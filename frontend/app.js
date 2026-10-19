// ---------- helpers ----------
function $(id) { return document.getElementById(id); }

// =====================================================
// Server OS detection
// Populated at bootstrap from /agent/ping { os: "Windows"|"Darwin"|"Linux" }
// Used throughout to adapt paths, placeholders, and feature visibility.
// =====================================================
window.TLI_SERVER_OS = "Windows"; // safe default until fetch resolves

function _tliIsWindows() { return window.TLI_SERVER_OS === "Windows"; }
function _tliIsMac()     { return window.TLI_SERVER_OS === "Darwin";  }
function _tliIsLinux()   { return window.TLI_SERVER_OS === "Linux";   }

// Real paths fetched from backend — populated by _tliLoadCommonPaths()
window.TLI_PATHS = null; // { home, common: {downloads, desktop, ...}, extras: [...] }
let _tliPathsEpoch = 0, _tliPathsLocked = false;

function _tliHomePath() {
  return (window.TLI_PATHS && window.TLI_PATHS.home) || "~";
}

function _tliPathPreset(kind) {
  // Use real server paths when available
  if (window.TLI_PATHS && window.TLI_PATHS.common) {
    const real = window.TLI_PATHS.common[kind];
    if (real) return real;
  }
  // Fallback: build from home
  const home = _tliHomePath();
  const sep  = _tliIsWindows() ? "\\" : "/";
  const map  = {
    downloads: home + sep + "Downloads",
    desktop:   home + sep + "Desktop",
    documents: home + sep + "Documents",
    pictures:  home + sep + "Pictures",
    videos:    home + sep + (_tliIsMac() ? "Movies" : "Videos"),
    music:     home + sep + "Music",
    home:      home,
  };
  return map[kind] || home;
}

async function _tliLoadCommonPaths() {
  if (_tliPathsLocked) return;
  const epoch = ++_tliPathsEpoch;
  try {
    const r = await fetch("/visualizer/paths", {credentials:'same-origin',cache:'no-store'});
    if (!r.ok) return;
    const data = await r.json();
    if (epoch !== _tliPathsEpoch || _tliPathsLocked || !data || typeof data.home !== 'string' || !data.common || typeof data.common !== 'object') return;
    window.TLI_PATHS = data;
    _tliApplyPathSuggestions(data);
    document.dispatchEvent(new CustomEvent("tli:paths-loaded", { detail: data }));
  } catch { /* non-fatal */ }
}
window.addEventListener('tli-session-locked', () => {
  _tliPathsLocked = true; _tliPathsEpoch++; window.TLI_PATHS = null;
  document.getElementById('visualizerPathSuggestions')?.replaceChildren();
  const field = document.getElementById('visualizerPathInput');
  if (field) field.placeholder = 'Choose a drive or enter an absolute folder path';
});
window.addEventListener('tli-session-unlocked', () => { _tliPathsLocked = false; _tliLoadCommonPaths(); });

function _tliApplyPathSuggestions(data) {
  try {
    // Visualizer: real placeholder + datalist suggestions
    const scanInput = document.getElementById("visualizerPathInput");
    if (scanInput && data.home) {
      scanInput.placeholder = data.home;
    }
    const dl = document.getElementById("visualizerPathSuggestions");
    if (dl && data.common) {
      dl.innerHTML = "";
      Object.values(data.common).forEach(p => {
        if (!p) return;
        const opt = document.createElement("option");
        opt.value = p;
        dl.appendChild(opt);
      });
      (data.extras || []).forEach(e => {
        const opt = document.createElement("option");
        opt.value = e.path;
        opt.label = e.label;
        dl.appendChild(opt);
      });
    }
    // File Organizer: real placeholder
    const foInput = document.getElementById("filesRootInput");
    if (foInput && data.common && data.common.downloads) {
      foInput.placeholder = "Or type a custom path — e.g. " + data.home;
    }
  } catch { /* non-fatal */ }
}

function _tliApplyServerOS(os) {
  window.TLI_SERVER_OS = os;
  // Real paths (with actual username) are populated by _tliLoadCommonPaths()
  // which is called right after this at bootstrap. Only set generic fallbacks
  // here if the paths fetch hasn't resolved yet.
  if (!window.TLI_PATHS) {
    const scanInput = document.getElementById("visualizerPathInput");
    if (scanInput && !scanInput.placeholder) {
      scanInput.placeholder = _tliIsWindows() ? "C:\\Users\\..." : "/home/...";
    }
  }

  // Printers banner: non-Windows gets an info note
  const printersBanner = document.getElementById("tli-printers-os-note");
  if (printersBanner) {
    if (!_tliIsWindows()) {
      printersBanner.textContent =
        "Printer management uses native OS APIs. Full support on Windows; " +
        (os === "Darwin" ? "macOS" : "Linux") + " shows basic info only.";
      printersBanner.hidden = false;
    } else {
      printersBanner.hidden = true;
    }
  }
}

// Fetch server OS as early as possible, then load real filesystem paths
fetch("/agent/ping")
  .then(r => r.ok ? r.json() : null)
  .then(d => { if (d && d.os) _tliApplyServerOS(d.os); })
  .catch(() => {})
  .finally(() => { _tliLoadCommonPaths(); });

// [module] See /js/tli-games.js
// [module] See /js/tli-system.js


// The first-run experience is owned by /js/onboarding.js.

// ===============================
// Assistant text formatting (safe)
// ===============================
function renderAssistantHTML(raw) {
  let t = String(raw || "");
  t = t.replace(/\r\n/g, "\n");

  // Insert line breaks before common list markers that often get jammed together.
  t = t.replace(/([^\n])(\n?\s*\d{1,2}[.)]\s+)/g, "$1\n$2");                 // 1) / 1.
  t = t.replace(/([^\n])(\n?\s*[-•]\s+)/g, "$1\n$2");                        // - / •
  t = t.replace(/([^\n])(\n?\s*(✅|❌|➡️|🔧|🟩|🟥|🟦|🟨)\s+)/g, "$1\n$2");     // emoji bullets

  // Reduce excessive blank lines
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  // Escape HTML then convert newlines to <br>
  const escaped = t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return escaped.replace(/\n/g, "<br>");
}

// ============================================
// UPLIFT 3.2 — LM Studio report fetch (throttle + backoff + de-noise)
// Why: prevent console noise / repeated 500 spam when LM Studio is down.
// ============================================
const _LMSTUDIO_REPORT_CACHE = {
  ts: 0,
  nextAllowed: 0,
  ttlMs: 10000,
  inFlight: null,
  payload: null,
  failCount: 0,
};

async function tliFetchLMStudioReport({ force = false } = {}) {
  const now = Date.now();

  // If TLI is running in Bundled mode, don't probe LM Studio (avoids 500 spam)
  try {
    const prov = (AIStatus && AIStatus.local && AIStatus.local.provider) ? String(AIStatus.local.provider).toLowerCase() : "";
    if (prov === "bundled") {
      return { ok: false, skipped: true, reason: "bundled_mode" };
    }
  } catch {}

  // Respect nextAllowed (server backoff hint or local throttle)
  if (!force && _LMSTUDIO_REPORT_CACHE.payload && now < _LMSTUDIO_REPORT_CACHE.nextAllowed) {
    return _LMSTUDIO_REPORT_CACHE.payload;
  }

  // TTL throttle
  if (!force && _LMSTUDIO_REPORT_CACHE.payload && (now - _LMSTUDIO_REPORT_CACHE.ts) < _LMSTUDIO_REPORT_CACHE.ttlMs) {
    return _LMSTUDIO_REPORT_CACHE.payload;
  }

  if (_LMSTUDIO_REPORT_CACHE.inFlight) {
    try { return await _LMSTUDIO_REPORT_CACHE.inFlight; } catch { /* fall through */ }
  }

  _LMSTUDIO_REPORT_CACHE.inFlight = (async () => {
    try {
      const res = await fetch("/health/lmstudio/report", { cache: "no-store" });
      let rep = null;

      if (res.ok) {
        rep = await res.json().catch(() => null);
      } else {
        // Backend may still return JSON; best-effort.
        rep = await res.json().catch(() => ({ ok: false, http_status: res.status }));
      }

      if (!rep || typeof rep !== "object") rep = { ok: false };
      rep.ok = rep.ok === true;

      // Backoff hints: server provides backoff_s when down.
      const backoffS = Number(rep.backoff_s || 0);
      if (!rep.ok && backoffS > 0) {
        _LMSTUDIO_REPORT_CACHE.nextAllowed = now + Math.max(500, backoffS * 1000);
      } else {
        _LMSTUDIO_REPORT_CACHE.nextAllowed = now + _LMSTUDIO_REPORT_CACHE.ttlMs;
      }

      _LMSTUDIO_REPORT_CACHE.ts = now;
      _LMSTUDIO_REPORT_CACHE.payload = rep;
      _LMSTUDIO_REPORT_CACHE.failCount = rep.ok ? 0 : (_LMSTUDIO_REPORT_CACHE.failCount + 1);
      return rep;
    } catch {
      // Quiet failure (no console spam)
      const rep = { ok: false, error: "unreachable" };
      _LMSTUDIO_REPORT_CACHE.ts = now;
      _LMSTUDIO_REPORT_CACHE.payload = rep;
      _LMSTUDIO_REPORT_CACHE.failCount += 1;
      _LMSTUDIO_REPORT_CACHE.nextAllowed = now + Math.min(60000, 2000 * Math.min(_LMSTUDIO_REPORT_CACHE.failCount, 10));
      return rep;
    } finally {
      _LMSTUDIO_REPORT_CACHE.inFlight = null;
    }
  })();

  return _LMSTUDIO_REPORT_CACHE.inFlight;
}
async function tliFetchBundledStatus({ force = false } = {}) {
  // Bundled AI status lives on the TLI backend
  // GET /api/ai/status -> { healthy: bool, base_url: "http://127.0.0.1:8089" }
  const now = Date.now();
  if (!tliFetchBundledStatus._cache) {
    tliFetchBundledStatus._cache = { ts: 0, ttlMs: 1500, payload: null, inFlight: null };
  }
  const c = tliFetchBundledStatus._cache;
  if (!force && c.payload && (now - c.ts) < c.ttlMs) return c.payload;
  if (c.inFlight) {
    try { return await c.inFlight; } catch {}
  }
  c.inFlight = (async () => {
    try {
      const res = await fetch("/api/ai/status", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      const healthy = !!j && (j.healthy === true);
      const payload = { ok: healthy, healthy, base_url: j.base_url || "" };
      c.payload = payload;
      c.ts = now;
      return payload;
    } catch {
      const payload = { ok: false, healthy: false, error: "unreachable" };
      c.payload = payload;
      c.ts = now;
      return payload;
    } finally {
      c.inFlight = null;
    }
  })();
  return c.inFlight;
}

// Register FIRST so it runs before other DOMContentLoaded handlers in this file
document.addEventListener("DOMContentLoaded", () => {
  _tliInitMobileNav();
  // Re-apply server OS now that DOM is ready (fetch may have completed before DOM was parsed)
  _tliApplyServerOS(window.TLI_SERVER_OS);

  // ── Central click dispatcher (replaces all inline onclick= handlers) ──────
  // index.html uses data-* attributes; this handler resolves them.
  document.addEventListener("click", function _tliDispatch(e) {
    // ── Navigation: data-panel-target ──────────────────────────────
    const navEl = e.target.closest("[data-panel-target]");
    if (navEl) {
      const target = navEl.dataset.panelTarget;
      if (typeof switchPanel === "function") switchPanel(target);
      return;
    }

    // ── Chat chips: data-q ─────────────────────────────────────────
    const chip = e.target.closest(".chip-button[data-q]");
    if (chip) {
      const inp = document.getElementById("chat-input");
      if (inp) { inp.value = chip.dataset.q; inp.focus(); }
      return;
    }

    // ── Named actions: data-action ─────────────────────────────────
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    const _call = (fn, ...args) => { if (typeof fn === "function") fn(...args); };

    switch (action) {
      // Printer panel
      case "refreshPrinters":   _call(window.refreshPrinters);   break;
      case "openScan":          _call(window.openScan);          break;
      case "testPrint":         _call(window.testPrint);         break;
      case "openAddPrinter":    _call(window.openAddPrinter);    break;
      case "refreshUsbDevices": _call(window.refreshUsbDevices); break;
      // Print & Scan Studio
      case "psLoadPrinters":    _call(window.psLoadPrinters);    break;
      case "psSendPrint":       _call(window.psSendPrint);       break;
      case "psTestPrint":       _call(window.psTestPrint);       break;
      case "psLoadScanners":    _call(window.psLoadScanners);    break;
      case "psTriggerScan":     _call(window.psTriggerScan);     break;
      case "psDownloadScan":    _call(window.psDownloadScan);    break;
      case "psDiscardScan":     _call(window.psDiscardScan);     break;
      case "psBrowseFile":
        document.getElementById("ps-file-input")?.click();
        break;
      case "psSwitchTab":
        _call(window.psSwitchTab, actionEl.dataset.tab);
        break;
      case "psSelectToggle":
        _call(window.psSelectToggle, actionEl.dataset.toggleGroup, actionEl);
        break;
    }
  });

  // ── File input change (was onchange="psPickFile(this)") ─────────
  document.getElementById("ps-file-input")?.addEventListener(
    "change", function () { if (typeof psPickFile === "function") psPickFile(this); }
  );
});

// =====================================================
// Mobile — More drawer
// =====================================================

function _tliCloseMoreDrawer() {
  const drawer   = document.getElementById("tli-more-drawer");
  const backdrop = document.getElementById("tli-more-backdrop");
  const moreBtn  = document.getElementById("tli-bn-more-btn");
  if (!drawer) return;
  drawer.hidden   = true;
  if (backdrop) backdrop.hidden = true;
  if (moreBtn)  moreBtn.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}

function _tliOpenMoreDrawer() {
  const drawer   = document.getElementById("tli-more-drawer");
  const backdrop = document.getElementById("tli-more-backdrop");
  const moreBtn  = document.getElementById("tli-bn-more-btn");
  if (!drawer) return;
  drawer.hidden   = false;
  if (backdrop) backdrop.hidden = false;
  if (moreBtn)  moreBtn.setAttribute("aria-expanded", "true");
  // Prevent body scroll while drawer is open
  document.body.style.overflow = "hidden";
}

function _tliInitMobileNav() {
  const moreBtn  = document.getElementById("tli-bn-more-btn");
  const backdrop = document.getElementById("tli-more-backdrop");

  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      const isOpen = moreBtn.getAttribute("aria-expanded") === "true";
      isOpen ? _tliCloseMoreDrawer() : _tliOpenMoreDrawer();
    });
  }

  if (backdrop) {
    backdrop.addEventListener("click", _tliCloseMoreDrawer);
  }

  // Drag the handle to close. Scrolling the destination list must not dismiss it.
  const drawer = document.getElementById("tli-more-drawer");
  if (drawer) {
    let startY = null;
    drawer.addEventListener("touchstart", e => { startY = e.target.closest('.tli-more-handle') ? e.touches[0].clientY : null; }, { passive: true });
    drawer.addEventListener("touchend",   e => {
      if (startY !== null && e.changedTouches[0].clientY - startY > 60) _tliCloseMoreDrawer();
      startY = null;
    }, { passive: true });
    drawer.addEventListener("touchcancel", () => { startY = null; }, { passive: true });
  }
}

// =====================================================
// Ambient Alerts
// =====================================================
// Polls /status/alerts every 60s. Shows bell badge on desktop,
// dot on mobile More button, and inline list in the More drawer.

