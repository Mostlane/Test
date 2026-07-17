// Engineer timesheets (+ self-employed invoicing and mileage) — /ts/*
//
// Engineers enter start/finish times per day and which job(s) they were on.
// Employed staff stop there. Self-employed staff can additionally claim
// mileage (site postcode → estimated road miles) and generate a sequential,
// numbered invoice PDF which is stored in R2 and retrievable by admin.
//
//   Any session (own data):
//     GET  /ts/me                      effective settings for the caller
//     POST /ts/me                      self-service bits: homePostcode, details,
//                                      rate/rateType (admin can override later)
//     GET  /ts/my?week=<Mon>           own week (days + computed pay + invoice)
//     POST /ts/my { week, days }       save own week (blocked once invoiced)
//     GET  /ts/sites?q=                site suggestions (name + postcode)
//     GET  /ts/mileage?from=&to=       postcode → postcode estimated road miles
//     GET  /ts/invoices                own invoices (signed URLs)
//     POST /ts/invoice { week, rate? } generate + store this week's invoice PDF
//     POST /ts/invoice/next { next }   set own next invoice number
//   Admin (FullAccess | TimesheetAdmin):
//     GET  /ts/admin/overview?week=    every user's week, totals, invoice state
//     POST /ts/admin/save              edit a user's week
//     GET  /ts/admin/config            defaults + per-user settings
//     POST /ts/admin/config            save settings
//     GET  /ts/invoices?u=<user|all>   anyone's invoices
//     POST /ts/invoice/delete { id }   remove a wrong invoice (frees its number)
//   Public (signature-verified in-handler — see index.js PUBLIC_ROUTES):
//     GET  /ts/invoice-file?key=&exp=&sig=   stream an invoice PDF
//
// Pay maths per day: span = finish − start (finish ≤ start rolls past midnight),
// minus commuteMins × 2 (if that user has the commute deduction), minus
// lunchMins (if that user has the lunch deduction and span ≥ lunchThresholdH).
// All the switches live in app_config engts:cfg:<tid> — no schema changes.
//
// Mileage estimate: postcodes.io lat/lng (custom domain — worker-fetchable),
// haversine × 1.25 road factor, × 2 for the round trip. Always editable by
// the engineer before saving — it's an estimate, not gospel.

import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { PdfDoc, textWidth } from "../lib/pdf.js";

const CFG_KEY = tid => `engts:cfg:${tid}`;
const INV_PREFIX = tid => `invoices/${tid}/`;

