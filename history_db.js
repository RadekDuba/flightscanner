/* ═══════════════════════════════════════════════════════════
   FLIGHTSCANNER — Comprehensive Historical Price Database
   Tracks route price history, all-time lows, and price drops
   ═══════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const HISTORY_FILE = 'flight_history.json';
const MAX_HISTORY_PER_ROUTE = 100; // Keep up to 100 historical price points per route

let _historyCache = null;

function loadHistory() {
    if (!existsSync(HISTORY_FILE)) {
        return { routes: {}, lastScan: null, totalScans: 0 };
    }
    try {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
        if (!data.routes) data.routes = {};
        if (!data.totalScans) data.totalScans = 0;
        return data;
    } catch {
        return { routes: {}, lastScan: null, totalScans: 0 };
    }
}

function saveHistory(db) {
    db.lastScan = new Date().toISOString();
    db.totalScans = (db.totalScans || 0) + 1;
    writeFileSync(HISTORY_FILE, JSON.stringify(db, null, 2));
}

/**
 * Records current scan deals into comprehensive price history,
 * computes route statistics (All-Time Low, High, Avg), and detects price crashes.
 * @param {Array} deals List of deal objects from error_fare_hunter.js
 * @param {number} minDropEur Minimum drop in EUR to flag as price crash (default €30)
 * @param {number} minDropPct Minimum percentage drop to flag as price crash (default 20%)
 */
export function processHistoryAndCrashes(deals, minDropEur = 30, minDropPct = 20) {
    const db = loadHistory();
    const ts = new Date().toISOString();
    const crashes = [];

    for (const deal of deals) {
        if (!deal || !deal.origin || !deal.dest || !deal.price) continue;
        const routeKey = `${deal.origin}→${deal.dest}`;

        if (!db.routes[routeKey] || Array.isArray(db.routes[routeKey])) {
            const oldHistory = Array.isArray(db.routes[routeKey]) ? db.routes[routeKey] : [];
            const oldPrices = oldHistory.map(h => h.price).filter(Boolean);
            db.routes[routeKey] = {
                origin: deal.origin,
                dest: deal.dest,
                destName: deal.destName,
                allTimeLow: oldPrices.length > 0 ? Math.min(...oldPrices, deal.price) : deal.price,
                allTimeLowDate: deal.date,
                allTimeHigh: oldPrices.length > 0 ? Math.max(...oldPrices, deal.price) : deal.price,
                scansCount: oldHistory.length,
                history: oldHistory,
            };
        }

        const routeMeta = db.routes[routeKey];
        if (!Array.isArray(routeMeta.history)) routeMeta.history = [];
        routeMeta.scansCount = (routeMeta.scansCount || 0) + 1;

        // Check All-Time Low & High
        const isNewAllTimeLow = deal.price < routeMeta.allTimeLow;
        if (isNewAllTimeLow) {
            routeMeta.allTimeLow = deal.price;
            routeMeta.allTimeLowDate = deal.date;
        }
        if (deal.price > routeMeta.allTimeHigh) {
            routeMeta.allTimeHigh = deal.price;
        }

        const history = routeMeta.history;
        const prevPoint = history.length > 0 ? history[history.length - 1] : null;

        // Price crash check (drop from previous scan)
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

        // Record price point (avoid duplicate consecutive prices if scanned within 5 mins)
        const isDuplicate = prevPoint && prevPoint.price === deal.price &&
            (Date.now() - new Date(prevPoint.ts).getTime()) < 5 * 60 * 1000;

        if (!isDuplicate) {
            history.push({
                ts,
                price: deal.price,
                date: deal.date,
                returnDate: deal.returnDate,
                airline: deal.airline,
                tripDays: deal.tripDays,
            });
            if (history.length > MAX_HISTORY_PER_ROUTE) {
                history.shift(); // Keep bounded history size
            }
        }

        // Calculate running average price
        const prices = history.map(h => h.price);
        const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        routeMeta.avgPrice = avgPrice;

        // Attach comprehensive history stats to deal object
        deal.isAllTimeLow = isNewAllTimeLow || deal.price === routeMeta.allTimeLow;
        deal.historyStats = {
            allTimeLow: routeMeta.allTimeLow,
            allTimeHigh: routeMeta.allTimeHigh,
            avgPrice,
            totalScans: routeMeta.scansCount,
            historyPointsCount: history.length,
        };
    }

    saveHistory(db);
    return crashes;
}

/**
 * Returns historical price points & metadata for a specific route
 */
export function getRoutePriceHistory(origin, dest) {
    const db = loadHistory();
    const routeKey = `${origin}→${dest}`;
    return db.routes[routeKey] || null;
}

/**
 * Returns all recorded routes with price history summary
 */
export function getAllRouteHistories() {
    const db = loadHistory();
    return db.routes;
}
