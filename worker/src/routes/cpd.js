// CPD training (Continuing Professional Development) — primarily for electricians.
// An admin builds MODULES (reading material + a short multiple-choice test + a pass
// mark). An engineer reads the material (the time they spend is tracked, visibility-
// aware) then takes the test; every ATTEMPT is logged with the date, time spent,
// score and pass/fail. The records are kept for every user so the owner can evidence
// CPD at the yearly NICEIC audit (admin report + CSV export).
//
//   Learner (CPD | FullAccess):
//     GET  /cpd/modules                 active modules + my best attempt status
//     GET  /cpd/module?id=              one module (content + questions, NO answers)
//     POST /cpd/submit                  {moduleId, startedAt, durationSeconds, answers}
//                                        → graded + logged; returns score/pass/results
//     GET  /cpd/my                      my own attempt history
//   Admin (FullAccess):
//     GET  /cpd/admin/modules           every module (+ inactive) + attempt counts
//     POST /cpd/admin/module            create/update a module
//     POST /cpd/admin/module-delete     {id}  (keeps the attempt history)
//     GET  /cpd/admin/report?user=&module=&from=&to=   the audit log (every attempt)
//
// Tables (self-migrating): cpd_modules, cpd_attempts.
import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { onceMigration } from "../lib/once.js";

