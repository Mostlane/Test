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
import { graphConfigured, graphJson, graphBatch } from "./graphmail.js";
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

// The Zap wrote a short AI summary (≈6 words, "Bakery sink discharges brown
// dirty water."). Do the same; fall back to shortDescription without a key.
export async function aiShortDescription(env, desc) {
  const text = String(desc || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!text || !env.ANTHROPIC_API_KEY) return shortDescription(desc);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || "claude-sonnet-5", max_tokens: 60,
        messages: [{ role: "user", content: "Summarise this building-maintenance fault in 4 to 8 plain words for a spreadsheet, ending with a full stop. Say what is wrong, not where or when. No quotes, no store names, no access times.\n\n" + text }],
      }),
    });
    if (r.ok) {
      const j = await r.json();
      let t = String((j.content || []).map(c => c.text || "").join(" ")).replace(/\s+/g, " ").replace(/^["'“]+|["'”]+$/g, "").trim();
      if (t && t.length <= 90) { t = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(t) ? t : t + "."; }
    }
  } catch {}
  return shortDescription(desc);
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
  const emailName = String(siteName || "").replace(/^\s*\d{3,4}\s*[-–]\s*/, "").trim();
  const portalName = String((site && site.site_name) || "").replace(/^\s*\d{3,4}\s*[-–]\s*/, "").trim();
  const name = emailName || portalName;
  const pc = (site && site.postcode) || postcode || "";
  let miles = await roundTripMiles(env, tid, portalName || name, pc);
  if (miles === "" && emailName && emailName !== portalName) miles = await roundTripMiles(env, tid, emailName, "");
  return {
    order: sheetOrderNo(reference),
    storeNo: /^\d+$/.test(code) ? code.padStart(4, "0") : code,
    type: (site && TYPE_LABEL[String(site.client || "").toLowerCase()]) || "Retail",
    name,
    desc: await aiShortDescription(env, description),
    trade: sheetTrade(description),
    miles,
  };
}

const colLetter = i => String.fromCharCode(65 + i);
function sheetBase(cfg) {
  return `/drives/${encodeURIComponent(cfg.driveId)}/items/${encodeURIComponent(cfg.itemId)}/workbook/worksheets('${encodeURIComponent(cfg.sheet)}')`;
}

// Read the sheet: header row, the next free row, the next "we" number, and
// whether the order is already on it (with that row's values). Read-only.
export async function inspectSheet(env, tid, order) {
  if (!graphConfigured(env)) return { ok: false, error: "Microsoft 365 connection isn't set up (GRAPH_* secrets missing)" };
  const cfg = await getSheetConfig(env, tid);
  try {
    const ur = await graphJson(env, "GET", sheetBase(cfg) + "/usedRange(valuesOnly=true)?$select=address,rowIndex,values");
    const vals = (ur && ur.values) || [], top = Number(ur && ur.rowIndex) || 0;
    const h = vals.findIndex(r => String(r[1] || "").trim().toLowerCase() === "order number");
    if (h < 0) return { ok: false, error: "Couldn't find the 'Order Number' heading on the " + cfg.sheet + " tab" };
    let target = -1, maxWe = 0, lastOrder = "", existsRow = 0, existsVals = null;
    for (let i = h + 1; i < vals.length; i++) {
      const r = vals[i];
      const blank = !String(r[1] || "").trim() && !String(r[4] || "").trim() && !String(r[5] || "").trim();
      if (blank) { if (target < 0) target = i; continue; }
      if (target < 0) { const we = Number(r[0]); if (Number.isFinite(we) && we > maxWe) maxWe = we; lastOrder = String(r[1] || ""); }
      if (order && !existsRow && sameOrder(r[1], order)) { existsRow = top + i + 1; existsVals = r; }
    }
    if (target < 0) target = vals.length;
    return { ok: true, cfg, nextRow: top + target + 1, nextWe: maxWe + 1, lastOrder, existsRow, existsVals, headerRow: top + h + 1 };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 300), status: e && e.status };
  }
}

const COLS = 21; // A..U
const formulasFor = r => ({ 13: `=SUM(M${r}*0.5)`, 16: `=SUM(P${r}*0.18)`, 17: `=SUM(N${r},O${r},P${r},Q${r})`, 18: `=SUM(G${r}-R${r})` });

