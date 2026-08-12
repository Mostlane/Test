/* ============================================================================
   Mostlane EICR engine (window.MLEICR)  —  eicr-engine.js
   ----------------------------------------------------------------------------
   The shared, DOM-free verification engine used by BOTH eicr-check.html (the
   single-file checker UI) and compliance-review.html (the batch worklist). It
   reads an EICR PDF's text with PDF.js and returns a structured analysis:
   outcome, signatories, latest date, LIM %, codebreaker suggestions, per-circuit
   review flags, and the verified circuits. Layout-aware (two schedule families),
   validated against real Satisfactory + Unsatisfactory reports.
   ============================================================================ */
(function () {
  var UCMIN = 230 * 0.95;                 // 218.5 V  (BS 7671 A2 Cmin 0.95)
  var K = { B: 5, C: 10, D: 20 };
  var PDFJS_BASE = "https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/";
  var pdfjsReady = null;

  function loadPdfjs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise(function (res, rej) {
      if (window.pdfjsLib) return res(window.pdfjsLib);
      var s = document.createElement("script"); s.src = PDFJS_BASE + "pdf.min.js";
      s.onload = function () { try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.js"; } catch (e) {} res(window.pdfjsLib); };
      s.onerror = function () { rej(new Error("Couldn't load the PDF reader (needs an internet connection).")); };
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }

  // Read a PDF (File | Blob | ArrayBuffer) → pages, each an array of reconstructed
  // line strings (items grouped by Y, sorted by X — the table's real columns).
  async function readPdf(source) {
    var lib = await loadPdfjs();
    var buf = (source instanceof ArrayBuffer) ? source : (source && source.arrayBuffer ? await source.arrayBuffer() : source);
    var pdf = await lib.getDocument({ data: buf }).promise;
    var pages = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      var items = tc.items.map(function (it) { return { s: it.str, x: it.transform[4], y: it.transform[5] }; }).filter(function (it) { return it.s && it.s.trim(); });
      items.sort(function (a, b) { return (Math.round(b.y) - Math.round(a.y)) || (a.x - b.x); });
      var lines = [], cur = null;
      items.forEach(function (it) { if (!cur || Math.abs(it.y - cur.y) > 3) { cur = { y: it.y, t: [] }; lines.push(cur); } cur.t.push(it.s); });
      pages.push(lines.map(function (l) { return l.t.join(" ").replace(/\s+/g, " ").trim(); }));
    }
    return pages;
  }

  // ── Codebreaker-style detectors (device product standards, not keywords) ──
  function acCount(t) { return (t.match(/\b(61008|61009|62423)\b[^A-Za-z0-9]{0,8}ac\b/gi) || []).length; }
  var DETECTORS = [
    { code: "C3", find: function (t) { return !/61643/.test(t); },
      title: "No surge protection device (SPD)",
      obs: "The installation is not provided with protection against transient overvoltages — no surge protective device (to BS EN 61643 series) was identified. Following Amendment 2, an SPD should be provided unless a documented risk assessment determines that protection is not required; its absence is recorded as an improvement.",
      regs: ["Section 443", "443.4", "534.4.1"] },
    { code: "C3", find: function (t) { return acCount(t) > 0; },
      detail: function (t) { var n = acCount(t); return n > 1 ? "Approximately " + n + " Type AC device(s) identified in the schedule. " : ""; },
      title: "RCD / RCBO of Type AC",
      obs: "One or more residual current devices are of Type AC. A Type AC RCD detects only sinusoidal AC residual currents; equipment containing electronic components (LED drivers, switch-mode power supplies, EV charging, variable-speed drives) can produce smooth DC residual currents that may 'blind' the device and impair disconnection. Replacement with a device of at least Type A should be considered.",
      regs: ["531.3.3", "GN3"] },
    { code: "C3", find: function (t) { return !/62606/.test(t); },
      title: "No arc fault detection (AFDD)",
      obs: "No arc fault detection devices (to BS EN 62606) were identified. For premises with a higher risk of fire, or with sleeping accommodation, consideration should be given to providing AFDDs on final circuits.",
      regs: ["421.1.7"] },
    { code: "C3", find: function (t) { return /\b3036\b/.test(t); },
      title: "BS 3036 semi-enclosed (rewireable) fuses",
      obs: "One or more circuits are protected by BS 3036 semi-enclosed (rewireable) fuses. These have a high fusing factor, offer no additional (RCD) protection and are easily re-fused with the wrong wire. Replacement with BS EN 60898 circuit-breakers or BS EN 61009 RCBOs should be considered to improve fault protection and disconnection times.",
      regs: ["533.1.1", "GN3"] },
    { code: "C3", find: function (t) { return /\b3871\b/.test(t); },
      title: "BS 3871 miniature circuit-breakers (obsolete)",
      obs: "Miniature circuit-breakers to BS 3871 were identified. This standard has been withdrawn and the devices are obsolete; correct operation and the availability of spares cannot be assured. Replacement with BS EN 60898 circuit-breakers should be considered.",
      regs: ["533.1.1", "GN3"] }
  ];

  // ── Structured schedule parser (layout-aware) ──
  var OCPD_RE = /^(60898|61009|60947|61008|3036|88)$/;
  var TE_CPC = { "1": "1", "1.5": "1", "2.5": "1.5", "4": "1.5", "6": "2.5", "10": "4", "16": "6", "25": "10" };
  var CAP = { "1": 16, "1.5": 20, "2.5": 27, "4": 37, "6": 47, "10": 64, "16": 85, "25": 112 };
  function toNum(x) { var n = parseFloat(x); return isNaN(n) ? null : n; }
  function isReading(x) { return x && x !== "---" && x !== "N/A" && x !== "n/a" && /^\d/.test(x); }
  function plainNum(x) { return x && !/[<>]/.test(x) && /^\d+(\.\d+)?$/.test(x); }
  function rowToks(line) { return line.replace(/([<>])\s+/g, "$1").trim().split(/\s+/); }
  function designation(t, iDev) {
    var phaseIdx = -1;
    for (var pi = 0; pi < iDev; pi++) { if (/^(L[123]|TP|SP|N)$/i.test(t[pi])) { phaseIdx = pi; break; } }
    var cctNum, phase = "";
    if (phaseIdx > 0) { cctNum = t[phaseIdx - 1]; phase = t[phaseIdx].toUpperCase(); }
    else { cctNum = /^\d/.test(t[1] || "") ? t[1] : t[0]; }
    var db = (t[0] !== cctNum && /^\d/.test(t[0])) ? t[0] : "";
    return { db: db, cct: ((cctNum || "") + phase).toUpperCase() };
  }
  function parseCircuit(line) {
    var t = rowToks(line), iDev = -1;
    for (var i = 1; i < t.length; i++) { if (OCPD_RE.test(t[i])) { iDev = i; break; } }
    if (iDev < 4) return null;
    var dev = t[iDev], type = t[iDev + 1], rating = toNum(t[iDev + 2]);
    if (!/^[BCD]$/.test(type) || !rating) return null;
    var maxZs = UCMIN / (K[type] * rating);
    var oMax = -1;
    for (var o = 3; o <= 8; o++) { var v = toNum(t[iDev + o]); if (v && Math.abs(v - maxZs) / maxZs < 0.04) { oMax = o; break; } }
    var ringBase = oMax >= 0 ? (oMax === 4 ? 9 : (oMax === 5 ? 6 : oMax + 1)) : -1;
    var r1, rn, r2, ring = false;
    if (ringBase > 0) { r1 = t[iDev + ringBase]; rn = t[iDev + ringBase + 1]; r2 = t[iDev + ringBase + 2]; ring = isReading(r1) && isReading(rn) && isReading(r2); }
    var measured = null;
    var jv = -1; for (var k = (oMax > 0 ? iDev + oMax : iDev + 3); k < t.length; k++) { if (/^(250|500|1000)$/.test(t[k])) { jv = k; break; } }
    if (jv >= 0) { for (var q = jv + 1; q < t.length; q++) { if (plainNum(t[q])) { var vv = toNum(t[q]); if (vv <= 50) { measured = vv; break; } } } }
    var d = designation(t, iDev);
    return {
      db: d.db, cct: d.cct, live: t[iDev - 3], cpc: t[iDev - 2],
      type: type, rating: rating, maxZs: maxZs, oMax: oMax,
      r1: r1, rn: rn, r2: r2, rcd: /^(61008|61009|62423)$/.test(dev), ring: ring,
      lim: /\bLIM\b/i.test(line), measured: measured, raw: line
    };
  }
  function parseCircuits(pages) {
    var out = [];
    pages.forEach(function (lines) { lines.forEach(function (t) { var c = parseCircuit(t); if (c) out.push(c); }); });
    return out;
  }

  // ── Document-level readers ──
  function findSignatories(flat) {
    var re = /([A-Z][a-zA-Z'’]+(?:[ -][A-Z][a-zA-Z'’]+)+)\s+(Qualified Supervisor|Approved Electrician|Electrician|Inspector(?: and Tester)?|Tester|Engineer)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/g;
    var seen = {}, out = [], m;
    while ((m = re.exec(flat))) { var key = m[1] + "|" + m[2]; if (!seen[key]) { seen[key] = 1; out.push({ name: m[1], role: m[2], date: m[3] }); } }
    return out;
  }
  function latestDate(flat) {
    var ds = [], m, re = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
    while ((m = re.exec(flat))) { var y = +m[3]; if (y < 100) y += 2000; var d = new Date(y, +m[2] - 1, +m[1]); if (!isNaN(d) && y >= 2000 && y <= 2100) ds.push(d); }
    if (!ds.length) return null;
    return new Date(Math.max.apply(null, ds.map(Number)));
  }
  function readOutcome(flat) {
    var lines = flat.split("\n"), su = 0, ss = 0;
    lines.forEach(function (l) {
      var t = l.trim().replace(/^[\s*:._\-]+|[\s*:._\-]+$/g, "");
      if (/^UN\s*SATISFACTORY$/i.test(t)) su++;
      else if (/^SATISFACTORY$/i.test(t)) ss++;
    });
    if (su && !ss) return "UNSATISFACTORY";
    if (ss && !su) return "SATISFACTORY";
    var c = flat.replace(/an?\s+['"]?un\s*satisfactory['"]?\s+assessment[\s\S]*?\./ig, "")
                .replace(/[\s\S]*?is\s+stated\s+as\s+['"]?un\s*satisfactory['"]?/ig, "")
                .replace(/\(\s*code[^)]*\)/ig, "");
    if (/UN\s*SATISFACTORY/i.test(c)) return "UNSATISFACTORY";
    if (/SATISFACTORY/i.test(c)) return "SATISFACTORY";
    return "";
  }

  // ── Full analysis. `pages` from readPdf(); returns a structured result. ──
  function analyze(pages) {
    var rawFlat = pages.map(function (p) { return p.join("\n"); }).join("\n");
    if (rawFlat.replace(/\s/g, "").length < 40) return { empty: true, textLen: 0 };

    // Strip the outcome/observation-code LEGEND & KEY rows before counting, so they
    // never masquerade as real observations. A legend line carries 2+ hazard codes
    // together (e.g. "C1 C2 C3 FI"), or the PASS-key phrase, or a code definition —
    // a GENUINE observation only ever carries a single code. Done per-line (not an
    // exact match) so it survives however a given EICR program lays the key out.
    function isLegendLine(l) {
      var hz = (l.match(/(?:^|\s)(C1|C2|C3|FI)(?=\s|[).,:]|$)/g) || []).length;
      if (hz >= 2) return true;
      if (/PASS\s+C1\s+or\s+C2|Limitation\s+LIM|N\/V\b[\s\S]*Limitation/i.test(l)) return true;
      if (/\b(C1|C2|C3|FI)\b\s*[-–:]?\s*(danger present|potentially dangerous|improvement recommended|further investigation)/i.test(l)) return true;
      return false;
    }
    var flat = rawFlat.split("\n").filter(function (l) { return !isLegendLine(l); }).join("\n");

    // Count GENUINE coded observations only. A real observation carries exactly ONE
    // code AND either an item number or real descriptive words. This rejects the code
    // KEY however a program lays it out — a horizontal cluster ("C1 C2 C3 FI"), a
    // VERTICAL fragment (a lone "C1" on its own line), or a code DEFINITION
    // ("C1 — Danger present…") — all of which faked phantom C1/C2/FI before.
    function countObs(text) {
      var c = { C1: 0, C2: 0, C3: 0, FI: 0 };
      text.split("\n").forEach(function (line) {
        var codes = (line.match(/(?:^|\s)(C1|C2|C3|FI)(?=\s|[).,:]|$)/g) || []).map(function (s) { return s.trim(); });
        if (codes.length !== 1) return;
        if (/danger present|potentially dangerous|improvement recommended|further investigation|risk of injury|remedial action|indicates that/i.test(line)) return;
        var rest = line.replace(/(?:^|\s)(C1|C2|C3|FI|N\/V|N\/A|Pass|LIM)(?=\s|[).,:]|$)/g, " ").trim();
        var letters = (rest.match(/[A-Za-z]/g) || []).length;
        var hasItemNo = /\b\d+\.\d+/.test(line) || /^\s*\d+\s+[A-Za-z]/.test(line);
        if (!hasItemNo && letters < 6) return;
        c[codes[0]]++;
      });
      return c;
    }

    var ref = (rawFlat.match(/(?:Certificate Number|Ref)[:\s]+(\S+)/i) || [])[1] || "";
    var outcome = readOutcome(rawFlat);
    var sigs = findSignatories(flat);
    var latest = latestDate(flat);
    var codes = countObs(flat);
    // LIM % over the INSPECTION SCHEDULE only — a line that starts with a numbered
    // item (5.12, 6.15.1 …) and carries an outcome. This is the natural reading of
    // "x% of the certificate is a limitation" and avoids the false inflation from the
    // DB-details / test-results rows (e.g. "N/A 400 V 230 V LIM") where LIM/N/A are
    // data, not inspection limitations.
    var totOut = 0, limOut = 0;
    flat.split("\n").forEach(function (l) {
      if (!/^\s*\d+\.\d+(\.\d+)?\s/.test(l)) return;
      var m = l.match(/(?:^|\s)(Pass|LIM|N\/A|N\/V|C1|C2|C3|FI)(?=\s|$)/g);
      if (!m || !m.length) return;
      totOut++; if (m.some(function (t) { return /LIM/.test(t); })) limOut++;
    });
    var limPct = totOut ? Math.round(limOut / totOut * 100) : 0;

    var circuits = parseCircuits(pages);

    // `hard` reviews drive the red "needs attention" flag in the worklist — only the
    // high-confidence, template-independent one (a mis-coded outcome). Everything else
    // (signatures, LIM, phase, circuit checks) is a SOFT note: shown, but it doesn't
    // turn a satisfactory cert red, because those reads vary too much across EICR
    // programs to trust as a hard fail.
    var reviews = [];
    function addReview(label, why, code, hard) { reviews.push({ label: label, why: why, code: code || "", hard: !!hard }); }
    if (codes.C1 + codes.C2 + codes.FI > 0 && outcome === "SATISFACTORY") {
      var parts = [];
      if (codes.C1) parts.push(codes.C1 + " × C1");
      if (codes.C2) parts.push(codes.C2 + " × C2");
      if (codes.FI) parts.push(codes.FI + " × FI");
      addReview("⚠ Outcome should be UNSATISFACTORY", "The report is marked SATISFACTORY, but it contains " + parts.join(", ") + " observation(s). Any C1, C2 or FI means the installation must be assessed UNSATISFACTORY (BS 7671 / GN3). Check the coding and the overall assessment.", "C1", true);
    }
    if (!sigs.length) addReview("Signatures", "No signatory (name · role · date) could be read on the report. Confirm the inspector/tester and, where required, the qualified supervisor have signed and dated it.");
    if (limPct > 10) addReview("Extent of testing", limOut + " of " + totOut + " assessed items are recorded as a Limitation (LIM) — about " + limPct + "%. More than 10% of the certificate is a limitation; check the extent & limitations were justified and agreed.");
    var phaseSeq = /phase sequence|phase rotation/i.test(rawFlat);
    var threePhase = /\bTP\b|\bL2\b|\bL3\b|400\s?V|three[ -]?phase/i.test(rawFlat);
    if (phaseSeq && !threePhase) addReview("Phase sequence", "Phase sequence / rotation is referenced, but the installation appears to be single-phase (no L2/L3/TP circuits or 400 V supply found). Confirm this isn't a template default left ticked.");

    // suggestions
    var suggestions = DETECTORS.filter(function (d) { return d.find(rawFlat); }).map(function (d) {
      return { code: d.code, title: d.title, obs: d.obs, regs: d.regs, detail: d.detail ? d.detail(rawFlat) : "" };
    });
    var noRcd = circuits.filter(function (c) { return !c.rcd && c.rating && c.rating <= 32; });
    if (noRcd.length) {
      var eg = noRcd.slice(0, 6).map(function (c) { return c.db + "·" + c.cct; }).join(", ") + (noRcd.length > 6 ? " …" : "");
      suggestions.push({
        code: "C3", title: noRcd.length + " circuit(s) with no RCD additional protection",
        detail: "e.g. " + eg + ". ",
        obs: "Circuits rated 32 A or below were identified with no RCD. Amendment 2 requires 30 mA RCD additional protection for socket-outlets rated up to 32 A intended for use by ordinary persons, and for cables concealed in walls or partitions at a depth of less than 50 mm without earthed mechanical protection. Review which of these circuits now require additional protection.",
        regs: ["411.3.3", "411.3.4", "522.6.202"]
      });
    }

    // per-circuit checks
    var verified = [];
    function fmt(n) { return (Math.round(n * 100) / 100).toString(); }
    circuits.forEach(function (c) {
      var lbl = (c.db ? "DB " + c.db + " · " : "") + "CCT " + c.cct;
      var liveN = toNum(c.live), cpcN = toNum(c.cpc), issues = [];
      // Under-rated only when the OCPD clearly exceeds the cable capacity (30% margin,
      // so marginal/rounding cases don't cry wolf) AND it isn't a standard 2.5 mm² ring
      // final on ≤32 A (a normal socket ring, not a fault).
      if (liveN && CAP[c.live] && c.rating > CAP[c.live] * 1.3 && !(c.live === "2.5" && c.rating <= 32))
        issues.push(c.live + " mm² live conductor on a " + c.rating + " A Type " + c.type + " device — above its typical current capacity (~" + CAP[c.live] + " A). Check the design current, install method and grouping.");
      if (liveN && cpcN && liveN <= 10 && TE_CPC[c.live] && cpcN < parseFloat(TE_CPC[c.live]))
        issues.push("CPC " + c.cpc + " mm² looks undersized for a " + c.live + " mm² line (a twin-&-earth cpc would be " + TE_CPC[c.live] + " mm²). Confirm the cable type and check the adiabatic (543.1.3).");
      if (c.live === "2.5" && c.rating > 20 && !c.ring && c.oMax >= 0)
        issues.push("2.5 mm² on a " + c.rating + " A device (a ring final is expected) but the end-to-end r1/rn/r2 continuity readings are missing. Record them, or confirm it isn't a ring.");
      var note = "";
      if (c.measured != null && c.maxZs) {
        var rule08 = 0.8 * c.maxZs;
        if (c.measured > c.maxZs) issues.push("Measured Zs " + fmt(c.measured) + " Ω exceeds the maximum permitted " + fmt(c.maxZs) + " Ω for this device.");
        else if (c.measured > rule08) note = "Zs " + fmt(c.measured) + " Ω is above the 0.8× cold rule-of-thumb (" + fmt(rule08) + " Ω) but within the tabulated max (" + fmt(c.maxZs) + " Ω) — verify temperature.";
      }
      if (c.lim) note = (note ? note + " " : "") + "Row contains a LIM (a value could not be measured).";
      if (issues.length) addReview(lbl, issues.join(" "));
      else verified.push({ db: c.db, cct: c.cct, live: c.live, cpc: c.cpc, type: c.type, rating: c.rating, maxZs: c.maxZs, measured: c.measured, note: note, raw: c.raw });
    });

    return {
      empty: false, ref: ref, outcome: outcome, latest: latest, sigs: sigs, codes: codes,
      lim: { pct: limPct, limOut: limOut, totOut: totOut },
      suggestions: suggestions, reviews: reviews, verified: verified, circuitsCount: circuits.length
    };
  }

  // Distil an analysis into a worklist verdict. `attention` (red) means a genuine
  // issue to action — unsatisfactory, a mis-coded outcome, missing signatures, >10%
  // LIM, a circuit problem, or unreadable. Routine C3 recommendations (no SPD/AFDD,
  // Type AC…) are LISTED but don't by themselves make a compliant report "red".
  // Break at a sentence-ending period (followed by space/end), NOT a decimal point —
  // so "2.5 mm² on a 20 A device…" isn't truncated to "2.".
  function firstSentence(s) { s = String(s || ""); var m = s.match(/^[\s\S]*?[.](?=\s|$)/); var t = (m ? m[0] : s).trim(); return t.length > 160 ? t.slice(0, 157) + "…" : t; }
  function fmtReview(r) { return r.label.replace(/^⚠\s*/, "") + " — " + firstSentence(r.why); }
  function summarize(result) {
    if (!result || result.empty) return { attention: true, headline: "Couldn't read text — scanned/image PDF", flags: ["No readable text — this looks like a scanned/flattened image PDF. Verify manually."], recommendations: [], outcome: "" };
    var hard = result.reviews.filter(function (r) { return r.hard; });
    var soft = result.reviews.filter(function (r) { return !r.hard; });
    var flags = hard.map(fmtReview);                                   // red — drive attention
    // soft findings + codebreaker suggestions are informational notes
    var recommendations = soft.map(fmtReview).concat(result.suggestions.map(function (s) { return s.code + " · " + s.title; }));
    var attention = result.outcome === "UNSATISFACTORY" || !result.outcome || hard.length > 0;
    var headline;
    if (!result.outcome) headline = "Outcome not read — check manually";
    else if (result.outcome === "UNSATISFACTORY") headline = "UNSATISFACTORY";
    else if (hard.length) headline = "Satisfactory — but should be reviewed";
    else if (soft.length) headline = "Satisfactory · " + soft.length + " note(s)";
    else if (result.suggestions.length) headline = "Satisfactory · " + result.suggestions.length + " recommendation(s)";
    else headline = "Satisfactory · nothing flagged";
    return { attention: attention, headline: headline, flags: flags, recommendations: recommendations, outcome: result.outcome, reviewCount: hard.length };
  }

  window.MLEICR = {
    loadPdfjs: loadPdfjs, readPdf: readPdf, analyze: analyze, summarize: summarize,
    DETECTORS: DETECTORS
  };
})();
