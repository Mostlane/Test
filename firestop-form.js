/* Shared Firestopping (RIA form) component — mounted on engineer-job.html
   (engineer fills it) and job-view.html (office views + downloads).

     MLFirestop.mount(containerEl, {
       jobId, mode: "engineer" | "office",
       api,                       // window.MOSTLANE_API
       token,                     // bearer token
       onComplete,                // engineer: called after the job is completed
       patchComplete,             // engineer: async () => PATCH the job to Complete
     });

   Endpoints (all under /sla/firestop/*): record (GET/POST), materials (GET),
   photo (POST multipart), photo-delete, pdf (GET), bundle (GET).                */
(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  const rid = () => "s-" + Math.random().toString(36).slice(2, 8);

  function shrink(file, max = 1600) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > max || h > max) { if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        c.toBlob(b => resolve(b || file), "image/jpeg", 0.82);
      };
      img.onerror = () => resolve(file);
      img.src = URL.createObjectURL(file);
    });
  }

  const CSS = `
  .fsw{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}
  .fsw .fscard{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin:10px 0;}
  .fsw h3{margin:0 0 8px;font-size:15px;color:#003b82;}
  .fsw label{display:block;font-size:12px;font-weight:600;color:#475569;margin:8px 0 3px;}
  .fsw input[type=text],.fsw textarea{width:100%;padding:8px;border:1px solid #ccd5dd;border-radius:8px;font-size:15px;font-family:inherit;box-sizing:border-box;}
  .fsw textarea{min-height:48px;}
  .fsw .row2{display:flex;gap:8px;flex-wrap:wrap;} .fsw .row2>div{flex:1 1 140px;}
  .fsw .btn{background:#003b82;color:#fff;border:none;border-radius:8px;padding:9px 13px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;}
  .fsw .btn.grey{background:#5b6b7b;} .fsw .btn.green{background:#0a7d33;} .fsw .btn.ghost{background:#fff;color:#003b82;border:1px solid #003b82;} .fsw .btn.small{padding:6px 10px;font-size:13px;} .fsw .btn.red{background:#b00020;}
  .fsw .prodchips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;}
  .fsw .prodchips button{background:#f1f5f9;border:1px solid #dbe3ec;border-radius:999px;padding:6px 11px;font:600 13px inherit;cursor:pointer;}
  .fsw .prodchips button.on{background:#003b82;color:#fff;border-color:#003b82;}
  .fsw .thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;}
  .fsw .thumbs .th{position:relative;width:74px;height:74px;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;}
  .fsw .thumbs .th img{width:100%;height:100%;object-fit:cover;}
  .fsw .thumbs .th button{position:absolute;top:1px;right:1px;background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1;}
  .fsw .seal{border:1px solid #e2e8f0;border-left:4px solid #f97316;border-radius:10px;padding:11px;margin:8px 0;}
  .fsw .seal .sh{display:flex;justify-content:space-between;align-items:center;}
  .fsw .sigpad{border:1px dashed #94a3b8;border-radius:8px;background:#fff;touch-action:none;width:100%;max-width:340px;height:120px;display:block;}
  .fsw .muted{color:#6b7a90;font-size:12.5px;}
  .fsw .save{font-size:12.5px;color:#0a7d33;} .fsw .save.err{color:#b00020;}
  .fsw .dlrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}`;

  async function mount(container, opts) {
    const { jobId, mode, api, token } = opts;
    const authFetch = (path, o = {}) => { o.headers = Object.assign({ Authorization: "Bearer " + token }, o.headers || {}); return fetch((path.startsWith("http") ? path : api + path), o); };
    if (!document.getElementById("fsw-css")) { const st = document.createElement("style"); st.id = "fsw-css"; st.textContent = CSS; document.head.appendChild(st); }
    container.classList.add("fsw");
    container.innerHTML = '<p class="muted" style="padding:8px">Loading firestopping record…</p>';

    let record, defaults, materials = [], saveTimer = null, sig = null;
    try {
      const d = await authFetch("/sla/firestop/record?jobId=" + encodeURIComponent(jobId)).then(r => r.json());
      record = d.record && Object.keys(d.record).length ? d.record : {};
      defaults = d.defaults || {};
      materials = (await authFetch("/sla/firestop/materials").then(r => r.json())).materials || [];
    } catch (e) { container.innerHTML = '<p class="muted" style="padding:8px">Couldn\'t load the firestopping record.</p>'; return; }

    // Seed header from defaults on first open.
    record.ref = record.ref || defaults.nextRef || "";
    record.dateOfIssue = record.dateOfIssue || defaults.dateOfIssue || "";
    record.company = record.company || defaults.company || "";
    record.installer = record.installer || defaults.installer || "";
    record.siteAddress = record.siteAddress || defaults.siteAddress || "";
    record.sealCategory = record.sealCategory || defaults.sealCategory || "";
    record.declaration = record.declaration || defaults.declaration || "";
    record.seals = Array.isArray(record.seals) ? record.seals : [];

    const readonly = mode === "office";

    function scheduleSave() {
      const s = document.getElementById("fsSaveMsg"); if (s) { s.textContent = "Saving…"; s.className = "save"; }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 700);
    }
    async function doSave() {
      try {
        const r = await authFetch("/sla/firestop/record", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, record }) }).then(r => r.json());
        if (r.ok && r.record && r.record.ref && r.record.ref !== record.ref) { record.ref = r.record.ref; const rf = document.getElementById("fsRef"); if (rf) rf.textContent = record.ref; }
        const s = document.getElementById("fsSaveMsg"); if (s) { s.textContent = "Saved ✓"; s.className = "save"; }
      } catch (e) { const s = document.getElementById("fsSaveMsg"); if (s) { s.textContent = "Save failed — will retry"; s.className = "save err"; } }
    }

    function seal(id) { return record.seals.find(s => s.id === id); }
    function addSeal() { record.seals.push({ id: rid(), location: "", aperture: "", frp: "60 mins", manufacturer: "", componentName: "", comments: "", productIds: [], beforePhotos: [], afterPhotos: [] }); scheduleSave(); render(); }
    function removeSeal(id) { record.seals = record.seals.filter(s => s.id !== id); scheduleSave(); render(); }

    function toggleProduct(sid, pid) {
      const s = seal(sid); if (!s) return;
      s.productIds = s.productIds || [];
      const i = s.productIds.indexOf(pid);
      if (i >= 0) s.productIds.splice(i, 1); else s.productIds.push(pid);
      // Auto-fill manufacturer / component name from the selected products.
      const chosen = materials.filter(m => s.productIds.includes(m.id));
      if (chosen.length) {
        s.manufacturer = [...new Set(chosen.map(m => m.manufacturer).filter(Boolean))].join(", ");
        s.componentName = [...new Set(chosen.map(m => m.name).filter(Boolean))].join(", ");
      }
      scheduleSave(); render();
    }

    async function addPhoto(sid, stage) {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.capture = "environment";
      inp.onchange = async () => {
        if (!inp.files[0]) return;
        const blob = await shrink(inp.files[0]);
        const fd = new FormData(); fd.append("file", new File([blob], "photo.jpg", { type: "image/jpeg" })); fd.append("jobId", jobId); fd.append("sealId", sid); fd.append("stage", stage);
        const btn = document.getElementById("addbtn-" + sid + "-" + stage); if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }
        try {
          const r = await authFetch("/sla/firestop/photo", { method: "POST", body: fd }).then(r => r.json());
          if (r.ok) { const s = seal(sid); (stage === "before" ? s.beforePhotos : s.afterPhotos).push({ key: r.key, url: r.url }); scheduleSave(); render(); }
        } catch (e) {}
      };
      inp.click();
    }
    async function delPhoto(sid, stage, key) {
      try { await authFetch("/sla/firestop/photo-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }); } catch (e) {}
      const s = seal(sid); const arr = stage === "before" ? "beforePhotos" : "afterPhotos";
      s[arr] = (s[arr] || []).filter(p => (p.key || p) !== key);
      scheduleSave(); render();
    }

    // Normalise photo entries (older saves may store bare keys → no url).
    function photoList(arr) { return (arr || []).map(p => typeof p === "string" ? { key: p, url: "" } : p); }

    function render() {
      const mats = materials;
      container.innerHTML = `
        <div class="fscard">
          <h3>🔥 Record of Installation Activities — RIA <span id="fsRef">${esc(record.ref)}</span></h3>
          <div class="row2">
            <div><label>Date of issue</label><input type="text" id="h_date" value="${esc(record.dateOfIssue)}" ${readonly ? "readonly" : ""}></div>
            <div><label>Installed by</label><input type="text" id="h_inst" value="${esc(record.installer)}" ${readonly ? "readonly" : ""}></div>
          </div>
          <label>Site address</label><input type="text" id="h_site" value="${esc(record.siteAddress)}" ${readonly ? "readonly" : ""}>
          <label>Seal category</label><input type="text" id="h_cat" value="${esc(record.sealCategory)}" ${readonly ? "readonly" : ""}>
          <div class="save" id="fsSaveMsg"></div>
        </div>

        <div class="fscard">
          <h3>Seals installed</h3>
          <div id="fsSeals">${record.seals.map((s, i) => sealHtml(s, i, mats)).join("") || '<p class="muted">No seals yet.</p>'}</div>
          ${readonly ? "" : '<button class="btn ghost small" id="fsAddSeal">＋ Add a seal</button>'}
        </div>

        <div class="fscard">
          <h3>Declaration</h3>
          <p class="muted">${esc(record.declaration)}</p>
          <label>Signature</label>
          ${record.signatureKey && (readonly || record._sigLocked)
            ? '<div class="muted">✓ Signed</div>'
            : (readonly ? '<div class="muted">Not signed yet</div>' : '<canvas class="sigpad" id="fsSig" width="340" height="120"></canvas><div style="margin-top:6px"><button class="btn grey small" id="fsSigClear">Clear</button> <span class="muted" id="fsSigState">' + (record.signatureKey ? "✓ signed — draw again to replace" : "sign above") + '</span></div>')}
        </div>

        ${downloadRow()}
        ${mode === "engineer" ? '<div style="margin-top:10px"><button class="btn green" id="fsComplete" style="width:100%;padding:13px;font-size:16px">✅ Complete firestopping job</button><div class="save err" id="fsCompMsg" style="margin-top:6px"></div></div>' : ""}
      `;
      wire();
    }

    function sealHtml(s, i, mats) {
      const chips = mats.map(m => `<button type="button" data-prod="${esc(s.id)}|${esc(m.id)}" class="${(s.productIds || []).includes(m.id) ? "on" : ""}">${esc([m.manufacturer, m.name].filter(Boolean).join(" "))}</button>`).join("");
      const ph = (stage) => {
        const arr = photoList(stage === "before" ? s.beforePhotos : s.afterPhotos);
        return `<label>Pictures ${stage === "before" ? "before" : "after"}</label>
          <div class="thumbs">${arr.map(p => `<div class="th"><img src="${esc(p.url || "")}" alt="">${readonly ? "" : `<button data-delph="${esc(s.id)}|${stage}|${esc(p.key)}">✕</button>`}</div>`).join("")}
          ${readonly ? "" : `<button class="btn ghost small" id="addbtn-${esc(s.id)}-${stage}" data-addph="${esc(s.id)}|${stage}" style="height:74px">📷 Add</button>`}</div>`;
      };
      return `<div class="seal" data-seal="${esc(s.id)}">
        <div class="sh"><b>Seal ${i + 1}</b>${readonly ? "" : `<button class="btn red small" data-rmseal="${esc(s.id)}">Remove</button>`}</div>
        <div class="row2">
          <div><label>Location</label><input type="text" data-f="${esc(s.id)}|location" value="${esc(s.location)}" ${readonly ? "readonly" : ""}></div>
          <div><label>Aperture size</label><input type="text" data-f="${esc(s.id)}|aperture" value="${esc(s.aperture)}" ${readonly ? "readonly" : ""}></div>
          <div><label>Fire resistance period</label><input type="text" data-f="${esc(s.id)}|frp" value="${esc(s.frp)}" ${readonly ? "readonly" : ""}></div>
        </div>
        ${readonly ? "" : `<label>Products used</label><div class="prodchips">${chips || '<span class="muted">No products set up — add them in Firestopping Setup.</span>'}</div>`}
        <div class="row2">
          <div><label>Manufacturer</label><input type="text" data-f="${esc(s.id)}|manufacturer" value="${esc(s.manufacturer)}" ${readonly ? "readonly" : ""}></div>
          <div><label>Component name</label><input type="text" data-f="${esc(s.id)}|componentName" value="${esc(s.componentName)}" ${readonly ? "readonly" : ""}></div>
        </div>
        <label>Comments</label><textarea data-f="${esc(s.id)}|comments" ${readonly ? "readonly" : ""}>${esc(s.comments)}</textarea>
        ${ph("before")}
        ${ph("after")}
      </div>`;
    }

    function downloadRow() {
      return `<div class="dlrow">
        <button class="btn ghost small" id="fsPdf">⬇ PDF</button>
        <button class="btn small" id="fsBundle">⬇ Download bundle (PDF + specs)</button>
      </div>`;
    }

    async function download(path, filename) {
      try {
        const res = await authFetch(path);
        if (!res.ok) { alert("Couldn't build the file — save the record first."); return; }
        const blob = await res.blob();
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch (e) { alert("Download failed — check your connection."); }
    }

    function wire() {
      const el = container;
      if (!readonly) {
        const add = el.querySelector("#fsAddSeal"); if (add) add.onclick = addSeal;
        el.querySelectorAll("[data-rmseal]").forEach(b => b.onclick = () => removeSeal(b.dataset.rmseal));
        el.querySelectorAll("[data-prod]").forEach(b => b.onclick = () => { const [sid, pid] = b.dataset.prod.split("|"); toggleProduct(sid, pid); });
        el.querySelectorAll("[data-addph]").forEach(b => b.onclick = () => { const [sid, stage] = b.dataset.addph.split("|"); addPhoto(sid, stage); });
        el.querySelectorAll("[data-delph]").forEach(b => b.onclick = () => { const [sid, stage, key] = b.dataset.delph.split("|"); delPhoto(sid, stage, key); });
        el.querySelectorAll("[data-f]").forEach(inp => inp.addEventListener("input", () => { const [sid, f] = inp.dataset.f.split("|"); const s = seal(sid); if (s) { s[f] = inp.value; scheduleSave(); } }));
        // Header fields
        const hb = (id, key) => { const e = el.querySelector(id); if (e) e.addEventListener("input", () => { record[key] = e.value; scheduleSave(); }); };
        hb("#h_date", "dateOfIssue"); hb("#h_inst", "installer"); hb("#h_site", "siteAddress"); hb("#h_cat", "sealCategory");
        setupSig();
      }
      const pdf = el.querySelector("#fsPdf"); if (pdf) pdf.onclick = () => download("/sla/firestop/pdf?jobId=" + encodeURIComponent(jobId), "RIA form " + (record.ref || jobId) + ".pdf");
      const bun = el.querySelector("#fsBundle"); if (bun) bun.onclick = () => download("/sla/firestop/bundle?jobId=" + encodeURIComponent(jobId), "Firestopping " + (record.ref || jobId) + ".zip");
      const comp = el.querySelector("#fsComplete"); if (comp) comp.onclick = complete;
    }

    function setupSig() {
      const cv = container.querySelector("#fsSig"); if (!cv) return;
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.strokeStyle = "#111"; ctx.lineWidth = 2; ctx.lineJoin = ctx.lineCap = "round";
      let drawing = false, dirty = false, last = null;
      const pos = e => { const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * cv.width / r.width, y: (t.clientY - r.top) * cv.height / r.height }; };
      const start = e => { drawing = true; dirty = true; last = pos(e); e.preventDefault(); };
      const move = e => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; e.preventDefault(); };
      const end = () => { if (drawing && dirty) uploadSig(); drawing = false; };
      cv.addEventListener("mousedown", start); cv.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
      cv.addEventListener("touchstart", start, { passive: false }); cv.addEventListener("touchmove", move, { passive: false }); cv.addEventListener("touchend", end);
      const clr = container.querySelector("#fsSigClear"); if (clr) clr.onclick = () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); dirty = false; };
      async function uploadSig() {
        cv.toBlob(async (blob) => {
          if (!blob) return;
          const fd = new FormData(); fd.append("file", new File([blob], "sig.jpg", { type: "image/jpeg" })); fd.append("jobId", jobId); fd.append("sealId", "_sig"); fd.append("stage", "signature");
          try { const r = await authFetch("/sla/firestop/photo", { method: "POST", body: fd }).then(r => r.json()); if (r.ok) { record.signatureKey = r.key; scheduleSave(); const st = container.querySelector("#fsSigState"); if (st) st.textContent = "✓ signed"; } } catch (e) {}
        }, "image/jpeg", 0.9);
      }
    }

    async function complete() {
      const msg = container.querySelector("#fsCompMsg"); msg.textContent = "";
      const miss = [];
      if (!record.seals.length) miss.push("add at least one seal");
      else if (!record.seals.some(s => photoList(s.beforePhotos).length && photoList(s.afterPhotos).length)) miss.push("add before and after photos to a seal");
      if (!record.signatureKey) miss.push("sign the declaration");
      if (miss.length) { msg.textContent = "Please " + miss.join(", ") + "."; return; }
      const comp = container.querySelector("#fsComplete"); comp.disabled = true; comp.textContent = "Completing…";
      try {
        await doSave();
        if (opts.patchComplete) { await opts.patchComplete(); }
        comp.textContent = "✓ Completed";
        if (opts.onComplete) opts.onComplete();
      } catch (e) { msg.textContent = "Couldn't complete — " + (e.message || e); comp.disabled = false; comp.textContent = "✅ Complete firestopping job"; }
    }

    render();
  }

  window.MLFirestop = { mount };
})();
