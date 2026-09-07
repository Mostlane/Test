// Mostlane-branded Sump Pump Monthly Maintenance PDF — same "soft product UI"
// house style as the EM/PAT certificate (lib/certpdf.js): light-grey canvas,
// white rounded cards, tracked micro-labels, green/red result dots. Vector-drawn
// on lib/pdf.js (never a screenshot). A4 portrait, paginated over the checklist.
//
//   buildPumpPdf(record, meta) -> Uint8Array
//   record = { store, storeName, siteCode, date, ref, instructions,
//              safety:[{label,answer}], checks:[{label,answer}], detailsNo,
//              declaration, declarationAgreed, engineerName, dmName,
//              photos:[{name}], videos:[{name}] }
//   meta   = { logo, engSig, dmSig }   (JPEG byte arrays; engSig/dmSig optional)
import { PdfDoc, textWidth, jpegInfo, toWinAnsi } from "./pdf.js";

const W = 595, H = 842, M = 40, CW = W - M * 2;
const NAVY = [0, 0.204, 0.408], NAVY_D = [0.0, 0.145, 0.29];
const INK = [0.10, 0.13, 0.18], MUTE = [0.46, 0.51, 0.58], FAINT = [0.62, 0.66, 0.72];
const BG = [0.953, 0.965, 0.977], CARD = [1, 1, 1], BORDER = [0.886, 0.906, 0.933];
const HAIR = [0.92, 0.935, 0.955], ZEBRA = [0.972, 0.980, 0.990], ACCENT = [0.04, 0.42, 0.52];
const GREEN = [0.09, 0.63, 0.29], RED = [0.83, 0.16, 0.16], GREY = [0.60, 0.64, 0.70], HEADSUB = [0.78, 0.85, 0.93];

const S = v => toWinAnsi(String(v == null ? "" : v));
const ROW_H = 19, THEAD_H = 22, CARD_PAD = 14, GAP = 14, HEADER_H = 84;

function fit(str, size, maxW) { str = S(str); if (textWidth(str, size) <= maxW) return str; let s = str; while (s.length > 1 && textWidth(s + "...", size) > maxW) s = s.slice(0, -1); return s + "..."; }
function wrap(str, size, maxW, maxLines) {
  const words = S(str).split(/\s+/).filter(Boolean); const lines = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (textWidth(t, size) <= maxW) { cur = t; continue; } if (cur) lines.push(cur); cur = w; if (maxLines && lines.length >= maxLines) break; }
  if (cur && (!maxLines || lines.length < maxLines)) lines.push(cur);
  return lines.length ? lines : [""];
}
// Split an instructions blob (with \n) into wrapped display lines, keeping blanks.
function instrLines(str, size, maxW) {
  const out = [];
  String(str || "").split(/\r?\n/).forEach(raw => {
    const t = raw.trim(); if (!t) { out.push(""); return; }
    wrap(t, size, maxW).forEach(l => out.push(l));
  });
  return out;
}
function tracked(doc, x, y, str, { size = 6.5, color = MUTE, track = 1.2, alignRight = false, bold = true } = {}) {
  const chars = [...S(str).toUpperCase()];
  const total = chars.reduce((w, c) => w + textWidth(c, size) + track, -track);
  let cx = alignRight ? x - total : x;
  for (const c of chars) { doc.text(cx, y, c, { size, bold, color }); cx += textWidth(c, size) + track; }
  return total;
}
function dot(doc, cx, cy, r, color, hollow) {
  if (hollow) { doc.roundRect(cx - r, cy - r, r * 2, r * 2, r, { fill: [1, 1, 1] }); doc.roundRect(cx - r - 0.6, cy - r - 0.6, r * 2 + 1.2, r * 2 + 1.2, r + 0.6, { fill: BORDER }); doc.roundRect(cx - r, cy - r, r * 2, r * 2, r, { fill: [1, 1, 1] }); }
  else doc.roundRect(cx - r, cy - r, r * 2, r * 2, r, { fill: color });
}
function pill(doc, x, yTop, label, { fill, textColor = [1, 1, 1], size = 7, padX = 7, h = 13 } = {}) {
  const w = textWidth(S(label), size) + padX * 2; doc.roundRect(x, yTop, w, h, h / 2, { fill });
  doc.text(x + padX, yTop + h - 4, S(label), { size, bold: true, color: textColor }); return w;
}
function cardBox(doc, x, y, w, h, r = 12, fill = CARD) { doc.roundRect(x - 0.8, y - 0.8, w + 1.6, h + 1.6, r + 0.8, { fill: BORDER }); doc.roundRect(x, y, w, h, r, { fill }); }
function pageBg(doc) { doc.rect(0, 0, W, H, { fill: BG }); }

