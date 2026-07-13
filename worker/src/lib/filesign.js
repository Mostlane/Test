// Signed, expiring URLs for R2-backed files (site documents, site/job photos).
//
// Why: those files live in the JOB_FILES bucket and were handed out as raw,
// permanent public URLs — anyone with the link could fetch them forever, with
// no login. These helpers let an *authenticated* endpoint mint a URL that:
//   • routes through the worker (so we control access + send CORS for PDF.js),
//   • carries an HMAC signature over the key so it can't be forged/enumerated,
//   • expires, so a leaked or cached link stops working.
//
// The signing key is a server secret (never shipped to the browser). We reuse
// PORTAL_BRIDGE_SECRET if a dedicated FILE_SIGNING_SECRET isn't set, so the
// protection turns on automatically. If NO secret is configured the helpers
// degrade to unsigned worker URLs and the stream route stays open (legacy
// behaviour) — so a mis-config never locks anyone out of their own files.

function fileSecret(env) {
  return (env && (env.FILE_SIGNING_SECRET || env.PORTAL_BRIDGE_SECRET)) || "";
}

export function fileSigningEnabled(env) {
  return !!fileSecret(env);
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Build a worker URL for a file. Signed + expiring when a secret exists,
// otherwise a plain worker URL (still proxied + CORS'd, just not access-gated).
// streamPath is the route that serves the bytes, e.g. "/sla/site/doc".
export async function signedFileUrl(env, origin, streamPath, key, ttlSec = 604800) {
  const base = `${origin}${streamPath}?key=${encodeURIComponent(key)}`;
  const secret = fileSecret(env);
  if (!secret) return base;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacHex(secret, key + "|" + exp);
  return `${base}&exp=${exp}&sig=${sig}`;
}

// Verify a request's ?exp=&sig= against the key. Returns true only for a live,
// correctly-signed link. When no secret is configured this returns true (the
// route falls back to its legacy open behaviour — see note above).
export async function verifyFileSig(env, key, params) {
  const secret = fileSecret(env);
  if (!secret) return true;
  const exp = parseInt(params.get("exp") || "0", 10);
  const sig = params.get("sig") || "";
  if (!exp || !sig) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const good = await hmacHex(secret, key + "|" + exp);
  if (good.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < good.length; i++) diff |= good.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