const isDateStr = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function weekDays(monday) {
  const base = new Date(monday + "T12:00:00Z");
  const out = [];
  for (let i = 0; i < 7; i++) { const x = new Date(base); x.setUTCDate(base.getUTCDate() + i); out.push(x.toISOString().slice(0, 10)); }
  return out;
}
const toMin = t => { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || "").trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const normPc = pc => String(pc || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const round1 = n => Math.round(n * 10) / 10;
const money = n => "£" + (Math.round(n * 100) / 100).toFixed(2);

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS eng_timesheets (
    tenant_id INTEGER NOT NULL DEFAULT 1, week TEXT NOT NULL, username TEXT NOT NULL,
    data TEXT, at TEXT, PRIMARY KEY (tenant_id, week, username))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS eng_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL, number INTEGER NOT NULL, week TEXT NOT NULL,
    hours REAL, miles REAL, labour REAL, mileage REAL, total REAL,
    r2_key TEXT, at TEXT,
    UNIQUE (tenant_id, username, number), UNIQUE (tenant_id, username, week))`).run();
}

// ── Settings (app_config JSON, per-user overrides on shared defaults) ────────
const DEFAULTS = { commuteMins: 30, lunchMins: 30, lunchThresholdH: 6, pencePerMile: 45, company: "Mostlane" };
async function getCfg(env, tid) {
  let cfg = { defaults: { ...DEFAULTS }, byUser: {} };
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(CFG_KEY(tid)).first();
    if (row && row.value) { const v = JSON.parse(row.value); cfg.defaults = Object.assign(cfg.defaults, v.defaults || {}); cfg.byUser = v.byUser || {}; }
  } catch {}
  return cfg;
}
async function saveCfg(env, tid, cfg) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, CFG_KEY(tid), JSON.stringify(cfg)).run();
}
async function userRow(env, tid, username) {
  return env.DB.prepare("SELECT username, first_name, last_name, employment_type, status, profile FROM users WHERE tenant_id=? AND username=?")
    .bind(tid, username).first();
}
function displayName(u) { return u ? ((`${u.first_name || ""} ${u.last_name || ""}`).trim() || u.username) : ""; }
function isSelfEmployed(u) { return /self/i.test(String((u && u.employment_type) || "")); }

// Effective settings for one user: shared defaults + their overrides + profile rates.
function effectiveCfg(cfg, u) {
  const mine = (cfg.byUser && cfg.byUser[u.username]) || {};
  let profile = {}; try { profile = u.profile ? JSON.parse(u.profile) : {}; } catch {}
  const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : null; };
  return {
    employment: u.employment_type || "Employed",
    selfEmployed: isSelfEmployed(u),
    commute: mine.commute === true,          // 30 mins each way deducted
    lunch: mine.lunch === true,              // 30 mins lunch deducted
    mileage: mine.mileage === true,          // may claim mileage
    commuteMins: Number(mine.commuteMins ?? cfg.defaults.commuteMins) || 30,
    lunchMins: Number(mine.lunchMins ?? cfg.defaults.lunchMins) || 30,
    lunchThresholdH: Number(mine.lunchThresholdH ?? cfg.defaults.lunchThresholdH) || 6,
    pencePerMile: Number(mine.pencePerMile ?? profile.pencePerMile ?? cfg.defaults.pencePerMile) || 45,
    rateType: mine.rateType === "day" ? "day" : "hour",
    rate: num(mine.rate) ?? (mine.rateType === "day" ? num(profile.dayRate) : num(profile.hourlyRate)) ?? num(profile.hourlyRate),
    homePostcode: String(mine.homePostcode || "").toUpperCase(),
    details: Array.isArray(mine.details) ? mine.details : [],   // extra lines under their name on the invoice
    nextNumber: Number(mine.nextNumber) || null,
  };
}

// ── Week data + pay maths ────────────────────────────────────────────────────
function cleanDays(monday, days) {
  const valid = new Set(weekDays(monday));
  const out = {};
  for (const [date, d] of Object.entries(days || {})) {
    if (!valid.has(date) || !d || typeof d !== "object") continue;
    const start = toMin(d.start) != null ? String(d.start) : "";
    const finish = toMin(d.finish) != null ? String(d.finish) : "";
    const jobs = String(d.jobs || "").slice(0, 400);
    const note = String(d.note || "").slice(0, 400);
    const mileage = (Array.isArray(d.mileage) ? d.mileage : []).slice(0, 8).map(m => ({
      site: String((m && m.site) || "").slice(0, 120),
      postcode: String((m && m.postcode) || "").toUpperCase().slice(0, 10),
      miles: Math.max(0, Math.min(1000, round1(parseFloat(m && m.miles) || 0))),
    })).filter(m => m.miles > 0 || m.site || m.postcode);
    if (start || finish || jobs || note || mileage.length) out[date] = { start, finish, jobs, note, mileage };
  }
  return out;
}
function dayCalc(d, eff) {
  const s = toMin(d.start), e0 = toMin(d.finish);
  if (s == null || e0 == null) return { span: 0, paid: 0, commute: 0, lunch: 0, worked: false, miles: dayMiles(d) };
  const e = e0 <= s ? e0 + 1440 : e0;   // finishing "past midnight" rolls to the next day
  const span = e - s;
  const commute = eff.commute ? eff.commuteMins * 2 : 0;
  const lunch = (eff.lunch && span >= eff.lunchThresholdH * 60) ? eff.lunchMins : 0;
  return { span, paid: Math.max(0, span - commute - lunch), commute, lunch, worked: true, miles: dayMiles(d) };
}
function dayMiles(d) { return round1((Array.isArray(d.mileage) ? d.mileage : []).reduce((a, m) => a + (parseFloat(m.miles) || 0), 0)); }
function weekTotals(days, eff) {
  let paidMins = 0, miles = 0, daysWorked = 0;
  for (const d of Object.values(days || {})) {
    const c = dayCalc(d, eff);
    paidMins += c.paid; miles += c.miles;
    if (c.worked) daysWorked++;
  }
  const hours = Math.round((paidMins / 60) * 100) / 100;
  const labour = eff.rate ? Math.round((eff.rateType === "day" ? daysWorked * eff.rate : hours * eff.rate) * 100) / 100 : null;
  const mileagePay = Math.round(miles * eff.pencePerMile) / 100;
  return { paidMins, hours, miles: round1(miles), daysWorked, labour, mileagePay,
    total: labour != null ? Math.round((labour + mileagePay) * 100) / 100 : null };
}
async function loadWeek(env, tid, username, monday) {
  const row = await env.DB.prepare("SELECT data, at FROM eng_timesheets WHERE tenant_id=? AND week=? AND username=?")
    .bind(tid, monday, username).first();
  let days = {}; try { days = row && row.data ? (JSON.parse(row.data).days || {}) : {}; } catch {}
  return { days, savedAt: row ? row.at : null };
}
async function invoiceFor(env, tid, username, monday) {
  return env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND username=? AND week=?").bind(tid, username, monday).first();
}
async function nextInvoiceNumber(env, tid, username, eff) {
  const row = await env.DB.prepare("SELECT MAX(number) AS m FROM eng_invoices WHERE tenant_id=? AND username=?").bind(tid, username).first();
  const max = row && row.m != null ? Number(row.m) : 0;
  return Math.max(max + 1, eff.nextNumber || 1);
}
async function isTsAdmin(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes" || p.TimesheetAdmin === "Yes";
}

// ── Mileage estimate (postcodes.io + haversine × road factor) ────────────────
async function lookupPostcode(pc) {
  const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(normPc(pc)), {
    headers: { "Accept": "application/json" },
    cf: { cacheTtl: 30 * 86400, cacheEverything: true } });   // postcodes don't move — cache at the edge
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const res = j && j.result;
  return res && res.latitude != null ? { lat: res.latitude, lng: res.longitude, pc: res.postcode } : null;
}
function haversineMiles(a, b) {
  const rad = x => x * Math.PI / 180, R = 3958.8;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const ROAD_FACTOR = 1.25;

// ── Invoice PDF ──────────────────────────────────────────────────────────────
function fmtDate(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
function fmtHm(mins) { return Math.floor(mins / 60) + "h " + String(Math.round(mins % 60)).padStart(2, "0") + "m"; }
function buildInvoicePdf({ number, name, details, company, monday, days, eff, totals }) {
  const doc = new PdfDoc();
  const L = 48, R = 547;
  let y = 64;
  doc.text(L, y, "INVOICE", { size: 22, bold: true });
  doc.text(R, y - 8, "Invoice no. " + number, { size: 12, bold: true, alignRight: true });
  doc.text(R, y + 8, "Date: " + fmtDate(new Date().toISOString().slice(0, 10)), { size: 10, alignRight: true, grey: true });
  y += 34;
  doc.text(L, y, "From", { size: 9, grey: true }); doc.text(R, y, "To", { size: 9, grey: true, alignRight: true });
  y += 14;
  doc.text(L, y, name, { size: 11, bold: true });
  const toLines = String(company || "Mostlane").split(/\n/).filter(Boolean);
  let ty = y;
  for (const ln of toLines) { doc.text(R, ty, ln.trim(), { size: ty === y ? 11 : 10, bold: ty === y, alignRight: true }); ty += 14; }
  for (const ln of (details || []).slice(0, 5)) { y += 14; doc.text(L, y, String(ln).slice(0, 60), { size: 10 }); }
  y = Math.max(y, ty - 14) + 24;
  doc.text(L, y, "Week: " + fmtDate(monday) + " – " + fmtDate(weekDays(monday)[6]), { size: 10, bold: true });
  y += 16; doc.hr(L, y, R); y += 16;

  // Table header
  const cDate = L, cDesc = L + 78, cHours = 425, cAmt = R;
  doc.text(cDate, y, "Date", { size: 9, bold: true, grey: true });
  doc.text(cDesc, y, "Details", { size: 9, bold: true, grey: true });
  doc.text(cHours, y, "Hours", { size: 9, bold: true, grey: true, alignRight: true });
  doc.text(cAmt, y, "Amount", { size: 9, bold: true, grey: true, alignRight: true });
  y += 6; doc.hr(L, y, R, { grey: true }); y += 15;

  const fitDesc = (s, max) => { let t = String(s || ""); while (t && textWidth(t, 10) > max) t = t.slice(0, -1); return t; };
  const perHourAmount = mins => eff.rate && eff.rateType === "hour" ? money((mins / 60) * eff.rate) : "";
  for (const date of weekDays(monday)) {
    const d = days[date]; if (!d) continue;
    const c = dayCalc(d, eff);
    if (!c.worked && !c.miles) continue;
    if (c.worked) {
      doc.text(cDate, y, new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), { size: 10 });
      const dedNote = [c.commute ? "-" + c.commute + "m travel" : "", c.lunch ? "-" + c.lunch + "m lunch" : ""].filter(Boolean).join(", ");
      doc.text(cDesc, y, fitDesc((d.jobs || "Site work") + (dedNote ? "  (" + dedNote + ")" : ""), cHours - cDesc - 40), { size: 10 });
      doc.text(cHours, y, fmtHm(c.paid), { size: 10, alignRight: true });
      doc.text(cAmt, y, perHourAmount(c.paid), { size: 10, alignRight: true });
      y += 15;
    }
    for (const m of (d.mileage || [])) {
      if (!(parseFloat(m.miles) > 0)) continue;
      doc.text(cDesc, y, fitDesc("Mileage — " + (m.site || m.postcode || "site") + " (" + m.miles + " mi @ " + eff.pencePerMile + "p)", cHours - cDesc - 40), { size: 10, grey: true });
      doc.text(cAmt, y, money(m.miles * eff.pencePerMile / 100), { size: 10, alignRight: true });
      y += 15;
    }
    if (y > 720) { doc.newPage(); y = 60; }
  }
  y += 4; doc.hr(L, y, R); y += 18;
  if (eff.rateType === "day" && eff.rate) {
    doc.text(cHours, y, "Labour: " + totals.daysWorked + " day(s) @ " + money(eff.rate), { size: 10 });
    doc.text(cAmt, y, money(totals.labour || 0), { size: 10, alignRight: true }); y += 16;
  } else {
    doc.text(cHours, y, "Labour: " + totals.hours + " h" + (eff.rate ? " @ " + money(eff.rate) + "/h" : ""), { size: 10 });
    doc.text(cAmt, y, totals.labour != null ? money(totals.labour) : "", { size: 10, alignRight: true }); y += 16;
  }
  if (totals.miles > 0) {
    doc.text(cHours, y, "Mileage: " + totals.miles + " mi @ " + eff.pencePerMile + "p");
    doc.text(cAmt, y, money(totals.mileagePay), { size: 10, alignRight: true }); y += 16;
  }
  y += 6;
  doc.text(cHours, y, "TOTAL", { size: 12, bold: true });
  doc.text(cAmt, y, money(totals.total || 0), { size: 12, bold: true, alignRight: true });
  y += 30;
  doc.text(L, y, "Generated via the Mostlane Portal on " + new Date().toISOString().slice(0, 10) + ".", { size: 8, grey: true });
  return doc.bytes();
}

// ── Handler ──────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/ts(?=\/|$)/, "") || "/";
  const q = url.searchParams;
  const headers = corsHeaders(env, request);

  // ── Stream an invoice PDF (public, but access-gated by the signature) ─────
  if (sub === "/invoice-file" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("invoices/")) return error("Bad key", 400, env, request);
    if (!sess && !(await verifyFileSig(env, key, q))) return error("Link expired or invalid", 403, env, request);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": "application/pdf", "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId;
  const me = sess.user.username;
  await ensureTables(env);
  const cfg = await getCfg(env, tid);

  // ── GET /ts/me — the caller's effective settings ──────────────────────────
  if (sub === "/me" && method === "GET") {
    const u = await userRow(env, tid, me);
    if (!u) return error("User not found", 404, env, request);
    const eff = effectiveCfg(cfg, u);
    const next = await nextInvoiceNumber(env, tid, me, eff);
    const admin = await isTsAdmin(env, tid, sess);
    const invCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM eng_invoices WHERE tenant_id=? AND username=?").bind(tid, me).first();
    return json({ ok: true, name: displayName(u), ...eff, rate: eff.rate, nextInvoice: next,
      canSetNumber: !invCount || Number(invCount.n) === 0, admin }, {}, env, request);
  }

  // ── POST /ts/me — self-service settings (postcode, invoice details, rate) ─
  if (sub === "/me" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const mine = cfg.byUser[me] || (cfg.byUser[me] = {});
    if ("homePostcode" in b) mine.homePostcode = String(b.homePostcode || "").toUpperCase().slice(0, 10);
    if ("details" in b) mine.details = (Array.isArray(b.details) ? b.details : String(b.details || "").split(/\n/))
      .map(s => String(s).trim()).filter(Boolean).slice(0, 5);
    if ("rate" in b) { const n = parseFloat(b.rate); if (isFinite(n) && n >= 0) mine.rate = n; }
    if ("rateType" in b && (b.rateType === "hour" || b.rateType === "day")) mine.rateType = b.rateType;
    await saveCfg(env, tid, cfg);
    return json({ ok: true }, {}, env, request);
  }

  // ── GET /ts/my — own week ─────────────────────────────────────────────────
  if (sub === "/my" && method === "GET") {
    const monday = mondayOf(isDateStr(q.get("week")) ? q.get("week") : new Date().toISOString().slice(0, 10));
    const u = await userRow(env, tid, me);
    const eff = effectiveCfg(cfg, u);
    const { days, savedAt } = await loadWeek(env, tid, me, monday);
    const inv = await invoiceFor(env, tid, me, monday);
    return json({ ok: true, week: monday, days, savedAt, totals: weekTotals(days, eff),
      invoice: inv ? { number: inv.number, total: inv.total, at: inv.at,
        url: await signedFileUrl(env, url.origin, "/ts/invoice-file", inv.r2_key) } : null }, {}, env, request);
  }

  // ── POST /ts/my — save own week ───────────────────────────────────────────
  if (sub === "/my" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!isDateStr(b.week)) return error("week (Monday, YYYY-MM-DD) required", 400, env, request);
    const monday = mondayOf(b.week);
    if (await invoiceFor(env, tid, me, monday))
      return error("This week has already been invoiced — ask the office to remove the invoice first.", 409, env, request);
    const days = cleanDays(monday, b.days);
    await env.DB.prepare(
      "INSERT INTO eng_timesheets (tenant_id, week, username, data, at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, week, username) DO UPDATE SET data=excluded.data, at=excluded.at"
    ).bind(tid, monday, me, JSON.stringify({ days }), new Date().toISOString()).run();
    const u = await userRow(env, tid, me);
    return json({ ok: true, week: monday, totals: weekTotals(days, effectiveCfg(cfg, u)) }, {}, env, request);
  }

  // ── GET /ts/sites — suggestion list for the mileage site picker ───────────
  if (sub === "/sites" && method === "GET") {
    const term = String(q.get("q") || "").trim();
    const like = "%" + term.replace(/[%_]/g, "") + "%";
    const { results } = await env.DB.prepare(
      "SELECT site_name, site_number, postcode FROM sites WHERE tenant_id=? AND active=1 AND (site_name LIKE ? OR postcode LIKE ? OR site_number LIKE ?) ORDER BY site_name LIMIT 15"
    ).bind(tid, like, like, like).all();
    return json({ ok: true, sites: (results || []).map(s => ({
      name: s.site_name || ("Site " + s.site_number), code: s.site_number, postcode: (s.postcode || "").replace(/\*+$/, "") })) }, {}, env, request);
  }

  // ── GET /ts/jobs — suggestions for the "job(s)" box ───────────────────────
  // Two sources, both already in the portal D1: project job numbers on sites
  // (the same list the PO system mirrors), and open live SLA jobs.
  if (sub === "/jobs" && method === "GET") {
    const term = String(q.get("q") || "").trim();
    if (term.length < 2) return json({ ok: true, jobs: [] }, {}, env, request);
    const like = "%" + term.replace(/[%_]/g, "") + "%";
    const jobs = [];
    try {
      const { results } = await env.DB.prepare(
        "SELECT helpdesk_ref, description, status FROM sla_jobs WHERE tenant_id=? AND helpdesk_ref IS NOT NULL AND helpdesk_ref!='' AND status NOT IN ('Complete','Closed') AND (helpdesk_ref LIKE ? OR description LIKE ?) ORDER BY raised_at DESC LIMIT 8"
      ).bind(tid, like, like).all();
      for (const r of results || []) jobs.push({ ref: r.helpdesk_ref, label: r.helpdesk_ref + " — " + String(r.description || "").slice(0, 48), kind: "sla" });
    } catch {}
    try {
      const { results } = await env.DB.prepare(
        "SELECT job_number, site_name, client FROM sites WHERE tenant_id=? AND active=1 AND job_number IS NOT NULL AND job_number!='' AND (job_number LIKE ? OR site_name LIKE ?) ORDER BY site_name LIMIT 8"
      ).bind(tid, like, like).all();
      for (const r of results || []) jobs.push({ ref: String(r.job_number), label: r.job_number + " — " + (r.site_name || r.client || "site"), kind: "project" });
    } catch {}
    // Exact/prefix matches float to the top; cap the list for the dropdown.
    const T = term.toLowerCase();
    jobs.sort((a, b) => {
      const pa = String(a.ref).toLowerCase().startsWith(T) ? 0 : 1;
      const pb = String(b.ref).toLowerCase().startsWith(T) ? 0 : 1;
      return pa - pb;
    });
    return json({ ok: true, jobs: jobs.slice(0, 10) }, {}, env, request);
  }

  // ── GET /ts/mileage — estimated road miles between two postcodes ──────────
  if (sub === "/mileage" && method === "GET") {
    const from = q.get("from"), to = q.get("to");
    if (!from || !to) return error("from and to postcodes required", 400, env, request);
    const [a, b] = await Promise.all([lookupPostcode(from), lookupPostcode(to)]);
    if (!a) return error("Couldn't find postcode " + String(from).toUpperCase(), 404, env, request);
    if (!b) return error("Couldn't find postcode " + String(to).toUpperCase(), 404, env, request);
    const oneWay = round1(haversineMiles(a, b) * ROAD_FACTOR);
    return json({ ok: true, from: a.pc, to: b.pc, oneWay, roundTrip: round1(oneWay * 2) }, {}, env, request);
  }

  // ── Invoices ──────────────────────────────────────────────────────────────
  if (sub === "/invoice/next" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const next = parseInt(b.next, 10);
    if (!next || next < 1 || next > 99999999) return error("Send a whole number, e.g. { next: 100 }", 400, env, request);
    const row = await env.DB.prepare("SELECT MAX(number) AS m FROM eng_invoices WHERE tenant_id=? AND username=?").bind(tid, me).first();
    if (row && row.m != null && next <= Number(row.m))
      return error("Your invoices are already up to number " + row.m + " — the next number must be higher.", 400, env, request);
    (cfg.byUser[me] || (cfg.byUser[me] = {})).nextNumber = next;
    await saveCfg(env, tid, cfg);
    return json({ ok: true, next }, {}, env, request);
  }

  if (sub === "/invoice" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!isDateStr(b.week)) return error("week required", 400, env, request);
    const monday = mondayOf(b.week);
    const u = await userRow(env, tid, me);
    if (!isSelfEmployed(u)) return error("Invoices are only for self-employed engineers.", 403, env, request);
    const existing = await invoiceFor(env, tid, me, monday);
    if (existing) return error("Invoice " + existing.number + " already exists for this week.", 409, env, request);
    // A rate sent with the request is remembered (first-time setup).
    if (b.rate != null) { const n = parseFloat(b.rate); if (isFinite(n) && n > 0) {
      const mine = cfg.byUser[me] || (cfg.byUser[me] = {}); mine.rate = n;
      if (b.rateType === "day" || b.rateType === "hour") mine.rateType = b.rateType;
      await saveCfg(env, tid, cfg);
    }}
    const eff = effectiveCfg(cfg, u);
    if (!eff.rate) return error("No pay rate set — enter your rate first.", 400, env, request);
    const { days } = await loadWeek(env, tid, me, monday);
    const totals = weekTotals(days, eff);
    if (!totals.daysWorked && !totals.miles) return error("Nothing on this week's timesheet yet — save your times first.", 400, env, request);
    const number = await nextInvoiceNumber(env, tid, me, eff);
    const pdf = buildInvoicePdf({ number, name: displayName(u), details: eff.details,
      company: cfg.defaults.company, monday, days, eff, totals });
    const key = `${INV_PREFIX(tid)}${encodeURIComponent(me)}/INV-${number}-${monday}.pdf`;
    await env.JOB_FILES.put(key, pdf, { httpMetadata: { contentType: "application/pdf" },
      customMetadata: { by: me, number: String(number), week: monday, at: new Date().toISOString() } });
    await env.DB.prepare(
      "INSERT INTO eng_invoices (tenant_id, username, number, week, hours, miles, labour, mileage, total, r2_key, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(tid, me, number, monday, totals.hours, totals.miles, totals.labour, totals.mileagePay, totals.total, key, new Date().toISOString()).run();
    return json({ ok: true, number, total: totals.total,
      url: await signedFileUrl(env, url.origin, "/ts/invoice-file", key) }, {}, env, request);
  }

  if (sub === "/invoices" && method === "GET") {
    const admin = await isTsAdmin(env, tid, sess);
    const who = q.get("u");
    let stmt;
    if (who && admin && who !== "all") stmt = env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND username=? ORDER BY at DESC LIMIT 200").bind(tid, who);
    else if (who === "all" && admin) stmt = env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? ORDER BY at DESC LIMIT 400").bind(tid);
    else stmt = env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND username=? ORDER BY at DESC LIMIT 200").bind(tid, me);
    const { results } = await stmt.all();
    const invoices = [];
    for (const r of results || []) invoices.push({
      id: r.id, username: r.username, number: r.number, week: r.week, hours: r.hours, miles: r.miles,
      labour: r.labour, mileage: r.mileage, total: r.total, at: r.at,
      url: await signedFileUrl(env, url.origin, "/ts/invoice-file", r.r2_key) });
    return json({ ok: true, invoices }, {}, env, request);
  }

  if (sub === "/invoice/delete" && method === "POST") {
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND id=?").bind(tid, Number(b.id)).first();
    if (!row) return error("Invoice not found", 404, env, request);
    await env.DB.prepare("DELETE FROM eng_invoices WHERE tenant_id=? AND id=?").bind(tid, row.id).run();
    try { await env.JOB_FILES.delete(row.r2_key); } catch {}
    return json({ ok: true, deleted: row.number, username: row.username }, {}, env, request);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────
  if (sub.startsWith("/admin/")) {
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);

    if (sub === "/admin/overview" && method === "GET") {
      const monday = mondayOf(isDateStr(q.get("week")) ? q.get("week") : new Date().toISOString().slice(0, 10));
      const { results: users } = await env.DB.prepare(
        "SELECT username, first_name, last_name, employment_type, profile FROM users WHERE tenant_id=? AND status='Active' ORDER BY username"
      ).bind(tid).all();
      const { results: rows } = await env.DB.prepare("SELECT username, data, at FROM eng_timesheets WHERE tenant_id=? AND week=?").bind(tid, monday).all();
      const { results: invs } = await env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND week=?").bind(tid, monday).all();
      const dataBy = {}; for (const r of rows || []) { try { dataBy[r.username] = { days: JSON.parse(r.data).days || {}, at: r.at }; } catch {} }
      const invBy = {}; for (const r of invs || []) invBy[r.username] = r;
      const out = [];
      for (const u of users || []) {
        const eff = effectiveCfg(cfg, u);
        const d = dataBy[u.username] || { days: {}, at: null };
        const inv = invBy[u.username];
        const perDay = {};
        for (const [date, day] of Object.entries(d.days)) perDay[date] = { ...dayCalc(day, eff), start: day.start, finish: day.finish, jobs: day.jobs, note: day.note, mileage: day.mileage || [] };
        out.push({ username: u.username, name: displayName(u), employment: u.employment_type || "Employed",
          selfEmployed: isSelfEmployed(u), cfg: { commute: eff.commute, lunch: eff.lunch, mileage: eff.mileage, rate: eff.rate, rateType: eff.rateType, pencePerMile: eff.pencePerMile },
          days: d.days, perDay, savedAt: d.at, totals: weekTotals(d.days, eff),
          invoice: inv ? { id: inv.id, number: inv.number, total: inv.total, at: inv.at,
            url: await signedFileUrl(env, url.origin, "/ts/invoice-file", inv.r2_key) } : null });
      }
      return json({ ok: true, week: monday, days: weekDays(monday), users: out }, {}, env, request);
    }

    if (sub === "/admin/save" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.username || !isDateStr(b.week)) return error("username and week required", 400, env, request);
      const monday = mondayOf(b.week);
      if (await invoiceFor(env, tid, b.username, monday))
        return error("That week is invoiced — delete the invoice first if it needs correcting.", 409, env, request);
      const days = cleanDays(monday, b.days);
      await env.DB.prepare(
        "INSERT INTO eng_timesheets (tenant_id, week, username, data, at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, week, username) DO UPDATE SET data=excluded.data, at=excluded.at"
      ).bind(tid, monday, b.username, JSON.stringify({ days }), new Date().toISOString()).run();
      return json({ ok: true }, {}, env, request);
    }

    if (sub === "/admin/config" && method === "GET") {
      const { results: users } = await env.DB.prepare(
        "SELECT username, first_name, last_name, employment_type, profile FROM users WHERE tenant_id=? AND status='Active' ORDER BY username"
      ).bind(tid).all();
      return json({ ok: true, defaults: cfg.defaults, byUser: cfg.byUser,
        users: (users || []).map(u => ({ username: u.username, name: displayName(u),
          employment: u.employment_type || "Employed", selfEmployed: isSelfEmployed(u),
          effective: effectiveCfg(cfg, u) })) }, {}, env, request);
    }

    if (sub === "/admin/config" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (b.defaults && typeof b.defaults === "object") cfg.defaults = Object.assign({ ...DEFAULTS }, cfg.defaults, b.defaults);
      if (b.byUser && typeof b.byUser === "object") {
        for (const [u, v] of Object.entries(b.byUser)) {
          if (v === null) { delete cfg.byUser[u]; continue; }
          const mine = cfg.byUser[u] || (cfg.byUser[u] = {});
          for (const k of ["commute", "lunch", "mileage"]) if (k in v) mine[k] = v[k] === true;
          for (const k of ["commuteMins", "lunchMins", "lunchThresholdH", "pencePerMile", "rate", "nextNumber"]) {
            if (k in v) { const n = parseFloat(v[k]); if (isFinite(n) && n >= 0) mine[k] = n; else delete mine[k]; }
          }
          if ("rateType" in v && (v.rateType === "hour" || v.rateType === "day")) mine.rateType = v.rateType;
          if ("homePostcode" in v) mine.homePostcode = String(v.homePostcode || "").toUpperCase().slice(0, 10);
          if ("details" in v) mine.details = (Array.isArray(v.details) ? v.details : String(v.details || "").split(/\n/))
            .map(s => String(s).trim()).filter(Boolean).slice(0, 5);
        }
      }
      await saveCfg(env, tid, cfg);
      return json({ ok: true }, {}, env, request);
    }
  }

  return error("Unknown timesheet route: " + sub, 404, env, request);
}
