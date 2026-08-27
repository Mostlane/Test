// Mostlane-branded EM / PAT certificate PDF — the "soft product UI" design:
// a light-grey canvas, white rounded cards with hairline borders, tracked
// small-caps micro-labels, a computed status pill, and green/red result dots.
// One builder serves both types via a column spec. Vector-drawn on lib/pdf.js
// (never a screenshot). A4 portrait, paginated (rows + a signature block).
import { PdfDoc, textWidth, jpegInfo, toWinAnsi } from "./pdf.js";

const W = 595, H = 842, M = 40, CW = W - M * 2;

// palette
const NAVY = [0, 0.204, 0.408];       // #003468
const NAVY_D = [0.0, 0.145, 0.29];    // deeper, for the header gradient-ish base
const INK = [0.10, 0.13, 0.18];
const MUTE = [0.46, 0.51, 0.58];
const FAINT = [0.62, 0.66, 0.72];
const BG = [0.953, 0.965, 0.977];
const CARD = [1, 1, 1];
const BORDER = [0.886, 0.906, 0.933];
const HAIR = [0.92, 0.935, 0.955];
const ZEBRA = [0.972, 0.980, 0.990];
const ACCENT = [0.04, 0.42, 0.52];    // teal-slate micro-labels
const GREEN = [0.09, 0.63, 0.29];
const RED = [0.83, 0.16, 0.16];
const GREY = [0.60, 0.64, 0.70];
const HEADSUB = [0.78, 0.85, 0.93];

const S = v => toWinAnsi(String(v == null ? "" : v));
const okColor = v => /fail/i.test(v) ? RED : (/(n\/?a|^—$|^$)/i.test(String(v || "").trim()) ? GREY : GREEN);

const COLS = {
  em: [
    { key: "no", label: "#", w: 0.06, align: "c", kind: "no" },
    { key: "comments", label: "Luminaire / location", w: 0.40, align: "l", kind: "text" },
    { key: "normal", label: "Normal", w: 0.13, align: "c", kind: "dot" },
    { key: "led", label: "LED", w: 0.12, align: "c", kind: "dot" },
    { key: "emergency", label: "Emergency", w: 0.15, align: "c", kind: "dot" },
    { key: "battery", label: "Batt", w: 0.14, align: "r", kind: "num" },
  ],
  pat: [
    { key: "no", label: "#", w: 0.05, align: "c", kind: "no" },
    { key: "appliance", label: "Appliance", w: 0.21, align: "l", kind: "text" },
    { key: "location", label: "Location", w: 0.15, align: "l", kind: "text" },
    { key: "cls", label: "Class", w: 0.07, align: "c", kind: "text" },
    { key: "visual", label: "Visual", w: 0.09, align: "c", kind: "dot" },
    { key: "earth", label: "Earth", w: 0.09, align: "c", kind: "text" },
    { key: "insulation", label: "Insul.", w: 0.10, align: "c", kind: "text" },
    { key: "result", label: "Result", w: 0.11, align: "c", kind: "pill" },
    { key: "comments", label: "Comments", w: 0.13, align: "l", kind: "text" },
  ],
};
const TITLES = { em: "Emergency Lighting Test", pat: "Portable Appliance Test" };

