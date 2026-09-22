// Supplier-invoice reader — two tiers, confirm-first (never writes on its own).
//
//  Tier 1 (free, instant): pdfExtractText() pulls the PDF's text layer and a set
//    of regex/heuristics lift the Mostlane PO number, the net/VAT/gross triple,
//    the transaction date, invoice number and supplier. Works with NO API key.
//  Tier 2 (Claude vision): when tier 1 can't get a confident PO + reconciling
//    money triple (e.g. Elliotts' glyph-encoded PDFs, or a scanned image), the
//    raw PDF rides to Claude as a `document` block and it OCRs the fields.
//
// Everything here is READ-ONLY: it returns a proposal. The caller (po.js) shows
// it to the office, who confirm before any £ is written or any file attached.
import { pdfExtractText } from "./pdftext.js";

const PO_MIN = 10011, PO_MAX = 99999;   // Mostlane PO range (PO_START in po.js)

// ── date parsing → ISO (the transaction / tax-point date is the fallback key) ──
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
function isoDate(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// Find a date near a transaction-ish label first (tax point / invoice date), else
// the first sensible date on the page.
export function parseInvoiceDate(text) {
  const t = String(text || "");
  const near = t.match(/(?:tax\s*point|invoice\s*date|date\s*of\s*invoice|transaction\s*date|document\s*date|inv(?:oice)?\.?\s*date)[^\n]{0,40}?(\d{1,2}[\/.\- ][A-Za-z0-9]{2,9}[\/.\- ]\d{2,4})/i);
  const grab = near ? near[1] : null;
  const dm = (s) => {
    if (!s) return null;
    let m = s.match(/(\d{1,2})[\/.\- ]([A-Za-z]{3,9})[\/.\- ](\d{2,4})/);          // 15 Sep 2026
    if (m) { const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)]; return isoDate(m[3], mo, m[1]); }
    m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);                       // 08-09-26 / 15/09/2026
    if (m) return isoDate(m[3], m[2], m[1]);
    m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);                                     // ISO
    if (m) return isoDate(m[1], m[2], m[3]);
    return null;
  };
  if (grab) { const d = dm(grab); if (d) return d; }
  // No labelled date — scan the whole text for the first plausible one. Tight
  // patterns only (real separators, no spaces in the numeric form) so a phone
  // number / VAT reg / "542478 08-09" run can't swallow the real date.
  const all = t.match(/\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|\b\d{1,2}[ \/.\-][A-Za-z]{3,9}[ \/.\-]\d{2,4}\b|\b\d{4}-\d{1,2}-\d{1,2}\b/g) || [];
  for (const s of all) { const d = dm(s); if (d) return d; }
  return null;
}

// Every Mostlane-looking PO number on the page (5-digit, in range), most-labelled
// first. Ignores supplier account codes (8+ digits) and letter-prefixed refs.
export function parsePoNumbers(text) {
  const t = String(text || "");
  const seen = new Set(), out = [];
  const add = (n, score) => { n = Number(n); if (n >= PO_MIN && n <= PO_MAX && !seen.has(n)) { seen.add(n); out.push({ n, score }); } };
  // A number sitting next to an order/PO label scores highest.
  const lab = /(?:order\s*(?:no|number|ref)|purchase\s*order|\bp\.?o\.?\s*(?:no|number|ref)?|your\s*ref(?:erence)?|customer\s*(?:order|ref))[^\d]{0,18}(\d{4,6})/gi;
  let m; while ((m = lab.exec(t))) add(m[1], 2);
  // Any standalone 5-digit number in range (word-bounded so it's not part of a longer code).
  const any = /\b(1\d{4})\b/g;
  while ((m = any.exec(t))) add(m[1], 1);
  return out.sort((a, b) => b.score - a.score).map(o => o.n);
}

// All money amounts (x.dd), in document order, de-duplicated by position.
function amounts(text) {
  const out = [];
  const re = /(?:£\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/g;
  let m; while ((m = re.exec(text))) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0 && v < 1e7) out.push(v);
  }
  return out;
}
// Reconcile a net/VAT/gross triple: find a,b,c in the amounts with a+b≈c (a≥b),
// preferring the triple whose gross is largest (the invoice total). Robust to the
// column layouts where labels and values are separated (CEF/TLC/TP all reconcile).
export function reconcileTotals(text) {
  const a = amounts(text);
  let best = null;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length; j++) {
    if (i === j) continue;
    const net = a[i], vat = a[j];
    if (vat > net) continue;                       // VAT is the smaller of the two
    const gross = net + vat;
    if (!a.some(x => Math.abs(x - gross) <= 0.02)) continue;   // gross must appear on the page
    // VAT should look like a plausible rate of net (0–25%).
    const rate = net ? vat / net : 0;
    if (rate < 0.001 || rate > 0.26) continue;
    if (!best || gross > best.gross + 0.001) best = { net: round2(net), vat: round2(vat), gross: round2(gross) };
  }
  return best;
}
const round2 = (n) => Math.round(n * 100) / 100;

