// POST /sla/inbound — the SAME INCIDENT arriving again (Concerto re-assigns an
// incident as "<n>/2" after our quote is ordered, or re-opens one with the exact
// same reference). Mock D1, synthetic jobs. Run: node worker/tools/test-inbound-incident.mjs
import * as sla from "../src/routes/sla.js";

const JOBS = {
  "00028541/1": { id: "00028541/1", helpdeskRef: "00028541/1", status: "Complete", closedAt: "2026-08-30T10:00:00.000Z", createdAt: "2026-08-26T08:00:00.000Z", description: "Door hinge broken — made safe, quoted", siteCode: "0335", siteName: "Test Store" },
  "REOPEN/1":   { id: "REOPEN/1", helpdeskRef: "REOPEN/1", status: "Closed Jobs", createdAt: "2026-07-01T08:00:00.000Z", description: "Old leak fixed", siteCode: "0100", siteName: "Old Store" },
  "OPEN/1":     { id: "OPEN/1", helpdeskRef: "OPEN/1", status: "Scheduled", createdAt: "2026-09-08T08:00:00.000Z", description: "Still open", siteCode: "0200", siteName: "Open Store" },
  "u-fra":      { id: "u-fra", helpdeskRef: "FRA/1", status: "FRA Complete", createdAt: "2026-08-01T08:00:00.000Z", description: "custom done cat", siteCode: "0300", siteName: "Cat Store" },
};
function makeEnv() {
  const saved = {};
  const rows = () => Object.values({ ...JOBS, ...saved });
  const db = { prepare(sql) { let binds = []; const st = {
    bind(...a) { binds = a; return st; },
    async first() {
      if (/SELECT data FROM sla_jobs WHERE tenant_id = \? AND id = \?/.test(sql)) { const j = rows().find(j => j.id === binds[1]); return j ? { data: JSON.stringify(j) } : null; }
      if (/FROM app_config/.test(sql) && (/sla_categories/.test(sql) || binds.includes("sla_categories"))) return { value: JSON.stringify([{ name: "FRA Complete", colour: "#0f0", done: true }]) };
      return null; },
    async all() {
      if (/helpdesk_ref=\?/.test(sql)) return { results: rows().filter(j => j.helpdeskRef === binds[1]).map(j => ({ data: JSON.stringify(j) })) };
      if (/helpdesk_ref LIKE \?/.test(sql)) { const pre = String(binds[1]).replace(/%$/, ""); return { results: rows().filter(j => String(j.helpdeskRef || "").startsWith(pre) && j.helpdeskRef !== binds[2]).map(j => ({ data: JSON.stringify(j) })) }; }
      if (/^SELECT data FROM sla_jobs WHERE tenant_id\s*=\s*\?\s*$/.test(sql.trim())) return { results: rows().map(j => ({ data: JSON.stringify(j) })) };
      console.log("UNMOCKED all():", sql.slice(0, 80));
      return { results: [] }; },
    async run() {
      if (/INSERT INTO sla_jobs/.test(sql)) { const j = JSON.parse(binds[binds.length - 1]); saved[j.id] = j; }
      return { meta: {} }; },
  }; return st; }, batch(s) { return Promise.all(s.map(x => x.run())); } };
  const r2 = { async list() { return { objects: [] }; }, async get() { return null; }, async put() {}, async delete() {} };
  return { env: { DB: db, JOB_FILES: r2, ASSET_BUCKET: r2, JOBS_INBOUND_TOKEN: "tok" }, saved };
}
async function inbound(body) {
  const { env, saved } = makeEnv();
  const url = new URL("https://api.test/sla/inbound");
  const req = new Request(url, { method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await sla.handle(req, env, { waitUntil() {} }, url, null);
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j, saved };
}
let fail = 0; const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };

