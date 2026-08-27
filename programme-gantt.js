// Shared job-programme renderer — used by programme-edit.html (editable) and
// programme-view.html (client copy: read-only, or editable in suggest mode).
// One source of truth so the client sees exactly what the office built.
//
// v2 — matches Jamie's Excel programme model: DAY columns (dd/mm + weekday,
// weekends shaded), tasks = Works · Contractor · Start · End(computed) · Days ·
// Wknd flag (end date skips weekends unless Wknd), bars coloured by CONTRACTOR
// (editable legend), per-contractor filtering (the workbook's per-contractor
// tabs), and a computed Start / End / Days-on-programme summary.
//
//   MLProg.render(host, data, { editable, onChange, watermark, contractor })
//   MLProg.migrate(data)     → normalises v1 {sections} drafts to v2 {tasks}
//   MLProg.blank()           → a new empty programme
//   MLProg.uid()             → id
//   MLProg.diff(base, mine)  → task-level change list
//   MLProg.summary(data)     → { start, end, days } (dates as Date or null)
//   MLProg.filterFor(data, contractorId) → deep copy holding only their tasks
//
// Data shape (v2):
// { title, client, site, ref, notes,
//   contractors:[{ id, name, colour }],
//   tasks:[{ id, name, contractor, start:"YYYY-MM-DD", days, wknd, progress, milestone }] }
(function () {
  const DAY = 86400000;
  const DAYW = 30;                    // px per day column
  // Jamie's workbook legend palette (Mostlane cyan first), then extras.
  const PALETTE = ["#00B0F0", "#92D050", "#FFC000", "#852C98", "#7F7F7F", "#e0344b", "#0369a1", "#b45309"];

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const p2 = n => String(n).padStart(2, "0");
  const ymd = d => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  function parse(s) { const d = new Date(String(s || "") + "T12:00:00"); return isNaN(d) ? null : d; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  const isWeekend = d => { const w = d.getDay(); return w === 0 || w === 6; };
  // data.holidays = ["YYYY-MM-DD", …] bank holidays (snapshotted into the
  // programme by the builder, so issued revisions keep the dates they were
  // planned against). A non-working day = weekend OR bank holiday.
  const holSet = data => { const m = new Set(); for (const h of (data && data.holidays) || []) m.add(String(h)); return m; };
  const nonWork = (d, hs) => isWeekend(d) || (hs && hs.has(ymd(d)));
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];
  function fmtDM(d) { return p2(d.getDate()) + "/" + p2(d.getMonth() + 1); }
  function fmtFull(d) { return p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + "/" + d.getFullYear(); }

  // End date, Excel-WORKDAY style: `days` working days from start, weekends
  // skipped — unless the task's Wknd flag says it runs through the weekend.
  function endOf(task, hs) {
    const s = parse(task.start);
    if (!s) return null;
    // 730-day ceiling: no typo (or hostile suggestion payload) can make the
    // end-date loop or the bar maths run away.
    const days = Math.min(730, Math.max(1, Number(task.days) || 1));
    if (task.wknd) return addDays(s, days - 1);   // Wknd = works weekends AND bank holidays
    let d = new Date(s), left = days - 1, guard = 0;
    while (left > 0 && guard++ < 4000) { d = addDays(d, 1); if (!nonWork(d, hs)) left--; }
    return d;
  }
  const worksDay = (task, d, hs) => task.wknd || !nonWork(d, hs);

  function blank() {
    return {
      title: "", client: "", site: "", ref: "", notes: "",
      contractors: [{ id: uid(), name: "Mostlane", colour: PALETTE[0] }],
      tasks: [],
    };
  }

  // v1 drafts stored {sections:[{rows}]} — flatten and keep going.
  function migrate(data) {
    data = data && typeof data === "object" ? data : {};
    if (!Array.isArray(data.contractors) || !data.contractors.length) {
      data.contractors = [{ id: uid(), name: "Mostlane", colour: PALETTE[0] }];
    }
    if (!Array.isArray(data.tasks)) data.tasks = [];
    if (Array.isArray(data.sections)) {
      for (const sec of data.sections) for (const r of (sec.rows || [])) {
        data.tasks.push({ id: r.id || uid(), name: r.name || "", contractor: "", start: r.start || "", days: r.days || 1, wknd: false, progress: r.progress || 0, milestone: !!r.milestone, extra: !!r.extra });
      }
      delete data.sections;
    }
    return data;
  }

  function summary(data) {
    let start = null, end = null;
    const hs = holSet(data);
    for (const t of (data.tasks || [])) {
      const s = parse(t.start); if (!s) continue;
      const e = endOf(t, hs);
      if (!start || s < start) start = s;
      if (e && (!end || e > end)) end = e;
    }
    return { start, end, days: (start && end) ? Math.round((end - start) / DAY) + 1 : 0 };
  }

  function filterFor(data, contractorId) {
    const d = JSON.parse(JSON.stringify(data || {}));
    if (!contractorId) return d;
    d.tasks = (d.tasks || []).filter(t => t.contractor === contractorId);
    return d;
  }

  function contractorOf(data, id) { return (data.contractors || []).find(c => c.id === id) || null; }

  // The grid is capped at 550 day columns (~18 months) so ONE mistyped year
  // (2072 for 2027) can never ask the browser to draw tens of thousands of
  // columns and hang a phone. The cap window is anchored on where most tasks
  // actually sit; anything outside it is listed but flagged instead of drawn.
  const MAX_GRID_DAYS = 550;
  function geometry(data) {
    const hs = holSet(data);
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const starts = (data.tasks || []).map(t => parse(t.start)).filter(Boolean).sort((a, b) => a - b);
    if (!starts.length) return { gridStart: today, days: 30, width: 30 * DAYW, offGrid: [], sumStart: null, sumEnd: null };
    // Anchor on the median start — a lone wild date (1926/2072) can't drag the
    // whole grid away from the real programme.
    const anchor = starts[Math.floor(starts.length / 2)];
    const near = t => { const s = parse(t.start); return s && Math.abs(s - anchor) / DAY <= MAX_GRID_DAYS; };
    let start = null, end = null;
    for (const t of (data.tasks || [])) {
      if (!near(t)) continue;
      const s = parse(t.start), e = endOf(t, hs);
      if (!start || s < start) start = s;
      if (e && (!end || e > end)) end = e;
    }
    if (!start) { start = anchor; end = addDays(anchor, 29); }
    let days = Math.max(14, Math.round((addDays(end, 3) - start) / DAY) + 1);
    if (days > MAX_GRID_DAYS) days = MAX_GRID_DAYS;
    const gridStart = start;
    const gridEndCap = addDays(gridStart, days - 1);
    const offGrid = (data.tasks || []).filter(t => {
      const s = parse(t.start); if (!s) return false;
      const e = endOf(t, hs) || s;
      return e < gridStart || s > gridEndCap;
    }).map(t => ({ name: t.name || "(unnamed)", start: t.start }));
    // Header summary uses the same sane window, so one wild date can't claim
    // a "17,000 days on programme".
    return { gridStart, days, width: days * DAYW, offGrid, sumStart: start, sumEnd: end };
  }

  function render(host, data, opts) {
    opts = opts || {};
    migrate(data);
    const editable = !!opts.editable;
    const view = opts.contractor ? filterFor(data, opts.contractor) : data;
    const tasks = view.tasks || [];
    const hs = holSet(data);
    const geo = geometry(tasks.length ? view : data);
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const todayOff = Math.round((today - geo.gridStart) / DAY);
    const sum = geo.sumStart
      ? { start: geo.sumStart, end: geo.sumEnd, days: Math.round((geo.sumEnd - geo.sumStart) / DAY) + 1 }
      : { start: null, end: null, days: 0 };

    // Two header rows: date (dd/mm) + weekday letter; weekend columns shaded.
    let hDates = "", hDows = "";
    for (let i = 0; i < geo.days; i++) {
      const d = addDays(geo.gridStart, i);
      const bh = !isWeekend(d) && hs.has(ymd(d));
      const we = isWeekend(d) ? " mlp-we" : (bh ? " mlp-bh" : "");
      const tt = bh ? ' title="Bank holiday"' : "";
      hDates += `<th class="mlp-day${we}"${tt}>${fmtDM(d)}</th>`;
      hDows += `<th class="mlp-dow${we}"${tt}>${bh ? "BH" : DOW[d.getDay()]}</th>`;
    }
    const leftCols = editable ? 7 : 6;
    const worksW = Math.max(120, Math.min(560, Number(data.worksW) || 230));
    let head = `<tr><th class="mlp-sticky mlp-actcol" rowspan="2">Works${editable ? '<div class="mlp-resize" title="Drag to widen the Works column"></div>' : ""}</th>
      <th class="mlp-small" rowspan="2">Contractor</th>
      <th class="mlp-small" rowspan="2">Start</th>
      <th class="mlp-small" rowspan="2">End</th>
      <th class="mlp-small" rowspan="2">Days</th>
      <th class="mlp-small" rowspan="2" title="Works through weekends and bank holidays">Wknd</th>
      ${editable ? '<th class="mlp-small mlp-tools" rowspan="2"></th>' : ""}${hDates}</tr><tr>${hDows}</tr>`;

    // Weekend + bank-holiday shading behind every row.
    let weBg = "";
    for (let i = 0; i < geo.days; i++) {
      const d = addDays(geo.gridStart, i);
      if (isWeekend(d)) weBg += `<i class="mlp-webg" style="left:${i * DAYW}px"></i>`;
      else if (hs.has(ymd(d))) weBg += `<i class="mlp-bhbg" style="left:${i * DAYW}px"></i>`;
    }

    let body = "";
    tasks.forEach(t => {
      const c = contractorOf(data, t.contractor);
      const colour = (c && c.colour) || "#94a3b8";
      const s = parse(t.start), e = endOf(t, hs);
      const prog = Math.max(0, Math.min(100, Number(t.progress) || 0));
      // Bar segments: consecutive worked days (weekends split the bar unless Wknd).
      let segs = "";
      if (s && e) {
        const marked = [];
        for (let d = new Date(s); d <= e; d = addDays(d, 1)) {
          if (!worksDay(t, d, hs)) continue;
          const off = Math.round((d - geo.gridStart) / DAY);
          if (off >= 0 && off < geo.days) marked.push(off);   // clip to the grid
        }
        const progCut = Math.ceil(marked.length * prog / 100);       // worked days counted as done
        let i = 0, done = 0;
        while (i < marked.length) {
          let j = i;
          while (j + 1 < marked.length && marked[j + 1] === marked[j] + 1) j++;
          const len = j - i + 1;
          const doneHere = Math.max(0, Math.min(len, progCut - done)); done += doneHere;
          segs += `<div class="mlp-bar${t.extra ? " extra" : ""}" style="left:${marked[i] * DAYW + 1}px;width:${len * DAYW - 2}px;background:${esc(colour)}" title="${esc(t.name)}${t.extra ? " — extra works" : ""}${prog ? " — " + prog + "%" : ""}">
                     ${doneHere ? `<i style="width:${(doneHere / len) * 100}%"></i>` : ""}</div>`;
          i = j + 1;
        }
        if (t.milestone && marked.length) segs = `<div class="mlp-dia${t.extra ? " extra" : ""}" style="left:${marked[0] * DAYW + DAYW / 2 - 6}px;background:${esc(colour)}" title="${esc(t.name)}${t.extra ? " — extra works" : ""}"></div>`;
      }
      body += `<tr class="mlp-row" data-row="${t.id}">
        <td class="mlp-sticky mlp-actcol">${editable
          ? `<textarea class="mlp-act" data-op="name" rows="1" placeholder="Works / task">${esc(t.name)}</textarea>`
          : `<span class="mlp-actro">${esc(t.name) || "&nbsp;"}</span>`}</td>
        <td class="mlp-small">${editable
          ? `<select class="mlp-sel" data-op="contractor" style="border-left:5px solid ${esc(colour)};">
               <option value="">—</option>${(data.contractors || []).map(x => `<option value="${esc(x.id)}" ${x.id === t.contractor ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`
          : `<span class="mlp-chip" style="background:${esc(colour)};color:#fff;">${esc(c ? c.name : "")}</span>`}</td>
        <td class="mlp-small">${editable
          ? `<input type="date" class="mlp-date" data-op="start" value="${esc(t.start || "")}">`
          : (s ? fmtDM(s) : "")}</td>
        <td class="mlp-small mlp-end">${e ? fmtDM(e) : ""}</td>
        <td class="mlp-small">${editable
          ? `<input type="number" min="1" max="365" class="mlp-num" data-op="days" value="${esc(t.days || 1)}">`
          : esc(t.days || 1)}</td>
        <td class="mlp-small" style="text-align:center;">${editable
          ? `<input type="checkbox" data-op="wknd" ${t.wknd ? "checked" : ""} title="Works through weekends and bank holidays">`
          : (t.wknd ? "✓" : "")}</td>
        ${editable ? `<td class="mlp-small mlp-tools">
            <input type="number" min="0" max="100" step="5" class="mlp-num" data-op="progress" value="${prog}" title="Progress %">
            <button type="button" data-op="extra" class="mlp-xtra ${t.extra ? "on" : ""}" title="Mark as extra works">✚</button>
            <button type="button" data-op="mile" class="${t.milestone ? "on" : ""}" title="Milestone">◆</button>
            <button type="button" data-op="rowup" title="Move up">↑</button>
            <button type="button" data-op="rowdown" title="Move down">↓</button>
            <button type="button" data-op="rowdel" title="Remove">✕</button>
          </td>` : ""}
        <td colspan="${geo.days}" class="mlp-tl"><div class="mlp-tlin" style="width:${geo.width}px;">
          ${weBg}${todayOff >= 0 && todayOff < geo.days ? `<div class="mlp-today" style="left:${todayOff * DAYW}px"></div>` : ""}${segs}
        </div></td></tr>`;
    });
    if (!tasks.length) {
      body += `<tr><td class="mlp-sticky mlp-emptyrow" colspan="${leftCols}">${editable ? "No tasks yet — press ＋ Add a task." : "No tasks."}</td><td colspan="${geo.days}"></td></tr>`;
    }
    if (editable) {
      body += `<tr><td class="mlp-sticky mlp-addsec" colspan="${leftCols + geo.days}">
        <button type="button" data-op="addrow">＋ Add a task</button></td></tr>`;
    }

    const sumLine = sum.start
      ? `<div class="mlp-sum"><b>Start</b> ${fmtFull(sum.start)} · <b>End</b> ${fmtFull(sum.end)} · <b>${sum.days} days on programme</b></div>`
      : "";
    // Small key — only shown when the programme actually has extra works marked.
    const keyLine = (tasks.some(t => t.extra))
      ? `<div class="mlp-key"><span class="mlp-keyswatch"></span> Extra works</div>`
      : "";
    const offWarn = (geo.offGrid && geo.offGrid.length)
      ? `<div class="mlp-warn">⚠ ${geo.offGrid.length} task${geo.offGrid.length === 1 ? "" : "s"} sit${geo.offGrid.length === 1 ? "s" : ""} far outside this programme's dates and ${geo.offGrid.length === 1 ? "isn't" : "aren't"} drawn — check the date${geo.offGrid.length === 1 ? "" : "s"}: ${geo.offGrid.slice(0, 3).map(o => esc(o.name) + " (" + esc(o.start) + ")").join(", ")}${geo.offGrid.length > 3 ? "…" : ""}</div>`
      : "";
    host.innerHTML = sumLine + keyLine + offWarn +
      `<div class="mlp-scroll"><table class="mlp-table" style="--maw:${worksW}px"><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
      (opts.watermark ? `<div class="mlp-wm">${esc(opts.watermark)}</div>` : "");

    if (!editable) return;
    const rerender = () => { render(host, data, opts); if (opts.onChange) opts.onChange(data); };
    const tbody = host.querySelector("tbody");

    // The task-name field is a textarea so long names WRAP and can be read in
    // full. Auto-grow it to its content (JS fallback for browsers without
    // field-sizing:content); size the ones already on screen after render.
    const sizeTA = el => { el.style.height = "auto"; el.style.height = (el.scrollHeight + 2) + "px"; };
    tbody.querySelectorAll("textarea.mlp-act").forEach(sizeTA);
    tbody.addEventListener("input", e => {
      if (e.target.getAttribute("data-op") !== "name") return;
      const tr = e.target.closest("tr");
      const t = (data.tasks || []).find(x => x.id === tr.getAttribute("data-row"));
      if (t) t.name = e.target.value;
      sizeTA(e.target);
      if (opts.onChange) opts.onChange(data);
    });

    tbody.addEventListener("change", e => {
      const op = e.target.getAttribute("data-op"); if (!op) return;
      const tr = e.target.closest("tr");
      const t = (data.tasks || []).find(x => x.id === tr.getAttribute("data-row"));
      if (!t) return;
      if (op === "name") { t.name = e.target.value; if (opts.onChange) opts.onChange(data); return; }
      if (op === "start") t.start = e.target.value;
      else if (op === "days") t.days = Math.max(1, Number(e.target.value) || 1);
      else if (op === "progress") t.progress = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      else if (op === "contractor") t.contractor = e.target.value;
      else if (op === "wknd") t.wknd = e.target.checked;
      rerender();
    });
    tbody.addEventListener("click", e => {
      const btn = e.target.closest("button[data-op]"); if (!btn) return;
      const op = btn.getAttribute("data-op");
      const tasks = data.tasks || (data.tasks = []);
      if (op === "addrow") {
        const last = tasks[tasks.length - 1];
        const defC = opts.contractor || (last ? last.contractor : ((data.contractors[0] || {}).id || ""));
        tasks.push({ id: uid(), name: "", contractor: defC, start: last ? last.start : ymd(new Date()), days: 1, wknd: false, progress: 0, milestone: false, extra: false });
        rerender(); return;
      }
      const tr = btn.closest("tr");
      const t = tasks.find(x => x.id === tr.getAttribute("data-row")); if (!t) return;
      const i = tasks.indexOf(t);
      if (op === "rowdel") { tasks.splice(i, 1); rerender(); }
      else if (op === "rowup" && i > 0) { tasks.splice(i, 1); tasks.splice(i - 1, 0, t); rerender(); }
      else if (op === "rowdown" && i < tasks.length - 1) { tasks.splice(i, 1); tasks.splice(i + 1, 0, t); rerender(); }
      else if (op === "mile") { t.milestone = !t.milestone; rerender(); }
      else if (op === "extra") { t.extra = !t.extra; rerender(); }
    });

    // Drag the Works column edge to widen/narrow it. Live-updates the CSS var so
    // there's no reflow of the whole table mid-drag; persists on release. The
    // stored data.worksW flows through to the PDF and Excel exports.
    const handle = host.querySelector(".mlp-resize");
    const tableEl = host.querySelector(".mlp-table");
    if (handle && tableEl) {
      handle.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX;
        const startW = Math.max(120, Math.min(560, Number(data.worksW) || 230));
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        const move = ev => {
          const w = Math.max(120, Math.min(560, startW + (ev.clientX - startX)));
          data.worksW = Math.round(w);
          tableEl.style.setProperty("--maw", data.worksW + "px");
        };
        const up = ev => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
          if (opts.onChange) opts.onChange(data);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    }
  }

  // Task-level change list — what did the client's copy change vs the base?
  function diff(base, mine) {
    base = migrate(JSON.parse(JSON.stringify(base || {})));
    mine = migrate(JSON.parse(JSON.stringify(mine || {})));
    const names = d => { const m = {}; (d.contractors || []).forEach(c => { m[c.id] = c.name; }); return m; };
    const cn = Object.assign(names(base), names(mine));
    const flat = d => { const m = {}; (d.tasks || []).forEach(t => { m[t.id] = t; }); return m; };
    const a = flat(base), b = flat(mine);
    const added = [], removed = [], changed = [];
    for (const id in b) if (!a[id]) added.push(b[id].name || "(unnamed)");
    for (const id in a) if (!b[id]) removed.push(a[id].name || "(unnamed)");
    for (const id in b) {
      if (!a[id]) continue;
      const o = a[id], n = b[id], what = [];
      if (String(o.name || "") !== String(n.name || "")) what.push(`renamed "${o.name}" → "${n.name}"`);
      if (String(o.start || "") !== String(n.start || "")) what.push(`start ${o.start || "—"} → ${n.start || "—"}`);
      if (Number(o.days || 1) !== Number(n.days || 1)) what.push(`duration ${o.days || 1} → ${n.days || 1} days`);
      if (String(o.contractor || "") !== String(n.contractor || "")) what.push(`contractor ${cn[o.contractor] || "—"} → ${cn[n.contractor] || "—"}`);
      if (!!o.wknd !== !!n.wknd) what.push(n.wknd ? "now works the weekend" : "no longer works the weekend");
      if (Number(o.progress || 0) !== Number(n.progress || 0)) what.push(`progress ${o.progress || 0}% → ${n.progress || 0}%`);
      if (!!o.milestone !== !!n.milestone) what.push(n.milestone ? "made a milestone" : "no longer a milestone");
      if (!!o.extra !== !!n.extra) what.push(n.extra ? "marked as extra works" : "no longer extra works");
      if (what.length) changed.push({ name: n.name || o.name || "(unnamed)", what: what.join(", ") });
    }
    return { added, removed, changed };
  }

  const css = `
  .mlp-sum{font:600 13px 'Segoe UI',system-ui,sans-serif;color:#003366;background:#ddebf7;border:1px solid #9dc3e6;border-radius:9px;padding:7px 12px;margin-bottom:8px;display:inline-block;}
  .mlp-warn{font:600 12.5px 'Segoe UI',system-ui,sans-serif;color:#92400e;background:#fef3c7;border:1px solid #f59e0b;border-radius:9px;padding:7px 12px;margin:0 0 8px 8px;display:inline-block;}
  .mlp-scroll{overflow-x:auto;border:1px solid #e3e8ee;border-radius:12px;background:#fff;}
  .mlp-table{border-collapse:separate;border-spacing:0;font:13px 'Segoe UI',system-ui,sans-serif;color:#1f2a37;width:max-content;table-layout:fixed;}
  .mlp-table th,.mlp-table td{box-sizing:border-box;}
  .mlp-table th{background:#f4f7fb;color:#334155;font-weight:700;font-size:11.5px;padding:5px 7px;border-bottom:1px solid #e3e8ee;text-align:left;white-space:nowrap;position:sticky;top:0;z-index:3;}
  .mlp-table th.mlp-day{text-align:center;padding:3px 1px;font-size:9px;font-weight:600;color:#475569;min-width:${DAYW}px;max-width:${DAYW}px;border-left:1px solid #eef2f7;}
  .mlp-table th.mlp-dow{text-align:center;padding:1px;font-size:9.5px;font-weight:700;color:#64748b;top:20px;border-left:1px solid #eef2f7;}
  th.mlp-we{background:#e8edf4 !important;color:#94a3b8 !important;}
  th.mlp-bh{background:#fdeeda !important;color:#b45309 !important;}
  .mlp-table td{border-bottom:1px solid #eef2f7;padding:3px 6px;vertical-align:middle;background:#fff;}
  .mlp-sticky{position:sticky;left:0;z-index:2;background:#fff;box-shadow:2px 0 0 #e3e8ee;}
  th.mlp-sticky{z-index:4;background:#f4f7fb;}
  .mlp-actcol{width:var(--maw,230px);min-width:var(--maw,230px);max-width:var(--maw,230px);position:relative;}
  .mlp-resize{position:absolute;top:0;right:0;bottom:0;width:8px;cursor:col-resize;touch-action:none;}
  .mlp-resize::after{content:"";position:absolute;top:50%;right:2px;transform:translateY(-50%);width:2px;height:16px;background:#b6c4d6;border-radius:2px;}
  .mlp-resize:hover::after{background:#1A4F8F;}
  .mlp-small{white-space:nowrap;font-size:12px;color:#475569;}
  .mlp-end{color:#0f766e;font-weight:600;}
  .mlp-chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:700;}
  .mlp-emptyrow{color:#94a3b8;font-size:12.5px;padding:14px 8px !important;}
  .mlp-addsec{padding:8px !important;}
  .mlp-addsec button,.mlp-tools button{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:2px 7px;font:600 11.5px 'Segoe UI';cursor:pointer;color:#334155;margin-left:3px;}
  .mlp-addsec button{font-size:12.5px;padding:6px 12px;}
  .mlp-tools button.on{background:#003b82;color:#fff;border-color:#003b82;}
  .mlp-act{display:block;width:100%;border:1px solid transparent;background:transparent;font:13px 'Segoe UI';padding:4px 6px;border-radius:6px;resize:none;overflow:hidden;line-height:1.3;min-height:26px;white-space:pre-wrap;word-break:break-word;field-sizing:content;}
  .mlp-act:focus{border-color:#94a3b8;background:#fff;outline:none;}
  .mlp-actro{display:block;padding:4px 2px;font-weight:600;white-space:pre-wrap;word-break:break-word;line-height:1.3;}
  .mlp-date{border:1px solid #dbe3ec;border-radius:6px;font:11.5px 'Segoe UI';padding:3px 4px;width:118px;}
  .mlp-num{border:1px solid #dbe3ec;border-radius:6px;font:12px 'Segoe UI';padding:3px 4px;width:52px;}
  .mlp-sel{border:1px solid #dbe3ec;border-radius:6px;font:12px 'Segoe UI';padding:3px 4px;max-width:130px;}
  .mlp-tl{padding:0 !important;position:relative;}
  .mlp-tlin{position:absolute;top:0;bottom:0;left:0;min-height:30px;background:repeating-linear-gradient(90deg,transparent 0,transparent ${DAYW - 1}px,#eef2f7 ${DAYW - 1}px,#eef2f7 ${DAYW}px);}
  .mlp-webg{position:absolute;top:0;bottom:0;width:${DAYW}px;background:#f1f4f9;}
  .mlp-bhbg{position:absolute;top:0;bottom:0;width:${DAYW}px;background:#fdf3e5;}
  .mlp-bar{position:absolute;top:50%;transform:translateY(-50%);height:20px;border-radius:999px;overflow:hidden;box-shadow:0 1px 2px rgba(16,32,58,.25);}
  .mlp-bar i{display:block;position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.4);}
  /* Extra works: a bold dashed amber outline so it stands out from normal bars
     without losing the contractor colour. Matches the PDF export's amber ring. */
  .mlp-bar.extra{outline:2px dashed #b45309;outline-offset:1px;overflow:visible;}
  .mlp-dia.extra{outline:2px dashed #b45309;outline-offset:2px;}
  .mlp-dia{position:absolute;top:calc(50% - 6px);width:12px;height:12px;transform:rotate(45deg);border-radius:2px;box-shadow:0 1px 2px rgba(16,32,58,.35);}
  .mlp-xtra.on{background:#fff4e6 !important;border-color:#f0b775 !important;color:#b45309 !important;}
  .mlp-key{display:inline-flex;align-items:center;gap:6px;font:600 12px 'Segoe UI';color:#8a4b0a;background:#fff7ed;border:1px solid #f4d8b4;border-radius:8px;padding:4px 10px;margin:2px 0 8px;}
  .mlp-keyswatch{display:inline-block;width:20px;height:11px;border-radius:3px;background:#cbd5e1;outline:2px dashed #b45309;outline-offset:1px;}
  .mlp-today{position:absolute;top:0;bottom:0;width:2px;background:#e0344b;opacity:.65;z-index:1;}
  .mlp-wm{text-align:center;font:600 11.5px 'Segoe UI';color:#94a3b8;padding:8px 4px 2px;}
  @media print{.mlp-scroll{overflow:visible;border:none;} .mlp-tools,.mlp-addsec{display:none !important;}}
  `;
  function ensureCss() {
    if (document.getElementById("mlp-css")) return;
    const s = document.createElement("style");
    s.id = "mlp-css"; s.textContent = css;
    document.head.appendChild(s);
  }
  window.MLProg = {
    blank, uid, diff, migrate, summary, filterFor,
    PALETTE,
    render(host, data, opts) { ensureCss(); render(host, data, opts); },
  };
})();