if (false) (function _tliAmbientAlerts() {
  let _knownAlertIds = new Set();

  function _severityIcon(sev) {
    if (sev === "critical") return "🔴";
    if (sev === "warn")     return "🟡";
    return "🔵";
  }

  function _renderAlertList(alerts, listEl, dismissCb) {
    if (!listEl) return;
    listEl.innerHTML = "";
    alerts.forEach(a => {
      const row = document.createElement("div");
      row.className = "tli-alert-row" + (a.severity === "critical" ? " tli-alert-critical" : "");
      row.dataset.id = a.id;
      row.innerHTML =
        `<span class="tli-alert-icon">${_severityIcon(a.severity)}</span>` +
        `<span class="tli-alert-msg">${a.message}` +
          (a.detail ? `<small class="tli-alert-detail">${a.detail}</small>` : "") +
        `</span>` +
        `<button class="tli-alert-x" data-id="${a.id}" title="Dismiss">✕</button>`;
      listEl.appendChild(row);
    });
    listEl.querySelectorAll(".tli-alert-x").forEach(btn => {
      btn.addEventListener("click", () => dismissCb(btn.dataset.id));
    });
  }

  async function _dismissAlert(id) {
    try {
      await fetch(`/status/alerts/${id}/dismiss`, { method: "POST" });
      _poll();
    } catch (_) {}
  }

  async function _dismissAll() {
    try {
      await fetch("/status/alerts/dismiss-all", { method: "POST" });
      _poll();
    } catch (_) {}
  }

  function _applyAlerts(alerts) {
    const count = alerts.length;
    const bell   = document.getElementById("tli-alert-bell");
    const badge  = document.getElementById("tli-alert-badge");
    const dot    = document.getElementById("tli-bn-alert-dot");
    const list   = document.getElementById("tli-alert-list");
    const drawerAlerts = document.getElementById("tli-drawer-alerts");
    const drawerList   = document.getElementById("tli-drawer-alert-list");

    // Desktop bell
    if (bell) {
      bell.hidden = count === 0;
      if (badge) badge.textContent = count;
    }
    // Mobile dot on More button
    if (dot) dot.hidden = count === 0;

    // Alert panel list (desktop)
    _renderAlertList(alerts, list, _dismissAlert);

    // Drawer section (mobile)
    if (drawerAlerts) drawerAlerts.hidden = count === 0;
    _renderAlertList(alerts, drawerList, _dismissAlert);

    // Toast for brand-new alerts
    alerts.forEach(a => {
      if (!_knownAlertIds.has(a.id)) {
        _knownAlertIds.add(a.id);
        if (typeof showToast === "function") {
          showToast(`${_severityIcon(a.severity)} ${a.message}`, a.severity === "critical" ? "error" : "warn", 5000);
        }
      }
    });
  }

  async function _poll() {
    try {
      const r = await fetch("/status/alerts");
      if (!r.ok) return;
      const data = await r.json();
      _applyAlerts(data.alerts || []);
    } catch (_) {}
  }

  function _init() {
    // Wire bell toggle
    const bell = document.getElementById("tli-alert-bell");
    const panel = document.getElementById("tli-alert-panel");
    if (bell && panel) {
      bell.addEventListener("click", (e) => {
        e.stopPropagation();
        panel.hidden = !panel.hidden;
      });
      document.addEventListener("click", (e) => {
        if (!panel.hidden && !panel.contains(e.target) && e.target !== bell) {
          panel.hidden = true;
        }
      });
    }

    // Dismiss-all buttons
    document.getElementById("tli-alert-dismiss-all")?.addEventListener("click", _dismissAll);
    document.getElementById("tli-drawer-dismiss-all")?.addEventListener("click", _dismissAll);

    // Delay initial poll so it doesn't compete with the page-load burst
    setTimeout(_poll, 2000);
    setInterval(_poll, 60_000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
})();

// =====================================================
// License Gate System
// =====================================================
// Intercepts HTTP 402 responses globally and shows an upgrade modal.
// Also fetches /license/status on load and stamps data-tli-tier on <html>
// so CSS can style locked sidebar items without extra JS.

(function _tliLicenseGate() {
  "use strict";

  // ── Upgrade modal ──────────────────────────────────────────
  function _showUpgradeModal(feature, message) {
    let modal = document.getElementById("tli-upgrade-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "tli-upgrade-modal";
      modal.className = "tli-upgrade-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.innerHTML = `
        <div class="tli-upgrade-card">
          <div class="tli-upgrade-icon">🔒</div>
          <div class="tli-upgrade-title" id="tli-upgrade-title">Pro Feature</div>
          <div class="tli-upgrade-msg" id="tli-upgrade-msg"></div>
          <div class="tli-upgrade-actions">
            <button class="btn-primary btn-sm" id="tli-upgrade-cta">Activate License</button>
            <button class="btn btn-ghost btn-sm" id="tli-upgrade-close">Dismiss</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      document.getElementById("tli-upgrade-cta").addEventListener("click", () => {
        modal.hidden = true;
        if (typeof switchPanel === "function") switchPanel("panel-settings");
        // Open the license section in settings
        setTimeout(() => {
          const licSection = document.getElementById("settings-section-license");
          if (licSection) {
            licSection.classList.remove("collapsed");
            licSection.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 350);
      });
      document.getElementById("tli-upgrade-close").addEventListener("click", () => {
        modal.hidden = true;
      });
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.hidden = true;
      });
    }
    document.getElementById("tli-upgrade-msg").textContent =
      message || "This feature requires a Pro license. Activate your key in Settings.";
    modal.hidden = false;
  }

  // ── Global fetch interceptor ───────────────────────────────
  const _origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const resp = await _origFetch(...args);
    if (resp.status === 402) {
      // Clone so caller can still read the body
      resp.clone().json().then(body => {
        const msg = (body && (body.detail?.message || body.detail)) || null;
        const feature = body && body.detail?.feature;
        _showUpgradeModal(feature, msg);
      }).catch(() => {
        _showUpgradeModal(null, null);
      });
    }
    return resp;
  };

  // ── Stamp tier on <html> + lock sidebar items ──────────────
  const _GATED_PANELS = {
    "panel-vault":    "vault",
    "panel-homeauto": "home_automation",
    "panel-mesh":     "peer_nodes",
  };

  let _licenseTier = null, _licenseFeatures = null;
  function _canOpenPanel(id) {
    const feature = _GATED_PANELS[id];
    return !feature || (_licenseFeatures ? !!_licenseFeatures[feature] : _licenseTier !== "free");
  }
  function _applyTierToUI(tier, features) {
    _licenseTier = tier; _licenseFeatures = features;
    document.documentElement.dataset.tliTier = tier || "free";

    // Stamp lock icons on gated nav buttons
    document.querySelectorAll("[data-panel-target]").forEach(btn => {
      const panelId  = btn.dataset.panelTarget;
      const feature  = _GATED_PANELS[panelId];
      if (!feature) return;
      const locked = features ? !features[feature] : (tier === "free");
      btn.classList.toggle("tli-nav-locked", locked);
      // Add/remove lock badge
      let badge = btn.querySelector(".tli-nav-lock-badge");
      if (locked && !badge) {
        badge = document.createElement("span");
        badge.className = "tli-nav-lock-badge";
        badge.title = "Requires Pro";
        btn.appendChild(badge);
      } else if (!locked && badge) {
        badge.remove();
      }
    });
  }

  async function _fetchTier() {
    try {
      const r = await _origFetch("/license/status");  // use original to skip 402 intercept loop
      if (!r.ok) return;
      const d = await r.json();
      _applyTierToUI(d.tier, d.features);
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _fetchTier);
  } else {
    setTimeout(_fetchTier, 0);
  }

  window.TLILicenseAccess = { canOpen: _canOpenPanel, refreshUI: () => { if (_licenseTier !== null) _applyTierToUI(_licenseTier, _licenseFeatures); } };
  // Expose for switchPanel locked-panel guard
  window._tliShowUpgradeModal = _showUpgradeModal;
})();

const TLI_VERSION        = "1.4.6-beta";
const DEFAULT_THEME      = "emeraldLight";
const previousPromptsKey = "tli_previous_prompts";

let currentDeviceId = null;        // filled from /status
const CHAT_HISTORY_DRAFT_ID = "__draft__";
let currentConversationId = null;  // tracks active conversation thread
window.TLIConversationLoad = {
  contract: "v1", generation: 0,
  invalidate() { this.generation++; this.loading = false; },
  deleted(id) {
    this.invalidate();
    if (id && currentConversationId !== id) return;
    currentConversationId = null;
    window.currentConversationId = null;
    window.TLIMemory?.clear();
    window.TLIDocuments?.clear();
    window.TLICaseContext?.clear();
    window.TLIIntelligence?.clearContext?.();
    if (typeof resetChatHistory === "function") resetChatHistory({ alsoClearStorage: true });
    if (typeof clearChatWithPlaceholder === "function") clearChatWithPlaceholder("Choose a saved conversation or start a new chat.");
  },
};
function clearLocalChatSession() {
  window.TLIConversationLoad.deleted();
  if (typeof _clearChatImage === "function") _clearChatImage();
  if (typeof inFlightController !== "undefined") inFlightController?.abort();
  const input = document.getElementById("chat-input");
  if (input) input.value = "";
  const send = document.getElementById("chat-send-btn"), abort = document.getElementById("abort-chat-btn");
  if (send) send.disabled = false;
  if (abort) abort.disabled = true;
}
window.addEventListener("tli-session-locked", clearLocalChatSession);
window.addEventListener("pagehide", clearLocalChatSession);
let meshDirectoryCache = null;   // cache for /mesh/directory so multi-node tools can see it
let currentNodeConfig = null;    // cache for /mesh/node (role + host state)
let suppressShellySelection = false;

// [module] See /js/mesh-service.js
// =====================================================
// Intelligence Routing (Local • LAN • Optional Online)
// =====================================================

const AIUserPolicy = Object.freeze({
  AUTO: "AUTO",
  LOCAL_ONLY: "LOCAL_ONLY",
  LAN_ONLY: "LAN_ONLY",
  PREFER_LOCAL_ALLOW_LAN: "PREFER_LOCAL_ALLOW_LAN",
  PREFER_LAN_ALLOW_LOCAL: "PREFER_LAN_ALLOW_LOCAL",
});

const AI_PREFS_KEY = "tli_ai_policy_v1";
const AI_LAN_PREF_KEY = "tli_ai_lan_preferred_node_v1";

function loadAIPolicy() {
  try {
    const raw = localStorage.getItem(AI_PREFS_KEY);
    const v = raw ? String(raw) : AIUserPolicy.AUTO;
    return Object.values(AIUserPolicy).includes(v) ? v : AIUserPolicy.AUTO;
  } catch {
    return AIUserPolicy.AUTO;
  }
}

function saveAIPolicy(v) {
  try { localStorage.setItem(AI_PREFS_KEY, String(v)); } catch {}
}

function loadPreferredLanNodeId() {
  try { return localStorage.getItem(AI_LAN_PREF_KEY) || "AUTO"; } catch { return "AUTO"; }
}

function savePreferredLanNodeId(v) {
  try { localStorage.setItem(AI_LAN_PREF_KEY, String(v)); } catch {}
}

let AI_POLICY = loadAIPolicy();
let AI_LAN_PREFERRED = loadPreferredLanNodeId();
const IntelligenceSource = Object.freeze({
  NONE: "none",
  LOCAL_LLM: "local_llm",
  LAN_LLM: "lan_llm",
  ONLINE_SEARCH: "online_search", // reserved (future)
  ONLINE_LLM: "online_llm",       // reserved (future)
});

// Lightweight AI status cache (UI + routing)
const AIStatus = {
  local: { available: false, provider: "bundled", health: "unknown", lastCheckedMs: 0 },
  lan:   { available: false, nodes: [], lastCheckedMs: 0 },
  resolved: { source: IntelligenceSource.NONE, node: null, reason: "Not checked yet." },
};

// Small helper: timeout fetch (for LAN probing)
async function fetchWithTimeout(url, opts = {}, timeoutMs = 1200) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Updates the header pill (added in index.html)
function setAIRoutePill(source, tip) {
  // The source controller owns header and Chat availability when present.
  if (window.__TLI_AI_SOURCE_OF_TRUTH_V2__) { window.TLIAISource?.renderRoute?.({source, reason:tip}); return; }
  const pill = $("ai-source-pill");
  const text = $("ai-source-text");
  if (!pill || !text) return;

  pill.classList.remove("ai-offline", "ai-local", "ai-lan", "ai-online");
  const s = String(source || IntelligenceSource.NONE);

  if (s === IntelligenceSource.LOCAL_LLM) {
    pill.classList.add("ai-local");
    const prov = (AIStatus && AIStatus.local && AIStatus.local.provider) ? String(AIStatus.local.provider) : "";
    if (prov.toLowerCase() === "bundled") {
      text.textContent = "AI: Integrated";
      pill.title = tip || "Using bundled local AI on this device.";
    } else {
      text.textContent = "AI: LM Studio";
      pill.title = tip || "Using local AI on this device (LM Studio).";
    }
    return;
  }
  if (s === IntelligenceSource.LAN_LLM) {
    pill.classList.add("ai-lan");
    text.textContent = "AI: Mesh";
    pill.title = tip || "Using AI served by another TLI node on your LAN.";
    return;
  }
  if (s === IntelligenceSource.ONLINE_SEARCH || s === IntelligenceSource.ONLINE_LLM) {
    pill.classList.add("ai-online");
    text.textContent = "AI: Online";
    pill.title = tip || "Online mode (explicit opt-in).";
    return;
  }

  pill.classList.add("ai-offline");
  text.textContent = "AI: Not confirmed";
  pill.title = tip || "AI availability has not been confirmed.";
}

// Probe local LM Studio via your existing report endpoint
async function refreshLocalAI() {
  // Throttle LM Studio probing to avoid log spam when offline.
  const now = Date.now();
  AIStatus.local._nextCheckMs = AIStatus.local._nextCheckMs || 0;
  if (now < AIStatus.local._nextCheckMs) return !!AIStatus.local.available;

  const rep = await tliFetchLMStudioReport();
  const ok = !!(
    rep &&
    (rep.ok === true || rep.available === true || rep.status === "ok" || rep.healthy === true) &&
    (rep.schema_ok !== false)
  );

  AIStatus.local.available = ok;
  AIStatus.local.health = ok ? "ok" : "down";
  AIStatus.local.lastCheckedMs = now;

  // Down: respect server backoff if present; otherwise slow down.
  const backoffMs = ok ? 5000 : Math.max(8000, Number(rep?.backoff_s || 0) * 1000);
  AIStatus.local._nextCheckMs = now + backoffMs;

  return ok;
}
// LAN inference is chosen explicitly after reviewing a trusted computer.
// Legacy status refreshes must not probe discovered addresses or grant routing authority.
async function refreshLanAI() {
  AIStatus.lan.nodes = [];
  AIStatus.lan.available = false;
  AIStatus.lan.lastCheckedMs = Date.now();
  return false;
}

// Decide route (policy: Local > LAN > None)
async function resolveIntelligenceRoute({ forceRefresh = false } = {}) {
  // Refresh probes (cheap local first)
  if (forceRefresh || (Date.now() - AIStatus.local.lastCheckedMs) > 2500) {
    await refreshLocalAI();
  }
  if (forceRefresh || (Date.now() - AIStatus.lan.lastCheckedMs) > 3500) {
    await refreshLanAI();
  }

  const localOk = !!AIStatus.local.available;
  const lanOk = !!AIStatus.lan.available;

  // Helper: pick LAN node (preferred if possible)
  const pickLan = () => {
    const pref = AI_LAN_PREFERRED || "AUTO";
    if (pref && pref !== "AUTO") {
      const hit = (AIStatus.lan.nodes || []).find(n => n && (n.nodeId === pref || n.ip === pref));
      if (hit) return hit;
    }
    return (AIStatus.lan.nodes && AIStatus.lan.nodes[0]) ? AIStatus.lan.nodes[0] : null;
  };

  // Policy-respecting routing (never silently violates strict choices)
  const policy = AI_POLICY || AIUserPolicy.AUTO;

  if (policy === AIUserPolicy.LOCAL_ONLY) {
    if (localOk) {
      AIStatus.resolved = { source: IntelligenceSource.LOCAL_LLM, node: null, reason: "Policy: Local Only." };
      setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
      return AIStatus.resolved;
    }
    AIStatus.resolved = { source: IntelligenceSource.NONE, node: null, reason: "Policy: Local Only, but local AI is unavailable." };
    setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
    return AIStatus.resolved;
  }

  if (policy === AIUserPolicy.LAN_ONLY) {
    if (lanOk) {
      const node = pickLan();
      AIStatus.resolved = { source: IntelligenceSource.LAN_LLM, node, reason: node ? `Policy: LAN Only → ${node.name} (${node.ip}).` : "Policy: LAN Only." };
      setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
      return AIStatus.resolved;
    }
    AIStatus.resolved = { source: IntelligenceSource.NONE, node: null, reason: "Choose a reviewed computer and model in the chat AI control." };
    setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
    return AIStatus.resolved;
  }

  if (policy === AIUserPolicy.PREFER_LAN_ALLOW_LOCAL) {
    if (lanOk) {
      const node = pickLan();
      AIStatus.resolved = { source: IntelligenceSource.LAN_LLM, node, reason: node ? `Policy: Prefer LAN → ${node.name} (${node.ip}).` : "Policy: Prefer LAN." };
      setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
      return AIStatus.resolved;
    }
    if (localOk) {
      AIStatus.resolved = { source: IntelligenceSource.LOCAL_LLM, node: null, reason: "Policy: Prefer LAN (fallback to local)." };
      setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
      return AIStatus.resolved;
    }
    AIStatus.resolved = { source: IntelligenceSource.NONE, node: null, reason: "Policy: Prefer LAN, but no providers available." };
    setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
    return AIStatus.resolved;
  }

  // AUTO or Prefer Local Allow LAN
  if (localOk) {
    AIStatus.resolved = {
      source: IntelligenceSource.LOCAL_LLM,
      node: null,
      reason: (policy === AIUserPolicy.PREFER_LOCAL_ALLOW_LAN) ? "Policy: Prefer Local (local available)." : "Auto: Local AI available."
    };
    setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
    return AIStatus.resolved;
  }

  if (lanOk) {
    const node = pickLan();
    AIStatus.resolved = {
      source: IntelligenceSource.LAN_LLM,
      node,
      reason: node
        ? ((policy === AIUserPolicy.PREFER_LOCAL_ALLOW_LAN) ? `Policy: Prefer Local (fallback LAN) → ${node.name} (${node.ip}).` : `Auto: Using LAN AI host → ${node.name} (${node.ip}).`)
        : "LAN AI available."
    };
    setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
    return AIStatus.resolved;
  }

  AIStatus.resolved = { source: IntelligenceSource.NONE, node: null, reason: "Local AI is not confirmed. To use LAN inference, choose a reviewed computer and model in the chat AI control." };
  setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
  return AIStatus.resolved;
}


// Kept as a compatibility guard for older browser extensions/callers.
async function lanAiChat() {
  throw new Error("Automatic LAN inference has been retired. Choose a reviewed computer and model in the chat AI control. Nothing was sent.");
}


// --- Global UI helpers ----------------------------------------------------

// ---------- Shelly device registry ----------
const shellyDevices = {}; // keyed by IP

// Formats raw model output based on Mode (default / concise / step / dev)
function formatModelOutput(raw, mode) {
  if (raw === null || raw === undefined) return "";
  let text = String(raw).trim();
  if (!text) return "";

  // 1) Normalize line endings
  text = text.replace(/\r\n/g, "\n");

  // 2) Strip basic markdown bold
  text = text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/__(.*?)__/g, "$1");

  // 3) Force breaks before bullets and numbered items
  //    " • " or " * " → start of a new line
  text = text.replace(/\s+•\s+/g, "\n• ").replace(/\s+\*\s+/g, "\n• ");

  //    " 1. Something 2. Something else" → each number on its own line
  text = text.replace(/(\d+)\.\s+/g, "\n$1. ");

  // 4) Collapse crazy blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  const m = (mode || "default").toLowerCase();

  // 🔹 Concise: single short line summary
  if (m === "concise") {
    const singleLine = text.replace(/\s+/g, " ");
    const maxLen = 260;
    const clipped =
      singleLine.length > maxLen
        ? singleLine.slice(0, maxLen).trimEnd() + "…"
        : singleLine;
    return "🔹 " + clipped;
  }

  // 🔹 Step-by-step: numbered steps with emojis
  if (m === "step" || m === "step-by-step") {
    let parts = text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    // If it's still one giant paragraph, fall back to sentence splitting
    if (parts.length === 1 && parts[0].length > 200) {
      parts = parts[0]
        .split(/\. +/g)
        .map((p) => p.trim())
        .filter(Boolean);
    }

    if (!parts.length) parts = [text];

    return parts
      .map((p, i) => {
        // strip any leading bullets/numbers
        const cleaned = p.replace(/^[-•\d.)]+\s*/, "");
        return `${i + 1}️⃣ ${cleaned}`;
      })
      .join("\n\n");
  }

  // 🔹 Developer: mostly raw, but sane line breaks
  if (m === "dev" || m === "developer") {
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  // 🔹 Default: readable paragraphs + bullets
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// Typewriter animation for the header title (runs once on load)
function runTitleTypeAnimation() {
  const span = document.getElementById("tli-title-typed");
  if (!span) return;

  // Avoid re-running if something calls it twice
  if (span.dataset.typed === "done") return;

  const full = (span.dataset.full || span.textContent || "").trim();
  if (!full) return;

  span.textContent = "";
  let i = 0;
  const minDelay = 45;  // base speed
  const jitter   = 55;  // random extra for a more organic feel

  function step() {
    span.textContent = full.slice(0, i + 1);
    i += 1;

    if (i < full.length) {
      const delay = minDelay + Math.random() * jitter;
      window.setTimeout(step, delay);
    } else {
      span.dataset.typed = "done";
    }
  }

  step();
}


function showToast(message, kind = "info", timeoutMs = 2800) {
  if (!message) return;
  // Route through nerve.js tliToast (themed, card-style, emerald identity)
  if (typeof window.tliToast === "function") {
    const type = (kind === "ok" || kind === "success") ? "success"
               : kind === "error"   ? "error"
               : kind === "warning" ? "warning"
               : "info";
    window.tliToast(message, type);
    return;
  }
  // Fallback: legacy container (nerve.js not yet loaded at call time)
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "tli-toast tli-toast-" + (kind || "info");
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  while (container.children.length > 3) container.removeChild(container.firstElementChild);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => { if (toast.parentNode === container) container.removeChild(toast); }, 220);
  }, timeoutMs);
}


/**
 * Sets text + visual variant on a small inline status element by id.
 * Variants map to existing status-pill shades in CSS where possible.
 */
function setInlineStatus(id, text, kind = "info") {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";

  el.classList.remove("status-ok", "status-error", "status-muted");
  if (kind === "ok") el.classList.add("status-ok");
  else if (kind === "error") el.classList.add("status-error");
  else if (kind === "muted") el.classList.add("status-muted");
}

/**
 * Marks a button as busy while an async action runs.
 * labelWhenIdle is the original label to restore afterward.
 */
function withButtonBusy(btn, labelWhenIdle, fn) {
  if (!btn || typeof fn !== "function") return fn();

  const originalHtml = btn.innerHTML;
  btn.classList.add("is-busy");
  if (labelWhenIdle) {
    btn.innerHTML = labelWhenIdle;
  }

  const done = () => {
    btn.classList.remove("is-busy");
    btn.innerHTML = originalHtml;
  };

  const maybePromise = fn();
  if (maybePromise && typeof maybePromise.finally === "function") {
    maybePromise.finally(done);
  } else {
    done();
  }

  return maybePromise;
}

// ---------- debug console (Settings) ----------
let debugEnabled = false;

