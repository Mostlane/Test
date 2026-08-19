// Projects — a first-class "project" record that links a job together: its own
// P-number project-site (for PO + costing), coordinates + mileage, which
// documents are required, the SiteLog arrival message + companies on site, a
// build To-Do list, and the LINKS to every related thing (programme id, RAMS
// ids, CPP ref, the costing key). Everything else in the portal joins projects
// only by loose name strings; this record is the spine that ties them.
//
//   View  (FullAccess | Projects | ProjectsAdmin):
//     GET  /projects/list?status=            project cards + todo progress
//     GET  /project/get?id=                  one project (todo, links, docs)
//     GET  /project/docs?id=                 project documents (engineers: non-hidden)
//     GET  /project/doc?key=&exp=&sig=       stream a document (PUBLIC, sig-verified)
//   Manage (FullAccess | ProjectsAdmin):
//     POST /project/create                   the wizard save
//     POST /project/update                   edit required/status/sitelog/companies/value
//     POST /project/link                     attach programmeId | ramsId | cppRef
//     POST /project/todo                     manual tick / add a to-do item
//     POST /project/doc                      upload a document (multipart)
//     POST /project/doc-update               rename / hide / downloadable
//     POST /project/doc-delete               remove a document
//
// Tables (self-migrating): projects, project_files. Docs in R2 JOB_FILES under
// projectdocs/<tid>/<projectId>/. Project valuations reuse costing's proj_fin.

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import * as sitelogApi from "./sitelog-api.js";
import { createOrUpdateJobFromPayload, listJobs, reconcileRelease, notifyNewlyAssigned } from "./sla.js";
import { ratesMap } from "./costing.js";

const PROJ_FIN_KEY = tid => `proj_fin:${tid}`;

// The five buildable document types, in order. `auto` = the link field whose
// presence auto-ticks the item; label + how the front-end builds it.
const DOC_TYPES = [
  { key: "programme", label: "Programme of works" },
  { key: "rams", label: "Risk Assessment (RAMS)" },
  { key: "cpp", label: "Construction Phase Plan" },
  { key: "valuations", label: "Valuations" },
  { key: "projectDocs", label: "Project Documents" },
];

function newId(prefix) {
  return prefix + "-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}
// Same normalisation costing uses for its site "key" — so a project's costing
// key matches the site register / proj_fin entry.
function normName(s) {
  return String(s || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function bool(v) { return v === true || v === 1 || v === "1" || v === "true"; }

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, tenant_id TEXT, number TEXT, name TEXT,
    site_client TEXT, site_number TEXT, status TEXT DEFAULT 'live',
    data TEXT, created_by TEXT, created_at TEXT, updated_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, title TEXT, section TEXT,
    r2_key TEXT, name TEXT, type TEXT, hidden INTEGER DEFAULT 0,
    downloadable INTEGER DEFAULT 1, uploaded_by TEXT, uploaded_at TEXT)`).run();
  // Manual labour + material costs on a project. Labour rows carry hours + a
  // snapshot of the rate at entry time (so a later rate change never rewrites
  // history); material rows carry an amount + supplier. Folded into the site's
  // cost totals by costing.js and shown on the project hub P&L.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_costs (
    id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, kind TEXT,
    date TEXT, username TEXT, hours REAL, rate REAL,
    supplier TEXT, description TEXT, amount REAL,
    created_by TEXT, created_at TEXT)`).run();
}

// Add-only push of the project's site name to the PO system's sites table
// (env.PO_DB — separate D1), so raising a PO can pick this project. Same
// idempotent shape as po.js addSite. Best-effort; must never break the caller.
export async function pushSiteToPO(env, name) {
  try {
    if (!env.PO_DB || !String(name || "").trim()) return false;
    await env.PO_DB.prepare(
      "INSERT INTO sites (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1"
    ).bind(String(name).trim()).run();
    return true;
  } catch { return false; }
}

async function cfgGet(db, key) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, key).first();
  try { return row && row.value ? JSON.parse(row.value) : null; } catch { return null; }
}
async function cfgSet(db, key, obj) {
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, key, JSON.stringify(obj)).run();
}