{ // brand-new incident → created, keyed by reference as before
  const r = await inbound({ reference: "NEW/1", description: "fresh", siteCode: "0400" });
  ok("new incident → created, id = reference", r.status === 201 && r.body.created && r.body.id === "NEW/1" && !r.body.linkedVisit, JSON.stringify(r.body));
}
{ // same reference, job still OPEN → the open job is updated (a re-sent email)
  const r = await inbound({ reference: "OPEN/1", description: "re-sent text", siteCode: "0200" });
  ok("same ref, still open → updated in place", r.status === 200 && !r.body.created && r.body.id === "OPEN/1" && !r.body.linkedVisit, JSON.stringify(r.body));
}
{ // same reference, job FINISHED → a NEW visit linked to it, never an overwrite
  const r = await inbound({ reference: "REOPEN/1", description: "Leak is back", siteCode: "0100" });
  const nj = r.saved[r.body.id];
  ok("re-opened incident → new linked visit", r.status === 201 && r.body.created && r.body.linkedVisit && r.body.visitKind === "reopened" && r.body.id !== "REOPEN/1" && nj.revisitOf === "REOPEN/1" && nj.visitGroupId === "REOPEN/1", JSON.stringify(r.body));
  ok("re-opened: the old job is NOT rewritten (still Closed)", !r.saved["REOPEN/1"] || r.saved["REOPEN/1"].status === "Closed Jobs" && r.saved["REOPEN/1"].description === "Old leak fixed");
  ok("re-opened: description says why + visit count stamped on both", /Same incident sent again/.test(nj.description) && /Leak is back/.test(nj.description) && nj.visitCount === 2 && r.saved["REOPEN/1"] && r.saved["REOPEN/1"].visitCount === 2 && r.saved["REOPEN/1"].visitGroupId === "REOPEN/1", nj.description);
}
{ // Concerto re-assignment: "/2" of an incident we attended as "/1" → linked visit
  const r = await inbound({ reference: "00028541/2", description: "Replace the door closer as quoted", siteCode: "0335", priority: "Priority 3" });
  const nj = r.saved[r.body.id];
  ok("re-assigned /2 → created as a visit linked to /1", r.status === 201 && r.body.linkedVisit && r.body.visitKind === "reassigned" && r.body.previousRef === "00028541/1" && nj.revisitOf === "00028541/1" && nj.visitGroupId === "00028541/1" && nj.helpdeskRef === "00028541/2", JSON.stringify(r.body));
  ok("re-assigned: description carries the link note", /Re-assigned incident/.test(nj.description) && /00028541\/1/.test(nj.description) && /Complete/.test(nj.description), nj.description);
}
{ // custom "done" category counts as finished
  const r = await inbound({ reference: "FRA/1", description: "again", siteCode: "0300" });
  ok("custom done category → treated as finished → linked visit", r.status === 201 && r.body.linkedVisit && r.body.visitKind === "reopened" && r.body.previousId === "u-fra", JSON.stringify(r.body));
}
{ // a sibling suffix only matches the SAME incident number (no prefix bleed)
  const r = await inbound({ reference: "000285411/1", description: "different incident", siteCode: "0335" });
  ok("different incident with a similar prefix → NOT linked", r.status === 201 && !r.body.linkedVisit, JSON.stringify(r.body));
}
/* ── action:"cancel" — the client cancelled an incident ─────────────────── */
{ // an OPEN job → Cancelled, stamped with the email's time + the client's reason; engineers pushed
  const r = await inbound({ action: "cancel", kind: "job", incident: "OPEN", reference: "OPEN/1", reason: "order for glass placed this morning.", by: "Southern Co-op (Concerto)", at: "2026-09-08T14:18:00.000Z" });
  const j = r.saved["OPEN/1"];
  ok("cancel: open job → status Cancelled", r.status === 200 && r.body.ok && r.body.cancelled && r.body.cancelled.length === 1 && r.body.cancelled[0].previousStatus === "Scheduled" && j && j.status === "Cancelled", JSON.stringify(r.body));
  ok("cancel: stamps — when / who / why / source", j && j.cancelledAt === "2026-09-08T14:18:00.000Z" && j.cancelledBy === "Southern Co-op (Concerto)" && /glass/.test(j.cancelReason) && j.cancelSource === "client", JSON.stringify(j && { at: j.cancelledAt, by: j.cancelledBy, why: j.cancelReason, src: j.cancelSource }));
  ok("cancel: history + event carry the reason", j && j.statusHistory.some(h => h.status === "Cancelled" && /glass/.test(h.note || "")) && (j.events || []).some(e => /cancelled by the client/.test(e.note || "")));
}
{ // by incident number only (no Order No. on the email) → finds the "/1" job
  const r = await inbound({ action: "cancel", kind: "job", incident: "OPEN", reason: "" });
  ok("cancel: incident number alone finds the /n job", r.status === 200 && r.body.cancelled && r.body.cancelled[0].reference === "OPEN/1", JSON.stringify(r.body));
}
{ // every job for the incident already FINISHED → noted on the newest one, status untouched
  const r = await inbound({ action: "cancel", kind: "job", incident: "00028541", reference: "00028541/1", reason: "Works quoted and approved on original job.", at: "2026-09-02T15:19:00.000Z" });
  const j = r.saved["00028541/1"];
  ok("cancel: finished job is NOT un-completed — cancellation noted", r.status === 200 && r.body.noted && r.body.status === "Complete" && j && j.status === "Complete" && !j.cancelledAt && j.clientCancelled && j.clientCancelled.at === "2026-09-02T15:19:00.000Z" && /quoted/.test(j.clientCancelled.reason), JSON.stringify(r.body));
}
{ // a QUOTE withdrawn on a job already Scheduled → held for the office, not cancelled
  const r = await inbound({ action: "cancel", kind: "quote", reference: "OPEN/1", reason: "no longer required" });
  ok("quote withdrawn on a Scheduled job → held, nothing changed", r.status === 200 && r.body.held && r.body.held[0].id === "OPEN/1" && (!r.body.cancelled || !r.body.cancelled.length) && !r.saved["OPEN/1"], JSON.stringify(r.body));
}
{ // a QUOTE withdrawn on a job still WAITING (status Quote) → cancelled
  JOBS["QT/1"] = { id: "QT/1", helpdeskRef: "QT/1", status: "Quote", createdAt: "2026-09-01T08:00:00.000Z", description: "quote sent", siteCode: "0500", siteName: "Quote Store", assignedEngineers: ["Test Eng"] };
  const r = await inbound({ action: "cancel", kind: "quote", reference: "QT/1", reason: "no longer required — completed under original job", by: "Southern Co-op (Concerto — A Person)" });
  const j = r.saved["QT/1"];
  ok("quote withdrawn on a waiting job → Cancelled + engineer named", r.status === 200 && r.body.cancelled && r.body.cancelled[0].engineers[0] === "Test Eng" && j && j.status === "Cancelled" && /original job/.test(j.cancelReason), JSON.stringify(r.body));
  delete JOBS["QT/1"];
}
{ // unknown incident → 404 notFound (the email pipeline holds it for a look)
  const r = await inbound({ action: "cancel", kind: "job", incident: "99999999", reference: "99999999/1" });
  ok("cancel: no job for that incident → 404 notFound", r.status === 404 && r.body.notFound, JSON.stringify(r.body));
}
{ // reinstating clears the stamps: a cancelled job re-sent as a new assignment becomes a linked visit (finished → reopened)
  JOBS["CX/1"] = { id: "CX/1", helpdeskRef: "CX/1", status: "Cancelled", cancelledAt: "2026-09-01T10:00:00.000Z", cancelledBy: "client", cancelReason: "x", createdAt: "2026-08-20T08:00:00.000Z", description: "was cancelled", siteCode: "0600" };
  const r = await inbound({ reference: "CX/1", description: "raised again", siteCode: "0600" });
  const nj = r.saved[r.body.id];
  ok("a cancelled job counts as finished → a re-send becomes a linked visit, not an overwrite", r.status === 201 && r.body.linkedVisit && r.body.visitKind === "reopened" && nj && nj.status !== "Cancelled" && !nj.cancelledAt, JSON.stringify(r.body));
  delete JOBS["CX/1"];
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