function debugLog(level, message) {
  const logEl = document.getElementById("debug-log");
  if (!logEl || !debugEnabled) return;

  const lvl = (level || "info").toLowerCase();
  const levelClass = ["info", "warn", "error"].includes(lvl) ? lvl : "info";

  const line = document.createElement("div");
  line.className = "debug-log-line debug-log-" + levelClass;

  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  line.textContent = `[${ts}] [${lvl.toUpperCase()}] ${message}`;

  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function initDebugConsole() {
  const debugCard     = $("debug-settings-card");
  const debugToggle   = $("debug-enable-toggle");
  const debugLogEl    = $("debug-log");
  const clearBtn      = $("debug-clear-btn");
  const downloadBtn   = $("debug-download-btn");

  if (!debugCard || !debugToggle || !debugLogEl || !clearBtn || !downloadBtn) {
    return; // HTML not present (older template, etc.)
  }

  const header = debugCard.querySelector(".collapsible-header");
  const body   = debugCard.querySelector(".collapsible-body");

  // Start collapsed by default
  if (header && body) {
    header.setAttribute("aria-expanded", "false");
    body.setAttribute("aria-hidden", "true");
    debugCard.classList.add("collapsed");
  }

  // Toggle debug on/off
  debugToggle.addEventListener("click", () => {
    debugEnabled = !debugEnabled;
    debugToggle.classList.toggle("on", debugEnabled);
    debugLog("info", debugEnabled ? "Debug logging enabled." : "Debug logging disabled.");
  });

  // Clear logs
  clearBtn.addEventListener("click", () => {
    debugLogEl.innerHTML = "";
    const initLine = document.createElement("div");
    initLine.className = "debug-log-line debug-log-info";
    initLine.textContent = "[debug] Logs cleared.";
    debugLogEl.appendChild(initLine);
  });

  // Download logs as .log file
  downloadBtn.addEventListener("click", () => {
    const lines = Array.from(debugLogEl.querySelectorAll(".debug-log-line")).map(
      (el) => el.textContent || ""
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().split(".")[0].replace(/:/g, "-");
    a.href = url;
    a.download = `tli-debug-${ts}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Seed initial line if empty
  if (!debugLogEl.querySelector(".debug-log-line")) {
    const initLine = document.createElement("div");
    initLine.className = "debug-log-line debug-log-info";
    initLine.textContent = "[debug] Ready. Toggle \"Enable debug\" to begin logging.";
    debugLogEl.appendChild(initLine);
  }
}

// Chat bubble appender
function appendMessage(role, text, options = {}) {
  const output = $("chat-output");
  const empty = output.querySelector(".chat-output-empty");
  if (empty) empty.remove();

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble " + (role === "user" ? "chat-bubble-user" : "chat-bubble-ai");
  if (options.thinking) bubble.classList.add("chat-bubble-thinking");

  // Show attached image above text in user bubbles
  if (options.imageDataUrl) {
    const img = document.createElement("img");
    img.src = options.imageDataUrl;
    img.className = "chat-bubble-image";
    img.alt = "Attached image";
    bubble.appendChild(img);
  }

  const textNode = document.createElement("span");
  textNode.textContent = text;
  bubble.appendChild(textNode);

  // Speak button on AI bubbles
  if (role !== "user" && !options.thinking && "speechSynthesis" in window) {
    const speakBtn = document.createElement("button");
    speakBtn.className = "chat-bubble-speak";
    speakBtn.textContent = "▶";
    speakBtn.title = "Read aloud";
    speakBtn.addEventListener("click", () => tliSpeakBubble(speakBtn, textNode.textContent || text));
    bubble.appendChild(speakBtn);
  }

  output.appendChild(bubble);
  output.scrollTop = output.scrollHeight;
  return bubble;
}



// ===============================
// Bundled AI SSE Streaming Helper
// ===============================

// ===============================
// Bundled AI SSE Streaming Helper (POST with GET fallback)
// ===============================
async function tliBundledChatStream({ message, raw_input, session_id, active_panel, max_tokens, temperature, image_b64, image_mime, onDelta, onMeta, signal, ...context }) {
  if (window.TLIWorkspace) {
    const result = await window.TLIWorkspace.chat({ ...context, message, raw_input: raw_input || '', conversation_id: session_id || null,
      active_panel: active_panel || null, max_tokens: max_tokens ?? 300, temperature: temperature ?? 0.2,
      image_b64: image_b64 || null, image_mime: image_mime || null }, {signal, onMeta, onDelta, chatPath:'/api/ai/chat/stream'});
    if (result) return true;
  }
  const res = await fetch("/api/ai/chat/stream", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body: JSON.stringify({ ...context, message, raw_input: raw_input || "", session_id: session_id || null,
      active_panel: active_panel || null, max_tokens: max_tokens ?? 300, temperature: temperature ?? 0.2,
      image_b64: image_b64 || null, image_mime: image_mime || null }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || `Chat request failed (${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", completed = false;
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let obj;
          try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (obj.type === "error") throw new Error(obj.detail || "The provider could not complete this request.");
          if (obj.type === "meta") onMeta?.(obj);
          if (obj.type === "delta") onDelta?.(obj.text || "");
          if (obj.type === "done") completed = true;
        }
      }
    }
    if (!completed) throw new Error("The response was interrupted. It was not automatically retried.");
    return true;
  } finally { await reader.cancel().catch(() => {}); }
}


function clearChatWithPlaceholder(text) {
  const output = $("chat-output");
  output.innerHTML = "";
  const div = document.createElement("div");
  div.className = "chat-output-empty";
  div.textContent = text;
  output.appendChild(div);
}

// -------- Header Integration Health (sleek pills) --------
function _ago(tsMs) {
  if (!tsMs) return "";
  const s = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
  if (s < 10) return "NOW";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function _setPill(pillId, textId, level, label, tip) {
  const pill = $(pillId);
  const text = $(textId);
  if (!pill || !text) return;

  pill.classList.remove("offline", "degraded", "compact");
  pill.classList.add("compact");
  if (level === "down") pill.classList.add("offline");
  else if (level === "degraded") pill.classList.add("degraded");

  const stamp = Date.now();
  const lvl = String(level).toUpperCase();
text.textContent = `${label} ${lvl}`;   // 👈 short & sleek

const when = _ago(stamp);
pill.title = `${label}: ${lvl} · ${when}${tip ? " — " + tip : ""}`;  // 👈 details only on hover

}

async function refreshBrainHealthFromReport() {
  try {
    const rep = await tliFetchLMStudioReport();

    if (!rep || rep.ok !== true) {
      const backoff = rep?.backoff_s ? ` Next check ~${Math.round(rep.backoff_s)}s.` : "";
      _setPill(
        "model-status-pill",
        "model-status-text",
        "down",
        "Brain",
        `AI unavailable. ${rep?.error ? "Error: " + rep.error : "Download your AI model in Settings → AI."}${backoff}`
      );
      return;
    }

    // Healthy
    _setPill("model-status-pill", "model-status-text", "ok", "Brain", "AI online and responding.");
  } catch {
    _setPill("model-status-pill", "model-status-text", "down", "Brain", "AI unavailable.");
  }
}

// Keep your existing call sites intact:
// refreshStatus() calls setModelStatus(online, message) :contentReference[oaicite:4]{index=4}
function setModelStatus(online, message) {
  // “online” still drives the quick state
  if (!online) {
    _setPill("model-status-pill", "model-status-text", "down", "Brain",
      message || "AI is offline. Download your AI model in Settings → AI.");
    return;
  }
  // If online, upgrade to report-based OK/DEGRADED when available
  refreshBrainHealthFromReport();
}

// Home Automation pill helpers
function setHomeAutoHealth(level, tip) {
  _setPill("homeauto-status-pill", "homeauto-status-text", level, "Home", tip);
}


function setMeshModelStatus(nodeRole, meshStatus) {
  const pill = $("mesh-model-pill");
  if (!pill) return;

  // Mesh Awareness (premium, low-clutter): show role + node count when available
  const role = (nodeRole || "").toLowerCase();
  const status = (meshStatus || "").toLowerCase();

  const rosterCount = Array.isArray(meshDirectoryCache?.devices)
    ? meshDirectoryCache.devices.length
    : Array.isArray(meshDirectoryCache?.nodes)
      ? meshDirectoryCache.nodes.length
      : 0;

  let roleLabel = "No mesh";
  let online = false;

  if (role === "host") {
    roleLabel = "HOST";
    online = true;
  } else if (role === "member") {
    roleLabel = "MEMBER";
    online = status === "pending" || status === "approved" || status === "ok";
  } else if (role) {
    roleLabel = role.toUpperCase();
  }

  const suffix = rosterCount ? ` · ${rosterCount} node${rosterCount === 1 ? "" : "s"}` : "";
  pill.textContent = roleLabel === "No mesh" ? "LAN-only · No mesh" : `Mesh: ${roleLabel}${suffix}`;
  pill.classList.toggle("mesh-online", online);
  pill.classList.toggle("mesh-offline", !online);

  // Keep context tags in sync across modules
  try { syncMeshContextTags({ fallbackRole: roleLabel }); } catch {}
}

// -----------------------------------------------------
// Mesh Context Tags (Visualizer, Tools, and Header)
// -----------------------------------------------------
function syncMeshContextTags({ fallbackRole } = {}) {
  const roleText = (window.MeshService && typeof window.MeshService.getRoleLabel === "function")
    ? window.MeshService.getRoleLabel()
    : (fallbackRole || "UNKNOWN");

  const visRole = $("visualizer-role-tag");
  if (visRole) visRole.textContent = "Role: " + roleText;

  const toolsRole = $("tools-role-tag");
  if (toolsRole) toolsRole.textContent = "Role: " + roleText;
}

function applyTheme(theme) {
  if (typeof window.TLIThemes?.apply === "function") return window.TLIThemes.apply(theme || DEFAULT_THEME);
  // The native picker still works if the gallery catalog failed to load.
  // CSS declares each palette's tone; do not infer it from the theme's name.
  const root = document.documentElement;
  const selected = typeof theme === "string" && theme ? theme : DEFAULT_THEME;
  root.setAttribute("data-theme", selected);
  root.style.removeProperty("color-scheme");
  const tone = getComputedStyle(root).colorScheme === "dark" ? "dark" : "light";
  root.setAttribute("data-theme-tone", tone);
  document.body.classList.toggle("theme-dark", tone === "dark");
  return selected;
}

// ---------- version + About modal ----------
function setupVersionAndAbout() {
  const versionPill  = $("version-pill");
  const aboutVersion = $("about-version");
  const aboutBtn     = $("about-button");
  const aboutModal   = $("about-modal");

  // Set version text in header + modal if elements exist
  if (versionPill)  versionPill.textContent  = "v" + TLI_VERSION;
  if (aboutVersion) aboutVersion.textContent = "v" + TLI_VERSION;

  // Wire About button to open/close modal
  if (aboutBtn && aboutModal) {
    aboutBtn.addEventListener("click", () => {
      aboutModal.classList.remove("hidden");
    });

    // Close when clicking backdrop or [data-close-modal] button
    aboutModal.addEventListener("click", (e) => {
      if (e.target === aboutModal || e.target.closest("[data-close-modal]")) {
        aboutModal.classList.add("hidden");
      }
    });
  }
}

// ---------- collapsibles ----------
function makeCollapsible(card) {
  const header = card.querySelector(".collapsible-header");
  const body = card.querySelector(".collapsible-body");
  if (!header || !body) return;
  header.addEventListener("click", () => {
    const collapsed = card.classList.toggle("collapsed");
    const expanded = !collapsed;
    header.setAttribute("aria-expanded", String(expanded));
    body.setAttribute("aria-hidden", String(!expanded));
  });
}

// ---------- sidebar panels (inline onclick version) ----------
let _currentPanelId = null;

function switchPanel(targetId) {
  if (!document.getElementById(targetId)) return false;

  // Block navigation to locked (Pro-gated) panels — show upgrade modal instead
  const lockedBtn = document.querySelector(`[data-panel-target="${targetId}"].tli-nav-locked`);
  if (window.TLILicenseAccess ? !window.TLILicenseAccess.canOpen(targetId) : lockedBtn) {
    if (typeof window._tliShowUpgradeModal === "function") {
      window._tliShowUpgradeModal(null, "This panel requires a Pro license. Activate your key in Settings → License.");
    }
    return;
  }

  _currentPanelId = targetId;
  const panels = document.querySelectorAll(".panel-container");
  const buttons = document.querySelectorAll(".side-nav-button");

  // Hide all non-target panels immediately (no layout overlap)
  panels.forEach(panel => {
    if (panel.id === targetId) return;
    panel.hidden = true;
    panel.classList.remove("active");
  });

  // Animate target panel in — remove .active, force reflow, re-add to restart animation
  const _tgtPanel = document.getElementById(targetId);
  if (_tgtPanel) {
    _tgtPanel.hidden = false;
    _tgtPanel.classList.remove("active");
    void _tgtPanel.offsetWidth; // force reflow so animation restarts
    _tgtPanel.classList.add("active");
  }

  buttons.forEach(btn => {
    btn.classList.toggle(
      "active",
      btn.dataset.panelTarget === targetId
    );
  });

  // Sync bottom nav active state
  document.querySelectorAll(".tli-bn-item[data-panel-target]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.panelTarget === targetId);
  });
  // Sync More drawer item active state + close the drawer
  document.querySelectorAll(".tli-more-item[data-panel-target]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.panelTarget === targetId);
  });
  _tliCloseMoreDrawer();

// Refresh no-AI banner whenever Chat panel opens
if (targetId === "panel-main" && typeof _refreshNoAiBanner === "function") {
  _refreshNoAiBanner();
}

// Notify listeners which panel just opened (used by Mesh Control Center, etc.)
document.dispatchEvent(new CustomEvent("tli-panel-switched", { detail: { panelId: targetId } }));

// Panel hooks (optional feature modules)
if (targetId === 'panel-companion') window.TLICompanion?.onOpen?.();
else window.TLICompanion?.onClose?.();
if (targetId === 'panel-troubleshooting') window.TLITroubleshooting?.onOpen?.();
else window.TLITroubleshooting?.onClose?.();
if (targetId === "panel-tli-chat" && window.TLIChat && typeof window.TLIChat.onOpen === "function") {
  window.TLIChat.onOpen();
}
if (targetId !== "panel-tli-chat" && window.TLIChat && typeof window.TLIChat.onClose === "function") {
  window.TLIChat.onClose();
}
// System Summary hook
if (targetId === "panel-system" && window.TLISystem && typeof window.TLISystem.onOpen === "function") {
  window.TLISystem.onOpen();
}
// Visualizer: refresh drives on every open (catches hotplugged drives)
if (targetId === "panel-visualizer") {
  const dc = document.getElementById("vis4-drives");
  if (dc) dc._loaded = false; // force refresh
  if (typeof loadVisualizerDrives === "function") loadVisualizerDrives();
}

// File Organizer: populate device tag on open
if (targetId === "panel-files") {
  const tag = document.getElementById("files-device-tag");
  if (tag) {
    const hn = window.__tli_node_name || window.__tli_hostname || (location.hostname !== "localhost" ? location.hostname : null);
    tag.textContent = hn ? `Device: ${hn}` : "Device: this machine";
  }
}

// Dashboard 2.0 hooks
if (targetId === "panel-dashboard2" && window.TLIDash2 && typeof window.TLIDash2.onOpen === "function") {
  window.TLIDash2.onOpen();
}
if (targetId !== "panel-dashboard2" && window.TLIDash2 && typeof window.TLIDash2.onClose === "function") {
  window.TLIDash2.onClose();
}


if (targetId === 'panel-performance') window.TLIPerformance?.onOpen?.();
else window.TLIPerformance?.onClose?.();

// Games panel hook
if (targetId === "panel-games" && window.TLIGames && typeof window.TLIGames.onOpen === "function") {
  window.TLIGames.onOpen();
}


// Automations panel hook
if (targetId === "panel-automations" && window.TLIAutomations && typeof window.TLIAutomations.onOpen === "function") {
  window.TLIAutomations.onOpen();
}

// Devices panel: auto-load USB storage on every open so no manual Refresh needed
if (targetId === "panel-usb") {
  if (typeof refreshUsbDevices === "function") refreshUsbDevices();
}

// Print & Scan Studio: load devices on first open
if (targetId === "panel-printshop") {
  psOnOpen();
}
  // If we leave Home Automation, stop Shelly auto-refresh
  if (targetId !== "panel-homeauto") {
    if (typeof stopShellyAutoRefresh === "function") {
      stopShellyAutoRefresh();
    }
  } else {
// Show skeleton cards while devices load
const _shellyCardWrap = document.getElementById("shellyCards");
if (_shellyCardWrap && !_shellyCardWrap.children.length) {
  _shellyCardWrap.innerHTML =
    '<div class="tli-skel-card"></div>' +
    '<div class="tli-skel-card"></div>' +
    '<div class="tli-skel-card"></div>';
}

// If we ENTER Home Automation, auto-pull Shelly status (MULTI)
if (typeof fetchAllShellyStatuses === "function") {
  // silent = true → no toast spam on panel switch / refresh
  fetchAllShellyStatuses(true);
} else if (typeof fetchShellyStatus === "function") {
  // fallback (older single-device)
  fetchShellyStatus(true);
}

if (typeof startShellyAutoRefresh === "function") {
  startShellyAutoRefresh();
}

if (window.TLIHomeAutoActions && typeof window.TLIHomeAutoActions.onOpen === "function") {
  window.TLIHomeAutoActions.onOpen();
}

  }
}



// Historical entry-point name retained for callers. Navigation prepares a
// location; the explicit Scan control is the only way to start inspection.
function switchPanelAndScan(panelId, path) {
  if (panelId === 'panel-visualizer' && window.TLIStorageWorkspace?.prepare) return window.TLIStorageWorkspace.prepare({view:'space', root:path, source:'dashboard'});
  switchPanel(panelId);
  if (panelId !== 'panel-visualizer') return;
  if (typeof window.TLIVisualizer?.scanPath === 'function') return window.TLIVisualizer.scanPath(path);
  const input = document.getElementById('visualizerPathInput');
  if (input && typeof path === 'string') {
    input.value = path;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }
}

function openPanelFromQuery() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const panel = params.get("panel");
    if (!panel) return false;

    // Panels are named like "panel-main", "panel-mesh", "panel-visualizer", etc.
    const targetId = "panel-" + panel;
    const el = document.getElementById(targetId);
    if (el) {
      switchPanel(targetId);
      return true;
    }
  } catch (e) {
    console.warn("Could not parse panel query:", e);
  }
  return false;
}


