/**
 * event_interpreter.js — TLI v1.3 Dashboard Presence Layer
 *
 * Pure-logic module: subscribes to /api/events/stream, classifies
 * incoming events, and fans them out to typed subscribers.
 *
 * Does NOT render anything. No DOM access. No global side effects
 * beyond its own namespace.
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

  function _connect() {
    if (_es) {
      try { _es.close(); } catch (_) {}
    }
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    _es = new EventSource(SSE_URL);

    _es.onmessage = function (e) {
      _handleMessage(e.data);
    };

    _es.onerror = function () {
      try { _es.close(); } catch (_) {}
      _es = null;
      _reconnectTimer = setTimeout(_connect, RECONNECT_DELAY_MS);
    };
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  function init() {
    if (_es && _es.readyState !== EventSource.CLOSED) return; // idempotent
    _connect();
  }

  function getLastEvent() {
    return _lastEvent;
  }

  window.EventInterpreter = { init, on, off, getLastEvent };
})();
