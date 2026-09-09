// ─────────────────────────────────────────────────────────────────────────────
// Email intake — ONE DETERMINISTIC TEMPLATE PER KNOWN LAYOUT.
//
// Every client's job email looks different, so the intake never guesses: each
// layout below is matched by SENDER + fixed markers in the subject/body, then
// read with plain regexes (no AI). A template says what KIND of email it is:
//   job    → a new job to attend (creates/updates the job via /sla/inbound)
//   order  → a client purchase order (goes to the client-orders intake)
//   notice → informational (helpdesk note, approval, quote, supplier report,
//            our own outbound) → logged and dropped, nothing created
// A template that matches but can't read a required field returns
// `missing:[…]` so the pipeline HOLDS the email for a human ("review") instead
// of creating a half-filled job. Anything with no template also goes to review
// (with the AI's best guess attached, if a key is set) — a job is only ever
// created automatically from a layout we've seen and tested.
//
// Layouts covered (synthetic fixtures in worker/tools/test-email-intake.mjs):
//   concerto-job      Southern Co-op Concerto "New Job Alert: <ref> - Priority N"
//   concerto-order    Concerto "Order number <n> from Southern Coop" (order sheet)
//   concerto-notice   Concerto "Helpdesk action - …" / "Quote : …" notifications
//   chapplins-job     Chapplins Lettings "A new job has been raised…" (ashley@ /
//                     support@ / kerry@ — subject = address, "P1 - address",
//                     "Urgent Estimate required - address", "New job raised: Job
//                     Number N [-- P1]")
//   metrorod-report   Metro Rod job cards / quotes (supplier paperwork)
//   mostlane-outbound our own drainage-zap emails ("Send N to MetroRod",
//                     "Mostlane - Emergency - Order …")
// ─────────────────────────────────────────────────────────────────────────────

const MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
/* "09/Sep/2026 15:44" (Europe/London wall clock) → ISO UTC. */
export function londonToIso(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(new Date(guess));
    const tz = (parts.find(p => p.type === "timeZoneName") || {}).value || "GMT";
    const off = /GMT([+-]\d{1,2})/.exec(tz); const hours = off ? Number(off[1]) : 0;
    return new Date(guess - hours * 3600e3).toISOString();
  } catch { return new Date(guess).toISOString(); }
}
export function concertoDate(s) {
  const m = /(\d{1,2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(s || ""));
  if (!m || MON[m[2].toLowerCase()] === undefined) return "";
  return londonToIso(+m[3], MON[m[2].toLowerCase()], +m[1], +m[4], +m[5]);
}
/* "08/09/2026" (UK) → "2026-09-08" (date only; the job's raised time is unknown). */
function ukDate(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 9, 0));
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}
const PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const domainOf = a => String(a || "").toLowerCase().trim().split("@").pop();
const line = (re, t) => { const m = re.exec(t); return m ? String(m[1] || "").trim() : ""; };
const phoneIn = s => (/\b(0\d{9,10}|0\d{2,4}\s?\d{3,4}\s?\d{3,4})\b/.exec(String(s || "")) || [])[1] || "";

