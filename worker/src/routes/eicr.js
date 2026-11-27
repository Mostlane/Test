// ═══════════════════════════════════════════════════════════════════════════
// EICR TRACKER — ONE record per site per 5-year cycle (25 Nov 2026, Jamie:
// "a process for all electrical tests… none slip through the net").
//
// The due list comes from the COMPLIANCE CHART (coop fiveYear due dates). Each
// site has at most ONE open case. A case carries the whole journey:
//
//   due → booked → (C3 only)   cert_signoff ───────────────────────────→ done
//                → (C1/C2/FI)  to_quote → quoted → ordered → works_booked
//                                                       → cert_update → done
//
// Invoicing is tracked separately on the case: the TEST invoice (due once the
// test job is finished) and, on the remedial path, the WORKS invoice (due once
// the updated certificate is signed off). A case closes when it is done AND
// every invoice it needs is ticked.
//
// Status is STORED (so "days in this status" is real) and moved forward by
// evidence the portal can see (test job, order email, works job), checked on
// every board load. A manual status change always holds until NEW evidence
// arrives (ev_status = what the evidence said when the status was last set).
// ═══════════════════════════════════════════════════════════════════════════
import { json, error } from "../lib/http.js";
import { permissionsFor, canSeeMoney } from "../lib/auth.js";
import { listJobs, getJob, createOrUpdateJobFromPayload, createWorksJobFromRemedials, reconcileRelease, badScheduleIn } from "./sla.js";
import { onceMigration } from "../lib/once.js";

export const STATUSES = [
  { key: "due",          label: "Due — book the test",            who: "office",   rank: 0 },
  { key: "booked",       label: "Test booked",                    who: "engineer", rank: 1 },
  { key: "to_quote",     label: "Remedials to quote",             who: "office",   rank: 2 },
  { key: "quoted",       label: "Quoted — awaiting order",        who: "client",   rank: 3 },
  { key: "ordered",      label: "Order received — book works",    who: "office",   rank: 4 },
  { key: "works_booked", label: "Remedial works booked",          who: "engineer", rank: 5 },
  { key: "cert_update",  label: "Update the certificate",         who: "signoff",  rank: 6 },
  { key: "cert_signoff", label: "Sign off the certificate",       who: "signoff",  rank: 6 },
  { key: "done",         label: "Done",                           who: "",         rank: 7 },
];
const S = Object.fromEntries(STATUSES.map(s => [s.key, s]));
const QUOTE_PATH = new Set(["to_quote", "quoted", "ordered", "works_booked", "cert_update"]);
const FIN_BUILTIN = new Set(["complete", "closed jobs", "closed", "invoiced"]);
const WORKS_CODES = new Set(["C1", "C2", "FI"]);

