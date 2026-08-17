// Minimal dependency-free ZIP writer (STORED, no compression) for bundling a
// few files — e.g. a completed form PDF plus its product-spec documents in a
// "Product specification/" subfolder. Runs on WebCrypto-only Workers (no Node
// zlib). Entry names may contain "/" to create folders.
//
//   const bytes = buildZip([
//     { name: "RIA form 00161.pdf", data: pdfBytes },
//     { name: "Product specification/Everbuild Fire Mat.pdf", data: docBytes },
//   ]);
//   // bytes: Uint8Array (application/zip)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u8(s) { return new TextEncoder().encode(s); }
// DOS date/time — fixed (WebCrypto Workers have no wall clock at module scope;
// callers pass timestamps separately if needed). A constant is fine for a bundle.
const DOS_TIME = 0, DOS_DATE = 0x0021;   // 1980-01-01

export function buildZip(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;
  const push = (arr) => { for (const a of arr) { chunks.push(a); offset += a.length; } };

  for (const f of files) {
    const nameBytes = u8(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const localOffset = offset;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // local file header sig
    lh.setUint16(4, 20, true);           // version needed
    lh.setUint16(6, 0x0800, true);       // flags: UTF-8 filename
    lh.setUint16(8, 0, true);            // method 0 = stored
    lh.setUint16(10, DOS_TIME, true);
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); // compressed size
    lh.setUint32(22, data.length, true); // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);           // extra len
    push([new Uint8Array(lh.buffer), nameBytes, data]);

    entries.push({ nameBytes, crc, size: data.length, localOffset });
  }

  const cdStart = offset;
  for (const e of entries) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);   // central dir header sig
    ch.setUint16(4, 20, true);           // version made by
    ch.setUint16(6, 20, true);           // version needed
    ch.setUint16(8, 0x0800, true);       // flags: UTF-8
    ch.setUint16(10, 0, true);           // method stored
    ch.setUint16(12, DOS_TIME, true);
    ch.setUint16(14, DOS_DATE, true);
    ch.setUint32(16, e.crc, true);
    ch.setUint32(20, e.size, true);
    ch.setUint32(24, e.size, true);
    ch.setUint16(28, e.nameBytes.length, true);
    ch.setUint16(30, 0, true);           // extra len
    ch.setUint16(32, 0, true);           // comment len
    ch.setUint16(34, 0, true);           // disk number
    ch.setUint16(36, 0, true);           // internal attrs
    ch.setUint32(38, 0, true);           // external attrs
    ch.setUint32(42, e.localOffset, true);
    push([new Uint8Array(ch.buffer), e.nameBytes]);
  }
  const cdSize = offset - cdStart;

  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);     // end of central dir sig
  eo.setUint16(8, entries.length, true); // entries on this disk
  eo.setUint16(10, entries.length, true);// total entries
  eo.setUint32(12, cdSize, true);
  eo.setUint32(16, cdStart, true);
  eo.setUint16(20, 0, true);             // comment len
  push([new Uint8Array(eo.buffer)]);

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
