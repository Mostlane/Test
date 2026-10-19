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
//   concerto-cancel   Concerto "Cancellled Job: <incident> Order No.: <ref>" (the
//                     client cancelled a job → the job is marked Cancelled)
//   concerto-quote-cancel  "Quote : N - Q003. Cancel request by …" (the client
//                     withdrew a quote request → cancels a job still waiting on it)
//   concerto-notice   Concerto "Helpdesk action - …" / other "Quote : …" notices
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
/* Concerto "Cancellled Job" (sic — their spelling) notice: the client cancelled an
   incident. Body: "The job you logged 00028752: Windows : Cracked/Smashed (R, E)",
   "Order No.: 00028752/1" (blank when it was never assigned to us as an order),
   "Has been Cancelled", "Comments: order for glass placed this morning." */
function concertoCancel(subject, t) {
  const incident = line(/Cancell?l?ed Job:\s*(\d{5,12})/i, subject) || line(/The job you logged\s*(\d{5,12})\b/i, t);
  const reference = line(/Order No\.?\s*:\s*([0-9A-Z]+\/\d{1,3})/i, t) || line(/Order No\.?\s*:\s*([0-9A-Z]+\/\d{1,3})/i, subject);
  const title = line(/The job you logged\s*\d+\s*:\s*([^\n]*)/i, t);
  let reason = line(/Comments?\s*:\s*([\s\S]*?)(?:\n\s*For further information|$)/i, t);
  reason = reason.replace(/\s+/g, " ").trim().replace(/^\.$/, "");
  const missing = [];
  if (!incident) missing.push("incident number");
  return { kind: "cancel", missing, cancel: { kind: "job", incident, reference, title, reason, by: "Southern Co-op (Concerto)" } };
}
/* Concerto quote-request cancellation: "Quote : 001663 - Q003. Cancel request by
   Alex Thompson" — body "The following quote request has been updated." then the
   reason line, "Quote reference : 001663", "Title : Quotation required for order
   number : 00014287/2", "Quote status : Cancelled", "Site : 9664 - Name". */
