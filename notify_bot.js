/* ═══════════════════════════════════════════════════════════
   FLIGHTSCANNER — Telegram Alert Bot Module
   Sends instant formatted deal alerts with inline booking buttons
   ═══════════════════════════════════════════════════════════ */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadEnvConfig() {
    let token = process.env.TELEGRAM_BOT_TOKEN || '';
    let chatId = process.env.TELEGRAM_CHAT_ID || '';

    if (existsSync(resolve('.env'))) {
        const env = readFileSync(resolve('.env'), 'utf-8');
        const mToken = env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
        if (mToken) token = mToken[1].trim().replace(/^['"]|['"]$/g, '');
        const mChat = env.match(/^TELEGRAM_CHAT_ID=(.+)$/m);
        if (mChat) chatId = mChat[1].trim().replace(/^['"]|['"]$/g, '');
    }
    return { token, chatId };
}

export async function sendTelegramAlert(deal) {
    const { token, chatId } = loadEnvConfig();
    if (!token || !chatId) {
        // Silent return if Telegram credentials are not set
        return false;
    }

    const tagEmoji = deal.score?.emoji || '🔥';
    const tagText = deal.score?.tag || 'ERROR FARE';
    const discount = deal.score?.discount || 0;
    const baseline = deal.score?.baseline || '—';
    const savings = Math.max(0, (baseline - deal.price) || 0);

    const messageText = `
${tagEmoji} <b>${tagText} DETECTED!</b> (${discount}% OFF)

✈️ <b>${deal.origin} → ${deal.destName} (${deal.dest})</b>
💰 <b>Price: €${deal.price}</b> <s>(Baseline: €${baseline})</s>
💵 <b>Total Savings: €${savings}</b>

📅 <b>Dates:</b> ${deal.date} → ${deal.returnDate} (${deal.tripDays} days)
🛩️ <b>Airline:</b> ${deal.airline} ${deal.stops > 0 ? `(${deal.stops} stop)` : '(Direct)'}
📊 <b>Haul:</b> ${deal.score?.distance || 'medium'}-haul ${deal.score?.isLCC ? 'LCC' : 'Legacy'}

${deal.crossCheck ? `🔍 <i>Duffel Verification: €${deal.crossCheck.duffelPrice || '—'} (${deal.crossCheck.status})</i>` : ''}
`.trim();

    const inlineKeyboard = [];
    if (deal.bookingLinks?.airline?.url) {
        inlineKeyboard.push([{ text: `🔗 Book on ${deal.bookingLinks.airline.name || 'Airline'}`, url: deal.bookingLinks.airline.url }]);
    }
    if (deal.bookingLinks?.skyscanner) {
        inlineKeyboard.push([{ text: '✈️ View on Skyscanner', url: deal.bookingLinks.skyscanner }]);
    }
    if (deal.bookingLinks?.googleFlights) {
        inlineKeyboard.push([{ text: '🌍 View on Google Flights', url: deal.bookingLinks.googleFlights }]);
    }
    if (deal.deepLink) {
        inlineKeyboard.push([{ text: '🥝 Book on Kiwi.com', url: deal.deepLink }]);
    }

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: messageText,
                parse_mode: 'HTML',
                disable_web_page_preview: false,
                reply_markup: { inline_keyboard: inlineKeyboard }
            })
        });
        const data = await res.json();
        return data.ok === true;
    } catch (err) {
        console.error(`[Telegram Alert Error] ${err.message}`);
        return false;
    }
}
