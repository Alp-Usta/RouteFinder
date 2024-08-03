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
const googleMapsApiKey = "***"; // Replace with your actual API key

// Starting location
const startingLocation = { lat: 40.10144209586004, lng: -75.30578283911566 };

// Function to geocode addresses and get zip codes and state
const geocodeAddresses = async (addresses) => {
    const geocoded = await Promise.all(addresses.map(async (address) => {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: { address, key: googleMapsApiKey }
        });
        if (response.data.results.length > 0) {
            const result = response.data.results[0];
            const postalComponent = result.address_components.find(component => component.types.includes('postal_code'));
            const stateComponent = result.address_components.find(component => component.types.includes('administrative_area_level_1'));
            const cityComponent = result.address_components.find(component => component.types.includes('locality'));
            const zipCode = postalComponent ? postalComponent.long_name : 'Unknown';
            const state = stateComponent ? stateComponent.short_name : 'Unknown';
            const city = cityComponent ? cityComponent.long_name : 'Unknown';
            return {
                address,
                coordinates: result.geometry.location,
                zipCode,
                state,
                city
            };
        }
    }));
    return geocoded.filter(item => item);
};

// Function to calculate the distance between two coordinates using the Haversine formula
const calculateDistance = (coord1, coord2) => {
    const toRad = angle => angle * (Math.PI / 180);
    const R = 6371; // Radius of the Earth in kilometers
    const dLat = toRad(coord2.lat - coord1.lat);
    const dLng = toRad(coord2.lng - coord1.lng);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(coord1.lat)) * Math.cos(toRad(coord2.lat)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in kilometers
};

// Function to sort waypoints by proximity using a simple greedy approach
const sortWaypointsByProximity = (waypoints, startLocation) => {
    const sorted = [];
    let currentLocation = startLocation;
    const remainingWaypoints = [...waypoints];

    while (remainingWaypoints.length > 0) {
        let nearestIndex = 0;
        let nearestDistance = calculateDistance(currentLocation, remainingWaypoints[0].coordinates);

        for (let i = 1; i < remainingWaypoints.length; i++) {
            const distance = calculateDistance(currentLocation, remainingWaypoints[i].coordinates);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = i;
            }
        }

        const nearestWaypoint = remainingWaypoints.splice(nearestIndex, 1)[0];
        sorted.push(nearestWaypoint);
        currentLocation = nearestWaypoint.coordinates;
    }

    return sorted;
};

// Function to cluster and sort waypoints by state
const clusterWaypointsByState = (waypoints) => {
    const stateClusters = {};

    // Cluster by state
    waypoints.forEach(wp => {
        if (!stateClusters[wp.state]) {
            stateClusters[wp.state] = [];
        }
        stateClusters[wp.state].push(wp);
    });

    // Sort each state cluster by proximity
    Object.keys(stateClusters).forEach(state => {
        stateClusters[state] = sortWaypointsByProximity(stateClusters[state], startingLocation);
    });

    return stateClusters;
};

// Function to assign routes to drivers
const assignRoutesToDrivers = (clusters, numDrivers) => {
    const driverRoutes = Array.from({ length: numDrivers }, () => ({
        route: [{ address: 'Starting Location', coordinates: startingLocation }]
    }));

    let driverIndex = 0;
    let assignedDriverRoutes = 0;

    // Assign clusters to drivers, maintaining state order
    Object.values(clusters).forEach(stateCluster => {
        let subCluster = [];
        stateCluster.forEach((waypoint, index) => {
            subCluster.push(waypoint);
            // Assign when you have a sub-cluster of locations
            if (subCluster.length >= 2 || index === stateCluster.length - 1) {
                if (assignedDriverRoutes < numDrivers) {
                    driverRoutes[driverIndex].route.push(...subCluster);
                    driverIndex++;
                    assignedDriverRoutes++;
                    subCluster = [];
                }
            }
        });
    });

    return driverRoutes;
};

// Route to calculate and display routes
app.post('/calculate-routes', async (req, res) => {
    const { waypoints, numDrivers } = req.body;

    try {
        console.log('Received waypoints:', waypoints);
        console.log('Number of drivers:', numDrivers);

        const geocodedWaypoints = await geocodeAddresses(waypoints);
        console.log('Geocoded waypoints:', geocodedWaypoints);

        // Cluster and sort waypoints by state
        const clusters = clusterWaypointsByState(geocodedWaypoints);

        // Assign clusters to drivers
        const driverRoutes = assignRoutesToDrivers(clusters, numDrivers);

        // Prepare final routes
        const finalRoutes = driverRoutes.map((driverRoute, index) => ({
            driver: index + 1,
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
