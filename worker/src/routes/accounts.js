// Accounts capture — a STANDALONE document/statement store (separate from the PO
// board). Upload anything (PDF / image / HTML / any file); it keeps the file and,
// for a credit-card or bank statement, reads out the transaction lines so accounts
// can tick each off against a captured receipt. Plus an all-suppliers +
// subcontractors per-VAT-quarter checklist. Storage + supplier lists live in PO_DB.
//
// NB a statement is NOT a VAT invoice — this is a completeness / chase workflow
// (what did we spend → which have a receipt → chase the rest), not VAT capture.
import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { onceMigration } from "../lib/once.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";

const numOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function vatQuarter(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return "";
  return m[1] + "-Q" + (Math.floor((Number(m[2]) - 1) / 3) + 1);
}
function staffTypeOf(u) {
  try { const p = JSON.parse(u.profile || "{}"); return p && p.staffType === "office" ? "office" : "field"; }
  catch { return "field"; }
}
function userName(sess) {
  const u = (sess && sess.user) || {};
  return (u.name || ((u.first_name || u.FirstName || "") + " " + (u.last_name || u.LastName || "")).trim() || u.username || "").trim();
}

async function ensureTables__raw(db) {
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS acct_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT,
      kind TEXT, filename TEXT, r2_key TEXT, content_type TEXT,
      supplier TEXT, doc_date TEXT, period TEXT, amount REAL,
      doc_type TEXT, source TEXT, notes TEXT, status TEXT DEFAULT 'open',
      line_count INTEGER DEFAULT 0, created_by TEXT, created_at TEXT )`,
    `CREATE TABLE IF NOT EXISTS acct_statement_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, document_id INTEGER,
      line_date TEXT, description TEXT, amount REAL, supplier_guess TEXT,
      period TEXT, status TEXT DEFAULT 'open', receipt_document_id INTEGER,
      notes TEXT, created_at TEXT )`,
    `CREATE TABLE IF NOT EXISTS acct_supplier_check (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, period TEXT,
      party_key TEXT, name TEXT, kind TEXT, checked INTEGER DEFAULT 0,
      checked_by TEXT, checked_at TEXT, note TEXT,
      UNIQUE(tenant_id, period, party_key) )`,
  ]) { try { await db.prepare(ddl).run(); } catch { /* exists */ } }
}
const ensureTables = onceMigration(ensureTables__raw);

// ── AI reader: pull a statement's transaction lines (or a single invoice line) ──
function bytesToBase64(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = ""; const CH = 8192;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  } catch { return ""; }
}
function stripHtml(s) {
  return String(s || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
function contentBlock(bytes, filename, ct) {
  const name = String(filename || "").toLowerCase();
  const c = String(ct || "").toLowerCase();
  const isPdf = c.includes("pdf") || name.endsWith(".pdf");
  const isImg = c.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/.test(name);
  const isHtml = c.includes("html") || c.startsWith("text/") || /\.(html?|txt|csv)$/.test(name);
  const b64 = () => bytesToBase64(bytes);
  if (isPdf) { const d = b64(); return d ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: d } } : null; }
  if (isImg) {
    const mt = c.startsWith("image/") ? c : name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : name.endsWith(".gif") ? "image/gif" : "image/jpeg";
    const d = b64(); return d ? { type: "image", source: { type: "base64", media_type: mt, data: d } } : null;
  }
  if (isHtml) {
    let text = "";
    try { text = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch {}
    text = stripHtml(text).slice(0, 60000);
    return text ? { type: "text", text: "Document text:\n" + text } : null;
  }
  return null; // unreadable (Word/Excel/…): store only
}
async function readFinancialDoc(env, bytes, filename, ct) {
  const key = env && env.ANTHROPIC_API_KEY;
  const block = contentBlock(bytes, filename, ct);
  if (!key || !block) return { docType: block ? "other" : "unreadable", supplier: null, total: null, lines: [] };
  const b64len = block.source && block.source.data ? block.source.data.length : 0;
  if (b64len > 12 * 1024 * 1024) return { docType: "toobig", supplier: null, total: null, lines: [] };
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const schema = {
    type: "object",
    properties: {
      docType: { type: "string", enum: ["statement", "invoice", "receipt", "other"], description: "'statement' = a credit-card or bank statement listing many transactions. 'invoice'/'receipt' = a single purchase. 'other' = anything else." },
      supplier: { type: "string", description: "The card provider / bank, or (for a single invoice) the merchant." },
      statementTotal: { type: "number", description: "The total spend / balance if shown." },
      lines: {
        type: "array", description: "Every transaction line. For a single invoice/receipt, one line.",
        items: {
          type: "object", properties: {
            date: { type: "string", description: "Transaction date, YYYY-MM-DD." },
            description: { type: "string", description: "Merchant / narrative." },
            amount: { type: "number", description: "GBP. POSITIVE for money spent (a charge); NEGATIVE for a refund/credit. Ignore payments to the account." },
          }, required: ["description", "amount"],
        },
      },
    }, required: ["docType", "lines"],
  };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 4000,
        tools: [{ name: "read_document", description: "Return the financial document's transaction lines.", input_schema: schema }],
        tool_choice: { type: "tool", name: "read_document" },
        messages: [{ role: "user", content: [block, { type: "text", text: "This is a financial document sent to Mostlane Construction (a UK building contractor). If it is a credit-card or bank STATEMENT, list EVERY transaction line — date, merchant/description, amount in GBP (positive = spent). Skip payments INTO the account. If it is a single invoice or receipt, return it as one line. All amounts in pounds." }] }],
      }),
    });
    if (!r.ok) return { docType: "other", supplier: null, total: null, lines: [] };
    const p = await r.json();
    const blk = Array.isArray(p.content) ? p.content.find(c => c.type === "tool_use" && c.name === "read_document") : null;
    const o = blk && blk.input;
    if (!o) return { docType: "other", supplier: null, total: null, lines: [] };
    const lines = (Array.isArray(o.lines) ? o.lines : []).slice(0, 400).map(l => ({
      date: normIso(l.date), description: String(l.description || "").slice(0, 200), amount: numOrNull(l.amount),
    })).filter(l => l.amount != null);
    return { docType: String(o.docType || "").toLowerCase() || "other", supplier: o.supplier ? String(o.supplier).slice(0, 120) : null, total: numOrNull(o.statementTotal), lines };
  } catch { return { docType: "other", supplier: null, total: null, lines: [] }; }
}
function normIso(s) { const m = String(s || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : null; }

// ── Router ──────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  const db = env.PO_DB;
  if (!db) return error("Accounts database not bound (PO_DB)", 500, env, request);
  const path = url.pathname.replace(/^\/accounts/, "") || "/";
  const method = request.method.toUpperCase();
  await ensureTables(db);

  // Public: stream a stored document via a signed link (viewer/<a> can't send a Bearer).
  if (path === "/doc-file" && method === "GET") return serveDocFile(request, env, url);

  if (!sess || !sess.user) return error("Not authenticated", 401, env, request);
  if (String(sess.user.status || "").toLowerCase() === "disabled") return error("Account disabled", 403, env, request);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  const field = staffTypeOf(sess.user) === "field";
  const office = perms.FullAccess === "Yes" || (perms.PurchaseOrders === "Yes" && !field);
  if (!office) return error("Not allowed", 403, env, request);
  const q = url.searchParams;
  const jr = (d, status) => json(d, status ? { status } : {}, env, request);
  const bodyOf = async () => { try { return await request.json(); } catch { return {}; } };

  try {
    if (path === "/upload" && method === "POST") return jr(await uploadDoc(env, db, sess, url.origin, request));
    if (path === "/docs" && method === "GET") return jr(await listDocs(env, db, sess, url.origin, q));
    if (path === "/doc" && method === "GET") return jr(await getDoc(env, db, sess, url.origin, q));
    if (path === "/doc-update" && method === "POST") return jr(await updateDoc(db, sess, await bodyOf()));
    if (path === "/doc-delete" && method === "POST") return jr(await deleteDoc(env, db, sess, await bodyOf()));
    if (path === "/doc-read" && method === "POST") return jr(await rereadDoc(env, db, sess, await bodyOf()));
    if (path === "/lines" && method === "GET") return jr(await listLines(db, sess, q));
    if (path === "/line-update" && method === "POST") return jr(await updateLine(db, sess, await bodyOf()));
    if (path === "/suppliers" && method === "GET") return jr(await suppliersChecklist(db, sess, q));
    if (path === "/supplier-check" && method === "POST") return jr(await setSupplierCheck(db, sess, await bodyOf()));
    return error("Not found: " + path, 404, env, request);
  } catch (e) {
    console.error("Accounts route error:", e && e.message);
    return error("Accounts error: " + (e && e.message || "unknown"), 500, env, request);
  }
}

async function serveDocFile(request, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!key.startsWith("accounts-docs/")) return error("Bad key", 400, env, request);
  const ok = await verifyFileSig(env, key, url.searchParams);
  if (!ok) return error("Link expired or invalid", 403, env, request);
  const obj = await env.JOB_FILES.get(key);
  if (!obj) return error("Not found", 404, env, request);
  const h = new Headers();
  h.set("Content-Type", (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream");
  h.set("Content-Disposition", "inline");
  h.set("Cache-Control", "private, max-age=60");
  h.set("Access-Control-Allow-Origin", "*");
  return new Response(obj.body, { headers: h });
}

async function uploadDoc(env, db, sess, origin, request) {
  const form = await request.formData().catch(() => null);
  const file = form && form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") return { error: "No file uploaded" };
  const ab = await file.arrayBuffer();
  if (ab.byteLength > 25 * 1024 * 1024) return { error: "That file is too big (max 25 MB)" };
  const bytes = new Uint8Array(ab);
  const kindHint = String((form.get("kind") || "")).trim();      // office may say it's a statement
  const noRead = String(form.get("no_read") || "") === "1";
  const filename = file.name || "document";
  const ct = file.type || "application/octet-stream";
  const safe = filename.replace(/[^\w.\-]+/g, "_").slice(-90);
  const r2key = `accounts-docs/${sess.tenantId}/${Date.now()}-${safe}`;
  try { await env.JOB_FILES.put(r2key, bytes, { httpMetadata: { contentType: ct } }); }
  catch (e) { return { error: "Could not store the file: " + (e && e.message) }; }
  const read = noRead ? { docType: "other", supplier: null, total: null, lines: [] }
    : await readFinancialDoc(env, bytes, filename, ct);
  const isStatement = kindHint === "statement" || read.docType === "statement" || read.lines.length > 1;
  const kind = kindHint || (isStatement ? "statement" : (read.docType === "invoice" || read.docType === "receipt" ? read.docType : "other"));
  // A single invoice's line date → the doc date; a statement → newest line date.
  const dates = read.lines.map(l => l.date).filter(Boolean).sort();
  const docDate = dates.length ? dates[dates.length - 1] : null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const res = await db.prepare(`INSERT INTO acct_documents
    (tenant_id, kind, filename, r2_key, content_type, supplier, doc_date, period, amount, doc_type, source, status, line_count, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    String(sess.tenantId), kind, filename, r2key, ct, read.supplier || null, docDate, vatQuarter(docDate),
    read.total, read.docType || null, "upload", "open", read.lines.length, userName(sess), now
  ).run();
  const docId = res && res.meta && res.meta.last_row_id;
  if (docId && read.lines.length) await insertLines(db, sess, docId, read.lines);
  return { ok: true, id: docId, kind, docType: read.docType, supplier: read.supplier, lineCount: read.lines.length, unreadable: read.docType === "unreadable" };
}
async function insertLines(db, sess, docId, lines) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const l of lines) {
    try {
      await db.prepare(`INSERT INTO acct_statement_lines
        (tenant_id, document_id, line_date, description, amount, period, status, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(
        String(sess.tenantId), docId, l.date || null, l.description || "", numOrNull(l.amount), vatQuarter(l.date), "open", now
      ).run();
    } catch { /* skip a bad line */ }
  }
}
async function rereadDoc(env, db, sess, b) {
  const id = Number(b && b.id); if (!id) return { error: "No id" };
  const row = await db.prepare(`SELECT * FROM acct_documents WHERE id=? AND tenant_id=?`).bind(id, String(sess.tenantId)).first();
  if (!row) return { error: "Not found" };
  const obj = await env.JOB_FILES.get(row.r2_key);
  if (!obj) return { error: "Stored file missing" };
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const read = await readFinancialDoc(env, bytes, row.filename, row.content_type);
  await db.prepare(`DELETE FROM acct_statement_lines WHERE document_id=? AND tenant_id=?`).bind(id, String(sess.tenantId)).run();
  if (read.lines.length) await insertLines(db, sess, id, read.lines);
  await db.prepare(`UPDATE acct_documents SET line_count=?, supplier=COALESCE(supplier,?), doc_type=? WHERE id=?`).bind(read.lines.length, read.supplier || null, read.docType || null, id).run();
  return { ok: true, lineCount: read.lines.length };
}
async function listDocs(env, db, sess, origin, params) {
  let sql = `SELECT * FROM acct_documents WHERE tenant_id=?`;
  const binds = [String(sess.tenantId)];
  const period = params.get("period"); if (period) { sql += ` AND period=?`; binds.push(period); }
  const kind = params.get("kind"); if (kind) { sql += ` AND kind=?`; binds.push(kind); }
  const qs = (params.get("q") || "").trim();
  if (qs) { const l = "%" + qs.toLowerCase() + "%"; sql += ` AND (lower(COALESCE(supplier,'')) LIKE ? OR lower(COALESCE(filename,'')) LIKE ?)`; binds.push(l, l); }
  sql += ` ORDER BY COALESCE(doc_date, created_at) DESC, id DESC LIMIT 1000`;
  let rows = [];
  try { rows = (await db.prepare(sql).bind(...binds).all()).results || []; } catch { rows = []; }
  for (const r of rows) r.url = r.r2_key ? await signedFileUrl(env, origin, "/accounts/doc-file", r.r2_key) : null;
  let periods = [];
  try { periods = (await db.prepare(`SELECT period p, COUNT(*) n FROM acct_documents WHERE tenant_id=? AND period IS NOT NULL AND period<>'' GROUP BY period ORDER BY period DESC`).bind(String(sess.tenantId)).all()).results || []; } catch {}
  return { rows, periods };
}
async function getDoc(env, db, sess, origin, params) {
  const id = Number(params.get("id")); if (!id) return { error: "No id" };
  const row = await db.prepare(`SELECT * FROM acct_documents WHERE id=? AND tenant_id=?`).bind(id, String(sess.tenantId)).first();
  if (!row) return { error: "Not found" };
  row.url = row.r2_key ? await signedFileUrl(env, origin, "/accounts/doc-file", row.r2_key) : null;
  let lines = [];
  try { lines = (await db.prepare(`SELECT * FROM acct_statement_lines WHERE document_id=? AND tenant_id=? ORDER BY COALESCE(line_date,''), id`).bind(id, String(sess.tenantId)).all()).results || []; } catch {}
  return { doc: row, lines };
}
async function updateDoc(db, sess, b) {
  const id = Number(b && b.id); if (!id) return { error: "No id" };
  const fields = [], binds = [];
  for (const k of ["kind", "supplier", "doc_date", "notes", "status", "amount"]) {
    if (b[k] !== undefined) { fields.push(`${k} = ?`); binds.push(b[k] === "" ? null : (k === "amount" ? numOrNull(b[k]) : b[k])); }
  }
  if (b.doc_date !== undefined) { fields.push(`period = ?`); binds.push(vatQuarter(b.doc_date)); }
  if (!fields.length) return { ok: true };
  binds.push(id, String(sess.tenantId));
  await db.prepare(`UPDATE acct_documents SET ${fields.join(", ")} WHERE id=? AND tenant_id=?`).bind(...binds).run();
  return { ok: true };
}
async function deleteDoc(env, db, sess, b) {
  const id = Number(b && b.id); if (!id) return { error: "No id" };
  const row = await db.prepare(`SELECT r2_key FROM acct_documents WHERE id=? AND tenant_id=?`).bind(id, String(sess.tenantId)).first();
  if (row && row.r2_key) { try { await env.JOB_FILES.delete(row.r2_key); } catch {} }
  await db.prepare(`DELETE FROM acct_statement_lines WHERE document_id=? AND tenant_id=?`).bind(id, String(sess.tenantId)).run();
  await db.prepare(`DELETE FROM acct_documents WHERE id=? AND tenant_id=?`).bind(id, String(sess.tenantId)).run();
  return { ok: true };
}
async function listLines(db, sess, params) {
  let sql = `SELECT l.*, d.filename AS doc_filename, d.supplier AS doc_supplier FROM acct_statement_lines l
             LEFT JOIN acct_documents d ON d.id = l.document_id
             WHERE l.tenant_id=?`;
  const binds = [String(sess.tenantId)];
  const period = params.get("period"); if (period) { sql += ` AND l.period=?`; binds.push(period); }
  const status = params.get("status"); if (status) { sql += ` AND COALESCE(l.status,'open')=?`; binds.push(status); }
  const docId = params.get("document_id"); if (docId) { sql += ` AND l.document_id=?`; binds.push(Number(docId)); }
  const qs = (params.get("q") || "").trim();
  if (qs) { const l = "%" + qs.toLowerCase() + "%"; sql += ` AND lower(COALESCE(l.description,'')) LIKE ?`; binds.push(l); }
  sql += ` ORDER BY COALESCE(l.line_date,'') DESC, l.id DESC LIMIT 3000`;
  let rows = [];
  try { rows = (await db.prepare(sql).bind(...binds).all()).results || []; } catch { rows = []; }
  const totals = { count: rows.length, open: 0, receipted: 0, excluded: 0, amount: 0, outstanding: 0 };
  for (const r of rows) {
    const st = r.status || "open";
    totals[st === "receipted" ? "receipted" : st === "excluded" ? "excluded" : "open"]++;
    totals.amount += Number(r.amount) || 0;
    if (st === "open") totals.outstanding += Number(r.amount) || 0;
  }
  totals.amount = Math.round(totals.amount * 100) / 100; totals.outstanding = Math.round(totals.outstanding * 100) / 100;
  return { rows, totals };
}
async function updateLine(db, sess, b) {
  const id = Number(b && b.id); if (!id) return { error: "No id" };
  const fields = [], binds = [];
  for (const k of ["status", "notes", "description", "supplier_guess", "receipt_document_id"]) {
    if (b[k] !== undefined) { fields.push(`${k} = ?`); binds.push(b[k] === "" ? null : (k === "receipt_document_id" ? numOrNull(b[k]) : b[k])); }
  }
  if (b.amount !== undefined) { fields.push(`amount = ?`); binds.push(numOrNull(b.amount)); }
  if (b.line_date !== undefined) { fields.push(`line_date = ?`); fields.push(`period = ?`); binds.push(b.line_date || null, vatQuarter(b.line_date)); }
  if (!fields.length) return { ok: true };
  binds.push(id, String(sess.tenantId));
  await db.prepare(`UPDATE acct_statement_lines SET ${fields.join(", ")} WHERE id=? AND tenant_id=?`).bind(...binds).run();
  return { ok: true };
}

// ── Suppliers + subcontractors tick-off, per VAT quarter ──────────────────────
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
async function suppliersChecklist(db, sess, params) {
  const period = (params.get("period") || "").trim() || vatQuarter((/* @__PURE__ */ new Date()).toISOString());
  let sups = [], subs = [];
  try { sups = (await db.prepare(`SELECT name FROM suppliers WHERE active=1 ORDER BY name`).all()).results || []; } catch {}
  try { subs = (await db.prepare(`SELECT name FROM subcontractors WHERE active=1 ORDER BY name`).all()).results || []; } catch {}
  const parties = sups.map(s => ({ name: s.name, kind: "supplier" })).concat(subs.map(s => ({ name: s.name, kind: "subcontractor" })));
  let checks = [];
  try { checks = (await db.prepare(`SELECT party_key, checked, note, checked_by, checked_at FROM acct_supplier_check WHERE tenant_id=? AND period=?`).bind(String(sess.tenantId), period).all()).results || []; } catch {}
  const map = {};
  for (const c of checks) map[c.party_key] = c;
  const rows = parties.map(p => {
    const c = map[normKey(p.name)] || {};
    return { name: p.name, kind: p.kind, key: normKey(p.name), checked: !!Number(c.checked), note: c.note || "", checked_by: c.checked_by || "", checked_at: c.checked_at || "" };
  });
  const done = rows.filter(r => r.checked).length;
  return { period, rows, total: rows.length, done, outstanding: rows.length - done };
}
async function setSupplierCheck(db, sess, b) {
  const period = String(b && b.period || "").trim(); if (!period) return { error: "No period" };
  const name = String(b && b.name || "").trim(); if (!name) return { error: "No name" };
  const key = normKey(name);
  const checked = b.checked ? 1 : 0;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.prepare(`INSERT INTO acct_supplier_check (tenant_id, period, party_key, name, kind, checked, checked_by, checked_at, note)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, period, party_key) DO UPDATE SET
      checked=excluded.checked, checked_by=excluded.checked_by, checked_at=excluded.checked_at,
      note=COALESCE(excluded.note, acct_supplier_check.note), name=excluded.name, kind=excluded.kind`).bind(
    String(sess.tenantId), period, key, name, String(b.kind || "supplier"), checked,
    checked ? userName(sess) : null, checked ? now : null, b.note !== undefined ? (b.note || null) : null
  ).run();
  return { ok: true };
}
