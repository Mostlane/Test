// Assets / plant & equipment — full port of the `mostlane-assets` Worker.
//
// CHANGES vs the original standalone Worker:
//   • ASSETS_KV (key = asset id)        -> D1 table `assets` (full JSON in `data`)
//   • ASSET_LOG_KV (key `<id>-<ts>`)    -> D1 table `asset_transfers`
//   • ASSET_BUCKET (images)             -> same R2 bucket (binding ASSET_BUCKET)
//
// All endpoints + behaviour preserved: image upload/fetch/thumb/delete, asset
// add/update (with transfer logging when assignedTo changes), explicit
// transfer, transfer-log read, and asset delete.
//
// Routes keep their original paths (/assets, /asset/*, /transfer, /transfer-log,
// /upload-asset-image, /delete-asset-image, /asset-image, /asset-thumb), so the
// front-end change is just the base URL.

import { corsHeaders } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  const cors = corsHeaders(env, request);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data, null, 2), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  // ── Image upload (multipart) -> R2 ─────────────────────────────────────────
  if (method === "POST" && pathname === "/upload-asset-image") {
    try {
      const form = await request.formData();
      const file = form.get("file");
      const assetId = form.get("assetId");
      if (!file || !assetId) return json({ ok: false, error: "Missing file or assetId" }, 400);

      const ext = file.name?.split(".").pop() || "jpg";
      const list = await env.ASSET_BUCKET.list({ prefix: `${assetId}/` });
      const nextNum = (list.objects?.length || 0) + 1;
      const filename = `${assetId}/image${nextNum}.${ext}`;

      await env.ASSET_BUCKET.put(filename, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || "image/jpeg" }
      });

      const publicUrl = `${url.origin}/asset-image?key=${encodeURIComponent(filename)}`;
      return json({ ok: true, url: publicUrl, key: filename });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── Image fetch from R2 ────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/asset-image") {
    const key = searchParams.get("key");
    if (!key) return json({ error: "Missing key" }, 400);
    const obj = await env.ASSET_BUCKET.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      status: 200,
      headers: { ...cors, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=3600" }
    });
  }

  // ── Thumbnail (R2 read + Cloudflare image resizing) ────────────────────────
  if (method === "GET" && pathname === "/asset-thumb") {
    try {
      const key = searchParams.get("key");
      if (!key) return json({ error: "Missing key" }, 400);
      const obj = await env.ASSET_BUCKET.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: { ...cors, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=3600" },
        cf: { image: { width: 200, height: 200, fit: "cover", quality: 50, format: "auto" } }
      });
    } catch (err) {
      return json({ error: "Thumbnail generation failed", details: err.message }, 500);
    }
  }

  // ── Delete asset image (R2 + remove from asset.images) ─────────────────────
  if (method === "POST" && pathname === "/delete-asset-image") {
    try {
      const body = await request.json();
      const { assetId, key, url: imageUrl } = body;
      if (!assetId || (!key && !imageUrl)) return json({ ok: false, error: "Missing assetId or url/key" }, 400);

      let r2Key = key;
      if (!r2Key && imageUrl) r2Key = decodeURIComponent((imageUrl.split("key=")[1] || "").split("&")[0]);
      if (!r2Key) return json({ ok: false, error: "Invalid image URL or key" }, 400);

      await env.ASSET_BUCKET.delete(r2Key);

      const asset = await getAsset(env, assetId);
      if (!asset) return json({ ok: false, error: "Asset not found" }, 404);

      const fullUrl = imageUrl || `${url.origin}/asset-image?key=${encodeURIComponent(r2Key)}`;
      asset.images = (asset.images || []).filter(u => u !== fullUrl);
      await putAsset(env, asset);

      return json({ ok: true, message: "Image deleted", removedKey: r2Key });
    } catch (err) {
      return json({ ok: false, error: "Failed to delete image", details: err.message }, 500);
    }
  }

  // ── GET /assets [?user=] ───────────────────────────────────────────────────
  if (method === "GET" && pathname === "/assets") {
    try {
      const user = searchParams.get("user");
      const stmt = user
        ? env.DB.prepare("SELECT data FROM assets WHERE assigned_to = ?").bind(user)
        : env.DB.prepare("SELECT data FROM assets");
      const { results } = await stmt.all();
      const assets = (results || []).map(r => JSON.parse(r.data));
      return json({ assets });
    } catch (err) {
      return json({ error: "Failed to fetch assets", details: err.message }, 500);
    }
  }

  // ── POST /asset/add ────────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/asset/add") {
    try {
      const body = await request.json();
      if (!body.id) return json({ error: "Missing ID" }, 400);
      await putAsset(env, body);
      return json({ ok: true, message: `Asset ${body.id} added.` });
    } catch (err) {
      return json({ error: "Failed to add asset", details: err.message }, 500);
    }
  }

  // ── POST /asset/update (logs a transfer when assignedTo changes) ───────────
  if (method === "POST" && pathname === "/asset/update") {
    try {
      const body = await request.json();
      if (!body.id) return json({ error: "Missing ID" }, 400);

      const existing = await getAsset(env, body.id);
      const updated = { ...existing, ...body };
      await putAsset(env, updated);

      if (existing && existing.assignedTo !== body.assignedTo) {
        const log = {
          assetID: body.id,
          from: existing.assignedTo || "Unassigned",
          to: body.assignedTo,
          timestamp: new Date().toISOString(),
          pdfURL: updated.pdfURL || null
        };
        await putTransfer(env, log);
      }

      return json({ ok: true, message: `Asset ${body.id} updated.` });
    } catch (err) {
      return json({ error: "Failed to update asset", details: err.message }, 500);
    }
  }

  // ── POST /transfer (explicit transfer + log) ───────────────────────────────
  if (method === "POST" && pathname === "/transfer") {
    try {
      const log = await request.json();
      if (!log.assetID) return json({ error: "Missing assetID" }, 400);

      const asset = await getAsset(env, log.assetID);
      if (asset) {
        asset.assignedTo = log.to;
        asset.lastTransfer = log.timestamp || new Date().toISOString();
        asset.pdfURL = log.pdfURL || asset.pdfURL;
        await putAsset(env, asset);
      }
      await putTransfer(env, log);

      return json({ ok: true, message: `Transfer logged for ${log.assetID}` });
    } catch (err) {
      return json({ error: "Failed to log transfer", details: err.message }, 500);
    }
  }

  // ── GET /transfer-log?assetID= ─────────────────────────────────────────────
  if (method === "GET" && pathname === "/transfer-log") {
    const assetID = searchParams.get("assetID");
    if (!assetID) return json({ error: "Missing assetID" }, 400);
    try {
      const { results } = await env.DB.prepare(
        "SELECT data FROM asset_transfers WHERE asset_id = ? ORDER BY id ASC"
      ).bind(assetID).all();
      return json((results || []).map(r => JSON.parse(r.data)));
    } catch (err) {
      return json({ error: "Failed to load logs", details: err.message }, 500);
    }
  }

  // ── DELETE /asset/delete?id= ───────────────────────────────────────────────
  if (method === "DELETE" && pathname === "/asset/delete") {
    try {
      const id = searchParams.get("id");
      if (!id) return json({ error: "Missing ID" }, 400);
      await env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(id).run();
      return json({ ok: true, message: `Asset ${id} deleted.` });
    } catch (err) {
      return json({ error: "Failed to delete asset", details: err.message }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
}

/* ================= D1 HELPERS ================= */

async function getAsset(env, id) {
  const row = await env.DB.prepare("SELECT data FROM assets WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.data) : null;
}

async function putAsset(env, asset) {
  await env.DB.prepare(`
    INSERT INTO assets (id, assigned_to, data) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET assigned_to = excluded.assigned_to, data = excluded.data
  `).bind(asset.id, asset.assignedTo || null, JSON.stringify(asset)).run();
}

async function putTransfer(env, log) {
  await env.DB.prepare(
    "INSERT INTO asset_transfers (asset_id, at, data) VALUES (?,?,?)"
  ).bind(log.assetID, log.timestamp || new Date().toISOString(), JSON.stringify(log)).run();
}
