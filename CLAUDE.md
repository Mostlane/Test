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
  `JOB_FILES`+`ASSET_BUCKET`, `[triggers] crons=["*/5 * * * *"]`, non-secret
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

## portal-config.js (every page includes it FIRST — as `/portal-config.js?v=3`)
All 90+ pages reference `?v=3` (cache-bust). If a portal-config change must
reach stubborn phone caches, bump to ?v=4 across all pages with sed. Provides:
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
  `bottom`) so the tabs stay tappable while impersonating. The
  field app's **engineer-jobs.html also has a top-left header back** (`.eng-back`
  → route.html; its own class since `.ml-back` is force-hidden there) so there's
  always an escape the bottom bar can't block.
- **Field-app bottom tabbar (Aug 2026 rework)** — the four tabs on route.html /
  engineer-jobs.html / inbox.html / you.html are now **Route · Jobs · PO · Menu**
  (were Route/Jobs/Inbox/You). **PO** (`#tabPO`) resolves to the engineer's
  personal PO link via GET /po-config (falls back to po.html); **Menu** →
  main.html (field users use the full office tile menu — everything they can open
  is a permitted tile there, so the old you.html permission-launcher is no longer
  linked, though the file remains). **Field-user "home" = main.html**:
  portal-config's back-button repoint (`data-role="home"`, for field users on
  non-field-app pages) now targets **/main.html** (was /you.html). **Van Check
  tile** (`#VanCheck`, main.html) is shown ONLY to field users (kept out of the
  MAP so admins/office don't see it; gated in applyGate by staffType field / the
  SLA-Story heuristic) so they can do a check anytime — the reg auto-fills from
  their assigned van as before. **van-check.html Back → main.html for field
  users** (never vehicles.html): the page carries its own inline guard (runs on
  load + a 600ms re-assert) so it's the final word over any cached portal-config.
  **Chat moved to the bubble**: the live-chat
  widget (chat-widget.js) is now injected for FIELD users too (portal-config
  chatWidget no longer skips staffType field — only the field-app pages + Story
  users are skipped), so engineers chat via the 💬 bubble on main.html and other
  portal pages instead of a dedicated Inbox tab. Field-user landing on login is
  still route.html. engineer-jobs.html's **"📌 Assigned — not booked in"** box is
  now a **collapsible** (default collapsed, tap the banner; per-device state in
  localStorage `mlUnschedOpen`). Its week list runs **Mon–Sun** (startOfWeek is
  Monday-based). The **🗺️ map overlay** (`openDayMap`) fetches all the engineer's
  jobs once (`/jobs/for-engineer` no date) then a **Day/Week/Month/Year segmented
  slider** (`#dayMapSeg`/`renderMapForRange`) pins whichever range: Day=today,
  Week=Mon–Sun, Month=calendar month, Year=Jan 1→today; defaults to Day on open.

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
  **View As + device lock (fix):** while impersonating, the checked username is
  the IMPERSONATED user (owner-exemption doesn't apply), so View As set
  `sessionStorage.mostlaneMasterLogin` to bypass the lock. iOS wipes sessionStorage
  on PWA kill but keeps localStorage, so a resumed PWA restored the impersonated
  session yet lost the bypass → device-registration prompt → kicked to login.
  Fix: `device-auth.js isMasterSession()` ALSO bypasses when the durable
  localStorage `mostlaneViewAsReal` stash (set only by owner impersonation, the
  return-bar's signal) is present. To stop a stale stash granting a later user the
  bypass, it's cleared on logout (both portal-config logout buttons) AND on every
  fresh login.html login.

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
  /users/reorder (StaffType/SortOrder), /hs-plan-config, /po-config. **GET /users
  is ACTIVE-ONLY by default** — `isActiveStatus` keeps blank/"Active", drops
  "Disabled" (and any other status), so a disabled account disappears from every
  picker/list portal-wide; **Users Admin passes `?all=1`** to still see + re-enable
  them. (Login already blocks Disabled in auth.js.)
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
  from GET /sla/categories. job-view/sla-main/sla-scheduler use `sla-jobedit.js?v=12`.
  **SLA board editor consolidation (Aug 2026):** the old inline "👤 Send" modal on
  sla-main.html was REMOVED — it duplicated the shared full editor. Each job row now
  has ONE edit entry, **✏️ Edit → `window.MLJobEdit` (sla-jobedit.js)**, which does
  engineers + schedule + visibility + status/priority/site in one save. (The orphaned
  inline `updateBackdrop` modal is left in the HTML but never opened.)
  **Multi-engineer = ONE job, status per engineer ("only status per engineer", Aug 2026):**
  a job worked by 2+ engineers stays a SINGLE job (no clutter) but each engineer runs
  their own day. Everything is SHARED (RA, photos, signature, notes) EXCEPT status:
  `job.engStatus[normId] = {status,at,by}` holds each engineer's own status; the
  top-level `job.status` is a **rollup** (`rollupStatus`: Complete only when everyone's
  done, else the most-active). Helpers in sla.js: `isMultiEng`, `effStatus(job,eng)`
  (their slice else shared status — covers single-eng + legacy), `rollupStatus`,
  `seedEngStatus` (on roster change: existing engineer keeps the shared status, a
  newcomer starts "Scheduled"). PATCH routing: a NON-admin engineer on a multi-eng job
  gets `body.__engActor=normId` and patchJob writes their slice + re-rolls `job.status`;
  the gate/cross-job/On-Hold checks judge THEIR `effStatus` (a co-worker mid-job never
  blocks them). Completion gates stay shared, so once one engineer supplies the RA/
  signature/After-photo the next passes instantly. An OFFICE status change on a multi-eng
  job sets every engineer's slice in step. Responses carry **`myStatus`** = the viewer's
  own slice: GET /sla/jobs/{id} + the PATCH reply add it; **GET /sla/jobs/for-engineer
  OVERWRITES `status` with the engineer's own** so route/engineer-jobs/inbox/my-day need
  no change. engineer-job.html adopts `job.myStatus` on load + after a patch. job-view.html
  (office) lists each engineer's status ("John — In Progress · Dave — Complete").
  Single-engineer jobs + the Zapier intake are UNCHANGED (never multi-eng → normal path).
  **NB the earlier "one independent job per engineer" split was REVERTED** (it cluttered
  the board/site history); `splitJobByEngineers` is left dormant/unused in sla.js.
  Editor is `sla-jobedit.js?v=13`.
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
  **Site match keys (fix):** the site-folder lookups (/site/jobs, /site/photos,
  /site/docs, siteMatches) must NOT use the lossy `digitsOf` on the `?site=` code —
  that stripped a PROJECT number "P0002" to "2" and pulled Co-op store-2 history
  onto a project. Use **`storeCodeOf(s)`** = pure-numeric only (`/^\d+$/` →
  Number(); else "") for archive + cross-job matching (projects/house-name sites →
  no store history), and **`siteKeyOf(s)`** = numeric normalised else sanitised
  full code, for the R2 `sitedocs/<key>/…` storage prefix (projects get their own
  namespace; numeric stores unchanged, back-compat). Live jobs' siteCode is always
  a bare number, so `/^\d+$/` never regresses a real store.
  Front-end: **sla-jobedit.js** (`?v=2`, shared by sla-main / sla-scheduler /
  job-view) is the ONE-HIT editor — every Edit button opens it and it edits
  everything in one save: ref, description, priority, status, raised,
  **schedule (date · start · finish, Clear = unschedule) + assigned engineers
  (multi-tick)**, full site, note — one PATCH /sla/jobs/{id}. Exposes
  **Release / visibility scheduling (`job.release`)**: a "👁 When the engineer
  sees this job" control in the editor sets `job.release = {mode, at?}` —
  `now` (default, visible immediately), `at` (custom date/time, client sends an
  absolute ISO), `dayBefore` (17:00 **Europe/London** the evening before the
  scheduled day, computed live server-side so it tracks reschedules), or
  `afterPrev` (the **stacked queue**: hidden until every EARLIER same-day job for
  that engineer is finished — set it on each queued job to drip them out one by
  one). Enforced server-side in sla.js: **GET /sla/jobs/for-engineer filters out
  jobs that aren't released yet** (`releaseVisibleNow`), so engineers simply don't
  see them. **The assignment push fires WHEN the job becomes visible, not at
  assignment** — `releaseNotified` flips true on first announcement:
  `reconcileRelease` pushes all assigned engineers when a gated job is visible;
  the **hourly cron** (`sla.sweepJobReleases`) announces timed jobs whose release
  has passed; and completing a job **announces the engineer's next `afterPrev`
  job** (its assignment push fires as it unlocks). `notifyNewlyAssigned` now only
  handles adding an engineer to an ALREADY-announced job. The office board
  (sla-main) shows a 🕒/⛓ badge on gated jobs (from `decorate.releaseView`);
  engineers never receive them. Editor is `sla-jobedit.js?v=12`.
  `MLJobEdit.wheelify(root)`: mouse-wheel stepping on date/time/number inputs
  (15 min per notch, Shift = 1 h, dates 1 day) — also wired to the scheduler's
  quick modal. Finish ≤ start rolls to next day (evening access windows).
  **job-view.html status control (engineer, mobile-first)**: the status dropdown
  is a grid of colour-coded **tap-to-change chips** that **auto-save on tap**
  (`pickStatus`/`buildStatusChips`; a hidden `#statusSelect` mirrors the value so
  the save/validation code is untouched). Statuses that need something first are
  `needsConfirm` (no silent save — show a labelled confirm button instead):
  Quote / On Hold (details pack), In Progress (risk assessment), and **Complete**
  (requires a completion **After** photo — the RA's "Before" work-area shot no
  longer counts — a completion note ≥ `MIN_COMPLETE_NOTE` chars, and the
  customer's signature, for EVERY engineer not just Story Mode). Enforced client-
  side (engineer-job.html `outcomeMissing`, checks `photos.some(stage==="After")`)
  AND server-side (sla.js `completionMissing` via `jobPhotoCount(env,id,"After")`,
  non-admins only — admins can still override). **Per-job RA + signature gates
  (Aug 2026):** each job carries `requiresRA` + `requiresSignature` +
  `requiresPhoto` + `requiresNote` — default OFF for PROJECTS (P-numbered site /
  projects client), ON otherwise; an explicit value wins, preserved across
  re-saves; settable on **add-job.html** ("On-site requirements" — four tick boxes
  that auto-default off when a Project site is picked). A project job can be
  completed with NOTHING; everything else needs RA + note + photo + signature.
  **Projects also have NO priority level and NO SLA at all, for every user:** the
  worker stores `priority:""` + `targetAt:null` for project jobs (create + patch),
  and the office views hide the fields for old jobs too — job-view.html
  (`#colPriority` hidden, SLA badge hidden, label→"Status"), sla-main.html
  (`isProjectJob` → blank priority cell + empty `slaBadge`) and sla-jobedit.js
  (`#mljePriorityWrap` hidden). A blank priority never trips the P1 "Urgent" flag.
  **A job's reference is NEVER the internal UUID.** When no reference is typed,
  createOrUpdateJobFromPayload + patchJob default `helpdeskRef` to a CLEAR name:
  a **project** job → its project number (site code, e.g. "P0002"); **every other
  job → the SITE NAME** (else site code). Both heal an old UUID-defaulted ref the
  same way; an explicitly typed reference always wins. (Existing UUID-ref jobs
  were one-off backfilled to the site name / P-number.) **Project jobs also use a SLIM status set** —
  Scheduled · Travelling · In Progress · Complete — everywhere (engineer-job grid,
  job-view chips, sla-jobedit + sla-main dropdowns; On Hold/Quote/Order/custom
  categories are dropped for projects, the job's current status always included).
  When `requiresRA` is false the engineer page treats the RA as done
  (no lock — `raRequired()` → `raDone=true`); the completion **note**,
  **photo** (After) and **signature** checks are each skipped when the matching
  flag is false — both client (engineer-job.html
  `noteRequired()`/`photoRequired()`/`sigRequired()` in `outcomeMissing`) AND
  server (sla.js `noteRequiredFor`/`photoRequiredFor`/`signatureRequiredFor` in
  `completionMissing`/`quoteMissing`). `jobIsProject` = `/^p\d/` siteCode or
  projects storeType/client. patchJob accepts all four flags so the office can flip
  them later. The field app
  **defaults the photo
  stage to "After" once the RA is done** (In Progress/During is rarely used), so the
  completion photo lands in the right tab. **Admins can recategorise a photo's
  stage** (Before/During/After) from the photo lightbox — stored as a
  `job.photoStages` override (no R2 rewrite); GET /files applies it, POST
  `/sla/jobs/{id}/photo-stage` sets it (SLA-admin only). **RA override:**
  a discreet `#raSkipBtn` ("skip") in the RA panel shown **only to FullAccess**
  (`isFullAccess()`, not SLAAdmin) starts the job without the assessment —
  records `riskAssessment.skipped` with their name; the job view shows "⚠️ Skipped
  (Full-Access override)". Also: a small "👤 You" button lives in the sla-main.html
  header (you.html has no dedicated tile/sidebar item). Cross-job guard:
  moving a job to **Travelling / In Progress / Complete** is blocked while ANOTHER
  of the engineer's jobs is unfinished (`jobBlockReason`: still In Progress/
  Travelling, or On Hold/Quote without its pack) — it alerts naming that job and
  redirects straight into it to finish first.
  **"✏️ Edit details" (the office job editor on job-view) is office-admin only**:
  gated `isOfficeAdmin() && !isFieldUser()` — a FIELD engineer never gets it even
  if they hold an SLAAdmin grant (it's an office control). isFieldUser reads
  mostlaneStaffType / perms.StaffType.
  **Signature capture is LOCAL-FIRST (never lost on no signal / navigation):**
  saveSignature writes the drawn PNG to localStorage `mlSig:<jobId>` (pending)
  BEFORE the upload, sets job.signature so the Complete gate is satisfied at once,
  then uploads in the background (`flushSignature`, retries on failure + on the
  `online` event, deduped server-side by opId). On load, if the server job has no
  signature but the device does, it's restored + re-flushed — so a signature taken
  offline survives the "finish previous job" bounce and a reload. Server clears
  the local copy once it has it.
  **NB there are TWO job pages:** `job-view.html` = the OFFICE/admin view (opened
  from sla-main / scheduler / site-folder / activity-log); **`engineer-job.html`
  = the FIELD ENGINEER page** (opened from route.html / engineer-jobs.html /
  inbox.html — the field app). The three behaviours above (office-only "✏️ Edit
  details (office)" gate `isOfficeAdmin() && !isFieldUser()`; the Full-Access RA
  skip `#raSkipBtn` in the RA modal, shown via `isFullAccess()` only; and
  local-first signatures `mlSig:<jobId>` with background `flushSig` retry) exist
  in **BOTH** pages — fix engineer-job.html too, it's the one engineers actually
  use. engineer-job.html's RA is a modal opened by the amber "Open risk
  assessment →" lock banner; the skip is a discreet dashed button at its foot.
  `sites.js` (get/add/update-site, customers, street-images, auto geofence
  push to SiteLog), `sitelog.js` (HMAC launch + admin proxy), `office.js`
  (clock segments; edits keep originals struck-through; /office/my,
  /office/timesheet), `email.js` lib (Resend templates).
- **Per-job PO materials cost** (job-view.html "🧾 Materials — purchase orders"
  card, **office/admin only** — FullAccess|SLAAdmin): reads live from the PO
  system via **GET /costing/job-pos?jobId=** (costing.js `jobPoRows`), which sums
  `po_log.cost_ex_vat` for rows with matching **`job_id`** (the stable key the PO
  worker stamps from a job's "Raise PO" link — `#mlpo` payload). Returns total +
  materials/subcontractor split (`cost_category`, `trade`) + unpriced count + the
  PO list; updates automatically as each PO is priced (nothing stored on the job).
  Net figure = `cost_ex_vat` (VAT reclaimable); `cost_ex_vat IS NULL` = raised
  but not yet priced (counted as unpriced, NOT zero); `cost_category` NULL →
  materials. **SCHEMA NOTE:** the PO worker adds `job_id`/`job_ref` to `po_log`,
  but as of this write those columns are **not yet live** on the `mostlane-po` D1
  — SQLite fails a whole SELECT on an unknown column, so `jobPoRows` (which filters
  on `job_id`) degrades to `[]` until the column exists, then lights up on its own;
  and `poRows` (the site rollup) must NEVER reference job_id/job_ref (it doesn't
  need them) or it would silently zero ALL PO spend. Match on `job_id` only, never
  `job_ref` (display-only, reusable).
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
- `compliance.js` — **Multi-scheme compliance charts** (Southern Co-op + Fareham
  Borough Council), scheme-aware. Every /compliance/* route takes `?scheme=`
  (default `coop`; `fareham` = fareham.html). `compliance_stores`/`compliance_files`
  gained a **`scheme`** column (stores PK widened to (tenant_id,scheme,code) via a
  one-off D1 migration; existing rows = coop) and stores gained a **`meta`** JSON
  ({lat,lng,w3w,access,contact}). Per-scheme type defaults in `SCHEME_DEFAULTS`
  (coop: fiveYear/pat/em/pv/ev/pump years; fareham: fiveYear 5y, **emMonthly 1
  MONTH**, emYearly/pat/pv 1y) — frequency is years OR months (`bumpDue` uses
  addMonths for emMonthly). Settings key `compliance_settings:<scheme>` (coop kept
  its un-suffixed key). New routes: **POST /compliance/store-meta** (📍 pin lat/lng
  + w3w, 🔑 access + contact), **GET /compliance/next-code** (auto-number a scheme's
  next site). `canonType` is idempotent for known keys (keeps camelCase emMonthly/
  emYearly/asbestos) and maps forecourt→ev. **fareham.html** = a tailored copy of
  eicr-portal.html (scheme=fareham via authFetch): types 5 Year/EM Monthly/EM
  Yearly/PAT/PV, NO archive, 📍 (Leaflet map pin + what3words) + 🔑 (access +
  contact) columns, the docs modal groups **EM Monthly by month** (🗓 headers) and
  always shows an **Asbestos Register** section; sites are added fresh (no
  mostlane-pos migration, no sites-table join — name/type/meta live on the
  compliance row). Fareham button on compliance.html now links to it.
- `compliance.js` (coop specifics) — **Southern Co-op compliance certificates in R2+D1** (the
  SharePoint "TSC Compliance" tree migrated into the portal). Table
  **compliance_files** (self-migrating; keyed by store `code` 4-digit +
  canonical `type` — `canonType()` maps labels→`fiveYear|pat|em|pv|ev|forecourt|
  pump|other`; `source` = SharePoint item id, UNIQUE-indexed so re-runs never
  double-import). Files live in R2 JOB_FILES under
  `compliance/<code>/<type>/<year|_>/<ts>-<name>`. Routes (gate
  `Compliance|FullAccess` unless noted): **GET /compliance/index** (compact
  `{code:{type:1}}` map — drives the 📄 links), **GET /compliance/files?code=**
  (one store, grouped by type, signed URLs), **GET /compliance/file-url?code=&
  type=** (latest cert's signed URL), **GET /compliance/has?source=** (dedupe
  check for the extractor), **POST /compliance/file** (multipart ingest:
  file+code+type+year?+date?+source? — the Graph extractor + manual upload;
  dedupes by source), **POST /compliance/file-delete** {id}, **GET
  /compliance/summary**. **GET /compliance/file** (PUBLIC_ROUTES, sig-verified,
  streams inline from R2). Front-end: **eicr-portal.html** fetches
  /compliance/index once on load (non-blocking) and shows a 📄 link on each date
  cell that has a cert → opens /compliance/file-url in a new tab (via a local
  `authFetch()` with the Bearer token; visible to all viewers, edit still gated).
  **Phase B extractor — BUILT (`tools/compliance-extractor/extract.mjs`,
  dependency-free Node 18+):** walks the TSC Compliance tree via Microsoft Graph
  (driveId `b!NpDXAs0EE0OL71TDQZYd-bdykHFlnd9FjsgSt11fwgt0jcCyS10IR5OEI-3NYzYC`,
  ROOT_PATH "Mostlane Construction/TSC Compliance") and streams each cert to POST
  /compliance/file. **Careful about the real folder variance** (confirmed live):
  mostly `group/<code> name/TYPE/files`, but also **type-first** top-level folders
  (PFS/EV Maintenance/PV Maintenance → store subfolders often with **NO code**),
  filenames that carry their own `code~TYPE~DD-MM-YY` (and whose code can DISAGREE
  with the folder), and a special "Lakeside Head Office". So it classifies by
  MEANING across the whole path + filename (type = deepest known-type folder else
  from the filename; code = first coded folder else filename), **quarantines
  anything with no confident code** to `out/unmatched.csv` instead of guessing,
  and flags folder-vs-filename code clashes to `out/mismatches.csv`. Runs
  **dry-run by default** (classify + CSV reports, download nothing) → review →
  `--commit`. Idempotent (server de-dupes on the SharePoint item id via `source`;
  script pre-checks /compliance/has). Auths to the portal with a machine-to-machine
  **COMPLIANCE_IMPORT_TOKEN** (worker secret; POST /compliance/file + GET
  /compliance/has are PUBLIC_ROUTES that verify it in-handler, timing-safe, same
  shape as /sla/inbound — a logged-in admin session still works too). `--selftest`
  asserts the classifier offline (no creds). Needs an Azure app registration
  (Graph application perm Sites.Read.All, admin-consented) — the M365 connector
  can't bulk-transfer (1MB/file cap + rate limits). See the tool's README.md.
  **Unified chart + drag-drop + versioning (ONE site home):** the compliance
  chart is now portal-native. Store list, category and per-type due dates live in
  D1 **compliance_stores** (PK tenant+code, `code` = **sites.site_number** — the
  one canonical site home, no duplicate list; name/postcode are fallbacks, the
  live values resolve from `sites`). Routes: **GET /compliance/stores** (the whole
  chart — each row joins `sites` for name/postcode, merges category + due dates +
  which types already have a doc), **POST /compliance/stores/import** (one-time
  migration: eicr-portal reads the old mostlane-pos list BROWSER-SIDE and posts it
  here; upserts the overlay and with `createSites:true` creates any missing `sites`
  row so chart+Sites share one home; returns imported/matched/sitesCreated), **POST
  /compliance/store** (edit category/due — replaces the mostlane-pos KV write),
  **POST /compliance/store-delete** (removes the chart row, keeps documents).
  **eicr-portal.html** loads from /compliance/stores (mostlane-pos kept only behind
  the admin "⤵ Import from old system" button), edits due dates via
  /compliance/store, and supports **drag-and-drop upload**: drop a file on a store
  row (or the 📎 button) → modal picks the compliance **type** (defaulting to the
  types that store tracks) + optional cert date → POST /compliance/file with
  **bump=1**, which **auto-advances that type's next-due date** (5y for EICR/5-Year,
  1y otherwise; the historical backfill omits bump so it can't stomp live dates).
  **Versioning:** every upload is kept — GET /compliance/files flags the newest per
  type `current`, older ones previous (never deleted); the 🗂 button opens a
  per-store documents modal. **Doc management (Aug 2026):** compliance_files gained
  `label` (admin display name) + `pinned` (self-migrating ALTERs). The Documents
  modal now lets admins **rename** (POST /compliance/file-update {id,label}),
  **delete ANY file** (not just previous — /compliance/file-delete), and **link
  multiple current docs of one type** by ticking "keep" (pinned) — if any file of a
  type is pinned, ALL pinned ones are `current` together (e.g. a 5-Year report split
  across two PDFs), else the newest is current. **Named custom docs:** upload with
  type **Other** + a name (label) files an extra document that isn't a due-dated
  type (no `bump`). **Documents modal layout (Aug 2026):** grouped under a **header
  bar per compliance type** (HEAD map: 5 Year / Emergency Lighting / PAT Testing /
  PV / EV / Pump / Other) showing only the **applicable** headings for that site
  (types it tracks-via-due-date OR has docs for, + Other always). A doc's label may
  carry a **sub-folder path** ("Manuals / Boiler" from a folder upload) → the folder
  becomes a small **📁 sub-header** and only the leaf shows as the doc name; rename
  keeps the prefix. **Drag to re-file:** each doc row (and each 📁 sub-header, which
  moves its whole group) is `draggable`; dropping on another type's header POSTs
  /compliance/file-update {id,type} (canonicalised) to recategorise it — Other docs
  get filed under a real type this way. current/previous badges + "keep" pin show
  for standard types only, not Other. HTML5 DnD (desktop). **Compact rows:** date cells are `td.dc{white-space:nowrap}` so the
  📄 cert icon sits BESIDE the date (no wrap → rows with a doc are the same height);
  cells are `vertical-align:middle`; long site names are `td.site{white-space:nowrap}`.
  **In-app cert viewer:** clicking a 📄 date-cell icon OR a document link in the modal
  opens the file in **docviewer.js** (`MLDocViewer`, robust PDF.js/image viewer) rather
  than a new tab; a self-contained `CertViewer` gallery layer in eicr-portal.html adds
  fixed ◀ ▶ arrows + ←/→ keyboard nav to flick through ALL of a store's certificates
  (built from /compliance/files, standard types in chart order, current-first),
  wrap-around, arrows hidden for a single doc. **NB an old edit-save quirk baked "📄"
  into 2 stores' due dates (0023/0052, cleaned in D1); fmtDue strips stray 📄, editing
  removes the cert link from the cell, saveEditInstant sanitises to date chars, and
  /store strips 📄 — so it can't recur.** **In-job:**
  **site-folder.html**'s **Compliance** tab reads **GET /compliance/site-files?site=**
  (NOT the per-scheme /files) so it shows a site's certs across **EVERY scheme**
  (Southern Co-op, Fareham …), grouped by type, current/previous, with a full-access
  upload bar per section that posts to the right `?scheme=`+code. mostlane-pos is
  retired (migration is one-tap); chart, Sites, job costing and site documents all
  reference the one site by `site_number`.
  **Compliance store → portal site link (Aug 2026):** `compliance_stores` gained a
  **`site_number`** column = the canonical PORTAL site a store belongs to, so its
  docs surface in that site's Site Documents. **Co-op stores ARE their portal site**
  (`site_number = code`, backfilled). **Other schemes (Fareham) link to an EXISTING
  portal site by NAME** — a separate workflow owns creating those sites, so the
  worker never invents a duplicate: `/stores/import` + the create-if-missing paths
  set `site_number` (coop=code, else name-match/null); **/stores GET self-heals**
  (one correlated UPDATE relinks any still-null non-coop store whose name now
  matches a site); and **/site-files also matches by the site's NAME** so docs show
  the moment the site exists. `listStoreFiles()` is the shared file-lister for /files
  + /site-files. **Fareham sites live under client `fbc`, numbered 3001–3024** (3001
  Civic Offices / 3002 Civic Way Shoppers Car Park pre-existed from the concurrent
  project; 3003–3024 created 12 Aug to give all 24 buildings a portal home — spare
  `9998` Hook Recreation Ground is the other project's, untouched). NB the Fareham
  chart page (fareham.html) still keys on (scheme=fareham, code=0001–0024) — the
  `site_number` link is only the bridge to Site Documents.
  **Compliance-check WORKLIST (compliance-review.html + `compliance_review` table,
  Aug 2026):** batch-runs the EICR verifier against every stored **5-year (EICR)**
  cert and builds a tick-off worklist. The verification runs IN THE BROWSER using the
  **shared engine `eicr-engine.js` (`window.MLEICR` — readPdf/analyze/summarize)** that
  eicr-check.html was refactored onto (ONE source of truth, no drift). Flow: **GET
  /compliance/review/targets** (newest cert per site + signed URL + the site's newest
  ANY-type doc time + stored review row; `needs`=true when never run OR a document was
  added to the site since last run — the "skip unchanged sites" rule, user chose
  re-check on ANY new doc so more check-types can be added later); client fetches each
  cert (the /compliance/file GET is CORS-enabled), runs MLEICR, **POST
  /compliance/review/save** {code,type,outcome,summary,flags,fileId,docAt} (a fresh run
  resets tick-off to open). Worklist: **GET /compliance/review/list** (rows + fresh
  signed cert URLs), **POST /compliance/review/status** {status done|open, notes}. Row
  = site → outcome badge + headline + issues + 💡recommendations + a done checkbox +
  autosaving notes + Open-certificate. `attention` (red) = genuine issues only
  (unsatisfactory / mis-coded / missing sigs / >10% LIM / circuit flags / unreadable);
  routine C3 recommendations are listed but don't make a compliant report red. Runs in
  a 2-lane pool, resumable (skip logic re-computes each run). Extensible: a check
  registry (`CHECK_TYPES=["fiveYear"]` in the worker) — PAT/EM/PV/EV etc. plug in as
  their own verifiers later. Button: "🔍 Run compliance checks" in eicr-portal.html.
  **site-folder.html Previous Jobs** (the Documents → Previous Jobs tab) lists LIVE
  jobs + the imported ARCHIVE (historical) jobs for the store (GET /sla/site/jobs
  returns both, each tagged `source:live|archive`; archive carries its full imported
  record). Every job opens in a **read-only modal** (archive badged 🗄; live keeps an
  "Open full job (edit)" link for FullAccess only). **Financial info is FullAccess-only:**
  the server strips money fields from each archived record for anyone without FullAccess
  (`stripFinancial` via `isFullAccess` in /sla/site/jobs — by key cost/price/invoice/…
  or any £/$ value), so a field engineer only ever sees description/notes/status/etc.,
  never costs/invoices.
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
  sig-verified, streams inline). **Each allocation can carry an optional `qty`**
  (integer — number of tyres, puncture repairs… on that line; a small "Qty" box
  on each category row, editable retrospectively on old invoices). Insights'
  per-category **count sums qty** (fallback 1 per line for legacy allocs with no
  qty), so "how many tyres" / the "How many" compare metric is a real total; the
  maintenance list badge shows "Tyres ×4". The page shows a spend-per-category bar chart +
  tap-to-filter chips + a chronological timeline (date · description · coloured
  category badges w/ per-cat cost · total · open-document · edit). vehicle-delete
  purges the maintenance rows + their R2 docs. **Documents open in the in-app
  viewer** (docviewer.js `MLDocViewer.open`, `?v=5` — robust for every PDF type +
  images, scrolls/zooms on mobile) rather than a new browser tab: the 📄 record
  button and the edit modal's "Open" both call `openDoc(url,name)`; the signed
  /fleet/maintenance-doc URL is CORS-enabled so PDF.js fetches it directly.
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
- **Vehicle-tagged purchase orders (Aug 2026)** — a PO raised for a van (AdBlue,
  parts…) can be tagged to it in the PO system, which stamps the van's
  registration onto **`po_log.vehicle_reg`** (the PO worker offers the portal's
  vehicles as pickable "sites", read from its `PORTAL_DB` binding's `vehicles`
  table). Portal side (fleet.js): helper **`vehiclePoRows(env,{reg,from,to})`**
  reads PO_DB `po_log WHERE vehicle_reg=?` (reg normalised both sides:
  `UPPER(REPLACE(vehicle_reg,' ',''))`), **fails soft to `[]`** when PO_DB is
  unbound OR the `vehicle_reg` column doesn't exist yet (SQLite throws the whole
  SELECT on an unknown column — try/catch keeps fleet views working, POs light up
  on their own once the PO worker adds the column). **GET /fleet/vehicle-pos?reg=&
  from=&to=** (any Vehicles user sees the list; £ figures stripped unless
  `canMoney`) powers a **🧾 Purchase orders** block in the vehicles.html deep-dive
  (loaded async after the modal opens; hidden when none). **/fleet/insights**
  folds PO spend in as a third bucket per van (`v.po` + `fleet.po`, added to
  `total`) — a distinct indigo segment on the "Spend per van" bars, a summary
  tile, a "Where the money goes" row + a breakdown-table column (all only when
  any PO spend exists). Only PRICED POs count (`cost_ex_vat`); match on
  `vehicle_reg` only (never a display field). The PO-worker side is delivered as
  a paste-in prompt (Jamie's PO environment builds it).
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
  - **Statement import + direct reg tagging (Aug 2026)**: `fuel_entries` gained
    **`reg`** (a fill-up tagged straight to a vehicle, bypassing the
    card→user→assignment chain) + **`ref`** (the statement's unique transaction
    id, for dedupe). `fuelByVehicle` + the insights fuel loop **prefer `reg`**
    when present, else fall back to card→user→assignment. **POST /fleet/fuel/import**
    (Full Access) bulk-loads `{entries:[{reg,date,litres,cost,ref?,card?}]}`,
    upserting by `ref` so re-importing a file never double-counts. Used to load a
    Shell fuel-card CSV: 240 rows across the 11 vans, **net (ex-VAT)** cost basis,
    Feb–Aug 2026 (Chloe/Megan personal cards + 4 non-fleet plates excluded). The
    Shell CSV's reg lives across Vehicle License Number / Fleet ID / Driver Name
    and ~⅓ of rows are blank — resolve every row via its **Card Full Number**
    (each card → one van, seen from its other rows). Imported rows carry no
    matching `profile.fuelCard`, so they show per-VAN (MPG/running-cost/insights)
    but not in the per-card entry list — by design. **Self-service importer
    (fuel-cards.html "⤵ Import statement", Full Access):** parses the fuel-card
    CSV entirely in-browser, matches each row to a van and POSTs to /fleet/fuel/import.
    Column detection is by header NAME (Shell layout, tolerant). Van resolution:
    per-row direct match on Vehicle License Number / Fleet ID / Driver Name
    (normalised vs the portal `vehicles` list) FIRST, else a **card→van majority
    fallback** (each Card Full Number's ≥50%-majority van — recovers typo'd/blank
    plates like N73KFO→HN73KFO without folding a lone coincidental hit). Rows that
    match nothing (unknown plates, personal cards like Chloe/Megan) are listed and
    SKIPPED. A Net/Gross toggle (default Net) + a per-van preview show before
    committing; dedupe-by-ref means re-importing overlapping periods is safe.
  - **MPG** (`mpgByVehicle`): miles = the van's odometer span (max−min, needs
    ≥2 readings) merged from van checks **AND manual odometer readings**; litres
    = fuel bought **WITHIN that reading window** (`> first date, ≤ last date`, via
    `fuelRowsByVehicle`) ÷ UK gallon (4.54609) — a true like-for-like figure, not
    all-time. Shown as **Current MPG** on the vehicle cards + deep-dive (MPG isn't
    money, so any Vehicles user sees it); `/fleet/vehicles` returns `currentMpg`.
  - **Odometer readings (Aug 2026)** — ad-hoc mileage readings, separate from
    van checks, in table **odometer_readings** (self-migrating; tenant/reg/date/
    miles). Endpoints (Vehicles): **GET /fleet/odometer?reg=** (readings +
    `mpgForReg`: overall + a per-interval breakdown between each pair of
    readings), **POST /fleet/odometer** (upsert, deduped by reg+date), **POST
    /fleet/odometer/import** (`{reg,readings:[{date,miles}]}` bulk), **POST
    /fleet/odometer-delete**. `latestMileage` + `odoByVehicle` merge these with
    van-check mileages (newest reading from either source = the van's current
    mileage; card label is now "as of <date>", not "van check"). Front-end:
    **📏 Mileage** button in the vehicles.html deep-dive → modal (MPG headline +
    readings list w/ gap-miles + add/delete). NB per-interval MPG is noisy when
    readings don't align with fill dates — the **overall window MPG** is the
    reliable figure. **Span uses the CHRONOLOGICAL endpoints (first→last by
    date), not raw min/max**, so one wild mid-history value (e.g. a "123456" test
    mileage in a van check) can't blow up the distance.
    - **Source priority (`source` col, self-migrating)**: each odo row is
      `manual` (typed) or `fuel` (auto-pulled off a statement); van-check mileage
      is `vancheck` at merge time. Rank **manual(3) > vancheck(2) > fuel(1)** —
      on a same-date clash the higher rank wins (`ODO_RANK` in fleet.js, applied
      in odoByVehicle/odoSeries/latestMileage). **POST /fleet/odometer/import**
      takes `source` (default `fuel`) and **won't let a lower-ranked reading
      clobber a better one**. **The fuel-statement CSV importer
      (fuel-cards.html) also pulls the Odometer Reading column**: per-van
      candidates are sanity-filtered client-side (positive, monotonic
      non-decreasing, ≤500 mi/day, and the whole van dropped if the series is
      degenerate — <2 points or <25 mi of movement, e.g. drivers typing "1") and
      POSTed as `source:fuel`. Van checks stay the trusted primary; fuel odos are
      a secondary gap-filler.
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
  candidates harvest. **Front-end (Aug 2026): folded into sites.html** — the
  standalone sites-register.html is now a redirect to sites.html; its two unique
  tools (Candidates + Merge/aliases) live behind the **"🧹 Tidy & merge"** button
  in the Sites toolbar (gated FullAccess|SLAAdmin|TimesheetAdmin, same as the
  register endpoints). Candidate **Add** opens the normal Sites edit modal
  prefilled with the name (so you set category/number/pin properly), **Merge**
  opens a canonical-site picker (POST /sites/register/merge), **Ignore** →
  /sites/register/ignore; aliases list has **Un-merge**. Sites is now the ONE
  site hub (directory + add + cleanup). sites.html reaches the register endpoints
  via a local apiFetch() (MOSTLANE_API + Bearer). **Coordinates→SiteLog:**
  /sites/register/add+update accept {lat,lng}, store in the site's data JSON, and
  push a geofence to SiteLog (`/bulk-add-sites`, radius 500); the page has lat/lng
  fields + "📍 From postcode" (postcodes.io) + per-row "Set location". **Pin-drop
  map (Aug 2026):** sites-register.html loads Leaflet (CARTO Voyager tiles) and a
  shared `openPinMap()` modal — a "🗺️ Drop pin" button on the Add card + the per-row
  "Set location" button both open a tap/drag map (postcode jump box) to place the
  exact geofence point; on save it fills addLat/addLng (Add) or POSTs
  /sites/register/update (existing). Adding a site with NO coords now warns
  ("SiteLog won't recognise it for sign-ins") before proceeding, so a site rarely
  reaches the register without a geofence. Only lat/lng present → geofence pushed.
  **Unified add (Aug 2026):** the register's "Add a site" now uses the SAME
  canonical **`/add-site`** endpoint (sites.js) as the Sites page modal, not the
  lightweight /sites/register/add — so it gets a **Category** dropdown (retail/els/
  els_private/cobra/wenzels/fbc/projects) + a **Site/store number** field, project
  auto-numbering, customer creation and the SiteLog push, identically from either
  page. **Projects** are auto-numbered server-side: `/add-site` with client=projects
  and no siteNumber assigns `nextProjectNumber()` ("P0001") and uses it as BOTH
  job_number AND site_number (the number box is hidden for Projects on the register
  add). Non-projects still require a typed site number. /sites/register/add is kept
  only for the candidate quick-add (harvested names, client "general").
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
(round-trip miles per site), **compliance_files** (Southern Co-op compliance
certs migrated off SharePoint; keyed by store code + canonical type, files in R2
JOB_FILES `compliance/<code>/<type>/<year>/…`), **compliance_stores** (the
compliance overlay on a site — category + per-type due dates, keyed by
code=sites.site_number). app_config also
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

## Messaging (office ↔ engineer, routes/messages.js)
1:1 direct messages **+ an "Office" group chat**. Tables **messages**
(id/from/to/body/at/seen/**thread_key**) + **message_typing** (upserted "X typing
to Y" markers) + **group_reads** (per-user read position in a group thread) —
self-migrating (`thread_key` added by ALTER; group_reads CREATE IF NOT EXISTS).
Endpoints: GET /messages/unread, /messages/threads, /messages/thread?with=&since=
(returns messages + **typing** [other typed <6s] + **readUpTo** [highest id of MY
msgs they've read]), POST /messages/send {to,body,opId} (fires web push to the
recipient), /messages/read {with}, /messages/typing {to}. **Admin moderation
(FullAccess only): POST /messages/delete {id}** (remove one message) +
**POST /messages/thread-delete {with}** (wipe a whole conversation) — surfaced
in the office widget as a 🗑 on each message + a 🗑 in the thread header.
**Delete is a SOFT-delete** (messages.deleted/deleted_by/deleted_at columns,
self-migrating): hidden from every everyday view (all reads carry
`COALESCE(deleted,0)=0`) but the row is KEPT so the owner-only Chat History can
still show it. **Chat History (OWNER ONLY, env.OWNER_USERNAME "Jamie Line"):
GET /messages/history?user=<u>** returns that person's every conversation
(1:1 + group threads keyed to them) grouped, INCLUDING deleted messages tagged
who/when removed. Page **chat-history.html** (owner-gated client + server; linked
from users-admin.html "🕵️ Chat history", shown only to the owner) — pick a
person → collapsible per-conversation cards, deleted lines struck-through in red
with "deleted by X"; message-body text search.
- **Group chat ("Office")** — config in app_config `chat_groups` (defaults to one
  group `{id:"office", name:"Office", members:["Joanna","Tanya","Megan","Chloe"]}`;
  `loadGroups` resolves member names → canonical usernames via the users table by
  username / first_name / "first last", 2-min cache). Model = **per-engineer
  thread**: each engineer has their OWN Office conversation; all group members see
  it and any can reply. Storage reuses `messages` with `to_user="@office"` +
  **thread_key = the engineer's username** (the reply from a member carries the
  same key). Per-user unread via `group_reads` (last_id read, ON CONFLICT MAX).
  Endpoints: **GET /messages/groups** (groups the caller can see), **GET
  /messages/thread?group=<id>&key=<engineer>** (visibility: a group member sees
  every thread, an engineer sees only key===me; returns isGroup/group/key/name/
  members + messages tagged `from`), **POST /messages/send {group,key,body}**
  (member ⇒ key required; engineer ⇒ key forced to self; pushes every member +
  the engineer, minus the sender). /unread and /threads fold group unread/threads
  in. **Read receipts are NOT shown in group threads** (member label shown instead).
- **Engineers** — the field app's **inbox.html** "Messages" tab (bottom nav).
  Compose is **"✉️ New message"** → a picker (`openPicker`): **"Office" pinned at
  the top (👥)** then a searchable list of all users; sending to Office is the
  per-engineer group thread above. Thread modal **live-polls** (3s) for new lines
  + shows "…is typing"; group lines carry the sender's name. **No read receipts
  shown to engineers** (by design).
- **Office** — a floating **live-chat widget** (**chat-widget.js**), injected
  portal-wide by portal-config.js for office users (skips field/Story users and
  the field-app pages). Bottom-right launcher with an unread **red badge**;
  panel = conversation list (Office group threads shown with 👥) ↔ thread ↔
  **✎ new** (pick any user). Live via polling (open thread every 3s, badge/list
  every 15s); typing indicator + ping.
  **Read receipts ("✓✓ Read" / "✓ Sent") are shown to ADMINS (FullAccess) only**
  — `IS_ADMIN` gates their display; engineers/end users never see them (and
  group threads never show them). Web push still delivers an OS notification +
  the badge when the widget is shut.
"Live chat" = short polling (feels instant while open) + web push when closed;
no WebSockets/Durable Objects. chat-widget.js is `?v=2` + in the _headers no-cache
list. `since`-based delta polling keeps it cheap. Bubble layout is flex-column
(`.mlc-row` / `.mlc-line`) — matches inbox.html's proven mobile pattern (an
earlier inline-block bubble stacked one char per line on iOS Safari).

## Company memos (routes/memos.js + notification-centre.html + memo-sign.html)
Admin (FullAccess) writes a memo in the classic **To/From/Cc/Date/Re + body**
format (matches Jamie's example), **saves DRAFTS**, then **sends company-wide**.
Managed entirely from **notification-centre.html** ("📢 Company memos" card:
compose, drafts & sent list, per-memo "Who signed"). A sent memo:
- **pushes every active user** (web push, url→memo-sign.html);
- shows an **UNAVOIDABLE, non-dismissible, non-snoozable blocking overlay**
  (`memoGate` in portal-config.js, on every page except the sign page + auth
  pages — `GET /memos/pending`) linking to **memo-sign.html**;
- **memo-sign.html** renders the memo, requires an "I have read & understood"
  tick **plus a drawn signature**, then `POST /memos/ack` files a
  signed-acknowledgement **PDF into the signer's My Documents › "Memos"**
  (R2 `staffdocs/<tid>/user/<user>/Memos/`, via lib/pdf.js — text-only, the
  drawn signature PNG is stored alongside at `memos/<tid>/<id>/<user>.png` as the
  admin record). The **author is auto-acknowledged** on send (not gated, counts
  as signed, no PDF filed for them).
**Targeting + logo + cleanup (Aug 2026):** a memo sends to **everyone OR selected
people** (`memos.recipients` = JSON usernames, null=everyone, self-migrating;
notification-centre.html has a searchable checkbox picker). /send pushes only the
recipients; /pending shows a memo only to its recipients; /status + signed/total
are relative to recipients; /ack rejects a non-recipient. **Deleting a memo also
purges the filed acknowledgement PDFs + signature PNGs** (via memo_acks.doc_key/
sig_key) so a test memo cleans up from everyone's My Documents. /status returns a
signed `doc` URL per signer → "Who signed" links each name to their signed copy.
The **acknowledgement PDF now carries the Mostlane logo**: `lib/pdf.js` gained
JPEG image embedding (`doc.image(bytes,x,yTop,w,h)` → DCTDecode XObject; `bytes()`
rewritten to assemble binary chunks so image streams stay byte-exact; text-only
output unchanged; `jpegInfo` exported), and `lib/logo.js` holds the logo as a
baseline-JPEG base64 (2000×798). **The signer's DRAWN signature is embedded ON the
PDF** (JotSign-style) + an audit line with **date + IP address**: memo-sign.html
captures the white-bg signature canvas as a **JPEG** (`toDataURL("image/jpeg")`) so
the worker can embed it; /ack captures `CF-Connecting-IP` into a new `memo_acks.ip`
column (self-migrating) and passes `{sigJpeg, ip}` to buildMemoPdf. An old client
that still sends a PNG signature stores fine but isn't embedded (graceful — falls
back to the text line). **docviewer.js ext detection fix:** a filed doc named
"Memo — Test" (no extension) with the real name in the `?key=` param now detects as
a PDF (ext() checks name → url path → key param), so Open renders it in the modal
(which already has a ⬇ download in its top bar) instead of the "can't preview"
fallback. docviewer.js bumped to `?v=3`. My Documents (my-documents.html) already lets Full Access pick any
user + delete (server /staff/doc-delete is Full-only — no other role can delete
personal docs); a per-row ⬇ download was added.
Tables **memos** (draft/sent + the header fields + body + recipients) and **memo_acks**
(tenant/memo/user PK; signed_at, doc_key, sig_key) — self-migrating. Routes
(FullAccess unless noted): POST /memos/save (draft upsert), /memos/send,
/memos/delete, GET /memos/list (+signed/total), GET /memos/status?id= (who
signed / who hasn't); **any session**: GET /memos/pending, GET /memos/one?id=,
POST /memos/ack. "Memos" is a default staff-doc category (hrdocs). memo-sign.html
is in the _headers no-cache list.

## Activity log (audit trail)
Server middleware records every state-changing request automatically (covers
all current AND future pages); portal-config beacons page views. Middleware also
captures the **`ref`** column = the portal page the action was fired from (from
the Referer, lazily ALTER'd onto audit_log) and a richer `detail` (curated body
fields incl. reg/description/date/amount/cost/priority/category/site/litres/
mileage… — never message bodies/secrets, joined with " · "). Viewer
**activity-log.html** (FullAccess): person/period/actions-vs-views filters,
text search, **big FRIENDLY map (~130 endpoints — fleet/vancheck/office/costing/
messages/push/… ; add new endpoints there so nothing shows a raw "POST /…")**,
each action shows a plain-English label **+ "on <Page>"** (from `ref`) and a
humanised detail line (`niceDetail`/`DKEY`: `reg=`→"Vehicle", `cost=`→"£"…).
Failed actions flagged red. Linked from Users Admin + Device Management top bar —
deliberately NO menu tile. 12-month retention.

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

## EICR / BS 7671 check (eicr-check.html)
Self-contained compliance tool (⚡ EICR Check tile, MAP `EicrCheck:["Compliance"]`,
Compliance|FullAccess; sidebar NAV entry too). NO backend — the PDF is read
in-browser, nothing uploaded. **Primary tab "📄 Verify a PDF"**: drop/upload an
EICR PDF → PDF.js (same unpkg build docviewer.js uses) reconstructs each line by
Y/X position (group-by-Y tol 3, sort-by-X — the schedule table's real columns),
then reports in a **REVIEW-first** layout:
- **Header facts card**: Certificate/Ref number, overall SATISFACTORY/UNSATISFACTORY
  read from the STATED value — `readOutcome()` matches the standalone assessment-box
  line, NOT the footnote "An unsatisfactory assessment indicates … (Code C1)…" that's
  printed on every EICR (the old naive substring test made satisfactory reports read
  as unsatisfactory), falling back to a boilerplate-stripped scan only when ambiguous;
  shown green/red. A **⚠ "Outcome should be UNSATISFACTORY" review** fires when the
  report is marked SATISFACTORY yet has any C1/C2/FI (legend-stripped counts). Also
  **latest date on the report** (max dd/mm/yyyy), **all signatories**
  (name · role · date — regex `Name (Qualified Supervisor|Electrician|Inspector|
  Tester|…) dd/mm/yyyy`), C1/C2/C3/FI counts + **LIM %** (LIM ÷ all Pass/LIM/N-A/
  code outcome tokens; legend/code-key lines `PASS C1 or C2…` and bare `C1 C2 C3 FI`
  stripped so they don't inflate counts).
- **⚠ Review section (shown FIRST)**, each item labelled **DB x · CCT y** (e.g.
  "DB 4 · CCT 3L1") with a plain-English reason:
  - **Document logic**: any C1/C2/FI present but marked SATISFACTORY; **no
    signatures found**; **>10% LIM**; **phase-sequence referenced but the job looks
    single-phase** (no L2/L3/TP/400 V).
  - **Codebreaker-style suggested observations** (device-signal scan, C3 + reg
    tags + Copy): **no SPD** (`!/61643/` — BS EN 61643, NOT the "SPD" keyword which
    lives in the form template) → 443/534; **Type AC RCD/RCBO** (`6100[89]|62423 …
    AC`, counted) → recommend Type A re DC-blinding (531.3.3/GN3); **no AFDD**
    (`!/62606/`) → 421.1.7.
  - **Per-circuit checks** from the structured parser: **cable under-rated** (live
    mm² vs a generous clipped-direct capacity table vs the OCPD rating); **CPC not a
    recognised pairing** for the line size (twin-&-earth reduced-cpc table `TE_CPC`,
    checked only in the ≤10 mm² T&E domain — larger = singles/SWA, skipped to avoid
    false positives on legit 16/10 etc.); **2.5 mm² on >20 A but no ring end-to-end
    r1/rn/r2 readings**; **measured Zs > max permitted Zs** (uses the report's own
    stated Max Zs column).
- **✓ Verified results** in a **collapsible `<details>`** below (DB·CCT, cable
  live/cpc, device, Max Zs, measured Zs, tap "row" for raw text).
**Structured schedule parser** (`parseCircuit`) — **layout-aware, handles multiple
EICR programs**: glue `> 200`→`>200`, split to tokens, **anchor on the OCPD BS EN
index** (`60898|61009|60947|61008|3036|88`). Columns at/before the device are stable
across programs — live=iDev-3, cpc=iDev-2, type=iDev+1, rating=iDev+2. The columns
AFTER the device vary, so: **max Zs is COMPUTED** (`218.5/(k·In)`, layout-independent)
and the report's own max-Zs column is then LOCATED by matching that value (`oMax`),
which also identifies the **layout family** — `oMax=4` = a 4-col RCD block follows
(ring r1/rn/r2 at iDev+9..11, the "Tangier Co-op" software), `oMax=5` = RCD-mA
precedes max-Zs (ring at iDev+6..8, the "QuickPDF" software). **Measured Zs = the
first plain number ≤50 after the IR test-voltage token** (250/500/1000) — robust to
whether the IR readings come before or after the voltage. RCD presence = the OCPD is
an RCBO (`61008|61009|62423`). DB·CCT via `designation()` — anchors on the phase
token (L1/L2/L3/TP/SP/N) so it survives leading-column differences. **CPC check flags
only an UNDERSIZED cpc** (larger is safe). The 2.5 mm²>20 A ring-readings check runs
only when the layout was recognised (`oMax>=0`). **Validated against THREE real
reports from TWO programs — Tangier Co-op (SATISFACTORY, 3-phase, 68 circuits) and
two QuickPDF reports (both UNSATISFACTORY, 35 & 51 circuits): all rows parse, measured
Zs ≤ max on every row, signatories + latest date correct, LIM flagged at 11%/15%,
and ZERO false review flags on all three.** New/other software may still need a
family added — add its `oMax`/ring offsets.
Manual reference tabs still present:
**Max Zs** (Type B/C/D MCB/RCBO, computed `218.5/(k·In)` where k=5/10/20 = BS 7671
A2 Cmin-0.95 method; shows tabulated + the 0.8× cold rule-of-thumb, pass/review/
fail; fuses not preset — use Table 41.2/41.4), **RCD & times** (30 mA ≤300 ms@1×/
≤40 ms@5×; Zs≤50/I∆n; Table 41.1 disconnection times; typical Ze), **Insulation**
(Table 61 — 0.5/1.0 MΩ at 250/500/1000 V), **Ring circuit** (r1/rn/rn checks +
expected r2/r1 from CSA + R1+R2=(r1+r2)/4), **Coding** (C1/C2/C3/FI defs +
searchable BPG4 example list + the "unsatisfactory if any C1/C2/FI" rule).
Framed throughout as a checking AID, not a substitute for BS 7671 / a competent
person. Update the values if a new BS 7671 amendment lands.

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
SITELOG_ADMIN_SECRET, **VAPID_PRIVATE**, **JOBS_INBOUND_TOKEN**,
**COMPLIANCE_IMPORT_TOKEN** (m2m token for the SharePoint→R2 compliance
extractor; POST /compliance/file + GET /compliance/has verify it in-handler)
(secrets); EMAIL_FROM, R2_PUBLIC_BASE,
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
  = ["mon:<week>","chase:<week>"]), so BST/GMT-safe and retry-safe. **Cron Trigger
  is now `*/5 * * * *`** (every 5 min — wrangler.toml `[triggers]`) so **timed job
  releases + the 5pm-day-before nudge push punctually**; `scheduled()` runs
  `sla.sweepJobReleases` every tick but **gates the hourly work (van-check
  reminders, SiteLog reconcile) to `minute < 5`** so their cadence is unchanged.
  New scheduled jobs hang off the same handler.

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
     data. **EICR/compliance (Aug 2026 tidy):** compliance.html rebuilt in the
     portal look; **eicr-portal.html** ("Southern Co-op") tidied — portal header
     + `ml-back`, Segoe UI, decluttered/labelled filter rows (Due · Store type ·
     Compliance) with actions split into a utility bar, sticky Store-Code column,
     **removed the service-worker-killer** (it was unregistering the portal's SW
     → killed offline/push on that device) and **replaced the hard-coded "2025"
     edit PIN with permission-based editing** (`Compliance`|`FullAccess`; Edit
     hidden for everyone else). Data STILL lives on the old mostlane-pos KV worker
     (client-side fetch/update/delete) — moving it into portal D1 is the open
     next step. Stray eicr-portal-{final,fixed,updated}.html deleted.
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
