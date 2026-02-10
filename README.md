
<img width="1610" height="914" alt="image" src="https://github.com/user-attachments/assets/5912ad08-f1d5-4294-9aab-f3d7eb510b11" />



# 🚀 RouteFinder: A Real-World Logistics Optimizer

This isn't just a portfolio project; it's a real-world solution I built to solve a major inefficiency I faced every day at my job as an Amazon Warehouse Associate at DPH9.

## The Problem: "Leftover Packages"

At my warehouse, we'd often have hundreds of leftover packages that needed to be dispatched to flex drivers. The process was entirely manual:


This system was slow, created a major bottleneck, and was a constant source of frustration for our drivers. Manually-crafted routes are almost never balanced, leading to unfair, inefficient routes.

## The Solution: RouteFinder

I knew I could solve this. I designed and built RouteFinder, a full-stack logistics tool that automates the entire dispatch process.

  * **What it does:** It takes a raw CSV export of packages (TBA and postal code) and, for a set number of drivers, calculates the most efficient, mathematically balanced routes.
  * **The Logic:** The backend uses **K-means++ clustering** to group stops into logical regions and the **2-Opt algorithm** to solve the "Traveling Salesperson Problem" for each driver, minimizing their drive time.
  * **The Impact:** When I showed the proof-of-concept to my managers, they were impressed by its ability to cut the dispatch and routing process from a long, manual task down to a minutes-long calculation.

-----

## Technical Versions

This repository contains two complete versions of this application, each on a separate branch.

### 1\. `main` branch: The Google Maps API Version

This is the "enterprise-grade" version. It uses the **Google Maps Geocoding API** and **Distance Matrix API** to get hyper-accurate, real-world driving times based on live traffic.

  * **Pro:** Extremely fast and accurate.
  * **Con:** Prohibitively expensive at scale. To calculate routes for 800 packages, it would require a 640,000-element matrix, which is impossible on a standard or free-tier API key.

### 2\. `v4` branch: The 100% Open-Source, Self-Hosted Version

This is the version I built to solve the cost and scale problem. It's the one I use, as it has **no API limits or costs**.

  * **Pro:** 100% free. Can handle any number of packages.
  * **Con:** Requires a more complex, self-hosted setup.

To achieve this, I migrated the entire backend:

  * **Routing:** Replaced Google's API with a self-hosted **GraphHopper** server.
  * **Geocoding:** Replaced Google's API with the public **Nominatim (OpenStreetMap)** API.

#### The "Missing Matrix" Challenge

The free, open-source GraphHopper server does *not* include the premium "Matrix API." This was the biggest challenge.

**Solution:** I re-engineered the backend to build the matrix manually. For 200 zip codes, my `server.js` makes **40,401** (201x201) individual requests to the local GraphHopper server to build the travel-time matrix from scratch.

This self-hosted version is so robust, it can process a real-world scenario of **8,000 packages** across **200 unique zip codes** in **under 6 minutes**.

-----

## How to Run This Project (v4 - Open Source)

This version requires two servers to run simultaneously.

### 1\. The GraphHopper Server (Routing Engine)

You only need to do this setup once.

1.  **Download GraphHopper:** Download the `graphhopper-web-*.jar` file from the [latest release](https://github.com/graphhopper/graphhopper/releases).

2.  **Download Map Data:** Download a map file in `.osm.pbf` format (e.g., `us-northeast-latest.osm.pbf`) from [Geofabrik](https://download.geofabrik.de/).

3.  **Create `config.yml`:** Create a file named `config.yml` in the same folder. Paste the following text into it (make sure to update the `.pbf` filename):

    ```yaml
    graphhopper:
      datareader.file: "us-northeast-latest.osm.pbf"
      import.osm.ignored_highways: footway,construction,cycleway,path,steps
      profiles:
        - name: car
          weighting: fastest 
          custom_model: {} 
      prepare.ch.profiles:
        - profile: car
    server:
      application_connectors:
        - type: http
          port: 8989
      admin_connectors:
        - type: http
          port: 8990
    ```

4.  **Run the Server:** Open a terminal in that folder and run the command. This will take a long time (10-30+ minutes) the *first* time as it builds the `graph-cache`.

    ```bash
    java -jar graphhopper-web-*.jar server config.yml
    ```

    Leave this terminal running.

### 2\. The Node.js Server (This App)

1.  Clone this repository and switch to the `v4` branch:
    ```bash
    git clone 
    cd RouteFinder
    git checkout v4
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Run the server:
    ```bash
    node server.js
    ```
4.  Open `http://localhost:3000` in your browser.



