// Valuation sheet → .xlsx (values only), built on the shared ml-xlsx.js writer.
// window.MLValXlsx.download(V) where V = { ref, data:{title,client,columns,items,
// currentColumnId, retentionPct, retentionMode} }. Totals are computed here (the
// writer is values-only, like the FBC + programme exports), so the numbers match
// the on-screen sheet and the PDF exactly.
(function () {
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const money = v => ({ v: Math.round(num(v) * 100) / 100, money: true });
  const moneyB = v => ({ v: Math.round(num(v) * 100) / 100, money: true, bold: true });
  const pctStr = f => (isFinite(f) ? Math.round(f * 100) : 0) + "%";

  function compute(data) {
    const pct = Math.max(0, Math.min(100, num(data.retentionPct)));
    const mode = data.retentionMode === "each" ? "each" : "final";
    const cols = data.columns || [], items = data.items || [];
    let contractTotal = 0, grandGross = 0;
    const perItem = items.map(it => {
      const cost = num(it.cost), am = it.amounts || {}; let taken = 0;
      for (const c of cols) taken += num(am[c.id]);
      contractTotal += cost; grandGross += taken;
      return { cost, taken, remaining: cost - taken, pct: cost ? taken / cost : 0, am, extra: !!it.extra, desc: it.desc || "" };
    });
    let grossCum = 0, prevNet = 0;
    const perCol = cols.map(c => {
      let gross = 0; for (const it of items) gross += num((it.amounts || {})[c.id]);
      grossCum += gross;
      const retHeld = mode === "each" ? (pct / 100) * grossCum : (c.final ? (pct / 100) * grossCum : 0);
      const netCum = grossCum - retHeld, dueThis = netCum - prevNet; prevNet = netCum;
      return { id: c.id, name: c.name || "", final: !!c.final, gross, grossCum, retHeld, netCum, dueThis };
    });
    const last = perCol[perCol.length - 1] || null;
    return { pct, mode, contractTotal, grandGross, remaining: contractTotal - grandGross, completion: contractTotal ? grandGross / contractTotal : 0, retentionHeld: last ? last.retHeld : 0, netCertified: last ? last.netCum : 0, perItem, perCol };
  }

  function buildRows(V) {
    const d = V.data || {}, cols = d.columns || [], C = compute(d);
    const rows = [];
    rows.push([{ v: d.title || "Valuation", bold: true }]);
    const sub = [V.ref, d.client].filter(Boolean).join("   ·   ");
    if (sub) rows.push([sub]);
    rows.push([]);
    // header
    const head = ["#", "Description", "Cost"];
    cols.forEach(c => head.push((c.name || "Valuation") + (c.final ? " (final)" : "")));
    head.push("Taken", "Remaining", "%");
    rows.push(head.map(h => ({ v: h, bold: true })));
    // items
    C.perItem.forEach((pi, i) => {
      const r = [pi.extra ? "EXTRA" : (i + 1), pi.desc, money(pi.cost)];
      cols.forEach(c => { const a = num(pi.am[c.id]); r.push(a ? money(a) : ""); });
      r.push(moneyB(pi.taken), money(pi.remaining), pctStr(pi.pct));
      rows.push(r);
    });
    // totals
    const tot = ["", { v: "TOTALS", bold: true }, moneyB(C.contractTotal)];
    C.perCol.forEach(c => tot.push(moneyB(c.gross)));
    tot.push(moneyB(C.grandGross), moneyB(C.remaining), { v: pctStr(C.completion), bold: true });
    rows.push(tot);
    // summary
    rows.push([]);
    rows.push([{ v: "Summary", bold: true }]);
    rows.push(["Contract total", money(C.contractTotal)]);
    C.perCol.forEach((c, i) => rows.push([(c.name || ("Valuation " + (i + 1))) + (c.final ? " (final a/c)" : ""), "gross " , money(c.gross), "to date", money(c.grossCum), c.retHeld ? "retention" : "", c.retHeld ? money(-c.retHeld) : "", "net due", money(c.dueThis)]));
    rows.push(["Certified to date", money(C.grandGross)]);
    if (C.pct > 0) rows.push(["Retention held (" + C.pct + "%)", money(C.retentionHeld), C.mode === "final" ? "on final account" : "each valuation"]);
    rows.push(["Net certified", moneyB(C.netCertified)]);
    rows.push(["Remaining", money(C.remaining), pctStr(C.completion) + " complete"]);
    return rows;
  }

  function download(V) {
    if (!window.MLXlsx) throw new Error("spreadsheet writer not loaded");
    const name = ((V.data && V.data.title) || "Valuation") + (V.ref ? " - " + V.ref : "");
    window.MLXlsx.download(name.replace(/[^\w .\-()]/g, "_") + ".xlsx", [{ name: "Valuation", rows: buildRows(V) }]);
  }
  window.MLValXlsx = { download, buildRows, compute };
})();
