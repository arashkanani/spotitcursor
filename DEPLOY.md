# Deploy on Render (50+ players)

## Quick steps

1. Push the latest `main` branch to GitHub.
2. [render.com](https://render.com) → your Blueprint **spotit3** → **Manual sync** (or enable auto-deploy).
3. Wait until the web service shows **Live** (not Deploy failed).
4. Open your service URL:
   - **Host:** `https://YOUR-SERVICE.onrender.com/`
   - **Players:** `https://YOUR-SERVICE.onrender.com/mobile`

`RENDER_EXTERNAL_URL` is set automatically on Render — QR codes use it. You do **not** need to set `PUBLIC_URL` unless you use a custom domain.

## Sponsor shapes on Render

Circle icons are PNG files under `data/sponsors/` (gitignored locally). The repo ships a **seed pack** in `seed/sponsors/` (IKEA + OORDOO). On each deploy/start the server copies any missing PNGs from `seed/` into `data/`.

After you change shapes locally, refresh the seed and push:

```bash
npm run seed:sync
git add seed/
git commit -m "Update sponsor shape seed pack"
git push
```

Then **Manual sync** on Render. Without pushing `seed/`, production only has shapes you upload on the live host setup screen.

## If deploy failed

Common causes we fixed:

- **Persistent disk** in `render.yaml` — removed; use app `data/` folder first (works on Starter).
- **`PUBLIC_URL` missing** — app now uses Render’s `RENDER_EXTERNAL_URL`.
- **Build** — uses `npm ci --omit=dev` (needs `package-lock.json` in repo).

In Render → your service → **Logs**, check:

- `Build logs` — npm install errors
- `Deploy logs` — crash on start (look for `Server failed to start`)

## Plan recommendation

| Plan | Players |
|------|---------|
| **Starter** | 50–100+ on one instance (recommended) |
| Free | Testing only; sleeps when idle; shapes reset on redeploy |

For live events, use **Starter** (not Free). Set `MAX_PLAYERS` in Environment if you want a hard cap (default 120).

Optional environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_PLAYERS` | 120 | Hard cap on registrations |
| `ROUND_TIMEOUT_MS` | 60000 | Auto-advance round if nobody wins (ms); set `0` to disable |

Registration **closes automatically** when the host presses Start. Players who disconnect during a game can reconnect with the same phone (saved token). New scans during an active game are rejected.

Event planners customize **title, page layout (5 patterns), and background (5 styles)** in the host setup screen; choices are saved to `data/event-config.json` on the server (use optional Render disk + `DATA_DIR` so themes survive redeploys).

## Keep sponsor shapes after redeploy (optional)

1. Render dashboard → your web service → **Disks** → Add disk (1 GB), mount **`/var/data`**
2. **Environment** → add `DATA_DIR` = `/var/data`
3. Redeploy

## Manual deploy (without Blueprint)

- **Build:** `npm ci --omit=dev`
- **Start:** `npm start`
- **Health check path:** `/health`

## Local production test

```bash
set NODE_ENV=production
set PORT=3001
npm start
```
