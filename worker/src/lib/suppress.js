// Admin notification suppression — lets an admin silence a pop-up/reminder and
// its red badge without deleting the underlying thing (asset, van check, etc).
//
// A rule matches a notification by TYPE plus an optional target:
//   • global      : { type }                       → mute this type for everyone
//   • per-user    : { type, user }                 → mute this type for one user
//   • one item    : { type, user, key }            → mute a single item for a user
//   • one item all: { type, key }                  → mute a single item for everyone
//
// Types currently understood: "asset-transfer", "asset-confirm", "vehicle-check".
// Rules live in app_config (tenant-scoped) as a JSON array.

const KEY = tid => `notify:suppress:${tid}`;

export async function getRules(env, tenantId) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(KEY(tenantId)).first();
    if (row && row.value) { const v = JSON.parse(row.value); if (Array.isArray(v)) return v; }
  } catch { /* fall through */ }
  return [];
}

export async function saveRules(env, tenantId, rules) {
  await env.DB.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tenantId, KEY(tenantId), JSON.stringify(rules)).run();
  return rules;
}

// Is a notification of (type) for (user), optionally about item (key), muted?
export function isSuppressed(rules, type, user, key) {
  if (!rules || !rules.length) return false;
  const u = String(user || "").toLowerCase();
  const k = key == null ? null : String(key);
  for (const r of rules) {
    if (r.type !== type) continue;
    const ru = (r.user == null || r.user === "") ? null : String(r.user).toLowerCase();
    const rk = (r.key == null || r.key === "") ? null : String(r.key);
    if (ru === null && rk === null) return true;                              // whole type, everyone
    if (ru !== null && rk === null && ru === u) return true;                  // whole type, this user
    if (ru !== null && rk !== null && ru === u && rk === k) return true;      // one item, this user
    if (ru === null && rk !== null && rk === k) return true;                  // one item, everyone
  }
  return false;
}
