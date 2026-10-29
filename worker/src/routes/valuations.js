// Valuation sheets — a progressively-built, line-item valuation document (the
// "applications for payment" sheet Jamie used to keep in Excel). Each row is a
// work ITEM with a contract cost; each VALUATION (a column) records the amount
// taken this time per item; the sheet totals what's been certified to date,
// what's remaining, completion %, and (where it applies) retention held on the
// final account. Modelled on routes/programmes.js: a living working document the
// office edits, with an AI draft-from-a-document builder and PDF/Excel export.
// Tied into projects (links.valuationId). No client share links — internal only.
//
//   Tables (self-migrating): valuations
//   Routes (gate FullAccess | Valuations):
//     GET  /val/list                 library
//     GET  /val/one?id=              one sheet (+ project list for linking)
//     POST /val/save                 upsert (optimistic concurrency, like /prog/save)
//     POST /val/delete               remove
//     POST /val/ai-draft             items from an uploaded spec / pasted text
//     POST /val/export               PDF of the sheet (Excel is built client-side)

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { buildValuationPdf } from "../lib/valuationpdf.js";
import { onceMigration } from "../lib/once.js";

const MAX_DATA_BYTES = 400 * 1024;

async function ensureTables__raw(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS valuations (
    id TEXT PRIMARY KEY, tenant_id TEXT, ref TEXT, title TEXT, client TEXT,
    project_id TEXT, status TEXT DEFAULT 'live', data TEXT,
    created_by TEXT, created_at TEXT, updated_at TEXT, updated_by TEXT)`).run();
}
const ensureTables = onceMigration(ensureTables__raw);

function newId(prefix) {
  return prefix + "-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}
function cleanData(raw) {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw || {});
  if (s.length > MAX_DATA_BYTES) return { error: "Valuation sheet too large" };
  let d; try { d = JSON.parse(s); } catch { return { error: "Bad valuation data" }; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { error: "Bad valuation data" };
  return { json: JSON.stringify(d), obj: d };
}

// Next VAL-#### number (per tenant, stored in app_config so concurrent creates
// don't collide). Starts at 1.
async function nextRef(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='val:seq'").bind(db.tenantId).first();
  let n = 1; try { n = Math.max(1, parseInt(row?.value, 10) || 0) + (row ? 1 : 0); if (!row) n = 1; } catch { n = 1; }
  // Guard against a gap: also beat any existing ref.
  try {
    const mx = await db.prepare("SELECT ref FROM valuations WHERE tenant_id=? AND ref LIKE 'VAL-%'").bind(db.tenantId).all();
    for (const r of (mx.results || [])) { const m = /VAL-(\d+)/.exec(r.ref || ""); if (m) n = Math.max(n, parseInt(m[1], 10) + 1); }
  } catch {}
  await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'val:seq', ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value=?")
    .bind(db.tenantId, String(n), String(n)).run();
  return "VAL-" + String(n).padStart(4, "0");
}

async function gate(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { code: 401, error: "Not authenticated" };
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.Valuations !== "Yes") return { code: 403, error: "Forbidden" };
  return { sess };
}

// ── Compute the whole sheet from its data (shared by the PDF + Excel; the builder
// mirrors this in JS). RETENTION is PER-JOB (Jamie: "not all jobs which have
// valuations have a retention… job by job whether bits are needed or not"): a sheet
// carries an explicit **`data.hasRetention`** toggle. When OFF, no retention is ever
// applied; when ON it's the standard UK two-rate "moiety" model (the same one the
// job-costing engine uses, costing.js computeFin):
//   • every INTERIM valuation holds `retentionPct`% (default 5) of the cumulative
//     value certified to date;
//   • the FINAL account RELEASES all that interim retention and instead holds
//     `finalRetentionPct`% (default 2.5 — the other half, released after the
//     defects period) of the CONTRACT value.
// So net-due on the final account naturally "adds back" the interim retention and
// then deducts the 2.5%. A NEW sheet defaults hasRetention:false (the office ticks
// it on per job); legacy sheets with no toggle fall back to "on if a rate is set".
// Each column exposes retHeld (held AT that valuation), interimAccrued (5% to date)
// and released (interim retention given back, non-zero only on the final account) so
// the bubbles/PDF can show the release → 2.5%-held calculation. ─────────────────
export function computeValuation(data) {
  data = data || {};
  const clampPct = (v, d) => { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(100, n)) : d; };
  const interimPct = clampPct(data.retentionPct, 5);
  // finalRetentionPct defaults to half the interim rate (5 → 2.5) when not set.
  const finalPct = clampPct(data.finalRetentionPct, interimPct / 2);
  // Per-job toggle: explicit true/false wins; legacy sheets (no toggle) = on if a
  // positive interim rate was stored.
  const hasRetention = data.hasRetention === true ? true
    : data.hasRetention === false ? false
    : clampPct(data.retentionPct, 0) > 0;
  const retOn = hasRetention && (interimPct > 0 || finalPct > 0);
  const cols = Array.isArray(data.columns) ? data.columns : [];
  const items = Array.isArray(data.items) ? data.items : [];
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

  let contractTotal = 0, grandGross = 0;
  const perItem = items.map(it => {
    const cost = num(it.cost);
    const amounts = (it && it.amounts) || {};
    let taken = 0;
    for (const c of cols) taken += num(amounts[c.id]);
    contractTotal += cost; grandGross += taken;
    return { id: it.id, desc: it.desc || "", cost, extra: !!it.extra, amounts, taken,
             remaining: cost - taken, pct: cost ? taken / cost : 0 };
  });

  // The final-account retention is held on the contract value where one is set,
  // else on the gross certified (a sheet with no item costs yet).
  const retBase = contractTotal > 0 ? contractTotal : grandGross;

  let grossCum = 0, prevNetCum = 0;
  const perCol = cols.map(c => {
    let gross = 0; for (const it of items) gross += num((it.amounts || {})[c.id]);
    grossCum += gross;
    const isFinal = !!c.final;
    const interimAccrued = retOn ? (interimPct / 100) * grossCum : 0; // 5% held to date
    // On the final account: release the interim retention, hold the final % instead.
    const retHeld = !retOn ? 0 : (isFinal ? (finalPct / 100) * retBase : interimAccrued);
    const released = (retOn && isFinal) ? interimAccrued : 0; // interim retention added back at final
    const netCum = grossCum - retHeld;
    const dueThis = netCum - prevNetCum;
    prevNetCum = netCum;
    return { id: c.id, name: c.name || "", date: c.date || "", note: c.note || "", final: isFinal,
             gross, grossCum, interimAccrued, retHeld, released, netCum, dueThis };
  });

  const lastCol = perCol[perCol.length - 1] || null;
  const hasFinal = cols.some(c => c.final);
  return {
    retentionPct: interimPct, finalRetentionPct: finalPct, hasRetention, retentionOn: retOn, hasFinal, retBase,
    contractTotal, grandGross,
    remaining: contractTotal - grandGross,
    completion: contractTotal ? grandGross / contractTotal : 0,
    retentionHeld: lastCol ? lastCol.retHeld : 0,
    netCertified: lastCol ? lastCol.netCum : 0,
    perItem, perCol,
  };
}

export async function handle(request, env, ctx, url) {
  const cors = corsHeaders(env, request);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();
  const tenantId = await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });
  await ensureTables(env);

  const g = await gate(env, request);
  if (g.error) return json({ ok: false, error: g.error }, g.code);
  const me = g.sess.user.username;

  if (method === "GET" && pathname === "/val/list") {
    const { results } = await db.prepare(
      "SELECT id, ref, title, client, project_id, status, created_by, created_at, updated_at, updated_by, data FROM valuations WHERE tenant_id=? ORDER BY updated_at DESC"
    ).bind(db.tenantId).all();
    const rows = (results || []).map(r => {
      let data = {}; try { data = JSON.parse(r.data); } catch {}
      const comp = computeValuation(data);
      return {
        id: r.id, ref: r.ref, title: r.title, client: r.client, projectId: r.project_id || "",
        status: r.status || "live", createdBy: r.created_by, createdAt: r.created_at,
        updatedAt: r.updated_at, updatedBy: r.updated_by || "",
        valuations: (data.columns || []).length,
        contractTotal: comp.contractTotal, grandGross: comp.grandGross, completion: comp.completion,
      };
    });
    return json({ ok: true, valuations: rows });
  }

  if (method === "GET" && pathname === "/val/one") {
    const id = searchParams.get("id") || "";
    const r = await db.prepare("SELECT * FROM valuations WHERE id=? AND tenant_id=?").bind(id, db.tenantId).first();
    if (!r) return json({ ok: false, error: "Valuation not found" }, 404);
    let data = {}; try { data = JSON.parse(r.data); } catch {}
    // Projects the office can link this sheet to (for the "tie to a project" picker).
    let projects = [];
    try {
      const pr = await db.prepare("SELECT id, number, name, status FROM projects WHERE tenant_id=? AND status<>'archived' ORDER BY number DESC LIMIT 400").bind(db.tenantId).all();
      projects = (pr.results || []).map(p => ({ id: p.id, number: p.number, name: p.name, status: p.status }));
    } catch {}
    return json({
      ok: true,
      val: {
        id: r.id, ref: r.ref, title: r.title, client: r.client, projectId: r.project_id || "",
        status: r.status || "live", createdBy: r.created_by, createdAt: r.created_at,
        updatedAt: r.updated_at, updatedBy: r.updated_by || "", data,
      },
      projects,
    });
  }

  if (method === "POST" && pathname === "/val/save") {
    const b = await request.json().catch(() => ({}));
    const c = cleanData(b.data);
    if (c.error) return json({ ok: false, error: c.error }, 400);
    const now = new Date().toISOString();
    const title = String(b.title ?? c.obj.title ?? "").slice(0, 200) || "Untitled valuation";
    const client = String(b.client ?? c.obj.client ?? "").slice(0, 200);
    const projectId = String(b.projectId ?? c.obj.projectId ?? "").slice(0, 80);
    const status = ["live", "complete", "archived"].includes(String(b.status)) ? b.status : undefined;
    let id = String(b.id || "").trim();
    if (id) {
      const row = await db.prepare("SELECT id, updated_at, updated_by, status FROM valuations WHERE id=? AND tenant_id=?").bind(id, db.tenantId).first();
      if (!row) return json({ ok: false, error: "Valuation not found" }, 404);
      // Optimistic concurrency — refuse a save over another device's edit.
      if (b.baseVersion !== undefined && String(b.baseVersion) !== String(row.updated_at || "")) {
        return json({ ok: false, conflict: true, error: "This valuation was changed on another device.", updatedAt: row.updated_at, updatedBy: row.updated_by || "" }, 409);
      }
      await db.prepare(
        "UPDATE valuations SET title=?, client=?, project_id=?, status=?, data=?, updated_at=?, updated_by=? WHERE id=? AND tenant_id=?"
      ).bind(title, client, projectId, status || row.status || "live", c.json, now, me, id, db.tenantId).run();
    } else {
      id = newId("VS");
      const ref = String(b.ref || "").trim() || await nextRef(db);
      await db.prepare(`INSERT INTO valuations (id, tenant_id, ref, title, client, project_id, status, data, created_by, created_at, updated_at, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, db.tenantId, ref, title, client, projectId, status || "live", c.json, me, now, now, me).run();
      return json({ ok: true, id, ref, updatedAt: now });
    }
    return json({ ok: true, id, updatedAt: now });
  }

  // The valuation sheet tied to a project (newest), for the project-hub button.
  if (method === "GET" && pathname === "/val/for-project") {
    const pid = searchParams.get("projectId") || "";
    if (!pid) return json({ ok: true, id: null });
    const r = await db.prepare("SELECT id, ref FROM valuations WHERE tenant_id=? AND project_id=? ORDER BY updated_at DESC LIMIT 1").bind(db.tenantId, pid).first();
    return json({ ok: true, id: r ? r.id : null, ref: r ? r.ref : "" });
  }

  if (method === "POST" && pathname === "/val/delete") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "").trim();
    if (!id) return json({ ok: false, error: "id required" }, 400);
    await db.prepare("DELETE FROM valuations WHERE id=? AND tenant_id=?").bind(id, db.tenantId).run();
    return json({ ok: true });
  }

  // ── AI: build the item list from a specification / scope / schedule of works ──
  // The client extracts the document TEXT in the browser (PDF.js / xlsx-lite /
  // plain text) and posts it; a scanned PDF rides as base64 for Claude's own OCR.
  // We return items (+ optional costs) and materialise a brand-new sheet.
  if (method === "POST" && pathname === "/val/ai-draft") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return json({ ok: false, error: "AI drafting isn't switched on yet. Add the ANTHROPIC_API_KEY secret to the mostlane-api worker in the Cloudflare dashboard, then hit Deploy." }, 400);
    const b = await request.json().catch(() => ({}));
    const notes = String(b.notes || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 4000);
    let text = String(b.text || "").replace(/\u0000/g, "").trim();
    let pdfB64 = String(b.pdfBase64 || "").replace(/\s+/g, "");
    if (pdfB64 && !/^[A-Za-z0-9+/=]+$/.test(pdfB64)) pdfB64 = "";
    const MAX_PDF_B64 = 9 * 1024 * 1024;
    if (pdfB64.length > MAX_PDF_B64) return json({ ok: false, error: "That PDF is too big to read directly (over ~6 MB). Try a smaller file, or paste the text in." }, 400);
    if (text.length < 40 && notes.length < 40 && !pdfB64) return json({ ok: false, error: "There wasn't enough to work from. Upload a document, or describe the works in the notes box." }, 400);
    const MAX_TEXT = 120000;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    const hintTitle = String(b.title || "").slice(0, 200);

    const schema = {
      type: "object",
      properties: {
        title: { type: "string", description: "A short title for the valuation, usually the project / site name." },
        items: {
          type: "array",
          description: "Each distinct work item / line from the schedule of works or scope, in order.",
          items: {
            type: "object",
            properties: {
              desc: { type: "string", description: "The work item description, kept faithful to the source." },
              cost: { type: "number", description: "The item's contract value in GBP ex-VAT, if the document gives one (else 0)." },
            },
            required: ["desc"],
          },
        },
      },
      required: ["items"],
    };
    const sys = "You are a UK construction quantity surveyor's assistant building a VALUATION sheet (an interim application for payment). "
      + "From the supplied schedule of works / specification / scope, extract each distinct work ITEM as a line, keeping the wording faithful to the source, and the item's contract value (GBP, ex-VAT) when the document states a price next to it. "
      + "Preserve the order. Include preliminaries/prelims as their own item if present. Do NOT invent prices — use 0 when none is given. Return every real item (there may be many). "
      + "If the user gave instructions below, follow them (they override the document).";
    let userMsg = "";
    if (notes) userMsg += "INSTRUCTIONS (follow these, they override the document):\n" + notes + "\n\n";
    if (pdfB64) { userMsg += "The attached PDF is the schedule of works / scope" + (hintTitle ? ` for ${hintTitle}.` : "."); if (text) userMsg += "\n\nAny text already read from it:\n" + text; }
    else { userMsg += "SCHEDULE OF WORKS / SCOPE" + (hintTitle ? ` for ${hintTitle}` : "") + ":\n\n" + text; }
    const userContent = pdfB64
      ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } }, { type: "text", text: userMsg }]
      : userMsg;

    const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
    let apiResp;
    try {
      apiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 8000, system: sys,
          tools: [{ name: "build_valuation", description: "Return the valuation items.", input_schema: schema }],
          tool_choice: { type: "tool", name: "build_valuation" },
          messages: [{ role: "user", content: userContent }] }),
      });
    } catch (e) { return json({ ok: false, error: "Couldn't reach the AI service. Try again in a moment." }, 502); }
    if (!apiResp.ok) {
      let detail = ""; try { const j = await apiResp.json(); detail = j?.error?.message || ""; } catch {}
      if (apiResp.status === 401 || apiResp.status === 403) return json({ ok: false, error: "The AI key was rejected. Check the ANTHROPIC_API_KEY secret on the worker." }, 400);
      if (apiResp.status === 404 && /model/i.test(detail)) return json({ ok: false, error: `The AI model "${model}" isn't available on this key. Set ANTHROPIC_MODEL on the worker to one you can use.` }, 400);
      return json({ ok: false, error: "The AI service returned an error" + (detail ? ": " + detail : ".") }, 502);
    }
    let payload; try { payload = await apiResp.json(); } catch { return json({ ok: false, error: "The AI service returned an unreadable response." }, 502); }
    const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === "build_valuation") : null;
    if (!block?.input) return json({ ok: false, error: "The AI didn't return a usable result." }, 422);
    const out = block.input;
    const items = (Array.isArray(out.items) ? out.items : []).slice(0, 400).map((it, i) => ({
      id: "it" + Date.now().toString(36) + i, desc: String(it.desc || "").slice(0, 1000),
      cost: Math.max(0, Number(it.cost) || 0), extra: false, amounts: {},
    })).filter(it => it.desc);
    if (!items.length) return json({ ok: false, error: "The AI didn't find any work items in that document." }, 422);
    // One opening valuation column so the sheet is ready to fill.
    const col = { id: "c" + Date.now().toString(36), name: "Valuation 1", date: "", note: "", final: false };
    const data = {
      title: String(out.title || hintTitle || "Valuation").slice(0, 200),
      client: String(b.client || "").slice(0, 200),
      projectNumber: "", hasRetention: false, retentionPct: 5, finalRetentionPct: 2.5, vatRate: 20,
      columns: [col], currentColumnId: col.id, items,
    };
    const now = new Date().toISOString();
    const id = newId("VS");
    const ref = await nextRef(db);
    await db.prepare(`INSERT INTO valuations (id, tenant_id, ref, title, client, project_id, status, data, created_by, created_at, updated_at, updated_by)
      VALUES (?,?,?,?,?,?, 'live', ?,?,?,?,?)`).bind(id, db.tenantId, ref, data.title, data.client, "", JSON.stringify(data), me, now, now, me).run();
    return json({ ok: true, id, ref, items: items.length });
  }

  // ── PDF export of the sheet ───────────────────────────────────────────────
  if (method === "POST" && pathname === "/val/export") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "").trim();
    const r = await db.prepare("SELECT * FROM valuations WHERE id=? AND tenant_id=?").bind(id, db.tenantId).first();
    if (!r) return json({ ok: false, error: "Valuation not found" }, 404);
    let data = {}; try { data = JSON.parse(r.data); } catch {}
    const bytes = buildValuationPdf(data, { title: r.title, client: r.client, ref: r.ref, projectNumber: data.projectNumber });
    return new Response(bytes, { status: 200, headers: {
      ...cors, "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${String((r.title || "Valuation") + " - " + (r.ref || "")).replace(/[^\w .\-()]/g, "_")}.pdf"`,
      "Cache-Control": "no-store" } });
  }

  return json({ ok: false, error: "Not found" }, 404);
}
