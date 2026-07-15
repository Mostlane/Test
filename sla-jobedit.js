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
  // Cached permission set (portal-config keeps it fresh) — lets admin-only UI
  // appear instantly and work on weak signal; the server enforces regardless.
  function cachedPerms() {
    try { return JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "null") || {}; }
    catch (e) { return {}; }
  }
  const isSlaAdmin = p => p && (String(p.FullAccess || "").toLowerCase() === "yes" || String(p.SLAAdmin || "").toLowerCase() === "yes");
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
  .mlje-3{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:8px;}
  .mlje-engs{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;max-height:150px;overflow-y:auto;background:#fff;}
  .mlje-engs label{display:flex;align-items:center;gap:7px;margin:0;font-size:13px;font-weight:500;cursor:pointer;}
  .mlje-engs input{width:auto;margin:0;flex:0 0 auto;transform:scale(1.15);}
  .mlje-hint a{color:#2563eb;font-weight:600;text-decoration:none;}
  .mlje-site{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-top:12px;background:#f8fafc;}
  .mlje-site h3{margin:0 0 4px;font-size:13px;color:#003b82;}
  .mlje-chk{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#334155;margin-top:10px;cursor:pointer;}
  .mlje-chk input{width:auto;}
  .mlje-hint{font-size:12px;color:#64748b;margin-top:4px;}
  .mlje-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}
  .mlje-btn{border:1px solid #cbd5e1;border-radius:999px;padding:9px 16px;font-size:14px;cursor:pointer;background:#f8fafc;color:#0f172a;}
  .mlje-btn.primary{background:#003b82;color:#fff;border-color:#003b82;}
  .mlje-btn.danger{color:#b91c1c;border-color:#fca5a5;background:#fff;margin-right:auto;}
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
        <h3>Schedule &amp; engineers</h3>
        <label>Assigned engineers (tick all that will attend)</label>
        <div class="mlje-engs" id="mljeEngineers"><span class="mlje-hint">Loading engineers…</span></div>

        <label for="mljeSchedDate">Scheduled date &amp; times</label>
        <div class="mlje-3">
          <input id="mljeSchedDate" type="date" aria-label="Scheduled date">
          <input id="mljeSchedStart" type="time" step="300" aria-label="Start time">
          <input id="mljeSchedEnd" type="time" step="300" aria-label="Finish time">
        </div>
        <div class="mlje-hint">Date · start · finish. Scroll the mouse wheel over a box to nudge it (15&nbsp;min / 1&nbsp;day steps). <a href="javascript:void(0)" id="mljeSchedClear">Clear schedule</a><span id="mljeDueHint"></span></div>
      </div>

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
      <button type="button" class="mlje-btn danger" id="mljeDelete" style="display:none;">🗑 Delete job</button>
      <button type="button" class="mlje-btn" id="mljeCancel">Cancel</button>
      <button type="button" class="mlje-btn primary" id="mljeSave">Save changes</button>
    </div>
    <div class="mlje-msg" id="mljeMsg"></div>
  </div>`;

  let sites = null, customers = null, engineers = null, me = null, currentJob = null, onSavedCb = null, onDeletedCb = null, pickMap = [];

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
    $("mljeDelete").addEventListener("click", del);
    $("mljeSiteFilter").addEventListener("input", () => fillSitePicker($("mljeSiteFilter").value));
    $("mljeSitePick").addEventListener("change", onPickSite);
    $("mljeSaveSite").addEventListener("change", () => {
      $("mljeSaveSiteBox").style.display = $("mljeSaveSite").checked ? "block" : "none";
    });
    $("mljeSiteCust").addEventListener("change", () => {
      $("mljeSiteCustNew").style.display = $("mljeSiteCust").value === "__new__" ? "block" : "none";
    });
    $("mljeSchedClear").addEventListener("click", () => {
      $("mljeSchedDate").value = ""; $("mljeSchedStart").value = ""; $("mljeSchedEnd").value = "";
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && $("mljeBack").classList.contains("show")) close(); });
    wheelify(back);
  }

  /* ---- mouse-wheel stepping on date/time boxes ----
     Hover a box and scroll: times step 15 min (hold Shift for 1 h), dates step
     1 day, numbers step by their step attribute. Beats the tiny spinner arrows. */
  const p2 = n => String(n).padStart(2, "0");
  function stepTime(v, mins, fallback) {
    const m = /^(\d{2}):(\d{2})/.exec(v || "");
    let t = m ? (Number(m[1]) * 60 + Number(m[2])) : fallback;
    t = ((t + mins) % 1440 + 1440) % 1440;
    return p2(Math.floor(t / 60)) + ":" + p2(t % 60);
  }
  function wheelify(root) {
    root.addEventListener("wheel", e => {
      const el = e.target;
      if (!el || !el.matches || !el.matches('input[type=time],input[type=date],input[type=datetime-local],input[type=number]')) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      if (el.type === "time") {
        el.value = stepTime(el.value, dir * (e.shiftKey ? 60 : 15), 8 * 60);
      } else if (el.type === "date") {
        const d = el.value ? new Date(el.value + "T12:00:00") : new Date();
        d.setDate(d.getDate() + dir);
        el.value = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      } else if (el.type === "datetime-local") {
        const d = el.value ? new Date(el.value) : new Date();
        if (!isNaN(d)) {
          d.setMinutes(d.getMinutes() + dir * (e.shiftKey ? 60 : 15));
          el.value = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
        }
      } else if (el.type === "number") {
        const step = parseFloat(el.step) || 1;
        const min = el.min !== "" ? parseFloat(el.min) : -Infinity;
        const cur = parseFloat(el.value);
        el.value = String(Math.max(min, (isNaN(cur) ? (parseFloat(el.min) || 0) : cur) + dir * step));
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { passive: false });
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
    if (!me) {
      try { const r = await authFetch("/auth/me"); const d = await r.json(); me = (d && d.ok && d.user) || {}; }
      catch (e) { me = {}; }
    }
    if (!engineers) {
      try {
        const r = await authFetch("/users");
        const d = await r.json();
        let list = (d.Users || d.users || []).filter(u => u.Username && (u.Status || "").toLowerCase() === "active");
        if (window.mlOrderUsers) list = window.mlOrderUsers(list);
        engineers = list.map(u => ({ username: u.Username, name: ((u.FirstName || "") + " " + (u.LastName || "")).trim() || u.Username }));
      } catch (e) { engineers = []; }
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

  let closeTimer = null;
  async function open(job, opts) {
    inject();
    clearTimeout(closeTimer);            // a just-saved modal's delayed close must not shut this one
    $("mljeSave").disabled = false;      // re-enable after a previous successful save
    $("mljeDelete").disabled = false;
    // Admin-only: show straight away from the cached permissions (works on weak
    // signal); the /auth/me check below can only ADD it, never depends on it.
    $("mljeDelete").style.display = isSlaAdmin(cachedPerms()) ? "" : "none";
    currentJob = job;
    onSavedCb = (opts && opts.onSaved) || null;
    onDeletedCb = (opts && opts.onDeleted) || (opts && opts.onSaved) || null;
    pickedSite = null;
    $("mljeTitle").textContent = `Edit job — ${job.helpdeskRef || job.id}`;
    $("mljeRef").value = job.helpdeskRef || "";
    $("mljeDesc").value = job.description || "";
    $("mljePriority").value = job.priority || "Priority 4";
    $("mljeStatus").value = job.status || "Pending";
    $("mljeRaised").value = toLocalInput(job.raisedAt);
    // Schedule (date · start · finish) — empty boxes mean "not scheduled".
    const sAt = job.scheduledAt ? new Date(job.scheduledAt) : null;
    const sEnd = job.scheduledEnd ? new Date(job.scheduledEnd) : null;
    const pd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    $("mljeSchedDate").value = (sAt && !isNaN(sAt)) ? pd(sAt) : "";
    $("mljeSchedStart").value = (sAt && !isNaN(sAt)) ? p2(sAt.getHours()) + ":" + p2(sAt.getMinutes()) : "";
    $("mljeSchedEnd").value = (sEnd && !isNaN(sEnd)) ? p2(sEnd.getHours()) + ":" + p2(sEnd.getMinutes()) : "";
    const tgt = job.targetAt ? new Date(job.targetAt) : null;
    $("mljeDueHint").textContent = (tgt && !isNaN(tgt))
      ? ` · SLA due by ${pd(tgt)} ${p2(tgt.getHours())}:${p2(tgt.getMinutes())}` : "";
    $("mljeEngineers").innerHTML = '<span class="mlje-hint">Loading engineers…</span>';
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
    // Engineer tick-list (multi — same as the scheduler).
    const assigned = (Array.isArray(job.assignedEngineers) && job.assignedEngineers.length
      ? job.assignedEngineers : (job.assignedTo ? [job.assignedTo] : []))
      .filter(Boolean).map(a => String(a).toLowerCase());
    const box = $("mljeEngineers");
    box.innerHTML = "";
    (engineers || []).forEach(e => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = e.username;
      input.checked = assigned.includes(e.username.toLowerCase());
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + e.name));
      box.appendChild(label);
    });
    if (!engineers || !engineers.length) box.innerHTML = '<span class="mlje-hint">Couldn’t load the engineer list.</span>';
    // Deleting is for SLA admins only (the server enforces this too). This
    // server-confirmed check only ever ADDS the button (e.g. first login on a
    // new device before the permission cache exists) — it never removes it,
    // so a failed fetch on weak signal can't hide it from a real admin.
    if (currentJob && isSlaAdmin(me)) $("mljeDelete").style.display = "";
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

    // Schedule from the date · start · finish boxes. Empty boxes = unscheduled
    // (explicit nulls clear the server fields). A finish at-or-before the start
    // rolls to the next day (evening access windows).
    const schedDate = $("mljeSchedDate").value;
    const schedStart = $("mljeSchedStart").value;
    const schedEnd = $("mljeSchedEnd").value;
    let scheduledAt = null, scheduledEnd = null;
    if (schedDate || schedStart) {
      const dateStr = schedDate || (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; })();
      const start = new Date(dateStr + "T" + (schedStart || "08:00") + ":00");
      if (!isNaN(start)) {
        scheduledAt = start.toISOString();
        if (schedEnd) {
          const end = new Date(dateStr + "T" + schedEnd + ":00");
          if (!isNaN(end)) {
            if (end <= start) end.setDate(end.getDate() + 1);
            scheduledEnd = end.toISOString();
          }
        }
      }
    }
    const assignedEngineers = [...document.querySelectorAll("#mljeEngineers input:checked")].map(c => c.value);

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
      scheduledAt: scheduledAt,
      // No finish typed: omit the field so the server keeps the job's duration
      // (sending null would erase the finish time). Cleared schedule: null both.
      scheduledEnd: scheduledAt === null ? null : (scheduledEnd || undefined),
      assignedEngineers: assignedEngineers,
      assignedTo: assignedEngineers[0] || "",
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
      closeTimer = setTimeout(close, 400);
    } catch (e) {
      msg.textContent = "❌ Couldn't save the job (" + e.message + ").";
      msg.className = "mlje-msg err";
      $("mljeSave").disabled = false;
    }
  }

  async function del() {
    if (!currentJob) return;
    const ref = currentJob.helpdeskRef || currentJob.id;
    if (!confirm(`Delete job ${ref} completely?\n\nThis permanently removes the job, its history and its photos/files. It cannot be undone.`)) return;
    const msg = $("mljeMsg");
    msg.className = "mlje-msg";
    msg.textContent = "Deleting…";
    $("mljeDelete").disabled = true;
    try {
      const r = await authFetch("/sla/jobs/" + encodeURIComponent(currentJob.id), { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || ("HTTP " + r.status));
      msg.textContent = "🗑 Deleted.";
      msg.className = "mlje-msg ok";
      if (onDeletedCb) { try { onDeletedCb(null); } catch (e) {} }
      closeTimer = setTimeout(close, 400);
    } catch (e) {
      msg.textContent = "❌ Couldn't delete the job (" + e.message + ").";
      msg.className = "mlje-msg err";
      $("mljeDelete").disabled = false;
    }
  }

  window.MLJobEdit = { open, wheelify };
})();
