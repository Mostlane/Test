// SiteLog timesheet PDFs, emailed to the office automatically.
// Mounted at /sitelog-ts. Gate: FullAccess | SiteLogAdmin.
//   Daily  — once everyone who signed in today has signed out (from 16:00
//            London), or at 20:00 regardless, with anyone still in shown as such.
//   Weekly — Monday from 07:00 London, covering the previous Monday–Sunday.
// One PDF per period: a summary page, then a page per person with every visit
// and a tick/cross for whether the sign-in and sign-out were GPS-verified.
// Config: app_config `sitelog:tsmail:<tid>` = {enabled, recipients[], daily, weekly}
// Sent markers: app_config `sitelog:tsmail:sent:<tid>` = {daily:<date>, weekly:<monday>}
import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { sendEmail } from "../lib/email.js";
import { logoBytes } from "../lib/logo.js";
import { buildSiteLogTimesheetPdf, personTotals, fmtHM } from "../lib/sitelogtspdf.js";

const CFG_KEY = tid => `sitelog:tsmail:${tid}`;
const SENT_KEY = tid => `sitelog:tsmail:sent:${tid}`;
const DAILY_FROM = "16:00", DAILY_FORCE = "20:00", WEEKLY_FROM = "07:00";

async function readKV(env, tid, key) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, key).first();
  try { return row && row.value ? JSON.parse(row.value) : null; } catch { return null; }
}
async function writeKV(env, tid, key, obj) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, key, JSON.stringify(obj)).run();
}
export async function getConfig(env, tid) {
  const c = (await readKV(env, tid, CFG_KEY(tid))) || {};
  return {
    enabled: c.enabled !== false,
    daily: c.daily !== false,
    weekly: c.weekly !== false,
    recipients: Array.isArray(c.recipients) ? c.recipients.filter(Boolean) : [],
  };
}

