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
import { evalAlerts, answerWord } from "./vancheck.js";

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
async function canFleet(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes" || p.Vehicles === "Yes";
}
// Money views (fuel spend, vehicle financials, running cost) are Full-Access only.
async function canMoney(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes";
}
const UK_GALLON = 4.54609;   // litres per imperial gallon (MPG is UK)
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
  alertUsers: [],   // who to push when an "Alert if" answer is given
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
    // MPG (all users) + money views (Full Access only): fuel/odo spans, finance,
    // last-12-months maintenance, running cost.
    const mpg = await mpgByVehicle(env, tid);
    const money = await canMoney(env, tid, sess);
    let fuelV = {}, odoV = {}, maint12 = {};
    if (money) {
      fuelV = await fuelByVehicle(env, tid); odoV = await odoByVehicle(env, tid);
      try {
        await ensureMaintTable(env);
        const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
        const { results: mrows } = await env.DB.prepare("SELECT reg, allocs FROM vehicle_maintenance WHERE tenant_id=? AND date>=?").bind(tid, since).all();
        for (const m of mrows || []) {
          const sum = (parseJson(m.allocs, []) || []).reduce((s, a) => s + (Number(a.cost) || 0), 0);
          maint12[dn(m.reg)] = (maint12[dn(m.reg)] || 0) + sum;
        }
      } catch {}
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
        pendingHandover: pendHo[dn(v.reg)] || 0,
        currentMpg: (mpg[dn(v.reg)] || {}).mpg || null,
        // Money views — Full Access only.
        finance: money ? financeOf(v) : undefined,
        runningCost: money ? runningCost(financeOf(v), fuelV[dn(v.reg)], odoV[dn(v.reg)], maint12[dn(v.reg)] || 0) : undefined
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

  // ── Fleet Insights (Full Access) — spend per van, per category, + fuel ─────
  // Aggregates maintenance (per category) + fuel-card spend across the whole
  // fleet for a date range, so you can compare vans (£ each, tyres each, etc.).
  if (sub === "/insights" && method === "GET") {
    if (!(await canMoney(env, tid, sess))) return jr({ error: "Forbidden" }, headers, 403);
    await ensureVehTable(env); await ensureMaintTable(env); await ensureFuelTable(env);
    const from = q.get("from") || "", to = q.get("to") || "";      // YYYY-MM-DD inclusive
    const inRange = d => (!from || (d && d >= from)) && (!to || (d && d <= to));
    const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
    const cats = await maintCats(env, tid);

    const per = {};
    const ensureV = (reg) => { const k = dnReg(reg); return per[k] || (per[k] = { reg, maint: 0, fuel: 0, litres: 0, byCat: {} }); };
    const vrows = (await env.DB.prepare("SELECT reg FROM vehicles WHERE tenant_id=?").bind(tid).all()).results || [];
    vrows.forEach(v => { if (v.reg) ensureV(v.reg); });

    // Maintenance — sum each cost allocation into its vehicle + category (count
    // = number of allocations, so "how many tyres" is comparable per van).
    const { results: mrows } = await env.DB.prepare("SELECT reg, date, allocs FROM vehicle_maintenance WHERE tenant_id=?").bind(tid).all();
    for (const m of mrows || []) {
      if (!m.reg || !inRange(m.date)) continue;
      const v = ensureV(m.reg);
      for (const a of parseJson(m.allocs, []) || []) {
        const cat = a.cat || "Other", cost = Number(a.cost) || 0;
        v.maint += cost;
        const c = v.byCat[cat] || (v.byCat[cat] = { cost: 0, count: 0 });
        c.cost += cost; c.count += 1;
      }
    }

    // Fuel — attribute each fill-up to the vehicle the card holder drove that day.
    const { byCard } = await fuelCardMap(env, tid);
    const userCurrent = {}; for (const c of Object.values(byCard)) userCurrent[c.username] = c.vehicle;
    const intervals = await assignmentIntervals(env, tid);
    const { results: frows } = await env.DB.prepare("SELECT card, username, date, litres, cost FROM fuel_entries WHERE tenant_id=?").bind(tid).all();
    for (const e of frows || []) {
      if (!inRange(e.date)) continue;
      const user = e.username || (byCard[e.card] ? byCard[e.card].username : "");
      if (!user) continue;
      const reg = regForUserOnDate(intervals, user, e.date || "") || userCurrent[user] || "";
      if (!reg) continue;
      const v = ensureV(reg);
      v.fuel += Number(e.cost) || 0; v.litres += Number(e.litres) || 0;
    }

    const vehicles = Object.values(per).map(v => {
      const byCat = {}; for (const [cat, c] of Object.entries(v.byCat)) byCat[cat] = { cost: r2(c.cost), count: c.count };
      return { reg: v.reg, maint: r2(v.maint), fuel: r2(v.fuel), litres: Math.round(v.litres * 10) / 10, total: r2(v.maint + v.fuel), byCat };
    }).sort((a, b) => b.total - a.total);

    const fleet = { maint: 0, fuel: 0, total: 0, byCat: {} };
    for (const v of vehicles) {
      fleet.maint += v.maint; fleet.fuel += v.fuel; fleet.total += v.total;
      for (const [cat, c] of Object.entries(v.byCat)) { const f = fleet.byCat[cat] || (fleet.byCat[cat] = { cost: 0, count: 0 }); f.cost = r2(f.cost + c.cost); f.count += c.count; }
    }
    fleet.maint = r2(fleet.maint); fleet.fuel = r2(fleet.fuel); fleet.total = r2(fleet.total);

    return jr({ ok: true, from, to, categories: cats, vehicles, fleet }, headers);
  }

  // ── Fuel cards + spend entries + stats + vehicle financials ───────────────
  // Fuel (cards/entries/stats/MPG) is open to any Vehicles user; the vehicle
  // FINANCIALS (insurance/finance) + the running-cost rollup stay Full-Access.
  if (sub === "/finance" || sub === "/fuel/cards" || sub === "/fuel/entries" ||
      sub === "/fuel/entry" || sub === "/fuel/entry-delete" || sub === "/fuel/stats") {

    // Save a vehicle's financials — Full Access only (money).
    if (sub === "/finance" && method === "POST") {
      if (!(await canMoney(env, tid, sess))) return jr({ error: "Forbidden" }, headers, 403);
      await ensureVehTable(env);
      const b = await readJson(request);
      const reg = String(b.reg || "").trim();
      if (!reg) return jr({ error: "reg required" }, headers, 400);
      const f = b.finance && typeof b.finance === "object" ? b.finance : {};
      const num = x => { const n = Number(x); return isFinite(n) && n !== 0 ? n : (x === 0 || x === "0" ? 0 : null); };
      const clean = {
        ownership: f.ownership === "financed" ? "financed" : "owned",
        insuranceYear: num(f.insuranceYear), roadTaxYear: num(f.roadTaxYear),
        financeMonthly: num(f.financeMonthly), financeEnd: /^\d{4}-\d{2}-\d{2}$/.test(f.financeEnd || "") ? f.financeEnd : "",
        allowedMiles: num(f.allowedMiles), excessPence: num(f.excessPence),
        note: String(f.note || "").slice(0, 300),
      };
      await env.DB.prepare("UPDATE vehicles SET finance=? WHERE tenant_id=? AND reg=?").bind(JSON.stringify(clean), tid, reg).run();
      return jr({ ok: true, finance: clean }, headers);
    }

    // Card list (card → user → current vehicle), from users.profile.fuelCard.
    if (sub === "/fuel/cards" && method === "GET") {
      const { cards } = await fuelCardMap(env, tid);
      cards.sort((a, b) => (b.active - a.active) || String(a.name).localeCompare(String(b.name)));
      return jr({ ok: true, cards }, headers);
    }

    // List spend entries (optionally for one card), newest first.
    if (sub === "/fuel/entries" && method === "GET") {
      await ensureFuelTable(env);
      const card = q.get("card") || "";
      const rows = card
        ? (await env.DB.prepare("SELECT * FROM fuel_entries WHERE tenant_id=? AND card=? ORDER BY date DESC, id DESC").bind(tid, card).all()).results
        : (await env.DB.prepare("SELECT * FROM fuel_entries WHERE tenant_id=? ORDER BY date DESC, id DESC").bind(tid).all()).results;
      const { byCard } = await fuelCardMap(env, tid);
      const entries = (rows || []).map(r => ({
        id: r.id, card: r.card, username: r.username, name: (byCard[r.card] || {}).name || r.username || "",
        date: r.date || "", litres: Number(r.litres) || 0, cost: Number(r.cost) || 0, note: r.note || "",
        ppl: (Number(r.litres) > 0) ? Math.round((Number(r.cost) / Number(r.litres)) * 100) / 100 : null,
      }));
      return jr({ ok: true, entries }, headers);
    }

    // Create / update a spend entry.
    if (sub === "/fuel/entry" && method === "POST") {
      await ensureFuelTable(env);
      const b = await readJson(request);
      const card = String(b.card || "").trim();
      if (!card) return jr({ error: "card required" }, headers, 400);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : "";
      if (!date) return jr({ error: "valid date required" }, headers, 400);
      const litres = Math.round((Number(b.litres) || 0) * 100) / 100;
      const cost = Math.round((Number(b.cost) || 0) * 100) / 100;
      const note = String(b.note || "").slice(0, 200);
      const { byCard } = await fuelCardMap(env, tid);
      const username = (byCard[card] || {}).username || "";
      const id = parseInt(String(b.id || ""), 10);
      const now = new Date().toISOString();
      if (id && !isNaN(id)) {
        await env.DB.prepare("UPDATE fuel_entries SET card=?,username=?,date=?,litres=?,cost=?,note=? WHERE tenant_id=? AND id=?")
          .bind(card, username, date, litres, cost, note, tid, id).run();
        return jr({ ok: true, id }, headers);
      }
      const res = await env.DB.prepare("INSERT INTO fuel_entries (tenant_id,card,username,date,litres,cost,note,by,at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(tid, card, username, date, litres, cost, note, sess.user.username, now).run();
      return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null }, headers, 201);
    }
    if (sub === "/fuel/entry-delete" && method === "POST") {
      await ensureFuelTable(env);
      const b = await readJson(request); const id = parseInt(String(b.id || ""), 10);
      if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
      await env.DB.prepare("DELETE FROM fuel_entries WHERE tenant_id=? AND id=?").bind(tid, id).run();
      return jr({ ok: true }, headers);
    }

    // Aggregated stats: overall + per-period (real-span averages, projections
    // flagged) + per-vehicle MPG/running cost. Optional ?card= scopes spend.
    if (sub === "/fuel/stats" && method === "GET") {
      await ensureFuelTable(env);
      const card = q.get("card") || "";
      const { byCard, cards } = await fuelCardMap(env, tid);
      const fuelV = await fuelByVehicle(env, tid);
      const odoV = await odoByVehicle(env, tid);
      const mpg = await mpgByVehicle(env, tid);

      // Spend/litres from entries (scoped to a card if given).
      const rows = (card
        ? (await env.DB.prepare("SELECT date,litres,cost,card,username FROM fuel_entries WHERE tenant_id=? AND card=?").bind(tid, card).all()).results
        : (await env.DB.prepare("SELECT date,litres,cost,card,username FROM fuel_entries WHERE tenant_id=?").bind(tid).all()).results) || [];
      let spend = 0, litres = 0, first = "", last = "";
      for (const r of rows) {
        spend += Number(r.cost) || 0; litres += Number(r.litres) || 0;
        if (r.date && (!first || r.date < first)) first = r.date;
        if (r.date && (!last || r.date > last)) last = r.date;
      }
      // Miles for the scope: the linked vehicle(s) odometer span.
      const regsInScope = new Set();
      if (card) {
        const u = (byCard[card] || {}).username;
        const ivs = await assignmentIntervals(env, tid);
        for (const e of rows) { const rg = regForUserOnDate(ivs, u, e.date) || (byCard[card] || {}).vehicle; if (rg) regsInScope.add(dnReg(rg)); }
      } else { for (const k of Object.keys(fuelV)) regsInScope.add(k); }
      let miles = 0;
      for (const k of regsInScope) if (odoV[k]) miles += odoV[k].milesDriven;

      const spanDays = (first && last) ? Math.max(1, (Date.parse(last) - Date.parse(first)) / 86400000) : 0;
      const spanWeeks = spanDays ? Math.round(spanDays / 7 * 10) / 10 : 0;
      const gallons = litres / UK_GALLON;
      const overallMpg = (miles > 0 && gallons > 0) ? Math.round((miles / gallons) * 10) / 10 : null;
      const periods = spanDays ? periodStats(spanDays, { spend, litres, miles }) : null;

      // Per-vehicle table — MPG + fuel spend for everyone; running cost (which
      // includes financials) only for Full Access.
      const money = await canMoney(env, tid, sess);
      const vrows = (await env.DB.prepare("SELECT reg, finance FROM vehicles WHERE tenant_id=?").bind(tid).all()).results || [];
      const maint12 = {};
      if (money) {
        const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
        try {
          await ensureMaintTable(env);
          const { results: mrows } = await env.DB.prepare("SELECT reg, allocs FROM vehicle_maintenance WHERE tenant_id=? AND date>=?").bind(tid, since).all();
          for (const m of mrows || []) maint12[dnReg(m.reg)] = (maint12[dnReg(m.reg)] || 0) + (parseJson(m.allocs, []) || []).reduce((s, a) => s + (Number(a.cost) || 0), 0);
        } catch {}
      }
      const vehicles = vrows.map(v => {
        const k = dnReg(v.reg);
        const row = { reg: v.reg, mpg: (mpg[k] || {}).mpg || null, spend: Math.round((fuelV[k] || {}).spend || 0), litres: Math.round(((fuelV[k] || {}).litres || 0) * 10) / 10 };
        if (money) row.running = runningCost(financeOf(v), fuelV[k], odoV[k], maint12[k] || 0);
        return row;
      });

      return jr({
        ok: true, card, money,
        overall: { spend: Math.round(spend * 100) / 100, litres: Math.round(litres * 10) / 10, miles, mpg: overallMpg, first, last, spanDays: Math.round(spanDays), spanWeeks, entries: rows.length },
        periods, vehicles, cards,
      }, headers);
    }
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
      const defects = Object.keys(answers).filter(k => answers[k] === "defect" || answers[k] === "missing");
      const slot = items.slotPhotos || {};
      const photos = Array.from(new Set([...Object.values(slot), ...((items.photos) || [])]));
      checks.push({
        username: r.username, name: names[r.username] || r.username, week: r.week,
        checkedAt: r.checked_at, safeToDrive: r.safe_to_drive === null ? null : !!Number(r.safe_to_drive),
        defectCount: defects.length, note: r.note || "", mileage: items.mileage || "",
        answers, defectNotes: items.defectNotes || {}, slotPhotos: slot, photos,
        alerts: items.alerts || [],
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

  // ── Van handover: the editable template (GET any Vehicles user; POST FullAccess) ─
  if (sub === "/handover/template" && method === "GET") {
    return jr({ ok: true, template: await handoverTemplate(env, tid), defaults: DEFAULT_HANDOVER }, headers);
  }
  if (sub === "/handover/template" && method === "POST") {
    if (!(await canMoney(env, tid, sess))) return jr({ error: "Only a Full-Access admin can change the handover template." }, headers, 403);
    const b = await readJson(request);
    const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    // kind: "answer" items carry an optional Alert-if rule (failVal = its bad
    // answer); "photo" items carry required. Defaults its alertOn to failVal.
    const mkList = (arr, kind, failVal) => {
      const out = [], seen = new Set();
      for (const it of Array.isArray(arr) ? arr : []) {
        const label = String(it && it.label || "").trim().slice(0, 120); if (!label) continue;
        let id = slug(it && it.id) || slug(label) || ("item" + (out.length + 1));
        while (seen.has(id)) id = id + "_" + (out.length + 1);
        seen.add(id);
        if (kind === "photo") { out.push({ id, label, required: !(it && it.required === false) }); continue; }
        const o = { id, label };
        if (it && it.alert) {
          const on = it.alertOn;
          o.alert = true;
          o.alertOn = (on === "ok" || on === "present" || on === "defect" || on === "missing") ? on : failVal;
        }
        out.push(o);
      }
      return out;
    };
    const alertUsers = (Array.isArray(b.alertUsers) ? b.alertUsers : []).map(u => String(u || "").trim()).filter(Boolean).slice(0, 50);
    const tpl = { checklist: mkList(b.checklist, "answer", "defect"), equipment: mkList(b.equipment, "answer", "missing"), photoSlots: mkList(b.photoSlots, "photo"), alertUsers };
    if (!tpl.checklist.length && !tpl.equipment.length && !tpl.photoSlots.length)
      return jr({ error: "Add at least one item." }, headers, 400);
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, HANDOVER_TPL_KEY(tid), JSON.stringify(tpl)).run();
    return jr({ ok: true, template: tpl }, headers);
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
    const alerts = evalAlerts(answers, tpl);   // "Alert if" rules on the template
    const items = {
      answers, defectNotes,
      conditionInterior: String(b.conditionInterior || "").slice(0, 1000),
      conditionExterior: String(b.conditionExterior || "").slice(0, 1000),
      damage, slotPhotos, photos, signature, source: "portal", alerts,
    };
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE vehicle_handovers SET status='done', completed_at=?, mileage=?, safe_to_drive=?, note=?, items=? WHERE tenant_id=? AND id=?"
    ).bind(now, String(b.mileage || "").trim(), b.safeToDrive === false ? 0 : 1, String(b.note || "").slice(0, 1000), JSON.stringify(items), tid, id).run();
    if (row.requested_by && row.requested_by !== row.username && ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, tid, row.requested_by, {
      title: "Van handover completed", body: `${row.username} completed the handover for ${row.reg}.`,
      url: "/vehicle-checks.html?reg=" + encodeURIComponent(row.reg), tag: "van-handover"
    }));
    if (alerts.length && (tpl.alertUsers || []).length && ctx && ctx.waitUntil) {
      const body = `${row.username} — ${row.reg}: ` + alerts.map(a => `${a.label}: ${answerWord(a.answer)}`).join(", ");
      const payload = { title: "⚠ Van handover alert", body, url: "/vehicle-checks.html?reg=" + encodeURIComponent(row.reg), tag: "handover-alert" };
      ctx.waitUntil(Promise.all((tpl.alertUsers || []).map(u => sendToUser(env, tid, u, payload).catch(() => {}))));
    }
    return jr({ ok: true, id, alerts: alerts.length }, headers);
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
        defectCount: defects.length, alerts: items.alerts || [],
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
    "specs TEXT",  // extra spec fields (AC, payload, dimensions, handsfree …) as JSON [{label,value}]
    "finance TEXT" // vehicle financials JSON {ownership,insuranceYear,roadTaxYear,financeMonthly,financeEnd,allowedMiles,excessPence}
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

// ── Fuel / MPG / running-cost helpers ─────────────────────────────────────
const dnReg = s => String(s || "").replace(/\s+/g, "").toUpperCase();
async function ensureFuelTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fuel_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    card TEXT, username TEXT, date TEXT, litres REAL, cost REAL, note TEXT, by TEXT, at TEXT)`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_card ON fuel_entries(tenant_id,card)").run(); } catch {}
}
// card number → { username, name } from users.profile.fuelCard.
async function fuelCardMap(env, tid) {
  const byCard = {}, cards = [];
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name, status, profile, vehicle_assigned FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of results || []) {
      let p = {}; try { p = u.profile ? JSON.parse(u.profile) : {}; } catch {}
      const card = String(p.fuelCard || "").trim();
      if (!card) continue;
      const name = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
      byCard[card] = { username: u.username, name, vehicle: u.vehicle_assigned || "" };
      cards.push({ card, username: u.username, name, vehicle: u.vehicle_assigned || "", active: u.status === "Active" });
    }
  } catch {}
  return { byCard, cards };
}
// Assignment intervals per username (reg + [start,end]); resolves which vehicle
// a driver held on a given date (falls back to their current vehicle_assigned).
async function assignmentIntervals(env, tid) {
  const list = [];
  try {
    const { results } = await env.DB.prepare("SELECT reg, username, start_date, end_date FROM vehicle_assignments WHERE tenant_id=?").bind(tid).all();
    for (const r of results || []) list.push({ reg: r.reg, username: r.username, start: r.start_date || "", end: r.end_date || "" });
  } catch {}
  return list;
}
function regForUserOnDate(intervals, username, date) {
  let best = null;
  for (const iv of intervals) {
    if (iv.username !== username) continue;
    if (iv.start && date < iv.start) continue;
    if (iv.end && date > iv.end) continue;
    if (!best || iv.start > best.start) best = iv;
  }
  if (best) return best.reg;
  return "";   // caller falls back to the driver's current vehicle
}
// Total litres + spend attributed to each vehicle (all-time), via card→user→
// assignment-at-date. Returns { REGNORM: {litres, spend, first, last, count} }.
async function fuelByVehicle(env, tid) {
  await ensureFuelTable(env);
  const { byCard } = await fuelCardMap(env, tid);
  const userCurrent = {};
  for (const c of Object.values(byCard)) userCurrent[c.username] = c.vehicle;
  const intervals = await assignmentIntervals(env, tid);
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT card, username, date, litres, cost FROM fuel_entries WHERE tenant_id=?").bind(tid).all();
    for (const e of results || []) {
      const user = e.username || (byCard[e.card] ? byCard[e.card].username : "");
      if (!user) continue;
      let reg = regForUserOnDate(intervals, user, e.date || "") || userCurrent[user] || "";
      if (!reg) continue;
      const k = dnReg(reg);
      const o = out[k] || (out[k] = { litres: 0, spend: 0, first: "", last: "", count: 0 });
      o.litres += Number(e.litres) || 0; o.spend += Number(e.cost) || 0; o.count++;
      if (e.date && (!o.first || e.date < o.first)) o.first = e.date;
      if (e.date && (!o.last || e.date > o.last)) o.last = e.date;
    }
  } catch {}
  return out;
}
// Odometer span per vehicle from van checks. { REGNORM: {min,max,milesDriven,first,last,readings} }.
async function odoByVehicle(env, tid) {
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, items, checked_at FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!='' ORDER BY checked_at ASC"
    ).bind(tid).all();
    for (const r of results || []) {
      let m = ""; try { m = (JSON.parse(r.items || "{}").mileage || "").toString().replace(/[^0-9]/g, ""); } catch {}
      if (!m) continue;
      const miles = parseInt(m, 10); if (!miles) continue;
      const k = dnReg(r.vehicle);
      const o = out[k] || (out[k] = { min: miles, max: miles, first: r.checked_at, last: r.checked_at, readings: 0 });
      o.min = Math.min(o.min, miles); o.max = Math.max(o.max, miles); o.readings++;
      if (r.checked_at < o.first) o.first = r.checked_at;
      if (r.checked_at > o.last) o.last = r.checked_at;
    }
    for (const k of Object.keys(out)) out[k].milesDriven = Math.max(0, out[k].max - out[k].min);
  } catch {}
  return out;
}
// MPG per vehicle (all available data). { REGNORM: {mpg, miles, litres, gallons} }.
async function mpgByVehicle(env, tid) {
  const fuel = await fuelByVehicle(env, tid);
  const odo = await odoByVehicle(env, tid);
  const out = {};
  for (const k of Object.keys(odo)) {
    const f = fuel[k]; const o = odo[k];
    if (!f || !(f.litres > 0) || !(o.milesDriven > 0) || o.readings < 2) continue;
    const gallons = f.litres / UK_GALLON;
    out[k] = { mpg: Math.round((o.milesDriven / gallons) * 10) / 10, miles: o.milesDriven, litres: Math.round(f.litres * 10) / 10, gallons };
  }
  return out;
}
function financeOf(v) { return parseJson(v && v.finance, {}) || {}; }
// Annual running cost for one vehicle. Combines fixed costs (insurance, tax,
// finance) with projected fuel (from its own spend rate) + maintenance (last 12
// months) + projected excess-mileage charge. `projected` flags the estimates.
function runningCost(fin, fuelV, odoV, maint12) {
  fin = fin || {}; const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
  const insurance = num(fin.insuranceYear), roadTax = num(fin.roadTaxYear);
  const finance = (fin.ownership === "financed") ? num(fin.financeMonthly) * 12 : 0;
  // Projected annual fuel from the vehicle's own spend/day (real span).
  let fuelYear = 0, fuelProjected = false, milesYear = 0;
  if (fuelV && fuelV.spend > 0 && fuelV.first && fuelV.last) {
    const days = Math.max(1, (Date.parse(fuelV.last) - Date.parse(fuelV.first)) / 86400000);
    fuelYear = fuelV.spend / days * 365; fuelProjected = days < 365;
  }
  if (odoV && odoV.milesDriven > 0 && odoV.first && odoV.last) {
    const days = Math.max(1, (Date.parse(odoV.last) - Date.parse(odoV.first)) / 86400000);
    milesYear = odoV.milesDriven / days * 365;
  }
  const maintenance = num(maint12);   // real: last 12 months
  // Excess mileage (financed agreements with an allowance + per-mile charge).
  let excess = 0, excessProjected = false;
  const allowed = num(fin.allowedMiles), excessPence = num(fin.excessPence);
  if (fin.ownership === "financed" && allowed > 0 && excessPence > 0 && milesYear > allowed) {
    excess = (milesYear - allowed) * excessPence / 100; excessProjected = true;
  }
  const total = insurance + roadTax + finance + fuelYear + maintenance + excess;
  return {
    insurance, roadTax, finance, fuel: Math.round(fuelYear), maintenance, excess: Math.round(excess),
    milesYear: Math.round(milesYear), total: Math.round(total),
    projected: fuelProjected || excessProjected, fuelProjected, excessProjected,
  };
}
// Given a card | 'all', return spend/litres/miles totals + per-period averages.
// Every average uses the REAL data span (days); a period longer than the span
// is flagged `projected`. Miles come from the linked vehicle(s) odometer span.
function periodStats(spanDays, totals) {
  const per = (days) => {
    const v = { spend: totals.spend / spanDays * days, litres: totals.litres / spanDays * days, miles: totals.miles / spanDays * days, projected: spanDays < days };
    v.spend = Math.round(v.spend * 100) / 100; v.litres = Math.round(v.litres * 10) / 10; v.miles = Math.round(v.miles);
    return v;
  };
  return { week: per(7), month: per(30.44), quarter: per(91.31), year: per(365) };
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
