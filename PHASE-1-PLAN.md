# Phase 1 — The Multi-Tenant Foundation (concrete plan)

**Goal:** make the portal tenant-aware, with your live company as **Tenant 1**, changing *nothing* about how it looks or works today. This is the only phase that gets harder the longer it's left, so it's the one to do first. Signup, billing, subdomains all come later and are untouched here.

Grounded in your actual code (`worker/src/index.js`, `worker/src/lib/auth.js`, the 12 route files, `schema.sql`).

---

## What Phase 1 delivers

- A `tenants` table, with your company inserted as Tenant 1.
- A `tenant_id` column on every data table, backfilled to `1`.
- Every request carries its tenant automatically (via the session you already have).
- Every database read/write is walled to the caller's tenant.
- An automated test that proves Tenant 2 can't see Tenant 1's data.

**What it deliberately does NOT do yet** (keeps risk low):
- No change to the 90+ HTML pages. With one tenant, everything defaults to Tenant 1 — the front end doesn't know or care.
- No change to how usernames work *yet*. They stay globally unique for now; we only switch to "unique per company" in Phase 2, when a second company can actually exist. Less to break today.
- No signup, no billing, no subdomains.

So Phase 1 is **backend-only**: a database migration + one updated `worker.js` you paste. That's the whole footprint.

---

## The four changes

### 1. Schema — add the tenant layer
```sql
CREATE TABLE tenants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT UNIQUE,
  company_name TEXT NOT NULL,
  status       TEXT DEFAULT 'active',
  branding     TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
INSERT INTO tenants (id, slug, company_name, status) VALUES (1, 'mostlane', 'Mostlane', 'active');

-- Add tenant_id to every data table, defaulting existing rows to Tenant 1:
ALTER TABLE users            ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_permissions ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions         ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
-- ...same one line for: shifts, office_shifts, customers, sites, oncall_log,
--    daily_logs, vehicle_checks, password_resets, devices, login_history,
--    holidays, holiday_system_days, holiday_allowance, holiday_log, assets,
--    asset_transfers, asset_transfer_requests, sla_jobs, app_config,
--    portal_keys, key_log, notify_log, audit_log
```
Because every `ADD COLUMN` has `DEFAULT 1`, **all your existing data is instantly and correctly stamped as Tenant 1 — no data moves, nothing is at risk of loss.** This is the "backfill" — it's this, not a transfer.

### 2. Session → tenant binding (one small change, big leverage)
Your `requireSession()` (`lib/auth.js:82`) already loads the user on every request. We extend it to return the tenant too:
```js
// lib/auth.js — requireSession now also returns tenantId, read from the session row
return { session: row, user, tenantId: row.tenant_id };
```
`createSession()` records `tenant_id` (taken from the user's row at login). The tenant is therefore **server-derived and un-fakeable** — it never comes from the URL or anything the browser sends.

### 3. The query choke-point (this is the safety mechanism)
Add one helper the routes use instead of raw `env.DB`:
```js
// lib/tenantdb.js — a thin wrapper that refuses to run a tenant query
// without the tenant filter. Routes get `db` already scoped to their tenant.
export function tenantDB(env, tenantId) { ... }
```
Then each route swaps `env.DB.prepare("... WHERE username = ?")` for the scoped version, which appends `AND tenant_id = ?` automatically. Individual handlers can't "forget" the filter because they never write it by hand.

### 4. Backfill + tenant-stamp on writes
Existing rows: handled by the `DEFAULT 1` above. New rows: every `INSERT` gains the caller's `tenant_id`. Mechanical, one edit per insert.

---

## How invasive is it, really?

Twelve route files get a mechanical pass (swap `env.DB` for the scoped `db`, add `tenant_id` to inserts). Rough size, so you can see it's bounded:

| File | Lines | Nature of change |
|---|---|---|
| `lib/auth.js` | 108 | session→tenant binding (the important one) |
| `lib/tenantdb.js` | *new* | the choke-point helper |
| `index.js` | 184 | pass tenant into handlers + audit rows get tenant_id |
| `routes/auth.js` | 230 | login resolves tenant; passwords scoped |
| `routes/users.js` | 353 | user CRUD + permissions scoped |
| `routes/assets.js` | 621 | assets/transfers scoped |
| `routes/sla.js` | 621 | jobs scoped |
| `routes/holidays.js` | 537 | holidays scoped |
| `routes/sites.js` | 309 | sites/customers scoped |
| `routes/office.js` | 249 | clock scoped |
| `routes/portal.js` | 210 | settings/oncall/prefs/audit scoped |
| `routes/devices.js` | 195 | devices scoped |
| `routes/keys.js` | 149 | keys scoped |
| `routes/theme.js` | 101 | theme scoped |

It's repetitive, low-cleverness work — exactly the kind that's safe to do carefully and test hard. No table is restructured; no feature logic changes.

---

## How it gets tested (zero risk to your live system)

1. Build the whole thing on the `claude/multi-tenant-saas-design` branch.
2. Create a **throwaway test D1** (not your live `mostlane` database), load a copy of your schema + a bit of sample data as Tenant 1, and **add a fake Tenant 2**.
3. Run the Playwright harness: log in as Tenant 2, attempt to read Tenant 1's users/assets/holidays/sla — every attempt must return nothing. Log in as Tenant 1, confirm everything still works exactly as now.
4. `node --check` the worker; confirm the bundle's expected tail.
5. Only then do we touch anything live.

---

## Cutover (the part that involves you)

1. I run the schema migration (the `ALTER`s above) on your live `mostlane` D1 via the connector — **with your explicit go-ahead**. It's additive only (new columns/table), so it can't damage or drop existing data, and the old worker keeps running fine against the new columns until you deploy.
2. I send you the rebuilt **`worker.js`** (commit hash + line/byte count + expected tail, per your usual convention).
3. You paste it into Cloudflare → mostlane-api → Edit code → **Deploy**.
4. We watch the activity log / a couple of pages to confirm normal operation.

**Rollback:** if anything looks off after deploy, you paste the previous worker back and you're exactly where you started — the extra `tenant_id` columns sitting unused do no harm.

---

## The only ongoing change for you

After this, manual `INSERT`s you type in the D1 console need `tenant_id = 1`. That's the sole day-to-day difference. Everything the app does, I handle.

---

## The one thing I need from you to start

A **green light on timing** — "build it now" vs "roll out to my team first, then build in a couple of weeks." Either is fine; the build itself and the cutover are the same amount of work regardless, because the backfill is trivial at any data volume.

Give me the word and I'll start on the branch + a throwaway test DB. **Nothing on your live system changes until you paste the worker — and I'll ask before I run the live migration.**