const pad4 = v => { const d = String(v ?? "").replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
const nowIso = () => new Date().toISOString();
function londonToday() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function toIso(v) {
  const s = String(v || "").trim(); if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return "";
}
function addMonthsIso(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000); }
// Working days (Mon–Fri) from an ISO instant to now.
export function workingDaysSince(iso, now) {
  if (!iso) return 0;
  const start = new Date(iso), end = now ? new Date(now) : new Date();
  if (!(start < end)) return 0;
  let n = 0; const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (d.getTime() < e) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

async function ensureTables__raw(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS eicr_cases (
    tenant_id INTEGER NOT NULL, id TEXT NOT NULL, store_code TEXT NOT NULL, site_name TEXT,
    cycle_due TEXT, status TEXT, status_at TEXT, status_by TEXT, status_manual INTEGER DEFAULT 0, ev_status TEXT,
    test_job_id TEXT, works_job_id TEXT, outcome TEXT,
    quote_ref TEXT, quote_value REAL, quote_at TEXT, quote_by TEXT,
    order_number TEXT, order_value REAL, order_at TEXT, order_id TEXT,
    cert_signed_at TEXT, cert_signed_by TEXT, cert_updated_at TEXT, cert_updated_by TEXT,
    test_inv_at TEXT, test_inv_by TEXT, test_inv_ref TEXT,
    works_inv_at TEXT, works_inv_by TEXT, works_inv_ref TEXT,
    note TEXT, log TEXT, source TEXT, flag TEXT,
    created_at TEXT, updated_at TEXT, closed_at TEXT,
    PRIMARY KEY (tenant_id, id))`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS eicr_cases_store ON eicr_cases(tenant_id, store_code)").run(); } catch {}
}
export const ensureTables = onceMigration(ensureTables__raw);

// ─── reading the world ─────────────────────────────────────────────────────
async function doneCategories(env) {
  try {
    const r = await env.DB.prepare("SELECT value FROM app_config WHERE key='sla_categories'").first();
    const list = JSON.parse((r && r.value) || "[]");
    return new Set(list.filter(c => c && c.done).map(c => String(c.name).toLowerCase()));
  } catch { return new Set(); }
}
export function jobFinished(job, doneCats) {
  const s = String((job && job.status) || "").toLowerCase();
  return FIN_BUILTIN.has(s) || !!(doneCats && doneCats.has(s));
}
const jobCancelled = j => /cancel/i.test(String((j && j.status) || ""));
// When the test itself first finished (the original test day) — later reopens
// for the remedials don't move it. Falls back to the job's created date.
export function testDoneAt(job, doneCats) {
  const h = Array.isArray(job && job.statusHistory) ? job.statusHistory : [];
  for (const e of h) { const s = String((e && e.status) || "").toLowerCase(); if (FIN_BUILTIN.has(s) || (doneCats && doneCats.has(s))) return e.at || ""; }
  return (job && (job.createdAt || job.scheduledAt)) || "";
}
// The office sometimes sends an engineer back on the TEST job itself to do the
// remedials (instead of the separate works job) — re-opened or simply re-assigned,
// and the engineer taps Complete again. Spot that: a "Complete" at least 5 days
// after the test was first finished. Returns {at, by} or null.
export function testReusedForWorks(job, doneCats) {
  if (!job || !jobFinished(job, doneCats)) return null;
  const h = Array.isArray(job.statusHistory) ? job.statusHistory : [];
  const fin = e => { const s = String((e && e.status) || "").toLowerCase(); return FIN_BUILTIN.has(s) || !!(doneCats && doneCats.has(s)); };
  let t0 = null, hit = null;
  for (const e of h) {
    const ms = Date.parse((e && e.at) || "");
    if (!Number.isFinite(ms)) continue;
    if (t0 == null) { if (fin(e)) t0 = ms; continue; }
    if (String(e.status || "").toLowerCase() === "complete" && ms - t0 >= 5 * 86400000) hit = { at: e.at, by: e.by || "" };
  }
  return hit;
}
const ORDER_RE = /\b(REM\d{3,}|R\d{4,})\b/i;
// Remedials found on the test: "remedials" when any C1/C2/FI — or an UNCODED
// item (safe side: it might be serious) — else "c3" (only C3s, or nothing).
export function testOutcome(job) {
  const rem = Array.isArray(job && job.remedials) ? job.remedials.filter(r => r && (r.description || (r.photos || []).length)) : [];
  if (rem.some(r => WORKS_CODES.has(String(r.code || "").toUpperCase()) || !String(r.code || "").trim())) return "remedials";
  return "c3";
}
function remSummary(job) {
  const rem = Array.isArray(job && job.remedials) ? job.remedials.filter(r => r && (r.description || (r.photos || []).length)) : [];
  const c = { C1: 0, C2: 0, FI: 0, C3: 0, uncoded: 0, total: rem.length, photos: 0 };
  for (const r of rem) { const k = String(r.code || "").toUpperCase(); if (c[k] !== undefined) c[k]++; else c.uncoded++; c.photos += (r.photos || []).length; }
  return c;
}

async function chartStores(env, tid) {
  const { results } = await env.DB.prepare(`SELECT cs.code, cs.category, cs.due, cs.active, cs.name,
      (SELECT s.site_name FROM sites s WHERE s.site_number <> '' AND s.site_number NOT GLOB '*[^0-9]*' AND CAST(s.site_number AS INTEGER)=CAST(cs.code AS INTEGER) ORDER BY LENGTH(s.site_number) LIMIT 1) AS site_name
    FROM compliance_stores cs WHERE cs.tenant_id=? AND cs.scheme='coop' AND cs.code <> '' AND cs.code NOT GLOB '*[^0-9]*'`).bind(tid).all();
  const m = new Map();
  for (const r of results || []) {
    let due = {}; try { due = JSON.parse(r.due || "{}") || {}; } catch {}
    const closed = r.active === 0 || /closed/i.test(String(r.name || r.site_name || "")) || /closed/i.test(String(due.fiveYear || ""));
    m.set(pad4(r.code), { code: pad4(r.code), category: r.category || "", name: r.site_name || r.name || "", due: toIso(due.fiveYear), closed });
  }
  return m;
}
async function loadCases(env, tid) {
  const { results } = await env.DB.prepare("SELECT * FROM eicr_cases WHERE tenant_id=?").bind(tid).all();
  return results || [];
}
async function concertoRows(env, tid) {
  try {
    const { results } = await env.DB.prepare("SELECT id, store_code, site_name, next_date, planned_date, last_date, order_nr, status FROM concerto_ppm WHERE ppm_type='fiveYear' AND COALESCE(status,'open')<>'gone'").bind().all();
    const m = new Map(); const unmapped = [];
    for (const r of results || []) {
      const code = pad4(r.store_code);
      if (!code) { unmapped.push(r); continue; }
      const cur = m.get(code);
      const next = toIso(r.next_date || r.planned_date);
      if (!cur || (next && (!cur.next || next < cur.next))) m.set(code, { next, released: !!String(r.order_nr || "").trim(), orderNr: r.order_nr || "", last: toIso(r.last_date), id: r.id });
    }
    return { byCode: m, unmapped };
  } catch { return { byCode: new Map(), unmapped: [] }; }
}
// Electrical-relevant client orders per store (matched to an elec test / 5-year
// remedial, or text that says EICR / electrical / remedial). EM orders excluded.
async function storeOrders(env, tid) {
  const m = new Map();
  try {
    const { results } = await env.DB.prepare(`SELECT id, order_number, order_value, store_code, matched_kind, status, title, description, notified_at, created_at
      FROM client_orders WHERE COALESCE(status,'') <> 'dismissed'`).bind().all();
    for (const o of results || []) {
      const code = pad4(o.store_code); if (!code) continue;
      if (o.matched_kind === "em") continue;
      const txt = `${o.title || ""} ${o.description || ""}`;
      const elec = o.matched_kind === "elec" || o.matched_kind === "fiveyear" || /eicr|5\s*-?\s*year|five\s*year|fixed\s*wire|electrical|remedial|C1|C2/i.test(txt);
      if (!elec) continue;
      const at = o.notified_at || o.created_at || "";
      if (!m.has(code)) m.set(code, []);
      m.get(code).push({ id: o.id, number: o.order_number || "", value: o.order_value, at });
    }
  } catch {}
  return m;
}
// Has a 5-year certificate been filed for THIS cycle? With a test job: uploaded on/after the
// test. Without one (cases carried over from the old schedule): the certificate's own date is
// within a year of the cycle's due date, or it was uploaded after the case was opened.
export function certFiledForCycle(cert, testDate, c) {
  if (!cert || !cert.uploadedAt) return false;
  const up = String(cert.uploadedAt).slice(0, 10);
  if (testDate) return up >= testDate;
  if (!c) return false;
  if (cert.docDate && c.cycle_due) {
    const d = new Date(c.cycle_due + "T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() - 1);
    if (cert.docDate >= d.toISOString().slice(0, 10)) return true;
  }
  return !!(c.created_at && String(cert.uploadedAt) >= String(c.created_at));
}
async function certFiles(env, tid) {
  const m = new Map();
  try {
    const { results } = await env.DB.prepare(`SELECT code, MAX(COALESCE(uploaded_at,'')) up, MAX(COALESCE(doc_date,'')) dd FROM compliance_files
      WHERE scheme='coop' AND type='fiveYear' GROUP BY code`).bind().all();
    for (const r of results || []) m.set(pad4(r.code), { uploadedAt: r.up || "", docDate: r.dd || "" });
  } catch {}
  return m;
}

// ─── evidence → status ─────────────────────────────────────────────────────
// What the portal can SEE for this case. Pure (exported for the tests).
export function deriveStatus(c, ctx) {
  const t = c.test_job_id ? ctx.jobs.get(c.test_job_id) : null;
  const w = c.works_job_id ? ctx.jobs.get(c.works_job_id) : null;
  let outcome = c.outcome || "";
  let st = "due";
  if (t && !jobCancelled(t)) {
    st = "booked";
    if (jobFinished(t, ctx.doneCats)) {
      if (!outcome) outcome = testOutcome(t);
      st = outcome === "remedials" ? "to_quote" : "cert_signoff";
    }
  }
  if (outcome === "remedials") {
    if (c.quote_at) st = maxRank(st, "quoted");
    if (c.order_number) st = maxRank(st, "ordered");
    if (w && !jobCancelled(w)) st = maxRank(st, jobFinished(w, ctx.doneCats) ? "cert_update" : "works_booked");
    if (t && testReusedForWorks(t, ctx.doneCats)) st = maxRank(st, "cert_update");
    if (c.cert_updated_at) st = "done";
  } else if (c.cert_signed_at) st = "done";
  return { status: st, outcome };
}
function maxRank(a, b) { return (S[b] ? S[b].rank : 0) > (S[a] ? S[a].rank : 0) ? b : a; }
// The status to store: evidence moves a case forward only when the evidence has
// CHANGED since the status was last set (so a manual choice holds), and a C3-only
// reading never drags a case off the quote path the office put it on.
export function nextStatus(c, derived) {
  const cur = c.status || "due";
  if (derived === c.ev_status) return cur;
  if (derived === "cert_signoff" && QUOTE_PATH.has(cur)) return cur;
  if (cur === "done") return cur;
  return (S[derived].rank > (S[cur] ? S[cur].rank : 0)) ? derived : cur;
}
export function invoicesNeeded(c) {
  const out = [];
  const testDone = c.test_job_id && c._testFinished;
  if (testDone || ["to_quote", "quoted", "ordered", "works_booked", "cert_update", "cert_signoff", "done"].includes(c.status)) out.push("test");
  if (c.outcome === "remedials" && (c.status === "done" || c.cert_updated_at)) out.push("works");
  return out;
}
function isClosable(c) {
  if (c.status !== "done") return false;
  const need = invoicesNeeded(c);
  if (need.includes("test") && !c.test_inv_at) return false;
  if (need.includes("works") && !c.works_inv_at) return false;
  return true;
}

function logPush(c, by, text) {
  let log = []; try { log = JSON.parse(c.log || "[]"); } catch {}
  log.push({ at: nowIso(), by: by || "", text });
  c.log = JSON.stringify(log.slice(-80));
}
const COLS = ["store_code","site_name","cycle_due","status","status_at","status_by","status_manual","ev_status","test_job_id","works_job_id","outcome","quote_ref","quote_value","quote_at","quote_by","order_number","order_value","order_at","order_id","cert_signed_at","cert_signed_by","cert_updated_at","cert_updated_by","test_inv_at","test_inv_by","test_inv_ref","works_inv_at","works_inv_by","works_inv_ref","note","log","source","flag","created_at","updated_at","closed_at"];
async function saveCase(env, tid, c) {
  c.updated_at = nowIso();
  const vals = COLS.map(k => (c[k] === undefined ? null : c[k]));
  await env.DB.prepare(`INSERT INTO eicr_cases (tenant_id, id, ${COLS.join(",")}) VALUES (?, ?, ${COLS.map(() => "?").join(",")})
    ON CONFLICT(tenant_id, id) DO UPDATE SET ${COLS.map(k => `${k}=excluded.${k}`).join(",")}`).bind(tid, c.id, ...vals).run();
}
function newCase(code, name, due, by, source) {
  return { id: "EC-" + code + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), store_code: code, site_name: name || "",
    cycle_due: due || "", status: "due", status_at: nowIso(), status_by: by || "", status_manual: 0, ev_status: null, log: "[]",
    source: source || "", created_at: nowIso() };
}

// ─── the reconcile pass (every board load) ─────────────────────────────────
// A remedial works job the office raised by hand. Pure (exported for the tests).
const EM_JOB_RE = /light failure|emergency light|\bEM\d|batter(y|ies)/i;
export function findManualWorksJob(c, t, allJobs, usedWorks) {
  const code = Number(c.store_code);
  const since = t ? String(t.createdAt || t.scheduledAt || "").slice(0, 10) : "";
  const ord = String(c.order_number || "").toUpperCase();
  const tok = s => String(s || "").toUpperCase().split(/[^A-Z0-9/]+/);
  const hits = allJobs.filter(j => {
    if (!j || j.elecTest || j.emTest || j.pat || j.pumpMaintenance || jobCancelled(j)) return false;
    if (t && j.id === t.id) return false;
    if (usedWorks && usedWorks.has(j.id)) return false;
    if (Number(j.siteCode) !== code || !Number.isFinite(code)) return false;
    if (/^emrem:|^empat-/i.test(String(j.id))) return false;
    if (since && String(j.createdAt || "").slice(0, 10) < since) return false;
    if (EM_JOB_RE.test(String(j.description || ""))) return false;
    const ref = String(j.helpdeskRef || "");
    return (ord && tok(ref).includes(ord)) || /^\s*REM\d{3,}\b/i.test(ref);
  });
  hits.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return hits[0] || null;
}
async function reconcile(env, tid, opts) {
  await ensureTables(env);
  const [stores, casesRaw, allJobs, doneCats, orders] = await Promise.all([
    chartStores(env, tid), loadCases(env, tid), listJobs(env, tid).catch(() => []), doneCategories(env), storeOrders(env, tid),
  ]);
  const jobs = new Map(allJobs.map(j => [j.id, j]));
  const ctx = { jobs, doneCats };
  const cases = casesRaw.map(c => ({ ...c }));
  const openByCode = new Map();
  for (const c of cases) if (!c.closed_at) openByCode.set(c.store_code, c);
  const usedTestJobs = new Set(cases.map(c => c.test_job_id).filter(Boolean));
  const usedOrders = new Set(cases.map(c => c.order_id).filter(Boolean));
  const usedWorks = new Set(cases.map(c => c.works_job_id).filter(Boolean));
  const changed = new Set();

  // 1) every electrical test job in the portal belongs to a case.
  const tests = allJobs.filter(j => j.elecTest && !jobCancelled(j) && pad4(j.siteCode));
  tests.sort((a, b) => String(a.createdAt || a.scheduledAt || "").localeCompare(String(b.createdAt || b.scheduledAt || "")));
  for (const j of tests) {
    if (usedTestJobs.has(j.id)) continue;
    const code = pad4(j.siteCode);
    let c = openByCode.get(code);
    if (c && c.test_job_id && c.test_job_id !== j.id) {
      // a duplicate test job: the linked one never ran, this one did → swap.
      const cur = jobs.get(c.test_job_id);
      if (cur && !jobFinished(cur, doneCats) && jobFinished(j, doneCats)) {
        logPush(c, "system", `Test job swapped to the one that was done: ${j.helpdeskRef || j.id}`);
        c.test_job_id = j.id; usedTestJobs.add(j.id); changed.add(c); continue;
      }
      // the open case already has a test — a newer test starts a new cycle only if the old one is done
      if (c.status !== "done") continue;
      c.closed_at = c.closed_at || nowIso(); changed.add(c);
      c = null;
    }
    if (!c) {
      const st = stores.get(code);
      c = newCase(code, (st && st.name) || j.siteName || "", st && st.due, "system", "test job");
      cases.push(c); openByCode.set(code, c);
    }
    c.test_job_id = j.id; usedTestJobs.add(j.id);
    logPush(c, "system", `Test job linked: ${j.helpdeskRef || j.id}`);
    changed.add(c);
  }

  // 2) works job raised from the test job (old path) → onto the case.
  for (const c of cases) {
    if (c.closed_at) continue;
    const t = c.test_job_id && jobs.get(c.test_job_id);
    if (!c.works_job_id && t && t.remedialsWorksJobId && jobs.get(t.remedialsWorksJobId) && !jobCancelled(jobs.get(t.remedialsWorksJobId))) {
      c.works_job_id = t.remedialsWorksJobId; logPush(c, "system", "Works job linked"); changed.add(c);
    }
    // 2b) a remedial works job raised by hand (not from the test's remedials) —
    // e.g. "REM0196 Bournemouth, Belle Vue Road": same store, made after the test,
    // its reference carries the case's order number or a REM number.
    if (!c.works_job_id) {
      const w = findManualWorksJob(c, t, allJobs, usedWorks);
      if (w) { c.works_job_id = w.id; usedWorks.add(w.id); logPush(c, "system", `Found existing remedial job: ${w.helpdeskRef || w.id}`); changed.add(c); }
    }
    // 3) an electrical client order for the store after the test → the order.
    const t2 = c.test_job_id && jobs.get(c.test_job_id);
    const out3 = c.outcome || (t2 && jobFinished(t2, doneCats) ? testOutcome(t2) : "");
    // the order number written on the jobs themselves (the office types it into
    // the test job's reference, or the order linked onto the works job).
    if (!c.order_number && out3 === "remedials") {
      const w2 = c.works_job_id && jobs.get(c.works_job_id);
      const num = (w2 && w2.orderNumber) || (t2 && (t2.orderNumber || (String(t2.helpdeskRef || "").match(ORDER_RE) || [])[1])) || "";
      if (num) {
        const o = (orders.get(c.store_code) || []).find(x => String(x.number).toUpperCase() === String(num).toUpperCase());
        c.order_number = String(num).toUpperCase(); c.order_value = o ? (o.value ?? null) : ((w2 && w2.orderValue) ?? null); c.order_at = (o && o.at) || nowIso(); c.order_id = o ? o.id : null;
        if (o) usedOrders.add(o.id);
        logPush(c, "system", `Order ${c.order_number} picked up from the job`); changed.add(c);
      }
    }
    if (!c.order_number && (out3 === "remedials" || QUOTE_PATH.has(c.status))) {
      const since = String((t2 && testDoneAt(t2, doneCats)) || "").slice(0, 10);
      const list = (orders.get(c.store_code) || []).filter(o => !usedOrders.has(o.id) && (!since || String(o.at).slice(0, 10) >= since)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (list.length) {
        const o = list[0];
        c.order_number = o.number; c.order_value = o.value ?? null; c.order_at = o.at || nowIso(); c.order_id = o.id; usedOrders.add(o.id);
        logPush(c, "system", `Order ${o.number} picked up from the client's order email`); changed.add(c);
      }
    }
  }

  // 4) evidence → status.
  for (const c of cases) {
    if (c.closed_at) continue;
    const t = c.test_job_id && jobs.get(c.test_job_id);
    c._testFinished = !!(t && jobFinished(t, doneCats));
    const d = deriveStatus(c, ctx);
    if (d.outcome && !c.outcome) { c.outcome = d.outcome; changed.add(c); }
    const nx = nextStatus(c, d.status);
    if (nx === "cert_update" && c.status !== "cert_update" && t) {
      const hit = testReusedForWorks(t, doneCats);
      if (hit) logPush(c, "system", `Remedials done on the test job — completed again by ${hit.by || "the engineer"} on ${String(hit.at).slice(0, 10)} (check)`);
    }
    if (nx !== c.status) {
      logPush(c, "system", `${S[c.status] ? S[c.status].label : c.status} → ${S[nx].label}`);
      c.status = nx; c.status_at = nowIso(); c.status_by = "system"; c.status_manual = 0; changed.add(c);
    }
    if (c.ev_status !== d.status) { c.ev_status = d.status; changed.add(c); }
    if (isClosable(c)) { c.closed_at = nowIso(); logPush(c, "system", "Closed — done and invoiced"); changed.add(c); }
  }
  for (const c of changed) await saveCase(env, tid, c);
  return { stores, cases, jobs, doneCats };
}

