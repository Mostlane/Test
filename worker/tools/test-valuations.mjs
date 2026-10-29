// Unit tests for computeValuation (routes/valuations.js) — the valuation maths:
// per-item totals, per-column gross/cumulative/net-due, and the two-rate
// retention model (interim 5% on every valuation; the final account releases all
// of that and holds 2.5% of the contract value instead). Pure function, no D1.
// Run: node --no-warnings worker/tools/test-valuations.mjs
import { computeValuation } from "../src/routes/valuations.js";

let pass = 0, fail = 0;
const approx = (a, b) => Math.abs(a - b) < 0.005;
function eq(name, got, want) {
  if (approx(got, want)) { pass++; }
  else { fail++; console.log(`✗ ${name}: got ${got}, want ${want}`); }
}
function is(name, got, want) {
  if (got === want) { pass++; }
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
// col1 gross = 3610, col2 gross = 3988, col3 gross = 0
// contractTotal = 12464, grandGross = 7598, remaining = 4866

// ── Per-job toggle OFF — no retention whatever the rates ─────────────────────
{
  const C = computeValuation({ hasRetention: false, retentionPct: 5, finalRetentionPct: 2.5, columns: cols, items });
  is("toggle off → retentionOn false", C.retentionOn, false);
  is("toggle off → hasRetention false", C.hasRetention, false);
  eq("toggle off → nothing held", C.retentionHeld, 0);
  eq("toggle off → final due is gross", C.perCol[2].dueThis, 0);
  eq("toggle off → netCertified = gross", C.netCertified, 7598);
}
// ── New-sheet default (no toggle, no rate) → off ─────────────────────────────
{
  const C = computeValuation({ columns: cols, items });
  is("default off", C.retentionOn, false);
  eq("default nothing held", C.retentionHeld, 0);
}

// ── No retention (interim 0) ─────────────────────────────────────────────────
{
  const C = computeValuation({ retentionPct: 0, finalRetentionPct: 0, columns: cols, items });
  eq("contractTotal", C.contractTotal, 12464);
  eq("grandGross", C.grandGross, 7598);
  eq("remaining", C.remaining, 4866);
  eq("completion", C.completion, 7598 / 12464);
  eq("col1 gross", C.perCol[0].gross, 3610);
  eq("col2 gross", C.perCol[1].gross, 3988);
  eq("col3 gross", C.perCol[2].gross, 0);
  eq("col1 due (no ret)", C.perCol[0].dueThis, 3610);
  eq("col2 due (no ret)", C.perCol[1].dueThis, 3988);
  eq("col3 due (no ret)", C.perCol[2].dueThis, 0);
  eq("retention held", C.retentionHeld, 0);
  is("retentionOn false", C.retentionOn, false);
  eq("item2 taken", C.perItem[1].taken, 2888);
  eq("item2 remaining", C.perItem[1].remaining, 0);
  eq("item5 remaining", C.perItem[4].remaining, 2510);
  eq("item5 pct", C.perItem[4].pct, 0);
}

// ── Standard: 5% interim, released on the final account, 2.5% of contract held ─
{
  const C = computeValuation({ retentionPct: 5, finalRetentionPct: 2.5, columns: cols, items });
  // interim valuations hold 5% of cumulative gross
  eq("col1 interimAccrued", C.perCol[0].interimAccrued, 0.05 * 3610);        // 180.5
  eq("col1 retHeld", C.perCol[0].retHeld, 0.05 * 3610);                      // 180.5
  eq("col1 released", C.perCol[0].released, 0);
  eq("col1 netCum", C.perCol[0].netCum, 3610 - 180.5);                       // 3429.5
  eq("col1 due", C.perCol[0].dueThis, 3429.5);
  eq("col2 retHeld", C.perCol[1].retHeld, 0.05 * 7598);                      // 379.9
  eq("col2 netCum", C.perCol[1].netCum, 7598 - 379.9);                       // 7218.1
  eq("col2 due", C.perCol[1].dueThis, (7598 - 379.9) - (3610 - 180.5));      // 3788.6
  // final account: releases the 379.9 interim retention, holds 2.5% of contract
  eq("final interimAccrued", C.perCol[2].interimAccrued, 0.05 * 7598);       // 379.9
  eq("final released", C.perCol[2].released, 0.05 * 7598);                   // 379.9 added back
  eq("final retHeld (2.5% of contract)", C.perCol[2].retHeld, 0.025 * 12464); // 311.6
  eq("final netCum", C.perCol[2].netCum, 7598 - 311.6);                      // 7286.4
  eq("final due", C.perCol[2].dueThis, (7598 - 311.6) - (7598 - 379.9));     // +68.3
  eq("retentionHeld (final)", C.retentionHeld, 0.025 * 12464);               // 311.6
  eq("netCertified", C.netCertified, 7598 - 311.6);
  is("hasFinal", C.hasFinal, true);
  is("retentionOn", C.retentionOn, true);
  eq("interimPct echoed", C.retentionPct, 5);
  eq("finalPct echoed", C.finalRetentionPct, 2.5);
}

// ── finalRetentionPct defaults to half the interim rate when not supplied ──────
{
  const C = computeValuation({ retentionPct: 5, columns: cols, items });   // no finalRetentionPct
  eq("default finalPct = 2.5", C.finalRetentionPct, 2.5);
  eq("default final retHeld", C.perCol[2].retHeld, 0.025 * 12464);
}

// ── Interim only (no final column): 5% held on the last interim valuation ──────
{
  const interimCols = [
    { id: "c1", name: "Valuation 1", final: false },
    { id: "c2", name: "Valuation 2", final: false },
  ];
  const C = computeValuation({ retentionPct: 5, finalRetentionPct: 2.5, columns: interimCols, items });
  is("no final column", C.hasFinal, false);
  eq("last interim retHeld", C.perCol[1].retHeld, 0.05 * 7598);   // still interim 5%
  eq("interim retentionHeld", C.retentionHeld, 0.05 * 7598);
  eq("col2 released = 0 (not final)", C.perCol[1].released, 0);
}

// ── retention base falls back to gross when no item costs ──────────────────────
{
  const noCost = items.map(it => ({ ...it, cost: 0 }));
  const C = computeValuation({ retentionPct: 5, finalRetentionPct: 2.5, columns: cols, items: noCost });
  eq("retBase = gross when no contract total", C.retBase, 7598);
  eq("final retHeld on gross", C.perCol[2].retHeld, 0.025 * 7598);
}

// ── Edge cases ───────────────────────────────────────────────────────────────
{
  const C = computeValuation({ columns: [], items: [] });
  eq("empty contractTotal", C.contractTotal, 0);
  eq("empty completion", C.completion, 0);
  eq("empty retentionHeld", C.retentionHeld, 0);
}
{
  // retention ON but bad numbers fall back to the defaults (5% / 2.5%), never NaN
  const C = computeValuation({ hasRetention: true, retentionPct: "oops", finalRetentionPct: "x", columns: cols, items });
  eq("bad interim pct → 5%", C.retentionPct, 5);
  eq("bad final pct → 2.5%", C.finalRetentionPct, 2.5);
  eq("bad pct still computes final retention", C.retentionHeld, 0.025 * 12464);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
