#!/usr/bin/env node
/**
 * Automated D1 backup — exports each live database to a gzipped .sql file.
 *
 * Uses Cloudflare's official D1 export API (the same mechanism as the dashboard
 * "Export" button): POST a polling request, wait for it to finish, download the
 * signed URL it returns, gzip it, and drop it in ./out/.
 *
 * Dependency-free (Node 20 global fetch + zlib). Prints ONLY metadata
 * (names + sizes) — never SQL content, never the signed URL (which carries a
 * token) — because this runs in the PUBLIC repo's Actions logs.
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN   (required) — token with D1 read/export permission
 *   CLOUDFLARE_ACCOUNT_ID  (required)
 *   BACKUP_DBS             (optional) — override the DB list, "name:id,name:id"
 *
 * Exit codes: 0 all good · 2 nothing to do (no token) · 1 an export failed.
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";

// The three LIVE databases. (The empty spares — payroll/hs/drainage/jobs — are
// deliberately skipped.) Override with BACKUP_DBS if the set ever changes.
const DEFAULT_DBS = [
  { name: "mostlane",     id: "e483b3b5-2cfd-4742-ae51-427c31598c87" },
  { name: "mostlane-po",  id: "bcaf5f51-3085-4cdf-a993-42278893c313" },
  { name: "sitelog-db",   id: "1e891155-dd61-4e0e-90fe-ad5f4895f2c8" },
];
const DBS = process.env.BACKUP_DBS
  ? process.env.BACKUP_DBS.split(",").map(s => { const [name, id] = s.split(":"); return { name: name.trim(), id: (id || "").trim() }; }).filter(d => d.id)
  : DEFAULT_DBS;

const YM = new Date().toISOString().slice(0, 7);          // 2026-08
const DAY = new Date().toISOString().slice(0, 10);        // 2026-08-20
const OUT = "out";
const API = "https://api.cloudflare.com/client/v4";
const mb = n => (n / 1048576).toFixed(1) + " MB";
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!TOKEN || !ACCOUNT) {
  console.log("⏭  No CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID set — backup not configured yet. Skipping (this is not an error).");
  process.exit(2);
}

async function cf(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors && j.errors.map(e => e.message).join("; ")) || ("HTTP " + r.status);
    throw new Error(msg);
  }
  return j.result || {};
}

// Poll the export to completion and return the signed download URL.
async function exportDb(db) {
  const base = `/accounts/${ACCOUNT}/d1/database/${db.id}/export`;
  let res = await cf(base, { output_format: "polling", dump_options: {} });
  const started = Date.now();
  // The result carries a signed_url once ready; until then it hands back an
  // at_bookmark to poll with. Cap at ~10 minutes.
  while (!res.signed_url) {
    if (Date.now() - started > 10 * 60 * 1000) throw new Error("export timed out after 10 min");
    if (res.error) throw new Error(res.error);
    await sleep(2500);
    res = await cf(base, { output_format: "polling", current_bookmark: res.at_bookmark });
  }
  return res.signed_url;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let failed = 0;
  const done = [];
  for (const db of DBS) {
    process.stdout.write(`• ${db.name}: exporting… `);
    try {
      const url = await exportDb(db);                    // signed URL — never logged
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const gz = gzipSync(buf, { level: 9 });
      const file = `${OUT}/${db.name}-${DAY}.sql.gz`;
      writeFileSync(file, gz);
      console.log(`done — ${mb(buf.length)} → ${mb(gz.length)} gzipped`);
      done.push({ name: db.name, raw: buf.length, gz: gz.length, file });
    } catch (e) {
      failed++;
      console.log(`FAILED — ${e.message}`);
    }
  }
  // A tiny manifest travels with the dumps (no data, just what/when/how-big).
  writeFileSync(`${OUT}/manifest-${DAY}.json`, JSON.stringify({ month: YM, day: DAY, databases: done.map(d => ({ name: d.name, bytes: d.raw, gzipBytes: d.gz })) }, null, 2));
  console.log(`\n${done.length}/${DBS.length} databases exported for ${YM}.`);
  if (failed) { console.error(`✖ ${failed} export(s) failed — see above.`); process.exit(1); }
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
