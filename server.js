const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = 3000;


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION ---
const startingLocation = { 
    address: 'Starting Location', // DPH9 Warehouse
    coordinates: { lat: 40.10144209586004, lng: -75.30578283911566 }
};

// --- HELPER FUNCTIONS ---

// Geocode function that only recieves unique zips 
const geocodeAddresses = async (addresses) => {
    const geocoded = [];
    console.log(`Geocoding ${addresses.length} addresses with Nominatim...`);
    
    for (const address of addresses) {
        try {
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 req/sec API limitation
            
            const response = await axios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    postalcode: address,
                    country: 'US',
                    format: 'json',
                    'accept-language': 'en',
                    addressdetails: 1 
                },
                headers: {
                    'User-Agent': 'RouteFinder/1.0 (Contact: your-email@example.com)'
                }
            });

            if (response.data.length > 0) {
                const result = response.data[0];
                const state = result.address.state ? result.address.state.substring(0, 2) : 'Unknown';
                
                const geocodedResult = { 
                    address: address, // This is the zip code
                    coordinates: { 
                        lat: parseFloat(result.lat), 
                        lng: parseFloat(result.lon) 
                    }, 
                    state: state.toUpperCase()
                };
                geocoded.push(geocodedResult);
            } else { 
                console.warn(`Could not geocode address: ${address}`); 
            }
        } catch (error) { 
            console.error(`Error geocoding address ${address}:`, error.message); 
        }
    }
    return geocoded;
};

// Matrix function
const getDistanceMatrix = async (points) => {
    const n = points.length;
    console.log(`Manually building matrix for ${n} points (this will take time)...`);
    
    let matrix = Array(n).fill(null).map(() => Array(n).fill(0));

    try {
        for (let i = 0; i < n; i++) { // From point i
            for (let j = 0; j < n; j++) { // To point j
                if (i === j) {
                    matrix[i][j] = 0; 
                    continue;
                }

                const origin = points[i].coordinates;
                const destination = points[j].coordinates;

                const p1 = `${origin.lat},${origin.lng}`;
                const p2 = `${destination.lat},${destination.lng}`;
                const profile = "car";
                
                const url = `http://localhost:8989/route?point=${p1}&point=${p2}&profile=${profile}&calc_points=false&points_encoded=false`;

                const response = await axios.get(url);

                if (response.data && response.data.paths && response.data.paths.length > 0) {
                    const timeInSeconds = response.data.paths[0].time / 1000;
                    matrix[i][j] = Math.round(timeInSeconds);
                } else {
                    console.warn(`No route found from point ${i} to ${j}.`);
                    matrix[i][j] = Infinity; 
                }
            }
            if (i % 10 === 0) {
                 console.log(`Matrix progress: ${i} / ${n} rows complete...`);
            }
        }

    } catch (error) {
        console.error(`Fatal Error in getDistanceMatrix:`, error.message);
        if (error.code === 'ECONNREFUSED') {
            throw new Error('Failed to connect to GraphHopper. Is it running on http://localhost:8989?');
        }
        throw new Error(`Failed to get route from GraphHopper. Details: ${error.message}`);
    }
    
    console.log("Matrix built.");
    return matrix;
};

// K-means and 2-Opt functions
const getSquaredDistance = (p1, p2) => Math.pow(p1.lat - p2.lat, 2) + Math.pow(p1.lng - p2.lng, 2);

const initializeCentroidsKMeansPlusPlus = (waypoints, k) => {
    const centroids = [];
    if (waypoints.length === 0 || k <= 0) return centroids;
    if (waypoints.length < k) {
        waypoints.forEach(wp => centroids.push(wp));
        return centroids;
    }
    centroids.push(waypoints[Math.floor(Math.random() * waypoints.length)]);
    for (let i = 1; i < k; i++) {
        const distances = waypoints.map(wp => {
            let minDistance = Infinity;
            centroids.forEach(centroid => {
                const dist = getSquaredDistance(wp.coordinates, centroid.coordinates);
                if (dist < minDistance) minDistance = dist;
            });
            return minDistance;
        });
        const totalDistance = distances.reduce((sum, d) => sum + d, 0);
        const randomValue = Math.random() * totalDistance;
        let cumulativeDistance = 0;
        for (let j = 0; j < waypoints.length; j++) {
            cumulativeDistance += distances[j];
            if (cumulativeDistance >= randomValue) {
                centroids.push(waypoints[j]);
                break;
            }
        }
    }
    return centroids;
};

