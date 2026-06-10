// Assets / plant & equipment — replaces the `mostlane-assets` Worker
// (+ assets/assets.json, assets/asset-log.json).
//   GET  /assets                 -> all assets
//   POST /assets                 { id, name, category, serial, value, assignedTo, shared }
//   POST /assets/transfer        { assetId, toUser }   (records a transfer)
//   GET  /transfer-log           -> transfer history
//
// STATUS: CRUD + transfer log done against D1.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if ((path === "/assets" || path === "/asset") && request.method === "GET") {
    const { results } = await env.DB.prepare(`
      SELECT id, name, category, serial, value, assigned_to AS assignedTo, shared
      FROM assets ORDER BY id
    `).all();
    return json(results || [], {}, env, request);
  }

  if ((path === "/assets" || path === "/asset") && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("id required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO assets (id, name, category, serial, value, assigned_to, shared)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, category=excluded.category, serial=excluded.serial,
        value=excluded.value, assigned_to=excluded.assigned_to, shared=excluded.shared
    `).bind(
      b.id, b.name || null, b.category || null, b.serial || null,
      b.value || null, b.assignedTo || null, b.shared || "No"
    ).run();
    return json({ ok: true }, {}, env, request);
  }

  if (path === "/assets/transfer" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.assetId || !b.toUser) return error("assetId and toUser required", 400, env, request);
    const cur = await env.DB.prepare("SELECT assigned_to FROM assets WHERE id=?").bind(b.assetId).first();
    await env.DB.prepare("INSERT INTO asset_transfers (asset_id, from_user, to_user) VALUES (?,?,?)")
      .bind(b.assetId, cur?.assigned_to || null, b.toUser).run();
    await env.DB.prepare("UPDATE assets SET assigned_to=? WHERE id=?").bind(b.toUser, b.assetId).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown assets route", 404, env, request);
}

export async function transferLog(request, env, ctx, url) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM asset_transfers ORDER BY at DESC LIMIT 500"
  ).all();
  return json({ ok: true, transfers: results || [] }, {}, env, request);
}
