/* ============================================================================
 * Mostlane office live-chat widget
 * ----------------------------------------------------------------------------
 * A floating chat launcher (bottom-right) + docked panel, injected on portal
 * pages for OFFICE users by portal-config.js. Backed by the existing
 * /messages/* API (1:1 threads + web push). "Live" via short polling: the open
 * thread refreshes every ~3s, the badge/thread list every ~15s; when the panel
 * is shut the launcher still shows an unread red bubble, and web push delivers
 * an OS notification like every other alert.
 * Field/Story users are excluded here — they use the field app's Inbox tab.
 * ==========================================================================*/
(function () {
  if (window.__mlChatLoaded) return;
  window.__mlChatLoaded = true;

  var API = (window.MOSTLANE_API || "").replace(/\/$/, "");
  var TOKEN = localStorage.getItem("mostlaneToken");
  if (!API || !TOKEN) return;

  var ME = sessionStorage.getItem("mostlaneUser") || localStorage.getItem("mostlaneUser") || "";
  function authFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + TOKEN }, opts.headers || {});
    if (opts.body && !opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
    return fetch(API + path, opts);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function opId() { return (ME || "u") + "-" + (window.performance ? Math.round(performance.now() * 1000) : "") + "-" + (window.__mlOp = (window.__mlOp || 0) + 1); }
  function fmtWhen(v) { try { var d = new Date(v); var t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); var today = new Date(); if (d.toDateString() === today.toDateString()) return t; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + " " + t; } catch (e) { return ""; } }

  // ── Styles ────────────────────────────────────────────────────────────────
  var css = document.createElement("style");
  css.textContent =
    "#mlchat-launch{position:fixed;right:18px;bottom:18px;z-index:99998;width:56px;height:56px;border-radius:50%;" +
    "background:linear-gradient(180deg,#1A4F8F,#003468);color:#fff;border:none;cursor:pointer;font-size:26px;" +
    "box-shadow:0 6px 18px rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;transition:transform .15s;}" +
    "#mlchat-launch:hover{transform:translateY(-2px);}" +
    "#mlchat-badge{position:absolute;top:-3px;right:-3px;min-width:22px;height:22px;padding:0 5px;background:#e11900;color:#fff;" +
    "border-radius:999px;font:700 12px/22px 'Segoe UI',system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);display:none;}" +
    "#mlchat-panel{position:fixed;right:18px;bottom:84px;z-index:99999;width:350px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 110px);" +
    "background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.34);display:none;flex-direction:column;overflow:hidden;" +
    "font-family:'Segoe UI',system-ui,-apple-system,sans-serif;}" +
    "#mlchat-panel.open{display:flex;}" +
    ".mlc-head{background:linear-gradient(180deg,#1A4F8F,#003468);color:#fff;padding:13px 14px;display:flex;align-items:center;gap:10px;flex:none;}" +
    ".mlc-head h3{margin:0;font-size:15px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".mlc-hbtn{background:rgba(255,255,255,.16);border:none;color:#fff;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:16px;flex:none;display:flex;align-items:center;justify-content:center;}" +
    ".mlc-body{flex:1;overflow-y:auto;background:#f3f5f8;}" +
    ".mlc-thread{display:flex;flex-direction:column;gap:8px;padding:12px 12px 16px;align-items:flex-start;}" +
    ".mlc-row{max-width:82%;display:flex;flex-direction:column;min-width:0;}" +
    ".mlc-row.me{align-self:flex-end;align-items:flex-end;}" +
    ".mlc-row.them{align-self:flex-start;align-items:flex-start;}" +
    ".mlc-line{display:flex;align-items:center;gap:5px;max-width:100%;min-width:0;}" +
    ".mlc-row.me .mlc-line{flex-direction:row-reverse;}" +
    ".mlc-bub{min-width:0;padding:8px 11px;border-radius:14px;font-size:14px;line-height:1.35;overflow-wrap:break-word;word-break:normal;white-space:pre-wrap;box-shadow:0 1px 1px rgba(0,0,0,.06);}" +
    ".mlc-row.me .mlc-bub{background:#1d4ed8;color:#fff;border-bottom-right-radius:5px;}" +
    ".mlc-row.them .mlc-bub{background:#fff;color:#0f172a;border-bottom-left-radius:5px;}" +
    ".mlc-when{font-size:10.5px;color:#94a3b8;margin-top:3px;}" +
    ".mlc-del{border:none;background:none;cursor:pointer;font-size:12px;opacity:.32;padding:0 2px;line-height:1;flex:none;}" +
    ".mlc-del:hover{opacity:1;}" +
    ".mlc-readmark{align-self:flex-end;font-size:11px;color:#64748b;padding:0 2px 2px;font-weight:600;}" +
    ".mlc-readmark.read{color:#1d4ed8;}" +
    ".mlc-typing{display:none;font-size:12.5px;color:#64748b;font-style:italic;padding:2px 14px 12px;}" +
    ".mlc-typing.on{display:block;}" +
    ".mlc-typing .dots span{animation:mlcblink 1.2s infinite;}.mlc-typing .dots span:nth-child(2){animation-delay:.2s}.mlc-typing .dots span:nth-child(3){animation-delay:.4s}" +
    "@keyframes mlcblink{0%,60%,100%{opacity:.25}30%{opacity:1}}" +
    ".mlc-item{display:flex;align-items:center;gap:11px;padding:12px 14px;border-bottom:1px solid #eef1f5;cursor:pointer;background:#fff;}" +
    ".mlc-item:hover{background:#f8fafc;}" +
    ".mlc-av{width:38px;height:38px;border-radius:50%;background:#dbe4f0;color:#1A4F8F;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;flex:none;}" +
    ".mlc-it-bd{flex:1;min-width:0;}.mlc-it-name{font-weight:650;font-size:14px;color:#0f172a;display:flex;align-items:center;gap:6px;}" +
    ".mlc-it-last{font-size:12.5px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".mlc-it-when{font-size:11px;color:#9aa4b2;flex:none;}" +
    ".mlc-udot{min-width:18px;height:18px;padding:0 5px;background:#e11900;color:#fff;border-radius:999px;font:700 11px/18px 'Segoe UI',sans-serif;text-align:center;flex:none;}" +
    ".mlc-empty{padding:30px 20px;text-align:center;color:#8a94a2;font-size:13.5px;}" +
    ".mlc-foot{flex:none;border-top:1px solid #e5e7eb;padding:9px 10px;display:flex;gap:8px;align-items:flex-end;background:#fff;}" +
    ".mlc-foot textarea{flex:1;resize:none;border:1px solid #cfd8e0;border-radius:12px;padding:9px 11px;font:14px 'Segoe UI',system-ui,sans-serif;max-height:96px;min-height:20px;outline:none;}" +
    ".mlc-send{background:#1d4ed8;color:#fff;border:none;border-radius:50%;width:40px;height:40px;font-size:17px;cursor:pointer;flex:none;}" +
    ".mlc-send:disabled{opacity:.5;cursor:default;}" +
    ".mlc-search{padding:10px 12px;border-bottom:1px solid #eef1f5;background:#fff;}" +
    ".mlc-search input{width:100%;box-sizing:border-box;border:1px solid #cfd8e0;border-radius:10px;padding:9px 11px;font-size:14px;outline:none;}" +
    "@media(max-width:520px){#mlchat-panel{right:10px;left:10px;width:auto;bottom:80px;height:auto;top:64px;max-height:none;}}";
  document.head.appendChild(css);

  // ── DOM ───────────────────────────────────────────────────────────────────
  var launch = document.createElement("button");
  launch.id = "mlchat-launch"; launch.title = "Messages"; launch.setAttribute("aria-label", "Messages");
  launch.innerHTML = '💬<span id="mlchat-badge"></span>';
  var panel = document.createElement("div");
  panel.id = "mlchat-panel";
  panel.innerHTML =
    '<div class="mlc-head">' +
      '<button class="mlc-hbtn" id="mlc-back" style="display:none;">‹</button>' +
      '<h3 id="mlc-title">Messages</h3>' +
      '<button class="mlc-hbtn" id="mlc-delchat" title="Delete this whole chat" style="display:none;">🗑</button>' +
      '<button class="mlc-hbtn" id="mlc-new" title="New conversation">✎</button>' +
      '<button class="mlc-hbtn" id="mlc-close" title="Close">✕</button>' +
    '</div>' +
    '<div class="mlc-body" id="mlc-body"></div>' +
    '<div class="mlc-foot" id="mlc-foot" style="display:none;">' +
      '<textarea id="mlc-input" rows="1" placeholder="Type a message…"></textarea>' +
      '<button class="mlc-send" id="mlc-sendbtn" title="Send">➤</button>' +
    '</div>';
  function mount() {
    document.body.appendChild(launch);
    document.body.appendChild(panel);
    positionForVaBar();
    wire();
    refreshBadge();
    startSlowPoll();
  }
  // Keep the launcher clear of the purple "View As" bar if it's present.
  function positionForVaBar() {
    var va = document.getElementById("mlVaBar");
    var off = va ? (va.offsetHeight + 12) : 0;
    launch.style.bottom = (18 + off) + "px";
    panel.style.bottom = (84 + off) + "px";
  }

  // ── State ─────────────────────────────────────────────────────────────────
  var open = false, view = "list", curWith = "", lastId = 0, sending = false;
  var readUpTo = 0, myLastId = 0, lastTypingPing = 0;
  var slowTimer = null, fastTimer = null;
  var $ = function (id) { return document.getElementById(id); };
  // Read receipts are shown to ADMINS only (Full Access) — engineers/end users
  // never see whether their message was read.
  var IS_ADMIN = (function () {
    try { var p = JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}"); return String(p.FullAccess || "").toLowerCase() === "yes"; }
    catch (e) { return false; }
  })();

  function setBadge(n) {
    var b = $("mlchat-badge");
    if (!b) return;
    if (n > 0) { b.textContent = n > 9 ? "9+" : n; b.style.display = "block"; }
    else b.style.display = "none";
  }
  function refreshBadge() {
    authFetch("/messages/unread").then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) setBadge(d.unread || 0); }).catch(function () {});
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  function showList() {
    view = "list"; curWith = ""; lastId = 0;
    stopFastPoll();
    $("mlc-title").textContent = "Messages";
    $("mlc-back").style.display = "none";
    $("mlc-new").style.display = "";
    $("mlc-delchat").style.display = "none";
    $("mlc-foot").style.display = "none";
    loadThreads();
  }
  function loadThreads() {
    authFetch("/messages/threads").then(function (r) { return r.json(); }).then(function (d) {
      if (view !== "list") return;
      var threads = (d && d.threads) || [];
      var body = $("mlc-body");
      if (!threads.length) {
        body.innerHTML = '<div class="mlc-empty">No conversations yet.<br>Tap ✎ to message someone.</div>';
        return;
      }
      body.innerHTML = threads.map(function (t) {
        var initial = (t.with || "?").trim().charAt(0).toUpperCase();
        return '<div class="mlc-item" data-with="' + esc(t.with) + '">' +
          '<div class="mlc-av">' + esc(initial) + '</div>' +
          '<div class="mlc-it-bd"><div class="mlc-it-name">' + esc(t.with) +
          (t.unread ? '<span class="mlc-udot">' + (t.unread > 9 ? "9+" : t.unread) + '</span>' : '') + '</div>' +
          '<div class="mlc-it-last">' + esc(t.last || "") + '</div></div>' +
          '<div class="mlc-it-when">' + esc(fmtWhen(t.at)) + '</div></div>';
      }).join("");
      [].forEach.call(body.querySelectorAll(".mlc-item"), function (el) {
        el.onclick = function () { openThread(el.getAttribute("data-with")); };
      });
    }).catch(function () {});
  }

  function openThread(withUser) {
    view = "thread"; curWith = withUser; lastId = 0; readUpTo = 0; myLastId = 0;
    $("mlc-title").textContent = withUser;
    $("mlc-back").style.display = "";
    $("mlc-new").style.display = "none";
    $("mlc-delchat").style.display = IS_ADMIN ? "" : "none";
    $("mlc-foot").style.display = "flex";
    $("mlc-body").innerHTML = '<div class="mlc-empty">Loading…</div>';
    authFetch("/messages/thread?with=" + encodeURIComponent(withUser)).then(function (r) { return r.json(); })
      .then(function (d) {
        if (view !== "thread" || curWith !== withUser) return;
        var msgs = (d && d.messages) || [];
        $("mlc-body").innerHTML = '<div class="mlc-thread" id="mlc-thread"></div>' +
          '<div class="mlc-typing" id="mlc-typing">' + esc(withUser) + ' is typing<span class="dots"><span>.</span><span>.</span><span>.</span></span></div>';
        renderMessages(msgs, true);
        applyThreadMeta(d);
        setTimeout(function () { $("mlc-input").focus(); }, 30);
        refreshBadge();
        startFastPoll();
      }).catch(function () { $("mlc-body").innerHTML = '<div class="mlc-empty">Couldn\'t load this chat.</div>'; });
  }
  function renderMessages(msgs, replace) {
    var host = $("mlc-thread"); if (!host) return;
    if (replace) host.innerHTML = "";
    msgs.forEach(function (m) {
      if (m.id) { if (m.id <= lastId) return; lastId = m.id; if (m.mine) myLastId = m.id; }
      var row = document.createElement("div");
      row.className = "mlc-row " + (m.mine ? "me" : "them");
      if (m.id) row.setAttribute("data-mid", m.id);
      var del = (IS_ADMIN && m.id) ? '<button class="mlc-del" data-del="' + m.id + '" title="Delete message">🗑</button>' : '';
      row.innerHTML = '<div class="mlc-line"><div class="mlc-bub">' + esc(m.body) + '</div>' + del + '</div>' +
        '<div class="mlc-when">' + esc(fmtWhen(m.at)) + '</div>';
      host.appendChild(row);
    });
    scrollDown();
  }
  function scrollDown() { var body = $("mlc-body"); if (body) body.scrollTop = body.scrollHeight; }

  // Apply the live extras from a thread response: typing indicator + (admin only)
  // a read/sent receipt under my most recent message.
  function applyThreadMeta(d) {
    if (!d) return;
    var tip = $("mlc-typing"); if (tip) tip.className = "mlc-typing" + (d.typing ? " on" : "");
    if (typeof d.readUpTo === "number") readUpTo = Math.max(readUpTo, d.readUpTo);
    if (IS_ADMIN) updateReceipt();
    if (d.typing) scrollDown();
  }
  function updateReceipt() {
    var host = $("mlc-thread"); if (!host) return;
    var mark = host.querySelector(".mlc-readmark");
    if (!myLastId) { if (mark) mark.remove(); return; }
    if (!mark) { mark = document.createElement("div"); mark.className = "mlc-readmark"; host.appendChild(mark); }
    else host.appendChild(mark);   // keep it last
    var read = readUpTo >= myLastId;
    mark.textContent = read ? "✓✓ Read" : "✓ Sent";
    mark.classList.toggle("read", read);
  }
  function pollThreadDelta() {
    if (view !== "thread" || !curWith) return;
    authFetch("/messages/thread?with=" + encodeURIComponent(curWith) + "&since=" + lastId)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (view !== "thread") return;
        var msgs = (d && d.messages) || [];
        if (msgs.length) refreshBadge();
        if (msgs.length) renderMessages(msgs, false);
        applyThreadMeta(d);
      }).catch(function () {});
  }
  // Tell the server I'm typing (throttled to once / 2.5s while typing).
  function pingTyping() {
    if (view !== "thread" || !curWith) return;
    var now = Date.now();
    if (now - lastTypingPing < 2500) return;
    lastTypingPing = now;
    authFetch("/messages/typing", { method: "POST", body: JSON.stringify({ to: curWith }) }).catch(function () {});
  }

  function send() {
    var inp = $("mlc-input"); var body = inp.value.trim();
    if (!body || !curWith || sending) return;
    sending = true; $("mlc-sendbtn").disabled = true;
    var op = opId();
    // optimistic echo
    renderMessages([{ mine: true, body: body, at: new Date().toISOString() }], false);
    inp.value = ""; inp.style.height = "auto";
    authFetch("/messages/send", { method: "POST", body: JSON.stringify({ to: curWith, body: body, opId: op }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.id) { if (d.id > lastId) lastId = d.id; myLastId = d.id; if (IS_ADMIN) updateReceipt(); } })
      .catch(function () {})
      .then(function () { sending = false; $("mlc-sendbtn").disabled = false; inp.focus(); });
  }

  // ── New conversation (pick any user) ────────────────────────────────────────
  var USERS = null;
  function showNew() {
    view = "new"; curWith = "";
    stopFastPoll();
    $("mlc-title").textContent = "New message";
    $("mlc-back").style.display = "";
    $("mlc-new").style.display = "none";
    $("mlc-delchat").style.display = "none";
    $("mlc-foot").style.display = "none";
    $("mlc-body").innerHTML =
      '<div class="mlc-search"><input id="mlc-usearch" placeholder="Search people…" autocomplete="off"></div>' +
      '<div id="mlc-ulist"><div class="mlc-empty">Loading people…</div></div>';
    $("mlc-usearch").oninput = function () { renderUsers(this.value); };
    if (USERS) { renderUsers(""); return; }
    authFetch("/users").then(function (r) { return r.json(); }).then(function (d) {
      USERS = ((d && (d.Users || d.users)) || []).filter(function (u) {
        return u.Username && String(u.Username).toLowerCase() !== String(ME).toLowerCase()
          && (!u.Status || u.Status === "Active");
      }).map(function (u) { return { name: u.Username, full: ((u.FirstName || "") + " " + (u.LastName || "")).trim() }; });
      renderUsers("");
    }).catch(function () { var l = $("mlc-ulist"); if (l) l.innerHTML = '<div class="mlc-empty">Couldn\'t load people.</div>'; });
  }
  function renderUsers(q) {
    var l = $("mlc-ulist"); if (!l) return;
    q = (q || "").toLowerCase();
    var list = (USERS || []).filter(function (u) { return !q || u.name.toLowerCase().indexOf(q) > -1 || (u.full && u.full.toLowerCase().indexOf(q) > -1); });
    if (!list.length) { l.innerHTML = '<div class="mlc-empty">No matches.</div>'; return; }
    l.innerHTML = list.map(function (u) {
      var initial = (u.full || u.name).charAt(0).toUpperCase();
      return '<div class="mlc-item" data-with="' + esc(u.name) + '"><div class="mlc-av">' + esc(initial) + '</div>' +
        '<div class="mlc-it-bd"><div class="mlc-it-name">' + esc(u.full || u.name) + '</div>' +
        (u.full ? '<div class="mlc-it-last">' + esc(u.name) + '</div>' : '') + '</div></div>';
    }).join("");
    [].forEach.call(l.querySelectorAll(".mlc-item"), function (el) {
      el.onclick = function () { openThread(el.getAttribute("data-with")); };
    });
  }

  // ── Open / close + polling ─────────────────────────────────────────────────
  function openPanel() {
    open = true; panel.classList.add("open"); positionForVaBar();
    showList();
  }
  function closePanel() {
    open = false; panel.classList.remove("open");
    view = "list"; curWith = ""; stopFastPoll();
    refreshBadge();
  }
  function startSlowPoll() { if (slowTimer) return; slowTimer = setInterval(function () {
    if (!open) { refreshBadge(); return; }
    if (view === "list") loadThreads();
  }, 15000); }
  function startFastPoll() { stopFastPoll(); fastTimer = setInterval(pollThreadDelta, 3000); }
  function stopFastPoll() { if (fastTimer) { clearInterval(fastTimer); fastTimer = null; } }

  function wire() {
    launch.onclick = function () { open ? closePanel() : openPanel(); };
    $("mlc-close").onclick = closePanel;
    $("mlc-back").onclick = showList;
    $("mlc-new").onclick = showNew;
    $("mlc-sendbtn").onclick = send;
    // Admin: delete the whole conversation.
    $("mlc-delchat").onclick = function () {
      if (!IS_ADMIN || !curWith) return;
      if (!confirm("Delete the entire conversation with " + curWith + "? This can't be undone.")) return;
      authFetch("/messages/thread-delete", { method: "POST", body: JSON.stringify({ with: curWith }) })
        .then(function (r) { return r.json(); })
        .then(function () { showList(); refreshBadge(); }).catch(function () {});
    };
    // Admin: delete a single message (delegated — works for polled-in rows too).
    $("mlc-body").addEventListener("click", function (e) {
      var d = e.target.closest ? e.target.closest(".mlc-del") : null;
      if (!d || !IS_ADMIN) return;
      var id = d.getAttribute("data-del");
      if (!id || !confirm("Delete this message?")) return;
      authFetch("/messages/delete", { method: "POST", body: JSON.stringify({ id: parseInt(id, 10) }) })
        .then(function (r) { return r.json(); })
        .then(function () { var row = d.closest(".mlc-row"); if (row) row.remove(); }).catch(function () {});
    });
    var inp = $("mlc-input");
    inp.addEventListener("input", function () { this.style.height = "auto"; this.style.height = Math.min(96, this.scrollHeight) + "px"; pingTyping(); });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    // Re-check the View-As bar occasionally (it mounts after us sometimes).
    setTimeout(positionForVaBar, 400);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { refreshBadge(); if (open && view === "thread") pollThreadDelta(); } });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
