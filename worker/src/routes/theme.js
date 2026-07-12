// Per-user personalisation: accent colour theme + main-menu background.
// Preferences live in users.profile.theme and follow the user across devices.
// What each person may change is controlled per user in Users admin:
//   ThemeColour     — may pick a colour theme
//   ThemeBackground — may change the menu background (block colour / own photo)
// FullAccess implies both. The server filters, so a revoked permission also
// stops an already-saved preference from being served.
//
//   GET  /theme            -> { ok, theme, can:{colour,background} }
//   POST /theme            -> save { accent?, bg? }  (validated + gated)
//   POST /theme/background -> multipart photo upload -> R2, returns key

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";

const ACCENTS = ["blue", "teal", "green", "purple", "burgundy", "orange", "slate", "midnight"];
const BG_COLOURS = ["sky", "sand", "sage", "blush", "lavender", "steel"];

async function caps(env, username) {
  const perms = await permissionsFor(env, username);
  const full = perms.FullAccess === "Yes";
  return {
    colour: full || perms.ThemeColour === "Yes",
    background: full || perms.ThemeBackground === "Yes",
  };
}

function filterTheme(theme, can) {
  const t = {};
  if (can.colour && ACCENTS.includes(theme.accent)) t.accent = theme.accent;
  if (can.background && theme.bg && typeof theme.bg === "object") t.bg = theme.bg;
  return t;
}

export async function handle(request, env, ctx, url) {
  const cors = corsHeaders(env, request);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  const sess = await requireSession(env, request);
  if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
  const me = sess.user.username;

  if (method === "GET" && pathname === "/theme") {
    const can = await caps(env, me);
    const row = await env.DB.prepare("SELECT profile FROM users WHERE username=?").bind(me).first();
    let profile = {}; try { profile = row?.profile ? JSON.parse(row.profile) : {}; } catch {}
    return json({ ok: true, theme: filterTheme(profile.theme || {}, can), can });
  }

  if (method === "POST" && pathname === "/theme") {
    const can = await caps(env, me);
    if (!can.colour && !can.background) return json({ ok: false, error: "Personalisation isn't enabled for your account" }, 403);
    const b = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT profile FROM users WHERE username=?").bind(me).first();
    let profile = {}; try { profile = row?.profile ? JSON.parse(row.profile) : {}; } catch {}
    const t = profile.theme || {};

    if (b.accent !== undefined && can.colour) {
      if (!ACCENTS.includes(b.accent)) return json({ ok: false, error: "Unknown colour theme" }, 400);
      t.accent = b.accent;
    }
    if (b.bg !== undefined && can.background) {
      const bg = b.bg || {};
      if (bg.type === "emboss" || !bg.type) delete t.bg;   // back to the default
      else if (bg.type === "colour" && BG_COLOURS.includes(bg.value)) t.bg = { type: "colour", value: bg.value };
      else if (bg.type === "image" && typeof bg.value === "string" && bg.value.startsWith(`theme/${me}/`)) t.bg = { type: "image", value: bg.value };
      else return json({ ok: false, error: "Unknown background choice" }, 400);
    }

    profile.theme = t;
    await env.DB.prepare("UPDATE users SET profile=?, updated_at=datetime('now') WHERE username=?")
      .bind(JSON.stringify(profile), me).run();
    return json({ ok: true, theme: filterTheme(t, can), can });
  }

  // Custom background photo -> R2 (old ones for this user are cleaned up).
  if (method === "POST" && pathname === "/theme/background") {
    const can = await caps(env, me);
    if (!can.background) return json({ ok: false, error: "Background changes aren't enabled for your account" }, 403);
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    if (!file || typeof file === "string") return json({ ok: false, error: "Missing file" }, 400);
    if (!/^image\//.test(file.type || "")) return json({ ok: false, error: "That isn't an image" }, 400);
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > 4 * 1024 * 1024) return json({ ok: false, error: "Image too large — try again (it should be under 4 MB)" }, 400);

    const prefix = `theme/${me}/`;
    const old = await env.ASSET_BUCKET.list({ prefix });
    for (const o of old.objects || []) await env.ASSET_BUCKET.delete(o.key);

    const ext = (file.type === "image/png") ? "png" : "jpg";
    const key = `${prefix}bg-${Date.now()}.${ext}`;
    await env.ASSET_BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type || "image/jpeg" } });
    return json({ ok: true, key, url: `${url.origin}/asset-image?key=${encodeURIComponent(key)}` });
  }

  return json({ ok: false, error: "Not found: " + pathname }, 404);
}
