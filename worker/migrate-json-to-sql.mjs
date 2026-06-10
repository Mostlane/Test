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

// ── Purchase orders & suppliers: intentionally skipped (separate system).

// ── Sites ───────────────────────────────────────────────────────────────────
for (const s of read("sites.json") || [])
  out.push(`INSERT OR REPLACE INTO sites (job_number, site_name, site_type, status, address, lat, lon, mileage, drive_time) VALUES (${q(s.jobNumber)}, ${q(s.siteName)}, ${q(s.siteType)}, ${q(s.status || "Active")}, ${q(s.address)}, ${s.lat ?? "NULL"}, ${s.lon ?? "NULL"}, ${s.mileage ?? "NULL"}, ${q(s.driveTime)});`);

// ── Vehicles + scores ───────────────────────────────────────────────────────
for (const v of read("vans.json") || [])
  if (v.reg) out.push(`INSERT OR REPLACE INTO vehicles (reg, driver) VALUES (${q(v.reg)}, ${q(v.driver)});`);
for (const v of read("van-scores.json") || [])
  out.push(`INSERT INTO van_scores (driver, van, mileage, trips, van_check, score, trend) VALUES (${q(v.driver)}, ${q(v.van)}, ${v.mileage ?? "NULL"}, ${v.trips ?? "NULL"}, ${v.van_check ? 1 : 0}, ${v.score ?? "NULL"}, ${q(v.trend)});`);

// ── Assets ──────────────────────────────────────────────────────────────────
for (const a of read("assets/assets.json") || [])
  out.push(`INSERT OR REPLACE INTO assets (id, name, category, serial, value, assigned_to, shared) VALUES (${q(a.id)}, ${q(a.name)}, ${q(a.category)}, ${q(a.serial)}, ${q(a.value)}, ${q(a.assignedTo)}, ${q(a.shared)});`);

// ── Holidays ────────────────────────────────────────────────────────────────
for (const h of read("holiday-log.json") || [])
  out.push(`INSERT INTO holidays (name, start, end, type, status, notes) VALUES (${q(h.name)}, ${q(h.start)}, ${q(h.end)}, ${q(h.type)}, ${q(h.status || "Pending")}, ${q(h.notes)});`);

// ── Hours / timesheets / labour: intentionally skipped (separate systems).

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "seed.sql"), out.join("\n") + "\n");
console.log(`Wrote seed.sql with ${out.length} statements.`);
