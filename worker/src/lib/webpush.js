// Web Push (VAPID + RFC 8291 "aes128gcm") implemented on WebCrypto only, so it
// runs inside the Cloudflare Worker with no external dependencies.
//
//   sendPush(env, subscription, payloadString) -> Response
//
// subscription = { endpoint, keys: { p256dh, auth } } exactly as the browser's
// PushSubscription.toJSON() produces. A 201/200 means delivered to the push
// service; 404/410 means the subscription is dead and should be deleted.
//
// Secrets on the worker:
//   VAPID_PUBLIC   base64url of the uncompressed P-256 public point (0x04||x||y)
//   VAPID_PRIVATE  base64url of the P-256 private scalar d (JWK "d")
//   PUSH_CONTACT   (optional) "mailto:you@domain" for the VAPID "sub" claim

const enc = new TextEncoder();

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(buf) {
  const a = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, dataBytes));
}
// HKDF (extract + one expand block; every output here is <= 32 bytes).
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const t = await hmac(prk, concat(info, new Uint8Array([1])));
  return t.slice(0, length);
}

// RFC 8291 §3.4 content encryption. `asKey` is the ephemeral (application
// server) ECDH keypair; `salt` is 16 random bytes. Both are injectable so the
// implementation can be checked against fixed test vectors.
export async function encryptPayload(payloadBytes, uaPublicRaw, authSecret, salt, asKey) {
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKey.publicKey)); // 65 bytes
  const uaPubKey = await crypto.subtle.importKey("raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPubKey }, asKey.privateKey, 256));

  // IKM from the ECDH secret, keyed by the subscription's auth secret.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublicRaw, asPubRaw);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  // Content encryption key + nonce (RFC 8188), salted by the record salt.
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // Single record: plaintext followed by the 0x02 "last record" delimiter.
  const plaintext = concat(payloadBytes, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext));

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as public).
  const rs = 4096;
  const header = concat(
    salt,
    new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPubRaw.length]),
    asPubRaw
  );
  return concat(header, ciphertext);
}

async function importVapidPrivate(env) {
  const pub = b64urlToBytes(env.VAPID_PUBLIC); // 0x04 || x(32) || y(32)
  const jwk = {
    kty: "EC", crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: env.VAPID_PRIVATE, ext: true, key_ops: ["sign"]
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// RFC 8292 VAPID: a signed JWT bound to the push service origin.
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = bytesToB64url(enc.encode(JSON.stringify({ aud, exp, sub: env.PUSH_CONTACT || "mailto:admin@mostlane-portal.com" })));
  const signingInput = header + "." + payload;
  const key = await importVapidPrivate(env);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)));
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC}`;
}

// Send one push. Returns the fetch Response (caller handles 404/410 cleanup).
export async function sendPush(env, sub, payloadStr, ttl = 86400) {
  const uaPublic = b64urlToBytes(sub.keys.p256dh);
  const auth = b64urlToBytes(sub.keys.auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const asKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const body = await encryptPayload(enc.encode(payloadStr), uaPublic, auth, salt, asKey);
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuth(env, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(ttl)
    },
    body
  });
}
