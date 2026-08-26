// Customer status-change emails + the "this time doesn't suit" reschedule flow.
//
// When a job's status changes to one the office has enabled (Scheduled,
// Travelling, …) we send a branded HTML email to the site contact (falling back
// to the customer). Scheduling emails carry a signed link to a public,
// no-login page where the customer can flag the slot, leave a note and suggest
// alternative times — which posts back and notifies the office.
//
// Config lives in app_config key `sla_status_emails` (per tenant). Reschedule
// responses live in the self-migrating `job_reschedule_requests` table.

import { sendEmail, appBase } from "./email.js";

const CFG_KEY = "sla_status_emails";

// The statuses the office can wire an email onto. Keys MUST match the app's
// normalized job statuses. Scheduled + Travelling are ON by default (matching
// the customer's current setup); the rest are available but off.
export const STATUS_DEFS = [
  { key: "Scheduled",  label: "Scheduled",           reschedule: true,  defaultOn: true },
  { key: "Travelling", label: "On our way / Travelling", reschedule: false, defaultOn: true },
  { key: "In Progress", label: "Job started",         reschedule: false, defaultOn: false },
  { key: "Complete",   label: "Completed",            reschedule: false, defaultOn: false },
  { key: "On Hold",    label: "On Hold / Delayed",    reschedule: false, defaultOn: false },
];

function defaultTemplates() {
  return {
    Scheduled: {
      on: true,
      subject: "Your job {job_ref} at {site_name} has been booked in",
      intro: "Good news — your job has been scheduled. The details are below. The time is approximate; you'll get another email when our engineer is on the way.",
      reschedule: true,
    },
    Travelling: {
      on: true,
      subject: "We're on our way to {site_name}",
      intro: "Just to let you know, a Mostlane engineer is now on their way to complete your job.",
      reschedule: false,
    },
    "In Progress": {
      on: false,
      subject: "Work has started at {site_name}",
      intro: "Our engineer has arrived on site and started work on your job.",
      reschedule: false,
    },
    Complete: {
      on: false,
      subject: "Job {job_ref} at {site_name} is complete",
      intro: "Your job has now been completed. Thank you for choosing Mostlane.",
      reschedule: false,
    },
    "On Hold": {
      on: false,
      subject: "Update on your job {job_ref} at {site_name}",
      intro: "Your job has been placed on hold. We'll be in touch shortly with an update.",
      reschedule: false,
    },
  };
}

export function defaultConfig() {
  return {
    enabled: false,            // global master OFF until the office turns it on
    recipientRule: "siteThenCustomer",
    fromName: "Mostlane",
    replyTo: "enquiries@mostlane.com",
    companyTel: "023 8026 2000",
    statuses: defaultTemplates(),
  };
}

function tdb(env) { return env.DB; }

export async function getStatusEmailConfig(env, tid) {
  try {
    const row = await tdb(env).prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
      .bind(tid, CFG_KEY).first();
    if (row && row.value) {
      const cfg = JSON.parse(row.value);
      // merge over defaults so a new status key always exists
      const base = defaultConfig();
      return { ...base, ...cfg, statuses: { ...base.statuses, ...(cfg.statuses || {}) } };
    }
  } catch { /* fall through to defaults */ }
  return defaultConfig();
}

