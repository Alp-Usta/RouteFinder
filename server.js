const express = require('express');
const axios = require('axios');
const path = require('path');
const zipdb = require('zipcodes');

const app = express();
const port = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const startingLocation = {
    address: 'Starting Location',
    coordinates: { lat: 40.10144209586004, lng: -75.30578283911566 }
};

// --- HELPER FUNCTIONS ---

const geocodeAddresses = async (addresses) => {
    const geocoded = [];
    console.log(`Looking up ${addresses.length} addresses in local DB...`);
    const missing = [];

    for (const address of addresses) {
        const found = zipdb.lookup(address);
        if (found) {
            geocoded.push({
                address: address,
                coordinates: { lat: found.latitude, lng: found.longitude },
                state: found.state
            });
        } else {
            missing.push(address);
        }
    }

    if (missing.length > 0) {
        for (const address of missing) {
            try {
                await new Promise(r => setTimeout(r, 1000));
                const response = await axios.get('https://nominatim.openstreetmap.org/search', {
                    params: { postalcode: address, country: 'US', format: 'json', 'accept-language': 'en', addressdetails: 1 },
                    headers: { 'User-Agent': 'FlexRouteOptimizer/3.0' }
                });

                if (response.data.length > 0) {
                    const result = response.data[0];
                    geocoded.push({
                        address: address,
                        coordinates: { lat: parseFloat(result.lat), lng: parseFloat(result.lon) },
                        state: result.address.state ? result.address.state.substring(0, 2).toUpperCase() : 'Unknown'
                    });
                }
            } catch (e) { console.error(`Failed to find ${address} online.`); }
        }
    }
    return geocoded;
};

const getDistanceMatrix = async (points) => {
    const n = points.length;
    let matrix = Array(n).fill(null).map(() => Array(n).fill(0));
    try {
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (i === j) { matrix[i][j] = 0; continue; }
                const p1 = `${points[i].coordinates.lat},${points[i].coordinates.lng}`;
                const p2 = `${points[j].coordinates.lat},${points[j].coordinates.lng}`;
                const url = `http://localhost:8989/route?point=${p1}&point=${p2}&profile=car&calc_points=false&points_encoded=false`;

                try {
                    const response = await axios.get(url, { timeout: 2000 });
                    if (response.data.paths) matrix[i][j] = Math.round(response.data.paths[0].time / 1000);
                    else matrix[i][j] = 600;
                } catch (e) { matrix[i][j] = 600; }
            }
        }
    } catch (error) { console.error(error); }
    return matrix;
};

const optimizeRouteWith2Opt = (route, matrix) => {
    if (route.length < 4) return route;
    let improved = true;
    while (improved) {
        improved = false;
        for (let i = 1; i < route.length - 2; i++) {
            for (let j = i + 1; j < route.length - 1; j++) {
                const p1_idx = route[i - 1].matrix_index;
                const p2_idx = route[i].matrix_index;
                const p3_idx = route[j].matrix_index;
                const p4_idx = route[j + 1].matrix_index;

                const currentDist = matrix[p1_idx][p2_idx] + matrix[p3_idx][p4_idx];
                const newDist = matrix[p1_idx][p3_idx] + matrix[p2_idx][p4_idx];

                if (newDist < currentDist) {
                    const segment = route.slice(i, j + 1).reverse();
                    route.splice(i, segment.length, ...segment);
                    improved = true;
                }
            }
        }
    }
    return route;
};

const splitBigZips = (zips, maxPerDriver) => {
    const splitZips = [];
    zips.forEach(zip => {
        if (zip.isBag) {
            splitZips.push(zip);
            return;
        }
        const pkgCount = zip.tbas.length;
        if (pkgCount > maxPerDriver) {
            let remainingTbas = [...zip.tbas];
            while (remainingTbas.length > 0) {
                const chunk = remainingTbas.splice(0, maxPerDriver);
                splitZips.push({ ...zip, tbas: chunk, matrix_index: zip.matrix_index });
            }
        } else {
            splitZips.push(zip);
        }
    });
    return splitZips;
};