// ── low-level helpers ────────────────────────────────────────────────────────
function fit(str, size, maxW) {
  str = S(str);
  if (textWidth(str, size) <= maxW) return str;
  let s = str; while (s.length > 1 && textWidth(s + "…", size) > maxW) s = s.slice(0, -1);
  return s + "…";
}
function wrap(str, size, maxW, maxLines) {
  const words = S(str).split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textWidth(t, size) <= maxW) { cur = t; continue; }
    if (cur) lines.push(cur); cur = w;
    if (maxLines && lines.length >= maxLines) break;
  }
  if (cur && (!maxLines || lines.length < maxLines)) lines.push(cur);
  if (maxLines && lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = fit(lines[maxLines - 1], size, maxW); }
  return lines.length ? lines : [""];
}
// tracked (letter-spaced) UPPERCASE micro-label — the modern touch
function tracked(doc, x, y, str, { size = 6.5, color = MUTE, track = 1.3, alignRight = false, bold = true } = {}) {
  const chars = [...S(str).toUpperCase()];
  const total = chars.reduce((w, c) => w + textWidth(c, size) + track, -track);
  let cx = alignRight ? x - total : x;
  for (const c of chars) { doc.text(cx, y, c, { size, bold, color }); cx += textWidth(c, size) + track; }
  return total;
}
function dot(doc, cx, cy, r, color) { doc.roundRect(cx - r, cy - r, r * 2, r * 2, r, { fill: color }); }
function pill(doc, x, yTop, label, { fill, textColor = [1, 1, 1], size = 7, padX = 7, h = 13 } = {}) {
  const w = textWidth(S(label), size) + padX * 2;
  doc.roundRect(x, yTop, w, h, h / 2, { fill });
  doc.text(x + padX, yTop + h - 4, S(label), { size, bold: true, color: textColor });
  return w;
}
function pillC(doc, cx, yTop, label, opt) { const w = textWidth(S(label), opt.size || 7) + (opt.padX || 7) * 2; return pill(doc, cx - w / 2, yTop, label, opt); }
// hairline-bordered rounded white card (border = an underlaid slightly-larger rr)
function cardBox(doc, x, y, w, h, r = 12, fill = CARD) {
  doc.roundRect(x - 0.8, y - 0.8, w + 1.6, h + 1.6, r + 0.8, { fill: BORDER });
  doc.roundRect(x, y, w, h, r, { fill });
}

function addrLines(o) {
  o = o || {}; const out = [];
  (o.address ? String(o.address).split(/\s*,\s*/).filter(Boolean) : []).forEach(a => out.push(a));
  if (o.postcode) out.push(String(o.postcode));
  return out.length ? out : ["—"];
}
function statusOf(rec) {
  const rows = rec.rows || [];
  let fails = 0;
  for (const r of rows) {
    if (rec.type === "pat") { if (/fail/i.test(r.result || "") || /fail/i.test(r.visual || "")) fails++; }
    else { if (/fail/i.test(r.normal || "") || /fail/i.test(r.led || "") || /fail/i.test(r.emergency || "")) fails++; }
  }
  return fails ? { label: fails + (fails === 1 ? " ITEM FAILED" : " ITEMS FAILED"), color: RED } : { label: "ALL PASS", color: GREEN };
}

// ── measured heights ─────────────────────────────────────────────────────────
const HEADER_H = 96, GAP = 14, ROW_H = 19, THEAD_H = 22, CARD_PAD = 14;
function infoCardH(o) { return CARD_PAD + 14 + 14 + addrLines(o).length * 12 + 6; }   // label + name + addr + pad
function detailsH(rec) {
  let h = CARD_PAD + 14 + wrap(rec.extent || "—", 9, CW - 28, 3).length * 12;
  if (rec.comments) h += 10 + 12 + wrap(rec.comments, 8, CW - 28, 5).length * 10.5;
  return h + CARD_PAD;
}

// ── draw pieces ──────────────────────────────────────────────────────────────
function pageBg(doc) { doc.rect(0, 0, W, H, { fill: BG }); }

