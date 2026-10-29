// Valuation-sheet PDF — a clean VECTOR A4-landscape table drawn straight from the
// valuation JSON (never a screenshot). One row per work item (description + cost),
// a column per valuation (amount taken that time), then Total Taken / Remaining /
// Completion %. The CURRENT valuation column is highlighted, like the on-screen
// sheet. Below the table: a totals row and summary "bubbles" (each valuation's
// gross + cumulative + net due, retention on the final account, contract total,
// certified to date, remaining).
//
//   buildValuationPdf(data, meta) -> Uint8Array
//     data = { title, client, projectNumber, retentionPct, retentionMode,
//              vatRate, columns:[{id,name,date,note,final}], currentColumnId,
//              items:[{id,desc,cost,extra,amounts:{colId:amount}}] }
//     meta = { title, client, ref, projectNumber }
//
// Kept dependency-free (imports only lib/pdf.js) so it's unit-testable in Node.

import { PdfDoc, textWidth, toWinAnsi } from "./pdf.js";
import { MOSTLANE_LOGO_JPEG_B64, MOSTLANE_LOGO_W, MOSTLANE_LOGO_H } from "./logo.js";

let LOGO_BYTES = null;
try {
  const bin = atob(MOSTLANE_LOGO_JPEG_B64);
  LOGO_BYTES = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) LOGO_BYTES[i] = bin.charCodeAt(i);
} catch (e) { LOGO_BYTES = null; }
const LOGO_W = 70, LOGO_H = LOGO_W * (MOSTLANE_LOGO_H / MOSTLANE_LOGO_W);

const PW = 842, PH = 595, M = 28;
const NAVY = [0.0, 0.2, 0.41];       // #003468
const HILITE = [1, 0.98, 0.78];      // soft yellow — the current valuation column
const EXTRA = [0.70, 0.33, 0.04];    // amber — extra-works rows
const ZEBRA = [0.965, 0.975, 0.985];
const GRID = [0.82, 0.86, 0.90];
const HEAD_H = 92;                   // top header band + facts
const TH_H = 26;                     // table header row
const ROW_MIN = 16, LINE_H = 9.5, ROW_PAD = 5;
const MAX_DESC_LINES = 6;

const money = n => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? "-£" : "£") + s;
};
const pctStr = f => (isFinite(f) ? Math.round(f * 100) : 0) + "%";

function compute(data) {
  const pct = Math.max(0, Math.min(100, Number(data && data.retentionPct) || 0));
  const mode = (data && data.retentionMode) === "each" ? "each" : "final";
  const cols = Array.isArray(data && data.columns) ? data.columns : [];
  const items = Array.isArray(data && data.items) ? data.items : [];
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  let contractTotal = 0, grandGross = 0;
  const perItem = items.map(it => {
    const cost = num(it.cost), amounts = (it && it.amounts) || {};
    let taken = 0; for (const c of cols) taken += num(amounts[c.id]);
    contractTotal += cost; grandGross += taken;
    return { desc: it.desc || "", cost, extra: !!it.extra, amounts, taken, remaining: cost - taken, pct: cost ? taken / cost : 0 };
  });
  let grossCum = 0, prevNet = 0;
  const perCol = cols.map(c => {
    let gross = 0; for (const it of items) gross += num((it.amounts || {})[c.id]);
    grossCum += gross;
    const retHeld = mode === "each" ? (pct / 100) * grossCum : (c.final ? (pct / 100) * grossCum : 0);
    const netCum = grossCum - retHeld, dueThis = netCum - prevNet; prevNet = netCum;
    return { id: c.id, name: c.name || "", date: c.date || "", final: !!c.final, gross, grossCum, retHeld, netCum, dueThis };
  });
  const last = perCol[perCol.length - 1] || null;
  return { pct, mode, contractTotal, grandGross, remaining: contractTotal - grandGross,
           completion: contractTotal ? grandGross / contractTotal : 0,
           retentionHeld: last ? last.retHeld : 0, netCertified: last ? last.netCum : 0, perItem, perCol, cols };
}

