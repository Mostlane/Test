// Portal-native EM / PAT certificates. The engineer fills the certificate on the
// job (it looks final to them), signs, and completes — the certificate is saved
// as a DRAFT for OFFICE REVIEW, where the office can edit every field, then
// FINALISE it: the portal assigns the certificate number, draws the Mostlane PDF
// (lib/certpdf.js) and files it straight onto the compliance chart (rolling the
// due date) — no Tysoft, no import. Prefill pulls the previous certificate's
// luminaire/appliance list forward so each visit is a re-confirm, not a retype.
//
//   GET  /certs/for-job?jobId=&type=   load/seed the job's cert (+ config, prefill)
//   POST /certs/save                   upsert a draft (engineer or office)
//   POST /certs/submit  {id}           engineer: mark submitted for office review
//   GET  /certs/pdf?id=                render the certificate PDF (owner or office)
//   GET  /certs/review                 office queue: drafts + submitted (Compliance|SLAAdmin|FullAccess)
//   GET  /certs/one?id=                one cert record (office)
//   GET  /certs/list?code=&type=       a site's issued history
//   GET  /certs/number?code=&type=     suggested next certificate number
//   POST /certs/finalise {id,certNumber?,docDate?}   office: issue → file to compliance
//   POST /certs/upload   (multipart)   office: file a replacement PDF instead of generating
//   GET  /certs/config / POST /certs/config          contractor + boilerplate defaults
//
// Table (self-migrating): certificates.  Config: app_config cert:config:<tid>.

import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { buildCertPdf } from "../lib/certpdf.js";
import { logoBytes } from "../lib/logo.js";
import { pdfExtractTokens } from "../lib/pdftext.js";
import { fileCertificatePdf } from "./compliance.js";
import { sendToUser, sendToPermission } from "./push.js";
import { createOrUpdateJobFromPayload, listJobs } from "./sla.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { sendEmail } from "../lib/email.js";
import { buildBatteryEnquiryPdf } from "../lib/batterypdf.js";
import { resolveTenantId } from "../lib/tenantdb.js";

const TYPES = ["em", "pat"];
const T = t => (t === "pat" ? "pat" : "em");

// The certificate CLIENT is decided by the SITE's client type (Jamie's rule):
// every Southern Co-op estate (Retail / ELS / ELS Private / Cobra) bills to the
// Co-op head office; Fareham Borough Council sites bill to the council. Returns a
// {name,address,postcode} block for a known client type, else null (fall back to
// the previous cert / config default).
function clientForSiteClient(sc) {
  sc = String(sc || "").toLowerCase().trim();
  if (sc === "retail" || sc === "els" || sc === "els_private" || sc === "cobra")
    return { name: "The Southern Co-op", address: "1000 Lakeside, Western Road, Portsmouth", postcode: "PO6 3FE" };
  if (sc === "fbc")
    return { name: "Fareham Borough Council", address: "Civic Offices, Civic Way, Fareham", postcode: "PO16 7AZ" };
  return null;
}
// Fill BLANK client fields on a cert record from its site's client type — PER
// FIELD, so a cert that carried only the client NAME (from an older seed) still
// gets its address + postcode. Never overwrites a value someone has typed. Used
// wherever a cert is read/rendered so the office and the PDF carry the right client.
async function backfillClient(env, tid, rec) {
  if (!rec) return rec;
  const code = rec.siteCode || "";
  if (!code) return rec;
  const sr = await env.DB.prepare("SELECT client FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, String(code)).first().catch(() => null);
  const m = clientForSiteClient(sr && sr.client);
  if (!m) return rec;
  rec.client = rec.client || {};
  if (!String(rec.client.name || "").trim()) rec.client.name = m.name;
  if (!String(rec.client.address || "").trim()) rec.client.address = m.address;
  if (!String(rec.client.postcode || "").trim()) rec.client.postcode = m.postcode;
  return rec;
}

const DEFAULT_CONFIG = {
  // Default client used to seed a NEW cert when the previous cert didn't supply one
  // (most EM/PAT work is Southern Co-op). Office-editable; the previous cert always
  // wins over this, and it's never applied over a value the office has typed.
  client: {
    name: "The Southern Co-op",
    address: "1000 Lakeside, Western Road, Portsmouth",
    postcode: "PO6 3FE",
  },
  contractor: {
    tradingTitle: "Mostlane",
    address: "Unit 5A Segensworth Road, Segensworth Business Centre",
    postcode: "PO15 5RQ",
    regNumber: "",
    telephone: "02380262000",
  },
  em: {
    extent: "Annual emergency light testing - Full 3 hour drain test.",
    comments: "Store advised that a full duration test involving discharging the batteries has been completed, so the emergency lighting system will not be fully functional until the batteries have had time to recharge (this can take up to 24 hours). We suggest occupants are warned to be extra vigilant, and torches are available, until the system has recharged. Regular Interval Testing: BS 5266-1:2016 recommends functional operation is checked on all luminaires at least every month.",
    declaration: "I certify that the emergency lighting installation identified above has been inspected and tested to BS 5266-1:2016 and the results are as recorded.",
  },
  pat: {
    extent: "In-service inspection and testing of portable electrical appliances.",
    comments: "",
    declaration: "I certify that the portable appliances identified above have been inspected and tested in accordance with the IET Code of Practice for In-service Inspection and Testing of Electrical Equipment, and the results are as recorded.",
  },
  // Who gets the "certificate ready to review" push when an engineer submits one.
  // EMPTY = everyone with FullAccess / SLAAdmin / Compliance (the default fan-out).
  // A non-empty list = ONLY these usernames are notified.
  reviewers: [],
  // Battery supplier — where the "please quote these batteries" enquiry PDF is emailed.
  supplierName: "",
  supplierEmail: "",
  supplierCc: "",        // optional CC on the battery enquiry email (remembered)
};

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY, tenant_id TEXT, type TEXT, status TEXT,
    job_id TEXT, site_code TEXT, cert_number TEXT,
    data TEXT, engineer TEXT,
    created_at TEXT, updated_at TEXT, submitted_at TEXT,
    finalised_at TEXT, finalised_by TEXT, r2_final_key TEXT)`).run();
  // EM remedial log — one row per failed fitting, £50 each. status: done (replaced
  // on site) | pending (remedial job raised, awaiting the works).
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS em_remedials (
    id TEXT PRIMARY KEY, tenant_id TEXT, cert_id TEXT, cert_number TEXT,
    site_code TEXT, site_name TEXT, light_ref TEXT, note TEXT,
    replaced_on_site INTEGER, charge REAL, status TEXT, job_id TEXT,
    engineer TEXT, created_at TEXT)`).run();
  // Battery-fault columns (self-migrating): a failed fitting may need batteries,
  // not a new light — capture spec + qty + photos, no £50 (supplier quotes it).
  for (const col of ["kind TEXT", "battery_spec TEXT", "battery_qty INTEGER", "photos TEXT", "light_spec TEXT", "fitting_no INTEGER"]) {
    try { await env.DB.prepare(`ALTER TABLE em_remedials ADD COLUMN ${col}`).run(); } catch {}
  }
  // Per-cert charge/quote acknowledgement — drives the office's blocking reminder
  // ("Have remedials been charged/quoted?") that re-pops every 4h until confirmed.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS em_remedial_acks (
    cert_id TEXT PRIMARY KEY, tenant_id TEXT, cert_number TEXT,
    site_code TEXT, site_name TEXT, fittings INTEGER, charge REAL,
    onsite INTEGER, pending INTEGER, state TEXT, snooze_until TEXT,
    created_at TEXT, done_at TEXT, done_by TEXT)`).run();
  try { await env.DB.prepare("ALTER TABLE em_remedial_acks ADD COLUMN batteries INTEGER").run(); } catch {}
  // Pipeline: to_quote → quoted → approved (job raised if any not-replaced) → invoiced.
  for (const col of ["stage TEXT", "job_id TEXT", "quoted_at TEXT", "quoted_by TEXT",
    "approved_at TEXT", "approved_by TEXT", "invoiced_at TEXT", "invoiced_by TEXT",
    "lights_pending INTEGER", "lights_job_id TEXT",
    "reissue_cert_id TEXT", "reissue_at TEXT",      // the auto-generated clean cert after the works
    // v2 pipeline (Sep 2026): to_quote → quoted → in_works | done → invoiced
    "status_label TEXT", "po_received_at TEXT", "po_received_by TEXT",
    "awaiting_batteries INTEGER", "batteries_arrived_at TEXT", "works_done_at TEXT"]) {
    try { await env.DB.prepare(`ALTER TABLE em_remedial_acks ADD COLUMN ${col}`).run(); } catch {}
  }
  // Incoming CLIENT ORDERS (e.g. Concerto REM/R-order emails fed in by a bot) that
  // approve outstanding remedial works. Matched to a remedial awaiting approval; the
  // office confirms with one tap to raise the works job.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS client_orders (
    id TEXT PRIMARY KEY, tenant_id TEXT, external_id TEXT, order_number TEXT,
    client TEXT, priority INTEGER, order_value REAL, currency TEXT,
    title TEXT, detail TEXT, description TEXT, job_category TEXT, observation_codes TEXT,
    already_done INTEGER, store_code TEXT, site_name TEXT, sr_ref TEXT, site_raw TEXT,
    notified_at TEXT, link TEXT, source TEXT, status TEXT,
    matched_kind TEXT, matched_cert_id TEXT, matched_job_id TEXT, match_note TEXT,
    created_at TEXT, updated_at TEXT, actioned_at TEXT, actioned_by TEXT)`).run();
  // EICR (5-year) certificate-NUMBER register — a sequential log of cert number →
  // job the office keeps, so the next number is always clear and gaps are visible.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cert_register (
    tenant_id TEXT, number INTEGER, job TEXT, cert_type TEXT DEFAULT 'fiveYear',
    created_at TEXT, updated_at TEXT, updated_by TEXT,
    PRIMARY KEY (tenant_id, number))`).run();
  // `source` marks how a row got here ("" = typed/imported, "scan" = auto-read
  // from a certificate PDF during the compliance-check pass) so the register can
  // badge auto-added rows for the office to verify. Self-migrating.
  try { await env.DB.prepare("ALTER TABLE cert_register ADD COLUMN source TEXT").run(); } catch (e) {}
}
// Pipeline v2: to_quote (blocking pop-up until "Quote sent") → quoted (waiting for
// the client's PO) → PO received → in_works (audit job raised; may be
// awaiting_batteries) | done (all fittings replaced on site → clean cert auto-filed)
// → done (works job completed → clean cert auto-filed) → invoiced.
const STAGES = ["to_quote", "quoted", "approved", "in_works", "done", "invoiced"];
const REMEDIAL_CHARGE = 50;   // £ per failed EM fitting — light replacement OR batteries, replaced on site or not
// Case status from its fittings (worst first): works > batteries > onsite.
function caseStatusLabel(rows) {
  const pend = rows.filter(r => !r.replaced);
  if (pend.some(r => r.kind !== "battery")) return "works";
  if (pend.length) return "batteries";
  return "onsite";
}

// Re-sign each remedial battery photo's URL when serving a cert (keys are stored,
// URLs expire) so the form/office can show the thumbnails.
async function resignRemedialPhotos(env, origin, rec) {
  if (!rec || rec.type !== "em" || !Array.isArray(rec.rows)) return;
  for (const r of rec.rows) {
    const rem = r && r.remedial;
    if (rem && Array.isArray(rem.photos)) {
      for (const p of rem.photos) {
        if (p && p.key) { try { p.url = await signedFileUrl(env, origin, "/certs/photo", p.key); } catch {} }
      }
    }
  }
}

// On finalise of an EM cert, log every failed fitting (£50 each) and — for the
// ones NOT replaced on site — raise ONE remedial SLA job for the office to
// schedule + charge. Idempotent per cert (safe to re-finalise). Returns a summary.
async function processEmRemedials(env, tid, rec, certRow, certNumber, siteCode) {
  if (rec.type !== "em") return null;
  const rows = Array.isArray(rec.rows) ? rec.rows : [];
  const fails = rows.map((r, i) => {
    const rem = r.remedial || {};
    const kind = rem.kind === "battery" ? "battery" : "light";
    return {
      no: r.no != null && r.no !== "" ? Number(r.no) || (i + 1) : (i + 1),
      ref: (String(r.comments || "").trim()) || ("Light " + (i + 1)),
      replaced: rem.replacedOnSite === true,
      lightSpec: kind === "light" ? String(rem.lightSpec || "") : "",
      note: rem.note || "",
      failed: isRealRemedial(rem),
      kind,
      batterySpec: kind === "battery" ? String(rem.batterySpec || "") : "",
      batteryQty: kind === "battery" ? (Number(rem.batteryQty) || 0) : 0,
      // Every failed fitting's photos (light OR battery) — needed for the office
      // record and to build the remedial job when the client orders the works.
      photos: Array.isArray(rem.photos) ? rem.photos.map(p => (p && p.key) || (typeof p === "string" ? p : "")).filter(Boolean) : [],
    };
  }).filter(x => x.failed);
  if (!fails.length) {
    try { await env.DB.prepare("DELETE FROM em_remedials WHERE tenant_id=? AND cert_id=?").bind(tid, certRow.id).run(); } catch {}
    try { await env.DB.prepare("DELETE FROM em_remedial_acks WHERE tenant_id=? AND cert_id=?").bind(tid, certRow.id).run(); } catch {}
    return { count: 0 };
  }

  const siteName = (rec.installation && rec.installation.name) || (rec.client && rec.client.name) || siteCode;
  const now = new Date().toISOString();
  const pending = fails.filter(f => !f.replaced);
  const onsite = fails.filter(f => f.replaced);
  const isBatt = f => f.kind === "battery";
  const lights = fails.filter(f => !isBatt(f));
  const batteries = fails.filter(isBatt);
  const lightsPending = pending.filter(f => !isBatt(f)).length;   // lights NOT replaced on site (need the works job)
  const lightCharge = fails.length * REMEDIAL_CHARGE;   // £50 per failed fitting, lights AND batteries
  const statusLabel = caseStatusLabel(fails);

  // Log every fitting. NOTE: the remedial SLA JOB is NOT raised here — it's raised
  // when the client's ORDER comes in (the "approved" stage), listing what to do.
  try { await env.DB.prepare("DELETE FROM em_remedials WHERE tenant_id=? AND cert_id=?").bind(tid, certRow.id).run(); } catch {}
  const stmts = fails.map((f, i) => env.DB.prepare(
    `INSERT INTO em_remedials (id,tenant_id,cert_id,cert_number,site_code,site_name,light_ref,note,replaced_on_site,charge,status,job_id,engineer,created_at,kind,battery_spec,battery_qty,photos,light_spec,fitting_no)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(certRow.id + ":" + i, tid, certRow.id, certNumber, siteCode || "", siteName, f.ref, f.note,
    f.replaced ? 1 : 0, REMEDIAL_CHARGE, f.replaced ? "done" : "pending", null,
    certRow.engineer || "", now, f.kind, f.batterySpec, f.batteryQty, JSON.stringify(f.photos), f.lightSpec, f.no));
  try { for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20)); } catch {}

  // Open (or re-open) the per-cert case at stage `to_quote` (the one blocking
  // stage). Re-finalising resets it so the office is prompted again if it changed.
  try {
    await env.DB.prepare(
      `INSERT INTO em_remedial_acks (cert_id,tenant_id,cert_number,site_code,site_name,fittings,charge,onsite,pending,batteries,lights_pending,state,stage,snooze_until,created_at,done_at,done_by,job_id,lights_job_id,quoted_at,quoted_by,approved_at,approved_by,invoiced_at,invoiced_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'open','to_quote',NULL,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)
       ON CONFLICT(cert_id) DO UPDATE SET cert_number=excluded.cert_number, site_code=excluded.site_code,
         site_name=excluded.site_name, fittings=excluded.fittings, charge=excluded.charge,
         onsite=excluded.onsite, pending=excluded.pending, batteries=excluded.batteries,
         lights_pending=excluded.lights_pending, state='open',
         stage='to_quote', snooze_until=NULL, done_at=NULL, done_by=NULL, job_id=NULL, lights_job_id=NULL,
         quoted_at=NULL, quoted_by=NULL, approved_at=NULL, approved_by=NULL, invoiced_at=NULL, invoiced_by=NULL`
    ).bind(certRow.id, tid, certNumber, siteCode || "", siteName, fails.length, lightCharge,
      onsite.length, pending.length, batteries.length, lightsPending, now).run();
    await env.DB.prepare("UPDATE em_remedial_acks SET status_label=?, po_received_at=NULL, po_received_by=NULL, awaiting_batteries=0, batteries_arrived_at=NULL, works_done_at=NULL WHERE tenant_id=? AND cert_id=?")
      .bind(statusLabel, tid, certRow.id).run();
  } catch {}

  return { count: fails.length, onsite: onsite.length, pending: pending.length, charge: lightCharge, batteries: batteries.length, lights: lights.length };
}

