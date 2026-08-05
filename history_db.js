/* ═══════════════════════════════════════════════════════════
   FLIGHTSCANNER — Historical Price Crash Tracking Database
   Tracks route price history and identifies sudden price drops
   ═══════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const HISTORY_FILE = 'flight_history.json';
const MAX_HISTORY_PER_ROUTE = 50; // Keep up to 50 price points per route

let _historyCache = null;

function loadHistory() {
    if (!existsSync(HISTORY_FILE)) {
        return { routes: {}, lastScan: null };
    }
    try {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
        if (!data.routes) data.routes = {};
        return data;
    } catch {
        return { routes: {}, lastScan: null };
    }
}

function saveHistory() {
    if (!_historyCache) return;
    _historyCache.lastScan = new Date().toISOString();
    writeFileSync(HISTORY_FILE, JSON.stringify(_historyCache, null, 2));
}

/**
 * Records current scan deals into price history and tags price crashes
 * @param {Array} deals List of deal objects from error_fare_hunter.js
 * @param {number} minDropEur Minimum drop in EUR to flag as price crash (default €30)
 * @param {number} minDropPct Minimum percentage drop to flag as price crash (default 25%)
 */
export function processHistoryAndCrashes(deals, minDropEur = 30, minDropPct = 20) {
    const db = loadHistory();
    const ts = new Date().toISOString();
    const crashes = [];

    for (const deal of deals) {
        if (!deal || !deal.origin || !deal.dest || !deal.price) continue;
        const routeKey = `${deal.origin}→${deal.dest}`;

        if (!db.routes[routeKey]) {
            db.routes[routeKey] = [];
        }

        const history = db.routes[routeKey];
        const prevPoint = history.length > 0 ? history[history.length - 1] : null;

        // Price crash check
        if (prevPoint && prevPoint.price > deal.price) {
            const dropEur = Math.round((prevPoint.price - deal.price) * 100) / 100;
            const dropPct = Math.round((dropEur / prevPoint.price) * 100);

            if (dropEur >= minDropEur && dropPct >= minDropPct) {
                deal.priceCrash = {
                    previousPrice: prevPoint.price,
                    previousTs: prevPoint.ts,
                    dropEur,
                    dropPct,
                };
                crashes.push(deal);
            }
        }

        // Record new price point (avoid duplicate consecutive prices if scanned within 5 mins)
        const isDuplicate = prevPoint && prevPoint.price === deal.price &&
            (Date.now() - new Date(prevPoint.ts).getTime()) < 5 * 60 * 1000;

        if (!isDuplicate) {
            history.push({ ts, price: deal.price, date: deal.date, returnDate: deal.returnDate });
            if (history.length > MAX_HISTORY_PER_ROUTE) {
                history.shift(); // Keep bounded history size
            }
        }
    }

    saveHistory();
    return crashes;
}

/**
 * Returns historical price points for a specific route
 */
export function getRoutePriceHistory(origin, dest) {
    const db = loadHistory();
    const routeKey = `${origin}→${dest}`;
    return db.routes[routeKey] || [];
}

/**
 * Returns all recorded routes with price history summary
 */
export function getAllRouteHistories() {
    const db = loadHistory();
    return db.routes;
}
