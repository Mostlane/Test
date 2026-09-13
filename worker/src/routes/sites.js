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
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor } from "../lib/auth.js";
import * as sitelogApi from "./sitelog-api.js";

const OLD_SITES_WORKER = "https://mostlane-sites.jamie-def.workers.dev";

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method;
  const q = url.searchParams;
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);

  /* ── Sites (old API, ported) ─────────────────────────────────────────── */

  if (path === "/get-sites" && method === "GET") {
    const cat = (q.get("category") || "all").toLowerCase();
    let rows;
    if (cat === "all") {
      ({ results: rows } = await db.prepare("SELECT data FROM sites WHERE tenant_id=? ORDER BY client, site_number").bind(db.tenantId).all());
    } else {
      ({ results: rows } = await db.prepare("SELECT data FROM sites WHERE tenant_id=? AND client=? ORDER BY site_number").bind(db.tenantId, cat).all());
    }
    return json((rows || []).map(r => JSON.parse(r.data)), {}, env, request);
  }

  // Delete a site outright (Full Access only — destructive). Removes the row
  // from the register; historical jobs/costing/compliance keyed by number/name
  // are independent and untouched. Body { siteNumber, client } (client also
  // accepted via ?category=). For an Inactive/temporary hide, use the Active
  // toggle instead — this is a permanent removal.
  if (path === "/delete-site" && method === "POST") {
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, tenantId, sess.user.username);
    if (perms.FullAccess !== "Yes")
      return error("Deleting a site needs Full Access", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const client = ((q.get("category") || b.client || "") + "").toLowerCase().trim();
    const siteNumber = String(b.siteNumber || "").trim();
    if (!client || !siteNumber) return error("client (category) and siteNumber required", 400, env, request);
    const existing = await db.prepare("SELECT data FROM sites WHERE tenant_id=? AND client=? AND site_number=?")
      .bind(db.tenantId, client, siteNumber).first();
    if (!existing) return error("Site not found", 404, env, request);
    let name = siteNumber;
    try { name = JSON.parse(existing.data).siteName || siteNumber; } catch {}
    await db.prepare("DELETE FROM sites WHERE tenant_id=? AND client=? AND site_number=?")
      .bind(db.tenantId, client, siteNumber).run();
    // Retire the SiteLog geofence (archive rather than hard-delete so any
    // in-flight scan lands on a valid row before the reconcilers close them).
    ctx?.waitUntil(removeSiteFromSiteLog(env, name, { archive: true }));
    // Human before→after note for the activity log.
    const res = json({ success: true, deleted: siteNumber }, {}, env, request);
    try { res.headers.set("X-Audit-Note", encodeURIComponent(`Deleted site ${siteNumber} — "${name}"`)); } catch {}
    return res;
  }

  if ((path === "/add-site" || path === "/update-site") && method === "POST") {
    let site = await request.json().catch(() => ({}));
    const client = ((q.get("category") || site.client || "") + "").toLowerCase().trim();
    if (!client) return error("client (category) required", 400, env, request);
    site.client = client;

    // Projects auto-number: the project number (P0001…) doubles as the site
    // number, so a project can be added without typing one. Do this BEFORE the
    // required-number check so projects are exempt from it.
    if (path === "/add-site" && client === "projects") {
      if (!site.jobNumber) site.jobNumber = await nextProjectNumber(env, tenantId);
      if (!String(site.siteNumber || "").trim()) site.siteNumber = site.jobNumber;
    }
    // Generic "site" category (office / yard / one-off): auto-assign an S-number
    // so it never needs one typed — same idea as projects, no job-number machinery.
    if (path === "/add-site" && client === "site" && !String(site.siteNumber || "").trim()) {
      site.siteNumber = await nextSiteNumber(env, tenantId);
    }

    const siteNumber = String(site.siteNumber || "").trim();
    if (!siteNumber) return error("siteNumber required", 400, env, request);
    site.siteNumber = siteNumber;

    // Renamed site number: drop the old row.
    const oldNum = q.get("oldSiteNumber");

    // Guard against duplicate / reserved site numbers. A collision — e.g. a
    // generic "site" (office/yard) typed with a project's P-number — makes jobs
    // booked there cross-link into that project (an office-meet job showed under
    // a live project this way). P#### is reserved for projects; every site
    // number must be unique. Checked when a number is being SET or CHANGED.
    if (client !== "projects" && /^p\d/i.test(siteNumber))
      return error(`"${siteNumber}" uses the project number format (P####), reserved for projects. Give this ${client} site a different number.`, 400, env, request);
    if (path === "/add-site" || (oldNum && oldNum !== siteNumber)) {
      const dup = await db.prepare("SELECT client, site_name FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1")
        .bind(db.tenantId, siteNumber).first();
      if (dup) return error(`Site number ${siteNumber} is already used by "${dup.site_name}"${dup.client && dup.client !== client ? " (" + dup.client + ")" : ""}. Site numbers must be unique.`, 400, env, request);
    }
    if (path === "/update-site" && oldNum && oldNum !== siteNumber) {
      await db.prepare("DELETE FROM sites WHERE tenant_id=? AND client=? AND site_number=?").bind(db.tenantId, client, oldNum).run();
    }

    // Update = MERGE into the existing record so a partial edit (e.g. just adding
    // a phone number to a site from inside a job) never wipes the site's other
    // fields. Look up by the old number first (a rename), else the current one.
    // While merging, build a human "before → after" note for the activity log.
    let auditNote = "";
    let oldName = null;   // pre-save name — passed to SiteLog so a rename follows
    if (path === "/update-site") {
      const lookNum = String(oldNum || siteNumber).trim();
      const row = await db.prepare("SELECT data FROM sites WHERE tenant_id=? AND client=? AND site_number=?")
        .bind(db.tenantId, client, lookNum).first();
      if (row) {
        let cur = {}; try { cur = JSON.parse(row.data) || {}; } catch {}
        oldName = String(cur.siteName || "").trim() || null;
        const merged = { ...cur };
        // Which fields changed (human-named), for the activity-log note.
        const NOTE_FIELDS = { name: "name", siteName: "name", postcode: "postcode", address: "address", phone: "phone", contactName: "contact", contact: "contact" };
        const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/ · /g, " ").trim();
        const chg = [];
        for (const [k, v] of Object.entries(site)) {
          if (v !== undefined && v !== null && v !== "") {
            if (NOTE_FIELDS[k] && clean(cur[k]) !== clean(v)) chg.push(`${NOTE_FIELDS[k]} "${clean(cur[k]) || "—"}" → "${clean(v)}"`);
            merged[k] = v;
          }
        }
        if (oldNum && oldNum !== siteNumber) chg.unshift(`number "${clean(oldNum)}" → "${clean(siteNumber)}"`);
        merged.siteNumber = siteNumber; merged.client = client;
        site = merged;
        const label = clean(merged.name) || siteNumber;
        auditNote = (chg.length ? `${label} — ${chg.join(", ")}` : label).slice(0, 380);
      }
    }

    await saveSite(env, tenantId, site);
    await ensureCustomer(env, tenantId, client);
    // SiteLog: create-or-update-or-rename in one call. oldName (captured before
    // saveSite) lets a rename find the existing geofence instead of orphaning it.
    ctx?.waitUntil(syncSiteToSiteLog(env, site, oldName));
    // Mirror name / postcode edits AND active/archived state to any linked
    // compliance_stores rows so a Co-op / Fareham store's row on the compliance
    // chart tracks the site (Active↔Closed toggle mirrors the portal).
    ctx?.waitUntil(syncSiteToCompliance(env, tenantId, site).catch(() => {}));
    // Flip the PO system's active flag in step — archived site stops appearing
    // in the PO site picker; un-archived reappears.
    ctx?.waitUntil(setPOSiteActive(env, site.siteName, site.active !== false));
    const headers = auditNote ? { "X-Audit-Note": encodeURIComponent(auditNote) } : {};
    return json({ success: true, site }, { headers }, env, request);
  }

  if (path === "/next-project-job-number" && method === "GET") {
    return json({ next: await nextProjectNumber(env, tenantId) }, {}, env, request);
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
    const { results } = await db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM sites s WHERE s.tenant_id = ? AND s.client = c.id) AS site_count
      FROM customers c WHERE c.tenant_id = ? ORDER BY c.name COLLATE NOCASE
    `).bind(db.tenantId, db.tenantId).all();
    return json({ customers: results || [] }, {}, env, request);
  }

  if (path === "/customers" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = slug(b.id || b.name);
    if (!id) return error("name required", 400, env, request);
    await db.prepare(`
      INSERT INTO customers (tenant_id, id, name, contact_name, email, phone, invoice_email, billing_address, notes, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, contact_name=excluded.contact_name, email=excluded.email,
        phone=excluded.phone, invoice_email=excluded.invoice_email,
        billing_address=excluded.billing_address, notes=excluded.notes, updated_at=datetime('now')
    `).bind(db.tenantId, id, b.name || id, b.contactName || null, b.email || null, b.phone || null,
            b.invoiceEmail || null, b.billingAddress || null, b.notes || null).run();
    return json({ ok: true, id }, {}, env, request);
  }

  if (path === "/customers/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("id required", 400, env, request);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE tenant_id=? AND client=?").bind(db.tenantId, b.id).first();
    if (n && n.n > 0) return error(`Customer has ${n.n} site(s) — move or delete them first.`, 400, env, request);
    await db.prepare("DELETE FROM customers WHERE tenant_id=? AND id=?").bind(db.tenantId, b.id).run();
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
    const brands = b.brands || {};                     // client -> business name for Places search
    const limit = Math.min(Number(b.limit) || 8, 10);  // stay under subrequest caps (up to 5 fetches/site)
    const size = b.size || "640x400";

    const { results } = await db.prepare("SELECT data FROM sites WHERE tenant_id=?").bind(db.tenantId).all();
    const all = (results || []).map(r => JSON.parse(r.data));
    const locOf = s => (s.lat != null && s.lon != null)
      ? `${s.lat},${s.lon}`
      : [s.address1 || s.street || s.siteName, s.town, (s.postcode || "").replace(/\*+$/, "")].filter(Boolean).join(", ");
    // A hand-uploaded photo (anything that isn't our generated streetview.jpg)
    // is never overwritten — overwrite only regenerates OUR images.
    const ownImage = s => !s.imageURL || /\/streetview\.jpg(\?|$)/.test(s.imageURL);
    const todo = all.filter(s =>
      (overwrite || !s._noImagery) &&   // an overwrite run retries previously-failed sites
      (overwrite ? ownImage(s) && (!s._svAt || s._svAt < since) : !s.imageURL) &&
      locOf(s));

    const batch = todo.slice(0, limit);
    let updated = 0; const failed = []; let sampleError = "";
    const now = new Date().toISOString();
    for (const site of batch) {
      let loc = locOf(site);
      let buf = null;
      // 1st choice: the branch's OWN business photo via Places (brand + postcode
      // finds the actual Starbucks/Funeralcare, not whatever the camera saw).
      try {
        const q = [brands[site.client] || "", site.siteName || "",
                   (site.postcode || "").replace(/\*+$/, "")].filter(Boolean).join(" ");
        const fp = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(q)}&inputtype=textquery&fields=photos,geometry&key=${key}`);
        const fpj = await fp.json();
        const cand = fpj.candidates && fpj.candidates[0];
        if (cand) {
          // The place's true position also makes the Street View fallback accurate.
          if (cand.geometry && cand.geometry.location) loc = `${cand.geometry.location.lat},${cand.geometry.location.lng}`;
          const ref = cand.photos && cand.photos[0] && cand.photos[0].photo_reference;
          if (ref) {
            const ph = await fetch(`https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${encodeURIComponent(ref)}&key=${key}`);
            if (ph.ok && (ph.headers.get("content-type") || "").startsWith("image/")) buf = await ph.arrayBuffer();
          }
        }
      } catch (e) { if (!sampleError) sampleError = "Places: " + e.message; }
      // 2nd choice: Street View shopfront photo at the (now accurate) location.
      if (!buf) try {
        const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${encodeURIComponent(loc)}&fov=80&return_error_code=true&key=${key}`;
        const res = await fetch(svUrl);
        if (res.ok) buf = await res.arrayBuffer();
        else if (!sampleError) sampleError = `StreetView ${res.status}: ${(await res.text()).slice(0, 160)}`;
      } catch (e) { if (!sampleError) sampleError = "StreetView: " + e.message; }
      // Fallback: satellite photo via Maps Static API (aerial view of the building).
      if (!buf) {
        try {
          const smUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(loc)}&zoom=19&size=${size}&maptype=satellite&format=jpg&markers=size:small%7C${encodeURIComponent(loc)}&key=${key}`;
          const res = await fetch(smUrl);
          if (res.ok && (res.headers.get("content-type") || "").startsWith("image/")) buf = await res.arrayBuffer();
          else if (!sampleError) sampleError = `StaticMap ${res.status}: ${(await res.text()).slice(0, 160)}`;
        } catch (e) { if (!sampleError) sampleError = "StaticMap: " + e.message; }
      }
      if (buf) {
        const r2key = `sites/${site.client}/${String(site.siteNumber).trim()}/streetview.jpg`;
        await env.JOB_FILES.put(r2key, buf, { httpMetadata: { contentType: "image/jpeg" } });
        site.imageURL = `${(env.R2_PUBLIC_BASE || "").replace(/\/$/, "")}/${r2key}`;
        site._svAt = now;
        delete site._noImagery;
        await saveSite(env, tenantId, site);
        updated++;
      } else {
        site._noImagery = true;   // both sources failed — don't retry every run
        site._svAt = now;
        await saveSite(env, tenantId, site);
        failed.push(String(site.siteNumber));
      }
    }
    return json({
      ok: true, updated, failed, sampleError,
      remaining: Math.max(0, todo.length - batch.length)
    }, {}, env, request);
  }

  /* ── One-time migration from the old worker ──────────────────────────── */

  if (path === "/import-sites" && method === "POST") {
    // Preferred: the browser fetches the old worker and sends the list here
    // (Cloudflare blocks worker→worker fetches on *.workers.dev — error 1042).
    const body = await request.json().catch(() => ({}));
    const imagesOnly = !!body.imagesOnly;   // restore original photos, touch nothing else
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
      if (imagesOnly) {
        if (!site.imageURL) continue;
        const row = await db.prepare("SELECT data FROM sites WHERE tenant_id=? AND client=? AND site_number=?")
          .bind(db.tenantId, client, siteNumber).first();
        if (!row) continue;
        const cur = JSON.parse(row.data);
        cur.imageURL = site.imageURL;   // original hand-uploaded photo wins
        await saveSite(env, tenantId, cur);
        imported++;
        continue;
      }
      site.client = client;
      await saveSite(env, tenantId, site);
      clients.add(client);
      imported++;
    }
    for (const c of clients) await ensureCustomer(env, tenantId, c);
    return json({ ok: true, imported, customers: [...clients] }, {}, env, request);
  }

  return error("Unknown sites route", 404, env, request);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function saveSite(env, tenantId, site) {
  const db = tenantDB(env, tenantId);
  await db.prepare(`
    INSERT INTO sites (tenant_id, client, site_number, site_name, postcode, active, job_number, data, updated_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(client, site_number) DO UPDATE SET
      site_name=excluded.site_name, postcode=excluded.postcode, active=excluded.active,
      job_number=excluded.job_number, data=excluded.data, updated_at=datetime('now')
  `).bind(
    db.tenantId, site.client, String(site.siteNumber).trim(), site.siteName || null, site.postcode || null,
    site.active === false ? 0 : 1, site.jobNumber || null, JSON.stringify(site)
  ).run();
}

