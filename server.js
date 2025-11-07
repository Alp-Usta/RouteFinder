const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION ---
const googleMapsApiKey = 'YOUR_GOOGLE_MAPS_API_KEY'; // ⚠️ Paste your API key here
const startingLocation = { 
    address: 'Starting Location',
    coordinates: { lat: 40.10144209586004, lng: -75.30578283911566 }
};
const BATCH_SIZE = 10; // Google's limit

// --- HELPER FUNCTIONS ---

const geocodeAddresses = async (addresses) => {
    const geocoded = [];
    console.log(`Geocoding ${addresses.length} addresses...`);
    for (const address of addresses) {
        try {
            const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
                params: {
                    components: `postal_code:${address}|country:US`,
                    key: googleMapsApiKey
                }
            });
            if (response.data.results.length > 0) {
                const result = response.data.results[0];
                const stateComponent = result.address_components.find(c => c.types.includes('administrative_area_level_1'));
                const state = stateComponent ? stateComponent.short_name : 'Unknown';
                const geocodedResult = { address, coordinates: result.geometry.location, state };
                geocoded.push(geocodedResult);
            } else { console.warn(`Could not geocode address: ${address}`); }
        } catch (error) { console.error(`Error geocoding address ${address}:`, error.response ? error.response.data.error_message : error.message); }
    }
    return geocoded;
};

/**
 * Builds a matrix of driving times
 */
const getDistanceMatrix = async (points) => {
    const n = points.length;
    console.log(`Building new distance matrix for ${n} points...`);
    let matrix = Array(n).fill(null).map(() => Array(n).fill(0));

    
    try {
        for (let i = 0; i < n; i += BATCH_SIZE) {
            for (let j = 0; j < n; j += BATCH_SIZE) {
                const origins = points.slice(i, i + BATCH_SIZE).map(p => `${p.coordinates.lat},${p.coordinates.lng}`);
                const destinations = points.slice(j, j + BATCH_SIZE).map(p => `${p.coordinates.lat},${p.coordinates.lng}`);
                if (origins.length === 0 || destinations.length === 0) continue;

                const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
                    params: { 
                        origins: origins.join('|'), 
                        destinations: destinations.join('|'), 
                        key: googleMapsApiKey,
                        departure_time: Math.floor(Date.now() / 1000) + 3600
                    }
                });

                //Check for top-level API error
                if (response.data.status !== 'OK') {
                    throw new Error(`Distance Matrix API Error: ${response.data.error_message || response.data.status}`);
                }

                const { rows } = response.data;
                for (let oi = 0; oi < rows.length; oi++) {
                    const elements = rows[oi].elements;
                    for (let di = 0; di < elements.length; di++) {
                        if (elements[di].status === 'OK') {
                            matrix[i + oi][j + di] = elements[di].duration.value;
                        } else {
                            // If one element fails, still log it but don't stop the matrix
                            console.warn(`No route found for origin ${i+oi} to dest ${j+di}: ${elements[di].status}`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        //If any batch fails, log the error and re-throw it
        // This will be caught by the main app.post try/catch
        console.error(`Fatal Error in getDistanceMatrix:`, error.response ? error.response.data.error_message : error.message);
        // Re-throw the error to make the request fail
        throw new Error(`Failed to get distance matrix. Is the API key restricted or the API not enabled? Details: ${error.message}`);
    }
    
    console.log("Matrix built.");
    return matrix;
};

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
    // ... (no changes) ...
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
        route.unshift({ ...startPoint, matrix_index: 0 });
        const optimizedRoute = optimizeRouteWith2Opt([...route], matrix);
        let totalSeconds = 0;
        for (let i = 0; i < optimizedRoute.length - 1; i++) {
            totalSeconds += matrix[optimizedRoute[i].matrix_index][optimizedRoute[i+1].matrix_index];
        }
        return { route: optimizedRoute, totalHours: totalSeconds / 3600 };
    }).filter(Boolean);

    return finalRoutes;
};

// --- API ENDPOINT & SERVER STARTUP ---

app.post('/calculate-routes', async (req, res) => {

    try {
        if (!googleMapsApiKey || googleMapsApiKey === 'YOUR_GOOGLE_MAPS_API_KEY') {
            throw new Error("Server is missing Google Maps API key.");
        }
        const { waypoints, numDrivers } = req.body;
        const totalDrivers = parseInt(numDrivers, 10);
        
        if (!waypoints || !totalDrivers || waypoints.length === 0 || totalDrivers <= 0) {
            return res.status(400).json({ error: 'Invalid input.' });
        }

        const uniqueZips = [...new Set(waypoints.filter(wp => wp.trim() !== ''))];
        console.log(`Received ${waypoints.length} waypoints, ${uniqueZips.length} are unique.`);
        const geocodedZips = await geocodeAddresses(uniqueZips);
        
        if (geocodedZips.length === 0) {
            console.error("Geocoding failed for all addresses.");
            return res.json([]);
        }

        const stateBuckets = geocodedZips.reduce((acc, zip) => {
            (acc[zip.state] = acc[zip.state] || []).push(zip);
            return acc;
        }, {});
        console.log(`Found ${Object.keys(stateBuckets).length} states.`);

        const driverAllocations = {};
        let driversAllocated = 0;
        Object.keys(stateBuckets).forEach((state, index) => {
            const proportion = stateBuckets[state].length / geocodedZips.length;
            let driversForState = Math.round(totalDrivers * proportion);
            if (driversForState === 0 && stateBuckets[state].length > 0) driversForState = 1;
            if (index === Object.keys(stateBuckets).length - 1) {
                driversForState = totalDrivers - driversAllocated;
            }
            driverAllocations[state] = driversForState;
            driversAllocated += driversForState;
        });
        console.log("Driver allocations:", driverAllocations);

        let allRoutes = [];
        for (const state of Object.keys(stateBuckets)) {
            const zipsForState = stateBuckets[state];
            const driversForState = driverAllocations[state];
            if (driversForState === 0) continue;

            console.log(`Planning routes for ${state} with ${driversForState} drivers...`);
            
            const pointsForMatrix = [startingLocation, ...zipsForState];
            
            // This await will now throw an error if the matrix fails
            const timeMatrix = await getDistanceMatrix(pointsForMatrix);
            
    
            if (!timeMatrix) {
                throw new Error(`Failed to build matrix for ${state}.`);
            }

            const regionRoutes = planRoutesForRegion(zipsForState, driversForState, timeMatrix, startingLocation);
            allRoutes.push(...regionRoutes);
        }
        
        console.log(`Total routes planned: ${allRoutes.length}`);
        res.json(allRoutes);

    } catch (error) {
        console.error("--- ERROR IN /calculate-routes ---");
        console.error(error); // This will log the fatal error in IDE console
        console.error("-----------------------------------");
        res.status(500).json({ error: 'An internal server error occurred', details: error.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));