// Portal-native Sump Pump Monthly Maintenance. A "🚰 Pump Maintenance" SLA job
// carries a store id (job.pumpStore); the engineer fills that store's set form on
// the job — a required safety pre-check, the store's location/method instructions,
// the monthly Yes/No/N-A checklist, a "details of any No" box, photo AND video
// uploads, then engineer + store-DM signatures — and submits it. That saves a
// DRAFT for OFFICE REVIEW, where the office edits anything and FINALISEs → a
// Mostlane-branded PDF (lib/pumppdf.js) is drawn and filed to the site's Documents.
// Six stores are seeded from the Jotform (Binfield, Wickham, Eastbourne, Shanklin,
// Wimbledon, Newport ELS); each store's checklist + instructions are editable.
//
//   GET  /pump/config                     whole config (seeds on first read)
//   POST /pump/config                     save config (office)
//   GET  /pump/stores                     [{id,name,siteCode}] for the Add-Job picker
//   GET  /pump/for-job?jobId=&store=      load/seed the job's record (+ store template)
//   POST /pump/save                       upsert a draft (engineer or office)
//   POST /pump/submit  {id}               engineer: submit for office review
//   POST /pump/media   (multipart)        upload a photo/video to a record
//   POST /pump/media-delete {id,key}      remove one
//   GET  /pump/media?key=&exp=&sig=       PUBLIC signed inline stream (photo/video)
//   GET  /pump/one?id=                    one record (office or owner)
//   GET  /pump/review                     office queue: drafts + submitted
//   GET  /pump/list?store=                a store's finalised history (office)
//   GET  /pump/pdf?id=                    render the record PDF (office or owner)
//   POST /pump/finalise {id}              office: draw PDF + file to the site
//   POST /pump/upload   (multipart)       office: file a replacement PDF
//   POST /pump/delete   {id}              office
//
// Table (self-migrating): pump_records.  Config: app_config pump:config:<tid>.
import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { buildPumpPdf } from "../lib/pumppdf.js";
import { logoBytes } from "../lib/logo.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { sendToUser, sendToPermission } from "./push.js";
import { fileCertificatePdf } from "./compliance.js";
import { decodePngToRgb } from "../lib/pngdecode.js";
import { onceMigration } from "../lib/once.js";

const GENERAL = [
  "Chamber free of debris or obstructions", "Water level within expected range when idle",
  "Pump body free from corrosion or damage", "Electrical cables undamaged and away from water",
  "Discharge pipe secure and supported", "Float switch activates pump when lifted",
  "Pump runs smoothly with no unusual noise/vibration", "Water discharges fully through outlet",
  "Pump switches off automatically after emptying", "Discharge outlet clear of blockages or freezing",
  "Non-return/check valve prevents backflow (where Fitted)", "Sump chamber inlet screen free of debris",
  "Inspection details recorded in log",
];
const BINFIELD_CHECKS = [
  "Chamber free of debris or obstructions", "Water level within expected range when idle",
  "Pump body free from corrosion or damage", "Electrical cables undamaged and away from water",
  "Discharge pipe secure and supported", "Float switch activates pump when lifted",
  "Pump runs smoothly with no unusual noise/vibration", "Water discharges fully through outlet",
  "Pump switches off automatically after emptying", "Discharge outlet clear of blockages or freezing",
  "Non-return/check valve prevents backflow", "Sump chamber inlet screen free of debris",
  "Control panel or alarm system functioning", "Inspection details recorded in log",
];
const WICKHAM_CHECKS = BINFIELD_CHECKS.concat([
  "Water Pumping into ditch", "Ditch inlet & outlet clear from debris",
  "Ditch generally tidy of debris", "CCTV receiving power",
]);

