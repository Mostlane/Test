// Shared branded PDF renderer for portal "Signable Documents".
// ONE house style for every document so they all look the same (the Mostlane
// Annual Leave policy is the reference): logo top-left of page 1, a
// "COMPANY CONFIDENTIAL" running header, a "Document ID / Page X of Y" footer,
// the document body, then a signature block carrying BOTH signatures —
// the issuer's (auto-applied on send) and the signer's (drawn on signing) —
// with dates and an IP/device audit line.
//
//   buildSignDocPdf({ ref, title, body }, {
//     issuerName, issuerDateISO, issuerSigJpeg,      // Uint8Array | null
//     signerName, signedAtISO, signerSigJpeg,        // Uint8Array | null (null = unsigned preview)
//     signerIp, signerUa,
//   }) -> Uint8Array
//
// Body markup (plain text, one construct per line):
//   # Heading            -> H1
//   ## Heading           -> H2
//   - item   / • item    -> bullet
//   ---                  -> horizontal rule
//   (blank line)         -> paragraph gap
//   anything else        -> paragraph (wrapped)

import { PdfDoc, textWidth } from "./pdf.js";
import { logoBytes, MOSTLANE_LOGO_W, MOSTLANE_LOGO_H } from "./logo.js";

const L = 56, R = 539, W = R - L;
const NAVY = [0, 0.20, 0.41];       // #003468
const TOP = 92;                      // first body baseline (below the header)
const BOTTOM = 772;                  // break before the footer zone

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function fmtDate(iso) {
  try { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
  catch { return String(iso || ""); }
}
function fmtWhen(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
  } catch { return String(iso || ""); }
}

