// One store's Southern Co-op compliance pack as a .zip — the same layout as the
// full pack (compliance-pack.html) but for a single site:
//
//   <code> - <store name>/<type folder>/<current certificate(s)>
//   <code> - <store name>/Compliance tracker.xlsx
//
// Open to everyone who can see the chart (client logins included): the server
// (GET /compliance/export?scheme=coop&code=) decides WHICH files — the current
// certificate per type plus anything ticked "include in pack" — so nothing a
// client shouldn't see can be reached from here.
//
//   MLSitePack.download(code, authFetch, onStatus?)  → Promise<{files, failed}>
// Needs ml-xlsx.js (window.MLXlsx) for the tracker sheet.
(function () {
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  // STORED zip (PDFs are already compressed), UTF-8 names, folder entries kept so
  // a type with no certificate still shows as an (empty) folder, like the pack.
  function zip(entries) {                         // [{name, data?:Uint8Array, dir?:true}]
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = []; let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.dir ? e.name.replace(/\/?$/, "/") : e.name);
      const data = e.dir ? new Uint8Array(0) : e.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, e.dir ? 0x10 : 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const csize = central.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: "application/zip" });
  }

  function safeName(s, fb) {
    const t = String(s == null ? "" : s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
    return (t || fb || "file").slice(0, 150);
  }
  // Same naming as the full pack: the office's label (sub-folder stripped) + the
  // original extension, else the original filename.
  function outName(f) {
    const ext = (String(f.filename || "").match(/\.[a-z0-9]{2,5}$/i) || [".pdf"])[0];
    let lab = String(f.label || "").split(" / ").pop().trim();
    if (lab) { lab = lab.replace(/\.[a-z0-9]{2,5}$/i, ""); return safeName(lab, "document") + ext; }
    const n = safeName(f.filename, "document" + ext);
    return /\.[a-z0-9]{2,5}$/i.test(n) ? n : n + ext;
  }
  const ukDate = (iso) => { const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ""); };

  async function download(code, authFetch, onStatus) {
    const say = (t) => { try { onStatus && onStatus(t); } catch (e) {} };
    say("Getting the store's certificates…");
    const r = await authFetch("/compliance/export?scheme=coop&code=" + encodeURIComponent(code));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    const st = (j.stores || [])[0];
    if (!st) throw new Error("That store isn't on the live chart");
    const TYPES = j.types || [];

    // folder → files: every required type (empty = missing) + extras ticked "in pack"
    const plan = [];
    TYPES.forEach((t) => { const x = st.types[t.key]; if (x && (x.required || x.hasExtras)) plan.push({ folder: t.folder, key: t.key, files: x.files.slice() }); });
    (st.extras || []).forEach((e) => {
      let p = plan.find((q) => q.folder === e.folder);
      if (!p) { p = { folder: e.folder, key: e.typeKey, files: [], extra: true }; plan.push(p); }
      p.files.push(Object.assign({ _extra: true }, e.file));
    });

    const root = st.folder;
    const entries = [{ name: root, dir: true }];
    const jobs = [];
    plan.forEach((p) => {
      entries.push({ name: root + "/" + p.folder, dir: true });
      const used = {};
      p.files.forEach((f) => {
        let n = outName(f); const base = n; let k = 2;
        while (used[n.toLowerCase()]) n = base.replace(/(\.[^.]+)$/, " (" + k++ + ")$1");
        used[n.toLowerCase()] = 1;
        jobs.push({ p, f, path: root + "/" + p.folder + "/" + n });
      });
    });

    const failed = {};
    let done = 0;
    const got = new Array(jobs.length);
    async function lane() {
      for (;;) {
        const i = done++; if (i >= jobs.length) return;
        const jb = jobs[i];
        say(`Downloading ${Math.min(i + 1, jobs.length)} of ${jobs.length}…`);
        try {
          const res = await fetch(jb.f.url);
          if (!res.ok) throw new Error("HTTP " + res.status);
          got[i] = new Uint8Array(await res.arrayBuffer());
        } catch (e) { failed[jb.p.key] = (failed[jb.p.key] || 0) + 1; }
      }
    }
    await Promise.all([lane(), lane(), lane()]);
    jobs.forEach((jb, i) => { if (got[i]) entries.push({ name: jb.path, data: got[i] }); });

    // Tracker sheet for this one store
    if (window.MLXlsx && MLXlsx.build) {
      const rows = [
        [{ v: `${st.code} - ${st.name}`, bold: true }],
        ["Store type", st.group], ["Postcode", st.postcode || ""], ["Pack made", ukDate(new Date().toISOString())], [],
        [{ v: "Compliance", bold: true }, { v: "Status", bold: true }, { v: "Certificate date", bold: true }, { v: "Next due", bold: true }, { v: "Files", bold: true }],
      ];
      TYPES.forEach((t) => {
        const x = st.types[t.key]; if (!x) return;
        let s = x.status;
        if (failed[t.key] && (s === "Present" || s === "Overdue")) s = "Missing (download failed)";
        if (x.linked && s !== "Not required") s += ` (${x.files.length} linked)`;
        rows.push([t.folder, s, x.files.map((f) => ukDate(f.date) || "undated").join(" + "), ukDate(x.due), x.files.map(outName).join("; ")]);
      });
      if ((st.extras || []).length) {
        rows.push([], [{ v: "Also included", bold: true }, { v: "Folder", bold: true }]);
        st.extras.forEach((e) => rows.push([outName(e.file), e.folder]));
      }
      if ((st.flags || []).length) { rows.push([], [{ v: "Notes", bold: true }]); st.flags.forEach((f) => rows.push([f])); }
      rows.push([], ["Present = latest certificate included and in date. Overdue = included but its next due date has passed. Missing = needed but no certificate on file. Not required = the store doesn't have that system."]);
      entries.push({ name: root + "/Compliance tracker.xlsx", data: MLXlsx.build([{ name: "Tracker", rows }]) });
    }

    say("Making the zip…");
    const blob = zip(entries);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = root + ".zip";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 8000);
    const nFailed = Object.values(failed).reduce((a, b) => a + b, 0);
    return { files: jobs.length - nFailed, failed: nFailed, missing: TYPES.filter((t) => st.types[t.key] && st.types[t.key].status === "Missing").map((t) => t.folder) };
  }

  window.MLSitePack = { download, _zip: zip };
})();