/* ── Concerto (Southern Co-op) ─────────────────────────────────────────────── */
function concertoJob(subject, t) {
  const ref = line(/assigned a new job:\s*([^\s<]+)/i, t) || line(/New Job Alert:\s*([^\s-]+)/i, subject);
  const pr = line(/Priority\s*([1-4])/i, subject) || line(/SLA of Priority\s*([1-4])/i, t);
  const siteLine = line(/^\s*Site:\s*(.+)$/im, t);
  const code = line(/^\s*(\d{3,5})\b/, siteLine);
  const postcode = (PC_RE.exec(siteLine) || [])[1] || "";
  const fault = line(/Fault\/Issue:\s*([\s\S]+?)(?:\n\s*(?:Click here to login|Please log|$))/i, t);
  const respondBy = concertoDate(line(/target Response Date\s*&\s*Time:\s*([^\n]+)/i, t));
  const completeBy = concertoDate(line(/target Completion Date\s*&\s*Time:\s*([^\n]+)/i, t));
  const site = siteLine.replace(/^\s*\d{3,5}\s*-\s*/, "").trim();
  const missing = [];
  if (!ref) missing.push("job reference");
  if (!fault) missing.push("fault/issue");
  if (!code) missing.push("store number");
  return {
    kind: "job", missing,
    fields: {
      isJob: true, reference: ref, priority: pr ? "Priority " + pr : "", siteCode: code,
      siteName: site.split(",").slice(0, 2).join(",").trim(), address: site, postcode,
      telephone: phoneIn(fault), description: fault.trim(), raisedAt: "", respondBy, completeBy
    }
  };
}
function concertoOrder(subject, t) {
  const orderNumber = line(/Order number\s+([A-Z0-9\/-]+)/i, subject) || line(/order number\s+([A-Z0-9\/-]+)/i, t);
  const pr = line(/Priority\s*:\s*Priority\s*([1-4])/i, t);
  const value = line(/Order value\s*:\s*£?\s*([\d,]+(?:\.\d{1,2})?)/i, t);
  const forLine = line(/^\s*For\s*:\s*\n?\s*(.+)$/im, t);
  const code = line(/^\s*(\d{3,5})\b/, forLine);
  const sr = line(/\b(SR\d{4,6})\b/i, forLine);
  const siteName = forLine.replace(/^\s*\d{3,5}\s*-\s*/, "").replace(/\bSR\d{4,6}\b/i, "").trim();
  const desc = line(/Order value\s*:[^\n]*\n([\s\S]*?)(?:\n\s*For\s*:|$)/i, t);
  const missing = [];
  if (!orderNumber) missing.push("order number");
  if (!code) missing.push("store number");
  return {
    kind: "order", missing,
    order: { orderNumber, priority: pr ? Number(pr) : null, orderValue: value ? Number(value.replace(/,/g, "")) : null,
      storeCode: code, siteName, srRef: sr, siteRaw: forLine, description: desc.trim(), client: "Southern Co-op", source: "email" }
  };
}
/* ── Chapplins Lettings ────────────────────────────────────────────────────── */
const CHAP_SIG = /\n\s*(?:Many thanks|Kind regards|Regards|Thanks|Thank you)\b|\n\s*Ashley Newell|\n\s*Kerry\b|\n\s*Chapplins (?:Support|Lettings|Residential)|\n\s*\d{2}-\d{2} Station Road/i;
function chapplinsJob(subject, t) {
  const jobNo = line(/Job Number:\s*(\d{3,12})\b/i, t) || line(/Job Number\s*(\d{3,12})\b/i, subject);
  // Same-line values only ([ \t]* not \s*): an EMPTY "Home Telephone:" line must
  // not swallow the "Mobile: …" line beneath it.
  const property = line(/^[ \t]*Property:[ \t]*([^\n]*)$/im, t);
  const tenantRef = line(/^[ \t]*Tenant:[ \t]*([^\n]*)$/im, t);
  const name = line(/^[ \t]*Name:[ \t]*([^\n]*)$/im, t);
  const home = line(/^[ \t]*Home Telephone:[ \t]*([^\n]*)$/im, t);
  const mobile = line(/^[ \t]*Mobile:[ \t]*([^\n]*)$/im, t);
  const email = line(/^[ \t]*E-?mail:[ \t]*([^\n]*)$/im, t);
  const entered = line(/Date Job Entered:\s*([\d\/]+)/i, t);
  let desc = line(/Job Description:\s*([\s\S]*)$/i, t);
  const cut = CHAP_SIG.exec(desc); if (cut) desc = desc.slice(0, cut.index);
  desc = desc.replace(/^\s*(?:Hi(?: All)?|Hello[^\n]*|Dear[^\n]*)\s*,?\s*\n/i, "").trim();
  // Subject carries the priority ("P1 - …", "… -- P1", "… P1 Urgent") and sometimes
  // a request type ("Urgent Estimate required - …") worth keeping in front.
  const pr = line(/\bP\s*([1-4])\b/i, subject);
  const subjHead = subject.replace(/\bP\s*[1-4]\b\s*-?\s*/i, "").split(/\s+-\s+/)[0].trim();
  const prefix = /estimate|quote/i.test(subjHead) && !/^new job raised/i.test(subjHead) ? subjHead + " — " : "";
  const postcode = (PC_RE.exec(property) || PC_RE.exec(subject) || [])[1] || "";
  const contact = [name && ("Tenant: " + name + (tenantRef ? " (" + tenantRef + ")" : "")), mobile && ("Mobile: " + mobile), home && ("Home: " + home), email && ("Email: " + email)].filter(Boolean).join(" · ");
  const missing = [];
  if (!jobNo) missing.push("job number");
  if (!property) missing.push("property address");
  if (!desc) missing.push("job description");
  return {
    kind: "job", missing,
    siteLookup: { client: "chapplins", address: property, postcode },
    fields: {
      isJob: true, reference: jobNo ? "CHAP-" + jobNo : "", priority: pr ? "Priority " + pr : "",
      siteCode: "", siteName: property.replace(/\s*,\s*,+/g, ",").replace(/,\s*$/, "").trim(), address: property, postcode,
      telephone: phoneIn(mobile) || phoneIn(home), description: (prefix + desc + (contact ? "\n\n" + contact : "")).trim(),
      raisedAt: ukDate(entered), respondBy: "", completeBy: "", storeType: "chapplins"
    }
  };
}

