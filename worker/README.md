# Mostlane Portal — Consolidated Worker + D1

This folder replaces the **19 separate Cloudflare Workers** (and all the JSON /
KV storage) with **one Worker** backed by **one D1 (SQLite) database**.

It is currently a **scaffold**: the core (routing, CORS, real session auth,
users, devices) is fully wired to D1; the rest of the domains are implemented
for basic reads/writes and marked `STUB` where they need the logic from your
existing Workers ported in faithfully.

## Why consolidate?

The old setup spread data across many Workers that didn't share storage — e.g.
hours lived in **five** different Workers (`odd-water-f78a`, `average-hours`,
`labourhours`, `timesheet`, `mostlane-labour-api`), and POs in **two**
(`mostlane-po`, `mostlane-pos`). That fragmentation is the most likely cause of
"things don't quite work": one tool writes data another never sees. One Worker
+ one database fixes that, and gives one place to enforce real authentication.

## Layout

```
worker/
├── wrangler.toml            # Worker + D1 config (paste your D1 id + set SESSION_SECRET)
├── schema.sql               # the whole database
├── migrate-json-to-sql.mjs  # turns existing ../*.json into seed.sql
├── package.json
└── src/
    ├── index.js             # router — maps every old Worker's paths here
    ├── lib/
    │   ├── http.js          # JSON + CORS helpers
    │   └── auth.js          # PBKDF2 passwords + server-side sessions
    └── routes/
        ├── auth.js          ✅ login / logout / me   (replaces `login`)
        ├── users.js         ✅ /user /users          (replaces `mostlane-users`)
        ├── devices.js       ✅ device lock           (replaces `userdevicekv`)
        ├── checkinout.js    🟡 /check                (replaces `ckeck-in-out`)
        ├── holidays.js      ✅ /holiday/*             (replaces `mostlane-holidays`)
        ├── vehicles.js      🟡 /vehicles /van        (replaces `vehicles`,`vehicles-fuel`)
        ├── sites.js         🟡 /sites                (replaces `mostlane-sites`)
        ├── assets.js        ✅ /assets, /asset/*      (replaces `mostlane-assets`; images→R2)
        ├── sla.js           ✅ /sla/*                (replaces `mostlane-sla`; jobs+config→D1, files→R2)
        ├── compliance.js    🔴 /Compliance           (needs compliance Worker source)
        └── projects.js      🔴 /project              (needs `projects-ml-portal`)
```

✅ done · 🟡 working but verify against original · 🔴 stub, needs your Worker code

**Out of scope (separate / later systems):** Purchase Orders & suppliers
(`mostlane-po`, `mostlane-pos`), Hours/Timesheets (`odd-water-f78a`,
`average-hours`, `labourhours`, `timesheet`), Labour Planning
(`mostlane-labour-api`).

## One-time setup

```bash
cd worker
npm install
npx wrangler login

# 1. Create the database, paste the printed id into wrangler.toml
npx wrangler d1 create mostlane

# 2. Create the tables
npm run db:init

# 3. Set the session signing secret
npx wrangler secret put SESSION_SECRET     # paste a long random string

# 4. Migrate existing JSON data in
npm run db:seed

# 5. Deploy
npm run deploy
```

## Front-end bridge & cutover (`/portal-config.js`)

All 103 root pages now include `/portal-config.js` as the first thing in
`<head>` (done — see `tools/inject-portal-config.mjs`). That one file:

1. Holds the single API base URL (`window.MOSTLANE_API`).
2. Transparently rewrites calls aimed at the OLD per-feature workers to the new
   one (so existing `fetch()` calls keep working untouched).
3. Attaches the login session token (`Authorization: Bearer`) to those calls.

**It is a no-op until configured.** While `MOSTLANE_API` still contains
`REPLACE-ME`, every page keeps calling its existing worker exactly as before —
so this was safe to commit before the worker is even deployed.

### Cutover = edit ONE line

After `npx wrangler deploy`, set the real URL in `portal-config.js`:

```js
window.MOSTLANE_API = "https://mostlane-portal.<your-subdomain>.workers.dev";
```

