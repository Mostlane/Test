// Shared client-side capture: rasterise a rendered document element into
// PORTRAIT A4 page images (colour-faithful — it's a screenshot of the DOM), to
// be posted to the worker which wraps them into a PDF with a ref + page footer.
// The page images are sliced to the A4 CONTENT area (page minus the footer
// strip) so the worker's footer never sits over the content.
//   window.HSCaptureDoc(el) -> Promise<string[]>   (data:image/jpeg;base64 pages)
(function () {
  const PAGE_H = 842, PAGE_W = 595, FOOTER = 22, CONTENT_H = PAGE_H - FOOTER;
  function waitImgs(el) {
    const imgs = [...el.querySelectorAll("img")];
    return Promise.all(imgs.map(im => im.complete ? Promise.resolve() : new Promise(res => { im.onload = im.onerror = res; })));
  }
  window.HSCaptureDoc = async function (el) {
    if (!window.html2canvas || !el) throw new Error("Capture unavailable");
    await waitImgs(el);
    const canvas = await window.html2canvas(el, { useCORS: true, backgroundColor: "#ffffff", scale: 2, logging: false });
    const cw = canvas.width;
    const pageH = Math.max(1, Math.round(cw * (CONTENT_H / PAGE_W)));   // portrait A4 content aspect
    const pages = [];
    for (let y = 0; y < canvas.height; y += pageH) {
      const h = Math.min(pageH, canvas.height - y);
      const pc = document.createElement("canvas"); pc.width = cw; pc.height = pageH;
      const cx = pc.getContext("2d"); cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, cw, pageH);
      cx.drawImage(canvas, 0, y, cw, h, 0, 0, cw, h);
      pages.push(pc.toDataURL("image/jpeg", 0.82));
    }
    return pages;
  };
})();
