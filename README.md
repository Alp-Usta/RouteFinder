# **🚀 RouteFinder: Logistics Optimization Tool (V2)**

**An attempt to solve station dispatch challenges.**

This application attempts to improve the dispatch process for leftover packages by replacing subjective, inefficient manual routing with accurate, data-driven optimization.

## **The Attempt**

This project directly addresses three major issues impacting the DPH9 station:

1. **Inefficient Dispatch Bottleneck:** Tries to fix the delays caused by manually sorting and grouping packages.  
2. **Flex Driver Fairness:**Attempts to fix unbalanced, hand-created routes with **impartial, data-driven assignments**, directly addressing driver complaints.  
3. **The 'Philadelphia Problem' (Geo-Fragmentation):** The manual process failes to logically segment large metro areas and extremly time consuming to sort. RouteFinder uses **state-based clustering** to fix this issue.

## **✨ Key Technical Achievements**

| Feature | Description | Value |
| :---- | :---- | :---- |
| **Hybrid Clustering** | Uses **State Bucketing** combined with the **K-means++ Algorithm** to create high-quality routes that respect logical boundaries (e.g., PA vs. NJ). | Ensures efficient, logical routes by eliminating cross-state/cross-region travel. |
| **Real-Time Optimization** | All routing decisions are based on **real-world driving time** data (not straight-line distance) fetched via the Google Distance Matrix API. | Ensures the planned route time (e.g., **1 HR 15 MIN**) is accurate and reliable for workload planning. |
| **Path Optimization (2-Opt)** | Sequences stops within each route using real-time driving data (Traveling Salesperson Problem heuristic). | Minimizes wasted travel time and vehicle mileage. |
| **Cost Efficiency** | Implements automated **deduplication** of package locations and uses API batching (10x10) to minimize Google Maps service costs. | Makes the solution scalable and cost-effective for operational use. |

## **🛠️ Technology Stack**

| Component | Technology | Role |
| :---- | :---- | :---- |
| **User Interface** | HTML/CSS/JavaScript | Interactive dark-mode UI (Spotify-inspired) for input and map visualization. |
| **Server** | Node.js (Express) | High-speed, robust server handling complex API calls and routing computations. |
| **Data Engine** | Google Maps APIs | Provides GPS coordinates and the essential **Distance Matrix** (real-world driving time). |
| **Core Logic** | K-means++ & 2-Opt | The core algorithms for clustering and sequencing stops. |

## **💻 Running Locally**

### **Prerequisites**

1. Node.js installed.  
2. A Google Cloud Project with the **Geocoding API** and **Distance Matrix API** enabled.  
3. Your Google Maps API Key.

### **Setup**

1. Save the provided Node.js code as server.js and the HTML code as public/index.html.  
2. In server.js, replace 'YOUR\_GOOGLE\_MAPS\_API\_KEY' with your actual key.  
3. Install dependencies:  
   npm install express axios

4. Start the server:  
   node server.js

5. Open your browser to http://localhost:3000.