/* ── The registry ─────────────────────────────────────────────────────────── */
export const TEMPLATES = [
  { id: "concerto-job", label: "Concerto — New Job Alert (Southern Co-op)", domains: ["concerto.co.uk"],
    test: (s, t) => /New Job Alert/i.test(s) || /You have been assigned a new job/i.test(t), read: concertoJob },
  { id: "concerto-order", label: "Concerto — order sheet (client purchase order)", domains: ["concerto.co.uk"],
    test: (s, t) => /^Order number\s/i.test(s) || /attached order sheet for order number/i.test(t), read: concertoOrder },
  { id: "concerto-notice", label: "Concerto — helpdesk action / quote notice", domains: ["concerto.co.uk"],
    test: (s) => /^Helpdesk action\b|^Quote\s*:/i.test(s), read: (s) => ({ kind: "notice", reason: /Approved/i.test(s) ? "Concerto approval notice — the order-sheet email carries the actual order" : "Concerto helpdesk/quote notice, not a job" }) },
  { id: "chapplins-job", label: "Chapplins Lettings — new job raised", domains: ["chapplins.co.uk"],
    test: (s, t) => /A new job has been raised/i.test(t), read: chapplinsJob },
  { id: "metrorod-report", label: "Metro Rod — job card / quote (supplier paperwork)", domains: ["metrorod.co.uk"],
    test: () => true, read: (s) => ({ kind: "notice", reason: /quote/i.test(s) ? "Metro Rod quotation — supplier paperwork, not a job" : "Metro Rod job card / report — supplier paperwork, not a job" }) },
  { id: "mostlane-outbound", label: "Mostlane — our own drainage/zap emails", domains: ["mostlane.com"],
    test: (s, t) => /^Send\s+\S+\s+to MetroRod|^Mostlane - Emergency - Order/i.test(s) || /Possible MetroRod job received/i.test(t), read: () => ({ kind: "notice", reason: "Our own outbound drainage email, not a job" }) },
];

/* Match a template by sender domain + markers. Returns {tpl, result} or null.
   `sender` is the ORIGINAL sender (unwrapped from a forward). */
export function matchTemplate(sender, subject, text) {
  const dom = domainOf(sender);
  const s = String(subject || ""), t = String(text || "");
  for (const tpl of TEMPLATES) {
    if (!tpl.domains.some(d => dom === d || dom.endsWith("." + d))) continue;
    let hit = false; try { hit = !!tpl.test(s, t); } catch {}
    if (!hit) continue;
    let result; try { result = tpl.read(s, t); } catch (e) { result = { kind: "job", missing: ["template error: " + String(e && e.message || e).slice(0, 80)], fields: null }; }
    return { tpl, result };
  }
  return null;
}
/* Is this sender the home of a known layout? (Known layouts are trusted senders.) */
export function templateDomain(sender) {
  const dom = domainOf(sender);
  return TEMPLATES.some(tpl => tpl.domains.some(d => dom === d || dom.endsWith("." + d)));
}

/* ── Chapplins site lookup: property address → the portal site (4001–4127) ──
   Sites are unit-level (each flat / communal area its own site), and several
   share a postcode, so the match is postcode FIRST then the normalised address
   (unit + street) — an exact normalised match, else a unique leading-words match.
   No confident match → no site code (the office links it; the job still lands). */
const normAddr = s => String(s || "").toLowerCase().replace(PC_RE, " ").replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\b(flat|apartment|apt)\b/g, "flat").replace(/\s+/g, " ").trim();
export async function lookupSite(env, tid, { client, address, postcode }) {
  if (!env || !env.DB || !address) return null;
  const pc = String(postcode || "").toUpperCase().replace(/\s+/g, "");
  let rows = [];
  try {
    const q = pc
      ? env.DB.prepare("SELECT site_number, site_name, postcode FROM sites WHERE tenant_id=? AND client=? AND active=1 AND REPLACE(UPPER(COALESCE(postcode,'')),' ','')=?").bind(tid, client, pc)
      : env.DB.prepare("SELECT site_number, site_name, postcode FROM sites WHERE tenant_id=? AND client=? AND active=1").bind(tid, client);
    rows = ((await q.all()).results) || [];
  } catch { return null; }
  if (!rows.length) return null;
  const want = normAddr(address);
  const exact = rows.filter(r => normAddr(r.site_name) === want);
  if (exact.length === 1) return { siteCode: exact[0].site_number, siteName: exact[0].site_name };
  const head = want.split(" ").slice(0, 3).join(" ");
  const lead = head ? rows.filter(r => normAddr(r.site_name).startsWith(head + " ") || normAddr(r.site_name) === head) : [];
  if (lead.length === 1) return { siteCode: lead[0].site_number, siteName: lead[0].site_name };
  return null;
}