function ansOf(a) { const s = String(a || "").toLowerCase(); if (/^y/.test(s)) return "yes"; if (/^n\/?a/.test(s) || s === "na") return "na"; if (/^n/.test(s)) return "no"; return ""; }
function statusOf(rec) {
  const fails = (rec.checks || []).filter(c => ansOf(c.answer) === "no").length;
  const safe = (rec.safety || []).every(s => ansOf(s.answer) === "yes");
  if (!safe) return { label: "SAFETY NOT CONFIRMED", color: RED };
  return fails ? { label: fails + (fails === 1 ? " ITEM FAILED" : " ITEMS FAILED"), color: RED } : { label: "ALL PASS", color: GREEN };
}

function header(doc, rec, meta, slim) {
  const y = 30, h = slim ? 40 : HEADER_H; cardBox(doc, M, y, CW, h, slim ? 12 : 14, NAVY);
  if (!slim) doc.roundRect(M, y, CW, 5, 2.5, { fill: NAVY_D });
  if (meta.logo) { try { const g = jpegInfo(meta.logo); const hh = slim ? 18 : 24; doc.image(meta.logo, M + (slim ? 16 : 20), y + (slim ? 11 : 18), hh * (g.w / g.h), hh); } catch {} }
  if (slim) { tracked(doc, W - M - 16, y + 17, "Sump Pump Maintenance — continued", { size: 7, color: HEADSUB, alignRight: true }); doc.text(W - M - 16, y + 31, S(rec.storeName || ""), { size: 9, bold: true, color: [1, 1, 1], alignRight: true }); return y + h; }
  const st = statusOf(rec); pill(doc, M + 20, y + 52, st.label, { fill: st.color, size: 7 });
  tracked(doc, W - M - 20, y + 24, "Sump Pump Monthly Maintenance", { size: 7.5, color: HEADSUB, track: 1.4, alignRight: true });
  doc.text(W - M - 20, y + 47, S(rec.storeName || "—"), { size: 15, bold: true, color: [1, 1, 1], alignRight: true });
  if (rec.date) doc.text(W - M - 20, y + 64, "Serviced " + S(rec.date), { size: 9, color: HEADSUB, alignRight: true });
  if (rec.status === "draft" || rec.status === "review") doc.text(W - M - 20, y + 77, rec.status === "review" ? "Awaiting office review" : "Draft", { size: 7.5, color: [0.72, 0.8, 0.9], alignRight: true });
  return y + h;
}
function footer(doc, pageNo, pageCount) {
  doc.text(M, H - 22, "Sump pump monthly maintenance record. Generated by the Mostlane Portal.", { size: 7, color: FAINT });
  doc.text(W - M, H - 22, `Page ${pageNo} of ${pageCount}`, { size: 7, color: FAINT, alignRight: true });
}

function instrH(rec) { return CARD_PAD + 14 + instrLines(rec.instructions, 8.5, CW - CARD_PAD * 2).length * 11 + 4; }
function safetyH(rec) { return CARD_PAD + 14 + (rec.safety || []).length * 16 + 4; }
function detailsH(rec) { if (!String(rec.detailsNo || "").trim()) return 0; return CARD_PAD + 14 + wrap(rec.detailsNo, 8.5, CW - CARD_PAD * 2, 8).length * 11 + 4; }