// ─── shaping a row for the page ────────────────────────────────────────────
const TIMERS = { to_quote: 5, ordered: 5, cert_signoff: 2, cert_update: 2, quoted: 20 };
function jobView(j, money) {
  if (!j) return null;
  const engs = Array.isArray(j.assignedEngineers) ? j.assignedEngineers : (j.assignedTo ? [j.assignedTo] : []);
  return { id: j.id, ref: j.helpdeskRef || j.siteName || "", status: j.status || "", scheduledAt: j.scheduledAt || null, engineers: engs };
}
function shapeRow(store, c, ctx, extra) {
  const today = londonToday();
  const t = c && c.test_job_id ? ctx.jobs.get(c.test_job_id) : null;
  const w = c && c.works_job_id ? ctx.jobs.get(c.works_job_id) : null;
  const status = c ? c.status : "due";
  const due = store ? store.due : (c && c.cycle_due) || "";
  let alert = "", alertText = "";
  if (status === "due") {
    if (due && due < today) { alert = "red"; alertText = "Overdue — no valid certificate"; }
    else if (due && daysBetween(today, due) <= 60) { alert = "amber"; alertText = `Due in ${daysBetween(today, due)} days`; }
  } else if (status === "booked" || status === "works_booked") {
    const jj = status === "booked" ? t : w;
    const sd = jj && jj.scheduledAt ? String(jj.scheduledAt).slice(0, 10) : "";
    if (!sd) { alert = "amber"; alertText = "No date booked"; }
    else if (sd < today && !jobFinished(jj, ctx.doneCats)) { alert = "red"; alertText = "Visit date passed — job not finished"; }
  } else if (TIMERS[status] && c) {
    const wd = workingDaysSince(c.status_at);
    if (wd > TIMERS[status]) { alert = status === "quoted" ? "amber" : "red"; alertText = `${wd} working days in this status`; }
  }
  const instRec = extra.inst ? extra.inst[store ? store.code : (c && c.store_code)] : null;
  if (instRec && status === "due") { alert = ""; alertText = ""; }
  const need = c ? invoicesNeeded(c) : [];
  const conc = extra.concerto.get(store ? store.code : (c && c.store_code));
  const cert = extra.certs.get(store ? store.code : (c && c.store_code));
  const testDate = t ? String(testDoneAt(t, ctx.doneCats) || t.scheduledAt || "").slice(0, 10) : "";
  const reusedHit = t ? testReusedForWorks(t, ctx.doneCats) : null;
  return {
    code: store ? store.code : c.store_code,
    name: (store && store.name) || (c && c.site_name) || "",
    category: store ? store.category : "",
    due, installRec: instRec ? { at: instRec.at || "", by: instRec.by || "" } : null, closedStore: !!(store && store.closed), onChart: !!store,
    caseId: c ? c.id : null, status, statusLabel: instRec && status === "due" ? "Install records required" : (S[status] ? S[status].label : status), who: S[status] ? S[status].who : "",
    statusAt: c ? c.status_at : null, statusBy: c ? c.status_by : "", manual: !!(c && c.status_manual),
    daysInStatus: c && c.status_at ? workingDaysSince(c.status_at) : null,
    alert, alertText,
    outcome: c ? c.outcome || "" : "",
    test: jobView(t), works: jobView(w),
    worksOnTestJob: reusedHit ? { date: String(reusedHit.at).slice(0, 10), by: reusedHit.by } : null,
    remedials: t ? remSummary(t) : null,
    quote: c && (c.quote_at || c.quote_ref || c.quote_value != null) ? { ref: c.quote_ref || "", value: extra.money ? c.quote_value : undefined, at: c.quote_at } : null,
    order: c && c.order_number ? { number: c.order_number, value: extra.money ? c.order_value : undefined, at: c.order_at } : null,
    certSigned: c && c.cert_signed_at ? { at: c.cert_signed_at, by: c.cert_signed_by } : null,
    certUpdated: c && c.cert_updated_at ? { at: c.cert_updated_at, by: c.cert_updated_by } : null,
    certFiled: cert ? cert.uploadedAt : "",
    certFiledSinceTest: certFiledForCycle(cert, testDate, c),
    invoices: {
      test: need.includes("test") ? { done: !!(c && c.test_inv_at), at: c && c.test_inv_at, by: c && c.test_inv_by, ref: c && c.test_inv_ref } : null,
      works: need.includes("works") ? { done: !!(c && c.works_inv_at), at: c && c.works_inv_at, by: c && c.works_inv_by, ref: c && c.works_inv_ref } : null,
    },
    concerto: conc ? { next: conc.next, last: conc.last, released: conc.released, orderNr: conc.orderNr } : null,
    certDocDate: cert ? cert.docDate : "",
    note: c ? c.note || "" : "", flag: c ? c.flag || "" : "", source: c ? c.source || "" : "",
    log: c ? (() => { try { return JSON.parse(c.log || "[]").slice(-12).reverse(); } catch { return []; } })() : [],
  };
}

