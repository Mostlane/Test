// Key register — site keys, van keys etc. signed out of the office to an
// engineer and signed back in. Deliberately small: a keys table (JSON blob,
// same pattern as assets) + an append-only key_log for the audit trail.
//
//   GET  /keys              -> { ok, keys }            (any session)
//   POST /key/add           -> { ok, key }             (FullAccess / AssetAdmin)
//   POST /key/update        -> { ok, key }             (admin)
//   DELETE /key/delete?id=  -> { ok }                  (admin)
//   POST /key/sign-out      -> { id, to, note }        (admin)
//   POST /key/sign-in       -> { id, note }            (admin)
//   GET  /key/log?keyID=    -> { ok, log }             (admin)

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";

async function keyAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { code: 401, error: "Not authenticated" };
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.AssetAdmin !== "Yes") return { code: 403, error: "Forbidden" };
  return { sess };
}

async function getKey(env, id) {
  const row = await env.DB.prepare("SELECT data FROM portal_keys WHERE id=?").bind(id).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

async function putKey(env, key) {
  await env.DB.prepare(`
    INSERT INTO portal_keys (id, data) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data
  `).bind(key.id, JSON.stringify(key)).run();
}

function logMove(env, keyID, action, holder, byUser, note) {
  return env.DB.prepare(
    "INSERT INTO key_log (key_id, action, holder, by_user, note, at) VALUES (?,?,?,?,?,?)"
  ).bind(keyID, action, holder || "", byUser || "", note || "", new Date().toISOString()).run();
}

export async function handle(request, env, ctx, url) {
  const cors = corsHeaders(env, request);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  // ── List all keys (any logged-in user) ─────────────────────────────────────
  if (method === "GET" && pathname === "/keys") {
    const sess = await requireSession(env, request);
    if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
    const { results } = await env.DB.prepare("SELECT data FROM portal_keys").all();
    const keys = [];
    for (const r of results || []) { try { keys.push(JSON.parse(r.data)); } catch {} }
    keys.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
    return json({ ok: true, keys });
  }

  // ── Per-key movement history ───────────────────────────────────────────────
  if (method === "GET" && pathname === "/key/log") {
    const gate = await keyAdmin(env, request);
    if (gate.error) return json({ ok: false, error: gate.error }, gate.code);
    const keyID = searchParams.get("keyID");
    if (!keyID) return json({ ok: false, error: "Missing keyID" }, 400);
    const { results } = await env.DB.prepare(
      "SELECT action, holder, by_user, note, at FROM key_log WHERE key_id=? ORDER BY id DESC LIMIT 50"
    ).bind(keyID).all();
    return json({ ok: true, log: results || [] });
  }

  // ── Add / update a key ─────────────────────────────────────────────────────
  if (method === "POST" && (pathname === "/key/add" || pathname === "/key/update")) {
    const gate = await keyAdmin(env, request);
    if (gate.error) return json({ ok: false, error: gate.error }, gate.code);
    const b = await request.json().catch(() => ({}));
    if (!String(b.label || "").trim()) return json({ ok: false, error: "A key needs a label" }, 400);

    if (pathname === "/key/add") {
      const id = String(b.id || "").trim() || "K-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      if (await getKey(env, id)) return json({ ok: false, error: "Key ID already exists" }, 400);
      const key = {
        id,
        label: String(b.label).trim(),
        type: ["site", "van", "other"].includes(b.type) ? b.type : "other",
        ref: String(b.ref || "").trim(),          // site name or van reg
        notes: String(b.notes || "").trim(),
        holder: "",                                // "" = in the office
        outSince: null,
        createdAt: new Date().toISOString(),
      };
      await putKey(env, key);
      return json({ ok: true, key });
    }

    const key = await getKey(env, String(b.id || ""));
    if (!key) return json({ ok: false, error: "Key not found" }, 404);
    key.label = String(b.label).trim();
    key.type = ["site", "van", "other"].includes(b.type) ? b.type : key.type;
    key.ref = String(b.ref ?? key.ref ?? "").trim();
    key.notes = String(b.notes ?? key.notes ?? "").trim();
    await putKey(env, key);
    return json({ ok: true, key });
  }

  // ── Sign a key out to an engineer ──────────────────────────────────────────
  if (method === "POST" && pathname === "/key/sign-out") {
    const gate = await keyAdmin(env, request);
    if (gate.error) return json({ ok: false, error: gate.error }, gate.code);
    const b = await request.json().catch(() => ({}));
    const key = await getKey(env, String(b.id || ""));
    if (!key) return json({ ok: false, error: "Key not found" }, 404);
    const to = String(b.to || "").trim();
    if (!to) return json({ ok: false, error: "Choose who the key is signed to" }, 400);
    key.holder = to;
    key.outSince = new Date().toISOString();
    await putKey(env, key);
    await logMove(env, key.id, "out", to, gate.sess.user.username, b.note);
    return json({ ok: true, key });
  }

  // ── Sign a key back in ─────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/key/sign-in") {
    const gate = await keyAdmin(env, request);
    if (gate.error) return json({ ok: false, error: gate.error }, gate.code);
    const b = await request.json().catch(() => ({}));
    const key = await getKey(env, String(b.id || ""));
    if (!key) return json({ ok: false, error: "Key not found" }, 404);
    const wasWith = key.holder || "";
    key.holder = "";
    key.outSince = null;
    await putKey(env, key);
    await logMove(env, key.id, "in", wasWith, gate.sess.user.username, b.note);
    return json({ ok: true, key });
  }

  // ── Delete a key (audit log rows are kept) ─────────────────────────────────
  if (method === "DELETE" && pathname === "/key/delete") {
    const gate = await keyAdmin(env, request);
    if (gate.error) return json({ ok: false, error: gate.error }, gate.code);
    const id = searchParams.get("id");
    if (!id) return json({ ok: false, error: "Missing id" }, 400);
    await env.DB.prepare("DELETE FROM portal_keys WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  return json({ ok: false, error: "Not found: " + pathname }, 404);
}
