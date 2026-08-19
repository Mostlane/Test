// Programme-of-works PDF — a clean VECTOR A4-landscape Gantt drawn straight
// from the programme JSON (never a screenshot), so it prints crisply at any
// size. Paginates vertically (rows) AND horizontally (long timelines split
// into date windows, with the task columns repeated on every page).
//
//   buildProgrammePdf(data, meta) -> Uint8Array (application/pdf)
//     data = { title, contractors:[{id,name,colour}], holidays:[dates],
//              tasks:[{name,contractor,start,days,wknd,progress,milestone}] }
//     meta = { title, client, site, ref, rev, issuedAt, sharedWith, notes }
//
// Kept separate from routes/programmes.js so it can be unit-tested in Node
// with no worker dependencies (imports only lib/pdf.js).

import { PdfDoc, textWidth } from "./pdf.js";
import { MOSTLANE_LOGO_JPEG_B64, MOSTLANE_LOGO_W, MOSTLANE_LOGO_H } from "./logo.js";

// Decode the embedded logo once; fail soft so a bad decode never breaks a PDF.
let LOGO_BYTES = null;
try {
  const bin = atob(MOSTLANE_LOGO_JPEG_B64);
  LOGO_BYTES = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) LOGO_BYTES[i] = bin.charCodeAt(i);
} catch (e) { LOGO_BYTES = null; }
const LOGO_W = 76, LOGO_H = LOGO_W * (MOSTLANE_LOGO_H / MOSTLANE_LOGO_W);   // keep aspect

const PW = 842, PH = 595;                 // A4 landscape
const M = 26;                             // page margin
const ROW_H = 14.5;                       // single-line row height
const LINE_H = 10;                        // added height per extra wrapped line
const ROW_PAD = 4.5;                      // so 1 line = ROW_H (10 + 4.5)
const MAX_NAME_LINES = 5;                 // cap so one task can't fill a page
const HDR_H = 22;                         // day-grid header band
const COLS = [                            // left columns; "Works" width is dynamic
  { key: "name", label: "Works", w: 168 },
  { key: "contractor", label: "Contractor", w: 62 },
  { key: "start", label: "Start", w: 36 },
  { key: "end", label: "End", w: 36 },
  { key: "days", label: "Days", w: 26 },
];
// Recomputed per render from data.worksW (the on-screen Works column width).
let LEFT_W = COLS.reduce((a, c) => a + c.w, 0);
let GRID_X = M + LEFT_W;
let GRID_W = PW - M - GRID_X;
const WORKS_DEFAULT_PX = 230;             // matches the builder's default column
const PX_TO_PT = 168 / WORKS_DEFAULT_PX;  // 230px on screen ≈ 168pt in the PDF
function applyWorksWidth(worksW) {
  const px = Math.max(120, Math.min(560, Number(worksW) || WORKS_DEFAULT_PX));
  COLS[0].w = Math.max(90, Math.min(380, Math.round(px * PX_TO_PT)));
  LEFT_W = COLS.reduce((a, c) => a + c.w, 0);
  GRID_X = M + LEFT_W;
  GRID_W = PW - M - GRID_X;
}
const MIN_DAY_W = 6.5;                    // never squeeze below this — split pages instead