export async function saveStatusEmailConfig(env, tid, cfg) {
  const clean = { ...defaultConfig(), ...cfg };
  await tdb(env).prepare(
    "INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tid, CFG_KEY, JSON.stringify(clean)).run();
  return clean;
}

// ── reschedule requests table ──────────────────────────────────────────────
export async function ensureReschedTable(env) {
  await tdb(env).prepare(`CREATE TABLE IF NOT EXISTS job_reschedule_requests (
    id TEXT PRIMARY KEY, tenant_id TEXT, job_id TEXT, job_ref TEXT, site_name TEXT,
    note TEXT, suggestions TEXT, created_at TEXT, status TEXT DEFAULT 'open',
    resolved_at TEXT, resolved_by TEXT, ip TEXT
  )`).run();
}

// ── recipient resolution ───────────────────────────────────────────────────
// Site contact email (by the job's site code / name) then the customer email
// stored on the job, if any. Returns "" when nothing is on file.
export async function resolveRecipient(env, tid, job, cfg) {
  const rule = (cfg && cfg.recipientRule) || "siteThenCustomer";
  const emailOf = (s) => {
    const e = String(s || "").trim();
    return /\S+@\S+\.\S+/.test(e) ? e : "";
  };
  let siteEmail = "";
  const code = String(job.siteCode || "").trim();
  const name = String(job.siteName || "").trim();
  if (code || name) {
    try {
      const row = await tdb(env).prepare(
        `SELECT data FROM sites WHERE tenant_id=? AND (site_number=? OR lower(site_name)=lower(?)) LIMIT 1`
      ).bind(tid, code, name).first();
      if (row && row.data) {
        try { siteEmail = emailOf(JSON.parse(row.data).email); } catch {}
      }
    } catch {}
  }
  const custEmail = emailOf(job.customerEmail || job.contactEmail || (job.customer && job.customer.email));
  if (rule === "siteOnly") return siteEmail;
  return siteEmail || custEmail;
}

// ── template fill + HTML render ────────────────────────────────────────────
function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  try {
    return d.toLocaleString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
    });
  } catch { return d.toISOString(); }
}

function vars(job) {
  return {
    "{job_ref}": String(job.helpdeskRef || job.reference || job.id || "").trim(),
    "{job_name}": String(job.helpdeskRef || job.siteName || "").trim(),
    "{site_name}": String(job.siteName || "").trim(),
    "{site_address}": [job.address, job.postcode].filter(Boolean).join(", "),
    "{status}": String(job.status || "").trim(),
    "{scheduled}": fmtWhen(job.scheduledAt),
    "{description}": String(job.description || "").trim(),
  };
}

