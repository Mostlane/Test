// Focused unit test for the audit-critical CPD logic: question normalisation,
// answer-stripping (answers never reach the browser) and grading.
//   node --no-warnings worker/tools/test-cpd.mjs
import { normQuestions, stripAnswers, gradeAttempt, parseYouTubeId, parseTime, parseSegments } from "../src/routes/cpd.js";

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

// ── parseYouTubeId ────────────────────────────────────────────────────────────
eq(parseYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ", "parses a watch URL");
eq(parseYouTubeId("https://youtu.be/dQw4w9WgXcQ?t=42"), "dQw4w9WgXcQ", "parses a youtu.be share URL");
eq(parseYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0"), "dQw4w9WgXcQ", "parses an embed URL");
eq(parseYouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ", "parses a shorts URL");
eq(parseYouTubeId("dQw4w9WgXcQ"), "dQw4w9WgXcQ", "accepts a bare 11-char id");
eq(parseYouTubeId("not a video"), "", "returns empty for a non-YouTube string");
eq(parseYouTubeId("https://vimeo.com/12345"), "", "returns empty for a non-YouTube URL");

// ── parseTime ─────────────────────────────────────────────────────────────────
eq(parseTime(90), 90, "number seconds");
eq(parseTime("90"), 90, "string seconds");
eq(parseTime("1:30"), 90, "m:ss → seconds");
eq(parseTime("1:02:05"), 3725, "h:mm:ss → seconds");
eq(parseTime(""), null, "empty → null");
eq(parseTime("abc"), null, "garbage → null");

// ── parseSegments (a lesson's clips) ──────────────────────────────────────────
const segs = parseSegments([
  { url: "https://youtu.be/dQw4w9WgXcQ", start: "0:30", end: "1:30" },
  { url: "dQw4w9WgXcQ" },                                   // whole video
  { url: "https://www.youtube.com/watch?v=abcdefghijk", start: 10, end: 5 }, // bad range → end dropped
  { url: "not a video" },                                   // dropped
]);
eq(segs.length, 3, "keeps the 3 valid clips, drops the bad url");
eq([segs[0].start, segs[0].end], [30, 90], "parses start/end clock times");
eq([segs[1].start, segs[1].end], [null, null], "whole-video clip has null start/end");
eq(segs[2].end, null, "an end <= start is dropped (plays to natural end)");
eq(parseSegments([]).length, 0, "no clips → empty");

console.log((fail ? "✗" : "✓") + " CPD: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