const INSTR = {
  binfield: "The pump is located in the basement in the BOH area.\nBarriers must be set up around the hatch and all staff notified of the works being carried out.\n\nPriming the pump:\n- Fill buckets from the store's tap (approx. 2 buckets) and pour into the sump.\n- This will prime the pump, which will then discharge through the plastic pipe into the waste.\n\nAlarm float switch:\n- Located in the basement, above the pump.\n- Tilting it should activate the alarm inside the Co-op building (warehouse).\n- This switch is set high to act as an early warning if the pump fails and water rises too high.\n- This gives the store time to move stock before flooding occurs.\n\nImportant: Always leave both the pump and the alarm float switch in their correct positions after maintenance.",
  wickham: "The sump pump is in the rear garden of the store, under a manhole in the grass (approx. 5 m deep).\nAccessing the pump: pull it up carefully using the rope, then lower it back down slowly after checks.\n\nPriming the pump:\n- Fill buckets from the store's tap (approx. 5 buckets) and pour into the sump.\n- This will prime the pump, which will then discharge through the plastic pipe into the ditch at the top of the land.\n\nDitch maintenance:\n- Clear all debris from both ends of the ditch to maintain flow.\n- Remove any debris along the ditch length as well.\n\nAlarm float switch:\n- Located in the manhole, above the pump.\n- Tilting it should activate the alarm inside the Co-op building (just inside the rear doors).\n- This switch is set high to act as an early warning if the pump fails and water rises too high.\n- This gives the store time to move stock before flooding occurs.\n\nImportant: Always leave both the pump and the alarm float switch in their correct positions after maintenance.",
  eastbourne: "The pump is located in the basement in the BOH area.\nBarriers must be set up around the hatch and all staff notified of the works being carried out.\n\nPriming the pump:\n- Fill buckets from the store's tap (approx. 2 buckets) and pour into the sump.\n- This will prime the pump, which will then discharge through the plastic pipe into the waste.\n\nImportant: Always leave both the pump and the alarm float switch in their correct positions after maintenance.",
  shanklin: "The sump pump is in the basement in the BOH area of the store.\n\nPriming the pump:\n- Fill buckets from the store's tap (approx. 2 buckets) and pour into the sump.\n- This will prime the pump, which will then discharge through the plastic pipe into the ditch at the top of the land.\n\nElectrical Cut Off switch:\n- Located on the wall, above the pump.\n- Tilting it should activate the contactors above the basement and cut all 230v electricity to the lighting and tube heaters.\n- When the float switch is released, the contactor should re-engage and bring the 230v power back on.\n\nImportant: Always leave both the pump and the alarm float switch in their correct positions after maintenance.",
  wimbledon: "There are two pumps to test in this store.\n\nFirst pump - located in a hatch in the staff room.\n- Remove the skirting and lift the hatch to access.\n- This area must be shut off while the hatch is open and all staff notified of the risk.\n\nSecond pump - located in the rear area of the store basement (not occupied by Co-op).\n- Key can be acquired via the store manager.\n- Walk inside the unit, turn back on yourself, and you will see the pump.\n\nPriming the pump:\n- Fill buckets from the store's cleaners' sink tap (approx. 2 buckets) and pour into the sump.\n\nImportant: Always leave both the pump and the alarm float switch in their correct positions after maintenance.",
  newportels: "The sump pump is in the basement below the reception desk printer.\nThe printer will need moving to complete the test.\nStaff must be notified, and the area barriered off.\n\nPriming the pump:\n- Fill buckets from the store's tap (approx. 2 buckets) and pour into the sump.\n\nImportant:\n- Ensure the hatch is fitted back correctly and flush.\n- Always leave both the pump and the alarm float switch in their correct positions after maintenance.",
};

const DEFAULT_CONFIG = {
  declaration: "I confirm that all checks listed above have been carried out and that the sump pump and associated alarm system are in good working order, suitable for continued operation until the next scheduled monthly service.",
  contractor: { tradingTitle: "Mostlane", address: "Unit A5, Segensworth Business Centre, Titchfield", postcode: "PO15 5RQ" },
  safety: [
    { id: "barrier", label: "Area made safe and barriered off correctly to prevent injury (e.g. someone falling into the open hatch/sump)" },
    { id: "notified", label: "Store staff have been notified that the works are being carried out" },
  ],
  stores: [
    { id: "binfield", name: "Binfield", siteCode: "0382", client: "retail", address: "Binfield, Forest Road", postcode: "RG42 4HP", instructions: INSTR.binfield, checks: BINFIELD_CHECKS.slice() },
    { id: "wickham", name: "Wickham", siteCode: "0066", client: "retail", address: "Wickham, The Square", postcode: "PO17 5JN", instructions: INSTR.wickham, checks: WICKHAM_CHECKS.slice() },
    { id: "eastbourne", name: "Eastbourne", siteCode: "0356", client: "retail", address: "Eastbourne, Lindfield Road", postcode: "BN22 0AU", instructions: INSTR.eastbourne, checks: GENERAL.slice() },
    { id: "shanklin", name: "Shanklin", siteCode: "0125", client: "retail", address: "Shanklin, Regent Street", postcode: "PO37 7AA", instructions: INSTR.shanklin, checks: GENERAL.slice() },
    { id: "wimbledon", name: "Wimbledon", siteCode: "0404", client: "retail", address: "Wimbledon, Ridgway", postcode: "SW19 4ST", instructions: INSTR.wimbledon, checks: GENERAL.slice() },
    { id: "newportels", name: "Newport ELS", siteCode: "0682", client: "els", address: "The Co-operative Funeralcare - Newport", postcode: "PO30 1LQ", instructions: INSTR.newportels, checks: GENERAL.slice() },
  ],
};

