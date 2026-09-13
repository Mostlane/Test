// Unit tests for the employee required-documents logic (staffrecords.js).
//   node worker/tools/test-staff-required.mjs
import { requiredForUser, reqStatus } from "../src/routes/staffrecords.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const ids = a => a.map(x => x.id).sort().join(",");
const future = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
const soon   = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const past   = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

const cfg = {
  items: [
    { id: "r1", kind: "qualification", title: "CSCS", scope: "all" },
    { id: "r2", kind: "qualification", title: "First Aid", scope: "field" },
    { id: "r3", kind: "insurance", title: "Public Liability", scope: "office" },
    { id: "r4", kind: "licence", title: "Driving Licence", scope: "none" },
  ],
  byUser: {},
};

// ── scope matching ────────────────────────────────────────────────────────────
ok("field engineer gets all+field", ids(requiredForUser(cfg, "u1", "field")) === "r1,r2");
ok("office staff gets all+office", ids(requiredForUser(cfg, "u2", "office")) === "r1,r3");
ok("blank staffType treated as field", ids(requiredForUser(cfg, "u3", "")) === "r1,r2");
ok("scope none never auto-applies", !requiredForUser(cfg, "u1", "field").some(x => x.id === "r4"));

// ── per-user overrides ─────────────────────────────────────────────────────────
const cfg2 = { items: cfg.items, byUser: { u1: { off: ["r1"], on: ["r4"] } } };
ok("per-user off removes an auto item", !requiredForUser(cfg2, "u1", "field").some(x => x.id === "r1"));
ok("per-user on adds a none-scope item", requiredForUser(cfg2, "u1", "field").some(x => x.id === "r4"));
ok("override only affects that user", ids(requiredForUser(cfg2, "u9", "field")) === "r1,r2");
const cfg3 = { items: cfg.items, byUser: { u1: { off: ["r1"], on: ["r1"] } } };
ok("off wins over on for same id", !requiredForUser(cfg3, "u1", "field").some(x => x.id === "r1"));

// ── reqStatus matching ─────────────────────────────────────────────────────────
const item = { kind: "qualification", title: "CSCS" };
ok("valid record → held", reqStatus(item, [{ kind: "qualification", title: "CSCS", expires: future }]).status === "held");
ok("no-expiry record → held", reqStatus(item, [{ kind: "qualification", title: "CSCS", expires: "" }]).status === "held");
ok("expiring record → expiring", reqStatus(item, [{ kind: "qualification", title: "CSCS", expires: soon }]).status === "expiring");
ok("expired record → expired", reqStatus(item, [{ kind: "qualification", title: "CSCS", expires: past }]).status === "expired");
ok("no record → missing", reqStatus(item, [{ kind: "qualification", title: "SMSTS", expires: future }]).status === "missing");
ok("kind mismatch → missing", reqStatus({ kind: "licence", title: "Driving Licence" }, [{ kind: "qualification", title: "Driving Licence", expires: future }]).status === "missing");
ok("contains-match (First Aid ~ First Aid at Work)", reqStatus({ kind: "qualification", title: "First Aid" }, [{ kind: "qualification", title: "First Aid at Work", expires: future }]).status === "held");
ok("best-of: valid beats expired", reqStatus(item, [{ kind: "qualification", title: "CSCS", expires: past }, { kind: "qualification", title: "CSCS", expires: future }]).status === "held");
ok("held carries furthest expiry", reqStatus(item, [{ kind: "qualification", title: "CSCS", expires: future }]).expires === future);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
