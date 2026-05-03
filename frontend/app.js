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
  try {
    const r = await fetch("/visualizer/paths");
    if (!r.ok) return;
    const data = await r.json();
    window.TLI_PATHS = data;
    _tliApplyPathSuggestions(data);
    document.dispatchEvent(new CustomEvent("tli:paths-loaded", { detail: data }));
  } catch { /* non-fatal */ }
}

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

// Recovery: dashboard panel was broken by a previous session — force classic mode.
// Prevents the animated dashboard (with GPU-expensive blur filters) from loading.
try { localStorage.setItem("tli_ui_mode", "classic"); } catch {}

// [module] See /js/tli-games.js
// [module] See /js/tli-system.js


// =====================================================
// First-Run Onboarding Wizard (v1, installer-safe)
// - Blocks the app UI until finished (via html[data-tli-onboard="1"] + CSS)
// - Uses the onboarding markup in index.html (tli-onboard ids)
// - Intro audio starts on first Continue (fade-in), with Stop + Volume slider (optional)
// =====================================================
const TLI_ONBOARD_SEEN_KEY = "tli_onboard_seen_v1";
const TLI_FORCE_ONBOARD_KEY = "tli_force_onboard_once";

// Preflight: hide app-shell from first paint if onboarding should run
(() => {
  try {
    const seen = localStorage.getItem(TLI_ONBOARD_SEEN_KEY) === "1";
    const forced = localStorage.getItem(TLI_FORCE_ONBOARD_KEY) === "1";
    if (!seen || forced) document.documentElement.dataset.tliOnboard = "1";
  } catch {}
})();

function tliLSGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return (v === null || v === undefined) ? fallback : v;
  } catch { return fallback; }
}


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

function tliLSSet(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }
function tliLSBool(key, fallback = false) {
  const v = tliLSGet(key, fallback ? "1" : "0");
  return v === "1" || v === "true";
}

function tliShowOnboard() {
  const el = document.getElementById("tli-onboard");
  if (!el) return;
  try { document.documentElement.dataset.tliOnboard = "1"; } catch {}
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
}
function tliHideOnboard(markSeen = true) {
  const el = document.getElementById("tli-onboard");
  if (!el) return;
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");
  try { delete document.documentElement.dataset.tliOnboard; } catch {}
  if (markSeen) tliLSSet(TLI_ONBOARD_SEEN_KEY, "1");
}

function tliStopAudio(audioEl) {
  try {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.currentTime = 0;
  } catch {}
}

function tliFadeInAudio(audioEl, targetVol = 0.22, ms = 900) {
  if (!audioEl) return;
  const start = performance.now();
  const startVol = 0.0;
  try {
    audioEl.muted = false;
    audioEl.volume = 0.0;
  } catch {}
  const step = (t) => {
    const p = Math.min(1, (t - start) / ms);
    const v = startVol + (targetVol - startVol) * p;
    try { audioEl.volume = v; } catch {}
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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

async function tliDetectLocalAI() {
  // Prefer Bundled AI; only fall back to LM Studio if explicitly needed elsewhere.
  try {
    const rep = await tliFetchBundledStatus();
    const ok = !!(rep && rep.ok === true);
    return ok ? { ok: true, label: "Bundled" } : { ok: false, label: "Not detected" };
  } catch {
    return { ok: false, label: "Not detected" };
  }
}

async function tliSetDeviceNickname(name) {
  const n = (name || "").trim();
  if (!n) return;
  try {
    await fetch("/device/nickname", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: n }),
    });
  } catch {}
}

