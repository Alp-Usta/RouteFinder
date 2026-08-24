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

// --- helpers ---

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

// Returns drive times in seconds. Also fills distMatrix (metres) as a side
// output, since GraphHopper hands back both on the same call and mileage would
// otherwise cost a second full pass over the grid.
const getDistanceMatrix = async (points, distOut = null) => {
    const n = points.length;
    const UNREACHABLE = 99999;
    let matrix = Array(n).fill(null).map(() => Array(n).fill(0));
    if (distOut) {
        distOut.length = 0;
        for (let i = 0; i < n; i++) distOut.push(Array(n).fill(0));
    }
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
                    if (response.data.paths) {
                        matrix[i][j] = Math.round(response.data.paths[0].time / 1000);
                        if (distOut) distOut[i][j] = Math.round(response.data.paths[0].distance || 0);
                    } else {
                        matrix[i][j] = UNREACHABLE;
                        if (distOut) distOut[i][j] = UNREACHABLE;
                        failedRoutes++;
                    }
                } catch (e) {
                    matrix[i][j] = UNREACHABLE;
                    if (distOut) distOut[i][j] = UNREACHABLE;
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

// 2-opt. Skips any swap touching an UNREACHABLE edge, otherwise the 99999
// sentinel gets treated as a real distance and the result is garbage.
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

// Breaks up any ZIP too big for one driver, by count or by volume.
// Bags are left alone. Splitting a bag is never allowed.
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

        // Fill a chunk until either limit trips, then start a fresh one
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

// ---- TUNABLES ----
// These are the defaults. The constraint editor in the UI can override any of
// them for a single request: applyConfig() swaps the live values in before
// planning, resetConfig() puts them back after. Without the reset, one
// person's tweak would silently affect everyone's next run.
const DEFAULTS = Object.freeze({
    COST_PER_MILE: 0.67,
    MPG_SEDAN: 32,
    MPG_SUV: 24,
    MPG_TRUCK: 17,
    FUEL_PRICE_PER_GAL: 3.45,
    REMOTE_ISOLATION_SECONDS: 900,
    REMOTE_STEM_SECONDS: 2700,
    FAIR_SHARE_SLACK: 1.35,
    ORPHAN_MAX_ATTACH: 900,
    SEED_PACKAGE_WEIGHT: 600,
    SEED_NEARBY_WEIGHT: 300,
    SEED_STEM_WEIGHT: 0.25,
    SEED_SPREAD_WEIGHT: 0.35,
    RELAX_DIAMETER_STEP: 300,
    RELAX_STEP_STEP: 150,
    SIZE_LARGE_MAX: 120,
    SIZE_MEDIUM_MAX: 50,
    SIZE_SMALL_MAX: 15,
    FLAT_VOLUME_FACTOR: 0.25,
    FLAT_MAX_VOLUME_L: 6,
    FLAT_MAX_MIN_DIM_CM: 6,
    VAN_CAPACITY: 48,
    SECONDS_PER_PKG: 180,
    TRAFFIC_HIGHWAY: 1.0,
    TRAFFIC_CITY: 1.1,
    PACKING_EFFICIENCY: 0.68,
    BASE_STEM_SECONDS: 1800,
    STEM_PER_HOUR: 900,
    BASE_MAX_DIAMETER: 600,
    DIAMETER_PER_HOUR: 180,
    BASE_STEP_LIMIT: 360,
    STEP_PER_HOUR: 90,
    SAME_AREA_BONUS: 0.75,
    NEAR_AREA_SECONDS: 180,
    NEAR_AREA_BONUS: 0.40,
    PKG_COUNT_BONUS: 0.20,
    DIAMETER_GROWTH_PENALTY: 2.0,
    ABSOLUTE_MAX_STEP: 900,
    SANITY_MAX_DIAMETER: 2400,
    MAX_LOCAL_DRIVE_SHARE: 0.55,
    TIE_TOLERANCE_SECONDS: 180,
});

// What the UI needs to draw each control: name, unit, safe range, plain-English
// description. Keep this in sync when you add a tunable above.
const CONFIG_SCHEMA = [
    { key: 'VAN_CAPACITY',          label: 'Max packages per driver', unit: 'pkgs', min: 5,  max: 120, step: 1,
      help: 'Hard ceiling on how many packages one driver can carry.' },
    { key: 'SECONDS_PER_PKG',       label: 'Time per delivery',       unit: 'sec',  min: 30, max: 600, step: 10,
      help: 'Service time charged for each package at a stop.' },
    { key: 'MAX_LOCAL_DRIVE_SHARE', label: 'Max driving share',       unit: 'x',    min: 0.2, max: 0.95, step: 0.05,
      help: 'Cap on driving between stops as a fraction of the block after the drive out. Lower means more delivering, less driving.' },
    { key: 'ABSOLUTE_MAX_STEP',     label: 'Max gap between stops',   unit: 'sec',  min: 180, max: 2400, step: 60,
      help: 'Longest allowed drive between two consecutive stops. The main anti-sprawl control.' },
    { key: 'SEED_PACKAGE_WEIGHT',   label: 'Seed: pull per package',  unit: '',     min: 0,  max: 2000, step: 50,
      help: 'How strongly a busy area attracts the first stop of a route. Raise it to start drivers where the packages are, even if that means driving further out.' },
    { key: 'SEED_NEARBY_WEIGHT',    label: 'Seed: pull per nearby package', unit: '', min: 0, max: 1000, step: 25,
      help: 'Counts packages in neighbouring stops when choosing where to start a driver. A ZIP with one package but five next door is a six-package area.' },
    { key: 'SEED_SPREAD_WEIGHT',    label: 'Seed: spread between drivers', unit: 'x', min: 0, max: 2, step: 0.05,
      help: 'Pushes each new driver away from the ones already seeded. Too high and an empty far ZIP wins just for being far away.' },
    { key: 'SEED_STEM_WEIGHT',      label: 'Seed: cost of driving out', unit: 'x',  min: 0,  max: 3, step: 0.05,
      help: 'How much the drive from the warehouse counts against a starting area. Keep it low, you only pay that drive once.' },
    { key: 'ORPHAN_MAX_ATTACH',     label: 'Max orphan pickup distance', unit: 'sec', min: 120, max: 2400, step: 60,
      help: 'How far a leftover stop may sit from the route that picks it up. Follows the max gap above unless you set it yourself.' },
    { key: 'SANITY_MAX_DIAMETER',   label: 'Absolute route width limit', unit: 'sec', min: 300, max: 5400, step: 120,
      help: 'Backstop on total route width. Nothing should reach this in normal use; it exists to catch a route running away.' },
    { key: 'COST_PER_MILE',         label: 'Cost per mile', unit: '$', min: 0, max: 3, step: 0.01,
      help: 'All-in running cost per mile: fuel, wear, depreciation. The IRS business rate is a reasonable starting point.' },
    { key: 'FUEL_PRICE_PER_GAL',    label: 'Fuel price per gallon', unit: '$', min: 1, max: 10, step: 0.05,
      help: 'Used with the figures below to estimate fuel separately from total running cost.' },
    { key: 'MPG_SEDAN',             label: 'Sedan MPG', unit: 'mpg', min: 5, max: 80, step: 1,
      help: 'Real-world mileage, not the sticker number.' },
    { key: 'MPG_SUV',               label: 'SUV MPG', unit: 'mpg', min: 5, max: 80, step: 1,
      help: 'Real-world mileage for the SUV tier.' },
    { key: 'MPG_TRUCK',             label: 'Truck MPG', unit: 'mpg', min: 5, max: 80, step: 1,
      help: 'Real-world mileage for the truck tier.' },
    { key: 'REMOTE_ISOLATION_SECONDS', label: 'Isolated stop threshold', unit: 'sec', min: 300, max: 3600, step: 60,
      help: 'A stop with no other stop within this drive gets flagged as isolated before planning.' },
    { key: 'REMOTE_STEM_SECONDS',   label: 'Far-from-base threshold', unit: 'sec', min: 600, max: 7200, step: 300,
      help: 'A stop further than this from the warehouse gets flagged, even if it has neighbours.' },
    { key: 'FAIR_SHARE_SLACK',      label: 'Fair-share headroom', unit: 'x', min: 1, max: 3, step: 0.05,
      help: 'How far a driver may go past an even split before they stop bidding. 1.0 forces a strict even split; higher lets clustering look more natural.' },
    { key: 'TIE_TOLERANCE_SECONDS', label: 'Tie tolerance',           unit: 'sec',  min: 0,  max: 900, step: 30,
      help: 'Drivers within this distance of each other count as equally close, so the least loaded one takes the stop.' },
    { key: 'BASE_STEM_SECONDS',     label: 'Drive-out: starting value', unit: 'sec', min: 300, max: 7200, step: 300,
      help: 'How far the shortest block (2h) may travel from the warehouse to its first stop. Longer blocks add the value below on top.' },
    { key: 'STEM_PER_HOUR',         label: 'Drive-out: added per hour above 2h', unit: 'sec', min: 0,  max: 3600, step: 150,
      help: 'Added for every hour past 2. At the defaults a 4h driver gets 30 + 15 + 15 = 60 min.' },
    { key: 'BASE_MAX_DIAMETER',     label: 'Route width: starting value', unit: 'sec',  min: 180, max: 3600, step: 60,
      help: 'How wide a 2h route may be end to end. Longer blocks add the value below on top.' },
    { key: 'DIAMETER_PER_HOUR',     label: 'Route width: added per hour above 2h', unit: 'sec', min: 0, max: 900, step: 30,
      help: 'Added for every hour past 2. At the defaults a 4h route may be 16 min wide before relaxation.' },
    { key: 'BASE_STEP_LIMIT',       label: 'Step limit: starting value', unit: 'sec',  min: 120, max: 1800, step: 30,
      help: 'Preferred gap between consecutive stops for a 2h driver, before relaxation.' },
    { key: 'STEP_PER_HOUR',         label: 'Step limit: added per hour above 2h', unit: 'sec', min: 0, max: 600, step: 30,
      help: 'Added for every hour past 2. Never exceeds the hard max gap set above.' },
    { key: 'RELAX_DIAMETER_STEP',   label: 'Relaxation: width added per retry', unit: 'sec', min: 0, max: 1200, step: 60,
      help: 'When the solver cannot find a nearby stop it retries with more slack. This is how much width each retry adds. Zero disables widening.' },
    { key: 'RELAX_STEP_STEP',       label: 'Relaxation: gap added per retry', unit: 'sec', min: 0, max: 600, step: 30,
      help: 'How much extra gap between stops each retry allows. Still capped by the hard max gap.' },
    { key: 'FLAT_MAX_MIN_DIM_CM',   label: 'Envelope thickness limit', unit: 'cm', min: 1, max: 30, step: 1,
      help: 'A package this thin or thinner counts as a flat mailer.' },
    { key: 'FLAT_MAX_VOLUME_L',     label: 'Envelope volume limit', unit: 'L', min: 1, max: 40, step: 1,
      help: 'A flat also has to be no bigger than this to qualify.' },
    { key: 'FLAT_VOLUME_FACTOR',    label: 'Envelope space charge', unit: 'x', min: 0.05, max: 1, step: 0.05,
      help: 'Fraction of its real volume a flat is charged, since mailers squeeze into gaps between boxes.' },
    { key: 'SIZE_SMALL_MAX',        label: 'Small package limit', unit: 'L', min: 1, max: 60, step: 1,
      help: 'Upper volume bound for the small category.' },
    { key: 'SIZE_MEDIUM_MAX',       label: 'Medium package limit', unit: 'L', min: 5, max: 150, step: 5,
      help: 'Upper volume bound for medium.' },
    { key: 'SIZE_LARGE_MAX',        label: 'Large package limit', unit: 'L', min: 20, max: 400, step: 10,
      help: 'Above this a package counts as oversize.' },
    { key: 'SAME_AREA_BONUS',       label: 'Same ZIP pull',           unit: 'x',    min: 0,  max: 0.95, step: 0.05,
      help: 'How strongly the solver prefers another stop in the same ZIP.' },
    { key: 'NEAR_AREA_SECONDS',     label: 'What counts as nearby', unit: 'sec', min: 30, max: 900, step: 30,
      help: 'A stop within this drive of the last one gets the nearby bonus below. Sets how big "the same area" is.' },
    { key: 'NEAR_AREA_BONUS',       label: 'Nearby ZIP pull',         unit: 'x',    min: 0,  max: 0.95, step: 0.05,
      help: 'Preference for a stop in an adjacent area.' },
    { key: 'PKG_COUNT_BONUS',       label: 'Busy stop bonus',         unit: 'x',    min: 0,  max: 0.5, step: 0.05,
      help: 'Preference for stops holding more packages.' },
    { key: 'DIAMETER_GROWTH_PENALTY', label: 'Route-widening penalty', unit: 'x',   min: 0,  max: 8, step: 0.5,
      help: 'Cost charged when a stop widens the overall route. Higher keeps routes tighter.' },
    { key: 'TRAFFIC_CITY',          label: 'City traffic multiplier', unit: 'x',    min: 1,  max: 2, step: 0.05,
      help: 'Multiplier on drive time between stops.' },
    { key: 'TRAFFIC_HIGHWAY',       label: 'Highway traffic multiplier', unit: 'x', min: 1,  max: 2, step: 0.05,
      help: 'Multiplier on the drive out from the warehouse.' },
    { key: 'PACKING_EFFICIENCY',    label: 'Packing efficiency',      unit: 'x',    min: 0.3, max: 1, step: 0.02,
      help: 'How much of a vehicle\'s cargo space real boxes actually fill.' },
];

// --- CONSTANTS ---
let VAN_CAPACITY = DEFAULTS.VAN_CAPACITY;
let SECONDS_PER_PKG = DEFAULTS.SECONDS_PER_PKG;      // 3 min per package
const UNREACHABLE = 99999;
let TRAFFIC_HIGHWAY = DEFAULTS.TRAFFIC_HIGHWAY;
let TRAFFIC_CITY = DEFAULTS.TRAFFIC_CITY;

// ---- VEHICLE CAPACITY ----
// Zone volumes are raw space. Manufacturer trunk figures assume you're pouring
// liquid in; real boxes leave gaps, which is what PACKING_EFFICIENCY accounts for.
//
// maxDimCm is separate and matters just as much: a 142cm package is only 29L,
// so the volume math says a sedan can take it. It still won't go through the
// trunk opening. Check both.
let PACKING_EFFICIENCY = DEFAULTS.PACKING_EFFICIENCY;   // boxes waste ~32% of any space

// Editable, because the right numbers depend on what cars the station actually runs.
const VEHICLE_DEFAULTS = Object.freeze({
    SEDAN: { trunk: 425,  rearSeat: 280, frontPassenger: 95, maxDimCm: 120 },
    SUV:   { trunk: 1000, rearSeat: 350, frontPassenger: 95, maxDimCm: 180 },
    TRUCK: { trunk: 3000, rearSeat: 400, frontPassenger: 95, maxDimCm: 250 }
});

const VEHICLE_TIERS = [
    { id: 'SEDAN', label: 'Sedan',             color: '#4ecdc4',
      zones: { ...VEHICLE_DEFAULTS.SEDAN }, maxDimCm: VEHICLE_DEFAULTS.SEDAN.maxDimCm },
    { id: 'SUV',   label: 'SUV',               color: '#fca311',
      zones: { ...VEHICLE_DEFAULTS.SUV },   maxDimCm: VEHICLE_DEFAULTS.SUV.maxDimCm },
    { id: 'TRUCK', label: 'Truck / Cargo Van', color: '#f032e6',
      zones: { ...VEHICLE_DEFAULTS.TRUCK }, maxDimCm: VEHICLE_DEFAULTS.TRUCK.maxDimCm }
];

// Built from the tiers above so the editor can't drift out of sync with them
const VEHICLE_SCHEMA = [];
VEHICLE_TIERS.forEach(t => {
    const d = VEHICLE_DEFAULTS[t.id];
    VEHICLE_SCHEMA.push(
        { key: `veh.${t.id}.trunk`, label: `${t.label} — trunk`, unit: 'L', min: 50, max: 5000, step: 25,
          def: d.trunk, help: 'Raw trunk or cargo-bay volume before packing loss.' },
        { key: `veh.${t.id}.rearSeat`, label: `${t.label} — rear seat`, unit: 'L', min: 0, max: 2000, step: 25,
          def: d.rearSeat, help: 'Usable space on the back seat.' },
        { key: `veh.${t.id}.frontPassenger`, label: `${t.label} — front seat`, unit: 'L', min: 0, max: 500, step: 5,
          def: d.frontPassenger, help: 'Usable space on the front passenger seat.' },
        { key: `veh.${t.id}.maxDimCm`, label: `${t.label} — longest item`, unit: 'cm', min: 40, max: 400, step: 5,
          def: d.maxDimCm, help: 'Longest single package the loading opening accepts. Independent of volume.' }
    );
});

// Raw zone volume minus what packing wastes
const tierUsableVolume = (tier) => {
    const gross = tier.zones.trunk + tier.zones.rearSeat + tier.zones.frontPassenger;
    return Math.round(gross * PACKING_EFFICIENCY);
};

let TIER_BY_ID = {};
const rebuildTiers = () => {
    TIER_BY_ID = {};
    VEHICLE_TIERS.forEach(t => {
        TIER_BY_ID[t.id] = { ...t, usableL: tierUsableVolume(t) };
    });
};
rebuildTiers();

// Takes overrides from the constraint editor. Ignores anything not in DEFAULTS,
// anything that isn't a number, and clamps the rest to the schema range.
// Never trust these values, they come straight off the wire.
const applyConfig = (overrides) => {
    const applied = {};
    if (!overrides || typeof overrides !== 'object') return applied;

    const limits = {};
    CONFIG_SCHEMA.forEach(s => { limits[s.key] = s; });

    Object.keys(overrides).forEach(key => {
        if (!(key in DEFAULTS)) return;
        const lim = limits[key];
        // Toggles come through as booleans, everything else as numbers
        if (lim && lim.type === 'bool') {
            applied[key] = !!overrides[key];
            return;
        }
        const raw = Number(overrides[key]);
        if (!isFinite(raw)) return;
        const val = lim ? Math.min(lim.max, Math.max(lim.min, raw)) : raw;
        applied[key] = val;
    });

    if ('VAN_CAPACITY' in applied) VAN_CAPACITY = applied.VAN_CAPACITY;
    if ('SECONDS_PER_PKG' in applied) SECONDS_PER_PKG = applied.SECONDS_PER_PKG;
    if ('TRAFFIC_HIGHWAY' in applied) TRAFFIC_HIGHWAY = applied.TRAFFIC_HIGHWAY;
    if ('TRAFFIC_CITY' in applied) TRAFFIC_CITY = applied.TRAFFIC_CITY;
    if ('PACKING_EFFICIENCY' in applied) PACKING_EFFICIENCY = applied.PACKING_EFFICIENCY;
    if ('BASE_STEM_SECONDS' in applied) BASE_STEM_SECONDS = applied.BASE_STEM_SECONDS;
    if ('STEM_PER_HOUR' in applied) STEM_PER_HOUR = applied.STEM_PER_HOUR;
    if ('BASE_MAX_DIAMETER' in applied) BASE_MAX_DIAMETER = applied.BASE_MAX_DIAMETER;
    if ('DIAMETER_PER_HOUR' in applied) DIAMETER_PER_HOUR = applied.DIAMETER_PER_HOUR;
    if ('BASE_STEP_LIMIT' in applied) BASE_STEP_LIMIT = applied.BASE_STEP_LIMIT;
    if ('STEP_PER_HOUR' in applied) STEP_PER_HOUR = applied.STEP_PER_HOUR;
    if ('SAME_AREA_BONUS' in applied) SAME_AREA_BONUS = applied.SAME_AREA_BONUS;
    if ('NEAR_AREA_SECONDS' in applied) NEAR_AREA_SECONDS = applied.NEAR_AREA_SECONDS;
    if ('NEAR_AREA_BONUS' in applied) NEAR_AREA_BONUS = applied.NEAR_AREA_BONUS;
    if ('PKG_COUNT_BONUS' in applied) PKG_COUNT_BONUS = applied.PKG_COUNT_BONUS;
    if ('DIAMETER_GROWTH_PENALTY' in applied) DIAMETER_GROWTH_PENALTY = applied.DIAMETER_GROWTH_PENALTY;
    if ('ABSOLUTE_MAX_STEP' in applied) {
        ABSOLUTE_MAX_STEP = applied.ABSOLUTE_MAX_STEP;
        // Keep orphan rescue in step with the gap limit unless it was set on
        // its own, otherwise orphans quietly reintroduce the sprawl you just
        // tightened away.
        if (!('ORPHAN_MAX_ATTACH' in applied)) ORPHAN_MAX_ATTACH = ABSOLUTE_MAX_STEP;
    }
    if ('ORPHAN_MAX_ATTACH' in applied) ORPHAN_MAX_ATTACH = applied.ORPHAN_MAX_ATTACH;
    if ('SANITY_MAX_DIAMETER' in applied) SANITY_MAX_DIAMETER = applied.SANITY_MAX_DIAMETER;
    if ('MAX_LOCAL_DRIVE_SHARE' in applied) MAX_LOCAL_DRIVE_SHARE = applied.MAX_LOCAL_DRIVE_SHARE;
    if ('TIE_TOLERANCE_SECONDS' in applied) TIE_TOLERANCE_SECONDS = applied.TIE_TOLERANCE_SECONDS;
    if ('COST_PER_MILE' in applied) COST_PER_MILE = applied.COST_PER_MILE;
    if ('MPG_SEDAN' in applied) MPG_SEDAN = applied.MPG_SEDAN;
    if ('MPG_SUV' in applied) MPG_SUV = applied.MPG_SUV;
    if ('MPG_TRUCK' in applied) MPG_TRUCK = applied.MPG_TRUCK;
    if ('FUEL_PRICE_PER_GAL' in applied) FUEL_PRICE_PER_GAL = applied.FUEL_PRICE_PER_GAL;
    if ('REMOTE_ISOLATION_SECONDS' in applied) REMOTE_ISOLATION_SECONDS = applied.REMOTE_ISOLATION_SECONDS;
    if ('REMOTE_STEM_SECONDS' in applied) REMOTE_STEM_SECONDS = applied.REMOTE_STEM_SECONDS;
    if ('FAIR_SHARE_SLACK' in applied) FAIR_SHARE_SLACK = applied.FAIR_SHARE_SLACK;
    if ('SEED_PACKAGE_WEIGHT' in applied) SEED_PACKAGE_WEIGHT = applied.SEED_PACKAGE_WEIGHT;
    if ('SEED_NEARBY_WEIGHT' in applied) SEED_NEARBY_WEIGHT = applied.SEED_NEARBY_WEIGHT;
    if ('SEED_STEM_WEIGHT' in applied) SEED_STEM_WEIGHT = applied.SEED_STEM_WEIGHT;
    if ('SEED_SPREAD_WEIGHT' in applied) SEED_SPREAD_WEIGHT = applied.SEED_SPREAD_WEIGHT;

    if ('FLAT_MAX_MIN_DIM_CM' in applied) FLAT_MAX_MIN_DIM_CM = applied.FLAT_MAX_MIN_DIM_CM;
    if ('FLAT_MAX_VOLUME_L' in applied) FLAT_MAX_VOLUME_L = applied.FLAT_MAX_VOLUME_L;
    if ('FLAT_VOLUME_FACTOR' in applied) FLAT_VOLUME_FACTOR = applied.FLAT_VOLUME_FACTOR;
    if ('SIZE_SMALL_MAX' in applied) SIZE_SMALL_MAX = applied.SIZE_SMALL_MAX;
    if ('SIZE_MEDIUM_MAX' in applied) SIZE_MEDIUM_MAX = applied.SIZE_MEDIUM_MAX;
    if ('SIZE_LARGE_MAX' in applied) SIZE_LARGE_MAX = applied.SIZE_LARGE_MAX;

    let relaxChanged = false;
    if ('RELAX_DIAMETER_STEP' in applied) { RELAX_DIAMETER_STEP = applied.RELAX_DIAMETER_STEP; relaxChanged = true; }
    if ('RELAX_STEP_STEP' in applied) { RELAX_STEP_STEP = applied.RELAX_STEP_STEP; relaxChanged = true; }
    if (relaxChanged) rebuildRelaxation();

    // Vehicle keys look like "veh.SEDAN.trunk", handled separately from the scalars
    const vehLimits = {};
    VEHICLE_SCHEMA.forEach(s => { vehLimits[s.key] = s; });
    let vehChanged = false;
    Object.keys(overrides).forEach(key => {
        if (!key.startsWith('veh.')) return;
        const lim = vehLimits[key];
        if (!lim) return;
        const raw = Number(overrides[key]);
        if (!isFinite(raw)) return;
        const val = Math.min(lim.max, Math.max(lim.min, raw));
        const [, tierId, field] = key.split('.');
        const tier = VEHICLE_TIERS.find(t => t.id === tierId);
        if (!tier) return;
        if (field === 'maxDimCm') tier.maxDimCm = val;
        else tier.zones[field] = val;
        applied[key] = val;
        vehChanged = true;
    });

    if ('PACKING_EFFICIENCY' in applied || vehChanged) rebuildTiers();
    return applied;
};

const resetConfig = () => {
    VAN_CAPACITY = DEFAULTS.VAN_CAPACITY;
    SECONDS_PER_PKG = DEFAULTS.SECONDS_PER_PKG;
    TRAFFIC_HIGHWAY = DEFAULTS.TRAFFIC_HIGHWAY;
    TRAFFIC_CITY = DEFAULTS.TRAFFIC_CITY;
    PACKING_EFFICIENCY = DEFAULTS.PACKING_EFFICIENCY;
    BASE_STEM_SECONDS = DEFAULTS.BASE_STEM_SECONDS;
    STEM_PER_HOUR = DEFAULTS.STEM_PER_HOUR;
    BASE_MAX_DIAMETER = DEFAULTS.BASE_MAX_DIAMETER;
    DIAMETER_PER_HOUR = DEFAULTS.DIAMETER_PER_HOUR;
    BASE_STEP_LIMIT = DEFAULTS.BASE_STEP_LIMIT;
    STEP_PER_HOUR = DEFAULTS.STEP_PER_HOUR;
    SAME_AREA_BONUS = DEFAULTS.SAME_AREA_BONUS;
    NEAR_AREA_SECONDS = DEFAULTS.NEAR_AREA_SECONDS;
    NEAR_AREA_BONUS = DEFAULTS.NEAR_AREA_BONUS;
    PKG_COUNT_BONUS = DEFAULTS.PKG_COUNT_BONUS;
    DIAMETER_GROWTH_PENALTY = DEFAULTS.DIAMETER_GROWTH_PENALTY;
    ABSOLUTE_MAX_STEP = DEFAULTS.ABSOLUTE_MAX_STEP;
    ORPHAN_MAX_ATTACH = DEFAULTS.ORPHAN_MAX_ATTACH;
    SANITY_MAX_DIAMETER = DEFAULTS.SANITY_MAX_DIAMETER;
    MAX_LOCAL_DRIVE_SHARE = DEFAULTS.MAX_LOCAL_DRIVE_SHARE;
    TIE_TOLERANCE_SECONDS = DEFAULTS.TIE_TOLERANCE_SECONDS;
    COST_PER_MILE = DEFAULTS.COST_PER_MILE;
    MPG_SEDAN = DEFAULTS.MPG_SEDAN;
    MPG_SUV = DEFAULTS.MPG_SUV;
    MPG_TRUCK = DEFAULTS.MPG_TRUCK;
    FUEL_PRICE_PER_GAL = DEFAULTS.FUEL_PRICE_PER_GAL;
    REMOTE_ISOLATION_SECONDS = DEFAULTS.REMOTE_ISOLATION_SECONDS;
    REMOTE_STEM_SECONDS = DEFAULTS.REMOTE_STEM_SECONDS;
    FAIR_SHARE_SLACK = DEFAULTS.FAIR_SHARE_SLACK;
    SEED_PACKAGE_WEIGHT = DEFAULTS.SEED_PACKAGE_WEIGHT;
    SEED_NEARBY_WEIGHT = DEFAULTS.SEED_NEARBY_WEIGHT;
    SEED_STEM_WEIGHT = DEFAULTS.SEED_STEM_WEIGHT;
    SEED_SPREAD_WEIGHT = DEFAULTS.SEED_SPREAD_WEIGHT;
    FLAT_MAX_MIN_DIM_CM = DEFAULTS.FLAT_MAX_MIN_DIM_CM;
    FLAT_MAX_VOLUME_L = DEFAULTS.FLAT_MAX_VOLUME_L;
    FLAT_VOLUME_FACTOR = DEFAULTS.FLAT_VOLUME_FACTOR;
    SIZE_SMALL_MAX = DEFAULTS.SIZE_SMALL_MAX;
    SIZE_MEDIUM_MAX = DEFAULTS.SIZE_MEDIUM_MAX;
    SIZE_LARGE_MAX = DEFAULTS.SIZE_LARGE_MAX;
    RELAX_DIAMETER_STEP = DEFAULTS.RELAX_DIAMETER_STEP;
    RELAX_STEP_STEP = DEFAULTS.RELAX_STEP_STEP;
    rebuildRelaxation();

    VEHICLE_TIERS.forEach(t => {
        const d = VEHICLE_DEFAULTS[t.id];
        t.zones.trunk = d.trunk;
        t.zones.rearSeat = d.rearSeat;
        t.zones.frontPassenger = d.frontPassenger;
        t.maxDimCm = d.maxDimCm;
    });
    rebuildTiers();
};

const LARGEST_TIER = 'TRUCK';

// Envelopes squash into the gaps between boxes, so charging them their full
// cubic would badly overstate how much room they take.
let FLAT_MAX_MIN_DIM_CM = DEFAULTS.FLAT_MAX_MIN_DIM_CM;     // thickness at or under this = flat
let FLAT_MAX_VOLUME_L   = DEFAULTS.FLAT_MAX_VOLUME_L;     // and no bigger than this
let FLAT_VOLUME_FACTOR  = DEFAULTS.FLAT_VOLUME_FACTOR;  // charged at 25% of cubic

// Size buckets, by full cubic volume in litres
let SIZE_SMALL_MAX  = DEFAULTS.SIZE_SMALL_MAX;
let SIZE_MEDIUM_MAX = DEFAULTS.SIZE_MEDIUM_MAX;
let SIZE_LARGE_MAX  = DEFAULTS.SIZE_LARGE_MAX;

// How much space one package actually eats. Dims in cm, answer in litres.
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

// Smallest vehicle that can take this load. null means nothing in the fleet can.
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

// --- Tuned against the Collegeville PA warehouse ---
let BASE_STEM_SECONDS = DEFAULTS.BASE_STEM_SECONDS;    // 30 min stem for 2h driver
let STEM_PER_HOUR = DEFAULTS.STEM_PER_HOUR;         // +15 min per extra hour over 2h

// These used to scale much harder per hour. Combined with the old multiplying
// relaxation, a 4h driver ended up allowed roughly 6x what a 2h driver got,
// which is exactly why 2h routes looked fine and 4h ones sprawled.
let BASE_MAX_DIAMETER = DEFAULTS.BASE_MAX_DIAMETER;     // 10 min diameter for 2h driver
let DIAMETER_PER_HOUR = DEFAULTS.DIAMETER_PER_HOUR;     // +3 min per extra hour (was 5)

let BASE_STEP_LIMIT = DEFAULTS.BASE_STEP_LIMIT;       // 6 min step for 2h driver
let STEP_PER_HOUR = DEFAULTS.STEP_PER_HOUR;          // +1.5 min per extra hour (was 3)

let SAME_AREA_BONUS = DEFAULTS.SAME_AREA_BONUS;      // Very strong pull for the same ZIP
let NEAR_AREA_SECONDS = DEFAULTS.NEAR_AREA_SECONDS;     // stops within 3 min count as "same area"
let NEAR_AREA_BONUS = DEFAULTS.NEAR_AREA_BONUS;      // strong pull for an adjacent ZIP
let PKG_COUNT_BONUS = DEFAULTS.PKG_COUNT_BONUS;      // 20% bonus per package
let DIAMETER_GROWTH_PENALTY = DEFAULTS.DIAMETER_GROWTH_PENALTY; // cost per second a stop widens the route

// Relaxation tiers: progressively widen diameter/step when tight
// constraints can't find candidates. Time budget is always the hard ceiling.
// Relaxation adds a fixed amount per tier instead of multiplying. Multiplying
// compounded with the per-hour scaling above and blew up long blocks.
// Tier N gets N steps of slack. Change the step size and the ladder rebuilds.
let RELAX_DIAMETER_STEP = DEFAULTS.RELAX_DIAMETER_STEP;
let RELAX_STEP_STEP = DEFAULTS.RELAX_STEP_STEP;
const RELAXATION_TIER_COUNT = 4;
let RELAXATION_DIAMETER_ADD = [];
let RELAXATION_STEP_ADD = [];
let RELAXATION_TIERS = [];

const rebuildRelaxation = () => {
    RELAXATION_DIAMETER_ADD = [];
    RELAXATION_STEP_ADD = [];
    for (let i = 0; i < RELAXATION_TIER_COUNT; i++) {
        RELAXATION_DIAMETER_ADD.push(i * RELAX_DIAMETER_STEP);
        RELAXATION_STEP_ADD.push(i * RELAX_STEP_STEP);
    }
    RELAXATION_TIERS = RELAXATION_DIAMETER_ADD;
};

// =====================================================
// ABSOLUTE GEOGRAPHIC CEILINGS
//
// Compactness beats throughput. A relaxation tier may widen a route up to
// these values and no further, no matter how many stops are still waiting.
// Without them, tier 3 tripled a 4h driver's diameter from 20 to 60 minutes
// and produced routes that spanned two counties.
//
// An unassigned package is a better outcome than a driver spending the block
// driving between distant stops instead of delivering.
// =====================================================
// One hard geographic ceiling. A gap this big between consecutive stops is
// sprawl whatever the clock says. Route width is handled by drive share below.
let ABSOLUTE_MAX_STEP = DEFAULTS.ABSOLUTE_MAX_STEP;        // 15 min between consecutive stops
let SANITY_MAX_DIAMETER = DEFAULTS.SANITY_MAX_DIAMETER;     // 40 min end-to-end, backstop only
// How far an orphan may sit from the route it gets bolted onto.
//
// This was a hardcoded 900 while the max-gap slider moved independently, so
// tightening the gap changed the auction but not orphan rescue. You'd end up
// with a route that broke your own limit and a safety warning explaining it.
// Tracks the max gap now unless it's overridden on its own.
let ORPHAN_MAX_ATTACH = DEFAULTS.ORPHAN_MAX_ATTACH;

// ---- DRIVE SHARE ----
// This is what actually fixed the long blocks. The time budget on its own
// stopped constraining anything when packages were spread thin: few packages
// means little service time, so a 4h budget would happily allow 3h of driving.
//
// The drive out to the first stop doesn't count here. You pay it once, and a
// long run to a tight cluster is a perfectly good route. What's capped is the
// driving between stops, which you pay all day.
let MAX_LOCAL_DRIVE_SHARE = DEFAULTS.MAX_LOCAL_DRIVE_SHARE;   // local driving <= 55% of post-stem time

// ---- SEED SCORING ----
// Seeds are picked on how much work is sitting there, not how close it is.
// A cluster of six 40 minutes out is a better start than one package round the
// corner, because the drive out is paid once and delivering is the whole job.
let COST_PER_MILE = DEFAULTS.COST_PER_MILE;
let MPG_SEDAN = DEFAULTS.MPG_SEDAN;
let MPG_SUV = DEFAULTS.MPG_SUV;
let MPG_TRUCK = DEFAULTS.MPG_TRUCK;
let FUEL_PRICE_PER_GAL = DEFAULTS.FUEL_PRICE_PER_GAL;
let REMOTE_ISOLATION_SECONDS = DEFAULTS.REMOTE_ISOLATION_SECONDS;  // nothing within this = isolated
let REMOTE_STEM_SECONDS = DEFAULTS.REMOTE_STEM_SECONDS;   // further than this from base = far out
let FAIR_SHARE_SLACK    = DEFAULTS.FAIR_SHARE_SLACK;      // headroom over an even split
let SEED_PACKAGE_WEIGHT = DEFAULTS.SEED_PACKAGE_WEIGHT;   // per package at the seed
let SEED_NEARBY_WEIGHT  = DEFAULTS.SEED_NEARBY_WEIGHT;    // per package near it
let SEED_STEM_WEIGHT    = DEFAULTS.SEED_STEM_WEIGHT;      // per second of drive out
let SEED_SPREAD_WEIGHT  = DEFAULTS.SEED_SPREAD_WEIGHT;    // per second from other seeds

// Inside this gap two drivers count as equally close and the emptier one wins.
// Outside it, distance decides and balance doesn't get a vote.
let TIE_TOLERANCE_SECONDS = DEFAULTS.TIE_TOLERANCE_SECONDS;    // 3 min

rebuildRelaxation();

const getConstraints = (hours, tier = 0) => {
    const extraHours = Math.max(0, hours - 2);
    const t = Math.max(0, Math.min(tier, RELAXATION_DIAMETER_ADD.length - 1));
    return {
        maxStemTime: BASE_STEM_SECONDS + (extraHours * STEM_PER_HOUR),
        maxDiameter: BASE_MAX_DIAMETER + (extraHours * DIAMETER_PER_HOUR) + RELAXATION_DIAMETER_ADD[t],
        stepLimit:   Math.min(ABSOLUTE_MAX_STEP,
                       BASE_STEP_LIMIT + (extraHours * STEP_PER_HOUR) + RELAXATION_STEP_ADD[t])
    };
};

// Would this driver still be mostly delivering after taking on addedDrive?
const withinDriveShare = (driver, addedDrive) => {
    const stem = driver.stemTime || 0;
    const available = driver.timeBudget - stem;
    if (available <= 0) return false;
    const localDrive = Math.max(0, driver.currentDriveTime - stem) + addedDrive;
    return localDrive <= available * MAX_LOCAL_DRIVE_SHARE;
};

// Scores a candidate stop. Lower is better.
//
// Distance from the last stop isn't enough on its own. A stop can sit right
// next to where the driver already is and still stretch the route's overall
// span, and span is what eats the block. So growth gets penalised too.
const compactnessScore = (driver, pkg, distFromLast, matrix) => {
    let currentMax = 0, newMax = 0;
    for (const idx of driver.assignedIndices) {
        for (const other of driver.assignedIndices) {
            if (idx === other) continue;
            const d = matrix[idx][other];
            if (d < UNREACHABLE && d > currentMax) currentMax = d;
        }
        const d = matrix[idx][pkg.matrix_index];
        if (d < UNREACHABLE && d > newMax) newMax = d;
    }
    const growth = Math.max(0, Math.max(newMax, currentMax) - currentMax);

    let score = distFromLast + (growth * DIAMETER_GROWTH_PENALTY);

    // Same ZIP is the ideal: no new ground covered at all
    const lastStop = driver.route[driver.route.length - 1];
    if (pkg.address === lastStop.address) score *= (1 - SAME_AREA_BONUS);
    else if (distFromLast <= NEAR_AREA_SECONDS) score *= (1 - NEAR_AREA_BONUS);

    score *= (1 - Math.min(pkg.tbas.length * PKG_COUNT_BONUS, 0.5));
    return score;
};

// Widest gap between any two stops. This is the compactness number.
const routeDiameter = (route, matrix) => {
    let max = 0;
    for (let i = 0; i < route.length; i++) {
        for (let j = i + 1; j < route.length; j++) {
            const d = matrix[route[i].matrix_index][route[j].matrix_index];
            if (d < UNREACHABLE && d > max) max = d;
        }
    }
    return max;
};

// ---- TERRITORIAL ROUTING ----
// Every package goes to whichever driver's route is already closest to it.
// That's what stops routes crossing over each other.
//
// Relaxation tiers apply in both auto and manual. The time budget is always
// the hard ceiling. Orphans go to the closest route, never to whoever's free.

// Closest this package gets to anything already on the driver's route
const minDistToRoute = (pkgIdx, route, matrix) => {
    let minD = UNREACHABLE;
    for (const stop of route) {
        const d = matrix[stop.matrix_index][pkgIdx];
        if (d < minD) minD = d;
    }
    return minD;
};

// Wrap up a route: prepend the warehouse, run 2-opt, work out the numbers
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

    // Running ETA per stop, seconds since leaving the warehouse
    let elapsed = 0;
    optimized.forEach((stop, i) => {
        if (i > 0) {
            const leg = matrix[optimized[i - 1].matrix_index][stop.matrix_index];
            if (leg < UNREACHABLE) elapsed += (i === 1) ? leg * TRAFFIC_HIGHWAY : leg * TRAFFIC_CITY;
        }
        stop.etaSeconds = Math.round(elapsed);
        if (i > 0) elapsed += (stop.tbas ? stop.tbas.length : 0) * SECONDS_PER_PKG;
    });

    const diameterSec = routeDiameter(driver.route, matrix);
    const metrics = computeMetrics(optimized, matrix);
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
        diameterMin: Math.round(diameterSec / 60),
        metrics,
        requiredVehicle: requiredVehicle || 'UNFITTABLE',
        assignedVehicle: driver.vehicle || null,
        vehicleUsagePct: driver.vehicle && TIER_BY_ID[driver.vehicle]
            ? Math.round((totalVolumeL / TIER_BY_ID[driver.vehicle].usableL) * 100)
            : null
    };
};

