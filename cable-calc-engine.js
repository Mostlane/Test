/* ============================================================================
   Mostlane Cable Calculator engine  (window.MLCable)  —  cable-calc-engine.js
   ----------------------------------------------------------------------------
   A DOM-free BS 7671 single-circuit cable-sizing / verification engine, modelled
   on the ProCert-style calculation flow. Used by cable-calculator.html (the form
   + live results) and by the worker's PDF builder (same numbers, one source).

   DESIGN PRINCIPLE — computed vs looked-up:
     • COMPUTED here (engineering formulae, no copyright): design current, the
       required tabulated capacity It = In / (Ca·Cg·Ci·Cs·Cc), voltage drop from
       the tabulated mV/A/m, R1+R2 & Zs, max Zs (Uoc / (k·In) style & device
       curves), adiabatic CPC minimum S = sqrt(I²t)/k, disconnection check.
     • LOOKED UP from the caller-supplied `data` object (the user's own
       manufacturer-datasheet values — NOT reproduced from BS 7671 here):
       tabulated current-carrying capacity Iz(tab), mV/A/m, and the correction-
       factor tables Ca/Cg/Ci. The engine never invents these; if the data is
       missing it says so and the check is reported as "no data", never a silent
       pass.

   IMPORTANT: this is a CHECKING AID. Every result must be verified by a
   competent person against BS 7671 and the actual manufacturer data. The engine
   flags, it does not certify.
   ============================================================================ */
