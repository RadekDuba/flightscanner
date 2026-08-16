/* ═══════════════════════════════════════════════════════════
   FLIGHTSCANNER — Self-Transfer & Hub-Spoke Combo Engine
   Combines independent low-cost carrier flights through European mega-hubs
   ═══════════════════════════════════════════════════════════ */

import { readFileSync, existsSync } from 'fs';

// Major European self-transfer connection hubs
export const MAJOR_HUBS = [
    { code: 'STN', city: 'LON', name: 'London Stansted' },
    { code: 'LTN', city: 'LON', name: 'London Luton' },
    { code: 'LGW', city: 'LON', name: 'London Gatwick' },
    { code: 'BGY', city: 'MIL', name: 'Milan Bergamo' },
    { code: 'MXP', city: 'MIL', name: 'Milan Malpensa' },
    { code: 'BCN', city: 'BCN', name: 'Barcelona' },
    { code: 'MAD', city: 'MAD', name: 'Madrid' },
    { code: 'ATH', city: 'ATH', name: 'Athens' },
    { code: 'LIS', city: 'LIS', name: 'Lisbon' },
    { code: 'IST', city: 'IST', name: 'Istanbul' },
];

/**
 * Validates self-transfer connection buffer between Leg 1 arrival and Leg 2 departure
 * @param {string} arriveTime ISO string or time string
 * @param {string} departTime ISO string or time string
 * @param {number} minHours Minimum hours needed for baggage re-check & security (default 3.5)
 * @param {number} maxHours Maximum allowed layover hours (default 14)
 */
export function isValidTransferBuffer(arriveTime, departTime, minHours = 3.5, maxHours = 14) {
    if (!arriveTime || !departTime) return true; // Fallback if exact times missing
    const arr = new Date(arriveTime).getTime();
    const dep = new Date(departTime).getTime();
    if (isNaN(arr) || isNaN(dep)) return true;

    const diffHours = (dep - arr) / (1000 * 60 * 60);
    return diffHours >= minHours && diffHours <= maxHours;
}

/**
 * Builds Self-Transfer Hub & Spoke combinations from raw flight offers
 * @param {Array} leg1Flights Flights from Origin → Hub (e.g., PRG → STN)
 * @param {Array} leg2Flights Flights from Hub → Destination (e.g., STN → KEF)
 */
export function buildHubSpokeCombos(leg1Flights, leg2Flights) {
    const combos = [];

    for (const l1 of leg1Flights) {
        for (const l2 of leg2Flights) {
            // Must connect at same hub airport or city
            if (l1.dest !== l2.origin) continue;

            // Check layover buffer safety
            if (!isValidTransferBuffer(l1.arrival, l2.departure)) continue;

            const totalPrice = Math.round((l1.price + l2.price) * 100) / 100;
            const hubName = l1.destName || l1.dest;
            let layoverHours = 4;
            if (l1.arrival && l2.departure) {
                const arr = new Date(l1.arrival).getTime();
                const dep = new Date(l2.departure).getTime();
                if (!isNaN(arr) && !isNaN(dep) && dep > arr) {
                    layoverHours = Math.round(((dep - arr) / (1000 * 60 * 60)) * 10) / 10;
                }
            }

            const retDate = l2.returnDate || l1.returnDate;
            const [yyyy, mm, dd] = l1.date.split('-');
            const [ryyyy, rmm, rdd] = (retDate || l1.date).split('-');
            const skyscannerUrl = `https://www.skyscanner.net/transport/flights/${l1.origin.toLowerCase()}/${l2.dest.toLowerCase()}/${yyyy.substring(2)}${mm}${dd}/${ryyyy.substring(2)}${rmm}${rdd}/`;
            const googleFlightsUrl = `https://www.google.com/travel/flights?q=flights+from+${l1.origin}+to+${l2.dest}+on+${l1.date}+through+${retDate}`;

            combos.push({
                origin: l1.origin,
                hub: l1.dest,
                hubName,
                dest: l2.dest,
                destName: l2.destName,
                country: l2.country,
                date: l1.date,
                returnDate: retDate,
                tripDays: l1.tripDays || 7,
                price: totalPrice,
                currency: 'EUR',
                airline: `${l1.airline} + ${l2.airline}`,
                stops: 1,
                isSelfTransfer: true,
                layovers: {
                    outbound: [{ code: l1.dest, city: hubName, hours: layoverHours }],
                    return: []
                },
                bookingLinks: {
                    airline: {
                        name: `${l1.airline || 'Leg 1'} + ${l2.airline || 'Leg 2'}`,
                        url: l1.bookingLinks?.airline?.url || l1.bookingLinks?.skyscanner || '#'
                    },
                    leg1: l1.bookingLinks?.airline || null,
                    leg2: l2.bookingLinks?.airline || null,
                    skyscanner: skyscannerUrl,
                    googleFlights: googleFlightsUrl,
                },
                source: 'self_transfer_combo',
            });
        }
    }

    return combos.sort((a, b) => a.price - b.price);
}
