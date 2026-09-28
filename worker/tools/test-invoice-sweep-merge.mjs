// Unit test for the incremental-sweep merge (mergeSweepProposals): remembered
// outstanding + freshly-read, de-duped by mailbox|message|attachment, fresh wins.
//   node --no-warnings worker/tools/test-invoice-sweep-merge.mjs
import { mergeSweepProposals } from "../src/routes/po.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("FAIL:", name); } };
const p = (mid, aid, extra = {}) => ({ mailbox: "accounts@x.com", messageId: mid, attachmentId: aid, ...extra });

// 1. Empty + empty = empty.
ok("empty merge", mergeSweepProposals([], []).length === 0);

// 2. Fresh added to outstanding, both kept when keys differ.
{
  const out = mergeSweepProposals([p("m1", "a1")], [p("m2", "a1")]);
  ok("distinct kept", out.length === 2);
}

// 3. Same key → fresh copy WINS (updated fields), not duplicated.
{
  const outstanding = [p("m1", "a1", { fields: { net: 100 }, tier: "old" })];
  const fresh = [p("m1", "a1", { fields: { net: 200 }, tier: "new" })];
  const out = mergeSweepProposals(outstanding, fresh);
  ok("dedupe by key", out.length === 1);
  ok("fresh wins", out[0].tier === "new" && out[0].fields.net === 200);
}

// 4. Same message, different attachment = two distinct invoices.
{
  const out = mergeSweepProposals([], [p("m1", "a1"), p("m1", "a2")]);
  ok("per-attachment key", out.length === 2);
}

// 5. Outstanding-only pass-through (a sweep that read nothing new).
{
  const out = mergeSweepProposals([p("m1", "a1"), p("m2", "a2")], []);
  ok("outstanding carried over", out.length === 2);
}

// 6. Null-safe.
ok("null args", mergeSweepProposals(null, null).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
