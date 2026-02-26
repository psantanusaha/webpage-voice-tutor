# LearnAloud Webpage Voice Tutor

Chrome extension + local Node relay server for real-time voice tutoring on any webpage.

## Features

- Reads visible page content and sends structured context to an agent.
- Streams microphone audio via LiveKit / VocalBridge.
- Executes agent UI actions in-page (`scroll_to`, `highlight`).
- Tracks user scrolling and publishes events back to the agent.

## Project Structure

- `extensions/manifest.json`: Chrome MV3 manifest.
- `extensions/content.js`: Main extension runtime and DOM action logic.
- `extensions/livekit.js`: Bundled LiveKit client (for extension-side load).
- `relay.js`: Local relay server for token generation and SDK proxying.
- `test-logic.js`: Local behavior tests for action execution.

## Prerequisites

- Node.js 18+
- npm
- VocalBridge API key
- Chrome (or Chromium-based browser)

## Quick Start

```bash
npm install
cp .env.example .env
# Set VOCALBRIDGE_API_KEY in .env
npm start
```

Relay server runs on `http://localhost:3000` by default.

## Environment Variables

- `VOCALBRIDGE_API_KEY` required, used by relay `POST /token`.
- `PARTICIPANT_NAME` optional, default `LearnAloud-User`.
- `PORT` optional, default `3000`.

## Load The Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the `extensions/` folder from this repo.
5. Open any webpage, then press `Ctrl+Shift+S` or click `Start Tutor`.

## Architecture Overview

1. Extension captures visible content (`p`, `h1`, `h2`, `h3`, `li`) and assigns `data-la-id`.
2. Extension requests a token from local relay `POST /token`.
3. Extension joins LiveKit room and starts microphone publishing.
4. Agent sends actions (`scroll_to`, `highlight`) over data channel.
5. Extension executes actions and publishes client events (scroll, heartbeat ack).

## Scripts

- `npm start`: start relay server.
- `npm run dev`: start relay server (same as start).
- `npm test`: run local action logic tests.

## Security Notes

- Do not commit real `.env` values.
- Keep API keys only in local environment.
- Relay CORS is currently broad for local development and should be restricted before production use.
