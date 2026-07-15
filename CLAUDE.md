# Mostlane Portal — State of Play (14 July 2026)

Read this first. It is the handover brief for the whole system. The owner (Jamie)
is not a developer: he deploys by pasting into the Cloudflare dashboard and
running SQL in the D1 console — often from a phone. NO wrangler, NO local tools.
The Cloudflare connector (mcp__Cloudflare_Developer_Platform__*) is available in
sessions: D1/KV/R2 are READ-WRITE (create tables directly — no SQL paste needed),
workers are READ-ONLY (Jamie must paste worker.js manually).

## Architecture (one line)
Static HTML pages (this repo = mostlane-portal.com, Cloudflare Pages) + ONE
consolidated API worker (`mostlane-api`) + ONE central D1 (`mostlane`,
database_id e483b3b5-2cfd-4742-ae51-427c31598c87) + R2, with three satellite
systems (PO, SiteLog, H&S) on their own workers/DBs, bridged to the portal.

## How things deploy — CRITICAL CONVENTIONS
- **Pages**: the site is **Cloudflare Pages connected to this GitHub repo
  (Mostlane/Test)** — GitHub holds the code, Cloudflare builds + serves
  mostlane-portal.com on every push to `main`. It is NOT GitHub Pages
  (no CNAME, no Actions workflow) so **`_headers` IS honoured** (its no-cache
  rules are real, not dead files). Work on the `claude/...` branch,
  `merge --no-ff` into `main`, push both.
- **Worker (`mostlane-api`)**: NOT auto-deployed. Source `worker/src/`
  (entry `src/index.js`); build:
  `npx esbuild src/index.js --bundle --format=esm --outfile=dist/worker.js`
  (+ `--minify` → dist/worker.min.js). Always give commit hash + line/byte
  count + the expected tail `export { index_default as default };` so a
  truncated paste is detectable. Jamie pastes into Cloudflare → mostlane-api →
  Edit code → Deploy. Three delivery routes (his preference has varied — offer
  the one he asks for): (a) **SendUserFile** dist/worker.js; (b) an **Artifact
  copy page** — a self-contained HTML page with the whole file in a read-only
  textarea + a Copy button (build it so `textarea.value` returns the exact
  bytes: HTML-escape only `&`→`&amp;` and `<`→`&lt;`; verify byte-exact
  headlessly before publishing); (c) **straight from GitHub** — dist/worker.js
  is committed, so link the blob (has a copy-raw button):
  github.com/Mostlane/Test/blob/main/worker/dist/worker.js.
  **Worker last sent ≈ the Web Push Phase-1 build (routes/push.js +
  lib/webpush.js, ~6,174 lines) — needs VAPID_PUBLIC/VAPID_PRIVATE set in the
  dashboard.** Confirm with Jamie what's actually pasted before assuming.
- **Schema changes**: worker/schema.sql is the reference. Create tables LIVE
  via the D1 connector (done for all current tables), then update schema.sql.