// Supplier: match the page text against the known-suppliers list first (so we get
// the canonical name), else a light heuristic from the top of the page.
export function normSupplierName(s) {
  return String(s || "").toLowerCase()
    .replace(/\b(ltd|limited|plc|llp|uk|group|the|co|company|services|holdings|trading|as)\b/g, " ")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
// Generic trade words that must NOT stand in for a supplier's identity — a name
// made only of these (or of a short acronym like N&C / CCF / TLC) is too weak to
// guess from, so we return null rather than mislabel. The PO's own supplier is
// the truth on a matched card; a wrong guess here was labelling TP as "N&C" etc.
const SUPPLIER_STOP = new Set(
  ("and group building products product electrical electric plumbing heating "
   + "supplies supply trade uk ltd limited services service hire distribution "
   + "wholesale centre center direct company holdings maintenance construction "
   + "contractors contractor mechanical fabrication for the").split(/\s+/));
export function matchSupplier(text, knownNames) {
  const t = String(text || "").toLowerCase();
  let best = null;
  for (const name of (knownNames || [])) {
    const norm = normSupplierName(name);
    if (!norm) continue;
    // A supplier's DISTINCTIVE words: ≥4 chars and not a generic trade word.
    const words = norm.split(" ").filter(w => w.length >= 4 && !SUPPLIER_STOP.has(w));
    if (!words.length) continue;                 // acronym-only / all-generic → don't guess
    if (!words.every(w => t.includes(w))) continue;  // ALL distinctive words must appear
    const score = words.join("").length + words.length;   // prefer the fullest, most specific name
    if (!best || score > best.score) best = { name, score };
  }
  return best ? best.name : null;
}

// A remittance advice (a payment WE received) / a monthly statement is not a
// purchase invoice — the sweep must not offer it as one.
export function looksLikeRemittance(text) {
  const t = String(text || "").toLowerCase();
  return /remittance\s*advice|\bremittance\b|statement of account|monthly statement/.test(t);
}

function invoiceNumber(text) {
  const m = String(text || "").match(/(?:invoice|inv|document)\s*(?:no|number|#|:)?\s*[:#]?\s*([A-Z]{0,4}[\/\-]?\d{4,10})/i);
  return m ? m[1].trim() : "";
}

// Tier 1 — regex extraction from the PDF's text layer.
export function extractFields(text, knownSuppliers) {
  const totals = reconcileTotals(text);
  const pos = parsePoNumbers(text);
  return {
    poNumbers: pos,
    poNumber: pos[0] || null,
    net: totals ? totals.net : null,
    vat: totals ? totals.vat : null,
    gross: totals ? totals.gross : null,
    invoiceDate: parseInvoiceDate(text),
    invoiceNumber: invoiceNumber(text),
    supplier: matchSupplier(text, knownSuppliers),
  };
}

// A tier-1 read is trustworthy enough to skip the AI when it found a PO number
// AND a reconciling money triple.
function tier1Confident(f) {
  return !!(f && f.poNumber && f.net != null && f.gross != null);
}

// Tier 2 — Claude vision over the raw PDF (document block). Returns the same
// field shape. Fails soft to null when there's no key / the call errors.
async function aiExtract(env, bytes, filename) {
  const key = env && env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const b64 = bytesToBase64(bytes);
  if (!b64 || b64.length > 12 * 1024 * 1024) return null;   // ~9 MB PDF cap
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const schema = {
    type: "object",
    properties: {
      docType: { type: "string", enum: ["invoice", "credit_note", "remittance", "statement", "other"],
        description: "What kind of document this is. 'invoice' = a supplier's PURCHASE invoice billing Mostlane for goods/works. 'credit_note' = a supplier credit. 'remittance' = a REMITTANCE ADVICE / payment advice (a record that a payment was MADE or received — NOT a bill to pay). 'statement' = a monthly account statement listing several invoices. 'other' = anything else (a delivery note, quote, order acknowledgement, letter)." },
      supplier: { type: "string", description: "The supplier / merchant name that issued this document." },
      invoiceNumber: { type: "string", description: "The supplier's own invoice number." },
      invoiceDate: { type: "string", description: "The invoice / tax-point / transaction date in YYYY-MM-DD." },
      poNumber: { type: "string", description: "The customer's purchase-order / order number if shown — a 5-digit Mostlane number in the 10000s. Empty if none is printed." },
      net: { type: "number", description: "Goods / net total, excluding VAT, in GBP." },
      vat: { type: "number", description: "VAT total in GBP." },
      gross: { type: "number", description: "Invoice total including VAT, in GBP." },
    },
    required: ["docType", "net", "gross"],
  };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 900,
        tools: [{ name: "extract_invoice", description: "Return the invoice's key fields.", input_schema: schema }],
        tool_choice: { type: "tool", name: "extract_invoice" },
        messages: [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
          { type: "text", text: "This is a PDF received by Mostlane Construction (a UK building contractor). FIRST decide what kind of document it is (docType) — be careful to distinguish a supplier PURCHASE INVOICE (a bill for us to pay) from a REMITTANCE ADVICE / payment advice (a record that a payment was made — do NOT treat this as an invoice) and from a monthly STATEMENT of account. Then read its key fields. The purchase-order number, when printed, is a 5-digit number in the 10000s (e.g. 10505) — it is NOT the supplier's own account code. Give the net (ex-VAT) and gross (inc-VAT) totals in pounds." },
        ] }],
      }),
    });
    if (!r.ok) return null;
    const p = await r.json();
    const block = Array.isArray(p.content) ? p.content.find(c => c.type === "tool_use" && c.name === "extract_invoice") : null;
    const o = block && block.input;
    if (!o) return null;
    const poRaw = String(o.poNumber || "").replace(/\D/g, "");
    const poN = Number(poRaw);
    return {
      docType: String(o.docType || "").toLowerCase() || null,
      supplier: o.supplier ? String(o.supplier).slice(0, 120) : null,
      invoiceNumber: o.invoiceNumber ? String(o.invoiceNumber).slice(0, 40) : "",
      invoiceDate: normIsoLoose(o.invoiceDate),
      poNumber: (poN >= PO_MIN && poN <= PO_MAX) ? poN : null,
      poNumbers: (poN >= PO_MIN && poN <= PO_MAX) ? [poN] : [],
      net: numOrNull(o.net), vat: numOrNull(o.vat), gross: numOrNull(o.gross),
    };
  } catch { return null; }
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? round2(n) : null; }
function normIsoLoose(s) {
  const m = String(s || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? isoDate(m[1], m[2], m[3]) : null;
}
function bytesToBase64(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = ""; const CH = 8192;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  } catch { return ""; }
}

