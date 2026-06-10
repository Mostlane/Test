#!/usr/bin/env node
// Convert the portal's existing JSON files into a seed.sql you can load into D1.
//
//   node migrate-json-to-sql.mjs            # reads ../*.json, writes ./seed.sql
//   npx wrangler d1 execute mostlane --file=./seed.sql --remote
//
// Safe to re-run: uses INSERT OR REPLACE. Only migrates the files with clean,
// well-known shapes; the bespoke modules (SLA, compliance, projects) come over
// once their Worker logic is ported.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const q = (v) => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const yn = (v) => String(v).toLowerCase() === "yes" ? 1 : 0;

function read(name) {
  const p = join(ROOT, name);
  if (!existsSync(p)) { console.warn("skip (missing):", name); return null; }
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { console.warn("skip (bad JSON):", name, e.message); return null; }
}

// ── Users + permissions ─────────────────────────────────────────────────────
const PERMS = ["FullAccess","Users","DeviceAdmin","CheckInOut","Vehicles","Holiday",
  "HolidayAdmin","EngineersHoursMenu","HoursDashboard","PurchaseOrders","Sites",
  "AddSite","Assets","MyDocuments","Weekly","Forms","Compliance","Projects",
  "ProjectsAdmin","TimesheetAdmin","LabourPlanning","SLA"];

const usersDoc = read("users.json");
if (usersDoc?.Users) {
  for (const u of usersDoc.Users) {
    if (!u.Username || !u.Username.trim() || u.Username.trim() === ".") continue; // skip blank/corrupt row
    out.push(`INSERT OR REPLACE INTO users (engineer_number, first_name, last_name, username, email, password_hash, password_algo, vehicle_assigned, employment_type, status, sharepoint_path) VALUES (${q(u.EngineerNumber)}, ${q(u.FirstName)}, ${q(u.LastName)}, ${q(u.Username)}, ${q(u.Email)}, ${q(u.HashedPassword)}, 'sha256', ${q(u.VehicleAssigned)}, ${q(u.EmploymentType)}, ${q(u.Status || "Active")}, ${q(u.SharePointPath)});`);
    for (const p of PERMS) {
      if (p in u) out.push(`INSERT OR REPLACE INTO user_permissions (username, permission, value) VALUES (${q(u.Username)}, ${q(p)}, ${yn(u[p])});`);
    }
  }
}

// ── Purchase orders, suppliers, sites, vehicles, check-in/out, hours, labour,
//    compliance, projects: intentionally skipped (separate / later systems).

// ── Assets (blob model: full JSON in `data`). NOTE: this is repo seed/test
//    data; the live assets live in the assets Worker's ASSETS_KV and should be
//    brought over via the KV export at cutover (see README "Migrating KV data").
for (const a of read("assets/assets.json") || [])
  out.push(`INSERT OR REPLACE INTO assets (id, assigned_to, data) VALUES (${q(a.id)}, ${q(a.assignedTo)}, ${q(JSON.stringify(a))});`);

// ── Holidays: NOT migrated from repo JSON. Live holiday data lives in the
//    mostlane-holidays Worker's KV (HOLIDAYS_KV / HOLIDAY_CONFIG_KV), and the
//    repo's holiday-log.json is stale sample data with no year/id/days. Use the
//    KV export step (see README "Migrating KV data") instead.

// ── Hours / timesheets / labour: intentionally skipped (separate systems).

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "seed.sql"), out.join("\n") + "\n");
console.log(`Wrote seed.sql with ${out.length} statements.`);
