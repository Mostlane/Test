// ============================================================================
// Compliance certificates (mounted at /compliance)
// ----------------------------------------------------------------------------
// The portal-native home for The Southern Co-op compliance certificates: files
// live in R2 (JOB_FILES under `compliance/<code>/<type>/<year>/…`) and are
// indexed in D1 (`compliance_files`), keyed by store CODE + compliance TYPE.
// A Graph-based extractor (run separately) streams each cert off SharePoint's
// "TSC Compliance" tree into POST /compliance/file. The compliance page joins
// these to its store rows by code so each store shows a live cert per type.
// ============================================================================

import { corsHeaders } from "../lib/http.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor, requireSession } from "../lib/auth.js";
import { resolveComplianceAccess } from "../lib/complianceaccess.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { syncSiteToSiteLog } from "./sites.js";

let READY = false;
async function ensure(env) {
  if (READY) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS compliance_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    code TEXT NOT NULL,          -- store code (4 digits)
    type TEXT NOT NULL,          -- canonical: fiveYear|pat|em|pv|ev|forecourt|pump|other
    year TEXT,                   -- e.g. "2025" (if known)
    r2_key TEXT NOT NULL,
    filename TEXT,
    label TEXT,                  -- admin-given display name (rename + named custom docs e.g. "O&M for PV")
    pinned INTEGER DEFAULT 0,    -- 1 = keep as current (link several current docs of one type together)
    size INTEGER,
    doc_date TEXT,               -- certificate date (if parsed)
    source TEXT,                 -- SharePoint item id / webUrl — used to de-dupe re-runs
    uploaded_at TEXT
  )`).run();
  // Self-migrating: add label + pinned + scheme to any existing table.
  try { await env.DB.prepare("ALTER TABLE compliance_files ADD COLUMN label TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE compliance_files ADD COLUMN pinned INTEGER DEFAULT 0").run(); } catch {}
  // scheme = which compliance chart this belongs to: 'coop' (Southern Co-op) or
  // 'fareham' (Fareham Borough Council). Existing rows default to 'coop'.
  try { await env.DB.prepare("ALTER TABLE compliance_files ADD COLUMN scheme TEXT NOT NULL DEFAULT 'coop'").run(); } catch {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_compfiles_code ON compliance_files(tenant_id, scheme, code, type)").run(); } catch {}
  // One row per source item (nulls stay distinct, so manual uploads aren't blocked).
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_compfiles_src ON compliance_files(tenant_id, source)").run(); } catch {}
  // The compliance OVERLAY on a site: one row per (scheme, code). Holds the
  // category + per-type due dates + a `meta` JSON ({lat,lng,w3w,access,contact}).
  // For 'coop' the name/postcode resolve from the `sites` table by code; other
  // schemes (Fareham) store them directly here.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS compliance_stores (
    tenant_id  INTEGER NOT NULL DEFAULT 1,
    scheme     TEXT NOT NULL DEFAULT 'coop',
    code       TEXT NOT NULL,
    category   TEXT,
    name       TEXT,
    postcode   TEXT,
    due        TEXT,
    active     INTEGER DEFAULT 1,
    meta       TEXT,                   -- JSON { lat, lng, w3w, access, contact }
    updated_at TEXT,
    PRIMARY KEY (tenant_id, scheme, code)
  )`).run();
  // Self-migrating for a pre-scheme table (adds columns; the live table's PK is
  // widened to include scheme by a one-off migration).
  try { await env.DB.prepare("ALTER TABLE compliance_stores ADD COLUMN scheme TEXT NOT NULL DEFAULT 'coop'").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE compliance_stores ADD COLUMN meta TEXT").run(); } catch {}
  // site_number = the canonical PORTAL site this compliance store belongs to, so
  // its documents surface in that site's "Site Documents". For 'coop' this equals
  // the code (the store IS the portal site); other schemes (Fareham) resolve it by
  // matching an existing site by name (null until that site exists).
  try { await env.DB.prepare("ALTER TABLE compliance_stores ADD COLUMN site_number TEXT").run(); } catch {}
  // Compliance-check WORKLIST. One row per scheme+site+check-type. The verifier runs
  // in the browser (reusing the EICR engine) and posts its result here; the row keeps
  // the findings + a tick-off status + notes so the check can be worked through and
  // survives across devices. `checked_at` (last run) vs the site's newest document
  // upload drives the "skip unchanged sites" re-run rule.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS compliance_review (
    tenant_id  INTEGER NOT NULL DEFAULT 1,
    scheme     TEXT NOT NULL DEFAULT 'coop',
    code       TEXT NOT NULL,          -- site code
    type       TEXT NOT NULL,          -- check type (fiveYear, …)
    status     TEXT DEFAULT 'open',    -- open | done
    outcome    TEXT,                   -- SATISFACTORY | UNSATISFACTORY | '' | error
    attention  INTEGER DEFAULT 0,      -- 1 = something flagged for review
    summary    TEXT,                   -- short headline
    flags      TEXT,                   -- JSON array of finding strings
    file_id    INTEGER,                -- compliance_files.id checked
    doc_at     TEXT,                   -- the newest-doc timestamp checked against
    checked_at TEXT,                   -- when the verifier last ran (last run)
    notes      TEXT,
    updated_by TEXT,
    updated_at TEXT,
    PRIMARY KEY (tenant_id, scheme, code, type)
  )`).run();
  try { await env.DB.prepare("ALTER TABLE compliance_review ADD COLUMN scheme TEXT NOT NULL DEFAULT 'coop'").run(); } catch {}
  // Engine version that produced the stored result — lets the client auto-re-check
  // any cert scored by an older verifier without a manual "re-check every site".
  try { await env.DB.prepare("ALTER TABLE compliance_review ADD COLUMN ver INTEGER DEFAULT 0").run(); } catch {}
  READY = true;
}

// Which compliance chart a request is for. Sanitised to [a-z0-9]; defaults to
// 'coop' so the Southern Co-op page (which sends no scheme) is unchanged.
function schemeOf(q) {
  const s = String((q && q.get && q.get("scheme")) || "coop").toLowerCase().replace(/[^a-z0-9]/g, "");
  return s || "coop";
}

// Compliance frequencies (years). EICR/5-Year is 5-yearly; everything else annual.
const DUE_YEARS = { fiveYear: 5 };

// Per-type page settings (app_config key 'compliance_settings:<scheme>'): how
// often each compliance recurs (frequency, drives the auto-advance on upload) and
// when the status light + its date cell turn amber / red (days before due).
// Frequency is `years` OR `months` (EM Monthly). Per scheme:
const SCHEME_DEFAULTS = {
  coop: {
    fiveYear:  { years: 5, amberDays: 90, redDays: 30 },
    pat:       { years: 1, amberDays: 90, redDays: 30 },
    em:        { years: 1, amberDays: 90, redDays: 30 },
    pv:        { years: 1, amberDays: 90, redDays: 30 },
    ev:        { years: 1, amberDays: 90, redDays: 30 },
    forecourt: { years: 1, amberDays: 90, redDays: 30 },
    pump:      { years: 1, amberDays: 90, redDays: 30 },
  },
  fareham: {
    fiveYear:  { years: 5, amberDays: 90, redDays: 30 },
    emMonthly: { months: 1, amberDays: 14, redDays: 7 },
    emYearly:  { years: 1, amberDays: 90, redDays: 30 },
    pat:       { years: 1, amberDays: 90, redDays: 30 },
    pv:        { years: 1, amberDays: 90, redDays: 30 },
  },
  // Projects scheme — one row per portal project (auto-created on
  // /project/create). Every project appears here so a lost approval /
  // certificate has one canonical home. Types kept short + editable per project:
  //   elec = Electrical Certificate (EICR / EIC / Minor Works)
  //   gas  = Gas Safety Certificate
  //   bldg = Building Control (approval / completion)
  // "other" (drawings + everything else) is always available on every scheme.
  projects: {
    elec: { years: 5, amberDays: 90, redDays: 30 },
    gas:  { years: 1, amberDays: 90, redDays: 30 },
    bldg: { years: 10, amberDays: 90, redDays: 30 },
  },
  // Chapplins (residential lettings): statutory landlord certificates.
  chapplins: {
    fiveYear:   { years: 5,  amberDays: 90, redDays: 30 },  // EICR (electrical), 5-yearly
    gas:        { years: 1,  amberDays: 60, redDays: 21 },  // Gas Safety (CP12), annual
    epc:        { years: 10, amberDays: 180, redDays: 60 }, // EPC, 10-yearly
    alarms:     { years: 1,  amberDays: 60, redDays: 21 },  // Smoke/CO alarms
    fire:       { years: 1,  amberDays: 90, redDays: 30 },  // Fire / emergency lighting (communal)
    legionella: { years: 2,  amberDays: 90, redDays: 30 },  // Legionella risk assessment
  },
};
const DEFAULT_TYPE_SETTINGS = SCHEME_DEFAULTS.coop;   // back-compat alias
function numOr(v, d, min, max) {
  let n = Number(v); if (!isFinite(n)) n = d; n = Math.round(n);
  if (n < min) n = min; if (n > max) n = max; return n;
}
// Read the saved settings for a scheme, merged over that scheme's defaults.
async function getComplianceSettings(env, tid, scheme) {
  scheme = scheme || "coop";
  const defaults = SCHEME_DEFAULTS[scheme] || SCHEME_DEFAULTS.coop;
  let saved = {};
  try {
    const key = "compliance_settings:" + scheme;
    // coop kept its original un-suffixed key; fall back to it for back-compat.
    let row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, key).first();
    if ((!row || !row.value) && scheme === "coop") row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='compliance_settings'").bind(tid).first();
    if (row && row.value) saved = JSON.parse(row.value) || {};
  } catch {}
  const st = (saved && saved.types) || {};
  const types = {};
  for (const [t, def] of Object.entries(defaults)) {
    const s = st[t] || {};
    const one = { amberDays: numOr(s.amberDays, def.amberDays, 0, 3650), redDays: numOr(s.redDays, def.redDays, 0, 3650) };
    if (def.months != null) one.months = numOr(s.months != null ? s.months : def.months, def.months, 1, 120);
    else one.years = numOr(s.years != null ? s.years : def.years, def.years, 1, 50);
    types[t] = one;
  }
  return { types };
}

function addYears(dateStr, n) {
  const d = new Date(dateStr); if (isNaN(d)) return null;
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const d = new Date(dateStr); if (isNaN(d)) return null;
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
// Advance a store's due date for a type from a freshly-uploaded cert's date. Only
// called for "current" drag-drop uploads (bump=1), never the historical backfill,
// so importing old certs can't stomp the live due dates. Creates the store row if
// the cert was dropped on a code we weren't yet tracking.
async function bumpDue(env, tid, scheme, code, type, dateStr) {
  if (!dateStr) return;
  // Use the configured per-type frequency (years, or months for EM Monthly).
  let next = null;
  try {
    const cfg = await getComplianceSettings(env, tid, scheme);
    const c = cfg.types[type];
    if (c && c.months != null) next = addMonths(dateStr, c.months);
    else next = addYears(dateStr, (c && c.years) || DUE_YEARS[type] || 1);
  } catch { next = addYears(dateStr, DUE_YEARS[type] || 1); }
  if (!next) return;
  const at = new Date().toISOString();
  const row = await env.DB.prepare("SELECT due FROM compliance_stores WHERE tenant_id=? AND scheme=? AND code=?").bind(tid, scheme, code).first();
  let due = {}; if (row && row.due) { try { due = JSON.parse(row.due) || {}; } catch {} }
  due[type] = next;
  if (row) await env.DB.prepare("UPDATE compliance_stores SET due=?, updated_at=? WHERE tenant_id=? AND scheme=? AND code=?").bind(JSON.stringify(due), at, tid, scheme, code).run();
  else await env.DB.prepare("INSERT INTO compliance_stores (tenant_id, scheme, code, due, active, site_number, updated_at) VALUES (?,?,?,?,1,?,?)").bind(tid, scheme, code, JSON.stringify(due), (scheme === "coop" ? await coopSiteNumber(env, tid, code) : null), at).run();
}

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
const safeName = (s) => String(s || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);

// File a certificate PDF onto the compliance chart — the exact R2 + DB + bumpDue
// path the manual /compliance/file upload uses, exposed so the portal-native
// certificate module (routes/certs.js) can finalise a cert into the same place.
// Returns { id, key }. type is canonicalised; code is padded like a store code.
export async function fileCertificatePdf(env, tid, { scheme = "coop", code, type, bytes, filename, docDate, bump = true, source = null, label = null }) {
  const sc = String(scheme || "coop");
  const cd = pad4(code);
  const ty = canonType(type);
  if (!cd || !bytes) throw new Error("code and bytes required");
  const year = docDate ? String(docDate).slice(0, 4) : null;
  const fn = safeName(filename || (ty + ".pdf"));
  const key = `compliance/${sc}/${cd}/${ty}/${year || "_"}/${Date.now()}-${fn}`;
  await env.JOB_FILES.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const at = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO compliance_files (tenant_id, scheme, code, type, year, r2_key, filename, label, size, doc_date, source, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(tid, sc, cd, ty, year, key, fn, label, bytes.length || bytes.byteLength || null, docDate || null, source, at).run();
  if (bump && docDate) { try { await bumpDue(env, tid, sc, cd, ty, docDate); } catch {} }
  return { id: res.meta ? res.meta.last_row_id : null, key };
}
// A store's compliance code is a numeric store number (4-digit, zero-padded).
// A code carrying a LETTER (e.g. a project "P0002") is NOT a Co-op store — return
// "" so it never resolves onto a real store's certs (stripping the letter would
// turn "P0002" into "0002"). An empty/no-digit code is also "" (not "0000").
const pad4 = (v) => { const s = String(v ?? ""); if (/[a-z]/i.test(s)) return ""; const d = s.replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };

// A Co-op store's compliance code IS its portal site number — but the chart pads
// codes to 4 digits ("0649") while older portal sites are stored UNPADDED ("649").
// A blind site_number = code therefore missed the site that was already there and
// (with createSites) minted a duplicate 3-digit/4-digit pair. So resolve the link
// NUMERICALLY: use the existing site's own number when one matches, and only fall
// back to the padded code when that store genuinely has no portal site yet.
// Shortest-first so the original unpadded row wins over any legacy stub.
async function coopSiteNumber(env, tid, code) {
  if (!code) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT site_number FROM sites
        WHERE tenant_id=? AND site_number <> '' AND site_number NOT GLOB '*[^0-9]*'
          AND CAST(site_number AS INTEGER) = CAST(? AS INTEGER)
        ORDER BY LENGTH(site_number), site_number LIMIT 1`
    ).bind(tid, code).first();
    if (row && row.site_number) return String(row.site_number);
  } catch {}
  return code;
}

