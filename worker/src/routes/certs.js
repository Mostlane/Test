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

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { buildCertPdf } from "../lib/certpdf.js";
import { logoBytes } from "../lib/logo.js";
import { pdfExtractText } from "../lib/pdftext.js";
import { fileCertificatePdf } from "./compliance.js";
import { sendToUser, sendToPermission } from "./push.js";

const TYPES = ["em", "pat"];
const T = t => (t === "pat" ? "pat" : "em");

const DEFAULT_CONFIG = {
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
};

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY, tenant_id TEXT, type TEXT, status TEXT,
    job_id TEXT, site_code TEXT, cert_number TEXT,
    data TEXT, engineer TEXT,
    created_at TEXT, updated_at TEXT, submitted_at TEXT,
    finalised_at TEXT, finalised_by TEXT, r2_final_key TEXT)`).run();
}

async function getConfig(env, tid) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "cert:config:" + tid).first();
  let c = null; try { c = row ? JSON.parse(row.value) : null; } catch {}
  if (!c || typeof c !== "object") return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return {
    contractor: { ...DEFAULT_CONFIG.contractor, ...(c.contractor || {}) },
    em: { ...DEFAULT_CONFIG.em, ...(c.em || {}) },
    pat: { ...DEFAULT_CONFIG.pat, ...(c.pat || {}) },
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
// The valuable carry-forward is the ROW LIST (each luminaire's position/comment),
// so a monthly re-test is a re-confirm not a retype. Client/installation come
// from the portal site; contractor + boilerplate from config.
function parseEmRows(txt) {
  if (!txt) return [];
  // rows look like: "12 Pass Pass Pass 180 600x600"  (No. | Normal | LED | Emergency | Battery | Comments)
  const rows = [];
  const re = /\b(\d{1,3})\s+(Pass|Fail|N\/?A)\s+(Pass|Fail|N\/?A)\s+(Pass|Fail|N\/?A)\s+(\d{1,4})\s+(.*?)(?=\s+\d{1,3}\s+(?:Pass|Fail|N\/?A)\s+(?:Pass|Fail|N\/?A)\b|\s+www\.|\s+Tysoft|\s+EMERGENCY LIGHTING|$)/gi;
  let m;
  while ((m = re.exec(txt))) {
    rows.push({ no: Number(m[1]), normal: cap(m[2]), led: cap(m[3]), emergency: cap(m[4]), battery: m[5], comments: (m[6] || "").trim().slice(0, 80) });
    if (rows.length > 400) break;
  }
  // de-dupe by No. (page footers can repeat) keeping first
  const seen = new Set(); const out = [];
  for (const r of rows) { if (seen.has(r.no)) continue; seen.add(r.no); out.push(r); }
  out.sort((a, b) => a.no - b.no);
  return out;
}
function parsePatRows(txt) {
  if (!txt) return [];
  // PAT layouts vary; best-effort — capture "<no> <desc…> … <Pass|Fail>".
  const rows = [];
  const re = /\b(\d{1,3})\s+(.{2,60}?)\s+(Pass|Fail)\b/gi;
  let m; const seen = new Set();
  while ((m = re.exec(txt))) {
    const no = Number(m[1]); if (seen.has(no)) continue; seen.add(no);
    rows.push({ no, appliance: (m[2] || "").trim().slice(0, 60), location: "", cls: "", visual: "", earth: "", insulation: "", result: cap(m[3]), comments: "" });
    if (rows.length > 400) break;
  }
  rows.sort((a, b) => a.no - b.no);
  return rows;
}
const cap = s => { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase().replace("n/a", "N/A") : s; };

// Carry an item list forward for a NEW visit: keep each item's IDENTITY
// (position/description/appliance/location/class) but BLANK the test results and
// measurements so the engineer actively re-confirms every one on site.
function carryRows(rows, type) {
  return (rows || []).map((r, i) => type === "pat"
    ? { no: i + 1, appliance: r.appliance || "", location: r.location || "", cls: r.cls || "", visual: "", earth: "", insulation: "", result: "", comments: r.comments || "" }
    : { no: i + 1, comments: r.comments || "", normal: "", led: "", emergency: "", battery: r.battery || 180 });
}
async function latestCertR2Key(env, tid, code, type) {
  try {
    const row = await env.DB.prepare(
      "SELECT r2_key FROM compliance_files WHERE tenant_id=? AND code=? AND type=? ORDER BY COALESCE(doc_date,uploaded_at) DESC LIMIT 1"
    ).bind(tid, padCode(code), type).first();
    return row ? row.r2_key : null;
  } catch { return null; }
}
async function prefillRows(env, tid, code, type) {
  const c4 = padCode(code);
  // 1) Prefer the most recent PORTAL certificate (structured rows — clean, no
  //    PDF parsing, and it chains forward year on year).
  try {
    const prev = await env.DB.prepare(
      "SELECT data FROM certificates WHERE tenant_id=? AND site_code=? AND type=? AND status='final' ORDER BY COALESCE(finalised_at,updated_at) DESC LIMIT 1"
    ).bind(tid, c4, type).first();
    if (prev) {
      let d = {}; try { d = JSON.parse(prev.data) || {}; } catch {}
      if (Array.isArray(d.rows) && d.rows.length) return { rows: carryRows(d.rows, type), from: "last certificate", source: "portal" };
    }
  } catch {}
  // 2) Fall back to the previous (legacy Tysoft) cert PDF on the compliance chart.
  const key = await latestCertR2Key(env, tid, c4, type);
  if (!key || !env.JOB_FILES) return { rows: [], from: null };
  try {
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return { rows: [], from: null };
    const buf = await obj.arrayBuffer();
    if (buf.byteLength > 6 * 1024 * 1024) return { rows: [], from: null };
    const txt = await pdfExtractText(buf);
    const parsed = type === "pat" ? parsePatRows(txt) : parseEmRows(txt);
    return { rows: carryRows(parsed, type), from: key.split("/").pop(), source: "pdf" };
  } catch { return { rows: [], from: null }; }
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
        contractor: { ...cur.contractor, ...(b.contractor || {}) },
        em: { ...cur.em, ...(b.em || {}) },
        pat: { ...cur.pat, ...(b.pat || {}) },
      };
      await saveConfig(env, tid, next);
      return json({ ok: true, config: next }, {}, env, request);
    }
  }

  // ── Suggested next number ────────────────────────────────────────────────────
  if (sub === "/number" && method === "GET") {
    return json({ ok: true, number: await suggestNumber(env, tid, q.get("code"), T(q.get("type"))) }, {}, env, request);
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
    const pre = await prefillRows(env, tid, code, type);
    const record = {
      id: null, type, status: "draft", jobId, siteCode: code, certNumber: "",
      client: { name: "The Southern Co-op", address: "", postcode: "" },
      installation: {
        name: (job && job.siteName) || (siteRow && siteRow.site_name) || "",
        address: (job && job.address) || (siteData.address || ""),
        postcode: (job && job.postcode) || (siteRow && siteRow.postcode) || "",
      },
      extent: config[type].extent,
      comments: config[type].comments,
      declaration: config[type].declaration,
      contractor: { ...config.contractor, name: "", position: "Engineer", date: "" },
      rows: pre.rows,
      signature: "",
    };
    return json({ ok: true, record, config, seeded: true, prefilledFrom: pre.from, prefilledRows: pre.rows.length }, {}, env, request);
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
    // notify the office review queue
    ctx?.waitUntil?.(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], {
      title: (cert.type === "pat" ? "PAT" : "EM") + " certificate ready to review",
      body: `${me} submitted a certificate for review.`, url: "/cert-review.html", tag: "cert-review:" + cert.id,
    }, me).catch(() => {}));
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
    return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${(rec.certNumber || cert.id)}.pdf"`, "Cache-Control": "no-store" } });
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
    return json({ ok: true, number, key: filed.key }, {}, env, request);
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
