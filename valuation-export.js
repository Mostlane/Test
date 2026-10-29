// Valuation sheet → .xlsx (values only), built on the shared ml-xlsx.js writer.
// window.MLValXlsx.download(V) where V = { ref, data:{title,client,columns,items,
// currentColumnId, retentionPct, finalRetentionPct} }. Totals are computed here (the
// writer is values-only, like the FBC + programme exports), so the numbers match
// the on-screen sheet and the PDF exactly. Two-rate retention: interim valuations
// hold retentionPct% (5); the final account releases that and holds
// finalRetentionPct% (2.5) of the contract value instead.
(function () {
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const money = v => ({ v: Math.round(num(v) * 100) / 100, money: true, center: true });
  const moneyB = v => ({ v: Math.round(num(v) * 100) / 100, money: true, bold: true, center: true });
  const pctStr = f => (isFinite(f) ? Math.round(f * 100) : 0) + "%";

  function compute(data) {
    const clampPct = (v, d) => { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(100, n)) : d; };
    const interimPct = clampPct(data.retentionPct, 5);
    const finalPct = clampPct(data.finalRetentionPct, interimPct / 2);
    const hasRetention = data.hasRetention === true ? true
      : data.hasRetention === false ? false
      : clampPct(data.retentionPct, 0) > 0;
    const retOn = hasRetention && (interimPct > 0 || finalPct > 0);
    const cols = data.columns || [], items = data.items || [];
    let contractTotal = 0, grandGross = 0;
    const perItem = items.map(it => {
      const cost = num(it.cost), am = it.amounts || {}; let taken = 0;
      for (const c of cols) taken += num(am[c.id]);
      contractTotal += cost; grandGross += taken;
      return { cost, taken, remaining: cost - taken, pct: cost ? taken / cost : 0, am, extra: !!it.extra, desc: it.desc || "" };
    });
    const retBase = contractTotal > 0 ? contractTotal : grandGross;
    let grossCum = 0, prevNet = 0;
    const perCol = cols.map(c => {
      let gross = 0; for (const it of items) gross += num((it.amounts || {})[c.id]);
      grossCum += gross;
      const isFinal = !!c.final;
      const interimAccrued = retOn ? (interimPct / 100) * grossCum : 0;
      const retHeld = !retOn ? 0 : (isFinal ? (finalPct / 100) * retBase : interimAccrued);
      const released = (retOn && isFinal) ? interimAccrued : 0;
      const netCum = grossCum - retHeld, dueThis = netCum - prevNet; prevNet = netCum;
      return { id: c.id, name: c.name || "", final: isFinal, gross, grossCum, interimAccrued, retHeld, released, netCum, dueThis };
    });
    const last = perCol[perCol.length - 1] || null;
    const hasFinal = cols.some(c => c.final);
    return { pct: interimPct, finalPct, retOn, hasFinal, retBase, contractTotal, grandGross, remaining: contractTotal - grandGross, completion: contractTotal ? grandGross / contractTotal : 0, retentionHeld: last ? last.retHeld : 0, netCertified: last ? last.netCum : 0, perItem, perCol };
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
    rows.push(head.map((h, ix) => ({ v: h, bold: true, center: ix >= 2 })));
    // items
    C.perItem.forEach((pi, i) => {
      const r = [pi.extra ? "EXTRA" : (i + 1), pi.desc, money(pi.cost)];
      cols.forEach(c => { const a = num(pi.am[c.id]); r.push(a ? money(a) : ""); });
      r.push(moneyB(pi.taken), money(pi.remaining), { v: pctStr(pi.pct), center: true });
      rows.push(r);
    });
    // totals
    const tot = ["", { v: "TOTALS", bold: true }, moneyB(C.contractTotal)];
    C.perCol.forEach(c => tot.push(moneyB(c.gross)));
    tot.push(moneyB(C.grandGross), moneyB(C.remaining), { v: pctStr(C.completion), bold: true, center: true });
    rows.push(tot);
    // summary
    rows.push([]);
    rows.push([{ v: "Summary", bold: true }]);
    rows.push(["Contract total", money(C.contractTotal)]);
    C.perCol.forEach((c, i) => {
      const r = [(c.name || ("Valuation " + (i + 1))) + (c.final ? " (final a/c)" : ""), "gross", money(c.gross), "to date", money(c.grossCum)];
      if (c.final && c.released) r.push("retention released", money(c.released), "final retention " + C.finalPct + "%", money(-c.retHeld), "net due", money(c.dueThis));
      else if (c.retHeld) r.push("retention " + C.pct + "%", money(-c.retHeld), "net due", money(c.dueThis));
      else r.push("net due", money(c.dueThis));
      rows.push(r);
    });
    rows.push(["Certified to date", money(C.grandGross)]);
    if (C.retOn) rows.push(["Retention held", money(C.retentionHeld), C.hasFinal ? "final account @ " + C.finalPct + "%" : "interim @ " + C.pct + "% (" + C.finalPct + "% at final a/c)"]);
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