// ── Scheme identity: display label. 'coop' compliance stores ARE portal sites
// (site_number = code). Other schemes (Fareham) attach to an EXISTING portal
// site matched by name — a separate workflow owns creating those sites — so a
// store links up when its site exists and shows nothing extra until then.
const SCHEME_LABELS = { coop: "Southern Co-op", fareham: "Fareham Borough Council", chapplins: "Chapplins" };
const schemeLabel = (s) => SCHEME_LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

// Human labels + the pickable upload types for a scheme (drives the Site
// Documents upload selector). Built from that scheme's due-dated types, plus
// asbestos (Fareham) and always "other".
const TYPE_LABELS = {
  fiveYear: "5 Year", pat: "PAT", em: "Emergency Lighting", emMonthly: "EM Monthly",
  emYearly: "EM Yearly", pv: "PV", ev: "EV/Forecourt", forecourt: "EV/Forecourt",
  pump: "Pump", asbestos: "Asbestos Register",
  // Projects scheme
  elec: "Electrical Certificate", bldg: "Building Control",
  // Chapplins lettings types
  gas: "Gas Safety", epc: "EPC", alarms: "Smoke/CO Alarms",
  fire: "Fire / Emergency Lighting", legionella: "Legionella",
  other: "Other",
};
function typeOptionsFor(scheme) {
  const keys = Object.keys(SCHEME_DEFAULTS[scheme] || SCHEME_DEFAULTS.coop);
  if (scheme === "fareham" && !keys.includes("asbestos")) keys.push("asbestos");
  if (!keys.includes("other")) keys.push("other");
  return keys.map((k) => ({ key: k, label: TYPE_LABELS[k] || k }));
}

