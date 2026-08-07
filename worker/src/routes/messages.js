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
import { firstTime } from "../lib/idempotency.js";
import { permissionsFor } from "../lib/auth.js";

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
  // Transient "X is typing to Y" markers (one row per direction, upserted).
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS message_typing (
    tenant_id INTEGER NOT NULL DEFAULT 1,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, from_user, to_user)
  )`).run();
  // Group messages reuse the messages table: to_user = "@<groupId>" and
  // thread_key = the engineer (non-member) who owns that conversation. Per-user
  // read position for group threads lives in group_reads (the flat `seen` flag
  // can't model many readers).
  try { await env.DB.prepare("ALTER TABLE messages ADD COLUMN thread_key TEXT").run(); } catch {}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS group_reads (
    tenant_id INTEGER NOT NULL DEFAULT 1,
    user TEXT NOT NULL,
    group_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    last_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, user, group_id, thread_key)
  )`).run();
  READY = true;
}

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(r) { try { return await r.json(); } catch { return {}; } }
const lc = (s) => String(s || "").toLowerCase();

// ── Chat groups (e.g. "Office") ───────────────────────────────────────────────
// Config in app_config `chat_groups` = [{id,name,members:[names]}]; member names
// resolve to canonical usernames (by username / first name / full name).
const GROUPS_KEY = "chat_groups";
const DEFAULT_GROUPS = [{ id: "office", name: "Office", members: ["Joanna", "Tanya", "Megan", "Chloe"] }];
let _grpCache = { at: 0, tid: null, groups: null };
async function loadGroups(env, tid) {
  if (_grpCache.groups && _grpCache.tid === tid && (Date.now() - _grpCache.at) < 120000) return _grpCache.groups;
  let cfg = DEFAULT_GROUPS;
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, GROUPS_KEY).first();
    const g = row ? JSON.parse(row.value) : null;
    if (Array.isArray(g) && g.length) cfg = g;
  } catch {}
  const { results: users } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
  const byName = {};
  (users || []).forEach((u) => {
    byName[lc(u.username)] = u.username;
    if (u.first_name && !byName[lc(u.first_name)]) byName[lc(u.first_name)] = u.username;
    const full = ((u.first_name || "") + " " + (u.last_name || "")).trim();
    if (full && !byName[lc(full)]) byName[lc(full)] = u.username;
  });
  const groups = cfg.map((g) => ({ id: g.id, name: g.name, members: (g.members || []).map((m) => byName[lc(m)] || m) }));
  _grpCache = { at: Date.now(), tid, groups };
  return groups;
}
function groupById(groups, id) { return groups.find((g) => lc(g.id) === lc(id)) || null; }
function isMember(group, user) { return !!(group && (group.members || []).some((m) => lc(m) === lc(user))); }

// Sum of unread group messages for `me` across every group thread they can see.
async function groupUnreadCount(env, tid, me) {
  const groups = await loadGroups(env, tid);
  let n = 0;
  for (const g of groups) {
    const member = isMember(g, me);
    const rows = member
      ? (await env.DB.prepare("SELECT id, thread_key FROM messages WHERE tenant_id=? AND to_user=? AND lower(from_user)!=lower(?)").bind(tid, "@" + g.id, me).all()).results || []
      : (await env.DB.prepare("SELECT id, thread_key FROM messages WHERE tenant_id=? AND to_user=? AND lower(thread_key)=lower(?) AND lower(from_user)!=lower(?)").bind(tid, "@" + g.id, me, me).all()).results || [];
    if (!rows.length) continue;
    const reads = (await env.DB.prepare("SELECT thread_key, last_id FROM group_reads WHERE tenant_id=? AND lower(user)=lower(?) AND group_id=?").bind(tid, me, g.id).all()).results || [];
    const readMap = {}; reads.forEach((rr) => { readMap[lc(rr.thread_key)] = rr.last_id; });
    rows.forEach((m) => { if (m.id > (readMap[lc(m.thread_key || "")] || 0)) n++; });
  }
  return n;
}