// --- ROUTING LOGIC: ADAPTIVE V5.5 (STABLE + SAME AREA PRIORITY) ---
const planRoutesForRegion = (regionalZips, driverList, matrix, startPoint, mode = 'auto') => {
    if (regionalZips.length === 0 || driverList.length === 0) return [];

    regionalZips.forEach((wp, i) => { wp.matrix_index = i + 1; });

    // 1. Sort Drivers (Best drivers first)
    const sortedDrivers = [...driverList].sort((a, b) => b.maxHours - a.maxHours);

    // --- DETERMINE CAP STRATEGY ---
    const VAN_CAPACITY = 48;
    let DYNAMIC_CAP = VAN_CAPACITY;
    const totalPackages = regionalZips.reduce((sum, zip) => sum + (zip.tbas ? zip.tbas.length : 0), 0);

    if (mode === 'manual') {
        const fairShare = Math.ceil(totalPackages / driverList.length);
        DYNAMIC_CAP = Math.max(1, Math.min(VAN_CAPACITY, fairShare));
        console.log(`[Router] MANUAL MODE. Total: ${totalPackages}, Drivers: ${driverList.length}, Cap: ${DYNAMIC_CAP}`);
    } else {
        console.log(`[Router] AUTO MODE. Greedy fill to ${VAN_CAPACITY}.`);
    }

    // 2. Pre-Split
    let splitLimit = (mode === 'manual') ? DYNAMIC_CAP : VAN_CAPACITY;
    let unassigned = splitBigZips(regionalZips, splitLimit).map(wp => ({
        ...wp,
        isAssigned: false
    }));

    let finalRoutes = [];

    // --- TUNING CONSTANTS ---
    const SECONDS_PKG = 180;
    const GRACE_PERIOD_SECONDS = 300;
    const DIAMETER_STANDARD = 600;
    const DIAMETER_TIER1 = 900;
    const DIAMETER_TIER2 = 1200;
    const STEP_STANDARD = 420;
    const STEP_TIER1 = 720;
    const STEP_TIER2 = 900;
    const TRAFFIC_HIGHWAY = 1.0;
    const TRAFFIC_CITY = 1.1;

    const calculateServiceTime = (pkgCount) => pkgCount * SECONDS_PKG;

    // --- THE LOOP ---
    sortedDrivers.forEach(driver => {
        if (unassigned.filter(u => !u.isAssigned).length === 0) return;

        let currentRoute = [];
        let currentPkgs = 0;
        let currentDriveTime = 0;
        let currentServiceTime = 0;

        // A. Find "Seed" Stop
        const SEED_RADIUS = (mode === 'manual') ? 7200 : 3600;

        let seedStop = null;
        let maxDist = -1;

        const bags = unassigned.filter(u => !u.isAssigned && u.isBag);
        const candidates = bags.length > 0 ? bags : unassigned.filter(u => !u.isAssigned);

        candidates.forEach(stop => {
            const dist = matrix[0][stop.matrix_index];
            if (dist > SEED_RADIUS) return;
            if (dist > maxDist) {
                maxDist = dist;
                seedStop = stop;
            }
        });

        if (!seedStop) return;

        // Check Seed Validity
        const rawSeedDrive = matrix[0][seedStop.matrix_index];
        const seedDrive = rawSeedDrive * TRAFFIC_HIGHWAY;
        const seedService = calculateServiceTime(seedStop.tbas.length);
        const maxSeconds = (driver.maxHours * 3600) + GRACE_PERIOD_SECONDS;

        if ((seedDrive + seedService) > maxSeconds) return;

        // Assign Seed
        currentRoute.push(seedStop);
        seedStop.isAssigned = true;
        currentPkgs += seedStop.tbas.length;
        currentDriveTime += seedDrive;
        currentServiceTime += seedService;

        // B. Grow Route
        let lookingForStops = true;

        while (lookingForStops) {
            if (currentPkgs >= DYNAMIC_CAP) {
                lookingForStops = false;
                break;
            }

            const lastStop = currentRoute[currentRoute.length - 1];

            // *** MODIFIED FIND CANDIDATE: SAME AREA PRIORITY ***
            const findCandidate = (stepLimit, diameterLimit) => {
                let sameAreaMatches = [];
                let otherMatches = [];

                unassigned.forEach(candidate => {
                    if (!candidate.isAssigned) {
                        const addPkgs = candidate.tbas.length;

                        // 1. HARD CAP CHECK
                        if (currentPkgs + addPkgs > VAN_CAPACITY) return;

                        // 2. DYNAMIC CAP CHECK
                        if (mode === 'manual' && (currentPkgs + addPkgs > DYNAMIC_CAP)) return;

                        // 3. STEP CHECK (Leash)
                        const distFromLast = matrix[lastStop.matrix_index][candidate.matrix_index];
                        if (distFromLast > stepLimit) return;

                        // 4. DIAMETER CHECK
                        for (let i = 0; i < currentRoute.length; i++) {
                            const existing = currentRoute[i];
                            const dist = matrix[existing.matrix_index][candidate.matrix_index];
                            if (dist > diameterLimit) return;
                        }

                        // 5. TIME CHECK
                        const driveStep = distFromLast * TRAFFIC_CITY;
                        const serviceStep = calculateServiceTime(addPkgs);
                        const totalEstSeconds = currentDriveTime + driveStep + currentServiceTime + serviceStep;

                        if (totalEstSeconds > maxSeconds) return;

                        // *** SORTING LOGIC ***
                        // Check if candidate is in the SAME ZIP as the last stop
                        if (candidate.address === lastStop.address) {
                            sameAreaMatches.push({
                                stop: candidate,
                                drive: driveStep,
                                service: serviceStep,
                                dist: distFromLast
                            });
                        } else {
                            otherMatches.push({
                                stop: candidate,
                                drive: driveStep,
                                service: serviceStep,
                                dist: distFromLast
                            });
                        }
                    }
                });

                // *** PRIORITY DECISION ***
                // If we have stops in the SAME area, we MUST pick the closest one of those.
                // We ignore the "Other" list even if they are closer, until the "Same" list is empty.
                if (sameAreaMatches.length > 0) {
                    sameAreaMatches.sort((a, b) => a.dist - b.dist);
                    return sameAreaMatches[0];
                }

                // If no same-area stops, fall back to closest neighbor (Efficiency)
                if (otherMatches.length > 0) {
                    otherMatches.sort((a, b) => a.dist - b.dist);
                    return otherMatches[0];
                }

                return null;
            };

            // Strategy Tiers
            let bestCandidate = findCandidate(STEP_STANDARD, DIAMETER_STANDARD);
            if (!bestCandidate && currentPkgs < 20) bestCandidate = findCandidate(STEP_TIER1, DIAMETER_TIER1);
            if (!bestCandidate && currentPkgs < 10) bestCandidate = findCandidate(STEP_TIER2, DIAMETER_TIER2);

            if (bestCandidate) {
                const { stop, drive, service } = bestCandidate;
                currentRoute.push(stop);
                stop.isAssigned = true;
                currentPkgs += stop.tbas.length;
                currentDriveTime += drive;
                currentServiceTime += service;
            } else {
                lookingForStops = false;
            }
        }

        // C. Optimize
        if (currentRoute.length > 0) {
            currentRoute.unshift({ ...startPoint, matrix_index: 0, tbas: ['WAREHOUSE'] });
            const optimized = optimizeRouteWith2Opt([...currentRoute], matrix);

            let finalDrive = 0;
            const stemLeg = matrix[optimized[0].matrix_index][optimized[1].matrix_index];
            finalDrive += (stemLeg * TRAFFIC_HIGHWAY);

            for (let k = 1; k < optimized.length - 1; k++) {
                const legTime = matrix[optimized[k].matrix_index][optimized[k + 1].matrix_index];
                finalDrive += (legTime * TRAFFIC_CITY);
            }

            let finalService = 0;
            for (let k = 1; k < optimized.length; k++) {
                finalService += calculateServiceTime(optimized[k].tbas.length);
            }

            finalRoutes.push({
                route: optimized,
                totalHours: (finalDrive + finalService) / 3600,
                driverId: driver.id,
                driverMax: driver.maxHours
            });
        }
    });

    // 4. ORPHAN RESCUE 
    const remaining = unassigned.filter(u => !u.isAssigned);
    if (remaining.length > 0 && finalRoutes.length > 0) {
        remaining.forEach(orphan => {
            let bestRoute = null;
            let minAddedTime = Infinity;

            finalRoutes.forEach(fr => {
                let currentTotal = 0;
                fr.route.forEach(r => currentTotal += (r.tbas ? r.tbas.length : 0));

                if (currentTotal + orphan.tbas.length > VAN_CAPACITY) return;

                const lastStop = fr.route[fr.route.length - 1];
                const dist = matrix[lastStop.matrix_index][orphan.matrix_index];

                if (dist > 1800) return;

                if (dist < minAddedTime) {
                    minAddedTime = dist;
                    bestRoute = fr;
                }
            });

            if (bestRoute) {
                bestRoute.route.push(orphan);
                orphan.isAssigned = true;
            }
        });
    }

    // 5. Overflow
    const trueOverflow = unassigned.filter(u => !u.isAssigned);
    if (trueOverflow.length > 0) {
        finalRoutes.push({
            route: trueOverflow,
            totalHours: 0,
            driverId: "OVERFLOW (Need more drivers!)",
            driverMax: 0
        });
    }

    return finalRoutes;
};

