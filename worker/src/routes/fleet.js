// Fleet reports — save/list/open/delete generated reports, plus the persistent
// reg→driver mapping the generator page uses.
//
//   GET  /fleet/drivers                 { map: { reg: username } }  (remembered)
//   POST /fleet/drivers { map }         save the reg→driver mapping (Vehicles)
//   POST /fleet/report  (multipart)     save a generated report HTML to R2
//   GET  /fleet/reports                 list saved reports (signed open URLs)
//   GET  /fleet/report?key=&sig=        stream a saved report (public + signed)
//   POST /fleet/report-delete { key }   delete a saved report
//
// Reports are self-contained HTML, stored in R2 (JOB_FILES) under a
// tenant-prefixed key and opened via a signed, expiring URL (same protection as
// documents). Gated by the Vehicles permission (or Full access).

import { corsHeaders } from "../lib/http.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor } from "../lib/auth.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { sendToUser } from "./push.js";

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
async function canFleet(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes" || p.Vehicles === "Yes";
}
const DKEY = tid => `fleet:drivers:${tid}`;
const CKEY = tid => `fleet:vehcover:${tid}`;   // { REGNORM: photoKey } — chosen cover per van
const prefix = tid => `fleetreports/${tid}/`;
const regKey = reg => String(reg).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const vdocPrefix = (tid, reg) => `vehicledocs/${tid}/${regKey(reg)}/`;
const vphotoPrefix = (tid, reg) => `vehiclephotos/${tid}/${regKey(reg)}/`;
const vphotoRoot = tid => `vehiclephotos/${tid}/`;
const vmaintPrefix = (tid, reg) => `vehiclemaint/${tid}/${regKey(reg)}/`;   // maintenance-record documents

const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Maintenance categories (Tyres / Service / Brakes …). A managed list per
// tenant in app_config, each with a colour for the chart; falls back to a
// sensible default set until the office customises it.
const MCATS_KEY = tid => `fleet:maintcats:${tid}`;
const DEFAULT_MAINT_CATS = [
  { name: "Service",    colour: "#2563eb" },
  { name: "MOT",        colour: "#7c3aed" },
  { name: "Tyres",      colour: "#0891b2" },
  { name: "Brakes",     colour: "#dc2626" },
  { name: "Windscreen", colour: "#0d9488" },
  { name: "Bodywork",   colour: "#ea580c" },
  { name: "Electrical", colour: "#ca8a04" },
  { name: "Battery",    colour: "#65a30d" },
  { name: "Repair",     colour: "#db2777" },
  { name: "Other",      colour: "#64748b" },
];
async function maintCats(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(MCATS_KEY(tid)).first();
    if (row && row.value) { const a = JSON.parse(row.value); if (Array.isArray(a) && a.length) return a; }
  } catch {}
  return DEFAULT_MAINT_CATS;
}

// Username → display name map (for check/handover listings).
async function nameMap(env, tid) {
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of results || []) out[u.username] = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
  } catch {}
  return out;
}

