# Deploy & cutover runbook — Mostlane Portal

Go from this repo to a live, single-worker portal in ~10 minutes. Run these on
your machine (they need YOUR Cloudflare login — they can't be run from CI here).

## 0. Prereqs

```bash
cd worker
npm install
npx wrangler login        # opens browser, authorises your Cloudflare account
```

## 1. Create the D1 database

```bash
npx wrangler d1 create mostlane
```

Copy the printed `database_id` into `wrangler.toml` (replace
`PASTE_DATABASE_ID_HERE`).

## 2. Create the tables

```bash
npm run db:init           # runs schema.sql against the remote D1
```

## 3. Set secrets

```bash
npx wrangler secret put SESSION_SECRET        # any long random string
npx wrangler secret put PDFSHIFT_API_KEY      # if you use SLA PDF export
npx wrangler secret put RESET_EMAIL_WEBHOOK   # see "Password-reset email" below
```

Also edit `wrangler.toml` → `[vars]` → `APP_BASE_URL` to your portal URL.

## 4. Confirm the R2 buckets

`wrangler.toml` binds two existing buckets: `JOB_FILES` (SLA photos) and
`ASSET_BUCKET` (asset images). Set each `bucket_name` to the bucket your old
`mostlane-sla` / `mostlane-assets` workers already use (Cloudflare dash → R2),
so existing files keep resolving. If unsure:

```bash
npx wrangler r2 bucket list
```

## 5. Seed reference data (from repo JSON)

```bash
npm run db:seed           # users, sites, vehicles, assets (seed/test data)
```

## 6. Migrate LIVE data from the old workers' KV  ⟶  D1

SLA jobs, holidays, and live assets live in the old workers' **KV**, not the
repo. Get the KV namespace IDs (`npx wrangler kv namespace list`) and run:

```bash
SLA_JOBS_ID=...  SLA_CONFIG_ID=... \
HOLIDAYS_ID=...  HOLIDAY_CONFIG_ID=... \
ASSETS_ID=...    ASSET_LOG_ID=... \
ASSET_ORIGIN="https://mostlane-assets.jamie-def.workers.dev" \
NEW_ORIGIN="https://mostlane-portal.<sub>.workers.dev" \
node tools/export-kv-to-sql.mjs

npx wrangler d1 execute mostlane --file=./kv-seed.sql --remote
```

(Omit any IDs you don't have — it migrates what it's given. Devices don't need
migrating: users simply re-register on first login.)

## 7. Deploy

```bash
npm run deploy
```

Note the deployed URL, e.g. `https://mostlane-portal.<sub>.workers.dev`.

## 8. Flip the front end (ONE line)

In the repo root, edit `portal-config.js`:

```js
window.MOSTLANE_API = "https://mostlane-portal.<sub>.workers.dev";
```

Commit + redeploy the static site. Every page now routes its migrated features
to the new worker. Done.

## 9. Smoke test

- Log in → token stored → main menu loads.
- Users Admin: list, edit, toggle a permission, reset a password.
- Holidays: request + approve. SLA: open the board. Assets: view + photo.
- Forgot password → email arrives with a working reset link.

---

## Password-reset email (`RESET_EMAIL_WEBHOOK`)

The worker POSTs `{ type:"password_reset", to, name, resetUrl }` to this URL.
Simplest wiring with your existing stack:

1. Zapier → **Webhooks by Zapier → Catch Hook** (copy the hook URL).
2. Action → **Microsoft Outlook / Office 365 → Send Email**, To = `to`,
   body includes `resetUrl`.
3. `npx wrangler secret put RESET_EMAIL_WEBHOOK` → paste the hook URL.

Swap for Resend/SendGrid/Microsoft Graph later if you prefer — just change the
one webhook.

---

## Building the Apple / Android app later

The backend is already app-ready, by design:

- **Token auth, not cookies.** Login returns a bearer token; every call sends
  `Authorization: Bearer <token>`. Native apps store it in Keychain / Keystore.
- **`POST /auth/refresh`** rotates the token and extends the session, so the app
  stays signed in without re-login. Tune session length via `SESSION_TTL_HOURS`
  (12h default; consider longer for the app).
- **Pure JSON API, CORS open** — works the same from web, PWA, and native.
- **Device lock** (`/device/*`) already models one-device-per-user; the app can
  generate its own device id from secure storage.
- **Same endpoints for everything** — the app calls the identical worker the web
  app does, so no second backend to maintain.

Recommended app path: a thin native shell (or React Native / Flutter / Capacitor)
over these APIs, reusing the screens you already have as a reference. The web
PWA (`manifest.json` + service worker) already gives an installable app today as
a stop-gap.
