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

  return jr({ error: "Not found: " + sub }, headers, 404);
}
