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

-- Device locking (replaces userdevicekv Worker)
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  label       TEXT,
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

-- ── Check in / out (replaces ckeck-in-out Worker + checkinout logs) ─────────
CREATE TABLE IF NOT EXISTS check_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT NOT NULL,
  type      TEXT NOT NULL,               -- in | out
  site      TEXT,
  job_number TEXT,
  lat       REAL,
  lon       REAL,
  at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_check_user_at ON check_events(username, at);

-- ── Hours / timesheets / labour planning: intentionally NOT modelled here
--    (handled by separate / later systems).

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

-- ── Vehicles (replaces vehicles, vehicles-fuel, vans/van-scores json) ───────
CREATE TABLE IF NOT EXISTS vehicles (
  reg     TEXT PRIMARY KEY,
  driver  TEXT
);
CREATE TABLE IF NOT EXISTS van_scores (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  driver   TEXT,
  van      TEXT,
  mileage  REAL,
  trips    INTEGER,
  van_check INTEGER DEFAULT 0,
  score    INTEGER,
  trend    TEXT,
  week_of  TEXT
);

-- ── Purchase orders: intentionally NOT modelled here.
--    POs will be handled by a separate external system.

-- ── Sites (replaces mostlane-sites + sites.json) ────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  job_number TEXT PRIMARY KEY,
  site_name  TEXT,
  site_type  TEXT,
  status     TEXT DEFAULT 'Active',
  address    TEXT,
  lat        REAL,
  lon        REAL,
  mileage    REAL,
  drive_time TEXT
);

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

-- ── Compliance (replaces mostlane-pos /Compliance + Compliance/*.json) ──────
CREATE TABLE IF NOT EXISTS compliance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client     TEXT,                         -- cobra | wenzels | retail | els | ...
  site       TEXT,
  doc_type   TEXT,
  status     TEXT,
  file_link  TEXT,
  payload    TEXT,                         -- JSON blob
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Projects (replaces projects-ml-portal) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,
  status     TEXT,
  payload    TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Generic activity log (replaces activity-log.json) ───────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  action   TEXT,
  detail   TEXT,
  at       TEXT DEFAULT (datetime('now'))
);
