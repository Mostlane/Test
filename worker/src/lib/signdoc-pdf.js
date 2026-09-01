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

function wrap(str, size, maxW) {
  const words = String(str == null ? "" : str).split(/\s+/), lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textWidth(t, size) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
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
  for (const ln of wrap(String(docObj.title || "Document"), 20, W)) {
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

  // Body.
  const lines = String(docObj.body || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { y += 8; continue; }
    if (/^---+$/.test(line.trim())) { need(16); doc.hr(L, y, R, { grey: true }); y += 14; continue; }
    if (/^#\s+/.test(line)) {
      const t = line.replace(/^#\s+/, ""); need(24);
      y += 6; for (const ln of wrap(t, 15, W)) { doc.text(L, y, ln, { size: 15, bold: true, color: NAVY }); y += 20; } y += 2; continue;
    }
    if (/^##\s+/.test(line)) {
      const t = line.replace(/^##\s+/, ""); need(20);
      y += 4; for (const ln of wrap(t, 12, W)) { doc.text(L, y, ln, { size: 12, bold: true, color: NAVY }); y += 16; } continue;
    }
    if (/^[-•]\s+/.test(line)) {
      const t = line.replace(/^[-•]\s+/, "");
      const parts = wrap(t, 10.5, W - 16);
      need(parts.length * 15);
      doc.text(L + 4, y, "•", { size: 10.5 });
      for (let i = 0; i < parts.length; i++) { doc.text(L + 16, y, parts[i], { size: 10.5 }); y += 15; }
      y += 2; continue;
    }
    const parts = wrap(line, 10.5, W);
    need(parts.length * 15);
    for (const ln of parts) { doc.text(L, y, ln, { size: 10.5 }); y += 15; }
    y += 5;
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
