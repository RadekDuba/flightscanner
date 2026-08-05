#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   FLIGHT KEY SCANNER — Scans GitHub for flight/travel API keys
   Providers: Duffel (LIVE only), SerpAPI (Google Flights), Kiwi.com Tequila
   ═══════════════════════════════════════════════════════════ */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
    bgRed: '\x1b[41m', bgGreen: '\x1b[42m', magenta: '\x1b[35m',
};

function log(level, msg) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const prefix = {
        info: `${c.blue}[INFO]${c.reset}`,
        ok: `${c.green}[OK]${c.reset}`,
        warn: `${c.yellow}[WARN]${c.reset}`,
        err: `${c.red}[ERR]${c.reset}`,
        scan: `${c.cyan}[SCAN]${c.reset}`,
        valid: `${c.magenta}[VALIDATE]${c.reset}`,
        key: `${c.bgGreen}${c.white}${c.bold} KEY ${c.reset}`,
    }[level] || `[${level}]`;
    console.log(`  ${c.gray}${time}${c.reset} ${prefix} ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function maskKey(key) {
    if (key.length <= 12) return key.substring(0, 4) + '•'.repeat(key.length - 4);
    return key.substring(0, 10) + '•'.repeat(Math.min(key.length - 14, 10)) + key.substring(key.length - 4);
}

async function safeFetch(url, opts = {}) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { ...opts, signal: controller.signal });
        clearTimeout(timeout);
        return res;
    } catch (err) {
        return { status: 0, ok: false, json: async () => null, text: async () => err.message };
    }
}

function isPlaceholder(val) {
    const lower = val.toLowerCase();
    const bad = ['your_', 'placeholder', 'xxx', 'INSERT', 'REPLACE', 'TODO', 'CHANGEME',
        'example', 'test_key', 'dummy', 'fake', 'sample', 'demo', '<', '>', '{', '}',
        'put_your', 'enter_your', 'undefined', 'null', 'none'];
    return bad.some(p => lower.includes(p));
}

// ─── Flight API Patterns ────────────────────────────────────
const PATTERNS = [
    {
        id: 'duffel',
        name: 'Duffel (Live Only)',
        survivalRate: 90,
        queries: [
            '"duffel_live_" extension:env NOT "placeholder"',
            '"DUFFEL_ACCESS_TOKEN" "duffel_live_" extension:env NOT "placeholder"',
        ],
        regex: /duffel_live_[A-Za-z0-9_-]{30,}/g,
        envVars: ['DUFFEL_ACCESS_TOKEN', 'DUFFEL_TOKEN', 'DUFFEL_API_TOKEN'],
        validate: async (key) => {
            if (!key.startsWith('duffel_live_')) return { valid: false, info: 'TEST key — skipped (need LIVE)' };
            const res = await safeFetch('https://api.duffel.com/air/airports?limit=1', {
                headers: { 'Authorization': `Bearer ${key}`, 'Duffel-Version': 'v2', 'Accept': 'application/json' }
            });
            if (res.status === 200) return { valid: true, info: 'Active — LIVE mode' };
            if (res.status === 401) return { valid: false, info: 'Invalid / revoked' };
            return { valid: null, info: `HTTP ${res.status}` };
        },
        searchFn: 'duffel',
    },
    {
        id: 'serpapi',
        name: 'SerpAPI (Google Flights)',
        survivalRate: 39,
        queries: [
            '"SERPAPI_KEY" extension:env NOT "your" NOT "xxx" NOT "placeholder"',
            '"SERPAPI_API_KEY" extension:env NOT "your" NOT "placeholder"',
            '"SERP_API_KEY" extension:env NOT "your" NOT "xxx"',
        ],
        regex: /[a-f0-9]{64}/g,
        envVars: ['SERPAPI_KEY', 'SERPAPI_API_KEY', 'SERP_API_KEY'],
        validate: async (key) => {
            const res = await safeFetch(`https://serpapi.com/account.json?api_key=${key}`);
            if (res.status === 200) {
                const data = await res.json().catch(() => ({}));
                const remaining = data.searches_remaining ?? 0;
                if (remaining === 0) return { valid: false, info: `Depleted — 0 searches left (${data.plan_name})` };
                return {	valid: true, info: `Active — ${data.plan_name}, ${remaining} searches left` };
            }
            if (res.status === 401) return { valid: false, info: 'Invalid / revoked' };
            return { valid: null, info: `HTTP ${res.status}` };
        },
        searchFn: 'serpapi',
    },
    {
        id: 'kiwi',
        name: 'Kiwi.com Tequila',
        survivalRate: 21,
        queries: [
            '"KIWI_API_KEY" extension:env NOT "your" NOT "xxx" NOT "placeholder"',
            '"TEQUILA_API_KEY" extension:env NOT "your" NOT "placeholder"',
            '"kiwi" "apikey" extension:env NOT "placeholder"',
        ],
        regex: /[A-Za-z0-9_-]{20,}/g,
        envVars: ['KIWI_API_KEY', 'TEQUILA_API_KEY', 'KIWI_TEQUILA_KEY'],
        validate: async (key) => {
            const d = new Date();
            d.setDate(d.getDate() + 30);
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            const fmt = `${dd}/${mm}/${yyyy}`;
            const res = await safeFetch(`https://api.tequila.kiwi.com/v2/search?fly_from=PRG&fly_to=LHR&date_from=${fmt}&date_to=${fmt}&adults=1&limit=1`, {
                headers: { 'apikey': key }
            });
            if (res.status === 200) return { valid: true, info: 'Active — flight search works' };
            if (res.status === 401 || res.status === 403) return { valid: false, info: 'Invalid / revoked' };
            return { valid: null, info: `HTTP ${res.status}` };
        },
        searchFn: 'kiwi',
    },
];

