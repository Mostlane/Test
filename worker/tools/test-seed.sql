-- Isolation test fixture: two tenants with deliberately overlapping data.
-- Tenant 1 = Mostlane (already inserted by schema.sql). Tenant 2 = Acme.
-- Each has a FullAccess admin, a plain user, and their own assets/holidays.
-- Both tenants even reuse the username "admin" to prove per-tenant scoping.

INSERT OR IGNORE INTO tenants (id, slug, company_name, status)
VALUES (2, 'acme', 'Acme Ltd', 'active');

-- ── Tenant 1 users ──────────────────────────────────────────────────────────
INSERT INTO users (tenant_id, username, first_name, last_name, email, status, password_algo)
VALUES (1, 'alice', 'Alice', 'One', 'alice@mostlane.test', 'Active', 'pbkdf2');
INSERT INTO users (tenant_id, username, first_name, last_name, email, status, password_algo)
VALUES (1, 'mostlane-admin', 'Mo', 'Admin', 'mo@mostlane.test', 'Active', 'pbkdf2');
INSERT INTO user_permissions (tenant_id, username, permission, value) VALUES (1, 'mostlane-admin', 'FullAccess', 1);

-- ── Tenant 2 users (note: reuses 'alice' as a different person) ──────────────
INSERT INTO users (tenant_id, username, first_name, last_name, email, status, password_algo)
VALUES (2, 'bob', 'Bob', 'Two', 'bob@acme.test', 'Active', 'pbkdf2');
INSERT INTO users (tenant_id, username, first_name, last_name, email, status, password_algo)
VALUES (2, 'acme-admin', 'Ada', 'Admin', 'ada@acme.test', 'Active', 'pbkdf2');
INSERT INTO user_permissions (tenant_id, username, permission, value) VALUES (2, 'acme-admin', 'FullAccess', 1);

-- ── Sessions (bypass login for endpoint tests) ──────────────────────────────
INSERT INTO sessions (tenant_id, token, username, expires_at) VALUES (1, 'TOKEN_T1_ADMIN', 'mostlane-admin', '2099-01-01T00:00:00Z');
INSERT INTO sessions (tenant_id, token, username, expires_at) VALUES (2, 'TOKEN_T2_ADMIN', 'acme-admin', '2099-01-01T00:00:00Z');

-- ── Assets ──────────────────────────────────────────────────────────────────
INSERT INTO assets (tenant_id, id, assigned_to, data)
VALUES (1, 'T1-ASSET', 'alice', '{"id":"T1-ASSET","name":"Mostlane Drill","assignedTo":"alice"}');
INSERT INTO assets (tenant_id, id, assigned_to, data)
VALUES (2, 'T2-ASSET', 'bob', '{"id":"T2-ASSET","name":"Acme Ladder","assignedTo":"bob"}');

-- ── Holidays ────────────────────────────────────────────────────────────────
INSERT INTO holidays (tenant_id, id, username, engineer, year, start_date, end_date, days, type, status, submitted_at)
VALUES (1, 'T1-HOL', 'alice', 'alice', 2026, '2026-08-01', '2026-08-05', 5, 'Holiday', 'Approved', '2026-07-01T00:00:00Z');
INSERT INTO holidays (tenant_id, id, username, engineer, year, start_date, end_date, days, type, status, submitted_at)
VALUES (2, 'T2-HOL', 'bob', 'bob', 2026, '2026-09-01', '2026-09-03', 3, 'Holiday', 'Approved', '2026-07-01T00:00:00Z');

-- ── Sites / customers ───────────────────────────────────────────────────────
INSERT INTO customers (tenant_id, id, name) VALUES (1, 'cust-t1', 'Mostlane Client');
INSERT INTO customers (tenant_id, id, name) VALUES (2, 'cust-t2', 'Acme Client');
INSERT INTO sites (tenant_id, client, site_number, site_name, data) VALUES (1, 'cust-t1', 'S1', 'Mostlane Site', '{}');
INSERT INTO sites (tenant_id, client, site_number, site_name, data) VALUES (2, 'cust-t2', 'S1', 'Acme Site', '{}');
