// Staff / HR documents — each person's private file plus company-wide documents.
//
//   Personal  : employment contract, letters, payslips — visible ONLY to that
//               user and to Full-access admins.
//   Company   : policies (incl. the data-retention policy), handbooks —
//               visible to everyone.
//
// Files live in R2 (JOB_FILES) under a tenant-prefixed key and are served
// through the signed, expiring /staff/doc route (same protection as site docs),
// so a link can't be forged, enumerated, or shared to an outsider forever.
//
//   GET  /staff/docs?user=<u>         list a person's personal docs + company docs
//   POST /staff/docs?user=<u>&scope=personal|company&category=<c>   upload (Full access)
//   POST /staff/doc-delete { key }    delete (Full access)
//   GET  /staff/doc?key=...           stream bytes (signed; public like site docs)
//   POST /staff/category { name }     add a category (Full access)

import { corsHeaders } from "../lib/http.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor } from "../lib/auth.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";

const DEFAULT_CATEGORIES = ["Employment Contract", "Policies", "Payslips", "Other"];

function jr(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
const safeName = s => String(s || "file").replace(/[^\w.\-]+/g, "_");
const cleanCat = s => String(s || "").replace(/[\/]/g, "-").trim();

async function isFull(env, tenantId, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tenantId, sess.user.username);
  return p.FullAccess === "Yes";
}

async function getCategories(env, tenantId) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?")
      .bind(`staff_doc_categories:${tenantId}`).first();
    if (row && row.value) {
      const c = JSON.parse(row.value);
      if (Array.isArray(c) && c.length) return c;
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_CATEGORIES.slice();
}
async function addCategory(env, tenantId, name) {
  const cats = await getCategories(env, tenantId);
  const clean = cleanCat(name);
  if (clean && !cats.some(c => c.toLowerCase() === clean.toLowerCase())) cats.push(clean);
  await env.DB.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tenantId, `staff_doc_categories:${tenantId}`, JSON.stringify(cats)).run();
  return cats;
}

// Personal docs live under .../user/<username>/, company docs under .../company/.
const personalPrefix = (tid, user) => `staffdocs/${tid}/user/${user}/`;
const companyPrefix = tid => `staffdocs/${tid}/company/`;

async function listUnder(env, prefix) {
  const out = {};
  const listed = await env.JOB_FILES.list({ prefix, include: ["customMetadata"] });
  for (const o of listed.objects || []) {
    // key = <prefix><category>/<ts>-<name>
    const rest = o.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    const category = slash > 0 ? rest.slice(0, slash) : "Other";
    (out[category] = out[category] || []).push({
      key: o.key,
      name: (o.customMetadata && o.customMetadata.name) || o.key.split("/").pop(),
      at: o.uploaded ? new Date(o.uploaded).toISOString() : null,
      by: o.customMetadata && o.customMetadata.by,
      size: o.size
    });
  }
  return out;
}
async function signGroups(env, origin, groups) {
  for (const cat of Object.keys(groups)) {
    for (const f of groups[cat]) f.url = await signedFileUrl(env, origin, "/staff/doc", f.key);
    groups[cat].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  }
  return groups;
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const sub = url.pathname.replace(/^\/staff(?=\/|$)/, "") || "/";
  const q = url.searchParams;

  // ── Stream a document (public, but access-gated by the signature) ──────────
  if (sub === "/doc" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("staffdocs/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers,
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600"
    }});
  }

  // Everything below needs a session.
  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  const full = await isFull(env, tenantId, sess);

  // ── List a person's file: their personal docs + the company docs ───────────
  if (sub === "/docs" && method === "GET") {
    const who = (q.get("user") || sess.user.username).trim();
    // A normal user may only see their OWN personal file; admins see anyone's.
    if (who !== sess.user.username && !full) return jr({ error: "Forbidden" }, headers, 403);
    const categories = await getCategories(env, tenantId);
    const personal = await signGroups(env, url.origin, await listUnder(env, personalPrefix(tenantId, who)));
    const company = await signGroups(env, url.origin, await listUnder(env, companyPrefix(tenantId)));
    return jr({ user: who, categories, personal, company, canManage: full }, headers);
  }

  // ── Upload (Full access only) ──────────────────────────────────────────────
  if (sub === "/docs" && method === "POST") {
    if (!full) return jr({ error: "Only a Full-access user can upload staff documents." }, headers, 403);
    const scope = (q.get("scope") || "personal") === "company" ? "company" : "personal";
    const category = cleanCat(q.get("category")) || "Other";
    const who = (q.get("user") || "").trim();
    if (scope === "personal" && !who) return jr({ error: "Missing user" }, headers, 400);
    const form = await request.formData();
    const file = form.get("file");
    if (!file) return jr({ error: "Missing file" }, headers, 400);
    const base = scope === "company" ? companyPrefix(tenantId) : personalPrefix(tenantId, who);
    const key = `${base}${category}/${Date.now()}-${safeName(file.name)}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { name: file.name || safeName(file.name), by: sess.user.username, at: new Date().toISOString() }
    });
    return jr({ ok: true, key, url: await signedFileUrl(env, url.origin, "/staff/doc", key) }, headers, 201);
  }

  // ── Delete (Full access only) ──────────────────────────────────────────────
  if (sub === "/doc-delete" && method === "POST") {
    if (!full) return jr({ error: "Forbidden" }, headers, 403);
    const { key } = await readJson(request);
    if (!key || !String(key).startsWith("staffdocs/")) return jr({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    return jr({ ok: true }, headers);
  }

  // ── Add a category (Full access only) ──────────────────────────────────────
  if (sub === "/category" && method === "POST") {
    if (!full) return jr({ error: "Only a Full-access user can add categories." }, headers, 403);
    const { name } = await readJson(request);
    if (!cleanCat(name)) return jr({ error: "Category name required" }, headers, 400);
    return jr({ ok: true, categories: await addCategory(env, tenantId, name) }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}

// Exposed so the privacy/erasure tool can wipe a leaver's personal file.
export async function deletePersonalDocs(env, tenantId, username) {
  let n = 0;
  try {
    const listed = await env.JOB_FILES.list({ prefix: personalPrefix(tenantId, username) });
    for (const o of listed.objects || []) { await env.JOB_FILES.delete(o.key); n++; }
  } catch { /* best effort */ }
  return n;
}