async function setupOnboardingWizard() {
  const container = document.getElementById("tli-onboard");
  if (!container) return;

  const forced = tliLSGet(TLI_FORCE_ONBOARD_KEY, "0") === "1";
  if (forced) tliLSSet(TLI_FORCE_ONBOARD_KEY, "0");

  // Check backend status — backend is source of truth on fresh installs
  try {
    const r = await fetch("/system/onboarding/status");
    if (r.ok) {
      const d = await r.json();
      if (d.complete && !forced) {
        tliLSSet(TLI_ONBOARD_SEEN_KEY, "1");
        try { delete document.documentElement.dataset.tliOnboard; } catch {}
        return;
      }
      if (!d.complete) {
        // Fresh install — clear any stale localStorage flag from a previous install
        tliLSSet(TLI_ONBOARD_SEEN_KEY, "0");
      }
    }
  } catch {}

  const already = tliLSGet(TLI_ONBOARD_SEEN_KEY, "0") === "1";
  if (already && !forced) {
    try { delete document.documentElement.dataset.tliOnboard; } catch {}
    return;
  }

  const titleEl  = document.getElementById("tli-onboard-step-title");
  const textEl   = document.getElementById("tli-onboard-step-text");
  const dynEl    = document.getElementById("tli-onboard-dyn");
  const statusEl = document.getElementById("tli-onboard-status");
  const barEl    = document.getElementById("tli-onboard-bar");

  const backBtn  = document.getElementById("tli-onboard-back");
  const nextBtn  = document.getElementById("tli-onboard-next");
  const closeBtn = document.getElementById("tli-onboard-close");

  const audioEl  = document.getElementById("tli-startup-audio");
  const stopBtn  = document.getElementById("tli-audio-stop"); // legacy, may be absent
  const ppBtn    = document.getElementById("tli-audio-playpause");
  const volEl    = document.getElementById("tli-audio-vol");

  if (!titleEl || !textEl || !dynEl || !statusEl || !barEl || !backBtn || !nextBtn || !closeBtn) {
    console.warn("[TLI] Onboarding markup missing; skipping.");
    try { delete document.documentElement.dataset.tliOnboard; } catch {}
    return;
  }

  // optional audio controls
  if (stopBtn) stopBtn.addEventListener("click", () => tliStopAudio(audioEl));
  if (ppBtn && audioEl) {
    ppBtn.addEventListener("click", () => {
      if (audioEl.paused) {
        const p = audioEl.play();
        if (p) p.catch(() => {});
        ppBtn.dataset.playing = "1";
        audioStarted = true;
      } else {
        audioEl.pause();
        ppBtn.dataset.playing = "0";
      }
    });
  }
  if (volEl) {
    volEl.addEventListener("input", () => {
      const v = parseFloat(volEl.value || "0.22");
      try { if (audioEl) audioEl.volume = Math.max(0, Math.min(1, v)); } catch {}
    });
  }

  let step = 0;
  let audioStarted = false;
  let _aiPolling = null;

  const steps = [
    // ── Step 0: Welcome + node name ────────────────────────────
    {
      title: "Welcome to TheLANIntelligence",
      text: "Your private home console — no cloud, no accounts, no tracking.\nLet’s get you set up in a few quick steps.",
      build: () => {
        dynEl.innerHTML = `
          <div class="tli-onboard-field">
            <label for="onboard-node-name">Name this machine</label>
            <input id="onboard-node-name" type="text" placeholder="e.g. Office PC, Media Server, Laptop" maxlength="48" autofocus />
          </div>
          <div class="tli-onboard-cardmini">
            <div class="h">Why name it?</div>
            <div class="p">Used in the mesh dashboard and Chat. You can change it anytime in Settings → Node Identity.</div>
          </div>
        `;
        statusEl.textContent = "You can leave it blank to use the hostname default.";
        nextBtn.textContent = "Continue";
      },
      onNext: async () => {
        const name = (document.getElementById("onboard-node-name")?.value || "").trim();
        if (name) {
          try {
            await fetch("/system/node/name", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            });
            // Also update legacy nickname store for dashboard display
            await tliSetDeviceNickname(name);
          } catch {}
        }
      },
    },

    // ── Step 1: PIN setup ──────────────────────────────────────
    {
      title: "Set an access PIN (recommended)",
      text: "A PIN locks TLI so only you can open it from the browser. Hashed with PBKDF2 — never stored in plaintext.",
      build: () => {
        dynEl.innerHTML = `
          <div class="tli-onboard-field">
            <label for="onboard-pin">PIN (4–32 characters)</label>
            <input id="onboard-pin" type="password" placeholder="Choose a PIN" maxlength="32" autocomplete="new-password" />
          </div>
          <div class="tli-onboard-field">
            <label for="onboard-pin2">Confirm PIN</label>
            <input id="onboard-pin2" type="password" placeholder="Repeat PIN" maxlength="32" autocomplete="new-password" />
          </div>
          <div class="tli-onboard-cardmini">
            <div class="h">Skip PIN?</div>
            <div class="p">Leave both fields blank to skip. You can add a PIN later in Settings → PIN Lock.</div>
          </div>
        `;
        statusEl.textContent = "";
        nextBtn.textContent = "Continue";

        // Real-time mismatch feedback
        const pinEl  = document.getElementById("onboard-pin");
        const pin2El = document.getElementById("onboard-pin2");
        const check = () => {
          if (!pin2El.value) { statusEl.textContent = ""; return; }
          statusEl.textContent = pinEl.value === pin2El.value ? "✓ PINs match" : "PINs do not match";
          statusEl.style.color = pinEl.value === pin2El.value ? "var(--accent)" : "var(--danger, #f87171)";
        };
        pinEl?.addEventListener("input", check);
        pin2El?.addEventListener("input", check);
      },
      onNext: async () => {
        const pin  = document.getElementById("onboard-pin")?.value || "";
        const pin2 = document.getElementById("onboard-pin2")?.value || "";
        if (!pin && !pin2) return; // skipped
        if (pin.length < 4) { statusEl.textContent = "PIN must be at least 4 characters."; throw new Error("pin too short"); }
        if (pin !== pin2) { statusEl.textContent = "PINs do not match."; throw new Error("pin mismatch"); }
        try {
          const r = await fetch("/system/pin/set", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            statusEl.textContent = d.detail || "Failed to set PIN.";
            throw new Error("pin set failed");
          }
          // Immediately verify to establish session cookie
          await fetch("/system/pin/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin }),
          });
        } catch (e) {
          if (e.message !== "pin too short" && e.message !== "pin mismatch" && e.message !== "pin set failed") {
            statusEl.textContent = "Network error setting PIN.";
          }
          throw e;
        }
      },
    },

    // ── Step 2: Bundled AI download ────────────────────────────
    {
      title: "Get your AI",
      text: "TLI includes a built-in AI that runs entirely on your computer.\nDownload it once — it's yours forever. No accounts, no internet after download.",
      build: async () => {
        dynEl.innerHTML = `<div id="onboard-ai-body"><div class="tli-onboard-detect-badge tli-onboard-detect-scanning" style="margin-bottom:12px">Checking…</div></div>`;
        statusEl.textContent = "You can skip and download later in Settings → AI.";
        nextBtn.textContent = "Skip for now";

        let _dlInterval = null;

        function _fmtBytes(b) {
          if (!b) return "?";
          if (b > 1e9) return (b / 1e9).toFixed(1) + " GB";
          return (b / 1e6).toFixed(0) + " MB";
        }

        function _renderProgress() {
          fetch("/api/ai/model/download/status").then(r => r.json()).then(dl => {
            const bar = document.getElementById("onboard-ai-dlbar");
            const lbl = document.getElementById("onboard-ai-dllbl");
            if (!bar || !lbl) return;
            if (dl.status === "done") {
              clearInterval(_dlInterval);
              lbl.textContent = "Download complete ✓";
              bar.style.width = "100%";
              bar.style.background = "var(--accent)";
              nextBtn.textContent = "Continue";
              statusEl.textContent = "Your AI is ready.";
              return;
            }
            if (dl.status === "error") {
              clearInterval(_dlInterval);
              lbl.textContent = "Download failed: " + (dl.error || "unknown error");
              return;
            }
            if (dl.in_progress && dl.bytes_total > 0) {
              const pct = Math.round((dl.bytes_done / dl.bytes_total) * 100);
              bar.style.width = pct + "%";
              lbl.textContent = `Downloading… ${_fmtBytes(dl.bytes_done)} / ${_fmtBytes(dl.bytes_total)} (${pct}%)`;
            }
          }).catch(() => {});
        }

        function _startDownload(presetId) {
          const body = document.getElementById("onboard-ai-body");
          if (!body) return;
          body.innerHTML = `
            <div style="margin-bottom:10px;font-weight:600;font-size:14px" id="onboard-ai-dllbl">Starting download…</div>
            <div style="background:var(--bg-elevated-alt);border-radius:99px;height:8px;overflow:hidden;margin-bottom:8px">
              <div id="onboard-ai-dlbar" style="height:100%;width:0%;background:var(--accent);border-radius:99px;transition:width .3s"></div>
            </div>
            <button class="btn btn-ghost btn-sm" id="onboard-ai-cancel">Cancel</button>
          `;
          document.getElementById("onboard-ai-cancel")?.addEventListener("click", () => {
            fetch("/api/ai/model/download/cancel", { method: "POST" }).catch(() => {});
            clearInterval(_dlInterval);
            _buildChooser();
          });
          fetch("/api/ai/model/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: presetId }),
          }).catch(() => {});
          clearInterval(_dlInterval);
          _dlInterval = setInterval(_renderProgress, 800);
          _renderProgress();
        }

        async function _buildChooser() {
          const body = document.getElementById("onboard-ai-body");
          if (!body) return;

          // Get RAM to suggest a tier
          let ramGb = 16;
          try {
            const sr = await fetch("/system/summary");
            if (sr.ok) { const sd = await sr.json(); ramGb = sd?.memory?.total_gb || 16; }
          } catch {}

          // Get preset list
          let presets = [];
          try {
            const pr = await fetch("/api/ai/models/presets");
            if (pr.ok) { const pd = await pr.json(); presets = pd.presets || []; }
          } catch {}

          // Check if any already downloaded
          const downloaded = presets.find(p => p.downloaded);
          if (downloaded) {
            body.innerHTML = `
              <div class="tli-onboard-cardmini" style="border-color:var(--accent);margin-bottom:12px">
                <div class="h" style="color:var(--accent)">AI already downloaded ✓</div>
                <div class="p">${downloaded.name} is ready to use.</div>
              </div>`;
            nextBtn.textContent = "Continue";
            statusEl.textContent = "Your AI is ready.";
            return;
          }

          // Recommend a tier based on RAM
          const recommended = ramGb >= 16 ? "power" : ramGb >= 12 ? "standard" : "lite";
          const tierRows = presets.map(p => {
            const isRec = p.id === recommended;
            return `
              <div class="tli-onboard-ai-tier${isRec ? " recommended" : ""}" data-preset-id="${p.id}">
                <div class="tli-onboard-ai-tier-top">
                  <span class="tli-onboard-ai-tier-name">${p.name}${isRec ? ' <span class="tli-onboard-ai-rec">Recommended</span>' : ""}</span>
                  <span class="tli-onboard-ai-tier-size">${p.size_human}</span>
                </div>
                <div class="tli-onboard-ai-tier-desc">${p.description}</div>
              </div>`;
          }).join("");

          body.innerHTML = `
            <div class="tli-onboard-ai-tiers">${tierRows}</div>
            <button class="pill-btn primary" id="onboard-ai-dl-btn" style="margin-top:12px;width:100%">Download Standard AI</button>
          `;

          let selectedPreset = recommended;
          document.querySelectorAll(".tli-onboard-ai-tier").forEach(el => {
            el.addEventListener("click", () => {
              document.querySelectorAll(".tli-onboard-ai-tier").forEach(x => x.classList.remove("selected"));
              el.classList.add("selected");
              selectedPreset = el.dataset.presetId;
              const p = presets.find(x => x.id === selectedPreset);
              const dlBtn = document.getElementById("onboard-ai-dl-btn");
              if (dlBtn && p) dlBtn.textContent = `Download ${p.name.split(" (")[0]}`;
            });
            // Pre-select recommended
            if (el.dataset.presetId === recommended) el.classList.add("selected");
          });

          document.getElementById("onboard-ai-dl-btn")?.addEventListener("click", () => {
            _startDownload(selectedPreset);
          });
        }

        _buildChooser();
      },
      onNext: async () => {
        // Nothing to save — download is fire-and-forget in background
      },
    },

    // ── Step 3: Done ───────────────────────────────────────────
    {
      title: "You’re in.",
      text: "TLI is running entirely on your LAN. Nothing leaves your network.",
      build: async () => {
        // Pull latest autodetect summary for the done screen
        let ad = null;
        try {
          const r = await fetch("/setup/autodetect");
          if (r.ok) ad = await r.json();
        } catch {}

        // Check bundled AI model status
        let aiStatus = `<span style="color:var(--warning,#f59e0b);font-weight:600;">Not downloaded</span> <button id="tli-onboard-ai-dl-now" style="margin-left:8px;background:var(--accent);color:#050d09;border:none;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600;cursor:pointer;">Get AI</button>`;
        if (_aiPolling) { clearInterval(_aiPolling); _aiPolling = null; }
        async function _refreshAiStatus() {
          try {
            const air = await fetch("/api/ai/model/info");
            if (air.ok) {
              const aid = await air.json();
              if (aid.exists) {
                clearInterval(_aiPolling);
                const valEl = document.getElementById("tli-onboard-ai-val");
                if (valEl) valEl.innerHTML = `<span style="color:var(--accent)">Ready ✓</span> · ${aid.preset?.name || "Integrated AI"}`;
                return true;
              }
            }
            // Fallback: check /api/ai/status for active model
            const str = await fetch("/api/ai/status");
            if (str.ok) {
              const std = await str.json();
              if (std.active_model || std.model_loaded) {
                clearInterval(_aiPolling);
                const valEl = document.getElementById("tli-onboard-ai-val");
                if (valEl) valEl.innerHTML = `<span style="color:var(--accent)">Ready ✓</span> · ${std.active_model || "Integrated AI"}`;
                return true;
              }
            }
            // Check download in progress
            const dlr = await fetch("/api/ai/model/download/status");
            if (dlr.ok) {
              const dld = await dlr.json();
              const valEl = document.getElementById("tli-onboard-ai-val");
              if (dld.status === "done") {
                clearInterval(_aiPolling);
                if (valEl) valEl.innerHTML = `<span style="color:var(--accent)">Ready ✓</span> · Integrated AI`;
                return true;
              }
              if (dld.in_progress && valEl) {
                const pct = dld.bytes_total > 0 ? Math.round((dld.bytes_done / dld.bytes_total) * 100) : 0;
                valEl.innerHTML = `<span style="color:var(--warning,#f59e0b)">Downloading… ${pct}%</span>`;
              }
            }
          } catch {}
          return false;
        }
        const ready = await _refreshAiStatus();
        if (!ready) {
          // Poll every 3s in case download finishes while user is on this card
          _aiPolling = setInterval(_refreshAiStatus, 3000);
        }
        if (!ready) {
          // keep default "Not downloaded" aiStatus
        } else {
          aiStatus = `<span id="tli-onboard-ai-val" style="color:var(--accent)">Ready ✓</span>`;
        }
        const shellyLine = ad?.shelly?.count > 0
          ? `${ad.shelly.count} device${ad.shelly.count !== 1 ? "s" : ""} registered`
          : "None yet — add in Home Automation";
        const nodeLine   = ad?.node?.name || "TLI Node";
        const lanLine    = ad?.lan_ip     || "127.0.0.1";

        dynEl.innerHTML = `
          <div class="tli-onboard-summary">
            <div class="tli-onboard-summary-row">
              <span class="tli-onboard-summary-label">AI</span>
              <span class="tli-onboard-summary-val" id="tli-onboard-ai-val">${aiStatus}</span>
            </div>
            <div class="tli-onboard-summary-row">
              <span class="tli-onboard-summary-label">Devices</span>
              <span class="tli-onboard-summary-val">${shellyLine}</span>
            </div>
            <div class="tli-onboard-summary-row">
              <span class="tli-onboard-summary-label">Node</span>
              <span class="tli-onboard-summary-val">${nodeLine}</span>
            </div>
            <div class="tli-onboard-summary-row">
              <span class="tli-onboard-summary-label">LAN IP</span>
              <span class="tli-onboard-summary-val">${lanLine}</span>
            </div>
          </div>
          <div class="tli-onboard-cardmini" style="margin-top:12px">
            <div class="p">Explore the sidebar — Chat, Vault, Files, Devices, Mesh, and more. All settings are in the gear icon.</div>
          </div>
        `;
        statusEl.textContent = "";
        nextBtn.textContent = "Enter TLI";
        // Wire "Get AI" button — navigates to AI settings after dismissing
        document.getElementById("tli-onboard-ai-dl-now")?.addEventListener("click", () => {
          if (_aiPolling) { clearInterval(_aiPolling); _aiPolling = null; }
          tliStopAudio(audioEl);
          tliHideOnboard(true);
          // Navigate to Settings → AI after the overlay closes
          setTimeout(() => {
            const settingsBtn = document.querySelector("[data-panel='settings']") || document.getElementById("nav-settings");
            if (settingsBtn) settingsBtn.click();
          }, 150);
        });
      },
      onNext: async () => {
        if (_aiPolling) { clearInterval(_aiPolling); _aiPolling = null; }
        try {
          await fetch("/system/onboarding/complete", { method: "POST" });
        } catch {}
        tliHideOnboard(true);
        tliStopAudio(audioEl);
      },
    },
  ];

  function setProgress() {
    const pct = Math.round(((step + 1) / steps.length) * 100);
    barEl.style.width = pct + "%";
  }

  async function render() {
    const s = steps[step];
    setProgress();
    titleEl.textContent = s.title || "";
    textEl.textContent = s.text || "";
    dynEl.innerHTML = "";
    statusEl.textContent = "";
    statusEl.style.color = "";
    backBtn.disabled = step === 0;
    nextBtn.disabled = false;
    const out = s.build?.();
    if (out && typeof out.then === "function") await out;
  }

  async function goNext() {
    // Start intro audio on first Continue only (fire-and-fade, no await)
    if (!audioStarted && audioEl) {
      audioStarted = true;
      try {
        audioEl.muted = false;
        audioEl.volume = 0;
        audioEl.currentTime = 0;
        const target = volEl ? parseFloat(volEl.value || "0.22") : 0.22;
        const p = audioEl.play();
        if (p) p.catch(() => {});  // suppress unhandled rejection, don't await
        tliFadeInAudio(audioEl, isFinite(target) ? target : 0.22, 900);
        // Update play/pause button state
        const ppBtn = document.getElementById("tli-audio-playpause");
        if (ppBtn) ppBtn.dataset.playing = "1";
      } catch {}
    }

    nextBtn.disabled = true;
    const s = steps[step];
    try {
      if (s.onNext) await s.onNext();
    } catch {
      nextBtn.disabled = false;
      return; // onNext threw — validation failed, stay on step
    }
    nextBtn.disabled = false;

    if (step < steps.length - 1) {
      step += 1;
      await render();
    } else {
      tliHideOnboard(true);
    }
  }

  async function goBack() {
    if (_aiPolling) { clearInterval(_aiPolling); _aiPolling = null; }
    if (step > 0) {
      step -= 1;
      await render();
    }
  }

  nextBtn.addEventListener("click", goNext);
  backBtn.addEventListener("click", goBack);
  closeBtn.addEventListener("click", () => {
    if (_aiPolling) { clearInterval(_aiPolling); _aiPolling = null; }
    tliStopAudio(audioEl);
    tliHideOnboard(true);
  });

  // Allow force-reset from anywhere: TLI_resetOnboarding()
  window.TLI_resetOnboarding = () => {
    try {
      localStorage.setItem(TLI_FORCE_ONBOARD_KEY, "1");
      localStorage.removeItem(TLI_ONBOARD_SEEN_KEY);
    } catch {}
    location.reload();
  };

  tliShowOnboard();
  await render();
}