// Canonical compliance type keys across every scheme (coop, fareham, projects, chapplins).
const KNOWN_TYPES = ["fiveYear","pat","em","emMonthly","emYearly","pv","ev","pump","asbestos","elec","gas","bldg","epc","alarms","fire","legionella","other"];
// Normalise any incoming type label (a chart type key, a SharePoint subfolder, or
// a table key) to a canonical compliance type.
function canonType(t) {
  const s = String(t || "").toLowerCase();
  // Idempotent for a key the front-end already sent (keeps camelCase like emMonthly).
  const exact = KNOWN_TYPES.find(k => k.toLowerCase() === s);
  if (exact) return exact;
  if (/em\s*month|month.*\bem\b|emmonthly/.test(s)) return "emMonthly";
  if (/em\s*year|year.*\bem\b|emyearly/.test(s)) return "emYearly";
  if (/asbestos/.test(s)) return "asbestos";
  // Chapplins lettings types (checked before the generic ones below).
  if (/legionella|\blra\b/.test(s)) return "legionella";
  if (/\bepc\b|energy\s*perf/.test(s)) return "epc";
  if (/\bgas\b|cp12|gsc|landlord.*gas|gas.*safety/.test(s)) return "gas";
  if (/smoke|\bco\b|carbon\s*monox|alarm/.test(s)) return "alarms";
  if (/5\s*year|five\s*year|eicr/.test(s)) return "fiveYear";
  if (/\bfire\b|\bfra\b/.test(s)) return "fire";
  if (/\bpat\b/.test(s)) return "pat";
  if (/emergency|\bem\b|em\s*light/.test(s)) return "em";
  // Forecourt (PFS) is merged with EV on the chart → one "EV/Forecourt" column.
  if (/forecourt|\bpfs\b|petrol|fuel/.test(s)) return "ev";
  if (/\bpv\b|solar|photovolt/.test(s)) return "pv";
  if (/\bev\b|charge|ev\s*maint/.test(s)) return "ev";
  if (/pump|sump/.test(s)) return "pump";
  // Projects scheme
  if (/build.*control|\bbldg\b|building/.test(s)) return "bldg";
  if (/gas\s*safe|gas/.test(s)) return "gas";
  if (/electr|\belec\b|eic\b|minor\s*works/.test(s)) return "elec";
  const k = s.replace(/[^a-z0-9]+/g, "");
  return k ? k.slice(0, 20) : "other";
}

async function isFull(env, tid, me) { try { const p = await permissionsFor(env, tid, me); return p.FullAccess === "Yes" || p.Compliance === "Yes"; } catch { return false; } }

// The user's resolved compliance access LEVEL for a scheme: none|view|download|
// edit. Same model the client uses (Full-Access => edit; explicit stored level;
// else legacy default office edit / field view). The import bot (token) = edit.
// This is the server-side gate so access can't be bypassed by crafting requests.
async function complianceLevelFor(env, tid, me, scheme, viaToken) {
  if (viaToken) return "edit";
  try {
    const perms = await permissionsFor(env, tid, me);
    const row = await env.DB.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=?").bind(tid, me).first();
    const map = resolveComplianceAccess(row ? row.profile : null, perms);
    return map[scheme] || "none";
  } catch { return "none"; }
}

// One store's files grouped by type (newest first, signed URLs, current/previous
// resolved). Shared by GET /files and GET /site-files.
async function listStoreFiles(env, origin, tid, scheme, code) {
  const { results } = await env.DB.prepare(
    "SELECT id, type, year, r2_key, filename, label, pinned, size, doc_date, uploaded_at FROM compliance_files WHERE tenant_id=? AND scheme=? AND code=? ORDER BY COALESCE(doc_date,uploaded_at) DESC"
  ).bind(tid, scheme, code).all();
  const byType = {};
  for (const r of results || []) {
    (byType[r.type] = byType[r.type] || []).push({
      id: r.id, year: r.year, filename: r.filename, label: r.label || null, pinned: r.pinned ? 1 : 0,
      size: r.size, date: r.doc_date || r.uploaded_at,
      url: await signedFileUrl(env, origin, "/compliance/file", r.r2_key),
    });
  }
  // "current" set per type: if any files are pinned, ALL pinned ones are current
  // (two linked docs stay current together); else the newest single file is current.
  for (const t of Object.keys(byType)) {
    const arr = byType[t];
    const anyPinned = arr.some((f) => f.pinned);
    arr.forEach((f, i) => { f.current = anyPinned ? !!f.pinned : (i === 0); });
  }
  return byType;
}

// Map a compliance category label to the portal's canonical lowercase client id
// (matches how sites are already stored: retail/els/els_private/cobra/wenzels).
const CLIENT_MAP = { "retail":"retail", "els":"els", "els private":"els_private", "cobra":"cobra", "wenzel's":"wenzels", "wenzels":"wenzels" };
function complianceClient(cat) {
  const k = String(cat || "").toLowerCase().trim();
  return CLIENT_MAP[k] || k.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "general";
}

