/* day-timesheet.js — the "finish your day" timesheet popup.
 *
 * Shown the moment an engineer clocks off (route.html / engineer-jobs.html /
 * my-day.html), while the day is fresh. It PRE-FILLS the day from what the
 * portal already captured — the shift start/finish and the on-site minutes from
 * each job's status taps — so it's a confirm-and-correct, not a retype. Confirm
 * soft-locks the day (the engineer can still reopen it until the office approves
 * the week) and feeds the per-job hours into job costing.
 *
 *   window.MLDaySheet.open({ date, onDone }) -> Promise(result)
 *
 * Never traps the engineer: the clock-off has already happened before this runs,
 * so a bad signal just queues the confirmation locally and syncs later.
 */
(function () {
  if (window.MLDaySheet) return;
  var API = window.MOSTLANE_API || "https://mostlane-api.jamie-def.workers.dev";

  function tok() { try { return localStorage.getItem("mostlaneToken") || ""; } catch (e) { return ""; } }
  function af(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: "Bearer " + tok() }, opts.headers || {});
    if (opts.body && !opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
    return fetch(API + path, opts);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function todayLocal() { try { return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function q1(n) { return Math.round((Number(n) || 0) * 4) / 4; }   // nearest ¼h
  function fmtDate(d) { try { return new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }); } catch (e) { return d; } }

  function css() {
    if (document.getElementById("ml-day-style")) return;
    var s = document.createElement("style");
    s.id = "ml-day-style";
    s.textContent =
      ".mlds-back{position:fixed;inset:0;background:rgba(6,18,34,.55);z-index:2147483200;display:flex;align-items:flex-end;justify-content:center;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}" +
      ".mlds-sheet{background:#fff;width:100%;max-width:560px;border-radius:18px 18px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.28);max-height:94vh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:0 16px calc(env(safe-area-inset-bottom,0px) + 18px);box-sizing:border-box}" +
      ".mlds-hd{position:sticky;top:0;background:#fff;padding:16px 0 10px;border-bottom:1px solid #eef2f6;z-index:2}" +
      ".mlds-grab{width:40px;height:4px;border-radius:999px;background:#d7dee6;margin:0 auto 12px}" +
      ".mlds-t{font-weight:800;font-size:19px;color:#0e2438;margin:0}" +
      ".mlds-sub{color:#5b6b7b;font-size:13px;margin-top:2px}" +
      ".mlds-sec{margin-top:16px}" +
      ".mlds-lab{font-size:12px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#5b6b7b;margin-bottom:6px}" +
      ".mlds-times{display:flex;gap:10px}" +
      ".mlds-times>div{flex:1}" +
      ".mlds-in{width:100%;box-sizing:border-box;border:1px solid #cfd8e2;border-radius:11px;padding:12px;font-size:16px;color:#0f2438;background:#fff}" +
      ".mlds-in:focus{outline:none;border-color:#003468;box-shadow:0 0 0 3px rgba(0,52,104,.12)}" +
      ".mlds-hint{font-size:12px;color:#3a7a52;margin-top:6px}" +
      ".mlds-job{border:1px solid #e4eaf0;border-radius:13px;padding:11px 12px;margin-bottom:9px}" +
      ".mlds-job .r{display:flex;align-items:center;gap:10px}" +
      ".mlds-job .nm{flex:1;min-width:0}" +
      ".mlds-job .ref{font-weight:700;color:#0e2438;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".mlds-job .site{color:#5b6b7b;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".mlds-hr{width:74px}" +
      ".mlds-hr input{width:100%;box-sizing:border-box;border:1px solid #cfd8e2;border-radius:10px;padding:10px 8px;font-size:16px;text-align:center;color:#0f2438}" +
      ".mlds-cap{font-size:11.5px;color:#8794a2;margin-top:5px}" +
      ".mlds-cap b{color:#3a7a52}" +
      ".mlds-quick{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}" +
      ".mlds-quick button{border:1px solid #cfd8e2;background:#f6f9fc;color:#0e2438;border-radius:999px;padding:5px 11px;font-size:12.5px;font-weight:600;cursor:pointer}" +
      ".mlds-quick button.on{background:#003468;color:#fff;border-color:#003468}" +
      ".mlds-note textarea{width:100%;box-sizing:border-box;border:1px solid #cfd8e2;border-radius:11px;padding:11px;font-size:15px;min-height:64px;color:#0f2438;resize:vertical}" +
      ".mlds-foot{margin-top:18px;position:sticky;bottom:0;background:#fff;padding-bottom:2px}" +
      ".mlds-btn{width:100%;border:none;border-radius:13px;padding:15px;font-size:16px;font-weight:800;cursor:pointer}" +
      ".mlds-btn.primary{background:#003468;color:#fff}" +
      ".mlds-later{display:block;width:100%;text-align:center;background:none;border:none;color:#7a8794;font-size:13px;padding:12px 0 2px;cursor:pointer;text-decoration:underline}" +
      ".mlds-empty{color:#5b6b7b;font-size:14px;background:#f6f9fc;border-radius:12px;padding:14px;text-align:center}" +
      ".mlds-na{color:#8794a2;font-size:12.5px;margin-top:4px;padding:2px 2px 0;line-height:1.4}" +
      ".mlds-one{color:#334;font-size:14px;background:#f6f9fc;border-radius:12px;padding:13px 14px;line-height:1.45}" +
      ".mlds-locked{background:#f6f9fc;border-radius:12px;padding:16px;color:#334;font-size:14.5px;text-align:center}" +
      ".mlds-sum{text-align:center;padding:22px 6px 6px}" +
      ".mlds-sum .tick{width:64px;height:64px;border-radius:50%;background:#e7f6ed;color:#1e9e5a;display:flex;align-items:center;justify-content:center;font-size:34px;margin:0 auto 12px}" +
      ".mlds-sum h3{margin:0 0 4px;font-size:20px;color:#0e2438}" +
      ".mlds-sum p{margin:0;color:#5b6b7b;font-size:14px}" +
      ".mlds-stats{display:flex;gap:10px;margin:18px 0}" +
      ".mlds-stats .s{flex:1;background:#f6f9fc;border-radius:12px;padding:12px 6px}" +
      ".mlds-stats .n{font-size:20px;font-weight:800;color:#003468}" +
      ".mlds-stats .l{font-size:11.5px;color:#5b6b7b;margin-top:2px}" +
      ".mlds-sync{font-size:12.5px;color:#a6710b;background:#fff7e6;border:1px solid #f2e2b8;border-radius:10px;padding:9px 11px;margin-top:12px}";
    document.head.appendChild(s);
  }

  // ── offline queue ──────────────────────────────────────────────────────────
  function qKey(date) { return "mlDaySheet:" + date; }
  function savePending(payload) { try { localStorage.setItem(qKey(payload.date), JSON.stringify(payload)); } catch (e) {} }
  function clearPending(date) { try { localStorage.removeItem(qKey(date)); } catch (e) {} }
  function pendingDates() {
    var out = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf("mlDaySheet:") === 0) out.push(k.slice(11)); } } catch (e) {}
    return out;
  }
  function flushPending() {
    pendingDates().forEach(function (date) {
      var raw; try { raw = localStorage.getItem(qKey(date)); } catch (e) { return; }
      if (!raw) return;
      var payload; try { payload = JSON.parse(raw); } catch (e) { clearPending(date); return; }
      af("/ts/confirm-day", { method: "POST", body: JSON.stringify(payload) })
        .then(function (r) { if (r.ok) clearPending(date); })
        .catch(function () {});
    });
  }

  // ── the sheet ───────────────────────────────────────────────────────────────
  function open(o) {
    o = o || {};
    var date = o.date || todayLocal();
    css();
    return new Promise(function (resolve) {
      var done = false;
      function finish(res) { if (done) return; done = true; teardown(); resolve(res || {}); }

      var back = document.createElement("div");
      back.className = "mlds-back";
      var sheet = document.createElement("div");
      sheet.className = "mlds-sheet";
      back.appendChild(sheet);
      document.body.appendChild(back);
      sheet.innerHTML = '<div class="mlds-hd"><div class="mlds-grab"></div><div class="mlds-t">Finish your day</div><div class="mlds-sub">Loading ' + esc(fmtDate(date)) + '…</div></div>';

      function fitVV() {
        try { var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight; sheet.style.maxHeight = Math.round(h * 0.94) + "px"; } catch (e) {}
      }
      fitVV();
      if (window.visualViewport) { window.visualViewport.addEventListener("resize", fitVV); window.visualViewport.addEventListener("scroll", fitVV); }
      function onFocusIn(e) { if (e.target && e.target.closest && e.target.closest(".mlds-sheet")) setTimeout(function () { try { e.target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (x) {} }, 280); }
      sheet.addEventListener("focusin", onFocusIn);

      function teardown() {
        if (window.visualViewport) { window.visualViewport.removeEventListener("resize", fitVV); window.visualViewport.removeEventListener("scroll", fitVV); }
        if (back && back.parentNode) back.parentNode.removeChild(back);
      }

      af("/ts/day?date=" + encodeURIComponent(date) + "&t=" + Date.now(), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (!d || !d.ok) throw new Error("bad"); render(d); })
        .catch(function () {
          // Couldn't load — don't block the engineer's evening.
          sheet.innerHTML = '<div class="mlds-hd"><div class="mlds-grab"></div><div class="mlds-t">Finish your day</div></div>' +
            '<div class="mlds-sec"><div class="mlds-empty">Couldn\'t load your timesheet just now — no signal? You can finish it from the day-ended screen.</div></div>' +
            '<div class="mlds-foot"><button class="mlds-btn primary" id="mlds-ok">OK</button></div>';
          sheet.querySelector("#mlds-ok").onclick = function () { finish({ error: true }); };
        });

      function render(d) {
        if (d.locked) {
          sheet.innerHTML = '<div class="mlds-hd"><div class="mlds-grab"></div><div class="mlds-t">Finish your day</div><div class="mlds-sub">' + esc(fmtDate(date)) + '</div></div>' +
            '<div class="mlds-sec"><div class="mlds-locked">This week is ' + (d.lockReason === "invoiced" ? "already invoiced" : "locked by the office") + ', so today can\'t be changed here.</div></div>' +
            '<div class="mlds-foot"><button class="mlds-btn primary" id="mlds-ok">OK</button></div>';
          sheet.querySelector("#mlds-ok").onclick = function () { finish({ locked: true }); };
          return;
        }
        var rows = Array.isArray(d.jobs) ? d.jobs : [];
        var na = Array.isArray(d.notAttended) ? d.notAttended : [];
        // Per-job time only earns its place with MULTIPLE jobs. One job (or a
        // project/site day) = the whole day belongs to that one thing, so we just
        // confirm start/finish — no per-job split to fill in.
        var showSplit = rows.length >= 2;
        var naHtml = na.length
          ? '<div class="mlds-na">Not reached today (no time needed): ' + na.map(function (j) { return esc(j.ref); }).join(", ") + '</div>'
          : "";
        var jobsHtml = showSplit ? rows.map(function (j, i) {
          var capH = j.capturedMins > 0 ? q1(j.capturedMins / 60) : 0;
          return '<div class="mlds-job" data-jid="' + esc(j.jobId) + '">' +
            '<div class="r"><div class="nm"><div class="ref">' + esc(j.ref) + '</div>' + (j.site ? '<div class="site">' + esc(j.site) + '</div>' : '') + '</div>' +
            '<div class="mlds-hr"><input type="number" inputmode="decimal" step="0.25" min="0" max="24" value="' + (j.hours || j.hours === 0 ? esc(j.hours) : '') + '" aria-label="Hours on ' + esc(j.ref) + '"></div></div>' +
            (j.capturedMins > 0 ? '<div class="mlds-cap">Recorded on site: <b>' + capH + 'h</b> (' + j.capturedMins + ' min) — adjust if that\'s not right</div>' : '<div class="mlds-cap">No time was recorded automatically — enter how long you were on site</div>') +
            '<div class="mlds-quick">' + [0.5, 1, 1.5, 2, 3].map(function (v) { return '<button type="button" data-v="' + v + '">' + (v === 0.5 ? '½' : (v === 1.5 ? '1½' : v)) + 'h</button>'; }).join("") + '</div>' +
            '</div>';
        }).join("") : "";

        // The job block adapts to how many jobs there were.
        var jobSection;
        if (showSplit) {
          jobSection = '<div class="mlds-sec"><div class="mlds-lab">Time on each job</div>' + jobsHtml + naHtml + '</div>';
        } else {
          var line = rows.length === 1
            ? 'All of today\'s time goes to <b>' + esc(rows[0].ref) + '</b>' + (rows[0].site ? ' — ' + esc(rows[0].site) : '') + '.'
            : 'No jobs to split today — just confirm your hours.';
          jobSection = '<div class="mlds-sec"><div class="mlds-one">' + line + '</div>' + naHtml + '</div>';
        }

        var startHint = d.autoStart && (d.autoStart === d.start) ? '<div class="mlds-hint">⏱ Filled in from your day — check it\'s right</div>' : '';
        var finishHint = d.travelHome ? '<div class="mlds-hint">Includes your drive home — adjust if needed</div>' : '';

        sheet.innerHTML =
          '<div class="mlds-hd"><div class="mlds-grab"></div><div class="mlds-t">Finish your day</div><div class="mlds-sub">' + esc(fmtDate(date)) + ' — confirm your hours while they\'re fresh</div></div>' +
          '<div class="mlds-sec"><div class="mlds-lab">Your day</div><div class="mlds-times">' +
          '<div><input class="mlds-in" id="mlds-start" type="time" step="300" value="' + esc(d.start || "") + '" aria-label="Start time"></div>' +
          '<div><input class="mlds-in" id="mlds-finish" type="time" step="300" value="' + esc(d.finish || "") + '" aria-label="Finish time"></div>' +
          '</div>' + startHint + finishHint + '</div>' +
          jobSection +
          '<div class="mlds-sec mlds-note"><div class="mlds-lab">Anything to add? (optional)</div><textarea id="mlds-note" placeholder="Notes about today…">' + esc(d.note || "") + '</textarea></div>' +
          '<div class="mlds-foot"><button class="mlds-btn primary" id="mlds-confirm">✓ Confirm &amp; finish day</button>' +
          '<button class="mlds-later" id="mlds-later">I\'ll finish this later</button></div>';

        // quick-hour chips
        sheet.querySelectorAll(".mlds-job").forEach(function (jobEl) {
          var input = jobEl.querySelector("input");
          jobEl.querySelectorAll(".mlds-quick button").forEach(function (b) {
            b.onclick = function () { input.value = b.getAttribute("data-v"); syncChips(jobEl); };
          });
          input.addEventListener("input", function () { syncChips(jobEl); });
          syncChips(jobEl);
        });
        function syncChips(jobEl) {
          var v = parseFloat(jobEl.querySelector("input").value);
          jobEl.querySelectorAll(".mlds-quick button").forEach(function (b) { b.classList.toggle("on", parseFloat(b.getAttribute("data-v")) === v); });
        }

        sheet.querySelector("#mlds-later").onclick = function () {
          finish({ skipped: true });
        };
        sheet.querySelector("#mlds-confirm").onclick = function () { submit(d, rows); };
      }

      function submit(d, rows) {
        var btn = sheet.querySelector("#mlds-confirm");
        if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
        var jobHours = {};
        var jobLabels = [];
        var showSplit = rows.length >= 2;
        if (showSplit) {
          sheet.querySelectorAll(".mlds-job").forEach(function (jobEl) {
            var jid = jobEl.getAttribute("data-jid");
            var h = parseFloat(jobEl.querySelector("input").value);
            if (jid && isFinite(h) && h > 0) {
              jobHours[jid] = Math.min(24, Math.round(h * 4) / 4);
              var ref = (rows.find(function (r) { return r.jobId === jid; }) || {}).ref || jid;
              jobLabels.push(ref);
            }
          });
        } else if (rows.length === 1) {
          // Single job / project day: the whole day's time goes to that one job
          // (pre-filled from the shift span server-side).
          var only = rows[0], h1 = parseFloat(only.hours);
          if (only.jobId && isFinite(h1) && h1 > 0) { jobHours[only.jobId] = Math.min(24, Math.round(h1 * 4) / 4); jobLabels.push(only.ref); }
        }
        var payload = {
          date: date,
          start: (sheet.querySelector("#mlds-start") || {}).value || "",
          finish: (sheet.querySelector("#mlds-finish") || {}).value || "",
          note: (sheet.querySelector("#mlds-note") || {}).value || "",
          jobs: jobLabels.join(", "),
          jobHours: jobHours,
        };
        af("/ts/confirm-day", { method: "POST", body: JSON.stringify(payload) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok) {
              // Week locked / validation — surface it, let them close.
              if (btn) { btn.disabled = false; btn.textContent = "✓ Confirm & finish day"; }
              try { if (window.MLUI && MLUI.toast) MLUI.toast((res.j && res.j.error) || "Couldn't save — try again"); else alert((res.j && res.j.error) || "Couldn't save — try again"); } catch (e) {}
              return;
            }
            clearPending(date);
            summary(res.j && res.j.summary, payload, false);
          })
          .catch(function () {
            // Offline — queue it, still show a summary so the day feels done.
            savePending(payload);
            summary(localSummary(payload), payload, true);
          });
      }

      function localSummary(payload) {
        var s = toMin(payload.start), f = toMin(payload.finish);
        var span = (s != null && f != null) ? ((f <= s ? f + 1440 : f) - s) : 0;
        var jt = 0; for (var k in payload.jobHours) jt += Number(payload.jobHours[k]) || 0;
        return { start: payload.start, finish: payload.finish, spanHours: Math.round(span / 60 * 10) / 10, paidHours: Math.round(span / 60 * 10) / 10, jobs: Object.keys(payload.jobHours).length, jobHoursTotal: Math.round(jt * 10) / 10 };
      }
      function toMin(t) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "")); return m ? (+m[1]) * 60 + (+m[2]) : null; }

      function summary(sum, payload, offline) {
        sum = sum || {};
        var hrs = sum.paidHours != null ? sum.paidHours : (sum.spanHours != null ? sum.spanHours : 0);
        sheet.innerHTML =
          '<div class="mlds-hd"><div class="mlds-grab"></div></div>' +
          '<div class="mlds-sum"><div class="tick">✓</div><h3>Day finished</h3><p>' + esc(fmtDate(date)) + '</p></div>' +
          '<div class="mlds-stats">' +
          '<div class="s"><div class="n">' + esc(hrs) + 'h</div><div class="l">On shift</div></div>' +
          '<div class="s"><div class="n">' + esc(sum.jobs || 0) + '</div><div class="l">Jobs logged</div></div>' +
          '<div class="s"><div class="n">' + esc(sum.jobHoursTotal || 0) + 'h</div><div class="l">On-site time</div></div>' +
          '</div>' +
          (offline ? '<div class="mlds-sync">📶 Saved on this phone — it\'ll sync to the office when you\'re back online.</div>' : '') +
          '<div class="mlds-foot"><button class="mlds-btn primary" id="mlds-close">Done</button></div>';
        sheet.querySelector("#mlds-close").onclick = function () { finish({ confirmed: true, offline: offline }); };
      }
    });
  }

  // Un-confirm a day (used on Resume, so the second clock-off re-prompts). Best
  // effort — a failure just means the day stays confirmed, which is harmless.
  function reopen(date) {
    date = date || todayLocal();
    clearPending(date);
    return af("/ts/confirm-day", { method: "POST", body: JSON.stringify({ date: date, reopen: true }) }).catch(function () {});
  }
  // Is a given day already confirmed? Resolves true/false (false on any error).
  function isConfirmed(date) {
    date = date || todayLocal();
    return af("/ts/day?date=" + encodeURIComponent(date) + "&t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { return !!(d && d.ok && d.confirmed); })
      .catch(function () { return false; });
  }

  window.MLDaySheet = { open: open, reopen: reopen, isConfirmed: isConfirmed, flushPending: flushPending, hasPending: function () { return pendingDates().length > 0; } };

  // Sync any queued confirmations when the app regains connectivity / reopens.
  try {
    window.addEventListener("online", flushPending);
    if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(flushPending, 1500);
    else window.addEventListener("load", function () { setTimeout(flushPending, 1500); });
  } catch (e) {}
})();
