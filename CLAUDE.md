# Mostlane Portal — State of Play (July 2026)

Read this first. It is the handover brief for the whole system. The owner (Jamie)
is not a developer: he deploys by pasting into the Cloudflare dashboard and
running SQL in the D1 console — often from a phone. NO wrangler, NO local tools.

## Architecture (one line)
Static HTML pages (this repo = mostlane-portal.com) + ONE consolidated API
worker (`mostlane-api`) + ONE central D1 (`mostlane`) + R2, with three satellite
systems (PO, SiteLog, H&S) on their own workers/DBs, bridged to the portal.

## How things deploy — CRITICAL CONVENTIONS
- **Pages**: merging to `main` deploys the site automatically. Work on the
  `claude/...` branch, `merge --no-ff` into `main`, push both.
- **Worker (`mostlane-api`)**: NOT auto-deployed. Source is `worker/src/`
  (entry `src/index.js`); build both bundles with esbuild:
  `npx esbuild src/index.js --bundle --format=esm --outfile=dist/worker.js`
  (+ `--minify` → dist/worker.min.js). Jamie pastes `dist/worker.js` into
  Cloudflare → mostlane-api → Edit code. Deliver every new build by refreshing
  the **"Copy & Deploy" artifact page** (a hosted page with a one-tap
  copy-all button, commit chip, and "file must end with" tail verification —
  regenerate it fresh in a new session; pattern lives in this conversation
  style: big textarea payload + clipboard JS). Chat-pasting the 90KB+ worker
  truncates — never do it.
- **Schema changes**: give Jamie `CREATE TABLE IF NOT EXISTS ...` SQL to paste
  into the D1 console (worker/schema.sql is the reference, not auto-applied).
- **External workers (PO, SiteLog)**: never retype their code. Deliver changes
  as **patcher artifact pages**: user pastes their live code, page applies
  anchored string replacements, verifies count, copies patched result back.
- Always `node --check` the bundle and syntax-check edited HTML script blocks
  (vm.Script) before shipping.

## portal-config.js (every page includes it first)
- Sets `window.MOSTLANE_API = https://mostlane-api.jamie-def.workers.dev`.
- Rewrites fetches aimed at MIGRATED legacy worker hosts onto mostlane-api and
  attaches the session Bearer token (localStorage `mostlaneToken`).
  Migrated hosts: login, mostlane-users, mostlane-holidays, mostlane-assets,
  mostlane-sla (prefix /sla), mostlane-sites, userdevicekv.
- Direct calls to MOSTLANE_API do NOT get the token automatically — pages use a
  local `authFetch()` helper that adds `Authorization: Bearer` manually.
- Also injects the Story Mode floating "⚡ My Day" button on every page.

## mostlane-api worker (worker/src/routes/)
- `auth.js` — login (+ MASTER_PASSWORD break-glass fallback, audited as
  outcome "master"; returns `master:true` so device lock is bypassed),
  logout/me/refresh, change/forgot/reset password (emails via Resend).