// Machine-to-machine import token (for the SharePoint→R2 batch extractor, which
// can't hold a portal session). Timing-safe compare, same shape as /sla/inbound.
function importTokenOK(request, env) {
  const secret = (env.COMPLIANCE_IMPORT_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (!secret) return false;
  const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let diff = tok.length === secret.length ? 0 : 1;
  for (let i = 0; i < Math.min(tok.length, secret.length); i++) diff |= tok.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/compliance(?=\/|$)/, "") || "/";
  const q = url.searchParams;

  // ── Public: stream a certificate (access gated by the signed link) ──────────
  if (sub === "/file" && method === "GET" && q.get("key")) {
    const key = q.get("key");
    if (!key || !String(key).startsWith("compliance/")) return jr({ error: "Bad key" }, headers, 400);
    // Always require a valid signed link (issued only to view+ users via /files
    // and /file-url) — a bare session no longer bypasses the signature, so a
    // logged-in user can't fetch an arbitrary compliance key directly.
    if (!(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers,
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600"
    }});
  }

  // The batch extractor authenticates with COMPLIANCE_IMPORT_TOKEN instead of a
  // session — it may only touch the ingest/dedupe routes (/file POST, /has),
  // which are declared public so the token (not a session) reaches here. On
  // those public routes `sess` arrives null even for a logged-in admin, so we
  // re-resolve a real session from the Authorization header when there's no
  // import token — that keeps the admin manual-upload path working too.
  const viaToken = !sess && importTokenOK(request, env);
  if (!sess && !viaToken) { try { sess = await requireSession(env, request); } catch { sess = null; } }
  if (!sess && !viaToken) return jr({ error: "Not authenticated" }, headers, 401);
  const tid = sess ? (sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request)) : await resolveTenantId(env, request);
  const me = sess ? sess.user.username : "import-bot";
  const scheme = schemeOf(q);   // 'coop' (default) or 'fareham'
  // Per-scheme access level — the authoritative server gate.
  const level = await complianceLevelFor(env, tid, me, scheme, viaToken);
  const canRead  = viaToken || level !== "none";   // view / download / edit
  const canWrite = viaToken || level === "edit";    // edit only (all write routes key off this)
  await ensure(env);

  // Reads for a scheme's chart require at least "view" on that scheme. The public
  // /file GET (handled above, signature-gated) and the cross-scheme /site-files
  // path (site-folder, used by engineers) are deliberately NOT gated here.
  const SCHEME_READS = new Set(["/has", "/index", "/files", "/file-url", "/stores", "/summary", "/settings", "/next-code"]);
  if (!canRead && SCHEME_READS.has(sub)) {
    return jr({ error: "No compliance access to this page" }, headers, 403);
  }

  // ── Dedupe check: has this SharePoint item already been ingested? ───────────
  if (sub === "/has" && method === "GET") {
    const source = q.get("source") || "";
    if (!source) return jr({ error: "source required" }, headers, 400);
    const row = await env.DB.prepare("SELECT id FROM compliance_files WHERE tenant_id=? AND source=?").bind(tid, source).first();
    return jr({ ok: true, exists: !!row, id: row ? row.id : null }, headers);
  }

  // ── Compact index: which types each store has a cert for (for the table) ────
  if (sub === "/index" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT DISTINCT code, type FROM compliance_files WHERE tenant_id=? AND scheme=?").bind(tid, scheme).all();
    const map = {};
    for (const r of results || []) { (map[r.code] = map[r.code] || {})[r.type] = 1; }
    return jr({ ok: true, map, stores: Object.keys(map).length }, headers);
  }

  // ── One store's files (grouped by type, newest first, signed URLs) ──────────
  if (sub === "/files" && method === "GET") {
    const code = pad4(q.get("code"));
    if (!code) return jr({ error: "code required" }, headers, 400);
    const byType = await listStoreFiles(env, url.origin, tid, scheme, code);
    return jr({ ok: true, code, files: byType }, headers);
  }

  // ── A PORTAL SITE's compliance docs across every scheme (drives "Site
  // Documents"). Resolves site_number → the linked compliance store(s), so a
  // Co-op site shows its Co-op certs and a Fareham site shows its Fareham certs
  // — from the one place a site is opened. `site` is the portal site_number.
  if (sub === "/site-files" && method === "GET") {
    const site = String(q.get("site") || "").trim();
    if (!site) return jr({ error: "site required" }, headers, 400);
    const seen = new Set();
    const stores = [];
    const add = (r) => { const k = r.scheme + "|" + r.code; if (!seen.has(k)) { seen.add(k); stores.push({ scheme: r.scheme, code: r.code, name: r.name || "" }); } };
    // 1) Stores explicitly linked to this portal site (any scheme).
    const linked = await env.DB.prepare(
      "SELECT scheme, code, name FROM compliance_stores WHERE tenant_id=? AND site_number=?"
    ).bind(tid, site).all();
    for (const r of linked.results || []) add(r);
    // 2) Stores whose NAME matches this site's name — covers a store not yet
    //    relinked to a freshly-created site (e.g. Fareham buildings whose portal
    //    site is added by a separate workflow after the compliance chart exists).
    const siteRow = await env.DB.prepare("SELECT site_name FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, site).first();
    if (siteRow && siteRow.site_name) {
      const byName = await env.DB.prepare(
        "SELECT scheme, code, name FROM compliance_stores WHERE tenant_id=? AND LOWER(TRIM(name))=LOWER(TRIM(?))"
      ).bind(tid, siteRow.site_name).all();
      for (const r of byName.results || []) add(r);
    }
    // 3) Back-compat: a plain-numeric site is a Co-op store by code (covers rows
    //    from before site_number was backfilled).
    const plain = pad4(site);
    if (plain && !stores.some((s) => s.scheme === "coop" && s.code === plain)) {
      const has = await env.DB.prepare(
        "SELECT 1 FROM compliance_stores WHERE tenant_id=? AND scheme='coop' AND code=? UNION SELECT 1 FROM compliance_files WHERE tenant_id=? AND scheme='coop' AND code=? LIMIT 1"
      ).bind(tid, plain, tid, plain).first();
      if (has) add({ scheme: "coop", code: plain, name: "" });
    }
    const sections = [];
    for (const s of stores) {
      sections.push({
        scheme: s.scheme, schemeLabel: schemeLabel(s.scheme), code: s.code, name: s.name,
        types: typeOptionsFor(s.scheme),
        files: await listStoreFiles(env, url.origin, tid, s.scheme, s.code),
      });
    }
    return jr({ ok: true, site, sections }, headers);
  }

  // ── Latest cert URL for a store+type (used by the 📄 links) ─────────────────
  if (sub === "/file-url" && method === "GET") {
    const code = pad4(q.get("code")), type = canonType(q.get("type"));
    const row = await env.DB.prepare(
      "SELECT r2_key FROM compliance_files WHERE tenant_id=? AND scheme=? AND code=? AND type=? ORDER BY COALESCE(doc_date,uploaded_at) DESC LIMIT 1"
    ).bind(tid, scheme, code, type).first();
    if (!row) return jr({ error: "No file" }, headers, 404);
    return jr({ ok: true, url: await signedFileUrl(env, url.origin, "/compliance/file", row.r2_key) }, headers);
  }

  // ── Ingest a certificate (the extractor + manual upload) ────────────────────
  // multipart: file + code, type, year?, date?, filename?, source?
  if (sub === "/file" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    let form; try { form = await request.formData(); } catch { return jr({ error: "multipart required" }, headers, 400); }
    const file = form.get("file");
    const code = pad4(form.get("code"));
    const type = canonType(form.get("type"));
    if (!file || typeof file === "string" || !code) return jr({ error: "file and code required" }, headers, 400);
    const source = String(form.get("source") || "").slice(0, 400) || null;
    if (source) {
      const dup = await env.DB.prepare("SELECT id, r2_key FROM compliance_files WHERE tenant_id=? AND source=?").bind(tid, source).first();
      if (dup) return jr({ ok: true, duplicate: true, id: dup.id }, headers);
    }
    const year = String(form.get("year") || "").replace(/[^0-9]/g, "").slice(0, 4) || null;
    const fname = safeName(form.get("filename") || file.name || (type + ".pdf"));
    // Optional admin display name (e.g. a named custom "O&M for PV" doc, or a
    // clearer name than the raw filename). Empty → null (falls back to filename).
    const label = String(form.get("label") || "").slice(0, 160).trim() || null;
    const at = new Date().toISOString();
    const key = `compliance/${scheme}/${code}/${type}/${year || "_"}/${Date.now()}-${fname}`;
    await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    const docDate = String(form.get("date") || "") || null;
    const res = await env.DB.prepare(
      "INSERT INTO compliance_files (tenant_id, scheme, code, type, year, r2_key, filename, label, size, doc_date, source, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(tid, scheme, code, type, year, key, fname, label, file.size || null, docDate, source, at).run();
    // A "current" drag-drop upload (bump=1) advances the store's due date from the
    // new cert's date; the historical backfill never sends bump, so it can't stomp
    // the live due dates.
    if (form.get("bump") && docDate) { try { await bumpDue(env, tid, scheme, code, type, docDate); } catch {} }
    return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null, key, code, type }, headers, 201);
  }

  // ── Delete a certificate (admin) ────────────────────────────────────────────
  if (sub === "/file-delete" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const row = await env.DB.prepare("SELECT r2_key FROM compliance_files WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (row) { try { await env.JOB_FILES.delete(row.r2_key); } catch {} }
    await env.DB.prepare("DELETE FROM compliance_files WHERE tenant_id=? AND id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Update a document: rename (label), pin as current (link), or re-file (type)
  // Body { id, label?, pinned?, type? }. `type` re-files the doc under another
  // compliance heading (drag-and-drop in the Documents modal), canonicalised.
  if (sub === "/file-update" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const sets = [], vals = [];
    if (b.label != null) { sets.push("label=?"); vals.push(String(b.label).slice(0, 160).trim() || null); }
    if (b.pinned != null) { sets.push("pinned=?"); vals.push(b.pinned ? 1 : 0); }
    if (b.type != null) { sets.push("type=?"); vals.push(canonType(b.type)); }
    if (!sets.length) return jr({ error: "nothing to update" }, headers, 400);
    vals.push(tid, id);
    await env.DB.prepare(`UPDATE compliance_files SET ${sets.join(", ")} WHERE tenant_id=? AND id=?`).bind(...vals).run();
    return jr({ ok: true }, headers);
  }

  // ── The compliance chart, single-sourced from the `sites` home ──────────────
  // Each row = a compliance store (by code) with its name/postcode resolved LIVE
  // from the sites table (fallback to the cached copy), its category + due dates,
  // and which types already have a document on file (drives the 📄 links).
  if (sub === "/stores" && method === "GET") {
    // Projects scheme: every portal project has a row on this chart. Auto-heal
    // any missing rows (e.g. projects created before this scheme existed) by
    // inserting them here — link stays via site_number = project.number.
    if (scheme === "projects") {
      try {
        const { results: projRows } = await env.DB.prepare(
          "SELECT id, number, name, status FROM projects WHERE tenant_id=? AND status IN ('live','complete')"
        ).bind(tid).all();
        for (const p of projRows || []) {
          const code = String(p.number || "").trim();
          if (!code) continue;
          await env.DB.prepare(
            `INSERT OR IGNORE INTO compliance_stores
              (tenant_id, scheme, code, name, site_number, active, due, meta, updated_at)
              VALUES (?, 'projects', ?, ?, ?, 1, '{}', '{}', ?)`
          ).bind(tid, code, p.name || null, code, new Date().toISOString()).run();
        }
      } catch {}
    }
    // Non-Co-op stores link to a portal site by NAME. Portal sites for other
    // schemes may be created by a separate workflow AFTER the compliance chart,
    // so self-heal on load: link any still-unlinked store whose name now matches
    // a site (one cheap correlated UPDATE, touches only null rows).
    if (scheme !== "coop") {
      try {
        await env.DB.prepare(
          `UPDATE compliance_stores SET site_number = (
             SELECT s.site_number FROM sites s
             WHERE s.tenant_id = compliance_stores.tenant_id
               AND LOWER(TRIM(s.site_name)) = LOWER(TRIM(compliance_stores.name))
             ORDER BY s.site_number LIMIT 1)
           WHERE tenant_id=? AND scheme=? AND name IS NOT NULL AND (site_number IS NULL OR site_number='')`
        ).bind(tid, scheme).run();
      } catch {}
    }
    // 'coop' resolves live name/postcode from the sites table; other schemes
    // (Fareham) store them directly on the compliance row.
    const { results } = scheme === "coop"
      ? await env.DB.prepare(
          // Resolve the live site by the store's LINK (site_number), falling back
          // to its code — and match numerically as well as exactly, so a padded
          // code ("0649") still finds an unpadded portal site ("649") instead of
          // showing as unlinked. Duplicate matches are collapsed below by code.
          `SELECT cs.code, cs.category, cs.name AS cname, cs.postcode AS cpost, cs.due, cs.active, cs.meta, cs.site_number,
                  s.site_name AS sname, s.postcode AS spost
             FROM compliance_stores cs
             LEFT JOIN sites s ON s.tenant_id = cs.tenant_id AND (
                    s.site_number = COALESCE(NULLIF(cs.site_number, ''), cs.code)
                 OR (s.site_number <> '' AND s.site_number NOT GLOB '*[^0-9]*'
                     AND COALESCE(NULLIF(cs.site_number, ''), cs.code) NOT GLOB '*[^0-9]*'
                     AND CAST(s.site_number AS INTEGER) = CAST(COALESCE(NULLIF(cs.site_number, ''), cs.code) AS INTEGER)))
            WHERE cs.tenant_id = ? AND cs.scheme = ?`
        ).bind(tid, scheme).all()
      : await env.DB.prepare(
          `SELECT code, category, name AS cname, postcode AS cpost, due, active, meta, site_number,
                  NULL AS sname, NULL AS spost
             FROM compliance_stores WHERE tenant_id = ? AND scheme = ?`
        ).bind(tid, scheme).all();
    // file index: which types each store has ≥1 document for
    const idx = {};
    const fi = await env.DB.prepare("SELECT code, type, COUNT(*) AS n FROM compliance_files WHERE tenant_id=? AND scheme=? GROUP BY code, type").bind(tid, scheme).all();
    for (const r of fi.results || []) { (idx[r.code] = idx[r.code] || {})[r.type] = r.n; }
    // One row per store: the numeric-tolerant join above can match twice if a
    // duplicate padded/unpadded site pair ever exists — keep the resolved one.
    const byCode = new Map();
    for (const r of results || []) {
      const prev = byCode.get(r.code);
      if (!prev || (!prev.sname && r.sname)) byCode.set(r.code, r);
    }
    const stores = [...byCode.values()].map(r => {
      let due = {}; if (r.due) { try { due = JSON.parse(r.due) || {}; } catch {} }
      let meta = {}; if (r.meta) { try { meta = JSON.parse(r.meta) || {}; } catch {} }
      return {
        code: r.code,
        name: r.sname || r.cname || "",
        postcode: r.spost || r.cpost || "",
        category: r.category || "",
        siteNumber: r.site_number || (scheme === "coop" ? r.code : ""),
        hasSite: !!r.sname,
        active: r.active == null ? 1 : r.active,
        due,
        meta,
        files: idx[r.code] || {},
      };
    });
    return jr({ ok: true, stores, count: stores.length }, headers);
  }

  // ── One-time migration from the old mostlane-pos store list (browser-driven) ─
  // Body { stores:[{code,name,postcode,category,due:{type:date}}], createSites:bool }.
  // Upserts the overlay and (optionally) creates any missing canonical `sites` row
  // so the chart and Sites share one home with no duplicates.
  if (sub === "/stores/import" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const rows = Array.isArray(b.stores) ? b.stores : [];
    if (!rows.length) return jr({ error: "stores[] required" }, headers, 400);
    const createSites = !!b.createSites;
    const at = new Date().toISOString();
    let imported = 0, matched = 0, sitesCreated = 0;
    for (const r of rows) {
      const code = pad4(r.code); if (!code || code === "0000") continue;
      const due = (r.due && typeof r.due === "object") ? r.due : {};
      // keep only real dates, canonicalising the type keys
      const dueClean = {};
      for (const [k, v] of Object.entries(due)) { const t = canonType(k); const s = String(v || "").replace(/📄/g, "").trim(); if (s) dueClean[t] = s; }
      const metaJson = (r.meta && typeof r.meta === "object") ? JSON.stringify(r.meta) : null;
      // The portal site this store links to. Co-op stores ARE portal sites (site
      // number = code). Other schemes (Fareham) attach to an EXISTING portal site
      // matched by name — a separate workflow owns creating those sites, so we
      // never invent a duplicate here; unmatched stores link once their site lands.
      let siteNo = null;
      if (scheme === "coop") siteNo = await coopSiteNumber(env, tid, code);
      else {
        const match = await env.DB.prepare(
          "SELECT site_number FROM sites WHERE tenant_id=? AND LOWER(TRIM(site_name))=LOWER(TRIM(?)) ORDER BY site_number LIMIT 1"
        ).bind(tid, r.name || "").first();
        siteNo = match ? match.site_number : null;
      }
      await env.DB.prepare(
        `INSERT INTO compliance_stores (tenant_id, scheme, code, category, name, postcode, due, active, meta, site_number, updated_at)
         VALUES (?,?,?,?,?,?,?,1,?,?,?)
         ON CONFLICT(tenant_id, scheme, code) DO UPDATE SET
           category=COALESCE(excluded.category, compliance_stores.category),
           name=COALESCE(excluded.name, compliance_stores.name),
           postcode=COALESCE(excluded.postcode, compliance_stores.postcode),
           due=excluded.due,
           meta=COALESCE(excluded.meta, compliance_stores.meta),
           site_number=COALESCE(excluded.site_number, compliance_stores.site_number),
           updated_at=excluded.updated_at`
      ).bind(tid, scheme, code, r.category || null, r.name || null, r.postcode || null, JSON.stringify(dueClean), metaJson, siteNo, at).run();
      imported++;
      // Only Co-op creates a missing portal site (opt-in via createSites — its
      // sites already exist). Other schemes just link; if the named site exists
      // it's a match, otherwise it links up later when that site is added.
      if (siteNo) {
        const site = await env.DB.prepare("SELECT site_number FROM sites WHERE tenant_id=? AND site_number=?").bind(tid, siteNo).first();
        if (site) matched++;
        else if (scheme === "coop" && createSites && r.name) {
          // `sites.client` is NOT NULL. Map the compliance category to the portal's
          // canonical lowercase client id, and — crucially — write the full site
          // object into `data`, because /get-sites (and sites.html) render ONLY from
          // that JSON blob; a columns-only row shows up blank.
          const client = complianceClient(r.category);
          const name = String(r.name).slice(0, 200);
          const postcode = String(r.postcode || "").slice(0, 20);
          const data = JSON.stringify({ client, siteNumber: siteNo, siteName: name, postcode, active: true });
          try {
            await env.DB.prepare(
              "INSERT INTO sites (tenant_id, client, site_number, site_name, postcode, active, archived, data, updated_at) VALUES (?,?,?,?,?,1,0,?,?)"
            ).bind(tid, client, siteNo, name, postcode, data, at).run();
            sitesCreated++;
          } catch (e) { /* skip a store we can't create a site for */ }
        }
      }
    }
    return jr({ ok: true, imported, matched, sitesCreated }, headers);
  }

  // ── Page settings: per-type frequency + amber/red warning windows ───────────
  // GET is open to any session (viewers need it to colour the chart correctly).
  if (sub === "/settings" && method === "GET") {
    return jr({ ok: true, settings: await getComplianceSettings(env, tid, scheme) }, headers);
  }
  if (sub === "/settings" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const inTypes = (b && b.types) || {};
    const defaults = SCHEME_DEFAULTS[scheme] || SCHEME_DEFAULTS.coop;
    const cur = await getComplianceSettings(env, tid, scheme);
    const out = { types: {} };
    for (const [t, def] of Object.entries(defaults)) {
      const s = inTypes[t] || cur.types[t] || def;
      const one = { amberDays: numOr(s.amberDays, def.amberDays, 0, 3650), redDays: numOr(s.redDays, def.redDays, 0, 3650) };
      if (def.months != null) one.months = numOr(s.months != null ? s.months : def.months, def.months, 1, 120);
      else one.years = numOr(s.years != null ? s.years : def.years, def.years, 1, 50);
      out.types[t] = one;
    }
    // coop kept its original un-suffixed key; new schemes use compliance_settings:<scheme>.
    const key = scheme === "coop" ? "compliance_settings" : ("compliance_settings:" + scheme);
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, key, JSON.stringify(out)).run();
    return jr({ ok: true, settings: out }, headers);
  }

  // ── Edit one store's category / due dates (replaces the mostlane-pos update) ─
  if (sub === "/store" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code);
    if (!code) return jr({ error: "code required" }, headers, 400);
    const at = new Date().toISOString();
    const row = await env.DB.prepare("SELECT due, category, name, postcode FROM compliance_stores WHERE tenant_id=? AND scheme=? AND code=?").bind(tid, scheme, code).first();
    let due = {}; if (row && row.due) { try { due = JSON.parse(row.due) || {}; } catch {} }
    if (b.due && typeof b.due === "object") {
      // Strip any stray cert emoji / non-date junk so it can never be stored on a
      // due date (that produced a phantom extra 📄 in the chart).
      for (const [k, v] of Object.entries(b.due)) { const t = canonType(k); const s = String(v == null ? "" : v).replace(/📄/g, "").trim(); if (s) due[t] = s; else delete due[t]; }
    }
    const category = b.category != null ? String(b.category).slice(0, 60) : (row ? row.category : null);
    const name = b.name != null ? String(b.name).slice(0, 200) : (row ? row.name : null);
    const postcode = b.postcode != null ? String(b.postcode).slice(0, 20) : (row ? row.postcode : null);
    // Explicit portal-site link (the "Add from Sites" picker passes it): a coop
    // store's code IS its site number, but other schemes (Fareham) use their own
    // 0001-style codes, so the link must be given. Falls back to the coop rule.
    const explicitSite = (b.siteNumber != null ? String(b.siteNumber) : (b.site_number != null ? String(b.site_number) : "")).trim();
    const siteNo = explicitSite || (scheme === "coop" ? await coopSiteNumber(env, tid, code) : null);
    await env.DB.prepare(
      `INSERT INTO compliance_stores (tenant_id, scheme, code, category, name, postcode, due, active, site_number, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(tenant_id, scheme, code) DO UPDATE SET category=excluded.category, name=excluded.name, postcode=excluded.postcode, due=excluded.due, site_number=COALESCE(excluded.site_number, compliance_stores.site_number), updated_at=excluded.updated_at`
    ).bind(tid, scheme, code, category, name, postcode, JSON.stringify(due), siteNo, at).run();
    // Cascade name / postcode edits to the linked portal site so an admin who
    // edits the store here doesn't have to also edit sites.html. Best-effort;
    // only touches columns supplied. NOP when the store isn't linked yet.
    if (siteNo && (b.name != null || b.postcode != null)) {
      try {
        const s = await env.DB.prepare("SELECT client, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, siteNo).first();
        if (s) {
          let d = {}; try { d = JSON.parse(s.data || "{}"); } catch {}
          if (b.name != null) d.siteName = String(name || d.siteName || "").slice(0, 200);
          if (b.postcode != null) d.postcode = String(postcode || "").slice(0, 20);
          await env.DB.prepare(
            "UPDATE sites SET site_name=?, postcode=?, data=?, updated_at=datetime('now') WHERE tenant_id=? AND client=? AND site_number=?"
          ).bind(d.siteName || null, d.postcode || null, JSON.stringify(d), tid, s.client, siteNo).run();
        }
      } catch {}
    }
    return jr({ ok: true, code, due, siteNumber: siteNo }, headers);
  }

  // ── Save a store's location / access meta (📍 pin + 🔑 access) ───────────────
  // Body { code, lat?, lng?, w3w?, access?, contact?, keys? } — merged into meta JSON.
  if (sub === "/store-meta" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code);
    if (!code) return jr({ error: "code required" }, headers, 400);
    const at = new Date().toISOString();
    const row = await env.DB.prepare("SELECT meta FROM compliance_stores WHERE tenant_id=? AND scheme=? AND code=?").bind(tid, scheme, code).first();
    let meta = {}; if (row && row.meta) { try { meta = JSON.parse(row.meta) || {}; } catch {} }
    const numOrNull = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
    if ("lat" in b) meta.lat = b.lat === null || b.lat === "" ? null : numOrNull(b.lat);
    if ("lng" in b) meta.lng = b.lng === null || b.lng === "" ? null : numOrNull(b.lng);
    if ("w3w" in b) meta.w3w = String(b.w3w || "").replace(/^\/+/, "").slice(0, 120) || null;
    if ("access" in b) meta.access = String(b.access || "").slice(0, 2000) || null;
    if ("contact" in b) meta.contact = String(b.contact || "").slice(0, 2000) || null;
    if ("keys" in b) meta.keys = String(b.keys || "").slice(0, 2000) || null;
    if (row) await env.DB.prepare("UPDATE compliance_stores SET meta=?, updated_at=? WHERE tenant_id=? AND scheme=? AND code=?").bind(JSON.stringify(meta), at, tid, scheme, code).run();
    else await env.DB.prepare("INSERT INTO compliance_stores (tenant_id, scheme, code, meta, active, site_number, updated_at) VALUES (?,?,?,?,1,?,?)").bind(tid, scheme, code, JSON.stringify(meta), (scheme === "coop" ? await coopSiteNumber(env, tid, code) : null), at).run();
    // Cascade lat/lng edits to the linked portal site (and hence to SiteLog's
    // geofence), so a coord pin on the compliance chart moves the map + the
    // scanner geofence in one action.
    if ("lat" in b || "lng" in b) {
      try {
        const linkRow = await env.DB.prepare("SELECT site_number FROM compliance_stores WHERE tenant_id=? AND scheme=? AND code=?").bind(tid, scheme, code).first();
        const siteNo = linkRow && linkRow.site_number;
        if (siteNo) {
          const s = await env.DB.prepare("SELECT client, site_name, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, siteNo).first();
          if (s) {
            let d = {}; try { d = JSON.parse(s.data || "{}"); } catch {}
            if ("lat" in b) d.lat = meta.lat;
            if ("lng" in b) { d.lng = meta.lng; d.lon = meta.lng; }
            await env.DB.prepare("UPDATE sites SET data=?, updated_at=datetime('now') WHERE tenant_id=? AND client=? AND site_number=?")
              .bind(JSON.stringify(d), tid, s.client, siteNo).run();
            // Push the new coord to SiteLog too (upsert, so an existing geofence
            // gets moved instead of a duplicate). Best-effort.
            ctx?.waitUntil(syncSiteToSiteLog(env, { siteName: s.site_name, lat: d.lat, lon: d.lon, client: s.client }));
          }
        }
      } catch {}
    }
    return jr({ ok: true, code, meta }, headers);
  }

  // ── Remove a store from the chart (keeps its documents) ─────────────────────
  if (sub === "/store-delete" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code);
    if (!code) return jr({ error: "code required" }, headers, 400);
    await env.DB.prepare("DELETE FROM compliance_stores WHERE tenant_id=? AND scheme=? AND code=?").bind(tid, scheme, code).run();
    return jr({ ok: true }, headers);
  }

  // ── Archive / reopen a store (moves it to/from the Closed Sites view) ────────
  // Body { code, archived }. Keeps the row + its documents; just flips `active`.
  if (sub === "/store-archive" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code);
    if (!code) return jr({ error: "code required" }, headers, 400);
    const active = b.archived ? 0 : 1;
    await env.DB.prepare("UPDATE compliance_stores SET active=?, updated_at=? WHERE tenant_id=? AND scheme=? AND code=?")
      .bind(active, new Date().toISOString(), tid, scheme, code).run();
    return jr({ ok: true, code, active }, headers);
  }

  // ── Next free numeric code for a scheme (for Add Site auto-numbering) ────────
  if (sub === "/next-code" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT code FROM compliance_stores WHERE tenant_id=? AND scheme=?").bind(tid, scheme).all();
    let max = 0; for (const r of results || []) { const n = parseInt(String(r.code).replace(/\D/g, ""), 10); if (isFinite(n) && n > max) max = n; }
    return jr({ ok: true, code: String(max + 1).padStart(4, "0") }, headers);
  }

  // ══ Compliance-check WORKLIST ═══════════════════════════════════════════════
  // The verification runs in the browser (the shared EICR engine); these routes
  // hand it the certs to check and store/serve the resulting worklist. Scheme-scoped
  // (default 'coop'), same as the rest of the compliance chart.

  // Targets to run the check against. For every site that has a cert of a
  // checkable type, return its NEWEST cert of that type (signed URL) + the site's
  // newest document upload time (ANY type) + the stored review row. `needs` is
  // true when nothing's been run yet OR a document has been added to the site
  // since the last run — the client skips the rest.
  if (sub === "/review/targets" && method === "GET") {
    if (!canWrite) return jr({ error: "Compliance edit access required" }, headers, 403);
    const CHECK_TYPES = ["fiveYear"];   // extend as more per-type checkers are added
    // newest document per site (any type) → the "has anything changed" clock
    const siteLatest = {};
    const sl = await env.DB.prepare("SELECT code, MAX(uploaded_at) AS latest FROM compliance_files WHERE tenant_id=? AND scheme=? GROUP BY code").bind(tid, scheme).all();
    for (const r of sl.results || []) siteLatest[r.code] = r.latest;
    // stored review rows
    const rev = {};
    const rv = await env.DB.prepare("SELECT code, type, status, outcome, attention, checked_at, ver FROM compliance_review WHERE tenant_id=? AND scheme=?").bind(tid, scheme).all();
    for (const r of rv.results || []) rev[r.code + "|" + r.type] = r;
    const targets = [];
    for (const type of CHECK_TYPES) {
      // ALL documents filed under this type per site (newest first). Multiple docs can
      // sit under "5 Year" (the certificate + remedial sheets etc.); the client works
      // through them newest-first and verifies the FIRST that is a real EICR, ignoring
      // the rest — so a remedial sheet never gets checked as if it were the cert.
      const { results } = await env.DB.prepare(
        `SELECT f.code, f.id, f.r2_key, f.filename, f.doc_date, f.uploaded_at, s.site_name AS sname, cs.name AS cname
           FROM compliance_files f
           LEFT JOIN sites s ON s.tenant_id=f.tenant_id AND s.site_number=f.code
           LEFT JOIN compliance_stores cs ON cs.tenant_id=f.tenant_id AND cs.scheme=f.scheme AND cs.code=f.code
          WHERE f.tenant_id=? AND f.scheme=? AND f.type=?
          ORDER BY f.code, COALESCE(f.doc_date,f.uploaded_at) DESC`
      ).bind(tid, scheme, type).all();
      const byCode = {};
      for (const r of results || []) {
        if (!byCode[r.code]) byCode[r.code] = { code: r.code, name: r.sname || r.cname || r.code, docs: [] };
        if (byCode[r.code].docs.length < 8) {
          byCode[r.code].docs.push({
            fileId: r.id, filename: r.filename || "",
            date: r.doc_date || r.uploaded_at,
            url: await signedFileUrl(env, url.origin, "/compliance/file", r.r2_key),
          });
        }
      }
      for (const code of Object.keys(byCode)) {
        const t = byCode[code];
        const latestDoc = siteLatest[code] || (t.docs[0] && t.docs[0].date);
        const rr = rev[code + "|" + type];
        const needs = !rr || !rr.checked_at || (latestDoc && rr.checked_at < latestDoc);
        targets.push({
          code: code, type, name: t.name, docs: t.docs,
          fileId: t.docs[0] ? t.docs[0].fileId : null,           // back-compat
          url: t.docs[0] ? t.docs[0].url : "",                    // back-compat
          docAt: latestDoc, needs,
          review: rr ? { status: rr.status, outcome: rr.outcome, attention: rr.attention, checked_at: rr.checked_at, ver: rr.ver || 0 } : null,
        });
      }
    }
    return jr({ ok: true, targets, count: targets.length }, headers);
  }

  // Store one check result (client posts after running the verifier on a cert).
  if (sub === "/review/save" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance edit access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code), type = canonType(b.type || "fiveYear");
    if (!code) return jr({ error: "code required" }, headers, 400);
    const flags = Array.isArray(b.flags) ? b.flags.slice(0, 60).map(x => String(x).slice(0, 400)) : [];
    // `attention` (red) means a genuine issue — the client sends it from the engine's
    // summarize(); fall back to "any flag" only if it wasn't provided.
    const attention = (b.attention != null) ? (b.attention ? 1 : 0) : (flags.length ? 1 : 0);
    const at = new Date().toISOString();
    // A fresh run (new/changed cert) resets the tick-off to open; keep the prior
    // notes. status column is only advanced to 'done' by /review/status.
    const ver = parseInt(b.ver, 10) || 0;
    await env.DB.prepare(
      `INSERT INTO compliance_review (tenant_id, scheme, code, type, status, outcome, attention, summary, flags, file_id, doc_at, checked_at, ver, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, scheme, code, type) DO UPDATE SET
         status='open', outcome=excluded.outcome, attention=excluded.attention, summary=excluded.summary,
         flags=excluded.flags, file_id=excluded.file_id, doc_at=excluded.doc_at, checked_at=excluded.checked_at,
         ver=excluded.ver, updated_by=excluded.updated_by, updated_at=excluded.updated_at`
    ).bind(tid, scheme, code, type, "open", String(b.outcome || "").slice(0, 20), attention,
      String(b.summary || "").slice(0, 300), JSON.stringify(flags),
      b.fileId ? parseInt(b.fileId, 10) : null, String(b.docAt || at), at, ver, me, at).run();
    return jr({ ok: true, code, type, attention }, headers);
  }

  // The worklist (with a fresh signed URL to open each cert).
  if (sub === "/review/list" && method === "GET") {
    if (!canWrite) return jr({ error: "Compliance edit access required" }, headers, 403);
    const { results } = await env.DB.prepare(
      `SELECT r.code, r.type, r.status, r.outcome, r.attention, r.summary, r.flags, r.file_id, r.checked_at, r.notes,
              s.site_name AS sname, cs.name AS cname, f.r2_key AS r2_key
         FROM compliance_review r
         LEFT JOIN sites s ON s.tenant_id=r.tenant_id AND s.site_number=r.code
         LEFT JOIN compliance_stores cs ON cs.tenant_id=r.tenant_id AND cs.scheme=r.scheme AND cs.code=r.code
         LEFT JOIN compliance_files f ON f.id=r.file_id
        WHERE r.tenant_id=? AND r.scheme=?`
    ).bind(tid, scheme).all();
    const rows = [];
    for (const r of results || []) {
      let flags = []; if (r.flags) { try { flags = JSON.parse(r.flags) || []; } catch {} }
      rows.push({
        code: r.code, type: r.type, name: r.sname || r.cname || r.code,
        status: r.status || "open", outcome: r.outcome || "", attention: r.attention || 0,
        summary: r.summary || "", flags, checkedAt: r.checked_at, notes: r.notes || "",
        url: r.r2_key ? await signedFileUrl(env, url.origin, "/compliance/file", r.r2_key) : "",
      });
    }
    return jr({ ok: true, rows, count: rows.length }, headers);
  }

  // Tick off / add a note.
  if (sub === "/review/status" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance edit access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code), type = canonType(b.type || "fiveYear");
    if (!code) return jr({ error: "code required" }, headers, 400);
    const at = new Date().toISOString();
    const sets = [], vals = [];
    if (b.status != null) { sets.push("status=?"); vals.push(b.status === "done" ? "done" : "open"); }
    if (b.notes != null) { sets.push("notes=?"); vals.push(String(b.notes).slice(0, 2000)); }
    if (!sets.length) return jr({ error: "nothing to update" }, headers, 400);
    sets.push("updated_by=?", "updated_at=?"); vals.push(me, at);
    vals.push(tid, scheme, code, type);
    const r = await env.DB.prepare(`UPDATE compliance_review SET ${sets.join(", ")} WHERE tenant_id=? AND scheme=? AND code=? AND type=?`).bind(...vals).run();
    return jr({ ok: true, changed: r.meta ? r.meta.changes : 0 }, headers);
  }

  // ── Summary / progress (how many certs stored, by type) ─────────────────────
  if (sub === "/summary" && method === "GET") {
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM compliance_files WHERE tenant_id=? AND scheme=?").bind(tid, scheme).first())?.n || 0;
    const { results } = await env.DB.prepare("SELECT type, COUNT(*) AS n FROM compliance_files WHERE tenant_id=? AND scheme=? GROUP BY type").bind(tid, scheme).all();
    const byType = {}; (results || []).forEach(r => { byType[r.type] = r.n; });
    const stores = (await env.DB.prepare("SELECT COUNT(DISTINCT code) AS n FROM compliance_files WHERE tenant_id=? AND scheme=?").bind(tid, scheme).first())?.n || 0;
    return jr({ ok: true, total, stores, byType }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}
