/* =========================================================
   Coal Park Lane — booking backend
   ---------------------------------------------------------
   A small, standalone Cloudflare Worker + D1. It:
     • receives enquiries from the website and stores them
     • serves a password-protected admin API (admin.html)
   No payment handling — that's Phase 2. The data model is
   already payment-ready (status, amount, paid columns).
   ========================================================= */

const enc = (s) => new TextEncoder().encode(s);

/* ---------- tiny helpers ---------- */
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
function corsHeaders(env, request) {
  const allow = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  // Echo the request origin when it matches the allow-list (so credentials-free
  // POSTs from the site work); otherwise fall back to the configured value.
  const acao =
    allow === "*" ? "*" : (origin && origin === allow ? origin : allow);
  return {
    "Access-Control-Allow-Origin": acao,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "b" + Date.now() + Math.random().toString(16).slice(2));
const now = () => new Date().toISOString();
const clean = (v, max = 2000) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

/* ---------- schema (self-migrating, so a fresh DB just works) ---------- */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS bookings (" +
      "id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT, " +
      "source TEXT NOT NULL DEFAULT 'enquiry', status TEXT NOT NULL DEFAULT 'new', " +
      "name TEXT, email TEXT, phone TEXT, booking_date TEXT, booking_time TEXT, " +
      "duration_mins INTEGER, pitch TEXT, use_for TEXT, message TEXT, admin_notes TEXT, " +
      "amount REAL, paid INTEGER NOT NULL DEFAULT 0)"
  );
  schemaReady = true;
}

/* ---------- admin token (HMAC-signed, expiring) ---------- */
function signingSecret(env) {
  return env.ADMIN_SECRET || env.ADMIN_PASSWORD || "";
}
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makeToken(env) {
  const exp = Date.now() + 1000 * 60 * 60 * 12; // 12 hours
  const payload = String(exp);
  return payload + "." + (await hmac(payload, signingSecret(env)));
}
async function validToken(token, env) {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const good = await hmac(payload, signingSecret(env));
  if (sig.length !== good.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ good.charCodeAt(i);
  if (diff !== 0) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}
async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return validToken(token, env);
}

/* ---------- optional email notification (Resend) ---------- */
async function notifyEnquiry(env, b, ctx) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  const lines = [
    "New booking enquiry — Coal Park Lane",
    "----------------------------------------",
    `Name:    ${b.name || "-"}`,
    `Email:   ${b.email || "-"}`,
    `Phone:   ${b.phone || "-"}`,
    `Date:    ${b.booking_date || "-"}${b.booking_time ? " at " + b.booking_time : ""}`,
    `Space:   ${b.pitch || "-"}`,
    `For:     ${b.use_for || "-"}`,
    `Message: ${b.message || "-"}`,
    "",
    "See it in the admin: open admin.html",
  ].join("\n");
  const send = fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "bookings@coalparklane.co.uk",
      to: [env.NOTIFY_EMAIL],
      reply_to: b.email || undefined,
      subject: `New enquiry — ${b.name || "website"} — ${b.booking_date || ""}`.trim(),
      text: lines,
    }),
  }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
  else await send;
}

/* ---------- row shaping ---------- */
function shape(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    source: r.source,
    status: r.status,
    name: r.name,
    email: r.email,
    phone: r.phone,
    date: r.booking_date,
    time: r.booking_time,
    durationMins: r.duration_mins,
    pitch: r.pitch,
    use: r.use_for,
    message: r.message,
    adminNotes: r.admin_notes,
    amount: r.amount,
    paid: !!r.paid,
  };
}

const STATUSES = ["new", "contacted", "confirmed", "declined", "cancelled"];

