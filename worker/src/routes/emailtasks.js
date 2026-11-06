// Outlook "unreplied email" → portal task sync (replaces the old Grok bot).
//
// Server-side, in the mostlane-api worker. Every working-day slot (Mon–Fri,
// 07:00–17:00 London, on the hour and half-hour) it reads jamie@mostlane.com's
// Inbox + Sent via Microsoft Graph (Mail.Read, already set up for the invoice
// sweep), works out which threads still need a reply from Jamie, and turns each
// into a one-off portal task via the SAME in-process helpers the HTTP
// /tasks/inbound route uses (upsertInboundTask / closeInboundTask). When he's
// replied, the task is marked done automatically.
//
// Why in the worker (not an external bot or a Claude session): the old setup
// "kept breaking" from a lost token + a fragile external scheduler. Here there's
// no token to lose (the task write is in-process) and no external cron — it hangs
// off the existing 5-minute cron. READ-ONLY against email: never sends, moves,
// flags or changes anything in Outlook.
//
//   GET  /email-tasks/status   config + last-run summary (FullAccess)
//   POST /email-tasks/run      manual catch-up run (FullAccess)  — same as a slot
//   POST /email-tasks/config   { enabled, mailbox, days }        (FullAccess)
//
// Config:  app_config  emailtasks:<tid>        = { enabled, mailbox, days }
// State:   app_config  emailtasks:state:<tid>  = { lastSlot, lastRunAt, result, error, errorNotifiedAt }

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { graphConfigured, graphJson } from "../lib/graphmail.js";
import { upsertInboundTask, closeInboundTask } from "./tasks.js";
import { sendToUser } from "./push.js";

const DEFAULT_MAILBOX = "jamie@mostlane.com";
const LOOKBACK_DAYS   = 14;   // inbox window (spec: last 14 days)
const SENT_DAYS       = 21;   // look a little further back for replies
const MAX_AI          = 40;   // cap the per-run classify (cost guard)

// ── Config / state ───────────────────────────────────────────────────────────
async function cfgGet(env, tid) {
  let cfg = {};
  try { const r = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, `emailtasks:${tid}`).first(); if (r && r.value) cfg = JSON.parse(r.value) || {}; } catch {}
  return {
    enabled: cfg.enabled !== false,                                  // default ON (Jamie asked to reinstate it)
    mailbox: String(cfg.mailbox || DEFAULT_MAILBOX).trim() || DEFAULT_MAILBOX,
    days: Math.max(1, Math.min(60, Number(cfg.days) || LOOKBACK_DAYS)),
  };
}
async function cfgSet(env, tid, patch) {
  const cur = await cfgGet(env, tid);
  const next = { ...cur, ...patch };
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, `emailtasks:${tid}`, JSON.stringify(next)).run();
  return next;
}
async function stateGet(env, tid) {
  try { const r = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, `emailtasks:state:${tid}`).first(); if (r && r.value) return JSON.parse(r.value) || {}; } catch {}
  return {};
}
async function stateSet(env, tid, st) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, `emailtasks:state:${tid}`, JSON.stringify(st)).run();
}

