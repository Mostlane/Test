// Job programmes — build a programme of works (sections + activities on a
// weekly timeline) in the portal, issue frozen revisions (Rev A, B, …) and
// share them with clients by revocable link. Clients NEVER get the file:
// the share link renders the latest ISSUED revision in their browser
// (programme-view.html), and "Suggest changes" submits their edited COPY back
// as a suggestion — the issued revision is immutable.
//
//   Admin (FullAccess | Programmes):
//     GET  /prog/list                     programmes + latest rev + counts
//     GET  /prog/one?id=                  draft + revisions + shares + suggestions
//     POST /prog/save                     { id?, data } create/autosave draft
//     POST /prog/delete { id }            remove programme + revisions/shares/suggestions
//     POST /prog/issue  { id, note }      freeze the draft as the next revision
//     GET  /prog/revision?id=             one frozen revision's full data
//     POST /prog/share  { progId, label, accessCode?, expiresDays?, allowSuggest }
//     POST /prog/share/revoke { token }
//     GET  /prog/suggestion?id=           one suggestion's full data (review)
//     POST /prog/suggestion/decide { id, status }   incorporated | dismissed
//
//   Public (PUBLIC_ROUTES; token verified in-handler, optional access code):
//     POST /prog/shared/open    { token, code }     latest issued revision
//     POST /prog/shared/suggest { token, code, author, note, data }
//
// Tables (self-migrating): job_programmes (working draft), programme_revisions
// (immutable issues), programme_shares (links), programme_suggestions.

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { sendToUser } from "./push.js";
import { buildProgrammePdf } from "../lib/progpdf.js";