- **External workers (PO, SiteLog)**: never retype their code. Deliver changes
  as **patcher artifact pages**: user pastes their live code, page applies
  anchored string replacements, verifies count, copies patched result back.
  (Patchers need desktop — don't start one when Jamie is on his phone.)
- Always `node --check` worker JS and vm.Script-check edited HTML script
  blocks before shipping. Playwright (headless, CommonJS .cjs,
  NODE_PATH=/opt/node22/lib/node_modules, python3 -m http.server 8099) is the
  test harness — mock the API with ctx.route. Login state needs BOTH storages:
  localStorage mostlaneToken/mostlaneLoggedIn/mostlaneExpiry/mostlaneBypassUntil
  + sessionStorage mostlaneLoggedIn/mostlaneUsername/mostlaneMasterLogin.

## portal-config.js (every page includes it FIRST — as `/portal-config.js?v=2`)
All 90+ pages reference `?v=2` (cache-bust). If a portal-config change must
reach stubborn phone caches, bump to ?v=3 across all pages with sed. Provides:
- `window.MOSTLANE_API` = https://mostlane-api.jamie-def.workers.dev
- Legacy-host fetch bridge: rewrites calls to the migrated old workers
  (login, mostlane-users, mostlane-holidays, mostlane-assets, mostlane-sla
  (prefix /sla), mostlane-sites, userdevicekv → /auth/* becomes /device/*)
  onto mostlane-api and attaches the Bearer token. Direct MOSTLANE_API calls
  do NOT get the token — pages use a local `authFetch()` helper.
- Canonical people order (mlUserCmp/mlOrderUsers: office first, drag order).
- Shared theme layer + `.ml-back` button CSS.
- Desktop sidebar (#pnav, NAV array; `always:true`, `perms:[]` any-of,
  `ownerOnly`) with red badges (pending transfers, holiday, holiday admin).
- **Theme engine**: per-user accent colour + menu background from
  localStorage `mostlaneTheme` (instant paint) then GET /theme (server truth,
  permission-filtered). Recolours header.page, #pnav, .menu-grid a.button,
  primary .btn, #mlNotify header via injected !important CSS. Re-applies on
  bfcache pageshow. ML_ACCENTS/ML_BG_COLOURS exposed (personalise.html keeps
  its own fallback copies — must work against a stale portal-config).
- **Page-view beacon**: POST /audit/pageview once per page open (logged-in
  only; login/reset/onboard pages excluded).
- **Embossed logo watermark** (added 14 Jul): one fixed `html::before` layer
  (`#mlEmbossCss`, `/Mostlane_Embossed.png`, z-index:-1, behind all content),
  so it shows on EVERY portal page without touching per-page `body`
  backgrounds — coexists with the personalised main.html menu bg. The old
  per-page `body{background:… url(Mostlane_Embossed.png) …}` copies were
  stripped so nothing doubles. Standalone sub-apps under /fsm and /vehicles
  keep their own copy (they don't load portal-config.js).
- View As (owner only, OWNER="Jamie Line"), Story Mode "⚡ My Day" button.

## Auth & sessions (worker lib/auth.js + routes/auth.js + client auth.js)
- Passwords: salted PBKDF2 100k (`pbkdf2$100000$salt$hash`), legacy sha256
  auto-upgraded on login. NEVER paste plaintext into D1 — it won't work.
- **Sessions last 90 days** (SESSION_TTL_HOURS default 2160). login.html
  stores 90-day mostlaneExpiry + mostlaneBypassUntil.
- Login lookup is FORGIVING (findUser): exact, case-insensitive, legacy
  dotted form (Jamie.Line → "Jamie Line"), or email — phones autofill old
  dotted usernames, which once looked like "new password doesn't work".
  Everything downstream uses the canonical username from the matched row.
- Self-service reset: login → forgot-password.html → Resend email link (1h)
  → reset-password.html. Admin: Users Admin password box (with "must change
  at next login" tick-box → ForceChange) or Reset password button (temp
  password + kills ALL of that user's sessions instantly).
- Password rule (min 8, letter+number) shown AND enforced client+server.
  Eye toggles (👁 click, stays open) on login/change/reset/users-admin.
  ⚠️ Those pages style `button {width:100%}` — the eye buttons carry inline
  `width:auto` or they invisibly cover the whole field. Don't regress.
- **PWA fixes (hard-won, don't break)**: iOS wipes sessionStorage on PWA
  kill. Client auth.js restores mostlaneLoggedIn/mostlaneUser/mostlaneUsername
  from localStorage BEFORE any checks (device-auth.js requires
  mostlaneUsername). login.html auto-skips to main/my-day ONLY after /auth/me
  confirms the token server-side, has a 20s circuit-breaker (sessionStorage
  mlAutoSkipAt), and every device-auth redirect to login clears the login
  flags first. All three guards exist because a stale server token once
  caused a violent login↔main redirect loop.
- MASTER_PASSWORD break-glass (audited "master", bypasses device lock,
  session-scoped). Device lock: devices table, owner exempt, per-user caps;
  /device/check-device fires on every page load (excluded from audit log).

## mostlane-api worker (worker/src/routes/)
- `index.js` — route table (longest prefix wins), auth gate (public: login,
  forgot/reset, onboard, asset-image/thumb, sla export), **audit middleware**:
  every POST/PUT/PATCH/DELETE by a logged-in user → audit_log row (user,
  path+query, key body fields, HTTP status, ISO time; request.clone() before
  dispatch). Skips /notify/log, /prefs, /device/check-device, /audit,
  /auth/refresh. Auto-prunes rows older than 12 months.
- `auth.js` — login/logout/me/refresh/impersonate (View As, owner-locked,
  audited), change/forgot/reset password, login_history (utcify'd on read).
- `users.js` — users CRUD (+Password w/ ForceChange), PERMISSION_KEYS (incl.
  AssetAdmin, OfficeClock, OfficeTimesheet, ThemeColour, ThemeBackground,
  StoryMode, HSPlan, SiteLog), welcome/reset emails, /users N+1-fixed,
  /users/reorder (StaffType/SortOrder), /hs-plan-config, /po-config.
- `devices.js` — check/register device, /device/admin-list, /device/allowed,
  /device/reset, owner exempt.
- `holidays.js` — summary ring, accrual mode, Holiday/Unpaid/Other,
  approve/reject (type override), staff self-cancel (notifies admin), bank
  holidays (GOV.UK import) + shutdown + worked-credit, batch system days.
- `assets.js` — assets CRUD + images (R2 ASSET_BUCKET=mostlane-asset-images;
  /asset-image + /asset-thumb by key), transfer workflow (request → accept
  with signature + condition photos both sides → formal TRANSFER_NOTE,
  reject/cancel), /asset/condition-photos (admin: every condition photo with
  who/when/handover-or-received), /asset/my-documents, /transfer-log,
  r2-relink/unlink (recovery endpoints; UI buttons removed after the data
  recovery was completed). **Equipment confirmation rounds**
  ("do you still hold this?"): /asset/confirm/request (admin starts a round —
  marks every held item pending; POST body `exclude:[usernames]` skips those
  holders — recipient picker on assets-admin.html), /asset/confirm/respond
  (holder confirms/flags), /asset/confirm/pending-count (my badge),
  /asset/confirm/status (admin dashboard, round stored in app_config
  `asset_confirm_round:<tid>`). Flagged items ("not held") are resolved on the
  dashboard: **Reassign** (opens the asset edit modal — /asset/update clears
  `confirm` whenever assignedTo changes) or **Still held** (/asset/confirm/respond
  held:true). **utcify()** pattern: never serve SQLite's naive
  "YYYY-MM-DD HH:MM:SS" to browsers (hour off in UK summer) — store
  toISOString(), normalise old rows on read.
- `keys.js` — key register: portal_keys (JSON) + key_log (append-only audit).
  /keys (any session — engineers see "keys signed to me" on my-assets),
  /key/add|update|delete, /key/sign-out|sign-in, /key/log. Admin =
  FullAccess|AssetAdmin.
- `theme.js` — /theme GET/POST (users.profile.theme; server filters by
  ThemeColour/ThemeBackground perms so revoking reverts the user),
  /theme/background (photo → R2 theme/<user>/, old ones deleted first).
- `portal.js` — /settings, /oncall/*, /daily-logs, **/prefs** (per-user
  cross-device markers in users.profile.prefs: holSeen, holAdminSeen,
  notifySnooze — POST shallow-merges, null deletes, 8KB cap), **/notify/log**
  (notification audit POST any session / GET FullAccess), **/audit/pageview**
  + **/audit/log** (activity log; GET FullAccess, filters user/days/type).
- `sla.js` (jobs, multi-engineer, shifts, vehicle checks, packs, PDF).
  **POST /sla/inbound** (PUBLIC_ROUTES; `Authorization: Bearer
  JOBS_INBOUND_TOKEN`, timing-safe compare): machine-to-machine job intake —
  the Zapier email-parser zap POSTs jobs straight in. Upserts by reference
  (re-sent email updates, never duplicates), forgiving priority ("P1"→
  "Priority 1") and date parsing, fires the assignment push, changedBy
  "zapier". Returns {ok, created, id, reference, status, priority, targetAt}.
  **DELETE /sla/jobs/{id}** (FullAccess|SLAAdmin): removes the job + purges
  its R2 files (jobs/{id}/…); 🗑 button in the shared editor (admin-only).
  Front-end: **sla-jobedit.js** (`?v=2`, shared by sla-main / sla-scheduler /
  job-view) is the ONE-HIT editor — every Edit button opens it and it edits
  everything in one save: ref, description, priority, status, raised,
  **schedule (date · start · finish, Clear = unschedule) + assigned engineers
  (multi-tick)**, full site, note — one PATCH /sla/jobs/{id}. Exposes
  `MLJobEdit.wheelify(root)`: mouse-wheel stepping on date/time/number inputs
  (15 min per notch, Shift = 1 h, dates 1 day) — also wired to the scheduler's
  quick modal. Finish ≤ start rolls to next day (evening access windows).
  `sites.js` (get/add/update-site, customers, street-images, auto geofence
  push to SiteLog), `sitelog.js` (HMAC launch + admin proxy), `office.js`
  (clock segments; edits keep originals struck-through; /office/my,
  /office/timesheet), `email.js` lib (Resend templates).
- `vancheck.js` — weekly van checks (replaces the old Jotform walkaround):
  driver form (mileage + photo slots → R2 vancheck/…), /vancheck/week admin
  grid, badges. **/vancheck/skip** (admin skips a driver's week → writes a
  "skipped" row into vehicle_checks with items.skipped/skippedBy, shows in the
  Vehicles weekly grid) + **/vancheck/unskip**. Attention gate honours
  vehicle-check suppression. **/vancheck/remind-now** (admin: Vehicles|
  FullAccess) fires this week's reminder to all still-outstanding drivers on
  demand (no time-gate/dedupe) — "🔔 Remind now" button on van-checks.html;
  shares `remindDrivers()` with the cron. `sendWeeklyReminders` is the cron path.
- `fleet.js` — the whole Vehicles/Fleet backend (gate: FullAccess|Vehicles).
  See the **Fleet / Vehicles** section below for the endpoint list.
- `hrdocs.js` — staff personal + company documents (R2, signed URLs);
  front-end my-documents.html.
- `privacy.js` — GDPR: /privacy/export (redacts passwords/tokens),
  /privacy/erase (anonymise + kill sessions/devices + delete personal docs;
  keeps legally-required records). Front-end my-documents.html admin panel.
- `stats.js` — /stats D1 aggregates + R2 storage totals (stats.html).
- `menu-config` (in portal.js) — /menu-config: Full-Access shared list of
  hidden menu tiles (main.html reads it). Also **/notify/suppress**,
  **/notify/suppress/remove**, **/notify/overview** (notification-centre.html:
  mute a user's popups/reminders — specific / all-of-type / global; vehicle
  checks are shown-not-muted and skippable). `lib/suppress.js` = getRules /
  saveRules / isSuppressed(rules,type,user,key).
- `lib/filesign.js` — HMAC-SHA256 signed expiring file URLs
  (FILE_SIGNING_SECRET||PORTAL_BRIDGE_SECRET): signedFileUrl / verifyFileSig.
  Used by hrdocs, fleet reports + vehicle docs. Public GET routes verify the
  sig in-handler (see index.js PUBLIC_ROUTES: /staff/doc, /fleet/report,
  /fleet/vehicle-doc).
- Login brute-force throttle: auth.js tooManyRecentFails (20 fails/15min per
  IP via login_history).

## Fleet / Vehicles (routes/fleet.js — added this session)
Vehicles moved OFF the old standalone `vehicles.jamie-def.workers.dev` worker
INTO the portal. vehicles.html was rebuilt in the standard portal look (light
theme, header.page, cards — NOT the old dark embossed page) and is the hub.
- **Registry**: `/fleet/vehicles` GET (returns each van + current driver +
  computed service status + latest mileage), `/fleet/vehicle` POST (upsert),
  `/fleet/vehicles-import` POST (bulk from legacy `${VEHICLE_WORKER}/fleet`,
  a bare array; reg-matched upsert, no dupes — the "⤵ Import old data" button),
  `/fleet/vehicle-delete` POST (also closes open assignment + deletes its R2
  docs; van-check history kept). Self-migrating `vehicles` table
  (ensureVehTable adds service/odometer columns via ALTER…try/catch).
- **Service intervals**: per van, time (months→stored as days) and/or mileage,
  flagged on whichever comes first; editable pre-warning (default 30 days /
  1000 miles); falls back to a fixed next_service date if no interval. Status
  computed server-side (serviceView) → ok/warn/bad + reason; summary "Service
  due" count + filter on the page.
- **Mileage** comes from the weekly van checks (vehicle_checks.items.mileage,
  latest checked_at wins) — not stored on the vehicle row (latestMileage()).
- **Documents** (repair invoices/receipts): `/fleet/vehicle-doc` POST
  (multipart → R2 JOB_FILES `vehicledocs/<tid>/<REG>/…`), `/fleet/vehicle-docs`
  GET (signed URLs), `/fleet/vehicle-doc-delete` POST, `/fleet/vehicle-doc` GET
  (public+signed stream, inline). 📎 Docs button on each card.
- **Photos** (gallery per van, one is the card cover): `/fleet/vehicle-photo`
  POST (multipart → R2 JOB_FILES `vehiclephotos/<tid>/<REG>/…`; client shrinks
  to 1600px JPEG before upload), `/fleet/vehicle-photos` GET (signed URLs +
  which is cover), `/fleet/vehicle-photo-cover` POST (pick the card cover),
  `/fleet/vehicle-photo-delete` POST, `/fleet/vehicle-photo` GET (public+signed
  stream, inline — used by the card `<img>` + lightbox). Cover choice stored in
  app_config `fleet:vehcover:<tid>` ({REGNORM:key}); first upload auto-covers,
  deleting the cover falls back to newest. `/fleet/vehicles` returns `photoUrl`
  (signed cover) + `photoCount` so cards show a thumbnail with no extra round
  trips (one R2 list for the whole fleet). 📷 Photos button + tap-to-enlarge
  lightbox on each card; photos purged on vehicle-delete. Both GET stream
  routes are in index.js PUBLIC_ROUTES (sig-verified in-handler).
- **Drag-to-reorder**: ⠿ handle on each card, pointer-based (mouse+touch/PWA,
  edge auto-scroll), saves `/fleet/vehicle-order` (app_config
  `fleet:vehorder:<tid>` = [reg,…]); order applied server-side in
  /fleet/vehicles so it's the same everywhere.
- **Driver assignment registry** (who drives what, when — the single source):
  `/fleet/assign` POST, `/fleet/current` GET (?week=), `/fleet/assignments`
  GET (?reg=, full history). Table `vehicle_assignments` (open row =
  end_date NULL); also syncs users.vehicle_assigned (van checks read that).
  seedAssignments bootstraps from users.vehicle_assigned first use. 👤 Driver
  + History buttons on the page.
- **Fleet Report** (fleet-report.html — AI-style report from a VelocityFleet
  XLS + driver-score PDF, parsed client-side): `/fleet/report` POST (save
  standalone HTML to R2) / `/fleet/reports` GET / `/fleet/report-delete`;
  `/fleet/drivers` GET/POST (remembered reg→driver overrides for the report).
  Pool vans: mark a reg "🚚 Fleet/pool" → per-day allocate-to-driver dropdowns
  saved to `/fleet/pool-alloc` (app_config `fleet:poolalloc:<tid>`,
  key `REG|YYYY-MM-DD`→username); the van timesheet uses these per-day.
- **Van timesheets** (van-timesheet.html — office-timesheet style, door-to-door
  pay): `/fleet/timesheet` GET/POST (table `van_timesheets`), `/fleet/paycfg`
  GET/POST (app_config `fleet:paycfg:<tid>`; defaults morningCap 30 / homeCap
  30 / lunch 30 / thresholdH 6, per-user overrides). Pay = span − min(cap,
  commute leg) each end − lunch (if span ≥ threshold). Auto-filled from the
  fleet report's door-to-door hours; editable (leaving-site vs arriving-home
  toggles recompute live).
- Legacy `vehicles.jamie-def.workers.dev` is now import-only; the standalone
  /vehicles and /fsm sub-app folders are separate and unmigrated.

## D1 `mostlane` tables
users (profile JSON holds poUrl, theme, prefs, rates…), user_permissions,
sessions, devices, login_history, password_resets, holidays(+config/log/
allowance/system_days), assets, asset_transfers, asset_transfer_requests,
sites, customers, sla_jobs, shifts, vehicle_checks, office_shifts, oncall_log,
daily_logs, app_config, portal_keys, key_log, notify_log, audit_log,
**vehicles**, **vehicle_assignments**, **van_timesheets**. app_config also
holds JSON blobs keyed `fleet:drivers:<tid>`, `fleet:poolalloc:<tid>`,
`fleet:paycfg:<tid>`, `fleet:vehorder:<tid>`, `fleet:vehcover:<tid>` and the
notification-suppression rules. R2 (JOB_FILES): `fleetreports/<tid>/…`,
`vehicledocs/<tid>/<REG>/…`, `vehiclephotos/<tid>/<REG>/…`; staff docs via
hrdocs. All fleet tables are self-migrating (CREATE TABLE IF
NOT EXISTS + ALTER on read) — no manual SQL needed.

## Notifications system
- Red badges on tiles (main.html) + sidebar (portal-config) from
  /asset/transfers/pending-count, /holiday/my (unseen decisions),
  /holiday/all (pending + staff cancellations). "Seen" markers are per-USER
  via /prefs (server), mirrored in localStorage (newer timestamp wins) — so
  dealing with something on one device clears it on all devices.
- **Attention gate** (main.html): phones get a BLOCKING overlay listing
  outstanding items (no dismiss button); desktop gets a dismissible corner
  panel (sessionStorage sig). "💤 Remind me later" = 4h snooze, max 2 per
  notification (identified by page+count; counts shared across devices via
  prefs), then enforced. Every shown/snoozed/opened/dismissed is POSTed to
  /notify/log → viewer notify-log.html (FullAccess, linked from Users Admin)
  — proof against "mine never showed that".

## Activity log (audit trail)
Server middleware records every state-changing request automatically (covers
all current AND future pages); portal-config beacons page views. Viewer
**activity-log.html** (FullAccess): person/period/actions-vs-views filters,
text search, friendly names (~50 endpoints in its FRIENDLY map — add new
endpoints there), failed actions flagged red. Linked from Users Admin +
Device Management top bar — deliberately NO menu tile. 12-month retention.

## Personalisation
personalise.html (🎨 tile + sidebar; theme.html is now only a redirect — the
old URL got cache-poisoned on phones). 8 accent themes + menu background
(embossed M / 6 light block colours / own photo, client-shrunk to 1600px).
Gated per user by ThemeColour / ThemeBackground permissions (Users Admin →
Personalisation group; FullAccess implies both). Server-side filtering means
revoking a permission reverts that user on their next page load.

## Help section
help.html — ❓ tile (always visible, incl. Story users) + sidebar item. 46
task-level SOP guides in a GROUPS array, each tagged perms:"always" or an
any-of permission list (FullAccess sees all) — users only see guides for what
they can use. 47 staged screenshots in help-img/ (generated headless with
mocked data — people in screenshots are ALWAYS "User 1/2/3", never real or
invented names; regeneration recipes for every page live in the session
scratchpad pattern gen-help-shots*.cjs). Search + tap-to-enlarge lightbox.
Known gap: PO guide is text-only (external code — Jamie may supply a phone
screenshot to embed). **UPDATE THE RELEVANT GUIDE WHENEVER FEATURES CHANGE.**

## Menu gating (main.html)
MAP object: KEY = element id, list = permission names (any-of; FullAccess
sees all). Hardcoded `class="button visible"` = always shown (Logout, Help).
Story users: STORY_ALLOWED set only + pinned "Back to My Day". Personalise
tile gated by ThemeColour/ThemeBackground.
- **Consolidated tiles (Jul 2026)** — five standalone pages were nested behind
  parents to cut top-level clutter. A merged tile is visible to holders of
  EITHER the parent OR child permission (its MAP key list carries both), and
  applyGate() sets a **per-user dynamic href** (`setHref`) so a child-only
  holder lands straight on the child page (never orphaned, never on a page
  their permission blocks). Same pattern in portal-config.js sidebar via
  `resolveHref(item)` + `item.hrefBy`. The merges:
  - **Timesheet** (id `OfficeTimesheet`, keys OfficeTimesheet|Vehicles):
    Office Timesheet default, Vehicles-only → van-timesheet.html. Each page
    cross-links the other (`vanTsLink` / `officeTsLink`, gated by the other
    perm). van-timesheet.html has no server perm-guard; office-timesheet needs
    OfficeTimesheet|FullAccess.
  - **Users** (keys Users|DeviceAdmin): users-admin default, DeviceAdmin-only →
    device-admin.html (its guard accepts DeviceAdmin). users-admin toolbar has a
    `devicesLink` (gated DeviceAdmin|FullAccess). Removed standalone Devices.
  - **Projects** (keys Projects|ProjectsAdmin): projects default, ProjectsAdmin-
    only → projects-admin.html. projects.html topbar `⚙ Admin` btn `projAdminBtn`
    (gated ProjectsAdmin|FullAccess). Removed standalone Project Admin.
  - **Vehicles**: Fleet Report is a `🚚 Fleet Report` button in vehicles.html
    head-actions (page-gated by the Vehicles tile). Removed standalone tile.
  - **Notifications**: the all-staff per-device push toggle (notifications.html)
    moved into Settings (personalise.html `notifCard`, everyone). The admin
    **Notification Centre** tile (notification-centre.html, `__fullOnly`) stays.
  Child-page link gates read cached `mostlanePermissions` at parse time (inline
  script), matching the delete-button/projAdmin pattern.

## _headers (Cloudflare Pages cache rules)
no-cache on: portal-config.js, auth.js, device-auth.js, docviewer.js,
login.html, main.html, holiday.html, holiday-admin.html, theme.html,
personalise.html, help.html, activity-log.html, my-documents.html,
notification-centre.html, fleet-report.html, van-timesheet.html,
vehicles.html. **ADD NEW HOT PAGES HERE when created** — a page shipped
without no-cache once got cache-poisoned on phones (that's why
personalise.html had to replace theme.html).

## Secrets/vars on mostlane-api (dashboard)
RESEND_API_KEY, MASTER_PASSWORD, HS_PLAN_TOKEN, PORTAL_BRIDGE_SECRET,
SITELOG_ADMIN_SECRET, **VAPID_PRIVATE**, **JOBS_INBOUND_TOKEN** (secrets); EMAIL_FROM, R2_PUBLIC_BASE,
**VAPID_PUBLIC**, optionally **PUSH_CONTACT** (mailto: for VAPID sub) /
SESSION_TTL_HOURS / OWNER_USERNAME (vars); R2 bindings JOB_FILES
(mostlane-job-files) + ASSET_BUCKET (mostlane-asset-images); D1 binding DB
(mostlane). After changing dashboard secrets you must hit Deploy.

## Push notifications (Web Push — routes/push.js + lib/webpush.js + sw.js)
Phase 1 (plumbing + test) + Phase 2 (real events + all-staff) DONE. Real OS
notifications on installed PWAs
(iOS 16.4+ Home-Screen only; Android Chrome). Icon = the Mostlane "M":
iOS uses the Home-Screen (apple-touch) icon, Android uses the notification
`icon`/`badge` (both /icons/icon-192.png).
- **lib/webpush.js** — VAPID ES256 JWT (RFC 8292) + aes128gcm payload
  encryption (RFC 8291) on WebCrypto only (no libs). `sendPush(env, sub, str)`.
  Verified against http_ece + RFC-style round-trips.
- **routes/push.js** — /push/public-key (VAPID pub for subscribe),
  /push/subscribe, /push/unsubscribe, /push/test. Table push_subscriptions
  (self-migrating: endpoint PK, username, p256dh, auth, ua). `sendToUser(env,
  tid, username, {title,body,url})` fans out to a user's devices + prunes dead
  (404/410) — **Phase 2 event hooks will call this**.
- **VAPID keys** are worker config (VAPID_PUBLIC var + VAPID_PRIVATE secret;
  optional PUSH_CONTACT). Client fetches the public key from /push/public-key.
- **sw.js is now the single service worker** (cache + push + notificationclick);
  service-worker.js is kept as an identical copy so any cached page still works.
  main.html + pwa.js both register /sw.js (idempotent). Payload JSON =
  {title, body, url, tag?}; notificationclick focuses/opens url.
- **Offline hardening (cache v3)**: navigations are network-first **with a 3.5s
  timeout** → cached page → **offline.html** (fixes the blank-white-screen on
  weak signal — a slow fetch used to hang forever). Scripts/styles are
  stale-while-revalidate (shell boots from cache; `?v=N` bump still busts it).
  Precaches the shell + offline.html + icon. Bump CACHE_NAME when changing SW
  caching. offline.html is a standalone branded "you're offline" page.
- **Client:** `push-client.js` = shared `window.MostlanePush`
  (state/enable/disable/test), included on pages that offer the toggle.
  **notifications.html** = the all-staff per-device toggle page (Turn on / off /
  Send test); linked from an always-visible "🔔 Notifications" tile on main.html.
  **main.html** also shows a dismissible "Turn on notifications" banner when a
  device is off (hidden once on / "Later" dismissed via localStorage
  mlPushBannerDismissed). notification-centre.html keeps its own (admin) copy of
  the card. All entry points share the same /push endpoints.
- **Phase 2 events (live)** — pushes fire on the same moments as the popups,
  via `ctx.waitUntil` so they never block/​break the action:
  - assets.js `/asset/transfer-request` → recipient (`b.to`).
  - assets.js `/asset/confirm/request` → each held-item holder (one push, item
    count in the body).
  - holidays.js `/holiday/request` + `/holiday/cancel` → holiday admins
    (`sendToPermission(["FullAccess","HolidayAdmin"])`, actor excluded).
  - holidays.js `/holiday/approve|reject` → the staff member (`record.username`).
  - sla.js `/sla/jobs` (POST) + `/sla/job/{id}` (PUT scheduler) →
    `notifyNewlyAssigned` pushes each engineer NEWLY added to a job (diff
    before/after so edits don't re-notify), resolving the SLA name/dotted id to
    the canonical portal username the subscription is keyed by.
  Add new event pushes the same way: import sendToUser/sendToPermission from
  ./push.js and `ctx?.waitUntil(...)` after the action succeeds.
- **Scheduled reminders (cron)** — `index.js` exports a `scheduled(event,env,ctx)`
  handler calling `vancheck.js sendWeeklyReminders(env)`: pushes every driver
  (Active + vehicle_assigned) who hasn't done/​been-skipped for THIS week's van
  check (honours mute rules). Two nudges: **Monday 07:00 London** (fixed) + a
  **dynamic chase within 2h BEFORE the portal deadline** (deadlineFor = the
  van-check settings dueDow/dueTime; never after — already missed). Self-gates
  on London time, deduped per week per slot (app_config `vancheck:reminded:<tid>`
  = ["mon:<week>","chase:<week>"]), so BST/GMT-safe and retry-safe. **Needs an
  HOURLY Cron Trigger** (dashboard → Settings → Triggers): `0 * * * *` — hourly
  so the chase tracks whatever due-time is set. New scheduled jobs hang off the
  same handler.

## Satellite systems
1. **PO system** — single-file worker (own D1 `mostlane-po`; legacy KV
   bindings unused). Identity = personal URLs per user (profile.poUrl,
   released via /po-config; portal 🧾 button). Patched previously: 🏠 back
   button; portal sync (PORTAL_DB binding mirrors portal sites+users,
   add-only, 5-min throttle). That PORTAL_DB binding can also WRITE
   audit_log — see future plans.
2. **SiteLog** — repo `Mostlane/SiteLog` (docs/ = Pages at site-log.co.uk),
   worker api.site-log.co.uk (secret ADMIN_SECRET = admin PIN; custom domain
   IS fetchable server-side; *.workers.dev hosts are NOT — error 1042).
   Portal sitelog.html: HMAC #pt= launch token binds deviceToken→person
   (stores portal_username), on-site list + geofence push via /sitelog/*
   admin proxy. 348+ portal sites pushed as geofences; new sites auto-push.
3. **H&S planner** — static app IN THIS REPO at /hs-plan/; worker
   `mostlane-hs-jobs` (own D1 + APP_TOKEN secret). Menu 🦺 builds
   `hs-plan/#worker=...&token=` via /hs-plan-config.

## FUTURE PLANS / NEXT UP (agreed with Jamie)
1. **Satellite audit logging** (agreed in principle; waiting for a DESKTOP
   session — patcher pages don't work on his phone):
   a. Quick win, portal-side, no paste: log /po-config, /hs-plan-config and
      /sitelog-launch GETs as "launched X" actions into audit_log.
   b. SiteLog scans → audit_log: Jamie adds a D1 binding (database `mostlane`)
      to the SiteLog worker in the dashboard, then a patcher makes scan in/out
      insert rows under portal_username.
   c. PO worker patcher: use its existing PORTAL_DB binding to log
      raise/approve actions.
   d. H&S: app-side beacons (repo-local edit) ± worker binding.
2. **Rebuild queue** (owner-approved: D1+R2+mostlane-api only, no KV):
   - Onboarding (onboard.html, add-driver.html — still Zapier) → /users API.
   - **Timesheets/check-in-out** (BIG): 5 old workers (ckeck-in-out,
     odd-water-f78a, timesheet, average-hours, labourhours) + ~15 pages;
     new backbone = shifts + office_shifts tables.
   - Labour planning (mostlane-labour-api), Projects (projects-ml-portal).
   - **Vehicles — DONE this session** (see Fleet / Vehicles section): registry,
     service intervals + mileage from van checks, repair docs, drag order,
     driver assignment history, fleet report + van timesheets all in-portal.
     Import from the old worker is a one-tap button. Still open: vehicles-fuel
     data, and EICR/compliance (eicr-portal*.html on old mostlane-pos KV).
   - Van-check walkaround already replaced the Jotform one (vancheck.js).
3. Help: embed a real PO screenshot when Jamie sends one; deeper SLA
   job-view guide on request; keep guides in sync with new features.
   **TODO: add Help guides for the new Vehicles/Fleet, Fleet Report, Van
   Timesheet, My Documents (GDPR) and Notification Centre pages.**
4. **Next up agreed with Jamie (started)**: MOT/tax/service due warnings as a
   red badge on the main menu tile + sidebar (like holidays/transfers), and
   possibly `?v=3` cache-bust so phones pick up the new portal-config
   (emboss + drag). Offer these when he returns.

## Retired/redirected (do not resurrect)
Old PO pages (po*.html except po.html, purchase.html), old jobs/create/job
pages, sla_scheduler.html, sla-job-view, all-sites, view-assets,
view-timesheets, holiday-calendar, admin-holiday, import-users,
engineer-report, hours-dashboard.html, add-site chain (Zapier), theme.html
(redirect only now). Static user-data files DELETED — never re-add user data
files to this public repo.

## Known quirks
- Cloudflare blocks worker→worker fetch on *.workers.dev (error 1042) — use
  browser-side fetch, or custom domains (api.site-log.co.uk works).
- Users must log out/in for new permissions to reach their session.
- SQLite datetime('now') is naive UTC — browsers misparse it as local time
  (hour off in UK summer). Store new Date().toISOString(); utcify() on read
  for old rows (pattern in assets.js / auth.js loginHistory).
- Generic `button {width:100%}` CSS on the auth pages swallows any
  absolutely-positioned button (the eye bug) — inline width:auto on such.
- iOS PWA: sessionStorage wiped on kill; bfcache replays old page JS; HTTP
  cache can pin old files mid-redirect-loop. The auth restore, server-verified
  login auto-skip + circuit-breaker, and flag-clearing redirects guard all of
  this — see Auth section before touching login/auth/device-auth.
- Owner account is "Jamie Line" (space, post-rename); legacy dotted usernames
  still arrive from phone autofill (findUser absorbs them). Chloe renamed:
  Chloe.Line → Chloe Molloy.
- Site images: sites.data JSON carries imageURL/_svAt/_noImagery flags.
- Worker delivery: always give commit + line count + expected tail so a
  truncated paste is detectable. Chat-pasting the worker truncates — never.
