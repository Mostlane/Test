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
  .mlc input[type=text],.mlc input[type=number],.mlc textarea{width:100%;padding:8px;border:1px solid #ccd5dd;border-radius:8px;font-size:15px;font-family:inherit;box-sizing:border-box;background:#fff !important;color:#0f2438 !important;-webkit-text-fill-color:#0f2438;}
  .mlc .err{outline:2px solid #b00020;border-color:#b00020 !important;}
  .mlc .mlrow.err-row{border-left:4px solid #b00020;background:#fff5f5;}
  .mlc textarea{min-height:44px;}
  .mlc .row2{display:flex;gap:8px;flex-wrap:wrap;}.mlc .row2>div{flex:1 1 150px;}
  .mlc .btn{background:#003468;color:#fff;border:none;border-radius:9px;padding:10px 14px;font:600 14px inherit;cursor:pointer;}
  .mlc .btn.ghost{background:#fff;color:#003468;border:1px solid #cdd8e3;}
  .mlc .btn.green{background:#0a7d33;}.mlc .btn.grey{background:#5b6b7b;}.mlc .btn.red{background:#b00020;}
  .mlc .btn.sm{padding:7px 11px;font-size:13px;}
  .mlc .mlrows{display:flex;flex-direction:column;gap:8px;}
  /* Desktop (office/admin): pack the appliance/light cards into a compact grid so
     a long list uses the screen width instead of scrolling one column. Phones keep
     the single column. */
  @media (min-width:820px){ .mlc .mlrows{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;align-items:start;} }
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
  .mlc .banner{background:#fff7e6;border:1px solid #f2d98a;border-radius:8px;padding:8px 10px;font-size:13px;color:#7a5b00;margin:6px 0;}
  .mlc .mlrem{margin-top:9px;}
  .mlc .mlrem.open{border-top:1px dashed #edd3a3;padding-top:9px;}
  .mlc .mlrem-flag{background:#fff;border:1px solid #e2c4c4;color:#b45309;border-radius:8px;padding:7px 12px;font:700 13px inherit;cursor:pointer;}
  .mlc .mlrem-flag.on{background:#fff4e6;border-color:#f0b775;color:#b45309;}
  .mlc .mlrem-body{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:9px;}
  .mlc .mlrem-q{font:700 12px inherit;color:#7a8595;text-transform:uppercase;letter-spacing:.03em;}
  .mlc .mlrem-note{flex:1;min-width:150px;padding:8px;font-size:14px;}
  .mlc .mlrem-hint{flex-basis:100%;font-size:12px;color:#8a5a0a;}
  .mlc .mlrem.ro{margin-top:8px;}
  .mlc .mlrem-tag{display:inline-block;background:#fff4e6;border:1px solid #f0c98a;color:#8a4b0a;border-radius:999px;padding:3px 10px;font:700 12px inherit;}
  .mlc .mlrem-batt{flex-basis:100%;display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:2px;}
  .mlc .mlrem-bspec{flex:1;min-width:180px;padding:8px;font-size:14px;}
  .mlc .mlrem-bqty{width:74px;padding:8px;font-size:14px;}
  .mlc .mlrem-addphoto{background:#eef4fb;border:1px solid #c7dbf3;color:#003468;border-radius:8px;padding:8px 12px;font:700 13px inherit;cursor:pointer;}
  .mlc .mlrem-photos{display:flex;flex-wrap:wrap;gap:6px;flex-basis:100%;}
  .mlc .mlrem-thw{position:relative;display:inline-block;}
  .mlc .mlrem-th{width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #d7dee6;background:#eef2f6;}
  .mlc .mlrem-thx{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:#b00020;color:#fff;border:none;font-size:11px;line-height:1;cursor:pointer;}
  .mlc .mlc-listhead{background:#fff;padding:9px 4px;margin:-4px -4px 8px;border-bottom:2px solid #eef2f6;display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;color:#003468;}
  .mlc .mlc-listhead .cnt{margin-left:auto;font-size:13px;}
  .mlc .mlc-listhead .cnt .ok{color:#0a7d33;font-weight:700;}
  .mlc .mlc-listhead .cnt .bad{color:#b00020;font-weight:700;cursor:pointer;text-decoration:underline;}
  .mlc .mlrow.fail{border-color:#e6a1a1;border-left:4px solid #b00020;background:#fdf3f3;}
  .mlc details.mlc-fold{background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin:10px 0;}
  .mlc details.mlc-fold>summary{list-style:none;cursor:pointer;padding:12px;font-weight:700;font-size:14px;color:#003468;display:flex;align-items:center;gap:8px;}
  .mlc details.mlc-fold>summary::-webkit-details-marker{display:none;}
  .mlc details.mlc-fold>summary::after{content:"▾";margin-left:auto;color:#94a3b8;font-weight:400;}
  .mlc details.mlc-fold[open]>summary::after{content:"▴";}
  .mlc details.mlc-fold .cc-body{padding:0 12px 12px;}
  .mlc .setall{border:1px solid #cdd8e3;border-radius:10px;padding:10px;margin-top:8px;background:#f8fafc;}
  .mlc .setall .sr{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 0;border-top:1px solid #eef2f6;}
  .mlc .setall .sr:first-of-type{border-top:none;}
  .mlc .setall .sr .lb{min-width:82px;font-weight:700;font-size:12px;color:#475569;}
  .mlc .setall select,.mlc .setall input{padding:6px;border:1px solid #ccd5dd;border-radius:8px;font-size:14px;font-family:inherit;}`;

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

    // "view" = a live READ-ONLY reflection (job-view / office job card). Engineer
    // can edit a non-final cert; office (review) can always edit.
    const editable = mode === "view" ? false : (mode === "engineer" ? (rec.status !== "final") : true);

    function render() {
      const titleType = type === "pat" ? "Portable Appliance Test" : "Emergency Lighting Test";
      let h = "";
      h += '<div class="cc"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">'
        + '<h4 style="margin:0">' + esc(titleType) + ' certificate</h4>'
        + '<span class="pill">' + esc(rec.certNumber || "No. assigned on issue") + (rec.status === "review" ? " · in review" : rec.status === "final" ? " · issued" : " · draft") + '</span></div>';
      if (rec._prefilledRows) h += '<div class="banner">↩ ' + rec._prefilledRows + ' item' + (rec._prefilledRows === 1 ? "" : "s") + ' carried forward from the last certificate — marked Pass, tap any to change.</div>';
      else if (rec._seeded && mode === "engineer") h += '<div class="banner">No previous certificate found for this site — nothing was carried forward. Add each ' + (type === "pat" ? "appliance" : "light") + ' below.</div>';
      h += '</div>';

      // ── ITEM LIST FIRST — the active part on site. Sticky header keeps the
      // count + a live fail tally visible while scrolling a long list.
      h += '<div class="cc"><div class="mlc-listhead" id="mlcListHead">'
        + (type === "pat" ? "🔌 Appliances tested" : "💡 Emergency lighting tests")
        + ' <span class="cnt" id="mlcCnt"></span></div>';
      h += '<div class="mlrows" id="mlcRows"></div>';
      if (editable) {
        h += '<div class="toolbar"><button class="btn ghost sm" data-act="add">＋ Add ' + (type === "pat" ? "appliance" : "light") + '</button><button class="btn ghost sm" data-act="add5">＋ Add 5</button>'
          + '<button class="btn ghost sm" data-act="allpass">✔ All Pass</button>'
          + '<button class="btn ghost sm" data-act="setall">⚙ Set all…</button>'
          + '<button class="btn ghost sm" data-act="pull">↻ Pull last</button></div>';
        // Bulk-set panel — apply one value to every item (all Class II, all Pass…)
        h += '<div class="setall" id="mlcSetAll" style="display:none"><div class="muted" style="margin-bottom:4px">Apply to every item:</div>';
        cols.filter(c => c.role === "toggle").forEach(c => {
          h += '<div class="sr"><span class="lb">' + esc(c.label) + '</span>'
            + c.toggle.map(o => '<button class="btn ghost sm" data-bulk="' + c.key + '|' + esc(o) + '">' + esc(o) + '</button>').join("") + '</div>';
        });
        const inputCols = cols.filter(c => c.role === "input");
        if (inputCols.length) {
          h += '<div class="sr"><span class="lb">Value</span><select id="mlcBulkField">'
            + inputCols.map(c => '<option value="' + c.key + '">' + esc(c.label) + '</option>').join("")
            + '</select><input type="text" id="mlcBulkVal" placeholder="set to…" style="width:90px"><button class="btn ghost sm" data-act="bulkinput">Set all</button></div>';
        }
        h += '</div>';
      }
      h += '</div>';

      // ── Header details — collapsed by default (prefilled, rarely edited on site)
      h += '<details class="mlc-fold"><summary>Client &amp; installation</summary><div class="cc-body"><div class="row2">'
        + block("Client", "client") + block("Installation address", "installation") + '</div></div></details>';
      h += '<details class="mlc-fold"><summary>Extent &amp; comments</summary><div class="cc-body">'
        + '<label>Extent &amp; limitations</label><textarea data-f="extent" ' + ro() + '>' + esc(rec.extent || "") + '</textarea>'
        + '<label>Additional comments</label><textarea data-f="comments" ' + ro() + ' style="min-height:70px">' + esc(rec.comments || "") + '</textarea></div></details>';
      h += '<details class="mlc-fold"><summary>Contractor &amp; engineer</summary><div class="cc-body"><div class="row2">'
        + '<div><label>Trading title</label><input type="text" data-c="tradingTitle" value="' + esc(rec.contractor.tradingTitle || "") + '" ' + ro() + '></div>'
        + '<div><label>Engineer name</label><input type="text" data-c="name" value="' + esc(rec.contractor.name || "") + '" ' + ro() + '></div>'
        + '<div><label>Position</label><input type="text" data-c="position" value="' + esc(rec.contractor.position || "Engineer") + '" ' + ro() + '></div>'
        + '<div><label>Date</label><input type="text" data-c="date" value="' + esc(rec.contractor.date || "") + '" placeholder="dd/mm/yyyy or yyyy-mm-dd" ' + ro() + '></div>'
        + '</div></div></details>';

      // Signature (engineer captures; office sees status)
      h += '<div class="cc"><h4>Signature</h4>';
      if (mode === "engineer" && editable) {
        h += '<canvas class="sigpad" id="mlcSig"></canvas><div class="toolbar"><button class="btn ghost sm" data-act="sigclear">Clear</button>'
          + '<button class="btn ghost sm" data-act="siguse">✒ Use my saved signature</button>'
          + '<button class="btn ghost sm" data-act="sigsave">💾 Save as my signature</button>'
          + '<span class="muted" id="mlcSigState">' + (rec.signature ? "Signed ✓" : "Sign above") + '</span></div>';
      } else {
        h += '<div class="muted">' + (rec.signature ? "Signed by the engineer ✓" : "Not signed") + '</div>';
        if (rec.signature) h += '<img src="' + esc(rec.signature) + '" alt="signature" style="max-width:220px;border:1px solid #e2e8f0;border-radius:8px;margin-top:6px;background:#fff">';
      }
      h += '</div>';

      // Actions — a normal card at the end. (No position:sticky here: on iOS a
      // sticky/fixed bottom bar makes the fixed "Viewing as" return bar drift up
      // mid-scroll — see the CLAUDE.md iOS bottom-bar quirk.)
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
    const isFail = r => type === "pat"
      ? (/fail/i.test(r.result || "") || /fail/i.test(r.visual || ""))
      : (/fail/i.test(r.normal || "") || /fail/i.test(r.led || "") || /fail/i.test(r.emergency || ""));
    // Live count + fail tally in the sticky list header; the fail chip jumps to
    // the first failed item so nothing gets missed in a long list.
    // An item counts as "completed" once its required fields are filled — so the
    // header shows live progress (X of Y) as the engineer works, for the admin too.
    const isComplete = r => type === "pat"
      ? (!!String(r.appliance || "").trim() && !!r.visual && !!r.result)
      : (!!r.normal && !!r.led && !!r.emergency && r.battery != null && String(r.battery).trim() !== "");
    function updateListHead() {
      const el = container.querySelector("#mlcCnt"); if (!el) return;
      const n = rec.rows.length, fails = rec.rows.filter(isFail).length, done = rec.rows.filter(isComplete).length;
      el.innerHTML = '<span class="ok">' + done + " of " + n + " completed</span>"
        + (fails ? ' · <span class="bad" data-jump="1">⚠ ' + fails + " failed</span>" : (done === n && n ? ' · <span class="ok">✓ all pass</span>' : ""));
      const j = el.querySelector("[data-jump]");
      if (j) j.onclick = () => { const f = container.querySelector(".mlrow.fail"); if (f) f.scrollIntoView({ behavior: "smooth", block: "center" }); };
    }
    function renderRows() {
      const tb = container.querySelector("#mlcRows"); if (!tb) return;
      let h = "";
      rec.rows.forEach((r, i) => {
        h += '<div class="mlrow' + (isFail(r) ? " fail" : "") + '" data-i="' + i + '"><div class="mlrow-top"><span class="mlrow-n">' + String(i + 1).padStart(2, "0") + '</span><div class="mlrow-title">';
        titleCols.forEach(c => { h += titleInput(c, r[c.key], i); });
        h += '</div>' + (editable ? '<button class="del" data-del="' + i + '">✕</button>' : '') + '</div>';
        h += '<div class="mlrow-fields">';
        fieldCols.forEach(c => { h += '<div class="mlf"><label>' + esc(c.label) + '</label>' + cellHtml(c, r[c.key], i) + '</div>'; });
        h += '</div>';
        if (type === "em") h += remedialHtml(r, i);   // EM only: mark a fitting failed + remedial
        h += '</div>';
      });
      tb.innerHTML = h;
      wireRows();
      updateListHead();
    }
    // EM remedial: mark a fitting as failed, then whether it was replaced on site.
    // The light STAYS a Pass on the certificate (per Mostlane's rule) — this is a
    // separate £50 remedial log. Replaced-on-site rows print "Fitting failed,
    // replaced on site" on the cert; not-replaced rows raise a remedial job for
    // the office to schedule + charge.
    function remedialHtml(r, i) {
      const rem = r.remedial || {};
      const on = !!rem.failed;
      const onsite = rem.replacedOnSite === true ? "yes" : rem.replacedOnSite === false ? "no" : "";
      const kind = rem.kind === "battery" ? "battery" : "light";
      const photos = Array.isArray(rem.photos) ? rem.photos : [];
      if (!editable) {
        if (!on) return "";
        const what = kind === "battery"
          ? "Batteries" + (rem.batterySpec ? " — " + esc(rem.batterySpec) : "") + (rem.batteryQty ? " ×" + esc(rem.batteryQty) : "")
          : "Replacement light (£50)";
        const where = rem.replacedOnSite === true ? "done on site" : rem.replacedOnSite === false ? "remedial required" : "outcome not set";
        const thumbs = photos.map(p => '<img class="mlrem-th" src="' + esc((p && p.url) || "") + '">').join("");
        return '<div class="mlrem ro"><span class="mlrem-tag">⚠ Fitting failed — ' + what + ' · ' + where + '</span>'
          + (rem.note ? ' <span class="muted">· ' + esc(rem.note) + '</span>' : '')
          + (thumbs ? '<div class="mlrem-photos">' + thumbs + '</div>' : '') + '</div>';
      }
      const hint = kind === "battery"
        ? (onsite === "yes" ? 'Batteries replaced on site — NO £50 (supplier prices the batteries). Add spec, qty & photos.'
          : onsite === "no" ? 'Shown as FAILED — batteries go on a supplier enquiry to price (NO £50). Add spec, qty & photos.'
          : 'Add the battery spec, quantity and photos for the supplier.')
        : (onsite === "no" ? 'Shown as FAILED on the certificate — a remedial job is raised and the office quoted £50.'
          : onsite === "yes" ? 'Certificate reads "Fitting failed, replaced on site" — the office charges the client £50.'
          : 'Choose whether it was replaced on site.');
      const thumbs = photos.map((p, pi) => '<span class="mlrem-thw"><img class="mlrem-th" src="' + esc((p && p.url) || "") + '"><button type="button" class="mlrem-thx" data-rem="delphoto" data-i="' + i + '" data-p="' + pi + '">✕</button></span>').join("");
      return '<div class="mlrem' + (on ? " open" : "") + '">'
        + '<button type="button" class="mlrem-flag' + (on ? " on" : "") + '" data-rem="flag" data-i="' + i + '">⚠ ' + (on ? "Fitting failed" : "Mark fitting failed") + '</button>'
        + '<div class="mlrem-body" style="' + (on ? "" : "display:none") + '">'
          + '<span class="mlrem-q">Fault</span>'
          + '<div class="tg mlrem-kind" data-rem="kind" data-i="' + i + '">'
            + '<button type="button" data-v="light" class="' + (kind === "light" ? "on one" : "") + '">Replace light</button>'
            + '<button type="button" data-v="battery" class="' + (kind === "battery" ? "on one" : "") + '">Batteries</button>'
          + '</div>'
          + '<span class="mlrem-q">Done on site?</span>'
          + '<div class="tg mlrem-onsite" data-rem="onsite" data-i="' + i + '">'
            + '<button type="button" data-v="yes" class="' + (onsite === "yes" ? "on pass" : "") + '">Yes</button>'
            + '<button type="button" data-v="no" class="' + (onsite === "no" ? "on na" : "") + '">No</button>'
          + '</div>'
          + '<input type="text" class="mlrem-note" data-rem="note" data-i="' + i + '" placeholder="Fault / fitting detail (optional)" value="' + esc(rem.note || "") + '">'
          + (kind === "battery"
            ? '<div class="mlrem-batt">'
              + '<input type="text" class="mlrem-bspec" data-rem="bspec" data-i="' + i + '" placeholder="Battery type / spec (e.g. 4.8V 4Ah NiCd)" value="' + esc(rem.batterySpec || "") + '">'
              + '<input type="number" inputmode="numeric" class="mlrem-bqty" data-rem="bqty" data-i="' + i + '" placeholder="Qty" value="' + esc(rem.batteryQty == null ? "" : rem.batteryQty) + '">'
              + '<div class="mlrem-photos">' + thumbs + '</div>'
              + '<button type="button" class="mlrem-addphoto" data-rem="addphoto" data-i="' + i + '">📷 Add photo</button>'
              + '</div>'
            : '')
          + '<div class="mlrem-hint">' + hint + '</div>'
        + '</div></div>';
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

    // Row-level handlers — re-bound every time the rows re-render (renderRows
    // calls this), so the toolbar/header handlers in wire() bind exactly once.
    function wireRows() {
      container.querySelectorAll("[data-cell]").forEach(el => el.addEventListener("input", () => { const i = +el.dataset.i; rec.rows[i] = rec.rows[i] || {}; rec.rows[i][el.dataset.cell] = el.value; const rw = el.closest(".mlrow"); if (rw) rw.classList.remove("err-row"); queueSave(); }));
      container.querySelectorAll("[data-tg] button").forEach(btn => btn.addEventListener("click", () => {
        const tg = btn.closest("[data-tg]"); const i = +tg.dataset.i; const key = tg.dataset.tg;
        rec.rows[i] = rec.rows[i] || {}; rec.rows[i][key] = btn.dataset.v;
        tg.querySelectorAll("button").forEach(b => b.className = "");
        const opt = btn.dataset.v; const cls = /^pass$/i.test(opt) ? "pass" : /^fail$/i.test(opt) ? "fail" : (opt === "I" || opt === "II" || tg.querySelectorAll("button").length === 2) ? "one" : "na";
        btn.className = "on " + cls;
        const rowEl = tg.closest(".mlrow"); if (rowEl) { rowEl.classList.toggle("fail", isFail(rec.rows[i])); rowEl.classList.remove("err-row"); }
        updateListHead();
        queueSave();
      }));
      container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => { rec.rows.splice(+b.dataset.del, 1); renderRows(); queueSave(); }));
      // EM remedial controls
      container.querySelectorAll('[data-rem="flag"]').forEach(b => b.addEventListener("click", () => {
        const i = +b.dataset.i; rec.rows[i] = rec.rows[i] || {};
        const rem = (rec.rows[i].remedial = rec.rows[i].remedial || {});
        rem.failed = !rem.failed; if (!rem.failed) rem.replacedOnSite = null;
        renderRows(); queueSave();
      }));
      container.querySelectorAll('[data-rem="onsite"] button').forEach(btn => btn.addEventListener("click", () => {
        const tg = btn.closest("[data-rem]"); const i = +tg.dataset.i;
        const rem = (rec.rows[i].remedial = rec.rows[i].remedial || {});
        rem.replacedOnSite = btn.dataset.v === "yes";
        renderRows(); queueSave();
      }));
      container.querySelectorAll('[data-rem="kind"] button').forEach(btn => btn.addEventListener("click", () => {
        const tg = btn.closest("[data-rem]"); const i = +tg.dataset.i;
        const rem = (rec.rows[i].remedial = rec.rows[i].remedial || {});
        rem.kind = btn.dataset.v; renderRows(); queueSave();
      }));
      container.querySelectorAll('[data-rem="note"]').forEach(el => el.addEventListener("input", () => {
        const i = +el.dataset.i; (rec.rows[i].remedial = rec.rows[i].remedial || {}).note = el.value; queueSave();
      }));
      container.querySelectorAll('[data-rem="bspec"]').forEach(el => el.addEventListener("input", () => {
        const i = +el.dataset.i; (rec.rows[i].remedial = rec.rows[i].remedial || {}).batterySpec = el.value; queueSave();
      }));
      container.querySelectorAll('[data-rem="bqty"]').forEach(el => el.addEventListener("input", () => {
        const i = +el.dataset.i; (rec.rows[i].remedial = rec.rows[i].remedial || {}).batteryQty = el.value === "" ? "" : (Number(el.value) || 0); queueSave();
      }));
      container.querySelectorAll('[data-rem="addphoto"]').forEach(b => b.addEventListener("click", () => pickRemedialPhoto(+b.dataset.i)));
      container.querySelectorAll('[data-rem="delphoto"]').forEach(b => b.addEventListener("click", () => {
        const i = +b.dataset.i, p = +b.dataset.p; const rem = rec.rows[i] && rec.rows[i].remedial;
        if (rem && Array.isArray(rem.photos)) { rem.photos.splice(p, 1); renderRows(); queueSave(); }
      }));
    }
    // Shrink a chosen image to a JPEG data-URL (max dimension), then upload to R2.
    function shrinkImage(file, maxDim) {
      return new Promise((resolve, reject) => {
        const img = new Image(); const url = URL.createObjectURL(file);
        img.onload = () => {
          let w = img.width, h = img.height; const m = maxDim || 1400;
          if (w > h && w > m) { h = Math.round(h * m / w); w = m; } else if (h > m) { w = Math.round(w * m / h); h = m; }
          const c = document.createElement("canvas"); c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
          resolve(c.toDataURL("image/jpeg", 0.82));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
        img.src = url;
      });
    }
    function pickRemedialPhoto(i) {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*"; inp.setAttribute("capture", "environment"); inp.style.display = "none";
      inp.onchange = async () => {
        const file = inp.files && inp.files[0]; if (!file) return;
        const btn = container.querySelector('[data-rem="addphoto"][data-i="' + i + '"]');
        if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }
        try {
          if (!rec.id) await doSave();
          if (!rec.id) { alert("Save the certificate first, then add the photo."); return; }
          const dataUrl = await shrinkImage(file, 1400);
          const blob = await (await fetch(dataUrl)).blob();
          const fd = new FormData(); fd.append("certId", rec.id); fd.append("file", blob, "battery.jpg");
          const d = await fetch(api + "/certs/photo", { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd }).then(r => r.json());
          if (d && d.ok && d.key) {
            const rem = (rec.rows[i].remedial = rec.rows[i].remedial || {});
            rem.photos = rem.photos || []; rem.photos.push({ key: d.key, url: d.url });
            renderRows(); queueSave();
          } else alert((d && d.error) || "Photo upload failed.");
        } catch (e) { alert("Photo upload failed."); }
        finally { if (btn) { btn.disabled = false; btn.textContent = "📷 Add photo"; } }
      };
      document.body.appendChild(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
    }
    function wire() {
      container.querySelectorAll("input[data-f],textarea[data-f]").forEach(el => el.addEventListener("input", () => { rec[el.dataset.f] = el.value; el.classList.remove("err"); queueSave(); }));
      container.querySelectorAll("[data-b]").forEach(el => el.addEventListener("input", () => { const [k, f] = el.dataset.b.split("."); (rec[k] = rec[k] || {})[f] = el.value; el.classList.remove("err"); queueSave(); }));
      container.querySelectorAll("[data-c]").forEach(el => el.addEventListener("input", () => { rec.contractor[el.dataset.c] = el.value; el.classList.remove("err"); queueSave(); }));
      const tb = container.querySelector('[data-act="add"]'); if (tb) tb.addEventListener("click", () => { addRows(1); });
      const t5 = container.querySelector('[data-act="add5"]'); if (t5) t5.addEventListener("click", () => { addRows(5); });
      const ap = container.querySelector('[data-act="allpass"]'); if (ap) ap.addEventListener("click", allPass);
      const sa = container.querySelector('[data-act="setall"]'); if (sa) sa.addEventListener("click", () => { const p = container.querySelector("#mlcSetAll"); if (p) p.style.display = p.style.display === "none" ? "block" : "none"; });
      container.querySelectorAll("[data-bulk]").forEach(btn => btn.addEventListener("click", () => { const [k, v] = btn.dataset.bulk.split("|"); bulkSet(k, v); }));
      const bi = container.querySelector('[data-act="bulkinput"]'); if (bi) bi.addEventListener("click", () => { const f = container.querySelector("#mlcBulkField").value; const v = container.querySelector("#mlcBulkVal").value.trim(); if (f) bulkSet(f, v); });
      const pl = container.querySelector('[data-act="pull"]'); if (pl) pl.addEventListener("click", pullPrevious);
      const sc = container.querySelector('[data-act="sigclear"]'); if (sc) sc.addEventListener("click", () => { if (sigCtx) sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); rec.signature = ""; const st = container.querySelector("#mlcSigState"); if (st) st.textContent = "Sign above"; queueSave(); });
      // Saved signature: one tap to drop in a consistent personal signature, and a
      // button to save the current drawing as that default (stored per-user).
      const su = container.querySelector('[data-act="siguse"]'); if (su) su.addEventListener("click", async () => {
        try {
          const d = await authFetch("/certs/my-signature").then(r => r.json());
          if (!d || !d.ok || !d.signature) { alert("No saved signature yet — draw one, then tap “Save as my signature”."); return; }
          rec.signature = d.signature;
          if (sigCtx && sigCanvas) { sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); const im = new Image(); im.onload = () => sigCtx.drawImage(im, 0, 0, sigCanvas.width, sigCanvas.height); im.src = d.signature; }
          const st = container.querySelector("#mlcSigState"); if (st) st.textContent = "Signed ✓ (saved)";
          queueSave();
        } catch (e) { alert("Couldn't load your saved signature."); }
      });
      const ss = container.querySelector('[data-act="sigsave"]'); if (ss) ss.addEventListener("click", async () => {
        if (!rec.signature) { alert("Draw your signature first, then save it."); return; }
        try {
          const d = await authFetch("/certs/my-signature", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signature: rec.signature }) }).then(r => r.json());
          const st = container.querySelector("#mlcSigState"); if (st) st.textContent = (d && d.ok) ? "Saved as your signature ✓" : "Couldn't save signature";
        } catch (e) { const st = container.querySelector("#mlcSigState"); if (st) st.textContent = "Couldn't save signature"; }
      });
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
      renderRows(); queueSave();
    }
    function allPass() {
      rec.rows.forEach(r => { if (type === "em") { r.normal = "Pass"; r.led = "Pass"; r.emergency = "Pass"; if (!r.battery) r.battery = 180; } else { r.visual = "Pass"; r.result = "Pass"; } });
      renderRows(); queueSave();
    }
    // Bulk-set ONE field on every row (e.g. all Class II, all Visual Pass, all
    // battery 180). One place, no clutter — the "⚙ Set all…" panel.
    function bulkSet(key, val) {
      if (!key) return;
      rec.rows.forEach(r => { r[key] = val; });
      renderRows(); queueSave();
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
    // Strict pre-submit validation: every required field must be filled. Missing
    // fields are highlighted red, their section is expanded, and the view scrolls
    // to the first one. Returns { ok, missing:[labels], firstEl }.
    function validate() {
      container.querySelectorAll(".err").forEach(e => e.classList.remove("err"));
      container.querySelectorAll(".err-row").forEach(e => e.classList.remove("err-row"));
      const missing = []; let firstEl = null;
      const need = (sel, label) => {
        const el = container.querySelector(sel); if (!el) return;
        if (!String(el.value || "").trim()) { el.classList.add("err"); missing.push(label); if (!firstEl) firstEl = el; }
      };
      need('[data-b="client.name"]', "Client name");
      need('[data-b="client.address"]', "Client address");
      need('[data-b="client.postcode"]', "Client postcode");
      need('[data-b="installation.name"]', "Installation name");
      need('[data-b="installation.postcode"]', "Installation postcode");
      need('[data-f="extent"]', "Extent & limitations");
      need('[data-c="name"]', "Engineer name");
      need('[data-c="date"]', "Certificate date");
      let badRows = 0;
      if (!rec.rows.length) missing.push("at least one " + (type === "pat" ? "appliance" : "light"));
      let remOpen = 0, battBad = 0;
      rec.rows.forEach((r, i) => {
        let bad = false;
        if (type === "em") { if (!r.normal || !r.led || !r.emergency || r.battery == null || String(r.battery).trim() === "") bad = true; }
        else { if (!String(r.appliance || "").trim() || !r.visual || !r.result) bad = true; }
        // A failed fitting MUST say whether it was done on site (drives the charge + remedial job).
        if (type === "em" && r.remedial && r.remedial.failed) {
          const rem = r.remedial;
          if (rem.replacedOnSite == null) { bad = true; remOpen++; }
          // Batteries: spec + qty + at least one photo, so the supplier can quote.
          if (rem.kind === "battery") {
            if (!String(rem.batterySpec || "").trim() || !(Number(rem.batteryQty) > 0) || !(Array.isArray(rem.photos) && rem.photos.length)) { bad = true; battBad++; }
          }
        }
        if (bad) { badRows++; const rowEl = container.querySelector('.mlrow[data-i="' + i + '"]'); if (rowEl) { rowEl.classList.add("err-row"); if (!firstEl) firstEl = rowEl; } }
      });
      if (badRows) missing.push(badRows + (type === "pat" ? " appliance" : " item") + (badRows === 1 ? "" : "s") + " not fully filled in");
      if (remOpen) missing.push(remOpen + " failed fitting" + (remOpen === 1 ? "" : "s") + " — say if done on site");
      if (battBad) missing.push(battBad + " battery fault" + (battBad === 1 ? "" : "s") + " — add spec, quantity & a photo");
      if (!rec.signature) { missing.push("signature"); const sc = container.querySelector("#mlcSig"); if (sc && !firstEl) firstEl = sc; }
      // expand any collapsed section that holds a flagged field so it's visible
      container.querySelectorAll("details.mlc-fold").forEach(d => { if (d.querySelector(".err")) d.open = true; });
      return { ok: missing.length === 0, missing, firstEl };
    }
    // Validate → save → submit for office review. `silent` skips the alert (the
    // combined-job orchestrator handles messaging), but validation still gates.
    async function submit(silent) {
      const v = validate();
      if (!v.ok) {
        if (v.firstEl) setTimeout(() => v.firstEl.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
        if (!silent) alert("Please complete before submitting:\n\n• " + v.missing.join("\n• "));
        return false;
      }
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
