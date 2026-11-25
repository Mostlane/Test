// node --no-warnings worker/tools/test-compliance-pack.mjs
import { buildPackPlan, splitEvFile, storeFolderName, pickLatest, safeName } from "../src/lib/compliancepack.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const F = (o) => ({ id: Math.random(), pinned: 0, size: 1, uploaded_at: "2026-01-01T00:00:00Z", r2_key: "compliance/x", ...o });

ok(storeFolderName("0109", "Romsey, Winchester Hill PFS") === "0109 - Romsey, Winchester Hill PFS", "folder name");
ok(storeFolderName("0125", "0125 Lee-On Solent") === "0125 - Lee-On Solent", "strip leading code");
ok(storeFolderName("0042", "") === "0042", "no name");
ok(safeName('a/b:c*?"<>|. ') === "a b c", "safe name");
ok(splitEvFile({ filename: "PET_coop_romsey_26.pdf" }, true) === "forecourt", "PET → forecourt");
ok(splitEvFile({ filename: "Oaks_EV_26.pdf" }, false) === "ev", "EV underscore");
ok(splitEvFile({ filename: "EV-Charger-Maintenance.pdf" }, true) === "ev", "EV charger at PFS store");
ok(splitEvFile({ filename: "coop_romsey_25_1_.pdf" }, true) === "forecourt", "unlabelled at PFS → forecourt");
ok(splitEvFile({ filename: "6528461047117546849.pdf" }, false) === "ev", "unlabelled non-PFS → ev");
ok(splitEvFile({ filename: "Petersfield.pdf" }, false) === "ev", "Petersfield isn't 'pet'");

const latest = pickLatest([F({ id: 1, doc_date: "2021-05-01" }), F({ id: 2, doc_date: "2026-05-01" }), F({ id: 3, doc_date: null, uploaded_at: "2024-01-01" })]);
ok(latest.length === 1 && latest[0].id === 2, "newest by cert date");
ok(pickLatest([F({ id: 1, pinned: 1, doc_date: "2020-01-01" }), F({ id: 2, pinned: 1 }), F({ id: 3, doc_date: "2026-01-01" })]).map(f => f.id).join() === "1,2", "pinned wins");

const stores = [
  { code: "0109", name: "Romsey, Winchester Hill PFS", category: "Retail", due: { fiveYear: "2027-01-01", pat: "2020-01-01", em: "2027-01-01", ev: "2027-11-01" } },
  { code: "0626", name: "Somewhere", category: "Cobra", due: { pv: "01/02/2027", ev: "2027-09-01" } },
  { code: "0999", name: "Nothing", category: "", due: {} },
];
const files = [
  F({ code: "0109", type: "fiveYear", doc_date: "2023-01-01" }),
  F({ code: "0109", type: "pat", doc_date: "2025-01-01" }),
  F({ code: "0109", type: "ev", filename: "coop_romsey_25_1_.pdf", doc_date: "2025-11-07" }),
  F({ code: "0109", type: "ev", filename: "PET_coop_romsey_26.pdf", doc_date: "2026-11-06" }),
  F({ code: "0626", type: "ev", filename: "EV-Charger-Maintenance.pdf", doc_date: null }),
];
const plan = buildPackPlan(stores, files, "2026-11-25");
const r = plan.find(s => s.code === "0109"), c = plan.find(s => s.code === "0626"), u = plan.find(s => s.code === "0999");
ok(r.group === "Retail" && r.pfs, "group + pfs");
ok(r.types.fiveYear.status === "Present", "5yr present");
ok(r.types.pat.status === "Overdue", "pat overdue");
ok(r.types.em.status === "Missing", "em missing");
ok(r.types.forecourt.status === "Present" && r.types.forecourt.files.length === 1 && r.types.forecourt.files[0].filename.startsWith("PET"), "forecourt latest only");
ok(r.types.forecourt.due === "2027-11-01", "pfs ev due → forecourt");
ok(r.types.ev.status === "Not required", "pfs ev not required");
ok(r.types.pump.status === "Not required", "pump n/a");
ok(c.types.ev.status === "Present" && c.flags.some(f => /no date/.test(f)), "ev present + undated flag");
ok(c.types.pv.status === "Missing" && c.types.pv.due === "2027-02-01", "pv required by due, legacy date");
ok(c.types.forecourt.status === "Not required", "non-pfs forecourt n/a");
ok(u.group === "Uncategorised" && u.flags.length, "uncategorised flagged");
ok(plan[0].group === "Cobra", "sorted by group");
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
