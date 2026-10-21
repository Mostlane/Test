// Daily email-intake check (21 Oct 2026, Jamie: "an automated check each day that
// will send an email with any issues so we can rectify"). Runs off the 5-minute
// cron once a morning (~07:30 London) and looks back over the last 24 h:
//   • every Concerto job email → is the job on the board AND its row on the Co-op
//     spreadsheet, with trade / mileage / type filled and a summarised description?
//   • emails that failed, are still waiting in "Needs a look", or came from a
//     known client but were ignored;
//   • rows still queued for the spreadsheet;
//   • a weekday with NO emails at all (the Outlook forward may have stopped).
// Sends ONLY when something needs fixing — an "all fine" email gets ignored.
import { sheetOrderRows, sheetOrderNo, coopSheetPending } from "./coopsheet.js";

const CFG = tid => "intakecheck:" + (Math.trunc(Number(tid)) || 1);
const SENT = tid => "intakecheck:sent:" + (Math.trunc(Number(tid)) || 1);
const RUN_HOUR = 7, RUN_MIN = 30;
const CONCERTO_JOB = /Helpdesk action - (?:FM Approved|AM01|Re-open)|New Job Alert/i;
const CLIENT_DOMAINS = /concerto\.co\.uk|jotform\.com|chapplins\.co\.uk/i;

