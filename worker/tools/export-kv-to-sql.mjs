#!/usr/bin/env node
// ============================================================================
// export-kv-to-sql.mjs — one-off cutover migration: live KV  ->  D1 INSERTs.
// ----------------------------------------------------------------------------
// The holidays / SLA / assets data lives in the OLD workers' KV namespaces, not
// in the repo. This dumps those namespaces (via `wrangler kv`) and writes
// kv-seed.sql, which you then load into D1.
//
// PREREQS: `npx wrangler login`, and the KV namespace IDs of the old workers
// (Cloudflare dash -> Workers & Pages -> KV, or `npx wrangler kv namespace list`).
//
// USAGE (set the IDs you have; omit any you don't):
//   SLA_JOBS_ID=...  SLA_CONFIG_ID=... \
//   HOLIDAYS_ID=...  HOLIDAY_CONFIG_ID=... \
//   ASSETS_ID=...    ASSET_LOG_ID=... \
//   ASSET_ORIGIN="https://mostlane-assets.jamie-def.workers.dev" \
//   NEW_ORIGIN="https://mostlane-portal.<sub>.workers.dev" \
//   node tools/export-kv-to-sql.mjs
//
// Then:  npx wrangler d1 execute mostlane --file=./kv-seed.sql --remote
//
// Notes:
//  - Asset image URLs are rewritten from ASSET_ORIGIN -> NEW_ORIGIN so existing
//    photos keep resolving through the new worker.
//  - Re-runnable: uses INSERT OR REPLACE where there's a natural key.
// ============================================================================

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const E = process.env;
const out = [];
const q = v => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

function kvList(nsId) {
  const raw = execFileSync("npx", ["wrangler", "kv", "key", "list", `--namespace-id=${nsId}`], { encoding: "utf8", maxBuffer: 1 << 28 });
  return JSON.parse(raw).map(k => k.name);
}
function kvGet(nsId, key) {
  try {
    return execFileSync("npx", ["wrangler", "kv", "key", "get", key, `--namespace-id=${nsId}`], { encoding: "utf8", maxBuffer: 1 << 28 });
  } catch { return null; }
}
function getJSON(nsId, key) { const r = kvGet(nsId, key); try { return r ? JSON.parse(r) : null; } catch { return null; } }