// Set (or clear) the project's contract value in costing's proj_fin, keyed by
// the same costing key so valuations show on the job-costing card + hub.
async function setProjFinValue(db, costingKey, value, name) {
  if (!costingKey) return;
  const all = (await cfgGet(db, PROJ_FIN_KEY(db.tenantId))) || {};
  const cur = all[costingKey] || { value: 0, planned: 1, valuations: [] };
  cur.value = Number(value) || 0;
  cur.name = name || cur.name;
  if (!Array.isArray(cur.valuations)) cur.valuations = [];
  if (!cur.planned) cur.planned = 1;
  all[costingKey] = cur;
  await cfgSet(db, PROJ_FIN_KEY(db.tenantId), all);
}

// Push the SiteLog arrival message ("what SiteLog should say") onto the site's
// SiteLog geofence. Best-effort: in-process when the SiteLog DB is bound, else
// the remote admin API; never throws into the caller.
async function applySiteLogRules(env, siteName, rules, visitorRules) {
  try {
    if (!env.SITELOG_ADMIN_SECRET || !String(siteName || "").trim()) return false;
    const base = (env.SITELOG_API || "https://api.site-log.co.uk");
    const hdr = { "Content-Type": "application/json", "x-admin-secret": env.SITELOG_ADMIN_SECRET };
    const call = async (path, init) => {
      const req = new Request(base + path, init);
      if (env.SITELOG_DB) { try { const r = await sitelogApi.handle(req, env); if (r && r.ok) return r; } catch {} }
      return fetch(base + path, init);
    };
    const listRes = await call("/sites", { method: "GET", headers: hdr });
    const listJson = await listRes.json().catch(() => ({}));
    const sites = (listJson && listJson.sites) || [];
    const want = normName(siteName);
    const match = sites.find(s => normName(s.site_name || s.siteName || s.name) === want);
    if (!match) return false;   // geofence not created yet (best-effort — retried on next update)
    await call("/update-site", { method: "POST", headers: hdr, body: JSON.stringify({
      id: match.id, siteName: match.site_name || siteName, radius: match.radius_m || 500,
      siteRules: rules || "", siteRulesVisitor: visitorRules || "",
    }) });
    return true;
  } catch { return false; }
}

// Compute the To-Do list from the required-docs config + the current links +
// what actually exists, honouring any manual overrides stored in data.doneOverride.
function computeTodo(p, data, fileCount) {
  const req = data.required || {};
  const links = data.links || {};
  const done = data.doneOverride || {};
  const fin = data.contractValue != null && Number(data.contractValue) > 0;
  const out = [];
  for (const dt of DOC_TYPES) {
    if (!bool(req[dt.key])) continue;
    let auto = false;
    if (dt.key === "programme") auto = !!links.programmeId;
    else if (dt.key === "rams") auto = Array.isArray(links.ramsIds) && links.ramsIds.length > 0;
    else if (dt.key === "cpp") auto = !!links.cppRef;
    else if (dt.key === "valuations") auto = fin;
    else if (dt.key === "projectDocs") auto = fileCount > 0;
    const isDone = done[dt.key] === true || auto;
    out.push({ key: dt.key, label: dt.label, done: isDone, auto });
  }
  return out;
}

function projectView(row, data, fileCount) {
  return {
    id: row.id, number: row.number, name: row.name,
    siteClient: row.site_client, siteNumber: row.site_number,
    status: row.status || "live",
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    postcode: data.postcode || "", lat: data.lat ?? null, lon: data.lon ?? null,
    mileageRoundTrip: data.mileageRoundTrip ?? null, mileageOneWay: data.mileageOneWay ?? null,
    fromExisting: data.fromExisting || null,
    required: data.required || {},
    sitelog: data.sitelog || { rules: "", visitorRules: "", companies: [] },
    contractValue: data.contractValue ?? null,
    links: data.links || {},
    costingKey: (data.links && data.links.costingKey) || normName(row.name),
    visibleTo: Array.isArray(data.visibleTo) ? data.visibleTo : [],
    todo: computeTodo(row, data, fileCount),
  };
}