// 📂 "Install Records Required" — a new site with no 5-year test yet: its installation
// certificates are needed instead of a test date. Map {code:{at,by}} in app_config,
// shared with the compliance chart (compliance.js /installrec-flag).
export async function installRecMap(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "compliance:installrec:coop:" + tid).first();
    return JSON.parse((row && row.value) || "{}") || {};
  } catch { return {}; }
}
async function buildBoard(env, tid, money) {
  const r = await reconcile(env, tid);
  const [conc, certs, inst] = await Promise.all([concertoRows(env, tid), certFiles(env, tid), installRecMap(env, tid)]);
  const extra = { concerto: conc.byCode, certs, money, inst };
  const ctx = { jobs: r.jobs, doneCats: r.doneCats };
  const openByCode = new Map(); const lastClosed = new Map();
  for (const c of r.cases) {
    if (!c.closed_at) openByCode.set(c.store_code, c);
    else { const cur = lastClosed.get(c.store_code); if (!cur || String(c.closed_at) > String(cur.closed_at)) lastClosed.set(c.store_code, c); }
  }
  const closedView = (c) => {
    if (!c) return null;
    const t = c.test_job_id ? r.jobs.get(c.test_job_id) : null;
    return { caseId: c.id, closedAt: c.closed_at, testDate: t ? String(t.scheduledAt || t.createdAt || "").slice(0, 10) : "", outcome: c.outcome || "",
      testInvoiced: c.test_inv_at || null, worksInvoiced: c.works_inv_at || null, orderNumber: c.order_number || "" };
  };
  const rows = [];
  for (const st of r.stores.values()) {
    const c = openByCode.get(st.code);
    if (st.closed && !c) continue;
    const row = shapeRow(st, c, ctx, extra);
    row.lastClosed = closedView(lastClosed.get(st.code));
    rows.push(row);
    openByCode.delete(st.code);
  }
  for (const c of openByCode.values()) rows.push(shapeRow(null, c, ctx, extra));   // open case for a store not on the chart
  rows.sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")) || a.code.localeCompare(b.code));
  const counts = {}; for (const x of rows) counts[x.status] = (counts[x.status] || 0) + 1;
  return { rows, counts, statuses: STATUSES };
}