// Register FIRST so it runs before other DOMContentLoaded handlers in this file
document.addEventListener("DOMContentLoaded", () => {
  setupOnboardingWizard().catch(e => console.error("[TLI] Onboarding init failed:", e));
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

  // Swipe-down on drawer to close
  const drawer = document.getElementById("tli-more-drawer");
  if (drawer) {
    let startY = 0;
    drawer.addEventListener("touchstart", e => { startY = e.touches[0].clientY; }, { passive: true });
    drawer.addEventListener("touchend",   e => {
      if (e.changedTouches[0].clientY - startY > 60) _tliCloseMoreDrawer();
    }, { passive: true });
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

  function _applyTierToUI(tier, features) {
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

  // Expose for switchPanel locked-panel guard
  window._tliShowUpgradeModal = _showUpgradeModal;
})();

const TLI_VERSION        = "1.3.5-beta";
const DEFAULT_THEME      = "emeraldLight";
const previousPromptsKey = "tli_previous_prompts";

let currentDeviceId = null;        // filled from /status
const CHAT_HISTORY_DRAFT_ID = "__draft__";
let currentConversationId = null;  // tracks active conversation thread
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
  // ✅ Header single source-of-truth badge
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
  text.textContent = "AI: Off";
  pill.title = tip || "No AI provider available.";
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
// Probe LAN nodes for /tli/capabilities (best-effort; nodes may not implement yet)
async function refreshLanAI() {
  const roster =
    (window.MeshService && typeof window.MeshService.getRoster === "function")
      ? window.MeshService.getRoster()
      : [];

  const candidates = (roster || []).filter(n => n && n.ip && n.presence !== "offline");

  const found = [];
  for (const n of candidates) {
    const port = (typeof window.MeshService?._pickPort === "function")
      ? window.MeshService._pickPort(n)
      : 8000; // default
    const url = `http://${n.ip}:${port}/tli/capabilities`;

    try {
      const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } }, 900);
      if (!res.ok) continue;
      const caps = await res.json();

      const servesAI = !!(caps?.capabilities?.ai?.serve);
      if (!servesAI) continue;

      found.push({
        nodeId: caps.nodeId || n.id || n.ip,
        name: caps.name || n.name || n.id || n.ip,
        ip: n.ip,
        port,
        models: caps?.capabilities?.ai?.models || [],
        provider: caps?.capabilities?.ai?.provider || "tli-lan",
        streaming: !!caps?.capabilities?.ai?.streaming,
        health: "ok",
      });
    } catch {
      // ignore
    }
  }

  // If roster probe found nothing, fall back to the backend's mesh/status endpoint.
  // This covers the case where MeshService hasn't populated the roster yet on this node.
  if (!found.length) {
    try {
      const mr = await fetch("/api/ai/mesh/status", { signal: AbortSignal.timeout(3000) });
      if (mr.ok) {
        const md = await mr.json();
        if (md.available && md.peer) {
          const peer = md.peer;
          found.push({
            nodeId: peer.nodeId || peer.id || peer.ip,
            name:   peer.name  || peer.nodeId || peer.ip || "LAN node",
            ip:     peer.ip,
            port:   peer.port  || 8000,
            models: peer.models || [],
            provider: "tli-lan",
            streaming: false,
            health: "ok",
          });
        }
      }
    } catch {
      // ignore — best-effort
    }
  }

  AIStatus.lan.nodes = found;
  AIStatus.lan.available = found.length > 0;
  AIStatus.lan.lastCheckedMs = Date.now();
  return AIStatus.lan.available;
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
    AIStatus.resolved = { source: IntelligenceSource.NONE, node: null, reason: "Policy: LAN Only, but no LAN AI host detected." };
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

  AIStatus.resolved = { source: IntelligenceSource.NONE, node: null, reason: "No local AI and no LAN AI hosts detected." };
  setAIRoutePill(AIStatus.resolved.source, AIStatus.resolved.reason);
  return AIStatus.resolved;
}


