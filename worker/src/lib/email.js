// Email sending for the Mostlane portal — all in-Worker.
//
// Provider priority:
//   1. Resend HTTP API   (env.RESEND_API_KEY)      — free tier, preferred
//   2. Generic webhook   (env.RESET_EMAIL_WEBHOOK) — e.g. Zapier → Outlook/365
//   3. No-op             — logs a warning so it's visible in `wrangler tail`
//
// The only external dependency is a single email API key (or webhook URL);
// nothing else needs setting up.

const BRAND = "Mostlane";

// Front-end base URL (where reset-password.html lives), trailing slash stripped.
// Defaults to the live portal so no env var is required.
export function appBase(env) {
  return (env.APP_BASE_URL || "https://mostlane-portal.com").replace(/\/$/, "");
}

// Issue a single-use password token. Reused for both "forgot password" and the
// "set your password" welcome link (same reset-password.html page consumes it).
export async function issuePasswordToken(env, username, ttlHours = 1) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO password_resets (token, username, expires_at) VALUES (?,?,?)"
  ).bind(token, username, expires).run();
  return token;
}

// Send one email. Returns { ok, via } on success, or { ok:false, skipped|error }.
export async function sendEmail(env, { to, subject, html, text }) {
  if (!to) return { ok: false, skipped: true, reason: "no recipient" };
  const body = text || stripHtml(html);

  // 1) Resend — simple HTTPS POST, works from a Worker, free tier.
  if (env.RESEND_API_KEY) {
    const from = env.EMAIL_FROM || `${BRAND} <no-reply@mostlane-portal.com>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to, subject, html, text: body }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error("Resend send failed:", res.status, errBody);
        return { ok: false, status: res.status, error: errBody };
      }
      return { ok: true, via: "resend" };
    } catch (e) {
      console.error("Resend send error:", e.message);
      return { ok: false, error: e.message };
    }
  }

  // 2) Legacy/optional webhook (e.g. a Zapier Catch Hook that emails via 365).
  if (env.RESET_EMAIL_WEBHOOK) {
    try {
      await fetch(env.RESET_EMAIL_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, html, text: body }),
      });
      return { ok: true, via: "webhook" };
    } catch (e) {
      console.error("Email webhook failed:", e.message);
      return { ok: false, error: e.message };
    }
  }

  // 3) Nothing configured.
  console.warn(`No email provider set (RESEND_API_KEY / RESET_EMAIL_WEBHOOK) — "${subject}" to ${to} was NOT sent.`);
  return { ok: false, skipped: true, reason: "no provider" };
}

// ── Templates ───────────────────────────────────────────────────────────────

export function welcomeEmail({ name, username, setUrl, ttlHours, appUrl }) {
  return {
    subject: `Welcome to ${BRAND} — set your password`,
    html: shell(`
      <h1 style="margin:0 0 14px;font-size:21px;font-weight:700;color:#003b82;">Welcome to ${BRAND}</h1>
      <p style="margin:0 0 14px;">Hi ${esc(name)}, an account has been created for you on the ${BRAND} portal.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;background:#f3f6fb;border:1px solid #e1e9f5;border-radius:10px;">
        <tr><td style="padding:12px 16px;">
          <div style="font-size:12px;color:#6b7a90;text-transform:uppercase;letter-spacing:.04em;">Your username</div>
          <div style="font-size:16px;font-weight:700;color:#0f2a52;margin-top:2px;">${esc(username)}</div>
        </td></tr>
      </table>
      <p style="margin:0 0 6px;">Set your password to get started:</p>
      ${button(setUrl, "Set your password")}
      <p style="margin:18px 0 0;color:#8a94a3;font-size:13px;">This link expires in ${ttlHours} hours. If it expires, just use
      &ldquo;Forgot password&rdquo; on the sign-in page to get a fresh one.</p>
    `, appUrl),
  };
}

export function resetEmail({ name, resetUrl, appUrl }) {
  return {
    subject: `${BRAND} — password reset`,
    html: shell(`
      <h1 style="margin:0 0 14px;font-size:21px;font-weight:700;color:#003b82;">Password reset</h1>
      <p style="margin:0 0 16px;">Hi ${esc(name)}, we received a request to reset your ${BRAND} portal password. Click below to choose a new one:</p>
      ${button(resetUrl, "Reset your password")}
      <p style="margin:18px 0 0;color:#8a94a3;font-size:13px;">This link expires in 1 hour. If you didn&rsquo;t request this you can safely
      ignore this email &mdash; your password won&rsquo;t change.</p>
    `, appUrl),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Branded HTML shell: gradient brand bar, centred logo, content, footer.
// Table-based + inline styles for broad email-client support (incl. Outlook).
function shell(inner, appUrl) {
  const base = (appUrl || "https://mostlane-portal.com").replace(/\/$/, "");
  const logo = `${base}/mostlane-logo.jpg`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef1f4;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${BRAND} portal notification</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e6ea;box-shadow:0 8px 24px rgba(15,23,42,0.08);">
        <tr><td style="height:6px;line-height:6px;font-size:0;background:#1e66ff;background:linear-gradient(90deg,#003b82,#1e66ff);">&nbsp;</td></tr>
        <tr><td align="center" style="padding:26px 24px 6px;">
          <img src="${logo}" alt="${BRAND}" height="46" style="height:46px;display:block;border:0;outline:none;text-decoration:none;">
        </td></tr>
        <tr><td style="padding:10px 32px 28px;color:#26303d;font-size:15px;line-height:1.6;">${inner}</td></tr>
        <tr><td style="padding:16px 32px;background:#f7f9fb;border-top:1px solid #edf0f4;color:#8a94a3;font-size:12px;line-height:1.5;">
          ${BRAND} Portal &middot; automated message.<br>If you weren&rsquo;t expecting this, you can ignore it.
        </td></tr>
      </table>
      <div style="max-width:480px;color:#aab2bd;font-size:11px;padding:12px 0;">&copy; ${BRAND}</div>
    </td></tr>
  </table>
</body></html>`;
}

// Bulletproof (table-based) call-to-action button.
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0;"><tr>
    <td align="center" style="border-radius:8px;background:#1e66ff;">
      <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
    </td></tr></table>`;
}

function stripHtml(html = "") {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .trim();
}

function esc(s = "") {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