// Concerto ↔ chart exceptions.
async function buildExceptions(env, tid) {
  const [stores, conc] = await Promise.all([chartStores(env, tid), concertoRows(env, tid)]);
  const today = londonToday(), horizon = addMonthsIso(today, 12);
  const dueOnPortalNotConcerto = [], dueOnConcertoNotPortal = [], notOnChart = [], noDate = [];
  for (const st of stores.values()) {
    if (st.closed) continue;
    const c = conc.byCode.get(st.code);
    if (!st.due) { noDate.push({ code: st.code, name: st.name, concertoNext: c ? c.next : "" }); continue; }
    if (st.due <= horizon) {
      if (!c) dueOnPortalNotConcerto.push({ code: st.code, name: st.name, due: st.due, reason: "Not on the Concerto list at all" });
      else if (c.next && c.next > horizon) dueOnPortalNotConcerto.push({ code: st.code, name: st.name, due: st.due, concertoNext: c.next, reason: "Concerto has it later" });
    }
  }
  for (const [code, c] of conc.byCode) {
    const st = stores.get(code);
    if (!st) { notOnChart.push({ code, concertoNext: c.next, released: c.released }); continue; }
    if (st.closed) continue;
    const concDue = (c.next && c.next <= horizon) || c.released;
    if (concDue && (!st.due || st.due > horizon)) dueOnConcertoNotPortal.push({ code, name: st.name, due: st.due, concertoNext: c.next, released: c.released, orderNr: c.orderNr });
  }
  const unmapped = conc.unmapped.map(u => ({ id: u.id, site: u.site_name || "", next: toIso(u.next_date || u.planned_date) }));
  return { horizon, dueOnPortalNotConcerto, dueOnConcertoNotPortal, notOnChart, noDate, unmapped };
}

