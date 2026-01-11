const API_BASE = "https://api.mostlane.com"; // 🔴 change if needed
const form = document.getElementById("fwForm");
const errorBox = document.getElementById("error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";

  const files = form.photos.files;
  if (!files || files.length < 2) {
    errorBox.textContent = "Please upload at least two photos.";
    return;
  }

  const reason = [...form.reason.options]
    .filter(o => o.selected)
    .map(o => o.value);

  const payload = {
    reason,
    issue: form.issue.value.trim(),
    nature: form.nature.value,
    asset: form.asset.value.trim(),
    risk: form.risk.value.trim(),
    client_awareness: form.client_awareness.value
  };

  try {
    // 1️⃣ Create Further Works record
    const res = await fetch(`${API_BASE}/fw/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error("Failed to create record");
    const { id, uploadUrls } = await res.json();

    // 2️⃣ Upload photos directly to R2
    for (let i = 0; i < files.length; i++) {
      if (!uploadUrls[i]) break;
      await fetch(uploadUrls[i], {
        method: "PUT",
        body: files[i]
      });
    }

    alert("Further works submitted successfully");
    form.reset();

  } catch (err) {
    errorBox.textContent = "Submission failed. Please try again.";
  }
});