const normEng = s => (s || "").toLowerCase().replace(/\s+/g, ".").trim();
const siteKeyOf = s => { const t = String(s || "").trim(); return t ? (/^\d+$/.test(t) ? String(Number(t)) : t.toUpperCase().replace(/[^A-Z0-9]/g, "")) : ""; };

async function ensureTables__raw(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pump_records (
    tenant_id TEXT, id TEXT, job_id TEXT, store TEXT, site_code TEXT,
    status TEXT DEFAULT 'draft', data TEXT, engineer TEXT,
    created_at TEXT, updated_at TEXT, r2_final_key TEXT,
    PRIMARY KEY (tenant_id, id))`).run();
}
const ensureTables = onceMigration(ensureTables__raw); // once per isolate — see lib/once.js
async function getConfig(env, tid) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "pump:config:" + tid).first();
  if (row && row.value) { try { const c = JSON.parse(row.value); if (c && Array.isArray(c.stores)) return c; } catch {} }
  await saveConfig(env, tid, DEFAULT_CONFIG);
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
async function saveConfig(env, tid, c) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, "pump:config:" + tid, JSON.stringify(c)).run();
}
async function getJob(env, tid, id) {
  try { const row = await env.DB.prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, id).first(); return row ? JSON.parse(row.data) : null; } catch { return null; }
}
function storeById(cfg, id) { return (cfg.stores || []).find(s => s.id === id) || null; }
function dataUrlToBytes(u) {
  const s = String(u || ""); const i = s.indexOf(",");
  if (!/^data:image\//i.test(s) || i < 0) return null;
  try { const bin = atob(s.slice(i + 1)); const out = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k); return out; } catch { return null; }
}
// ── Images for the PDF ────────────────────────────────────────────────────────
// lib/pdf.js embeds baseline JPEG as-is; anything else must be decoded to raw
// RGB. Canvas signatures are PNG data-URLs; iPhone photos arrive as JPEG (or PNG
// screenshots). HEIC/other formats can't be decoded here — they're listed by name.
const isJpeg = b => b && b.length > 3 && b[0] === 0xFF && b[1] === 0xD8;
const isPng = b => b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
async function sigImage(dataUrl) {
  const b = dataUrlToBytes(dataUrl); if (!b) return null;
  if (isJpeg(b)) return { jpeg: b };
  if (isPng(b)) { const d = await decodePngToRgb(b, { signature: true }); return d ? { rgb: d.rgb, w: d.width, h: d.height } : null; }
  return null;
}
// Nearest-neighbour downscale of raw RGB so a 12-MP PNG doesn't become a 36 MB page.
export function shrinkRgb(rgb, w, h, maxEdge) {
  const s = Math.max(w, h) / maxEdge; if (s <= 1) return { rgb, w, h };
  const nw = Math.max(1, Math.round(w / s)), nh = Math.max(1, Math.round(h / s));
  const out = new Uint8Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) { const sy = Math.min(h - 1, Math.floor(y * s)); for (let x = 0; x < nw; x++) { const sx = Math.min(w - 1, Math.floor(x * s)); const si = (sy * w + sx) * 3, di = (y * nw + x) * 3; out[di] = rgb[si]; out[di + 1] = rgb[si + 1]; out[di + 2] = rgb[si + 2]; } }
  return { rgb: out, w: nw, h: nh };
}
export async function deflate(bytes) {
  try {
    const cs = new CompressionStream("deflate");   // zlib-wrapped = PDF FlateDecode
    const w = cs.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch { return null; }
}
// Returns { img } or { why } so the PDF can say why a photo isn't shown.
async function photoImage(env, m) {
  try {
    const o = env.JOB_FILES && await env.JOB_FILES.get(m.key); if (!o) return { why: "file missing" };
    const b = new Uint8Array(await o.arrayBuffer());
    if (isJpeg(b)) return { img: { jpeg: b, name: m.name || "" } };
    if (isPng(b)) {
      // Camera PNGs can be 12 MP+ — decode with the sampler straight to ≤1000px.
      const d = await decodePngToRgb(b, { maxPixels: 60e6, maxEdge: 1000 });
      if (!d) return { why: "PNG couldn't be decoded" };
      const s = shrinkRgb(d.rgb, d.width, d.height, 1000);
      const z = await deflate(s.rgb);
      return { img: z ? { rgb: z, w: s.w, h: s.h, deflated: true, name: m.name || "" } : { rgb: s.rgb, w: s.w, h: s.h, name: m.name || "" } };
    }
    const ct = (o.httpMetadata && o.httpMetadata.contentType) || "";
    return { why: /heic|heif/i.test(ct + " " + (m.name || "")) ? "HEIC not supported — upload as JPEG" : "unsupported image format" + (ct ? " (" + ct + ")" : "") };
  } catch (e) { return { why: "decode error: " + String(e && e.message || e).slice(0, 60) }; }
}
const MAX_PDF_PHOTOS = 12;
// Everything the PDF builder needs from a record row: decoded signatures +
// embedded photos (+ names of videos / anything that couldn't be embedded).
async function pdfMeta(env, d) {
  const media = Array.isArray(d.media) ? d.media : [];
  const photos = [], skipped = [], videos = [];
  for (const m of media) {
    if (!m || !m.key) continue;
    if (m.kind === "video") { videos.push(m.name || "video"); continue; }
    if (photos.length >= MAX_PDF_PHOTOS) { skipped.push((m.name || "photo") + " (over the " + MAX_PDF_PHOTOS + "-photo limit)"); continue; }
    const r = await photoImage(env, m);
    if (r.img) photos.push(r.img); else skipped.push((m.name || "photo") + " — " + (r.why || "not embedded"));
  }
  return { logo: logoBytes(), engSig: await sigImage(d.engSig), dmSig: await sigImage(d.dmSig), photos, videos, skipped };
}
async function buildPdfFor(env, rec) {
  const d = shapeRow(rec);
  return buildPumpPdf(d, await pdfMeta(env, d));
}

function shapeRow(r) { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return { id: r.id, jobId: r.job_id, store: r.store, siteCode: r.site_code, status: r.status, engineer: r.engineer, createdAt: r.created_at, updatedAt: r.updated_at, ...d }; }

// Build the record object the PDF builder + form expect, merging the store template.
function seedRecord(cfg, store, job) {
  return {
    store: store.id, storeName: store.name, siteCode: store.siteCode || "",
    instructions: store.instructions || "", declaration: cfg.declaration || "",
    safety: (cfg.safety || []).map(s => ({ id: s.id, label: s.label, answer: "" })),
    checks: (store.checks || []).map(c => ({ label: c, answer: "" })),
    detailsNo: "", declarationAgreed: "", date: "",
    engineerName: "", dmName: "", engSig: "", dmSig: "", media: [],
  };
}

// Auto-complete the SLA job once its pump record is submitted/final (like EM/PAT).
async function maybeCompletePumpJob(env, tid, rec) {
  try {
    if (!rec || !rec.job_id) return false;
    const row = await env.DB.prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, rec.job_id).first();
    if (!row) return false;
    let job; try { job = JSON.parse(row.data); } catch { return false; }
    if (!job.pumpMaintenance) return false;
    if (/complete|closed|invoiced|cancel/i.test(String(job.status || ""))) return false;
    if (!/^(review|final)$/.test(String(rec.status || ""))) return false;
    const now = new Date().toISOString();
    job.status = "Complete"; job.updatedAt = now; job.closedAt = job.closedAt || now;
    const engs = (Array.isArray(job.assignedEngineers) && job.assignedEngineers.length) ? job.assignedEngineers.filter(Boolean) : (job.assignedTo ? [job.assignedTo] : []);
    if (engs.length) { job.engStatus = job.engStatus || {}; for (const e of engs) job.engStatus[normEng(e)] = { status: "Complete", at: now, by: "pump" }; }
    job.statusHistory = Array.isArray(job.statusHistory) ? job.statusHistory : [];
    job.statusHistory.push({ status: "Complete", at: now, by: "pump" });
    await env.DB.prepare("UPDATE sla_jobs SET status='Complete', closed_at=?, updated_at=?, data=? WHERE tenant_id=? AND id=?").bind(job.closedAt, now, JSON.stringify(job), tid, rec.job_id).run();
    return true;
  } catch { return false; }
}

async function resignMedia(env, origin, rec) {
  if (!rec || !Array.isArray(rec.media)) return rec;
  for (const m of rec.media) { if (m && m.key) { try { m.url = await signedFileUrl(env, origin, "/pump/media", m.key); } catch {} } }
  return rec;
}

export async function handle(request, env, ctx, url, sess) {
  const method = request.method.toUpperCase();

  // Public (signed) inline stream of a pump photo/video — verified in-handler.
  if (method === "GET" && url.pathname === "/pump/media") {
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("pump/")) return new Response("Bad key", { status: 400 });
    if (!(await verifyFileSig(env, key, url.searchParams))) return new Response("Bad signature", { status: 403 });
    const obj = env.JOB_FILES && await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream", "Cache-Control": "public, max-age=86400" } });
  }

  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const sub = url.pathname.replace(/^\/pump(?=\/|$)/, "") || "/";
  const q = url.searchParams;
  await ensureTables(env);
  const perms = await permissionsFor(env, tid, me);
  const isOffice = perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes" || perms.Compliance === "Yes";
  const loadRec = async id => env.DB.prepare("SELECT * FROM pump_records WHERE tenant_id=? AND id=?").bind(tid, id).first();
  const canWrite = async rec => {
    if (isOffice) return true;
    if (!rec) return true;
    if (String(rec.engineer || "").toLowerCase().trim() === String(me).toLowerCase().trim()) return true;
    try {
      const job = rec.job_id ? await getJob(env, tid, String(rec.job_id)) : null;
      const engs = job ? (Array.isArray(job.assignedEngineers) ? job.assignedEngineers : (job.assignedTo ? [job.assignedTo] : [])) : [];
      return engs.some(e => String(e || "").toLowerCase().trim() === String(me).toLowerCase().trim());
    } catch { return false; }
  };

  // ── config ──
  if (sub === "/config") {
    if (method === "GET") return json({ ok: true, config: await getConfig(env, tid) }, {}, env, request);
    if (method === "POST") {
      if (!isOffice) return error("Office access required", 403, env, request);
      const b = await request.json().catch(() => ({}));
      const cur = await getConfig(env, tid);
      const next = { ...cur };
      if (typeof b.declaration === "string") next.declaration = b.declaration.slice(0, 800);
      if (b.contractor && typeof b.contractor === "object") next.contractor = b.contractor;
      if (Array.isArray(b.safety)) next.safety = b.safety.map((s, i) => ({ id: String(s.id || ("s" + i)), label: String(s.label || "").slice(0, 300) })).filter(s => s.label);
      if (Array.isArray(b.stores)) next.stores = b.stores.map(s => ({
        id: String(s.id || "").toLowerCase().replace(/[^a-z0-9]/g, "") || ("store" + Math.random().toString(36).slice(2, 7)),
        name: String(s.name || "").slice(0, 120), siteCode: String(s.siteCode || "").slice(0, 20),
        client: String(s.client || "").slice(0, 40),
        address: String(s.address || "").slice(0, 300), postcode: String(s.postcode || "").slice(0, 20),
        instructions: String(s.instructions || "").slice(0, 4000),
        checks: (Array.isArray(s.checks) ? s.checks : []).map(c => String(c || "").slice(0, 200)).filter(Boolean),
      })).filter(s => s.name);
      await saveConfig(env, tid, next);
      return json({ ok: true, config: next }, {}, env, request);
    }
  }

  // ── stores list for the Add-Job picker ──
  if (sub === "/stores" && method === "GET") {
    const cfg = await getConfig(env, tid);
    return json({ ok: true, stores: (cfg.stores || []).map(s => ({ id: s.id, name: s.name, siteCode: s.siteCode || "", client: s.client || "", address: s.address || "", postcode: s.postcode || "" })) }, {}, env, request);
  }

  // ── load / seed a job's record ──
  if (sub === "/for-job" && method === "GET") {
    const jobId = q.get("jobId") || "";
    if (!jobId) return error("jobId required", 400, env, request);
    const cfg = await getConfig(env, tid);
    const job = await getJob(env, tid, jobId);
    let storeId = q.get("store") || (job && job.pumpStore) || "";
    const existing = await env.DB.prepare("SELECT * FROM pump_records WHERE tenant_id=? AND job_id=? ORDER BY updated_at DESC LIMIT 1").bind(tid, jobId).first();
    if (existing) {
      const rec = shapeRow(existing); await resignMedia(env, url.origin, rec);
      const store = storeById(cfg, rec.store) || null;
      return json({ ok: true, record: rec, store, config: { declaration: cfg.declaration, safety: cfg.safety } }, {}, env, request);
    }
    const store = storeById(cfg, storeId) || (cfg.stores || [])[0];
    if (!store) return error("No pump stores configured", 400, env, request);
    const seeded = seedRecord(cfg, store, job);
    seeded.date = new Date().toISOString().slice(0, 10);
    if (job) seeded.engineerName = "";
    return json({ ok: true, record: { id: null, jobId, status: "draft", ...seeded }, store, config: { declaration: cfg.declaration, safety: cfg.safety } }, {}, env, request);
  }

  // ── save a draft ──
  if (sub === "/save" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const jobId = String(b.jobId || "");
    let rec = null, id = b.id ? String(b.id) : "";
    if (id) rec = await loadRec(id);
    if (rec && rec.status === "final") return error("This record is finalised — reopen it from the office review to edit.", 409, env, request);
    if (!(await canWrite(rec))) return error("Not allowed", 403, env, request);
    const cfg = await getConfig(env, tid);
    const store = storeById(cfg, String(b.store || (rec && rec.store) || "")) || null;
    // sanitise signatures (data-url JPEG/PNG, size-capped)
    const sanSig = v => { const s = String(v || ""); return (/^data:image\//.test(s) && s.length <= 400000) ? s : (rec ? undefined : ""); };
    const data = {
      storeName: store ? store.name : (b.storeName || ""), instructions: store ? store.instructions : (b.instructions || ""),
      declaration: cfg.declaration || "",
      safety: Array.isArray(b.safety) ? b.safety.map(s => ({ id: String(s.id || ""), label: String(s.label || ""), answer: String(s.answer || "") })) : [],
      checks: Array.isArray(b.checks) ? b.checks.map(c => ({ label: String(c.label || ""), answer: String(c.answer || "") })) : [],
      detailsNo: String(b.detailsNo || "").slice(0, 4000),
      declarationAgreed: b.declarationAgreed === true || String(b.declarationAgreed || "").toLowerCase().startsWith("y") ? "yes" : "",
      date: String(b.date || "").slice(0, 20),
      engineerName: String(b.engineerName || "").slice(0, 120), dmName: String(b.dmName || "").slice(0, 120),
      media: rec ? (shapeRow(rec).media || []) : [],
    };
    const es = sanSig(b.engSig); if (es !== undefined) data.engSig = es; else if (rec) data.engSig = shapeRow(rec).engSig || "";
    const ds = sanSig(b.dmSig); if (ds !== undefined) data.dmSig = ds; else if (rec) data.dmSig = shapeRow(rec).dmSig || "";
    const now = new Date().toISOString();
    if (!id) { id = "pump-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
    const siteCode = store ? (store.siteCode || "") : (rec ? rec.site_code : "");
    const storeId = store ? store.id : (rec ? rec.store : "");
    if (rec) {
      await env.DB.prepare("UPDATE pump_records SET store=?, site_code=?, data=?, updated_at=? WHERE tenant_id=? AND id=?")
        .bind(storeId, siteCode, JSON.stringify(data), now, tid, id).run();
    } else {
      await env.DB.prepare("INSERT INTO pump_records (tenant_id,id,job_id,store,site_code,status,data,engineer,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(tid, id, jobId, storeId, siteCode, "draft", JSON.stringify(data), me, now, now).run();
    }
    const saved = await loadRec(id); const out = shapeRow(saved); await resignMedia(env, url.origin, out);
    return json({ ok: true, record: out }, {}, env, request);
  }

  // ── upload a photo / video ──
  if (sub === "/media" && method === "POST") {
    if (!env.JOB_FILES) return error("Storage unavailable", 500, env, request);
    const form = await request.formData().catch(() => null);
    if (!form) return error("multipart required", 400, env, request);
    const id = String(form.get("id") || ""); const kind = String(form.get("kind") || "photo") === "video" ? "video" : "photo";
    const file = form.get("file");
    if (!id || !file || typeof file.arrayBuffer !== "function") return error("id + file required", 400, env, request);
    const rec = await loadRec(id);
    if (!rec) return error("Record not found", 404, env, request);
    if (rec.status === "final") return error("Record finalised", 409, env, request);
    if (!(await canWrite(rec))) return error("Not allowed", 403, env, request);
    // Cloudflare Workers cap the request body at ~100 MB, so keep videos under that.
    const cap = kind === "video" ? 95 * 1024 * 1024 : 12 * 1024 * 1024;
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length > cap) return error(kind === "video" ? "Video too large (max 95 MB — keep the clip short)" : "Photo too large (max 12 MB)", 413, env, request);
    const ext = (String(file.name || "").match(/\.([a-z0-9]{2,5})$/i) || [, kind === "video" ? "mp4" : "jpg"])[1].toLowerCase();
    const key = `pump/${tid}/${id}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    await env.JOB_FILES.put(key, buf, { httpMetadata: { contentType: file.type || (kind === "video" ? "video/mp4" : "image/jpeg") } });
    const d = shapeRow(rec); const media = Array.isArray(d.media) ? d.media : [];
    media.push({ key, kind, name: String(file.name || (kind + "." + ext)).slice(0, 160) });
    const data = { ...d }; delete data.id; delete data.jobId; delete data.store; delete data.siteCode; delete data.status; delete data.engineer; delete data.createdAt; delete data.updatedAt; data.media = media;
    await env.DB.prepare("UPDATE pump_records SET data=?, updated_at=? WHERE tenant_id=? AND id=?").bind(JSON.stringify(data), new Date().toISOString(), tid, id).run();
    const urlOut = await signedFileUrl(env, url.origin, "/pump/media", key);
    return json({ ok: true, key, kind, name: media[media.length - 1].name, url: urlOut }, {}, env, request);
  }
  if (sub === "/media-delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || ""), key = String(b.key || "");
    const rec = await loadRec(id);
    if (!rec) return error("Record not found", 404, env, request);
    if (!(await canWrite(rec))) return error("Not allowed", 403, env, request);
    if (key.startsWith("pump/") && env.JOB_FILES) { try { await env.JOB_FILES.delete(key); } catch {} }
    const d = shapeRow(rec); const media = (Array.isArray(d.media) ? d.media : []).filter(m => m.key !== key);
    const data = { ...d }; delete data.id; delete data.jobId; delete data.store; delete data.siteCode; delete data.status; delete data.engineer; delete data.createdAt; delete data.updatedAt; data.media = media;
    await env.DB.prepare("UPDATE pump_records SET data=?, updated_at=? WHERE tenant_id=? AND id=?").bind(JSON.stringify(data), new Date().toISOString(), tid, id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── submit for office review ──
  if (sub === "/submit" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    const rec = await loadRec(id);
    if (!rec) return error("Record not found", 404, env, request);
    if (!(await canWrite(rec))) return error("Not allowed", 403, env, request);
    await env.DB.prepare("UPDATE pump_records SET status='review', updated_at=? WHERE tenant_id=? AND id=?").bind(new Date().toISOString(), tid, id).run();
    const fresh = await loadRec(id);
    try { await maybeCompletePumpJob(env, tid, fresh); } catch {}
    ctx && ctx.waitUntil && ctx.waitUntil(sendToPermission(env, tid, ["FullAccess", "SLAAdmin", "Compliance"], {
      title: "🚰 Pump maintenance submitted", body: `${shapeRow(rec).storeName || "A store"} — ready for office review`, url: "/cert-review.html?pump=" + encodeURIComponent(id), tag: "pump-review",
    }, me, { officeOnly: true }).catch(() => {}));
    return json({ ok: true, record: shapeRow(fresh) }, {}, env, request);
  }

  // ── one record ──
  if (sub === "/one" && method === "GET") {
    const rec = await loadRec(q.get("id") || "");
    if (!rec) return error("Not found", 404, env, request);
    if (!(await canWrite(rec)) && !isOffice) return error("Not allowed", 403, env, request);
    const out = shapeRow(rec); await resignMedia(env, url.origin, out);
    return json({ ok: true, record: out }, {}, env, request);
  }

  // ── office review queue ──
  if (sub === "/review" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const { results } = await env.DB.prepare("SELECT * FROM pump_records WHERE tenant_id=? AND status IN ('draft','review') ORDER BY updated_at DESC LIMIT 200").bind(tid).all();
    return json({ ok: true, records: (results || []).map(shapeRow) }, {}, env, request);
  }
  // ── a store's finalised history ──
  if (sub === "/list" && method === "GET") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const store = q.get("store") || "";
    const { results } = await env.DB.prepare("SELECT * FROM pump_records WHERE tenant_id=? AND status='final' AND (?='' OR store=?) ORDER BY updated_at DESC LIMIT 200").bind(tid, store, store).all();
    return json({ ok: true, records: (results || []).map(shapeRow) }, {}, env, request);
  }

  // ── render PDF ──
  if (sub === "/pdf" && method === "GET") {
    const rec = await loadRec(q.get("id") || "");
    if (!rec) return error("Not found", 404, env, request);
    if (!(await canWrite(rec)) && !isOffice) return error("Not allowed", 403, env, request);
    const d = shapeRow(rec);
    const bytes = await buildPdfFor(env, rec);
    return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Pump-${(d.storeName || rec.id)}.pdf"`, "Cache-Control": "no-store", ...corsHeaders(env, request) } });
  }

  // ── finalise → draw PDF + file to the site ──
  if (sub === "/finalise" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const rec = await loadRec(String(b.id || ""));
    if (!rec) return error("Not found", 404, env, request);
    const d = shapeRow(rec);
    const bytes = await buildPdfFor(env, rec);
    const now = new Date().toISOString();
    const finalKey = `pump/${tid}/${rec.id}/record.pdf`;
    if (env.JOB_FILES) { try { await env.JOB_FILES.put(finalKey, bytes, { httpMetadata: { contentType: "application/pdf" } }); } catch {} }
    // File the PDF into the compliance chart's PUMP section for the store's site,
    // as the CURRENT pump document (rolls the due date). Co-op stores are the
    // `coop` scheme; the compliance code = the site number. Also surfaces in the
    // site's Documents via the /sla/site/docs compliance injection. Skipped when
    // the store isn't linked to a site yet (Eastbourne) — the PDF still lives on
    // the record + review page.
    let filedToSite = false;
    const code = rec.site_code || d.siteCode || "";
    if (code) {
      try {
        await fileCertificatePdf(env, tid, {
          scheme: "coop", code: code, type: "pump", bytes: bytes,
          filename: `Pump-${(d.storeName || rec.id).replace(/[^A-Za-z0-9]+/g, "-")}-${(d.date || now.slice(0, 10))}.pdf`,
          docDate: d.date || now.slice(0, 10), bump: true, source: "pump:" + rec.id,
          label: "Pump maintenance — " + (d.date || now.slice(0, 10)),
        });
        filedToSite = true;
      } catch {}
    }
    await env.DB.prepare("UPDATE pump_records SET status='final', r2_final_key=?, updated_at=? WHERE tenant_id=? AND id=?").bind(finalKey, now, tid, rec.id).run();
    const fresh = await loadRec(rec.id);
    try { await maybeCompletePumpJob(env, tid, fresh); } catch {}
    if (rec.engineer) ctx && ctx.waitUntil && ctx.waitUntil(sendToUser(env, tid, rec.engineer, { title: "🚰 Pump record filed", body: `${d.storeName || "Pump"} maintenance record finalised`, url: "/pump-review.html", tag: "pump-final" }).catch(() => {}));
    return json({ ok: true, record: shapeRow(fresh), filedToSite }, {}, env, request);
  }

  // ── office: file a replacement PDF instead of generating ──
  if (sub === "/upload" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    if (!env.JOB_FILES) return error("Storage unavailable", 500, env, request);
    const form = await request.formData().catch(() => null);
    if (!form) return error("multipart required", 400, env, request);
    const rec = await loadRec(String(form.get("id") || ""));
    if (!rec) return error("Not found", 404, env, request);
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return error("file required", 400, env, request);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const finalKey = `pump/${tid}/${rec.id}/record.pdf`;
    await env.JOB_FILES.put(finalKey, bytes, { httpMetadata: { contentType: "application/pdf" } });
    await env.DB.prepare("UPDATE pump_records SET status='final', r2_final_key=?, updated_at=? WHERE tenant_id=? AND id=?").bind(finalKey, new Date().toISOString(), tid, rec.id).run();
    const fresh = await loadRec(rec.id); try { await maybeCompletePumpJob(env, tid, fresh); } catch {}
    return json({ ok: true, record: shapeRow(fresh) }, {}, env, request);
  }

  // ── office: reopen a finalised record for editing ──
  if (sub === "/reopen" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const rec = await loadRec(String(b.id || ""));
    if (!rec) return error("Not found", 404, env, request);
    await env.DB.prepare("UPDATE pump_records SET status='review', updated_at=? WHERE tenant_id=? AND id=?").bind(new Date().toISOString(), tid, rec.id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── office: delete ──
  if (sub === "/delete" && method === "POST") {
    if (!isOffice) return error("Office access required", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const rec = await loadRec(String(b.id || ""));
    if (!rec) return error("Not found", 404, env, request);
    if (env.JOB_FILES) { try { const l = await env.JOB_FILES.list({ prefix: `pump/${tid}/${rec.id}/` }); for (const o of (l.objects || [])) await env.JOB_FILES.delete(o.key); } catch {} }
    await env.DB.prepare("DELETE FROM pump_records WHERE tenant_id=? AND id=?").bind(tid, rec.id).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Not found: " + url.pathname, 404, env, request);
}
