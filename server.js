#!/usr/bin/env node
// Simple static file server for the deal map
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { spawn } from 'child_process';
import { getRoutePriceHistory } from './history_db.js';

const PORT = 3000;
const MIME = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.json': 'application/json', '.css': 'text/css',
    '.png': 'image/png', '.svg': 'image/svg+xml',
};

let activeHuntProcess = null;
let activeHuntStartTime = null;

createServer((req, res) => {
    // Global CORS headers & OPTIONS preflight handler
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API Endpoints
    if (req.url.startsWith('/api/trigger-hunt')) {
        if (activeHuntProcess) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'running', message: 'Hunt already in progress', startedAt: activeHuntStartTime }));
            return;
        }
        const u = new URL(req.url, 'http://localhost:3000');
        const daysParam = parseInt(u.searchParams.get('days') || '30', 10);
        const days = isNaN(daysParam) ? 30 : Math.min(365, Math.max(1, daysParam));

        activeHuntStartTime = new Date().toISOString();
        activeHuntProcess = spawn('node', ['error_fare_hunter.js', '--days', String(days)], { cwd: resolve('.') });

        activeHuntProcess.on('exit', () => {
            activeHuntProcess = null;
            activeHuntStartTime = null;
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'started', message: `Flight hunt launched for next ${days} days`, days, startedAt: activeHuntStartTime }));
        return;
    }

    if (req.url.startsWith('/api/history')) {
        const u = new URL(req.url, 'http://localhost:3000');
        const origin = u.searchParams.get('origin') || '';
        const dest = u.searchParams.get('dest') || '';
        const history = getRoutePriceHistory(origin, dest);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ origin, dest, history }));
        return;
    }

    if (req.url === '/api/crashes') {
        const reportPath = resolve('./error_fares_report.json');
        let crashes = [];
        if (existsSync(reportPath)) {
            try {
                const rep = JSON.parse(readFileSync(reportPath, 'utf-8'));
                crashes = (rep.allResults || []).filter(r => !!r.priceCrash);
            } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ count: crashes.length, crashes }));
        return;
    }

    if (req.url === '/api/report') {
        const reportPath = resolve('./error_fares_report.json');
        if (!existsSync(reportPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Report not generated yet' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(readFileSync(reportPath));
        return;
    }

    if (req.url === '/api/status') {
        const keysExist = existsSync('./active_keys.json');
        const reportExist = existsSync('./error_fares_report.json');
        let reportMeta = null;
        if (reportExist) {
            try {
                const rep = JSON.parse(readFileSync('./error_fares_report.json', 'utf-8'));
                reportMeta = {
                    scannedAt: rep.scannedAt,
                    totalRoutes: rep.allResults?.length || 0,
                    errorFares: rep.allResults?.filter(r => r.score?.tag === 'ERROR FARE').length || 0,
                };
            } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            status: 'online',
            isHunting: !!activeHuntProcess,
            keysConfigured: keysExist,
            report: reportMeta,
            uptimeSeconds: Math.floor(process.uptime()),
        }));
        return;
    }

    let file = req.url === '/' ? '/map.html' : req.url.split('?')[0];
    const path = resolve('.' + file);
    if (!existsSync(path)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = extname(path);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end(readFileSync(path));
}).listen(PORT, () => {
    console.log(`\n  🗺️  Deal Map → http://localhost:${PORT}\n`);
});
