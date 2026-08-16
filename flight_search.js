#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   FLIGHT SEARCH — Multi-provider flight price lookup
   Providers: Duffel (live), Kiwi.com Tequila
   Used by error_fare_hunter.js for Duffel fallback searches
   ═══════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, existsSync } from 'fs';

// ─── ANSI Colors ────────────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', underline: '\x1b[4m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
    magenta: '\x1b[35m',
    bgGreen: '\x1b[42m', bgCyan: '\x1b[46m', bgRed: '\x1b[41m', bgYellow: '\x1b[43m',
    bgMagenta: '\x1b[45m',
};

function log(level, msg) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const prefix = {
        info: `${c.blue}[INFO]${c.reset}`,
        ok: `${c.green}[OK]${c.reset}`,
        warn: `${c.yellow}[WARN]${c.reset}`,
        err: `${c.red}[ERR]${c.reset}`,
        search: `${c.cyan}[SEARCH]${c.reset}`,
        deal: `${c.bgGreen}${c.white}${c.bold} DEAL ${c.reset}`,
        error_fare: `${c.bgRed}${c.white}${c.bold} ERROR FARE ${c.reset}`,
        monitor: `${c.bgCyan}${c.white}${c.bold} MONITOR ${c.reset}`,
    }[level] || `[${level}]`;
    console.log(`  ${c.gray}${time}${c.reset} ${prefix} ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Fetch with timeout ─────────────────────────────────────
async function safeFetch(url, opts = {}) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        const res = await fetch(url, { ...opts, signal: controller.signal });
        clearTimeout(timeout);
        return res;
    } catch (err) {
        return { status: 0, ok: false, json: async () => null, text: async () => err.message };
    }
}

// ─── Load keys (cached) ────────────────────────────────────
let _keysCache = null;
function loadKeys() {
    if (_keysCache) return _keysCache;
    const path = 'active_keys.json';
    if (!existsSync(path)) {
        log('err', `${c.bold}active_keys.json${c.reset} not found. Run ${c.cyan}npm run scan${c.reset} first.`);
        return {};
    }
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        _keysCache = {};
        for (const [provider, keys] of Object.entries(raw)) {
            _keysCache[provider] = (keys || []).map(k => {
                if (typeof k === 'string') return { key: k, info: '' };
                return k;
            }).filter(k => k && k.key);
        }
        return _keysCache;
    } catch {
        return {};
    }
}

// ─── Validation ─────────────────────────────────────────────
function isValidIATA(code) { return /^[A-Z]{3}$/.test(code); }
function isValidDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    return !isNaN(new Date(dateStr + 'T00:00:00').getTime());
}

// ═══════════════════════════════════════════════════════════
//  DEAL & ERROR FARE DETECTION ENGINE
// ═══════════════════════════════════════════════════════════

// Average price baselines per distance category (EUR, economy, one-way)
// Used as fallback when we don't have enough data to compute route-specific stats
// Baselines are ROUND-TRIP prices (we always search with a return date)
const BASELINE_PRICES = {
    domestic:       { median: 80,   errorThreshold: 15  },   // < 500 km
    shortHaul:      { median: 120,  errorThreshold: 25  },   // 500 - 1500 km
    mediumHaul:     { median: 250,  errorThreshold: 50  },   // 1500 - 4000 km
    longHaul:       { median: 450,  errorThreshold: 100 },   // 4000 - 8000 km
    ultraLongHaul:  { median: 700,  errorThreshold: 150 },   // > 8000 km
};

// Approximate great-circle distance between IATA codes
// Falls back to heuristics based on region detection
const REGION_MAP = {
    // Europe
    'PRG': 'EU', 'KTW': 'EU', 'WAW': 'EU', 'BCN': 'EU', 'LHR': 'EU', 'CDG': 'EU',
    'FRA': 'EU', 'AMS': 'EU', 'FCO': 'EU', 'VIE': 'EU', 'MUC': 'EU', 'BER': 'EU',
    'MAD': 'EU', 'LIS': 'EU', 'ATH': 'EU', 'IST': 'EU', 'ZRH': 'EU', 'BRU': 'EU',
    'CPH': 'EU', 'OSL': 'EU', 'HEL': 'EU', 'DUB': 'EU', 'EDI': 'EU', 'MAN': 'EU',
    'STN': 'EU', 'LGW': 'EU', 'BUD': 'EU', 'OTP': 'EU', 'SOF': 'EU', 'BEG': 'EU',
    'TXL': 'EU', 'SXF': 'EU', 'MXP': 'EU', 'BGY': 'EU', 'NAP': 'EU', 'PMI': 'EU',
    'AGP': 'EU', 'ALC': 'EU', 'VLC': 'EU', 'GDN': 'EU', 'WRO': 'EU', 'KRK': 'EU',
    'RIX': 'EU', 'VNO': 'EU', 'TLL': 'EU',
    // North America
    'JFK': 'NA', 'LAX': 'NA', 'ORD': 'NA', 'SFO': 'NA', 'MIA': 'NA', 'ATL': 'NA',
    'DFW': 'NA', 'SEA': 'NA', 'BOS': 'NA', 'DEN': 'NA', 'IAD': 'NA', 'EWR': 'NA',
    'YYZ': 'NA', 'YVR': 'NA', 'YUL': 'NA', 'MEX': 'NA', 'CUN': 'NA',
    // Asia
    'NRT': 'AS', 'HND': 'AS', 'PEK': 'AS', 'PVG': 'AS', 'HKG': 'AS', 'SIN': 'AS',
    'BKK': 'AS', 'ICN': 'AS', 'KUL': 'AS', 'DEL': 'AS', 'BOM': 'AS', 'DXB': 'AS',
    'DOH': 'AS', 'AUH': 'AS', 'TPE': 'AS',
    // Middle East / Africa / Oceania / South America
    'LCA': 'ME', 'TLV': 'ME', 'AMM': 'ME', 'CAI': 'AF', 'JNB': 'AF', 'NBO': 'AF',
    'SYD': 'OC', 'MEL': 'OC', 'AKL': 'OC', 'GRU': 'SA', 'EZE': 'SA', 'BOG': 'SA',
    'SCL': 'SA', 'LIM': 'SA',
};

function guessDistanceCategory(from, to) {
    const rFrom = REGION_MAP[from];
    const rTo = REGION_MAP[to];
    if (!rFrom || !rTo) return 'mediumHaul'; // Unknown → assume medium
    if (rFrom === rTo) {
        if (rFrom === 'EU') return 'shortHaul';
        return 'domestic';
    }
    const crossings = `${rFrom}-${rTo}`;
    // Same continent pairs
    if (['EU-EU', 'NA-NA', 'AS-AS'].includes(crossings)) return 'shortHaul';
    // Adjacent regions
    if (['EU-ME', 'ME-EU', 'EU-AF', 'AF-EU', 'NA-SA', 'SA-NA', 'AS-OC', 'OC-AS', 'EU-AS', 'AS-EU'].includes(crossings)) return 'mediumHaul';
    // Transatlantic / Transpacific
    if (['EU-NA', 'NA-EU', 'NA-AS', 'AS-NA'].includes(crossings)) return 'longHaul';
    // Intercontinental long
    return 'ultraLongHaul';
}

function analyzeDeals(offers, from, to) {
    if (!offers || offers.length === 0) return { deals: [], errorFares: [], stats: null };

    const prices = offers.map(o => o.price).filter(p => p > 0).sort((a, b) => a - b);
    if (prices.length === 0) return { deals: [], errorFares: [], stats: null };

    // Statistics
    const median = prices[Math.floor(prices.length / 2)];
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const min = prices[0];
    const max = prices[prices.length - 1];
    const q1 = prices[Math.floor(prices.length * 0.25)] || min;
    const q3 = prices[Math.floor(prices.length * 0.75)] || max;
    const iqr = q3 - q1;

    // Distance-based baseline
    const distCat = guessDistanceCategory(from, to);
    const baseline = BASELINE_PRICES[distCat];

    const stats = { median, mean, min, max, q1, q3, iqr, distCategory: distCat, baseline };

    // ── Error Fare Detection ─────────────────────────────────
    // An offer is flagged as a potential error fare if:
    // 1. Price is below the baseline error threshold for this distance
    // 2. Price is more than 70% below median of all results
    // 3. Price is a statistical outlier (below Q1 - 2.5*IQR)
    const errorFares = [];
    const deals = [];

    for (const offer of offers) {
        if (offer.price <= 0) continue;

        let score = 0; // Higher = better deal. 90+ = likely error fare
        const reasons = [];

        // Check 1: Below absolute error threshold
        if (offer.price <= baseline.errorThreshold) {
            score += 40;
            reasons.push(`Below €${baseline.errorThreshold} error threshold for ${distCat}`);
        }

        // Check 2: Below 30% of median (massive underprice)
        if (offer.price < median * 0.30 && prices.length >= 3) {
            score += 35;
            reasons.push(`${Math.round((1 - offer.price / median) * 100)}% below median €${median}`);
        }
        // Check 2b: Below 50% of median (significant underprice)
        else if (offer.price < median * 0.50 && prices.length >= 3) {
            score += 20;
            reasons.push(`${Math.round((1 - offer.price / median) * 100)}% below median €${median}`);
        }

        // Check 3: Statistical outlier (IQR method)
        if (iqr > 0 && offer.price < q1 - 2.5 * iqr) {
            score += 25;
            reasons.push('Statistical outlier (IQR)');
        } else if (iqr > 0 && offer.price < q1 - 1.5 * iqr) {
            score += 15;
            reasons.push('Mild outlier (IQR)');
        }

        // Check 4: Significantly below baseline median
        if (offer.price < baseline.median * 0.40) {
            score += 20;
            reasons.push(`Well below ${distCat} average €${baseline.median}`);
        } else if (offer.price < baseline.median * 0.65) {
            score += 10;
            reasons.push(`Below ${distCat} average €${baseline.median}`);
        }

        // Check 5: Cross-provider verification (if same route is much more on other providers)
        const otherProviderPrices = offers
            .filter(o => o.source !== offer.source && o.price > 0)
            .map(o => o.price);
        if (otherProviderPrices.length > 0) {
            const otherMedian = otherProviderPrices.sort((a, b) => a - b)[Math.floor(otherProviderPrices.length / 2)];
            if (offer.price < otherMedian * 0.40) {
                score += 15;
                reasons.push(`${Math.round((1 - offer.price / otherMedian) * 100)}% cheaper than other providers`);
            }
        }

        // Tag the offer
        offer.dealScore = score;
        offer.dealReasons = reasons;

        if (score >= 80) {
            offer.dealTag = 'ERROR_FARE';
            errorFares.push(offer);
        } else if (score >= 40) {
            offer.dealTag = 'HOT_DEAL';
            deals.push(offer);
        } else if (score >= 20) {
            offer.dealTag = 'GOOD_DEAL';
            deals.push(offer);
        }
    }

    return { deals, errorFares, stats };
}

// ═══════════════════════════════════════════════════════════
//  PROVIDER SEARCH FUNCTIONS
// ═══════════════════════════════════════════════════════════

// ─── Duffel ─────────────────────────────────────────────────
async function searchDuffel(key, params) {
    const { from, to, departDate, returnDate, passengers = 1 } = params;
    const slices = [{ origin: from, destination: to, departure_date: departDate }];
    if (returnDate) slices.push({ origin: to, destination: from, departure_date: returnDate });

    const res = await safeFetch('https://api.duffel.com/air/offer_requests', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Duffel-Version': 'v2',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({
            data: {
                slices,
                passengers: Array(passengers).fill({ type: 'adult' }),
                cabin_class: 'economy',
            }
        })
    });

    if (!res.ok) return { provider: 'Duffel', error: `HTTP ${res.status}`, offers: [] };
    const data = await res.json().catch(() => null);
    if (!data?.data?.offers) return { provider: 'Duffel', error: 'No offers', offers: [] };

    return {
        provider: 'Duffel',
        offers: data.data.offers.slice(0, 40).map(o => {
            const offer = {
                price: parseFloat(o.total_amount),
                currency: o.total_currency,
                airline: o.slices?.[0]?.segments?.[0]?.operating_carrier?.name || o.owner?.name || 'Unknown',
                airlineCode: o.slices?.[0]?.segments?.[0]?.operating_carrier?.iata_code || '',
                departure: o.slices?.[0]?.segments?.[0]?.departing_at || '',
                arrival: o.slices?.[0]?.segments?.slice(-1)[0]?.arriving_at || '',
                duration: sumDuration(o.slices?.[0]?.segments || []),
                stops: (o.slices?.[0]?.segments?.length || 1) - 1,
                segments: o.slices?.map(s => ({
                    legs: s.segments?.map(seg => ({
                        from: seg.origin?.iata_code,
                        to: seg.destination?.iata_code,
                        airline: seg.operating_carrier?.name || '',
                        flightNo: `${seg.operating_carrier?.iata_code || ''}${seg.operating_carrier_flight_number || ''}`,
                        depart: seg.departing_at,
                        arrive: seg.arriving_at,
                    })) || []
                })) || [],
                source: 'duffel',
            };
            // Generate booking links from flight data (always round-trip)
            offer.bookingLinks = generateBookingLinks(offer, params);
            offer.bookingUrl = bestBookingUrl(offer, params);
            return offer;
        })
    };
}

function sumDuration(segments) {
    if (!segments.length) return '';
    const first = new Date(segments[0].departing_at);
    const last = new Date(segments[segments.length - 1].arriving_at);
    const mins = Math.round((last - first) / 60000);
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// ─── SerpAPI (Google Flights) ───────────────────────────────
async function searchSerpAPI(key, params) {
    const { from, to, departDate, returnDate } = params;
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_flights');
    url.searchParams.set('departure_id', from);
    url.searchParams.set('arrival_id', to);
    url.searchParams.set('outbound_date', departDate);
    if (returnDate) url.searchParams.set('return_date', returnDate);
    url.searchParams.set('type', returnDate ? '1' : '2');
    url.searchParams.set('hl', 'en');
    url.searchParams.set('currency', 'EUR');
    url.searchParams.set('api_key', key);

    const res = await safeFetch(url.toString());
    if (!res.ok) return { provider: 'Google Flights', error: `HTTP ${res.status}`, offers: [] };
    const data = await res.json().catch(() => null);
    if (!data) return { provider: 'Google Flights', error: 'Parse error', offers: [] };

    const flights = [...(data.best_flights || []), ...(data.other_flights || [])];
    const googleUrl = data.search_metadata?.google_flights_url || null;

    return {
        provider: 'Google Flights',
        offers: flights.slice(0, 40).map(f => {
            // Build a Google Flights direct booking URL
            const bookUrl = googleUrl || buildGoogleFlightsUrl(from, to, departDate, returnDate);
            return {
                price: f.price || 0,
                currency: 'EUR',
                airline: f.flights?.[0]?.airline || 'Unknown',
                airlineCode: '',
                departure: f.flights?.[0]?.departure_airport?.time || '',
                arrival: f.flights?.slice(-1)[0]?.arrival_airport?.time || '',
                duration: formatMinutes(f.total_duration),
                stops: (f.flights?.length || 1) - 1,
                segments: [{
                    legs: (f.flights || []).map(leg => ({
                        from: leg.departure_airport?.id || '',
                        to: leg.arrival_airport?.id || '',
                        airline: leg.airline || '',
                        flightNo: `${leg.flight_number || ''}`,
                        depart: leg.departure_airport?.time || '',
                        arrive: leg.arrival_airport?.time || '',
                    }))
                }],
                bookingUrl: bookUrl,
                source: 'google_flights',
            };
        })
    };
}

function buildGoogleFlightsUrl(from, to, depart, ret) {
    const base = `https://www.google.com/travel/flights?q=flights+from+${from}+to+${to}+on+${depart}`;
    return ret ? `${base}+through+${ret}` : base;
}

