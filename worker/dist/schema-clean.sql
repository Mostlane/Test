CREATE TABLE IF NOT EXISTS users (
id              INTEGER PRIMARY KEY AUTOINCREMENT,
engineer_number TEXT,
first_name      TEXT,
last_name       TEXT,
username        TEXT NOT NULL UNIQUE,
email           TEXT,
password_hash   TEXT,
password_algo   TEXT DEFAULT 'sha256',
vehicle_assigned TEXT,
employment_type TEXT,
status          TEXT DEFAULT 'Active',
sharepoint_path TEXT,
must_change_password INTEGER DEFAULT 0,
created_at      TEXT DEFAULT (datetime('now')),
updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE TABLE IF NOT EXISTS user_permissions (
username   TEXT NOT NULL,
permission TEXT NOT NULL,
value      INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY (username, permission)
);
CREATE TABLE IF NOT EXISTS sessions (
token       TEXT PRIMARY KEY,
username    TEXT NOT NULL,
device_id   TEXT,
created_at  TEXT DEFAULT (datetime('now')),
expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE TABLE IF NOT EXISTS password_resets (
token      TEXT PRIMARY KEY,
username   TEXT NOT NULL,
expires_at TEXT NOT NULL,
used       INTEGER DEFAULT 0,
created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pwreset_username ON password_resets(username);
CREATE TABLE IF NOT EXISTS devices (
device_id   TEXT PRIMARY KEY,
username    TEXT NOT NULL,
label       TEXT,
registered_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_username ON devices(username);
CREATE TABLE IF NOT EXISTS login_history (
id        INTEGER PRIMARY KEY AUTOINCREMENT,
username  TEXT,
device_id TEXT,
ip        TEXT,
user_agent TEXT,
outcome   TEXT,
at        TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS holidays (
id           TEXT PRIMARY KEY,
username     TEXT NOT NULL,
engineer     TEXT,
year         INTEGER NOT NULL,
start_date   TEXT NOT NULL,
end_date     TEXT NOT NULL,
days         INTEGER,
type         TEXT,
notes        TEXT,
status       TEXT DEFAULT 'Pending',
submitted_at TEXT,
approved_by  TEXT,
decision_at  TEXT,
cancelled_by TEXT,
cancel_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_holidays_user_year ON holidays(username, year);
CREATE INDEX IF NOT EXISTS idx_holidays_year_status ON holidays(year, status);
CREATE TABLE IF NOT EXISTS holiday_system_days (
kind       TEXT NOT NULL,
year       INTEGER NOT NULL,
date       TEXT NOT NULL,
username   TEXT NOT NULL,
id         TEXT,
engineer   TEXT,
label      TEXT,
days       INTEGER DEFAULT 1,
category   TEXT,
worked     INTEGER DEFAULT 0,
status     TEXT,
created_at TEXT,
updated_by TEXT,
updated_at TEXT,
PRIMARY KEY (kind, year, date, username)
);
CREATE INDEX IF NOT EXISTS idx_sysdays_year_user ON holiday_system_days(year, username);
CREATE TABLE IF NOT EXISTS holiday_allowance (
year      INTEGER NOT NULL,
username  TEXT NOT NULL,
allowance INTEGER NOT NULL,
PRIMARY KEY (year, username)
);
CREATE TABLE IF NOT EXISTS holiday_log (
id         INTEGER PRIMARY KEY AUTOINCREMENT,
request_id TEXT,
action     TEXT,
by_user    TEXT,
at         TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assets (
id          TEXT PRIMARY KEY,
assigned_to TEXT,
data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_assigned ON assets(assigned_to);
CREATE TABLE IF NOT EXISTS asset_transfers (
id       INTEGER PRIMARY KEY AUTOINCREMENT,
asset_id TEXT NOT NULL,
at       TEXT,
data     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_tx_asset ON asset_transfers(asset_id);
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
data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sla_status   ON sla_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sla_assigned ON sla_jobs(assigned_to);
CREATE INDEX IF NOT EXISTS idx_sla_site     ON sla_jobs(site_code);
CREATE TABLE IF NOT EXISTS app_config (
key   TEXT PRIMARY KEY,
value TEXT NOT NULL
);