app.post('/calculate-routes', async (req, res) => {
    try {
        const { loosePackages = [], bags = [], drivers, mode } = req.body;

        console.log(`\n--- REQUEST ---`);
        console.log(`Drivers: ${drivers ? drivers.length : 0} | Mode: "${mode}"`);

        if (!drivers) return res.status(400).json({ error: 'No drivers' });

        const looseZipMap = {};
        loosePackages.forEach(p => {
            if (!looseZipMap[p.postal]) looseZipMap[p.postal] = [];
            looseZipMap[p.postal].push(p.tba);
        });
        const uniqueLooseZips = Object.keys(looseZipMap);

        const bagZips = new Set();
        bags.forEach(b => b.items.forEach(i => bagZips.add(i.postal)));

        const allZipsToGeocode = [...new Set([...uniqueLooseZips, ...bagZips])];

        const geocoded = await geocodeAddresses(allZipsToGeocode);
        const geoMap = {};
        geocoded.forEach(g => geoMap[g.address] = g);

        let allStops = [];

        uniqueLooseZips.forEach(z => {
            if (geoMap[z]) {
                allStops.push({
                    address: z,
                    coordinates: geoMap[z].coordinates,
                    state: geoMap[z].state,
                    tbas: looseZipMap[z],
                    isBag: false
                });
            }
        });

        bags.forEach(bag => {
            let latSum = 0, lngSum = 0, count = 0, state = 'UNKNOWN';
            const tbas = [];
            bag.items.forEach(item => {
                const g = geoMap[item.postal];
                if (g) {
                    latSum += g.coordinates.lat;
                    lngSum += g.coordinates.lng;
                    state = g.state;
                    count++;
                }
                tbas.push(item.tba);
            });
            if (count > 0) {
                allStops.push({
                    address: bag.name,
                    coordinates: { lat: latSum / count, lng: lngSum / count },
                    state: state,
                    tbas: tbas,
                    isBag: true
                });
            }
        });

        const buckets = allStops.reduce((acc, s) => {
            (acc[s.state] = acc[s.state] || []).push(s);
            return acc;
        }, {});

        let allRoutes = [];
        for (const state of Object.keys(buckets)) {
            const stops = buckets[state];
            const matrix = await getDistanceMatrix([startingLocation, ...stops]);
            const result = planRoutesForRegion(stops, drivers, matrix, startingLocation, mode);
            allRoutes.push(...result);
        }

        res.json(allRoutes);

    } catch (error) { console.error(error); res.status(500).json({ error: error.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));