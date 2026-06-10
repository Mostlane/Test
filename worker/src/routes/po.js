// Purchase orders — CONSOLIDATES `mostlane-po` + `mostlane-pos` (two Workers
// that were doing overlapping jobs) into one (+ po-log.json, suppliers.json).
//   GET  /po/list[?site=]          -> POs (optionally per site)
//   POST /po/create                -> raise a PO (auto PO number)
//   POST /po/update  { poNumber, status, ... }
//   GET  /po/sites/:client         -> PO refs for a client (cobra|wenzels|retail|els|els_private|projects)
//   GET  /suppliers                -> supplier list
//
// STATUS: storage + reads done. Send me mostlane-po AND mostlane-pos so I can
// match the exact PO-number format, PDF generation hook and approval flow.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/po/list" && request.method === "GET") {
    const site = url.searchParams.get("site");
    const stmt = site
      ? env.DB.prepare("SELECT * FROM purchase_orders WHERE site=? ORDER BY created_at DESC").bind(site)
      : env.DB.prepare("SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT 1000");
    const { results } = await stmt.all();
    return json({ ok: true, entries: results || [] }, {}, env, request);
  }

  if (path === "/po/create" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const poNumber = b.poNumber || genPoNumber();
    await env.DB.prepare(`
      INSERT INTO purchase_orders (po_number, engineer, site, supplier, description, cost, gps, status, pdf_link)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      poNumber, b.engineer || null, b.site || null, b.supplier || null,
      b.description || null, b.cost || null, b.gps || null,
      b.status || "Raised", b.pdfLink || null
    ).run();
    return json({ ok: true, poNumber }, {}, env, request);
  }

  if (path === "/po/update" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.poNumber) return error("poNumber required", 400, env, request);
    await env.DB.prepare("UPDATE purchase_orders SET status=? WHERE po_number=?")
      .bind(b.status || "Updated", b.poNumber).run();
    return json({ ok: true }, {}, env, request);
  }

  // /po/sites/:client  -> reads PO references grouped by client/site
  if (path.startsWith("/po/sites/") && request.method === "GET") {
    const client = path.split("/")[3];
    const { results } = await env.DB.prepare(
      "SELECT * FROM purchase_orders WHERE lower(site)=lower(?) ORDER BY created_at DESC"
    ).bind(client).all();
    return json({ ok: true, client, entries: results || [] }, {}, env, request);
  }

  return error("Unknown PO route", 404, env, request);
}

export async function suppliers(request, env, ctx, url) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT supplier_number AS supplierNumber, supplier_name AS supplierName FROM suppliers ORDER BY supplier_name"
    ).all();
    return json(results || [], {}, env, request);
  }
  return error("Unknown suppliers route", 405, env, request);
}

function genPoNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `ML-PO-${stamp}-${rand}`;
}
