// Cross-job guard — jobs at the SAME site may run together (Sep 2026).
// An engineer with several job numbers at one store used to be able to start
// only the first; the rest sat amber on the scheduler until closed as paperwork.
// Mock D1, synthetic data. Run: node worker/tools/test-same-site.mjs
import * as sla from "../src/routes/sla.js";
globalThis.fetch = async () => { throw new Error("no network in test"); };

function envWith(jobs) {
  const db = { prepare(sql) { let binds = []; const st = {
    bind(...a) { binds = a; return st; },
    async first() { return null; },
    async all() { if (/^SELECT data FROM sla_jobs WHERE tenant_id\s*=\s*\?\s*$/.test(sql.trim())) return { results: jobs.map(j => ({ data: JSON.stringify(j) })) }; return { results: [] }; },
    async run() { return { meta: {} }; },
  }; return st; }, async batch() { return []; } };
  return { DB: db };
}
let fail = 0;
const ok = (n, c, d) => { console.log((c ? "PASS" : "FAIL") + "  " + n + (c ? "" : "  → " + JSON.stringify(d))); if (!c) fail++; };
const J = (id, siteCode, siteName, status, extra = {}) => ({ id, helpdeskRef: id, siteCode, siteName, status, assignedEngineers: ["Dave Test"], ...extra });

{ // same store code → not blocked; different store → blocked
  const active = J("A1", "0125", "Shanklin, Regent Street", "In Progress");
  const env = envWith([active, J("A2", "125", "Shanklin, Regent Street", "Scheduled"), J("B1", "0066", "Wickham", "Scheduled")]);
  ok("same store (0125 vs 125) — not blocked", await sla.findBlockingJob(env, 1, "Dave Test", "A2", { id: "A2", siteCode: "125" }) === null);
  const b = await sla.findBlockingJob(env, 1, "Dave Test", "B1", { id: "B1", siteCode: "0066" });
  ok("different store — still blocked by the active job", b && b.id === "A1", b);
  ok("no current job passed (legacy caller) — still blocked", (await sla.findBlockingJob(env, 1, "Dave Test", "B1")) !== null);
}
{ // name match when no codes; pending on-hold at the same site still blocks
  const env = envWith([J("N1", "", "The Old Mill, Romsey", "Travelling"), J("N2", "", "the old mill romsey", "Scheduled")]);
  ok("same site by name (no codes) — not blocked", await sla.findBlockingJob(env, 1, "Dave Test", "N2", { id: "N2", siteCode: "", siteName: "the old mill romsey" }) === null);
  const env2 = envWith([J("H1", "0125", "Shanklin", "On Hold", { hold: { approval: { state: "pending" } } }), J("H2", "0125", "Shanklin", "Scheduled")]);
  const h = await sla.findBlockingJob(env2, 1, "Dave Test", "H2", { id: "H2", siteCode: "0125" });
  ok("a pending on-hold at the same site still blocks", h && h.kind === "holdPending", h);
  ok("sameSiteJob: blank codes + blank names never match", sla.sameSiteJob({ siteCode: "", siteName: "" }, { siteCode: "", siteName: "" }) === false);
  ok("sameSiteJob: project codes compare exactly (P0002 ≠ P0003)", sla.sameSiteJob({ siteCode: "P0002" }, { siteCode: "P0003" }) === false && sla.sameSiteJob({ siteCode: "P0002" }, { siteCode: "p0002" }) === true);
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS"); process.exit(fail ? 1 : 0);
