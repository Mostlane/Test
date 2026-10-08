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
    tenant_id INTEGER, id TEXT, title TEXT, category TEXT, content TEXT,
    pass_mark INTEGER, min_seconds INTEGER, questions TEXT, active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, created_by TEXT,
    PRIMARY KEY (tenant_id, id))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cpd_attempts (
    tenant_id INTEGER, id TEXT, module_id TEXT, module_title TEXT, category TEXT,
    username TEXT, started_at TEXT, submitted_at TEXT, duration_seconds INTEGER,
    score INTEGER, total INTEGER, correct INTEGER, pass_mark INTEGER, passed INTEGER,
    answers TEXT, created_at TEXT, PRIMARY KEY (tenant_id, id))`).run();
  // Index for the per-user lookups + the audit report.
  try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS cpd_att_user ON cpd_attempts (tenant_id, username, submitted_at)`).run(); } catch {}
}
const ensureTables = onceMigration(ensureTables__raw);

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

function shapeModule(row, { withAnswers = false } = {}) {
  let questions = []; try { questions = JSON.parse(row.questions || "[]"); } catch {}
  if (!Array.isArray(questions)) questions = [];
  return {
    id: row.id, title: row.title || "", category: row.category || "",
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
      await env.DB.prepare(
        `INSERT INTO cpd_modules (tenant_id,id,title,category,content,pass_mark,min_seconds,questions,active,sort_order,created_at,updated_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,id) DO UPDATE SET title=excluded.title, category=excluded.category,
           content=excluded.content, pass_mark=excluded.pass_mark, min_seconds=excluded.min_seconds,
           questions=excluded.questions, active=excluded.active, sort_order=excluded.sort_order,
           updated_at=excluded.updated_at`
      ).bind(tid, id, title, String(b.category || "").trim(), String(b.content || ""), passMark, minSeconds,
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
