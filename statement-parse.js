/* statement-parse.js — dependency-free bank-statement reader for wealth.html.
 *
 * Turns a file the user exported from their bank into a list of transactions
 * WITHOUT any external library or network call — the raw statement never leaves
 * the browser. Three formats:
 *   • CSV / TSV / TXT  — auto-detects delimiter, header row and columns
 *                        (single signed Amount, or Money In/Out, or Debit/Credit).
 *   • XLSX             — reuses the portal's xlsx-lite.js, then the same column logic.
 *   • PDF              — best-effort text extraction (inflates FlateDecode streams
 *                        with the built-in DecompressionStream, pulls the text
 *                        operators) then a heuristic line→row pass. Bank PDFs vary
 *                        wildly, so PDF rows are flagged `guess:true` for the
 *                        on-screen review step to confirm before saving.
 *
 * API:  const res = await StatementParse.parseFile(file);
 *       res = { format, rows:[{date, description, amount, candidates, guess}], warnings }
 *       date  = "YYYY-MM-DD" (or "" if unpar?sed); amount = signed number (+in/-out).
 */
(function (global) {
  "use strict";

  // ── Money ──────────────────────────────────────────────────────────────────
  function parseMoney(v) {
    if (v == null) return null;
    let s = String(v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }        // (12.34) = negative
    if (/(^-)|(-$)/.test(s)) neg = true;
    if (/\bdr\b/i.test(s)) neg = true;                                  // debit
    if (/\bcr\b/i.test(s)) neg = false;                                 // credit
    s = s.replace(/[£$€,]/g, "").replace(/[a-z]/gi, "").replace(/[()\s+-]/g, "");
    if (!s || !/\d/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return neg ? -Math.abs(n) : n;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  // Parse a date to ISO YYYY-MM-DD. UK day-first by default.
  function parseDate(v, dayFirst) {
    if (v == null) return "";
    const s = String(v).trim();
    if (!s) return "";
    let m;
    // 2024-01-31 / 2024/01/31
    if ((m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/))) {
      return iso(+m[1], +m[2], +m[3]);
    }
    // 31 Jan 2024  /  31-Jan-24  /  Jan 31 2024
    if ((m = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,9})[\s\-]+(\d{2,4})/))) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return iso(fullYear(+m[3]), mo, +m[1]);
    }
    if ((m = s.match(/^([A-Za-z]{3,9})[\s\-]+(\d{1,2}),?[\s\-]+(\d{2,4})/))) {
      const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) return iso(fullYear(+m[3]), mo, +m[2]);
    }
    // 31/01/2024 or 01/31/2024
    if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/))) {
      let a = +m[1], b = +m[2];
      let day, mon;
      if (dayFirst === false) { mon = a; day = b; }
      else if (a > 12 && b <= 12) { day = a; mon = b; }
      else if (b > 12 && a <= 12) { mon = a; day = b; }
      else { day = a; mon = b; }                                        // ambiguous → day-first (UK)
      if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return iso(fullYear(+m[3]), mon, day);
    }
    return "";
  }
  function fullYear(y) { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }
  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(y, mo, d) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return "";
    return y + "-" + pad(mo) + "-" + pad(d);
  }
  function looksLikeDate(v) { return parseDate(v, true) !== ""; }
  function looksLikeMoney(v) {
    const s = String(v || "").trim();
    return /^-?\(?£?\s?-?\d{1,3}(,\d{3})*(\.\d{1,2})?\)?\s?(cr|dr)?$/i.test(s) && /\d/.test(s);
  }

  // ── CSV ──────────────────────────────────────────────────────────────────--
  function detectDelimiter(text) {
    const line = (text.split(/\r?\n/).find(l => l.trim()) || "");
    const counts = { ",": (line.match(/,/g) || []).length, "\t": (line.match(/\t/g) || []).length, ";": (line.match(/;/g) || []).length };
    let best = ",", n = -1;
    for (const d in counts) if (counts[d] > n) { n = counts[d]; best = d; }
    return best;
  }
  function parseCSVText(text, delim) {
    const rows = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ""));
  }

  // ── Column mapping (shared by CSV + XLSX) ──────────────────────────────────-
  // Given an array-of-arrays, find the header row and which columns are the
  // date / description / amount(s), then build normalised rows.
  function rowsToTransactions(grid, warnings) {
    if (!grid.length) return [];
    // Find a header row: the first row where most cells are non-numeric words.
    let headerIdx = -1;
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      const cells = grid[i].map(c => String(c || "").trim().toLowerCase());
      const joined = cells.join(" ");
      if (/date/.test(joined) && /(amount|paid|debit|credit|money|value|in|out)/.test(joined)) { headerIdx = i; break; }
    }
    const header = headerIdx >= 0 ? grid[headerIdx].map(c => String(c || "").trim().toLowerCase()) : null;

    let dateCol = -1, descCol = -1, amtCol = -1, inCol = -1, outCol = -1, debitCol = -1, creditCol = -1;
    if (header) {
      header.forEach((h, i) => {
        if (dateCol < 0 && /date/.test(h)) dateCol = i;
        if (/desc|detail|narrative|reference|payee|memo|transaction|particular|name/.test(h) && descCol < 0) descCol = i;
        if (/paid\s*in|money\s*in|credit(?!\/)/.test(h) && inCol < 0) inCol = i;
        if (/paid\s*out|money\s*out|debit(?!\/)/.test(h) && outCol < 0) outCol = i;
        if (/^debit$/.test(h) && debitCol < 0) debitCol = i;
        if (/^credit$/.test(h) && creditCol < 0) creditCol = i;
        if (/^amount$|^value$|^amt$/.test(h) && amtCol < 0) amtCol = i;
      });
      // "balance" must never be mistaken for the amount.
      if (amtCol >= 0 && /balance/.test(header[amtCol] || "")) amtCol = -1;
    }

    const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;
    const out = [];

    // No usable header — infer columns by sampling the data.
    if (dateCol < 0 || (amtCol < 0 && inCol < 0 && outCol < 0 && debitCol < 0 && creditCol < 0)) {
      return inferColumns(grid, dataStart, warnings);
    }

    for (let i = dataStart; i < grid.length; i++) {
      const r = grid[i];
      const date = parseDate(r[dateCol], true);
      if (!date) continue;
      let amount = null;
      if (amtCol >= 0) amount = parseMoney(r[amtCol]);
      else {
        const din = parseMoney(r[inCol >= 0 ? inCol : creditCol]);
        const dout = parseMoney(r[outCol >= 0 ? outCol : debitCol]);
        if (din) amount = Math.abs(din);
        else if (dout) amount = -Math.abs(dout);
      }
      if (amount == null || amount === 0) continue;
      const description = descCol >= 0 ? String(r[descCol] || "").trim()
        : r.filter((_, idx) => idx !== dateCol && idx !== amtCol).map(x => String(x || "").trim()).filter(Boolean).join(" ");
      out.push({ date, description: description || "(no description)", amount, candidates: [amount], guess: false });
    }
    if (!out.length) warnings.push("Found the columns but no rows parsed — check the file has real transaction lines.");
    return out;
  }

  // Header-less CSV: sample columns to guess which is the date, the amount and
  // the description.
  function inferColumns(grid, dataStart, warnings) {
    const width = Math.max(...grid.map(r => r.length));
    const score = { date: new Array(width).fill(0), money: new Array(width).fill(0), text: new Array(width).fill(0) };
    const sample = grid.slice(dataStart, dataStart + 60);
    for (const r of sample) {
      for (let c = 0; c < width; c++) {
        const v = r[c];
        if (v == null || v === "") continue;
        if (looksLikeDate(v)) score.date[c]++;
        else if (looksLikeMoney(v)) score.money[c]++;
        else if (String(v).trim().length > 2) score.text[c]++;
      }
    }
    const argmax = a => a.reduce((bi, v, i, arr) => v > arr[bi] ? i : bi, 0);
    const dateCol = argmax(score.date);
    // amount = money column with the widest spread (balance is monotonic; the
    // amount column is not) — but simply take the money col that is NOT the last
    // one if there are two (last is usually the running balance).
    const moneyCols = score.money.map((v, i) => ({ i, v })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).map(x => x.i);
    let amtCol = moneyCols[0];
    if (moneyCols.length >= 2) { const sorted = moneyCols.slice().sort((a, b) => a - b); amtCol = sorted[sorted.length - 2]; }
    const descCol = argmax(score.text);
    if (dateCol == null || amtCol == null) { warnings.push("Couldn't work out the columns automatically — you can fix them in the review step."); return []; }
    const out = [];
    for (let i = dataStart; i < grid.length; i++) {
      const r = grid[i];
      const date = parseDate(r[dateCol], true);
      const amount = parseMoney(r[amtCol]);
      if (!date || amount == null || amount === 0) continue;
      const description = String(r[descCol] || "").trim() ||
        r.filter((_, idx) => idx !== dateCol && idx !== amtCol).map(x => String(x || "").trim()).filter(Boolean).join(" ");
      out.push({ date, description: description || "(no description)", amount, candidates: [amount], guess: false });
    }
    warnings.push("No column headers found — columns were guessed. Please check the review list.");
    return out;
  }

  // ── PDF ────────────────────────────────────────────────────────────────────
  async function inflate(bytes, format) {
    try {
      const ds = new DecompressionStream(format);
      const stream = new Response(bytes).body.pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { return null; }
  }
  async function extractPdfText(buf) {
    const bytes = new Uint8Array(buf);
    // 1:1 latin1 view for index scanning.
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    let text = "";
    let idx = 0;
    while (true) {
      const st = s.indexOf("stream", idx);
      if (st < 0) break;
      let ds = st + 6;
      if (s[ds] === "\r") ds++;
      if (s[ds] === "\n") ds++;
      const en = s.indexOf("endstream", ds);
      if (en < 0) break;
      idx = en + 9;
      const raw = bytes.subarray(ds, en);
      let inflated = await inflate(raw, "deflate");           // zlib (FlateDecode)
      if (!inflated) inflated = await inflate(raw, "deflate-raw");
      let content;
      if (inflated) content = new TextDecoder("latin1").decode(inflated);
      else content = s.slice(ds, en);                          // uncompressed content stream
      if (/BT|Tj|TJ/.test(content)) text += pdfStreamToText(content) + "\n";
    }
    return text;
  }
  function decodeEscapes(str) {
    return str.replace(/\\(\d{1,3}|\r\n|\n|.)/g, (m, g) => {
      if (/^\d{1,3}$/.test(g)) return String.fromCharCode(parseInt(g, 8) & 0xff);
      if (g === "\n" || g === "\r\n") return "";               // line continuation
      const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      return map[g] != null ? map[g] : g;
    });
  }
  function hexToStr(h) {
    h = h.replace(/[^0-9A-Fa-f]/g, "");
    if (h.length % 2) h += "0";
    let out = "";
    for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    return out;
  }
  // Walk a content stream, emitting one line per text-positioning operator.
  function pdfStreamToText(content) {
    const lines = [];
    let line = "", token = "", i = 0;
    const n = content.length;
    const flush = () => { if (line.trim()) lines.push(line.replace(/\s+/g, " ").trim()); line = ""; };
    while (i < n) {
      const c = content[i];
      if (c === "(") {
        let depth = 1, j = i + 1, str = "";
        while (j < n && depth > 0) {
          const d = content[j];
          if (d === "\\") { str += d + (content[j + 1] || ""); j += 2; continue; }
          if (d === "(") { depth++; str += d; j++; continue; }
          if (d === ")") { depth--; if (depth === 0) { j++; break; } str += d; j++; continue; }
          str += d; j++;
        }
        line += decodeEscapes(str);
        i = j; token = ""; continue;
      }
      if (c === "<" && content[i + 1] !== "<") {
        let j = i + 1, hx = "";
        while (j < n && content[j] !== ">") { hx += content[j]; j++; }
        line += hexToStr(hx); i = j + 1; token = ""; continue;
      }
      if (/[A-Za-z*'"]/.test(c)) { token += c; i++; continue; }
      if (token) {
        if (token === "Td" || token === "TD" || token === "T*" || token === "Tm" || token === "'" || token === '"') flush();
        token = "";
      }
      i++;
    }
    if (token === "Td" || token === "TD" || token === "T*" || token === "Tm") flush();
    flush();
    return lines.join("\n");
  }
  function parsePdfLines(text, warnings) {
    const dateRe = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/;
    const moneyRe = /-?£?\s?\(?-?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:cr|dr))?/gi;
    const out = [];
    for (const ln of text.split(/\n+/)) {
      const dm = ln.match(dateRe);
      if (!dm) continue;
      const date = parseDate(dm[1], true);
      if (!date) continue;
      const monies = ln.match(moneyRe);
      if (!monies || !monies.length) continue;
      const nums = monies.map(parseMoney).filter(x => x != null && x !== 0);
      if (!nums.length) continue;
      // Last money on the line is usually the running balance → drop it if 2+.
      const txNums = nums.length >= 2 ? nums.slice(0, -1) : nums;
      let amount = txNums[txNums.length - 1];
      // Guess sign from wording; the review step lets the user flip it.
      const credit = /(salary|wages|received|refund|interest|credit|transfer in|from )/i.test(ln);
      amount = credit ? Math.abs(amount) : -Math.abs(amount);
      // Description = the line with the date + monies stripped out.
      let description = ln.replace(dm[1], " ");
      for (const mo of monies) description = description.replace(mo, " ");
      description = description.replace(/\s+/g, " ").trim();
      out.push({ date, description: description || "(no description)", amount, candidates: nums, guess: true });
    }
    if (!out.length) warnings.push("Couldn't read transactions from this PDF automatically. If your bank can export a CSV, that works far better.");
    return out;
  }

  // ── XLSX ───────────────────────────────────────────────────────────────────
  async function parseXlsx(buf, warnings) {
    if (!global.XLSXLite) { warnings.push("Spreadsheet reader not loaded."); return []; }
    const wb = await global.XLSXLite.parse(buf);
    const grid = [];
    for await (const row of wb.rows()) {
      const arr = [];
      for (const col in row.cells) {
        const ci = colIndex(col);
        arr[ci] = row.cells[col];
      }
      grid.push(arr);
    }
    return rowsToTransactions(grid, warnings);
  }
  function colIndex(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // ── Entry point ────────────────────────────────────────────────────────────
  async function parseFile(file) {
    const warnings = [];
    const name = (file.name || "").toLowerCase();
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    const isPdf = name.endsWith(".pdf") || (head[0] === 0x25 && head[1] === 0x50); // %P
    const isZip = head[0] === 0x50 && head[1] === 0x4b;                            // PK (xlsx)
    let rows = [], format = "csv";
    if (isPdf) {
      format = "pdf";
      const text = await extractPdfText(buf);
      rows = parsePdfLines(text, warnings);
    } else if (name.endsWith(".xlsx") || isZip) {
      format = "xlsx";
      rows = await parseXlsx(buf, warnings);
    } else {
      format = "csv";
      const text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
      const delim = detectDelimiter(text);
      const grid = parseCSVText(text, delim);
      rows = rowsToTransactions(grid, warnings);
    }
    // Newest first.
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { format, rows, warnings };
  }

  global.StatementParse = { parseFile, parseMoney, parseDate };
})(typeof self !== "undefined" ? self : this);
