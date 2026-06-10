// SLA / EICR scheduler — replaces the `mostlane-sla` Worker (+ eicr-log*.json).
//   GET  /sla            -> jobs
//   POST /sla            { ref, site, client, type, status, dueAt, ...rest }
//
// STATUS: STUB. The SLA scheduler is one of the more complex modules (8 calls
// from the front end, scheduling + due-date logic). Send me mostlane-sla and
// I'll model its tables properly instead of the generic `payload` blob.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM sla_jobs ORDER BY created_at DESC LIMIT 1000").all();
    return json({ ok: true, jobs: (results || []).map(parseRow) }, {}, env, request);
  }
  if (request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(
      "INSERT INTO sla_jobs (ref, site, client, type, status, due_at, payload) VALUES (?,?,?,?,?,?,?)"
    ).bind(b.ref || null, b.site || null, b.client || null, b.type || null,
           b.status || "Open", b.dueAt || null, JSON.stringify(b)).run();
    return json({ ok: true }, {}, env, request);
  }
  return error("Unknown SLA route", 405, env, request);
}

function parseRow(r) { try { return { ...JSON.parse(r.payload || "{}"), id: r.id }; } catch { return r; } }
