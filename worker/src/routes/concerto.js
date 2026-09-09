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
import { json, error } from "../lib/http.js";
import { permissionsFor, canSeeMoney } from "../lib/auth.js";
import { listJobs } from "./sla.js";

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS concerto_ppm (
    id TEXT NOT NULL, tenant_id TEXT NOT NULL, kind TEXT, order_date TEXT, order_value REAL,
    description TEXT, ppm_type TEXT, period TEXT, asset_ref TEXT, sr_ref TEXT,
    store_code TEXT, site_name TEXT, supplier TEXT, target_response TEXT, actual_response TEXT,
    planned_date TEXT, last_date TEXT, status TEXT, note TEXT, source_file TEXT,
    first_seen_at TEXT, last_seen_at TEXT, gone_at TEXT, updated_at TEXT,
    PRIMARY KEY (tenant_id, id))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS concerto_refs (
    tenant_id TEXT NOT NULL, ref TEXT NOT NULL, store_code TEXT, site_name TEXT,
    kind TEXT, source TEXT, updated_at TEXT,
    PRIMARY KEY (tenant_id, ref))`).run();
}

/* ── Parsing helpers (pure — exported for the test harness + seeding) ─────── */
export const FREQ_MONTHS = { fiveYear: 60, pat: 12, em: 12, pv: 12, ev: 12, pump: 1 };
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
  const out = { added: 0, updated: 0, unresolved: 0, gone: 0, skipped: 0, ids: [] };
  const seen = new Set(), typesSeen = new Set();
  const stmts = [];
  for (const raw of rows || []) {
    let rec;
    if (layout === "schedule") {
      const sr = srIn(raw.uprn) || normRef(raw.uprn);
      const site = splitSite(raw.site);
      const type = typeOf(String(raw.ref || "") + " " + String(raw.type || ""));
      const planned = toIsoDate(raw.plannedDate);
      if (!sr && !site.code) { out.skipped++; continue; }
      const id = `SCH:${sr || site.code}:${type}:${planned || "none"}`;
      const r = site.code ? { code: site.code, name: site.name } : resolveRef(map, sr, "");
      if (sr && site.code) await learnConcertoRef(env, tid, sr, site.code, site.name, "schedule-export");
      rec = { id, kind: "schedule", order_date: null, order_value: null, description: `${raw.type || raw.ref || ""} — planned ${planned || "?"}`.trim(),
        ppm_type: type, period: planned ? planned.slice(0, 7) : "", asset_ref: normRef(raw.ref || ""), sr_ref: sr,
        store_code: r ? r.code : "", site_name: r ? r.name : site.name, supplier: String(raw.supplier || "").slice(0, 80),
        target_response: null, actual_response: null, planned_date: planned, last_date: toIsoDate(raw.lastDate) };
    } else {
      const id = normRef(raw.orderNumber);
      if (!id) { out.skipped++; continue; }
      const p = parseOrderDescription(raw.description);
      const r = resolveRef(map, p.srRef, p.ref);
      rec = { id, kind: "order", order_date: toIsoDate(raw.orderDate), order_value: raw.orderValue === "" || raw.orderValue == null ? null : Number(raw.orderValue),
        description: String(raw.description || "").slice(0, 300), ppm_type: p.type, period: p.period, asset_ref: p.ref, sr_ref: p.srRef,
        store_code: r ? r.code : "", site_name: r ? r.name : "", supplier: String(raw.supplier || "").slice(0, 80),
        target_response: toIsoDate(raw.targetResponse), actual_response: toIsoDate(raw.actualResponse), planned_date: null, last_date: null };
    }
    if (seen.has(rec.id)) continue;
    seen.add(rec.id); typesSeen.add(rec.ppm_type); out.ids.push(rec.id);
    if (!rec.store_code) out.unresolved++;
    const ex = await env.DB.prepare("SELECT id, status FROM concerto_ppm WHERE tenant_id=? AND id=?").bind(tid, rec.id).first();
    if (ex) out.updated++; else out.added++;
    stmts.push(env.DB.prepare(`INSERT INTO concerto_ppm (id,tenant_id,kind,order_date,order_value,description,ppm_type,period,asset_ref,sr_ref,store_code,site_name,supplier,target_response,actual_response,planned_date,last_date,status,note,source_file,first_seen_at,last_seen_at,gone_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','',?,?,?,NULL,?)
      ON CONFLICT(tenant_id,id) DO UPDATE SET
        kind=excluded.kind, order_date=COALESCE(excluded.order_date, concerto_ppm.order_date), order_value=COALESCE(excluded.order_value, concerto_ppm.order_value),
        description=excluded.description, ppm_type=excluded.ppm_type, period=excluded.period, asset_ref=excluded.asset_ref, sr_ref=excluded.sr_ref,
        store_code=CASE WHEN excluded.store_code<>'' THEN excluded.store_code ELSE concerto_ppm.store_code END,
        site_name=CASE WHEN excluded.site_name<>'' THEN excluded.site_name ELSE concerto_ppm.site_name END,
        supplier=excluded.supplier, target_response=excluded.target_response, actual_response=excluded.actual_response,
        planned_date=COALESCE(excluded.planned_date, concerto_ppm.planned_date), last_date=COALESCE(excluded.last_date, concerto_ppm.last_date),
        status=CASE WHEN concerto_ppm.status IN ('gone') THEN 'open' ELSE concerto_ppm.status END,
        source_file=excluded.source_file, last_seen_at=excluded.last_seen_at, gone_at=NULL, updated_at=excluded.updated_at`)
      .bind(rec.id, tid, rec.kind, rec.order_date, rec.order_value, rec.description, rec.ppm_type, rec.period, rec.asset_ref, rec.sr_ref, rec.store_code, rec.site_name,
        rec.supplier, rec.target_response, rec.actual_response, rec.planned_date, rec.last_date, String(fileName || "").slice(0, 120), now, now, now));
  }
  for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20));
  // A full "open" orders list is authoritative: anything open that it no longer
  // lists has been closed on Concerto. A schedule export is filtered per type,
  // so it only retires future planned rows of the types it carries.
  if (seen.size) {
    const kind = layout === "schedule" ? "schedule" : "order";
    const { results } = await env.DB.prepare("SELECT id, ppm_type, planned_date FROM concerto_ppm WHERE tenant_id=? AND kind=? AND status='open'").bind(tid, kind).all();
    const goneIds = (results || []).filter(r => !seen.has(r.id) && (kind === "order" || (typesSeen.has(r.ppm_type) && r.planned_date && r.planned_date >= todayIso()))).map(r => r.id);
    for (const id of goneIds) await env.DB.prepare("UPDATE concerto_ppm SET status='gone', gone_at=?, updated_at=? WHERE tenant_id=? AND id=?").bind(now, now, tid, id).run();
    out.gone = goneIds.length;
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
  if (!pStart) return { flag: chartDue < today ? "overdue" : "due", text: chartDue < today ? `Overdue on the chart (${chartDue})` : `Due ${chartDue}`, chartDue };
  const slack = freq >= 12 ? 45 : 10;
  const lastDone = addMonths(chartDue, -freq);           // when the chart last saw it done
  if (lastDone >= addDays(pStart, -slack)) return { flag: "done", text: `Done our side around ${lastDone} — Concerto still shows it open`, chartDue, lastDone };
  if (chartDue >= addDays(pStart, -slack) && chartDue <= addDays(pEnd, slack)) {
    return chartDue < today ? { flag: "overdue", text: `Overdue — chart ${chartDue}, Concerto ${row.period || row.planned_date}`, chartDue }
                            : { flag: "due", text: `Due ${chartDue} (Concerto ${row.period || row.planned_date})`, chartDue };
  }
  if (chartDue < pStart) return { flag: "mismatch", text: `Chart says due ${chartDue}, earlier than Concerto's ${row.period || row.planned_date}`, chartDue };
  return { flag: "mismatch", text: `Chart says due ${chartDue}, later than Concerto's ${row.period || row.planned_date}`, chartDue };
}
async function buildList(env, tid, opts) {
  await ensureTables(env);
  const status = opts.status === "all" ? null : "open";
  const { results } = await env.DB.prepare("SELECT * FROM concerto_ppm WHERE tenant_id=?" + (status ? " AND status='open'" : "") + " ORDER BY COALESCE(planned_date, period) ASC, id ASC").bind(tid).all();
  const stores = await chartStores(env, tid);
  const booked = await bookedJobs(env, tid);
  const today = todayIso();
  const rows = (results || []).map(r => {
    const store = r.store_code ? stores.get(r.store_code) : null;
    const rec = r.status === "open" ? reconcileRow(r, store, today) : { flag: r.status, text: r.status === "gone" ? ("No longer on the Concerto list" + (r.gone_at ? " since " + r.gone_at.slice(0, 10) : "")) : (r.note || "") };
    const job = r.store_code ? booked.get(r.store_code + "|" + r.ppm_type) : null;
    return { id: r.id, kind: r.kind, orderDate: r.order_date, orderValue: opts.money ? r.order_value : undefined, description: r.description, type: r.ppm_type, typeLabel: TYPE_LABEL[r.ppm_type] || r.ppm_type,
      period: r.period, assetRef: r.asset_ref, srRef: r.sr_ref, storeCode: r.store_code || "", siteName: (store && store.name) || r.site_name || "", supplier: r.supplier,
      plannedDate: r.planned_date, lastDate: r.last_date, status: r.status, note: r.note || "", sourceFile: r.source_file, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, goneAt: r.gone_at,
      flag: rec.flag, flagText: rec.text, chartDue: rec.chartDue || (store && store.due[r.ppm_type]) || null, lastDone: rec.lastDone || null, category: store ? store.category : "", job: job || null };
  });
  // Reverse check: stores overdue (or due within 30 days) on the chart for the
  // PPM types Concerto schedules (5-year, EM, PAT, pump, PV, EV), with NO open
  // Concerto row for that store+type.
  const covered = new Set(rows.filter(r => r.status === "open" && r.storeCode).map(r => r.storeCode + "|" + r.type));
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
    const out = await buildList(env, tid, { status: url.searchParams.get("status") || "open", money });
    return json({ ok: true, money, ...out }, {}, env, request);
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