const optimizeRouteWith2Opt = (route, matrix) => {
    if (route.length < 4) return route;
    let improved = true;
    while (improved) {
        improved = false;
        for (let i = 1; i < route.length - 2; i++) {
            for (let j = i + 1; j < route.length - 1; j++) {
                const p1_idx = route[i-1].matrix_index;
                const p2_idx = route[i].matrix_index;
                const p3_idx = route[j].matrix_index;
                const p4_idx = route[j+1].matrix_index;
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


const planRoutesForRegion = (regionalZips, numDrivers, matrix, startPoint) => {
 
    if (regionalZips.length === 0 || numDrivers === 0) return [];
    
    regionalZips.forEach((wp, i) => { wp.matrix_index = i + 1; });

    let centroids = initializeCentroidsKMeansPlusPlus(regionalZips, numDrivers);
    
    let assignments = [];
    for (let iter = 0; iter < 50; iter++) {
        assignments = Array.from({ length: numDrivers }, () => []);
        regionalZips.forEach(wp => {
            let closestDist = Infinity, closestCentroidIndex = 0;
            centroids.forEach((centroid, index) => {
                if (!centroid) return;
                const dist = matrix[wp.matrix_index][centroid.matrix_index];
                if (dist < closestDist) { closestDist = dist; closestCentroidIndex = index; }
            });
            assignments[closestCentroidIndex].push(wp);
        });
        
        let moved = false;
        for (let i = 0; i < numDrivers; i++) {
            const cluster = assignments[i];
            if (cluster.length > 0) {
                const newCentroid = cluster[Math.floor(cluster.length / 2)];
                if (!centroids[i] || newCentroid.matrix_index !== centroids[i].matrix_index) {
                    centroids[i] = newCentroid;
                    moved = true;
                }
            } else {
                centroids[i] = null;
            }
        }
        if (!moved) break;
    }

    const finalRoutes = assignments.map(route => {
        if (route.length === 0) return null;
        route.unshift({ ...startPoint, matrix_index: 0, tbas: ['WAREHOUSE'] });
        const optimizedRoute = optimizeRouteWith2Opt([...route], matrix);
        
        let totalSeconds = 0;
        let totalPackages = 0; // <-- New variable

        // 1. Add up all the driving time
        for (let i = 0; i < optimizedRoute.length - 1; i++) {
            totalSeconds += matrix[optimizedRoute[i].matrix_index][optimizedRoute[i+1].matrix_index];
        }

        // 2. Add up all the packages (skip index 0, the warehouse)
        for (let i = 1; i < optimizedRoute.length; i++) {
            totalPackages += optimizedRoute[i].tbas.length;
        }

        // 3. Add the buffer (e.g., 300 seconds * total packages)
        totalSeconds += (totalPackages * 300); 

        return { route: optimizedRoute, totalHours: totalSeconds / 3600 };
    }).filter(Boolean);

    return finalRoutes;
};

// --- API ENDPOINT & SERVER STARTUP ---

app.post('/calculate-routes', async (req, res) => {

    try {
        // 1. Get packages [{postal, tba}, ...] and driver count
        const { packages, numDrivers } = req.body;
        const totalDrivers = parseInt(numDrivers, 10);
        
        if (!packages || !totalDrivers || packages.length === 0 || totalDrivers <= 0) {
            return res.status(400).json({ error: 'Invalid input.' });
        }

        // 2. Create a map of { zip: [tba1, tba2, ...] }
        const zipToTbaMap = packages.reduce((acc, pkg) => {
            const zip = pkg.postal;
            const tba = pkg.tba;
            if (zip && tba) {
                if (!acc[zip]) {
                    acc[zip] = [];
                }
                acc[zip].push(tba);
            }
            return acc;
        }, {});

        // 3. Get all unique zip codes to geocode
        const uniqueZips = Object.keys(zipToTbaMap);
        console.log(`Received ${packages.length} packages, ${uniqueZips.length} are unique zips.`);
        
        // 4. Geocode ONLY the unique zips (this is fast)
        const geocodedZips = await geocodeAddresses(uniqueZips);
        
        if (geocodedZips.length === 0) {
            console.error("Geocoding failed for all addresses.");
            return res.json([]);
        }

        // 5. CRITICAL: Map TBAs back to the geocoded zips
        // array of objects that contain all info
        const geocodedPackages = geocodedZips.map(zipInfo => ({
            ...zipInfo, // has address (zip), coordinates, state
            tbas: zipToTbaMap[zipInfo.address] // has tbas: [tba1, tba2]
        }));

        // 6. Bucket by state 
        const stateBuckets = geocodedPackages.reduce((acc, pkg) => {
            (acc[pkg.state] = acc[pkg.state] || []).push(pkg);
            return acc;
        }, {});
        console.log(`Found ${Object.keys(stateBuckets).length} states.`);

        // 7. Allocate drivers 
        const driverAllocations = {};
        let driversAllocated = 0;
        Object.keys(stateBuckets).forEach((state, index) => {
            const proportion = stateBuckets[state].length / geocodedPackages.length;
            let driversForState = Math.round(totalDrivers * proportion);
            if (driversForState === 0 && stateBuckets[state].length > 0) driversForState = 1;
            if (index === Object.keys(stateBuckets).length - 1) {
                driversForState = totalDrivers - driversAllocated;
            }
            driverAllocations[state] = driversForState;
            driversAllocated += driversForState;
        });
        console.log("Driver allocations:", driverAllocations);

        // 8. Plan routes 
        let allRoutes = [];
        for (const state of Object.keys(stateBuckets)) {
            const packagesForState = stateBuckets[state];
            const driversForState = driverAllocations[state];
            if (driversForState === 0) continue;

            console.log(`Planning routes for ${state} with ${driversForState} drivers...`);
            
            // Points list
            const pointsForMatrix = [startingLocation, ...packagesForState];
            
            const timeMatrix = await getDistanceMatrix(pointsForMatrix);
            
            if (!timeMatrix) {
                throw new Error(`Failed to build matrix for ${state}.`);
            }

            const regionRoutes = planRoutesForRegion(packagesForState, driversForState, timeMatrix, startingLocation);
            allRoutes.push(...regionRoutes);
        }
        
        console.log(`Total routes planned: ${allRoutes.length}`);
        // 9. Send the full route data (with TBAs) back to the client
        res.json(allRoutes);

    } catch (error) {
        console.error("--- ERROR IN /calculate-routes ---");
        console.error(error); 
        console.error("-----------------------------------");
        res.status(500).json({ error: 'An internal server error occurred', details: error.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));