// ─── Kiwi.com Tequila ──────────────────────────────────────
async function searchKiwi(key, params) {
    const { from, to, departDate, returnDate, passengers = 1 } = params;
    const fmtDate = (d) => d.split('-').reverse().join('/');
    const url = new URL('https://api.tequila.kiwi.com/v2/search');
    url.searchParams.set('fly_from', from);
    url.searchParams.set('fly_to', to);
    url.searchParams.set('date_from', fmtDate(departDate));
    url.searchParams.set('date_to', fmtDate(departDate));
    if (returnDate) {
        url.searchParams.set('return_from', fmtDate(returnDate));
        url.searchParams.set('return_to', fmtDate(returnDate));
    }
    url.searchParams.set('adults', String(passengers));
    url.searchParams.set('curr', 'EUR');
    url.searchParams.set('limit', '40');
    url.searchParams.set('sort', 'price');

    const res = await safeFetch(url.toString(), { headers: { 'apikey': key } });
    if (!res.ok) return { provider: 'Kiwi.com', error: `HTTP ${res.status}`, offers: [] };
    const data = await res.json().catch(() => null);
    if (!data?.data) return { provider: 'Kiwi.com', error: 'No data', offers: [] };

    return {
        provider: 'Kiwi.com',
        offers: data.data.slice(0, 40).map(f => {
            let durationStr = '?';
            if (typeof f.fly_duration === 'string') {
                durationStr = f.fly_duration;
            } else if (typeof f.fly_duration === 'number' && f.fly_duration > 0) {
                durationStr = formatMinutes(Math.floor(f.fly_duration / 60));
            } else if (f.dTime && f.aTime) {
                durationStr = formatMinutes(Math.floor((f.aTime - f.dTime) / 60));
            }

            const depTime = f.local_departure || (f.dTime ? new Date(f.dTime * 1000).toISOString() : '');
            const arrTime = f.local_arrival || (f.aTime ? new Date(f.aTime * 1000).toISOString() : '');

            return {
                price: f.price || 0,
                currency: 'EUR',
                airline: f.airlines?.join(', ') || 'Unknown',
                airlineCode: f.airlines?.[0] || '',
                departure: depTime,
                arrival: arrTime,
                duration: durationStr,
                stops: (f.route?.filter(r => r.return === 0)?.length || 1) - 1,
                segments: [{
                    legs: (f.route || []).filter(r => r.return === 0).map(r => ({
                        from: r.flyFrom,
                        to: r.flyTo,
                        airline: r.airline,
                        flightNo: `${r.airline || ''}${r.flight_no || ''}`,
                        depart: r.local_departure || (r.dTime ? new Date(r.dTime * 1000).toISOString() : ''),
                        arrive: r.local_arrival || (r.aTime ? new Date(r.aTime * 1000).toISOString() : ''),
                    }))
                }],
                bookingUrl: f.deep_link || null,
                source: 'kiwi',
            };
        })
    };
}

