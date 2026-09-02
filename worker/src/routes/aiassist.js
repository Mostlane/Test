// AI job assistant (routes/aiassist.js, mounted /ai) — an office command box that
// turns a plain-English request into a job DRAFT (preview), following the house
// rules in app_config `ai:jobrules:<tid>`. It never executes silently: /ai/assistant
// returns a preview or a clarifying question; the office confirms via /ai/assistant/create.
//
//   GET  /ai/jobrules                 read the rulebook (office)
//   POST /ai/jobrules  {rules}        replace the rulebook (Full Access)
//   POST /ai/assistant {message,history}   → {kind:"ask"|"preview"|"reply"|"rules", …}
//   POST /ai/assistant/create {jobs}  create the confirmed job drafts (office)
//
// Two-tier chat: Full-Access users get a relaxed chat (may also tweak rules / reply
// freely); every other office user gets a task-only chat (job requests only).

import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { createOrUpdateJobFromPayload, reconcileRelease } from "./sla.js";

const RULES_KEY = tid => `ai:jobrules:${tid}`;
const HQ_POSTCODE = "PO15 5RQ";

async function getRules(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(RULES_KEY(tid)).first();
    if (row && row.value) return JSON.parse(row.value);
  } catch {}
  return { rules: "", log: [], chatModes: "" };
}
async function saveRules(env, tid, obj) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, RULES_KEY(tid), JSON.stringify(obj)).run();
}

async function isOfficeUser(env, tid, username) {
  try {
    const u = await env.DB.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=?").bind(tid, username).first();
    let p = {}; try { p = u && u.profile ? JSON.parse(u.profile) : {}; } catch {}
    return String(p.staffType || "").toLowerCase() !== "field";   // office = not a field engineer
  } catch { return false; }
}

// London date helpers.
const londonToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
function resolveDate(s) {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const base = new Date(londonToday() + "T12:00:00Z");
  if (t === "today") return londonToday();
  if (t === "tomorrow") { base.setUTCDate(base.getUTCDate() + 1); return base.toISOString().slice(0, 10); }
  const dows = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const di = dows.findIndex(d => t.includes(d));
  if (di >= 0) { for (let i = 1; i <= 7; i++) { base.setUTCDate(base.getUTCDate() + 1); if (base.getUTCDay() === di) return base.toISOString().slice(0, 10); } }
  return null;
}
// London wall-clock (date + HH:MM) → UTC ISO. Uses the tz offset at that instant.
function londonISO(date, hhmm) {
  const [hh, mm] = String(hhmm || "09:00").split(":").map(n => parseInt(n, 10) || 0);
  const naive = Date.parse(date + "T" + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":00Z");
  let offMin = 0;
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(new Date(naive)).reduce((a, x) => (a[x.type] = x.value, a), {});
    offMin = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - naive) / 60000);
  } catch {}
  return new Date(naive - offMin * 60000).toISOString();
}

async function resolveSite(env, tid, query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false };
  const num = q.replace(/\D/g, "");
  // Prefer an exact store-number match (numeric, incl. leading-zero variants).
  try {
    if (num) {
      const cands = [num, num.padStart(4, "0"), String(Number(num))];
      for (const c of [...new Set(cands)]) {
        const r = await env.DB.prepare("SELECT site_number, site_name, postcode, client, data FROM sites WHERE tenant_id=? AND site_number=? AND active=1 LIMIT 1").bind(tid, c).first();
        if (r) return siteOut(r);
      }
    }
  } catch {}
  // Else name search.
  try {
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    const { results } = await env.DB.prepare("SELECT site_number, site_name, postcode, client, data FROM sites WHERE tenant_id=? AND active=1 AND site_name LIKE ? ORDER BY length(site_name) LIMIT 6").bind(tid, like).all();
    if (results && results.length === 1) return siteOut(results[0]);
    if (results && results.length > 1) return { ok: false, ambiguous: results.map(r => `${r.site_number} ${r.site_name}`) };
  } catch {}
  return { ok: false };
}
function siteOut(r) {
  let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
  const addr = [d.address1 || d.street, d.town, d.county, r.postcode].filter(Boolean).join(", ");
  return { ok: true, code: r.site_number, name: r.site_name, postcode: r.postcode || d.postcode || "",
    address: addr, lat: d.lat, lon: d.lon || d.lng, telephone: d.telephone || "", storeType: d.storeType || r.client || "",
    sharepointURL: d.sharepointURL || "" };
}