async function ensureCustomer(env, tenantId, id) {
  if (!id) return;
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "INSERT INTO customers (tenant_id, id, name) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(db.tenantId, id, prettify(id)).run();
}

// Keep SiteLog's geofences in step with the portal on EVERY save: create if
// missing, otherwise update coords / category / rename. `oldName` lets a rename
// find the existing row so the geofence follows the portal record. Best-effort.
// Uses the in-process handler when SITELOG_DB is bound, else the remote HTTP API.
export async function syncSiteToSiteLog(env, site, oldName) {
  try {
    if (!env.SITELOG_ADMIN_SECRET) return { ok: false, reason: "no-secret" };
    const name = String(site.siteName || "").trim();
    if (!name) return { ok: false, reason: "no-name" };
    const lat = Number(site.lat), lng = Number(site.lon ?? site.lng);
    // Always send `archived` (0 or 1) so a site flipped Inactive→Active on the
    // portal ALSO un-archives the geofence — otherwise archive is one-way.
    const body = {
      siteName: name,
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
      category: prettify(site.client || "") || "Projects",
      oldName: oldName && String(oldName).trim() !== name ? String(oldName).trim() : undefined,
      archived: site.active === false ? 1 : 0,
    };
    return await slCall(env, "/upsert-site", body);
  } catch (e) { return { ok: false, error: e.message }; }
}

