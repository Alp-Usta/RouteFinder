# RouteFinder

A route planning tool for last-mile package delivery. You give it a CSV of packages and a list of drivers, and it works out who should take what.

Built independently, on my own time and my own equipment, as a personal and academic project.

---

## What problem this solves

Last-mile delivery in a lot of places still comes down to somebody standing in front of a pile of packages in the morning deciding who takes what. Gig drivers book time blocks, usually two to four hours, and drive their own cars — some a sedan, some an SUV, some a pickup.

Getting that assignment wrong costs real time:

- A driver spends the block driving instead of delivering
- A driver turns up to load and their car can't physically fit what they were given
- A driver runs past the block they're actually paid for

Doing it by hand also tends to produce unbalanced work. One person gets a tight cluster of thirty stops, another gets six stops spread across forty kilometres.

RouteFinder does that assignment step. It takes the package list, groups stops that belong together, and hands each group to a driver whose vehicle and block length can actually handle it.

**It does not do turn-by-turn navigation.** Once a driver has their packages, their own delivery app handles directions and stop order. What this tool decides is which packages belong together and who gets them.

---

## What it looks like

### Loading a manifest

![Package intake and fleet setup](satty-2026-08-26_23_40_43.png)

Drop in the CSV and it reports what's actually there: 32 routable packages, 1124 L
of space needed, the longest item at 142.9 cm, and a size breakdown. It flags that
one package won't fit anything smaller than a truck, and that one item on the
manifest is a return rather than a delivery.

### The plan

![Planned routes on the map](satty-2026-08-26_23_40_58.png)

Six routes across 19 locations. The panel flags three areas sitting on their own,
confirms every route passes its safety checks, and reports what an unplanned split
would have cost — three constraint violations, against zero here.

### Per-driver detail

![Route cards with stops, timing and cost](satty-2026-08-26_23_41_09.png)

Every driver's route with arrival times, packages per stop, miles, gas and running
cost. The move link on any stop reassigns it by hand.

### Comparing planners

![Algorithm comparison](satty-2026-08-26_23_38_36.png)

Both algorithms run on the same packages and fleet. Here cluster-first drives 8
minutes less for the same 32 packages and spreads work far more evenly across
drivers, while the greedy planner keeps routes geographically tighter.

## What it does

**Planning**
- Imports a CSV of packages (tracking number, postal code, optional dimensions)
- Geocodes postal codes and builds a real drive-time matrix from a self-hosted routing engine
- Assigns stops to drivers under hard constraints: cargo volume, longest item, block hours, drive-out distance, maximum gap between stops, and a cap on how much of a block can be spent driving rather than delivering
- Two planning strategies, switchable, with a side-by-side comparison view

**Vehicles**
- Three tiers with editable cargo volumes
- Checks longest item separately from volume, because a long thin package can fit by cubic volume and still not go through a trunk opening
- Matches each route to the smallest vehicle in the fleet that can carry it

**Working with the plan**
- Interactive map with numbered per-driver stops
- Barcode lookup: scan a package, it tells you which driver has it and when they'll be there
- Move packages between drivers by hand, with a map, a search box that accepts a scan, and drivers listed nearest first
- Safety checks on every route after every change, warning before dispatch rather than after
- Undo, twenty steps
- Arrival time at every stop
- Miles and running cost per route

**Screening**
- Separates packages that aren't customer deliveries so they don't end up on a van
- Optional residential-only filter, since businesses are closed after hours
- Flags stops that sit far out on their own before you commit to them

**Tuning**
- Every routing constant is editable in the UI, 56 of them, sliders with typed entry

---

## Running it

Two things run side by side: a routing engine that answers "how long does it take to drive from A to B", and the app itself.

### Requirements

- Java 17 or newer
- Node.js 18 or newer
- About 8 GB of free disk space for map data and the routing graph
- 4 GB of RAM available to the routing engine

### Setup

```bash
git clone https://github.com/Alp-Usta/RouteFinder.git
cd RouteFinder
./setup.sh
```

That downloads the routing engine, downloads map data, installs dependencies, and builds the routing graph.

**The graph build takes 10 to 30 minutes the first time.** It only happens once. Everything after that starts in seconds.

