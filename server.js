#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
//  FLIGHTSCANNER — High-Performance Local & API Server
//  Serves the Tactical Glassmorphism dashboard & live API endpoints
// ═══════════════════════════════════════════════════════════

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname, normalize } from 'path';
import { spawn } from 'child_process';
import { getRoutePriceHistory } from './history_db.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT_DIR = resolve('.');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
    '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
};

// Files that should never be served directly via HTTP
const BLOCKED_PATTERNS = [
    /\.env($|\.)/i,
    /^\.git/i,
    /\.key$/i,
    /\.pem$/i,
    /node_modules/i,
    /package(-lock)?\.json$/i,
];

let activeHuntProcess = null;
let activeHuntStartTime = null;

const server = createServer((req, res) => {
    // Global CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;

    // ─── API Endpoints ──────────────────────────────────────────

    // POST / GET /api/trigger-hunt
    if (pathname === '/api/trigger-hunt') {
        if (activeHuntProcess) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'running', message: 'Hunt already in progress', startedAt: activeHuntStartTime }));
            return;
        }
        const daysParam = parseInt(parsedUrl.searchParams.get('days') || '90', 10);
        const days = isNaN(daysParam) ? 90 : Math.min(365, Math.max(1, daysParam));

        activeHuntStartTime = new Date().toISOString();
        activeHuntProcess = spawn('node', ['error_fare_hunter.js', '--days', String(days)], { cwd: ROOT_DIR });

        activeHuntProcess.on('exit', () => {
            activeHuntProcess = null;
            activeHuntStartTime = null;
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'started', message: `Flight hunt launched for next ${days} days`, days, startedAt: activeHuntStartTime }));
        return;
    }

    // GET /api/history?origin=PRG&dest=BCN
    if (pathname === '/api/history') {
        const origin = (parsedUrl.searchParams.get('origin') || '').toUpperCase();
        const dest = (parsedUrl.searchParams.get('dest') || '').toUpperCase();
        const history = getRoutePriceHistory(origin, dest);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ origin, dest, history }));
        return;
    }

    // GET /api/crashes
    if (pathname === '/api/crashes') {
        const reportPath = resolve(ROOT_DIR, 'error_fares_report.json');
        let crashes = [];
        if (existsSync(reportPath)) {
            try {
                const rep = JSON.parse(readFileSync(reportPath, 'utf-8'));
                crashes = (rep.allResults || []).filter(r => !!r.priceCrash);
            } catch { /* parse error */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: crashes.length, crashes }));
        return;
    }

    // GET /api/report
    if (pathname === '/api/report') {
        const reportPath = resolve(ROOT_DIR, 'error_fares_report.json');
        if (!existsSync(reportPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Report not generated yet. Run: npm run hunt' }));
            return;
        }
        try {
            const data = readFileSync(reportPath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read report', details: err.message }));
        }
        return;
    }

    // GET /api/status
    if (pathname === '/api/status') {
        const keysExist = existsSync(resolve(ROOT_DIR, 'active_keys.json'));
        const reportPath = resolve(ROOT_DIR, 'error_fares_report.json');
        let reportMeta = null;
        if (existsSync(reportPath)) {
            try {
                const rep = JSON.parse(readFileSync(reportPath, 'utf-8'));
                reportMeta = {
                    scannedAt: rep.scanDate || rep.scannedAt,
                    totalRoutes: rep.allResults?.length || 0,
                    errorFares: rep.allResults?.filter(r => r.score?.tag === 'ERROR FARE').length || 0,
                    greatDeals: rep.allResults?.filter(r => r.score?.tag === 'GREAT DEAL').length || 0,
                };
            } catch { /* parse error */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            isHunting: !!activeHuntProcess,
            keysConfigured: keysExist,
            report: reportMeta,
            uptimeSeconds: Math.floor(process.uptime()),
        }));
        return;
    }

    // ─── Static File Serving with Path Traversal Protection ──────
    let reqFile = (pathname === '/' || pathname === '/map.html') ? '/index.html' : pathname;
    // Decode URI components safely
    try { reqFile = decodeURIComponent(reqFile); } catch { /* keep raw */ }

    // Normalize and prevent directory traversal
    const safePath = resolve(ROOT_DIR, '.' + normalize(reqFile));

    // Security check: Must reside within ROOT_DIR
    if (!safePath.startsWith(ROOT_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access denied');
        return;
    }

    // Block sensitive files
    const relFile = reqFile.replace(/^\/+/, '');
    if (BLOCKED_PATTERNS.some(re => re.test(relFile))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access denied');
        return;
    }

    if (!existsSync(safePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    try {
        const ext = extname(safePath).toLowerCase();
        const contentType = MIME[ext] || 'application/octet-stream';
        const content = readFileSync(safePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Internal error: ${err.message}`);
    }
});

server.listen(PORT, () => {
    console.log(`\n  🗺️  FlightScanner Dashboard → http://localhost:${PORT}\n`);
});

process.on('SIGINT', () => {
    if (activeHuntProcess) activeHuntProcess.kill();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (activeHuntProcess) activeHuntProcess.kill();
    process.exit(0);
});
