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

export function welcomeEmail({ name, username, setUrl, ttlHours }) {
  return {
    subject: `Welcome to ${BRAND} — set your password`,
    html: shell(`
      <p>Hi ${esc(name)},</p>
      <p>An account has been created for you on the ${BRAND} portal.</p>
      <p style="margin:6px 0;"><strong>Username:</strong> ${esc(username)}</p>
      <p>Click below to set your password and get started:</p>
      <p style="margin:22px 0;">${button(setUrl, "Set your password")}</p>
      <p style="color:#6b7280;font-size:12px;">This link expires in ${ttlHours} hours. If it expires, use
      &ldquo;Forgot password&rdquo; on the login page to get a new one.</p>
    `),
  };
}

export function resetEmail({ name, resetUrl }) {
  return {
    subject: `${BRAND} password reset`,
    html: shell(`
      <p>Hi ${esc(name)},</p>
      <p>We received a request to reset your ${BRAND} portal password.</p>
      <p style="margin:22px 0;">${button(resetUrl, "Reset your password")}</p>
      <p style="color:#6b7280;font-size:12px;">This link expires in 1 hour. If you didn&rsquo;t request this you can
      ignore this email &mdash; your password won&rsquo;t change.</p>
    `),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shell(inner) {
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr><td style="background:#003b82;padding:16px 24px;color:#fff;font-size:18px;font-weight:700;">${BRAND}</td></tr>
      <tr><td style="padding:24px;font-size:14px;line-height:1.55;">${inner}</td></tr>
      <tr><td style="padding:14px 24px;background:#f9fafb;color:#6b7280;font-size:11px;border-top:1px solid #eee;">
        Automated message from the ${BRAND} portal.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#1e66ff;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;">${label}</a>`;
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