// Client quote message for the LIGHT remedials on a cert (the agreed £50/light,
// no supplier, no approval). Office copies-and-pastes it to the client. Uses the
// luminaire NUMBERS. Counts every failed light (replaced-on-site or not — they're
// all chargeable at the agreed rate). Returns null when there are no light fails.
// Client quote text — every failed fitting (light OR batteries, replaced on site or
// not: all chargeable at the agreed £50), one full line each, plus a total.
//   Failed EM fittings at store 0622:
//   Fitting 3 - Light replacement - £50
//   Fitting 11 - Batteries - £50
//   Total: 2 fittings - £100
function buildQuoteText(rec, code) {
  const rows = Array.isArray(rec.rows) ? rec.rows : [];
  const lines = [], numbers = [];
  rows.forEach((r, i) => {
    const rem = r.remedial;
    if (!rem || !isRealRemedial(rem)) return;
    const no = (r.no != null && r.no !== "") ? r.no : (i + 1);
    const fault = rem.kind === "battery" ? "Batteries" : "Light replacement";
    const where = rem.replacedOnSite === true ? " (replaced on site)" : "";
    numbers.push(no);
    lines.push(`Fitting ${no} - ${fault}${where} - £${REMEDIAL_CHARGE}`);
  });
  if (!lines.length) return null;
  const total = lines.length * REMEDIAL_CHARGE;
  const text = `Failed EM fittings at store ${padCode(code) || code || ""}:\n` + lines.join("\n")
    + `\nTotal: ${lines.length} fitting${lines.length === 1 ? "" : "s"} - £${total}`;
  return { text, count: lines.length, total, numbers };
}
const buildLightQuoteText = (rec, siteName, code) => buildQuoteText(rec, code);   // legacy name

// Raise the remedial SLA job for a cert. `kind` limits it: "light" (the agreed
// £50 works — raised on demand, no order needed), "battery" (raised when the
// client's order lands), or null for both (legacy). Distinct job ids per kind so
// the lights job and the batteries job are separate.
async function createRemedialJobForCert(env, tid, certId, kind) {
  const { results } = await env.DB.prepare("SELECT * FROM em_remedials WHERE tenant_id=? AND cert_id=? AND status='pending'").bind(tid, certId).all();
  let pend = results || [];
  if (kind === "light") pend = pend.filter(r => r.kind !== "battery");
  else if (kind === "battery") pend = pend.filter(r => r.kind === "battery");
  if (!pend.length) return null;
  const first = pend[0];
  const siteName = first.site_name || first.site_code, siteCode = first.site_code || "";
  const lights = pend.filter(r => r.kind !== "battery"), batts = pend.filter(r => r.kind === "battery");
  const parts = [];
  if (lights.length) parts.push(`Replace ${lights.length} failed light fitting${lights.length === 1 ? "" : "s"} (£${lights.length * REMEDIAL_CHARGE}):\n` + lights.map(r => "• " + r.light_ref + (r.note ? " — " + r.note : "")).join("\n"));
  if (batts.length) parts.push(`Replace batteries in ${batts.length} fitting${batts.length === 1 ? "" : "s"}:\n` + batts.map(r => "• " + r.light_ref + (r.battery_spec ? " — " + r.battery_spec : "") + (r.battery_qty ? " ×" + r.battery_qty : "") + (r.note ? " — " + r.note : "")).join("\n"));
  const lead = kind === "light" ? "agreed £50/light works" : "client ordered";
  const desc = `EM remedial at ${siteName} (from EM certificate ${first.cert_number}) — ${lead}.\n\n` + parts.join("\n\n");
  const jobId = "emrem:" + certId + (kind === "light" ? ":L" : kind === "battery" ? ":B" : "");
  try {
    const job = await createOrUpdateJobFromPayload(env, tid, {
      id: jobId, reference: "EM remedial — " + (siteCode || siteName),
      status: "Pending", priority: "Priority 4", description: desc, siteName, siteCode, originator: "em-remedial",
    });
    // Link the raised fittings so the tracker/Open-job works.
    if (job && job.id) {
      try {
        const ids = pend.map(r => r.id);
        for (let i = 0; i < ids.length; i += 20) {
          await env.DB.batch(ids.slice(i, i + 20).map(rid => env.DB.prepare("UPDATE em_remedials SET job_id=? WHERE tenant_id=? AND id=?").bind(job.id, tid, rid)));
        }
      } catch {}
      // Carry each failed fitting's PHOTOS onto the remedial job, so whoever opens
      // it can see exactly which fittings to replace. Copied into the job's own R2
      // folder (they then show like any job photo). Idempotent — skipped if the job
      // already has them (re-running the pipeline never duplicates).
      if (env.JOB_FILES) {
        try {
          const already = await env.JOB_FILES.list({ prefix: "jobs/" + job.id + "/emrem-" }).catch(() => null);
          if (!already || !already.objects || !already.objects.length) {
            let n = 0;
            for (const r of pend) {
              let keys = []; try { keys = JSON.parse(r.photos || "[]"); } catch {}
              for (const key of (Array.isArray(keys) ? keys : [])) {
                if (!key || typeof key !== "string" || n >= 40) continue;
                const obj = await env.JOB_FILES.get(key);
                if (!obj) continue;
                await env.JOB_FILES.put("jobs/" + job.id + "/emrem-" + n + "-" + Date.now() + ".jpg", obj.body,
                  { httpMetadata: { contentType: (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg" } });
                n++;
              }
              if (n >= 40) break;
            }
          }
        } catch {}
      }
    }
    return job && job.id;
  } catch { return null; }
}

// File a certificate's PDF to the right compliance chart (coop em/pat; FBC sites →
// fareham emMonthly/emYearly). Shared by the auto-filed clean re-issue.
async function fileCertNow(env, tid, cert, rec, number, { bump = false, docDate = "", by = "auto" } = {}) {
  const code = padCode(cert.site_code || rec.siteCode);
  if (!code) throw new Error("no store code");
  let emKind = (cert.type === "em") ? (rec.emKind || "") : "";
  if (cert.type === "em" && !emKind) { try { const jb = cert.job_id ? await getJob(env, tid, cert.job_id) : null; emKind = (jb && jb.emKind) || ""; } catch {} }
  rec.certNumber = number; rec.status = "final";
  const sig = dataUrlToBytes(rec.signature);
  let logo = null; try { logo = logoBytes(); } catch {}
  const bytes = buildCertPdf(rec, { logo, signature: sig });
  let fileScheme = "coop", fileType = cert.type;
  try {
    const srow = await env.DB.prepare("SELECT client FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, String(rec.siteCode || code)).first();
    if (String((srow && srow.client) || "").toLowerCase() === "fbc") { fileScheme = "fareham"; if (cert.type === "em") fileType = emKind === "monthly" ? "emMonthly" : "emYearly"; }
  } catch {}
  const dd = /^\d{4}-\d{2}-\d{2}/.test(String(docDate || "")) ? String(docDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const filed = await fileCertificatePdf(env, tid, {
    scheme: fileScheme, code, type: fileType, bytes,
    filename: `${code}_${cert.type.toUpperCase()}_${number}.pdf`, docDate: dd,
    bump, source: "cert:" + cert.id, label: `${cert.type === "pat" ? "PAT" : "EM"} certificate ${number}`,
  });
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE certificates SET status='final', cert_number=?, r2_final_key=?, finalised_at=?, finalised_by=?, updated_at=? WHERE tenant_id=? AND id=?")
    .bind(number, filed.key, now, by, now, tid, cert.id).run();
  return filed;
}

// ── The remedial WORKS job (v2): ONE site-audit-style job for every fitting the
// engineer did NOT replace on site — one checklist item per fitting ("Fitting 3 —
// Replace light …" / "Fitting 11 — Replace batteries …") carrying the engineer's
// photos as reference photos, unassigned for the office to schedule. When the
// case needs batteries the job is flagged AWAITING BATTERIES until the office
// presses "Batteries arrived". Stable id emrem:<certId> → idempotent.
async function createRemedialWorksJob(env, tid, certId, { awaitingBatteries = false } = {}) {
  const { results } = await env.DB.prepare("SELECT * FROM em_remedials WHERE tenant_id=? AND cert_id=? AND status='pending' ORDER BY fitting_no, id").bind(tid, certId).all();
  const pend = results || [];
  if (!pend.length) return null;
  const jobId = "emrem:" + certId;
  const existing = await getJob(env, tid, jobId).catch(() => null);
  if (existing) return existing.id;
  const first = pend[0];
  const siteName = first.site_name || first.site_code, siteCode = first.site_code || "";
  const auditItems = [];
  let n = 0;
  for (const r of pend) {
    const itemId = crypto.randomUUID();
    const refPhotos = [];
    let keys = []; try { keys = JSON.parse(r.photos || "[]"); } catch {}
    for (const key of (Array.isArray(keys) ? keys : [])) {
      if (!key || typeof key !== "string" || n >= 40 || !env.JOB_FILES) continue;
      try {
        const obj = await env.JOB_FILES.get(key); if (!obj) continue;
        const fn = String(key).split("/").pop();
        const dstKey = `jobs/${jobId}/audit/${itemId}/${fn}`;
        await env.JOB_FILES.put(dstKey, obj.body, { httpMetadata: obj.httpMetadata });
        refPhotos.push(dstKey); n++;
      } catch {}
    }
    const isB = r.kind === "battery";
    const what = isB
      ? "Replace batteries" + (r.battery_spec ? " — " + r.battery_spec : "") + (r.battery_qty ? " ×" + r.battery_qty : "")
      : "Replace light fitting" + (r.light_spec ? " — " + r.light_spec : "");
    const no = r.fitting_no != null ? r.fitting_no : "";
    auditItems.push({ id: itemId, text: `Fitting ${no}${r.light_ref && !/^light \d+$/i.test(r.light_ref) ? " (" + r.light_ref + ")" : ""} — ${what}${r.note ? " · " + r.note : ""}`, refPhotos });
  }
  const lights = pend.filter(r => r.kind !== "battery").length, batts = pend.length - lights;
  const summary = [lights ? `${lights} light fitting${lights === 1 ? "" : "s"} to replace` : "", batts ? `batteries in ${batts} fitting${batts === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ");
  const desc = (awaitingBatteries ? "⏳ AWAITING BATTERIES — do not book until the batteries have arrived (the office will clear this).\n\n" : "")
    + `EM remedial works at ${siteName} (from EM certificate ${first.cert_number}) — ${summary}. Each fitting is a checklist item below; photograph each one once replaced.`;
  try {
    const job = await createOrUpdateJobFromPayload(env, tid, {
      id: jobId, reference: "EM remedial — " + (siteCode || siteName),
      status: "Pending", priority: "Priority 4", description: desc, siteName, siteCode, originator: "em-remedial",
      auditItems, requiresRA: true, requiresSignature: false, requiresPhoto: false, requiresNote: false,
      assignedEngineers: [],
    });
    if (job && job.id) {
      const ids = pend.map(r => r.id);
      try { for (let i = 0; i < ids.length; i += 20) await env.DB.batch(ids.slice(i, i + 20).map(rid => env.DB.prepare("UPDATE em_remedials SET job_id=? WHERE tenant_id=? AND id=?").bind(job.id, tid, rid))); } catch {}
    }
    return job && job.id;
  } catch { return null; }
}

// "PO Received" (v2): the client has ordered the works.
//  • nothing left to attend (every fitting replaced on site) → the clean certificate
//    is generated AND filed to the compliance chart straight away → stage `done`;
//  • otherwise → raise the works job (flagged awaiting batteries if any battery
//    fitting is pending) → stage `in_works`; the clean cert files itself when the
//    engineer completes that job.
async function poReceived(env, tid, certId, me, ctx) {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare("SELECT kind, status FROM em_remedials WHERE tenant_id=? AND cert_id=?").bind(tid, certId).all();
  const rows = results || [];
  const pend = rows.filter(r => r.status === "pending");
  await env.DB.prepare("UPDATE em_remedial_acks SET po_received_at=?, po_received_by=?, approved_at=COALESCE(approved_at,?), approved_by=COALESCE(approved_by,?), snooze_until=NULL WHERE tenant_id=? AND cert_id=?")
    .bind(now, me, now, me, tid, certId).run();
  if (!pend.length) {
    const newId = await reissueCleanCert(env, tid, certId, ctx);
    await env.DB.prepare("UPDATE em_remedial_acks SET stage='done', works_done_at=? WHERE tenant_id=? AND cert_id=?").bind(now, tid, certId).run();
    return { stage: "done", reissueCertId: newId };
  }
  const awaiting = pend.some(r => r.kind === "battery");
  const jobId = await createRemedialWorksJob(env, tid, certId, { awaitingBatteries: awaiting });
  await env.DB.prepare("UPDATE em_remedial_acks SET stage='in_works', job_id=COALESCE(?,job_id), awaiting_batteries=? WHERE tenant_id=? AND cert_id=?")
    .bind(jobId, awaiting ? 1 : 0, tid, certId).run();
  return { stage: "in_works", jobId, awaitingBatteries: awaiting };
}

// ── Auto-reissue a CLEAN certificate after the remedial works are done ──────────
// The final step of the EM remedial process: once the replacement lights/batteries
// have been fitted, produce the SAME certificate as before but with every
// previously-failed fitting now showing Pass and its comment suffixed "(Replaced)"
// (so it's traceable, not as-if-it-never-happened-but-hidden). Generated as a cert
// in the office REVIEW queue (a one-tap Finalise files the clean copy to the
// compliance chart) — the human checkpoint before it replaces the failed cert.
// Idempotent: stable reissue id + an ack marker, so it's produced exactly once.
async function reissueCleanCert(env, tid, certId, ctx) {
  const orig = await env.DB.prepare("SELECT * FROM certificates WHERE tenant_id=? AND id=?").bind(tid, certId).first();
  if (!orig || orig.type !== "em") return null;
  const newId = "CERT-reissue-" + certId;   // stable → idempotent even without the marker
  const dupe = await env.DB.prepare("SELECT id FROM certificates WHERE tenant_id=? AND id=?").bind(tid, newId).first().catch(() => null);
  if (dupe) return newId;
  let data = {}; try { data = JSON.parse(orig.data) || {}; } catch {}
  const rows = Array.isArray(data.rows) ? data.rows : [];
  let changed = 0;
  const cleanRows = rows.map(r => {
    const rem = r && r.remedial;
    if (rem && isRealRemedial(rem)) {
      changed++;
      const nr = { ...r };
      delete nr.remedial;                       // no longer a fault — it's been replaced
      nr.normal = "Pass"; nr.led = "Pass"; nr.emergency = "Pass";
      const c = String(nr.comments || "").trim();
      if (!/\(replaced\)/i.test(c)) nr.comments = (c ? c + " " : "") + "(Replaced)";
      return nr;
    }
    return r;
  });
  if (!changed) return null;                    // nothing failed → nothing to reissue
  const now = new Date().toISOString();
  const newData = { ...data, rows: cleanRows, reissueOf: certId, replacedAt: now };
  await env.DB.prepare(
    "INSERT INTO certificates (id, tenant_id, type, status, job_id, site_code, cert_number, data, engineer, created_at, updated_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(newId, tid, "em", "review", orig.job_id, orig.site_code, orig.cert_number || "", JSON.stringify(newData), orig.engineer, now, now, now).run();
  // v2: FILE IT AUTOMATICALLY — same number, replaces the failed copy on the
  // compliance chart (no due-date bump). Falls back to the review queue only if
  // filing fails (no store code etc.), so nothing is ever lost.
  let filed = false;
  try {
    const nrow = await env.DB.prepare("SELECT * FROM certificates WHERE tenant_id=? AND id=?").bind(tid, newId).first();
    const rec = shapeRow(nrow);
    await fileCertNow(env, tid, nrow, rec, orig.cert_number || rec.certNumber || "", { bump: false, docDate: now.slice(0, 10), by: "auto (remedial works)" });
    filed = true;
  } catch {}
  try { await env.DB.prepare("UPDATE em_remedial_acks SET reissue_cert_id=?, reissue_at=?, works_done_at=COALESCE(works_done_at,?), stage=CASE WHEN COALESCE(stage,'')='invoiced' THEN stage ELSE 'done' END WHERE tenant_id=? AND cert_id=?").bind(newId, now, now, tid, certId).run(); } catch {}
  try {
    const site = (newData.installation && newData.installation.name) || orig.site_code || "";
    const p = sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], {
      title: filed ? "Updated EM certificate filed" : "Updated EM certificate ready",
      body: filed
        ? `${site}: the EM certificate has been re-issued with ${changed} fitting${changed === 1 ? "" : "s"} marked "Replaced" and filed to the compliance chart. Tap to download.`
        : `${site}: a clean EM certificate was generated (${changed} fitting${changed === 1 ? "" : "s"} now Pass) but couldn't be filed automatically — review and issue it.`,
      url: "/cert-review.html?open=" + newId, tag: "cert-reissue:" + newId,
    }, null, { officeOnly: true });
    ctx?.waitUntil ? ctx.waitUntil(p.catch(() => {})) : await p.catch(() => {});
  } catch {}
  return newId;
}

// Called from sla.js when a remedial SLA job (id "emrem:<certId>:L|:B") is completed:
// reissue the clean cert ONCE every remedial job raised for that cert is finished
// (so a split lights+batteries order waits for both).
export async function reissueCleanCertForRemedialJob(env, tid, job) {
  try {
    await ensureTables(env);
    const jid = String((job && job.id) || "");
    if (!jid.startsWith("emrem:")) return null;
    const certId = jid.slice(6).replace(/:(L|B)$/i, "");
    if (!certId) return null;
    const { results: sib } = await env.DB.prepare("SELECT id, status FROM sla_jobs WHERE tenant_id=? AND id LIKE ?")
      .bind(tid, "emrem:" + certId + "%").all().catch(() => ({ results: [] }));
    const fin = s => /complete|closed|invoiced/i.test(String(s || ""));
    if ((sib || []).some(j => !fin(j.status))) return null;   // works still outstanding
    return await reissueCleanCert(env, tid, certId);
  } catch { return null; }
}

// ── Client-order intake (Concerto REM/R-orders) → match to a remedial ──────────
// A client order APPROVES outstanding remedial works. We match it (by store code)
// to a remedial that's awaiting approval — an EM remedial case (em_remedial_acks,
// stage to_quote/quoted) or an electrical-test job carrying remedials not yet
// turned into a works job — and store it for the office to confirm with one tap.
const numOf = v => { const d = String(v ?? "").replace(/\D/g, ""); return d ? String(Number(d)) : ""; };
async function matchOrderToRemedial(env, tid, o) {
  const code = padCode(o.storeCode), num = numOf(o.storeCode);
  if (!code && !num) return null;
  // 1) EM remedial case awaiting approval at this store.
  try {
    const { results } = await env.DB.prepare(
      "SELECT cert_id, site_code, site_name, cert_number, stage FROM em_remedial_acks WHERE tenant_id=? AND COALESCE(stage,'to_quote') IN ('to_quote','quoted') ORDER BY created_at DESC LIMIT 200"
    ).bind(tid).all();
    const cands = (results || []).filter(r => numOf(r.site_code) && numOf(r.site_code) === num);
    if (cands.length) {
      const r = cands[0];
      return { kind: "em", certId: r.cert_id, note: `EM cert ${r.cert_number || ""} at ${r.site_name || code} (stage ${r.stage || "to_quote"})` + (cands.length > 1 ? ` +${cands.length - 1} more at this site` : "") };
    }
  } catch {}
  // 2) Electrical-test job with remedials not yet raised as a works job.
  try {
    const jobs = (await listJobs(env, tid)).filter(j => j && j.elecTest && Array.isArray(j.remedials) && j.remedials.length && !j.remedialsWorksJobId);
    const cand = jobs.find(j => numOf(j.siteCode) && numOf(j.siteCode) === num);
    if (cand) return { kind: "elec", jobId: cand.id, note: `Electrical-test remedials on job ${cand.helpdeskRef || cand.reference || cand.id} at ${cand.siteName || code}` };
  } catch {}
  return null;
}
function shapeOrder(r) {
  let codes = []; try { codes = JSON.parse(r.observation_codes || "[]"); } catch {}
  return {
    id: r.id, externalId: r.external_id || "", orderNumber: r.order_number || "", client: r.client || "",
    priority: r.priority, orderValue: r.order_value, currency: r.currency || "GBP",
    title: r.title || "", detail: r.detail || "", jobCategory: r.job_category || "", observationCodes: codes,
    alreadyDone: r.already_done === 1, storeCode: r.store_code || "", siteName: r.site_name || "", srRef: r.sr_ref || "",
    notifiedAt: r.notified_at || "", link: r.link || "", source: r.source || "", status: r.status || "new",
    matchedKind: r.matched_kind || "", matchedCertId: r.matched_cert_id || "", matchedJobId: r.matched_job_id || "",
    matchNote: r.match_note || "", createdAt: r.created_at || "",
  };
}
async function handleOrderInbound(env, tid, b, ctx, request) {
  const now = new Date().toISOString();
  const extId = String(b.externalId || b.messageId || "").slice(0, 200);
  const orderNumber = String(b.orderNumber || "").slice(0, 60);
  const storeCode = padCode(b.storeCode || (b.siteRaw ? (String(b.siteRaw).match(/\d{2,5}/) || [])[0] : ""));
  const siteName = String(b.siteName || "").slice(0, 160);
  const srRef = String(b.srRef || "").slice(0, 40);
  const detail = String(b.detail || b.description || "").replace(/https?:\/\/\S+/g, "").replace(/\n{2,}/g, "\n").trim().slice(0, 1000);
  const title = String(b.title || `Order ${orderNumber} — ${siteName || storeCode}`).slice(0, 200);
  // Dedupe by external id, then order number.
  let id = null, created = true;
  if (extId) { const ex = await env.DB.prepare("SELECT id FROM client_orders WHERE tenant_id=? AND external_id=? LIMIT 1").bind(tid, extId).first().catch(() => null); if (ex) { id = ex.id; created = false; } }
  if (!id && orderNumber) { const ex = await env.DB.prepare("SELECT id FROM client_orders WHERE tenant_id=? AND order_number=? LIMIT 1").bind(tid, orderNumber).first().catch(() => null); if (ex) { id = ex.id; created = false; } }
  if (!id) id = "ord-" + crypto.randomUUID();
  const m = await matchOrderToRemedial(env, tid, { storeCode, siteName, srRef, orderNumber });
  const status = m ? "matched" : "new";
  await env.DB.prepare(`INSERT INTO client_orders
    (id,tenant_id,external_id,order_number,client,priority,order_value,currency,title,detail,description,job_category,observation_codes,already_done,store_code,site_name,sr_ref,site_raw,notified_at,link,source,status,matched_kind,matched_cert_id,matched_job_id,match_note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET order_number=excluded.order_number, client=excluded.client, priority=excluded.priority,
      order_value=excluded.order_value, currency=excluded.currency, title=excluded.title, detail=excluded.detail,
      description=excluded.description, job_category=excluded.job_category, observation_codes=excluded.observation_codes,
      already_done=excluded.already_done, store_code=excluded.store_code, site_name=excluded.site_name, sr_ref=excluded.sr_ref,
      site_raw=excluded.site_raw, notified_at=excluded.notified_at, link=excluded.link,
      status=CASE WHEN client_orders.status IN ('actioned','dismissed') THEN client_orders.status ELSE excluded.status END,
      matched_kind=excluded.matched_kind, matched_cert_id=excluded.matched_cert_id, matched_job_id=excluded.matched_job_id,
      match_note=excluded.match_note, updated_at=excluded.updated_at`)
    .bind(id, tid, extId || null, orderNumber || null, String(b.client || "").slice(0, 80), Number(b.priority) || null,
      (b.orderValue != null ? Number(b.orderValue) : null), String(b.currency || "GBP").slice(0, 8), title, detail,
      String(b.description || "").slice(0, 4000), String(b.jobCategory || "").slice(0, 20),
      JSON.stringify(Array.isArray(b.observationCodes) ? b.observationCodes.slice(0, 40) : []), b.alreadyDoneOnSite ? 1 : 0,
      storeCode || null, siteName || null, srRef || null, String(b.siteRaw || "").slice(0, 200),
      String(b.notifiedAt || now).slice(0, 40), String(b.link || "").slice(0, 800) || null, String(b.source || "concerto").slice(0, 40),
      status, m ? m.kind : null, m ? (m.certId || null) : null, m ? (m.jobId || null) : null, m ? m.note : null, now, now).run();
  if (ctx && ctx.waitUntil) {
    const site = siteName || storeCode || "a site";
    const body = m
      ? `Client order ${orderNumber || ""} for ${site} — matches a remedial awaiting approval. Review & raise the works job.`
      : `Client order ${orderNumber || ""} for ${site} — no matching remedial found yet. Review it in the remedials tracker.`;
    ctx.waitUntil(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"],
      { title: m ? "Client order — approve remedial" : "Client order received", body, url: "/cert-review.html?orders=1", tag: "client-order:" + id, actionable: true }, "", { officeOnly: true }).catch(() => {}));
  }
  return json({ ok: true, id, created, matched: !!m, matchedKind: m ? m.kind : null, status }, {}, env, request);
}

async function getConfig(env, tid) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "cert:config:" + tid).first();
  let c = null; try { c = row ? JSON.parse(row.value) : null; } catch {}
  if (!c || typeof c !== "object") return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return {
    client: { ...DEFAULT_CONFIG.client, ...(c.client || {}) },
    contractor: { ...DEFAULT_CONFIG.contractor, ...(c.contractor || {}) },
    em: { ...DEFAULT_CONFIG.em, ...(c.em || {}) },
    pat: { ...DEFAULT_CONFIG.pat, ...(c.pat || {}) },
    reviewers: Array.isArray(c.reviewers) ? c.reviewers.map(String).filter(Boolean).slice(0, 200) : [],
    supplierName: typeof c.supplierName === "string" ? c.supplierName : "",
    supplierEmail: typeof c.supplierEmail === "string" ? c.supplierEmail : "",
    supplierCc: typeof c.supplierCc === "string" ? c.supplierCc : "",
  };
}
async function saveConfig(env, tid, c) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, "cert:config:" + tid, JSON.stringify(c)).run();
}

