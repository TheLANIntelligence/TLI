/**
 * system-state-bar.js — TLI v1.3 Dashboard Presence Layer
 *
 * Implements:
 *   SystemStateBar  — 36px persistent bar above all panels
 *   ActionCard      — Confirm / Dismiss surface inside Dashboard panel
 *
 * Depends on EventInterpreter being loaded first.
 */

/* global window, document, EventInterpreter */

(function () {
  "use strict";

  if (window.__TLI_SSB_LOADED__) return;
  window.__TLI_SSB_LOADED__ = true;

  const POLL_INTERVAL_MS  = 10_000;
  const IDLE_THRESHOLD_MS = 30 * 60 * 1000;  // 30 minutes
  const IDLE_KEY          = "tli_last_active_ts";

  // ─────────────────────────────────────────────────────────────────────────
  // SystemStateBar
  // ─────────────────────────────────────────────────────────────────────────

  let _ssbPollTimer = null;
  let _ssbState = null, _ssbReceivedAt = 0, _ssbAgeAtReceipt = null;
  let _ssbUnavailable = false, _ssbFetching = false, _ssbRevision = 0;
  let _registeredCount = null, _registeredNames = [], _inventoryAt = 0, _locked = false;
  let _accessPaused = false, _accessMessage = '', _authEpoch = 0;
  let _storageSnapshot = null, _storageCheckedAt = null, _storageServerAt = 0, _storageUnavailable = false;
  const STALE_AFTER_MS = 30_000;
  const validPercent = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  const validTimestamp = value => typeof value === "number" && Number.isFinite(value) && value > 0;

  function _fmtPct(val) { return validPercent(val) ? val.toFixed(0) + "%" : "--"; }

  function _fmtTs(ts) {
    if (!validTimestamp(ts)) return "--";
    const d = new Date(ts * 1000);
    if (!Number.isFinite(d.getTime())) return "--";
    const h = d.getHours(), m = d.getMinutes();
    return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  }

  function _primaryDiskPct(diskByDrive) {
    if (!diskByDrive || typeof diskByDrive !== "object") return null;
    for (const k of ["C:\\", "C:/", "/"]) {
      if (Object.prototype.hasOwnProperty.call(diskByDrive, k)) return diskByDrive[k];
    }
    return Object.values(diskByDrive)[0] ?? null;
  }

  function _renderSSB() {
    const bar = document.getElementById("tli-state-bar");
    if (!bar) return;
    const state = _ssbState || {};
    const age = _ssbAgeAtReceipt === null ? null : _ssbAgeAtReceipt + Math.max(0, Date.now() - _ssbReceivedAt);
    const freshness = _ssbUnavailable || state.probe_error ? "unavailable" : age === null ? "unknown" : age >= STALE_AFTER_MS ? "stale" : "current";
    // A legacy response without a probe time cannot establish that its values are current.
    const cpu = age === null ? null : state.cpu_pct;
    const ram = age === null ? null : state.ram_pct;
    const disk = age === null ? null : _primaryDiskPct(state.disk_pct_by_drive);
    const deviceCount = Number.isInteger(state.device_count) && state.device_count >= 0 ? String(state.device_count) : "--";
    for (const [key, text] of Object.entries({cpu:_fmtPct(cpu), ram:_fmtPct(ram), disk:_fmtPct(disk), dev:deviceCount, ts:_fmtTs(state.last_event_ts)})) {
      const node = bar.querySelector(`.ssb-val[data-metric='${key}']`); if (node) node.textContent = text;
    }
    bar.dataset.freshness = freshness;
    bar.classList.toggle('ssb-stale', freshness !== 'current');
    let message = document.getElementById('ssb-monitoring-status');
    if (!message) {
      message = document.createElement('span'); message.id = 'ssb-monitoring-status';
      message.className = 'ssb-monitoring-status'; message.setAttribute('role', 'status'); bar.appendChild(message);
    }
    const partial = ![cpu, ram, disk].every(validPercent) || deviceCount === "--";
    const labels = { unknown:'Monitoring freshness unknown', unavailable:'Monitoring unavailable', stale:'Readings stale', current:partial ? 'Some readings unavailable' : 'Metrics current' };
    const time = age === null ? '' : ` · last check ${_fmtTs(state.probed_ts)}`;
    const text = _accessMessage || labels[freshness] + (freshness === 'current' ? '' : time);
    if (message.textContent !== text) message.textContent = text;
    message.title = age === null ? 'This host did not provide a successful metrics probe time.' : 'Latest successful metrics probe: ' + new Date(state.probed_ts * 1000).toLocaleString();
    const diskEl = bar.querySelector(".ssb-metric[data-for='disk']");
    if (diskEl) {
      diskEl.classList.toggle("ssb-warn", validPercent(disk) && disk >= 85 && disk < 95);
      diskEl.classList.toggle("ssb-critical", validPercent(disk) && disk >= 95);
    }
  }

  function _observationSnapshot() {
    return { state: _ssbState ? { ..._ssbState } : {},
      observationClock: { receivedAt: _ssbReceivedAt, ageAtReceipt: _ssbAgeAtReceipt },
      monitoringUnavailable: _ssbUnavailable, devCount: _registeredCount, devNames: [..._registeredNames],
      storage: _storageSnapshot, storageCheckedAt: _storageCheckedAt, storageUnavailable: _storageUnavailable };
  }

  function _publishObservation() {
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('tli-system-observation', { detail: _observationSnapshot() }));
    }
  }

  function _normaliseSSBState(payload) {
    if (!payload || typeof payload !== 'object' || payload.ok === false) return null;
    const state = Object.assign({}, payload.state || payload);
    if (payload.state) {
      if (Number.isInteger(payload.smart_home?.count)) state.device_count = payload.smart_home.count;
      else if (Number.isInteger(payload.devCount)) state.device_count = payload.devCount;
      if ((!state.disk_pct_by_drive || !Object.keys(state.disk_pct_by_drive).length) && Array.isArray(payload.storage?.drives)) {
        state.disk_pct_by_drive = {};
        payload.storage.drives.forEach(drive => { if (drive?.mount) state.disk_pct_by_drive[drive.mount] = drive.pct; });
      }
    }
    return state;
  }

  function _acceptSSB(payload, metricsOnly = false) {
    if (_locked) return false;
    const state = _normaliseSSBState(payload); if (!state) return false;
    if (!metricsOnly && (payload.storage || payload.diskData) && (!validTimestamp(payload.ts) || payload.ts >= _storageServerAt)) {
      const storage = payload.storage || payload.diskData;
      if (validTimestamp(payload.ts)) _storageServerAt = payload.ts;
      if (storage.ok === true && validPercent((storage.system || storage).pct)) {
        _storageSnapshot = storage; _storageCheckedAt = Date.now(); _storageUnavailable = false;
      } else _storageUnavailable = true;
    }
    // Metric events carry an old placeholder device_count. Only the registered
    // inventory snapshot can replace the command-center count and names.
    const count = payload.smart_home?.count ?? payload.devCount;
    if (!metricsOnly && Number.isInteger(count) && count >= 0 && (!validTimestamp(payload.ts) || payload.ts >= _inventoryAt)) {
      _registeredCount = count;
      if (validTimestamp(payload.ts)) _inventoryAt = payload.ts;
      _registeredNames = Array.isArray(payload.smart_home?.names) ? payload.smart_home.names.slice() : Array.isArray(payload.devNames) ? payload.devNames.slice() : [];
    }
    if (_registeredCount !== null) state.device_count = _registeredCount;
    if (state.probe_error && _ssbState) {
      for (const key of ['cpu_pct', 'ram_pct']) if (!validPercent(state[key])) state[key] = _ssbState[key];
      if (!state.disk_pct_by_drive || !Object.keys(state.disk_pct_by_drive).length) state.disk_pct_by_drive = _ssbState.disk_pct_by_drive;
    }
    if (validTimestamp(state.probed_ts) && validTimestamp(_ssbState?.probed_ts) && state.probed_ts < _ssbState.probed_ts) return true;
    if (!metricsOnly && payload.node) window.TLIUI?.hostIdentity?.observe({
      id: payload.node.id, name: payload.node.name, observedAt: validTimestamp(payload.ts) ? payload.ts * 1000 : Date.now(),
      source: 'dashboard/command-center',
    });
    _accessPaused = false; _accessMessage = '';
    _ssbRevision++; _ssbState = state; _ssbReceivedAt = Date.now(); _ssbUnavailable = false;
    const serverNow = validTimestamp(payload.ts) ? payload.ts * 1000 : _ssbReceivedAt;
    const age = validTimestamp(state.probed_ts) ? serverNow - state.probed_ts * 1000 : null;
    _ssbAgeAtReceipt = age === null || age < -5000 ? null : Math.max(0, age);
    _renderSSB(); _publishObservation(); return true;
  }

  async function _fetchAndRenderSSB() {
    if (_ssbFetching || _locked || _accessPaused) return;
    _ssbFetching = true; const revision = _ssbRevision, authEpoch = _authEpoch;
    const options = () => ({ cache:'no-store', credentials:'same-origin', signal:AbortSignal.timeout(12000) });
    try {
      let response;
      try { response = await fetch('/dashboard/command-center', options()); }
      catch (_) { if (_locked || authEpoch !== _authEpoch) return; response = await fetch('/dashboard/state', options()); }
      if (_locked || authEpoch !== _authEpoch) return;
      if (response.status === 404) response = await fetch('/dashboard/state', options());
      if (await _checkAccessFailure(response, authEpoch)) return;
      if (!response.ok) throw new Error('Monitoring unavailable');
      const payload = await response.json();
      if (revision === _ssbRevision && !_acceptSSB(payload)) throw new Error('Monitoring response unavailable');
    } catch (_) {
      if (revision === _ssbRevision) { _ssbUnavailable = true; _renderSSB(); _publishObservation(); }
    } finally { _ssbFetching = false; }
  }

  function initSystemStateBar() {
    _renderSSB(); _fetchAndRenderSSB();
    _ssbPollTimer = setInterval(_fetchAndRenderSSB, POLL_INTERVAL_MS);
    // Freshness changes even if an in-flight poll or unchanged metric band emits nothing.
    setInterval(() => { _renderSSB();
      if (_currentAction && _lastActionAvailability !== _actionAvailability(_currentAction)) _paintActionCard();
    }, 1000);
    if (window.EventInterpreter) EventInterpreter.on('state_update', payload => _acceptSSB(payload, true));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ActionCard
  // ─────────────────────────────────────────────────────────────────────────

  let _currentAction = null, _actionPending = null, _actionFetch = null;
  let _actionRevision = 0, _actionMessage = '', _actionState = 'idle';
  let _actionReceivedAt = 0, _lastActionAvailability = '';

  function _actionAvailability(action) {
    if (action?.kind !== 'disk_observation') return 'recorded';
    const target = action.target, observation = action.observation;
    if (!target || target.kind !== 'drive' || !target.host_id || !target.host_name || !target.id || !target.path
        || action.handler !== 'open_visualizer:' + target.path || !observation || !observation.id
        || observation.host_id !== target.host_id || observation.target_id !== target.id
        || observation.scope !== 'host_drive' || observation.metric !== 'disk_percent'
        || !validPercent(observation.value) || observation.value < 85
        || !validTimestamp(observation.observed_at) || !validTimestamp(observation.expires_at)
        || observation.expires_at - observation.observed_at !== 30 || !validTimestamp(action.server_time)) return 'unavailable';
    const now = action.server_time + Math.max(0, Date.now() - _actionReceivedAt) / 1000;
    if (observation.observed_at > now + 5) return 'unavailable';
    return now >= observation.expires_at ? 'expired' : 'current';
  }

  function _actionReviewable(action) {
    return !['expired', 'unavailable'].includes(_actionAvailability(action));
  }

  function _actionPresentation(action) {
    const handler = String(action.handler || '');
    const path = handler.startsWith('open_visualizer:') ? handler.slice('open_visualizer:'.length) : '';
    if (action.kind === 'disk_observation') {
      const availability = _actionAvailability(action), target = action.target || {}, observation = action.observation || {};
      if (availability === 'unavailable') return {title:'Storage suggestion unavailable', context:'The recorded target or observation could not be verified. Refresh suggestions before reviewing.', confirm:'Refresh required', path:''};
      return {title:`Review ${target.path} in Free Space`, path:target.path, confirm:'Open Free Space',
        context:`${target.host_name} · ${target.path} · ${observation.value.toFixed(0)}% used · observed ${new Date(observation.observed_at * 1000).toLocaleString()}. ` +
          (availability === 'expired' ? 'This reading expired. Await a fresh observation; expiry does not prove recovery.' : 'Independent recorded suggestion. Opening Free Space does not scan or select cleanup.')};
    }
    if (path) return { title: `Review ${path} in Free Space`,
      context: 'Independent recorded suggestion; observation time and host were not supplied. Review this location before choosing any cleanup.',
      confirm: 'Open Free Space', path };
    const rename = value => String(value || '').replace(/(?:File |Storage )?Visualizer/g, 'Free Space');
    return { title: rename(action.title), context: rename(action.context), confirm: rename(action.confirm_label || 'Review action'), path: '' };
  }

  function _paintActionCard() {
    const card = document.getElementById('nd-action-card');
    if (!card) return;
    const action = _currentAction;
    _lastActionAvailability = _actionAvailability(action);
    card.hidden = !action && !_actionMessage;
    card.classList.toggle('ac-has-action', !!action);
    card.dataset.state = _actionState;
    card.setAttribute('aria-busy', _actionPending ? 'true' : 'false');
    const presentation = action ? _actionPresentation(action) : null;
    const breakdown = Array.isArray(action?.breakdown) ? action.breakdown.filter(item => typeof item?.gb === 'number' && Number.isFinite(item.gb) && item.gb >= 0) : [];
    card.innerHTML = (action ?
      '<div class="ac-copy"><div class="ac-eyebrow">Recorded suggestion</div>' +
      '<div class="ac-title">' + _esc(presentation.title) + '</div>' +
      '<div class="ac-context">' + _esc(presentation.context) + '</div></div>' +
      (breakdown.length ? '<div class="ac-breakdown">' + breakdown.map(item =>
        '<div class="ac-breakdown-row"><span class="ac-breakdown-label">' + _esc(item.label) + '</span><span class="ac-breakdown-val">' + item.gb.toFixed(1) + ' GB</span></div>').join('') + '</div>' : '') +
      '<div class="ac-buttons"><button type="button" class="ac-btn ac-btn-confirm" id="ac-confirm-btn">' + _esc(_actionPending ? (String(action.handler || '').startsWith('open_') ? 'Opening…' : 'Working…') : presentation.confirm) + '</button>' +
      (action.secondary_label ? '<button type="button" class="ac-btn ac-btn-secondary" id="ac-secondary-btn">' + _esc(action.secondary_label) + '</button>' : '') +
      '<button type="button" class="ac-btn ac-btn-dismiss" id="ac-dismiss-btn">' + _esc(action.dismiss_label || 'Not now') + '</button></div>' : '') +
      '<div id="ac-result" class="ac-result" role="status" aria-live="polite">' + _esc(_actionMessage) + '</div>';
    if (!action) return;
    for (const [id, kind] of [['ac-confirm-btn', 'confirm'], ['ac-secondary-btn', 'secondary'], ['ac-dismiss-btn', 'dismiss']]) {
      const button = document.getElementById(id);
      if (button) { button.disabled = !!_actionPending || _locked || _accessPaused || !_actionReviewable(action); button.addEventListener('click', () => _runAction(kind, action.id)); }
    }
  }

  function _renderActionCard(action) {
    if (_locked || _accessPaused || _actionPending) return;
    if (action && (typeof action !== 'object' || !action.id)) return;
    if (action?.id !== _currentAction?.id) { _actionMessage = ''; _actionState = 'idle'; }
    _actionRevision++;
    _currentAction = action || null;
    _actionReceivedAt = Date.now();
    _paintActionCard();
  }

  function _fetchActionCurrent() {
    if (_locked || _accessPaused || _actionPending) return Promise.resolve(false);
    if (_actionFetch) return _actionFetch;
    const revision = _actionRevision, authEpoch = _authEpoch;
    _actionFetch = (async () => {
      try {
        const response = await fetch('/dashboard/action/current', { credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(10000) });
        if (await _checkAccessFailure(response, authEpoch)) return false;
        if (!response.ok) throw new Error('Suggested actions could not be checked.');
        const action = await response.json();
        if (action && (typeof action !== 'object' || !action.id)) throw new Error('Suggested action response was incomplete.');
        if (!_locked && revision === _actionRevision) _renderActionCard(action);
        return true;
      } catch (error) {
        if (!_locked && revision === _actionRevision) {
          _actionMessage = error.message + (_currentAction ? ' The previous suggestion is retained.' : '');
          _actionState = 'unavailable'; _paintActionCard();
        }
        return false;
      } finally { _actionFetch = null; }
    })();
    return _actionFetch;
  }

  function _runAction(kind, actionId) {
    if (_actionPending) return _actionPending;
    if (_locked || _accessPaused || !_currentAction || _currentAction.id !== actionId) return Promise.resolve(false);
    if (!_actionReviewable(_currentAction)) { _paintActionCard(); return Promise.resolve(false); }
    const reviewedAction = _currentAction;
    const revision = ++_actionRevision, authEpoch = _authEpoch;
    _actionState = 'working';
    _actionMessage = kind === 'dismiss' ? 'Snoozing this suggestion…' : 'Waiting for the action result…';
    let refreshAfter = false, submitted = false, confirmedOutcome = false;
    // Reserve the operation before rendering or starting the request. SSE and
    // command-center updates cannot replace the controls while it is running.
    _actionPending = Promise.resolve().then(async () => {
      try {
        if (_locked || _accessPaused || revision !== _actionRevision || !_actionReviewable(_currentAction)) return false;
        submitted = true;
        const response = await fetch('/dashboard/action/' + kind, {
          method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
          body:JSON.stringify({action_id:actionId}),
        });
        if (await _checkAccessFailure(response, authEpoch, undefined, true)) return false;
        const result = await response.json().catch(() => null);
        if (_locked || _accessPaused || revision !== _actionRevision || authEpoch !== _authEpoch) return false;
        const hasReceipt = result?.receipt && typeof result.receipt === 'object' && !Array.isArray(result.receipt);
        confirmedOutcome = response.ok && typeof result?.ok === 'boolean' && (result.ok === false || kind === 'dismiss' || hasReceipt);
        if (response.ok && result?.ok === true && kind !== 'dismiss' && !hasReceipt) throw new Error('The host returned no action receipt.');
        if (!response.ok || result?.ok !== true || result?.receipt?.ok === false) {
          const detail = result?.receipt?.narrator_msg || result?.receipt?.error || result?.detail;
          throw new Error(typeof detail === 'string' ? detail : 'TLI did not confirm the action result.');
        }
        if (kind !== 'dismiss' && reviewedAction.kind === 'disk_observation'
            && (result.receipt?.navigate_to !== 'panel-visualizer' || result.receipt?.scan_path !== reviewedAction.target.path)) {
          throw new Error('The returned location does not match the reviewed drive. Nothing was opened.');
        }
        if (_locked || _accessPaused || revision !== _actionRevision) return false;
        _actionState = 'completed';
        _actionMessage = kind === 'dismiss' ? 'Suggestion snoozed. No action was run.' : result.receipt?.narrator_msg || 'Action completed.';
        if (kind !== 'secondary') { _currentAction = null; refreshAfter = true; }
        if (kind !== 'dismiss' && result.receipt?.navigate_to) {
          const receipt = result.receipt;
          if (receipt.navigate_to === 'panel-visualizer' && window.TLIDash2?.openStorage) window.TLIDash2.openStorage(receipt.scan_path);
          else if (receipt.scan_path && typeof switchPanelAndScan === 'function') await switchPanelAndScan(receipt.navigate_to, receipt.scan_path);
          else _navigateTo(receipt.navigate_to);
        }
        return true;
      } catch (error) {
        if (!_locked && !_accessPaused && revision === _actionRevision) {
          _actionState = submitted && !confirmedOutcome ? 'unknown' : 'failed';
          _actionMessage = submitted && !confirmedOutcome
            ? 'The action result is unknown; it may have run. Check activity and the affected device before explicitly retrying.'
            : error.message || 'The result was not confirmed. Check activity before retrying.';
          if (typeof showToast === 'function') showToast(_actionMessage, 'error');
        }
        return false;
      } finally {
        _actionPending = null;
        if (!_locked && !_accessPaused && revision === _actionRevision) {
          _paintActionCard();
          document.getElementById('ac-' + kind + '-btn')?.focus();
          // An earlier queue read may still be resolving. Finish that obsolete
          // read before requesting the next action from the new queue state.
          if (refreshAfter) Promise.resolve(_actionFetch).finally(_fetchActionCurrent);
        }
      }
    });
    _paintActionCard();
    return _actionPending;
  }

  function _navigateTo(panelId) {
    // Use TLI's existing panel-switching mechanism if available
    if (window.TLINav && typeof window.TLINav.open === "function") {
      window.TLINav.open(panelId);
      return;
    }
    // Click the matching sidebar nav button (data-panel-target is the correct attribute)
    const navItem = document.querySelector(`[data-panel-target="${panelId}"]`);
    if (navItem) { navItem.click(); return; }
    // Last resort: show the panel directly
    const panel = document.getElementById(panelId);
    if (panel) {
      document.querySelectorAll(".panel-container").forEach(function (p) { p.hidden = true; });
      panel.hidden = false;
    }
  }

  function _esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initActionCard() {
    // Delay slightly so NarratorCard and SystemStateBar load first
    setTimeout(_fetchActionCurrent, 800);

    if (window.EventInterpreter) {
      EventInterpreter.on("action_update", function (payload) {
        // payload.action_id can be null (no pending actions) or a string.
        // Re-fetch rather than rendering from the partial payload.
        _fetchActionCurrent();
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EventPulse
  // ─────────────────────────────────────────────────────────────────────────

  function initEventPulse() {
    const bell = document.getElementById("tli-feed-bell");
    if (!bell) return;

    // Create the dot element
    const dot = document.createElement("span");
    dot.id = "ep-dot";
    dot.className = "ep-dot";
    bell.style.position = "relative";
    bell.appendChild(dot);

    if (window.EventInterpreter) {
      EventInterpreter.on("classified_event", function () {
        dot.classList.remove("ep-pulse");
        // Force reflow to restart animation
        void dot.offsetWidth;
        dot.classList.add("ep-pulse");
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────

  // ─── NarratorCard wiring ──────────────────────────────────────────────────
  // Bridges EventInterpreter narrator_update events → TLIDash2.setEventMessage()

  function initNarratorWiring() {
    if (!window.EventInterpreter) return;

    EventInterpreter.on("narrator_update", function (payload) {
      if (_locked || _accessPaused) return;
      if (window.TLIDash2 && typeof window.TLIDash2.setEventMessage === "function") {
        window.TLIDash2.setEventMessage(payload);
      }
    });

    // Fetch initial narrator state on mount (shown while data loads)
    const authEpoch = _authEpoch;
    fetch("/dashboard/narrator/current", { credentials: "same-origin", signal:AbortSignal.timeout(10000) })
      .then(async function (r) { return await _checkAccessFailure(r, authEpoch) || !r.ok ? null : r.json(); })
      .then(function (msg) {
        if (_locked || _accessPaused || authEpoch !== _authEpoch || !msg || !msg.text) return;
        // Only set if TLIDash2 panel is already open; otherwise it will show on next open
        if (window.TLIDash2 && typeof window.TLIDash2.setEventMessage === "function") {
          window.TLIDash2.setEventMessage(msg);
        }
      })
      .catch(function () {});
  }

  // ─── Return-visit idle detection ─────────────────────────────────────────
  // STUB: AI path not implemented. Backend /dashboard/narrator/current will
  // return a template response. The "while you were away" AI path is deferred.
  // See Section 5.7 of tli_v1.3_presence_layer_prompt.md.

  function _trackActivity() {
    const update = function () {
      try { localStorage.setItem(IDLE_KEY, Date.now().toString()); } catch (_) {}
    };
    ["click", "keydown", "touchstart"].forEach(function (ev) {
      document.addEventListener(ev, update, { passive: true });
    });
  }

  function _checkReturnVisit() {
    if (_locked || _accessPaused) return;
    const authEpoch = _authEpoch;
    try {
      const last = parseInt(localStorage.getItem(IDLE_KEY) || "0", 10);
      if (!last) return;
      const idle = Date.now() - last;
      if (idle > IDLE_THRESHOLD_MS) {
        // STUB: would call AI path narrator; for now just fetches template narrator
        fetch("/dashboard/narrator/current", { credentials: "same-origin", signal:AbortSignal.timeout(10000) })
          .then(async function (r) { return await _checkAccessFailure(r, authEpoch) || !r.ok ? null : r.json(); })
          .then(function (msg) {
            if (_locked || _accessPaused || authEpoch !== _authEpoch || !msg) return;
            if (window.TLIDash2 && typeof window.TLIDash2.setEventMessage === "function") {
              window.TLIDash2.setEventMessage(msg);
            }
          })
          .catch(function () {});
      }
    } catch (_) {}
  }

  function boot() {
    if (window.EventInterpreter) EventInterpreter.init();
    initSystemStateBar();
    initActionCard();
    initEventPulse();
    initNarratorWiring();
    _trackActivity();
    _checkReturnVisit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Expose for external wiring (e.g., app.js NarratorCard integration)
  window.TLIPresence = {
    fetchActionCurrent: _fetchActionCurrent,
    renderActionCard:   _renderActionCard,
    acceptSnapshot: _acceptSSB,
    getObservation: _observationSnapshot,
  };
  function _pausePrivate(message) {
    _authEpoch++; _accessPaused = true; _ssbRevision++; _actionRevision++;
    _ssbState = null; _ssbAgeAtReceipt = null; _registeredCount = null; _registeredNames = []; _inventoryAt = 0;
    _storageSnapshot = null; _storageCheckedAt = null; _storageServerAt = 0; _storageUnavailable = false;
    _ssbUnavailable = true; _currentAction = null; _actionMessage = ''; _actionState = 'locked';
    _accessMessage = message || 'Monitoring paused. Unlock TLI, then retry live activity.';
    _renderSSB(); _paintActionCard(); _publishObservation();
  }
  async function _checkAccessFailure(response, authEpoch, data, mutation = false) {
    if (response.status !== 401 && response.status !== 403) return false;
    const outcomeWarning = ' After restoring access, review activity and current status before retrying; the action may already have run.';
    if (mutation && authEpoch === _authEpoch) {
      // Denied headers are sufficient to hide private action state; a slow or
      // malformed error body must not retain the old action or its receipt.
      _pausePrivate('Browser access changed. Unlock TLI before continuing.' + outcomeWarning);
    }
    if (data === undefined) data = await response.json().catch(() => null);
    const detail = typeof data?.detail === 'string' ? data.detail : undefined;
    const message = mutation ? (detail || 'Browser access changed. Unlock TLI before continuing.') + outcomeWarning : detail;
    if (authEpoch === _authEpoch) _pausePrivate(message);
    else if (mutation && _accessPaused && !_currentAction) {
      // The global 401 interceptor may have cleared this operation first.
      // Retain only the public outcome warning while recovery is still paused.
      _accessMessage = message; _renderSSB();
    }
    return true;
  }
  window.EventInterpreter?.on('access_ready', () => {
    if (_locked) return;
    _accessPaused = false; _accessMessage = '';
    _fetchAndRenderSSB(); Promise.resolve(_actionPending).finally(_fetchActionCurrent);
  });
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('tli-session-locked', () => {
      _locked = true; _pausePrivate();
    });
    window.addEventListener('tli-session-unlocked', () => {
      _locked = false;
    });
  }
})();
