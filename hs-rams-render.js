// Shared Risk Assessment (RAMS) document renderer.
// ---------------------------------------------------------------------------
// ONE source of truth for the printable RA document, used by BOTH the builder
// (hs-docs.html) and the remote signing page (hs-sign.html) so they never drift.
// Depends on window.HS_RAMS (hs-rams-library.js) for the risk maths/keys.
//
//   window.HSRamsRender(doc) -> HTML string
//
// doc = { ref, created_at, created_by, data, attachments:[{key,name,type,url}],
//         signRequests:[{name,status,signedAt,signature}] }
// The Mostlane logo is embedded at the top; images among the attachments print
// as appendix pages; other files are listed as links; and any remotely-signed
// sign-off requests fold into the Operative sign-off section.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));
  const fmtDate = s => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString("en-GB"); };
  const sigImg = s => s ? `<img src="${s}" alt="signature" style="max-height:70px;border-bottom:1px solid #333;">` : `<span style="color:#889;">(not signed)</span>`;
  const bandCol = b => b === "High" ? "#b00020" : b === "Medium" ? "#b26b00" : "#0a7d33";
  const bandBg = b => b === "High" ? "#fdecea" : b === "Medium" ? "#fff6e5" : "#e6f6ec";

  window.HSRamsRender = function (doc) {
    const HS = window.HS_RAMS;
    const x = doc.data || {};
    const hz = x.hazards || [];
    const atts = doc.attachments || [];
    const signed = (doc.signRequests || []).filter(s => s.status === "signed");
    const rank = { Low:0, Medium:1, High:2 };
    const worst = hz.reduce((w,h) => { const b = HS.band(h.sevWith, h.likWith); return rank[b] > rank[w] ? b : w; }, "Low");
    const td = 'style="padding:6px;border:1px solid #ccc;font-size:12.5px;vertical-align:top;"';
    const tdc = 'style="padding:6px;border:1px solid #ccc;font-size:12.5px;text-align:center;"';
    const solidBg = b => b === "High" ? "#c62828" : b === "Medium" ? "#f0a000" : "#2e7d32";
    const solidFg = b => b === "Medium" ? "#3a2b00" : "#ffffff";
    const rateCell = (s,l) => { const b = HS.band(s,l); return `<td style="padding:6px;border:1px solid #fff;font-size:12.5px;text-align:center;background:${solidBg(b)};color:${solidFg(b)};font-weight:800;">${b} (${(s||0)*(l||0)})</td>`; };
    const numCell = (n,b) => `<td style="padding:6px;border:1px solid #fff;font-size:12.5px;text-align:center;background:${bandBg(b)};font-weight:700;">${esc(n)}</td>`;
    const summaryRows = hz.map(h => {
      const bW = HS.band(h.sevWithout, h.likWithout), bC = HS.band(h.sevWith, h.likWith);
      return `
      <tr>
        <td ${td}>${esc(h.name||"")}</td><td ${td}>${esc(h.persons||"")}</td>
        ${numCell(h.sevWithout,bW)}${numCell(h.likWithout,bW)}${rateCell(h.sevWithout,h.likWithout)}
        ${numCell(h.sevWith,bC)}${numCell(h.likWith,bC)}${rateCell(h.sevWith,h.likWith)}
      </tr>`;
    }).join("") || `<tr><td ${td} colspan="8">No hazards recorded.</td></tr>`;
    const mCell = (s,l) => { const b = HS.band(s,l); return `<td style="text-align:center;padding:8px 11px;border:1px solid #fff;background:${solidBg(b)};color:${solidFg(b)};font-weight:700;">${s*l}</td>`; };
    const riskMatrix = `
      <table style="border-collapse:collapse;margin-top:4px;">
        <tr><td style="border:none;"></td><td colspan="5" style="text-align:center;font-weight:700;font-size:11px;padding:2px;border:none;">Severity &rarr;</td></tr>
        <tr><td style="border:none;"></td>${[1,2,3,4,5].map(s=>`<td style="text-align:center;font-weight:700;background:#eef2f7;border:1px solid #fff;padding:6px 11px;">${s}</td>`).join("")}</tr>
        ${[5,4,3,2,1].map(l=>`<tr><td style="text-align:center;font-weight:700;background:#eef2f7;border:1px solid #fff;padding:6px 11px;">${l}</td>${[1,2,3,4,5].map(s=>mCell(s,l)).join("")}</tr>`).join("")}
      </table>
      <p style="font-size:11px;margin:2px 0 0;">Likelihood &darr; (rows) &middot; Severity &rarr; (columns) &middot; number shown = risk rating</p>`;
    const lvlLabel = id => (HS.levels.find(l => l.id === id) || { label:"" }).label;
    const controlRows = hz.flatMap(h => (h.controls||[]).slice().sort((a,b) => (HS.levelRank[a && a.level]??3) - (HS.levelRank[b && b.level]??3)).map(c => {
      const txt = typeof c === "string" ? c : (c.text||"");
      const lvl = typeof c === "string" ? "" : lvlLabel(c.level);
      return `<tr><td ${td}>${esc(h.name||"")}</td><td ${tdc}>${esc(lvl)}</td><td ${td}>${esc(txt)}</td></tr>`;
    })).join("") || `<tr><td ${td} colspan="3">No control measures.</td></tr>`;

    // Operative sign-off = manually-added acks + anyone who signed remotely.
    const ackItems = (x.acks || []).map(a => ({ name: a.name || "", signature: a.signature, when: "" }))
      .concat(signed.map(s => ({ name: s.name || s.username || "", signature: s.signature, when: s.signedAt })));
    const acks = ackItems.map(a => `<div style="display:inline-block;width:48%;margin:6px 1%;vertical-align:top;"><b>${esc(a.name)}</b>${a.when?` <span style="color:#667;font-size:11px;">&middot; signed ${esc(fmtDate(a.when))}</span>`:""}<br>${sigImg(a.signature)}</div>`).join("");

    // Attachments appendix — images embed as pages, other files list as links.
    const imgs = atts.filter(a => /^image\//.test(a.type || "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || ""));
    const files = atts.filter(a => imgs.indexOf(a) === -1);
    const attSection = atts.length ? `
      <div style="page-break-before:always;"></div>
      <h3>APPENDIX — ATTACHMENTS</h3>
      ${files.length ? `<ul>${files.map(f => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name || "file")}</a></li>`).join("")}</ul>` : ""}
      ${imgs.map(im => `<figure style="margin:10px 0;page-break-inside:avoid;"><img src="${esc(im.url)}" alt="${esc(im.name||"")}" style="max-width:100%;border:1px solid #ccc;border-radius:4px;"><figcaption style="font-size:11px;color:#667;margin-top:3px;">${esc(im.name||"")}</figcaption></figure>`).join("")}
    ` : "";

    return `
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:6px;">
        <img src="/mostlane-logo.jpg" alt="Mostlane" style="max-height:64px;width:auto;" onerror="this.style.display='none'">
      </div>
      <div style="text-align:center;color:#667;font-size:12px;">Risk Assessment</div>
      <h2>${esc(x.task || "Risk Assessment")}</h2>
      <p class="ref">Ref: ${esc(doc.ref || "—")}</p>
      <div style="text-align:center;font-weight:800;padding:8px;border-radius:8px;margin-bottom:14px;color:${bandCol(worst)};background:${bandBg(worst)};border:1px solid ${bandCol(worst)};">${worst} Risk Activity</div>
      <h3>ACTIVITY DETAILS</h3>
      <p><b>Location of activity:</b> ${esc(x.location||"")}</p>
      <p><b>Description of activity:</b><br>${esc(x.description||"").replace(/\n/g,"<br>")}</p>
      <div class="kv">
        <div><b>Equipment used:</b> ${esc(x.equipment||"")}</div><div><b>Supporting documents:</b> ${esc(x.supporting||"")}</div>
        <div><b>Person(s) affected:</b> ${esc(x.persons||"")}</div><div><b>Likely harm(s):</b> ${esc(x.harms||"")}</div>
        <div><b>Total numbers affected:</b> ${esc(x.totalAffected||"")}</div><div><b>Frequency of exposure:</b> ${esc(x.frequency||"")}</div>
        <div><b>Duration of exposure:</b> ${esc(x.duration||"")}</div><div><b>Assessor:</b> ${esc(x.assessor||"")}</div>
        <div><b>Created:</b> ${esc(fmtDate(x.date))}</div><div><b>Review before:</b> ${esc(fmtDate(x.reviewDate))}</div>
      </div>
      <h3>RISK SUMMARY</h3>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#eef2f7;"><th ${td} rowspan="2">Hazard</th><th ${td} rowspan="2">Persons affected</th><th ${tdc} colspan="3">Risk WITHOUT controls</th><th ${tdc} colspan="3">Risk WITH controls</th></tr>
          <tr style="background:#eef2f7;"><th ${tdc}>Sev</th><th ${tdc}>Lik</th><th ${tdc}>Rating</th><th ${tdc}>Sev</th><th ${tdc}>Lik</th><th ${tdc}>Rating</th></tr>
        </thead>
        <tbody>${summaryRows}</tbody>
      </table>
      <h3>KEY</h3>
      <div class="kv" style="font-size:12px;">
        <div><b>Severity</b><br>${HS.severityKey.map((t,i)=>`${i+1} = ${esc(t)}`).join("<br>")}</div>
        <div><b>Likelihood</b><br>${HS.likelihoodKey.map((t,i)=>`${i+1} = ${esc(t)}`).join("<br>")}</div>
      </div>
      <p style="font-size:12px;margin-top:8px;"><b>Risk (Severity &times; Likelihood):</b> 15–25 = High Risk · 8–12 = Medium Risk · 1–6 = Low Risk</p>
      <div style="margin-top:8px;"><b style="font-size:12px;">Risk matrix</b>${riskMatrix}</div>
      <h3>RISK CONTROL PLAN</h3>
      <table style="width:100%;border-collapse:collapse;">
        ${HS.riskControlPlan.map(p=>`<tr><td ${td} style="width:130px;padding:6px;border:1px solid #ccc;font-weight:700;">${esc(p.band)}</td><td ${td}>${esc(p.text)}</td></tr>`).join("")}
      </table>
      <h3>CONTROL MEASURES <span style="font-weight:400;font-size:11px;">(ordered by hierarchy of control)</span></h3>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#eef2f7;"><th ${td}>Hazard</th><th ${tdc}>Type</th><th ${td}>Control measure</th></tr></thead>
        <tbody>${controlRows}</tbody>
      </table>
      <h3>REQUIRED PPE</h3>
      <ul>${(x.ppe && x.ppe.length ? x.ppe : []).map(p=>`<li>${esc(p)}</li>`).join("") || "<li style='color:#889;'>See control measures.</li>"}</ul>
      <h3>ASSESSOR</h3>
      <div class="kv"><div><b>Name:</b> ${esc(x.assessor||"")}</div></div>
      <div class="sig" style="margin-top:6px;">${sigImg(x.assessorSignature)}</div>
      ${acks ? `<h3>OPERATIVE SIGN-OFF <span style="font-weight:400;font-size:12px;">— read &amp; understood</span></h3>${acks}` : ""}
      ${attSection}`;
  };
})();
