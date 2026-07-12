-- ============================================================================
-- Migration 001 — Multi-tenant foundation
-- ----------------------------------------------------------------------------
-- Turns the single-company portal into a multi-tenant one WITHOUT moving any
-- data: every existing row becomes Tenant 1 (Mostlane) via DEFAULT 1.
--
-- This file is for the EXISTING live `mostlane` D1 (built from the old schema).
-- Fresh databases should use schema.sql, which already includes tenant_id.
--
-- ADDITIVE ONLY — creates a table, adds columns, adds indexes. It cannot drop
-- or alter existing data. Run ONCE (ALTER ... ADD COLUMN errors if re-run
-- because the column already exists — that error is harmless proof it was
-- already applied).
--
-- Apply on the live DB via the D1 console / connector, statement by statement.
-- ============================================================================

-- ── The tenant registry ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT UNIQUE,               -- 'acme'  -> future acme.<product>.com
  company_name TEXT NOT NULL,
  status       TEXT DEFAULT 'active',     -- active | trialing | past_due | suspended | cancelled
  plan         TEXT DEFAULT 'standard',
  seat_limit   INTEGER,                   -- optional hard cap on users
  branding     TEXT,                      -- JSON: logo, accent colour, menu bg
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  trial_ends_at TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Your existing company is Tenant 1. Every backfilled row below points here.
INSERT OR IGNORE INTO tenants (id, slug, company_name, status)
VALUES (1, 'mostlane', 'Mostlane', 'active');

-- ── Add tenant_id to every data table (existing rows default to Tenant 1) ────
ALTER TABLE users                    ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_permissions         ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions                 ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shifts                   ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE office_shifts            ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customers                ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sites                    ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE oncall_log               ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE daily_logs               ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vehicle_checks           ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE password_resets          ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices                  ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE login_history            ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE holidays                 ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE holiday_system_days      ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE holiday_allowance        ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE holiday_log              ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assets                   ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE asset_transfers          ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE asset_transfer_requests  ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sla_jobs                 ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_config               ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE portal_keys              ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE key_log                  ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notify_log               ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE audit_log                ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;

-- ── Tenant-first indexes for the hot lookup paths ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_tenant       ON users(tenant_id, username);
CREATE INDEX IF NOT EXISTS idx_perms_tenant       ON user_permissions(tenant_id, username);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant    ON sessions(tenant_id, username);
CREATE INDEX IF NOT EXISTS idx_devices_tenant     ON devices(tenant_id, username);
CREATE INDEX IF NOT EXISTS idx_holidays_tenant    ON holidays(tenant_id, year, status);
CREATE INDEX IF NOT EXISTS idx_assets_tenant      ON assets(tenant_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_atr_tenant         ON asset_transfer_requests(tenant_id, to_user, status);
CREATE INDEX IF NOT EXISTS idx_sla_tenant         ON sla_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sites_tenant       ON sites(tenant_id, client);
CREATE INDEX IF NOT EXISTS idx_appconfig_tenant   ON app_config(tenant_id, key);
CREATE INDEX IF NOT EXISTS idx_audit_tenant       ON audit_log(tenant_id, id);

-- ── app_config primary key note ─────────────────────────────────────────────
-- app_config was keyed by `key` alone. It now holds per-tenant rows, so the
-- worker reads/writes it as (tenant_id, key). The old PRIMARY KEY(key) still
-- exists on the live table; because Tenant 1 is the only tenant today there is
-- no collision. When onboarding a SECOND tenant, app_config must be rebuilt
-- with PRIMARY KEY(tenant_id, key) — handled in the Phase 2 migration, not now.
