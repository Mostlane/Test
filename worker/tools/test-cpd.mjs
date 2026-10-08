// Focused unit test for the audit-critical CPD logic: question normalisation,
// answer-stripping (answers never reach the browser) and grading.
//   node --no-warnings worker/tools/test-cpd.mjs
import { normQuestions, stripAnswers, gradeAttempt } from "../src/routes/cpd.js";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log("  ✗ " + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + " (got " + JSON.stringify(a) + ")"); }

// ── normQuestions ─────────────────────────────────────────────────────────────
const nq = normQuestions([
  { q: "Good?", options: ["a", "b", "c"], answer: 2 },
  { q: "No options", options: ["only"] },        // dropped: <2 options
  { question: "", options: ["x", "y"] },          // dropped: no text
  { q: "Clamp answer", options: ["a", "b"], answer: 9 },  // answer clamped to 0
  { q: "  trims  ", options: [" a ", "", "b"], answer: 1 }, // blank option removed; answer re-index safe
]);
eq(nq.length, 3, "normQuestions keeps only the 3 valid questions");
eq(nq[0].answer, 2, "keeps a valid answer index");
eq(nq[1].answer, 0, "clamps an out-of-range answer to 0");
ok(nq[0].id && nq[1].id && nq[2].id, "assigns an id to every question");
eq(nq[2].options, ["a", "b"], "drops blank options + trims");

// ── stripAnswers (the correct answer must NEVER go to the learner) ────────────
const stripped = stripAnswers(nq);
ok(stripped.every(q => !("answer" in q)), "stripAnswers removes the answer from every question");
ok(stripped[0].options.length === 3, "stripAnswers keeps the options");

// ── gradeAttempt ──────────────────────────────────────────────────────────────
const qs = [
  { id: "q1", q: "a", options: ["x", "y"], answer: 1 },
  { id: "q2", q: "b", options: ["x", "y", "z"], answer: 0 },
  { id: "q3", q: "c", options: ["x", "y"], answer: 0 },
];
eq(gradeAttempt(qs, { q1: 1, q2: 0, q3: 0 }).score, 100, "all correct = 100%");
eq(gradeAttempt(qs, { q1: 1, q2: 0, q3: 1 }).score, 67, "2 of 3 = 67%");
eq(gradeAttempt(qs, {}).score, 0, "no answers = 0%");
eq(gradeAttempt(qs, { q1: 1 }).correct, 1, "partial answers graded, missing = wrong");
const g = gradeAttempt(qs, { q1: 0, q2: 0, q3: 0 });
eq([g.correct, g.total], [2, 3], "scores correct/total");
ok(g.results.find(r => r.id === "q1").correct === false, "a wrong answer is flagged in results");
// Reading-only module (no questions) passes on reading.
const rg = gradeAttempt([], {});
eq([rg.total, rg.score], [0, 100], "reading-only module (no questions) scores 100 / total 0");
// A string answer index still grades (the client sends numbers, be defensive).
eq(gradeAttempt([{ id: "q1", q: "a", options: ["x", "y"], answer: 1 }], { q1: "1" }).score, 100, "string answer index grades correctly");

console.log((fail ? "✗" : "✓") + " CPD: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
