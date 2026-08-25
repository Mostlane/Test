// CCTV Wall — DVR snapshot proxy.
// ---------------------------------------------------------------------------
// A browser on the HTTPS portal can't load a JPEG straight off a site DVR:
//   • mixed content (HTTPS page -> HTTP DVR is blocked), and
//   • Annke/Hikvision snapshots need DIGEST auth, which an <img> can't do.
// So the worker fetches the snapshot server-side (digest handshake here),
// hiding the DVR login from the browser and serving the JPEG back over HTTPS.
//
// Config (Full-Access only) lives in app_config key `cctv:sites`:
//   [{ id, name, host, port, https, user, pass, vendor, path, cameras:[{id,name,ch}] }]
// Passwords are stored server-side and never returned to the client.
//
//   GET  /cctv/sites            -> { ok, sites:[…] }  (no passwords; signed snapshot URLs)
//   POST /cctv/site             -> upsert a site (Full-Access)
//   POST /cctv/site/delete      -> { id }             (Full-Access)
//   GET  /cctv/snapshot?key=&exp=&sig=  -> image/jpeg (PUBLIC, signature-verified)
//
// Reachability note: Cloudflare Workers can only fetch a small set of outbound
// ports. HTTP 80/8080/8880/2052/2082/2086/2095 and HTTPS 443/8443/2053/2083/
// 2087/2096 are the safe ones — forward each DVR to one of those (8080 is
// easiest). Prefer HTTP forwarding: the worker->DVR hop is server-side, and a
// DVR's self-signed HTTPS cert would fail the worker's certificate check.

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";

const CFG_KEY = "cctv:sites";
const ALLOWED_PORTS = new Set([80, 443, 8080, 8880, 8443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096]);

/* ---- vendor snapshot path templates ({ch} = channel token) ---- */
const VENDOR_PATH = {
  hik: "/ISAPI/Streaming/channels/{ch}/picture",   // Annke/Hikvision (default)
  dahua: "/cgi-bin/snapshot.cgi?channel={ch}",      // Dahua-based
};
// Default channel token per camera index (1-based). Hik main stream = n01.
function defaultCh(vendor, i) { return vendor === "dahua" ? String(i) : String(i * 100 + 1); }

/* ------------------------------- config io ------------------------------- */
// Mint a signed snapshot URL for one camera, reusable by other routes (the
// yard-gate safety dialog) so a non-Full-Access user can view the gate camera
// without exposing the DVR admin. Returns null if the site/camera isn't found.
export async function cameraSnapshotUrl(env, origin, siteId, cameraId) {
  try {
    const db = tenantDB(env, 1);
    const sites = await loadSites(db);
    const site = (sites || []).find(s => String(s.id) === String(siteId));
    if (!site) return null;
    const cam = (site.cameras || []).find(c => String(c.id) === String(cameraId)) || (site.cameras || [])[0];
    if (!cam) return null;
    return await signedFileUrl(env, origin, "/cctv/snapshot", `${site.id}:${cam.ch}`, 24 * 3600);
  } catch { return null; }
}

async function loadSites(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
    .bind(db.tenantId, CFG_KEY).first();
  let sites = [];
  try { sites = row ? JSON.parse(row.value) : []; } catch {}
  return Array.isArray(sites) ? sites : [];
}
async function saveSites(db, sites) {
  await db.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(db.tenantId, CFG_KEY, JSON.stringify(sites)).run();
}

function newId(prefix) {
  return prefix + Math.abs((Date.now() ^ Math.floor(Math.random() * 1e9))).toString(36);
}

// Client-safe view of a site: no password, camera list intact.
function publicSite(s) {
  return {
    id: s.id, name: s.name, host: s.host, port: s.port, https: !!s.https,
    user: s.user, hasPass: !!s.pass, vendor: s.vendor || "hik", path: s.path || "",
    cameras: (s.cameras || []).map(c => ({ id: c.id, name: c.name, ch: c.ch })),
  };
}

