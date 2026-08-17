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
const ROW_H = 14.5;
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
  const daysPerPage = Math.max(7, Math.floor(GRID_W / MIN_DAY_W));
  const windows = [];
  for (let off = 0; off < totalDays; off += daysPerPage) {
    windows.push({ from: off, days: Math.min(daysPerPage, totalDays - off) });
  }
  const headerBlockH = 78;
  const footerH = 18;
  const rowsPerPage = Math.max(8, Math.floor((PH - M - headerBlockH - HDR_H - footerH - M) / ROW_H));
  const rowChunks = [];
  for (let i = 0; i < Math.max(1, tasks.length); i += rowsPerPage) {
    rowChunks.push(tasks.slice(i, i + rowsPerPage));
  }

  const doc = new PdfDoc(PW, PH);
  let first = true;
  const totalPages = windows.length * rowChunks.length;
  let pageNo = 0;

  for (const win of windows) {
    const dayW = Math.min(16, GRID_W / win.days);
    const winStart = addDays(s0, win.from);
    for (const rows of rowChunks) {
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
      // Legend
      let lx = M;
      for (const c of contractors) {
        if (!c.name) continue;
        doc.rect(lx, y - 7, 8, 8, { fill: hex2rgb(c.colour) });
        doc.text(lx + 11, y, c.name, { size: 8.5 });
        lx += 11 + textWidth(c.name, 8.5) + 14;
        if (lx > PW - M - 80) break;
      }
      if (windows.length > 1) {
        doc.text(PW - M, y, `Days ${win.from + 1}–${win.from + win.days} of ${totalDays}  (${fmtDM(winStart)} → ${fmtDM(addDays(winStart, win.days - 1))})`, { size: 8.5, alignRight: true, grey: true });
      }
      y = M + headerBlockH;

      // ── Column headers ────────────────────────────────────────────────
      const gridTop = y, gridBot = gridTop + HDR_H + rows.length * ROW_H;
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
        if (we) doc.rect(x, gridTop, dayW, HDR_H + rows.length * ROW_H, { fill: [0.937, 0.949, 0.963] });
        if (bh) doc.rect(x, gridTop, dayW, HDR_H + rows.length * ROW_H, { fill: [0.992, 0.953, 0.898] });
        const label = dayW >= 15 ? true : d.getUTCDay() === 1;   // Mondays (or all when roomy)
        if (label) {
          doc.text(x + 1, gridTop + 9, fmtDM(d), { size: 5.8, color: bh ? [0.7, 0.45, 0.05] : [0.32, 0.4, 0.5] });
          doc.line(x, gridTop, x, gridBot, { stroke: [0.78, 0.82, 0.87], lw: 0.5 });
        }
        if (bh) doc.text(x + 1, gridTop + 17, "BH", { size: 5.5, color: [0.7, 0.45, 0.05] });
      }
      doc.line(M, gridTop, M + LEFT_W + win.days * dayW, gridTop, { stroke: [0.7, 0.75, 0.8] });
      doc.line(M, gridTop + HDR_H, M + LEFT_W + win.days * dayW, gridTop + HDR_H, { stroke: [0.7, 0.75, 0.8] });

      // ── Rows ──────────────────────────────────────────────────────────
      rows.forEach((t, ri) => {
        const ry = gridTop + HDR_H + ri * ROW_H;
        const col = t._c ? hex2rgb(t._c.colour) : [0.55, 0.62, 0.7];
        // left cells
        doc.text(M + 3, ry + 10.5, fitText(t.name, COLS[0].w - 8, 8.5), { size: 8.5 });
        if (t._c) {
          doc.rect(M + COLS[0].w + 2, ry + 3.5, 7, 7, { fill: col });
          doc.text(M + COLS[0].w + 12, ry + 10.5, fitText(t._c.name, COLS[1].w - 16, 8), { size: 8 });
        }
        if (t._start) doc.text(M + COLS[0].w + COLS[1].w + 3, ry + 10.5, fmtDM(t._start), { size: 8 });
        if (t._end) doc.text(M + COLS[0].w + COLS[1].w + COLS[2].w + 3, ry + 10.5, fmtDM(t._end), { size: 8, color: [0.05, 0.45, 0.42] });
        doc.text(M + LEFT_W - 5, ry + 10.5, String(Math.max(1, Number(t.days) || 1)) + (t.wknd ? "*" : ""), { size: 8, alignRight: true });
        doc.line(M, ry + ROW_H, M + LEFT_W + win.days * dayW, ry + ROW_H, { stroke: [0.9, 0.92, 0.95], lw: 0.4 });

        // bars — runs of worked days clipped to this window
        if (t._start && t._end) {
          const marked = [];
          for (let d = t._start; d <= t._end; d = addDays(d, 1)) {
            if (!t.wknd && nonWork(d, hs)) continue;
            const off = Math.round((d - winStart) / DAY);
            if (off >= 0 && off < win.days) marked.push(off);
          }
          if (t.milestone && marked.length) {
            const x = GRID_X + marked[0] * dayW + dayW / 2, cy = ry + ROW_H / 2;
            doc.poly([[x, cy - 4.5], [x + 4.5, cy], [x, cy + 4.5], [x - 4.5, cy]], { fill: col });
          } else {
            let i = 0;
            while (i < marked.length) {
              let j = i;
              while (j + 1 < marked.length && marked[j + 1] === marked[j] + 1) j++;
              const bh = ROW_H - 5;
              doc.roundRect(GRID_X + marked[i] * dayW + 0.5, ry + 2.5, (j - i + 1) * dayW - 1, bh, bh / 2, { fill: col });
              i = j + 1;
            }
          }
        }
      });
      // frame
      doc.rect(M, gridTop, LEFT_W + win.days * dayW, HDR_H + rows.length * ROW_H, { stroke: [0.7, 0.75, 0.8], lw: 0.8 });
      doc.line(GRID_X, gridTop, GRID_X, gridBot, { stroke: [0.7, 0.75, 0.8] });

      // ── Footer ────────────────────────────────────────────────────────
      const fy = PH - M + 6;
      const wm = `Prepared by Mostlane Construction · ${revLbl}${issued}${meta.sharedWith ? " · shared with " + meta.sharedWith : ""}`;
      doc.text(M, fy, wm + (tasks.some(t => t.wknd) ? "   (* works weekends & bank holidays)" : ""), { size: 7.5, grey: true });
      doc.text(PW - M, fy, `Page ${pageNo} of ${totalPages}`, { size: 7.5, alignRight: true, grey: true });
    }
  }

  // Notes block on the last page if there's room, else its own page.
  const notes = String(data.notes || meta.notes || "").trim();
  if (notes) {
    doc.newPage(PW, PH);
    doc.text(M, M + 14, "Notes", { size: 12, bold: true });
    const words = notes.split(/\s+/);
    let line = "", ny = M + 32;
    for (const w of words) {
      if (textWidth(line + " " + w, 10) > PW - 2 * M) { doc.text(M, ny, line, { size: 10 }); ny += 14; line = w; }
      else line = line ? line + " " + w : w;
    }
    if (line) doc.text(M, ny, line, { size: 10 });
    doc.text(M, PH - M + 6, `Prepared by Mostlane Construction`, { size: 7.5, grey: true });
  }

  return doc.bytes();
}