const yy = () => String(new Date().getFullYear()).slice(-2);
function dataUrlToBytes(u) {
  const s = String(u || "");
  const i = s.indexOf(",");
  if (!/^data:image\//i.test(s) || i < 0) return null;
  try {
    const bin = atob(s.slice(i + 1));
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  } catch { return null; }
}

async function getJob(env, tid, id) {
  try {
    const row = await env.DB.prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, id).first();
    return row ? JSON.parse(row.data) : null;
  } catch { return null; }
}
// A store code from the job's site (numeric, 4-padded like the compliance chart).
function padCode(v) { const d = String(v ?? "").replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; }

// Normalise an engineer name to the engStatus key (matches sla.js normId).
const normEng = s => (s || "").toLowerCase().replace(/\s+/g, ".").trim();

// Complete an EM/PAT JOB once ALL the certificates it needs are in (submitted or
// finalised). The engineer's app normally flips the job to Complete when they
// submit the last cert — but if that's interrupted (the office finalises the
// certs, or the two certs are submitted across separate page loads), the job was
// left stuck In Progress with no way to complete it, which then blocked the
// engineer's clock-off. So the SERVER now completes the job whenever its certs are
// all in — the source of truth is the certificates, not the engineer's device.
// Writes the top-level status AND every assigned engineer's per-engineer slice so
// single-engineer and multi-engineer (shared cert) jobs both read Complete.
async function maybeCompleteCertJob(env, tid, cert) {
  try {
    if (!cert || !cert.job_id) return false;
    const row = await env.DB.prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, cert.job_id).first();
    if (!row) return false;
    let job; try { job = JSON.parse(row.data); } catch { return false; }
    const need = [];
    if (job.emTest) need.push("em");
    if (job.pat) need.push("pat");
    if (!need.length) return false;                                    // not an EM/PAT job
    if (/complete|closed|invoiced|cancel/i.test(String(job.status || ""))) return false;   // already finished
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT type FROM certificates WHERE tenant_id=? AND job_id=? AND status IN ('review','final')"
    ).bind(tid, cert.job_id).all();
    const have = new Set((results || []).map(r => r.type));
    if (!need.every(t => have.has(t))) return false;                   // still waiting on a cert
    const now = new Date().toISOString();
    job.status = "Complete"; job.updatedAt = now; job.closedAt = job.closedAt || now;
    const engs = (Array.isArray(job.assignedEngineers) && job.assignedEngineers.length)
      ? job.assignedEngineers.filter(Boolean) : (job.assignedTo ? [job.assignedTo] : []);
    if (engs.length >= 2) {   // shared cert → everyone on the job is done
      job.engStatus = job.engStatus || {};
      for (const e of engs) job.engStatus[normEng(e)] = { status: "Complete", at: now, by: "cert" };
    } else if (job.engStatus) {   // single-eng with a stale slice — keep it consistent
      for (const k of Object.keys(job.engStatus)) job.engStatus[k] = { status: "Complete", at: now, by: "cert" };
    }
    job.statusHistory = Array.isArray(job.statusHistory) ? job.statusHistory : [];
    job.statusHistory.push({ status: "Complete", at: now, by: "cert" });
    await env.DB.prepare("UPDATE sla_jobs SET status='Complete', closed_at=?, updated_at=?, data=? WHERE tenant_id=? AND id=?")
      .bind(job.closedAt, now, JSON.stringify(job), tid, cert.job_id).run();
    return true;
  } catch { return false; }
}

// A remedial counts as REAL (a flagged fault) whenever it carries substantive
// detail — not only when the `failed` flag is set. The engineer app's "Mark
// fitting failed" button is a toggle whose active label reads like a confirm, so
// a fitting could end up with battery spec/qty/notes/photos but failed:false and
// then be invisible to the office. Anything with detail is a fault.
function isRealRemedial(rem) {
  if (!rem || typeof rem !== "object") return false;
  if (rem.failed) return true;
  if (rem.replacedOnSite != null) return true;
  if (String(rem.batterySpec || "").trim()) return true;
  if (Number(rem.batteryQty) > 0) return true;
  if (Array.isArray(rem.photos) && rem.photos.length) return true;
  if (String(rem.note || "").trim()) return true;
  return false;
}
// Force failed=true on every substantive remedial so all downstream (office
// render, £ processing, supplier enquiry, tracker) sees it. Mutates in place.
function normalizeRemedials(rec) {
  if (rec && Array.isArray(rec.rows)) {
    for (const r of rec.rows) { if (r && r.remedial && isRealRemedial(r.remedial)) r.remedial.failed = true; }
  }
  return rec;
}

// ── Prefill the luminaire/appliance list from the site's most recent cert ─────
// Both parsers are TOKEN-BASED and LANDMARK-ANCHORED so they cope with format
// variation across Tysoft (and similar) templates — different appliance-ID styles
// (AP00001 / 00001 / 1), single- OR multi-word descriptions/locations, an
// optional serial-number column, Pass/Fail/Skip or P/F/S status, and dates with
// / . or - separators. Each cell is its own PDF text token, which is what makes
// the anchoring reliable. The valuable carry-forward is the ITEM LIST (each
// item's position/description + location) — results default to Pass on carry, so
// only the identity + location need reading. Nothing is invented: an unreadable
// (e.g. scanned) cert yields [] and the office/engineer is told none was found.
const cap = s => { s = String(s || "").trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase().replace("n/a", "N/A") : s; };
const CERT_PF = s => /^(pass|fail|n\/?a|na|p|f)$/i.test(String(s).trim());
const CERT_DATE = s => /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(String(s).trim());
const CERT_STATUS = s => /^(pass|fail|skip|p|f|s)$/i.test(String(s).trim());
const CERT_STOP = /^(www\.|tysoft|report printed|key:|page:|ref:|emergency lighting|appliance details|site:|no\.$|lamp$|battery|comments$|status$|total appliances|installation|certificate|the southern)/i;

