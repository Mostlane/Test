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
        ├── hours.js         🟡 /hours /timesheet     (replaces 5 hours Workers)
        ├── holidays.js      🟡 /holiday              (replaces `mostlane-holidays`)
        ├── vehicles.js      🟡 /vehicles /van        (replaces `vehicles`,`vehicles-fuel`)
        ├── po.js            🟡 /po /suppliers        (replaces `mostlane-po`,`mostlane-pos`)
        ├── sites.js         🟡 /sites                (replaces `mostlane-sites`)
        ├── assets.js        🟡 /assets               (replaces `mostlane-assets`)
        ├── sla.js           🔴 /sla                  (needs `mostlane-sla` source)
        ├── compliance.js    🔴 /Compliance           (needs `mostlane-pos` source)
        ├── projects.js      🔴 /project              (needs `projects-ml-portal`)
        └── labour.js        🔴 /labour               (needs `mostlane-labour-api`)
```

✅ done · 🟡 working but verify against original · 🔴 stub, needs your Worker code

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
I'll port its exact logic into the matching route file. Priority order:
`mostlane-sla`, `mostlane-po` + `mostlane-pos`, the hours Workers, then the rest.
