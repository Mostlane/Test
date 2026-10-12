// One-time move from the 9 old work areas to the work-type taxonomy. Mock D1.
// Run: node --no-warnings worker/tools/test-workarea-migrate.mjs
import * as sla from "../src/routes/sla.js";
const cfg = {
  sla_eng_skills: JSON.stringify({ "david.molloy": { plumbing: 5, electrical: 2, "joinery-carpentry": 4, "general-maintenance": 5 }, "john.thorn": { electrical: 5, "fire-alarms": 5 } }),
  "sla:subcontractors:1": JSON.stringify({ metrorod: { name: "Metro Rod", active: true, to: "x@y", trade: "Drainage", areas: ["plumbing"] }, other: { name: "Builder Co", active: true, to: "b@c", trade: "", areas: ["fabric-building"] } }),
  "sla:jobtrade:1": "{}",
};
const jobs = {
  a: { id: "a", workArea: "plumbing", description: "colleague toilet blocked again" },
  b: { id: "b", workArea: "plumbing", description: "Kitchen tap repair" },
  c: { id: "c", workArea: "electrical", description: "Flick Test" },
  d: { id: "d", workArea: "electrical", description: "Be on site for meter installs from 12:30" },
  e: { id: "e", workArea: "plumbing", description: "3 hour drain down" },   // EM, mis-tagged plumbing
  f: { id: "f", workArea: "fabric-building", description: "Resident here has reported a section downpipe has popped off the guttering" },
};
const db = { prepare(sql) { let b = []; const st = {
  bind(...a) { b = a; return st; },
  async first() {
    if (/FROM app_config/.test(sql)) { const k = b[1] && /key=\?|key = \?/.test(sql) ? b[1] : (/key = 'sla_eng_skills'/.test(sql) ? "sla_eng_skills" : /key = 'sla_work_areas'/.test(sql) ? "sla_work_areas" : null); return k && cfg[k] != null ? { value: cfg[k], 1: 1 } : null; }
    return null;
  },
  async all() {
    if (/FROM sla_jobs/.test(sql)) return { results: Object.values(jobs).map(j => ({ data: JSON.stringify(j) })) };
    if (/FROM user_permissions/.test(sql)) return { results: [{ permission: "SLAAdmin", value: 1 }] };
    return { results: [] };
  },
  async run() {
    if (/INSERT INTO app_config/.test(sql)) { const lit = /VALUES \(\?, '([^']+)'/.exec(sql); if (lit) cfg[lit[1]] = b[1]; else cfg[b[1]] = b[2]; }
    if (/DELETE FROM app_config/.test(sql)) for (const k of b.slice(1)) delete cfg[k];
    if (/INSERT INTO sla_jobs/.test(sql)) { const j = JSON.parse(b[b.length - 1]); jobs[j.id] = j; }
    return { meta: { changes: 1 } };
  } }; return st; }, batch(s) { return Promise.all(s.map(x => x.run())); } };
const env = { DB: db };
let fail = 0; const ok = (n, c, x = "") => { console.log((c ? "PASS" : "FAIL") + "  " + n + (x ? "  → " + x : "")); if (!c) fail++; };
const call = async path => { const url = new URL("https://t/sla" + path); const r = await sla.handle(new Request(url), env, { waitUntil() {} }, url, { user: { username: "Office" }, tenantId: 1 }); return r.json(); };

const r = await call("/eng-skills");
const sk = JSON.parse(cfg.sla_eng_skills);
ok("areas list = the taxonomy, grouped + described", r.areas.length > 40 && r.areas.every(a => a.group) && r.areas.find(a => a.id === "drainage").description.length > 100);
ok("David's plumbing 5 → plumbing/hot-water/drainage 5", sk["david.molloy"].plumbing === 5 && sk["david.molloy"]["hot-water"] === 5 && sk["david.molloy"].drainage === 5, JSON.stringify(sk["david.molloy"]));
ok("overlap takes the higher (washroom-fittings: joinery 4 vs general 5 → 5)", sk["david.molloy"]["washroom-fittings"] === 5);
ok("John's electrical 5 → lighting/emergency-lighting 5, old id gone", sk["john.thorn"].lighting === 5 && sk["john.thorn"]["emergency-lighting"] === 5 && !sk["john.thorn"].electrical && sk["john.thorn"]["fire-doors"] === 5);
ok("blocked-toilet job: plumbing → drainage", jobs.a.workArea === "drainage");
ok("tap job stays plumbing", jobs.b.workArea === "plumbing");
ok("Flick test: electrical → emergency-lighting", jobs.c.workArea === "emergency-lighting");
ok("unrecognised electrical job → main type (power)", jobs.d.workArea === "electrical-power");
ok("EM drain-down wrongly tagged plumbing → emergency-lighting (confident read wins)", jobs.e.workArea === "emergency-lighting");
ok("downpipe: fabric-building → rainwater", jobs.f.workArea === "rainwater");
const subs = JSON.parse(cfg["sla:subcontractors:1"]);
ok("Metro Rod (trade Drainage) covers drainage only", JSON.stringify(subs.metrorod.areas) === '["drainage"]', JSON.stringify(subs.metrorod.areas));
ok("other sub gets the whole old family", subs.other.areas.includes("walls-plaster") && subs.other.areas.includes("rainwater"));
ok("old trade cache cleared", cfg["sla:jobtrade:1"] === undefined);
const before = JSON.stringify(cfg.sla_eng_skills);
await call("/eng-skills");
ok("runs once (flag set; second load changes nothing)", JSON.stringify(cfg.sla_eng_skills) === before && !!cfg["sla:workareas:v2:1"]);
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS"); process.exit(fail ? 1 : 0);
