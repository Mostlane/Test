// Battery-supply enquiry PDF — sent to the supplier to price the emergency-lighting
// batteries a failed EM fitting needs. A4 portrait, vector-drawn on lib/pdf.js;
// embeds the engineer's photos (JPEG). Built from em_remedials kind='battery' rows.
import { PdfDoc, textWidth, jpegInfo, toWinAnsi } from "./pdf.js";

const W = 595, H = 842, M = 36;
const NAVY = [0.0, 0.204, 0.408], INK = [0.09, 0.14, 0.22], MUTE = [0.42, 0.48, 0.56];
const HAIR = [0.85, 0.88, 0.92], CARD = [0.972, 0.98, 0.988];
const S = s => toWinAnsi(String(s == null ? "" : s));

function fit(str, size, maxW) {
  let s = S(str);
  if (textWidth(s, size) <= maxW) return s;
  while (s.length > 1 && textWidth(s + "...", size) > maxW) s = s.slice(0, -1);
  return s + "...";
}
function wrapLines(str, size, maxW, maxLines) {
  const words = S(str).split(/\s+/).filter(Boolean); const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textWidth(t, size) <= maxW) cur = t;
    else { if (cur) lines.push(cur); cur = w; if (lines.length >= (maxLines || 6) - 1) break; }
  }
  if (cur && lines.length < (maxLines || 6)) lines.push(cur);
  return lines.length ? lines : [""];
}

function header(doc, meta) {
  doc.rect(0, 0, W, 74, { fill: NAVY });
  if (meta.logo) { try { const g = jpegInfo(meta.logo); const hh = 26; doc.image(meta.logo, M, 24, hh * (g.w / g.h), hh); } catch {} }
  doc.text(W - M, 32, "Battery Supply Enquiry", { size: 17, bold: true, color: [1, 1, 1], alignRight: true });
  doc.text(W - M, 50, "Please quote — emergency lighting batteries", { size: 9.5, color: [0.75, 0.83, 0.92], alignRight: true });
  let y = 92;
  const con = meta.contractor || {};
  const bits = [con.tradingTitle, meta.site ? "Site: " + meta.site : "", meta.certNumber ? "EM cert " + meta.certNumber : ""].filter(Boolean);
  doc.text(M, y, S(bits.join("   ·   ")), { size: 9.5, color: MUTE });
  y += 8;
  doc.line(M, y, W - M, y, { stroke: HAIR, lw: 0.8 });
  return y + 16;
}

function itemBlock(doc, it, idx, y) {
  const photos = (it.photos || []).map(b => { try { return { b, g: jpegInfo(b) }; } catch { return null; } }).filter(Boolean);
  const photoH = photos.length ? 96 : 0;
  const noteLines = it.note ? wrapLines(it.note, 8.5, W - M * 2 - 24, 2) : [];
  const blockH = 26 + 18 + 18 + noteLines.length * 11 + (photoH ? photoH + 12 : 0) + 14;
  if (y + blockH > H - M) { doc.newPage(W, H); y = M + 6; }

  doc.rect(M, y, W - M * 2, blockH, { fill: CARD, stroke: HAIR, lw: 0.8 });
  const px = M + 12; let ty = y + 18;
  doc.text(px, ty, S((idx + 1) + ".  " + (it.ref || "Fitting")), { size: 11, bold: true, color: INK });
  if (it.site) doc.text(W - M - 12, ty, fit(it.site, 8.5, 180), { size: 8.5, color: MUTE, alignRight: true });
  ty += 18;
  doc.text(px, ty, "Battery: ", { size: 9, bold: true, color: [0.3, 0.36, 0.44] });
  doc.text(px + textWidth("Battery: ", 9), ty, fit(it.spec || "(spec to confirm)", 9, W - M * 2 - 120), { size: 9, color: INK });
  doc.text(W - M - 12, ty, "Qty: " + (it.qty || "?"), { size: 9.5, bold: true, color: NAVY, alignRight: true });
  ty += 15;
  noteLines.forEach(l => { doc.text(px, ty, l, { size: 8.5, color: MUTE }); ty += 11; });
  if (photos.length) {
    ty += 4; let cx = px;
    for (const p of photos) {
      const w = Math.min(150, photoH * (p.g.w / p.g.h));
      if (cx + w > W - M - 8) break;
      try { doc.image(p.b, cx, ty, w, photoH); } catch {}
      cx += w + 8;
    }
  }
  return y + blockH + 12;
}

export function buildBatteryEnquiryPdf(items, meta = {}) {
  const doc = new PdfDoc(W, H);
  let y = header(doc, meta);
  (items || []).forEach((it, idx) => { y = itemBlock(doc, it, idx, y); });
  if (!(items || []).length) doc.text(M, y, "No battery items.", { size: 10, color: MUTE });
  return doc.bytes();
}
