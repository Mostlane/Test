// Excel export for job programmes — builds a VALUES-ONLY .xlsx entirely in the
// browser (no formulas, no macros, nothing live): a "Programme" master sheet
// plus one tab per contractor with just their tasks, day columns with the
// contractor-coloured X blocks, weekend/bank-holiday shading, and every sheet
// marked protected so it opens as a print-only record.
//
//   MLProgXlsx.download(data, meta)   — build + save "<title>.xlsx"
//   MLProgXlsx.build(data, meta)      — Uint8Array (for tests)
//
// The ZIP is written with STORED (uncompressed) entries + CRC32 — dependency-
// free and readable by Excel, LibreOffice, Google Sheets and openpyxl.
(function () {
  const DAY = 86400000;
  const p2 = n => String(n).padStart(2, "0");
  const parse = s => { const d = new Date(String(s || "") + "T12:00:00Z"); return isNaN(d) ? null : d; };
  const ymd = d => d.toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(d.getTime() + n * DAY);
  const isWeekend = d => { const w = d.getUTCDay(); return w === 0 || w === 6; };
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmtDM = d => p2(d.getUTCDate()) + "/" + p2(d.getUTCMonth() + 1);
  const fmtFull = d => p2(d.getUTCDate()) + "/" + p2(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear();
  const escXml = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const nonWork = (d, hs) => isWeekend(d) || hs.has(ymd(d));
  function endOf(t, hs) {
    const s = parse(t.start);
    if (!s) return null;
    const days = Math.min(730, Math.max(1, Number(t.days) || 1));
    if (t.wknd) return addDays(s, days - 1);
    let d = s, left = days - 1, guard = 0;
    while (left > 0 && guard++ < 4000) { d = addDays(d, 1); if (!nonWork(d, hs)) left--; }
    return d;
  }

  // ── ZIP (stored entries) ──────────────────────────────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {          // files: [{name, text}]
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const u16 = n => new Uint8Array([n & 255, (n >> 8) & 255]);
    const u32 = n => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
    for (const f of files) {
      const nameB = enc.encode(f.name);
      const data = enc.encode(f.text);
      const crc = crc32(data);
      const head = [u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0)];
      const localLen = 30 + nameB.length + data.length;
      chunks.push(...head, nameB, data);
      central.push({ nameB, crc, size: data.length, offset });
      offset += localLen;
    }
    const cdStart = offset;
    for (const c of central) {
      chunks.push(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c.crc), u32(c.size), u32(c.size),
        u16(c.nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset), c.nameB);
      offset += 46 + c.nameB.length;
    }
    chunks.push(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(offset - cdStart), u32(cdStart), u16(0));
    let total = 0; for (const c of chunks) total += c.length;
    const out = new Uint8Array(total + 22 - 22);
    let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
    return out.slice(0, p);
  }

  // Excel's legacy sheet-protection password hash (a deterrent, like the
  // original workbook's protection — real security stays on the share link).
  function legacyHash(pw) {
    let hash = 0;
    const s = String(pw);
    for (let i = s.length - 1; i >= 0; i--) {
      hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7FFF);
      hash ^= s.charCodeAt(i);
    }
    hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7FFF);
    hash ^= s.length;
    hash ^= 0xCE4B;
    return (hash >>> 0).toString(16).toUpperCase();
  }

  const colName = n => { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  // ── One worksheet's XML ───────────────────────────────────────────────────
  // Styles (cellXfs index): 0 default · 1 bold · 2 title · 3 grey · 4 header ·
  // 5 weekend · 6 bank holiday · 7+ one per contractor (X blocks).
  function sheetXml(data, meta, tasks, styleOfContractor, pwHash) {
    const hs = new Set((data.holidays || []).map(String));
    let s0 = null, e0 = null;
    for (const t of tasks) {
      const s = parse(t.start); if (!s) continue;
      const e = endOf(t, hs);
      if (!s0 || s < s0) s0 = s;
      if (e && (!e0 || e > e0)) e0 = e;
    }
    if (!s0) { s0 = new Date(); e0 = addDays(s0, 13); }
    const days = Math.min(550, Math.round((e0 - s0) / DAY) + 1);
    const FIRST_DAY_COL = 6;              // G
    const HEADER_ROW = 9, DOW_ROW = 10, FIRST_TASK_ROW = 11;

    const rows = [];
    const cell = (r, c, v, style, num) => {
      (rows[r] = rows[r] || []).push(
        num ? `<c r="${colName(c)}${r + 1}" s="${style || 0}"><v>${v}</v></c>`
            : `<c r="${colName(c)}${r + 1}" s="${style || 0}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`);
    };

    cell(0, 0, meta.title || data.title || "Programme of works", 2);
    cell(1, 0, [meta.client, meta.site, meta.ref ? "Ref " + meta.ref : ""].filter(Boolean).join(" - "), 3);
    cell(2, 0, (meta.rev ? "Rev " + meta.rev + (meta.issuedAt ? " - issued " + fmtFull(new Date(meta.issuedAt)) : "") : "DRAFT - not issued") + " - prepared by Mostlane Construction (read-only export)", 3);
    cell(3, 0, "Contractors:", 1);
    (data.contractors || []).forEach((c, i) => { if (c.name) cell(3, 1 + i, c.name, styleOfContractor[c.id] || 0); });
    cell(4, 0, "Start date:", 1); cell(4, 1, fmtFull(s0), 0);
    cell(5, 0, "End date:", 1); cell(5, 1, fmtFull(e0), 0);
    cell(6, 0, "Days on programme:", 1); cell(6, 1, String(Math.round((e0 - s0) / DAY) + 1), 0, true);

    ["Works", "Contractor", "Start", "End", "Days", "Wknd"].forEach((h, i) => cell(HEADER_ROW - 1, i, h, 4));
    for (let i = 0; i < days; i++) {
      const d = addDays(s0, i);
      const st = isWeekend(d) ? 5 : (hs.has(ymd(d)) ? 6 : 4);
      cell(HEADER_ROW - 1, FIRST_DAY_COL + i, fmtDM(d), st);
      cell(DOW_ROW - 1, FIRST_DAY_COL + i, hs.has(ymd(d)) && !isWeekend(d) ? "BH" : DOW[d.getUTCDay()], st);
    }

    const byC = {}; for (const c of (data.contractors || [])) byC[c.id] = c;
    tasks.forEach((t, ti) => {
      const r = FIRST_TASK_ROW - 1 + ti;
      const s = parse(t.start), e = endOf(t, hs);
      cell(r, 0, t.name || "", 0);
      cell(r, 1, (byC[t.contractor] || {}).name || "", styleOfContractor[t.contractor] ? 0 : 0);
      cell(r, 2, s ? fmtFull(s) : "", 0);
      cell(r, 3, e ? fmtFull(e) : "", 0);
      cell(r, 4, String(Math.max(1, Number(t.days) || 1)), 0, true);
      cell(r, 5, t.wknd ? "TRUE" : "", 0);
      if (s && e) {
        const xStyle = styleOfContractor[t.contractor] || 1;
        for (let d = s; d <= e; d = addDays(d, 1)) {
          if (!t.wknd && nonWork(d, hs)) continue;
          const off = Math.round((d - s0) / DAY);
          if (off >= 0 && off < days) cell(r, FIRST_DAY_COL + off, "X", xStyle);
        }
      }
    });

    const rowXml = rows.map((cells, r) => cells ? `<row r="${r + 1}">${cells.join("")}</row>` : "").join("");
    const lastCol = colName(FIRST_DAY_COL + days - 1);
    const lastRow = FIRST_TASK_ROW + Math.max(1, tasks.length);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane xSplit="6" ySplit="10" topLeftCell="G11" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/><col min="3" max="4" width="11" customWidth="1"/><col min="5" max="6" width="6" customWidth="1"/><col min="7" max="${6 + days}" width="4" customWidth="1"/></cols>
<sheetData>${rowXml}</sheetData>
<sheetProtection password="${pwHash}" sheet="1" objects="1" scenarios="1" formatCells="1" formatColumns="1" formatRows="1" insertColumns="1" insertRows="1" deleteColumns="1" deleteRows="1" sort="1" autoFilter="1"/>
</worksheet>`;
  }

  function stylesXml(contractors) {
    const fills = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF0F8"/></patternFill></fill>',   // header
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EDF4"/></patternFill></fill>',   // weekend
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFDEEDA"/></patternFill></fill>',   // bank holiday
    ];
    const styleOfContractor = {};
    contractors.forEach((c, i) => {
      const hex = /^#?([0-9a-f]{6})$/i.exec(String(c.colour || "").trim());
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${(hex ? hex[1] : "94A3B8").toUpperCase()}"/></patternFill></fill>`);
      styleOfContractor[c.id] = 7 + i;    // cellXfs index below
    });
    // cellXfs: 0 default · 1 bold · 2 title · 3 grey · 4 header · 5 we · 6 bh · 7+ contractors
    const xfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>',
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/>',
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/>',
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/>',
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/>',
      '<xf numFmtId="0" fontId="3" fillId="3" borderId="0" applyFont="1" applyFill="1"/>',
      '<xf numFmtId="0" fontId="3" fillId="4" borderId="0" applyFont="1" applyFill="1"/>',
    ];
    contractors.forEach((c, i) => {
      xfs.push(`<xf numFmtId="0" fontId="0" fillId="${5 + i}" borderId="0" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>`);
    });
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="15"/><color rgb="FF003366"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF667085"/><name val="Calibri"/></font></fonts>
<fills count="${fills.length}">${fills.join("")}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
    return { xml, styleOfContractor };
  }

  const safeSheetName = (name, used) => {
    let s = String(name || "Sheet").replace(/[\[\]:*?\/\\]/g, "").trim().slice(0, 28) || "Sheet";
    let out = s, n = 2;
    while (used.has(out.toLowerCase())) out = s.slice(0, 25) + " " + (n++);
    used.add(out.toLowerCase());
    return out;
  };

  function build(data, meta) {
    data = data || {}; meta = meta || {};
    const contractors = (data.contractors || []).filter(c => c && c.name);
    const { xml: styles, styleOfContractor } = stylesXml(contractors);
    const pwHash = legacyHash("Mostlane");
    const used = new Set();
    const sheets = [{ name: safeSheetName("Programme", used), tasks: data.tasks || [] }];
    for (const c of contractors) {
      const theirs = (data.tasks || []).filter(t => t.contractor === c.id);
      if (theirs.length) sheets.push({ name: safeSheetName(c.name, used), tasks: theirs });
    }
    const files = [
      { name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>` },
      { name: "_rels/.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>` },
      { name: "docProps/core.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escXml((meta && meta.title) || "Programme of works")}</dc:title><dc:creator>Mostlane Portal</dc:creator></cp:coreProperties>` },
      { name: "docProps/app.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Mostlane Portal</Application></Properties>` },
      { name: "xl/workbook.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookProtection lockStructure="1" workbookPassword="${pwHash}"/>
<sheets>${sheets.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>` },
      { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
      { name: "xl/styles.xml", text: styles },
    ];
    sheets.forEach((s, i) => {
      files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(data, meta, s.tasks, styleOfContractor, pwHash) });
    });
    return zip(files);
  }

  function download(data, meta) {
    const bytes = build(data, meta);
    const name = (String((meta && meta.title) || (data && data.title) || "Programme").replace(/[^\w .\-()]/g, "_")) +
      (meta && meta.rev ? " - Rev " + meta.rev : " - DRAFT") + ".xlsx";
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return name;
  }

  window.MLProgXlsx = { build, download };
})();