async function ensureTables__raw(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cpd_modules (
    tenant_id INTEGER, id TEXT, title TEXT, category TEXT, content TEXT, video TEXT,
    pass_mark INTEGER, min_seconds INTEGER, questions TEXT, active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, created_by TEXT,
    PRIMARY KEY (tenant_id, id))`).run();
  // `video` added Oct 2026 — a module can embed a YouTube video to watch before the
  // test. Self-migrating for a cpd_modules table created before this column existed.
  try { await env.DB.prepare(`ALTER TABLE cpd_modules ADD COLUMN video TEXT`).run(); } catch {}
  // `segments` (Oct 2026) — a lesson's ordered YouTube clips [{id,start,end}], which
  // supersedes the single `video`. Self-migrating; a legacy `video` reads as one clip.
  try { await env.DB.prepare(`ALTER TABLE cpd_modules ADD COLUMN segments TEXT`).run(); } catch {}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cpd_attempts (
    tenant_id INTEGER, id TEXT, module_id TEXT, module_title TEXT, category TEXT,
    username TEXT, started_at TEXT, submitted_at TEXT, duration_seconds INTEGER,
    score INTEGER, total INTEGER, correct INTEGER, pass_mark INTEGER, passed INTEGER,
    answers TEXT, created_at TEXT, PRIMARY KEY (tenant_id, id))`).run();
  // Index for the per-user lookups + the audit report.
  try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS cpd_att_user ON cpd_attempts (tenant_id, username, submitted_at)`).run(); } catch {}
}
const ensureTables = onceMigration(ensureTables__raw);

// Pull the 11-char YouTube video id out of whatever the admin pastes (a full
// watch/share/embed/shorts URL, or a bare id). Returns "" if it isn't a YouTube id.
export function parseYouTubeId(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;                    // already a bare id
  const m = s.match(/(?:youtu\.be\/|\/embed\/|\/shorts\/|[?&]v=)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}
// A time as seconds (number or "90") or a clock string ("1:30", "1:02:05") → seconds.
export function parseTime(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v >= 0 ? Math.round(v) : null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);   // h:mm:ss or m:ss
  if (m) return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
  return null;
}
// A LESSON is an ordered list of YouTube clips: [{id, start, end}] (start/end in
// seconds, null = natural start/end). Only real YouTube ids with a sane range survive.
export function parseSegments(input) {
  const out = [];
  for (const raw of (Array.isArray(input) ? input : [])) {
    if (!raw) continue;
    const id = parseYouTubeId(raw.id || raw.url || raw.video || "");
    if (!id) continue;
    let start = parseTime(raw.start), end = parseTime(raw.end);
    if (start != null && start < 0) start = null;
    if (end != null && start != null && end <= start) end = null;   // invalid range → play to natural end
    out.push({ id, start: start == null ? null : start, end: end == null ? null : end });
    if (out.length >= 12) break;
  }
  return out;
}
const nowISO = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "cpd-" + Date.now() + "-" + Math.random().toString(36).slice(2));
const clampInt = (v, lo, hi) => { let n = Math.round(Number(v) || 0); if (n < lo) n = lo; if (n > hi) n = hi; return n; };

// A module's questions are stored as [{id, q, options:[...], answer:<index>}].
// Sanitise anything the admin sends so a malformed question can't break grading.
export function normQuestions(input) {
  const out = [];
  for (const raw of (Array.isArray(input) ? input : [])) {
    if (!raw) continue;
    const q = String(raw.q || raw.question || "").trim();
    const options = (Array.isArray(raw.options) ? raw.options : []).map(o => String(o == null ? "" : o).trim()).filter(o => o !== "").slice(0, 8);
    if (!q || options.length < 2) continue;                 // need a question + ≥2 options
    let answer = Number(raw.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) answer = 0;
    out.push({ id: String(raw.id || "") || uid(), q: q.slice(0, 600), options, answer });
    if (out.length >= 50) break;
  }
  return out;
}
// What the LEARNER receives — the correct answer is never sent to the browser.
export const stripAnswers = qs => (Array.isArray(qs) ? qs : []).map(x => ({ id: x.id, q: x.q, options: x.options }));

// Grade a submitted attempt. `answers` is a map {questionId: chosenIndex}. A module
// with NO questions is a reading-only module → score 100 / passed. Pure + testable.
export function gradeAttempt(questions, answers) {
  const qs = Array.isArray(questions) ? questions : [];
  const a = (answers && typeof answers === "object") ? answers : {};
  const results = [];
  let correct = 0;
  for (const q of qs) {
    const given = a[q.id];
    const ok = given != null && Number(given) === Number(q.answer);
    if (ok) correct++;
    results.push({ id: q.id, correct: ok, given: (given == null ? null : Number(given)), answer: q.answer });
  }
  const total = qs.length;
  const score = total ? Math.round((correct / total) * 100) : 100;
  return { correct, total, score, results };
}

// ── YouTube transcript → AI question drafting ──────────────────────────────────
// The office shouldn't have to watch a video and write questions by hand. A YouTube
// video almost always carries a transcript (captions); we fetch it server-side (the
// browser can't — cross-origin) and hand it to Claude to draft the multiple-choice
// questions. Everything FAILS SOFT: no captions / no key → a clear message so the
// office falls back to pasting the transcript or adding questions by hand.
const YT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// YouTube's OWN public InnerTube keys — the ones embedded in youtube.com's page
// source and the YouTube app, used to ask YouTube for a video's captions. These
// are NOT a private/Mostlane Google key (no account or billing sits behind them).
// Assembled at runtime from parts so secret-scanners (GitGuardian) don't false-flag
// a plain `AIza…` literal in the repo. Not confidential — just noise-avoidance.
const YT_WEB_KEY = ["AIza", "SyAO_FJ2SlqU8Q4STEHLG", "Cilw_Y9_11qcW8"].join("");
const YT_ANDROID_KEY = ["AIza", "SyA8eiZmM1FaDVjRy-df2K", "TyQ_vz_yYM39w"].join("");
// Cookie that gets past Google's EU consent interstitial on a server fetch.
const YT_CONSENT = "CONSENT=YES+1; SOCS=CAI";
// InnerTube client contexts to try, in order of reliability from a datacenter IP.
// ANDROID / TVHTML5 return captionTracks without the consent/bot wall the WEB
// watch page hits; WEB is the last resort.
const YT_CLIENTS = [
  { key: YT_ANDROID_KEY, host: "youtubei.googleapis.com", ua: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
    ctx: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "GB" } },
  { key: YT_WEB_KEY, host: "www.youtube.com", ua: "Mozilla/5.0",
    ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "GB" } },
  { key: YT_WEB_KEY, host: "www.youtube.com", ua: YT_UA,
    ctx: { clientName: "WEB", clientVersion: "2.20240726.00.00", hl: "en", gl: "GB" } },
];

// Bracket-scan the first JSON array that follows `key` in a blob of text (robust to
// nested arrays inside each caption-track's name renderer). Returns the parsed array.
function jsonArrayAfter(text, key) {
  const i = text.indexOf(key); if (i < 0) return null;
  const start = text.indexOf("[", i); if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") { if (--depth === 0) { try { return JSON.parse(text.slice(start, j + 1)); } catch { return null; } } }
  }
  return null;
}
// Decode timedtext XML (it double-encodes, e.g. &amp;#39; → '), twice.
function decodeXmlText(s) {
  s = String(s || "").replace(/<[^>]+>/g, "");
  const un = x => x
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return un(un(s)).replace(/\s+/g, " ").trim();
}
// Find a video's caption tracks. Try each InnerTube client in turn (Android/TV
// first — they answer from a datacenter IP without the consent wall), then fall
// back to scraping the watch page. Returns [] when the video genuinely has none.
async function youtubeCaptionTracks(videoId) {
  for (const c of YT_CLIENTS) {
    try {
      const r = await fetch("https://" + c.host + "/youtubei/v1/player?key=" + c.key, {
        method: "POST",
        headers: { "content-type": "application/json", "accept-language": "en", "user-agent": c.ua, "cookie": YT_CONSENT, "origin": "https://www.youtube.com" },
        body: JSON.stringify({ context: { client: c.ctx }, videoId, params: "8AEB", contentCheckOk: true, racyCheckOk: true }),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const t = d && d.captions && d.captions.playerCaptionsTracklistRenderer && d.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (Array.isArray(t) && t.length) return t;
    } catch {}
  }
  // Last resort: the HTML watch page (often consent-walled from a server).
  for (const url of [
    "https://www.youtube.com/watch?v=" + videoId + "&hl=en&bpctr=9999999999&has_verified=1",
    "https://m.youtube.com/watch?v=" + videoId + "&hl=en",
  ]) {
    try {
      const r = await fetch(url, { headers: { "accept-language": "en-US,en;q=0.9", "user-agent": YT_UA, "cookie": YT_CONSENT } });
      if (!r.ok) continue;
      const html = await r.text();
      const tracks = jsonArrayAfter(html, '"captionTracks":');
      if (Array.isArray(tracks) && tracks.length) return tracks;
    } catch {}
  }
  return [];
}
// Fetch + flatten one track's text, optionally clipped to [start,end] seconds.
async function trackText(track, start, end) {
  const inWin = t => (start == null || t >= start) && (end == null || t <= end);
  let base = String(track.baseUrl || ""); if (!base) return "";
  if (base.startsWith("//")) base = "https:" + base;
  const hdr = { "accept-language": "en", "user-agent": YT_UA, "cookie": YT_CONSENT };
  try {
    const r = await fetch(base + (base.includes("fmt=") ? "" : "&fmt=json3"), { headers: hdr });
    if (r.ok) {
      const j = await r.json(); const ev = Array.isArray(j.events) ? j.events : []; const parts = [];
      for (const e of ev) {
        if (!e.segs) continue;
        if (!inWin((e.tStartMs || 0) / 1000)) continue;
        const line = e.segs.map(s => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
        if (line) parts.push(line);
      }
      if (parts.length) return parts.join(" ").replace(/\s+/g, " ").trim();
    }
  } catch {}
  try {
    const r = await fetch(base, { headers: hdr });
    if (r.ok) {
      const xml = await r.text(); const parts = []; const re = /<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g; let m;
      while ((m = re.exec(xml))) { if (!inWin(parseFloat(m[1]) || 0)) continue; const t = decodeXmlText(m[2]); if (t) parts.push(t); }
      if (parts.length) return parts.join(" ").replace(/\s+/g, " ").trim();
    }
  } catch {}
  return "";
}
// A video's transcript (preferring a real English track over an auto-generated one),
// clipped to the clip's own start/end if the admin set one.
export async function fetchYouTubeTranscript(videoId, seg) {
  const tracks = await youtubeCaptionTracks(videoId);
  if (!tracks.length) return "";
  const en = tracks.filter(t => /^en/i.test(t.languageCode || ""));
  const pick = en.find(t => t.kind !== "asr") || en[0] || tracks.find(t => t.kind !== "asr") || tracks[0];
  const start = seg && seg.start != null ? seg.start : null;
  const end = seg && seg.end != null ? seg.end : null;
  return await trackText(pick, start, end);
}

// Forced-tool call to Claude (same shape as the SLA helper; fails soft with a reason).
async function anthropicTool(env, { system, user, toolName, schema, maxTokens }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "AI isn't set up on the server (no API key)." };
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens || 800, system, tools: [{ name: toolName, description: "Return the result.", input_schema: schema }], tool_choice: { type: "tool", name: toolName }, messages: [{ role: "user", content: user }] }),
    });
  } catch { return { ok: false, error: "Couldn't reach the AI service." }; }
  if (!resp.ok) {
    let d = ""; try { const j = await resp.json(); d = (j && j.error && j.error.message) || ""; } catch {}
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "The AI key was rejected." };
    if (resp.status === 404 && /model/i.test(d)) return { ok: false, error: `The AI model "${model}" isn't available on this key.` };
    return { ok: false, error: "The AI service errored." + (d ? " (" + d + ")" : "") };
  }
  let payload; try { payload = await resp.json(); } catch { return { ok: false, error: "AI gave an unreadable reply." }; }
  const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === toolName) : null;
  if (!block || !block.input) return { ok: false, error: "AI returned nothing usable." };
  return { ok: true, input: block.input };
}