async function resolveEngineer(env, tid, name) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return { ok: false, none: true };
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR status='Active')").bind(tid).all();
    const norm = s => String(s || "").toLowerCase().trim();
    const matches = (results || []).filter(u => {
      const full = norm(u.first_name + " " + u.last_name), fn = norm(u.first_name), un = norm(u.username);
      return un === q || full === q || fn === q || full.startsWith(q) || (q.length >= 3 && full.includes(q));
    });
    if (matches.length === 1) return { ok: true, username: matches[0].username, name: (matches[0].first_name + " " + matches[0].last_name).trim() };
    if (matches.length > 1) return { ok: false, ambiguous: matches.map(m => (m.first_name + " " + m.last_name).trim()) };
  } catch {}
  return { ok: false };
}

// ── Anthropic (tools) ─────────────────────────────────────────────────────────
async function anthropicChat(env, { system, messages, tools, forceTool }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "AI isn't configured on the server (no API key)." };
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1500, system, tools, tool_choice: forceTool ? { type: "any" } : { type: "auto" }, messages }),
    });
    if (!r.ok) { let d = ""; try { d = (await r.json())?.error?.message || ""; } catch {} return { ok: false, error: "AI error" + (d ? " (" + d + ")" : "") }; }
    const p = await r.json();
    const tool = Array.isArray(p.content) ? p.content.find(c => c.type === "tool_use") : null;
    const text = Array.isArray(p.content) ? p.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim() : "";
    return { ok: true, tool, text, content: Array.isArray(p.content) ? p.content : [] };
  } catch { return { ok: false, error: "Couldn't reach the AI service." }; }
}

