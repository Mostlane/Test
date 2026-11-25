// Southern Co-op "compliance pack" — works out, for every active store, which
// certificate goes in which folder of the hand-over pack the client asked for:
//
//   <Group>/<code> - <store name>/<type folder>/<latest certificate>
//
// Group = the store's chart category (Cobra / ELS / ELS Private / Retail).
// Only the MOST RECENT certificate per type is included (all pinned files when
// the office has pinned more than one — e.g. a 5-year report split over two
// PDFs). The chart stores forecourt and EV in one "ev" type; here they are split
// back out: a petroleum / forecourt cert goes to "Forecourt 12 monthly", an EV
// charger cert to "EV".
//
// Pure (no env/DB) so it is unit-testable: worker/tools/test-compliance-pack.mjs

export const PACK_TYPES = [
  { key: "fiveYear",  folder: "5 Year electrical Test", label: "5 Year electrical", always: true },
  { key: "pat",       folder: "PAT",                    label: "PAT",               always: true },
  { key: "em",        folder: "EM Lighting",            label: "EM Lighting",       always: true },
  { key: "pump",      folder: "Pump",                   label: "Pump" },
  { key: "forecourt", folder: "Forecourt 12 monthly",   label: "Forecourt 12 monthly" },
  { key: "pv",        folder: "PV",                     label: "PV" },
  { key: "ev",        folder: "EV",                     label: "EV" },
];

export const PACK_GROUPS = ["Cobra", "ELS", "ELS Private", "Retail"];

const isPfsName = (n) => /\bpfs\b|petrol|forecourt/i.test(String(n || ""));

// A chart "ev" file → "forecourt" or "ev".
export function splitEvFile(f, storeIsPfs) {
  const s = String((f.filename || "") + " " + (f.label || "")).toLowerCase();
  if (/(^|[^a-z])pet([^a-z]|$)|petrol|forecourt|(^|[^a-z])pfs([^a-z]|$)|fuel|dispenser/.test(s)) return "forecourt";
  if (/(^|[^a-z])ev([^a-z]|$)|charg/.test(s)) return "ev";
  return storeIsPfs ? "forecourt" : "ev";
}

// Windows/Mac-safe file/folder name.
export function safeName(s, fallback = "file") {
  let t = String(s == null ? "" : s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/[. ]+$/g, "");
  if (!t) t = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(t)) t = "_" + t;
  return t.slice(0, 150);
}

// "0109 Romsey, Winchester Hill" → "Romsey, Winchester Hill" (when the name
// already starts with the store code, so the folder doesn't read "0109 - 0109 …").
export function storeFolderName(code, name) {
  let n = String(name || "").trim();
  const num = String(parseInt(code, 10));
  n = n.replace(new RegExp("^0*" + num + "\\s*[-–:]?\\s*"), "").trim();
  return safeName(n ? `${code} - ${n}` : String(code), String(code));
}

const fileDate = (f) => f.doc_date || f.uploaded_at || "";

// The latest certificate(s) of one type: pinned ones if any, else the newest by
// certificate date (upload date when undated), newest upload breaking a tie.
export function pickLatest(files) {
  if (!files || !files.length) return [];
  const pinned = files.filter((f) => f.pinned);
  if (pinned.length) return pinned;
  const sorted = [...files].sort((a, b) => {
    const d = fileDate(b).localeCompare(fileDate(a));
    return d || String(b.uploaded_at || "").localeCompare(String(a.uploaded_at || ""));
  });
  return [sorted[0]];
}

const hasDue = (due, k) => !!(due && due[k] && String(due[k]).trim());
// Due dates are ISO or legacy dd/mm/yyyy.
export function isoDue(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return "";
}

// stores: [{code, name, postcode, category, due:{}}] (active only)
// files:  [{id, code, type, filename, label, pinned, size, doc_date, uploaded_at, r2_key}]
export function buildPackPlan(stores, files, today = new Date().toISOString().slice(0, 10)) {
  const byStore = new Map();
  for (const f of files || []) {
    if (!byStore.has(f.code)) byStore.set(f.code, []);
    byStore.get(f.code).push(f);
  }
  const out = [];
  for (const st of stores || []) {
    const due = st.due || {};
    const pfs = isPfsName(st.name);
    const group = PACK_GROUPS.find((g) => g.toLowerCase() === String(st.category || "").trim().toLowerCase()) || "Uncategorised";
    const mine = byStore.get(st.code) || [];
    const cand = {};
    for (const f of mine) {
      let k = f.type;
      if (k === "ev" || k === "forecourt") k = f.type === "forecourt" ? "forecourt" : splitEvFile(f, pfs);
      (cand[k] = cand[k] || []).push(f);
    }
    const dueFor = {
      fiveYear: due.fiveYear, pat: due.pat, em: due.em, pump: due.pump, pv: due.pv,
      forecourt: due.forecourt || (pfs ? due.ev : ""),
      ev: pfs ? "" : due.ev,
    };
    const types = {};
    const flags = [];
    for (const t of PACK_TYPES) {
      const have = cand[t.key] || [];
      let required = !!t.always || have.length > 0;
      if (!required) {
        if (t.key === "forecourt") required = pfs || hasDue(dueFor, "forecourt");
        else required = hasDue(dueFor, t.key);
      }
      const chosen = pickLatest(have);
      const d = isoDue(dueFor[t.key]);
      let status;
      if (!required) status = "Not required";
      else if (!chosen.length) status = "Missing";
      else if (d && d < today) status = "Overdue";
      else status = "Present";
      types[t.key] = {
        required, status, due: d,
        files: chosen.map((f) => ({
          id: f.id, filename: f.filename || "", label: f.label || "", size: f.size || 0,
          date: f.doc_date || "", uploaded: f.uploaded_at || "", undated: !f.doc_date, r2_key: f.r2_key,
        })),
      };
      if (chosen.some((f) => !f.doc_date)) flags.push(`${t.label}: certificate has no date (upload date used)`);
    }
    if (group === "Uncategorised") flags.push("No store type set on the chart");
    out.push({
      group, code: st.code, name: st.name || "", postcode: st.postcode || "", pfs,
      folder: storeFolderName(st.code, st.name), types, flags,
    });
  }
  out.sort((a, b) => a.group.localeCompare(b.group) || a.code.localeCompare(b.code));
  return out;
}
