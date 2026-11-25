// Linked certificates, Make current, In pack, and "a new upload retires an old
// linked set" — drives the real compliance.js handler on a real SQLite.
// Run:  node --no-warnings worker/tools/test-compliance-links.mjs
import { DatabaseSync } from "node:sqlite";
import * as compliance from "../src/routes/compliance.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
function d1(db) {
  const wrap = (sql) => { let binds = []; const st = {
    bind(...a) { binds = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
  }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); } };
}
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE compliance_stores (tenant_id INTEGER, scheme TEXT, code TEXT, category TEXT, name TEXT, postcode TEXT, due TEXT, active INTEGER DEFAULT 1, meta TEXT, updated_at TEXT, site_number TEXT, PRIMARY KEY(tenant_id,scheme,code));
  CREATE TABLE sites (tenant_id INTEGER, client TEXT, site_number TEXT, site_name TEXT, postcode TEXT, active INTEGER, job_number TEXT, data TEXT, updated_at TEXT);
  CREATE TABLE app_config (tenant_id, key TEXT UNIQUE, value);
  INSERT INTO compliance_stores VALUES (1,'coop','0200','ELS','Test store','PO1 1AA','{"fiveYear":"2026-01-01","pv":"2027-01-01"}',1,'{}','',  '0200');`);
const r2 = new Map();
const env = { DB: d1(db), COMPLIANCE_IMPORT_TOKEN: "tok", PORTAL_BRIDGE_SECRET: "s3cret",
  JOB_FILES: { async put(k, v) { r2.set(k, v); }, async get(k) { return r2.has(k) ? { body: "x", httpMetadata: {} } : null; }, async delete(k) { r2.delete(k); } } };
const H = { Authorization: "Bearer tok" };
let tick = 0;
async function upload(type, name, extra = {}) {
  const fd = new FormData();
  fd.append("file", new File(["%PDF"], name, { type: "application/pdf" })); fd.append("code", "0200"); fd.append("type", type);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  await new Promise(r => setTimeout(r, 3)); tick++;
  const url = new URL("https://x/compliance/file?scheme=coop");
  const res = await compliance.handle(new Request(url, { method: "POST", headers: H, body: fd }), env, null, url, null);
  return res.json();
}
async function post(path, body) {
  const url = new URL("https://x/compliance" + path + "?scheme=coop");
  const res = await compliance.handle(new Request(url, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, null, url, null);
  return res.json();
}
async function files() {
  const url = new URL("https://x/compliance/files?scheme=coop&code=0200");
  const res = await compliance.handle(new Request(url, { headers: H }), env, null, url, null);
  return (await res.json()).files;
}
const cur = (fs, t) => (fs[t] || []).filter(f => f.current).map(f => f.filename).sort().join(",");

const a = await upload("fiveYear", "eicr-unsat.pdf", { bump: "1", date: "2026-01-10" });
ok(a.ok && a.id, "upload EICR");
let f = await files(); ok(cur(f, "fiveYear") === "eicr-unsat.pdf", "EICR current");
const b = await upload("fiveYear", "eic-remedials.pdf", { link: "1" });
ok(b.linked === 2, "link reply says 2 linked");
f = await files(); ok(cur(f, "fiveYear") === "eic-remedials.pdf,eicr-unsat.pdf", "remedial cert + EICR both current");
const due1 = JSON.parse(db.prepare("SELECT due FROM compliance_stores WHERE code='0200'").get().due).fiveYear;
ok(due1 === "2031-01-10", "linked upload did not move the due date (EICR date set it): " + due1);
// a NEW cycle's EICR retires the linked pair
await upload("fiveYear", "eicr-2031.pdf", { bump: "1", date: "2031-01-05" });
f = await files(); ok(cur(f, "fiveYear") === "eicr-2031.pdf", "new upload replaces the old linked set");
ok(f.fiveYear.every(x => x.filename === "eicr-2031.pdf" || !x.pinned), "old pins cleared");
// make current
const old = f.fiveYear.find(x => x.filename === "eicr-unsat.pdf");
await post("/file-update", { id: old.id, makeCurrent: 1 });
f = await files(); ok(cur(f, "fiveYear") === "eicr-unsat.pdf", "Make current = that file alone");
// link toggle on two
const nw = f.fiveYear.find(x => x.filename === "eicr-2031.pdf");
await post("/file-update", { id: nw.id, pinned: 1 });
f = await files(); ok(cur(f, "fiveYear") === "eicr-2031.pdf,eicr-unsat.pdf", "🔗 tick adds a second current");
// in pack
const om = await upload("other", "PV-OM.pdf", { label: "PV install manual", inPack: "1" });
f = await files(); ok((f.other || []).find(x => x.id === om.id).inPack === 1, "in-pack set on upload");
await post("/file-update", { id: om.id, inPack: 0 });
f = await files(); ok((f.other || []).find(x => x.id === om.id).inPack === 0, "in-pack toggled off");
// an "other" upload never unpins certificates
await upload("other", "misc.pdf", { bump: "1" });
f = await files(); ok(cur(f, "fiveYear") === "eicr-2031.pdf,eicr-unsat.pdf", "Other upload leaves certificate links alone");
// export carries the link + extras
await post("/file-update", { id: om.id, inPack: 1 });
const eu = new URL("https://x/compliance/export?scheme=coop");
const ex = await (await compliance.handle(new Request(eu, { headers: H }), env, null, eu, null)).json();
const st = ex.stores[0];
ok(st.types.fiveYear.linked && st.types.fiveYear.files.length === 2, "export: linked pair");
ok(st.extras.length === 1 && st.extras[0].folder === "Other documents" && st.extras[0].file.url, "export: PV manual as extra with a link");
// ── Client login (Southern Co-op, compliance-only) ─────────────────────────
db.exec(`CREATE TABLE users (tenant_id INTEGER, username TEXT, profile TEXT);
  CREATE TABLE user_permissions (tenant_id INTEGER, username TEXT, permission TEXT, value INTEGER);
  INSERT INTO users VALUES (1,'Client Co','{"staffType":"client","clientOrg":"coop","clientRole":"compliance"}');
  INSERT INTO users VALUES (1,'Viewer','{"staffType":"field","complianceAccess":{"coop":"view"}}');`);
const sessOf = (u) => ({ tenantId: 1, user: { username: u } });
async function getAs(user, path) {
  const url = new URL("https://x/compliance" + path);
  const res = await compliance.handle(new Request(url), env, null, url, sessOf(user));
  return { status: res.status, j: await res.json() };
}
let g = await getAs("Client Co", "/files?scheme=coop&code=0200");
const visible = Object.values(g.j.files).flat().map(x => x.filename).sort().join(",");
ok(g.status === 200 && g.j.internal === false, "client: /files answers, marked not internal");
ok(visible === "PV-OM.pdf,eicr-2031.pdf,eicr-unsat.pdf", "client sees only current + in-pack docs: " + visible);
g = await getAs("Client Co", "/export?scheme=coop&code=0200");
ok(g.status === 200 && g.j.stores.length === 1 && g.j.stores[0].types.fiveYear.files.length === 2, "client: per-site pack");
g = await getAs("Viewer", "/export?scheme=coop&code=0200");
ok(g.status === 200 && g.j.stores.length === 1, "view-level staff: per-site pack allowed");
g = await getAs("Viewer", "/export?scheme=coop");
ok(g.status === 403, "view-level staff: whole-estate pack refused");
g = await getAs("Client Co", "/export?scheme=coop&code=9999");
ok(g.status === 404, "unknown store → 404");
g = await getAs("Client Co", "/files?scheme=fareham&code=0200");
ok(g.status === 403, "Co-op client can't read the Fareham chart");
g = await getAs("Client Co", "/site-files?site=0200");
ok(g.status === 403, "client refused on cross-scheme /site-files");
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
