// Compliance — replaces the `/Compliance` routes on the `mostlane-pos` Worker
// (+ Compliance/*.json per client: cobra, wenzels, retail, els, els_private).
//   GET  /compliance?client=cobra   -> records for a client
//   POST /compliance                { client, site, docType, status, fileLink, ...rest }
//   POST /Compliance/upload         (kept for the old path the front end uses)
//
// STATUS: STUB. Send me the mostlane-pos /Compliance handler + the upload
// target (it looked like it pushed files somewhere) so uploads go to the right
// store (R2 / SharePoint) rather than just recording a link.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if (request.method === "GET") {
    const client = url.searchParams.get("client");
    const stmt = client
      ? env.DB.prepare("SELECT * FROM compliance WHERE lower(client)=lower(?) ORDER BY created_at DESC").bind(client)
      : env.DB.prepare("SELECT * FROM compliance ORDER BY created_at DESC LIMIT 1000");
    const { results } = await stmt.all();
    return json({ ok: true, records: results || [] }, {}, env, request);
  }

  if (request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(
      "INSERT INTO compliance (client, site, doc_type, status, file_link, payload) VALUES (?,?,?,?,?,?)"
    ).bind(b.client || null, b.site || null, b.docType || null,
           b.status || null, b.fileLink || null, JSON.stringify(b)).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown compliance route", 405, env, request);
}