// Greedy word-wrap to a width (pt), hard-breaking an over-long word.
function wrapLines(str, width, size) {
  const words = toWinAnsi(String(str || "")).split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  const push = () => { if (cur) lines.push(cur); cur = ""; };
  for (let w of words) {
    while (textWidth(w, size) > width && w.length > 1) {
      let i = w.length; while (i > 1 && textWidth(w.slice(0, i), size) > width) i--;
      if (cur) push();
      lines.push(w.slice(0, i)); w = w.slice(i);
    }
    const t = cur ? cur + " " + w : w;
    if (textWidth(t, size) > width && cur) { push(); cur = w; } else cur = t;
  }
  push();
  if (lines.length > MAX_DESC_LINES) { lines.length = MAX_DESC_LINES; lines[MAX_DESC_LINES - 1] = lines[MAX_DESC_LINES - 1].replace(/.{3}$/, "...") || "..."; }
  return lines.length ? lines : [""];
}

export function buildValuationPdf(data, meta = {}) {
  data = data || {};
  const C = compute(data);
  const doc = new PdfDoc(PW, PH);
  const currentId = data.currentColumnId || (C.cols[C.cols.length - 1] || {}).id;

  // ── Column layout. Fixed cols + one per valuation; description takes the slack.
  const VAL_W_IDEAL = 66, VAL_W_MIN = 44;
  const idxW = 22, costW = 66, totW = 66, remW = 66, pctW = 40;
  const gridX = M, gridRight = PW - M;
  const fixedRight = costW + totW + remW + pctW;
  let nVal = C.perCol.length;
  let avail = gridRight - gridX - idxW - fixedRight;
  // Shrink value columns to fit; description keeps a floor of 150pt.
  let descW = 190, valW = VAL_W_IDEAL;
  if (nVal > 0) {
    valW = Math.max(VAL_W_MIN, Math.min(VAL_W_IDEAL, (avail - 150) / nVal));
    descW = avail - valW * nVal;
    if (descW < 150) { descW = 150; valW = Math.max(28, (avail - 150) / nVal); }
  } else { descW = avail; }

  // Build x-offsets for each column.
  const cols = [];
  let x = gridX;
  cols.push({ key: "idx", label: "", x, w: idxW }); x += idxW;
  cols.push({ key: "desc", label: "Description", x, w: descW }); x += descW;
  cols.push({ key: "cost", label: "Cost", x, w: costW, right: true }); x += costW;
  C.perCol.forEach((pc, i) => { cols.push({ key: "val" + i, label: pc.name || ("Val " + (i + 1)), x, w: valW, right: true, colId: pc.id, final: pc.final }); x += valW; });
  cols.push({ key: "tot", label: "Taken", x, w: totW, right: true }); x += totW;
  cols.push({ key: "rem", label: "Remaining", x, w: remW, right: true }); x += remW;
  cols.push({ key: "pct", label: "%", x, w: pctW, right: true });

  // ── Pre-measure each item row's height (wrapped description). ──────────────
  const rows = C.perItem.map(it => {
    const lines = wrapLines(it.desc, descW - 8, 8);
    return { it, lines, h: Math.max(ROW_MIN, lines.length * LINE_H + ROW_PAD) };
  });

  // ── Paginate rows by cumulative height. ───────────────────────────────────
  const bodyTop = HEAD_H + TH_H;
  const bodyBottom = PH - 42;          // leave room for the footer
  const pages = []; let cur = [], h = bodyTop;
  for (const r of rows) {
    if (h + r.h > bodyBottom && cur.length) { pages.push(cur); cur = []; h = bodyTop; }
    cur.push(r); h += r.h;
  }
  pages.push(cur);

  const drawHeader = () => {
    doc.rect(0, 0, PW, HEAD_H - 20, { fill: NAVY });
    if (LOGO_BYTES) { try { doc.image(LOGO_BYTES, M, 14, LOGO_W, LOGO_H); } catch {} }
    const tx = M + LOGO_W + 14;
    doc.text(tx, 30, toWinAnsi(meta.title || data.title || "Valuation"), { size: 15, bold: true, color: [1, 1, 1] });
    const sub = [meta.ref, meta.client || data.client, (meta.projectNumber || data.projectNumber) ? ("Project " + (meta.projectNumber || data.projectNumber)) : ""].filter(Boolean).join("   ·   ");
    if (sub) doc.text(tx, 46, toWinAnsi(sub), { size: 9.5, color: [0.85, 0.9, 0.96] });
    doc.text(gridRight, 30, "VALUATION", { size: 9, bold: true, color: [0.75, 0.82, 0.9], alignRight: true });
    doc.text(gridRight, 44, new Date().toLocaleDateString("en-GB"), { size: 9, color: [0.85, 0.9, 0.96], alignRight: true });
    // Table header row.
    doc.rect(gridX, HEAD_H, (gridRight - gridX), TH_H, { fill: NAVY });
    for (const c of cols) {
      if (c.colId === currentId) doc.rect(c.x, HEAD_H, c.w, TH_H, { fill: [0.12, 0.3, 0.5] });
      const lbl = toWinAnsi(c.label);
      if (c.key === "idx") continue;
      if (c.label.length > 1 && textWidth(lbl, 8, true) > c.w - 4 && c.key.startsWith("val")) {
        // two-line valuation header (name + date)
        doc.text(c.x + c.w - 3, HEAD_H + 11, lbl.slice(0, 16), { size: 7.5, bold: true, color: [1, 1, 1], alignRight: true });
      } else {
        doc.text(c.right ? c.x + c.w - 3 : c.x + 3, HEAD_H + 12, lbl, { size: 8, bold: true, color: [1, 1, 1], alignRight: !!c.right });
      }
      const pc = c.key.startsWith("val") ? C.perCol[parseInt(c.key.slice(3), 10)] : null;
      if (pc && pc.date) doc.text(c.x + c.w - 3, HEAD_H + 21, toWinAnsi(pc.date), { size: 6.5, color: [0.8, 0.86, 0.93], alignRight: true });
      else if (pc && pc.final) doc.text(c.x + c.w - 3, HEAD_H + 21, "final a/c", { size: 6.5, color: [0.95, 0.85, 0.6], alignRight: true });
    }
  };

  pages.forEach((pageRows, pi) => {
    if (pi > 0) doc.newPage(PW, PH);
    drawHeader();
    let y = bodyTop;
    pageRows.forEach((r, ri) => {
      const it = r.it;
      // row background: extra-works amber tint, else zebra
      if (it.extra) doc.rect(gridX, y, gridRight - gridX, r.h, { fill: [1, 0.96, 0.9] });
      else if (ri % 2) doc.rect(gridX, y, gridRight - gridX, r.h, { fill: ZEBRA });
      // highlight the current valuation cell for this row
      const curCol = cols.find(c => c.colId === currentId);
      if (curCol) doc.rect(curCol.x, y, curCol.w, r.h, { fill: HILITE });
      // description (wrapped)
      r.lines.forEach((ln, li) => doc.text(cols[1].x + 4, y + 10 + li * LINE_H, ln, { size: 8, color: it.extra ? EXTRA : [0.1, 0.14, 0.2] }));
      const by = y + 10;
      doc.text(cols[2].x + cols[2].w - 3, by, money(it.cost), { size: 8, alignRight: true });
      C.perCol.forEach((pc, i) => {
        const amt = Number((it.amounts || {})[pc.id]) || 0;
        const cc = cols.find(c => c.key === "val" + i);
        if (amt) doc.text(cc.x + cc.w - 3, by, money(amt), { size: 8, alignRight: true });
      });
      const ct = cols.find(c => c.key === "tot"), cr = cols.find(c => c.key === "rem"), cp = cols.find(c => c.key === "pct");
      doc.text(ct.x + ct.w - 3, by, money(it.taken), { size: 8, bold: true, alignRight: true });
      doc.text(cr.x + cr.w - 3, by, money(it.remaining), { size: 8, alignRight: true, color: it.remaining > 0.005 ? [0.6, 0.2, 0.2] : [0.2, 0.45, 0.2] });
      doc.text(cp.x + cp.w - 3, by, pctStr(it.pct), { size: 8, alignRight: true, grey: true });
      // row rule
      doc.line(gridX, y + r.h, gridRight, y + r.h, { stroke: GRID, lw: 0.4 });
      y += r.h;
    });

    // Totals + summary only on the LAST page (after the final rows).
    if (pi === pages.length - 1) {
      // totals row
      const th = 20;
      if (y + th < PH - 40) {
        doc.rect(gridX, y, gridRight - gridX, th, { fill: [0.90, 0.93, 0.96] });
        doc.text(cols[1].x + 4, y + 13, "TOTALS", { size: 9, bold: true });
        doc.text(cols[2].x + cols[2].w - 3, y + 13, money(C.contractTotal), { size: 9, bold: true, alignRight: true });
        C.perCol.forEach((pc, i) => { const cc = cols.find(c => c.key === "val" + i); doc.text(cc.x + cc.w - 3, y + 13, money(pc.gross), { size: 8.5, bold: true, alignRight: true }); });
        const ct = cols.find(c => c.key === "tot"), cr = cols.find(c => c.key === "rem"), cp = cols.find(c => c.key === "pct");
        doc.text(ct.x + ct.w - 3, y + 13, money(C.grandGross), { size: 9, bold: true, alignRight: true });
        doc.text(cr.x + cr.w - 3, y + 13, money(C.remaining), { size: 9, bold: true, alignRight: true });
        doc.text(cp.x + cp.w - 3, y + 13, pctStr(C.completion), { size: 9, bold: true, alignRight: true });
        y += th + 14;
      } else { doc.newPage(PW, PH); drawHeader(); y = bodyTop; }

      // ── Summary bubbles ──────────────────────────────────────────────────
      if (y + 120 > PH - 40) { doc.newPage(PW, PH); y = 40; }
      doc.text(gridX, y + 2, "Summary", { size: 11, bold: true, color: NAVY });
      y += 12;
      const bubbleW = 168, bubbleH = 58, gap = 10;
      let bx = gridX, by = y;
      const bubble = (title, lines) => {
        if (bx + bubbleW > gridRight) { bx = gridX; by += bubbleH + gap; }
        doc.rect(bx, by, bubbleW, bubbleH, { fill: [0.97, 0.98, 0.99], stroke: GRID, lw: 0.6 });
        doc.text(bx + 8, by + 14, toWinAnsi(title), { size: 8, bold: true, color: NAVY });
        lines.forEach((ln, i) => doc.text(bx + 8, by + 28 + i * 11, toWinAnsi(ln), { size: 8.5, color: [0.12, 0.16, 0.22] }));
        bx += bubbleW + gap;
      };
      bubble("Contract total", [money(C.contractTotal)]);
      C.perCol.forEach((pc, i) => {
        const l = ["This valuation: " + money(pc.gross), "To date: " + money(pc.grossCum)];
        if (pc.retHeld) l.push("Retention: -" + money(pc.retHeld));
        l.push("Net due: " + money(pc.dueThis));
        bubble((pc.name || ("Valuation " + (i + 1))) + (pc.final ? " (final)" : ""), l);
      });
      bubble("Certified to date", [money(C.grandGross), "Net: " + money(C.netCertified)]);
      if (C.pct > 0) bubble("Retention held (" + C.pct + "%)", [money(C.retentionHeld), C.mode === "final" ? "on final account" : "each valuation"]);
      bubble("Remaining", [money(C.remaining), pctStr(C.completion) + " complete"]);
    }
  });

  // Footer on every page (stamped after layout so "Page X of Y" is right).
  const total = doc.pages.length;
  for (let i = 0; i < total; i++) {
    doc.lineOn(i, M, PH - 30, PW - M, { grey: true });
    doc.textOn(i, M, PH - 18, toWinAnsi((meta.ref ? meta.ref + "  ·  " : "") + (meta.title || data.title || "Valuation")), { size: 7.5, grey: true });
    doc.textOn(i, PW - M, PH - 18, "Page " + (i + 1) + " of " + total, { size: 7.5, grey: true, alignRight: true });
    doc.textOn(i, PW / 2, PH - 18, "Mostlane", { size: 7.5, grey: true, center: true });
  }
  return doc.bytes();
}