// LAN AI chat request (protocol hook)
async function lanAiChat({ node, payload }) {
  if (!node?.ip) throw new Error("LAN AI node missing IP");
  const url = `http://${node.ip}:${node.port || 8000}/tli/ai/chat`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  }, 10_000);

  if (!res.ok) throw new Error("LAN AI HTTP " + res.status);
  return await res.json();
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
async function tliBundledChatStream({ message, raw_input, session_id, active_panel, max_tokens, temperature, image_b64, image_mime, onDelta, onMeta }) {
  // 1) Try POST streaming first (works when same-origin + POST allowed)
  try {
    const res = await fetch("/api/ai/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        message,
        raw_input: raw_input || "",
        session_id: session_id || null,
        active_panel: active_panel || null,
        max_tokens: max_tokens ?? 300,
        temperature: temperature ?? 0.2,
        image_b64: image_b64 || null,
        image_mime: image_mime || null,
      }),
    });

    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          for (const ln of block.split("\n")) {
            if (!ln.startsWith("data:")) continue;
            const dataStr = ln.slice(5).trim();
            if (!dataStr) continue;

            let obj = null;
            try { obj = JSON.parse(dataStr); } catch { obj = null; }
            if (!obj) continue;

            if (obj.type === "meta" && onMeta) onMeta(obj);
            if (obj.type === "delta" && onDelta) onDelta(obj.text || "");
          }
        }
      }
      return true;
    }

    // If server rejects POST (common: 405), fall through to GET/EventSource.
    if (res.status !== 405) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Bundled stream failed (${res.status}): ${txt}`);
    }
  } catch (e) {
    // swallow and try GET fallback below
  }

  // 2) GET fallback via EventSource (avoids POST/CORS/preflight issues)
  return await new Promise((resolve, reject) => {
    try {
      const qs = new URLSearchParams();
      qs.set("message", message || "");
      if (session_id) qs.set("session_id", session_id);
      qs.set("max_tokens", String(max_tokens ?? 300));
      qs.set("temperature", String(temperature ?? 0.2));

      const es = new EventSource("/api/ai/chat/stream?" + qs.toString());
      es.onmessage = (ev) => {
        if (!ev || !ev.data) return;
        let obj = null;
        try { obj = JSON.parse(ev.data); } catch { obj = null; }
        if (!obj) return;

        if (obj.type === "meta" && onMeta) onMeta(obj);
        if (obj.type === "delta" && onDelta) onDelta(obj.text || "");
        if (obj.type === "done") {
          try { es.close(); } catch {}
          resolve(true);
        }
      };
      es.onerror = () => {
        try { es.close(); } catch {}
        reject(new Error("Bundled SSE connection failed (EventSource)."));
      };
    } catch (err) {
      reject(err);
    }
  });
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
  const t = theme || DEFAULT_THEME;
  document.documentElement.setAttribute("data-theme", t);
  // Sync body.theme-dark for CSS components that target that class
  document.body.classList.toggle("theme-dark", !/(light|lite)/i.test(t));
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
  _currentPanelId = targetId;

  // Block navigation to locked (Pro-gated) panels — show upgrade modal instead
  const lockedBtn = document.querySelector(`[data-panel-target="${targetId}"].tli-nav-locked`);
  if (lockedBtn) {
    if (typeof window._tliShowUpgradeModal === "function") {
      window._tliShowUpgradeModal(null, "This panel requires a Pro license. Activate your key in Settings → License.");
    }
    return;
  }

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


// Games panel hook
if (targetId === "panel-games" && window.TLIGames && typeof window.TLIGames.onOpen === "function") {
  window.TLIGames.onOpen();
}


// Automations panel hook
if (targetId === "panel-automations" && window.TLIAutomations && typeof window.TLIAutomations.onOpen === "function") {
  window.TLIAutomations.onOpen();
}

// Devices panel: auto-load USB storage on every open so no manual Refresh needed
if (targetId === "panel-devices") {
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



// Navigate to the visualizer and immediately scan a path.
// Called by alert action buttons so the user lands on a pre-scanned result.
function switchPanelAndScan(panelId, path) {
  switchPanel(panelId);
  // Give the panel time to become visible before triggering the scan
  const attempt = (tries) => {
    if (window.TLIVisualizer && typeof window.TLIVisualizer.scanPath === "function") {
      window.TLIVisualizer.scanPath(path);
    } else if (tries > 0) {
      setTimeout(() => attempt(tries - 1), 150);
    }
  };
  setTimeout(() => attempt(10), 50);
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


// ---------- UI Mode (Classic vs Dashboard 2.0) ----------
const UI_MODE_KEY = "tli_ui_mode";
function getUiMode() {
  return "dash2"; // Dashboard is default landing panel
}
function setUiMode(mode) {
  const v = (mode || "").toLowerCase() === "dash2" ? "dash2" : "classic";
  localStorage.setItem(UI_MODE_KEY, v);
  return v;
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

function setupUiModeSelect() {
  const sel = document.getElementById("ui-mode-select");
  if (!sel) return;

  // initialize select value
  sel.value = getUiMode();

  sel.addEventListener("change", () => {
    const mode = setUiMode(sel.value);

    // Navigate immediately to the correct landing panel
    if (mode === "dash2") {
      const el = document.getElementById("panel-dashboard2");
      if (el) switchPanel("panel-dashboard2");
    } else {
      const el = document.getElementById("panel-main");
      if (el) switchPanel("panel-main");
    }
  });
}

// ---------- Dashboard toggle button (replaces UI dropdown visually; keeps it for compatibility) ----------
function setupDash2HeaderButton() {
  const btn  = document.getElementById("dash2-btn");
  const sel  = document.getElementById("ui-mode-select");
  const chip = document.getElementById("ui-mode-chip");
  if (!btn || !sel) return;

  // Hide the dropdown chip (but keep select in DOM so existing logic still works)
  try { if (chip) chip.style.display = "none"; } catch {}

  function sync() {
    const mode = getUiMode();
    btn.textContent = (mode === "dash2") ? "Classic View" : "Dashboard";
    btn.classList.toggle("is-dash2", mode === "dash2");
    btn.setAttribute("aria-pressed", mode === "dash2" ? "true" : "false");
  }

  btn.addEventListener("click", () => {
    const next = (getUiMode() === "dash2") ? "classic" : "dash2";
    sel.value = next;
    sel.dispatchEvent(new Event("change"));
    sync();
  });

  sel.addEventListener("change", sync);
  sync();
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
  let _lastCategory  = null;
  let _lastData      = null;   // cached from last _refresh()
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
        const devStr  = devCount > 0 ? `${devCount} device${devCount !== 1 ? "s" : ""} online` : "no smart devices";
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
          aiReady && devCount > 0 ? `Quiet on the home front. ${devCount} device${devCount !== 1 ? "s" : ""} online, AI ready.` : null,
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
          devCount > 1 ? `${devNames[devNames.length - 1]} and ${devCount - 1} other device${devCount > 2 ? "s" : ""} are online.` : null,
          `Your devices are named. TLI knows "${first}" — no IP addresses needed.`,
          `${list} — plain English works: "turn off ${first}", "is ${devNames[devNames.length - 1]} on?".`,
          `TLI has mapped ${devCount} smart plug${devCount !== 1 ? "s" : ""} to your LAN. ${first} is ready.`,
          devCount === 2 ? `Both ${devNames[0]} and ${devNames[1]} are registered. TLI can toggle them by name.` : null,
        ].filter(Boolean));
      },

      ai: () => pick(aiReady ? [
        `${nickname}'s AI runs 100% offline. Nothing you say ever leaves this network.`,
        `${aiLabel} can answer questions, write scripts, and control devices — no cloud required.`,
        "Ask TLI to write a PowerShell script. It generates real, runnable code you can save and schedule.",
        "Teaching Mode walks through the AI's reasoning step by step — great for learning or auditing.",
        "The AI remembers context within a session. Start a New Chat to reset its memory.",
        "Precision mode makes the AI more technical. Creative mode lets it think freely.",
        "Use [vault:key] in any chat message to inject a secret without typing it in the clear.",
        `${aiLabel} doesn't log your conversations. Privacy is the default.`,
        "You can ask the AI to explain any process, file, or network event — it answers from local context.",
        "The AI can draft scripts, explain errors, and suggest fixes — all without leaving your LAN.",
        "Ask the AI anything about this machine. It has access to tools, files, and device status.",
        `${aiLabel} works even without internet. Power cut to the router? AI still runs on ${nickname}.`,
        "Default mode balances speed and quality. Precision mode goes deeper. Creative mode roams free.",
        "Every reply stays on your hardware. No usage data is collected. No external servers are contacted.",
        "The AI can reference your Vault. Ask it to use [vault:key] and it will inject the secret safely.",
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
        "Vault stores secrets encrypted at rest. Use [vault:key] in any chat message to inject them.",
        "Nothing in the Vault ever leaves your network. Encrypted locally, always.",
        "Store API keys, passwords, and notes in Vault — reference them in chat with [vault:key].",
        "Vault entries are encrypted with your PIN. TLI locked = Vault locked.",
        "The Vault is zero-knowledge — the AI never sees the raw secret unless you explicitly inject it.",
        "Vault lets you keep secrets out of your chat history. [vault:key] injects them invisibly.",
        "Everything in Vault is AES-encrypted on disk. No plaintext is ever stored.",
        "You can store credentials, tokens, passphrases — and inject them into any AI prompt on demand.",
        "The Vault is always available offline. Your secrets don't need a cloud provider.",
        "Use Vault like a local 1Password — reference secrets in chat without exposing them.",
      ]),

      tip: () => pick([
        `Say "Remember that..." to teach TLI facts about ${nickname}. It stores them in local memory.`,
        "History saves every conversation. Tap History in chat to browse and resume past sessions.",
        "Advanced controls let you tune temperature and token limits per message.",
        "Use the Scripts panel to generate automations — PowerShell, Bash, or Python — and save them.",
        "TLI Chat lets mesh nodes send messages and files to each other with no cloud relay.",
        "The Tools panel runs one-click utilities: health check, top processes, printer scan, and more.",
        "LAN AI lets you offload inference to a more powerful machine on the same network.",
        `Home Automation responds to plain English — "Is the charger on?" or "Turn off the HDD."`,
        "Game Optimizer tweaks system settings for better gaming performance — all locally, instantly.",
        "File browser lets you explore this machine's directories and ask the AI to help organize them.",
        "Teaching Mode is great for clients — the AI explains every step like a patient instructor.",
        "The Abort button stops an AI response mid-stream. Useful if it goes off track.",
        "Start a New Chat to give the AI a clean context — no memory of previous messages.",
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
        "TLI's LAN AI mode routes inference to a stronger node on your network — automatically.",
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
    if (label) label.textContent = state === "good" ? "ONLINE" : state === "warn" ? "PARTIAL" : "OFFLINE";
  }

  // ── Live activity feed seeding ────────────────────────────────

  async function _seedFeed() {
    // 1. Action receipts (Shelly toggles, saved actions, etc.)
    try {
      const data = await fetch("/actions/receipts?limit=10", { signal: AbortSignal.timeout(4000) })
        .then(r => r.ok ? r.json() : null);
      const receipts = (data?.items || []).reverse(); // oldest first → insert in order
      receipts.forEach(r => {
        const key = "r:" + (r.ts || "") + "|" + (r.kind || "");
        if (_seenFeedIds.has(key)) return;
        _seenFeedIds.add(key);
        const label = r.summary || r.kind || "Action";
        _feedLog("⚡ " + label, "good", r.ts);
      });
    } catch {}

    // 2. Active alerts (disk, Shelly offline, mesh offline)
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
    if (_dashSse) return;
    try {
      _dashSse = new EventSource("/mesh/presence/stream");
      _dashSse.onmessage = e => {
        try {
          const evt = JSON.parse(e.data);
          if (evt.type === "node_online") {
            _feedLog(`${evt.name || evt.node_id || "Node"} joined the mesh`, "mesh");
          } else if (evt.type === "node_offline") {
            _feedLog(`${evt.name || evt.node_id || "Node"} went offline`, "warn");
          }
        } catch {}
      };
      _dashSse.onerror = () => { if (_dashSse) { _dashSse.close(); _dashSse = null; } };
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
      const dots = { info: "🟢", warning: "🟡", critical: "🔴" };
      const dot  = dots[msg.severity] || "";
      sevEl.textContent   = dot;
      sevEl.style.display = dot ? "" : "none";
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
    switchPanel("panel-main");
    const ci = document.getElementById("chat-input");
    if (ci) { ci.value = q; ci.focus(); }
  };

  function _renderActions(aiOk, devNames) {
    const el = _el("nd-actions");
    if (!el) return;
    const _dMount    = (_lastData?.diskData?.system?.mount) || (_tliIsWindows() ? "C:\\" : "/");
    const _dMountEsc = _dMount.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const actions = [
      { icon: "💬", label: "Ask TLI anything",             onclick: "switchPanel('panel-main'); document.getElementById('chat-input')?.focus();" },
      { icon: "🩺", label: "What's slowing me down?",      onclick: `window._tliDashChatAction("Run a full system health check — CPU, RAM, disk, and top processes.")` },
      { icon: "🌐", label: "Map this network",              onclick: `window._tliDashChatAction("Scan the local network and list all active LAN devices.")` },
      { icon: "📁", label: "Find what's filling my drive",  onclick: `switchPanelAndScan('panel-visualizer', '${_dMountEsc}')` },
      { icon: "🔑", label: "Open Vault",                    onclick: "switchPanel('panel-vault');" },
    ];
    if (devNames.length > 0) {
      actions.splice(3, 0, { icon: "🏠", label: "Control smart home", onclick: "switchPanel('panel-homeauto')" });
      const first = (devNames[0] || "").replace(/"/g, "");
      actions.splice(4, 0, { icon: "⚡", label: `Toggle ${first}`, onclick: `window._tliDashChatAction("Toggle ${first}")` });
    }
    if (!aiOk) {
      actions.push({ icon: "🤖", label: "Why is AI offline?", onclick: `window._tliDashChatAction("The AI model appears offline. Why might this happen and how do I fix it?")` });
    }
    el.style.cssText = "display:flex;flex-direction:column;gap:6px;padding-top:8px;";
    el.innerHTML = actions.map(a =>
      `<button class="chip-button" style="display:flex;width:100%;text-align:left;align-items:center;gap:8px;padding:7px 10px;" onclick="${a.onclick}">` +
      `<span style="flex-shrink:0;">${a.icon}</span><span>${a.label}</span></button>`
    ).join("");
  }

  // ── Quick Read findings ───────────────────────────────────────
  function _renderQuickRead(data) {
    const el = _el("nd-quickread");
    if (!el) return;
    const sys   = data.diskData?.system || data.diskData;
    const chips = [];

    if (sys?.ok) {
      const dMount   = sys.mount || (_tliIsWindows() ? "C:\\" : "/");
      const dEsc     = dMount.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const dAct     = `switchPanelAndScan('panel-visualizer', '${dEsc}')`;
      if (sys.pct >= 85)
        chips.push({ icon: "💾", text: `${sys.drive || "C:"} ${sys.pct}% full`, cls: "warn", action: dAct, label: "Clean Up" });
      else if (sys.pct >= 70)
        chips.push({ icon: "💾", text: `${sys.free_gb} GB free`, cls: "", action: dAct, label: "Browse" });
      else
        chips.push({ icon: "💾", text: "Storage healthy", cls: "ok" });
    }
    if (data.devCount > 0)
      chips.push({ icon: "🏠", text: `${data.devCount} device${data.devCount !== 1 ? "s" : ""} online`, cls: "ok" });
    if (data.aiOk || data.lmOnline)
      chips.push({ icon: "🧠", text: data.aiOk ? "AI ready" : "LM Studio", cls: "ok" });
    else
      chips.push({ icon: "🧠", text: "AI offline", cls: "warn", action: "switchPanel('panel-main')", label: "Start" });

    if (!chips.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = chips.map(c => {
      const mod  = (c.cls   ? ` nd-quickread__chip--${c.cls}` : "") + (c.action ? " nd-quickread__chip--action" : "");
      const act  = c.action ? ` onclick="${c.action}"` : "";
      const hint = c.label  ? `<span style="opacity:0.5;font-size:10px;margin-left:3px;">${c.label}&nbsp;›</span>` : "";
      return `<div class="nd-quickread__chip${mod}"${act}>${c.icon} ${c.text}${hint}</div>`;
    }).join("");
  }

  // ── Smart suggestions ─────────────────────────────────────────
  function _renderSuggestions(data) {
    const el = _el("nd-suggestions");
    if (!el) return;
    const sys   = data.diskData?.system || data.diskData;
    const chips = [];

    if (sys?.ok && sys.pct >= 70) {
      const dMount = sys.mount || (_tliIsWindows() ? "C:\\" : "/");
      const dEsc   = dMount.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      chips.push({ label: "Free up space", onclick: `switchPanelAndScan('panel-visualizer', '${dEsc}')` });
    }
    if (!data.aiOk && !data.lmOnline)
      chips.push({ label: "Start AI model", onclick: "switchPanel('panel-main')" });
    if (data.devCount === 0)
      chips.push({ label: "Add smart device", onclick: "switchPanel('panel-homeauto')" });
    if (data.meshSt === "unpaired")
      chips.push({ label: "Connect a peer", onclick: "switchPanel('panel-mesh')" });

    if (!chips.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<span class="nd-suggestions__label">Try</span>` +
      chips.map(c => `<button class="nd-sugg-chip" onclick="${c.onclick}">${c.label}</button>`).join("");
  }

  // ── Data refresh (every 30s) ──────────────────────────────────
  async function _refresh() {
    if (!_open) return;
    try {
      const [statusRes, devRes, aiRes, diskRes, alertsRes] = await Promise.allSettled([
        fetch("/status",                { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch("/homeauto/devices",      { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch("/api/ai/bundled/status", { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch("/api/system/disk",       { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch("/status/alerts",         { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
      ]);

      const status      = statusRes.status  === "fulfilled" ? statusRes.value  : null;
      const devData     = devRes.status     === "fulfilled" ? devRes.value     : null;
      const aiData      = aiRes.status      === "fulfilled" ? aiRes.value      : null;
      const diskData    = diskRes.status    === "fulfilled" ? diskRes.value    : null;
      const alertsData  = alertsRes.status  === "fulfilled" ? alertsRes.value  : null;
      const activeAlerts = (alertsData?.alerts || []).filter(a => !a.dismissed);

      const aiOk     = !!(aiData && (aiData.ok || aiData.healthy));
      const lmOnline = !!(status?.model_online);
      const devices  = Array.isArray(devData?.devices) ? devData.devices : [];
      const devNames = devices.map((d, i) => (d.name?.trim()) ? d.name.trim() : `Device ${i + 1}`);
      const devCount = devices.length;
      const nickname = status?.device_nickname || "TLI Node";
      const nodeRole = status?.node_role       || "standalone";
      const meshSt   = status?.mesh_status     || "unpaired";

      // Cache for Narrator statements
      _lastData = { aiOk, lmOnline, devNames, devCount, nickname, nodeRole, meshSt, diskData, activeAlerts };
      // Seed activity feed from backend events (fire-and-forget)
      _seedFeed();
      // Refresh mesh health strip (independent — may take up to 6s for peer pings)
      _refreshMeshStrip();

      // Vitals
      const meshLabel = meshSt === "unpaired" ? "Mesh: standalone" : `Mesh: ${meshSt}`;
      _setVital("node", nodeRole === "standalone" ? "Solo" : nodeRole, `${nickname} · ${meshLabel}`);
      const sysDrive = diskData?.system || diskData;
      const driveLabel = sysDrive?.drive || "C:";
      _setVital("storage",
        diskData?.ok ? `${sysDrive.pct}%` : "—",
        diskData?.ok ? `${driveLabel} · ${sysDrive.used_gb} GB used of ${sysDrive.total_gb} GB` : "Unavailable");
      _setVital("smart", devCount > 0 ? String(devCount) : "—",
                         devCount > 0 ? devNames.slice(0, 3).join(", ") + (devCount > 3 ? ` +${devCount - 3}` : "") : "No devices registered");
      _setVital("ai", aiOk ? "Bundled" : lmOnline ? "LM Studio" : "Offline",
                      aiOk ? "Local · offline-first" : lmOnline ? "LM Studio connected" : "No model running");

      const _overallGood = aiOk || lmOnline;
      _setOrb(_overallGood ? "good" : devCount > 0 ? "warn" : "idle");
      _setMeta(`${nickname} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      _renderActions(_overallGood, devNames);
      _renderQuickRead(_lastData);
      _renderSuggestions(_lastData);

      // Make storage vital tile clickable → opens visualizer at system drive
      const _svTile = document.getElementById("nd-storage-vital-tile");
      if (_svTile && diskData?.ok) {
        const _sMnt = sysDrive?.mount || (_tliIsWindows() ? "C:\\" : "/");
        _svTile.classList.add("nd-vital--clickable");
        _svTile.dataset.scanPath = _sMnt;
        _svTile.title = "Click to open Storage Visualizer";
        if (!_svTile._tliClickBound) {
          _svTile.addEventListener("click", function () {
            switchPanelAndScan("panel-visualizer", this.dataset.scanPath);
          });
          _svTile._tliClickBound = true;
        }
      }

      // Always log a state snapshot on each data refresh so the feed is never empty
      const _snapParts = [];
      if (devCount > 0) _snapParts.push(`${devCount} device${devCount !== 1 ? "s" : ""} online`);
      _snapParts.push(aiOk ? "AI bundled" : lmOnline ? "LM Studio" : "AI offline");
      if (diskData?.ok) _snapParts.push(`${driveLabel} ${diskData.pct}%`);
      _feedLog(_snapParts.join(" · ") + ".", _overallGood ? "good" : "warn");

    } catch (e) {
      _setOrb("idle");
      _setMeta("Backend unreachable");
      _feedLog("Backend unreachable — check the server.", "error");
    }
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
      const offline  = !n.online;
      const name     = n.node_name || n.hostname || "Unknown";
      const cpu      = typeof n.cpu_percent === "number" ? Math.round(n.cpu_percent) : null;
      const ram      = typeof n.ram_percent  === "number" ? Math.round(n.ram_percent)  : null;
      const aiOk     = n.ai_healthy;
      const aiModel  = n.active_model || (n.active_preset ? n.active_preset : null);
      const cpuWarn  = cpu !== null && cpu >= 80;

      const cpuStat  = cpu !== null
        ? `<span class="nd-mesh-node__stat${cpuWarn ? " nd-mesh-node__stat--warn" : ""}">CPU ${cpu}%</span>`
        : "";
      const ramStat  = ram !== null
        ? `<span class="nd-mesh-node__stat">RAM ${ram}%</span>`
        : "";
      const aiStat   = aiOk
        ? `<span class="nd-mesh-node__stat nd-mesh-node__stat--ai">AI ${aiModel ? "· " + aiModel : "✓"}</span>`
        : `<span class="nd-mesh-node__stat nd-mesh-node__stat--ai-off">AI offline</span>`;
      const selfTag  = n.is_self
        ? `<span class="nd-mesh-node__self">This device</span>`
        : "";
      const offlineTag = offline && !n.is_self
        ? `<span class="nd-mesh-node__stat">Offline</span>`
        : "";

      return `<div class="nd-mesh-node${offline && !n.is_self ? " nd-mesh-node--offline" : ""}">
        <div class="nd-mesh-node__dot"></div>
        <div class="nd-mesh-node__name">${name.replace(/</g,"&lt;")}</div>
        ${selfTag}
        <div class="nd-mesh-node__stats">
          ${cpuStat}${ramStat}${offline && !n.is_self ? offlineTag : aiStat}
        </div>
      </div>`;
    }).join("");
  }

  async function _refreshMeshStrip() {
    try {
      const data = await fetch("/api/mesh/health", { signal: AbortSignal.timeout(6000) })
        .then(r => r.ok ? r.json() : null);
      if (data?.nodes?.length) _renderMeshStrip(data.nodes);
    } catch {}
  }

  // ── Public API ────────────────────────────────────────────────
  function onOpen() {
    if (_open) return;
    _open = true;
    // v1.3: First-launch placeholder while data loads
    _typeText("I'm reading your environment.");
    _startDashSSE();
    _refresh().then(() => {
      // First statement immediately after data loads
      _narratorNext();
      // Then cycle every 9 seconds
      _cycleTimer = setInterval(_narratorNext, 9_000);
    });
    // Data refresh every 30s
    _pollTimer = setInterval(_refresh, 30_000);
  }

  function onClose() {
    _open = false;
    _stopDashSSE();
    if (_pollTimer)  { clearInterval(_pollTimer);  _pollTimer  = null; }
    if (_cycleTimer) { clearInterval(_cycleTimer); _cycleTimer = null; }
    if (_typeTimer)  { clearInterval(_typeTimer);  _typeTimer  = null; }
    if (_tipTimer)   { clearInterval(_tipTimer);   _tipTimer   = null; }
  }

  // ── v1.3: Event-driven narrator override ────────────────────────────────
  // Called by EventInterpreter via window.TLIDash2.setEventMessage(msg)
  // msg: { type: "status"|"alert"|"action_prompt"|"confirmation", text: string }
  let _eventOverrideTimer = null;
  function setEventMessage(msg) {
    if (!msg || !msg.text) return;

    // Map backend narrator type → internal type + severity
    const typeMap = {
      status:         { type: "GUIDANCE",  severity: "info"     },
      alert:          { type: "AWARENESS", severity: "warning"  },
      action_prompt:  { type: "ACTION_PROMPT", severity: "info" },
      confirmation:   { type: "CONFIRMATION",  severity: "info" },
    };
    const mapped = typeMap[msg.type] || { type: "GUIDANCE", severity: "info" };

    const stmt = _el("nd-statement");
    if (stmt) { stmt.style.opacity = "0"; stmt.style.transition = "opacity 0.35s"; }

    setTimeout(function () {
      if (!_open) return;
      _typeText(msg.text);
      _setNarratorCard({ text: msg.text, type: mapped.type, severity: mapped.severity });
      if (stmt) { stmt.style.opacity = "1"; }

      // Apply data-narrator-type for CSS styling
      const narratorEl = _el("nd-narrator");
      if (narratorEl) narratorEl.dataset.narratorType = msg.type || "status";

      // For "confirmation" type: fade back to normal after 8s
      if (msg.type === "confirmation") {
        if (_eventOverrideTimer) clearTimeout(_eventOverrideTimer);
        _eventOverrideTimer = setTimeout(function () {
          if (!_open) return;
          if (narratorEl) narratorEl.dataset.narratorType = "status";
          _narratorNext();
        }, 8_000);
      }
    }, 380);
  }

  return { onOpen, onClose, setEventMessage };
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
  if (!input || !sendBtn || !abortBtn) return;

  let rawText = (input.value || "").trim();
  // Allow send with no text if an image is attached — default prompt
  if (!rawText && _chatImageB64) rawText = "What's in this image?";
  if (!rawText) return;
  input.value = "";

  // Capture image preview URL immediately — before any async code can touch state
  const _previewDataUrl = _chatImageB64
    ? `data:${_chatImageMime || "image/jpeg"};base64,${_chatImageB64}`
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

// Gate unless explicitly bypassed (e.g., user clicked "Answer Offline" or "Search + Answer")
const __bypassGate = !!window.__tliSearchGateBypassOnce;
window.__tliSearchGateBypassOnce = false;

try {
  if (!__bypassGate && tliSearchIsEnabled() && tliShouldGateForSearch(rawText)) {
    // Show banner and wait. Do NOT send to model yet.
    tliShowSearchBannerFor(rawText);
    return;
  }
} catch (e) {
  // If gating fails for any reason, fail open (offline) to preserve chat usability.
}

// Instant render: user bubble + thinking bubble (before async AI route resolution)
appendMessage("user", rawText, _previewDataUrl ? { imageDataUrl: _previewDataUrl } : {});
const thinkingBubble = appendMessage("ai", "Thinking… please give me a moment while your offline AI processes this.", { thinking: true });

// 🧭 Decide where intelligence comes from (Local > LAN > None)
let __aiRoute = null;
try { __aiRoute = await resolveIntelligenceRoute({ forceRefresh: false }); } catch {}

// If LAN AI is selected, try it first (best-effort). If it fails, fall through to local /chat.
if (__aiRoute && __aiRoute.source === IntelligenceSource.LAN_LLM && __aiRoute.node) {
  try {
    debugLog("info", `AI route=LAN → ${__aiRoute.node.name} (${__aiRoute.node.ip})`);
    const payload = {
      requestId: "req-" + Math.random().toString(16).slice(2),
      fromNodeId: (currentNodeConfig?.node_id || currentNodeConfig?.device_id || currentDeviceId || "dev-browser"),
      sessionId: currentConversationId || null,
      model: (__aiRoute.node.models && __aiRoute.node.models[0]) ? __aiRoute.node.models[0] : null,
      messages: (function(){
        const sys = { role: "system", content: buildSystemInstruction({ teachingMode: isTeachingMode(), mode: ($("mode-select")?.value || "default") }) };
        const turns = (chatHistory || []).slice(-CHAT_CTX_MAX_TURNS).map(m => ({ role: m.role, content: m.content }));
        turns.push({ role: "user", content: rawText });
        return [sys, ...turns].slice(-(CHAT_CTX_MAX_TURNS + 6));
      })()
    };

    const lanData = await lanAiChat({ node: __aiRoute.node, payload });
    let reply = lanData?.message?.content || lanData?.reply || lanData?.answer || "(No reply from LAN AI)";
    reply = formatModelOutput(reply, $("mode-select")?.value || "default");

    if (thinkingBubble) {
      thinkingBubble.innerHTML = reply;
      thinkingBubble.classList.remove("chat-bubble-thinking");
    }
    chatHistoryAdd("user", rawText);
    chatHistoryAdd("assistant", reply);

    try { saveConversation(rawText, reply, currentConversationId); } catch {}
    try { addPreviousPrompt(rawText); } catch {}

    // Reset UI controls
    sendBtn.disabled = false;
    abortBtn.disabled = true;
    return;
  } catch (e) {
    debugLog("warn", "LAN AI failed, falling back to local: " + (e?.message || e));
  }
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
  if (now - lastSendTs < 250) return;
  lastSendTs = now;

  const storedSettings = readSettings() || {};
  const brain = storedSettings.defaultBrain || "auto";
  const mode          = $("mode-select").value || "default";
  const teachingMode  = isTeachingMode();
  const temperature   = parseFloat($("temperature-input").value || "0.7");
  const maxTokens     = parseInt($("max-tokens-input").value || "768", 10);

  // Conversation memory (store cleaned text for the model)
  // (user message already rendered instantly above)
  // Keep model context consistent
  // NOTE: we store rawText in chat history to preserve user intent exactly.
  if (thinkingBubble) {
    thinkingBubble.textContent = "Thinking… please give me a moment while your offline AI processes this.";
  }

  // lock buttons + show generic “thinking” status
  sendBtn.disabled = true;
  abortBtn.disabled = false;
  setModelStatus(true, "Model server: thinking…");

  // 🔹 NEW: Shelly intent fast-path (skip LLM entirely)
  const shellyIntent = detectShellyIntent(text);
  if (shellyIntent) {
    debugLog(
      "info",
      `Shelly intent from chat: action=${shellyIntent.action}, name="${shellyIntent.name}"`
    );

    // Make it obvious this is local control, not the model
    setModelStatus(true, "Local control: Shelly plug");

    try {
      await handleShellyIntent(shellyIntent, thinkingBubble, rawText);
      // Persist assistant reply from the Shelly fast-path into conversation memory
      try {
        const txt = (thinkingBubble && thinkingBubble.textContent) ? thinkingBubble.textContent : "";
        if (txt && !/thinking/i.test(txt)) chatHistoryAdd("assistant", txt);
      } catch {}
    } catch (err) {
      // Very defensive; handleShellyIntent already has its own try/catch
      thinkingBubble.textContent =
        "Shelly control failed: " + (err?.message || "unknown error");
      thinkingBubble.classList.remove("chat-bubble-thinking");
      showToast("Shelly control failed.", "error");
      debugLog("error", "Shelly intent outer error: " + err.message);
    } finally {
      sendBtn.disabled = false;
      abortBtn.disabled = true;
      inFlightController = null;
    }

    // ⬅️ IMPORTANT: do *not* call /chat; Shelly path ends here
    return;
  }

  // 🔹 Normal LLM path (unchanged)
  debugLog(
    "info",
    `POST /chat brain=${brain} mode=${mode} teaching=${teachingMode} temp=${temperature} max=${maxTokens} secrets=[${secretKeys.join(
      ", "
    )}]`
  );

  try {
    inFlightController = new AbortController();
    // Choose endpoint:
// - If Bundled AI is healthy, use /api/ai/chat (fast, offline, no LM Studio).
// - Otherwise fall back to legacy /chat routing (LM Studio / Mesh).
let useBundled = false;
try {
  const st = await tliFetchBundledStatus();
  useBundled = !!(st && st.ok === true);
  AIStatus.local.provider = useBundled ? "bundled" : (AIStatus.local.provider || "lmstudio");
  AIStatus.local.available = useBundled;
} catch {}

// If a LAN AI peer is available but local bundled AI is off, force the /api/ai/chat
// path anyway — the backend already has mesh routing built in and will proxy to the peer.
if (!useBundled && AIStatus.lan.available) {
  useBundled = true;
}

const endpoint = useBundled ? "/api/ai/chat" : "/chat";

// ✅ Bundled AI: use SSE streaming for instant partial output
if (useBundled) {
  const wrapped = buildContextWrappedMessage({ latestUserMessage: text, teachingMode: teachingMode, mode: mode });
  // Capture and clear image before send
  const sentImageB64  = _chatImageB64;
  const sentImageMime = _chatImageMime;
  _clearChatImage();

  let acc = "";
  // reuse the existing thinking bubble created above
  try { if (thinkingBubble) thinkingBubble.innerHTML = ""; } catch {}

  try {
  await tliBundledChatStream({
      message: wrapped,
      raw_input: text,
      session_id: currentConversationId || null,
      active_panel: _currentPanelId || null,
      max_tokens: maxTokens,
      temperature: temperature,
      image_b64: sentImageB64 || null,
      image_mime: sentImageMime || null,
      onMeta: (m) => {
        try { currentConversationId = m.session_id || currentConversationId; } catch {}
        // If this response is being served by a mesh peer, update the AI pill live
        if (m.handled_by === "mesh" && m.mesh_node) {
          try {
            const peerName = m.mesh_node.name || m.mesh_node.ip || "Mesh";
            const preset = m.mesh_node.preset ? ` (${m.mesh_node.preset})` : "";
            const setPill = window.__tliSetAIPill;
            if (typeof setPill === "function") {
              setPill(`Mesh AI · ${peerName}`, "ok", `AI routed to ${peerName}${preset} via mesh`);
            } else {
              const t = document.getElementById("ai-source-text");
              if (t) t.textContent = `Mesh AI · ${peerName}`;
            }
          } catch {}
        }
      },
      onDelta: (chunk) => {
        if (!chunk) return;
        acc += chunk;
        try {
          if (thinkingBubble) {
            thinkingBubble.classList.remove("chat-bubble-thinking");
            thinkingBubble.innerHTML = renderAssistantHTML(acc); _attachSpeakBtn(thinkingBubble, acc);
          }
        } catch {}
      },
    });
  
    // finalize
} catch (e) {
  // Fallback to non-streaming bundled endpoint
  const wrappedMsg = buildContextWrappedMessage({ latestUserMessage: text, teachingMode: teachingMode, mode: mode });
  const r = await fetch('/api/ai/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: wrappedMsg, raw_input: text, session_id: currentConversationId || null, max_tokens: maxTokens, temperature: temperature }) });
  if (!r.ok) { const t = await r.text().catch(()=> ''); throw new Error('Bundled chat failed ('+r.status+'): '+t); }
  const j = await r.json();
  currentConversationId = j.session_id || currentConversationId;
  acc = (j.reply || '').toString();
  try { if (thinkingBubble) { thinkingBubble.classList.remove('chat-bubble-thinking'); thinkingBubble.innerHTML = renderAssistantHTML(acc); _attachSpeakBtn(thinkingBubble, acc); } } catch {}
  try { chatHistoryAdd('assistant', acc); } catch {}
  try { if (acc) tliSpeak(acc); } catch {}
  return;
}

// finalize
  try {
    if (thinkingBubble) thinkingBubble.classList.remove("chat-bubble-thinking");
  } catch {}
  try { chatHistoryAdd("assistant", acc); } catch {}
  try { if (acc) tliSpeak(acc); } catch {}
  return;
}


const res = await fetch(endpoint, {

      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: inFlightController.signal,
      body: JSON.stringify({
        device_id: currentDeviceId || "dev-browser",
        message: buildContextWrappedMessage({ latestUserMessage: text, teachingMode: teachingMode, mode: mode }),                    // cleaned text without [vault:.] markers
        brain,
        mode,
        teaching_mode: teachingMode,
        temperature,
        max_tokens: maxTokens,
        session_id: (useBundled ? (currentConversationId || null) : null),
        conversation_id: currentConversationId || null,
        include_vault_secrets: secretKeys.length > 0,         // vault hook
        secret_keys: secretKeys.length ? secretKeys : null    // vault hook
      })
    });
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const j = await res.json();
        detail = j.detail ? ("HTTP " + res.status + ": " + j.detail) : detail;
      } catch {}
      debugLog("error", "POST /chat failed: " + detail);
      throw new Error(detail);
    }
    const data  = await res.json();
let reply = data.reply || data.answer || "(No reply from model)";

// 🔹 Apply response formatting based on Mode dropdown (default / concise / step / dev)
reply = formatModelOutput(reply, mode);


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

thinkingBubble.textContent = reply;
    thinkingBubble.classList.remove("chat-bubble-thinking");
    try { chatHistoryAdd("assistant", reply); } catch {}

    try { saveConversation(text, reply, currentConversationId); } catch {}
    try { addPreviousPrompt(text); } catch {}

    setModelStatus(true, "Model server: Online");
    debugLog(
      "info",
      "POST /chat OK, conversation_id=" +
        (data.conversation_id || "none") +
        ", reply_length=" +
        reply.length
    );
  } catch (err) {
    if (err.name === "AbortError") {
      thinkingBubble.textContent = "Request cancelled.";
      thinkingBubble.classList.remove("chat-bubble-thinking");
      setModelStatus(true, "Model server: Online");
      debugLog("warn", "POST /chat aborted by user.");
    } else {
      const hint = err.message.includes("503") || err.message.includes("unavailable")
        ? "No AI available. Download your AI model in Settings → AI."
        : err.message.includes("401")
        ? "Session expired. Unlock TLI to continue."
        : "Error: " + err.message + " — check Tools → Model Health for details.";
      thinkingBubble.textContent = hint;
      thinkingBubble.classList.remove("chat-bubble-thinking");
      setModelStatus(false, "Model server: error");
      debugLog("error", "POST /chat error: " + err.message);
    }
  } finally {
    sendBtn.disabled = false;
    abortBtn.disabled = true;
    inFlightController = null;
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
    if (info.exists) { banner.classList.add("hidden"); return; }
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
          if (subEl)   subEl.textContent   = `${peerName} is running AI on your LAN — your messages will be routed there automatically.`;
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
    if (titleEl) titleEl.textContent = "No AI downloaded";
    if (subEl)   subEl.textContent   = "Download Qwen2.5 to start chatting — runs 100% on your machine, no internet after download.";
    if (btnEl)   { btnEl.textContent = "Download Qwen2.5"; delete btnEl.dataset.tliMeshMode; }
    banner.classList.remove("hidden");
  } catch {
    banner.classList.add("hidden");
  }
}

// ── Image attach state ──────────────────────────────────────────────────
let _chatImageB64 = null;
let _chatImageMime = null;

function _clearChatImage() {
  _chatImageB64 = null;
  _chatImageMime = null;
  const preview = $("chat-image-preview");
  const thumb   = $("chat-image-thumb");
  const attachBtn = $("chat-attach-btn");
  if (preview) preview.classList.add("hidden");
  if (thumb)   thumb.src = "";
  if (attachBtn) attachBtn.classList.remove("has-image");
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
  const imagePreview = $("chat-image-preview");
  const imageThumb   = $("chat-image-thumb");
  const removeBtn    = $("chat-image-remove");

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      _chatImageMime = file.type || "image/jpeg";
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        // strip the data:...;base64, prefix
        _chatImageB64 = dataUrl.split(",")[1] || null;
        if (imageThumb)   imageThumb.src = dataUrl;
        if (imagePreview) imagePreview.classList.remove("hidden");
        attachBtn.classList.add("has-image");
      };
      reader.readAsDataURL(file);
      fileInput.value = ""; // reset so same file can be re-selected
    });
  }
  if (removeBtn) removeBtn.addEventListener("click", _clearChatImage);

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
      const overlay = $("model-manager-modal-overlay");
      if (overlay) {
        overlay.classList.remove("hidden");
        overlay.setAttribute("aria-hidden", "false");
        if (typeof window.openModelManager === "function") window.openModelManager();
      }
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
    currentConversationId = null;
    resetChatHistory({ alsoClearStorage: true });
    clearChatWithPlaceholder("New chat started. Ask anything.");
  });
  abortBtn.addEventListener("click", () => {
    if (inFlightController) inFlightController.abort();
  });

  // ── Recent chats buttons ─────────────────────────────────────────
  const rcRefresh = $("recent-chats-refresh");
  if (rcRefresh) rcRefresh.addEventListener("click", loadPreviousPrompts);

  const rcClear = $("recent-chats-clear");
  if (rcClear) rcClear.addEventListener("click", async () => {
    if (!confirm("Clear all chat history? This cannot be undone.")) return;
    try {
      await fetch("/api/ai/conversations", { method: "DELETE" });
      currentConversationId = null;
      if (typeof clearChatWithPlaceholder === "function") clearChatWithPlaceholder("Chat history cleared.");
      loadPreviousPrompts();
    } catch (e) {
      if (typeof showToast === "function") showToast("Could not clear history.", "warn");
    }
  });

  // ── Voice input (mic button) ─────────────────────────────────────
  _setupVoiceInput();

  // ── TTS toggle ───────────────────────────────────────────────────
  _setupTTSToggle();
}


