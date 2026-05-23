# Deploy on Render (50+ players)

## Quick steps

1. Push this repo to **GitHub**.
2. [render.com](https://render.com) → **New** → **Blueprint** → connect repo (uses `render.yaml`).
3. After deploy, open **Environment** and set:
   - `PUBLIC_URL` = `https://YOUR-SERVICE-NAME.onrender.com` (your real URL, no trailing slash)
4. Open the host URL in a browser: `https://YOUR-SERVICE-NAME.onrender.com/`
5. Players join: `https://YOUR-SERVICE-NAME.onrender.com/mobile` (QR code on host uses this automatically).

## Plan recommendation

| Plan | Players |
|------|---------|
| **Starter** ($7/mo) | 50–100+ on one instance (recommended) |
| Free | OK for testing; sleeps when idle; **no persistent disk** (uploaded shapes lost on redeploy) |

`render.yaml` uses **Starter** + **1 GB persistent disk** at `/var/data` so sponsor shapes survive restarts.

## What was configured for production

- `PORT` from Render
- `PUBLIC_URL` for QR / join links (required on Render)
- Persistent `DATA_DIR` for sponsor shape packs
- Health check: `GET /health`
- Socket.io tuned for many mobile connections
- Player cap default: 120 (`MAX_PLAYERS` env)

## Manual deploy (without Blueprint)

- **Build:** `npm install --omit=dev`
- **Start:** `npm start`
- **Health check path:** `/health`

## Local production test

```bash
set NODE_ENV=production
set PORT=3001
npm start
```
