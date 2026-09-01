/* remedials-form.js — shared "Remedial works" capture for electrical-test jobs.
 *
 *   window.MLRemedials.mount(el, {
 *     jobId, mode:"engineer"|"office", api, token, job,
 *     canManage,            // office: may create the works job
 *     onCreateWorks,        // office: called with the new job id after creation
 *   })
 *
 * Engineer mode: add/edit/remove items (code · description · duration · material £
 *   · photos), autosaving to PATCH /sla/jobs/{id} {remedials}.
 * Office mode: a clean read-only table with totals + a "Create works job" button
 *   (POST /sla/jobs/{id}/create-works-job) that spins the remedials into a new
 *   unassigned site-audit job (photos carried, duration/cost stripped).
 *
 * v1
 */
(function () {
  var CODES = ["", "C1", "C2", "C3", "FI"];
  var CODE_LABEL = { "": "–", C1: "C1", C2: "C2", C3: "C3", FI: "FI" };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtDur(min) { min = Math.round(Number(min) || 0); var h = Math.floor(min / 60), m = min % 60; return h ? (h + "h" + (m ? " " + m + "m" : "")) : (m + "m"); }
  function fmtGBP(n) { n = Number(n) || 0; return "£" + n.toFixed(2); }
  function uid() { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // Shrink an image File to a JPEG blob at a max dimension.
  function shrink(file, max, quality) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        var c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (b) { resolve(b); }, "image/jpeg", quality || 0.82);
      };
      img.onerror = function () { resolve(null); };
      img.src = URL.createObjectURL(file);
    });
  }

  function mount(el, opts) {
    opts = opts || {};
    var API = opts.api || (window.MOSTLANE_API || "");
    var jobId = opts.jobId;
    var mode = opts.mode === "office" ? "office" : "engineer";
    var items = (opts.job && Array.isArray(opts.job.remedials) ? opts.job.remedials : []).map(normItem);
    var worksJobId = opts.job && opts.job.remedialsWorksJobId;
    var saveTimer = null, saving = false;

    function normItem(r) {
      return {
        id: r.id || uid(), code: CODES.indexOf(r.code) >= 0 ? r.code : "",
        description: r.description || "", minutes: Number(r.minutes) || 0,
        materialCost: Number(r.materialCost) || 0,
        photos: (r.photos || r.photoUrls || []).map(function (p) { return typeof p === "string" ? { key: p, thumb: "", url: "" } : { key: p.key, thumb: p.thumb || "", url: p.url || "" }; }).filter(function (p) { return p.key; }),
      };
    }
    function payloadItems() {
      return items.map(function (r) { return { id: r.id, code: r.code, description: r.description, minutes: r.minutes, materialCost: r.materialCost, photos: r.photos.map(function (p) { return p.key; }) }; });
    }

    function afetch(path, init) {
      init = init || {}; init.headers = init.headers || {};
      if (opts.token) init.headers.Authorization = "Bearer " + opts.token;
      return fetch(API + path, init);
    }

    function queueSave() {
      if (mode !== "engineer") return;
      setStatus("Saving…");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 800);
    }
    function doSave() {
      if (saving) { queueSave(); return; }
      saving = true;
      afetch("/sla/jobs/" + encodeURIComponent(jobId), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remedials: payloadItems() }),
      }).then(function (r) { saving = false; setStatus(r.ok ? "Saved ✓" : "Save failed — will retry"); if (!r.ok) queueSave(); })
        .catch(function () { saving = false; setStatus("Offline — will retry"); setTimeout(queueSave, 6000); });
    }
    function setStatus(t) { var s = el.querySelector(".mlr-status"); if (s) s.textContent = t; }

    // ── Engineer editor ──────────────────────────────────────────────────────
    function renderEngineer() {
      var totMin = items.reduce(function (a, r) { return a + (Number(r.minutes) || 0); }, 0);
      var totMat = items.reduce(function (a, r) { return a + (Number(r.materialCost) || 0); }, 0);
      var h = '<div class="mlr-wrap"><div class="mlr-head"><b>Remedial works</b><span class="mlr-status"></span></div>' +
        '<p class="mlr-hint">List each remedial as its own item — add the code, what needs doing, roughly how long, an approximate material cost, and photos. Leave the list empty if the test was satisfactory.</p>';
      h += '<div class="mlr-items">';
      items.forEach(function (r, i) { h += itemHtml(r, i); });
      h += '</div>';
      h += '<button type="button" class="mlr-add">➕ Add remedial</button>';
      h += '<div class="mlr-tot">' + items.length + ' item' + (items.length === 1 ? "" : "s") + ' · ' + fmtDur(totMin) + ' · ' + fmtGBP(totMat) + ' materials</div>';
      h += '</div>';
      el.innerHTML = h;
      wireEngineer();
    }
    function itemHtml(r, i) {
      var opts2 = CODES.map(function (c) { return '<option value="' + c + '"' + (c === r.code ? " selected" : "") + '>' + CODE_LABEL[c] + '</option>'; }).join("");
      var photos = r.photos.map(function (p) { return '<div class="mlr-ph"><img src="' + esc(p.thumb || p.url) + '" loading="lazy"><button type="button" class="mlr-ph-x" data-delph="' + esc(p.key) + '">✕</button></div>'; }).join("");
      return '<div class="mlr-item" data-i="' + i + '">' +
        '<div class="mlr-row1"><span class="mlr-num">' + (i + 1) + '</span>' +
        '<select class="mlr-code" title="Code">' + opts2 + '</select>' +
        '<button type="button" class="mlr-del" title="Remove">🗑</button></div>' +
        '<textarea class="mlr-desc" rows="2" placeholder="What needs doing…">' + esc(r.description) + '</textarea>' +
        '<div class="mlr-row2">' +
        '<label>Duration <input type="number" class="mlr-min" min="0" step="5" value="' + (r.minutes || "") + '"><span>min</span></label>' +
        '<label>Material £ <input type="number" class="mlr-mat" min="0" step="1" value="' + (r.materialCost || "") + '"></label>' +
        '</div>' +
        '<div class="mlr-photos">' + photos + '<label class="mlr-addph">📷 Photo<input type="file" accept="image/*" capture="environment" hidden></label></div>' +
        '</div>';
    }
    function wireEngineer() {
      el.querySelector(".mlr-add").onclick = function () { items.push(normItem({})); renderEngineer(); queueSave(); };
      Array.prototype.forEach.call(el.querySelectorAll(".mlr-item"), function (node) {
        var i = +node.getAttribute("data-i"), r = items[i];
        node.querySelector(".mlr-code").onchange = function () { r.code = this.value; };
        node.querySelector(".mlr-desc").oninput = function () { r.description = this.value; queueSave(); };
        node.querySelector(".mlr-min").oninput = function () { r.minutes = Math.max(0, Number(this.value) || 0); queueSave(); };
        node.querySelector(".mlr-mat").oninput = function () { r.materialCost = Math.max(0, Number(this.value) || 0); queueSave(); };
        node.querySelector(".mlr-del").onclick = function () {
          (window.MLUI ? MLUI.confirm("Remove this remedial item?", { danger: true }) : Promise.resolve(confirm("Remove this remedial item?"))).then(function (ok) {
            if (!ok) return; items.splice(i, 1); renderEngineer(); queueSave();
          });
        };
        node.querySelector(".mlr-addph input").onchange = function () { var f = this.files && this.files[0]; if (f) uploadPhoto(r, f); this.value = ""; };
        Array.prototype.forEach.call(node.querySelectorAll("[data-delph]"), function (b) {
          b.onclick = function () {
            var key = b.getAttribute("data-delph");
            r.photos = r.photos.filter(function (p) { return p.key !== key; });
            afetch("/sla/jobs/" + encodeURIComponent(jobId) + "/remedial-photo?key=" + encodeURIComponent(key), { method: "DELETE" }).catch(function () {});
            renderEngineer(); queueSave();
          };
        });
      });
    }
    function uploadPhoto(r, file) {
      setStatus("Uploading photo…");
      Promise.all([shrink(file, 1400, 0.82), shrink(file, 420, 0.7)]).then(function (arr) {
        var full = arr[0] || file, thumb = arr[1];
        var fd = new FormData();
        fd.append("file", full, "photo.jpg");
        if (thumb) fd.append("thumb", thumb, "thumb.jpg");
        fd.append("itemId", r.id);
        return afetch("/sla/jobs/" + encodeURIComponent(jobId) + "/remedial-photo", { method: "POST", body: fd });
      }).then(function (res) { return res.json(); }).then(function (j) {
        if (j && j.key) { r.photos.push({ key: j.key, thumb: j.thumb, url: j.url }); renderEngineer(); queueSave(); }
        else setStatus("Photo failed — try again");
      }).catch(function () { setStatus("Photo failed — try again"); });
    }

    // ── Office read-only view ─────────────────────────────────────────────────
    function renderOffice() {
      var totMin = items.reduce(function (a, r) { return a + (Number(r.minutes) || 0); }, 0);
      var totMat = items.reduce(function (a, r) { return a + (Number(r.materialCost) || 0); }, 0);
      var h = '<div class="mlr-wrap"><div class="mlr-head"><b>Remedial works</b><span class="mlr-count">' + items.length + ' item' + (items.length === 1 ? "" : "s") + '</span></div>';
      if (!items.length) { h += '<p class="mlr-hint">No remedials recorded — the test was satisfactory (or not yet completed).</p></div>'; el.innerHTML = h; return; }
      h += '<div class="mlr-tblwrap"><table class="mlr-tbl"><thead><tr><th>#</th><th>Code</th><th>Task</th><th>Duration</th><th>Material</th><th>Photos</th></tr></thead><tbody>';
      items.forEach(function (r, i) {
        var photos = r.photos.map(function (p) { return '<img class="mlr-th" src="' + esc(p.thumb || p.url) + '" data-full="' + esc(p.url || p.thumb) + '" loading="lazy">'; }).join("");
        h += '<tr><td>' + (i + 1) + '</td><td>' + (r.code ? '<span class="mlr-code-pill c' + r.code + '">' + esc(r.code) + '</span>' : "–") + '</td>' +
          '<td class="mlr-t">' + esc(r.description) + '</td><td>' + fmtDur(r.minutes) + '</td><td>' + fmtGBP(r.materialCost) + '</td>' +
          '<td class="mlr-ths">' + (photos || "–") + '</td></tr>';
      });
      h += '</tbody><tfoot><tr><td colspan="3">Totals</td><td>' + fmtDur(totMin) + '</td><td>' + fmtGBP(totMat) + '</td><td></td></tr></tfoot></table></div>';
      // Create-works action.
      if (worksJobId) {
        h += '<div class="mlr-works done">✓ Works job created — <a href="job-view.html?jobId=' + encodeURIComponent(worksJobId) + '">open it</a></div>';
      } else if (opts.canManage) {
        h += '<button type="button" class="mlr-mk">➕ Create works job from these remedials</button>' +
          '<div class="mlr-mkhint">Makes a new unassigned job with every task + photo (no durations or costs), ready to allocate.</div>';
      }
      h += '</div>';
      el.innerHTML = h;
      var mk = el.querySelector(".mlr-mk");
      if (mk) mk.onclick = createWorks;
      Array.prototype.forEach.call(el.querySelectorAll(".mlr-th"), function (im) { im.onclick = function () { var u = im.getAttribute("data-full"); if (u) window.open(u, "_blank"); }; });
    }
    // Opens a picker so the office chooses which remedials go on the works job.
    // C1 / C2 / FI are pre-ticked (usually actioned); C3 (and un-coded items) are
    // left unticked but can be added.
    var PRESELECT = ["C1", "C2", "FI"];
    function createWorks() {
      var pick = items.filter(function (r) { return r.description || r.photos.length; });
      if (!pick.length) { alert("There are no remedials to turn into works."); return; }
      var ov = document.createElement("div");
      ov.className = "mlr-ov";
      var rows = pick.map(function (r, i) {
        var on = PRESELECT.indexOf((r.code || "").toUpperCase()) >= 0;
        return '<label class="mlr-pk-row"><input type="checkbox" data-i="' + i + '"' + (on ? " checked" : "") + '>' +
          '<span class="mlr-pk-code">' + (r.code ? '<span class="mlr-code-pill c' + r.code + '">' + esc(r.code) + '</span>' : '<span class="mlr-pk-none">–</span>') + '</span>' +
          '<span class="mlr-pk-desc">' + esc(r.description || "(no description)") + (r.photos.length ? ' <span class="mlr-pk-ph">📷' + r.photos.length + '</span>' : '') + '</span></label>';
      }).join("");
      ov.innerHTML = '<div class="mlr-pk">' +
        '<div class="mlr-pk-h">Which remedials go on the works job?</div>' +
        '<div class="mlr-pk-hint">C1, C2 &amp; FI are ticked by default. C3 isn\'t usually required — tick any you want to include.</div>' +
        '<div class="mlr-pk-list">' + rows + '</div>' +
        '<div class="mlr-pk-act"><button type="button" class="mlr-pk-cancel">Cancel</button>' +
        '<button type="button" class="mlr-pk-go">Create works job</button></div></div>';
      document.body.appendChild(ov);
      var close = function () { try { document.body.removeChild(ov); } catch (e) {} };
      var updateGo = function () {
        var n = ov.querySelectorAll('.mlr-pk-list input:checked').length;
        var g = ov.querySelector('.mlr-pk-go'); g.textContent = "Create works job" + (n ? " (" + n + ")" : ""); g.disabled = !n;
      };
      ov.querySelectorAll('.mlr-pk-list input').forEach(function (c) { c.addEventListener("change", updateGo); });
      updateGo();
      ov.querySelector(".mlr-pk-cancel").onclick = close;
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      ov.querySelector(".mlr-pk-go").onclick = function () {
        var ids = Array.prototype.map.call(ov.querySelectorAll('.mlr-pk-list input:checked'), function (c) { return pick[+c.getAttribute("data-i")].id; });
        if (!ids.length) return;
        var g = ov.querySelector(".mlr-pk-go"); g.disabled = true; g.textContent = "Creating…";
        submitWorks(ids, close, function () { g.disabled = false; updateGo(); });
      };
    }
    function submitWorks(itemIds, onDone, onFail) {
      afetch("/sla/jobs/" + encodeURIComponent(jobId) + "/create-works-job", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemIds: itemIds })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j && res.j.id) {
            worksJobId = res.j.id; if (onDone) onDone(); renderOffice();
            if (typeof opts.onCreateWorks === "function") opts.onCreateWorks(res.j.id);
            if (window.MLUI && MLUI.toast) MLUI.toast("Works job created"); else alert("Works job created");
          } else { alert((res.j && res.j.error) || "Couldn't create the works job."); if (onFail) onFail(); }
        }).catch(function () { alert("Couldn't create the works job."); if (onFail) onFail(); });
    }

    injectStyle();
    if (mode === "engineer") renderEngineer(); else renderOffice();
  }

  function injectStyle() {
    if (document.getElementById("mlr-style")) return;
    var css = ''
      + '.mlr-wrap{font-size:14px}'
      + '.mlr-head{display:flex;justify-content:space-between;align-items:center;margin:2px 0 6px}'
      + '.mlr-head b{color:#003468;font-size:16px}.mlr-status{font-size:12px;color:#16a34a}.mlr-count{font-size:12px;color:#64748b}'
      + '.mlr-hint{font-size:12px;color:#64748b;margin:0 0 10px}'
      + '.mlr-item{border:1px solid #d7dee6;border-radius:12px;padding:10px;margin-bottom:10px;background:#fff}'
      + '.mlr-row1{display:flex;align-items:center;gap:8px;margin-bottom:6px}'
      + '.mlr-num{width:22px;height:22px;border-radius:999px;background:#003468;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}'
      + '.mlr-code{flex:1;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}'
      + '.mlr-del{background:none;border:0;font-size:18px;cursor:pointer}'
      + '.mlr-desc{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:inherit;resize:vertical;color:#0f2438}'
      + '.mlr-row2{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px}'
      + '.mlr-row2 label{font-size:12px;color:#475569;display:flex;align-items:center;gap:6px}'
      + '.mlr-row2 input{width:90px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}'
      + '.mlr-photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}'
      + '.mlr-ph{position:relative}.mlr-ph img{width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #d7dee6}'
      + '.mlr-ph-x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:999px;border:0;background:#dc2626;color:#fff;font-size:11px;cursor:pointer;line-height:1}'
      + '.mlr-addph{display:inline-flex;align-items:center;justify-content:center;width:60px;height:60px;border:1px dashed #94a3b8;border-radius:8px;color:#475569;font-size:11px;cursor:pointer;text-align:center}'
      + '.mlr-add{width:100%;padding:10px;border:1px dashed #003468;background:#f3f7fc;color:#003468;border-radius:10px;font-weight:600;cursor:pointer}'
      + '.mlr-tot{font-size:12px;color:#475569;margin-top:8px;text-align:right}'
      + '.mlr-tblwrap{overflow-x:auto}.mlr-tbl{width:100%;border-collapse:collapse;font-size:13px}'
      + '.mlr-tbl th,.mlr-tbl td{border-bottom:1px solid #e5e9ef;padding:7px 8px;text-align:left;vertical-align:top}'
      + '.mlr-tbl thead th{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.03em}'
      + '.mlr-tbl tfoot td{font-weight:700;border-top:2px solid #cbd5e1}'
      + '.mlr-t{max-width:280px}'
      + '.mlr-code-pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;color:#fff}'
      + '.mlr-code-pill.cC1{background:#b91c1c}.mlr-code-pill.cC2{background:#ea580c}.mlr-code-pill.cC3{background:#0891b2}.mlr-code-pill.cFI{background:#7c3aed}'
      + '.mlr-th{width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #d7dee6;margin:0 4px 4px 0;cursor:pointer}'
      + '.mlr-mk{width:100%;margin-top:12px;padding:12px;border:0;background:#003468;color:#fff;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer}'
      + '.mlr-mkhint{font-size:12px;color:#64748b;margin-top:6px;text-align:center}'
      + '.mlr-works{margin-top:12px;padding:10px;border-radius:10px;background:#ecfdf5;border:1px solid #bbf7d0;color:#166534;font-weight:600}'
      + '.mlr-works a{color:#166534}'
      + '.mlr-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;z-index:100000;padding:16px;}'
      + '.mlr-pk{background:#fff;border-radius:14px;max-width:460px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.3);overflow:hidden;}'
      + '.mlr-pk-h{font-weight:700;font-size:16px;color:#003468;padding:16px 16px 4px;}'
      + '.mlr-pk-hint{font-size:12px;color:#64748b;padding:0 16px 8px;}'
      + '.mlr-pk-list{overflow:auto;padding:4px 8px;flex:1;}'
      + '.mlr-pk-row{display:flex;align-items:flex-start;gap:10px;padding:9px 8px;border-radius:8px;cursor:pointer;font-size:14px;}'
      + '.mlr-pk-row:hover{background:#f3f7fc;}.mlr-pk-row input{margin-top:2px;width:18px;height:18px;flex:none;}'
      + '.mlr-pk-code{flex:none;width:34px;}.mlr-pk-none{color:#94a3b8;}'
      + '.mlr-pk-desc{flex:1;color:#0f2438;}.mlr-pk-ph{color:#64748b;font-size:12px;white-space:nowrap;}'
      + '.mlr-pk-act{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #e5e9ef;}'
      + '.mlr-pk-cancel{padding:9px 14px;border:1px solid #cbd5e1;background:#fff;border-radius:9px;font:inherit;cursor:pointer;}'
      + '.mlr-pk-go{padding:9px 16px;border:0;background:#003468;color:#fff;border-radius:9px;font:inherit;font-weight:700;cursor:pointer;}'
      + '.mlr-pk-go:disabled{opacity:.5;cursor:default;}';
    var st = document.createElement("style"); st.id = "mlr-style"; st.textContent = css; document.head.appendChild(st);
  }

  window.MLRemedials = { mount: mount };
})();
