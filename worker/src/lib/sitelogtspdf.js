// SiteLog timesheet PDF — one document per period (a day or a Mon–Sun week).
// Page 1 = a summary of everyone's hours; then one page (or more) per person
// listing every visit with a green tick / red cross for whether the sign-in and
// the sign-out were GPS-verified at the site. Missed sign-outs (auto-closed by
// the system) and people still on site are highlighted on their row.
//
// WinAnsi fonts carry no tick/cross glyphs, so the marks are DRAWN (shapes).
//
//   buildSiteLogTimesheetPdf({ title, periodLabel, generatedAt, people, logo })
//   people: [{ name, company, visits: [{ date, site, inTime, outTime, mins,
//             inOk, outOk, inDist, outDist, state, note }] }]
//   state: "ok" | "open" | "auto" | "moved" | "manual" | "scanned" (scanned but not confirmed)
import { PdfDoc, textWidth } from "./pdf.js";

const PW = 842, PH = 595;              // A4 landscape — room for long site names
const M = 36;
const NAVY = [0, 0.2, 0.4];
const GREEN = [0.086, 0.639, 0.290];
const RED = [0.863, 0.149, 0.149];
const AMBER = [0.851, 0.467, 0.024];
const ROW_RED = [0.996, 0.937, 0.937];
const ROW_AMBER = [1, 0.969, 0.898];
const ZEBRA = [0.973, 0.976, 0.984];
const PURPLE = [0.486, 0.228, 0.929];
const ROW_PURPLE = [0.953, 0.937, 1];
const GRID = [0.85, 0.87, 0.9];

