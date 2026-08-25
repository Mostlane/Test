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

## portal-config.js (every page includes it FIRST — as `/portal-config.js?v=17`)
All 123 pages reference `?v=13` (cache-bust; ?v=6 forced the `.ml-back` styling,
?v=7–9 the animated wait mark, ?v=13–17 the status-bar cap — 13 had to clear a
concurrent session's ?v=12 or phones would have kept the pre-cap file). If a
portal-config change must reach them again, bump to ?v=18 across all pages
with sed — and check the
count afterwards (`grep -aho 'portal-config\.js?v=[0-9]*' *.html | sort | uniq -c`
should show ONE version; cctv.html had been left behind on ?v=2 for weeks, so it
was silently running an ancient portal-config). NB `grep` treats programmes.html
as binary — use `grep -a` or it drops out of every sweep. Provides:
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
- **Busy mark — the spinning Mostlane "M"** (`mlLoading()` IIFE, 17 Aug):
  EVERY busy state in the portal shows `/icons/icon-192.png` (the M tile)
  animating `mlSpinStop` — one eased revolution in ~0.9s, then a ~0.8s rest,
  repeating (spin · stop · spin · stop), 1.7s cycle, held still under
  `prefers-reduced-motion`. Sized in **em** (1.45em) so a small grey footer
  status line and a full-size card row both look right. **New code should call
  `MLUI.loading("Loading jobs…")`** → an HTML string (mark + label);
  `MLUI.loading(txt,{big:true})` is the large centred variant for a whole panel.
  Existing pages need NO edit: ~250 busy strings across ~90 pages are written
  every which way (static HTML, innerHTML, textContent), so an initial pass + a
  MutationObserver upgrade any element whose WHOLE text is a busy phrase,
  keeping the original wording as the label ("Loading fleet…" still reads).
  **Detection is NOT a word list** — it needs BOTH signals: the text **ends in an
  ellipsis** AND **contains a gerund** (an "-ing" word), ≤40 chars, no element
  children. Either signal alone is wrong: the ellipsis alone catches dropdown
  placeholders ("Select site…", "Choose a person…") and menu/button labels
  ("Edit finance…", "🗓 Shift dates…", "Mark selected as…"); the gerund alone
  catches the H&S pages' "Working days" / "Working On or Near Live Services".
  A STOP set drops non-verbs that end in -ing (nothing/something/morning/…) so
  "Nothing new…" and "Something went wrong…" stay plain. Bare "Loading" (no
  ellipsis) is the one accepted exception. **Validated against every "…" string
  in the repo: 100 wait states matched, and the 22 non-matches are all
  placeholders or buttons** — re-run that sweep if the rule is ever touched.
  (b) **NO sticky "already done" flag.** An early version set `data-mlload` and
  skipped flagged elements, which broke any page that re-shows its status —
  vehicles.html does `statusLine.textContent = "Loading fleet…"` on every
  refresh, wiping the mark back to plain text for good (Jamie caught this on his
  phone). The `el.children.length` test already skips an upgraded element (it
  now holds our span), so the flag was both redundant and harmful.
  `<button>` is in the SKIP list so a "Saving…" button label never gets a mark.
  **The component injects its OWN `<style id="ml-load-style">` rather than riding
  the sidebar's `#pnav-style`** — that block is skipped inside iframes (po.html
  embeds po-office.html), on auth/my-day pages and for Story users, and without
  the CSS the mark renders as a raw 192px icon.
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
- **Field-app bottom tabbar (Aug 2026 rework)** — the tabs on route.html /
  engineer-jobs.html / inbox.html / you.html are now **Route · Jobs · Menu**
  (were Route/Jobs/Inbox/You, then briefly Route·Jobs·PO·Menu). **The PO tab
  (`#tabPO`) was REMOVED (Aug 2026)** — it pointed at the old standalone PO
  system, and engineers are now pushed to raise POs **from the job** (job-view
  "Raise PO for this job", which stamps job_id for costing linkage) so nothing is
  unlinked. The `/po-config` resolver script was removed from all four pages too.
  **Menu** →
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
  still route.html. **Engineer day flow (Aug 2026):** the main.html **SLA tile is
  repointed to route.html for FIELD users** (applyGate; office/admins keep
  sla-main.html), and **route.html auto-forwards to engineer-jobs.html while the
  engineer is mid-shift** (`onShift()` = clock_on_at && !clock_off_at) — tap SLA
  before starting → the day page; once started → straight to the jobs list.
  `route.html?stay=1` bypasses the forward (every tabbar/`.eng-back` Route link on
  route/engineer-jobs/inbox/you now carries `?stay=1` so deliberate navigation
  always works). **engineer-jobs.html has the live day bar for EVERY engineer**
  (was Story-Mode-only): `init()`'s non-story branch runs
  `loadShift().then(renderDayBar+applyDayGate)`, so the top of the jobs list shows
  ▶ Start my day / 🟢 On shift + **■ End my day** / ✔ Day ended (Story users keep
  their "Open My Day" link; applyDayGate still no-ops for non-story).
  **Simple start/stop + live timer + resume (Aug 2026, Jamie's spec):** Start is a
  ONE-TAP clock (no mileage/fuel prompts, no vehicle-check intro — the check gate
  is kept but OFF behind a `DAY_START_CHECK=false` flag in BOTH engineer-jobs.html
  and route.html, to reintroduce later as "the daily check"). The on-shift bar
  shows a **live ticking H:MM:SS timer** (`fmtElapsed`/`dayTimerInt`, cleared on
  re-render). **End my day asks "Are you sure?"** (MLUI.confirm, danger) before
  posting; a blocked (409) or cancelled press is still audit-logged server-side.
  The ✔ Day-ended bar has **▶ Resume my day** (also on route.html's "That's a
  wrap" screen, which forwards to engineer-jobs on resume) → **POST /shift/resume**
  (sla.js): clears `clock_off_at` on today's shift so the timer runs on from the
  original start — for emergency call-outs after clocking off. Clock-off's UPDATE
  now COALESCEs gps/end_mileage/fuel so a resume→re-end never wipes the first
  press's values. **Protected
  clock-off:** `/shift/clock-off` (sla.js) refuses with **409 + `outstanding` list**
  while the engineer still has unfinished jobs today — assigned+released jobs whose
  per-engineer `effStatus` is active (Travelling/In Progress) or scheduled TODAY and
  not finished/parked (finished = Complete/Closed/Invoiced/Cancelled/`done` custom
  categories; parked = On Hold/Quote/Order — those need their packs via the
  cross-job guard instead). `{force:true}` bypasses for FullAccess|SLAAdmin only;
  the check fails OPEN on an internal error so clock-off is never impossible. Both
  clockOff() clients (route.html endDay + engineer-jobs.html) surface the 409 with
  the "• ref — status" list. engineer-jobs.html's **"📌 Assigned — not booked in"** box is
  now a **collapsible** (default collapsed, tap the banner; per-device state in
  localStorage `mlUnschedOpen`). Its week list runs **Mon–Sun** (startOfWeek is
  Monday-based). The **🗺️ map overlay** (`openDayMap`) fetches all the engineer's jobs once
  (`/jobs/for-engineer` no date) then a **Day / ±7 days / ±30 days / Year**
  segmented slider (`#dayMapSeg`/`renderMapForRange`) pins whichever range,
  plus a "Show status" filter; defaults to Day on open.
  **The N-day windows span BOTH directions around today and must stay that way.**
  They were briefly made forward-only ("Next 7/30 days", 17 Aug) and that emptied
  the map: work here is booked only a day or two ahead, so at the time "next 7
  days" held 4 jobs where "last 7 days" held 50, and engineers reported their
  jobs had vanished (19 Aug). Either side of today keeps upcoming work visible
  for planning AND the recent jobs engineers actually look for. An **All** segment sits
  after Year: it drops the date filter entirely and is the ONLY view that can show
  jobs **assigned but not booked in** (no `scheduledAt`, so they fall inside no
  window) — those pin with a dashed outline and a "📌 Not booked in yet" popup.
  Every range's status line now names what ISN'T pinned ("· 2 with no usable
  postcode · 3 not booked in (tap All)") so a missing job is never a mystery.
  **Geocoding caches SUCCESSES ONLY** (`mlPostcodeGeo_v1`) — caching a miss as
  null meant a postcode that failed once, on a bad batch or a rate-limit, was
  never looked up again on that device and its pin stayed missing for good.
  **That cache is SHARED by engineer-jobs.html, route.html AND
  sla-scheduler.html** — fixing only one page is not a fix, because the other two
  re-poison it on the next visit (this is what made the pins come back and vanish
  again). All three now: strip any nulls left by an older build when they load the
  cache, keep failures in an in-memory `geoMiss` for the page load only, and
  persist arrays exclusively. sla-scheduler's "postcode not recognised"
  diagnostic reads `geoMiss`, not a stored null.

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
  **Approved leave auto-flows to timesheets + scheduler (Aug 2026):** exported
  helper **`approvedLeaveInRange(env,tid,from,to,username?)`** expands each
  approved booking's start→end into per-day markers `{username:{date:{type,half}}}`;
  **GET /holiday/calendar?from=&to=** (any logged-in user) returns it for the SLA
  scheduler. timesheets.js `holidayDaysFor()` (uses the helper) adds `holidays`
  to **GET /ts/my** + **/ts/admin/overview**; engineer-timesheet.html renders a
  full holiday day as a green holiday-only card (half-days keep inputs + a banner)
  and timesheets-admin.html shows a 🌴 chip per day. sla-scheduler.html loads
  /holiday/calendar for a ±window around the date (`holidayMap`, `holFor`) and
  shades/badges any engineer's day/week cell they're on leave — so you never
  schedule someone who's off.
  **"Used" is USED-TO-DATE (Aug 2026):** `computeUsage()` (shared by
  /holiday/summary + /holiday/admin-summary) counts a bank-holiday/shutdown
  system day toward `used` only once its date has PASSED; the full-year figure is
  `committed` (remaining = allowance − committed). **Duplicate-day safeguard:** a
  system day (bank/shutdown) whose date is already covered by an approved paid
  Holiday booking is NOT charged again (`bookedHolidayDates` → skip) — a holiday
  on a bank holiday only ever costs one day. Both summaries return a per-person
  breakdown `{booked, bankHolidays, shutdown, committed, usedToDate}` (system days
  split by `kind`; `sysOut` now exposes `kind`). **Wall chart (holiday-admin.html):**
  each name shows a summary (`N booked · N bank · N shutdown · N left` from BALMAP),
  and clicking a name highlights that row — persisting across month navigation
  (`SELECT­ED_USER` + `applyWallSel`, re-applied in loadWall); click again to clear.
  **Timetastic re-sync (Aug 2026):** the live 2025/2026 leave + allowances were
  reconciled to the Timetastic full export — the `H-TT-<bookingId>` rows were
  replaced from the export (real leave only: Holiday/Unpaid/Compassionate→Other),
  per-year `holiday_allowance` set from the export's per-year columns. Bank
  holidays/shutdown stay portal-generated system days; **2026-01-02 was reclassified
  from bank holiday → company shutdown** (config + system days) to match Timetastic.
  NB bank holidays are still generated UNIFORMLY per active user, so owners (Greg/
  Jamie) whose Timetastic bank-holiday count differs are over-deducted — per-person
  bank holidays would need the export's bank rows imported + auto-gen disabled.
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
  **The pill's LOOK is owned by portal-config.js and FORCED with `!important`
  (17 Aug) — never restyle `.ml-back` on a page.** It is a white pill, 999px
  radius, 1px #d7dee6 border, navy #003366 text, 14px/600. Why forced: a page with
  a dark header band declares `header.page a{color:#fff}` (specificity 0,1,2),
  which beat the old un-forced `.ml-back{color:#003366}` (0,1,0) and painted WHITE
  text on the WHITE pill — a blank, invisible button. That hit 16 pages (all the
  po-*, timesheets-admin, engineer-timesheet, van-timesheet, fleet-report,
  programmes/programme-edit, compliance-review, my-van-scores, cctv…). All 19
  per-page `.ml-back` rules were deleted; **only engineer-jobs.html keeps one**
  (`display:none !important`, because the field app uses its own `.eng-back`) —
  which still works because `display` is deliberately the ONE property portal-config
  does NOT force. Verified by rendering all 97 pages headless and measuring computed
  colour/contrast (scratchpad `audit-back.cjs`): 93 measurable pages all report
  identical `rgb(0,51,102)` on `rgb(255,255,255)`, 999px, 14px.
  **Engineer day summary (Aug 2026):** clicking an engineer's NAME on the
  scheduler (day-lane header or week-grid name cell — `.day-name.clickable` /
  `.week-day-header.clickable`) opens the **#engDayBackdrop** modal (`openEngDay`)
  showing how that engineer is getting on for the day: a **status count strip**
  (N jobs · Scheduled N · In Progress N · Complete N …, coloured by STATUS_COLOUR,
  known statuses ordered by `ENG_STATUS_ORDER` then custom categories) + a
  time-sorted **list of their jobs** each with time · ref/title · site/priority ·
  a coloured status chip. Data = **GET /sla/jobs/for-engineer?engineer=&date=**
  (serves THAT engineer's own per-engineer status). Day view uses the selected
  date; week view uses today if it's in the shown week, else the picked date.
  Tapping a job row opens the quick edit modal (board jobs) or job-view.html
  (finished jobs, which loadJobs drops from the board). The modal has a **🗺️ Map**
  button (`openMapForEngineer`) that opens the shared map overlay scoped to that
  engineer's jobs for the day (`mapScope` = {engineer,name,date}; `jobsForMap()`
  filters, the status chips hide, title shows the name+date). The scheduler's
  **quick edit modal** also has a **🗂 Job card** button → `job-view.html?jobId=`
  (the full office card — handy for completed jobs).
  **Completed jobs stay on the board (Aug 2026):** loadJobs no longer drops
  "Complete" (only Closed Jobs / Invoiced stay off). A Complete job renders GREEN
  with a ✓ and is LOCKED (not draggable). **Day view positions a finished job at
  the time it was ACTUALLY worked** — `actualWindow(job, engineer)` reads the
  In Progress → Complete timestamps from `job.statusHistory` (normaliseJob now
  passes statusHistory through; multi-eng entries carry `eng`=normId matched via
  `schedNormId`) so an early finish slides left behind the now-line. The stored
  `scheduledAt` is NEVER changed — a faint dashed 🕘 `.sched-marker` is drawn at
  the original scheduled slot and the hover shows "Scheduled HH:MM (worked HH:MM)".
  Falls back to the scheduled slot when there are no actual times (office-marked
  complete) or the work wasn't on the shown day. Week view just greens the chip.
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
  **Job photo thumbnails (Aug 2026 — fixes slow/blank previews in engineer-job.html):**
  the engineer photo grid used to paint each tile with the FULL-RES `publicURL` as a
  CSS background — no lazy-load, so every photo downloaded at once and previews were
  slow or blank (they only appeared once tapped = cached). Now mirrors the site-photo
  pattern: **POST /sla/jobs/{id}/files** accepts a client-shrunk `thumb` form field →
  stored as `<key>.thumb`; **GET /sla/jobs/{id}/files** returns `key` + a signed
  `thumb` URL (via `/sla/site/thumb`, which already accepts `jobs/` keys and edge-
  caches) + `hasThumb`. engineer-job.html `uploadPhotos` generates a 400px JPEG thumb
  (`shrinkImage`) alongside each photo; `drawPhotos` renders `<img loading="lazy"
  decoding="async" src="thumb||publicURL">` (full-res only opens in the lightbox on
  tap) with a shimmer `.pend` placeholder + a one-shot error fallback to full-res;
  `backfillThumbs()` self-heals older photos with no thumb (fetch→shrink→POST
  /site/thumb, 2 lanes) — normally a no-op since new uploads carry their thumb.
  (job-view.html office view still uses full-res; same treatment could be applied there.)
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
  **Approved leave shows on the office clock (Aug 2026):** a holiday used to
  read as a BLANK day on "My Hours" (office-my-hours.html) — as if the person
  never clocked in — and the week came up short. `weekDetail()` now overlays
  `approvedLeaveInRange()` (the same holidays.js helper the engineer timesheet
  and SLA scheduler use), so each day may carry
  `holiday:{type,half,seconds,paid}`. A full day is **8h** (`LEAVE_DAY_SECONDS`),
  a half day 4h; **Unpaid leave marks the day but is worth 0h** (`isPaidLeave`).
  `weekTotal` deliberately stays CLOCKED-only so existing consumers don't change
  meaning — the new **`holidayTotal`** and **`paidTotal`** carry the leave, and
  My Hours shows `paidTotal` with a "Nh clocked + Nh leave" split underneath.
  Applies to /office/my, /office/user-week AND the office master timesheet
  **/office/timesheet** (office-timesheet.html, 18 Aug): each user row carries
  `holidays`/`holidayTotal`/`paidTotal`, a leave day renders as a green cell with
  🌴, the Total column shows the paid figure with a "20h 0m + 12h 0m leave" split,
  and the CSV's day columns match the screen plus explicit Clocked / Leave /
  Total-paid columns. Someone signed off ALL week has no clock rows at all, so
  the leave pass calls `ensure()` to give them a line rather than letting them
  vanish — but only for OfficeClock holders (`officeUsers` set), or a field
  engineer's holiday would appear on the office sheet. The per-person ✏️ Edit
  modal shows the leave too. NB `hm(0)` renders "–", so the split line omits the
  clocked half when nothing was clocked ("40h 0m leave", not "–  + 40h 0m").
- **Total cost of a job to us** (job-view.html "💷 Total cost to us" card,
  **office/admin only** — FullAccess|SLAAdmin): **GET /costing/job-full-cost?jobId=**
  (costing.js) sums **labour on-site** (job_time_segments for the job → per-engineer
  minutes × hourly rate from `ratesMap`; a day rate ÷8; 14h runaway clamp) +
  **travel labour** (one round trip HQ→site→HQ per engineer per distinct day worked,
  driving time = miles ÷ 30mph × rate) + **fuel** (those round-trip miles × a FIXED
  **£0.50/mile**) + **materials** (priced POs; unpriced POs are FLAGGED, never counted
  as £0). Round-trip miles come from the `site_miles` register first (already a
  round-trip figure), else a HQ `PO15 5RQ` → site-postcode geocode (postcodes.io) ×
  1.25 × 2. Returns per-engineer breakdown + `unpricedPOs`/`missingRate`/`hasSegments`
  flags; the card shows the headline total + labour/travel/fuel/materials rows and an
  amber "N POs raised but not yet priced — total will rise" note. Nothing stored.
  The PO-numbers card below it (clickable → filtered PO board) is separate.
- **Per-job PO materials cost** (job-view.html "🧾 Materials — purchase orders"
  card, **office/admin only** — FullAccess|SLAAdmin; shows each PO's **number**,
  clickable → `po-office.html?search=<po>`, + an "Open all N POs → `?job_id=`" link):
  reads live from the PO
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
  **Per-driver on/off + global pause (Aug 2026 — sending controls):** an admin
  controls WHO is in the weekly cycle without touching the notification centre.
  A **per-driver opt-out** list lives in app_config **`vancheck:optout:<tid>`**
  (JSON array of usernames); `getOptedOut(env,tid)` returns the Set. A driver
  switched **Off** is dropped from `remindDrivers` (no cron/Remind-now push), from
  `/vancheck/attention` (`mineDue`=false, and excluded from admin `missing`), and
  shown "Off — not required" on the weekly grid — but can still submit a check.
  **POST /vancheck/driver-toggle** `{username, enabled}` (Vehicles|FullAccess)
  adds/removes them; **GET /vancheck/week** now returns `enabled` per row +
  `globallyPaused`. The **global "bypass"** (mute reminders for EVERYONE) is the
  vehicle-check suppression rule with no user/key — surfaced on van-checks.html as
  a banner (⏸ Pause all / ▶ Resume) via **POST /vancheck/pause-all** `{paused}`
  (`isGloballyPaused(rules)` detects it; add/remove through lib/suppress
  getRules/saveRules), so the blunt on/off is controllable in one place instead of
  buried in the notification centre. Front-end: van-checks.html grid has an
  On✓/Off toggle column + the pause banner.
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
  **Auto-recognise a compliance cert in the GENERAL doc areas (Aug 2026):** a cert
  dropped into an ordinary Site Documents area (not the Compliance tab) used to sit
  as a plain doc the chart never saw. site-folder.html `uploadBar` now runs
  `detectComplianceType(filename)` (keyword heuristic → fiveYear/pat/em/pv/ev/pump/
  asbestos; word-boundary matched so Invoice/Patricia/review don't false-positive)
  on each non-photo file; if it matches AND the user `canCompliance()`
  (FullAccess|Compliance), a confirm-and-correct modal (`askCompliance`) pre-selects
  the detected type (+ a scheme picker when the site has >1 compliance section) and
  files it via **POST /compliance/file** (bump=1) instead of /sla/site/docs — so it
  lands on the chart + rolls the due date, exactly like the Compliance-tab upload.
  Decline → filed as an ordinary document. Never silently files (the modal is the
  safety net against a mis-named file bumping a due date). Verified: 344/344 coop +
  24 Fareham compliance stores are linked to a real portal site, so a filed cert
  surfaces under the site both ways.
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
  **Document-type classification + remediation (v10):** the engine now returns a
  `docType` per PDF — `eicr` (condition report: title / stated SATISFACTORY-
  UNSATISFACTORY assessment / schedule of test results), `minorworks` (Minor
  Electrical Installation Works Certificate), `eic` (Electrical Installation
  Certificate), or `other` (remedial sheet / quote / paperwork). A stated outcome is
  EICR-exclusive so it wins; else the certificate title decides. The worklist walks a
  site's 5-Year docs newest-first, picks the newest `eicr` as the condition report AND
  collects any `minorworks`/`eic` seen along the way (the remedial certificates). **If
  the chosen EICR is UNSATISFACTORY but a Minor Works / EIC on file is dated on/after
  the EICR's date, the observations are treated as cleared → outcome `REMEDIED`,
  attention off, a ✅ "remedied by a … dated …" flag** (a REMEDIED green badge). A
  remedial cert with no readable date can't clear it (fails safe → still flagged).
  Remedial certs are expected filed under 5-Year alongside the EICR (where Jamie files
  them). `outcome` is stored capped at 20 chars ("REMEDIED" fits); no worker change.
  **site-folder.html Previous Jobs** (the Documents → Previous Jobs tab) lists LIVE
  jobs + the imported ARCHIVE (historical) jobs for the store (GET /sla/site/jobs
  returns both, each tagged `source:live|archive`; archive carries its full imported
  record). Every job opens in a **read-only modal** (archive badged 🗄; live keeps an
  "Open full job (edit)" link for FullAccess only). **Financial info is FullAccess-only:**
  the server strips money fields from each archived record for anyone without FullAccess
  (`stripFinancial` via `isFullAccess` in /sla/site/jobs — by key cost/price/invoice/…
  or any £/$ value), so a field engineer only ever sees description/notes/status/etc.,
  never costs/invoices.
- `cctv.js` — **CCTV Wall DVR snapshot proxy** (page **cctv.html**, 📹 tile +
  sidebar, Full-Access `__fullOnly`). A browser on the HTTPS portal can't load a
  DVR JPEG directly — mixed content (HTTPS page → HTTP DVR) AND Annke/Hikvision
  snapshots need **digest** auth an `<img>` can't do — so the worker fetches the
  snapshot server-side and streams it back over HTTPS, hiding the DVR login.
  Config in app_config `cctv:sites` = `[{id,name,host,port,https,user,pass,
  vendor,path,cameras:[{id,name,ch}]}]` (passwords stored server-side, NEVER
  returned to the client). Routes: **GET /cctv/sites** (Full-Access; per-camera
  **signed** snapshot URL via filesign, 24h), **POST /cctv/site** (upsert;
  validates port against the CF-fetch allowlist 80/8080/8880/2052/2082/2086/2095
  + HTTPS variants; auto-gens N cameras — Hik ch = n01, Dahua ch = n), **POST
  /cctv/site/delete**, **POST /cctv/test** (live-fetch first camera), and **GET
  /cctv/snapshot?key=&exp=&sig=** (PUBLIC_ROUTES, sig-verified, does the digest
  handshake — includes a self-contained MD5 since WebCrypto has none — and
  returns image/jpeg no-store). Vendor paths: hik
  `/ISAPI/Streaming/channels/{ch}/picture`, dahua `/cgi-bin/snapshot.cgi?channel={ch}`,
  or a custom `{ch}` template. Front-end cctv.html: split-screen grid (auto/
  1×1…4×4), location tabs per site, per-tile reload/fullscreen, whole-wall
  fullscreen, DVR-sites admin modal (add/edit/test/delete, view-only-user
  guidance, port-forward note), plus a manual "other feed" path (HLS via lazy
  hls.js/native, MJPEG, snapshot-poll, iframe embed, direct video) kept in
  localStorage. **Ring/cloud-app cameras deliberately NOT supported** (no
  browser-openable feed without an always-on bridge — documented in-page).
  **Reachability requirement:** each DVR must be internet-reachable and forwarded
  to a CF-fetch-allowed port (8080 easiest), HTTP preferred (worker→DVR is
  server-side; a DVR self-signed HTTPS cert would fail the worker's cert check).
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
- **Van-check defects on the vehicle card (Aug 2026)** — a reported fault now
  shows prominently on vehicles.html. `/fleet/vehicles` computes per-van
  outstanding defects via **`vanCheckDefects(env,tid,resolved)`**: ANY van-check
  answer of `defect`/`missing` OR the driver's `safe_to_drive=0`, aggregated per
  reg (returns `defectItems`/`defectChecks`/`defectNotSafe`/`defectSince`). The
  model is **explicit-resolve, not auto-clear** (Jamie's rule): a fault stays
  flagged even after a later clean check until an admin taps **✓ Mark defects
  resolved**, which stamps a per-reg "resolved as of now" time in app_config
  **`fleet:defectsclear:<tid>`** (`{REGNORM:ISO}`) via **POST /fleet/defects-resolve**
  `{reg}` (any Vehicles user) — checks completed on/before that time are treated
  as dealt-with; a NEW defect reported afterwards re-flags the van. Front-end
  (vehicles.html): a red **⚠ Defect reported** tag (+ **🚫 Not safe to drive**
  when flagged) on the card + deep-dive, a **Vans with faults** summary tile
  (hidden when zero), and the **✓ Mark defects resolved** button on the card and
  in the deep-dive's red banner (which also links to vehicle-checks.html to see
  what was reported). `hasDefect(v)`/`defectTags(v)`/`resolveDefects(reg)` are the
  helpers; no schema change (app_config only).
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
  **Driver table autosaves (Aug 2026):** the "🧑‍🔧 Vehicle drivers" selects
  (reg → driver for the week) now save the moment one is changed — debounced
  500ms, "Saved ✓" beside the heading, retry on failure, `keepalive` flush on
  pagehide/visibilitychange (NOT sendBeacon — it can't carry the Bearer header
  and the worker takes no `?token=`). Previously they were only written when a
  report was generated, so the table had to be redone every week.
  **Gotcha:** POST /fleet/drivers REPLACES the whole map, and load merges it OVER
  `/fleet/current` (the registry) — so a deliberate "— unassigned —" must be sent
  as an explicit `""` or the registry's driver silently reappears on reload.
  `DRIVER_BLANKS` tracks those, seeded on load from stored blanks so it survives
  a refresh; getDriverSelections() still omits untouched blanks so an unedited
  van keeps following the registry.
  **Auto-save (Aug 2026):** every generated report saves to the portal
  automatically (generate() calls saveReport({auto:true})); the POST **dedupes by
  week range** (deletes any earlier report with the same weekStart+weekEnd) so
  regenerating a week UPDATES it instead of piling up duplicates. The manual
  button is now "💾 Save again" (re-save after edits). The saved-reports list
  (loadPastReports) is **grouped under month/year banners** (`.rpt-month`, keyed
  by weekStart's month, newest first) so a long history is easy to scan.
  **Send van driver scores to engineers (Aug 2026):** scores in the report are
  keyed by reg; each vehicle carries `driverUser` (the assigned engineer). After
  a report generates, a **"📤 Send Van Scores to engineers" modal** auto-pops
  (also a header button) listing each engineer that has a score — checkbox
  (pre-ticked) + colour-coded score — and **POST /fleet/scores/send**
  `{weekStart,weekEnd,scores:[{username,reg,score}]}` (Vehicles) files each to
  **table `driver_scores`** (PK tenant+username+week_start, re-send updates) and
  **push-notifies** each engineer (sendToUser → /my-van-scores.html). Engineers
  see their OWN history at **my-van-scores.html** (hero = latest, grouped by year)
  via **GET /fleet/scores/mine** (any session, own rows only — placed BEFORE the
  fleet canFleet gate so field users without Vehicles perm can read it). A field
  notice: **route.html** shows a dismissible "new van score" banner when **GET
  /fleet/scores/unseen** `{latest}` beats the local `mlVanScoreSeen` marker
  (my-van-scores + the ✕ write it, mirrored to /prefs `vanScoreSeen`). Pool vans
  (no single assigned engineer) are excluded from the recipient list. The page is
  deliberately NOT a menu tile (only reached via the notification/banner).
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

## Chapplins customer (routes/chapplins.js + chapplins.html + chapplins-compliance.html — Aug 2026)
A whole customer (Chapplins Lettings) built from their emailed **job-report PDFs**,
imported via the **Microsoft 365 / Outlook connector** across THREE senders —
`support@`, `ashley@` and `kerry@chapplins.co.uk` (the job emails are structured:
Tenant ref/Name/Property/contacts/Job Number/Date/Description; resumable
checkpointed extraction subagents + a three-way merge script lived in the session
scratchpad — merge3-chapplins.mjs). Modelled as a full customer like Co-op/Fareham
— NOT a silo. **Live totals (20 Aug 2026): 123 sites · 76 tenants (70 current) ·
123 compliance stores · 578 archived jobs**, 0 orphans:
- **Sites**: normal `sites` register, **client=`chapplins`**, numbered **4001–4127**
  (added to the sites.html category dropdown + `ucClient`), currently 123 live
  (unit-level: individual flats + communal areas are distinct sites). Loaded direct
  to D1 (PII stays out of the public repo — never commit customer data). **Duplicate
  communal records were merged** (20 Aug): the same communal area recorded 2–3× under
  slightly different names was collapsed to one canonical site (jobs repointed, not
  deleted) — Woodhouse 4127/4095→4094, Crawford 4074→4109, Andover 4073→4108;
  individual flats were left untouched. **Any new communal-area sweep: merge only
  duplicate COMMUNAL records, never fold flats into their block.** NB Jasmine Court
  4088 and 4044 are TWO SEPARATE buildings (different postcodes PO21 5LT vs 5UR) —
  confirmed by Jamie, do not merge.
- **Tenants** (the genuinely new bit): table **`site_tenants`** (self-migrating;
  tenant_id INTEGER, keyed `id=<client>:<siteNumber>:<slug(ref|name)>`), generic
  per-site tenant with **current + previous history** (`is_current`, first/last_seen
  from job dates → newest = current). Route **/chapplins** (session-gated; manage =
  FullAccess|Compliance|SLAAdmin): GET /chapplins/sites (directory + current tenant
  + job count + compliance due), GET /chapplins/site?number= (tenants current-first +
  jobs), POST /chapplins/tenant (upsert, makeCurrent unsets siblings), /tenant/current,
  /tenant/delete. Real handovers captured (newest=current, older=previous) at e.g.
  4039 (BIS44→BISH01), 4046 (NATH01→CHO202), 4070 (COO600→COOP8), 4077 (MANN12→MANN2),
  4004 (POT140→OLEK01), 4021 (SKRU01→LAI01). 76 tenant rows total, 70 current.
- **Jobs**: 578 job reports live in **`sla_jobs_archive`** (id `CHAP-<jobNumber>`;
  within-sender reused job numbers get a `-2` suffix; `site_code`=numeric site
  number) so each site's **Previous Jobs** tab + the Job Archive search surface them
  for free. Skeletons now; enrich later from Workever.
- **Compliance**: new **`chapplins` scheme** in compliance.js (SCHEME_DEFAULTS/
  SCHEME_LABELS/TYPE_LABELS/canonType) — six landlord cert types **fiveYear(EICR 5y),
  gas(1y), epc(10y), alarms(1y), fire(1y), legionella(2y)**. compliance_stores rows
  (scheme=chapplins, code=site_number; 123 rows, one per live site) created empty
  (no certs in the emails yet — a framework to populate going forward). Page
  **chapplins-compliance.html** = a clone of fareham.html on scheme=chapplins.
  **🔑 column + access modal (Aug 2026):** the key button is always a plain 🔑
  (the "🔑❓" not-set variant read as something being wrong with the site; the
  📍 pin keeps its ❓), and its modal shows **Access instructions only** — the
  "Keys required" and "Site contact" blocks were dropped from both the view and
  the edit form. Any `meta.keys`/`meta.contact` already stored is untouched
  (the save now sends only `access`, and /store-meta merges), so re-adding the
  fields later would show the old values.
  **📍 Fill missing pins (Aug 2026):** all 95 Chapplins sites carried a postcode
  but NONE had a location pin, and 95 by hand is not realistic. A
  **"📍 Fill missing pins"** button in the utility bar (Compliance|FullAccess)
  looks up every store with NO pin via postcodes.io **in the browser** (the same
  lookup the scheduler and sites register use — the worker can't be the one to
  call it) and saves each through the normal **POST /compliance/store-meta**, so
  the linked portal site's lat/lng and its SiteLog geofence move with it exactly
  as if the pin had been dropped by hand. A pin already set is never touched
  (w3w/access/contact survive — the route merges); a postcode centroid is a
  starting point, so rows stay draggable. The outcome goes in a **modal**, not an
  `alert()` — portal-wide `alert` is an MLUI toast and can't carry the list of
  what was skipped (postcode not recognised / no postcode at all). NB 4073
  "Communal Area, 22 London Street, Andover" had no postcode; set to SP10 2PE
  from the two sibling flats at the same address. 4074 (The Crawford Apartments,
  Percy Road, Exeter) still has none. The button is Chapplins-only for now:
  Fareham's 24 stores have no postcodes to look up (2 exceptions) and the Co-op
  chart (eicr-portal.html) has no 📍 column at all. (NB 4073 and 4074 referenced
  above were later merged away as duplicate communal records — see the Sites bullet.)
- **Nav**: 🏠 Chapplins tile on main.html (MAP `Chapplins:["Compliance","SLAAdmin"]`),
  sidebar entry in portal-config, a card on compliance.html → chapplins-compliance.html.
  Hub page **chapplins.html** = the directory (search, per-site current tenant +
  contacts, previous tenants, jobs, links to site-folder + compliance).
- **Ongoing intake (TODO/next):** new Chapplins job emails could auto-import via the
  Outlook connector on a schedule (like the Zapier /sla/inbound path) — not built yet.

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

## Job programmes (routes/programmes.js + programmes.html / programme-edit.html / programme-view.html — Aug 2026)
**Notes & items to discuss (Aug 2026):** below the Gantt the builder has a
"📝 Notes & items to discuss" card editing **`data.noteItems` = [{id,text,discuss}]**
(separate from the top settings `data.notes` free-text "assumptions/exclusions"
blob, which still exists). Each row is a note with a "To discuss" toggle;
autosaves via the normal `queueSave` (part of `data`, no worker/route change).
It flows read-only to **programme-view.html** (`renderNoteItems`: plain notes as
bullets + a highlighted "❓ To discuss" box, blanks skipped, card hidden when
empty) and to the **PDF** (`lib/progpdf.js` notes page: free-text notes, then note
bullets, then a "To discuss" list; page-break guarded). (PDF: a themed box directly below the chart when it fits — keeps a short programme to 2 pages — else its own page.) NOT yet in the Excel
export (progpdf/PDF is the primary locked share format). No programme-gantt.js
change (kept off the shared renderer), so no `?v=` bump.
Build a **programme of works** (Gantt: sections + activity rows on a weekly grid)
in the portal and share it with clients by **revocable link — never a file**
(Jamie's "locked hard" requirement: Excel can't be locked, so nothing leaves the
portal). Permission **`Programmes`** (new PERMISSION_KEYS entry; FullAccess
implies) gates the 📊 Programmes tile + sidebar item + all /prog/* admin routes.
**Model:** the working **draft** autosaves (Jamie's no-save-button rule);
**📤 Issue** freezes it as an immutable revision (Rev A, B, … `revLabel`);
**🔗 Share** creates a token link (`programme-view.html?t=<hex>`; optional
access code + expiry days + view-only, per-link open counter, Revoke kills it).
The client page (NO auth.js/portal-config — public) fetches **POST
/prog/shared/open** {token, code} which serves ONLY the latest ISSUED revision,
watermarked; **✎ Suggest changes** gives the client an editable COPY (same
shared renderer) submitted via **POST /prog/shared/suggest** — stored in
`programme_suggestions` (+ push to the programme's creator), the issued
revision untouched. The builder's 💬 suggestions list shows a per-row **change
diff** (`MLProg.diff`, vs the revision it was made against), with "↪ Load into
my draft" / incorporated / dismissed. Both /prog/shared/* are PUBLIC_ROUTES
(token verified in-handler). **`programme-gantt.js?v=1`** = the ONE shared
renderer (`window.MLProg`: render editable/read-only, blank, uid, diff) used by
builder + client page, sticky first column, week columns from the Monday of the
earliest activity, today line, milestones (◆), per-row colour + progress %.
Tables (self-migrating + schema.sql): **job_programmes** (draft),
**programme_revisions**, **programme_shares**, **programme_suggestions**.
Headers on the two admin pages carry `padding-right:60px` so the fixed 🔔 bell
never covers the header buttons. Help group "Job programmes" (build/issue +
share/suggest).
**v2 — matched to Jamie's Excel example (`Programme (TURN OFF AUTOSAVE).xlsm`,
received 16 Aug):** the workbook is a DAY-level programme (Works · Contractor ·
Start · End · Days · Wknd; daily dd/mm+ddd columns; "X" day cells coloured by
contractor via CF; per-contractor filtered tabs; MIN/MAX Start/End/Days summary;
end = `WORKDAY(start,days-1)` unless Wknd=TRUE). `programme-gantt.js?v=2`
replicates that model: data = `{contractors:[{id,name,colour}], tasks:[{name,
contractor,start,days,wknd,progress,milestone}]}` (**`MLProg.migrate`** flattens
old v1 `{sections}` drafts), DAY columns with weekend shading, **end date
computed weekend-skipping** (bars SPLIT around weekends unless wknd), bars
coloured by contractor (legend editor in the builder; default palette = the
workbook's: #00B0F0/#92D050/#FFC000/#852C98 + grey), Start·End·Days summary
line, and **filter chips** (the per-contractor tabs). **Contractor-scoped share
links**: `programme_shares.contractor` + `programme_suggestions.contractor`
(self-migrating ALTERs) — a scoped link's /prog/shared/open **filters tasks
server-side** so a subcontractor only ever receives their own rows; their
suggestion carries the contractor, the builder diffs against the same-filtered
base (no false "removed"), and "Load into my draft" **merges only that
contractor's tasks** (everyone else's untouched). The workbook's VBA
(theme/dropdown refresh, sheet password) is NOT needed — the portal replaces it.
**AI draft-from-a-document (Aug 2026):** a "🤖 Draft from a document" button on
programmes.html opens a modal that reads a **specification/scope (PDF via PDF.js,
.xlsx via xlsx-lite, or text/CSV) ENTIRELY IN THE BROWSER** (nothing uploaded —
only the extracted text is sent) — or the office can paste the scope.
**Scanned / image-only PDFs (no text layer, e.g. "Print to PDF" of pictures):**
when browser extraction yields < 40 chars the client base64-encodes the PDF and
posts it as `pdfBase64`; the worker sends it to Claude as a **`document` content
block** (`{type:"document",source:{type:"base64",media_type:"application/pdf"}}` —
GA, no beta header) so Claude OCRs it with its own vision (capped ~6 MB; this is
the one path where the file itself is sent, surfaced in the modal status). A **"Notes
for the AI"** box passes free-text steering (who's subcontracting which trade,
timing/sequencing constraints) that is sent as **prioritised INSTRUCTIONS** ahead
of the document in the prompt (`notes` in the POST body; the endpoint accepts a
notes-only draft with no document too). **POST
/prog/ai-draft** (Programmes|FullAccess) calls the **Anthropic Messages API**
(`env.ANTHROPIC_API_KEY` secret; model `env.ANTHROPIC_MODEL` || `claude-sonnet-5`)
with a **forced tool** (`build_programme` input_schema → structured JSON: title,
contractors[], tasks[] with `startOffset` in working-days + `days` + milestone),
then materialises it into a BRAND-NEW `job_programmes` **draft** (contractor names
→ ids + palette colours; `startOffset` → real dates by adding working days to the
chosen start date, default next Monday, weekends skipped) and returns its id →
the page navigates to programme-edit.html?id= so Jamie refines and issues as
normal. **Nothing is issued or shared automatically.** Fails gracefully with a
plain-English message when the secret is missing / the key is rejected / the
model isn't available on the key (tells Jamie exactly what to add in the
dashboard). Pair it with the builder's **"Auto-order"** button (sorts task lines
by start date so a drafted or hand-built list staggers correctly).
**Date-shift tools + AI edit (Aug 2026):** the builder toolbar adds **🗓 Shift
dates** (a modal: move the WHOLE programme to a new start date or by ±N days;
or **move one task to a date and ripple every task starting on/after its
original date** by the same delta, keeping the sequence — pure client-side date
maths, `dParse`/`addDaysISO`/`daysBetween`), a single-level **↩ Undo** (stashes
a JSON snapshot before any shift/AI edit), and an **"✨ Ask AI" edit box** — a
plain-English instruction ("compress into two weeks", "push everything back a
week", "make the M&E take 5 days") POSTed with the current draft to **POST
/prog/ai-edit** (Programmes|FullAccess). That endpoint (shared `anthropicStructured`
helper, forced `revise_programme` tool → full revised programme with absolute
`start` YYYY-MM-DD + working `days` + `wknd`/milestone) returns a complete revised
programme the client adopts into the DRAFT (issued revisions untouched; contractor
COLOURS preserved by matching names to the existing legend). Undo reverts it.
The whole reshaping set (Auto-order, Shift dates, Ask AI, Undo) lives under one
**🛠 Tools** dropdown in the builder toolbar. **Resizable "Works" column:** drag
the handle on the Works header to widen/narrow it; the width is stored on the
programme as **`data.worksW`** (px) and flows through to BOTH exports — progpdf.js
`applyWorksWidth()` scales it to PDF points (230px≈168pt), and programme-export.js
scales it to Excel char-width (230px≈34). `programme-gantt.js?v=5`,
`programme-export.js?v=2`.
**Task text WRAPS everywhere (Aug 2026) — read in full, no truncation:** the Works
column now wraps long task names in all three outputs with VARIABLE row heights.
On screen (`programme-gantt.js?v=6`): the editable name field is a `<textarea>`
(auto-grows to its content; `field-sizing:content` + a JS `sizeTA` fallback), the
read-only `.mlp-actro` wraps, `.mlp-tlin` is `position:absolute;inset:0` so the
timeline fills the taller row, and `.mlp-bar`/`.mlp-dia` are vertically CENTRED
(`top:50%`) so bars line up in wrapped rows. PDF (`lib/progpdf.js`): `wrapLines()`
splits the name to the column width (hard-breaks over-long words, caps at
MAX_NAME_LINES=5 → "..."), each task carries `_lines`+`_h`, and pagination PACKS
rows by cumulative height (`bodyH`) instead of a fixed row count — so wrapped rows
never overflow a page; bars centre with `barTop = ry + (rh-bh)/2`. Excel
(`programme-export.js?v=3`): the Works cell uses a new `wrapText` cellXf and each
task row gets a computed `ht`/`customHeight` (≈15pt × wrapped lines via
`wrapCount`); still values-only (0 formulas, verified with openpyxl). Bump both JS
`?v=` together when touched.
**PDF truncation fix:** progpdf `fitText` now uses ASCII
"..." not "…" (U+2026) — the WinAnsi PDF font has no ellipsis glyph, so it was
rendering as "?" after every truncated task/contractor label.
**Bank holidays + concurrency (v3, `programme-gantt.js?v=4 (v4: pill/bubble bars + table-layout:fixed so short programmes on wide screens can never stretch columns out of line with the bars)`):** the builder
snapshots the Holidays admin's GOV.UK bank-holiday list (app_config
`holiday:bankholidays:<year>`, read across y-1..y+2 by `bankHolidayDates()` in
programmes.js, returned by /prog/one) into **`data.holidays`** — so issued
revisions keep the dates they were planned with and the PUBLIC client page needs
no extra endpoint. End dates skip weekends AND bank holidays (Wknd ticked = works
through both); BH columns are amber-shaded and labelled "BH". **Concurrent-edit
protection:** job_programmes gained `updated_by` (self-migrating); every
/prog/save carries **`baseVersion`** (the updated_at the builder last saw) and a
mismatch returns **409 {conflict, updatedAt, updatedBy}** → the builder pauses
autosave and asks "Load theirs (recommended) / Keep mine" (Keep mine = ONE
unstamped save that deliberately overwrites, then re-stamps). The pagehide
keepalive save also carries baseVersion so closing a stale tab can't clobber.
**PDF export fixes (18 Aug, from a real tender programme Jamie exported):** four
faults, in `lib/progpdf.js` / `lib/pdf.js` —
(a) **pages of empty rows.** Pagination crossed EVERY date window with EVERY
row-chunk, so a page could show the December tasks against the Sept-Nov columns
with a completely blank chart. The page list is now built first, pairing each
window only with the tasks that intersect it (`inWindow`), and a window no task
touches is dropped. A 4-page export became a correct 2-page one.
(b) **"?" in the date range.** `pdfStr` mapped only a few typographic chars and
turned everything else >255 into "?" - the arrow in "(28/09 -> 21/11)" was the
visible one. `lib/pdf.js` now carries a real **WIN1252** map (en/em dash,
ellipsis, curly quotes, bullet, euro, tm) plus an **ASCIIFY** map (arrows,
<=, >=, ticks), exported as **`toWinAnsi()`**; anything still unmappable (emoji,
CJK) is DROPPED rather than printed as "?" - a stray "?" reads as a broken
document to a client. `textWidth()` measures the transliterated string so fits
stay accurate. Supersedes the old fitText "..." workaround.
(c) **legend overlapped the range label** - it reserved a flat 80pt for a label
nearly twice that wide, so the last contractor sat on top of it. The legend now
WRAPS to a second line (headerBlockH 78->89) and reserves the label's measured
width; anything beyond two lines becomes "+N more".
(d) **bars rendered as blobs.** The corner radius was `barHeight/2`, so a 1-day
bar (~8pt wide, 9.5pt tall) came out a circle. The radius is now capped by the
bar's own width. Also: date windows and rows are both split EVENLY (77 days over
2 pages = 39+38, not 71+6; 30 rows = 15+15, not 28+orphan), and a date label that
would spill past the grid's right edge is suppressed.
Regression-tested by rebuilding the programme from the exported PDF and
re-generating (scratchpad `gen.mjs`): 32/32 tasks drawn, zero stray "?", every
page's chart populated. The firestop RIA PDF was smoke-tested too (shared encoder).

**Exports (⬇ PDF / ⬇ Excel, on the builder AND the client share link):** the PDF
is a VECTOR A4-landscape Gantt drawn server-side by **`lib/progpdf.js`**
(`buildProgrammePdf(data, meta)` — never a screenshot; paginates rows AND long
timelines into date windows, weekend/BH shading, contractor bars, milestone
diamonds, legend, watermark+page numbers, `*` = wknd footnote; lib/pdf.js gained
`rect/line/poly` + text `color` for it). Routes: **POST /prog/export** {id,
revId?} (admin — no revId = the DRAFT) and **POST /prog/shared/export** {token,
code} (PUBLIC_ROUTES; latest issued rev, contractor-filtered like /shared/open).
The Excel export is built CLIENT-side by **`programme-export.js?v=1`**
(`window.MLProgXlsx`): a dependency-free stored-ZIP .xlsx writer — VALUES ONLY
(no formulas/macros), "Programme" master sheet + one tab per contractor with
their tasks, coloured X day-cells, weekend/BH shading, frozen panes, sheet+
workbook protection (legacy hash — a deterrent like the original workbook's).
Validated with openpyxl (parse, fills, protection, zero formulas) — NB
LibreOffice is broken in the dev sandbox (loads nothing), that's not a file
problem. progpdf.js is unit-testable in Node (imports only lib/pdf.js). **Mostlane logo** is embedded top-left of the PDF header (lib/logo.js base64 JPEG via doc.image, fail-soft) and shown beside the title on the client share page (programme-view.html /mostlane-logo.jpg).

## Engineer skills & skills-aware scheduling (sla.js + engineer-skills.html — Aug 2026)
A **competency "rock sheet"** so the scheduler can prefer the right engineer for a
job. **Phase 1 (DONE):** managed **areas of work** (app_config `sla_work_areas` =
`[{id,name,colour}]`, GET any session / POST SLA admin — defaults Electrical/
Plumbing/Fabric/Firestopping/Fire alarms/HVAC/Joinery/Decorating/General) + an
**engineer×area star matrix** (app_config `sla_eng_skills` =
`{normId(username):{areaId:1-5}}`, **GET /sla/eng-skills** returns `{skills,areas}`
any session / **POST** SLA admin) + a **`job.workArea`** field (areaId) threaded
through `createOrUpdateJobFromPayload` + `patchJob` (PATCH /sla/jobs/{id} forwards
it; the scheduler quick-modal PUT /job/{id} does not — set it on add-job/editor).
Page **engineer-skills.html** (SLA-admin gated; 🧭 Engineer skills button in the
sla-scheduler header) = editable areas list + a sticky-first-column grid of
tap-to-set 1–5 stars per engineer×area, all autosaving. Star=0 means not competent
(dropped). Field engineers shown by default (StaffType field), "Show all staff"
toggle. Chosen design: **1–5 stars · AI suggests a job's area (office confirms) ·
SOFT preference in suggestions (⚠ flag, never a hard block) · both per-engineer and
whole-team auto-day.**
**Phase 2 (DONE):** **POST /sla/infer-work-area** (Claude classifies a description
→ one work-area id; shared `anthropicTool()` helper) — add-job.html + sla-jobedit.js
(`?v=17`) both have an "Area of work" picker + 🤖 Suggest (add-job auto-suggests once
on description blur if none picked); office confirms.
**Phase 3 (DONE):** the scheduler loads `/sla/eng-skills` and SOFT-weights its fill-in
suggestions — `engStars(user,area)` + `skillAdjust(mins,stars)` shaves ~4 detour-min
per star, so a competent engineer floats up but a much-closer un-rated one still wins;
rows show `★N <area>` or `⚠ not rated` (`skillBadge`). normaliseJob carries `workArea`.
**Phase 4 (DONE) — auto-make-a-day:** **POST /sla/auto-schedule** (SLA admin,
`autoScheduleDay()`) assigns + orders a pool of UNSCHEDULED located jobs across one or
many engineers by skill-weighted cheapest-insertion + per-day capacity (480−lunch),
2-opts each route, returns a per-engineer PREVIEW. **Deterministic — Distance-Matrix/
haversine only, NO Claude, ~0 AI cost** (estimate when >45 points). sla-scheduler.html:
**🤖 Auto day** (header, whole team) + **🪄 Auto-build day** (engineer-day modal, one)
→ #autoBackdrop preview (times + skill badges + unplaced list) → **✓ Apply** PATCHes
each job (assignedEngineers + scheduledAt + durationMinutes). Only ever touches
unscheduled jobs.
**AI usage meter + soft daily cap (DONE):** every paid scheduler AI call bumps
app_config `ai_usage:<yyyy-mm>` (`bumpAiUsage`); a soft **daily** cap (`ai_daily_cap`,
default 400) makes route-optimise/infer fall back to non-AI when hit. **GET/POST
/sla/ai-usage** (SLA admin) reads month/today totals + sets the cap — shown on
engineer-skills.html "📊 AI usage this month". (Programme AI is occasional + NOT yet
metered.)

## Scheduler route optimiser (sla.js `/sla/route-optimize` + sla-scheduler.html — Aug 2026)
Per-engineer **"🧭 Optimise route"** button (in the engineer day-summary modal
`#engDayBackdrop`, alongside 🗺️ Map) that auto-orders that engineer's jobs for a
day into the most efficient **round trip** (home → jobs → home) and previews the
predicted day. **Hybrid — Maps for the facts, Claude for the judgement:**
- **POST /sla/route-optimize** (SLA-admin gated; `isSlaAdmin`). Body `{engineer,
  date, dayStart, lunchMinutes, notes, jobs:[{id,ref,site,priority,durationMinutes,
  lat,lng,postcode}]}`. The CLIENT sends the day's jobs WITH resolved coords (it
  already geocodes postcodes for the map via `coordsFor`); the worker resolves the
  engineer's **home** from `users.profile.homeLat/homeLng` else geocodes
  `profile.homePostcode` (postcodes.io, edge-cached), builds a **Google Distance
  Matrix** driving-time+miles matrix (`driveMatrix`, chunked to the 100-element
  cap; haversine ×1.25 @30mph fallback when `GOOGLE_MAPS_KEY` is unset or the call
  fails — `matrixSource` says which), solves a **nearest-neighbour + 2-opt**
  baseline (`solveRoute`), then calls **Claude** (`anthropicRouteOrder`, forced
  `set_route` tool, `env.ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`) with the matrix +
  the office's plain-English `notes` to RE-ORDER for anomalies ("the Tesco job must
  be at 14:00", "do Southampton last"). AI order is validated as a full permutation
  else the baseline is used; every fallback is surfaced in `warnings`. Returns a
  PREVIEW only — `legs` (per stop: arrivalOffset minutes-from-start, driveMins,
  driveMiles, durationMin), a fixed **lunch** allowance (inserted ~13:00, else after
  the last job), and a **summary** (driveMins, driveMiles round-trip, siteMins,
  lunchMins, dayLengthMins). Times are OFFSETS in minutes — the client owns the
  local wall-clock conversion (it knows the date + start in London time).
- **Apply** writes the new times back: the client builds each `scheduledAt`/
  `scheduledEnd` from date + dayStart + offset and PATCHes each job (nothing is
  written until the office presses ✓ Apply).
- **Per-job expected duration**: a real persisted **`job.durationMinutes`** field
  (create + patch in sla.js) so an UNSCHEDULED job still carries its on-site time
  (the finish time only exists once scheduled). Input on **add-job.html** (allocate
  section) + the shared **sla-jobedit.js** editor (a typed finish time still wins,
  so the picker never fights the finish box). `sla-jobedit.js?v=16`.
- **Engineer home** lives on `users.profile.homePostcode` (+ optional
  `homeLat/homeLng` pin) — edited in **users-admin.html** (postcode field always;
  a "📍 Set on map" Leaflet pin modal, lazy-loaded from unpkg, that overrides the
  postcode). Postcode alone is enough (worker geocodes it); the pin is a fine-tune.
- Uses the **already-present** `GOOGLE_MAPS_KEY` (same key sitelog-api's
  `getTravelData` uses) and the OPTIONAL `ANTHROPIC_API_KEY` (the programme AI's
  key). No new secrets; both fail soft with a clear reason in `warnings`.
- **"Jobs you could work in" + cross-engineer fill-ins (front-end only, ZERO API
  cost):** the whole suggestion engine is **local straight-line geometry** on
  coordinates the page already has — `haversineMiC`/`roadMi` (×1.25) +
  `cheapestInsertion(points, x)` (min added road-miles to slot a job into a
  polyline home→…→home). `loadEngineers` now carries each engineer's home
  (`Profile.homePostcode`/`homeLat`/`homeLng` from GET /users), so every
  engineer's start point is known client-side (`engHomeCoord`, geocoded via the
  same free postcodes.io cache). **Google is NEVER spent on the scan** — only when
  a chosen route is actually (re-)optimised. Two surfaces, both in
  sla-scheduler.html:
  - **Backfill panel** inside the optimiser (`renderBackfill`): after a route, it
    scans every active job NOT already on that day (unscheduled OR same-day; never
    a job booked for another day), ranks by detour into the optimised route,
    filters by a **max-detour slider** (`optThreshold`, default 20 min), and shows
    each with `≈ +Nm · +N mi · <slot>` and an owner flag (**"⚠ currently <name>"**
    if it's another engineer's, **"🆕 unscheduled"** otherwise). Tick some →
    **↻ Re-optimise** folds them in (`optAddedIds`) and the real Google matrix
    runs; **Apply reassigns** each added job to this engineer (`assignedEngineers`
    on the PATCH).
  - **Cross-engineer overview** (💡 Fill-ins button → `#fillBackdrop`): a
    **tick-list of engineers** (auto-ticked when a home is set, disabled + "no home
    set" otherwise), scanned together for the selected date. For each loose job
    (unscheduled, or scheduled that date but NOT on a ticked engineer) it finds the
    **best-fit ticked engineer** by cheapest insertion into their day-route
    (`engRoutePoints`), skipping anyone on leave (`holFor`), and flags the current
    owner. Each suggestion has **✓ Accept** (`acceptFillin` — PATCH
    `assignedEngineers` + schedule onto the day if it had no time; removes just
    that row, NO re-scan), **✕ Reject** (`rejectFillin` — dismiss + remember in
    `fillRejected` for the session), and **👁 View**.
  - **Job-card sub-modal** (`#jobCardBackdrop`, z-index 10001, `openJobCard`):
    View on ANY suggestion (backfill or fill-ins) stacks a read-only job card OVER
    the suggestion modal, rendered from the in-memory `jobs` array (no fetch). ‹
    Back just hides it — **the suggestion list underneath is untouched, so nothing
    re-runs**. This "peek then return without re-scanning" was an explicit
    requirement. "Open full job ↗" links to job-view.html.
  Because empty/near-empty days score a full home round-trip, the detour metric
  naturally prefers engineers already passing by — i.e. "without going out of
  their way". No worker change and no new endpoint — reuses /sla/route-optimize
  (for the re-optimise) and PATCH /sla/jobs/{id} (for assignment).
- **Allocation-time "whilst you're here" pop-up (sla-jobedit.js):** when a job is
  newly allocated to an operative in the **shared editor** (`MLJobEdit`), a
  self-contained pop-up (`#mlnjOverlay`, injected `#mlnj-style`) offers OTHER OPEN
  jobs to batch onto the same person — **same site always** + **within a
  straight-line radius** (default 5 mi, editable inline). Tick + **Assign** PATCHes
  each to that engineer (landing an unscheduled one on the target's day). Data from
  **GET /sla/jobs/nearby?jobId=&engineer=&radius=** (sla.js `nearbyForJob`): same
  site via `siteKeyOf` (project-safe), nearby via `haversineMi` from the target's
  coords (job lat/lon else `geocodePcServer`; others bulk-geocoded via
  `geocodePcBulk`), OPEN statuses only, excludes jobs already the engineer's, top
  12 by distance. Radius default persists in app_config `sla:nearbyRadius` via
  **POST /sla/jobs/nearby-radius** (SLA admin). Trigger = a newly-added engineer on
  save (`openEngineers` diff) AND the scheduler drag —
  `MLJobEdit.suggestNearby(job,eng,cb)` is called from `commitDrop` when a drop
  hands a job to a NEW primary engineer (tray→lane or engineer→engineer; never a
  plain time move). **Cross-engineer:** the scan includes OPEN jobs currently with
  OTHER engineers (flagged "currently <name>") + unassigned ones — only the target
  engineer's own are excluded. **Assigning keeps the pop-up open** with remaining
  same-site/nearby rows so a second nearby job stays flagged. **After accepting,
  closing the pop-up calls `window.mlOptimiseEngineerDay(username,name,date)` when
  present (the scheduler exposes it) → opens the route optimiser for that
  engineer's day and auto-runs the preview, so the newly-added stops get sequenced
  (office reviews → Apply). On sla-main (no optimiser on the page) the jobs are
  just added to the day.** No pop-up when nothing is same-site or in range.
  `sla-jobedit.js?v=19`.

## Firestopping / RIA form (sla.js `/sla/firestop/*` + firestop-form.js + firestop-admin.html — Aug 2026)
A **fire-stopping job** produces a "Record of Installation Activities" (RIA) PDF
from the engineer's per-seal photos + a signed declaration, bundled with the
product spec sheets for the materials used. **Tickable when raising a job**:
add-job.html "🔥 Firestopping job" → `job.firestopping` (patchJob accepts it;
ticking it sends requiresRA/Sig/Photo/Note=false — the RIA record IS the
completion). **Completion gate:** `completionMissing()` short-circuits to
`firestopMissing()` for firestopping jobs — needs ≥1 seal with before+after
photos + a signed declaration (NOT the standard note/photo/signature).
- **Record** lives on `job.firestop` = {ref, dateOfIssue, company, installer,
  siteAddress, sealCategory, declaration, signatureKey, seals:[{id, location,
  aperture, frp, manufacturer, componentName, comments, productIds[],
  beforePhotos:[{key,url}], afterPhotos[]}]}. Photos in R2
  `firestop/<tid>/<jobId>/<sealId>/<stage>-<ts>.jpg`; signature is sealId `_sig`.
- **Config + materials** in app_config (`firestop_config` = company/sealCategory/
  declaration/**nextRef** auto-sequence; `firestop_materials` = preset products
  {id,manufacturer,name,category,docs:[{id,name,key}]}). Spec docs in R2
  `firestopspec/<tid>/<productId>/`. RIA number auto-assigned from nextRef on
  first save (padded to 5 digits, e.g. 00161), manual override honoured.
- **Endpoints** (all `/sla/firestop/*`): config GET/POST (POST=SLA admin),
  materials GET (session)/POST (admin), material-doc POST + material-doc-delete
  (admin, R2), spec-file + photo-file GET (session OR signed), record GET
  (returns record + header defaults + presets)/POST (saves `job.firestop`,
  assigns ref), photo POST (multipart)/photo-delete, **pdf** GET (lib/firestoppdf.js
  → application/pdf), **bundle** GET (lib/zip.js → ZIP: "RIA form N.pdf" at top +
  "Product specification/" subfolder of each used product's docs).
- **lib/firestoppdf.js** builds the RIA layout (header grid, declaration +
  embedded signature, one bordered block per seal with fields + before/after
  photo thumbnails, page numbers) via lib/pdf.js (JPEG images). **lib/zip.js** =
  dependency-free STORED-zip writer (CRC32, folder paths in entry names) — no
  Node zlib, WebCrypto-only. Both validated in Node (PDF opens, `unzip -t` OK).
- **Front-end:** **firestop-form.js** = shared `window.MLFirestop.mount(el,{jobId,
  mode:"engineer"|"office",api,token,patchComplete,onComplete})` — the whole RIA
  UI (header, seals, product chips that autofill manufacturer/name, per-seal
  before/after camera photos client-shrunk to JPEG, signature pad, autosave,
  ⬇PDF/⬇Bundle, engineer "✅ Complete" that validates then PATCHes Complete).
  **engineer-job.html** mounts it for firestopping jobs (replaces the standard
  photo/note/signature/slider; status grid trimmed to Travelling/In Progress;
  the photo/refresh/applyLock helpers are null-guarded). **job-view.html** mounts
  it read-only + downloads. **firestop-admin.html** (🔥 Firestopping button on
  sla-main, SLA-admin) manages config + products + spec-doc uploads.

## Projects (routes/projects-api.js + project-new.html / projects-live.html / project-hub.html — Aug 2026)
A **first-class project record** that is the SPINE linking a job together — before
this, programmes/RAMS/costing joined only by loose name strings. Permission
**Projects** (viewer) / **ProjectsAdmin|FullAccess** (manage); the "Projects"
tile + sidebar now open **projects-live.html** (the old external
`projects-ml-portal` doc-repo is absorbed — projects.html/projects-admin.html are
redirect stubs to projects-live; existing external docs were NOT migrated).
- **Tables (self-migrating):** `projects` (id PRJ-…, number=P-number, name,
  site_client/site_number = its own project-site, status live|complete|archived,
  `data` JSON) + `project_files` (docs in R2 JOB_FILES `projectdocs/<tid>/<pid>/`).
  `data` JSON holds: postcode/lat/lon, mileageRoundTrip/OneWay, fromExisting,
  required{programme,rams,cpp,valuations,projectDocs}, sitelog{rules,visitorRules,
  companies[]}, contractValue, links{programmeId,ramsIds[],cppRef,costingKey},
  doneOverride{}. **costingKey = normName(project name)** — the SAME key costing
  uses, so PO/labour/valuations roll up automatically.
- **Wizard (project-new.html)** — 4 steps: **1** site (existing → search+copy
  coords, or new) + **always creates its own Pxxxx project-site** via `/add-site?
  category=projects` (auto P-number, pushes the SiteLog geofence, PO picks it up
  via its add-only mirror) + confirm/drop coords (Leaflet, postcodes.io geocode) +
  **round-trip mileage** computed client-side (haversine ×1.25×2 from HQ PO15 5RQ,
  saved to site_miles) + name/number; **2** required-docs tick-box; **3** SiteLog
  message (→ site_rules) + companies-on-site (pick from PO `/po/api/subcontractors`
  + free add); **4** review → POST **/project/create** → project-hub.
- **project-hub.html** — the everything-page: summary, **To-Do** (auto-ticks off
  the links + presence; manual tick via /project/todo), build actions
  **UNIFIED doc-attach (Aug 2026): every required document offers the same three
  routes via one "📎 Add / link" button (admin-only, `data-docpick`) opening a
  GENERIC picker (`#docPick`, config `DOCTYPES`): (1) BUILD in the portal, (2)
  LINK an existing portal record, (3) UPLOAD/attach a file.** Per type —
  **Programme**: build = POST /prog/save → programme-edit; link existing = GET
  /prog/list (single-select → `data.links.programmeId`, POST /project/link
  `kind:"programme"`). **RAMS**: build = `hs-docs.html?newRams=1&site=&project=`;
  link existing = GET /hs/docs?type=rams (multi-tick → `data.links.ramsIds[]`,
  `kind:"rams"`/`"rams-remove"`). **CPP**: build = the hs-plan planner (no portal
  CPP records, so no "link existing"). **File attach is generic for ALL types**:
  the picker uploads (POST /project/doc, section = the doc-type label → returns
  the file id) or ticks an existing project document, linked via POST
  /project/link **`kind:"doc-file"`/`"doc-file-remove"` with `docKey`** into
  **`data.links.docFiles[key][]`** (`normLinks()` guarantees the map + migrates
  legacy `cppFiles`→`docFiles.cpp`; `cpp-file`/`cpp-file-remove` kept as aliases).
  A required doc's to-do auto-ticks on its portal link OR `docFiles[key].length`;
  /project/doc-delete strips a deleted id from every `docFiles[*]`. Linked
  records + files show as pills per to-do row (`loadDocRefs`, open in docviewer).
  **Uploaded files are project_files, so they already surface to engineers in
  Site Documents** (the `/sla/site/docs` "Project Documents" injection) on the
  site-folder AND on portal jobs — portal-built RAMS/programmes are rendered
  documents, not stored files, so only their attached-file form appears there.
  **Valuations**: sets proj_fin value),
  **Project Documents** (drag-drop upload, hide/show, delete; engineers with
  Projects perm see non-hidden), **SiteLog** (edit rules+companies, re-applied to
  the geofence), **Job costing** (GET /costing/summary?site=<name> → labour+PO+
  valuations for FullAccess/costing perm; silently omitted otherwise), and
  **Required-docs editor** (add/remove later).
- **Projects compliance chart (Aug 2026):** a third compliance scheme
  **`projects`** joins `coop` + `fareham`. Types: **elec** (Electrical
  Certificate, 5y), **gas** (Gas Safety, 1y), **bldg** (Building Control, 10y),
  plus **other** for drawings + everything else. Wired end-to-end:
  - `SCHEME_DEFAULTS.projects` + TYPE_LABELS + KNOWN_TYPES + `canonType` all
    recognise the new keys.
  - `/project/create` inserts a `compliance_stores` row (`scheme='projects'`,
    `code=<Pxxxx>`, `site_number=<Pxxxx>`) so every project appears on the
    chart from day one.
  - `/compliance/stores?scheme=projects` self-heals: any live/complete project
    without a compliance row is INSERT-OR-IGNORE'd on GET, backfilling anything
    the create hook missed.
  - `/project/delete` cascades to compliance_files (R2 + DB) and compliance_stores.
  - Archive cascade already carries: project.status=archived → Pxxxx site inactive
    → syncSiteToCompliance sets `compliance_stores.active=0` → project appears in
    the chart's Closed Sites view.
  - **compliance-projects.html** (new page, copied from fareham.html and
    adapted): `SCHEME='projects'`, columns Electrical/Gas/Building Control,
    "Add site" replaced with a redirect to the Projects wizard (this chart is
    read-only for project creation — the projects area owns it).
  - **compliance.html** landing page now offers Projects alongside Southern
    Co-op and Fareham.
- **Centralisation pass (Aug 2026):** the portal now propagates edits between
  its parallel stores so one source of truth stays in step.
  - **Sites → SiteLog** is now UPSERT (not add-only): `sitelog-api.js`
    `/upsert-site` and `/delete-site` accept a name+coord change (or an
    `oldName` for rename). `sites.js syncSiteToSiteLog(site, oldName?)` fires on
    every /add-site + /update-site, and `removeSiteFromSiteLog` (soft-archive)
    fires on /delete-site — postcode/coord/rename edits and deletes propagate
    to the geofence instead of being silently ignored.
  - **Projects cascade on rename + delete:** `/project/update` — when the name
    changes — renames the Pxxxx `sites` row, calls **`renameSiteInPO`** (which
    also rewrites historical `po_log.site` so costing rolls up onto the new
    name), fires `syncSiteToSiteLog(oldName)` and re-applies the arrival
    rules, and calls **`renameProjFinKey`** so the contract-value carries
    across. `/project/delete` cascades to project_files (R2), project_costs,
    the Pxxxx `sites` row, `proj_fin` (`deleteProjFinKey`), soft-delete on
    PO's site (active=0 keeps historical po_log rows), soft-archive on the
    SiteLog geofence, and nulls out `job.projectId` on any linked SLA jobs
    (jobs are kept). Response returns `cascaded` for visibility.
  - **Contract value: single writer.** `costing.js` exports
    **`writeProjFin(env,tid,key,{value,planned,name})`** (+ `renameProjFinKey`
    / `deleteProjFinKey`). Both `/costing/fin` and `/project/update` now go
    through it, so the two pages share ONE code path (no drift, null clears).
  - **Compliance PDFs on Site Documents.** `/sla/site/docs` GET now injects
    a **"Compliance Certificates"** area for any site that matches a
    compliance store (by `site_number` OR the compliance `code`). Files stream
    via signed `/compliance/file` URLs. Each row carries `complianceDoc:true`
    and site-folder.html shows a "· from compliance chart" hint + hides
    Delete (managed on the chart).
  - **Compliance ↔ Sites bidirectional edits.** `/store` name/postcode edits
    cascade to the linked `sites` row (`site_name` + `postcode` + `data`).
    `/store-meta` lat/lng edits cascade to `sites.data.lat/lng` AND fire
    `syncSiteToSiteLog` so the SiteLog geofence moves too. In reverse,
    `sites.js /update-site` mirrors name / postcode / lat / lng into any
    linked `compliance_stores` row via **`syncSiteToCompliance`** — so an
    admin can edit in either place and the other tracks.
  - **sitelog_scans fallback.** `buildDay` (costing.js) now falls back to
    live `SITELOG_DB.visits` when the local `sitelog_scans` mirror has no
    rows for the day — exceptions/mismatch detection keeps working even if
    the HMAC bridge is dark, so `/costing/summary` £s and `/exceptions`
    stay consistent.
- **Project docs surface as "Site Documents" (Aug 2026):** the SLA
  **`/sla/site/docs`** GET now injects a **"Project Documents"** area whenever
  the requested siteCode matches a portal project's number
  (`SELECT id FROM projects WHERE number=? OR site_number=?`). Files come from
  `project_files` (non-hidden only) with a signed URL pointing at
  `/project/doc` (CORS-enabled, PUBLIC_ROUTES sig-verified). Effect:
  **site-folder.html** shows the project's docs as a first tab, and
  **engineer-job.html** — whose "Site documents" button navigates to
  site-folder — surfaces them too. A `projectDoc:true` marker on each row makes
  site-folder show a "· from project" hint and HIDE the Delete button (project
  docs are managed on the project hub). Also: **project-hub.html's doc opener
  was fixed** — it was calling `MLDocViewer.open(url, name)` (positional)
  instead of the object form docviewer expects, so the modal never sniffed the
  PDF; now passes `{url,fetchUrl,name,downloadUrl}` so PDFs render inline.
  **"🔄 Sync to PO" button** added to the P&L card header — a one-tap admin
  backfill (`POST /project/push-po`) for projects created before the auto-push
  landed (SCF Furniture). The hub also opportunistically re-runs pushSiteToPO
  on every /project/get, so opening a project once is enough.
- **Auto-push project site to PO + manual labour/materials + P&L (Aug 2026):**
  Creating a project now **auto-registers its site name in the PO system's
  `sites` table** (env.PO_DB) via `pushSiteToPO()` (add-only, idempotent), so a
  PO raised for the project can pick it — and once priced, its cost automatically
  appears against the project in job-costing (costing.js already matches
  `po_log.site` by name). Existing projects self-heal on the next
  /project/get, and there's a **POST /project/push-po** admin backfill (called
  from a hub button when needed). NEW table **`project_costs`** (self-migrating)
  + endpoints: **GET /project/costs**, **POST /project/cost** (kind=labour → the
  hours are auto-costed from the engineer's `engts:cfg` rate — an explicit
  override in £/hr wins; kind=material → £ ex-VAT + supplier), **POST
  /project/cost-delete**. Manual entries are folded into `/costing/summary` for
  the project's site: labour → `s.cost` + per-engineer + `s.manualLabour`;
  materials → `s.poTotal` + `s.manualMaterials` + a supplier row (default
  "Manual entry"). Front-end (project-hub.html "💷 Job costing & P&L" card):
  clear headline (Contract value · Total cost · Projected profit/loss · Margin
  %; green/red by sign), a 4-line **breakdown** (Captured labour · Manual
  labour · PO materials · Manual materials), the People + Suppliers rows as
  before, and two admin-only mini-forms: **Log a labour shift** (engineer +
  date + hours + optional rate override + note) and **Add a material cost**
  (date + description + supplier + £ ex-VAT). Every manual entry lists below
  with a delete button. `ratesMap` is now exported from costing.js so
  projects-api.js can snapshot the rate at entry time.
- **Jobs & site visits from the project (Aug 2026):** every SLA job now carries
  an optional **`job.projectId`** (`createOrUpdateJobFromPayload` + `patchJob`
  accept + preserve it); a job raised from a project is stamped with the
  project's id so the project can list its jobs and roll up per-engineer visits.
  New endpoints on projects-api.js:
  **POST /project/create-job** `{id, description, engineers[], scheduledAt?,
  durationMinutes?}` (ProjectsAdmin|FullAccess) — creates a **multi-engineer**
  SLA job in one shot, prefilled from the project's own Pxxxx site
  (address/postcode/coords), gates all four requirements OFF by default (the
  Projects rule) and stamps `projectId`; runs through the normal SLA path
  (`createOrUpdateJobFromPayload` + `reconcileRelease` → assignment push).
  **GET /project/visits?id=<PID>** — returns `{jobs, visits, perUser}`.
  Matches jobs by `projectId` first, else by the project's site name/number
  (legacy jobs). Each visit is one (user, day, job) row aggregated from
  **`job_time_segments`** (status-tap timing — works whether the site is
  scanned via SiteLog or not, per Jamie's spec). **Non-manager viewers see only
  their OWN visits** (case-insensitive + normId match); **admins see all + a
  `perUser` summary** (days · visits · on-site + travel mins). Front-end:
  project-hub.html "🛠 Jobs & site visits" card — admin gets a "Create a job"
  mini-form (description + Start/duration + a filtered engineer tick-list,
  field engineers first) that POSTs /project/create-job; underneath, every
  project job (link → job-view) + visits list (grouped by day, "LIVE" chip on
  open segments) + per-engineer summary with a "open in Job Costing →"
  shortcut. The seeded project row on /costing/summary now automatically
  reflects those visits' cost (labour ledger already reads
  job_time_segments).
- **Project ↔ Job Costing deep-link (Aug 2026):** every live/complete portal
  project is now **seeded into `/costing/summary`** even at £0 — so a brand-new
  project appears on **job-costing.html** the moment it's created, ready for the
  admin to set its contract value + valuations. The seeded row goes through
  `resolveSite`, so once real labour/PO activity lands, it merges into the same
  row (no duplicate). Returned rows carry a `project:{id,number}` field when the
  site IS a portal project; job-costing shows a **📁 PROJECT Pxxxx chip** on
  those cards. The project-hub.html "💷 Job costing" card + the To-Do row's
  "View valuations" button + the "Manage valuations →" link all target
  **`/job-costing.html?project=<id>&site=<name>&back=hub`**; job-costing.html
  reads those params, defaults to **All time** so a new project is always
  visible, auto-expands + scrolls to that site card, and rewrites its **‹ Back**
  to `/project-hub.html?id=<id>`. The site is matched by `project.id` first (so a
  renamed project still resolves), else by key/name.
- **Per-project visibility (Aug 2026):** `data.visibleTo` = array of usernames.
  Empty/missing = visible to **everyone with the Projects permission** (default).
  Non-empty = only those usernames see it in **projects-live.html** / can open
  its **project-hub.html**. **FullAccess|ProjectsAdmin always see every project**
  regardless of the list (they manage). Enforced server-side in projects-api.js
  `canSeeProject(data, me, canManage)` on both **GET /projects/list** (filter)
  and **GET /project/get** (404 to a non-viewer, so a direct link can't leak).
  UI: **project-new.html** step 2 has a "👥 Who can see this project?" section
  (radio: everyone / only-picked → checkbox list of active users, searchable);
  **project-hub.html** shows a matching **👥 Who can see this project** card
  (admins only — same UI) saving via **POST /project/update** `{visibleTo:[…]}`.
  Case-insensitive match; `sanitiseVisible` dedupes/caps 200.
- **Endpoints (routes/projects-api.js, mounted /project + /projects):** GET
  /projects/list, GET /project/get, POST /project/create|update|link|todo|delete
  (manage=ProjectsAdmin|FullAccess), GET /project/docs, POST /project/doc (multipart)
  |doc-update|doc-delete, GET **/project/doc** (PUBLIC_ROUTES, sig-verified R2
  stream). **Valuations reuse costing's `proj_fin`** (keyed by costingKey) — nothing
  new to learn on the costing side. SiteLog rules applied via `applySiteLogRules`
  (in-process sitelogApi.handle when SITELOG_DB, else remote, best-effort). The
  wizard front-end orchestrates the /add-site call (D1) so the P-number + geofence
  come from the existing sites path.

## Home hub / dashboard (main.html — Aug 2026, extensible)
The home page (`#hubDash` / `#hubGrid` on main.html) shows a **permission-gated
set of at-a-glance widgets** — the start of "the hub of everything" (each user
sees only the areas they have permission for). It's separate from the blocking
attention gate: the hub is a persistent dashboard, not a snooze-able popup.
Renders on BOTH mobile (above the tiles) and desktop (below the greeting); white
cards so it's legible over any personalised background. **Framework:**
`window.MostlaneHub` — `HUB.register({id,emoji,title,can(perms),load(card),wide?})`
then `HUB.run(perms)` (reads the cached `mostlanePermissions` blob, instant, no
network wait). A widget filtered out by `can(perms)` never renders; if NO widget
is eligible the whole `#hubDash` stays hidden. **Areas of responsibility
(personalised home):** each office user has `profile.areas` (a set of area
domain keys — set in Users Admin's "🏠 Responsible for" picker, saved via the
normal user save; also a dedicated POST /users/set-areas + GET /users/areas-meta
exist). `/auth/me` + `/users` return `Areas`. `HUB.run` fetches `/auth/me` (via
`boot`) for the authoritative `Areas`; when non-empty the dashboard shows **only**
widgets whose `area` matches (My tasks `always:true` + the overview `first` always
show; the overview's KPI strip is area-filtered too). Empty `areas` → falls back
to permission-gating (every area they can access). Each widget carries an `area`
domain key (vehicles/sla/holidays/equipment/compliance/purchaseorders/memos/
timesheets/messages), matching users.js `USER_AREAS`. **Positive "all up to date"
state:** a clear widget (a `cardHtml` with a `✓` line and no amber/red — it drops
a hidden `[data-clear]` marker; the custom-HTML van-check + overview widgets add
their own) gets a green `.clear` card; when EVERY shown card is clear, the
`#hubAllClear` "🎉 You're all caught up" banner shows + the overview greens.
**The whole dashboard is
office/admin only** — `HUB.run` bails immediately for field engineers
(`isFieldUser(perms)`: StaffType field, or the SLA/Story heuristic when blank —
mirrors applyGate), so field users never see ANY stat regardless of a widget's
own `can`. Each `load()` fetches its own data
(via a timeout-raced `jfetch`, since API calls bypass the SW) and fills its card;
a throwing/timed-out widget removes its own card. **DESKTOP ONLY** (CSS: shown via
`.hub-on` under `@media(min-width:1000px) body.pnav-on`, same condition as the
greeting card) — mobile keeps the tiles + attention gate as its home. Shared
render helpers `cardHtml({emoji,title,when,big,sub,tone,ok,rows,actions})`,
`metric(label,n,tone)`, `act(href,label,primary)`, `daysUntil(YYYY-MM-DD)`.
**Add a new area** = one `HUB.register({id,emoji,title,can,load})` call. A
`first:true` widget sorts to the top; `wide:true` spans both columns; `cls`
adds a card class. **Shared fetch cache `jget(path)`** memoises GETs so the
overview strip and a detail card reading the same endpoint fetch it ONCE
(verified: PO dashboard hit once for both its KPI + card). Reads perms via
`readPerms()` (cached blob).
**Overview card ("How are we doing", `first`+`wide`+`cls:"overview"`):** a
KPI strip at the top — one clickable headline number per area the user can see
(`kpiSpecs(perms)`): open SLA jobs (·N overdue), van checks due, vans to attend,
jobs to schedule, POs to price, holidays to approve, certs overdue, memos
unsigned, unread messages. Tiles render progressively (fixed-order slots) and
reuse the detail cards' fetches; a slow/failed area just drops its tile.
Current detail widgets (each permission-gated):
  - **Van checks** (FullAccess|Vehicles): GET /vancheck/week → done/N progress
    bar, outstanding chips, red defect/alert rows, "⏸ Reminders paused" pill,
    **Open van checks** + **🔔 Remind now** (POST /vancheck/remind-now).
  - **Fleet** (FullAccess|Vehicles): GET /fleet/vehicles → count of vans with MOT
    /tax due-or-overdue (`daysUntil` <0 / ≤30), service warn/bad, pending handovers.
  - **SLA jobs** (FullAccess|SLA|SLAAdmin): GET /sla/jobs → open (status not
    complete/closed/done), needs-scheduling (no `scheduledAt`), overdue
    (`sla.state==="BREACHED"`), unassigned. Open board + Scheduler.
  - **Holidays** (FullAccess|HolidayAdmin): GET /holiday/all?year= → Pending +
    staff self-cancellations. Open holiday admin.
  - **Equipment** (FullAccess|AssetAdmin): GET /asset/requests/attention →
    toAction + decided. Open requests + My equipment.
  - **Compliance** (FullAccess|Compliance): GET /compliance/stores → certs overdue
    / due within 30 days (per-type `due` dates). Open compliance.
  - **Purchase orders** (FullAccess|PurchaseOrders): GET /po/api/dashboard →
    uncosted (to price) + needs_review/flagged/credit_due/unmatched_site. Open
    PO system (po-office.html).
  - **Company memos** (FullAccess): GET /memos/list → sent memos with
    signed<total (per-memo signed/total rows). Open memos (notification-centre).
  - **Engineer timesheets** (FullAccess|TimesheetAdmin): GET /ts/admin/overview →
    invoices to process + timesheets started this week. Open timesheets-admin.
  - **Messages** (StaffType≠field): GET /messages/unread → unread count; action
    clicks the chat bubble launcher (#mlchat-launch) rather than a page.
  - **My tasks** (ALWAYS shown, `can:()=>true`): GET /tasks/attention → outstanding
    (+ overdue red). Also an overview KPI (always present). Open my-tasks.html.
Help + CLAUDE.md must list new widgets as they're added.

## Admin task list (routes/tasks.js + my-tasks.html + tasks-admin.html)
Recurring jobs a **Full-Access** user sets for staff, with a deadline day/time,
surfaced as a home-page stat (always shown, even at zero) and auto-ticked when
the person does the linked portal action. Tables (self-migrating): **admin_tasks**
(defs: title, detail, assignees JSON, recurrence, due_time/due_dow/due_dom/
due_month/due_date, area, auto_match, active) + **admin_task_done** (manual
completions, PK task_id+username+period_key). **Recurrence**: daily/weekly/
monthly/quarterly/yearly/once; `occurrence(task,now)` computes the current
period key + London-wall-clock deadline instant + period start (DOM capped at 28).
**Multiple assignees** per task; each ticks their own occurrence. **Auto-complete
(computed live, no stored state)**: a task's `area` (a permission key from
`TASK_AREAS`) carries a default audit-path fragment (`auto_match`, e.g. Vehicles →
`/vancheck/submit`); `autoDone()` checks audit_log for a successful entry by that
user matching the fragment since the period start → counts as done. **Access
flagging + grant**: /tasks/admin returns each assignee's `hasAccess` for the
task's linked area; tasks-admin.html shows "⚠ no <area> access" + a **Grant
access** button → POST /tasks/grant sets user_permissions=Yes (note: user must
re-login). Routes: GET /tasks/mine, GET /tasks/attention (hub), POST
/tasks/complete {id,undo}, GET /tasks/admin (Full), POST /tasks/save (Full),
POST /tasks/delete (Full), POST /tasks/grant (Full), GET /tasks/meta (Full).
**Daily push reminder**: `sweepTaskReminders(env)` on the 5-min cron self-gates to
~08:00 London, deduped per day (app_config `tasks:reminded:<tid>`), pushes each
user with outstanding tasks. Menu tile **✅ My Tasks** (always visible, like Help)
→ my-tasks.html; admin manages from its "🗂 Manage tasks" button (Full-Access).

## Notifications system
- **🔄 Hard refresh (Aug 2026)** — portal-config `hardRefresh()` gives users
  the closest thing to Ctrl+Shift+R without leaving the app: deletes every Cache
  Storage cache, `registration.update()`s the service worker, re-fetches the
  core shell (portal-config/portal.css/auth/device-auth + current page) with
  `{cache:"reload"}` to punch through the browser HTTP cache, then reloads.
  **How it's triggered depends on the device** — `window.matchMedia("(pointer:coarse)")`
  splits them: touch devices (mobile/PWA) get **pull-to-refresh** (drag DOWN
  ≥80px at the top of the page → blue banner "↓ Pull to refresh" → "↻ Release
  to refresh" → same routine on release; 60% resistance, HTML gets
  `overscroll-behavior-y:contain` to stop Chromium's own soft reload fighting
  the gesture); desktops keep the small fixed **🔄 button** BOTTOM-LEFT (so it
  never covers a ‹ Back link or a full-screen photo's ✕; lifted above the
  field-app `.tabbar` when present; `env(safe-area-inset-bottom)`-aware). Skipped
  on the same set of pages (auth/sign/my-day/programme-view). Same underlying
  `doHardRefresh()` for both. The user-facing cure for "my phone is stuck on an
  old version" — no button-hunting required on mobile.
- **Notification bell / feed (Aug 2026)** — a Facebook-style 🔔 injected by
  portal-config.js (`notifBell()`, fixed top-right, `#mlBell`). **It lives ONLY
  on main.html (Aug 2026)** — it used to float top-right on EVERY page and
  covered full-screen photo/doc close (✕) buttons in the field app; the same
  applies to the 💬 chat bubble (`chatWidget()` also gated to main.html only).
  A durable per-user history of every notification:
  each event that fires a push is ALSO written to a feed row, so the bell is
  complete even if the phone never enabled push. **Mechanism:** `push.js
  sendToUser()` calls **`recordNotification(env,tid,user,{title,body,url,tag})`**
  FIRST (before the VAPID/subscription early-returns), writing to table
  **user_notifications** (self-migrating; id/tenant/username/title/body/url/tag/
  created_at/read_at; capped to newest 120/user). `sendToPermission` fans out →
  one row per recipient automatically. **Chat messages are EXCLUDED** (tag
  `msg:`/`grp:` skipped — they have the 💬 chat-widget bell). Each feed item links
  to its push `url` (the job, the signed memo, the holiday, the van score…) so
  clicking takes the user straight to the thing. Routes (portal.js, any session,
  own rows only; audit-skipped): **GET /notify/feed?limit=** (items + unread),
  **GET /notify/feed/count** (cheap badge poll, every 45s), **POST
  /notify/feed/read** `{id}` or `{all:true}`. Opening the panel marks all read
  (clears the red badge); a "Mark all read" button too. Icons derived client-side
  from tag/url/title (`iconFor`). NB the bell is the read-back history; the
  blocking attention gate + red tile badges are unchanged and separate.
  **Actionable alerts — stay outstanding until DEALT WITH (Aug 2026):**
  `user_notifications` gained **`actionable`** (0/1) + **`resolved_at`**. An alert
  sent with `actionable:true` (per-item tag) stays OUTSTANDING for every recipient
  — bold + amber "Needs action", always counted, NOT cleared by opening/clicking —
  until the underlying item is dealt with. **Outstanding = `resolved_at IS NULL AND
  (actionable=1 OR seen_at IS NULL)`** (portal.js feed/count + feed). On resolution,
  **`push.js resolveNotificationsByTag(env,tid,tag,{title,body})`** stamps resolved_at
  + read + seen on EVERY recipient's row AND rewrites it to the outcome ("Dave's
  holiday — ✅ approved by Jamie"), so it drops off everyone's outstanding list and
  sits read in each log. (`markNotificationsReadByTag` is now a thin wrapper.) Wired:
  on-hold (`hold-approve:<jobId>`), holiday (`holiday-admin:<id>`), transfers
  (`asset-transfer:<reqId>`); the actor's own follow-up notice uses a DIFFERENT tag
  (`hold-decided`/`holiday-decision`) so it's untouched. Client: portal-config bell
  renders outstanding items amber, opening never dismisses them, the badge = count
  of still-outstanding actionable items (openPanel + Mark-all-read both respect it).
  **Re-reminders (cron, push-only via `remindUser`/`remindPermission` — no new feed
  rows):** on-hold chased **every ~10 min** (`sla.remindPendingHolds`, gated
  `minute%10<5`); holiday + transfer chased **daily ~08:00 London**
  (`holidays.remindPendingHolidays` + `assets.remindPendingTransfers`, deduped via
  app_config `approvals:dailyReminded:1`). To extend: send with a per-item tag +
  `actionable:true`, resolve with an outcome, and add a reminder sweep.
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
  enforced). **The weekly van-check note is TIME-gated, not count-gated**
  (`timeGated:true` + `snoozeUntil` = van-check `dueAt` − 2h): the driver can
  keep snoozing right up to 2h before the deadline however many times, then it's
  enforced; each snooze is capped (`dueMs`) so it can't bury the reminder past
  the deadline, and an OVERDUE check (`snoozeUntil:0`) is never snoozable.
  `itemCanSnooze(i,now)` is the shared rule. Every shown/snoozed/opened/dismissed is POSTed to
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
each action shows a plain-English label **+ its subject inline** (from the detail,
e.g. "Updated a site — **0125 Lee-On Solent**") **+ "on <Page>"** (from `ref`) and a
humanised detail line (`niceDetail`/`DKEY`: `reg=`→"Vehicle", `cost=`→"£"…).
**Every message is CLICKABLE** (`linkFor`): to the page it was fired from (`ref`)
else an action→page map — so you can jump straight to the thing that changed.
**Before → after notes:** a handler can attach an **`X-Audit-Note`** response header
(URI-encoded) with a ready-made human line; index.js's audit middleware stores it
verbatim as `detail` (in preference to the raw body fields). Wired into
**`/update-site`** so a rename logs `0125 Lee-On Solent — name "0125 Lee-on-Solent"
→ "0125 Lee-On Solent"` (compares the merged-over old row; also covers number/
postcode/address/phone/contact). `niceDetail` passes any `→` fragment through as-is.
**Burst grouping:** consecutive events by the SAME user with the SAME friendly
action (views grouped per-user) collapse into ONE expandable `<details>` group once
a run hits **3+** (e.g. "📍 Updated a site × 200"), with a time span — so one busy
user updating hundreds of sites never buries everyone else; short runs stay inline.
Failed actions flagged red. Linked from Users Admin + Device Management top bar —
deliberately NO menu tile. 12-month retention. **To add before→after to another
endpoint:** set the `X-Audit-Note` header on its response (see sites.js update-site).

## Portal health watchdog + AI code review (Aug 2026)
Two automatic, always-on quality checks — one for the LIVE system, one for the CODE.
- **Live watchdog** (`routes/health.js` + `health.html`, 🩺 tile + sidebar, `__fullOnly`).
  Folded into the existing 5-min cron — NO separate worker. Three signals:
  (1) **Synthetic probes** every tick (`runHealthChecks`): D1 `SELECT 1`, core tables
  (users/sla_jobs/sites/vehicles/app_config counts), R2 JOB_FILES + ASSET_BUCKET
  `.list`, and optional PO_DB / SITELOG_DB — each timed. Latest snapshot stored in
  app_config `health:lastrun:<tid>`. (2) **Real 500 capture**: index.js's top-level
  `catch` calls `health.recordEvent(kind:'error')` for every server error a user hits.
  (3) **Slow-response capture**: index.js times every request and records
  `kind:'slow'` when a response exceeds `SLOW_MS` (2500ms; /health/* excluded so the
  dashboard's own polling can't pollute it). Table **health_events** (self-migrating,
  pruned ~30 days; the ONLY new D1 table). **Alerts**: `maybeAlert` pushes the owner
  (`OWNER_USERNAME`) via `sendToUser` when a probe fails OR ≥8 errors land in 15 min —
  deduped per problem-signature to once/hour so a 5-min cron is never a siren. Routes
  (FullAccess): GET /health/status (dashboard: probe snapshot + error/slow aggregates
  24h/7d + top error/slow endpoints + recent events), GET /health/events, POST
  /health/run (manual re-probe). health.html auto-refreshes every 60s. NB the bare
  `/health` liveness JSON in index.js is unchanged — the routes are under `/health/`.
  **To watch a new dependency**: add a probe to `probeList()`. **To flag a new event
  kind**: call `recordEvent` from the relevant handler.
- **AI code review** (`.github/workflows/ai-code-review.yml` + `tools/ai-code-review/
  review.mjs`) — a GitHub Action (NOT the worker: a worker can't read its own source).
  Runs nightly (02:00 UTC, last-day changes), on every push to `main` (that push's
  diff), and on-demand (Actions → Run workflow, recent|full). Dependency-free Node:
  raw fetch to the Anthropic Messages API (model `claude-opus-5`, override with repo
  var `ANTHROPIC_MODEL=claude-sonnet-5` to cut cost) reviews changed source (capped 30
  files / 260 KB) for correctness bugs / efficiency / missing auth, returns JSON
  findings, and opens a GitHub issue (label `ai-code-review`) when it finds something
  (manual runs always open one). **Setup Jamie must do once**: add repo secret
  `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions) — GitHub Actions
  secrets are SEPARATE from the Cloudflare worker secrets, so the key must be added
  there too. Fails SOFT (no key / API error → skips, exits 0, never breaks a deploy).
  Findings are AI-generated — verify before acting.
- **AI AUTO-FIX (cautious, no-merge)** (`.github/workflows/ai-auto-fix.yml` +
  `tools/ai-code-review/autofix.mjs`) — nightly (02:30 UTC) + on-demand. Asks Claude
  for fixes to the WORKER code changed in the last day, applies ONLY the ones marked
  confidence=high + risk=small as exact single-occurrence text replacements, then a
  HARD GATE: `node --check` every changed file + rebuild `dist` — if anything fails it
  `git checkout`s the lot and opens an issue instead of shipping. On success it commits
  `[ai-autofix] …`, pushes to `main` (deploys via Workers Builds) and opens a
  "✅ Auto-fixed…" issue carrying the exact `git revert <sha>` undo, plus a phone push.
  **SCOPE IS DELIBERATELY NARROW:** worker/src/**/*.js only (never the HTML pages), and
  **PROTECTED files are never auto-edited** — index.js, lib/auth.js, routes/auth.js,
  devices.js, users.js, push.js, health.js, wrangler.toml, *.sql (those still surface as
  review issues). HTML is excluded on purpose: a push by the default GITHUB_TOKEN does
  NOT trigger GitHub workflows (so no fix→review loop, and no Pages rebuild), but
  Cloudflare Workers Builds is a separate webhook so worker pushes DO deploy. **Phone
  ping** = the worker's token-gated public **POST /health/notify** (reuses
  `JOBS_INBOUND_TOKEN`, verified in-handler, sends `sendToUser` to `OWNER_USERNAME`);
  the Action passes `secrets.JOBS_INBOUND_TOKEN`, failing soft (the issue is the
  guaranteed record) if it isn't set as a GitHub secret. To WIDEN scope: relax
  `inScope`/`PROTECTED` in autofix.mjs — but keep auth/permissions/routing protected.
- **Data-integrity catalogue** (health.js `INTEGRITY_CHECKS` + `runIntegrityChecks`,
  **ONCE WEEKLY — Sunday ~03:00 UTC** on the cron (`getUTCDay()===0 &&
  getUTCHours()===3`) — was hourly, but its correlated NOT-EXISTS joins are the
  worker's heaviest read source (compliance_stores × sites alone ≈ 600k
  row-reads), so hourly blew past D1's free-tier 5M/day limit; weekly is plenty
  since integrity drifts slowly, and admins can still run it on demand via
  /health/run. The lightweight liveness probes (`runHealthChecks`) still run
  every 5 min — they're what actually catch + alert on an outage). The "do all
  the areas actually JOIN UP?" layer:
  ~20 declarative invariants, each a COUNT of VIOLATING rows against the central D1
  (0 = healthy), written against the REAL schema. Covers Fleet (assignments/maintenance/
  odometer/fuel/user-van → real vehicle & user), SLA (segments→jobs & users, job→site
  by numeric store code, empty status, runaway-open segments), People (push/devices/
  timesheets→users, active users with no password), Holidays (bookings→users, bad date
  range), Compliance (stores→sites, Co-op link). Each scans a whole table, so ~20 rules
  = tens of thousands of row-level checks per run. Defensive: a rule that throws (missing
  table/column) is marked `ok:null` (n/a), never a false pass/fail. Snapshot in app_config
  `health:integrity:<tid>`; surfaced on health.html grouped by area + folded into the
  "N/N checks passing" headline. **ADD A CHECK** = push one `{id,area,label,sql}` (sql
  returns column `n`, one `?` bound to tid). NB the site↔job and segment↔job checks find
  REAL drift on the live DB (9 orphan job sites, 2 orphan segments at build time).
- **Alignment / centralisation linter** (`tools/alignment-check/check.mjs` +
  `.github/workflows/alignment-check.yml`, nightly + on push + on-demand). Deterministic,
  NO AI/cost. Parses the worker's real route table from index.js, then checks EVERY portal
  page: (1) **centralisation** — does it hardcode a legacy `*.jamie-def.workers.dev`
  worker instead of the central MOSTLANE_API? Split into `bridged` (still works via
  portal-config's rewrite bridge — medium) vs `retired` (an old worker being
  decommissioned — high); (2) **config version** — is it on the majority
  `portal-config.js?v=N` or a stale one; (3) **status-bar cap** — loads portal-config but
  missing `viewport-fit=cover`; (4) **endpoint reality** — for central-only pages, every
  authFetch/apiFetch path maps to a real route (legacy-host pages are skipped here since
  their paths are relative to that host — already flagged by #1). Opens an `alignment-check`
  issue listing drift. At build time it found 17 pages on retired workers (the old
  Hours/Timesheet/vehicles workers) + 25 on bridged legacy hosts. This is the "all pages
  point at the centralised database" check. Report-only — never auto-edits (legacy pages
  are migrations, not one-line fixes).

## Auto-day job-duration estimation (sla.js + sla-scheduler.html + job-durations.html — Aug 2026)
Auto-make-a-day now ALLOCATES a realistic on-site time per unscheduled job instead of a
flat 60 min, and shows everything in **hours+minutes** (`optFmtMins`); day target raised to
**~9h door-to-door** (`dayMinutes` 540, the 8–10h band). Duration per job, best source first:
1. the job's own **set `durationMinutes`** (a typed length always wins);
2. an **AI estimate** — `aiEstimateDurations(env, metas)` batches the day's un-set jobs (≤40
   per call, parallel chunks) to Claude via the shared `anthropicTool` helper (forced
   `set_durations` tool → `{id,minutes}`), reading each job's description/trade/priority;
   **cached per job in app_config `sla:aidur:<tid>`** so a job is estimated once (POST
   `/sla/duration-clear-ai` forgets them). Fails soft → falls back to;
3. a **learned historical typical** — `estimateJobDurations(env,tid)` medians the MEASURED
   actual on-site time (last `In Progress`→`Complete` in `statusHistory`), preferring
   measured over set-durations (which were a uniform 40m placeholder), refining per priority
   at ≥5 samples, bounded 30–240m, default 90m; 5-min isolate cache.
`autoScheduleDay` returns `durModel` + `estimatedCount` + `aiUsed`/`aiSource` + `overruns`;
legs carry `estimated`/`aiEstimated` (shown "(AI)"/"(est)"). **Overrun learning:** a job whose
actual ran >1.5× (and >+30m) over its allocated time is flagged, and those actuals feed the
median — so estimates self-correct as engineers tap In Progress/Complete. **Review page
`job-durations.html`** (⏱ Durations button on sla-scheduler, SLA-admin) reads GET
`/sla/duration-insights` (typical + per-priority + overruns + a recent allowed-vs-actual-vs-AI
table). NB **0 jobs are workArea-tagged and only ~9 have measured times today**, so estimates
lean on AI now and sharpen as status-tap history accrues. Reuses the existing
`ANTHROPIC_API_KEY`; no new secret.

## Personalisation
personalise.html (🎨 tile + sidebar; theme.html is now only a redirect — the
old URL got cache-poisoned on phones). 8 accent themes + menu background
(embossed M / 6 light block colours / own photo, client-shrunk to 1600px).
Gated per user by ThemeColour / ThemeBackground permissions (Users Admin →
Personalisation group; FullAccess implies both). Server-side filtering means
revoking a permission reverts that user on their next page load.

## Portal polish layer (Aug 2026)
One pass to make everything feel like one product:
- **POST /batch** (index.js, session-gated): `{paths:[…≤20 GETs]}` dispatched
  through the normal route table in ONE round trip — each sub-handler's own
  permission checks still run; per-path fail-soft. The home hub's `jget()`
  coalesces same-tick cache misses into one /batch (per-path fallback to
  individual fetches). Hub cards load with shimmer skeletons (`.hub-skel .sk`)
  and an all-failed state shows a "↻ Try again" card.
- **MLUI (portal-config.js)**: `window.alert()` portal-wide is now a branded
  toast (bottom-centre, auto-dismiss; a toast fired just before a redirect
  survives onto the next page via sessionStorage `mlToastPending`).
  `MLUI.confirm(msg,{title,okLabel,danger})` = Promise-based styled dialog —
  adopt call-site by call-site (native `confirm()` is synchronous, can't be
  globally swapped). Converted: vehicles resolve-defects, van-checks pause-all,
  tasks-admin delete/grant. Pattern:
  `const ok = window.MLUI ? await MLUI.confirm(...) : confirm(...);`.
- **/portal.css?v=1**: shared design tokens (`--ml-*`) + baseline polish
  (focus-visible rings, uniform button hover/press, tidy desktop scrollbars,
  ::selection, reduced-motion) + opt-in `.ml-card/.ml-pill/.ml-btn/.ml-empty`.
  Loaded BEFORE each page's own <style> (page CSS wins) on the 22 top pages.
  **Include it on every NEW page.**
- **Command palette** (portal-config, desktop): Ctrl/Cmd+K or the Search row
  at the top of the sidebar. Jumps to pages (sidebar's permission-filtered NAV),
  vehicles by reg (→ `vehicles.html?veh=REG` opens the deep-dive) and live site
  search via /ts/sites (→ site-folder.html?site=CODE). Sidebar already
  highlights the current page (`.pn-item.active`).
- **Dead-page cleanup**: 35 retired/unreferenced pages deleted (zero inbound
  links verified across html/js/worker at deletion time). Deliberate redirect
  stubs KEPT: theme.html, sites-register.html, po.html (router). SW cache
  bumped to `mostlane-v71`; portal.css added to the precache shell.

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
  report is marked SATISFACTORY yet has any C1/C2/FI. **Code counting is
  legend-robust** (`isLegendLine`): a line carrying 2+ hazard codes together
  (`C1 C2 C3 FI`), the PASS-key phrase, or a code definition is a KEY/LEGEND —
  stripped before counting, since a genuine observation only ever carries ONE code
  (fixed phantom C1/C2/FI on Tysoft EasyCert & other templates whose reconstructed
  key rows slipped past the earlier exact-line strip and faked an unsatisfactory).
  Also **latest date on the report** (max dd/mm/yyyy), **all signatories**
  (name · role · date — regex `Name (Qualified Supervisor|Electrician|Inspector|
  Tester|…) dd/mm/yyyy`), C1/C2/C3/FI counts + **LIM %** measured over the INSPECTION
  SCHEDULE only (numbered items `5.12 LIM`, not the DB-details / test-result rows
  where LIM/N-A are data — that inflated a clean cert to ~14%; legend rows stripped).
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
extractor; POST /compliance/file + GET /compliance/has verify it in-handler),
**ANTHROPIC_API_KEY** (powers the Job-Programmes "🤖 Draft from a document" AI —
POST /prog/ai-draft calls api.anthropic.com; feature fails soft with a clear
"add the key" message when unset) (secrets); optional var **ANTHROPIC_MODEL**
(defaults to `claude-sonnet-5`); EMAIL_FROM, R2_PUBLIC_BASE,
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
  /push/subscribe, /push/unsubscribe, /push/test, **/push/status-all**
  (FullAccess: every active user + whether they have push ON — device count,
  last-confirmed-send time; groups push_subscriptions by lower(username), merges
  the active users list, off-first sort; surfaced on **notification-centre.html**
  "📱 Who has notifications on" card with an Off-only filter + refresh — so Jamie
  can see at any time who's enabled. NB a subscription row = "on" but can be
  stale until a send returns 404/410 and prunes it; the card shows last-confirmed
  age as the freshness signal). Table push_subscriptions
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

## Inbound email → job (Cloudflare Email Routing — replaces the Zapier zap)
Jobs used to be captured by a Zapier zap watching **enquiries@mostlane.com** for
Southern Co-op's **Concerto** "New Job Alert" emails (from `noreply@concerto.co.uk`)
and POSTing them to `/sla/inbound`. That's now done in-portal by a Cloudflare
**Email Worker**: `worker/src/index.js` exports an **`email(message, env, ctx)`**
handler that calls **`handleInboundEmail`** (`worker/src/routes/emailjob.js`).
- **Parsing**: a dependency-free MIME walker (`extractText`) pulls the text body
  (decodes quoted-printable/base64, strips HTML, DROPS attachments so the PDF work
  order never reaches the AI). Extraction is **AI-first** — `aiExtract` calls the
  Anthropic Messages API (`env.ANTHROPIC_API_KEY`, model `env.ANTHROPIC_MODEL`||
  `claude-sonnet-5`, forced `extract_job` tool → {isJob, reference, priority,
  siteCode, siteName, address, postcode, telephone, description, raisedAt}) so it
  copes with ANY client's format and survives template tweaks. A deterministic
  **`concertoRegex`** is the no-key / AI-error fallback. `isJob=false` (replies,
  chases, quotes, POs, invoices, status updates, newsletters) is dropped.
- **Creation**: reuses `/sla/inbound` **verbatim** via an in-process self-request
  (`fetchSelf` = the worker's own `fetch`, Bearer `JOBS_INBOUND_TOKEN`) — so the
  dedupe-by-reference, forgiving priority/date parsing and assignment push are all
  identical to the old zap. `originator:"email"`. No change to sla.js.
- The `email()` handler **never throws** (a thrown email handler bounces the mail).
- **Manual setup (dashboard — no MCP tool for it):** (1) Cloudflare → the chosen
  domain → **Email Routing** on; add address `jobs@<domain>` → **Worker:
  mostlane-api**. The domain's DNS must be on Cloudflare. (2) Outlook rule on
  enquiries@: from `noreply@concerto.co.uk` (+ any other job senders) → **forward**
  (not redirect — forward re-sends from mostlane.com so it passes SPF/DMARC at
  Cloudflare) to `jobs@<domain>`. Dormant until (1)+(2) are done — the `email`
  export just sits unused.

## Yard gate (routes/tuya.js + yard-gate.html — Aug 2026)
The yard's FAAC 415L gate has a Tuya 4-channel WiFi relay (device
`bf7240c4db7fedd458froe`, Central Europe DC → `eu`/tuyaeu.com). It's a
**LATCHING relay on channel 1 (`switch_1`)**: `switch_1=true` opens (gate stays
open), `switch_1=false` closes (stays closed) — NOT a momentary pulse. The route
signs Tuya Cloud v1.0 HMAC requests server-side so a portal button drives it.
- **Secrets (dashboard):** `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET` (Tuya IoT Cloud
  project → Overview → Authorization Key). Device ids/DP codes live in app_config
  `tuya:config` so they're editable without redeploy.
- **`tuya:config`:** `{region:"eu", gateDeviceId, openCode:"switch_1", openValue:true,
  closeCode?, closeValue?, stateDeviceId?, stateCode?, stateOpenValue?, thresholdMins:10,
  repeatMins:30}`. **closeCode defaults to openCode, closeValue defaults to the
  opposite of openValue** — so a latching gate needs only the open fields set.
- **State without a sensor:** `readGateOpen` reads a dedicated contact sensor if
  configured, ELSE falls back to the gate switch's OWN value (on=open) — so
  open/closed state + the left-open watch work off the relay alone (`canReadState`).
- **Endpoints** (YardGate|FullAccess to operate; FullAccess to configure): POST
  /tuya/gate/open, **POST /tuya/gate/close** (latching), GET /tuya/gate/state, GET
  /tuya/gate/log (openlog entries tagged `action:open|close`), config GET/POST,
  device-status/devices setup tools. `checkGateLeftOpen` on the 5-min cron pushes
  the owner+YardGate holders if the gate's left open past `thresholdMins`.
- **Front-end yard-gate.html** (🚪 tile, YardGate perm): Open (green) + **Close
  (red)** buttons, live open/closed state, access log. **The setup panel is
  HIDDEN by default** — `tuya:config` is pre-seeded in app_config (gateDeviceId
  `bf7240c4db7fedd458froe`, switch_1/true) so nobody needs to configure it; a
  Full-Access user can still reach the setup form for maintenance via
  **`yard-gate.html?setup=1`**. **Still dormant until the two secrets are added +
  Deployed** (device config is already in place).

## Satellite systems
1. **PO system — MIGRATED IN-PORTAL (14 Aug 2026).** The Purchase Order system
   now runs INSIDE the portal (`mostlane-api`), not the standalone `mostlane-po`
   worker. **The PO DATA was NOT moved** — it still lives in its own D1
   (`mostlane-po`, bound as `PO_DB`); only the code moved, so there was no data
   migration. **The standalone `mostlane-po` worker is switched OFF** (its
   Production `workers.dev` route disabled in the dashboard — code + DB kept as an
   instant fallback; re-enable the toggle + revert `po.html` to roll back).
   - **Backend:** `worker/src/routes/po.js`, mounted at `/po` (longest-prefix, so
     `/po-config` still wins for the old per-user link endpoint). Ported the PO
     data layer against `PO_DB`, gated by portal session + `PurchaseOrders`|
     `FullAccess`. Issuer identity is the LOGGED-IN portal user (server-stamped);
     the out-of-hours rule is preserved (field engineers raise only when the
     office is shut; office any time). `/po/api/*` endpoints; `/po/api/my-pos` is
     the field-safe "my own POs" list; `/po/api/engineers` reads LIVE portal field
     staff (env.DB) so the assign-dropdown needs no PO-side engineer list/sync.
     `PO_START=10011` (first allocated number). Vehicles read from the portal DB.
   - **Pages (all portal HTML, `authFetch('/po/api/*')`, `PurchaseOrders`-gated,
     carry a subtle "Portal PO · V1" bottom-right marker):** `po-office.html`
     (office board: log/filters/dashboard/raise/price-edit/CSV/print),
     `po-raise.html` (engineer raise form), `po-stats.html`, `po-summary.html`,
     `po-accounts.html` (supplier aging), `po-jobs.html` (job costs),
     `po-admin.html` (system config + suppliers/subcontractors/trades/sites/
     closures — the obsolete Engineers/Office-Users token-link tabs were dropped).
     CSV + print are done CLIENT-side (no un-authenticated new tab).
   - **`po.html` is now a ROLE ROUTER** (the single launcher every PO entry point —
     field-app PO tab, menu tile, sidebar — already points at): PurchaseOrders|
     FullAccess → `po-office.html`, field engineers → `po-raise.html`, else a
     "no access" message. (Was: redirected to the standalone worker via
     /po-config. Pre-migration launcher is at commit 1a4269c:po.html — that's the
     revert target.) **NB the old `po.html` was a launcher; overwriting it once
     locked engineers out — never reuse a live filename, always route via po.html.**
   - **Not ported (unused/optional):** the weekly PO summary email (Jamie doesn't
     use it) and the old token-URL engineer/office-user management (portal login
     replaces it). `/po-config` + `profile.poUrl` are now dead for the PO flow.
   - Everything else (costing.js/timesheets.js/fleet.js reading `PO_DB` po_log)
     is unaffected — they read the same DB directly.
   HISTORICAL (standalone worker, now retired):
   single-file worker (own D1 `mostlane-po`; legacy KV
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
   "Raise a PO" link carries no payload (by design). **Start-up reliability fix
   (13 Aug):** the worker ran its whole `ensureSchema()` DDL/seed battery on the
   FIRST request of every cold isolate, and any single transient D1
   "internal error" (D1_EXEC_ERROR) threw → the top-level catch blanked the page
   with `Error: D1_EXEC_ERROR … CREATE TABLE … engineers …` (Jamie hit this on
   mobile). Fix = a new **`ensureSchemaSafe(db)`** wrapper that both fetch +
   `runWeeklyEmail` call instead of `ensureSchema` directly: it retries a
   transient error up to 3× (150/300 ms) and, if it still fails, **logs and
   proceeds** — the tables already exist, so schema-init must never block the
   page. Delivered as a **patcher artifact** (2 anchored changes: rewire both
   `await ensureSchema(env.DB)` call sites → `…Safe`, and insert the wrapper
   before `async function ensureSchema(db)`) + a full pre-patched fallback file
   (3,128 lines, tail `//# sourceMappingURL=po-worker.js.map`). Live PO worker was
   the bundled build fetched via the Cloudflare connector (read-only) on 13 Aug.
2. **SiteLog — MIGRATING IN-PORTAL (Aug 2026, Stage 1 done).** Like the PO
   system, the SiteLog BACKEND now runs INSIDE `mostlane-api`:
   **`worker/src/routes/sitelog-api.js`** is a faithful port of the standalone
   `Mostlane/SiteLog worker.js` (3184 lines) with `env.DB`→**`env.SITELOG_DB`**
   and `env.ADMIN_SECRET`→**`env.SITELOG_ADMIN_SECRET`**. It exports `handle()`
   (the full API router) + `sweepAutoClose()` (the daily open-visit auto-close,
   folded into mostlane-api's 5-min cron, gated `if(env.SITELOG_DB)` + hourly).
   The **SiteLog D1 (`sitelog`, id 1e891155-…) is bound as `SITELOG_DB`** in
   `worker/wrangler.toml` (so Workers Builds binds it automatically). Data was
   NOT moved (stays in sitelog-db; that DB also holds unrelated legacy PO tables
   — leave them alone).
   - **Stage 1 (LIVE): portal reads SiteLog locally.** `routes/sitelog.js`
     (admin proxy) and `routes/costing.js` (`sitelogAdminFetch` → /job-costing +
     /admin, `pushSiteToSiteLog` → /bulk-add-sites) now call `sitelogApi.handle()`
     in-process instead of fetching api.site-log.co.uk — **no round-trip, no
     1042, no HMAC bridge for reads**. All paths **fail soft**: if `SITELOG_DB`
     is unbound OR the local module errors/returns non-ok, they fall back to the
     remote `api.site-log.co.uk` fetch (the standalone worker still runs). So the
     scanner + old worker are UNTOUCHED and everything is reversible.
   - **Stage 2 (LIVE — scanner cut over 16 Aug via FRONT-END REPOINT, not a
     domain move).** Lesson from a failed attempt: **moving the live
     `api.site-log.co.uk` custom domain between workers leaves a DNS/cert gap and
     the scanner goes dark** (it orphaned once and needed re-attaching). So instead
     of moving the domain, we stood up a SECOND host **`api2.site-log.co.uk`** as a
     Custom Domain on `mostlane-api` and pointed the scanner front-end at it —
     **zero downtime, old worker stays as a live fallback, both hosts read the same
     `sitelog-db` so no split.** index.js host-dispatches BOTH
     `api.site-log.co.uk` and `api2.site-log.co.uk` → `sitelogApi.handle`. The
     scanner front-end (Mostlane/SiteLog `docs/`: app.html, admin.html,
     documents.html, sites.html) now sets its API base to
     **`https://api2.site-log.co.uk`** (was api.site-log.co.uk); SW cache bumped
     v8→v9. Bindings needed & PRESENT on mostlane-api: **`SITELOG_DB`**,
     **`DOCS_BUCKET`** (R2 sitelog-documents), secret **`GOOGLE_MAPS_KEY`**,
     **`SITELOG_ADMIN_SECRET`** (all confirmed via `GET /served-by` →
     `{worker:"mostlane-api",dbBound:true,docsBound:true}`). **Diagnostics baked
     in:** `GET /served-by` names the answering worker; every `/confirm-checkin`
     insert stamps **`visits.served_by='mostlane-api'`** (old worker leaves it
     NULL) so the cutover can be watched device-by-device in D1. **`api2` is now
     the PERMANENT scanner backend — do NOT remove it.** Device identity survives
     the api→api2 move because the `ml_did` cookie is `Domain=site-log.co.uk`
     (both subdomains) + localStorage/IndexedDB on the unchanged site-log.co.uk
     front-end origin; CORS ALLOWED_ORIGINS already lists site-log.co.uk.
     **Rollback = one commit** (revert the front-end API base to api.site-log.co.uk).
     **REMAINING:** (a) old standalone `sitelog-api` worker + `api.site-log.co.uk`
     stay as fallback until every active device shows `served_by='mostlane-api'`
     (watch visits) — THEN retire the worker; (b) remove the STALE
     `api.site-log.co.uk` custom-domain row still sitting on mostlane-api from the
     failed attempt (harmless now — sitelog-api serves api.*).
   - **Stage 3 (TODO):** rebuild admin.html/documents as portal pages
     (FullAccess-gated) reading SITELOG_DB directly. (admin/documents/sites.html
     currently work standalone against mostlane-api via api2.)
   HISTORICAL (standalone worker, still the live scanner backend until Stage 2):
   repo `Mostlane/SiteLog` (docs/ = Pages at site-log.co.uk;
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
- **Compliance codes are ZERO-PADDED to 4 digits; portal site numbers are not.**
  `pad4()` makes a Co-op store "0649", but the portal site created back in July is
  `site_number = "649"`. The old `/compliance/stores/import` set `site_number = code`
  blindly, so those stores missed the site that already existed and (with
  `createSites:true`) minted a DUPLICATE 3-digit/4-digit site pair — 6 of them
  (0649/0650/0665/0667/0668/0670, ELS + ELS Private funeral directors), each a
  minimal stub next to the real record. Fixed 17 Aug: **`coopSiteNumber(env,tid,code)`**
  in compliance.js resolves the link NUMERICALLY (shortest match wins, so the
  original unpadded row is used) and only falls back to the padded code when the
  store genuinely has no site yet — used by /stores/import, /store, /store-meta and
  bumpDue. The `/stores` GET join also matches numerically (and dedupes by code) so
  a padded code still resolves an unpadded site's live name/postcode. The 6 stores
  were repointed and the 6 stub sites deleted in D1. **Any new site↔code matching
  must compare numerically, never as strings.**
- **Mobile-first `.shell{max-width:560px}` clamps a page to mobile width on
  DESKTOP too** (a "field-friendly restyle" that unconditionally overrode an
  earlier `max-width:1100px`). Symptom: an OFFICE page (e.g. **job-view.html**)
  opens narrow like mobile on desktop; a refresh sometimes "fixes" it only
  because the SW served an older, wider cached copy — pure cache lottery, not a
  real fix. The cure is a desktop widen rule AFTER the 560 clamp:
  `@media(min-width:769px){ .shell{ max-width:1000px } }` (applied Aug 2026 to
  job-view / daily-logs / oncall_current; **my-day.html is a FIELD phone page —
  left narrow on purpose**). When restyling any office page mobile-first, always
  re-add a desktop `.shell` width or it'll be stuck at 560px on desktop.
- **Manual D1 inserts into worker tables: tenant_id must be the string '1.0'**
  (not 1, not '1') when the table declares `tenant_id TEXT` (job_programmes,
  admin_tasks, the programme_* tables…). The worker binds the JS number 1,
  which D1 marshals as REAL 1.0; the TEXT column then stores/compares it as
  the string "1.0". A hand-inserted row with tenant_id=1 stores "1" and is
  INVISIBLE to every worker query (cost a long debugging session on 16 Aug —
  the Excel-example programme "wasn't there"). Tables declaring
  `tenant_id INTEGER` (users, app_config…) compare numerically and don't care.
  Safest: copy the tenant_id value from an existing worker-written row of the
  SAME table.
- **iOS PWA Web Push shows NOTHING while the app is in the FOREGROUND.** A push
  that the server sent fine (push_subscriptions.last_ok updates on a 201, and a
  user_notifications feed row is written) will NOT pop a banner if the installed
  PWA is open in front of the user — iOS suppresses its own app's banners.
  Symptom: "I sent a test and got nothing" even though the send succeeded. First
  check last_ok + a feed row before suspecting the backend; then have them lock
  the phone / background the app so the push lands on the Lock Screen. The
  notifications.html "Send test" runs a 5-second lock-your-phone countdown on an
  installed iPhone/iPad for exactly this reason. Also: don't churn the SW
  CACHE_NAME needlessly — every bump forces an SW update, and rapid updates can
  briefly disturb iOS push; HTML pages are network-first so they refresh without
  a bump, and external JS is stale-while-revalidate (or use a `?v=` query bump).
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
- **van-check.html answer buttons must read CFG LIVE, never a captured array.**
  The driver form's answer handlers were bound as `onPick(CFG.checklist||[], …)`
  at load — but `CFG` is fetched async, so at bind time it was null → an empty
  array was captured (or it threw) and NO answer could be selected once items
  existed. Fix: `onPick(kind, render)` looks up `CFG.checklist`/`CFG.equipment`
  on every tap (+ `e.target.closest("button[data-id]")`), and `normItems()`
  guarantees every item a stable id (`slugId(label)`, matching the worker's
  underscore slug) so items added/removed in settings always stay answerable and
  never collide on `answers[undefined]`. Same pattern applies to any config-driven
  tap list — bind once, read the live config in the handler.
- **Status-bar cap: ONE slim branded bar, portal-wide (18 Aug).** main.html (the
  PWA start_url) sets `apple-mobile-web-app-status-bar-style: black-translucent`,
  which governs the WHOLE installed app — so EVERY page runs full-bleed under the
  iOS clock/battery, and a header's back button sat under the clock, untappable.
  Fixed centrally by **`statusCap()` in portal-config.js**: it paints
  `#mlStatusCap` (fixed, full width, `height:env(safe-area-inset-top,0px)`, navy
  #003468, z-index 2147483000) and pushes the page below it. **`viewport-fit=cover`
  is now on every page that LOADS portal-config.js** (117 pages) — without it
  `env()` reports 0 and the cap can't size itself.
  **Two rules learned doing it:**
  (a) **The offset goes on `<html>`, never `<body>` — this took three attempts.**
  A CSS `body{padding-top:env(...)}` REPLACED the padding pages set for
  themselves (the field app lost its 14px). A JS version that ADDED to the
  page's own value then broke main.html: `html,body{overflow-x:hidden}` makes
  **body the scroll container**, and padding a scroll box left a band of
  background at the end of the scroll range — the "blank section bar" Jamie
  reported. The working form is CSS on html:
  `html{box-sizing:border-box; min-height:100vh; padding-top:env(safe-area-inset-top,0px)}`.
  **Anything else pinned across the top must reserve its space via
  `--ml-topbar`**: the html padding is
  `calc(env(safe-area-inset-top,0px) + var(--ml-topbar, 0px))` and the body
  min-height subtracts both. The van-score banner (`#mlVanScoreNote`, moved into
  portal-config so it shows portal-wide) is `position:fixed`, so before this it
  simply covered the first row — a field user saw the Van Check / Holiday tiles
  sliced in half. It now measures its own height on show (it wraps to two lines
  on a narrow screen), sets `--ml-topbar`, re-measures on resize, and CLEARS the
  variable when dismissed. Any future top banner/toast must do the same.
  The **`min-height:100vh` pins html to the FULL screen**: with viewport-fit=cover
  iOS can resolve a page's own `html{height:100%}` against the SAFE-AREA box
  instead of the screen, leaving the page short and a band of canvas below it —
  main.html (the only page setting `html,body{height:100%}`) kept showing that
  bottom bar after every other page was right. Chromium does not reproduce it,
  so that line is belt-and-braces; where html is already full-height it is a no-op.
  Percentage heights resolve against the parent's CONTENT box, so a
  `body{height:100%}` shrinks to fit exactly and nothing overflows.
  **`vh` does NOT** — it measures the full screen and ignores that padding, so
  portal-config also injects `body{min-height:calc(100vh - env(...))}` to
  re-base it, and the five pages that used `height:100vh` (login, change/forgot/
  reset-password, hours-menu) were switched to `min-height:100vh` so that one
  central rule can win. Check with scratchpad `cap3.cjs`, which flags any page
  that fitted the screen before and scrolls after. Two known non-issues: hs-docs
  `.wrap` has its own 60px bottom margin, and daily-logs reflows — both are the
  pages' own spacing, not a gap the cap created.
  (b) **Only add `viewport-fit=cover` where portal-config actually loads.** Grep
  for the `<script src=…portal-config.js>` tag, NOT the string — programme-view.html
  merely *mentions* it in a comment, and giving that client-facing page the meta
  without a cap pushed its content under the status bar.
  The cap skips iframes (po.html embeds portal pages; a second cap would double
  the gap) and collapses to 0 in a browser, so nothing changes off-device.
  Per-page header insets were REMOVED as part of this (my-documents,
  vehicle-maintenance, memo-sign, project-hub, site-folder, the seven po-*,
  engineer-timesheet, engineer-job) — the cap owns the top inset now, so never
  add `env(safe-area-inset-top)` to a header again. Fixed OVERLAY buttons still
  need it themselves (they ignore body padding): job-view `.photo-modal-close`,
  site-folder `.lb .x`, engineer-job `.lx-close`, docviewer `.mldv-bar`, and
  portal-config's own 🔔 bell. offline.html carries its own inline cap (it never
  loads portal-config). Verified across all 124 portal-config pages
  (scratchpad `cap.cjs`): cap present, 0px at rest, and with a 47px inset the bar
  is exactly 47px with each page's own padding preserved beneath it.
  **A FIXED `top:0` element still needs the inset itself** — it is positioned
  against the viewport, so the cap's body padding doesn't move it. route.html's
  `#vanScoreNote` "new van driving score" banner sat under the clock until its
  padding became `calc(env(safe-area-inset-top, 0px) + 10px)` (18 Aug, found in
  a concurrent session); same for any toast or banner pinned to the top edge.
- **Full-screen photo/doc close (✕) buttons must clear the iOS status bar.**
  On installed PWAs the ✕ sat at a fixed `top` under the notch/clock/battery.
  Fix pattern (Apple-standard): the page's `<meta viewport>` needs
  **`viewport-fit=cover`** AND the button's `top`/`right` use
  **`calc(env(safe-area-inset-top, 0px) + Npx)`** (both are required — without
  viewport-fit the env() inset is 0). Applied to engineer-job.html `.lx-close`,
  docviewer.js `.mldv-bar` (padding-top), job-view.html `.photo-modal-close`,
  site-folder.html `.lb .x`; viewport-fit added to job-view/site-folder/
  my-documents/vehicle-maintenance/project-hub. docviewer bumped `?v=6`.
  Any NEW full-screen overlay close button needs the same treatment.
- **NEVER put `transform`/`translateZ(0)` on a `position:fixed` bottom bar** (iOS
  Safari, Aug 2026). The field-app tabbar (route/engineer-jobs/inbox/you `.tabbar`)
  and the View As "Viewing as…" return bar (portal-config `mlVaBar`) carried
  `transform:translateZ(0);-webkit-transform:translateZ(0)` as a GPU-promotion hack.
  On iOS that promotes the fixed element to a compositor layer that is only
  repositioned at scroll-END, so during a scroll the bar DRIFTS UP with the content
  and appears stuck mid-page (Jamie saw the purple return bar float into the middle
  of the jobs list while View As'ing). Chromium pins it perfectly at every scroll
  offset (verified with scratchpad `repro-bar.cjs`) — it's an iOS-only quirk. Modern
  iOS handles a plain `position:fixed;bottom:0` bar correctly, so the fix is to
  REMOVE the transform. Do not re-add translateZ(0) to any fixed bar.
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
