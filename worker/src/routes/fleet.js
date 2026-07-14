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

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
async function canFleet(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes" || p.Vehicles === "Yes";
}
const DKEY = tid => `fleet:drivers:${tid}`;
const prefix = tid => `fleetreports/${tid}/`;
const vdocPrefix = (tid, reg) => `vehicledocs/${tid}/${String(reg).replace(/[^A-Za-z0-9]/g, "").toUpperCase()}/`;

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
    const vehicles = (results || []).map(v => {
      const cm = miles[dn(v.reg)] || null;
      const sv = serviceView(v, cm);
      return {
        reg: v.reg, make: v.make, model: v.model, fuel: v.fuel, active: v.active !== 0,
        motDue: v.mot_due || "", taxDue: v.tax_due || "", nextServiceDate: sv.dueDate || "",
        notes: v.notes || "", driver: drv[dn(v.reg)] || "",
        svcIntervalDays: v.svc_interval_days || null, svcIntervalMiles: v.svc_interval_miles || null,
        lastServiceDate: v.last_service_date || "", lastServiceMiles: v.last_service_miles != null ? v.last_service_miles : null,
        warnDays: sv.warnDays, warnMiles: sv.warnMiles,
        serviceDueMiles: sv.dueMiles, serviceStatus: sv.status, serviceReason: sv.reason,
        currentMiles: cm ? cm.miles : null, milesAt: cm ? cm.at : ""
      };
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
    } catch {}
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
    "warn_days INTEGER", "warn_miles INTEGER"
  ];
  for (const c of cols) { try { await env.DB.prepare(`ALTER TABLE vehicles ADD COLUMN ${c}`).run(); } catch {} }
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
