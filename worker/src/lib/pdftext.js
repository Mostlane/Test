// Dependency-free PDF text extraction (WebCrypto / DecompressionStream only).
// Good enough to read structured certificate text (Tysoft EasyCert EM & PAT
// reports, and similar) so the portal can pull the previous certificate's
// details forward. Only FlateDecode text streams are read; image streams that
// don't inflate are skipped. NOT a general PDF parser — no font/CMap handling,
// so glyph-mapped or purely-image PDFs yield little/no text (callers fall back).

function latin1(u8) {
  let s = ""; const CH = 8192;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
}

async function inflate(u8) {
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const stream = new Response(u8).body.pipeThrough(new DecompressionStream(fmt));
      const buf = await new Response(stream).arrayBuffer();
      const out = new Uint8Array(buf);
      if (out.length) return out;
    } catch {}
  }
  return null;
}

// Return the certificate text as one normalised (single-spaced) string.
export async function pdfExtractText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const s = latin1(u8);
  const out = [];
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    let raw = u8.subarray(start, end);
    let e = raw.length; while (e > 0 && (raw[e - 1] === 10 || raw[e - 1] === 13)) e--;  // trim trailing CR/LF or inflate fails
    raw = raw.slice(0, e);
    const dec = await inflate(raw);
    const ds = latin1(dec || raw);
    const toks = ds.match(/\((?:[^()\\]|\\.)*\)/g);
    if (toks) for (const t of toks) {
      const v = t.slice(1, -1).replace(/\\([()\\])/g, "$1");
      if (v.trim()) out.push(v);
    }
    re.lastIndex = end + 9;
  }
  return out.join(" ").replace(/\s+/g, " ");
}

// Also return the raw ordered token list (before space-collapsing) — useful for
// row/table reconstruction where token boundaries matter.
export async function pdfExtractTokens(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const s = latin1(u8);
  const out = [];
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    let raw = u8.subarray(start, end);
    let e = raw.length; while (e > 0 && (raw[e - 1] === 10 || raw[e - 1] === 13)) e--;
    raw = raw.slice(0, e);
    const dec = await inflate(raw);
    const ds = latin1(dec || raw);
    const toks = ds.match(/\((?:[^()\\]|\\.)*\)/g);
    if (toks) for (const t of toks) {
      const v = t.slice(1, -1).replace(/\\([()\\])/g, "$1");
      if (v.trim()) out.push(v);
    }
    re.lastIndex = end + 9;
  }
  return out;
}

// The Tysoft EasyCert certificate number, printed in the footer:
//   "…Copyright Tysoft 2025. 0014-25 Page: 1 of 2"  /  "…Ref: 0014-25 - Page: 2 of 2"
// The "Certificate Number:" field itself is often blank, so the footer/Ref wins.
export function certNumberFromText(txt) {
  if (!txt) return null;
  const m =
    txt.match(/\bRef:\s*(\d{3,5})\s*-\s*(DEC)?\s*(\d{2})\b/i) ||
    txt.match(/Copyright\s+Tysoft\s+\d{4}\.\s*(\d{3,5})\s*-\s*(DEC)?\s*(\d{2})\b/i) ||
    txt.match(/(\d{3,5})\s*-\s*(DEC)?\s*(\d{2})\s*-?\s*Page:/i) ||
    txt.match(/Certificate\s*Number:?\s*(\d{3,5})\s*-\s*(DEC)?\s*(\d{2})\b/i);
  return m ? { set: m[1], year: Number(m[3]) } : null;
}
