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
import { signedFileUrl, verifyFileSig, fileSigningEnabled } from "../lib/filesign.js";

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
// So is one within 30 min AFTER a sign-out: that's someone leaving, not arriving.
// Every such visit is state "scanned" and flagged "Scanned but not confirmed".
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
const SCAN_EARLY = 5 * 60, SCAN_LATE = 21 * 60, PRE_CONFIRM_MS = 20 * 60000, POST_SIGNOUT_MS = 30 * 60000, MIN_SPAN_MS = 30 * 60000;
const minsOfDay = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
function plausible(d) { const m = minsOfDay(london(d).hhmm); return m >= SCAN_EARLY && m <= SCAN_LATE; }

async function loadUnconfirmedScans(db, from, to) {
  try {
    const r = await db.prepare(`
      SELECT l.at, l.outcome, l.person_id, l.site, l.lat, l.lng, p.first_name, p.last_name, p.company
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
           v.lat AS in_lat, v.lng AS in_lng, v.out_lat, v.out_lng,
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
  const insideVisit = (pid, t) => (spans.get(pid) || []).some(([a, b]) => t >= a - PRE_CONFIRM_MS && t <= b + POST_SIGNOUT_MS);
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
    let scannedOut = null, scannedOutAt = null;
    if ((state === "auto" || (state === "open" && day < today)) && r.person_id) {
      const limit = outD ? outD.getTime() : Infinity;
      for (const s of scansBy.get(r.person_id) || []) {
        const t = s._d.getTime();
        if (s.outcome !== "confirm_sign_out" || t <= inD.getTime() + 60000 || t > limit) continue;
        if (london(s._d).key !== day || !plausible(s._d)) continue;
        scannedOut = s._d; scannedOutAt = s;
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
      pid: r.person_id || "", vid: r.id, day,
      inLat: num(r.in_lat), inLng: num(r.in_lng),
      outLat: scannedOutAt ? num(scannedOutAt.lat) : (auto ? null : num(r.out_lat)),
      outLng: scannedOutAt ? num(scannedOutAt.lng) : (auto ? null : num(r.out_lng)),
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
      let end = null, endScan = null;
      for (let j = i + 1; j < ins.length; j++) {
        const e = ins[j], et = e._d.getTime();
        if (london(e._d).key !== day || et >= nextVisit - PRE_CONFIRM_MS) break;
        used.add(e); // repeat taps of the same attempt, or the leaving scan
        if ((e.site || "") === (s.site || "") && et - t >= MIN_SPAN_MS && plausible(e._d)) { end = e._d; endScan = e; }
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
        pid, vid: "scan:" + s.at, day,
        inLat: num(s.lat), inLng: num(s.lng),
        outLat: endScan ? num(endScan.lat) : null, outLng: endScan ? num(endScan.lng) : null,
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
  await addMapLinks(env, apiOrigin(env), people, MAP_TTL_EMAIL);
  const pin = u => u ? ` <a href="${esc(u)}" style="text-decoration:none" title="Show on a map">📍</a>` : "";
  const evRows = p => p.visits.map(v => {
    const out = v.state === "open" ? "still in" : (v.outTime || "—");
    const bad = v.state === "auto" || v.state === "scanned";
    return `<tr><td></td><td colspan="2" style="padding:1px 0 1px 10px;font-size:12.5px;color:${bad ? "#b45309" : "#475569"}">` +
      `${kind === "weekly" ? esc(v.date) + " · " : ""}${esc(v.site)} · in ${esc(v.inTime)}${v.inOk ? " ✔" : " ✘"}${pin(v.mapIn)}` +
      ` → out ${esc(out)}${v.state === "open" ? "" : (v.outOk ? " ✔" : " ✘")}${pin(v.mapOut)}` +
      (bad ? ` · ${esc(v.note)}` : "") + `</td></tr>`;
  }).join("");
  const rows = people.map(p => {
    const t = personTotals(p);
    const flag = [t.missed ? `${t.missed} missed sign-out${t.missed > 1 ? "s" : ""}` : "",
      t.scanned ? `${t.scanned} scanned but not confirmed` : "",
      t.unver ? `${t.unver} not verified` : "", t.open ? `${t.open} still in` : ""].filter(Boolean).join(" · ");
    return `<tr><td style="padding:4px 10px 4px 0">${esc(p.name)}</td><td style="padding:4px 10px;text-align:right"><b>${fmtHM(t.mins)}</b></td>` +
      `<td style="padding:4px 0;color:${flag ? "#dc2626" : "#16a34a"}">${flag ? esc(flag) : "All verified"}</td></tr>` + evRows(p);
  }).join("");
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a">
    <p><b>SiteLog ${kind === "weekly" ? "weekly" : "daily"} timesheet — ${esc(per.label)}</b></p>
    ${people.length ? `<table style="border-collapse:collapse">${rows}</table>` : "<p>Nobody signed in to a site.</p>"}
    <p style="color:#6b7280;font-size:12px">The full timesheet is attached as a PDF. A green tick means the phone was at the site when it signed in or out; a red cross means it was not checked (an automatic sign-out, an office edit, or a visit from before location checks began). "Scanned but not confirmed" means they scanned the QR code but never pressed Sign in / Sign out — the scan time is used where nothing else was recorded. Tap 📍 to see on a map where the phone was for that sign-in or sign-out (links work for 90 days).</p></div>`;
  const r = await sendEmail(env, {
    to: recipients,
    subject: `SiteLog ${kind === "weekly" ? "weekly " : ""}timesheet — ${per.label}`,
    html,
    attachments: [{ filename: per.file, content: b64(bytes) }],
  });
  return { ...r, people: people.length, period: per.label };
}

// ── Location maps (admin only) ───────────────────────────────────────────────
// Every sign-in / sign-out carries a 📍 link to a map of where the phone was.
// The link is SIGNED (HMAC, expiring) because it has to open straight from the
// timesheet email without a portal login: /data mints them for SiteLog admins,
// the email mints them for the configured recipients. No signing secret = no
// links at all (verifyFileSig would otherwise wave unsigned links through).
const MAP_PATH = "/sitelog-map";
const MAP_TTL_EMAIL = 90 * 86400, MAP_TTL_VIEW = 7 * 86400;
export function apiOrigin(env, url) {
  return url ? url.origin : String(env.API_BASE_URL || "https://mostlane-api.jamie-def.workers.dev").replace(/\/$/, "");
}
export async function addMapLinks(env, origin, people, ttl) {
  if (!fileSigningEnabled(env)) return people;
  for (const p of people) for (const v of p.visits) {
    if (!v.pid) continue;
    const key = side => [v.pid, v.day, v.vid, side].join("|");
    if (v.inLat != null && v.inLng != null) v.mapIn = await signedFileUrl(env, origin, MAP_PATH, key("in"), ttl);
    if (v.outLat != null && v.outLng != null) v.mapOut = await signedFileUrl(env, origin, MAP_PATH, key("out"), ttl);
  }
  return people;
}
function hav(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const s = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const SCAN_LABEL = {
  confirm_check_in: "Scanned — offered sign-in", confirm_sign_out: "Scanned — offered sign-out",
  checked_in: "Signed in", checked_out: "Signed out", first_visit: "Scanned — new phone",
  unknown_site: "Refused — not at a site", outside_site: "Refused — outside the site boundary",
  outside_site_signed_in: "Refused — tried to sign out away from the site", no_location: "Refused — no location",
};

// Everything one person did on one London day, with coordinates.
export async function personDayEvents(env, personId, dateKey) {
  const db = env.SITELOG_DB;
  const person = await db.prepare("SELECT first_name, last_name, company FROM people WHERE id = ?").bind(personId).first();
  const vis = (await db.prepare(`SELECT * FROM visits WHERE person_id = ? AND check_in_at >= ? AND check_in_at < ? ORDER BY check_in_at`)
    .bind(personId, addDays(dateKey, -1), addDays(dateKey, 2)).all()).results || [];
  let scans = [];
  try {
    scans = (await db.prepare(`SELECT at, kind, outcome, refused, site, nearest_site, lat, lng, accuracy, distance_m FROM scan_log
      WHERE person_id = ? AND at >= ? AND at < ? ORDER BY at`).bind(personId, addDays(dateKey, -1), addDays(dateKey, 2)).all()).results || [];
  } catch (e) {}
  const sites = (await db.prepare("SELECT site_name, lat, lng, radius_m FROM sites WHERE COALESCE(archived,0) = 0").all()).results || [];
  const siteBy = new Map(sites.map(x => [x.site_name, x]));
  const distTo = (name, lat, lng) => { const st = siteBy.get(name); return st && lat != null ? Math.round(hav(lat, lng, +st.lat, +st.lng)) : null; };
  const events = [];
  for (const v of vis) {
    const inD = parseUtc(v.check_in_at); if (!inD || london(inD).key !== dateKey) continue;
    const auto = Number(v.auto_checkout) === 1;
    if (num(v.lat) != null) events.push({ id: v.id + ":in", t: inD.toISOString(), time: london(inD).hhmm, kind: "in",
      label: "Signed in", site: v.site_code, lat: num(v.lat), lng: num(v.lng), acc: num(v.accuracy),
      ok: Number(v.sign_in_verified) === 1, dist: distTo(v.site_code, num(v.lat), num(v.lng)) });
    const outD = parseUtc(v.check_out_at);
    if (outD && !auto && num(v.out_lat) != null) events.push({ id: v.id + ":out", t: outD.toISOString(), time: london(outD).hhmm, kind: "out",
      label: "Signed out", site: v.site_code, lat: num(v.out_lat), lng: num(v.out_lng), acc: num(v.out_accuracy),
      ok: Number(v.sign_out_verified) === 1, dist: distTo(v.site_code, num(v.out_lat), num(v.out_lng)) });
  }
  for (const sc of scans) {
    const d = parseUtc(sc.at); if (!d || london(d).key !== dateKey || num(sc.lat) == null) continue;
    if (sc.kind !== "scan" && !Number(sc.refused)) continue; // confirmed sign-ins/outs are already the visit pins
    const site = sc.site || sc.nearest_site || "";
    events.push({ id: "scan:" + sc.at, t: d.toISOString(), time: london(d).hhmm, kind: Number(sc.refused) ? "refused" : "scan",
      label: SCAN_LABEL[sc.outcome] || ("Scan — " + sc.outcome), site, lat: num(sc.lat), lng: num(sc.lng), acc: num(sc.accuracy),
      ok: null, dist: sc.site ? distTo(sc.site, num(sc.lat), num(sc.lng)) : (sc.distance_m != null ? Number(sc.distance_m) : null) });
  }
  events.sort((a, b) => a.t < b.t ? -1 : 1);
  // Sites to draw: every site an event names, plus any neighbour within 1 km of
  // a pin (so two sites sitting metres apart are both visible).
  const want = new Set(events.map(e => e.site).filter(Boolean));
  for (const st of sites) {
    if (want.size > 40) break;
    if (events.some(e => hav(e.lat, e.lng, +st.lat, +st.lng) <= 1000)) want.add(st.site_name);
  }
  const drawSites = [...want].map(n => siteBy.get(n)).filter(Boolean)
    .map(x => ({ name: x.site_name, lat: +x.lat, lng: +x.lng, radius: Number(x.radius_m) > 0 ? Number(x.radius_m) : 500 }));
  const name = person ? [person.first_name, person.last_name].filter(Boolean).join(" ") : "Unknown person";
  return { name, company: person && person.company || "", date: dateKey, events, sites: drawSites };
}

function mapPage(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>${body}`, { status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } });
}

