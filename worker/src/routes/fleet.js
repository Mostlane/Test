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
