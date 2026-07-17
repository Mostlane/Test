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

export function textWidth(str, size = 10) {
  let u = 0;
  for (const ch of String(str)) u += W[ch] != null ? W[ch] : 556;
  return (u / 1000) * size;
}

// Escape a JS string into a PDF literal string using WinAnsi bytes.
function pdfStr(s) {
  let out = "";
  for (const ch of String(s)) {
    let c = ch.charCodeAt(0);
    if (ch === "–" || ch === "—") c = 45;            // dashes → hyphen
    if (ch === "’" || ch === "‘") c = 39;
    if (ch === "“" || ch === "”") c = 34;
    if (c > 255) c = 63;                              // outside WinAnsi → ?
    if (c === 92) out += "\\\\";
    else if (c === 40) out += "\\(";
    else if (c === 41) out += "\\)";
    else if (c >= 32 && c <= 126) out += String.fromCharCode(c);
    else out += "\\" + c.toString(8).padStart(3, "0"); // e.g. £ = \243
  }
  return out;
}

export class PdfDoc {
  constructor() { this.pages = []; this.newPage(); }
  newPage() { this.pages.push([]); return this; }
  get _ops() { return this.pages[this.pages.length - 1]; }

  // yTop is measured from the top of the page to the text BASELINE.
  text(x, yTop, str, opt = {}) {
    const size = opt.size || 10;
    const font = opt.bold ? "/F2" : "/F1";
    const grey = opt.grey ? "0.45 g " : "";
    let tx = x;
    if (opt.alignRight) tx = x - textWidth(str, size);
    const y = PAGE_H - yTop;
    this._ops.push(`${grey}BT ${font} ${size} Tf 1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm (${pdfStr(str)}) Tj ET${opt.grey ? " 0 g" : ""}`);
    return this;
  }

  hr(x1, yTop, x2, opt = {}) {
    const y = PAGE_H - yTop;
    const grey = opt.grey ? "0.75 G " : "0.2 G ";
    this._ops.push(`${grey}${(opt.w || 0.75)} w ${x1} ${y.toFixed(2)} m ${x2} ${y.toFixed(2)} l S 0 G`);
    return this;
  }

  bytes() {
    const enc = new TextEncoder();
    const objs = [];                    // 1-indexed object bodies (strings)
    objs.push("<< /Type /Catalog /Pages 2 0 R >>");                       // 1
    const pageIds = this.pages.map((_, i) => 5 + i * 2 + 1);
    objs.push(`<< /Type /Pages /Kids [${pageIds.map(id => id + " 0 R").join(" ")}] /Count ${this.pages.length} >>`); // 2
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");        // 3
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");   // 4
    objs.push("<< /Producer (Mostlane Portal) >>");                                                        // 5
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      objs.push(`<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`);               // content
      const cid = objs.length;
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`);                       // page
    }
    let body = "%PDF-1.4\n%âãÏÓ\n";
    const offsets = [0];
    for (let i = 0; i < objs.length; i++) {
      offsets.push(enc.encode(body).length);
      body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xrefAt = enc.encode(body).length;
    body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) body += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return enc.encode(body);
  }
}
