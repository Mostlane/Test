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
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";

export async function handle(request, env, ctx, url, sess) {
  const cors = corsHeaders(env, request);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data, null, 2), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  // Tenant is always server-derived: from the verified session, or — for the
  // pre-auth public image routes — from the request host. Every tenant-table
  // query goes through `db` and binds `db.tenantId`.
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);

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

      const asset = await getAsset(env, tenantId, assetId);
      if (!asset) return json({ ok: false, error: "Asset not found" }, 404);

      const fullUrl = imageUrl || `${url.origin}/asset-image?key=${encodeURIComponent(r2Key)}`;
      asset.images = (asset.images || []).filter(u => u !== fullUrl);
      await putAsset(env, tenantId, asset);

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
        ? db.prepare("SELECT data FROM assets WHERE tenant_id = ? AND assigned_to = ?").bind(db.tenantId, user)
        : db.prepare("SELECT data FROM assets WHERE tenant_id = ?").bind(db.tenantId);
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
      await putAsset(env, tenantId, body);
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

      const existing = await getAsset(env, tenantId, body.id);
      const updated = { ...existing, ...body };
      await putAsset(env, tenantId, updated);

      if (existing && existing.assignedTo !== body.assignedTo) {
        const log = {
          assetID: body.id,
          from: existing.assignedTo || "Unassigned",
          to: body.assignedTo,
          timestamp: new Date().toISOString(),
          pdfURL: updated.pdfURL || null
        };
        await putTransfer(env, tenantId, log);
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

      const asset = await getAsset(env, tenantId, log.assetID);
      if (asset) {
        asset.assignedTo = log.to;
        asset.lastTransfer = log.timestamp || new Date().toISOString();
        asset.pdfURL = log.pdfURL || asset.pdfURL;
        await putAsset(env, tenantId, asset);
      }
      await putTransfer(env, tenantId, log);

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
      const { results } = await db.prepare(
        "SELECT data FROM asset_transfers WHERE tenant_id = ? AND asset_id = ? ORDER BY id ASC"
      ).bind(db.tenantId, assetID).all();
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
      await db.prepare("DELETE FROM assets WHERE tenant_id = ? AND id = ?").bind(db.tenantId, id).run();
      return json({ ok: true, message: `Asset ${id} deleted.` });
    } catch (err) {
      return json({ error: "Failed to delete asset", details: err.message }, 500);
    }
  }

  // ── Photo repair: rebuild each asset's images[] from what's actually in the
  // R2 bucket (keys are "<assetId>/imageN.ext"). Fixes records that lost their
  // image links, and tells you if the bucket is simply empty. Admin only.
  if (method === "POST" && pathname === "/asset/r2-relink") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const perms = await permissionsFor(env, tenantId, sess.user.username);
    if (perms.FullAccess !== "Yes" && perms.AssetAdmin !== "Yes") return json({ ok: false, error: "Forbidden" }, 403);

    // List the whole bucket (paginated).
    let cursor, objects = [];
    try {
      do {
        const l = await env.ASSET_BUCKET.list({ cursor, limit: 1000 });
        objects.push(...(l.objects || []));
        cursor = l.truncated ? l.cursor : null;
      } while (cursor);
    } catch (e) {
      return json({ ok: false, error: "Couldn't read the image bucket — check the ASSET_BUCKET binding.", details: e.message }, 500);
    }

    const byAsset = {};
    for (const o of objects) {
      const pfx = String(o.key).split("/")[0];
      (byAsset[pfx] || (byAsset[pfx] = [])).push(o.key);
    }

    const { results } = await db.prepare("SELECT id, data FROM assets WHERE tenant_id = ?").bind(db.tenantId).all();
    let updated = 0;
    for (const row of results || []) {
      let asset; try { asset = JSON.parse(row.data); } catch { continue; }
      const keys = byAsset[asset.id];
      if (!keys || !keys.length) continue;
      const urls = keys.sort().map(k => `${url.origin}/asset-image?key=${encodeURIComponent(k)}`);
      if (JSON.stringify(asset.images || []) === JSON.stringify(urls)) continue;
      asset.images = urls;
      await putAsset(env, tenantId, asset);
      updated++;
    }
    return json({
      ok: true,
      bucketObjects: objects.length,
      assetsInBucket: Object.keys(byAsset).length,
      assetsUpdated: updated,
      sampleKeys: objects.slice(0, 6).map(o => o.key)
    });
  }

  // Admin: every condition photo ever taken for an asset across its transfers,
  // with who took it, when, and whether they were handing over or receiving.
  if (method === "GET" && pathname === "/asset/condition-photos") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const perms = await permissionsFor(env, tenantId, sess.user.username);
    if (perms.FullAccess !== "Yes" && perms.AssetAdmin !== "Yes") return json({ ok: false, error: "Forbidden" }, 403);
    const assetID = searchParams.get("assetID");
    if (!assetID) return json({ ok: false, error: "Missing assetID" }, 400);

    const toUrl = k => `${url.origin}/asset-image?key=${encodeURIComponent(k)}`;
    const keyOf = u => { try { return decodeURIComponent((String(u).split("key=")[1] || "").split("&")[0]); } catch { return ""; } };
    const rebase = u => { const k = keyOf(u); return k ? toUrl(k) : u; };
    const photos = [];

    // Completed transfers — photos live on the signed notes.
    const { results } = await db.prepare(
      "SELECT data FROM asset_transfers WHERE tenant_id=? AND asset_id=? AND json_extract(data,'$.type')='TRANSFER_NOTE'"
    ).bind(db.tenantId, assetID).all();
    for (const row of results || []) {
      let n; try { n = JSON.parse(row.data); } catch { continue; }
      for (const u of n.conditionSender || [])
        photos.push({ url: rebase(u), takenAt: utcify(n.requestedAt), by: n.from, role: "handover", counterparty: n.to, transferId: n.transferId });
      for (const u of n.conditionRecipient || [])
        photos.push({ url: rebase(u), takenAt: utcify(n.acceptedAt), by: n.acceptedBy || n.to, role: "received", counterparty: n.from, transferId: n.transferId });
    }
    // Pending transfers — the sender's drop-off photos, not yet on a note.
    const { results: reqs } = await db.prepare(
      "SELECT * FROM asset_transfer_requests WHERE tenant_id=? AND asset_id=? AND status='pending' AND condition_photos IS NOT NULL"
    ).bind(db.tenantId, assetID).all();
    for (const r of reqs || []) {
      let c = {}; try { c = JSON.parse(r.condition_photos || "{}"); } catch {}
      for (const k of c.sender || [])
        photos.push({ url: toUrl(k), takenAt: utcify(r.requested_at), by: r.from_user, role: "handover", counterparty: r.to_user, transferId: r.id, pending: true });
    }
    photos.sort((a, b) => String(b.takenAt || "").localeCompare(String(a.takenAt || "")));
    return json({ ok: true, assetID, photos });
  }

  // Undo the re-link: strip images[] off every asset record (the photos stay
  // safe in R2 — this only removes the links). Admin only.
  if (method === "POST" && pathname === "/asset/r2-unlink") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const perms = await permissionsFor(env, tenantId, sess.user.username);
    if (perms.FullAccess !== "Yes" && perms.AssetAdmin !== "Yes") return json({ ok: false, error: "Forbidden" }, 403);
    const { results } = await db.prepare("SELECT id, data FROM assets WHERE tenant_id = ?").bind(db.tenantId).all();
    let cleared = 0;
    for (const row of results || []) {
      let asset; try { asset = JSON.parse(row.data); } catch { continue; }
      if (!asset.images || !asset.images.length) continue;
      delete asset.images;
      await putAsset(env, tenantId, asset);
      cleared++;
    }
    return json({ ok: true, cleared });
  }

  // ═══ Pending transfer workflow ══════════════════════════════════════════
  // User 1 offers an item -> request sits 'pending' -> User 2 accepts (signing
  // a transfer note, logged in asset_transfers) or rejects. The recipient's
  // pending count drives the red badge on the Plant & Equipment button.

  // Lightweight badge count for the logged-in user.
  if (method === "GET" && pathname === "/asset/transfers/pending-count") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM asset_transfer_requests WHERE tenant_id=? AND lower(to_user)=lower(?) AND status='pending'"
    ).bind(db.tenantId, sess.user.username).first();
    return json({ ok: true, count: Number(row?.n || 0) });
  }

  // Incoming + outgoing pending requests for the logged-in user, with asset details.
  if (method === "GET" && pathname === "/asset/transfers/pending") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const me = sess.user.username;
    const { results } = await db.prepare(
      "SELECT * FROM asset_transfer_requests WHERE tenant_id=? AND status='pending' AND (lower(to_user)=lower(?) OR lower(from_user)=lower(?)) ORDER BY requested_at DESC"
    ).bind(db.tenantId, me, me).all();
    const shaped = [];
    for (const r of results || []) {
      const asset = await getAsset(env, tenantId, r.asset_id);
      let cond = {}; try { cond = r.condition_photos ? JSON.parse(r.condition_photos) : {}; } catch {}
      shaped.push({
        id: r.id, assetId: r.asset_id, from: r.from_user, to: r.to_user,
        note: r.note || "", requestedAt: utcify(r.requested_at),
        assetName: asset?.name || r.asset_id, serial: asset?.serial || "",
        category: asset?.category || "", value: asset?.value || "",
        image: (asset?.images || [])[0] || null,
        senderPhotos: (cond.sender || []).map(k => `${url.origin}/asset-image?key=${encodeURIComponent(k)}`),
        direction: r.to_user.toLowerCase() === me.toLowerCase() ? "incoming" : "outgoing"
      });
    }
    return json({
      ok: true,
      incoming: shaped.filter(s => s.direction === "incoming"),
      outgoing: shaped.filter(s => s.direction === "outgoing")
    });
  }

  // Offer an item to someone. Only the current holder (or an admin) can offer.
  if (method === "POST" && pathname === "/asset/transfer-request") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.assetId || !b.to) return json({ ok: false, error: "assetId and to required" }, 400);
    const asset = await getAsset(env, tenantId, b.assetId);
    if (!asset) return json({ ok: false, error: "Asset not found" }, 404);
    const me = sess.user.username;
    const holder = String(asset.assignedTo || "");
    if (holder.toLowerCase() !== me.toLowerCase()) {
      const perms = await permissionsFor(env, tenantId, me);
      if (perms.FullAccess !== "Yes") return json({ ok: false, error: "Only the current holder can transfer this item" }, 403);
    }
    if (String(b.to).toLowerCase() === holder.toLowerCase())
      return json({ ok: false, error: "That person already holds this item" }, 400);
    const dup = await db.prepare(
      "SELECT id FROM asset_transfer_requests WHERE tenant_id=? AND asset_id=? AND status='pending'"
    ).bind(db.tenantId, b.assetId).first();
    if (dup) return json({ ok: false, error: "This item already has a transfer pending" }, 409);
    const res = await db.prepare(
      "INSERT INTO asset_transfer_requests (asset_id, from_user, to_user, note, requested_at, tenant_id) VALUES (?,?,?,?,?,?)"
    ).bind(b.assetId, holder || me, b.to, b.note || null, new Date().toISOString(), db.tenantId).run();
    const reqId = res.meta.last_row_id;
    // Optional condition photos from the person handing the item over —
    // timestamped evidence of state at drop-off.
    const senderKeys = await saveConditionPhotos(env, reqId, "sender", b.photos);
    if (senderKeys.length) {
      await db.prepare("UPDATE asset_transfer_requests SET condition_photos=? WHERE tenant_id=? AND id=?")
        .bind(JSON.stringify({ sender: senderKeys, recipient: [] }), db.tenantId, reqId).run();
    }
    return json({ ok: true, id: reqId });
  }

  // Recipient accepts — signature required; writes the signed transfer note.
  if (method === "POST" && pathname === "/asset/transfer-accept") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.id || !b.signature) return json({ ok: false, error: "id and signature required" }, 400);
    const req = await db.prepare("SELECT * FROM asset_transfer_requests WHERE tenant_id=? AND id=? AND status='pending'").bind(db.tenantId, b.id).first();
    if (!req) return json({ ok: false, error: "Transfer not found (it may have been cancelled)" }, 404);
    const me = sess.user.username;
    if (req.to_user.toLowerCase() !== me.toLowerCase())
      return json({ ok: false, error: "This transfer is addressed to " + req.to_user }, 403);

    // Store the signature image in R2 (unguessable key, served via /asset-image).
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(b.signature);
    if (!m) return json({ ok: false, error: "Signature must be a PNG/JPEG data URL" }, 400);
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    const sigKey = `signatures/transfer-${req.id}-${crypto.randomUUID()}.${m[1] === "jpeg" ? "jpg" : "png"}`;
    await env.ASSET_BUCKET.put(sigKey, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });

    const now = new Date().toISOString();
    const asset = await getAsset(env, tenantId, req.asset_id);
    const when = londonWhen(now);

    // Condition photos: the sender's from drop-off (already stored) plus any
    // the recipient adds at acceptance — both sides evidenced, no arguments.
    let cond = {}; try { cond = req.condition_photos ? JSON.parse(req.condition_photos) : {}; } catch {}
    const recipientKeys = await saveConditionPhotos(env, req.id, "recipient", b.photos);
    cond = { sender: cond.sender || [], recipient: recipientKeys };
    await db.prepare("UPDATE asset_transfer_requests SET condition_photos=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(cond), db.tenantId, req.id).run();
    const toUrl = k => `${url.origin}/asset-image?key=${encodeURIComponent(k)}`;

    // The signed transfer note — the permanent paperwork trail. The statement
    // binds the new holder; the release clause ends the previous holder's
    // responsibility at the moment of acceptance.
    const note = {
      type: "TRANSFER_NOTE",
      transferId: req.id,
      assetID: req.asset_id,
      assetName: asset?.name || req.asset_id,
      serial: asset?.serial || "",
      category: asset?.category || "",
      value: asset?.value || "",
      images: (asset?.images || []).slice(0, 4),
      from: req.from_user,
      to: req.to_user,
      message: req.note || "",
      requestedAt: utcify(req.requested_at),
      acceptedAt: now,
      acceptedAtText: when,
      acceptedBy: me,
      signatureKey: sigKey,
      conditionSender: (cond.sender || []).map(toUrl),
      conditionRecipient: (cond.recipient || []).map(toUrl),
      statement: `I, ${me}, accept this item and take responsibility for it from ${when}. ` +
        `I accept responsibility for the cost to repair or replace this item at any point as required ` +
        `whilst this item remains allocated to myself. This includes if the item is left unattended ` +
        `at any point in time. This also includes any and all accessories.`,
      releaseStatement: req.from_user && req.from_user !== "Unassigned"
        ? `Upon this acceptance, custody of the item passed from ${req.from_user}. ` +
          `${req.from_user}'s responsibility for this item and all of its accessories ended on ${when}, ` +
          `when ${me} accepted the item and signed this note.`
        : `This item was previously unassigned; custody was issued directly to ${me} on ${when}.`
    };
    await putTransfer(env, tenantId, { ...note, timestamp: now });

    if (asset) {
      asset.assignedTo = req.to_user;
      asset.lastTransfer = now;
      await putAsset(env, tenantId, asset);
    }
    await db.prepare(
      "UPDATE asset_transfer_requests SET status='accepted', decided_at=?, signature_key=? WHERE tenant_id=? AND id=?"
    ).bind(now, sigKey, db.tenantId, req.id).run();

    note.signatureUrl = `${url.origin}/asset-image?key=${encodeURIComponent(sigKey)}`;
    return json({ ok: true, note });
  }

  // Recipient rejects — item stays with the sender; the decision is logged.
  if (method === "POST" && pathname === "/asset/transfer-reject") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    const req = await db.prepare("SELECT * FROM asset_transfer_requests WHERE tenant_id=? AND id=? AND status='pending'").bind(db.tenantId, b.id).first();
    if (!req) return json({ ok: false, error: "Transfer not found" }, 404);
    const me = sess.user.username;
    if (req.to_user.toLowerCase() !== me.toLowerCase())
      return json({ ok: false, error: "This transfer is addressed to " + req.to_user }, 403);
    const now = new Date().toISOString();
    await db.prepare("UPDATE asset_transfer_requests SET status='rejected', decided_at=? WHERE tenant_id=? AND id=?").bind(now, db.tenantId, req.id).run();
    await putTransfer(env, tenantId, {
      type: "TRANSFER_REJECTED", transferId: req.id, assetID: req.asset_id,
      from: req.from_user, to: req.to_user, reason: b.reason || "", timestamp: now
    });
    return json({ ok: true });
  }

  // Sender withdraws their own pending offer.
  if (method === "POST" && pathname === "/asset/transfer-cancel") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    const req = await db.prepare("SELECT * FROM asset_transfer_requests WHERE tenant_id=? AND id=? AND status='pending'").bind(db.tenantId, b.id).first();
    if (!req) return json({ ok: false, error: "Transfer not found" }, 404);
    const me = sess.user.username;
    if (String(req.from_user || "").toLowerCase() !== me.toLowerCase()) {
      const perms = await permissionsFor(env, tenantId, me);
      if (perms.FullAccess !== "Yes") return json({ ok: false, error: "Only the sender can cancel this transfer" }, 403);
    }
    await db.prepare("UPDATE asset_transfer_requests SET status='cancelled', decided_at=? WHERE tenant_id=? AND id=?")
      .bind(new Date().toISOString(), db.tenantId, req.id).run();
    return json({ ok: true });
  }

  // A completed transfer note (for viewing / printing). Visibility rules:
  //   • admin (FullAccess or AssetAdmin): every note
  //   • the receiving party: only while they STILL hold the item
  //   • the releasing party: always (their proof responsibility ended)
  if (method === "GET" && pathname === "/asset/transfer-note") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const id = searchParams.get("id");
    if (!id) return json({ ok: false, error: "Missing id" }, 400);
    const { results } = await db.prepare(
      "SELECT data FROM asset_transfers WHERE tenant_id=? AND json_extract(data,'$.transferId') = ? AND json_extract(data,'$.type')='TRANSFER_NOTE' LIMIT 1"
    ).bind(db.tenantId, Number(id)).all();
    if (!results || !results.length) return json({ ok: false, error: "Note not found" }, 404);
    const note = JSON.parse(results[0].data);

    const me = sess.user.username, meL = me.toLowerCase();
    const perms = await permissionsFor(env, tenantId, me);
    const admin = perms.FullAccess === "Yes" || perms.AssetAdmin === "Yes";
    if (!admin) {
      const isFrom = String(note.from || "").toLowerCase() === meL;
      let isCurrentTo = false;
      if (String(note.to || "").toLowerCase() === meL) {
        const a = await getAsset(env, tenantId, note.assetID);
        isCurrentTo = !!(a && String(a.assignedTo || "").toLowerCase() === meL);
      }
      if (!isFrom && !isCurrentTo)
        return json({ ok: false, error: "This document isn't linked to you" }, 403);
    }
    if (note.signatureKey) note.signatureUrl = `${url.origin}/asset-image?key=${encodeURIComponent(note.signatureKey)}`;
    note.requestedAt = utcify(note.requestedAt);   // older notes stored the naive DB timestamp
    return json({ ok: true, note });
  }

  // The logged-in user's own document set:
  //   acceptance — latest note per item they CURRENTLY hold (their live
  //   responsibility record); releases — every note where they handed an item
  //   over (their proof that responsibility ended, kept permanently).
  if (method === "GET" && pathname === "/asset/my-documents") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const me = sess.user.username, meL = me.toLowerCase();
    const { results } = await db.prepare(
      "SELECT data FROM asset_transfers WHERE tenant_id=? AND json_extract(data,'$.type')='TRANSFER_NOTE' " +
      "AND (lower(json_extract(data,'$.to'))=? OR lower(json_extract(data,'$.from'))=?) ORDER BY at DESC"
    ).bind(db.tenantId, meL, meL).all();
    const { results: held } = await db.prepare("SELECT id FROM assets WHERE tenant_id=? AND lower(assigned_to)=?").bind(db.tenantId, meL).all();
    const heldSet = new Set((held || []).map(h => h.id));
    const acceptance = [], releases = [], seen = new Set();
    for (const row of results || []) {
      let n; try { n = JSON.parse(row.data); } catch { continue; }
      if (n.signatureKey) n.signatureUrl = `${url.origin}/asset-image?key=${encodeURIComponent(n.signatureKey)}`;
      n.requestedAt = utcify(n.requestedAt);   // older notes stored the naive DB timestamp
      if (String(n.to || "").toLowerCase() === meL && heldSet.has(n.assetID) && !seen.has(n.assetID)) {
        seen.add(n.assetID); acceptance.push(n);
      } else if (String(n.from || "").toLowerCase() === meL) {
        releases.push(n);
      }
    }
    return json({ ok: true, acceptance, releases });
  }

  return json({ error: "Not found" }, 404);
}

