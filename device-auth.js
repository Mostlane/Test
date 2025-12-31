// device-auth.js (FINAL PRODUCTION VERSION — FIXED)
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

// Cloudflare Worker endpoint
const DEVICE_AUTH_BASE = "https://userdevicekv.jamie-def.workers.dev";

// --------------------------------------------------------------
// CANONICAL USERNAME SOURCE (SINGLE TRUTH)
// --------------------------------------------------------------
function getLoggedInUsername() {
  return (
    sessionStorage.getItem("mostlaneUser") ||
    localStorage.getItem("mostlaneUser") ||
    ""
  );
}

// --------------------------------------------------------------
// DEVICE ID (SINGLE SOURCE OF TRUTH)
// --------------------------------------------------------------
function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem("deviceID");
    if (!id) {
      id = "dev-" + crypto.randomUUID().slice(0, 7);
      localStorage.setItem("deviceID", id);
    }
    sessionStorage.setItem("deviceID", id);
    return id;
  } catch {
    return "dev-session-" + crypto.randomUUID().slice(0, 7);
  }
}

// --------------------------------------------------------------
// Worker POST helper
// --------------------------------------------------------------
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

// --------------------------------------------------------------
// DEVICE REGISTER POPUP
// --------------------------------------------------------------
function showRegisterPopup(username, callback) {
  const label = prompt(
    "This appears to be a new device.\n\nPlease give this device a name (e.g. 'Work iPhone'):"
  );

  if (!label) {
    alert("Device registration cancelled.");
    location.replace("login.html");
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
      location.replace("login.html");
    }
  });
}

function showBlock(message) {
  alert(message);
  location.replace("login.html");
}

// --------------------------------------------------------------
// PUBLIC API
// --------------------------------------------------------------
window.DeviceAuth = {

  // ------------------------------------------------------------
  // Called immediately after successful login
  // ------------------------------------------------------------
  async checkOnLogin(username, onSuccess) {
    const deviceId = getOrCreateDeviceId();

    const res = await postToWorker("/auth/check-device", {
      username,
      deviceId
    });

    const body = res.body;

    if (body.status === "OK") return onSuccess();

    if (body.status === "NEW_DEVICE_REQUIRED") {
      if (devicePromptShown) return onSuccess();
      devicePromptShown = true;
      return showRegisterPopup(username, onSuccess);
    }

    if (body.status === "DEVICE_MISMATCH") {
      return showBlock(
        "🔒 This device is registered to a different user.\nYou cannot log in on this device."
      );
    }

    showBlock("Device verification failed.");
  },

  // ------------------------------------------------------------
  // Enforce device on protected pages (ADMIN-AWARE)
  // ------------------------------------------------------------
  async enforceOnPage({ allowAdminOverride = false } = {}) {
    const username = getLoggedInUsername();

    if (!username) {
      location.replace("login.html");
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
      if (devicePromptShown) return location.reload();
      devicePromptShown = true;
      return showRegisterPopup(username, () => location.reload());
    }

    if (body.status === "DEVICE_MISMATCH") {
      if (allowAdminOverride === true) {
        console.warn("🔓 Admin override — device mismatch ignored for", username);
        return;
      }

      return showBlock(
        "🔒 This device is registered to a different user.\nAccess denied."
      );
    }

    showBlock("Device verification error.");
  }
};
