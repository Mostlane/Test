// Chapplins — a full customer (residential lettings) built from their emailed
// job reports. Sites live in the normal `sites` register (client = 'chapplins');
// their jobs live in `sla_jobs_archive` (site_code = the portal site number, so
// each site's "Previous Jobs" + the Job Archive surface them); their compliance
// certs live under the `chapplins` scheme in compliance_stores/compliance_files.
//
// The ONE thing that has no home elsewhere is the TENANT: who occupies a site,
// their contact details, and the current-vs-previous history. That is this
// module — table `site_tenants` (generic per-site tenant, keyed by site number)
// plus a small read/manage API mounted at /chapplins.
//
//   GET  /chapplins/sites            -> [{ siteNumber, siteName, postcode, active,
//                                          jobCount, tenantCount, currentTenant, due }]
//   GET  /chapplins/site?number=NNNN -> { site, tenants:[current-first], jobs:[] }
//   POST /chapplins/tenant           -> upsert one tenant (manage)
//   POST /chapplins/tenant/current   -> make one tenant current for its site
//   POST /chapplins/tenant/delete    -> remove one tenant
//
// View = any logged-in office user; manage = FullAccess | Compliance | SLAAdmin.

import { json, error } from "../lib/http.js";
import { tenantDB } from "../lib/tenantdb.js";
import { permissionsFor } from "../lib/auth.js";

const CLIENT = "chapplins";
const SCHEME = "chapplins";

let _ready = false;
async function ensureTables(env, tenantId) {
  if (_ready) return;
  const db = tenantDB(env, tenantId);
  await db.prepare(`CREATE TABLE IF NOT EXISTS site_tenants (
    tenant_id   INTEGER NOT NULL DEFAULT 1,
    id          TEXT PRIMARY KEY,        -- stable: <client>:<siteNumber>:<ref|slug(name)>
    client      TEXT,                    -- portal client id (chapplins)
    site_number TEXT NOT NULL,           -- the portal site this tenant occupies
    ref         TEXT,                    -- the customer's own tenant reference (e.g. MYER01)
    name        TEXT,
    phone       TEXT,
    email       TEXT,
    home_tel    TEXT,
    notes       TEXT,
    first_seen  TEXT,                    -- earliest job date we saw this tenant
    last_seen   TEXT,                    -- latest job date (drives current)
    is_current  INTEGER DEFAULT 0,       -- 1 = current occupant of the site
    data        TEXT,                    -- JSON room for extra fields
    updated_at  TEXT
  )`).run();
  try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_site_tenants_site ON site_tenants(tenant_id, client, site_number)").run(); } catch {}
  _ready = true;
}

const slug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const nowISO = () => new Date().toISOString();
function tenantId2(client, siteNumber, ref, name) {
  return `${client}:${siteNumber}:${slug(ref || name || "t")}`;
}
async function canManage(env, tid, sess) {
  if (!sess) return false;
  try { const p = await permissionsFor(env, tid, sess.user.username); return p.FullAccess === "Yes" || p.Chapplins === "Yes"; } catch { return false; }
}

