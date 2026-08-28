// Builds a downloadable "Job Sheet" PDF for an SLA job — a real vector PDF made
// server-side, so it downloads as a proper file on any device (unlike the
// browser print-to-PDF page, which iOS only lets you Print). Photos are passed
// in as baseline-JPEG Uint8Arrays (the small thumbnails), which lib/pdf.js
// embeds via DCTDecode — that keeps the file small and the layout clean.
//
// The drawn customer signature is stored as a PNG, and lib/pdf.js embeds JPEG
// only, so the sign-off is rendered as a clear text block (who + when). The
// on-screen / print sheet still shows the drawn image.
//
//   buildJobSheetPdf(data, { logo }) -> Uint8Array
//
// data = {
//   jobNo, title, subtitle, copyType ("mostlane"|"client"),
//   details: [[label, value], ...],
//   description,
//   sla:  { met:boolean, target } | null,
//   time: { travelling, onsite, total } | null,   (pre-formatted strings)
//   timeline: [{ status, at, by }],
//   notes:    [{ note, by, at }],
//   photos:   [{ bytes:Uint8Array, stage }],
//   signature:{ signedBy, signedAt } | null,
// }

import { PdfDoc, textWidth, jpegInfo } from "./pdf.js";

const M = 40;
const PAGE_W = 595, PAGE_H = 842;
const CONTENT_W = PAGE_W - M * 2;
const BLUE = [0.0, 0.23, 0.51];
const GREY = [0.45, 0.45, 0.45];
const LINE = [0.80, 0.82, 0.86];
const OK = [0.09, 0.55, 0.24];
const BAD = [0.78, 0.11, 0.15];

function wrap(str, size, maxW) {
  const paras = String(str == null ? "" : str).replace(/\r/g, "").split(/\n/);
  const out = [];
  for (const para of paras) {
    const w = para.split(/\s+/).filter(Boolean);
    if (!w.length) { out.push(""); continue; }
    let line = w[0];
    for (let i = 1; i < w.length; i++) {
      if (textWidth(line + " " + w[i], size) <= maxW) line += " " + w[i];
      else { out.push(line); line = w[i]; }
    }
    out.push(line);
  }
  return out;
}