function instrCard(doc, y, rec) {
  const h = instrH(rec); cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, "Location & method — " + S(rec.storeName || ""), { size: 6.5, color: ACCENT });
  let yy = y + 32; instrLines(rec.instructions, 8.5, CW - CARD_PAD * 2).forEach(l => { if (l) doc.text(M + CARD_PAD, yy, l, { size: 8.5, color: l === l.toUpperCase() && /IMPORTANT/i.test(l) ? INK : MUTE }); yy += 11; });
  return h;
}
function safetyCard(doc, y, rec) {
  const h = safetyH(rec); cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, "Safety before starting", { size: 6.5, color: ACCENT });
  let yy = y + 32;
  (rec.safety || []).forEach(s => {
    const ok = ansOf(s.answer) === "yes"; dot(doc, M + CARD_PAD + 4, yy - 3, 4, ok ? GREEN : RED);
    doc.text(M + CARD_PAD + 14, yy, fit(s.label, 8.5, CW - CARD_PAD * 2 - 70), { size: 8.5, color: INK });
    pill(doc, W - M - CARD_PAD - 40, yy - 10, ok ? "YES" : "NO", { fill: ok ? GREEN : RED, size: 6.5, h: 12 });
    yy += 16;
  });
  return h;
}
function checksCard(doc, rows, startIndex, y, count) {
  const h = 20 + THEAD_H + rows.length * ROW_H + 12; cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, "Monthly maintenance checks", { size: 6.5, color: ACCENT });
  if (count != null) doc.text(W - M - CARD_PAD, y + 18, count + " checks", { size: 7.5, color: FAINT, alignRight: true });
  const x0 = M + CARD_PAD, tw = CW - CARD_PAD * 2;
  const cItem = x0, wItem = tw * 0.70, cYes = x0 + tw * 0.76, cNo = x0 + tw * 0.85, cNa = x0 + tw * 0.94;
  const headY = y + 26 + THEAD_H - 8;
  tracked(doc, cItem, headY, "Check", { size: 6, color: MUTE, track: 0.6 });
  ["Yes", "No", "N/A"].forEach((lab, k) => { const cx = [cYes, cNo, cNa][k]; const lw = textWidth(lab, 6); doc.text(cx - lw / 2, headY, lab, { size: 6, color: MUTE }); });
  let ry = y + 26 + THEAD_H; doc.line(x0, ry - 4, x0 + tw, ry - 4, { stroke: HAIR, lw: 0.8 });
  rows.forEach((r, i) => {
    if ((startIndex + i) % 2 === 1) doc.rect(x0 - 4, ry, tw + 8, ROW_H, { fill: ZEBRA });
    const txtY = ry + ROW_H - 6, a = ansOf(r.answer);
    doc.text(cItem, txtY, fit(r.label, 8, wItem), { size: 8, color: INK });
    dot(doc, cYes, txtY - 3, 3.4, GREEN, a !== "yes");
    dot(doc, cNo, txtY - 3, 3.4, RED, a !== "no");
    dot(doc, cNa, txtY - 3, 3.4, GREY, a !== "na");
    ry += ROW_H;
  });
  return h;
}
function detailsCard(doc, y, rec) {
  const h = detailsH(rec); if (!h) return 0; cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, "Details of any check answered No", { size: 6.5, color: ACCENT });
  let yy = y + 32; wrap(rec.detailsNo, 8.5, CW - CARD_PAD * 2, 8).forEach(l => { doc.text(M + CARD_PAD, yy, l, { size: 8.5, color: INK }); yy += 11; });
  return h;
}
function mediaLine(rec) {
  const np = (rec.photos || []).length, nv = (rec.videos || []).length; const bits = [];
  if (np) bits.push(np + (np === 1 ? " photo" : " photos"));
  if (nv) bits.push(nv + (nv === 1 ? " video" : " videos"));
  return bits.length ? bits.join(" · ") + " attached in the portal record" : "";
}
function signatureCard(doc, y, rec, meta) {
  const declLines = wrap(rec.declaration || "I confirm that all checks listed above have been carried out and that the sump pump and associated alarm system are in good working order, suitable for continued operation until the next scheduled monthly service.", 8.5, CW - 40, 4);
  const media = mediaLine(rec);
  const h = CARD_PAD + 14 + declLines.length * 11 + (media ? 14 : 0) + 66; cardBox(doc, M, y, CW, h);
  tracked(doc, M + CARD_PAD, y + 18, "Declaration", { size: 6.5, color: ACCENT });
  let yy = y + 32; declLines.forEach(l => { doc.text(M + CARD_PAD, yy, l, { size: 8.5, color: MUTE }); yy += 11; });
  if (media) { doc.text(M + CARD_PAD, yy + 2, media, { size: 7.5, color: FAINT }); yy += 14; }
  const agreed = ansOf(rec.declarationAgreed) === "yes" || rec.declarationAgreed === true;
  pill(doc, M + CARD_PAD, yy + 2, agreed ? "CONFIRMED" : "NOT CONFIRMED", { fill: agreed ? GREEN : RED, size: 6.5, h: 12 });
  // two signature blocks (engineer left-of-centre, store DM right)
  const bw = 200, y2 = y + h - 54;
  const blocks = [
    { x: M + CARD_PAD, sig: meta.engSig, name: rec.engineerName, label: "Engineer" },
    { x: W - M - bw, sig: meta.dmSig, name: rec.dmName, label: "Store manager (DM)" },
  ];
  blocks.forEach(b => {
    if (b.sig) { try { const g = jpegInfo(b.sig); const hh = 30; doc.image(b.sig, b.x, y2 - 6, Math.min(bw, hh * (g.w / g.h)), hh); } catch {} }
    doc.line(b.x, y2 + 30, b.x + bw, y2 + 30, { stroke: BORDER, lw: 0.7 });
    doc.text(b.x, y2 + 42, S(b.name || "—"), { size: 9, bold: true, color: INK });
    tracked(doc, b.x, y2 + 52, b.label, { size: 6, color: FAINT });
  });
  return h;
}