const MAX_DATA_BYTES = 400 * 1024;      // a programme JSON should never be near this

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS job_programmes (
    id TEXT PRIMARY KEY, tenant_id TEXT, title TEXT, client TEXT, site TEXT,
    data TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, archived INTEGER DEFAULT 0)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS programme_revisions (
    id TEXT PRIMARY KEY, tenant_id TEXT, prog_id TEXT, rev TEXT, data TEXT,
    note TEXT, issued_by TEXT, issued_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS programme_shares (
    token TEXT PRIMARY KEY, tenant_id TEXT, prog_id TEXT, label TEXT,
    access_code TEXT, expires_at TEXT, revoked INTEGER DEFAULT 0,
    allow_suggest INTEGER DEFAULT 1, created_by TEXT, created_at TEXT,
    last_opened_at TEXT, opens INTEGER DEFAULT 0, contractor TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS programme_suggestions (
    id TEXT PRIMARY KEY, tenant_id TEXT, prog_id TEXT, token TEXT, rev TEXT,
    author TEXT, note TEXT, data TEXT, status TEXT DEFAULT 'open',
    created_at TEXT, decided_by TEXT, decided_at TEXT, contractor TEXT)`).run();
  // Early installs created the tables without these columns — heal in place.
  try { await env.DB.prepare("ALTER TABLE programme_shares ADD COLUMN contractor TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE programme_suggestions ADD COLUMN contractor TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE job_programmes ADD COLUMN updated_by TEXT").run(); } catch {}
}

// Company bank holidays (the Holidays admin's GOV.UK-imported list, stored per
// year in app_config `holiday:bankholidays:<year>`) — flattened to ISO dates
// across a span of years so the programme maths can skip them.
async function bankHolidayDates(db) {
  const y = new Date().getFullYear();
  const years = [y - 1, y, y + 1, y + 2];
  const dates = [];
  for (const yr of years) {
    try {
      const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
        .bind(db.tenantId, `holiday:bankholidays:${yr}`).first();
      if (!row) continue;
      for (const b of JSON.parse(row.value) || []) if (b?.date) dates.push(b.date);
    } catch { /* one bad year's config never breaks programmes */ }
  }
  return dates.sort();
}

async function progAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { code: 401, error: "Not authenticated" };
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.Programmes !== "Yes") return { code: 403, error: "Forbidden" };
  return { sess };
}

function newId(prefix) {
  return prefix + "-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}
function randToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}
// Rev labels count A…Z, AA, AB… like drawing revisions.
function revLabel(n) {
  let s = "";
  n = Math.max(0, n);
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function cleanData(raw) {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw || {});
  if (s.length > MAX_DATA_BYTES) return { error: "Programme too large" };
  let d;
  try { d = JSON.parse(s); } catch { return { error: "Bad programme data" }; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { error: "Bad programme data" };
  return { json: JSON.stringify(d), obj: d };
}

async function getShare(db, token) {
  if (!/^[a-f0-9]{24,64}$/i.test(String(token || ""))) return { error: "This link isn't valid.", code: 404 };
  const s = await db.prepare("SELECT * FROM programme_shares WHERE token=? AND tenant_id=?").bind(token, db.tenantId).first();
  if (!s) return { error: "This link isn't valid.", code: 404 };
  if (s.revoked) return { error: "This link has been switched off. Ask Mostlane for a new one.", code: 410 };
  if (s.expires_at && new Date(s.expires_at) < new Date()) return { error: "This link has expired. Ask Mostlane for a new one.", code: 410 };
  return { share: s };
}
function codeOk(share, given) {
  const want = String(share.access_code || "");
  if (!want) return true;
  return String(given || "").trim() === want;
}

async function latestRevision(db, progId) {
  return db.prepare(
    "SELECT * FROM programme_revisions WHERE prog_id=? AND tenant_id=? ORDER BY issued_at DESC LIMIT 1"
  ).bind(progId, db.tenantId).first();
}

function pdfResponse(cors, bytes, filename) {
  return new Response(bytes, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${String(filename).replace(/[^\w .\-()]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function handle(request, env, ctx, url) {
  const cors = corsHeaders(env, request);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();
  const tenantId = await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });
  await ensureTables(env);

  // ══ PUBLIC: client share link ═══════════════════════════════════════════
  // Serves ONLY issued revisions — the working draft never leaves the portal.
  if (method === "POST" && pathname === "/prog/shared/open") {
    const b = await request.json().catch(() => ({}));
    const g = await getShare(db, b.token);
    if (g.error) return json({ ok: false, error: g.error }, g.code);
    const share = g.share;
    if (share.access_code && !codeOk(share, b.code)) {
      return json({ ok: false, needCode: true, error: b.code ? "That access code isn't right." : "" }, b.code ? 403 : 401);
    }
    const rev = await latestRevision(db, share.prog_id);
    if (!rev) return json({ ok: false, error: "This programme hasn't been issued yet." }, 404);
    const prog = await db.prepare("SELECT title, client, site FROM job_programmes WHERE id=? AND tenant_id=?")
      .bind(share.prog_id, db.tenantId).first();
    ctx?.waitUntil(db.prepare(
      "UPDATE programme_shares SET opens=opens+1, last_opened_at=? WHERE token=? AND tenant_id=?"
    ).bind(new Date().toISOString(), share.token, db.tenantId).run());
    let data = {};
    try { data = JSON.parse(rev.data); } catch {}
    // A contractor-scoped link serves ONLY that contractor's tasks — filtered
    // here, server-side, so a subcontractor can't see the rest of the
    // programme even in the network response.
    if (share.contractor && Array.isArray(data.tasks)) {
      data = { ...data, tasks: data.tasks.filter(t => t && t.contractor === share.contractor) };
    }
    return json({
      ok: true,
      title: prog?.title || data.title || "Programme of works",
      client: prog?.client || "", site: prog?.site || "",
      rev: rev.rev, issuedAt: rev.issued_at, note: rev.note || "",
      allowSuggest: !!share.allow_suggest, sharedWith: share.label || "",
      contractor: share.contractor || "",
      data,
    });
  }
  if (method === "POST" && pathname === "/prog/shared/suggest") {
    const b = await request.json().catch(() => ({}));
    const g = await getShare(db, b.token);
    if (g.error) return json({ ok: false, error: g.error }, g.code);
    const share = g.share;
    if (!codeOk(share, b.code)) return json({ ok: false, error: "That access code isn't right." }, 403);
    if (!share.allow_suggest) return json({ ok: false, error: "Suggestions are switched off for this link." }, 403);
    const c = cleanData(b.data);
    if (c.error) return json({ ok: false, error: c.error }, 400);
    // Tag the suggestion with the revision the client actually marked up (sent
    // by the page) — if a new revision was issued while they were editing, the
    // diff still runs against the copy they saw, not the newer one.
    let revLbl = "";
    const claimed = String(b.rev || "").slice(0, 6);
    if (claimed) {
      const known = await db.prepare("SELECT rev FROM programme_revisions WHERE prog_id=? AND tenant_id=? AND rev=?")
        .bind(share.prog_id, db.tenantId, claimed).first();
      if (known) revLbl = known.rev;
    }
    if (!revLbl) {
      const rev = await latestRevision(db, share.prog_id);
      revLbl = rev ? rev.rev : "";
    }
    const id = newId("PSG");
    await db.prepare(`INSERT INTO programme_suggestions
      (id, tenant_id, prog_id, token, rev, author, note, data, status, created_at, contractor)
      VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?)`)
      .bind(id, db.tenantId, share.prog_id, share.token, revLbl,
        String(b.author || share.label || "Client").slice(0, 80),
        String(b.note || "").slice(0, 2000), c.json, new Date().toISOString(),
        share.contractor || "").run();
    // Tell whoever built the programme a client has commented.
    const prog = await db.prepare("SELECT title, created_by FROM job_programmes WHERE id=? AND tenant_id=?")
      .bind(share.prog_id, db.tenantId).first();
    if (prog?.created_by) {
      ctx?.waitUntil(sendToUser(env, tenantId, prog.created_by, {
        title: "Programme suggestion",
        body: `${String(b.author || share.label || "A client")} suggested changes on "${prog.title || "a programme"}"`,
        url: "/programme-edit.html?id=" + encodeURIComponent(share.prog_id) + "#suggestions",
        tag: "prog:" + share.prog_id,
      }).catch(() => {}));
    }
    return json({ ok: true, id });
  }

  // Client downloads a print-quality PDF of the ISSUED revision from a share
  // link — same token/code/contractor rules as /shared/open.
  if (method === "POST" && pathname === "/prog/shared/export") {
    const b = await request.json().catch(() => ({}));
    const g = await getShare(db, b.token);
    if (g.error) return json({ ok: false, error: g.error }, g.code);
    const share = g.share;
    if (share.access_code && !codeOk(share, b.code)) return json({ ok: false, error: "That access code isn't right." }, 403);
    const rev = await latestRevision(db, share.prog_id);
    if (!rev) return json({ ok: false, error: "This programme hasn't been issued yet." }, 404);
    const prog = await db.prepare("SELECT title, client, site FROM job_programmes WHERE id=? AND tenant_id=?")
      .bind(share.prog_id, db.tenantId).first();
    let data = {}; try { data = JSON.parse(rev.data); } catch {}
    if (share.contractor && Array.isArray(data.tasks)) {
      data = { ...data, tasks: data.tasks.filter(t => t && t.contractor === share.contractor) };
    }
    const bytes = buildProgrammePdf(data, {
      title: prog?.title || data.title, client: prog?.client, site: prog?.site, ref: data.ref,
      rev: rev.rev, issuedAt: rev.issued_at, sharedWith: share.label || "",
    });
    return pdfResponse(cors, bytes, `${prog?.title || "Programme"} - Rev ${rev.rev}.pdf`);
  }

  // ══ Admin: everything below needs FullAccess | Programmes ═══════════════
  const gate = await progAdmin(env, request);
  if (gate.error) return json({ ok: false, error: gate.error }, gate.code);
  const me = gate.sess.user.username;

  if (method === "GET" && pathname === "/prog/list") {
    const { results } = await db.prepare(
      "SELECT id, title, client, site, created_by, created_at, updated_at, archived FROM job_programmes WHERE tenant_id=? ORDER BY updated_at DESC"
    ).bind(db.tenantId).all();
    const progs = results || [];
    const revs = (await db.prepare(
      "SELECT prog_id, rev, issued_at FROM programme_revisions WHERE tenant_id=? ORDER BY issued_at ASC"
    ).bind(db.tenantId).all()).results || [];
    const sugg = (await db.prepare(
      "SELECT prog_id, COUNT(*) n FROM programme_suggestions WHERE tenant_id=? AND status='open' GROUP BY prog_id"
    ).bind(db.tenantId).all()).results || [];
    const shares = (await db.prepare(
      "SELECT prog_id, COUNT(*) n FROM programme_shares WHERE tenant_id=? AND revoked=0 GROUP BY prog_id"
    ).bind(db.tenantId).all()).results || [];
    const revBy = {}; for (const r of revs) revBy[r.prog_id] = { rev: r.rev, issuedAt: r.issued_at };
    const sBy = {}; for (const r of sugg) sBy[r.prog_id] = r.n;
    const shBy = {}; for (const r of shares) shBy[r.prog_id] = r.n;
    return json({
      ok: true,
      programmes: progs.map(p => ({
        ...p,
        latestRev: revBy[p.id] || null,
        openSuggestions: sBy[p.id] || 0,
        liveShares: shBy[p.id] || 0,
      })),
    });
  }

  if (method === "GET" && pathname === "/prog/one") {
    const id = searchParams.get("id") || "";
    const p = await db.prepare("SELECT * FROM job_programmes WHERE id=? AND tenant_id=?").bind(id, db.tenantId).first();
    if (!p) return json({ ok: false, error: "Programme not found" }, 404);
    let data = {}; try { data = JSON.parse(p.data); } catch {}
    const revisions = (await db.prepare(
      "SELECT id, rev, note, issued_by, issued_at FROM programme_revisions WHERE prog_id=? AND tenant_id=? ORDER BY issued_at DESC"
    ).bind(id, db.tenantId).all()).results || [];
    const shares = (await db.prepare(
      "SELECT token, label, access_code, expires_at, revoked, allow_suggest, created_at, last_opened_at, opens, contractor FROM programme_shares WHERE prog_id=? AND tenant_id=? ORDER BY created_at DESC"
    ).bind(id, db.tenantId).all()).results || [];
    const suggestions = (await db.prepare(
      "SELECT id, rev, author, note, status, created_at, decided_by, decided_at, contractor FROM programme_suggestions WHERE prog_id=? AND tenant_id=? ORDER BY created_at DESC LIMIT 100"
    ).bind(id, db.tenantId).all()).results || [];
    return json({
      ok: true,
      prog: { id: p.id, title: p.title, client: p.client, site: p.site, createdBy: p.created_by, createdAt: p.created_at, updatedAt: p.updated_at, updatedBy: p.updated_by || "", data },
      revisions, shares, suggestions,
      bankHolidays: await bankHolidayDates(db),
    });
  }

  if (method === "POST" && pathname === "/prog/save") {
    const b = await request.json().catch(() => ({}));
    const c = cleanData(b.data);
    if (c.error) return json({ ok: false, error: c.error }, 400);
    const now = new Date().toISOString();
    const title = String(b.title ?? c.obj.title ?? "").slice(0, 200) || "Untitled programme";
    const client = String(b.client ?? c.obj.client ?? "").slice(0, 200);
    const site = String(b.site ?? c.obj.site ?? "").slice(0, 200);
    let id = String(b.id || "").trim();
    if (id) {
      const row = await db.prepare("SELECT id, updated_at, updated_by FROM job_programmes WHERE id=? AND tenant_id=?").bind(id, db.tenantId).first();
      if (!row) return json({ ok: false, error: "Programme not found" }, 404);
      // Optimistic concurrency: the builder sends the version it loaded/last
      // saved. A mismatch means another device saved in between — refuse
      // instead of silently clobbering their work (client may retry without
      // baseVersion to deliberately overwrite after asking the user).
      if (b.baseVersion !== undefined && String(b.baseVersion) !== String(row.updated_at || "")) {
        return json({ ok: false, conflict: true, error: "This programme was changed on another device.", updatedAt: row.updated_at, updatedBy: row.updated_by || "" }, 409);
      }
      await db.prepare(
        "UPDATE job_programmes SET title=?, client=?, site=?, data=?, updated_at=?, updated_by=? WHERE id=? AND tenant_id=?"
      ).bind(title, client, site, c.json, now, me, id, db.tenantId).run();
    } else {
      id = newId("PRG");
      await db.prepare(`INSERT INTO job_programmes (id, tenant_id, title, client, site, data, created_by, created_at, updated_at, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, db.tenantId, title, client, site, c.json, me, now, now, me).run();
    }
    return json({ ok: true, id, updatedAt: now });
  }

  // ── AI: draft a task list from an uploaded specification/document ─────────
  // The client extracts the document's TEXT in the browser (PDF.js / plain
  // text / xlsx-lite) and posts it here. We ask Claude for a structured task
  // list, then materialise it into a brand-new working draft the office can
  // refine — nothing is issued or shared automatically.
  if (method === "POST" && pathname === "/prog/ai-draft") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) {
      return json({ ok: false, error: "AI drafting isn't switched on yet. Add the ANTHROPIC_API_KEY secret to the mostlane-api worker in the Cloudflare dashboard, then hit Deploy." }, 400);
    }
    const b = await request.json().catch(() => ({}));
    const notes = String(b.notes || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 4000);
    let text = String(b.text || "").replace(/ /g, "").trim();
    if (text.length < 40 && notes.length < 40) return json({ ok: false, error: "There wasn't enough to work from. Upload a document, or describe the works in the notes box." }, 400);
    // Keep the token cost bounded — the front of a spec carries the scope.
    const MAX_TEXT = 120000;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

    const hintTitle = String(b.title || "").slice(0, 200);
    const hintSite = String(b.site || "").slice(0, 200);
    const hintClient = String(b.client || "").slice(0, 200);

    const schema = {
      type: "object",
      properties: {
        title: { type: "string", description: "A short programme title, e.g. the project or site name." },
        contractors: {
          type: "array",
          description: "The distinct trades / contractors doing the work (e.g. Strip out, M&E, Flooring, Decoration). 1–8 of them.",
          items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
        tasks: {
          type: "array",
          description: "The work activities in the order they should happen, staggered sensibly so dependent work follows on.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The work activity, short (e.g. 'Strip out existing shopfront')." },
              contractor: { type: "string", description: "Which contractor name (from the contractors list) does this task." },
              startOffset: { type: "integer", description: "Working days after the project start this task begins (first task = 0). Stagger so tasks follow in a realistic sequence." },
              days: { type: "integer", description: "How many working days the task takes (at least 1)." },
              milestone: { type: "boolean", description: "True only for a single-point milestone like 'Handover' or 'Opening day'." },
            },
            required: ["name", "startOffset", "days"],
          },
        },
      },
      required: ["tasks"],
    };

    const sys = "You are a UK construction planner helping build a programme of works (a Gantt schedule). "
      + "From the supplied specification or scope document, produce a realistic, ordered list of work activities with sensible durations in WORKING DAYS and a start offset (in working days) from the project start, staggered so dependent trades follow on. "
      + "Group tasks under the distinct contractors/trades. Keep task names short and practical. Only include a milestone flag for true single-point events. Return between about 8 and 60 tasks — a useful starting point the planner will refine, not an exhaustive breakdown. "
      + "If the planner has given specific instructions (below), follow them closely — especially who is doing which trade (name subcontractors as the contractor for their tasks) and any sequencing or timing constraints. The planner's instructions take priority over anything implied by the document.";
    let userMsg = "";
    if (notes) {
      userMsg += "INSTRUCTIONS FROM THE PLANNER (follow these closely — they override the document where they conflict):\n" + notes + "\n\n";
    }
    userMsg += "DOCUMENT / SCOPE TO PLAN FROM";
    if (hintTitle) userMsg += ` (project: ${hintTitle})`;
    userMsg += ":\n\n" + text;

    const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
    let apiResp;
    try {
      apiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          system: sys,
          tools: [{ name: "build_programme", description: "Return the drafted programme of works.", input_schema: schema }],
          tool_choice: { type: "tool", name: "build_programme" },
          messages: [{ role: "user", content: userMsg }],
        }),
      });
    } catch (e) {
      return json({ ok: false, error: "Couldn't reach the AI service. Try again in a moment." }, 502);
    }
    if (!apiResp.ok) {
      let detail = "";
      try { const j = await apiResp.json(); detail = j?.error?.message || ""; } catch {}
      if (apiResp.status === 401 || apiResp.status === 403) {
        return json({ ok: false, error: "The AI key was rejected. Check the ANTHROPIC_API_KEY secret on the worker." }, 400);
      }
      if (apiResp.status === 404 && /model/i.test(detail)) {
        return json({ ok: false, error: `The AI model "${model}" isn't available on this key. Set ANTHROPIC_MODEL on the worker to one you can use.` }, 400);
      }
      return json({ ok: false, error: "The AI service returned an error" + (detail ? ": " + detail : ".") }, 502);
    }
    let payload;
    try { payload = await apiResp.json(); } catch { return json({ ok: false, error: "The AI service returned an unreadable response." }, 502); }
    if (payload.stop_reason === "refusal") {
      return json({ ok: false, error: "The AI declined to draft from that document. Try a clearer specification." }, 400);
    }
    const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === "build_programme") : null;
    const out = block?.input;
    if (!out || !Array.isArray(out.tasks) || !out.tasks.length) {
      return json({ ok: false, error: "The AI couldn't find any work activities in that document." }, 422);
    }

    // Materialise into the programme data shape (matches programme-gantt.js v2).
    const PALETTE = ["#00B0F0", "#92D050", "#FFC000", "#852C98", "#7F7F7F", "#e0344b", "#0369a1", "#b45309"];
    const uid = () => "c" + Math.random().toString(36).slice(2, 8);
    // Build the contractor list from the AI's contractors + any names its tasks
    // reference, so every task maps to a real legend row.
    const conByName = new Map();
    const contractors = [];
    const addCon = (nm) => {
      const name = String(nm || "").trim().slice(0, 60);
      if (!name) return null;
      const kkey = name.toLowerCase();
      if (conByName.has(kkey)) return conByName.get(kkey);
      const c = { id: uid(), name, colour: PALETTE[contractors.length % PALETTE.length] };
      contractors.push(c); conByName.set(kkey, c);
      return c;
    };
    for (const c of (out.contractors || [])) addCon(c?.name);

    // Base start: the client's chosen date, else the next Monday.
    const parseISO = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); if (!m) return null; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)); return isNaN(d) ? null : d; };
    let base = parseISO(b.startDate);
    if (!base) { base = new Date(); base.setUTCHours(12, 0, 0, 0); const wd = base.getUTCDay(); base.setUTCDate(base.getUTCDate() + ((8 - wd) % 7 || 7)); }
    const isWknd = (d) => { const g = d.getUTCDay(); return g === 0 || g === 6; };
    const addWorkingDays = (from, n) => { let d = new Date(from); let left = Math.max(0, n | 0), guard = 0; while (isWknd(d)) d.setUTCDate(d.getUTCDate() + 1); while (left > 0 && guard++ < 5000) { d.setUTCDate(d.getUTCDate() + 1); if (!isWknd(d)) left--; } return d; };
    const ymd = (d) => d.toISOString().slice(0, 10);

    const tasks = [];
    for (const t of out.tasks) {
      const name = String(t?.name || "").trim().slice(0, 200);
      if (!name) continue;
      const con = t?.contractor ? addCon(t.contractor) : null;
      const off = Math.max(0, Number(t?.startOffset) || 0);
      const start = ymd(addWorkingDays(base, off));
      const days = Math.max(1, Math.min(365, Number(t?.days) || 1));
      tasks.push({ id: uid(), name, contractor: con ? con.id : "", start, days, wknd: false, progress: 0, milestone: !!t?.milestone });
    }
    if (!tasks.length) return json({ ok: false, error: "The AI couldn't turn that document into tasks." }, 422);
    if (!contractors.length) contractors.push({ id: uid(), name: "Mostlane", colour: PALETTE[0] });

    const data = {
      title: hintTitle || String(out.title || "").slice(0, 200) || "Programme of works",
      client: hintClient, site: hintSite, ref: "", notes: "",
      contractors, tasks,
    };
    const id = newId("PRG");
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO job_programmes (id, tenant_id, title, client, site, data, created_by, created_at, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, db.tenantId, data.title, data.client, data.site, JSON.stringify(data), me, now, now, me).run();
    return json({ ok: true, id, taskCount: tasks.length, contractors: contractors.length });
  }

  if (method === "POST" && pathname === "/prog/delete") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    await db.prepare("DELETE FROM job_programmes WHERE id=? AND tenant_id=?").bind(id, db.tenantId).run();
    await db.prepare("DELETE FROM programme_revisions WHERE prog_id=? AND tenant_id=?").bind(id, db.tenantId).run();
    await db.prepare("DELETE FROM programme_shares WHERE prog_id=? AND tenant_id=?").bind(id, db.tenantId).run();
    await db.prepare("DELETE FROM programme_suggestions WHERE prog_id=? AND tenant_id=?").bind(id, db.tenantId).run();
    return json({ ok: true });
  }

  // Freeze the working draft as the next revision (A, B, … immutable).
  if (method === "POST" && pathname === "/prog/issue") {
    const b = await request.json().catch(() => ({}));
    const p = await db.prepare("SELECT * FROM job_programmes WHERE id=? AND tenant_id=?").bind(String(b.id || ""), db.tenantId).first();
    if (!p) return json({ ok: false, error: "Programme not found" }, 404);
    const n = await db.prepare("SELECT COUNT(*) n FROM programme_revisions WHERE prog_id=? AND tenant_id=?").bind(p.id, db.tenantId).first();
    const rev = revLabel(Number(n?.n || 0));
    await db.prepare(`INSERT INTO programme_revisions (id, tenant_id, prog_id, rev, data, note, issued_by, issued_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(newId("REV"), db.tenantId, p.id, rev, p.data, String(b.note || "").slice(0, 500), me, new Date().toISOString()).run();
    return json({ ok: true, rev });
  }

  // Office PDF export — the current DRAFT (what's on the builder screen), or a
  // specific issued revision when revId is sent.
  if (method === "POST" && pathname === "/prog/export") {
    const b = await request.json().catch(() => ({}));
    const p = await db.prepare("SELECT * FROM job_programmes WHERE id=? AND tenant_id=?").bind(String(b.id || ""), db.tenantId).first();
    if (!p) return json({ ok: false, error: "Programme not found" }, 404);
    let data = {}, revLbl = "", issuedAt = "";
    if (b.revId) {
      const r = await db.prepare("SELECT * FROM programme_revisions WHERE id=? AND prog_id=? AND tenant_id=?")
        .bind(String(b.revId), p.id, db.tenantId).first();
      if (!r) return json({ ok: false, error: "Revision not found" }, 404);
      try { data = JSON.parse(r.data); } catch {}
      revLbl = r.rev; issuedAt = r.issued_at;
    } else {
      try { data = JSON.parse(p.data); } catch {}
    }
    const bytes = buildProgrammePdf(data, {
      title: p.title || data.title, client: p.client, site: p.site, ref: data.ref,
      rev: revLbl, issuedAt,
    });
    return pdfResponse(cors, bytes, `${p.title || "Programme"}${revLbl ? " - Rev " + revLbl : " - DRAFT"}.pdf`);
  }

  if (method === "GET" && pathname === "/prog/revision") {
    const r = await db.prepare("SELECT * FROM programme_revisions WHERE id=? AND tenant_id=?")
      .bind(searchParams.get("id") || "", db.tenantId).first();
    if (!r) return json({ ok: false, error: "Revision not found" }, 404);
    let data = {}; try { data = JSON.parse(r.data); } catch {}
    return json({ ok: true, rev: r.rev, note: r.note, issuedBy: r.issued_by, issuedAt: r.issued_at, data });
  }

  if (method === "POST" && pathname === "/prog/share") {
    const b = await request.json().catch(() => ({}));
    const p = await db.prepare("SELECT id FROM job_programmes WHERE id=? AND tenant_id=?").bind(String(b.progId || ""), db.tenantId).first();
    if (!p) return json({ ok: false, error: "Programme not found" }, 404);
    const token = randToken();
    const days = Number(b.expiresDays);
    const expires = (days > 0) ? new Date(Date.now() + days * 86400000).toISOString() : null;
    const code = String(b.accessCode || "").trim().slice(0, 20);
    await db.prepare(`INSERT INTO programme_shares
      (token, tenant_id, prog_id, label, access_code, expires_at, revoked, allow_suggest, created_by, created_at, contractor)
      VALUES (?,?,?,?,?,?,0,?,?,?,?)`)
      .bind(token, db.tenantId, p.id, String(b.label || "").slice(0, 120), code, expires,
        b.allowSuggest === false ? 0 : 1, me, new Date().toISOString(),
        String(b.contractor || "").slice(0, 40)).run();
    return json({ ok: true, token });
  }

  if (method === "POST" && pathname === "/prog/share/revoke") {
    const b = await request.json().catch(() => ({}));
    await db.prepare("UPDATE programme_shares SET revoked=1 WHERE token=? AND tenant_id=?")
      .bind(String(b.token || ""), db.tenantId).run();
    return json({ ok: true });
  }

  if (method === "GET" && pathname === "/prog/suggestion") {
    const s = await db.prepare("SELECT * FROM programme_suggestions WHERE id=? AND tenant_id=?")
      .bind(searchParams.get("id") || "", db.tenantId).first();
    if (!s) return json({ ok: false, error: "Suggestion not found" }, 404);
    let data = {}; try { data = JSON.parse(s.data); } catch {}
    return json({ ok: true, id: s.id, progId: s.prog_id, rev: s.rev, author: s.author, note: s.note, status: s.status, createdAt: s.created_at, contractor: s.contractor || "", data });
  }

  if (method === "POST" && pathname === "/prog/suggestion/decide") {
    const b = await request.json().catch(() => ({}));
    const status = b.status === "incorporated" ? "incorporated" : b.status === "dismissed" ? "dismissed" : "open";
    await db.prepare("UPDATE programme_suggestions SET status=?, decided_by=?, decided_at=? WHERE id=? AND tenant_id=?")
      .bind(status, me, new Date().toISOString(), String(b.id || ""), db.tenantId).run();
    return json({ ok: true });
  }

  return json({ ok: false, error: "Not found: " + pathname }, 404);
}
