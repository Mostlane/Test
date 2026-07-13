/* Mostlane — shared "Edit Job" modal for every OFFICE view of the SLA system
 * (dashboard, scheduler, job detail). One implementation so every office area
 * edits a job the same way.
 *
 * Usage:
 *   MLJobEdit.open(job, { onSaved: updatedJob => { ... } });
 *
 * It lets an admin edit ANY job detail — reference, description, priority,
 * status, raised time, and the full SITE (name, address, postcode, phone).
 * The site can be picked from the existing sites OR typed fresh; a brand-new
 * address can be saved back into the Sites database (under a chosen customer,
 * with an auto-generated site number) so it's a real site from then on.
 *
 * Talks to the consolidated worker via window.MOSTLANE_API with the Bearer
 * token, so it works on any portal page that includes portal-config.js.
 */
(function () {
  "use strict";
  if (window.MLJobEdit) return;

  const API = () => (window.MOSTLANE_API || "https://mostlane-api.jamie-def.workers.dev");
  const $ = sel => document.getElementById(sel);
  function authFetch(path, opts = {}) {
    const t = localStorage.getItem("mostlaneToken");
    opts.headers = Object.assign({}, opts.headers, t ? { "Authorization": "Bearer " + t } : {});
    return fetch(API() + path, opts);
  }
  function currentUser() {
    return sessionStorage.getItem("mostlaneUser") || sessionStorage.getItem("mostlaneUsername") ||
           localStorage.getItem("mostlaneUser") || "Portal User";
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function slug(s) { return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

  const STATUSES = ["Pending", "Scheduled", "Travelling", "In Progress", "On Hold", "Quote", "Order", "Complete", "Invoiced", "Closed Jobs"];
  const PRIORITIES = [["Priority 1", "P1 – Emergency"], ["Priority 2", "P2 – Urgent"], ["Priority 3", "P3 – Routine"], ["Priority 4", "P4 – Low"]];

  /* ---- injected styles + DOM ---- */
  const CSS = `
  .mlje-back{position:fixed;inset:0;background:rgba(15,23,42,.45);display:none;align-items:center;justify-content:center;z-index:100000;padding:12px;}
  .mlje-back.show{display:flex;}
  .mlje-modal{background:#fff;border-radius:14px;max-width:520px;width:100%;box-shadow:0 24px 48px rgba(0,0,0,.3);padding:16px;max-height:94vh;display:flex;flex-direction:column;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;}
  .mlje-modal h2{margin:0 0 8px;font-size:17px;color:#003b82;}
  .mlje-body{flex:1;overflow-y:auto;padding-right:2px;}
  .mlje-body label{display:block;font-size:12px;font-weight:600;color:#334155;margin:10px 0 3px;}
  .mlje-body input,.mlje-body select,.mlje-body textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px 9px;font-size:14px;font-family:inherit;background:#fff;}
  .mlje-body textarea{min-height:52px;resize:vertical;}
  .mlje-2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .mlje-site{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-top:12px;background:#f8fafc;}
  .mlje-site h3{margin:0 0 4px;font-size:13px;color:#003b82;}
  .mlje-chk{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#334155;margin-top:10px;cursor:pointer;}
  .mlje-chk input{width:auto;}
  .mlje-hint{font-size:12px;color:#64748b;margin-top:4px;}
  .mlje-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}
  .mlje-btn{border:1px solid #cbd5e1;border-radius:999px;padding:9px 16px;font-size:14px;cursor:pointer;background:#f8fafc;color:#0f172a;}
  .mlje-btn.primary{background:#003b82;color:#fff;border-color:#003b82;}
  .mlje-btn:disabled{opacity:.5;cursor:default;}
  .mlje-msg{font-size:13px;margin-top:8px;}
  .mlje-msg.err{color:#b91c1c;}
  .mlje-msg.ok{color:#166534;}
  `;

  const HTML = `
  <div class="mlje-modal" role="dialog" aria-modal="true">
    <h2 id="mljeTitle">Edit job</h2>
    <div class="mlje-body">
      <label for="mljeRef">Reference</label>
      <input id="mljeRef" type="text">

      <label for="mljeDesc">Description</label>
      <textarea id="mljeDesc"></textarea>

      <div class="mlje-2">
        <div>
          <label for="mljePriority">Priority</label>
          <select id="mljePriority"></select>
        </div>
        <div>
          <label for="mljeStatus">Status</label>
          <select id="mljeStatus"></select>
        </div>
      </div>

      <label for="mljeRaised">Raised (date &amp; time)</label>
      <input id="mljeRaised" type="datetime-local">

      <div class="mlje-site">
        <h3>Site</h3>
        <label for="mljeSitePick">Use an existing site</label>
        <input id="mljeSiteFilter" type="text" placeholder="Type to filter sites…" style="margin-bottom:6px;">
        <select id="mljeSitePick"><option value="">— pick a site to fill the boxes below —</option></select>

        <label for="mljeSiteName">Site name</label>
        <input id="mljeSiteName" type="text">
        <label for="mljeSiteAddr">Address</label>
        <textarea id="mljeSiteAddr"></textarea>
        <div class="mlje-2">
          <div>
            <label for="mljeSitePc">Postcode</label>
            <input id="mljeSitePc" type="text">
          </div>
          <div>
            <label for="mljeSiteTel">Telephone</label>
            <input id="mljeSiteTel" type="text">
          </div>
        </div>

        <label class="mlje-chk"><input type="checkbox" id="mljeSaveSite"> Also save these site details to my Sites list</label>
        <div id="mljeSaveSiteBox" style="display:none;">
          <label for="mljeSiteCust">Save under customer / group</label>
          <select id="mljeSiteCust"></select>
          <input id="mljeSiteCustNew" type="text" placeholder="New customer name…" style="display:none;margin-top:6px;">
          <div class="mlje-hint" id="mljeSiteHint">A new site number will be created automatically.</div>
        </div>
      </div>

      <label for="mljeNote">Add a note (goes in the job history)</label>
      <textarea id="mljeNote"></textarea>
    </div>
    <div class="mlje-actions">
      <button type="button" class="mlje-btn" id="mljeCancel">Cancel</button>
      <button type="button" class="mlje-btn primary" id="mljeSave">Save changes</button>
    </div>
    <div class="mlje-msg" id="mljeMsg"></div>
  </div>`;

  let sites = null, customers = null, currentJob = null, onSavedCb = null, pickMap = [];

  function inject() {
    if ($("mljeBack")) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const back = document.createElement("div");
    back.className = "mlje-back";
    back.id = "mljeBack";
    back.innerHTML = HTML;
    document.body.appendChild(back);

    // build static option lists
    $("mljePriority").innerHTML = PRIORITIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    $("mljeStatus").innerHTML = STATUSES.map(s => `<option value="${s}">${s}</option>`).join("");

    $("mljeCancel").addEventListener("click", close);
    back.addEventListener("click", e => { if (e.target === back) close(); });
    $("mljeSave").addEventListener("click", save);
    $("mljeSiteFilter").addEventListener("input", () => fillSitePicker($("mljeSiteFilter").value));
    $("mljeSitePick").addEventListener("change", onPickSite);
    $("mljeSaveSite").addEventListener("change", () => {
      $("mljeSaveSiteBox").style.display = $("mljeSaveSite").checked ? "block" : "none";
    });
    $("mljeSiteCust").addEventListener("change", () => {
      $("mljeSiteCustNew").style.display = $("mljeSiteCust").value === "__new__" ? "block" : "none";
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && $("mljeBack").classList.contains("show")) close(); });
  }

  function mapSite(s) {
    const postcode = String(s.postcode || "").replace(/\*+$/, "").trim();
    return {
      code: String(s.siteNumber || "").toString().padStart(4, "0"),
      rawNumber: String(s.siteNumber || ""),
      name: s.siteName || "",
      postcode,
      telephone: s.telephone || s.phone || "",
      address: [s.address1 || s.street || "", s.town || "", s.county || "", postcode].filter(Boolean).join(", "),
      lat: (s.lat ?? null), lon: (s.lon ?? null),
      client: s.client || "",
      storeType: s.storeType || s.client || "",
      sharepointURL: s.sharepointURL || s.sharepoint || ""
    };
  }

  async function ensureData() {
    if (!sites) {
      try {
        const r = await authFetch("/get-sites?category=all");
        const raw = await r.json();
        sites = (Array.isArray(raw) ? raw : []).filter(s => s.active !== false).map(mapSite)
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { sites = []; }
    }
    if (!customers) {
      customers = [];
      try {
        const r = await authFetch("/customers");
        const d = await r.json();
        customers = (d.customers || []).map(c => ({ id: c.id, name: c.name || c.id }));
      } catch (e) { /* fall back to site clients below */ }
      if (!customers.length) {
        const seen = new Set();
        (sites || []).forEach(s => { if (s.client && !seen.has(s.client)) { seen.add(s.client); customers.push({ id: s.client, name: s.client }); } });
      }
    }
  }

  function fillSitePicker(filter) {
    const sel = $("mljeSitePick");
    sel.innerHTML = `<option value="">— pick a site to fill the boxes below —</option>`;
    const f = (filter || "").toLowerCase();
    pickMap = [];
    sites.forEach(s => {
      if (f && !(`${s.name} ${s.code} ${s.postcode}`.toLowerCase().includes(f))) return;
      const o = document.createElement("option");
      o.value = String(pickMap.length);
      o.textContent = `${s.name} — ${s.code}${s.postcode ? " (" + s.postcode + ")" : ""}`;
      sel.appendChild(o);
      pickMap.push(s);
    });
  }
  function fillCustomers() {
    const sel = $("mljeSiteCust");
    sel.innerHTML = customers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")
      + `<option value="__new__">➕ New customer…</option>`;
  }

  let pickedSite = null;   // set when an existing site is chosen
  function onPickSite() {
    const v = $("mljeSitePick").value;
    if (v === "") { pickedSite = null; return; }
    const s = pickMap[Number(v)];
    if (!s) return;
    pickedSite = s;
    $("mljeSiteName").value = s.name;
    $("mljeSiteAddr").value = s.address;
    $("mljeSitePc").value = s.postcode;
    $("mljeSiteTel").value = s.telephone;
  }

  function toLocalInput(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function open(job, opts) {
    inject();
    currentJob = job;
    onSavedCb = (opts && opts.onSaved) || null;
    pickedSite = null;
    $("mljeTitle").textContent = `Edit job — ${job.helpdeskRef || job.id}`;
    $("mljeRef").value = job.helpdeskRef || "";
    $("mljeDesc").value = job.description || "";
    $("mljePriority").value = job.priority || "Priority 4";
    $("mljeStatus").value = job.status || "Pending";
    $("mljeRaised").value = toLocalInput(job.raisedAt);
    $("mljeSiteName").value = job.siteName || "";
    $("mljeSiteAddr").value = job.address || "";
    $("mljeSitePc").value = (job.postcode || "").replace(/\*+$/, "");
    $("mljeSiteTel").value = job.telephone || "";
    $("mljeSaveSite").checked = false;
    $("mljeSaveSiteBox").style.display = "none";
    $("mljeSiteCustNew").style.display = "none";
    $("mljeSiteFilter").value = "";
    $("mljeNote").value = "";
    $("mljeMsg").textContent = "";
    $("mljeSitePick").innerHTML = `<option value="">Loading sites…</option>`;
    $("mljeBack").classList.add("show");

    await ensureData();
    fillSitePicker("");
    fillCustomers();
  }
  function close() { const b = $("mljeBack"); if (b) b.classList.remove("show"); currentJob = null; }

  function nextSiteNumber() {
    let max = 0;
    (sites || []).forEach(s => { const n = parseInt(String(s.rawNumber).replace(/\D/g, ""), 10); if (Number.isFinite(n) && n > max) max = n; });
    return String(max + 1).padStart(4, "0");
  }

  async function save() {
    if (!currentJob) return;
    const msg = $("mljeMsg");
    msg.className = "mlje-msg";
    $("mljeSave").disabled = true;

    const siteName = $("mljeSiteName").value.trim();
    const address = $("mljeSiteAddr").value.trim();
    const postcode = $("mljeSitePc").value.trim();
    const telephone = $("mljeSiteTel").value.trim();
    let siteCode = currentJob.siteCode || "";
    let lat = null, lon = null;
    if (pickedSite) { siteCode = pickedSite.code; lat = pickedSite.lat; lon = pickedSite.lon; }

    // Optionally persist the site to the Sites database.
    if ($("mljeSaveSite").checked && siteName) {
      try {
        msg.textContent = "Saving site…";
        let client, existing = pickedSite;
        if (existing) {
          client = existing.client || "retail";
          siteCode = existing.code;
        } else {
          const custVal = $("mljeSiteCust").value;
          client = custVal === "__new__" ? slug($("mljeSiteCustNew").value) : custVal;
          if (!client) { msg.textContent = "Enter a customer name to save the new site under."; msg.className = "mlje-msg err"; $("mljeSave").disabled = false; return; }
          siteCode = nextSiteNumber();
        }
        const sitePayload = {
          siteNumber: String(Number(siteCode)),   // store without leading zeros, like the rest
          siteName, address1: address, postcode, telephone,
          lat: (lat != null ? lat : undefined), lon: (lon != null ? lon : undefined),
          client
        };
        const ep = existing ? "/update-site" : "/add-site";
        const qs = "?category=" + encodeURIComponent(client) + (existing ? "&oldSiteNumber=" + encodeURIComponent(existing.rawNumber) : "");
        const r = await authFetch(ep + qs, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sitePayload) });
        if (!r.ok) throw new Error("site save HTTP " + r.status);
        sites = null;   // force reload next open so the new site appears in the picker
        siteCode = String(Number(siteCode)).padStart(4, "0");
      } catch (e) {
        msg.textContent = "⚠️ Couldn't save the site (" + e.message + "). The job itself was not changed.";
        msg.className = "mlje-msg err";
        $("mljeSave").disabled = false;
        return;
      }
    }

    // Patch the job with every edited detail.
    const raisedLocal = $("mljeRaised").value;
    const payload = {
      helpdeskRef: $("mljeRef").value.trim() || undefined,
      description: $("mljeDesc").value.trim() || undefined,
      priority: $("mljePriority").value,
      status: $("mljeStatus").value,
      raisedAt: raisedLocal ? new Date(raisedLocal).toISOString() : undefined,
      siteCode: siteCode || undefined,
      siteName: siteName,
      address: address,
      postcode: postcode,
      telephone: telephone,
      lat: (lat != null ? lat : undefined),
      lon: (lon != null ? lon : undefined),
      note: $("mljeNote").value.trim() || undefined,
      changedBy: currentUser()
    };
    try {
      msg.textContent = "Saving job…";
      const r = await authFetch("/sla/jobs/" + encodeURIComponent(currentJob.id), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const saved = await r.json();
      msg.textContent = "✅ Saved.";
      msg.className = "mlje-msg ok";
      if (onSavedCb) { try { onSavedCb(saved); } catch (e) {} }
      setTimeout(close, 400);
    } catch (e) {
      msg.textContent = "❌ Couldn't save the job (" + e.message + ").";
      msg.className = "mlje-msg err";
      $("mljeSave").disabled = false;
    }
  }

  window.MLJobEdit = { open };
})();