// ── SLA: SLA_JOBS (key `job:<id>`) + SLA_CONFIG (`sla_config`) ───────────────
if (E.SLA_JOBS_ID) {
  for (const key of kvList(E.SLA_JOBS_ID)) {
    if (!key.startsWith("job:")) continue;
    const j = getJSON(E.SLA_JOBS_ID, key);
    if (!j || !j.id) continue;
    out.push(`INSERT OR REPLACE INTO sla_jobs (id, helpdesk_ref, description, priority, status, assigned_to, site_code, raised_at, target_at, scheduled_at, created_at, updated_at, closed_at, data) VALUES (${q(j.id)}, ${q(j.helpdeskRef)}, ${q(j.description)}, ${q(j.priority)}, ${q(j.status)}, ${q(j.assignedTo)}, ${q(j.siteCode)}, ${q(j.raisedAt)}, ${q(j.targetAt)}, ${q(j.scheduledAt)}, ${q(j.createdAt)}, ${q(j.updatedAt)}, ${q(j.closedAt)}, ${q(JSON.stringify(j))});`);
  }
}
if (E.SLA_CONFIG_ID) {
  const cfg = getJSON(E.SLA_CONFIG_ID, "sla_config");
  if (cfg) out.push(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('sla_config', ${q(JSON.stringify(cfg))});`);
}

// ── Holidays: HOLIDAYS_KV (`holiday:<id>`, `system:<...>`) + HOLIDAY_CONFIG ──
if (E.HOLIDAYS_ID) {
  for (const key of kvList(E.HOLIDAYS_ID)) {
    const j = getJSON(E.HOLIDAYS_ID, key);
    if (!j) continue;
    if (key.startsWith("holiday:")) {
      out.push(`INSERT OR REPLACE INTO holidays (id, username, engineer, year, start_date, end_date, days, type, notes, status, submitted_at, approved_by, decision_at, cancelled_by, cancel_note) VALUES (${q(j.id)}, ${q(j.username)}, ${q(j.engineer)}, ${j.year ?? "NULL"}, ${q(j.start)}, ${q(j.end)}, ${j.days ?? "NULL"}, ${q(j.type)}, ${q(j.notes)}, ${q(j.status)}, ${q(j.submittedAt)}, ${q(j.approvedBy)}, ${q(j.decisionAt)}, ${q(j.cancelledBy)}, ${q(j.cancelNote)});`);
    } else if (key.startsWith("system:")) {
      const kind = j.category === "Shutdown" ? "shutdown" : "bankholiday";
      out.push(`INSERT OR REPLACE INTO holiday_system_days (kind, year, date, username, id, engineer, label, days, category, worked, status, created_at, updated_by, updated_at) VALUES (${q(kind)}, ${j.year ?? "NULL"}, ${q(j.date)}, ${q(j.username)}, ${q(j.id)}, ${q(j.engineer)}, ${q(j.label)}, ${j.days ?? 1}, ${q(j.category)}, ${j.worked ? 1 : 0}, ${q(j.status)}, ${q(j.createdAt)}, ${q(j.updatedBy)}, ${q(j.updatedAt)});`);
    }
  }
}
if (E.HOLIDAY_CONFIG_ID) {
  for (const key of kvList(E.HOLIDAY_CONFIG_ID)) {
    const raw = kvGet(E.HOLIDAY_CONFIG_ID, key);
    if (!raw) continue;
    let m;
    if ((m = key.match(/^config:(\d+)$/))) {
      const j = JSON.parse(raw);
      out.push(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('holiday:config:${m[1]}', ${q(JSON.stringify(j))});`);
    } else if ((m = key.match(/^bankholidays:(\d+)$/))) {
      out.push(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('holiday:bankholidays:${m[1]}', ${q(raw)});`);
    } else if ((m = key.match(/^shutdown:(\d+)$/))) {
      out.push(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('holiday:shutdown:${m[1]}', ${q(raw)});`);
    } else if ((m = key.match(/^allowance:(\d+):(.+)$/))) {
      const j = JSON.parse(raw);
      if (Number.isFinite(Number(j.allowance)))
        out.push(`INSERT OR REPLACE INTO holiday_allowance (year, username, allowance) VALUES (${m[1]}, ${q(m[2])}, ${Number(j.allowance)});`);
    }
  }
}

// ── Assets: ASSETS_KV (key = id) + ASSET_LOG_KV (`<id>-<ts>`) ────────────────
const rewriteImages = (a) => {
  if (E.ASSET_ORIGIN && E.NEW_ORIGIN && Array.isArray(a.images))
    a.images = a.images.map(u => String(u).split(E.ASSET_ORIGIN).join(E.NEW_ORIGIN));
  return a;
};
if (E.ASSETS_ID) {
  for (const key of kvList(E.ASSETS_ID)) {
    const a = getJSON(E.ASSETS_ID, key);
    if (!a || !a.id) continue;
    rewriteImages(a);
    out.push(`INSERT OR REPLACE INTO assets (id, assigned_to, data) VALUES (${q(a.id)}, ${q(a.assignedTo)}, ${q(JSON.stringify(a))});`);
  }
}
if (E.ASSET_LOG_ID) {
  for (const key of kvList(E.ASSET_LOG_ID)) {
    const log = getJSON(E.ASSET_LOG_ID, key);
    if (!log || !log.assetID) continue;
    out.push(`INSERT INTO asset_transfers (asset_id, at, data) VALUES (${q(log.assetID)}, ${q(log.timestamp)}, ${q(JSON.stringify(log))});`);
  }
}

writeFileSync("kv-seed.sql", out.join("\n") + "\n");
console.log(`Wrote kv-seed.sql with ${out.length} statements.`);
