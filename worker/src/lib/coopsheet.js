// Co-op job spreadsheet feed — replaces the Zapier step that added each new
// Concerto job as a row on the "Concerto" tab of
//   Mostlane Construction/Admin/Co-op/Concerto Reactive Maintenance.xlsx
// (SharePoint). The office fills in cost / close notes / labour etc. later; we
// write only what the Zap did: row no · order number · store no · type · store
// name · short description · trade · round-trip mileage, plus the sheet's own
// formulas (N, Q, R, S) so the row calculates like the others.
//
// Written through Microsoft Graph with the portal's existing app (GRAPH_*
// secrets) — the app needs the APPLICATION permission Files.ReadWrite.All.
// Never throws: every failure comes back as {ok:false, error}.
import { graphConfigured, graphJson } from "./graphmail.js";
import { classifyWork } from "./worktypes.js";

const DEFAULTS = {
  enabled: true,
  driveId: "b!NpDXAs0EE0OL71TDQZYd-bdykHFlnd9FjsgSt11fwgt0jcCyS10IR5OEI-3NYzYC",
  itemId: "01SR6ZRFZSTGBV7G2BEZGJN6JXZHXELVHD",
  sheet: "Concerto",
};
const HQ_PC = "PO15 5RQ";
const KEY = tid => "coopsheet:" + (Math.trunc(Number(tid)) || 1);

export async function getSheetConfig(env, tid) {
  try {
    const r = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(KEY(tid)).first();
    if (r && r.value) return { ...DEFAULTS, ...JSON.parse(r.value) };
  } catch {}
  return { ...DEFAULTS };
}

// "00032141/1" → "32141/1" (how the sheet writes them).
export function sheetOrderNo(ref) {
  const m = String(ref || "").trim().match(/^0*(\d+)(\/\d+)?/);
  return m ? m[1] + (m[2] || "") : String(ref || "").trim();
}
function sameOrder(a, b) { return sheetOrderNo(a).toLowerCase() === sheetOrderNo(b).toLowerCase(); }

// One readable line from a Concerto description: drop the "Windows : Cracked
// (R, E) - " tag, "Observation:" lead-ins and the ACCESS TIMES / Recommendation
// tails, keep the first sentence, ≤ 70 characters on a word boundary.
export function shortDescription(desc) {
  let t = String(desc || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:Fault\/Issue:\s*)?[^-:]{1,60}:[^-]{1,60}\([^)]*\)\s*-\s*/i, "");
  t = t.replace(/^(?:Observation|Issue|Fault|Description)\s*:\s*/i, "");
  t = t.split(/\s*(?:ACCESS TIMES?|Recommendation|Access)\s*:/i)[0].trim();
  const first = (t.match(/^.*?[.!?](?=\s|$)/) || [t])[0].trim();
  if (first.length >= 12) t = first;
  if (t.length > 70) t = t.slice(0, 70).replace(/\s+\S*$/, "").replace(/[,;:\-\s]+$/, "") + "…";
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t && !/[.!?…]$/.test(t) ? t + "." : t;
}

// The sheet's trade words: Drainage / Electrician / Plumbing / Glazing / MT.
export function sheetTrade(desc) {
  let w = null; try { w = classifyWork(String(desc || "")); } catch {}
  if (!w) return "MT (Multi-trade)";
  if (w.group === "Drainage") return "Drainage";
  if (w.group === "Electrical") return "Electrician";
  if (w.group === "Plumbing & water") return "Plumbing";
  if (/glaz/i.test(w.name || "") || /glaz/i.test(w.id || "")) return "Glazing";
  return "MT (Multi-trade)";
}

const TYPE_LABEL = { retail: "Retail", els: "ELS", els_private: "ELS", cobra: "COBRA", wenzels: "Wenzels" };

