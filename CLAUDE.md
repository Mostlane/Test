# Mostlane Portal — State of Play (5 August 2026)

Read this first. It is the handover brief for the whole system. The owner (Jamie)
is not a developer: he deploys by pasting into the Cloudflare dashboard and
running SQL in the D1 console — often from a phone. NO wrangler, NO local tools.
The Cloudflare connector (mcp__Cloudflare_Developer_Platform__* / a Cloudflare
d1_database_query tool) is available in sessions: D1/KV/R2 are READ-WRITE (create
tables + edit config rows directly — no SQL paste needed), workers are READ-ONLY
via the connector. **mostlane-api now AUTO-DEPLOYS from GitHub (Cloudflare
Workers Builds — see deploy section); the SiteLog & PO workers are still manual
pastes.** D1 database_ids: mostlane e483b3b5-2cfd-4742-ae51-427c31598c87,
mostlane-po bcaf5f51-3085-4cdf-a993-42278893c313, sitelog-db
1e891155-dd61-4e0e-90fe-ad5f4895f2c8.

## Architecture (one line)
Static HTML pages (this repo = mostlane-portal.com, Cloudflare Pages) + ONE
consolidated API worker (`mostlane-api`) + ONE central D1 (`mostlane`,
database_id e483b3b5-2cfd-4742-ae51-427c31598c87) + R2, with three satellite
systems (PO, SiteLog, H&S) on their own workers/DBs, bridged to the portal.

