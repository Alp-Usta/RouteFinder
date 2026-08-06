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
    const UNREACHABLE = 99999;
    let matrix = Array(n).fill(null).map(() => Array(n).fill(0));
    let failedRoutes = 0;
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
                    else {
                        matrix[i][j] = UNREACHABLE;
                        failedRoutes++;
                    }
                } catch (e) {
                    matrix[i][j] = UNREACHABLE;
                    failedRoutes++;
                }
            }
        }
        if (failedRoutes > 0) {
            console.log(`[Matrix] Warning: ${failedRoutes} route calculations failed`);
        }
    } catch (error) { console.error(error); }
    return matrix;
};

// 2-opt with UNREACHABLE guard: skip swaps involving 99999 edges
const optimizeRouteWith2Opt = (route, matrix) => {
    if (route.length < 4) return route;
    let improved = true;
    let iterations = 0;
    const maxIterations = 100;
    const UNREACHABLE = 99999;

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;
        for (let i = 1; i < route.length - 2; i++) {
            for (let j = i + 1; j < route.length - 1; j++) {
                const p1_idx = route[i - 1].matrix_index;
                const p2_idx = route[i].matrix_index;
                const p3_idx = route[j].matrix_index;
                const p4_idx = route[j + 1].matrix_index;

                const d1 = matrix[p1_idx][p2_idx];
                const d2 = matrix[p3_idx][p4_idx];
                const d3 = matrix[p1_idx][p3_idx];
                const d4 = matrix[p2_idx][p4_idx];

                if (d1 >= UNREACHABLE || d2 >= UNREACHABLE || d3 >= UNREACHABLE || d4 >= UNREACHABLE) continue;

                const currentDist = d1 + d2;
                const newDist = d3 + d4;

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

// Split ZIPs that exceed a driver's package count OR cubic volume into chunks.
// Bags are never split — bag integrity is a hard rule.
const splitBigZips = (zips, maxPerChunk, maxVolumePerChunk) => {
    const result = [];
    zips.forEach(zip => {
        if (zip.isBag) {
            result.push(zip);
            return;
        }
        const overCount  = zip.tbas.length > maxPerChunk;
        const overVolume = maxVolumePerChunk > 0 && (zip.volumeL || 0) > maxVolumePerChunk;

        if (!overCount && !overVolume) {
            result.push(zip);
            return;
        }

        // Walk the ZIP's packages, opening a new chunk when either limit trips.
        const meta = zip.pkgMeta || {};
        let chunkTbas = [], chunkVol = 0, chunkMaxDim = 0;

        const flush = () => {
            if (chunkTbas.length === 0) return;
            result.push({
                ...zip,
                tbas: chunkTbas,
                volumeL: +chunkVol.toFixed(2),
                maxDimCm: chunkMaxDim
            });
            chunkTbas = []; chunkVol = 0; chunkMaxDim = 0;
        };

        zip.tbas.forEach(tba => {
            const m = meta[tba] || { effectiveL: 0, maxDimCm: 0 };
            const wouldCount  = chunkTbas.length + 1 > maxPerChunk;
            const wouldVolume = maxVolumePerChunk > 0 && (chunkVol + m.effectiveL) > maxVolumePerChunk;
            if (chunkTbas.length > 0 && (wouldCount || wouldVolume)) flush();

            chunkTbas.push(tba);
            chunkVol += m.effectiveL;
            chunkMaxDim = Math.max(chunkMaxDim, m.maxDimCm || 0);
        });
        flush();
    });
    return result;
};

// --- CONSTANTS ---
const VAN_CAPACITY = 48;
const SECONDS_PER_PKG = 180;      // 3 min per package
const UNREACHABLE = 99999;
const TRAFFIC_HIGHWAY = 1.0;
const TRAFFIC_CITY = 1.1;

// =====================================================
// VEHICLE CAPACITY MODEL
//
// Volumes are USABLE litres per zone, not brochure numbers.
// Brochure trunk volume assumes liquid fill; real boxes leave
// air. PACKING_EFFICIENCY converts summed package cubic into
// the space actually consumed.
//
// maxDimCm = longest single item the loading aperture accepts.
// A 142 cm item physically cannot enter a sedan trunk even
// when the volume math says there is room.
// =====================================================
const PACKING_EFFICIENCY = 0.68;   // boxes waste ~32% of any space

const VEHICLE_TIERS = [
    {
        id: 'SEDAN',
        label: 'Sedan',
        // Mid-size 4-door (Camry / Accord class)
        zones: { trunk: 425, rearSeat: 280, frontPassenger: 95 },
        maxDimCm: 120,
        color: '#4ecdc4'
    },
    {
        id: 'SUV',
        label: 'SUV',
        // Mid-size SUV, 2nd row UP (RAV4 / Explorer class)
        zones: { trunk: 1000, rearSeat: 350, frontPassenger: 95 },
        maxDimCm: 180,
        color: '#fca311'
    },
    {
        id: 'TRUCK',
        label: 'Truck / Cargo Van',
        // Transit Connect / pickup with cap
        zones: { trunk: 3000, rearSeat: 400, frontPassenger: 95 },
        maxDimCm: 250,
        color: '#f032e6'
    }
];

// Gross zone volume -> usable volume after packing loss
const tierUsableVolume = (tier) => {
    const gross = tier.zones.trunk + tier.zones.rearSeat + tier.zones.frontPassenger;
    return Math.round(gross * PACKING_EFFICIENCY);
};

const TIER_BY_ID = {};
VEHICLE_TIERS.forEach(t => {
    TIER_BY_ID[t.id] = { ...t, usableL: tierUsableVolume(t) };
});

const LARGEST_TIER = 'TRUCK';

// Flat / envelope packages compress into gaps between boxes.
// They are charged a fraction of their cubic instead of the full amount.
const FLAT_MAX_MIN_DIM_CM = 6;     // thickness at or under this = flat
const FLAT_MAX_VOLUME_L   = 6;     // and no bigger than this
const FLAT_VOLUME_FACTOR  = 0.25;  // charged at 25% of cubic

// Package size categories (by full cubic, in litres)
const SIZE_SMALL_MAX  = 15;
const SIZE_MEDIUM_MAX = 50;
const SIZE_LARGE_MAX  = 120;

// Compute effective (space-consuming) volume for one package.
// Accepts dims in cm; returns litres.
const packageVolume = (lengthCm, widthCm, heightCm) => {
    const L = parseFloat(lengthCm), W = parseFloat(widthCm), H = parseFloat(heightCm);
    if (!isFinite(L) || !isFinite(W) || !isFinite(H) || L <= 0 || W <= 0 || H <= 0) {
        return { cubicL: 0, effectiveL: 0, maxDimCm: 0, category: 'UNKNOWN' };
    }
    const cubicL = (L * W * H) / 1000;
    const maxDimCm = Math.max(L, W, H);
    const minDimCm = Math.min(L, W, H);

    const isFlat = minDimCm <= FLAT_MAX_MIN_DIM_CM && cubicL <= FLAT_MAX_VOLUME_L;

    let category;
    if (isFlat) category = 'FLAT';
    else if (cubicL <= SIZE_SMALL_MAX) category = 'SMALL';
    else if (cubicL <= SIZE_MEDIUM_MAX) category = 'MEDIUM';
    else if (cubicL <= SIZE_LARGE_MAX) category = 'LARGE';
    else category = 'OVERSIZE';

    return {
        cubicL: +cubicL.toFixed(2),
        effectiveL: +(isFlat ? cubicL * FLAT_VOLUME_FACTOR : cubicL).toFixed(2),
        maxDimCm: +maxDimCm.toFixed(1),
        category
    };
};

// Smallest tier that can carry this load. Returns null if nothing fits.
const classifyVehicle = (volumeL, maxDimCm) => {
    for (const tier of VEHICLE_TIERS) {
        const t = TIER_BY_ID[tier.id];
        if (volumeL <= t.usableL && maxDimCm <= t.maxDimCm) return tier.id;
    }
    return null;
};

const tierCapacity = (tierId) => {
    const t = TIER_BY_ID[tierId] || TIER_BY_ID[LARGEST_TIER];
    return { usableL: t.usableL, maxDimCm: t.maxDimCm };
};

// --- TUNING (Calibrated for PA warehouse @ Collegeville) ---
const BASE_STEM_SECONDS = 1800;    // 30 min stem for 2h driver
const STEM_PER_HOUR = 900;         // +15 min per extra hour over 2h

const BASE_MAX_DIAMETER = 600;     // 10 min diameter for 2h driver
const DIAMETER_PER_HOUR = 300;     // +5 min per extra hour

const BASE_STEP_LIMIT = 360;       // 6 min step for 2h driver
const STEP_PER_HOUR = 180;         // +3 min per extra hour

const SAME_AREA_BONUS = 0.6;       // Strong pull for same ZIP
const PKG_COUNT_BONUS = 0.20;      // 20% bonus per package

// Relaxation tiers: progressively widen diameter/step when tight
// constraints can't find candidates. Time budget is always the hard ceiling.
const RELAXATION_TIERS = [1.0, 1.5, 2.0, 3.0];

const getConstraints = (hours, relaxMultiplier = 1.0) => {
    const extraHours = Math.max(0, hours - 2);
    return {
        maxStemTime:  BASE_STEM_SECONDS + (extraHours * STEM_PER_HOUR),
        maxDiameter:  Math.round((BASE_MAX_DIAMETER + (extraHours * DIAMETER_PER_HOUR)) * relaxMultiplier),
        stepLimit:    Math.round((BASE_STEP_LIMIT   + (extraHours * STEP_PER_HOUR)) * relaxMultiplier)
    };
};

// =====================================================
// V12: TERRITORIAL ROUTING
//
// Key principle: each package goes to the driver whose
// existing route is GEOGRAPHICALLY CLOSEST. This prevents
// routes from crossing each other.
//
// - Progressive relaxation tiers for both auto & manual
// - Time budget is always the hard ceiling
// - Orphan rescue uses closest-route, not random
// =====================================================

// Helper: minimum distance from a package to any stop in a driver's route
const minDistToRoute = (pkgIdx, route, matrix) => {
    let minD = UNREACHABLE;
    for (const stop of route) {
        const d = matrix[stop.matrix_index][pkgIdx];
        if (d < minD) minD = d;
    }
    return minD;
};

// Helper: finalize a driver's route (add warehouse, 2-opt, compute hours)
const finalizeRoute = (driver, startPoint, matrix) => {
    const routeWithWarehouse = [{
        ...startPoint, matrix_index: 0, tbas: ['WAREHOUSE'],
        isWarehouse: true, volumeL: 0, maxDimCm: 0
    }, ...driver.route];
    const optimized = optimizeRouteWith2Opt([...routeWithWarehouse], matrix);

    let finalDrive = 0;
    for (let i = 0; i < optimized.length - 1; i++) {
        const leg = matrix[optimized[i].matrix_index][optimized[i + 1].matrix_index];
        if (leg >= UNREACHABLE) continue;
        finalDrive += (i === 0) ? leg * TRAFFIC_HIGHWAY : leg * TRAFFIC_CITY;
    }
    const finalService = driver.currentPackages * SECONDS_PER_PKG;
    const totalHours = (finalDrive + finalService) / 3600;

    // Cumulative per-stop ETA (seconds from warehouse departure)
    let elapsed = 0;
    optimized.forEach((stop, i) => {
        if (i > 0) {
            const leg = matrix[optimized[i - 1].matrix_index][stop.matrix_index];
            if (leg < UNREACHABLE) elapsed += (i === 1) ? leg * TRAFFIC_HIGHWAY : leg * TRAFFIC_CITY;
        }
        stop.etaSeconds = Math.round(elapsed);
        if (i > 0) elapsed += (stop.tbas ? stop.tbas.length : 0) * SECONDS_PER_PKG;
    });

    const totalVolumeL = +(driver.currentVolume || 0).toFixed(1);
    const maxDimCm = driver.currentMaxDim || 0;
    const requiredVehicle = classifyVehicle(totalVolumeL, maxDimCm);

    return {
        route: optimized,
        totalHours,
        driverId: driver.id,
        driverMax: driver.maxHours,
        totalVolumeL,
        maxDimCm,
        requiredVehicle: requiredVehicle || 'UNFITTABLE',
        assignedVehicle: driver.vehicle || null,
        vehicleUsagePct: driver.vehicle && TIER_BY_ID[driver.vehicle]
            ? Math.round((totalVolumeL / TIER_BY_ID[driver.vehicle].usableL) * 100)
            : null
    };
};

// Helper: recalculate a driver's time from scratch based on their route
// If optimize=true, also runs 2-opt to fix stop ordering (use after merges)
const recalcDriverTime = (driver, matrix, optimize = false) => {
    if (optimize && driver.route.length >= 3) {
        // Insert temporary warehouse, run 2-opt, strip warehouse
        const warehouseStop = { matrix_index: 0, tbas: ['_WH_'] };
        const tempRoute = [warehouseStop, ...driver.route];
        const optimized = optimizeRouteWith2Opt([...tempRoute], matrix);
        // Strip warehouse from result and update route order
        driver.route = optimized.filter(s => s.tbas[0] !== '_WH_');
    }
    
    let driveTime = 0;
    let serviceTime = 0;
    let pkgCount = 0;
    let volume = 0;
    let maxDim = 0;
    const indices = new Set();
    
    if (driver.route.length > 0) {
        // Stem: warehouse to first stop
        driveTime += matrix[0][driver.route[0].matrix_index] * TRAFFIC_HIGHWAY;
    }
    
    for (let i = 0; i < driver.route.length; i++) {
        const stop = driver.route[i];
        pkgCount += stop.tbas.length;
        serviceTime += stop.tbas.length * SECONDS_PER_PKG;
        volume += (stop.volumeL || 0);
        maxDim = Math.max(maxDim, stop.maxDimCm || 0);
        indices.add(stop.matrix_index);
        
        if (i > 0) {
            const leg = matrix[driver.route[i-1].matrix_index][stop.matrix_index];
            driveTime += (leg >= UNREACHABLE ? 0 : leg * TRAFFIC_CITY);
        }
    }
    
    driver.currentDriveTime = driveTime;
    driver.currentServiceTime = serviceTime;
    driver.currentPackages = pkgCount;
    driver.currentVolume = +volume.toFixed(2);
    driver.currentMaxDim = maxDim;
    driver.assignedIndices = indices;
};

// Can this driver physically accept this stop? Count + cubic + longest item.
const fitsVehicle = (driver, stop) => {
    if (driver.currentPackages + stop.tbas.length > VAN_CAPACITY) return false;
    const cap = tierCapacity(driver.vehicle || LARGEST_TIER);
    if ((driver.currentVolume || 0) + (stop.volumeL || 0) > cap.usableL) return false;
    if ((stop.maxDimCm || 0) > cap.maxDimCm) return false;
    return true;
};

// Apply a stop to a driver's running totals.
const applyStop = (driver, stop, addedDrive, addedService) => {
    driver.route.push(stop);
    driver.assignedIndices.add(stop.matrix_index);
    driver.currentPackages += stop.tbas.length;
    driver.currentVolume = +((driver.currentVolume || 0) + (stop.volumeL || 0)).toFixed(2);
    driver.currentMaxDim = Math.max(driver.currentMaxDim || 0, stop.maxDimCm || 0);
    driver.currentDriveTime += addedDrive;
    driver.currentServiceTime += addedService;
};

// =====================================================
// POST-PROCESSING: Merge close routes (auto mode only)
//
// After sequential route building, some routes end up
// geographically close but split across drivers.
// This merges them if combined they fit in one driver.
// =====================================================
const mergeCloseRoutes = (driverObjects, matrix, maxHours) => {
    const timeBudget = maxHours * 3600;
    const constraints = getConstraints(maxHours);
    // Hard cap: only merge routes whose avg pairwise distance is within diameter
    const MERGE_MAX_AVG_DIST = constraints.maxDiameter;
    let merged = true;
    
    while (merged) {
        merged = false;
        
        for (let i = 0; i < driverObjects.length; i++) {
            if (driverObjects[i].route.length === 0) continue;
            
            let bestMerge = null;
            let bestAvgDist = Infinity;
            
            for (let j = i + 1; j < driverObjects.length; j++) {
                if (driverObjects[j].route.length === 0) continue;
                
                const combinedPkgs = driverObjects[i].currentPackages + driverObjects[j].currentPackages;
                if (combinedPkgs > VAN_CAPACITY) continue;

                // Cubic + longest-item feasibility for the merged load
                const mergeCap = tierCapacity(driverObjects[i].vehicle || LARGEST_TIER);
                const combinedVol = (driverObjects[i].currentVolume || 0) + (driverObjects[j].currentVolume || 0);
                const combinedMaxDim = Math.max(driverObjects[i].currentMaxDim || 0, driverObjects[j].currentMaxDim || 0);
                if (combinedVol > mergeCap.usableL) continue;
                if (combinedMaxDim > mergeCap.maxDimCm) continue;
                
                // AVERAGE pairwise distance between all stops in both routes
                let totalDist = 0;
                let pairs = 0;
                for (const stopA of driverObjects[i].route) {
                    for (const stopB of driverObjects[j].route) {
                        const d = matrix[stopA.matrix_index][stopB.matrix_index];
                        if (d >= UNREACHABLE) { totalDist += UNREACHABLE; }
                        else { totalDist += d; }
                        pairs++;
                    }
                }
                const avgDist = pairs > 0 ? totalDist / pairs : Infinity;
                
                // Only merge if routes are genuinely close on average
                if (avgDist > MERGE_MAX_AVG_DIST || avgDist >= UNREACHABLE) continue;
                
                // Quick feasibility: combined service + larger stem + avg inter-route gap
                const combinedService = combinedPkgs * SECONDS_PER_PKG;
                const stemI = driverObjects[i].currentDriveTime;
                const stemJ = driverObjects[j].currentDriveTime;
                const roughDrive = Math.max(stemI, stemJ) + avgDist;
                
                // Use 0.85x — 2-opt will optimize significantly
                if ((roughDrive * 0.85) + combinedService > timeBudget) continue;
                
                if (avgDist < bestAvgDist) {
                    bestAvgDist = avgDist;
                    bestMerge = j;
                }
            }
            
            if (bestMerge !== null) {
                // Save state for potential undo
                const savedRouteI = [...driverObjects[i].route];
                const savedRouteJ = [...driverObjects[bestMerge].route];
                
                // Merge j into i
                driverObjects[i].route.push(...driverObjects[bestMerge].route);
                driverObjects[bestMerge].route = [];
                driverObjects[bestMerge].currentPackages = 0;
                // Run 2-opt on merged route to fix ordering, then recalc time
                recalcDriverTime(driverObjects[i], matrix, true);
                recalcDriverTime(driverObjects[bestMerge], matrix);
                
                // Verify the optimized route actually fits
                const totalTime = driverObjects[i].currentDriveTime + driverObjects[i].currentServiceTime;
                if (totalTime > timeBudget) {
                    // Undo: restore both routes
                    console.log(`[MERGE] Undo: ${Math.round(totalTime/60)}min > ${Math.round(timeBudget/60)}min budget`);
                    driverObjects[i].route = savedRouteI;
                    driverObjects[bestMerge].route = savedRouteJ;
                    recalcDriverTime(driverObjects[i], matrix);
                    recalcDriverTime(driverObjects[bestMerge], matrix);
                    // Don't set merged=true — skip this pair
                } else {
                    merged = true;
                    console.log(`[MERGE] Merged routes -> ${driverObjects[i].currentPackages} pkgs, ${Math.round(totalTime/60)}min`);
                    break; // Restart scan after a merge
                }
            }
        }
    }
    
    // Remove empty drivers
    return driverObjects.filter(d => d.route.length > 0);
};

// =====================================================
// POST-PROCESSING: Swap-optimize stop assignments
//
// For each stop in each route, check if moving it to
// another driver whose route is closer would be better.
// Only move if: fits capacity, fits time, AND reduces
// total inter-stop distance. Runs multiple passes until
// no more beneficial swaps exist.
// =====================================================
const swapOptimize = (driverObjects, matrix, label = '') => {
    let totalSwaps = 0;
    let pass = 0;
    const maxPasses = 10;
    
    while (pass < maxPasses) {
        pass++;
        let swapsThisPass = 0;
        
        for (let srcIdx = 0; srcIdx < driverObjects.length; srcIdx++) {
            const srcDriver = driverObjects[srcIdx];
            if (srcDriver.route.length <= 1) continue; // Don't empty a route
            
            for (let stopIdx = srcDriver.route.length - 1; stopIdx >= 0; stopIdx--) {
                // Don't remove the last stop from a route
                if (srcDriver.route.length <= 1) break;
                
                const stop = srcDriver.route[stopIdx];
                
                // Distance from this stop to source route's other stops
                let srcRouteDist = 0;
                let srcCount = 0;
                srcDriver.route.forEach((other, oi) => {
                    if (oi !== stopIdx) {
                        const d = matrix[stop.matrix_index][other.matrix_index];
                        if (d < UNREACHABLE) { srcRouteDist += d; srcCount++; }
                    }
                });
                const avgDistToSrc = srcCount > 0 ? srcRouteDist / srcCount : Infinity;
                
                // Find if any other driver's route is closer
                let bestTarget = null;
                let bestAvgDist = avgDistToSrc;
                
                for (let tgtIdx = 0; tgtIdx < driverObjects.length; tgtIdx++) {
                    if (tgtIdx === srcIdx) continue;
                    const tgtDriver = driverObjects[tgtIdx];
                    if (tgtDriver.route.length === 0) continue;
                    
                    // Capacity check: count + cubic volume + longest item
                    if (!fitsVehicle(tgtDriver, stop)) continue;
                    
                    // Distance from stop to target route's stops
                    let tgtRouteDist = 0;
                    let tgtCount = 0;
                    tgtDriver.route.forEach(other => {
                        const d = matrix[stop.matrix_index][other.matrix_index];
                        if (d < UNREACHABLE) { tgtRouteDist += d; tgtCount++; }
                    });
                    const avgDistToTgt = tgtCount > 0 ? tgtRouteDist / tgtCount : Infinity;
                    
                    // Must be closer (even small improvement counts)
                    if (avgDistToTgt >= bestAvgDist * 0.98) continue;
                    
                    // Time check for target: would adding this stop fit?
                    const closestInTarget = minDistToRoute(stop.matrix_index, tgtDriver.route, matrix);
                    const addedDrive = closestInTarget * TRAFFIC_CITY;
                    const addedService = stop.tbas.length * SECONDS_PER_PKG;
                    if (tgtDriver.currentDriveTime + tgtDriver.currentServiceTime + addedDrive + addedService > tgtDriver.timeBudget) continue;
                    
                    bestAvgDist = avgDistToTgt;
                    bestTarget = tgtIdx;
                }
                
                if (bestTarget !== null) {
                    // Move stop from src to target
                    const tgtDriver = driverObjects[bestTarget];
                    srcDriver.route.splice(stopIdx, 1);
                    tgtDriver.route.push(stop);
                    
                    // Recalc both
                    recalcDriverTime(srcDriver, matrix);
                    recalcDriverTime(tgtDriver, matrix);
                    
                    swapsThisPass++;
                    totalSwaps++;
                }
            }
        }
        
        if (swapsThisPass === 0) break;
    }
    
    if (totalSwaps > 0) {
        console.log(`[${label}SWAP] ${totalSwaps} stops reassigned across ${pass} passes`);
        // Re-optimize route order after swaps moved stops around
        driverObjects.forEach(d => {
            if (d.route.length >= 3) recalcDriverTime(d, matrix, true);
        });
    }
    
    return driverObjects.filter(d => d.route.length > 0);
};

// Explain why each leftover stop could not be placed. The overflow panel
// is useless without this -- "unassigned" alone tells a dispatcher nothing.
const annotateOverflow = (overflowStops, bestVehicleId, matrix) => {
    const cap = tierCapacity(bestVehicleId);
    overflowStops.forEach(stop => {
        const reasons = [];
        if ((stop.maxDimCm || 0) > cap.maxDimCm) {
            reasons.push(`Longest side ${stop.maxDimCm}cm exceeds the ${cap.maxDimCm}cm limit for the largest vehicle in the fleet`);
        }
        if ((stop.volumeL || 0) > cap.usableL) {
            reasons.push(`Needs ${Math.round(stop.volumeL)}L but the largest vehicle holds ${cap.usableL}L`);
        }
        if (stop.tbas.length > VAN_CAPACITY) {
            reasons.push(`${stop.tbas.length} packages exceeds the ${VAN_CAPACITY}-package van limit`);
        }
        const stem = matrix[0][stop.matrix_index];
        if (stem >= UNREACHABLE) {
            reasons.push('No drivable route from the warehouse to this ZIP');
        } else if (reasons.length === 0) {
            const stemMin = Math.round((stem * TRAFFIC_HIGHWAY) / 60);
            reasons.push(`No driver had time or space left; ${stemMin} min from the warehouse`);
        }
        stop.overflowReason = reasons.join('. ');
    });
};

const planRoutesForRegion = (regionalZips, driverList, matrix, startPoint, mode = 'auto') => {
    if (regionalZips.length === 0 || driverList.length === 0) return [];

    // Assign matrix indices (matrix row 0 = warehouse, 1..N = stops)
    regionalZips.forEach((wp, i) => { wp.matrix_index = i + 1; });

    // Split against the largest vehicle any driver in this fleet has.
    const fleetTopVehicle = driverList.reduce((best, d) => {
        const order = VEHICLE_TIERS.findIndex(t => t.id === (d.vehicle || LARGEST_TIER));
        const bestOrder = VEHICLE_TIERS.findIndex(t => t.id === best);
        return order > bestOrder ? (d.vehicle || LARGEST_TIER) : best;
    }, VEHICLE_TIERS[0].id);
    const splitZips = splitBigZips(regionalZips, VAN_CAPACITY, tierCapacity(fleetTopVehicle).usableL);
    const totalPackages = splitZips.reduce((sum, zip) => sum + (zip.tbas ? zip.tbas.length : 0), 0);

    console.log(`\n[Router V12] Mode: ${mode.toUpperCase()} | TERRITORIAL`);
    console.log(`[Router V12] ${totalPackages} packages across ${splitZips.length} stops (after split)`);

    let unassigned = splitZips.map(wp => ({ ...wp, isAssigned: false }));

    // =====================================================
    // FIND BEST SEED: densest area reachable from warehouse
    // =====================================================
    const findBestSeed = (excludeIndices, maxStemTime, searchRadius, vehicleId = LARGEST_TIER) => {
        const cap = tierCapacity(vehicleId);
        const available = unassigned.filter(u => {
            if (u.isAssigned) return false;
            if (excludeIndices.has(u.matrix_index)) return false;
            // A seed the vehicle cannot physically hold is not a seed
            if ((u.maxDimCm || 0) > cap.maxDimCm) return false;
            if ((u.volumeL || 0) > cap.usableL) return false;
            const dist = matrix[0][u.matrix_index];
            return dist < UNREACHABLE && dist <= maxStemTime;
        });

        if (available.length === 0) return null;

        const bags = available.filter(u => u.isBag);
        const pool = bags.length > 0 ? bags : available;

        let bestSeed = null;
        let bestScore = Infinity;

        pool.forEach(pkg => {
            const distFromWarehouse = matrix[0][pkg.matrix_index];
            let score = distFromWarehouse;
            score -= pkg.tbas.length * 60;

            // Density bonus
            let nearbyPackages = 0;
            available.forEach(other => {
                if (other.matrix_index !== pkg.matrix_index) {
                    const dist = matrix[pkg.matrix_index][other.matrix_index];
                    if (dist < searchRadius) nearbyPackages += other.tbas.length;
                }
            });
            score -= nearbyPackages * 30;

            if (score < bestScore) {
                bestScore = score;
                bestSeed = pkg;
            }
        });

        return bestSeed;
    };

    // =====================================================
    // AUTO MODE — sequential drivers with relaxation tiers
    // =====================================================
    if (mode === 'auto') {
        const maxHours = driverList[0].maxHours;
        // Fleet ceiling: the largest vehicle auto-plan is allowed to assume.
        // Each finished route is then classified DOWN to the smallest tier
        // that actually fits it, so the dispatcher learns what they need.
        const fleetVehicle = driverList[0].vehicle || LARGEST_TIER;
        const baseConstraints = getConstraints(maxHours);

        console.log(`[AUTO] Fleet ceiling: ${fleetVehicle} (${tierCapacity(fleetVehicle).usableL}L usable, max item ${tierCapacity(fleetVehicle).maxDimCm}cm)`);
        console.log(`[AUTO] ${maxHours}h drivers | stem: ${Math.round(baseConstraints.maxStemTime/60)}min | diameter: ${Math.round(baseConstraints.maxDiameter/60)}min | step: ${Math.round(baseConstraints.stepLimit/60)}min`);

        const finalRoutes = [];
        let driverCount = 0;

        while (unassigned.filter(u => !u.isAssigned).length > 0) {
            driverCount++;

            const driver = {
                id: driverCount,
                maxHours: maxHours,
                vehicle: fleetVehicle,
                timeBudget: maxHours * 3600,
                currentPackages: 0,
                currentVolume: 0,
                currentMaxDim: 0,
                currentDriveTime: 0,
                currentServiceTime: 0,
                route: [],
                assignedIndices: new Set()
            };

            // Try to find a seed — widen stem radius across tiers if needed
            let seed = null;
            for (let tier = 0; tier < RELAXATION_TIERS.length && !seed; tier++) {
                const relaxed = getConstraints(maxHours, RELAXATION_TIERS[tier]);
                seed = findBestSeed(new Set(), relaxed.maxStemTime, relaxed.stepLimit, fleetVehicle);
            }

            if (!seed) {
                console.log(`[AUTO] No valid seed for Driver ${driverCount}, stopping`);
                break;
            }

            const stemTime = matrix[0][seed.matrix_index] * TRAFFIC_HIGHWAY;
            const serviceTime = seed.tbas.length * SECONDS_PER_PKG;

            if (stemTime + serviceTime > driver.timeBudget) {
                console.log(`[AUTO] Seed too far for time budget, stopping`);
                break;
            }

            seed.isAssigned = true;
            applyStop(driver, seed, stemTime, serviceTime);

            console.log(`[AUTO] Driver ${driverCount} seeded: "${seed.address}" (${seed.tbas.length} pkgs) @ ${Math.round(stemTime/60)}min`);

            // Grow with progressive relaxation tiers
            for (let tier = 0; tier < RELAXATION_TIERS.length; tier++) {
                const constraints = getConstraints(maxHours, RELAXATION_TIERS[tier]);
                let growing = true;

                while (growing) {
                    const remaining = unassigned.filter(u => !u.isAssigned);
                    if (remaining.length === 0) break;
                    if (driver.currentPackages >= VAN_CAPACITY) break;

                    const lastStop = driver.route[driver.route.length - 1];
                    let bestCandidate = null;
                    let bestScore = Infinity;

                    remaining.forEach(pkg => {
                        const addPkgs = pkg.tbas.length;
                        // Count + cubic volume + longest-item aperture
                        if (!fitsVehicle(driver, pkg)) return;

                        const distFromLast = matrix[lastStop.matrix_index][pkg.matrix_index];
                        if (distFromLast >= UNREACHABLE || distFromLast > constraints.stepLimit) return;

                        // Diameter check
                        let violates = false;
                        for (const idx of driver.assignedIndices) {
                            const dist = matrix[idx][pkg.matrix_index];
                            if (dist >= UNREACHABLE || dist > constraints.maxDiameter) { violates = true; break; }
                        }
                        if (violates) return;

                        // Time check (hard ceiling)
                        const addedDrive = distFromLast * TRAFFIC_CITY;
                        const addedService = addPkgs * SECONDS_PER_PKG;
                        if (driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService > driver.timeBudget) return;

                        let score = distFromLast;
                        if (pkg.address === lastStop.address) score *= (1 - SAME_AREA_BONUS);
                        score *= (1 - Math.min(addPkgs * PKG_COUNT_BONUS, 0.5));

                        if (score < bestScore) {
                            bestScore = score;
                            bestCandidate = { pkg, addedDrive, addedService };
                        }
                    });

                    if (bestCandidate) {
                        const { pkg, addedDrive, addedService } = bestCandidate;
                        pkg.isAssigned = true;
                        applyStop(driver, pkg, addedDrive, addedService);
                    } else {
                        growing = false;
                    }
                }
            }

            if (driver.route.length > 0) {
                console.log(`[AUTO] Driver ${driverCount} built: ${driver.route.length} stops, ${driver.currentPackages} pkgs`);
                driver.timeBudget = maxHours * 3600;
                finalRoutes.push(driver);
            }

            if (driverCount > 200) {
                console.log(`[AUTO] Safety limit reached (200 drivers)`);
                break;
            }
        }

        // =====================================================
        // SWEEP: Any remaining unassigned packages get new drivers.
        // Auto mode NEVER produces overflow — every package gets assigned.
        // Group remaining by proximity into clusters, each cluster = 1 driver.
        // =====================================================
        let remaining = unassigned.filter(u => !u.isAssigned);
        if (remaining.length > 0) {
            console.log(`[AUTO] Sweep phase: ${remaining.length} stops need new drivers`);
            
            while (remaining.length > 0) {
                driverCount++;
                const driver = {
                    id: driverCount,
                    maxHours: maxHours,
                    vehicle: fleetVehicle,
                    timeBudget: maxHours * 3600,
                    currentPackages: 0,
                    currentVolume: 0,
                    currentMaxDim: 0,
                    currentDriveTime: 0,
                    currentServiceTime: 0,
                    route: [],
                    assignedIndices: new Set()
                };
                
                // Pick the unassigned stop closest to warehouse as seed
                let bestSeed = null;
                let bestSeedDist = Infinity;
                remaining.forEach(pkg => {
                    if (!fitsVehicle(driver, pkg)) return;   // empty driver: pure vehicle fit
                    const d = matrix[0][pkg.matrix_index];
                    if (d < bestSeedDist) {
                        bestSeedDist = d;
                        bestSeed = pkg;
                    }
                });

                // Nothing left that this vehicle can carry -> stop sweeping.
                // Whatever remains falls through to overflow with a reason.
                if (!bestSeed) break;
                
                bestSeed.isAssigned = true;
                applyStop(driver, bestSeed, bestSeedDist * TRAFFIC_HIGHWAY, bestSeed.tbas.length * SECONDS_PER_PKG);
                
                // Greedily add nearest remaining stops that fit time + capacity
                let growing = true;
                while (growing) {
                    growing = false;
                    remaining = unassigned.filter(u => !u.isAssigned);
                    if (remaining.length === 0) break;
                    if (driver.currentPackages >= VAN_CAPACITY) break;
                    
                    const lastStop = driver.route[driver.route.length - 1];
                    let nearest = null;
                    let nearestDist = Infinity;
                    
                    remaining.forEach(pkg => {
                        if (!fitsVehicle(driver, pkg)) return;
                        const d = matrix[lastStop.matrix_index][pkg.matrix_index];
                        if (d >= UNREACHABLE) return;
                        
                        const addedDrive = d * TRAFFIC_CITY;
                        const addedService = pkg.tbas.length * SECONDS_PER_PKG;
                        if (driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService > driver.timeBudget) return;
                        
                        if (d < nearestDist) {
                            nearestDist = d;
                            nearest = { pkg, addedDrive: d * TRAFFIC_CITY, addedService: pkg.tbas.length * SECONDS_PER_PKG };
                        }
                    });
                    
                    if (nearest) {
                        nearest.pkg.isAssigned = true;
                        applyStop(driver, nearest.pkg, nearest.addedDrive, nearest.addedService);
                        growing = true;
                    }
                }
                
                if (driver.route.length > 0) {
                    console.log(`[AUTO] Sweep Driver ${driverCount}: ${driver.route.length} stops, ${driver.currentPackages} pkgs`);
                    finalRoutes.push(driver);
                }
                
                remaining = unassigned.filter(u => !u.isAssigned);
                
                if (driverCount > 200) {
                    console.log(`[AUTO] Sweep safety limit (200 drivers)`);
                    break;
                }
            }
        }

        // =====================================================
        // POST-PROCESSING: Merge close routes, then swap-optimize
        // =====================================================
        console.log(`[AUTO] Pre-optimize: ${finalRoutes.length} routes`);
        let optimizedDrivers = mergeCloseRoutes(finalRoutes, matrix, maxHours);
        console.log(`[AUTO] After merge: ${optimizedDrivers.length} routes`);
        optimizedDrivers = swapOptimize(optimizedDrivers, matrix, 'AUTO ');
        
        // Re-index and finalize
        const results = [];
        optimizedDrivers.forEach((driver, idx) => {
            driver.id = idx + 1;
            const result = finalizeRoute(driver, startPoint, matrix);
            console.log(`[AUTO] Driver ${driver.id} final: ${driver.route.length} stops, ${driver.currentPackages} pkgs, ${result.totalVolumeL}L, longest ${result.maxDimCm}cm -> ${result.requiredVehicle}, ${result.totalHours.toFixed(2)}h`);
            results.push(result);
        });

        // Overflow
        const overflow = unassigned.filter(u => !u.isAssigned);
        if (overflow.length > 0) {
            annotateOverflow(overflow, fleetVehicle, matrix);
            const overflowPkgs = overflow.reduce((s, o) => s + o.tbas.length, 0);
            console.log(`[AUTO] OVERFLOW: ${overflow.length} stops, ${overflowPkgs} packages`);
            overflow.forEach(o => console.log(`   - ${o.address} (${o.tbas.length} pkgs): ${o.overflowReason}`));
            results.push({
                route: overflow, totalHours: 0, driverId: "OVERFLOW", driverMax: 0, isOverflow: true,
                totalVolumeL: +overflow.reduce((s, o) => s + (o.volumeL || 0), 0).toFixed(1),
                maxDimCm: overflow.reduce((m, o) => Math.max(m, o.maxDimCm || 0), 0),
                totalPackages: overflowPkgs
            });
        }

        return results;
    }

    // =====================================================
    // MANUAL MODE — TERRITORIAL AUCTION + relaxation tiers
    //
    // Key idea: each unassigned package "belongs" to the
    // driver whose existing route is geographically closest.
    // Drivers can ONLY pick from their own territory.
    // This prevents routes from crossing each other.
    // =====================================================
    else {
        const totalHours = driverList.reduce((sum, d) => sum + d.maxHours, 0);
        const isSparse = (totalPackages / driverList.length) < 15;

        const drivers = driverList.map(d => {
            const hourRatio = d.maxHours / totalHours;
            let budget = Math.ceil(totalPackages * hourRatio);
            budget = Math.min(budget, VAN_CAPACITY);
            budget = Math.max(budget, 5);
            if (isSparse) budget = VAN_CAPACITY;

            const constraints = getConstraints(d.maxHours);

            const vcap = tierCapacity(d.vehicle || LARGEST_TIER);
            console.log(`[MANUAL] Driver ${d.id}: ${d.maxHours}h ${d.vehicle || LARGEST_TIER} -> ${budget} pkgs / ${vcap.usableL}L | stem: ${Math.round(constraints.maxStemTime/60)}min${isSparse ? ' [SPARSE]' : ''}`);

            return {
                id: d.id,
                maxHours: d.maxHours,
                vehicle: d.vehicle || LARGEST_TIER,
                timeBudget: d.maxHours * 3600,
                packageBudget: budget,
                maxStemTime: constraints.maxStemTime,
                currentPackages: 0,
                currentVolume: 0,
                currentMaxDim: 0,
                currentDriveTime: 0,
                currentServiceTime: 0,
                route: [],
                assignedIndices: new Set()
            };
        });

        // Sort by hours (longest first — they seed farther out)
        drivers.sort((a, b) => b.maxHours - a.maxHours);

        // =====================================================
        // SEED: Farthest-first spread — maximize geographic coverage
        //
        // First seed = densest reachable area (classic).
        // Each subsequent seed = farthest from ALL existing seeds,
        // weighted by local density. This ensures seeds cover
        // distinct geographic clusters instead of bunching up.
        // =====================================================
        const baseConstraints = getConstraints(drivers[0].maxHours);
        const seedIndices = []; // matrix_index of each placed seed
        
        drivers.forEach((driver, driverIdx) => {
            const driverCap = tierCapacity(driver.vehicle);
            const available = unassigned.filter(u => {
                if (u.isAssigned) return false;
                // Never seed a driver with a stop their vehicle cannot hold
                if ((u.maxDimCm || 0) > driverCap.maxDimCm) return false;
                if ((u.volumeL || 0) > driverCap.usableL) return false;
                const dist = matrix[0][u.matrix_index];
                return dist < UNREACHABLE && dist <= driver.maxStemTime;
            });
            
            if (available.length === 0) return;
            
            const bags = available.filter(u => u.isBag);
            const pool = bags.length > 0 ? bags : available;
            
            let bestSeed = null;
            let bestScore = -Infinity;
            
            pool.forEach(pkg => {
                // Density: count nearby unassigned packages
                let nearbyPkgs = 0;
                available.forEach(other => {
                    if (other.matrix_index !== pkg.matrix_index) {
                        const d = matrix[pkg.matrix_index][other.matrix_index];
                        if (d < baseConstraints.stepLimit) nearbyPkgs += other.tbas.length;
                    }
                });
                
                if (driverIdx === 0) {
                    // First seed: densest area closest to warehouse (original behavior)
                    const distFromWarehouse = matrix[0][pkg.matrix_index];
                    const score = -distFromWarehouse + (pkg.tbas.length * 60) + (nearbyPkgs * 30);
                    if (score > bestScore) {
                        bestScore = score;
                        bestSeed = pkg;
                    }
                } else {
                    // Subsequent seeds: maximize min distance to existing seeds, weighted by density
                    let minDistToExisting = Infinity;
                    for (const existIdx of seedIndices) {
                        const d = matrix[existIdx][pkg.matrix_index];
                        if (d < minDistToExisting) minDistToExisting = d;
                    }
                    
                    // Score: density primary, spread secondary
                    // Density-first prevents seeds jumping to far areas when
                    // nearby clusters still need coverage
                    const score = (minDistToExisting * 1) + (nearbyPkgs * 40) + (pkg.tbas.length * 60);
                    if (score > bestScore) {
                        bestScore = score;
                        bestSeed = pkg;
                    }
                }
            });
            
            if (bestSeed) {
                const stemTime = matrix[0][bestSeed.matrix_index] * TRAFFIC_HIGHWAY;
                const serviceTime = bestSeed.tbas.length * SECONDS_PER_PKG;
                
                if (stemTime + serviceTime > driver.timeBudget) return;
                
                bestSeed.isAssigned = true;
                applyStop(driver, bestSeed, stemTime, serviceTime);
                seedIndices.push(bestSeed.matrix_index);
                
                console.log(`[MANUAL] Driver ${driver.id} seeded: "${bestSeed.address}" (${bestSeed.tbas.length} pkgs) @ ${Math.round(stemTime/60)}min`);
            }
        });

        // =====================================================
        // TERRITORIAL AUCTION with progressive relaxation
        //
        // Each round:
        //  1. For each unassigned pkg, find which seeded driver's
        //     route is closest (min matrix dist to any route stop)
        //  2. Each driver picks the best candidate from ONLY
        //     their territorial pool (closest to last stop)
        //  3. Capacity + time checks still enforced
        //  4. If nobody can grab anything, relax to next tier
        // =====================================================
        const seededDrivers = drivers.filter(d => d.route.length > 0);

        for (let tier = 0; tier < RELAXATION_TIERS.length; tier++) {
            const relaxMult = RELAXATION_TIERS[tier];

            const remaining = unassigned.filter(u => !u.isAssigned);
            if (remaining.length === 0) break;

            if (tier > 0) {
                console.log(`[MANUAL] Relaxation tier ${tier} (${relaxMult}x): ${remaining.length} stops remaining`);
            }

            // Per-driver constraints at this tier
            const driverConstraints = {};
            seededDrivers.forEach(d => {
                driverConstraints[d.id] = getConstraints(d.maxHours, relaxMult);
            });

            let tierStalled = false;
            let iterations = 0;
            const maxIterations = totalPackages * 3;

            while (!tierStalled && iterations < maxIterations) {
                iterations++;

                const stillRemaining = unassigned.filter(u => !u.isAssigned);
                if (stillRemaining.length === 0) break;

                // ---- TERRITORIAL MAPPING ----
                // Each package "belongs" to the driver whose route is closest
                const driverBins = {};
                seededDrivers.forEach(d => { driverBins[d.id] = []; });

                stillRemaining.forEach(pkg => {
                    let closestDriver = null;
                    let closestDist = Infinity;

                    seededDrivers.forEach(driver => {
                        // Skip full drivers (count, budget, or cubic) and
                        // drivers whose vehicle physically cannot take this stop
                        if (driver.currentPackages >= driver.packageBudget) return;
                        if (!fitsVehicle(driver, pkg)) return;

                        const dist = minDistToRoute(pkg.matrix_index, driver.route, matrix);
                        if (dist < closestDist) {
                            closestDist = dist;
                            closestDriver = driver;
                        }
                    });

                    if (closestDriver) {
                        driverBins[closestDriver.id].push({ pkg, routeDist: closestDist });
                    }
                });

                // ---- EACH DRIVER PICKS BEST FROM THEIR TERRITORY ----
                let madeAssignment = false;

                seededDrivers.forEach(driver => {
                    if (driver.currentPackages >= driver.packageBudget) return;
                    if (driver.currentPackages >= VAN_CAPACITY) return;

                    const myPool = driverBins[driver.id];
                    if (!myPool || myPool.length === 0) return;

                    const constraints = driverConstraints[driver.id];
                    const lastStop = driver.route[driver.route.length - 1];

                    let bestCandidate = null;
                    let bestScore = Infinity;

                    myPool.forEach(({ pkg }) => {
                        if (pkg.isAssigned) return;

                        const addPkgs = pkg.tbas.length;
                        if (!fitsVehicle(driver, pkg)) return;

                        const distFromLast = matrix[lastStop.matrix_index][pkg.matrix_index];
                        if (distFromLast >= UNREACHABLE) return;

                        // Step check
                        if (distFromLast > constraints.stepLimit) return;

                        // Diameter check
                        let violates = false;
                        for (const idx of driver.assignedIndices) {
                            const dist = matrix[idx][pkg.matrix_index];
                            if (dist >= UNREACHABLE || dist > constraints.maxDiameter) { violates = true; break; }
                        }
                        if (violates) return;

                        // Time check (hard ceiling)
                        const addedDrive = distFromLast * TRAFFIC_CITY;
                        const addedService = addPkgs * SECONDS_PER_PKG;
                        const newTime = driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService;
                        if (newTime > driver.timeBudget) return;

                        // Scoring: prefer closest to last stop + same-area bonus
                        let score = distFromLast;
                        if (pkg.address === lastStop.address) score *= (1 - SAME_AREA_BONUS);
                        score *= (1 - Math.min(addPkgs * PKG_COUNT_BONUS, 0.5));

                        if (score < bestScore) {
                            bestScore = score;
                            bestCandidate = { pkg, addedDrive, addedService };
                        }
                    });

                    if (bestCandidate) {
                        const { pkg, addedDrive, addedService } = bestCandidate;
                        pkg.isAssigned = true;
                        applyStop(driver, pkg, addedDrive, addedService);
                        madeAssignment = true;
                    }
                });

                if (!madeAssignment) tierStalled = true;
            }
        }

        // =====================================================
        // ORPHAN RESCUE: territorial — assign to closest route
        // only if time budget allows. No diameter/step checks.
        // =====================================================
        let orphans = unassigned.filter(u => !u.isAssigned);
        if (orphans.length > 0 && seededDrivers.length > 0) {
            console.log(`[MANUAL] Orphan rescue: ${orphans.length} stops to place`);

            // Sort orphans: farthest from warehouse first (hardest to place)
            orphans.sort((a, b) => matrix[0][b.matrix_index] - matrix[0][a.matrix_index]);

            orphans.forEach(orphan => {
                let bestDriver = null;
                let bestRouteDist = Infinity;

                seededDrivers.forEach(driver => {
                    if (!fitsVehicle(driver, orphan)) return;

                    // Min distance from orphan to this driver's route
                    const dist = minDistToRoute(orphan.matrix_index, driver.route, matrix);
                    if (dist >= UNREACHABLE) return;

                    // Time check
                    const addedDrive = dist * TRAFFIC_CITY;
                    const addedService = orphan.tbas.length * SECONDS_PER_PKG;
                    const newTime = driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService;
                    if (newTime > driver.timeBudget) return;

                    if (dist < bestRouteDist) {
                        bestRouteDist = dist;
                        bestDriver = { driver, addedDrive, addedService };
                    }
                });

                if (bestDriver) {
                    const { driver, addedDrive, addedService } = bestDriver;
                    orphan.isAssigned = true;
                    applyStop(driver, orphan, addedDrive, addedService);
                    console.log(`[MANUAL] Orphan "${orphan.address}" (${orphan.tbas.length} pkgs) -> Driver ${driver.id}`);
                }
            });
        }

        // =====================================================
        // UNUSED DRIVER SWEEP: If packages remain AND there are
        // drivers with no route yet, put those drivers to work.
        // Seed them with remaining packages and grow greedily.
        // =====================================================
        let stillRemaining = unassigned.filter(u => !u.isAssigned);
        const unusedDrivers = drivers.filter(d => d.route.length === 0);
        
        if (stillRemaining.length > 0 && unusedDrivers.length > 0) {
            console.log(`[MANUAL] Unused driver sweep: ${stillRemaining.length} stops, ${unusedDrivers.length} unused drivers`);
            
            for (const driver of unusedDrivers) {
                stillRemaining = unassigned.filter(u => !u.isAssigned);
                if (stillRemaining.length === 0) break;
                
                // Seed with closest unassigned to warehouse
                let bestSeed = null;
                let bestDist = Infinity;
                stillRemaining.forEach(pkg => {
                    const d = matrix[0][pkg.matrix_index];
                    if (d < UNREACHABLE && d < bestDist) {
                        // Time feasibility + vehicle feasibility
                        const stemTime = d * TRAFFIC_HIGHWAY;
                        const serviceTime = pkg.tbas.length * SECONDS_PER_PKG;
                        if (stemTime + serviceTime <= driver.timeBudget && fitsVehicle(driver, pkg)) {
                            bestDist = d;
                            bestSeed = pkg;
                        }
                    }
                });
                
                if (!bestSeed) continue;
                
                bestSeed.isAssigned = true;
                applyStop(driver, bestSeed, bestDist * TRAFFIC_HIGHWAY, bestSeed.tbas.length * SECONDS_PER_PKG);
                
                // Greedily grow: nearest unassigned that fits
                let growing = true;
                while (growing) {
                    growing = false;
                    const left = unassigned.filter(u => !u.isAssigned);
                    if (left.length === 0) break;
                    if (driver.currentPackages >= VAN_CAPACITY) break;
                    
                    const lastStop = driver.route[driver.route.length - 1];
                    let nearest = null;
                    let nearestDist = Infinity;
                    
                    left.forEach(pkg => {
                        if (!fitsVehicle(driver, pkg)) return;
                        const d = matrix[lastStop.matrix_index][pkg.matrix_index];
                        if (d >= UNREACHABLE) return;
                        
                        const addedDrive = d * TRAFFIC_CITY;
                        const addedService = pkg.tbas.length * SECONDS_PER_PKG;
                        if (driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService > driver.timeBudget) return;
                        
                        if (d < nearestDist) {
                            nearestDist = d;
                            nearest = { pkg, addedDrive, addedService };
                        }
                    });
                    
                    if (nearest) {
                        nearest.pkg.isAssigned = true;
                        applyStop(driver, nearest.pkg, nearest.addedDrive, nearest.addedService);
                        growing = true;
                    }
                }
                
                if (driver.route.length > 0) {
                    console.log(`[MANUAL] Unused Driver ${driver.id} activated: ${driver.route.length} stops, ${driver.currentPackages} pkgs`);
                }
            }
        }

        // =====================================================
        // POST-PROCESSING: Swap-optimize stop assignments
        // =====================================================
        let activeDrivers = drivers.filter(d => d.route.length > 0);
        activeDrivers = swapOptimize(activeDrivers, matrix, 'MANUAL ');

        // =====================================================
        // REBALANCE: Fill empty drivers by splitting heavy routes
        //
        // If fewer drivers have routes than were requested,
        // take the farthest stops from the heaviest routes and
        // give them to empty drivers. This ensures every driver
        // the dispatcher added gets a route.
        // =====================================================
        let emptyDrivers = drivers.filter(d => d.route.length === 0);
        
        while (emptyDrivers.length > 0) {
            // Find the route with the most stops (must have >=3 to split)
            activeDrivers = drivers.filter(d => d.route.length > 0);
            let heaviest = null;
            let heaviestStops = 0;
            activeDrivers.forEach(d => {
                if (d.route.length > heaviestStops) {
                    heaviestStops = d.route.length;
                    heaviest = d;
                }
            });
            
            // Can't split a route with fewer than 3 stops
            if (!heaviest || heaviest.route.length < 3) {
                console.log(`[MANUAL] Rebalance: no route large enough to split (largest: ${heaviestStops} stops)`);
                break;
            }
            
            const emptyDriver = emptyDrivers[0];
            
            // Find the stop in the heaviest route that is farthest from
            // the route's other stops (the outlier). Peel it off along
            // with any nearby stops to form a new cluster for the empty driver.
            
            // Compute each stop's average distance to all other stops in the route
            const stopScores = heaviest.route.map((stop, idx) => {
                let totalDist = 0;
                let count = 0;
                heaviest.route.forEach((other, oi) => {
                    if (oi !== idx) {
                        const d = matrix[stop.matrix_index][other.matrix_index];
                        if (d < UNREACHABLE) { totalDist += d; count++; }
                    }
                });
                return { stop, idx, avgDist: count > 0 ? totalDist / count : 0 };
            });
            
            // Sort: farthest outliers first
            stopScores.sort((a, b) => b.avgDist - a.avgDist);
            
            // Take the top outlier(s): peel off ~half the stops or at least 1
            // Prefer peeling stops that are close to each other (cluster the peeled ones)
            const peelSeed = stopScores[0].stop;
            const peelIndices = new Set([stopScores[0].idx]);
            
            // How many to peel: aim for fair share
            const targetPeel = Math.max(1, Math.floor(heaviest.route.length / 2));
            
            // Add stops closest to the peel seed, up to target
            const candidates = stopScores.slice(1).map(s => ({
                ...s,
                distToPeel: matrix[peelSeed.matrix_index][s.stop.matrix_index]
            })).sort((a, b) => a.distToPeel - b.distToPeel);
            
            for (const c of candidates) {
                if (peelIndices.size >= targetPeel) break;
                peelIndices.add(c.idx);
            }
            
            // Move peeled stops to the empty driver
            const peeledStops = [];
            const keptStops = [];
            heaviest.route.forEach((stop, idx) => {
                if (peelIndices.has(idx)) peeledStops.push(stop);
                else keptStops.push(stop);
            });
            
            heaviest.route = keptStops;
            emptyDriver.route = peeledStops;
            
            recalcDriverTime(heaviest, matrix, true);
            recalcDriverTime(emptyDriver, matrix, true);
            
            console.log(`[MANUAL] Rebalance: split Driver ${heaviest.id} (kept ${keptStops.length}) -> Driver ${emptyDriver.id} (got ${peeledStops.length})`);
            
            // Refresh the empty list
            emptyDrivers = drivers.filter(d => d.route.length === 0);
        }
        
        // Run swap-optimize again after rebalance to clean up
        emptyDrivers = drivers.filter(d => d.route.length === 0);
        activeDrivers = drivers.filter(d => d.route.length > 0);
        if (emptyDrivers.length === 0 && activeDrivers.length === drivers.length) {
            activeDrivers = swapOptimize(activeDrivers, matrix, 'MANUAL-REBAL ');
        }

        // =====================================================
        // FINALIZE
        // =====================================================
        const finalRoutes = [];

        activeDrivers.forEach(driver => {
            const result = finalizeRoute(driver, startPoint, matrix);
            const utilPct = Math.round((result.totalHours / driver.maxHours) * 100);
            const volPct = result.vehicleUsagePct !== null ? `${result.vehicleUsagePct}% vol` : `${result.totalVolumeL}L`;
            console.log(`[MANUAL] Driver ${driver.id} [${driver.vehicle}]: ${driver.route.length} stops, ${driver.currentPackages} pkgs, ${volPct}, needs ${result.requiredVehicle}, ${result.totalHours.toFixed(2)}h/${driver.maxHours}h (${utilPct}%)`);
            finalRoutes.push(result);
        });

        // Overflow
        const overflow = unassigned.filter(u => !u.isAssigned);
        if (overflow.length > 0) {
            annotateOverflow(overflow, fleetTopVehicle, matrix);
            const overflowPkgs = overflow.reduce((s, o) => s + o.tbas.length, 0);
            console.log(`[MANUAL] OVERFLOW: ${overflow.length} stops, ${overflowPkgs} packages`);
            overflow.forEach(o => console.log(`   - ${o.address} (${o.tbas.length} pkgs): ${o.overflowReason}`));
            finalRoutes.push({
                route: overflow, totalHours: 0, driverId: "OVERFLOW", driverMax: 0, isOverflow: true,
                totalVolumeL: +overflow.reduce((s, o) => s + (o.volumeL || 0), 0).toFixed(1),
                maxDimCm: overflow.reduce((m, o) => Math.max(m, o.maxDimCm || 0), 0),
                totalPackages: overflowPkgs
            });
        }

        return finalRoutes;
    }
};

// =====================================================
// API ENDPOINT
// =====================================================

app.post('/calculate-routes', async (req, res) => {
    try {
        const { loosePackages = [], bags = [], drivers, mode, residentialOnly = false } = req.body;

        console.log(`\n========== NEW REQUEST ==========`);
        console.log(`Mode: "${mode}" | Drivers: ${drivers ? drivers.length : 0}`);

        if (mode === 'manual' && drivers && drivers.length > 0) {
            drivers.forEach(d => console.log(`  - Driver ${d.id}: ${d.maxHours}h`));
        } else if (mode === 'auto' && drivers && drivers.length > 0) {
            console.log(`  - Auto with ${drivers[0].maxHours}h blocks`);
        }

        if (!drivers) return res.status(400).json({ error: 'No drivers' });

        // =====================================================
        // INTAKE FILTERS
        // Packages are split into three streams before routing:
        //   deliverable   -> goes to drivers
        //   fcReturns     -> destination is a station code, not a customer
        //   addressHolds  -> non-residential while residential-only is on
        // Only the first stream reaches the solver.
        // =====================================================
        const fcReturns = [];
        const addressHolds = [];
        const deliverable = [];

        const isCustomerDestination = (dest) => {
            if (dest === undefined || dest === null) return true;   // blank = customer
            const d = dest.toString().trim();
            if (d === '') return true;
            return d.toUpperCase() === 'CUSTOMER_ADDRESS';
        };

        const isResidential = (addrType) => {
            if (addrType === undefined || addrType === null) return true;  // blank = residential
            const a = addrType.toString().trim();
            if (a === '') return true;
            return a.toUpperCase() === 'RESIDENTIAL';
        };

        const screen = (p, bagName = null) => {
            if (!isCustomerDestination(p.destination)) {
                fcReturns.push({ ...p, bagName, reason: `Destination "${p.destination}" is a facility code, not a customer address` });
                return false;
            }
            if (residentialOnly && !isResidential(p.addressType)) {
                addressHolds.push({ ...p, bagName, reason: `Address type "${p.addressType}" is not residential` });
                return false;
            }
            deliverable.push(p);
            return true;
        };

        // Volume metadata per TBA, computed once and reused everywhere
        const metaFor = (p) => {
            if (p.volumeL !== undefined && p.maxDimCm !== undefined) {
                return { effectiveL: +p.volumeL || 0, maxDimCm: +p.maxDimCm || 0, category: p.category || 'UNKNOWN' };
            }
            const v = packageVolume(p.length, p.width, p.height);
            return { effectiveL: v.effectiveL, maxDimCm: v.maxDimCm, category: v.category };
        };

        const looseZipMap = {};
        const looseZipMeta = {};
        const looseZipVol = {};
        const looseZipMaxDim = {};

        loosePackages.forEach(p => {
            if (!screen(p)) return;
            const m = metaFor(p);
            if (!looseZipMap[p.postal]) {
                looseZipMap[p.postal] = [];
                looseZipMeta[p.postal] = {};
                looseZipVol[p.postal] = 0;
                looseZipMaxDim[p.postal] = 0;
            }
            looseZipMap[p.postal].push(p.tba);
            looseZipMeta[p.postal][p.tba] = m;
            looseZipVol[p.postal] += m.effectiveL;
            looseZipMaxDim[p.postal] = Math.max(looseZipMaxDim[p.postal], m.maxDimCm);
        });
        const uniqueLooseZips = Object.keys(looseZipMap);

        if (fcReturns.length > 0) console.log(`[INTAKE] ${fcReturns.length} package(s) held for FC return`);
        if (addressHolds.length > 0) console.log(`[INTAKE] ${addressHolds.length} package(s) held: non-residential`);

        // Bags are screened per item; a bag keeps only its deliverable items.
        const screenedBags = bags.map(b => ({
            name: b.name,
            items: b.items.filter(i => screen(i, b.name))
        })).filter(b => b.items.length > 0);

        const bagZips = new Set();
        screenedBags.forEach(b => b.items.forEach(i => bagZips.add(i.postal)));

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
                    pkgMeta: looseZipMeta[z],
                    volumeL: +looseZipVol[z].toFixed(2),
                    maxDimCm: +looseZipMaxDim[z].toFixed(1),
                    isBag: false
                });
            }
        });

        screenedBags.forEach(bag => {
            let latSum = 0, lngSum = 0, count = 0, state = 'UNKNOWN';
            const tbas = [];
            const meta = {};
            let bagVol = 0, bagMaxDim = 0;
            bag.items.forEach(item => {
                const g = geoMap[item.postal];
                if (g) {
                    latSum += g.coordinates.lat;
                    lngSum += g.coordinates.lng;
                    state = g.state;
                    count++;
                }
                tbas.push(item.tba);
                const m = metaFor(item);
                meta[item.tba] = m;
                bagVol += m.effectiveL;
                bagMaxDim = Math.max(bagMaxDim, m.maxDimCm);
            });
            if (count > 0) {
                allStops.push({
                    address: bag.name,
                    coordinates: { lat: latSum / count, lng: lngSum / count },
                    state: state,
                    tbas: tbas,
                    pkgMeta: meta,
                    volumeL: +bagVol.toFixed(2),
                    maxDimCm: +bagMaxDim.toFixed(1),
                    isBag: true
                });
            }
        });

        const totalVol = allStops.reduce((s, x) => s + (x.volumeL || 0), 0);
        console.log(`Total stops: ${allStops.length} | Packages: ${allStops.reduce((s, x) => s + x.tbas.length, 0)} | Volume: ${totalVol.toFixed(0)}L`);

        const buckets = allStops.reduce((acc, s) => {
            (acc[s.state] = acc[s.state] || []).push(s);
            return acc;
        }, {});

        let allRoutes = [];
        for (const state of Object.keys(buckets)) {
            console.log(`\n--- Processing ${state}: ${buckets[state].length} stops ---`);
            const stops = buckets[state];
            const matrix = await getDistanceMatrix([startingLocation, ...stops]);
            const result = planRoutesForRegion(stops, drivers, matrix, startingLocation, mode);
            allRoutes.push(...result);
        }

        // Re-index driver IDs
        let driverIdx = 1;
        allRoutes.forEach(r => {
            if (!r.driverId.toString().includes("OVERFLOW")) {
                r.driverId = driverIdx++;
            }
        });

        // Flag any route whose load exceeds the vehicle it was assigned
        allRoutes.forEach(r => {
            if (r.driverId.toString().includes('OVERFLOW')) return;
            if (!r.assignedVehicle) return;
            const cap = tierCapacity(r.assignedVehicle);
            r.vehicleWarning = null;
            if (r.totalVolumeL > cap.usableL) {
                r.vehicleWarning = `Load ${r.totalVolumeL}L exceeds ${r.assignedVehicle} capacity ${cap.usableL}L`;
            } else if (r.maxDimCm > cap.maxDimCm) {
                r.vehicleWarning = `Longest item ${r.maxDimCm}cm will not fit a ${r.assignedVehicle}`;
            }
        });

        console.log(`\n========== COMPLETE: ${allRoutes.length} routes | ${fcReturns.length} FC | ${addressHolds.length} held ==========\n`);

        res.json({
            routes: allRoutes,
            fcReturns,
            addressHolds,
            vehicleTiers: VEHICLE_TIERS.map(t => ({
                id: t.id, label: t.label, color: t.color,
                usableL: TIER_BY_ID[t.id].usableL, maxDimCm: t.maxDimCm,
                zones: t.zones
            })),
            residentialOnly
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));