// ── Live SLA job lookup (so the assistant can find + assign EXISTING jobs) ─────
function jobRow(r) {
  let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
  const engs = Array.isArray(d.assignedEngineers) ? d.assignedEngineers : (d.assignedTo ? [d.assignedTo] : []);
  return { id: r.id, ref: d.helpdeskRef || r.helpdesk_ref || r.id, siteName: d.siteName || "", siteCode: d.siteCode || r.site_code || "",
    status: d.status || r.status || "", priority: d.priority || "", scheduledAt: d.scheduledAt || r.scheduled_at || null,
    engineers: engs, durationMinutes: d.durationMinutes || null, description: String(d.description || r.description || "").slice(0, 220), _dormant: !!d.fallbackTemplate };
}
const FINISHED = /^(complete|closed|closed jobs|invoiced|cancelled)$/i;
async function searchJobs(env, tid, query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const like = "%" + q.replace(/[%_]/g, "") + "%";
  // A reference like "28767/1" is stored as "28767-Andover…" — match the leading
  // number run too so the slash/line-suffix the office types never misses it.
  const numRun = (q.match(/\d{3,}/) || [])[0];
  const likeNum = numRun ? "%" + numRun + "%" : like;
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, helpdesk_ref, description, status, site_code, scheduled_at, updated_at, data FROM sla_jobs WHERE tenant_id=? AND (helpdesk_ref LIKE ? OR helpdesk_ref LIKE ? OR description LIKE ? OR site_code LIKE ? OR lower(status) LIKE lower(?) OR lower(data) LIKE lower(?)) ORDER BY (CASE WHEN lower(status) LIKE lower(?) THEN 0 ELSE 1 END), (CASE WHEN status IN ('Complete','Closed','Closed Jobs','Invoiced','Cancelled') THEN 1 ELSE 0 END), updated_at DESC LIMIT 60"
    ).bind(tid, like, likeNum, like, like, like, like, like).all();
    return (results || [])
      .map(jobRow)
      .filter(j => !j._dormant)   // dormant fallback templates never surface
      .slice(0, 20);
  } catch { return []; }
}
async function jobById(env, tid, id) {
  try {
    const r = await env.DB.prepare("SELECT id, helpdesk_ref, description, status, site_code, scheduled_at, data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, id).first();
    return r ? jobRow(r) : null;
  } catch { return null; }
}
// Resolve one assignment target: by exact job id, else by a typed reference/number.
async function resolveJobTarget(env, tid, a) {
  if (a.jobId) { const j = await jobById(env, tid, a.jobId); if (j) return { ok: true, job: j }; }
  const ref = String(a.jobRef || a.ref || a.jobId || "").trim();
  if (!ref) return { ok: false, notfound: true };
  const rows = await searchJobs(env, tid, ref);
  const norm = s => String(s || "").toLowerCase();
  const numRun = (ref.match(/\d{3,}/) || [])[0];   // the job number (ignore a "/1" line suffix)
  // Prefer a match on the reference number the office typed.
  let hits = rows.filter(r => norm(r.ref).includes(norm(ref)) || (numRun && String(r.ref).includes(numRun)));
  if (!hits.length) hits = rows;
  const open = hits.filter(r => !FINISHED.test(r.status));
  const pool = open.length ? open : hits;
  if (pool.length === 1) return { ok: true, job: pool[0] };
  if (pool.length > 1) return { ok: false, ambiguous: pool.slice(0, 6).map(r => `${r.ref} (${r.siteName || r.siteCode}${r.status ? ", " + r.status : ""})`) };
  return { ok: false, notfound: true };
}

const JOB_TYPES = {
  empat: "EM light + PAT test (combined)", reactive: "reactive / maintenance", electrical: "electrical test", firestop: "firestopping",
};

// ── Day sequencing: order + space several jobs on one engineer's day ──────────
const HQ_COORD = { lat: 50.8607, lon: -1.2610 };   // PO15 5RQ (Segensworth / HQ)
function haversineMi(a, b) {
  if (!a || !b) return null;
  const R = 3958.8, tr = Math.PI / 180;
  const dLat = (b.lat - a.lat) * tr, dLon = (b.lon - a.lon) * tr;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * tr) * Math.cos(b.lat * tr) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const travelMin = (a, b) => { const mi = haversineMi(a, b); return mi == null ? 30 : Math.max(10, Math.round((mi * 1.25 / 30 * 60) / 5) * 5); };
const hmToMin = s => { const [h, m] = String(s || "08:00").split(":").map(n => parseInt(n, 10) || 0); return h * 60 + m; };
const minToHm = t => { t = Math.max(0, Math.min(23 * 60 + 55, Math.round(t))); return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
const _geoCache = new Map();
async function geocodePostcode(pc) {
  const key = String(pc || "").toUpperCase().replace(/\s+/g, "");
  if (!key) return null;
  if (_geoCache.has(key)) return _geoCache.get(key);
  let c = null;
  try {
    const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(key));
    if (r.ok) { const j = await r.json(); const res = j && j.result; if (res && Number.isFinite(res.latitude) && Number.isFinite(res.longitude)) c = { lat: res.latitude, lon: res.longitude }; }
  } catch {}
  _geoCache.set(key, c); return c;
}
async function coordsForJob(env, tid, j) {
  const lat = Number(j.lat), lon = Number(j.lon != null ? j.lon : j.lng);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  let pc = j.postcode || "";
  if (j.siteCode) {
    try {
      const code = String(j.siteCode);
      const cands = [...new Set([code, code.padStart(4, "0"), String(Number(code) || "")].filter(Boolean))];
      let r = null;
      for (const c of cands) { r = await env.DB.prepare("SELECT postcode, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, c).first(); if (r) break; }
      if (r) { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} const la = Number(d.lat), lo = Number(d.lon != null ? d.lon : d.lng); if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lon: lo }; pc = pc || r.postcode || d.postcode || ""; }
    } catch {}
  }
  return pc ? await geocodePostcode(pc) : null;
}
// Lay out each engineer's dated jobs in a sensible nearest-neighbour order from
// HQ, starting at the earliest requested time, spacing by on-site + travel time.
async function sequenceDay(env, tid, jobs) {
  const groups = {};
  for (const j of jobs) {
    if (!(j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date))) continue;
    const key = j.engineer + "|" + j.date;
    (groups[key] = groups[key] || []).push(j);
  }
  for (const key of Object.keys(groups)) {
    const grp = groups[key];
    if (grp.length < 2) continue;
    for (const j of grp) j._c = await coordsForJob(env, tid, j);
    const startMins = grp.map(j => j.startTime).filter(Boolean).map(hmToMin).sort((a, b) => a - b);
    let cur = startMins.length ? startMins[0] : 8 * 60;
    // nearest-neighbour route from HQ; coord-less jobs sink to the end (stable).
    const ordered = [], pool = grp.slice(); let from = HQ_COORD;
    while (pool.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < pool.length; i++) { const d = pool[i]._c ? haversineMi(from, pool[i]._c) : 1e6 + i; if (d < bd) { bd = d; bi = i; } }
      const nx = pool.splice(bi, 1)[0]; ordered.push(nx); if (nx._c) from = nx._c;
    }
    let prev = null, prevC = HQ_COORD;
    for (const j of ordered) {
      if (prev) cur = Math.ceil((cur + (Number(prev.durationMinutes) || 60) + travelMin(prevC, j._c || prevC)) / 5) * 5;
      j.startTime = minToHm(cur);
      prev = j; prevC = j._c || prevC;
    }
    grp.forEach(j => { delete j._c; });
  }
}