function concertoQuoteCancel(subject, t) {
  const reference = line(/order number\s*:\s*([0-9A-Z]+\/\d{1,3})/i, t);
  const quoteRef = line(/Quote reference\s*:\s*(\S+)/i, t) || line(/^Quote\s*:\s*(\d+)/i, subject);
  const by = line(/Cancel request by\s+([^\n]+?)\s*$/i, subject);
  let reason = line(/has been updated\.?\s*\n+\s*([^\n]*)/i, t);
  if (/^Quote reference/i.test(reason)) reason = "";
  reason = reason.replace(/\.{3,}/g, " — ").replace(/\s+/g, " ").trim();
  const siteLine = line(/^\s*Site\s*:\s*([^\n]*)/im, t);
  const siteCode = line(/^\s*(\d{3,5})\b/, siteLine);
  const missing = [];
  if (!reference) missing.push("job reference (order number)");
  return { kind: "cancel", missing, cancel: { kind: "quote", incident: (/^(\d{5,12})\//.exec(reference) || [])[1] || "", reference, quoteRef, siteCode, reason, by: "Southern Co-op (Concerto" + (by ? " — " + by : "") + ")" } };
}
/* Concerto "Helpdesk action - <ACTION> : <incident>" — the RICH dispatch/update
   email (this is how most Co-op jobs actually reach us; the New Job Alert doesn't
   fire for all of them). ONE reader classifies by the Action line:
     AM01. Approved / FM Approved - Send to Contractor  → a job dispatched to us
                                                          (create/update the job)
     G01. Add a note, photo or document / "Additional information has been added"
                                                          → a note on an EXISTING
                                                          job (never create) → note
     anything else                                       → held for a human (review)
   The reference is the BARE incident (e.g. 00025826); its /N order rounds are
   linked as re-visits by /sla/inbound's matchSameIncident. Body layout:
     Helpdesk reference : 00029820
     Description : … ACCESS TIMES: …
     Site : SR00455 0414 - Chichester, Lavant Road (PFS)
     Address : Summersdale Retail Park,, Unit 2, …, PO19 5RD
     Telephone : 01243 539914
     Block : Forecourt
     Raised on : 15 September 2026 at 09:00
     Action : FM Approved - Send to Contractor, by Ian Blackwell
     Call status : With Contractor - R
     Urgency : Priority 2 */
function concertoHelpdesk(subject, t) {
  const sm = /^\s*Helpdesk action\s*-\s*(.+?)\s*:\s*(\d{5,12})\b/i.exec(subject);
  const action = (sm ? sm[1] : (line(/^\s*Action\s*:\s*([^\n,]+)/im, t))).trim();
  // "Additional information has been added" names the incident in the body only.
  const incident = (sm ? sm[2] : "")
    || line(/Helpdesk reference\s*:\s*(\d{5,12})/i, t)
    || line(/information has been added to\s*(\d{5,12})/i, t)
    || line(/\bfor\s+(\d{5,12})\b/i, t);
  const isNote = /add a note|photo or document|additional information/i.test(action)
    || /^\s*Additional information has been added/i.test(subject);
  // "Re-open order" = the client sends us back to a job ("leak is still there —
  // please re-attend"): a job to attend (it lands as a linked re-visit).
  const isDispatch = !isNote && (/\bapproved\b/i.test(action) || /send to contractor/i.test(action) || /\bre-?open/i.test(action));

  const desc = line(/^\s*Description\s*:\s*([\s\S]*?)(?:\n\s*(?:Site|Address|Telephone|Block|Raised on|Action|Call status)\s*:|$)/im, t).replace(/\s+/g, " ").trim();
  const siteLine = line(/^\s*Site\s*:\s*([^\n]+)/im, t);
  const sr = line(/\b(SR\d{4,6})\b/i, siteLine);
  const stripped = siteLine.replace(/^\s*SR\d{4,6}\s*/i, "").trim();
  const code = line(/^\s*(\d{3,5})\b/, stripped);
  const siteName = stripped.replace(/^\s*\d{3,5}\s*-\s*/, "").trim();
  const address = line(/^\s*Address\s*:\s*([^\n]+)/im, t).replace(/,\s*,+/g, ", ").trim();
  const postcode = (PC_RE.exec(address) || PC_RE.exec(siteLine) || [])[1] || "";
  const telephone = phoneIn(line(/^\s*Telephone\s*:\s*([^\n]+)/im, t));
  const pr = line(/^\s*Urgency\s*:\s*Priority\s*([1-4])/im, t) || line(/Priority\s*([1-4])/i, t);
  // "Raised on : 09 October 2026 at 15:03" (London wall clock).
  const ro = /Raised on\s*:\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})/i.exec(t);
  const raisedAt = ro && MON[ro[2].toLowerCase()] !== undefined ? londonToIso(+ro[3], MON[ro[2].toLowerCase()], +ro[1], +ro[4], +ro[5]) : "";
  const completeBy = concertoDate(line(/New target set to\s*([^\n.]+)/i, t));
  // The helpdesk's own free-text note under the fields ("Area Manager reporting
  // leak is still there - please re-attend.") — the reason for a re-open.
  const tail = (/^\s*Email\s*:[^\n]*\n([\s\S]*)$/im.exec(t) || [])[1] || "";
  const hdNote = tail.split("\n").map(x => x.trim())
    .filter(x => x && !/^(New target set to|Click here|For further information)/i.test(x) && !/^[A-Za-z ]{2,20}\s*:/.test(x))
    .join(" ").replace(/\s+/g, " ").trim().slice(0, 400);

  if (isNote) {
    // A store's note/chase on an existing job. Update-only downstream — it must
    // never CREATE a job (that's what the dispatch email is for).
    return { kind: "note", incident, note: { incident, reference: incident, text: desc, action, siteCode: code, siteName } };
  }
  const missing = [];
  if (!incident) missing.push("incident number");
  if (!desc) missing.push("description");
  if (!code) missing.push("store number");
  if (!isDispatch) missing.push("unrecognised Concerto action “" + (action || "?") + "” — confirm this is a job to attend");
  return {
    kind: "job", missing,
    fields: {
      isJob: true, reference: incident, priority: pr ? "Priority " + pr : "", siteCode: code,
      siteName: siteName || (address.split(",")[0] || "").trim(), address: address || siteName, postcode,
      telephone, description: hdNote ? desc + "\n\n" + action + ": " + hdNote : desc,
      raisedAt, respondBy: "", completeBy
    }
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

/* Chapplins CHASE / follow-up on an existing job (no "A new job has been raised"
   marker): e.g. "32c Archers Road - Southampton … the smell is getting a lot worse,
   could you contact the tenant". Never a new job — it is appended to the matching
   job's card + raised as a task (kind "note"). Matched to the job by a Job Number
   anywhere in the mail (incl. a quoted original), else by the property in the
   subject / a quoted "Property:" line. Remittances/invoices are not chases. */
function chapplinsNote(subject, t) {
  const subj = String(subject || "").replace(/^(?:\s*(?:re|fw|fwd|aw)\s*:\s*)+/i, "").trim();
  if (/remittance|payment advice|statement|invoice/i.test(subj)) return { kind: "notice", reason: "Chapplins accounts email — not a job" };
  let body = String(t || "");
  // Drop the outer forward header (From:/Sent:/To:/Subject:) then cut at a quoted original.
  const hdr = /^[\s_]*From:[^\n]*\n(?:[^\n]*\n){0,6}?\s*Subject:[^\n]*\n/i.exec(body);
  if (hdr && hdr.index < 200) body = body.slice(hdr.index + hdr[0].length);
  const q = /\n\s*(?:From:\s|-{3,}\s*Original Message|_{10,})/i.exec(body);
  let text = q ? body.slice(0, q.index) : body;
  const cut = CHAP_SIG.exec(text); if (cut) text = text.slice(0, cut.index);
  text = text.replace(/^\s*(?:Good (?:morning|afternoon|evening)[^\n]*|Hi[^\n]*|Hello[^\n]*|Dear[^\n]*)\n/i, "").replace(/\s+/g, " ").trim();
  const jobNo = line(/Job Number[:\s]*(\d{6,12})\b/i, subj) || line(/Job Number[:\s]*(\d{6,12})\b/i, t);
  const quotedProp = line(/^[ \t]*Property:[ \t]*([^\n]*)$/im, t);
  const property = (quotedProp || subj.replace(/\bP\s*[1-4]\b/ig, " ").replace(/\b(?:urgent|chase|chaser|update)\b/ig, " ").replace(/\s*-\s*$/,"").replace(/\s+/g, " ").trim());
  const reference = jobNo ? "CHAP-" + jobNo : "";
  return { kind: "note", incident: reference, note: { reference, incident: reference, property, client: "chapplins", text: text.slice(0, 1000), action: "Chapplins", by: "Chapplins Lettings" } };
}

/* ── Fareham Borough Council (FBC) — Jotform "Mostlane New Incident Form" ─────
   FBC officers log incidents on our Jotform; Jotform emails a fixed table from
   noreply@jotform.com, subject "Re: Mostlane New Incident Form". stripHtml lays
   each row as "<label> <value>" on one line (verified). Fields: Site (a pill),
   Site Address (name + street + postcode + hours + a ///what3words), Priority
   ("P3 (7 Days)"), Reported By, Job Title, Brief description of the issue, and
   "Quotation Required Before Works?" (Yes/No). The weekly "FBC Weekly Incident
   Report Update" digest is from the same sender but carries none of these value
   rows, so requiring the Quotation row (below) excludes it.
   No incident number exists, so the reference is a stable hash of the incident's
   own content — the same submission re-delivered yields the same ref (update, not
   duplicate); two different incidents at one site never collide on the site name. */
const djb2 = s => { let h = 5381; const str = String(s || ""); for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(16); };
function fbcJotform(subject, t) {
  const val = re => { const m = re.exec(t); return m ? String(m[1] || "").replace(/\s+/g, " ").trim() : ""; };
  // The "Site" answer is a dropdown: on some renders it sits on the SAME line as
  // the label, on others on the NEXT line. A value of "Other" means the reporter
  // typed a free location into the "Other" Site Address box instead of picking a
  // named building — so the real place lives in the (Other) Site Address block.
  let site = val(/^\s*Site[ \t]+(?!Address)(.+)$/im);
  if (!site) { const nx = (/^\s*Site[ \t]*\r?\n[ \t]*([^\r\n]+)/im.exec(t) || [])[1] || ""; if (nx && !/^(?:["']?Other["']?\s*)?Site Address\b/i.test(nx)) site = nx.replace(/\s+/g, " ").trim(); }
  const isOther = /^other$/i.test(site);
  // NB `$` under /m is end-of-LINE, so multi-line blocks end on the NEXT known
  // label, never `$`, or they'd capture only the first line. Accept a plain
  // "Site Address" OR an "Other" Site Address block, ending on the next label.
  const addrBlock = (/^\s*(?:["']?Other["']?\s+)?Site Address[ \t]+([\s\S]+?)\n\s*(?:(?:["']?Other["']?\s+)?Site Access|Priority|Reported By)\b/im.exec(t) || [])[1] || "";
  const postcode = (PC_RE.exec(addrBlock) || PC_RE.exec(t) || [])[1] || "";
  const w3w = (/(\/\/\/[a-z]+\.[a-z]+\.[a-z]+)/i.exec(addrBlock) || [])[1] || "";
  const HOURS_LINE = /^[ \t]*(?:out of hours|in hours|office hours|24\s*\/\s*7|24 hours|any ?time)[^\n]*$/im;
  const hours = ((/([A-Za-z][^\n]*?\d\s*(?:am|pm)[^\n]*)/i.exec(addrBlock) || [])[1] || ((HOURS_LINE.exec(addrBlock) || [])[0] || "")).trim();
  // Priority is a dropdown too: same-line on HTML renders, next-line on a plain
  // Outlook forward ("Priority\nP4 (14 Days)"). Read both.
  const prTxt = val(/^\s*Priority[ \t]+(P?\s*[1-5][^\n]*)$/im) || ((/^\s*Priority[ \t]*\r?\n[ \t]*(P?\s*[1-5][^\n]*)/im.exec(t) || [])[1] || "");
  // FBC's form has a P5 ("On next planned visit to site") — the portal's lowest SLA
  // is Priority 4, so P5 maps there and the client's own wording rides in the description.
  const prRaw = (/([1-5])/.exec(prTxt) || [])[1] || "";
  const prNum = prRaw === "5" ? "4" : prRaw;
  const reportedBy = val(/^\s*Reported By[ \t]+(.+)$/im);
  const jobTitle = val(/^\s*Job Title[ \t]+(.+)$/im);
  let desc = (/^\s*Brief description of the issue[ \t]+([\s\S]+?)\n\s*Quotation Required/im.exec(t) || [])[1] || "";
  desc = desc.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const quoteRequired = /Quotation Required Before Works\?\s+Yes\b/i.test(t);
  // The street address for display: the address block minus the hours + what3words.
  const streetAddr = addrBlock.replace(new RegExp(HOURS_LINE.source, "img"), " ").replace(/\/\/\/[a-z.]+/ig, " ").replace(/[A-Za-z][^\n]*\d\s*(?:am|pm)[^\n]*/ig, " ").replace(/\s*\n\s*/g, ", ").replace(/,\s*,+/g, ", ").replace(/[\s,]+$/g, "").replace(/\s+/g, " ").trim();
  // When the reporter picked "Other", the place name is the address's first
  // segment ("Fareham and Crofton Cricket Club, Bath Lane…" → the cricket club):
  // that name + the postcode resolve the known FBC site. An UNKNOWN place still
  // creates the job (with the address as its name) + a "link to a site" task — it
  // is never stuck in review for the want of a dropdown pick.
  const otherName = (addrBlock.split(/[,\n]/)[0] || "").replace(/\s+/g, " ").trim();
  const siteName = (site && !isOther) ? site : otherName;
  const reference = "FBC-" + djb2([siteName, reportedBy, desc.slice(0, 120), prNum].join("|"));
  const missing = [];
  // Only a truly unreadable submission (no name AND no postcode) holds for a human.
  if (!siteName && !postcode) missing.push("site");
  if (!desc) missing.push("description");
  return {
    kind: "job", missing,
    // Match on the SITE NAME (the "Site" pill = the register's site_name); the
    // postcode narrows first, the name disambiguates when a postcode is shared.
    siteLookup: { client: "fbc", address: siteName, postcode },
    fbc: { quoteRequired, reportedBy, jobTitle, w3w, hours, siteName },
    fields: {
      isJob: true, reference, priority: prNum ? "Priority " + prNum : "",
      siteCode: "", siteName, address: streetAddr || siteName, postcode,
      telephone: "", description: desc + (prRaw === "5" ? "\n\nClient priority: " + prTxt.replace(/\s+/g, " ").trim() : ""), raisedAt: "", respondBy: "", completeBy: "", storeType: "fbc"
    }
  };
}

/* ── The registry ─────────────────────────────────────────────────────────── */
export const TEMPLATES = [
  // replyOk: Jotform sends the incident form as "Re: Mostlane New Incident Form",
  // so these are exempt from the "a Re: subject is a reply, not a job" drop.
  { id: "fbc-jotform-digest", label: "Fareham BC — Jotform weekly digest (ignored)", domains: ["jotform.com"], replyOk: true,
    test: (s) => /Weekly Incident Report Update/i.test(s), read: () => ({ kind: "notice", reason: "Jotform weekly incident digest — a summary, not a job" }) },
  { id: "fbc-jotform", label: "Fareham BC — Jotform New Incident Form", domains: ["jotform.com"], replyOk: true,
    test: (s, t) => /Mostlane New Incident Form/i.test(s) && /Quotation Required Before Works/i.test(t), read: fbcJotform },
  { id: "concerto-job", label: "Concerto — New Job Alert (Southern Co-op)", domains: ["concerto.co.uk"],
    test: (s, t) => /New Job Alert/i.test(s) || /You have been assigned a new job/i.test(t), read: concertoJob },
  { id: "concerto-order", label: "Concerto — order sheet (client purchase order)", domains: ["concerto.co.uk"],
    test: (s, t) => /^Order number\s/i.test(s) || /attached order sheet for order number/i.test(t), read: concertoOrder },
  { id: "concerto-cancel", label: "Concerto — job cancelled by the client", domains: ["concerto.co.uk"],
    test: (s, t) => /^Cancell?l?ed Job\b/i.test(s) || /The job you logged\s*\d+[\s\S]{0,300}Has been Cancelled/i.test(t), read: concertoCancel },
  { id: "concerto-quote-cancel", label: "Concerto — quote request cancelled by the client", domains: ["concerto.co.uk"],
    test: (s, t) => (/^Quote\s*:/i.test(s) && /Cancel request/i.test(s)) || /Quote status\s*:\s*Cancelled/i.test(t), read: concertoQuoteCancel },
  { id: "concerto-helpdesk", label: "Concerto — helpdesk action (dispatch / note)", domains: ["concerto.co.uk"],
    test: (s) => /^Helpdesk action\b/i.test(s) || /^Additional information has been added/i.test(s), read: concertoHelpdesk },
  { id: "concerto-supplier-portal", label: "Concerto — supplier-portal batch notice", domains: ["concerto.co.uk"],
    test: (s) => /Supplier Portal/i.test(s), read: () => ({ kind: "notice", reason: "Concerto supplier-portal batch notice (e.g. PPM orders added) — not an individual job" }) },
  { id: "concerto-notice", label: "Concerto — quote notice", domains: ["concerto.co.uk"],
    test: (s) => /^Quote\s*:/i.test(s), read: () => ({ kind: "notice", reason: "Concerto quote notice, not a job" }) },
  { id: "chapplins-job", label: "Chapplins Lettings — new job raised", domains: ["chapplins.co.uk"],
    test: (s, t) => /A new job has been raised/i.test(t) && !/^\s*(?:re|aw)\s*:/i.test(s), read: chapplinsJob },
  // Anything else from Chapplins (a chase, a reply on a job thread) → a note on the job.
  { id: "chapplins-note", label: "Chapplins Lettings — chase / update on a job", domains: ["chapplins.co.uk"], replyOk: true,
    test: () => true, read: chapplinsNote },
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
  const want = normAddr(address);
  if (pc) {
    // The form's postcode can disagree with the register (Broadcut Depot is on the
    // register at PO16 8SP, the officer typed PO13 9FW): fall back to an EXACT,
    // unique site-name match across the client's sites.
    const byPc = rows.length ? rows.filter(r => normAddr(r.site_name) === want) : [];
    if (!byPc.length) {
      try {
        const all = ((await env.DB.prepare("SELECT site_number, site_name, postcode FROM sites WHERE tenant_id=? AND client=? AND active=1").bind(tid, client).all()).results) || [];
        const ex = all.filter(r => normAddr(r.site_name) === want);
        if (ex.length === 1) return { siteCode: ex[0].site_number, siteName: ex[0].site_name };
      } catch {}
    }
  }
  if (!rows.length) return null;
  const exact = rows.filter(r => normAddr(r.site_name) === want);
  if (exact.length === 1) return { siteCode: exact[0].site_number, siteName: exact[0].site_name };
  const head = want.split(" ").slice(0, 3).join(" ");
  const lead = head ? rows.filter(r => normAddr(r.site_name).startsWith(head + " ") || normAddr(r.site_name) === head) : [];
  if (lead.length === 1) return { siteCode: lead[0].site_number, siteName: lead[0].site_name };
  return null;
}
