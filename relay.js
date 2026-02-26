require('dotenv').config({ override: true });
const express = require('express');
const fetch = require('node-fetch');
const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = (process.env.VOCALBRIDGE_API_KEY || '').trim();
const DEFAULT_PARTICIPANT_NAME = process.env.PARTICIPANT_NAME || 'LearnAloud-User';

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-API-Key, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.post('/token', async (req, res) => {
    console.log(`📡 Relaying request to VocalBridge...`);

    if (!API_KEY) {
        console.error('❌ Missing VOCALBRIDGE_API_KEY environment variable.');
        return res.status(500).json({
            error: 'Relay server is not configured. Missing VOCALBRIDGE_API_KEY.'
        });
    }

    const participantName = req.body?.participant_name || DEFAULT_PARTICIPANT_NAME;

    try {
        // USE HTTPS to avoid the redirect that causes the 405 error
        const response = await fetch("https://vocalbridgeai.com/api/v1/token", {
            method: 'POST',
            headers: { 
                'X-API-Key': API_KEY, 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ 
                participant_name: participantName
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error(`❌ VocalBridge Error (${response.status}):`, data);
            return res.status(response.status).json(data);
        }

        console.log("✅ Token generated successfully.");
        res.json(data);
    } catch (e) {
        console.error("❌ Relay Failure:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Serve the SDK locally to bypass Wikipedia's CSP
app.get('/livekit.js', async (req, res) => {
    try {
        const response = await fetch('https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js');
        if (!response.ok) {
            console.error(`❌ Failed to fetch LiveKit SDK (${response.status})`);
            return res.status(502).send('Failed to fetch LiveKit SDK');
        }

        const body = await response.text();
        res.header("Content-Type", "application/javascript");
        res.send(body);
    } catch (e) {
        console.error("❌ LiveKit relay failure:", e.message);
        res.status(502).send('Failed to fetch LiveKit SDK');
    }
});

const server = app.listen(PORT, () => {
    console.log(`🚀 Relay running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
    console.error('❌ Server error:', err);
    process.exit(1);
});

server.on('close', () => {
    console.error('⚠️  Server closed.');
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
});

function shutdown(signal) {
    console.log(`🛑 Received ${signal}, shutting down relay...`);
    server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
