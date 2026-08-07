#!/usr/bin/env node
// ============================================================================
// TSC Compliance → R2 extractor  (Phase B of the portal compliance migration)
// ----------------------------------------------------------------------------
// Walks The Southern Co-op "TSC Compliance" SharePoint tree via Microsoft Graph
// and streams every certificate into the portal's POST /compliance/file, which
// stores it in R2 and indexes it in D1 (keyed by store CODE + compliance TYPE).
//
// The tree is MOSTLY  <group>/<code name>/<TYPE>/<files>  but has real variance:
//   • type-first top-level folders   PFS / EV Maintenance / PV Maintenance /...
//     → <TYPE>/<store name, often NO code>/<files>
//   • store folders with no code     "East Devon crematorium- 2026-04-24 ..."
//   • filenames that carry their OWN  code/type/date  "9683~EICR~17-12-21.pdf"
//     — and that code can DISAGREE with the folder it sits in.
//   • a special "Lakeside Head Office" with Data Sheets / Schedules / Old Demise.
//
// So we DON'T assume a fixed depth. For each file we derive (code, type, year,
// date) from the WHOLE ancestor path + the filename, preferring the explicit
// folder structure, and QUARANTINE anything we can't confidently key rather than
// import it under a wrong code. Nothing is guessed into the live data.
//
// Runs read-review-then-commit:  default is --dry-run (classify + write CSV
// reports, download/post NOTHING). Inspect the reports, fix the name map if
// needed, then re-run with --commit.
//
// Requires: Node 18+ (global fetch/FormData/Blob). No npm deps.
//
// ENV (or .env in this folder):
//   GRAPH_TENANT_ID       Azure AD tenant id (GUID)
//   GRAPH_CLIENT_ID       App registration (client) id
//   GRAPH_CLIENT_SECRET   App registration client secret
//     → the app registration needs APPLICATION permission Sites.Read.All
//       (or Files.Read.All), admin-consented.
//   PORTAL_BASE           e.g. https://mostlane-api.jamie-def.workers.dev
//   COMPLIANCE_IMPORT_TOKEN   matches the worker secret of the same name
//   DRIVE_ID              default: the TSC Compliance drive (below)
//   ROOT_PATH             default: "Mostlane Construction/TSC Compliance"
//   ROOT_ITEM_ID          optional: use instead of ROOT_PATH if you have the id
//
// FLAGS:
//   --commit         actually download + post (default is dry-run)
//   --code-source=folder|filename   which wins on a code clash (default folder)
//   --names=names.json   { "store name substring": "9683", ... } to rescue
//                        code-less folders by name (optional)
//   --max-mb=95      skip + report files larger than this (Worker body limit)
//   --limit=N        stop after N files (smoke test)
//   --only=CODE      only process files that resolve to this store code
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── tiny .env loader (no dep) ───────────────────────────────────────────────
(function loadDotenv() {
  const p = path.join(__dir, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k, d) => { const a = argv.find(x => x.startsWith(k + "=")); return a ? a.split("=").slice(1).join("=") : d; };

const SELFTEST    = has("--selftest");
const COMMIT      = has("--commit");
const CODE_SOURCE = (val("--code-source", "folder") === "filename") ? "filename" : "folder";
const MAX_MB      = Number(val("--max-mb", "95"));
const LIMIT       = Number(val("--limit", "0")) || Infinity;
const ONLY        = val("--only", "");
const NAMES_FILE  = val("--names", "");

function die(m) { console.error("✖ " + m); process.exit(1); }
function must(k) { const v = process.env[k]; if (!v) die(`Missing env ${k}`); return v; }

// --selftest: assert the classifier against the real variance seen in the tree.
// Runs with NO credentials so it's safe in CI / before you have the app reg.
// (Invoked at the bottom, after the pure helpers are initialised.)
function selftest() {
  let fail = 0;
  const eq = (got, want, msg) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.error(`✖ ${msg}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); } else console.log(`✓ ${msg}`); };
  const pick = (item, segs, src = "folder") => { const c = classify(item, segs, src); return { code: c.code, type: c.type, year: c.year, date: c.date, clash: c.notes.some(x => x.startsWith("code-clash")), unmatched: !c.code }; };

  // 1. common: COBRA / 9667 Plymouth / 5 Year / 9683~EICR~17-12-21.pdf
  //    folder code 9667 wins (default), type fiveYear, date from filename, code clash flagged.
  eq(pick({ name: "9683~EICR~17-12-21.pdf", size: 5 }, ["COBRA", "9667 Plymouth", "5 Year"]),
     { code: "9667", type: "fiveYear", year: "2021", date: "2021-12-17", clash: true, unmatched: false },
     "store folder / 5 Year / filename-coded EICR");

  // 2. PAT subfolder, plain filename, no code clash
  eq(pick({ name: "PAT Certificate.pdf", size: 5 }, ["Retail", "9688 Southampton Above Bar", "PAT"]),
     { code: "9688", type: "pat", year: null, date: null, clash: false, unmatched: false },
     "store folder / PAT / plain filename");

  // 3. type-first, code-LESS folder → unmatched (no confident code)
  eq(pick({ name: "cert.pdf", size: 5 }, ["EV Maintenance", "East Devon crematorium- 2026-04-24 07_36_34- 3"]),
     { code: "", type: "ev", year: "2026", date: "2026-04-24", clash: false, unmatched: true },
     "type-first EV / code-less folder → unmatched");

  // 4. 4-digit-coded store under Crematorium group
  eq(pick({ name: "EICR 2023.pdf", size: 5 }, ["Crematorium & Burial Grounds", "4000 The Oaks Havant Crematorium", "5 Year"]),
     { code: "4000", type: "fiveYear", year: "2023", date: null, clash: false, unmatched: false },
     "crematorium / coded store / year-in-filename");

  // 5. type only from filename when folder is generic
  eq(pick({ name: "Emergency Lighting Test.pdf", size: 5 }, ["ELS", "9701 Somewhere"]),
     { code: "9701", type: "em", year: null, date: null, clash: false, unmatched: false },
     "type inferred from filename (EM)");

  // 6. --code-source=filename flips the clash winner
  eq(pick({ name: "9683~EICR~17-12-21.pdf", size: 5 }, ["COBRA", "9667 Plymouth", "5 Year"], "filename").code, "9683",
     "code-source=filename → filename code wins");

  // 7. head-office junk with no code, unknown type → unmatched + other
  eq(pick({ name: "notes.docx", size: 5 }, ["Lakeside Head Office", "Data Schedules"]),
     { code: "", type: "other", year: null, date: null, clash: false, unmatched: true },
     "head-office / no code / unknown type → unmatched other");

  console.log(fail ? `\n${fail} FAILED` : "\nall self-tests passed");
  if (fail) process.exit(1);
}

// Graph creds are needed to walk the tree (both dry-run and commit) — but NOT
// for --selftest, which exercises the classifier offline.
const TENANT = SELFTEST ? "" : must("GRAPH_TENANT_ID");
const CLIENT = SELFTEST ? "" : must("GRAPH_CLIENT_ID");
const SECRET = SELFTEST ? "" : must("GRAPH_CLIENT_SECRET");
// Portal creds are only needed when we actually write.
const PORTAL = (COMMIT ? must("PORTAL_BASE") : (process.env.PORTAL_BASE || "")).replace(/\/+$/, "");
const IMPORT_TOKEN = COMMIT ? must("COMPLIANCE_IMPORT_TOKEN") : (process.env.COMPLIANCE_IMPORT_TOKEN || "");
const DRIVE_ID = process.env.DRIVE_ID || "b!NpDXAs0EE0OL71TDQZYd-bdykHFlnd9FjsgSt11fwgt0jcCyS10IR5OEI-3NYzYC";
const ROOT_PATH = process.env.ROOT_PATH || "Mostlane Construction/TSC Compliance";
const ROOT_ITEM_ID = process.env.ROOT_ITEM_ID || "";

// Optional store-name → code rescue map for code-less folders.
let NAME_MAP = [];
if (NAMES_FILE) {
  const raw = JSON.parse(fs.readFileSync(path.isAbsolute(NAMES_FILE) ? NAMES_FILE : path.join(__dir, NAMES_FILE), "utf8"));
  NAME_MAP = Object.entries(raw).map(([name, code]) => ({ name: norm(name), code: pad4(code) }));
}

// ── helpers ─────────────────────────────────────────────────────────────────
const pad4 = (v) => String(v ?? "").replace(/\D/g, "").padStart(4, "0");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Canonical compliance type from any folder/type label. Mirrors the worker's
// canonType() so folder+server agree.
function canonType(t) {
  const s = String(t || "").toLowerCase();
  if (/5\s*year|five\s*year|eicr/.test(s)) return "fiveYear";
  if (/\bpat\b/.test(s)) return "pat";
  if (/emergency|\bem\b|em\s*light/.test(s)) return "em";
  if (/forecourt|\bpfs\b|petrol|fuel/.test(s)) return "forecourt";
  if (/\bpv\b|solar|photovolt/.test(s)) return "pv";
  if (/\bev\b|charge|ev\s*maint/.test(s)) return "ev";
  if (/pump|sump/.test(s)) return "pump";
  return "other";
}

// A leading store code in a folder/file name: "9667 Plymouth", "9683~EICR~...".
function codeFrom(nameRaw) {
  const m = /^(\d{3,4})(?:\b|[~_\- ])/.exec(String(nameRaw || "").trim());
  return m ? pad4(m[1]) : "";
}

// Parse a date and/or year out of a filename or segment.
function dateFrom(nameRaw) {
  const s = String(nameRaw || "");
  let m;
  // YYYY-MM-DD  /  YYYY_MM_DD
  if ((m = /(20\d{2}|19\d{2})[-_.](\d{1,2})[-_.](\d{1,2})/.exec(s))) {
    return iso(+m[1], +m[2], +m[3]);
  }
  // DD-MM-YY(YY)  /  DD.MM.YY  (Workever-style "17-12-21")
  if ((m = /\b(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})\b/.exec(s))) {
    let y = +m[3]; if (y < 100) y += (y > 70 ? 1900 : 2000);
    return iso(y, +m[2], +m[1]);
  }
  // a bare 4-digit year
  if ((m = /\b(20\d{2}|19\d{2})\b/.exec(s))) return { date: null, year: String(m[1]) };
  return { date: null, year: null };
}
function iso(y, mo, d) {
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return { date: null, year: null };
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return { date: dt.toISOString().slice(0, 10), year: String(y) };
}

// ── Graph auth + paging ─────────────────────────────────────────────────────
let TOKEN = null, TOKEN_EXP = 0;
async function graphToken() {
  if (TOKEN && Date.now() < TOKEN_EXP - 60000) return TOKEN;
  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET,
    scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) die(`Graph token failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  TOKEN = j.access_token; TOKEN_EXP = Date.now() + (j.expires_in || 3600) * 1000;
  return TOKEN;
}
async function graph(url) {
  for (let attempt = 0; ; attempt++) {
    const tok = await graphToken();
    const r = await fetch(url.startsWith("http") ? url : `https://graph.microsoft.com/v1.0${url}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (r.status === 429 || r.status >= 500) {
      const wait = Number(r.headers.get("retry-after") || Math.min(30, 2 ** attempt)) * 1000;
      if (attempt < 6) { await sleep(wait); continue; }
    }
    if (!r.ok) throw new Error(`Graph ${r.status} on ${url}: ${await r.text()}`);
    return r.json();
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function resolveRootId() {
  if (ROOT_ITEM_ID) return ROOT_ITEM_ID;
  const enc = ROOT_PATH.split("/").map(encodeURIComponent).join("/");
  const j = await graph(`/drives/${DRIVE_ID}/root:/${enc}`);
  return j.id;
}

async function* walk(itemId, segments) {
  let url = `/drives/${DRIVE_ID}/items/${itemId}/children?$top=200&$select=id,name,size,folder,file,webUrl`;
  while (url) {
    const j = await graph(url);
    for (const it of j.value || []) {
      if (it.folder) {
        yield* walk(it.id, [...segments, it.name]);
      } else if (it.file) {
        yield { item: it, segments };
      }
    }
    url = j["@odata.nextLink"] || null;
  }
}

// ── classify one file into (code, type, year, date, notes) ──────────────────
const SKIP_NAMES = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;
function classify(item, segments, codeSource = CODE_SOURCE) {
  const name = item.name;
  const notes = [];

  // type: deepest segment that canon-maps to a real type, else from filename.
  let type = "other";
  for (let i = segments.length - 1; i >= 0; i--) {
    const c = canonType(segments[i]);
    if (c !== "other") { type = c; break; }
  }
  if (type === "other") { const c = canonType(name); if (c !== "other") { type = c; notes.push("type-from-filename"); } }

  // code: first coded segment (highest store folder) unless --code-source=filename.
  let folderCode = "";
  for (const seg of segments) { const c = codeFrom(seg); if (c) { folderCode = c; break; } }
  const fileCode = codeFrom(name);
  let code = "";
  if (codeSource === "filename") code = fileCode || folderCode;
  else code = folderCode || fileCode;

  if (folderCode && fileCode && folderCode !== fileCode) notes.push(`code-clash folder=${folderCode} file=${fileCode}`);

  // code-less folder → try the optional name map against each segment.
  if (!code && NAME_MAP.length) {
    for (let i = segments.length - 1; i >= 0 && !code; i--) {
      const ns = norm(segments[i]);
      const hit = NAME_MAP.find(x => x.name && (ns.includes(x.name) || x.name.includes(ns)));
      if (hit) { code = hit.code; notes.push(`code-by-name:${segments[i]}`); }
    }
  }

  // date / year: filename first, then any dated segment.
  let { date, year } = dateFrom(name);
  if (!year) for (let i = segments.length - 1; i >= 0; i--) { const d = dateFrom(segments[i]); if (d.year) { date = date || d.date; year = d.year; break; } }

  return { code, type, year, date, notes };
}

// ── portal calls ────────────────────────────────────────────────────────────
async function portalHas(source) {
  const r = await fetch(`${PORTAL}/compliance/has?source=${encodeURIComponent(source)}`, {
    headers: { Authorization: `Bearer ${IMPORT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`/has ${r.status}: ${await r.text()}`);
  return (await r.json()).exists;
}
async function portalPost(item, cls) {
  // fresh download URL each time (they expire quickly)
  const meta = await graph(`/drives/${DRIVE_ID}/items/${item.id}?$select=id,name,@microsoft.graph.downloadUrl`);
  const durl = meta["@microsoft.graph.downloadUrl"];
  if (!durl) throw new Error("no downloadUrl");
  const dl = await fetch(durl);
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());

  const form = new FormData();
  form.append("file", new Blob([buf]), item.name);
  form.append("code", cls.code);
  form.append("type", cls.type);
  if (cls.year) form.append("year", cls.year);
  if (cls.date) form.append("date", cls.date);
  form.append("filename", item.name);
  form.append("source", item.id); // stable Graph id → server de-dupes

  const r = await fetch(`${PORTAL}/compliance/file`, {
    method: "POST", headers: { Authorization: `Bearer ${IMPORT_TOKEN}` }, body: form,
  });
  if (!r.ok) throw new Error(`/file ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── CSV reports ─────────────────────────────────────────────────────────────
function csvRow(a) { return a.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",") + "\n"; }
const OUT = path.join(__dir, "out");
fs.mkdirSync(OUT, { recursive: true });
const streams = {};
function report(name, header) {
  const p = path.join(OUT, name);
  const s = fs.createWriteStream(p);
  s.write(csvRow(header));
  streams[name] = s;
  return (arr) => s.write(csvRow(arr));
}

// ── main ────────────────────────────────────────────────────────────────────
if (SELFTEST) { selftest(); process.exit(0); }

(async () => {
  console.log(`TSC Compliance extractor — ${COMMIT ? "COMMIT (writing to portal)" : "DRY RUN (classify only)"}`);
  console.log(`  drive=${DRIVE_ID.slice(0, 12)}…  root="${ROOT_PATH}"  code-source=${CODE_SOURCE}  max=${MAX_MB}MB`);
  if (NAME_MAP.length) console.log(`  name-map: ${NAME_MAP.length} entries`);

  const wImported  = report("imported.csv",  ["code", "type", "year", "date", "file", "path", "notes"]);
  const wSkipped   = report("skipped.csv",   ["reason", "file", "path", "sizeMB"]);
  const wUnmatched = report("unmatched.csv", ["type", "file", "path", "notes"]); // no confident code
  const wMismatch  = report("mismatches.csv",["code", "type", "file", "path", "notes"]);
  const wErrors    = report("errors.csv",    ["file", "path", "error"]);

  const rootId = await resolveRootId();
  console.log(`  root item id: ${rootId}`);

  const counts = { seen: 0, imported: 0, dup: 0, skipped: 0, unmatched: 0, mismatch: 0, error: 0 };
  let n = 0;

  for await (const { item, segments } of walk(rootId, [])) {
    if (n >= LIMIT) break;
    counts.seen++;
    const relPath = segments.join(" / ") + " / " + item.name;

    if (SKIP_NAMES.test(item.name)) { counts.skipped++; wSkipped(["system-file", item.name, relPath, ""]); continue; }

    const cls = classify(item, segments);
    if (ONLY && cls.code !== pad4(ONLY)) continue;
    n++;

    if (cls.notes.some(x => x.startsWith("code-clash"))) { counts.mismatch++; wMismatch([cls.code, cls.type, item.name, relPath, cls.notes.join("; ")]); }

    if (!cls.code) { counts.unmatched++; wUnmatched([cls.type, item.name, relPath, cls.notes.join("; ")]); continue; }

    const sizeMB = (item.size || 0) / 1048576;
    if (sizeMB > MAX_MB) { counts.skipped++; wSkipped(["too-big", item.name, relPath, sizeMB.toFixed(1)]); continue; }

    if (!COMMIT) { counts.imported++; wImported([cls.code, cls.type, cls.year, cls.date, item.name, relPath, cls.notes.join("; ")]);
      if (counts.seen % 200 === 0) tick(counts); continue; }

    try {
      if (await portalHas(item.id)) { counts.dup++; if (counts.seen % 200 === 0) tick(counts); continue; }
      await portalPost(item, cls);
      counts.imported++;
      wImported([cls.code, cls.type, cls.year, cls.date, item.name, relPath, cls.notes.join("; ")]);
    } catch (e) {
      counts.error++;
      wErrors([item.name, relPath, String(e.message || e)]);
    }
    if (counts.seen % 100 === 0) tick(counts);
  }

  await Promise.all(Object.values(streams).map(s => new Promise(r => s.end(r))));
  console.log("\n── done ──");
  console.table(counts);
  console.log(`Reports in: ${OUT}`);
  if (!COMMIT) console.log(`\nReview out/*.csv (esp. unmatched.csv + mismatches.csv), then re-run with --commit.`);
})().catch(e => die(e.stack || String(e)));

function tick(c) { process.stdout.write(`\r  seen ${c.seen}  imported ${c.imported}  dup ${c.dup}  unmatched ${c.unmatched}  clash ${c.mismatch}  skip ${c.skipped}  err ${c.error}   `); }