// ─── GitHub Code Search ─────────────────────────────────────
async function searchGitHub(token, query, perPage = 30) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${Math.min(perPage, 100)}`;
    const res = await safeFetch(url, {
        headers: {
            'Authorization': token.startsWith('ghp_') ? `token ${token}` : `Bearer ${token}`,
            'Accept': 'application/vnd.github.text-match+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'FlightScanner/1.0',
        }
    });
    if (res.status === 403 || res.status === 429) throw new Error('RATE_LIMIT');
    if (res.status === 401) {
        const body = await res.text().catch(() => '');
        log('err', `GitHub 401 Body: ${body}`);
        throw new Error('UNAUTHORIZED');
    }
    if (res.status === 0) throw new Error('NETWORK_ERROR');
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json();
    return data.items || [];
}

function extractKey(item, pattern) {
    if (!item.text_matches) return null;
    for (const tm of item.text_matches) {
        const fragment = tm.fragment || '';
        for (const envVar of (pattern.envVars || [])) {
            const idx = fragment.indexOf(envVar);
            if (idx !== -1) {
                const afterEquals = fragment.substring(idx + envVar.length).replace(/^[\s='"]+/, '');
                const value = afterEquals.split(/[\s'"#\n\r]/)[0];
                if (value.length > 8 && !isPlaceholder(value)) return value;
            }
        }
        if (pattern.regex) {
            const copy = new RegExp(pattern.regex.source, pattern.regex.flags);
            const match = copy.exec(fragment);
            if (match && !isPlaceholder(match[0])) return match[0];
        }
    }
    return null;
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
    console.log(`
${c.cyan}${c.bold}  ╔══════════════════════════════════════════════════════════╗
  ║                                                          ║
  ║  ✈️  FLIGHT KEY SCANNER                                   ║
  ║  GitHub → Duffel (live) + Kiwi.com Tequila keys           ║
  ║                                                          ║
  ╚══════════════════════════════════════════════════════════╝${c.reset}
