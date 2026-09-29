// EM/PAT day optimiser (sla.js optimiseEmDay). Each 3-hour EM site is worked
// twice (flick+PAT start, light-check return >= 3h after the flick); the drain-
// down is filled with work at other sites; the optimiser chooses PAT placement
// per site. Mock D1, no network (jobs carry coords, no Maps key → haversine).
// Run: node worker/tools/test-em-optimize.mjs
import * as sla from "../src/routes/sla.js";
globalThis.fetch = async () => { throw new Error("no network in test"); };

function env(home = { homeLat: 50.85, homeLng: -1.20 }) {
  return {
    GOOGLE_MAPS_KEY: "",
    DB: { prepare(sql) { let b = []; const st = {
      bind(...a) { b = a; return st; },
      async first() { if (/FROM users/.test(sql)) return home ? { profile: JSON.stringify(home) } : null; return null; },
      async all() { return { results: [] }; },
      async run() { return {}; },
    }; return st; } },
  };
}
let fail = 0;
const ok = (n, c, d) => { console.log((c ? "PASS" : "FAIL") + "  " + n + (c ? "" : "  → " + JSON.stringify(d))); if (!c) fail++; };
// A job at a coordinate. empat = combined EM+PAT (3h drain-down + PAT).
const JOB = (id, lat, lng, kind, extra = {}) => {
  const base = { id, ref: id, site: "Site " + id, siteCode: id, lat, lng, priority: "", ...extra };
  if (kind === "empat") return { ...base, emTest: true, pat: true };
  if (kind === "em") return { ...base, emTest: true, pat: false };
  if (kind === "emmonthly") return { ...base, emTest: true, pat: false, emKind: "monthly" };
  if (kind === "pat") return { ...base, emTest: false, pat: true };
  return { ...base, durationMinutes: 60 };
};
const starts = s => s.stops.filter(x => x.phase === "start");
const returns = s => s.stops.filter(x => x.phase === "return");
const singles = s => s.stops.filter(x => x.phase === "single");
const findStart = (s, id) => s.stops.find(x => x.phase === "start" && x.jobId === id);
const findReturn = (s, id) => s.stops.find(x => x.phase === "return" && x.jobId === id);

// Spread of sites a few miles apart around the home.
const A = [50.90, -1.30], B = [50.88, -1.25], C = [50.95, -1.40], D2 = [50.83, -1.10];

{ // 1) Two EM+PAT sites — worked twice each; drain respected; day interleaved
  const res = await sla.optimiseEmDay(env(), 1, {
    engineer: "Dave", date: "2026-10-01", dayStart: "08:00", lunchMinutes: 0,
    jobs: [JOB("A", ...A, "empat"), JOB("B", ...B, "empat")],
  });
  ok("2 EM+PAT: ok", res.ok, res);
  ok("2 EM+PAT: 2 start stops", starts(res).length === 2);
  ok("2 EM+PAT: 2 return stops", returns(res).length === 2);
  ok("2 EM+PAT: summary emSites=2, patJobs=2", res.summary.emSites === 2 && res.summary.patJobs === 2, res.summary);
  // Each EM site's check starts no sooner than flick + 3h drain.
  let legal = true;
  for (const id of ["A", "B"]) { const st = findStart(res, id), rt = findReturn(res, id); if (!st || !rt || rt.checkStartOffset < st.checkDueOffset) legal = false; }
  ok("2 EM+PAT: every check ≥ flick + 3h drain (185 min)", legal, res.stops.map(s => [s.jobId, s.phase, s.arrivalOffset, s.checkStartOffset, s.checkDueOffset]));
  ok("2 EM+PAT: checkDue = flick(10)+drain(180) after arrival", findStart(res, "A").checkDueOffset - findStart(res, "A").arrivalOffset === 190);
  // Interleaved beats doing each site fully sequentially (2×(10+45+180+15)=500).
  ok("2 EM+PAT: interleaved day well under fully-sequential 500 min", res.summary.dayLengthMins < 460, res.summary.dayLengthMins);
  // Execution order: arrivals never go backwards.
  let mono = true; for (let i = 1; i < res.stops.length; i++) if (res.stops[i].arrivalOffset < res.stops[i - 1].arrivalOffset) mono = false;
  ok("2 EM+PAT: stop arrivals are monotonic", mono, res.stops.map(s => s.arrivalOffset));
}

{ // 2) Three EM+PAT sites — 3 starts + 3 returns, all legal
  const res = await sla.optimiseEmDay(env(), 1, {
    engineer: "Dave", date: "2026-10-01", dayStart: "08:00", lunchMinutes: 30,
    jobs: [JOB("A", ...A, "empat"), JOB("B", ...B, "empat"), JOB("C", ...C, "empat")],
  });
  ok("3 EM+PAT: ok, 3 start + 3 return", res.ok && starts(res).length === 3 && returns(res).length === 3, res.summary);
  let legal = true; for (const id of ["A", "B", "C"]) { const st = findStart(res, id), rt = findReturn(res, id); if (rt.checkStartOffset < st.checkDueOffset) legal = false; }
  ok("3 EM+PAT: all checks legal (≥ each flick + 3h)", legal);
  ok("3 EM+PAT: lunch inserted", !!res.lunch && res.lunch.minutes === 30, res.lunch);
  ok("3 EM+PAT: dayLength counts lunch", res.summary.lunchMins === 30);
}