// The one entry point: read an invoice's fields from its bytes.
//   { tier: "text"|"vision"|"none", fields, textLen, aiUsed }
// opts.allowVision (default true) — a bulk sweep sets it false once its AI budget
// is spent, so the reader falls back to the free text tier instead of stalling.
export async function parseInvoice(env, bytes, filename, knownSuppliers, opts) {
  const allowVision = !opts || opts.allowVision !== false;
  let text = "";
  try { text = await pdfExtractText(bytes); } catch {}
  const remittance = looksLikeRemittance(text);
  const t1 = extractFields(text, knownSuppliers);
  if (tier1Confident(t1)) return { tier: "text", fields: t1, textLen: text.length, aiUsed: false, remittance, docType: remittance ? "remittance" : "invoice", notInvoice: remittance };
  // Tier 1 fell short — try Claude vision (glyph-encoded / scanned / odd layout).
  const t2 = allowVision ? await aiExtract(env, bytes, filename) : null;
  if (t2) {
    // Merge: keep the best of each field (a text-layer PO is authoritative; vision
    // fills the money it couldn't reconcile). Supplier from the known list wins.
    const merged = {
      poNumber: t1.poNumber || t2.poNumber || null,
      poNumbers: (t1.poNumbers && t1.poNumbers.length ? t1.poNumbers : t2.poNumbers) || [],
      net: t2.net != null ? t2.net : t1.net,
      vat: t2.vat != null ? t2.vat : t1.vat,
      gross: t2.gross != null ? t2.gross : t1.gross,
      invoiceDate: t2.invoiceDate || t1.invoiceDate || null,
      invoiceNumber: t1.invoiceNumber || t2.invoiceNumber || "",
      supplier: (matchSupplier(text, knownSuppliers)) || t2.supplier || t1.supplier || null,
    };
    // The AI classified the document — a remittance / statement is NOT a purchase
    // invoice, so the sweep must drop it (this catches glyph/scanned remittances
    // like Sienna where the text guard can't read the "remittance" wording).
    const docType = t2.docType || (remittance ? "remittance" : "invoice");
    const notInvoice = remittance || docType === "remittance" || docType === "statement";
    return { tier: "vision", fields: merged, textLen: text.length, aiUsed: true, remittance: remittance || notInvoice, docType, notInvoice };
  }
  // No AI available and tier 1 incomplete — return whatever tier 1 got (office fills the rest).
  return { tier: text.length > 40 ? "text" : "none", fields: t1, textLen: text.length, aiUsed: false, remittance, docType: remittance ? "remittance" : null, notInvoice: remittance };
}
