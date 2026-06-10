// Projects — replaces the `projects-ml-portal` Worker.
//   GET  /projects     -> all projects
//   POST /projects     { name, status, ...rest }
//
// STATUS: STUB. Send me projects-ml-portal so I can model its real fields
// (tasks, phases, budgets?) instead of the generic `payload` blob.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
    return json({ ok: true, projects: (results || []).map(r => { try { return { ...JSON.parse(r.payload || "{}"), id: r.id }; } catch { return r; } }) }, {}, env, request);
  }
  if (request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare("INSERT INTO projects (name, status, payload) VALUES (?,?,?)")
      .bind(b.name || null, b.status || "Active", JSON.stringify(b)).run();
    return json({ ok: true }, {}, env, request);
  }
  return error("Unknown projects route", 405, env, request);
}