export async function handle(request, env, ctx, url, sess) {
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/ai(?=\/|$)/, "") || "/";
  const headers = corsHeaders(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const perms = await permissionsFor(env, tid, me);
  const fullAccess = perms.FullAccess === "Yes";
  const office = fullAccess || await isOfficeUser(env, tid, me);
  if (!office) return error("The job assistant is for office staff.", 403, env, request);

  // ── Rulebook ──────────────────────────────────────────────────────────────
  if (sub === "/jobrules" && method === "GET") {
    const g = await getRules(env, tid);
    return json({ ok: true, rules: g.rules || "", chatModes: g.chatModes || "", log: g.log || [], canEdit: fullAccess }, {}, env, request);
  }
  if (sub === "/jobrules" && method === "POST") {
    if (!fullAccess) return error("Only Full-Access users can edit the rules.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const g = await getRules(env, tid);
    g.rules = String(b.rules || "").slice(0, 20000);
    g.updatedAt = new Date().toISOString();
    if (b.logNote) { g.log = g.log || []; g.log.push({ q: "Rule edit", a: String(b.logNote).slice(0, 300), at: g.updatedAt, by: me }); g.log = g.log.slice(-200); }
    await saveRules(env, tid, g);
    return json({ ok: true }, {}, env, request);
  }

  // ── The assistant turn ────────────────────────────────────────────────────
  if (sub === "/assistant" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const message = String(b.message || "").slice(0, 4000);
    if (!message) return error("Say what you'd like me to do.", 400, env, request);
    const g = await getRules(env, tid);
    // Field engineers list (names) for context.
    let engNames = [];
    try {
      const { results } = await env.DB.prepare("SELECT first_name, last_name, profile FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR status='Active')").bind(tid).all();
      engNames = (results || []).filter(u => { let p = {}; try { p = JSON.parse(u.profile || "{}"); } catch {} return String(p.staffType || "").toLowerCase() === "field"; })
        .map(u => (u.first_name + " " + u.last_name).trim()).filter(Boolean);
    } catch {}
    // Custom job categories — a job's STATUS can be one of these to mark a
    // workstream (e.g. "FRA Works"). The assistant must recognise these.
    let cats = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='sla_categories'").bind(tid).first(); if (row && row.value) cats = (JSON.parse(row.value) || []).map(c => c && c.name).filter(Boolean); } catch {}
    const tools = [
      { name: "find_jobs", description: "Search the LIVE job board for existing jobs — by reference/incident number, site name or store number, or words from the description. ALWAYS use this first when the office refers to jobs that already exist (reference numbers like '28767/1', 'the Tesco job', a store number). Returns matching jobs with their id, ref, site, status and current engineer.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "ask", description: "Ask the office ONE clarifying question — only when something genuinely can't be found or is truly ambiguous. Don't ask for details you can look up with find_jobs.", input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
      { name: "assign_jobs", description: "Assign and/or schedule one or more EXISTING jobs to an engineer (you found them with find_jobs). Use this for 'assign X to Y', 'give these to Z tomorrow', 'move to Thursday', etc.", input_schema: { type: "object", properties: {
        summary: { type: "string" },
        assignments: { type: "array", items: { type: "object", properties: {
          jobId: { type: "string", description: "the job id from find_jobs (preferred)" },
          jobRef: { type: "string", description: "the reference the office typed, if you don't have the id" },
          engineer: { type: "string", description: "engineer name" },
          date: { type: "string", description: "today / tomorrow / a weekday / YYYY-MM-DD, or empty to leave the date as-is" },
          startTime: { type: "string", description: "HH:MM 24h, or empty" },
          durationMinutes: { type: "number" },
        }, required: [] } },
      }, required: ["assignments"] } },
      { name: "draft_jobs", description: "Propose brand-NEW jobs to create (only for work not already on the board). A preview the office confirms.", input_schema: { type: "object", properties: {
        summary: { type: "string", description: "one short sentence describing what you're proposing" },
        jobs: { type: "array", items: { type: "object", properties: {
          jobType: { type: "string", enum: Object.keys(JOB_TYPES), description: "best guess; use reactive if unsure" },
          site: { type: "string", description: "store number or site name" },
          engineer: { type: "string", description: "engineer name, or empty if not given" },
          date: { type: "string", description: "today / tomorrow / a weekday / YYYY-MM-DD, or empty" },
          startTime: { type: "string", description: "HH:MM 24h, or empty" },
          durationMinutes: { type: "number" },
          priority: { type: "string", description: "e.g. Priority 1..4, or empty" },
          title: { type: "string", description: "short reference/title, or empty to use the site" },
          description: { type: "string" },
        }, required: ["site", "description"] } },
      }, required: ["jobs"] } },
    ];
    if (fullAccess) {
      tools.push({ name: "reply", description: "Reply conversationally (Full-Access relaxed chat only).", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
      tools.push({ name: "set_rules", description: "Propose a full replacement of the house rules (Full-Access only). Return the COMPLETE new rules text.", input_schema: { type: "object", properties: { rules: { type: "string" }, summary: { type: "string" } }, required: ["rules", "summary"] } });
    }
    const system = "You are the Mostlane office job assistant on the live SLA job board. You can LOOK UP existing jobs with find_jobs and assign/schedule them, or draft new jobs. A person always confirms before anything changes — never claim a job is created or assigned. "
      + "Be smart and proactive: when the office gives reference/incident numbers or names an existing job, USE find_jobs to look it up rather than asking them to re-type details. Job type doesn't matter when you're just assigning an existing job. "
      + (fullAccess ? "This user is FULL ACCESS: you may chat freely (use `reply`) and may adjust the rules with `set_rules` when they ask. " : "This user is TASK-ONLY: only help RAISE or MANAGE jobs. If they ask for open chat or to change the rules, use `ask` to say that's Full-Access only and steer back to the task. ")
      + "Today is " + londonToday() + " (Europe/London). HQ is " + HQ_POSTCODE + ". Field engineers: " + (engNames.join(", ") || "(none listed)") + ". "
      + (cats.length ? ("Custom job categories on this board: " + cats.join(", ") + ". A job's STATUS can be one of these to mark a workstream — e.g. jobs with status \"FRA Works\" ARE the Fire Risk Assessment remedial jobs (\"the FRA tracker\" / \"FRA works\"). When the office names a workstream, find_jobs for that category name and treat jobs whose STATUS equals it as that workstream — do NOT dismiss them as unrelated text just because random words also contain those letters. A job is OUTSTANDING unless its status is Complete/Closed/Closed Jobs/Invoiced/Cancelled. \"Send <engineer> in\" for a workstream means SCHEDULE those outstanding jobs (usually already assigned to them) onto the given day via assign_jobs — keep the engineer, set the date. ") : "")
      + "For a NEW EM/PAT compliance test the description should simply read like 'Carry out 3-hour EM drain-down test and PAT testing' (duration 180). "
      + "If a NEW job doesn't name an engineer, ASK who. Only ask about things you cannot resolve with a lookup. "
      + "\n\nHOUSE RULES:\n" + (g.rules || "(none set yet)");
    const messages = [];
    for (const h of (Array.isArray(b.history) ? b.history : []).slice(-8)) {
      if (h && h.role && h.text) messages.push({ role: h.role === "user" ? "user" : "assistant", content: String(h.text).slice(0, 2000) });
    }
    messages.push({ role: "user", content: message });

    // Agentic loop: let the model call find_jobs (possibly several in one turn,
    // and re-search) before proposing. Every tool_use in an assistant message
    // MUST get a matching tool_result, or the next call is rejected.
    let t = null, ai = null;
    for (let round = 0; round < 5; round++) {
      ai = await anthropicChat(env, { system, messages, tools, forceTool: !fullAccess });
      if (!ai.ok) return json({ ok: true, kind: "reply", text: "⚠️ " + ai.error }, {}, env, request);
      const uses = (ai.content || []).filter(c => c.type === "tool_use");
      const finds = uses.filter(c => c.name === "find_jobs");
      if (finds.length) {
        messages.push({ role: "assistant", content: ai.content });
        const out = [];
        for (const u of uses) {
          if (u.name === "find_jobs") {
            const found = await searchJobs(env, tid, u.input.query || "");
            out.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ count: found.length, jobs: found }) });
          } else {
            out.push({ type: "tool_result", tool_use_id: u.id, content: "Use the find_jobs results above, then propose again." });
          }
        }
        messages.push({ role: "user", content: out });
        continue;   // let the model use the results
      }
      t = uses[0] || null;
      break;
    }
    if (!t) return json({ ok: true, kind: "reply", text: ai.text || "I didn't catch that — try again." }, {}, env, request);
    if (t.name === "ask") return json({ ok: true, kind: "ask", question: t.input.question || "Could you clarify?" }, {}, env, request);
    if (t.name === "reply") return json({ ok: true, kind: "reply", text: t.input.text || "" }, {}, env, request);
    if (t.name === "set_rules") return json({ ok: true, kind: "rules", proposed: String(t.input.rules || "").slice(0, 20000), summary: t.input.summary || "Updated rules" }, {}, env, request);

    if (t.name === "assign_jobs") {
      const list = Array.isArray(t.input.assignments) ? t.input.assignments.slice(0, 12) : [];
      const jobs = [], problems = [];
      for (const a of list) {
        const jt = await resolveJobTarget(env, tid, a);
        if (!jt.ok) { problems.push(jt.ambiguous ? `Which job did you mean for "${a.jobRef || a.jobId}"? (${jt.ambiguous.join("; ")})` : `I couldn't find a job matching "${a.jobRef || a.jobId || "(blank)"}".`); continue; }
        const job = jt.job;
        let engUser = null, engName = "";
        if (a.engineer && String(a.engineer).trim()) {
          const en = await resolveEngineer(env, tid, a.engineer);
          if (!en.ok) { problems.push(en.ambiguous ? `Which "${a.engineer}"? (${en.ambiguous.join(", ")})` : `I couldn't find an engineer called "${a.engineer}".`); continue; }
          engUser = en.username; engName = en.name;
        } else { problems.push(`Who should ${job.ref} go to?`); continue; }
        const date = resolveDate(a.date);
        const warns = [];
        if (job.engineers && job.engineers.length && !job.engineers.map(String).map(s => s.toLowerCase()).includes(engUser.toLowerCase()))
          warns.push(`currently ${job.engineers.join(", ")}`);
        if (FINISHED.test(job.status)) warns.push(`this job is ${job.status}`);
        jobs.push({
          action: "assign", jobId: job.id, siteCode: job.siteCode, siteName: job.siteName,
          engineer: engUser, engineerName: engName, date, startTime: date ? (a.startTime || "08:00") : "",
          durationMinutes: Number(a.durationMinutes) > 0 ? Math.round(Number(a.durationMinutes)) : job.durationMinutes,
          priority: job.priority, title: job.ref, description: job.description,
          currentStatus: job.status, currentEngineers: job.engineers, typeLabel: "Assign job", warn: warns,
        });
      }
      if (problems.length && !jobs.length) return json({ ok: true, kind: "ask", question: problems.join("\n") }, {}, env, request);
      await sequenceDay(env, tid, jobs);   // order + space same-engineer, same-day jobs
      return json({ ok: true, kind: "preview", summary: t.input.summary || "", jobs, warnings: problems }, {}, env, request);
    }

    if (t.name === "draft_jobs") {
      const drafts = Array.isArray(t.input.jobs) ? t.input.jobs.slice(0, 12) : [];
      const jobs = [], problems = [];
      for (const d of drafts) {
        const site = await resolveSite(env, tid, d.site);
        if (!site.ok) { problems.push(site.ambiguous ? `Which site did you mean for "${d.site}"? (${site.ambiguous.slice(0, 5).join("; ")})` : `I couldn't find a site matching "${d.site}".`); continue; }
        const jobType = d.jobType || "reactive";
        let engUser = null, engName = "";
        if (d.engineer && String(d.engineer).trim()) {
          const en = await resolveEngineer(env, tid, d.engineer);
          if (!en.ok) { problems.push(en.ambiguous ? `Which "${d.engineer}"? (${en.ambiguous.join(", ")})` : `I couldn't find an engineer called "${d.engineer}".`); continue; }
          engUser = en.username; engName = en.name;
        } else { problems.push(`Who should do the ${JOB_TYPES[jobType] || "job"} at ${site.name}?`); continue; }
        const date = resolveDate(d.date);
        const empat = jobType === "empat";
        const dur = Number(d.durationMinutes) > 0 ? Math.round(Number(d.durationMinutes)) : (empat ? 180 : (jobType === "reactive" ? 90 : 120));
        const desc = String(d.description || (empat ? "Carry out 3-hour EM drain-down test and PAT testing." : "")).slice(0, 2000);
        jobs.push({
          action: "create", jobType, siteCode: site.code, siteName: site.name, postcode: site.postcode, address: site.address,
          lat: site.lat, lon: site.lon, storeType: site.storeType, sharepointURL: site.sharepointURL, telephone: site.telephone,
          engineer: engUser, engineerName: engName, date, startTime: date ? (d.startTime || "09:00") : "",
          durationMinutes: dur, priority: (empat || jobType === "electrical") ? (d.priority || "Priority 4") : (d.priority || ""),
          title: d.title || site.name, description: desc,
          emTest: empat, pat: empat, electrical: jobType === "electrical", firestopping: jobType === "firestop",
          typeLabel: JOB_TYPES[jobType] || jobType,
        });
      }
      if (problems.length && !jobs.length) return json({ ok: true, kind: "ask", question: problems.join("\n") }, {}, env, request);
      await sequenceDay(env, tid, jobs);   // order + space same-engineer, same-day jobs
      return json({ ok: true, kind: "preview", summary: t.input.summary || "", jobs, warnings: problems }, {}, env, request);
    }
    return json({ ok: true, kind: "reply", text: ai.text || "" }, {}, env, request);
  }

  // ── Create confirmed drafts ───────────────────────────────────────────────
  if (sub === "/assistant/create" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const jobs = Array.isArray(b.jobs) ? b.jobs.slice(0, 12) : [];
    if (!jobs.length) return error("No jobs to create.", 400, env, request);
    const today = londonToday();
    const created = [];
    for (const j of jobs) {
      if (!j || !j.engineer) continue;
      const date = j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : null;
      const scheduledAt = date ? londonISO(date, j.startTime || (j.action === "assign" ? "08:00" : "09:00")) : null;
      // Same-day (or no date) → visible now; future day → drip at 17:00 the evening before.
      const release = (!date || date <= today) ? { mode: "now" } : { mode: "dayBefore", hour: 17 };
      let payload;
      if (j.action === "assign") {
        // Re-assign / re-schedule an EXISTING job — id-merge keeps everything else.
        if (!j.jobId) continue;
        payload = {
          id: String(j.jobId), assignedEngineers: [j.engineer],
          scheduledAt: scheduledAt || undefined,
          durationMinutes: Number(j.durationMinutes) || undefined,
          release, changedBy: me + " (assistant)",
        };
      } else {
        if (!j.siteCode) continue;
        payload = {
          reference: crypto.randomUUID(), helpdeskRef: String(j.title || j.siteName || j.siteCode),
          description: String(j.description || ""), siteCode: String(j.siteCode), siteName: String(j.siteName || ""),
          address: String(j.address || ""), postcode: String(j.postcode || ""), telephone: String(j.telephone || ""),
          lat: j.lat, lon: j.lon, storeType: String(j.storeType || ""), sharepointURL: String(j.sharepointURL || ""),
          assignedEngineers: [j.engineer], status: "Scheduled", priority: String(j.priority || ""),
          scheduledAt, durationMinutes: Number(j.durationMinutes) || undefined,
          emTest: !!j.emTest, pat: !!j.pat, electrical: !!j.electrical, firestopping: !!j.firestopping,
          workArea: (j.emTest || j.electrical) ? "electrical" : undefined,
          release, changedBy: me + " (assistant)",
        };
      }
      try {
        const job = await createOrUpdateJobFromPayload(env, tid, payload);
        ctx?.waitUntil(reconcileRelease(env, tid, job).catch(() => {}));
        created.push({ id: job.id, ref: job.helpdeskRef, site: job.siteName, engineer: j.engineerName || j.engineer, date, action: j.action || "create" });
      } catch (e) { created.push({ error: String(e && e.message || e), site: j.siteName || j.title }); }
    }
    const okc = created.filter(c => !c.error);
    const res = json({ ok: true, created }, {}, env, request);
    try { res.headers.set("X-Audit-Note", encodeURIComponent(`AI assistant: ` + okc.map(c => `${c.action === "assign" ? "assigned" : "created"} ${c.ref} → ${c.engineer}`).join(", "))); } catch {}
    return res;
  }

  return error("Unknown assistant route: " + sub, 404, env, request);
}
