// CLUSTER FIRST, THEN HAND OUT THE WORK
//
// The other planner grows routes one at a time from a seed, which means what
// ends up together depends on who bid first. This one settles the geography
// before any driver is involved: split the stops into k tight groups using
// k-medoids on the real drive times, then give each group to somebody.
//
// The point is that clusters come from the map, not from the order things ran in.

module.exports = function makeClusterPlanner(deps) {
    const {
        VAN_CAPACITY, SECONDS_PER_PKG, UNREACHABLE,
        TRAFFIC_HIGHWAY, TRAFFIC_CITY,
        ABSOLUTE_MAX_STEP, MAX_LOCAL_DRIVE_SHARE,
        LARGEST_TIER, tierCapacity, classifyVehicle,
        splitBigZips, optimizeRouteWith2Opt, annotateOverflow, computeMetrics
    } = deps;

    // Turn a set of stops into a route. Nearest-neighbour out from the
    // warehouse, then 2-opt to undo the crossings that leaves behind.
    const orderStops = (stops, matrix) => {
        if (stops.length === 0) return [];
        const remaining = [...stops];
        const route = [];
        let cur = 0;
        while (remaining.length) {
            let best = 0, bestD = Infinity;
            remaining.forEach((s, i) => {
                const d = matrix[cur][s.matrix_index];
                if (d < bestD) { bestD = d; best = i; }
            });
            const s = remaining.splice(best, 1)[0];
            route.push(s);
            cur = s.matrix_index;
        }
        if (route.length < 3) return route;
        const withWh = [{ matrix_index: 0, tbas: ['_WH_'] }, ...route];
        return optimizeRouteWith2Opt([...withWh], matrix).filter(s => s.tbas[0] !== '_WH_');
    };

    // Everything we need to know about a candidate cluster: what it costs and
    // whether it's actually legal.
    const evaluate = (stops, driver, matrix) => {
        const route = orderStops(stops, matrix);
        if (route.length === 0) {
            return { ok: false, route: [], reason: 'empty' };
        }
        const stem = matrix[0][route[0].matrix_index] * TRAFFIC_HIGHWAY;
        let localDrive = 0, maxLeg = 0;
        for (let i = 1; i < route.length; i++) {
            const leg = matrix[route[i - 1].matrix_index][route[i].matrix_index];
            if (leg >= UNREACHABLE) return { ok: false, route, reason: 'unreachable leg' };
            localDrive += leg * TRAFFIC_CITY;
            if (leg > maxLeg) maxLeg = leg;
        }
        const packages = route.reduce((a, s) => a + s.tbas.length, 0);
        const volume = route.reduce((a, s) => a + (s.volumeL || 0), 0);
        const maxDim = route.reduce((m, s) => Math.max(m, s.maxDimCm || 0), 0);
        const service = packages * SECONDS_PER_PKG;
        const total = stem + localDrive + service;

        const cap = tierCapacity(driver.vehicle || LARGEST_TIER);
        const available = driver.timeBudget - stem;

        let ok = true, reason = null;
        if (packages > VAN_CAPACITY) { ok = false; reason = 'over package capacity'; }
        else if (volume > cap.usableL) { ok = false; reason = 'over cubic capacity'; }
        else if (maxDim > cap.maxDimCm) { ok = false; reason = 'item too long for vehicle'; }
        else if (total > driver.timeBudget) { ok = false; reason = 'over time budget'; }
        else if (maxLeg > ABSOLUTE_MAX_STEP) { ok = false; reason = 'leg between stops too long'; }
        else if (available <= 0 || localDrive > available * MAX_LOCAL_DRIVE_SHARE) { ok = false; reason = 'too much driving, not enough delivering'; }

        return { ok, reason, route, stem, localDrive, service, packages, volume, maxDim, maxLeg, total };
    };

    // Pick k starting centres, spread out but leaning toward busy areas
    const seedMedoids = (stops, k, matrix) => {
        if (stops.length === 0) return [];
        const medoids = [];
        // Start with wherever has the most packages around it
        let best = stops[0], bestScore = -Infinity;
        stops.forEach(s => {
            let near = 0;
            stops.forEach(o => {
                if (o === s) return;
                const d = matrix[s.matrix_index][o.matrix_index];
                if (d < ABSOLUTE_MAX_STEP) near += o.tbas.length;
            });
            const score = near * 10 + s.tbas.length * 5 - matrix[0][s.matrix_index] / 60;
            if (score > bestScore) { bestScore = score; best = s; }
        });
        medoids.push(best);

        // Then keep picking whatever's furthest from everything chosen so far
        while (medoids.length < k) {
            let far = null, farD = -1;
            stops.forEach(s => {
                if (medoids.includes(s)) return;
                let minD = Infinity;
                medoids.forEach(m => {
                    const d = matrix[m.matrix_index][s.matrix_index];
                    if (d < minD) minD = d;
                });
                const weighted = minD * (1 + s.tbas.length * 0.15);
                if (weighted > farD) { farD = weighted; far = s; }
            });
            if (!far) break;
            medoids.push(far);
        }
        return medoids;
    };

    // Put every stop in a cluster without breaking capacity.
    //
    // Order matters: stops go in by regret, meaning how much worse their second
    // choice would be. Whoever has the least room to compromise picks first.
    const assignToClusters = (stops, medoids, drivers, matrix) => {
        const clusters = medoids.map(() => []);
        const unassigned = [];

        const scored = stops.map(s => {
            const dists = medoids.map(m => matrix[m.matrix_index][s.matrix_index]);
            const sorted = [...dists].sort((a, b) => a - b);
            const regret = (sorted[1] ?? sorted[0]) - sorted[0];
            return { stop: s, dists, regret };
        });
        scored.sort((a, b) => b.regret - a.regret);

        scored.forEach(({ stop, dists }) => {
            const order = dists
                .map((d, i) => ({ i, d }))
                .filter(x => x.d < UNREACHABLE)
                .sort((a, b) => a.d - b.d);

            let placed = false;
            for (const { i, d } of order) {
                const driver = drivers[i];
                if (!driver) continue;

                // Has to be within reach of something already in the cluster
                if (clusters[i].length > 0) {
                    let nearest = Infinity;
                    clusters[i].forEach(o => {
                        const dd = matrix[o.matrix_index][stop.matrix_index];
                        if (dd < nearest) nearest = dd;
                    });
                    if (nearest > ABSOLUTE_MAX_STEP) continue;
                }

                const trial = evaluate([...clusters[i], stop], driver, matrix);
                if (trial.ok) { clusters[i].push(stop); placed = true; break; }
            }
            if (!placed) unassigned.push(stop);
        });

        return { clusters, unassigned };
    };

    // Shift each centre to whichever stop is most central to its cluster
    const recentreMedoids = (clusters, medoids, matrix) => {
        let moved = false;
        clusters.forEach((cluster, i) => {
            if (cluster.length === 0) return;
            let best = cluster[0], bestSum = Infinity;
            cluster.forEach(cand => {
                let sum = 0;
                cluster.forEach(o => {
                    const d = matrix[cand.matrix_index][o.matrix_index];
                    sum += (d >= UNREACHABLE ? UNREACHABLE : d);
                });
                if (sum < bestSum) { bestSum = sum; best = cand; }
            });
            if (best !== medoids[i]) { medoids[i] = best; moved = true; }
        });
        return moved;
    };

    const runKMedoids = (stops, drivers, matrix, iterations = 6) => {
        let medoids = seedMedoids(stops, drivers.length, matrix);
        let result = assignToClusters(stops, medoids, drivers, matrix);
        for (let it = 0; it < iterations; it++) {
            if (!recentreMedoids(result.clusters, medoids, matrix)) break;
            const next = assignToClusters(stops, medoids, drivers, matrix);
            // Only keep the new arrangement if it placed at least as many
            if (next.unassigned.length <= result.unassigned.length) result = next;
            else break;
        }
        return result;
    };

    // Hand clusters out, heaviest first.
    //
    // Careful here: each cluster was built against one specific driver, so
    // sorting both lists and zipping them can drop an SUV-sized cluster on a
    // sedan. That bug shipped once. Every pairing gets fit-checked now, and a
    // cluster keeps the driver it was built for unless something better is free.
    const matchClustersToDrivers = (clusters, drivers, matrix) => {
        const withLoad = clusters.map((stops, i) => ({
            stops,
            volume: stops.reduce((a, s) => a + (s.volumeL || 0), 0),
            packages: stops.reduce((a, s) => a + s.tbas.length, 0),
            maxDim: stops.reduce((m, s) => Math.max(m, s.maxDimCm || 0), 0),
            owner: drivers[i]
        })).filter(c => c.stops.length > 0);

        withLoad.sort((a, b) => b.volume - a.volume);

        const taken = new Set();
        const pairs = [];

        withLoad.forEach(c => {
            // Smallest thing that fits wins, so the big vehicles stay free for
            // the clusters that genuinely need them
            const viable = drivers
                .filter(d => !taken.has(d.id))
                .filter(d => {
                    const cap = tierCapacity(d.vehicle || LARGEST_TIER);
                    return c.volume <= cap.usableL
                        && c.maxDim <= cap.maxDimCm
                        && c.packages <= VAN_CAPACITY;
                })
                .sort((a, b) => {
                    const ca = tierCapacity(a.vehicle || LARGEST_TIER).usableL;
                    const cb = tierCapacity(b.vehicle || LARGEST_TIER).usableL;
                    if (ca !== cb) return ca - cb;          // tightest fit first
                    return b.maxHours - a.maxHours;
                });

            let chosen = null;
            // Prefer whoever it was built for, if they're still free
            if (c.owner && !taken.has(c.owner.id) && viable.includes(c.owner)) {
                chosen = c.owner;
            } else if (viable.length > 0) {
                chosen = viable[0];
            }

            if (chosen) {
                taken.add(chosen.id);
                pairs.push({ driver: chosen, stops: c.stops });
            } else {
                // Nothing in the fleet can carry this one
                pairs.push({ driver: null, stops: c.stops, unfittable: true });
            }
        });

        return pairs;
    };

    return function planRoutesByCluster(regionalZips, driverList, matrix, startPoint, mode) {
        if (regionalZips.length === 0 || driverList.length === 0) return [];

        regionalZips.forEach((wp, i) => { wp.matrix_index = i + 1; });

        const fleetTop = driverList.reduce((best, d) => {
            const v = d.vehicle || LARGEST_TIER;
            return tierCapacity(v).usableL > tierCapacity(best).usableL ? v : best;
        }, driverList[0].vehicle || LARGEST_TIER);

        const splitZips = splitBigZips(regionalZips, VAN_CAPACITY, tierCapacity(fleetTop).usableL);
        const totalPackages = splitZips.reduce((s, z) => s + z.tbas.length, 0);

        console.log(`\n[Cluster] Mode: ${mode.toUpperCase()} | ${totalPackages} packages across ${splitZips.length} stops`);

        const makeDriver = (src, id) => ({
            id,
            maxHours: src.maxHours,
            vehicle: src.vehicle || LARGEST_TIER,
            timeBudget: src.maxHours * 3600,
            route: [],
            currentPackages: 0,
            currentVolume: 0,
            currentMaxDim: 0,
            currentDriveTime: 0,
            currentServiceTime: 0,
            stemTime: 0,
            assignedIndices: new Set()
        });

        let drivers, best;

        if (mode === 'auto') {
            // Auto works out its own k. Start at the capacity minimum and keep
            // adding drivers until everything lands somewhere.
            const template = driverList[0];
            let k = Math.max(1, Math.ceil(totalPackages / VAN_CAPACITY));
            const maxK = Math.min(200, splitZips.length);
            for (; k <= maxK; k++) {
                drivers = Array.from({ length: k }, (_, i) => makeDriver(template, i + 1));
                best = runKMedoids(splitZips, drivers, matrix);
                if (best.unassigned.length === 0) break;
            }
            console.log(`[Cluster] Auto settled on k=${drivers.length}, ${best.unassigned.length} stops unplaced`);
        } else {
            drivers = driverList.map((d, i) => makeDriver(d, d.id ?? i + 1));
            best = runKMedoids(splitZips, drivers, matrix);
            console.log(`[Cluster] Manual k=${drivers.length}, ${best.unassigned.length} stops unplaced`);
        }

        const pairs = matchClustersToDrivers(best.clusters, drivers, matrix);
        const results = [];

        pairs.forEach(({ driver, stops, unfittable }) => {
            if (stops.length === 0) return;
            if (unfittable || !driver) {
                // Nobody can carry these. Say so rather than quietly loading
                // them onto a driver who'll find out in the parking lot.
                best.unassigned.push(...stops);
                return;
            }
            const ev = evaluate(stops, driver, matrix);
            if (!ev.ok) {
                // Drop the most expensive stop until it fits
                let working = [...stops];
                while (working.length > 1) {
                    let worst = 0, worstD = -1;
                    working.forEach((s, i) => {
                        let sum = 0;
                        working.forEach(o => { if (o !== s) sum += matrix[s.matrix_index][o.matrix_index]; });
                        const avg = sum / Math.max(1, working.length - 1);
                        if (avg > worstD) { worstD = avg; worst = i; }
                    });
                    const dropped = working.splice(worst, 1)[0];
                    best.unassigned.push(dropped);
                    if (evaluate(working, driver, matrix).ok) break;
                }
                stops = working;
            }

            const final = evaluate(stops, driver, matrix);
            if (final.route.length === 0) return;

            driver.route = final.route;
            driver.stemTime = final.stem;
            driver.currentDriveTime = final.stem + final.localDrive;
            driver.currentServiceTime = final.service;
            driver.currentPackages = final.packages;
            driver.currentVolume = +final.volume.toFixed(2);
            driver.currentMaxDim = final.maxDim;
            final.route.forEach(s => driver.assignedIndices.add(s.matrix_index));

            const routeWithWarehouse = [{
                ...startPoint, matrix_index: 0, tbas: ['WAREHOUSE'],
                isWarehouse: true, volumeL: 0, maxDimCm: 0
            }, ...final.route];

            let elapsed = 0;
            routeWithWarehouse.forEach((stop, i) => {
                if (i > 0) {
                    const leg = matrix[routeWithWarehouse[i - 1].matrix_index][stop.matrix_index];
                    if (leg < UNREACHABLE) elapsed += (i === 1) ? leg * TRAFFIC_HIGHWAY : leg * TRAFFIC_CITY;
                }
                stop.etaSeconds = Math.round(elapsed);
                if (i > 0) elapsed += stop.tbas.length * SECONDS_PER_PKG;
            });

            let diameter = 0;
            for (let i = 0; i < final.route.length; i++)
                for (let j = i + 1; j < final.route.length; j++) {
                    const d = matrix[final.route[i].matrix_index][final.route[j].matrix_index];
                    if (d < UNREACHABLE && d > diameter) diameter = d;
                }

            const requiredVehicle = classifyVehicle(final.volume, final.maxDim);
            const metrics = computeMetrics(routeWithWarehouse, matrix);

            console.log(`[Cluster] Driver ${driver.id} [${driver.vehicle}]: ${final.route.length} stops, ${final.packages} pkgs, ${Math.round(final.volume)}L, longest leg ${Math.round(final.maxLeg / 60)}min, ${(final.total / 3600).toFixed(2)}h/${driver.maxHours}h`);

            results.push({
                route: routeWithWarehouse,
                totalHours: final.total / 3600,
                driverId: driver.id,
                driverMax: driver.maxHours,
                totalVolumeL: +final.volume.toFixed(1),
                maxDimCm: final.maxDim,
                diameterMin: Math.round(diameter / 60),
                metrics,
                requiredVehicle: requiredVehicle || 'UNFITTABLE',
                assignedVehicle: driver.vehicle,
                vehicleUsagePct: Math.round((final.volume / tierCapacity(driver.vehicle).usableL) * 100)
            });
        });

        results.forEach((r, i) => { r.driverId = i + 1; });

        if (best.unassigned.length > 0) {
            annotateOverflow(best.unassigned, fleetTop, matrix);
            const pk = best.unassigned.reduce((s, o) => s + o.tbas.length, 0);
            console.log(`[Cluster] OVERFLOW: ${best.unassigned.length} stops, ${pk} packages`);
            results.push({
                route: best.unassigned, totalHours: 0, driverId: 'OVERFLOW',
                driverMax: 0, isOverflow: true,
                totalVolumeL: +best.unassigned.reduce((s, o) => s + (o.volumeL || 0), 0).toFixed(1),
                maxDimCm: best.unassigned.reduce((m, o) => Math.max(m, o.maxDimCm || 0), 0),
                totalPackages: pk
            });
        }

        return results;
    };
};