function headerFull(doc, rec, meta) {
  const y = 30, h = HEADER_H;
  cardBox(doc, M, y, CW, h, 14, NAVY);
  // subtle top sheen band
  doc.roundRect(M, y, CW, 5, 2.5, { fill: NAVY_D });
  if (meta.logo) { try { const g = jpegInfo(meta.logo); const hh = 26; doc.image(meta.logo, M + 20, y + 20, hh * (g.w / g.h), hh); } catch {} }
  const st = statusOf(rec);
  pill(doc, M + 20, y + 58, st.label, { fill: st.color, size: 7 });
  tracked(doc, W - M - 20, y + 26, TITLES[rec.type] + " Certificate", { size: 7.5, color: HEADSUB, track: 1.5, alignRight: true });
  doc.text(W - M - 20, y + 50, rec.certNumber ? "No. " + S(rec.certNumber) : "Draft — number on issue", { size: 15, bold: true, color: [1, 1, 1], alignRight: true });
  const dt = (rec.contractor && rec.contractor.date) ? rec.contractor.date : "";
  if (dt) doc.text(W - M - 20, y + 68, "Tested " + S(dt), { size: 9, color: HEADSUB, alignRight: true });
  if (rec.status === "draft" || rec.status === "review") doc.text(W - M - 20, y + 84, rec.status === "review" ? "Awaiting office review" : "Draft", { size: 7.5, color: [0.72, 0.8, 0.9], alignRight: true });
  return y + h;
}
function headerSlim(doc, rec, meta) {
  const y = 30, h = 40;
  cardBox(doc, M, y, CW, h, 12, NAVY);
  if (meta.logo) { try { const g = jpegInfo(meta.logo); const hh = 18; doc.image(meta.logo, M + 16, y + 11, hh * (g.w / g.h), hh); } catch {} }
  tracked(doc, W - M - 16, y + 17, TITLES[rec.type] + " — continued", { size: 7, color: HEADSUB, alignRight: true });
  if (rec.certNumber) doc.text(W - M - 16, y + 31, "No. " + S(rec.certNumber), { size: 9, bold: true, color: [1, 1, 1], alignRight: true });
  return y + h;
}

function infoCard(doc, x, y, w, label, o) {
  const h = infoCardH(o);
  cardBox(doc, x, y, w, h);
  tracked(doc, x + CARD_PAD, y + 18, label, { size: 6.5, color: ACCENT });
  doc.text(x + CARD_PAD, y + 34, fit(o && o.name || "—", 10.5, w - CARD_PAD * 2), { size: 10.5, bold: true, color: INK });
  let yy = y + 48;
  addrLines(o).forEach(a => { doc.text(x + CARD_PAD, yy, fit(a, 8.5, w - CARD_PAD * 2), { size: 8.5, color: MUTE }); yy += 12; });
  return h;
}
function detailsCard(doc, y, rec) {
  const h = detailsH(rec);
  cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, "Extent & limitations", { size: 6.5, color: ACCENT });
  let yy = y + 32;
  wrap(rec.extent || "—", 9, CW - 28, 3).forEach(l => { doc.text(M + CARD_PAD, yy, l, { size: 9, color: INK }); yy += 12; });
  if (rec.comments) {
    yy += 8; tracked(doc, M + CARD_PAD, yy, "Additional comments", { size: 6.5, color: ACCENT }); yy += 13;
    wrap(rec.comments, 8, CW - 28, 5).forEach(l => { doc.text(M + CARD_PAD, yy, l, { size: 8, color: MUTE }); yy += 10.5; });
  }
  return h;
}