## How things deploy — CRITICAL CONVENTIONS
(Plain-English version for Jamie: **`DEPLOY.md`** at the repo root — how GitHub
→ Cloudflare works, why bindings/secrets survive, and the static-worker recovery.)
- **Pages**: the site is **Cloudflare Pages connected to this GitHub repo
  (Mostlane/Test)** — GitHub holds the code and **GitHub Pages builds + serves
  mostlane-portal.com on every push to `main`** (the "pages build and
  deployment" Actions workflow; deploy on push to `main`). Work on the
  `claude/...` branch, `merge --no-ff` into `main`, push both.
  - **CORRECTION (17 Jul):** it is **GitHub Pages, NOT Cloudflare Pages** — an
    earlier note here was wrong and cost a long debugging detour. Consequences:
    (a) **`_headers` is a DEAD file** — GitHub Pages ignores it, so its no-cache
    rules were never applied (GitHub Pages sets its own ~10-min HTML cache).
    Client freshness relies on the **service worker cache version** (`sw.js` /
    `service-worker.js` `CACHE_NAME`, currently `mostlane-v7`) + `?v=` query
    bumps — bump those to force phones to refresh, NOT `_headers`. (HTML pages
    are navigation = network-first, so their inline-script edits ride the next
    load without a CACHE_NAME bump; bump it to flush stale *cached* copies on
    phones/PWAs when a page won't update.)
    (b) A **`.nojekyll`** file (repo root) disables the Jekyll build so the site
    is published as-is. **Keep it.** Without it, GitHub ran Jekyll, whose
    `github-metadata` plugin calls the GitHub API mid-build; a transient API
    503 then crashed the build, the **deploy step was skipped**, and the live
    site silently froze on the last good build while still accepting commits.
    (c) Check deploys with the **GitHub Actions "pages build and deployment"**
    runs (mcp__github__actions_list / get_job_logs), not a Cloudflare dashboard.
- **Worker (`mostlane-api`)**: **AUTO-DEPLOYS via Cloudflare Workers Builds**,
  git-connected to **Mostlane/Test**, **root directory `worker/`** — every push
  to `main` rebuilds and deploys from `worker/src/` (entry `src/index.js`, per
  `worker/wrangler.toml`: name/main/compat_date, D1 `DB`+`PO_DB`, R2
  `JOB_FILES`+`ASSET_BUCKET`, `[triggers] crons=["0 * * * *"]`, non-secret
  `[vars]`; **secrets stay in the dashboard, never in git**). So the normal flow
  is now: edit `worker/src/`, commit, `merge --no-ff` into `main`, push — done,
  no paste. **Still rebuild the committed `dist/worker.js`+`dist/worker.min.js`**
  (`npx esbuild src/index.js --bundle --format=esm --outfile=dist/worker.js`,
  `--minify` for the min) — Workers Builds bundles from src, but dist is kept in
  sync as a source-of-truth/manual-paste fallback.
  - **Recovery history (4 Aug):** the worker had briefly become a
    "static-assets-only" type (from a stray git build) which hid the code editor
    and rejected bindings/secrets; fixed by deploying a correct `wrangler.toml`
    with Root directory `worker`. If bindings/secrets "won't save" or the Edit-
    code button vanishes, that's the symptom. Secrets don't survive that kind of
    reset — re-add them in the dashboard (list in the Secrets section).
  - **Manual-paste fallback** (only if Workers Builds is down): SendUserFile
    `dist/worker.js`, or link the committed blob
    github.com/Mostlane/Test/blob/main/worker/dist/worker.js. Give line/byte
    count + expected tail `export { index_default as default };`.
- **SiteLog worker** (`api.site-log.co.uk`, repo `Mostlane/SiteLog`, root
  `worker.js`): **still a MANUAL PASTE** (Jamie pastes into its Cloudflare
  worker). The repo IS git-connected but Jamie deploys it by paste; commit
  changes to Mostlane/SiteLog `main` as source-of-truth AND SendUserFile the
  file with line count + tail `};`. `PORTAL_BRIDGE_SECRET` must be IDENTICAL on
  mostlane-api and this worker (signs the launch token).
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
  The purple "Viewing as…" return bar (fixed bottom:0) now **lifts the field
  app's `.tabbar` above itself** (addBar measures its height, sets the tabbar's
  `bottom`) so Route/Jobs/Inbox/You stay tappable while impersonating. The
  field app's **engineer-jobs.html also has a top-left header back** (`.eng-back`
  → route.html; its own class since `.ml-back` is force-hidden there) so there's
  always an escape the bottom bar can't block.

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
  **Custom job categories** (office-defined extra statuses, e.g. "FRA Works" /
  "FRA Complete"): stored in app_config `sla_categories` = `[{name,colour,done}]`.
  **GET /sla/categories** (any session), **POST /sla/categories** (SLA admin —
  replaces the whole list; a name can never shadow a built-in status),
  **POST /sla/categories/delete** `{name, moveTo}` (SLA admin — moves any jobs
  still in the category to `moveTo`, then removes it). `normalizeStatus(status,
  extraNames)` now PRESERVES a status matching a custom category (the write
  paths — create/inbound + PATCH — pass the category names); truly-unknown
  statuses still fall back to Pending. Categories with `done:true` count as
  finished (dropped from the dashboard "Open" view like Complete/Closed).
  Front-end: sla-main.html "🏷️ Categories" toolbar button → manage modal
  (add name + `<input type=color>` + Finished tick, edit colour/done, delete
  with a "where do the jobs go?" picker). Categories merge into the dashboard
  chips/filters/bulk-mark, job-view.html status chips (custom chips carry their
  own `--cc` colour), and the sla-jobedit.js status dropdown — all load them
  from GET /sla/categories. job-view/sla-main/sla-scheduler use `sla-jobedit.js?v=7`.
  **UI polish (Aug 2026 layout pass):** sla-main.html base font bumped + set to
  "Segoe UI" (was 13px/system-ui — "too small"), back button moved to the header
  TOP-LEFT (grouped with the title in `.header-left`, no `data-role` so it stays
  visible on desktop alongside the sidebar — the vehicles.html standard), and the
  "📝 My Jobs" button is now gated to FIELD USERS only (engineers) via the
  mlFieldUser logic (office/admins already see the whole board; SLA-only engineers
  are redirected to route.html by the gate anyway). sla-scheduler.html
  **"Needs scheduling" tray** was decluttered: header shows a live count badge,
  each chip has a ✕ to HIDE it from the suggestion list (persisted client-side in
  localStorage `slaTrayHidden`, pruned to still-waiting ids on render), a
  **↩ Reinstate all** button (shown only when some are hidden) clears the set, a
  ▾/▸ toggle collapses the tray, and the chip area becomes scrollable
  (max-height) once >8 are waiting. Its back button was also moved top-left.
  The standard back-button markup portal-wide is
  `<a class="ml-back" href="…" title="Back">‹ Back</a>` placed FIRST in the header
  (no `data-role` → visible on desktop).
  **POST /sla/inbound** (PUBLIC_ROUTES; `Authorization: Bearer
  JOBS_INBOUND_TOKEN`, timing-safe compare): machine-to-machine job intake —
  the Zapier email-parser zap POSTs jobs straight in. Upserts by reference
  (re-sent email updates, never duplicates), forgiving priority ("P1"→
  "Priority 1") and date parsing, fires the assignment push, changedBy
  "zapier". Returns {ok, created, id, reference, status, priority, targetAt}.
  **DELETE /sla/jobs/{id}** (FullAccess|SLAAdmin): removes the job + purges
  its R2 files (jobs/{id}/…); 🗑 button in the shared editor (admin-only).
  **POST /sla/jobs/bulk-delete** (FullAccess|SLAAdmin): `{ids:[…]}` or
  `{all:true}`; chunk-capped (300/call) + returns `remaining` so the caller
  loops — used to clear test data before the history import.
  **Job archive (imported history)**: 22k+ historical jobs (the Commusoft
  `jobreport…xlsx`) live in a SEPARATE self-migrating table **sla_jobs_archive**
  (indexed cols + `search` haystack + full JSON in `data`), deliberately NOT on
  the live `listJobs` hot path (scheduler/day-view/dashboard load the whole
  sla_jobs table each request — the archive must never bloat that). Routes
  (FullAccess|SLAAdmin): **POST /sla/archive/import** (`{jobs:[…]}` upsert by
  id), **GET /sla/archive?q=&limit=&offset=** (paged LIKE search), **GET
  /sla/archive/count**, **POST /sla/archive/clear**. Front-end:
  **sla-data-tools.html** (admin: review + bulk-delete live jobs, then import
  the spreadsheet) parses the .xlsx entirely in-browser via **xlsx-lite.js**
  (dependency-free ZIP+inflate+XML reader — customer data never touches the
  public repo or an external tool; import batches 200 rows, dedupes duplicate
  MOS numbers by id-suffix so all rows survive). **job-archive.html** = the
  everyday search page (multi-term AND search; card title = spreadsheet Job
  Name). Both linked from sla-main header (🗄️ Archive / 🧰 Data, SLA-admin-gated).
  Jobs keep their real status so closed history stays out of engineers' active
  views.
  **Archive job FILES (photos/signatures/PDFs migrated off Workever)**: table
  **sla_archive_files** (id=source file id, mos, r2_key, kind photo|signature|
  document, type, bytes). Workever stored files on a PUBLIC S3 bucket
  (`s3.eu-west-2.amazonaws.com/workforcefmbucket/mostlane/photo/…`, the
  `_compressed` copies are real JPEG/PNG/PDF even for HEIC originals). A browser
  console **harvester** (scratchpad `workever-harvest.js`) walks Workever's
  `/api/v1/jobs-list` + `/documents/{uuid}/job/photos` and produces
  `workever-manifest.json` (MOS → file URLs; ~85k files / ~33GB). Import path
  (all FullAccess|SLAAdmin): **POST /sla/archive/photos/import** streams each S3
  url → R2 `archivephoto/<mos>/<fileId>` (skips already-stored, so re-runnable),
  **GET /sla/archive/photos/count**, **POST /sla/archive/photos/clear**, **GET
  /sla/archive/files?mos=** (signed URLs). **GET /sla/archive-file** (PUBLIC_ROUTES,
  sig-verified, streams from R2). sla-data-tools.html §3 loads the manifest and
  loops batches (80/call × 3 lanes, localStorage resume). job-archive.html shows
  each job's photos/signatures as a thumbnail grid + lightbox, PDFs as links.
  **Serving speed**: /sla/archive-file edge-caches via the Cache API (immutable);
  job-archive caps a job's grid at 8 thumbs + "show all". The same edge-cache was
  retrofitted to /asset-image + /asset-thumb (purgeAssetCache busts it on
  delete/upload/thumb-backfill) to fix the slow assets grids.
  **Dashboard 📷 + unified search**: POST /sla/jobs/photo-flags returns which live
  jobs have photos (own R2 jobs/<id>/ folder OR archive photos matching the ref);
  sla-main shows a 📷 badge (fetched once per load, applied per render). The
  dashboard search box also searches the archive (/sla/archive?q=), showing
  matches as read-only "🗄️ archive" rows; View opens job-archive.html?q=.
  **Site Photos linking**: sla_jobs_archive gains a `site_code` column
  (digitsOf(customer name), same convention as portal site codes), backfilled via
  POST /sla/archive/backfill-sites (🔗 button on sla-data-tools). /sla/site/photos
  then also returns that store's archive photos (kind='photo' only — signatures/
  PDFs stay on the job, not the site gallery). ~90% of jobs match a store; one-off
  customers with no store number stay in the Job Archive only.
  Front-end: **sla-jobedit.js** (`?v=2`, shared by sla-main / sla-scheduler /
  job-view) is the ONE-HIT editor — every Edit button opens it and it edits
  everything in one save: ref, description, priority, status, raised,
  **schedule (date · start · finish, Clear = unschedule) + assigned engineers
  (multi-tick)**, full site, note — one PATCH /sla/jobs/{id}. Exposes
  `MLJobEdit.wheelify(root)`: mouse-wheel stepping on date/time/number inputs
  (15 min per notch, Shift = 1 h, dates 1 day) — also wired to the scheduler's
  quick modal. Finish ≤ start rolls to next day (evening access windows).
  **job-view.html status control (engineer, mobile-first)**: the status dropdown
  is a grid of colour-coded **tap-to-change chips** that **auto-save on tap**
  (`pickStatus`/`buildStatusChips`; a hidden `#statusSelect` mirrors the value so
  the save/validation code is untouched). Statuses that need something first are
  `needsConfirm` (no silent save — show a labelled confirm button instead):
  Quote / On Hold (details pack), In Progress (risk assessment), and **Complete**
  (requires ≥1 photo + a completion note ≥ `MIN_COMPLETE_NOTE` chars for EVERY
  engineer, not just Story Mode; Story also needs a signature). Cross-job guard:
  moving a job to **Travelling / In Progress / Complete** is blocked while ANOTHER
  of the engineer's jobs is unfinished (`jobBlockReason`: still In Progress/
  Travelling, or On Hold/Quote without its pack) — it alerts naming that job and
  redirects straight into it to finish first.
  `sites.js` (get/add/update-site, customers, street-images, auto geofence
  push to SiteLog), `sitelog.js` (HMAC launch + admin proxy), `office.js`
  (clock segments; edits keep originals struck-through; /office/my,
  /office/timesheet), `email.js` lib (Resend templates).
