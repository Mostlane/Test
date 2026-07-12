// Tenant isolation — the single choke-point that keeps one company's data
// walled off from another's.
//
// The portal is multi-tenant: every data row carries a `tenant_id`, and a
// request may only ever touch its OWN tenant's rows. Rather than trust every
// hand-written query to remember `AND tenant_id = ?`, routes go through
// `tenantDB(env, tenantId)`. Its `.prepare()` is identical to `env.DB.prepare()`
// EXCEPT it throws if a query references a tenant-scoped table without
// mentioning `tenant_id`. That turns a silent cross-tenant data leak (the one
// class of bug that matters most in a SaaS) into a loud error the isolation
// tests catch immediately.
//
// The tenant itself is always server-derived (from the session, or — for
// pre-login public routes — from the request host), NEVER from anything the
// browser can set in a body or query string.

// Every table that holds per-company data. The `tenants` registry itself is
// deliberately NOT here — it's the cross-tenant index and is only ever touched
// by tenant-resolution / super-admin code.
export const TENANT_TABLES = new Set([
  "users", "user_permissions", "sessions", "shifts", "office_shifts",
  "customers", "sites", "oncall_log", "daily_logs", "vehicle_checks",
  "password_resets", "devices", "login_history", "holidays",
  "holiday_system_days", "holiday_allowance", "holiday_log", "assets",
  "asset_transfers", "asset_transfer_requests", "sla_jobs", "app_config",
  "portal_keys", "key_log", "notify_log", "audit_log", "hs_documents",
]);

// Today there is exactly one tenant, so anything that arrives before a session
// exists (login, onboard, password reset) belongs to Tenant 1. This function is
// the Phase-2 seam: it will map the request host (acme.<product>.com) to the
// right tenant row once self-serve signup exists. Kept async for that future.
export const DEFAULT_TENANT_ID = 1;
export async function resolveTenantId(env, request) {
  // Phase 2: look up tenants by slug from the Host header here.
  return DEFAULT_TENANT_ID;
}

// Finds the table after FROM / INTO / UPDATE / JOIN so we can tell whether a
// query touches tenant-scoped data.
const TABLE_RE = /\b(?:from|into|update|join)\s+([a-z_][a-z0-9_]*)/gi;

// Throws if `sql` reads or writes a tenant table but never mentions tenant_id.
export function assertTenantScoped(sql) {
  const s = String(sql);
  const touched = new Set();
  let m;
  TABLE_RE.lastIndex = 0;
  while ((m = TABLE_RE.exec(s))) {
    const t = m[1].toLowerCase();
    if (TENANT_TABLES.has(t)) touched.add(t);
  }
  if (touched.size && !/tenant_id/i.test(s)) {
    throw new Error(
      `tenant guard: query touches ${[...touched].join(", ")} without tenant_id — ` +
      s.replace(/\s+/g, " ").trim().slice(0, 140)
    );
  }
}

// A tenant-scoped DB handle. Drop-in for env.DB in route code:
//   const db = tenantDB(env, tenantId);
//   await db.prepare("SELECT * FROM users WHERE tenant_id=? AND username=?")
//           .bind(db.tenantId, username).first();
// - db.tenantId : the caller's tenant (bind it into every query)
// - db.prepare  : guarded prepare (throws on an unscoped tenant-table query)
// - db.batch    : env.DB.batch (its statements were already guarded at prepare)
// - db.unscoped : raw env.DB, for the `tenants` registry / super-admin only
export function tenantDB(env, tenantId) {
  if (tenantId === undefined || tenantId === null) {
    throw new Error("tenantDB: tenantId is required");
  }
  return {
    tenantId,
    unscoped: env.DB,
    prepare(sql) {
      assertTenantScoped(sql);
      return env.DB.prepare(sql);
    },
    batch(stmts) {
      return env.DB.batch(stmts);
    },
  };
}
