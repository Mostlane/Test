// Cable Calculator — BS 7671 single-circuit cable-sizing / verification.
// Mounted at /cablecalc. Gate: FullAccess | CableCalc.
//   Reference data (cables Iz + mV/A/m, Ca/Cg/Ci factor tables, device max-Zs)
//   lives in app_config `cablecalc:data:<tid>` and is user-managed — the seed
//   below is SAMPLE data, explicitly flagged, to be replaced/verified against
//   the user's own manufacturer datasheets. Config (company/defaults) in
//   `cablecalc:config:<tid>`. Saved calculations in table `cable_calcs`.
//   The calculation itself runs client-side (cable-calc-engine.js); this route
//   stores inputs+results and renders the branded PDF from what the engine
//   produced (one source of numbers, no server/client drift).
import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { buildCableCalcPdf } from "../lib/cablecalcpdf.js";
import { logoBytes } from "../lib/logo.js";

const DATA_KEY = tid => `cablecalc:data:${tid}`;
const CFG_KEY = tid => `cablecalc:config:${tid}`;

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cable_calcs (
    id TEXT PRIMARY KEY, tenant_id TEXT, ref TEXT, title TEXT, client TEXT, site TEXT,
    circuit_ref TEXT, inputs TEXT, results TEXT, engineer TEXT, outcome TEXT,
    created_at TEXT, updated_at TEXT )`).run();
}

async function getConfig(env, tid) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, CFG_KEY(tid)).first();
  const stored = row && row.value ? safeParse(row.value) : {};
  return Object.assign({
    company: "Mostlane", hq: "PO15 5RQ",
    voltage1: 230, voltage3: 400,
    vdLighting: 3, vdPower: 5,
    engineer: "", qualification: ""
  }, stored || {});
}
async function saveKV(env, tid, key, obj) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, key, JSON.stringify(obj)).run();
}
async function getData(env, tid) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, DATA_KEY(tid)).first();
  if (row && row.value) { const d = safeParse(row.value); if (d && d.cables) return d; }
  return SEED;   // sample data (flagged) until the user saves their own
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/cablecalc(?=\/|$)/, "") || "/";
  const q = url.searchParams;
  await ensureTables(env);

  const perms = await permissionsFor(env, tid, me);
  const canUse = perms.FullAccess === "Yes" || perms.CableCalc === "Yes";
  const canManage = perms.FullAccess === "Yes" || perms.CableCalc === "Yes";
  if (!canUse) return error("Cable Calculator access required", 403, env, request);

  // ── reference data ──
  if (sub === "/data") {
    if (method === "GET") return json({ ok: true, data: await getData(env, tid) }, {}, env, request);
    if (method === "POST") {
      if (!canManage) return error("Manage access required", 403, env, request);
      const b = await request.json().catch(() => ({}));
      if (!b || !b.data || !Array.isArray(b.data.cables)) return error("Invalid data", 400, env, request);
      const clean = Object.assign({}, b.data); delete clean.sample;   // saved data is not sample
      await saveKV(env, tid, DATA_KEY(tid), clean);
      return json({ ok: true, data: clean }, {}, env, request);
    }
  }
  if (sub === "/data/reset" && method === "POST") {
    if (!canManage) return error("Manage access required", 403, env, request);
    await env.DB.prepare("DELETE FROM app_config WHERE tenant_id=? AND key=?").bind(tid, DATA_KEY(tid)).run();
    return json({ ok: true, data: SEED }, {}, env, request);
  }

  // ── config ──
  if (sub === "/config") {
    if (method === "GET") return json({ ok: true, config: await getConfig(env, tid) }, {}, env, request);
    if (method === "POST") {
      if (!canManage) return error("Manage access required", 403, env, request);
      const b = await request.json().catch(() => ({}));
      const next = Object.assign(await getConfig(env, tid), b || {});
      await saveKV(env, tid, CFG_KEY(tid), next);
      return json({ ok: true, config: next }, {}, env, request);
    }
  }

  // ── saved calculations ──
  if (sub === "/list" && method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT id,ref,title,client,site,circuit_ref,engineer,outcome,created_at,updated_at FROM cable_calcs WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 200"
    ).bind(tid).all()).results || [];
    return json({ ok: true, calcs: rows }, {}, env, request);
  }
  if (sub === "/one" && method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM cable_calcs WHERE tenant_id=? AND id=?").bind(tid, q.get("id") || "").first();
    if (!row) return error("Not found", 404, env, request);
    return json({ ok: true, calc: shapeCalc(row) }, {}, env, request);
  }
  if (sub === "/save" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const now = new Date().toISOString();
    const id = b.id || ("cc:" + now.replace(/[-:.TZ]/g, "").slice(0, 14) + ":" + Math.random().toString(36).slice(2, 6));
    const rec = b.record || {};
    const inp = rec.inputs || {}, m = rec.meta || {};
    const ref = b.ref || rec.ref || "";
    const outcome = rec.incomplete ? "incomplete" : (rec.pass ? "compliant" : "not-compliant");
    const exists = await env.DB.prepare("SELECT id,created_at FROM cable_calcs WHERE tenant_id=? AND id=?").bind(tid, id).first();
    const created = exists && exists.created_at ? exists.created_at : now;
    await env.DB.prepare(`INSERT INTO cable_calcs
      (id,tenant_id,ref,title,client,site,circuit_ref,inputs,results,engineer,outcome,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ref=excluded.ref,title=excluded.title,client=excluded.client,
        site=excluded.site,circuit_ref=excluded.circuit_ref,inputs=excluded.inputs,results=excluded.results,
        engineer=excluded.engineer,outcome=excluded.outcome,updated_at=excluded.updated_at`)
      .bind(id, tid, ref, m.title || "", m.client || "", m.site || "", inp.circuitRef || "",
        JSON.stringify(inp), JSON.stringify(rec), m.engineer || me, outcome, created, now).run();
    return json({ ok: true, id, ref }, {}, env, request);
  }
  if (sub === "/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare("DELETE FROM cable_calcs WHERE tenant_id=? AND id=?").bind(tid, b.id || "").run();
    return json({ ok: true }, {}, env, request);
  }

  // ── PDF (authed blob; client posts the engine record it produced) ──
  if (sub === "/pdf" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    let rec = b.record;
    if (!rec && b.id) { const row = await env.DB.prepare("SELECT * FROM cable_calcs WHERE tenant_id=? AND id=?").bind(tid, b.id).first(); if (row) rec = shapeCalc(row).results; }
    if (!rec) return error("No calculation supplied", 400, env, request);
    let logo = null; try { logo = logoBytes(); } catch {}
    const bytes = buildCableCalcPdf(rec, { logo });
    return new Response(bytes, { headers: Object.assign({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${(rec.ref || "cable-calc").replace(/[^\w.-]+/g, "_")}.pdf"`,
      "Cache-Control": "no-store"
    }, corsHeaders(env, request)) });
  }

  return error("Not found: " + sub, 404, env, request);
}

