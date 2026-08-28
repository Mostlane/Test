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

  // Clean "Job name" for titles everywhere, formatted "{Job number} - {Site name}"
  // (e.g. "26819 - Poole, Ringwood Road"). The job number is the ticket that
  // prefixes the id ("26819-Poole, Ringwood Road", "27882/1-Marchwood",
  // "P0002-…"); it can also lead the reference. The site name is the clean
  // siteName (falling back to the reference minus its number, then the site
  // code). A job with no derivable number just shows its site name.
  function mlJobName(job) {
    if (!job) return "";
    const id = String(job.id || "");
    const ref = String(job.helpdeskRef || "").trim();
    // Job/ticket number: id prefix "<num>-…", else the number that leads the ref.
    // NEVER off a raw UUID id — a segment like "d7356541-…" (hex) would otherwise
    // be misread as a ticket number and stuck in front of a manual job's site.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let m = UUID.test(id) ? null : id.match(/^([A-Za-z]?\d+(?:\/\d+)?)-/);
    let num = m ? m[1] : ((ref.match(/^([A-Za-z]?\d+(?:\/\d+)?)\b/) || [])[1] || "");
    // Drop a leading "<num> - " / "<num>, " that's baked into a string.
    const stripNum = s => String(s || "").replace(/^\s*[A-Za-z]?\d+(?:\/\d+)?\s*[-–,]\s*/, "").trim();
    // Site name: prefer siteName; else pull the site out of a short reference
    // (not a long fault sentence); else the site code.
    let site = String(job.siteName || "").trim();
    if (!site) {
      const refSite = (ref && ref.length <= 70 && /\s/.test(ref) && !/[.!?]/.test(ref)) ? stripNum(ref) : "";
      site = refSite || String(job.siteCode || "").trim();
    }
    site = stripNum(site) || site;   // de-duplicate a number already in siteName
    if (num && site) return num + " - " + site;
    return site || num || (ref && ref.length <= 40 ? ref : "") || "";
  }
  window.mlJobName = mlJobName;

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

  const BASE_STATUSES = ["Pending", "Scheduled", "Travelling", "In Progress", "On Hold", "Quote", "Order", "Complete", "Invoiced", "Closed Jobs"];
  let STATUSES = BASE_STATUSES.slice();   // built-ins + custom categories (loaded lazily)
  let catsLoaded = false;
  async function loadCats() {
    try {
      const r = await authFetch("/sla/categories?t=" + Date.now());
      const d = await r.json();
      const names = (Array.isArray(d.categories) ? d.categories : []).map(c => c && c.name).filter(Boolean);
      STATUSES = BASE_STATUSES.concat(names.filter(n => !BASE_STATUSES.some(b => b.toLowerCase() === n.toLowerCase())));
    } catch (e) { /* keep built-ins on failure */ }
    catsLoaded = true;
  }
  // Areas of work for the work-area picker (loaded once). Hidden when none exist.
  let WORK_AREAS = null;
  async function loadWorkAreas() {
    const sel = $("mljeWorkArea"); if (!sel) return;
    if (WORK_AREAS) return;
    try {
      const d = await (await authFetch("/sla/work-areas?t=" + Date.now())).json();
      WORK_AREAS = (d && d.areas) || [];
    } catch (e) { WORK_AREAS = []; }
    if (!WORK_AREAS.length) return;   // keep the field hidden
    sel.innerHTML = '<option value="">— none —</option>' + WORK_AREAS.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
    const wrap = $("mljeWorkAreaWrap"); if (wrap) wrap.style.display = "";
  }
  async function suggestWorkAreaEdit() {
    const sel = $("mljeWorkArea"), hint = $("mljeWaHint"), btn = $("mljeWaSuggest");
    if (!sel) return;
    const desc = ($("mljeDesc").value || "").trim();
    if (desc.length < 8) { if (hint) hint.textContent = "Type a description first, then Suggest."; return; }
    if (hint) hint.textContent = "🤖 Suggesting…"; if (btn) btn.disabled = true;
    try {
      const r = await (await authFetch("/sla/infer-work-area", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: desc }) })).json();
      if (r && r.capped) { if (hint) hint.textContent = r.error || "Daily AI limit reached."; }
      else if (r && r.ok && r.areaId) { sel.value = r.areaId; if (hint) hint.textContent = "🤖 Suggested: " + (r.name || r.areaId) + " — change it if wrong."; }
      else if (r && r.ok) { if (hint) hint.textContent = "AI couldn't match an area — pick one if needed."; }
      else { if (hint) hint.textContent = (r && r.error) || "Couldn't suggest — pick one manually."; }
    } catch (e) { if (hint) hint.textContent = "Couldn't reach the AI."; }
    if (btn) btn.disabled = false;
  }
  // Rebuild the status dropdown; always include the job's own status so an
  // orphaned/custom value still shows selected instead of silently blank.
  function buildStatusOptions(current) {
    // Projects have a slim status set — no On Hold / Quote / custom categories.
    const proj = currentJob && (/^p\d/i.test(String(currentJob.siteCode || "")) ||
      /project/i.test(String(currentJob.storeType || currentJob.client || "")));
    const list = proj ? ["Scheduled", "Travelling", "In Progress", "Complete"] : STATUSES.slice();
    if (current && !list.some(s => s.toLowerCase() === String(current).toLowerCase())) list.push(current);
    const sel = $("mljeStatus");
    if (sel) sel.innerHTML = list.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  }
  const PRIORITIES = [["Priority 1", "P1 – Emergency"], ["Priority 2", "P2 – Urgent"], ["Priority 3", "P3 – Routine"], ["Priority 4", "P4 – Low"]];

  /* ---- injected styles + DOM ---- */
  const CSS = `
  .mlje-back{position:fixed;inset:0;background:rgba(15,23,42,.45);display:none;align-items:center;justify-content:center;z-index:100000;padding:12px;}
  .mlje-back.show{display:flex;}
  .mlje-modal{background:#fff;border-radius:14px;max-width:520px;width:100%;box-shadow:0 24px 48px rgba(0,0,0,.3);padding:16px;max-height:94vh;display:flex;flex-direction:column;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;}
  /* Editing is desktop-only — give it room so short forms don't scroll. */
  @media(min-width:820px){ .mlje-modal{max-width:760px;padding:20px;} }
  /* Collapsible section (Site, per-engineer visibility) — a details/summary card. */
  details.mlje-coll > summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;color:#003b82;font-size:13px;margin:0;}
  details.mlje-coll > summary::-webkit-details-marker{display:none;}
  details.mlje-coll > summary::after{content:"▸";margin-left:auto;color:#94a3b8;font-size:12px;}
  details.mlje-coll[open] > summary::after{content:"▾";}
  details.mlje-coll > summary h3{margin:0;font-size:13px;color:#003b82;}
  details.mlje-coll > summary .mlje-collsub{font-weight:400;color:#64748b;font-size:12px;}
  details.mlje-coll > .mlje-collbody{margin-top:8px;}
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
  .mlje-visbtn{border:1px solid #cbd5e1;border-radius:8px;padding:9px 12px;font:600 13.5px inherit;cursor:pointer;background:#f1f6ff;color:#003b82;text-align:left;width:100%;margin-top:2px;}
  .mlje-visbtn.set{background:#e6f6ec;color:#0a6b33;border-color:#b6e3c6;}
  .mlje-vispanel{border:1px solid #cbd5e1;border-radius:8px;padding:6px 10px;margin-top:6px;background:#fff;}
  .mlje-visopt{display:flex;align-items:flex-start;gap:9px;padding:8px 2px;border-top:1px solid #eef2f7;margin:0;cursor:pointer;font-weight:500;}
  .mlje-visopt:first-child{border-top:none;}
  .mlje-visopt input{width:auto;margin:3px 0 0;flex:0 0 auto;transform:scale(1.15);}
  .mlje-visopt span{display:flex;flex-direction:column;}
  .mlje-visopt small{color:#64748b;font-size:12px;font-weight:400;margin-top:1px;}
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
      <label for="mljeRef">Job name</label>
      <input id="mljeRef" type="text" placeholder="e.g. 28667-Eastbourne, Beatty Road">
      <div class="mlje-hint">How the job shows on the board and to the engineer — edit it for a clearer name.</div>

      <label for="mljeDesc">Description</label>
      <textarea id="mljeDesc"></textarea>

      <div id="mljeWorkAreaWrap" style="display:none;">
        <label for="mljeWorkArea">Area of work</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="mljeWorkArea" style="flex:1;"><option value="">— none —</option></select>
          <button type="button" id="mljeWaSuggest" class="mlje-btn" title="Let AI suggest the area from the description">🤖 Suggest</button>
        </div>
        <div class="mlje-hint" id="mljeWaHint">Matches the job to a competent engineer. AI can suggest one — change it if wrong.</div>
      </div>

      <div class="mlje-2">
        <div id="mljePriorityWrap">
          <label for="mljePriority">Priority</label>
          <select id="mljePriority"></select>
        </div>
        <div>
          <label for="mljeStatus">Status</label>
          <select id="mljeStatus"></select>
        </div>
      </div>

      <details class="mlje-raised" style="margin:2px 0 6px;">
        <summary style="cursor:pointer;font-size:12.5px;color:#64748b;list-style:none;">⌄ Raised date &amp; time <span style="font-weight:400;">(rarely needed)</span></summary>
        <input id="mljeRaised" type="datetime-local" style="margin-top:6px;">
      </details>

      <div class="mlje-site">
        <h3>Schedule &amp; engineers</h3>
        <label>Assigned engineers (tick all that will attend)</label>
        <div class="mlje-engs" id="mljeEngineers"><span class="mlje-hint">Loading engineers…</span></div>
        <label class="mlje-chk" style="margin-top:4px;"><input type="checkbox" id="mljeShowOffice"> Show office / admin staff too <small style="font-weight:400;color:#64748b;">(normally hidden — engineers only)</small></label>
        <div class="mlje-hint" style="margin-top:4px;">Tick everyone attending. Two or more engineers share the one job.</div>

        <label for="mljeSchedDate">Scheduled date &amp; times</label>
        <div class="mlje-3">
          <input id="mljeSchedDate" type="date" aria-label="Scheduled date">
          <input id="mljeSchedStart" type="time" step="300" aria-label="Start time">
          <input id="mljeSchedEnd" type="time" step="300" aria-label="Finish time">
        </div>
        <div class="mlje-hint">Date · start · finish. Scroll the mouse wheel over a box to nudge it (15&nbsp;min / 1&nbsp;day steps). <a href="javascript:void(0)" id="mljeSchedClear">Clear schedule</a><span id="mljeDueHint"></span></div>

        <label for="mljeDuration">Expected duration <small style="font-weight:400;color:#64748b;">(time on site — used to predict the route/day)</small></label>
        <select id="mljeDuration" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;">
          <option value="15">¼ hour</option>
          <option value="30">½ hour</option>
          <option value="45">¾ hour</option>
          <option value="60" selected>1 hour</option>
          <option value="90">1½ hours</option>
          <option value="120">2 hours</option>
          <option value="150">2½ hours</option>
          <option value="180">3 hours</option>
          <option value="240">4 hours</option>
          <option value="300">5 hours</option>
          <option value="360">6 hours</option>
          <option value="480">Full day (8 hours)</option>
        </select>
        <div class="mlje-hint">If you set a finish time above, that wins; otherwise this sets it.</div>

        <div id="mljeEngSchedWrap" style="display:none;margin-top:12px;border:1px solid #e2e8f0;border-radius:10px;padding:10px;background:#f8fafc;">
          <div style="font-weight:600;font-size:13.5px;color:#003366;margin-bottom:2px;">Per-engineer times <small style="font-weight:400;color:#64748b;">(each can be a different day/time — the shared date/time above is the default)</small></div>
          <div class="mlje-hint" style="margin-bottom:8px;">They all work the same job &amp; shared list; only their own slot differs. Leave a row blank to follow the shared time.</div>
          <div id="mljeEngSched"></div>
        </div>

        <label style="margin-top:12px;">When the engineer sees this job</label>
        <button type="button" id="mljeVisBtn" class="mlje-visbtn">👁 Visible now ▾</button>
        <div id="mljeVisPanel" class="mlje-vispanel" style="display:none;">
          <label class="mlje-visopt"><input type="radio" name="mljeVis" value="now" checked> <span><b>Visible now</b><small>The engineer sees it straight away (default).</small></span></label>
          <label class="mlje-visopt"><input type="radio" name="mljeVis" value="dayBefore"> <span><b>5pm the day before</b><small>Hidden until 17:00 the evening before the scheduled day.</small></span></label>
          <label class="mlje-visopt"><input type="radio" name="mljeVis" value="at"> <span><b>At a set date &amp; time…</b><small>You choose exactly when it appears.</small></span></label>
          <input type="datetime-local" id="mljeVisAt" style="display:none;margin:4px 0 4px 30px;width:calc(100% - 30px);">
          <label class="mlje-visopt"><input type="radio" name="mljeVis" value="afterPrev"> <span><b>After the previous job that day</b><small>Stacks the day: this appears once the engineer finishes their earlier job. Set this on each queued job to drip them out one-by-one.</small></span></label>
        </div>

        <details class="mlje-coll" id="mljeEngRelWrap" style="display:none;margin-top:10px;border:1px solid #e2e8f0;border-radius:10px;padding:9px 11px;background:#fff;">
          <summary>When <b style="margin:0 3px;">each</b> engineer sees it <span class="mlje-collsub">— override per person</span></summary>
          <div class="mlje-collbody">
            <div class="mlje-hint" style="margin-bottom:6px;">Each engineer starts from the setting above — change a row to give that person their own time.</div>
            <div id="mljeEngRel"></div>
          </div>
        </details>
      </div>

      <details class="mlje-site mlje-coll">
        <summary><h3>Site</h3></summary>
        <div class="mlje-collbody">
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
      </details>

      <label style="margin-top:4px;">On-site requirements <small style="font-weight:400;color:#64748b;">(what the engineer must do to complete)</small></label>
      <div style="display:flex;flex-wrap:wrap;gap:10px 18px;margin-bottom:4px;">
        <label class="mlje-chk"><input type="checkbox" id="mljeReqRA"> Risk assessment</label>
        <label class="mlje-chk"><input type="checkbox" id="mljeReqSig"> Customer signature</label>
        <label class="mlje-chk"><input type="checkbox" id="mljeReqPhoto"> Completion photo</label>
        <label class="mlje-chk"><input type="checkbox" id="mljeReqNote"> Completion note</label>
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
    buildStatusOptions();
    // Format toolbar (bold / colour / ⚠🚨 emoji) above the description.
    try { if (window.MLUI && MLUI.richBar) MLUI.richBar("mljeDesc"); } catch (e) {}
    // Auto-grow the description to fit its text (capped ~50% of the screen, then
    // it scrolls) — so an edited job's full description shows without an inner scroll.
    $("mljeDesc").addEventListener("input", autosizeDesc);

    $("mljeCancel").addEventListener("click", close);
    back.addEventListener("click", e => { if (e.target === back) close(); });
    $("mljeSave").addEventListener("click", save);
    $("mljeDelete").addEventListener("click", del);
    { const wb = $("mljeWaSuggest"); if (wb) wb.addEventListener("click", suggestWorkAreaEdit); }
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
    // Visibility ("release") control: toggle the panel, show the datetime box only
    // for "At a set time", and reflect the chosen mode on the button.
    $("mljeVisBtn").addEventListener("click", () => {
      const p = $("mljeVisPanel"); p.style.display = p.style.display === "none" ? "block" : "none";
    });
    back.querySelectorAll('input[name="mljeVis"]').forEach(r => r.addEventListener("change", () => {
      $("mljeVisAt").style.display = (visMode() === "at") ? "block" : "none";
      updateVisBtn(); renderEngRel();
    }));
    $("mljeVisAt").addEventListener("change", () => { updateVisBtn(); renderEngRel(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && $("mljeBack").classList.contains("show")) close(); });
    wheelify(back);
  }
  function visMode() { const c = document.querySelector('input[name="mljeVis"]:checked'); return c ? c.value : "now"; }
  function updateVisBtn() {
    const m = visMode(), btn = $("mljeVisBtn");
    let label = "👁 Visible now";
    if (m === "dayBefore") label = "🕔 5pm the day before";
    else if (m === "afterPrev") label = "⛓ After the previous job that day";
    else if (m === "at") { const v = $("mljeVisAt").value; label = v ? "🕒 " + new Date(v).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "🕒 At a set time…"; }
    btn.textContent = label + " ▾";
    btn.classList.toggle("set", m !== "now");
  }

  /* ---- mouse-wheel stepping on date/time boxes ----
     Hover a box and scroll: times step 15 min (hold Shift for 1 h), dates step
     1 day, numbers step by their step attribute. Beats the tiny spinner arrows. */
  const p2 = n => String(n).padStart(2, "0");
  // Per-engineer scheduling (multi-engineer jobs): each ticked engineer gets a
  // row (date · start · finish) so they can sit at a different day/time — the
  // shared date/time is the default for anyone left blank.
  function mljeNorm(s) { return String(s || "").toLowerCase().replace(/\s+/g, ".").trim(); }
  function engNameFor(username) { const e = (engineers || []).find(x => x.username && x.username.toLowerCase() === String(username).toLowerCase()); return e ? e.name : username; }
  function renderEngSched() {
    const wrap = $("mljeEngSchedWrap"), host = $("mljeEngSched"); if (!wrap || !host) return;
    const checked = [...document.querySelectorAll("#mljeEngineers input:checked")].map(c => c.value);
    if (checked.length < 2) { wrap.style.display = "none"; host.innerHTML = ""; return; }
    wrap.style.display = "";
    // keep any values already typed for still-ticked engineers on a re-render
    const prev = {};
    host.querySelectorAll(".mlje-es-row").forEach(r => { prev[r.dataset.user.toLowerCase()] = { d: r.querySelector(".es-d").value, s: r.querySelector(".es-s").value, f: r.querySelector(".es-f").value }; });
    const es = (currentJob && currentJob.engSchedule) || {};
    host.innerHTML = checked.map(u => {
      let d = "", s = "", f = "";
      const p = prev[u.toLowerCase()];
      if (p) { d = p.d; s = p.s; f = p.f; }
      else { const o = es[mljeNorm(u)]; if (o && o.scheduledAt) { const a = new Date(o.scheduledAt); if (!isNaN(a)) { d = a.getFullYear() + "-" + p2(a.getMonth() + 1) + "-" + p2(a.getDate()); s = p2(a.getHours()) + ":" + p2(a.getMinutes()); } if (o.scheduledEnd) { const b = new Date(o.scheduledEnd); if (!isNaN(b)) f = p2(b.getHours()) + ":" + p2(b.getMinutes()); } } }
      return '<div class="mlje-es-row" data-user="' + esc(u) + '" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">'
        + '<span style="flex:0 0 120px;font-size:13px;font-weight:600;">' + esc(engNameFor(u)) + '</span>'
        + '<input class="es-d" type="date" value="' + esc(d) + '" style="flex:1;min-width:130px;padding:6px;border:1px solid #cbd5e1;border-radius:8px;">'
        + '<input class="es-s" type="time" step="300" value="' + esc(s) + '" style="flex:0 0 96px;padding:6px;border:1px solid #cbd5e1;border-radius:8px;">'
        + '<span style="font-size:12px;color:#64748b;">to</span>'
        + '<input class="es-f" type="time" step="300" value="' + esc(f) + '" style="flex:0 0 96px;padding:6px;border:1px solid #cbd5e1;border-radius:8px;">'
        + '</div>';
    }).join("");
  }
  function autosizeDesc() {
    const t = document.getElementById("mljeDesc"); if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, Math.round(window.innerHeight * 0.5)) + "px";
  }
  function relOpt(v, l, cur) { return '<option value="' + v + '"' + (v === cur ? " selected" : "") + '>' + l + '</option>'; }
  // Per-engineer visibility ("release"): each engineer defaults to the job-level
  // setting; a row that differs becomes their own override. Shown only for 2+.
  function renderEngRel() {
    const wrap = $("mljeEngRelWrap"), host = $("mljeEngRel"); if (!wrap || !host) return;
    const checked = [...document.querySelectorAll("#mljeEngineers input:checked")].map(c => c.value);
    if (checked.length < 2) { wrap.style.display = "none"; wrap.open = false; host.innerHTML = ""; return; }
    wrap.style.display = "";
    const defMode = (document.querySelector('input[name="mljeVis"]:checked') || {}).value || "now";
    const defAt = $("mljeVisAt").value || "";
    const prev = {};
    host.querySelectorAll(".mlje-er-row").forEach(r => { prev[r.dataset.user.toLowerCase()] = { m: r.querySelector(".er-m").value, a: (r.querySelector(".er-a") || {}).value || "" }; });
    const er = (currentJob && currentJob.engRelease) || {};
    host.innerHTML = checked.map(u => {
      let mode = defMode, at = defAt;
      const p = prev[u.toLowerCase()];
      if (p) { mode = p.m; at = p.a; }
      else { const o = er[mljeNorm(u)]; if (o && o.mode) { mode = o.mode; if (o.mode === "at" && o.at) at = toLocalInput(o.at); } }
      return '<div class="mlje-er-row" data-user="' + esc(u) + '" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">'
        + '<span style="flex:0 0 120px;font-size:13px;font-weight:600;">' + esc(engNameFor(u)) + '</span>'
        + '<select class="er-m" style="flex:1;min-width:150px;padding:6px;border:1px solid #cbd5e1;border-radius:8px;">'
        + relOpt("now", "Visible now", mode) + relOpt("dayBefore", "5pm the day before", mode) + relOpt("at", "At a set time…", mode) + relOpt("afterPrev", "After previous job", mode)
        + '</select>'
        + '<input class="er-a" type="datetime-local" value="' + esc(at) + '" style="flex:0 0 200px;padding:6px;border:1px solid #cbd5e1;border-radius:8px;' + (mode === "at" ? "" : "display:none;") + '">'
        + '</div>';
    }).join("");
    host.querySelectorAll(".mlje-er-row").forEach(r => { const m = r.querySelector(".er-m"), a = r.querySelector(".er-a"); m.onchange = () => { a.style.display = m.value === "at" ? "" : "none"; }; });
  }
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
        engineers = list.map(u => ({ username: u.Username, name: ((u.FirstName || "") + " " + (u.LastName || "")).trim() || u.Username, staffType: (u.StaffType === "office" ? "office" : "field") }));
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

  // Duration always reads in HOURS (never minutes) — e.g. 90 → "1½ hours".
  function hrLabel(min) {
    const h = min / 60, w = Math.floor(h), f = Math.round((h - w) * 100) / 100;
    const fr = { 0.25: "¼", 0.5: "½", 0.75: "¾" }[f];
    if (fr) return (w ? w + fr : fr) + " hour" + (w ? "s" : "");
    if (Number.isInteger(h)) return h + " hour" + (h === 1 ? "" : "s");
    return (Math.round(h * 100) / 100) + " hours";
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
    openEngineers = (job.assignedEngineers && job.assignedEngineers.slice()) || (job.assignedTo ? [job.assignedTo] : []);
    onSavedCb = (opts && opts.onSaved) || null;
    onDeletedCb = (opts && opts.onDeleted) || (opts && opts.onSaved) || null;
    pickedSite = null;
    $("mljeTitle").textContent = "Edit job — " + (mlJobName(job) || job.helpdeskRef || job.id);
    $("mljeRef").value = job.helpdeskRef || "";
    $("mljeDesc").value = job.description || "";
    autosizeDesc();
    $("mljePriority").value = job.priority || "Priority 4";
    // Status list = built-ins + custom categories. Show the job's own value even
    // before the category fetch returns; refresh the list once it does.
    buildStatusOptions(job.status);
    $("mljeStatus").value = job.status || "Pending";
    loadCats().then(() => { buildStatusOptions(currentJob && currentJob.status); if (currentJob) $("mljeStatus").value = currentJob.status || "Pending"; });
    $("mljeRaised").value = toLocalInput(job.raisedAt);
    loadWorkAreas().then(() => { const s = $("mljeWorkArea"); if (s) s.value = job.workArea || ""; });
    // On-site requirements — reflect the job's flags (project-aware default when unset).
    const isProjJob = /^p\d/i.test(String(job.siteCode || "")) || /project/i.test(String(job.storeType || job.client || ""));
    // Projects have no priority level — hide the field entirely for them.
    const pw = $("mljePriorityWrap"); if (pw) pw.style.display = isProjJob ? "none" : "";
    const reqOf = k => (job[k] !== undefined ? !!job[k] : !isProjJob);
    $("mljeReqRA").checked = reqOf("requiresRA");
    $("mljeReqSig").checked = reqOf("requiresSignature");
    $("mljeReqPhoto").checked = reqOf("requiresPhoto");
    $("mljeReqNote").checked = reqOf("requiresNote");
    // Schedule (date · start · finish) — empty boxes mean "not scheduled".
    const sAt = job.scheduledAt ? new Date(job.scheduledAt) : null;
    const sEnd = job.scheduledEnd ? new Date(job.scheduledEnd) : null;
    const pd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    $("mljeSchedDate").value = (sAt && !isNaN(sAt)) ? pd(sAt) : "";
    $("mljeSchedStart").value = (sAt && !isNaN(sAt)) ? p2(sAt.getHours()) + ":" + p2(sAt.getMinutes()) : "";
    $("mljeSchedEnd").value = (sEnd && !isNaN(sEnd)) ? p2(sEnd.getHours()) + ":" + p2(sEnd.getMinutes()) : "";
    // Expected duration: the job's own field, else derived from start→finish, else 1h.
    {
      let dm = (job.durationMinutes && job.durationMinutes >= 15) ? Math.round(job.durationMinutes)
        : ((sAt && sEnd && !isNaN(sAt) && !isNaN(sEnd) && sEnd > sAt) ? Math.round((sEnd - sAt) / 60000) : 60);
      const sel = $("mljeDuration"), v = String(Math.max(15, dm));
      if (sel) {
        if (![...sel.options].some(o => o.value === v)) {
          const o = document.createElement("option");
          o.value = v; o.textContent = hrLabel(Number(v));
          sel.insertBefore(o, sel.firstChild);
        }
        sel.value = v;
      }
    }
    const tgt = job.targetAt ? new Date(job.targetAt) : null;
    $("mljeDueHint").textContent = (tgt && !isNaN(tgt))
      ? ` · SLA due by ${pd(tgt)} ${p2(tgt.getHours())}:${p2(tgt.getMinutes())}` : "";
    // Visibility ("release") control — reflect the job's current setting.
    const rel = job.release || {};
    const relMode = (rel.mode && rel.mode !== "now") ? rel.mode : "now";
    const relRadio = document.querySelector('input[name="mljeVis"][value="' + relMode + '"]');
    if (relRadio) relRadio.checked = true;
    $("mljeVisAt").value = (relMode === "at" && rel.at) ? toLocalInput(rel.at) : "";
    $("mljeVisAt").style.display = (relMode === "at") ? "block" : "none";
    $("mljeVisPanel").style.display = "none";
    updateVisBtn();
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
    // Office/admin staff are hidden by default (rarely assigned jobs) — shown
    // only when the "Show office staff" tick is on OR they're already on this
    // job. Re-painting preserves whatever is currently ticked.
    function paintEngineers(showOffice) {
      const nowChecked = new Set([...box.querySelectorAll("input:checked")].map(i => i.value.toLowerCase()));
      const on = u => assigned.includes(u.toLowerCase()) || nowChecked.has(u.toLowerCase());
      box.innerHTML = "";
      (engineers || []).forEach(e => {
        const isOffice = e.staffType === "office";
        if (isOffice && !showOffice && !on(e.username)) return;
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = e.username;
        input.checked = on(e.username);
        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + e.name + (isOffice ? " (office)" : "")));
        box.appendChild(label);
      });
      if (!engineers || !engineers.length) box.innerHTML = '<span class="mlje-hint">Couldn’t load the engineer list.</span>';
    }
    const showOfficeTog = $("mljeShowOffice");
    if (showOfficeTog) { showOfficeTog.checked = false; showOfficeTog.onchange = () => { paintEngineers(showOfficeTog.checked); renderEngSched(); renderEngRel(); }; }
    paintEngineers(false);
    // Per-engineer time rows appear when 2+ engineers are ticked (re-render on tick).
    if (!box._esHooked) { box.addEventListener("change", () => { renderEngSched(); renderEngRel(); }); box._esHooked = true; }
    renderEngSched();
    renderEngRel();
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
        let existing = pickedSite;
        // The job already carries a site but the user didn't re-pick it from the
        // dropdown — resolve it from the job's site code so ticking "save" UPDATES
        // that site (adds the phone/address) instead of creating a duplicate.
        if (!existing && currentJob.siteCode) {
          const want = String(currentJob.siteCode).replace(/\D/g, "");
          existing = (sites || []).find(s => String(s.rawNumber).replace(/\D/g, "") === want) || null;
        }
        let client;
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
    // Expected duration: a typed finish wins (so the picker never fights the
    // finish box); otherwise the duration picker. Persisted even when unscheduled.
    let durationMinutes = Number($("mljeDuration") && $("mljeDuration").value) || null;
    if (scheduledAt && scheduledEnd) {
      const dm = Math.round((Date.parse(scheduledEnd) - Date.parse(scheduledAt)) / 60000);
      if (dm >= 15) durationMinutes = dm;
    }
    const assignedEngineers = [...document.querySelectorAll("#mljeEngineers input:checked")].map(c => c.value);

    // Per-engineer schedule (multi-engineer only). Each row that has a date/start
    // becomes that engineer's own slot; blank rows follow the shared time above.
    // Sent as a full REPLACE ({} clears it) so single-engineer jobs use the shared
    // time. If the shared schedule is blank, the earliest per-engineer slot seeds
    // the job's top-level time (so the board/release still have one).
    const engSchedule = {};
    if (assignedEngineers.length >= 2) {
      document.querySelectorAll("#mljeEngSched .mlje-es-row").forEach(row => {
        const u = row.dataset.user;
        if (!assignedEngineers.some(a => a.toLowerCase() === String(u).toLowerCase())) return;
        const d = row.querySelector(".es-d").value, s = row.querySelector(".es-s").value, f = row.querySelector(".es-f").value;
        if (!d && !s) return;   // blank → follow the shared time
        const dateStr = d || schedDate || (() => { const x = new Date(); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; })();
        const st = new Date(dateStr + "T" + (s || "08:00") + ":00");
        if (isNaN(st)) return;
        let en = null;
        if (f) { const e = new Date(dateStr + "T" + f + ":00"); if (!isNaN(e)) { if (e <= st) e.setDate(e.getDate() + 1); en = e.toISOString(); } }
        engSchedule[mljeNorm(u)] = { scheduledAt: st.toISOString(), scheduledEnd: en };
      });
    }
    if (!scheduledAt && Object.keys(engSchedule).length) {
      const arr = Object.values(engSchedule).filter(x => x.scheduledAt).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
      if (arr[0]) { scheduledAt = arr[0].scheduledAt; if (!scheduledEnd) scheduledEnd = arr[0].scheduledEnd; }
    }

    // Visibility ("release"): null = visible now, else the chosen mode.
    let release = null;
    const vm = visMode();
    if (vm === "at") { const v = $("mljeVisAt").value; release = v ? { mode: "at", at: new Date(v).toISOString() } : null; }
    else if (vm === "dayBefore") release = { mode: "dayBefore" };
    else if (vm === "afterPrev") release = { mode: "afterPrev" };

    // Per-engineer visibility overrides (multi-engineer only). A row that DIFFERS
    // from the job-level release above becomes that engineer's own override; rows
    // matching the default fall back to it. Full REPLACE ({} clears it).
    const engRelease = {};
    if (assignedEngineers.length >= 2) {
      const defMode = vm, defAt = (vm === "at") ? ($("mljeVisAt").value || "") : "";
      document.querySelectorAll("#mljeEngRel .mlje-er-row").forEach(row => {
        const u = row.dataset.user;
        if (!assignedEngineers.some(a => a.toLowerCase() === String(u).toLowerCase())) return;
        const m = row.querySelector(".er-m").value, aEl = row.querySelector(".er-a"), aVal = aEl ? aEl.value : "";
        const differs = (m !== defMode) || (m === "at" && aVal !== defAt);
        if (!differs) return;   // same as the job-level default → no override
        if (m === "now") engRelease[mljeNorm(u)] = { mode: "now" };
        else if (m === "at") { if (aVal) engRelease[mljeNorm(u)] = { mode: "at", at: new Date(aVal).toISOString() }; }
        else if (m === "dayBefore") engRelease[mljeNorm(u)] = { mode: "dayBefore" };
        else if (m === "afterPrev") engRelease[mljeNorm(u)] = { mode: "afterPrev" };
      });
    }

    // Patch the job with every edited detail.
    const raisedLocal = $("mljeRaised").value;
    const payload = {
      release: release,
      engRelease: engRelease,   // per-engineer overrides (full replace; {} clears)
      helpdeskRef: $("mljeRef").value.trim() || undefined,
      description: $("mljeDesc").value.trim() || undefined,
      priority: $("mljePriority").value,
      status: $("mljeStatus").value,
      workArea: $("mljeWorkArea") ? ($("mljeWorkArea").value || "") : undefined,
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
      durationMinutes: durationMinutes || undefined,
      assignedEngineers: assignedEngineers,
      assignedTo: assignedEngineers[0] || "",
      engSchedule: engSchedule,   // full replace ({} clears — single-engineer uses the shared time)
      requiresRA: $("mljeReqRA").checked,
      requiresSignature: $("mljeReqSig").checked,
      requiresPhoto: $("mljeReqPhoto").checked,
      requiresNote: $("mljeReqNote").checked,
      changedBy: currentUser()
    };
    // Pre-save safeguard: warn if a NEWLY-added engineer already has job(s) that
    // day (incl. a project drip day). Runs before the save so the office can back
    // out; it's independent of the post-save series-clash + nearby suggestions.
    const preNewEngs = assignedEngineers.filter(e => e && openEngineers.indexOf(e) === -1);
    if (preNewEngs.length && scheduledAt) {
      const proceed = await warnDayClash(preNewEngs, scheduledAt, currentJob.id);
      if (!proceed) { msg.textContent = ""; $("mljeSave").disabled = false; return; }
    }
    try {
      msg.textContent = "Saving job…";
      const r = await authFetch("/sla/jobs/" + encodeURIComponent(currentJob.id), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const saved = await r.json();
      msg.textContent = "✅ Saved.";
      msg.className = "mlje-msg ok";
      const cb = onSavedCb;
      if (cb) { try { cb(saved); } catch (e) {} }
      // Clash with a project drip day? Offer to fit the project after this job,
      // skip it, or leave it (it auto-skips that day anyway).
      await maybeSeriesClash(saved);
      // Newly allocated to an operative? Offer same-site + nearby OPEN jobs to
      // batch onto the same person before we close.
      const newlyAssigned = assignedEngineers.filter(e => e && openEngineers.indexOf(e) === -1);
      if (newlyAssigned.length) { close(); maybeShowNearby(saved, newlyAssigned[0], cb); }
      else closeTimer = setTimeout(close, 400);
    } catch (e) {
      msg.textContent = "❌ Couldn't save the job (" + e.message + ").";
      msg.className = "mlje-msg err";
      $("mljeSave").disabled = false;
    }
  }

  // After allocating a job, check whether the engineer already has a project
  // drip-series day that date and let the office decide what to do with it.
  async function maybeSeriesClash(saved) {
    try {
      if (!saved || !saved.scheduledAt || saved.seriesId || saved.fallback) return;
      const engs = (Array.isArray(saved.assignedEngineers) && saved.assignedEngineers.length)
        ? saved.assignedEngineers : (saved.assignedTo ? [saved.assignedTo] : []);
      if (!engs.length) return;
      const date = new Date(saved.scheduledAt).toISOString().slice(0, 10);
      for (const eng of engs) {
        const res = await authFetch("/sla/series-clash?engineer=" + encodeURIComponent(eng) + "&date=" + date + "&excludeId=" + encodeURIComponent(saved.id));
        const d = await res.json().catch(() => ({}));
        const clash = d && d.clash;
        if (!clash) continue;
        const choice = await seriesClashPrompt(clash);
        if (choice === "fit") {
          const newStart = saved.scheduledEnd || saved.scheduledAt;
          const keepEnd = clash.scheduledEnd && Date.parse(clash.scheduledEnd) > Date.parse(newStart) ? clash.scheduledEnd : null;
          let dur = keepEnd ? Math.round((Date.parse(keepEnd) - Date.parse(newStart)) / 60000) : 60;
          if (!(dur > 0)) dur = 60;
          await authFetch("/sla/jobs/" + encodeURIComponent(clash.id), { method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scheduledAt: newStart, scheduledEnd: keepEnd || undefined, durationMinutes: dur }) });
        } else if (choice === "skip") {
          await authFetch("/sla/jobs/" + encodeURIComponent(clash.id), { method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seriesSkipped: true }) });
        }
        break;   // one clash decision is enough
      }
    } catch (e) { /* clash prompt is best-effort — the auto safeguard still covers it */ }
  }
  function seriesClashPrompt(clash) {
    return new Promise(resolve => {
      const day = clash.scheduledAt ? new Date(clash.scheduledAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "that day";
      // A "fallback"/filler day (the auto "at least a job for tomorrow" one) vs a
      // project drip-series day — same choices, different wording.
      const fb = clash.kind === "fallback";
      const title = fb ? "Auto job clash" : "Project day clash";
      const what = fb ? "an auto-added filler job" : "a project day";
      const fitLabel = fb ? "✅ Keep it — fit it in <b>after</b> this job" : "✅ Fit the project in <b>after</b> this job";
      const skipLabel = fb ? "🗑 Remove the auto job that day" : "⏭ Skip the project that day";
      const ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;background:rgba(0,20,40,.5);z-index:2147483400;display:flex;align-items:center;justify-content:center;padding:20px;font-family:inherit;";
      const btn = "display:block;width:100%;padding:11px;border-radius:10px;border:1px solid #d7dee6;font:600 14px inherit;cursor:pointer;text-align:left;";
      ov.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:410px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.3);">'
        + '<h3 style="margin:0 0 8px;color:#003366;font-size:17px;">' + title + '</h3>'
        + '<p style="margin:0 0 14px;color:#334;font-size:14px;line-height:1.5;">This engineer already has ' + what + ' on <b>' + day + '</b>. What should happen to it?</p>'
        + '<div style="display:flex;flex-direction:column;gap:8px;">'
        + '<button data-c="fit" style="' + btn + 'background:#003366;color:#fff;border-color:#003366;">' + fitLabel + '</button>'
        + '<button data-c="skip" style="' + btn + 'background:#fff;color:#991b1b;">' + skipLabel + '</button>'
        + '<button data-c="leave" style="' + btn + 'background:#f4f6f9;color:#475569;">Leave it for now</button>'
        + '</div></div>';
      ov.addEventListener("click", e => {
        const b = e.target.closest("[data-c]");
        if (b) { document.body.removeChild(ov); resolve(b.dataset.c); }
        else if (e.target === ov) { document.body.removeChild(ov); resolve("leave"); }
      });
      document.body.appendChild(ov);
    });
  }

  function engName(u) {
    const f = (engineers || []).find(x => String(x.username || "").toLowerCase() === String(u || "").toLowerCase());
    return (f && f.name) || u;
  }
  // Pre-save safeguard: does a newly-assigned engineer already have job(s) that
  // day? Returns true to proceed with the assignment, false to back out.
  async function warnDayClash(newEngs, scheduledAt, excludeId) {
    try {
      const date = new Date(scheduledAt).toISOString().slice(0, 10);
      const groups = [];
      for (const eng of newEngs) {
        const res = await authFetch("/sla/engineer-day?engineer=" + encodeURIComponent(eng) + "&date=" + date + "&excludeId=" + encodeURIComponent(excludeId || ""));
        const d = await res.json().catch(() => ({}));
        const jobs = (d && d.jobs) || [];
        if (jobs.length) groups.push({ eng, jobs });
      }
      if (!groups.length) return true;   // no clash — proceed silently
      return await dayClashPrompt(groups, date);
    } catch (e) { return true; }   // best-effort — never block a save on an error
  }
  function dayClashPrompt(groups, date) {
    return new Promise(resolve => {
      const dstr = (() => { try { return new Date(date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }); } catch { return date; } })();
      const tm = iso => { try { return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
      const body = groups.map(g => {
        const rows = g.jobs.map(j => '<li style="margin:2px 0;">' + (j.scheduledAt ? '<b>' + tm(j.scheduledAt) + '</b> · ' : '')
          + esc(j.ref) + (j.siteName ? ' <span style="color:#64748b;">— ' + esc(j.siteName) + '</span>' : '')
          + (j.series ? ' <span style="background:#ede9fe;color:#5b21b6;border-radius:6px;padding:0 6px;font-size:11px;">project day</span>' : '')
          + ' <span style="color:#64748b;font-size:12px;">' + esc(j.status) + '</span></li>').join("");
        return '<p style="margin:8px 0 2px;font-weight:700;color:#334;">' + esc(engName(g.eng)) + ' already has ' + g.jobs.length + ' job' + (g.jobs.length === 1 ? '' : 's') + ' this day:</p><ul style="margin:0 0 4px 18px;padding:0;font-size:13.5px;">' + rows + '</ul>';
      }).join("");
      const ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;background:rgba(0,20,40,.5);z-index:2147483400;display:flex;align-items:center;justify-content:center;padding:20px;font-family:inherit;";
      const btn = "padding:10px 16px;border-radius:10px;border:1px solid #d7dee6;font:600 14px inherit;cursor:pointer;";
      ov.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.3);max-height:80vh;overflow:auto;">'
        + '<h3 style="margin:0 0 6px;color:#92400e;font-size:17px;">⚠ Already booked that day</h3>'
        + '<p style="margin:0 0 6px;color:#334;font-size:13.5px;">On <b>' + dstr + '</b>:</p>'
        + body
        + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">'
        + '<button data-c="cancel" style="' + btn + 'background:#fff;color:#334;">Cancel</button>'
        + '<button data-c="ok" style="' + btn + 'background:#92400e;color:#fff;border-color:#92400e;">Assign anyway</button>'
        + '</div></div>';
      ov.addEventListener("click", e => {
        const b = e.target.closest("[data-c]");
        if (b) { document.body.removeChild(ov); resolve(b.dataset.c === "ok"); }
        else if (e.target === ov) { document.body.removeChild(ov); resolve(false); }
      });
      document.body.appendChild(ov);
    });
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

  // ── Allocation-time "whilst you're here" pop-up ────────────────────────────
  // After a job is newly allocated to an operative, offer other OPEN jobs at the
  // same site + within a straight-line radius, to send to the same person.
  let openEngineers = [];
  function nearbyRadiusPref() { const n = Number(localStorage.getItem("mlNearbyRadius")); return isFinite(n) && n > 0 ? n : 5; }
  function njStyle() {
    if ($("mlnj-style")) return;
    const s = document.createElement("style"); s.id = "mlnj-style";
    s.textContent = `
      .mlnj-overlay{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:14px;}
      .mlnj-card{background:#fff;border-radius:14px;max-width:520px;width:100%;max-height:88vh;overflow:auto;padding:16px 18px;font-family:"Segoe UI",system-ui,sans-serif;}
      .mlnj-head{display:flex;justify-content:space-between;align-items:center;font-size:17px;}
      .mlnj-x{border:0;background:#f1f5f9;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:15px;}
      .mlnj-sub{font-size:13px;color:#475569;margin:6px 0 10px;}
      .mlnj-sec{font-size:12px;font-weight:700;color:#334155;margin:12px 0 6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      .mlnj-sec input{width:56px;padding:3px 6px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;}
      .mlnj-nocoord{font-weight:400;color:#94a3b8;}
      .mlnj-row{display:flex;align-items:center;gap:9px;border:1px solid #e2e8f0;border-radius:9px;padding:7px 10px;margin-bottom:6px;cursor:pointer;}
      .mlnj-row:hover{background:#f8fafc;}
      .mlnj-row input{width:auto;flex:0 0 auto;}
      .mlnj-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
      .mlnj-main b{font-size:13px;}
      .mlnj-meta{font-size:11.5px;color:#64748b;}
      .mlnj-own{color:#b45309;font-weight:700;margin-left:4px;}
      .mlnj-new{color:#2563eb;font-weight:700;margin-left:4px;}
      .mlnj-mi{flex:0 0 auto;font-size:12px;font-weight:800;color:#16a34a;}
      .mlnj-empty{font-size:12.5px;color:#94a3b8;padding:4px 2px;}
      .mlnj-foot{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
      .mlnj-btn{border:1px solid #cbd5e1;background:#fff;border-radius:999px;padding:8px 14px;font-size:13px;cursor:pointer;}
      .mlnj-btn.primary{background:#16a34a;color:#fff;border:0;}
      .mlnj-msg{font-size:12.5px;color:#475569;margin-top:8px;}`;
    document.head.appendChild(s);
  }
  async function maybeShowNearby(job, engineer, cb) {
    let d = null;
    try {
      const res = await authFetch(`/sla/jobs/nearby?jobId=${encodeURIComponent(job.id)}&engineer=${encodeURIComponent(engineer)}&radius=${nearbyRadiusPref()}`);
      d = await res.json();
    } catch { }
    if (d && d.ok && ((d.sameSite && d.sameSite.length) || (d.nearby && d.nearby.length))) showNearby(job, engineer, d, cb);
  }
  function njRow(item, withMiles) {
    const owner = (item.assignedEngineers && item.assignedEngineers.length)
      ? `<span class="mlnj-own">currently ${esc(item.assignedEngineers.join(", "))}</span>`
      : `<span class="mlnj-new">unassigned</span>`;
    return `<label class="mlnj-row"><input type="checkbox" class="mlnj-cb" data-id="${esc(item.id)}">
      <span class="mlnj-main"><b>${esc(item.ref || item.site || "Job")}</b>
        <span class="mlnj-meta">${esc(item.site || "")}${item.priority ? " · " + esc(item.priority) : ""} · ${esc(item.status || "")} ${owner}</span></span>
      <span class="mlnj-mi">${withMiles ? item.miles + " mi" : "same site"}</span></label>`;
  }
  function showNearby(job, engineer, data, cb) {
    njStyle();
    let assignedAny = false;
    let ov = $("mlnjOverlay");
    if (!ov) { ov = document.createElement("div"); ov.id = "mlnjOverlay"; ov.className = "mlnj-overlay"; document.body.appendChild(ov); }
    const render = (d) => {
      const site = esc(d.targetSite || job.siteName || job.site || job.siteCode || "this site");
      ov.innerHTML = `<div class="mlnj-card">
        <div class="mlnj-head"><b>🧭 Whilst you're here</b><button type="button" class="mlnj-x" id="mlnjClose">✕</button></div>
        <div class="mlnj-sub"><b>${esc(engineer)}</b> is going to <b>${site}</b>. Also send them any of these?</div>
        ${d.sameSite && d.sameSite.length ? `<div class="mlnj-sec">🏢 Same site (${d.sameSite.length})</div>${d.sameSite.map(x => njRow(x, false)).join("")}` : ""}
        <div class="mlnj-sec">📍 Within <input type="number" id="mlnjRad" min="1" max="50" step="1" value="${d.radius}"> miles${d.nearby && d.nearby.length ? " (" + d.nearby.length + ")" : ""}${d.hasCoords ? "" : ' <span class="mlnj-nocoord">— no map location on this job</span>'}</div>
        ${d.nearby && d.nearby.length ? d.nearby.map(x => njRow(x, true)).join("") : (d.hasCoords ? `<div class="mlnj-empty">Nothing else open within ${d.radius} miles.</div>` : "")}
        <div class="mlnj-foot"><button type="button" class="mlnj-btn primary" id="mlnjAssign">Assign ticked to ${esc(engineer)}</button><button type="button" class="mlnj-btn" id="mlnjSkip">Skip</button></div>
        <div class="mlnj-msg" id="mlnjMsg"></div>
      </div>`;
      const done = () => {
        ov.remove();
        // On the scheduler, sequence the newly-added stops: open the optimiser
        // preview for this engineer's day (office reviews, then Applies). On the
        // board there's no optimiser here — the jobs are simply added to the day.
        if (assignedAny && window.mlOptimiseEngineerDay) {
          const dt = job.scheduledAt ? new Date(job.scheduledAt) : new Date();
          try { window.mlOptimiseEngineerDay(engineer, engineer, dt); } catch (e) { }
        }
      };
      $("mlnjClose").onclick = done; $("mlnjSkip").onclick = done;
      $("mlnjRad").onchange = async (e) => {
        const n = Math.max(1, Math.min(50, Number(e.target.value) || 5));
        localStorage.setItem("mlNearbyRadius", String(n));
        authFetch("/sla/jobs/nearby-radius", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ radius: n }) }).catch(() => { });
        try { const res = await authFetch(`/sla/jobs/nearby?jobId=${encodeURIComponent(job.id)}&engineer=${encodeURIComponent(engineer)}&radius=${n}`); const nd = await res.json(); if (nd && nd.ok) render(nd); } catch { }
      };
      $("mlnjAssign").onclick = async () => {
        const ids = [...ov.querySelectorAll(".mlnj-cb:checked")].map(c => c.getAttribute("data-id"));
        if (!ids.length) { done(); return; }
        $("mlnjAssign").disabled = true; $("mlnjMsg").textContent = "Assigning…";
        const pool = [...(d.sameSite || []), ...(d.nearby || [])];
        let ok = 0;
        for (const id of ids) {
          const patch = { assignedEngineers: [engineer], assignedTo: engineer, changedBy: currentUser() };
          const item = pool.find(x => x.id === id);
          if (item && !item.scheduledAt && job.scheduledAt) {
            const t = new Date(job.scheduledAt);
            patch.scheduledAt = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 8, 0, 0, 0).toISOString();
          }
          try {
            const res = await authFetch("/sla/jobs/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
            if (res.ok) { ok++; const sv = await res.json().catch(() => null); if (sv && cb) { try { cb(sv); } catch { } } }
          } catch { }
        }
        if (ok) assignedAny = true;   // closing will open the optimiser to sequence them
        // Drop the ones just assigned, but KEEP the pop-up open so any remaining
        // same-site / nearby job is still flagged (a second one isn't lost).
        d.sameSite = (d.sameSite || []).filter(x => ids.indexOf(x.id) === -1);
        d.nearby = (d.nearby || []).filter(x => ids.indexOf(x.id) === -1);
        if (d.sameSite.length || d.nearby.length) {
          render(d);
          $("mlnjMsg").textContent = `✅ Assigned ${ok} to ${esc(engineer)}. Anything else?`;
        } else {
          $("mlnjMsg").textContent = `✅ Assigned ${ok} to ${esc(engineer)}.`;
          setTimeout(done, 900);
        }
      };
    };
    render(data);
  }

  // Exposed so the scheduler's drag-drop (tray→lane, engineer→engineer) can raise
  // the same pop-up, not just the editor save.
  window.MLJobEdit = { open, wheelify, suggestNearby: maybeShowNearby };
})();
