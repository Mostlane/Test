// Builds the "Record of Installation Activities Form — Fire Stopping
// Installation" (RIA) PDF from a job's firestopping record. Pure + synchronous:
// the caller fetches photo/signature/logo bytes from R2 and passes them in as
// baseline-JPEG Uint8Arrays (lib/pdf.js embeds JPEG via DCTDecode).
//
//   buildFirestopPdf(record, { logo }) -> Uint8Array
//
// record = {
//   ref, dateOfIssue, sealCategory, declaration, company, installer,
//   siteAddress, signature:Uint8Array|null,
//   seals: [{ sealRef, date, by, location, aperture, frp, manufacturer,
//             componentName, comments,
//             beforePhotos:[Uint8Array], afterPhotos:[Uint8Array] }]
// }

import { PdfDoc, textWidth, jpegInfo } from "./pdf.js";

const M = 40;                 // page margin
const PAGE_W = 595, PAGE_H = 842;
const CONTENT_W = PAGE_W - M * 2;
const BLUE = [0.0, 0.23, 0.40];
const GREY = [0.45, 0.45, 0.45];
const LINE = [0.80, 0.82, 0.86];

// Wrap a string to a pixel width at a font size → array of lines.
function wrap(str, size, maxW) {
  const words = String(str == null ? "" : str).replace(/\r/g, "").split(/\n/);
  const out = [];
  for (const para of words) {
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

export function buildFirestopPdf(record, meta = {}) {
  const doc = new PdfDoc();
  let y = M;

  const ensure = (need) => {
    if (y + need > PAGE_H - M) { doc.newPage(); y = M; }
  };
  const label = (x, yy, s) => doc.text(x, yy, s, { size: 7.5, bold: true, color: GREY });
  const val = (x, yy, s, opt = {}) => doc.text(x, yy, s || "—", Object.assign({ size: 9.5 }, opt));

  // ── Header ────────────────────────────────────────────────────────────────
  if (meta.logo) {
    try { const d = jpegInfo(meta.logo); const h = 30; doc.image(meta.logo, M, y, h * (d.w / d.h), h); } catch {}
  }
  doc.text(M + 130, y + 12, "Record of Installation Activities Form", { size: 13, bold: true, color: BLUE });
  doc.text(M + 130, y + 26, "Fire Stopping Installation", { size: 10, color: GREY });
  y += 46;
  doc.line(M, y, PAGE_W - M, y, { stroke: LINE }); y += 12;

  // Header field grid (two columns).
  const colW = CONTENT_W / 2;
  const hdr = [
    ["RIA form sequential reference number", record.ref],
    ["Date of issue", record.dateOfIssue],
    ["Company name", record.company],
    ["Installed by", record.installer],
    ["Site address", record.siteAddress],
    ["Seal category", record.sealCategory],
  ];
  for (let i = 0; i < hdr.length; i += 2) {
    ensure(30);
    const rows = [hdr[i], hdr[i + 1]].filter(Boolean);
    let rowH = 0;
    rows.forEach((pair, c) => {
      const x = M + c * colW;
      label(x, y + 8, pair[0]);
      const lines = wrap(pair[1] || "—", 9.5, colW - 14);
      lines.forEach((ln, li) => val(x, y + 20 + li * 12, ln));
      rowH = Math.max(rowH, 20 + lines.length * 12);
    });
    y += rowH + 6;
  }

  // ── Declaration ─────────────────────────────────────────────────────────────
  ensure(70);
  y += 4;
  doc.text(M, y + 9, "Declaration", { size: 10, bold: true, color: BLUE }); y += 16;
  const decl = record.declaration ||
    "I declare that the work undertaken fully complies with the manufacturers guidance for all products installed. " +
    "All materials used are correctly installed in accordance with training and to a good standard. Local " +
    "identification labelling installed to each penetration seal.";
  wrap(decl, 9, CONTENT_W).forEach(ln => { ensure(14); doc.text(M, y + 9, ln, { size: 9 }); y += 12; });
  y += 6;
  label(M, y + 8, "SIGNATURE");
  if (record.signature) {
    try { const d = jpegInfo(record.signature); const h = 34; doc.image(record.signature, M, y + 12, Math.min(150, h * (d.w / d.h)), h); y += 50; }
    catch { y += 20; }
  } else { doc.line(M + 60, y + 8, M + 220, y + 8, { stroke: LINE }); y += 20; }

  // ── Seals ───────────────────────────────────────────────────────────────────
  y += 8; ensure(20);
  doc.text(M, y + 10, "Information of the installed fire stopping products", { size: 10, bold: true, color: BLUE }); y += 22;

  const seals = Array.isArray(record.seals) ? record.seals : [];
  if (!seals.length) { doc.text(M, y + 10, "No seals recorded.", { size: 9, color: GREY }); }

  seals.forEach((s, idx) => {
    // Estimate block height: field lines + a photo row.
    const fieldPairs = [
      ["Installation / Seal Ref", s.sealRef],
      ["Date", s.date], ["By", s.by],
      ["Location & aperture size", [s.location, s.aperture].filter(Boolean).join("  ·  ")],
      ["Intended fire resistance period", s.frp],
      ["Fire stopping component manufacturer", s.manufacturer],
      ["Fire stopping component name", s.componentName],
      ["Comments", s.comments],
    ];
    const photoH = 74;
    ensure(150);
    const blockTop = y;
    doc.text(M, y + 11, `Seal ${idx + 1}` + (s.sealRef ? " — " + s.sealRef : ""), { size: 9.5, bold: true });
    y += 20;

    // Two-column field grid.
    for (let i = 0; i < fieldPairs.length; i += 2) {
      const rows = [fieldPairs[i], fieldPairs[i + 1]].filter(Boolean);
      let rowH = 0;
      ensure(26);
      rows.forEach((pair, c) => {
        const x = M + c * colW;
        label(x, y + 7, pair[0]);
        const lines = wrap(pair[1] || "—", 9, colW - 14);
        lines.forEach((ln, li) => doc.text(x, y + 18 + li * 11, ln, { size: 9 }));
        rowH = Math.max(rowH, 18 + lines.length * 11);
      });
      y += rowH + 3;
    }

    // Photo rows (before / after).
    const drawPhotos = (title, arr) => {
      if (!arr || !arr.length) return;
      ensure(photoH + 18);
      label(M, y + 8, title); y += 12;
      let x = M;
      for (const bytes of arr) {
        let w = 96;
        try { const d = jpegInfo(bytes); w = Math.min(120, photoH * (d.w / d.h)); } catch {}
        if (x + w > PAGE_W - M) { y += photoH + 6; x = M; ensure(photoH + 6); }
        try { doc.image(bytes, x, y, w, photoH); } catch {}
        doc.rect(x, y, w, photoH, { stroke: LINE, lw: 0.5 });
        x += w + 6;
      }
      y += photoH + 8;
    };
    drawPhotos("PICTURES BEFORE", s.beforePhotos);
    drawPhotos("PICTURES AFTER", s.afterPhotos);

    // Block border + spacer.
    doc.rect(M - 6, blockTop - 4, CONTENT_W + 12, (y - blockTop) + 8, { stroke: LINE, lw: 0.6 });
    y += 14;
  });

  // Footer page numbers.
  const n = doc.pages.length;
  for (let i = 0; i < n; i++) {
    const pg = doc.pages[i];
    pg.ops.push(`0.45 g BT /F1 8 Tf 1 0 0 1 ${PAGE_W - M - 60} ${M / 2} Tm (Page ${i + 1} of ${n}) Tj ET 0 g`);
  }
  return doc.bytes();
}
