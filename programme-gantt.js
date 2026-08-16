// Shared job-programme renderer — used by programme-edit.html (editable) and
// programme-view.html (client copy: read-only, or editable in suggest mode).
// One source of truth so the client sees exactly what the office built.
//
//   MLProg.render(host, data, { editable, onChange, watermark })
//   MLProg.blank()          → a new empty programme
//   MLProg.uid()            → row/section id
//   MLProg.diff(base, mine) → { added, removed, changed } row-level change list
//
// Data shape:
// { title, client, site, ref, startDate:"YYYY-MM-DD", notes,
//   sections:[{ id, name, rows:[{ id, name, start, days, progress, colour, milestone }] }] }
(function () {
  const DAY = 86400000;
  const COLW = 42;                     // px per week column
  const DW = COLW / 7;                 // px per day
  const PALETTE = ["#2f6fed", "#0fb6b0", "#7a5af8", "#f79009", "#e0344b", "#15803d", "#0369a1", "#b45309"];

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const p2 = n => String(n).padStart(2, "0");
  const ymd = d => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  function parse(s) { const d = new Date(String(s || "") + "T12:00:00"); return isNaN(d) ? null : d; }
  function mondayOf(d) { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setHours(12, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtShort(d) { return p2(d.getDate()) + "/" + p2(d.getMonth() + 1); }
  function nextMonday() { const d = mondayOf(new Date()); return ymd(addDays(d, 7)); }

  function blank() {
    return { title: "", client: "", site: "", ref: "", startDate: nextMonday(), notes: "", sections: [{ id: uid(), name: "Phase 1", rows: [] }] };
  }

  function allRows(data) { return (data.sections || []).flatMap(s => s.rows || []); }

  // Grid geometry: starts the Monday of startDate's week, runs to a week past
  // the latest activity (min 12 weeks so an empty programme still has a grid).
  function geometry(data) {
    let start = parse(data.startDate) || new Date();
    const rows = allRows(data);
    for (const r of rows) { const d = parse(r.start); if (d && d < start) start = d; }
    const gridStart = mondayOf(start);
    let end = addDays(gridStart, 12 * 7 - 1);
    for (const r of rows) {
      const d = parse(r.start); if (!d) continue;
      const e = addDays(d, Math.max(1, Number(r.days) || 1) - 1);
      if (e > end) end = e;
    }
    const weeks = Math.max(4, Math.ceil((addDays(end, 7) - gridStart) / (7 * DAY)));
    return { gridStart, weeks, width: weeks * COLW };
  }

  function barGeom(row, geo) {
    const d = parse(row.start);
    if (!d) return null;
    const off = Math.round((d - geo.gridStart) / DAY);
    if (off < 0) return null;
    const days = Math.max(1, Number(row.days) || 1);
    return { left: off * DW, width: Math.max(4, days * DW - 2) };
  }

  function render(host, data, opts) {
    opts = opts || {};
    const editable = !!opts.editable;
    const geo = geometry(data);
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const todayOff = Math.round((today - geo.gridStart) / DAY);
    const showToday = todayOff >= 0 && todayOff < geo.weeks * 7;
    let colourIdx = 0;

    let head = '<tr><th class="mlp-sticky mlp-actcol">Activity</th>';
    if (editable) head += '<th class="mlp-small">Start</th><th class="mlp-small">Days</th><th class="mlp-small">%</th><th class="mlp-small mlp-tools"></th>';
    else head += '<th class="mlp-small">Start</th><th class="mlp-small">Days</th><th class="mlp-small">%</th>';
    for (let w = 0; w < geo.weeks; w++) {
      const wc = addDays(geo.gridStart, w * 7);
      head += `<th class="mlp-wk" style="min-width:${COLW}px;max-width:${COLW}px;">W${w + 1}<span>${fmtShort(wc)}</span></th>`;
    }
    head += "</tr>";

    let body = "";
    (data.sections || []).forEach((sec, si) => {
      const secColour = PALETTE[si % PALETTE.length];
      body += `<tr class="mlp-sec" data-sec="${sec.id}">
        <td class="mlp-sticky" colspan="${editable ? 5 : 4}">
          ${editable
            ? `<input class="mlp-secname" data-op="secname" value="${esc(sec.name)}" placeholder="Section name">
               <span class="mlp-secbtns">
                 <button type="button" data-op="addrow" title="Add an activity">＋ Activity</button>
                 <button type="button" data-op="secup" title="Move up">↑</button>
                 <button type="button" data-op="secdown" title="Move down">↓</button>
                 <button type="button" data-op="secdel" title="Remove section">✕</button>
               </span>`
            : `<b>${esc(sec.name)}</b>`}
        </td>
        <td colspan="${geo.weeks}" class="mlp-secfill"></td></tr>`;
      (sec.rows || []).forEach(row => {
        if (!row.colour) row.colour = secColour;
        const g = barGeom(row, geo);
        const prog = Math.max(0, Math.min(100, Number(row.progress) || 0));
        let bar = "";
        if (g) {
          bar = row.milestone
            ? `<div class="mlp-dia" style="left:${g.left - 6}px;background:${esc(row.colour)}" title="${esc(row.name)}"></div>`
            : `<div class="mlp-bar" style="left:${g.left}px;width:${g.width}px;background:${esc(row.colour)}" title="${esc(row.name)} — ${prog}%">
                 <i style="width:${prog}%"></i>${g.width > 70 ? `<span>${prog ? prog + "%" : ""}</span>` : ""}
               </div>`;
        }
        body += `<tr class="mlp-row" data-sec="${sec.id}" data-row="${row.id}">
          <td class="mlp-sticky mlp-actcol">${editable
            ? `<input class="mlp-act" data-op="name" value="${esc(row.name)}" placeholder="Activity">`
            : `<span class="mlp-actro">${esc(row.name) || "&nbsp;"}</span>`}</td>
          <td class="mlp-small">${editable
            ? `<input type="date" class="mlp-date" data-op="start" value="${esc(row.start || "")}">`
            : esc(row.start ? fmtShort(parse(row.start)) : "")}</td>
          <td class="mlp-small">${editable
            ? `<input type="number" min="1" max="365" class="mlp-num" data-op="days" value="${esc(row.days || 1)}" ${row.milestone ? "disabled" : ""}>`
            : (row.milestone ? "◆" : esc(row.days || 1))}</td>
          <td class="mlp-small">${editable
            ? `<input type="number" min="0" max="100" step="5" class="mlp-num" data-op="progress" value="${prog}">`
            : (prog ? prog + "%" : "")}</td>
          ${editable ? `<td class="mlp-small mlp-tools">
              <input type="color" data-op="colour" value="${esc(row.colour)}" title="Bar colour">
              <button type="button" data-op="mile" class="${row.milestone ? "on" : ""}" title="Milestone">◆</button>
              <button type="button" data-op="rowup" title="Move up">↑</button>
              <button type="button" data-op="rowdown" title="Move down">↓</button>
              <button type="button" data-op="rowdel" title="Remove">✕</button>
            </td>` : ""}
          <td colspan="${geo.weeks}" class="mlp-tl"><div class="mlp-tlin" style="width:${geo.width}px;">
            ${showToday ? `<div class="mlp-today" style="left:${todayOff * DW}px"></div>` : ""}${bar}
          </div></td></tr>`;
      });
    });
    if (editable) {
      body += `<tr><td class="mlp-sticky mlp-addsec" colspan="${5 + geo.weeks}">
        <button type="button" data-op="addsec">＋ Add a section</button></td></tr>`;
    }

    host.innerHTML = `<div class="mlp-scroll"><table class="mlp-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
      (opts.watermark ? `<div class="mlp-wm">${esc(opts.watermark)}</div>` : "");

    if (!editable) return;
    const rerender = () => { render(host, data, opts); if (opts.onChange) opts.onChange(data); };
    const findSec = id => (data.sections || []).find(s => s.id === id);

    host.querySelector("tbody").addEventListener("change", e => {
      const op = e.target.getAttribute("data-op"); if (!op) return;
      const tr = e.target.closest("tr");
      const sec = findSec(tr.getAttribute("data-sec"));
      if (!sec) return;
      if (op === "secname") { sec.name = e.target.value; if (opts.onChange) opts.onChange(data); return; }
      const row = (sec.rows || []).find(r => r.id === tr.getAttribute("data-row"));
      if (!row) return;
      if (op === "name") { row.name = e.target.value; if (opts.onChange) opts.onChange(data); return; }
      if (op === "start") row.start = e.target.value;
      else if (op === "days") row.days = Math.max(1, Number(e.target.value) || 1);
      else if (op === "progress") row.progress = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      else if (op === "colour") row.colour = e.target.value;
      rerender();
    });
    host.querySelector("tbody").addEventListener("click", e => {
      const btn = e.target.closest("button[data-op]"); if (!btn) return;
      const op = btn.getAttribute("data-op");
      const tr = btn.closest("tr");
      const secs = data.sections || (data.sections = []);
      if (op === "addsec") { secs.push({ id: uid(), name: "Section " + (secs.length + 1), rows: [] }); rerender(); return; }
      const sec = findSec(tr.getAttribute("data-sec")); if (!sec) return;
      const si = secs.indexOf(sec);
      if (op === "addrow") {
        const last = (sec.rows || [])[sec.rows.length - 1];
        sec.rows.push({ id: uid(), name: "", start: last ? last.start : (data.startDate || nextMonday()), days: 5, progress: 0, colour: "", milestone: false });
        rerender(); return;
      }
      if (op === "secdel") { if (!sec.rows.length || confirm("Remove this section and its activities?")) { secs.splice(si, 1); rerender(); } return; }
      if (op === "secup" && si > 0) { secs.splice(si, 1); secs.splice(si - 1, 0, sec); rerender(); return; }
      if (op === "secdown" && si < secs.length - 1) { secs.splice(si, 1); secs.splice(si + 1, 0, sec); rerender(); return; }
      const row = (sec.rows || []).find(r => r.id === tr.getAttribute("data-row")); if (!row) return;
      const ri = sec.rows.indexOf(row);
      if (op === "rowdel") { sec.rows.splice(ri, 1); rerender(); }
      else if (op === "rowup" && ri > 0) { sec.rows.splice(ri, 1); sec.rows.splice(ri - 1, 0, row); rerender(); }
      else if (op === "rowdown" && ri < sec.rows.length - 1) { sec.rows.splice(ri, 1); sec.rows.splice(ri + 1, 0, row); rerender(); }
      else if (op === "mile") { row.milestone = !row.milestone; rerender(); }
    });
  }

  // Row-level change list — what did the client's copy change vs the issued base?
  function diff(base, mine) {
    const flat = d => { const m = {}; (d.sections || []).forEach(s => (s.rows || []).forEach(r => { m[r.id] = { ...r, _sec: s.name }; })); return m; };
    const a = flat(base || {}), b = flat(mine || {});
    const added = [], removed = [], changed = [];
    for (const id in b) if (!a[id]) added.push(b[id].name || "(unnamed)");
    for (const id in a) if (!b[id]) removed.push(a[id].name || "(unnamed)");
    for (const id in b) {
      if (!a[id]) continue;
      const o = a[id], n = b[id], what = [];
      if (String(o.name || "") !== String(n.name || "")) what.push(`renamed "${o.name}" → "${n.name}"`);
      if (String(o.start || "") !== String(n.start || "")) what.push(`start ${o.start || "—"} → ${n.start || "—"}`);
      if (Number(o.days || 1) !== Number(n.days || 1)) what.push(`duration ${o.days || 1} → ${n.days || 1} days`);
      if (Number(o.progress || 0) !== Number(n.progress || 0)) what.push(`progress ${o.progress || 0}% → ${n.progress || 0}%`);
      if (!!o.milestone !== !!n.milestone) what.push(n.milestone ? "made a milestone" : "no longer a milestone");
      if (what.length) changed.push({ name: n.name || o.name || "(unnamed)", what: what.join(", ") });
    }
    return { added, removed, changed };
  }

  const css = `
  .mlp-scroll{overflow-x:auto;border:1px solid #e3e8ee;border-radius:12px;background:#fff;}
  .mlp-table{border-collapse:separate;border-spacing:0;font:13px 'Segoe UI',system-ui,sans-serif;color:#1f2a37;width:max-content;min-width:100%;}
  .mlp-table th{background:#f4f7fb;color:#334155;font-weight:700;font-size:11.5px;padding:6px 8px;border-bottom:1px solid #e3e8ee;text-align:left;white-space:nowrap;position:sticky;top:0;z-index:3;}
  .mlp-table th.mlp-wk{text-align:center;padding:4px 2px;}
  .mlp-table th.mlp-wk span{display:block;font-weight:600;color:#64748b;font-size:10.5px;}
  .mlp-table td{border-bottom:1px solid #eef2f7;padding:3px 6px;vertical-align:middle;background:#fff;}
  .mlp-sticky{position:sticky;left:0;z-index:2;background:#fff;box-shadow:2px 0 0 #e3e8ee;min-width:210px;max-width:280px;}
  th.mlp-sticky{z-index:4;background:#f4f7fb;}
  .mlp-actcol{width:240px;}
  .mlp-small{white-space:nowrap;font-size:12px;color:#475569;}
  .mlp-sec td{background:#eaf0f8;font-size:13px;color:#003366;padding:6px 8px;}
  .mlp-sec .mlp-sticky{background:#eaf0f8;}
  .mlp-secfill{background:#eaf0f8 !important;}
  .mlp-secname{border:1px solid transparent;background:transparent;font:700 13px 'Segoe UI';color:#003366;padding:3px 6px;border-radius:6px;width:150px;}
  .mlp-secname:focus{border-color:#94a3b8;background:#fff;outline:none;}
  .mlp-secbtns button,.mlp-addsec button,.mlp-tools button{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:2px 7px;font:600 11.5px 'Segoe UI';cursor:pointer;color:#334155;margin-left:3px;}
  .mlp-tools button.on{background:#003b82;color:#fff;border-color:#003b82;}
  .mlp-addsec{padding:8px !important;}
  .mlp-addsec button{font-size:12.5px;padding:6px 12px;}
  .mlp-act{width:100%;border:1px solid transparent;background:transparent;font:13px 'Segoe UI';padding:4px 6px;border-radius:6px;}
  .mlp-act:focus{border-color:#94a3b8;background:#fff;outline:none;}
  .mlp-actro{display:block;padding:4px 2px;font-weight:600;}
  .mlp-date{border:1px solid #dbe3ec;border-radius:6px;font:11.5px 'Segoe UI';padding:3px 4px;width:118px;}
  .mlp-num{border:1px solid #dbe3ec;border-radius:6px;font:12px 'Segoe UI';padding:3px 4px;width:52px;}
  .mlp-tools input[type=color]{width:22px;height:22px;border:none;background:none;padding:0;vertical-align:middle;cursor:pointer;}
  .mlp-tl{padding:0 !important;position:relative;}
  .mlp-tlin{position:relative;height:30px;background:repeating-linear-gradient(90deg,transparent 0,transparent ${COLW - 1}px,#eef2f7 ${COLW - 1}px,#eef2f7 ${COLW}px);}
  .mlp-bar{position:absolute;top:5px;height:20px;border-radius:6px;overflow:hidden;box-shadow:0 1px 2px rgba(16,32,58,.25);}
  .mlp-bar i{display:block;position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.35);}
  .mlp-bar span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font:700 10.5px 'Segoe UI';text-shadow:0 1px 2px rgba(0,0,0,.4);}
  .mlp-dia{position:absolute;top:9px;width:12px;height:12px;transform:rotate(45deg);border-radius:2px;box-shadow:0 1px 2px rgba(16,32,58,.35);}
  .mlp-today{position:absolute;top:0;bottom:0;width:2px;background:#e0344b;opacity:.65;z-index:1;}
  .mlp-wm{text-align:center;font:600 11.5px 'Segoe UI';color:#94a3b8;padding:8px 4px 2px;}
  @media print{.mlp-scroll{overflow:visible;border:none;} .mlp-tools,.mlp-secbtns,.mlp-addsec{display:none !important;}}
  `;
  function ensureCss() {
    if (document.getElementById("mlp-css")) return;
    const s = document.createElement("style");
    s.id = "mlp-css"; s.textContent = css;
    document.head.appendChild(s);
  }
  window.MLProg = {
    blank, uid, diff,
    render(host, data, opts) { ensureCss(); render(host, data, opts); },
  };
})();