/* ================= D1 HELPERS ================= */

// SQLite's datetime('now') is UTC but carries no timezone marker, so browsers
// parse it as LOCAL time — an hour off in UK summer. Normalise any such value
// to a real ISO UTC string before it leaves the API.
function utcify(s) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(s || "")) ? s.replace(" ", "T") + "Z" : s;
}

async function getAsset(env, tenantId, id) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT data FROM assets WHERE tenant_id=? AND id = ?").bind(db.tenantId, id).first();
  return row ? JSON.parse(row.data) : null;
}

async function putAsset(env, tenantId, asset) {
  const db = tenantDB(env, tenantId);
  await db.prepare(`
    INSERT INTO assets (id, assigned_to, data, tenant_id) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET assigned_to = excluded.assigned_to, data = excluded.data
  `).bind(asset.id, asset.assignedTo || null, JSON.stringify(asset), db.tenantId).run();
}

async function putTransfer(env, tenantId, log) {
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "INSERT INTO asset_transfers (asset_id, at, data, tenant_id) VALUES (?,?,?,?)"
  ).bind(log.assetID, log.timestamp || new Date().toISOString(), JSON.stringify(log), db.tenantId).run();
}

// Store condition-photo data URLs (max 6, PNG/JPEG) in R2 under the transfer.
// Returns the stored R2 keys; silently skips malformed entries.
async function saveConditionPhotos(env, reqId, who, photos) {
  const keys = [];
  for (const p of (Array.isArray(photos) ? photos : []).slice(0, 6)) {
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(p || "");
    if (!m) continue;
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    if (bytes.length > 4 * 1024 * 1024) continue;   // 4MB per-photo cap
    const key = `transfers/${reqId}/${who}-${keys.length + 1}-${crypto.randomUUID().slice(0, 8)}.${m[1] === "jpeg" ? "jpg" : "png"}`;
    await env.ASSET_BUCKET.put(key, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
    keys.push(key);
  }
  return keys;
}

// "11th July 2026 at 17:05" in UK time — for the transfer note declarations.
function londonWhen(iso) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(iso));
  const get = t => (parts.find(p => p.type === t) || {}).value || "";
  const day = Number(get("day"));
  const suf = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suf} ${get("month")} ${get("year")} at ${get("hour")}:${get("minute")}`;
}