// Make row `dst` look like row `src`: number formats, font, fill, alignment and
// cell borders, cell by cell (the office's rows have outlines + colouring that
// a plain value write doesn't carry). Best-effort — never throws.
export async function copyRowFormat(env, cfg, src, dst) {
  try {
    const base = sheetBase(cfg);
    const cell = (c, r) => `${base}/range(address='${colLetter(c)}${r}')`;
    const gets = [{ method: "GET", url: `${base}/range(address='A${src}:${colLetter(COLS - 1)}${src}')?$select=numberFormat` }];
    for (let c = 0; c < COLS; c++) {
      gets.push({ method: "GET", url: cell(c, src) + "/format?$select=horizontalAlignment,verticalAlignment,wrapText" });
      gets.push({ method: "GET", url: cell(c, src) + "/format/fill" });
      gets.push({ method: "GET", url: cell(c, src) + "/format/font" });
      gets.push({ method: "GET", url: cell(c, src) + "/format/borders" });
    }
    const res = await graphBatch(env, gets, { sequential: false });
    const writes = [];
    const nf = res[0] && res[0].status < 300 && res[0].body && res[0].body.numberFormat;
    if (Array.isArray(nf) && nf[0]) writes.push({ method: "PATCH", url: `${base}/range(address='A${dst}:${colLetter(COLS - 1)}${dst}')`, body: { numberFormat: [nf[0]] } });
    for (let c = 0; c < COLS; c++) {
      const [fm, fill, font, bord] = res.slice(1 + c * 4, 5 + c * 4).map(x => (x && x.status < 300 ? x.body : null));
      if (fm) writes.push({ method: "PATCH", url: cell(c, dst) + "/format", body: { horizontalAlignment: fm.horizontalAlignment, verticalAlignment: fm.verticalAlignment, wrapText: !!fm.wrapText } });
      if (fill && fill.color && !/^#?FFFFFF$/i.test(fill.color)) writes.push({ method: "PATCH", url: cell(c, dst) + "/format/fill", body: { color: fill.color } });
      if (font) {
        const f = {}; for (const k of ["name", "size", "color", "bold", "italic", "underline"]) if (font[k] != null) f[k] = font[k];
        writes.push({ method: "PATCH", url: cell(c, dst) + "/format/font", body: f });
      }
      for (const b of (bord && bord.value) || []) {
        if (!/^Edge(Top|Bottom|Left|Right)$/.test(b.sideIndex || "") || !b.style || b.style === "None") continue;
        const body = { style: b.style }; if (b.color) body.color = b.color; if (b.weight) body.weight = b.weight;
        writes.push({ method: "PATCH", url: cell(c, dst) + `/format/borders/${b.sideIndex}`, body });
      }
    }
    if (!writes.length) return { ok: false, error: "nothing read from row " + src };
    const out = await graphBatch(env, writes, { sequential: true });
    const bad = out.filter(o => !(o.status >= 200 && o.status < 300)).length;
    return { ok: bad === 0, applied: writes.length - bad, failed: bad };
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
}

// Add one job's row. If the order is already on the sheet (re-run, or typed by
// the office) nothing typed is ever overwritten — only BLANK trade / mileage /
// formula cells are filled. dryRun reports without writing.
export async function appendCoopSheetRow(env, tid, job, { dryRun = false } = {}) {
  try {
    const cfg = await getSheetConfig(env, tid);
    if (!cfg.enabled) return { ok: false, skipped: true, error: "spreadsheet feed is switched off" };
    const info = await rowInfo(env, tid, job);
    if (!info.order) return { ok: false, error: "no order number" };
    const at = await inspectSheet(env, tid, info.order);
    if (!at.ok) return at;

    if (at.existsRow) {
      const r = at.existsRow, ev = at.existsVals || [];
      const blank = c => ev[c] == null || String(ev[c]).trim() === "";
      const fills = {};
      if (blank(9) && info.trade) fills[9] = info.trade;
      if (blank(12) && info.miles !== "") fills[12] = info.miles;
      const fx = formulasFor(r); for (const c of Object.keys(fx)) if (blank(+c)) fills[c] = fx[c];
      const cols = Object.keys(fills).map(Number);
      if (!cols.length) return { ok: true, skipped: true, row: r, info, reason: "already on the sheet (row " + r + ")" };
      if (dryRun) return { ok: true, dryRun: true, row: r, info, filled: fills };
      await graphBatch(env, cols.map(c => ({ method: "PATCH", url: sheetBase(cfg) + `/range(address='${colLetter(c)}${r}')`, body: { formulas: [[fills[c]]] } })));
      const fmt = r > at.headerRow + 1 ? await copyRowFormat(env, cfg, r - 1, r) : null;
      return { ok: true, filled: true, row: r, info, cols: cols.map(colLetter), format: fmt };
    }

    const r = at.nextRow, fx = formulasFor(r);
    const row = [
      at.nextWe, info.order, info.storeNo ? "'" + info.storeNo : "", info.type, info.name, info.desc,
      "", "", "", info.trade, "", "", info.miles === "" ? "" : info.miles,
      fx[13], "", "", fx[16], fx[17], fx[18], "", "",
    ];
    if (dryRun) return { ok: true, dryRun: true, row: r, info, values: row };
    await graphJson(env, "PATCH", sheetBase(cfg) + `/range(address='A${r}:${colLetter(row.length - 1)}${r}')`, { formulas: [row] });
    const fmt = r > at.headerRow + 1 ? await copyRowFormat(env, cfg, r - 1, r) : null;
    return { ok: true, row: r, info, format: fmt };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 300) };
  }
}