function london(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return { dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday], hour: Number(p.hour === "24" ? 0 : p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ukTime = iso => { try { return new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };

export async function getIntakeCheckConfig(env, tid) {
  let c = {};
  try { const r = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(CFG(tid)).first(); if (r) c = JSON.parse(r.value) || {}; } catch {}
  return { enabled: c.enabled !== false, recipients: Array.isArray(c.recipients) ? c.recipients : [] };
}
export async function setIntakeCheckConfig(env, tid, { enabled, recipients }) {
  const cur = await getIntakeCheckConfig(env, tid);
  const next = { enabled: enabled === undefined ? cur.enabled : !!enabled,
    recipients: Array.isArray(recipients) ? recipients.map(x => String(x || "").trim().toLowerCase()).filter(x => /@/.test(x)).slice(0, 10) : cur.recipients };
  await env.DB.prepare("INSERT INTO app_config (key, value, tenant_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(CFG(tid), JSON.stringify(next), Math.trunc(Number(tid)) || 1).run();
  return next;
}
async function defaultRecipients(env) {
  const owner = env.OWNER_USERNAME || "Jamie Line";
  try { const r = await env.DB.prepare("SELECT email FROM users WHERE username=?").bind(owner).first(); if (r && r.email) return [r.email]; } catch {}
  return [];
}

// Build the list of issues for the window [since, now). Read-only.
export async function runIntakeCheck(env, tid, { hours = 24, silenceHours = null, cosmetic = true } = {}) {
  const now = new Date(), since = new Date(now.getTime() - hours * 3600e3).toISOString();
  const issues = []; // {section, ref, text, fix}
  let emails = [];
  try {
    const { results } = await env.DB.prepare("SELECT id, received_at, from_addr, orig_from, subject, outcome, reason, reference, job_id FROM inbound_emails WHERE received_at >= ? ORDER BY received_at").bind(since).all();
    emails = results || [];
  } catch (e) { issues.push({ section: "intake", text: "Couldn't read the email log: " + String(e.message || e).slice(0, 120) }); }

  // 1) Emails that didn't do their job.
  for (const e of emails) {
    const who = e.orig_from || e.from_addr || "";
    if (e.outcome === "failed") issues.push({ kind: "email_failed", emailId: e.id, section: "intake", ref: e.reference || "", text: `Email failed: “${e.subject}” — ${String(e.reason || "").slice(0, 160)}`, fix: "Open Email intake and press ↻ Re-run on it." });
    else if (e.outcome === "review") issues.push({ kind: "review", emailId: e.id, section: "intake", ref: e.reference || "", text: `Waiting in “Needs a look”: “${e.subject}”`, fix: "Open Email intake → Needs a look, check the fields and create the job (or dismiss)." });
    else if (e.outcome === "ignored" && CLIENT_DOMAINS.test(who)) issues.push({ kind: "ignored", emailId: e.id, section: "intake", ref: "", text: `A client email was ignored: “${e.subject}” from ${who}`, fix: "Check the sender is on the Email intake allow-list, then Re-run." });
  }

  // 2) Concerto jobs → on the board + on the spreadsheet, filled in.
  const jobs = emails.filter(e => (e.outcome === "created" || e.outcome === "updated") && CONCERTO_JOB.test(e.subject || ""));
  if (jobs.length) {
    const ids = [...new Set(jobs.map(j => j.job_id).filter(Boolean))];
    const onBoard = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try { const { results } = await env.DB.prepare(`SELECT id FROM sla_jobs WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all(); (results || []).forEach(r => onBoard.add(r.id)); } catch {}
    }
    const sheet = await sheetOrderRows(env, tid);
    if (!sheet.ok && !sheet.off) issues.push({ kind: "sheet_unreachable", section: "sheet", text: "Couldn't open the Co-op spreadsheet to check it: " + sheet.error, fix: "Check the file hasn't been moved/renamed and the Concerto tab still exists." });
    const seen = new Set();
    for (const j of jobs) {
      const order = sheetOrderNo(j.reference || "");
      if (!order || seen.has(order)) continue; seen.add(order);
      if (j.job_id && !onBoard.has(j.job_id)) issues.push({ kind: "board_missing", emailId: j.id, section: "board", ref: order, text: `Job ${order} came in at ${ukTime(j.received_at)} but is no longer on the board.`, fix: "Check it wasn't deleted by mistake (Email intake → Re-run puts it back)." });
      if (!sheet.ok || j.outcome !== "created") continue;
      const rows = sheet.byOrder[order.toLowerCase()];
      if (!rows) { issues.push({ kind: "sheet_missing", section: "sheet", ref: order, text: `${order} (${ukTime(j.received_at)}) is not on the spreadsheet.`, fix: "Email intake → 📊 Co-op spreadsheet → type the order → Add." }); continue; }
      if (rows.length > 1) issues.push({ kind: "sheet_dup", section: "sheet", ref: order, text: `${order} is on the spreadsheet ${rows.length} times (rows ${rows.map(r => r.row).join(", ")}).`, fix: "Delete the extra row(s)." });
      const r = rows[0], miss = [];
      if (!r.trade) miss.push("trade");
      if (!r.miles || r.miles === "0") miss.push("mileage");
      if (!r.type) miss.push("type");
      if (!r.name) miss.push("store name");
      if (miss.length) issues.push({ kind: "sheet_blank", section: "sheet", ref: order, text: `${order} (row ${r.row}) is missing: ${miss.join(", ")}.`, fix: "Fill in by hand, or Email intake → Add again (fills blanks only)." });
      else if (cosmetic && (/…$/.test(r.desc) || r.desc.length > 75)) issues.push({ kind: "sheet_desc", section: "sheet", ref: order, text: `${order} (row ${r.row}) has the long, cut-off description rather than a short summary.`, fix: "Retype column F if you want it tidy (cosmetic)." });
    }
  }

  // 3) Still queued for the spreadsheet (older than 30 min — the cron hasn't cleared them).
  for (const p of await coopSheetPending(env, tid)) {
    if (Date.now() - new Date(p.at).getTime() < 30 * 60e3) continue;
    issues.push({ kind: "sheet_pending", section: "sheet", ref: sheetOrderNo(p.reference), text: `${sheetOrderNo(p.reference)} has been waiting to go on the spreadsheet since ${ukTime(p.at)} (${p.tries || 0} tries): ${p.error || ""}`, fix: "Check the file isn't locked open/checked out; Email intake → Add it by hand." });
  }

  // 4) Silence on a working day = the forward has probably stopped.
  const sh = silenceHours || hours;
  const start = london(new Date(now.getTime() - sh * 3600e3)), recent = emails.filter(e => e.received_at >= new Date(now.getTime() - sh * 3600e3).toISOString());
  if (!recent.length && start.dow >= 1 && start.dow <= 5) issues.push({ kind: "silence", section: "intake", text: `No job emails at all reached the portal in the last ${sh} hours (a working day).`, fix: "Check the Outlook forwarding rule to the jobs@ address is still on, and Email Routing in Cloudflare." });

  return { since, until: now.toISOString(), emails: emails.length, concertoJobs: jobs.length, issues };
}

function renderEmail(res) {
  const sec = { intake: "📨 Emails", board: "📋 Job board", sheet: "📊 Co-op spreadsheet" };
  const groups = ["intake", "board", "sheet"].map(k => {
    const list = res.issues.filter(i => i.section === k);
    if (!list.length) return "";
    return `<h3 style="margin:18px 0 6px;color:#003366;font-size:15px">${sec[k]} (${list.length})</h3><ul style="margin:0;padding-left:18px">` +
      list.map(i => `<li style="margin:0 0 8px">${esc(i.text)}${i.fix ? `<br><span style="color:#5b6b7b;font-size:13px">→ ${esc(i.fix)}</span>` : ""}</li>`).join("") + "</ul>";
  }).join("");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f2438;max-width:640px">
<p>Morning — the daily intake check found <b>${res.issues.length} thing${res.issues.length === 1 ? "" : "s"}</b> to sort out
(${ukTime(res.since)} → ${ukTime(res.until)}: ${res.emails} email${res.emails === 1 ? "" : "s"} received, ${res.concertoJobs} Concerto job${res.concertoJobs === 1 ? "" : "s"}).</p>
${groups}
<p style="margin-top:20px"><a href="https://mostlane-portal.com/email-intake.html" style="background:#003366;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none">Open Email intake</a></p>
<p style="color:#8a97a5;font-size:12px">Sent automatically by the portal. You only get this email when something needs fixing.</p></div>`;
}

export async function sendIntakeCheck(env, tid, res, { force = false } = {}) {
  if (!res.issues.length && !force) return { ok: true, sent: false, reason: "nothing to report" };
  const cfg = await getIntakeCheckConfig(env, tid);
  const to = cfg.recipients.length ? cfg.recipients : await defaultRecipients(env);
  if (!to.length) return { ok: false, error: "no recipient — set one on the Email intake page" };
  const subject = res.issues.length ? `⚠ Portal intake check: ${res.issues.length} to fix` : "✅ Portal intake check: nothing to fix";
  const html = res.issues.length ? renderEmail(res) : `<p>The daily intake check found nothing to fix (${res.emails} emails, ${res.concertoJobs} Concerto jobs in the last 24 h).</p>`;
  const { sendSubconMail } = await import("../routes/sla.js");
  const r = await sendSubconMail(env, Math.trunc(Number(tid)) || 1, { to, subject, html });
  return { ok: !!r.ok, sent: !!r.ok, to, via: r.via, error: r.error };
}

// Cron: once a day from 07:30 London.
export async function sweepIntakeCheck(env, tid = 1) {
  const L = london();
  if (L.hour < RUN_HOUR || (L.hour === RUN_HOUR && L.minute < RUN_MIN)) return;
  const cfg = await getIntakeCheckConfig(env, tid);
  if (!cfg.enabled) return;
  try { const r = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(SENT(tid)).first(); if (r && r.value === L.date) return; } catch {}
  await env.DB.prepare("INSERT INTO app_config (key, value, tenant_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(SENT(tid), L.date, Math.trunc(Number(tid)) || 1).run();
  const res = await runIntakeCheck(env, tid, { hours: 24 });
  const s = await sendIntakeCheck(env, tid, res);
  if (res.issues.length) {
    try { const { sendToUser } = await import("../routes/push.js");
      await sendToUser(env, tid, env.OWNER_USERNAME || "Jamie Line", { title: `⚠ Intake check: ${res.issues.length} to fix`, body: res.issues.slice(0, 3).map(i => i.text).join(" · ").slice(0, 180), url: "/email-intake.html", tag: "intakecheck:" + L.date }); } catch {}
  }
  return s;
}

// ── Live issues for the ⚠ on the SLA board + sidebar ─────────────────────────
// A 7-day look-back so a problem stays flagged until it's actually fixed (not
// just until it ages out of 24 h); cosmetic description warnings are left to the
// morning email. Saved to app_config so every page load reads it for free.
const LIVE = tid => "intakecheck:live:" + (Math.trunc(Number(tid)) || 1);
const FIXABLE = { sheet_missing: 1, sheet_blank: 1, sheet_pending: 1 };
export async function refreshLiveIssues(env, tid) {
  const res = await runIntakeCheck(env, tid, { hours: 168, silenceHours: 24, cosmetic: false });
  const issues = res.issues.map(i => ({ ...i, id: (i.kind || "x") + ":" + (i.ref || i.emailId || ""), fixable: !!FIXABLE[i.kind] }));
  const live = { at: new Date().toISOString(), issues };
  await env.DB.prepare("INSERT INTO app_config (key, value, tenant_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(LIVE(tid), JSON.stringify(live), Math.trunc(Number(tid)) || 1).run();
  return live;
}
export async function getLiveIssues(env, tid) {
  try { const r = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(LIVE(tid)).first(); if (r) return JSON.parse(r.value); } catch {}
  return null;
}
// Cron: every 15 minutes.
export async function sweepLiveIssues(env, tid = 1) {
  const cur = await getLiveIssues(env, tid);
  if (cur && Date.now() - new Date(cur.at).getTime() < 14 * 60e3) return cur;
  return refreshLiveIssues(env, tid);
}