// ── London-time slot gating ──────────────────────────────────────────────────
// Returns {dow(0=Sun..6=Sat), hour, minute, ymd} in Europe/London.
function lonParts(d) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = t => (p.find(x => x.type === t) || {}).value || "";
  const wk = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")] ?? -1;
  return { dow: wk, hour: Number(get("hour")) || 0, minute: Number(get("minute")) || 0, ymd: d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }) };
}
// Mon–Fri, on the hour and half-hour, 07:00 through 17:00 inclusive.
function inWindow(pt) {
  if (pt.dow < 1 || pt.dow > 5) return false;
  if (pt.minute !== 0 && pt.minute !== 30) return false;
  if (pt.hour >= 7 && pt.hour <= 16) return true;
  if (pt.hour === 17 && pt.minute === 0) return true;
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const normAddr = s => String(s || "").trim().toLowerCase();
function fromAddr(m) { return normAddr(((m.from || {}).emailAddress || {}).address); }
function fromName(m) { const ea = ((m.from || {}).emailAddress || {}); return String(ea.name || ea.address || "").trim(); }
function cleanSubject(s) {
  let t = String(s || "").trim();
  for (let i = 0; i < 6; i++) { const n = t.replace(/^\s*(re|fw|fwd|aw|wg|tr)\s*:\s*/i, ""); if (n === t) break; t = n; }
  return t.trim() || "(no subject)";
}

// Clear, automated senders we never raise a task for (the AI catches the rest).
function looksAutomated(addr, subject) {
  const a = normAddr(addr);
  if (!a) return true;
  const local = a.split("@")[0] || "";
  if (/(^|[._-])(no-?reply|do-?not-?reply|donotreply|noreply|mailer-?daemon|postmaster|bounce[sd]?|mailer|notif(y|ication)s?|automail|auto-?reply|alerts?|updates?|newsletters?|digest|mailings?)(\b|[._-]|$)/i.test(local)) return true;
  if (/@(jotform\.com|mailchimp|sendgrid\.net|mcsv\.net|email\.concerto\.co\.uk|bounce|notifications?\.)/i.test(a)) return true;
  if (a === "noreply@concerto.co.uk" || a.startsWith("noreply@") || a.startsWith("no-reply@")) return true;
  const sub = String(subject || "").toLowerCase();
  if (/^\s*(undeliverable|automatic reply|auto(matic)? reply|out of office|read:|delivery (status|has failed)|mail delivery)/i.test(sub)) return true;
  return false;
}

// Read a mail folder (inbox / sentitems), newest first, within `days`.
async function readFolder(env, mailbox, folder, { days, select, top = 150 }) {
  const floor = new Date(Date.now() - days * 86400000).toISOString();
  const tf = folder === "sentitems" ? "sentDateTime" : "receivedDateTime";
  const path = `/users/${encodeURIComponent(mailbox)}/mailFolders/${folder}/messages`
    + `?$select=${encodeURIComponent(select)}`
    + `&$filter=${encodeURIComponent(`${tf} ge ${floor}`)}`
    + `&$orderby=${encodeURIComponent(`${tf} desc`)}&$top=${top}`;
  const j = await graphJson(env, "GET", path);
  return (j && j.value) || [];
}

// AI classify the deterministic survivors: for each, does a real person expect a
// reply from Jamie? Returns an array aligned by index: {needsReply, summary, dueDate?}.
// Fails soft → null (caller then keeps them all with a preview summary).
async function aiClassify(env, items) {
  if (!items.length || !env.ANTHROPIC_API_KEY) return null;
  const lines = items.map((it, i) =>
    `[${i}] from: ${it.fromName} <${it.fromAddr}>\nsubject: ${it.subject}\npreview: ${String(it.preview || "").replace(/\s+/g, " ").slice(0, 300)}`
  ).join("\n\n");
  const tool = {
    name: "classify",
    description: "Classify each email for whether Jamie needs to send a reply.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              i: { type: "integer", description: "the [index] of the email" },
              needsReply: { type: "boolean", description: "true only if a real person is asking Jamie for something / expects a response" },
              summary: { type: "string", description: "one short sentence: what they want (no greetings, no quotes)" },
              dueDate: { type: "string", description: "YYYY-MM-DD if a clear deadline is stated, else empty" },
            },
            required: ["i", "needsReply", "summary"],
          },
        },
      },
      required: ["items"],
    },
  };
  const prompt = "You triage the inbox of Jamie (Mostlane Construction). For each email below decide if it genuinely needs a REPLY from Jamie.\n"
    + "needsReply = true ONLY when a real person asks a question, makes a request, or expects a response.\n"
    + "needsReply = false for newsletters, marketing, notifications, receipts, invoices, statements, calendar invites, automated/no-reply mail, pure FYI, and plain acknowledgements ('thanks, that's fine').\n"
    + "Give a one-sentence summary of what each sender wants. Classify EVERY index.\n\n" + lines;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 1500,
        tools: [tool],
        tool_choice: { type: "tool", name: "classify" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const use = (j.content || []).find(c => c.type === "tool_use");
    const arr = use && use.input && Array.isArray(use.input.items) ? use.input.items : null;
    if (!arr) return null;
    const out = new Array(items.length).fill(null);
    for (const it of arr) { const i = Number(it.i); if (i >= 0 && i < items.length) out[i] = { needsReply: !!it.needsReply, summary: String(it.summary || "").trim(), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(it.dueDate || "") ? it.dueDate : "" }; }
    return out;
  } catch { return null; }
}