Setup rewrites `config-example.yml` to point at whatever map file it actually downloaded, so you don't have to keep the filename in sync by hand. It prints the change and stops with instructions if it can't make the edit.

Delivering somewhere other than the US northeast? Pick your region from [Geofabrik](https://download.geofabrik.de/) and point setup at it:

```bash
MAP_URL="https://download.geofabrik.de/europe/great-britain-latest.osm.pbf" ./setup.sh
```

### Starting it

```bash
./start.sh
```

Then open **http://localhost:3000**. Ctrl-C stops both servers.

### If setup fails

- **"Java is missing"** — install a JDK 17+ (`brew install openjdk@17` on macOS, `apt install default-jdk` on Debian/Ubuntu)
- **Graph build runs out of memory** — raise the heap in `setup.sh` and `start.sh`, e.g. `-Xmx8g`
- **Port already in use** — the routing engine needs 8989 and the app needs 3000
- **Graph build interrupted** — delete the `graph-cache` folder and run `./setup.sh` again, otherwise it'll try to use a half-built graph
- **"file not found" naming a `.osm.pbf`** — the map filename in `config-example.yml` doesn't match the file on disk. Re-running `./setup.sh` fixes it, or set `datareader.file` by hand to match whatever `.osm.pbf` you have

### Doing it manually

If you'd rather not use the scripts, `setup.sh` is short and readable. The two commands it comes down to:

```bash
java -Xmx4g -jar graphhopper-web-*.jar server config-example.yml   # terminal 1
node server.js                                                     # terminal 2
```

---

## How it works

**Geocoding** — a local postal code database with a [Nominatim](https://nominatim.org/) fallback for anything it misses.

**Drive times** — a self-hosted [GraphHopper](https://www.graphhopper.com/) instance running OpenStreetMap data. Every stop-to-stop time is a real routed drive, not straight-line distance.

**The matrix problem.** The free GraphHopper build doesn't include a matrix endpoint, so the app builds one itself: for N stops it makes N×N individual routing requests against the local engine. For 200 postal codes that's around 40,000 requests, which sounds like a lot but runs locally in a few minutes because there's no network involved.

**Assignment** — a constructive heuristic that fills one driver at a time starting from the densest unassigned area, then improves with route merging and stop swapping between routes. A second strategy using k-medoids clustering on the drive-time matrix is available and switchable, along with a view that runs both and compares them.

**Sequencing** — 2-opt within each route. This is used internally so the time estimates and constraint checks are realistic, not because the driver needs it. Their delivery app handles the actual order on the road.

---

## Tech

- **Frontend** — HTML, CSS, vanilla JavaScript. MapLibre GL for mapping. No framework.
- **Backend** — Node.js, Express
- **Routing** — self-hosted GraphHopper, OpenStreetMap data
- **Geocoding** — local postal code DB, Nominatim fallback

No paid APIs and no API keys. An earlier build used a commercial mapping API and the bill for three days of testing was steep enough to make the point — everything here runs locally and free.

---

## Project history

Earlier branches used commercial mapping APIs before the migration to a self-hosted engine. `main` is the current version; older branches are kept for reference but aren't maintained.

---

## About this project

I work in warehouse operations, and this started because I kept watching a slow manual process and thought it could be done better.

Some things worth being clear about:

- Built entirely on my own time, on my own equipment, with my own tools
- No employer code, systems, credentials, internal documentation, or proprietary information were used
- No connection to any employer network or internal service
- No real customer data, addresses, or personal information is in this repository. Test data is either synthetic or has identifying details removed
- Not affiliated with, endorsed by, or sponsored by any delivery company
- The problem it addresses is general to last-mile logistics and is documented publicly in operations research literature. Nothing here depends on any particular company's methods

Company and product names that appear anywhere in this project are trademarks of their respective owners and are used only to describe what the software is for.

---

## License

Copyright © 2026 Alp Usta. All rights reserved. See [LICENSE](LICENSE).

You're welcome to read the code and run it locally to evaluate it or learn from it. Redistribution, modification, or commercial use needs written permission.

Provided as-is, with no warranty. If you run it, you're responsible for what you do with it and for complying with whatever rules apply where you work.
