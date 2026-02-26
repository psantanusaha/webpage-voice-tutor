# LearnAloud Webpage Voice Tutor

Browser extension + local relay server for voice tutoring on arbitrary webpages.

## What This Project Does

The extension reads visible page content, streams audio to a LiveKit/VocalBridge-backed agent, and executes agent-driven page actions such as scrolling and highlighting.

## Architecture

### 1. Browser extension (`extensions/`)

- `manifest.json`: MV3 manifest that injects scripts on all pages.
- `content.js`: Main runtime:
  - Starts/stops a tutoring session.
  - Connects to LiveKit room with a token fetched from local relay.
  - Maps page segments (`p`, `h1`, `h2`, `h3`, `li`) into `data-la-id` nodes.
  - Sends page context and user scroll events over LiveKit data channel.
  - Applies agent actions (`scroll_to`, `highlight`) in the DOM.

### 2. Local relay server (`relay.js`)

- Provides `POST /token`:
  - Accepts optional JSON body `{ "participant_name": "..." }`.
  - Calls VocalBridge token API using `VOCALBRIDGE_API_KEY`.
  - Returns token payload to extension.
- Provides `GET /livekit.js`:
  - Proxies LiveKit client SDK from jsDelivr.
  - Helps bypass CSP restrictions on some websites.

### 3. Test script (`test-logic.js`)

- Minimal local logic test for action handling behavior (`scroll_to`, `highlight`, missing-id case).

## Data Flow

1. User triggers tutor (`Ctrl+Shift+S` or floating button).
2. Extension ensures LiveKit SDK is loaded.
3. Extension requests token from `http://localhost:3000/token`.
4. Extension connects room, enables microphone, and sends `update_context`.
5. Agent sends messages over data channel.
6. Extension executes DOM actions and sends events back (heartbeat ack, user scroll).

## Configuration

Set environment variables before starting relay:

- `VOCALBRIDGE_API_KEY` (required)
- `PARTICIPANT_NAME` (optional, default: `LearnAloud-User`)
- `PORT` (optional, default: `3000`)

## Run Locally

```bash
npm install
VOCALBRIDGE_API_KEY=your_vb_key npm start
```

## NPM Scripts

- `npm start`: Start relay server.
- `npm run dev`: Start relay server (same as start).
- `npm test`: Run local logic test script.

## Load Extension

1. Open Chrome `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select the `extensions` folder.
4. Open any webpage and click `Start Tutor` (top-right) or press `Ctrl+Shift+S`.

## Notes

- Keep `VOCALBRIDGE_API_KEY` out of source control.
- The relay currently allows CORS from any origin for local development.