// ── The sweep ────────────────────────────────────────────────────────────────
// `force` (manual run) skips the slot gate but still checks enabled + Graph.
export async function sweepUnrepliedEmails(env, ctx, tid = 1, { force = false } = {}) {
  const now = new Date();
  const pt = lonParts(now);
  const slot = `${pt.ymd} ${String(pt.hour).padStart(2, "0")}:${String(pt.minute).padStart(2, "0")}`;
  const cfg = await cfgGet(env, tid);
  if (!cfg.enabled) return { ran: false, reason: "disabled" };
  if (!force) {
    if (!inWindow(pt)) return { ran: false, reason: "outside-window" };
    const st = await stateGet(env, tid);
    if (st.lastSlot === slot) return { ran: false, reason: "slot-done" };
  }
  if (!graphConfigured(env)) return { ran: false, reason: "graph-not-configured" };

  const me = normAddr(cfg.mailbox);
  let result;
  try {
    // 1) Read Inbox (candidates) + Sent (to tell what I've already replied to).
    const inbox = await readFolder(env, cfg.mailbox, "inbox",
      { days: cfg.days, select: "id,subject,from,receivedDateTime,internetMessageId,conversationId,bodyPreview,webLink" });
    const sent = await readFolder(env, cfg.mailbox, "sentitems",
      { days: Math.max(cfg.days, SENT_DAYS), select: "id,conversationId,sentDateTime" });

    // Latest of MY replies per conversation.
    const sentLatest = new Map();
    for (const m of sent) {
      const c = m.conversationId; if (!c) continue;
      const t = Date.parse(m.sentDateTime || 0) || 0;
      if (t > (sentLatest.get(c) || 0)) sentLatest.set(c, t);
    }

    // Group inbox by conversation → latest message FROM SOMEONE ELSE.
    const convs = new Map();
    for (const m of inbox) {
      const c = m.conversationId || m.internetMessageId || m.id; if (!c) continue;
      if (fromAddr(m) === me) continue;                 // skip my own messages that landed in Inbox
      const t = Date.parse(m.receivedDateTime || 0) || 0;
      const cur = convs.get(c);
      if (!cur || t > cur._t) convs.set(c, { ...m, _conv: c, _t: t });
    }

    const toClose = [];     // replied → mark done
    const candidates = [];  // unreplied → consider raising a task
    for (const [c, m] of convs) {
      const replied = (sentLatest.get(c) || 0) > m._t;   // my latest reply is after their latest message
      if (replied) { toClose.push(m); continue; }
      if (looksAutomated(fromAddr(m), m.subject)) continue;
      candidates.push(m);
    }

    // 2) Close first — threads I've now replied to.
    let closed = 0;
    for (const m of toClose) {
      const extKey = ("outlook:" + (m._conv || m.conversationId || m.internetMessageId)).slice(0, 200);
      const r = await closeInboundTask(env, tid, extKey).catch(() => null);
      if (r && r.found && r.done) closed++;
    }

    // 3) Classify the survivors (oldest first) + raise/update tasks.
    candidates.sort((a, b) => a._t - b._t);
    const batch = candidates.slice(0, MAX_AI);
    const ai = await aiClassify(env, batch.map(m => ({ fromName: fromName(m), fromAddr: fromAddr(m), subject: cleanSubject(m.subject), preview: m.bodyPreview })));

    let created = 0, updated = 0, skipped = 0;
    const createdTitles = [];
    for (let i = 0; i < batch.length; i++) {
      const m = batch[i];
      const verdict = ai ? ai[i] : null;
      if (ai && verdict && !verdict.needsReply) { skipped++; continue; }   // AI says no reply needed
      const summary = (verdict && verdict.summary) || String(m.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 200);
      const subject = cleanSubject(m.subject);
      const title = `Reply to ${fromName(m) || fromAddr(m)} — ${subject}`.slice(0, 150);
      const extKey = ("outlook:" + m._conv).slice(0, 200);
      const received = (m.receivedDateTime || "").slice(0, 10);

      // Reopen only if genuinely newer mail arrived AFTER it was marked done
      // (a re-engaged thread). A task closed/ticked with nothing newer stays done.
      try {
        const t = await env.DB.prepare("SELECT id FROM admin_tasks WHERE tenant_id=? AND ext_key=? LIMIT 1").bind(tid, extKey).first();
        if (t) {
          const d = await env.DB.prepare("SELECT MAX(done_at) m FROM admin_task_done WHERE tenant_id=? AND task_id=?").bind(tid, t.id).first();
          if (d && d.m && Date.parse(d.m) < m._t) {
            await env.DB.prepare("DELETE FROM admin_task_done WHERE tenant_id=? AND task_id=?").bind(tid, t.id).run();
          }
        }
      } catch {}

      const r = await upsertInboundTask(env, ctx, tid, {
        title, detail: summary, link: m.webLink || "", externalId: extKey,
        source: "outlook", category: "Emails", date: received,
        dueDate: (verdict && verdict.dueDate) || received,
      }).catch(() => null);
      if (r && r.ok) { if (r.created) { created++; createdTitles.push(title); } else updated++; }
    }

    result = { closed, created, updated, skipped, candidates: candidates.length, aiUsed: !!ai, at: now.toISOString() };

    // 4) Report — only when something actually changed (stay silent otherwise).
    if ((created > 0 || closed > 0) && ctx && ctx.waitUntil) {
      const bits = [];
      if (created) bits.push(`${created} new`);
      if (closed) bits.push(`${closed} done (replied)`);
      if (updated) bits.push(`${updated} updated`);
      const owner = String(env.OWNER_USERNAME || "Jamie Line");
      const body = bits.join(" · ") + (createdTitles.length ? " — " + createdTitles.slice(0, 4).join("; ") : "");
      ctx.waitUntil(sendToUser(env, tid, owner, { title: "📧 Email tasks", body, url: "/my-tasks.html", tag: "email-tasks" }).catch(() => {}));
    }

    const st = await stateGet(env, tid);
    await stateSet(env, tid, { ...st, lastSlot: slot, lastRunAt: now.toISOString(), result, error: null });
    return { ran: true, ...result };
  } catch (e) {
    // Graph auth / read failure: record it, and tell Jamie ONCE per 12h rather
    // than failing silently every slot. It self-heals when the creds are fixed.
    const msg = String(e && e.message || e).slice(0, 300);
    const st = await stateGet(env, tid);
    const lastNote = Date.parse(st.errorNotifiedAt || 0) || 0;
    const stale = Date.now() - lastNote > 12 * 3600000;
    if (stale && ctx && ctx.waitUntil) {
      const owner = String(env.OWNER_USERNAME || "Jamie Line");
      ctx.waitUntil(sendToUser(env, tid, owner, { title: "📧 Email-task sync paused", body: "Couldn't read the mailbox: " + msg, url: "/my-tasks.html", tag: "email-tasks-error" }).catch(() => {}));
    }
    await stateSet(env, tid, { ...st, lastSlot: force ? st.lastSlot : slot, lastRunAt: now.toISOString(), error: msg, errorNotifiedAt: stale ? now.toISOString() : st.errorNotifiedAt });
    return { ran: false, reason: "error", error: msg };
  }
}

// ── HTTP: status / run / config (FullAccess) ─────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/email-tasks(?=\/|$)/, "") || "/";
  const isFull = (await permissionsFor(env, tid, sess.user.username)).FullAccess === "Yes";
  if (!isFull) return error("Forbidden", 403, env, request);

  if (sub === "/status" && method === "GET") {
    const cfg = await cfgGet(env, tid);
    const st = await stateGet(env, tid);
    return json({ ok: true, config: cfg, state: st, graphConfigured: graphConfigured(env), aiConfigured: !!env.ANTHROPIC_API_KEY }, {}, env, request);
  }
  if (sub === "/config" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const patch = {};
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (b.mailbox != null) patch.mailbox = String(b.mailbox).trim();
    if (b.days != null) patch.days = Number(b.days);
    const cfg = await cfgSet(env, tid, patch);
    return json({ ok: true, config: cfg }, {}, env, request);
  }
  if (sub === "/run" && method === "POST") {
    const r = await sweepUnrepliedEmails(env, ctx, tid, { force: true });
    return json({ ok: true, run: r }, {}, env, request);
  }
  return error("Unknown email-tasks route", 404, env, request);
}