// Shape a DB row into the client tenant object.
function tenantOut(r) {
  return {
    id: r.id, siteNumber: r.site_number, ref: r.ref || "", name: r.name || "",
    phone: r.phone || "", email: r.email || "", homeTel: r.home_tel || "",
    notes: r.notes || "", firstSeen: r.first_seen || "", lastSeen: r.last_seen || "",
    current: r.is_current ? 1 : 0,
  };
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method;
  const q = url.searchParams;
  if (!sess) return error("Not authenticated", 401, env, request);
  const tenantId = sess.tenantId;
  const db = tenantDB(env, tenantId);
  await ensureTables(env, tenantId);

  /* ── GET /chapplins/sites — the directory ─────────────────────────────── */
  if (path === "/chapplins/sites" && method === "GET") {
    // Sites (client=chapplins) from the register.
    const { results: siteRows } = await db.prepare(
      "SELECT site_number, site_name, postcode, active, data FROM sites WHERE tenant_id=? AND client=? ORDER BY site_name COLLATE NOCASE"
    ).bind(tenantId, CLIENT).all();

    // Tenants for those sites.
    const { results: tenRows } = await db.prepare(
      "SELECT * FROM site_tenants WHERE tenant_id=? AND client=?"
    ).bind(tenantId, CLIENT).all();
    const tenBySite = {};
    for (const r of tenRows || []) (tenBySite[r.site_number] = tenBySite[r.site_number] || []).push(r);

    // Job counts per site (archive is keyed by numeric site_code).
    const jobCount = {};
    try {
      const { results: jc } = await db.prepare(
        "SELECT site_code, COUNT(*) AS n FROM sla_jobs_archive WHERE tenant_id=? AND site_code IS NOT NULL GROUP BY site_code"
      ).bind(tenantId).all();
      for (const r of jc || []) jobCount[String(r.site_code)] = r.n;
    } catch {}

    // Compliance due dates per site (scheme=chapplins, code = site number).
    const dueByCode = {};
    try {
      const { results: cs } = await db.prepare(
        "SELECT code, due FROM compliance_stores WHERE tenant_id=? AND scheme=?"
      ).bind(tenantId, SCHEME).all();
      for (const r of cs || []) { try { dueByCode[String(r.code)] = JSON.parse(r.due || "{}") || {}; } catch {} }
    } catch {}

    const sites = (siteRows || []).map(s => {
      const num = String(s.site_number);
      const tens = (tenBySite[num] || []).slice().sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));
      const cur = tens.find(t => t.is_current) || tens[0] || null;
      return {
        siteNumber: num, siteName: s.site_name || "", postcode: s.postcode || "",
        active: s.active == null ? 1 : s.active,
        jobCount: jobCount[String(Number(num))] || jobCount[num] || 0,
        tenantCount: tens.length,
        currentTenant: cur ? { ref: cur.ref || "", name: cur.name || "", phone: cur.phone || "", email: cur.email || "" } : null,
        due: dueByCode[num] || {},
      };
    });
    return json({ ok: true, sites, count: sites.length }, {}, env, request);
  }

  /* ── GET /chapplins/site?number= — one site in full ───────────────────── */
  if (path === "/chapplins/site" && method === "GET") {
    const num = String(q.get("number") || "").trim();
    if (!num) return error("number required", 400, env, request);
    const s = await db.prepare(
      "SELECT site_number, site_name, postcode, active, data FROM sites WHERE tenant_id=? AND client=? AND site_number=?"
    ).bind(tenantId, CLIENT, num).first();
    if (!s) return error("Site not found", 404, env, request);
    let data = {}; try { data = JSON.parse(s.data || "{}") || {}; } catch {}

    const { results: tenRows } = await db.prepare(
      "SELECT * FROM site_tenants WHERE tenant_id=? AND client=? AND site_number=? ORDER BY is_current DESC, last_seen DESC"
    ).bind(tenantId, CLIENT, num).all();
    const tenants = (tenRows || []).map(tenantOut);

    // Jobs: this site's archived job history (numeric site_code).
    let jobs = [];
    try {
      const code = String(Number(num));
      const { results: jr } = await db.prepare(
        "SELECT id, ref, status, created_at, completed_at, data FROM sla_jobs_archive WHERE tenant_id=? AND site_code=? ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 500"
      ).bind(tenantId, code).all();
      jobs = (jr || []).map(r => {
        let d = {}; try { d = JSON.parse(r.data || "{}") || {}; } catch {}
        return {
          id: r.id, ref: r.ref || r.id, status: r.status || "Archived",
          priority: d.priority || "", date: r.created_at || r.completed_at || null,
          description: d.description || d.jobName || "", tenantRef: d.tenantRef || "", tenantName: d.tenantName || "",
        };
      });
    } catch {}

    return json({
      ok: true,
      site: { siteNumber: String(s.site_number), siteName: s.site_name || "", postcode: s.postcode || "", active: s.active == null ? 1 : s.active, data },
      tenants, jobs,
    }, {}, env, request);
  }

  /* ── POST /chapplins/tenant — upsert (manage) ─────────────────────────── */
  if (path === "/chapplins/tenant" && method === "POST") {
    if (!(await canManage(env, tenantId, sess))) return error("Not permitted", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const siteNumber = String(b.siteNumber || "").trim();
    if (!siteNumber) return error("siteNumber required", 400, env, request);
    if (!String(b.name || "").trim() && !String(b.ref || "").trim()) return error("name or ref required", 400, env, request);
    const id = String(b.id || "").trim() || tenantId2(CLIENT, siteNumber, b.ref, b.name);
    const makeCurrent = b.makeCurrent === undefined ? true : !!b.makeCurrent;
    if (makeCurrent) {
      await db.prepare("UPDATE site_tenants SET is_current=0, updated_at=? WHERE tenant_id=? AND client=? AND site_number=?")
        .bind(nowISO(), tenantId, CLIENT, siteNumber).run();
    }
    await db.prepare(`INSERT INTO site_tenants
        (tenant_id, id, client, site_number, ref, name, phone, email, home_tel, notes, first_seen, last_seen, is_current, data, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        site_number=excluded.site_number, ref=excluded.ref, name=excluded.name,
        phone=excluded.phone, email=excluded.email, home_tel=excluded.home_tel,
        notes=excluded.notes, first_seen=COALESCE(excluded.first_seen, site_tenants.first_seen),
        last_seen=COALESCE(excluded.last_seen, site_tenants.last_seen),
        is_current=excluded.is_current, updated_at=excluded.updated_at`)
      .bind(tenantId, id, CLIENT, siteNumber, b.ref || null, b.name || null, b.phone || null,
            b.email || null, b.homeTel || null, b.notes || null,
            b.firstSeen || null, b.lastSeen || null, makeCurrent ? 1 : 0, JSON.stringify(b.data || {}), nowISO()).run();
    const row = await db.prepare("SELECT * FROM site_tenants WHERE tenant_id=? AND id=?").bind(tenantId, id).first();
    return json({ ok: true, tenant: row ? tenantOut(row) : null }, {}, env, request);
  }

  /* ── POST /chapplins/tenant/current — promote to current ──────────────── */
  if (path === "/chapplins/tenant/current" && method === "POST") {
    if (!(await canManage(env, tenantId, sess))) return error("Not permitted", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "").trim();
    if (!id) return error("id required", 400, env, request);
    const row = await db.prepare("SELECT site_number FROM site_tenants WHERE tenant_id=? AND id=?").bind(tenantId, id).first();
    if (!row) return error("Tenant not found", 404, env, request);
    await db.prepare("UPDATE site_tenants SET is_current=0, updated_at=? WHERE tenant_id=? AND client=? AND site_number=?")
      .bind(nowISO(), tenantId, CLIENT, row.site_number).run();
    await db.prepare("UPDATE site_tenants SET is_current=1, updated_at=? WHERE tenant_id=? AND id=?").bind(nowISO(), tenantId, id).run();
    return json({ ok: true }, {}, env, request);
  }

  /* ── POST /chapplins/tenant/delete ────────────────────────────────────── */
  if (path === "/chapplins/tenant/delete" && method === "POST") {
    if (!(await canManage(env, tenantId, sess))) return error("Not permitted", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "").trim();
    if (!id) return error("id required", 400, env, request);
    await db.prepare("DELETE FROM site_tenants WHERE tenant_id=? AND id=?").bind(tenantId, id).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown chapplins route", 404, env, request);
}
