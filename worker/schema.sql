-- ============================================================================
-- Mostlane Portal — D1 schema (single database for the whole portal)
-- Replaces: users.json, timesheets.json, holiday-*.json, vans.json,
--           van-scores.json, po-log.json, suppliers.json, sites.json,
--           assets/*.json, eicr-log*.json, activity-log.json, and the
--           per-Worker KV namespaces.
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

-- ── Hours / timesheets (replaces odd-water /Hours, average-hours,
--     labourhours, timesheet, mostlane-labour-api, timesheets.json) ──────────
CREATE TABLE IF NOT EXISTS timesheets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  engineer   TEXT NOT NULL,
  date       TEXT NOT NULL,
  start      TEXT,
  finish     TEXT,
  lunch_deducted INTEGER DEFAULT 0,
  travel_time REAL,
  job_type   TEXT,
  job_number TEXT,
  source     TEXT,                        -- which flow created it
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timesheets_eng_date ON timesheets(engineer, date);

-- ── Holidays (replaces mostlane-holidays, holiday-log/summary.json) ─────────
CREATE TABLE IF NOT EXISTS holidays (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,                  -- username
  start   TEXT NOT NULL,
  end     TEXT NOT NULL,
  type    TEXT,                           -- Annual Leave | Sick | Bank Holiday | ...
  status  TEXT DEFAULT 'Pending',         -- Pending | Approved | Rejected
  notes   TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_holidays_name ON holidays(name);

-- Per-user yearly allowance (replaces holiday-summary.json header figures)
CREATE TABLE IF NOT EXISTS holiday_allowance (
  username  TEXT PRIMARY KEY,
  available INTEGER DEFAULT 28,
  carried   INTEGER DEFAULT 0,
  year      INTEGER
);

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

-- ── Purchase orders (replaces mostlane-po + mostlane-pos + po-log.json) ─────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number   TEXT UNIQUE,
  engineer    TEXT,
  site        TEXT,
  supplier    TEXT,
  description TEXT,
  cost        TEXT,                        -- keep as text (existing data has "£x")
  gps         TEXT,
  status      TEXT,
  pdf_link    TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_po_site ON purchase_orders(site);

CREATE TABLE IF NOT EXISTS suppliers (
  supplier_number TEXT PRIMARY KEY,
  supplier_name   TEXT NOT NULL
);

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

-- ── Assets / plant (replaces mostlane-assets + assets/*.json) ───────────────
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  category    TEXT,
  serial      TEXT,
  value       TEXT,
  assigned_to TEXT,
  shared      TEXT
);
CREATE TABLE IF NOT EXISTS asset_transfers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id  TEXT,
  from_user TEXT,
  to_user   TEXT,
  at        TEXT DEFAULT (datetime('now'))
);

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

-- ── Labour planning (replaces mostlane-labour-api / labour-tracker) ─────────
CREATE TABLE IF NOT EXISTS labour_plan (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  engineer   TEXT,
  date       TEXT,
  site       TEXT,
  job_number TEXT,
  hours      REAL,
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
