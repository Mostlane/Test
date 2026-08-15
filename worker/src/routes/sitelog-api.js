// Origins allowed to call the API. Credentials (the device cookie) require a
// specific origin to be echoed back - never "*" - so we reflect from this list.
const ALLOWED_ORIGINS = [
  "https://site-log.co.uk",
  "https://www.site-log.co.uk",
  "https://mostlane.github.io"
];
function corsFor(request) {
  const origin = request.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
    "Access-Control-Max-Age": "86400"
  };
}

const OFFICE_LAT = 50.8573;
const OFFICE_LNG = -1.2343;

// Module-level ephemeral caches. Persist across requests in the same isolate
// Cloudflare Workers reuse isolates, but reset on cold start.
const geocodeCache = new Map();

// Offline-sync schema bootstrap. Runs once per isolate (idempotent), so no
// manual D1 migration is needed when this version is deployed:
//   - visits.offline_synced  : 1 when a visit's time came from a device that
//                              was offline at scan time (device clock, not
//                              server-verified) and synced later.
//   - pending_events         : offline events from devices the server can't
//                              attribute to a known person, so nothing is lost.
let offlineSchemaReady = false;
async function ensureOfflineSchema(env) {
  if (offlineSchemaReady) return;
  try { await env.SITELOG_DB.prepare("ALTER TABLE visits ADD COLUMN offline_synced INTEGER DEFAULT 0").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE visits ADD COLUMN unmatched_site INTEGER DEFAULT 0").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE visits ADD COLUMN provided_site_name TEXT").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE visits ADD COLUMN manual_entry INTEGER DEFAULT 0").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE people ADD COLUMN fuel_rate REAL").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE people ADD COLUMN is_main INTEGER DEFAULT 0").run(); } catch (e) {}
  // Mostlane portal identity link: the person's portal username, set via
  // /portal-link when the scanner is opened from the portal. NULL = not a
  // portal user = subcontractor (for the portal's unified job costing).
  try { await env.SITELOG_DB.prepare("ALTER TABLE people ADD COLUMN portal_username TEXT").run(); } catch (e) {}
  // Fuel and travel-time pay are independent toggles. Columns are left nullable
  // so the one-time backfill below can seed them from the old single
  // travel_status ('paid' -> both on) without clobbering later edits: it only
  // touches rows that haven't been backfilled yet (fuel_paid IS NULL).
  try { await env.SITELOG_DB.prepare("ALTER TABLE people ADD COLUMN fuel_paid INTEGER").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE people ADD COLUMN travel_time_paid INTEGER").run(); } catch (e) {}
  try {
    await env.SITELOG_DB.prepare(
      "UPDATE people SET fuel_paid = CASE WHEN travel_status = 'paid' THEN 1 ELSE 0 END, travel_time_paid = CASE WHEN travel_status = 'paid' THEN 1 ELSE 0 END WHERE fuel_paid IS NULL"
    ).run();
  } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE sites ADD COLUMN category TEXT DEFAULT 'Projects'").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE devices ADD COLUMN last_seen TEXT").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE documents ADD COLUMN doc_number TEXT").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE documents ADD COLUMN doc_seq INTEGER").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("CREATE TABLE IF NOT EXISTS document_links (id TEXT PRIMARY KEY, document_id TEXT, person_id TEXT, person_name TEXT, linked_at TEXT)").run(); } catch (e) {}
  try { await env.SITELOG_DB.prepare("ALTER TABLE visits ADD COLUMN transferred_to TEXT").run(); } catch (e) {}
  try {
    await env.SITELOG_DB.prepare(
      "CREATE TABLE IF NOT EXISTS pending_events (id TEXT PRIMARY KEY, device_token TEXT, lat REAL, lng REAL, accuracy REAL, site_code TEXT, intent TEXT, occurred_at TEXT, synced_at TEXT, resolved INTEGER DEFAULT 0)"
    ).run();
  } catch (e) {}
  // Per-site document library (drawings, RAMS/H&S, certs). File bytes live in R2
  // (env.DOCS_BUCKET); this table holds the metadata + R2 key. Tied to a site by
  // site_name (consistent with the templated `documents` feature).
  try {
    await env.SITELOG_DB.prepare(
      "CREATE TABLE IF NOT EXISTS site_documents (id TEXT PRIMARY KEY, site_name TEXT, category TEXT, title TEXT, file_name TEXT, content_type TEXT, size_bytes INTEGER, r2_key TEXT, require_ack INTEGER DEFAULT 0, uploaded_by TEXT, uploaded_at TEXT, archived INTEGER DEFAULT 0)"
    ).run();
  } catch (e) {}
  // One row per person who has ticked "read & understood" on a site document.
  try {
    await env.SITELOG_DB.prepare(
      "CREATE TABLE IF NOT EXISTS site_document_acks (id TEXT PRIMARY KEY, document_id TEXT, person_id TEXT, person_name TEXT, company TEXT, acked_at TEXT)"
    ).run();
  } catch (e) {}
  // Trusted people who may view a site's documents any time (not just while
  // signed in at that site).
  try { await env.SITELOG_DB.prepare("ALTER TABLE people ADD COLUMN doc_access_always INTEGER DEFAULT 0").run(); } catch (e) {}
  offlineSchemaReady = true;
}

// Format a millisecond timestamp as SQLite's UTC string 'YYYY-MM-DD HH:MM:SS',
// matching what CURRENT_TIMESTAMP writes so date-key helpers keep working.
function toSqlUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
// Record that a device was active now (best-effort). Used to surface "last
// active" per person and make duplicate-merge suggestions recency-aware.
async function touchDevice(env, deviceToken) {
  if (!deviceToken) return;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    await env.SITELOG_DB.prepare("UPDATE devices SET last_seen = ? WHERE device_token = ?")
      .bind(now, deviceToken).run();
  } catch (e) { /* column may not exist yet pre-migration */ }
}

// ── Mostlane portal token verification ───────────────────────────────────────
// The portal signs a token "v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>"
// over "v1.<payload>" with the shared PORTAL_BRIDGE_SECRET (same secret on both
// workers). Returns the decoded payload {u,f,l,c,exp} or null if bad/expired.
function b64uToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function verifyPortalToken(env, token) {
  try {
    if (!env.PORTAL_BRIDGE_SECRET) return null;
    const parts = String(token).split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const signed = parts[0] + "." + parts[1];
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(env.PORTAL_BRIDGE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64uToBytes(parts[2]), enc.encode(signed));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1])));
    if (payload.exp && Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch (e) { return null; }
}


async function getTravelData(env, fromLat, fromLng, toLat, toLng) {
  try {
    const apiKey = env.GOOGLE_MAPS_KEY || "";
    if (!apiKey) return null;

    const url =
      "https://maps.googleapis.com/maps/api/distancematrix/json" +
      "?origins=" + encodeURIComponent(fromLat + "," + fromLng) +
      "&destinations=" + encodeURIComponent(toLat + "," + toLng) +
      "&mode=driving" +
      "&key=" + encodeURIComponent(apiKey);

    const res = await fetch(url);
    const data = await res.json();
    const el = data?.rows?.[0]?.elements?.[0];

    if (!el || el.status !== "OK") return null;

    return {
      miles: Math.round((el.distance.value / 1609.344) * 10) / 10,
      mins: Math.round(el.duration.value / 60),
      duration_text: el.duration?.text || "",
      distance_text: el.distance?.text || ""
    };
  } catch (e) {
    return null;
  }
}

async function getGeocode(env, address) {
  try {
    const apiKey = env.GOOGLE_MAPS_KEY || "";
    if (!apiKey) return null;

    const cacheKey = String(address).trim().toLowerCase();

    if (geocodeCache.has(cacheKey)) {
      const entry = geocodeCache.get(cacheKey);
      if (Date.now() - entry.t < 86400000) return entry.v;
    }

    const url =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      "?address=" + encodeURIComponent(address) +
      "&region=uk" +
      "&key=" + encodeURIComponent(apiKey);

    const res = await fetch(url);
    const data = await res.json();
    const result = data?.results?.[0];

    if (!result || !result.geometry?.location) return null;

    const out = {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      formatted: result.formatted_address || ""
    };

    geocodeCache.set(cacheKey, { v: out, t: Date.now() });

    if (geocodeCache.size > 200) {
      const firstKey = geocodeCache.keys().next().value;
      geocodeCache.delete(firstKey);
    }

    return out;
  } catch (e) {
    return null;
  }
}

// Either travel allowance (fuel or travel time) is switched on for this person.
// Falls back to the legacy single travel_status if the flags aren't backfilled.
function travelAllowanceOn(person) {
  if (!person) return false;
  const fuel = person.fuel_paid != null ? Number(person.fuel_paid) : (person.travel_status === "paid" ? 1 : 0);
  const time = person.travel_time_paid != null ? Number(person.travel_time_paid) : (person.travel_status === "paid" ? 1 : 0);
  return fuel === 1 || time === 1;
}

// May this person view the document library for `siteName`? Yes when the site is
// active (not archived) AND either they have always-on access, or they have an
// open visit there right now.
async function canViewSiteDocs(env, personId, siteName) {
  if (!personId || !siteName) return false;
  const site = await env.SITELOG_DB.prepare(
    "SELECT COALESCE(archived,0) AS archived FROM sites WHERE site_name = ?"
  ).bind(siteName).first();
  if (!site || Number(site.archived) === 1) return false;
  const person = await env.SITELOG_DB.prepare(
    "SELECT COALESCE(doc_access_always,0) AS always FROM people WHERE id = ?"
  ).bind(personId).first();
  if (person && Number(person.always) === 1) return true;
  const open = await env.SITELOG_DB.prepare(
    "SELECT 1 FROM visits WHERE person_id = ? AND site_code = ? AND check_out_at IS NULL LIMIT 1"
  ).bind(personId, siteName).first();
  return !!open;
}

async function handleTravelIn(env, visitId, personId, siteLat, siteLng) {
  try {
    const person = await env.SITELOG_DB.prepare(
      "SELECT travel_status, fuel_paid, travel_time_paid FROM people WHERE id = ?"
    ).bind(personId).first();

    // Record the home->first-site commute only if either allowance applies.
    if (!person || !travelAllowanceOn(person)) return null;

    const today = new Date().toISOString().slice(0, 10);

    const earlier = await env.SITELOG_DB.prepare(
      "SELECT COUNT(*) as cnt FROM visits WHERE person_id = ? AND date(check_in_at) = ? AND id != ?"
    ).bind(personId, today, visitId).first();

    if (earlier && earlier.cnt > 0) return null;

    const travel = await getTravelData(env, OFFICE_LAT, OFFICE_LNG, siteLat, siteLng);
    if (!travel) return null;

    await env.SITELOG_DB.prepare(
      "UPDATE visits SET travel_in_miles = ?, travel_in_mins = ?, is_first_of_day = 1 WHERE id = ?"
    ).bind(travel.miles, travel.mins, visitId).run();

    return travel;
  } catch (e) {
    return null;
  }
}

async function handleTravelOut(env, visitId, personId, siteLat, siteLng) {
  try {
    const person = await env.SITELOG_DB.prepare(
      "SELECT travel_status, fuel_paid, travel_time_paid FROM people WHERE id = ?"
    ).bind(personId).first();

    // Record the last-site->home commute only if either allowance applies.
    if (!person || !travelAllowanceOn(person)) return null;

    const travel = await getTravelData(env, siteLat, siteLng, OFFICE_LAT, OFFICE_LNG);
    if (!travel) return null;

    await env.SITELOG_DB.prepare(
      "UPDATE visits SET travel_out_miles = ?, travel_out_mins = ? WHERE id = ?"
    ).bind(travel.miles, travel.mins, visitId).run();

    return travel;
  } catch (e) {
    return null;
  }
}

function londonNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${get("hour")}:${get("minute")}`
  };
}

function londonDateKeyFromUtcString(utcString) {
  const d = new Date(utcString);
  const p = londonNowParts(d);
  return p.dateKey;
}

function londonLocalToUtcIso(londonDateKey, hhmm = "16:00:00") {
  const [year, month, day] = londonDateKey.split("-").map(Number);
  const [hour, minute, second = 0] = hhmm.split(":").map(Number);

  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  for (let i = 0; i < 3; i++) {
    const parts = londonNowParts(utc);
    const actualMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    const wantedMinutes = hour * 60 + minute;
    const diffMinutes = actualMinutes - wantedMinutes;

    utc = new Date(utc.getTime() - diffMinutes * 60 * 1000);
  }

  return utc.toISOString();
}

// Forced ("auto") checkout time for an open visit that has rolled past its day
// and was never signed out. Day shifts close at the 16:00 London policy cutoff.
// A check-in AT OR AFTER that cutoff is an evening/overnight shift — closing it
// at 16:00 the same day would land before they arrived (zero/negative hours), so
// it is instead capped at a 12-hour shift. The result is finally clamped to the
// current time so a forgotten overnight sign-out can never be stamped in the
// future. The SQL MAX(check_in_at, ?) guard still protects the lower bound.
function forcedCheckoutSql(checkInAt, visitDateKey, nowMs) {
  const checkInMs = Date.parse(String(checkInAt).replace(" ", "T") + "Z");
  const dayCutoffMs = Date.parse(londonLocalToUtcIso(visitDateKey, "16:00:00"));
  let forcedMs = dayCutoffMs;
  if (Number.isFinite(checkInMs) && checkInMs >= dayCutoffMs) {
    forcedMs = checkInMs + 12 * 60 * 60 * 1000;
  }
  if (Number.isFinite(nowMs)) forcedMs = Math.min(forcedMs, nowMs);
  return toSqlUtc(forcedMs);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isValidDateTimeString(str) {
  if (typeof str !== "string") return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function isValidDateKey(str) {
  if (typeof str !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + "T00:00:00Z");
  return !isNaN(d.getTime());
}

function isFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

function parseLatLng(str) {
  if (typeof str !== "string") return null;

  const parts = str.split(",");
  if (parts.length !== 2) return null;

  const lat = Number(parts[0]);
  const lng = Number(parts[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  let mismatch = 0;

  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

// ── Job-costing maths (server copy of docs/admin.html) ───────────────────────
// The portal's unified job costing needs the SAME per-site / per-person labour
// figures the SiteLog admin screen shows, but it can't run admin.html's
// client-side JS. These helpers are a faithful port of admin.html's costing
// functions so /job-costing returns identical numbers. KEEP IN SYNC with
// admin.html if the pay rules there change.
function jcParseStoredTs(ts) {
  if (ts == null || ts === "") return null;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === "number") { const d = new Date(ts); return isNaN(d.getTime()) ? null : d; }
  let s = String(ts).trim();
  if (/^\d{12,}$/.test(s)) { const d = new Date(Number(s)); return isNaN(d.getTime()) ? null : d; }
  s = s.replace(" ", "T");
  const hasTz = /[zZ]$/.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz) s += "Z";
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function jcMinutesBetween(a, b) {
  const s = jcParseStoredTs(a);
  if (!s) return 0;
  const e = b ? jcParseStoredTs(b) : new Date();
  if (!e) return 0;
  return Math.max(0, Math.round((e - s) / 60000));
}
function jcNameOf(v) { return ((v.first_name || "") + " " + (v.last_name || "")).trim(); }
function jcRateIsSet(v) { return v != null && String(v).trim() !== ""; }
function jcLondonDayKey(ts) {
  if (!ts) return "";
  const dt = jcParseStoredTs(ts);
  if (!dt) return String(ts).slice(0, 10);
  return dt.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
function jcFuelPaid(eng) {
  if (!eng) return false;
  if (eng.fuel_paid != null) return Number(eng.fuel_paid) === 1;
  return eng.travel_status === "paid";
}
function jcTimePaid(eng) {
  if (!eng) return false;
  if (eng.travel_time_paid != null) return Number(eng.travel_time_paid) === 1;
  return eng.travel_status === "paid";
}
function jcCalcPaidMins(actualMins, actualMiles, eng, legType) {
  if (!eng || !(actualMins > 0)) return 0;
  if (legType === "inter") return actualMins;
  if (!jcTimePaid(eng)) return 0;
  const capType = eng.travel_cap_type;
  const capVal = parseFloat(eng.travel_cap_value) || 0;
  if (!capType || capType === "none") return actualMins;
  if (capType === "time") return Math.max(0, actualMins - capVal);
  if (capType === "distance" && actualMiles > 0) {
    const unpaidMins = Math.round((Math.min(capVal, actualMiles) / actualMiles) * actualMins);
    return Math.max(0, actualMins - unpaidMins);
  }
  return 0;
}
function jcCalcPaidMiles(actualMiles, eng, legType) {
  if (!eng || !jcFuelPaid(eng) || !(actualMiles > 0)) return 0;
  if (legType === "inter") return actualMiles;
  const capType = eng.travel_cap_type;
  const capVal = parseFloat(eng.travel_cap_value) || 0;
  if (capType === "distance") return Math.max(0, actualMiles - capVal);
  return actualMiles;
}
function jcInLegType(v) { return Number(v.is_first_of_day || 0) === 1 ? "first" : "inter"; }
// Aggregate one person's visits at a site → cost components. Open (un-signed-out)
// visits are excluded from time/cost and counted separately so a forgotten
// sign-out can't inflate a total. Mirrors admin.html costEngineerVisits exactly.
function jcCostVisits(visits, eng) {
  const hasRate = !!(eng && jcRateIsSet(eng.hourly_rate));
  const rate = hasRate ? Number(eng.hourly_rate) : 0;
  const fuelRate = (jcFuelPaid(eng) && eng && eng.fuel_rate != null && Number(eng.fuel_rate) > 0) ? Number(eng.fuel_rate) : 0;
  let workMins = 0, travelMins = 0, miles = 0, openCount = 0, costedVisits = 0, autoCount = 0;
  visits.forEach((v) => {
    if (!v.check_out_at) { openCount++; return; }
    workMins += jcMinutesBetween(v.check_in_at, v.check_out_at);
    costedVisits++;
    if (Number(v.auto_checkout || 0) === 1 && !v.transferred_to) autoCount++;
    if (v.travel_in_mins != null) travelMins += jcCalcPaidMins(v.travel_in_mins, v.travel_in_miles, eng, jcInLegType(v));
    if (v.travel_out_mins != null) travelMins += jcCalcPaidMins(v.travel_out_mins, v.travel_out_miles, eng, "out");
    if (v.travel_in_miles != null) miles += jcCalcPaidMiles(v.travel_in_miles, eng, jcInLegType(v));
    if (v.travel_out_miles != null) miles += jcCalcPaidMiles(v.travel_out_miles, eng, "out");
  });
  const workH = workMins / 60, travelH = travelMins / 60;
  const labour = workH * rate, travelCost = travelH * rate, fuelCost = miles * fuelRate;
  return { rate, hasRate, workH, travelH, miles, openCount, costedVisits, autoCount,
    labour, travelCost, fuelCost, total: labour + travelCost + fuelCost };
}

// Durable device cookie. Fully effective only when the API shares the site's
// domain (a custom domain); cross-site (workers.dev vs github.io) Safari blocks
// it, so the client-side IndexedDB/localStorage stores remain the primary id.
function readDidCookie(request) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(/(?:^|;\s*)ml_did=([^;]+)/);
  return m ? m[1] : "";
}
function didSetCookie(token) {
  return { "Set-Cookie": "ml_did=" + token + "; Max-Age=63072000; Path=/; Secure; SameSite=Lax; Domain=site-log.co.uk; HttpOnly" };
}

// Default arrival rules (config key) — shown on any site that has no rules of
// its own. Stored newline-separated in the SiteLog `config` key/value table.
async function getArrivalDefaultRules(env) {
  try {
    const row = await env.SITELOG_DB.prepare("SELECT value FROM config WHERE key = 'arrival_default_rules'").first();
    if (!row || !row.value) return [];
    return String(row.value).split("\n").map((r) => r.trim()).filter((r) => r.length > 0);
  } catch { return []; }
}

// Ported SiteLog backend, now living inside mostlane-api. Faithful copy of the
// standalone worker (Mostlane/SiteLog worker.js) with env.DB → env.SITELOG_DB
// and env.ADMIN_SECRET → env.SITELOG_ADMIN_SECRET. Exposed as handle() (the full
// API router — active when the request host is api.site-log.co.uk, or called
// internally by the portal) and sweepAutoClose() (the daily auto-close, folded
// into mostlane-api's cron). Nothing else in the portal changes.
export async function handle(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsFor(request) });
    }

    function json(data, status = 200, extraHeaders) {
      const base = corsFor(request);
      const headers = extraHeaders ? { ...base, ...extraHeaders } : base;
      return Response.json(data, { status, headers });
    }

    async function readBody(req) {
      const ct = (req.headers.get("content-type") || "").toLowerCase();

      if (ct.includes("application/json")) {
        try {
          return await req.json();
        } catch {
          return {};
        }
      }

      if (
        ct.includes("application/x-www-form-urlencoded") ||
        ct.includes("multipart/form-data")
      ) {
        const form = await req.formData();
        const obj = {};
        for (const [k, v] of form.entries()) obj[k] = v;
        return obj;
      }

      try {
        return await req.json();
      } catch {
        return {};
      }
    }

    function isAdminAuthorised() {
      const secret = env.SITELOG_ADMIN_SECRET || "";
      if (!secret) return false;

      const header = request.headers.get("x-admin-secret") ?? "";
      if (!header) return false;

      return constantTimeEqual(header, secret);
    }

    function requireAdmin() {
      if (!isAdminAuthorised()) {
        return json({ ok: false, error: "Unauthorised" }, 401);
      }

      return null;
    }

    // POST /admin-auth
    if (url.pathname === "/admin-auth" && request.method === "POST") {
      const secret = env.SITELOG_ADMIN_SECRET || "";
      if (!secret) return json({ ok: false, error: "Admin secret not configured" }, 500);

      const headerSecret = request.headers.get("x-admin-secret") ?? "";

      let bodySecret = "";
      try {
        const body = await readBody(request);
        bodySecret = (body.password ?? body.adminSecret ?? body.secret ?? "").toString();
      } catch {
        bodySecret = "";
      }

      const valid =
        constantTimeEqual(headerSecret, secret) ||
        constantTimeEqual(bodySecret, secret);

      if (!valid) return json({ ok: false, error: "Invalid password" }, 401);

      return json({ ok: true });
    }

    // POST /portal-link
    // The Mostlane portal opens the scanner with a signed token (#pt=...),
    // HMAC-SHA256 over "v1.<payload>" using the shared PORTAL_BRIDGE_SECRET.
    // We verify it and stamp the portal username onto this device's person, so
    // every scan is tied to the portal user — the basis for unified job costing
    // (portal user = employee; unlinked = subcontractor). Additive + safe:
    // touches only the linked person; scanning still works if this is skipped.
    if (url.pathname === "/portal-link" && request.method === "POST") {
      const body = await readBody(request);
      const token = (body.token ?? body.pt ?? "").toString();
      const deviceToken = (
        body.deviceToken ?? body.device_token ?? readDidCookie(request) ?? ""
      ).toString().trim();
      if (!token || !deviceToken) return json({ ok: false, error: "token and deviceToken required" }, 400);
      const payload = await verifyPortalToken(env, token);
      if (!payload) return json({ ok: false, error: "invalid or expired token" }, 401);
      const portalUser = String(payload.u || "").trim();
      if (!portalUser) return json({ ok: false, error: "no portal user in token" }, 400);
      const first = String(payload.f || "").trim().slice(0, 80);
      const last = String(payload.l || "").trim().slice(0, 80);
      const company = (String(payload.c || "Mostlane").trim().slice(0, 120)) || "Mostlane";
      try {
        // Find the person: already linked to this portal user > already on this
        // device > an existing person with the same name (so history links up).
        let person = await env.SITELOG_DB.prepare(
          "SELECT id FROM people WHERE portal_username = ? LIMIT 1").bind(portalUser).first();
        if (!person) person = await env.SITELOG_DB.prepare(
          "SELECT p.id FROM devices d JOIN people p ON p.id = d.person_id WHERE d.device_token = ? LIMIT 1"
        ).bind(deviceToken).first();
        if (!person && (first || last)) person = await env.SITELOG_DB.prepare(
          "SELECT id FROM people WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?) LIMIT 1"
        ).bind(first, last).first();
        let personId = person ? person.id : null;
        if (!personId) {
          personId = crypto.randomUUID();
          await env.SITELOG_DB.prepare(
            "INSERT INTO people (id, first_name, last_name, company, archived, hourly_rate, portal_username) VALUES (?,?,?,?,0,0,?)"
          ).bind(personId, first, last, company, portalUser).run();
        } else {
          await env.SITELOG_DB.prepare(
            "UPDATE people SET portal_username=?, first_name=COALESCE(NULLIF(?,''),first_name), last_name=COALESCE(NULLIF(?,''),last_name), company=COALESCE(company,?) WHERE id=?"
          ).bind(portalUser, first, last, company, personId).run();
        }
        // Bind this device to the person (upsert).
        const dev = await env.SITELOG_DB.prepare(
          "SELECT person_id FROM devices WHERE device_token = ? LIMIT 1").bind(deviceToken).first();
        if (dev) {
          if (dev.person_id !== personId) await env.SITELOG_DB.prepare(
            "UPDATE devices SET person_id=? WHERE device_token=?").bind(personId, deviceToken).run();
        } else {
          await env.SITELOG_DB.prepare(
            "INSERT INTO devices (device_token, person_id) VALUES (?, ?)").bind(deviceToken, personId).run();
        }
        return json({ ok: true, personId, portalUsername: portalUser }, 200, didSetCookie(deviceToken));
      } catch (err) {
        console.error("portal-link failed:", err);
        return json({ ok: false, error: "link failed" }, 500);
      }
    }

    // POST /register, /signup, /add-person
    if (
      (url.pathname === "/register" ||
        url.pathname === "/signup" ||
        url.pathname === "/add-person") &&
      request.method === "POST"
    ) {
      const body = await readBody(request);

      const deviceToken = (
        body.deviceToken ??
        body.device_token ??
        body.device ??
        body.device_id ??
        readDidCookie(request) ??
        ""
      ).toString().trim();

      const firstName = (
        body.firstName ??
        body.first_name ??
        body.first ??
        ""
      ).toString().trim().slice(0, 80);

      const lastName = (
        body.lastName ??
        body.last_name ??
        body.last ??
        ""
      ).toString().trim().slice(0, 80);

      const company = ((body.company ?? "").toString().trim().slice(0, 120)) || null;
      const purpose = ((body.purpose ?? "").toString().trim().slice(0, 60)) || null;

      if (!deviceToken || deviceToken.length > 128) return json({ ok: false, error: "Missing deviceToken" }, 400);
      if (!firstName && !lastName) return json({ ok: false, error: "Missing name" }, 400);

      try {
        const existing = await env.SITELOG_DB.prepare(`
          SELECT p.id as person_id, p.first_name, p.last_name, p.company, p.purpose, COALESCE(p.archived,0) as archived
          FROM devices d
          JOIN people p ON p.id = d.person_id
          WHERE d.device_token = ?
          LIMIT 1
        `).bind(deviceToken).first();

        if (existing) {
          await env.SITELOG_DB.prepare(`
            UPDATE people
            SET first_name = ?, last_name = ?, company = COALESCE(?, company), purpose = COALESCE(?, purpose)
            WHERE id = ?
          `).bind(firstName, lastName, company, purpose, existing.person_id).run();

          return json({
            ok: true,
            status: "already_registered",
            personId: existing.person_id
          }, 200, didSetCookie(deviceToken));
        }

        const personId = crypto.randomUUID();

        await env.SITELOG_DB.prepare(`
          INSERT INTO people (id, first_name, last_name, company, purpose, archived, hourly_rate)
          VALUES (?, ?, ?, ?, ?, 0, 0)
        `).bind(personId, firstName, lastName, company, purpose).run();

        await env.SITELOG_DB.prepare(`
          INSERT INTO devices (device_token, person_id)
          VALUES (?, ?)
        `).bind(deviceToken, personId).run();

        return json({ ok: true, status: "registered", personId }, 200, didSetCookie(deviceToken));
      } catch (err) {
        console.error("register failed:", err);
        return json({
          ok: false,
          error: "Registration failed"
        }, 500);
      }
    }

    // POST /transfer-request
    if (url.pathname === "/transfer-request" && request.method === "POST") {
      const body = await readBody(request);
      const { deviceToken, firstName, lastName, company } = body;

      if (!deviceToken || !firstName || !lastName || !company) {
        return json({ ok: false, error: "Missing required fields" }, 400);
      }
      if (String(deviceToken).length > 128) {
        return json({ ok: false, error: "Invalid deviceToken" }, 400);
      }

      const existing = await env.SITELOG_DB.prepare(
        "SELECT id FROM device_transfers WHERE new_device_token = ? AND status = 'pending'"
      ).bind(deviceToken).first();

      if (existing) return json({ ok: true, already_pending: true });

      const tempPersonId = crypto.randomUUID();
      const transferId = crypto.randomUUID();
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      await env.SITELOG_DB.prepare(
        "INSERT INTO people (id, first_name, last_name, company, is_transfer_pending) VALUES (?, ?, ?, ?, 1)"
      ).bind(
        tempPersonId,
        String(firstName).trim().slice(0, 80),
        String(lastName).trim().slice(0, 80),
        String(company).trim().slice(0, 120)
      ).run();

      await env.SITELOG_DB.prepare(
        "INSERT OR REPLACE INTO devices (device_token, person_id) VALUES (?, ?)"
      ).bind(deviceToken, tempPersonId).run();

      await env.SITELOG_DB.prepare(
        "INSERT INTO device_transfers (id, new_device_token, first_name, last_name, company, status, temp_person_id, requested_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
      ).bind(
        transferId,
        deviceToken,
        firstName.trim(),
        lastName.trim(),
        company.trim(),
        tempPersonId,
        now
      ).run();

      return json({ ok: true });
    }

    // GET /pending-transfers
    if (url.pathname === "/pending-transfers" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;

      const transfers = await env.SITELOG_DB.prepare(
        "SELECT dt.*, (SELECT COUNT(*) FROM visits v WHERE v.person_id = dt.temp_person_id) as visit_count " +
        "FROM device_transfers dt WHERE dt.status = 'pending' ORDER BY dt.requested_at DESC"
      ).all();

      return json({ ok: true, transfers: transfers.results || [] });
    }

    // GET /all-engineers-for-transfer
    if (url.pathname === "/all-engineers-for-transfer" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;

      const engineers = await env.SITELOG_DB.prepare(
        "SELECT id, first_name, last_name, company FROM people " +
        "WHERE (is_transfer_pending = 0 OR is_transfer_pending IS NULL) AND (archived = 0 OR archived IS NULL) " +
        "ORDER BY last_name, first_name"
      ).all();

      return json({ ok: true, engineers: engineers.results || [] });
    }

    // POST /approve-transfer
    if (url.pathname === "/approve-transfer" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { transferId, targetPersonId } = await readBody(request);

      if (!transferId || !targetPersonId) {
        return json({ ok: false, error: "Missing transferId or targetPersonId" }, 400);
      }

      const transfer = await env.SITELOG_DB.prepare(
        "SELECT * FROM device_transfers WHERE id = ? AND status = 'pending'"
      ).bind(transferId).first();

      if (!transfer) {
        return json({ ok: false, error: "Transfer not found or already resolved" }, 404);
      }

      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      await env.SITELOG_DB.prepare("UPDATE visits SET person_id = ? WHERE person_id = ?")
        .bind(targetPersonId, transfer.temp_person_id).run();

      await env.SITELOG_DB.prepare("DELETE FROM devices WHERE person_id = ?")
        .bind(targetPersonId).run();

      await env.SITELOG_DB.prepare("INSERT OR REPLACE INTO devices (device_token, person_id) VALUES (?, ?)")
        .bind(transfer.new_device_token, targetPersonId).run();

      await env.SITELOG_DB.prepare("DELETE FROM people WHERE id = ?")
        .bind(transfer.temp_person_id).run();

      await env.SITELOG_DB.prepare(
        "UPDATE device_transfers SET status = 'approved', target_person_id = ?, resolved_at = ? WHERE id = ?"
      ).bind(targetPersonId, now, transferId).run();

      return json({ ok: true });
    }

    // POST /reject-transfer
    if (url.pathname === "/reject-transfer" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { transferId } = await readBody(request);

      if (!transferId) return json({ ok: false, error: "Missing transferId" }, 400);

      const transfer = await env.SITELOG_DB.prepare(
        "SELECT * FROM device_transfers WHERE id = ? AND status = 'pending'"
      ).bind(transferId).first();

      if (!transfer) return json({ ok: false, error: "Transfer not found" }, 404);

      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      await env.SITELOG_DB.prepare("DELETE FROM devices WHERE device_token = ?")
        .bind(transfer.new_device_token).run();

      await env.SITELOG_DB.prepare("DELETE FROM people WHERE id = ?")
        .bind(transfer.temp_person_id).run();

      await env.SITELOG_DB.prepare(
        "UPDATE device_transfers SET status = 'rejected', resolved_at = ? WHERE id = ?"
      ).bind(now, transferId).run();

      return json({ ok: true });
    }

    // GET /sites
    if (url.pathname === "/sites" && request.method === "GET") {
      await ensureOfflineSchema(env);
      const rows = await env.SITELOG_DB.prepare(
        "SELECT * FROM sites ORDER BY site_name ASC"
      ).all();

      return json({ sites: rows.results || [] });
    }

    // POST /update-site
    if (url.pathname === "/update-site" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const { id, siteName, radius, siteRules, category } = await readBody(request);

      if (!id) return json({ error: "Missing id" }, 400);
      if (!siteName) return json({ error: "Missing siteName" }, 400);

      if (category !== undefined) {
        await env.SITELOG_DB.prepare(
          "UPDATE sites SET site_name = ?, radius_m = ?, site_rules = ?, category = ? WHERE id = ?"
        ).bind(siteName, Number(radius ?? 500), siteRules ?? null, (String(category || "").trim() || "Projects"), id).run();
      } else {
        await env.SITELOG_DB.prepare(
          "UPDATE sites SET site_name = ?, radius_m = ?, site_rules = ? WHERE id = ?"
        ).bind(siteName, Number(radius ?? 500), siteRules ?? null, id).run();
      }

      return json({ ok: true });
    }

    // GET /arrival-config — the DEFAULT arrival rules + coverage counts (admin).
    if (url.pathname === "/arrival-config" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      const defaultRules = await getArrivalDefaultRules(env);
      const counts = await env.SITELOG_DB.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN site_rules IS NOT NULL AND TRIM(site_rules)!='' THEN 1 ELSE 0 END) AS withOwn FROM sites WHERE COALESCE(archived,0)=0"
      ).first();
      return json({
        ok: true, defaultRules,
        totalSites: (counts && counts.total) || 0,
        sitesWithOwnRules: (counts && counts.withOwn) || 0
      });
    }

    // POST /arrival-config — set the default arrival rules (admin).
    // Body { rules: [..] } or { text: "line\nline" }.
    if (url.pathname === "/arrival-config" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      const body = await readBody(request);
      const lines = Array.isArray(body.rules)
        ? body.rules
        : String(body.text ?? body.rules ?? "").split("\n");
      const value = lines.map((r) => String(r).trim()).filter((r) => r.length > 0).join("\n");
      await env.SITELOG_DB.prepare(
        "INSERT INTO config (key, value) VALUES ('arrival_default_rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(value).run();
      return json({ ok: true, defaultRules: value ? value.split("\n") : [] });
    }

    // POST /arrival-config/apply — stamp the default onto sites in one go, so
    // every known site shows it (admin). Body { onlyBlank: true } (default) only
    // fills sites that have no rules of their own; { onlyBlank: false } overwrites
    // every non-archived site with the default.
    if (url.pathname === "/arrival-config/apply" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      const body = await readBody(request);
      const onlyBlank = body.onlyBlank !== false;
      const rules = (await getArrivalDefaultRules(env)).join("\n");
      const sql = onlyBlank
        ? "UPDATE sites SET site_rules = ? WHERE COALESCE(archived,0)=0 AND (site_rules IS NULL OR TRIM(site_rules)='')"
        : "UPDATE sites SET site_rules = ? WHERE COALESCE(archived,0)=0";
      const res = await env.SITELOG_DB.prepare(sql).bind(rules).run();
      const changes = (res && res.meta && res.meta.changes) || 0;
      return json({ ok: true, updated: changes, onlyBlank });
    }

    // POST /toggle-site
    if (url.pathname === "/toggle-site" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { id } = await readBody(request);

      if (!id) return json({ error: "Missing id" }, 400);

      const site = await env.SITELOG_DB.prepare(
        "SELECT archived FROM sites WHERE id = ?"
      ).bind(id).first();

      if (!site) return json({ error: "Site not found" }, 404);

      const newState = site.archived ? 0 : 1;

      await env.SITELOG_DB.prepare(
        "UPDATE sites SET archived = ? WHERE id = ?"
      ).bind(newState, id).run();

      return json({ ok: true, archived: newState });
    }

    // GET /engineers
    if (url.pathname === "/engineers" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const rows = await env.SITELOG_DB.prepare(`
        SELECT id, first_name, last_name, company, purpose,
               COALESCE(archived,0) as archived,
               COALESCE(hourly_rate,0) as hourly_rate,
               COALESCE(travel_status,'not_configured') as travel_status,
               COALESCE(fuel_paid, CASE WHEN travel_status='paid' THEN 1 ELSE 0 END) as fuel_paid,
               COALESCE(travel_time_paid, CASE WHEN travel_status='paid' THEN 1 ELSE 0 END) as travel_time_paid,
               travel_cap_type, travel_cap_value, fuel_rate,
               COALESCE(is_main,0) as is_main,
               portal_username,
               COALESCE(doc_access_always,0) as doc_access_always,
               (SELECT COUNT(*) FROM visits WHERE visits.person_id = people.id) AS visit_count,
               (SELECT COUNT(*) FROM devices WHERE devices.person_id = people.id) AS device_count,
               (SELECT MAX(last_seen) FROM devices WHERE devices.person_id = people.id) AS device_last_seen
        FROM people
        ORDER BY first_name ASC, last_name ASC
      `).all();

      return json({ engineers: rows.results || [] });
    }

    // POST /add-engineer
    // Create an engineer (person) with NO device. A device can be linked later
    // when they register on a phone (via the transfer-approval flow).
    if (url.pathname === "/add-engineer" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const body = await readBody(request);
      const firstName = (body.firstName ?? body.first_name ?? "").toString().trim().slice(0, 80);
      const lastName = (body.lastName ?? body.last_name ?? "").toString().trim().slice(0, 80);
      const company = ((body.company ?? "").toString().trim().slice(0, 120)) || null;
      const purpose = ((body.purpose ?? "").toString().trim().slice(0, 60)) || null;
      const rateIn = body.hourlyRate ?? body.hourly_rate;
      // No rate given => null (unset). An explicit 0 is a valid £0 rate (e.g. a
      // bona fide subcontractor with no labour charge).
      const hourlyRate =
        rateIn === "" || rateIn == null || Number.isNaN(Number(rateIn)) ? null : Number(rateIn);
      const isMain = (body.isMain ?? body.is_main) ? 1 : 0;

      if (!firstName && !lastName) return json({ ok: false, error: "Enter a name" }, 400);

      const id = crypto.randomUUID();
      await env.SITELOG_DB.prepare(`
        INSERT INTO people (id, first_name, last_name, company, purpose, archived, hourly_rate, is_main)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).bind(id, firstName, lastName, company, purpose, hourlyRate, isMain).run();

      return json({ ok: true, id });
    }

    // POST /update-engineer
    if (url.pathname === "/update-engineer" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const body = await readBody(request);
      const id = body?.id;

      if (!id) return json({ error: "Missing id" }, 400);

      const firstName = body.firstName ?? body.first_name ?? null;
      const lastName = body.lastName ?? body.last_name ?? null;
      const company = body.company ?? null;
      const purpose = body.purpose ?? null;

      const rateIn = body.hourlyRate ?? body.hourly_rate;
      const hourlyRate =
        rateIn === "" || rateIn == null || Number.isNaN(Number(rateIn))
          ? null
          : Number(rateIn);

      // Fuel and travel time are independent now. Accept the two flags; older
      // callers that still send travelStatus map onto both (paid -> both on).
      const fuelPaidIn = body.fuelPaid;
      const travelTimePaidIn = body.travelTimePaid;
      const hasNewTravelFlags = fuelPaidIn !== undefined || travelTimePaidIn !== undefined;

      const travelStatus = body.travelStatus ?? null;
      const travelCapType = body.travelCapType ?? null;
      const travelCapValue =
        body.travelCapValue != null && body.travelCapValue !== ""
          ? Number(body.travelCapValue)
          : null;

      const fuelIn = body.fuelRate ?? body.fuel_rate;
      const fuelRate =
        fuelIn === "" || fuelIn == null || Number.isNaN(Number(fuelIn))
          ? null
          : Number(fuelIn);

      const isMainIn = body.isMain ?? body.is_main;
      const docAlwaysIn = body.docAccessAlways ?? body.doc_access_always;

      const sets = [];
      const binds = [];

      if (firstName !== null) {
        sets.push("first_name = ?");
        binds.push(firstName);
      }

      if (lastName !== null) {
        sets.push("last_name = ?");
        binds.push(lastName);
      }

      if (company !== null) {
        sets.push("company = ?");
        binds.push(company);
      }

      if (purpose !== null) {
        sets.push("purpose = ?");
        binds.push(purpose);
      }

      if (rateIn !== undefined) {
        sets.push("hourly_rate = ?");
        binds.push(hourlyRate ?? 0);
      }

      if (hasNewTravelFlags) {
        const fuelPaid = fuelPaidIn ? 1 : 0;
        const travelTimePaid = travelTimePaidIn ? 1 : 0;
        sets.push("fuel_paid = ?");
        binds.push(fuelPaid);
        sets.push("travel_time_paid = ?");
        binds.push(travelTimePaid);
        // Keep the legacy single status in sync so any code still reading it
        // ('paid' when either allowance is on) behaves sensibly.
        sets.push("travel_status = ?");
        binds.push(fuelPaid || travelTimePaid ? "paid" : "not_configured");

        sets.push("travel_cap_type = ?");
        binds.push(travelCapType);
        sets.push("travel_cap_value = ?");
        binds.push(Number.isFinite(travelCapValue) ? travelCapValue : null);
      } else if (travelStatus !== null) {
        const on = travelStatus === "paid" ? 1 : 0;
        sets.push("fuel_paid = ?");
        binds.push(on);
        sets.push("travel_time_paid = ?");
        binds.push(on);
        sets.push("travel_status = ?");
        binds.push(travelStatus);

        sets.push("travel_cap_type = ?");
        binds.push(travelCapType);

        sets.push("travel_cap_value = ?");
        binds.push(Number.isFinite(travelCapValue) ? travelCapValue : null);
      }

      if (fuelIn !== undefined) {
        sets.push("fuel_rate = ?");
        binds.push(fuelRate);
      }

      if (isMainIn !== undefined) {
        sets.push("is_main = ?");
        binds.push(isMainIn ? 1 : 0);
      }

      if (docAlwaysIn !== undefined) {
        sets.push("doc_access_always = ?");
        binds.push(docAlwaysIn ? 1 : 0);
      }

      // Manual portal link: admin maps this SiteLog person to a portal user
      // (or clears it with ""). One portal user ↔ one SiteLog person, so clear
      // the same username off anyone else first.
      const portalUserIn = body.portalUsername ?? body.portal_username;
      if (portalUserIn !== undefined) {
        const pu = String(portalUserIn || "").trim();
        if (pu) {
          try { await env.SITELOG_DB.prepare("UPDATE people SET portal_username = NULL WHERE portal_username = ? AND id != ?").bind(pu, id).run(); } catch (e) {}
        }
        sets.push("portal_username = ?");
        binds.push(pu || null);
      }

      if (!sets.length) return json({ ok: true, note: "No fields to update" });

      binds.push(id);

      await env.SITELOG_DB.prepare(
        `UPDATE people SET ${sets.join(", ")} WHERE id = ?`
      ).bind(...binds).run();

      return json({ ok: true });
    }

    // POST /toggle-engineer
    if (url.pathname === "/toggle-engineer" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { id } = await readBody(request);

      if (!id) return json({ error: "Missing id" }, 400);

      const person = await env.SITELOG_DB.prepare(
        "SELECT COALESCE(archived,0) as archived FROM people WHERE id = ?"
      ).bind(id).first();

      if (!person) return json({ error: "Engineer not found" }, 404);

      const newState = person.archived ? 0 : 1;

      await env.SITELOG_DB.prepare(
        "UPDATE people SET archived = ? WHERE id = ?"
      ).bind(newState, id).run();

      return json({ ok: true, archived: newState });
    }

    // POST /delete-engineer
    if (url.pathname === "/delete-engineer" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { id } = await readBody(request);

      if (!id) return json({ ok: false, error: "Missing id" }, 400);

      const visitCount = await env.SITELOG_DB.prepare(
        "SELECT COUNT(*) as cnt FROM visits WHERE person_id = ?"
      ).bind(id).first();

      if (visitCount && visitCount.cnt > 0) {
        await env.SITELOG_DB.prepare(
          "UPDATE people SET archived = 1 WHERE id = ?"
        ).bind(id).run();

        await env.SITELOG_DB.prepare(
          "DELETE FROM devices WHERE person_id = ?"
        ).bind(id).run();

        return json({ ok: true, message: "Archived and device links removed." });
      }

      await env.SITELOG_DB.prepare("DELETE FROM devices WHERE person_id = ?")
        .bind(id).run();

      await env.SITELOG_DB.prepare("DELETE FROM people WHERE id = ?")
        .bind(id).run();

      return json({ ok: true, message: "Engineer deleted." });
    }

    // POST /merge-people
    // Merge one or more duplicate people into a single primary person: all their
    // visits and devices are re-pointed to the primary, then the duplicate rows
    // are deleted. Mirrors the device-transfer approval flow, generalised.
    if (url.pathname === "/merge-people" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const body = await readBody(request);
      const primaryId = body?.primaryId;
      const mergeIds = Array.isArray(body?.mergeIds)
        ? [...new Set(body.mergeIds.filter(x => x && x !== primaryId))]
        : [];

      if (!primaryId) return json({ ok: false, error: "Missing primaryId" }, 400);
      if (!mergeIds.length) return json({ ok: false, error: "No people to merge" }, 400);

      const primary = await env.SITELOG_DB.prepare("SELECT id FROM people WHERE id = ?").bind(primaryId).first();
      if (!primary) return json({ ok: false, error: "Primary person not found" }, 404);

      const placeholders = mergeIds.map(() => "?").join(",");

      const moved = await env.SITELOG_DB.prepare(
        `UPDATE visits SET person_id = ? WHERE person_id IN (${placeholders})`
      ).bind(primaryId, ...mergeIds).run();

      // Re-point the duplicates' devices to the primary so either phone keeps
      // working under the one person going forward.
      await env.SITELOG_DB.prepare(
        `UPDATE devices SET person_id = ? WHERE person_id IN (${placeholders})`
      ).bind(primaryId, ...mergeIds).run();

      // Re-point document links too, so documents the duplicates were named on
      // still show for the kept person (e.g. the user app's My Documents).
      try {
        await env.SITELOG_DB.prepare(
          `UPDATE document_attendees SET person_id = ? WHERE person_id IN (${placeholders})`
        ).bind(primaryId, ...mergeIds).run();
      } catch (e) { /* documents tables may not exist on every deployment */ }

      await env.SITELOG_DB.prepare(
        `DELETE FROM people WHERE id IN (${placeholders})`
      ).bind(...mergeIds).run();

      const visitsMoved = (moved && moved.meta && moved.meta.changes) || 0;
      return json({ ok: true, merged: mergeIds.length, visitsMoved });
    }

    // POST /reset-device
    if (url.pathname === "/reset-device" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { personId } = await readBody(request);

      if (!personId) return json({ ok: false, error: "Missing personId" }, 400);

      const result = await env.SITELOG_DB.prepare(
        "DELETE FROM devices WHERE person_id = ?"
      ).bind(personId).run();

      return json({ ok: true, removedDevices: result.meta.changes });
    }

    // POST /add-site
    if (url.pathname === "/add-site" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const { siteName, lat, lng, radius, category } = await readBody(request);

      if (!siteName || lat == null || lng == null) {
        return json({ error: "Missing siteName/lat/lng" }, 400);
      }

      if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
        return json({ error: "lat/lng must be numbers" }, 400);
      }

      await env.SITELOG_DB.prepare(
        "INSERT INTO sites (id, site_name, lat, lng, radius_m, archived, category) VALUES (?, ?, ?, ?, ?, 0, ?)"
      ).bind(
        crypto.randomUUID(),
        siteName,
        Number(lat),
        Number(lng),
        Number(radius ?? 500),
        (String(category || "").trim() || "Projects")
      ).run();

      return json({ ok: true, siteName });
    }

    // POST /bulk-add-sites  — import many sites at once; skips names that already exist
    if (url.pathname === "/bulk-add-sites" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const body = await readBody(request);
      const incoming = Array.isArray(body.sites) ? body.sites : [];
      if (!incoming.length) return json({ ok: false, error: "No sites provided" }, 400);

      const existing = await env.SITELOG_DB.prepare("SELECT site_name FROM sites").all();
      const have = new Set((existing.results || []).map(r => String(r.site_name || "").trim().toLowerCase()));

      const stmts = [];
      let skipped = 0;
      const insert = env.SITELOG_DB.prepare(
        "INSERT INTO sites (id, site_name, lat, lng, radius_m, archived, category) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const s of incoming) {
        const name = String(s.siteName ?? s.n ?? "").trim();
        const lat = s.lat, lng = s.lng ?? s.lon;
        const key = name.toLowerCase();
        if (!name || !isFiniteNumber(lat) || !isFiniteNumber(lng) || have.has(key)) { skipped++; continue; }
        have.add(key);
        stmts.push(insert.bind(
          crypto.randomUUID(),
          name,
          Number(lat),
          Number(lng),
          Number(s.radius ?? 500),
          (s.archived ?? s.arch) ? 1 : 0,
          (String(s.category ?? s.cat ?? "").trim() || "Projects")
        ));
      }

      if (stmts.length) await env.SITELOG_DB.batch(stmts);
      return json({ ok: true, added: stmts.length, skipped });
    }

    // POST /manual-checkout
    if (url.pathname === "/manual-checkout" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { visitId, manualTime } = await readBody(request);

      if (!visitId) return json({ ok: false, error: "Missing visitId" }, 400);

      if (manualTime !== undefined && manualTime !== "" && !isValidDateTimeString(manualTime)) {
        return json({ ok: false, error: "Invalid manualTime format" }, 400);
      }

      if (manualTime) {
        const vrow = await env.SITELOG_DB.prepare(
          "SELECT check_in_at FROM visits WHERE id = ?"
        ).bind(visitId).first();
        if (vrow && vrow.check_in_at && new Date(manualTime) <= new Date(vrow.check_in_at)) {
          return json({ ok: false, error: "Sign-out time must be after sign-in time" }, 400);
        }
      }

      let checkoutTimeSQL = "CURRENT_TIMESTAMP";
      let bindValues = [visitId];

      if (manualTime) {
        checkoutTimeSQL = "?";
        bindValues = [manualTime, visitId];
      }

      const sql =
        `UPDATE visits SET check_out_at = ${checkoutTimeSQL}, auto_checkout = 0 WHERE id = ? AND check_out_at IS NULL`;

      const result = await env.SITELOG_DB.prepare(sql).bind(...bindValues).run();

      if (result.meta.changes === 0) {
        return json({ ok: false, error: "Visit not found or already checked out" }, 400);
      }

      return json({ ok: true });
    }

    // POST /add-visit
    // Admin manually logs a visit for a person (job costing / corrections).
    // No GPS; flagged manual_entry = 1. Times are taken as entered.
    if (url.pathname === "/add-visit" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const { personId, site, checkInAt, checkOutAt } = await readBody(request);
      if (!personId || !site || !checkInAt) {
        return json({ ok: false, error: "Missing person, site or start time" }, 400);
      }
      const siteName = String(site).trim().slice(0, 120);
      if (!siteName) return json({ ok: false, error: "Missing site" }, 400);
      if (!isValidDateTimeString(checkInAt)) return json({ ok: false, error: "Invalid start time" }, 400);
      if (checkOutAt && !isValidDateTimeString(checkOutAt)) return json({ ok: false, error: "Invalid end time" }, 400);
      if (checkOutAt && new Date(checkOutAt) <= new Date(checkInAt)) {
        return json({ ok: false, error: "End time must be after start time" }, 400);
      }

      const person = await env.SITELOG_DB.prepare("SELECT id FROM people WHERE id = ?").bind(personId).first();
      if (!person) return json({ ok: false, error: "Person not found" }, 404);

      const id = crypto.randomUUID();
      await env.SITELOG_DB.prepare(`
        INSERT INTO visits
          (id, person_id, site_code, lat, lng, accuracy, hs_ack, auto_checkout, sign_in_confirmed, sign_out_confirmed, manual_entry, check_in_at, check_out_at)
        VALUES (?, ?, ?, NULL, NULL, NULL, 1, 0, 1, 1, 1, ?, ?)
      `).bind(id, personId, siteName, checkInAt, checkOutAt ?? null).run();

      return json({ ok: true, visitId: id });
    }

    // POST /update-visit-times
    if (url.pathname === "/update-visit-times" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { visitId, checkInAt, checkOutAt } = await readBody(request);

      if (!visitId) return json({ ok: false, error: "Missing visitId" }, 400);
      if (!checkInAt || !isValidDateTimeString(checkInAt)) {
        return json({ ok: false, error: "Invalid checkInAt" }, 400);
      }

      if (checkOutAt && !isValidDateTimeString(checkOutAt)) {
        return json({ ok: false, error: "Invalid checkOutAt" }, 400);
      }

      if (checkOutAt && new Date(checkOutAt) <= new Date(checkInAt)) {
        return json({ ok: false, error: "check_out_at must be after check_in_at" }, 400);
      }

      await env.SITELOG_DB.prepare(
        "UPDATE visits SET check_in_at = ?, check_out_at = ? WHERE id = ?"
      ).bind(checkInAt, checkOutAt ?? null, visitId).run();

      return json({ ok: true });
    }

    // POST /confirm-checkout
    if (url.pathname === "/confirm-checkout" && request.method === "POST") {
      const { visitId } = await readBody(request);

      if (!visitId) return json({ ok: false, error: "Missing visitId" }, 400);

      const result = await env.SITELOG_DB.prepare(`
        UPDATE visits
        SET check_out_at = MAX(check_in_at, COALESCE(check_out_at, CURRENT_TIMESTAMP)),
            auto_checkout = 0,
            sign_out_confirmed = 1
        WHERE id = ?
      `).bind(visitId).run();

      if (result.meta.changes === 0) {
        return json({ ok: false, error: "Visit not found" }, 400);
      }

      let travelOut = null;

      try {
        const visit = await env.SITELOG_DB.prepare(
          "SELECT person_id, site_code FROM visits WHERE id = ?"
        ).bind(visitId).first();

        if (visit) {
          const siteRow = await env.SITELOG_DB.prepare(
            "SELECT lat, lng FROM sites WHERE site_name = ?"
          ).bind(visit.site_code).first();

          if (siteRow) {
            travelOut = await handleTravelOut(
              env,
              visitId,
              visit.person_id,
              siteRow.lat,
              siteRow.lng
            );
          }
        }
      } catch (e) {}

      return json({ ok: true, status: "checked_out", travel: travelOut });
    }

    // POST /confirm-checkin
    if (url.pathname === "/confirm-checkin" && request.method === "POST") {
      const { deviceToken, lat, lng, accuracy, site, visitId } = await readBody(request);

      if (!deviceToken) return json({ ok: false, error: "Missing deviceToken" }, 400);
      if (!site) return json({ ok: false, error: "Missing site" }, 400);

      const siteCheck = await env.SITELOG_DB.prepare(`
        SELECT id, lat, lng
        FROM sites
        WHERE site_name = ? AND COALESCE(archived,0) = 0
        LIMIT 1
      `).bind(site).first();

      if (!siteCheck) {
        return json({ ok: false, error: "Site not found or archived" }, 404);
      }

      if (lat != null && lat !== "" && !isFiniteNumber(lat)) {
        return json({ ok: false, error: "Invalid lat" }, 400);
      }

      if (lng != null && lng !== "" && !isFiniteNumber(lng)) {
        return json({ ok: false, error: "Invalid lng" }, 400);
      }

      const device = await env.SITELOG_DB.prepare(
        "SELECT person_id FROM devices WHERE device_token = ?"
      ).bind(deviceToken).first();

      if (!device) return json({ ok: false, error: "Device not registered" }, 404);

      const person = await env.SITELOG_DB.prepare(
        "SELECT first_name, company FROM people WHERE id = ?"
      ).bind(device.person_id).first();

      let targetId = visitId || null;
      const siteRow = await env.SITELOG_DB.prepare(
        "SELECT lat, lng FROM sites WHERE site_name = ?"
      ).bind(site).first();

      if (!targetId) {
        const openVisit = await env.SITELOG_DB.prepare(`
          SELECT id
          FROM visits
          WHERE person_id = ? AND site_code = ? AND check_out_at IS NULL
          ORDER BY check_in_at DESC
          LIMIT 1
        `).bind(device.person_id, site).first();

        if (openVisit) targetId = openVisit.id;
      }

      let travelIn = null;

      if (targetId) {
        await env.SITELOG_DB.prepare(
          "UPDATE visits SET sign_in_confirmed = 1, hs_ack = 1 WHERE id = ?"
        ).bind(targetId).run();

        try {
          if (siteRow) {
            travelIn = await handleTravelIn(
              env,
              targetId,
              device.person_id,
              siteRow.lat,
              siteRow.lng
            );
          }
        } catch (e) {}

        return json({
          ok: true,
          status: "checked_in",
          site,
          firstName: person?.first_name || null,
          company: person?.company || null,
          travel: travelIn
        });
      }

      const newVisitId = crypto.randomUUID();

      // Moved sites without signing out? Auto-close the still-open visit at the
      // time they LEFT it (this arrival − the A→B drive time), and attribute the
      // A→B journey to this new visit's inbound travel (paid). The gap between
      // the two visits is the drive.
      let transferTravel = null;
      let transferredFrom = null;
      const nowMs = Date.now();
      const nowSql = toSqlUtc(nowMs);
      try {
        const openA = await env.SITELOG_DB.prepare(`
          SELECT id, site_code, check_in_at, lat, lng FROM visits
          WHERE person_id = ? AND check_out_at IS NULL AND site_code != ?
          ORDER BY check_in_at DESC LIMIT 1
        `).bind(device.person_id, site).first();

        if (openA) {
          transferredFrom = openA.site_code;

          // Inter-site (mid-day) travel time is paid to EVERYONE, so always
          // measure the A->B drive regardless of the person's allowance — it
          // also drives the accurate back-dating of A's checkout below.
          if (siteRow) {
            // Prefer the GPS captured when they checked into A (robust to A being
            // renamed/archived/moved); fall back to A's configured site coords.
            let aLat = isFiniteNumber(openA.lat) ? Number(openA.lat) : null;
            let aLng = isFiniteNumber(openA.lng) ? Number(openA.lng) : null;
            if (aLat === null || aLng === null) {
              const aSite = await env.SITELOG_DB.prepare(
                "SELECT lat, lng FROM sites WHERE site_name = ?"
              ).bind(openA.site_code).first();
              if (aSite) { aLat = aSite.lat; aLng = aSite.lng; }
            }
            if (aLat !== null && aLng !== null) {
              transferTravel = await getTravelData(env, aLat, aLng, siteRow.lat, siteRow.lng);
            }
          }

          // Only back-date A and credit the drive when it fits between A's
          // check-in and this arrival; otherwise the hop was too short for a real
          // drive — close A at the arrival time and credit no travel (avoids a
          // zero-duration A and phantom travel pay). transferred_to records the move.
          const aInMs = Date.parse(String(openA.check_in_at).replace(" ", "T") + "Z");
          let leftSql = nowSql;
          if (transferTravel && Number.isFinite(aInMs) && transferTravel.mins * 60000 < (nowMs - aInMs)) {
            leftSql = toSqlUtc(nowMs - transferTravel.mins * 60000);
          } else {
            transferTravel = null;
          }
          await env.SITELOG_DB.prepare(`
            UPDATE visits SET check_out_at = MAX(check_in_at, ?), auto_checkout = 1, sign_out_confirmed = 0, transferred_to = ?
            WHERE id = ? AND check_out_at IS NULL
          `).bind(leftSql, site, openA.id).run();
        }
      } catch (e) {}

      await env.SITELOG_DB.prepare(`
        INSERT INTO visits
          (id, person_id, site_code, lat, lng, accuracy, hs_ack, auto_checkout, sign_in_confirmed, sign_out_confirmed, check_in_at, travel_in_miles, travel_in_mins)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, 0, ?, ?, ?)
      `).bind(
        newVisitId,
        device.person_id,
        site,
        lat ?? null,
        lng ?? null,
        accuracy ?? null,
        nowSql,
        transferTravel ? transferTravel.miles : null,
        transferTravel ? transferTravel.mins : null
      ).run();

      try {
        // When the journey here was a site transfer, that IS the inbound travel.
        // Otherwise fall back to office→site (first visit of the day).
        if (transferTravel) {
          travelIn = transferTravel;
        } else if (siteRow) {
          travelIn = await handleTravelIn(
            env,
            newVisitId,
            device.person_id,
            siteRow.lat,
            siteRow.lng
          );
        }
      } catch (e) {}

      return json({
        ok: true,
        status: "checked_in",
        site,
        firstName: person?.first_name || null,
        company: person?.company || null,
        travel: travelIn,
        transferFrom: transferredFrom
      });
    }

    // POST /checkin-unmatched
    // Check in when the GPS matched no configured site. The visit is stored
    // with the captured location and a worker-typed site name, flagged for an
    // admin to later create a site or link it to an existing one. No travel is
    // computed until it's resolved to a real (geofenced) site.
    if (url.pathname === "/checkin-unmatched" && request.method === "POST") {
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      const deviceToken = (body.deviceToken || readDidCookie(request) || "").toString().trim();
      const siteName = (body.siteName || "").toString().trim().slice(0, 120);
      const lat = body.lat, lng = body.lng, accuracy = body.accuracy;

      if (!deviceToken) return json({ ok: false, error: "Missing deviceToken" }, 400);
      if (!siteName) return json({ ok: false, error: "Please enter a site name" }, 400);
      if (lat != null && lat !== "" && !isFiniteNumber(lat)) return json({ ok: false, error: "Invalid lat" }, 400);
      if (lng != null && lng !== "" && !isFiniteNumber(lng)) return json({ ok: false, error: "Invalid lng" }, 400);

      const device = await env.SITELOG_DB.prepare(
        "SELECT person_id FROM devices WHERE device_token = ?"
      ).bind(deviceToken).first();
      if (!device) return json({ ok: false, error: "Device not registered" }, 404);

      const person = await env.SITELOG_DB.prepare(
        "SELECT first_name, company FROM people WHERE id = ?"
      ).bind(device.person_id).first();

      await env.SITELOG_DB.prepare(`
        INSERT INTO visits
          (id, person_id, site_code, lat, lng, accuracy, hs_ack, auto_checkout, sign_in_confirmed, sign_out_confirmed, unmatched_site, provided_site_name)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, 0, 1, ?)
      `).bind(
        crypto.randomUUID(),
        device.person_id,
        siteName,
        isFiniteNumber(lat) ? Number(lat) : null,
        isFiniteNumber(lng) ? Number(lng) : null,
        isFiniteNumber(accuracy) ? Number(accuracy) : null,
        siteName
      ).run();

      return json({
        ok: true,
        status: "checked_in",
        site: siteName,
        unmatched: true,
        firstName: person?.first_name || null,
        company: person?.company || null
      });
    }

    // POST /resolve-unmatched
    // Admin links an unmatched check-in to a site: either create a new site at
    // the visit's captured GPS, or attach it to an existing site.
    if (url.pathname === "/resolve-unmatched" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const { visitId, mode, siteName, radius, existingSiteName } = await readBody(request);
      if (!visitId) return json({ ok: false, error: "Missing visitId" }, 400);

      const visit = await env.SITELOG_DB.prepare(
        "SELECT id, lat, lng FROM visits WHERE id = ?"
      ).bind(visitId).first();
      if (!visit) return json({ ok: false, error: "Visit not found" }, 404);

      if (mode === "create") {
        const name = (siteName || "").toString().trim().slice(0, 120);
        if (!name) return json({ ok: false, error: "Missing site name" }, 400);
        if (!isFiniteNumber(visit.lat) || !isFiniteNumber(visit.lng)) {
          return json({ ok: false, error: "This visit has no captured location, so a site can't be created from it. Link to an existing site instead." }, 400);
        }
        const existing = await env.SITELOG_DB.prepare(
          "SELECT id FROM sites WHERE site_name = ?"
        ).bind(name).first();
        if (!existing) {
          await env.SITELOG_DB.prepare(
            "INSERT INTO sites (id, site_name, lat, lng, radius_m, archived) VALUES (?, ?, ?, ?, ?, 0)"
          ).bind(crypto.randomUUID(), name, Number(visit.lat), Number(visit.lng), Number(radius ?? 500)).run();
        }
        await env.SITELOG_DB.prepare(
          "UPDATE visits SET site_code = ?, unmatched_site = 0 WHERE id = ?"
        ).bind(name, visitId).run();
        return json({ ok: true, site: name, created: !existing });
      }

      if (mode === "link") {
        const name = (existingSiteName || "").toString().trim();
        if (!name) return json({ ok: false, error: "Missing site to link to" }, 400);
        const site = await env.SITELOG_DB.prepare(
          "SELECT id FROM sites WHERE site_name = ?"
        ).bind(name).first();
        if (!site) return json({ ok: false, error: "Site not found" }, 404);
        await env.SITELOG_DB.prepare(
          "UPDATE visits SET site_code = ?, unmatched_site = 0 WHERE id = ?"
        ).bind(name, visitId).run();
        return json({ ok: true, site: name });
      }

      return json({ ok: false, error: "Invalid mode" }, 400);
    }

    if (url.pathname === "/delete-visit" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { visitId } = await readBody(request);

      if (!visitId) return json({ error: "Missing visitId" }, 400);

      await env.SITELOG_DB.prepare(
        "DELETE FROM visits WHERE id = ?"
      ).bind(visitId).run();

      return json({ ok: true });
    }

    // POST /sync-event
    // Replays an offline-captured sign in/out once the device is back online.
    // The client just queues the raw event (device token, GPS, the device-clock
    // timestamp, and whether they meant to sign in or out); all the reconciling
    // happens here against current state, so events are never missed.
    if (url.pathname === "/sync-event" && request.method === "POST") {
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      const deviceToken = (body.deviceToken || readDidCookie(request) || "").toString().trim();
      const intent = body.intent === "out" ? "out" : "in";
      const accuracy = isFiniteNumber(body.accuracy) ? Number(body.accuracy) : null;
      if (!deviceToken) return json({ ok: false, error: "Missing deviceToken" }, 400);

      await touchDevice(env, deviceToken);

      // Trust the device clock, but correct for a constant clock offset and
      // guard against garbage / future timestamps. The client reports its own
      // clock (clientNow) at SEND time; the gap to our clock is the device's
      // skew, which we subtract from the captured event time so a mis-set phone
      // clock doesn't shift the recorded sign-in/out. (Old clients that don't
      // send clientNow get skew 0 — identical to the previous behaviour.)
      const nowMs = Date.now();
      const clientNowMs = typeof body.clientNow === "string" ? Date.parse(body.clientNow) : NaN;
      let skewMs = 0;
      if (Number.isFinite(clientNowMs)) {
        const s = nowMs - clientNowMs;
        // Ignore sub-minute gaps (latency/rounding); cap the correction so a
        // wildly wrong clientNow can't itself manufacture a bad timestamp.
        if (Math.abs(s) > 60 * 1000) {
          const CAP = 2 * 24 * 60 * 60 * 1000;
          skewMs = Math.max(-CAP, Math.min(CAP, s));
        }
      }
      const parsed = typeof body.occurredAt === "string" ? Date.parse(body.occurredAt) : NaN;
      const correctedMs = Number.isFinite(parsed) ? parsed + skewMs : NaN;
      const occurredMs =
        Number.isFinite(correctedMs) && correctedMs <= nowMs + 5 * 60 * 1000 && correctedMs >= nowMs - 30 * 24 * 60 * 60 * 1000
          ? correctedMs
          : nowMs;
      const occurredSql = toSqlUtc(occurredMs);

      // Resolve which site the captured GPS falls inside (mirrors /scan).
      const lat = body.lat, lng = body.lng;
      const latVal = isFiniteNumber(lat) ? Number(lat) : null;
      const lngVal = isFiniteNumber(lng) ? Number(lng) : null;
      let matchedSite = null;
      if (latVal !== null && lngVal !== null && latVal >= -90 && latVal <= 90 && lngVal >= -180 && lngVal <= 180) {
        const siteRows = await env.SITELOG_DB.prepare("SELECT * FROM sites WHERE COALESCE(archived,0) = 0").all();
        let bestDist = null;
        for (const s of siteRows.results || []) {
          const d = haversineMeters(latVal, lngVal, Number(s.lat), Number(s.lng));
          if (d <= Number(s.radius_m) && (bestDist === null || d < bestDist)) { bestDist = d; matchedSite = s; }
        }
      }

      const device = await env.SITELOG_DB.prepare(
        "SELECT * FROM devices WHERE device_token = ?"
      ).bind(deviceToken).first();

      const logPending = async (siteCode, reason) => {
        await env.SITELOG_DB.prepare(
          "INSERT INTO pending_events (id, device_token, lat, lng, accuracy, site_code, intent, occurred_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
        ).bind(crypto.randomUUID(), deviceToken, latVal, lngVal, accuracy, siteCode, intent, occurredSql).run();
        return json({ ok: true, status: "logged_pending", reason });
      };

      // Unknown device, or GPS not inside any site -> log so nothing is lost.
      if (!device) return await logPending(matchedSite ? matchedSite.site_name : null, "unknown_device");
      if (!matchedSite) return await logPending(null, "no_site_match");

      const siteCode = matchedSite.site_name;
      const openVisit = await env.SITELOG_DB.prepare(
        "SELECT id, check_in_at FROM visits WHERE person_id = ? AND site_code = ? AND check_out_at IS NULL ORDER BY check_in_at DESC"
      ).bind(device.person_id, siteCode).first();

      if (intent === "out") {
        if (!openVisit) return await logPending(siteCode, "no_open_visit");
        // Use the offline time only if it's after check-in; else fall back to now.
        // Both strings are 'YYYY-MM-DD HH:MM:SS' UTC, so they compare lexically.
        const outSql = occurredSql > String(openVisit.check_in_at) ? occurredSql : toSqlUtc(nowMs);
        await env.SITELOG_DB.prepare(
          "UPDATE visits SET check_out_at = ?, auto_checkout = 0, sign_out_confirmed = 1, offline_synced = 1 WHERE id = ? AND check_out_at IS NULL"
        ).bind(outSql, openVisit.id).run();
        return json({ ok: true, status: "checked_out", site: siteCode, offline: true });
      }

      // intent === "in" — idempotent if already on site at this site.
      if (openVisit) return json({ ok: true, status: "already_in", site: siteCode, offline: true });
      // Idempotency on retry: if a response was lost and the same event is
      // re-sent, a visit with this exact person+site+timestamp already exists
      // (even if since signed out) — don't create a duplicate check-in.
      const dupIn = await env.SITELOG_DB.prepare(
        "SELECT id FROM visits WHERE person_id = ? AND site_code = ? AND check_in_at = ? LIMIT 1"
      ).bind(device.person_id, siteCode, occurredSql).first();
      if (dupIn) return json({ ok: true, status: "duplicate_ignored", site: siteCode, offline: true });

      // Moved sites without signing out (offline) — same handling as the online
      // /confirm-checkin flow: close the still-open site at the time they left
      // (this arrival minus the A->B drive) and attribute that drive to this
      // visit's inbound paid travel. Uses the device-clock time for the maths.
      let offTravel = null, offTransferFrom = null;
      // Only a visit that was open BEFORE this offline event can be the site it
      // transferred from. Without the check_in_at < occurredSql guard, replaying
      // an old queued check-in could wrongly close a LATER (current) visit at a
      // different site and mark it transferred.
      const openOther = await env.SITELOG_DB.prepare(
        "SELECT id, site_code, check_in_at, lat, lng FROM visits WHERE person_id = ? AND check_out_at IS NULL AND site_code != ? AND check_in_at < ? ORDER BY check_in_at DESC LIMIT 1"
      ).bind(device.person_id, siteCode, occurredSql).first();
      if (openOther) {
        offTransferFrom = openOther.site_code;
        // Inter-site travel time is paid to everyone — always measure the drive
        // (also used to back-date the site they left).
        {
          let aLat = isFiniteNumber(openOther.lat) ? Number(openOther.lat) : null;
          let aLng = isFiniteNumber(openOther.lng) ? Number(openOther.lng) : null;
          if (aLat === null || aLng === null) {
            const aSite = await env.SITELOG_DB.prepare(
              "SELECT lat, lng FROM sites WHERE site_name = ?"
            ).bind(openOther.site_code).first();
            if (aSite) { aLat = aSite.lat; aLng = aSite.lng; }
          }
          if (aLat !== null && aLng !== null) offTravel = await getTravelData(env, aLat, aLng, matchedSite.lat, matchedSite.lng);
        }
        // Only back-date + credit the drive if it fits the gap (see /confirm-checkin).
        const aInMs = Date.parse(String(openOther.check_in_at).replace(" ", "T") + "Z");
        let leftSql = occurredSql;
        if (offTravel && Number.isFinite(aInMs) && offTravel.mins * 60000 < (occurredMs - aInMs)) {
          leftSql = toSqlUtc(occurredMs - offTravel.mins * 60000);
        } else {
          offTravel = null;
        }
        await env.SITELOG_DB.prepare(
          "UPDATE visits SET check_out_at = MAX(check_in_at, ?), auto_checkout = 1, sign_out_confirmed = 0, transferred_to = ? WHERE id = ? AND check_out_at IS NULL"
        ).bind(leftSql, siteCode, openOther.id).run();
      }

      await env.SITELOG_DB.prepare(
        "INSERT INTO visits (id, person_id, site_code, lat, lng, accuracy, hs_ack, auto_checkout, sign_in_confirmed, sign_out_confirmed, offline_synced, check_in_at, travel_in_miles, travel_in_mins) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, 0, 1, ?, ?, ?)"
      ).bind(crypto.randomUUID(), device.person_id, siteCode, latVal, lngVal, accuracy, occurredSql, offTravel ? offTravel.miles : null, offTravel ? offTravel.mins : null).run();
      return json({ ok: true, status: "checked_in", site: siteCode, offline: true, transferFrom: offTransferFrom });
    }

    // GET /pending-events  (offline events the server could not attribute)
    if (url.pathname === "/pending-events" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const rows = await env.SITELOG_DB.prepare(
        "SELECT id, device_token, lat, lng, accuracy, site_code, intent, occurred_at, synced_at FROM pending_events WHERE COALESCE(resolved,0) = 0 ORDER BY occurred_at DESC LIMIT 200"
      ).all();
      return json({ ok: true, events: rows.results || [] });
    }

    // POST /scan
    if (url.pathname === "/scan" && request.method === "POST") {
      const body = await readBody(request);
      const lat = body.lat, lng = body.lng, accuracy = body.accuracy;
      const deviceToken = body.deviceToken || readDidCookie(request);

      if (!deviceToken) return json({ ok: false, error: "Missing deviceToken" }, 400);

      if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
        return json({ ok: false, error: "Missing or invalid lat/lng" }, 400);
      }

      await touchDevice(env, deviceToken);

      const latNum = Number(lat);
      const lngNum = Number(lng);

      if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
        return json({ ok: false, error: "lat/lng out of range" }, 400);
      }

      const siteRows = await env.SITELOG_DB.prepare(
        "SELECT * FROM sites WHERE COALESCE(archived,0) = 0"
      ).all();

      let matchedSite = null;
      let bestDist = null;

      for (const s of siteRows.results || []) {
        const d = haversineMeters(latNum, lngNum, Number(s.lat), Number(s.lng));

        if (d <= Number(s.radius_m) && (bestDist === null || d < bestDist)) {
          bestDist = d;
          matchedSite = s;
        }
      }

      if (!matchedSite) {
        // Even with no GPS-matched site, a device that is currently signed in
        // must be able to sign OUT — otherwise an unmatched-location check-in
        // (or someone who left a site and has no signal at a matched one) is
        // stuck open until the 16:00 auto-close. Offer sign-out for their most
        // recent open visit.
        const devNoSite = await env.SITELOG_DB.prepare(
          "SELECT * FROM devices WHERE device_token = ?"
        ).bind(deviceToken).first();
        if (devNoSite) {
          const openAny = await env.SITELOG_DB.prepare(
            "SELECT id, site_code FROM visits WHERE person_id = ? AND check_out_at IS NULL ORDER BY check_in_at DESC LIMIT 1"
          ).bind(devNoSite.person_id).first();
          if (openAny) {
            const perNoSite = await env.SITELOG_DB.prepare(
              "SELECT first_name, company FROM people WHERE id = ?"
            ).bind(devNoSite.person_id).first();
            return json({
              status: "confirm_sign_out",
              visitId: openAny.id,
              site: openAny.site_code,
              firstName: perNoSite?.first_name || null,
              company: perNoSite?.company || null
            });
          }
        }

        let nearestSite = null;
        let nearestDist = null;

        for (const s of siteRows.results || []) {
          const d = haversineMeters(latNum, lngNum, Number(s.lat), Number(s.lng));

          if (nearestDist === null || d < nearestDist) {
            nearestDist = d;
            nearestSite = s;
          }
        }

        if (!nearestSite) {
          return json({ status: "unknown_site", reason: "No active sites configured" });
        }

        return json({
          status: "unknown_site",
          nearestSite: nearestSite.site_name,
          distance_m: Math.round(nearestDist)
        });
      }

      const siteCode = matchedSite.site_name;
      const rulesRaw = matchedSite.site_rules || "";
      let siteRules = rulesRaw
        .split("\n")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      // A site with no rules of its own falls back to the portal-set DEFAULT
      // arrival rules (config key arrival_default_rules), so every site shows
      // something on arrival without setting each one individually.
      if (!siteRules.length) siteRules = await getArrivalDefaultRules(env);

      const device = await env.SITELOG_DB.prepare(
        "SELECT * FROM devices WHERE device_token = ?"
      ).bind(deviceToken).first();

      if (!device) {
        return json({ status: "first_visit", site: siteCode, siteRules });
      }

      const isArchived = await env.SITELOG_DB.prepare(
        "SELECT COALESCE(archived,0) as archived FROM people WHERE id = ?"
      ).bind(device.person_id).first();

      if (isArchived && isArchived.archived) {
        return json({ status: "blocked", reason: "engineer_archived" });
      }

      const person = await env.SITELOG_DB.prepare(
        "SELECT first_name, company FROM people WHERE id = ?"
      ).bind(device.person_id).first();

      const allOpenVisits = await env.SITELOG_DB.prepare(
        "SELECT id, site_code, check_in_at FROM visits WHERE person_id = ? AND check_out_at IS NULL"
      ).bind(device.person_id).all();

      const nowLondon = londonNowParts();
      const nowDateKey = nowLondon.dateKey;

      for (const v of allOpenVisits.results || []) {
        const visitDateKey = londonDateKeyFromUtcString(v.check_in_at);

        if (visitDateKey < nowDateKey) {
          // Day shift -> 16:00 cutoff; evening/overnight check-in -> 12h cap.
          // MAX(check_in_at, ...) additionally guards against negative durations.
          const forcedCheckoutUtc = forcedCheckoutSql(v.check_in_at, visitDateKey, Date.now());

          await env.SITELOG_DB.prepare(`
            UPDATE visits
            SET check_out_at = MAX(check_in_at, ?), auto_checkout = 1
            WHERE id = ? AND check_out_at IS NULL
          `).bind(forcedCheckoutUtc, v.id).run();
        }
      }

      const openVisit = await env.SITELOG_DB.prepare(`
        SELECT *
        FROM visits
        WHERE person_id = ? AND site_code = ? AND check_out_at IS NULL
      `).bind(device.person_id, siteCode).first();

      if (openVisit) {
        return json({
          status: "confirm_sign_out",
          visitId: openVisit.id,
          site: siteCode,
          firstName: person?.first_name || null,
          company: person?.company || null
        });
      }

      return json({
        status: "confirm_check_in",
        site: siteCode,
        firstName: person?.first_name || null,
        company: person?.company || null,
        siteRules
      });
    }

    // GET /companies
    if (url.pathname === "/companies" && request.method === "GET") {
      const rows = await env.SITELOG_DB.prepare(
        "SELECT id, name FROM companies ORDER BY name ASC"
      ).all();

      return json({ companies: rows.results || [] });
    }

    // POST /add-company
    if (url.pathname === "/add-company" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { name } = await readBody(request);

      if (!name || !name.trim()) {
        return json({ ok: false, error: "Missing company name" }, 400);
      }

      await env.SITELOG_DB.prepare(
        "INSERT INTO companies (id, name) VALUES (?, ?)"
      ).bind(crypto.randomUUID(), name.trim()).run();

      return json({ ok: true });
    }

    // POST /delete-company
    if (url.pathname === "/delete-company" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const { id } = await readBody(request);

      if (!id) return json({ ok: false, error: "Missing id" }, 400);

      await env.SITELOG_DB.prepare(
        "DELETE FROM site_company_map WHERE company_id = ?"
      ).bind(id).run();

      await env.SITELOG_DB.prepare(
        "DELETE FROM companies WHERE id = ?"
      ).bind(id).run();

      return json({ ok: true });
    }

    // GET /companies-for-site
    if (url.pathname === "/companies-for-site" && request.method === "GET") {
      const siteName = url.searchParams.get("site");

      if (!siteName) return json({ error: "Missing site parameter" }, 400);

      const rows = await env.SITELOG_DB.prepare(`
        SELECT c.id, c.name
        FROM sites s
        JOIN site_company_map m ON m.site_id = s.id
        JOIN companies c ON c.id = m.company_id
        WHERE s.site_name = ?
        ORDER BY c.name ASC
      `).bind(siteName).all();

      return json({ companies: rows.results || [] });
    }

    // POST /update-site-companies
    if (url.pathname === "/update-site-companies" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const mappings = await readBody(request);

      if (!mappings || typeof mappings !== "object") {
        return json({ ok: false, error: "Invalid payload" }, 400);
      }

      try {
        const statements = [];

        for (const siteId of Object.keys(mappings)) {
          statements.push(
            env.SITELOG_DB.prepare("DELETE FROM site_company_map WHERE site_id = ?").bind(siteId)
          );

          const companies = mappings[siteId];
          if (!Array.isArray(companies)) continue;

          for (const companyId of companies) {
            statements.push(
              env.SITELOG_DB.prepare("INSERT INTO site_company_map (site_id, company_id) VALUES (?, ?)")
                .bind(siteId, companyId)
            );
          }
        }

        if (statements.length) await env.SITELOG_DB.batch(statements);

        return json({ ok: true });
      } catch (err) {
        console.error("update-site-companies failed:", err);
        return json({
          ok: false,
          error: "Database update failed"
        }, 500);
      }
    }

    // GET /site-occupants
    if (url.pathname === "/site-occupants" && request.method === "GET") {
      const siteName = url.searchParams.get("site");

      if (!siteName) return json({ error: "Missing site parameter" }, 400);

      const rows = await env.SITELOG_DB.prepare(`
        SELECT p.first_name, p.last_name, p.company, p.purpose, v.check_in_at
        FROM visits v
        JOIN people p ON v.person_id = p.id
        WHERE v.site_code = ? AND v.check_out_at IS NULL AND COALESCE(p.archived,0) = 0
        ORDER BY v.check_in_at ASC
      `).bind(siteName).all();

      return json({ occupants: rows.results || [] });
    }

    // GET /my-visits
    if (url.pathname === "/my-visits" && request.method === "GET") {
      const deviceToken = url.searchParams.get("deviceToken");
      const limit = Math.min(Number(url.searchParams.get("limit") || 60), 200);

      if (!deviceToken) return json({ error: "Missing deviceToken" }, 400);

      const device = await env.SITELOG_DB.prepare(
        "SELECT person_id FROM devices WHERE device_token = ?"
      ).bind(deviceToken).first();

      if (!device) return json({ visits: [] });

      const rows = await env.SITELOG_DB.prepare(`
        SELECT id, site_code, check_in_at, check_out_at,
               COALESCE(sign_in_confirmed,0) as sign_in_confirmed,
               COALESCE(sign_out_confirmed,0) as sign_out_confirmed,
               COALESCE(auto_checkout,0) as auto_checkout
        FROM visits
        WHERE person_id = ?
        ORDER BY check_in_at DESC
        LIMIT ?
      `).bind(device.person_id, limit).all();

      return json({ visits: rows.results || [] });
    }

    // GET /me — current profile for this device.
    // Lets the worker app keep its locally cached name/company in sync with
    // admin edits on every page load. Returns registered:false (not an error)
    // when the device has never registered, so the client can stay quiet.
    if (url.pathname === "/me" && request.method === "GET") {
      const deviceToken = url.searchParams.get("deviceToken");

      if (!deviceToken) return json({ ok: false, error: "Missing deviceToken" }, 400);

      const row = await env.SITELOG_DB.prepare(`
        SELECT p.id AS person_id, p.first_name, p.last_name, p.company, p.purpose,
               COALESCE(p.archived,0) AS archived,
               COALESCE(p.is_transfer_pending,0) AS is_transfer_pending
        FROM devices d
        JOIN people p ON p.id = d.person_id
        WHERE d.device_token = ?
        LIMIT 1
      `).bind(deviceToken).first();

      if (!row) return json({ ok: true, registered: false });

      return json({
        ok: true,
        registered: true,
        personId: row.person_id,
        firstName: row.first_name,
        lastName: row.last_name,
        company: row.company,
        purpose: row.purpose,
        archived: !!row.archived,
        isTransferPending: !!row.is_transfer_pending
      });
    }

    // GET /travel-time
    if (url.pathname === "/travel-time" && request.method === "GET") {
      const orig = parseLatLng(url.searchParams.get("orig") || "");
      const dest = parseLatLng(url.searchParams.get("dest") || "");

      if (!orig || !dest) {
        return json({
          ok: false,
          error: "Invalid orig/dest. Expected 'lat,lng' with valid ranges."
        }, 400);
      }

      const result = await getTravelData(env, orig.lat, orig.lng, dest.lat, dest.lng);

      if (!result) {
        return json({ ok: false, error: "Travel data unavailable" }, 502);
      }

      return json({
        ok: true,
        duration_text: result.duration_text,
        distance_text: result.distance_text,
        duration_mins: result.mins,
        distance_miles: result.miles
      });
    }

    // GET /geocode
    if (url.pathname === "/geocode" && request.method === "GET") {
      const address = (url.searchParams.get("address") || "").trim();

      if (!address) return json({ ok: false, error: "Missing address" }, 400);
      if (address.length > 200) return json({ ok: false, error: "Address too long" }, 400);

      const result = await getGeocode(env, address);

      if (!result) return json({ ok: false, error: "Geocode failed" }, 502);

      return json({
        ok: true,
        lat: result.lat,
        lng: result.lng,
        formatted: result.formatted
      });
    }

    // POST /log-failed-scan
    if (url.pathname === "/log-failed-scan" && request.method === "POST") {
      return json({ ok: true });
    }

    // GET /admin
    if (url.pathname === "/admin" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      if (from && !isValidDateKey(from)) {
        return json({ error: "Invalid 'from' date (expected YYYY-MM-DD)" }, 400);
      }

      if (to && !isValidDateKey(to)) {
        return json({ error: "Invalid 'to' date (expected YYYY-MM-DD)" }, 400);
      }

      let sql = `
        SELECT v.id AS visit_id, v.person_id, v.site_code, v.check_in_at, v.check_out_at,
               v.lat, v.lng, v.accuracy, v.hs_ack,
               COALESCE(v.auto_checkout,0) AS auto_checkout,
               COALESCE(v.sign_in_confirmed,0) AS sign_in_confirmed,
               COALESCE(v.sign_out_confirmed,0) AS sign_out_confirmed,
               v.travel_in_miles, v.travel_in_mins,
               v.travel_out_miles, v.travel_out_mins,
               v.transferred_to,
               COALESCE(v.is_first_of_day,0) AS is_first_of_day,
               COALESCE(v.offline_synced,0) AS offline_synced,
               COALESCE(v.unmatched_site,0) AS unmatched_site,
               COALESCE(v.manual_entry,0) AS manual_entry,
               COALESCE(p.is_main,0) AS is_main,
               v.provided_site_name,
               CASE
                 WHEN COALESCE(v.auto_checkout,0) = 1 THEN 'No Sign Out'
                 WHEN v.check_out_at IS NOT NULL AND COALESCE(v.sign_out_confirmed,0) = 0 THEN 'Soft Sign Out'
                 WHEN v.check_out_at IS NOT NULL THEN 'Signed Out'
                 WHEN COALESCE(v.sign_in_confirmed,0) = 0 THEN 'Soft Sign In'
                 ELSE 'Still Open'
               END AS sign_out_status,
               p.first_name, p.last_name, p.company, p.purpose, p.portal_username, d.device_token
        FROM visits v
        JOIN people p ON v.person_id = p.id
        LEFT JOIN devices d ON d.person_id = p.id
          AND d.rowid = (SELECT MIN(rowid) FROM devices WHERE person_id = p.id)
        WHERE COALESCE(p.archived,0) = 0
      `;

      const params = [];

      // Apply each bound independently so a one-sided range (just from, or just
      // to) is honoured rather than ignored — otherwise the caller silently
      // gets all-time data.
      if (from) {
        sql += " AND v.check_in_at >= ?";
        params.push(londonLocalToUtcIso(from, "00:00:00"));
      }
      if (to) {
        sql += " AND v.check_in_at <= ?";
        params.push(londonLocalToUtcIso(to, "23:59:59"));
      }

      // Cursor for backward pagination: callers needing the complete set (e.g.
      // job costing) page by passing the oldest check_in_at they've seen so far.
      // Kept inclusive (<=) and deduped client-side so no rows fall through a
      // page boundary even when timestamps tie.
      const before = url.searchParams.get("before");
      if (before) {
        sql += " AND v.check_in_at <= ?";
        params.push(before);
      }

      sql += " ORDER BY v.check_in_at DESC LIMIT 500";

      const stmt = env.SITELOG_DB.prepare(sql);
      const rows = params.length ? await stmt.bind(...params).all() : await stmt.all();

      return json({ visits: rows.results || [] });
    }

    // GET /job-costing?from=YYYY-MM-DD&to=YYYY-MM-DD
    // Server-side job costing for the portal's unified view. Returns the SAME
    // per-site / per-person labour figures as the SiteLog admin screen, computed
    // here (the portal can't run admin.html's client JS). Each person carries
    // their portal_username so the portal can tell employees (linked, deduped
    // against SLA time) from subcontractors (SiteLog is their only source).
    if (url.pathname === "/job-costing" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);

      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (from && !isValidDateKey(from)) return json({ ok: false, error: "Invalid 'from' date (expected YYYY-MM-DD)" }, 400);
      if (to && !isValidDateKey(to)) return json({ ok: false, error: "Invalid 'to' date (expected YYYY-MM-DD)" }, 400);

      // Engineers (rates + travel rules). Match a visit to its engineer by
      // person_id first, then name+company — same as admin.html findEngineer.
      const engRows = (await env.SITELOG_DB.prepare(`
        SELECT id, first_name, last_name, company,
               COALESCE(hourly_rate, NULL) as hourly_rate,
               COALESCE(travel_status,'not_configured') as travel_status,
               COALESCE(fuel_paid, CASE WHEN travel_status='paid' THEN 1 ELSE 0 END) as fuel_paid,
               COALESCE(travel_time_paid, CASE WHEN travel_status='paid' THEN 1 ELSE 0 END) as travel_time_paid,
               travel_cap_type, travel_cap_value, fuel_rate,
               COALESCE(is_main,0) as is_main, portal_username
        FROM people
      `).all()).results || [];
      const engById = new Map();
      engRows.forEach((e) => engById.set(String(e.id), e));
      const findEng = (personId, name, company) => {
        if (personId && engById.has(String(personId))) return engById.get(String(personId));
        return engRows.find((e) =>
          (((e.first_name || "").trim() + " " + (e.last_name || "").trim()).trim() === name) &&
          ((e.company || "") === (company || ""))) || null;
      };

      // Fetch every visit in range (paged back by check_in_at so nothing is
      // capped), deduped by visit_id. Mirrors the /admin SELECT columns.
      const SELECT = `
        SELECT v.id AS visit_id, v.person_id, v.site_code, v.check_in_at, v.check_out_at,
               COALESCE(v.auto_checkout,0) AS auto_checkout,
               v.travel_in_miles, v.travel_in_mins, v.travel_out_miles, v.travel_out_mins,
               v.transferred_to, COALESCE(v.is_first_of_day,0) AS is_first_of_day,
               p.first_name, p.last_name, p.company, p.portal_username
        FROM visits v
        JOIN people p ON v.person_id = p.id
        WHERE COALESCE(p.archived,0) = 0`;
      const baseParams = [];
      let where = "";
      if (from) { where += " AND v.check_in_at >= ?"; baseParams.push(londonLocalToUtcIso(from, "00:00:00")); }
      if (to) { where += " AND v.check_in_at <= ?"; baseParams.push(londonLocalToUtcIso(to, "23:59:59")); }

      const PAGE = 1000;
      const seen = new Set();
      const visits = [];
      let before = null;
      // Hard cap of 40 pages (40k visits) so a pathological range can't run away.
      for (let page = 0; page < 40; page++) {
        let sql = SELECT + where;
        const params = baseParams.slice();
        if (before) { sql += " AND v.check_in_at <= ?"; params.push(before); }
        sql += " ORDER BY v.check_in_at DESC LIMIT " + PAGE;
        const res = await env.SITELOG_DB.prepare(sql).bind(...params).all();
        const rows = res.results || [];
        if (!rows.length) break;
        let added = 0;
        for (const r of rows) {
          if (seen.has(r.visit_id)) continue;
          seen.add(r.visit_id);
          visits.push(r);
          added++;
        }
        if (rows.length < PAGE) break;
        before = rows[rows.length - 1].check_in_at;
        if (added === 0) break; // whole page was dupes at a tie boundary
      }

      // Authoritative London-day bound (handles UTC/London edges + one-sided).
      const inRange = visits.filter((v) => {
        const day = jcLondonDayKey(v.check_in_at);
        if (from && day < from) return false;
        if (to && day > to) return false;
        return true;
      });

      // Group by site_code → person_id, then cost each person.
      const sites = {};
      inRange.forEach((v) => {
        const siteKey = (v.site_code || "").trim() || "";
        const pKey = v.person_id || jcNameOf(v) || "Unknown";
        sites[siteKey] = sites[siteKey] || {};
        sites[siteKey][pKey] = sites[siteKey][pKey] ||
          { personId: v.person_id || "", name: jcNameOf(v) || "Unknown", company: v.company || "", portalUsername: v.portal_username || null, visits: [] };
        sites[siteKey][pKey].visits.push(v);
      });

      const out = Object.keys(sites).map((siteKey) => {
        const people = Object.keys(sites[siteKey]).map((pKey) => {
          const p = sites[siteKey][pKey];
          const eng = findEng(p.visits[0].person_id, p.name, p.company);
          const c = jcCostVisits(p.visits, eng);
          return {
            personId: p.personId,
            portalUsername: (eng && eng.portal_username) || p.portalUsername || null,
            name: p.name, company: p.company, engId: eng ? eng.id : "",
            rate: c.rate, hasRate: c.hasRate,
            workH: c.workH, travelH: c.travelH, miles: c.miles,
            labour: c.labour, travelCost: c.travelCost, fuelCost: c.fuelCost, total: c.total,
            costedVisits: c.costedVisits, openCount: c.openCount, autoCount: c.autoCount,
          };
        }).sort((a, b) => b.total - a.total);
        return {
          siteCode: siteKey,
          total: people.reduce((s, p) => s + p.total, 0),
          labour: people.reduce((s, p) => s + p.labour, 0),
          travelCost: people.reduce((s, p) => s + p.travelCost, 0),
          fuelCost: people.reduce((s, p) => s + p.fuelCost, 0),
          workH: people.reduce((s, p) => s + p.workH, 0),
          travelH: people.reduce((s, p) => s + p.travelH, 0),
          visits: people.reduce((s, p) => s + p.costedVisits, 0),
          open: people.reduce((s, p) => s + p.openCount, 0),
          auto: people.reduce((s, p) => s + p.autoCount, 0),
          noRate: people.some((p) => !p.hasRate && p.costedVisits > 0),
          people,
        };
      }).sort((a, b) => b.total - a.total);

      return json({ ok: true, from: from || null, to: to || null, sites: out });
    }

    // GET /on-site
    if (url.pathname === "/on-site" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      const site = url.searchParams.get("site") || "";

      const rows = await env.SITELOG_DB.prepare(`
        SELECT v.id as visit_id, v.person_id, p.first_name, p.last_name, p.company
        FROM visits v
        JOIN people p ON v.person_id = p.id
        WHERE v.site_code = ? AND v.check_out_at IS NULL AND COALESCE(p.archived,0) = 0
        ORDER BY p.first_name, p.last_name
      `).bind(site).all();

      const people = (rows.results || []).map((r) => ({
        person_id: r.person_id || "",
        name: `${r.first_name || ""} ${r.last_name || ""}`.trim(),
        company: r.company || ""
      }));

      return json({ people });
    }

    // POST /documents/create
    if (url.pathname === "/documents/create" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      const docId = crypto.randomUUID();
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      // Per-type running document number (HWP-0001, IND-0001, TBT-0001). MAX(seq)
      // rather than COUNT so deleting a document never reissues an old number.
      const type = body.type || "";
      const prefix = { induction: "IND", hwp: "HWP", tbt: "TBT" }[type] || "DOC";
      const maxRow = await env.SITELOG_DB.prepare("SELECT MAX(doc_seq) AS m FROM documents WHERE type = ?").bind(type).first();
      const docSeq = (maxRow && maxRow.m ? Number(maxRow.m) : 0) + 1;
      const docNumber = prefix + "-" + String(docSeq).padStart(4, "0");

      await env.SITELOG_DB.prepare(`
        INSERT INTO documents
          (id, type, template_version, status, site_name, site_address,
           issued_by, issued_at, permit_no, valid_from,
           manager_signature, manager_signed_at, form_data, created_at, doc_number, doc_seq)
        VALUES (?,?,1,'issued',?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        docId,
        body.type || "",
        body.site_name || "",
        body.site_address || "",
        body.issued_by || "",
        body.issued_at || now,
        body.permit_no || null,
        body.valid_from || null,
        body.manager_signature || null,
        body.manager_signature ? now : null,
        JSON.stringify(body.form_data || {}),
        now,
        docNumber,
        docSeq
      ).run();

      const attendees = Array.isArray(body.attendees) ? body.attendees : [];

      for (let i = 0; i < attendees.length; i++) {
        const a = attendees[i];

        await env.SITELOG_DB.prepare(`
          INSERT INTO document_attendees
            (id, document_id, person_id, person_name, company, sign_order,
             trade, contact_number, cscs_number, signature, signed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          crypto.randomUUID(),
          docId,
          a.personId || null,
          a.personName || "",
          a.company || "",
          i + 1,
          a.trade || null,
          a.contact || null,
          a.cscs || null,
          a.signature || null,
          a.signature ? now : null
        ).run();
      }

      return json({ ok: true, id: docId });
    }

    // POST /documents/closeout
    if (url.pathname === "/documents/closeout" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;

      const body = await readBody(request);
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      if (!body.docId) return json({ ok: false, error: "Missing docId" }, 400);

      await env.SITELOG_DB.prepare(`
        UPDATE documents
        SET status = 'closed',
            completion_time = ?,
            final_area_safe = ?,
            manager_signature = ?,
            manager_signed_at = ?,
            closed_at = ?
        WHERE id = ?
      `).bind(
        body.completionTime || null,
        body.finalAreaSafe ?? null,
        body.managerSignature || null,
        now,
        now,
        body.docId
      ).run();

      return json({ ok: true });
    }

    // GET /documents
    // GET /site-people — everyone signed into the site now OR previously, for the
    // document name dropdowns (currently-on-site listed first).
    if (url.pathname === "/site-people" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      const site = url.searchParams.get("site") || "";
      const rows = await env.SITELOG_DB.prepare(`
        SELECT p.id AS person_id, p.first_name, p.last_name, p.company,
               MAX(v.check_in_at) AS last_seen,
               MAX(CASE WHEN v.check_out_at IS NULL THEN 1 ELSE 0 END) AS on_now
        FROM visits v JOIN people p ON v.person_id = p.id
        WHERE v.site_code = ? AND COALESCE(p.archived,0) = 0
        GROUP BY p.id
        ORDER BY on_now DESC, last_seen DESC
      `).bind(site).all();
      const people = (rows.results || []).map(r => ({
        person_id: r.person_id || "",
        name: `${r.first_name || ""} ${r.last_name || ""}`.trim(),
        company: r.company || "",
        on_now: Number(r.on_now || 0) === 1
      })).filter(p => p.name);
      return json({ people });
    }

    // GET /my-documents — documents at a site that the calling device's person is
    // linked to (i.e. listed on the document). Powers the user app's Documents tab.
    if (url.pathname === "/my-documents" && request.method === "GET") {
      await ensureOfflineSchema(env);
      const deviceToken = url.searchParams.get("deviceToken") || "";
      const site = url.searchParams.get("site") || "";
      if (!deviceToken) return json({ documents: [] });
      const dev = await env.SITELOG_DB.prepare("SELECT person_id FROM devices WHERE device_token = ?").bind(deviceToken).first();
      if (!dev || !dev.person_id) return json({ documents: [] });
      // The person is linked via a signed attendee OR an extra link.
      const wheres = ["d.id IN (SELECT document_id FROM document_attendees WHERE person_id = ? UNION SELECT document_id FROM document_links WHERE person_id = ?)"];
      const binds = [dev.person_id, dev.person_id];
      if (site) { wheres.push("d.site_name = ?"); binds.push(site); }
      const rows = await env.SITELOG_DB.prepare(`
        SELECT d.id, d.type, d.status, d.site_name, d.issued_at, d.doc_number, d.permit_no
        FROM documents d
        WHERE ${wheres.join(" AND ")}
        ORDER BY d.issued_at DESC LIMIT 100
      `).bind(...binds).all();
      return json({ documents: rows.results || [] });
    }

    if (url.pathname === "/documents" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      const type = url.searchParams.get("type") || "";
      const status = url.searchParams.get("status") || "";
      const site = url.searchParams.get("site") || "";
      const person = url.searchParams.get("person") || "";
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";

      let q = `
        SELECT d.id, d.type, d.status, d.site_name, d.issued_at,
               d.permit_no, d.closed_at, d.form_data, d.doc_number,
               GROUP_CONCAT(da.person_name, ', ') AS attendee_names
        FROM documents d
        LEFT JOIN document_attendees da ON da.document_id = d.id
      `;

      const wheres = [];
      const binds = [];

      if (type) {
        wheres.push("d.type = ?");
        binds.push(type);
      }

      if (status) {
        wheres.push("d.status = ?");
        binds.push(status);
      }

      if (site) {
        wheres.push("d.site_name = ?");
        binds.push(site);
      }

      if (from) {
        wheres.push("d.issued_at >= ?");
        binds.push(from);
      }

      if (to) {
        wheres.push("d.issued_at <= ?");
        binds.push(to + " 23:59:59");
      }

      if (person) {
        wheres.push("da.person_name LIKE ?");
        binds.push("%" + person + "%");
      }

      if (wheres.length) q += " WHERE " + wheres.join(" AND ");

      q += " GROUP BY d.id ORDER BY d.issued_at DESC LIMIT 200";

      const rows = await env.SITELOG_DB.prepare(q).bind(...binds).all();

      return json({ documents: rows.results || [] });
    }

    // POST /documents/delete
    if (url.pathname === "/documents/delete" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      const body = await readBody(request);
      const id = body.id || body.docId;
      if (!id) return json({ ok: false, error: "Missing id" }, 400);
      await env.SITELOG_DB.prepare("DELETE FROM document_attendees WHERE document_id = ?").bind(id).run();
      await env.SITELOG_DB.prepare("DELETE FROM document_links WHERE document_id = ?").bind(id).run();
      await env.SITELOG_DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // POST /documents/link — link an extra person to an existing document so it
    // shows for them in the user app (separate from the signed attendees).
    if (url.pathname === "/documents/link" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      const docId = body.docId, personId = body.personId;
      if (!docId || !personId) return json({ ok: false, error: "Missing docId or personId" }, 400);
      const existing = await env.SITELOG_DB.prepare(
        "SELECT id FROM document_links WHERE document_id = ? AND person_id = ?"
      ).bind(docId, personId).first();
      const alreadyAttendee = await env.SITELOG_DB.prepare(
        "SELECT id FROM document_attendees WHERE document_id = ? AND person_id = ?"
      ).bind(docId, personId).first();
      if (!existing && !alreadyAttendee) {
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        await env.SITELOG_DB.prepare(
          "INSERT INTO document_links (id, document_id, person_id, person_name, linked_at) VALUES (?,?,?,?,?)"
        ).bind(crypto.randomUUID(), docId, personId, body.personName || "", now).run();
      }
      return json({ ok: true });
    }

    // POST /documents/unlink — remove an extra link (does not touch signed attendees)
    if (url.pathname === "/documents/unlink" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      if (!body.docId || !body.personId) return json({ ok: false, error: "Missing docId or personId" }, 400);
      await env.SITELOG_DB.prepare(
        "DELETE FROM document_links WHERE document_id = ? AND person_id = ?"
      ).bind(body.docId, body.personId).run();
      return json({ ok: true });
    }

    // GET /documents/single — admin, OR the engineer app (a device whose person
    // is named on / linked to the document). Anything else is rejected so the
    // attendee PII (contacts, CSCS numbers, signatures) isn't public.
    if (url.pathname === "/documents/single" && request.method === "GET") {
      const id = url.searchParams.get("id") || "";

      if (!isAdminAuthorised()) {
        const deviceToken = url.searchParams.get("deviceToken") || "";
        const dev = deviceToken
          ? await env.SITELOG_DB.prepare("SELECT person_id FROM devices WHERE device_token = ?").bind(deviceToken).first()
          : null;
        let allowed = false;
        if (dev && dev.person_id) {
          const onDoc = await env.SITELOG_DB.prepare(
            "SELECT 1 FROM document_attendees WHERE document_id = ? AND person_id = ? " +
            "UNION SELECT 1 FROM document_links WHERE document_id = ? AND person_id = ? LIMIT 1"
          ).bind(id, dev.person_id, id, dev.person_id).first();
          allowed = !!onDoc;
        }
        if (!allowed) return json({ error: "Unauthorised" }, 401);
      }

      const doc = await env.SITELOG_DB.prepare(
        "SELECT * FROM documents WHERE id = ?"
      ).bind(id).first();

      if (!doc) return json({ error: "Not found" }, 404);

      try {
        doc.form_data = JSON.parse(doc.form_data || "{}");
      } catch {
        doc.form_data = {};
      }

      const atts = await env.SITELOG_DB.prepare(
        "SELECT * FROM document_attendees WHERE document_id = ? ORDER BY sign_order"
      ).bind(id).all();

      doc.attendees = atts.results || [];
      doc.attendee_names = doc.attendees.map((a) => a.person_name).join(", ");

      let linked = [];
      try {
        const lr = await env.SITELOG_DB.prepare(
          "SELECT person_id, person_name FROM document_links WHERE document_id = ?"
        ).bind(id).all();
        linked = lr.results || [];
      } catch (e) {}
      doc.linked = linked;

      return json({ document: doc });
    }

    // POST /field-memory/save
    if (url.pathname === "/field-memory/save" && request.method === "POST") {
      const body = await readBody(request);

      const key = (body.key || "").trim();
      const value = (body.value || "").trim();
      const site = (body.site || "").trim();

      if (!key || !value) {
        return json({ ok: false, error: "key and value required" }, 400);
      }

      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      const existing = await env.SITELOG_DB.prepare(`
        SELECT id, use_count
        FROM field_memory
        WHERE field_key = ? AND COALESCE(site_name,'') = ? AND value = ?
        LIMIT 1
      `).bind(key, site, value).first();

      if (existing) {
        await env.SITELOG_DB.prepare(`
          UPDATE field_memory
          SET use_count = COALESCE(use_count,0) + 1,
              last_used_at = ?
          WHERE id = ?
        `).bind(now, existing.id).run();
      } else {
        await env.SITELOG_DB.prepare(`
          INSERT INTO field_memory
            (id, field_key, site_name, value, use_count, last_used_at)
          VALUES (?, ?, ?, ?, 1, ?)
        `).bind(
          crypto.randomUUID(),
          key,
          site || null,
          value,
          now
        ).run();
      }

      return json({ ok: true });
    }

    // GET /field-memory/suggest
    if (url.pathname === "/field-memory/suggest" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      const site = url.searchParams.get("site") || "";

      const rows = await env.SITELOG_DB.prepare(`
        SELECT value
        FROM field_memory
        WHERE field_key = ? AND (site_name = ? OR site_name IS NULL OR site_name = '')
        ORDER BY (site_name IS NOT NULL AND site_name != '') DESC,
                 use_count DESC,
                 last_used_at DESC
        LIMIT 6
      `).bind(key, site).all();

      const seen = new Set();

      const suggestions = (rows.results || [])
        .filter((r) => {
          if (seen.has(r.value)) return false;
          seen.add(r.value);
          return true;
        })
        .map((r) => ({ value: r.value }));

      return json({ suggestions });
    }

    // ───────────────────────── SITE DOCUMENTS ─────────────────────────
    // Per-site file library (drawings, RAMS/H&S, certs). Files are stored in R2
    // (env.DOCS_BUCKET); D1 holds metadata. Admin uploads/manages; engineers
    // signed in at the site (or with always-on access) view/download.

    // POST /site-documents/upload  (admin, multipart: site, category, title, requireAck, file)
    if (url.pathname === "/site-documents/upload" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      if (!env.DOCS_BUCKET) {
        return json({ ok: false, error: "File storage is not configured. Add an R2 bucket binding named DOCS_BUCKET to the worker." }, 500);
      }
      const form = await request.formData();
      const file = form.get("file");
      const site = (form.get("site") || "").toString().trim();
      const category = (form.get("category") || "Other").toString().trim() || "Other";
      const title = (form.get("title") || "").toString().trim();
      const requireAck = form.get("requireAck") && form.get("requireAck") !== "0" ? 1 : 0;
      const uploadedBy = (form.get("uploadedBy") || "Admin").toString();
      if (!site) return json({ ok: false, error: "Missing site" }, 400);
      if (!file || typeof file === "string") return json({ ok: false, error: "Missing file" }, 400);

      const id = crypto.randomUUID();
      const fileName = (file.name || "document").toString();
      const contentType = file.type || "application/octet-stream";
      const key = "site-docs/" + id + "/" + fileName;
      const buf = await file.arrayBuffer();
      await env.DOCS_BUCKET.put(key, buf, { httpMetadata: { contentType } });
      await env.SITELOG_DB.prepare(
        "INSERT INTO site_documents (id, site_name, category, title, file_name, content_type, size_bytes, r2_key, require_ack, uploaded_by, uploaded_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
      ).bind(id, site, category, title || fileName, fileName, contentType, buf.byteLength, key, requireAck, uploadedBy, toSqlUtc(Date.now())).run();
      return json({ ok: true, id });
    }

    // GET /site-documents/list?site=NAME  (admin) — docs for one site (active sites only)
    if (url.pathname === "/site-documents/list" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const site = url.searchParams.get("site") || "";
      const wheres = ["COALESCE(sd.archived,0) = 0"];
      const binds = [];
      if (site) { wheres.push("sd.site_name = ?"); binds.push(site); }
      const rows = await env.SITELOG_DB.prepare(`
        SELECT sd.id, sd.site_name, sd.category, sd.title, sd.file_name, sd.content_type,
               sd.size_bytes, sd.require_ack, sd.uploaded_by, sd.uploaded_at,
               (SELECT COUNT(*) FROM site_document_acks a WHERE a.document_id = sd.id) AS ack_count
        FROM site_documents sd
        JOIN sites s ON s.site_name = sd.site_name AND COALESCE(s.archived,0) = 0
        WHERE ${wheres.join(" AND ")}
        ORDER BY sd.category ASC, sd.uploaded_at DESC
      `).bind(...binds).all();
      return json({ ok: true, documents: rows.results || [] });
    }

    // GET /site-documents/summary  (admin) — doc counts per active site, for the picker
    if (url.pathname === "/site-documents/summary" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const rows = await env.SITELOG_DB.prepare(`
        SELECT sd.site_name AS site_name, COUNT(*) AS count
        FROM site_documents sd
        JOIN sites s ON s.site_name = sd.site_name AND COALESCE(s.archived,0) = 0
        WHERE COALESCE(sd.archived,0) = 0
        GROUP BY sd.site_name
      `).all();
      return json({ ok: true, sites: rows.results || [] });
    }

    // POST /site-documents/update  (admin) — rename / recategorise / toggle ack
    if (url.pathname === "/site-documents/update" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      const id = body.id;
      if (!id) return json({ ok: false, error: "Missing id" }, 400);
      const sets = [], binds = [];
      if (body.title != null) { sets.push("title = ?"); binds.push(String(body.title)); }
      if (body.category != null) { sets.push("category = ?"); binds.push(String(body.category)); }
      if (body.requireAck !== undefined) { sets.push("require_ack = ?"); binds.push(body.requireAck && body.requireAck !== "0" ? 1 : 0); }
      if (!sets.length) return json({ ok: true });
      binds.push(id);
      await env.SITELOG_DB.prepare(`UPDATE site_documents SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
      return json({ ok: true });
    }

    // POST /site-documents/delete  (admin) — remove the file from R2 and the row
    if (url.pathname === "/site-documents/delete" && request.method === "POST") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      const id = body.id;
      if (!id) return json({ ok: false, error: "Missing id" }, 400);
      const row = await env.SITELOG_DB.prepare("SELECT r2_key FROM site_documents WHERE id = ?").bind(id).first();
      if (row && row.r2_key && env.DOCS_BUCKET) { try { await env.DOCS_BUCKET.delete(row.r2_key); } catch (e) {} }
      await env.SITELOG_DB.prepare("DELETE FROM site_document_acks WHERE document_id = ?").bind(id).run();
      await env.SITELOG_DB.prepare("DELETE FROM site_documents WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // GET /site-documents/acks?id=DOC  (admin) — who has acknowledged a document
    if (url.pathname === "/site-documents/acks" && request.method === "GET") {
      const guard = requireAdmin();
      if (guard) return guard;
      await ensureOfflineSchema(env);
      const id = url.searchParams.get("id") || "";
      const rows = await env.SITELOG_DB.prepare(
        "SELECT person_name, company, acked_at FROM site_document_acks WHERE document_id = ? ORDER BY acked_at DESC"
      ).bind(id).all();
      return json({ ok: true, acks: rows.results || [] });
    }

    // GET /site-documents/my?site=NAME&deviceToken=...  (engineer) — docs the caller may see
    if (url.pathname === "/site-documents/my" && request.method === "GET") {
      await ensureOfflineSchema(env);
      const deviceToken = url.searchParams.get("deviceToken") || "";
      const site = url.searchParams.get("site") || "";
      if (!deviceToken || !site) return json({ documents: [] });
      const dev = await env.SITELOG_DB.prepare("SELECT person_id FROM devices WHERE device_token = ?").bind(deviceToken).first();
      if (!dev || !dev.person_id) return json({ documents: [] });
      if (!(await canViewSiteDocs(env, dev.person_id, site))) return json({ documents: [] });
      const rows = await env.SITELOG_DB.prepare(`
        SELECT sd.id, sd.category, sd.title, sd.file_name, sd.content_type, sd.size_bytes,
               sd.require_ack, sd.uploaded_at,
               (SELECT COUNT(*) FROM site_document_acks a WHERE a.document_id = sd.id AND a.person_id = ?) AS acked
        FROM site_documents sd
        JOIN sites s ON s.site_name = sd.site_name AND COALESCE(s.archived,0) = 0
        WHERE sd.site_name = ? AND COALESCE(sd.archived,0) = 0
        ORDER BY sd.category ASC, sd.uploaded_at DESC
      `).bind(dev.person_id, site).all();
      return json({ documents: rows.results || [] });
    }

    // POST /site-documents/ack  (engineer) — record "read & understood"
    if (url.pathname === "/site-documents/ack" && request.method === "POST") {
      await ensureOfflineSchema(env);
      const body = await readBody(request);
      const deviceToken = (body.deviceToken || "").toString();
      const id = (body.id || "").toString();
      if (!deviceToken || !id) return json({ ok: false, error: "Missing fields" }, 400);
      const dev = await env.SITELOG_DB.prepare("SELECT person_id FROM devices WHERE device_token = ?").bind(deviceToken).first();
      if (!dev || !dev.person_id) return json({ ok: false, error: "Unknown device" }, 401);
      const doc = await env.SITELOG_DB.prepare("SELECT site_name FROM site_documents WHERE id = ?").bind(id).first();
      if (!doc) return json({ ok: false, error: "Document not found" }, 404);
      if (!(await canViewSiteDocs(env, dev.person_id, doc.site_name))) return json({ ok: false, error: "Not permitted" }, 403);
      const person = await env.SITELOG_DB.prepare("SELECT first_name, last_name, company FROM people WHERE id = ?").bind(dev.person_id).first();
      const name = person ? `${person.first_name || ""} ${person.last_name || ""}`.trim() : "";
      const existing = await env.SITELOG_DB.prepare(
        "SELECT id FROM site_document_acks WHERE document_id = ? AND person_id = ?"
      ).bind(id, dev.person_id).first();
      if (!existing) {
        await env.SITELOG_DB.prepare(
          "INSERT INTO site_document_acks (id, document_id, person_id, person_name, company, acked_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), id, dev.person_id, name, person ? (person.company || "") : "", toSqlUtc(Date.now())).run();
      }
      return json({ ok: true });
    }

    // GET /site-documents/file?id=DOC[&download=1][&deviceToken=...]  — stream the file
    // Auth: admin (x-admin-secret header) OR an engineer permitted for the site.
    if (url.pathname === "/site-documents/file" && request.method === "GET") {
      await ensureOfflineSchema(env);
      const id = url.searchParams.get("id") || "";
      const download = url.searchParams.get("download") === "1";
      if (!id) return new Response("Missing id", { status: 400, headers: corsFor(request) });
      const doc = await env.SITELOG_DB.prepare("SELECT * FROM site_documents WHERE id = ?").bind(id).first();
      if (!doc) return new Response("Not found", { status: 404, headers: corsFor(request) });

      let ok = isAdminAuthorised();
      if (!ok) {
        const deviceToken = url.searchParams.get("deviceToken") || "";
        if (deviceToken) {
          const dev = await env.SITELOG_DB.prepare("SELECT person_id FROM devices WHERE device_token = ?").bind(deviceToken).first();
          if (dev && dev.person_id) ok = await canViewSiteDocs(env, dev.person_id, doc.site_name);
        }
      }
      if (!ok) return new Response("Unauthorised", { status: 401, headers: corsFor(request) });
      if (!env.DOCS_BUCKET) return new Response("Storage not configured", { status: 500, headers: corsFor(request) });

      const obj = await env.DOCS_BUCKET.get(doc.r2_key);
      if (!obj) return new Response("File missing", { status: 404, headers: corsFor(request) });
      const headers = corsFor(request);
      headers["Content-Type"] = doc.content_type || "application/octet-stream";
      const safeName = (doc.file_name || "document").replace(/["\\\r\n]/g, "");
      headers["Content-Disposition"] = (download ? "attachment" : "inline") + '; filename="' + safeName + '"';
      headers["Access-Control-Expose-Headers"] = "Content-Disposition";
      headers["Cache-Control"] = "private, max-age=60";
      return new Response(obj.body, { headers });
    }

    return new Response("Not found", { status: 404, headers: corsFor(request) });
}

// Daily auto-close of open visits (was the standalone worker's scheduled cron).
// Called from mostlane-api's scheduled(); idempotent (only closes prior-day open
// visits), so it's safe even while the old worker's cron still runs.
export async function sweepAutoClose(env) {
      const now = londonNowParts();

      const openVisits = await env.SITELOG_DB.prepare(
        "SELECT id, check_in_at FROM visits WHERE check_out_at IS NULL"
      ).all();

      for (const v of openVisits.results || []) {
        const visitDateKey = londonDateKeyFromUtcString(v.check_in_at);

        if (visitDateKey < now.dateKey) {
          // Day shift -> 16:00 cutoff; evening/overnight check-in -> 12h cap,
          // clamped to now (see forcedCheckoutSql). MAX(check_in_at, ...) below
          // additionally guards against negative durations.
          const forcedCheckoutUtc = forcedCheckoutSql(v.check_in_at, visitDateKey, Date.now());

          await env.SITELOG_DB.prepare(`
            UPDATE visits
            SET check_out_at = MAX(check_in_at, ?), auto_checkout = 1
            WHERE id = ? AND check_out_at IS NULL
          `).bind(forcedCheckoutUtc, v.id).run();
        }
      }
}