// ─── Amadeus GDS ─────────────────────────────────────────────
async function searchAmadeus(keyObj, params) {
    const { from, to, departDate, returnDate, passengers = 1 } = params;
    const clientId = typeof keyObj === 'string' ? keyObj : keyObj?.clientId || keyObj?.key;
    const clientSecret = typeof keyObj === 'object' ? keyObj?.clientSecret || keyObj?.secret : '';

    if (!clientId || !clientSecret) return { provider: 'Amadeus GDS', error: 'Missing client credentials', offers: [] };

    try {
        const tokenRes = await safeFetch('https://api.amadeus.com/v1/security/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`
        });
        if (!tokenRes.ok) return { provider: 'Amadeus GDS', error: `Auth HTTP ${tokenRes.status}`, offers: [] };
        const tokenData = await tokenRes.json().catch(() => null);
        if (!tokenData?.access_token) return { provider: 'Amadeus GDS', error: 'Auth token missing', offers: [] };

        const token = tokenData.access_token;
        const url = new URL('https://api.amadeus.com/v2/shopping/flight-offers');
        url.searchParams.set('originLocationCode', from);
        url.searchParams.set('destinationLocationCode', to);
        url.searchParams.set('departureDate', departDate);
        if (returnDate) url.searchParams.set('returnDate', returnDate);
        url.searchParams.set('adults', String(passengers));
        url.searchParams.set('currencyCode', 'EUR');
        url.searchParams.set('max', '20');

        const res = await safeFetch(url.toString(), {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });
        if (!res.ok) return { provider: 'Amadeus GDS', error: `HTTP ${res.status}`, offers: [] };
        const data = await res.json().catch(() => null);
        if (!data?.data) return { provider: 'Amadeus GDS', error: 'No offers', offers: [] };

        return {
            provider: 'Amadeus GDS',
            offers: data.data.map(o => ({
                price: parseFloat(o.price?.grandTotal || o.price?.total || 0),
                currency: 'EUR',
                airline: o.validatingAirlineCodes?.[0] || 'GDS Carrier',
                airlineCode: o.validatingAirlineCodes?.[0] || '',
                departure: o.itineraries?.[0]?.segments?.[0]?.departure?.at || '',
                arrival: o.itineraries?.[0]?.segments?.slice(-1)[0]?.arrival?.at || '',
                stops: (o.itineraries?.[0]?.segments?.length || 1) - 1,
                source: 'amadeus',
            }))
        };
    } catch (err) {
        return { provider: 'Amadeus GDS', error: err.message, offers: [] };
    }
}

