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

        // Calculate running statistics (mean, median, standard deviation, Z-score)
        const prices = history.map(h => h.price).filter(p => typeof p === 'number' && !isNaN(p));
        const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : deal.price;
        
        const sortedPrices = [...prices].sort((a, b) => a - b);
        const mid = Math.floor(sortedPrices.length / 2);
        const medianPrice = sortedPrices.length % 2 !== 0 
            ? sortedPrices[mid] 
            : Math.round(((sortedPrices[mid - 1] + sortedPrices[mid]) / 2));

        const variance = prices.length > 1
            ? prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length
            : 0;
        const stdDev = Math.round(Math.sqrt(variance) * 10) / 10;

        // Z-Score: how many standard deviations below historical mean
        const zScore = stdDev > 0 ? Math.round(((avgPrice - deal.price) / stdDev) * 10) / 10 : 0;
        const dropPctFromAvg = avgPrice > 0 ? Math.round(((avgPrice - deal.price) / avgPrice) * 100) : 0;

        routeMeta.avgPrice = avgPrice;
        routeMeta.medianPrice = medianPrice;
        routeMeta.stdDev = stdDev;

        // Statistical Anomaly Classification
        const isStatError = zScore >= 3.0 && dropPctFromAvg >= 50 && history.length >= 3;
        const isStatGreat = zScore >= 2.0 && dropPctFromAvg >= 30 && history.length >= 2;

        // Attach comprehensive history stats to deal object
        deal.isAllTimeLow = isNewAllTimeLow || deal.price === routeMeta.allTimeLow;
        deal.zScore = zScore;
        deal.historyStats = {
            allTimeLow: routeMeta.allTimeLow,
            allTimeHigh: routeMeta.allTimeHigh,
            avgPrice,
            medianPrice,
            stdDev,
            zScore,
            dropPctFromAvg,
            isAllTimeLow: deal.isAllTimeLow,
            isStatError,
            isStatGreat,
            totalScans: routeMeta.scansCount,
            historyPointsCount: history.length,
        };
    }

    saveHistory(db);
    return crashes;
}

/**
 * Computes anomaly metrics for a given route and price against historical records
 */
export function getRouteAnomaly(origin, dest, price) {
    const db = loadHistory();
    const routeKey = `${origin}→${dest}`;
    const routeMeta = db.routes[routeKey];
    if (!routeMeta || !Array.isArray(routeMeta.history) || routeMeta.history.length < 2) {
        return null;
    }
    const prices = routeMeta.history.map(h => h.price).filter(p => typeof p === 'number' && !isNaN(p));
    if (prices.length < 2) return null;

    const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length;
    const stdDev = Math.round(Math.sqrt(variance) * 10) / 10;
    const zScore = stdDev > 0 ? Math.round(((avgPrice - price) / stdDev) * 10) / 10 : 0;
    const dropPct = avgPrice > 0 ? Math.round(((avgPrice - price) / avgPrice) * 100) : 0;

    return {
        avgPrice,
        allTimeLow: routeMeta.allTimeLow,
        stdDev,
        zScore,
        dropPct,
        isAllTimeLow: price <= (routeMeta.allTimeLow || price),
        isStatError: zScore >= 3.0 && dropPct >= 50 && prices.length >= 3,
        isStatGreat: zScore >= 2.0 && dropPct >= 30 && prices.length >= 2,
    };
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
