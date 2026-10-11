/**
 * live-feed.js — TLI Live System Feed
 * =====================================
 * Subscribes to the shared EventInterpreter and renders events into #nd-feed.
 * Falls back gracefully if SSE is unavailable.
 * Never breaks the page — all errors are swallowed.
 */
(function () {
  if (window.__TLI_LIVE_FEED__) return;
  window.__TLI_LIVE_FEED__ = true;

  const MAX_FEED_ITEMS = 40;

  // Track rendered event IDs so SSE reconnect replays don't double-render.
  const _seenIds = new Set();
  const MAX_AGE_MS     = 2 * 60 * 60 * 1000; // suppress events older than 2 h

  // Category → accent color (CSS variable or hex)
  const CAT_COLOR = {
    ai:         "var(--accent)",
    game:       "#22c55e",
    mesh:       "#38bdf8",
    device:     "#a78bfa",
    automation: "#f59e0b",
    system:     "#94a3b8",
    vault:      "#f472b6",
  };

  // Level → dot emoji
  const LEVEL_DOT = {
    ok:    "🟢",
    info:  "🔵",
    warn:  "🟡",
    alert: "🔴",
    critical: "🔴",
    error: "🔴",
    warning: "🟡",
  };

  // ── Notification bell state ────────────────────────────────────────────
  let _unread = 0;

  function _getBell() { return document.getElementById("tli-feed-bell"); }
  function _getBadge() { return document.getElementById("tli-feed-badge"); }

  function _incUnread() {
    try {
      // Only count while not on dashboard
      const dash = document.getElementById("panel-dashboard2");
      if (dash && !dash.hidden) return;
      if (window.TLIShell?.isActivityVisible()) return;
      _unread++;
      const badge = _getBadge();
      if (badge) {
        badge.textContent = _unread > 9 ? "9+" : String(_unread);
        badge.style.display = "flex";
      }
    } catch {}
  }

  function _clearUnread() {
    try {
      _unread = 0;
      const badge = _getBadge();
      if (badge) badge.style.display = "none";
    } catch {}
  }

  function _safeEventActionEndpoint(endpoint) {
    try {
      const u = new URL(String(endpoint || ""), window.location.origin);
      if (u.origin !== window.location.origin) return false;
      return (
        u.pathname === "/status/alerts/dismiss-all" ||
        /^\/status\/alerts\/[^/]+\/dismiss$/.test(u.pathname)
      );
    } catch {
      return false;
    }
  }

  // ── Feed renderer ──────────────────────────────────────────────────────
  function _renderEvent(ev) {
    try {
      const feed = document.getElementById("nd-feed");
      if (!feed) return;

      // Skip already-rendered events (replayed after SSE reconnect).
      const evId = ev.id || "";
      if (evId && _seenIds.has(evId)) return;
      if (evId) {
        _seenIds.add(evId);
        if (_seenIds.size > MAX_FEED_ITEMS * 3) {
          const first = _seenIds.values().next().value;
          _seenIds.delete(first);
        }
      }

      // Skip stale events — anything older than 2 hours is history, not live.
      const evTs = ev.ts ? ev.ts * 1000 : 0;
      if (evTs && (Date.now() - evTs) > MAX_AGE_MS) return;

      // Narrator suppression does not hide recorded activity or escalation.
      const dot   = LEVEL_DOT[ev.level] || "🔵";
      const color = CAT_COLOR[ev.category] || "var(--text-muted)";
      const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const ts    = escape(ev.ts_fmt || new Date(ev.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      const title = escape(ev.title) + (ev.node ? ' · ' + escape(ev.node) : '');
      const body  = escape(ev.body);

      const item = document.createElement("div");
      item.className = "lf-event";
      item.dataset.evId = ev.id || "";

      item.innerHTML =
        `<div class="lf-event-top">` +
          `<span class="lf-dot" style="color:${color};box-shadow:0 0 0 1px ${color};border-radius:50%">${dot}</span>` +
          `<span class="lf-title" style="color:var(--text-main)">${title}</span>` +
          `<span class="lf-ts">${ts}</span>` +
        `</div>` +
        (body ? `<div class="lf-body">${body}</div>` : "");

      // Action buttons
      const safeActions = (ev.actions || []).filter(a => _safeEventActionEndpoint(a.endpoint));
      if (safeActions.length) {
        const actions = document.createElement("div");
        actions.className = "lf-actions";
        safeActions.forEach(a => {
          const btn = document.createElement("button");
          btn.className = "chip-button lf-action-btn";
          btn.textContent = a.label || "Action";
          btn.addEventListener("click", async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            try {
              const response = await fetch(a.endpoint, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
              const result = await response.json();
              if (!response.ok || result.ok !== true) throw new Error('Action failed');
              btn.textContent = "Done";
            } catch { btn.textContent = "Failed — retry"; btn.disabled = false; }
          });
          actions.appendChild(btn);
        });
        item.appendChild(actions);
      }

      feed.insertBefore(item, feed.firstChild);
      while (feed.children.length > MAX_FEED_ITEMS) {
        feed.removeChild(feed.lastChild);
      }
      _incUnread();
    } catch {}
  }

  // Reuse the metrics stream. Another permanent HTTP/1.1 connection here
  // can exhaust browser connection slots when several TLI tabs are open.
  function _connect() {
    if (!window.EventInterpreter) return;
    window.EventInterpreter.on("classified_event", ev => {
      document.dispatchEvent(new CustomEvent('tli-activity-event', {detail: ev}));
      _renderEvent(ev);
    });
    window.EventInterpreter.init();
  }

  // ── Dashboard visibility → clear badge ────────────────────────────────
  function _watchDashboard() {
    try {
      const dash = document.getElementById("panel-dashboard2");
      if (!dash) return;
      const obs = new MutationObserver(() => {
        if (!dash.hidden) _clearUnread();
      });
      obs.observe(dash, { attributes: true, attributeFilter: ["hidden"] });
    } catch {}
  }

  // ── Init ───────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    _connect();
    _watchDashboard();
    document.addEventListener("tli-activity-viewed", _clearUnread);
  });
})();