function setupTeachingToggle() {
  const toggle = $("teaching-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => { toggle.classList.toggle("on"); });
}
function isTeachingMode() {
  const toggle = $("teaching-toggle");
  return !!(toggle && toggle.classList.contains("on"));
}

// =========================================================
// Dashboard 2.0 — Alive Layer (additive, safe)
// =========================================================
// ── Narrator Dashboard (TLIDash2) ────────────────────────────────────────────
window.TLIDash2 = (function () {
  "use strict";

  let _pollTimer     = null;
  let _typeTimer     = null;
  let _cycleTimer    = null;
  let _tipTimer      = null;
  let _open          = false;
  let _panelOpen     = false;
  let _lastCategory  = null;
  let _lastData      = null;   // cached from last _refresh()
  let _freshnessTimer = null, _lastRefreshFailed = false, _meshObservedAt = null;
  let _refreshPending = null, _viewEpoch = 0, _sessionLocked = false;
  let _dashSse       = null;   // SSE connection for mesh presence events
  const _seenFeedIds = new Set(); // dedup guard for seeded feed entries

  // ── Statement categories ──────────────────────────────────────
  const CATEGORIES = ["state","state","device","ai","ai","mesh","storage","vault","tip","tip","time","capability","capability","fact","awareness_storage","alert","alert"];
  // state/ai/tip/capability appear twice for weight; awareness_storage fires on threshold; alert fires when active alerts exist

  const _recentStatements = [];   // last 8 shown — prevents exact repeats

  function _dedupe(candidates) {
    const fresh = candidates.filter(s => s && !_recentStatements.includes(s));
    return fresh.length ? fresh : candidates.filter(Boolean);
  }

  function _buildStatement(cat) {
    const d        = _lastData || {};
    const nickname = d.nickname  || "TLI Node";
    const aiOk     = d.aiOk     || false;
    const lmOnline = d.lmOnline  || false;
    const aiReady  = aiOk || lmOnline;
    const aiLabel  = aiOk ? "bundled AI" : lmOnline ? "LM Studio" : "the AI";
    const devCount = d.devCount  || 0;
    const devNames = d.devNames  || [];
    const meshSt   = d.meshSt   || "unpaired";
    const disk     = d.diskData;
    const sys      = disk?.system || disk;
    const dLabel   = sys?.drive  || "C:";
    const hour     = new Date().getHours();
    const timeStr  = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const greeting = hour < 5 ? "Still going" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : hour < 21 ? "Good evening" : "Late night";
    const pick = arr => { const f = _dedupe(arr); return f[Math.floor(Math.random() * f.length)]; };

    const map = {
      state: () => {
        const devStr  = devCount > 0 ? `${devCount} device${devCount !== 1 ? "s" : ""} registered` : "no smart devices";
        const aiStr   = aiOk ? "AI bundled" : lmOnline ? "LM Studio" : "AI offline";
        const diskStr = sys?.ok ? `${sys.pct}% on ${dLabel}` : "";
        return pick([
          // Factual summaries
          [devStr, aiStr, diskStr].filter(Boolean).join(" · ") + ".",
          `${nickname}: ${aiStr}, ${devStr}${diskStr ? ", " + diskStr : ""}.`,
          // Natural language variants
          devCount > 0 && aiReady ? `All systems up — ${devCount} plug${devCount !== 1 ? "s" : ""} on, AI standing by.` : null,
          devCount > 0 && aiReady ? `${nickname} is running clean. ${devCount} smart device${devCount !== 1 ? "s" : ""} active, AI ready.` : null,
          aiReady ? `AI is live on ${nickname}. ${devCount > 0 ? devCount + " device" + (devCount !== 1 ? "s" : "") + " connected." : "No smart devices registered."}` : null,
          aiReady ? `Everything looks good on ${nickname}. ${aiStr}, ${devStr}.` : null,
          !aiReady ? `AI is offline on ${nickname}. Device control and file browsing still work.` : null,
          devCount === 0 ? `${nickname} is online. No smart devices registered yet.` : null,
          devCount > 0 ? `${devCount} Shelly device${devCount !== 1 ? "s" : ""} are responding on this network.` : null,
          sys?.ok && sys.pct > 85 ? `${dLabel} is getting full — ${sys.pct}% used on ${nickname}.` : null,
          sys?.ok && sys.pct <= 85 ? `${sys.free_gb} GB free on ${dLabel}. Storage is healthy.` : null,
          `${nickname} is up. ${timeStr} — ${aiStr.toLowerCase()}, ${devStr}.`,
          aiReady && devCount > 0 ? `Quiet on the home front. ${devCount} device${devCount !== 1 ? "s" : ""} registered, AI ready.` : null,
          aiReady ? `${aiLabel} is running locally — nothing is leaving this network.` : null,
        ].filter(Boolean));
      },

      device: () => {
        if (!devNames.length) return null;
        const list = devNames.join(", ");
        const first = devNames[0];
        const both  = devNames.length === 2 ? `${devNames[0]} and ${devNames[1]}` : list;
        return pick([
          `${both} ${devCount === 1 ? "is" : "are"} registered and responding.`,
          `Smart home: ${list}. Say their names in chat to control them.`,
          `You have ${devCount} Shelly device${devCount !== 1 ? "s" : ""}: ${list}.`,
          `"Toggle ${first}" — say it in chat to switch it instantly.`,
          `${first} is under TLI control. Ask for its power draw, voltage, or relay status.`,
          devCount > 1 ? `${devNames[devNames.length - 1]} and ${devCount - 1} other device${devCount > 2 ? "s" : ""} are registered.` : null,
          `Your devices are named. TLI knows "${first}" — no IP addresses needed.`,
          `${list} — plain English works: "turn off ${first}", "is ${devNames[devNames.length - 1]} on?".`,
          `TLI has mapped ${devCount} smart plug${devCount !== 1 ? "s" : ""} to your LAN. ${first} is ready.`,
          devCount === 2 ? `Both ${devNames[0]} and ${devNames[1]} are registered. TLI can toggle them by name.` : null,
        ].filter(Boolean));
      },

      ai: () => pick(aiReady ? [
        `Check the chat source to see where ${nickname}'s AI runs. Optional online search and external services have their own connection settings.`,
        `${aiLabel} can answer questions, write scripts, and control devices — no cloud required.`,
        "Ask TLI to write a PowerShell script. It generates real, runnable code you can save and schedule.",
        "Teaching Mode walks through the AI's reasoning step by step — great for learning or auditing.",
        "New Chat starts a fresh conversation. Use saved notes controls whether relevant Notes & fixes can also be included.",
        "Precision mode makes the AI more technical. Creative mode lets it think freely.",
        "A [vault:key] reference can share a secret with the selected AI provider. Review the destination before sending.",
        `${aiLabel} doesn't log your conversations. Privacy is the default.`,
        "You can ask the AI to explain any process, file, or network event — it answers from local context.",
        "The AI can draft scripts, explain errors, and suggest fixes — all without leaving your LAN.",
        "Ask the AI anything about this machine. It has access to tools, files, and device status.",
        `${aiLabel} works even without internet. Power cut to the router? AI still runs on ${nickname}.`,
        "Default mode balances speed and quality. Precision mode goes deeper. Creative mode roams free.",
        "Every reply stays on your hardware. No usage data is collected. No external servers are contacted.",
        "Vault values shared with AI may appear in its reply or saved conversation. Share only what the task needs.",
      ] : [
        "No AI model is running. Start the bundled backend or connect LM Studio to enable chat.",
        "TLI works without an AI for device control and file browsing — but chat needs a model.",
        "The integrated AI model runs entirely on this machine. No internet required — fully local inference.",
        `${nickname} is ready. Start a model to unlock full chat and automation features.`,
      ]),

      mesh: () => meshSt !== "unpaired"
        ? pick([
          `${nickname} is meshed (${meshSt}). Nodes share AI context and files across your LAN.`,
          `Mesh is active — ${meshSt}. Multiple TLI nodes are collaborating on this network.`,
        ])
        : pick([
          `${nickname} is running solo. Add a second TLI node to share AI context across the LAN.`,
          "Mesh mode lets TLI nodes collaborate — share files, relay messages, distribute AI load.",
          "With Mesh, every device on your LAN becomes a node. Intelligence routes where it's needed.",
          "TLI Chat works over Mesh — send messages and files between nodes with no cloud relay.",
          `${nickname} is standalone right now. Mesh unlocks multi-room, multi-device intelligence.`,
          "Pair a second node via Settings → Mesh to start sharing context between machines.",
          "Mesh is off. When enabled, any TLI node on the LAN can answer for any other.",
          "Running solo on this network. Mesh nodes would let you extend TLI to every room.",
        ]),

      storage: () => {
        if (!sys?.ok) return null;
        const { used_gb, free_gb, total_gb, pct } = sys;
        const drives = Array.isArray(disk?.drives) ? disk.drives : [];
        const dc     = drives.length;
        return pick([
          pct > 90 ? `${dLabel} is critically full — ${pct}% used. Ask TLI to find what's taking space.` : null,
          pct > 85 ? `${dLabel} is ${pct}% full on ${nickname}. Consider clearing space soon.` : null,
          pct <= 85 ? `${dLabel} has ${free_gb} GB free of ${total_gb} GB — ${pct}% used.` : null,
          pct <= 85 ? `System drive ${dLabel}: ${used_gb} GB used, ${free_gb} GB still available.` : null,
          pct <= 60 ? `Plenty of space on ${nickname} — ${free_gb} GB free on ${dLabel}.` : null,
          dc > 1 ? `${dc} drives are mounted on ${nickname}. System drive ${dLabel} is at ${pct}%.` : null,
          dc > 1 ? `${nickname} has ${dc} drives. ${dLabel} (system) has ${free_gb} GB free.` : null,
          dc > 5 ? `${dc} drives detected — ${dLabel} is the system drive at ${pct}% capacity.` : null,
          `${dLabel}: ${used_gb} GB used of ${total_gb} GB total.`,
          `Storage check — ${dLabel} is ${pct}% full on ${nickname}.`,
        ].filter(Boolean));
      },

      vault: () => pick([
        "Vault protects file contents, secret values and private notes with a separate passphrase.",
        "Your TLI PIN and Vault passphrase are separate. Use Lock Vault to end Vault access for this account.",
        "Vault notes are separate from Notes & fixes and conversation history.",
        "Vault access lasts up to 30 minutes for this TLI account, including its other signed-in sessions.",
        "A downloaded Vault file is an unencrypted copy outside the Vault. Your browser chooses where to save it.",
        "Revealing or copying a secret is deliberate. Locking Vault does not erase your device’s clipboard.",
        "A [vault:key] reference can expose its value to a tool or AI provider and its output. Review before sharing.",
        "Vault encrypts contents on the TLI host. File names and Vault note titles remain visible as storage metadata.",
        "TLI cannot recover a forgotten Vault passphrase. Keep it somewhere safe.",
        "The encrypted Vault export is a partial copy. Retain the original installation and encryption metadata for recovery.",
      ]),

      tip: () => pick([
        `Use Ask TLI → Saved notes to save setup details and past fixes for ${nickname}. Saving stays in your control.`,
        "History saves every conversation. Tap History in chat to browse and resume past sessions.",
        "Advanced controls let you tune temperature and token limits per message.",
        "Use the Scripts panel to generate automations — PowerShell, Bash, or Python — and save them.",
        "TLI Chat lets mesh nodes send messages and files to each other with no cloud relay.",
        "The Tools panel runs one-click utilities: health check, top processes, printer scan, and more.",
        "LAN AI lets you offload inference to a more powerful machine on the same network.",
        `Home Automation responds to plain English — "Is the charger on?" or "Turn off the HDD."`,
        "Help → App performance check records CPU and memory for an app you choose. Review the readings before saving a report or asking AI; no settings are changed.",
        "File browser lets you explore this machine's directories and ask the AI to help organize them.",
        "Teaching Mode is great for clients — the AI explains every step like a patient instructor.",
        "The Abort button stops an AI response mid-stream. Useful if it goes off track.",
        "New Chat leaves earlier messages behind. Review the context summary and Use saved notes setting before sending.",
        "You can inject a Vault secret into any message without it appearing in the chat log.",
        `${nickname} is your private LAN console. Free tier covers most features — Pro unlocks the rest.`,
        "The AI can read system logs, explain errors, and suggest fixes — all without internet.",
        "Rename your Shelly devices anything you like — TLI will refer to them by that name everywhere.",
        "Mode selector lets you switch between Default, Precise, and Creative AI personalities on the fly.",
      ]),

      time: () => {
        const runningStr = aiReady ? "AI is ready" : "AI is offline";
        const devStr     = devCount > 0 ? `${devCount} device${devCount !== 1 ? "s" : ""} connected` : "no devices registered";
        return pick([
          `${greeting}. ${nickname} is online and ready.`,
          `${greeting} — ${runningStr} and ${devStr}.`,
          hour >= 22 || hour < 5 ? `${nickname} is running through the night. All systems nominal.` : null,
          hour >= 5 && hour < 9  ? `Early start on ${nickname}. ${runningStr}.` : null,
          hour >= 9 && hour < 17 ? `${nickname} is up and running. ${runningStr}.` : null,
          hour >= 17 && hour < 21 ? `Evening on ${nickname}. ${devStr}, ${runningStr}.` : null,
          `${greeting}. You're on ${nickname} — ${runningStr}.`,
          `It's ${timeStr} on ${nickname}. ${runningStr}, ${devStr}.`,
          `${nickname} has been online since startup. ${runningStr}.`,
          `${greeting} from ${nickname}. Everything is running locally.`,
        ].filter(Boolean));
      },

      capability: () => pick([
        "TLI can scan your LAN, identify devices, check open ports, and ping any host — all offline.",
        "Ask TLI to check your printer, scan for USB devices, or list top running processes.",
        "TLI's intent engine understands natural language for device control — no exact commands needed.",
        "Everything TLI does stays on your LAN. No telemetry. No cloud. No copies.",
        "TLI is self-hosted. You own the code, the data, and the AI model running it.",
        `Scripts panel generates real automations you can schedule with ${_tliIsWindows() ? "Windows Task Scheduler" : "cron or systemd timers"}.`,
        "The Vault, AI, and device control all work without an internet connection.",
        "TLI can explain what a process is, why it's using RAM, and whether it's safe — just ask.",
        "Ask TLI to summarise a folder, find large files, or explain a PowerShell error.",
        "TLI Chat is a local messenger between your mesh nodes — no Slack, no Discord, no cloud.",
        "You can give the AI a Vault secret at chat time — it uses it once and forgets it.",
        "TLI generates scripts from plain English. Describe what you want — it writes the code.",
        "The file browser lets you navigate this machine and ask the AI about anything you find.",
        "Choose a trusted computer and model in Ask TLI's AI control to use its inference resources. LAN inference is explicitly selected.",
        "Every panel in TLI works offline. No feature requires an internet connection.",
      ]),

      awareness_storage: () => {
        if (!sys?.ok) return null;
        const { pct, free_gb } = sys;
        if (pct >= 95) {
          return {
            text: `${dLabel} is critically full at ${pct}% — only ${free_gb} GB left. The Visualizer can show you exactly what to clear.`,
            type: "ACTION_PROMPT",
            severity: "critical",
            action: { label: "Review Files", onclick: `switchPanelAndScan('panel-visualizer', ${JSON.stringify(sys?.mount || ((_tliIsWindows() ? 'C:\\\\' : '/')))})` },
          };
        }
        if (pct >= 85) {
          return {
            text: `${dLabel} is at ${pct}% — ${free_gb} GB remaining. Worth a look in the Visualizer before things get tight.`,
            type: "ACTION_PROMPT",
            severity: "warning",
            action: { label: "Review Files", onclick: `switchPanelAndScan('panel-visualizer', ${JSON.stringify(sys?.mount || ((_tliIsWindows() ? 'C:\\\\' : '/')))})` },
          };
        }
        if (pct >= 75) {
          return {
            text: `${dLabel} is at ${pct}% capacity — ${free_gb} GB still free. Nothing urgent, but worth keeping an eye on.`,
            type: "AWARENESS",
            severity: "info",
          };
        }
        return null; // healthy — let the regular storage category handle it
      },

      alert: () => {
        const alerts = (_lastData?.activeAlerts || []);
        if (!alerts.length) return null;
        // Surface highest-severity alert first
        const sorted = [...alerts].sort((a, b) => {
          const rank = { critical: 3, warn: 2, info: 1 };
          return (rank[b.severity] || 0) - (rank[a.severity] || 0);
        });
        const a = sorted[0];
        // Map alert kind → panel navigation
        // alert.detail carries the exact mount point from the backend
        const _actionFor = (kind, alert) => {
          if (!kind) return null;
          if (kind.startsWith("disk_critical") || kind.startsWith("disk_warn")) {
            // Use the mount point the backend detected (detail field)
            // Fall back to OS-appropriate root if detail is missing
            const scanPath = (alert && alert.detail)
              ? alert.detail
              : (_tliIsWindows() ? "C:\\" : "/");
            return { label: "Review Storage", onclick: `switchPanelAndScan('panel-visualizer', ${JSON.stringify(scanPath)})` };
          }
          if (kind.startsWith("shelly_offline_"))
            return { label: "Open Devices",   onclick: "switchPanel('panel-homeauto')" };
          if (kind.startsWith("mesh_offline_"))
            return { label: "Open Mesh",      onclick: "switchPanel('panel-mesh')" };
          return null;
        };
        return {
          text:     a.message || "System alert active.",
          type:     a.severity === "critical" ? "ACTION_PROMPT" : "AWARENESS",
          severity: a.severity === "critical" ? "critical" : "warning",
          action:   _actionFor(a.kind, a),
        };
      },

      fact: () => pick([
        `TLI v${TLI_VERSION || "0.9.0"} is running on ${nickname}.`,
        "TLI was designed as a private, offline-first Home OS for LAN power users.",
        "All AI inference happens locally. The model never phones home.",
        "TLI's integrated AI uses quantised models — fast on consumer hardware, no GPU required.",
        "You can rename any Shelly device in Home Automation and TLI will use that name everywhere.",
        "The Narrator refreshes live data every 30 seconds and cycles through system insights.",
        "TLI remembers your settings, chat history, and vault data between sessions.",
        `${nickname} is your private LAN console. Local-first. No cloud. Your data never leaves this network.`,
        "TLI was built to run on your hardware, serve your LAN, and stay out of your way.",
        "The integrated AI model is fully quantised — tuned for speed on low-power hardware.",
        "Your Vault is AES-encrypted on disk. Not even TLI's backend reads plaintext secrets.",
        "TLI's Narrator is driven entirely by live data fetched from your local backend.",
        "Every smart device name you set is stored locally and referenced by the AI, the Narrator, and the feed.",
      ]),
    };

    const fn = map[cat];
    let result = fn ? fn() : null;
    // Normalize plain strings → GUIDANCE objects; structured categories return objects directly
    if (typeof result === "string") {
      result = result ? { text: result, type: "GUIDANCE" } : null;
    }
    if (result?.text) {
      _recentStatements.push(result.text);
      if (_recentStatements.length > 8) _recentStatements.shift();
    }
    return result;
  }

  function _el(id) { return document.getElementById(id); }

  function _dashEsc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function _runSuggestion(item) {
    if (!item) return;
    if (item.kind === "chat_seed") {
      window._tliDashChatAction(item.prompt || item.context || item.title || "");
      return;
    }
    const target = item.target || item.panel || "";
    if (!target) return;
    if (target === "panel-visualizer") {
      _openStorage(item.scan_path);
      return;
    }
    if (typeof switchPanel === "function") switchPanel(target);
  }

  function _openStorage(path) {
    if (!path) { switchPanel('panel-visualizer'); return; }
    if (window.TLIStorageWorkspace?.prepare) {
      window.TLIStorageWorkspace.prepare({view:'space', root:path || '', source:'dashboard'});
      return;
    }
    if (path && typeof window.TLIVisualizer?.scanPath === 'function') {
      switchPanel('panel-visualizer');
      window.TLIVisualizer.scanPath(path);
      return;
    }
    switchPanel('panel-visualizer');
    const input = document.getElementById('visualizerPathInput');
    if (input && path) {
      input.value = path;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input?.focus();
  }

  // ── Vitals ───────────────────────────────────────────────────
  function _setVital(base, val, sub) {
    const v = _el("ndv-" + base + "-val");
    const s = _el("ndv-" + base + "-sub");
    if (v) v.textContent = val;
    if (s) s.textContent = sub;
  }

  // ── Orb ──────────────────────────────────────────────────────
  function _setOrb(state) {
    const orb   = _el("nd-orb");
    const label = _el("nd-status-label");
    if (!orb) return;
    const colors = { good: "var(--accent)", warn: "#f59e0b", idle: "#6b7280" };
    orb.style.background = colors[state] || colors.idle;
    orb.style.boxShadow  = state === "good" ? "0 0 14px var(--accent)" : "none";
    if (label) label.textContent = state === "good" ? "CHECKED" : state === "warn" ? "ATTENTION" : "UNKNOWN";
  }

  // ── Live activity feed seeding ────────────────────────────────

  async function _seedFeed() {
    const epoch = _viewEpoch;
    // 1. Action receipts (Shelly toggles, saved actions, etc.)
    try {
      let receipts = Array.isArray(_lastData?.recent_receipts) ? _lastData.recent_receipts.slice() : null;
      if (!receipts) {
        const data = await fetch("/actions/receipts?limit=10", { signal: AbortSignal.timeout(4000) })
          .then(r => r.ok ? r.json() : null);
        receipts = data?.items || [];
      }
      if (epoch !== _viewEpoch || _sessionLocked) return;
      receipts = receipts.reverse();
      receipts.forEach(r => {
        const key = "r:" + (r.ts || "") + "|" + (r.kind || "");
        if (_seenFeedIds.has(key)) return;
        _seenFeedIds.add(key);
        const label = r.summary || r.kind || "Action";
        const failed = r.ok === false || r.receipt?.ok === false ||
          (Array.isArray(r.results) && r.results.some(step => step.ok === false));
        _feedLog("⚡ " + label, failed ? "error" : "good", r.ts);
      });
    } catch {}

    // 2. Active alerts (disk, Shelly offline, mesh offline)
    if (epoch !== _viewEpoch || _sessionLocked) return;
    const alerts = _lastData?.activeAlerts || [];
    alerts.forEach(a => {
      const key = "a:" + (a.id || a.kind || a.message || "");
      if (!key || _seenFeedIds.has(key)) return;
      _seenFeedIds.add(key);
      const type = a.severity === "critical" ? "error" : "warn";
      _feedLog(a.message || "System alert", type, a.created_at);
    });
  }

  // ── Mesh presence SSE (live node join/drop events) ────────────

  function _startDashSSE() {
    if (_dashSse || !_open || _sessionLocked || document.hidden) return;
    try {
      const es = new EventSource("/mesh/presence/stream");
      _dashSse = es;
      es.onmessage = e => {
        if (!_open || _sessionLocked || document.hidden || _dashSse !== es) return;
        try {
          const evt = JSON.parse(e.data);
          if (evt.type === "node_online") {
            _feedLog(`${evt.name || evt.node_id || "Node"} joined the mesh`, "mesh");
          } else if (evt.type === "node_offline") {
            _feedLog(`${evt.name || evt.node_id || "Node"} went offline`, "warn");
          }
        } catch {}
      };
      es.onerror = () => { if (_dashSse === es) _stopDashSSE(); };
    } catch {}
  }

  function _stopDashSSE() {
    if (_dashSse) { _dashSse.close(); _dashSse = null; }
  }

  // ── Narrator cycling ─────────────────────────────────────────
  function _pickCategory() {
    const d = _lastData || {};
    // Critical alerts always surface — bypass normal rotation 50% of the time
    const criticals = (d.activeAlerts || []).filter(a => a.severity === "critical");
    if (criticals.length && _lastCategory !== "alert" && Math.random() < 0.5) {
      _lastCategory = "alert";
      return "alert";
    }
    const available = CATEGORIES.filter(c => {
      if (c === "device"            && !d.devNames?.length)     return false;
      if (c === "storage"           && !d.diskData?.ok)         return false;
      if (c === "awareness_storage" && !d.diskData?.ok)         return false;
      if (c === "alert"             && !d.activeAlerts?.length) return false;
      return true;
    });
    const choices = available.filter(c => c !== _lastCategory);
    const pick = choices[Math.floor(Math.random() * choices.length)];
    _lastCategory = pick;
    return pick;
  }

  function _typeText(text, onDone) {
    if (_typeTimer) { clearInterval(_typeTimer); _typeTimer = null; }
    const el = _el("nd-statement-text");
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = text;
      if (onDone) onDone();
      return;
    }
    let i = 0;
    el.textContent = "";
    _typeTimer = setInterval(() => {
      if (i < text.length) { el.textContent += text[i++]; }
      else {
        clearInterval(_typeTimer); _typeTimer = null;
        if (onDone) onDone();
      }
    }, 22);
  }

  function _narratorNext() {
    if (_serverNarrator) return;
    if (!_open) return;
    const cat = _pickCategory();
    const msg = _buildStatement(cat);
    if (!msg) { _narratorNext(); return; }

    const stmt = _el("nd-statement");
    if (stmt) stmt.style.opacity = "0";

    // v1.3: reset any event-driven severity styling when cycling back to normal
    const narratorEl = _el("nd-narrator");
    if (narratorEl) narratorEl.dataset.narratorType = "status";

    setTimeout(() => {
      if (!_open) return;
      _typeText(msg.text);
      _setNarratorCard(msg);
      if (stmt) stmt.style.transition = "opacity 0.5s";
      if (stmt) stmt.style.opacity    = "1";
      // Feed log for observational categories (not pure tips/capabilities/facts)
      const _feedCats = ["state","device","storage","mesh","ai","awareness_storage","alert"];
      if (_feedCats.includes(cat)) {
        const _feedType = msg.severity === "critical" ? "error"
          : msg.severity === "warning"  ? "warn"
          : (_lastData?.aiOk || _lastData?.lmOnline ? "good" : "warn");
        _feedLog(msg.text, _feedType);
      }
    }, 450);
  }

  function _setMeta(text) {
    const el = _el("nd-meta-line");
    if (el) el.textContent = text;
  }

  // ── Narrator card metadata (type label, severity dot, action button) ──
  function _setNarratorCard(msg) {
    const typeEl   = _el("nd-msg-type");
    const sevEl    = _el("nd-msg-severity");
    const actionEl = _el("nd-msg-action");
    const type     = msg.type || "GUIDANCE";

    if (typeEl) {
      const labels = { GUIDANCE: "", AWARENESS: "Awareness", ACTION_PROMPT: "Action", CONFIRMATION: "Done" };
      const label  = labels[type] || "";
      typeEl.textContent   = label;
      typeEl.style.display = label ? "" : "none";
      typeEl.dataset.type  = type;
    }

    if (sevEl) {
      const attention = ['warning','critical'].includes(msg.severity);
      sevEl.textContent = '';
      sevEl.dataset.severity = msg.severity || 'info';
      sevEl.setAttribute('aria-label', msg.severity || 'Information');
      sevEl.style.display = attention ? "" : "none";
    }

    if (actionEl) {
      if (msg.action) {
        actionEl.innerHTML     = `<button class="nd-action-btn" onclick="${msg.action.onclick.replace(/"/g, "&quot;")}">${msg.action.label}</button>`;
        actionEl.style.display = "";
      } else {
        actionEl.innerHTML     = "";
        actionEl.style.display = "none";
      }
    }
  }

  // ── Activity feed ─────────────────────────────────────────────
  function _feedLog(msg, type, isoTs) {
    const feed = _el("nd-feed");
    if (!feed) return;
    const item = document.createElement("div");
    const t    = isoTs
      ? new Date(isoTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dot  = type === "warn" ? "🟡" : type === "error" ? "🔴" : type === "mesh" ? "🔵" : "🟢";
    item.innerHTML =
      `<span style="font-size:10px;color:var(--text-soft);flex-shrink:0;">${t}</span>` +
      `<span style="margin:0 5px;flex-shrink:0;">${dot}</span>` +
      `<span style="font-size:12px;color:var(--text-muted);">${String(msg).replace(/</g,"&lt;")}</span>`;
    item.style.cssText = "display:flex;gap:4px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--border-subtle);";
    feed.insertBefore(item, feed.firstChild);
    while (feed.children.length > 25) feed.removeChild(feed.lastChild);
  }

  // ── Suggested actions ─────────────────────────────────────────
  window._tliDashChatAction = function(q) {
    return window.TLIChatWorkspace?.prepareDraft(q) || false;
  };

  function _renderActions(aiOk, devNames) {
    const el = _el("nd-actions");
    if (!el) return;
    const mount = _lastData?.diskData?.system?.mount || '';
    const chat = prompt => () => window._tliDashChatAction(prompt);
    const actions = [
      { icon: "💬", label: "Ask TLI anything", run: () => { switchPanel('panel-main'); document.getElementById('chat-input')?.focus(); } },
      { icon: "🩺", label: "What's slowing me down?", run: chat('Check host resources') },
      { icon: "🌐", label: "Map this network", run: chat('Scan the local network and list all active LAN devices.') },
      { icon: "📁", label: "Review Free Space", run: () => _openStorage(mount) },
      { icon: "🔑", label: "Open Vault", run: () => switchPanel('panel-vault') },
    ];
    if (devNames.length) {
      actions.splice(3, 0, { icon: "🏠", label: "Control smart home", run: () => switchPanel('panel-homeauto') });
      actions.splice(4, 0, { icon: "⚡", label: `Toggle ${devNames[0]}`, run: chat(`Toggle ${devNames[0]}`) });
    }
    if (!aiOk) actions.push({ icon: "🤖", label: "Check AI availability", run: () => document.getElementById('ai-source-pill')?.click() });
    el.replaceChildren();
    actions.forEach(action => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip-button';
      const iconName = {'💬':'chat','🩺':'tools','🌐':'network','📁':'folder','🔑':'lock','🏠':'home','⚡':'flow','🤖':'settings'}[action.icon];
      const icon = window.TLIUI?.icon(iconName);
      if (icon) button.append(icon);
      button.append(document.createTextNode(action.label));
      button.addEventListener('click', action.run);
      el.append(button);
    });
  }

  // ── Quick Read findings ───────────────────────────────────────
  function _renderQuickRead(data) {
    const el = _el("nd-quickread");
    if (!el) return;
    const sys   = data.diskData?.system || data.diskData;
    const chips = [];

    if (data.diskData?.ok && window.TLIUIHealth?.percent(sys?.pct) != null) {
      if (sys.pct >= 85)
        chips.push({ icon: "💾", text: `${sys.drive || "C:"} ${sys.pct}% full`, cls: "warn" });
      else if (sys.pct >= 70 && typeof sys.free_gb === 'number' && Number.isFinite(sys.free_gb))
        chips.push({ icon: "💾", text: `${sys.free_gb} GB free`, cls: "" });
      else
        chips.push({ icon: "💾", text: `${sys.drive || 'System drive'} ${sys.pct}% used`, cls: "ok" });
    }
    if (data.devCount > 0)
      chips.push({ icon: "🏠", text: `${data.devCount} device${data.devCount !== 1 ? "s" : ""} registered`, cls: "ok" });
    if (data.aiOk || data.lmOnline)
      chips.push({ icon: "🧠", text: data.aiOk ? "AI ready" : "LM Studio", cls: "ok" });
    else
      chips.push({ icon: "🧠", text: data.aiOk === false && data.lmOnline === false ? "AI unavailable" : "AI status unknown", cls: "" });

    if (!chips.length) { el.hidden = true; return; }
    el.hidden = false;
    el.replaceChildren();
    chips.forEach(chip => {
      const finding = document.createElement('span');
      finding.className = 'nd-quickread__chip' + (chip.cls ? ' nd-quickread__chip--' + chip.cls : '');
      finding.textContent = chip.text;
      el.append(finding);
    });
  }

  // ── Smart suggestions ─────────────────────────────────────────
  function _renderSuggestions(data) {
    const el = _el("nd-suggestions");
    if (!el) return;

    const serverSuggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(0, 5) : [];
    if (serverSuggestions.length) {
      el.hidden = false;
      el.innerHTML = `<span class="nd-suggestions__label">Try</span>` +
        serverSuggestions.map((c, idx) =>
          `<button class="nd-sugg-chip" data-suggestion-index="${idx}" title="${_dashEsc(c.reason || c.title || c.context || "")}">${_dashEsc(c.label || c.title || "Open")}</button>`
        ).join("");
      el.querySelectorAll("[data-suggestion-index]").forEach(btn => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.getAttribute("data-suggestion-index"));
          _runSuggestion(serverSuggestions[idx]);
        });
      });
      return;
    }

    const sys = data.diskData?.system || data.diskData;
    const chips = [];
    if (data.diskData?.ok && sys && sys.pct >= 70) {
      chips.push({ label: 'Review Free Space', run: () => _openStorage(sys.mount) });
    }
    if (!data.aiOk && !data.lmOnline)
      chips.push({ label: 'Manage AI model', run: () => document.getElementById('ai-source-pill')?.click() });
    if (data.devCount === 0)
      chips.push({ label: 'Add smart device', run: () => switchPanel('panel-homeauto') });
    if (data.meshSt === 'unpaired')
      chips.push({ label: 'Connect a peer', run: () => switchPanel('panel-mesh') });
    el.hidden = chips.length === 0;
    el.replaceChildren();
    chips.forEach(chip => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nd-sugg-chip';
      button.textContent = chip.label;
      button.addEventListener('click', chip.run);
      el.append(button);
    });
  }

  // ── Data refresh (every 30s) ──────────────────────────────────
  async function _refresh() {
    if (!_open || _sessionLocked || document.hidden) return;
    if (_refreshPending) return _refreshPending;
    _refreshPending = _refreshOnce();
    try { return await _refreshPending; } finally { _refreshPending = null; }
  }

  async function _refreshOnce() {
    const epoch = _viewEpoch;
    const identityStartedAt = Date.now();
    try {
      let accessRejected = false;
      let data = await fetch("/dashboard/command-center", {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(12000),
      }).then(r => { accessRejected = r.status === 401 || r.status === 403; return r.ok ? r.json() : null; }).catch(() => null);
      if (accessRejected) throw new Error('Unlock TLI to check the Dashboard.');

      if (data && (typeof data !== 'object' || Array.isArray(data) || data.ok === false)) data = null;
      if (!data) {
        const [statusRes, devRes, aiRes, diskRes, alertsRes] = await Promise.allSettled([
          fetch("/status",                { signal: AbortSignal.timeout(5000), cache: "no-store" }).then(r => r.ok ? r.json() : null),
          fetch("/homeauto/devices",      { signal: AbortSignal.timeout(5000), cache: "no-store" }).then(r => r.ok ? r.json() : null),
          fetch("/api/ai/bundled/status", { signal: AbortSignal.timeout(5000), cache: "no-store" }).then(r => r.ok ? r.json() : null),
          fetch("/api/system/disk",       { signal: AbortSignal.timeout(5000), cache: "no-store" }).then(r => r.ok ? r.json() : null),
          fetch("/status/alerts",         { signal: AbortSignal.timeout(5000), cache: "no-store" }).then(r => r.ok ? r.json() : null),
        ]);

        const status       = statusRes.status === "fulfilled" ? statusRes.value : null;
        const devData      = devRes.status    === "fulfilled" ? devRes.value    : null;
        const aiData       = aiRes.status     === "fulfilled" ? aiRes.value     : null;
        const diskData     = diskRes.status   === "fulfilled" ? diskRes.value   : null;
        const alertsData   = alertsRes.status === "fulfilled" ? alertsRes.value : null;
        const devices      = Array.isArray(devData?.devices) ? devData.devices : [];
        const devNames     = devices.map((d, i) => (d.name?.trim()) ? d.name.trim() : `Device ${i + 1}`);
        data = {
          aiOk: typeof aiData?.healthy === 'boolean' ? aiData.healthy : null,
          lmOnline: typeof status?.model_online === 'boolean' ? status.model_online : null,
          devNames,
          devCount: Array.isArray(devData?.devices) ? devices.length : null,
          nickname: status?.device_nickname || null,
          node: status ? {id: status.device_id || status.node_id, name: status.device_nickname} : null,
          identitySource: 'status',
          nodeRole: status?.node_role || "standalone",
          meshSt: status?.mesh_status || "unpaired",
          diskData: diskData || {},
          activeAlerts: (alertsData?.alerts || []).filter(a => !a.dismissed),
          suggestions: [],
          current_action: null,
        };
        if (!status && !aiData && !diskData && !devData) throw new Error('Monitoring unavailable');
      }

      if (epoch !== _viewEpoch || _sessionLocked || !_open) return;
      const aiOk         = typeof data.aiOk === 'boolean' ? data.aiOk : null;
      const lmOnline     = typeof data.lmOnline === 'boolean' ? data.lmOnline : null;
      const devNames     = Array.isArray(data.devNames) ? data.devNames : [];
      const devCount     = Number.isInteger(data.devCount) && data.devCount >= 0 ? data.devCount : null;
      window.TLIUI?.hostIdentity?.observe({id: data.node?.id || data.node_id || data.device_id, name: data.node?.name || data.nickname,
        observedAt: Number.isFinite(data.ts) && data.ts > 0 ? data.ts * 1000 : identityStartedAt,
        source: data.identitySource || 'dashboard/command-center'});
      const nickname     = window.TLIUI?.hostIdentity ? (window.TLIUI.hostIdentity.get().name || 'Not confirmed') : (data.node?.name || data.nickname || 'Not confirmed');
      const nodeRole     = data.nodeRole || data.node?.role || "standalone";
      const meshSt       = data.meshSt || data.node?.mesh_status || "unpaired";
      const diskData     = data.diskData || data.storage || {};
      const activeAlerts = Array.isArray(data.activeAlerts) ? data.activeAlerts : [];

      // Cache for Narrator statements
      if (data.narrator) setEventMessage(data.narrator);
      _lastRefreshFailed = false;
      _lastData = Object.assign({}, data, {
        aiOk, lmOnline, devNames, devCount, nickname, nodeRole, meshSt, diskData, activeAlerts,
      });
      if (data.state) window.TLIPresence?.acceptSnapshot?.(data);
      // Only the action owner reads and versions the queue. This aggregate may
      // predate a just-completed action, and legacy fallback has no queue facts.
      window.TLIPresence?.fetchActionCurrent?.();
      // Seed activity feed from backend events (fire-and-forget)
      _seedFeed();
      // Refresh mesh health strip (independent — may take up to 6s for peer pings)
      _refreshMeshStrip();

      // Vitals
      const meshLabel = meshSt === "unpaired" ? "Mesh: standalone" : `Mesh: ${meshSt}`;
      _setVital("node", nickname, nodeRole === 'standalone' ? 'This computer · Standalone' : `${nodeRole} · ${meshLabel}`);
      const sysDrive = diskData?.system || diskData;
      const driveLabel = sysDrive?.drive || "System drive";
      const diskKnown = diskData?.ok && window.TLIUIHealth?.percent(sysDrive?.pct) != null;
      _setVital("storage",
        diskKnown ? `${sysDrive.pct}%` : "—",
        diskKnown ? `${driveLabel}${typeof sysDrive.used_gb === 'number' && typeof sysDrive.total_gb === 'number' ? ` · ${sysDrive.used_gb} GB used of ${sysDrive.total_gb} GB` : ' · Capacity details unavailable'}` : "Storage reading unavailable");
      const meter = _el('ndv-storage-meter');
      if (meter) { meter.hidden = !diskKnown; if (diskKnown) { meter.value = sysDrive.pct; meter.setAttribute('aria-label', `${driveLabel}: ${sysDrive.pct}% used`); } }
      _setVital("smart", devCount !== null ? String(devCount) : "—",
                         devCount > 0 ? devNames.slice(0, 3).join(", ") + (devCount > 3 ? ` +${devCount - 3}` : "") : devCount === 0 ? "No devices registered" : "Device inventory unavailable");
      const presentation = window.TLIUIHealth?.dashboard({ ..._lastData, aiSource: window.TLIAISource?.getSnapshot?.() }) || {
        aiLabel: aiOk ? 'Bundled' : lmOnline ? 'LM Studio' : 'Unknown',
        aiDetail: 'Check AI readiness in the model library', orb: 'idle', aiReady: aiOk === true || lmOnline === true,
      };
      _setVital("ai", presentation.aiLabel, presentation.aiDetail);

      const _overallGood = presentation.aiReady;
      _renderObservationSummary();
      _renderActions(_overallGood, devNames);
      _renderQuickRead(_lastData);
      _renderSuggestions(_lastData);

      // Make storage vital tile clickable → opens visualizer at system drive
      const _svTile = document.getElementById("nd-storage-vital-tile");
      if (_svTile) {
        const _sMnt = diskKnown ? sysDrive?.mount || '' : '';
        _svTile.classList.add("nd-vital--clickable");
        _svTile.dataset.scanPath = _sMnt;
        _svTile.title = _sMnt ? `Review ${_sMnt} in Free Space` : 'Open Free Space';
        _svTile.setAttribute('role', 'button'); _svTile.tabIndex = 0;
        if (!_svTile._tliClickBound) {
          _svTile.addEventListener("click", function () {
            _openStorage(this.dataset.scanPath);
          });
          _svTile.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.click(); } });
          _svTile._tliClickBound = true;
        }
      }

      // Always log a state snapshot on each data refresh so the feed is never empty
      const _snapParts = [];
      if (devCount > 0) _snapParts.push(`${devCount} device${devCount !== 1 ? "s" : ""} registered`);
      _snapParts.push('AI: ' + presentation.aiLabel);
      if (diskKnown) _snapParts.push(`${driveLabel} ${sysDrive.pct}%`);
      _feedLog(_snapParts.join(" · ") + ".", presentation.orb === 'warn' ? 'warn' : 'info');

    } catch (e) {
      if (epoch !== _viewEpoch || _sessionLocked || !_open) return;
      _lastRefreshFailed = true;
      _renderObservationSummary();
      setEventMessage({ type: "alert", text: "System monitoring is unavailable. TLI could not be reached for a fresh check." });
      _feedLog("Backend unreachable — check the server.", "error");
    }
  }

  function _renderObservationSummary() {
    const shared = window.TLIPresence?.getObservation?.();
    const aiSource = window.TLIAISource?.getSnapshot?.();
    const facts = window.TLIUIHealth?.dashboard({ ...(_lastData || {}), ...(shared || {}), aiSource });
    if (!facts) return;
    const observed = facts.observed;
    if (aiSource) _setVital('ai', facts.aiLabel, facts.aiDetail);
    if (shared?.storage) {
      const disk = shared.storage.system || shared.storage;
      const label = disk.drive || disk.mount || 'System drive';
      _setVital('storage', `${disk.pct}%`, `${label}${typeof disk.free_gb === 'number' && Number.isFinite(disk.free_gb) ? ` · ${disk.free_gb} GB free` : ''}${typeof disk.total_gb === 'number' && Number.isFinite(disk.total_gb) ? ` of ${disk.total_gb} GB` : ''}`);
      const meter = _el('ndv-storage-meter'); if (meter) { meter.hidden = false; meter.value = disk.pct; meter.setAttribute('aria-label', `${label}: ${disk.pct}% used`); }
      const tile = _el('nd-storage-vital-tile'); if (tile) tile.dataset.scanPath = disk.mount || '';
    }
    const storageScope = _el('ndv-storage-scope');
    if (storageScope && shared) {
      const stamp = shared.storageCheckedAt ? new Date(shared.storageCheckedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : null;
      const stale = shared.storageCheckedAt && Date.now() - shared.storageCheckedAt >= 30000;
      storageScope.textContent = stamp ? `${shared.monitoringUnavailable || shared.storageUnavailable ? 'Refresh unavailable · last check' : stale ? 'Previous reading' : 'Checked'} ${stamp}` : 'Storage has not been checked';
      storageScope.dataset.freshness = shared.monitoringUnavailable || shared.storageUnavailable ? 'unavailable' : stale ? 'stale' : stamp ? 'fresh' : 'unknown';
    }
    if (shared?.devCount !== null && shared?.devCount !== undefined) {
      _setVital('smart', String(shared.devCount), shared.devCount ? shared.devNames.slice(0, 3).join(', ') + (shared.devCount > 3 ? ` +${shared.devCount - 3}` : '') : 'No devices registered');
    }
    const metric = _el('ndv-node-metrics'), state = shared?.state || _lastData?.state || {};
    if (metric) {
      const pct = window.TLIUIHealth?.percent;
      metric.textContent = `CPU ${pct?.(state.cpu_pct) != null ? state.cpu_pct + '%' : 'unknown'} · Memory ${pct?.(state.ram_pct) != null ? state.ram_pct + '%' : 'unknown'}`;
      metric.dataset.freshness = observed.freshness;
    }
    const stamp = observed.stamp ? new Date(observed.stamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : 'No successful system probe';
    const failed = shared ? shared.monitoringUnavailable : _lastRefreshFailed;
    _setOrb(failed ? 'idle' : facts.orb);
    _setMeta(`${_lastData?.nickname || 'TLI host'} · ${failed ? (observed.stamp ? 'Monitoring unavailable; previous results retained' : 'Monitoring unavailable; no successful readings yet') : observed.label} · ${stamp}`);
    const meta = _el('nd-meta-line'); if (meta) meta.dataset.freshness = failed ? 'unavailable' : observed.freshness;
  }

  // ── Mesh health strip ─────────────────────────────────────────

  function _renderMeshStrip(nodes) {
    const strip    = document.getElementById("nd-mesh-strip");
    const container = document.getElementById("nd-mesh-nodes");
    if (!strip || !container) return;

    // Only show if there are peers (more than just self)
    const peers = nodes.filter(n => !n.is_self);
    if (!peers.length) { strip.hidden = true; return; }

    strip.hidden = false;
    const allNodes = nodes; // self first, then peers

    container.innerHTML = allNodes.map(n => {
      const facts = window.TLIUIHealth?.meshNode(n);
      const offline = n.online === false;
      const name     = n.node_name || n.hostname || "Unknown";
      const cpu      = facts?.cpu != null ? Math.round(facts.cpu) : null;
      const ram      = facts?.ram != null ? Math.round(facts.ram) : null;
      const aiOk     = n.ai_healthy === true;
      const aiModel  = n.active_model || (n.active_preset ? n.active_preset : null);
      const cpuWarn  = cpu !== null && cpu >= 80;

      const cpuStat  = cpu !== null
        ? `<span class="nd-mesh-node__stat${cpuWarn ? " nd-mesh-node__stat--warn" : ""}">CPU ${cpu}%</span>`
        : `<span class="nd-mesh-node__stat">CPU unknown</span>`;
      const ramStat  = ram !== null
        ? `<span class="nd-mesh-node__stat">RAM ${ram}%</span>`
        : `<span class="nd-mesh-node__stat">RAM unknown</span>`;
      const aiStat   = aiOk
        ? `<span class="nd-mesh-node__stat nd-mesh-node__stat--ai">AI ready${aiModel ? " · " + _dashEsc(aiModel) : ""}</span>`
        : `<span class="nd-mesh-node__stat nd-mesh-node__stat--ai-off">${facts?.ai || 'AI status unknown'}</span>`;
      const selfTag  = n.is_self
        ? `<span class="nd-mesh-node__self">TLI host</span>`
        : "";
      const offlineTag = offline && !n.is_self
        ? `<span class="nd-mesh-node__stat">Not reachable</span>`
        : `<span class="nd-mesh-node__stat">${facts?.availability || 'Status unknown'}</span>`;

      return `<div class="nd-mesh-node${offline && !n.is_self ? " nd-mesh-node--offline" : ""}">
        <div class="nd-mesh-node__dot"></div>
        <div class="nd-mesh-node__name">${_dashEsc(name)}</div>
        ${selfTag}
        <div class="nd-mesh-node__stats">
          ${offlineTag}${offline ? '' : cpuStat + ramStat + aiStat}
        </div>
      </div>`;
    }).join("");
  }

  async function _refreshMeshStrip() {
    const epoch = _viewEpoch;
    const strip = _el('nd-mesh-strip');
    let observed = strip?.querySelector('.ui-mesh-observed');
    if (strip && !observed) { observed = document.createElement('p'); observed.className = 'ui-mesh-observed small-meta'; strip.append(observed); }
    try {
      const data = await fetch("/api/mesh/health", { signal: AbortSignal.timeout(6000) })
        .then(r => r.ok ? r.json() : null);
      if (epoch !== _viewEpoch || _sessionLocked) return;
      if (!Array.isArray(data?.nodes)) throw new Error('No computer readings');
      _renderMeshStrip(data.nodes);
      _meshObservedAt = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      if (observed) observed.textContent = `Computers checked ${_meshObservedAt}`;
    } catch {
      if (epoch !== _viewEpoch || _sessionLocked) return;
      if (observed) observed.textContent = _meshObservedAt ? `Computer refresh unavailable. Previous results from ${_meshObservedAt}.` : 'Computer readings unavailable.';
    }
  }

  // ── Public API ────────────────────────────────────────────────
  function onOpen() {
    _panelOpen = true;
    if (_open || _sessionLocked || document.hidden) return;
    _open = true;
    _serverNarrator = null;
    // Server Narrator owns awareness and confirmation timing.
    _typeText("I'm reading your environment.");
    _startDashSSE();
    Promise.resolve(_refreshPending).then(_refresh).then(() => {
      if (!_open || _sessionLocked) return;
      if (!_serverNarrator) setEventMessage({ type: "status", text: "System monitoring is unavailable. Waiting for a fresh check." });
    });
    // Data refresh every 30s
    _pollTimer = setInterval(_refresh, 30_000);
    _freshnessTimer = setInterval(_renderObservationSummary, 1000);
  }

  function onClose() {
    _panelOpen = false;
    _pauseDashboard();
  }

  function _pauseDashboard() {
    _open = false;
    _viewEpoch++;
    _stopDashSSE();
    if (_narratorTransition) { clearTimeout(_narratorTransition); _narratorTransition = null; }
    if (_pollTimer)  { clearInterval(_pollTimer);  _pollTimer  = null; }
    if (_freshnessTimer) { clearInterval(_freshnessTimer); _freshnessTimer = null; }
    if (_cycleTimer) { clearInterval(_cycleTimer); _cycleTimer = null; }
    if (_typeTimer)  { clearInterval(_typeTimer);  _typeTimer  = null; }
    if (_tipTimer)   { clearInterval(_tipTimer);   _tipTimer   = null; }
  }

  // ── v1.3: Event-driven narrator override ────────────────────────────────
  // Called by EventInterpreter via window.TLIDash2.setEventMessage(msg)
  // msg: { type: "status"|"alert"|"action_prompt"|"confirmation", text: string }
  let _serverNarrator = null;
  let _narratorTransition = null;
  function setEventMessage(msg) {
    if (!msg || !msg.text || _sessionLocked) return;
    if (_serverNarrator?.timestamp && msg.timestamp && msg.timestamp < _serverNarrator.timestamp) return;
    const unchanged = _serverNarrator?.text === msg.text && _serverNarrator?.type === msg.type && _serverNarrator?.severity === msg.severity;
    _serverNarrator = msg;
    if (!_open || unchanged) return;
    if (_narratorTransition) clearTimeout(_narratorTransition);
    const typeMap = {
      status: { type: "GUIDANCE", severity: "info" },
      alert: { type: "AWARENESS", severity: "warning" },
      action_prompt: { type: "ACTION_PROMPT", severity: "info" },
      confirmation: { type: "CONFIRMATION", severity: "info" },
    };
    const mapped = typeMap[msg.type] || typeMap.status;
    const severity = msg.severity === 'warn' ? 'warning' : ['info','warning','critical'].includes(msg.severity) ? msg.severity : mapped.severity;
    const stmt = _el("nd-statement");
    if (stmt) { stmt.style.opacity = "0"; stmt.style.transition = "opacity 0.35s"; }
    _narratorTransition = setTimeout(function () {
      if (!_open) return;
      _typeText(msg.text);
      _setNarratorCard({ text: msg.text, type: mapped.type, severity });
      if (stmt) stmt.style.opacity = "1";
      const narratorEl = _el("nd-narrator");
      if (narratorEl) narratorEl.dataset.narratorType = msg.type || "status";
    }, 380);
  }

  window.addEventListener('tli-system-observation', () => { if (_open) _renderObservationSummary(); });
  window.addEventListener('tli-ai-source-changed', () => { if (_open) _renderObservationSummary(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _pauseDashboard();
    else if (_panelOpen) onOpen();
  });
  window.addEventListener('beforeunload', _pauseDashboard);
  window.addEventListener('tli-session-locked', () => {
    _sessionLocked = true; onClose(); _lastData = null; _serverNarrator = null; _seenFeedIds.clear();
    for (const id of ['nd-feed', 'nd-mesh-nodes', 'nd-statement-text', 'nd-meta-line', 'nd-actions', 'nd-suggestions', 'nd-quickread']) _el(id)?.replaceChildren();
    for (const name of ['storage', 'smart', 'ai']) _setVital(name, '—', 'Unlock TLI to check');
    _setVital('node', 'Not confirmed', 'Unlock TLI to check');
    const meter = _el('ndv-storage-meter'); if (meter) meter.hidden = true;
    const metric = _el('ndv-node-metrics'); if (metric) metric.textContent = '';
  });
  window.addEventListener('tli-session-unlocked', () => {
    _sessionLocked = false;
    const panel = _el('panel-dashboard2');
    if (panel && !panel.hidden && !panel.classList.contains('hidden')) onOpen();
  });
  return { onOpen, onClose, setEventMessage, refresh: _refresh, openStorage: _openStorage };
})();

// AbortController + debounce
let inFlightController = null;
let lastSendTs = 0;

function setupChatHistoryDrawer() { /* stub — original lost in recovery */ }

async function handleShellyIntent(intent, thinkingBubble, rawUserText) {
  try {
        // 🧷 Ambiguity handling (NEVER toggle if unclear)
    if (intent.action === "ambiguous") {
      const actionWord =
        intent.desiredAction === "on" ? "turn ON" :
        intent.desiredAction === "off" ? "turn OFF" :
        intent.desiredAction === "toggle" ? "TOGGLE" :
        "check status of";

      const lines = (intent.candidates || []).slice(0, 8).map((d, i) => {
        const label = (d.name || "").trim() || d.ip;
        return `${i + 1}) ${label} (${d.ip})`;
      });

      thinkingBubble.textContent =
        `I found multiple Shelly devices. Which one should I ${actionWord}?\n\n` +
        lines.join("\n") +
        `\n\nReply with the number (e.g. "2") or the exact device name.`;

      thinkingBubble.classList.remove("chat-bubble-thinking");
      return;
    }

// 🔹 STATUS path – do NOT toggle the plug
if (intent.action === "status") {
  const ip = (intent.ip || "").trim();
  if (!ip) {
    thinkingBubble.textContent = "I couldn't determine which Shelly device you meant.";
    thinkingBubble.classList.remove("chat-bubble-thinking");
    return;
  }

  thinkingBubble.textContent = `Checking status of ${intent.name}…`;
  thinkingBubble.classList.remove("chat-bubble-thinking");

  const s = await fetchShellySnapshot(ip);

  const parts = [];
  if (typeof s.isOn === "boolean") parts.push(s.isOn ? "ON" : "OFF");
  if (typeof s.power === "number") parts.push(`${s.power.toFixed(1)} W`);
  if (typeof s.voltage === "number") parts.push(`${s.voltage.toFixed(1)} V`);
  if (typeof s.current === "number") parts.push(`${s.current.toFixed(3)} A`);
  if (typeof s.temperature === "number") parts.push(`${s.temperature.toFixed(1)} °C`);

  const summary = parts.length ? parts.join(" · ") : "status loaded";
  const stamp = s.at ? new Date(s.at).toLocaleTimeString() : "just now";

  thinkingBubble.textContent =
    `${intent.name} status: ${summary} (updated ${stamp}).`;

  debugLog(
    "info",
    `[Shelly] Chat status → ${intent.name} @ ${ip} :: ${summary}`
  );
  return;
}

    // 🔹 ON / OFF path – real control (target the matched device)
    const ip = (intent.ip || "").trim();
    if (ip && typeof setSelectedShellyIp === "function") {
      setSelectedShellyIp(ip);
    }

    await sendShellyAction(intent.action, ip);

    const verb = intent.action === "on" ? "ON" : "OFF";
    thinkingBubble.textContent = `Turning ${intent.name} ${verb}.`;
    thinkingBubble.classList.remove("chat-bubble-thinking");

    debugLog(
      "info",
      `[Shelly] Chat fast-path → ${intent.name} ${verb} (from: "${rawUserText}")`
    );
  } catch (err) {
    console.error("[Shelly] handleShellyIntent failed:", err);
    if (thinkingBubble) {
      thinkingBubble.textContent =
        "Shelly control failed: " + (err?.message || "unknown error");
      thinkingBubble.classList.remove("chat-bubble-thinking");
    }
    showToast("Shelly control failed.", "error");
  }
}


function buildSystemInstruction({ teachingMode, mode } = {}) {
  let base = "You are TLI, a helpful and concise home network assistant running fully offline on a local LAN. You have access to smart home devices, files, scripts, and system tools.";
  if (mode === "creative") base += " Be imaginative and explore ideas freely.";
  if (mode === "precise")  base += " Be highly precise, technical, and thorough.";
  if (teachingMode)        base += " The user has Teaching Mode enabled — explain your reasoning step by step, as if teaching a capable adult.";
  return base;
}

function buildContextWrappedMessage({ latestUserMessage, teachingMode, mode } = {}) {
  if (teachingMode) {
    return `${latestUserMessage}\n\n[Teaching Mode: please explain your reasoning step by step.]`;
  }
  return latestUserMessage;
}

async function sendChat() {
  const input   = $("chat-input");
  const sendBtn = $("chat-send-btn");
  const abortBtn = $("abort-chat-btn");
  if (!input || !sendBtn || !abortBtn || sendBtn.disabled) return;
  if (window.TLIConversationLoad?.loading) { showToast('Wait for the saved conversation to finish loading before sending.', 'info'); return; }

  const requestImageB64 = _chatImageB64, requestImageMime = _chatImageMime;
  const requestImageVersion = _chatImageReadVersion;
  let requestContext = window.TLIIntelligence?.getContext() || {};
  const intelligenceTicket = window.TLIIntelligence?.capture?.();
  const lanTicket = window.TLILanInference?.capture?.();
  let lanInference = null;
  try {
    if (requestImageB64) requestContext = window.TLIScreenshots?.requestContext(requestContext) || requestContext;
    requestContext = window.TLINotebook?.requestContext(requestContext, { image: !!requestImageB64, text: window.__tliInjectedUserMessage || input.value || '' }) || requestContext;
    requestContext = window.TLIDocuments?.requestContext(requestContext, { image: !!requestImageB64, text: window.__tliInjectedUserMessage || input.value || '' }) || requestContext;
    requestContext = window.TLICaseContext?.requestContext(requestContext, { image: !!requestImageB64, text: window.__tliInjectedUserMessage || input.value || '' }) || requestContext;
    requestContext = window.TLIMemory?.requestContext(requestContext) || requestContext;
  }
  catch (e) { showToast(e.message, "error"); return; }
  let rawText = (input.value || "").trim();
  // Allow send with no text if an image is attached — default prompt
  if (_chatImageReading) { showToast("Wait for the image to finish attaching.", "info"); return; }
  if (!rawText && requestImageB64) rawText = window.TLIScreenshots?.defaultPrompt() || "What's in this image?";
  if (!rawText) return;
  const checkingAIStatus = !requestImageB64 && !requestContext.note_refs?.length && !requestContext.documents?.length && !requestContext.case_ref && !requestContext.diagnostic_id && !requestContext.target_id && !!window.TLIChatWorkspace?.isStatusQuestion(rawText);
  input.value = "";

  // Capture image preview URL immediately — before any async code can touch state
  const _previewDataUrl = requestImageB64
    ? `data:${requestImageMime || "image/jpeg"};base64,${requestImageB64}`
    : null;

// =====================================================
// 🔎 Seamless Suggested Search (Phase 2: Hard Gate)
// - Uses searXNG for retrieval only (no cloud LLM).
// - NEVER runs silently: strong triggers show a banner and wait for user choice.
// =====================================================

// One-shot injected message (used when user clicks "Search + Answer")
if (window.__tliInjectedUserMessage) {
  rawText = String(window.__tliInjectedUserMessage || "").trim();
  window.__tliInjectedUserMessage = null;
  try { input.value = rawText; } catch {}
}

try {
  lanInference = window.TLILanInference?.request(lanTicket, requestContext, { image: !!requestImageB64, message: rawText }) || null;
} catch (error) { input.value = rawText; showToast(error.message, 'error'); return; }

// Gate unless explicitly bypassed (e.g., user clicked "Answer Offline" or "Search + Answer")
const __bypassGate = !!window.__tliSearchGateBypassOnce;
window.__tliSearchGateBypassOnce = false;

try {
  if (!requestImageB64 && !requestContext.note_refs?.length && !requestContext.documents?.length && !requestContext.case_ref && !__bypassGate && tliSearchIsEnabled() && tliShouldGateForSearch(rawText)) {
    // Show banner and wait. Do NOT send to model yet.
    tliShowSearchBannerFor(rawText);
    return;
  }
} catch (e) {
  // If gating fails for any reason, fail open (offline) to preserve chat usability.
}

sendBtn.disabled = true;
const responseIndicator = window.TLIChatWorkspace?.beginResponse?.();
const requestController = new AbortController();
inFlightController = requestController;
abortBtn.disabled = false;
let responseOutcome = null, responseBubble = null, requestStillCurrent = () => false;
// Managed runs receive an explicit cancellation request. Previously completed
// actions remain recorded; the legacy transport can only stop its browser wait.
const waitForResponse = promise => new Promise((resolve, reject) => {
  const stopped = () => { const error = new Error('You stopped waiting for this response.'); error.name = 'AbortError'; reject(error); };
  if (requestController.signal.aborted) { stopped(); return; }
  requestController.signal.addEventListener('abort', stopped, {once:true});
  Promise.resolve(promise).then(resolve, reject).finally(() => requestController.signal.removeEventListener('abort', stopped));
});
try {
window.TLIConversationLoad?.invalidate?.();
const isCurrent = () => (!window.TLIMemory || window.TLIMemory.isCurrent(requestContext)) &&
  (!window.TLICaseContext || window.TLICaseContext.isCurrent(requestContext)) &&
  (!window.TLILanInference || window.TLILanInference.isCurrent(lanTicket)) &&
  window.TLIIntelligence?.isCurrent?.(intelligenceTicket) !== false;
requestStillCurrent = isCurrent;
let partialReply = '';
let requestWasStopped = false;
let replyMetadata = null;
// Instant render: user bubble + thinking bubble (before async AI route resolution)
const userBubble = appendMessage("user", rawText, _previewDataUrl ? { imageDataUrl: _previewDataUrl } : {});
const thinkingBubble = appendMessage("ai", "TLI is working…", { thinking: true });
responseBubble = thinkingBubble;
function preserveInterruptedReply(err) {
    if (!isCurrent()) return;
    if (!input.value && (!requestImageB64 || requestImageVersion === _chatImageReadVersion)) input.value = rawText;
    const stopped = requestWasStopped || err.name === "AbortError" || requestController.signal.aborted;
    responseOutcome = stopped ? "stopped" : "interrupted";
    const actionUncertain = replyMetadata?.handled_by === 'intent_engine' || replyMetadata?.provider === 'tli-action' ||
      /^(?:turn|switch|toggle|run|clear|clean|delete|move|restart|shutdown|shut down)\b/i.test(rawText);
    const review = () => {
      if (!isCurrent() || sendBtn.disabled) return;
      if (input.value.trim() && input.value !== rawText) {
        showToast('Your newer draft is still in the composer. Finish or clear it before reviewing this question.', 'info');
        input.focus?.(); return;
      }
      input.value = rawText; input.focus?.();
      showToast('Review the question and current context, then choose Send.' + (actionUncertain ? ' The earlier action may already have completed.' : ''), 'info');
    };
    const hint = err.message || 'The connection ended before a complete response arrived.';
    if (window.TLIChatWorkspace?.showInterrupted) {
      window.TLIChatWorkspace.showInterrupted(thinkingBubble, { partial: partialReply, message: hint, stopped, actionUncertain, review });
    } else {
      thinkingBubble.textContent = (partialReply ? partialReply + '\n\nIncomplete response. ' : '') +
        (stopped ? 'Stopped waiting for the response. ' : 'Request failed: ' + hint + ' ') +
        'No automatic retry was sent. Check any action result before trying again.';
      thinkingBubble.classList.remove('chat-bubble-thinking');
    }
    if (stopped) {
      debugLog("warn", "POST /chat aborted by user.");
    } else {
      window.TLIChatWorkspace?.markFailure?.(thinkingBubble);
      debugLog("error", "POST /chat error: " + hint);
    }
}


// 🧭 Decide where intelligence comes from (Local > LAN > None)
let __aiRoute = null;
try { if (!checkingAIStatus && !lanInference) __aiRoute = await waitForResponse(resolveIntelligenceRoute({ forceRefresh: false })); } catch (e) { if (requestController.signal.aborted) { preserveInterruptedReply(e); return; } }
if (!isCurrent()) return;

// A failed LAN request is uncertain. Keep it for deliberate review rather than sending it again to another provider.
if (requestContext.use_conversation_history === false && __aiRoute?.source === IntelligenceSource.LAN_LLM && !requestImageB64 && !requestContext.note_refs?.length && !requestContext.documents?.length && !requestContext.case_ref) {
  preserveInterruptedReply(new Error('This LAN AI route cannot confirm that earlier conversation is excluded. Select a provider on this TLI host before retrying. Nothing was sent.'));
  return;
}
if (requestContext.use_saved_memory !== false && !requestImageB64 && !requestContext.note_refs?.length && !requestContext.documents?.length && !requestContext.case_ref && !requestContext.diagnostic_id && !requestContext.target_id && !window.TLIChatWorkspace?.isStatusQuestion(rawText) && !/^(?:turn|switch|toggle|check|run .*diagnostics)\b/i.test(rawText) && __aiRoute && __aiRoute.source === IntelligenceSource.LAN_LLM && __aiRoute.node) {
  preserveInterruptedReply(new Error('Automatic LAN inference has been retired. Choose a reviewed computer and model in the chat AI control. Nothing was sent.'));
  return;
}

// If no providers, keep the header truthful (local /chat may still error, but UX stays clear)
if (__aiRoute && __aiRoute.source === IntelligenceSource.NONE) {
  setAIRoutePill(IntelligenceSource.NONE, __aiRoute.reason);
}

  // --- Vault tag parsing: [vault:secret_key] ---
  const vaultTagRe = /\[vault:([^\]]+)\]/gi;
  const secretKeys = [];
  let cleanedText = rawText;
  let m;
  while ((m = vaultTagRe.exec(rawText)) !== null) {
    const key = (m[1] || "").trim();
    if (key && !secretKeys.includes(key)) {
      secretKeys.push(key);
    }
  }
  if (secretKeys.length) {
    cleanedText = rawText.replace(vaultTagRe, "").trim();
  }
  const text = cleanedText;
  
  // --- end vault parsing ---

  const now = Date.now();
  lastSendTs = now;

  const storedSettings = readSettings() || {};
  const brain = storedSettings.defaultBrain || "auto";
  // Notebook turns keep the chosen provider; the owner-aware SSE note handler
  // serves bundled inference while LM Studio uses the existing /chat handler.
  const notebookUsesLMStudio = !requestImageB64 &&
    (/^(?:lmstudio|lm_studio|lm-studio|lms|openai)$/i.test(brain) ||
      (brain === "auto" && window.__tliActiveAISource === "lmstudio"));
  const mode          = $("mode-select").value || "default";
  const teachingMode  = isTeachingMode();
  const temperature   = parseFloat($("temperature-input").value || "0.7");
  const maxTokens     = parseInt($("max-tokens-input").value || "768", 10);

  // Conversation memory (store cleaned text for the model)
  // (user message already rendered instantly above)
  // Keep model context consistent
  // NOTE: we store rawText in chat history to preserve user intent exactly.
  if (thinkingBubble) {
    thinkingBubble.textContent = checkingAIStatus ? "Checking AI status…" : "Preparing your reply…";
  }

  // lock buttons + show generic “thinking” status
  sendBtn.disabled = true;
  abortBtn.disabled = false;
  // Response progress does not establish provider health; the response indicator owns this state.

  // Device commands use the backend's shared resolver and clarification path.
  // 🔹 Normal LLM path (unchanged)
  debugLog(
    "info",
    `POST /chat brain=${brain} mode=${mode} teaching=${teachingMode} temp=${temperature} max=${maxTokens} secrets=[${secretKeys.join(
      ", "
    )}]`
  );

  try {

    // Old backends ignore unknown request fields and could route the question
    // as an ordinary command. Verify this read-only protocol before any POST.
    if (requestContext.documents?.length) await waitForResponse(window.TLIDocuments.ensureAvailable(requestContext, requestController.signal));
    if (requestContext.case_ref) await waitForResponse(window.TLICaseContext.ensureAvailable(requestContext, requestController.signal));
    if (window.TLIMemory) await waitForResponse(window.TLIMemory.ensureAvailable(requestContext, requestController.signal));
    // Choose endpoint:
// - If Bundled AI is healthy, use /api/ai/chat (fast, offline, no LM Studio).
// - Otherwise fall back to legacy /chat routing (LM Studio / Mesh).
let useBundled = false;
try {
  if (!checkingAIStatus && !lanInference) {
    const st = await waitForResponse(tliFetchBundledStatus());
    useBundled = !!(st && st.ok === true);
    AIStatus.local.provider = useBundled ? "bundled" : (AIStatus.local.provider || "lmstudio");
    AIStatus.local.available = useBundled;
  }
} catch (e) { if (requestController.signal.aborted) throw e; }

if (checkingAIStatus) useBundled = true;

if (requestImageB64 || requestContext.note_refs?.length || requestContext.documents?.length || requestContext.case_ref || /^(?:turn|switch|toggle|check|run .*diagnostics)\b/i.test(text)) useBundled = true;
if (notebookUsesLMStudio) useBundled = false;
// A reviewed LAN model always uses the primary host's authenticated chat route.
if (lanInference) useBundled = true;

if (!isCurrent() || (requestContext.documents?.length && !window.TLIDocuments?.isCurrent(requestContext))) return;
const endpoint = useBundled ? "/api/ai/chat" : "/chat";

// ✅ Bundled AI: use SSE streaming for instant partial output
if (useBundled) {
  // Keep the attachment available if the request fails.
  const sentImageB64  = requestImageB64;
  const sentImageMime = requestImageMime;

  let acc = "";
  let screenshotMeta = null;
  // Keep the waiting message visible until the first response text arrives.

  try {
  await waitForResponse(tliBundledChatStream({
      ...requestContext,
      ...(lanInference ? { lan_inference: lanInference } : {}),
      signal: requestController.signal,
      message: text,
      raw_input: text,
      session_id: currentConversationId || null,
      active_panel: _currentPanelId || null,
      max_tokens: maxTokens,
      temperature: temperature,
      image_b64: sentImageB64 || null,
      image_mime: sentImageMime || null,
      onMeta: (m) => {
        if (!isCurrent() || requestController.signal.aborted) return;
        if (requestContext.documents?.length && !window.TLIDocuments?.isCurrent(requestContext)) return;
        screenshotMeta = { ...(screenshotMeta || {}), ...m };
        replyMetadata = screenshotMeta;
        window.TLIIntelligence?.showMeta?.(m);
        try { currentConversationId = m.session_id || currentConversationId; } catch {}
        window.currentConversationId = currentConversationId;

      },
      onDelta: (chunk) => {
        if (!isCurrent() || requestController.signal.aborted) return;
        if (requestContext.documents?.length && !window.TLIDocuments?.isCurrent(requestContext)) return;
        if (!chunk) return;
        if (!acc) responseIndicator?.responding();
        acc += chunk;
        partialReply = acc;
        try {
          if (thinkingBubble) {
            thinkingBubble.classList.remove("chat-bubble-thinking");
            thinkingBubble.innerHTML = renderAssistantHTML(acc); _attachSpeakBtn(thinkingBubble, acc);
          }
        } catch {}
      },
    }));
  
    // finalize
} catch (e) {
  requestWasStopped = e.name === 'AbortError' || requestController.signal.aborted;
  throw e;
}
if (!isCurrent() || (requestContext.documents?.length && !window.TLIDocuments?.isCurrent(requestContext))) return;
if (!acc.trim()) throw new Error("The provider returned no usable reply.");
responseOutcome = "completed";
// A routing announcement is not readiness. Confirm the mesh response only after completion.
        if (acc.trim() && screenshotMeta?.handled_by === "mesh" && screenshotMeta.mesh_node) {
          try {
            const peerName = screenshotMeta.mesh_node.name || screenshotMeta.mesh_node.ip || "Mesh";
            const preset = screenshotMeta.mesh_node.preset ? ` (${screenshotMeta.mesh_node.preset})` : "";
            const setPill = window.__tliSetAIPill;
            if (typeof setPill === "function") {
              setPill(`Mesh AI · ${peerName}`, "ok", `AI routed to ${peerName}${preset} via mesh`);
            } else {
              const t = document.getElementById("ai-source-text");
              if (t) t.textContent = `Mesh AI · ${peerName}`;
            }
          } catch {}
        }
if (sentImageB64 && requestImageVersion === _chatImageReadVersion) _clearChatImage();
window.TLIScreenshots?.annotateReply(thinkingBubble, screenshotMeta);
window.TLINotebook?.annotateReply(thinkingBubble, screenshotMeta);
window.TLINotebook?.sent(requestContext);
window.TLIDocuments?.sent(requestContext, screenshotMeta);
window.TLIDocuments?.annotateReply(thinkingBubble, screenshotMeta);
window.TLICaseContext?.sent(requestContext, screenshotMeta);
window.TLICaseContext?.decorateReply(thinkingBubble, screenshotMeta);
window.TLIMemory?.decorateReply(thinkingBubble, screenshotMeta || {});
window.TLILanInference?.annotateReply(thinkingBubble, screenshotMeta);
window.TLIMemory?.sent?.(requestContext);
window.TLIMemory?.decorateMessage(userBubble, { source_ref: screenshotMeta?.user_source_ref });

// finalize
  try {
    if (thinkingBubble) thinkingBubble.classList.remove("chat-bubble-thinking");
  } catch {}
  try { chatHistoryAdd("user", rawText); chatHistoryAdd("assistant", acc); } catch {}
  try { saveConversation(rawText, acc, currentConversationId); addPreviousPrompt(rawText); } catch {}
  try { if (acc) tliSpeak(acc); } catch {}
  return;
}


const payload = {
        ...requestContext,
        device_id: currentDeviceId || "dev-browser",
        message: text,
        brain: notebookUsesLMStudio ? "lmstudio" : brain,
        mode,
        teaching_mode: teachingMode,
        temperature,
        max_tokens: maxTokens,
        session_id: (useBundled ? (currentConversationId || null) : null),
        conversation_id: currentConversationId || null,
        include_vault_secrets: secretKeys.length > 0,         // vault hook
        secret_keys: secretKeys.length ? secretKeys : null    // vault hook
      };
    const managed = window.TLIWorkspace ? await window.TLIWorkspace.chat(payload, { signal: requestController.signal, chatPath: '/chat' }) : null;
    const res = managed ? new Response(JSON.stringify(managed), { status: 200, headers: { 'Content-Type': 'application/json' } }) : await waitForResponse(fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: requestController.signal, body: JSON.stringify(payload)
    }));
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const j = await res.json();
        detail = j.detail ? ("HTTP " + res.status + ": " + j.detail) : detail;
      } catch {}
      debugLog("error", "POST /chat failed: " + detail);
      throw new Error(detail);
    }
    const data  = await waitForResponse(res.json());
