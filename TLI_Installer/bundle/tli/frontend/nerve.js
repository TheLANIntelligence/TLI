/* ============================================================
   nerve.js — TLI Alive System
   Drop-in after app.js + chat_enhanced.js.

   Exposes:
     window.tliToast(message, type)   — success|error|info|warning
     window.tliNerveRefreshPulse()    — force pulse update now

   Hooks:
     tliBundledChatStream → intercepts onMeta (handled_by detection)
     /api/ai/bundled/status + /homeauto/devices → pulse bar (30s interval)
   ============================================================ */
(function () {
  "use strict";

  // ── Toast system ────────────────────────────────────────────

  const MAX_TOASTS    = 3;
  const TOAST_DURATION = 4000; // ms

  const _ICONS = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };

  function _ensureContainer() {
    let c = document.getElementById("tli-toast-container");
    if (!c) {
      c = document.createElement("div");
      c.id = "tli-toast-container";
      document.body.appendChild(c);
    }
    return c;
  }

  function _removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    clearTimeout(toast._tliTid);
    toast.classList.add("tli-toast--out");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 240);
  }

  window.tliToast = function tliToast(message, type) {
    type = (type && _ICONS[type]) ? type : "info";
    const container = _ensureContainer();

    // Trim oldest toasts when at capacity
    while (container.children.length >= MAX_TOASTS) {
      _removeToast(container.firstChild);
    }

    const toast = document.createElement("div");
    toast.className = `tli-toast tli-toast--${type}`;

    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const safe = String(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    toast.innerHTML =
      `<span class="tli-toast-icon">${_ICONS[type]}</span>` +
      `<div class="tli-toast-body">` +
        `<div class="tli-toast-msg">${safe}</div>` +
        `<div class="tli-toast-ts">${now}</div>` +
      `</div>` +
      `<button class="tli-toast-close" aria-label="Dismiss">×</button>`;

    toast.querySelector(".tli-toast-close").addEventListener("click", () => _removeToast(toast));
    container.appendChild(toast);

    toast._tliTid = setTimeout(() => _removeToast(toast), TOAST_DURATION);
  };


  // ── Chat stream hook ────────────────────────────────────────
  //
  // Wraps tliBundledChatStream (already wrapped by chat_enhanced.js).
  // Intercepts onMeta to detect handled_by="intent_engine" (device action),
  // then accumulates delta text and shows a toast on completion.

  function _hookChatStream() {
    if (!window.tliBundledChatStream || window.tliBundledChatStream.__nerveHooked) return;

    const _orig = window.tliBundledChatStream;

    window.tliBundledChatStream = async function nerveStream(opts) {
      let _isDevice   = false;
      let _isFast     = false;
      let _accumulated = "";

      const _origOnMeta  = opts.onMeta;
      const _origOnDelta = opts.onDelta;

      opts.onMeta = function (meta) {
        if (_origOnMeta) _origOnMeta(meta);
        const h = meta && meta.handled_by;
        if (h === "intent_engine")  _isDevice = true;
        if (h === "tool_fastpath")  _isFast   = true;
      };

      opts.onDelta = function (text) {
        if (_origOnDelta) _origOnDelta(text);
        if (_isDevice) _accumulated += text;
      };

      const result = await _orig.call(this, opts);

      // Show toast after stream completes
      if (_isDevice && _accumulated.trim()) {
        const firstLine = _accumulated
          .split("\n")[0]
          .replace(/\*\*/g, "")   // strip markdown bold
          .replace(/^Done\.\s*/i, "")
          .trim();
        if (firstLine) {
          const isFailure = /didn't respond|failed|error|unreachable/i.test(firstLine);
          window.tliToast(firstLine, isFailure ? "error" : "success");
        }
      } else if (_isFast) {
        window.tliToast("Local index answered", "info");
      }

      return result;
    };

    window.tliBundledChatStream.__nerveHooked = true;
  }


  // ── Pulse status bar ────────────────────────────────────────

  let _pulseTimer = null;

  function _ensurePulseBar() {
    if (document.getElementById("tli-pulse-bar")) return;

    const bar = document.createElement("div");
    bar.id        = "tli-pulse-bar";
    bar.className = "tli-pulse-bar";
    bar.title     = "Live system status — refreshes every 30s";
    bar.innerHTML =
      `<span class="tli-pulse-dot tli-pulse-dot--idle" id="tli-pulse-dot"></span>` +
      `<span class="tli-pulse-text" id="tli-pulse-text">Checking…</span>`;

    // Insert into .header-right, before the lock button
    const headerRight = document.querySelector(".header-right");
    if (!headerRight) return;
    const lockBtn = headerRight.querySelector("#tli-lock-btn");
    if (lockBtn) {
      headerRight.insertBefore(bar, lockBtn);
    } else {
      headerRight.appendChild(bar);
    }
  }

  async function _updatePulse() {
    const dot  = document.getElementById("tli-pulse-dot");
    const text = document.getElementById("tli-pulse-text");
    if (!dot || !text) return;

    try {
      const [aiSettled, devSettled] = await Promise.allSettled([
        fetch("/api/ai/bundled/status", { signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null),
        fetch("/homeauto/devices",       { signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null),
      ]);

      const aiData  = aiSettled.status  === "fulfilled" ? aiSettled.value  : null;
      const devData = devSettled.status === "fulfilled" ? devSettled.value : null;

      const aiOk     = !!(aiData && (aiData.ok || aiData.healthy));
      const devCount = devData && Array.isArray(devData.devices)
        ? devData.devices.length
        : "?";

      dot.className  = `tli-pulse-dot ${aiOk ? "tli-pulse-dot--good" : "tli-pulse-dot--bad"}`;
      text.textContent = `${devCount} devices · ${aiOk ? "AI ready" : "AI offline"}`;
    } catch {
      dot.className    = "tli-pulse-dot tli-pulse-dot--idle";
      text.textContent = "Status unknown";
    }
  }

  window.tliNerveRefreshPulse = function () {
    _updatePulse();
  };

  function _startPulse() {
    // COMMENTED OUT (recovery mode) — all timers disabled
    // if (_pulseTimer) return;
    // _ensurePulseBar();
    // setTimeout(_updatePulse, 6000);
    // _pulseTimer = setInterval(_updatePulse, 30_000);
  }


  // ── Init ───────────────────────────────────────────────────

  function _init() {
    // Hook chat stream — by this point chat_enhanced.js has already run
    _hookChatStream();
    // Start pulse (safe after DOMContentLoaded) — DISABLED (recovery mode)
    // _startPulse();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
})();
