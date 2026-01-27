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

const optimizeRouteWith2Opt = (route, matrix) => {
    if (route.length < 4) return route;
    let improved = true;
    let iterations = 0;
    const maxIterations = 100;
    
    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;
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

// --- CONSTANTS ---
const VAN_CAPACITY = 48;
const SECONDS_PER_PKG = 180;      // 3 min per package
const UNREACHABLE = 99999;
const TRAFFIC_HIGHWAY = 1.0;
const TRAFFIC_CITY = 1.1;

// --- TUNING (ADJUST THESE FOR SPARSENESS) ---
// Base values for 2-hour drivers (TIGHTEST - close to warehouse)
const BASE_MAX_DIAMETER = 1200;    // 20 min
const BASE_STEP_LIMIT = 720;      // 12 min  hops
const BASE_STEM_RATIO = 0.75;     // first stop 

// Scaling per extra hour above 2h
const DIAMETER_PER_HOUR = 300;    // +5 min diameter per extra hour (allows 4h drivers to cover wide areas)
const STEP_PER_HOUR = 120;        // +2 min step per extra hour 
const STEM_RATIO_PER_HOUR = -0.02;// DECREASE stem ratio for longer routes (4h routes can afford less % on stem)

const SAME_AREA_BONUS = 0.6;      // Stronger pull for same ZIP (was 0.7)
const PKG_COUNT_BONUS = 0.20;     // 20% bonus per package (was 15%). Prioritize lockers/apartments.

// Helper to get constraints based on driver hours
const getConstraints = (hours) => {
    const extraHours = Math.max(0, hours - 2);
    const maxDiameter = BASE_MAX_DIAMETER + (extraHours * DIAMETER_PER_HOUR);
    const stepLimit = BASE_STEP_LIMIT + (extraHours * STEP_PER_HOUR);
    const stemRatio = Math.min(BASE_STEM_RATIO + (extraHours * STEM_RATIO_PER_HOUR), 0.30);
    
    return { maxDiameter, stepLimit, stemRatio };
};

// CONSTRAINTS BY HOURS:
// 2.0h: diameter=420s (7min), step=240s (4min), stem=14min max
// 2.5h: diameter=480s (8min), step=270s (4.5min), stem=18min max
// 3.0h: diameter=540s (9min), step=300s (5min), stem=22min max
// 3.5h: diameter=600s (10min), step=330s (5.5min), stem=25min max
// 4.0h: diameter=660s (11min), step=360s (6min), stem=29min max

// =====================================================
// V10: DENSITY-FIRST ROUTING
// - Clusters tight, nearby stops together
// - AUTO: Fills one driver completely before starting next
// - MANUAL: Maximizes packages with tight clusters
// =====================================================

const planRoutesForRegion = (regionalZips, driverList, matrix, startPoint, mode = 'auto') => {
    if (regionalZips.length === 0 || driverList.length === 0) return [];
    
    regionalZips.forEach((wp, i) => { wp.matrix_index = i + 1; });
    
    const totalPackages = regionalZips.reduce((sum, zip) => sum + (zip.tbas ? zip.tbas.length : 0), 0);
    
    console.log(`\n[Router V10] Mode: ${mode.toUpperCase()} | DENSITY-FIRST`);
    console.log(`[Router V10] ${totalPackages} packages across ${regionalZips.length} stops`);
    
    let unassigned = regionalZips.map(wp => ({ ...wp, isAssigned: false }));
    
    // =====================================================
    // FIND BEST SEED: Closest to warehouse with most packages
    // (NOT farthest - we want to build dense clusters outward)
    // =====================================================
    const findBestSeed = (excludeIndices, maxStemTime, stepLimit) => {
        const available = unassigned.filter(u => {
            if (u.isAssigned) return false;
            if (excludeIndices.has(u.matrix_index)) return false;
            const dist = matrix[0][u.matrix_index];
            return dist < UNREACHABLE && dist <= maxStemTime;
        });
        
        if (available.length === 0) return null;
        
        // Prioritize bags first
        const bags = available.filter(u => u.isBag);
        const pool = bags.length > 0 ? bags : available;
        
        // Score: prefer CLOSER to warehouse + MORE packages + DENSE area
        let bestSeed = null;
        let bestScore = Infinity;
        
        pool.forEach(pkg => {
            const distFromWarehouse = matrix[0][pkg.matrix_index];
            
            // Base score is distance (lower = better)
            let score = distFromWarehouse;
            
            // BONUS for more packages at this location
            score -= pkg.tbas.length * 60; // Each package reduces score by 60s
            
            // BONUS for having nearby unassigned packages (dense area)
            let nearbyPackages = 0;
            available.forEach(other => {
                if (other.matrix_index !== pkg.matrix_index) {
                    const dist = matrix[pkg.matrix_index][other.matrix_index];
                    if (dist < stepLimit) {
                        nearbyPackages += other.tbas.length;
                    }
                }
            });
            score -= nearbyPackages * 30; // Nearby packages reduce score
            
            if (score < bestScore) {
                bestScore = score;
                bestSeed = pkg;
            }
        });
        
        return bestSeed;
    };
    
    // =====================================================
    // GROW ROUTE: Add closest valid packages until full
    // Uses hour-based constraints for diameter and step
    // =====================================================
    const growRoute = (driver, constraints) => {
        const { maxDiameter, stepLimit } = constraints;
        let growing = true;
        
        while (growing) {
            const remaining = unassigned.filter(u => !u.isAssigned);
            if (remaining.length === 0) break;
            
            const lastStop = driver.route[driver.route.length - 1];
            
            let bestCandidate = null;
            let bestScore = Infinity;
            
            remaining.forEach(pkg => {
                const addPkgs = pkg.tbas.length;
                
                // Capacity check
                if (driver.currentPackages + addPkgs > VAN_CAPACITY) return;
                
                // Distance from last stop
                const distFromLast = matrix[lastStop.matrix_index][pkg.matrix_index];
                if (distFromLast >= UNREACHABLE) return;
                
                // *** STEP LIMIT - max hop distance (hour-scaled) ***
                if (distFromLast > stepLimit) return;
                
                // *** DIAMETER CHECK - max spread of route (hour-scaled) ***
                let violatesDiameter = false;
                for (const idx of driver.assignedIndices) {
                    if (matrix[idx][pkg.matrix_index] > maxDiameter) {
                        violatesDiameter = true;
                        break;
                    }
                }
                if (violatesDiameter) return;
                
                // Time check
                const addedDrive = distFromLast * TRAFFIC_CITY;
                const addedService = addPkgs * SECONDS_PER_PKG;
                const newTotalTime = driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService;
                if (newTotalTime > driver.timeBudget) return;
                
                // *** SCORING: Density-first ***
                let score = distFromLast;
                
                // SAME AREA BONUS (huge bonus for same ZIP)
                if (pkg.address === lastStop.address) {
                    score *= (1 - SAME_AREA_BONUS);
                }
                
                // PACKAGE COUNT BONUS (prefer locations with more packages)
                score *= (1 - Math.min(addPkgs * PKG_COUNT_BONUS, 0.5));
                
                if (score < bestScore) {
                    bestScore = score;
                    bestCandidate = { pkg, addedDrive, addedService };
                }
            });
            
            if (bestCandidate) {
                const { pkg, addedDrive, addedService } = bestCandidate;
                
                pkg.isAssigned = true;
                driver.route.push(pkg);
                driver.assignedIndices.add(pkg.matrix_index);
                driver.currentPackages += pkg.tbas.length;
                driver.currentDriveTime += addedDrive;
                driver.currentServiceTime += addedService;
            } else {
                growing = false;
            }
        }
    };
    
    // =====================================================
    // AUTO MODE: Fill one driver completely, then add next
    // Uses hour-based constraints for tighter 2h routes
    // =====================================================
    if (mode === 'auto') {
        const maxHours = driverList[0].maxHours;
        const constraints = getConstraints(maxHours);
        const maxStemTime = maxHours * 3600 * constraints.stemRatio;
        
        console.log(`[AUTO] ${maxHours}h drivers | diameter: ${Math.round(constraints.maxDiameter/60)}min | step: ${Math.round(constraints.stepLimit/60)}min | stem: ${Math.round(maxStemTime/60)}min`);
        
        const finalRoutes = [];
        let driverCount = 0;
        
        while (unassigned.filter(u => !u.isAssigned).length > 0) {
            driverCount++;
            
            // Create new driver
            const driver = {
                id: driverCount,
                maxHours: maxHours,
                timeBudget: maxHours * 3600,
                currentPackages: 0,
                currentDriveTime: 0,
                currentServiceTime: 0,
                route: [],
                assignedIndices: new Set()
            };
            
            // Find seed (closest dense area)
            const seed = findBestSeed(new Set(), maxStemTime, constraints.stepLimit);
            
            if (!seed) {
                console.log(`[AUTO] No valid seed for Driver ${driverCount}, stopping`);
                break;
            }
            
            // Assign seed
            const stemTime = matrix[0][seed.matrix_index] * TRAFFIC_HIGHWAY;
            const serviceTime = seed.tbas.length * SECONDS_PER_PKG;
            
            seed.isAssigned = true;
            driver.route.push(seed);
            driver.assignedIndices.add(seed.matrix_index);
            driver.currentPackages += seed.tbas.length;
            driver.currentDriveTime += stemTime;
            driver.currentServiceTime += serviceTime;
            
            console.log(`[AUTO] Driver ${driverCount} seeded: "${seed.address}" (${seed.tbas.length} pkgs) @ ${Math.round(stemTime/60)}min`);
            
            // Grow route until full (using hour-based constraints)
            growRoute(driver, constraints);
            
            // Finalize this driver's route
            if (driver.route.length > 0) {
                const routeWithWarehouse = [{ ...startPoint, matrix_index: 0, tbas: ['WAREHOUSE'] }, ...driver.route];
                const optimized = optimizeRouteWith2Opt([...routeWithWarehouse], matrix);
                
                let finalDrive = 0;
                for (let i = 0; i < optimized.length - 1; i++) {
                    const leg = matrix[optimized[i].matrix_index][optimized[i + 1].matrix_index];
                    finalDrive += (i === 0) ? leg * TRAFFIC_HIGHWAY : leg * TRAFFIC_CITY;
                }
                const finalService = driver.currentPackages * SECONDS_PER_PKG;
                const totalHours = (finalDrive + finalService) / 3600;
                
                console.log(`[AUTO] Driver ${driverCount} complete: ${driver.route.length} stops, ${driver.currentPackages} pkgs, ${totalHours.toFixed(2)}h`);
                
                finalRoutes.push({
                    route: optimized,
                    totalHours: totalHours,
                    driverId: driverCount,
                    driverMax: maxHours
                });
            }
            
            // Safety: prevent infinite loop
            if (driverCount > 50) {
                console.log(`[AUTO] Safety limit reached (50 drivers)`);
                break;
            }
        }
        
        // Overflow
        const overflow = unassigned.filter(u => !u.isAssigned);
        if (overflow.length > 0) {
            console.log(`[AUTO] OVERFLOW: ${overflow.length} packages`);
            finalRoutes.push({
                route: overflow,
                totalHours: 0,
                driverId: "OVERFLOW",
                driverMax: 0
            });
        }
        
        return finalRoutes;
    }
    
    // =====================================================
    // MANUAL MODE: Distribute proportionally with tight clusters
    // Focus on QUANTITY - deliver as many packages as possible
    // 2h drivers get tight/close routes, 4h drivers can spread more
    // =====================================================
    else {
        const totalHours = driverList.reduce((sum, d) => sum + d.maxHours, 0);
        
        // Initialize drivers with hour-based constraints
        const drivers = driverList.map(d => {
            const hourRatio = d.maxHours / totalHours;
            let budget = Math.ceil(totalPackages * hourRatio);
            budget = Math.min(budget, VAN_CAPACITY);
            budget = Math.max(budget, 5);
            
            // Get hour-based constraints
            const constraints = getConstraints(d.maxHours);
            const maxStemTime = d.maxHours * 3600 * constraints.stemRatio;
            
            console.log(`[MANUAL] Driver ${d.id}: ${d.maxHours}h -> ${budget} pkgs | diameter: ${Math.round(constraints.maxDiameter/60)}min | step: ${Math.round(constraints.stepLimit/60)}min | stem: ${Math.round(maxStemTime/60)}min`);
            
            return {
                id: d.id,
                maxHours: d.maxHours,
                timeBudget: d.maxHours * 3600,
                packageBudget: budget,
                maxStemTime: maxStemTime,
                maxDiameter: constraints.maxDiameter,
                stepLimit: constraints.stepLimit,
                currentPackages: 0,
                currentDriveTime: 0,
                currentServiceTime: 0,
                route: [],
                assignedIndices: new Set(),
                isFull: false
            };
        });
        
        // Sort by hours (longest first - they get seeded farther, 2h stays close)
        drivers.sort((a, b) => b.maxHours - a.maxHours);
        
        // Seed each driver in different dense areas
        const usedSeedAreas = new Set();
        drivers.forEach(driver => {
            const seed = findBestSeed(usedSeedAreas, driver.maxStemTime, driver.stepLimit);
            
            if (seed) {
                const stemTime = matrix[0][seed.matrix_index] * TRAFFIC_HIGHWAY;
                const serviceTime = seed.tbas.length * SECONDS_PER_PKG;
                
                seed.isAssigned = true;
                driver.route.push(seed);
                driver.assignedIndices.add(seed.matrix_index);
                driver.currentPackages += seed.tbas.length;
                driver.currentDriveTime += stemTime;
                driver.currentServiceTime += serviceTime;
                
                // Mark this area as used (exclude nearby stops from other seeds)
                unassigned.forEach(u => {
                    if (!u.isAssigned && matrix[seed.matrix_index][u.matrix_index] < driver.maxDiameter) {
                        usedSeedAreas.add(u.matrix_index);
                    }
                });
                
                console.log(`[MANUAL] Driver ${driver.id} seeded: "${seed.address}" (${seed.tbas.length} pkgs) @ ${Math.round(stemTime/60)}min`);
            }
        });
        
        // Parallel growth: each driver grows their cluster using their own constraints
        let iterations = 0;
        const maxIterations = totalPackages * 3;
        
        while (iterations < maxIterations) {
            iterations++;
            
            const remaining = unassigned.filter(u => !u.isAssigned);
            if (remaining.length === 0) break;
            
            let madeAssignment = false;
            
            // Each active driver tries to grab their best nearby package
            drivers.filter(d => !d.isFull && d.route.length > 0).forEach(driver => {
                if (driver.currentPackages >= driver.packageBudget) {
                    driver.isFull = true;
                    return;
                }
                
                const lastStop = driver.route[driver.route.length - 1];
                
                let bestCandidate = null;
                let bestScore = Infinity;
                
                remaining.filter(u => !u.isAssigned).forEach(pkg => {
                    const addPkgs = pkg.tbas.length;
                    
                    // Budget check (soft cap for manual)
                    if (driver.currentPackages + addPkgs > VAN_CAPACITY) return;
                    
                    const distFromLast = matrix[lastStop.matrix_index][pkg.matrix_index];
                    if (distFromLast >= UNREACHABLE) return;
                    
                    // Use driver's own step limit (hour-based)
                    if (distFromLast > driver.stepLimit) return;
                    
                    // Diameter check using driver's own limit (hour-based)
                    let violatesDiameter = false;
                    for (const idx of driver.assignedIndices) {
                        if (matrix[idx][pkg.matrix_index] > driver.maxDiameter) {
                            violatesDiameter = true;
                            break;
                        }
                    }
                    if (violatesDiameter) return;
                    
                    // Time check
                    const addedDrive = distFromLast * TRAFFIC_CITY;
                    const addedService = addPkgs * SECONDS_PER_PKG;
                    const newTime = driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService;
                    if (newTime > driver.timeBudget) return;
                    
                    // Scoring
                    let score = distFromLast;
                    
                    // Same area bonus
                    if (pkg.address === lastStop.address) {
                        score *= (1 - SAME_AREA_BONUS);
                    }
                    
                    // Package count bonus
                    score *= (1 - Math.min(addPkgs * PKG_COUNT_BONUS, 0.5));
                    
                    if (score < bestScore) {
                        bestScore = score;
                        bestCandidate = { pkg, addedDrive, addedService };
                    }
                });
                
                if (bestCandidate) {
                    const { pkg, addedDrive, addedService } = bestCandidate;
                    
                    pkg.isAssigned = true;
                    driver.route.push(pkg);
                    driver.assignedIndices.add(pkg.matrix_index);
                    driver.currentPackages += pkg.tbas.length;
                    driver.currentDriveTime += addedDrive;
                    driver.currentServiceTime += addedService;
                    madeAssignment = true;
                }
            });
            
            if (!madeAssignment) {
                // No driver could take any package - mark all as full
                drivers.forEach(d => d.isFull = true);
                break;
            }
        }
        
        // Finalize routes
        const finalRoutes = [];
        
        drivers.filter(d => d.route.length > 0).forEach(driver => {
            const routeWithWarehouse = [{ ...startPoint, matrix_index: 0, tbas: ['WAREHOUSE'] }, ...driver.route];
            const optimized = optimizeRouteWith2Opt([...routeWithWarehouse], matrix);
            
            let finalDrive = 0;
            for (let i = 0; i < optimized.length - 1; i++) {
                const leg = matrix[optimized[i].matrix_index][optimized[i + 1].matrix_index];
                finalDrive += (i === 0) ? leg * TRAFFIC_HIGHWAY : leg * TRAFFIC_CITY;
            }
            const finalService = driver.currentPackages * SECONDS_PER_PKG;
            const totalHours = (finalDrive + finalService) / 3600;
            
            console.log(`[MANUAL] Driver ${driver.id}: ${driver.route.length} stops, ${driver.currentPackages} pkgs, ${totalHours.toFixed(2)}h/${driver.maxHours}h`);
            
            finalRoutes.push({
                route: optimized,
                totalHours: totalHours,
                driverId: driver.id,
                driverMax: driver.maxHours
            });
        });
        
        // Overflow
        const overflow = unassigned.filter(u => !u.isAssigned);
        if (overflow.length > 0) {
            console.log(`[MANUAL] OVERFLOW: ${overflow.length} packages (need more drivers or looser constraints)`);
            finalRoutes.push({
                route: overflow,
                totalHours: 0,
                driverId: "OVERFLOW",
                driverMax: 0
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
        const { loosePackages = [], bags = [], drivers, mode } = req.body;

        console.log(`\n========== NEW REQUEST ==========`);
        console.log(`Mode: "${mode}" | Drivers: ${drivers ? drivers.length : 0}`);
        
        if (mode === 'manual' && drivers && drivers.length > 0) {
            drivers.forEach(d => console.log(`  - Driver ${d.id}: ${d.maxHours}h`));
        } else if (mode === 'auto' && drivers && drivers.length > 0) {
            console.log(`  - Auto with ${drivers[0].maxHours}h blocks`);
        }

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

        console.log(`Total stops: ${allStops.length} | Packages: ${allStops.reduce((s, x) => s + x.tbas.length, 0)}`);

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

        console.log(`\n========== COMPLETE: ${allRoutes.length} routes ==========\n`);
        res.json(allRoutes);

    } catch (error) { 
        console.error(error); 
        res.status(500).json({ error: error.message }); 
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));