- `users.js` — users CRUD, permissions (PERMISSION_KEYS incl. StoryMode,
  HSPlan, SiteLog), welcome email on create + /users/resend-welcome,
  /users/reset-password, /hs-plan-config (releases HS_PLAN_TOKEN to permitted
  users), /po-config (releases the user's personal PO URL from profile.poUrl).
- `sites.js` — /get-sites, /add-site, /update-site (old mostlane-sites API,
  ported; 350 sites + customers tables), /customers CRUD, /import-sites,
  /sites/street-images (bulk site photos: Places→StreetView→satellite, stored
  in R2, never overwrites hand-uploaded photos), auto-push of saved sites to
  SiteLog geofences (pushSiteToSiteLog).
- `sla.js` — SLA jobs (multi-engineer assignedEngineers[], site details stored
  on the job, quote/riskAssessment/order packs, statusHistory+events),
  /jobs/for-engineer, shifts (/shift/clock-on|clock-off|today, /shifts list),
  /vehicle-check (weekly), photos/signature in R2, PDF export.
- `portal.js` — /settings (app_config blob), /oncall/*, /daily-logs.
- `sitelog.js` — /sitelog-launch (HMAC identity token for scanner) and
  /sitelog/* admin proxy to api.site-log.co.uk.
- `email.js` (lib) — Resend sender + branded welcome/reset templates.
- Auth gate in index.js: everything needs a session except login/forgot/reset,
  asset-image, sla export.

## Secrets/vars on mostlane-api (dashboard)
RESEND_API_KEY, MASTER_PASSWORD, HS_PLAN_TOKEN, PORTAL_BRIDGE_SECRET,
SITELOG_ADMIN_SECRET (secrets); EMAIL_FROM, R2_PUBLIC_BASE (vars);
R2 bindings JOB_FILES (mostlane-job-files) + ASSET_BUCKET (mostlane-assets);
D1 binding DB (mostlane).

## D1 `mostlane` tables
users, user_permissions, sessions, devices, login_history, password_resets,
holidays(+config/log/allowance/system_days), assets, asset_transfers, sla_jobs,
sites, customers, shifts, vehicle_checks, oncall_log, daily_logs, app_config.

## Satellite systems
1. **PO system** — single-file worker (own D1 `mostlane-po`; legacy KV bindings
   on it are unused). Identity = personal URLs (/o/office, /e/engineer) stored
   per portal user in profile.poUrl; portal 🧾 button opens it via /po-config.
   Patched: 🏠 Portal back-button; portal sync (PORTAL_DB binding → mirrors
   portal sites + users into its lists, add-only, 5-min throttle).
2. **SiteLog** — repo `Mostlane/SiteLog` (docs/ = GitHub Pages at
   site-log.co.uk), worker at api.site-log.co.uk (secret ADMIN_SECRET = admin
   PIN). Portal page sitelog.html: scan launch (identity bridge: portal mints
   #pt= HMAC token → SiteLog /portal-link binds deviceToken→person, creates or
   adopts by name, stores portal_username), on-site list + geofence push via
   the admin proxy. 348 portal sites pushed as geofences; new sites auto-push.
3. **H&S planner** — static app hosted in THIS repo at /hs-plan/ (from the
   H&S project zip); its worker `mostlane-hs-jobs` (own D1 + APP_TOKEN secret).
   Menu 🦺 button builds `hs-plan/#worker=...&token=` via /hs-plan-config.

## Story Mode (per-user toggle, Users admin → Account tab)
Guided engineer day. Login lands on my-day.html (start day: weekly vehicle
check gate Wed 12:00, mileage, GPS → one job at a time: travel → RA gate →
complete needs note+photo+signature / quote pack / order / hold → end day
summary). Portal menu restricted for Story users (STORY_ALLOWED in main.html)
+ floating return button everywhere. Gates also enforced on job-view.html.

## Menu gating (main.html)
MAP object: KEY = element id, list = permission names. All buttons hidden by
default; FullAccess sees all (minus Story restriction). Adding a button =
element + MAP entry keyed by its id.

## Retired/redirected (do not resurrect)
Old PO pages (po*.html, purchase.html), old jobs/create/job pages,
sla_scheduler.html, sla-job-view, all-sites, view-assets, view-timesheets,
holiday-calendar, admin-holiday, import-users, engineer-report,
hours-dashboard.html, add-site chain (Zapier). Static data files (users.json,
Users.txt, admin.users, sites.json, timesheets.json etc.) DELETED — never
re-add user data files to this public repo.

## Still legacy (rebuild queue, owner-approved: D1+R2+mostlane-api only, no KV)
1. Onboarding (onboard.html, add-driver.html — still Zapier) → /users API.
2. **Timesheets/check-in-out** (BIG): 5 old workers (ckeck-in-out,
   odd-water-f78a, timesheet, average-hours, labourhours) + ~15 pages; new
   backbone = shifts table.
3. Labour planning (mostlane-labour-api), Projects (projects-ml-portal).
4. Open verdicts: vehicles (two check systems exist: Story Mode weekly in D1
   vs Jotform walkaround + vehicles/vehicles-fuel workers), EICR/compliance
   (eicr-portal*.html on old mostlane-pos KV).

## Known quirks
- Cloudflare blocks worker→worker fetch on *.workers.dev (error 1042) — use
  browser-side fetch + POST to our API, or custom domains (api.site-log.co.uk
  is fetchable server-side).
- After changing dashboard secrets you must hit Deploy (staged otherwise).
- Users must log out/in for new permissions to reach their session.
- Site images: sites.data JSON carries imageURL/_svAt/_noImagery flags.
- The user pastes worker code from artifact pages — always show commit + line
  count + expected tail so truncation is detectable.
