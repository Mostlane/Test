// Concerto PPM list — the client's OFFICIAL schedule of planned maintenance
// (EM light tests, PAT, pump maintenance, PV/EV, 5-year) that Mostlane works to.
// Southern Co-op's Concerto system exports two spreadsheets:
//   • "Open PPM jobs overdue (completion)" — one row per PPM ORDER still open:
//     Order number (PPMnnnn) · Order date · Order value · Order description
//     ("Emergency light - August 2025 : AR005758" / "PAT - August 2026 :
//     EL-PAT-SR00161") · Supplier · Target/Actual response.
//   • "PPM schedule" — planned PPMs: UPRN (SRnnnnn = the Concerto site ref) ·
//     Site ("0109 - Romsey, Winchester Hill (PFS)") · Block · Ref (EL-5Y…) ·
//     Type · Supplier · Last date · Planned date · Estimate.
// Neither carries a store number on the order rows — only an ASSET REFERENCE
// (an SRnnnnn site ref inside "SC-EL-SR00373", or an older ARnnnnnn asset ref),
// so a REFERENCE MAP (concerto_refs) resolves each row to a store. It is seeded
// from every place a reference has been seen against a store (order emails,
// the site register, past exports) and LEARNS from each Concerto order email.
//
// The office drops each new export on concerto-ppm.html; rows upsert by order
// number (never a duplicate), rows that vanish from a full "open" list are
// marked gone, and every row is RECONCILED against the compliance chart:
//   done      the chart shows the test done in/after the Concerto period, but
//             Concerto still lists it open → close it / send the completion date
//   due       both agree it is due (overdue when the date has passed)
//   mismatch  the chart's due date disagrees with the Concerto period
//   no_store  the reference isn't mapped yet (office maps it once)
//   not_on_chart / store_closed
// plus the reverse check: stores OVERDUE on the chart with NO open Concerto row.
//
// Routes (office = FullAccess | SLAAdmin | Compliance; order values only for
// canSeeMoney):
//   GET  /concerto/list?status=open|all      rows + flags + chartMissing + counts
//   POST /concerto/import {layout, rows, fileName}
//   POST /concerto/ref {ref, storeCode}      map a reference → re-resolve rows
//   GET  /concerto/refs
//   POST /concerto/refs/seed {refs:[…]}
//   POST /concerto/status {id, status, note}  dismissed | open | done
//   GET  /concerto/stores                    coop chart stores for the picker
//   GET  /concerto/schedule?type=&from=&to=&released=   the schedule tab; for
//        type=fiveYear every row carries a CASE (the EICR pipeline, below)
//   POST /concerto/case {ppmId, step, done|note, outcome, engineer, hold, flag, close}
import { json, error } from "../lib/http.js";
import { permissionsFor, canSeeMoney } from "../lib/auth.js";
import { listJobs } from "./sla.js";
import { onceMigration } from "../lib/once.js";

async function ensureTables__raw(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS concerto_ppm (
    id TEXT NOT NULL, tenant_id TEXT NOT NULL, kind TEXT, order_date TEXT, order_value REAL,
    description TEXT, ppm_type TEXT, period TEXT, asset_ref TEXT, sr_ref TEXT,
    store_code TEXT, site_name TEXT, supplier TEXT, target_response TEXT, actual_response TEXT,
    planned_date TEXT, last_date TEXT, status TEXT, note TEXT, source_file TEXT,
    first_seen_at TEXT, last_seen_at TEXT, gone_at TEXT, updated_at TEXT,
    PRIMARY KEY (tenant_id, id))`).run();
  // Schedule-export columns (self-migrating): the "PPM schedule" layout carries
  // the NEXT due date, whether the client has RELEASED the order (Order nr. =
  // PPMnnnn + the ordered value), Concerto's status and a month marker.
  for (const col of ["next_date TEXT", "order_nr TEXT", "ordered_value REAL", "released_at TEXT", "concerto_status TEXT", "month_marker TEXT", "discipline TEXT", "frequency_months INTEGER", "block TEXT"]) {
    try { await env.DB.prepare("ALTER TABLE concerto_ppm ADD COLUMN " + col).run(); } catch {}
  }
  // Append-only event log for stats: when an order was released against a
  // schedule row, when a next date moved, when a row appeared / vanished.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS concerto_log (
    tenant_id TEXT NOT NULL, ppm_id TEXT NOT NULL, event TEXT, detail TEXT, at TEXT)`).run();
  // 5-year EICR pipeline: one CASE per schedule row per 5-year cycle (see
  // CASE_STEPS). `steps` = JSON {stepKey:{done,at,by,note}} of MANUAL ticks;
  // everything the portal can see is derived live and never stored here.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS concerto_cases (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, ppm_id TEXT NOT NULL, store_code TEXT, ppm_type TEXT,
    cycle_due TEXT, outcome TEXT, engineer TEXT, steps TEXT,
    hold_reason TEXT, held_at TEXT, held_by TEXT,
    opened_at TEXT, closed_at TEXT, closed_by TEXT, updated_at TEXT, updated_by TEXT,
    PRIMARY KEY (tenant_id, id))`).run();
  // 🚩 flag = "needs my attention" + a comment (distinct from hold = waiting on something)
  for (const col of ["flag_note TEXT", "flagged_at TEXT", "flagged_by TEXT"]) { try { await env.DB.prepare("ALTER TABLE concerto_cases ADD COLUMN " + col).run(); } catch {} }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS concerto_refs (
    tenant_id TEXT NOT NULL, ref TEXT NOT NULL, store_code TEXT, site_name TEXT,
    kind TEXT, source TEXT, updated_at TEXT,
    PRIMARY KEY (tenant_id, ref))`).run();
}
export const ensureTables = onceMigration(ensureTables__raw); // once per isolate — see lib/once.js (exported so the test harness can reset it per mock DB)

/* ── Parsing helpers (pure — exported for the test harness + seeding) ─────── */
export const FREQ_MONTHS = { fiveYear: 60, pat: 12, em: 12, pv: 12, ev: 12, pump: 1 };
// Dates shown to people are DD/MM/YY (Jamie's rule); a Concerto month period reads "Aug 25".
export function fmtUk(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso || ""); }
function fmtPeriodUk(row) { if (row.planned_date) return fmtUk(row.planned_date); const m = /^(\d{4})-(\d{2})/.exec(String(row.period || "")); if (!m) return String(row.period || ""); const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return (M[Number(m[2]) - 1] || m[2]) + " " + m[1].slice(2); }
const TYPE_LABEL = { fiveYear: "5 Year", pat: "PAT", em: "Emergency lighting", pv: "PV", ev: "EV", pump: "Pump", other: "Other" };
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

export function padCode(v) { const d = String(v ?? "").replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; }
export function normRef(v) { return String(v || "").toUpperCase().replace(/\s+/g, "").trim(); }
export function srIn(s) { const m = /\b(SR\d{4,6})\b/i.exec(String(s || "")); return m ? m[1].toUpperCase() : ""; }