function resultsCard(doc, layout, rows, startIndex, y, titleType, count) {
  const bodyH = rows.length * ROW_H;
  const h = 20 + THEAD_H + bodyH + 12;
  cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, (titleType === "pat" ? "Appliances tested" : "Emergency lighting tests"), { size: 6.5, color: ACCENT });
  if (count != null) doc.text(W - M - CARD_PAD, y + 18, String(count) + (titleType === "pat" ? " appliances" : " luminaires"), { size: 7.5, color: FAINT, alignRight: true });
  // column x positions
  const x0 = M + CARD_PAD, tw = CW - CARD_PAD * 2;
  let cx = x0; const cols = layout.map(c => { const ww = tw * c.w; const o = { ...c, x: cx, ww }; cx += ww; return o; });
  const headY = y + 26 + THEAD_H - 8;
  cols.forEach(c => {
    const lw = trackedWidth(c.label, 6, 0.8);
    let lx = c.x;                                   // left
    if (c.align === "c") lx = c.x + c.ww / 2 - lw / 2;
    else if (c.align === "r") lx = c.x + c.ww - lw;
    tracked(doc, lx, headY, c.label, { size: 6, color: MUTE, track: 0.8 });
  });
  let ry = y + 26 + THEAD_H;
  doc.line(x0, ry - 4, x0 + tw, ry - 4, { stroke: HAIR, lw: 0.8 });
  rows.forEach((r, i) => {
    if ((startIndex + i) % 2 === 1) doc.rect(x0 - 4, ry, tw + 8, ROW_H, { fill: ZEBRA });
    const midY = ry + ROW_H / 2, txtY = ry + 12.5;
    cols.forEach(c => {
      if (c.kind === "no") { const v = String(startIndex + i + 1).padStart(2, "0"); doc.text(c.x + c.ww / 2 - textWidth(v, 8) / 2, txtY, v, { size: 8, bold: true, color: FAINT }); return; }
      if (c.kind === "dot") {
        let dv = r[c.key];
        // A not-replaced EM remedial is a genuine failure — show the emergency dot red.
        if (titleType === "em" && c.key === "emergency" && r.remedial && r.remedial.failed && r.remedial.replacedOnSite === false) dv = "Fail";
        dot(doc, c.x + c.ww / 2, midY, 3.1, okColor(dv)); return;
      }
      if (c.kind === "pill") { const v = r[c.key] || ""; if (v) pillC(doc, c.x + c.ww / 2, ry + (ROW_H - 12) / 2, /fail/i.test(v) ? "FAIL" : "PASS", { fill: okColor(v), size: 6.5, padX: 6, h: 12 }); return; }
      let v = r[c.key] == null ? "" : r[c.key];
      // EM remedial: annotate the luminaire/location cell so the certificate flags
      // the fault to the client — replaced on site (fixed, still chargeable) or a
      // genuine failure needing remedial works.
      if (titleType === "em" && c.key === "comments" && r.remedial && r.remedial.failed) {
        const tag = r.remedial.replacedOnSite === true ? "Fitting failed, replaced on site"
          : r.remedial.replacedOnSite === false ? "FITTING FAILED — remedial required" : "";
        if (tag) v = (S(v).trim() ? S(v).trim() + " — " : "") + tag;
      }
      const s = fit(v, 8, c.ww - 8);
      const tx = c.align === "r" ? c.x + c.ww - textWidth(s, 8) : c.x + 2;
      doc.text(tx, txtY, s, { size: 8, color: c.key === "comments" ? MUTE : INK });
    });
    ry += ROW_H;
  });
  return h;
}
function trackedWidth(str, size, track) { const chars = [...S(str).toUpperCase()]; return chars.reduce((w, c) => w + textWidth(c, size) + track, -track); }

function signatureCard(doc, y, rec, meta) {
  const con = rec.contractor || {};
  const declLines = wrap(rec.declaration || (rec.type === "em"
    ? "I certify that the emergency lighting installation identified above has been inspected and tested to BS 5266-1:2016 and the results are as recorded."
    : "I certify that the portable appliances identified above have been inspected and tested in accordance with the IET Code of Practice, and the results are as recorded."), 8.5, CW - 200, 3);
  const h = Math.max(96, CARD_PAD + 14 + declLines.length * 11 + 58);
  cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, "Declaration", { size: 6.5, color: ACCENT });
  let yy = y + 32;
  declLines.forEach(l => { doc.text(M + CARD_PAD, yy, l, { size: 8.5, color: MUTE }); yy += 11; });
  // signature area (right)
  const sigX = W - M - 190;
  if (meta.signature) { try { const g = jpegInfo(meta.signature); const hh = 34; doc.image(meta.signature, sigX, y + 20, Math.min(170, hh * (g.w / g.h)), hh); } catch {} }
  doc.line(sigX, y + 60, sigX + 170, y + 60, { stroke: BORDER, lw: 0.7 });
  doc.text(sigX, y + 72, S([con.name, con.position].filter(Boolean).join("  ·  ") || "Engineer"), { size: 9, bold: true, color: INK });
  doc.text(sigX, y + 84, S(con.date ? "Signed " + con.date : ""), { size: 7.5, color: MUTE });
  // contractor line bottom-left
  doc.text(M + CARD_PAD, y + h - 12, S([con.tradingTitle || "Mostlane", con.address, con.postcode].filter(Boolean).join(" · ")), { size: 7.5, color: FAINT });
  return h;
}

