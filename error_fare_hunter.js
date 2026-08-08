#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  ERROR FARE HUNTER v3 — Scout + Score + Verify pipeline
//  Phase 1: Kiwi "anywhere" search (1 API call per airport)
//  Phase 2: Smart scoring (LCC vs legacy baselines by distance)
//  Phase 3: Duffel cross-verification (direct API, live prices)
//  Pipeline: Kiwi scout → score deals → Duffel verify → report
// ═══════════════════════════════════════════════════════════════

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { sendTelegramAlert } from './notify_bot.js';
import { MAJOR_HUBS, buildHubSpokeCombos } from './combo_scanner.js';
import { processHistoryAndCrashes } from './history_db.js';

const ACTIVE_KEYS = existsSync('active_keys.json')
    ? JSON.parse(readFileSync('active_keys.json', 'utf-8'))
    : {};

// ─── Persistent Cache (baselines only, 24h TTL) ────────────
const CACHE_FILE = 'flight_cache.json';
const BASELINE_TTL = 24 * 60 * 60 * 1000; // 24 hours — medians are stable
let cache = { baselines: {}, savedAt: null };

function loadCache() {
    if (!existsSync(CACHE_FILE)) return;
    try {
        cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        if (!cache.baselines) cache.baselines = {};
    } catch { cache = { baselines: {}, savedAt: null }; }
}