// GET /sitelog-map?key=<personId>|<date>|<visitId>|<in|out>&exp&sig  (PUBLIC, signed)
export async function handleMap(request, env, ctx, url) {
  if (request.method !== "GET") return mapPage("Not allowed", "</head><body>Not allowed</body></html>", 405);
  const key = url.searchParams.get("key") || "";
  if (!fileSigningEnabled(env) || !(await verifyFileSig(env, key, url.searchParams)))
    return mapPage("Link expired", `</head><body style="font-family:Segoe UI,Arial,sans-serif;padding:24px;color:#0f172a"><h2>This map link has expired or isn't valid</h2><p>Open the timesheet in the portal (Site Log) for a fresh link.</p></body></html>`, 403);
  if (!env.SITELOG_DB) return mapPage("Unavailable", "</head><body>SiteLog is not connected.</body></html>", 503);
  const [pid, day, vid, side] = key.split("|");
  if (!pid || !/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return mapPage("Bad link", "</head><body>Bad link</body></html>", 400);
  const data = await personDayEvents(env, pid, day);
  data.focus = vid && vid.startsWith("scan:") ? vid : (vid ? vid + ":" + (side === "out" ? "out" : "in") : "");
  data.dayLabel = niceDate(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "");
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return mapPage(`${data.name} — ${data.dayLabel}`, `
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;background:#f4f6f9}
  header{background:#003468;color:#fff;padding:12px 16px;padding-top:calc(12px + env(safe-area-inset-top,0px))}
  header h1{font-size:17px;margin:0} header div{font-size:13px;opacity:.85;margin-top:2px}
  #map{height:58vh;min-height:300px}
  ul{list-style:none;margin:0;padding:8px 12px 24px;max-width:760px}
  li{background:#fff;border:1px solid #e2e6ec;border-radius:10px;padding:9px 12px;margin:6px 0;cursor:pointer;display:flex;gap:10px;align-items:baseline}
  li.on{border-color:#003468;box-shadow:0 0 0 2px #00346833}
  .t{font-weight:700;font-variant-numeric:tabular-nums;min-width:44px}
  .d{font-size:12.5px;color:#64748b} .ok{color:#16a34a} .bad{color:#dc2626}
  .dot{width:10px;height:10px;border-radius:50%;flex:none;align-self:center}
  .note{font-size:12px;color:#64748b;padding:6px 14px 0;max-width:760px}
</style></head><body>
<header><h1 id="h"></h1><div id="sub"></div></header>
<div id="map"></div>
<p class="note">Pins show where the phone said it was. The blue circles are each site's sign-in boundary. GPS on a phone is usually accurate to 10–25 m (the faint ring round the selected pin).</p>
<ul id="list"></ul>
<script type="application/json" id="data">${json}</script>
<script>
(function(){
  var D = JSON.parse(document.getElementById("data").textContent);
  var esc = function(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); };
  document.getElementById("h").textContent = D.name + (D.company ? " — " + D.company : "");
  document.getElementById("sub").textContent = D.dayLabel + " · " + D.events.length + " event" + (D.events.length==1?"":"s");
  var COL = { in:"#16a34a", out:"#1d4ed8", scan:"#94a3b8", refused:"#dc2626" };
  var map = L.map("map", { zoomControl:true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { maxZoom:20, subdomains:"abcd", attribution:"&copy; OpenStreetMap &copy; CARTO" }).addTo(map);
  D.sites.forEach(function(s){
    L.circle([s.lat,s.lng], { radius:s.radius, color:"#2563eb", weight:1, fillOpacity:.05 }).addTo(map);
    L.circleMarker([s.lat,s.lng], { radius:4, color:"#1e3a8a", fillColor:"#1e3a8a", fillOpacity:1, weight:1 })
      .addTo(map).bindTooltip(esc(s.name), { permanent:true, direction:"right", offset:[6,0], className:"" });
  });
  var marks = {}, acc = null, bounds = [];
  function text(e){
    var where = e.site ? esc(e.site) : "no site";
    var dist = e.dist != null ? (e.dist + " m from " + (e.kind==="refused" && !e.ok ? "the nearest site" : "the site")) : "";
    var gps = e.ok === true ? '<span class="ok">✔ GPS verified</span>' : e.ok === false ? '<span class="bad">✘ not verified</span>' : "";
    return "<b>" + esc(e.time) + " · " + esc(e.label) + "</b><br>" + where + (dist ? " · " + dist : "") + (gps ? "<br>" + gps : "")
      + (e.acc ? '<br><span style="color:#64748b">phone accuracy ±' + Math.round(e.acc) + ' m</span>' : "");
  }
  D.events.forEach(function(e){
    var m = L.circleMarker([e.lat,e.lng], { radius:8, color:"#fff", weight:2, fillColor:COL[e.kind]||"#64748b", fillOpacity:1 })
      .addTo(map).bindPopup(text(e));
    marks[e.id] = { m:m, e:e }; bounds.push([e.lat,e.lng]);
  });
  function focus(id, pan){
    var x = marks[id]; if (!x) return;
    if (acc) map.removeLayer(acc);
    if (x.e.acc) acc = L.circle([x.e.lat,x.e.lng], { radius:x.e.acc, color:COL[x.e.kind], weight:1, fillOpacity:.12 }).addTo(map);
    Object.keys(marks).forEach(function(k){ marks[k].m.setRadius(k===id?12:8); });
    if (pan) map.setView([x.e.lat,x.e.lng], 18);
    x.m.openPopup();
    [].forEach.call(document.querySelectorAll("#list li"), function(li){ li.classList.toggle("on", li.dataset.id===id); });
  }
  var list = document.getElementById("list");
  list.innerHTML = D.events.map(function(e){
    return '<li data-id="' + esc(e.id) + '"><span class="dot" style="background:' + (COL[e.kind]||"#64748b") + '"></span><span class="t">' + esc(e.time)
      + '</span><span>' + esc(e.label) + '<div class="d">' + (e.kind === "refused" && e.site ? "nearest site: " : "") + (e.site ? esc(e.site) : "no site") + (e.dist != null ? " · " + e.dist + " m away" : "")
      + (e.ok === true ? ' · <span class="ok">✔</span>' : e.ok === false ? ' · <span class="bad">✘</span>' : "") + '</div></span></li>';
  }).join("") || '<li>No events with a location on this day.</li>';
  list.addEventListener("click", function(ev){ var li = ev.target.closest("li[data-id]"); if (li) focus(li.dataset.id, true); });
  if (D.focus && marks[D.focus]) { map.setView([marks[D.focus].e.lat, marks[D.focus].e.lng], 17); focus(D.focus, false); }
  else if (bounds.length) map.fitBounds(bounds, { padding:[40,40], maxZoom:17 });
  else if (D.sites.length) map.setView([D.sites[0].lat, D.sites[0].lng], 16);
  else map.setView([50.86,-1.2], 9);
})();
</script></body></html>`);
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
    await addMapLinks(env, apiOrigin(env, url), people, MAP_TTL_VIEW);
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
