const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Google Maps API key (replace with your own API key)
const googleMapsApiKey = '********';

// Starting location
const startingLocation = { lat: 40.10144209586004, lng: -75.30578283911566 };

// Function to geocode addresses
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
            geocoded.push({
                address: address,
                coordinates: response.data.results[0].geometry.location
            });
        }
    }
    return geocoded;
};

// Route to calculate and display routes
app.post('/calculate-routes', async (req, res) => {
    const { waypoints, numDrivers } = req.body;
    const geocodedWaypoints = await geocodeAddresses(waypoints);
    const routes = distributeWaypointsAmongDrivers(geocodedWaypoints, numDrivers);
    res.json(routes);
});

// Function to distribute waypoints among drivers
const distributeWaypointsAmongDrivers = (waypoints, numDrivers) => {
    // Cluster waypoints by unique locations
    const clusters = clusterWaypointsByLocation(waypoints);

    // Create driver routes
    const driverRoutes = Array.from({ length: numDrivers }, () => []);

    // Distribute clusters to drivers
    clusters.forEach(cluster => {
        let assigned = false;
        for (let i = 0; i < numDrivers; i++) {
            if (driverRoutes[i].length + cluster.length <= waypoints.length / numDrivers) {
                driverRoutes[i].push(...cluster);
                assigned = true;
                break;
            }
        }
        if (!assigned) {
            driverRoutes[numDrivers - 1].push(...cluster);
        }
    });

    // Add the starting location to the beginning of each route
    driverRoutes.forEach(route => {
        route.unshift({
            address: 'Starting Location',
            coordinates: startingLocation
        });
    });

    return driverRoutes;
};

// Function to cluster waypoints by unique locations
const clusterWaypointsByLocation = (waypoints) => {
    const clusters = {};
    waypoints.forEach(wp => {
        const key = `${wp.coordinates.lat}_${wp.coordinates.lng}`;
        if (!clusters[key]) {
            clusters[key] = [];
        }
        clusters[key].push(wp);
    });
    return Object.values(clusters);
};

// Serve index.html on the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