// "Emergency light" / "PAT" / "Pump maintenance" / "PV" / "EV" / "5 year fixed wire" / "EL-5Y"…
export function typeOf(text) {
  const t = String(text || "").toLowerCase();
  if (/5\s*-?\s*y|five\s*year|fixed\s*wire|eicr/.test(t)) return "fiveYear";
  if (/emergency|\bem\b|sc-el|el-em|\bem\s*light/.test(t)) return "em";
  if (/\bpat\b/.test(t)) return "pat";
  if (/pump/.test(t)) return "pump";
  if (/\bpv\b|solar/.test(t)) return "pv";
  if (/\bev\b|forecourt|charg/.test(t)) return "ev";
  return "other";
}
// "August 2025" → "2025-08"
export function periodOf(text) {
  const m = /([A-Za-z]+)\s+(20\d{2})/.exec(String(text || ""));
  if (!m) return "";
  const i = MONTHS.indexOf(m[1].toLowerCase());
  return i < 0 ? "" : `${m[2]}-${String(i + 1).padStart(2, "0")}`;
}
// "Emergency light - August 2025 : AR005758" → {type, period, ref, srRef}
export function parseOrderDescription(desc) {
  const s = String(desc || "").trim();
  const m = /^(.*?)\s*-\s*([A-Za-z]+\s+20\d{2})\s*:\s*([A-Za-z0-9._\/-]+)\s*$/.exec(s);
  const typeText = m ? m[1] : s, periodText = m ? m[2] : s, ref = normRef(m ? m[3] : (/\b([A-Z]{2,3}-?[A-Z0-9-]*\d{4,})\b/i.exec(s) || [])[1] || "");
  return { type: typeOf(typeText), period: periodOf(periodText), ref, srRef: srIn(ref) };
}
// "0109 - Romsey, Winchester Hill (PFS)" → {code, name}
export function splitSite(text) {
  const s = String(text || "").trim();
  const m = /^\s*(\d{2,5})\s*-\s*(.+)$/.exec(s);
  return m ? { code: padCode(m[1]), name: m[2].trim() } : { code: "", name: s };
}
// Excel serial / ISO / dd/mm/yyyy → YYYY-MM-DD (or null)
export function toIsoDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && isFinite(v)) {
    if (v < 20000 || v > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s); if (m) return `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) return toIsoDate(Number(s));
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
export function addMonths(iso, n) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const todayIso = () => new Date().toISOString().slice(0, 10);

/* ── Reference map ────────────────────────────────────────────────────────── */
export async function learnConcertoRef(env, tid, ref, storeCode, siteName, source) {
  const r = normRef(ref), code = padCode(storeCode);
  if (!r || !code || !/^(SR|AR)\d{3,}$/.test(r)) return false;
  try {
    await ensureTables(env);
    await env.DB.prepare(`INSERT INTO concerto_refs (tenant_id, ref, store_code, site_name, kind, source, updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id, ref) DO UPDATE SET
        store_code=excluded.store_code,
        site_name=CASE WHEN excluded.site_name<>'' THEN excluded.site_name ELSE concerto_refs.site_name END,
        source=excluded.source, updated_at=excluded.updated_at`)
      .bind(tid, r, code, String(siteName || "").slice(0, 160), r.startsWith("SR") ? "sr" : "ar", String(source || "").slice(0, 40), new Date().toISOString()).run();
    // Any imported row still carrying this reference now resolves.
    await env.DB.prepare("UPDATE concerto_ppm SET store_code=?, site_name=CASE WHEN COALESCE(site_name,'')='' THEN ? ELSE site_name END, updated_at=? WHERE tenant_id=? AND (sr_ref=? OR asset_ref=?) AND COALESCE(store_code,'')=''")
      .bind(code, String(siteName || "").slice(0, 160), new Date().toISOString(), tid, r, r).run();
    return true;
  } catch { return false; }
}
async function refMap(env, tid) {
  const { results } = await env.DB.prepare("SELECT ref, store_code, site_name FROM concerto_refs WHERE tenant_id=?").bind(tid).all();
  const m = new Map();
  for (const r of results || []) if (r.store_code) m.set(r.ref, { code: r.store_code, name: r.site_name || "" });
  return m;
}
function resolveRef(map, srRef, assetRef) {
  if (srRef && map.has(srRef)) return map.get(srRef);
  if (assetRef && map.has(assetRef)) return map.get(assetRef);
  return null;
}

/* ── Import ───────────────────────────────────────────────────────────────── */
// rows for layout "orders": {orderNumber, orderDate, orderValue, description, supplier, targetResponse, actualResponse}
// rows for layout "schedule": {uprn, site, block, ref, type, supplier, lastDate, plannedDate, estimate}
export async function importRows(env, tid, layout, rows, fileName) {
  await ensureTables(env);
  const map = await refMap(env, tid);
  const now = new Date().toISOString();
  const out = { added: 0, updated: 0, unresolved: 0, gone: 0, skipped: 0, released: 0, ids: [] };
  const seen = new Set(), typesSeen = new Set();
  const stmts = [], logs = [];
  const log = (id, event, detail) => logs.push(env.DB.prepare("INSERT INTO concerto_log (tenant_id, ppm_id, event, detail, at) VALUES (?,?,?,?,?)").bind(tid, id, event, JSON.stringify(detail || {}), now));
  for (const raw of rows || []) {
    let rec;
    if (layout === "schedule") {
      const sr = srIn(raw.uprn) || normRef(raw.uprn);
      const site = splitSite(raw.site);
      const type = typeOf(String(raw.ref || "") + " " + String(raw.type || ""));
      // "Next date" (full layout) or "Planned date" (short layout) = when Concerto expects it
      const next = toIsoDate(raw.nextDate) || toIsoDate(raw.plannedDate);
      if (!sr && !site.code) { out.skipped++; continue; }
      // One row per Concerto site + PPM type; the next date rolls on it (and is logged).
      const id = `SCH:${sr || site.code}:${type}`;
      const r = site.code ? { code: site.code, name: site.name } : resolveRef(map, sr, "");
      if (sr && site.code) await learnConcertoRef(env, tid, sr, site.code, site.name, "schedule-export");
      const orderNr = normRef(raw.orderNr || "");
      const freq = parseInt(String(raw.frequency || "").replace(/\D/g, ""), 10) || null;
      rec = { id, kind: "schedule", order_date: null, order_value: null, description: `${raw.type || raw.ref || ""} — next ${next || "?"}`.trim(),
        ppm_type: type, period: next ? next.slice(0, 7) : "", asset_ref: normRef(raw.ref || ""), sr_ref: sr,
        store_code: r ? r.code : "", site_name: r ? r.name : site.name, supplier: String(raw.supplier || "").slice(0, 80),
        target_response: null, actual_response: null, planned_date: next, last_date: toIsoDate(raw.lastDate),
        next_date: next, order_nr: orderNr, ordered_value: raw.ordered === "" || raw.ordered == null ? null : Number(raw.ordered) || null,
        released_at: orderNr ? now : null, concerto_status: String(raw.status || "").slice(0, 40), month_marker: String(raw.monthMarker || "").slice(0, 40),
        discipline: String(raw.discipline || "").slice(0, 40), frequency_months: freq, block: String(raw.block || "").slice(0, 120) };
    } else {
      const id = normRef(raw.orderNumber);
      if (!id) { out.skipped++; continue; }
      const p = parseOrderDescription(raw.description);
      const r = resolveRef(map, p.srRef, p.ref);
      rec = { id, kind: "order", order_date: toIsoDate(raw.orderDate), order_value: raw.orderValue === "" || raw.orderValue == null ? null : Number(raw.orderValue),
        description: String(raw.description || "").slice(0, 300), ppm_type: p.type, period: p.period, asset_ref: p.ref, sr_ref: p.srRef,
        store_code: r ? r.code : "", site_name: r ? r.name : "", supplier: String(raw.supplier || "").slice(0, 80),
        target_response: toIsoDate(raw.targetResponse), actual_response: toIsoDate(raw.actualResponse), planned_date: null, last_date: null,
        next_date: null, order_nr: id, ordered_value: null, released_at: null, concerto_status: "", month_marker: "", discipline: "", frequency_months: null, block: "" };
    }
    if (seen.has(rec.id)) continue;
    seen.add(rec.id); typesSeen.add(rec.ppm_type); out.ids.push(rec.id);
    if (!rec.store_code) out.unresolved++;
    const ex = await env.DB.prepare("SELECT id, status, order_nr, next_date FROM concerto_ppm WHERE tenant_id=? AND id=?").bind(tid, rec.id).first();
    if (ex) out.updated++; else { out.added++; log(rec.id, "imported", { type: rec.ppm_type, next: rec.next_date, store: rec.store_code }); }
    if (rec.kind === "schedule") {
      // First sight of an order number against this schedule row = the client RELEASED it.
      if (rec.order_nr && !(ex && ex.order_nr)) { out.released++; log(rec.id, "released", { orderNr: rec.order_nr, next: rec.next_date, store: rec.store_code, value: rec.ordered_value, daysBeforeDue: rec.next_date ? Math.round((Date.parse(rec.next_date) - Date.parse(now.slice(0, 10))) / 86400000) : null }); }
      if (ex && ex.next_date && rec.next_date && ex.next_date !== rec.next_date) log(rec.id, "next_date_changed", { from: ex.next_date, to: rec.next_date, store: rec.store_code });
    }
    stmts.push(env.DB.prepare(`INSERT INTO concerto_ppm (id,tenant_id,kind,order_date,order_value,description,ppm_type,period,asset_ref,sr_ref,store_code,site_name,supplier,target_response,actual_response,planned_date,last_date,status,note,source_file,first_seen_at,last_seen_at,gone_at,updated_at,next_date,order_nr,ordered_value,released_at,concerto_status,month_marker,discipline,frequency_months,block)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','',?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,id) DO UPDATE SET
        kind=excluded.kind, order_date=COALESCE(excluded.order_date, concerto_ppm.order_date), order_value=COALESCE(excluded.order_value, concerto_ppm.order_value),
        description=excluded.description, ppm_type=excluded.ppm_type, period=excluded.period, asset_ref=excluded.asset_ref, sr_ref=excluded.sr_ref,
        store_code=CASE WHEN excluded.store_code<>'' THEN excluded.store_code ELSE concerto_ppm.store_code END,
        site_name=CASE WHEN excluded.site_name<>'' THEN excluded.site_name ELSE concerto_ppm.site_name END,
        supplier=excluded.supplier, target_response=excluded.target_response, actual_response=excluded.actual_response,
        planned_date=COALESCE(excluded.planned_date, concerto_ppm.planned_date), last_date=COALESCE(excluded.last_date, concerto_ppm.last_date),
        status=CASE WHEN concerto_ppm.status IN ('gone') THEN 'open' ELSE concerto_ppm.status END,
        source_file=excluded.source_file, last_seen_at=excluded.last_seen_at, gone_at=NULL, updated_at=excluded.updated_at,
        next_date=COALESCE(excluded.next_date, concerto_ppm.next_date),
        order_nr=CASE WHEN COALESCE(excluded.order_nr,'')<>'' THEN excluded.order_nr
                      WHEN COALESCE(excluded.next_date,'')<>'' AND excluded.next_date<>COALESCE(concerto_ppm.next_date,'') THEN NULL
                      ELSE concerto_ppm.order_nr END,
        ordered_value=CASE WHEN COALESCE(excluded.order_nr,'')<>'' THEN COALESCE(excluded.ordered_value, concerto_ppm.ordered_value)
                           WHEN COALESCE(excluded.next_date,'')<>'' AND excluded.next_date<>COALESCE(concerto_ppm.next_date,'') THEN NULL
                           ELSE concerto_ppm.ordered_value END,
        released_at=CASE WHEN COALESCE(excluded.order_nr,'')<>'' THEN COALESCE(concerto_ppm.released_at, excluded.released_at)
                         WHEN COALESCE(excluded.next_date,'')<>'' AND excluded.next_date<>COALESCE(concerto_ppm.next_date,'') THEN NULL
                         ELSE concerto_ppm.released_at END,
        concerto_status=CASE WHEN COALESCE(excluded.concerto_status,'')<>'' THEN excluded.concerto_status ELSE concerto_ppm.concerto_status END,
        month_marker=CASE WHEN COALESCE(excluded.month_marker,'')<>'' THEN excluded.month_marker ELSE concerto_ppm.month_marker END,
        discipline=COALESCE(NULLIF(excluded.discipline,''), concerto_ppm.discipline), frequency_months=COALESCE(excluded.frequency_months, concerto_ppm.frequency_months),
        block=COALESCE(NULLIF(excluded.block,''), concerto_ppm.block)`)
      .bind(rec.id, tid, rec.kind, rec.order_date, rec.order_value, rec.description, rec.ppm_type, rec.period, rec.asset_ref, rec.sr_ref, rec.store_code, rec.site_name,
        rec.supplier, rec.target_response, rec.actual_response, rec.planned_date, rec.last_date, String(fileName || "").slice(0, 120), now, now, now,
        rec.next_date, rec.order_nr, rec.ordered_value, rec.released_at, rec.concerto_status, rec.month_marker, rec.discipline, rec.frequency_months, rec.block));
  }
  for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20));
  for (let i = 0; i < logs.length; i += 20) await env.DB.batch(logs.slice(i, i + 20));
  const logged = logs.length;
  // A full "open" orders list is authoritative: anything open that it no longer
  // lists has been closed on Concerto. A schedule export is per type: any open
  // schedule row of a type it carries that it no longer lists has gone.
  if (seen.size) {
    const kind = layout === "schedule" ? "schedule" : "order";
    const { results } = await env.DB.prepare("SELECT id, ppm_type FROM concerto_ppm WHERE tenant_id=? AND kind=? AND status='open'").bind(tid, kind).all();
    const goneIds = (results || []).filter(r => !seen.has(r.id) && (kind === "order" || typesSeen.has(r.ppm_type))).map(r => r.id);
    for (const id of goneIds) { await env.DB.prepare("UPDATE concerto_ppm SET status='gone', gone_at=?, updated_at=? WHERE tenant_id=? AND id=?").bind(now, now, tid, id).run(); log(id, "gone", {}); }
    out.gone = goneIds.length;
    for (let i = logged; i < logs.length; i += 20) await env.DB.batch(logs.slice(i, i + 20));
  }
  return out;
}

/* ── Reconciliation ───────────────────────────────────────────────────────── */
async function chartStores(env, tid) {
  const { results } = await env.DB.prepare(`SELECT cs.code, cs.category, cs.due, cs.active, cs.name,
      (SELECT s.site_name FROM sites s WHERE s.site_number <> '' AND s.site_number NOT GLOB '*[^0-9]*' AND CAST(s.site_number AS INTEGER)=CAST(cs.code AS INTEGER) ORDER BY LENGTH(s.site_number) LIMIT 1) AS site_name
    FROM compliance_stores cs WHERE cs.scheme='coop' AND cs.code <> '' AND cs.code NOT GLOB '*[^0-9]*'`).bind().all();
  const m = new Map();
  for (const r of results || []) {
    let due = {}; try { due = JSON.parse(r.due || "{}") || {}; } catch {}
    const parsed = {}; for (const k of Object.keys(due)) { const d = toIsoDate(due[k]); if (d) parsed[k] = d; }
    const closed = r.active === 0 || /closed/i.test(String(r.name || r.site_name || "")) || Object.values(due).some(v => /closed/i.test(String(v)));
    m.set(padCode(r.code), { code: padCode(r.code), category: r.category || "", name: r.site_name || r.name || "", due: parsed, closed });
  }
  return m;
}
const FINISHED = new Set(["complete", "closed jobs", "closed", "invoiced", "cancelled"]);
async function bookedJobs(env, tid) {
  const out = new Map();   // code|type → {id, ref, scheduledAt, engineer, status}
  let jobs = []; try { jobs = await listJobs(env, tid); } catch {}
  for (const j of jobs) {
    if (FINISHED.has(String(j.status || "").toLowerCase())) continue;
    const code = padCode(j.siteCode); if (!code) continue;
    const types = []; if (j.emTest) types.push("em"); if (j.pat) types.push("pat"); if (j.pumpMaintenance) types.push("pump"); if (j.elecTest) types.push("fiveYear");
    for (const t of types) {
      const k = code + "|" + t;
      const cur = out.get(k);
      if (!cur || (j.scheduledAt || "") > (cur.scheduledAt || "")) out.set(k, { id: j.id, ref: j.helpdeskRef || j.siteName || "", scheduledAt: j.scheduledAt || null, engineer: (Array.isArray(j.assignedEngineers) && j.assignedEngineers[0]) || j.assignedTo || "", status: j.status || "" });
    }
  }
  return out;
}
// The flag for one Concerto row against the chart. Exported for the tests.
export function reconcileRow(row, store, today) {
  today = today || todayIso();
  if (!row.store_code) return { flag: "no_store", text: "Reference not mapped to a store yet" };
  if (!store) return { flag: "not_on_chart", text: `Store ${row.store_code} is not on the compliance chart` };
  if (store.closed) return { flag: "store_closed", text: "Store is closed on the chart" };
  const type = row.ppm_type, freq = FREQ_MONTHS[type];
  const chartDue = store.due[type] || null;
  if (!freq || !chartDue) return { flag: "no_chart_date", text: `The chart has no ${TYPE_LABEL[type] || type} date for this store`, chartDue };
  // Concerto's period = the month the PPM falls due (order rows) or the planned date (schedule rows).
  const pStart = row.planned_date || (row.period ? row.period + "-01" : null);
  const pEnd = row.planned_date ? row.planned_date : (row.period ? addDays(addMonths(row.period + "-01", 1), -1) : null);
  const cDue = fmtUk(chartDue), cPer = fmtPeriodUk(row);
  if (!pStart) return { flag: chartDue < today ? "overdue" : "due", text: chartDue < today ? `Overdue on the chart (${cDue})` : `Due ${cDue}`, chartDue };
  const slack = freq >= 12 ? 45 : 10;
  const lastDone = addMonths(chartDue, -freq);           // when the chart last saw it done
  if (lastDone >= addDays(pStart, -slack)) return { flag: "done", text: `Done our side around ${fmtUk(lastDone)} — Concerto still shows it open`, chartDue, lastDone };
  if (chartDue >= addDays(pStart, -slack) && chartDue <= addDays(pEnd, slack)) {
    return chartDue < today ? { flag: "overdue", text: `Overdue — chart ${cDue}, Concerto ${cPer}`, chartDue }
                            : { flag: "due", text: `Due ${cDue} (Concerto ${cPer})`, chartDue };
  }
  if (chartDue < pStart) {
    // COVERAGE GAP: our certificate runs out BEFORE Concerto plans the next test, so if the
    // site were tested to Concerto's date it would sit with no valid certificate in between.
    const gapDays = Math.round((Date.parse(pStart + "T00:00:00Z") - Date.parse(chartDue + "T00:00:00Z")) / 864e5);
    const span = gapDays >= 60 ? `about ${Math.round(gapDays / 30)} months` : `${gapDays} days`;
    const text = chartDue < today
      ? `Our certificate ran out on ${cDue} but Concerto has the next test planned for ${cPer}. The site has NO valid certificate right now and will not have one until it is tested — ${span} uncovered if we wait for Concerto's date. Get it tested and get Concerto's date corrected.`
      : `Our certificate runs out on ${cDue} but Concerto has the next test planned for ${cPer}. If we wait for Concerto's date the site would have no valid certificate for ${span}. Test it by ${cDue} and get Concerto's date corrected.`;
    return { flag: "gap", text, chartDue, gapFrom: chartDue, gapTo: pStart, gapDays };
  }
  return { flag: "mismatch", text: `Chart says due ${cDue}, later than Concerto's ${cPer} — Concerto is early, the site stays covered`, chartDue };
}
async function buildList(env, tid, opts) {
  await ensureTables(env);
  const status = opts.status === "all" ? null : "open";
  const kind = opts.kind === "schedule" ? "schedule" : "order";
  const { results: allOpen } = await env.DB.prepare("SELECT * FROM concerto_ppm WHERE tenant_id=?" + (status ? " AND status='open'" : "") + " ORDER BY COALESCE(planned_date, period) ASC, id ASC").bind(tid).all();
  const results = (allOpen || []).filter(r => (r.kind || "order") === kind);
  const stores = await chartStores(env, tid);
  const booked = await bookedJobs(env, tid);
  const today = todayIso();
  const rows = (results || []).map(r => {
    const store = r.store_code ? stores.get(r.store_code) : null;
    const rec = r.status === "open" ? reconcileRow(r, store, today) : { flag: r.status, text: r.status === "gone" ? ("No longer on the Concerto list" + (r.gone_at ? " since " + fmtUk(r.gone_at) : "")) : (r.note || "") };
    const job = r.store_code ? booked.get(r.store_code + "|" + r.ppm_type) : null;
    return { id: r.id, kind: r.kind, orderDate: r.order_date, orderValue: opts.money ? r.order_value : undefined, description: r.description, type: r.ppm_type, typeLabel: TYPE_LABEL[r.ppm_type] || r.ppm_type,
      period: r.period, assetRef: r.asset_ref, srRef: r.sr_ref, storeCode: r.store_code || "", siteName: (store && store.name) || r.site_name || "", supplier: r.supplier,
      plannedDate: r.planned_date, lastDate: r.last_date, status: r.status, note: r.note || "", sourceFile: r.source_file, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, goneAt: r.gone_at,
      flag: rec.flag, flagText: rec.text, chartDue: rec.chartDue || (store && store.due[r.ppm_type]) || null, lastDone: rec.lastDone || null, category: store ? store.category : "", job: job || null,
      nextDate: r.next_date || null, orderNr: r.order_nr || "", orderedValue: opts.money ? r.ordered_value : undefined, releasedAt: r.released_at || null, concertoStatus: r.concerto_status || "", monthMarker: r.month_marker || "", block: r.block || "" };
  });
  // Reverse check: stores overdue (or due within 30 days) on the chart for the
  // PPM types Concerto schedules (5-year, EM, PAT, pump, PV, EV), with NO open
  // Concerto row for that store+type.
  const covered = new Set((allOpen || []).filter(r => r.status === "open" && r.store_code).map(r => r.store_code + "|" + r.ppm_type));
  const chartMissing = [];
  const soon = addDays(today, 30);
  for (const s of stores.values()) {
    if (s.closed) continue;
    for (const type of ["fiveYear", "em", "pat", "pump", "pv", "ev"]) {
      const d = s.due[type]; if (!d || covered.has(s.code + "|" + type)) continue;
      if (d <= soon) chartMissing.push({ storeCode: s.code, siteName: s.name, category: s.category, type, typeLabel: TYPE_LABEL[type], chartDue: d, overdue: d < today, job: booked.get(s.code + "|" + type) || null });
    }
  }
  chartMissing.sort((a, b) => a.chartDue.localeCompare(b.chartDue));
  const counts = {};
  for (const r of rows) counts[r.flag] = (counts[r.flag] || 0) + 1;
  counts.open = rows.filter(r => r.status === "open").length;
  counts.chartMissing = chartMissing.length; counts.chartOverdue = chartMissing.filter(x => x.overdue).length;
  return { rows, chartMissing, counts, today };
}