// ==================================================================
//  Voice Input — Web Speech API (SpeechRecognition)
// ==================================================================

let _micActive = false;
let _speechRec = null;

function _setupVoiceInput() {
  const micBtn = $("chat-mic-btn");
  const chatInput = $("chat-input");
  if (!micBtn) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.classList.add("unsupported");
    micBtn.title = "Voice input not supported in this browser (use Chrome or Edge)";
    return;
  }

  _speechRec = new SpeechRecognition();
  _speechRec.continuous = false;
  _speechRec.interimResults = true;
  _speechRec.lang = "en-US";

  let _interimSpan = null;

  _speechRec.onstart = () => {
    _micActive = true;
    micBtn.classList.add("recording");
    micBtn.title = "Listening… click to stop";
    // placeholder to show interim text
    _interimSpan = document.createElement("span");
    _interimSpan.style.opacity = "0.5";
    _interimSpan.style.fontStyle = "italic";
    if (chatInput) chatInput.parentNode.insertBefore(_interimSpan, chatInput.nextSibling);
  };

  _speechRec.onresult = (e) => {
    let interim = "", final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (_interimSpan) _interimSpan.textContent = interim ? `"${interim}"` : "";
    if (final && chatInput) {
      chatInput.value = (chatInput.value ? chatInput.value + " " : "") + final.trim();
      chatInput.dispatchEvent(new Event("input"));
    }
  };

  _speechRec.onend = () => {
    _micActive = false;
    micBtn.classList.remove("recording");
    micBtn.title = "Voice input";
    if (_interimSpan) { _interimSpan.remove(); _interimSpan = null; }
  };

  _speechRec.onerror = (e) => {
    _micActive = false;
    micBtn.classList.remove("recording");
    micBtn.title = "Voice input";
    if (_interimSpan) { _interimSpan.remove(); _interimSpan = null; }
    if (e.error === "not-allowed") {
      const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
      const msg = isLocalhost
        ? "Microphone access denied. Click the lock icon in your browser address bar and allow microphone."
        : "Microphone requires HTTPS on LAN. Access TLI via https:// or use http://localhost:8000 on this machine.";
      if (typeof showToast === "function") showToast(msg, "warn");
    } else if (e.error !== "aborted" && e.error !== "no-speech") {
      if (typeof showToast === "function") showToast(`Mic error: ${e.error}`, "warn");
    }
  };

  micBtn.addEventListener("click", () => {
    if (_micActive) {
      _speechRec.stop();
    } else {
      try { _speechRec.start(); }
      catch (err) { if (typeof showToast === "function") showToast("Could not start microphone.", "warn"); }
    }
  });
}