// ── Van Handover: a detailed condition check sent to a newly-assigned driver.
// Its own template (editable via app_config, defaults below), and its own table
// vehicle_handovers. Photos + the signature go to ASSET_BUCKET under
// handover/<user>/<id>/… (served by the public /asset-image + /asset-thumb).
const HANDOVER_TPL_KEY = tid => `handover:template:${tid}`;
const DEFAULT_HANDOVER = {
  checklist: [
    { id: "exterior", label: "Exterior bodywork condition (walk all sides)" },
    { id: "glass", label: "Windscreen, windows & mirrors" },
    { id: "lights", label: "Lights & indicators" },
    { id: "tyres", label: "Tyres & wheels (tread & condition)" },
    { id: "wipers", label: "Wipers & washers" },
    { id: "oil", label: "Engine oil level" },
    { id: "coolant", label: "Coolant level" },
    { id: "screenwash", label: "Screen wash level" },
    { id: "brakes", label: "Brakes & handbrake" },
    { id: "horn", label: "Horn" },
    { id: "seatbelts", label: "Seatbelts" },
    { id: "dash", label: "Dashboard warning lights (none showing)" },
    { id: "interior", label: "Interior condition & cleanliness" },
    { id: "load", label: "Load area & racking condition" },
  ],
  equipment: [
    { id: "spare_wheel", label: "Spare wheel" },
    { id: "jack", label: "Jack" },
    { id: "tyre_tools", label: "Tyre changing tools (wheel brace)" },
    { id: "locking_nut", label: "Locking wheel-nut key" },
    { id: "warning_triangle", label: "Warning triangle" },
    { id: "hi_vis", label: "Hi-vis vest" },
    { id: "first_aid", label: "First aid kit" },
    { id: "fire_ext", label: "Fire extinguisher" },
  ],
  photoSlots: [
    { id: "front", label: "Front", required: true },
    { id: "rear", label: "Rear", required: true },
    { id: "nearside", label: "Nearside (passenger side)", required: true },
    { id: "offside", label: "Offside (driver side)", required: true },
    { id: "dashcam", label: "Dashboard & mileage", required: true },
    { id: "cab", label: "Cab interior", required: true },
    { id: "loadarea", label: "Load area", required: false },
  ],
};
async function handoverTemplate(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(HANDOVER_TPL_KEY(tid)).first();
    if (row && row.value) { const t = JSON.parse(row.value); if (t && Array.isArray(t.checklist)) return { ...DEFAULT_HANDOVER, ...t }; }
  } catch {}
  return DEFAULT_HANDOVER;
}
async function ensureHandoverTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicle_handovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    reg TEXT NOT NULL, username TEXT NOT NULL, status TEXT DEFAULT 'pending',
    requested_by TEXT, requested_at TEXT, completed_at TEXT,
    mileage TEXT, safe_to_drive INTEGER, note TEXT, items TEXT)`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_handover_reg ON vehicle_handovers(tenant_id,reg)").run(); } catch {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_handover_user ON vehicle_handovers(tenant_id,username,status)").run(); } catch {}
}
// data:image/... base64 → ASSET_BUCKET key under handover/<user>/<id>/. Returns
// an already-stored key untouched (idempotent resubmit). 5 MB cap per image.
async function storeHandoverImg(env, userDir, id, tag, p, nRef) {
  if (typeof p === "string" && /^handover\//.test(p)) return p;
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(p || "");
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > 5 * 1024 * 1024) return null;
  const key = `handover/${userDir}/${id}/${tag}-${++nRef.n}-${crypto.randomUUID().slice(0, 8)}.${m[1] === "jpeg" ? "jpg" : "png"}`;
  await env.ASSET_BUCKET.put(key, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
  return key;
}

// Load the chosen-cover map ({ REGNORM: photoKey }) for a tenant.
async function coverMap(env, tid) {
  try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(CKEY(tid)).first(); if (row && row.value) return JSON.parse(row.value) || {}; } catch {}
  return {};
}
async function saveCoverMap(env, tid, map) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, CKEY(tid), JSON.stringify(map)).run();
}
// One R2 list for the whole fleet's photos, grouped by van (newest first).
async function photoIndex(env, tid) {
  const out = {};   // REGNORM -> [{ key, at }]  (newest first)
  try {
    const listed = await env.JOB_FILES.list({ prefix: vphotoRoot(tid), include: ["customMetadata"] });
    for (const o of listed.objects || []) {
      const parts = o.key.split("/");            // vehiclephotos/<tid>/<REG>/<file>
      const reg = parts[2]; if (!reg) continue;
      const at = (o.customMetadata && o.customMetadata.at) || (o.uploaded ? new Date(o.uploaded).toISOString() : "");
      (out[reg] = out[reg] || []).push({ key: o.key, at, name: (o.customMetadata && o.customMetadata.name) || parts.slice(-1)[0], by: (o.customMetadata && o.customMetadata.by) || "" });
    }
    for (const reg of Object.keys(out)) out[reg].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  } catch {}
  return out;
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  const tid = sess ? sess.tenantId : await resolveTenantId(env, request);
  const sub = url.pathname.replace(/^\/fleet(?=\/|$)/, "") || "/";
  const q = url.searchParams;

  // ── Open a saved report (public, but access-gated by the signature) ────────
  if (sub === "/report" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("fleetreports/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, max-age=3600"
    }});
  }

  // ── Open a vehicle document (public, but access-gated by the signature) ────
  if (sub === "/vehicle-doc" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("vehicledocs/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  // ── Open a maintenance-record document (public, but signature-gated) ───────
  if (sub === "/maintenance-doc" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("vehiclemaint/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  // ── Open a vehicle photo (public, but access-gated by the signature) ───────
  if (sub === "/vehicle-photo" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("vehiclephotos/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  // Everything else needs a fleet-permitted session.
  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  if (!(await canFleet(env, tid, sess))) return jr({ error: "Forbidden" }, headers, 403);

  // ── Reg → driver mapping (remembered across sessions/devices) ──────────────
  if (sub === "/drivers" && method === "GET") {
    let map = {};
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(DKEY(tid)).first(); if (row && row.value) map = JSON.parse(row.value) || {}; } catch {}
    return jr({ ok: true, map }, headers);
  }
  if (sub === "/drivers" && method === "POST") {
    const b = await readJson(request);
    const map = (b && b.map && typeof b.map === "object") ? b.map : {};
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, DKEY(tid), JSON.stringify(map)).run();
    return jr({ ok: true, map }, headers);
  }

  // ── Save a generated report ────────────────────────────────────────────────
  if (sub === "/report" && method === "POST") {
    const form = await request.formData();
    const file = form.get("html");
    if (!file) return jr({ error: "Missing report" }, headers, 400);
    const weekStart = String(form.get("weekStart") || "");
    const key = `${prefix(tid)}${Date.now()}-${(weekStart || "report").replace(/[^0-9-]/g, "")}.html`;
    await env.JOB_FILES.put(key, typeof file.stream === "function" ? file.stream() : file, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: {
        title: String(form.get("title") || "Fleet report").slice(0, 160),
        weekStart, weekEnd: String(form.get("weekEnd") || ""),
        by: sess.user.username, at: new Date().toISOString()
      }
    });
    return jr({ ok: true, key }, headers, 201);
  }

  // ── List saved reports ─────────────────────────────────────────────────────
  if (sub === "/reports" && method === "GET") {
    const listed = await env.JOB_FILES.list({ prefix: prefix(tid), include: ["customMetadata"] });
    const reports = [];
    for (const o of listed.objects || []) {
      const m = o.customMetadata || {};
      reports.push({
        key: o.key, title: m.title || "Fleet report", weekStart: m.weekStart || "", weekEnd: m.weekEnd || "",
        by: m.by || "", at: m.at || (o.uploaded ? new Date(o.uploaded).toISOString() : ""), size: o.size,
        url: await signedFileUrl(env, url.origin, "/fleet/report", o.key)
      });
    }
    reports.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return jr({ ok: true, reports }, headers);
  }

  // ── Delete a saved report ──────────────────────────────────────────────────
  if (sub === "/report-delete" && method === "POST") {
    const { key } = await readJson(request);
    if (!key || !String(key).startsWith("fleetreports/")) return jr({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    return jr({ ok: true }, headers);
  }

  // ── Central driver-assignment registry (with history) ─────────────────────
  // Source of truth for "who drives which vehicle, when". Van checks read the
  // synced users.vehicle_assigned; the Fleet Report reads /fleet/current.
  if (sub === "/current" || sub === "/assignments" || sub === "/assign") {
    await ensureAssignTable(env);
    if (method === "GET") await seedAssignments(env, tid);

    if (sub === "/current" && method === "GET") {
      const week = q.get("week");
      let rows;
      if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) {
        const d = new Date(week + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 6);
        const wkEnd = d.toISOString().slice(0, 10);
        rows = (await env.DB.prepare(
          "SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND start_date<=? AND (end_date IS NULL OR end_date>=?) ORDER BY start_date"
        ).bind(tid, wkEnd, week).all()).results;
      } else {
        rows = (await env.DB.prepare("SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND end_date IS NULL").bind(tid).all()).results;
      }
      const map = {}; for (const r of rows || []) map[r.reg] = r.username;
      return jr({ ok: true, map }, headers);
    }

    if (sub === "/assignments" && method === "GET") {
      const reg = q.get("reg");
      if (reg) {
        const history = (await env.DB.prepare(
          "SELECT reg, username, start_date, end_date, assigned_by, at FROM vehicle_assignments WHERE tenant_id=? AND reg=? ORDER BY start_date DESC, id DESC"
        ).bind(tid, reg).all()).results;
        return jr({ ok: true, history: history || [] }, headers);
      }
      const current = (await env.DB.prepare("SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND end_date IS NULL").bind(tid).all()).results;
      return jr({ ok: true, current: current || [] }, headers);
    }

    if (sub === "/assign" && method === "POST") {
      const b = await readJson(request);
      const reg = String(b.reg || "").trim();
      const username = String(b.username || "").trim();
      const from = /^\d{4}-\d{2}-\d{2}$/.test(b.fromDate || "") ? b.fromDate : new Date().toISOString().slice(0, 10);
      if (!reg) return jr({ error: "reg required" }, headers, 400);
      const now = new Date().toISOString();
      // End the vehicle's current driver, and clear that person's vehicle field.
      await env.DB.prepare("UPDATE vehicle_assignments SET end_date=? WHERE tenant_id=? AND reg=? AND end_date IS NULL").bind(from, tid, reg).run();
      await env.DB.prepare("UPDATE users SET vehicle_assigned='' WHERE tenant_id=? AND vehicle_assigned=?").bind(tid, reg).run();
      if (username) {
        // The new driver moves off any other van they currently hold.
        await env.DB.prepare("UPDATE vehicle_assignments SET end_date=? WHERE tenant_id=? AND username=? AND end_date IS NULL").bind(from, tid, username).run();
        await env.DB.prepare("INSERT INTO vehicle_assignments (tenant_id, reg, username, start_date, end_date, assigned_by, at) VALUES (?,?,?,?,?,?,?)")
          .bind(tid, reg, username, from, null, sess.user.username, now).run();
        await env.DB.prepare("UPDATE users SET vehicle_assigned=? WHERE tenant_id=? AND username=?").bind(reg, tid, username).run();
      }
      return jr({ ok: true }, headers);
    }
  }

  // ── Vehicle registry (MOT / tax / service now in the portal) ──────────────
  if (sub === "/vehicles" && method === "GET") {
    await ensureVehTable(env); await ensureAssignTable(env); await seedAssignments(env, tid);
    const { results } = await env.DB.prepare("SELECT * FROM vehicles WHERE tenant_id=?").bind(tid).all();
    const cur = (await env.DB.prepare("SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND end_date IS NULL").bind(tid).all()).results;
    const dn = s => String(s || "").replace(/\s+/g, "").toUpperCase();
    const drv = {}; for (const r of cur || []) drv[dn(r.reg)] = r.username;
    const miles = await latestMileage(env, tid);
    const photos = await photoIndex(env, tid);
    const covers = await coverMap(env, tid);
    // Handover state per reg: latest completed (for the card's direct link) +
    // whether one is still pending (a badge / "awaiting handover" hint).
    await ensureHandoverTable(env);
    const hoRows = (await env.DB.prepare("SELECT id, reg, status, completed_at FROM vehicle_handovers WHERE tenant_id=?").bind(tid).all()).results || [];
    const lastHo = {}, pendHo = {};
    for (const h of hoRows) {
      const k = dn(h.reg);
      if (h.status === "done") { const cur = lastHo[k]; if (!cur || new Date(h.completed_at || 0) > new Date(cur.at || 0)) lastHo[k] = { id: h.id, at: h.completed_at || "" }; }
      else if (h.status === "pending") pendHo[k] = (pendHo[k] || 0) + 1;
    }
    const vehicles = await Promise.all((results || []).map(async v => {
      const cm = miles[dn(v.reg)] || null;
      const sv = serviceView(v, cm);
      // Cover photo for the card: the manually-chosen one if it still exists, else newest.
      const pics = photos[dn(v.reg)] || [];
      let coverKey = covers[dn(v.reg)];
      if (!coverKey || !pics.some(p => p.key === coverKey)) coverKey = pics.length ? pics[0].key : "";
      return {
        reg: v.reg, make: v.make, model: v.model, fuel: v.fuel, active: v.active !== 0,
        motDue: v.mot_due || "", taxDue: v.tax_due || "", nextServiceDate: sv.dueDate || "",
        notes: v.notes || "", driver: drv[dn(v.reg)] || "",
        svcIntervalDays: v.svc_interval_days || null, svcIntervalMiles: v.svc_interval_miles || null,
        lastServiceDate: v.last_service_date || "", lastServiceMiles: v.last_service_miles != null ? v.last_service_miles : null,
        warnDays: sv.warnDays, warnMiles: sv.warnMiles,
        serviceDueMiles: sv.dueMiles, serviceStatus: sv.status, serviceReason: sv.reason,
        currentMiles: cm ? cm.miles : null, milesAt: cm ? cm.at : "",
        specs: parseJson(v.specs, []),
        photoCount: pics.length,
        photoUrl: coverKey ? await signedFileUrl(env, url.origin, "/fleet/vehicle-photo", coverKey) : "",
        lastHandoverId: (lastHo[dn(v.reg)] || {}).id || null,
        lastHandoverAt: (lastHo[dn(v.reg)] || {}).at || "",
        pendingHandover: pendHo[dn(v.reg)] || 0
      };
    }));
    // Apply the saved manual order (drag-to-reorder); unknown regs fall to the
    // end alphabetically so newly-added vans still appear.
    let order = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:vehorder:${tid}`).first(); if (row && row.value) order = JSON.parse(row.value) || []; } catch {}
    const oidx = {}; order.forEach((r, i) => oidx[dn(r)] = i);
    vehicles.sort((a, b) => {
      const ia = oidx[dn(a.reg)], ib = oidx[dn(b.reg)];
      if (ia == null && ib == null) return String(a.reg).localeCompare(String(b.reg));
      if (ia == null) return 1;
      if (ib == null) return -1;
      return ia - ib;
    });
    return jr({ ok: true, vehicles }, headers);
  }
  if ((sub === "/vehicle" || sub === "/vehicles-import") && method === "POST") {
    await ensureVehTable(env);
    const b = await readJson(request);
    const list = sub === "/vehicles-import" ? (b.vehicles || []) : [b];
    const num = x => { const n = parseInt(String(x == null ? "" : x).replace(/[^0-9]/g, ""), 10); return isNaN(n) ? null : n; };
    let count = 0;
    for (const v of list) {
      const reg = String(v.reg || "").trim(); if (!reg) continue;
      await env.DB.prepare(`INSERT INTO vehicles
        (tenant_id,reg,make,model,fuel,active,mot_due,tax_due,next_service,notes,
         svc_interval_days,svc_interval_miles,last_service_date,last_service_miles,warn_days,warn_miles,at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,reg) DO UPDATE SET
        make=excluded.make,model=excluded.model,fuel=excluded.fuel,active=excluded.active,
        mot_due=excluded.mot_due,tax_due=excluded.tax_due,next_service=excluded.next_service,notes=excluded.notes,
        svc_interval_days=excluded.svc_interval_days,svc_interval_miles=excluded.svc_interval_miles,
        last_service_date=excluded.last_service_date,last_service_miles=excluded.last_service_miles,
        warn_days=excluded.warn_days,warn_miles=excluded.warn_miles,at=excluded.at`)
        .bind(tid, reg, v.make || "", v.model || "", v.fuel || "", v.active === false ? 0 : 1,
          v.motDue || v.motDate || "", v.taxDue || v.taxDate || "", v.nextServiceDate || v.serviceDate || "", v.notes || "",
          num(v.svcIntervalDays), num(v.svcIntervalMiles), v.lastServiceDate || "", num(v.lastServiceMiles),
          num(v.warnDays), num(v.warnMiles), new Date().toISOString()).run();
      // Extra spec fields (AC, payload, dimensions, handsfree …) are stored as a
      // JSON array of {label,value}. Only written when supplied, so the legacy
      // import (which carries no specs) never wipes an existing vehicle's specs.
      if (v.specs !== undefined) {
        const specsStr = typeof v.specs === "string" ? v.specs : JSON.stringify(Array.isArray(v.specs) ? v.specs : []);
        await env.DB.prepare("UPDATE vehicles SET specs=? WHERE tenant_id=? AND reg=?").bind(specsStr, tid, reg).run();
      }
      count++;
    }
    return jr({ ok: true, count }, headers);
  }
  if (sub === "/vehicle-delete" && method === "POST") {
    const b = await readJson(request); const reg = String(b.reg || "").trim();
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    await env.DB.prepare("DELETE FROM vehicles WHERE tenant_id=? AND reg=?").bind(tid, reg).run();
    // Tidy up: close any open assignments + delete the vehicle's uploaded documents.
    await env.DB.prepare("UPDATE vehicle_assignments SET end_date=? WHERE tenant_id=? AND reg=? AND end_date IS NULL")
      .bind(new Date().toISOString().slice(0, 10), tid, reg).run();
    try {
      const listed = await env.JOB_FILES.list({ prefix: vdocPrefix(tid, reg) });
      for (const o of listed.objects || []) await env.JOB_FILES.delete(o.key);
      const pics = await env.JOB_FILES.list({ prefix: vphotoPrefix(tid, reg) });
      for (const o of pics.objects || []) await env.JOB_FILES.delete(o.key);
      const maint = await env.JOB_FILES.list({ prefix: vmaintPrefix(tid, reg) });
      for (const o of maint.objects || []) await env.JOB_FILES.delete(o.key);
    } catch {}
    try { await ensureMaintTable(env); await env.DB.prepare("DELETE FROM vehicle_maintenance WHERE tenant_id=? AND reg=?").bind(tid, reg).run(); } catch {}
    // Handover records + their photos/signatures (keyed by driver+id in ASSET_BUCKET).
    try {
      await ensureHandoverTable(env);
      const hos = (await env.DB.prepare("SELECT id, username FROM vehicle_handovers WHERE tenant_id=? AND reg=?").bind(tid, reg).all()).results || [];
      for (const h of hos) {
        const ud = String(h.username).replace(/[^A-Za-z0-9._-]/g, "_");
        try { const l = await env.ASSET_BUCKET.list({ prefix: `handover/${ud}/${h.id}/` }); for (const o of l.objects || []) await env.ASSET_BUCKET.delete(o.key); } catch {}
      }
      await env.DB.prepare("DELETE FROM vehicle_handovers WHERE tenant_id=? AND reg=?").bind(tid, reg).run();
    } catch {}
    try { const covers = await coverMap(env, tid); if (covers[regKey(reg)]) { delete covers[regKey(reg)]; await saveCoverMap(env, tid, covers); } } catch {}
    return jr({ ok: true }, headers);
  }

  // ── Manual card order (drag-to-reorder on the Vehicles page) ──────────────
  if (sub === "/vehicle-order" && method === "GET") {
    let order = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:vehorder:${tid}`).first(); if (row && row.value) order = JSON.parse(row.value) || []; } catch {}
    return jr({ ok: true, order }, headers);
  }
  if (sub === "/vehicle-order" && method === "POST") {
    const b = await readJson(request);
    const order = Array.isArray(b.order) ? b.order.map(String) : [];
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, `fleet:vehorder:${tid}`, JSON.stringify(order)).run();
    return jr({ ok: true }, headers);
  }

  // ── Vehicle documents (repair invoices, receipts) ─────────────────────────
  if (sub === "/vehicle-docs" && method === "GET") {
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const listed = await env.JOB_FILES.list({ prefix: vdocPrefix(tid, reg), include: ["customMetadata"] });
    const docs = [];
    for (const o of listed.objects || []) {
      const m = o.customMetadata || {};
      docs.push({
        key: o.key, name: m.name || o.key.split("/").pop(), by: m.by || "",
        at: m.at || (o.uploaded ? new Date(o.uploaded).toISOString() : ""), size: o.size,
        url: await signedFileUrl(env, url.origin, "/fleet/vehicle-doc", o.key)
      });
    }
    docs.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return jr({ ok: true, docs }, headers);
  }
  if (sub === "/vehicle-doc" && method === "POST") {
    const form = await request.formData();
    const reg = String(form.get("reg") || "").trim();
    const file = form.get("file");
    if (!reg || !file) return jr({ error: "reg and file required" }, headers, 400);
    const safe = String(file.name || "document").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const key = `${vdocPrefix(tid, reg)}${Date.now()}-${safe}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { name: file.name || safe, by: sess.user.username, at: new Date().toISOString() }
    });
    return jr({ ok: true, key, url: await signedFileUrl(env, url.origin, "/fleet/vehicle-doc", key) }, headers, 201);
  }
  if (sub === "/vehicle-doc-delete" && method === "POST") {
    const b = await readJson(request); const key = String(b.key || "");
    if (!key || !key.startsWith("vehicledocs/")) return jr({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    return jr({ ok: true }, headers);
  }

  // ── Maintenance categories (managed list + colours for the charts) ────────
  if (sub === "/maint-categories" && method === "GET") {
    return jr({ ok: true, categories: await maintCats(env, tid) }, headers);
  }
  if (sub === "/maint-categories" && method === "POST") {
    const b = await readJson(request);
    const seen = new Set(), out = [];
    for (const c of Array.isArray(b.categories) ? b.categories : []) {
      const name = String(c && c.name || "").trim().slice(0, 40);
      if (!name) continue;
      const k = name.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      out.push({ name, colour: String(c.colour || "#64748b").slice(0, 9) });
    }
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, MCATS_KEY(tid), JSON.stringify(out)).run();
    return jr({ ok: true, categories: out }, headers);
  }

  // ── Maintenance records (dated work, categorised, cost-split) ─────────────
  // A record = date + description + optional document + one or more category
  // allocations [{cat,cost}]. A £450 invoice split Brakes £200 / Tyres £250 is
  // one record whose document appears under BOTH categories when filtered, and
  // whose costs sum into each category's total. Rows live in vehicle_maintenance.
  if (sub === "/maintenance" && method === "GET") {
    await ensureMaintTable(env);
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const { results } = await env.DB.prepare(
      "SELECT * FROM vehicle_maintenance WHERE tenant_id=? AND reg=? ORDER BY date DESC, id DESC"
    ).bind(tid, reg).all();
    const records = [];
    for (const r of results || []) {
      const allocs = (parseJson(r.allocs, []) || [])
        .map(a => ({ cat: String(a.cat || a.category || ""), cost: Number(a.cost) || 0 }))
        .filter(a => a.cat);
      records.push({
        id: r.id, date: r.date || "", description: r.description || "", allocs,
        total: allocs.reduce((s, a) => s + a.cost, 0),
        docKey: r.doc_key || "", docName: r.doc_name || "",
        docUrl: r.doc_key ? await signedFileUrl(env, url.origin, "/fleet/maintenance-doc", r.doc_key) : "",
        by: r.by || "", at: r.at || ""
      });
    }
    const totals = {}; let grandTotal = 0;
    for (const rec of records) for (const a of rec.allocs) { totals[a.cat] = (totals[a.cat] || 0) + a.cost; grandTotal += a.cost; }
    return jr({ ok: true, reg, records, totals, grandTotal, categories: await maintCats(env, tid) }, headers);
  }
  if (sub === "/maintenance" && method === "POST") {
    await ensureMaintTable(env);
    const form = await request.formData();
    const reg = String(form.get("reg") || "").trim();
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const id = parseInt(String(form.get("id") || ""), 10);
    const date = String(form.get("date") || "").slice(0, 10);
    const description = String(form.get("description") || "").slice(0, 500);
    const allocs = (parseJson(String(form.get("allocs") || "[]"), []) || [])
      .map(a => ({ cat: String(a.cat || a.category || "").trim().slice(0, 40), cost: Math.round((Number(a.cost) || 0) * 100) / 100 }))
      .filter(a => a.cat);
    const file = form.get("file");
    const removeDoc = String(form.get("removeDoc") || "") === "1";
    const now = new Date().toISOString();

    const existing = (id && !isNaN(id))
      ? await env.DB.prepare("SELECT * FROM vehicle_maintenance WHERE tenant_id=? AND id=?").bind(tid, id).first()
      : null;
    let docKey = existing ? (existing.doc_key || "") : "";
    let docName = existing ? (existing.doc_name || "") : "";
    if (file && typeof file.stream === "function") {
      if (docKey) { try { await env.JOB_FILES.delete(docKey); } catch {} }   // replace old document
      const safe = String(file.name || "document").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      docKey = `${vmaintPrefix(tid, reg)}${Date.now()}-${safe}`;
      docName = file.name || safe;
      await env.JOB_FILES.put(docKey, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { name: docName, reg, by: sess.user.username, at: now }
      });
    } else if (removeDoc && docKey) {
      try { await env.JOB_FILES.delete(docKey); } catch {}
      docKey = ""; docName = "";
    }

    if (existing) {
      await env.DB.prepare("UPDATE vehicle_maintenance SET date=?,description=?,allocs=?,doc_key=?,doc_name=? WHERE tenant_id=? AND id=?")
        .bind(date, description, JSON.stringify(allocs), docKey, docName, tid, id).run();
      return jr({ ok: true, id }, headers);
    }
    const res = await env.DB.prepare(
      "INSERT INTO vehicle_maintenance (tenant_id,reg,date,description,allocs,doc_key,doc_name,by,at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(tid, reg, date, description, JSON.stringify(allocs), docKey, docName, sess.user.username, now).run();
    return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null }, headers, 201);
  }
  if (sub === "/maintenance-delete" && method === "POST") {
    await ensureMaintTable(env);
    const b = await readJson(request); const id = parseInt(String(b.id || ""), 10);
    if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
    const row = await env.DB.prepare("SELECT doc_key FROM vehicle_maintenance WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (row && row.doc_key) { try { await env.JOB_FILES.delete(row.doc_key); } catch {} }
    await env.DB.prepare("DELETE FROM vehicle_maintenance WHERE tenant_id=? AND id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Van check history for a vehicle (completed weekly checks, newest first) ─
  // Reads the shared vehicle_checks table, filtered to this reg; skips are not
  // real checks. Photos are ASSET_BUCKET keys served by /asset-image + /asset-thumb.
  if (sub === "/vehicle-checks" && method === "GET") {
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    const { results } = await env.DB.prepare(
      "SELECT username, week, vehicle, checked_at, safe_to_drive, items, note FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all();
    const names = await nameMap(env, tid);
    const checks = [];
    for (const r of results || []) {
      if (regKey(r.vehicle) !== rk) continue;
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      if (items.skipped) continue;
      const answers = items.answers || {};
      const defects = Object.keys(answers).filter(k => answers[k] === "defect");
      const slot = items.slotPhotos || {};
      const photos = Array.from(new Set([...Object.values(slot), ...((items.photos) || [])]));
      checks.push({
        username: r.username, name: names[r.username] || r.username, week: r.week,
        checkedAt: r.checked_at, safeToDrive: r.safe_to_drive === null ? null : !!Number(r.safe_to_drive),
        defectCount: defects.length, note: r.note || "", mileage: items.mileage || "",
        answers, defectNotes: items.defectNotes || {}, slotPhotos: slot, photos,
      });
    }
    checks.sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0));
    return jr({ ok: true, reg, checks }, headers);
  }

  // ── Van handover: request (from assign popup) → pushes the new driver ──────
  if (sub === "/handover/request" && method === "POST") {
    await ensureHandoverTable(env);
    const b = await readJson(request);
    const reg = String(b.reg || "").trim();
    const username = String(b.username || "").trim();
    if (!reg || !username) return jr({ error: "reg and username required" }, headers, 400);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE vehicle_handovers SET status='superseded' WHERE tenant_id=? AND reg=? AND username=? AND status='pending'").bind(tid, reg, username).run();
    const res = await env.DB.prepare(
      "INSERT INTO vehicle_handovers (tenant_id,reg,username,status,requested_by,requested_at) VALUES (?,?,?,?,?,?)"
    ).bind(tid, reg, username, "pending", sess.user.username, now).run();
    const id = res.meta ? res.meta.last_row_id : null;
    if (ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, tid, username, {
      title: "Van handover required",
      body: `Please complete the handover check for ${reg} before using the vehicle.`,
      url: "/van-handover.html", tag: "van-handover"
    }));
    return jr({ ok: true, id }, headers, 201);
  }

  // ── Van handover: the driver's pending one + the template (van-handover.html) ─
  if (sub === "/handover/mine" && method === "GET") {
    await ensureHandoverTable(env);
    const row = await env.DB.prepare(
      "SELECT id, reg, requested_by, requested_at FROM vehicle_handovers WHERE tenant_id=? AND username=? AND status='pending' ORDER BY requested_at DESC, id DESC LIMIT 1"
    ).bind(tid, sess.user.username).first();
    return jr({
      ok: true,
      handover: row ? { id: row.id, reg: row.reg, requestedBy: row.requested_by, requestedAt: row.requested_at } : null,
      template: await handoverTemplate(env, tid),
    }, headers);
  }

  // ── Van handover: attention (badge/gate for the assigned driver) ──────────
  if (sub === "/handover/attention" && method === "GET") {
    await ensureHandoverTable(env);
    const row = await env.DB.prepare(
      "SELECT id, reg FROM vehicle_handovers WHERE tenant_id=? AND username=? AND status='pending' ORDER BY requested_at DESC, id DESC LIMIT 1"
    ).bind(tid, sess.user.username).first();
    return jr({ ok: true, mineDue: !!row, id: row ? row.id : null, reg: row ? row.reg : "" }, headers);
  }

  // ── Van handover: submit (the assigned driver completes it) ───────────────
  if (sub === "/handover/submit" && method === "POST") {
    await ensureHandoverTable(env);
    const b = await readJson(request);
    const id = parseInt(String(b.id || ""), 10);
    if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
    const row = await env.DB.prepare("SELECT * FROM vehicle_handovers WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!row) return jr({ error: "Handover not found" }, headers, 404);
    if (row.username !== sess.user.username) {
      const p = await permissionsFor(env, tid, sess.user.username);
      if (p.FullAccess !== "Yes") return jr({ error: "This handover isn't assigned to you." }, headers, 403);
    }
    const tpl = await handoverTemplate(env, tid);
    const userDir = String(row.username).replace(/[^A-Za-z0-9._-]/g, "_");
    const nRef = { n: 0 };
    const answers = (b.answers && typeof b.answers === "object") ? b.answers : {};
    const defectNotes = (b.defectNotes && typeof b.defectNotes === "object") ? b.defectNotes : {};
    const slotIn = (b.photoSlots && typeof b.photoSlots === "object") ? b.photoSlots : {};
    const slotPhotos = {};
    for (const sl of tpl.photoSlots) { const key = await storeHandoverImg(env, userDir, id, sl.id, slotIn[sl.id], nRef); if (key) slotPhotos[sl.id] = key; }
    const missing = tpl.photoSlots.filter(sl => sl.required !== false && !slotPhotos[sl.id]);
    if (missing.length) return jr({ error: "Missing required photos: " + missing.map(m => m.label).join(", ") }, headers, 400);
    const photos = [];
    for (const p of (Array.isArray(b.photos) ? b.photos : []).slice(0, 8)) { const key = await storeHandoverImg(env, userDir, id, "extra", p, nRef); if (key) photos.push(key); }
    const damage = [];
    for (const d of (Array.isArray(b.damage) ? b.damage : []).slice(0, 20)) {
      const note = String(d && d.note || "").slice(0, 300);
      let photo = ""; if (d && d.photo) { const key = await storeHandoverImg(env, userDir, id, "damage", d.photo, nRef); if (key) photo = key; }
      if (note || photo) damage.push({ note, photo });
    }
    let signature = b.signature ? (await storeHandoverImg(env, userDir, id, "signature", b.signature, nRef) || "") : "";
    if (!signature) return jr({ error: "Signature required." }, headers, 400);
    const items = {
      answers, defectNotes,
      conditionInterior: String(b.conditionInterior || "").slice(0, 1000),
      conditionExterior: String(b.conditionExterior || "").slice(0, 1000),
      damage, slotPhotos, photos, signature, source: "portal",
    };
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE vehicle_handovers SET status='done', completed_at=?, mileage=?, safe_to_drive=?, note=?, items=? WHERE tenant_id=? AND id=?"
    ).bind(now, String(b.mileage || "").trim(), b.safeToDrive === false ? 0 : 1, String(b.note || "").slice(0, 1000), JSON.stringify(items), tid, id).run();
    if (row.requested_by && row.requested_by !== row.username && ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, tid, row.requested_by, {
      title: "Van handover completed", body: `${row.username} completed the handover for ${row.reg}.`,
      url: "/vehicle-checks.html?reg=" + encodeURIComponent(row.reg), tag: "van-handover"
    }));
    return jr({ ok: true, id }, headers);
  }

  // ── Van handover: admin cancels a pending one (mistaken send) ─────────────
  if (sub === "/handover/cancel" && method === "POST") {
    await ensureHandoverTable(env);
    const b = await readJson(request); const id = parseInt(String(b.id || ""), 10);
    if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
    await env.DB.prepare("UPDATE vehicle_handovers SET status='cancelled' WHERE tenant_id=? AND id=? AND status='pending'").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Van handover: full history for a vehicle (listing + detail) ───────────
  if (sub === "/handovers" && method === "GET") {
    await ensureHandoverTable(env);
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    const { results } = await env.DB.prepare(
      "SELECT * FROM vehicle_handovers WHERE tenant_id=? ORDER BY COALESCE(completed_at,requested_at) DESC, id DESC"
    ).bind(tid).all();
    const names = await nameMap(env, tid);
    const handovers = [];
    for (const r of results || []) {
      if (regKey(r.reg) !== rk) continue;
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      const answers = items.answers || {};
      const defects = Object.keys(answers).filter(k => answers[k] === "defect" || answers[k] === "missing");
      handovers.push({
        id: r.id, reg: r.reg, username: r.username, name: names[r.username] || r.username,
        status: r.status, requestedBy: r.requested_by, requestedByName: names[r.requested_by] || r.requested_by,
        requestedAt: r.requested_at, completedAt: r.completed_at,
        mileage: r.mileage || "", safeToDrive: r.safe_to_drive === null ? null : !!Number(r.safe_to_drive), note: r.note || "",
        defectCount: defects.length,
        answers, defectNotes: items.defectNotes || {},
        conditionInterior: items.conditionInterior || "", conditionExterior: items.conditionExterior || "",
        damage: items.damage || [], slotPhotos: items.slotPhotos || {}, photos: items.photos || [], signature: items.signature || "",
      });
    }
    return jr({ ok: true, reg, handovers, template: await handoverTemplate(env, tid) }, headers);
  }

  // ── Vehicle photos (gallery; one is the card cover) ───────────────────────
  if (sub === "/vehicle-photos" && method === "GET") {
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    const idx = (await photoIndex(env, tid))[rk] || [];
    const covers = await coverMap(env, tid);
    let coverKey = covers[rk];
    if (!coverKey || !idx.some(p => p.key === coverKey)) coverKey = idx.length ? idx[0].key : "";
    const photos = [];
    for (const p of idx) {
      photos.push({
        key: p.key, name: p.name, by: p.by, at: p.at, cover: p.key === coverKey,
        url: await signedFileUrl(env, url.origin, "/fleet/vehicle-photo", p.key)
      });
    }
    return jr({ ok: true, photos, cover: coverKey }, headers);
  }
  if (sub === "/vehicle-photo" && method === "POST") {
    const form = await request.formData();
    const reg = String(form.get("reg") || "").trim();
    const file = form.get("file");
    if (!reg || !file) return jr({ error: "reg and file required" }, headers, 400);
    const safe = String(file.name || "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const key = `${vphotoPrefix(tid, reg)}${Date.now()}-${safe}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "image/jpeg" },
      customMetadata: { name: file.name || safe, by: sess.user.username, at: new Date().toISOString() }
    });
    // First photo for a van becomes its cover automatically.
    const rk = regKey(reg);
    const covers = await coverMap(env, tid);
    if (!covers[rk]) { covers[rk] = key; await saveCoverMap(env, tid, covers); }
    return jr({ ok: true, key, url: await signedFileUrl(env, url.origin, "/fleet/vehicle-photo", key) }, headers, 201);
  }
  if (sub === "/vehicle-photo-cover" && method === "POST") {
    const b = await readJson(request);
    const reg = String(b.reg || "").trim(); const key = String(b.key || "");
    if (!reg || !key || !key.startsWith("vehiclephotos/")) return jr({ error: "reg and key required" }, headers, 400);
    const covers = await coverMap(env, tid); covers[regKey(reg)] = key; await saveCoverMap(env, tid, covers);
    return jr({ ok: true }, headers);
  }
  if (sub === "/vehicle-photo-delete" && method === "POST") {
    const b = await readJson(request); const key = String(b.key || "");
    if (!key || !key.startsWith("vehiclephotos/")) return jr({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    // If it was a cover, drop it — /fleet/vehicles falls back to the newest photo.
    const rk = key.split("/")[2];
    const covers = await coverMap(env, tid);
    if (rk && covers[rk] === key) { delete covers[rk]; await saveCoverMap(env, tid, covers); }
    return jr({ ok: true }, headers);
  }

  // ── Pool-vehicle trip/day allocation (which driver used a shared van) ──────
  if (sub === "/pool-alloc" && method === "GET") {
    let alloc = {};
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:poolalloc:${tid}`).first(); if (row && row.value) alloc = JSON.parse(row.value) || {}; } catch {}
    return jr({ ok: true, alloc }, headers);
  }
  if (sub === "/pool-alloc" && method === "POST") {
    const b = await readJson(request);
    let alloc = {};
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:poolalloc:${tid}`).first(); if (row && row.value) alloc = JSON.parse(row.value) || {}; } catch {}
    if (b.key) { if (b.username) alloc[String(b.key)] = String(b.username); else delete alloc[String(b.key)]; }
    else if (b.alloc && typeof b.alloc === "object") alloc = b.alloc;
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, `fleet:poolalloc:${tid}`, JSON.stringify(alloc)).run();
    return jr({ ok: true, alloc }, headers);
  }

  // ── Van driver pay settings (per-driver deductions) ───────────────────────
  if (sub === "/paycfg" && method === "GET") {
    let cfg = { defaults: { morningCap: 30, homeCap: 30, lunch: 30, thresholdH: 6 }, byUser: {} };
    try {
      const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:paycfg:${tid}`).first();
      if (row && row.value) { const v = JSON.parse(row.value); cfg.defaults = Object.assign(cfg.defaults, v.defaults || {}); cfg.byUser = v.byUser || {}; }
    } catch {}
    return jr({ ok: true, defaults: cfg.defaults, byUser: cfg.byUser }, headers);
  }
  if (sub === "/paycfg" && method === "POST") {
    const b = await readJson(request);
    const cfg = { defaults: b.defaults || { morningCap: 30, homeCap: 30, lunch: 30, thresholdH: 6 }, byUser: b.byUser || {} };
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, `fleet:paycfg:${tid}`, JSON.stringify(cfg)).run();
    return jr({ ok: true }, headers);
  }

  // ── Van timesheets (per week, per driver) ─────────────────────────────────
  if (sub === "/timesheet") {
    await ensureTsTable(env);
    if (method === "GET") {
      const week = q.get("week") || "";
      const rows = (await env.DB.prepare("SELECT username, data FROM van_timesheets WHERE tenant_id=? AND week=?").bind(tid, week).all()).results;
      const out = (rows || []).map(r => { let d = {}; try { d = JSON.parse(r.data); } catch {} return { username: r.username, days: d.days || {} }; });
      return jr({ ok: true, week, rows: out }, headers);
    }
    if (method === "POST") {
      const b = await readJson(request);
      const week = String(b.week || "");
      if (!week) return jr({ error: "week required" }, headers, 400);
      for (const row of (b.rows || [])) {
        if (!row.username) continue;
        await env.DB.prepare(
          "INSERT INTO van_timesheets (tenant_id, week, username, data, at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, week, username) DO UPDATE SET data=excluded.data, at=excluded.at"
        ).bind(tid, week, row.username, JSON.stringify({ days: row.days || {} }), new Date().toISOString()).run();
      }
      return jr({ ok: true }, headers);
    }
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}

async function ensureVehTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicles (
    tenant_id INTEGER NOT NULL DEFAULT 1, reg TEXT NOT NULL, make TEXT, model TEXT, fuel TEXT,
    active INTEGER DEFAULT 1, mot_due TEXT, tax_due TEXT, next_service TEXT, notes TEXT, at TEXT,
    PRIMARY KEY (tenant_id, reg))`).run();
  // Service-interval + odometer columns added over time (ignore "already exists").
  const cols = [
    "svc_interval_days INTEGER", "svc_interval_miles INTEGER",
    "last_service_date TEXT", "last_service_miles INTEGER",
    "warn_days INTEGER", "warn_miles INTEGER",
    "specs TEXT"   // extra spec fields (AC, payload, dimensions, handsfree …) as JSON [{label,value}]
  ];
  for (const c of cols) { try { await env.DB.prepare(`ALTER TABLE vehicles ADD COLUMN ${c}`).run(); } catch {} }
}
// Maintenance records: dated, categorised work with cost-split allocations and
// an optional document per record. Self-migrating (CREATE IF NOT EXISTS).
async function ensureMaintTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicle_maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    reg TEXT NOT NULL, date TEXT, description TEXT, allocs TEXT,
    doc_key TEXT, doc_name TEXT, by TEXT, at TEXT)`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_vmaint_reg ON vehicle_maintenance(tenant_id,reg)").run(); } catch {}
}
// Latest odometer reading per vehicle, pulled from the weekly van checks.
async function latestMileage(env, tid) {
  const dn = s => String(s || "").replace(/\s+/g, "").toUpperCase();
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, items, checked_at FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!='' ORDER BY checked_at ASC"
    ).bind(tid).all();
    for (const r of results || []) {
      let m = ""; try { m = (JSON.parse(r.items || "{}").mileage || "").toString().replace(/[^0-9]/g, ""); } catch {}
      if (!m) continue;
      out[dn(r.vehicle)] = { miles: parseInt(m, 10), at: r.checked_at };   // ASC → last write wins = newest
    }
  } catch {}
  return out;
}
// Given a vehicle row + current mileage, work out the next service and a status.
function serviceView(v, cur) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const warnDays = v.warn_days != null ? v.warn_days : 30;
  const warnMiles = v.warn_miles != null ? v.warn_miles : 1000;
  let dueDate = v.next_service || "";
  if (v.svc_interval_days && v.last_service_date) {
    const d = new Date(v.last_service_date); d.setDate(d.getDate() + v.svc_interval_days);
    dueDate = d.toISOString().slice(0, 10);
  }
  let dueMiles = null;
  if (v.svc_interval_miles && v.last_service_miles != null) dueMiles = v.last_service_miles + v.svc_interval_miles;
  let status = "none", reasons = [];
  const rank = { none: 0, ok: 1, warn: 2, bad: 3 };
  const bump = (s, why) => { if (rank[s] > rank[status]) status = s; if (why) reasons.push(why); };
  if (dueDate) {
    const dd = new Date(dueDate); dd.setHours(0, 0, 0, 0);
    const days = Math.ceil((dd - today) / 86400000);
    if (days < 0) bump("bad", "Service overdue by date");
    else if (days <= warnDays) bump("warn", `Service due in ${days} day(s)`);
    else bump("ok");
  }
  if (dueMiles != null && cur && cur.miles != null) {
    const left = dueMiles - cur.miles;
    if (left <= 0) bump("bad", "Service overdue by mileage");
    else if (left <= warnMiles) bump("warn", `Service due in ${left} mile(s)`);
    else bump("ok");
  } else if (dueMiles != null) {
    bump("ok");
  }
  return { dueDate, dueMiles, status, reason: reasons.join(" · "), warnDays, warnMiles };
}
async function ensureTsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS van_timesheets (
    tenant_id INTEGER NOT NULL DEFAULT 1, week TEXT NOT NULL, username TEXT NOT NULL,
    data TEXT, at TEXT, PRIMARY KEY (tenant_id, week, username))`).run();
}

async function ensureAssignTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicle_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    reg TEXT NOT NULL, username TEXT NOT NULL, start_date TEXT NOT NULL,
    end_date TEXT, assigned_by TEXT, at TEXT)`).run();
}
// Bootstrap current assignments from the existing users.vehicle_assigned field
// the first time the registry is used, so history starts from today's reality.
async function seedAssignments(env, tid) {
  try {
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM vehicle_assignments WHERE tenant_id=?").bind(tid).first();
    if (cnt && Number(cnt.n) > 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      "SELECT username, vehicle_assigned FROM users WHERE tenant_id=? AND vehicle_assigned IS NOT NULL AND vehicle_assigned!=''"
    ).bind(tid).all();
    for (const u of results || []) {
      await env.DB.prepare("INSERT INTO vehicle_assignments (tenant_id, reg, username, start_date, end_date, assigned_by, at) VALUES (?,?,?,?,?,?,?)")
        .bind(tid, String(u.vehicle_assigned).trim(), u.username, today, null, "seed", new Date().toISOString()).run();
    }
  } catch { /* seeding is best-effort */ }
}
