/* Mostlane — shared in-app document viewer.
 *
 *   MLDocViewer.open({ url, fetchUrl, name, downloadUrl });
 *
 * Fixes the mobile problem where PDFs shown in an <iframe>/<object> won't
 * scroll (mobile browsers don't render PDFs inline). PDFs are drawn with
 * PDF.js into a scrollable column of pages — fit-to-WIDTH by default (so the
 * whole page width is visible) with zoom in/out, working identically on mobile
 * and desktop. Images get the same fit-width + zoom + scroll treatment.
 *
 * - url        : the file's normal URL (used for <img>, download, and the
 *                "open full screen" fallback / native viewer).
 * - fetchUrl   : optional CORS-enabled URL PDF.js should fetch from (defaults
 *                to url). Site docs pass the /sla/site/doc?key= route.
 * - name       : filename (used to detect the type and as the title).
 * - downloadUrl: optional; defaults to url.
 *
 * If PDF.js can't fetch the file (e.g. the source has no CORS headers), it
 * falls back to a big "Open document" button that uses the device's native
 * full-screen viewer — which scrolls and zooms fine on every phone.
 */
(function () {
  "use strict";
  if (window.MLDocViewer) return;

  // unpkg legacy build — same CDN the portal already loads Leaflet from, and the
  // legacy build works on older office browsers too.
  var PDFJS_BASE = "https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/";
  var pdfjsReady = null;

  function loadPdfjs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise(function (resolve, reject) {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);
      var s = document.createElement("script");
      s.src = PDFJS_BASE + "pdf.min.js";
      s.onload = function () {
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.js";
          resolve(window.pdfjsLib);
        } catch (e) { reject(e); }
      };
      s.onerror = function () { reject(new Error("pdfjs load failed")); };
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }

  var CSS = ''
    + '.mldv-back{position:fixed;inset:0;background:#1e293b;display:none;flex-direction:column;z-index:100001;}'
    + '.mldv-back.show{display:flex;}'
    + '.mldv-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#0f172a;color:#fff;flex-wrap:wrap;}'
    + '.mldv-title{flex:1;min-width:80px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.mldv-bar button,.mldv-bar a{appearance:none;border:1px solid #334155;background:#1e293b;color:#e2e8f0;border-radius:8px;padding:7px 11px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:5px;line-height:1;font-family:inherit;}'
    + '.mldv-bar button:active{background:#334155;}'
    + '.mldv-zoom{font-variant-numeric:tabular-nums;min-width:44px;text-align:center;font-size:13px;color:#cbd5e1;}'
    + '.mldv-body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;background:#334155;padding:12px;text-align:center;}'
    + '.mldv-page{display:block;margin:0 auto 12px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.4);overflow:hidden;}'
    + '.mldv-img{display:block;margin:0 auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.4);}'
    + '.mldv-msg{color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;max-width:420px;margin:40px auto;text-align:center;font-size:15px;line-height:1.5;}'
    + '.mldv-msg .big{display:inline-block;margin-top:14px;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:13px 22px;font-size:16px;font-weight:600;text-decoration:none;}'
    + '.mldv-spin{color:#cbd5e1;font-family:system-ui,sans-serif;margin:40px auto;text-align:center;}';

  var el = {};
  function build() {
    if (el.back) return;
    var style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
    var back = document.createElement("div"); back.className = "mldv-back";
    back.innerHTML = ''
      + '<div class="mldv-bar">'
      + '  <span class="mldv-title" id="mldvTitle"></span>'
      + '  <button id="mldvOut" title="Zoom out" style="display:none;">–</button>'
      + '  <span class="mldv-zoom" id="mldvZoom" style="display:none;"></span>'
      + '  <button id="mldvIn" title="Zoom in" style="display:none;">+</button>'
      + '  <button id="mldvFit" title="Fit width" style="display:none;">Fit</button>'
      + '  <a id="mldvFull" title="Open full screen" target="_blank" rel="noopener">⤢</a>'
      + '  <a id="mldvDl" title="Download" download>⬇</a>'
      + '  <button id="mldvClose" title="Close">✕</button>'
      + '</div>'
      + '<div class="mldv-body" id="mldvBody"></div>';
    document.body.appendChild(back);
    el.back = back;
    ["mldvTitle","mldvOut","mldvIn","mldvFit","mldvZoom","mldvFull","mldvDl","mldvClose","mldvBody"].forEach(function (id) { el[id] = document.getElementById(id); });
    el.mldvClose.addEventListener("click", close);
    el.mldvOut.addEventListener("click", function () { setZoom(zoom / 1.25); });
    el.mldvIn.addEventListener("click", function () { setZoom(zoom * 1.25); });
    el.mldvFit.addEventListener("click", function () { setZoom(1); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && el.back.classList.contains("show")) close(); });
  }

  var current = null, zoom = 1, pdfDoc = null, renderToken = 0;

  function close() {
    if (el.back) el.back.classList.remove("show");
    el.mldvBody && (el.mldvBody.innerHTML = "");
    if (pdfIO) { try { pdfIO.disconnect(); } catch (e) {} pdfIO = null; }
    pageInfos = [];
    if (pdfDoc) { try { pdfDoc.destroy(); } catch (e) {} pdfDoc = null; }
    current = null; renderToken++;
  }

  function setZoom(z) {
    zoom = Math.max(0.4, Math.min(6, z));
    el.mldvZoom.textContent = Math.round(zoom * 100) + "%";
    if (!current) return;
    if (current.kind === "pdf") layoutPdf();
    else if (current.kind === "img") applyImgZoom();
  }
  function showZoomControls(on) {
    ["mldvOut","mldvIn","mldvFit","mldvZoom"].forEach(function (k) { el[k].style.display = on ? "" : "none"; });
  }

  function ext(name, url) {
    var s = (name || url || "").split("?")[0].split("#")[0];
    var m = /\.([a-z0-9]+)$/i.exec(s);
    return m ? m[1].toLowerCase() : "";
  }

  function open(opts) {
    build();
    opts = opts || {};
    var name = opts.name || "Document";
    var url = opts.url || opts.fetchUrl || "";
    var fetchUrl = opts.fetchUrl || url;
    var e = ext(name, url);
    current = { kind: null, url: url, fetchUrl: fetchUrl, name: name };
    zoom = 1;
    el.mldvTitle.textContent = name;
    el.mldvFull.href = url;
    el.mldvDl.href = opts.downloadUrl || url;
    el.mldvBody.innerHTML = '<div class="mldv-spin">Loading…</div>';
    el.back.classList.add("show");

    if (["png","jpg","jpeg","gif","webp","bmp","svg"].indexOf(e) >= 0) {
      current.kind = "img"; showZoomControls(true); renderImg();
    } else if (e === "pdf") {
      current.kind = "pdf"; showZoomControls(true); openPdf();
    } else {
      showZoomControls(false); showFallback("This file type can't be previewed here.");
    }
  }

  /* ---- image ---- */
  function renderImg() {
    var img = document.createElement("img");
    img.className = "mldv-img"; img.alt = current.name;
    img.onload = function () { el.mldvZoom.textContent = "100%"; };
    img.onerror = function () { showFallback("Couldn't load this image here."); };
    img.src = current.url;
    el.mldvBody.innerHTML = ""; el.mldvBody.appendChild(img);
    current.imgEl = img; applyImgZoom();
  }
  function applyImgZoom() {
    if (!current || !current.imgEl) return;
    // Fit width at zoom 1; grow beyond container (scroll) when zoomed in.
    current.imgEl.style.width = Math.round(zoom * 100) + "%";
    current.imgEl.style.maxWidth = zoom <= 1 ? "100%" : "none";
    current.imgEl.style.height = "auto";
    el.mldvZoom.textContent = Math.round(zoom * 100) + "%";
  }

  /* ---- pdf ----
     Pages are laid out as sized placeholders and only rasterised when they
     scroll near the viewport (IntersectionObserver), so a big document doesn't
     blow up memory. Each page is rendered ABOVE its display size (device pixel
     ratio × a supersample factor) so text stays crisp when pinch-zoomed, and
     the −/Fit/+ buttons re-rasterise for pin-sharp text at any zoom. */
  var pageInfos = [], pdfIO = null;
  var SUPERSAMPLE = 2;   // extra resolution for pinch-zoom headroom
  var MAX_CANVAS_W = 3000;

  function openPdf() {
    loadPdfjs().then(function (pdfjsLib) {
      // Plain GET (no custom headers) so there's no CORS preflight — the site
      // route is public+CORS and the projects route authenticates by query.
      return pdfjsLib.getDocument({ url: current.fetchUrl, withCredentials: false }).promise;
    }).then(function (pdf) {
      pdfDoc = pdf;
      var maxPages = Math.min(pdf.numPages, 200);
      var jobs = [];
      for (var n = 1; n <= maxPages; n++) jobs.push(pdf.getPage(n));
      return Promise.all(jobs).then(function (pages) {
        pageInfos = pages.map(function (page) {
          var vp = page.getViewport({ scale: 1 });
          return { page: page, w: vp.width, h: vp.height };
        });
        layoutPdf();
      });
    }).catch(function () {
      // CORS / network / load failure — offer the native full-screen viewer.
      showFallback("This document opens best full screen on this device.");
    });
  }

  function layoutPdf() {
    if (!pdfDoc || !current || current.kind !== "pdf") return;
    var body = el.mldvBody;
    if (pdfIO) { pdfIO.disconnect(); pdfIO = null; }
    body.innerHTML = "";
    el.mldvZoom.textContent = Math.round(zoom * 100) + "%";
    var innerWidth = Math.max(120, body.clientWidth - 24);
    var dispW = innerWidth * zoom;
    var placeholders = [];
    pageInfos.forEach(function (pi) {
      var ph = document.createElement("div");
      ph.className = "mldv-page";
      ph.style.width = Math.floor(dispW) + "px";
      ph.style.height = Math.floor(dispW * (pi.h / pi.w)) + "px";
      ph._pi = pi; ph._dispW = dispW; ph._done = false;
      body.appendChild(ph);
      placeholders.push(ph);
    });
    pdfIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) renderPage(e.target); });
    }, { root: body, rootMargin: "400px 0px" });
    placeholders.forEach(function (ph) { pdfIO.observe(ph); });
  }

  function renderPage(ph) {
    if (ph._done) return; ph._done = true;
    var pi = ph._pi, dispW = ph._dispW;
    var dpr = window.devicePixelRatio || 1;
    var scale = (dispW / pi.w) * dpr * SUPERSAMPLE;
    if (pi.w * scale > MAX_CANVAS_W) scale = MAX_CANVAS_W / pi.w;   // cap memory
    var vp = pi.page.getViewport({ scale: scale });
    var canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    var ctx = canvas.getContext("2d");
    pi.page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
      ph.innerHTML = ""; ph.appendChild(canvas);   // browser downscales high-res canvas -> crisp
    }).catch(function () { ph._done = false; });
  }

  function showFallback(msg) {
    showZoomControls(false);
    el.mldvBody.innerHTML = '<div class="mldv-msg">' + msg
      + '<br><a class="big" href="' + encodeURI(current.url) + '" target="_blank" rel="noopener">📄 Open document</a></div>';
  }

  // Re-fit PDFs when the viewport width changes (rotation / resize).
  var rt;
  window.addEventListener("resize", function () {
    if (!current || current.kind !== "pdf" || !el.back.classList.contains("show")) return;
    clearTimeout(rt); rt = setTimeout(layoutPdf, 200);
  });

  window.MLDocViewer = { open: open };
})();
