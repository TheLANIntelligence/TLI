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
  let _ssbAnimDone  = false;

  function _fmtPct(val) {
    return typeof val === "number" ? val.toFixed(0) + "%" : "--";
  }

  function _fmtTs(ts) {
    if (!ts) return "--";
    const d = new Date(ts * 1000);
    const h = d.getHours(), m = d.getMinutes();
    const hh = h % 12 || 12;
    const mm = String(m).padStart(2, "0");
    const ampm = h < 12 ? "am" : "pm";
    return `${hh}:${mm}${ampm}`;
  }

  function _primaryDiskPct(diskByDrive) {
    if (!diskByDrive) return null;
    // Prefer C:\ or / ; otherwise first entry
    const preferred = ["C:\\", "C:/", "/"];
    for (const k of preferred) {
      if (diskByDrive[k] !== undefined) return diskByDrive[k];
    }
    const vals = Object.values(diskByDrive);
    return vals.length ? vals[0] : null;
  }

  function _renderSSB(state) {
    const bar = document.getElementById("tli-state-bar");
    if (!bar) return;

    const cpu    = state.cpu_pct  ?? null;
    const ram    = state.ram_pct  ?? null;
    const disk   = _primaryDiskPct(state.disk_pct_by_drive);
    const devCnt = state.device_count ?? 0;
    const lastTs = state.last_event_ts ?? null;

    bar.querySelector(".ssb-val[data-metric='cpu']").textContent  = _fmtPct(cpu);
    bar.querySelector(".ssb-val[data-metric='ram']").textContent  = _fmtPct(ram);
    bar.querySelector(".ssb-val[data-metric='disk']").textContent = disk !== null ? _fmtPct(disk) : "--";
    bar.querySelector(".ssb-val[data-metric='dev']").textContent  = devCnt;
    bar.querySelector(".ssb-val[data-metric='ts']").textContent   = _fmtTs(lastTs);

    // Severity colouring on disk metric
    const diskEl = bar.querySelector(".ssb-metric[data-for='disk']");
    if (diskEl) {
      diskEl.classList.toggle("ssb-warn",     disk >= 85 && disk < 95);
      diskEl.classList.toggle("ssb-critical", disk >= 95);
    }
  }

  // Count-up animation on first load
  function _animateCountUp(state) {
    if (_ssbAnimDone) return;
    _ssbAnimDone = true;
    const targets = {
      cpu:  state.cpu_pct  ?? 0,
      ram:  state.ram_pct  ?? 0,
      disk: _primaryDiskPct(state.disk_pct_by_drive) ?? 0,
    };
    const duration = 800;
    const fps      = 30;
    const steps    = Math.round(duration / (1000 / fps));
    let   step     = 0;

    const timer = setInterval(function () {
      step++;
      const progress = step / steps;
      const bar = document.getElementById("tli-state-bar");
      if (!bar) { clearInterval(timer); return; }

      for (const [key, target] of Object.entries(targets)) {
        const el = bar.querySelector(`.ssb-val[data-metric='${key}']`);
        if (el) {
          const cur = Math.round(progress * target);
          el.textContent = cur + "%";
        }
      }
      if (step >= steps) clearInterval(timer);
    }, 1000 / fps);
  }

  function _fetchAndRenderSSB(isFirst) {
    fetch("/dashboard/state", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) {
        if (!state) return;
        if (isFirst) {
          _animateCountUp(state);
          setTimeout(function () { _renderSSB(state); }, 850);
        } else {
          _renderSSB(state);
        }
      })
      .catch(function () {});
  }

  function initSystemStateBar() {
    _fetchAndRenderSSB(true);
    _ssbPollTimer = setInterval(function () { _fetchAndRenderSSB(false); }, POLL_INTERVAL_MS);

    if (window.EventInterpreter) {
      EventInterpreter.on("state_update", function (payload) {
        _renderSSB(payload);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ActionCard
  // ─────────────────────────────────────────────────────────────────────────

  let _currentAction = null;

  function _renderBreakdown(breakdown) {
    if (!breakdown || !breakdown.length) return "";
    var rows = breakdown.map(function (item) {
      return (
        '<div class="ac-breakdown-row">' +
          '<span class="ac-breakdown-dot"></span>' +
          '<span class="ac-breakdown-label">' + _esc(item.label) + "</span>" +
          '<span class="ac-breakdown-val">' + _esc(item.gb.toFixed(1)) + " GB</span>" +
        "</div>"
      );
    });
    return '<div class="ac-breakdown">' + rows.join("") + "</div>";
  }

  function _renderActionCard(action) {
    const card = document.getElementById("nd-action-card");
    if (!card) return;

    _currentAction = action;

    if (!action) {
      card.innerHTML = `<div class="ac-idle">No actions needed right now.</div>`;
      card.classList.remove("ac-has-action");
      return;
    }

    var hasSecondary = action.secondary_label && action.secondary_label.length > 0;
    var breakdownHtml = _renderBreakdown(action.breakdown);

    card.classList.add("ac-has-action");
    card.innerHTML =
      '<div class="ac-title">' + _esc(action.title) + "</div>" +
      breakdownHtml +
      (breakdownHtml ? "" : '<div class="ac-context">' + _esc(action.context) + "</div>") +
      '<div class="ac-buttons">' +
        '<button class="ac-btn ac-btn-confirm" id="ac-confirm-btn">' + _esc(action.confirm_label) + "</button>" +
        (hasSecondary
          ? '<button class="ac-btn ac-btn-secondary" id="ac-secondary-btn">' + _esc(action.secondary_label) + "</button>"
          : "") +
        '<button class="ac-btn ac-btn-dismiss" id="ac-dismiss-btn">' + _esc(action.dismiss_label) + "</button>" +
      "</div>";

    document.getElementById("ac-confirm-btn").addEventListener("click", function () {
      _confirmAction(action.id);
    });
    if (hasSecondary) {
      document.getElementById("ac-secondary-btn").addEventListener("click", function () {
        _secondaryAction(action.id);
      });
    }
    document.getElementById("ac-dismiss-btn").addEventListener("click", function () {
      _dismissAction(action.id);
    });
  }

  function _fetchActionCurrent() {
    fetch("/dashboard/action/current", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (action) { _renderActionCard(action); })
      .catch(function () {});
  }

  function _confirmAction(actionId) {
    const btn = document.getElementById("ac-confirm-btn");
    if (btn) {
      btn.disabled = true;
      // Show context-appropriate in-progress label
      var isCleanup = _currentAction && _currentAction.handler === "cleanup_clean_safe";
      btn.textContent = isCleanup ? "Cleaning…" : "Running…";
    }

    fetch("/dashboard/action/confirm", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body:    JSON.stringify({ action_id: actionId }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res) return;
        // Navigate if the handler says to
        if (res.receipt && res.receipt.navigate_to) {
          var panelId  = res.receipt.navigate_to;
          var scanPath = res.receipt.scan_path || "";
          if (scanPath && typeof switchPanelAndScan === "function") {
            // Navigate AND pre-load the suggested path (e.g. open_visualizer:C:\)
            switchPanelAndScan(panelId, scanPath);
          } else {
            _navigateTo(panelId);
          }
        }
        // Fetch next action after a short pause
        setTimeout(_fetchActionCurrent, 500);
      })
      .catch(function () {
        setTimeout(_fetchActionCurrent, 500);
      });
  }

  function _dismissAction(actionId) {
    const card = document.getElementById("nd-action-card");
    if (card) card.classList.add("ac-sliding-out");

    fetch("/dashboard/action/dismiss", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body:    JSON.stringify({ action_id: actionId }),
    })
      .then(function () {
        setTimeout(function () {
          if (card) card.classList.remove("ac-sliding-out");
          _fetchActionCurrent();
        }, 350);
      })
      .catch(function () {
        if (card) card.classList.remove("ac-sliding-out");
        setTimeout(_fetchActionCurrent, 350);
      });
  }

  function _secondaryAction(actionId) {
    const btn = document.getElementById("ac-secondary-btn");
    if (btn) { btn.disabled = true; }

    fetch("/dashboard/action/secondary", {
      method:      "POST",
      headers:     { "Content-Type": "application/json" },
      credentials: "same-origin",
      body:        JSON.stringify({ action_id: actionId }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res) return;
        if (res.receipt && res.receipt.navigate_to) {
          var panelId  = res.receipt.navigate_to;
          var scanPath = res.receipt.scan_path || "";
          if (scanPath && typeof switchPanelAndScan === "function") {
            switchPanelAndScan(panelId, scanPath);
          } else {
            _navigateTo(panelId);
          }
        }
        // Re-enable the button — action stays in queue after "Review Files"
        if (btn) { btn.disabled = false; }
      })
      .catch(function () {
        if (btn) { btn.disabled = false; }
      });
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
      if (window.TLIDash2 && typeof window.TLIDash2.setEventMessage === "function") {
        window.TLIDash2.setEventMessage(payload);
      }
    });

    // Fetch initial narrator state on mount (shown while data loads)
    fetch("/dashboard/narrator/current", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (msg) {
        if (!msg || !msg.text) return;
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
    try {
      const last = parseInt(localStorage.getItem(IDLE_KEY) || "0", 10);
      if (!last) return;
      const idle = Date.now() - last;
      if (idle > IDLE_THRESHOLD_MS) {
        // STUB: would call AI path narrator; for now just fetches template narrator
        fetch("/dashboard/narrator/current", { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (msg) {
            if (!msg) return;
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
  };
})();