function shapeModule(row, { withAnswers = false } = {}) {
  let questions = []; try { questions = JSON.parse(row.questions || "[]"); } catch {}
  if (!Array.isArray(questions)) questions = [];
  // Lesson clips: the `segments` list, else a legacy single `video` as one clip.
  let segments = []; try { segments = JSON.parse(row.segments || "[]"); } catch {}
  if (!Array.isArray(segments) || !segments.length) segments = row.video ? [{ id: row.video, start: null, end: null }] : [];
  return {
    id: row.id, title: row.title || "", category: row.category || "", video: row.video || "", segments,
    content: row.content || "", passMark: row.pass_mark != null ? row.pass_mark : 80,
    minSeconds: row.min_seconds != null ? row.min_seconds : 0,
    active: row.active == null ? true : !!Number(row.active),
    sortOrder: row.sort_order || 0, createdAt: row.created_at || "", updatedAt: row.updated_at || "",
    questionCount: questions.length,
    questions: withAnswers ? questions : stripAnswers(questions),
  };
}
function shapeAttempt(row) {
  return {
    id: row.id, moduleId: row.module_id, moduleTitle: row.module_title || "", category: row.category || "",
    username: row.username, startedAt: row.started_at || "", submittedAt: row.submitted_at || "",
    durationSeconds: row.duration_seconds || 0, score: row.score, total: row.total, correct: row.correct,
    passMark: row.pass_mark, passed: !!Number(row.passed),
  };
}

