// Minimal PDF writer — enough for clean, single/multi-page A4 text documents
// (the self-employed engineer invoices). No external services or libraries:
// standard base-14 Helvetica fonts, WinAnsi encoding (so £ works), text +
// horizontal rules only. Coordinates are given from the TOP of the page in
// points (A4 = 595 × 842) and converted internally.
//
//   const doc = new PdfDoc();
//   doc.text(48, 60, "INVOICE", { size: 20, bold: true });
//   doc.text(547, 90, "£1,234.50", { size: 10, alignRight: true });
//   doc.hr(48, 100, 547);
//   const bytes = doc.bytes();   // Uint8Array (application/pdf)

const PAGE_W = 595, PAGE_H = 842;

// Helvetica advance widths (per 1000 units) — exact for the characters that
// matter for right-aligning money/number columns; a sane average otherwise.
const W = {
  " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 278, ";": 278, "=": 584, "?": 556, "@": 1015,
  "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778, "H": 722,
  "I": 278, "J": 500, "K": 667, "L": 556, "M": 833, "N": 722, "O": 778, "P": 667,
  "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667, "W": 944, "X": 667,
  "Y": 667, "Z": 611, "a": 556, "b": 556, "c": 500, "d": 556, "e": 556, "f": 278,
  "g": 556, "h": 556, "i": 222, "j": 222, "k": 500, "l": 222, "m": 833, "n": 556,
  "o": 556, "p": 556, "q": 556, "r": 333, "s": 500, "t": 278, "u": 556, "v": 500,
  "w": 722, "x": 500, "y": 500, "z": 500, "£": 556, "·": 278, "–": 556, "—": 1000,
};

// Characters WinAnsi DOES have, but above the Latin-1 range (Windows-1252's
// 0x80–0x9F block). Without this an en-dash or an ellipsis came out as "?".
const WIN1252 = {
  "\u20AC": 0x80, "\u201A": 0x82, "\u0192": 0x83, "\u201E": 0x84, "\u2026": 0x85,
  "\u2020": 0x86, "\u2021": 0x87, "\u02C6": 0x88, "\u2030": 0x89, "\u0160": 0x8A,
  "\u2039": 0x8B, "\u0152": 0x8C, "\u017D": 0x8E, "\u2018": 0x91, "\u2019": 0x92,
  "\u201C": 0x93, "\u201D": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
  "\u02DC": 0x98, "\u2122": 0x99, "\u0161": 0x9A, "\u203A": 0x9B, "\u0153": 0x9C,
  "\u017E": 0x9E, "\u0178": 0x9F,
};
// No WinAnsi glyph exists for these, so spell them in ASCII rather than print a
// "?" in a document that goes to a client. (An arrow in a date range was doing
// exactly that.) Applied before encoding, so widths measure the real output.
const ASCIIFY = {
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21D2": "=>", "\u21D0": "<=",
  "\u2212": "-", "\u2011": "-", "\u2012": "-", "\u2015": "-", "\u2044": "/",
  "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u2248": "~",
  "\u2713": "v", "\u2714": "v", "\u2715": "x", "\u2717": "x", "\u221A": "v",
  "\u00A0": " ", "\u2009": " ", "\u202F": " ", "\u200B": "",
};
// Fold a string to what the base-14 WinAnsi fonts can actually draw. Anything
// still unrepresentable (emoji, CJK…) is DROPPED rather than turned into "?" —
// a missing glyph reads as a typo; a stray "?" reads as a broken document.
export function toWinAnsi(s) {
  let out = "";
  for (const ch of String(s == null ? "" : s)) {
    if (ASCIIFY[ch] != null) { out += ASCIIFY[ch]; continue; }
    if (WIN1252[ch] != null || ch.charCodeAt(0) <= 255) { out += ch; continue; }
    // unmappable → drop
  }
  return out;
}

export function textWidth(str, size = 10) {
  let u = 0;
  // Measure what will actually be DRAWN — toWinAnsi can change the length
  // (an arrow becomes "->"), so measuring the raw string would misjudge fits.
  for (const ch of toWinAnsi(str)) u += W[ch] != null ? W[ch] : 556;
  return (u / 1000) * size;
}

// Escape a JS string into a PDF literal string using WinAnsi bytes.
function pdfStr(s) {
  let out = "";
  for (const ch of toWinAnsi(s)) {
    let c = WIN1252[ch] != null ? WIN1252[ch] : ch.charCodeAt(0);
    if (c === 92) out += "\\\\";
    else if (c === 40) out += "\\(";
    else if (c === 41) out += "\\)";
    else if (c >= 32 && c <= 126) out += String.fromCharCode(c);
    else out += "\\" + c.toString(8).padStart(3, "0"); // e.g. £ = \243
  }
  return out;
}

