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

-- ── Users & access ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
  username   TEXT NOT NULL,
  permission TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,  -- 0 = No, 1 = Yes
  PRIMARY KEY (username, permission)
);

-- ── Sessions (server-side auth — replaces localStorage-only "logged in") ────
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,          -- random id; signed value sent to client
  username    TEXT NOT NULL,
  device_id   TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

-- Story Mode: one shift row per engineer per day (clock on/off, mileage, fuel).
CREATE TABLE IF NOT EXISTS shifts (
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
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  role   TEXT NOT NULL,             -- 'engineer' | 'manager'
  name   TEXT NOT NULL,
  set_by TEXT,
  set_at TEXT DEFAULT (datetime('now'))
);

-- Engineer daily logs (replaces the Zapier daily-log form).
CREATE TABLE IF NOT EXISTS daily_logs (
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
  username      TEXT NOT NULL,
  week          TEXT NOT NULL,   -- Monday date yyyy-mm-dd
  vehicle       TEXT,
  checked_at    TEXT,
  safe_to_drive INTEGER,
  items         TEXT,            -- JSON of checklist items
  note          TEXT,
  PRIMARY KEY (username, week)
);

-- Self-service password reset tokens (forgot-password flow).
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pwreset_username ON password_resets(username);

-- Device locking (replaces userdevicekv Worker)
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  label       TEXT,
  office_clock INTEGER DEFAULT 0,          -- 1 = show the office clock on this device
  registered_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_username ON devices(username);

-- Login history (replaces login /admin/login-history)
CREATE TABLE IF NOT EXISTS login_history (
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
  id           TEXT PRIMARY KEY,          -- "H-<timestamp>"
  username     TEXT NOT NULL,
  engineer     TEXT,                      -- display name (username with dot->space)
  year         INTEGER NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  days         INTEGER,                   -- weekdays inclusive
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
  year      INTEGER NOT NULL,
  username  TEXT NOT NULL,
  allowance INTEGER NOT NULL,
  PRIMARY KEY (year, username)
);

-- Audit log (was HOLIDAY_LOG_KV `log:<id>:<ts>`).
CREATE TABLE IF NOT EXISTS holiday_log (
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
  id          TEXT PRIMARY KEY,
  assigned_to TEXT,
  data        TEXT NOT NULL                -- full asset JSON (name, serial, value,
                                           -- shared, calibrationDate, images[], ...)
);
CREATE INDEX IF NOT EXISTS idx_assets_assigned ON assets(assigned_to);

-- Transfer log (was ASSET_LOG_KV key `<assetID>-<timestamp>`). Full log JSON in
-- `data`; asset_id + at denormalised for lookups/ordering.
CREATE TABLE IF NOT EXISTS asset_transfers (
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

-- ── SLA jobs (replaces mostlane-sla Worker's SLA_JOBS KV) ───────────────────
-- Indexed columns drive the list filters; `data` holds the full job object
-- (events, statusHistory, signature, etc.) exactly as the front end expects.
-- Binary files (photos/signatures) stay in the JOB_FILES R2 bucket.
CREATE TABLE IF NOT EXISTS sla_jobs (
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
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Key register (site keys, van keys, office keys) ─────────────────────────
-- Full key JSON in `data` (id, label, type site|van|other, ref, notes,
-- holder — "" = in the office, outSince, createdAt). key_log is the
-- append-only sign-out/sign-in audit trail; rows are kept even if the key
-- record is later deleted.
CREATE TABLE IF NOT EXISTS portal_keys (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS key_log (
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

-- ── Compliance and Projects are intentionally NOT modelled here yet —
--    they'll be added (or handled by separate systems) later.
