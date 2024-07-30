const express = require('express');
const axios = require('axios');
const path = require('path');
const WebSocket = require('ws');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Google Maps API key (replace with your own API key)
const googleMapsApiKey = '***';

// Starting location
const startingLocation = { lat: 40.10144209586004, lng: -75.30578283911566 };

// Function to geocode addresses and get zip codes and state
const geocodeAddresses = async (addresses) => {
    const geocoded = [];
    for (const address of addresses) {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                address: address,
                key: googleMapsApiKey
            }
        });
        if (response.data.results.length > 0) {
            const result = response.data.results[0];
            const postalComponent = result.address_components.find(component => component.types.includes('postal_code'));
            const stateComponent = result.address_components.find(component => component.types.includes('administrative_area_level_1'));
            const zipCode = postalComponent ? postalComponent.long_name : 'Unknown';
            const state = stateComponent ? stateComponent.short_name : 'Unknown';
            geocoded.push({
                address: address,
                coordinates: result.geometry.location,
                zipCode: zipCode,
                state: state
            });
        }
    }
    return geocoded;
};

const getDistanceMatrix = async (origins, destinations) => {
    const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
        params: {
            origins: origins.map(loc => `${loc.lat},${loc.lng}`).join('|'),
            destinations: destinations.map(loc => `${loc.lat},${loc.lng}`).join('|'),
            key: googleMapsApiKey
        }
    });

    if (response.data.status !== 'OK') {
        throw new Error('Error with the Distance Matrix API');
    }

    const distances = response.data.rows.map(row => row.elements.map(elem => elem.duration.value));
    return distances;
};

// Function to cluster waypoints by state, zip code, and proximity
const clusterAndSortWaypoints = (waypoints) => {
    const clusters = {};

    // Step 1: Cluster by state and zip code
    waypoints.forEach(wp => {
        if (!clusters[wp.state]) {
            clusters[wp.state] = {};
        }
        if (!clusters[wp.state][wp.zipCode]) {
            clusters[wp.state][wp.zipCode] = [];
        }
        clusters[wp.state][wp.zipCode].push(wp);
    });

    // Step 2: Sort each zip code cluster by coordinates (latitude and longitude)
    Object.values(clusters).forEach(stateCluster => {
        Object.values(stateCluster).forEach(zipCluster => {
            zipCluster.sort((a, b) => {
                if (a.coordinates.lat === b.coordinates.lat) {
                    return a.coordinates.lng - b.coordinates.lng;
                }
                return a.coordinates.lat - b.coordinates.lat;
            });
        });
    });

    return clusters;
};

// Route to calculate and display routes
app.post('/calculate-routes', async (req, res) => {
    const { waypoints, numDrivers, hourLimit } = req.body;

    try {
        console.log('Received waypoints:', waypoints);
        console.log('Number of drivers:', numDrivers);
        console.log('Hour limit per driver:', hourLimit);

        const geocodedWaypoints = await geocodeAddresses(waypoints);
        console.log('Geocoded waypoints:', geocodedWaypoints);

        const allLocations = [startingLocation, ...geocodedWaypoints.map(wp => wp.coordinates)];
        const distanceMatrix = await getDistanceMatrix(allLocations, allLocations);

        console.log('Distance Matrix:', JSON.stringify(distanceMatrix, null, 2));

        const driverRoutes = Array.from({ length: numDrivers }, () => ({
            route: [{ address: 'Starting Location', coordinates: startingLocation }],
            currentRouteTime: 0
        }));
        const maxTravelTime = hourLimit * 3600; // Max travel time in seconds

        // Cluster and sort waypoints by state, zip code, and coordinates
        const clusters = clusterAndSortWaypoints(geocodedWaypoints);

        // Distribute sorted clusters among drivers in a round-robin fashion
        let driverIndex = 0;
        Object.values(clusters).forEach(stateCluster => {
            Object.values(stateCluster).forEach(zipCluster => {
                zipCluster.forEach(waypoint => {
                    const driverRoute = driverRoutes[driverIndex];
                    const lastLocationIndex = allLocations.indexOf(driverRoute.route[driverRoute.route.length - 1].coordinates);
                    const travelTimeFromLastLocation = distanceMatrix[lastLocationIndex][allLocations.indexOf(waypoint.coordinates)];

                    if (driverRoute.currentRouteTime + travelTimeFromLastLocation <= maxTravelTime) {
                        driverRoute.route.push(waypoint);
                        driverRoute.currentRouteTime += travelTimeFromLastLocation;
                    } else {
                        console.log(`Skipping waypoint due to exceeding travel time for all drivers: ${waypoint.address}`);
                    }
                });
                driverIndex = (driverIndex + 1) % numDrivers;
            });
        });

        // Prepare final routes by removing the currentRouteTime property
        const finalRoutes = driverRoutes.map(driverRoute => ({
            route: driverRoute.route.map(location => ({
                address: location.address,
                coordinates: location.coordinates
            }))
        }));

        console.log('Final routes:', JSON.stringify(finalRoutes, null, 2));
        res.json(finalRoutes);
    } catch (error) {
        console.error('Error calculating routes:', error);
        res.status(500).json({ error: 'Failed to calculate routes' });
    }
});

// Serve index.html on the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', (message) => {
        console.log('Received:', message);
        // Broadcast the received message to all connected clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});