/* --------------------------------- handler -------------------------------- */
export async function handle(request, env, ctx, url, sess) {
  const cors = corsHeaders(env, request);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  // Snapshot is PUBLIC (signature-gated) — <img> can't send an auth header.
  if (path === "/cctv/snapshot" && method === "GET") {
    return snapshot(request, env, url, cors);
  }

  // Everything else is Full-Access admin.
  if (!sess) sess = await requireSession(env, request);
  if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes") return json({ ok: false, error: "Forbidden" }, 403);
  const db = tenantDB(env, sess.tenantId);

  if (path === "/cctv/sites" && method === "GET") {
    const sites = await loadSites(db);
    const out = [];
    for (const s of sites) {
      const v = publicSite(s);
      // Mint a long-ish signed snapshot URL per camera (browser polls with &_t=).
      v.cameras = [];
      for (const c of (s.cameras || [])) {
        const key = `${s.id}:${c.ch}`;
        const snapUrl = await signedFileUrl(env, url.origin, "/cctv/snapshot", key, 24 * 3600);
        v.cameras.push({ id: c.id, name: c.name, ch: c.ch, snapshotUrl: snapUrl });
      }
      out.push(v);
    }
    return json({ ok: true, sites: out, allowedPorts: [...ALLOWED_PORTS] });
  }

  if (path === "/cctv/site" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    const host = String(b.host || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    const port = parseInt(b.port, 10) || (b.https ? 443 : 80);
    if (!name) return json({ ok: false, error: "Give the site a name" }, 400);
    if (!host) return json({ ok: false, error: "Enter the DVR host / DDNS address" }, 400);
    if (!ALLOWED_PORTS.has(port)) {
      return json({ ok: false, error: `Port ${port} can't be reached by the proxy. Forward the DVR to one of: ${[...ALLOWED_PORTS].join(", ")} (8080 is easiest).` }, 400);
    }
    const vendor = (b.vendor === "dahua") ? "dahua" : "hik";
    const sites = await loadSites(db);
    let site = b.id ? sites.find(s => s.id === b.id) : null;
    const isNew = !site;
    if (!site) { site = { id: newId("dvr") }; sites.push(site); }

    site.name = name;
    site.host = host;
    site.port = port;
    site.https = !!b.https;
    site.user = String(b.user || "").trim();
    // Keep the existing password on edit unless a new one is supplied.
    if (typeof b.pass === "string" && b.pass !== "") site.pass = b.pass;
    if (b.clearPass) site.pass = "";
    site.vendor = vendor;
    site.path = (typeof b.path === "string" && b.path.trim()) ? b.path.trim() : "";

    // Cameras: accept an explicit list, or a count to auto-generate.
    if (Array.isArray(b.cameras)) {
      site.cameras = b.cameras.map((c, i) => ({
        id: c.id || newId("cam"),
        name: String(c.name || `Camera ${i + 1}`).slice(0, 60),
        ch: String(c.ch || defaultCh(vendor, i + 1)),
      }));
    } else if (b.count != null) {
      const n = Math.max(0, Math.min(64, parseInt(b.count, 10) || 0));
      const prev = site.cameras || [];
      site.cameras = Array.from({ length: n }, (_, i) => prev[i] || ({
        id: newId("cam"), name: `Camera ${i + 1}`, ch: defaultCh(vendor, i + 1),
      }));
    } else if (!site.cameras) {
      site.cameras = [];
    }

    await saveSites(db, sites);
    return json({ ok: true, id: site.id, isNew, site: publicSite(site) });
  }

  if (path === "/cctv/site/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    let sites = await loadSites(db);
    const before = sites.length;
    sites = sites.filter(s => s.id !== b.id);
    if (sites.length === before) return json({ ok: false, error: "Site not found" }, 404);
    await saveSites(db, sites);
    return json({ ok: true });
  }

  // Live test of a site's first camera without saving (admin only).
  if (path === "/cctv/test" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const sites = await loadSites(db);
    const site = sites.find(s => s.id === b.id);
    if (!site) return json({ ok: false, error: "Save the site first, then test" }, 404);
    const cam = (site.cameras || [])[0];
    if (!cam) return json({ ok: false, error: "This site has no cameras" }, 400);
    const r = await fetchSnapshot(site, cam.ch);
    return json({ ok: r.ok, status: r.status, bytes: r.bytes || 0, error: r.error || null, contentType: r.contentType || null, debug: r.debug || null, ch: cam.ch });
  }

  return json({ ok: false, error: "Not found: " + path }, 404);
}

/* ------------------------------- snapshot -------------------------------- */
async function snapshot(request, env, url, cors) {
  const params = url.searchParams;
  const key = params.get("key") || "";
  const okSig = await verifyFileSig(env, key, params);
  if (!okSig) return new Response("Bad or expired signature", { status: 403, headers: cors });

  const sep = key.indexOf(":");
  const siteId = sep >= 0 ? key.slice(0, sep) : key;
  const ch = sep >= 0 ? key.slice(sep + 1) : "";

  const tenantId = await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);
  const sites = await loadSites(db);
  const site = sites.find(s => s.id === siteId);
  if (!site) return new Response("Unknown camera", { status: 404, headers: cors });

  const r = await fetchSnapshot(site, ch);
  if (!r.ok) {
    return new Response(`DVR fetch failed (${r.status || "no response"})${r.error ? ": " + r.error : ""}`,
      { status: 502, headers: { ...cors, "Cache-Control": "no-store" } });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": r.contentType || "image/jpeg",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

// Fetch one JPEG from a DVR, doing a digest (or basic) handshake as needed.
// Returns rich diagnostics (dbg) so /cctv/test can explain a failure precisely.
async function fetchSnapshot(site, ch) {
  const scheme = site.https ? "https" : "http";
  const base = `${scheme}://${site.host}:${site.port}`;
  const tmpl = site.path || VENDOR_PATH[site.vendor === "dahua" ? "dahua" : "hik"];
  const uri = tmpl.replace(/\{ch\}/g, encodeURIComponent(ch));
  const target = base + uri;
  // Present as a normal browser — some Annke/Hik firmware 403s "non-browser"
  // requests as suspected illegal access. A real UA + Referer often flips that
  // to a proper 401 digest challenge we can then answer.
  const ACCEPT = {
    "Accept": "image/avif,image/webp,image/jpeg,image/png,image/*,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Referer": base + "/doc/index.html",
  };

  const dbg = { firstStatus: null, wwwAuth: null, authScheme: null, authTried: false, finalStatus: null, reason: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);

  const get = (extra) => fetch(target, { signal: ctl.signal, headers: Object.assign({}, ACCEPT, extra || {}) });
  // Hikvision packs the real reason (userLocked / badUserPassword /
  // insufficientPermission …) into a small XML body — pull it out for the UI.
  const readReason = async (resp) => {
    try {
      const t = (await resp.text()).slice(0, 400);
      const m = t.match(/<subStatusCode>([^<]+)<\/subStatusCode>/i) || t.match(/<statusString>([^<]+)<\/statusString>/i);
      return m ? m[1] : (t.replace(/\s+/g, " ").trim().slice(0, 160) || null);
    } catch { return null; }
  };

  try {
    let resp = await get();
    dbg.firstStatus = resp.status;
    const wa = resp.headers.get("WWW-Authenticate") || "";
    dbg.wwwAuth = wa ? wa.slice(0, 80) : null;

    if ((resp.status === 401 || resp.status === 403) && site.user) {
      if (wa) {
        dbg.authScheme = /digest/i.test(wa) ? "digest" : (/basic/i.test(wa) ? "basic" : "unknown");
        const authHeader = await buildAuthHeader(wa, site.user, site.pass || "", "GET", uri);
        if (authHeader) {
          dbg.authTried = true;
          resp = await get({ "Authorization": authHeader });
          dbg.finalStatus = resp.status;
          // Digest rejected? Some Annke firmware is set to Basic — try that too.
          if (!resp.ok && dbg.authScheme === "digest") {
            const r2 = await get({ "Authorization": "Basic " + btoa(`${site.user}:${site.pass || ""}`) });
            if (r2.ok) { resp = r2; dbg.authScheme = "digest→basic"; } else { resp = resp.status >= r2.status ? r2 : resp; }
            dbg.finalStatus = resp.status;
          }
        }
      } else {
        // No challenge header at all — try a preemptive Basic (some firmware).
        dbg.authScheme = "basic(preemptive)"; dbg.authTried = true;
        resp = await get({ "Authorization": "Basic " + btoa(`${site.user}:${site.pass || ""}`) });
        dbg.finalStatus = resp.status;
      }
    }

    if (!resp.ok) {
      dbg.reason = await readReason(resp);
      return { ok: false, status: resp.status, debug: dbg };
    }
    const ct = resp.headers.get("Content-Type") || "image/jpeg";
    const buf = await resp.arrayBuffer();
    // A tiny "image" is usually an XML error the server sent with 200 — sanity-check.
    if (buf.byteLength < 200 && !/image\//i.test(ct)) {
      dbg.reason = "server returned " + ct + " (" + buf.byteLength + " bytes), not an image";
      return { ok: false, status: resp.status, debug: dbg };
    }
    return { ok: true, status: 200, body: buf, bytes: buf.byteLength, contentType: ct, debug: dbg };
  } catch (e) {
    dbg.reason = (e && e.name === "AbortError") ? "timed out (check host/port/forwarding)" : String(e && e.message || e);
    return { ok: false, status: 0, error: dbg.reason, debug: dbg };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------ auth: digest + basic --------------------------- */
async function buildAuthHeader(wwwAuth, user, pass, methodHttp, uri) {
  const scheme = /^\s*digest/i.test(wwwAuth) ? "digest" : (/^\s*basic/i.test(wwwAuth) ? "basic" : "");
  if (scheme === "basic") {
    return "Basic " + btoa(`${user}:${pass}`);
  }
  if (scheme !== "digest") return "";

  const p = parseAuthParams(wwwAuth);
  const realm = p.realm || "";
  const nonce = p.nonce || "";
  const opaque = p.opaque;
  const algorithm = (p.algorithm || "MD5");
  const qopList = (p.qop || "").split(",").map(s => s.trim()).filter(Boolean);
  const qop = qopList.includes("auth") ? "auth" : (qopList[0] || "");

  const ha1 = await md5(`${user}:${realm}:${pass}`);
  const ha2 = await md5(`${methodHttp}:${uri}`);

  let response, extra = "";
  if (qop) {
    const cnonce = randomHex(16);
    const nc = "00000001";
    response = await md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extra = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = await md5(`${ha1}:${nonce}:${ha2}`);
  }

  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=${algorithm}, response="${response}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  h += extra;
  return h;
}

function parseAuthParams(header) {
  const out = {};
  const s = header.replace(/^\s*[A-Za-z]+\s+/, "");
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : (m[3] || "").trim());
  return out;
}

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* --------------------------- MD5 (WebCrypto lacks it) --------------------- */
// Compact, well-known MD5. Digest auth uses MD5 by default; SubtleCrypto has
// no MD5, so we implement it. Input/output are hex-friendly strings.
async function md5(str) {
  return md5Hex(new TextEncoder().encode(str));
}
function md5Hex(bytes) {
  function toWords(b) {
    const len = b.length, words = [];
    for (let i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] || 0) | (b[i] << ((i % 4) * 8));
    return { words, len };
  }
  function add(a, b) { return (a + b) & 0xffffffff; }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return add(rol(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  const { words, len } = toWords(bytes);
  const bitLen = len * 8;
  // Pad to a whole number of 512-bit (16-word) blocks, every slot defined.
  const nBlocks = ((bitLen + 64) >>> 9) + 1;
  const total = nBlocks * 16;
  for (let i = 0; i < total; i++) if (words[i] === undefined) words[i] = 0;
  words[bitLen >> 5] |= 0x80 << (bitLen % 32);   // append the '1' bit
  words[total - 2] = bitLen;                      // low 32 bits of length
  words[total - 1] = 0;                           // high 32 bits (always 0 here)

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < words.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d, w = words;
    a = ff(a, b, c, d, w[i + 0], 7, -680876936); d = ff(d, a, b, c, w[i + 1], 12, -389564586);
    c = ff(c, d, a, b, w[i + 2], 17, 606105819); b = ff(b, c, d, a, w[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, w[i + 4], 7, -176418897); d = ff(d, a, b, c, w[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, w[i + 6], 17, -1473231341); b = ff(b, c, d, a, w[i + 7], 22, -45705983);
    a = ff(a, b, c, d, w[i + 8], 7, 1770035416); d = ff(d, a, b, c, w[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, w[i + 10], 17, -42063); b = ff(b, c, d, a, w[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, w[i + 12], 7, 1804603682); d = ff(d, a, b, c, w[i + 13], 12, -40341101);
    c = ff(c, d, a, b, w[i + 14], 17, -1502002290); b = ff(b, c, d, a, w[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, w[i + 1], 5, -165796510); d = gg(d, a, b, c, w[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, w[i + 11], 14, 643717713); b = gg(b, c, d, a, w[i + 0], 20, -373897302);
    a = gg(a, b, c, d, w[i + 5], 5, -701558691); d = gg(d, a, b, c, w[i + 10], 9, 38016083);
    c = gg(c, d, a, b, w[i + 15], 14, -660478335); b = gg(b, c, d, a, w[i + 4], 20, -405537848);
    a = gg(a, b, c, d, w[i + 9], 5, 568446438); d = gg(d, a, b, c, w[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, w[i + 3], 14, -187363961); b = gg(b, c, d, a, w[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, w[i + 13], 5, -1444681467); d = gg(d, a, b, c, w[i + 2], 9, -51403784);
    c = gg(c, d, a, b, w[i + 7], 14, 1735328473); b = gg(b, c, d, a, w[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, w[i + 5], 4, -378558); d = hh(d, a, b, c, w[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, w[i + 11], 16, 1839030562); b = hh(b, c, d, a, w[i + 14], 23, -35309556);
    a = hh(a, b, c, d, w[i + 1], 4, -1530992060); d = hh(d, a, b, c, w[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, w[i + 7], 16, -155497632); b = hh(b, c, d, a, w[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, w[i + 13], 4, 681279174); d = hh(d, a, b, c, w[i + 0], 11, -358537222);
    c = hh(c, d, a, b, w[i + 3], 16, -722521979); b = hh(b, c, d, a, w[i + 6], 23, 76029189);
    a = hh(a, b, c, d, w[i + 9], 4, -640364487); d = hh(d, a, b, c, w[i + 12], 11, -421815835);
    c = hh(c, d, a, b, w[i + 15], 16, 530742520); b = hh(b, c, d, a, w[i + 2], 23, -995338651);

    a = ii(a, b, c, d, w[i + 0], 6, -198630844); d = ii(d, a, b, c, w[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, w[i + 14], 15, -1416354905); b = ii(b, c, d, a, w[i + 5], 21, -57434055);
    a = ii(a, b, c, d, w[i + 12], 6, 1700485571); d = ii(d, a, b, c, w[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, w[i + 10], 15, -1051523); b = ii(b, c, d, a, w[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, w[i + 8], 6, 1873313359); d = ii(d, a, b, c, w[i + 15], 10, -30611744);
    c = ii(c, d, a, b, w[i + 6], 15, -1560198380); b = ii(b, c, d, a, w[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, w[i + 4], 6, -145523070); d = ii(d, a, b, c, w[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, w[i + 2], 15, 718787259); b = ii(b, c, d, a, w[i + 9], 21, -343485551);

    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  const hex = w => {
    let s = "";
    for (let i = 0; i < 4; i++) s += ((w >> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return s;
  };
  return hex(a) + hex(b) + hex(c) + hex(d);
}