// Group-thread summaries visible to `me` (for /threads).
async function groupThreads(env, tid, me) {
  const groups = await loadGroups(env, tid);
  const out = [];
  for (const g of groups) {
    const member = isMember(g, me);
    const rows = member
      ? (await env.DB.prepare("SELECT id, from_user, thread_key, body, at FROM messages WHERE tenant_id=? AND to_user=? ORDER BY id DESC LIMIT 800").bind(tid, "@" + g.id).all()).results || []
      : (await env.DB.prepare("SELECT id, from_user, thread_key, body, at FROM messages WHERE tenant_id=? AND to_user=? AND lower(thread_key)=lower(?) ORDER BY id DESC LIMIT 200").bind(tid, "@" + g.id, me).all()).results || [];
    if (!rows.length) continue;
    const reads = (await env.DB.prepare("SELECT thread_key, last_id FROM group_reads WHERE tenant_id=? AND lower(user)=lower(?) AND group_id=?").bind(tid, me, g.id).all()).results || [];
    const readMap = {}; reads.forEach((rr) => { readMap[lc(rr.thread_key)] = rr.last_id; });
    const byKey = {};
    for (const m of rows) {   // DESC order → first seen per key is the latest message
      const k = lc(m.thread_key || ""); if (!k) continue;
      if (!byKey[k]) byKey[k] = { key: m.thread_key, last: m.body, at: m.at, unread: 0 };
      if (m.id > (readMap[k] || 0) && lc(m.from_user) !== lc(me)) byKey[k].unread++;
    }
    Object.values(byKey).forEach((t) => {
      out.push({ isGroup: true, group: g.id, key: t.key, with: member ? (g.name + " · " + t.key) : g.name, last: t.last, at: t.at, unread: t.unread });
    });
  }
  return out;
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  const tid = sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request);
  const me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/messages(?=\/|$)/, "") || "/";
  await ensure(env);

  // GET /messages/unread — total unread (1:1 + group threads), for the badge.
  if (sub === "/unread" && method === "GET") {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE tenant_id=? AND lower(to_user)=lower(?) AND seen=0"
    ).bind(tid, me).first();
    const gUnread = await groupUnreadCount(env, tid, me);
    return jr({ ok: true, unread: ((r && r.n) || 0) + gUnread }, headers);
  }

  // GET /messages/groups — chat groups (for the "Office" contact in pickers).
  if (sub === "/groups" && method === "GET") {
    const groups = await loadGroups(env, tid);
    return jr({ ok: true, groups: groups.map((g) => ({ id: g.id, name: g.name, members: g.members })) }, headers);
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
    const gThreads = await groupThreads(env, tid, me);
    const threads = Object.values(byOther).concat(gThreads).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return jr({ ok: true, threads }, headers);
  }

  // GET /messages/thread?group=<id>&key=<engineer>[&since=] — a group conversation.
  // Visible to the group's members and to the thread's owner (the engineer).
  // Messages carry `from` so the UI can label who said what.
  if (sub === "/thread" && method === "GET" && url.searchParams.get("group")) {
    const groups = await loadGroups(env, tid);
    const g = groupById(groups, (url.searchParams.get("group") || "").trim());
    if (!g) return jr({ error: "unknown group" }, headers, 400);
    const member = isMember(g, me);
    let key = (url.searchParams.get("key") || "").trim();
    if (!member) key = me;                                  // engineer → own thread
    if (!key) return jr({ error: "key required" }, headers, 400);
    if (!member && lc(key) !== lc(me)) return jr({ error: "forbidden" }, headers, 403);
    const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
    const { results } = await env.DB.prepare(
      "SELECT id, from_user, body, at FROM messages WHERE tenant_id=? AND to_user=? AND lower(thread_key)=lower(?)" + (since ? " AND id>?" : "") + " ORDER BY id ASC LIMIT 500"
    ).bind(...(since ? [tid, "@" + g.id, key, since] : [tid, "@" + g.id, key])).all();
    const maxId = (results || []).reduce((mx, m) => Math.max(mx, m.id), 0);
    if (maxId) ctx?.waitUntil(env.DB.prepare(
      "INSERT INTO group_reads (tenant_id,user,group_id,thread_key,last_id) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,user,group_id,thread_key) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)"
    ).bind(tid, lc(me), g.id, lc(key), maxId).run());
    const messages = (results || []).map((m) => ({ id: m.id, mine: lc(m.from_user) === lc(me), from: m.from_user, body: m.body, at: m.at }));
    return jr({ ok: true, isGroup: true, group: g.id, key, name: g.name, members: g.members, messages }, headers);
  }

  // GET /messages/thread?with=<user>[&since=<id>] — a conversation; marks incoming
  // read. `since` returns only messages newer than that id, so the live-chat
  // widget can poll cheaply for just the new lines.
  if (sub === "/thread" && method === "GET") {
    const other = (url.searchParams.get("with") || "").trim();
    if (!other) return jr({ error: "with required" }, headers, 400);
    const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
    const pair = "((lower(from_user)=lower(?) AND lower(to_user)=lower(?)) OR (lower(from_user)=lower(?) AND lower(to_user)=lower(?)))";
    const { results } = await env.DB.prepare(
      "SELECT id, from_user, to_user, body, at FROM messages WHERE tenant_id=? AND " + pair + (since ? " AND id > ?" : "") + " ORDER BY id ASC LIMIT 500"
    ).bind(...(since ? [tid, me, other, other, me, since] : [tid, me, other, other, me])).all();
    ctx?.waitUntil(env.DB.prepare(
      "UPDATE messages SET seen=1 WHERE tenant_id=? AND lower(to_user)=lower(?) AND lower(from_user)=lower(?) AND seen=0"
    ).bind(tid, me, other).run());
    const messages = (results || []).map((m) => ({ id: m.id, mine: lc(m.from_user) === lc(me), from: m.from_user, body: m.body, at: m.at }));
    // Live extras: is the other person typing to me (last 6s), and how far have
    // they read MY messages (highest seen id) — the widget shows read receipts.
    const tRow = await env.DB.prepare("SELECT at FROM message_typing WHERE tenant_id=? AND from_user=? AND to_user=?").bind(tid, lc(other), lc(me)).first();
    const typing = !!(tRow && (Date.now() - Date.parse(tRow.at) < 6000));
    const rRow = await env.DB.prepare("SELECT MAX(id) AS m FROM messages WHERE tenant_id=? AND lower(from_user)=lower(?) AND lower(to_user)=lower(?) AND seen=1").bind(tid, me, other).first();
    const readUpTo = (rRow && rRow.m) || 0;
    return jr({ ok: true, with: other, messages, typing, readUpTo }, headers);
  }

  // POST /messages/typing { to } — I'm typing to <to> (upsert a 6s marker).
  if (sub === "/typing" && method === "POST") {
    const b = await readJson(request);
    const to = lc(String(b.to || "").trim());
    if (!to) return jr({ error: "to required" }, headers, 400);
    await env.DB.prepare(
      "INSERT INTO message_typing (tenant_id, from_user, to_user, at) VALUES (?,?,?,?) ON CONFLICT(tenant_id, from_user, to_user) DO UPDATE SET at=excluded.at"
    ).bind(tid, lc(me), to, new Date().toISOString()).run();
    return jr({ ok: true }, headers);
  }

  // POST /messages/send { to, body } OR { group, key?, body } for a group thread.
  if (sub === "/send" && method === "POST") {
    const b = await readJson(request);
    const body = String(b.body || "").trim().slice(0, 2000);
    const groupId = String(b.group || "").trim();
    if (groupId) {
      if (!body) return jr({ error: "body required" }, headers, 400);
      if (!(await firstTime(env, tid, b.opId, "msg"))) return jr({ ok: true, duplicate: true }, headers);
      const groups = await loadGroups(env, tid);
      const g = groupById(groups, groupId);
      if (!g) return jr({ error: "unknown group" }, headers, 400);
      const member = isMember(g, me);
      let key = String(b.key || "").trim();
      if (!member) key = me;                                // engineer messages their own thread
      else if (!key) return jr({ error: "key required" }, headers, 400);
      const at = new Date().toISOString();
      const res = await env.DB.prepare(
        "INSERT INTO messages (tenant_id, from_user, to_user, body, at, seen, thread_key) VALUES (?,?,?,?,?,0,?)"
      ).bind(tid, me, "@" + g.id, body, at, key).run();
      const newId = res.meta ? res.meta.last_row_id : null;
      if (newId) ctx?.waitUntil(env.DB.prepare(
        "INSERT INTO group_reads (tenant_id,user,group_id,thread_key,last_id) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,user,group_id,thread_key) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)"
      ).bind(tid, lc(me), g.id, lc(key), newId).run());
      // Push to the group's members + the thread owner, minus the sender.
      const recips = new Set(g.members); recips.add(key);
      recips.forEach((rcpt) => {
        if (lc(rcpt) !== lc(me)) ctx?.waitUntil(sendToUser(env, tid, rcpt, { title: g.name + " chat", body: (me + ": " + body).slice(0, 120), url: "/inbox.html", tag: "grp:" + g.id + ":" + lc(key) }));
      });
      return jr({ ok: true, id: newId, at, group: g.id, key }, headers, 201);
    }
    const to = String(b.to || "").trim();
    if (!to || !body) return jr({ error: "to and body required" }, headers, 400);
    // Offline replay guard: a repeated op-id is a no-op, not a duplicate message.
    if (!(await firstTime(env, tid, b.opId, "msg"))) return jr({ ok: true, duplicate: true }, headers);
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

  // ── Admin moderation (Full Access only) ────────────────────────────────────
  // POST /messages/delete { id } — remove a single message from any chat.
  if (sub === "/delete" && method === "POST") {
    const p = await permissionsFor(env, tid, me).catch(() => ({}));
    if (p.FullAccess !== "Yes") return jr({ error: "Admins only" }, headers, 403);
    const b = await readJson(request);
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    await env.DB.prepare("DELETE FROM messages WHERE tenant_id=? AND id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // POST /messages/thread-delete { with } — remove a whole conversation between
  // me and <with>. (The office widget only exposes the admin's own chats.)
  if (sub === "/thread-delete" && method === "POST") {
    const p = await permissionsFor(env, tid, me).catch(() => ({}));
    if (p.FullAccess !== "Yes") return jr({ error: "Admins only" }, headers, 403);
    const b = await readJson(request);
    const other = String(b.with || "").trim();
    if (!other) return jr({ error: "with required" }, headers, 400);
    await env.DB.prepare(
      "DELETE FROM messages WHERE tenant_id=? AND ((lower(from_user)=lower(?) AND lower(to_user)=lower(?)) OR (lower(from_user)=lower(?) AND lower(to_user)=lower(?)))"
    ).bind(tid, me, other, other, me).run();
    return jr({ ok: true }, headers);
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
