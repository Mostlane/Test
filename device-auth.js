// device-auth.js (FINAL PRODUCTION VERSION)
// --------------------------------------------------------------
// MOSTLANE PORTAL - DEVICE AUTH FRONT-END
// --------------------------------------------------------------

// Your Cloudflare Worker endpoint
const DEVICE_AUTH_BASE = "https://userdevicekv.jamie-def.workers.dev";

// Session key for username
const USERNAME_SESSION_KEY = "mostlaneUsername";

// ───────────────────────────────────────────────────────────────
// HELPERS: HASH + FINGERPRINT + DEVICE ID
// ───────────────────────────────────────────────────────────────

// Simple hashing function
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16);
}

// Compute stable fingerprint based on device/browser characteristics
function computeFingerprint() {
  try {
    const nav = navigator;
    const scr = screen;

    const fpData = {
      ua: nav.userAgent || "",
      platform: nav.platform || "",
      lang: nav.language || "",
      langs: nav.languages || [],
      hw: nav.hardwareConcurrency || "",
      mem: nav.deviceMemory || "",
      res: `${scr.width}x${scr.height}`,
      depth: scr.colorDepth,
      tz: new Date().getTimezoneOffset(),
      touch: "ontouchstart" in window,
      maxTouch: nav.maxTouchPoints || 0
    };

    return "fp_" + hashString(JSON.stringify(fpData));
  } catch (e) {
    return "fp_fallback_" + hashString(navigator.userAgent || "unknown");
  }
}

// Generate or retrieve persistent device ID
function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem("mlDeviceId");
    if (!id) {
      id = "dev-" + Math.random().toString(36).slice(2, 9);
      localStorage.setItem("mlDeviceId", id);
    }
    return id;
  } catch (e) {
    return "dev-session-" + Math.random().toString(36).slice(2, 9);
  }
}

// Worker POST
async function postToWorker(path, payload) {
  const res = await fetch(DEVICE_AUTH_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return {
    status: res.status,
    body: await res.json().catch(() => ({}))
  };
}

// ───────────────────────────────────────────────────────────────
// DEVICE REGISTER POPUP (simple blocking prompt version)
// ───────────────────────────────────────────────────────────────
function showRegisterPopup(username, callback) {
  const label = prompt(
    "This appears to be a new device.\n\nPlease give this device a name (e.g. 'Work iPhone'):"
  );

  if (!label) {
    alert("Device registration cancelled.");
    window.location.href = "login.html";
    return;
  }

  const deviceId = getOrCreateDeviceId();
  const fingerprint = computeFingerprint();

  postToWorker("/auth/register-device", {
    username,
    deviceId,
    fingerprint,
    label
  }).then((res) => {
    if (res.body.status === "OK") {
      callback();
    } else {
      alert("Unable to register device. Please contact the office.");
      window.location.href = "login.html";
    }
  });
}

function showBlock(message) {
  alert(message);
  window.location.href = "login.html";
}

// ───────────────────────────────────────────────────────────────
// PUBLIC API: Called by login.html + protected pages
// ───────────────────────────────────────────────────────────────
window.DeviceAuth = {

  // Called immediately after successful username/password login
  async checkOnLogin(username, onSuccess) {
    const deviceId = getOrCreateDeviceId();
    const fingerprint = computeFingerprint();

    const res = await postToWorker("/auth/check-device", {
      username,
      deviceId,
      fingerprint
    });

    const body = res.body;

    if (body.status === "OK") {
      return onSuccess();
    }

    if (body.status === "NEW_DEVICE_REQUIRED") {
      return showRegisterPopup(username, onSuccess);
    }

    if (body.status === "DEVICE_MISMATCH") {
      return showBlock(
        "🔒 This device is registered to a different user.\nYou cannot log in on this device."
      );
    }

    showBlock("Device verification failed. Please try again.");
  },

  // Call this at top of all protected pages
  async enforceOnPage() {
    const username = sessionStorage.getItem(USERNAME_SESSION_KEY);
    if (!username) {
      window.location.href = "login.html";
      return;
    }

    const deviceId = getOrCreateDeviceId();
    const fingerprint = computeFingerprint();

    const res = await postToWorker("/auth/check-device", {
      username,
      deviceId,
      fingerprint
    });

    const body = res.body;

    if (body.status === "OK") return;

    if (body.status === "NEW_DEVICE_REQUIRED") {
      return showRegisterPopup(username, () => location.reload());
    }

    if (body.status === "DEVICE_MISMATCH") {
      return showBlock(
        "🔒 This device is registered to a different user.\nAccess denied."
      );
    }

    showBlock("Device verification error.");
  }
};