if (!isCurrent() || (requestContext.documents?.length && !window.TLIDocuments?.isCurrent(requestContext))) return;
let reply = data.reply || data.answer;
if (typeof reply !== 'string' || !reply.trim()) throw new Error('The provider returned no usable reply.');

// 🔹 Apply response formatting based on Mode dropdown (default / concise / step / dev)
reply = formatModelOutput(reply, mode);
responseIndicator?.responding(); responseOutcome = "completed";


// Bundled AI uses session_id instead of conversation_id
if (!data.conversation_id && data.session_id) {
  try { currentConversationId = data.session_id; } catch {}
}

    if (data.conversation_id) {

  const prevId = currentConversationId || CHAT_HISTORY_DRAFT_ID;
  currentConversationId = data.conversation_id;

  // Migrate draft history → real conversation_id key (best-effort)
  try {
    if (prevId === CHAT_HISTORY_DRAFT_ID) {
      const draft = loadChatHistoryFromStorage(CHAT_HISTORY_DRAFT_ID);
      if (draft && draft.length) {
        chatHistory = draft;
        saveChatHistoryToStorage(currentConversationId);
      }
      clearChatHistoryStorage(CHAT_HISTORY_DRAFT_ID);
    }
  } catch {}
}

window.currentConversationId = currentConversationId;
thinkingBubble.textContent = reply;
    thinkingBubble.classList.remove("chat-bubble-thinking");
    window.TLILanInference?.annotateReply(thinkingBubble, data);
    window.TLINotebook?.annotateReply(thinkingBubble, data);
    window.TLINotebook?.sent(requestContext);
    window.TLIDocuments?.sent(requestContext, data);
    window.TLIDocuments?.annotateReply(thinkingBubble, data);
    window.TLICaseContext?.sent(requestContext, data);
    window.TLICaseContext?.decorateReply(thinkingBubble, data);
    window.TLIMemory?.decorateReply(thinkingBubble, data);
    window.TLIMemory?.sent?.(requestContext);
    window.TLIMemory?.decorateMessage(userBubble, { source_ref: data.user_source_ref });
    try { chatHistoryAdd("user", rawText); chatHistoryAdd("assistant", reply); } catch {}

    try { saveConversation(text, reply, currentConversationId); } catch {}
    try { addPreviousPrompt(text); } catch {}

    // The reply identifies its provider; independent health checks own runtime
    // readiness. Do not launch a health-generation request after an answer.

    debugLog(
      "info",
      "POST /chat OK, conversation_id=" +
        (data.conversation_id || "none") +
        ", reply_length=" +
        reply.length
    );
  } catch (err) {
    preserveInterruptedReply(err);
  } finally {
    if (isCurrent()) {
      sendBtn.disabled = false;
      abortBtn.disabled = true;
      if (inFlightController === requestController) inFlightController = null;
    }
  }
} finally {
  if (requestStillCurrent()) {
    sendBtn.disabled = false; abortBtn.disabled = true;
    if (inFlightController === requestController) inFlightController = null;
  }
  responseIndicator?.finish({ outcome: requestStillCurrent() ? responseOutcome : null, bubble: responseBubble });
}
}
// =====================================================
// Shelly Chat Helpers (NEW)
// =====================================================