// Empty visibleTo (or missing) = visible to everyone with the Projects
// permission. A non-empty list restricts to those usernames (case-insensitive).
// FullAccess / ProjectsAdmin ALWAYS see every project regardless of the list —
// they're the ones managing it.
function canSeeProject(data, me, canManage) {
  if (canManage) return true;
  const list = Array.isArray(data && data.visibleTo) ? data.visibleTo : [];
  if (!list.length) return true;
  const u = String(me || "").toLowerCase();
  return list.some(v => String(v || "").toLowerCase() === u);
}
function sanitiseVisible(v) {
  if (!Array.isArray(v)) return [];
  const out = [], seen = new Set();
  for (const x of v) {
    const s = String(x || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

export async function handle(request, env, ctx, url, sess) {
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ── PUBLIC: stream a project document (signed URL) ────────────────────────
  if (path === "/project/doc" && method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith(`projectdocs/${tenantId}/`)) return error("Bad key", 400, env, request);
    if (!(await verifyFileSig(env, key, url.searchParams))) return error("Bad or expired link", 403, env, request);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return error("Not found", 404, env, request);
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set("Cache-Control", "private, max-age=300");
    h.set("Access-Control-Allow-Origin", "*");
    if (url.searchParams.get("dl")) h.set("Content-Disposition", `attachment; filename="${(key.split("/").pop() || "file").replace(/[^\w.\-]+/g, "_")}"`);
    return new Response(obj.body, { headers: h });
  }

  if (!sess) return error("Not authenticated", 401, env, request);
  const me = sess.user.username;
  const perms = await permissionsFor(env, tenantId, me);
  const canView = perms.FullAccess === "Yes" || perms.Projects === "Yes" || perms.ProjectsAdmin === "Yes";
  const canManage = perms.FullAccess === "Yes" || perms.ProjectsAdmin === "Yes";
  if (!canView) return error("Forbidden", 403, env, request);
  await ensureTables(env);

  const fileCountFor = async (pid) => {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM project_files WHERE tenant_id=? AND project_id=?").bind(db.tenantId, pid).first();
    return r ? Number(r.n) || 0 : 0;
  };
  const getRow = async (id) => db.prepare("SELECT * FROM projects WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
  const parse = (row) => { try { return row && row.data ? JSON.parse(row.data) : {}; } catch { return {}; } };

  // ── List projects ─────────────────────────────────────────────────────────
  if (path === "/projects/list" && method === "GET") {
    const status = url.searchParams.get("status") || "";
    const { results } = await db.prepare(
      "SELECT * FROM projects WHERE tenant_id=? ORDER BY created_at DESC"
    ).bind(db.tenantId).all();
    const counts = {};
    const { results: fc } = await db.prepare("SELECT project_id, COUNT(*) AS n FROM project_files WHERE tenant_id=? GROUP BY project_id").bind(db.tenantId).all();
    for (const r of fc || []) counts[r.project_id] = Number(r.n) || 0;
    let items = (results || [])
      .filter(row => canSeeProject(parse(row), me, canManage))
      .map(row => projectView(row, parse(row), counts[row.id] || 0));
    if (status) items = items.filter(p => (p.status || "live") === status);
    return json({ ok: true, projects: items }, {}, env, request);
  }

  // ── One project ───────────────────────────────────────────────────────────
  if (path === "/project/get" && method === "GET") {
    const row = await getRow(url.searchParams.get("id") || "");
    if (!row) return error("Project not found", 404, env, request);
    const data = parse(row);
    if (!canSeeProject(data, me, canManage)) return error("Project not found", 404, env, request);
    // Opportunistically heal an existing project whose PO-site push was missed
    // when it was created (idempotent add-only; PO_DB may not be bound yet).
    if (canManage) ctx?.waitUntil(pushSiteToPO(env, row.name));
    return json({ ok: true, project: projectView(row, data, await fileCountFor(row.id)), canManage }, {}, env, request);
  }

  // ── Create (the wizard save) ──────────────────────────────────────────────
  if (path === "/project/create" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    const number = String(b.number || "").trim();
    const siteNumber = String(b.siteNumber || number).trim();
    if (!name) return error("Project name required", 400, env, request);
    if (!number) return error("Project number required", 400, env, request);
    const costingKey = normName(name);
    const required = {};
    for (const dt of DOC_TYPES) required[dt.key] = bool(b.required && b.required[dt.key]);
    const companies = Array.isArray(b.sitelog && b.sitelog.companies)
      ? b.sitelog.companies.map(s => String(s || "").trim()).filter(Boolean).slice(0, 60) : [];
    const contractValue = b.contractValue != null && b.contractValue !== "" ? Number(b.contractValue) : null;
    const now = new Date().toISOString();
    const id = newId("PRJ");
    const data = {
      postcode: String(b.postcode || "").trim(),
      lat: b.lat != null && b.lat !== "" ? Number(b.lat) : null,
      lon: b.lon != null && b.lon !== "" ? Number(b.lon) : null,
      mileageRoundTrip: b.mileageRoundTrip != null && b.mileageRoundTrip !== "" ? Number(b.mileageRoundTrip) : null,
      mileageOneWay: b.mileageOneWay != null && b.mileageOneWay !== "" ? Number(b.mileageOneWay) : null,
      fromExisting: b.fromExisting || null,
      required,
      sitelog: { rules: String(b.sitelog && b.sitelog.rules || ""), visitorRules: String(b.sitelog && b.sitelog.visitorRules || ""), companies },
      contractValue,
      links: { programmeId: "", ramsIds: [], cppRef: "", costingKey },
      visibleTo: sanitiseVisible(b.visibleTo),
      doneOverride: {},
    };
    await db.prepare(`INSERT INTO projects (id, tenant_id, number, name, site_client, site_number, status, data, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, db.tenantId, number, name, String(b.siteClient || "projects"), siteNumber, "live", JSON.stringify(data), me, now, now
    ).run();
    // Valuations: seed the contract value into costing's proj_fin.
    if (required.valuations && contractValue) await setProjFinValue(db, costingKey, contractValue, name);
    // SiteLog arrival message (best-effort; the geofence was created by /add-site).
    if (data.sitelog.rules || data.sitelog.visitorRules) {
      ctx?.waitUntil(applySiteLogRules(env, name, data.sitelog.rules, data.sitelog.visitorRules));
    }
    // Register the project's site on the PO system so a PO raised here can
    // pick it — and once priced, its cost automatically appears against the
    // project in job-costing (costing.js matches po_log.site by name).
    ctx?.waitUntil(pushSiteToPO(env, name));
    const row = await getRow(id);
    return json({ ok: true, id, project: projectView(row, parse(row), 0) }, {}, env, request);
  }

  // ── Update (edit required/status/sitelog/companies/value) ─────────────────
  if (path === "/project/update" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await getRow(String(b.id || ""));
    if (!row) return error("Project not found", 404, env, request);
    const data = parse(row);
    let name = row.name, status = row.status;
    if (typeof b.name === "string" && b.name.trim()) name = b.name.trim().slice(0, 200);
    if (typeof b.status === "string" && ["live", "complete", "archived"].includes(b.status)) status = b.status;
    if (b.required && typeof b.required === "object") {
      data.required = data.required || {};
      for (const dt of DOC_TYPES) if (dt.key in b.required) data.required[dt.key] = bool(b.required[dt.key]);
    }
    if (b.sitelog && typeof b.sitelog === "object") {
      data.sitelog = data.sitelog || {};
      if (typeof b.sitelog.rules === "string") data.sitelog.rules = b.sitelog.rules;
      if (typeof b.sitelog.visitorRules === "string") data.sitelog.visitorRules = b.sitelog.visitorRules;
      if (Array.isArray(b.sitelog.companies)) data.sitelog.companies = b.sitelog.companies.map(s => String(s || "").trim()).filter(Boolean).slice(0, 60);
      ctx?.waitUntil(applySiteLogRules(env, name, data.sitelog.rules, data.sitelog.visitorRules));
    }
    if (b.contractValue !== undefined) {
      data.contractValue = b.contractValue === null || b.contractValue === "" ? null : Number(b.contractValue);
      const key = (data.links && data.links.costingKey) || normName(name);
      if (data.contractValue) await setProjFinValue(db, key, data.contractValue, name);
    }
    if (Array.isArray(b.visibleTo)) data.visibleTo = sanitiseVisible(b.visibleTo);
    await db.prepare("UPDATE projects SET name=?, status=?, data=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(name, status, JSON.stringify(data), new Date().toISOString(), db.tenantId, row.id).run();
    const fresh = await getRow(row.id);
    return json({ ok: true, project: projectView(fresh, parse(fresh), await fileCountFor(row.id)) }, {}, env, request);
  }

  // ── Link a built document to the project ──────────────────────────────────
  if (path === "/project/link" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await getRow(String(b.id || ""));
    if (!row) return error("Project not found", 404, env, request);
    const data = parse(row);
    data.links = data.links || { ramsIds: [] };
    const kind = String(b.kind || ""), value = String(b.value || "").trim();
    if (kind === "programme") data.links.programmeId = value;
    else if (kind === "cpp") data.links.cppRef = value;
    else if (kind === "rams") {
      data.links.ramsIds = Array.isArray(data.links.ramsIds) ? data.links.ramsIds : [];
      if (value && !data.links.ramsIds.includes(value)) data.links.ramsIds.push(value);
    } else if (kind === "rams-remove") {
      data.links.ramsIds = (data.links.ramsIds || []).filter(x => x !== value);
    } else return error("Unknown link kind", 400, env, request);
    await db.prepare("UPDATE projects SET data=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(data), new Date().toISOString(), db.tenantId, row.id).run();
    return json({ ok: true, links: data.links }, {}, env, request);
  }

  // ── Manual tick / untick a to-do item ─────────────────────────────────────
  if (path === "/project/todo" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await getRow(String(b.id || ""));
    if (!row) return error("Project not found", 404, env, request);
    const data = parse(row);
    data.doneOverride = data.doneOverride || {};
    const key = String(b.key || "");
    if (!DOC_TYPES.some(d => d.key === key)) return error("Unknown item", 400, env, request);
    if (b.done) data.doneOverride[key] = true; else delete data.doneOverride[key];
    await db.prepare("UPDATE projects SET data=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(data), new Date().toISOString(), db.tenantId, row.id).run();
    const fresh = await getRow(row.id);
    return json({ ok: true, todo: computeTodo(fresh, parse(fresh), await fileCountFor(row.id)) }, {}, env, request);
  }

  // ── Project documents ─────────────────────────────────────────────────────
  if (path === "/project/docs" && method === "GET") {
    const pid = url.searchParams.get("id") || "";
    if (!(await getRow(pid))) return error("Project not found", 404, env, request);
    const { results } = await db.prepare(
      "SELECT * FROM project_files WHERE tenant_id=? AND project_id=? ORDER BY uploaded_at DESC"
    ).bind(db.tenantId, pid).all();
    const origin = url.origin;
    const files = [];
    for (const f of results || []) {
      if (!canManage && f.hidden) continue;   // engineers never see hidden files
      files.push({
        id: f.id, title: f.title || f.name, name: f.name, section: f.section || "Documents",
        type: f.type || "", hidden: !!f.hidden, downloadable: f.downloadable !== 0,
        uploadedBy: f.uploaded_by, uploadedAt: f.uploaded_at,
        url: await signedFileUrl(env, origin, "/project/doc", f.r2_key, 86400),
      });
    }
    return json({ ok: true, files, canManage }, {}, env, request);
  }

  if (path === "/project/doc" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    const pid = form && String(form.get("id") || "");
    if (!file || !pid) return error("file and id required", 400, env, request);
    if (!(await getRow(pid))) return error("Project not found", 404, env, request);
    const safe = (file.name || "document").replace(/[^\w.\-]+/g, "_");
    const r2key = `projectdocs/${tenantId}/${pid}/${Date.now()}-${safe}`;
    await env.JOB_FILES.put(r2key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    const id = newId("PF");
    await db.prepare(`INSERT INTO project_files (id, tenant_id, project_id, title, section, r2_key, name, type, hidden, downloadable, uploaded_by, uploaded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, db.tenantId, pid, String(form.get("title") || file.name || "Document"),
      String(form.get("section") || "Documents"), r2key, file.name || safe, file.type || "",
      bool(form.get("hidden")) ? 1 : 0, form.get("downloadable") === "0" ? 0 : 1, me, new Date().toISOString()
    ).run();
    return json({ ok: true, id }, {}, env, request);
  }

  if (path === "/project/doc-update" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const f = await db.prepare("SELECT * FROM project_files WHERE tenant_id=? AND id=?").bind(db.tenantId, String(b.fileId || "")).first();
    if (!f) return error("File not found", 404, env, request);
    const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 200) : f.title;
    const hidden = b.hidden === undefined ? f.hidden : (bool(b.hidden) ? 1 : 0);
    const dl = b.downloadable === undefined ? f.downloadable : (bool(b.downloadable) ? 1 : 0);
    await db.prepare("UPDATE project_files SET title=?, hidden=?, downloadable=? WHERE tenant_id=? AND id=?")
      .bind(title, hidden, dl, db.tenantId, f.id).run();
    return json({ ok: true }, {}, env, request);
  }

  if (path === "/project/doc-delete" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const f = await db.prepare("SELECT * FROM project_files WHERE tenant_id=? AND id=?").bind(db.tenantId, String(b.fileId || "")).first();
    if (!f) return error("File not found", 404, env, request);
    try { await env.JOB_FILES.delete(f.r2_key); } catch {}
    await db.prepare("DELETE FROM project_files WHERE tenant_id=? AND id=?").bind(db.tenantId, f.id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── Create a job for this project (multi-engineer possible) ──────────────
  // Prefills the site from the project's own Pxxxx site, stamps job.projectId
  // so the project can list its jobs + roll visits per engineer, and starts
  // multi-engineer jobs (each on their own timer) via the SLA path everything
  // else uses. Returns { ok, id, ref, status }.
  if (path === "/project/create-job" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await getRow(String(b.id || ""));
    if (!row) return error("Project not found", 404, env, request);
    const data = parse(row);
    const description = String(b.description || "").trim();
    if (!description) return error("Description required", 400, env, request);
    const engineers = Array.isArray(b.engineers)
      ? b.engineers.map(s => String(s || "").trim()).filter(Boolean) : [];
    // Look up the project's own Pxxxx site for its address/postcode/coords, so
    // the created job carries all the site details engineers see (address,
    // directions) — same as picking it in add-job.html.
    let siteRow = null;
    try {
      siteRow = await env.DB.prepare(
        "SELECT site_number, site_name, postcode, data FROM sites WHERE tenant_id=? AND client='projects' AND site_number=?"
      ).bind(tenantId, row.number).first();
    } catch {}
    let siteData = {}; try { if (siteRow && siteRow.data) siteData = JSON.parse(siteRow.data); } catch {}
    const scheduledAt = b.scheduledAt && Number.isFinite(Date.parse(b.scheduledAt))
      ? new Date(b.scheduledAt).toISOString() : undefined;
    const durationMinutes = b.durationMinutes ? Math.max(15, Number(b.durationMinutes)) : undefined;
    const payload = {
      description,
      projectId: row.id,
      siteCode: row.number, siteName: row.name,
      storeType: "projects",
      address: (siteRow && [siteData.address1, siteData.town, siteData.county, siteRow.postcode].filter(Boolean).join(", ")) || "",
      telephone: siteData.telephone || siteData.phone || "",
      postcode: (siteRow && siteRow.postcode) || data.postcode || "",
      lat: data.lat != null ? data.lat : (siteData.lat != null ? siteData.lat : undefined),
      lon: data.lon != null ? data.lon : (siteData.lng != null ? siteData.lng : (siteData.lon != null ? siteData.lon : undefined)),
      mileageFromHQ: data.mileageOneWay != null ? data.mileageOneWay : undefined,
      assignedEngineers: engineers,
      scheduledAt, durationMinutes,
      // Projects default all four gates OFF (RA/sig/photo/note) — matches the
      // add-job.html Projects rule. Explicit values from the form still win.
      requiresRA: b.requiresRA === true, requiresSignature: b.requiresSignature === true,
      requiresPhoto: b.requiresPhoto === true, requiresNote: b.requiresNote === true,
      changedBy: me,
    };
    const job = await createOrUpdateJobFromPayload(env, tenantId, payload);
    ctx?.waitUntil(reconcileRelease(env, tenantId, job).catch(() => {}));
    // notifyNewlyAssigned(before, after): brand-new job → before is null so the
    // release reconciler above sends the assignment push.
    return json({ ok: true, id: job.id, ref: job.helpdeskRef, status: job.status }, {}, env, request);
  }

  // ── Site visits for this project (jobs + per-engineer time segments) ──────
  // Anyone with the Projects perm can call; a non-manager sees ONLY their own
  // visits (perUserSummary is admin-only). Visits come from job_time_segments,
  // not SiteLog — status-tap timing works whether the site was scanned or not.
  if (path === "/project/visits" && method === "GET") {
    const row = await getRow(url.searchParams.get("id") || "");
    if (!row) return error("Project not found", 404, env, request);
    const dataP = parse(row);
    if (!canSeeProject(dataP, me, canManage)) return error("Project not found", 404, env, request);

    // Match a job to THIS project by projectId first, else by site (name /
    // number / project's own Pxxxx site code) so legacy jobs still roll up.
    const wantName = String(row.name || "").toLowerCase();
    const wantNum = String(row.number || "").toLowerCase();
    const all = await listJobs(env, tenantId);
    const projectJobs = all.filter(j => {
      if (String(j.projectId || "") === row.id) return true;
      const sc = String(j.siteCode || "").toLowerCase(), sn = String(j.siteName || "").toLowerCase();
      return (wantNum && (sc === wantNum || sn === wantNum)) || (wantName && sn === wantName);
    });
    const jobIds = projectJobs.map(j => String(j.id));
    if (!jobIds.length) return json({ ok: true, canManage, jobs: [], visits: [], perUser: [] }, {}, env, request);

    // Fetch time segments for those jobs. UNION of one prepared statement per id
    // works fine (job count on a project is small) — and dodges IN(?,?…) binding.
    const segs = [];
    for (const jid of jobIds) {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, username, job_id, job_ref, started_at, ended_at, kind FROM job_time_segments WHERE tenant_id=? AND job_id=? ORDER BY started_at"
        ).bind(tenantId, jid).all();
        for (const s of results || []) segs.push(s);
      } catch {}
    }
    const dayOf = iso => String(iso || "").slice(0, 10);
    const minsOf = (a, b) => {
      const s = Date.parse(a || ""), e = Date.parse(b || "");
      if (!Number.isFinite(s)) return 0;
      const end = Number.isFinite(e) ? e : Date.now();
      return Math.max(0, Math.round((end - s) / 60000));
    };
    // Group by (username, day, jobId) → one visit row per engineer per day per
    // job. Multiple segments on the same day merge into one row.
    const visitMap = new Map();   // key -> { date, user, jobId, jobRef, onsiteMins, travelMins, live:bool }
    for (const s of segs) {
      const user = s.username || "";
      const date = dayOf(s.started_at);
      const key = user + "|" + date + "|" + s.job_id;
      let v = visitMap.get(key);
      if (!v) { v = { date, user, jobId: s.job_id, jobRef: s.job_ref || "", onsiteMins: 0, travelMins: 0, live: false }; visitMap.set(key, v); }
      const m = minsOf(s.started_at, s.ended_at);
      if ((s.kind || "onsite") === "travel") v.travelMins += m; else v.onsiteMins += m;
      if (!s.ended_at) v.live = true;
    }
    const meLower = String(me).toLowerCase();
    const normId = u => String(u || "").toLowerCase().replace(/\s+/g, ".").trim();
    let visits = Array.from(visitMap.values()).sort((a, b) => (b.date + b.user).localeCompare(a.date + a.user));
    if (!canManage) {
      // Field/engineer view: only their own visits (match on either username or
      // the dotted form some legacy records carry).
      const meNorm = normId(me);
      visits = visits.filter(v => v.user.toLowerCase() === meLower || normId(v.user) === meNorm);
    }
    const perUser = [];
    if (canManage) {
      const byU = new Map();
      for (const v of Array.from(visitMap.values())) {
        let r = byU.get(v.user);
        if (!r) { r = { user: v.user, visits: 0, days: new Set(), onsiteMins: 0, travelMins: 0 }; byU.set(v.user, r); }
        r.visits++; r.days.add(v.date); r.onsiteMins += v.onsiteMins; r.travelMins += v.travelMins;
      }
      for (const r of byU.values()) perUser.push({ user: r.user, visits: r.visits, days: r.days.size, onsiteMins: r.onsiteMins, travelMins: r.travelMins });
      perUser.sort((a, b) => (b.onsiteMins + b.travelMins) - (a.onsiteMins + a.travelMins));
    }
    // Compact job list for the page (title/status/schedule + who's on it).
    const jobs = projectJobs.map(j => ({
      id: j.id, ref: j.helpdeskRef || j.id, description: j.description || "",
      status: j.status || "Pending", scheduledAt: j.scheduledAt || null,
      engineers: Array.isArray(j.assignedEngineers) && j.assignedEngineers.length
        ? j.assignedEngineers : (j.assignedTo ? [j.assignedTo] : []),
      firestopping: !!j.firestopping, investigateOnly: !!j.investigateOnly,
    })).sort((a, b) => String(b.scheduledAt || "").localeCompare(String(a.scheduledAt || "")));
    return json({ ok: true, canManage, jobs, visits, perUser }, {}, env, request);
  }

  // ── Manual costs: labour shifts + material entries ────────────────────────
  // Admins add labour (hours × rate → auto-cost) and materials (£ ex-VAT) that
  // aren't captured elsewhere (no PO raised, no status-tap timing). Folded
  // into the project's site totals by costing.js.
  if (path === "/project/costs" && method === "GET") {
    const pid = url.searchParams.get("id") || "";
    if (!(await getRow(pid))) return error("Project not found", 404, env, request);
    const { results } = await env.DB.prepare(
      "SELECT * FROM project_costs WHERE tenant_id=? AND project_id=? ORDER BY date DESC, created_at DESC"
    ).bind(tenantId, pid).all();
    const rows = (results || []).map(r => ({
      id: r.id, kind: r.kind, date: r.date, username: r.username || "",
      hours: r.hours != null ? Number(r.hours) : null, rate: r.rate != null ? Number(r.rate) : null,
      supplier: r.supplier || "", description: r.description || "",
      amount: Number(r.amount) || 0, createdBy: r.created_by, createdAt: r.created_at,
    }));
    return json({ ok: true, costs: rows, canManage }, {}, env, request);
  }
  if (path === "/project/cost" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await getRow(String(b.id || ""));
    if (!row) return error("Project not found", 404, env, request);
    const kind = b.kind === "material" ? "material" : "labour";
    const date = /^\d{4}-\d{2}-\d{2}/.test(String(b.date || "")) ? String(b.date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const description = String(b.description || "").slice(0, 400);
    let username = "", hours = null, rate = null, amount = 0, supplier = "";
    if (kind === "labour") {
      username = String(b.username || "").trim();
      if (!username) return error("Engineer required", 400, env, request);
      hours = Number(b.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return error("Hours must be between 0 and 24", 400, env, request);
      // Rate: explicit override else engts:cfg (per-user or default). A missing
      // rate is allowed but the row will cost nothing — flagged in the UI so
      // the admin knows to type one or set the engineer's rate.
      const explicit = Number(b.rate);
      if (Number.isFinite(explicit) && explicit > 0) rate = explicit;
      else { const rates = await ratesMap(env, tenantId); const r = rates[username]; rate = r && r.rateType === "hour" ? r.rate : null; }
      amount = rate ? Math.round(hours * rate * 100) / 100 : 0;
    } else {
      supplier = String(b.supplier || "").trim().slice(0, 120);
      const amt = Number(b.amount);
      if (!Number.isFinite(amt) || amt <= 0) return error("Amount required", 400, env, request);
      amount = Math.round(amt * 100) / 100;
      if (!description) return error("Description required", 400, env, request);
    }
    const id = newId("PC");
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO project_costs
      (id, tenant_id, project_id, kind, date, username, hours, rate, supplier, description, amount, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, tenantId, row.id, kind, date, username, hours, rate, supplier, description, amount, me, now
    ).run();
    return json({ ok: true, id, amount }, {}, env, request);
  }
  if (path === "/project/cost-delete" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const id = String(b.costId || "");
    if (!id) return error("costId required", 400, env, request);
    await env.DB.prepare("DELETE FROM project_costs WHERE tenant_id=? AND id=?").bind(tenantId, id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── Push this project's site to the PO system (manual heal) ───────────────
  if (path === "/project/push-po" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await getRow(String(b.id || ""));
    if (!row) return error("Project not found", 404, env, request);
    const ok = await pushSiteToPO(env, row.name);
    return json({ ok, poBound: !!env.PO_DB }, {}, env, request);
  }

  // ── Delete a whole project (record only; the project-site is kept) ────────
  if (path === "/project/delete" && method === "POST") {
    if (!canManage) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await getRow(String(b.id || ""));
    if (!row) return error("Project not found", 404, env, request);
    const { results } = await db.prepare("SELECT r2_key FROM project_files WHERE tenant_id=? AND project_id=?").bind(db.tenantId, row.id).all();
    for (const f of results || []) { try { await env.JOB_FILES.delete(f.r2_key); } catch {} }
    await db.prepare("DELETE FROM project_files WHERE tenant_id=? AND project_id=?").bind(db.tenantId, row.id).run();
    await db.prepare("DELETE FROM projects WHERE tenant_id=? AND id=?").bind(db.tenantId, row.id).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown projects route", 404, env, request);
}