From that moment, all pages route the **migrated** features to the new worker:
`login`, `mostlane-users`, `mostlane-holidays`, `mostlane-assets`,
`mostlane-sla`, `userdevicekv`. Anything not yet ported keeps hitting its old
worker until you add its host to the `ROUTES` list in `portal-config.js`.

Login now stores the server session token (`mostlaneToken`); the bridge sends it
on every API call. Full server-side enforcement of that token on all endpoints
lands with the users/auth overhaul.

## Passwords & security

- Existing unsalted SHA-256 hashes are imported as-is and **transparently
  upgraded to salted PBKDF2 on each user's next successful login** — no reset
  needed.
- Login now issues a **server-verified session token**; protected routes check
  it. This closes the "set a localStorage flag to bypass login" hole.

## What I need from you to finish the 🔴/🟡 modules

Send me each Worker's source (Cloudflare dashboard → Worker → Edit code) and
I'll port its exact logic into the matching route file. Remaining to verify /
port: `mostlane-holidays`, `vehicles`/`vehicles-fuel`, `mostlane-sites`,
`mostlane-assets`, `ckeck-in-out`, the compliance Worker, `projects-ml-portal`.

> **Excluded for now** (separate / later systems): Purchase Orders & suppliers
> (`mostlane-po`, `mostlane-pos`), Hours/Timesheets (`odd-water-f78a`,
> `average-hours`, `labourhours`, `timesheet`), Labour Planning
> (`mostlane-labour-api`).

### Holidays notes (done)

- Routes keep their `/holiday/*` paths, so the front-end change is just the base
  URL: `const API = "<new-worker-url>"` in `holiday.html` and `holiday-admin.html`.
- Identity: still reads `X-User` / `X-Role` headers (so those pages work
  unchanged), falling back to the verified session token if absent. ⚠️ Like the
  original, the header path trusts the client — tighten this in the security pass
  so `Admin`/`Director` is derived server-side from permissions, not a header.
- All KV moved to D1: requests → `holidays`, bank-holiday/shutdown days →
  `holiday_system_days`, per-user allowances → `holiday_allowance`, audit →
  `holiday_log`; year config + date lists → `app_config`. Active-user list now
  comes from the D1 `users` table instead of `USERS_KV`.
- **`holiday-config.html` is broken/superseded** (posts to a non-existent
  `/holiday/config` and sends the wrong role) — delete it; `holiday-admin.html`
  already does config correctly. Not ported.

### Assets notes (done)

- Routes keep their original paths, so the front-end change is just the base URL
  in `assets-admin.html`, `my-assets.html`, `shared-assets.html`.
- Assets stored as full JSON (faithful to the Worker's schemaless `{...existing,
  ...body}` merge); `assigned_to` denormalised for `/assets?user=`.
- **Images stay in R2** (`ASSET_BUCKET`) — point `bucket_name` in wrangler.toml
  at the assets Worker's existing bucket so current images keep resolving.
- Image URLs are served by this Worker at `/asset-image?key=` / `/asset-thumb`.
  Existing stored image URLs point at the *old* worker origin — rewrite them to
  the new origin during the KV export (below), or keep the old worker alive for
  images only during transition.

### Migrating KV data (SLA + Holidays + Assets)

The JSON seed only covers repo files. **SLA jobs, all holiday data, and the live
asset records live in the Workers' KV**, not the repo, so they need a one-off
KV → D1 export at cutover (dump each KV namespace with `wrangler kv key
list/get`, transform to `INSERT`s; rewrite asset image origins). I can generate
that export script when you're ready to migrate.

### SLA notes (done)

- Routes are namespaced under `/sla/*`. Front-end change is one line per page:
  `const SLA_API = "<new-worker-url>/sla"` (was `https://mostlane-sla...`).
  Every appended path (`/jobs`, `/config`, `/pdf`, `/job/:id`) then lines up.
- Jobs + config moved to D1; **photos & signatures stay in the R2 bucket**
  (`JOB_FILES` binding) — point `bucket_name` in wrangler.toml at the SLA
  Worker's existing bucket so old photos keep resolving.
- Set the `PDFSHIFT_API_KEY` secret for PDF export; optionally
  `MOSTLANE_LOGO_BASE64` for the logo on exported job sheets.