`);

    const args = process.argv.slice(2);
    let token = process.env.GITHUB_TOKEN || '';
    let maxResults = 30;
    let skipScan = false;
    let inputFile = '';

    // Load .env (local file overrides process.env)
    if (existsSync(resolve('.env'))) {
        const env = readFileSync(resolve('.env'), 'utf-8');
        const m = env.match(/^GITHUB_TOKEN=(.+)$/m);
        if (m) token = m[1].trim().replace(/^['"]|['"]$/g, '');
    } else if (existsSync(resolve('../.env'))) {
        const env = readFileSync(resolve('../.env'), 'utf-8');
        const m = env.match(/^GITHUB_TOKEN=(.+)$/m);
        if (m) token = m[1].trim().replace(/^['"]|['"]$/g, '');
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--token': case '-t': token = args[++i]; break;
            case '--max': case '-m': maxResults = parseInt(args[++i]) || 30; break;
            case '--input': case '-i': inputFile = args[++i]; skipScan = true; break;
            case '--skip-scan': skipScan = true; break;
            case '--force': case '-f': break; // handled below
        }
    }

    const forceRescan = args.includes('--force') || args.includes('-f');

    // Smart skip: don't re-scan if active_keys.json already has working keys
    if (!forceRescan && existsSync('active_keys.json')) {
        try {
            const existing = JSON.parse(readFileSync('active_keys.json', 'utf-8'));
            const providers = Object.entries(existing).filter(([, keys]) => keys.length > 0);
            const totalKeys = providers.reduce((sum, [, keys]) => sum + keys.length, 0);
            if (totalKeys > 0) {
                console.log(`  ${c.green}${c.bold}✓ active_keys.json already has ${totalKeys} working keys:${c.reset}`);
                for (const [provider, keys] of providers) {
                    console.log(`    ${c.cyan}${provider}${c.reset}: ${keys.length} key${keys.length > 1 ? 's' : ''}`);
                }
                console.log(`\n  ${c.dim}To force a fresh scan, run: ${c.bold}node scan_keys.js --force${c.reset}`);
                console.log('');
                return;
            }
        } catch { /* corrupted file — proceed with scan */ }
    }

    let results = [];

    if (skipScan && inputFile) {
        log('info', `Loading from ${c.bold}${inputFile}${c.reset}`);
        const data = JSON.parse(readFileSync(inputFile, 'utf-8'));
        results = (data.results || []).map(r => ({ ...r, validation: null }));
        log('ok', `Loaded ${results.length} keys for re-validation`);
    } else {
        if (!token) {
            log('err', 'GitHub token required. Use --token or set GITHUB_TOKEN in .env');
            process.exit(1);
        }

        // Sort by survival rate (highest first)
        const sorted = [...PATTERNS].sort((a, b) => b.survivalRate - a.survivalRate);
        const allQueries = [];
        for (const p of sorted) {
            for (const q of p.queries) allQueries.push({ query: q, pattern: p });
        }

        log('scan', `${c.bold}${allQueries.length} queries${c.reset} across ${c.bold}${sorted.length} flight API providers${c.reset}`);
        log('info', `Token being used: ${maskKey(token)} (len: ${token.length})`);
        console.log(`  ${c.gray}${'─'.repeat(56)}${c.reset}`);

        const seen = new Set();
        let qi = 0;

        for (const { query, pattern } of allQueries) {
            qi++;
            log('scan', `${c.dim}[${qi}/${allQueries.length}]${c.reset} ${c.bold}${pattern.name}${c.reset} → ${c.dim}${query.substring(0, 60)}...${c.reset}`);

            try {
                const items = await searchGitHub(token, query, maxResults);
                for (const item of items) {
                    const rawKey = extractKey(item, pattern);
                    if (!rawKey) continue;
                    const dedup = `${rawKey}:${pattern.id}`;
                    if (seen.has(dedup)) continue;
                    seen.add(dedup);

                    results.push({
                        type: pattern.name, typeId: pattern.id,
                        key: rawKey, keyMasked: maskKey(rawKey),
                        repo: item.repository?.full_name || '',
                        filePath: item.path || '',
                        fileUrl: item.html_url || '',
                        validation: null,
                        searchFn: pattern.searchFn,
                        timestamp: new Date().toISOString(),
                    });
                    log('key', `${c.yellow}${maskKey(rawKey)}${c.reset} ${c.dim}— ${item.repository?.full_name}${c.reset}`);
                }
                if (items.length > 0) log('ok', `${items.length} results, ${results.length} unique keys`);
            } catch (err) {
                if (err.message === 'RATE_LIMIT') {
                    log('warn', 'Rate limited — waiting 65s...');
                    await sleep(65000); qi--; continue;
                } else if (err.message === 'UNAUTHORIZED') {
                    log('err', 'GitHub token invalid!'); break;
                } else {
                    log('err', `Query failed: ${err.message}`);
                }
            }
            await sleep(6500);
        }
    }

    if (results.length === 0) { log('info', 'No keys found.'); return; }
    log('ok', `Found ${c.bold}${results.length}${c.reset} flight API keys`);

    // ─── VALIDATE ───────────────────────────────────────────
    console.log('');
    log('info', `${c.bold}Validating ${results.length} keys...${c.reset}`);
    let valid = 0, invalid = 0, unknown = 0;

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const pattern = PATTERNS.find(p => p.id === r.typeId);
        if (!pattern) { r.validation = { valid: null, info: 'No validator' }; unknown++; continue; }

        log('valid', `[${i + 1}/${results.length}] ${c.bold}${r.type}${c.reset}: ${c.yellow}${r.keyMasked}${c.reset}`);
        try {
            const v = await pattern.validate(r.key);
            r.validation = v;
            if (v.valid === true) { valid++; log('key', `${c.green}✓ ${v.info}${c.reset}`); }
            else if (v.valid === false) { invalid++; log('info', `${c.dim}✗ ${v.info}${c.reset}`); }
            else { unknown++; log('warn', `? ${v.info}`); }
        } catch (err) {
            r.validation = { valid: null, info: err.message }; unknown++;
        }
        await sleep(500);
    }

    // ─── DEEP VALIDATE (check balance/quota) ────────────────
    const validResults = results.filter(r => r.validation?.valid === true);
    const deepable = validResults.filter(r => {
        const p = PATTERNS.find(pp => pp.id === r.typeId);
        return p?.deepValidate;
    });

    if (deepable.length > 0) {
        console.log('');
        log('info', `${c.bold}Deep validating ${deepable.length} keys (checking quota/balance)...${c.reset}`);
        for (const r of deepable) {
            const p = PATTERNS.find(pp => pp.id === r.typeId);
            try {
                const deep = await p.deepValidate(r.key);
                r.deepValidation = deep;
                if (deep.usable) log('key', `${c.green}✓ USABLE — ${deep.tier}: ${deep.details}${c.reset}`);
                else log('warn', `✗ NOT USABLE — ${deep.tier}: ${deep.details}`);
            } catch (err) {
                r.deepValidation = { usable: false, tier: 'ERROR', details: err.message };
            }
            await sleep(500);
        }
    }

    // ─── REPORT ─────────────────────────────────────────────
    console.log('');
    console.log(`  ${c.cyan}${c.bold}═══════════════════════════════════════════════════${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}         FLIGHT KEY SCAN REPORT${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}═══════════════════════════════════════════════════${c.reset}`);
    console.log('');
    console.log(`  Total found:  ${c.bold}${results.length}${c.reset}`);
    console.log(`  ${c.green}✓ Valid:       ${c.bold}${valid}${c.reset}`);
    console.log(`  ${c.dim}✗ Invalid:     ${invalid}${c.reset}`);
    console.log(`  ${c.yellow}? Unknown:     ${unknown}${c.reset}`);
    console.log('');

    // Group by type
    const byType = {};
    for (const r of results) {
        if (!byType[r.type]) byType[r.type] = { total: 0, valid: 0, usable: 0 };
        byType[r.type].total++;
        if (r.validation?.valid === true) byType[r.type].valid++;
        if (r.deepValidation?.usable === true) byType[r.type].usable++;
    }
    for (const [type, counts] of Object.entries(byType)) {
        const usableStr = counts.usable > 0 ? ` ${c.green}(${counts.usable} usable)${c.reset}` : '';
        console.log(`  ${type.padEnd(30)} ${String(counts.total).padStart(3)} found  ${c.green}✓${counts.valid}${c.reset} ${c.dim}✗${counts.total - counts.valid}${c.reset}${usableStr}`);
    }

    // Show usable keys for flight search
    const searchable = validResults.filter(r => r.searchFn);
    if (searchable.length > 0) {
        console.log('');
        console.log(`  ${c.bgGreen}${c.white}${c.bold} ✈️  KEYS READY FOR FLIGHT SEARCH ✈️  ${c.reset}`);
        for (const r of searchable) {
            const isTestKey = r.searchFn === 'duffel' && r.key.startsWith('duffel_test_');
            const isDepleted = r.deepValidation?.usable === false;
            if (isTestKey) {
                console.log(`  ${c.dim}✗ ${r.type} → ${r.keyMasked} (TEST KEY — filtered out)${c.reset}`);
            } else if (isDepleted) {
                console.log(`  ${c.dim}✗ ${r.type} → ${r.keyMasked} (DEPLETED — filtered out)${c.reset}`);
            } else {
                const usable = r.deepValidation?.usable !== false;
                const icon = usable ? '✓' : '⚠';
                console.log(`  ${icon} ${c.bold}${r.type}${c.reset} → ${c.yellow}${r.keyMasked}${c.reset} ${c.dim}(${r.searchFn})${c.reset}`);
            }
        }
    }

    // Save
    // Save only usable keys
    const usableKeys = {};
    for (const r of searchable) {
        if (!usableKeys[r.searchFn]) usableKeys[r.searchFn] = [];
        usableKeys[r.searchFn].push({
            key: r.key,
            info: r.validation?.info || '',
        });
    }
    const totalUsable = Object.values(usableKeys).reduce((sum, arr) => sum + arr.length, 0);
    writeFileSync('active_keys.json', JSON.stringify(usableKeys, null, 2));
    log('ok', `${c.green}${c.bold}${totalUsable} usable keys${c.reset} → ${c.bold}active_keys.json${c.reset}`);

    console.log('');
}

main().catch(err => { log('err', `Fatal: ${err.message}`); process.exit(1); });
