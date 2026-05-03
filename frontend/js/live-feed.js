/**
 * live-feed.js — TLI Live System Feed
 * =====================================
 * Subscribes to /api/events/stream and renders events into #nd-feed.
 * Falls back gracefully if SSE is unavailable.
 * Never breaks the page — all errors are swallowed.
 */
(function () {
  if (window.__TLI_LIVE_FEED__) return;
  window.__TLI_LIVE_FEED__ = true;

  const RECONNECT_MS = 5000;
  const MAX_FEED_ITEMS = 40;

  // Track rendered event IDs so SSE reconnect replays don't double-render.
  const _seenIds = new Set();
  // Track title → count to suppress excessive same-title repetition.
  const _titleCount = new Map();
  const MAX_SAME_TITLE = 2;      // show at most 2 of the same title
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

      // Suppress excessive same-title repetition (e.g. "Mesh node offline: X" spamming).
      const evTitle = (ev.title || "").trim();
      const titleKey = evTitle.toLowerCase();
      if (evTitle) {
        const cnt = _titleCount.get(titleKey) || 0;
        if (cnt >= MAX_SAME_TITLE) return;
        _titleCount.set(titleKey, cnt + 1);
      }

      const dot   = LEVEL_DOT[ev.level] || "🟢";
      const color = CAT_COLOR[ev.category] || "var(--text-muted)";
      const ts    = ev.ts_fmt || new Date(ev.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const title = String(ev.title || "").replace(/</g, "&lt;");
      const body  = String(ev.body  || "").replace(/</g, "&lt;");

      const item = document.createElement("div");
      item.className = "lf-event";
      item.dataset.evId = ev.id || "";

      item.innerHTML =
        `<div class="lf-event-top">` +
          `<span class="lf-dot">${dot}</span>` +
          `<span class="lf-title" style="color:${color}">${title}</span>` +
          `<span class="lf-ts">${ts}</span>` +
        `</div>` +
        (body ? `<div class="lf-body">${body}</div>` : "");

      // Action buttons
      if (ev.actions && ev.actions.length) {
        const actions = document.createElement("div");
        actions.className = "lf-actions";
        ev.actions.forEach(a => {
          const btn = document.createElement("button");
          btn.className = "chip-button lf-action-btn";
          btn.textContent = a.label || "Action";
          btn.addEventListener("click", async () => {
            try {
              await fetch(a.endpoint, { method: "POST" });
              btn.textContent = "Done";
              btn.disabled = true;
            } catch { btn.textContent = "Failed"; }
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

  // ── SSE connection ─────────────────────────────────────────────────────
  let _es = null;
  let _reconnectTimer = null;

  function _connect() {
    try {
      if (_es) { _es.close(); _es = null; }
      _es = new EventSource("/api/events/stream");

      _es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev && ev.title) {
            // A genuinely new live event — reset per-title suppression so fresh
            // events of the same name always get through.
            const age = ev.ts ? (Date.now() - ev.ts * 1000) : 0;
            if (age < 10_000) {
              // Event is < 10 s old → real-time; clear its title slot
              const k = (ev.title || "").trim().toLowerCase();
              if (k) _titleCount.set(k, 0);
            }
            _renderEvent(ev);
          }
        } catch {}
      };

      _es.onerror = () => {
        try {
          _es.close();
          _es = null;
          if (_reconnectTimer) clearTimeout(_reconnectTimer);
          _reconnectTimer = setTimeout(_connect, RECONNECT_MS);
        } catch {}
      };
    } catch {}
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
    // Clear badge when user clicks bell
    try {
      const bell = _getBell();
      if (bell) bell.addEventListener("click", () => {
        _clearUnread();
        if (typeof switchPanel === "function") switchPanel("panel-dashboard2");
      });
    } catch {}
  });
})();
