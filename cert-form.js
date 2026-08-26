/* Shared EM / PAT certificate component.
   Mounted on engineer-job.html (engineer fills it, signs, completes — it looks
   final to them, but it's saved as a DRAFT for office review) and on
   cert-review.html (office edits every field, previews, finalises).

     MLCert.mount(containerEl, {
       jobId, type: "em" | "pat",
       mode: "engineer" | "office",
       certId,                    // office: load a specific cert (else by job)
       api, token,
       patchComplete,             // engineer: async () => PATCH the job to Complete
       onComplete,                // engineer: after submit+complete
       onChange,                  // office: called on save (id)
     });

   Endpoints under /certs/*: for-job, one, save, submit, pdf.                    */
(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

  const COLS = {
    em: [
      { key: "comments", label: "Location / description", role: "title" },
      { key: "normal", label: "Normal", role: "toggle", toggle: ["Pass", "Fail", "N/A"] },
      { key: "led", label: "LED", role: "toggle", toggle: ["Pass", "Fail", "N/A"] },
      { key: "emergency", label: "Emergency", role: "toggle", toggle: ["Pass", "Fail", "N/A"] },
      { key: "battery", label: "Battery (min)", role: "input", num: true, def: 180 },
    ],
    pat: [
      { key: "appliance", label: "Appliance", role: "title" },
      { key: "location", label: "Location", role: "subtitle" },
      { key: "cls", label: "Class", role: "toggle", toggle: ["I", "II", "—"] },
      { key: "visual", label: "Visual", role: "toggle", toggle: ["Pass", "Fail"] },
      { key: "earth", label: "Earth (Ω)", role: "input" },
      { key: "insulation", label: "Insulation (MΩ)", role: "input" },
      { key: "result", label: "Result", role: "toggle", toggle: ["Pass", "Fail"] },
      { key: "comments", label: "Comments", role: "input" },
    ],
  };

  const CSS = `
  .mlc{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f2438;}
  .mlc .cc{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin:10px 0;}
  .mlc h4{margin:0 0 8px;font-size:14px;color:#003468;letter-spacing:.01em;}
  .mlc label{display:block;font-size:11.5px;font-weight:600;color:#4a5568;margin:7px 0 3px;}
  .mlc input[type=text],.mlc input[type=number],.mlc textarea{width:100%;padding:8px;border:1px solid #ccd5dd;border-radius:8px;font-size:15px;font-family:inherit;box-sizing:border-box;background:#fff;}
  .mlc textarea{min-height:44px;}
  .mlc .row2{display:flex;gap:8px;flex-wrap:wrap;}.mlc .row2>div{flex:1 1 150px;}
  .mlc .btn{background:#003468;color:#fff;border:none;border-radius:9px;padding:10px 14px;font:600 14px inherit;cursor:pointer;}
  .mlc .btn.ghost{background:#fff;color:#003468;border:1px solid #cdd8e3;}
  .mlc .btn.green{background:#0a7d33;}.mlc .btn.grey{background:#5b6b7b;}.mlc .btn.red{background:#b00020;}
  .mlc .btn.sm{padding:7px 11px;font-size:13px;}
  .mlc .mlrows{display:flex;flex-direction:column;gap:8px;}
  .mlc .mlrow{border:1px solid #e6ebf1;border-radius:11px;padding:9px 10px;background:#fff;}
  .mlc .mlrow-top{display:flex;align-items:flex-start;gap:8px;}
  .mlc .mlrow-n{font-weight:700;color:#8b97a6;font-size:12px;min-width:22px;text-align:center;padding-top:9px;}
  .mlc .mlrow-title{flex:1;display:flex;flex-direction:column;gap:5px;min-width:0;}
  .mlc .ti-big{font-size:15px;font-weight:600;padding:8px 9px;}
  .mlc .ti-sub{font-size:13px;padding:6px 9px;color:#475569;}
  .mlc .mlrow-fields{display:flex;flex-wrap:wrap;gap:12px;margin-top:9px;align-items:flex-end;}
  .mlc .mlf{display:flex;flex-direction:column;gap:4px;}
  .mlc .mlf label{margin:0;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#7a8595;font-weight:700;}
  .mlc .mlf input{width:84px;padding:8px;font-size:15px;}
  .mlc .tg{display:inline-flex;border:1px solid #cdd8e3;border-radius:9px;overflow:hidden;}
  .mlc .tg button{border:none;background:#fff;padding:9px 13px;font:600 14px inherit;cursor:pointer;color:#475569;min-width:46px;}
  .mlc .tg button:not(:first-child){border-left:1px solid #e2e8f0;}
  .mlc .tg button.on{color:#fff;}
  .mlc .tg button.on.pass{background:#0a7d33;}.mlc .tg button.on.fail{background:#b00020;}.mlc .tg button.on.na{background:#94a3b8;}
  .mlc .tg button.on.one{background:#003468;}
  .mlc .del{background:#fff;border:1px solid #e2c4c4;color:#b00020;border-radius:7px;width:26px;height:26px;cursor:pointer;font-size:14px;line-height:1;}
  .mlc .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;}
  .mlc .sigpad{border:1px dashed #94a3b8;border-radius:8px;background:#fff;touch-action:none;width:100%;max-width:360px;height:130px;display:block;}
  .mlc .muted{color:#6b7a90;font-size:12.5px;}
  .mlc .save{font-size:12.5px;color:#0a7d33;font-weight:600;}.mlc .save.err{color:#b00020;}
  .mlc .pill{display:inline-block;background:#eef4fb;color:#003468;border-radius:999px;padding:3px 10px;font:600 12px inherit;}
  .mlc .banner{background:#fff7e6;border:1px solid #f2d98a;border-radius:8px;padding:8px 10px;font-size:13px;color:#7a5b00;margin:6px 0;}`;

  function shrinkSig(canvas) {
    // flatten onto white so it embeds as a baseline JPEG (PDF embeds JPEG)
    const w = canvas.width, h = canvas.height;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(canvas, 0, 0);
    return c.toDataURL("image/jpeg", 0.85);
  }

  async function mount(container, opts) {
    const { jobId, mode, api, token } = opts;
    const type = opts.type === "pat" ? "pat" : "em";
    const cols = COLS[type];
    const authFetch = (p, o = {}) => { o.headers = Object.assign({ Authorization: "Bearer " + token }, o.headers || {}); return fetch((p.startsWith("http") ? p : api + p), o); };
    if (!document.getElementById("mlc-css")) { const st = document.createElement("style"); st.id = "mlc-css"; st.textContent = CSS; document.head.appendChild(st); }
    container.classList.add("mlc");
    container.innerHTML = '<p class="muted" style="padding:8px">Loading certificate…</p>';

    let rec = null, saveTimer = null, sigDirty = false;
    try {
      const url = opts.certId ? "/certs/one?id=" + encodeURIComponent(opts.certId)
        : "/certs/for-job?jobId=" + encodeURIComponent(jobId) + "&type=" + type;
      const d = await authFetch(url).then(r => r.json());
      if (!d || !d.ok) throw new Error(d && d.error || "load failed");
      rec = d.record || {};
      rec._prefilledRows = d.prefilledRows || 0;
      rec._seeded = !!d.seeded;
    } catch (e) { container.innerHTML = '<p class="muted" style="padding:8px">Couldn\'t load the certificate.</p>'; return; }

    rec.type = type;
    rec.client = rec.client || {}; rec.installation = rec.installation || {}; rec.contractor = rec.contractor || {};
    rec.rows = Array.isArray(rec.rows) ? rec.rows : [];
    if (!rec.contractor.date) rec.contractor.date = new Date().toISOString().slice(0, 10);

    const editable = mode === "engineer" ? (rec.status !== "final") : true;

    function render() {
      const titleType = type === "pat" ? "Portable Appliance Test" : "Emergency Lighting Test";
      let h = "";
      h += '<div class="cc"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">'
        + '<h4 style="margin:0">' + esc(titleType) + ' certificate</h4>'
        + '<span class="pill">' + esc(rec.certNumber || "No. assigned on issue") + (rec.status === "review" ? " · in review" : rec.status === "final" ? " · issued" : " · draft") + '</span></div>';
      if (rec._prefilledRows) h += '<div class="banner">↩ ' + rec._prefilledRows + ' item' + (rec._prefilledRows === 1 ? "" : "s") + ' carried forward from the last certificate — marked Pass, tap any to change.</div>';
      else if (rec._seeded && mode === "engineer") h += '<div class="banner">No previous certificate found for this site — nothing was carried forward. Add each ' + (type === "pat" ? "appliance" : "light") + ' below.</div>';
      h += '</div>';

      // Client + installation
      h += '<div class="cc"><h4>Client &amp; installation</h4><div class="row2">';
      h += block("Client", "client");
      h += block("Installation address", "installation");
      h += '</div></div>';

      // Extent + comments
      h += '<div class="cc"><h4>Details</h4>'
        + '<label>Extent &amp; limitations</label><textarea data-f="extent" ' + ro() + '>' + esc(rec.extent || "") + '</textarea>'
        + '<label>Additional comments</label><textarea data-f="comments" ' + ro() + ' style="min-height:70px">' + esc(rec.comments || "") + '</textarea></div>';

      // Results — mobile-first cards (location prominent, tappable result toggles)
      h += '<div class="cc"><h4>' + (type === "pat" ? "Appliances tested" : "Emergency lighting tests") + ' <span class="muted">(' + rec.rows.length + ')</span></h4>';
      h += '<div class="mlrows" id="mlcRows"></div>';
      if (editable) h += '<div class="toolbar"><button class="btn ghost sm" data-act="add">＋ Add ' + (type === "pat" ? "appliance" : "light") + '</button><button class="btn ghost sm" data-act="add5">＋ Add 5</button>'
        + '<button class="btn ghost sm" data-act="allpass">✔ Mark all Pass</button>'
        + '<button class="btn ghost sm" data-act="pull">↻ Pull last certificate</button></div>';
      h += '</div>';

      // Contractor
      h += '<div class="cc"><h4>Contractor &amp; engineer</h4><div class="row2">'
        + '<div><label>Trading title</label><input type="text" data-c="tradingTitle" value="' + esc(rec.contractor.tradingTitle || "") + '" ' + ro() + '></div>'
        + '<div><label>Engineer name</label><input type="text" data-c="name" value="' + esc(rec.contractor.name || "") + '" ' + ro() + '></div>'
        + '<div><label>Position</label><input type="text" data-c="position" value="' + esc(rec.contractor.position || "Engineer") + '" ' + ro() + '></div>'
        + '<div><label>Date</label><input type="text" data-c="date" value="' + esc(rec.contractor.date || "") + '" placeholder="dd/mm/yyyy or yyyy-mm-dd" ' + ro() + '></div>'
        + '</div></div>';

      // Signature (engineer captures; office sees status)
      h += '<div class="cc"><h4>Signature</h4>';
      if (mode === "engineer" && editable) {
        h += '<canvas class="sigpad" id="mlcSig"></canvas><div class="toolbar"><button class="btn ghost sm" data-act="sigclear">Clear</button>'
          + '<span class="muted" id="mlcSigState">' + (rec.signature ? "Signed ✓" : "Sign above") + '</span></div>';
      } else {
        h += '<div class="muted">' + (rec.signature ? "Signed by the engineer ✓" : "Not signed") + '</div>';
        if (rec.signature) h += '<img src="' + esc(rec.signature) + '" alt="signature" style="max-width:220px;border:1px solid #e2e8f0;border-radius:8px;margin-top:6px;background:#fff">';
      }
      h += '</div>';

      // Actions
      h += '<div class="cc"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">';
      if (mode === "engineer" && editable && !opts.hideComplete) h += '<button class="btn green" id="mlcComplete">✅ Complete &amp; submit</button>';
      h += '<button class="btn ghost sm" id="mlcPdf">⬇ Preview PDF</button>';
      h += '<span class="save" id="mlcSave"></span></div>';
      if (mode === "engineer" && !opts.hideComplete) h += '<div class="muted" style="margin-top:6px">Completing sends this to the office to check and issue.</div>';
      h += '</div>';

      container.innerHTML = h;
      renderRows();
      wire();
      if (mode === "engineer" && editable) initSig();
    }

    function ro() { return editable ? "" : "readonly"; }
    function block(title, k) {
      const o = rec[k] || {};
      return '<div><label>' + esc(title) + '</label>'
        + '<input type="text" data-b="' + k + '.name" value="' + esc(o.name || "") + '" placeholder="Name" ' + ro() + ' style="margin-bottom:5px">'
        + '<input type="text" data-b="' + k + '.address" value="' + esc(o.address || "") + '" placeholder="Address" ' + ro() + ' style="margin-bottom:5px">'
        + '<input type="text" data-b="' + k + '.postcode" value="' + esc(o.postcode || "") + '" placeholder="Postcode" ' + ro() + '></div>';
    }

    const titleCols = cols.filter(c => c.role === "title" || c.role === "subtitle");
    const fieldCols = cols.filter(c => c.role === "toggle" || c.role === "input");
    function renderRows() {
      const tb = container.querySelector("#mlcRows"); if (!tb) return;
      let h = "";
      rec.rows.forEach((r, i) => {
        h += '<div class="mlrow" data-i="' + i + '"><div class="mlrow-top"><span class="mlrow-n">' + String(i + 1).padStart(2, "0") + '</span><div class="mlrow-title">';
        titleCols.forEach(c => { h += titleInput(c, r[c.key], i); });
        h += '</div>' + (editable ? '<button class="del" data-del="' + i + '">✕</button>' : '') + '</div>';
        h += '<div class="mlrow-fields">';
        fieldCols.forEach(c => { h += '<div class="mlf"><label>' + esc(c.label) + '</label>' + cellHtml(c, r[c.key], i) + '</div>'; });
        h += '</div></div>';
      });
      tb.innerHTML = h;
    }
    function titleInput(c, v, i) {
      const big = c.role === "title";
      if (!editable) return '<div class="' + (big ? "ti-big" : "ti-sub") + '" style="border:none;padding:2px 0">' + esc(v || (big ? "—" : "")) + '</div>';
      return '<input type="text" class="' + (big ? "ti-big" : "ti-sub") + '" data-cell="' + c.key + '" data-i="' + i + '" value="' + esc(v == null ? "" : v) + '" placeholder="' + esc(c.label) + '">';
    }
    function cellHtml(c, v, i) {
      if (!editable) {
        if (c.toggle) return '<div style="padding-top:3px">' + esc(v || "—") + '</div>';
        return '<div style="padding-top:3px">' + esc(v == null || v === "" ? "—" : v) + '</div>';
      }
      if (c.toggle) {
        return '<div class="tg" data-tg="' + c.key + '" data-i="' + i + '">' + c.toggle.map(opt => {
          const on = String(v || "") === opt;
          const cls = /^pass$/i.test(opt) ? "pass" : /^fail$/i.test(opt) ? "fail" : (c.toggle.length === 2 || opt === "I" || opt === "II") ? "one" : "na";
          return '<button type="button" class="' + (on ? "on " + cls : "") + '" data-v="' + esc(opt) + '">' + esc(opt) + '</button>';
        }).join("") + '</div>';
      }
      if (c.num) return '<input type="number" inputmode="numeric" data-cell="' + c.key + '" data-i="' + i + '" value="' + esc(v == null ? (c.def != null ? c.def : "") : v) + '">';
      return '<input type="text" data-cell="' + c.key + '" data-i="' + i + '" value="' + esc(v == null ? "" : v) + '">';
    }

    let sigCtx = null, sigCanvas = null;
    function initSig() {
      sigCanvas = container.querySelector("#mlcSig"); if (!sigCanvas) return;
      const rectW = sigCanvas.clientWidth || 340; sigCanvas.width = rectW; sigCanvas.height = 130;
      sigCtx = sigCanvas.getContext("2d"); sigCtx.lineWidth = 2.2; sigCtx.lineCap = "round"; sigCtx.strokeStyle = "#12294a";
      if (rec.signature) { const im = new Image(); im.onload = () => sigCtx.drawImage(im, 0, 0, sigCanvas.width, sigCanvas.height); im.src = rec.signature; }
      let drawing = false, last = null;
      const pos = e => { const r = sigCanvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; };
      const down = e => { drawing = true; last = pos(e); e.preventDefault(); };
      const move = e => { if (!drawing) return; const p = pos(e); sigCtx.beginPath(); sigCtx.moveTo(last.x, last.y); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); last = p; sigDirty = true; e.preventDefault(); };
      const up = () => { if (drawing) { drawing = false; captureSig(); } };
      sigCanvas.addEventListener("mousedown", down); sigCanvas.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
      sigCanvas.addEventListener("touchstart", down, { passive: false }); sigCanvas.addEventListener("touchmove", move, { passive: false }); sigCanvas.addEventListener("touchend", up);
    }
    function captureSig() {
      if (!sigCanvas) return;
      rec.signature = shrinkSig(sigCanvas);
      const st = container.querySelector("#mlcSigState"); if (st) st.textContent = "Signed ✓";
      queueSave();
    }

    function setSave(t, err) { const el = container.querySelector("#mlcSave"); if (el) { el.textContent = t; el.className = "save" + (err ? " err" : ""); } }
    function queueSave() { clearTimeout(saveTimer); setSave("Saving…"); saveTimer = setTimeout(doSave, 900); }
    async function doSave() {
      try {
        const body = {
          id: rec.id || undefined, type, jobId: rec.jobId || jobId, siteCode: rec.siteCode || "",
          client: rec.client, installation: rec.installation, extent: rec.extent || "", comments: rec.comments || "",
          declaration: rec.declaration || "", contractor: rec.contractor, rows: rec.rows, signature: rec.signature || "",
        };
        const d = await authFetch("/certs/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
        if (d && d.ok) { rec.id = d.id; setSave("Saved ✓"); if (opts.onChange) opts.onChange(rec.id); }
        else setSave("Save failed", true);
      } catch (e) { setSave("Save failed", true); }
    }

    function wire() {
      container.querySelectorAll("input[data-f],textarea[data-f]").forEach(el => el.addEventListener("input", () => { rec[el.dataset.f] = el.value; queueSave(); }));
      container.querySelectorAll("[data-b]").forEach(el => el.addEventListener("input", () => { const [k, f] = el.dataset.b.split("."); (rec[k] = rec[k] || {})[f] = el.value; queueSave(); }));
      container.querySelectorAll("[data-c]").forEach(el => el.addEventListener("input", () => { rec.contractor[el.dataset.c] = el.value; queueSave(); }));
      container.querySelectorAll("[data-cell]").forEach(el => el.addEventListener("input", () => { const i = +el.dataset.i; rec.rows[i] = rec.rows[i] || {}; rec.rows[i][el.dataset.cell] = el.value; queueSave(); }));
      container.querySelectorAll("[data-tg] button").forEach(btn => btn.addEventListener("click", () => {
        const tg = btn.closest("[data-tg]"); const i = +tg.dataset.i; const key = tg.dataset.tg;
        rec.rows[i] = rec.rows[i] || {}; rec.rows[i][key] = btn.dataset.v;
        tg.querySelectorAll("button").forEach(b => b.className = "");
        const opt = btn.dataset.v; const cls = /^pass$/i.test(opt) ? "pass" : /^fail$/i.test(opt) ? "fail" : (opt === "I" || opt === "II" || tg.querySelectorAll("button").length === 2) ? "one" : "na";
        btn.className = "on " + cls;
        queueSave();
      }));
      container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => { rec.rows.splice(+b.dataset.del, 1); renderRows(); wire(); queueSave(); }));
      const tb = container.querySelector('[data-act="add"]'); if (tb) tb.addEventListener("click", () => { addRows(1); });
      const t5 = container.querySelector('[data-act="add5"]'); if (t5) t5.addEventListener("click", () => { addRows(5); });
      const ap = container.querySelector('[data-act="allpass"]'); if (ap) ap.addEventListener("click", allPass);
      const pl = container.querySelector('[data-act="pull"]'); if (pl) pl.addEventListener("click", pullPrevious);
      const sc = container.querySelector('[data-act="sigclear"]'); if (sc) sc.addEventListener("click", () => { if (sigCtx) sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); rec.signature = ""; const st = container.querySelector("#mlcSigState"); if (st) st.textContent = "Sign above"; queueSave(); });
      const pdf = container.querySelector("#mlcPdf"); if (pdf) pdf.addEventListener("click", async () => {
        // Open the tab synchronously (keeps the user gesture), then stream the PDF
        // in WITH the bearer token — /certs/pdf is session-gated, so a plain
        // window.open (no header) returns "Not authenticated".
        const w = window.open("", "_blank");
        try {
          if (!rec.id) await doSave();
          if (!rec.id) { if (w) w.close(); return; }
          const r = await authFetch("/certs/pdf?id=" + encodeURIComponent(rec.id) + "&t=" + Date.now());
          if (!r.ok) throw new Error("pdf");
          const u = URL.createObjectURL(await r.blob());
          if (w) w.location.href = u; else window.location.href = u;
          setTimeout(() => URL.revokeObjectURL(u), 60000);
        } catch (e) { if (w) w.close(); alert("Couldn't open the PDF — please try again."); }
      });
      const cm = container.querySelector("#mlcComplete"); if (cm) cm.addEventListener("click", complete);
    }
    function addRows(n) {
      const def = type === "em" ? { normal: "Pass", led: "Pass", emergency: "Pass", battery: 180, comments: "" } : { appliance: "", location: "", cls: "I", visual: "Pass", earth: "", insulation: "", result: "Pass", comments: "" };
      for (let k = 0; k < n; k++) rec.rows.push({ ...def });
      renderRows(); wire(); queueSave();
    }
    function allPass() {
      rec.rows.forEach(r => { if (type === "em") { r.normal = "Pass"; r.led = "Pass"; r.emergency = "Pass"; if (!r.battery) r.battery = 180; } else { r.visual = "Pass"; r.result = "Pass"; } });
      renderRows(); wire(); queueSave();
    }
    // Re-pull the previous certificate's items (+ blank header fields) on demand —
    // for a draft made before the reader existed, or to refresh from the last cert.
    async function pullPrevious() {
      let d;
      try { d = await authFetch("/certs/prefill?type=" + type + "&code=" + encodeURIComponent(rec.siteCode || "") + "&jobId=" + encodeURIComponent(rec.jobId || jobId || "")).then(r => r.json()); }
      catch (e) { alert("Couldn't reach the previous certificate."); return; }
      if (!d || !d.ok) { alert("Couldn't reach the previous certificate."); return; }
      if (!d.rows || !d.rows.length) { alert("No previous certificate found for this site — nothing to pull. (It may be a scanned image with no readable text.)"); return; }
      if (rec.rows.length && !confirm("Replace the current list with " + d.rows.length + " item" + (d.rows.length === 1 ? "" : "s") + " from the last certificate?")) return;
      rec.rows = d.rows;
      const hh = d.header;   // fill BLANK header fields only — never overwrite typed edits
      if (hh) {
        if (hh.client && !(rec.client && rec.client.name)) rec.client = hh.client;
        if (hh.installation && !(rec.installation && rec.installation.name)) rec.installation = hh.installation;
        if (hh.extent && !rec.extent) rec.extent = hh.extent;
        if (hh.comments && !rec.comments) rec.comments = hh.comments;
      }
      rec._prefilledRows = d.rows.length;
      render(); queueSave();
    }

    // Validate + save + submit for office review (NO job patch). Returns true on
    // success. `silent` skips the alerts (used by the combined-job orchestrator).
    async function submit(silent) {
      if (!rec.rows.length) { if (!silent) alert("Add at least one test row before completing."); return false; }
      const incomplete = rec.rows.some(r => type === "em" ? (!r.normal || !r.led || !r.emergency) : (!r.result));
      if (incomplete && !silent && !confirm("Some rows have no result set. Complete anyway?")) return false;
      if (!rec.signature) { if (!silent) alert("Please sign the certificate before completing."); return false; }
      await doSave();
      if (!rec.id) return false;
      try { await authFetch("/certs/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rec.id }) }); rec.status = "review"; return true; }
      catch (e) { return false; }
    }
    async function complete() {
      const btn = container.querySelector("#mlcComplete"); if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
      const ok = await submit(false);
      if (!ok) { if (btn) { btn.disabled = false; btn.textContent = "✅ Complete & submit"; } return; }
      if (opts.patchComplete) { try { await opts.patchComplete(); } catch (e) {} }
      if (opts.onComplete) opts.onComplete();
    }

    render();
    return { save: doSave, submit, get: () => rec, ready: () => !!(rec.rows.length && rec.signature) };
  }

  window.MLCert = { mount };
})();