// Round-trip miles from HQ: the site-mileage register first, else Google
// driving distance × 2 (what the Zap recorded). Blank when neither answers.
async function roundTripMiles(env, tid, siteName, postcode) {
  const key = String(siteName || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (key) {
    try {
      const r = await env.DB.prepare("SELECT miles FROM site_miles WHERE tenant_id=? AND key=?").bind(Math.trunc(Number(tid)) || 1, key).first();
      if (r && r.miles != null && Number(r.miles) > 0) return Math.round(Number(r.miles) * 10) / 10;
    } catch {}
  }
  const pc = String(postcode || "").replace(/[^A-Za-z0-9 ]/g, "").trim();
  if (pc && env.GOOGLE_MAPS_KEY) {
    try {
      const u = "https://maps.googleapis.com/maps/api/distancematrix/json?origins=" + encodeURIComponent(HQ_PC)
        + "&destinations=" + encodeURIComponent(pc) + "&mode=driving&units=imperial&key=" + encodeURIComponent(env.GOOGLE_MAPS_KEY);
      const d = await (await fetch(u)).json();
      const el = d && d.status === "OK" && d.rows && d.rows[0] && d.rows[0].elements && d.rows[0].elements[0];
      if (el && el.status === "OK") return Math.round((el.distance.value / 1609.344) * 2 * 10) / 10;
    } catch {}
  }
  return "";
}

// Everything the row needs, from a job (or the email's fields).
export async function rowInfo(env, tid, { reference, siteCode, siteName, postcode, description }) {
  let site = null;
  const code = String(siteCode || "").trim();
  if (/^\d+$/.test(code)) {
    try {
      site = await env.DB.prepare("SELECT site_number, site_name, client, postcode FROM sites WHERE CAST(site_number AS INTEGER)=? ORDER BY length(site_number) DESC LIMIT 1").bind(Number(code)).first();
    } catch {}
  }
  const name = (site && site.site_name) || String(siteName || "").replace(/^\s*\d{3,4}\s*[-–]\s*/, "").trim();
  const pc = (site && site.postcode) || postcode || "";
  return {
    order: sheetOrderNo(reference),
    storeNo: /^\d+$/.test(code) ? code.padStart(4, "0") : code,
    type: (site && TYPE_LABEL[String(site.client || "").toLowerCase()]) || "Retail",
    name,
    desc: shortDescription(description),
    trade: sheetTrade(description),
    miles: await roundTripMiles(env, tid, name, pc),
  };
}

const colLetter = i => String.fromCharCode(65 + i);
function sheetBase(cfg) {
  return `/drives/${encodeURIComponent(cfg.driveId)}/items/${encodeURIComponent(cfg.itemId)}/workbook/worksheets('${encodeURIComponent(cfg.sheet)}')`;
}

// Read the sheet: header row, the next free row, the next "we" number, and
// whether the order is already on it. Read-only.
export async function inspectSheet(env, tid, order) {
  if (!graphConfigured(env)) return { ok: false, error: "Microsoft 365 connection isn't set up (GRAPH_* secrets missing)" };
  const cfg = await getSheetConfig(env, tid);
  try {
    const ur = await graphJson(env, "GET", sheetBase(cfg) + "/usedRange(valuesOnly=true)?$select=address,rowIndex,values");
    const vals = (ur && ur.values) || [], top = Number(ur && ur.rowIndex) || 0;
    const h = vals.findIndex(r => String(r[1] || "").trim().toLowerCase() === "order number");
    if (h < 0) return { ok: false, error: "Couldn't find the 'Order Number' heading on the " + cfg.sheet + " tab" };
    let target = -1, maxWe = 0, lastOrder = "", existsRow = 0;
    for (let i = h + 1; i < vals.length; i++) {
      const r = vals[i];
      const blank = !String(r[1] || "").trim() && !String(r[4] || "").trim() && !String(r[5] || "").trim();
      if (blank) { if (target < 0) target = i; continue; }
      if (target < 0) { const we = Number(r[0]); if (Number.isFinite(we) && we > maxWe) maxWe = we; lastOrder = String(r[1] || ""); }
      if (order && !existsRow && sameOrder(r[1], order)) existsRow = top + i + 1;
    }
    if (target < 0) target = vals.length;
    return { ok: true, cfg, nextRow: top + target + 1, nextWe: maxWe + 1, lastOrder, existsRow };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 300), status: e && e.status };
  }
}

// Add one job's row. Skips an order already on the sheet (so a re-run, or a row
// the office typed by hand, never doubles up). dryRun reports without writing.
export async function appendCoopSheetRow(env, tid, job, { dryRun = false } = {}) {
  try {
    const cfg = await getSheetConfig(env, tid);
    if (!cfg.enabled) return { ok: false, skipped: true, error: "spreadsheet feed is switched off" };
    const info = await rowInfo(env, tid, job);
    if (!info.order) return { ok: false, error: "no order number" };
    const at = await inspectSheet(env, tid, info.order);
    if (!at.ok) return at;
    if (at.existsRow) return { ok: true, skipped: true, row: at.existsRow, info, reason: "already on the sheet (row " + at.existsRow + ")" };
    const r = at.nextRow;
    const row = [
      at.nextWe, info.order, info.storeNo ? "'" + info.storeNo : "", info.type, info.name, info.desc,
      "", "", "", info.trade, "", "", info.miles === "" ? "" : info.miles,
      `=SUM(M${r}*0.5)`, "", "", `=SUM(P${r}*0.18)`, `=SUM(N${r},O${r},P${r},Q${r})`, `=SUM(G${r}-R${r})`, "", "",
    ];
    if (dryRun) return { ok: true, dryRun: true, row: r, info, values: row };
    await graphJson(env, "PATCH", sheetBase(cfg) + `/range(address='A${r}:${colLetter(row.length - 1)}${r}')`, { formulas: [row] });
    return { ok: true, row: r, info };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 300) };
  }
}
