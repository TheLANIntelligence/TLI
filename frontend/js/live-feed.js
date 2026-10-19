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
  let _locked = document.getElementById('tli-lock-screen')?.getAttribute?.('aria-hidden') === 'false', _generation = 0;
  let _accessReady = !_locked;
  const _alertActions = new Set();

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
    if (_locked || !_accessReady) return;
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
          const generation = _generation;
          // Resolve the shell lazily: this script registers before the shell.
          // An event created before coordination exists cannot authorize a write.
          const coordinator = window.TLIShell?.alertOperations;
          const context = coordinator?.capture();
          let pending = null, finished = false;
          const btn = document.createElement("button");
          btn.className = "chip-button lf-action-btn";
          btn.textContent = a.label || "Action";
          const sync = () => {
            if (pending || finished) return;
            btn.disabled = !coordinator || !context || !coordinator.canBegin(context);
            btn.textContent = btn.disabled ? 'Review Alerts' : (a.label || 'Action');
          };
          _alertActions.add(sync);
          if (_alertActions.size > MAX_FEED_ITEMS * 3) _alertActions.delete(_alertActions.values().next().value);
          sync();
          btn.addEventListener("click", async () => {
            if (btn.disabled || pending || _locked || !_accessReady || generation !== _generation) return;
            const request = coordinator?.begin(context);
            if (!request) return;
            pending = request;
            let confirmed = false;
            const current = () => pending === request && generation === _generation && !_locked && _accessReady && coordinator.current(request);
            btn.disabled = true;
            btn.textContent = a.label || 'Action';
            try {
              const response = await fetch(a.endpoint, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
              if (!current()) return;
              if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
              if (!response.ok) throw new Error('Dismissal not confirmed');
              const result = await response.json();
              if (!current()) return;
              const path = new URL(a.endpoint, window.location.origin).pathname;
              const id = path === '/status/alerts/dismiss-all' ? null : decodeURIComponent(path.split('/')[3]);
              if (result?.ok !== true || (id === null ? !Number.isInteger(result.dismissed) || result.dismissed < 0 : result.dismissed !== id)) throw new Error('Dismissal not confirmed');
              btn.textContent = "Done";
              confirmed = true; finished = true;
            } catch { if (current()) { btn.textContent = 'Not confirmed — review Alerts'; btn.disabled = true; finished = true; } }
            finally {
              // A stream pause can retire this button without changing the shell
              // session. Release only our exact token, retaining uncertainty.
              if (coordinator.current(request)) await coordinator.settle(request, confirmed && current());
              if (pending === request) pending = null;
            }
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
      if (_locked || !_accessReady) return;
      document.dispatchEvent(new CustomEvent('tli-activity-event', {detail: ev}));
      _renderEvent(ev);
    });
    window.EventInterpreter.on('access_required', ({message}) => {
      _accessReady = false; _generation++; _seenIds.clear(); _alertActions.clear(); _clearUnread();
      const feed = document.getElementById('nd-feed');
      if (!feed) return;
      feed.replaceChildren();
      const status = document.createElement('p'); status.textContent = message;
      const retry = document.createElement('button'); retry.className = 'chip-button'; retry.textContent = 'Retry live activity';
      retry.addEventListener('click', () => { if (!_locked) window.EventInterpreter.retry(); });
      feed.appendChild(status); feed.appendChild(retry);
    });
    window.EventInterpreter.on('access_ready', () => { if (!_locked) _accessReady = true; document.getElementById('nd-feed')?.replaceChildren(); });
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
  for (const event of ['tli-session-locked','tli-account-changed','tli-user-changed']) window.addEventListener?.(event, () => {
    _locked = true; _accessReady = false; _generation++; _seenIds.clear(); _alertActions.clear(); _clearUnread();
    document.getElementById('nd-feed')?.replaceChildren();
  });
  window.addEventListener?.('tli-session-unlocked', () => { _locked = false; });
  window.addEventListener?.('tli-private-observation-ready', () => { if (!_locked) _accessReady = true; });
  window.addEventListener?.('tli-alert-operation', () => { for (const sync of _alertActions) sync(); });
})();