function footer(doc, rec, pageNo, pageCount) {
  const note = rec.type === "em" ? "Tested to BS 5266-1:2016." : "Tested to the IET Code of Practice for In-service Inspection & Testing.";
  doc.text(M, H - 22, note + "  Generated by the Mostlane Portal.", { size: 7, color: FAINT });
  doc.text(W - M, H - 22, `Page ${pageNo} of ${pageCount}`, { size: 7, color: FAINT, alignRight: true });
}

// ── main ─────────────────────────────────────────────────────────────────────
export function buildCertPdf(record, meta = {}) {
  const rec = record || {};
  rec.type = rec.type === "pat" ? "pat" : "em";
  rec.rows = Array.isArray(rec.rows) ? rec.rows : [];
  const layout = COLS[rec.type];

  // page-1 content stack height above the table
  const cl = rec.client || {}, inst = rec.installation || {};
  const infoH = Math.max(infoCardH(cl), infoCardH(inst));
  const introBottom = 30 + HEADER_H + GAP + infoH + GAP + detailsH(rec) + GAP;
  const bottomLimit = H - 40;

  const cap = (top, extraForTable) => Math.max(0, Math.floor((bottomLimit - top - (20 + THEAD_H + 12)) / ROW_H));
  const page1Cap = cap(introBottom);
  const slimTop = 30 + 40 + GAP;
  const laterCap = cap(slimTop);

  // paginate rows
  const pages = [];
  pages.push({ start: 0, rows: rec.rows.slice(0, page1Cap), intro: true, tableTop: introBottom });
  let i = page1Cap;
  while (i < rec.rows.length) { pages.push({ start: i, rows: rec.rows.slice(i, i + laterCap), intro: false, tableTop: slimTop }); i += laterCap; }

  // does the signature block fit under the last table?
  const last = pages[pages.length - 1];
  const lastBottom = last.tableTop + 20 + THEAD_H + last.rows.length * ROW_H + 12;
  const sigOwnPage = lastBottom + GAP + 96 > H - 40;
  const totalPages = pages.length + (sigOwnPage ? 1 : 0);

  const doc = new PdfDoc(W, H);
  pages.forEach((pg, idx) => {
    if (idx > 0) doc.newPage(W, H);
    pageBg(doc);
    if (pg.intro) {
      headerFull(doc, rec, meta);
      const iy = 30 + HEADER_H + GAP;
      const colW = (CW - GAP) / 2;
      infoCard(doc, M, iy, colW, "Client", cl);
      infoCard(doc, M + colW + GAP, iy, colW, "Installation address", inst);
      detailsCard(doc, iy + infoH + GAP, rec);
    } else {
      headerSlim(doc, rec, meta);
    }
    resultsCard(doc, layout, pg.rows, pg.start, pg.tableTop, rec.type, pg.intro ? rec.rows.length : null);
    footer(doc, rec, idx + 1, totalPages);
  });

  let sigY;
  if (sigOwnPage) { doc.newPage(W, H); pageBg(doc); headerSlim(doc, rec, meta); footer(doc, rec, totalPages, totalPages); sigY = slimTop; }
  else sigY = lastBottom + GAP;
  signatureCard(doc, sigY, rec, meta);

  return doc.bytes();
}