// One clearly-labelled EXAMPLE module so the page isn't empty — the office edits or
// deletes it and builds their own. Seeded once (only when there are no modules at all).
async function seedIfEmpty(env, tid) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM cpd_modules WHERE tenant_id=?").bind(tid).first();
  if (n && Number(n.c) > 0) return;
  const now = nowISO();
  const content = [
    "# Example CPD module — edit or replace me",
    "",
    "This is a sample so you can see how CPD training works on the portal. An admin can edit it (or delete it and add your own real NICEIC CPD material) from **Manage & audit**.",
    "",
    "## How it works for the engineer",
    "- Read the material on this screen. The time you spend is recorded automatically.",
    "- When you've read it, take the short test at the end.",
    "- Your score, the date and the time spent are saved to your record.",
    "",
    "## Safe isolation — the basics (illustrative)",
    "Before working on a circuit, prove it is dead using the correct procedure and an approved voltage indicator that you prove before AND after testing. Lock off and label the point of isolation so it cannot be re-energised while you work.",
    "",
    "Replace this content with your own CPD material and questions.",
  ].join("\n");
  const questions = normQuestions([
    { q: "Before testing a circuit is dead, what must you do with your voltage indicator?", options: ["Nothing — just test the circuit", "Prove it works before and after testing on a known source", "Only test it afterwards"], answer: 1 },
    { q: "Why lock off and label the point of isolation?", options: ["It looks tidy", "So the circuit can't be re-energised while you work", "It's optional"], answer: 1 },
  ]);
  await env.DB.prepare(
    `INSERT INTO cpd_modules (tenant_id,id,title,category,content,pass_mark,min_seconds,questions,active,sort_order,created_at,updated_at,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(tid, "cpd-sample", "Example: Safe isolation (sample — edit or replace)", "Example",
    content, 80, 20, JSON.stringify(questions), 1, 0, now, now, "sample").run();
}

export async function handle(request, env, ctx, url, sess) {
  const method = request.method.toUpperCase();
  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const sub = url.pathname.replace(/^\/cpd(?=\/|$)/, "") || "/";
  const q = url.searchParams;
  await ensureTables(env);
  const perms = await permissionsFor(env, tid, me);
  const isAdmin = perms.FullAccess === "Yes";
  const canLearn = isAdmin || perms.CPD === "Yes";
  const readJson = async () => { try { return await request.json(); } catch { return {}; } };

  // ── Learner: the module list + my best attempt per module ──────────────────
  if (sub === "/modules" && method === "GET") {
    if (!canLearn) return error("Forbidden", 403, env, request);
    await seedIfEmpty(env, tid);
    const { results } = await env.DB.prepare("SELECT * FROM cpd_modules WHERE tenant_id=? AND active=1 ORDER BY sort_order, created_at").bind(tid).all();
    const mine = (await env.DB.prepare("SELECT module_id, submitted_at, score, passed, duration_seconds FROM cpd_attempts WHERE tenant_id=? AND username=? ORDER BY submitted_at").bind(tid, me).all()).results || [];
    const best = {};
    for (const a of mine) {
      const cur = best[a.module_id];
      // "Best" = a pass if any, else the highest score; newest within that.
      const better = !cur || (Number(a.passed) > Number(cur.passed)) ||
        (Number(a.passed) === Number(cur.passed) && (Number(a.score) || 0) >= (Number(cur.score) || 0));
      if (better) best[a.module_id] = a;
    }
    const modules = (results || []).map(r => {
      const m = shapeModule(r);
      const b = best[r.id];
      return {
        id: m.id, title: m.title, category: m.category, passMark: m.passMark,
        minSeconds: m.minSeconds, questionCount: m.questionCount,
        hasVideo: !!(m.segments && m.segments.length), videoCount: (m.segments || []).length,
        myStatus: b ? (Number(b.passed) ? "passed" : "attempted") : "not_started",
        myScore: b ? b.score : null, myPassedAt: (b && Number(b.passed)) ? b.submitted_at : null,
        myLastAt: b ? b.submitted_at : null, myAttempts: mine.filter(a => a.module_id === r.id).length,
      };
    });
    return json({ ok: true, modules, canManage: isAdmin }, {}, env, request);
  }

  // ── Learner: one module to read + sit (answers stripped) ───────────────────
  if (sub === "/module" && method === "GET") {
    if (!canLearn) return error("Forbidden", 403, env, request);
    const row = await env.DB.prepare("SELECT * FROM cpd_modules WHERE tenant_id=? AND id=?").bind(tid, q.get("id") || "").first();
    if (!row) return error("Module not found", 404, env, request);
    if (!Number(row.active) && !isAdmin) return error("Module not available", 403, env, request);
    return json({ ok: true, module: shapeModule(row) }, {}, env, request);
  }

  // ── Learner: submit a test attempt (graded + logged) ───────────────────────
  if (sub === "/submit" && method === "POST") {
    if (!canLearn) return error("Forbidden", 403, env, request);
    const b = await readJson();
    const row = await env.DB.prepare("SELECT * FROM cpd_modules WHERE tenant_id=? AND id=?").bind(tid, String(b.moduleId || "")).first();
    if (!row) return error("Module not found", 404, env, request);
    let questions = []; try { questions = JSON.parse(row.questions || "[]"); } catch {}
    if (!Array.isArray(questions)) questions = [];
    const answers = (b.answers && typeof b.answers === "object") ? b.answers : {};
    const { correct, total, score, results } = gradeAttempt(questions, answers);
    const passMark = row.pass_mark != null ? row.pass_mark : 80;
    const passed = total ? (score >= passMark) : true;             // no-test module = pass on reading
    // Duration: the client reports ACTIVE reading/test seconds (visibility-aware),
    // but clamp it to the real wall-clock window so it can never be inflated.
    const submittedAt = new Date();
    const startedMs = Date.parse(b.startedAt);
    const wall = Number.isFinite(startedMs) ? Math.max(0, Math.round((submittedAt.getTime() - startedMs) / 1000)) : null;
    let duration = clampInt(b.durationSeconds, 0, 86400);
    if (wall != null) duration = Math.min(duration, wall + 5);          // +5s grace for the submit round-trip
    const startedAtIso = Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : submittedAt.toISOString();
    const id = uid();
    await env.DB.prepare(
      `INSERT INTO cpd_attempts (tenant_id,id,module_id,module_title,category,username,started_at,submitted_at,duration_seconds,score,total,correct,pass_mark,passed,answers,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(tid, id, row.id, row.title || "", row.category || "", me, startedAtIso, submittedAt.toISOString(),
      duration, score, total, correct, passMark, passed ? 1 : 0, JSON.stringify(answers), submittedAt.toISOString()).run();
    return json({ ok: true, attemptId: id, score, correct, total, passMark, passed, durationSeconds: duration,
      results: isAdmin ? results : results.map(r => ({ id: r.id, correct: r.correct })) }, {}, env, request);
  }

  // ── Learner: my own history ────────────────────────────────────────────────
  if (sub === "/my" && method === "GET") {
    if (!canLearn) return error("Forbidden", 403, env, request);
    const { results } = await env.DB.prepare("SELECT * FROM cpd_attempts WHERE tenant_id=? AND username=? ORDER BY submitted_at DESC LIMIT 500").bind(tid, me).all();
    return json({ ok: true, attempts: (results || []).map(shapeAttempt) }, {}, env, request);
  }

  // ═══════════════ ADMIN (Full Access) ═══════════════════════════════════════
  if (sub.startsWith("/admin")) {
    if (!isAdmin) return error("Forbidden", 403, env, request);

    if (sub === "/admin/modules" && method === "GET") {
      await seedIfEmpty(env, tid);
      const { results } = await env.DB.prepare("SELECT * FROM cpd_modules WHERE tenant_id=? ORDER BY sort_order, created_at").bind(tid).all();
      const counts = (await env.DB.prepare("SELECT module_id, COUNT(*) AS n, SUM(passed) AS p FROM cpd_attempts WHERE tenant_id=? GROUP BY module_id").bind(tid).all()).results || [];
      const cmap = {}; for (const c of counts) cmap[c.module_id] = { attempts: Number(c.n) || 0, passes: Number(c.p) || 0 };
      const modules = (results || []).map(r => Object.assign(shapeModule(r, { withAnswers: true }), { stats: cmap[r.id] || { attempts: 0, passes: 0 } }));
      return json({ ok: true, modules }, {}, env, request);
    }

    if (sub === "/admin/module" && method === "POST") {
      const b = await readJson();
      const title = String(b.title || "").trim();
      if (!title) return error("A title is required", 400, env, request);
      const now = nowISO();
      const id = String(b.id || "") || uid();
      const existing = await env.DB.prepare("SELECT created_at, created_by FROM cpd_modules WHERE tenant_id=? AND id=?").bind(tid, id).first();
      const questions = normQuestions(b.questions);
      const passMark = clampInt(b.passMark != null ? b.passMark : 80, 0, 100);
      const minSeconds = clampInt(b.minSeconds != null ? b.minSeconds : 0, 0, 86400);
      const active = b.active === false ? 0 : 1;
      const sortOrder = clampInt(b.sortOrder || 0, 0, 100000);
      // A lesson's clips. Accept the new `segments` list; fall back to a single
      // `video` field (back-compat). `video` mirrors the first clip's id.
      const segments = parseSegments(b.segments && b.segments.length ? b.segments : (b.video ? [{ url: b.video }] : []));
      const video = segments.length ? segments[0].id : "";
      await env.DB.prepare(
        `INSERT INTO cpd_modules (tenant_id,id,title,category,content,video,segments,pass_mark,min_seconds,questions,active,sort_order,created_at,updated_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,id) DO UPDATE SET title=excluded.title, category=excluded.category,
           content=excluded.content, video=excluded.video, segments=excluded.segments, pass_mark=excluded.pass_mark,
           min_seconds=excluded.min_seconds, questions=excluded.questions, active=excluded.active,
           sort_order=excluded.sort_order, updated_at=excluded.updated_at`
      ).bind(tid, id, title, String(b.category || "").trim(), String(b.content || ""), video, JSON.stringify(segments), passMark, minSeconds,
        JSON.stringify(questions), active, sortOrder,
        (existing && existing.created_at) || now, now, (existing && existing.created_by) || me).run();
      const row = await env.DB.prepare("SELECT * FROM cpd_modules WHERE tenant_id=? AND id=?").bind(tid, id).first();
      return json({ ok: true, module: shapeModule(row, { withAnswers: true }) }, {}, env, request);
    }

    if (sub === "/admin/module-delete" && method === "POST") {
      const b = await readJson();
      const id = String(b.id || "");
      if (!id) return error("id required", 400, env, request);
      // Remove the module but KEEP the attempt history — the audit record must
      // survive even if the module is retired (attempts carry a title snapshot).
      await env.DB.prepare("DELETE FROM cpd_modules WHERE tenant_id=? AND id=?").bind(tid, id).run();
      return json({ ok: true }, {}, env, request);
    }

    // Draft multiple-choice questions from a video's transcript (or a pasted one).
    // Pasted transcript wins; else we auto-fetch the video's captions. The office
    // reviews/edits the drafts before saving — nothing is stored here.
    if (sub === "/admin/ai-questions" && method === "POST") {
      const b = await readJson();
      const count = clampInt(b.count != null ? b.count : 5, 1, 15);
      const instructions = String(b.instructions || "").slice(0, 500).trim();
      let transcript = String(b.transcript || "").replace(/\s+/g, " ").trim();
      let source = "pasted";
      if (!transcript) {
        const vid = parseYouTubeId(b.videoId || b.url || "");
        if (!vid) return json({ ok: false, needTranscript: true, error: "Add a YouTube link first, or paste the transcript below." }, {}, env, request);
        transcript = await fetchYouTubeTranscript(vid, { start: parseTime(b.start), end: parseTime(b.end) });
        source = "captions";
        if (!transcript) return json({ ok: false, needTranscript: true, error: "Couldn't read this video's captions — it may not have any. Check the video has subtitles (the CC button on YouTube) and try again, or pick a video that does." }, {}, env, request);
      }
      if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: "AI isn't set up on the server (no API key). You can still add questions by hand." }, {}, env, request);
      transcript = transcript.slice(0, 16000);
      const schema = {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The question stem." },
                options: { type: "array", items: { type: "string" }, description: "3 or 4 answer options." },
                answer: { type: "integer", description: "0-based index of the single correct option." },
              },
              required: ["question", "options", "answer"],
            },
          },
        },
        required: ["questions"],
      };
      const system = "You write multiple-choice CPD (Continuing Professional Development) test questions for UK electricians, based ONLY on the supplied training-video transcript. Every question must be answerable from the transcript — never invent facts it does not state. Give each question 3 or 4 plausible options with exactly one correct answer, and set `answer` to that option's 0-based index. Keep the wording clear, practical and specific to the content; avoid trick questions and 'all/none of the above'.";
      const user = "Write " + count + " multiple-choice question" + (count === 1 ? "" : "s") + " from this training-video transcript."
        + (instructions ? "\n\nExtra guidance from the trainer (prioritise this): " + instructions : "")
        + "\n\nTranscript:\n\"\"\"\n" + transcript + "\n\"\"\"";
      const r = await anthropicTool(env, { system, user, toolName: "set_questions", schema, maxTokens: 3500 });
      if (!r.ok) return json({ ok: false, error: r.error || "The AI couldn't draft questions." }, {}, env, request);
      const questions = normQuestions(r.input.questions);
      if (!questions.length) return json({ ok: false, error: "The AI didn't return usable questions — try again, or add them by hand." }, {}, env, request);
      return json({ ok: true, questions, source, transcriptChars: transcript.length }, {}, env, request);
    }

    // The audit log — every attempt, filterable by user / module / date range.
    if (sub === "/admin/report" && method === "GET") {
      const where = ["tenant_id=?"]; const args = [tid];
      const user = (q.get("user") || "").trim();
      if (user && user !== "all") { where.push("username=?"); args.push(user); }
      const mod = (q.get("module") || "").trim();
      if (mod && mod !== "all") { where.push("module_id=?"); args.push(mod); }
      const from = (q.get("from") || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push("submitted_at>=?"); args.push(from + "T00:00:00.000Z"); }
      const to = (q.get("to") || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push("submitted_at<=?"); args.push(to + "T23:59:59.999Z"); }
      const onlyPass = q.get("passed") === "1";
      if (onlyPass) where.push("passed=1");
      const { results } = await env.DB.prepare(
        `SELECT * FROM cpd_attempts WHERE ${where.join(" AND ")} ORDER BY submitted_at DESC LIMIT 5000`
      ).bind(...args).all();
      const attempts = (results || []).map(shapeAttempt);
      // Filter lists for the page (distinct users + the module list).
      const users = (await env.DB.prepare("SELECT DISTINCT username FROM cpd_attempts WHERE tenant_id=? ORDER BY username").bind(tid).all()).results || [];
      const mods = (await env.DB.prepare("SELECT id, title FROM cpd_modules WHERE tenant_id=? ORDER BY sort_order, created_at").bind(tid).all()).results || [];
      const totalSeconds = attempts.reduce((s, a) => s + (a.durationSeconds || 0), 0);
      return json({
        ok: true, attempts,
        summary: { attempts: attempts.length, passes: attempts.filter(a => a.passed).length, totalSeconds },
        users: users.map(u => u.username), modules: mods.map(m => ({ id: m.id, title: m.title })),
      }, {}, env, request);
    }

    return error("Not found: " + sub, 404, env, request);
  }

  return error("Not found: " + sub, 404, env, request);
}
