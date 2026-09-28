// Tiny dependency-free .xlsx writer for the browser — VALUES ONLY (no formulas/
// macros). One workbook, one sheet per {name, rows}. A cell is a primitive
// (string|number) or {v, bold?, money?, date?}. Numbers render as numbers,
// money as "£#,##0.00", everything else as an inline string (so leading-zero
// site codes like "0382" keep their zeros). The ZIP is written with STORED
// (uncompressed) entries + CRC32, readable by Excel / LibreOffice / Sheets.
//
//   MLXlsx.download("file.xlsx", [{name:"Sep 2026", rows:[[...],[...]]}])
//   MLXlsx.build(sheets)  -> Uint8Array (tests)
(function () {
  const escXml = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const colName = n => { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {                       // files: [{name, text}]
    const enc = new TextEncoder();
    const u16 = n => new Uint8Array([n & 255, (n >> 8) & 255]);
    const u32 = n => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
    const locals = [], central = []; let offset = 0;
    for (const f of files) {
      const data = enc.encode(f.text), name = enc.encode(f.name), crc = crc32(data);
      const lh = [].concat([...u32(0x04034b50)], [...u16(20)], [...u16(0)], [...u16(0)], [...u16(0)], [...u16(0)],
        [...u32(crc)], [...u32(data.length)], [...u32(data.length)], [...u16(name.length)], [...u16(0)]);
      const local = new Uint8Array(lh.length + name.length + data.length);
      local.set(lh, 0); local.set(name, lh.length); local.set(data, lh.length + name.length);
      locals.push(local);
      const ch = [].concat([...u32(0x02014b50)], [...u16(20)], [...u16(20)], [...u16(0)], [...u16(0)], [...u16(0)], [...u16(0)],
        [...u32(crc)], [...u32(data.length)], [...u32(data.length)], [...u16(name.length)], [...u16(0)], [...u16(0)], [...u16(0)], [...u16(0)], [...u32(0)], [...u32(offset)]);
      const cen = new Uint8Array(ch.length + name.length);
      cen.set(ch, 0); cen.set(name, ch.length); central.push(cen);
      offset += local.length;
    }
    const csize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array([].concat([...u32(0x06054b50)], [...u16(0)], [...u16(0)], [...u16(files.length)], [...u16(files.length)], [...u32(csize)], [...u32(offset)], [...u16(0)]));
    const total = offset + csize + end.length, out = new Uint8Array(total); let p = 0;
    for (const l of locals) { out.set(l, p); p += l.length; }
    for (const c of central) { out.set(c, p); p += c.length; }
    out.set(end, p);
    return out;
  }

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;£&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const styleIx = c => (c.money ? (c.bold ? 3 : 2) : (c.bold ? 1 : 0));

  function sheetXml(rows) {
    const out = [];
    rows.forEach((cells, r) => {
      const rn = r + 1, parts = [];
      cells.forEach((raw, ci) => {
        const c = (raw && typeof raw === "object") ? raw : { v: raw };
        if (c.v == null || c.v === "") { if (!styleIx(c)) return; }
        const ref = colName(ci) + rn, s = styleIx(c);
        const isNum = c.money || (typeof c.v === "number" && !c.text);
        if (isNum) {
          const n = Number(c.v); parts.push(`<c r="${ref}" s="${s}"><v>${Number.isFinite(n) ? n : 0}</v></c>`);
        } else {
          parts.push(`<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escXml(c.v)}</t></is></c>`);
        }
      });
      out.push(`<row r="${rn}">${parts.join("")}</row>`);
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${out.join("")}</sheetData></worksheet>`;
  }

  const safeName = (name, used) => {
    let n = String(name || "Sheet").replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 31).trim() || "Sheet";
    let base = n, i = 2; while (used.has(n.toLowerCase())) { n = (base.slice(0, 28) + " " + i).slice(0, 31); i++; }
    used.add(n.toLowerCase()); return n;
  };

  function build(sheets) {
    const used = new Set();
    const named = (sheets || []).map(s => ({ name: safeName(s.name, used), rows: s.rows || [] }));
    if (!named.length) named.push({ name: "Sheet1", rows: [] });
    const files = [
      { name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>` },
      { name: "_rels/.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
      { name: "xl/styles.xml", text: STYLES },
    ];
    named.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows) }));
    return zip(files);
  }

  function download(filename, sheets) {
    const blob = new Blob([build(sheets)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename || "export.xlsx";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  window.MLXlsx = { build, download };
})();
