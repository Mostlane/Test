// Unit tests for computeValuation (routes/valuations.js) — the valuation maths:
// per-item totals, per-column gross/cumulative/net-due, and retention in both
// modes. Pure function, no D1. Run: node --no-warnings worker/tools/test-valuations.mjs
import { computeValuation } from "../src/routes/valuations.js";

let pass = 0, fail = 0;
const approx = (a, b) => Math.abs(a - b) < 0.005;
function eq(name, got, want) {
  if (approx(got, want)) { pass++; }
  else { fail++; console.log(`✗ ${name}: got ${got}, want ${want}`); }
}

const cols = [
  { id: "c1", name: "Valuation 1", final: false },
  { id: "c2", name: "Valuation 2", final: false },
  { id: "c3", name: "Final Account", final: true },
];
const items = [
  { id: "i1", desc: "A", cost: 110, amounts: { c1: 110 } },
  { id: "i2", desc: "B", cost: 2888, amounts: { c1: 1500, c2: 1388 } },
  { id: "i3", desc: "Prelims", cost: 5756, amounts: { c1: 2000, c2: 2000 } },
  { id: "i4", desc: "Extra", cost: 1200, extra: true, amounts: { c2: 600 } },
  { id: "i5", desc: "Not started", cost: 2510, amounts: {} },
];

// ── No retention ────────────────────────────────────────────────────────────
{
  const C = computeValuation({ retentionPct: 0, retentionMode: "final", columns: cols, items });
  eq("contractTotal", C.contractTotal, 12464);
  eq("grandGross", C.grandGross, 7598);
  eq("remaining", C.remaining, 4866);
  eq("completion", C.completion, 7598 / 12464);
  eq("col1 gross", C.perCol[0].gross, 3610);
  eq("col2 gross", C.perCol[1].gross, 3988);
  eq("col3 gross", C.perCol[2].gross, 0);
  eq("col1 due (no ret)", C.perCol[0].dueThis, 3610);
  eq("col2 due (no ret)", C.perCol[1].dueThis, 3988);
  eq("retention held", C.retentionHeld, 0);
  eq("item2 taken", C.perItem[1].taken, 2888);
  eq("item2 remaining", C.perItem[1].remaining, 0);
  eq("item5 remaining", C.perItem[4].remaining, 2510);
  eq("item5 pct", C.perItem[4].pct, 0);
}

// ── 2.5% retention on the FINAL account only ─────────────────────────────────
{
  const C = computeValuation({ retentionPct: 2.5, retentionMode: "final", columns: cols, items });
  eq("final: col1 retHeld", C.perCol[0].retHeld, 0);           // not final → no retention
  eq("final: col2 retHeld", C.perCol[1].retHeld, 0);
  eq("final: col3 retHeld", C.perCol[2].retHeld, 0.025 * 7598); // 189.95
  eq("final: col1 due", C.perCol[0].dueThis, 3610);            // unchanged before final
  eq("final: col2 due", C.perCol[1].dueThis, 3988);
  eq("final: col3 due (retention comes off)", C.perCol[2].dueThis, -0.025 * 7598);
  eq("final: retentionHeld", C.retentionHeld, 189.95);
  eq("final: netCertified", C.netCertified, 7598 - 189.95);
}

// ── 5% retention on EVERY valuation (standard) ───────────────────────────────
{
  const C = computeValuation({ retentionPct: 5, retentionMode: "each", columns: cols, items });
  eq("each: col1 retHeld", C.perCol[0].retHeld, 0.05 * 3610);          // 180.5
  eq("each: col2 retHeld", C.perCol[1].retHeld, 0.05 * 7598);          // on cumulative
  eq("each: col1 due", C.perCol[0].dueThis, 3610 - 0.05 * 3610);       // 3429.5
  // col2 net due = (cum2 - ret2) - (cum1 - ret1)
  const cum1 = 3610, cum2 = 7598;
  eq("each: col2 due", C.perCol[1].dueThis, (cum2 - 0.05 * cum2) - (cum1 - 0.05 * cum1));
  eq("each: netCertified", C.netCertified, 7598 - 0.05 * 7598);
}

// ── Edge cases ───────────────────────────────────────────────────────────────
{
  const C = computeValuation({ columns: [], items: [] });
  eq("empty contractTotal", C.contractTotal, 0);
  eq("empty completion", C.completion, 0);
  eq("empty retentionHeld", C.retentionHeld, 0);
}
{
  // retention clamps to 0..100; bad numbers treated as 0
  const C = computeValuation({ retentionPct: "oops", retentionMode: "final", columns: cols, items });
  eq("bad pct → 0 retention", C.retentionHeld, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
