// device-auth.js (FINAL PRODUCTION VERSION)
// --------------------------------------------------------------
// MOSTLANE PORTAL - DEVICE AUTH FRONT-END (DEVICE ID ONLY)
// --------------------------------------------------------------

// ✅ GLOBAL SINGLE-RUN GUARD
if (window.__mlDeviceAuthRan) {
  console.warn("DeviceAuth already ran — skipping duplicate execution");
} else {
  window.__mlDeviceAuthRan = true;
}

// ✅ Prompt-once-per-page-load guard
let devicePromptShown = false;

// Your Cloudflare Worker endpoint
const DEVICE_AUTH_BASE = "https://userdevicekv.jamie-def.workers.dev";

// Session key for username
const USERNAME_SESSION_KEY = "mostlaneUsername";

// ───────────────────────────────────────────────────────────────
// DEVICE ID (SINGLE SOURCE OF TRUTH)
// ───────────────────────────────────────────────────────────────
function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem("deviceID");
    if (!id) {
      id = "dev-" + crypto.randomUUID().slice(0, 7);
      localStorage.setItem("deviceID", id);
    }
    sessionStorage.setItem("deviceID", id);
    return id;
  } catch (e) {
    return "dev-session-" + crypto.randomUUID().slice(0, 7);
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

  postToWorker("/auth/register-device", {
    username,
    deviceId,
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

// Break-glass: a master-password login (flagged by login.html for this browser
// session) skips all device-lock checks. Session-scoped, so it ends when the
// tab/browser closes — it does not permanently disable the device lock.
function isMasterSession() {
  try { return sessionStorage.getItem("mostlaneMasterLogin") === "1"; }
  catch { return false; }
}

// ───────────────────────────────────────────────────────────────
// PUBLIC API: Called by login.html + protected pages
// ───────────────────────────────────────────────────────────────
window.DeviceAuth = {

  // Called immediately after successful username/password login
  async checkOnLogin(username, onSuccess) {
    if (isMasterSession()) return onSuccess();
    const deviceId = getOrCreateDeviceId();

    const res = await postToWorker("/auth/check-device", {
      username,
      deviceId
    });

    const body = res.body;

    if (body.status === "OK") {
      return onSuccess();
    }

    if (body.status === "NEW_DEVICE_REQUIRED") {
      if (devicePromptShown) {
        console.warn("Device prompt already shown — retrying silently");
        return onSuccess();
      }
      devicePromptShown = true;
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
    if (isMasterSession()) return;
    const username = sessionStorage.getItem(USERNAME_SESSION_KEY);
    if (!username) {
      window.location.href = "login.html";
      return;
    }

    const deviceId = getOrCreateDeviceId();

    const res = await postToWorker("/auth/check-device", {
      username,
      deviceId
    });

    const body = res.body;

    if (body.status === "OK") return;

    if (body.status === "NEW_DEVICE_REQUIRED") {
      if (devicePromptShown) {
        console.warn("Device prompt already shown — reloading");
        return location.reload();
      }
      devicePromptShown = true;
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