function fill(str, v) {
  let out = String(str || "");
  for (const [k, val] of Object.entries(v)) out = out.split(k).join(val || "");
  return out;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Build the branded HTML + plain-text bodies for one status email.
export function renderStatusEmail({ env, job, tpl, statusDef, rescheduleUrl }) {
  const v = vars(job);
  const subject = fill(tpl.subject, v) || `Update on your job ${v["{job_ref}"]}`;
  const intro = fill(tpl.intro, v);
  const base = appBase(env);
  const logo = `${base}/mostlane-logo.jpg`;
  const navy = "#003468", ink = "#1f2937", grey = "#6b7280", line = "#e5e7eb";

  const rows = [];
  const addRow = (k, val) => { if (val) rows.push(`<tr><td style="padding:6px 0;color:${grey};font-size:13px;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:${ink};font-size:14px;font-weight:600">${esc(val)}</td></tr>`); };
  addRow("Reference", v["{job_ref}"]);
  addRow("Site", v["{site_name}"]);
  addRow("Address", v["{site_address}"]);
  if (statusDef && statusDef.key === "Scheduled") addRow("Scheduled for", v["{scheduled}"]);
  addRow("Status", v["{status}"]);

  const rescheduleBlock = rescheduleUrl ? `
    <tr><td style="padding:24px 0 4px">
      <div style="font-size:14px;color:${ink};margin-bottom:12px">Does this time not suit you?</div>
      <a href="${esc(rescheduleUrl)}" style="display:inline-block;background:${navy};color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:8px">Let us know a better time</a>
      <div style="font-size:12px;color:${grey};margin-top:10px">Tap the button to send us a note or suggest alternative times — no login needed.</div>
    </td></tr>` : "";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f8;font-family:Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ${line}">
        <tr><td style="background:${navy};padding:20px 28px">
          <img src="${esc(logo)}" alt="Mostlane" height="34" style="height:34px;display:block;border:0" />
        </td></tr>
        <tr><td style="padding:28px 28px 8px">
          <div style="font-size:20px;font-weight:700;color:${ink};margin-bottom:8px">${esc(fill(tpl.subject, v))}</div>
          <div style="font-size:15px;color:${ink};line-height:1.5">${esc(intro)}</div>
        </td></tr>
        <tr><td style="padding:8px 28px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${line};border-bottom:1px solid ${line};margin:12px 0">${rows.join("")}</table>
        </td></tr>
        ${rescheduleBlock ? `<tr><td style="padding:0 28px">${rescheduleBlock}</td></tr>` : ""}
        <tr><td style="padding:24px 28px 28px">
          <div style="font-size:13px;color:${grey};line-height:1.5">
            Kind regards,<br><strong style="color:${ink}">Mostlane</strong><br>
            ${esc((tpl && tpl.companyTel) || "")}
          </div>
        </td></tr>
      </table>
      <div style="max-width:560px;margin:14px auto 0;font-size:11px;color:#9aa4b2;text-align:center">This is an automated message about your job. Please do not reply directly — contact us on the number above.</div>
    </td></tr>
  </table></body></html>`;

  const textLines = [
    fill(tpl.subject, v), "", intro, "",
    v["{job_ref}"] ? `Reference: ${v["{job_ref}"]}` : "",
    v["{site_name}"] ? `Site: ${v["{site_name}"]}` : "",
    v["{site_address}"] ? `Address: ${v["{site_address}"]}` : "",
    (statusDef && statusDef.key === "Scheduled" && v["{scheduled}"]) ? `Scheduled for: ${v["{scheduled}"]}` : "",
    `Status: ${v["{status}"]}`, "",
    rescheduleUrl ? `Does this time not suit? Let us know here: ${rescheduleUrl}` : "",
    "", "Kind regards, Mostlane",
  ].filter(Boolean);

  return { subject, html, text: textLines.join("\n") };
}

// ── signed reschedule link ─────────────────────────────────────────────────
// Reuses the file-signing secret (HMAC-SHA256) so the customer link can't be
// forged and expires. key = "resched:<jobId>".
async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function signSecret(env) { return (env && (env.FILE_SIGNING_SECRET || env.PORTAL_BRIDGE_SECRET)) || ""; }

export async function reschedURL(env, jobId, ttlSec = 60 * 60 * 24 * 30) {
  const base = appBase(env);
  const secret = signSecret(env);
  const key = "resched:" + jobId;
  if (!secret) return `${base}/job-reschedule.html?jobId=${encodeURIComponent(jobId)}`;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacHex(secret, key + "|" + exp);
  return `${base}/job-reschedule.html?jobId=${encodeURIComponent(jobId)}&exp=${exp}&sig=${sig}`;
}

export async function verifyResched(env, jobId, exp, sig) {
  const secret = signSecret(env);
  if (!secret) return true;               // no secret configured → open (dev)
  const e = parseInt(exp || "0", 10);
  if (!e || !sig) return false;
  if (Math.floor(Date.now() / 1000) > e) return false;
  const good = await hmacHex(secret, "resched:" + jobId + "|" + e);
  if (good.length !== String(sig).length) return false;
  let diff = 0;
  for (let i = 0; i < good.length; i++) diff |= good.charCodeAt(i) ^ String(sig).charCodeAt(i);
  return diff === 0;
}

// ── the transition hook ────────────────────────────────────────────────────
// Called after a job's status changes. Fire-and-forget via ctx.waitUntil.
// Never throws to the caller.
export async function onStatusTransition(env, tid, job, prevStatus, newStatus) {
  try {
    if (!newStatus || prevStatus === newStatus) return;
    const cfg = await getStatusEmailConfig(env, tid);
    if (!cfg.enabled) return;
    const tpl = cfg.statuses && cfg.statuses[newStatus];
    if (!tpl || !tpl.on) return;
    const to = await resolveRecipient(env, tid, job, cfg);
    if (!to) return;                       // no email on file → silently skip
    const statusDef = STATUS_DEFS.find(s => s.key === newStatus) || { key: newStatus };
    tpl.companyTel = cfg.companyTel;
    let rescheduleUrl = "";
    if (tpl.reschedule && statusDef.reschedule) rescheduleUrl = await reschedURL(env, job.id);
    const { subject, html, text } = renderStatusEmail({ env, job, tpl, statusDef, rescheduleUrl });
    await sendEmail(env, { to, subject, html, text, replyTo: cfg.replyTo });
  } catch { /* never break a status change over an email */ }
}
