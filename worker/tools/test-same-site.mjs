// Cross-job guard is STRICT — one job In Progress at a time, even at the same
// site (Sep 2026, Jamie's rule: status is kept current between jobs, never done
// retrospectively). Mock D1, synthetic data. Run: node worker/tools/test-same-site.mjs
import * as sla from "../src/routes/sla.js";
globalThis.fetch = async () => { throw new Error("no network in test"); };
function envWith(jobs) {
  const db = { prepare(sql) { let binds = []; const st = {
    bind(...a) { binds = a; return st; }, async first() { return null; },
    async all() { if (/^SELECT data FROM sla_jobs WHERE tenant_id\s*=\s*\?\s*$/.test(sql.trim())) return { results: jobs.map(j => ({ data: JSON.stringify(j) })) }; return { results: [] }; },
    async run() { return { meta: {} }; },
  }; return st; }, async batch() { return []; } };
  return { DB: db };
}
let fail = 0;
const ok = (n, c, d) => { console.log((c ? "PASS" : "FAIL") + "  " + n + (c ? "" : "  → " + JSON.stringify(d))); if (!c) fail++; };
const J = (id, siteCode, siteName, status, extra = {}) => ({ id, helpdeskRef: id, siteCode, siteName, status, assignedEngineers: ["Dave Test"], ...extra });
{
  const env = envWith([J("A1", "0125", "Shanklin, Regent Street", "In Progress"), J("A2", "125", "Shanklin, Regent Street", "Scheduled"), J("B1", "0066", "Wickham", "Scheduled")]);
  const a = await sla.findBlockingJob(env, 1, "Dave Test", "A2");
  ok("same store — STILL blocked by the active job (one at a time)", a && a.id === "A1", a);
  const b = await sla.findBlockingJob(env, 1, "Dave Test", "B1");
  ok("different store — blocked", b && b.id === "A1", b);
  ok("the active job itself is not its own blocker", (await sla.findBlockingJob(env, 1, "Dave Test", "A1")) === null);
  const env2 = envWith([J("E1", "0125", "Shanklin", "In Progress", { emTest: true }), J("A3", "0125", "Shanklin", "Scheduled")]);
  ok("an EM job in progress never blocks (drain-down overlap)", (await sla.findBlockingJob(env2, 1, "Dave Test", "A3")) === null);
  const env3 = envWith([J("H1", "0125", "Shanklin", "On Hold", { hold: { approval: { state: "pending" } } }), J("H2", "0125", "Shanklin", "Scheduled")]);
  const h = await sla.findBlockingJob(env3, 1, "Dave Test", "H2");
  ok("a pending on-hold blocks", h && h.kind === "holdPending", h);
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS"); process.exit(fail ? 1 : 0);