(function () {
  "use strict";

  // ---- physical constants (not copyrightable — standard physics/derivations) ----
  // Conductor resistivity used for R1+R2 when a datasheet mΩ/m isn't supplied.
  // Values at 20°C (Ω·mm²/m). Standard reference resistivity.
  var RHO20 = { cu: 0.017241, al: 0.028264 };
  // Temperature coefficient of resistance (per °C at 20°C).
  var ALPHA = { cu: 0.00393, al: 0.00403 };
  // Operating (final) conductor temperature by insulation (°C) — BS 7671 std.
  var THETA_OP = { pvc: 70, xlpe: 90 };
  // R1+R2 multiplier from 20°C to operating temp for the loop-impedance check.
  // (BS 7671 / GN3 use ~1.20 for 70°C and ~1.28 for 90°C thermoplastic vs. 90°C.)
  function tempFactor(insulation, cond) {
    var a = ALPHA[cond] || ALPHA.cu, op = THETA_OP[insulation] || 70;
    return 1 + a * (op - 20);
  }

  // ---- adiabatic k (BS 7671 Tables 43.1 / 54.2-54.6) ----
  // These are the standard published k constants, DERIVED from the adiabatic
  // formula k = sqrt( Qc(β+20)/ρ20 ) · ln((β+θf)/(β+θi)) — reproduced from the
  // physics, not from a copyrighted table. The caller may override via data.k.
  // Line conductor, initial temp = operating temp of the insulation:
  var K_LINE = { pvc_cu: 115, pvc_al: 76, xlpe_cu: 143, xlpe_al: 94 };
  // Protective conductor: value depends on whether the cpc is a core of the
  // cable (initial temp = operating temp) or run separately (30°C assumed) and
  // its insulation. We expose the common cases; caller can override.
  var K_CPC = {
    // cpc is a core within the cable (initial temp = insulation op temp)
    core_pvc_cu: 115, core_xlpe_cu: 143, core_pvc_al: 76, core_xlpe_al: 94,
    // cpc separate, not bunched, insulated, initial 30°C
    sep_pvc_cu: 143, sep_xlpe_cu: 143, sep_70pvc_cu: 143,
    // bare cpc (e.g. conduit/tray), initial 30°C, not in contact with cable covering
    bare_cu: 159, bare_al: 105,
    // steel (SWA armour / conduit) as cpc
    steel: 52
  };

  function num(x) { var n = parseFloat(x); return isFinite(n) ? n : null; }
  function round(x, dp) { var m = Math.pow(10, dp == null ? 2 : dp); return Math.round(x * m) / m; }

  // ── Design current ──────────────────────────────────────────────────────
  // Single-phase: Ib = P / (V·pf).  Three-phase: Ib = P / (√3·VL·pf).
  function designCurrent(inp) {
    if (inp.ib != null && num(inp.ib) != null) return num(inp.ib);   // entered directly
    var p = num(inp.powerW), pf = num(inp.pf) || 1, v;
    if (p == null) return null;
    if (inp.phases === 3) { v = num(inp.voltage) || 400; return p / (Math.sqrt(3) * v * pf); }
    v = num(inp.voltage) || 230; return p / (v * pf);
  }

  // ── Voltage-drop limit (V) from the % and nominal voltage ─────────────────
  function vdLimit(inp) {
    var pct = num(inp.vdPercent);
    if (pct == null) pct = (inp.circuitUse === "lighting") ? 3 : 5;   // BS 7671 App 12 defaults
    var v = inp.phases === 3 ? (num(inp.voltage) || 400) : (num(inp.voltage) || 230);
    return { pct: pct, volts: v * pct / 100 };
  }

  // ── Correction factors from the supplied tables (nearest-safe lookup) ─────
  // Each returns { value, source, note } — value null ⇒ no data (never assumed).
  function ca(data, insulation, ambient) {
    if (ambient == null || ambient === 30) return { value: 1, source: "std (30°C reference)" };
    var tbl = data && data.ambient && data.ambient[insulation];
    if (!tbl) return { value: null, note: "No ambient-temperature (Ca) table for " + insulation };
    // exact key else nearest key at-or-above the ambient (conservative)
    if (tbl[ambient] != null) return { value: +tbl[ambient], source: "datasheet Ca @" + ambient + "°C" };
    var keys = Object.keys(tbl).map(Number).sort(function (a, b) { return a - b; });
    var pick = keys.filter(function (k) { return k >= ambient; })[0];
    if (pick == null) pick = keys[keys.length - 1];
    return { value: +tbl[pick], source: "datasheet Ca @" + pick + "°C (nearest ≥ " + ambient + ")" };
  }
  function cg(data, method, circuits, arrangement) {
    if (!circuits || circuits <= 1) return { value: 1, source: "single circuit" };
    var tbl = data && data.grouping && (data.grouping[arrangement || "default"] || data.grouping["default"]);
    if (!tbl) return { value: null, note: "No grouping (Cg) table supplied" };
    var key = String(circuits);
    if (tbl[key] != null) return { value: +tbl[key], source: "datasheet Cg (" + circuits + " circuits)" };
    var keys = Object.keys(tbl).map(Number).sort(function (a, b) { return a - b; });
    var pick = keys.filter(function (k) { return k >= circuits; }).pop() || keys[keys.length - 1];
    return { value: +tbl[pick], source: "datasheet Cg (" + pick + "+ circuits)" };
  }
  function ci(data, factor) {
    if (factor == null || factor === "none") return { value: 1, source: "no thermal insulation" };
    var tbl = data && data.insulation;
    if (tbl && tbl[factor] != null) return { value: +tbl[factor], source: "datasheet Ci (" + factor + ")" };
    // BS 7671 523.9 worst case: cable totally surrounded ⇒ 0.5
    if (factor === "surround") return { value: 0.5, source: "523.9 fully surrounded (0.5)" };
    return { value: null, note: "No thermal-insulation (Ci) value for '" + factor + "'" };
  }
  function cc(inp) {
    // Cc: 0.725 for BS 3036 semi-enclosed fuse (rewireable); 0.9 for buried in
    // ground (Method D) — both standard multipliers.
    var f = 1, notes = [];
    if (inp.deviceStd === "3036") { f *= 0.725; notes.push("BS 3036 fuse (0.725)"); }
    if (inp.buried) { f *= 0.9; notes.push("buried in ground (0.9)"); }
    return { value: f, source: notes.join(" · ") || "1" };
  }

  // ── Tabulated capacity + mV/A/m lookup from the datasheet data ────────────
  function cableRow(data, inp) {
    var cab = (data && data.cables || []).filter(function (c) { return c.id === inp.cableId; })[0];
    if (!cab) return { err: "Cable type not found in datasheet data" };
    var m = cab.methods && cab.methods[inp.method];
    if (!m) return { err: "No data for reference method " + inp.method + " on this cable", cable: cab };
    var row = m[String(inp.csa)];
    if (!row) return { err: "No " + inp.csa + " mm² row for method " + inp.method, cable: cab };
    return {
      cable: cab,
      izTab: num(row.iz),        // tabulated current-carrying capacity (A)
      mvam: num(row.vd)          // mV/A/m (voltage drop per amp per metre)
    };
  }

  // ── Max Zs for the protective device ──────────────────────────────────────
  // MCB/RCBO (BS EN 60898/61009): Uoc/(k·In) using the Cmin(0.95) method that
  // eicr-engine already uses — 218.5/(k·In) at 230 V. Fuses/other: from a
  // caller-supplied device curve (data.deviceZs) since fuse Zs is tabulated.
  function maxZs(data, inp, uoc) {
    var In = num(inp.In);
    var t = inp.disconnect === 5 ? 5 : 0.4;
    if (inp.deviceStd === "60898" || inp.deviceStd === "61009") {
      var k = { B: 5, C: 10, D: 20 }[String(inp.deviceCurve || "B").toUpperCase()];
      if (!k || !In) return { value: null, note: "device curve / rating missing" };
      var u = uoc || 230;
      return { value: round((u * 0.95) / (k * In), 2), source: "Uoc·0.95 / (k·In), k=" + k, method: "computed" };
    }
    // Fuse or other: look up the device's max Zs for the disconnection time
    var dz = data && data.deviceZs && data.deviceZs[inp.deviceStd];
    var byRating = dz && dz[String(In)];
    var v = byRating && (byRating[t === 5 ? "5s" : "0.4s"]);
    if (v != null) return { value: +v, source: "datasheet " + inp.deviceStd + " " + In + "A @" + t + "s", method: "datasheet" };
    return { value: null, note: "No max-Zs data for " + inp.deviceStd + " " + (In || "?") + "A @ " + t + "s" };
  }

  // ── Disconnection time — for MCB/RCBO the max-Zs check already guarantees it;
  //    for fuses the datasheet Zs is time-specific. RCD adds a magnetic path. ──
  function adiabaticMinCPC(If, t, k) {
    // S ≥ sqrt(I²·t) / k  (BS 7671 543.1.3)
    if (!If || !t || !k) return null;
    return (Math.sqrt(If * If * t)) / k;
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  // inp = the circuit inputs; data = the reference/datasheet tables.
  function calculate(inp, data) {
    inp = inp || {}; data = data || {};
    var out = { inputs: inp, checks: [], warnings: [], values: {} };
    var v = out.values;
    var uoc = num(inp.uoc) || (inp.phases === 3 ? 400 : 230);
    var insulation = inp.insulation || "pvc";
    var cond = inp.conductor || "cu";

    // 1) Design current & device rating (BS 7671 433.1.1: Ib ≤ In ≤ Iz)
    var Ib = designCurrent(inp); v.Ib = Ib == null ? null : round(Ib, 2);
    var In = num(inp.In); v.In = In;
    pushCheck(out, "Overload — Ib ≤ In", "433.1.1",
      (Ib != null && In != null) ? (Ib <= In) : null,
      (Ib != null && In != null) ? ("Ib " + round(Ib, 1) + " A ≤ In " + In + " A") : "design current or device rating missing");

    // 2) Correction factors
    var Ca = ca(data, insulation, num(inp.ambient)); v.Ca = Ca;
    var Cg = cg(data, inp.method, num(inp.circuits), inp.grouping); v.Cg = Cg;
    var Ci = ci(data, inp.insulationFactor); v.Ci = Ci;
    var Cc = cc(inp); v.Cc = Cc;
    var factorMissing = [Ca, Cg, Ci].some(function (f) { return f.value == null; });
    var product = (Ca.value || 0) * (Cg.value || 0) * (Ci.value || 0) * (Cc.value || 1);
    v.factorProduct = factorMissing ? null : round(product, 4);

    // 3) Required tabulated capacity  It ≥ In / (Ca·Cg·Ci·Cs·Cc)
    var itReq = (In != null && !factorMissing && product > 0) ? In / product : null;
    v.itRequired = itReq == null ? null : round(itReq, 2);

    // 4) Cable capacity from the datasheet
    var cr = cableRow(data, inp); v.cable = cr.err ? { err: cr.err } : {
      name: cr.cable.name, csa: inp.csa, method: inp.method, izTab: cr.izTab, mvam: cr.mvam
    };
    if (cr.err) out.warnings.push(cr.err);
    var izCorrected = (cr.izTab != null && !factorMissing) ? cr.izTab * product : null;
    v.izTab = cr.izTab; v.izCorrected = izCorrected == null ? null : round(izCorrected, 2);
    // Current-carrying: corrected Iz ≥ In  (equivalent to It(req) ≤ tabulated Iz)
    pushCheck(out, "Current-carrying capacity — Iz ≥ In", "523 / App 4",
      (izCorrected != null && In != null) ? (izCorrected >= In) : null,
      (izCorrected != null && In != null)
        ? ("Corrected Iz " + round(izCorrected, 1) + " A ≥ In " + In + " A (tab " + cr.izTab + " × " + round(product, 3) + ")")
        : (cr.err || "correction-factor data missing"));

    // 5) Voltage drop  ΔU = mV/A/m · Ib · L / 1000
    var L = num(inp.length), lim = vdLimit(inp); v.vdLimit = lim;
    var vd = (cr.mvam != null && Ib != null && L != null) ? (cr.mvam * Ib * L) / 1000 : null;
    v.vdVolts = vd == null ? null : round(vd, 2);
    v.vdPercent = vd == null ? null : round((vd / (inp.phases === 3 ? uoc : (num(inp.voltage) || 230))) * 100, 2);
    pushCheck(out, "Voltage drop ≤ " + lim.pct + "%", "525 / App 12",
      (vd != null) ? (vd <= lim.volts) : null,
      (vd != null) ? (round(vd, 2) + " V (" + v.vdPercent + "%) vs limit " + round(lim.volts, 2) + " V")
        : "mV/A/m, Ib or length missing");

    // 6) Earth-fault loop impedance  Zs = Ze + (R1+R2)
    var Ze = num(inp.ze); v.Ze = Ze;
    var mohmLive = num(inp.r1) , mohmCpc = num(inp.r2);   // mΩ/m if the user gave them
    // else compute from resistivity & CSA
    function mOhmPerM(csa) { return csa ? (RHO20[cond] / csa) * 1000 : null; }
    if (mohmLive == null) mohmLive = mOhmPerM(num(inp.csa));
    if (mohmCpc == null) mohmCpc = mOhmPerM(num(inp.cpcCsa));
    var tf = tempFactor(insulation, cond);
    var r1r2 = (mohmLive != null && mohmCpc != null && L != null)
      ? ((mohmLive + mohmCpc) * L / 1000) * tf : null;                 // Ω, at op temp
    v.r1r2 = r1r2 == null ? null : round(r1r2, 3); v.tempFactor = round(tf, 3);
    var Zs = (Ze != null && r1r2 != null) ? Ze + r1r2 : null;
    v.Zs = Zs == null ? null : round(Zs, 3);
    var mz = maxZs(data, inp, uoc); v.maxZs = mz;
    pushCheck(out, "Earth-fault loop impedance — Zs ≤ max Zs", "411.4.5 / 41.3",
      (Zs != null && mz.value != null) ? (Zs <= mz.value) : null,
      (Zs != null && mz.value != null)
        ? ("Zs " + round(Zs, 2) + " Ω ≤ max " + mz.value + " Ω (" + (mz.source || "") + ")")
        : (mz.note || "Ze, cable resistance or max-Zs data missing"));

    // 7) Adiabatic / fault-protection — CPC minimum size
    var Ipf = (Zs != null && Zs > 0) ? (uoc / Zs) : null;              // prospective earth-fault current
    v.faultCurrent = Ipf == null ? null : round(Ipf, 0);
    // disconnection time t: MCB/RCBO ⇒ the disconnect target (0.4/5s) once Zs OK;
    // fuse ⇒ same target (its max-Zs table is time-specific). Use the target.
    var t = inp.disconnect === 5 ? 5 : 0.4;
    var kcpc = num(inp.kCpc) || K_CPC[(inp.cpcArrangement || "core") + "_" + insulation + "_" + cond]
      || K_CPC["core_" + insulation + "_" + cond] || K_LINE[insulation + "_" + cond];
    v.kCpc = kcpc;
    var minCpc = adiabaticMinCPC(Ipf, t, kcpc); v.minCpcCsa = minCpc == null ? null : round(minCpc, 2);
    var cpcCsa = num(inp.cpcCsa);
    pushCheck(out, "Adiabatic — CPC S ≥ √(I²t)/k", "543.1.3",
      (minCpc != null && cpcCsa != null) ? (cpcCsa >= minCpc) : null,
      (minCpc != null && cpcCsa != null)
        ? ("CPC " + cpcCsa + " mm² ≥ required " + round(minCpc, 2) + " mm² (If " + round(Ipf, 0) + " A, t " + t + "s, k " + kcpc + ")")
        : "fault current, disconnection time or CPC size missing");

    // 8) Additional protection (RCD) advisory — not a hard pass/fail here
    if (inp.socketsOutdoors || inp.cableInWall || inp.circuitUse === "sockets") {
      out.warnings.push("Additional protection by 30 mA RCD is required for socket-outlets (≤32 A) and for cables concealed in walls without earthed mechanical protection — confirm an RCD is fitted (BS 7671 411.3.3 / 522.6.202).");
    }

    // overall
    out.pass = out.checks.every(function (c) { return c.pass === true; });
    out.incomplete = out.checks.some(function (c) { return c.pass == null; });
    return out;
  }

  function pushCheck(out, label, reg, pass, detail) {
    out.checks.push({ label: label, reg: reg, pass: pass, detail: detail });
  }

  // ── public API ──
  window.MLCable = {
    calculate: calculate,
    designCurrent: designCurrent,
    K_LINE: K_LINE, K_CPC: K_CPC, RHO20: RHO20,
    _internal: { ca: ca, cg: cg, ci: ci, cc: cc, maxZs: maxZs, tempFactor: tempFactor }
  };
})();