// Read a baseline/progressive JPEG's intrinsic size + colour components from its
// SOF marker — enough to build the image XObject dictionary.
export function jpegInfo(bytes) {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0..SOF15 (baseline / progressive / etc.) carry the frame header.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6];
      const w = (bytes[i + 7] << 8) | bytes[i + 8];
      const comps = bytes[i + 9];
      return { w, h, comps };
    }
    i += 2 + len;
  }
  return { w: 1, h: 1, comps: 3 };
}

export class PdfDoc {
  // Pages default to A4 (595×842) but any page may carry its own size —
  // newPage(w, h) — e.g. the continuous single-tall-page RA copies.
  constructor(w, h) { this.pages = []; this.images = []; this.newPage(w, h); }
  newPage(w, h) { this.pages.push({ ops: [], w: w || PAGE_W, h: h || PAGE_H }); return this; }
  get _page() { return this.pages[this.pages.length - 1]; }
  get _ops() { return this._page.ops; }

  // Draw a JPEG image. (x, yTop) = top-left corner from the page top; w/h in pt.
  // Bytes must be a baseline JPEG (DCTDecode). Registers one XObject reused across
  // pages by index.
  image(bytes, x, yTop, w, h) {
    const idx = this.images.length;
    this.images.push({ jpeg: bytes });
    const y = this._page.h - yTop - h;   // PDF origin is bottom-left
    this._ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${idx} Do Q`);
    return this;
  }

  // Draw a RAW 8-bit DeviceRGB image (uncompressed samples, `iw`×`ih` pixels,
  // 3 bytes/pixel). Used to embed a signature PNG the caller has already decoded
  // (lib/pdf.js only decodes JPEG). (x, yTop) = top-left; w/h in pt.
  imageRGB(rgb, iw, ih, x, yTop, w, h) {
    const idx = this.images.length;
    this.images.push({ rgb, w: iw, h: ih });
    const y = this._page.h - yTop - h;
    this._ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${idx} Do Q`);
    return this;
  }

  // yTop is measured from the top of the page to the text BASELINE.
  text(x, yTop, str, opt = {}) {
    const size = opt.size || 10;
    const font = opt.bold ? "/F2" : "/F1";
    const col = opt.color ? `${opt.color.map(n => n.toFixed(3)).join(" ")} rg ` : (opt.grey ? "0.45 g " : "");
    let tx = x;
    if (opt.alignRight) tx = x - textWidth(str, size);
    const y = this._page.h - yTop;
    this._ops.push(`${col}BT ${font} ${size} Tf 1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm (${pdfStr(str)}) Tj ET${(opt.grey || opt.color) ? " 0 g" : ""}`);
    return this;
  }

  hr(x1, yTop, x2, opt = {}) {
    const y = this._page.h - yTop;
    const grey = opt.grey ? "0.75 G " : "0.2 G ";
    this._ops.push(`${grey}${(opt.w || 0.75)} w ${x1} ${y.toFixed(2)} m ${x2} ${y.toFixed(2)} l S 0 G`);
    return this;
  }

  // Filled / stroked rectangle. (x, yTop) = top-left from the page top; fill and
  // stroke are [r,g,b] 0–1 arrays. Used by the programme (Gantt) export.
  rect(x, yTop, w, h, opt = {}) {
    const y = this._page.h - yTop - h;
    let op = "q ";
    if (opt.fill) op += `${opt.fill.map(n => n.toFixed(3)).join(" ")} rg `;
    if (opt.stroke) op += `${opt.stroke.map(n => n.toFixed(3)).join(" ")} RG ${(opt.lw || 0.5)} w `;
    op += `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re `;
    op += opt.fill && opt.stroke ? "B" : (opt.fill ? "f" : "S");
    this._ops.push(op + " Q");
    return this;
  }

  // Straight line between two points (top-based coordinates).
  line(x1, yTop1, x2, yTop2, opt = {}) {
    const y1 = this._page.h - yTop1, y2 = this._page.h - yTop2;
    const col = (opt.stroke || [0.2, 0.2, 0.2]).map(n => n.toFixed(3)).join(" ");
    this._ops.push(`q ${col} RG ${(opt.lw || 0.5)} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`);
    return this;
  }

  // Rounded ("bubble") filled rectangle — Bézier-curve corners, radius clamped
  // so narrow bars become clean pills. Used for the programme Gantt bars.
  roundRect(x, yTop, w, h, r, opt = {}) {
    const y = this._page.h - yTop - h;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const k = 0.5523 * r;
    const fill = (opt.fill || [0, 0, 0]).map(n => n.toFixed(3)).join(" ");
    const f = n => n.toFixed(2);
    const op =
      `q ${fill} rg ` +
      `${f(x + r)} ${f(y)} m ` +
      `${f(x + w - r)} ${f(y)} l ` +
      `${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)} c ` +
      `${f(x + w)} ${f(y + h - r)} l ` +
      `${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)} c ` +
      `${f(x + r)} ${f(y + h)} l ` +
      `${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)} c ` +
      `${f(x)} ${f(y + r)} l ` +
      `${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)} c ` +
      `h f Q`;
    this._ops.push(op);
    return this;
  }

  // Filled polygon — points as [[x, yTop], …]. Used for milestone diamonds.
  poly(points, opt = {}) {
    if (!points.length) return this;
    const fill = (opt.fill || [0, 0, 0]).map(n => n.toFixed(3)).join(" ");
    const pts = points.map(([x, yT]) => [x, this._page.h - yT]);
    let op = `q ${fill} rg ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} m `;
    for (let i = 1; i < pts.length; i++) op += `${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} l `;
    this._ops.push(op + "h f Q");
    return this;
  }

  bytes() {
    const enc = new TextEncoder();
    const nImg = this.images.length;
    const imgMeta = this.images.map((im) => {
      if (im && im.rgb) return { data: im.rgb, w: im.w, h: im.h, cs: "/DeviceRGB", filter: null };
      const b = im && im.jpeg ? im.jpeg : im;   // back-compat if a bare buffer slipped in
      const d = jpegInfo(b);
      const cs = d.comps === 1 ? "/DeviceGray" : (d.comps === 4 ? "/DeviceCMYK" : "/DeviceRGB");
      return { data: b, w: d.w, h: d.h, cs, filter: "/DCTDecode" };
    });

    // Object layout: 1 catalog, 2 pages, 3-4 fonts, 5 info, then nImg image
    // XObjects (6…), then per page a CONTENT stream + its PAGE object. Kids must
    // reference the PAGE objects (strict viewers/iOS render blank otherwise).
    const IMG0 = 6;
    const firstPageObj = IMG0 + nImg;
    const pageIds = this.pages.map((_, i) => firstPageObj + i * 2 + 1);
    const xobjRes = nImg
      ? ` /XObject << ${imgMeta.map((_, i) => `/Im${i} ${IMG0 + i} 0 R`).join(" ")} >>` : "";

    // Each object is { s } (text) or { s, raw, sAfter } (text + binary + text).
    const objs = [];
    objs.push({ s: "<< /Type /Catalog /Pages 2 0 R >>" });                       // 1
    objs.push({ s: `<< /Type /Pages /Kids [${pageIds.map(id => id + " 0 R").join(" ")}] /Count ${this.pages.length} >>` }); // 2
    objs.push({ s: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" });        // 3
    objs.push({ s: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>" });   // 4
    objs.push({ s: "<< /Producer (Mostlane Portal) >>" });                        // 5
    for (const m of imgMeta) {                                                    // 6 … image XObjects
      const filt = m.filter ? ` /Filter ${m.filter}` : "";
      objs.push({
        s: `<< /Type /XObject /Subtype /Image /Width ${m.w} /Height ${m.h} /ColorSpace ${m.cs} /BitsPerComponent 8${filt} /Length ${m.data.length} >>\nstream\n`,
        raw: m.data, sAfter: "\nendstream"
      });
    }
    for (const pg of this.pages) {
      const stream = pg.ops.join("\n");
      objs.push({ s: `<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream` });          // content
      const cid = objs.length;   // 1-indexed object number of the content just pushed
      objs.push({ s: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pg.w} ${pg.h}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjRes} >> /Contents ${cid} 0 R >>` });             // page
    }

    // Assemble as binary chunks so image streams stay byte-exact.
    const chunks = [];
    let len = 0;
    const put = (u8) => { chunks.push(u8); len += u8.length; };
    const putStr = (s) => put(enc.encode(s));

    putStr("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    const offsets = [0];
    for (let i = 0; i < objs.length; i++) {
      offsets.push(len);
      putStr(`${i + 1} 0 obj\n`);
      putStr(objs[i].s);
      if (objs[i].raw) { put(objs[i].raw); putStr(objs[i].sAfter || ""); }
      putStr("\nendobj\n");
    }
    const xrefAt = len;
    let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) tail += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    putStr(tail);

    const out = new Uint8Array(len);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
}
