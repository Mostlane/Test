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
  for (const col of ["kind TEXT", "battery_spec TEXT", "battery_qty INTEGER", "photos TEXT"]) {
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
    "approved_at TEXT", "approved_by TEXT", "invoiced_at TEXT", "invoiced_by TEXT"]) {
    try { await env.DB.prepare(`ALTER TABLE em_remedial_acks ADD COLUMN ${col}`).run(); } catch {}
  }
}
const STAGES = ["to_quote", "quoted", "approved", "invoiced"];
const REMEDIAL_CHARGE = 50;   // £ per failed EM LIGHT (batteries are priced by the supplier, no £50)

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
      ref: (String(r.comments || "").trim()) || ("Light " + (i + 1)),
      replaced: rem.replacedOnSite === true,
      note: rem.note || "",
      failed: !!rem.failed,
      kind,
      batterySpec: kind === "battery" ? String(rem.batterySpec || "") : "",
      batteryQty: kind === "battery" ? (Number(rem.batteryQty) || 0) : 0,
      photos: (kind === "battery" && Array.isArray(rem.photos)) ? rem.photos.map(p => (p && p.key) || (typeof p === "string" ? p : "")).filter(Boolean) : [],
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
  const lightCharge = lights.length * REMEDIAL_CHARGE;   // £50/light; batteries priced by supplier

  // Log every fitting. NOTE: the remedial SLA JOB is NOT raised here — it's raised
  // when the client's ORDER comes in (the "approved" stage), listing what to do.
  try { await env.DB.prepare("DELETE FROM em_remedials WHERE tenant_id=? AND cert_id=?").bind(tid, certRow.id).run(); } catch {}
  const stmts = fails.map((f, i) => env.DB.prepare(
    `INSERT INTO em_remedials (id,tenant_id,cert_id,cert_number,site_code,site_name,light_ref,note,replaced_on_site,charge,status,job_id,engineer,created_at,kind,battery_spec,battery_qty,photos)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(certRow.id + ":" + i, tid, certRow.id, certNumber, siteCode || "", siteName, f.ref, f.note,
    f.replaced ? 1 : 0, isBatt(f) ? 0 : REMEDIAL_CHARGE, f.replaced ? "done" : "pending", null,
    certRow.engineer || "", now, f.kind, f.batterySpec, f.batteryQty, JSON.stringify(f.photos)));
  try { for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20)); } catch {}

  // Open (or re-open) the per-cert case at stage `to_quote` (the one blocking
  // stage). Re-finalising resets it so the office is prompted again if it changed.
  try {
    await env.DB.prepare(
      `INSERT INTO em_remedial_acks (cert_id,tenant_id,cert_number,site_code,site_name,fittings,charge,onsite,pending,batteries,state,stage,snooze_until,created_at,done_at,done_by,job_id,quoted_at,quoted_by,approved_at,approved_by,invoiced_at,invoiced_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,'open','to_quote',NULL,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)
       ON CONFLICT(cert_id) DO UPDATE SET cert_number=excluded.cert_number, site_code=excluded.site_code,
         site_name=excluded.site_name, fittings=excluded.fittings, charge=excluded.charge,
         onsite=excluded.onsite, pending=excluded.pending, batteries=excluded.batteries, state='open',
         stage='to_quote', snooze_until=NULL, done_at=NULL, done_by=NULL, job_id=NULL,
         quoted_at=NULL, quoted_by=NULL, approved_at=NULL, approved_by=NULL, invoiced_at=NULL, invoiced_by=NULL`
    ).bind(certRow.id, tid, certNumber, siteCode || "", siteName, fails.length, lightCharge,
      onsite.length, pending.length, batteries.length, now).run();
  } catch {}

  return { count: fails.length, onsite: onsite.length, pending: pending.length, charge: lightCharge, batteries: batteries.length, lights: lights.length };
}

// Raise the remedial SLA job for a cert (called when the client's order lands).
// Lists the NOT-replaced fittings — lights to replace + batteries to fit.
async function createRemedialJobForCert(env, tid, certId) {
  const { results } = await env.DB.prepare("SELECT * FROM em_remedials WHERE tenant_id=? AND cert_id=? AND status='pending'").bind(tid, certId).all();
  const pend = results || [];
  if (!pend.length) return null;
  const first = pend[0];
  const siteName = first.site_name || first.site_code, siteCode = first.site_code || "";
  const lights = pend.filter(r => r.kind !== "battery"), batts = pend.filter(r => r.kind === "battery");
  const parts = [];
  if (lights.length) parts.push(`Replace ${lights.length} failed light fitting${lights.length === 1 ? "" : "s"} (£${lights.length * REMEDIAL_CHARGE}):\n` + lights.map(r => "• " + r.light_ref + (r.note ? " — " + r.note : "")).join("\n"));
  if (batts.length) parts.push(`Replace batteries in ${batts.length} fitting${batts.length === 1 ? "" : "s"}:\n` + batts.map(r => "• " + r.light_ref + (r.battery_spec ? " — " + r.battery_spec : "") + (r.battery_qty ? " ×" + r.battery_qty : "") + (r.note ? " — " + r.note : "")).join("\n"));
  const desc = `EM remedial at ${siteName} (from EM certificate ${first.cert_number}) — client ordered.\n\n` + parts.join("\n\n");
  try {
    const job = await createOrUpdateJobFromPayload(env, tid, {
      id: "emrem:" + certId, reference: "EM remedial — " + (siteCode || siteName),
      status: "Pending", priority: "Priority 4", description: desc, siteName, siteCode, originator: "em-remedial",
    });
    return job && job.id;
  } catch { return null; }
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

// Carry an item list forward for a NEW visit: keep each item's IDENTITY
// (position/description/appliance/location/class) and default every result to
// Pass — the engineer just taps any that failed. Measurements (earth/insulation)
// are blanked so they're re-read on site.
function carryRows(rows, type) {
  return (rows || []).map((r, i) => type === "pat"
    ? { no: i + 1, appliance: r.appliance || "", location: r.location || "", cls: r.cls || "I", visual: "Pass", earth: "", insulation: "", result: "Pass", comments: r.comments || "" }
    : { no: i + 1, comments: r.comments || "", normal: "Pass", led: "Pass", emergency: "Pass", battery: r.battery || 180 });
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
async function suggestNumber(env, tid, code, type, opts = {}) {
  if (type === "pat") { const n = await nextPatNumber(env, tid); return String(n).padStart(4, "0") + "-" + yy(); }
  const set = await emSetFor(env, tid, code);
  // Monthly EM (Fareham flick test): <set/code>-<MM>-<YY> so all 12 in a year differ.
  if (opts.kind === "monthly") return set + "-" + monthYY(opts.date);
  return set + "-" + yy();
}

function shapeRow(cert) {
  let d = {}; try { d = JSON.parse(cert.data) || {}; } catch {}
  return {
    id: cert.id, type: cert.type, status: cert.status, jobId: cert.job_id, siteCode: cert.site_code,
    certNumber: cert.cert_number, engineer: cert.engineer, createdAt: cert.created_at, updatedAt: cert.updated_at,
    submittedAt: cert.submitted_at, finalisedAt: cert.finalised_at, finalisedBy: cert.finalised_by,
    ...d,
  };
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
  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/certs(?=\/|$)/, "") || "/";
  const q = url.searchParams;
  await ensureTables(env);

  const perms = await permissionsFor(env, tid, me);
  const isOffice = perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes" || perms.Compliance === "Yes";

  const loadCert = async (id) => env.DB.prepare("SELECT * FROM certificates WHERE tenant_id=? AND id=?").bind(tid, id).first();

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
    // only the office or the engineer who owns the draft may write it
    if (existing && !isOffice && existing.engineer !== me) return error("Not your certificate", 403, env, request);
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
    if (!isOffice && cert.engineer !== me) return error("Not your certificate", 403, env, request);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE certificates SET status='review', submitted_at=?, updated_at=? WHERE tenant_id=? AND id=?").bind(now, now, tid, cert.id).run();
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
      ctx?.waitUntil?.(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], payload, me).catch(() => {}));
    }
    return json({ ok: true }, {}, env, request);
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
    const rows = (await env.DB.prepare(
      "SELECT * FROM certificates WHERE tenant_id=? AND status IN ('draft','review') ORDER BY COALESCE(submitted_at,updated_at) DESC LIMIT 300"
    ).bind(tid).all()).results || [];
    return json({ ok: true, certs: rows.map(shapeRow) }, {}, env, request);
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
    if (cert.engineer && cert.engineer !== me) ctx?.waitUntil?.(sendToUser(env, tid, cert.engineer, { title: "Certificate issued", body: `Your ${cert.type === "pat" ? "PAT" : "EM"} certificate ${number} has been reviewed and filed.`, url: "/eicr-portal.html", tag: "cert-final:" + cert.id }).catch(() => {}));
    // EM remedials: log the £50/fitting failures + raise a remedial job for the
    // not-replaced ones, and tell the office so they can charge for the works.
    let remedial = null;
    try { remedial = await processEmRemedials(env, tid, rec, cert, number, code); } catch {}
    if (remedial && remedial.count) {
      const site = (rec.installation && rec.installation.name) || code;
      const body = `EM cert ${number} — ${site}: ${remedial.count} fitting${remedial.count === 1 ? "" : "s"} failed` + (remedial.charge ? ` (£${remedial.charge} in lights)` : "") + (remedial.batteries ? `, ${remedial.batteries} needing batteries` : "") + `. Quote the client — track it on the EM remedials list.`;
      ctx?.waitUntil?.(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], { title: "EM remedial to quote", body, url: "/cert-review.html", tag: "em-remedial:" + cert.id }).catch(() => {}));
    }
    return json({ ok: true, number, key: filed.key, remedial }, {}, env, request);
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

  const shapeCase = r => ({
    certId: r.cert_id, certNumber: r.cert_number, siteName: r.site_name || r.site_code, siteCode: r.site_code,
    fittings: r.fittings, charge: r.charge, onsite: r.onsite, pending: r.pending, batteries: r.batteries || 0,
    stage: r.stage || "to_quote", jobId: r.job_id || null, createdAt: r.created_at,
    quotedAt: r.quoted_at, approvedAt: r.approved_at, invoicedAt: r.invoiced_at,
  });

  // GET /certs/remedials/outstanding — cases still at the BLOCKING `to_quote` stage
  // that are due now (never snoozed, or the 4h snooze has passed). Drives the gate.
  if (sub === "/remedials/outstanding" && method === "GET") {
    if (!isOffice) return json({ ok: true, remedials: [] }, {}, env, request);
    const now = new Date().toISOString();
    const { results } = await env.DB.prepare(
      "SELECT * FROM em_remedial_acks WHERE tenant_id=? AND COALESCE(stage,'to_quote')='to_quote' AND (snooze_until IS NULL OR snooze_until<=?) ORDER BY created_at ASC LIMIT 50"
    ).bind(tid, now).all();
    return json({ ok: true, remedials: (results || []).map(shapeCase) }, {}, env, request);
  }

  // GET /certs/remedials/board — the continuous tracking list. Every OPEN case
  // (not yet invoiced) with its stage, so nothing is forgotten. ?all=1 includes invoiced.
  if (sub === "/remedials/board" && method === "GET") {
    if (!isOffice) return json({ ok: true, cases: [] }, {}, env, request);
    const all = q.get("all") === "1";
    const { results } = await env.DB.prepare(
      `SELECT * FROM em_remedial_acks WHERE tenant_id=?${all ? "" : " AND COALESCE(stage,'to_quote')<>'invoiced'"} ORDER BY created_at DESC LIMIT 400`
    ).bind(tid).all();
    return json({ ok: true, cases: (results || []).map(shapeCase) }, {}, env, request);
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
    if (to === "approved") {
      jobId = await createRemedialJobForCert(env, tid, certId);   // null when nothing to schedule (all on site)
      await env.DB.prepare("UPDATE em_remedial_acks SET stage='approved', approved_at=?, approved_by=?, job_id=COALESCE(?,job_id) WHERE tenant_id=? AND cert_id=?").bind(now, me, jobId, tid, certId).run();
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
    let certId = "", code = "";
    if (method === "POST") { const b = await request.json().catch(() => ({})); certId = String(b.certId || "").trim(); code = String(b.code || "").trim(); }
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
      const batt = (rec.rows || []).filter(r => r.remedial && r.remedial.failed && r.remedial.kind === "battery");
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
    // POST → email to the supplier
    if (!cfg.supplierEmail) return error("Set a supplier email first (cert-review → 📧 Supplier).", 400, env, request);
    let b64 = ""; try { let s = ""; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); b64 = btoa(s); } catch {}
    const site = siteName || "site";
    const escH = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const r = await sendEmail(env, {
      to: cfg.supplierEmail,
      subject: `Battery supply enquiry — ${site} (${items.length} fitting${items.length === 1 ? "" : "s"})`,
      html: `<p>Hi${cfg.supplierName ? " " + escH(cfg.supplierName) : ""},</p><p>Please could you quote for the emergency-lighting batteries listed in the attached enquiry for <b>${escH(site)}</b>. Details, quantities and photos are in the PDF.</p><p>Many thanks,<br>${escH((cfg.contractor && cfg.contractor.tradingTitle) || "Mostlane")}</p>`,
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

  return error("Not found: " + url.pathname, 404, env, request);
}