// EM: rows are  No · Normal · LED · Emergency · Battery · Comments(location).
// Anchor = a small row-number token immediately followed by a Pass/Fail token.
function parseEmRowsTokens(toks) {
  if (!toks || !toks.length) return [];
  const rows = [];
  for (let i = 0; i < toks.length - 2; i++) {
    if (!/^\d{1,3}$/.test(String(toks[i]).trim())) continue;
    if (!CERT_PF(toks[i + 1])) continue;                    // row-number → a result
    let j = i + 1; const states = [];
    while (j < toks.length && CERT_PF(toks[j]) && states.length < 6) { states.push(cap(toks[j])); j++; }
    let battery = ""; if (j < toks.length && /^\d{1,4}$/.test(String(toks[j]).trim())) { battery = String(toks[j]).trim(); j++; }
    const parts = [];                                       // comment/location = words up to the next row / a footer
    while (j < toks.length && parts.length < 8) {
      const tk = String(toks[j]).trim();
      if (/^\d{1,3}$/.test(tk) && CERT_PF(toks[j + 1])) break;
      if (CERT_STOP.test(tk)) break;
      parts.push(tk); j++;
    }
    rows.push({
      no: rows.length + 1, normal: states[0] || "", led: states[1] || "",
      emergency: states[2] || states[states.length - 1] || "",
      battery: battery || 180, comments: parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 80),
    });
    i = j - 1;
    if (rows.length > 600) break;
  }
  return rows;
}
// PAT: rows are  Appliance ID · Test Date · Description · Location · [Serial] ·
// [Retest Period] · Retest Date · Status.  Anchor = an ID-ish token followed by a
// date, whose 3rd token is NOT a status (that guard rejects the period→retest
// date→status tail so it can't be mistaken for a row start). End = a Status
// preceded by a date (the retest date); the words between the test date and the
// retest date are Description (first) and Location (second).
function parsePatRowsTokens(toks) {
  if (!toks || !toks.length) return [];
  const rows = [];
  for (let i = 0; i < toks.length - 3; i++) {
    const id = String(toks[i]).trim();
    if (id.length < 1 || id.length > 18 || /\s/.test(id)) continue;   // an ID cell, not free text
    if (CERT_DATE(id) || CERT_STATUS(id)) continue;
    if (!CERT_DATE(toks[i + 1])) continue;                            // test date
    if (CERT_STATUS(toks[i + 2])) continue;                           // reject the period/retest-date/status tail
    let end = -1;
    for (let k = i + 3; k <= i + 12 && k < toks.length; k++) {
      if (CERT_STATUS(toks[k]) && CERT_DATE(toks[k - 1])) { end = k; break; }
    }
    if (end < 0) continue;
    const middle = toks.slice(i + 2, end - 1);   // Description, Location, [Serial], [Period]
    if (!middle.length) continue;
    rows.push({
      no: rows.length + 1,
      appliance: String(middle[0] || "").trim().slice(0, 60),
      location: String(middle[1] || "").trim().slice(0, 60),
      cls: "", visual: "", earth: "", insulation: "", result: "", comments: "",
    });
    i = end;
    if (rows.length > 600) break;
  }
  return rows;
}

// PAT class rule (Mostlane standard): everything is Class II (double-insulated)
// EXCEPT earthed metal-cased items — kettles, microwaves, fridges/freezers,
// desktop PCs, printers, photocopiers, extension leads, and anything metal-cased.
// Old certificates often mis-recorded this, so we RE-DERIVE the class from the
// appliance description on every import/carry rather than trusting the old value.
const PAT_CLASS_I = /kettle|microwav|fridge|freezer|refriger|dishwash|washing\s*machine|tumble|dryer|toaster|\burn\b|water\s*heater|boiler|oven|cooker|\bhob\b|desktop|\bpc\b|pc\s*tower|tower\s*pc|printer|photocopier|copier|\bmfp\b|extension\s*(lead|reel)|\d+\s*[- ]?gang|multi[- ]?(gang|socket)|gang\s*(lead|extension)|metal/i;
function patClassFor(desc) { return PAT_CLASS_I.test(String(desc || "")) ? "I" : "II"; }
// Standard default test results by class (the engineer confirms / edits on site).
function patDefaults(cls) {
  return cls === "I"
    ? { earth: "0.08 Ω", insulation: ">200 MΩ", visual: "Pass", result: "Pass" }
    : { earth: "N/A", insulation: ">200 MΩ", visual: "Pass", result: "Pass" };
}

// Carry an item list forward for a NEW visit: keep each item's IDENTITY
// (position/description/appliance/location) and default every result to the
// class standard — the engineer just taps any that differ / failed.
function carryRows(rows, type) {
  return (rows || []).map((r, i) => {
    if (type !== "pat") return { no: i + 1, comments: r.comments || "", normal: "Pass", led: "Pass", emergency: "Pass", battery: r.battery || 180 };
    const cls = patClassFor(r.appliance);        // re-derive (old certs were often wrong)
    const def = patDefaults(cls);
    return { no: i + 1, appliance: r.appliance || "", location: r.location || "", cls, visual: def.visual, earth: def.earth, insulation: def.insulation, result: def.result, comments: r.comments || "" };
  });
}
async function latestCertR2Key(env, tid, code, type) {
  try {
    const row = await env.DB.prepare(
      "SELECT r2_key FROM compliance_files WHERE tenant_id=? AND code=? AND type=? ORDER BY COALESCE(doc_date,uploaded_at) DESC LIMIT 1"
    ).bind(tid, padCode(code), type).first();
    return row ? row.r2_key : null;
  } catch { return null; }
}
// Read EVERYTHING carryable from the previous certificate. NOTHING is ever
// invented: a field either transfers from the previous cert (or, for the site
// address, the real portal site record) or is left blank for the office to fill.
async function prefillFromPrevious(env, tid, code, type) {
  const c4 = padCode(code);
  // 1) Prefer the most recent PORTAL certificate — structured, so the WHOLE
  //    header (client/installation/extent/comments/contractor) + the item list
  //    transfer cleanly, and it chains forward year on year.
  try {
    const prev = await env.DB.prepare(
      "SELECT data FROM certificates WHERE tenant_id=? AND site_code=? AND type=? AND status='final' ORDER BY COALESCE(finalised_at,updated_at) DESC LIMIT 1"
    ).bind(tid, c4, type).first();
    if (prev) {
      let d = {}; try { d = JSON.parse(prev.data) || {}; } catch {}
      if (Array.isArray(d.rows) && d.rows.length) {
        const con = d.contractor || {};
        return {
          rows: carryRows(d.rows, type), from: "last certificate", source: "portal",
          header: {
            client: d.client || null, installation: d.installation || null,
            extent: d.extent || "", comments: d.comments || "",
            contractor: { tradingTitle: con.tradingTitle || "", address: con.address || "", postcode: con.postcode || "", regNumber: con.regNumber || "", telephone: con.telephone || "" },
          },
        };
      }
    }
  } catch {}
  // 2) Fall back to the previous (legacy Tysoft) cert PDF on the compliance chart.
  //    The ITEM ROWS parse reliably (each cell is its own token). The header
  //    fields are NOT reliably delimited in legacy text, so we DO NOT guess them
  //    — they come from the real site record / are left blank (header: null).
  const key = await latestCertR2Key(env, tid, c4, type);
  if (!key || !env.JOB_FILES) return { rows: [], from: null, header: null };
  try {
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return { rows: [], from: null, header: null };
    const buf = await obj.arrayBuffer();
    if (buf.byteLength > 6 * 1024 * 1024) return { rows: [], from: null, header: null };
    const toks = await pdfExtractTokens(buf);            // both parsers are token-based + format-flexible
    const parsed = type === "pat" ? parsePatRowsTokens(toks) : parseEmRowsTokens(toks);
    return { rows: carryRows(parsed, type), from: key.split("/").pop(), source: "pdf", header: null };
  } catch { return { rows: [], from: null, header: null }; }
}

// EM number = the store's EM set number (from sla:emsets) + "-YY". PAT number =
// next in the rolling PAT sequence. Both overridable by the office at finalise.
async function emSetFor(env, tid, code) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "sla:emsets:" + tid).first();
    const m = row ? JSON.parse(row.value) : {};
    const c4 = padCode(code);
    return m[c4] || m[String(Number(c4))] || c4;
  } catch { return padCode(code); }
}
async function nextPatNumber(env, tid) {
  // max of stored counter and the highest number seen on historical PAT certs
  let maxN = 0;
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "cert:patseq:" + tid).first();
    if (row) maxN = Number(row.value) || 0;
  } catch {}
  try {
    const rows = (await env.DB.prepare("SELECT r2_key FROM compliance_files WHERE tenant_id=? AND type='pat'").all()).results || [];
    for (const r of rows) {
      const name = String(r.r2_key || "").split("/").pop() || "";
      const m = name.match(/(\d{3,5})[-.](?:DEC)?\d{2}[A-Za-z]?_?\.pdf$/i);
      if (m) maxN = Math.max(maxN, Number(m[1]) || 0);
    }
  } catch {}
  return maxN + 1;
}
// MM-YY from a date (else now) — for monthly EM numbers so each month is unique.
function monthYY(date) { const d = date ? new Date(date) : new Date(); const x = isNaN(d) ? new Date() : d; return String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getFullYear()).slice(-2); }
// A store's OWN previous PAT/EM certificate number (they carry over year on year,
// like the EM set), from its last portal cert or its legacy cert PDF filename.
async function prevCertNumberForStore(env, tid, code, type) {
  const c4 = padCode(code);
  try {
    const row = await env.DB.prepare(
      "SELECT cert_number FROM certificates WHERE tenant_id=? AND site_code=? AND type=? AND cert_number IS NOT NULL AND cert_number!='' ORDER BY COALESCE(finalised_at,updated_at) DESC LIMIT 1"
    ).bind(tid, c4, type).first();
    if (row && row.cert_number) { const m = String(row.cert_number).match(/(\d{3,5})/); if (m) return m[1]; }
  } catch {}
  try {
    const key = await latestCertR2Key(env, tid, c4, type);
    if (key) { const name = key.split("/").pop() || ""; const m = name.match(/_(\d{3,5})[-.](?:DEC|JAN)?\d{2}[A-Za-z]?_?\.pdf$/i); if (m) return m[1]; }
  } catch {}
  return "";
}
async function suggestNumber(env, tid, code, type, opts = {}) {
  if (type === "pat") {
    // Re-test of a store that already has a PAT number → keep the SAME number
    // (new year); only a store with no prior PAT gets the next rolling number.
    const prev = await prevCertNumberForStore(env, tid, code, "pat");
    if (prev) return String(prev).padStart(4, "0") + "-" + yy();
    const n = await nextPatNumber(env, tid); return String(n).padStart(4, "0") + "-" + yy();
  }
  const set = await emSetFor(env, tid, code);
  // Monthly EM (Fareham flick test): <set/code>-<MM>-<YY> so all 12 in a year differ.
  if (opts.kind === "monthly") return set + "-" + monthYY(opts.date);
  return set + "-" + yy();
}

function shapeRow(cert) {
  let d = {}; try { d = JSON.parse(cert.data) || {}; } catch {}
  const rec = {
    id: cert.id, type: cert.type, status: cert.status, jobId: cert.job_id, siteCode: cert.site_code,
    certNumber: cert.cert_number, engineer: cert.engineer, createdAt: cert.created_at, updatedAt: cert.updated_at,
    submittedAt: cert.submitted_at, finalisedAt: cert.finalised_at, finalisedBy: cert.finalised_by,
    ...d,
  };
  // Heal any remedial that has detail but lost its failed flag, so the office
  // always sees flagged faults (this is what made a submitted cert's remedials
  // invisible on review).
  return normalizeRemedials(rec);
}