// ─── Booking Link Generator ─────────────────────────────────

// Airline IATA → deep booking link generator
// Builds direct booking URLs with route+date pre-filled where possible
function getAirlineBookingUrl(airlineCode, from, to, date, retDate) {
    const [yyyy, mm, dd] = date.split('-');
    const [ryyyy, rmm, rdd] = (retDate || date).split('-');

    const deepLinks = {
        // LCCs — best deep-link support
        'FR': `https://www.ryanair.com/gb/en/trip/flights/select?adults=1&dateOut=${date}&origin=${from}&destination=${to}`,
        'U2': `https://www.easyjet.com/en/booking/select-flight?origin=${from}&destination=${to}&outboundDate=${date}`,
        'VY': `https://www.vueling.com/en/booking/select?origin=${from}&destination=${to}&outbound=${date}&adults=1`,
        'W6': `https://wizzair.com/en-gb/booking/select-flight/${from}/${to}/${date}/1/0/0`,
        // Lufthansa Group
        'LH': `https://www.lufthansa.com/gb/en/select-flights?origin=${from}&destination=${to}&outbound-date=${date}&cabin-class=economy&adults=1`,
        'OS': `https://www.austrian.com/gb/en/select-flights?origin=${from}&destination=${to}&outbound-date=${date}&cabin-class=economy&adults=1`,
        'LX': `https://www.swiss.com/gb/en/select-flights?origin=${from}&destination=${to}&outbound-date=${date}&cabin-class=economy&adults=1`,
        'SN': `https://www.brusselsairlines.com/gb/en/select-flights?origin=${from}&destination=${to}&outbound-date=${date}&cabin-class=economy&adults=1`,
        'EW': `https://www.eurowings.com/en/booking/flight-selection.html?origin=${from}&destination=${to}&outboundDate=${date}&adults=1`,
        // BA
        'BA': `https://www.britishairways.com/travel/book/public/en_gb?origin=${from}&destination=${to}&outbound=${yyyy}${mm}${dd}&adult=1&cabin=M`,
        // AF/KLM
        'AF': `https://www.airfrance.com/search/offer?origin=${from}&destination=${to}&outboundDate=${date}&adults=1&cabinClass=ECONOMY`,
        'KL': `https://www.klm.com/search/offer?origin=${from}&destination=${to}&outboundDate=${date}&adults=1&cabinClass=ECONOMY`,
        // Iberia
        'IB': `https://www.iberia.com/gb/flights/${from}-${to}/?DEP_DATE=${dd}${mm}${yyyy}&CABIN=economy&ADULTS=1`,
        // Turkish/Pegasus
        'TK': `https://www.turkishairlines.com/en-gb/flights/?origin=${from}&destination=${to}&departureDate=${date}&adult=1`,
        'PC': `https://www.flypgs.com/en/booking?origin=${from}&destination=${to}&departureDate=${date}&adults=1`,
        // Others with booking paths
        'TP': `https://www.flytap.com/en-gb/booking?origin=${from}&destination=${to}&date=${date}&adults=1`,
        'EI': `https://www.aerlingus.com/booking/select-flights?origin=${from}&destination=${to}&departureDate=${date}&adults=1`,
        'AZ': `https://www.ita-airways.com/en_gb/offers/flights?from=${from}&to=${to}&date=${date}&adults=1`,
        'QS': `https://www.smartwings.com/en/booking?from=${from}&to=${to}&date=${date}&passengers=1`,
        'DE': `https://www.condor.com/gb/flights?origin=${from}&destination=${to}&date=${date}&adults=1`,
        'DY': `https://www.norwegian.com/en/booking/flight-offer?origin=${from}&destination=${to}&outbound=${date}&adults=1`,
        'SK': `https://www.flysas.com/en/book/flights?origin=${from}&destination=${to}&outDate=${date}&adt=1`,
        'AY': `https://www.finnair.com/en/booking?departureStation=${from}&arrivalStation=${to}&departureDate=${date}&adults=1`,
        // Long-haul
        'EK': `https://www.emirates.com/flights/search?origin=${from}&destination=${to}&date=${date}&adult=1`,
        'QR': `https://www.qatarairways.com/en/booking.html?origin=${from}&destination=${to}&departDate=${date}&adult=1`,
        'EY': `https://www.etihad.com/en-gb/fly-etihad/book-flights?origin=${from}&destination=${to}&date=${date}&pax=1`,
        'AA': `https://www.aa.com/booking/find-flights?origin=${from}&destination=${to}&departDate=${date}&adult=1`,
        'UA': `https://www.united.com/en/us/fsr/choose-flights?f=${from}&t=${to}&d=${date}&tt=1&at=1`,
        'DL': `https://www.delta.com/flight-search/book-a-flight?origin=${from}&destination=${to}&departureDate=${date}&paxCount=1`,
    };

    // Fallback airline homepages for ones without deep-link support
    const fallbackSites = {
        'OK': 'https://www.csa.cz', 'SQ': 'https://www.singaporeair.com',
        'CX': 'https://www.cathaypacific.com', 'NH': 'https://www.ana.co.jp/en',
        'JL': 'https://www.jal.co.jp/en', 'LO': 'https://www.lot.com',
        'A3': 'https://www.aegeanair.com', 'GQ': 'https://www.skyexpress.gr',
        'JU': 'https://www.airserbia.com', 'OU': 'https://www.croatiaairlines.com',
        'EN': 'https://www.airdolomiti.eu',
    };

    return deepLinks[airlineCode] || fallbackSites[airlineCode] || null;
}

function generateBookingLinks(offer, searchParams = {}) {
    const from = offer.segments?.[0]?.legs?.[0]?.from || '';
    const to = offer.segments?.[0]?.legs?.slice(-1)[0]?.to || '';
    const departISO = offer.departure || '';
    const date = departISO ? departISO.split('T')[0] : '';
    const airlineCode = offer.airlineCode || '';
    const links = {};

    if (!from || !to || !date) return links;

    // Always generate return dates — use explicit return or default +7 days
    const retDate = searchParams.returnDate || addDays(date, 7);

    // Date parts
    const [yyyy, mm, dd] = date.split('-');
    const yy = yyyy.substring(2);
    const [ryyyy, rmm, rdd] = retDate.split('-');
    const ryy = ryyyy.substring(2);

    // Google Flights — round-trip search
    links.googleFlights = `https://www.google.com/travel/flights?q=Flights+from+${from}+to+${to}+on+${date}+return+${retDate}&curr=EUR`;

    // Skyscanner — YYMMDD/YYMMDD for round-trip
    links.skyscanner = `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yy}${mm}${dd}/${ryy}${rmm}${rdd}/`;

    // Kayak — round-trip with two dates
    links.kayak = `https://www.kayak.com/flights/${from}-${to}/${date}/${retDate}?sort=bestflight_a`;

    // Momondo
    links.momondo = `https://www.momondo.com/flight-search/${from}-${to}/${date}/${retDate}?sort=bestflight_a`;

    // Direct airline booking — deep link with route + date
    if (airlineCode) {
        const airlineUrl = getAirlineBookingUrl(airlineCode, from, to, date, retDate);
        if (airlineUrl) links.airline = airlineUrl;
    }

    return links;
}

