-- ============================================================================
-- Mostlane Portal — D1 schema (single database for the whole portal)
-- Replaces: users.json, holiday-*.json, vans.json, van-scores.json,
--           sites.json, assets/*.json, eicr-log*.json, activity-log.json,
--           and the per-Worker KV namespaces.
-- Out of scope (separate / later systems): Purchase Orders & suppliers,
--           Hours/Timesheets, Labour Planning.
--
-- Apply:  npx wrangler d1 execute mostlane --file=./schema.sql --remote
-- Field names mirror the existing JSON so migration is a straight map.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ── Tenants (multi-tenant SaaS foundation) ──────────────────────────────────
-- One row per customer company. Every data table carries a tenant_id pointing
-- here; a request may only ever touch its own tenant's rows (enforced by
-- lib/tenantdb.js). Tenant 1 = the origin company (Mostlane). Existing live
-- data is migrated with worker/migrations/001-multitenant.sql.
CREATE TABLE IF NOT EXISTS tenants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT UNIQUE,
  company_name TEXT NOT NULL,
  status       TEXT DEFAULT 'active',   -- active | trialing | past_due | suspended | cancelled
  plan         TEXT DEFAULT 'standard',
  seat_limit   INTEGER,
  branding     TEXT,                    -- JSON: logo, accent colour, menu bg
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  trial_ends_at TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO tenants (id, slug, company_name, status)
VALUES (1, 'mostlane', 'Mostlane', 'active');

-- ── Users & access ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 1,
  engineer_number TEXT,
  first_name      TEXT,
  last_name       TEXT,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT,
  password_hash   TEXT,                 -- PBKDF2 (new) or legacy sha256 (auto-upgraded on login)
  password_algo   TEXT DEFAULT 'sha256',-- 'sha256' (legacy) | 'pbkdf2'
  vehicle_assigned TEXT,
  employment_type TEXT,                 -- Employed | Self Employed
  status          TEXT DEFAULT 'Active',
  sharepoint_path TEXT,
  must_change_password INTEGER DEFAULT 0,  -- force change on next login (admin reset / new user)
  profile         TEXT,                    -- JSON: rates, fuel, contact/HR details, etc.
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Permissions as flexible key/value (FullAccess, PurchaseOrders, CheckInOut,
-- Holiday, Forms, Assets, AddSite, MyDocuments, Compliance, HoursDashboard,
-- Sites, Users, DeviceAdmin, EngineersHoursMenu, Projects, ProjectsAdmin,
-- HolidayAdmin, Weekly, TimesheetAdmin, LabourPlanning, SLA, Vehicles, ...).
CREATE TABLE IF NOT EXISTS user_permissions (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  username   TEXT NOT NULL,
  permission TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,  -- 0 = No, 1 = Yes
  PRIMARY KEY (username, permission)
);

-- ── Sessions (server-side auth — replaces localStorage-only "logged in") ────
CREATE TABLE IF NOT EXISTS sessions (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  token       TEXT PRIMARY KEY,          -- random id; signed value sent to client
  username    TEXT NOT NULL,
  device_id   TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

-- Story Mode: one shift row per engineer per day (clock on/off, mileage, fuel).
CREATE TABLE IF NOT EXISTS shifts (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  username      TEXT NOT NULL,
  date          TEXT NOT NULL,
  clock_on_at   TEXT,
  clock_on_gps  TEXT,
  start_mileage INTEGER,
  clock_off_at  TEXT,
  clock_off_gps TEXT,
  end_mileage   INTEGER,
  fuel          TEXT,
  data          TEXT,
  PRIMARY KEY (username, date)
);

-- Office clock in/out: one row per clock-in→clock-out segment (breaks allowed).
-- The weekly master timesheet sums each user's segments per day. The clock only
-- shows on devices flagged office_clock=1 for a user holding the OfficeClock perm.
CREATE TABLE IF NOT EXISTS office_shifts (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  date       TEXT NOT NULL,          -- Europe/London calendar day yyyy-mm-dd (of the effective start)
  clock_in   TEXT NOT NULL,          -- ISO UTC timestamp (auto-captured original)
  clock_out  TEXT,                   -- ISO UTC timestamp (NULL = still running)
  device_id  TEXT,
  edited_in  TEXT,                   -- admin override start (NULL = use clock_in)
  edited_out TEXT,                   -- admin override end   (NULL = use clock_out)
  edited_by  TEXT,                   -- admin who last edited
  edited_at  TEXT,                   -- when edited
  edit_note  TEXT,                   -- optional reason
  voided     INTEGER DEFAULT 0,      -- 1 = excluded from totals
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_office_shifts_user_date ON office_shifts(username, date);
CREATE INDEX IF NOT EXISTS idx_office_shifts_date ON office_shifts(date);

-- Customers (clients) — own sites; billing details feed quoting/invoicing.
CREATE TABLE IF NOT EXISTS customers (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id              TEXT PRIMARY KEY,   -- slug, matches sites.client
  name            TEXT,
  contact_name    TEXT,
  email           TEXT,
  phone           TEXT,
  invoice_email   TEXT,
  billing_address TEXT,
  notes           TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT
);

-- Sites — replaces the mostlane-sites Worker's KV. Full site JSON in `data`.
CREATE TABLE IF NOT EXISTS sites (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  client      TEXT NOT NULL,          -- customer id (slug)
  site_number TEXT NOT NULL,
  site_name   TEXT,
  postcode    TEXT,
  active      INTEGER DEFAULT 1,
  job_number  TEXT,
  data        TEXT,
  updated_at  TEXT,
  PRIMARY KEY (client, site_number)
);

-- On-call rota: append-only log; the latest row per role is the current holder.
CREATE TABLE IF NOT EXISTS oncall_log (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  role   TEXT NOT NULL,             -- 'engineer' | 'manager'
  name   TEXT NOT NULL,
  set_by TEXT,
  set_at TEXT DEFAULT (datetime('now'))
);

-- Engineer daily logs (replaces the Zapier daily-log form).
CREATE TABLE IF NOT EXISTS daily_logs (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  engineer       TEXT NOT NULL,
  date           TEXT NOT NULL,
  site           TEXT,
  standard_hours REAL,
  overtime_hours REAL,
  travel_time    REAL,
  mileage        REAL,
  notes          TEXT,
  submitted_by   TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);

-- Story Mode: one weekly vehicle (van walkaround) check per engineer.
CREATE TABLE IF NOT EXISTS vehicle_checks (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  username      TEXT NOT NULL,
  week          TEXT NOT NULL,   -- Monday date yyyy-mm-dd
  vehicle       TEXT,
  checked_at    TEXT,
  safe_to_drive INTEGER,
  items         TEXT,            -- JSON of checklist items
  note          TEXT,
  PRIMARY KEY (username, week)
);

-- Portal vehicle registry (MOT/tax/service moved off the old standalone worker).
-- Self-migrating via ensureVehTable() in routes/fleet.js; this is the reference.
CREATE TABLE IF NOT EXISTS vehicles (
  tenant_id          INTEGER NOT NULL DEFAULT 1,
  reg                TEXT NOT NULL,
  make TEXT, model TEXT, fuel TEXT,
  active             INTEGER DEFAULT 1,
  mot_due TEXT, tax_due TEXT,
  next_service       TEXT,            -- fixed date, used only when no interval set
  notes              TEXT,
  svc_interval_days  INTEGER,         -- service every N days (or…)
  svc_interval_miles INTEGER,         -- …every N miles (whichever comes first)
  last_service_date  TEXT,
  last_service_miles INTEGER,
  warn_days          INTEGER,         -- pre-warning window (default 30)
  warn_miles         INTEGER,         -- pre-warning window (default 1000)
  at                 TEXT,
  PRIMARY KEY (tenant_id, reg)
);
-- Current odometer per vehicle is derived from vehicle_checks.items.mileage
-- (latest checked_at wins) — not stored on the vehicles row.

-- Driver assignment history: who drives which reg, and when (routes/fleet.js).
CREATE TABLE IF NOT EXISTS vehicle_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  reg TEXT NOT NULL, username TEXT NOT NULL,
  start_date TEXT NOT NULL, end_date TEXT,   -- end_date NULL = current
  assigned_by TEXT, at TEXT
);

-- Van driver timesheets (door-to-door pay from the fleet report; routes/fleet.js).
CREATE TABLE IF NOT EXISTS van_timesheets (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  week TEXT NOT NULL, username TEXT NOT NULL,
  data TEXT, at TEXT,                          -- data = JSON { days: {...} }
  PRIMARY KEY (tenant_id, week, username)
);
-- Vehicle repair/invoice documents live in R2 (JOB_FILES) under
-- vehicledocs/<tenant>/<REG>/… — no D1 table.

-- Self-service password reset tokens (forgot-password flow).
CREATE TABLE IF NOT EXISTS password_resets (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pwreset_username ON password_resets(username);

-- Device locking (replaces userdevicekv Worker)
CREATE TABLE IF NOT EXISTS devices (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  device_id   TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  label       TEXT,
  office_clock INTEGER DEFAULT 0,          -- 1 = show the office clock on this device
  registered_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_username ON devices(username);

-- Login history (replaces login /admin/login-history)
CREATE TABLE IF NOT EXISTS login_history (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT,
  device_id TEXT,
  ip        TEXT,
  user_agent TEXT,
  outcome   TEXT,                        -- success | fail
  at        TEXT DEFAULT (datetime('now'))
);

-- ── Check-in/out, Hours/Timesheets, Labour, Vehicles, Sites, Compliance,
--    Projects and Purchase Orders are intentionally NOT modelled here — they're
--    handled by separate / later systems.

-- ── Holidays (full port of mostlane-holidays Worker) ────────────────────────
-- Leave requests (was HOLIDAYS_KV `holiday:<id>`).
CREATE TABLE IF NOT EXISTS holidays (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id           TEXT PRIMARY KEY,          -- "H-<timestamp>"
  username     TEXT NOT NULL,
  engineer     TEXT,                      -- display name (username with dot->space)
  year         INTEGER NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  days         REAL,                      -- weekdays inclusive (0.5 = half day)
  half         TEXT,                      -- 'AM' | 'PM' for half-day bookings
  type         TEXT,                      -- Annual Leave | Sick | ...
  notes        TEXT,
  status       TEXT DEFAULT 'Pending',    -- Pending | Approved | Rejected | Cancelled
  submitted_at TEXT,
  approved_by  TEXT,
  decision_at  TEXT,
  cancelled_by TEXT,
  cancel_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_holidays_user_year ON holidays(username, year);
CREATE INDEX IF NOT EXISTS idx_holidays_year_status ON holidays(year, status);

-- System-generated per-user days for bank holidays & company shutdowns
-- (was HOLIDAYS_KV `system:<kind>:<year>:<date>:<username>`).
CREATE TABLE IF NOT EXISTS holiday_system_days (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  kind       TEXT NOT NULL,               -- 'bankholiday' | 'shutdown'
  year       INTEGER NOT NULL,
  date       TEXT NOT NULL,
  username   TEXT NOT NULL,
  id         TEXT,
  engineer   TEXT,
  label      TEXT,
  days       INTEGER DEFAULT 1,
  category   TEXT,                         -- 'BankHoliday' | 'Shutdown'
  worked     INTEGER DEFAULT 0,            -- 0/1
  status     TEXT,                         -- 'Deducted' | 'Credited'
  created_at TEXT,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (kind, year, date, username)
);
CREATE INDEX IF NOT EXISTS idx_sysdays_year_user ON holiday_system_days(year, username);

-- Per-user yearly allowance override (was HOLIDAY_CONFIG_KV `allowance:<year>:<user>`).
CREATE TABLE IF NOT EXISTS holiday_allowance (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  year      INTEGER NOT NULL,
  username  TEXT NOT NULL,
  allowance INTEGER NOT NULL,
  PRIMARY KEY (year, username)
);

-- Audit log (was HOLIDAY_LOG_KV `log:<id>:<ts>`).
CREATE TABLE IF NOT EXISTS holiday_log (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  action     TEXT,
  by_user    TEXT,
  at         TEXT DEFAULT (datetime('now'))
);

-- Year config (defaultAllowance) and the bank-holiday / shutdown date lists are
-- stored in app_config under keys:
--   holiday:config:<year>        -> { "defaultAllowance": 28 }
--   holiday:bankholidays:<year>  -> [ { "date": "...", "label": "..." }, ... ]
--   holiday:shutdown:<year>      -> [ { "date": "...", "label": "..." }, ... ]

-- ── Assets / plant (full port of mostlane-assets Worker) ────────────────────
-- The Worker stored each asset as free-form JSON (ASSETS_KV key = asset id),
-- merging updates with {...existing, ...body}. We keep that exactly: full JSON
-- in `data`, with assigned_to denormalised for the /assets?user= filter.
-- Asset images stay in the ASSET_BUCKET R2 bucket.
CREATE TABLE IF NOT EXISTS assets (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id          TEXT PRIMARY KEY,
  assigned_to TEXT,
  data        TEXT NOT NULL                -- full asset JSON (name, serial, value,
                                           -- shared, calibrationDate, images[], ...)
);
CREATE INDEX IF NOT EXISTS idx_assets_assigned ON assets(assigned_to);

-- Transfer log (was ASSET_LOG_KV key `<assetID>-<timestamp>`). Full log JSON in
-- `data`; asset_id + at denormalised for lookups/ordering.
CREATE TABLE IF NOT EXISTS asset_transfers (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  at       TEXT,
  data     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_tx_asset ON asset_transfers(asset_id);

-- Pending plant/equipment transfers: User 1 offers an item to User 2, who must
-- accept (signing a transfer note — logged in asset_transfers) or reject it.
-- The recipient's pending count drives the red badge on Plant & Equipment.
CREATE TABLE IF NOT EXISTS asset_transfer_requests (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id      TEXT NOT NULL,
  from_user     TEXT,
  to_user       TEXT NOT NULL,
  status        TEXT DEFAULT 'pending',   -- pending | accepted | rejected | cancelled
  note          TEXT,
  requested_at  TEXT DEFAULT (datetime('now')),
  decided_at    TEXT,
  signature_key TEXT,                     -- R2 key of the acceptance signature image
  condition_photos TEXT                   -- JSON {sender:[R2 keys], recipient:[R2 keys]}
);
CREATE INDEX IF NOT EXISTS idx_atr_to ON asset_transfer_requests(to_user, status);
CREATE INDEX IF NOT EXISTS idx_atr_asset ON asset_transfer_requests(asset_id, status);

-- Asset REQUESTS ("can I have that?"): anyone can request a shared/other
-- user's item; the current holder (or asset admins when it's unassigned) gets
-- a red-bubble notification and either starts a transfer (feeds the normal
-- signed-transfer workflow) or rejects with a message. Full request/response
-- log kept for the admin area.
CREATE TABLE IF NOT EXISTS asset_requests (
  tenant_id     INTEGER NOT NULL DEFAULT 1,
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id      TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  holder        TEXT,                     -- holder at request time ('' = unassigned/office)
  message       TEXT,                     -- requester's note
  status        TEXT DEFAULT 'pending',   -- pending | accepted | rejected | cancelled
  reject_reason TEXT,
  requested_at  TEXT,
  decided_at    TEXT,
  decided_by    TEXT,
  seen          INTEGER DEFAULT 0,        -- requester has seen the decision
  transfer_request_id INTEGER             -- the transfer created on accept
);
CREATE INDEX IF NOT EXISTS idx_areq_holder ON asset_requests(tenant_id, holder, status);
CREATE INDEX IF NOT EXISTS idx_areq_by ON asset_requests(tenant_id, requested_by, status);

-- ── SLA jobs (replaces mostlane-sla Worker's SLA_JOBS KV) ───────────────────
-- Indexed columns drive the list filters; `data` holds the full job object
-- (events, statusHistory, signature, etc.) exactly as the front end expects.
-- Binary files (photos/signatures) stay in the JOB_FILES R2 bucket.
CREATE TABLE IF NOT EXISTS sla_jobs (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id           TEXT PRIMARY KEY,
  helpdesk_ref TEXT,
  description  TEXT,
  priority     TEXT,
  status       TEXT,
  assigned_to  TEXT,
  site_code    TEXT,
  raised_at    TEXT,
  target_at    TEXT,
  scheduled_at TEXT,
  created_at   TEXT,
  updated_at   TEXT,
  closed_at    TEXT,
  data         TEXT NOT NULL                -- full job JSON
);
CREATE INDEX IF NOT EXISTS idx_sla_status   ON sla_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sla_assigned ON sla_jobs(assigned_to);
CREATE INDEX IF NOT EXISTS idx_sla_site     ON sla_jobs(site_code);

-- Generic key/value config store (replaces SLA_CONFIG KV; reusable elsewhere).
CREATE TABLE IF NOT EXISTS app_config (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Key register (site keys, van keys, office keys) ─────────────────────────
-- Full key JSON in `data` (id, label, type site|van|other, ref, notes,
-- holder — "" = in the office, outSince, createdAt). key_log is the
-- append-only sign-out/sign-in audit trail; rows are kept even if the key
-- record is later deleted.
CREATE TABLE IF NOT EXISTS portal_keys (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS key_log (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id  TEXT NOT NULL,
  action  TEXT NOT NULL,            -- 'out' | 'in'
  holder  TEXT,                     -- who it was signed to / returned by
  by_user TEXT,                     -- who recorded the movement
  note    TEXT,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_key_log_key ON key_log(key_id, id);

-- ── Notification audit log ───────────────────────────────────────────────────
-- One row every time the attention gate / desktop panel is shown to someone
-- (action 'shown'), plus 'snoozed' / 'dismissed' / 'opened'. `items` is the
-- JSON list of what was on screen. Proof against "mine never showed that".
CREATE TABLE IF NOT EXISTS notify_log (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  action   TEXT NOT NULL,            -- 'shown' | 'snoozed' | 'dismissed' | 'opened'
  surface  TEXT,                     -- 'mobile' | 'desktop'
  items    TEXT,                     -- JSON of the items on screen
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_log_user ON notify_log(username, id);

-- ── Activity log ─────────────────────────────────────────────────────────────
-- Every state-changing API request (who/what/when, written automatically by
-- the middleware in index.js) plus page views (method 'VIEW', posted by
-- portal-config). Pruned automatically to 12 months.
CREATE TABLE IF NOT EXISTS audit_log (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  method   TEXT NOT NULL,            -- POST | PUT | PATCH | DELETE | VIEW
  path     TEXT NOT NULL,            -- endpoint (+ query) or /page.html for views
  detail   TEXT,                     -- key fields extracted from the payload
  status   INTEGER,                  -- HTTP outcome of the action
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(username, id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- ── H&S documents (inductions, permits, RAMS, incident reports) ──────────────
-- One generic table serves every document type: doc_type says which, and the
-- full form (fields + inline signature data URLs) lives in `data`. ref is the
-- human-facing number (IND-0001, HWP-<site>-<date>-<n>, ...). The 🦺 H&S
-- Documents hub reads/writes these via /hs/*. Tenant-scoped like everything else.
CREATE TABLE IF NOT EXISTS hs_documents (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  id         TEXT PRIMARY KEY,          -- internal id (HSD-<ts>-<rand>)
  doc_type   TEXT NOT NULL,             -- 'induction' | 'hotworks' | 'rams' | 'incident'
  ref        TEXT,                      -- human reference, e.g. IND-0001
  site       TEXT,                      -- site / project name
  status     TEXT DEFAULT 'open',       -- open | closed
  data       TEXT NOT NULL,             -- full document JSON (fields + signatures)
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hs_tenant ON hs_documents(tenant_id, doc_type, id);

-- Web Push subscriptions (one row per device/browser). Self-migrating in
-- routes/push.js (ensureTable) — this is the reference definition.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at TEXT,
  last_ok TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(tenant_id, username);

-- ── Compliance and Projects are intentionally NOT modelled here yet —
--    they'll be added (or handled by separate systems) later.

-- Engineer weekly timesheets (times + jobs per day; mileage claims in the JSON)
CREATE TABLE IF NOT EXISTS eng_timesheets (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  week      TEXT NOT NULL,               -- Monday (YYYY-MM-DD)
  username  TEXT NOT NULL,
  data      TEXT,                        -- { days: { date: {start,finish,jobs,note,mileage[]} } }
  at        TEXT,
  PRIMARY KEY (tenant_id, week, username)
);

-- Self-employed engineer invoices (sequential per user; PDF stored in R2 invoices/<tid>/<user>/)
CREATE TABLE IF NOT EXISTS eng_invoices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  username  TEXT NOT NULL,
  number    INTEGER NOT NULL,
  week      TEXT NOT NULL,
  hours REAL, miles REAL, labour REAL, mileage REAL, total REAL,
  r2_key    TEXT,
  at        TEXT,
  UNIQUE (tenant_id, username, number),
  UNIQUE (tenant_id, username, week)
);

-- Known round-trip mileage per site from the base postcode (engineer mileage
-- rows auto-fill from this; admin edits it on timesheets-admin.html)
CREATE TABLE IF NOT EXISTS site_miles (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  key       TEXT NOT NULL,               -- normalised site name
  name      TEXT,
  postcode  TEXT,
  miles     REAL,                        -- round trip
  updated_at TEXT,
  PRIMARY KEY (tenant_id, key)
);