export function buildPumpPdf(record, meta = {}) {
  const rec = record || {}; rec.checks = Array.isArray(rec.checks) ? rec.checks : [];
  const introBottom = 30 + HEADER_H + GAP + instrH(rec) + GAP + safetyH(rec) + GAP;
  const bottomLimit = H - 40;
  const cap = top => Math.max(0, Math.floor((bottomLimit - top - (20 + THEAD_H + 12)) / ROW_H));
  const slimTop = 30 + 40 + GAP;
  const page1Cap = cap(introBottom), laterCap = cap(slimTop);
  const pages = []; pages.push({ start: 0, rows: rec.checks.slice(0, page1Cap), intro: true, top: introBottom });
  let i = page1Cap; while (i < rec.checks.length) { pages.push({ start: i, rows: rec.checks.slice(i, i + laterCap), intro: false, top: slimTop }); i += laterCap; }
  if (!pages.length) pages.push({ start: 0, rows: [], intro: true, top: introBottom });

  // trailing block (details-of-No + declaration/signatures) — does it fit under the last table?
  const last = pages[pages.length - 1];
  const lastBottom = last.top + 20 + THEAD_H + last.rows.length * ROW_H + 12;
  const trailH = (detailsH(rec) ? detailsH(rec) + GAP : 0) + 150;
  const trailOwnPage = lastBottom + GAP + trailH > H - 40;
  const totalPages = pages.length + (trailOwnPage ? 1 : 0);

  const doc = new PdfDoc(W, H);
  pages.forEach((pg, idx) => {
    if (idx > 0) doc.newPage(W, H);
    pageBg(doc);
    if (pg.intro) {
      header(doc, rec, meta, false);
      let yy = 30 + HEADER_H + GAP;
      yy += instrCard(doc, yy, rec) + GAP;
      yy += safetyCard(doc, yy, rec) + GAP;
      checksCard(doc, pg.rows, pg.start, yy, rec.checks.length);
    } else {
      header(doc, rec, meta, true);
      checksCard(doc, pg.rows, pg.start, pg.top, null);
    }
    footer(doc, idx + 1, totalPages);
  });

  let ty;
  if (trailOwnPage) { doc.newPage(W, H); pageBg(doc); header(doc, rec, meta, true); footer(doc, totalPages, totalPages); ty = slimTop; }
  else ty = lastBottom + GAP;
  const dh = detailsCard(doc, ty, rec); if (dh) ty += dh + GAP;
  signatureCard(doc, ty, rec, meta);
  return doc.bytes();
}
