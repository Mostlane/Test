// Runtime tenant-isolation test.
//
// Drives real route handlers through the REAL tenant guard (lib/tenantdb.js)
// with a mock D1, once as Tenant 1 and once as Tenant 2. It proves two things
// the static audit cannot:
//   1. Every query a handler actually composes (including SQL built by string
//      concatenation) passes the guard — i.e. no tenant-table query reaches the
//      DB without a tenant_id filter (the guard throws if one does).
//   2. Wherever a tenant_id filter is present, the value BOUND is the caller's
//      own tenant — never the other tenant's.
//
// Run:  node worker/tools/test-isolation.mjs

import { TENANT_TABLES } from "../src/lib/tenantdb.js";
import * as users from "../src/routes/users.js";
import * as assets from "../src/routes/assets.js";
import * as holidays from "../src/routes/holidays.js";
import * as devices from "../src/routes/devices.js";
import * as sites from "../src/routes/sites.js";
import * as keys from "../src/routes/keys.js";
import * as portal from "../src/routes/portal.js";
import * as office from "../src/routes/office.js";
import * as hs from "../src/routes/hs.js";
import * as vancheck from "../src/routes/vancheck.js";

const TABLE_RE = /\b(?:from|into|update|join)\s+([a-z_][a-z0-9_]*)/gi;
function tablesIn(sql) {
  const out = new Set(); let m; TABLE_RE.lastIndex = 0;
  while ((m = TABLE_RE.exec(sql))) if (TENANT_TABLES.has(m[1].toLowerCase())) out.add(m[1].toLowerCase());
  return out;
}

// A mock D1 that records every prepared statement + its binds, and returns
// canned rows good enough for admin-gated handlers to reach their data queries.
function makeEnv(tenantId) {
  const calls = [];
  const admin = { username: "admin", tenant_id: tenantId, profile: "{}", status: "Active", first_name: "Ad", last_name: "Min" };
  const db = {
    prepare(sql) {
      let binds = [];
      const stmt = {
        bind(...a) { binds = a; return stmt; },
        async first() {
          calls.push({ sql, binds });
          if (/FROM sessions/i.test(sql)) return { token: "T", username: "admin", tenant_id: tenantId, device_id: null };
          if (/FROM users/i.test(sql)) return admin;
          if (/COUNT\(\*\)/i.test(sql)) return { n: 0, count: 0 };
          return null;
        },
        async all() {
          calls.push({ sql, binds });
          if (/FROM user_permissions/i.test(sql)) {
            // Grant every admin gate so handlers proceed to their data queries.
            return { results: ["FullAccess", "Users", "DeviceAdmin", "AssetAdmin",
              "HolidayAdmin", "OfficeTimesheet", "TimesheetAdmin"].map(permission => ({ permission, value: 1, username: "admin" })) };
          }
          return { results: [] };
        },
        async run() { calls.push({ sql, binds }); return { meta: { last_row_id: 1 } }; },
      };
      return stmt;
    },
    batch(stmts) { return Promise.all(stmts.map(s => s.run())); },
  };
  return { env: { DB: db, OWNER_USERNAME: "owner", MASTER_PASSWORD: "" }, calls };
}

function req(path, { method = "GET", headers = {} } = {}) {
  return new Request("https://api.test" + path, {
    method,
    headers: { "Authorization": "Bearer T", ...headers },
  });
}
function sessFor(tenantId) {
  return { user: { username: "admin", tenant_id: tenantId }, tenantId, session: { token: "T", device_id: null } };
}

// The endpoints we drive. Each is a GET that reaches at least one tenant-table
// read; admin gates are satisfied by the canned permissions above.
const CASES = [
  ["users   GET /users",              users,    "/users"],
  ["assets  GET /assets",             assets,   "/assets"],
  ["assets  GET /asset/transfers/pending", assets, "/asset/transfers/pending"],
  ["holiday GET /holiday/all",        holidays, "/holiday/all", { "X-User": "admin", "X-Role": "Admin" }],
  ["holiday GET /holiday/my",         holidays, "/holiday/my",  { "X-User": "admin", "X-Role": "Engineer" }],
  ["devices GET /device/admin-list",  devices,  "/device/admin-list"],
  ["sites   GET /get-sites",          sites,    "/get-sites"],
  ["keys    GET /keys",               keys,     "/keys"],
  ["portal  GET /audit/log",          portal,   "/audit/log"],
  ["office  GET /office/timesheet",   office,   "/office/timesheet?week=2026-07-06"],
  ["hs      GET /hs/docs",            hs,       "/hs/docs"],
  ["hs      GET /hs/docs?type=induction", hs,   "/hs/docs?type=induction"],
  ["hs      GET /hs/attention",       hs,       "/hs/attention"],
  ["hs      GET /hs/library",         hs,       "/hs/library"],
  ["vancheck GET /vancheck/attention", vancheck, "/vancheck/attention"],
  ["vancheck GET /vancheck/week",      vancheck, "/vancheck/week"],
];

let failures = 0, checkedQueries = 0, drove = 0;

for (const tenantId of [1, 2]) {
  const other = tenantId === 1 ? 2 : 1;
  for (const [label, mod, path, headers] of CASES) {
    const { env, calls } = makeEnv(tenantId);
    const url = new URL("https://api.test" + path);
    try {
      await mod.handle(req(path, { headers }), env, {}, url, sessFor(tenantId));
    } catch (e) {
      // A guard throw = an unscoped tenant-table query slipped through.
      console.log(`✗ [T${tenantId}] ${label} threw: ${e.message}`);
      failures++; continue;
    }
    drove++;
    for (const { sql, binds } of calls) {
      const flat = String(sql).replace(/\s+/g, " ");
      // Only scrutinise queries that carry a tenant_id filter (the global
      // by-token lookups in requireSession legitimately don't).
      if (!/tenant_id/i.test(flat)) continue;
      if (!tablesIn(flat).size) continue;
      checkedQueries++;
      if (!binds.includes(tenantId)) {
        console.log(`✗ [T${tenantId}] ${label}: tenant query did not bind own tenant (${tenantId}). binds=${JSON.stringify(binds)}\n    ${flat.slice(0, 120)}`);
        failures++;
      }
      if (binds.includes(other)) {
        console.log(`✗ [T${tenantId}] ${label}: query bound the OTHER tenant (${other})!\n    ${flat.slice(0, 120)}`);
        failures++;
      }
    }
  }
}

console.log(`\nDrove ${drove} handler invocations across 2 tenants; checked ${checkedQueries} tenant-scoped queries.`);
if (failures) { console.log(`❌ ${failures} isolation failure(s).`); process.exit(1); }
console.log("✅ Every tenant-scoped query passed the guard and bound only its own tenant.");