function shapeCalc(row) {
  return {
    id: row.id, ref: row.ref, title: row.title, client: row.client, site: row.site,
    circuitRef: row.circuit_ref, engineer: row.engineer, outcome: row.outcome,
    created_at: row.created_at, updated_at: row.updated_at,
    inputs: safeParse(row.inputs) || {}, results: safeParse(row.results) || {}
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   SEED — SAMPLE reference data.  Flagged `sample:true`. These are representative
   commodity cable ratings (the kind printed on any wholesaler/manufacturer
   datasheet), provided so the tool is usable immediately. They are NOT a
   reproduction of the BS 7671 Appendix 4 tables and MUST be replaced/verified
   against the actual manufacturer's data before any report is issued. Method
   keys follow BS 7671 reference-method letters; values are { iz (A), vd (mV/A/m) }.
──────────────────────────────────────────────────────────────────────────── */
const SEED = {
  sample: true,
  note: "SAMPLE DATA — replace/verify against your manufacturer datasheet before issuing any report.",
  cables: [
    {
      id: "pvc-te", name: "70°C thermoplastic twin & earth (6242Y), Cu", conductor: "cu", insulation: "pvc",
      methods: {
        // C = clipped direct; A = enclosed in conduit in insulated wall; 100 = above a plasterboard ceiling
        C: { "1": { iz: 16, vd: 44 }, "1.5": { iz: 20, vd: 29 }, "2.5": { iz: 27, vd: 18 }, "4": { iz: 37, vd: 11 }, "6": { iz: 47, vd: 7.3 }, "10": { iz: 64, vd: 4.4 }, "16": { iz: 85, vd: 2.8 } },
        A: { "1": { iz: 11, vd: 44 }, "1.5": { iz: 14, vd: 29 }, "2.5": { iz: 18.5, vd: 18 }, "4": { iz: 25, vd: 11 }, "6": { iz: 32, vd: 7.3 }, "10": { iz: 43, vd: 4.4 }, "16": { iz: 57, vd: 2.8 } },
        "100": { "1": { iz: 13, vd: 44 }, "1.5": { iz: 16, vd: 29 }, "2.5": { iz: 21, vd: 18 }, "4": { iz: 27, vd: 11 }, "6": { iz: 34, vd: 7.3 }, "10": { iz: 45, vd: 4.4 }, "16": { iz: 57, vd: 2.8 } },
        // "in an insulated wall" columns — empty; fill from your datasheet (or use Method C + Ci)
        "102": {}, "103": {}
      }
    },
    {
      id: "xlpe-te", name: "90°C thermosetting twin & earth (6242B), Cu", conductor: "cu", insulation: "xlpe",
      methods: {
        C: { "1": { iz: 18, vd: 44 }, "1.5": { iz: 23, vd: 29 }, "2.5": { iz: 32, vd: 18 }, "4": { iz: 42, vd: 11 }, "6": { iz: 54, vd: 7.3 }, "10": { iz: 75, vd: 4.4 }, "16": { iz: 100, vd: 2.8 } },
        A: { "1": { iz: 14, vd: 44 }, "1.5": { iz: 18, vd: 29 }, "2.5": { iz: 25, vd: 18 }, "4": { iz: 33, vd: 11 }, "6": { iz: 42, vd: 7.3 }, "10": { iz: 57, vd: 4.4 }, "16": { iz: 76, vd: 2.8 } },
        "100": {}, "102": {}, "103": {}
      }
    },
    {
      id: "swa-xlpe-2c", name: "XLPE/SWA 2-core (6943X), Cu", conductor: "cu", insulation: "xlpe",
      methods: {
        // E = free air / on perforated tray; D = direct buried
        E: { "1.5": { iz: 27, vd: 29 }, "2.5": { iz: 36, vd: 18 }, "4": { iz: 49, vd: 11 }, "6": { iz: 62, vd: 7.3 }, "10": { iz: 85, vd: 4.4 }, "16": { iz: 110, vd: 2.8 }, "25": { iz: 146, vd: 1.75 } },
        D: { "1.5": { iz: 25, vd: 29 }, "2.5": { iz: 33, vd: 18 }, "4": { iz: 43, vd: 11 }, "6": { iz: 53, vd: 7.3 }, "10": { iz: 71, vd: 4.4 }, "16": { iz: 91, vd: 2.8 }, "25": { iz: 116, vd: 1.75 } }
      }
    },
    // Empty scaffolds for the rest of the common range — method columns present so
    // the datasheet importer has a target; fill Iz + mV/A/m from your datasheet.
    { id: "singles-pvc", name: "6491X singles (70°C PVC), Cu", conductor: "cu", insulation: "pvc", methods: { A: {}, B: {}, C: {}, "102": {}, "103": {} } },
    { id: "singles-lszh", name: "6491B singles (90°C LSZH), Cu", conductor: "cu", insulation: "xlpe", methods: { A: {}, B: {}, C: {}, "102": {}, "103": {} } },
    { id: "swa-xlpe-3c", name: "XLPE/SWA 3-core (6944X), Cu", conductor: "cu", insulation: "xlpe", methods: { C: {}, D: {}, E: {} } },
    { id: "swa-xlpe-4c", name: "XLPE/SWA 4-core (6945X), Cu", conductor: "cu", insulation: "xlpe", methods: { C: {}, D: {}, E: {} } }
  ],
  // Ca — ambient temperature correction (by insulation). Keys = °C.
  ambient: {
    pvc: { "25": 1.03, "30": 1.0, "35": 0.94, "40": 0.87, "45": 0.79, "50": 0.71, "55": 0.61 },
    xlpe: { "25": 1.02, "30": 1.0, "35": 0.96, "40": 0.91, "45": 0.87, "50": 0.82, "55": 0.76 }
  },
  // Cg — grouping (number of circuits). Simplified single "default" arrangement.
  grouping: { default: { "1": 1.0, "2": 0.8, "3": 0.7, "4": 0.65, "5": 0.6, "6": 0.57, "7": 0.54, "8": 0.52, "9": 0.5 } },
  // Ci — thermal insulation. Keys are descriptive; "surround" = totally enclosed (523.9).
  insulation: { "50mm": 0.89, "100mm": 0.81, "200mm": 0.68, "400mm": 0.55, "surround": 0.5 },
  // Device max-Zs for non-MCB devices (fuses), by rating, per disconnection time (Ω).
  deviceZs: { "88": {}, "3036": {}, "1361": {} }
};