/* ── Schedule view: what we have done and when, per site ─────────────────────
   For every schedule row the portal's own record of that PPM type at the store:
   the newest certificate on file (compliance_files), live SLA jobs and the
   imported job archive (Workever/Commusoft history) — matched by numeric store
   code + a type keyword. Filterable timeline + released / not-yet-released. */
const TYPE_KEYWORDS = {
  fiveYear: /5\s*-?\s*y(ea)?r|five\s*year|eicr|fixed\s*wire|periodic\s*insp|electrical\s*(installation\s*)?condition/i,
  em: /emergency\s*light|\bem\s*(light|test|drain)|3\s*hr\s*drain|drain\s*-?\s*down/i,
  pat: /\bpat\b|portable\s*appliance/i,
  pump: /pump/i, pv: /\bpv\b|solar/i, ev: /\bev\b|charg|forecourt/i,
};
const numEq = (a, b) => { const x = String(a || "").replace(/\D/g, ""), y = String(b || "").replace(/\D/g, ""); return x && y && Number(x) === Number(y); };
function jobDoneDate(j) {
  const h = Array.isArray(j.statusHistory) ? j.statusHistory : [];
  for (let i = h.length - 1; i >= 0; i--) { const st = String(h[i].status || h[i].to || "").toLowerCase(); if (st === "complete" || st === "closed jobs" || st === "closed" || st === "invoiced") return String(h[i].at || h[i].time || h[i].ts || "").slice(0, 10) || null; }
  return null;
}
async function historyIndex(env, tid, type, preloadedJobs) {
  const kw = TYPE_KEYWORDS[type] || TYPE_KEYWORDS.fiveYear;
  const byCode = new Map();
  const push = (code, item) => { const k = padCode(code); if (!k) return; if (!byCode.has(k)) byCode.set(k, []); byCode.get(k).push(item); };
  // Certificates on the chart
  try {
    const { results } = await env.DB.prepare("SELECT code, doc_date, uploaded_at, year, filename, label FROM compliance_files WHERE scheme='coop' AND type=?").bind(type).all();
    for (const f of results || []) { const d = toIsoDate(f.doc_date) || (f.year ? f.year + "-01-01" : null) || (f.uploaded_at || "").slice(0, 10) || null; if (d) push(f.code, { source: "cert", date: d, title: f.label || f.filename || "Certificate", status: "filed" }); }
  } catch {}
  // Live jobs
  let jobs = preloadedJobs; if (!jobs) { try { jobs = await listJobs(env, tid); } catch { jobs = []; } }
  for (const j of jobs) {
    const text = [j.description, j.helpdeskRef, j.title].filter(Boolean).join(" ");
    const flagged = (type === "fiveYear" && j.elecTest) || (type === "em" && j.emTest) || (type === "pat" && j.pat) || (type === "pump" && j.pumpMaintenance);
    if (!flagged && !kw.test(text)) continue;
    const st = String(j.status || "");
    const done = FINISHED.has(st.toLowerCase()) && st.toLowerCase() !== "cancelled";
    push(j.siteCode, { source: "job", id: j.id, date: (done ? (jobDoneDate(j) || (j.scheduledAt || "").slice(0, 10)) : (j.scheduledAt || "").slice(0, 10)) || null, status: st, done, title: (j.helpdeskRef || j.description || "").slice(0, 80), engineer: (Array.isArray(j.assignedEngineers) && j.assignedEngineers[0]) || j.assignedTo || "" });
  }
  // Archive (imported history) — search is a lowercased haystack
  try {
    const { results } = await env.DB.prepare("SELECT id, site_code, ref, status, completed_at, created_at, site_name, substr(data,1,400) AS d FROM sla_jobs_archive WHERE site_code<>'' AND (search LIKE '%eicr%' OR search LIKE '%5 year%' OR search LIKE '%fixed wire%' OR search LIKE '%periodic%' OR search LIKE '%emergency light%' OR search LIKE '%pat test%' OR search LIKE '%portable appliance%' OR search LIKE '%pump%')").bind().all();
    for (const a of results || []) {
      let name = ""; try { const j = JSON.parse(a.d + (a.d.endsWith("}") ? "" : "\"}")); name = j.jobName || j.description || ""; } catch { const m = /"jobName":"([^"]*)"/.exec(a.d || ""); name = m ? m[1] : ""; }
      const text = name + " " + (a.ref || "");
      if (!kw.test(text) && !kw.test(a.d || "")) continue;
      const date = (a.completed_at || a.created_at || "").slice(0, 10) || null;
      push(a.site_code, { source: "archive", id: a.id, date, status: a.status || "", done: true, title: (name || a.ref || a.id).slice(0, 80) });
    }
  } catch {}
  for (const list of byCode.values()) list.sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")));
  return byCode;
}

