// Cable Calculation Report PDF — vector A4 portrait, built on lib/pdf.js.
// buildCableCalcPdf(record, meta) — record is the engine result the client
// produced (inputs + values + checks), meta carries { logo } bytes.
// House style mirrors certpdf.js (navy header band, logo, cards, striped table).
import { PdfDoc, textWidth, jpegInfo, toWinAnsi } from "./pdf.js";

const W = 595, H = 842, M = 40, CW = W - M * 2;
const S = v => toWinAnsi(String(v == null ? "" : v));
const NAVY = [0.0, 0.20, 0.41];     // #003468
const INK = [0.09, 0.14, 0.22];
const GREY = [0.42, 0.47, 0.53];
const CARD = [0.97, 0.98, 0.99];
const BORDER = [0.84, 0.87, 0.90];
const GREEN = [0.13, 0.55, 0.30];
const RED = [0.78, 0.16, 0.16];
const AMBER = [0.70, 0.44, 0.03];
const ZEBRA = [0.955, 0.965, 0.975];

function card(doc, x, y, w, h, r = 10) {
  doc.roundRect(x - 0.8, y - 0.8, w + 1.6, h + 1.6, r + 0.8, { fill: BORDER });
  doc.roundRect(x, y, w, h, r, { fill: CARD });
}
function label(doc, x, y, str) { doc.text(x, y, S(str).toUpperCase(), { size: 6.6, color: GREY }); }
function val(doc, x, y, str, opt = {}) { doc.text(x, y, S(str), Object.assign({ size: 9.5, color: INK }, opt)); }

