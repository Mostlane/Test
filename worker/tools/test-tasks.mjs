// Admin task list — the SHARED / office-wide intake tasks (a Concerto note to
// action, an unknown site to link) drive the real tasks.js handler against a REAL
// SQLite (node:sqlite) through a tiny D1-shaped shim. Covers:
//   • inbound `@office` → assigned to every office user + the owner, field excluded
//   • `shared` completion: one office person's Done clears it for EVERYONE
//   • undo on a shared task reopens it for everyone
//   • a normal (per-assignee) task is unaffected — one Done ≠ all done
// Run:  node --no-warnings worker/tools/test-tasks.mjs
import { DatabaseSync } from "node:sqlite";
import * as tasks from "../src/routes/tasks.js";

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
db.exec(`
  CREATE TABLE users (tenant_id, username, first_name, last_name, profile, status);
  CREATE TABLE user_permissions (tenant_id, username, permission, value);
  CREATE TABLE admin_tasks (id TEXT PRIMARY KEY, tenant_id TEXT, title, detail, assignees, recurrence,
    due_time, due_dow INTEGER, due_dom INTEGER, due_month INTEGER, due_date, area, auto_match,
    active INTEGER DEFAULT 1, created_by, created_at, updated_at, source, ext_key, category, ref_date, link, shared INTEGER DEFAULT 0);
  CREATE TABLE admin_task_done (tenant_id, task_id, username, period_key, done_at, done_by, PRIMARY KEY (task_id, username, period_key));
  CREATE TABLE audit_log (tenant_id, username, path, at, status);
  CREATE TABLE push_subscriptions (tenant_id, username, endpoint, p256dh, auth, ua);
`);
const uins = db.prepare("INSERT INTO users (tenant_id,username,first_name,last_name,profile,status) VALUES (?,?,?,?,?,?)");
uins.run(1, "Jamie Line", "Jamie", "Line", '{"staffType":""}', "");            // owner (no staffType) — always included
uins.run(1, "Tanya", "Tanya", "Jones", '{"staffType":"office"}', "Active");
uins.run(1, "Megan", "Megan", "Hart", '{"staffType":"office"}', "");            // blank status = active
uins.run(1, "Ryan Diggens", "Ryan", "Diggens", '{"staffType":"field"}', "Active"); // field — excluded
uins.run(1, "Old Office", "Old", "Office", '{"staffType":"office"}', "Disabled"); // disabled office — excluded
db.prepare("INSERT INTO user_permissions (tenant_id,username,permission,value) VALUES (?,?,?,?)").run(1, "Jamie Line", "FullAccess", 1);

const env = { DB: d1(db), JOBS_INBOUND_TOKEN: "tok", OWNER_USERNAME: "Jamie Line" };
const ctx = { waitUntil() {} };
const sessFor = (who) => ({ user: { username: who, tenant_id: 1 }, tenantId: 1, session: { token: "T" } });

async function inbound(body) {
  const url = new URL("https://api.test/tasks/inbound");
  const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "authorization": "Bearer tok" }, body: JSON.stringify(body) });
  const res = await tasks.handle(req, env, ctx, url, null);
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}
async function call(who, method, path, body) {
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const res = await tasks.handle(req, env, ctx, url, sessFor(who));
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}
const mineTask = async (who, id) => (await call(who, "GET", "/mine")).body.tasks.find(t => t.id === id);
const outstanding = async (who) => (await call(who, "GET", "/attention")).body.outstanding;

let fail = 0; const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };

// ── 1. @office + shared intake task ──────────────────────────────────────────
const r = await inbound({ externalId: "note:abc", title: "📝 Concerto note — review it", detail: "please re-attend", link: "https://x/job-view.html?jobId=J1", category: "Concerto notes", assignee: "@office", shared: true });
ok("inbound @office created", r.status === 200 && r.body.ok && r.body.created, JSON.stringify(r.body));
const taskId = r.body.id;
const whoGot = (r.body.assignees || []).slice().sort();
ok("assigned to every office user + owner, field + disabled excluded",
  whoGot.includes("Jamie Line") && whoGot.includes("Tanya") && whoGot.includes("Megan")
  && !whoGot.includes("Ryan Diggens") && !whoGot.includes("Old Office"), JSON.stringify(whoGot));
const row = db.prepare("SELECT shared FROM admin_tasks WHERE id=?").get(taskId);
ok("stored shared=1", row && row.shared === 1, JSON.stringify(row));

// ── 2. shows for every office user, outstanding ──────────────────────────────
const mt = await mineTask("Tanya", taskId);
ok("shows on an office user's My Tasks, shared flag set", mt && mt.shared === true && mt.status.shared === true && mt.status.done === false, JSON.stringify(mt && mt.status));
ok("outstanding for Megan + Jamie before anyone acts", (await outstanding("Megan")) === 1 && (await outstanding("Jamie Line")) === 1);
ok("NOT on a field user's My Tasks", !(await mineTask("Ryan Diggens", taskId)));

// ── 3. one office person resolves → clears for ALL ───────────────────────────
const c = await call("Tanya", "POST", "/complete", { id: taskId });
ok("Tanya completes", c.status === 200 && c.body.ok, JSON.stringify(c.body));
const mt2 = await mineTask("Megan", taskId);
ok("cleared for Megan too (done, by Tanya)", mt2 && mt2.status.done === true && mt2.status.doneBy === "Tanya", JSON.stringify(mt2 && mt2.status));
ok("outstanding now 0 for Jamie + Megan", (await outstanding("Jamie Line")) === 0 && (await outstanding("Megan")) === 0);

// ── 4. undo reopens for everyone ─────────────────────────────────────────────
await call("Megan", "POST", "/complete", { id: taskId, undo: true });
ok("undo reopens for all", (await outstanding("Tanya")) === 1 && (await outstanding("Jamie Line")) === 1,
  "Tanya=" + (await outstanding("Tanya")) + " Jamie=" + (await outstanding("Jamie Line")));

// ── 5. the bot can close it by externalId (shared → done for all) ────────────
const dn = await inbound({ externalId: "note:abc", action: "done" });
ok("inbound action:done closes it", dn.status === 200 && dn.body.done, JSON.stringify(dn.body));
ok("closed for every office user", (await outstanding("Tanya")) === 0 && (await outstanding("Megan")) === 0 && (await outstanding("Jamie Line")) === 0);

// ── 6. a NORMAL (per-assignee) task is unaffected — one Done ≠ all done ───────
const r2 = await inbound({ externalId: "plain:1", title: "Two-person chore", assignees: ["Tanya", "Megan"] });
const pid = r2.body.id;
ok("plain task not shared", db.prepare("SELECT shared FROM admin_tasks WHERE id=?").get(pid).shared === 0);
await call("Tanya", "POST", "/complete", { id: pid });
const tm = await mineTask("Tanya", pid), mm = await mineTask("Megan", pid);
ok("Tanya done but Megan still outstanding (per-assignee)", tm.status.done === true && mm.status.done === false,
  "Tanya=" + tm.status.done + " Megan=" + mm.status.done);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