// ── Dates (Europe/London) ────────────────────────────────────────────────────
function london(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { key: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}
function parseUtc(s) {
  if (!s) return null;
  s = String(s).trim();
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  return isNaN(d) ? null : d;
}
function addDays(key, n) {
  const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = key => new Date(key + "T12:00:00Z").getUTCDay();
const mondayOf = key => addDays(key, -((dow(key) + 6) % 7));
function niceDate(key, opts) {
  return new Date(key + "T12:00:00Z").toLocaleDateString("en-GB", Object.assign({ timeZone: "UTC" }, opts));
}
export function periodFor(kind, dateKey) {
  if (kind === "weekly") {
    const from = mondayOf(dateKey), to = addDays(from, 6);
    const label = `Week ${niceDate(from, { day: "numeric", month: "short" })} – ${niceDate(to, { day: "numeric", month: "short", year: "numeric" })}`;
    return { kind, from, to, label, file: `SiteLog-week-${from}.pdf` };
  }
  return { kind: "daily", from: dateKey, to: dateKey,
    label: niceDate(dateKey, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", ""),
    file: `SiteLog-${dateKey}.pdf` };
}

// ── Data ─────────────────────────────────────────────────────────────────────
// A scan the worker logged (scan_log) that offered a sign-in or sign-out the
// person never confirmed. Used ONLY where no real event exists for that person:
//   • a missed sign-out (auto-closed visit) with a later "sign out?" scan → that
//     scan's time is the sign-out, hours run to it;
//   • a "sign in?" scan with no visit around it → a visit is built from it, ending
//     at a later unconfirmed scan at the same site (≥30 min on, same day) if any.
// Plausibility: scans between 05:00 and 21:00 London only; a "sign in?" scan inside
// a real visit, or within 20 min before one starts (the normal scan-then-confirm),
// is ignored — so a scan at another site while still signed in never double-counts.
// Every such visit is state "scanned" and flagged "Scanned but not confirmed".
const SCAN_EARLY = 5 * 60, SCAN_LATE = 21 * 60, PRE_CONFIRM_MS = 20 * 60000, MIN_SPAN_MS = 30 * 60000;
const minsOfDay = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
function plausible(d) { const m = minsOfDay(london(d).hhmm); return m >= SCAN_EARLY && m <= SCAN_LATE; }

async function loadUnconfirmedScans(db, from, to) {
  try {
    const r = await db.prepare(`
      SELECT l.at, l.outcome, l.person_id, l.site, p.first_name, p.last_name, p.company
      FROM scan_log l LEFT JOIN people p ON p.id = l.person_id
      WHERE l.kind = 'scan' AND l.outcome IN ('confirm_check_in','confirm_sign_out')
        AND l.person_id IS NOT NULL AND l.at >= ? AND l.at < ?
      ORDER BY l.at`).bind(addDays(from, -1), addDays(to, 2)).all();
    return r.results || [];
  } catch (e) { return []; } // scan_log not created yet
}

export async function loadPeriod(env, from, to) {
  const db = env.SITELOG_DB;
  if (!db) throw new Error("SiteLog database is not connected to this worker");
  const res = await db.prepare(`
    SELECT v.id, v.person_id, v.site_code, v.check_in_at, v.check_out_at,
           COALESCE(v.auto_checkout,0) AS auto_checkout, v.transferred_to,
           COALESCE(v.manual_entry,0) AS manual_entry, v.provided_site_name,
           COALESCE(v.sign_in_verified,0) AS sign_in_verified,
           COALESCE(v.sign_out_verified,0) AS sign_out_verified,
           v.sign_in_distance_m, v.sign_out_distance_m,
           p.first_name, p.last_name, p.company
    FROM visits v LEFT JOIN people p ON p.id = v.person_id
    WHERE v.check_in_at >= ? AND v.check_in_at < ?
    ORDER BY v.check_in_at`).bind(addDays(from, -1), addDays(to, 2)).all();
  const scans = await loadUnconfirmedScans(db, from, to);
  const today = london().key;

  // Every real visit per person (whole fetched window), for the overlap test.
  const spans = new Map();
  for (const r of res.results || []) {
    const a = parseUtc(r.check_in_at); if (!a || !r.person_id) continue;
    const b = parseUtc(r.check_out_at);
    if (!spans.has(r.person_id)) spans.set(r.person_id, []);
    spans.get(r.person_id).push([a.getTime(), b ? b.getTime() : Infinity]);
  }
  const insideVisit = (pid, t) => (spans.get(pid) || []).some(([a, b]) => t >= a - PRE_CONFIRM_MS && t <= b);
  const scansBy = new Map();
  for (const s of scans) {
    const d = parseUtc(s.at); if (!d) continue;
    s._d = d;
    if (!scansBy.has(s.person_id)) scansBy.set(s.person_id, []);
    scansBy.get(s.person_id).push(s);
  }

  const byPerson = new Map();
  const ensure = (key, first, last, company) => {
    const name = [first, last].filter(Boolean).join(" ").trim() || "Unknown person";
    if (!byPerson.has(key)) byPerson.set(key, { name, company: company || "", visits: [] });
    return byPerson.get(key);
  };
  const dayLabel = day => niceDate(day, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  const m = d => Math.round(Number(d));
  for (const r of res.results || []) {
    const inD = parseUtc(r.check_in_at);
    if (!inD) continue;
    const day = london(inD).key;
    if (day < from || day > to) continue;
    let outD = parseUtc(r.check_out_at);
    const auto = Number(r.auto_checkout) === 1;
    let state = !outD ? "open" : r.transferred_to ? "moved" : auto ? "auto" : Number(r.manual_entry) === 1 ? "manual" : "ok";
    const inOk = Number(r.sign_in_verified) === 1;
    let outOk = !!outD && Number(r.sign_out_verified) === 1 && !auto;
    let note = "";
    // Missed sign-out (or still "open" on a past day) with an unconfirmed
    // "sign out?" scan after the sign-in → use the LAST such scan as the sign-out.
    let scannedOut = null;
    if ((state === "auto" || (state === "open" && day < today)) && r.person_id) {
      const limit = outD ? outD.getTime() : Infinity;
      for (const s of scansBy.get(r.person_id) || []) {
        const t = s._d.getTime();
        if (s.outcome !== "confirm_sign_out" || t <= inD.getTime() + 60000 || t > limit) continue;
        if (london(s._d).key !== day || !plausible(s._d)) continue;
        scannedOut = s._d;
      }
    }
    if (scannedOut) {
      state = "scanned"; outD = scannedOut; outOk = false;
      note = "Scanned, not confirmed — sign-out time from a scan";
    } else if (state === "auto") note = "Did not sign out — closed automatically";
    else if (state === "open") note = "Still signed in";
    else if (state === "moved") note = `Signed in at ${r.transferred_to} — closed here`;
    else if (state === "manual") note = "Added by the office";
    if (!note) {
      const bits = [];
      if (inOk && r.sign_in_distance_m != null) bits.push(`in ${m(r.sign_in_distance_m)} m from site`);
      if (outOk && r.sign_out_distance_m != null) bits.push(`out ${m(r.sign_out_distance_m)} m`);
      if (!inOk) bits.push("sign-in location not checked");
      if (!outOk) bits.push("sign-out location not checked");
      note = bits.join(" · ");
    }
    const p = ensure(r.person_id || [r.first_name, r.last_name].join(" "), r.first_name, r.last_name, r.company);
    p.visits.push({
      _t: inD.getTime(),
      date: dayLabel(day),
      site: r.site_code || r.provided_site_name || "",
      inTime: london(inD).hhmm,
      outTime: outD ? london(outD).hhmm : "",
      mins: outD ? Math.max(0, (outD - inD) / 60000) : 0,
      inOk, outOk, state, note,
      scannedIn: false, scannedOut: !!scannedOut,
      inDist: r.sign_in_distance_m, outDist: r.sign_out_distance_m,
    });
  }

  // "Sign in?" scans with no real visit around them → a scanned-not-confirmed visit.
  for (const [pid, list] of scansBy) {
    const ins = list.filter(s => s.outcome === "confirm_check_in");
    const used = new Set();
    for (let i = 0; i < ins.length; i++) {
      const s = ins[i]; if (used.has(s)) continue;
      const t = s._d.getTime(), day = london(s._d).key;
      if (day < from || day > to || !plausible(s._d) || insideVisit(pid, t)) { used.add(s); continue; }
      used.add(s);
      // The next real visit that day caps the search for an end scan.
      const nextVisit = Math.min(...(spans.get(pid) || []).map(([a]) => a).filter(a => a > t), Infinity);
      let end = null;
      for (let j = i + 1; j < ins.length; j++) {
        const e = ins[j], et = e._d.getTime();
        if (london(e._d).key !== day || et >= nextVisit - PRE_CONFIRM_MS) break;
        used.add(e); // repeat taps of the same attempt, or the leaving scan
        if ((e.site || "") === (s.site || "") && et - t >= MIN_SPAN_MS && plausible(e._d)) end = e._d;
        else if ((e.site || "") !== (s.site || "")) { used.delete(e); break; }
      }
      const p = ensure(pid, s.first_name, s.last_name, s.company);
      p.visits.push({
        _t: t,
        date: dayLabel(day),
        site: s.site || "",
        inTime: london(s._d).hhmm,
        outTime: end ? london(end).hhmm : "",
        mins: end ? Math.max(0, (end - s._d) / 60000) : 0,
        inOk: false, outOk: false, state: "scanned",
        scannedIn: true, scannedOut: !!end,
        note: end ? "Scanned, not confirmed — in & out times from scans"
                  : "Scanned, not confirmed — no sign-out, hours not counted",
        inDist: null, outDist: null,
      });
    }
  }

  for (const p of byPerson.values()) {
    p.visits.sort((a, b) => a._t - b._t);
    for (const v of p.visits) delete v._t;
  }
  return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildPdf(env, kind, dateKey) {
  const per = periodFor(kind, dateKey);
  const people = await loadPeriod(env, per.from, per.to);
  let logo = null; try { logo = logoBytes(); } catch (e) {}
  const now = london();
  const bytes = buildSiteLogTimesheetPdf({
    title: kind === "weekly" ? "SiteLog weekly timesheet" : "SiteLog daily timesheet",
    periodLabel: per.label,
    generatedAt: `${niceDate(now.key, { day: "numeric", month: "short", year: "numeric" })} ${now.hhmm}`,
    people, logo,
  });
  return { per, people, bytes };
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function emailTimesheet(env, tid, kind, dateKey, recipients) {
  const { per, people, bytes } = await buildPdf(env, kind, dateKey);
  const rows = people.map(p => {
    const t = personTotals(p);
    const flag = [t.missed ? `${t.missed} missed sign-out${t.missed > 1 ? "s" : ""}` : "",
      t.scanned ? `${t.scanned} scanned but not confirmed` : "",
      t.unver ? `${t.unver} not verified` : "", t.open ? `${t.open} still in` : ""].filter(Boolean).join(" · ");
    return `<tr><td style="padding:4px 10px 4px 0">${esc(p.name)}</td><td style="padding:4px 10px;text-align:right"><b>${fmtHM(t.mins)}</b></td>` +
      `<td style="padding:4px 0;color:${flag ? "#dc2626" : "#16a34a"}">${flag ? esc(flag) : "All verified"}</td></tr>`;
  }).join("");
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a">
    <p><b>SiteLog ${kind === "weekly" ? "weekly" : "daily"} timesheet — ${esc(per.label)}</b></p>
    ${people.length ? `<table style="border-collapse:collapse">${rows}</table>` : "<p>Nobody signed in to a site.</p>"}
    <p style="color:#6b7280;font-size:12px">The full timesheet is attached as a PDF. A green tick means the phone was at the site when it signed in or out; a red cross means it was not checked (an automatic sign-out, an office edit, or a visit from before location checks began). "Scanned but not confirmed" means they scanned the QR code but never pressed Sign in / Sign out — the scan time is used where nothing else was recorded.</p></div>`;
  const r = await sendEmail(env, {
    to: recipients,
    subject: `SiteLog ${kind === "weekly" ? "weekly " : ""}timesheet — ${per.label}`,
    html,
    attachments: [{ filename: per.file, content: b64(bytes) }],
  });
  return { ...r, people: people.length, period: per.label };
}

// ── Cron (every 5-minute tick; self-gates on London time, deduped) ───────────
export async function sweepSitelogTimesheets(env, tid = 1) {
  if (!env.SITELOG_DB) return;
  const cfg = await getConfig(env, tid);
  if (!cfg.enabled || !cfg.recipients.length) return;
  const now = london();
  const sent = (await readKV(env, tid, SENT_KEY(tid))) || {};

  if (cfg.weekly && dow(now.key) === 1 && now.hhmm >= WEEKLY_FROM) {
    const lastMon = addDays(now.key, -7);
    if (sent.weekly !== lastMon) {
      const r = await emailTimesheet(env, tid, "weekly", lastMon, cfg.recipients);
      if (r.ok || r.skipped) { sent.weekly = lastMon; await writeKV(env, tid, SENT_KEY(tid), sent); }
    }
  }

  if (cfg.daily && now.hhmm >= DAILY_FROM && sent.daily !== now.key) {
    const people = await loadPeriod(env, now.key, now.key);
    const visits = people.reduce((n, p) => n + p.visits.length, 0);
    const open = people.reduce((n, p) => n + p.visits.filter(v => v.state === "open").length, 0);
    const force = now.hhmm >= DAILY_FORCE;
    if (!visits) {
      if (force) { sent.daily = now.key; await writeKV(env, tid, SENT_KEY(tid), sent); } // nothing to send today
    } else if (!open || force) {
      const r = await emailTimesheet(env, tid, "daily", now.key, cfg.recipients);
      if (r.ok || r.skipped) { sent.daily = now.key; await writeKV(env, tid, SENT_KEY(tid), sent); }
    }
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Not signed in", 401, env, request);
  const tid = sess.tenantId;
  const perms = await permissionsFor(env, tid, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.SiteLogAdmin !== "Yes") return error("Needs the SiteLog admin permission", 403, env, request);
  const path = url.pathname.replace(/^\/sitelog-ts(?=\/|$)/, "") || "/";

  if (path === "/config" && request.method === "GET") {
    return json({ ok: true, config: await getConfig(env, tid), sent: (await readKV(env, tid, SENT_KEY(tid))) || {},
      emailConfigured: !!(env.RESEND_API_KEY || env.RESET_EMAIL_WEBHOOK), sitelogConnected: !!env.SITELOG_DB }, {}, env, request);
  }
  // The same people/visits the emailed PDF is built from, as JSON for the
  // portal's timesheet view — so the screen and the email always agree.
  if (path === "/data" && request.method === "GET") {
    const k = url.searchParams.get("kind") === "weekly" ? "weekly" : "daily";
    const qd = url.searchParams.get("date") || "";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(qd) ? qd : london().key;
    const per = periodFor(k, d);
    let people;
    try { people = await loadPeriod(env, per.from, per.to); }
    catch (e) { return error(e.message || "SiteLog unavailable", 503, env, request); }
    return json({ ok: true, period: per, today: london().key,
      people: people.map(p => Object.assign({}, p, { totals: personTotals(p) })) }, {}, env, request);
  }
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  if (path === "/config" && request.method === "POST") {
    const cur = await getConfig(env, tid);
    const recips = Array.isArray(body.recipients) ? body.recipients
      : typeof body.recipients === "string" ? body.recipients.split(/[,;\s]+/) : cur.recipients;
    const clean = [...new Set(recips.map(s => String(s).trim().toLowerCase()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)))].slice(0, 20);
    const next = {
      enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
      daily: body.daily === undefined ? cur.daily : !!body.daily,
      weekly: body.weekly === undefined ? cur.weekly : !!body.weekly,
      recipients: clean,
    };
    await writeKV(env, tid, CFG_KEY(tid), next);
    return json({ ok: true, config: next }, {}, env, request);
  }
  const kind = body.kind === "weekly" ? "weekly" : "daily";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date
    : (kind === "weekly" ? addDays(london().key, -7) : london().key);
  if (path === "/pdf" && request.method === "POST") {
    const { per, bytes } = await buildPdf(env, kind, date);
    return new Response(bytes, { headers: Object.assign({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${per.file}"`,
      "Cache-Control": "no-store",
    }, corsHeaders(env, request)) });
  }
  if (path === "/send" && request.method === "POST") {
    const cfg = await getConfig(env, tid);
    if (!cfg.recipients.length) return error("Add at least one email address first", 400, env, request);
    const r = await emailTimesheet(env, tid, kind, date, cfg.recipients);
    if (!r.ok) return error(r.reason === "no provider" ? "Email isn't set up on the portal (RESEND_API_KEY)" : (r.error || "Email failed"), 502, env, request);
    return json({ ok: true, sentTo: cfg.recipients, period: r.period, people: r.people }, {}, env, request);
  }
  return error("Not found", 404, env, request);
}
