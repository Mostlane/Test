// A compliance-only FBC client: what the server resolves it to see. Confirms the
// compliance-access model (the real data gate) still locks an external client to
// its OWN org's chart, read+download, and nothing else — for BOTH the jobs and the
// compliance-only client sub-type (clientRole only changes jobs access, never the
// compliance scope). Run:  node --no-warnings worker/tools/test-client-compliance.mjs
import { resolveComplianceAccess } from "../src/lib/complianceaccess.js";

let fail = 0;
const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };
const prof = (o) => JSON.stringify(o);

// ── FBC compliance-only client ───────────────────────────────────────────────
const cv = resolveComplianceAccess(prof({ staffType: "client", clientOrg: "fbc", clientRole: "compliance" }), {});
ok("fbc compliance client → fareham download", cv.fareham === "download", JSON.stringify(cv));
ok("fbc compliance client → coop/chapplins/projects none",
  cv.coop === "none" && cv.chapplins === "none" && cv.projects === "none", JSON.stringify(cv));

// ── FBC jobs client — SAME compliance scope (clientRole never widens/narrows it) ─
const jv = resolveComplianceAccess(prof({ staffType: "client", clientOrg: "fbc", clientRole: "jobs" }), {});
ok("fbc jobs client → identical compliance scope", JSON.stringify(jv) === JSON.stringify(cv), JSON.stringify(jv));

// ── a client with NO clientRole still only sees its org, read+download ─────────
const nv = resolveComplianceAccess(prof({ staffType: "client", clientOrg: "fbc" }), {});
ok("fbc client (no role) → fareham download, rest none",
  nv.fareham === "download" && nv.coop === "none", JSON.stringify(nv));

// ── a client can NEVER be edit, even if a stray stored level says so ───────────
const ev = resolveComplianceAccess(prof({ staffType: "client", clientOrg: "fbc",
  complianceAccess: { fareham: "edit", coop: "edit" } }), { FullAccess: "Yes" });
ok("client is hard-capped: never edit, never other schemes",
  ev.fareham === "download" && ev.coop === "none", JSON.stringify(ev));

// ── an unknown client org sees nothing (no scheme mapped) ──────────────────────
const uv = resolveComplianceAccess(prof({ staffType: "client", clientOrg: "nope", clientRole: "compliance" }), {});
ok("unknown client org → every scheme none",
  Object.values(uv).every(v => v === "none"), JSON.stringify(uv));

// ── staff resolution is untouched (FullAccess edit everywhere) ─────────────────
const sv = resolveComplianceAccess(prof({ staffType: "office" }), { FullAccess: "Yes" });
ok("staff FullAccess → edit everywhere", Object.values(sv).every(v => v === "edit"), JSON.stringify(sv));

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
