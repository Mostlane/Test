/* xlsx-lite — a tiny, dependency-free .xlsx reader for one-off imports.
 *
 * Reads an .xlsx (which is a ZIP of XML) entirely in the browser: unzips the
 * two parts we need (sharedStrings + the first worksheet) using the built-in
 * DecompressionStream, then parses the cell XML. No SheetJS, no network — the
 * spreadsheet never leaves the device.
 *
 * Usage:
 *   const wb = await XLSXLite.parse(arrayBuffer);
 *   wb.rowCount            // number of <row> elements
 *   for await (const row of wb.rows()) { row.r; row.cells.A; row.cells.B; ... }
 *
 * Only what a flat "one row per record" export needs is supported (shared
 * strings, inline strings, numbers). Good enough for report exports; not a
 * general-purpose Excel library.
 */
(function (global) {
  "use strict";

  // ---- ZIP directory reader (store + deflate) --------------------------------
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function findEOCD(dv) {
    // End Of Central Directory: signature 0x06054b50, within last 64KB + 22.
    const len = dv.byteLength;
    const min = Math.max(0, len - 65557);
    for (let i = len - 22; i >= min; i--) {
      if (u32(dv, i) === 0x06054b50) return i;
    }
    throw new Error("Not a valid .xlsx (no ZIP end-of-directory found)");
  }

  function readCentralDirectory(buf) {
    const dv = new DataView(buf);
    const eocd = findEOCD(dv);
    let cdOffset = u32(dv, eocd + 16);
    const cdCount = u16(dv, eocd + 10);
    const entries = {};
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (u32(dv, p) !== 0x02014b50) break; // central file header sig
      const method = u16(dv, p + 10);
      const compSize = u32(dv, p + 20);
      const nameLen = u16(dv, p + 28);
      const extraLen = u16(dv, p + 30);
      const commentLen = u16(dv, p + 32);
      const localOffset = u32(dv, p + 42);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
      entries[name] = { method, compSize, localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { buf, dv, entries };
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Response(bytes).body.pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntryText(zip, name) {
    const e = zip.entries[name];
    if (!e) return null;
    const dv = zip.dv;
    // Local file header: name + extra lengths live at +26/+28 of the local rec.
    const lh = e.localOffset;
    if (u32(dv, lh) !== 0x04034b50) throw new Error("Bad local header for " + name);
    const nameLen = u16(dv, lh + 26);
    const extraLen = u16(dv, lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const comp = new Uint8Array(zip.buf, dataStart, e.compSize);
    const raw = e.method === 0 ? comp : await inflateRaw(comp);
    return new TextDecoder("utf-8").decode(raw);
  }

  // ---- XML helpers -----------------------------------------------------------
  function unescapeXml(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, "&");
  }

  // Elements may be namespaced (<x:si>) or not (<si>) depending on the writer.
  function tag(name) { return "(?:[a-zA-Z]+:)?" + name; }

  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const re = new RegExp("<" + tag("si") + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag("si") + ">", "g");
    const tre = new RegExp("<" + tag("t") + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag("t") + ">", "g");
    let m;
    while ((m = re.exec(xml))) {
      let text = "", t;
      tre.lastIndex = 0;
      while ((t = tre.exec(m[1]))) text += t[1];
      out.push(unescapeXml(text));
    }
    return out;
  }

  global.XLSXLite = {
    async parse(arrayBuffer) {
      const zip = readCentralDirectory(arrayBuffer);
      // Worksheet name can vary; default to sheet1 but fall back to the first.
      let sheetName = "xl/worksheets/sheet1.xml";
      if (!zip.entries[sheetName]) {
        sheetName = Object.keys(zip.entries).find(n => /^xl\/worksheets\/.*\.xml$/.test(n));
      }
      const [ssXml, sheetXml] = await Promise.all([
        readEntryText(zip, "xl/sharedStrings.xml"),
        readEntryText(zip, sheetName)
      ]);
      const strings = parseSharedStrings(ssXml);
      const rowCount = (sheetXml.match(new RegExp("<" + tag("row") + "\\b", "g")) || []).length;

      const cellRe = new RegExp(
        "<" + tag("c") + "\\b[^>]*\\br=\"([A-Z]+)\\d+\"[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/" + tag("c") + ">)", "g");
      const rowRe = new RegExp(
        "<" + tag("row") + "\\b[^>]*\\br=\"(\\d+)\"[^>]*>([\\s\\S]*?)<\\/" + tag("row") + ">", "g");
      const vRe = new RegExp("<" + tag("v") + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag("v") + ">");
      const isRe = new RegExp("<" + tag("is") + "\\b[^>]*>[\\s\\S]*?<" + tag("t") + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag("t") + ">");

      function cellValue(full) {
        const tMatch = full.match(/\bt="([^"]+)"/);
        const t = tMatch ? tMatch[1] : null;
        if (t === "inlineStr") { const im = full.match(isRe); return im ? unescapeXml(im[1]) : ""; }
        const vm = full.match(vRe);
        if (!vm) return "";
        if (t === "s") return strings[parseInt(vm[1], 10)] || "";
        return unescapeXml(vm[1]);
      }

      return {
        rowCount,
        strings,
        // Async generator so a huge sheet can be consumed row-by-row.
        async *rows() {
          let rm;
          rowRe.lastIndex = 0;
          while ((rm = rowRe.exec(sheetXml))) {
            const cells = {};
            let cm;
            cellRe.lastIndex = 0;
            while ((cm = cellRe.exec(rm[2]))) cells[cm[1]] = cellValue(cm[0]);
            yield { r: parseInt(rm[1], 10), cells };
          }
        }
      };
    }
  };
})(typeof self !== "undefined" ? self : this);