function fit(str, size, max) {
  str = String(str == null ? "" : str);
  if (textWidth(str, size) <= max) return str;
  while (str.length > 1 && textWidth(str + "...", size) > max) str = str.slice(0, -1);
  return str.trimEnd() + "...";
}
export function fmtHM(mins) {
  mins = Math.max(0, Math.round(Number(mins) || 0));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

// Green circle + tick, or red circle + cross. (cx, cy) = centre, top-based.
function mark(doc, cx, cy, ok) {
  const r = 5.2;
  doc.roundRect(cx - r, cy - r, r * 2, r * 2, r, { fill: ok ? GREEN : RED });
  const w = [1, 1, 1];
  if (ok) {
    doc.line(cx - 2.6, cy + 0.2, cx - 0.7, cy + 2.2, { stroke: w, lw: 1.4 });
    doc.line(cx - 0.7, cy + 2.2, cx + 2.8, cy - 2.2, { stroke: w, lw: 1.4 });
  } else {
    doc.line(cx - 2.2, cy - 2.2, cx + 2.2, cy + 2.2, { stroke: w, lw: 1.4 });
    doc.line(cx - 2.2, cy + 2.2, cx + 2.2, cy - 2.2, { stroke: w, lw: 1.4 });
  }
}

function header(doc, meta, subtitle) {
  doc.rect(0, 0, PW, 58, { fill: NAVY });
  if (meta.logo) { try { doc.image(meta.logo, M, 12, 85, 34); } catch (e) {} }
  const x0 = meta.logo ? M + 98 : M;
  doc.text(x0, 28, meta.title || "SiteLog timesheet", { size: 16, bold: true, color: [1, 1, 1] });
  doc.text(x0, 45, subtitle || meta.periodLabel || "", { size: 10, color: [0.85, 0.9, 1] });
  doc.text(PW - M, 28, meta.periodLabel || "", { size: 11, bold: true, color: [1, 1, 1], alignRight: true });
  return 80;
}

function legend(doc, y) {
  mark(doc, M + 5, y - 3, true);
  doc.text(M + 14, y, "GPS verified at the site", { size: 8.5, grey: true });
  mark(doc, M + 135, y - 3, false);
  doc.text(M + 144, y, "Not verified (no location, auto sign-out, or edited by the office)", { size: 8.5, grey: true });
  doc.rect(M + 418, y - 8, 10, 8, { fill: ROW_RED, stroke: [0.95, 0.7, 0.7], lw: 0.5 });
  doc.text(M + 432, y, "Missed sign-out", { size: 8.5, grey: true });
  doc.rect(M + 512, y - 8, 10, 8, { fill: ROW_AMBER, stroke: [0.95, 0.82, 0.6], lw: 0.5 });
  doc.text(M + 526, y, "Still signed in", { size: 8.5, grey: true });
  doc.rect(M + 606, y - 8, 10, 8, { fill: ROW_PURPLE, stroke: [0.8, 0.72, 0.98], lw: 0.5 });
  doc.text(M + 620, y, "Scanned but not confirmed", { size: 8.5, grey: true });
}

export function personTotals(p) {
  let mins = 0, autoMins = 0, missed = 0, open = 0, unver = 0, scanned = 0;
  for (const v of p.visits) {
    if (v.state === "scanned") scanned++;
    if (v.state !== "open") mins += v.mins || 0;
    if (v.state === "auto") { missed++; autoMins += v.mins || 0; }
    if (v.state === "open") open++;
    if (!v.inOk) unver++;
    if (v.state !== "open" && !v.outOk) unver++;
  }
  return { mins, autoMins, missed, open, unver, scanned, visits: p.visits.length };
}

function summaryPage(doc, meta, people) {
  let y = header(doc, meta, "Summary — everyone");
  const cols = [
    { k: "name", x: M, w: 200, label: "Person" },
    { k: "company", x: M + 205, w: 150, label: "Company" },
    { k: "visits", x: M + 410, label: "Visits", right: true },
    { k: "hours", x: M + 500, label: "Hours on site", right: true },
    { k: "missed", x: M + 600, label: "Missed sign-outs", right: true },
    { k: "open", x: M + 680, label: "Still in", right: true },
    { k: "unver", x: PW - M - 6, label: "Not verified", right: true },
  ];
  const head = () => {
    doc.rect(M, y, PW - 2 * M, 18, { fill: [0.92, 0.94, 0.97] });
    for (const c of cols) doc.text(c.x + (c.right ? 0 : 4), y + 12.5, c.label, { size: 8.5, bold: true, alignRight: !!c.right });
    y += 18;
  };
  head();
  const tot = { mins: 0, missed: 0, open: 0, unver: 0, visits: 0 };
  people.forEach((p, i) => {
    if (y > PH - 70) { doc.newPage(PW, PH); y = header(doc, meta, "Summary — everyone (continued)"); head(); }
    const t = personTotals(p);
    tot.mins += t.mins; tot.missed += t.missed; tot.open += t.open; tot.unver += t.unver; tot.visits += t.visits;
    const bad = t.missed || t.unver || t.scanned;
    doc.rect(M, y, PW - 2 * M, 18, { fill: t.missed ? ROW_RED : t.scanned ? ROW_PURPLE : bad ? ROW_RED : (i % 2 ? ZEBRA : [1, 1, 1]) });
    doc.text(M + 4, y + 12.5, fit(p.name, 9.5, 195), { size: 9.5, bold: true });
    doc.text(M + 209, y + 12.5, fit(p.company || "", 9, 190), { size: 9, grey: true });
    doc.text(M + 410, y + 12.5, String(t.visits), { size: 9.5, alignRight: true });
    doc.text(M + 500, y + 12.5, fmtHM(t.mins), { size: 9.5, bold: true, alignRight: true });
    doc.text(M + 600, y + 12.5, String(t.missed), { size: 9.5, bold: !!t.missed, alignRight: true, color: t.missed ? RED : null });
    doc.text(M + 680, y + 12.5, String(t.open), { size: 9.5, alignRight: true, color: t.open ? AMBER : null });
    doc.text(PW - M - 6, y + 12.5, String(t.unver), { size: 9.5, bold: !!t.unver, alignRight: true, color: t.unver ? RED : null });
    y += 18;
  });
  if (!people.length) {
    doc.text(M + 4, y + 16, "Nobody signed in to a site in this period.", { size: 10, grey: true });
    y += 24;
  }
  doc.hr(M, y + 2, PW - M);
  doc.text(M + 4, y + 16, "Total", { size: 10, bold: true });
  doc.text(M + 410, y + 16, String(tot.visits), { size: 10, bold: true, alignRight: true });
  doc.text(M + 500, y + 16, fmtHM(tot.mins), { size: 10, bold: true, alignRight: true });
  doc.text(M + 600, y + 16, String(tot.missed), { size: 10, bold: true, alignRight: true, color: tot.missed ? RED : null });
  doc.text(M + 680, y + 16, String(tot.open), { size: 10, bold: true, alignRight: true });
  doc.text(PW - M - 6, y + 16, String(tot.unver), { size: 10, bold: true, alignRight: true, color: tot.unver ? RED : null });
  y += 34;
  doc.text(M, y, "Hours on site include visits the system closed automatically (missed sign-outs) — those times are an assumption, not a scan.", { size: 8.5, grey: true });
  y += 12;
  doc.text(M, y, "Purple rows: scanned the QR code but never pressed Sign in / Sign out — the scan time is used because nothing else was recorded.", { size: 8.5, grey: true });
  legend(doc, y + 18);
}

const VC = { date: M, site: M + 72, inT: M + 330, inM: M + 372, outT: M + 392, outM: M + 434, hrs: M + 505, note: M + 520 };

function personPages(doc, meta, p) {
  doc.newPage(PW, PH);
  let y = header(doc, meta, `${p.name}${p.company ? " — " + p.company : ""}`);
  const t = personTotals(p);
  // Totals strip
  const chips = [
    ["Hours on site", fmtHM(t.mins), null],
    ["Visits", String(t.visits), null],
    ["Missed sign-outs", String(t.missed), t.missed ? RED : null],
    ["Not verified", String(t.unver), t.unver ? RED : null],
  ];
  if (t.scanned) chips.push(["Scanned, not confirmed", String(t.scanned), PURPLE]);
  if (t.open) chips.push(["Still signed in", String(t.open), AMBER]);
  let cx = M;
  for (const [lab, val, col] of chips) {
    doc.roundRect(cx, y, 130, 36, 6, { fill: [0.95, 0.96, 0.98] });
    doc.text(cx + 10, y + 14, lab, { size: 8, grey: true });
    doc.text(cx + 10, y + 30, val, { size: 13, bold: true, color: col });
    cx += 140;
  }
  y += 52;
  const head = () => {
    doc.rect(M, y, PW - 2 * M, 18, { fill: [0.92, 0.94, 0.97] });
    const h = (x, s, r) => doc.text(x, y + 12.5, s, { size: 8.5, bold: true, alignRight: !!r });
    h(VC.date + 4, "Date"); h(VC.site, "Site"); h(VC.inT, "Signed in"); h(VC.outT, "Signed out");
    h(VC.hrs, "Hours", true); h(VC.note, "Notes");
    y += 18;
  };
  head();
  let lastDate = "";
  p.visits.forEach((v, i) => {
    if (y > PH - 56) { doc.newPage(PW, PH); y = header(doc, meta, `${p.name} (continued)`); head(); lastDate = ""; }
    const bg = v.state === "scanned" ? ROW_PURPLE : v.state === "auto" ? ROW_RED : v.state === "open" ? ROW_AMBER : (i % 2 ? ZEBRA : [1, 1, 1]);
    doc.rect(M, y, PW - 2 * M, 20, { fill: bg });
    if (v.date !== lastDate) {
      doc.text(VC.date + 4, y + 13.5, v.date, { size: 9, bold: true });
      if (lastDate) doc.line(M, y, PW - M, y, { stroke: GRID, lw: 0.6 });
      lastDate = v.date;
    }
    doc.text(VC.site, y + 13.5, fit(v.site, 9.5, 250), { size: 9.5 });
    doc.text(VC.inT, y + 13.5, v.inTime || "", { size: 9.5, bold: true, color: v.scannedIn ? PURPLE : null });
    mark(doc, VC.inM, y + 10, !!v.inOk);
    if (v.state === "open" || (v.state === "scanned" && !v.outTime)) {
      doc.text(VC.outT, y + 13.5, "—", { size: 9.5, color: v.state === "open" ? AMBER : PURPLE });
    } else {
      doc.text(VC.outT, y + 13.5, v.outTime || (v.state === "scanned" ? "—" : ""), { size: 9.5, bold: true, color: v.state === "auto" ? RED : v.state === "scanned" && v.scannedOut ? PURPLE : null });
      mark(doc, VC.outM, y + 10, !!v.outOk);
    }
    doc.text(VC.hrs, y + 13.5, v.state === "open" || (v.state === "scanned" && !v.scannedOut) ? "—" : fmtHM(v.mins), { size: 9.5, alignRight: true });
    const note = v.note || "";
    if (note) doc.text(VC.note, y + 13.5, fit(note, 8.5, PW - M - VC.note - 4), {
      size: 8.5, bold: v.state === "auto" || v.state === "open" || v.state === "scanned",
      color: v.state === "scanned" ? PURPLE : v.state === "auto" ? RED : v.state === "open" ? AMBER : [0.4, 0.45, 0.5],
    });
    y += 20;
  });
  if (!p.visits.length) { doc.text(M + 4, y + 16, "No visits.", { size: 10, grey: true }); y += 24; }
  if (y < PH - 40) legend(doc, y + 22);
}

export function buildSiteLogTimesheetPdf(meta) {
  const people = meta.people || [];
  const doc = new PdfDoc(PW, PH);
  summaryPage(doc, meta, people);
  for (const p of people) personPages(doc, meta, p);
  const n = doc.pages.length;
  const gen = meta.generatedAt ? `Generated ${meta.generatedAt}` : "";
  for (let i = 0; i < n; i++) {
    doc.lineOn(i, M, PH - 26, PW - M, { grey: true });
    doc.textOn(i, M, PH - 14, `Mostlane SiteLog · ${meta.periodLabel || ""}${gen ? " · " + gen : ""}`, { size: 7.5, grey: true });
    doc.textOn(i, PW - M, PH - 14, `Page ${i + 1} of ${n}`, { size: 7.5, grey: true, alignRight: true });
  }
  return doc.bytes();
}