{ // 3) Mixed day: EM+PAT, EM-only, PAT-only, plain — correct stop composition
  const res = await sla.optimiseEmDay(env(), 1, {
    engineer: "Dave", date: "2026-10-01", dayStart: "08:00", lunchMinutes: 0,
    jobs: [JOB("EMP", ...A, "empat"), JOB("EMO", ...B, "em"), JOB("PAT", ...C, "pat"), JOB("PLN", ...D2, "plain")],
  });
  ok("mixed: ok", res.ok, res);
  ok("mixed: 2 EM sites → 2 starts + 2 returns", starts(res).length === 2 && returns(res).length === 2, res.summary);
  ok("mixed: 2 single visits (PAT-only + plain)", singles(res).length === 2, res.stops.map(s => [s.jobId, s.phase]));
  ok("mixed: EM-only start has no PAT (10-min flick)", findStart(res, "EMO").durationMin === 10 && findStart(res, "EMO").patHere === false, findStart(res, "EMO"));
  ok("mixed: PAT-only single is 45 min", singles(res).find(s => s.jobId === "PAT").durationMin === 45);
  ok("mixed: summary patJobs counts EM+PAT and PAT-only = 2", res.summary.patJobs === 2, res.summary);
}

{ // 4) PAT placement is chosen per site — every EM+PAT stop pair carries the PAT
  const res = await sla.optimiseEmDay(env(), 1, {
    engineer: "Dave", date: "2026-10-01", dayStart: "08:00", lunchMinutes: 0,
    jobs: [JOB("A", ...A, "empat"), JOB("B", ...B, "empat"), JOB("C", ...C, "empat")],
  });
  let patPlacedOnce = true;
  for (const id of ["A", "B", "C"]) {
    const st = findStart(res, id), rt = findReturn(res, id);
    // exactly one of the two visits carries the PAT (45 min longer than its base)
    const stPat = st.patHere, rtPat = rt.patHere;
    if (stPat === rtPat) patPlacedOnce = false;                 // must differ (one true, one false)
    if (stPat && st.durationMin !== 55) patPlacedOnce = false;  // flick+PAT
    if (!stPat && st.durationMin !== 10) patPlacedOnce = false; // flick only
    if (rtPat && rt.durationMin !== 60) patPlacedOnce = false;  // check+PAT
    if (!rtPat && rt.durationMin !== 15) patPlacedOnce = false; // check only
  }
  ok("PAT placement: each EM+PAT site does its PAT exactly once (start XOR return)", patPlacedOnce, res.stops.filter(s => s.phase !== "single").map(s => [s.jobId, s.phase, s.patHere, s.durationMin]));
}

{ // 5) Custom timings honoured
  const res = await sla.optimiseEmDay(env(), 1, {
    engineer: "Dave", date: "2026-10-01", dayStart: "08:00", lunchMinutes: 0,
    flickMin: 5, patMin: 30, checkMin: 10, drainMin: 120,
    jobs: [JOB("A", ...A, "empat"), JOB("B", ...B, "empat")],
  });
  ok("custom timings: reflected in output", res.timing.flickMin === 5 && res.timing.patMin === 30 && res.timing.checkMin === 10 && res.timing.drainMin === 120, res.timing);
  ok("custom timings: checkDue = flick(5)+drain(120) = 125 after arrival", findStart(res, "A").checkDueOffset - findStart(res, "A").arrivalOffset === 125);
}

{ // 6) Error paths
  const noHome = await sla.optimiseEmDay(env(null), 1, { engineer: "Dave", date: "2026-10-01", jobs: [JOB("A", ...A, "empat")] });
  ok("no home → needsHome error", noHome.ok === false && noHome.needsHome === true, noHome);
  const noEm = await sla.optimiseEmDay(env(), 1, { engineer: "Dave", date: "2026-10-01", jobs: [JOB("P", ...A, "pat"), JOB("Q", ...B, "pat")] });
  ok("no EM (only PAT) → error pointing at the normal optimiser", noEm.ok === false && /normal route optimiser/.test(noEm.error || ""), noEm);
  const noJobs = await sla.optimiseEmDay(env(), 1, { engineer: "Dave", date: "2026-10-01", jobs: [] });
  ok("no jobs → error", noJobs.ok === false);
  const noEng = await sla.optimiseEmDay(env(), 1, { jobs: [JOB("A", ...A, "empat")] });
  ok("no engineer → error", noEng.ok === false);
}

{ // 7) Single EM site — still valid, warns about the unfilled drain
  const res = await sla.optimiseEmDay(env(), 1, { engineer: "Dave", date: "2026-10-01", jobs: [JOB("A", ...A, "empat")] });
  ok("1 EM site: ok, 1 start + 1 return", res.ok && starts(res).length === 1 && returns(res).length === 1);
  ok("1 EM site: warns the drain can't be filled", (res.warnings || []).some(w => /drain-down/.test(w)), res.warnings);
  ok("1 EM site: check still ≥ flick + 3h", findReturn(res, "A").checkStartOffset >= findStart(res, "A").checkDueOffset);
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS"); process.exit(fail ? 1 : 0);
