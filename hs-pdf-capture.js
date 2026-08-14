// Shared client-side capture: rasterise a rendered document element into
// PORTRAIT A4 page images (colour-faithful — it's a screenshot of the DOM), to
// be posted to the worker which wraps them into a PDF with a ref + page footer.
//
//  • Content-aware pagination: pages end at a safe break line (the top/bottom of
//    a row or block), so table rows and sections are never cut in half.
//  • A clear zone is kept at the top and bottom of every page (the worker insets
//    the image with margins) so nothing sits hard against the edge.
//  • Attachment images are capped to one page's height before capture, so a tall
//    photo fits on its own page instead of being split across pages.
//
//   window.HSCaptureDoc(el) -> Promise<string[]>   (data:image/jpeg;base64 pages)
//
// The CONTENT box below MUST match the worker's buildRaPdf placement.
(function () {
  const PAGE_W = 595, PAGE_H = 842, MARGIN_TOP = 28, MARGIN_BOT = 30, CONTENT_H = PAGE_H - MARGIN_TOP - MARGIN_BOT;
  function waitImgs(el) {
    const imgs = [...el.querySelectorAll("img")];
    return Promise.all(imgs.map(im => im.complete ? Promise.resolve() : new Promise(res => { im.onload = im.onerror = res; })));
  }
  function breakLines(el) {
    const top0 = el.getBoundingClientRect().top;
    const set = new Set([0]);
    el.querySelectorAll("tr,h2,h3,p,table,ul,li,figure,.kv,.sub,.foot").forEach(c => {
      const r = c.getBoundingClientRect();
      set.add(Math.round(r.top - top0));
      set.add(Math.round(r.bottom - top0));
    });
    return set;
  }
  window.HSCaptureDoc = async function (el) {
    if (!window.html2canvas || !el) throw new Error("Capture unavailable");
    await waitImgs(el);
    // Cap attachment images so each fits within one page's content area (never
    // split across pages). Applied before measuring/capturing; restored after.
    const rectW = el.getBoundingClientRect().width || el.clientWidth || PAGE_W;
    const onePageDomH = Math.floor(rectW * (CONTENT_H / PAGE_W) * 0.94);
    const atts = [...el.querySelectorAll(".ml-att-img")];
    const saved = atts.map(a => a.style.maxHeight);
    atts.forEach(a => { a.style.maxHeight = onePageDomH + "px"; });
    void el.offsetHeight;   // force reflow so break lines reflect the capped sizes

    const domH = el.scrollHeight;
    const breaksDom = breakLines(el);
    let canvas;
    try {
      canvas = await window.html2canvas(el, { useCORS: true, backgroundColor: "#ffffff", scale: 2, logging: false });
    } finally {
      atts.forEach((a, i) => { a.style.maxHeight = saved[i]; });
    }
    const cw = canvas.width, H = canvas.height;
    const scaleY = H / domH;
    const breaks = [...breaksDom].filter(y => y >= 0 && y <= domH).map(y => Math.round(y * scaleY)).sort((a, b) => a - b);
    const maxPageH = Math.max(1, Math.round(cw * (CONTENT_H / PAGE_W)));   // A4 content px per page (aspect-locked to the worker box)
    const pages = [];
    let start = 0, guard = 0;
    while (start < H && guard++ < 400) {
      const limit = start + maxPageH;
      let end;
      if (limit >= H) end = H;
      else {
        end = -1;
        for (const b of breaks) { if (b > start && b <= limit) end = b; }   // largest safe line that fits
        if (end < 0) end = limit;   // a single element taller than a page — must hard-cut
      }
      const h = Math.min(end - start, maxPageH);
      const pc = document.createElement("canvas"); pc.width = cw; pc.height = maxPageH;
      const cx = pc.getContext("2d"); cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, cw, maxPageH);
      cx.drawImage(canvas, 0, start, cw, h, 0, 0, cw, h);
      pages.push(pc.toDataURL("image/jpeg", 0.82));
      start = end;
    }
    return pages;
  };
})();