// ==================================================================
//  TTS — Web Speech Synthesis
// ==================================================================

let _ttsEnabled = false;
try { _ttsEnabled = localStorage.getItem("tli_tts_enabled") === "1"; } catch {}

let _ttsVoice = null;

function _setupTTSToggle() {
  const btn = $("tts-toggle");
  const voiceSel = $("tts-voice-select");
  if (!btn) return;

  const hasTTS = "speechSynthesis" in window;
  if (!hasTTS) { btn.style.display = "none"; return; }

  function _applyState() {
    btn.classList.toggle("active", _ttsEnabled);
    const dot = btn.querySelector(".toggle-pill-dot");
    if (dot) dot.style.background = _ttsEnabled ? "var(--accent)" : "";
    if (voiceSel) voiceSel.classList.toggle("hidden", !_ttsEnabled);
  }

  function _populateVoices() {
    if (!voiceSel) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    const saved = localStorage.getItem("tli_tts_voice") || "";
    voiceSel.innerHTML = voices.map((v, i) => {
      const label = `${v.name} (${v.lang})`;
      const sel = saved ? v.name === saved : v.default;
      return `<option value="${v.name}" ${sel ? "selected" : ""}>${label}</option>`;
    }).join("");
    // restore saved voice object
    _ttsVoice = voices.find(v => v.name === (saved || null)) || voices.find(v => v.default) || voices[0];
  }

  window.speechSynthesis.addEventListener("voiceschanged", _populateVoices);
  _populateVoices();

  if (voiceSel) {
    voiceSel.addEventListener("change", () => {
      const voices = window.speechSynthesis.getVoices();
      _ttsVoice = voices.find(v => v.name === voiceSel.value) || null;
      try { localStorage.setItem("tli_tts_voice", voiceSel.value); } catch {}
    });
  }

  _applyState();

  btn.addEventListener("click", () => {
    _ttsEnabled = !_ttsEnabled;
    try { localStorage.setItem("tli_tts_enabled", _ttsEnabled ? "1" : "0"); } catch {}
    if (!_ttsEnabled) window.speechSynthesis.cancel();
    _applyState();
  });
}

