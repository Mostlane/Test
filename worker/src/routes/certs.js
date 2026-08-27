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
import { createOrUpdateJobFromPayload } from "./sla.js";

const TYPES = ["em", "pat"];
const T = t => (t === "pat" ? "pat" : "em");

const DEFAULT_CONFIG = {
  // Default client used to seed a NEW cert when the previous cert didn't supply one
  // (most EM/PAT work is Southern Co-op). Office-editable; the previous cert always
  // wins over this, and it's never applied over a value the office has typed.
  client: {
    name: "The Southern Co-op",
    address: "1000 Lakeside, Portsmouth",
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
  // Per-cert charge/quote acknowledgement — drives the office's blocking reminder
  // ("Have remedials been charged/quoted?") that re-pops every 4h until confirmed.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS em_remedial_acks (
    cert_id TEXT PRIMARY KEY, tenant_id TEXT, cert_number TEXT,
    site_code TEXT, site_name TEXT, fittings INTEGER, charge REAL,
    onsite INTEGER, pending INTEGER, state TEXT, snooze_until TEXT,
    created_at TEXT, done_at TEXT, done_by TEXT)`).run();
}
const REMEDIAL_CHARGE = 50;   // £ per failed EM fitting (replaced on site OR remedial)

// On finalise of an EM cert, log every failed fitting (£50 each) and — for the
// ones NOT replaced on site — raise ONE remedial SLA job for the office to
// schedule + charge. Idempotent per cert (safe to re-finalise). Returns a summary.
async function processEmRemedials(env, tid, rec, certRow, certNumber, siteCode) {
  if (rec.type !== "em") return null;
  const rows = Array.isArray(rec.rows) ? rec.rows : [];
  const fails = rows.map((r, i) => ({
    ref: (String(r.comments || "").trim()) || ("Light " + (i + 1)),
    replaced: !!(r.remedial && r.remedial.replacedOnSite === true),
    note: (r.remedial && r.remedial.note) || "",
    failed: !!(r.remedial && r.remedial.failed),
  })).filter(x => x.failed);
  if (!fails.length) {
    try { await env.DB.prepare("DELETE FROM em_remedials WHERE tenant_id=? AND cert_id=?").bind(tid, certRow.id).run(); } catch {}
    try { await env.DB.prepare("DELETE FROM em_remedial_acks WHERE tenant_id=? AND cert_id=?").bind(tid, certRow.id).run(); } catch {}
    return { count: 0 };
  }

  const siteName = (rec.installation && rec.installation.name) || (rec.client && rec.client.name) || siteCode;
  const now = new Date().toISOString();
  const pending = fails.filter(f => !f.replaced);
  const onsite = fails.filter(f => f.replaced);

  let jobId = null;
  if (pending.length) {
    const lines = pending.map(f => "• " + f.ref + (f.note ? " — " + f.note : "")).join("\n");
    const desc = `EM remedial — replace ${pending.length} failed emergency light fitting${pending.length === 1 ? "" : "s"} at ${siteName} (from EM certificate ${certNumber}).\n\n${lines}\n\nCharge: £${pending.length * REMEDIAL_CHARGE} (£${REMEDIAL_CHARGE}/fitting).`;
    try {
      const job = await createOrUpdateJobFromPayload(env, tid, {
        id: "emrem:" + certRow.id,               // stable id → idempotent per cert
        reference: "EM remedial — " + (siteCode || siteName),
        status: "Pending", priority: "Priority 4",
        description: desc, siteName, siteCode: siteCode || "",
        originator: "em-remedial",
      });
      jobId = job && job.id;
    } catch {}
  }

  try { await env.DB.prepare("DELETE FROM em_remedials WHERE tenant_id=? AND cert_id=?").bind(tid, certRow.id).run(); } catch {}
  const stmts = fails.map((f, i) => env.DB.prepare(
    `INSERT INTO em_remedials (id,tenant_id,cert_id,cert_number,site_code,site_name,light_ref,note,replaced_on_site,charge,status,job_id,engineer,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(certRow.id + ":" + i, tid, certRow.id, certNumber, siteCode || "", siteName, f.ref, f.note,
    f.replaced ? 1 : 0, REMEDIAL_CHARGE, f.replaced ? "done" : "pending", f.replaced ? null : jobId,
    certRow.engineer || "", now));
  try { for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20)); } catch {}

  // Open (or re-open) the per-cert charge/quote reminder. Re-finalising resets it
  // to open with fresh counts so the office is prompted again if the split changed.
  try {
    await env.DB.prepare(
      `INSERT INTO em_remedial_acks (cert_id,tenant_id,cert_number,site_code,site_name,fittings,charge,onsite,pending,state,snooze_until,created_at,done_at,done_by)
       VALUES (?,?,?,?,?,?,?,?,?,'open',NULL,?,NULL,NULL)
       ON CONFLICT(cert_id) DO UPDATE SET cert_number=excluded.cert_number, site_code=excluded.site_code,
         site_name=excluded.site_name, fittings=excluded.fittings, charge=excluded.charge,
         onsite=excluded.onsite, pending=excluded.pending, state='open', snooze_until=NULL, done_at=NULL, done_by=NULL`
    ).bind(certRow.id, tid, certNumber, siteCode || "", siteName, fails.length, fails.length * REMEDIAL_CHARGE,
      onsite.length, pending.length, now).run();
  } catch {}

  return { count: fails.length, onsite: onsite.length, pending: pending.length, charge: fails.length * REMEDIAL_CHARGE, jobId };
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
async function suggestNumber(env, tid, code, type) {
  if (type === "pat") { const n = await nextPatNumber(env, tid); return String(n).padStart(4, "0") + "-" + yy(); }
  return (await emSetFor(env, tid, code)) + "-" + yy();
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
      };
      await saveConfig(env, tid, next);
      return json({ ok: true, config: next }, {}, env, request);
    }
  }

  // ── Suggested next number ────────────────────────────────────────────────────
  if (sub === "/number" && method === "GET") {
    return json({ ok: true, number: await suggestNumber(env, tid, q.get("code"), T(q.get("type"))) }, {}, env, request);
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
    const existing = await env.DB.prepare(
      "SELECT * FROM certificates WHERE tenant_id=? AND job_id=? AND type=? ORDER BY created_at DESC LIMIT 1"
    ).bind(tid, jobId, type).first();
    const config = await getConfig(env, tid);
    if (existing) return json({ ok: true, record: shapeRow(existing), config, seeded: false }, {}, env, request);

    // seed a fresh draft from the job's site + config + prefill rows
    const job = await getJob(env, tid, jobId);
    const code = job ? (job.siteCode || "") : "";
    const siteRow = code ? await env.DB.prepare("SELECT site_name, postcode, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, String(code)).first() : null;
    let siteData = {}; try { siteData = siteRow && siteRow.data ? JSON.parse(siteRow.data) : {}; } catch {}
    const pre = await prefillFromPrevious(env, tid, code, type);
    const h = pre.header;
    const record = {
      id: null, type, status: "draft", jobId, siteCode: code, certNumber: "",
      // Client: transfer from the previous cert; NEVER invented. Blank until the
      // office fills it once (then it chains forward on every future cert).
      client: (h && h.client) ? h.client : (config.client || { name: "", address: "", postcode: "" }),
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
      // cert's trading block; engineer name/date always blank (per-visit).
      contractor: { ...config.contractor, ...((h && h.contractor) || {}), name: "", position: "Engineer", date: "" },
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

    const data = {
      client: b.client || {}, installation: b.installation || {},
      extent: b.extent || "", comments: b.comments || "", declaration: b.declaration || "",
      contractor: b.contractor || {}, rows: Array.isArray(b.rows) ? b.rows.slice(0, 500) : [],
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
    const rec = shapeRow(cert);
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
    return json({ ok: true, record: shapeRow(cert), config: await getConfig(env, tid) }, {}, env, request);
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
    const rec = shapeRow(cert);
    const code = padCode(cert.site_code || rec.siteCode);
    if (!code) return error("This certificate has no store code — set the site first.", 400, env, request);
    const number = String(b.certNumber || cert.cert_number || (await suggestNumber(env, tid, code, cert.type))).trim();
    const docDate = String(b.docDate || (rec.contractor && rec.contractor.date) || "").trim() || new Date().toISOString().slice(0, 10);
    rec.certNumber = number; rec.status = "final";
    const sig = dataUrlToBytes(rec.signature);
    let logo = null; try { logo = logoBytes(); } catch {}
    const bytes = buildCertPdf(rec, { logo, signature: sig });
    const filed = await fileCertificatePdf(env, tid, {
      scheme: "coop", code, type: cert.type, bytes,
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
      const body = `EM cert ${number} — ${site}: ${remedial.count} fitting${remedial.count === 1 ? "" : "s"} failed (£${remedial.charge} to charge). ${remedial.onsite} replaced on site` + (remedial.pending ? `, ${remedial.pending} remedial job raised.` : ".");
      const url = remedial.jobId ? ("/job-view.html?jobId=" + encodeURIComponent(remedial.jobId)) : "/cert-review.html";
      ctx?.waitUntil?.(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], { title: "EM remedial to charge", body, url, tag: "em-remedial:" + cert.id }).catch(() => {}));
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

  // GET /certs/remedials/outstanding — open charge/quote acks that are DUE now
  // (never snoozed, or the 4h snooze has passed). Drives the office blocking gate.
  if (sub === "/remedials/outstanding" && method === "GET") {
    if (!isOffice) return json({ ok: true, remedials: [] }, {}, env, request);
    const now = new Date().toISOString();
    const { results } = await env.DB.prepare(
      "SELECT * FROM em_remedial_acks WHERE tenant_id=? AND state='open' AND (snooze_until IS NULL OR snooze_until<=?) ORDER BY created_at ASC LIMIT 50"
    ).bind(tid, now).all();
    return json({ ok: true, remedials: (results || []).map(r => ({
      certId: r.cert_id, certNumber: r.cert_number, siteName: r.site_name || r.site_code, siteCode: r.site_code,
      fittings: r.fittings, charge: r.charge, onsite: r.onsite, pending: r.pending,
    })) }, {}, env, request);
  }

  // POST /certs/remedials/ack {certId, action:"done"|"later"} — confirm charged/
  // quoted (clears it), or snooze the reminder for 4 hours.
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
    await env.DB.prepare("UPDATE em_remedial_acks SET state='done', done_at=?, done_by=?, snooze_until=NULL WHERE tenant_id=? AND cert_id=?").bind(now, me, tid, certId).run();
    return json({ ok: true, done: true }, {}, env, request);
  }

  // GET /certs/remedials/flags — site codes with an OPEN ack, for the compliance
  // chart's ⚠ triangle next to the EM date.
  if (sub === "/remedials/flags" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT site_code, SUM(fittings) AS fittings, SUM(charge) AS charge FROM em_remedial_acks WHERE tenant_id=? AND state='open' GROUP BY site_code"
    ).bind(tid).all();
    const codes = {};
    (results || []).forEach(r => { const c = padCode(r.site_code); if (c) codes[c] = { fittings: r.fittings, charge: r.charge }; });
    return json({ ok: true, codes }, {}, env, request);
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