// Returns the saved nickname for the Shelly device
function getShellyFriendlyName() {
  // Match the actual input in index.html: id="shelly-name-input"
  const el = $("shelly-name-input");
  if (!el) return null;

  const v = (el.value || "").trim();
  return v.length ? v : null;
}

// Detect ON / OFF / STATUS intent in chat text
// =====================================================
// Shelly Chat Helpers (Multi-device + ambiguity-safe)
// =====================================================

function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\-_]+/g, " ")
    .trim();
}

function getKnownShellyDevices() {
  // Merge:
  // 1) multi-device registry (shellyDevices)
  // 2) the currently configured IP + name inputs (so a brand new device still matches)
  const list = [];

  try {
    Object.values(shellyDevices || {}).forEach((d) => {
      if (!d || !d.ip) return;
      list.push({ ip: String(d.ip).trim(), name: (d.name || "").trim() });
    });
  } catch {}

  const configuredIp = (readShellyIpConfigured() || "").trim();
  const configuredName = (readShellyName() || "").trim();

  if (configuredIp) {
    const already = list.some((x) => x.ip === configuredIp);
    if (!already) list.push({ ip: configuredIp, name: configuredName });
  }

  // De-dupe by IP
  const seen = new Set();
  return list.filter((d) => {
    if (!d.ip || seen.has(d.ip)) return false;
    seen.add(d.ip);
    return true;
  });
}