function bestBookingUrl(offer, searchParams = {}) {
    const links = generateBookingLinks(offer, searchParams);
    // Priority: skyscanner (actual booking) > kayak > google flights
    return links.skyscanner || links.kayak || links.googleFlights || null;
}

// ─── Helpers ────────────────────────────────────────────────
function formatMinutes(m) {
    if (!m || m <= 0) return '?';
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTime(isoOrTime) {
    if (!isoOrTime) return '--:--';
    try {
        if (isoOrTime.includes('T')) {
            return new Date(isoOrTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        }
        return isoOrTime.substring(0, 5);
    } catch { return isoOrTime; }
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

export async function searchTravelpayouts(params, key) {
    return { provider: 'Travelpayouts', error: 'Travelpayouts provider not configured', offers: [] };
}

// ─── Provider Map ───────────────────────────────────────────
const PROVIDERS = {
    duffel:        { fn: searchDuffel,        name: 'Duffel'          },
    serpapi:       { fn: searchSerpAPI,        name: 'Google Flights'  },
    kiwi:          { fn: searchKiwi,           name: 'Kiwi.com'       },
    travelpayouts: { fn: searchTravelpayouts,  name: 'Travelpayouts'  },
};

// ═══════════════════════════════════════════════════════════
//  CORE SEARCH ENGINE
// ═══════════════════════════════════════════════════════════

export async function searchFlights(params, quiet = false) {
    const keys = loadKeys();
    const searches = [];
    const activeProviders = [];

    for (const [id, provider] of Object.entries(PROVIDERS)) {
        let providerKeys = keys[id];
        if (!providerKeys || providerKeys.length === 0) continue;

        // ── Smart key filtering ─────────────────────────────
        if (id === 'duffel') {
            // Only use duffel_live_ keys — test keys return sandbox data
            providerKeys = providerKeys.filter(k => {
                const keyStr = typeof k === 'string' ? k : k?.key || '';
                return keyStr.startsWith('duffel_live_');
            });
            if (providerKeys.length === 0) {
                if (!quiet) log('warn', `Duffel: skipping test keys (need duffel_live_)`);
                continue;
            }
        }
        if (id === 'serpapi') {
            // Skip depleted keys (0 searches remaining)
            providerKeys = providerKeys.filter(k => {
                if (k && typeof k === 'object' && k.deep?.usable === false) return false;
                return true;
            });
            if (providerKeys.length === 0) {
                if (!quiet) log('warn', `SerpAPI: all keys depleted (0 searches left)`);
                continue;
            }
        }

        // Try keys with fallback — if first fails, try next
        const keyList = providerKeys.map(k => typeof k === 'string' ? k : k?.key).filter(Boolean);
        if (keyList.length === 0) continue;
        activeProviders.push(provider.name);
        searches.push(
            (async () => {
                for (let i = 0; i < Math.min(keyList.length, 3); i++) {
                    try {
                        const result = await provider.fn(keyList[i], params);
                        if (result.offers?.length > 0 || !result.error) return result;
                        if (i < keyList.length - 1 && !quiet) log('warn', `${provider.name}: key #${i+1} failed (${result.error}), trying next...`);
                    } catch (err) {
                        if (i < keyList.length - 1 && !quiet) log('warn', `${provider.name}: key #${i+1} error, trying next...`);
                    }
                }
                return { provider: provider.name, error: 'All keys exhausted', offers: [] };
            })()
        );
    }

    if (searches.length === 0) {
        return { error: 'No active keys. Run: npm run scan', providers: [], offers: [], deals: [], errorFares: [], stats: null };
    }

    if (!quiet) {
        for (const name of activeProviders) log('search', `Querying ${c.bold}${name}${c.reset}...`);
    }

    const results = await Promise.allSettled(searches);
    const allOffers = [];
    const providerResults = [];

    for (const r of results) {
        const val = r.status === 'fulfilled' ? r.value : { provider: '?', error: r.reason?.message, offers: [] };
        providerResults.push({
            name: val.provider,
            offers: val.offers?.length || 0,
            error: val.error || null,
        });
        if (val.offers) allOffers.push(...val.offers);
    }

    // Ensure every offer has booking links — generate from flight data if missing
    for (const offer of allOffers) {
        if (!offer.bookingLinks) offer.bookingLinks = generateBookingLinks(offer, params);
        if (!offer.bookingUrl) offer.bookingUrl = bestBookingUrl(offer, params);
    }

    // Sort by price
    allOffers.sort((a, b) => (a.price || 999999) - (b.price || 999999));

    // Run deal & error fare detection
    const analysis = analyzeDeals(allOffers, params.from, params.to);

    return {
        query: params,
        providers: providerResults,
        totalOffers: allOffers.length,
        offers: allOffers,
        deals: analysis.deals,
        errorFares: analysis.errorFares,
        stats: analysis.stats,
        timestamp: new Date().toISOString(),
    };
}

// ═══════════════════════════════════════════════════════════
//  DATE RANGE SCANNER — Find cheapest across ±N days
// ═══════════════════════════════════════════════════════════

async function scanDateRange(params, rangeDays) {
    const allResults = [];
    const dates = [];

    // Generate date range centered on the target date
    for (let d = -rangeDays; d <= rangeDays; d++) {
        const departDate = addDays(params.departDate, d);
        // Skip past dates
        if (new Date(departDate) < new Date(new Date().toISOString().split('T')[0])) continue;

        let returnDate = null;
        if (params.returnDate) {
            // Keep same trip duration
            const tripDays = Math.round((new Date(params.returnDate) - new Date(params.departDate)) / 86400000);
            returnDate = addDays(departDate, tripDays);
        }
        dates.push({ departDate, returnDate });
    }

    log('info', `Scanning ${c.bold}${dates.length} date combinations${c.reset} (${params.from}→${params.to}, ±${rangeDays} days)`);
    console.log('');

    for (let i = 0; i < dates.length; i++) {
        const { departDate, returnDate } = dates[i];
        const label = returnDate ? `${departDate} → ${returnDate}` : departDate;
        log('search', `${c.dim}[${i + 1}/${dates.length}]${c.reset} ${label}`);

        const result = await searchFlights({ ...params, departDate, returnDate }, true);
        if (result.offers.length > 0) {
            const cheapest = result.offers[0];
            const tag = cheapest.dealTag || '';
            const tagStr = tag === 'ERROR_FARE' ? ` ${c.bgRed}${c.white} ERROR FARE ${c.reset}`
                         : tag === 'HOT_DEAL' ? ` ${c.bgGreen}${c.white} HOT DEAL ${c.reset}`
                         : tag === 'GOOD_DEAL' ? ` ${c.bgYellow}${c.white} DEAL ${c.reset}`
                         : '';
            log('info', `  ${c.green}€${cheapest.price}${c.reset} ${c.dim}${cheapest.airline} (${cheapest.source})${c.reset}${tagStr}`);
        } else {
            log('info', `  ${c.dim}No results${c.reset}`);
        }
        allResults.push({ departDate, returnDate, ...result });

        // Rate limit between searches
        if (i < dates.length - 1) await sleep(2000);
    }

    // Find absolute best across all dates
    const allOffers = allResults.flatMap(r =>
        r.offers.map(o => ({ ...o, searchDate: r.departDate, searchReturn: r.returnDate }))
    );
    allOffers.sort((a, b) => (a.price || 999999) - (b.price || 999999));

    return { dates: allResults, allOffers, bestDate: allResults.reduce((best, r) => {
        if (!r.offers.length) return best;
        if (!best || r.offers[0].price < best.offers[0].price) return r;
        return best;
    }, null)};
}

// ═══════════════════════════════════════════════════════════
//  CLI OUTPUT
// ═══════════════════════════════════════════════════════════

function printOffer(o, rank, params) {
    const stopsText = o.stops === 0 ? `${c.green}Direct${c.reset}` : `${c.yellow}${o.stops} stop${o.stops > 1 ? 's' : ''}${c.reset}`;
    const priceStr = `€${o.price}`;
    const fromCode = o.segments?.[0]?.legs?.[0]?.from || params.from;
    const toCode = o.segments?.[0]?.legs?.slice(-1)[0]?.to || params.to;

    // Deal tag
    let tagStr = '';
    if (o.dealTag === 'ERROR_FARE') tagStr = ` ${c.bgRed}${c.white}${c.bold} ⚠ ERROR FARE ⚠ ${c.reset}`;
    else if (o.dealTag === 'HOT_DEAL') tagStr = ` ${c.bgGreen}${c.white}${c.bold} 🔥 HOT DEAL ${c.reset}`;
    else if (o.dealTag === 'GOOD_DEAL') tagStr = ` ${c.bgYellow}${c.white}${c.bold} ✦ DEAL ${c.reset}`;

    // Rank + Price
    const rankStr = String(rank).padStart(2, ' ');
    if (rank === 1) {
        console.log(`  ${c.bgGreen}${c.white}${c.bold} #${rankStr} ${c.reset} ${c.green}${c.bold}${priceStr.padStart(8)}${c.reset}  ${c.bold}${o.airline}${c.reset}${tagStr}`);
    } else {
        console.log(`   ${c.dim}#${rankStr}${c.reset}  ${c.bold}${priceStr.padStart(8)}${c.reset}  ${c.bold}${o.airline}${c.reset}${tagStr}`);
    }

    // Route
    console.log(`         ${c.white}${fromCode} → ${toCode}${c.reset}  ${formatTime(o.departure)} → ${formatTime(o.arrival)}  ${stopsText}  ${c.dim}${o.duration || '?'}${c.reset}  ${c.dim}[${o.source}]${c.reset}`);

    // Multi-leg details
    if (o.stops > 0 && o.segments?.[0]?.legs?.length > 1) {
        for (const leg of o.segments[0].legs) {
            console.log(`         ${c.dim}  └ ${leg.from}→${leg.to}  ${leg.flightNo || ''}  ${formatTime(leg.depart)}→${formatTime(leg.arrive)}${c.reset}`);
        }
    }

    // Deal reasons
    if (o.dealReasons?.length > 0) {
        console.log(`         ${c.magenta}⚡ ${o.dealReasons.join(' · ')}${c.reset}`);
    }

    // Booking links
    if (o.bookingLinks && Object.keys(o.bookingLinks).length > 0) {
        const bl = o.bookingLinks;
        const linkParts = [];
        if (bl.skyscanner)    linkParts.push(`${c.cyan}Skyscanner${c.reset}: ${c.underline}${bl.skyscanner}${c.reset}`);
        if (bl.googleFlights) linkParts.push(`${c.cyan}Google${c.reset}: ${c.underline}${bl.googleFlights}${c.reset}`);
        if (bl.kayak)         linkParts.push(`${c.cyan}Kayak${c.reset}: ${c.underline}${bl.kayak}${c.reset}`);
        if (bl.airline)       linkParts.push(`${c.cyan}${o.airline}${c.reset}: ${c.underline}${bl.airline}${c.reset}`);
        // Show primary link prominently
        if (linkParts.length > 0) console.log(`         🔗 ${linkParts[0]}`);
        // Show rest compactly
        for (let li = 1; li < linkParts.length; li++) {
            console.log(`            ${linkParts[li]}`);
        }
    } else if (o.bookingUrl) {
        console.log(`         ${c.cyan}${c.underline}🔗 ${o.bookingUrl}${c.reset}`);
    }
    console.log('');
}

function printResults(data, params) {
    const sep = `${c.cyan}${'═'.repeat(72)}${c.reset}`;
    const sepThin = `  ${c.gray}${'─'.repeat(68)}${c.reset}`;

    console.log('');
    console.log(sep);
    console.log(`${c.cyan}${c.bold}  ✈  FLIGHT SEARCH RESULTS${c.reset}`);
    console.log(sep);
    console.log('');
    console.log(`  ${c.bold}Route:${c.reset}      ${c.white}${params.from} → ${params.to}${c.reset}`);
    console.log(`  ${c.bold}Depart:${c.reset}     ${c.white}${params.departDate}${c.reset}`);
    if (params.returnDate) console.log(`  ${c.bold}Return:${c.reset}     ${c.white}${params.returnDate}${c.reset}`);
    console.log(`  ${c.bold}Passengers:${c.reset} ${c.white}${params.passengers || 1}${c.reset}`);
    console.log('');

    // Provider status
    for (const p of data.providers) {
        if (p.error) console.log(`    ${c.red}✗${c.reset} ${p.name.padEnd(22)} ${c.dim}${p.error}${c.reset}`);
        else console.log(`    ${c.green}✓${c.reset} ${p.name.padEnd(22)} ${c.green}${p.offers} offers${c.reset}`);
    }

    if (data.offers.length === 0) {
        console.log(`\n  ${c.yellow}No flights found.${c.reset}\n`);
        return;
    }

    // ── Error Fares ──────────────────────────────────────────
    if (data.errorFares.length > 0) {
        console.log('');
        console.log(`  ${c.bgRed}${c.white}${c.bold}  ⚠  POTENTIAL ERROR FARES DETECTED (${data.errorFares.length})  ⚠  ${c.reset}`);
        console.log(`  ${c.red}${c.dim}These prices are abnormally low — book FAST before they're fixed!${c.reset}`);
        console.log('');
        for (let i = 0; i < data.errorFares.length; i++) {
            printOffer(data.errorFares[i], i + 1, params);
        }
        console.log(sepThin);
    }

    // ── Hot Deals ────────────────────────────────────────────
    const hotDeals = data.deals.filter(d => d.dealTag === 'HOT_DEAL');
    if (hotDeals.length > 0) {
        console.log('');
        console.log(`  ${c.bgGreen}${c.white}${c.bold}  🔥 HOT DEALS (${hotDeals.length})  ${c.reset}`);
        console.log('');
        for (let i = 0; i < Math.min(hotDeals.length, 5); i++) {
            printOffer(hotDeals[i], i + 1, params);
        }
        console.log(sepThin);
    }

    // ── All Results ──────────────────────────────────────────
    console.log('');
    console.log(`  ${c.bold}ALL RESULTS (${data.totalOffers} flights, sorted by price)${c.reset}`);
    console.log('');

    const showCount = Math.min(data.offers.length, 20);
    for (let i = 0; i < showCount; i++) {
        printOffer(data.offers[i], i + 1, params);
    }

    if (data.offers.length > showCount) {
        console.log(`  ${c.dim}... and ${data.offers.length - showCount} more (see JSON export)${c.reset}\n`);
    }

    // ── Stats ────────────────────────────────────────────────
    if (data.stats) {
        console.log(sepThin);
        console.log('');
        console.log(`  ${c.bgCyan}${c.white}${c.bold} PRICE ANALYSIS ${c.reset}`);
        console.log(`  ${c.bold}Route type:${c.reset}  ${data.stats.distCategory} (baseline median: €${data.stats.baseline.median})`);
        console.log(`  ${c.bold}Cheapest:${c.reset}    ${c.green}€${data.stats.min}${c.reset}`);
        console.log(`  ${c.bold}Median:${c.reset}      €${data.stats.median}`);
        console.log(`  ${c.bold}Mean:${c.reset}        €${Math.round(data.stats.mean)}`);
        console.log(`  ${c.bold}Most exp.:${c.reset}   €${data.stats.max}`);
        console.log(`  ${c.bold}Spread:${c.reset}      Q1=€${data.stats.q1} Q3=€${data.stats.q3} IQR=€${data.stats.iqr}`);

        const withLinks = data.offers.filter(o => o.bookingUrl);
        console.log('');
        console.log(`  ${c.bold}Bookable:${c.reset}    ${withLinks.length}/${data.totalOffers} offers have direct links`);

        if (withLinks.length > 0) {
            const best = withLinks[0];
            console.log(`  ${c.bold}Best book:${c.reset}   ${c.green}€${best.price}${c.reset} on ${best.airline} (${best.source})`);
            console.log(`  ${c.bold}Book now:${c.reset}    ${c.cyan}${c.underline}${best.bookingUrl}${c.reset}`);
        }
    }

    console.log('');
    console.log(sep);
    console.log('');
}

function printDateScanResults(scanData, params) {
    const sep = `${c.cyan}${'═'.repeat(72)}${c.reset}`;

    console.log('');
    console.log(sep);
    console.log(`${c.cyan}${c.bold}  ✈  DATE RANGE SCAN RESULTS${c.reset}`);
    console.log(sep);
    console.log('');

    // Date price table
    console.log(`  ${c.bold}${'Date'.padEnd(24)} ${'Cheapest'.padStart(10)}  ${'Airline'.padEnd(20)}  Source${c.reset}`);
    console.log(`  ${c.gray}${'─'.repeat(68)}${c.reset}`);

    for (const dr of scanData.dates) {
        const label = dr.returnDate ? `${dr.departDate} → ${dr.returnDate}` : dr.departDate;
        if (dr.offers.length === 0) {
            console.log(`  ${label.padEnd(24)} ${c.dim}no results${c.reset}`);
        } else {
            const ch = dr.offers[0];
            const isBest = scanData.bestDate && dr.departDate === scanData.bestDate.departDate;
            const tag = ch.dealTag === 'ERROR_FARE' ? ` ${c.bgRed}${c.white} ERROR ${c.reset}`
                      : ch.dealTag === 'HOT_DEAL' ? ` ${c.bgGreen}${c.white} HOT ${c.reset}`
                      : '';
            if (isBest) {
                console.log(`  ${c.green}${c.bold}${label.padEnd(24)} €${String(ch.price).padStart(8)}  ${ch.airline.padEnd(20).substring(0,20)}  ${ch.source}${c.reset}${tag}  ${c.bgGreen}${c.white}${c.bold} BEST ${c.reset}`);
            } else {
                console.log(`  ${label.padEnd(24)} €${String(ch.price).padStart(8)}  ${ch.airline.padEnd(20).substring(0,20)}  ${ch.source}${tag}`);
            }
        }
    }

    // Best overall + booking link
    if (scanData.bestDate?.offers?.[0]) {
        const best = scanData.bestDate.offers[0];
        console.log('');
        console.log(`  ${c.bgGreen}${c.white}${c.bold}  🏆 BEST DATE: ${scanData.bestDate.departDate}${scanData.bestDate.returnDate ? ` → ${scanData.bestDate.returnDate}` : ''} — €${best.price} on ${best.airline}  ${c.reset}`);
        if (best.bookingUrl) {
            console.log(`  ${c.cyan}${c.underline}🔗 ${best.bookingUrl}${c.reset}`);
        }
    }

    // Error fares across all dates
    const allErrors = scanData.allOffers.filter(o => o.dealTag === 'ERROR_FARE');
    if (allErrors.length > 0) {
        console.log('');
        console.log(`  ${c.bgRed}${c.white}${c.bold}  ⚠ ${allErrors.length} POTENTIAL ERROR FARES FOUND ACROSS DATES  ${c.reset}`);
        for (const ef of allErrors.slice(0, 5)) {
            console.log(`  ${c.red}€${ef.price}${c.reset} on ${c.bold}${ef.airline}${c.reset} for ${ef.searchDate}${ef.searchReturn ? ` → ${ef.searchReturn}` : ''} ${c.dim}[${ef.source}]${c.reset}`);
            if (ef.bookingUrl) console.log(`    ${c.cyan}${c.underline}${ef.bookingUrl}${c.reset}`);
        }
    }

    console.log('');
    console.log(sep);
    console.log('');
}

// ═══════════════════════════════════════════════════════════
//  CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════

async function main() {
    console.log(`
${c.cyan}${c.bold}  ╔══════════════════════════════════════════════════════════╗
  ║                                                          ║
  ║  ✈  FLIGHT SCANNER — Deal & Error Fare Hunter            ║
  ║  Multi-provider search · anomaly detection · date scan    ║
  ║                                                          ║
  ╚══════════════════════════════════════════════════════════╝${c.reset}
`);

    const args = process.argv.slice(2);

    if (args.length < 3 || args.includes('--help') || args.includes('-h')) {
        console.log(`  ${c.bold}Usage:${c.reset}
    node flight_search.js <FROM> <TO> <DEPART> [RETURN] [options]

  ${c.bold}Examples:${c.reset}
    ${c.dim}# Simple search${c.reset}
    node flight_search.js PRG BCN 2026-04-18

    ${c.dim}# Round trip${c.reset}
    node flight_search.js KTW LCA 2026-04-18 2026-04-25

    ${c.dim}# Scan ±5 days to find cheapest date${c.reset}
    node flight_search.js PRG BCN 2026-04-18 --scan-dates 5

    ${c.dim}# Only show offers with booking links${c.reset}
    node flight_search.js PRG BCN 2026-04-18 --bookable-only

    ${c.dim}# Monitor every 30 min for error fares${c.reset}
    node flight_search.js PRG BCN 2026-04-18 --monitor 30

    ${c.dim}# Export to JSON + 2 passengers${c.reset}
    node flight_search.js JFK LAX 2026-05-01 --pax 2 --json deals.json

  ${c.bold}Options:${c.reset}
    --pax <N>            Passengers (default: 1)
    --json <file>        Export results to JSON
    --bookable-only      Only show offers with booking links
    --scan-dates <N>     Scan ±N days around departure date
    --monitor <mins>     Re-check every N minutes for error fares
    -h, --help           Show this help

  ${c.bold}npm scripts:${c.reset}
    npm run search -- PRG BCN 2026-04-18
    npm run deals -- PRG BCN 2026-04-18
    npm run monitor -- PRG BCN 2026-04-18
`);
        process.exit(0);
    }

    // Parse args
    const from = args[0].toUpperCase();
    const to = args[1].toUpperCase();
    const departDate = args[2];
    let returnDate = null;
    let passengers = 1;
    let jsonFile = null;
    let bookableOnly = false;
    let scanDays = 0;
    let monitorMins = 0;

    if (args[3] && !args[3].startsWith('-')) returnDate = args[3];

    for (let i = 3; i < args.length; i++) {
        switch (args[i]) {
            case '--pax':           passengers = parseInt(args[++i]) || 1; break;
            case '--json':          jsonFile = args[++i]; break;
            case '--bookable-only': bookableOnly = true; break;
            case '--scan-dates':    scanDays = parseInt(args[++i]) || 3; break;
            case '--monitor':       monitorMins = parseInt(args[++i]) || 30; break;
        }
    }

    // Validate
    if (!isValidIATA(from)) { log('err', `Invalid IATA: ${c.bold}${from}${c.reset} (need 3 letters, e.g. PRG)`); process.exit(1); }
    if (!isValidIATA(to)) { log('err', `Invalid IATA: ${c.bold}${to}${c.reset} (need 3 letters, e.g. BCN)`); process.exit(1); }
    if (!isValidDate(departDate)) { log('err', `Invalid date: ${c.bold}${departDate}${c.reset} (use YYYY-MM-DD)`); process.exit(1); }
    if (returnDate && !isValidDate(returnDate)) { log('err', `Invalid return date: ${c.bold}${returnDate}${c.reset}`); process.exit(1); }

    const params = { from, to, departDate, returnDate, passengers };

    // ── Mode: Monitor ────────────────────────────────────────
    if (monitorMins > 0) {
        log('monitor', `Monitoring ${c.bold}${from}→${to}${c.reset} every ${c.bold}${monitorMins} min${c.reset} — watching for error fares`);
        let lowestSeen = Infinity;
        let runCount = 0;

        while (true) {
            runCount++;
            console.log('');
            log('monitor', `${c.dim}Run #${runCount} at ${new Date().toLocaleTimeString()}${c.reset}`);

            const data = await searchFlights(params, true);

            if (data.offers.length > 0) {
                const cheapest = data.offers[0];
                const isNew = cheapest.price < lowestSeen;
                if (isNew) lowestSeen = cheapest.price;

                const arrow = isNew ? `${c.green}↓ NEW LOW` : `${c.dim}=`;
                log('info', `Cheapest: ${c.bold}€${cheapest.price}${c.reset} ${arrow}${c.reset} (${cheapest.airline}, ${cheapest.source})`);

                if (data.errorFares.length > 0) {
                    log('error_fare', `${c.red}${c.bold}${data.errorFares.length} ERROR FARE(S) DETECTED!${c.reset}`);
                    for (const ef of data.errorFares) {
                        log('error_fare', `€${ef.price} on ${ef.airline} — ${ef.dealReasons.join(' · ')}`);
                        if (ef.bookingUrl) log('deal', `🔗 ${c.cyan}${c.underline}${ef.bookingUrl}${c.reset}`);
                    }
                    // Save alert
                    writeFileSync('error_fare_alert.json', JSON.stringify({ timestamp: new Date().toISOString(), fares: data.errorFares }, null, 2));
                }

                if (data.deals.filter(d => d.dealTag === 'HOT_DEAL').length > 0) {
                    const hots = data.deals.filter(d => d.dealTag === 'HOT_DEAL');
                    log('deal', `${hots.length} hot deal(s) — cheapest: €${hots[0].price}`);
                }
            } else {
                log('warn', 'No results this run');
            }

            log('monitor', `${c.dim}Next check in ${monitorMins} minutes... (Ctrl+C to stop)${c.reset}`);
            await sleep(monitorMins * 60 * 1000);
        }
    }

    // ── Mode: Date Range Scan ────────────────────────────────
    if (scanDays > 0) {
        const tripType = returnDate ? 'round-trip' : 'one-way';
        log('search', `${c.bold}${from} → ${to}${c.reset} | ±${scanDays} days around ${departDate} | ${tripType}`);

        const scanData = await scanDateRange(params, scanDays);
        printDateScanResults(scanData, params);

        if (jsonFile) {
            writeFileSync(jsonFile, JSON.stringify(scanData, null, 2));
            log('ok', `Exported → ${c.bold}${jsonFile}${c.reset}`);
        }
        writeFileSync('last_scan.json', JSON.stringify(scanData, null, 2));
        log('info', `Full scan saved → ${c.bold}last_scan.json${c.reset}`);
        return;
    }

    // ── Mode: Single Search ──────────────────────────────────
    const tripType = returnDate ? 'round-trip' : 'one-way';
    log('search', `${c.bold}${from} → ${to}${c.reset} | ${departDate}${returnDate ? ` → ${returnDate}` : ''} | ${passengers} pax | ${tripType}`);
    console.log('');

    const keys = loadKeys();
    const active = Object.keys(PROVIDERS).filter(id => keys[id]?.length > 0);
    log('info', `${c.bold}${active.length} providers${c.reset} active: ${active.map(p => PROVIDERS[p].name).join(', ')}`);

    const startTime = Date.now();
    const data = await searchFlights(params);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    log('ok', `Done in ${c.bold}${elapsed}s${c.reset} — ${data.totalOffers} flights, ${data.errorFares.length} error fares, ${data.deals.length} deals`);

    if (bookableOnly) {
        data.offers = data.offers.filter(o => o.bookingUrl);
        data.totalOffers = data.offers.length;
        data.deals = data.deals.filter(o => o.bookingUrl);
        data.errorFares = data.errorFares.filter(o => o.bookingUrl);
    }

    printResults(data, params);

    if (jsonFile) {
        writeFileSync(jsonFile, JSON.stringify(data, null, 2));
        log('ok', `Exported → ${c.bold}${jsonFile}${c.reset}`);
    }

    writeFileSync('last_results.json', JSON.stringify(data, null, 2));
    log('info', `Full results → ${c.bold}last_results.json${c.reset}`);
}

// Only run CLI when executed directly (not when imported as module)
const isDirectRun = process.argv[1] && (
    process.argv[1].endsWith('flight_search.js') ||
    process.argv[1].replace(/\\/g, '/').endsWith('flight_search.js')
);
if (isDirectRun) {
    main().catch(err => { log('err', `Fatal: ${err.message}`); process.exit(1); });
}
