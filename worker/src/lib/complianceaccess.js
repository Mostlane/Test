// Per-user compliance access model, shared by auth.js (/auth/me, login) and
// users.js (/users list + save). Each user has a LEVEL per compliance scheme:
//   "none"     — no access; the page/tile is hidden
//   "view"     — open the chart + open certificates on screen
//   "download" — view + download/export the certificate files
//   "edit"     — download + upload & manage documents and due dates
//
// Stored in users.profile.complianceAccess as { coop, fareham, chapplins, projects }.
// resolveComplianceAccess() turns the raw profile + permission flags into the
// authoritative per-scheme map the client trusts, with safe legacy defaults so
// nothing breaks before an admin has set anyone explicitly:
//   - Full-Access  -> "edit" on every scheme (the owner can never be scoped out)
//   - a scheme with an explicit stored level -> that level
//   - otherwise, legacy fallback: Compliance permission => office "edit" /
//     field "view"; no Compliance permission => "none".

export const COMPLIANCE_SCHEMES = [
  { key: "coop",      label: "Southern Co-op" },
  { key: "fareham",   label: "Fareham" },
  { key: "chapplins", label: "Chapplins" },
  { key: "projects",  label: "Projects" },
];
export const COMPLIANCE_LEVELS = ["none", "view", "download", "edit"];

function parseProfile(profile) {
  if (!profile) return {};
  if (typeof profile === "string") { try { return JSON.parse(profile) || {}; } catch { return {}; } }
  return typeof profile === "object" ? profile : {};
}
function yes(v) { return v === "Yes" || v === true; }

// Keep only valid scheme keys with valid level values — used before persisting.
export function sanitizeComplianceAccess(input) {
  const out = {};
  const src = (input && typeof input === "object") ? input : {};
  for (const s of COMPLIANCE_SCHEMES) {
    const v = String(src[s.key] == null ? "" : src[s.key]);
    if (COMPLIANCE_LEVELS.includes(v)) out[s.key] = v;
  }
  return out;
}

// The authoritative resolved { scheme: level } map for a user.
export function resolveComplianceAccess(profile, perms) {
  const p = parseProfile(profile);
  const pr = perms || {};
  const stored = (p.complianceAccess && typeof p.complianceAccess === "object") ? p.complianceAccess : null;
  const full = yes(pr.FullAccess);
  const office = p.staffType === "office";
  const legacy = full ? "edit" : (yes(pr.Compliance) ? (office ? "edit" : "view") : "none");
  const out = {};
  for (const s of COMPLIANCE_SCHEMES) {
    if (full) { out[s.key] = "edit"; continue; }
    const v = stored && stored[s.key] != null ? String(stored[s.key]) : null;
    out[s.key] = (v && COMPLIANCE_LEVELS.includes(v)) ? v : legacy;
  }
  return out;
}