// Delete (or archive) the SiteLog geofence for this name, so scans stop landing
// on a site the portal has retired. Best-effort — never blocks the portal save.
export async function removeSiteFromSiteLog(env, siteName, { archive } = {}) {
  try {
    if (!env.SITELOG_ADMIN_SECRET || !String(siteName || "").trim()) return { ok: false };
    return await slCall(env, "/delete-site", { siteName: String(siteName).trim(), archive: !!archive });
  } catch (e) { return { ok: false, error: e.message }; }
}

async function slCall(env, path, body) {
  const base = (env.SITELOG_API || "https://api.site-log.co.uk");
  const init = { method: "POST", headers: { "Content-Type": "application/json", "x-admin-secret": env.SITELOG_ADMIN_SECRET }, body: JSON.stringify(body) };
  const req = new Request(base + path, init);
  if (env.SITELOG_DB) { try { const r = await sitelogApi.handle(req, env); if (r) return await r.json().catch(() => ({ ok: r.ok })); } catch (e) {} }
  const res = await fetch(base + path, init);
  return await res.json().catch(() => ({ ok: res.ok }));
}

// Legacy wrapper kept so any lingering callers still fire the sync.
async function pushSiteToSiteLog(env, site) { return syncSiteToSiteLog(env, site); }

// Mirror portal-site edits (name / postcode / lat / lng / active-vs-archived)
// into any linked `compliance_stores` rows so the compliance chart tracks the
// canonical site. Archive/unarchive moves the store between the Open and
// Closed views on the chart. Best-effort — never blocks the caller.
export async function syncSiteToCompliance(env, tenantId, site) {
  try {
    const num = String(site.siteNumber || "").trim();
    if (!num) return;
    const rows = await env.DB.prepare(
      "SELECT scheme, code, meta FROM compliance_stores WHERE tenant_id=? AND site_number=?"
    ).bind(tenantId, num).all();
    const activeVal = site.active === false ? 0 : 1;
    for (const r of rows.results || []) {
      let meta = {}; try { meta = JSON.parse(r.meta || "{}") || {}; } catch {}
      const lat = site.lat != null ? Number(site.lat) : null;
      const lng = site.lon != null ? Number(site.lon) : (site.lng != null ? Number(site.lng) : null);
      if (Number.isFinite(lat)) meta.lat = lat;
      if (Number.isFinite(lng)) meta.lng = lng;
      await env.DB.prepare(
        "UPDATE compliance_stores SET name=COALESCE(?, name), postcode=COALESCE(?, postcode), meta=?, active=?, updated_at=? WHERE tenant_id=? AND scheme=? AND code=?"
      ).bind(
        site.siteName || null, site.postcode || null, JSON.stringify(meta),
        activeVal, new Date().toISOString(), tenantId, r.scheme, r.code
      ).run();
    }
  } catch {}
}

