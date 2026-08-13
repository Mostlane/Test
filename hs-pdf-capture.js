// Shared client-side capture: rasterise a rendered document element into
// PORTRAIT A4 page images (colour-faithful — it's a screenshot of the DOM), to
// be posted to the worker which wraps them into a PDF with a ref + page footer.
//
// Pagination is CONTENT-AWARE: instead of slicing the tall canvas at fixed
// heights (which cut table rows / sections in half), we measure the safe break
// lines in the DOM (the top & bottom of every row and block) and end each page
// at the last safe line that still fits — so nothing is cut mid-row. Each page
// image is padded to the full A4 content aspect so the worker's footer sits in
// the reserved strip and the placement never distorts.
//   window.HSCaptureDoc(el) -> Promise<string[]>   (data:image/jpeg;base64 pages)
(function () {
  const PAGE_H = 842, PAGE_W = 595, FOOTER = 22, CONTENT_H = PAGE_H - FOOTER;
  function waitImgs(el) {
    const imgs = [...el.querySelectorAll("img")];
    return Promise.all(imgs.map(im => im.complete ? Promise.resolve() : new Promise(res => { im.onload = im.onerror = res; })));
  }
  // Safe break lines (DOM px from the element top): the top & bottom edge of
  // every row/block — cutting on one of these never splits a row or heading.
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
    const domH = el.scrollHeight;
    const breaksDom = breakLines(el);
    const canvas = await window.html2canvas(el, { useCORS: true, backgroundColor: "#ffffff", scale: 2, logging: false });
    const cw = canvas.width, H = canvas.height;
    const scaleY = H / domH;
    const breaks = [...breaksDom].filter(y => y >= 0 && y <= domH).map(y => Math.round(y * scaleY)).sort((a, b) => a - b);
    const maxPageH = Math.max(1, Math.round(cw * (CONTENT_H / PAGE_W)));   // A4 content px per page (aspect-locked)
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