export async function handle(request, env, ctx, url, sess) {
  // Public (signed) stream of an EM remedial battery photo — verified in-handler,
  // so it precedes the auth gate (it's registered in index.js PUBLIC_ROUTES).
  if (request.method === "GET" && url.pathname === "/certs/photo") {
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("certremedial/")) return new Response("Bad key", { status: 400 });
    if (!(await verifyFileSig(env, key, url.searchParams))) return new Response("Bad signature", { status: 403 });
    const obj = env.JOB_FILES && await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  }

  // ── Machine-to-machine CLIENT-ORDER intake (PUBLIC_ROUTES; token verified here) ─
  // A bot (e.g. Grok watching Concerto REM/R-order emails) POSTs a client order; we
  // store it, match it to a remedial awaiting approval, and push the office to
  // confirm. GET = a no-secret connection check.
  if (url.pathname === "/certs/remedials/order-inbound") {
    const secret = (env.ORDERS_INBOUND_TOKEN || env.TASKS_INBOUND_TOKEN || env.JOBS_INBOUND_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim();
    const m0 = request.method.toUpperCase();
    if (m0 === "GET") {
      let fp = null;
      if (secret) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)); fp = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 8); }
      return json({ ok: true, configured: !!secret, tokenFingerprint: fp, use: "POST the Concerto order JSON with header Authorization: Bearer <token>" }, {}, env, request);
    }
    if (m0 === "POST") {
      if (!secret) return json({ ok: false, error: "Order intake isn't configured (set ORDERS_INBOUND_TOKEN or TASKS_INBOUND_TOKEN or JOBS_INBOUND_TOKEN)" }, { status: 503 }, env, request);
      const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      let diff = tok.length === secret.length ? 0 : 1;
      for (let i = 0; i < Math.min(tok.length, secret.length); i++) diff |= tok.charCodeAt(i) ^ secret.charCodeAt(i);
      if (diff !== 0) return json({ ok: false, error: "Bad token" }, { status: 401 }, env, request);
      const oTid = await resolveTenantId(env, request);
      await ensureTables(env);
      const ob = await request.json().catch(() => ({}));
      return await handleOrderInbound(env, oTid, ob, ctx, request);
    }
  }

  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/certs(?=\/|$)/, "") || "/";
  const q = url.searchParams;
  await ensureTables(env);

  const perms = await permissionsFor(env, tid, me);
  const isOffice = perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes" || perms.Compliance === "Yes";

  const loadCert = async (id) => env.DB.prepare("SELECT * FROM certificates WHERE tenant_id=? AND id=?").bind(tid, id).first();

  // May `me` write/submit this cert? The office always can; otherwise the creator
  // OR any engineer assigned to the cert's job (so a cert seeded by one person —
  // office preview, the AI, a colleague — can still be completed by whoever
  // actually does the job). Names/usernames matched case-insensitively.
  const canWriteCert = async (cert) => {
    if (isOffice) return true;
    if (!cert) return true;   // brand-new cert (no existing row) — creation allowed
    const m = String(me || "").toLowerCase().trim();
    if (String(cert.engineer || "").toLowerCase().trim() === m) return true;
    try {
      const job = cert.job_id ? await getJob(env, tid, String(cert.job_id)) : null;
      const engs = job ? (Array.isArray(job.assignedEngineers) ? job.assignedEngineers : (job.assignedTo ? [job.assignedTo] : [])) : [];
      return engs.some(e => String(e || "").toLowerCase().trim() === m);
    } catch { return false; }
  };

  // ── Config (office) ─────────────────────────────────────────────────────────
  if (sub === "/config") {
    if (method === "GET") return json({ ok: true, config: await getConfig(env, tid) }, {}, env, request);
    if (method === "POST") {
      if (!isOffice) return error("Office access required", 403, env, request);
      const b = await request.json().catch(() => ({}));
      const cur = await getConfig(env, tid);
      const next = {
        client: { ...cur.client, ...(b.client || {}) },
        contractor: { ...cur.contractor, ...(b.contractor || {}) },
        em: { ...cur.em, ...(b.em || {}) },
        pat: { ...cur.pat, ...(b.pat || {}) },
        reviewers: Array.isArray(b.reviewers) ? b.reviewers.map(String).filter(Boolean).slice(0, 200) : cur.reviewers,
        supplierName: typeof b.supplierName === "string" ? b.supplierName.slice(0, 120) : cur.supplierName,
        supplierEmail: typeof b.supplierEmail === "string" ? b.supplierEmail.slice(0, 160) : cur.supplierEmail,
        supplierCc: typeof b.supplierCc === "string" ? b.supplierCc.slice(0, 200) : cur.supplierCc,
      };
      await saveConfig(env, tid, next);
      return json({ ok: true, config: next }, {}, env, request);
    }
  }

  // ── My saved signature (any user) — a personal default signature so signing a
  // cert is one tap. Stored per-user in app_config cert:sig:<username>. ─────────
  if (sub === "/my-signature") {
    const sigKey = "cert:sig:" + tid + ":" + me.toLowerCase();
    if (method === "GET") {
      const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, sigKey).first();
      return json({ ok: true, signature: (row && row.value) || "" }, {}, env, request);
    }
    if (method === "POST") {
      const b = await request.json().catch(() => ({}));
      const sig = typeof b.signature === "string" ? b.signature : "";
      // Guard: must be a small data-URL image (a signature PNG/JPEG is a few KB).
      if (sig && (!/^data:image\//.test(sig) || sig.length > 200000)) return error("Invalid signature", 400, env, request);
      if (sig) await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, sigKey, sig).run();
      else await env.DB.prepare("DELETE FROM app_config WHERE tenant_id=? AND key=?").bind(tid, sigKey).run();
      return json({ ok: true }, {}, env, request);
    }
  }

  // ── EM/PAT JOBS hub (office): every EM/PAT job in its own area, with the site's
  // client + status so the office can filter open/closed + by client. ──────────
  if (sub === "/jobs" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const jobs = (await listJobs(env, tid)).filter(j => j && (j.emTest || j.pat));
    const codes = [...new Set(jobs.map(j => String(j.siteCode || "")).filter(Boolean))];
    const clientByCode = {};
    if (codes.length) {
      const ph = codes.map(() => "?").join(",");
      const rows = await env.DB.prepare(`SELECT site_number, client, site_name FROM sites WHERE tenant_id=? AND site_number IN (${ph})`).bind(tid, ...codes).all().catch(() => ({ results: [] }));
      (rows.results || []).forEach(r => { clientByCode[String(r.site_number)] = { client: String(r.client || "").toLowerCase(), name: r.site_name }; });
    }
    const done = s => { s = String(s || "").toLowerCase(); return s.includes("complete") || s.includes("closed") || s.includes("invoiced") || s.includes("cancel"); };
    const out = jobs.map(j => {
      const c = clientByCode[String(j.siteCode || "")] || {};
      return {
        id: j.id, ref: j.helpdeskRef || j.reference || "", site: j.siteName || c.name || "", siteCode: j.siteCode || "",
        client: c.client || "", status: j.status || "", closed: done(j.status), scheduledAt: j.scheduledAt || "",
        em: !!j.emTest, pat: !!j.pat, emKind: j.emKind || (j.emTest ? "yearly" : ""), engineers: Array.isArray(j.assignedEngineers) ? j.assignedEngineers : [],
      };
    }).sort((a, b) => (b.scheduledAt || "").localeCompare(a.scheduledAt || ""));
    return json({ ok: true, jobs: out }, {}, env, request);
  }

  // POST /certs/jobs/create-next {jobId, months?} — clone an EM/PAT job for its
  // next test (default +12 months; monthly EM → +1). New job, Pending, unassigned.
  if (sub === "/jobs/create-next" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const src = await getJob(env, tid, String(b.jobId || ""));
    if (!src) return error("Job not found", 404, env, request);
    let months = Number(b.months);
    if (!Number.isFinite(months) || months < 1 || months > 60) months = (src.emKind === "monthly") ? 1 : 12;
    const base = src.scheduledAt ? new Date(src.scheduledAt) : new Date();
    const next = new Date(isNaN(base) ? Date.now() : base.getTime());
    next.setMonth(next.getMonth() + months);
    const job = await createOrUpdateJobFromPayload(env, tid, {
      reference: src.helpdeskRef || src.reference || "", description: src.description || "",
      siteName: src.siteName || "", siteCode: src.siteCode || "", address: src.address || "", postcode: src.postcode || "",
      priority: src.priority || "", emTest: !!src.emTest, pat: !!src.pat, emKind: src.emKind || "",
      durationMinutes: src.durationMinutes, scheduledAt: next.toISOString(), status: "Pending",
      assignedEngineers: [], originator: "cert-next",
    });
    return json({ ok: true, id: job.id, scheduledAt: next.toISOString(), months }, {}, env, request);
  }

  // POST /certs/jobs/bulk-create — create an EM (or PAT) job for MANY sites in one
  // go (built for the FBC monthly round). The client sends each site with its
  // pre-computed scheduledAt (it owns the London-time spread). {type, emKind,
  // engineers[], durationMinutes, sites:[{siteNumber, scheduledAt}]}.
  if (sub === "/jobs/bulk-create" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const sites = Array.isArray(b.sites) ? b.sites.slice(0, 200) : [];
    if (!sites.length) return error("No sites selected", 400, env, request);
    // Co-op/Cobra → a combined 3-hour EM + PAT job per site; FBC → EM only
    // (monthly flick or yearly 3-hour). Accept em/pat booleans (or legacy `type`).
    const em = b.em !== undefined ? !!b.em : (b.type !== "pat");
    const pat = b.pat !== undefined ? !!b.pat : (b.type === "pat");
    if (!em && !pat) return error("Pick EM and/or PAT", 400, env, request);
    const emKind = em ? (b.emKind === "monthly" ? "monthly" : "yearly") : "";
    const dur = Number(b.durationMinutes) > 0 ? Number(b.durationMinutes)
      : (em && pat ? 180 : em ? (emKind === "monthly" ? 30 : 180) : 45);
    const engineers = Array.isArray(b.engineers) ? b.engineers.filter(Boolean).slice(0, 20) : [];
    const nums = [...new Set(sites.map(s => String(s.siteNumber || "")).filter(Boolean))];
    const ph = nums.map(() => "?").join(",");
    const rows = nums.length ? ((await env.DB.prepare(`SELECT site_number, site_name, postcode, data FROM sites WHERE tenant_id=? AND site_number IN (${ph})`).bind(tid, ...nums).all()).results || []) : [];
    const byNum = {}; rows.forEach(r => { byNum[String(r.site_number)] = r; });
    const yr = String(new Date().getFullYear()).slice(-2);
    const created = [], skipped = [];
    for (const it of sites) {
      const num = String(it.siteNumber || ""); const s = byNum[num];
      if (!num || !s) { if (num) skipped.push(num); continue; }
      let addr = "", siteDur = 0; try { const dd = s.data ? JSON.parse(s.data) : {}; addr = dd.address || ""; siteDur = Number(dd.expectedDurationMinutes) || 0; } catch {}
      // Per-site expected duration: the row's own value → else the site's saved
      // default → else the group default. Feeds the route optimiser later.
      const sdur = Number(it.durationMinutes) > 0 ? Number(it.durationMinutes) : (siteDur > 0 ? siteDur : dur);
      const setNum = (em && emKind !== "monthly") ? await emSetFor(env, tid, num) : "";
      let desc;
      if (em && pat) desc = `EM: Import certificate number ${setNum || num}-${yr}\nPAT: Import certificate number ${num}-${yr}`;
      else if (em) desc = emKind === "monthly" ? `Monthly emergency lighting flick test — ${s.site_name || num}` : `Import certificate number ${setNum || num}-${yr}`;
      else desc = `Import certificate number ${num}-${yr}`;
      const sched = /^\d{4}-\d{2}-\d{2}T/.test(String(it.scheduledAt || "")) ? it.scheduledAt : undefined;
      const job = await createOrUpdateJobFromPayload(env, tid, {
        reference: s.site_name || num, description: desc,
        siteName: s.site_name || "", siteCode: num, address: addr, postcode: s.postcode || "",
        emTest: em, pat, emKind,
        durationMinutes: sdur, scheduledAt: sched, status: "Pending",
        assignedEngineers: engineers, originator: "bulk-em",
      });
      created.push({ id: job.id, site: s.site_name || num });
    }
    return json({ ok: true, created: created.length, skipped, jobs: created }, {}, env, request);
  }

  // POST /certs/site-duration {siteNumber, minutes} — save a site's expected
  // on-site duration (stored on the site) so it prefills next time + can drive
  // route optimisation. Office only.
  if (sub === "/site-duration" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const num = String(b.siteNumber || "").trim();
    const mins = Math.max(0, Math.min(1440, Number(b.minutes) || 0));
    if (!num) return error("siteNumber required", 400, env, request);
    const row = await env.DB.prepare("SELECT client, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, num).first();
    if (!row) return error("Site not found", 404, env, request);
    let data = {}; try { data = row.data ? JSON.parse(row.data) : {}; } catch {}
    if (mins > 0) data.expectedDurationMinutes = mins; else delete data.expectedDurationMinutes;
    await env.DB.prepare("UPDATE sites SET data=? WHERE tenant_id=? AND site_number=? AND client=?").bind(JSON.stringify(data), tid, num, row.client).run();
    return json({ ok: true, minutes: mins }, {}, env, request);
  }

  // GET /certs/w3w-key — hand the what3words key to an ADMIN's browser so the
  // lookup runs browser-side (its referrer matches the key's HTTP-referrer
  // restriction; a Cloudflare Worker can't send a matching referrer). Office only.
  if (sub === "/w3w-key" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    return json({ ok: true, key: env.W3W_KEY || "" }, {}, env, request);
  }

  // POST /certs/w3w-postcodes {items:[{name, words, lat?, lng?, postcode?}]} —
  // save each FBC site's postcode + pin + words. The browser resolves the
  // what3words → lat/lng (+ postcode) and sends them here; if a row arrives
  // without coords we fall back to a server-side lookup (works only if the key
  // isn't referrer-restricted). Office only.
  if (sub === "/w3w-postcodes" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
    if (!items.length) return error("No items", 400, env, request);
    const rows = (await env.DB.prepare("SELECT site_number, site_name, client, postcode, data FROM sites WHERE tenant_id=? AND client='fbc'").bind(tid).all()).results || [];
    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const byName = {}; rows.forEach(r => { byName[norm(r.site_name)] = r; });
    const out = [];
    for (const it of items) {
      const words = String(it.words || "").replace(/^\/+/, "").trim();
      const site = byName[norm(it.name)];
      if (!site) { out.push({ name: it.name, ok: false, error: "no matching FBC site" }); continue; }
      try {
        const lat = Number(it.lat), lng = Number(it.lng);
        let pc = String(it.postcode || "").trim();
        if (!pc && isFinite(lat) && isFinite(lng)) {
          try { const p = await fetch("https://api.postcodes.io/postcodes?lon=" + lng + "&lat=" + lat).then(r => r.json()); pc = (p && p.result && p.result[0] && p.result[0].postcode) || ""; } catch {}
        }
        let data = {}; try { data = site.data ? JSON.parse(site.data) : {}; } catch {}
        if (isFinite(lat)) data.lat = lat; if (isFinite(lng)) data.lon = lng;
        if (words) data.fbcWhat3Words = "///" + words;   // always keep the words on the site
        // Postcode lives in BOTH the column and data.postcode (the Sites page shows
        // the latter). NEVER overwrite a postcode already set in either — only fill
        // a genuinely blank one, and keep the two in step.
        const existingPc = (site.postcode && String(site.postcode).trim()) || (data.postcode && String(data.postcode).trim()) || "";
        if (pc && !existingPc) {
          data.postcode = pc;
          await env.DB.prepare("UPDATE sites SET postcode=?, data=? WHERE tenant_id=? AND client=? AND site_number=?").bind(pc, JSON.stringify(data), tid, site.client, site.site_number).run();
        } else {
          await env.DB.prepare("UPDATE sites SET data=? WHERE tenant_id=? AND client=? AND site_number=?").bind(JSON.stringify(data), tid, site.client, site.site_number).run();
        }
        out.push({ name: it.name, site: site.site_number, ok: true, postcode: existingPc || pc, kept: !!existingPc });
      } catch (e) { out.push({ name: it.name, site: site.site_number, ok: false, error: String((e && e.message) || e) }); }
    }
    return json({ ok: true, results: out }, {}, env, request);
  }


  // ── EM remedial battery photo upload (engineer or office) ───────────────────
  if (sub === "/photo" && method === "POST") {
    if (!env.JOB_FILES) return error("Storage unavailable", 500, env, request);
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    const certId = String((form && form.get("certId")) || "").trim();
    if (!certId || !file || typeof file === "string") return error("Missing certId or file", 400, env, request);
    const cert = await loadCert(certId);
    if (!cert) return error("Certificate not found", 404, env, request);
    if (!isOffice && cert.engineer !== me) return error("Not your certificate", 403, env, request);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.abs((Date.now() ^ (certId.length * 2654435761)) % 1e6);
    const key = `certremedial/${tid}/${certId}/${ts}-${rand}.jpg`;
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 6 * 1024 * 1024) return error("Photo too large", 413, env, request);
    await env.JOB_FILES.put(key, buf, { httpMetadata: { contentType: file.type || "image/jpeg" } });
    const urlOut = await signedFileUrl(env, url.origin, "/certs/photo", key);
    return json({ ok: true, key, url: urlOut }, {}, env, request);
  }

  // ── Suggested next number ────────────────────────────────────────────────────
  if (sub === "/number" && method === "GET") {
    return json({ ok: true, number: await suggestNumber(env, tid, q.get("code"), T(q.get("type")), { kind: q.get("kind") || "", date: q.get("date") || "" }) }, {}, env, request);
  }

  // ── Re-pull the previous certificate's details on demand (into an existing
  //    draft that was created before the reader existed, or to refresh it). ────
  if (sub === "/prefill" && method === "GET") {
    const type = T(q.get("type"));
    let code = q.get("code") || "";
    if (!code && q.get("jobId")) { const job = await getJob(env, tid, String(q.get("jobId"))); code = job ? (job.siteCode || "") : ""; }
    const pre = await prefillFromPrevious(env, tid, code, type);
    return json({ ok: true, rows: pre.rows, header: pre.header || null, from: pre.from, source: pre.source || null, prefilledRows: pre.rows.length }, {}, env, request);
  }

  // ── Load or seed the certificate for a job ───────────────────────────────────
  if (sub === "/for-job" && method === "GET") {
    const jobId = String(q.get("jobId") || "");
    const type = T(q.get("type"));
    if (!jobId) return error("jobId required", 400, env, request);
    const config = await getConfig(env, tid);
    // Resolve the job's site + its CLIENT TYPE up front, so we can auto-fill the
    // certificate's Client block from the site (Co-op estates → Co-op head office,
    // FBC → the council) for both a fresh seed AND back-filling a blank existing draft.
    const job = await getJob(env, tid, jobId);
    const code = job ? (job.siteCode || "") : "";
    const siteRow = code ? await env.DB.prepare("SELECT client, site_name, postcode, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, String(code)).first() : null;
    let siteData = {}; try { siteData = siteRow && siteRow.data ? JSON.parse(siteRow.data) : {}; } catch {}
    const mappedClient = clientForSiteClient(siteRow && siteRow.client);

    const existing = await env.DB.prepare(
      "SELECT * FROM certificates WHERE tenant_id=? AND job_id=? AND type=? ORDER BY created_at DESC LIMIT 1"
    ).bind(tid, jobId, type).first();
    if (existing) {
      const exRec = shapeRow(existing);
      await backfillClient(env, tid, exRec);   // fill any blank client field (name/address/postcode) from the site
      await resignRemedialPhotos(env, url.origin, exRec);
      return json({ ok: true, record: exRec, config, seeded: false }, {}, env, request);
    }

    // seed a fresh draft from the job's site + config + prefill rows
    const pre = await prefillFromPrevious(env, tid, code, type);
    const h = pre.header;
    const record = {
      id: null, type, status: "draft", jobId, siteCode: code, certNumber: "",
      // EM test kind (monthly flick / yearly 3-hour) carried from the job so the
      // number + compliance filing know which it is.
      emKind: (job && job.emKind) || "",
      // Client: the SITE's client type is authoritative for known estates; else the
      // previous cert; else the config default.
      client: mappedClient || (h && h.client) || (config.client || { name: "", address: "", postcode: "" }),
      // Installation: previous cert → else the REAL portal site record.
      installation: (h && h.installation) ? h.installation : {
        name: (job && job.siteName) || (siteRow && siteRow.site_name) || "",
        address: (job && job.address) || (siteData.address || ""),
        postcode: (job && job.postcode) || (siteRow && siteRow.postcode) || "",
      },
      // Extent/comments: previous cert if present, else our standard template.
      extent: (h && h.extent) || config[type].extent,
      comments: (h && h.comments != null && h.comments !== "") ? h.comments : config[type].comments,
      declaration: config[type].declaration,
      // Contractor = Mostlane's own details (config), refined by the previous
      // cert's trading block; the engineer NAME auto-fills from the job's assigned
      // engineer (per-visit), date left for the engineer to confirm.
      contractor: { ...config.contractor, ...((h && h.contractor) || {}), name: (job && Array.isArray(job.assignedEngineers) && job.assignedEngineers[0]) || "", position: "Engineer", date: "" },
      rows: pre.rows,
      signature: "",
    };
    return json({ ok: true, record, config, seeded: true, prefilledFrom: pre.from, prefilledRows: pre.rows.length, prefillSource: pre.source || null }, {}, env, request);
  }

  // ── Save (upsert) a draft ────────────────────────────────────────────────────
  if (sub === "/save" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const type = T(b.type);
    let id = b.id ? String(b.id) : "";
    const now = new Date().toISOString();
    let existing = id ? await loadCert(id) : null;
    // the office, the cert's creator, OR the job's assigned engineer may write it
    if (existing && !(await canWriteCert(existing))) return error("Not your certificate", 403, env, request);
    if (existing && existing.status === "final" && !isOffice) return error("This certificate is finalised", 409, env, request);

    let prevData = {}; try { prevData = existing ? JSON.parse(existing.data) : {}; } catch {}
    const data = {
      client: b.client || {}, installation: b.installation || {},
      extent: b.extent || "", comments: b.comments || "", declaration: b.declaration || "",
      contractor: b.contractor || {}, rows: Array.isArray(b.rows) ? b.rows.slice(0, 500) : [],
      // Carry the EM test kind (monthly/yearly) so numbering + filing know it.
      emKind: (b.emKind === "monthly" || b.emKind === "yearly") ? b.emKind : (prevData.emKind || ""),
      signature: typeof b.signature === "string" ? b.signature.slice(0, 400000) : (existing ? undefined : ""),
    };
    normalizeRemedials(data);   // a remedial with detail is always a flagged fault
    if (data.signature === undefined) { // keep the stored signature if not re-sent
      try { const d = existing ? JSON.parse(existing.data) : {}; data.signature = d.signature || ""; } catch { data.signature = ""; }
    }

    if (!existing) {
      id = "CERT-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
      await env.DB.prepare(
        "INSERT INTO certificates (id, tenant_id, type, status, job_id, site_code, cert_number, data, engineer, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, tid, type, "draft", b.jobId ? String(b.jobId) : null, b.siteCode ? padCode(b.siteCode) : "", "", JSON.stringify(data), me, now, now).run();
    } else {
      await env.DB.prepare(
        "UPDATE certificates SET type=?, site_code=?, data=?, updated_at=? WHERE tenant_id=? AND id=?"
      ).bind(type, b.siteCode ? padCode(b.siteCode) : existing.site_code, JSON.stringify(data), now, tid, id).run();
    }
    return json({ ok: true, id }, {}, env, request);
  }

  // ── Engineer submits for office review ───────────────────────────────────────
  if (sub === "/submit" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const cert = await loadCert(String(b.id || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    if (!(await canWriteCert(cert))) return error("Not your certificate", 403, env, request);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE certificates SET status='review', submitted_at=?, updated_at=? WHERE tenant_id=? AND id=?").bind(now, now, tid, cert.id).run();
    // Complete the JOB if all its required certs (em/pat) are now in — server-side,
    // so the job is never left stuck In Progress if the engineer's device didn't
    // patch it (which then blocks their clock-off).
    const jobDone = await maybeCompleteCertJob(env, tid, cert);
    // Notify the office review queue. If specific reviewers are configured
    // (cert:config.reviewers), notify ONLY them; otherwise fall back to everyone
    // with FullAccess / SLAAdmin / Compliance (the default behaviour).
    const payload = {
      title: (cert.type === "pat" ? "PAT" : "EM") + " certificate ready to review",
      body: `${me} submitted a certificate for review.`, url: "/cert-review.html", tag: "cert-review:" + cert.id,
    };
    const cfg = await getConfig(env, tid);
    const chosen = (cfg.reviewers || []).filter(u => String(u).toLowerCase() !== String(me).toLowerCase());
    if (chosen.length) {
      ctx?.waitUntil?.(Promise.all(chosen.map(u => sendToUser(env, tid, u, payload).catch(() => {}))));
    } else {
      ctx?.waitUntil?.(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], payload, me, { officeOnly: true }).catch(() => {}));
    }
    return json({ ok: true, jobComplete: jobDone }, {}, env, request);
  }

  // ── Render the certificate PDF ───────────────────────────────────────────────
  if (sub === "/pdf" && method === "GET") {
    const cert = await loadCert(String(q.get("id") || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    if (!isOffice && cert.engineer !== me) return error("Not your certificate", 403, env, request);
    const rec = shapeRow(cert); await backfillClient(env, tid, rec);
    const sig = dataUrlToBytes(rec.signature);
    let logo = null; try { logo = logoBytes(); } catch {}
    const bytes = buildCertPdf(rec, { logo, signature: sig });
    // Raw (non-JSON) response — must carry CORS itself, else the cross-origin
    // fetch (portal → workers.dev) that streams it in for preview is blocked.
    return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${(rec.certNumber || cert.id)}.pdf"`, "Cache-Control": "no-store", ...corsHeaders(env, request) } });
  }

  // ── One record (office) ──────────────────────────────────────────────────────
  if (sub === "/one" && method === "GET") {
    const cert = await loadCert(String(q.get("id") || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    if (!isOffice && cert.engineer !== me) return error("Not your certificate", 403, env, request);
    const oneRec = shapeRow(cert); await backfillClient(env, tid, oneRec); await resignRemedialPhotos(env, url.origin, oneRec);
    return json({ ok: true, record: oneRec, config: await getConfig(env, tid) }, {}, env, request);
  }

  // ── Office review queue ──────────────────────────────────────────────────────
  if (sub === "/review" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    // Default = the queue (draft + submitted). ?all=1 also returns recently
    // ISSUED (final) certs so the office can open one and re-issue its PDF.
    const statuses = q.get("all") === "1" ? "('draft','review','final')" : "('draft','review')";
    const rows = (await env.DB.prepare(
      "SELECT * FROM certificates WHERE tenant_id=? AND status IN " + statuses + " ORDER BY COALESCE(submitted_at,finalised_at,updated_at) DESC LIMIT 300"
    ).bind(tid).all()).results || [];
    return json({ ok: true, certs: rows.map(shapeRow) }, {}, env, request);
  }

  // ── EM/PAT certificate TRACKER (office) — every expected certificate and where
  // it's up to, so the office can see what's still outstanding. One row per
  // (EM/PAT job × type it needs), joined to its certificate: notstarted (no cert
  // row yet — with the engineer), draft (being filled), review (submitted — office
  // to finalise), final (uploaded/filed to the compliance chart). Filter by the
  // certificate's activity day: today (default) / 7d / 30d / all. `count=1` returns
  // just the tallies (for the home-page hub card). ─────────────────────────────
  if (sub === "/status" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const range = String(q.get("range") || "today").toLowerCase();
    const countOnly = q.get("count") === "1";
    // London calendar-day strings (YYYY-MM-DD) so the window matches the working day.
    const londonDay = (d) => { try { const x = new Date(d); return isNaN(x) ? "" : x.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch { return ""; } };
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); };
    let from = null;
    if (range === "7d") from = daysAgo(6);
    else if (range === "30d") from = daysAgo(29);
    else if (range !== "all") from = today;   // default = today

    // Every live EM/PAT/pump job (dormant fallback templates + archive already excluded).
    const jobs = (await listJobs(env, tid)).filter(j => j && (j.emTest || j.pat || j.pumpMaintenance));
    // Certificate rows for those jobs, keyed job_id::type.
    const certByKey = {};
    const jobIds = jobs.map(j => String(j.id));
    for (let i = 0; i < jobIds.length; i += 100) {
      const chunk = jobIds.slice(i, i + 100);
      if (!chunk.length) break;
      const ph = chunk.map(() => "?").join(",");
      const rows = (await env.DB.prepare(
        `SELECT id,type,status,job_id,cert_number,engineer,created_at,updated_at,submitted_at,finalised_at FROM certificates WHERE tenant_id=? AND job_id IN (${ph})`
      ).bind(tid, ...chunk).all().catch(() => ({ results: [] }))).results || [];
      for (const r of rows) certByKey[String(r.job_id) + "::" + r.type] = r;
      // Pump maintenance records (routes/pump.js) are the "certificate" for a
      // pump job — same statuses (draft → review → final). Table may not exist
      // yet on a fresh DB, so fail soft.
      const prows = (await env.DB.prepare(
        `SELECT id,status,job_id,engineer,created_at,updated_at FROM pump_records WHERE tenant_id=? AND job_id IN (${ph})`
      ).bind(tid, ...chunk).all().catch(() => ({ results: [] }))).results || [];
      for (const r of prows) certByKey[String(r.job_id) + "::pump"] = { ...r, type: "pump", cert_number: "", submitted_at: r.status !== "draft" ? r.updated_at : null, finalised_at: r.status === "final" ? r.updated_at : null };
    }

    const isCancelled = s => /cancel/i.test(String(s || ""));
    const items = [];
    for (const j of jobs) {
      if (isCancelled(j.status)) continue;
      const engs = Array.isArray(j.assignedEngineers) ? j.assignedEngineers.filter(Boolean)
        : (j.assignedTo ? [j.assignedTo] : []);
      const types = [];
      if (j.emTest) types.push("em");
      if (j.pat) types.push("pat");
      if (j.pumpMaintenance) types.push("pump");
      for (const type of types) {
        const cert = certByKey[String(j.id) + "::" + type] || null;
        const status = cert ? cert.status : "notstarted";
        // The certificate's "activity" day: the timestamp of its current state
        // (finalised → submitted → last-edited), else the job's scheduled day.
        const activity = cert
          ? (cert.finalised_at || cert.submitted_at || cert.updated_at || cert.created_at)
          : (j.scheduledAt || j.createdAt || "");
        const day = londonDay(activity);
        if (day && day > today) continue;              // never show future/not-yet-due work
        if (from && (!day || day < from)) continue;    // outside the chosen window
        items.push({
          jobId: j.id, type,
          site: j.siteName || j.helpdeskRef || j.reference || "",
          siteCode: j.siteCode || "",
          engineers: engs,
          engineer: (cert && cert.engineer) || engs[0] || "",
          status,
          certId: cert ? cert.id : "",
          certNumber: (cert && cert.cert_number) || "",
          scheduledAt: j.scheduledAt || "",
          submittedAt: cert ? (cert.submitted_at || "") : "",
          finalisedAt: cert ? (cert.finalised_at || "") : "",
          activityAt: activity || "",
        });
      }
    }
    items.sort((a, b) => String(b.activityAt || "").localeCompare(String(a.activityAt || "")));
    const counts = {
      expected: items.length,
      uploaded: items.filter(i => i.status === "final").length,
      toReview: items.filter(i => i.status === "review").length,
      withEngineers: items.filter(i => i.status === "draft" || i.status === "notstarted").length,
    };
    return json({ ok: true, range, counts, items: countOnly ? [] : items }, {}, env, request);
  }

  // ── A site's issued history ──────────────────────────────────────────────────
  if (sub === "/list" && method === "GET") {
    const code = padCode(q.get("code")), type = T(q.get("type"));
    const rows = (await env.DB.prepare(
      "SELECT * FROM certificates WHERE tenant_id=? AND site_code=? AND type=? ORDER BY COALESCE(finalised_at,updated_at) DESC LIMIT 100"
    ).bind(tid, code, type).all()).results || [];
    return json({ ok: true, certs: rows.map(shapeRow) }, {}, env, request);
  }

  // ── Finalise → file to the compliance chart ──────────────────────────────────
  if (sub === "/finalise" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const cert = await loadCert(String(b.id || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    const rec = shapeRow(cert); await backfillClient(env, tid, rec);
    const code = padCode(cert.site_code || rec.siteCode);
    if (!code) return error("This certificate has no store code — set the site first.", 400, env, request);
    const docDate = String(b.docDate || (rec.contractor && rec.contractor.date) || "").trim() || new Date().toISOString().slice(0, 10);
    // EM test kind: from the cert (persisted), else the job (covers older certs).
    let emKind = (cert.type === "em") ? (rec.emKind || "") : "";
    if (cert.type === "em" && !emKind) { try { const jb = cert.job_id ? await getJob(env, tid, cert.job_id) : null; emKind = (jb && jb.emKind) || ""; } catch {} }
    // Number: monthly EM → <set>-<MM>-<YY> (unique per month); else <set>-<YY>.
    const number = String(b.certNumber || cert.cert_number || (await suggestNumber(env, tid, code, cert.type, { kind: emKind, date: docDate }))).trim();
    rec.certNumber = number; rec.status = "final";
    const sig = dataUrlToBytes(rec.signature);
    let logo = null; try { logo = logoBytes(); } catch {}
    const bytes = buildCertPdf(rec, { logo, signature: sig });
    // Which compliance chart? An FBC site files onto the FAREHAM chart (its code is
    // the site number, 3001-3024, so it tallies), and an EM cert files as emMonthly
    // or emYearly by the test kind. Everyone else → the Co-op chart (em/pat).
    let fileScheme = "coop", fileType = cert.type;
    try {
      const srow = await env.DB.prepare("SELECT client FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, String(rec.siteCode || code)).first();
      if (String((srow && srow.client) || "").toLowerCase() === "fbc") {
        fileScheme = "fareham";
        if (cert.type === "em") fileType = emKind === "monthly" ? "emMonthly" : "emYearly";
      }
    } catch {}
    const filed = await fileCertificatePdf(env, tid, {
      scheme: fileScheme, code, type: fileType, bytes,
      filename: `${code}_${cert.type.toUpperCase()}_${number}.pdf`,
      docDate: /^\d{4}-\d{2}-\d{2}/.test(docDate) ? docDate : new Date().toISOString().slice(0, 10),
      bump: true, source: "cert:" + cert.id, label: `${cert.type === "pat" ? "PAT" : "EM"} certificate ${number}`,
    });
    const now = new Date().toISOString();
    // bump the PAT rolling counter so the next suggestion moves on
    if (cert.type === "pat") { const n = Number(String(number).replace(/\D/g, "").slice(0, 5)); if (n) await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, "cert:patseq:" + tid, String(n)).run(); }
    await env.DB.prepare("UPDATE certificates SET status='final', cert_number=?, r2_final_key=?, finalised_at=?, finalised_by=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(number, filed.key, now, me, now, tid, cert.id).run();
    // Finalising a cert also completes the JOB once all its certs are in — so an
    // office-finalised EM/PAT job never sits stuck In Progress on the engineer's
    // board (which used to block their clock-off).
    try { await maybeCompleteCertJob(env, tid, cert); } catch {}
    if (cert.engineer && cert.engineer !== me) ctx?.waitUntil?.(sendToUser(env, tid, cert.engineer, { title: "Certificate issued", body: `Your ${cert.type === "pat" ? "PAT" : "EM"} certificate ${number} has been reviewed and filed.`, url: "/eicr-portal.html", tag: "cert-final:" + cert.id }).catch(() => {}));
    // EM remedials: log the £50/fitting failures + raise a remedial job for the
    // not-replaced ones, and tell the office so they can charge for the works.
    let remedial = null;
    try { remedial = await processEmRemedials(env, tid, rec, cert, number, code); } catch {}
    if (remedial && remedial.count) {
      const site = (rec.installation && rec.installation.name) || code;
      const body = `EM cert ${number} — ${site}: ${remedial.count} fitting${remedial.count === 1 ? "" : "s"} failed` + (remedial.charge ? ` (£${remedial.charge} in lights)` : "") + (remedial.batteries ? `, ${remedial.batteries} needing batteries` : "") + `. Quote the client — track it on the EM remedials list.`;
      ctx?.waitUntil?.(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], { title: "EM remedial to quote", body, url: "/cert-review.html", tag: "em-remedial:" + cert.id }, null, { officeOnly: true }).catch(() => {}));
    }
    return json({ ok: true, number, key: filed.key, remedial }, {}, env, request);
  }

  // ── Re-issue: rebuild the PDF from the cert's CURRENT data and replace the filed
  //    copy on the compliance chart, WITHOUT moving the due date (bump:false) and
  //    keeping the same number. Use after editing an already-issued cert. Office only.
  if (sub === "/reissue" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const cert = await loadCert(String(b.id || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    const rec = shapeRow(cert); await backfillClient(env, tid, rec);
    const code = padCode(cert.site_code || rec.siteCode);
    if (!code) return error("This certificate has no store code.", 400, env, request);
    const number = String(cert.cert_number || b.certNumber || "").trim();
    if (!number) return error("This certificate hasn't been issued yet — finalise it first.", 400, env, request);
    const docDate = String(b.docDate || (rec.contractor && rec.contractor.date) || cert.finalised_at || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    let emKind = (cert.type === "em") ? (rec.emKind || "") : "";
    if (cert.type === "em" && !emKind) { try { const jb = cert.job_id ? await getJob(env, tid, cert.job_id) : null; emKind = (jb && jb.emKind) || ""; } catch {} }
    rec.certNumber = number; rec.status = "final";
    const sig = dataUrlToBytes(rec.signature);
    let logo = null; try { logo = logoBytes(); } catch {}
    const bytes = buildCertPdf(rec, { logo, signature: sig });
    let fileScheme = "coop", fileType = cert.type;
    try {
      const srow = await env.DB.prepare("SELECT client FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, String(rec.siteCode || code)).first();
      if (String((srow && srow.client) || "").toLowerCase() === "fbc") { fileScheme = "fareham"; if (cert.type === "em") fileType = emKind === "monthly" ? "emMonthly" : "emYearly"; }
    } catch {}
    const filed = await fileCertificatePdf(env, tid, {
      scheme: fileScheme, code, type: fileType, bytes,
      filename: `${code}_${cert.type.toUpperCase()}_${number}.pdf`,
      docDate: /^\d{4}-\d{2}-\d{2}/.test(docDate) ? docDate : new Date().toISOString().slice(0, 10),
      bump: false, source: "cert:" + cert.id, label: `${cert.type === "pat" ? "PAT" : "EM"} certificate ${number}`,
    });
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE certificates SET status='final', r2_final_key=?, finalised_at=COALESCE(finalised_at,?), finalised_by=COALESCE(finalised_by,?), updated_at=? WHERE tenant_id=? AND id=?")
      .bind(filed.key, now, me, now, tid, cert.id).run();
    return json({ ok: true, number, key: filed.key, reissued: true }, {}, env, request);
  }

  // GET /certs/remedials?status=&code= — the remedial charge log (office).
  if (sub === "/remedials" && method === "GET") {
    const st = String(q.get("status") || "").toLowerCase();
    const code = String(q.get("code") || "").trim();
    const where = ["tenant_id=?"]; const bind = [tid];
    if (st === "done" || st === "pending") { where.push("status=?"); bind.push(st); }
    if (code) { where.push("site_code=?"); bind.push(padCode(code)); }
    const { results } = await env.DB.prepare(
      `SELECT * FROM em_remedials WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`
    ).bind(...bind).all();
    const rows = results || [];
    const total = rows.reduce((a, r) => a + (Number(r.charge) || 0), 0);
    const pending = rows.filter(r => r.status === "pending").reduce((a, r) => a + (Number(r.charge) || 0), 0);
    return json({ ok: true, remedials: rows, count: rows.length, totalCharge: total, pendingCharge: pending }, {}, env, request);
  }

  // v2 stage view: legacy `approved` (job raised under the old flow) reads as in_works.
  const stageOf = r => { const s = r.stage || "to_quote"; return s === "approved" ? "in_works" : s; };
  const shapeCase = (r, fittings) => ({
    certId: r.cert_id, certNumber: r.cert_number, siteName: r.site_name || r.site_code, siteCode: r.site_code,
    fittings: r.fittings, charge: r.charge, onsite: r.onsite, pending: r.pending, batteries: r.batteries || 0,
    lightsPending: r.lights_pending || 0, lightsJobId: r.lights_job_id || null,
    stage: stageOf(r), jobId: r.job_id || r.lights_job_id || null, createdAt: r.created_at,
    quotedAt: r.quoted_at, approvedAt: r.approved_at, invoicedAt: r.invoiced_at,
    poReceivedAt: r.po_received_at || null, worksDoneAt: r.works_done_at || null,
    awaitingBatteries: !!(r.awaiting_batteries && !r.batteries_arrived_at), batteriesArrivedAt: r.batteries_arrived_at || null,
    statusLabel: r.status_label || (r.lights_pending ? "works" : (r.pending ? "batteries" : "onsite")),
    reissueCertId: r.reissue_cert_id || null,
    items: (fittings || []).map(f => ({ no: f.fitting_no, ref: f.light_ref, kind: f.kind === "battery" ? "battery" : "light",
      replacedOnSite: !!f.replaced_on_site, spec: f.kind === "battery" ? (f.battery_spec || "") : (f.light_spec || ""), qty: f.battery_qty || 0, note: f.note || "" })),
  });
  // Per-fitting rows for a set of cases (one query, grouped by cert).
  const fittingsFor = async certIds => {
    const out = {}; const ids = (certIds || []).filter(Boolean);
    for (let i = 0; i < ids.length; i += 60) {
      const chunk = ids.slice(i, i + 60);
      const { results } = await env.DB.prepare(`SELECT * FROM em_remedials WHERE tenant_id=? AND cert_id IN (${chunk.map(() => "?").join(",")}) ORDER BY fitting_no, id`).bind(tid, ...chunk).all().catch(() => ({ results: [] }));
      for (const r of (results || [])) (out[r.cert_id] = out[r.cert_id] || []).push(r);
    }
    return out;
  };

  // GET /certs/remedials/outstanding — cases still at the BLOCKING `to_quote` stage
  // that are due now (never snoozed, or the 4h snooze has passed). Drives the gate.
  if (sub === "/remedials/outstanding" && method === "GET") {
    if (!isOffice) return json({ ok: true, remedials: [] }, {}, env, request);
    const now = new Date().toISOString();
    const { results } = await env.DB.prepare(
      "SELECT * FROM em_remedial_acks WHERE tenant_id=? AND COALESCE(stage,'to_quote')='to_quote' AND (snooze_until IS NULL OR snooze_until<=?) ORDER BY created_at ASC LIMIT 50"
    ).bind(tid, now).all();
    const rows = results || [];
    const fit = await fittingsFor(rows.map(r => r.cert_id));
    const out = [];
    for (const r of rows) {
      const c = shapeCase(r, fit[r.cert_id]);
      // The copy-and-paste client quote, built from the certificate itself.
      try { const cert = await loadCert(r.cert_id); if (cert) { const q2 = buildQuoteText(shapeRow(cert), r.site_code); c.quoteText = q2 ? q2.text : ""; c.quoteTotal = q2 ? q2.total : 0; } } catch {}
      out.push(c);
    }
    return json({ ok: true, remedials: out }, {}, env, request);
  }

  // GET /certs/remedials/board — the continuous tracking list. Every OPEN case
  // (not yet invoiced) with its stage, so nothing is forgotten. ?all=1 includes invoiced.
  if (sub === "/remedials/board" && method === "GET") {
    if (!isOffice) return json({ ok: true, cases: [] }, {}, env, request);
    const all = q.get("all") === "1";
    const { results } = await env.DB.prepare(
      `SELECT * FROM em_remedial_acks WHERE tenant_id=?${all ? "" : " AND COALESCE(stage,'to_quote')<>'invoiced'"} ORDER BY created_at DESC LIMIT 400`
    ).bind(tid).all();
    const rows = results || [];
    const fit = await fittingsFor(rows.map(r => r.cert_id));
    return json({ ok: true, cases: rows.map(r => shapeCase(r, fit[r.cert_id])) }, {}, env, request);
  }

  // ── Client orders (office) — incoming approvals fed in by the email bot ────────
  // GET /certs/remedials/orders?all=1 — the review list (default hides
  // actioned/dismissed). Each carries its match to a remedial awaiting approval.
  if (sub === "/remedials/orders" && method === "GET") {
    if (!isOffice) return json({ ok: true, orders: [] }, {}, env, request);
    const all = q.get("all") === "1";
    const { results } = await env.DB.prepare(
      `SELECT * FROM client_orders WHERE tenant_id=?${all ? "" : " AND status IN ('new','matched')"} ORDER BY created_at DESC LIMIT 300`
    ).bind(tid).all();
    return json({ ok: true, orders: (results || []).map(shapeOrder) }, {}, env, request);
  }

  // POST /certs/remedials/order-action {id, action:"approve"|"dismiss"|"reopen"} —
  // office confirms an order: `approve` raises the works job for the matched EM
  // remedial (advances the case to `approved`) — or, for an electrical-test match,
  // links the job for the office to raise the works there. `dismiss` files it away.
  if (sub === "/remedials/order-action" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const oid = String(b.id || "").trim();
    const action = String(b.action || "").toLowerCase();
    const ord = await env.DB.prepare("SELECT * FROM client_orders WHERE tenant_id=? AND id=?").bind(tid, oid).first();
    if (!ord) return error("Order not found", 404, env, request);
    const now = new Date().toISOString();
    if (action === "dismiss") {
      await env.DB.prepare("UPDATE client_orders SET status='dismissed', actioned_at=?, actioned_by=? WHERE tenant_id=? AND id=?").bind(now, me, tid, oid).run();
      return json({ ok: true, status: "dismissed" }, {}, env, request);
    }
    if (action === "reopen") {
      const st = ord.matched_cert_id || ord.matched_job_id ? "matched" : "new";
      await env.DB.prepare("UPDATE client_orders SET status=?, actioned_at=NULL, actioned_by=NULL WHERE tenant_id=? AND id=?").bind(st, tid, oid).run();
      return json({ ok: true, status: st }, {}, env, request);
    }
    if (action === "approve") {
      let jobId = null, note = "";
      if (ord.matched_kind === "em" && ord.matched_cert_id) {
        // Client order landed → same as pressing "PO Received" on the case.
        const res = await poReceived(env, tid, ord.matched_cert_id, me, ctx);
        jobId = res.jobId || null;
        note = res.stage === "done" ? "All fittings were replaced on site — updated certificate filed to compliance." : (res.awaitingBatteries ? "Works job raised (awaiting batteries)." : "Works job raised.");
      } else if (ord.matched_kind === "elec" && ord.matched_job_id) {
        jobId = ord.matched_job_id;
        note = "Open the electrical-test job to raise the remedial works job.";
      } else {
        return json({ ok: false, error: "This order isn't matched to a remedial — open the tracker and link it manually." }, { status: 400 }, env, request);
      }
      await env.DB.prepare("UPDATE client_orders SET status='actioned', matched_job_id=COALESCE(?,matched_job_id), actioned_at=?, actioned_by=? WHERE tenant_id=? AND id=?").bind(jobId, now, me, tid, oid).run();
      return json({ ok: true, status: "actioned", jobId, note }, {}, env, request);
    }
    return error("Unknown action", 400, env, request);
  }

  // POST /certs/remedials/ack {certId, action:"done"|"later"} — the blocking modal:
  // "done" = quote sent (→ stage `quoted`, out of the gate); "later" = snooze 4h.
  if (sub === "/remedials/ack" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const certId = String(b.certId || b.id || "").trim();
    if (!certId) return error("Missing certId", 400, env, request);
    const now = new Date().toISOString();
    if (String(b.action) === "later") {
      const until = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
      await env.DB.prepare("UPDATE em_remedial_acks SET snooze_until=? WHERE tenant_id=? AND cert_id=?").bind(until, tid, certId).run();
      return json({ ok: true, snoozed: until }, {}, env, request);
    }
    await env.DB.prepare("UPDATE em_remedial_acks SET stage='quoted', quoted_at=?, quoted_by=?, snooze_until=NULL WHERE tenant_id=? AND cert_id=?").bind(now, me, tid, certId).run();
    return json({ ok: true, stage: "quoted" }, {}, env, request);
  }

  // POST /certs/remedials/stage {certId, to} — advance a case along the pipeline.
  //   quoted   → approved  : client approved / order received. If there are
  //                          not-replaced fittings, RAISE the remedial SLA job now.
  //   approved → invoiced  : done (drops off the board + clears the ⚠).
  //   any      → to_quote  : re-open (undo).
  if (sub === "/remedials/stage" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const certId = String(b.certId || "").trim();
    const to = String(b.to || "").trim();
    if (!certId || STAGES.indexOf(to) < 0) return error("Missing certId or bad stage", 400, env, request);
    const now = new Date().toISOString();
    let jobId = null;
    if (to === "approved" || to === "in_works" || to === "done") {
      // v2: these all mean "the client has ordered" → PO Received.
      const res = await poReceived(env, tid, certId, me, ctx); jobId = res.jobId || null;
    } else if (to === "invoiced") {
      await env.DB.prepare("UPDATE em_remedial_acks SET stage='invoiced', invoiced_at=?, invoiced_by=? WHERE tenant_id=? AND cert_id=?").bind(now, me, tid, certId).run();
    } else if (to === "to_quote") {
      await env.DB.prepare("UPDATE em_remedial_acks SET stage='to_quote', snooze_until=NULL WHERE tenant_id=? AND cert_id=?").bind(tid, certId).run();
    } else { // quoted
      await env.DB.prepare("UPDATE em_remedial_acks SET stage='quoted', quoted_at=COALESCE(quoted_at,?), quoted_by=COALESCE(quoted_by,?), snooze_until=NULL WHERE tenant_id=? AND cert_id=?").bind(now, me, tid, certId).run();
    }
    const row = await env.DB.prepare("SELECT * FROM em_remedial_acks WHERE tenant_id=? AND cert_id=?").bind(tid, certId).first();
    return json({ ok: true, stage: to, jobId, case: row ? shapeCase(row) : null }, {}, env, request);
  }

  // GET /certs/remedials/quote-text?certId= — the copy-and-paste CLIENT quote for
  // the LIGHT remedials (agreed £50/light — no supplier, no approval). Office
  // pastes it straight into a quote. Reads the cert so it works before OR after
  // finalise.
  if (sub === "/remedials/quote-text" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const cert = await loadCert(String(q.get("certId") || q.get("id") || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    const rec = shapeRow(cert);
    const siteName = (rec.installation && rec.installation.name) || (rec.client && rec.client.name) || cert.site_code;
    const quote = buildQuoteText(rec, cert.site_code || rec.siteCode);
    if (!quote) return json({ ok: true, text: "", count: 0, total: 0, message: "No failed fittings on this certificate." }, {}, env, request);
    return json({ ok: true, ...quote, site: siteName, certNumber: rec.certNumber || "" }, {}, env, request);
  }

  // POST /certs/remedials/po-received {certId} — the client has ordered the works.
  if (sub === "/remedials/po-received" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const certId = String(b.certId || b.id || "").trim();
    if (!certId) return error("Missing certId", 400, env, request);
    const exists = await env.DB.prepare("SELECT cert_id FROM em_remedial_acks WHERE tenant_id=? AND cert_id=?").bind(tid, certId).first();
    if (!exists) return error("No remedial case for that certificate", 404, env, request);
    const res = await poReceived(env, tid, certId, me, ctx);
    const row = await env.DB.prepare("SELECT * FROM em_remedial_acks WHERE tenant_id=? AND cert_id=?").bind(tid, certId).first();
    return json({ ok: true, ...res, case: row ? shapeCase(row, (await fittingsFor([certId]))[certId]) : null }, {}, env, request);
  }

  // POST /certs/remedials/batteries-arrived {certId} — clears the awaiting flag on
  // the works job (the office can now book it) and tells the SLA admins.
  if (sub === "/remedials/batteries-arrived" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const certId = String(b.certId || b.id || "").trim();
    const row = await env.DB.prepare("SELECT * FROM em_remedial_acks WHERE tenant_id=? AND cert_id=?").bind(tid, certId).first();
    if (!row) return error("No remedial case for that certificate", 404, env, request);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE em_remedial_acks SET awaiting_batteries=0, batteries_arrived_at=? WHERE tenant_id=? AND cert_id=?").bind(now, tid, certId).run();
    const jobId = row.job_id || ("emrem:" + certId);
    try {
      const job = await getJob(env, tid, jobId);
      if (job && /AWAITING BATTERIES/.test(String(job.description || ""))) {
        await createOrUpdateJobFromPayload(env, tid, { id: jobId, description: String(job.description).replace(/^⏳ AWAITING BATTERIES[^\n]*\n\n?/, "") });
      }
    } catch {}
    ctx?.waitUntil?.(sendToPermission(env, tid, ["FullAccess", "SLAAdmin"], { title: "Batteries arrived — EM remedial ready to book",
      body: `${row.site_name || row.site_code}: the batteries for the EM remedial have arrived. The works job can be scheduled now.`, url: "/job-view.html?jobId=" + encodeURIComponent(jobId), tag: "em-batt:" + certId }, me, { officeOnly: true }).catch(() => {}));
    return json({ ok: true, jobId }, {}, env, request);
  }

  // GET /certs/remedials/email-draft?certId= — the pre-written supplier email
  // (greeting by London time, reference <store>-EM-<YY>, signed by the user) plus
  // the remembered To / CC, so the office can copy it or send it from here.
  if (sub === "/remedials/email-draft" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const cert = await loadCert(String(q.get("certId") || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    const rec = shapeRow(cert); const cfg = await getConfig(env, tid);
    const code = padCode(cert.site_code || rec.siteCode) || "";
    const yr = String((cert.finalised_at || (rec.contractor && rec.contractor.date) || new Date().toISOString())).slice(0, 4).slice(-2);
    const reference = `${code}-EM-${yr}`;
    const hour = Number(new Date().toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).replace(/\D/g, "")) || 0;
    const greet = hour < 12 ? "Good morning" : "Good afternoon";
    let who = me; try { const u = await env.DB.prepare("SELECT first_name, last_name FROM users WHERE tenant_id=? AND username=?").bind(tid, me).first(); if (u && (u.first_name || u.last_name)) who = [u.first_name, u.last_name].filter(Boolean).join(" "); } catch {}
    const con = cfg.contractor || {};
    const body = `${greet},\n\nPlease see attached document showing batteries required and quantities. If you could please send us a quotation including delivery times and use reference ${reference}.\n\nKind regards,\n${who}\n${con.tradingTitle || "Mostlane"}`;
    const site = (rec.installation && rec.installation.name) || code;
    return json({ ok: true, to: cfg.supplierEmail || "", cc: cfg.supplierCc || "", supplierName: cfg.supplierName || "",
      subject: `Battery quotation request — ${reference}${site ? " (" + site + ")" : ""}`, body, reference, filename: `Battery enquiry ${reference}.pdf` }, {}, env, request);
  }

  // POST /certs/remedials/raise-lights {certId} — raise the works job for the
  // NOT-replaced LIGHT fittings NOW, without waiting for a client order (the £50/
  // light price is pre-agreed). Batteries keep the supplier/order pipeline.
  if (sub === "/remedials/raise-lights" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const certId = String(b.certId || b.id || "").trim();
    if (!certId) return error("Missing certId", 400, env, request);
    const jobId = await createRemedialJobForCert(env, tid, certId, "light");
    if (!jobId) return error("No light-fitting remedials to raise on this certificate.", 400, env, request);
    try { await env.DB.prepare("UPDATE em_remedial_acks SET lights_job_id=?, job_id=COALESCE(job_id,?) WHERE tenant_id=? AND cert_id=?").bind(jobId, jobId, tid, certId).run(); } catch {}
    return json({ ok: true, jobId }, {}, env, request);
  }

  // POST /certs/remedials/reissue {certId} — office: generate the CLEAN certificate
  // now (failures → Pass + "(Replaced)"), instead of waiting for the remedial job to
  // be marked complete. Lands in the review queue to finalise. Office only.
  if (sub === "/remedials/reissue" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const certId = String(b.certId || b.id || "").trim();
    if (!certId) return error("Missing certId", 400, env, request);
    const newId = await reissueCleanCert(env, tid, certId, ctx);
    if (!newId) return error("Nothing to reissue — this certificate has no failed fittings.", 400, env, request);
    return json({ ok: true, id: newId }, {}, env, request);
  }

  // GET /certs/remedials/flags — site codes with an OPEN case (not yet invoiced),
  // for the compliance chart's ⚠ triangle next to the EM date.
  if (sub === "/remedials/flags" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT site_code, SUM(fittings) AS fittings, SUM(charge) AS charge FROM em_remedial_acks WHERE tenant_id=? AND COALESCE(stage,'to_quote')<>'invoiced' GROUP BY site_code"
    ).bind(tid).all();
    const codes = {};
    (results || []).forEach(r => { const c = padCode(r.site_code); if (c) codes[c] = { fittings: r.fittings, charge: r.charge }; });
    return json({ ok: true, codes }, {}, env, request);
  }

  // Battery-supply enquiry PDF (office): every battery remedial for a cert (or a
  // whole site), with spec/qty/photos, to send the supplier for a price.
  // GET  /certs/remedials/supplier-pdf?certId= | ?code=   → application/pdf
  // POST /certs/remedials/supplier-email {certId|code}    → email it to the supplier
  if (sub === "/remedials/supplier-pdf" || sub === "/remedials/supplier-email") {
    if (!isOffice) return error("Office access required", 403, env, request);
    let certId = "", code = "", postBody = {};
    if (method === "POST") { postBody = await request.json().catch(() => ({})); certId = String(postBody.certId || "").trim(); code = String(postBody.code || "").trim(); }
    else { certId = String(q.get("certId") || "").trim(); code = String(q.get("code") || "").trim(); }
    const loadImgs = async (keys) => {
      const imgs = [];
      for (const k of (keys || []).slice(0, 4)) { const key = (k && k.key) || (typeof k === "string" ? k : ""); if (!key) continue;
        try { const o = env.JOB_FILES && await env.JOB_FILES.get(key); if (o) imgs.push(new Uint8Array(await o.arrayBuffer())); } catch {} }
      return imgs;
    };
    const items = []; let siteName = "", certNumber = "";
    if (certId) {
      // Read the battery remedials straight off the cert — works BEFORE finalise
      // (that's when the office needs a price to quote).
      const cert = await loadCert(certId);
      if (!cert) return error("Certificate not found", 404, env, request);
      const rec = shapeRow(cert);
      siteName = (rec.installation && rec.installation.name) || cert.site_code || "";
      certNumber = rec.certNumber || cert.cert_number || "";
      const batt = (rec.rows || []).filter(r => r.remedial && isRealRemedial(r.remedial) && r.remedial.kind === "battery");
      for (const r of batt) {
        const rem = r.remedial;
        items.push({ site: siteName, ref: (String(r.comments || "").trim()) || "Fitting", spec: rem.batterySpec || "", qty: rem.batteryQty || 0, note: rem.note || "", photos: await loadImgs(rem.photos) });
      }
    } else if (code) {
      const { results } = await env.DB.prepare("SELECT * FROM em_remedials WHERE tenant_id=? AND kind='battery' AND site_code=? ORDER BY created_at DESC LIMIT 300").bind(tid, padCode(code)).all();
      for (const r of (results || [])) {
        let ph = []; try { ph = JSON.parse(r.photos || "[]"); } catch {}
        if (!siteName) { siteName = r.site_name || r.site_code; certNumber = r.cert_number; }
        items.push({ site: r.site_name || r.site_code, ref: r.light_ref, spec: r.battery_spec || "", qty: r.battery_qty || 0, note: r.note || "", photos: await loadImgs(ph) });
      }
    } else return error("certId or code required", 400, env, request);
    if (!items.length) return error("No battery remedials found for this " + (certId ? "certificate" : "site") + ".", 404, env, request);
    const cfg = await getConfig(env, tid);
    let logo = null; try { logo = logoBytes(); } catch {}
    const bytes = buildBatteryEnquiryPdf(items, {
      logo, contractor: cfg.contractor, supplierName: cfg.supplierName, site: siteName, certNumber,
    });
    const fname = `Battery enquiry ${certNumber || code || certId}.pdf`;
    if (method === "GET") {
      return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fname}"`, "Cache-Control": "no-store", ...corsHeaders(env, request) } });
    }
    // POST → email to the supplier. The office can override To / CC / subject /
    // body per send; To + CC are REMEMBERED in the config for next time.
    const bodyIn = postBody || {};
    const toAddr = String(bodyIn.to || cfg.supplierEmail || "").trim();
    const ccAddr = String(bodyIn.cc != null ? bodyIn.cc : (cfg.supplierCc || "")).trim();
    if (!toAddr) return error("Enter the supplier's email address.", 400, env, request);
    if (toAddr !== cfg.supplierEmail || ccAddr !== (cfg.supplierCc || "")) { try { await saveConfig(env, tid, { ...cfg, supplierEmail: toAddr, supplierCc: ccAddr }); } catch {} }
    cfg.supplierEmail = toAddr;
    let b64 = ""; try { let s = ""; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); b64 = btoa(s); } catch {}
    const site = siteName || "site";
    const escH = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const customBody = String(bodyIn.body || "").trim();
    const r = await sendEmail(env, {
      to: cfg.supplierEmail, cc: ccAddr || undefined,
      subject: String(bodyIn.subject || "").trim() || `Battery supply enquiry — ${site} (${items.length} fitting${items.length === 1 ? "" : "s"})`,
      html: customBody
        ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escH(customBody)}</div>`
        : `<p>Hi${cfg.supplierName ? " " + escH(cfg.supplierName) : ""},</p><p>Please could you quote for the emergency-lighting batteries listed in the attached enquiry for <b>${escH(site)}</b>. Details, quantities and photos are in the PDF.</p>`,
      text: customBody || undefined,
      attachments: [{ filename: fname, content: b64 }],
    });
    if (!r || r.ok === false) return error((r && r.error) || "Couldn't send the email (check RESEND_API_KEY / supplier email).", 502, env, request);
    return json({ ok: true, sentTo: cfg.supplierEmail, fittings: items.length }, {}, env, request);
  }

  // ── Office uploads a replacement PDF instead of generating ────────────────────
  if (sub === "/upload" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    let form; try { form = await request.formData(); } catch { return error("multipart required", 400, env, request); }
    const cert = await loadCert(String(form.get("id") || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    const file = form.get("file");
    if (!file || typeof file === "string") return error("file required", 400, env, request);
    const code = padCode(cert.site_code);
    if (!code) return error("This certificate has no store code.", 400, env, request);
    const number = String(form.get("certNumber") || cert.cert_number || (await suggestNumber(env, tid, code, cert.type))).trim();
    const docDate = String(form.get("docDate") || "").trim() || new Date().toISOString().slice(0, 10);
    const buf = new Uint8Array(await file.arrayBuffer());
    const filed = await fileCertificatePdf(env, tid, {
      scheme: "coop", code, type: cert.type, bytes: buf,
      filename: `${code}_${cert.type.toUpperCase()}_${number}.pdf`, docDate, bump: true,
      source: "cert:" + cert.id, label: `${cert.type === "pat" ? "PAT" : "EM"} certificate ${number}`,
    });
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE certificates SET status='final', cert_number=?, r2_final_key=?, finalised_at=?, finalised_by=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(number, filed.key, now, me, now, tid, cert.id).run();
    return json({ ok: true, number, key: filed.key }, {}, env, request);
  }

  // ── Delete a draft (office, or the owning engineer while still a draft) ───────
  if (sub === "/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const cert = await loadCert(String(b.id || ""));
    if (!cert) return error("Certificate not found", 404, env, request);
    if (cert.status === "final") return error("A finalised certificate can't be deleted here.", 409, env, request);
    if (!isOffice && cert.engineer !== me) return error("Not your certificate", 403, env, request);
    await env.DB.prepare("DELETE FROM certificates WHERE tenant_id=? AND id=?").bind(tid, cert.id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── EICR 5-year certificate NUMBER register (office) ──────────────────────────
  // GET /certs/register — the whole register + the next number + sequence gaps
  // (numbers not yet used) + blanks (numbers with no job assigned).
  if (sub === "/register" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const { results } = await env.DB.prepare("SELECT number, job, source FROM cert_register WHERE tenant_id=? ORDER BY number").bind(tid).all();
    const rows = (results || []).map(r => ({ number: r.number, job: r.job || "", source: r.source || "" }));
    const nums = rows.map(r => r.number);
    const max = nums.length ? Math.max(...nums) : 0;
    const min = nums.length ? Math.min(...nums) : 0;
    const have = new Set(nums);
    const gaps = []; for (let n = min; n <= max; n++) if (!have.has(n)) gaps.push(n);
    const blanks = rows.filter(r => !String(r.job || "").trim()).map(r => r.number);
    return json({ ok: true, entries: rows, count: rows.length, min, max, next: max + 1, gaps, blanks }, {}, env, request);
  }
  // POST /certs/register {number, job} — add or edit one number's job.
  if (sub === "/register" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const number = parseInt(b.number, 10);
    if (!Number.isFinite(number) || number < 1 || number > 999999) return error("A valid number is required.", 400, env, request);
    const job = String(b.job || "").slice(0, 300);
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO cert_register (tenant_id,number,job,cert_type,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id,number) DO UPDATE SET job=excluded.job, updated_at=excluded.updated_at, updated_by=excluded.updated_by")
      .bind(tid, number, job, "fiveYear", now, now, me).run();
    return json({ ok: true, number, job }, {}, env, request);
  }
  // POST /certs/register/delete {number}
  if (sub === "/register/delete" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const number = parseInt(b.number, 10);
    if (!Number.isFinite(number)) return error("Missing number", 400, env, request);
    await env.DB.prepare("DELETE FROM cert_register WHERE tenant_id=? AND number=?").bind(tid, number).run();
    return json({ ok: true }, {}, env, request);
  }
  // POST /certs/register/auto {number, job} — auto-add a cert number read from a
  // certificate PDF (the compliance-check pass). Deliberately CONSERVATIVE: it
  // NEVER overwrites a number that already exists (INSERT OR IGNORE), so it can't
  // clobber a number the office typed; it only fills a genuinely-new number, and
  // stamps source='scan' so the register can flag it for a human to verify.
  if (sub === "/register/auto" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const number = parseInt(b.number, 10);
    // Only accept a clean, plausible register number (a whole number 1–99999);
    // anything else (a third-party ref with letters, a huge id) is left for the
    // office to add by hand rather than risk polluting the register.
    if (!Number.isFinite(number) || number < 1 || number > 99999) return json({ ok: true, added: false, reason: "out-of-range" }, {}, env, request);
    const job = String(b.job || "").slice(0, 300);
    const now = new Date().toISOString();
    const res = await env.DB.prepare("INSERT OR IGNORE INTO cert_register (tenant_id,number,job,cert_type,created_at,updated_at,updated_by,source) VALUES (?,?,?,?,?,?,?,?)")
      .bind(tid, number, job, "fiveYear", now, now, me, "scan").run();
    const added = !!(res && res.meta && res.meta.changes);
    return json({ ok: true, added, number }, {}, env, request);
  }
  // POST /certs/register/import — bulk load. Body {text} (one "number  job" per
  // line — a leading "(052)" note is ignored, a number-only line = blank job) OR
  // {entries:[{number,job}]}. Upserts; empty jobs never overwrite a set one.
  // {fillGaps:true} also inserts any missing sequence numbers as blank entries.
  if (sub === "/register/import" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    let entries = [];
    if (Array.isArray(b.entries)) {
      entries = b.entries.map(e => ({ number: parseInt(e.number, 10), job: String(e.job || "").slice(0, 300) })).filter(e => Number.isFinite(e.number));
    } else if (typeof b.text === "string") {
      for (const line of b.text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:\([^)]*\)\s*)?(\d{1,6})\b[\s.\-:)\t]*(.*)$/);
        if (!m) continue;
        entries.push({ number: parseInt(m[1], 10), job: String(m[2] || "").trim().slice(0, 300) });
      }
    }
    if (!entries.length) return error("Nothing to import — paste lines like '349<tab>Corsham Remedials'.", 400, env, request);
    const now = new Date().toISOString();
    let imported = 0;
    for (let i = 0; i < entries.length; i += 40) {
      const chunk = entries.slice(i, i + 40);
      await env.DB.batch(chunk.map(e => env.DB.prepare(
        // Keep an existing non-empty job if the incoming job is blank.
        "INSERT INTO cert_register (tenant_id,number,job,cert_type,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?) " +
        "ON CONFLICT(tenant_id,number) DO UPDATE SET job=CASE WHEN excluded.job<>'' THEN excluded.job ELSE cert_register.job END, updated_at=excluded.updated_at, updated_by=excluded.updated_by"
      ).bind(tid, e.number, e.job, "fiveYear", now, now, me)));
      imported += chunk.length;
    }
    // Optionally fill sequence gaps with blank placeholders so the register is contiguous.
    if (b.fillGaps) {
      const nums = entries.map(e => e.number);
      const min = Math.min(...nums), max = Math.max(...nums);
      const { results } = await env.DB.prepare("SELECT number FROM cert_register WHERE tenant_id=?").bind(tid).all();
      const have = new Set((results || []).map(r => r.number));
      const missing = []; for (let n = min; n <= max; n++) if (!have.has(n)) missing.push(n);
      for (let i = 0; i < missing.length; i += 40) {
        await env.DB.batch(missing.slice(i, i + 40).map(n => env.DB.prepare(
          "INSERT OR IGNORE INTO cert_register (tenant_id,number,job,cert_type,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?)"
        ).bind(tid, n, "", "fiveYear", now, now, me)));
      }
    }
    const row = await env.DB.prepare("SELECT MAX(number) AS mx, COUNT(*) AS n FROM cert_register WHERE tenant_id=?").bind(tid).first();
    return json({ ok: true, imported, count: row ? row.n : imported, next: (row && row.mx ? row.mx : 0) + 1 }, {}, env, request);
  }

  return error("Not found: " + url.pathname, 404, env, request);
}