export function buildJobSheetPdf(data = {}, meta = {}) {
  const doc = new PdfDoc();
  let y = M;

  const ensure = (need) => { if (y + need > PAGE_H - M) { doc.newPage(); y = M; } };
  const label = (x, yy, s) => doc.text(x, yy, s, { size: 7.5, bold: true, color: GREY });
  const heading = (s) => {
    ensure(26); y += 6;
    doc.text(M, y + 9, s, { size: 10.5, bold: true, color: BLUE });
    y += 15; doc.line(M, y, PAGE_W - M, y, { stroke: LINE }); y += 8;
  };

  // ── Header ──────────────────────────────────────────────────────────────
  const logoH = 44;
  if (meta.logo) {
    try { const d = jpegInfo(meta.logo); doc.image(meta.logo, M, y, logoH * (d.w / d.h), logoH); } catch {}
  }
  // "Job Sheet" centred across the page.
  doc.text((PAGE_W - textWidth("Job Sheet", 18)) / 2, y + 18, "Job Sheet", { size: 18, bold: true, color: BLUE });
  if (data.showJobNo !== false) {
    const jn = "Job " + (data.jobNo || "—");
    doc.text((PAGE_W - textWidth(jn, 9.5)) / 2, y + 33, jn, { size: 9.5, color: GREY });
  }
  const copyTxt = data.copyType === "client" ? "Client copy" : "Mostlane copy";
  doc.text(PAGE_W - M - textWidth(copyTxt, 8.5), y + 12, copyTxt, { size: 8.5, color: GREY });
  y += logoH + 6;
  doc.line(M, y, PAGE_W - M, y, { stroke: LINE }); y += 13;

  // Site name (bold) with the date on the same line, right-aligned.
  if (data.title) {
    doc.text(M, y, data.title, { size: 13, bold: true });
    if (data.subtitle) doc.text(PAGE_W - M - textWidth(data.subtitle, 9), y, data.subtitle, { size: 9, color: GREY });
    y += 10;
  }

  // ── Details grid (two columns, compact) ─────────────────────────────────
  const colW = CONTENT_W / 2;
  const RH = 10.5;   // value line height
  const details = (data.details || []).filter(p => p && p[1] != null && String(p[1]).trim() !== "");
  for (let i = 0; i < details.length; i += 2) {
    const rows = [details[i], details[i + 1]].filter(Boolean);
    let rowH = 0;
    ensure(24);
    rows.forEach((pair, c) => {
      const x = M + c * colW;
      label(x, y + 7, String(pair[0]).toUpperCase());
      const lines = wrap(pair[1], 9, colW - 12);
      lines.forEach((ln, li) => doc.text(x, y + 17 + li * RH, ln, { size: 9 }));
      rowH = Math.max(rowH, 17 + lines.length * RH);
    });
    y += rowH + 2;
  }
  // Site address — full width, each part stacked on its own line.
  if (data.siteAddress) {
    const parts = String(data.siteAddress).split(",").map(s => s.trim()).filter(Boolean);
    ensure(17 + parts.length * RH);
    label(M, y + 7, "SITE ADDRESS");
    parts.forEach((ln, li) => doc.text(M, y + 17 + li * RH, ln, { size: 9 }));
    y += 17 + parts.length * RH + 2;
  }

  // ── Description ─────────────────────────────────────────────────────────
  if (data.description) {
    heading("Description");
    wrap(data.description, 9.5, CONTENT_W).forEach(ln => { ensure(14); doc.text(M, y + 9, ln, { size: 9.5 }); y += 12; });
  }

  // ── SLA ─────────────────────────────────────────────────────────────────
  if (data.sla) {
    heading("SLA");
    ensure(18);
    const pill = data.sla.met ? "SLA achieved" : "SLA not achieved";
    doc.text(M, y + 9, pill, { size: 9.5, bold: true, color: data.sla.met ? OK : BAD });
    if (data.sla.target) doc.text(M + textWidth(pill, 9.5) + 16, y + 9, "Target: " + data.sla.target, { size: 9, color: GREY });
    y += 16;
  }

  // ── Time on job ─────────────────────────────────────────────────────────
  if (data.time && data.time.total) {
    heading("Time on job");
    ensure(18);
    const parts = [];
    if (data.time.travelling) parts.push(["Travelling", data.time.travelling]);
    if (data.time.onsite) parts.push(["On site", data.time.onsite]);
    parts.push(["Total", data.time.total]);
    let x = M;
    parts.forEach(([k, v]) => {
      const seg = k + ": " + v;
      doc.text(x, y + 9, k + ": ", { size: 9, color: GREY });
      doc.text(x + textWidth(k + ": ", 9), y + 9, v, { size: 9.5, bold: true });
      x += textWidth(seg, 9.5) + 20;
    });
    y += 16;
  }

  // ── Timeline ────────────────────────────────────────────────────────────
  if (data.timeline && data.timeline.length) {
    heading("Activity");
    data.timeline.forEach(e => {
      ensure(13);
      doc.text(M, y + 9, String(e.status || ""), { size: 9, bold: true });
      const meta2 = "— " + (e.at || "") + (e.by ? " · " + e.by : "");
      doc.text(M + 120, y + 9, meta2, { size: 8.5, color: GREY });
      y += 12;
    });
  }

  // ── Notes ───────────────────────────────────────────────────────────────
  if (data.notes && data.notes.length) {
    heading("Notes");
    data.notes.forEach(n => {
      wrap(n.note || "", 9.5, CONTENT_W).forEach(ln => { ensure(13); doc.text(M, y + 9, ln, { size: 9.5 }); y += 12; });
      ensure(12);
      doc.text(M, y + 8, (n.by || "Engineer") + (n.at ? " · " + n.at : ""), { size: 8, color: GREY });
      y += 14;
    });
  }

  // ── Risk assessment ─────────────────────────────────────────────────────
  if (data.ra) {
    const r = data.ra;
    heading("Risk assessment");
    if (r.skipped) {
      ensure(16);
      doc.text(M, y + 10, "Skipped (Full-Access override)" + (r.by ? " - " + r.by : ""), { size: 9.5, color: BAD });
      y += 16;
    } else {
      // Two-column checklist: hazard on the left, an aligned OK / REVIEW tag on
      // the right of each column.
      const haz = r.hazards || [];
      const cw = CONTENT_W / 2;
      for (let i = 0; i < haz.length; i += 2) {
        const pair = [haz[i], haz[i + 1]].filter(Boolean);
        ensure(14);
        pair.forEach((h, c) => {
          const x = M + c * cw;
          const tag = h.ok ? "OK" : "REVIEW";
          const tw = textWidth(tag, 8);
          let item = String(h.item || "");
          const maxW = cw - tw - 22;
          while (textWidth(item, 9) > maxW && item.length > 4) item = item.slice(0, -2);
          doc.text(x, y + 9, item, { size: 9 });
          doc.text(x + cw - tw - 12, y + 9, tag, { size: 8, bold: true, color: h.ok ? OK : BAD });
        });
        y += 13;
      }
      y += 3; ensure(14);
      doc.text(M, y + 9, "Safe to proceed: ", { size: 9.5, color: GREY });
      doc.text(M + textWidth("Safe to proceed: ", 9.5), y + 9, r.safe ? "Yes" : "No",
        { size: 9.5, bold: true, color: r.safe ? OK : BAD });
      y += 15;
      if (r.notes) wrap(r.notes, 9, CONTENT_W).forEach(ln => { ensure(12); doc.text(M, y + 9, ln, { size: 9 }); y += 11; });
      if (r.by) { ensure(12); doc.text(M, y + 8, "Assessed by " + r.by + (r.at ? " · " + r.at : ""), { size: 8, color: GREY }); y += 12; }
    }
  }

  // ── Photos (3-up grid) ──────────────────────────────────────────────────
  const photos = (data.photos || []).filter(p => p && p.bytes);
  if (photos.length) {
    heading("Photos");
    const cols = 3, gap = 8;
    const cellW = (CONTENT_W - gap * (cols - 1)) / cols;
    const cellH = cellW * 0.72;
    let col = 0, rowTop = y;
    photos.forEach((p, i) => {
      if (col === 0) { ensure(cellH + 16); rowTop = y; }
      const x = M + col * (cellW + gap);
      // Fit the image inside the cell, centred, preserving aspect.
      let iw = cellW, ih = cellH;
      try { const d = jpegInfo(p.bytes); const r = d.w / d.h; if (r > cellW / cellH) { iw = cellW; ih = cellW / r; } else { ih = cellH; iw = cellH * r; } } catch {}
      const ix = x + (cellW - iw) / 2, iy = rowTop + (cellH - ih) / 2;
      try { doc.image(p.bytes, ix, iy, iw, ih); } catch {}
      doc.rect(x, rowTop, cellW, cellH, { stroke: LINE, lw: 0.5 });
      if (p.stage) doc.text(x + 3, rowTop + cellH + 9, p.stage, { size: 7.5, color: GREY });
      col++;
      if (col >= cols) { col = 0; y = rowTop + cellH + 16; }
    });
    if (col !== 0) y = rowTop + cellH + 16;
  }

  // ── Sign-off ────────────────────────────────────────────────────────────
  if (data.showSignoff !== false) {
  heading("Sign-off");
  const sig = data.signature;
  if (sig && sig.signedBy) {
    const img = sig.image;  // { rgb, width, height } — the decoded drawn signature
    const sigH = 44, sigMaxW = 200;
    ensure((img ? sigH + 8 : 0) + 40);
    if (img && img.rgb && img.width && img.height) {
      let w = sigH * (img.width / img.height);
      if (w > sigMaxW) w = sigMaxW;
      const h = w * (img.height / img.width);
      try { doc.imageRGB(img.rgb, img.width, img.height, M, y, w, h); } catch {}
      doc.line(M, y + h + 2, M + Math.max(w, 120), y + h + 2, { stroke: LINE });
      y += h + 8;
    }
    doc.text(M, y + 10, "Signed by ", { size: 9, color: GREY });
    doc.text(M + textWidth("Signed by ", 9), y + 10, sig.signedBy, { size: 10, bold: true });
    if (sig.signedAt) doc.text(M, y + 24, sig.signedAt, { size: 9, color: GREY });
    y += 30;
  } else {
    ensure(24);
    doc.text(M, y + 11, "Not signed.", { size: 9.5, color: GREY });
    y += 20;
  }
  }

  // Footer page numbers.
  const n = doc.pages.length;
  for (let i = 0; i < n; i++) {
    const pg = doc.pages[i];
    pg.ops.push(`0.45 g BT /F1 8 Tf 1 0 0 1 ${PAGE_W - M - 70} ${M / 2} Tm (Page ${i + 1} of ${n}) Tj ET 0 g`);
    pg.ops.push(`0.45 g BT /F1 8 Tf 1 0 0 1 ${M} ${M / 2} Tm (Mostlane ${copyTxt}) Tj ET 0 g`);
  }
  return doc.bytes();
}
