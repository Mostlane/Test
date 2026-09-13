/* Shared Sump Pump Monthly Maintenance form.
   window.MLPump.mount(el, {
     jobId, store, mode:"engineer"|"office"|"view", api, token,
     recordId?, patchComplete?, onComplete?, hideComplete?
   })
   - engineer: fill + autosave + "Complete & submit" (submits for office review)
   - office:   edit every field + autosave (the review page owns Finalise)
   - view:     read-only + open PDF
   Photos AND videos upload straight to the record. Two signatures (engineer +
   store DM). A required safety pre-check must be Yes before it can be submitted. */
(function () {
  // Camera-or-gallery chooser (shared across the field photo forms). Pump photos
  // aren't "live only", so the engineer picks camera or gallery. Guarded so
  // whichever field script defines it first wins; falls back to the native picker.
  if (typeof window !== "undefined" && !window.MLPhotoInput) {
    window.MLPhotoInput = function (input, cb) {
      function go(mode){ if(!mode) return; if(mode==="camera") input.setAttribute("capture","environment"); else input.removeAttribute("capture"); if(cb) cb(mode); input.click(); }
      try{
        var ov=document.createElement("div");
        ov.style.cssText="position:fixed;inset:0;z-index:2147483600;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;padding:16px";
        var sh=document.createElement("div");
        sh.style.cssText="background:#fff;border-radius:16px;max-width:420px;width:100%;padding:14px;box-shadow:0 -6px 28px rgba(0,0,0,.3)";
        sh.innerHTML='<div style="font-weight:700;color:#003468;font-size:15px;margin:4px 6px 12px">Add a photo</div>';
        function mk(t,p){ var b=document.createElement("button"); b.type="button"; b.textContent=t; b.style.cssText="display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:14px;border:1px solid #d7dee6;border-radius:12px;background:"+(p?"#f7f9fc":"#fff")+";font:inherit;font-size:15px;font-weight:"+(p?"600":"500")+";color:"+(p?"#0f2438":"#64748b")+";cursor:pointer"; return b; }
        var cam=mk("📷 Take a photo",1),gal=mk("🖼 Choose from gallery",1),cx=mk("Cancel",0);
        var done=false; function fin(v){ if(done) return; done=true; try{ov.remove();}catch(e){} go(v); }
        cam.onclick=function(){fin("camera");}; gal.onclick=function(){fin("gallery");}; cx.onclick=function(){fin(null);};
        ov.addEventListener("click",function(e){ if(e.target===ov) fin(null); });
        sh.appendChild(cam); sh.appendChild(gal); sh.appendChild(cx); ov.appendChild(sh); document.body.appendChild(ov);
      }catch(e){ go("gallery"); }
    };
  }
  var CSS = ""
    + ".mlp{font-family:inherit;color:#14202c}"
    + ".mlp .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin-bottom:12px}"
    + ".mlp h4{margin:0 0 8px;font-size:14px;color:#003468}"
    + ".mlp .instr{white-space:pre-wrap;font-size:13px;color:#37475a;line-height:1.5}"
    + ".mlp .instr .imp{font-weight:700;color:#0f2438}"
    + ".mlp .row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9}"
    + ".mlp .row:last-child{border-bottom:0}"
    + ".mlp .row .lab{flex:1;font-size:13.5px;line-height:1.35}"
    + ".mlp .yn{display:flex;gap:6px;flex:none}"
    + ".mlp .yn button{border:1px solid #cbd5e1;background:#fff;color:#475569;border-radius:8px;padding:7px 11px;font-size:13px;font-weight:600;cursor:pointer;min-width:44px}"
    + ".mlp .yn button.yes.on{background:#0a7d33;border-color:#0a7d33;color:#fff}"
    + ".mlp .yn button.no.on{background:#b00020;border-color:#b00020;color:#fff}"
    + ".mlp .yn button.na.on{background:#64748b;border-color:#64748b;color:#fff}"
    + ".mlp .safety .row .lab{font-weight:600}"
    + ".mlp .safety.bad{border-color:#f0b4b4;background:#fdf3f3}"
    + ".mlp textarea,.mlp input[type=text],.mlp input[type=date]{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:9px;padding:9px 10px;font:inherit;font-size:14px;color:#0f2438;background:#fff}"
    + ".mlp textarea{min-height:64px;resize:vertical}"
    + ".mlp label.flbl{display:block;font-size:12px;font-weight:700;color:#475569;margin:8px 0 3px}"
    + ".mlp .two{display:flex;gap:10px}.mlp .two>div{flex:1}"
    + ".mlp .media{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}"
    + ".mlp .mtile{position:relative;width:82px;height:82px;border-radius:9px;overflow:hidden;border:1px solid #e2e8f0;background:#f1f5f9;display:flex;align-items:center;justify-content:center}"
    + ".mlp .mtile img{width:100%;height:100%;object-fit:cover}"
    + ".mlp .mtile .vid{font-size:26px}"
    + ".mlp .mtile .del{position:absolute;top:2px;right:2px;background:rgba(0,0,0,.6);color:#fff;border:0;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:20px;text-align:center}"
    + ".mlp .btn{border:0;border-radius:10px;padding:11px 14px;font-size:14px;font-weight:700;cursor:pointer}"
    + ".mlp .btn.p{background:#003468;color:#fff;width:100%}"
    + ".mlp .btn.line{background:#fff;color:#003468;border:1px solid #003468}"
    + ".mlp .btn[disabled]{opacity:.5;cursor:default}"
    + ".mlp .sigpad{border:1px dashed #94a3b8;border-radius:9px;background:#fff;touch-action:none;width:100%;height:120px;display:block}"
    + ".mlp .sigrow{display:flex;justify-content:space-between;align-items:center;margin-top:4px}"
    + ".mlp .sigrow a{color:#b00020;font-size:12px;text-decoration:none;cursor:pointer}"
    + ".mlp .chk{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#0f2438;cursor:pointer}"
    + ".mlp .chk input{width:18px;height:18px;margin-top:1px;flex:none}"
    + ".mlp .status{font-size:12px;color:#64748b;text-align:center;margin:4px 0 10px;min-height:15px}"
    + ".mlp .miss{color:#b00020;font-size:13px;text-align:center;margin-bottom:8px}"
    + ".mlp .uploading{font-size:12px;color:#64748b}";

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",'\'':"&#39;" }[c]; }); }
  function ans(a) { var s = String(a || "").toLowerCase(); if (/^y/.test(s)) return "yes"; if (/^n\/?a/.test(s) || s === "na") return "na"; if (/^n/.test(s)) return "no"; return ""; }

  function mount(host, opt) {
    opt = opt || {};
    var API = opt.api || (window.MOSTLANE_API || ""), TOKEN = opt.token || (localStorage.getItem("mostlaneToken") || "");
    var MODE = opt.mode || "engineer", RO = MODE === "view";
    if (!document.getElementById("mlpump-style")) { var st = el("style"); st.id = "mlpump-style"; st.textContent = CSS; document.head.appendChild(st); }
    host.innerHTML = '<div class="mlp"><div class="status" id="mlpStatus">Loading…</div><div id="mlpBody"></div></div>';
    var statusEl = host.querySelector("#mlpStatus"), body = host.querySelector("#mlpBody");
    var REC = null, saveT = null, dirty = false, sigPads = {};

    function af(path, o) { o = o || {}; o.headers = Object.assign({ "Authorization": "Bearer " + TOKEN }, o.headers || {}); return fetch((path.indexOf("http") === 0 ? path : API + path), o); }
    function setStatus(t) { statusEl.textContent = t || ""; }

    // Office/view: load the EXACT record by id (the queue row that was tapped).
    // Engineer: the job's record (or a fresh seeded one for that store).
    var loadUrl = opt.recordId
      ? "/pump/one?id=" + encodeURIComponent(opt.recordId)
      : "/pump/for-job?jobId=" + encodeURIComponent(opt.jobId || "") + "&store=" + encodeURIComponent(opt.store || "");
    function loadFail(msg) {
      setStatus("");
      body.innerHTML = '<div class="card" style="border-color:#e6b3ba;background:#fff5f5;color:#b00020;font-weight:600">Couldn\'t load the pump record' + (msg ? " — " + esc(msg) : "") + '.<br><span style="font-weight:400;color:#6b7a90">Pull down to refresh and try again. If it keeps happening, tell the office which store and date.</span></div>';
    }
    af(loadUrl)
      .then(function (r) { return r.json().then(function (d) { return { st: r.status, d: d }; }); })
      .then(function (x) {
        var d = x.d;
        if (!d || !d.ok || !d.record) { loadFail((d && d.error) || ("HTTP " + x.st)); return; }
        REC = d.record;
        try { render(); setStatus(""); }
        catch (e) { loadFail("display error: " + (e && e.message)); }
      })
      .catch(function (e) { loadFail(e && e.message); });

    function queueSave(now) {
      if (RO) return;
      dirty = true; setStatus("Saving…");
      if (saveT) clearTimeout(saveT);
      saveT = setTimeout(doSave, now ? 0 : 900);
    }
    function collect() {
      return {
        id: REC.id || undefined, jobId: opt.jobId || REC.jobId, store: REC.store,
        storeName: REC.storeName, instructions: REC.instructions,
        safety: (REC.safety || []).map(function (s) { return { id: s.id, label: s.label, answer: s.answer || "" }; }),
        checks: (REC.checks || []).map(function (c) { return { label: c.label, answer: c.answer || "" }; }),
        detailsNo: REC.detailsNo || "", declarationAgreed: REC.declarationAgreed || "",
        date: REC.date || "", engineerName: REC.engineerName || "", dmName: REC.dmName || "",
        engSig: REC.engSig || "", dmSig: REC.dmSig || ""
      };
    }
    function doSave() {
      if (RO) return Promise.resolve();
      return af("/pump/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(collect()) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d && d.ok) { if (!REC.id && d.record) { REC.id = d.record.id; } dirty = false; setStatus("Saved ✓"); } else setStatus((d && d.error) || "Save failed"); })
        .catch(function () { setStatus("Save failed — will retry"); });
    }

    // ── signature pad ──
    function initSig(canvas, key) {
      var ctx = canvas.getContext("2d"), draw = false, drew = false, last = null;
      function resize() { var r = canvas.getBoundingClientRect(); canvas.width = r.width * 2; canvas.height = r.height * 2; ctx.scale(2, 2); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#12305a"; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); redrawFrom(); }
      function redrawFrom() { if (REC[key] && /^data:image/.test(REC[key])) { var img = new Image(); img.onload = function () { var r = canvas.getBoundingClientRect(); ctx.drawImage(img, 0, 0, r.width, r.height); }; img.src = REC[key]; drew = true; } }
      function pos(e) { var r = canvas.getBoundingClientRect(); var t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; }
      function start(e) { if (RO) return; e.preventDefault(); draw = true; last = pos(e); }
      function move(e) { if (!draw) return; e.preventDefault(); var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drew = true; }
      function end() { if (!draw) return; draw = false; if (drew) { try { REC[key] = canvas.toDataURL("image/jpeg", 0.7); } catch (e) {} queueSave(); } }
      canvas.addEventListener("mousedown", start); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
      canvas.addEventListener("touchstart", start, { passive: false }); canvas.addEventListener("touchmove", move, { passive: false }); canvas.addEventListener("touchend", end);
      sigPads[key] = { clear: function () { var r = canvas.getBoundingClientRect(); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); drew = false; REC[key] = ""; queueSave(); } };
      setTimeout(resize, 30); window.addEventListener("resize", function () { /* keep drawing; no auto-resize wipe */ });
    }

    // ── media upload ──
    // Photos are re-encoded on the phone to a ≤1600px JPEG before upload: smaller
    // uploads, and the PDF builder can embed JPEG directly (a 12-MP PNG or a HEIC
    // can't be embedded server-side). Always resolves — a stall/failure (iOS can
    // silently choke on a HEIC decode) falls back to the original file after 8s.
    function toJpeg(file) {
      return new Promise(function (resolve) {
        var done = false, finish = function (v) { if (!done) { done = true; resolve(v); } };
        try {
          if (!/^image\//.test(file.type || "") || /gif|svg/i.test(file.type || "")) return finish(file);
          var url = URL.createObjectURL(file), img = new Image();
          setTimeout(function () { finish(file); }, 8000);
          img.onload = function () {
            try {
              var MAX = 1600, s = Math.min(1, MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
              var w = Math.max(1, Math.round((img.naturalWidth || 1) * s)), h = Math.max(1, Math.round((img.naturalHeight || 1) * s));
              var c = document.createElement("canvas"); c.width = w; c.height = h;
              var cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); cx.drawImage(img, 0, 0, w, h);
              c.toBlob(function (b) { URL.revokeObjectURL(url); if (!b) return finish(file); finish(new File([b], (file.name || "photo").replace(/\.[a-z0-9]+$/i, "") + ".jpg", { type: "image/jpeg" })); }, "image/jpeg", 0.85);
            } catch (e) { finish(file); }
          };
          img.onerror = function () { URL.revokeObjectURL(url); finish(file); };
          img.src = url;
        } catch (e) { finish(file); }
      });
    }
    function uploadMedia(file, kind) {
      if (!REC.id) { // must have a saved record first
        return doSave().then(function () { return REC.id ? uploadMedia(file, kind) : null; });
      }
      if (kind === "photo" && !file.__jpeg) { return toJpeg(file).then(function (f) { try { f.__jpeg = true; } catch (e) {} return uploadMedia(f, kind); }); }
      var fd = new FormData(); fd.append("id", REC.id); fd.append("kind", kind); fd.append("file", file);
      var note = host.querySelector("#mlpUpNote"); if (note) note.textContent = "Uploading " + kind + "…";
      return af("/pump/media", { method: "POST", body: fd }).then(function (r) { return r.json(); })
        .then(function (d) { if (d && d.ok) { REC.media = REC.media || []; REC.media.push({ key: d.key, kind: d.kind, name: d.name, url: d.url }); drawMedia(); if (note) note.textContent = ""; } else if (note) note.textContent = (d && d.error) || "Upload failed"; })
        .catch(function () { if (note) note.textContent = "Upload failed"; });
    }
    function drawMedia() {
      var wrap = host.querySelector("#mlpMedia"); if (!wrap) return;
      wrap.innerHTML = (REC.media || []).map(function (m, i) {
        var inner = m.kind === "video" ? '<span class="vid">🎬</span>' : '<img src="' + esc(m.url || "") + '" alt="">';
        return '<div class="mtile" data-i="' + i + '">' + inner + (RO ? "" : '<button class="del" data-k="' + esc(m.key) + '">×</button>') + '</div>';
      }).join("") || '<div class="uploading" style="color:#94a3b8">No photos or videos yet.</div>';
      [].forEach.call(wrap.querySelectorAll(".del"), function (b) {
        b.onclick = function () {
          var key = b.dataset.k;
          af("/pump/media-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: REC.id, key: key }) }).then(function () { REC.media = (REC.media || []).filter(function (m) { return m.key !== key; }); drawMedia(); });
        };
      });
      [].forEach.call(wrap.querySelectorAll(".mtile img"), function (im) { im.onclick = function () { window.open(im.src, "_blank"); }; });
    }

    function ynGroup(cur, onPick) {
      var g = el("div", "yn");
      [["yes", "Yes"], ["no", "No"], ["na", "N/A"]].forEach(function (p) {
        var b = el("button", p[0] + (ans(cur) === p[0] ? " on" : ""), p[1]);
        if (RO) b.disabled = true;
        b.onclick = function () { if (RO) return; [].forEach.call(g.children, function (c) { c.classList.remove("on"); }); b.classList.add("on"); onPick(p[0]); };
        g.appendChild(b);
      });
      return g;
    }

    function render() {
      body.innerHTML = "";
      // instructions
      if (REC.instructions) {
        var ic = el("div", "card");
        ic.appendChild(el("h4", null, "📍 Location & method — " + esc(REC.storeName || "")));
        var lines = String(REC.instructions).split(/\n/).map(function (l) { return /^important/i.test(l.trim()) || /^[A-Z][a-z].*:$/.test(l.trim()) ? '<span class="imp">' + esc(l) + "</span>" : esc(l); }).join("\n");
        ic.appendChild(el("div", "instr", lines));
        body.appendChild(ic);
      }
      // safety pre-check
      var sc = el("div", "card safety"); sc.id = "mlpSafety";
      sc.appendChild(el("h4", null, "⚠️ Safety before starting"));
      (REC.safety || []).forEach(function (s) {
        var row = el("div", "row"); row.appendChild(el("div", "lab", esc(s.label)));
        row.appendChild(ynGroup(s.answer, function (v) { s.answer = v; refreshSafety(); queueSave(); }));
        sc.appendChild(row);
      });
      body.appendChild(sc);
      // checklist
      var cc = el("div", "card");
      cc.appendChild(el("h4", null, "🔧 Monthly maintenance checks"));
      (REC.checks || []).forEach(function (c) {
        var row = el("div", "row"); row.appendChild(el("div", "lab", esc(c.label)));
        row.appendChild(ynGroup(c.answer, function (v) { c.answer = v; queueSave(); }));
        cc.appendChild(row);
      });
      var dl = el("div"); dl.innerHTML = '<label class="flbl">Details of any check answered No</label><textarea id="mlpDetails" placeholder="Explain anything marked No…">' + esc(REC.detailsNo || "") + "</textarea>";
      cc.appendChild(dl); body.appendChild(cc);
      // media
      var mc = el("div", "card");
      mc.appendChild(el("h4", null, "📷 Photos & video of maintenance"));
      if (!RO) mc.innerHTML += '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn line" id="mlpAddPhoto" style="cursor:pointer">➕ Add photo</button><input type="file" accept="image/*" id="mlpPhoto" style="display:none"><label class="btn line" style="cursor:pointer">🎬 Add video<input type="file" accept="video/*" id="mlpVideo" style="display:none"></label></div><div class="uploading" style="margin-top:4px;color:#94a3b8">Keep videos short (max 95 MB).</div><div class="uploading" id="mlpUpNote" style="margin-top:2px"></div>';
      mc.innerHTML += '<div class="media" id="mlpMedia"></div>'; body.appendChild(mc);
      // declaration + signatures
      var dc = el("div", "card");
      dc.appendChild(el("h4", null, "✅ Declaration & sign-off"));
      var declText = "I confirm that all checks listed above have been carried out and that the sump pump and associated alarm system are in good working order, suitable for continued operation until the next scheduled monthly service.";
      var chk = el("label", "chk"); chk.innerHTML = '<input type="checkbox" id="mlpDecl" ' + (ans(REC.declarationAgreed) === "yes" ? "checked" : "") + (RO ? " disabled" : "") + '><span>' + esc(declText) + "</span>";
      dc.appendChild(chk);
      var dt = el("div"); dt.innerHTML = '<label class="flbl">Date</label><input type="date" id="mlpDate" value="' + esc(REC.date || "") + '"' + (RO ? " disabled" : "") + ">"; dc.appendChild(dt);
      var two = el("div", "two");
      two.innerHTML = '<div><label class="flbl">Engineer name</label><input type="text" id="mlpEngName" value="' + esc(REC.engineerName || "") + '"' + (RO ? " disabled" : "") + '></div>'
        + '<div><label class="flbl">Store manager (DM) name</label><input type="text" id="mlpDmName" value="' + esc(REC.dmName || "") + '"' + (RO ? " disabled" : "") + "></div>";
      dc.appendChild(two);
      var sigs = el("div", "two");
      sigs.innerHTML = '<div><label class="flbl">Engineer signature</label><canvas class="sigpad" id="mlpEngSig"></canvas><div class="sigrow"><span></span>' + (RO ? "" : '<a id="mlpEngClear">Clear</a>') + "</div></div>"
        + '<div><label class="flbl">Store manager signature</label><canvas class="sigpad" id="mlpDmSig"></canvas><div class="sigrow"><span></span>' + (RO ? "" : '<a id="mlpDmClear">Clear</a>') + "</div></div>";
      dc.appendChild(sigs); body.appendChild(dc);

      if (MODE === "engineer" && !opt.hideComplete) {
        var comp = el("div"); comp.innerHTML = '<div class="miss" id="mlpMiss" style="display:none"></div><button class="btn p" id="mlpSubmit">✅ Complete &amp; submit</button>';
        body.appendChild(comp);
      }
      if (RO) { var pv = el("div"); pv.innerHTML = '<button class="btn line" id="mlpPdf" style="width:100%">⬇ Open PDF</button>'; body.appendChild(pv); }

      wire();
      drawMedia(); refreshSafety();
    }

    function refreshSafety() {
      var sEl = host.querySelector("#mlpSafety"); if (!sEl) return;
      var allYes = (REC.safety || []).every(function (s) { return ans(s.answer) === "yes"; });
      sEl.classList.toggle("bad", !allYes && (REC.safety || []).some(function (s) { return ans(s.answer) && ans(s.answer) !== "yes"; }));
    }

    function wire() {
      var d = host.querySelector("#mlpDetails"); if (d) d.oninput = function () { REC.detailsNo = d.value; queueSave(); };
      var decl = host.querySelector("#mlpDecl"); if (decl) decl.onchange = function () { REC.declarationAgreed = decl.checked ? "yes" : ""; queueSave(); };
      var dt = host.querySelector("#mlpDate"); if (dt) dt.onchange = function () { REC.date = dt.value; queueSave(); };
      var en = host.querySelector("#mlpEngName"); if (en) en.oninput = function () { REC.engineerName = en.value; queueSave(); };
      var dn = host.querySelector("#mlpDmName"); if (dn) dn.oninput = function () { REC.dmName = dn.value; queueSave(); };
      var ph = host.querySelector("#mlpPhoto"); if (ph) ph.onchange = function () { if (ph.files[0]) uploadMedia(ph.files[0], "photo"); ph.value = ""; };
      var pab = host.querySelector("#mlpAddPhoto"); if (pab && ph) pab.onclick = function () { if (window.MLPhotoInput) window.MLPhotoInput(ph); else { ph.removeAttribute("capture"); ph.click(); } };
      var vd = host.querySelector("#mlpVideo"); if (vd) vd.onchange = function () { if (vd.files[0]) uploadMedia(vd.files[0], "video"); vd.value = ""; };
      var es = host.querySelector("#mlpEngSig"); if (es) initSig(es, "engSig");
      var ds = host.querySelector("#mlpDmSig"); if (ds) initSig(ds, "dmSig");
      var ec = host.querySelector("#mlpEngClear"); if (ec) ec.onclick = function () { sigPads.engSig && sigPads.engSig.clear(); };
      var dc2 = host.querySelector("#mlpDmClear"); if (dc2) dc2.onclick = function () { sigPads.dmSig && sigPads.dmSig.clear(); };
      var pdf = host.querySelector("#mlpPdf"); if (pdf) pdf.onclick = function () { af("/pump/pdf?id=" + encodeURIComponent(REC.id || opt.recordId || "")).then(function (r) { return r.blob(); }).then(function (b) { window.open(URL.createObjectURL(b), "_blank"); }); };
      var sub = host.querySelector("#mlpSubmit"); if (sub) sub.onclick = submit;
    }

    function validate() {
      var m = [];
      if ((REC.safety || []).some(function (s) { return ans(s.answer) !== "yes"; })) m.push("confirm both safety checks (Yes)");
      if ((REC.checks || []).some(function (c) { return !ans(c.answer); })) m.push("answer every check");
      if ((REC.checks || []).some(function (c) { return ans(c.answer) === "no"; }) && !String(REC.detailsNo || "").trim()) m.push("add details for any check answered No");
      if (ans(REC.declarationAgreed) !== "yes") m.push("tick the declaration");
      if (!String(REC.date || "").trim()) m.push("the date");
      if (!String(REC.engineerName || "").trim()) m.push("engineer name");
      if (!REC.engSig) m.push("engineer signature");
      if (!String(REC.dmName || "").trim()) m.push("store manager name");
      if (!REC.dmSig) m.push("store manager signature");
      return m;
    }
    function submit() {
      var miss = validate(), mEl = host.querySelector("#mlpMiss");
      if (miss.length) { if (mEl) { mEl.style.display = "block"; mEl.textContent = "Still needs: " + miss.join(", ") + "."; mEl.scrollIntoView({ behavior: "smooth", block: "center" }); } return; }
      if (mEl) mEl.style.display = "none";
      var sub = host.querySelector("#mlpSubmit"); if (sub) { sub.disabled = true; sub.textContent = "Submitting…"; }
      doSave().then(function () {
        return af("/pump/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: REC.id }) }).then(function (r) { return r.json(); });
      }).then(function (d) {
        if (d && d.ok) {
          var p = opt.patchComplete ? opt.patchComplete() : Promise.resolve();
          Promise.resolve(p).then(function () { if (opt.onComplete) opt.onComplete(); });
        } else { if (sub) { sub.disabled = false; sub.textContent = "✅ Complete & submit"; } setStatus((d && d.error) || "Submit failed"); }
      }).catch(function () { if (sub) { sub.disabled = false; sub.textContent = "✅ Complete & submit"; } setStatus("Submit failed"); });
    }

    return { flush: doSave, get record() { return REC; } };
  }

  window.MLPump = { mount: mount };
})();
