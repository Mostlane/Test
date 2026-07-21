// ============================================================================
// Messages — lightweight office ↔ engineer direct messages (mounted at /messages)
// ----------------------------------------------------------------------------
// Powers the Inbox "Messages" tab. Simple 1:1 threads keyed on the two
// usernames; a message to you is "unread" until you open the thread. Sending
// fires a web push so it reaches the recipient's phone like every other alert.
// ============================================================================

import { corsHeaders } from "../lib/http.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { sendToUser } from "./push.js";

let READY = false;
async function ensure(env) {
  if (READY) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0
  )`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(tenant_id, to_user, seen)").run(); } catch {}
  READY = true;
}

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(r) { try { return await r.json(); } catch { return {}; } }
const lc = (s) => String(s || "").toLowerCase();

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  const tid = sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request);
  const me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/messages(?=\/|$)/, "") || "/";
  await ensure(env);

  // GET /messages/unread — total unread, for the Inbox badge.
  if (sub === "/unread" && method === "GET") {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE tenant_id=? AND lower(to_user)=lower(?) AND seen=0"
    ).bind(tid, me).first();
    return jr({ ok: true, unread: (r && r.n) || 0 }, headers);
  }

  // GET /messages or /messages/threads — my conversations, newest first.
  if ((sub === "/" || sub === "/threads") && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT from_user, to_user, body, at, seen FROM messages WHERE tenant_id=? AND (lower(from_user)=lower(?) OR lower(to_user)=lower(?)) ORDER BY id DESC LIMIT 500"
    ).bind(tid, me, me).all();
    const byOther = {};
    for (const m of results || []) {
      const other = lc(m.from_user) === lc(me) ? m.to_user : m.from_user;
      const key = lc(other);
      if (!byOther[key]) byOther[key] = { with: other, last: m.body, at: m.at, unread: 0 };
      if (lc(m.to_user) === lc(me) && !m.seen) byOther[key].unread++;
    }
    const threads = Object.values(byOther).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return jr({ ok: true, threads }, headers);
  }

  // GET /messages/thread?with=<user> — a full conversation; marks incoming read.
  if (sub === "/thread" && method === "GET") {
    const other = (url.searchParams.get("with") || "").trim();
    if (!other) return jr({ error: "with required" }, headers, 400);
    const { results } = await env.DB.prepare(
      "SELECT id, from_user, to_user, body, at FROM messages WHERE tenant_id=? AND ((lower(from_user)=lower(?) AND lower(to_user)=lower(?)) OR (lower(from_user)=lower(?) AND lower(to_user)=lower(?))) ORDER BY id ASC LIMIT 500"
    ).bind(tid, me, other, other, me).all();
    ctx?.waitUntil(env.DB.prepare(
      "UPDATE messages SET seen=1 WHERE tenant_id=? AND lower(to_user)=lower(?) AND lower(from_user)=lower(?) AND seen=0"
    ).bind(tid, me, other).run());
    const messages = (results || []).map((m) => ({ id: m.id, mine: lc(m.from_user) === lc(me), from: m.from_user, body: m.body, at: m.at }));
    return jr({ ok: true, with: other, messages }, headers);
  }

  // POST /messages/send { to, body }
  if (sub === "/send" && method === "POST") {
    const b = await readJson(request);
    const to = String(b.to || "").trim();
    const body = String(b.body || "").trim().slice(0, 2000);
    if (!to || !body) return jr({ error: "to and body required" }, headers, 400);
    // Resolve to the canonical username so threads don't split on casing.
    const row = await env.DB.prepare("SELECT username FROM users WHERE tenant_id=? AND lower(username)=lower(?)").bind(tid, to).first();
    const toUser = row ? row.username : to;
    const at = new Date().toISOString();
    const res = await env.DB.prepare(
      "INSERT INTO messages (tenant_id, from_user, to_user, body, at, seen) VALUES (?,?,?,?,?,0)"
    ).bind(tid, me, toUser, body, at).run();
    ctx?.waitUntil(sendToUser(env, tid, toUser, { title: "Message from " + me, body: body.slice(0, 120), url: "/inbox.html", tag: "msg:" + lc(me) }));
    return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null, at, to: toUser }, headers, 201);
  }

  // POST /messages/read { with } — mark a thread's incoming messages read.
  if (sub === "/read" && method === "POST") {
    const b = await readJson(request);
    const other = String(b.with || "").trim();
    if (!other) return jr({ error: "with required" }, headers, 400);
    await env.DB.prepare(
      "UPDATE messages SET seen=1 WHERE tenant_id=? AND lower(to_user)=lower(?) AND lower(from_user)=lower(?) AND seen=0"
    ).bind(tid, me, other).run();
    return jr({ ok: true }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}