// Recalculate a driver's totals from their route. Pass optimize=true after a
// merge or a swap, when the stop order is likely to have gone messy.
const recalcDriverTime = (driver, matrix, optimize = false) => {
    if (optimize && driver.route.length >= 3) {
        // 2-opt needs the warehouse in place to order things properly
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
        driver.stemTime = matrix[0][driver.route[0].matrix_index] * TRAFFIC_HIGHWAY;
        driveTime += driver.stemTime;
    } else {
        driver.stemTime = 0;
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

// Can this driver physically take this stop?
//
// enforceShare caps them at their fair slice of the total cubic, which stops
// the first bidder swallowing the manifest while everyone else sits empty.
// Pass false on the second pass, when the only thing that matters is real limits.
const fitsVehicle = (driver, stop, enforceShare = true) => {
    if (driver.currentPackages + stop.tbas.length > VAN_CAPACITY) return false;
    const cap = tierCapacity(driver.vehicle || LARGEST_TIER);
    if ((stop.maxDimCm || 0) > cap.maxDimCm) return false;

    const ceiling = (enforceShare && driver.volumeBudget)
        ? Math.min(cap.usableL, driver.volumeBudget)
        : cap.usableL;
    if ((driver.currentVolume || 0) + (stop.volumeL || 0) > ceiling) return false;
    return true;
};

// Add a stop and update the running totals
const applyStop = (driver, stop, addedDrive, addedService) => {
    driver.route.push(stop);
    driver.assignedIndices.add(stop.matrix_index);
    driver.currentPackages += stop.tbas.length;
    driver.currentVolume = +((driver.currentVolume || 0) + (stop.volumeL || 0)).toFixed(2);
    driver.currentMaxDim = Math.max(driver.currentMaxDim || 0, stop.maxDimCm || 0);
    driver.currentDriveTime += addedDrive;
    driver.currentServiceTime += addedService;
};

// ---- MERGE ----
// Building routes one at a time sometimes leaves two sitting on top of each
// other. If the combined load fits one driver, merge them.
const mergeCloseRoutes = (driverObjects, matrix, maxHours) => {
    const timeBudget = maxHours * 3600;
    const constraints = getConstraints(maxHours);
    // Don't merge routes that aren't genuinely near each other
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
                
                // Average distance between every pair of stops across both routes
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
                
                // Rough check before doing the expensive part
                const combinedService = combinedPkgs * SECONDS_PER_PKG;
                const stemI = driverObjects[i].currentDriveTime;
                const stemJ = driverObjects[j].currentDriveTime;
                const roughDrive = Math.max(stemI, stemJ) + avgDist;
                
                // 0.85x because 2-opt will claw back a good chunk of this
                if ((roughDrive * 0.85) + combinedService > timeBudget) continue;
                
                if (avgDist < bestAvgDist) {
                    bestAvgDist = avgDist;
                    bestMerge = j;
                }
            }
            
            if (bestMerge !== null) {
                // Keep the old routes in case the merge turns out not to fit
                const savedRouteI = [...driverObjects[i].route];
                const savedRouteJ = [...driverObjects[bestMerge].route];
                
                // Merge j into i
                driverObjects[i].route.push(...driverObjects[bestMerge].route);
                driverObjects[bestMerge].route = [];
                driverObjects[bestMerge].currentPackages = 0;
                // Run 2-opt on merged route to fix ordering, then recalc time
                recalcDriverTime(driverObjects[i], matrix, true);
                recalcDriverTime(driverObjects[bestMerge], matrix);
                
                // Now check the real number, not the estimate
                const totalTime = driverObjects[i].currentDriveTime + driverObjects[i].currentServiceTime;
                if (totalTime > timeBudget) {
                    // Undo: restore both routes
                    console.log(`[MERGE] Undo: ${Math.round(totalTime/60)}min > ${Math.round(timeBudget/60)}min budget`);
                    driverObjects[i].route = savedRouteI;
                    driverObjects[bestMerge].route = savedRouteJ;
                    recalcDriverTime(driverObjects[i], matrix);
                    recalcDriverTime(driverObjects[bestMerge], matrix);
                    // Don't set merged=true, skip this pair
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

// ---- SWAP ----
// Walk every stop and check whether some other driver's route is closer to it.
// Only moves if it fits on capacity and time AND cuts total distance.
// Keeps going until a pass makes no changes.
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
                    
                    // Compactness guard: never move a stop into a route it
                    // would stretch beyond the absolute diameter ceiling.
                    let stretches = false;
                    for (const other of tgtDriver.route) {
                        const dd = matrix[stop.matrix_index][other.matrix_index];
                        if (dd >= UNREACHABLE || dd > SANITY_MAX_DIAMETER) { stretches = true; break; }
                    }
                    if (stretches) continue;

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

// ---- METRICS ----
// What this app decides is assignment: which stops go together and who takes
// them. Sequencing happens in the Flex app on the driver's phone, so we don't
// claim credit for it. Routes still get 2-opt'd here, otherwise the drive
// times, ETAs and constraint checks would all be wrong.
const routeDriveTime = (orderedStops, matrix) => {
    let drive = 0;
    let prev = 0;
    orderedStops.forEach((stop, i) => {
        const leg = matrix[prev][stop.matrix_index];
        if (leg < UNREACHABLE) drive += (i === 0) ? leg * TRAFFIC_HIGHWAY : leg * TRAFFIC_CITY;
        prev = stop.matrix_index;
    });
    return drive;
};

// Road distance for a finished route, using the distance matrix rather than
// straight lines, so mileage matches what the driver's odometer will show.
// Road distance for a route: warehouse out to the first stop, then stop to
// stop. Ends at the last delivery, same as the block does.
const routeDistanceMeters = (orderedStops, distMatrix) => {
    if (!distMatrix) return 0;
    let total = 0;
    let prev = 0;
    orderedStops.forEach(stop => {
        const leg = distMatrix[prev][stop.matrix_index];
        if (leg < UNREACHABLE) total += leg;
        prev = stop.matrix_index;
    });
    return total;
};

// Drive time for one finished route. Summed for the fleet total.
const computeMetrics = (finalStops, matrix) => {
    const real = finalStops.filter(s => !s.isWarehouse);
    if (real.length === 0) return { optimizedDriveSec: 0 };
    return { optimizedDriveSec: Math.round(routeDriveTime(real, matrix)) };
};

// What you'd get with no software: manifest top to bottom, dealt into equal
// piles. Each pile gets 2-opt'd like a real route would, since the Flex app
// sequences it either way. That takes ordering out of the comparison and
// leaves only the part this app is responsible for.
//
// Worth knowing: manifests usually arrive ZIP-sorted, and ZIPs are roughly
// geographic, so these piles come out better than you'd expect. The gap shows
// up in the constraint violations, not the drive time.
const naivePlanDriveTime = (allStops, driverList, matrix) => {
    const stops = allStops.filter(s => !s.isWarehouse);
    const driverCount = driverList.length;
    if (stops.length === 0 || driverCount < 1) {
        return { driveSec: 0, chunks: 0, violations: 0, breakdown: {} };
    }

    const ordered = [...stops].sort((a, b) => a.matrix_index - b.matrix_index);
    const perDriver = Math.ceil(ordered.length / driverCount);

    let total = 0, chunks = 0, violations = 0;
    const breakdown = { overTime: 0, overVolume: 0, overPackages: 0, itemTooLong: 0, longLeg: 0 };

    for (let i = 0; i < ordered.length; i += perDriver) {
        const chunk = ordered.slice(i, i + perDriver);
        if (chunk.length === 0) continue;
        const driver = driverList[chunks] || driverList[driverList.length - 1];
        chunks++;

        const withWh = [{ matrix_index: 0, tbas: ['_WH_'] }, ...chunk];
        const seq = chunk.length >= 3
            ? optimizeRouteWith2Opt([...withWh], matrix).filter(s => s.tbas[0] !== '_WH_')
            : chunk;

        const drive = routeDriveTime(seq, matrix);
        total += drive;

        // Could you actually send this pile out? The split ignores every
        // constraint, and this is where that shows.
        const pkgs = chunk.reduce((a, s) => a + s.tbas.length, 0);
        const vol = chunk.reduce((a, s) => a + (s.volumeL || 0), 0);
        const maxDim = chunk.reduce((m, s) => Math.max(m, s.maxDimCm || 0), 0);
        const cap = tierCapacity(driver.vehicle || LARGEST_TIER);
        const hours = (drive + pkgs * SECONDS_PER_PKG) / 3600;

        if (hours > driver.maxHours) { breakdown.overTime++; violations++; }
        if (vol > cap.usableL) { breakdown.overVolume++; violations++; }
        if (pkgs > VAN_CAPACITY) { breakdown.overPackages++; violations++; }
        if (maxDim > cap.maxDimCm) { breakdown.itemTooLong++; violations++; }

        let worstLeg = 0;
        for (let k = 1; k < seq.length; k++) {
            const leg = matrix[seq[k - 1].matrix_index][seq[k].matrix_index];
            if (leg < UNREACHABLE && leg > worstLeg) worstLeg = leg;
        }
        if (worstLeg > ABSOLUTE_MAX_STEP) { breakdown.longLeg++; violations++; }
    }
    return { driveSec: Math.round(total), chunks, violations, breakdown };
};

// ---- SAFETY CHECKS ----
// Planning won't break these rules on its own. A manual package move will.
// Every route gets checked on the way out so problems turn up before dispatch
// rather than in a parking lot.
const validateRoute = (result, matrix) => {
    const issues = [];
    if (result.isOverflow) return issues;

    const stops = result.route.filter(s => !s.isWarehouse);
    if (stops.length === 0) return issues;

    const vehicle = result.assignedVehicle || LARGEST_TIER;
    const cap = tierCapacity(vehicle);
    const label = TIER_BY_ID[vehicle] ? TIER_BY_ID[vehicle].label : vehicle;
    const packages = stops.reduce((a, s) => a + s.tbas.length, 0);

    // 1. Over the block length
    if (result.totalHours > result.driverMax) {
        const over = Math.round((result.totalHours - result.driverMax) * 60);
        issues.push({
            severity: 'error', code: 'OVER_TIME',
            message: `Route runs ${over} min past the ${result.driverMax}h block`
        });
    } else if (result.totalHours > result.driverMax * 0.95) {
        issues.push({
            severity: 'warning', code: 'NEAR_TIME',
            message: `Route uses ${Math.round((result.totalHours / result.driverMax) * 100)}% of the block, very little slack`
        });
    }

    // 2. Over package capacity
    if (packages > VAN_CAPACITY) {
        issues.push({
            severity: 'error', code: 'OVER_PACKAGES',
            message: `${packages} packages exceeds the ${VAN_CAPACITY} limit`
        });
    }

    // 3. Over cubic capacity
    if (result.totalVolumeL > cap.usableL) {
        issues.push({
            severity: 'error', code: 'OVER_VOLUME',
            message: `${Math.round(result.totalVolumeL)}L will not fit a ${label} (${cap.usableL}L usable)`
        });
    } else if (result.totalVolumeL > cap.usableL * 0.95) {
        issues.push({
            severity: 'warning', code: 'NEAR_VOLUME',
            message: `Load is at ${Math.round((result.totalVolumeL / cap.usableL) * 100)}% of ${label} capacity`
        });
    }

    // 4. Item physically too large for the vehicle
    if (result.maxDimCm > cap.maxDimCm) {
        issues.push({
            severity: 'error', code: 'ITEM_TOO_LONG',
            message: `A ${result.maxDimCm}cm item will not fit a ${label} (max ${cap.maxDimCm}cm)`
        });
    }

    // 5. Unreachable stop, and 6. sprawl introduced by a move
    let prev = 0, worstLeg = 0;
    for (const stop of stops) {
        const leg = matrix[prev][stop.matrix_index];
        if (leg >= UNREACHABLE) {
            issues.push({
                severity: 'error', code: 'UNREACHABLE',
                message: `No drivable route to ${stop.address}`
            });
            break;
        }
        if (prev !== 0 && leg > worstLeg) worstLeg = leg;
        prev = stop.matrix_index;
    }
    if (worstLeg > ABSOLUTE_MAX_STEP) {
        issues.push({
            severity: 'warning', code: 'LONG_LEG',
            message: `${Math.round(worstLeg / 60)} min between two stops, above the ${Math.round(ABSOLUTE_MAX_STEP / 60)} min guideline`
        });
    }

    return issues;
};

// Shuffle vehicles between finished routes so each route ends up on the
// smallest thing that can carry it.
//
// The fleet stays exactly as the dispatcher entered it. All this decides is who
// drives what. Without it a light route can sit on an SUV while a heavy one gets
// a sedan it doesn't fit in, purely because of the order routes got built.
//
// Heaviest route picks first and takes the smallest vehicle that works, so the
// big vehicles stay free for the routes that genuinely need them.
const rematchVehicles = (drivers) => {
    if (drivers.length < 2) return;

    const needs = drivers.map(d => ({
        driver: d,
        vol: d.currentVolume || 0,
        dim: d.currentMaxDim || 0
    }));
    needs.sort((a, b) => (b.vol - a.vol) || (b.dim - a.dim));

    const pool = drivers.map(d => d.vehicle || LARGEST_TIER);
    pool.sort((a, b) => tierCapacity(a).usableL - tierCapacity(b).usableL);

    const used = new Array(pool.length).fill(false);
    const assignment = new Map();

    needs.forEach(nd => {
        let picked = -1;
        for (let i = 0; i < pool.length; i++) {
            if (used[i]) continue;
            const cap = tierCapacity(pool[i]);
            if (nd.vol <= cap.usableL && nd.dim <= cap.maxDimCm) { picked = i; break; }
        }
        // Nothing in the fleet fits it, take the biggest left and let validation shout
        if (picked === -1) {
            for (let i = pool.length - 1; i >= 0; i--) if (!used[i]) { picked = i; break; }
        }
        if (picked !== -1) { used[picked] = true; assignment.set(nd.driver, pool[picked]); }
    });

    let moved = 0;
    assignment.forEach((veh, driver) => {
        if (driver.vehicle !== veh) { driver.vehicle = veh; moved++; }
    });
    if (moved > 0) console.log(`[FLEET] Moved ${moved} route(s) onto a better-fitting vehicle`);
};

// Flag stops that sit on their own with nothing nearby.
//
// These are the ones that quietly wreck a plan: a single package 60km out with
// no neighbour inside half an hour either stretches a route across the map or
// silently overflows. Better to name them up front so the dispatcher decides
// what to do rather than finding out afterwards.
const findRemoteStops = (stops, matrix) => {
    const remote = [];
    stops.forEach(s => {
        let nearest = Infinity;
        let nearestName = null;
        stops.forEach(o => {
            if (o === s) return;
            const d = matrix[s.matrix_index][o.matrix_index];
            if (d < UNREACHABLE && d < nearest) { nearest = d; nearestName = o.address; }
        });
        const stem = matrix[0][s.matrix_index];
        const isolated = nearest > REMOTE_ISOLATION_SECONDS;
        const farOut = stem > REMOTE_STEM_SECONDS;
        if (!isolated && !farOut) return;

        remote.push({
            address: s.address,
            packages: s.tbas.length,
            tbas: s.tbas,
            stemMin: Math.round(stem / 60),
            nearestMin: nearest < UNREACHABLE ? Math.round(nearest / 60) : null,
            nearestStop: nearestName,
            isolated,
            farOut,
            reason: isolated && farOut
                ? `${Math.round(stem / 60)} min from the warehouse with nothing within ${Math.round(nearest / 60)} min of it`
                : isolated
                    ? `Nearest other stop is ${Math.round(nearest / 60)} min away`
                    : `${Math.round(stem / 60)} min from the warehouse`
        });
    });
    remote.sort((a, b) => b.stemMin - a.stemMin);
    return remote;
};

// Work out why each leftover stop didn't get placed. "Unassigned" on its own
// tells a dispatcher nothing they can act on.
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
            reasons.push(`No route passes within ${Math.round(ORPHAN_MAX_ATTACH / 60)} min of this ZIP; ${stemMin} min from the warehouse. Adding it would have stretched a route too far`);
        }
        stop.overflowReason = reasons.join('. ');
    });
};