const DAY = 86400000;
const p2 = n => String(n).padStart(2, "0");
const parse = s => { const d = new Date(String(s || "") + "T12:00:00Z"); return isNaN(d) ? null : d; };
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const isWeekend = d => { const w = d.getUTCDay(); return w === 0 || w === 6; };
const fmtDM = d => p2(d.getUTCDate()) + "/" + p2(d.getUTCMonth() + 1);
const fmtFull = d => p2(d.getUTCDate()) + "/" + p2(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear();

function hex2rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return [0.55, 0.62, 0.7];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
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

function fitText(str, w, size) {
  let s = String(str || "");
  if (textWidth(s, size) <= w) return s;
  // ASCII "..." — the PDF font is WinAnsi and has no "…" glyph (it renders as "?").
  while (s.length > 1 && textWidth(s + "...", size) > w) s = s.slice(0, -1);
  return s + "...";
}

// Wrap a string into lines that each fit within width w, so task names read in
// full (matches the wrapping Works column on screen). Breaks an over-long single
// word by character; caps at maxLines (the overflow collapses into a "..." on the
// last kept line) so a giant note can't consume a whole page.
function wrapLines(str, w, size, maxLines) {
  const words = String(str || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (let word of words) {
    // a single word wider than the column: hard-break it
    while (textWidth(word, size) > w && word.length > 1) {
      if (line) { lines.push(line); line = ""; }
      let k = word.length;
      while (k > 1 && textWidth(word.slice(0, k), size) > w) k--;
      lines.push(word.slice(0, k));
      word = word.slice(k);
    }
    const test = line ? line + " " + word : word;
    if (textWidth(test, size) <= w) line = test;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push("");
  if (maxLines && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitText(lines.slice(maxLines - 1).join(" "), w, size);
    return kept;
  }
  return lines;
}

export function buildProgrammePdf(data, meta = {}) {
  data = data || {};
  applyWorksWidth(data.worksW);
  const contractors = Array.isArray(data.contractors) ? data.contractors : [];
  const byC = {}; for (const c of contractors) byC[c.id] = c;
  const hs = new Set((data.holidays || []).map(String));
  const tasks = (Array.isArray(data.tasks) ? data.tasks : []).map(t => ({
    ...t,
    _start: parse(t.start),
    _end: endOf(t, hs),
    _c: byC[t.contractor] || null,
  }));
  // Per-task wrapped Works lines + row height (variable), so long names read in
  // full instead of being truncated. 3pt left inset, so usable width = w - 6.
  for (const t of tasks) {
    t._lines = wrapLines(t.name || "", COLS[0].w - 6, 8.5, MAX_NAME_LINES);
    t._h = Math.max(ROW_H, t._lines.length * LINE_H + ROW_PAD);
  }

  // Overall span (clamped like the on-screen chart so one wild date can't
  // produce a thousand pages).
  const starts = tasks.map(t => t._start).filter(Boolean).sort((a, b) => a - b);
  const anchor = starts.length ? starts[Math.floor(starts.length / 2)] : new Date();
  const near = t => t._start && Math.abs(t._start - anchor) / DAY <= 550;
  let s0 = null, e0 = null;
  for (const t of tasks) {
    if (!near(t)) continue;
    if (!s0 || t._start < s0) s0 = t._start;
    if (t._end && (!e0 || t._end > e0)) e0 = t._end;
  }
  if (!s0) { s0 = anchor; e0 = addDays(anchor, 29); }
  const totalDays = Math.min(550, Math.max(14, Math.round((addDays(e0, 2) - s0) / DAY) + 1));

  // Horizontal pagination: windows of whole days at ≥ MIN_DAY_W each.
  const maxDaysPerPage = Math.max(7, Math.floor(GRID_W / MIN_DAY_W));
  // Split the span into EQUAL windows rather than filling each page to the max
  // and leaving a stub: 77 days at 71-per-page gave a full page and a 6-day
  // sliver; balanced it gives two ~39-day pages that both fill the width.
  const nWindows = Math.max(1, Math.ceil(totalDays / maxDaysPerPage));
  const daysPerPage = Math.ceil(totalDays / nWindows);
  const windows = [];
  for (let off = 0; off < totalDays; off += daysPerPage) {
    windows.push({ from: off, days: Math.min(daysPerPage, totalDays - off) });
  }
  const headerBlockH = 89;   // room for a wrapped (2-line) contractor legend
  const footerH = 18;
  const bodyH = PH - M - headerBlockH - HDR_H - footerH - M;   // rows area per page

  // Build the page list FIRST, pairing each date window only with the tasks
  // that actually fall inside it. Previously every window was crossed with
  // every row-chunk, so a page could show (say) the December tasks against the
  // September–November columns — a full page of rows with an empty chart. A
  // window no task touches is dropped entirely rather than printed blank.
  const inWindow = (t, win) => {
    if (!t._start || !t._end) return false;
    const from = Math.round((t._start - s0) / DAY);
    const to = Math.round((t._end - s0) / DAY);
    return to >= win.from && from < win.from + win.days;
  };
  const pages = [];
  for (const win of windows) {
    const winTasks = tasks.filter(t => inWindow(t, win));
    if (!winTasks.length) continue;
    // Pack rows onto pages by their (variable) heights until the next one would
    // overflow the body area — so wrapped multi-line names never spill off page.
    let cur = [], curH = 0;
    for (const t of winTasks) {
      if (cur.length && curH + t._h > bodyH) { pages.push({ win, rows: cur }); cur = []; curH = 0; }
      cur.push(t); curH += t._h;
    }
    if (cur.length) pages.push({ win, rows: cur });
  }
  // Nothing datable at all (e.g. a programme of blank rows) — still emit one
  // page so the export is never a zero-page file.
  if (!pages.length) pages.push({ win: windows[0], rows: tasks.slice(0, Math.max(1, Math.floor(bodyH / ROW_H))) });

  const doc = new PdfDoc(PW, PH);
  let first = true;
  const totalPages = pages.length;
  let pageNo = 0;

  {   // (block kept so the page body below stays at its original indentation)
    for (const page of pages) {
      const win = page.win, rows = page.rows;
      const dayW = Math.min(16, GRID_W / win.days);
      const winStart = addDays(s0, win.from);
      pageNo++;
      if (!first) doc.newPage(PW, PH);
      first = false;

      // ── Header ─────────────────────────────────────────────────────────
      // Mostlane logo top-left; title sits to its right, legend runs full
      // width beneath (the logo is only ~30pt tall so it never overlaps).
      let tx = M;
      if (LOGO_BYTES) { try { doc.image(LOGO_BYTES, M, M - 2, LOGO_W, LOGO_H); tx = M + LOGO_W + 12; } catch (e) {} }
      let y = M + 14;
      doc.text(tx, y, meta.title || data.title || "Programme of works", { size: 15, bold: true });
      const revLbl = meta.rev ? `Rev ${meta.rev}` : "DRAFT — not issued";
      const issued = meta.issuedAt ? ` · issued ${fmtFull(new Date(meta.issuedAt))}` : "";
      doc.text(PW - M, y, revLbl + issued, { size: 9.5, bold: true, alignRight: true, color: meta.rev ? [0.09, 0.4, 0.2] : [0.72, 0.4, 0.05] });
      y += 13;
      const subBits = [meta.client, meta.site, meta.ref ? "Ref " + meta.ref : ""].filter(Boolean).join(" · ");
      if (subBits) { doc.text(tx, y, subBits, { size: 9, grey: true }); }
      doc.text(PW - M, y, `Start ${fmtFull(s0)} · End ${fmtFull(e0)} · ${Math.round((e0 - s0) / DAY) + 1} days on programme`, { size: 9, alignRight: true, grey: true });
      y += 15;
      // Legend. It WRAPS to a second line rather than running under the
      // right-hand range label — the old version reserved a flat 80pt for a
      // label nearly twice that wide, so the last contractor sat on top of it.
      const rangeLbl = windows.length > 1
        ? `Days ${win.from + 1}\u2013${win.from + win.days} of ${totalDays}  (${fmtDM(winStart)}\u2013${fmtDM(addDays(winStart, win.days - 1))})`
        : "";
      if (rangeLbl) doc.text(PW - M, y, rangeLbl, { size: 8.5, alignRight: true, grey: true });
      const LEG_LINE_H = 11;
      const legendRightL1 = PW - M - (rangeLbl ? textWidth(rangeLbl, 8.5) + 14 : 0);
      let lx = M, line = 0, dropped = 0;
      for (const c of contractors) {
        if (!c.name) continue;
        const w = 11 + textWidth(c.name, 8.5) + 14;
        const right = line === 0 ? legendRightL1 : PW - M;
        if (lx + w > right) {
          if (line === 0) { line = 1; lx = M; }          // wrap once
          else { dropped++; continue; }                   // no room for a 3rd line
        }
        const ly = y + line * LEG_LINE_H;
        doc.rect(lx, ly - 7, 8, 8, { fill: hex2rgb(c.colour) });
        doc.text(lx + 11, ly, c.name, { size: 8.5 });
        lx += w;
      }
      if (dropped) doc.text(lx, y + line * LEG_LINE_H, `+${dropped} more`, { size: 8, grey: true });
      y = M + headerBlockH;

      // ── Column headers ────────────────────────────────────────────────
      const pageRowsH = rows.reduce((a, t) => a + t._h, 0);   // variable row heights
      const gridTop = y, gridBot = gridTop + HDR_H + pageRowsH;
      doc.rect(M, gridTop, LEFT_W + win.days * dayW, HDR_H, { fill: [0.945, 0.958, 0.975] });
      let cx = M;
      for (const col of COLS) {
        doc.text(cx + 3, gridTop + 14, col.label, { size: 8, bold: true, color: [0.2, 0.28, 0.38] });
        cx += col.w;
      }
      // Day header: weekend/BH shading + a date label on every Monday (or
      // every day if the columns are wide enough).
      for (let i = 0; i < win.days; i++) {
        const d = addDays(winStart, i);
        const x = GRID_X + i * dayW;
        const we = isWeekend(d), bh = !we && hs.has(ymd(d));
        if (we) doc.rect(x, gridTop, dayW, HDR_H + pageRowsH, { fill: [0.937, 0.949, 0.963] });
        if (bh) doc.rect(x, gridTop, dayW, HDR_H + pageRowsH, { fill: [0.992, 0.953, 0.898] });
        let label = dayW >= 15 ? true : d.getUTCDay() === 1;    // Mondays (or all when roomy)
        // A label on one of the last columns would spill past the frame.
        if (label && x + 1 + textWidth(fmtDM(d), 5.8) > GRID_X + win.days * dayW) label = false;
        if (label) {
          doc.text(x + 1, gridTop + 9, fmtDM(d), { size: 5.8, color: bh ? [0.7, 0.45, 0.05] : [0.32, 0.4, 0.5] });
          doc.line(x, gridTop, x, gridBot, { stroke: [0.78, 0.82, 0.87], lw: 0.5 });
        }
        if (bh) doc.text(x + 1, gridTop + 17, "BH", { size: 5.5, color: [0.7, 0.45, 0.05] });
      }
      doc.line(M, gridTop, M + LEFT_W + win.days * dayW, gridTop, { stroke: [0.7, 0.75, 0.8] });
      doc.line(M, gridTop + HDR_H, M + LEFT_W + win.days * dayW, gridTop + HDR_H, { stroke: [0.7, 0.75, 0.8] });

      // ── Rows ──────────────────────────────────────────────────────────
      let ry = gridTop + HDR_H;
      rows.forEach((t) => {
        const rh = t._h;
        const col = t._c ? hex2rgb(t._c.colour) : [0.55, 0.62, 0.7];
        // Works name — wrapped onto as many lines as it needs.
        (t._lines || [t.name || ""]).forEach((ln, li) => doc.text(M + 3, ry + 10.5 + li * LINE_H, ln, { size: 8.5 }));
        if (t._c) {
          doc.rect(M + COLS[0].w + 2, ry + 3.5, 7, 7, { fill: col });
          doc.text(M + COLS[0].w + 12, ry + 10.5, fitText(t._c.name, COLS[1].w - 16, 8), { size: 8 });
        }
        if (t._start) doc.text(M + COLS[0].w + COLS[1].w + 3, ry + 10.5, fmtDM(t._start), { size: 8 });
        if (t._end) doc.text(M + COLS[0].w + COLS[1].w + COLS[2].w + 3, ry + 10.5, fmtDM(t._end), { size: 8, color: [0.05, 0.45, 0.42] });
        doc.text(M + LEFT_W - 5, ry + 10.5, String(Math.max(1, Number(t.days) || 1)) + (t.wknd ? "*" : ""), { size: 8, alignRight: true });
        doc.line(M, ry + rh, M + LEFT_W + win.days * dayW, ry + rh, { stroke: [0.9, 0.92, 0.95], lw: 0.4 });

        // bars — runs of worked days clipped to this window
        if (t._start && t._end) {
          const marked = [];
          for (let d = t._start; d <= t._end; d = addDays(d, 1)) {
            if (!t.wknd && nonWork(d, hs)) continue;
            const off = Math.round((d - winStart) / DAY);
            if (off >= 0 && off < win.days) marked.push(off);
          }
          if (t.milestone && marked.length) {
            const x = GRID_X + marked[0] * dayW + dayW / 2, cy = ry + rh / 2;
            doc.poly([[x, cy - 4.5], [x + 4.5, cy], [x, cy + 4.5], [x - 4.5, cy]], { fill: col });
          } else {
            const bh = ROW_H - 5;
            const barTop = ry + (rh - bh) / 2;   // centre the bar in a (possibly taller) row
            let i = 0;
            while (i < marked.length) {
              let j = i;
              while (j + 1 < marked.length && marked[j + 1] === marked[j] + 1) j++;
              const bw = (j - i + 1) * dayW - 1;
              // Cap the corner radius by the bar's own width. At a fully
              // rounded bh/2 a one-day bar (~8pt wide, 9.5pt tall) came out as
              // a circular blob you couldn't read off the date grid.
              const r = Math.max(1, Math.min(2.5, bh / 2, bw / 2));
              doc.roundRect(GRID_X + marked[i] * dayW + 0.5, barTop, bw, bh, r, { fill: col });
              i = j + 1;
            }
          }
        }
        ry += rh;
      });
      // frame
      doc.rect(M, gridTop, LEFT_W + win.days * dayW, HDR_H + pageRowsH, { stroke: [0.7, 0.75, 0.8], lw: 0.8 });
      doc.line(GRID_X, gridTop, GRID_X, gridBot, { stroke: [0.7, 0.75, 0.8] });

      // ── Footer ────────────────────────────────────────────────────────
      const fy = PH - M + 6;
      const wm = `Prepared by Mostlane Construction · ${revLbl}${issued}${meta.sharedWith ? " · shared with " + meta.sharedWith : ""}`;
      doc.text(M, fy, wm + (tasks.some(t => t.wknd) ? "   (* works weekends & bank holidays)" : ""), { size: 7.5, grey: true });
      doc.text(PW - M, fy, `Page ${pageNo} of ${totalPages}`, { size: 7.5, alignRight: true, grey: true });
    }
  }

  // Notes & items to discuss — its own page. Free-text notes, then plain note
  // bullets, then a highlighted "To discuss" list.
  const notes = String(data.notes || meta.notes || "").trim();
  const items = Array.isArray(data.noteItems) ? data.noteItems.filter(n => n && String(n.text || "").trim()) : [];
  if (notes || items.length) {
    doc.newPage(PW, PH);
    let ny = M + 14;
    const RIGHT = PW - M;
    const guard = () => { if (ny > PH - M - 6) { doc.newPage(PW, PH); ny = M + 14; } };
    const para = (text, x, size, opts) => {
      opts = opts || {};
      const words = String(text).split(/\s+/);
      let line = "";
      for (const w of words) {
        const test = line ? line + " " + w : w;
        if (textWidth(test, size) > RIGHT - x) { guard(); doc.text(x, ny, line, { size, ...opts }); ny += size + 4; line = w; }
        else line = test;
      }
      if (line) { guard(); doc.text(x, ny, line, { size, ...opts }); ny += size + 4; }
    };
    const bullet = (text, size) => { guard(); doc.text(M, ny, "•", { size }); para(text, M + 12, size); };

    doc.text(M, ny, "Notes", { size: 12, bold: true }); ny += 18;
    if (notes) { para(notes, M, 10); ny += 6; }
    const plain = items.filter(n => !n.discuss), disc = items.filter(n => n.discuss);
    for (const n of plain) bullet(String(n.text).trim(), 10);
    if (disc.length) {
      ny += 8; guard();
      doc.text(M, ny, "To discuss", { size: 11, bold: true }); ny += 16;
      for (const n of disc) bullet(String(n.text).trim(), 10);
    }
    doc.text(M, PH - M + 6, `Prepared by Mostlane Construction`, { size: 7.5, grey: true });
  }

  return doc.bytes();
}
