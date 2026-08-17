# 🔥 FlightScanner v3.6 — Global Flight Intelligence & Error Fare Hunter

[![Live Demo](https://img.shields.io/badge/Live_Demo-GitHub_Pages-brightgreen?style=for-the-badge&logo=github)](https://radekduba.github.io/flightscanner/)
[![Node.js](https://img.shields.io/badge/Node.js-v22_LTS-green?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)
[![GitHub Actions](https://img.shields.io/badge/Automated_Scan-Hourly-orange?style=for-the-badge&logo=githubactions)](.github/workflows/deploy.yml)

**FlightScanner v3.6** is an enterprise-grade, real-time flight deal intelligence and error fare detection platform. Designed with a **Tactical Glassmorphism HUD** and an interactive **3D MapTiler Vector Globe**, it automatically scouts, scores, cross-verifies, and visualizes 100% direct flights from Central European hubs to destinations worldwide.

🔗 **Live Application**: [https://radekduba.github.io/flightscanner/](https://radekduba.github.io/flightscanner/)

---

## 🚀 Key Features

* **🧠 Smart Insights & Live Header**: Top control bar featuring quick preset chips (🔥 Error Fares, 💰 Under €50, ✈️ Direct Only, 🏖️ Weekend Trips, ↺ Reset All) and live route counters.
* **⚡ 90-Day Date-Window Chunking**: Divides the 90-day booking horizon into 3 distinct 30-day windows requesting up to 1,000 direct flight offers per airport per window, ensuring **100% complete direct flight coverage** out of Czech airports (PRG, BRQ, OSR, PED, KLV, JCL) and Central European hubs (VIE, BTS, KTW).
* **🗺️ 3D MapTiler Vector Globe**: Interactive 3D canvas featuring curved flight paths, pulsing destination nodes, interactive hover popups, and atmospheric fog.
* **🎯 Unified Bi-Directional Sync**:
  * **Card Hover/Click**: Highlights the route on the 3D globe and opens the route detail drawer.
  * **Map Pin / Arc Click**: Highlights the matching route, smooth-pans the camera, and displays all available dates and historical trends.
* **📊 Dynamic Market Baselines**: Calculates route medians across sample dates over a 6-month window to distinguish genuine price anomalies from standard low-cost carrier (LCC) pricing.
* **📉 Interactive SVG Price Trends**: High-precision price history chart with cubic Bézier curves, gradient area fill, market baseline comparisons, crosshairs, and price crash alerts.
* **🔍 Live Duffel NDC Verification**: Cross-checks flagged error fares directly against Duffel's live airline API to confirm ticket availability before alerting.
* **📲 Multi-Provider Direct Booking & Sharing**: Direct links to Airline Websites, Skyscanner, Google Flights, and Kiwi, plus 1-click deal sharing to clipboard.
* **📲 Automated Alerts**: Telegram bot integration (`notify_bot.js`) for instant notifications on verified error fares.

---

## ✈️ Supported Origin Hubs

| Airport | Code | Location | Coverage Strategy |
| :--- | :---: | :--- | :--- |
| **Prague Airport** | `PRG` | Czech Republic | Exhaustive 90d window scan (~120 direct destinations) |
| **Brno–Tuřany Airport** | `BRQ` | Czech Republic | Complete direct route coverage (Ryanair, Smartwings, charters) |
| **Ostrava Airport** | `OSR` | Czech Republic | Complete direct route coverage (LOT, Ryanair, Smartwings) |
| **Pardubice Airport** | `PED` | Czech Republic | Complete direct route coverage (Ryanair, seasonal charters) |
| **Karlovy Vary Airport** | `KLV` | Czech Republic | Complete direct route coverage (International & seasonal flights) |
| **České Budějovice Airport** | `JCL` | Czech Republic | Complete direct route coverage (South Bohemia charter/leisure) |
| **Vienna International** | `VIE` | Austria | Exhaustive 90d window scan (~190 direct destinations) |
| **Katowice Airport** | `KTW` | Poland | Exhaustive 90d window scan (Wizz Air / Ryanair Base) |
| **Bratislava Airport** | `BTS` | Slovakia | Complete direct route coverage |

---

## 🛠️ Architecture & Data Pipeline

```mermaid
flowchart TD
    A[Kiwi Tequila API] -->|90-Day Window Chunking max 1000/window| B[Kiwi Scout Engine]
    B --> C{Dynamic Baseline Calculator}
    C -->|Median Calculation 20 Samples| D[Smart Scoring Engine]
    D -->|Error Fare >=70% / Great Deal >=50%| E[Duffel Live NDC Verification]
    E --> F[error_fares_report.json]
    F --> G[Tactical Glassmorphism UI index.html]
    F --> H[Telegram Notification Bot]
```

1. **Scout Phase**: Runs 90-day chunked queries (`max_stopovers=0`) across origin hubs to capture all non-stop direct flights.
2. **Scoring Phase**: Computes route-specific market medians to score deals (`ERROR FARE`, `GREAT DEAL`, `GOOD DEAL`, `NORMAL`).
3. **Verification Phase**: Queries Duffel NDC endpoints for live pricing confirmation.
4. **Publishing & UI**: Deploys updated reports to GitHub Pages and broadcasts high-priority alerts to Telegram.

---

## 📁 Repository Structure

```
flightscanner/
├── index.html                 # Tactical Glassmorphism Single-Page App (MapTiler SDK v4.0.2 + MapLibre GL JS)
├── error_fare_hunter.js       # Core hunter script (Scout + Score + Verify pipeline)
├── scan_keys.js               # Health checker and key validator for API pools
├── flight_search.js           # Multi-provider client (Duffel LIVE + Kiwi + SerpAPI)
├── history_db.js              # Historical price drop tracker & price crash detection
├── combo_scanner.js           # Hub-and-spoke self-transfer combo generator
├── notify_bot.js              # Telegram alert dispatcher with HTML entity escaping
├── server.js                  # Hardened local preview & API server
├── sw.js                      # Progressive Web App Service Worker (v3.6 offline cache)
├── error_fares_report.json    # Published deal dataset (updated hourly)
└── .github/workflows/
    ├── deploy.yml             # Hourly GitHub Actions build, scan & Pages deploy pipeline
    └── scan-keys.yml          # Daily API key maintenance workflow
```

---

## 💻 Local Setup & Development

### Prerequisites
* **Node.js**: v22 LTS or higher
* **npm**: v10+

### Installation

```bash
# Clone repository
git clone https://github.com/RadekDuba/flightscanner.git
cd flightscanner

# Install dependencies (if any)
npm install
```

### Running Scans Locally

```bash
# Verify API keys
npm run scan

# Run single route flight search (e.g. PRG to BCN on 2026-09-15)
npm run search -- PRG BCN 2026-09-15

# Run full error fare hunter scan
npm run hunt

# Run scan with fresh baseline cache
npm run hunt:fresh
```

### Serving the Dashboard Locally

```bash
# Start local preview server with API endpoints
npm run map
```
Then navigate to `http://localhost:3000` in your browser.

---

## 📜 License

Distributed under the **MIT License**. See `LICENSE` for details.