function findShellyCandidatesFromText(text) {
  const lower = String(text || "").toLowerCase();
  const devices = getKnownShellyDevices();

  // 1) Explicit IP match wins
  const ipMatch = lower.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  if (ipMatch) {
    const ip = ipMatch[1];
    const hit = devices.find((d) => d.ip === ip);
    if (hit) return [hit];
    // If they typed an IP not in registry, still allow it as a direct target
    return [{ ip, name: "" }];
  }

  // 2) Name-based matching (exact, then partial)
  const tNorm = _norm(text);
  const named = devices.filter((d) => _norm(d.name));

  // Exact name match
  const exact = named.filter((d) => _norm(d.name) && tNorm.includes(_norm(d.name)));
  if (exact.length) return exact;

  // Partial token match (e.g., "kitchen" matches "Kitchen Plug")
  const tokens = _norm(text).split(" ").filter(Boolean);
  const partial = named.filter((d) => {
    const dn = _norm(d.name);
    return tokens.some((tok) => tok.length >= 3 && dn.includes(tok));
  });
  if (partial.length) return partial;

  // 3) If they said "shelly one/two/3", map to sorted device list
  const ordinal =
    lower.match(/\bshelly\s*(?:#\s*)?(\d+)\b/) ||
    lower.match(/\bshelly\s*(one|two|three|four|five)\b/);

  if (ordinal) {
    const word = ordinal[1];
    const map = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const n = map[word] || parseInt(word, 10);
    if (n && devices.length) {
      const sorted = devices.slice().sort((a, b) => (a.name || a.ip).localeCompare(b.name || b.ip));
      const pick = sorted[n - 1];
      if (pick) return [pick];
    }
  }

  // 4) If they only said "shelly" with no other clue:
  // - if exactly 1 device exists, it’s safe
  // - otherwise ambiguous
  const mentionsShelly = lower.includes("shelly");
  if (mentionsShelly && devices.length === 1) return [devices[0]];
  if (mentionsShelly && devices.length > 1) return devices;

  return [];
}

async function fetchShellySnapshot(ip) {
  const res = await fetch("/shelly/status?ip=" + encodeURIComponent(ip));
  if (!res.ok) throw new Error("HTTP " + res.status);
  const payload = await res.json();

  // Normalize exactly like your UI does in renderShellyStatus()
  const raw = payload && payload.raw ? payload.raw : null;
  const sw = raw && raw["switch:0"] ? raw["switch:0"] : null;

  const isOn = sw && typeof sw.output === "boolean" ? sw.output : null;
  const power = sw && typeof sw.apower === "number" ? sw.apower : null;
  const voltage = sw && typeof sw.voltage === "number" ? sw.voltage : null;
  const current = sw && typeof sw.current === "number" ? sw.current : null;
  const temperature =
    raw && raw.temperature && typeof raw.temperature.tC === "number" ? raw.temperature.tC : null;

  return {
    ip,
    isOn,
    power,
    voltage,
    current,
    temperature,
    at: new Date().toISOString(),
    raw: payload,
  };
}

// Detect ON / OFF / STATUS intent in chat text (multi-device + ambiguity-safe)
function detectShellyIntent(text) {
  if (!text) return null;

  const lower = text.toLowerCase();

  // Quick reject ONLY if there is:
  // - no "shelly" mention
  // - no direct IP
  // - AND no known device name match
  const hasIp = /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(lower);
  const mentionsShelly = lower.includes("shelly");

  // 🔑 IMPORTANT: allow name-based control like "turn off phone charger"
  const candidatesEarly = findShellyCandidatesFromText(text);
  if (!mentionsShelly && !hasIp && !candidatesEarly.length) return null;


  const hasStatusWord =
    /\bstatus\b/.test(lower) ||
    /\bstate\b/.test(lower) ||
    /\bcheck\b/.test(lower) ||
    /\bwhat('?s| is)\s+the\s+status\b/.test(lower) ||
    /\bis\b.*\bon\b/.test(lower) ||
    /\bis\b.*\boff\b/.test(lower);

  const hasControlVerb =
    /\bturn\b/.test(lower) ||
    /\bswitch\b/.test(lower) ||
    /\bpower\b/.test(lower) ||
    /\btoggle\b/.test(lower);

  const hasOn = /\bon\b/.test(lower);
  const hasOff = /\boff\b/.test(lower);

  // Decide desired action first
  let desiredAction = null;

  if (!hasControlVerb && (hasStatusWord || hasOn || hasOff)) {
    desiredAction = "status";
  } else {
    const turnsOn = hasControlVerb && hasOn;
    const turnsOff = hasControlVerb && hasOff;

    // If both appear ("turn it off then back on") → let LLM handle it
    if (turnsOn && turnsOff) return null;

    if (turnsOn) desiredAction = "on";
    if (turnsOff) desiredAction = "off";
    if (!desiredAction && /\btoggle\b/.test(lower)) desiredAction = "toggle";
  }

  if (!desiredAction) return null;

    const candidates = candidatesEarly;


  // No candidates: if they said Shelly but nothing is configured, don't hijack the chat
  if (!candidates.length) return null;

  // Ambiguity case: multiple possible targets for a control action
  if (candidates.length > 1) {
    return {
      action: "ambiguous",
      desiredAction,
      candidates,
    };
  }

  const target = candidates[0];
  const friendly =
    (target.name || "").trim() ||
    ("Shelly " + String(target.ip || "").trim());

  return {
    action: desiredAction,
    ip: target.ip,
    name: friendly,
  };
}


// Check if AI is available and show/hide the no-AI nudge banner
async function _refreshNoAiBanner() {
  const banner = $("tli-no-ai-banner");
  if (!banner) return;
  try {
    const r = await fetch("/api/ai/model/info", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) { banner.classList.add("hidden"); return; }
    const info = await r.json();
    if (info.exists !== false || info.healthy === true) { banner.classList.add("hidden"); return; }
    // No bundled model — check if LM Studio is reachable before showing the banner
    try {
      const lr = await fetch("/health/llm", { signal: AbortSignal.timeout(2000) });
      const ld = lr.ok ? await lr.json() : {};
      if (ld.healthy) { banner.classList.add("hidden"); return; }
    } catch {}
    // No local AI — check if a mesh peer is serving AI
    try {
      const mr = await fetch("/api/ai/mesh/status", { signal: AbortSignal.timeout(3000) });
      if (mr.ok) {
        const md = await mr.json();
        if (md.available && md.peer) {
          // Mesh AI available — update banner to inform instead of prompt download
          const titleEl = banner.querySelector(".tli-no-ai-banner-title");
          const subEl   = banner.querySelector(".tli-no-ai-banner-sub");
          const btnEl   = $("tli-no-ai-download-btn");
          const peerName = md.peer.name || "a LAN node";
          if (titleEl) titleEl.textContent = "AI available via LAN";
          if (subEl)   subEl.textContent   = `${peerName} reports AI availability. Review your AI source in Settings to choose where chat should run.`;
          if (btnEl)   { btnEl.textContent = "Open AI Settings"; btnEl.dataset.tliMeshMode = "1"; }
          banner.classList.remove("hidden");
          return;
        }
      }
    } catch {}
    // No AI anywhere — show the download prompt
    const titleEl = banner.querySelector(".tli-no-ai-banner-title");
    const subEl   = banner.querySelector(".tli-no-ai-banner-sub");
    const btnEl   = $("tli-no-ai-download-btn");
    if (titleEl) titleEl.textContent = "Selected model files are unavailable";
    if (subEl)   subEl.textContent   = "Open the model library to check installed models and compatibility, or choose another AI source in Settings.";
    if (btnEl)   { btnEl.textContent = "Open model library"; delete btnEl.dataset.tliMeshMode; }
    banner.classList.remove("hidden");
  } catch {
    banner.classList.add("hidden");
  }
}

// ── Image attach state ──────────────────────────────────────────────────
let _chatImageB64 = null;
let _chatImageMime = null;
let _chatImageReadVersion = 0;
let _chatImageReading = false;
let _chatImageReader = null;
let _chatImageReadTimer = null;
let _chatImageDecoder = null;
let _chatImagePickerTicket = null;

function _stopChatImageRead() {
  if (_chatImageReadTimer != null) clearTimeout(_chatImageReadTimer);
  _chatImageReadTimer = null;
  const reader = _chatImageReader;
  _chatImageReader = null;
  if (reader?.readyState === 1) reader.abort();
  if (_chatImageDecoder) {
    _chatImageDecoder.onload = _chatImageDecoder.onerror = null;
    _chatImageDecoder.src = '';
    _chatImageDecoder = null;
  }
}

function _clearChatImage() {
  _chatImageReadVersion++;
  _chatImagePickerTicket = null;
  _stopChatImageRead();
  _chatImageReading = false;
  _chatImageB64 = null;
  _chatImageMime = null;
  const preview = $("chat-image-preview");
  const thumb   = $("chat-image-thumb");
  const attachBtn = $("chat-attach-btn");
  if (preview) preview.classList.add("hidden");
  if (thumb)   thumb.src = "";
  if (attachBtn) attachBtn.classList.remove("has-image");
  const fileInput = $("chat-image-input");
  if (fileInput) fileInput.value = "";
  window.TLIScreenshots?.attachmentChanged(null);
}

// A new image replaces the current attachment only after local read/decode.
// The server independently validates and sanitizes it before any provider call.
function _attachChatImage(file) {
  const ticket = window.TLIIntelligence?.capture?.();
  if (window.TLIIntelligence?.isCurrent?.(ticket) === false) return;
  if (!file || !["image/jpeg", "image/png"].includes(file.type) || !file.size || file.size > 6 * 1024 * 1024) {
    window.TLIScreenshots?.attachmentReadFailed?.();
    showToast("Use a JPEG or PNG image up to 6 MB. Your previous attachment is unchanged.", "error");
    return;
  }
  const readVersion = ++_chatImageReadVersion;
  _stopChatImageRead();
  const task = window.TLIScreenshots?.attachmentReadStarted?.();
  _chatImageReading = true;
  const reader = new FileReader();
  _chatImageReader = reader;
  const current = () => {
    if (readVersion !== _chatImageReadVersion) return false;
    if (window.TLIIntelligence?.isCurrent?.(ticket) === false) {
      // A context change can retire this read without replacing the image. It
      // must also release the Send guard, including on the timeout path.
      _chatImageReadVersion++;
      _chatImageReading = false;
      _stopChatImageRead();
      window.TLIScreenshots?.attachmentReadFailed?.();
      return false;
    }
    return true;
  };
  const fail = message => {
    if (!current()) return;
    _chatImageReadVersion++;
    _chatImageReading = false;
    _stopChatImageRead();
    window.TLIScreenshots?.attachmentReadFailed?.();
    showToast(message + " Your previous attachment and question are unchanged.", "error");
  };
  _chatImageReadTimer = setTimeout(() => fail("The image took too long to prepare. Choose it again to try again."), 15000);
  reader.onerror = () => fail("Image could not be read. Choose another image or try again.");
  reader.onload = event => {
    if (!current()) return;
    const dataUrl = event.target.result;
    if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      fail("Image could not be read as JPEG or PNG."); return;
    }
    const image = new Image();
    _chatImageDecoder = image;
    image.onerror = () => fail("This image is damaged or unsupported.");
    image.onload = () => {
      if (!current()) return;
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16000000) {
        fail("Use an image with no more than 16 million pixels. Crop the relevant area first."); return;
      }
      _stopChatImageRead();
      _chatImageReading = false;
      _chatImageB64 = dataUrl.split(',')[1];
      _chatImageMime = file.type;
      const thumb = $("chat-image-thumb"), preview = $("chat-image-preview"), attach = $("chat-attach-btn");
      if (thumb) thumb.src = dataUrl;
      if (preview) preview.classList.remove("hidden");
      if (attach) attach.classList.add("has-image");
      window.TLIScreenshots?.attachmentChanged({name: file.name || 'Pasted screenshot'}, task);
    };
    image.src = dataUrl;
  };
  try { reader.readAsDataURL(file); }
  catch (_) { fail("Image could not be read. Choose another image or try again."); }
}

function setupChat() {
  const sendBtn = $("chat-send-btn");
  const input   = $("chat-input");
  const newBtn  = $("new-chat-btn");
  const abortBtn = $("abort-chat-btn");
  if (!sendBtn || !input || !newBtn || !abortBtn) return;

  // ── Image attach wiring ──────────────────────────────────────────
  const attachBtn    = $("chat-attach-btn");
  const fileInput    = $("chat-image-input");
  const removeBtn    = $("chat-image-remove");

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => { window.TLIScreenshots?.chooseImage(); fileInput.click(); });
    fileInput.addEventListener('click', () => {
      const context = window.TLIIntelligence?.capture?.();
      _chatImagePickerTicket = window.TLIIntelligence?.isCurrent?.(context) !== false
        ? {version: _chatImageReadVersion, context} : null;
    });
    fileInput.addEventListener('cancel', () => { _chatImagePickerTicket = null; });
    fileInput.addEventListener("change", () => {
      const ticket = _chatImagePickerTicket;
      _chatImagePickerTicket = null;
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!ticket || ticket.version !== _chatImageReadVersion || window.TLIIntelligence?.isCurrent?.(ticket.context) === false) {
        fileInput.value = '';
        window.TLIScreenshots?.attachmentReadFailed?.();
        return;
      }
      _attachChatImage(file);
      fileInput.value = ""; // reset so same file can be re-selected
    });
  }
  if (removeBtn) removeBtn.addEventListener("click", _clearChatImage);
  input.addEventListener('paste', event => {
    // Handle only an explicit image paste into this composer. Text paste and
    // clipboard contents elsewhere in TLI remain native browser behavior.
    const images = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!images.length) return;
    if (images.some(item => !['image/jpeg', 'image/png'].includes(item.type)) && event.clipboardData.getData?.('text/plain')) return;
    event.preventDefault();
    if (images.length !== 1) { showToast("Attach one screenshot at a time.", "info"); return; }
    window.TLIScreenshots?.prepareTask?.('explain');
    _attachChatImage(images[0].getAsFile());
  });

  // Wire no-AI banner action button
  // In "download" mode → opens model manager modal
  // In "mesh" mode (data-tli-mesh-mode="1") → opens Settings panel
  const noAiBtn = $("tli-no-ai-download-btn");
  if (noAiBtn) {
    noAiBtn.addEventListener("click", () => {
      if (noAiBtn.dataset.tliMeshMode === "1") {
        if (typeof switchPanel === "function") switchPanel("panel-settings");
        return;
      }
      if (typeof window.tliOpenModelManagerModal === "function") {
        window.tliOpenModelManagerModal();
        return;
      }
      showToast("The model library is unavailable. Reload TLI and try again.", "error");
    });
  }
  // Initial check + re-check whenever panel-main becomes active
  _refreshNoAiBanner();

  sendBtn.addEventListener("click", sendChat);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  newBtn.addEventListener("click", () => {
    // reset conversation thread
    window.TLIConversationLoad?.invalidate?.();
    inFlightController?.abort();
    _clearChatImage();
    window.TLIMemory?.clear();
    window.TLIIntelligence?.clearContext?.();
    currentConversationId = null;
    window.currentConversationId = null;
    sendBtn.disabled = false;
    abortBtn.disabled = true;
    resetChatHistory({ alsoClearStorage: true });
    clearChatWithPlaceholder("New chat started. Ask anything.");
  });
  input.addEventListener("input", () => window.TLIConversationLoad?.invalidate?.());
  abortBtn.addEventListener("click", () => {
    if (inFlightController) inFlightController.abort();
  });

  // ── Recent chats buttons ─────────────────────────────────────────
  const rcRefresh = $("recent-chats-refresh");
  if (rcRefresh) rcRefresh.addEventListener("click", loadPreviousPrompts);

  const rcClear = $("recent-chats-clear");
  if (rcClear) rcClear.addEventListener("click", async () => {
    if (rcClear.disabled) return;
    if (sendBtn.disabled) { showToast("Wait for the current reply or cancel it before clearing history.", "info"); return; }
    if (!confirm("Clear all chat history? This cannot be undone.")) return;
    rcClear.disabled = true;
    try {
      const response = await fetch("/api/ai/conversations", { method: "DELETE" });
      if (!response.ok || (await response.json()).ok !== true) throw new Error("History was not cleared.");
      window.TLIConversationLoad?.deleted?.();
      if (typeof clearChatWithPlaceholder === "function") clearChatWithPlaceholder("Chat history cleared.");
      loadPreviousPrompts();
    } catch (e) {
      if (typeof showToast === "function") showToast("Could not clear history.", "warn");
    } finally { rcClear.disabled = false; }
  });

  // ── Voice input (mic button) ─────────────────────────────────────
  _setupVoiceInput();

  // ── TTS toggle ───────────────────────────────────────────────────
  _setupTTSToggle();
}


// Existing Chat entry points delegate to one browser-local voice controller.
// It owns microphone/playback lifecycles and never sends Chat automatically.
function _setupVoiceInput() { window.TLILocalVoice?.setup(); }
function _setupTTSToggle() { window.TLILocalVoice?.setup(); }
function _attachSpeakBtn(bubble, rawText) { window.TLILocalVoice?.attach(bubble, rawText); }
function tliSpeak(text) { window.TLILocalVoice?.speak(text, {automatic: true}); }
function tliSpeakBubble(btn, text) { window.TLILocalVoice?.speak(text, {button: btn}); }

