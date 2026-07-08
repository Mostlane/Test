// Sites + Customers — replaces the `mostlane-sites` Worker, on D1.
//
// Faithful port of the old API (so sites.html / admin-timesheets.html work
// unchanged once portal-config routes the host here):
//   GET  /get-sites?category=all|<client>     -> bare array of site objects
//   POST /add-site?category=<client>          -> { success:true }
//   POST /update-site?category=&oldSiteNumber -> { success:true }
//   GET  /next-project-job-number             -> { next }
//   POST /upload-image  (FormData: siteNumber, client, file) -> { success, url }
//
// New customer layer (Workever parity: customers own sites, invoices later):
//   GET  /customers                -> { customers:[{...siteCount}] }
//   POST /customers                -> upsert  { id?, name, contactName, email, phone, invoiceEmail, billingAddress, notes }
//   POST /customers/delete         -> { username } style: { id }
//   POST /import-sites             -> one-time pull from the old worker into D1

import { json, error } from "../lib/http.js";

const OLD_SITES_WORKER = "https://mostlane-sites.jamie-def.workers.dev";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const q = url.searchParams;

  /* ── Sites (old API, ported) ─────────────────────────────────────────── */

  if (path === "/get-sites" && method === "GET") {
    const cat = (q.get("category") || "all").toLowerCase();
    let rows;
    if (cat === "all") {
      ({ results: rows } = await env.DB.prepare("SELECT data FROM sites ORDER BY client, site_number").all());
    } else {
      ({ results: rows } = await env.DB.prepare("SELECT data FROM sites WHERE client=? ORDER BY site_number").bind(cat).all());
    }
    return json((rows || []).map(r => JSON.parse(r.data)), {}, env, request);
  }

  if ((path === "/add-site" || path === "/update-site") && method === "POST") {
    const site = await request.json().catch(() => ({}));
    const client = ((q.get("category") || site.client || "") + "").toLowerCase().trim();
    const siteNumber = String(site.siteNumber || "").trim();
    if (!client || !siteNumber) return error("client (category) and siteNumber required", 400, env, request);
    site.client = client;

    // Renamed site number: drop the old row.
    const oldNum = q.get("oldSiteNumber");
    if (path === "/update-site" && oldNum && oldNum !== siteNumber) {
      await env.DB.prepare("DELETE FROM sites WHERE client=? AND site_number=?").bind(client, oldNum).run();
    }

    // Projects get an auto job number if they don't have one.
    if (path === "/add-site" && client === "projects" && !site.jobNumber) {
      site.jobNumber = await nextProjectNumber(env);
    }

    await saveSite(env, site);
    await ensureCustomer(env, client);
    return json({ success: true, site }, {}, env, request);
  }

  if (path === "/next-project-job-number" && method === "GET") {
    return json({ next: await nextProjectNumber(env) }, {}, env, request);
  }

  if (path === "/upload-image" && method === "POST") {
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    const siteNumber = form && String(form.get("siteNumber") || "").trim();
    const client = form ? String(form.get("client") || "retail").toLowerCase() : "retail";
    if (!file || !siteNumber) return json({ success: false, error: "Missing file or siteNumber" }, { status: 400 }, env, request);
    const safeName = (file.name || "site.jpg").replace(/[^\w.\-]+/g, "_");
    const key = `sites/${client}/${siteNumber}/${Date.now()}-${safeName}`;
    await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
    const base = (env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
    return json({ success: true, url: `${base}/${key}` }, { status: 201 }, env, request);
  }

  /* ── Customers (new) ─────────────────────────────────────────────────── */

  if (path === "/customers" && method === "GET") {
    const { results } = await env.DB.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM sites s WHERE s.client = c.id) AS site_count
      FROM customers c ORDER BY c.name COLLATE NOCASE
    `).all();
    return json({ customers: results || [] }, {}, env, request);
  }

  if (path === "/customers" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = slug(b.id || b.name);
    if (!id) return error("name required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO customers (id, name, contact_name, email, phone, invoice_email, billing_address, notes, updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, contact_name=excluded.contact_name, email=excluded.email,
        phone=excluded.phone, invoice_email=excluded.invoice_email,
        billing_address=excluded.billing_address, notes=excluded.notes, updated_at=datetime('now')
    `).bind(id, b.name || id, b.contactName || null, b.email || null, b.phone || null,
            b.invoiceEmail || null, b.billingAddress || null, b.notes || null).run();
    return json({ ok: true, id }, {}, env, request);
  }

  if (path === "/customers/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("id required", 400, env, request);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE client=?").bind(b.id).first();
    if (n && n.n > 0) return error(`Customer has ${n.n} site(s) — move or delete them first.`, 400, env, request);
    await env.DB.prepare("DELETE FROM customers WHERE id=?").bind(b.id).run();
    return json({ ok: true }, {}, env, request);
  }

  /* ── Bulk site images from Google Street View ────────────────────────────
     Fetches each site's Street View photo ONCE, stores it in R2, and points
     site.imageURL at our own copy (no per-view Google billing, no key in the
     stored URL). Batched — the caller loops until remaining === 0. */
  if (path === "/sites/street-images" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const key = b.key || env.GOOGLE_MAPS_KEY;
    if (!key) return error("Google Maps API key required", 400, env, request);
    const overwrite = !!b.overwrite;
    const since = b.since || "";                       // run marker for overwrite mode
    const limit = Math.min(Number(b.limit) || 15, 25); // stay under subrequest caps
    const size = b.size || "640x400";

    const { results } = await env.DB.prepare("SELECT data FROM sites").all();
    const all = (results || []).map(r => JSON.parse(r.data));
    const locOf = s => (s.lat != null && s.lon != null)
      ? `${s.lat},${s.lon}`
      : [s.address1 || s.street || s.siteName, s.town, (s.postcode || "").replace(/\*+$/, "")].filter(Boolean).join(", ");
    const todo = all.filter(s =>
      !s._noStreetView &&
      (overwrite ? (!s._svAt || s._svAt < since) : !s.imageURL) &&
      locOf(s));

    const batch = todo.slice(0, limit);
    let updated = 0; const failed = [];
    const now = new Date().toISOString();
    for (const site of batch) {
      try {
        const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${encodeURIComponent(locOf(site))}&fov=80&return_error_code=true&key=${key}`;
        const res = await fetch(svUrl);
        if (!res.ok) throw new Error("no imagery / key rejected: " + res.status);
        const buf = await res.arrayBuffer();
        const r2key = `sites/${site.client}/${String(site.siteNumber).trim()}/streetview.jpg`;
        await env.JOB_FILES.put(r2key, buf, { httpMetadata: { contentType: "image/jpeg" } });
        site.imageURL = `${(env.R2_PUBLIC_BASE || "").replace(/\/$/, "")}/${r2key}`;
        site._svAt = now;
        await saveSite(env, site);
        updated++;
      } catch (e) {
        site._noStreetView = true;   // don't retry a site with no imagery every run
        site._svAt = now;
        await saveSite(env, site);
        failed.push(String(site.siteNumber));
      }
    }
    return json({
      ok: true, updated, failed,
      remaining: Math.max(0, todo.length - batch.length)
    }, {}, env, request);
  }

  /* ── One-time migration from the old worker ──────────────────────────── */

  if (path === "/import-sites" && method === "POST") {
    // Preferred: the browser fetches the old worker and sends the list here
    // (Cloudflare blocks worker→worker fetches on *.workers.dev — error 1042).
    const body = await request.json().catch(() => ({}));
    let list = Array.isArray(body.sites) ? body.sites : [];
    if (!list.length) {
      try {
        const res = await fetch(`${OLD_SITES_WORKER}/get-sites?category=all`);
        list = await res.json();
        if (!Array.isArray(list)) throw new Error("old worker did not return a list");
      } catch (e) {
        return error("Could not read the old sites worker: " + e.message, 502, env, request);
      }
    }
    let imported = 0;
    const clients = new Set();
    for (const site of list) {
      const client = ((site.client || "") + "").toLowerCase().trim() || "retail";
      const siteNumber = String(site.siteNumber || "").trim();
      if (!siteNumber) continue;
      site.client = client;
      await saveSite(env, site);
      clients.add(client);
      imported++;
    }
    for (const c of clients) await ensureCustomer(env, c);
    return json({ ok: true, imported, customers: [...clients] }, {}, env, request);
  }

  return error("Unknown sites route", 404, env, request);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function saveSite(env, site) {
  await env.DB.prepare(`
    INSERT INTO sites (client, site_number, site_name, postcode, active, job_number, data, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(client, site_number) DO UPDATE SET
      site_name=excluded.site_name, postcode=excluded.postcode, active=excluded.active,
      job_number=excluded.job_number, data=excluded.data, updated_at=datetime('now')
  `).bind(
    site.client, String(site.siteNumber).trim(), site.siteName || null, site.postcode || null,
    site.active === false ? 0 : 1, site.jobNumber || null, JSON.stringify(site)
  ).run();
}

async function ensureCustomer(env, id) {
  if (!id) return;
  await env.DB.prepare(
    "INSERT INTO customers (id, name) VALUES (?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(id, prettify(id)).run();
}

async function nextProjectNumber(env) {
  const { results } = await env.DB.prepare(
    "SELECT job_number FROM sites WHERE client='projects' AND job_number IS NOT NULL"
  ).all();
  let max = 0;
  for (const r of results || []) {
    const m = String(r.job_number).match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "P" + String(max + 1).padStart(4, "0");
}

function slug(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function prettify(id) {
  return String(id).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