const planRoutesForRegion = (regionalZips, driverList, matrix, startPoint, mode = 'auto') => {
    if (regionalZips.length === 0 || driverList.length === 0) return [];

    // Row 0 of the matrix is the warehouse, stops start at 1
    regionalZips.forEach((wp, i) => { wp.matrix_index = i + 1; });

    // Split against the biggest vehicle in the fleet, not the smallest
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

    // Pick a starting stop: the densest area we can actually reach
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
            // Lower is better here. Same idea as manual: the amount of work
            // waiting outweighs how far away it is.
            const distFromWarehouse = matrix[0][pkg.matrix_index];
            let score = distFromWarehouse * SEED_STEM_WEIGHT;
            score -= pkg.tbas.length * SEED_PACKAGE_WEIGHT;

            let nearbyPackages = 0;
            available.forEach(other => {
                if (other.matrix_index !== pkg.matrix_index) {
                    const dist = matrix[pkg.matrix_index][other.matrix_index];
                    if (dist < searchRadius) nearbyPackages += other.tbas.length;
                }
            });
            score -= nearbyPackages * SEED_NEARBY_WEIGHT;

            if (score < bestScore) {
                bestScore = score;
                bestSeed = pkg;
            }
        });

        return bestSeed;
    };

    // ---- AUTO MODE ----
    // Add drivers one at a time until everything is placed
    if (mode === 'auto') {
        const maxHours = driverList[0].maxHours;
        // Biggest vehicle auto-plan may assume it has. Finished routes then get
        // classified down to the smallest thing that actually fits them, so the
        // dispatcher finds out what they really need rather than what we guessed.
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

            // Widen the search across tiers until something turns up
            let seed = null;
            for (let tier = 0; tier < RELAXATION_TIERS.length && !seed; tier++) {
                const relaxed = getConstraints(maxHours, tier);
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
            driver.stemTime = stemTime;
            applyStop(driver, seed, stemTime, serviceTime);

            console.log(`[AUTO] Driver ${driverCount} seeded: "${seed.address}" (${seed.tbas.length} pkgs) @ ${Math.round(stemTime/60)}min`);

            // Grow the route, loosening up a tier at a time when nothing fits
            for (let tier = 0; tier < RELAXATION_TIERS.length; tier++) {
                const constraints = getConstraints(maxHours, tier);
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

                        // Would this stretch the route too wide?
                        let violates = false;
                        for (const idx of driver.assignedIndices) {
                            const dist = matrix[idx][pkg.matrix_index];
                            if (dist >= UNREACHABLE || dist > constraints.maxDiameter) { violates = true; break; }
                        }
                        if (violates) return;

                        // Hard ceiling, never negotiable
                        const addedDrive = distFromLast * TRAFFIC_CITY;
                        const addedService = addPkgs * SECONDS_PER_PKG;
                        if (driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService > driver.timeBudget) return;

                        // Keep the block mostly delivering, not driving
                        if (!withinDriveShare(driver, addedDrive)) return;

                        const score = compactnessScore(driver, pkg, distFromLast, matrix);

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

        // ---- SWEEP ----
        // Anything still unassigned gets its own driver. Auto mode shouldn't
        // produce overflow if it can help it, so keep spawning drivers until
        // either everything is placed or nothing left can physically be carried.
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
                
                // Start from whatever's closest to the warehouse
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

                // Nothing left this vehicle can carry. Rest goes to overflow
                // and gets a reason attached.
                if (!bestSeed) break;
                
                bestSeed.isAssigned = true;
                driver.stemTime = bestSeedDist * TRAFFIC_HIGHWAY;
                applyStop(driver, bestSeed, driver.stemTime, bestSeed.tbas.length * SECONDS_PER_PKG);
                
                // Then grab the nearest thing that fits, repeatedly
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
                        if (d >= UNREACHABLE || d > ABSOLUTE_MAX_STEP) return;

                        // Sweep routes get held to the same tightness as planned ones
                        let violates = false;
                        for (const idx of driver.assignedIndices) {
                            const dd = matrix[idx][pkg.matrix_index];
                            if (dd >= UNREACHABLE || dd > SANITY_MAX_DIAMETER) { violates = true; break; }
                        }
                        if (violates) return;

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

        // Clean-up passes: merge anything overlapping, then rebalance stops
        console.log(`[AUTO] Pre-optimize: ${finalRoutes.length} routes`);
        let optimizedDrivers = mergeCloseRoutes(finalRoutes, matrix, maxHours);
        console.log(`[AUTO] After merge: ${optimizedDrivers.length} routes`);
        optimizedDrivers = swapOptimize(optimizedDrivers, matrix, 'AUTO ');
        
        // Renumber and wrap up
        const results = [];
        optimizedDrivers.forEach((driver, idx) => {
            driver.id = idx + 1;
            // Auto mode invents its own fleet, so drop each route to the smallest
            // vehicle that fits. No point asking for an SUV to carry a sedan load.
            const needed = classifyVehicle(driver.currentVolume || 0, driver.currentMaxDim || 0);
            if (needed) driver.vehicle = needed;
            const result = finalizeRoute(driver, startPoint, matrix);
            console.log(`[AUTO] Driver ${driver.id} final: ${driver.route.length} stops, ${driver.currentPackages} pkgs, ${result.totalVolumeL}L, longest ${result.maxDimCm}cm -> ${result.requiredVehicle}, ${result.totalHours.toFixed(2)}h`);
            results.push(result);
        });

        // Whatever's left
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

    // ---- MANUAL MODE ----
    // Fixed fleet, so it's an auction instead. Each unassigned package belongs
    // to whichever driver's route is nearest, and a driver can only bid on
    // packages in their own territory. That's what keeps routes from crossing.
    else {
        const totalHours = driverList.reduce((sum, d) => sum + d.maxHours, 0);
        const totalVolume = splitZips.reduce((s, z) => s + (z.volumeL || 0), 0);

        // A bit of headroom over the exact share, so clustering still looks
        // natural. Without it routes come out mechanically even and ugly.
        // Was a hardcoded 1.35 that no control could reach. Same trap as the
        // orphan distance: you'd move a slider, nothing would change, and the
        // real governing number was sitting in here.
        const SHARE_SLACK = FAIR_SHARE_SLACK;

        const drivers = driverList.map(d => {
            const hourRatio = d.maxHours / totalHours;

            // Always proportional now. There used to be a "sparse manifest"
            // branch that reset everyone to full van capacity, which removed all
            // throttling and let whoever bid first take the lot.
            let budget = Math.ceil(totalPackages * hourRatio * SHARE_SLACK);
            budget = Math.min(budget, VAN_CAPACITY);
            budget = Math.max(budget, 5);

            // Same idea for volume, capped by what the vehicle can hold
            const vehCap = tierCapacity(d.vehicle || LARGEST_TIER);
            const volumeBudget = Math.min(
                vehCap.usableL,
                Math.max(totalVolume * hourRatio * SHARE_SLACK, totalVolume * 0.15)
            );

            const constraints = getConstraints(d.maxHours);

            console.log(`[MANUAL] Driver ${d.id}: ${d.maxHours}h ${d.vehicle || LARGEST_TIER} -> share ${budget} pkgs / ${Math.round(volumeBudget)}L of ${vehCap.usableL}L | stem: ${Math.round(constraints.maxStemTime/60)}min`);

            return {
                id: d.id,
                maxHours: d.maxHours,
                vehicle: d.vehicle || LARGEST_TIER,
                timeBudget: d.maxHours * 3600,
                packageBudget: budget,
                volumeBudget: volumeBudget,
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

        // Longest blocks first, they can reach further out
        drivers.sort((a, b) => b.maxHours - a.maxHours);

        // ---- SEEDING ----
        // First driver starts in the densest area we can reach. Everyone after
        // that starts as far from the existing seeds as density allows, so the
        // fleet spreads over separate clusters instead of piling into one.
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
                
                const distFromWarehouse = matrix[0][pkg.matrix_index];

                // Stem is paid once, so it barely matters next to how much work
                // is waiting. It used to be weighted 0.25 per second against 60
                // per package, which meant a single-package ZIP 3 minutes out
                // beat a six-package ZIP 40 minutes out. Backwards: we care
                // about getting packages delivered.
                const stemPreference = distFromWarehouse * SEED_STEM_WEIGHT;
                const workHere = (pkg.tbas.length * SEED_PACKAGE_WEIGHT)
                               + (nearbyPkgs * SEED_NEARBY_WEIGHT);

                if (driverIdx === 0) {
                    const score = workHere - stemPreference;
                    if (score > bestScore) { bestScore = score; bestSeed = pkg; }
                } else {
                    // Spread stops every driver seeding on top of each other.
                    // Worth watching: crank it too high and a far empty ZIP can
                    // out-earn a busy one just by being far away.
                    let minDistToExisting = Infinity;
                    for (const existIdx of seedIndices) {
                        const d = matrix[existIdx][pkg.matrix_index];
                        if (d < minDistToExisting) minDistToExisting = d;
                    }

                    const score = workHere
                                + (minDistToExisting * SEED_SPREAD_WEIGHT)
                                - stemPreference;
                    if (score > bestScore) { bestScore = score; bestSeed = pkg; }
                }
            });
            
            if (bestSeed) {
                const stemTime = matrix[0][bestSeed.matrix_index] * TRAFFIC_HIGHWAY;
                const serviceTime = bestSeed.tbas.length * SECONDS_PER_PKG;
                
                if (stemTime + serviceTime > driver.timeBudget) return;
                
                bestSeed.isAssigned = true;
                driver.stemTime = stemTime;
                applyStop(driver, bestSeed, stemTime, serviceTime);
                seedIndices.push(bestSeed.matrix_index);
                
                // Log the whole cluster, not just the seed stop. A 1-package ZIP
                // with five more next door is a 6-package area, and the seed
                // score treats it that way.
                let reach = 0;
                unassigned.forEach(o => {
                    if (o.isAssigned || o === bestSeed) return;
                    const d = matrix[bestSeed.matrix_index][o.matrix_index];
                    if (d < baseConstraints.stepLimit) reach += o.tbas.length;
                });
                console.log(`[MANUAL] Driver ${driver.id} seeded: "${bestSeed.address}" `
                    + `(${bestSeed.tbas.length} here, ${reach} more within `
                    + `${Math.round(baseConstraints.stepLimit/60)}min) @ ${Math.round(stemTime/60)}min out`);
            }
        });

        // ---- THE AUCTION ----
        // Each round: work out whose route each leftover package is nearest to,
        // then let every driver take the best one from their own pile. Capacity
        // and time still apply. If a whole round passes with nobody able to take
        // anything, loosen up a tier and go again.
        const seededDrivers = drivers.filter(d => d.route.length > 0);

        // Two passes. The first holds everyone to their fair share so work
        // spreads out. The second drops the shares entirely and lets whoever can
        // take what's left. An unassigned package is worse than an uneven driver.
        for (let phase = 0; phase < 2; phase++) {
        const enforceShares = (phase === 0);

        if (phase === 1) {
            const left = unassigned.filter(u => !u.isAssigned);
            if (left.length === 0) break;
            console.log(`[MANUAL] Phase 2 (shares lifted): ${left.length} stops still unassigned`);
        }

        for (let tier = 0; tier < RELAXATION_TIERS.length; tier++) {
            const relaxAdd = RELAXATION_DIAMETER_ADD[tier];

            const remaining = unassigned.filter(u => !u.isAssigned);
            if (remaining.length === 0) break;

            if (tier > 0) {
                console.log(`[MANUAL] Relaxation tier ${tier} (+${Math.round(relaxAdd/60)}min): ${remaining.length} stops remaining`);
            }

            // Per-driver constraints at this tier
            const driverConstraints = {};
            seededDrivers.forEach(d => {
                driverConstraints[d.id] = getConstraints(d.maxHours, tier);
            });

            let tierStalled = false;
            let iterations = 0;
            const maxIterations = totalPackages * 3;

            while (!tierStalled && iterations < maxIterations) {
                iterations++;

                const stillRemaining = unassigned.filter(u => !u.isAssigned);
                if (stillRemaining.length === 0) break;

                // Sort every leftover package into whoever's route it's nearest to
                const driverBins = {};
                seededDrivers.forEach(d => { driverBins[d.id] = []; });

                stillRemaining.forEach(pkg => {
                    // Who could physically take this, and how far away are they
                    const candidates = [];
                    seededDrivers.forEach(driver => {
                        if (enforceShares && driver.currentPackages >= driver.packageBudget) return;
                        if (!fitsVehicle(driver, pkg, enforceShares)) return;
                        const dist = minDistToRoute(pkg.matrix_index, driver.route, matrix);
                        if (dist >= UNREACHABLE) return;
                        candidates.push({ driver, dist });
                    });
                    if (candidates.length === 0) return;

                    // Clear winner takes it. If several are within a few minutes
                    // of each other, call it a tie and give it to whoever has the
                    // least work. Nobody genuinely further away ever gets it just
                    // for balance.
                    const closestDist = Math.min(...candidates.map(c => c.dist));
                    const tied = candidates.filter(c => c.dist <= closestDist + TIE_TOLERANCE_SECONDS);

                    let chosen = tied[0];
                    if (tied.length > 1) {
                        let lowestLoad = Infinity;
                        tied.forEach(c => {
                            const load = (c.driver.currentDriveTime + c.driver.currentServiceTime) / c.driver.timeBudget;
                            if (load < lowestLoad) { lowestLoad = load; chosen = c; }
                        });
                    }

                    driverBins[chosen.driver.id].push({ pkg, routeDist: chosen.dist });
                });

                // Now everyone takes their best available option
                let madeAssignment = false;

                seededDrivers.forEach(driver => {
                    if (enforceShares && driver.currentPackages >= driver.packageBudget) return;
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
                        if (!fitsVehicle(driver, pkg, enforceShares)) return;

                        const distFromLast = matrix[lastStop.matrix_index][pkg.matrix_index];
                        if (distFromLast >= UNREACHABLE) return;

                        // Too far from the last stop?
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

                        // Productivity check: keep the block mostly delivering
                        if (!withinDriveShare(driver, addedDrive)) return;

                        // Score on nearness plus how much it stretches the route
                        const score = compactnessScore(driver, pkg, distFromLast, matrix);

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
        }

        // ---- ORPHANS ----
        // Anything still homeless goes to the nearest route that has room.
        // Width and step rules are dropped here, but distance still has a cap.
        let orphans = unassigned.filter(u => !u.isAssigned);
        if (orphans.length > 0 && seededDrivers.length > 0) {
            console.log(`[MANUAL] Orphan rescue: ${orphans.length} stops to place`);

            // Hardest ones first, they have the fewest options
            orphans.sort((a, b) => matrix[0][b.matrix_index] - matrix[0][a.matrix_index]);

            orphans.forEach(orphan => {
                let bestDriver = null;
                let bestRouteDist = Infinity;

                seededDrivers.forEach(driver => {
                    if (!fitsVehicle(driver, orphan, false)) return;

                    // Min distance from orphan to this driver's route
                    const dist = minDistToRoute(orphan.matrix_index, driver.route, matrix);
                    if (dist >= UNREACHABLE) return;

                    // Hard cap. Bolting a far orphan onto the nearest route is
                    // what used to draw those long tentacles across the map.
                    // Better to leave it unassigned and say why.
                    if (dist > ORPHAN_MAX_ATTACH) return;

                    // And it can't blow out the route's overall width
                    const wouldBeDiameter = Math.max(
                        routeDiameter(driver.route, matrix),
                        Math.max(...driver.route.map(s => {
                            const d = matrix[s.matrix_index][orphan.matrix_index];
                            return d >= UNREACHABLE ? 0 : d;
                        }))
                    );
                    if (wouldBeDiameter > SANITY_MAX_DIAMETER) return;

                    // Time check
                    const addedDrive = dist * TRAFFIC_CITY;
                    const addedService = orphan.tbas.length * SECONDS_PER_PKG;
                    const newTime = driver.currentDriveTime + driver.currentServiceTime + addedDrive + addedService;
                    if (newTime > driver.timeBudget) return;
                    if (!withinDriveShare(driver, addedDrive)) return;

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

        // ---- IDLE DRIVERS ----
        // Packages left and drivers sitting empty. Put them to work.
        let stillRemaining = unassigned.filter(u => !u.isAssigned);
        const unusedDrivers = drivers.filter(d => d.route.length === 0);
        
        if (stillRemaining.length > 0 && unusedDrivers.length > 0) {
            console.log(`[MANUAL] Unused driver sweep: ${stillRemaining.length} stops, ${unusedDrivers.length} unused drivers`);
            
            for (const driver of unusedDrivers) {
                stillRemaining = unassigned.filter(u => !u.isAssigned);
                if (stillRemaining.length === 0) break;
                
                // Start them on whatever's nearest the warehouse
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
                driver.stemTime = bestDist * TRAFFIC_HIGHWAY;
                applyStop(driver, bestSeed, driver.stemTime, bestSeed.tbas.length * SECONDS_PER_PKG);
                
                // Then nearest thing that fits, repeatedly
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
                        if (d >= UNREACHABLE || d > ABSOLUTE_MAX_STEP) return;

                        let violates = false;
                        for (const idx of driver.assignedIndices) {
                            const dd = matrix[idx][pkg.matrix_index];
                            if (dd >= UNREACHABLE || dd > SANITY_MAX_DIAMETER) { violates = true; break; }
                        }
                        if (violates) return;

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

        // Rebalance stops between routes
        let activeDrivers = drivers.filter(d => d.route.length > 0);
        activeDrivers = swapOptimize(activeDrivers, matrix, 'MANUAL ');

        // ---- FILL EMPTY DRIVERS ----
        // If the dispatcher added five drivers, five drivers get work. Peel the
        // outlying stops off the heaviest routes and hand them over.
        let emptyDrivers = drivers.filter(d => d.route.length === 0);
        
        while (emptyDrivers.length > 0) {
            // Heaviest route, needs at least 3 stops to be worth splitting
            activeDrivers = drivers.filter(d => d.route.length > 0);
            let heaviest = null;
            let heaviestStops = 0;
            activeDrivers.forEach(d => {
                if (d.route.length > heaviestStops) {
                    heaviestStops = d.route.length;
                    heaviest = d;
                }
            });
            
            // Nothing big enough left to split
            if (!heaviest || heaviest.route.length < 3) {
                console.log(`[MANUAL] Rebalance: no route large enough to split (largest: ${heaviestStops} stops)`);
                break;
            }
            
            const emptyDriver = emptyDrivers[0];
            
            // Find the biggest outlier, then peel it off along with whatever
            // sits near it, so the new driver gets a cluster and not scraps.
            
            // How far each stop sits from the rest of its route
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
            
            // Worst offenders first
            stopScores.sort((a, b) => b.avgDist - a.avgDist);
            
            // Aim to peel about half, keeping the peeled stops near each other
            const peelSeed = stopScores[0].stop;
            const peelIndices = new Set([stopScores[0].idx]);
            
            // Roughly a fair share
            const targetPeel = Math.max(1, Math.floor(heaviest.route.length / 2));
            
            // Fill up with whatever is closest to the one we started with
            const candidates = stopScores.slice(1).map(s => ({
                ...s,
                distToPeel: matrix[peelSeed.matrix_index][s.stop.matrix_index]
            })).sort((a, b) => a.distToPeel - b.distToPeel);
            
            for (const c of candidates) {
                if (peelIndices.size >= targetPeel) break;
                peelIndices.add(c.idx);
            }
            
            // Hand them over
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
            
            // Anyone still empty?
            emptyDrivers = drivers.filter(d => d.route.length === 0);
        }
        
        // One more rebalance pass now that everyone has work
        emptyDrivers = drivers.filter(d => d.route.length === 0);
        activeDrivers = drivers.filter(d => d.route.length > 0);
        if (emptyDrivers.length === 0 && activeDrivers.length === drivers.length) {
            activeDrivers = swapOptimize(activeDrivers, matrix, 'MANUAL-REBAL ');
        }

        // Put every route on the smallest vehicle in the fleet that can take it
        rematchVehicles(activeDrivers);

        // Wrap up
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

// The other planner. Off by default, switchable from the UI.
const planRoutesByCluster = require('./cluster_planner')({
    VAN_CAPACITY, SECONDS_PER_PKG, UNREACHABLE,
    TRAFFIC_HIGHWAY, TRAFFIC_CITY,
    ABSOLUTE_MAX_STEP, MAX_LOCAL_DRIVE_SHARE,
    LARGEST_TIER, tierCapacity, classifyVehicle,
    splitBigZips, optimizeRouteWith2Opt, annotateOverflow, computeMetrics
});

// ---- API ----

app.post('/calculate-routes', async (req, res) => {
    try {
        const { loosePackages = [], bags = [], drivers, mode,
                residentialOnly = false, algorithm = 'greedy',
                config = null } = req.body;

        // Constraint tweaks from the editor, this request only
        const appliedConfig = applyConfig(config);
        if (Object.keys(appliedConfig).length > 0) {
            console.log('[CONFIG] overrides:', JSON.stringify(appliedConfig));
        }

        console.log(`\n========== NEW REQUEST ==========`);
        console.log(`Mode: "${mode}" | Algorithm: "${algorithm}" | Drivers: ${drivers ? drivers.length : 0}`);

        if (mode === 'manual' && drivers && drivers.length > 0) {
            drivers.forEach(d => console.log(`  - Driver ${d.id}: ${d.maxHours}h`));
        } else if (mode === 'auto' && drivers && drivers.length > 0) {
            console.log(`  - Auto with ${drivers[0].maxHours}h blocks`);
        }

        if (!drivers) return res.status(400).json({ error: 'No drivers' });

        // ---- INTAKE ----
        // Three piles before anything gets routed:
        //   deliverable  - goes out with a driver
        //   fcReturns    - destination is a station code, ships back to the FC
        //   addressHolds - business address while residential-only is switched on
        // Only the first pile reaches the solver.
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

        // Work out each package's volume once and hang onto it
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

        // Screen bags item by item, keep whatever survives
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

        // Split the fleet across states BEFORE planning.
        //
        // Every state used to get handed the whole driver list, so a PA+NJ
        // manifest produced roughly double the routes you asked for. Nobody
        // noticed because we only ever run PA.
        //
        // Drivers never cross state lines, which is the point of bucketing in
        // the first place, so each one belongs to exactly one state. Shares are
        // proportional to how much work each state holds. Auto mode is exempt:
        // it invents its own fleet, so every state can have as many as it needs.
        const splitFleetByState = (fleet, stateBuckets) => {
            const states = Object.keys(stateBuckets);
            const alloc = {};
            if (states.length === 1) { alloc[states[0]] = fleet; return alloc; }

            const work = {};
            let totalWork = 0;
            states.forEach(st => {
                work[st] = stateBuckets[st].reduce((a, s) => a + s.tbas.length, 0);
                totalWork += work[st];
            });

            // Biggest workload first, so rounding leftovers land where they help
            const ordered = [...states].sort((a, b) => work[b] - work[a]);

            // Longest blocks first within the fleet, so the states doing the most
            // get the drivers with the most hours
            const pool = [...fleet].sort((a, b) => b.maxHours - a.maxHours);

            const counts = {};
            let handedOut = 0;
            ordered.forEach((st, i) => {
                // Every state with work gets at least one driver
                const share = totalWork > 0 ? (work[st] / totalWork) : (1 / states.length);
                let n = Math.max(1, Math.round(fleet.length * share));
                if (i === ordered.length - 1) n = Math.max(0, fleet.length - handedOut);
                n = Math.min(n, fleet.length - handedOut);
                counts[st] = n;
                handedOut += n;
            });

            // Anything left over from rounding goes to the busiest state
            if (handedOut < fleet.length && ordered.length) {
                counts[ordered[0]] += fleet.length - handedOut;
            }

            let cursor = 0;
            ordered.forEach(st => {
                alloc[st] = pool.slice(cursor, cursor + counts[st]);
                cursor += counts[st];
            });

            states.forEach(st => {
                const got = (alloc[st] || []).length;
                console.log(`[FLEET] ${st}: ${work[st]} packages -> ${got} driver(s)`);
                if (got === 0) {
                    console.log(`[FLEET] Warning: ${st} has work but no driver, its stops will overflow`);
                }
            });
            return alloc;
        };

        const fleetByState = (mode === 'auto')
            ? null
            : splitFleetByState(drivers || [], buckets);

        let allRoutes = [];
        let naiveDriveTotal = 0, naiveViolations = 0, naiveChunks = 0;
        const remoteStops = [];
        const naiveBreakdown = {};
        for (const state of Object.keys(buckets)) {
            console.log(`\n--- Processing ${state}: ${buckets[state].length} stops ---`);
            const stops = buckets[state];
            const distMatrix = [];
            const matrix = await getDistanceMatrix([startingLocation, ...stops], distMatrix);
            const planner = algorithm === 'cluster' ? planRoutesByCluster : planRoutesForRegion;
            const stateFleet = fleetByState ? (fleetByState[state] || []) : drivers;

            if (fleetByState && stateFleet.length === 0) {
                // No driver available for this state, so everything here is
                // unassigned. Say why rather than dropping it silently.
                annotateOverflow(stops, LARGEST_TIER, matrix);
                stops.forEach(s => {
                    s.overflowReason = `No driver was allocated to ${state}. `
                        + `Add a driver or plan this state separately.`;
                });
                allRoutes.push({
                    route: stops, totalHours: 0, driverId: 'OVERFLOW',
                    driverMax: 0, isOverflow: true,
                    totalVolumeL: +stops.reduce((a, s) => a + (s.volumeL || 0), 0).toFixed(1),
                    maxDimCm: stops.reduce((m, s) => Math.max(m, s.maxDimCm || 0), 0),
                    totalPackages: stops.reduce((a, s) => a + s.tbas.length, 0)
                });
                continue;
            }

            const result = planner(stops, stateFleet, matrix, startingLocation, mode);
            // Remember which matrix this was planned against, validation needs it
            result.forEach(r => { r._matrix = matrix; });

            // Mileage and running cost per route
            const MPG = { SEDAN: MPG_SEDAN, SUV: MPG_SUV, TRUCK: MPG_TRUCK };
            result.forEach(r => {
                if (r.isOverflow) return;
                const stops2 = r.route.filter(s => !s.isWarehouse);
                const metres = routeDistanceMeters(stops2, distMatrix);
                const miles = metres / 1609.34;
                const mpg = MPG[r.assignedVehicle] || MPG_SEDAN;
                const gallons = mpg > 0 ? miles / mpg : 0;
                r.mileage = {
                    miles: +miles.toFixed(1),
                    km: +(metres / 1000).toFixed(1),
                    gallons: +gallons.toFixed(2),
                    fuelCost: +(gallons * FUEL_PRICE_PER_GAL).toFixed(2),
                    runningCost: +(miles * COST_PER_MILE).toFixed(2),
                    costPerPackage: null
                };
                const pk = stops2.reduce((a, s) => a + s.tbas.length, 0);
                if (pk > 0) r.mileage.costPerPackage = +(r.mileage.runningCost / pk).toFixed(2);
            });

            // Stops with nothing near them, flagged before the dispatcher notices
            findRemoteStops(stops, matrix).forEach(x => remoteStops.push(x));

            // Like for like: the comparison only covers stops we actually
            // delivered. Counting overflowed ones would flatter us for
            // skipping work we couldn't fit.
            const planned = result.filter(r => !r.isOverflow && r.route.length > 0);
            const deliveredStops = [];
            planned.forEach(r => r.route.forEach(s => { if (!s.isWarehouse) deliveredStops.push(s); }));
            if (planned.length > 0 && deliveredStops.length > 0) {
                // Same fleet the solver ended up using
                const usedFleet = planned.map(r => ({
                    maxHours: r.driverMax,
                    vehicle: r.assignedVehicle || LARGEST_TIER
                }));
                const naive = naivePlanDriveTime(deliveredStops, usedFleet, matrix);
                naiveDriveTotal += naive.driveSec;
                naiveViolations += naive.violations;
                Object.keys(naive.breakdown).forEach(k => {
                    naiveBreakdown[k] = (naiveBreakdown[k] || 0) + naive.breakdown[k];
                });
                naiveChunks += naive.chunks;
            }

            allRoutes.push(...result);
        }

        // Renumber so the IDs run 1..N
        let driverIdx = 1;
        allRoutes.forEach(r => {
            if (!r.driverId.toString().includes("OVERFLOW")) {
                r.driverId = driverIdx++;
            }
        });

        // Anything loaded beyond what its vehicle can take
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

        // Check everything before it goes out the door
        let errorCount = 0, warningCount = 0;
        allRoutes.forEach(r => {
            r.issues = r._matrix ? validateRoute(r, r._matrix) : [];
            delete r._matrix;
            r.issues.forEach(i => i.severity === 'error' ? errorCount++ : warningCount++);
        });
        if (errorCount || warningCount) {
            console.log(`[VALIDATE] ${errorCount} error(s), ${warningCount} warning(s)`);
        }

        // Roll the numbers up across the fleet
        const planned = allRoutes.filter(r => !r.isOverflow && r.metrics);
        const optimizedTotal = planned.reduce((s, r) => s + r.metrics.optimizedDriveSec, 0);
        const fleetMetrics = {
            // Versus splitting the manifest into equal piles with no software
            optimizedDriveSec: optimizedTotal,
            naiveDriveSec: naiveDriveTotal,
            naiveSavedSec: naiveDriveTotal - optimizedTotal,
            naiveSavedPct: naiveDriveTotal > 0
                ? +(((naiveDriveTotal - optimizedTotal) / naiveDriveTotal) * 100).toFixed(1) : 0,

            // How many of the unplanned piles you couldn't actually send out.
            // This plan should always be zero.
            naiveViolations,
            naiveBreakdown,
            naiveChunks,
            planViolations: errorCount,
            routesPlanned: planned.length
        };

        // No fleet totals. What matters is comparing one driver's route against
        // another's, so the per-route figures are the ones that get shown.

        console.log(`\n========== COMPLETE: ${allRoutes.length} routes | ${fcReturns.length} FC | ${addressHolds.length} held ==========\n`);

        res.json({
            routes: allRoutes,
            fleetMetrics,
            remoteStops,
            validation: { errors: errorCount, warnings: warningCount },
            configSchema: CONFIG_SCHEMA,
            configDefaults: DEFAULTS,
            vehicleSchema: VEHICLE_SCHEMA,
            vehicleDefaults: (() => {
                const d = {}; VEHICLE_SCHEMA.forEach(s => { d[s.key] = s.def; }); return d;
            })(),
            configApplied: appliedConfig,
            fcReturns,
            addressHolds,
            algorithm,
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
    } finally {
        // Always put the defaults back, or the next request inherits these
        resetConfig();
    }
});

// =====================================================
// MANUAL REASSIGNMENT
//
// Takes the plan that's on screen plus one move, applies it, then rebuilds
// every number from scratch: sequence, times, mileage, safety checks.
//
// Deliberately recomputes rather than patching the two routes involved. A move
// changes stop order, which changes drive time, which changes whether the route
// still fits the block. Patching would mean re-deriving all of that by hand and
// getting it subtly wrong.
// =====================================================
app.post('/reassign', async (req, res) => {
    try {
        const { routes = [], move = null, config = null, departSeconds = 0 } = req.body;
        applyConfig(config);

        if (!move || !move.fromDriverId || !move.toDriverId || !move.address) {
            return res.status(400).json({ error: 'Move needs a source driver, a target driver and a stop' });
        }
        if (String(move.fromDriverId) === String(move.toDriverId)) {
            return res.status(400).json({ error: 'That stop is already on that driver' });
        }

        // Rebuild working copies of every route
        const work = routes.map(r => ({
            driverId: r.driverId,
            driverMax: r.driverMax,
            vehicle: r.assignedVehicle || LARGEST_TIER,
            isOverflow: !!r.isOverflow,
            stops: r.route.filter(s => !s.isWarehouse).map(s => ({ ...s }))
        }));

        // "OVERFLOW" is a valid source: assigning unassigned packages is the
        // main thing a dispatcher wants to do after a plan comes back.
        const from = String(move.fromDriverId) === 'OVERFLOW'
            ? work.find(w => w.isOverflow)
            : work.find(w => String(w.driverId) === String(move.fromDriverId));
        const to = work.find(w => String(w.driverId) === String(move.toDriverId));
        if (!from || !to) return res.status(400).json({ error: 'Driver not found in the current plan' });

        const srcIdx = from.stops.findIndex(s => s.address === move.address);
        if (srcIdx === -1) return res.status(400).json({
            error: `${move.address} is not on ${move.fromDriverId === 'OVERFLOW' ? 'the unassigned pile' : 'driver ' + move.fromDriverId}` });
        const srcStop = from.stops[srcIdx];

        // Whole stop, or just the tracking numbers that were ticked
        const movingTbas = (Array.isArray(move.tbas) && move.tbas.length)
            ? move.tbas.filter(t => srcStop.tbas.includes(t))
            : [...srcStop.tbas];
        if (movingTbas.length === 0) return res.status(400).json({ error: 'No packages selected' });

        // Bags travel together. Splitting one is never allowed.
        if (srcStop.bagId && movingTbas.length !== srcStop.tbas.length) {
            return res.status(400).json({
                error: `${move.address} is a bag. Bags cannot be split, move the whole stop instead.`
            });
        }

        const perTbaVol = srcStop.tbas.length > 0
            ? (srcStop.volumeL || 0) / srcStop.tbas.length : 0;
        const movingVol = +(perTbaVol * movingTbas.length).toFixed(2);
        const partial = movingTbas.length < srcStop.tbas.length;

        // Take them off the source
        if (partial) {
            srcStop.tbas = srcStop.tbas.filter(t => !movingTbas.includes(t));
            srcStop.volumeL = +((srcStop.volumeL || 0) - movingVol).toFixed(2);
        } else {
            from.stops.splice(srcIdx, 1);
        }

        // Add to the target, merging if that driver already visits this ZIP
        const existing = to.stops.find(s => s.address === move.address);
        if (existing) {
            existing.tbas = [...existing.tbas, ...movingTbas];
            existing.volumeL = +((existing.volumeL || 0) + movingVol).toFixed(2);
            existing.maxDimCm = Math.max(existing.maxDimCm || 0, srcStop.maxDimCm || 0);
        } else {
            to.stops.push({
                ...srcStop,
                tbas: movingTbas,
                volumeL: movingVol,
                maxDimCm: partial ? (srcStop.maxDimCm || 0) : srcStop.maxDimCm
            });
        }

        // Rebuild the matrix over everything still in the plan
        const allStops = [];
        work.forEach(w => w.stops.forEach(s => allStops.push(s)));
        if (allStops.length === 0) return res.status(400).json({ error: 'Nothing left to plan' });

        allStops.forEach((s, i) => { s.matrix_index = i + 1; });
        const distMatrix = [];
        const matrix = await getDistanceMatrix([startingLocation, ...allStops], distMatrix);

        // Re-sequence and re-measure every route
        const MPG = { SEDAN: MPG_SEDAN, SUV: MPG_SUV, TRUCK: MPG_TRUCK };
        const rebuilt = [];

        work.forEach(w => {
            if (w.isOverflow) {
                if (w.stops.length === 0) return;
                annotateOverflow(w.stops, LARGEST_TIER, matrix);
                rebuilt.push({
                    route: w.stops, totalHours: 0, driverId: 'OVERFLOW', driverMax: 0,
                    isOverflow: true,
                    totalVolumeL: +w.stops.reduce((a, s) => a + (s.volumeL || 0), 0).toFixed(1),
                    maxDimCm: w.stops.reduce((m, s) => Math.max(m, s.maxDimCm || 0), 0),
                    totalPackages: w.stops.reduce((a, s) => a + s.tbas.length, 0)
                });
                return;
            }

            const driver = {
                id: w.driverId,
                maxHours: w.driverMax,
                vehicle: w.vehicle,
                timeBudget: w.driverMax * 3600,
                route: w.stops,
                currentPackages: w.stops.reduce((a, s) => a + s.tbas.length, 0),
                currentVolume: +w.stops.reduce((a, s) => a + (s.volumeL || 0), 0).toFixed(2),
                currentMaxDim: w.stops.reduce((m, s) => Math.max(m, s.maxDimCm || 0), 0),
                currentDriveTime: 0,
                currentServiceTime: 0,
                stemTime: 0,
                assignedIndices: new Set(w.stops.map(s => s.matrix_index))
            };

            if (driver.route.length === 0) {
                rebuilt.push({
                    route: [{ ...startingLocation, matrix_index: 0, tbas: ['WAREHOUSE'], isWarehouse: true, volumeL: 0, maxDimCm: 0 }],
                    totalHours: 0, driverId: w.driverId, driverMax: w.driverMax,
                    totalVolumeL: 0, maxDimCm: 0, diameterMin: 0,
                    requiredVehicle: null, assignedVehicle: w.vehicle, vehicleUsagePct: 0,
                    metrics: { optimizedDriveSec: 0 }
                });
                return;
            }

            recalcDriverTime(driver, matrix, true);
            const result = finalizeRoute(driver, startingLocation, matrix);

            const stops2 = result.route.filter(s => !s.isWarehouse);
            const metres = routeDistanceMeters(stops2, distMatrix);
            const miles = metres / 1609.34;
            const mpg = MPG[w.vehicle] || MPG_SEDAN;
            const gallons = mpg > 0 ? miles / mpg : 0;
            const pk = stops2.reduce((a, s) => a + s.tbas.length, 0);
            result.mileage = {
                miles: +miles.toFixed(1),
                km: +(metres / 1000).toFixed(1),
                gallons: +gallons.toFixed(2),
                fuelCost: +(gallons * FUEL_PRICE_PER_GAL).toFixed(2),
                runningCost: +(miles * COST_PER_MILE).toFixed(2),
                costPerPackage: pk > 0 ? +((miles * COST_PER_MILE) / pk).toFixed(2) : null
            };
            rebuilt.push(result);
        });

        // Re-check everything, not just what moved.
        //
        // Nothing here rejects a move for being over a limit. This is a manual
        // override: the dispatcher can see something the solver cannot, so the
        // move always goes through and the consequence is reported instead.
        let errorCount = 0, warningCount = 0;
        rebuilt.forEach(r => {
            r.issues = validateRoute(r, matrix);
            r.issues.forEach(i => i.severity === 'error' ? errorCount++ : warningCount++);
        });

        // Remember which routes were touched by hand. The flag has to survive
        // re-renders, otherwise a manual edit is invisible five seconds later.
        const touched = new Set([String(move.fromDriverId), String(move.toDriverId)]);
        rebuilt.forEach(r => {
            const wasTouched = touched.has(String(r.driverId))
                || (r.isOverflow && touched.has('OVERFLOW'));
            const prior = routes.find(x => String(x.driverId) === String(r.driverId));
            r.manuallyAdjusted = wasTouched || !!(prior && prior.manuallyAdjusted);
        });

        console.log(`[MOVE] ${movingTbas.length} package(s) from "${move.address}": `
            + `driver ${move.fromDriverId} -> ${move.toDriverId} | `
            + `${errorCount} error(s), ${warningCount} warning(s)`);

        res.json({
            routes: rebuilt,
            validation: { errors: errorCount, warnings: warningCount },
            moved: { address: move.address, count: movingTbas.length, tbas: movingTbas }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    } finally {
        resetConfig();
    }
});

// The constraint editor pulls its control definitions from here
app.get('/config-schema', (req, res) => {
    const vehicleDefaults = {};
    VEHICLE_SCHEMA.forEach(s => { vehicleDefaults[s.key] = s.def; });
    res.json({
        schema: CONFIG_SCHEMA,
        defaults: DEFAULTS,
        vehicleSchema: VEHICLE_SCHEMA,
        vehicleDefaults
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));