// Wrap a string to a pixel width, returning lines (hard-breaks over-long words).
function wrap(str, width, size) {
  const words = S(str).split(/\s+/); const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textWidth(t, size) <= width) { cur = t; continue; }
    if (cur) lines.push(cur);
    if (textWidth(w, size) > width) { let chunk = ""; for (const ch of w) { if (textWidth(chunk + ch, size) > width) { lines.push(chunk); chunk = ch; } else chunk += ch; } cur = chunk; }
    else cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function buildCableCalcPdf(record, meta = {}) {
  const doc = new PdfDoc(W, H);
  const inp = record.inputs || {};
  const v = record.values || {};
  const checks = record.checks || [];
  const m = record.meta || {};

  // ── header band ──
  doc.rect(0, 0, W, 92, { fill: NAVY });
  if (meta.logo) { try { const g = jpegInfo(meta.logo); const hh = 30; doc.image(meta.logo, M, 20, hh * (g.w / g.h), hh); } catch {} }
  doc.text(M, 70, "Cable Calculation Report", { size: 17, bold: true, color: [1, 1, 1] });
  doc.text(W - M, 34, S(m.company || "Mostlane"), { size: 10, bold: true, color: [1, 1, 1], alignRight: true });
  doc.text(W - M, 50, S("Ref: " + (record.ref || record.id || "—")), { size: 8.5, color: [0.8, 0.86, 0.94], alignRight: true });
  doc.text(W - M, 64, S("Date: " + (m.date || new Date().toISOString().slice(0, 10))), { size: 8.5, color: [0.8, 0.86, 0.94], alignRight: true });

  // overall outcome pill
  const overall = record.incomplete ? "INCOMPLETE" : (record.pass ? "COMPLIANT" : "NOT COMPLIANT");
  const oc = record.incomplete ? AMBER : (record.pass ? GREEN : RED);
  const pw = textWidth(overall, 9) + 22;
  doc.roundRect(M, 108, pw, 20, 10, { fill: oc });
  doc.text(M + 11, 122, overall, { size: 9, bold: true, color: [1, 1, 1] });
  doc.text(M + pw + 12, 122, S(m.title || (inp.circuitRef ? "Circuit " + inp.circuitRef : "Single circuit")), { size: 10.5, bold: true, color: INK });

  // ── detail cards (two columns) ──
  let y = 144;
  const colW = (CW - 14) / 2, cx2 = M + colW + 14;
  const cardH = 128;
  card(doc, M, y, colW, cardH); card(doc, cx2, y, colW, cardH);
  label(doc, M + 12, y + 16, "Circuit"); label(doc, cx2 + 12, y + 16, "Installation");

  const phase = inp.phases === 3 ? "3-phase 400 V" : "1-phase 230 V";
  const left = [
    ["Client / site", (m.client || "—") + (m.site ? " · " + m.site : "")],
    ["Circuit reference", inp.circuitRef || "—"],
    ["Supply", phase + (inp.ze != null ? " · Ze " + inp.ze + " Ω" : "")],
    ["Design current Ib", v.Ib != null ? v.Ib + " A" : "—"],
    ["Protective device", devLabel(inp)],
    ["Disconnection time", (inp.disconnect === 5 ? "5 s" : "0.4 s")]
  ];
  const right = [
    ["Cable", (v.cable && v.cable.name) || "—"],
    ["Live / CPC CSA", (inp.csa || "?") + " / " + (inp.cpcCsa || "?") + " mm²"],
    ["Reference method", inp.method || "—"],
    ["Length", inp.length != null ? inp.length + " m" : "—"],
    ["Ambient / grouping", (inp.ambient != null ? inp.ambient + "°C" : "30°C") + " · " + (inp.circuits || 1) + " circuit(s)"],
    ["Insulation", (inp.insulation === "xlpe" ? "90°C thermosetting" : "70°C thermoplastic") + " " + ((inp.conductor || "cu") === "al" ? "Al" : "Cu")]
  ];
  const rowGap = 17.5;
  left.forEach((r, i) => { const ry = y + 34 + i * rowGap; label(doc, M + 12, ry, r[0]); val(doc, M + 12, ry + 11, r[1]); });
  right.forEach((r, i) => { const ry = y + 34 + i * rowGap; label(doc, cx2 + 12, ry, r[0]); val(doc, cx2 + 12, ry + 11, r[1]); });

  // ── correction factors strip ──
  y += cardH + 14;
  card(doc, M, y, CW, 34);
  label(doc, M + 12, y + 14, "Correction factors (BS 7671 App 4)");
  const facs = [
    ["Ca", v.Ca && v.Ca.value], ["Cg", v.Cg && v.Cg.value], ["Ci", v.Ci && v.Ci.value],
    ["Cc", v.Cc && v.Cc.value], ["Product", v.factorProduct]
  ];
  let fx = M + 12;
  facs.forEach(f => { const t = f[0] + " " + (f[1] == null ? "—" : f[1]); doc.text(fx, y + 27, S(t), { size: 9, color: INK, bold: f[0] === "Product" }); fx += textWidth(t, 9) + 26; });

  // ── checks table ──
  y += 34 + 16;
  doc.text(M, y, "Verification", { size: 11, bold: true, color: NAVY }); y += 8;
  const cols = [
    { key: "res", label: "", w: 0.05, align: "c" },
    { key: "label", label: "Check", w: 0.34 },
    { key: "reg", label: "BS 7671", w: 0.14 },
    { key: "detail", label: "Result", w: 0.47 }
  ];
  // header
  card(doc, M, y, CW, 20, 6);
  let cxp = M + 8;
  cols.forEach(c => { if (c.label) doc.text(c.align === "c" ? cxp + CW * c.w / 2 - textWidth(c.label, 7) / 2 : cxp, y + 13, c.label.toUpperCase(), { size: 7, color: GREY }); cxp += CW * c.w; });
  y += 24;
  const rowH = 9;
  checks.forEach((c, i) => {
    const detailLines = wrap(c.detail || "", CW * 0.47 - 12, 8.4);
    const rh = Math.max(20, 8 + detailLines.length * 10.5);
    if (i % 2) doc.rect(M, y - 4, CW, rh, { fill: ZEBRA });
    let cxr = M + 8;
    // result dot
    const dotc = c.pass === true ? GREEN : c.pass === false ? RED : AMBER;
    doc.roundRect(M + CW * 0.05 / 2 - 3.5, y + 1, 7, 7, 3.5, { fill: dotc });
    cxr += CW * 0.05;
    doc.text(cxr, y + 8, S(c.label), { size: 8.6, bold: true, color: INK }); cxr += CW * 0.34;
    doc.text(cxr, y + 8, S(c.reg), { size: 8, color: GREY }); cxr += CW * 0.14;
    detailLines.forEach((ln, k) => doc.text(cxr, y + 8 + k * 10.5, ln, { size: 8.4, color: INK }));
    y += rh;
  });

  // ── key figures ──
  y += 12;
  card(doc, M, y, CW, 58);
  label(doc, M + 12, y + 15, "Key figures");
  const figs = [
    ["Ib", v.Ib, "A"], ["In", v.In, "A"], ["Iz (corrected)", v.izCorrected, "A"],
    ["Volt drop", v.vdVolts, "V (" + (v.vdPercent == null ? "—" : v.vdPercent + "%") + ")"],
    ["Zs", v.Zs, "Ω"], ["Max Zs", v.maxZs && v.maxZs.value, "Ω"],
    ["Fault current", v.faultCurrent, "A"], ["Min CPC", v.minCpcCsa, "mm²"]
  ];
  const perRow = 4, fw = CW / perRow;
  figs.forEach((f, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const fxx = M + 12 + col * fw, fyy = y + 30 + row * 20;
    doc.text(fxx, fyy, S(f[0]), { size: 7.4, color: GREY });
    doc.text(fxx + 62, fyy, S((f[1] == null ? "—" : f[1]) + (f[1] == null ? "" : " " + f[2])), { size: 8.6, bold: true, color: INK });
  });

  // ── warnings ──
  y += 58 + 12;
  if ((record.warnings || []).length) {
    record.warnings.forEach(w => {
      const lines = wrap("• " + w, CW - 8, 8);
      lines.forEach((ln, k) => doc.text(M, y + k * 10, ln, { size: 8, color: AMBER }));
      y += lines.length * 10 + 3;
    });
    y += 4;
  }

  // ── declaration ──
  if (y > H - 120) { doc.newPage(W, H); y = M; }
  card(doc, M, y, CW, 66);
  label(doc, M + 12, y + 15, "Declaration");
  doc.text(M + 12, y + 30, S("Calculated by: " + (m.engineer || "—")), { size: 9, color: INK });
  doc.text(M + 12, y + 44, S("Position / qualification: " + (m.qualification || "—")), { size: 9, color: INK });
  doc.text(W - M - 12, y + 30, S("Date: " + (m.date || new Date().toISOString().slice(0, 10))), { size: 9, color: INK, alignRight: true });
  doc.text(M + 12, y + 58, S("This report is a design-verification aid. All values must be confirmed by a competent person against BS 7671 and the manufacturer's data before use."), { size: 6.8, color: GREY });

  // ── footers (stamped after layout) ──
  const total = doc.pages.length;
  for (let p = 0; p < total; p++) {
    doc.lineOn(p, M, H - 30, W - M, { grey: true });
    doc.textOn(p, M, H - 18, "Mostlane Cable Calculator — checking aid, not a substitute for BS 7671 / a competent person", { size: 6.6, grey: true });
    doc.textOn(p, W - M, H - 18, "Page " + (p + 1) + " of " + total, { size: 6.6, grey: true, alignRight: true });
  }
  return doc.bytes();
}

function devLabel(inp) {
  const std = { "60898": "BS EN 60898 MCB", "61009": "BS EN 61009 RCBO", "88": "BS 88 fuse", "3036": "BS 3036 fuse", "1361": "BS 1361 fuse" }[inp.deviceStd] || inp.deviceStd || "device";
  const curve = inp.deviceCurve ? " Type " + inp.deviceCurve : "";
  return (inp.In != null ? inp.In + " A " : "") + std + curve;
}