/* ========================================================= */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      await ensureSchema(env);

      /* ---- health ---- */
      if (path === "/" || path === "/health") {
        return json({ ok: true, service: "coalparklane-api" }, 200, cors);
      }

      /* ---- public: submit an enquiry ---- */
      if (path === "/enquiry" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = clean(body.name, 120);
        const email = clean(body.email, 200);
        if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json({ error: "A name and valid email are required." }, 400, cors);
        }
        const row = {
          id: uid(),
          created_at: now(),
          source: "enquiry",
          status: "new",
          name,
          email,
          phone: clean(body.phone, 60),
          booking_date: clean(body.date, 20),
          booking_time: clean(body.time, 10),
          pitch: clean(body.pitch, 80),
          use_for: clean(body.use, 120),
          message: clean(body.message, 4000),
        };
        await env.DB.prepare(
          "INSERT INTO bookings (id,created_at,source,status,name,email,phone,booking_date,booking_time,pitch,use_for,message) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
        )
          .bind(
            row.id, row.created_at, row.source, row.status, row.name, row.email,
            row.phone, row.booking_date, row.booking_time, row.pitch, row.use_for, row.message
          )
          .run();
        await notifyEnquiry(env, row, ctx);
        return json({ ok: true, id: row.id }, 200, cors);
      }

      /* ---- admin: login ---- */
      if (path === "/admin/login" && request.method === "POST") {
        if (!env.ADMIN_PASSWORD) {
          return json({ error: "Admin password is not set up yet." }, 503, cors);
        }
        const body = await request.json().catch(() => ({}));
        const pw = String(body.password || "");
        // constant-time-ish compare
        const a = enc(pw), b = enc(env.ADMIN_PASSWORD);
        let ok = a.length === b.length;
        for (let i = 0; i < Math.max(a.length, b.length); i++) ok = ok && a[i] === b[i];
        if (!ok) return json({ error: "Wrong password." }, 401, cors);
        return json({ token: await makeToken(env) }, 200, cors);
      }

      /* ---- everything else under /admin needs a valid token ---- */
      if (path.startsWith("/admin")) {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "Not authorised." }, 401, cors);
        }

        /* list / filter */
        if (path === "/admin/bookings" && request.method === "GET") {
          const status = url.searchParams.get("status");
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          const where = [];
          const args = [];
          if (status && STATUSES.includes(status)) { where.push("status = ?"); args.push(status); }
          if (from) { where.push("booking_date >= ?"); args.push(from); }
          if (to) { where.push("booking_date <= ?"); args.push(to); }
          const sql =
            "SELECT * FROM bookings" +
            (where.length ? " WHERE " + where.join(" AND ") : "") +
            " ORDER BY (booking_date IS NULL), booking_date ASC, created_at DESC LIMIT 1000";
          const rs = await env.DB.prepare(sql).bind(...args).all();
          return json({ bookings: (rs.results || []).map(shape) }, 200, cors);
        }

        /* calendar feed: things actually taking up the ground */
        if (path === "/admin/calendar" && request.method === "GET") {
          const from = url.searchParams.get("from") || "0000-00-00";
          const to = url.searchParams.get("to") || "9999-99-99";
          const rs = await env.DB.prepare(
            "SELECT * FROM bookings WHERE booking_date IS NOT NULL AND booking_date >= ? AND booking_date <= ? " +
              "AND (status IN ('confirmed','contacted') OR source='manual') " +
              "ORDER BY booking_date ASC, booking_time ASC"
          ).bind(from, to).all();
          return json({ bookings: (rs.results || []).map(shape) }, 200, cors);
        }

        /* create a manual booking (e.g. a regular club slot) */
        if (path === "/admin/bookings" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const id = uid();
          const status = STATUSES.includes(body.status) ? body.status : "confirmed";
          await env.DB.prepare(
            "INSERT INTO bookings (id,created_at,source,status,name,email,phone,booking_date,booking_time,duration_mins,pitch,use_for,message,admin_notes) " +
              "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
          )
            .bind(
              id, now(), "manual", status,
              clean(body.name, 120), clean(body.email, 200), clean(body.phone, 60),
              clean(body.date, 20), clean(body.time, 10),
              body.durationMins != null ? Number(body.durationMins) || null : null,
              clean(body.pitch, 80), clean(body.use, 120), clean(body.message, 4000),
              clean(body.adminNotes, 4000)
            )
            .run();
          const rs = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
          return json({ booking: shape(rs) }, 200, cors);
        }

        /* update / delete a single booking */
        const m = path.match(/^\/admin\/bookings\/([A-Za-z0-9._-]+)$/);
        if (m) {
          const id = m[1];
          if (request.method === "DELETE") {
            await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
            return json({ ok: true }, 200, cors);
          }
          if (request.method === "PATCH") {
            const body = await request.json().catch(() => ({}));
            const sets = [];
            const args = [];
            const put = (col, val) => { sets.push(col + " = ?"); args.push(val); };
            if (body.status !== undefined) {
              if (!STATUSES.includes(body.status)) return json({ error: "Bad status." }, 400, cors);
              put("status", body.status);
            }
            if (body.adminNotes !== undefined) put("admin_notes", clean(body.adminNotes, 4000));
            if (body.name !== undefined) put("name", clean(body.name, 120));
            if (body.email !== undefined) put("email", clean(body.email, 200));
            if (body.phone !== undefined) put("phone", clean(body.phone, 60));
            if (body.date !== undefined) put("booking_date", clean(body.date, 20));
            if (body.time !== undefined) put("booking_time", clean(body.time, 10));
            if (body.durationMins !== undefined) put("duration_mins", body.durationMins == null ? null : Number(body.durationMins) || null);
            if (body.pitch !== undefined) put("pitch", clean(body.pitch, 80));
            if (body.use !== undefined) put("use_for", clean(body.use, 120));
            if (body.message !== undefined) put("message", clean(body.message, 4000));
            if (!sets.length) return json({ error: "Nothing to update." }, 400, cors);
            put("updated_at", now());
            args.push(id);
            await env.DB.prepare("UPDATE bookings SET " + sets.join(", ") + " WHERE id = ?").bind(...args).run();
            const rs = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
            if (!rs) return json({ error: "Not found." }, 404, cors);
            return json({ booking: shape(rs) }, 200, cors);
          }
        }

        return json({ error: "Unknown admin route." }, 404, cors);
      }

      return json({ error: "Not found." }, 404, cors);
    } catch (err) {
      return json({ error: "Server error", detail: String(err && err.message || err) }, 500, cors);
    }
  },
};
