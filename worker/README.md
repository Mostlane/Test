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
        ├── holidays.js      🟡 /holiday              (replaces `mostlane-holidays`)
        ├── vehicles.js      🟡 /vehicles /van        (replaces `vehicles`,`vehicles-fuel`)
        ├── sites.js         🟡 /sites                (replaces `mostlane-sites`)
        ├── assets.js        🟡 /assets               (replaces `mostlane-assets`)
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

## Front-end change (later, one line per page)

Every page currently hard-codes a different Worker host. Once this is live we
point them all at the single base URL, e.g.:

```js
const API = "https://mostlane-portal.<your-subdomain>.workers.dev";
```

and add the session token to calls:

```js
fetch(API + "/user?u=" + username, {
  headers: { Authorization: "Bearer " + localStorage.getItem("mostlaneToken") }
});
```

I can do that sweep across all 103 pages once the backend is verified.

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

### SLA notes (done)

- Routes are namespaced under `/sla/*`. Front-end change is one line per page:
  `const SLA_API = "<new-worker-url>/sla"` (was `https://mostlane-sla...`).
  Every appended path (`/jobs`, `/config`, `/pdf`, `/job/:id`) then lines up.
- Jobs + config moved to D1; **photos & signatures stay in the R2 bucket**
  (`JOB_FILES` binding) — point `bucket_name` in wrangler.toml at the SLA
  Worker's existing bucket so old photos keep resolving.
- Set the `PDFSHIFT_API_KEY` secret for PDF export; optionally
  `MOSTLANE_LOGO_BASE64` for the logo on exported job sheets.
