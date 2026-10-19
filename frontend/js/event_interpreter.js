/**
 * event_interpreter.js — TLI v1.3 Dashboard Presence Layer
 *
 * Pure-logic module: subscribes to /api/events/stream, classifies
 * incoming events, and fans them out to typed subscribers.
 *
 * Owns one shared stream for dashboard metrics and activity. Pauses while
 * the browser tab is hidden or the session is locked; does not render UI.
 *
 * API:
 *   EventInterpreter.init()          — connect to SSE feed (idempotent)
 *   EventInterpreter.on(type, fn)    — subscribe; type = "state_update" |
 *                                       "narrator_update" | "action_update" |
 *                                       "classified_event" | "*"
 *   EventInterpreter.off(type, fn)   — unsubscribe
 *   EventInterpreter.getLastEvent()  — returns last classified raw event or null
 */

/* global window */

(function () {
  "use strict";

  // Guard: only one instance per page
  if (window.EventInterpreter) return;

  const SSE_URL = "/api/events/stream";
  const RECONNECT_DELAY_MS = 5000;

  // Subscriber map: type → Set<fn>
  const _subs = new Map();
  let _es = null;
  let _lastEvent = null;
  let _reconnectTimer = null;
  let _initialized = false;
  let _locked = false;
  let _pageHidden = false;
  let _accessBlocked = false;
  let _accessCheck = null;
  let _generation = 0;
  let _verifiedSession = false;
  let _verifiedRecovery = false;

  // ─── Subscriber management ───────────────────────────────────────────────

  function on(type, fn) {
    if (!_subs.has(type)) _subs.set(type, new Set());
    _subs.get(type).add(fn);
  }

  function off(type, fn) {
    if (_subs.has(type)) _subs.get(type).delete(fn);
  }

  function _dispatch(type, data) {
    if (_subs.has(type)) {
      _subs.get(type).forEach(function (fn) {
        try { fn(data); } catch (e) { /* subscriber errors must not kill the bus */ }
      });
    }
    if (_subs.has("*")) {
      _subs.get("*").forEach(function (fn) {
        try { fn(type, data); } catch (e) {}
      });
    }
  }

  // ─── Event handling ───────────────────────────────────────────────────────

  function _handleMessage(raw) {
    let ev;
    try { ev = JSON.parse(raw); } catch (_) { return; }
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "auth_required") {
      _denyAccess();
      return;
    }

    // Meta-events (v1.3): have a `type` field, no `title`
    const metaType = ev.type;
    if (
      metaType === "state_update" ||
      metaType === "narrator_update" ||
      metaType === "action_update"
    ) {
      // Keep the server observation clock when unwrapping metric events. The
      // browser clock may differ; freshness must use the host's timestamps.
      const payload = metaType === 'state_update' && ev.payload && typeof ev.payload === 'object' && Number.isFinite(ev.ts)
        ? { ...ev.payload, ts: ev.ts } : ev.payload || ev;
      _dispatch(metaType, payload);
      return;
    }

    // Regular feed events: have a `title`
    if (!ev.title) return;

    _lastEvent = ev;
    const classified = _classify(ev);
    ev._classified = classified;

    _dispatch("classified_event", ev);
  }

  // ─── Classification (mirrors backend classify_event()) ────────────────────

  const _CAT_MAP = {
    system: "system", device: "device", automation: "automation",
    file: "file", vault: "vault", game: "game", power: "device",
    network: "system", usb: "device", mesh: "system", alert: "system",
  };
  const _SEV_MAP = {
    debug: "info", info: "info", notice: "notice", warn: "warning",
    warning: "warning", error: "warning", critical: "critical", alert: "warning",
  };
  const _NARRATOR_CATS = new Set(["system", "device", "automation", "vault"]);
  const _ACTION_LEVELS = new Set(["warning", "critical"]);
  const _ACTION_KW = ["disk", "backup", "usb", "game", "automation", "power", "shelly"];

  function _classify(ev) {
    const rawCat = (ev.category || "system").toLowerCase();
    const rawLvl = (ev.level    || "info").toLowerCase();
    const title  = (ev.title    || "").toLowerCase();
    const body   = (ev.body     || "").toLowerCase();

    const category = _CAT_MAP[rawCat] || "system";
    const severity = _SEV_MAP[rawLvl] || "info";

    const narrator_worthy =
      _NARRATOR_CATS.has(category) || _ACTION_LEVELS.has(severity);

    const action_worthy =
      _ACTION_LEVELS.has(severity) ||
      _ACTION_KW.some(function (kw) { return title.includes(kw) || body.includes(kw); });

    return { category, severity, narrator_worthy, action_worthy };
  }

  // ─── SSE connection ───────────────────────────────────────────────────────

  function _stop() {
    const previous = _es;
    _es = null;
    if (previous) { try { previous.close(); } catch (_) {} }
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
  }

  function _canConnect() {
    return _initialized && !_locked && !_accessBlocked && !_pageHidden &&
      (typeof document === "undefined" || !document.hidden);
  }

  function _denyAccess(message) {
    _accessBlocked = true;
    _lastEvent = null;
    _stop();
    window.dispatchEvent?.(new CustomEvent('tli-session-locked'));
    _dispatch('access_required', {message: message || 'Live activity paused. Unlock TLI before retrying. If the PIN is off, clear this site’s cookies or use a new private window on localhost.'});
    window.TLIPinLock?.checkAndLock();
  }

  // EventSource hides HTTP status. A bounded read uses the same browser
  // authority before reconnecting. Confirmed PIN entry can recover once;
  // PIN-disabled status alone cannot retry a denied browser session.
  function _resumeVerifiedRecovery() {
    if (!_verifiedRecovery || _accessCheck || _locked || _pageHidden ||
        (typeof document !== 'undefined' && document.hidden)) return;
    _verifiedRecovery = false;
    return _checkAccess();
  }

  function _checkAccess() {
    if (_accessCheck || _locked || _pageHidden || (typeof document !== 'undefined' && document.hidden)) return;
    const generation = _generation;
    _accessBlocked = true; // a global 401 -> PIN-off unlock must not retry this read
    _accessCheck = (async () => {
      try {
        const response = await fetch('/api/events/recent?n=0', {cache:'no-store', signal:AbortSignal.timeout(10000)});
        const data = await response.json().catch(() => null);
        if (generation !== _generation) {
          if (response.status === 401 && _accessBlocked && !_es && !_verifiedSession) {
            _dispatch('access_required', {message: typeof data?.detail === 'string' ? data.detail : 'Live activity access expired. Unlock TLI, then retry. If the PIN is off, clear this site’s cookies or use a new private window on localhost.'});
          }
          return;
        }
        if (response.status === 401 || response.status === 403) {
          _denyAccess(typeof data?.detail === 'string' ? data.detail : undefined);
          return;
        }
        if (!response.ok || !Array.isArray(data?.events)) throw new Error('Live activity is unavailable.');
        _accessBlocked = false;
        _dispatch('access_ready', {});
        window.dispatchEvent?.(new CustomEvent('tli-private-observation-ready'));
        _connect();
      } catch (_) {
        if (generation === _generation) _dispatch('access_required', {message:'Live activity is unavailable. Check the host connection, then retry.'});
      }
    })().finally(() => {
      _accessCheck = null;
      // A successful PIN verification can arrive while an older probe is
      // settling. Check once for that new session instead of reusing its reply.
      _resumeVerifiedRecovery();
    });
    return _accessCheck;
  }

  function _connect() {
    if (!_canConnect() || _es || _reconnectTimer) return;
    const stream = new EventSource(SSE_URL);
    _es = stream;

    stream.onmessage = function (e) {
      if (_es === stream && _canConnect()) _handleMessage(e.data);
    };

    stream.onerror = function () {
      if (_es !== stream) return;
      _stop();
      if (_canConnect()) _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        _checkAccess();
      }, RECONNECT_DELAY_MS);
    };
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  function init() {
    _initialized = true;
    _connect();
  }

  function getLastEvent() {
    return _lastEvent;
  }

  window.EventInterpreter = { init, on, off, getLastEvent, retry: _checkAccess };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (_verifiedRecovery) _resumeVerifiedRecovery();
      else if (_canConnect()) _connect();
      else _stop();
    });
  }
  window.addEventListener?.("tli-session-locked", () => {
    _generation++;
    _locked = true;
    _verifiedSession = false;
    _verifiedRecovery = false;
    _lastEvent = null;
    _stop();
  });
  window.addEventListener?.("tli-session-unlocked", event => {
    if (event?.detail?.source === 'pin-verification' && !_verifiedSession) {
      // Coalesce duplicate notifications for this unlock. The read still
      // checks server authority before private observations resume.
      _generation++;
      _locked = false;
      _verifiedSession = true;
      _verifiedRecovery = true;
      _accessBlocked = true;
      _lastEvent = null;
      _stop();
      _resumeVerifiedRecovery();
      return;
    }
    if (!_locked) return;
    _generation++;
    _locked = false;
    if (!_accessBlocked) _checkAccess();
  });
  window.addEventListener?.("pagehide", () => { _pageHidden = true; _stop(); });
  window.addEventListener?.("pageshow", () => {
    _pageHidden = false;
    if (_verifiedRecovery) _resumeVerifiedRecovery();
    else _connect();
  });
})();