function wrap(str, size, maxW, bold) {
  const words = String(str == null ? "" : str).split(/\s+/), lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textWidth(t, size, !!bold) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// ── Inline **bold** support ─────────────────────────────────────────────────
// Split a string on ** markers into styled words. Returns a flat word list
// [{w, bold}] (spaces dropped; the drawer re-inserts single spaces).
function boldWords(str) {
  const out = [];
  String(str == null ? "" : str).split("**").forEach((chunk, i) => {
    const bold = i % 2 === 1;
    chunk.split(/\s+/).forEach((w) => { if (w !== "") out.push({ w, bold }); });
  });
  return out;
}
// Greedy word-wrap over styled words. Returns lines, each an array of {w,bold}.
// `force` = a style applied to every word (e.g. a bold heading) so widths are
// measured in the SAME font the word is drawn in — bold glyphs are wider.
function wrapWords(words, size, maxW, force) {
  const lines = []; let cur = [], curW = 0; const sp = textWidth(" ", size);
  for (const tok of words) {
    const ww = textWidth(tok.w, size, !!(force || tok.bold));
    const add = cur.length ? sp + ww : ww;
    if (cur.length && curW + add > maxW) { lines.push(cur); cur = [tok]; curW = ww; }
    else { cur.push(tok); curW += add; }
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [[]];
}

export function buildSignDocPdf(docObj = {}, sig = {}) {
  const doc = new PdfDoc();
  const ref = String(docObj.ref || "");
  let y = 44;

  // Logo, page 1 only.
  try {
    const lw = 150, lh = lw * (MOSTLANE_LOGO_H / MOSTLANE_LOGO_W);
    doc.image(logoBytes(), L, y, lw, lh);
    y += lh + 14;
  } catch { y = 96; }

  // Title.
  for (const ln of wrap(String(docObj.title || "Document"), 20, W, true)) {
    doc.text(L, y, ln, { size: 20, bold: true, color: NAVY }); y += 26;
  }
  y += 2;
  if (sig.issuerName || sig.issuerDateISO) {
    doc.text(L, y, `Issued by: ${sig.issuerName || ""}${sig.issuerDateISO ? "   ·   " + fmtDate(sig.issuerDateISO) : ""}`, { size: 10, grey: true });
    y += 16;
  }
  if (ref) { doc.text(L, y, "Document ID: " + ref, { size: 9.5, grey: true }); y += 14; }
  y += 4; doc.hr(L, y, R, { w: 1 }); y += 22;

  const need = (h) => { if (y + h > BOTTOM) { doc.newPage(); y = TOP; } };

  // Draw one wrapped, possibly-bold block of text at indent `x`. Honours a
  // forced style (heading colour) applied to every run.
  function emitWords(x, text, size, opt = {}, lh) {
    lh = lh || size + 4.5;
    const lines = wrapWords(boldWords(text), size, R - x, opt.bold);
    for (const ln of lines) {
      need(lh);
      let tx = x;
      for (let i = 0; i < ln.length; i++) {
        const tok = ln[i];
        const b = opt.bold || tok.bold;
        doc.text(tx, y, tok.w, { size, bold: b, color: opt.color, grey: opt.grey });
        tx += textWidth(tok.w, size, b) + textWidth(" ", size);
      }
      y += lh;
    }
  }

  // A bordered table. `rows` = array of arrays of cell strings; row 0 is the
  // header (bold). Equal column widths; page-break repeats the header.
  function emitTable(rows) {
    if (!rows.length) return;
    const ncol = Math.max(...rows.map((r) => r.length));
    const colW = W / ncol, pad = 5, csize = 9.5, clh = 13;
    const drawRow = (cells, header) => {
      const wrapped = [];
      let maxLines = 1;
      for (let c = 0; c < ncol; c++) {
        const w = wrapWords(boldWords(cells[c] || ""), csize, colW - pad * 2, header);
        wrapped.push(w); if (w.length > maxLines) maxLines = w.length;
      }
      const rh = maxLines * clh + pad * 2;
      need(rh);
      for (let c = 0; c < ncol; c++) {
        const cx = L + c * colW;
        doc.rect(cx, y, colW, rh, { stroke: [0.6, 0.65, 0.7], lw: 0.5 });
        let ty = y + pad + csize;
        for (const ln of wrapped[c]) {
          let tx = cx + pad;
          for (const tok of ln) {
            const b = header || tok.bold;
            doc.text(tx, ty, tok.w, { size: csize, bold: b });
            tx += textWidth(tok.w, csize, b) + textWidth(" ", csize);
          }
          ty += clh;
        }
      }
      y += rh;
    };
    drawRow(rows[0], true);
    for (let i = 1; i < rows.length; i++) drawRow(rows[i], false);
    y += 8;
  }

  // Body.
  const lines = String(docObj.body || "").split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\s+$/, "");
    if (!line.trim()) { y += 8; continue; }
    // Pipe table: gather consecutive "| … |" lines, drop a |---| separator row.
    if (/^\|.*\|$/.test(line.trim())) {
      const rows = [];
      while (li < lines.length && /^\s*\|.*\|\s*$/.test(lines[li])) {
        const cells = lines[li].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c) || c === "")) rows.push(cells);
        li++;
      }
      li--;
      need(24); emitTable(rows); continue;
    }
    if (/^---+$/.test(line.trim())) { need(16); doc.hr(L, y, R, { grey: true }); y += 14; continue; }
    if (/^#\s+/.test(line)) { need(26); y += 6; emitWords(L, line.replace(/^#\s+/, ""), 15, { bold: true, color: NAVY }, 20); y += 2; continue; }
    if (/^##\s+/.test(line)) { need(20); y += 4; emitWords(L, line.replace(/^##\s+/, ""), 12, { bold: true, color: NAVY }, 16); continue; }
    if (/^[-•]\s+/.test(line)) {
      const parts = wrapWords(boldWords(line.replace(/^[-•]\s+/, "")), 10.5, W - 16);
      need(parts.length * 15);
      doc.text(L + 4, y, "•", { size: 10.5 });
      for (const ln of parts) {
        let tx = L + 16;
        for (const tok of ln) { doc.text(tx, y, tok.w, { size: 10.5, bold: tok.bold }); tx += textWidth(tok.w, 10.5, tok.bold) + textWidth(" ", 10.5); }
        y += 15;
      }
      y += 2; continue;
    }
    emitWords(L, line, 10.5, {}, 15); y += 5;
  }

  // ── Signature block ────────────────────────────────────────────────────────
  y += 12; need(200);
  doc.hr(L, y, R, { grey: true }); y += 20;
  doc.text(L, y, "Signatures", { size: 13, bold: true, color: NAVY }); y += 22;

  const block = (label, name, sigJpeg, whenLine, extra) => {
    need(110);
    doc.text(L, y, label, { size: 10.5, bold: true }); y += 6;
    let drew = false;
    if (sigJpeg && sigJpeg.length) {
      try {
        // Scale the drawn signature to a max box, keeping aspect ratio.
        // (Ratio unknown without decode; assume a wide pad ~ 320x180.)
        let sw = 170, sh = 56;
        need(sh + 30);
        doc.image(sigJpeg, L, y + 4, sw, sh); y += sh + 6; drew = true;
      } catch { /* fall through to a signed line */ }
    }
    if (!drew) { y += 30; }
    doc.hr(L, y, L + 200, { grey: true }); y += 14;
    doc.text(L, y, name || "", { size: 10.5, bold: true }); y += 15;
    if (whenLine) { doc.text(L, y, whenLine, { size: 10 }); y += 14; }
    if (extra) { for (const e of extra) { if (e) { doc.text(L, y, e, { size: 8.5, grey: true }); y += 12; } } }
    y += 12;
  };

  block("Issued and signed by (Mostlane):", sig.issuerName, sig.issuerSigJpeg,
        sig.issuerDateISO ? "Issued: " + fmtDate(sig.issuerDateISO) : "", null);

  if (sig.signedAtISO) {
    block("Signed by the recipient:", sig.signerName, sig.signerSigJpeg,
          "Signed: " + fmtWhen(sig.signedAtISO),
          [sig.signerIp ? "IP address: " + sig.signerIp : "",
           sig.signerUa ? "Device: " + String(sig.signerUa).slice(0, 90) : "",
           "Signed electronically via the Mostlane Portal."]);
  } else {
    need(40);
    doc.text(L, y, "Awaiting recipient signature.", { size: 10, grey: true }); y += 16;
  }

  // ── Header + footer on EVERY page (stamped now that page count is known) ────
  const total = doc.pages.length;
  const mid = (L + R) / 2;
  for (let i = 0; i < total; i++) {
    doc.textOn(i, mid, 38, "COMPANY CONFIDENTIAL", { size: 8, grey: true, center: true });
    doc.lineOn(i, L, 48, R, { grey: true });
    doc.lineOn(i, L, 806, R, { grey: true });
    doc.textOn(i, L, 820, "Mostlane Construction Ltd" + (ref ? "   ·   Document ID: " + ref : ""), { size: 8, grey: true });
    doc.textOn(i, R, 820, `Page ${i + 1} of ${total}`, { size: 8, grey: true, alignRight: true });
  }

  return doc.bytes();
}