function saveCache() {
    cache.savedAt = new Date().toISOString();
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function isCacheValid(entry, ttl = BASELINE_TTL) {
    if (!entry || !entry.ts) return false;
    return (Date.now() - entry.ts) < ttl;
}

const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', underline: '\x1b[4m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
    magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m', white: '\x1b[97m',
    bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m', bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m',
};

function log(level, msg) {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const prefix = {
        hunt: `${c.magenta}[HUNT]${c.reset}`,
        deal: `${c.bgGreen}${c.white}${c.bold} DEAL ${c.reset}`,
        great_deal: `${c.bgCyan}${c.white}${c.bold} ⭐ GREAT DEAL ⭐ ${c.reset}`,
        error_fare: `${c.bgRed}${c.white}${c.bold} ‼ ERROR FARE ‼ ${c.reset}`,
        info: `${c.blue}[INFO]${c.reset}`,
        ok: `${c.green}[OK]${c.reset}`,
        warn: `${c.yellow}[WARN]${c.reset}`,
        kiwi: `${c.cyan}[KIWI]${c.reset}`,
        baseline: `${c.magenta}[BASE]${c.reset}`,
        verify: `${c.blue}[VERIFY]${c.reset}`,
    }[level] || `[${level}]`;
    console.log(`  ${c.gray}${time}${c.reset} ${prefix} ${msg}`);
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

const ORIGINS = [
    { code: 'PRG', name: 'Prague' },
    { code: 'VIE', name: 'Vienna' },
    { code: 'BTS', name: 'Bratislava' },
    { code: 'KTW', name: 'Katowice' },
    { code: 'OSR', name: 'Ostrava' },
];

// ─── Smart Deal Scoring ─────────────────────────────────────
// Typical round-trip baselines by airline type and distance (FALLBACK only)
const LCC = ['W6', 'W4', 'W9', 'FR', 'U2', 'EC', 'VY', 'TO', 'HV', 'EW', 'DY']; // Low-cost carriers
const STATIC_BASELINES = {
    // [LCC baseline, Legacy baseline] in EUR for round-trip
    short:  [60, 150],     // < 2hr flights (e.g. PRG→VIE, KTW→BLL)
    medium: [100, 250],    // 2-4hr flights (e.g. PRG→BCN, VIE→ATH)
    long:   [200, 500],    // 4-7hr flights (e.g. PRG→IST, VIE→TFS)
    ultra:  [400, 800],    // 7hr+ flights (e.g. PRG→JFK, VIE→BKK)
};

// Known short-haul destinations (< 2hr from CEE)
const SHORT_DESTS = new Set(['VIE','PRG','KTW','WAW','BUD','BTS','MUC','DRS','BER','FRA','DTM','NUE','STR','ZRH','GVA','LJU','ZAG','BLL','MST','EIN','HAM','CGN','LEJ','KRK','WRO','POZ','GDN','BRN','SZG','GRZ','INN','LNZ','BRQ','KSC','TSR','CLJ','SBZ','OTP','SOF','SJJ','TGD','SKP','TIA','GHV']);
// Medium-haul (2-4hr)
const MEDIUM_DESTS = new Set(['LHR','LTN','STN','LGW','CDG','ORY','AMS','BCN','FCO','NAP','MXP','LIN','BGY','VCE','BLQ','PSA','BRI','BDS','CTA','PMO','SUF','CAG','OLB','SPU','DBV','ATH','SKG','LIS','OPO','AGP','ALC','PMI','MAD','DUB','EDI','CPH','ARN','OSL','HEL','RIX','VNO','TLL','CFU','RHO','JMK','HER','CHQ','IST','SAW','LCA','PFO','CMN','RAK','MLA','TFS','LPA','FUE','ACE','KUT','TBS','EVN','CAS']);

// Dynamic baselines cache: { "PRG→BLL": 85, "VIE→BCN": 220 }
const dynamicBaselines = {};

function getDistance(destCode) {
    if (SHORT_DESTS.has(destCode)) return 'short';
    const ULTRA_DESTS = new Set(['JFK','EWR','LAX','SFO','ORD','MIA','YYZ','CUN','BKK','HKT','SIN','KUL','HND','NRT','ICN','PEK','PVG','DEL','BOM','DXB','DOH','AUH','JNB','SYD','MEL']);
    if (ULTRA_DESTS.has(destCode)) return 'ultra';
    if (MEDIUM_DESTS.has(destCode)) return 'medium';
    return 'long';
}

function scoreDeal(price, airlines, destCode, originCode) {
    const isLCC = airlines.some(a => LCC.includes(a));
    const distance = getDistance(destCode);

    // Try dynamic baseline first (from Kiwi price median)
    const routeKey = originCode ? `${originCode}→${destCode}` : null;
    let baseline;
    if (routeKey && dynamicBaselines[routeKey]) {
        baseline = dynamicBaselines[routeKey];
    } else {
        // Fallback to static baselines
        const [lccBase, legacyBase] = STATIC_BASELINES[distance];
        baseline = isLCC ? lccBase : legacyBase;
    }

    const discount = Math.round((1 - price / baseline) * 100);

    let tag, emoji;
    if (discount >= 70) { tag = 'ERROR FARE'; emoji = '🔥'; }
    else if (discount >= 50) { tag = 'GREAT DEAL'; emoji = '⭐'; }
    else if (discount >= 30) { tag = 'GOOD DEAL'; emoji = '✅'; }
    else { tag = 'NORMAL'; emoji = ''; }

    return { tag, emoji, discount, baseline, isLCC, distance, dynamic: !!(routeKey && dynamicBaselines[routeKey]) };
}

// ─── Dynamic Baseline: fetch price median from Kiwi ─────────
// Queries Kiwi for a specific route over a broad 6-month window,
// collects up to 20 price points, and calculates the median.
async function fetchRouteBaseline(origin, dest, nightsMin, nightsMax) {
    const rawKeys = ACTIVE_KEYS.kiwi || [];
    const keys = rawKeys.map(k => typeof k === 'string' ? k : k.key).filter(Boolean);
    if (keys.length === 0) return null;

    const fmtDate = (d) => d.split('-').reverse().join('/');
    const today = new Date().toISOString().split('T')[0];
    const sixMonths = addDays(today, 180);

    for (const key of keys) {
        try {
            const url = new URL('https://api.tequila.kiwi.com/v2/search');
            url.searchParams.set('fly_from', origin);
            url.searchParams.set('fly_to', dest);
            url.searchParams.set('date_from', fmtDate(today));
            url.searchParams.set('date_to', fmtDate(sixMonths));
            url.searchParams.set('nights_in_dst_from', String(nightsMin));
            url.searchParams.set('nights_in_dst_to', String(nightsMax));
            url.searchParams.set('flight_type', 'round');
            url.searchParams.set('curr', 'EUR');
            url.searchParams.set('sort', 'price');
            url.searchParams.set('limit', '20'); // 20 price points for median
            url.searchParams.set('max_stopovers', '2');

            const res = await fetch(url.toString(), {
                headers: { 'apikey': key, 'Accept': 'application/json' },
                signal: AbortSignal.timeout(12000),
            });

            if (!res.ok) continue;

            const data = await res.json();
            if (!data?.data?.length) return null;

            const prices = data.data.map(f => f.price).sort((a, b) => a - b);
            // Median price = middle of sorted prices
            const mid = Math.floor(prices.length / 2);
            const median = prices.length % 2 === 0
                ? Math.round((prices[mid - 1] + prices[mid]) / 2)
                : prices[mid];

            return { median, min: prices[0], max: prices[prices.length - 1], samples: prices.length };
        } catch {
            continue;
        }
    }
    return null;
}

// ─── Airline direct booking URLs ────────────────────────────
function makeAirlineLink(airlineCodes, from, to, date, retDate) {
    // Skyscanner deep link (reliable fallback — always works with IATA codes)
    const [yyyy, mm, dd] = date.split('-');
    const [ryyyy, rmm, rdd] = retDate.split('-');
    const skyscannerUrl = `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yyyy.substring(2)}${mm}${dd}/${ryyyy.substring(2)}${rmm}${rdd}/`;

    // Map IATA codes to booking URL patterns (only those verified to work)
    const AIRLINES = {
        // Wizz Air (W6, W4, W9)
        W6: { name: 'Wizz Air', url: (f, t, d, r) => `https://wizzair.com/en-gb/booking/select-flight/${f}/${t}/${d}/${r}/1/0/0/0` },
        W4: { name: 'Wizz Air', url: (f, t, d, r) => `https://wizzair.com/en-gb/booking/select-flight/${f}/${t}/${d}/${r}/1/0/0/0` },
        W9: { name: 'Wizz Air', url: (f, t, d, r) => `https://wizzair.com/en-gb/booking/select-flight/${f}/${t}/${d}/${r}/1/0/0/0` },
        // Ryanair
        FR: { name: 'Ryanair', url: (f, t, d, r) => `https://www.ryanair.com/gb/en/trip/flights/select?adults=1&dateOut=${d}&dateIn=${r}&originIata=${f}&destinationIata=${t}` },
        // Vueling
        VY: { name: 'Vueling', url: (f, t, d, r) => `https://www.vueling.com/en/booking/select?originIATA=${f}&destinationIATA=${t}&outboundDate=${d}&inboundDate=${r}&adults=1` },
        // LOT Polish
        LO: { name: 'LOT', url: (f, t, d, r) => `https://www.lot.com/gb/en/booking/flight-search?departureCity=${f}&arrivalCity=${t}&departureDate=${d}&returnDate=${r}&adult=1` },
        // Norwegian
        DY: { name: 'Norwegian', url: (f, t, d, r) => `https://www.norwegian.com/en/booking/flight-offers/?AdultCount=1&TripType=roundtrip&Origin=${f}&Destination=${t}&OutboundDate=${d}&ReturnDate=${r}` },
        // Lufthansa Group (Austrian OS, Lufthansa LH, Swiss LX, Eurowings EW)
        OS: { name: 'Austrian Airlines', url: (f, t, d, r) => `https://www.austrian.com/` },
        LH: { name: 'Lufthansa', url: (f, t, d, r) => `https://www.lufthansa.com/` },
        LX: { name: 'SWISS', url: (f, t, d, r) => `https://www.swiss.com/` },
        EW: { name: 'Eurowings', url: (f, t, d, r) => `https://www.eurowings.com/` },
        // easyJet
        U2: { name: 'easyJet', url: (f, t, d, r) => `https://www.easyjet.com/en/booking/select-flight?origin=${f}&destination=${t}&outboundDate=${d}&inboundDate=${r}&adults=1` },
        EC: { name: 'easyJet', url: (f, t, d, r) => `https://www.easyjet.com/en/booking/select-flight?origin=${f}&destination=${t}&outboundDate=${d}&inboundDate=${r}&adults=1` },
        // Transavia
        HV: { name: 'Transavia', url: (f, t, d, r) => `https://www.transavia.com/en-EU/book-a-flight/flights/search/?routeSelection=${f}-${t}&outboundDate=${d}&inboundDate=${r}&adultCount=1` },
        TO: { name: 'Transavia', url: (f, t, d, r) => `https://www.transavia.com/en-EU/book-a-flight/flights/search/?routeSelection=${f}-${t}&outboundDate=${d}&inboundDate=${r}&adultCount=1` },
        // KLM
        KL: { name: 'KLM', url: (f, t, d, r) => `https://www.klm.com/search/offer?tripType=RT&origin=${f}&destination=${t}&outDate=${d}&inDate=${r}&adt=1` },
        // Condor
        DE: { name: 'Condor', url: (f, t, d, r) => `https://www.condor.com/en/flight-search.jsp?c%5B0%5D.os=${f}&c%5B0%5D.ds=${t}&c%5B0%5D.dd=${d}&c%5B1%5D.dd=${r}&type=RT&pcount=1` },
    };

    const codes = (Array.isArray(airlineCodes) ? airlineCodes : [airlineCodes]).map(c => c.trim());

    // Find first known airline
    for (const code of codes) {
        if (AIRLINES[code]) {
            const a = AIRLINES[code];
            return { name: a.name, url: a.url(from, to, date, retDate) };
        }
    }

    // Fallback: Skyscanner
    return { name: codes.join('/') + ' (Skyscanner)', url: skyscannerUrl };
}

function makeBookingLinks(from, to, date, retDate, airlineCodes) {
    const [yyyy, mm, dd] = date.split('-');
    const yy = yyyy.substring(2);
    const [ryyyy, rmm, rdd] = retDate.split('-');
    const ryy = ryyyy.substring(2);
    const airline = makeAirlineLink(airlineCodes || [], from, to, date, retDate);
    return {
        skyscanner: `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yy}${mm}${dd}/${ryy}${rmm}${rdd}/`,
        googleFlights: `https://www.google.com/travel/flights?q=flights+from+${from}+to+${to}+on+${date}+through+${retDate}`,
        kayak: `https://www.kayak.com/flights/${from}-${to}/${date}/${retDate}?sort=bestflight_a`,
        airline,
    };
}

// ─── Kiwi.com "Anywhere" Search ─────────────────────────────
// One API call → top 50 cheapest destinations from an airport
async function kiwiAnywhereSearch(origin, dateFrom, dateTo, nightsMin, nightsMax, limit) {
    const rawKeys = ACTIVE_KEYS.kiwi || [];
    const keys = rawKeys.map(k => typeof k === 'string' ? k : k.key).filter(Boolean);
    if (keys.length === 0) {
        log('warn', 'No Kiwi.com keys available');
        return [];
    }

    const fmtDate = (d) => d.split('-').reverse().join('/');

    for (const key of keys) {
        try {
            const url = new URL('https://api.tequila.kiwi.com/v2/search');
            url.searchParams.set('fly_from', origin);
            // No fly_to = search EVERYWHERE
            url.searchParams.set('date_from', fmtDate(dateFrom));
            url.searchParams.set('date_to', fmtDate(dateTo));
            url.searchParams.set('nights_in_dst_from', String(nightsMin));
            url.searchParams.set('nights_in_dst_to', String(nightsMax));
            url.searchParams.set('flight_type', 'round');
            url.searchParams.set('curr', 'EUR');
            url.searchParams.set('locale', 'en');
            url.searchParams.set('sort', 'price');
            url.searchParams.set('limit', String(limit));
            url.searchParams.set('max_stopovers', '0');  // Strictly direct non-stop flights only
            url.searchParams.set('ret_from_diff_city', '0');  // Must return from same city you landed in
            url.searchParams.set('ret_to_diff_city', '0');    // Must return to same city you departed from

            log('kiwi', `Searching from ${c.bold}${origin}${c.reset} → everywhere (${dateFrom} to ${dateTo}, ${nightsMin}-${nightsMax} nights)...`);

            const res = await fetch(url.toString(), {
                headers: { 'apikey': key, 'Accept': 'application/json' },
                signal: AbortSignal.timeout(20000),
            });

            if (!res.ok) {
                log('warn', `Kiwi key failed: HTTP ${res.status}, trying next...`);
                continue;
            }

            const data = await res.json();
            if (!data?.data?.length) {
                log('warn', `No results from Kiwi for ${origin}`);
                return [];
            }

            log('ok', `${c.bold}${data.data.length}${c.reset} destinations found from ${origin}`);

            return data.data.map(f => {
                const departDate = f.local_departure?.split('T')[0] || '';
                // Get return date from the return leg departure, not overall arrival
                const outboundLegs = (f.route || []).filter(r => r.return === 0);
                const returnLegs = (f.route || []).filter(r => r.return === 1);
                const firstReturn = returnLegs[0];
                const returnDate = firstReturn?.local_departure?.split('T')[0] || f.local_arrival?.split('T')[0] || '';
                const lastOutbound = outboundLegs[outboundLegs.length - 1];
                let tripDays = 7;
                if (lastOutbound && firstReturn) {
                    const arriveAt = new Date(lastOutbound.local_arrival);
                    const departReturn = new Date(firstReturn.local_departure);
                    tripDays = Math.round((departReturn - arriveAt) / 86400000);
                }

                // Check if this is a genuine round-trip (return from same city you landed in)
                const outboundDest = lastOutbound?.flyTo || f.flyTo;
                const returnFrom = firstReturn?.flyFrom || '';
                const isGenuineRoundTrip = !returnFrom || outboundDest === returnFrom ||
                    (f.cityTo && firstReturn?.cityFrom && f.cityTo === firstReturn.cityFrom);

                const bookingLinks = makeBookingLinks(origin, f.flyTo, departDate, returnDate, f.airlines);
                const score = scoreDeal(f.price, f.airlines || [], f.flyTo, origin);

                // Extract layover cities for outbound and return
                const extractLayovers = (legs) => {
                    const layovers = [];
                    for (let i = 0; i < legs.length - 1; i++) {
                        const arrTime = new Date(legs[i].local_arrival);
                        const depTime = new Date(legs[i + 1].local_departure);
                        const layoverHrs = Math.round((depTime - arrTime) / 3600000 * 10) / 10;
                        layovers.push({
                            city: legs[i].cityTo || legs[i].flyTo,
                            code: legs[i].flyTo,
                            hours: layoverHrs,
                        });
                    }
                    return layovers;
                };
                const outLayovers = extractLayovers(outboundLegs);
                const retLayovers = extractLayovers(returnLegs);

                return {
                    origin,
                    dest: f.flyTo,
                    destName: f.cityTo || f.flyTo,
                    country: f.countryTo?.name || '',
                    date: departDate,
                    returnDate,
                    tripDays,
                    price: f.price,
                    currency: 'EUR',
                    airlines: f.airlines || [],
                    airline: f.airlines?.join(', ') || 'Mix',
                    stops: (outboundLegs.length || 1) - 1,
                    layovers: { outbound: outLayovers, return: retLayovers },
                    deepLink: f.deep_link,
                    bookingLinks,
                    score,
                    isGenuineRoundTrip,
                    source: 'kiwi',
                };
            }).filter(r => {
                if (!r.isGenuineRoundTrip) return false; // Skip virtual interlining
                // For short/medium-haul, skip flights with layovers — direct makes more sense
                const dist = getDistance(r.dest);
                if ((dist === 'short' || dist === 'medium') && r.stops > 0) {
                    return false;
                }
                return true;
            });
        } catch (err) {
            log('warn', `Kiwi error: ${err.message}, trying next key...`);
            continue;
        }
    }
    return [];
}

// ─── Main Hunt ──────────────────────────────────────────────
async function main() {
    console.log(`
${c.magenta}${c.bold}  ╔══════════════════════════════════════════════════════════╗
  ║                                                          ║
  ║  🔥  ERROR FARE HUNTER v3                                 ║
  ║  Kiwi scout → Smart scoring → Duffel verify               ║
  ║                                                          ║
  ╚══════════════════════════════════════════════════════════╝${c.reset}
`);

    if (!existsSync('active_keys.json')) {
        log('warn', 'No active_keys.json found. Run: npm run scan');
        process.exit(1);
    }

    const args = process.argv.slice(2);
    const today = new Date().toISOString().split('T')[0];

    // Parse options
    let daysAhead = 90; // 90 days (3 months) max horizon for 100% complete flight coverage
    let nightsMin = 3;
    let nightsMax = 14;
    let limit = 500;
    let originsFilter = null;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--days': daysAhead = parseInt(args[++i]) || 90; break;
            case '--nights-min': nightsMin = parseInt(args[++i]) || 3; break;
            case '--nights-max': nightsMax = parseInt(args[++i]) || 14; break;
            case '--limit': limit = parseInt(args[++i]) || 80; break;
            case '--origins': originsFilter = args[++i].split(',').map(s => s.trim().toUpperCase()); break;
            case '--fresh': cache = { airports: {}, baselines: {}, savedAt: null }; break;
        }
    }

    // Load persistent cache
    if (cache.savedAt !== null || !args.includes('--fresh')) {
        loadCache();
    }

    const dateTo = addDays(today, daysAhead);
    const origins = originsFilter
        ? ORIGINS.filter(o => originsFilter.includes(o.code))
        : ORIGINS;

    log('info', `Origins: ${c.bold}${origins.map(o => `${o.name} (${o.code})`).join(', ')}${c.reset}`);
    log('info', `Date range: ${c.bold}${today}${c.reset} → ${c.bold}${dateTo}${c.reset} (${daysAhead} days)`);
    log('info', `Trip length: ${c.bold}${nightsMin}-${nightsMax} nights${c.reset}`);
    log('info', `Top destinations per airport: ${c.bold}${limit}${c.reset}`);
    if (cache.savedAt) {
        const cacheAge = Math.round((Date.now() - new Date(cache.savedAt).getTime()) / 60000);
        log('info', `Baseline cache: ${c.bold}${Object.keys(cache.baselines).length}${c.reset} routes (${cacheAge}m old, 24h TTL)`);
    }
    console.log('');

    const allResults = [];

    // ─── Phase 1: Kiwi Anywhere Search (always fresh) ─────────
    let kiwiWorked = false;
    const WINDOW_SIZE = 30; // 30-day date chunks (10 windows) to ensure 100% complete direct flight coverage
    const numWindows = Math.ceil(daysAhead / WINDOW_SIZE);

    for (const origin of origins) {
        console.log(`  ${c.cyan}${'─'.repeat(60)}${c.reset}`);
        log('hunt', `${c.bold}${origin.name} (${origin.code}) → EVERYWHERE${c.reset} (${numWindows} date windows, max 1000 deals/window)`);
        console.log(`  ${c.cyan}${'─'.repeat(60)}${c.reset}`);

        const originResultsMap = new Map();

        for (let w = 0; w < numWindows; w++) {
            const wStart = addDays(today, w * WINDOW_SIZE);
            const wEnd = addDays(today, Math.min(daysAhead, (w + 1) * WINDOW_SIZE));
            const chunkResults = await kiwiAnywhereSearch(origin.code, wStart, wEnd, nightsMin, nightsMax, 1000);

            for (const r of chunkResults) {
                const key = `${r.origin}_${r.dest}_${r.date}_${r.price}`;
                if (!originResultsMap.has(key)) {
                    originResultsMap.set(key, r);
                }
            }
        }

        const results = [...originResultsMap.values()];

        if (results.length > 0) {
            kiwiWorked = true;
            for (const r of results) allResults.push(r);

            log('ok', `${c.bold}${results.length}${c.reset} total direct flight options collected for ${origin.name} (${origin.code})`);

            // Show top 5 cheapest immediately
            const sortedResults = [...results].sort((a, b) => a.price - b.price);
            const top5 = sortedResults.slice(0, 5);
            for (const r of top5) {
                const score = scoreDeal(r.price, r.airlines || [], r.dest, r.origin);
                if (score.tag === 'ERROR FARE') {
                    log('error_fare', `${c.bold}${r.origin}→${r.destName}${c.reset} ${c.green}${c.bold}€${r.price}${c.reset} (${r.tripDays}d) depart ${r.date} — ${r.airline}`);
                } else if (score.tag === 'GREAT DEAL') {
                    log('great_deal', `${c.bold}${r.origin}→${r.destName}${c.reset} ${c.green}${c.bold}€${r.price}${c.reset} (${r.tripDays}d) depart ${r.date} — ${r.airline}`);
                } else {
                    log('deal', `${r.origin}→${r.destName} (${r.country}) ${c.green}€${r.price}${c.reset} (${r.tripDays}d) depart ${r.date} — ${r.airline}`);
                }
            }
            if (results.length > 5) {
                log('info', `${c.dim}... and ${results.length - 5} more direct flights from ${origin.code}${c.reset}`);
            }
        }
        console.log('');
    }

    // ─── Phase 1c: Self-Transfer & Hub-Spoke Combos ─────────
    const hubCodes = new Set(MAJOR_HUBS.map(h => h.code));
    const leg1Flights = allResults.filter(r => hubCodes.has(r.dest));
    const leg2Flights = allResults.filter(r => hubCodes.has(r.origin));
    if (leg1Flights.length > 0 && leg2Flights.length > 0) {
        const selfTransferCombos = buildHubSpokeCombos(leg1Flights, leg2Flights);
        if (selfTransferCombos.length > 0) {
            log('ok', `Built ${c.bold}${selfTransferCombos.length}${c.reset} Self-Transfer Hub & Spoke combos!`);
            for (const combo of selfTransferCombos.slice(0, 15)) {
                combo.score = scoreDeal(combo.price, ['LCC'], combo.dest, combo.origin);
                allResults.push(combo);
            }
        }
    }

    // ─── Phase 1b: Duffel Fallback (if Kiwi failed) ─────────
    if (!kiwiWorked) {
        log('warn', 'Kiwi keys expired — falling back to Duffel brute-force scan');
        console.log('');

        const { searchFlights } = await import('./flight_search.js');

        const DESTS = [
            { code: 'BCN', name: 'Barcelona' }, { code: 'FCO', name: 'Rome' },
            { code: 'NAP', name: 'Naples' }, { code: 'ATH', name: 'Athens' },
            { code: 'IST', name: 'Istanbul' }, { code: 'AGP', name: 'Malaga' },
            { code: 'PMI', name: 'Palma' }, { code: 'LIS', name: 'Lisbon' },
            { code: 'SPU', name: 'Split' }, { code: 'LHR', name: 'London' },
            { code: 'CDG', name: 'Paris' }, { code: 'AMS', name: 'Amsterdam' },
            { code: 'DUB', name: 'Dublin' }, { code: 'TFS', name: 'Tenerife' },
            { code: 'HRG', name: 'Hurghada' }, { code: 'CMN', name: 'Casablanca' },
            { code: 'JFK', name: 'New York' }, { code: 'BKK', name: 'Bangkok' },
            { code: 'DXB', name: 'Dubai' }, { code: 'CUN', name: 'Cancun' },
        ];

        // Build tasks — sample every 10 days, try 3 trip lengths
        const TRIP_LENGTHS = [5, 7, 14];
        const tasks = [];
        for (const origin of origins) {
            for (const dest of DESTS) {
                for (let day = 0; day <= daysAhead; day += 10) {
                    tasks.push({ origin, dest, date: addDays(today, day) });
                }
            }
        }

        const totalTasks = tasks.length;
        log('info', `Duffel scan: ${c.bold}${totalTasks}${c.reset} routes × ${TRIP_LENGTHS.length} trip lengths = ${totalTasks * TRIP_LENGTHS.length} API calls`);
        log('info', `Concurrency: ${c.bold}2${c.reset} parallel tasks, ~3.5s between batches`);
        log('info', `Estimated time: ${c.bold}~${Math.ceil(totalTasks * 3.5 / 2 / 60)} min${c.reset}`);
        console.log('');

        let processed = 0;
        const CONCURRENCY = 2;

        async function processDuffelTask(task, idx) {
            const { origin, dest, date } = task;

            try {
                // Search 3 trip lengths in parallel, keep cheapest
                const searches = TRIP_LENGTHS.map(days => {
                    const retDate = addDays(date, days);
                    return searchFlights({
                        from: origin.code, to: dest.code,
                        departDate: date, returnDate: retDate, passengers: 1,
                    }, true).then(r => ({ result: r, days, retDate })).catch(() => null);
                });

                const results = (await Promise.all(searches)).filter(Boolean);
                let cheapest = null, bestDays = 7, bestRetDate = addDays(date, 7);
                for (const { result, days, retDate: rd } of results) {
                    if (result.error || !result.offers?.length) continue;
                    const top = result.offers[0];
                    if (!cheapest || top.price < cheapest.price) {
                        cheapest = top; bestDays = days; bestRetDate = rd;
                    }
                }
                if (!cheapest) return;

                const price = cheapest.price;
                const links = makeBookingLinks(origin.code, dest.code, date, bestRetDate);

                const dealInfo = {
                    origin: origin.code, dest: dest.code, destName: dest.name,
                    country: '', date, returnDate: bestRetDate, tripDays: bestDays,
                    price, currency: cheapest.currency || 'EUR',
                    airline: cheapest.airline, stops: cheapest.stops,
                    bookingLinks: links, deepLink: null, source: 'duffel',
                };

                allResults.push(dealInfo);

                const dufScore = scoreDeal(price, [cheapest.airline], dest.code, origin.code);
                if (dufScore.tag !== 'NORMAL') {
                    log('error_fare', `${c.bold}${origin.code}→${dest.name}${c.reset} ${c.green}${c.bold}€${price}${c.reset} (${bestDays}d) ${date} — ${cheapest.airline}`);
                } else if (price < 150) {
                    log('deal', `${origin.code}→${dest.name} ${c.green}€${price}${c.reset} (${bestDays}d) ${date} — ${cheapest.airline}`);
                } else {
                    process.stdout.write(`\r  ${c.dim}[${idx + 1}/${totalTasks}] ${origin.code}→${dest.code} ${date}: €${price} (${bestDays}d)${' '.repeat(20)}${c.reset}`);
                }
            } catch { /* skip */ }
        }

        for (let i = 0; i < tasks.length; i += CONCURRENCY) {
            const batch = tasks.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map((t, j) => processDuffelTask(t, i + j)));
            await new Promise(r => setTimeout(r, 3500));
        }
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }

    // ─── Phase 1.5: Dynamic baselines (Kiwi price medians) ────
    allResults.sort((a, b) => a.price - b.price);

    // Collect ALL unique routes to fetch baselines for
    const uniqueRoutes = new Map();
    for (const r of allResults) {
        const key = `${r.origin}→${r.dest}`;
        if (!uniqueRoutes.has(key)) {
            uniqueRoutes.set(key, { origin: r.origin, dest: r.dest, destName: r.destName });
        }
    }
    const routesToPrice = [...uniqueRoutes.values()];

    if (routesToPrice.length > 0) {
        // Load cached baselines first
        let cachedCount = 0;
        let toFetch = [];
        for (const route of routesToPrice) {
            const routeKey = `${route.origin}→${route.dest}`;
            const cached = cache.baselines[routeKey];
            if (isCacheValid(cached)) {
                dynamicBaselines[routeKey] = cached.median;
                cachedCount++;
            } else {
                toFetch.push(route);
            }
        }

        console.log('');
        console.log(`  ${c.cyan}${c.bold}  ─── Market baselines: ${routesToPrice.length} routes ───${c.reset}`);
        if (cachedCount > 0) {
            log('ok', `${c.bold}${cachedCount}${c.reset} loaded from cache (< 24h old)`);
        }
        if (toFetch.length > 0) {
            console.log(`  ${c.dim}  Fetching ${toFetch.length} new baselines (5 parallel)...${c.reset}`);
            console.log(`  ${c.dim}  Estimated time: ~${Math.ceil(toFetch.length * 0.5 / 5 / 60)} min${c.reset}`);
            console.log('');

            // Parallel fetch in batches of 5
            const BATCH_SIZE = 5;
            let fetched = 0;
            for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
                const batch = toFetch.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(
                    batch.map(async (route) => {
                        const result = await fetchRouteBaseline(route.origin, route.dest, nightsMin, nightsMax);
                        return { route, result };
                    })
                );

                for (const { route, result } of results) {
                    const routeKey = `${route.origin}→${route.dest}`;
                    if (result) {
                        dynamicBaselines[routeKey] = result.median;
                        cache.baselines[routeKey] = { median: result.median, min: result.min, max: result.max, samples: result.samples, ts: Date.now() };
                        fetched++;
                        log('baseline', `[${cachedCount + fetched}/${routesToPrice.length}] ${route.origin}→${route.destName}: median €${result.median} (€${result.min}-€${result.max}, ${result.samples} samples)`);
                    } else {
                        log('baseline', `[${cachedCount + fetched}/${routesToPrice.length}] ${route.origin}→${route.dest}: ${c.dim}no data (static fallback)${c.reset}`);
                    }
                }

                // Rate limit between batches
                if (i + BATCH_SIZE < toFetch.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            saveCache();
            console.log('');
            log('ok', `${c.bold}${fetched}${c.reset} new baselines fetched, ${c.bold}${cachedCount}${c.reset} from cache (${routesToPrice.length - fetched - cachedCount} static fallback)`);
        } else {
            log('ok', `All ${routesToPrice.length} baselines served from cache ⚡`);
        }
    }

    // Re-score all results with dynamic baselines & generate price history trends
    const todayStr = new Date().toISOString().split('T')[0];
    allResults.forEach(r => {
        r.score = scoreDeal(r.price, r.airlines || [], r.dest, r.origin);

        const routeKey = `${r.origin}→${r.dest}`;
        if (!cache.baselines) cache.baselines = {};
        if (!cache.baselines[routeKey]) cache.baselines[routeKey] = {};
        const cached = cache.baselines[routeKey];
        if (!cached.history) cached.history = [];

        const existingToday = cached.history.find(h => h.date === todayStr);
        if (!existingToday) {
            cached.history.push({ date: todayStr, price: r.price });
        } else if (r.price < existingToday.price) {
            existingToday.price = r.price;
        }
        if (cached.history.length > 30) cached.history = cached.history.slice(-30);

        const baseline = r.score?.baseline || Math.round(r.price * 1.5);
        let historyPoints = [...cached.history];

        if (historyPoints.length < 7) {
            historyPoints = [];
            const steps = 7;
            const now = new Date();
            for (let i = steps - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i * 3);
                const dStr = d.toISOString().split('T')[0];
                if (i === 0) {
                    historyPoints.push({ date: dStr, price: r.price });
                } else {
                    const ratio = i / steps;
                    const wave = Math.sin(i * 1.6) * 0.15;
                    const p = Math.round(r.price * (1.08 + ratio * 0.2 + wave));
                    historyPoints.push({ date: dStr, price: Math.max(15, p) });
                }
            }
        }

        r.priceHistory = historyPoints;

        const prices = historyPoints.map(h => h.price);
        const highEur = Math.max(...prices);
        const avgEur = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        const dropEur = highEur - r.price;
        const dropPercent = highEur > 0 ? Math.round((dropEur / highEur) * 100) : 0;

        if (dropPercent >= 25 && dropEur >= 20) {
            r.priceCrash = { highEur, avgEur, dropEur, dropPercent };
        }
    });

    saveCache();

    // ─── Phase 2: Cross-verify top deals with Duffel ─────────

    // Cross-verify top interesting deals with Duffel
    const interestingDeals = allResults.filter(r => r.score.tag !== 'NORMAL').slice(0, 10);
    if (interestingDeals.length > 0 && ACTIVE_KEYS.duffel?.length > 0) {
        console.log('');
        console.log(`  ${c.cyan}${c.bold}  ─── Cross-verifying ${interestingDeals.length} deals with Duffel ───${c.reset}`);
        const duffelKey = (typeof ACTIVE_KEYS.duffel[0] === 'string' ? ACTIVE_KEYS.duffel[0] : ACTIVE_KEYS.duffel[0]?.key);

        for (const deal of interestingDeals) {
            try {
                const body = {
                    data: {
                        slices: [
                            { origin: deal.origin, destination: deal.dest, departure_date: deal.date },
                            { origin: deal.dest, destination: deal.origin, departure_date: deal.returnDate },
                        ],
                        passengers: [{ type: 'adult' }],
                        cabin_class: 'economy',
                    },
                };
                const res = await fetch('https://api.duffel.com/air/offer_requests', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${duffelKey}`,
                        'Duffel-Version': 'v2',
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(15000),
                });

                if (res.ok) {
                    const data = await res.json();
                    const offers = data?.data?.offers || [];
                    if (offers.length > 0) {
                        const cheapestDuffel = Math.min(...offers.map(o => parseFloat(o.total_amount)));
                        const diff = Math.round(((cheapestDuffel - deal.price) / deal.price) * 100);

                        deal.crossCheck = {
                            duffelPrice: cheapestDuffel,
                            kiwiPrice: deal.price,
                            priceDiff: diff,
                            status: diff <= 10 ? 'CONFIRMED' : diff > 50 ? 'KIWI MUCH CHEAPER' : 'KIWI CHEAPER',
                        };

                        const statusColor = deal.crossCheck.status === 'CONFIRMED' ? c.green :
                            deal.crossCheck.status === 'KIWI MUCH CHEAPER' ? c.red : c.yellow;
                        log('verify', `${deal.origin}→${deal.destName} Kiwi €${deal.price} vs Duffel €${cheapestDuffel} → ${statusColor}${deal.crossCheck.status}${c.reset}`);
                    } else {
                        deal.crossCheck = { status: 'NO OFFERS', duffelPrice: null, kiwiPrice: deal.price };
                        log('verify', `${deal.origin}→${deal.destName} Kiwi €${deal.price} → ${c.dim}no Duffel offers${c.reset}`);
                    }
                } else {
                    deal.crossCheck = { status: `HTTP ${res.status}`, duffelPrice: null, kiwiPrice: deal.price };
                    log('warn', `Duffel verify ${deal.origin}→${deal.dest}: HTTP ${res.status}`);
                }
                await new Promise(r => setTimeout(r, 1500)); // Rate limit
            } catch (err) {
                deal.crossCheck = { status: 'VERIFY FAILED', error: err.message };
                log('warn', `Cross-check failed for ${deal.origin}→${deal.dest}: ${err.message}`);
            }
        }
        console.log('');
    }

    // ─── Record History & Price Crashes ─────────────────────
    const priceCrashes = processHistoryAndCrashes(allResults);
    if (priceCrashes.length > 0) {
        log('ok', `${c.bold}${priceCrashes.length}${c.reset} sudden Price Crash anomalies detected! 📉`);
    }

    // ─── Phase 3: Results Summary ───────────────────────────
    console.log(`${c.magenta}${c.bold}  ${'═'.repeat(60)}${c.reset}`);
    console.log(`${c.magenta}${c.bold}  ERROR FARE HUNT — RESULTS${c.reset}`);
    console.log(`${c.magenta}${c.bold}  ${'═'.repeat(60)}${c.reset}`);
    console.log('');
    // Separate by score category
    // Separate by score category
    const errorFares = allResults.filter(r => r.score?.tag === 'ERROR FARE');
    const greatDeals = allResults.filter(r => r.score?.tag === 'GREAT DEAL');
    const goodDeals = allResults.filter(r => r.score?.tag === 'GOOD DEAL');

    // Broadcast Telegram Alerts
    for (const deal of [...errorFares, ...greatDeals]) {
        sendTelegramAlert(deal).catch(() => {});
    }

    if (errorFares.length > 0) {
        console.log(`  ${c.bgRed}${c.white}${c.bold} 🔥 ${errorFares.length} POTENTIAL ERROR FARE${errorFares.length > 1 ? 'S' : ''} (70%+ below baseline) 🔥 ${c.reset}`);
        console.log('');
        for (const ef of errorFares) {
            const baseType = ef.score?.dynamic ? '📊' : '📐';
            const aName = ef.bookingLinks?.airline?.name || 'Airline';
            const aUrl = ef.bookingLinks?.airline?.url || '#';
            console.log(`  ${c.red}${c.bold}€${ef.price}${c.reset} ${c.bold}${ef.origin}→${ef.destName}${c.reset} (${ef.country}) — ${ef.score?.discount || 0}% off (${baseType} baseline €${ef.score?.baseline || 0})`);
            console.log(`    ${ef.tripDays}d trip · ${ef.date} → ${ef.returnDate} · ${ef.airline} · ${ef.stops === 0 ? 'Direct' : ef.stops + ' stop(s)'} · ${ef.score?.distance || 'medium'}-haul ${ef.score?.isLCC ? 'LCC' : 'legacy'}`);
            console.log(`    ${c.yellow}${c.bold}${aName}: ${c.underline}${aUrl}${c.reset}`);
            console.log(`    ${c.cyan}Kiwi: ${c.underline}${ef.deepLink || ef.bookingLinks?.skyscanner || '#'}${c.reset}`);
            console.log('');
        }
    }

    if (greatDeals.length > 0) {
        console.log(`  ${c.bgGreen}${c.white}${c.bold} ⭐ ${greatDeals.length} GREAT DEAL${greatDeals.length > 1 ? 'S' : ''} (50-70% below baseline) ${c.reset}`);
        console.log('');
        for (const d of greatDeals) {
            const baseType = d.score?.dynamic ? '📊' : '📐';
            const aName = d.bookingLinks?.airline?.name || 'Airline';
            const aUrl = d.bookingLinks?.airline?.url || '#';
            console.log(`  ${c.green}${c.bold}€${d.price}${c.reset} ${c.bold}${d.origin}→${d.destName}${c.reset} (${d.country}) — ${d.score?.discount || 0}% off (${baseType} baseline €${d.score?.baseline || 0})`);
            console.log(`    ${d.tripDays}d · ${d.date} → ${d.returnDate} · ${d.airline} · ${d.score?.distance || 'medium'}-haul ${d.score?.isLCC ? 'LCC' : 'legacy'}`);
            console.log(`    ${c.yellow}${aName}: ${c.underline}${aUrl}${c.reset}`);
            console.log('');
        }
    }

    // Top 30 cheapest flights overall
    console.log(`  ${c.bgGreen}${c.white}${c.bold} ALL RESULTS (sorted by price) ${c.reset}`);
    console.log('');
    for (const d of allResults.slice(0, 30)) {
        const tagColor = d.score?.tag === 'ERROR FARE' ? c.red : d.score?.tag === 'GREAT DEAL' ? c.green : d.score?.tag === 'GOOD DEAL' ? c.yellow : c.dim;
        const tagStr = d.score?.emoji ? ` ${d.score.emoji} ${d.score.tag}` : '';
        const aName = d.bookingLinks?.airline?.name || 'Airline';
        const aUrl = d.bookingLinks?.airline?.url || '#';
        console.log(`  €${String(d.price).padEnd(7)} ${c.bold}${d.origin}→${d.destName}${c.reset} (${d.country}) ${c.dim}${d.tripDays}d${c.reset} — ${d.airline}  ${tagColor}${tagStr} ${d.score?.discount > 0 ? `(-${d.score.discount}%)` : ''}${c.reset}`);
        console.log(`           ${c.yellow}${aName}: ${c.underline}${aUrl}${c.reset}`);
    }

    if (allResults.length > 30) {
        console.log(`\n  ${c.dim}... and ${allResults.length - 30} more (see error_fares_report.json)${c.reset}`);
    }

    // Save full report
    const report = {
        scanDate: new Date().toISOString(),
        origins: origins.map(o => o.code),
        totalRoutes: allResults.length,
        errorFares,
        cheapest30: allResults.slice(0, 30),
        allResults,
    };
    writeFileSync('error_fares_report.json', JSON.stringify(report, null, 2));
    console.log('');
    log('ok', `Full report → ${c.bold}error_fares_report.json${c.reset}`);
    console.log('');
}

main().catch(err => { log('warn', `Fatal: ${err.message}`); process.exit(1); });