/* ── 5-year EICR pipeline: one CASE per site per 5-year cycle (10 Sep 2026) ──
   Jamie's flow: job scheduled → test carried out → certificate reviewed
   (satisfactory / unsatisfactory) → approved in EasyCert → uploaded to Concerto
   → test invoiced on Concerto. An UNSATISFACTORY test adds: remedials quoted →
   order received → works done → certificate re-issued → remedials closed and
   invoiced on Concerto. It is a CHECKLIST, not a state machine — steps tick in
   any order (a quote can go out before the certificate is approved) and "next"
   is simply the first unticked step in the recommended order. The portal ticks
   what it can SEE (the elec-test job, the cert on file, the compliance-check
   outcome, a client order, the works job, a re-issued cert); the rest are
   one-tap manual ticks that log who/when. A manual tick or untick always beats
   the automatic reading. A case is ACTIVE once the site is released, due within
   a year, has a test job, or has been touched by hand — the 2031 rows sit as
   "not due yet" until then. */
export const CASE_STEPS = [
  { key: "checked",      label: "Checked — due, to be booked",                short: "Checked",  todo: "To check" },
  { key: "scheduled",    label: "Job booked",                                  short: "Booked",   todo: "To book",      auto: true },
  { key: "tested",       label: "Test carried out",                            short: "Test",     todo: "Test due",     auto: true },
  { key: "reviewed",     label: "Certificate reviewed — outcome set",          short: "Review",   todo: "To review",    auto: true },
  { key: "quoted",       label: "Remedials quoted",                            short: "Quote",    todo: "To quote",     unsat: true },
  { key: "ordered",      label: "Remedial order received",                     short: "Order",    todo: "Awaiting order", unsat: true, auto: true },
  { key: "works_done",   label: "Remedial works completed",                    short: "Works",    todo: "Works to do",  unsat: true, auto: true },
  { key: "cert_updated", label: "Certificate updated after the works",         short: "Re-issue", todo: "Cert to update", unsat: true, auto: true },
  { key: "approved",     label: "Certificate approved (EasyCert)",             short: "Approve",  todo: "To approve" },
  { key: "uploaded",     label: "Certificate uploaded to Concerto",            short: "Upload",   todo: "To upload" },
  { key: "invoiced",     label: "Test invoiced on Concerto",                   short: "Invoice",  todo: "To invoice" },
  { key: "rem_closed",   label: "Remedials closed & invoiced on Concerto",     short: "Rem. inv.", todo: "Remedials to close", unsat: true },
];
const STEP_KEYS = new Set(CASE_STEPS.map(s => s.key));
const caseId = (ppmId, cycleDue) => ppmId + "@" + (cycleDue || "none");
const REMEDIAL_ORDER = /eicr|5\s*-?\s*y(ea)?r|five\s*year|fixed\s*wire|electrical|remedial|\bC[123]\b/i;
async function caseContext(env, tid, type, jobs) {
  const ctx = { testJobs: new Map(), jobsById: new Map(), certs: new Map(), reviews: new Map(), orders: new Map(), cases: new Map(), log: new Map() };
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const j of jobs || []) {
    ctx.jobsById.set(String(j.id), j);
    const flagged = type === "fiveYear" ? j.elecTest : type === "em" ? j.emTest : type === "pat" ? j.pat : type === "pump" ? j.pumpMaintenance : false;
    if (!flagged) continue;
    const code = padCode(j.siteCode); if (!code) continue;
    const st = String(j.status || "").toLowerCase();
    if (st === "cancelled") continue;
    const done = FINISHED.has(st);
    const doneDate = done ? (jobDoneDate(j) || (j.scheduledAt || "").slice(0, 10) || null) : null;
    push(ctx.testJobs, code, { id: j.id, ref: j.helpdeskRef || j.siteName || "", status: j.status || "", done, doneDate, scheduledAt: j.scheduledAt || null,
      date: doneDate || (j.scheduledAt || "").slice(0, 10) || null, engineer: (Array.isArray(j.assignedEngineers) ? j.assignedEngineers : []).join(", "),
      worksJobId: j.remedialsWorksJobId || null, remedials: Array.isArray(j.remedials) ? j.remedials.length : 0 });
  }
  try {
    const { results } = await env.DB.prepare("SELECT id, code, doc_date, uploaded_at, year, filename, label FROM compliance_files WHERE scheme='coop' AND type=?").bind(type).all();
    for (const f of results || []) { const d = toIsoDate(f.doc_date) || (f.year ? f.year + "-01-01" : null) || (f.uploaded_at || "").slice(0, 10) || null; push(ctx.certs, padCode(f.code), { id: f.id, date: d, name: f.label || f.filename || "" }); }
    for (const l of ctx.certs.values()) l.sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")));
  } catch {}
  try {
    const { results } = await env.DB.prepare("SELECT code, outcome, attention, summary, file_id, doc_at, checked_at, updated_at, status FROM compliance_review WHERE scheme='coop' AND type=?").bind(type).all();
    for (const r of results || []) ctx.reviews.set(padCode(r.code), r);
  } catch {}
  try {
    const { results } = await env.DB.prepare("SELECT id, order_number, order_value, title, description, detail, store_code, status, matched_kind, matched_job_id, created_at, notified_at FROM client_orders WHERE tenant_id=? AND COALESCE(status,'')<>'dismissed' ORDER BY created_at DESC").bind(tid).all();
    for (const o of results || []) { const c = padCode(o.store_code); if (c) push(ctx.orders, c, o); }
  } catch {}
  try {
    const { results } = await env.DB.prepare("SELECT * FROM concerto_cases WHERE tenant_id=? AND ppm_type=?").bind(tid, type).all();
    for (const c of results || []) push(ctx.cases, c.ppm_id, c);
  } catch {}
  try {
    const { results } = await env.DB.prepare("SELECT ppm_id, detail, at FROM concerto_log WHERE tenant_id=? AND event='case' ORDER BY at DESC LIMIT 3000").bind(tid).all();
    for (const x of results || []) { let d = {}; try { d = JSON.parse(x.detail || "{}"); } catch {} push(ctx.log, x.ppm_id, { at: x.at, by: d.by || "", text: d.text || d.action || "" }); }
  } catch {}
  return ctx;
}
// Exported for the test harness. `r` = the concerto_ppm row; returns the case view.
export function deriveCase(r, ctx, today, money, rec) {
  today = today || todayIso();
  const code = r.store_code ? padCode(r.store_code) : "";
  const nextDate = r.next_date || r.planned_date || null;
  const stored = (ctx.cases.get(r.id) || []).slice().sort((a, b) => String(b.opened_at || "").localeCompare(String(a.opened_at || "")));
  let c = stored.find(x => !x.closed_at) || stored.find(x => x.closed_at && x.cycle_due === nextDate) || null;
  const cycleDue = (c && c.cycle_due) || nextDate;
  let manual = {}; try { manual = JSON.parse((c && c.steps) || "{}") || {}; } catch {}
  const wStart = cycleDue ? addMonths(cycleDue, -18) : "0000-00-00", wEnd = cycleDue ? addMonths(cycleDue, 24) : "9999-99-99";
  const inWin = d => !!d && d >= wStart && d <= wEnd;
  const tj = (code ? ctx.testJobs.get(code) || [] : []).filter(j => inWin(j.date)).sort((a, b) => (b.done - a.done) || String(b.date || "").localeCompare(String(a.date || "")));
  const testJob = tj[0] || null;
  const auto = {};
  if (testJob) auto.checked = { done: true, at: testJob.scheduledAt || testJob.date, detail: "A test job exists", source: "job", jobId: testJob.id };
  if (testJob) auto.scheduled = { done: true, at: testJob.scheduledAt || testJob.date, detail: (testJob.scheduledAt ? "Booked " + String(testJob.scheduledAt).slice(0, 10) : "On the board") + (testJob.engineer ? " — " + testJob.engineer : ""), source: "job", jobId: testJob.id };
  if (testJob && testJob.done) auto.tested = { done: true, at: testJob.doneDate, detail: "Job " + testJob.status + (testJob.engineer ? " — " + testJob.engineer : ""), source: "job", jobId: testJob.id };
  const testDate = testJob && testJob.done ? testJob.doneDate : null;
  // The cycle's certificate = the OLDEST cert filed after the test (a later one
  // is the re-issue after remedial works, picked up as cert_updated below).
  const certs = code ? ctx.certs.get(code) || [] : [];
  const cycleCerts = certs.filter(f => f.date && (testDate ? f.date >= addDays(testDate, -7) : inWin(f.date)));
  const cert = cycleCerts.length ? cycleCerts[cycleCerts.length - 1] : null;
  const rv = code ? ctx.reviews.get(code) : null;
  let outcomeAuto = "";
  if (rv && rv.outcome && cert && (rv.file_id === cert.id || String(rv.doc_at || rv.checked_at || "").slice(0, 10) >= cert.date)) {
    const o = String(rv.outcome); outcomeAuto = /unsat/i.test(o) ? "unsatisfactory" : /remedied/i.test(o) ? "remedied" : /sat/i.test(o) ? "satisfactory" : "";
  }
  if (outcomeAuto) auto.reviewed = { done: true, at: rv.checked_at || rv.updated_at || null, detail: "Compliance check read the certificate: " + rv.outcome, source: "review" };
  const outcome = (c && c.outcome) || (outcomeAuto === "remedied" ? "unsatisfactory" : outcomeAuto);
  const ords = (code ? ctx.orders.get(code) || [] : []).filter(o => o.matched_kind !== "em" && String(o.created_at || "") >= (testDate || wStart) && REMEDIAL_ORDER.test([o.title, o.description, o.detail].join(" ")));
  const order = ords[0] || null;
  if (order) auto.ordered = { done: true, at: order.created_at, detail: "Client order " + (order.order_number || "") + (money && order.order_value != null ? " (£" + Number(order.order_value).toFixed(2) + ")" : ""), source: "order", orderId: order.id };
  const wj = testJob && testJob.worksJobId ? ctx.jobsById.get(String(testJob.worksJobId)) : null;
  if (wj) {
    const wst = String(wj.status || "").toLowerCase(), wdone = FINISHED.has(wst) && wst !== "cancelled";
    auto.works_done = { done: wdone, at: wdone ? (jobDoneDate(wj) || (wj.scheduledAt || "").slice(0, 10) || null) : null, detail: wdone ? "Works job complete" : "Works job raised — " + (wj.status || "Pending") + ((wj.scheduledAt ? ", booked " + String(wj.scheduledAt).slice(0, 10) : "")), source: "job", jobId: wj.id };
  } else if (outcomeAuto === "remedied") auto.works_done = { done: true, at: null, detail: "Compliance check found a later Minor Works / EIC on file", source: "review" };
  const worksAt = auto.works_done && auto.works_done.done ? String(auto.works_done.at || "").slice(0, 10) : "";
  const cert2 = worksAt ? cycleCerts.find(f => f.date >= worksAt && (!cert || f.id !== cert.id)) || null : null;
  if (cert2) auto.cert_updated = { done: true, at: cert2.date, detail: cert2.name, source: "cert" };
  else if (outcomeAuto === "remedied") auto.cert_updated = { done: true, at: null, detail: "Remedial certificate on file", source: "review" };
  const steps = CASE_STEPS.map(s => {
    const m = manual[s.key], a = auto[s.key], forced = m && typeof m.done === "boolean";
    const done = forced ? m.done : !!(a && a.done);
    return { key: s.key, label: s.label, short: s.short, todo: s.todo || s.label, unsat: !!s.unsat, done, source: forced ? "manual" : (a ? "auto" : ""),
      at: (forced && m.done ? m.at : null) || (a && a.done ? a.at : null) || null, by: forced && m.done ? (m.by || "") : "", note: (m && m.note) || "",
      detail: (a && a.detail) || "", jobId: a && a.jobId || null, orderId: a && a.orderId || null,
      applicable: !s.unsat || outcome === "unsatisfactory" || forced };
  });
  const applicable = steps.filter(s => s.applicable);
  const nextStep = applicable.find(s => !s.done) || null;
  const allDone = applicable.length > 0 && !nextStep;
  const daysToDue = nextDate ? Math.round((Date.parse(nextDate + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 864e5) : null;
  const closed = !!(c && c.closed_at);
  const touched = Object.keys(manual).length > 0 || !!(c && (c.outcome || c.engineer || c.hold_reason || c.flag_note));
  // Automatic flag: the reconcile found a coverage gap (Concerto's date later than our
  // certificate's expiry). Derived from the dates, so it clears itself once they agree —
  // never stored, never clearable by hand. A manual 🚩 can sit alongside it.
  const autoFlag = !closed && rec && rec.flag === "gap" ? { reason: "gap", note: "⛔ No certificate cover: " + rec.text } : null;
  const flagged = !closed && (!!(c && c.flag_note) || !!autoFlag);
  const active = !closed && (!!r.order_nr || (daysToDue != null && daysToDue <= 365) || !!testJob || touched || !!autoFlag);
  const held = !closed && !!(c && c.hold_reason);
  const stage = closed ? "closed" : !active ? "not_due" : held ? "held" : allDone ? "complete" : nextStep.key;
  return { id: c ? c.id : caseId(r.id, cycleDue), stored: !!c, cycleDue, active, closed, closedAt: c && c.closed_at || null, closedBy: c && c.closed_by || "",
    held, holdReason: held ? c.hold_reason : "", heldBy: held ? c.held_by || "" : "", heldAt: held ? c.held_at || null : null,
    flagged, flagNote: !closed && c && c.flag_note ? c.flag_note : "", flaggedBy: !closed && c && c.flag_note ? c.flagged_by || "" : "", flaggedAt: !closed && c && c.flag_note ? c.flagged_at || null : null,
    autoFlag,
    outcome, outcomeAuto, outcomeSource: c && c.outcome ? "manual" : outcomeAuto ? "review" : "",
    engineer: (c && c.engineer) || (testJob && testJob.engineer) || "", engineerSource: c && c.engineer ? "manual" : testJob && testJob.engineer ? "job" : "",
    stage, next: nextStep ? nextStep.key : null, nextLabel: nextStep ? nextStep.label : (allDone ? "All steps done — close the case" : ""), nextTodo: nextStep ? nextStep.todo : "", allDone, steps, daysToDue,
    testJob: testJob ? { id: testJob.id, ref: testJob.ref, status: testJob.status, date: testJob.date, engineer: testJob.engineer, remedials: testJob.remedials, worksJobId: testJob.worksJobId } : null,
    worksJob: wj ? { id: wj.id, status: wj.status || "", scheduledAt: wj.scheduledAt || null } : null,
    cert: cert ? { id: cert.id, date: cert.date, name: cert.name } : null, certUpdated: cert2 ? { id: cert2.id, date: cert2.date, name: cert2.name } : null,
    review: rv && rv.outcome ? { outcome: rv.outcome, attention: !!rv.attention, summary: rv.summary || "", checkedAt: rv.checked_at || null } : null,
    order: order ? { id: order.id, number: order.number || order.order_number || "", value: money ? order.order_value : undefined, at: order.created_at } : null,
    log: (ctx.log.get(r.id) || []).slice(0, 12) };
}
async function buildSchedule(env, tid, opts) {
  await ensureTables(env);
  const type = opts.type || "fiveYear";
  const { results } = await env.DB.prepare("SELECT * FROM concerto_ppm WHERE tenant_id=? AND kind='schedule' AND ppm_type=?" + (opts.status === "all" ? "" : " AND status='open'") + " ORDER BY next_date ASC, store_code ASC").bind(tid, type).all();
  const stores = await chartStores(env, tid);
  let jobs = []; try { jobs = await listJobs(env, tid); } catch {}
  const hist = await historyIndex(env, tid, type, jobs);
  const booked = await bookedJobs(env, tid);
  const today = todayIso();
  const pipeline = type === "fiveYear";
  const cctx = pipeline ? await caseContext(env, tid, type, jobs) : null;
  const rows = (results || []).map(r => {
    const store = r.store_code ? stores.get(r.store_code) : null;
    const rec = r.status === "open" ? reconcileRow(r, store, today) : { flag: r.status, text: r.note || "" };
    const h = (r.store_code && hist.get(r.store_code)) || [];
    const done = h.filter(x => x.source === "cert" || x.done);
    const lastDone = done[0] || null;
    const job = r.store_code ? booked.get(r.store_code + "|" + type) : null;
    return { id: r.id, type, typeLabel: TYPE_LABEL[type] || type, srRef: r.sr_ref, storeCode: r.store_code || "", siteName: (store && store.name) || r.site_name || "", block: r.block || "", category: store ? store.category : "",
      nextDate: r.next_date || r.planned_date || null, lastDate: r.last_date || null, released: !!r.order_nr, orderNr: r.order_nr || "", orderedValue: opts.money ? r.ordered_value : undefined, releasedAt: r.released_at || null,
      concertoStatus: r.concerto_status || "", monthMarker: r.month_marker || "", status: r.status, note: r.note || "", lastSeenAt: r.last_seen_at,
      chartDue: (store && store.due[type]) || null, flag: rec.flag, flagText: rec.text,
      lastDone, history: h.slice(0, 6), job: job || null, case: cctx ? deriveCase(r, cctx, today, !!opts.money, rec) : undefined };
  });
  const from = opts.from || "", to = opts.to || "";
  const filtered = rows.filter(r => (!from || (r.nextDate || "") >= from) && (!to || (r.nextDate || "") <= to) && (opts.released === "yes" ? r.released : opts.released === "no" ? !r.released : true));
  const byYear = {};
  for (const r of rows) { const y = (r.nextDate || "").slice(0, 4) || "none"; byYear[y] = byYear[y] || { total: 0, released: 0, done: 0 }; byYear[y].total++; if (r.released) byYear[y].released++; if (r.flag === "done") byYear[y].done++; }
  const stats = { sites: rows.length, released: rows.filter(r => r.released).length, notReleased: rows.filter(r => !r.released).length, done: rows.filter(r => r.flag === "done").length, overdue: rows.filter(r => r.flag === "overdue").length, mismatch: rows.filter(r => r.flag === "mismatch").length, gap: rows.filter(r => r.flag === "gap").length, noStore: rows.filter(r => r.flag === "no_store").length, notOnChart: rows.filter(r => r.flag === "not_on_chart").length, withHistory: rows.filter(r => r.lastDone).length, byYear };
  let releaseLog = [];
  try { const { results: lg } = await env.DB.prepare("SELECT ppm_id, detail, at FROM concerto_log WHERE tenant_id=? AND event='released' ORDER BY at DESC LIMIT 500").bind(tid).all(); releaseLog = (lg || []).map(x => { let d = {}; try { d = JSON.parse(x.detail || "{}"); } catch {} return { id: x.ppm_id, at: x.at, ...d }; }); } catch {}
  const lead = releaseLog.map(x => x.daysBeforeDue).filter(n => Number.isFinite(n));
  stats.releaseLeadDaysAvg = lead.length ? Math.round(lead.reduce((a, b) => a + b, 0) / lead.length) : null;
  stats.releasesLogged = releaseLog.length;
  // Month-by-month workload (next due) + the chase list: due within 90 days, not released.
  const byMonth = {};
  for (const r of rows) { const m = (r.nextDate || "").slice(0, 7); if (!m) continue; const b = byMonth[m] = byMonth[m] || { total: 0, released: 0, done: 0, value: 0 }; b.total++; if (r.released) b.released++; if (r.flag === "done" || (r.case && r.case.steps.some(s => s.key === "tested" && s.done))) b.done++; if (opts.money && r.orderedValue) b.value += Number(r.orderedValue) || 0; }
  stats.byMonth = byMonth;
  stats.dueSoonNotReleased = rows.filter(r => !r.released && r.nextDate && r.nextDate <= addDays(today, 90) && r.status === "open").length;
  if (pipeline) {
    const byStage = {}, byEngineer = {};
    for (const r of rows) {
      const c = r.case; if (!c) continue;
      byStage[c.stage] = (byStage[c.stage] || 0) + 1;
      const tj = c.testJob; if (tj && tj.engineer) { const e = byEngineer[tj.engineer] = byEngineer[tj.engineer] || { tested: 0, scheduled: 0, byYear: {} }; if (tj.done !== false && c.steps.some(s => s.key === "tested" && s.done)) { e.tested++; const y = String(tj.date || "").slice(0, 4); if (y) e.byYear[y] = (e.byYear[y] || 0) + 1; } else e.scheduled++; }
    }
    stats.pipeline = { byStage, active: rows.filter(r => r.case && r.case.active && !r.case.closed).length, flagged: rows.filter(r => r.case && r.case.flagged).length, held: byStage.held || 0, complete: byStage.complete || 0, notDue: byStage.not_due || 0, closed: byStage.closed || 0, steps: CASE_STEPS };
    stats.byEngineer = byEngineer;
  }
  return { type, rows: filtered, total: rows.length, stats, today };
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */
export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Unauthorised", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const perms = await permissionsFor(env, tid, me);
  const office = perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes" || perms.Compliance === "Yes";
  if (!office) return error("Compliance, SLA Admin or Full Access needed", 403, env, request);
  const money = await canSeeMoney(env, tid, me);
  const path = url.pathname, method = request.method.toUpperCase();
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  if (path === "/concerto/list" && method === "GET") {
    const out = await buildList(env, tid, { status: url.searchParams.get("status") || "open", kind: url.searchParams.get("kind") || "order", money });
    return json({ ok: true, money, ...out }, {}, env, request);
  }
  if (path === "/concerto/schedule" && method === "GET") {
    const q = url.searchParams;
    const out = await buildSchedule(env, tid, { type: q.get("type") || "fiveYear", from: q.get("from") || "", to: q.get("to") || "", released: q.get("released") || "all", status: q.get("status") || "open", money });
    return json({ ok: true, money, ...out }, {}, env, request);
  }
  if (path === "/concerto/case" && method === "POST") {
    const b = await body();
    const ppmId = String(b.ppmId || "").trim(); if (!ppmId) return error("Need ppmId", 400, env, request);
    await ensureTables(env);
    const row = await env.DB.prepare("SELECT id, store_code, ppm_type, next_date, planned_date FROM concerto_ppm WHERE tenant_id=? AND id=?").bind(tid, ppmId).first();
    if (!row) return error("Schedule row not found", 404, env, request);
    const now = new Date().toISOString();
    let c = await env.DB.prepare("SELECT * FROM concerto_cases WHERE tenant_id=? AND ppm_id=? AND closed_at IS NULL").bind(tid, ppmId).first();
    const events = [];
    if (!c) {
      const cycle = String(b.cycleDue || row.next_date || row.planned_date || "");
      const id = String(b.caseId || caseId(ppmId, cycle));
      c = await env.DB.prepare("SELECT * FROM concerto_cases WHERE tenant_id=? AND id=?").bind(tid, id).first();
      if (!c) {
        await env.DB.prepare("INSERT INTO concerto_cases (tenant_id,id,ppm_id,store_code,ppm_type,cycle_due,outcome,engineer,steps,opened_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(tid, id, ppmId, row.store_code || "", row.ppm_type || "fiveYear", cycle, "", "", "{}", now, now, me).run();
        c = await env.DB.prepare("SELECT * FROM concerto_cases WHERE tenant_id=? AND id=?").bind(tid, id).first();
      } else if (c.closed_at && (b.reopen || b.step || b.outcome !== undefined || b.hold || b.flag)) { c.closed_at = null; c.closed_by = null; events.push({ action: "reopen", text: "Case reopened" }); }
    }
    let steps = {}; try { steps = JSON.parse(c.steps || "{}") || {}; } catch {}
    if (b.step !== undefined) {
      const key = String(b.step || "");
      if (!STEP_KEYS.has(key)) return error("Unknown step", 400, env, request);
      const label = (CASE_STEPS.find(s => s.key === key) || {}).label || key;
      if (b.reset) { delete steps[key]; events.push({ action: "reset", step: key, text: "Back to automatic: " + label }); }
      else {
        const cur = steps[key] || {};
        if (typeof b.done === "boolean") { cur.done = b.done; cur.at = b.done ? (toIsoDate(b.at) || now) : null; cur.by = me; events.push({ action: b.done ? "tick" : "untick", step: key, done: b.done, text: (b.done ? "Ticked: " : "Unticked: ") + label + (b.done && b.at ? " (" + toIsoDate(b.at) + ")" : "") }); }
        if (b.note !== undefined) { cur.note = String(b.note || "").slice(0, 300); events.push({ action: "note", step: key, note: cur.note, text: "Note on " + label + ": " + cur.note }); }
        steps[key] = cur;
      }
    }
    if (b.outcome !== undefined) {
      const o = String(b.outcome || "").toLowerCase();
      if (!["", "satisfactory", "unsatisfactory"].includes(o)) return error("outcome must be satisfactory | unsatisfactory | blank", 400, env, request);
      c.outcome = o; events.push({ action: "outcome", outcome: o, text: o ? "Outcome set: " + o : "Outcome cleared (back to the compliance check)" });
    }
    if (b.engineer !== undefined) { c.engineer = String(b.engineer || "").slice(0, 80); events.push({ action: "engineer", engineer: c.engineer, text: c.engineer ? "Tested by: " + c.engineer : "Engineer cleared (back to the job's engineer)" }); }
    if (b.hold !== undefined) {
      const reason = String(b.hold || "").slice(0, 200);
      if (reason) { c.hold_reason = reason; c.held_at = now; c.held_by = me; events.push({ action: "hold", hold: reason, text: "On hold: " + reason }); }
      else { c.hold_reason = null; c.held_at = null; c.held_by = null; events.push({ action: "resume", text: "Taken off hold" }); }
    }
    if (b.flag !== undefined) {
      const note = String(b.flag || "").slice(0, 300);
      if (note) { c.flag_note = note; c.flagged_at = now; c.flagged_by = me; events.push({ action: "flag", flag: note, text: "🚩 Flagged: " + note }); }
      else { c.flag_note = null; c.flagged_at = null; c.flagged_by = null; events.push({ action: "unflag", text: "Flag cleared" }); }
    }
    if (b.close) { c.closed_at = now; c.closed_by = me; c.hold_reason = null; c.flag_note = null; events.push({ action: "close", text: "Case closed" }); }
    if (b.reopen && c.closed_at) { c.closed_at = null; c.closed_by = null; events.push({ action: "reopen", text: "Case reopened" }); }
    await env.DB.prepare("UPDATE concerto_cases SET steps=?, outcome=?, engineer=?, hold_reason=?, held_at=?, held_by=?, flag_note=?, flagged_at=?, flagged_by=?, closed_at=?, closed_by=?, updated_at=?, updated_by=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(steps), c.outcome || "", c.engineer || "", c.hold_reason || null, c.held_at || null, c.held_by || null, c.flag_note || null, c.flagged_at || null, c.flagged_by || null, c.closed_at || null, c.closed_by || null, now, me, tid, c.id).run();
    for (const ev of events) await env.DB.prepare("INSERT INTO concerto_log (tenant_id, ppm_id, event, detail, at) VALUES (?,?,?,?,?)").bind(tid, ppmId, "case", JSON.stringify({ caseId: c.id, by: me, ...ev }), now).run();
    return json({ ok: true, caseId: c.id, events: events.length }, {}, env, request);
  }
  if (path === "/concerto/log" && method === "GET") {
    await ensureTables(env);
    const { results } = await env.DB.prepare("SELECT ppm_id, event, detail, at FROM concerto_log WHERE tenant_id=? ORDER BY at DESC LIMIT 1000").bind(tid).all();
    return json({ ok: true, events: (results || []).map(x => { let d = {}; try { d = JSON.parse(x.detail || "{}"); } catch {} return { id: x.ppm_id, event: x.event, at: x.at, ...d }; }) }, {}, env, request);
  }
  if (path === "/concerto/import" && method === "POST") {
    const b = await body();
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    if (!rows.length) return error("No rows to import", 400, env, request);
    const layout = b.layout === "schedule" ? "schedule" : "orders";
    const res = await importRows(env, tid, layout, rows, b.fileName || "");
    return json({ ok: true, layout, ...res }, {}, env, request);
  }
  if (path === "/concerto/ref" && method === "POST") {
    const b = await body();
    const ok = await learnConcertoRef(env, tid, b.ref, b.storeCode, b.siteName || "", "office:" + me);
    if (!ok) return error("Need a reference (SRnnnnn or ARnnnnnn) and a store number", 400, env, request);
    return json({ ok: true, ref: normRef(b.ref), storeCode: padCode(b.storeCode) }, {}, env, request);
  }
  if (path === "/concerto/refs" && method === "GET") {
    await ensureTables(env);
    const { results } = await env.DB.prepare("SELECT ref, store_code, site_name, kind, source, updated_at FROM concerto_refs WHERE tenant_id=? ORDER BY ref").bind(tid).all();
    return json({ ok: true, refs: (results || []).map(r => ({ ref: r.ref, storeCode: r.store_code, siteName: r.site_name, kind: r.kind, source: r.source, updatedAt: r.updated_at })) }, {}, env, request);
  }
  if (path === "/concerto/refs/seed" && method === "POST") {
    const b = await body(); let n = 0;
    for (const r of Array.isArray(b.refs) ? b.refs.slice(0, 2000) : []) if (await learnConcertoRef(env, tid, r.ref, r.storeCode, r.siteName || "", r.source || "seed")) n++;
    return json({ ok: true, learned: n }, {}, env, request);
  }
  if (path === "/concerto/status" && method === "POST") {
    const b = await body();
    const st = ["open", "dismissed", "done"].includes(b.status) ? b.status : null;
    if (!b.id || !st) return error("Need id + status (open | dismissed | done)", 400, env, request);
    await ensureTables(env);
    await env.DB.prepare("UPDATE concerto_ppm SET status=?, note=?, updated_at=? WHERE tenant_id=? AND id=?").bind(st, String(b.note || "").slice(0, 300), new Date().toISOString(), tid, String(b.id)).run();
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/concerto/stores" && method === "GET") {
    const stores = await chartStores(env, tid);
    return json({ ok: true, stores: [...stores.values()].map(s => ({ code: s.code, name: s.name, category: s.category, closed: s.closed })).sort((a, b) => a.code.localeCompare(b.code)) }, {}, env, request);
  }
  return error("Not found", 404, env, request);
}