// ─── quote text ────────────────────────────────────────────────────────────
function quoteText(job, includeC3, money) {
  const rem = (job.remedials || []).filter(r => r && r.description && (includeC3 || String(r.code || "").toUpperCase() !== "C3"));
  const lines = [`Remedial works following the EICR at ${job.siteCode ? pad4(job.siteCode) + " " : ""}${job.siteName || ""}:`, ""];
  let mins = 0, mat = 0;
  rem.forEach((r, i) => {
    const m = Number(r.minutes) || 0, c = Number(r.materialCost) || 0; mins += m; mat += c;
    const bits = [];
    if (m) bits.push(m >= 60 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)} h` : `${m} min`);
    if (money && c) bits.push(`materials £${c.toFixed(2)}`);
    lines.push(`${i + 1}. ${r.code ? "[" + String(r.code).toUpperCase() + "] " : ""}${String(r.description).trim()}${bits.length ? " — " + bits.join(", ") : ""}`);
  });
  lines.push("");
  if (mins) lines.push(`Total time: ${(mins / 60).toFixed(1)} h`);
  if (money && mat) lines.push(`Total materials: £${mat.toFixed(2)}`);
  return lines.join("\n");
}

// ─── book a test job ───────────────────────────────────────────────────────
async function siteRecord(env, tid, code) {
  try {
    const r = await env.DB.prepare(`SELECT client, site_number, site_name, postcode, data FROM sites WHERE tenant_id=? AND site_number<>'' AND site_number NOT GLOB '*[^0-9]*' AND CAST(site_number AS INTEGER)=CAST(? AS INTEGER) ORDER BY LENGTH(site_number) LIMIT 1`).bind(tid, code).first();
    if (!r) return null;
    let d = {}; try { d = JSON.parse(r.data || "{}") || {}; } catch {}
    return { client: r.client, code: r.site_number, name: r.site_name || "", postcode: r.postcode || d.postcode || "",
      address: [d.address1 || d.street, d.address2, d.town].filter(Boolean).join(", "), telephone: d.telephone || "", lat: d.lat, lng: d.lng };
  } catch { return null; }
}
function elecDescription(label) {
  return `Carry out EICR. Import "${label}" from EasyCert Cloud. If certificate is not there, create a new one and use certificate name and number "${label}"\n\n`
    + "- Record every remedial (with its C1/C2/C3/FI code) and photos in this job.\n"
    + "- Export complete certificate to EasyCert Cloud\n"
    + "- Set job as complete";
}

// ─── HTTP ──────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Unauthorised", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const perms = await permissionsFor(env, tid, me);
  const full = perms.FullAccess === "Yes";
  const office = full || perms.SLAAdmin === "Yes" || perms.Compliance === "Yes";
  if (!office) return error("Compliance, SLA Admin or Full Access needed", 403, env, request);
  await ensureTables(env);
  const money = await canSeeMoney(env, tid, me);
  const path = url.pathname, method = request.method.toUpperCase();
  const body = async () => { try { return await request.json(); } catch { return {}; } };
  const ok = (o) => json({ ok: true, ...o }, {}, env, request);

  if (path === "/eicr/board" && method === "GET") {
    // First open: carry the old 5-Year schedule + remedials register across (once).
    try { await migrateOld(env, tid, me, false); } catch {}
    const out = await buildBoard(env, tid, money);
    return ok({ ...out, money, canSignOff: full, me });
  }
  if (path === "/eicr/exceptions" && method === "GET") return ok(await buildExceptions(env, tid));

  // Find (or open) the case for a store.
  async function caseFor(b, create) {
    if (b.caseId) {
      const c = await env.DB.prepare("SELECT * FROM eicr_cases WHERE tenant_id=? AND id=?").bind(tid, b.caseId).first();
      if (c) return { ...c };
    }
    const code = pad4(b.code); if (!code) return null;
    const c = await env.DB.prepare("SELECT * FROM eicr_cases WHERE tenant_id=? AND store_code=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(tid, code).first();
    if (c) return { ...c };
    if (!create) return null;
    const stores = await chartStores(env, tid); const st = stores.get(code);
    return newCase(code, st ? st.name : (b.name || ""), st ? st.due : "", me, "office");
  }

  if (path === "/eicr/case" && method === "GET") {
    const c = await caseFor({ caseId: url.searchParams.get("id"), code: url.searchParams.get("code") }, false);
    if (!c) return error("No case", 404, env, request);
    const t = c.test_job_id ? await getJob(env, tid, c.test_job_id).catch(() => null) : null;
    const rem = t && Array.isArray(t.remedials) ? t.remedials.filter(r => r && (r.description || (r.photos || []).length)).map(r => ({
      id: r.id, code: String(r.code || "").toUpperCase(), description: r.description || "", minutes: r.minutes || 0,
      materialCost: money ? r.materialCost || 0 : undefined, photos: (r.photos || []).length })) : [];
    return ok({ case: { id: c.id, code: c.store_code, status: c.status }, remedials: rem });
  }

  if (path === "/eicr/quote-text" && method === "GET") {
    const c = await caseFor({ caseId: url.searchParams.get("id") }, false);
    const t = c && c.test_job_id ? await getJob(env, tid, c.test_job_id).catch(() => null) : null;
    if (!t) return error("This case has no test job with remedials", 404, env, request);
    return ok({ text: quoteText(t, url.searchParams.get("c3") === "1", money) });
  }

  if (method !== "POST") return error("Not found", 404, env, request);
  const b = await body();

  if (path === "/eicr/book") {
    const code = pad4(b.code); if (!code) return error("Store code needed", 400, env, request);
    const engs = (Array.isArray(b.engineers) ? b.engineers : []).map(String).filter(Boolean);
    const bad = badScheduleIn({ scheduledAt: b.scheduledAt, scheduledEnd: b.scheduledEnd });
    if (bad) return error(bad, 400, env, request);
    const c = await caseFor({ code }, true);
    if (c.test_job_id) {
      const ex = await getJob(env, tid, c.test_job_id).catch(() => null);
      if (ex && !jobCancelled(ex)) return error("This site already has a test job on its case — open it from the row.", 409, env, request);
    }
    const site = await siteRecord(env, tid, code);
    const label = `${code} ${(site && site.name) || c.site_name || ""}`.trim();
    const payload = {
      reference: label, description: elecDescription(label),
      siteCode: code, siteName: (site && site.name) || c.site_name || "", postcode: site ? site.postcode : "", address: site ? site.address : "",
      telephone: site ? site.telephone : "", lat: site ? site.lat : undefined, lon: site ? site.lng : undefined,
      storeType: site ? site.client : "retail", client: site ? site.client : "retail",
      elecTest: true, requiresRA: false, requiresSignature: false, requiresPhoto: false, requiresNote: false,
      assignedEngineers: engs, priority: "", status: engs.length ? "Scheduled" : "Pending",
      release: { mode: "dayBefore" }, changedBy: me,
    };
    if (b.scheduledAt) payload.scheduledAt = new Date(b.scheduledAt).toISOString();
    if (b.scheduledEnd) payload.scheduledEnd = new Date(b.scheduledEnd).toISOString();
    if (b.durationMinutes) payload.durationMinutes = Math.max(15, Number(b.durationMinutes) || 0);
    const job = await createOrUpdateJobFromPayload(env, tid, payload);
    try { const nj = await getJob(env, tid, job.id); if (nj && engs.length) await reconcileRelease(env, tid, nj); } catch {}
    c.test_job_id = job.id; c.status = "booked"; c.status_at = nowIso(); c.status_by = me; c.status_manual = 0; c.ev_status = "booked";
    logPush(c, me, `Test booked${engs.length ? " for " + engs.join(", ") : ""}${b.scheduledAt ? " on " + String(b.scheduledAt).slice(0, 10) : ""}`);
    await saveCase(env, tid, c);
    return ok({ caseId: c.id, jobId: job.id });
  }

  if (path === "/eicr/link-job") {
    const c = await caseFor(b, true);
    const j = b.jobId ? await getJob(env, tid, b.jobId).catch(() => null) : null;
    if (!j) return error("Job not found", 404, env, request);
    if (b.kind === "works") c.works_job_id = j.id; else c.test_job_id = j.id;
    logPush(c, me, `${b.kind === "works" ? "Works" : "Test"} job linked by hand: ${j.helpdeskRef || j.id}`);
    await saveCase(env, tid, c);
    return ok({ caseId: c.id });
  }

  if (path === "/eicr/status") {
    if (!S[b.status]) return error("Unknown status", 400, env, request);
    const c = await caseFor(b, true);
    if ((b.status === "done") && (c.status === "cert_signoff" || c.status === "cert_update") && !full) return error("Only Full Access can sign off a certificate", 403, env, request);
    const from = c.status;
    c.status = b.status; c.status_at = nowIso(); c.status_by = me; c.status_manual = 1;
    if (b.status === "quoted" && !c.quote_at) { c.quote_at = nowIso(); c.quote_by = me; }
    if (QUOTE_PATH.has(b.status) && !c.outcome) c.outcome = "remedials";
    logPush(c, me, `Status set by hand: ${S[from] ? S[from].label : from || "—"} → ${S[b.status].label}${b.note ? " (" + String(b.note).slice(0, 200) + ")" : ""}`);
    if (c.closed_at && b.status !== "done") c.closed_at = null;
    await saveCase(env, tid, c);
    return ok({ caseId: c.id });
  }

  if (path === "/eicr/update") {
    const c = await caseFor(b, true);
    const bits = [];
    if (b.orderNumber !== undefined) {
      const v = String(b.orderNumber || "").trim().slice(0, 40);
      if (v !== (c.order_number || "")) { c.order_number = v || null; c.order_at = v ? (c.order_at || nowIso()) : null; c.order_id = null; bits.push(v ? `order number ${v}` : "order number cleared"); }
    }
    if (b.orderValue !== undefined && money) { c.order_value = b.orderValue === "" || b.orderValue === null ? null : Number(b.orderValue) || 0; bits.push("order value"); }
    if (b.quoteRef !== undefined) { c.quote_ref = String(b.quoteRef || "").trim().slice(0, 60) || null; bits.push("quote ref"); }
    if (b.quoteValue !== undefined && money) { c.quote_value = b.quoteValue === "" || b.quoteValue === null ? null : Number(b.quoteValue) || 0; bits.push("quote value"); }
    if (b.note !== undefined) { c.note = String(b.note || "").slice(0, 2000); bits.push("note"); }
    if (b.outcome !== undefined && ["c3", "remedials", ""].includes(b.outcome)) { c.outcome = b.outcome || null; bits.push("outcome " + (b.outcome || "cleared")); }
    if (bits.length) logPush(c, me, "Updated " + bits.join(", "));
    await saveCase(env, tid, c);
    return ok({ caseId: c.id });
  }

  if (path === "/eicr/quote-sent") {
    const c = await caseFor(b, false); if (!c) return error("No case", 404, env, request);
    c.quote_at = nowIso(); c.quote_by = me;
    if (b.quoteRef !== undefined) c.quote_ref = String(b.quoteRef || "").trim().slice(0, 60) || null;
    if (b.quoteValue !== undefined && money) c.quote_value = Number(b.quoteValue) || null;
    if (S[c.status].rank < S.quoted.rank) { c.status = "quoted"; c.status_at = nowIso(); c.status_by = me; c.status_manual = 0; }
    c.outcome = "remedials";
    logPush(c, me, `Quote sent${c.quote_ref ? " (" + c.quote_ref + ")" : ""}`);
    await saveCase(env, tid, c);
    return ok({ caseId: c.id });
  }

  if (path === "/eicr/create-works") {
    const c = await caseFor(b, false); if (!c) return error("No case", 404, env, request);
    if (c.works_job_id) {
      const ex = await getJob(env, tid, c.works_job_id).catch(() => null);
      if (ex && !jobCancelled(ex)) return ok({ caseId: c.id, jobId: ex.id, existing: true });
    }
    let src = c.test_job_id ? await getJob(env, tid, c.test_job_id).catch(() => null) : null;
    const items = Array.isArray(b.items) ? b.items.map(s => String(s || "").trim()).filter(Boolean) : [];
    let synthetic = false;
    if (!src || items.length) {
      const site = await siteRecord(env, tid, c.store_code);
      src = src || { siteCode: c.store_code, siteName: (site && site.name) || c.site_name, postcode: site && site.postcode, address: site && site.address, telephone: site && site.telephone, storeType: site && site.client, client: site && site.client, lat: site && site.lat, lon: site && site.lng, helpdeskRef: c.order_number || "" };
      synthetic = !c.test_job_id;
    }
    const res = await createWorksJobFromRemedials(env, tid, src, {
      pickIds: Array.isArray(b.itemIds) ? b.itemIds : null, items: items.length ? items : null, synthetic,
      assignedEngineers: b.engineers, scheduledAt: b.scheduledAt, scheduledEnd: b.scheduledEnd, durationMinutes: b.durationMinutes,
      by: me, existingId: null,
    });
    if (res.error) return error(res.error, res.status || 400, env, request);
    c.works_job_id = res.id; c.status = "works_booked"; c.status_at = nowIso(); c.status_by = me; c.status_manual = 0; c.ev_status = "works_booked"; c.outcome = "remedials";
    logPush(c, me, `Works job created (${res.items || 0} items, test photos copied)`);
    await saveCase(env, tid, c);
    return ok({ caseId: c.id, jobId: res.id });
  }

  if (path === "/eicr/signoff") {
    if (!full) return error("Only Full Access can sign off a certificate", 403, env, request);
    const c = await caseFor(b, false); if (!c) return error("No case", 404, env, request);
    if (c.status === "cert_update" || b.kind === "update") { c.cert_updated_at = nowIso(); c.cert_updated_by = me; logPush(c, me, "Updated certificate signed off"); }
    else { c.cert_signed_at = nowIso(); c.cert_signed_by = me; logPush(c, me, "Certificate signed off"); }
    c.status = "done"; c.status_at = nowIso(); c.status_by = me; c.status_manual = 0; c.ev_status = "done";
    await saveCase(env, tid, c);
    return ok({ caseId: c.id });
  }

  if (path === "/eicr/invoice") {
    const c = await caseFor(b, false); if (!c) return error("No case", 404, env, request);
    const which = b.which === "works" ? "works" : "test";
    if (b.undo) { c[which + "_inv_at"] = null; c[which + "_inv_by"] = null; c[which + "_inv_ref"] = null; c.closed_at = null; logPush(c, me, `${which === "works" ? "Remedial works" : "Test"} invoice un-ticked`); }
    else {
      c[which + "_inv_at"] = nowIso(); c[which + "_inv_by"] = me; c[which + "_inv_ref"] = String(b.ref || "").trim().slice(0, 60) || null;
      logPush(c, me, `${which === "works" ? "Remedial works" : "Test"} invoiced${b.ref ? " (" + b.ref + ")" : ""}`);
      c._testFinished = true;
      if (isClosable(c)) { c.closed_at = nowIso(); logPush(c, "system", "Closed — done and invoiced"); }
    }
    await saveCase(env, tid, c);
    return ok({ caseId: c.id, closed: !!c.closed_at });
  }

  if (path === "/eicr/reopen") {
    const c = await caseFor(b, false); if (!c) return error("No case", 404, env, request);
    c.closed_at = null; logPush(c, me, "Reopened"); await saveCase(env, tid, c);
    return ok({ caseId: c.id });
  }

  if (path === "/eicr/migrate") {
    if (!full) return error("Full Access only", 403, env, request);
    return ok(await migrateOld(env, tid, me, !!b.force));
  }

  return error("Not found", 404, env, request);
}

// ─── one-off: carry the old registers across ───────────────────────────────
const OLD_STAGE = {
  needs_booking: "due", scheduled: "booked", awaiting_review: "cert_signoff", complete_satisfactory: "done",
  remedials_required: "to_quote", remedials_to_quote: "to_quote", remedials_quoted: "quoted", orders_received: "ordered",
  remedials_scheduled: "works_booked", remedials_complete: "cert_update", certificate_updated: "done", invoiced: "done",
};
export async function migrateOld(env, tid, by, force) {
  await ensureTables(env);
  const flagKey = "eicr:migrated:" + tid;
  if (!force) { const f = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(flagKey).first(); if (f) return { skipped: true, at: f.value }; }
  const r = await reconcile(env, tid);   // links every portal test job first
  const open = new Map(); for (const c of r.cases) if (!c.closed_at) open.set(c.store_code, c);
  let fromSchedule = 0, fromRegister = 0;
  const stores = r.stores;
  const ensureCase = (code, source) => {
    let c = open.get(code);
    if (!c) { const st = stores.get(code); c = newCase(code, st ? st.name : "", st ? st.due : "", by, source); open.set(code, c); r.cases.push(c); }
    return c;
  };
  // (1) the 5-Year schedule's manual statuses
  try {
    const { results } = await env.DB.prepare("SELECT store_code, stage12, note, quote_ref, quote_value, quote_at, works_job_id FROM concerto_cases WHERE stage12 IS NOT NULL AND stage12<>'' AND closed_at IS NULL").bind().all();
    for (const o of results || []) {
      const code = pad4(o.store_code); const st = OLD_STAGE[o.stage12]; if (!code || !st) continue;
      const c = ensureCase(code, "old schedule");
      if (S[st].rank > S[c.status || "due"].rank) { c.status = st; c.status_at = nowIso(); c.status_by = "migration"; c.status_manual = 1; }
      if (QUOTE_PATH.has(st) && !c.outcome) c.outcome = "remedials";
      if (o.quote_ref && !c.quote_ref) c.quote_ref = o.quote_ref;
      if (o.quote_value && c.quote_value == null) c.quote_value = o.quote_value;
      if (o.quote_at && !c.quote_at) c.quote_at = o.quote_at;
      if (o.works_job_id && !c.works_job_id) c.works_job_id = o.works_job_id;
      if (o.note) c.note = [c.note, o.note].filter(Boolean).join("\n");
      if (o.stage12 === "invoiced") { c.test_inv_at = c.test_inv_at || nowIso(); c.test_inv_by = "migration"; if (c.outcome === "remedials") { c.works_inv_at = c.works_inv_at || nowIso(); c.works_inv_by = "migration"; } }
      logPush(c, "migration", `Carried over from the old 5-Year schedule (status "${o.stage12}")`);
      c._dirty = true; fromSchedule++;
    }
  } catch {}
  // (2) the old remedials register — orders with no works job are flagged to check
  try {
    const { results } = await env.DB.prepare("SELECT id, store_code, stage, order_number, order_value, data FROM five_year_remedials").bind().all();
    for (const o of results || []) {
      const code = pad4(o.store_code); if (!code) continue;
      const stage = String(o.stage || "");
      if (!["ordered", "in_works", "quoted", "to_review"].includes(stage)) continue;
      const c = ensureCase(code, "old remedials register");
      if (c.test_job_id) {
        // the portal test job is the truth — only carry an order number across
        if (o.order_number && !c.order_number) { c.order_number = o.order_number; c.order_value = o.order_value; c.order_at = nowIso(); logPush(c, "migration", `Order ${o.order_number} carried over from the old remedials register`); c._dirty = true; fromRegister++; }
        continue;
      }
      c.outcome = "remedials";
      const target = stage === "in_works" ? "works_booked" : stage === "ordered" ? "ordered" : stage === "quoted" ? "quoted" : "to_quote";
      if (S[target].rank > S[c.status || "due"].rank) { c.status = target; c.status_at = nowIso(); c.status_by = "migration"; c.status_manual = 1; }
      if (o.order_number && !c.order_number) { c.order_number = o.order_number; c.order_value = o.order_value; c.order_at = nowIso(); }
      if (!c.test_job_id) c.flag = "Imported from the old remedials register — check it is still outstanding";
      logPush(c, "migration", `Carried over from the old remedials register (${stage}${o.order_number ? ", order " + o.order_number : ""})`);
      c._dirty = true; fromRegister++;
    }
  } catch {}
  let saved = 0;
  for (const c of r.cases) if (c._dirty) { delete c._dirty; await saveCase(env, tid, c); saved++; }
  await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, flagKey, nowIso()).run();
  return { fromSchedule, fromRegister, saved, cases: r.cases.length };
}
