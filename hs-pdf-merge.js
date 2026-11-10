// Append the PDF attachments of a Risk Assessment to its produced PDF, so the
// download carries the real pages of each attached PDF (e.g. an SMSTS
// certificate), not just its name in the appendix. Images are already drawn
// in the appendix itself, so only PDFs are appended here.
// window.HSMergeAttachments(blob, attachments) -> Promise<Blob>
// Fails soft: if pdf-lib can't load or a file can't be read, the original PDF
// is returned (with `blob.mergeErrors` listing what was left out).
(function () {
  const LIB = "/pdf-lib.min.js?v=1";   // pdf-lib 1.17.1, self-hosted (MIT)
  let loading = null;
  function loadLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = LIB; s.async = true;
      s.onload = () => window.PDFLib ? res(window.PDFLib) : rej(new Error("pdf-lib missing"));
      s.onerror = () => { loading = null; rej(new Error("Couldn't load the PDF tool")); };
      document.head.appendChild(s);
    });
    return loading;
  }
  const isPdf = a => /pdf/i.test(a && a.type || "") || /\.pdf$/i.test(a && a.name || "");

  window.HSMergeAttachments = async function (blob, attachments) {
    const pdfs = (attachments || []).filter(a => a && a.url && isPdf(a));
    if (!pdfs.length) return blob;
    const errors = [];
    try {
      const { PDFDocument } = await loadLib();
      const out = await PDFDocument.load(await blob.arrayBuffer());
      for (const a of pdfs) {
        try {
          const r = await fetch(a.url);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const src = await PDFDocument.load(await r.arrayBuffer(), { ignoreEncryption: true });
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach(p => out.addPage(p));
        } catch (e) { errors.push((a.name || "file") + " (" + (e && e.message || "unreadable") + ")"); }
      }
      const merged = new Blob([await out.save()], { type: "application/pdf" });
      merged.mergeErrors = errors;
      return merged;
    } catch (e) {
      blob.mergeErrors = pdfs.map(a => a.name || "file");
      return blob;
    }
  };
})();