function _attachSpeakBtn(bubble, rawText) {
  if (!bubble || !("speechSynthesis" in window)) return;
  bubble.querySelectorAll(".chat-bubble-speak").forEach(b => b.remove());
  const speakBtn = document.createElement("button");
  speakBtn.className = "chat-bubble-speak";
  speakBtn.textContent = "▶";
  speakBtn.title = "Read aloud";
  speakBtn.addEventListener("click", () => tliSpeakBubble(speakBtn, rawText));
  bubble.appendChild(speakBtn);
}

function tliSpeak(text) {
  if (!_ttsEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  // Strip markdown syntax before speaking
  const clean = text
    .replace(/```[\s\S]*?```/g, "code block omitted")
    .replace(/`[^`]+`/g, m => m.slice(1, -1))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/#+\s*/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .trim();
  if (!clean) return;
  const utt = new SpeechSynthesisUtterance(clean);
  utt.rate = 1.0;
  utt.pitch = 1.0;
  if (_ttsVoice) utt.voice = _ttsVoice;
  window.speechSynthesis.speak(utt);
}

function tliSpeakBubble(btn, text) {
  if (!("speechSynthesis" in window)) return;
  if (btn.classList.contains("speaking")) {
    window.speechSynthesis.cancel();
    btn.classList.remove("speaking");
    btn.textContent = "▶";
    return;
  }
  window.speechSynthesis.cancel();
  document.querySelectorAll(".chat-bubble-speak.speaking").forEach(b => {
    b.classList.remove("speaking"); b.textContent = "▶";
  });
  btn.classList.add("speaking");
  btn.textContent = "■";
  const clean = text
    .replace(/```[\s\S]*?```/g, "code block omitted")
    .replace(/`[^`]+`/g, m => m.slice(1, -1))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/#+\s*/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .trim();
  const utt = new SpeechSynthesisUtterance(clean);
  utt.rate = 1.0;
  if (_ttsVoice) utt.voice = _ttsVoice;
  utt.onend = utt.onerror = () => {
    btn.classList.remove("speaking"); btn.textContent = "▶";
  };
  window.speechSynthesis.speak(utt);
}

// ---------- recent chats ----------
async function loadPreviousPrompts() {
  const listEl = $("recent-chats-list");
  if (!listEl) return;
  listEl.innerHTML = `<div class="small-meta">Loading…</div>`;
  try {
    const r = await fetch("/api/ai/conversations", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const { conversations } = await r.json();
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
      btn.innerHTML = `<span class="rc-title">${title}</span><span class="rc-meta">${turns}</span>`;
      btn.title = "Resume: " + title;
      btn.addEventListener("click", () => loadConversation(c.id, title));
      listEl.appendChild(btn);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="small-meta">Could not load chats.</div>`;
  }
}

async function loadConversation(convId, title) {
  try {
    const r = await fetch(`/api/ai/conversations/${convId}`);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const conv = await r.json();
    // Set as active conversation
    currentConversationId = convId;
    // Render messages
    const output = $("chat-output");
    if (output) {
      output.innerHTML = "";
      (conv.messages || []).forEach(m => {
        appendMessage(m.role === "user" ? "user" : "ai", m.content);
      });
    }
    // Focus input
    const input = $("chat-input");
    if (input) input.focus();
    if (typeof showToast === "function") showToast(`Resumed: ${title}`, "info");
  } catch (e) {
    if (typeof showToast === "function") showToast("Could not load conversation.", "warn");
  }
}

function addPreviousPrompt(_text) {
  // Refresh the list after a new message so the latest chat appears
  setTimeout(loadPreviousPrompts, 800);
}

// ---------- status ----------
async function refreshStatus() {
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

if (data.device_nickname) {
  $("device-name-chip").textContent = data.device_nickname;
  $("footer-device").textContent    = data.device_nickname;

  // NEW: update Visualizer device pill, if present
  const visTag = $("visualizer-device-tag");
  if (visTag) {
    visTag.textContent = "Device: " + data.device_nickname;
  }

  // NEW: update Tools device pill, if present
  const toolsTag = $("tools-device-tag");
  if (toolsTag) {
    toolsTag.textContent = "Device: " + data.device_nickname;
  }
}

if (data.device_id) currentDeviceId = data.device_id;


    const vaultStatus = data.vault_status || {};
    updateVaultUIFromStatus(vaultStatus);

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
  const btn    = $("rename-device-btn");
  const nameEl = $("device-name-chip");
  if (!btn || !nameEl) return;

  let _editing = false;

  function startEdit() {
    if (_editing) return;
    _editing = true;

    const current = nameEl.textContent.trim() || "Device";
    const input = document.createElement("input");
    input.type      = "text";
    input.value     = current;
    input.maxLength = 32;
    input.className = "device-chip-edit";
    input.setAttribute("aria-label", "Device name");

    nameEl.style.display = "none";
    nameEl.insertAdjacentElement("afterend", input);
    btn.textContent = "Save";
    input.focus();
    input.select();

    async function save() {
      const name = input.value.trim();
      cancel(name || current);
      if (!name || name === current) return;
      try {
        await fetch("/device/nickname", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: name }),
        });
        // Also update the mesh node name so other nodes see it
        await fetch("/mesh/node/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_name: name }),
        });
      } catch (err) {
        debugLog("warn", "device rename save failed: " + err.message);
      }
    }

    function cancel(finalName) {
      _editing = false;
      input.remove();
      nameEl.style.display = "";
      if (finalName) {
        nameEl.textContent           = finalName;
        $("footer-device").textContent = finalName;
      }
      btn.textContent = "Rename";
      btn.onclick     = null;
      btn.addEventListener("click", startEdit, { once: true });
    }

    input.addEventListener("keydown", e => {
      if (e.key === "Enter")  { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => { if (_editing) cancel(); });
    btn.onclick = (e) => { e.stopPropagation(); save(); };
  }

  btn.addEventListener("click", startEdit, { once: true });
  nameEl.addEventListener("dblclick", startEdit);
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

  // Populate label from device name chip
  const chipName = document.getElementById("device-name-chip");
  if (chipName && label) label.textContent = chipName.textContent.trim() || "This Node";

  async function refreshSwitcher() {
    try {
      const dir = await fetch("/mesh/directory", { cache: "no-store" }).then(r => r.json());
      const devices = Array.isArray(dir.devices) ? dir.devices : [];
      const thisId = dir.this_device_id || "";

      if (devices.length <= 1) {
        // Only self — no peers yet
        items.innerHTML = '<div class="node-switcher-empty">No other nodes on LAN yet</div>';
        return;
      }

      const now = Date.now();
      const ONLINE_MS = 90 * 1000;
      items.innerHTML = devices.map(d => {
        const name = d.display_name || d.device_id || "Node";
        const ip = d.ip || "";
        const port = d.tli_port || 8000;
        const isSelf = d.device_id === thisId;
        const lastSeen = d.last_seen ? new Date(d.last_seen).getTime() : 0;
        const isOnline = d.is_host || (lastSeen && (now - lastSeen) < ONLINE_MS);
        const url = ip ? `http://${ip}:${port}` : null;

        if (isSelf) {
          return `<div class="node-switcher-item node-switcher-item--self" role="menuitem">
            <span class="node-switcher-item-dot node-switcher-item-dot--self"></span>
            <span class="node-switcher-item-name">${escapeHtml(String(name))}</span>
            <span class="node-switcher-item-badge">Here</span>
          </div>`;
        }
        if (!url) {
          return `<div class="node-switcher-item node-switcher-item--offline" role="menuitem">
            <span class="node-switcher-item-dot"></span>
            <span class="node-switcher-item-name">${escapeHtml(String(name))}</span>
            <span class="node-switcher-item-badge">No IP</span>
          </div>`;
        }
        return `<a class="node-switcher-item${isOnline ? " node-switcher-item--online" : " node-switcher-item--offline"}"
            href="${url}" target="_blank" rel="noopener" role="menuitem"
            title="Open ${escapeHtml(String(name))}'s TLI at ${url}">
          <span class="node-switcher-item-dot${isOnline ? " node-switcher-item-dot--online" : ""}"></span>
          <span class="node-switcher-item-name">${escapeHtml(String(name))}</span>
          <span class="node-switcher-item-ip">${escapeHtml(ip)}:${port}</span>
        </a>`;
      }).join("");
    } catch {
      items.innerHTML = '<div class="node-switcher-empty">Could not load nodes</div>';
    }
  }

  // Toggle dropdown
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !menu.classList.contains("hidden");
    if (isOpen) {
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    } else {
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
      refreshSwitcher();
    }
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });
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
    const mode = getUiMode();
    const preferredId = mode === "dash2" ? "panel-dashboard2" : "panel-main";
    const preferred = document.getElementById(preferredId);
    const fallback =
      document.querySelector(".panel-container.active") ||
      document.getElementById("panel-main");
    const initialPanel = preferred || fallback;
    if (initialPanel) switchPanel(initialPanel.id);
  }

  // Critical UI setup
  setupTeachingToggle();
  setupChatHistoryDrawer();
  setupUiModeSelect();
  try { setupDash2HeaderButton(); } catch {}
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
  function doReset() {
    const ok = confirm(
      "Reset onboarding for this device/browser and reload?\n\n" +
      "This will re-run the first-run wizard.\n" +
      "It will NOT delete your Vault or device nickname."
    );
    if (!ok) return;
    try {
      localStorage.setItem("tli_force_onboard_once", "1");
      localStorage.removeItem("tli_onboard_seen_v1");
      localStorage.removeItem("tli_onboard_seen_v2");
      localStorage.removeItem("tli_onboard_seen");
    } catch {}
    location.reload();
  }

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
    btn.textContent = "Reset onboarding";
    btn.title = "Re-run the first-run wizard for this browser/device";
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