// Flip a PO-system site's active flag (0/1) to match the portal. Add-only
// otherwise — never creates a PO row that wasn't already there.
export async function setPOSiteActive(env, name, active) {
  try {
    if (!env.PO_DB || !String(name || "").trim()) return false;
    const val = active ? 1 : 0;
    await env.PO_DB.prepare("UPDATE sites SET active = ? WHERE name = ?").bind(val, String(name).trim()).run();
    return true;
  } catch { return false; }
}

async function nextProjectNumber(env, tenantId) {
  const db = tenantDB(env, tenantId);
  // Scan EVERY site's number (job_number AND site_number, any client) for a
  // P#### — not just client='projects' — so a new project number can never
  // collide with a generic site that was typed with a P-number (e.g. the office
  // or yard). A collision cross-links jobs into the wrong project.
  const { results } = await db.prepare(
    "SELECT job_number, site_number FROM sites WHERE tenant_id=?"
  ).bind(db.tenantId).all();
  let max = 0;
  for (const r of results || []) {
    for (const v of [r.job_number, r.site_number]) {
      const m = String(v || "").match(/^P0*(\d+)$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return "P" + String(max + 1).padStart(4, "0");
}

async function nextSiteNumber(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const { results } = await db.prepare(
    "SELECT site_number FROM sites WHERE tenant_id=? AND client='site' AND site_number IS NOT NULL"
  ).bind(db.tenantId).all();
  let max = 0;
  for (const r of results || []) {
    const m = String(r.site_number).match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "S" + String(max + 1).padStart(4, "0");
}

function slug(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function prettify(id) {
  return String(id).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
