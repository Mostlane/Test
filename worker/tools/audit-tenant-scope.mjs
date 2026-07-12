// Static tenant-isolation audit.
// Scans every SQL string literal in worker/src for a reference to a
// tenant-scoped table (after FROM/INTO/UPDATE/JOIN) and fails if that statement
// does not also mention `tenant_id`. This is the compile-time twin of the
// runtime guard in lib/tenantdb.js.
//
// A short, documented ALLOWLIST covers the handful of queries that are
// deliberately cross-tenant or keyed by a global secret (login, token lookups,
// the time-based audit prune) plus SQL whose tenant filter is appended by
// string concatenation (the runtime guard validates those on the final text).
//
// Run:  node worker/tools/audit-tenant-scope.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TENANT_TABLES = new Set([
  "users", "user_permissions", "sessions", "shifts", "office_shifts",
  "customers", "sites", "oncall_log", "daily_logs", "vehicle_checks",
  "password_resets", "devices", "login_history", "holidays",
  "holiday_system_days", "holiday_allowance", "holiday_log", "assets",
  "asset_transfers", "asset_transfer_requests", "sla_jobs", "app_config",
  "portal_keys", "key_log", "notify_log", "audit_log", "hs_documents",
]);

// Deliberately-unscoped statements, each with the reason it is safe. Matched as
// substrings against the normalised (whitespace-collapsed) SQL.
const ALLOW = [
  ["FROM sessions WHERE token = ?", "session lookup by token (the global session secret); the tenant comes FROM the matched row"],
  ["FROM password_resets WHERE token = ?", "reset lookup by single-use token; tenant comes from the matched row"],
  ["UPDATE password_resets SET used = 1 WHERE token = ?", "consume reset token (global single-use secret)"],
  ["FROM users WHERE lower(username) = lower(?1)", "login findUser — pre-session, cross-tenant by design (usernames globally unique this phase)"],
  ["DELETE FROM audit_log WHERE at < ?", "12-month retention prune — intentionally tenant-agnostic housekeeping"],
  ['SELECT * FROM daily_logs', "base literal; WHERE tenant_id=? is appended by concatenation and validated by the runtime guard"],
  ['FROM audit_log WHERE', "activity-log viewer; conds seeded with tenant_id=? (bound db.tenantId), appended by concatenation"],
  ['FROM notify_log WHERE', "notification-log viewer; conds seeded with tenant_id=? (bound db.tenantId), appended by concatenation"],
  ['SELECT * FROM shifts', "base literal; WHERE tenant_id=? is appended by concatenation and validated by the runtime guard"],
];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

// Comment-aware string scanner: walks the source char by char, tracking line
// comments, block comments and string state, so apostrophes inside comments and
// `//` inside strings don't confuse it. Returns { text, index } per literal.
function extractStrings(code) {
  const out = [];
  let i = 0; const n = code.length;
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === "/" && d === "/") { i += 2; while (i < n && code[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c, start = i + 1; i++;
      let buf = "";
      while (i < n) {
        if (code[i] === "\\") { buf += code[i + 1] || ""; i += 2; continue; }
        if (code[i] === quote) break;
        buf += code[i]; i++;
      }
      out.push({ text: buf, index: start });
      i++; continue;
    }
    i++;
  }
  return out;
}

const TABLE_RE = /\b(?:from|into|update|join)\s+([a-z_][a-z0-9_]*)/gi;

let violations = 0, checked = 0, allowed = 0;
for (const file of walk(SRC)) {
  const code = readFileSync(file, "utf8");
  const rel = relative(join(SRC, ".."), file);
  const lineAt = idx => code.slice(0, idx).split("\n").length;
  for (const { text, index } of extractStrings(code)) {
    if (!/\b(from|into|update|join)\b/i.test(text)) continue;
    const touched = new Set(); let mm; TABLE_RE.lastIndex = 0;
    while ((mm = TABLE_RE.exec(text))) if (TENANT_TABLES.has(mm[1].toLowerCase())) touched.add(mm[1].toLowerCase());
    if (!touched.size) continue;
    const flat = text.replace(/\s+/g, " ").trim();
    if (/tenant_id/i.test(flat)) { checked++; continue; }
    const allow = ALLOW.find(([frag]) => flat.includes(frag));
    if (allow) { allowed++; continue; }
    violations++;
    console.log(`✗ ${rel}:${lineAt(index)}  [${[...touched].join(", ")}]`);
    console.log(`    ${flat.slice(0, 140)}`);
  }
}

console.log(`\nScanned tenant-table statements: ${checked} scoped, ${allowed} documented exceptions.`);
if (violations) { console.log(`❌ ${violations} statement(s) missing a tenant_id filter.`); process.exit(1); }
console.log("✅ Every tenant-table statement is either tenant-scoped or a documented exception.");