// ---------- recent chats ----------
async function loadPreviousPrompts() {
  const listEl = $("recent-chats-list");
  if (!listEl) return;
  const generation = window.TLIConversationLoad?.generation;
  listEl.innerHTML = `<div class="small-meta">Loading…</div>`;
  try {
    const r = await fetch("/api/ai/conversations", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const { conversations } = await r.json();
    if (generation !== window.TLIConversationLoad?.generation) return;
    if (!conversations.length) {
      listEl.innerHTML = `<div class="small-meta">No chats yet.</div>`;
      return;
    }
    listEl.innerHTML = "";
    conversations.forEach(c => {
      const btn = document.createElement("button");
      btn.className = "recent-chat-btn";
      const title = (c.title || "Untitled").slice(0, 72);
      const turnCount = Math.max(1, Math.floor((c.message_count || 0) / 2));
      const turns = `${turnCount} turn${turnCount !== 1 ? "s" : ""}`;
      const label = document.createElement("span"), meta = document.createElement("span");
      label.className = "rc-title"; label.textContent = title;
      meta.className = "rc-meta"; meta.textContent = turns;
      btn.append(label, meta);
      btn.title = "Resume: " + title;
      btn.addEventListener("click", () => loadConversation(c.id, title));
      listEl.appendChild(btn);
    });
  } catch (e) {
    if (generation !== window.TLIConversationLoad?.generation) return;
    listEl.innerHTML = `<div class="small-meta">Could not load chats.</div>`;
  }
}

async function loadConversation(convId, title, options = {}) {
  const navigation = window.TLIConversationLoad || (window.TLIConversationLoad = { generation: 0 });
  const input = $("chat-input");
  const draft = input?.value || "";
  if ($("chat-send-btn")?.disabled) {
    if (!options.restore && typeof showToast === "function") showToast("Wait for this reply or cancel it before changing conversations.", "info");
    return false;
  }
  if (options.restore && (navigation.generation || currentConversationId || draft.trim())) return false;
  const generation = ++navigation.generation;
  navigation.loading = true;
  const current = () => generation === navigation.generation && (input?.value || "") === draft && !$("chat-send-btn")?.disabled;
  // A document question belongs to the conversation in which it was sent.
  // Invalidate its callbacks before awaiting another conversation's history.
  if (!options.refresh) {
    window.TLIDocuments?.clear();
    window.TLICaseContext?.clear();
    window.TLIMemory?.clear();
  }
  try {
    const r = await fetch(`/api/ai/conversations/${encodeURIComponent(convId)}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const conv = await r.json();
    if (!current()) return false;
    if (!Array.isArray(conv.messages)) throw new Error("Conversation messages were not returned.");
    const commitSelection = await window.TLILanInference?.prepareConversation?.(convId, { current });
    if (!current() || (commitSelection && !commitSelection())) return false;
    if (!options.refresh) window.TLIIntelligence?.clearContext?.();
    // Commit identity, AI selection and visible history together after both reads.
    currentConversationId = convId;
    window.currentConversationId = convId;
    if (typeof chatHistory !== "undefined") chatHistory = conv.messages.filter(m => ["user", "assistant"].includes(m.role) && typeof m.content === "string").map(m => ({ role: m.role, content: m.content }));
    try { if (typeof saveConversation === "function") saveConversation("", "", convId); } catch {}
    // Render messages
    const output = $("chat-output");
    if (output) {
      output.innerHTML = "";
      (conv.messages || []).forEach(m => {
        const bubble = appendMessage(m.role === "user" ? "user" : "ai", m.content);
        if (m.role === "assistant") { window.TLIScreenshots?.annotateReply(bubble, m); window.TLINotebook?.annotateReply(bubble, m); window.TLIDocuments?.annotateReply(bubble, m); window.TLICaseContext?.decorateReply(bubble, m); window.TLILanInference?.annotateReply(bubble, m); }
        if (m.role === "assistant") window.TLIMemory?.decorateReply(bubble, m);
        else window.TLIMemory?.decorateMessage(bubble, m);
      });
    }
    // Focus input
    if (!options.restore && !options.refresh && input) input.focus();
    if (!options.restore && !options.refresh && typeof showToast === "function") showToast(`Resumed: ${title}`, "info");
    return true;
  } catch (e) {
    if (current() && typeof showToast === "function") showToast("Could not load conversation.", "warn");
    return false;
  } finally { if (generation === navigation.generation) navigation.loading = false; }
}

function addPreviousPrompt(_text) {
  // Refresh the list after a new message so the latest chat appears
  setTimeout(loadPreviousPrompts, 800);
}

// ---------- status ----------
async function refreshStatus() {
  const identityGeneration = window.TLIUI?.hostIdentity?.get().generation;
  try {
    const res = await fetch("/status");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
 

        const online = !!data.model_online;
    setModelStatus(online, online ? "Model server: Online" : "Model server: Offline");

    // Update mesh model pill (local vs host)
    setMeshModelStatus(data.node_role, data.mesh_status);

    // Best-effort refresh of /mesh/node for richer context labels
    try {
      if (window.MeshService) {
        await window.MeshService.fetchNode({ force: false });
        syncMeshContextTags({ fallbackRole: String((data.node_role || "").toUpperCase() || "UNKNOWN") });
      }
    } catch {}

window.TLIUI?.hostIdentity?.observe({id: data.device_id || data.node_id, name: data.device_nickname,
  source: 'status', generation: identityGeneration});

if (data.device_id && (!window.TLIUI?.hostIdentity || (window.TLIUI.hostIdentity.get().generation === identityGeneration && window.TLIUI.hostIdentity.get().status !== 'locked'))) currentDeviceId = data.device_id;


    // Vault owns its authenticated reads and discards responses from before a
    // lock. A delayed general-status snapshot must not reopen private content.

    debugLog("info", "GET /status OK: " + JSON.stringify(data));
  } catch (err) {
    setModelStatus(false, "Model server: unreachable");
    debugLog("error", "GET /status failed: " + err.message);
  }

  // NEW: AI route awareness (Local → LAN → None)
  try { await resolveIntelligenceRoute({ forceRefresh: false }); } catch {}
}

// ---------- device rename ----------
function setupDeviceRename() {
  const btn = $("rename-device-btn");
  const nameEl = $("device-name-chip");
  const form = $("tli-rename-form");
  const input = $("tli-rename-input");
  const error = $("tli-rename-error");
  if (!btn || !nameEl || !form) return;
  let saving = false;
  function cancel(focus = false) {
    form.hidden = true;
    btn.hidden = false;
    error.hidden = true;
    if (focus) btn.focus();
  }
  btn.addEventListener('click', () => {
    btn.hidden = true;
    form.hidden = false;
    input.value = nameEl.textContent.trim();
    input.focus(); input.select();
  });
  $('tli-rename-cancel').addEventListener('click', () => cancel(true));
  document.addEventListener('tli-device-menu-closed', () => cancel());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const name = input.value.trim();
    if (!name) { error.textContent = 'Enter a device name.'; error.hidden = false; return; }
    if (name === nameEl.textContent.trim()) { cancel(true); return; }
    saving = true;
    const identity = window.TLIUI?.hostIdentity;
    const identityBefore = identity?.get();
    const current = () => !identity || (identity.get().generation === identityBefore.generation && identity.get().status !== 'locked');
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const response = await fetch('/device/nickname', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: name }),
      });
      if (!response.ok) throw new Error('Could not save device name. Please try again.');
      const saved = await response.json();
      if (!current()) return;
      if (saved?.status !== 'ok' || typeof saved.nickname !== 'string' || !saved.nickname.trim()) throw new Error('The name change could not be confirmed. Refresh the host before retrying.');
      identity?.observe({id: identityBefore.id, name: saved.nickname, source: 'host-rename', generation: identityBefore.generation});
      const meshResponse = await fetch('/mesh/node/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_name: name }),
      });
      if (!current()) return;
      if (!meshResponse.ok) throw new Error('Device renamed, but the mesh name could not be updated.');
      cancel(!document.getElementById('tli-device-popover').hidden);
    } catch (err) {
      if (!current()) return;
      error.textContent = err.message || 'Could not save device name. Please try again.';
      error.hidden = false;
      if (form.hidden && typeof showToast === 'function') showToast(error.textContent, 'warn');
    } finally { saving = false; submit.disabled = false; }
  });
  window.addEventListener('tli-session-locked', () => { input.value = ''; cancel(); });
}

// ---------- hamburger ----------
function setupHamburger() {
  const burger  = $("hamburger");
  const sidebar = $("sidebar");
  if (!burger || !sidebar) return;
  burger.addEventListener("click", () => {
    const visible = sidebar.style.display !== "none";
    sidebar.style.display = visible ? "none" : "flex";
  });
}

// ---------- Node Switcher ----------

function setupNodeSwitcher() {
  const btn = document.getElementById("node-switcher-btn");
  const menu = document.getElementById("node-switcher-menu");
  const label = document.getElementById("node-switcher-label");
  const items = document.getElementById("node-switcher-items");
  if (!btn || !menu || !items) return;
  const chipName = document.getElementById("device-name-chip");
  if (chipName && label) label.textContent = chipName.textContent.trim() || "This Node";
  let records = [], generation = 0, locked = false, request = null, unsubscribe = null;
  const element = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  function closeMenu() {
    menu.classList.add('hidden'); btn.setAttribute('aria-expanded','false');
    unsubscribe?.(); unsubscribe = null;
  }
  function rowState(record) {
    const connection = window.MeshService?.projectConnection?.(record.connection);
    const reviewed = record.status === 'allowed' && record.trust_state === 'verified';
    const online = reviewed && connection?.state === 'connected' && connection.fresh === true;
    const state = record.status === 'blocked' ? 'Access removed' : !reviewed ? 'Needs approval' : online ? 'Connected' :
      connection?.state === 'checking' ? 'Checking' : connection?.state === 'unreachable' && connection.fresh ? 'Unreachable' : 'Not checked';
    return {reviewed,online,state};
  }
  function expireStatuses() {
    if (locked || menu.classList.contains('hidden')) return;
    const byId = new Map(records.map(record => [record.device_id,record]));
    for (const row of items.querySelectorAll('.node-switcher-item')) {
      const record = byId.get(row.dataset.deviceId); if (!record) continue;
      const {online,state} = rowState(record);
      row.classList.toggle('node-switcher-item--online',online);
      row.querySelector('.node-switcher-item-dot')?.classList.toggle('node-switcher-item-dot--online',online);
      const badge = row.querySelector('.node-switcher-item-badge'); if (badge) badge.textContent = state;
    }
  }
  function paint() {
    if (locked || menu.classList.contains('hidden')) return;
    items.replaceChildren();
    if (!records.length) { items.append(element('div','No other computers are listed yet','node-switcher-empty')); return; }
    for (const record of records) {
      const {reviewed,online,state} = rowState(record);
      const node = record.peer_profile === 'inference_node';
      const name = String(record.display_name || record.device_id || 'Computer');
      const row = element('button',null,'node-switcher-item' + (online ? ' node-switcher-item--online' : ''));
      Object.assign(row.style,{width:'100%',border:'0',background:'transparent',color:'inherit',font:'inherit',textAlign:'left',cursor:'pointer'});
      row.type = 'button'; row.setAttribute('role','menuitem'); row.dataset.deviceId = record.device_id;
      row.append(element('span',null,'node-switcher-item-dot' + (online ? ' node-switcher-item-dot--online' : '')),
        element('span',name,'node-switcher-item-name'));
      row.append(element('span',state,'node-switcher-item-badge'));
      row.title = reviewed && !node ? 'Open the reviewed HTTPS console for ' + name : 'Review the connection to ' + name;
      row.addEventListener('click', () => {
        if (locked) return;
        closeMenu();
        if (reviewed && !node && window.MeshService?.openNodePanel) window.MeshService.openNodePanel(record,'');
        else window.TLIConnectDevice?.open({kind:node?'node':'computer',deviceId:record.device_id});
      });
      items.append(row);
    }
  }
  async function refreshSwitcher() {
    const ticket = ++generation;
    request?.abort(); const controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(),10000);
    try {
      const response = await fetch('/mesh/directory',{cache:'no-store',signal:controller.signal});
      if (!response.ok) throw Error('Computer directory unavailable');
      const directory = await response.json();
      if (locked || ticket !== generation) return;
      if (!Array.isArray(directory.devices) || directory.devices.length > 4096) throw Error('Computer directory incomplete');
      records = directory.devices.filter(record => typeof record.device_id === 'string' && record.device_id !== directory.this_device_id);
      paint();
    } catch {
      if (!locked && ticket === generation) { records = []; items.replaceChildren(element('div','Computer list unavailable. Open Connect device to review.','node-switcher-empty')); }
    } finally { clearTimeout(timeout); if (request === controller) request = null; }
  }
  btn.addEventListener('click', event => {
    event.stopPropagation(); if (locked) return;
    if (!menu.classList.contains('hidden')) closeMenu();
    else {
      menu.classList.remove('hidden'); btn.setAttribute('aria-expanded','true');
      paint(); refreshSwitcher();
      unsubscribe = window.MeshService?.subscribeExpiry?.(expireStatuses) || null;
    }
  });
  document.addEventListener('click', event => { if (!btn.contains(event.target) && !menu.contains(event.target)) closeMenu(); });
  for (const event of ['tli-session-locked','tli-account-changed','tli-user-changed']) window.addEventListener(event, () => {
    locked = true; generation++; request?.abort(); request = null; records = []; items.replaceChildren(); closeMenu();
  });
  window.addEventListener('tli-session-unlocked', () => { locked = false; generation++; });
  window.addEventListener('pagehide', closeMenu);
}

// ---------- init ----------

document.addEventListener("DOMContentLoaded", () => {
  try { wireAISourceModal(); } catch {}
  // Load any existing draft chat history for this browser session
  try { chatHistory = loadChatHistoryFromStorage(CHAT_HISTORY_DRAFT_ID); } catch { chatHistory = []; }
  
// =====================================================
// AI Source Picker Modal (UI)
// =====================================================
function openAISourceModal() {
  const ov = $("ai-source-modal-overlay");
  if (!ov) return;
  ov.classList.remove("hidden");
  ov.setAttribute("aria-hidden", "false");

  // Sync radio selection from current policy
  const radios = document.querySelectorAll('input[name="ai-policy"]');
  const cur = AI_POLICY || AIUserPolicy.AUTO;
  // Legacy policies not shown in new UI — remap to closest option
  const displayed = new Set(["AUTO", "LOCAL_ONLY", "PREFER_LAN_ALLOW_LOCAL"]);
  const effective = displayed.has(cur) ? cur : AIUserPolicy.AUTO;
  radios.forEach(r => { r.checked = (r.value === effective); });

  // Populate availability rows
  const localEl = $("ai-detected-local");
  const lanEl   = $("ai-detected-lan");
  if (localEl) {
    const bs = window.__tliBundledStatus;
    if (bs && bs.healthy) {
      const model = window.__tliActiveModelLabel || "Integrated AI";
      localEl.textContent = `Active — ${model}`;
      localEl.style.color = "var(--accent)";
    } else if (AIStatus.local.available) {
      localEl.textContent = `Active — ${AIStatus.local.provider || "LM Studio"}`;
      localEl.style.color = "var(--accent)";
    } else if (bs && bs.model_exists) {
      localEl.textContent = "Model present — starting…";
      localEl.style.color = "var(--text-muted)";
    } else {
      localEl.textContent = "No model downloaded";
      localEl.style.color = "var(--text-muted)";
    }
  }
  if (lanEl) {
    const nodes = AIStatus.lan.nodes || [];
    if (nodes.length) {
      lanEl.textContent = `${nodes.length} node${nodes.length > 1 ? "s" : ""} — ${nodes.map(n => n.name || n.ip).join(", ")}`;
      lanEl.style.color = "var(--accent)";
    } else {
      lanEl.textContent = "None detected";
      lanEl.style.color = "var(--text-muted)";
    }
  }

  try { syncSettingsAI(); } catch {}
}

function closeAISourceModal() {
  const ov = $("ai-source-modal-overlay");
  if (!ov) return;
  ov.classList.add("hidden");
  ov.setAttribute("aria-hidden", "true");
    stopAutoRefresh();
}

function getSelectedPolicyFromModal() {
  const picked = document.querySelector('input[name="ai-policy"]:checked');
  const v = picked ? String(picked.value) : AIUserPolicy.AUTO;
  return Object.values(AIUserPolicy).includes(v) ? v : AIUserPolicy.AUTO;
}

function updateAIRoutePreview() {
  const preview = $("ai-route-preview");
  if (!preview) return;

  const pol = getSelectedPolicyFromModal();
  const pref = $("ai-lan-host-select") ? $("ai-lan-host-select").value : (AI_LAN_PREFERRED || "AUTO");

  const localOk = !!AIStatus.local.available;
  const lanOk = !!AIStatus.lan.available;

  let msg = "";

  if (pol === AIUserPolicy.LOCAL_ONLY) {
    msg = localOk ? "Would use: LOCAL (policy Local Only)" : "Would use: OFF (local required but unavailable)";
  } else if (pol === AIUserPolicy.LAN_ONLY) {
    msg = lanOk ? `Would use: LAN (${pref === "AUTO" ? "auto host" : "preferred host"})` : "Would use: OFF (LAN required but none detected)";
  } else if (pol === AIUserPolicy.PREFER_LAN_ALLOW_LOCAL) {
    msg = lanOk ? "Would use: LAN (preferred)" : (localOk ? "Would use: LOCAL (fallback)" : "Would use: OFF");
  } else {
    // AUTO or Prefer Local Allow LAN
    msg = localOk ? "Would use: LOCAL" : (lanOk ? "Would use: LAN (fallback)" : "Would use: OFF");
  }

  preview.textContent = "Route preview: " + msg;
}


function policyLabel(v){
  if (v === AIUserPolicy.LOCAL_ONLY) return "Local Only";
  if (v === AIUserPolicy.PREFER_LAN_ALLOW_LOCAL) return "Mesh Preferred";
  return "Smart (Recommended)";
}

function syncSettingsAI(){
  const desc = $("settings-ai-source-desc");
  if (desc) desc.textContent = policyLabel(AI_POLICY);

  // Populate Settings LAN host selector
  const sel = $("settings-ai-lan-host");
  if (sel) {
    const pref = AI_LAN_PREFERRED || "AUTO";
    const prev = sel.value || pref;

    sel.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "AUTO";
    opt0.textContent = "Auto-select fastest";
    sel.appendChild(opt0);

    (AIStatus.lan.nodes || []).forEach(n => {
      const o = document.createElement("option");
      o.value = n.nodeId || n.ip;
      o.textContent = `${n.name || n.nodeId || n.ip} (${n.ip})`;
      sel.appendChild(o);
    });

    sel.value = (prev && Array.from(sel.options).some(o => o.value === prev)) ? prev : pref;
  }
}

function wireAISourceModal() {
  // ✅ Header badge is read-only.
  // Manage is handled by #ai-manage-btn (wired elsewhere) to open the correct manager/modal.

  // Close controls
  const closeBtn = $("ai-modal-close");
  const cancelBtn = $("ai-modal-cancel");
  const overlay = $("ai-source-modal-overlay");
  if (closeBtn) closeBtn.addEventListener("click", closeAISourceModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeAISourceModal);

  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAISourceModal();
    });
  }

  // Save
  const saveBtn = $("ai-modal-save");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    AI_POLICY = getSelectedPolicyFromModal();
    saveAIPolicy(AI_POLICY);
    try { await resolveIntelligenceRoute({ forceRefresh: true }); } catch {}
    closeAISourceModal();
  });

  // Escape key closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const ov = $("ai-source-modal-overlay");
      if (ov && !ov.classList.contains("hidden")) closeAISourceModal();
    }
  });
// Settings entry points (same modal, same state)
const settingsBtn = $("settings-ai-source");
if (settingsBtn) {
  settingsBtn.addEventListener("click", () => {
    openAISourceModal();
    (async () => {
      try { await resolveIntelligenceRoute({ forceRefresh: true }); } catch {}
      try { openAISourceModal(); } catch {}
    })();
  });
}

const settingsLanSel = $("settings-ai-lan-host");
if (settingsLanSel) {
  settingsLanSel.addEventListener("change", async () => {
    AI_LAN_PREFERRED = settingsLanSel.value;
    savePreferredLanNodeId(AI_LAN_PREFERRED);
    try { await resolveIntelligenceRoute({ forceRefresh: true }); } catch {}
    try { syncSettingsAI(); } catch {}
  });
}

}

// __tli_ai_bootstrap__: initialize AI route pill early
  try { resolveIntelligenceRoute({ forceRefresh: true }); } catch {}
  // Apply stored settings (brain/mode/teaching/temp/max/theme) right away
  const initialSettings = readSettings();
  applySettingsToUI(initialSettings || {});

  // Version + About modal
  setupVersionAndAbout();

  // Typewriter animation for the header title (runs once on load)
  function runTitleTypeAnimation() {
    const span = document.getElementById("tli-title-typed");
    if (!span) return;

    // Avoid re-running if something calls it twice
    if (span.dataset.typed === "done") return;

    const full = (span.dataset.full || span.textContent || "").trim();
    if (!full) return;

    span.textContent = "";
    let i = 0;
    const minDelay = 45;   // base speed
    const jitter = 55;     // random extra for a more organic feel

    function step() {
      span.textContent = full.slice(0, i + 1);
      i += 1;

      if (i < full.length) {
        const delay = minDelay + Math.random() * jitter;
        window.setTimeout(step, delay);
      } else {
        span.dataset.typed = "done";
      }
    }

    step();
  }

  // Run the header title typewriter once on load
  runTitleTypeAnimation();

  // Collapsibles
  document.querySelectorAll(".collapsible-card").forEach(makeCollapsible);

  // (…rest of your existing init code stays as-is below this)



  // Collapsibles
  document.querySelectorAll(".collapsible-card").forEach(makeCollapsible);

  // Init debug console (must be after collapsibles so DOM exists)
  initDebugConsole();

  // Landing selection (clean):
  const didDeepLink = openPanelFromQuery();
  if (!didDeepLink) {
    // Interface style never changes startup navigation or the active workspace.
    const preferred = document.getElementById('panel-dashboard2');
    const fallback =
      document.querySelector(".panel-container.active") ||
      document.getElementById("panel-main");
    const initialPanel = preferred || fallback;
    if (initialPanel) switchPanel(initialPanel.id);
  }

  // Critical UI setup
  setupTeachingToggle();
  setupChatHistoryDrawer();
  setupChat();

  setTimeout(() => {
    try { setupAdvancedControls(); } catch {}
    try { setupDeviceRename(); } catch {}
    try { setupMeshPanel(); } catch {}
    try { setupHamburger(); } catch {}
  }, 0);

  setTimeout(() => {
    try { setupFilesPanel(); } catch {}
    try { setupVisualizer(); } catch {}
    try { setupToolsPanel(); } catch {}
    try { if (window.TLISystem && typeof window.TLISystem.setup === "function") window.TLISystem.setup(); } catch {}
  }, 0);

  setTimeout(() => {
    try { if (window.TLIGames && typeof window.TLIGames.setup === "function") window.TLIGames.setup(); } catch {}
    try { if (window.TLIHomeAutoActions && typeof window.TLIHomeAutoActions.setup === "function") window.TLIHomeAutoActions.setup(); } catch {}
    try { setupScriptsPanel(); } catch {}
    try { setupSettingsPanel(); } catch {}
    try { loadSettingsPanel(); } catch {}
    try { setupHubPanel(); } catch {}
    try { setupFederatedChat(); } catch {}
  }, 0);

  setTimeout(() => {
    try { setupVaultPanel(); } catch {}
    try { setupSettingsVault(); } catch {}
    try { setupHomeAutomationPanel(); } catch {}
    try { setupNodeSwitcher(); } catch {}
  }, 0);

  setTimeout(() => {
    try { loadPreviousPrompts(); } catch {}
    refreshStatus();
    try { fetchVaultStatus(); } catch {}
    try { refreshToolsList(); } catch {}
    setInterval(refreshStatus, 30000);
  }, 50);
});

// ---------- Visualizer Legend ----------
function buildLegend(colorScale, categories) {
  const legend = document.getElementById("legend");
  if (!legend) return;

  // clear any previous legend entries
  legend.innerHTML = "";

  categories.forEach((name) => {
    const item = document.createElement("div");
    item.className = "legend-item";

    const swatch = document.createElement("div");
    swatch.className = "legend-color";
    swatch.style.background = colorScale(name);

    const label = document.createElement("div");
    label.textContent = name;

    item.appendChild(swatch);
    item.appendChild(label);
    legend.appendChild(item);
  });
}
// Build legend UI from array of { name, color }
function buildTreemapLegend(items) {
  const legend = document.getElementById("treemap-legend");
  if (!legend) return;
  legend.innerHTML = "";
  items.forEach(({ name, color }) => {
    if (!name || !color) return;
    const item = document.createElement("div");
    item.className = "treemap-legend-item";
    const swatch = document.createElement("div");
    swatch.className = "treemap-legend-color";
    swatch.style.backgroundColor = color;
    const label = document.createElement("span");
    label.textContent = name;
    item.appendChild(swatch);
    item.appendChild(label);
    legend.appendChild(item);
  });
}

// Read current treemap rects and build a legend by file extension
function updateTreemapLegendFromDom() {
  const legendItems = [];
  const seen = new Set();

  d3.select("#treemap-container")
    .selectAll("rect.treemap-rect")
    .each(function (d) {
      if (!d || !d.data) return;

      const name = d.data.name || "";
      let ext = "";

      const lastDot = name.lastIndexOf(".");
      if (lastDot > 0 && lastDot < name.length - 1) {
        ext = name.slice(lastDot).toLowerCase(); // ".exe", ".sys", etc.
      } else {
        ext = "(no extension)";
      }

      // Get the actual color used for this rect
      const color =
        this.style.fill ||
        this.getAttribute("fill") ||
        window.getComputedStyle(this).fill;

      if (!color) return;

      // Use "ext|color" as a unique key so same ext+color collapses to one entry
      const key = ext + "|" + color;
      if (seen.has(key)) return;
      seen.add(key);

      legendItems.push({
        name: ext,
        color: color,
      });
    });

  // Limit so it doesn't get stupidly long
  const limited = legendItems.slice(0, 12);
  buildTreemapLegend(limited);
}

/* modules/tli_chat.js
   TLI Chat (Home) — Node discovery + messenger UX + File Share UI (UI-first)

   - Discovers nodes via /mesh/directory (and window.meshDirectoryCache)
   - If NO nodes found -> injects a Local Loopback node (so you can test today)
   - Node search filters the current source list (won't wipe loopback)
   - Chat threads per node (UI-local)
   - File share cards + Transfers drawer (simulated progress until backend exists)
   - Policy: NO size limit, confirm above 5GB (incoming accept)
*/


// =====================================================
// TLI Automations Panel
// Trigger types: presence.node_online/offline, power.above/below, schedule.daily
// Actions: shelly.switch
// =====================================================


// =====================================================
// SearXNG — handled by /js/tli-search.js
// =====================================================
/* tli-search.js handles all SearXNG integration. */



// =====================================================
// Settings UI: Inject "Reset onboarding" button (no index.html changes)
// - Inserts next to existing Settings buttons when Settings panel is rendered.
// =====================================================
(function registerResetOnboardingButton() {
  function doReset() { window.TLIOnboarding?.replay(); }

  function injectResetOnboardingButton() {
    // Stable anchor inside Settings: the "Refresh models" button exists in your UI.
    const buttons = Array.from(document.querySelectorAll("button"));
    const anchor = buttons.find(b => (b.textContent || "").trim().toLowerCase() === "refresh models");
    if (!anchor) return false;

    // Don't inject twice
    if (document.getElementById("tli-reset-onboarding-btn")) return true;

    const btn = document.createElement("button");
    btn.id = "tli-reset-onboarding-btn";
    btn.className = "btn btn-ghost btn-sm";
    btn.textContent = "Welcome & setup";
    btn.title = "Revisit your TLI welcome and setup";
    btn.addEventListener("click", doReset);

    // Insert right after "Refresh models"
    anchor.insertAdjacentElement("afterend", btn);
    return true;
  }

  // Try immediately + retry a few times after load (no MutationObserver — too expensive on body)
  document.addEventListener("DOMContentLoaded", () => {
    // Try at 0ms, 2s, 5s, 10s — covers late-rendering Settings panel without DOM scanning on every mutation
    [0, 2000, 5000, 10000].forEach((delay) => {
      setTimeout(() => { try { injectResetOnboardingButton(); } catch {} }, delay);
    });
  });
})();




/* =========================================================
   TLI PATCH (SAFE): AI Source of Truth (Header + Main Chat) v2
   - Header: #ai-source-pill (read-only) + separate Manage button (#ai-manage-btn)
   - Main Chat: #ai-source-badge mirrors the same source
   - Respects existing AI_POLICY (Local vs LAN) via resolveIntelligenceRoute()
   - Treats Bundled AI as a LOCAL fallback when LM Studio is unavailable
   - NEVER shows "Model missing" unless Bundled is the active source (details live in Manage)
   ========================================================= */

/* ============================================================
 * 
/* ============================================================
 * TLI — Bundled AI Model Manager (installer-grade v2)
 * Goals:
 * - NO fake checkmarks (only turn on when true)
 * - Real progress: % / MB / MBps via backend polling
 * - Do NOT auto-open browser on failure (proxy/captive portal issues)
 * Endpoints (must exist in backend):
 * - GET  /api/ai/model/info
 * - POST /api/ai/model/download   {url}
 * - GET  /api/ai/model/progress
 * ============================================================ */



/* =====================================================
   MESH CONTROL CENTER — Collective Dashboard
   ===================================================== */

/* =====================================================
   TLI_PRINTERS_NATIVE_SETTINGS_WIRE (cross-platform)
   Why:
   - Printer discovery endpoints may not exist on all OSes/builds.
   - "Discover" should always do *something useful*.
   What:
   - Any click on a button that says "Discover" or "Add Printer"
     will open the OS-native printer UI via backend:
       POST /api/printers/open_add
   Safe:
   - No-op if backend route missing; shows toast if available.
   ===================================================== */


// Uplift 1.3 SAFE: Quick Actions More/Less
let dash2QuickMoreWired=false;
window.addEventListener('DOMContentLoaded', ()=>{
  if(dash2QuickMoreWired) return;
  dash2QuickMoreWired=true;
  const btn=document.getElementById('dash2-quick-more');
  const grid=document.getElementById('dash2-quick-grid');
  if(!btn || !grid) return;
  btn.addEventListener('click', ()=>{
    const collapsed = grid.getAttribute('data-collapsed')==='1';
    grid.setAttribute('data-collapsed', collapsed ? '0' : '1');
    btn.textContent = collapsed ? 'Less' : 'More';
  });
});



// =====================================================
// Uplift 4 — Unified Action Engine (Home Automation UI)
// Goals:
// - Do NOT touch existing Shelly control chain.
// - Provide an understandable "Game Mode" builder.
// - Store actions deterministically via backend /actions/* endpoints.
// =====================================================


/* =============================================================
   PWA Install Prompt
   - Android Chrome: deferred beforeinstallprompt → banner with Install button
   - iOS Safari:     banner with "Add to Home Screen" instructions
   - Dismissal stored in localStorage; never shown again once dismissed
   ============================================================= */


// =====================================================
