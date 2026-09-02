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
    return { ok: true, tool, text };
  } catch { return { ok: false, error: "Couldn't reach the AI service." }; }
}

const JOB_TYPES = {
  empat: "EM light + PAT test (combined)", reactive: "reactive / maintenance", electrical: "electrical test", firestop: "firestopping",
};

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
    const tools = [
      { name: "ask", description: "Ask the office ONE clarifying question when anything is missing or ambiguous.", input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
      { name: "draft_jobs", description: "Propose one or more jobs to create (a preview the office confirms).", input_schema: { type: "object", properties: {
        summary: { type: "string", description: "one short sentence describing what you're proposing" },
        jobs: { type: "array", items: { type: "object", properties: {
          jobType: { type: "string", enum: Object.keys(JOB_TYPES) },
          site: { type: "string", description: "store number or site name" },
          engineer: { type: "string", description: "engineer name, or empty if not given" },
          date: { type: "string", description: "today / tomorrow / a weekday / YYYY-MM-DD, or empty" },
          startTime: { type: "string", description: "HH:MM 24h, or empty" },
          durationMinutes: { type: "number" },
          priority: { type: "string", description: "e.g. Priority 1..4, or empty" },
          title: { type: "string", description: "short reference/title, or empty to use the site" },
          description: { type: "string" },
        }, required: ["jobType", "site", "description"] } },
      }, required: ["jobs"] } },
    ];
    if (fullAccess) {
      tools.push({ name: "reply", description: "Reply conversationally (Full-Access relaxed chat only).", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
      tools.push({ name: "set_rules", description: "Propose a full replacement of the house rules (Full-Access only). Return the COMPLETE new rules text.", input_schema: { type: "object", properties: { rules: { type: "string" }, summary: { type: "string" } }, required: ["rules", "summary"] } });
    }
    const system = "You are the Mostlane office job assistant. Follow the HOUSE RULES exactly. You DRAFT jobs and ask questions; a person always confirms before anything is created — never claim a job is created. "
      + (fullAccess ? "This user is FULL ACCESS: you may chat freely (use `reply`) and may adjust the rules with `set_rules` when they ask. " : "This user is TASK-ONLY: only help RAISE or MANAGE jobs. If they ask for open chat or to change the rules, use `ask` to say that's Full-Access only and steer back to the task. ")
      + "Today is " + londonToday() + " (Europe/London). HQ is " + HQ_POSTCODE + ". Field engineers: " + (engNames.join(", ") || "(none listed)") + ". "
      + "Job types: " + Object.entries(JOB_TYPES).map(([k, v]) => k + "=" + v).join("; ") + ". For an EM/PAT compliance test the description should simply be an instruction like 'Carry out 3-hour EM drain-down test and PAT testing' (duration 180). "
      + "If the request does not name an engineer, ASK who — do not leave it blank. If a site or name is ambiguous, ASK. "
      + "\n\nHOUSE RULES:\n" + (g.rules || "(none set yet)");
    const messages = [];
    for (const h of (Array.isArray(b.history) ? b.history : []).slice(-8)) {
      if (h && h.role && h.text) messages.push({ role: h.role === "user" ? "user" : "assistant", content: String(h.text).slice(0, 2000) });
    }
    messages.push({ role: "user", content: message });
    const ai = await anthropicChat(env, { system, messages, tools, forceTool: !fullAccess });
    if (!ai.ok) return json({ ok: true, kind: "reply", text: "⚠️ " + ai.error }, {}, env, request);
    const t = ai.tool;
    if (!t) return json({ ok: true, kind: "reply", text: ai.text || "I didn't catch that — try again." }, {}, env, request);
    if (t.name === "ask") return json({ ok: true, kind: "ask", question: t.input.question || "Could you clarify?" }, {}, env, request);
    if (t.name === "reply") return json({ ok: true, kind: "reply", text: t.input.text || "" }, {}, env, request);
    if (t.name === "set_rules") return json({ ok: true, kind: "rules", proposed: String(t.input.rules || "").slice(0, 20000), summary: t.input.summary || "Updated rules" }, {}, env, request);
    if (t.name === "draft_jobs") {
      const drafts = Array.isArray(t.input.jobs) ? t.input.jobs.slice(0, 12) : [];
      const jobs = [], problems = [];
      for (const d of drafts) {
        const site = await resolveSite(env, tid, d.site);
        if (!site.ok) { problems.push(site.ambiguous ? `Which site did you mean for "${d.site}"? (${site.ambiguous.slice(0, 5).join("; ")})` : `I couldn't find a site matching "${d.site}".`); continue; }
        let engUser = null, engName = "";
        if (d.engineer && String(d.engineer).trim()) {
          const en = await resolveEngineer(env, tid, d.engineer);
          if (!en.ok) { problems.push(en.ambiguous ? `Which "${d.engineer}"? (${en.ambiguous.join(", ")})` : `I couldn't find an engineer called "${d.engineer}".`); continue; }
          engUser = en.username; engName = en.name;
        } else { problems.push(`Who should do the ${JOB_TYPES[d.jobType] || "job"} at ${site.name}?`); continue; }
        const date = resolveDate(d.date);
        const empat = d.jobType === "empat";
        const dur = Number(d.durationMinutes) > 0 ? Math.round(Number(d.durationMinutes)) : (empat ? 180 : (d.jobType === "reactive" ? 90 : 120));
        const desc = String(d.description || (empat ? "Carry out 3-hour EM drain-down test and PAT testing." : "")).slice(0, 2000);
        jobs.push({
          jobType: d.jobType, siteCode: site.code, siteName: site.name, postcode: site.postcode, address: site.address,
          lat: site.lat, lon: site.lon, storeType: site.storeType, sharepointURL: site.sharepointURL, telephone: site.telephone,
          engineer: engUser, engineerName: engName, date, startTime: date ? (d.startTime || "09:00") : "",
          durationMinutes: dur, priority: (empat || d.jobType === "electrical") ? (d.priority || "Priority 4") : (d.priority || ""),
          title: d.title || site.name, description: desc,
          emTest: empat, pat: empat, electrical: d.jobType === "electrical", firestopping: d.jobType === "firestop",
          typeLabel: JOB_TYPES[d.jobType] || d.jobType,
        });
      }
      if (problems.length && !jobs.length) return json({ ok: true, kind: "ask", question: problems.join("\n") }, {}, env, request);
      return json({ ok: true, kind: "preview", summary: t.input.summary || "", jobs, warnings: problems }, {}, env, request);
    }
    return json({ ok: true, kind: "reply", text: ai.text || "" }, {}, env, request);
  }

  // ── Create confirmed drafts ───────────────────────────────────────────────
  if (sub === "/assistant/create" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const jobs = Array.isArray(b.jobs) ? b.jobs.slice(0, 12) : [];
    if (!jobs.length) return error("No jobs to create.", 400, env, request);
    const created = [];
    for (const j of jobs) {
      if (!j || !j.siteCode || !j.engineer) continue;
      const date = j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : null;
      const scheduledAt = date ? londonISO(date, j.startTime || "09:00") : null;
      // Same-day → visible now; future day → drip at 17:00 the evening before.
      const today = londonToday();
      const release = (!date || date <= today) ? { mode: "now" } : { mode: "dayBefore", hour: 17 };
      const payload = {
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
      try {
        const job = await createOrUpdateJobFromPayload(env, tid, payload);
        ctx?.waitUntil(reconcileRelease(env, tid, job).catch(() => {}));
        created.push({ id: job.id, ref: job.helpdeskRef, site: job.siteName, engineer: j.engineerName || j.engineer, date });
      } catch (e) { created.push({ error: String(e && e.message || e), site: j.siteName }); }
    }
    const okCount = created.filter(c => !c.error).length;
    const res = json({ ok: true, created }, {}, env, request);
    try { res.headers.set("X-Audit-Note", encodeURIComponent(`AI assistant created ${okCount} job(s): ` + created.filter(c => !c.error).map(c => `${c.ref} → ${c.engineer}`).join(", "))); } catch {}
    return res;
  }

  return error("Unknown assistant route: " + sub, 404, env, request);
}