- `costing.js` — **Master site register + labour ledger + job costing +
  project valuations** (see the dedicated "Job costing & SiteLog↔Portal
  integration" section below). Routes: /sites/register(+/add,/update,/merge,
  /unmerge,/ignore,/candidates,/push-candidates), /ledger/scan,/ledger/day,
  /ledger/scans, /costing/summary, /costing/prefs, /costing/reconcile-sitelog,
  /costing/eng-aliases,/eng-alias(+/delete), /costing/po-engineers,
  /costing/fin(+/valuation,+/valuation/delete), /exceptions.
- `timesheets.js` (**added 17 Jul**) — engineer weekly timesheets at **/ts/***
  (+ `lib/pdf.js`, a dependency-free PDF writer — base-14 Helvetica, WinAnsi,
  no PDFShift/external API). Engineers enter start/finish + job(s) per day
  (page: **engineer-timesheet.html**, tile "⏱️ My Timesheet", NEW permission
  **EngTimesheet**); admin (**timesheets-admin.html**, tile "🧾 Engineer
  Timesheets", existing TimesheetAdmin|FullAccess perm) sees everyone's week.
  EVERYTHING AUTOSAVES (Jamie's rule: no manual save buttons on any timesheet
  page) — debounced ~1s, instant on taps, 8s retry loop, keepalive flush on
  pagehide, flush before week-nav/modal close; status text shows Saved ✓.
  Per-user deduction switches (app_config `engts:cfg:<tid>` — no schema churn):
  **commute** (30 min each way, shown greyed/read-only on the engineer's page),
  **lunch** (30 min on days ≥ 6 h), **mileage** allowed, rate (£/hour or /day),
  pence-per-mile, home postcode, next invoice number; defaults + the invoice
  "To" company block editable in the admin ⚙️ Settings modal. Tables (live in
  D1 + schema.sql): **eng_timesheets** (PK tid/week/username, data JSON) and
  **eng_invoices** (UNIQUE per user+number and per user+week). Self-employed
  (users.employment_type ~ "Self Employed"): invoice card on their page —
  set-once **starting invoice number** (POST /ts/invoice/next; numbers then
  count up: next = max(existing)+1, so deleting the newest frees its number),
  **POST /ts/invoice** re-saves the week, computes totals server-side, builds
  the PDF, stores R2 `invoices/<tid>/<user>/INV-<n>-<week>.pdf`, and LOCKS the
  week (saves 409 until admin deletes the invoice via /ts/invoice/delete).
  Retrieval: GET /ts/invoices (own; admin ?u=all), signed URLs → **GET
  /ts/invoice-file** (PUBLIC_ROUTES, sig-verified). **GET /ts/jobs?q=** feeds
  the jobs-box suggestion chips: open sla_jobs refs + portal/PO_DB sites BY
  NAME with or without a job number (engineers are "on" places — a name-only
  match inserts the site name, commas softened to " – " so the
  comma-separated box doesn't split it); the page also merges
  compliance-store names into the jobs chips client-side. PO_DB suggestions
  come from TWO discoveries: the PO sites table AND site names harvested off
  the PO rows themselves (poOrderDiscover/poOrderSiteNames: po/purchase/order
  table, columnar `site` col or JSON rows, last 800 rows deduped, 5-min
  isolate cache) — plenty of PO sites exist ONLY as text on POs (e.g.
  "Lakeside Surgery, Verwood"); /ts/po-status reports both discoveries.
  **Job-status time capture (20 Jul)**: sla.js status changes call
  timesheets.js trackJobTime (both PATCH paths, ctx.waitUntil): Travelling/
  In Progress by an ASSIGNED engineer opens a row in **job_time_segments**
  (closing their open segment on any other job); every other status closes
  it; office edits never track. GET /ts/my returns `auto` (per-London-day
  window + jobs incl. site/postcode); engineer page fills ONLY empty fields
  from it (green "⏱ From your jobs" line, job pills + preset mileage added,
  persisted via autosave); /ts/admin/overview overlays the same so admin
  sees captured days even if the engineer never opens the page. Segments
  left open on a previous day are lazily closed (~19:00 UK or start+1h).
  RESOLVED 18 Jul: the original "PO sites don't suggest" saga was a WRONG
  BINDING — Jamie had PO_DB pointed at the `mostlane` (portal) D1, so
  discovery kept "working" against the portal (the tables[] list in the
  status line is how it was caught — it showed eng_timesheets etc.). Correct
  binding = database `mostlane-po`. That DB has NO recognisable sites table —
  its site names live ONLY on the PO rows (orderSites discovery), which the
  status line reports as healthy (green, "site names on the PO records"). The admin
  Settings column for the mileage switch is labelled **"Fuel (mileage)"** —
  that's Jamie's word for it. **PO sites (17 Jul)**: portal→PO site sync is
  add-only, so sites created inside the PO system never reach the portal —
  /ts/sites + /ts/jobs therefore ALSO read the PO system's own D1 via an
  OPTIONAL **PO_DB binding** (dashboard → mostlane-api → Bindings → D1 →
  variable `PO_DB` → database `mostlane-po`). The PO schema isn't in this
  repo, so timesheets.js **discovers** the site storage at runtime
  (sqlite_master + PRAGMA + row sampling; recognises THREE shapes: columnar
  site tables, per-row JSON objects in a data/value column, and KV-style
  blob = one JSON array of sites; field aliases siteName/postcode/jobNumber
  etc.; cached per isolate; fails soft to portal-only when unbound).
  **GET /ts/po-status** (admin) reports bound + discovered mode/table +
  sample sites — and when nothing was recognised, every PO table + its
  columns. The admin Settings modal renders this as a plain-English status
  line (old worker build / missing binding / unrecognised schema / OK) —
  FIRST place to look when "PO sites don't suggest". **Compliance stores
  (17 Jul)**: what Jamie ALSO calls "PO sites" are the store lists on the
  `mostlane-pos` KV worker (Retail/ELS/ELS Private/Cobra/Wenzels,
  spreadsheet-shaped records). engineer-timesheet.html fetches its PUBLIC
  CORS'd GET /Compliance/combined BROWSER-SIDE (workers.dev is 1042-blocked
  server-side), heuristic-maps name/postcode (postcode regex over values
  covers address-embedded ones), caches 15 min in sessionStorage, and merges
  into the site picker alongside portal + PO_DB sites. **Mileage (reworked
  18 Jul)**: per-site ROUND-TRIP miles live in the **site_miles** table
  (self-migrating; key = normalised site name) — the register the admin edits
  via "🗺️ Site mileage" on timesheets-admin (autosaving rows, ➕ add one-offs,
  "⚡ Work out missing" loops POST /ts/miles/autofill 25-at-a-time estimating
  from defaults.basePostcode, default **PO15 5RQ**, via postcodes.io
  haversine × 1.25 × 2 — an ESTIMATE, always editable). /ts/sites suggestions
  carry `miles`; picking a site auto-fills the engineer's miles box (GET
  /ts/miles?name= is the single lookup; 🧮 falls back to a base→postcode
  estimate — home postcode no longer used). **10-mile radius rule**: per-user
  `radius` tick (+ defaults radiusMiles 10) — first/last N mi of each day
  unpaid: claimed = max(0, dayMiles − 2N) per day, shown on the engineer page
  and itemised on the invoice PDF ("66 mi − 28 mi (first/last 10 mi/day) =
  38 mi @ 45p"). No new worker secrets needed (filesign reuses
  PORTAL_BRIDGE_SECRET). Activity-log FRIENDLY entries added.
- `vancheck.js` — weekly van checks (replaces the old Jotform walkaround):
  driver form (mileage + photo slots → R2 vancheck/…), /vancheck/week admin
  grid, badges. Settings (van-checks.html ⚙, FullAccess) = due day/time +
  editable **checklist** (OK/Defect), **equipment** (Present/Missing, opt-in —
  empty by default; a missing item counts as an issue) and **photo slots**; all
  three ride in the app_config `vancheck:settings` JSON and are returned by
  /vancheck/config + /vancheck/settings. van-check.html shows the equipment
  section only when items exist and merges its answers into the same answers map.
  **"Alert if" rules + notifications:** checklist/equipment items carry an
  optional `{alert:true, alertOn:"defect"|"missing"}`; `vancheck:settings` +
  `handover:template:<tid>` also hold `alertUsers` (recipient usernames). The
  template editors (van-check settings + handover template on van-checks.html)
  are **structured rows** — label · ☑ Alert if · answer select — plus a recipient
  picker (shared helpers). On submit, `evalAlerts(answers, tpl)` (exported from
  vancheck.js, used by both van-check + handover submit) returns fired alerts
  `[{id,label,answer}]`, **stored on the record** (items.alerts) and **pushed** to
  alertUsers (sendToUser). A fired alert shows a ⚠ pill on the admin grid + the
  vehicle Checks history + an alert banner in the detail. vehicle-checks.html adds
  an **⚠ Issues** panel (every defect/missing across checks+handovers, alerts
  highlighted, alerts-only toggle) + a **🔎 By question** filter (pick any item →
  every answer over time: driver · date · answer). /fleet/vehicle-checks +
  /fleet/handovers return `alerts`. **/vancheck/skip** (admin skips a driver's week → writes a
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
- **Specifications** (extra per-vehicle fields — AC, payload, dimensions,
  handsfree, VIN…): `vehicles.specs` column = JSON `[{label,value}]`. The edit
  modal (vehicles.html) seeds a preset list (Air con/Handsfree/Payload/Length/
  Height/Width/Load length/VIN/Euro-ULEZ/Colour) but every row's label is
  editable and "＋ Add field" appends custom rows; blanks are dropped on save.
  Shown on the deep-dive card. `/fleet/vehicle` POST writes specs with a
  SEPARATE non-destructive UPDATE (only when supplied) so the legacy import
  never wipes them. `/fleet/vehicles` GET returns `specs` (parsed array).
- **Maintenance log** (replaced the old loose "📎 Docs" — see below): a
  categorised, dated, cost-split work history per vehicle on a dedicated page
  **vehicle-maintenance.html?reg=…** (🔧 Maintenance button on each card + the
  deep-dive). A record = date + description + optional document + one or more
  category allocations `[{cat,cost}]`. A shared invoice splits its cost across
  categories (Brakes £200 / Tyres £250) — the SAME document then shows under
  each category when filtered, and each category's total combines across
  records. Table **vehicle_maintenance** (self-migrating; documents in R2
  JOB_FILES `vehiclemaint/<tid>/<REG>/…`). Categories are a managed list in
  app_config `fleet:maintcats:<tid>` = `[{name,colour}]` (defaults until edited;
  colours drive the chart + badges). Routes (FullAccess|Vehicles):
  **GET /fleet/maintenance?reg=** (records + per-category totals + grandTotal +
  categories), **POST /fleet/maintenance** (multipart: reg,id?,date,description,
  allocs JSON, file?, removeDoc?; new file replaces the old doc), **POST
  /fleet/maintenance-delete** `{id}` (also purges the R2 doc), **GET/POST
  /fleet/maint-categories**, **GET /fleet/maintenance-doc** (PUBLIC_ROUTES,
  sig-verified, streams inline). The page shows a spend-per-category bar chart +
  tap-to-filter chips + a chronological timeline (date · description · coloured
  category badges w/ per-cat cost · total · open-document · edit). vehicle-delete
  purges the maintenance rows + their R2 docs.
- **Old vehicle documents** (`/fleet/vehicle-doc*`, R2 `vehicledocs/…`): the UI
  was REMOVED (replaced by the Maintenance log). The GET/list/POST/delete
  endpoints remain in fleet.js so any old signed links still open, but nothing
  surfaces them now; previously-uploaded loose docs were NOT auto-migrated.
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
- **Fuel cards, MPG & running cost** — page **fuel-cards.html** (⛽ Fuel Cards
  button in the vehicles header, shown to ANY Vehicles user). A fuel card = a
  user's `profile.fuelCard` (set in Users Admin). Log fill-ups (**date · litres ·
  cost £**) per card → table **fuel_entries** (self-migrating). **Access split:
  fuel (cards/entries/stats/MPG/spend) is open to any Vehicles user (`canFleet`);
  the vehicle FINANCIALS + the running-cost rollup stay Full-Access (`canMoney`).**
  Routes (Vehicles): **GET /fleet/fuel/cards** (card→user→current van), **GET
  /fleet/fuel/entries?card=**, **POST /fleet/fuel/entry** (create/update), **POST
  /fleet/fuel/entry-delete**, **GET /fleet/fuel/stats?card=** (overall +
  per-period + per-vehicle; the response's `money:true/false` says whether
  per-vehicle `running` cost was included — the page hides that column when false).
  - **MPG** (`mpgByVehicle`, all-available-data): litres attributed to a vehicle
    via card→user→**assignment-at-date** (`vehicle_assignments`, fallback current
    `vehicle_assigned`) ÷ UK gallon (4.54609), miles = the van's van-check
    odometer span (max−min, needs ≥2 readings). Shown as **Current MPG** on the
    vehicle cards + deep-dive (MPG isn't money, so any Vehicles user sees it);
    `/fleet/vehicles` returns `currentMpg` for everyone.
  - **Stats** foldable **Weekly / Monthly / 3-Monthly / Yearly** (`periodStats`):
    every average = total ÷ (real data span in days) × period days; a period
    LONGER than the real span is flagged **`projected`** in the response and
    badged in the UI. "Based on N weeks of real data" is always shown.
  - **Vehicle financials** — `vehicles.finance` JSON column
    {ownership owned|financed, insuranceYear, roadTaxYear, financeMonthly,
    financeEnd, allowedMiles, excessPence}. Edited in the vehicles.html edit
    modal (💷 Financials group, FullAccess only), saved via **POST /fleet/finance**
    (FullAccess-gated, separate from /fleet/vehicle so Vehicles-only users can't
    write/read money).
  - **Running cost / year** (`runningCost`): insurance + road tax + finance
    (financed→monthly×12) + **projected** fuel (from the van's own spend/day
    ×365) + maintenance (real, last 12 months from vehicle_maintenance) +
    **projected** excess-mileage charge (financed with an allowance: projected
    annual miles over allowedMiles × excessPence). Returned in /fleet/vehicles +
    /fleet/fuel/stats for FullAccess only; shown on the deep-dive ("Cost to run
    /year") and the fuel page's per-vehicle table with a `projected` badge.
- **Van check history + Van handovers** (page **vehicle-checks.html?reg=**,
  reached from a 📋 Checks button on each card + the deep-dive):
  - **Van checks** — **GET /fleet/vehicle-checks?reg=** returns every completed
    weekly check for that reg from the shared `vehicle_checks` table (skips
    excluded), with photos (ASSET_BUCKET keys served by the public /asset-image
    + /asset-thumb). The page groups them into **collapsible month dropdowns**;
    tapping one opens its photos + checklist answers (labels resolved from
    /vancheck/settings).
  - **Van handovers** — a NEW detailed condition check sent to a newly-assigned
    driver. Table **vehicle_handovers** (self-migrating; status
    pending|done|cancelled|superseded). Template = checklist + **equipment**
    (Spare wheel / Jack / Tyre tools / Locking wheel-nut key… as separate items) +
    photo slots; **customisable** on van-checks.html ("🤝 Handover template"
    button, FullAccess) via **GET /fleet/handover/template** (any Vehicles user) +
    **POST /fleet/handover/template** (FullAccess; item id = slug(label)), stored
    in app_config `handover:template:<tid>` (defaults in fleet.js until edited).
    The vehicle-checks.html handover detail labels answers by the CURRENT template
    but falls back to the raw id, so a later template edit never hides old records.
    The driver form **van-handover.html** (modeled on van-check.html: OK/Defect
    + Present/Missing toggles, interior/exterior condition, a **damage log**
    [{note,photo}], photo slots, mileage, safe-to-drive, and a **required drawn
    signature**; IndexedDB draft). Photos + signature → ASSET_BUCKET under
    `handover/<user>/<id>/…`.
    - **Trigger:** assigning a driver in vehicles.html pops **"Send a Van
      Handover to <driver>?"** → **POST /fleet/handover/request** {reg,username}
      creates a pending row + pushes the driver (sendToUser).
    - **Required + push + attention gate:** pending handovers surface in
      main.html's blocking attention gate via **GET /fleet/handover/attention**,
      as a note with **maxSnooze:1** (one 4-hour snooze then enforced — stricter
      than the van check's 2×). The gate now honours a per-note `maxSnooze`
      (defaults to SNOOZE_MAX=2). Clears when submitted.
    - Routes: **GET /fleet/handover/mine** (driver's pending one + template),
      **POST /fleet/handover/submit** (assigned driver or FullAccess; stores
      photos/signature, marks done, notifies the requester), **POST
      /fleet/handover/cancel** {id} (admin), **GET /fleet/handovers?reg=** (full
      history + template, for the listing page). /fleet/vehicles returns
      `lastHandoverId`/`lastHandoverAt` (card's direct 🤝 Handover link →
      vehicle-checks.html?reg=…&open=ho<id>) + `pendingHandover` (a "Handover
      pending" card pill). vehicle-delete purges handover rows + their photos.
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

## Job costing & SiteLog↔Portal integration (costing.js + job-costing.html — Aug 2026)
The big Aug workstream: one **master site register** and a **per-site/per-job
P&L** that unifies labour (SiteLog scans + SLA job-status taps), materials (PO
spend) and project valuations. Direction-of-travel rule: **the portal always
PULLS from SiteLog** — mostlane-api is on `*.workers.dev` so SiteLog→portal
fetch is blocked by Cloudflare 1042; `api.site-log.co.uk` is a custom domain and
IS fetchable server-side, so the portal calls it (via SITELOG_ADMIN_SECRET).
- **Site register** (`sites` table + `app_config` `site_aliases`,
  `site_reg_ignore`, `site_reg_ext`): active/archive, **merge** (alias a name →
  a canonical site; resolveSite/resolveSiteCode use byNorm+byCode+aliases),
  candidates harvest. Front-end **sites-register.html**. **Coordinates→SiteLog:**
  /sites/register/add+update accept {lat,lng}, store in the site's data JSON, and
  push a geofence to SiteLog (`/bulk-add-sites`, radius 500); the page has lat/lng
  fields + "📍 From postcode" (postcodes.io) + per-row "Set location".
- **Labour reconciliation** (`job_time_segments` = SLA status capture, primary;
  `sitelog_scans` = optional pushed scans; buildDay clips scans to non-overlap).
  **Runaway-session clamp:** any segment (open OR "closed" only when the next job
  was tapped days later) longer than **14h** is clamped to a forgot-to-finish
  close on its start day + flagged auto-closed — in BOTH buildDay (costing.js)
  and jobTimeAuto (timesheets.js). Stops a stale "In Progress" job billing days.
- **GET /costing/summary** — per-site card data. Folds in: **SiteLog /job-costing**
  (authoritative per site+person; employees=linked portal users costed at PORTAL
  rate+fuel, subcontractors=SiteLog's own cost; the person's SLA time at that site
  is dropped to dedupe), **SLA labour** (portal rates), **PO spend** (PO_DB
  po_log). Each site returns: laborCost, poTotal, grandTotal, engineers[] (with
  `src` sitelog|sla|mixed, `visits`=on-site days), `suppliers[]` (spend per
  supplier), `series` (spend-over-time, bucketed day/week/month over the site's
  OWN active date span — NOT the requested range, so "All time" isn't one spike),
  `key` (stable id), and `fin` (project financials, below). Also returns
  `sitelog:true/false` (false = SiteLog unreachable → SLA-only, banner shown).
- **Project valuations** (`app_config` `proj_fin` per site key): contract value,
  N valuations planned, each valuation {amount,date,note,final}. computeFin
  returns valued, cost, position (valued−cost), margin%, remaining, **suggested
  next valuation** (max of break-even and even-share, capped at remaining),
  per-valuation **cost-vs-profit at the time** + running profit, **costSinceLastVal**
  (reconciles last valuation's running profit to current position), and
  **retention** (5% interim; on the `final` valuation the 5% releases and 2.5%
  of project VALUE is held). POST /costing/fin, /costing/fin/valuation(+/delete).
- **View prefs** (`app_config` `costing_prefs`): pin / hide / drag-order site
  cards (shared across admins). GET/POST /costing/prefs.
- **Engineer aliases** (`app_config` `eng_aliases` = normName→portal user):
  collapse PO/SiteLog name variants into one person (e.g. **"JT"→"John Thorn"**);
  applied across SLA, SiteLog and PO in costing (canonEng). GET /costing/eng-aliases,
  POST /costing/eng-alias(+/delete), GET /costing/po-engineers (distinct PO names).
- **/exceptions** — auto-closed / site-mismatch / archived-site / unmatched-site
  / unallocated / claimed-vs-captured, incl. unmatched SiteLog sites.
- **P4 reconcile** (`reconcileSitelogSessions`, hourly cron + POST
  /costing/reconcile-sitelog): pulls recent SiteLog visits (/admin), and for
  LINKED employees closes an SLA session left open at scan-out + materialises a
  segment from a scan (idempotent via `sitelog_visit_id`). Open (no scan-out)
  visits cost NOTHING until closed; SiteLog's own cron auto-closes them at 16:00
  (day shift) / +12h (evening), after which they're costed.
- **job-costing.html**: range 7d/28d/3mo/**All time**; each card pins/hides/drags;
  **Hidden** tab; **expand a card** → per-job labour-vs-materials doughnut +
  spend-over-time line (inline SVG, no libs), spend-per-supplier, people (hours +
  on-site days + src badge), **project financials** block, and **🔗 Merge into
  another site / ➕ Add to register** (merge any visible site — incl. all-time /
  SiteLog-only names — into a register site). Header links to sites-register.html
  and **sitelog-links.html**.
- **sitelog-links.html** ("People links", FullAccess): two tabs — **SiteLog
  scanners** (set portal_username via /sitelog/update-engineer through the admin
  proxy) and **PO raisers** (set eng_alias). Auto-suggests the matching portal
  user; one portal user ↔ one person per system. This is the manual backfill for
  the auto identity-link (P1).
- **SiteLog↔portal identity (P1)**: opening SiteLog from the portal tile
  (sitelog.html → /sitelog-launch → SCAN_URL#pt=<HMAC token>) makes SiteLog bind
  that phone→portal user (`/portal-link`, stamps people.portal_username). One
  launch per phone, then permanent; cross-origin means it can't be zero-touch.
  Unlinked people are costed on SiteLog's own rate+fuel (fine for subbies).

## D1 `mostlane` tables
users (profile JSON holds poUrl, theme, prefs, rates…), user_permissions,
sessions, devices, login_history, password_resets, holidays(+config/log/
allowance/system_days), assets, asset_transfers, asset_transfer_requests,
sites, customers, sla_jobs, shifts, vehicle_checks, office_shifts, oncall_log,
daily_logs, app_config, portal_keys, key_log, notify_log, audit_log,
**vehicles** (+`specs` JSON [{label,value}] extra fields, +`finance` JSON
financials), **vehicle_assignments**,
**vehicle_maintenance** (categorised, cost-split maintenance log; docs in R2
`vehiclemaint/<tid>/<REG>/…`), **vehicle_handovers** (detailed handover checks
sent to newly-assigned drivers; photos+signature in ASSET_BUCKET
`handover/<user>/<id>/…`), **fuel_entries** (fuel-card fill-ups → per-vehicle
MPG + running cost), **van_timesheets**, **sla_jobs_archive**
(imported job history — separate from live sla_jobs), **eng_timesheets**,
**eng_invoices** (engineer weekly timesheets + self-employed invoice register;
PDFs in R2 JOB_FILES `invoices/<tid>/<user>/`), **job_time_segments** (SLA
status-capture time; +`sitelog_visit_id` links a segment materialised from a
SiteLog visit), **sitelog_scans** (optional pushed scans), **site_miles**
(round-trip miles per site). app_config also
holds JSON blobs keyed `fleet:drivers:<tid>`, `fleet:poolalloc:<tid>`,
`fleet:paycfg:<tid>`, `fleet:vehorder:<tid>`, `fleet:vehcover:<tid>`,
`fleet:maintcats:<tid>` (vehicle-maintenance categories [{name,colour}]), the
notification-suppression rules, and the costing keys `site_aliases:<tid>`,
`site_reg_ignore:<tid>`, `site_reg_ext:<tid>`, `eng_aliases:<tid>`,
`proj_fin:<tid>` (project value + valuations), `costing_prefs:<tid>` (pin/hide/
order), `engts:cfg:<tid>` (timesheet rates + pencePerMile). The SiteLog D1
(`sitelog-db`) holds people(+portal_username, hourly_rate, fuel_paid, fuel_rate,
travel caps), devices(device_token→person_id), visits. R2 (JOB_FILES): `fleetreports/<tid>/…`,
`vehicledocs/<tid>/<REG>/…`, `vehiclephotos/<tid>/<REG>/…`; staff docs via
hrdocs. All fleet tables are self-migrating (CREATE TABLE IF
NOT EXISTS + ALTER on read) — no manual SQL needed.

## Notifications system
- Red badges on tiles (main.html) + sidebar (portal-config) from
  /asset/transfers/pending-count, /holiday/my (unseen decisions),
  /holiday/all (pending + staff cancellations). "Seen" markers are per-USER
  via /prefs (server), mirrored in localStorage (newer timestamp wins) — so
  dealing with something on one device clears it on all devices.
- **Van-check badge drill-down (Aug 2026)**: the Vehicles tile / sidebar badge
  (`/vancheck/attention`: driver's own `mineDue` + admin `missing.length`) is now
  MIRRORED onto the **"Van Checks" button inside vehicles.html** (`#vanChecksBtn`,
  same count). The admin "missing this week" portion clears once they open
  **van-checks.html** for the week — a per-user seen marker **`vcSeen`** (=/prefs
  the server's `week` string + localStorage `mostlaneVcSeen` mirror, newer wins),
  applied in main.html (tile + note), portal-config.js (sidebar) and vehicles.html
  (button); van-checks.html writes it on load. The driver's own `mineDue` is NOT
  cleared by viewing (it clears when they submit their check). Week-scoped, so it
  re-appears next week. No worker change (/prefs merges arbitrary keys).
- **Attention gate** (main.html): phones get a BLOCKING overlay listing
  outstanding items (no dismiss button); desktop gets a dismissible corner
  panel (sessionStorage sig). "💤 Remind me later" = 4h snooze, max 2 per
  notification (identified by page+count; counts shared across devices via
  prefs), then enforced. A note may carry **`maxSnooze`** to override the 2×
  default (the **van handover** uses `maxSnooze:1` — one 4h snooze then
  enforced). Every shown/snoozed/opened/dismissed is POSTed to
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
help.html — ❓ tile (always visible, incl. Story users) + sidebar item. 50+
task-level SOP guides in a GROUPS array (incl. a **"Vehicles & fleet"** group:
weekly van check, complete a handover, maintenance & costs, checks/handover
history + issues, fuel cards & MPG, cost-to-run + set-up-checks/alerts — the last
two `__fullOnly`; driver guides "always"), each tagged perms:"always" or an
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
- **Drag-to-reorder tiles (mobile, Aug 2026)** — iOS-home-screen style: a
  **long-press** (~2.5s — deliberately long so slow taps never trigger it)
  on any visible tile enters "arrange" mode (tiles wobble
  via `.menu-grid.reordering`, a fixed `#reorderBar` "Drag tiles, then Done"
  appears) and immediately grabs the held tile; drag reorders with a pointer-based
  placeholder + edge auto-scroll (same engine as vehicles.html). **Done / the ✕ /
  tapping the background** all save + exit. Order is the DOM order of tile element
  **ids**, saved to localStorage **`mlMenuOrder`** (instant paint via `layoutTiles()`,
  which also re-runs the odd-tile `full-width` rule) AND mirrored to **`/prefs`
  `menuOrder`** so it follows the user across devices (GET on load reconciles
  server→local). Every gated tile plus the always-on ones is movable — Help and
  Logout were given ids (`Help`/`Logout`) so their positions persist; the pinned
  Story "Back to My Day" (`backToMyDay`) is excluded (rank -1, always first). The
  grid is desktop-hidden (sidebar), so this is inherently a mobile feature. No
  worker change — `/prefs` already shallow-merges arbitrary keys (8KB cap).
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
vehicles.html, vehicle-maintenance.html, vehicle-checks.html, van-handover.html,
fuel-cards.html, job-costing.html, sites-register.html, sitelog-links.html.
**ADD NEW HOT PAGES HERE when created** — a page shipped
without no-cache once got cache-poisoned on phones (that's why
personalise.html had to replace theme.html). (NB: _headers is a DEAD file on
GitHub Pages — real freshness is the SW cache version + `?v=` bumps; this list
is kept as documentation of the hot pages.)

## Secrets/vars on mostlane-api (dashboard)
RESEND_API_KEY, MASTER_PASSWORD, HS_PLAN_TOKEN, PORTAL_BRIDGE_SECRET,
SITELOG_ADMIN_SECRET, **VAPID_PRIVATE**, **JOBS_INBOUND_TOKEN** (secrets); EMAIL_FROM, R2_PUBLIC_BASE,
**VAPID_PUBLIC**, optionally **PUSH_CONTACT** (mailto: for VAPID sub) /
SESSION_TTL_HOURS / OWNER_USERNAME (vars); R2 bindings JOB_FILES
(mostlane-job-files) + ASSET_BUCKET (mostlane-asset-images); D1 binding DB
(mostlane) + OPTIONAL PO_DB (mostlane-po — PO-site suggestions on the
engineer timesheet AND PO spend in job costing). After changing dashboard
secrets you must hit Deploy. Job costing's SiteLog pull uses SITELOG_ADMIN_SECRET
(→ api.site-log.co.uk); optional var `SITELOG_API` overrides that base URL.
All of the above are declared in `worker/wrangler.toml` too (vars/bindings) so a
Workers Builds deploy restores them; **secrets are dashboard-only**.

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
   audit_log — see future plans. **Job→PO prefill (20 Jul)**: job-view.html's
   "Raise PO for this job" button appends `#mlpo=<base64(JSON)>` (jobRef,
   jobId, site, address, description, by — encoded
   btoa(unescape(encodeURIComponent(...)))) to the engineer's personal PO URL;
   the PO worker's engineerPage() `prefillFromJob()` decodes it and fills Site
   + Incident/job number ONLY when those fields are empty (supplier +
   description stay the engineer's to type; green "✓ Pre-filled from job …"
   note; office-hours gate still hides the form so no prefill then; bad
   payloads fail silent to a blank form). Full patched worker was delivered
   20 Jul (2,311 lines, tail `function escapeHtmlServer(s) …`) — Jamie pastes
   it into the PO worker in the Cloudflare dashboard. my-day.html's generic
   "Raise a PO" link carries no payload (by design).
2. **SiteLog** — repo `Mostlane/SiteLog` (docs/ = Pages at site-log.co.uk;
   worker `worker.js` = **manual paste**, not auto-deployed; commit to
   Mostlane/SiteLog `main` as source-of-truth). Worker api.site-log.co.uk
   (secret ADMIN_SECRET = admin PIN + PORTAL_BRIDGE_SECRET matching mostlane-api;
   custom domain IS fetchable server-side; *.workers.dev hosts are NOT — 1042).
   Portal sitelog.html: HMAC #pt= launch token binds deviceToken→person
   (stores portal_username), on-site list + geofence push via /sitelog/*
   admin proxy. 348+ portal sites pushed as geofences; new sites auto-push.
   **Costing-relevant endpoints added Aug 2026** (portal PULLS these): `people`
   gained **portal_username** (the portal link); **POST /portal-link** (verifies
   the #pt token, stamps portal_username onto the scanning person); **GET
   /job-costing?from=&to=** (per-site/per-person labour, same maths as its
   admin.html — jcCostVisits; open/no-sign-out visits cost £0, SiteLog's cron
   auto-closes them 16:00/+12h); **/update-engineer** now also sets
   portal_username (powers the manual People-links page). `/admin?from=&to=`
   returns raw visits (portal dates SiteLog labour + P4 reconcile from these).
   Worker last pasted ≈ the /update-engineer-portal_username build (3,184 lines,
   tail `};`); before that the /job-costing build. Confirm with Jamie what's live.
3. **H&S planner** — static app IN THIS REPO at /hs-plan/; worker
   `mostlane-hs-jobs` (own D1 + APP_TOKEN secret). Menu 🦺 builds
   `hs-plan/#worker=...&token=` via /hs-plan-config.

## FUTURE PLANS / NEXT UP (agreed with Jamie)
0. **Job costing & SiteLog↔Portal — DONE (Aug 2026)**, see the dedicated
   section: site register + coordinates→SiteLog geofence, unified labour
   (SiteLog+SLA deduped) + PO + project valuations/retention, per-job charts,
   spend-per-supplier, pin/hide/drag, People-links (SiteLog + PO). **Loose
   ends for next phase:** (a) fix pencePerMile 0.25→25/45 (see Known quirks);
   (b) get engineers linked (People-links backfill, or the SiteLog "Connect to
   portal" prompt — not built); (c) optional deeper cost views. Jamie is
   starting a NEW project for the next phase.
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
   **Vehicles/Fleet Help guides DONE** ("Vehicles & fleet" group — text-only,
   no screenshots yet). **TODO: add Help guides for Fleet Report, Van
   Timesheet, My Documents (GDPR) and Notification Centre; and stage screenshots
   for the new Vehicles guides (help-img/, mocked "User 1/2/3" data).**
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
- **API fetches bypass the service worker** (sw.js skips workers.dev /
  cross-origin), so they have NO timeout of their own. A page that hides its
  UI behind an `await`ed API call (e.g. a permission `gate()`) will FREEZE on a
  blank screen on weak signal — the fetch just never resolves. Fix pattern:
  race the fetch against a timeout so a hang falls into the catch and the page
  still renders (sla-main.html `authFetchTO()`, used on the gate `/user` lookup;
  job-view.html has a `Promise.race` timeout on its category fetch). Keep
  secondary data (like categories) OFF the first-paint critical path — load it
  after the board shows and merge it in when it arrives.
- **pencePerMile is stored in PENCE** (code does `miles × pencePerMile ÷ 100`;
  default 25/45). But every user's per-user value in `engts:cfg` byUser is set
  to **0.25** — read as 0.25p/mile (~£0), so timesheet mileage AND (once a person
  is linked) job-costing fuel come out ~1/100th. **OPEN:** fix per-user (and the
  default) to 25 (or 45 HMRC) — Jamie to confirm the rate before bulk-changing
  (touches pay/invoices). Unlinked SiteLog people are unaffected (SiteLog's own
  fuel_rate 0.25 there means £0.25/mile — SiteLog treats it as £/mile, correct).
- **SiteLog identity is one-launch, not zero-touch:** portal & SiteLog are
  different origins, so SiteLog can only learn the portal user when the portal
  hands over the #pt token at launch (sitelog.html tile). Home-screen/bookmark
  opens skip it. As of 5 Aug NO SiteLog people were linked yet (portal_username
  all null) — use sitelog-links.html to backfill, and/or get engineers to open
  SiteLog via the portal tile once. Considered but not built: a "Connect to
  portal" prompt inside SiteLog for unlinked phones (needs a SiteLog paste).
