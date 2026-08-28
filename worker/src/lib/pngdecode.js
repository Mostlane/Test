// Minimal PNG decoder for the Worker → { width, height, rgb: Uint8Array } with
// any alpha composited over WHITE (so a transparent-background signature reads as
// black strokes on white). Async: it uses DecompressionStream to inflate the
// zlib-wrapped IDAT. Supports 8-bit, non-interlaced PNGs of colour type
// 0 (grey), 2 (RGB), 3 (palette + tRNS), 4 (grey+alpha), 6 (RGBA) — which covers
// every canvas.toDataURL("image/png"). Returns null for anything else so the
// caller can fall back gracefully.
//
//   await decodePngToRgb(bytes) -> { width, height, rgb } | null

const MAX_PIXELS = 4_000_000; // guard the uncompressed buffer (a signature is tiny)

export async function decodePngToRgb(bytes) {
  try {
    const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (v.length < 8 || v[0] !== 0x89 || v[1] !== 0x50 || v[2] !== 0x4E || v[3] !== 0x47) return null;
    const u32 = (o) => ((v[o] << 24) | (v[o + 1] << 16) | (v[o + 2] << 8) | v[o + 3]) >>> 0;

    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    let palette = null, trns = null;
    const idat = [];
    let p = 8;
    while (p + 8 <= v.length) {
      const len = u32(p);
      const type = String.fromCharCode(v[p + 4], v[p + 5], v[p + 6], v[p + 7]);
      const d = p + 8;
      if (type === "IHDR") {
        width = u32(d); height = u32(d + 4);
        bitDepth = v[d + 8]; colorType = v[d + 9]; interlace = v[d + 12];
      } else if (type === "PLTE") {
        palette = v.subarray(d, d + len);
      } else if (type === "tRNS") {
        trns = v.subarray(d, d + len);
      } else if (type === "IDAT") {
        idat.push(v.subarray(d, d + len));
      } else if (type === "IEND") break;
      p = d + len + 4; // + CRC
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
    if (width * height > MAX_PIXELS) return null;

    const ch = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1
      : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (!ch) return null;
    if (colorType === 3 && !palette) return null;

    // Concatenate IDAT and inflate (zlib → DecompressionStream "deflate").
    let total = 0; idat.forEach(a => total += a.length);
    if (!total) return null;
    const comp = new Uint8Array(total);
    let q = 0; idat.forEach(a => { comp.set(a, q); q += a.length; });
    const ds = new DecompressionStream("deflate");
    const raw = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer());

    // Un-filter scanlines (per-line filter byte + Sub/Up/Average/Paeth).
    const bpp = ch, stride = width * ch;
    if (raw.length < height * (stride + 1)) return null;
    const out = new Uint8Array(height * stride);
    let ip = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[ip++];
      const rowOff = y * stride, prevOff = (y - 1) * stride;
      for (let x = 0; x < stride; x++) {
        const rv = raw[ip++];
        const a = x >= bpp ? out[rowOff + x - bpp] : 0;
        const b = y > 0 ? out[prevOff + x] : 0;
        const c = (y > 0 && x >= bpp) ? out[prevOff + x - bpp] : 0;
        let val;
        switch (filter) {
          case 0: val = rv; break;
          case 1: val = rv + a; break;
          case 2: val = rv + b; break;
          case 3: val = rv + ((a + b) >> 1); break;
          case 4: {
            const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
            val = rv + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)); break;
          }
          default: return null;
        }
        out[rowOff + x] = val & 255;
      }
    }

    // Flatten to RGB over white.
    const rgb = new Uint8Array(width * height * 3);
    let o = 0;
    for (let pix = 0; pix < width * height; pix++) {
      let r, g, bl, al = 255;
      if (colorType === 0) { r = g = bl = out[pix]; }
      else if (colorType === 2) { r = out[pix * 3]; g = out[pix * 3 + 1]; bl = out[pix * 3 + 2]; }
      else if (colorType === 4) { r = g = bl = out[pix * 2]; al = out[pix * 2 + 1]; }
      else if (colorType === 6) { r = out[pix * 4]; g = out[pix * 4 + 1]; bl = out[pix * 4 + 2]; al = out[pix * 4 + 3]; }
      else { const idx = out[pix]; r = palette[idx * 3]; g = palette[idx * 3 + 1]; bl = palette[idx * 3 + 2]; if (trns && idx < trns.length) al = trns[idx]; }
      const inv = 255 - al;
      rgb[o++] = ((r * al) + 255 * inv) / 255 | 0;
      rgb[o++] = ((g * al) + 255 * inv) / 255 | 0;
      rgb[o++] = ((bl * al) + 255 * inv) / 255 | 0;
    }
    return { width, height, rgb };
  } catch { return null; }
}
