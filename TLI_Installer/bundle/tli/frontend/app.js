// ---------- helpers ----------
function $(id) { return document.getElementById(id); }

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
const TLI_ONBOARD_ALLOW_SEARCH_SUGGEST_KEY = "tli_allow_search_suggest_v1";
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

  // Check backend status — existing users (PIN already set) are auto-marked complete
  try {
    const r = await fetch("/system/onboarding/status");
    if (r.ok) {
      const d = await r.json();
      if (d.complete && !forced) {
        tliLSSet(TLI_ONBOARD_SEEN_KEY, "1");
        try { delete document.documentElement.dataset.tliOnboard; } catch {}
        return;
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
  const stopBtn  = document.getElementById("tli-audio-stop");
  const volEl    = document.getElementById("tli-audio-vol");

  if (!titleEl || !textEl || !dynEl || !statusEl || !barEl || !backBtn || !nextBtn || !closeBtn) {
    console.warn("[TLI] Onboarding markup missing; skipping.");
    try { delete document.documentElement.dataset.tliOnboard; } catch {}
    return;
  }

  // optional audio controls
  if (stopBtn) stopBtn.addEventListener("click", () => tliStopAudio(audioEl));
  if (volEl) {
    volEl.addEventListener("input", () => {
      const v = parseFloat(volEl.value || "0.22");
      try { if (audioEl) audioEl.volume = Math.max(0, Math.min(1, v)); } catch {}
    });
  }

  let step = 0;
  let audioStarted = false;

  const steps = [
    // ── Step 0: Welcome + node name ────────────────────────────
    {
      title: "Welcome to TheLanIntelligence",
      text: "Your private home console — no cloud, no accounts, no tracking.\nLet’s get you set up in a few quick steps.",
      build: () => {
        dynEl.innerHTML = `
          <div class="tli-onboard-field">
            <label for="onboard-node-name">Name this machine</label>
            <input id="onboard-node-name" type="text" placeholder="e.g. Office PC, Media Server, Laptop" maxlength="48" />
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
        let aiStatus = `<span style="color:var(--warning,#f59e0b);font-weight:600;">Not downloaded</span> <button onclick="document.getElementById('tli-no-ai-download-btn')?.click()" style="margin-left:8px;background:var(--accent);color:#fff;border:none;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600;cursor:pointer;">Download now</button>`;
        try {
          const air = await fetch("/api/ai/model/info");
          if (air.ok) {
            const aid = await air.json();
            if (aid.exists) {
              aiStatus = `<span style="color:var(--accent)">Ready ✓</span> · ${aid.preset?.name || "Bundled AI"}`;
            } else {
              // Check download in progress
              const dlr = await fetch("/api/ai/model/download/status");
              if (dlr.ok) {
                const dld = await dlr.json();
                if (dld.in_progress) {
                  const pct = dld.bytes_total > 0 ? Math.round((dld.bytes_done / dld.bytes_total) * 100) : 0;
                  aiStatus = `<span style="color:var(--warning,#f59e0b)">Downloading… ${pct}%</span>`;
                }
              }
            }
          }
        } catch {}
        const shellyLine = ad?.shelly?.count > 0
          ? `${ad.shelly.count} device${ad.shelly.count !== 1 ? "s" : ""} registered`
          : "None yet — add in Home Automation";
        const nodeLine   = ad?.node?.name || "TLI Node";
        const lanLine    = ad?.lan_ip     || "127.0.0.1";

        dynEl.innerHTML = `
          <div class="tli-onboard-summary">
            <div class="tli-onboard-summary-row">
              <span class="tli-onboard-summary-label">AI</span>
              <span class="tli-onboard-summary-val">${aiStatus}</span>
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
      },
      onNext: async () => {
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
    // Start intro audio on first Continue only (fade-in)
    if (!audioStarted && audioEl) {
      audioStarted = true;
      try {
        await audioEl.play().catch(() => {});
        const target = volEl ? parseFloat(volEl.value || "0.22") : 0.22;
        tliFadeInAudio(audioEl, isFinite(target) ? target : 0.22, 900);
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
    if (step > 0) {
      step -= 1;
      await render();
    }
  }

  nextBtn.addEventListener("click", goNext);
  backBtn.addEventListener("click", goBack);
  closeBtn.addEventListener("click", () => {
    tliStopAudio(audioEl);
    tliHideOnboard(false);
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
  render();
}

// Register FIRST so it runs before other DOMContentLoaded handlers in this file
document.addEventListener("DOMContentLoaded", () => {
  try { setupOnboardingWizard(); } catch (e) { console.error("[TLI] Onboarding init failed:", e); }
  _tliInitMobileNav();
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

;(function _tliAmbientAlerts() {
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
    "panel-tli-chat": "peer_nodes",
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

const TLI_VERSION        = "0.9.0";
const DEFAULT_THEME      = "emeraldLight";
const previousPromptsKey = "tli_previous_prompts";

let currentDeviceId = null;        // filled from /status
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
      text.textContent = "AI: Bundled";
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
  bubble.textContent = text;
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
async function tliBundledChatStream({ message, raw_input, session_id, max_tokens, temperature, onDelta, onMeta }) {
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
        max_tokens: max_tokens ?? 300,
        temperature: temperature ?? 0.2,
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
function switchPanel(targetId) {
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
// Visualizer: load drive tiles on first open
if (targetId === "panel-visualizer") {
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

  // ── Statement categories ──────────────────────────────────────
  const CATEGORIES = ["state","state","device","ai","ai","mesh","storage","vault","tip","tip","time","capability","capability","fact"];
  // state/ai/tip/capability appear twice to give them more weight

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
        "The bundled AI model runs entirely on this machine. No internet or subscription required.",
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
        `${nickname} is your private LAN console. Nothing here requires an account or a subscription.`,
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
        "Scripts panel generates real automations you can schedule with Windows Task Scheduler or cron.",
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

      fact: () => pick([
        `TLI v${TLI_VERSION || "0.9.0"} is running on ${nickname}.`,
        "TLI was designed as a private, offline-first Home OS for LAN power users.",
        "All AI inference happens locally. The model never phones home.",
        "TLI's bundled AI uses quantised models — fast on consumer hardware, no GPU required.",
        "You can rename any Shelly device in Home Automation and TLI will use that name everywhere.",
        "The Narrator refreshes live data every 30 seconds and cycles through system insights.",
        "TLI remembers your settings, chat history, and vault data between sessions.",
        `${nickname} is your private LAN console. No account. No subscription. No cloud.`,
        "TLI was built to run on your hardware, serve your LAN, and stay out of your way.",
        "The bundled AI model is fully quantised — tuned for speed on low-power hardware.",
        "Your Vault is AES-encrypted on disk. Not even TLI's backend reads plaintext secrets.",
        "TLI's Narrator is driven entirely by live data fetched from your local backend.",
        "Every smart device name you set is stored locally and referenced by the AI, the Narrator, and the feed.",
      ]),
    };

    const fn = map[cat];
    const result = fn ? fn() : null;
    if (result) {
      _recentStatements.push(result);
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

  // ── Narrator cycling ─────────────────────────────────────────
  function _pickCategory() {
    const d = _lastData || {};
    const available = CATEGORIES.filter(c => {
      if (c === "device"  && !d.devNames?.length) return false;
      if (c === "storage" && !d.diskData?.ok)     return false;
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
    const cat  = _pickCategory();
    const text = _buildStatement(cat);
    if (!text) { _narratorNext(); return; } // skip empty categories, try again

    const stmt = _el("nd-statement");
    if (stmt) stmt.style.opacity = "0";

    setTimeout(() => {
      if (!_open) return;
      _typeText(text);
      if (stmt) stmt.style.transition = "opacity 0.5s";
      if (stmt) stmt.style.opacity    = "1";
      // Feed log for state/device categories only (not every tip)
      if (["state","device","storage","mesh","ai"].includes(cat)) {
        _feedLog(text, _lastData?.aiOk || _lastData?.lmOnline ? "good" : "warn");
      }
    }, 450);
  }

  function _setMeta(text) {
    const el = _el("nd-meta-line");
    if (el) el.textContent = text;
  }

  // ── Activity feed ─────────────────────────────────────────────
  function _feedLog(msg, type) {
    const feed = _el("nd-feed");
    if (!feed) return;
    const item = document.createElement("div");
    const t    = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dot  = type === "warn" ? "🟡" : type === "error" ? "🔴" : "🟢";
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
    const actions = [
      { icon: "💬", label: "Open Chat",       onclick: "switchPanel('panel-main'); document.getElementById('chat-input')?.focus();" },
      { icon: "🩺", label: "System health",   onclick: `window._tliDashChatAction("Run a full system health check — CPU, RAM, disk, and top processes.")` },
      { icon: "🌐", label: "Network scan",    onclick: `window._tliDashChatAction("Scan the local network and list all active LAN devices.")` },
      { icon: "📁", label: "Disk usage",      onclick: `window._tliDashChatAction("Show me disk usage and which folders are taking the most space.")` },
      { icon: "🔑", label: "Vault",           onclick: "switchPanel('panel-vault');" },
    ];
    if (devNames.length > 0) {
      actions.splice(3, 0, { icon: "🏠", label: "Device status", onclick: `window._tliDashChatAction("Show the on/off status and power draw of all smart home devices.")` });
      const first = (devNames[0] || "").replace(/"/g, "");
      actions.splice(4, 0, { icon: "⚡", label: `Toggle ${first}`, onclick: `window._tliDashChatAction("Toggle ${first}")` });
    }
    if (!aiOk) {
      actions.push({ icon: "🤖", label: "Why is AI offline?", onclick: `window._tliDashChatAction("The AI model appears offline. Why might this happen and how do I fix it?")` });
    }
    el.style.cssText = "display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;padding-top:8px;";
    el.innerHTML = actions.map(a =>
      `<button class="chip-button" style="width:auto;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;" onclick="${a.onclick}">` +
      `<span>${a.icon}</span><span>${a.label}</span></button>`
    ).join("");
  }

  // ── Data refresh (every 30s) ──────────────────────────────────
  async function _refresh() {
    if (!_open) return;
    try {
      const [statusRes, devRes, aiRes, diskRes] = await Promise.allSettled([
        fetch("/status",                { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch("/homeauto/devices",      { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch("/api/ai/bundled/status", { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch("/api/system/disk",       { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
      ]);

      const status   = statusRes.status  === "fulfilled" ? statusRes.value  : null;
      const devData  = devRes.status     === "fulfilled" ? devRes.value     : null;
      const aiData   = aiRes.status      === "fulfilled" ? aiRes.value      : null;
      const diskData = diskRes.status    === "fulfilled" ? diskRes.value    : null;

      const aiOk     = !!(aiData && (aiData.ok || aiData.healthy));
      const lmOnline = !!(status?.model_online);
      const devices  = Array.isArray(devData?.devices) ? devData.devices : [];
      const devNames = devices.map((d, i) => (d.name?.trim()) ? d.name.trim() : `Device ${i + 1}`);
      const devCount = devices.length;
      const nickname = status?.device_nickname || "TLI Node";
      const nodeRole = status?.node_role       || "standalone";
      const meshSt   = status?.mesh_status     || "unpaired";

      // Cache for Narrator statements
      _lastData = { aiOk, lmOnline, devNames, devCount, nickname, nodeRole, meshSt, diskData };

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

      // Always log a state snapshot on each data refresh so the feed is never empty
      const _snapParts = [];
      if (devCount > 0) _snapParts.push(`${devCount} device${devCount !== 1 ? "s" : ""} online`);
      _snapParts.push(aiOk ? "AI bundled" : lmOnline ? "LM Studio" : "AI offline");
      if (sys?.ok) _snapParts.push(`${dLabel} ${sys.pct}%`);
      _feedLog(_snapParts.join(" · ") + ".", _overallGood ? "good" : "warn");

    } catch (e) {
      _setOrb("idle");
      _setMeta("Backend unreachable");
      _feedLog("Backend unreachable — check the server.", "error");
    }
  }

  // ── Public API ────────────────────────────────────────────────
  function onOpen() {
    if (_open) return;
    _open = true;
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
    if (_pollTimer)  { clearInterval(_pollTimer);  _pollTimer  = null; }
    if (_cycleTimer) { clearInterval(_cycleTimer); _cycleTimer = null; }
    if (_typeTimer)  { clearInterval(_typeTimer);  _typeTimer  = null; }
    if (_tipTimer)   { clearInterval(_tipTimer);   _tipTimer   = null; }
  }

  return { onOpen, onClose };
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
  if (!rawText) return;
  input.value = "";

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
appendMessage("user", rawText);
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

const endpoint = useBundled ? "/api/ai/chat" : "/chat";

// ✅ Bundled AI: use SSE streaming for instant partial output
if (useBundled) {
  const wrapped = buildContextWrappedMessage({ latestUserMessage: text, teachingMode: teachingMode, mode: mode });
  let acc = "";
  // reuse the existing thinking bubble created above
  try { if (thinkingBubble) thinkingBubble.innerHTML = ""; } catch {}

  try {
  await tliBundledChatStream({
      message: wrapped,
      raw_input: text,
      session_id: currentConversationId || null,
      max_tokens: maxTokens,
      temperature: temperature,
      onMeta: (m) => {
        try { currentConversationId = m.session_id || currentConversationId; } catch {}
      },
      onDelta: (chunk) => {
        if (!chunk) return;
        acc += chunk;
        try {
          if (thinkingBubble) {
            thinkingBubble.classList.remove("chat-bubble-thinking");
            thinkingBubble.innerHTML = renderAssistantHTML(acc);
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
  try { if (thinkingBubble) { thinkingBubble.classList.remove('chat-bubble-thinking'); thinkingBubble.innerHTML = renderAssistantHTML(acc); } } catch {}
  try { chatHistoryAdd('assistant', acc); } catch {}
  return;
}

// finalize
  try {
    if (thinkingBubble) thinkingBubble.classList.remove("chat-bubble-thinking");
  } catch {}
  try { chatHistoryAdd("assistant", acc); } catch {}
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
        detail = j.detail ? JSON.stringify(j.detail) : detail;
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

    saveConversation(text, reply, currentConversationId);
    addPreviousPrompt(text);

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
    banner.classList.remove("hidden");
  } catch {
    banner.classList.add("hidden");
  }
}

function setupChat() {
  const sendBtn = $("chat-send-btn");
  const input   = $("chat-input");
  const newBtn  = $("new-chat-btn");
  const abortBtn = $("abort-chat-btn");
  if (!sendBtn || !input || !newBtn || !abortBtn) return;

  // Wire no-AI banner download button → model manager modal
  const noAiBtn = $("tli-no-ai-download-btn");
  if (noAiBtn) {
    noAiBtn.addEventListener("click", () => {
      const overlay = $("model-manager-modal-overlay");
      if (overlay) {
        overlay.classList.remove("hidden");
        overlay.setAttribute("aria-hidden", "false");
        // Trigger model manager refresh if available
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
}

// ---------- previous prompts ----------
function loadPreviousPrompts() {
  const listEl = $("previous-prompts");
  if (!listEl) return;
  listEl.innerHTML = "";
  let stored = [];
  try {
    const raw = localStorage.getItem(previousPromptsKey);
    stored = raw ? JSON.parse(raw) : [];
  } catch {
    stored = [];
  }

  if (!stored.length) {
    const hint = document.createElement("div");
    hint.className = "small-meta";
    hint.textContent = "No prompts yet (0 saved).";
    listEl.appendChild(hint);
    return;
  }

  stored.slice(-12).reverse().forEach(text => {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.addEventListener("click", () => {
      $("chat-input").value = text;
      $("chat-input").focus();
    });
    listEl.appendChild(btn);
  });
}

function addPreviousPrompt(text) {
  let stored = [];
  try {
    const raw = localStorage.getItem(previousPromptsKey);
    stored = raw ? JSON.parse(raw) : [];
  } catch {
    stored = [];
  }
  stored.push(text);
  if (stored.length > 50) stored = stored.slice(stored.length - 50);
  localStorage.setItem(previousPromptsKey, JSON.stringify(stored));
  loadPreviousPrompts();
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
  const btn = $("rename-device-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const current = $("device-name-chip").textContent || "Device";
    const name = prompt("Device nickname:", current);
    if (!name || !name.trim()) return;
    $("device-name-chip").textContent = name.trim();
    $("footer-device").textContent    = name.trim();
    try {
      await fetch("/device/nickname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: name.trim() })
      });
      debugLog("info", 'POST /device/nickname set to "' + name.trim() + '"');
    } catch (err) {
      debugLog("warn", "POST /device/nickname failed: " + err.message);
    }
  });
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

// ---------- vault ----------
function updateVaultUIFromStatus(status) {
  const initialized  = !!status.initialized;
  const unlocked     = !!status.unlocked;
  const setupSection = $("vault-setup-section");
  const authSection  = $("vault-auth-section");
  const pill         = $("vault-status-pill");
  const contentArea  = $("vault-content-area");
  const lockBtn      = $("vault-lock-btn");
  const iconGlyph    = $("vault-icon-glyph");
  const authCard     = document.querySelector(".vault-auth-card");

  if (!pill || !setupSection || !authSection) return;

  const hint         = $("vault-auth-hint");
  const forgotBtn    = $("vault-forgot-btn");

  pill.className = "vault-pill";
  if (!initialized) {
    setupSection.style.display = "block";  // shows the redirect note
    authSection.style.display  = "none";
    pill.textContent = "Setup required";
    pill.dataset.state = "setup";
  } else if (!unlocked) {
    setupSection.style.display = "none";
    authSection.style.display  = "block";
    pill.textContent = "Locked";
    pill.dataset.state = "locked";

    // Lockout state
    const lockedUntil  = status.locked_until;
    const failedCount  = status.failed_attempts || 0;
    const remaining    = 5 - failedCount;

    if (hint) {
      if (lockedUntil) {
        const until = new Date(lockedUntil);
        const mins  = Math.ceil((until - Date.now()) / 60000);
        hint.textContent = `Too many failed attempts. Try again in ~${mins} minute${mins !== 1 ? "s" : ""}.`;
        hint.style.display = "block";
      } else if (failedCount > 0) {
        hint.textContent = `Wrong passphrase. ${remaining > 0 ? `${remaining} attempt${remaining !== 1 ? "s" : ""} before lockout.` : ""}`;
        hint.style.display = "block";
      } else {
        hint.textContent = "";
        hint.style.display = "none";
      }
    }

    // Show forgot link after first failed attempt
    if (forgotBtn) forgotBtn.style.display = failedCount > 0 ? "" : "none";
  } else {
    setupSection.style.display = "none";
    authSection.style.display  = "none";
    pill.textContent = "Unlocked";
    pill.dataset.state = "unlocked";
    if (hint) { hint.textContent = ""; hint.style.display = "none"; }
    if (forgotBtn) forgotBtn.style.display = "none";
    // Collapse reset panel if it was open
    const resetPanel = $("vault-reset-panel");
    if (resetPanel) resetPanel.classList.add("hidden");
  }

  if (contentArea) contentArea.classList.toggle("hidden", !unlocked);
  if (lockBtn) lockBtn.style.display = unlocked ? "" : "none";
  if (iconGlyph) iconGlyph.textContent = unlocked ? "🔓" : "🔒";
  if (authCard) authCard.classList.toggle("is-unlocked", unlocked);

  // Mirror state into Settings vault section
  _updateSettingsVaultUI(status);
}

function _updateSettingsVaultUI(status) {
  const initialized = !!status.initialized;
  const unlocked    = !!status.unlocked;
  const setupWrap   = $("sv-setup-wrap");
  const manageWrap  = $("sv-manage-wrap");
  const statusDesc  = $("sv-status-desc");
  if (!setupWrap || !manageWrap) return;

  if (!initialized) {
    setupWrap.style.display  = "";
    manageWrap.style.display = "none";
  } else {
    setupWrap.style.display  = "none";
    manageWrap.style.display = "";
    if (statusDesc) statusDesc.textContent = unlocked
      ? "Unlocked — content is accessible."
      : "Locked — passphrase required to access content.";
  }
}

async function fetchVaultStatus() {
  try {
    const res = await fetch("/vault/status");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    updateVaultUIFromStatus(data);
    if (data.unlocked) {
      await Promise.all([refreshVaultFiles(), refreshVaultSecrets(), refreshVaultNotes()]);
    }
    debugLog("info", "GET /vault/status OK: " + JSON.stringify(data));
  } catch (err) {
    debugLog("warn", "GET /vault/status failed: " + err.message);
    showToast("Vault unavailable — backend unreachable.");
  }
}

async function refreshVaultFiles() {
  const list = $("vault-files-list");
  if (!list) return;
  list.innerHTML = "";
  try {
    const res = await fetch("/vault/list");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const files = data.files || [];

    if (!files.length) {
      list.innerHTML = '<div class="vault-file-empty">No encrypted files yet. Upload one above.</div>';
      return;
    }

    files.forEach(file => {
      const row = document.createElement("div");
      row.className = "vault-file-row";

      const nameEl = document.createElement("span");
      nameEl.className = "vault-file-name";
      nameEl.textContent = file.name || "(unnamed)";
      nameEl.title = file.name || "";

      const sizeEl = document.createElement("span");
      sizeEl.className = "vault-file-size";
      sizeEl.textContent = file.size_display || "";

      const actionsEl = document.createElement("span");
      actionsEl.className = "vault-file-actions";

      const dl = document.createElement("button");
      dl.textContent = "Download";
      dl.className = "btn-outline";
      dl.style.cssText = "font-size:11px;padding:3px 8px;";
      dl.addEventListener("click", () => {
        window.location.href = "/vault/get_file?file_id=" + encodeURIComponent(file.id);
      });

      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "btn-outline danger";
      del.style.cssText = "font-size:11px;padding:3px 8px;";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this vault file? This cannot be undone.")) return;
        try {
          await fetch("/vault/delete_file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file_id: file.id })
          });
          await refreshVaultFiles();
          debugLog("info", "POST /vault/delete_file OK for " + (file.id || file.name));
        } catch (err) {
          debugLog("error", "POST /vault/delete_file failed: " + err.message);
        }
      });

      actionsEl.appendChild(dl);
      actionsEl.appendChild(del);
      row.appendChild(nameEl);
      row.appendChild(sizeEl);
      row.appendChild(actionsEl);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '<div class="vault-file-empty" style="color:var(--danger,#f87171)">Could not load files. Is the backend running?</div>';
    debugLog("warn", "GET /vault/list failed: " + err.message);
  }
}

// ---- Vault secrets ----
async function refreshVaultSecrets() {
  const list = $("vault-secrets-list");
  if (!list) return;
  list.innerHTML = "";
  try {
    const res = await fetch("/vault/secrets");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const keys = data.keys || [];

    if (!keys.length) {
      list.innerHTML = '<div class="vault-secrets-empty">No secrets stored yet.</div>';
      return;
    }

    keys.forEach(key => {
      const row = document.createElement("div");
      row.className = "vault-secret-row";

      const keyEl = document.createElement("span");
      keyEl.className = "vault-secret-key";
      keyEl.textContent = key;

      const valEl = document.createElement("span");
      valEl.className = "vault-secret-val";
      valEl.textContent = "••••••••";
      let revealed = false;

      const revealBtn = document.createElement("button");
      revealBtn.className = "btn-outline";
      revealBtn.style.cssText = "font-size:11px;padding:3px 8px;white-space:nowrap;";
      revealBtn.textContent = "Show";
      revealBtn.addEventListener("click", async () => {
        if (revealed) {
          valEl.textContent = "••••••••";
          revealBtn.textContent = "Show";
          revealed = false;
          return;
        }
        try {
          const r = await fetch(`/vault/secret/${encodeURIComponent(key)}`);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const d = await r.json();
          valEl.textContent = d.value;
          revealBtn.textContent = "Hide";
          revealed = true;
        } catch (err) {
          showToast("Could not reveal secret: " + err.message);
        }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "btn-outline danger";
      delBtn.style.cssText = "font-size:11px;padding:3px 8px;";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete secret "${key}"?`)) return;
        try {
          await fetch(`/vault/secret/${encodeURIComponent(key)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
          });
          await refreshVaultSecrets();
        } catch (err) {
          showToast("Delete failed: " + err.message);
        }
      });

      const actEl = document.createElement("span");
      actEl.className = "vault-secret-actions";
      actEl.appendChild(revealBtn);
      actEl.appendChild(delBtn);

      row.appendChild(keyEl);
      row.appendChild(valEl);
      row.appendChild(actEl);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '<div class="vault-secrets-empty" style="color:var(--danger,#f87171)">Could not load secrets.</div>';
    debugLog("warn", "GET /vault/secrets failed: " + err.message);
  }
}

// ---- Vault notes ----
let _vaultNoteActiveId = null;

async function refreshVaultNotes() {
  const noteList = $("vault-notes-list");
  if (!noteList) return;
  noteList.innerHTML = "";
  try {
    const res = await fetch("/vault/notes");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const notes = data.notes || [];

    if (!notes.length) {
      noteList.innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 2px;">No notes yet.</div>';
    } else {
      notes.forEach(note => {
        const item = document.createElement("div");
        item.className = "vault-note-item" + (note.id === _vaultNoteActiveId ? " is-active" : "");
        item.textContent = note.title || note.id;
        item.title = note.title;
        item.addEventListener("click", () => loadVaultNote(note.id, note.title));
        noteList.appendChild(item);
      });
    }
  } catch (err) {
    noteList.innerHTML = '<div style="font-size:0.78rem;color:var(--danger,#f87171);padding:6px 2px;">Could not load notes.</div>';
    debugLog("warn", "GET /vault/notes failed: " + err.message);
  }
}

async function loadVaultNote(noteId, title) {
  _vaultNoteActiveId = noteId;
  const editor     = $("vault-note-editor");
  const empty      = $("vault-note-empty");
  const titleInput = $("vault-note-title-input");
  const body       = $("vault-note-body");
  const status     = $("vault-note-status");

  if (!editor || !body) return;

  editor.classList.add("hidden");
  if (empty) empty.classList.remove("hidden");
  if (status) status.textContent = "Loading…";

  try {
    const res = await fetch(`/vault/note/${encodeURIComponent(noteId)}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    if (titleInput) titleInput.value = data.title || "";
    body.value = data.content || "";
    if (status) status.textContent = "";

    editor.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
    editor.dataset.noteId = noteId;
    editor.dataset.noteOrigTitle = data.title || "";

    await refreshVaultNotes();
  } catch (err) {
    if (status) status.textContent = "Load failed";
    debugLog("warn", "GET /vault/note failed: " + err.message);
  }
}

function _vaultOpenNewNote() {
  _vaultNoteActiveId = null;
  const editor     = $("vault-note-editor");
  const empty      = $("vault-note-empty");
  const titleInput = $("vault-note-title-input");
  const body       = $("vault-note-body");
  const status     = $("vault-note-status");

  if (!editor) return;
  if (titleInput) titleInput.value = "";
  if (body) body.value = "";
  if (status) status.textContent = "";

  editor.classList.remove("hidden");
  if (empty) empty.classList.add("hidden");
  editor.dataset.noteId = "";

  document.querySelectorAll(".vault-note-item").forEach(el => el.classList.remove("is-active"));
  if (titleInput) titleInput.focus();
}

async function _vaultUnlock(pw) {
  const hint = $("vault-auth-hint");
  try {
    const res = await fetch("/vault/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || "HTTP " + res.status);
    }
    $("vault-password").value = "";
    if (hint) { hint.textContent = ""; hint.style.display = "none"; }
    await fetchVaultStatus();
    await Promise.all([refreshVaultFiles(), refreshVaultSecrets(), refreshVaultNotes()]);
    debugLog("info", "POST /vault/unlock OK");
  } catch (err) {
    // Re-fetch status to get updated failed_attempts count and lockout info
    await fetchVaultStatus();
    debugLog("error", "POST /vault/unlock failed: " + err.message);
  }
}

function setupSettingsVault() {
  // ---- Initialize ----
  const svSetupBtn = $("sv-setup-btn");
  if (svSetupBtn && !svSetupBtn.__tliWired) {
    svSetupBtn.__tliWired = true;
    const doInit = async () => {
      const p1 = ($("sv-passphrase")?.value || "").trim();
      const p2 = ($("sv-passphrase-confirm")?.value || "").trim();
      if (!p1 || p1.length < 8) { showToast("Passphrase must be at least 8 characters.", "error"); return; }
      if (p1 !== p2) { showToast("Passphrases do not match.", "error"); return; }
      svSetupBtn.disabled = true;
      try {
        const res = await fetch("/vault/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: p1 }),
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || "HTTP " + res.status); }
        showToast("Vault initialized. Go to the Vault panel to unlock.", "success");
        if ($("sv-passphrase")) $("sv-passphrase").value = "";
        if ($("sv-passphrase-confirm")) $("sv-passphrase-confirm").value = "";
        await fetchVaultStatus();
      } catch (e) {
        showToast("Vault setup failed: " + e.message, "error");
      } finally {
        svSetupBtn.disabled = false;
      }
    };
    svSetupBtn.addEventListener("click", doInit);
    [$("sv-passphrase"), $("sv-passphrase-confirm")].forEach(el => {
      if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") doInit(); });
    });
  }

  // ---- Open Vault → ----
  const svOpenBtn = $("sv-open-btn");
  if (svOpenBtn && !svOpenBtn.__tliWired) {
    svOpenBtn.__tliWired = true;
    svOpenBtn.addEventListener("click", () => {
      if (typeof switchPanel === "function") switchPanel("panel-vault");
    });
  }

  // ---- Export backup ----
  const svExportBtn = $("sv-export-btn");
  if (svExportBtn && !svExportBtn.__tliWired) {
    svExportBtn.__tliWired = true;
    svExportBtn.addEventListener("click", () => {
      window.location.href = "/vault/export_backup";
    });
  }

  // ---- Hard reset ----
  const svResetConfirm  = $("sv-reset-confirm");
  const svResetPassword = $("sv-reset-password");
  const svResetBtn      = $("sv-reset-btn");
  if (svResetConfirm && svResetBtn && !svResetBtn.__tliWired) {
    svResetBtn.__tliWired = true;
    const _checkReady = () => {
      svResetBtn.disabled =
        svResetConfirm.value !== "RESET VAULT" ||
        !(svResetPassword?.value?.trim());
    };
    svResetConfirm.addEventListener("input", _checkReady);
    svResetPassword?.addEventListener("input", _checkReady);

    svResetBtn.addEventListener("click", async () => {
      if (svResetConfirm.value !== "RESET VAULT") return;
      const password = svResetPassword?.value?.trim() || "";
      if (!password) { showToast("Enter your current vault passphrase.", "error"); return; }
      const confirmed = confirm(
        "PERMANENT DATA DESTRUCTION\n\n" +
        "This will delete ALL encrypted vault files — files, secrets, and notes.\n\n" +
        "This cannot be undone. There is no recovery.\n\nClick OK only if you are certain."
      );
      if (!confirmed) return;
      svResetBtn.disabled = true;
      svResetBtn.textContent = "Resetting…";
      try {
        const res = await fetch("/vault/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "RESET VAULT", password }),
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || "HTTP " + res.status); }
        svResetConfirm.value = "";
        if (svResetPassword) svResetPassword.value = "";
        showToast("Vault reset. You can now set a new passphrase.", "success");
        await fetchVaultStatus();
      } catch (e) {
        showToast("Reset failed: " + e.message, "error");
      } finally {
        svResetBtn.disabled = false;
        svResetBtn.textContent = "Destroy & Reset";
      }
    });
  }
}

function setupVaultPanel() {
  // ---- Unlock ----
  const unlockBtn = $("vault-unlock-btn");
  if (unlockBtn) {
    unlockBtn.addEventListener("click", () => {
      const pw = $("vault-password").value.trim();
      if (pw) _vaultUnlock(pw);
    });
  }
  const pwInput = $("vault-password");
  if (pwInput) {
    pwInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const pw = pwInput.value.trim();
        if (pw) _vaultUnlock(pw);
      }
    });
  }

  // ---- Lock ----
  const lockBtn = $("vault-lock-btn");
  if (lockBtn) {
    lockBtn.addEventListener("click", async () => {
      try { await fetch("/vault/lock", { method: "POST" }); } catch {}
      // Clear all vault content areas
      const list = $("vault-files-list");
      if (list) list.innerHTML = "";
      const sl = $("vault-secrets-list");
      if (sl) sl.innerHTML = "";
      const nl = $("vault-notes-list");
      if (nl) nl.innerHTML = "";
      const editor = $("vault-note-editor");
      if (editor) editor.classList.add("hidden");
      const empty = $("vault-note-empty");
      if (empty) empty.classList.remove("hidden");
      _vaultNoteActiveId = null;
      await fetchVaultStatus();
    });
  }

  // ---- Tab bar ----
  document.querySelectorAll(".vault-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".vault-tab").forEach(t => t.classList.remove("is-active"));
      document.querySelectorAll(".vault-tab-pane").forEach(p => p.classList.add("hidden"));
      tab.classList.add("is-active");
      const target = tab.dataset.vaultTab;
      const pane = $("vault-tab-" + target);
      if (pane) pane.classList.remove("hidden");
    });
  });

  // ---- File upload ----
  const fileInput = $("vault-file-input");
  const chosenName = $("vault-chosen-filename");
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      if (chosenName) chosenName.textContent = fileInput.files.length ? fileInput.files[0].name : "No file chosen";
    });
  }
  const uploadBtn = $("vault-upload-btn");
  const msgEl = $("vault-message");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      if (!fileInput || !fileInput.files.length) { showToast("Choose a file first."); return; }
      const file = fileInput.files[0];
      const form = new FormData();
      form.append("file", file);
      if (msgEl) msgEl.textContent = "Uploading…";
      try {
        const res = await fetch("/vault/upload", { method: "POST", body: form });
        if (!res.ok) { const txt = await res.text(); throw new Error("HTTP " + res.status + " · " + txt); }
        if (msgEl) msgEl.textContent = "Uploaded.";
        if (chosenName) chosenName.textContent = "No file chosen";
        fileInput.value = "";
        await refreshVaultFiles();
      } catch (err) {
        if (msgEl) msgEl.textContent = "Upload failed: " + err.message;
      }
    });
  }

  // ---- Forgot passphrase toggle ----
  const forgotBtn   = $("vault-forgot-btn");
  const resetPanel  = $("vault-reset-panel");
  if (forgotBtn && resetPanel) {
    forgotBtn.addEventListener("click", () => {
      resetPanel.classList.toggle("hidden");
    });
  }

  // ---- Export encrypted backup ----
  const exportBtn = $("vault-export-backup-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      window.location.href = "/vault/export_backup";
    });
  }

  // ---- Hard reset confirmation input ----
  const resetConfirmInput  = $("vault-reset-confirm-input");
  const resetPasswordInput = $("vault-reset-password-input");
  const hardResetBtn       = $("vault-hard-reset-btn");
  if (resetConfirmInput && hardResetBtn) {
    const _checkResetReady = () => {
      hardResetBtn.disabled =
        resetConfirmInput.value !== "RESET VAULT" ||
        !(resetPasswordInput?.value?.trim());
    };
    resetConfirmInput.addEventListener("input", _checkResetReady);
    resetPasswordInput?.addEventListener("input", _checkResetReady);

    hardResetBtn.addEventListener("click", async () => {
      if (resetConfirmInput.value !== "RESET VAULT") return;
      const password = resetPasswordInput?.value?.trim() || "";
      if (!password) { showToast("Enter your vault passphrase to confirm the reset."); return; }

      // Final explicit warning before irreversible action
      const confirmed = confirm(
        "PERMANENT DATA DESTRUCTION\n\n" +
        "This will delete ALL encrypted vault files — files, secrets, and notes.\n\n" +
        "This cannot be undone. There is no recovery.\n\n" +
        "Click OK only if you are certain."
      );
      if (!confirmed) return;

      hardResetBtn.disabled = true;
      hardResetBtn.textContent = "Resetting…";
      try {
        const res = await fetch("/vault/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "RESET VAULT", password })
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.detail || "HTTP " + res.status);
        }
        resetConfirmInput.value = "";
        if (resetPasswordInput) resetPasswordInput.value = "";
        if (resetPanel) resetPanel.classList.add("hidden");
        const forgotBtnEl = $("vault-forgot-btn");
        if (forgotBtnEl) forgotBtnEl.style.display = "none";
        showToast("Vault reset. You can now set a new passphrase.");
        await fetchVaultStatus();
      } catch (err) {
        hardResetBtn.disabled = false;
        hardResetBtn.textContent = "Destroy & Reset";
        showToast("Reset failed: " + err.message);
      }
    });
  }

  // ---- Add secret ----
  const secretAddBtn = $("vault-secret-add-btn");
  if (secretAddBtn) {
    const doAddSecret = async () => {
      const keyEl = $("vault-secret-key-input");
      const valEl = $("vault-secret-val-input");
      const key = keyEl ? keyEl.value.trim() : "";
      const val = valEl ? valEl.value : "";
      if (!key) { showToast("Enter a key name."); return; }
      try {
        const res = await fetch(`/vault/secret/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: val })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        if (keyEl) keyEl.value = "";
        if (valEl) valEl.value = "";
        await refreshVaultSecrets();
      } catch (err) {
        showToast("Could not save secret: " + err.message);
      }
    };
    secretAddBtn.addEventListener("click", doAddSecret);
    const valInput = $("vault-secret-val-input");
    if (valInput) valInput.addEventListener("keydown", e => { if (e.key === "Enter") doAddSecret(); });
  }

  // ---- New note ----
  const newNoteBtn = $("vault-newnote-btn");
  if (newNoteBtn) newNoteBtn.addEventListener("click", _vaultOpenNewNote);

  // ---- Save note ----
  const noteSaveBtn = $("vault-note-save-btn");
  if (noteSaveBtn) {
    noteSaveBtn.addEventListener("click", async () => {
      const titleInput = $("vault-note-title-input");
      const body       = $("vault-note-body");
      const status     = $("vault-note-status");
      const title = titleInput ? titleInput.value.trim() : "";
      const content = body ? body.value : "";
      if (!title) { showToast("Note needs a title."); return; }
      if (status) status.textContent = "Saving…";
      try {
        const res = await fetch("/vault/note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (status) status.textContent = "Saved.";
        _vaultNoteActiveId = data.id;
        await refreshVaultNotes();
        setTimeout(() => { if (status) status.textContent = ""; }, 2000);
      } catch (err) {
        if (status) status.textContent = "Save failed";
        showToast("Could not save note: " + err.message);
      }
    });
  }

  // ---- Delete note ----
  const noteDeleteBtn = $("vault-note-delete-btn");
  if (noteDeleteBtn) {
    noteDeleteBtn.addEventListener("click", async () => {
      const editor = $("vault-note-editor");
      const noteId = editor ? editor.dataset.noteId : "";
      if (!noteId) {
        // New unsaved note — just close editor
        editor.classList.add("hidden");
        const empty = $("vault-note-empty");
        if (empty) empty.classList.remove("hidden");
        return;
      }
      if (!confirm("Delete this note? This cannot be undone.")) return;
      try {
        await fetch(`/vault/note/${encodeURIComponent(noteId)}`, { method: "DELETE" });
        _vaultNoteActiveId = null;
        editor.classList.add("hidden");
        const empty = $("vault-note-empty");
        if (empty) empty.classList.remove("hidden");
        await refreshVaultNotes();
      } catch (err) {
        showToast("Could not delete note: " + err.message);
      }
    });
  }
}

// ---------- FILES PANEL ----------

const FILES_LAST_ROOT_KEY = "tli_files_last_root_v1";
const FILES_BUCKET_DEST_KEY = "tli_files_bucket_dests_v1";

let filesLastScanBuckets = null;
let filesBucketDestinations = {};

function filesLoadSavedDestinations() {
  try {
    const raw = window.localStorage.getItem(FILES_BUCKET_DEST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      filesBucketDestinations = parsed;
    }
  } catch (err) {
    console.warn("Failed to load saved File Organizer destinations:", err);
  }
}

function filesSaveDestinations() {
  try {
    window.localStorage.setItem(
      FILES_BUCKET_DEST_KEY,
      JSON.stringify(filesBucketDestinations || {})
    );
  } catch (err) {
    console.warn("Failed to persist File Organizer destinations:", err);
  }
}

function filesSetPreset(kind) {
  let path = "";
  if (kind === "downloads") path = "%USERPROFILE%\\Downloads";
  else if (kind === "desktop") path = "%USERPROFILE%\\Desktop";
  else if (kind === "documents") path = "%USERPROFILE%\\Documents";
  else if (kind === "pictures") path = "%USERPROFILE%\\Pictures";

  const input = $("filesRootInput");
  if (input) {
    input.value = path;
    try {
      window.localStorage.setItem(FILES_LAST_ROOT_KEY, path);
    } catch {
      /* ignore */
    }
  }
}

function filesSetStatus(msg) {
  const el = $("filesStatus");
  if (el) el.textContent = msg;
  debugLog("info", "[FILES] " + msg);
}

function filesRenderExtensionTable(extSummary) {
  const tbody = $("filesExtTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!extSummary || !extSummary.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3">No files detected in this folder.</td>`;
    tbody.appendChild(tr);
    return;
  }

  extSummary.forEach(row => {
    const tr = document.createElement("tr");
    const ext = row.extension || row.ext || "(none)";
    const count = row.count ?? 0;
    const example = row.example || "";
    tr.innerHTML = `<td>${ext}</td><td>${count}</td><td title="${example}">${example}</td>`;
    tbody.appendChild(tr);
  });
}

function filesRenderBuckets() {
  const container = $("filesBucketsContainer");
  if (!container) return;
  container.innerHTML = "";

  if (!filesLastScanBuckets) {
    container.innerHTML =
      '<p class="hint">No scan yet. After scanning, you\'ll see buckets and can customize destination folders.</p>';
    return;
  }

  const buckets = filesLastScanBuckets.buckets || {};
  const names = Object.keys(buckets);
  if (!names.length) {
    container.innerHTML = '<p class="hint">No files found in this folder.</p>';
    return;
  }

  names.sort();
  names.forEach(name => {
    const files = buckets[name] || [];

    // Seed from saved destinations if available; otherwise fall back to bucket name.
    if (!filesBucketDestinations[name]) {
      filesBucketDestinations[name] = name;
    }

    const row = document.createElement("div");
    row.className = "files-bucket-row";
    row.innerHTML = `
      <div class="files-bucket-main">
        <div class="files-bucket-name">${name}</div>
        <div class="files-bucket-count">${files.length} files</div>
      </div>
      <div class="files-bucket-dest-row">
        <label class="files-bucket-dest-label">Destination subfolder name</label>
        <input type="text" class="files-bucket-input" value="${filesBucketDestinations[name]}"/>
      </div>`;

    const input = row.querySelector("input");
    input.addEventListener("input", () => {
      filesBucketDestinations[name] = input.value.trim();
      filesSaveDestinations();
    });

    container.appendChild(row);
  });
}
// Helper used by the Quick actions cards.
// It assumes /file/scan has already been run and filled filesLastScanBuckets.
function filesApplyQuick(bucketName, destName, description) {
  if (!filesLastScanBuckets) {
    showToast("Scan this folder first so TLI can see what's inside.");
    return;
  }

  const buckets = filesLastScanBuckets.buckets || {};
  const files = buckets[bucketName];

  if (!files || !files.length) {
    filesSetStatus(`No "${bucketName}" bucket found in this folder.`);
    debugLog("info", `[FILES] Quick action: no ${bucketName} bucket for current scan.`);
    return;
  }

  // Set or update the destination name for this bucket.
  filesBucketDestinations[bucketName] = destName;
  filesRenderBuckets();

  const msg = description || `Prepared quick action for "${bucketName}" → "${destName}/".`;
  filesSetStatus(msg);
  debugLog(
    "info",
    `[FILES] Quick action applied for ${bucketName} → ${destName}, ${files.length} files in bucket.`
  );
}

function filesBuildOrganizePayload() {
  if (!filesLastScanBuckets) return null;
  const basePath = ($("filesRootInput")?.value || "").trim();
  const buckets = filesLastScanBuckets.buckets || {};
  const actions = {};

  Object.entries(buckets).forEach(([bucketName, fileList]) => {
    const destName = (filesBucketDestinations[bucketName] || "").trim();
    if (!destName || !fileList || !fileList.length) return;
    actions[destName] = fileList.slice();
  });

  if (!basePath || !Object.keys(actions).length) return null;
  return { path: basePath, actions };
}

async function filesScanFolder() {
  const path = ($("filesRootInput")?.value || "").trim();
  if (!path) {
    showToast("Enter a folder path first.");
    return;
  }

  filesSetStatus("Scanning folder…");
  debugLog("info", "POST /files/scan root=" + path);

  // Persist last-used root for the next session.
  try {
    window.localStorage.setItem(FILES_LAST_ROOT_KEY, path);
  } catch {
    /* ignore */
  }

  try {
    const extRes = await fetch("/files/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: path })
    });
    if (!extRes.ok) {
      const txt = await extRes.text();
      filesSetStatus("Scan failed: " + extRes.status + " · " + txt);
      debugLog("error", "POST /files/scan failed: " + extRes.status + " · " + txt);
      return;
    }
    const extData = await extRes.json();
    filesRenderExtensionTable(extData.extension_summary || []);

    const bucketRes = await fetch("/file/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    if (!bucketRes.ok) {
      const txt = await bucketRes.text();
      filesSetStatus("Scan failed (buckets): " + bucketRes.status + " · " + txt);
      debugLog("error", "POST /file/scan failed: " + bucketRes.status + " · " + txt);
      return;
    }
    const bucketData = await bucketRes.json();
    filesLastScanBuckets = bucketData;
    filesRenderBuckets();

    const total = bucketData.total_files ?? 0;
    const bucketCount = Object.keys(bucketData.buckets || {}).length;
    filesSetStatus(`Scan complete: ${total} files in ${bucketCount} buckets.`);
    debugLog("info", "POST /file/scan OK, total_files=" + total + " buckets=" + bucketCount);

    // Show summary bar
    const summaryBar = $("fo-summary-bar");
    const summaryMeta = $("fo-summary-meta");
    const typeBars = $("fo-type-bars");
    const resultsSection = $("fo-results-section");
    if (summaryBar) summaryBar.style.display = "";
    if (resultsSection) resultsSection.style.display = "";
    if (summaryMeta) {
      const scanPath = ($("filesRootInput")?.value || "").trim();
      summaryMeta.innerHTML = `<strong>${total.toLocaleString()}</strong> files found across <strong>${bucketCount}</strong> categories in <code style="font-size:11px;opacity:.8">${scanPath}</code>`;
    }
    if (typeBars) {
      typeBars.innerHTML = "";
      const _catColors = {
        Images: "#10b981", Videos: "#f59e0b", Audio: "#6366f1",
        Documents: "#3b82f6", Archives: "#8b5cf6", Installers: "#ef4444",
        Code: "#06b6d4", Other: "#6b7280"
      };
      const buckets = bucketData.buckets || {};
      const entries = Object.entries(buckets).sort((a,b) => (b[1].files?.length ?? 0) - (a[1].files?.length ?? 0));
      const maxCount = entries[0]?.[1]?.files?.length ?? 1;
      entries.forEach(([name, bucket]) => {
        const count = bucket.files?.length ?? 0;
        const pct = Math.round((count / Math.max(maxCount, 1)) * 100);
        const color = _catColors[name] || _catColors.Other;
        const row = document.createElement("div");
        row.className = "fo-type-bar-row";
        row.innerHTML = `<span class="fo-type-bar-label">${name}</span><div class="fo-type-bar-track"><div class="fo-type-bar-fill" style="width:${pct}%;background:${color}"></div></div><span class="fo-type-bar-count">${count}</span>`;
        typeBars.appendChild(row);
      });
    }
  } catch (err) {
    console.error(err);
    filesSetStatus("Scan error: " + err.message);
    filesLastScanBuckets = null;
    filesRenderBuckets();
    debugLog("error", "FILES scan error: " + err.message);
  }
}

async function filesPreviewOrganize() {
  const payload = filesBuildOrganizePayload();
  if (!payload) {
    showToast("Scan a folder first, then adjust bucket destinations.");
    return;
  }
  filesSetStatus("Building preview plan…");
  try {
    const res = await fetch("/file/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, confirm: false })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Preview failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/organize preview failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const plan = data.plan || {};
    let fileCount = 0;
    Object.values(plan).forEach(list => {
      fileCount += (list || []).length;
    });
    const destCount = Object.keys(plan).length;
    filesSetStatus(`Preview only – would move ${fileCount} files into ${destCount} folders.`);
    debugLog("info", "POST /file/organize preview OK, files=" + fileCount + " dests=" + destCount);
  } catch (err) {
    filesSetStatus("Preview error: " + err.message);
    debugLog("error", "FILES preview error: " + err.message);
  }
}

async function filesRunOrganize() {
  const payload = filesBuildOrganizePayload();
  if (!payload) {
    showToast("Scan a folder first, then adjust bucket destinations.");
    return;
  }
  if (
    !window.confirm(
      "Run organizer now? It will move files according to the suggested buckets (you can undo the last change)."
    )
  ) {
    return;
  }
  filesSetStatus("Organizing files…");
  try {
    const res = await fetch("/file/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, confirm: true })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Organize failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/organize confirm failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const moved = data.moved_count ?? 0;
    filesSetStatus(
      `Organize complete: moved ${moved} files. You can undo the last change if needed.`
    );
    filesLastScanBuckets = null;
    filesBucketDestinations = {};
    filesSaveDestinations();
    filesRenderBuckets();
    debugLog("info", "POST /file/organize confirm OK, moved=" + moved);
  } catch (err) {
    filesSetStatus("Organize error: " + err.message);
    debugLog("error", "FILES organize error: " + err.message);
  }
}

async function filesUndoLast() {
  if (!window.confirm("Undo the last file operation?")) return;
  filesSetStatus("Undoing last operation…");
  try {
    const res = await fetch("/file/undo", { method: "POST" });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Undo failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/undo failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const undone = data.undone ?? 0;
    const message = data.message || "Undo complete.";
    filesSetStatus(`${message} (${undone} entries reverted.)`);
    debugLog("info", "POST /file/undo OK, undone=" + undone);
  } catch (err) {
    filesSetStatus("Undo error: " + err.message);
    debugLog("error", "FILES undo error: " + err.message);
  }
}

async function filesBatchRename() {
  const prefix = ($("filesRenamePrefix")?.value || "").trim();
  const path = ($("filesRootInput")?.value || "").trim();
  if (!prefix || !path) {
    showToast("Enter both a folder path and a prefix before running batch rename.");
    return;
  }

  filesSetStatus("Renaming files…");
  debugLog("info", "POST /file/rename path=" + path + " prefix=" + prefix);

  try {
    const res = await fetch("/file/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, prefix })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Rename failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/rename failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const count = data.count ?? 0;
    filesSetStatus(`Renamed ${count} files with the new prefix.`);
    debugLog("info", "POST /file/rename OK, count=" + count);
  } catch (err) {
    filesSetStatus("Rename error: " + err.message);
    debugLog("error", "FILES rename error: " + err.message);
  }
}

async function filesUseCustomRules() {
  const path = ($("filesRootInput")?.value || "").trim();
  const rulesText = ($("filesRulesTextarea")?.value || "").trim();
  if (!path) {
    showToast("Enter a folder path first.");
    return;
  }
  if (!rulesText) {
    showToast("Describe your organization rules first.");
    return;
  }

  filesSetStatus("Asking AI to propose an organization plan…");

  try {
    const res = await fetch("/files/apply_rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: path, rules: rulesText })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Rules planner failed: " + res.status + " · " + txt);
      debugLog("error", "POST /files/apply_rules failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const summary = data.summary || "No plan returned.";
    $("filesRulesSummary").textContent = summary;
    filesSetStatus("Rules plan ready – review the summary on the right.");
    debugLog("info", "POST /files/apply_rules OK");
  } catch (err) {
    filesSetStatus("Rules planner error: " + err.message);
    debugLog("error", "FILES rules planner error: " + err.message);
  }
}

// NEW: Files AI insight power
async function filesAskAiAboutFolder() {
  const path = ($("filesRootInput")?.value || "").trim();
  const box = $("filesInsightBox");
  const btn = $("filesInsightButton");

  if (!box) {
    console.warn("filesInsightBox element is missing.");
    debugLog("warn", "filesInsightBox missing in DOM.");
    return;
  }

  if (!path) {
    box.textContent = "Enter a folder path first, then ask for insight.";
    return;
  }

  let originalLabel = null;
  if (btn) {
    originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Analyzing…";
  }

  box.textContent =
    "Asking your local model for a high-level summary of this folder…";
  debugLog("info", "POST /files/insight root=" + path);

  try {
    const res = await fetch("/files/insight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: path })
    });

    if (!res.ok) {
      let detail = "";
      try {
        const txt = await res.text();
        detail = txt || res.statusText;
      } catch {
        detail = res.statusText;
      }
      box.textContent = "Insight request failed: " + res.status + " · " + detail;
      debugLog("error", "POST /files/insight failed: " + res.status + " · " + detail);
      return;
    }

    const data = await res.json();
    const text =
      data.summary ||
      data.insight ||
      "No insight returned from your local model.";

    box.textContent = text;
    debugLog("info", "POST /files/insight OK");
  } catch (err) {
    console.error("files/insight error:", err);
    box.textContent =
      "Error contacting your local model for folder insight: " + err.message;
    debugLog("error", "FILES insight error: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      if (originalLabel !== null) btn.textContent = originalLabel;
    }
  }
}

function setupFilesPanel() {
  const root = $("filesRootInput");
  if (!root) return;

  // Quick presets for common locations
  document.querySelectorAll("[data-files-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      filesSetPreset(btn.getAttribute("data-files-preset"));
    });
  });

  // Main controls
  $("filesScanButton")?.addEventListener("click", filesScanFolder);
  $("filesPreviewButton")?.addEventListener("click", filesPreviewOrganize);
  $("filesRunButton")?.addEventListener("click", filesRunOrganize);
  $("filesUndoButton")?.addEventListener("click", filesUndoLast);
  $("filesBatchRenameButton")?.addEventListener("click", filesBatchRename);
  $("filesCustomRulesButton")?.addEventListener("click", filesUseCustomRules);
  $("filesInsightButton")?.addEventListener("click", filesAskAiAboutFolder);

  // NEW: Quick action recipes
  $("filesQuickInstallers")?.addEventListener("click", () =>
    filesApplyQuick("Installers", "Installers", "installer files")
  );
  $("filesQuickArchives")?.addEventListener("click", () =>
    filesApplyQuick("Archives", "Archives", "archive files")
  );
  $("filesQuickImages")?.addEventListener("click", () =>
    filesApplyQuick("Images", "Images", "image files")
  );

  filesRenderBuckets();
  filesSetStatus("No scan yet.");
}



// ---------- VISUALIZER (Treemap + filters) ----------
// Open a file/folder on the host OS
async function openPathOnHost(fullPath) {
  if (!fullPath) return;
  try {
    const resp = await fetch("/open_path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error("HTTP " + resp.status + (txt ? " · " + txt : ""));
    }
    try { if (typeof showToast === "function") showToast("Revealed in file manager:\n" + fullPath); } catch {}
    console.log("[VIS] Opened path on host:", fullPath);
    try { if (typeof showToast === "function") showToast("Opened on host:\n" + fullPath); } catch {}
  } catch (err) {
    console.error("[VIS] Failed to open path:", err);
    showToast("Could not open this path in Explorer/Finder:\n" + err.message);
  }
}

async function revealPathOnHost(fullPath) {
  if (!fullPath) return;
  try {
    const resp = await fetch("/open_reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error("HTTP " + resp.status + (txt ? " · " + txt : ""));
    }
  } catch (err) {
    console.error("[VIS] Reveal failed:", err);
    showToast("Could not reveal this path:\n" + (err?.message || err));
  }
}

// Delete a file/folder on the host OS
// deletePathOnHost — defined once below

function getParentFolderPath(fullPath) {
  if (!fullPath) return fullPath;

  // Strip trailing slashes first
  const norm = fullPath.replace(/[\\\/]+$/, "");
  const lastSlash = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));

  // If there's no parent, just return the normalized path
  if (lastSlash <= 0) return norm;

  return norm.slice(0, lastSlash);
}

let lastVisualizerData = null;
let treemapContextMenu = null;
let treemapContextPath = null;
let treemapContextIsDir = false;

const visualizerState = {
  hideTiny: false,
  hideNoisy: false,
};
// Delete a file/folder on the host OS.
// Always moves to Recycle Bin / Trash — never permanently deletes.
async function deletePathOnHost(fullPath, isDir) {
  if (!fullPath) return;

  // Stronger confirmation for directories
  let message;
  if (isDir) {
    message = `Move this folder to the Recycle Bin?\n\n${fullPath}\n\nThe entire folder and its contents will be moved to the Recycle Bin.`;
  } else {
    message = `Move to Recycle Bin?\n\n${fullPath}`;
  }
  if (!confirm(message)) return;

  try {
    const resp = await fetch("/visualizer/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath, permanent: false })
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.detail || "HTTP " + resp.status);
    }

    showToast("Moved to Recycle Bin.", "success");
    const scanBtn = document.getElementById("visualizerScanBtn");
    if (scanBtn) scanBtn.click();
  } catch (err) {
    console.error("[VIS] Delete failed:", err);
    showToast("Could not delete: " + err.message, "error");
  }
}

// Per-category colors (soft WinDirStat vibe)
const TREEMAP_COLORS = {
  documents: "#2b8cff",
  images:    "#ff7a45",
  audio:     "#ffb347",
  video:     "#c472faff",
  code:      "#9b6dff",
  archives:  "#3dd68c",
  system:    "#580f0fff",
  other:     "#4fb3ff"
};


function openInFilesPanel(fullPath, isDir = false) {
  if (!fullPath) return;
  try {
    const dir = isDir ? fullPath : getParentDirFromFullPath(fullPath);
    if (typeof switchPanel === "function") switchPanel("panel-files");
    const input = document.getElementById("filesRootInput");
    if (input) input.value = dir;
    const btn = document.getElementById("filesScanButton");
    if (btn) btn.click();
    try { if (typeof showToast === "function") showToast("Opened in Files panel:\n" + dir); } catch {}
  } catch (err) {
    console.error("[VIS] Open in Files failed:", err);
  }
}

// Show the Visualizer context menu (V4 tables/tree) at the cursor, clamped to viewport.
function showVisContextMenu(evt, fullPath, isDir = false) {
  if (!treemapContextMenu || !fullPath) return;
  evt.preventDefault();
  evt.stopPropagation();
  treemapContextPath = fullPath;
  treemapContextIsDir = !!isDir;

  // Position (clamp inside viewport)
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  treemapContextMenu.style.display = "block";
  treemapContextMenu.style.left = "0px";
  treemapContextMenu.style.top = "0px";

  // Measure after display
  const rect = treemapContextMenu.getBoundingClientRect();
  const mw = rect.width || 220;
  const mh = rect.height || 160;

  let x = (evt.pageX ?? evt.clientX ?? 0);
  let y = (evt.pageY ?? evt.clientY ?? 0);

  x = Math.max(8, Math.min(x, (vw - mw - 8)));
  y = Math.max(8, Math.min(y, (vh - mh - 8)));

  treemapContextMenu.style.left = x + "px";
  treemapContextMenu.style.top = y + "px";
}

// ── Drive tiles loader ────────────────────────────────────────────────────
// Called when the visualizer panel opens. Fetches /agent/disk and renders
// clickable drive cards that auto-fill the path and trigger a scan.
async function loadVisualizerDrives() {
  const container = document.getElementById("vis4-drives");
  if (!container || container._loaded) return;

  try {
    const data = await _fetchJson("/agent/disk");
    const parts = (data && data.partitions) || [];
    if (!parts.length) { container.innerHTML = ""; return; }

    container.innerHTML = "";
    parts.forEach(p => {
      const pct    = Math.round(p.percent_used || 0);
      const isCrit = pct >= 90;
      const isWarn = pct >= 75 && pct < 90;
      const mount  = p.mountpoint || p.device || "?";
      const label  = mount.replace(/\\/g, "").replace(/\//g, "") || mount;

      const tile = document.createElement("button");
      tile.className = "vis4-drive-tile" + (isCrit ? " crit" : isWarn ? " warn" : "");
      tile.title = `${mount} — ${p.used_human} used of ${p.total_human}`;
      tile.innerHTML = `
        <div class="vis4-drive-label">${label}</div>
        <div class="vis4-drive-usage">
          <div class="vis4-drive-bar"><div class="vis4-drive-fill" style="width:${pct}%"></div></div>
          <span class="vis4-drive-pct">${pct}%</span>
        </div>
        <div class="vis4-drive-free">${p.free_human} free</div>
      `;
      tile.addEventListener("click", () => {
        const inp = document.getElementById("visualizerPathInput");
        if (inp) inp.value = mount;
        const btn = document.getElementById("visualizerScanBtn");
        if (btn) btn.click();
      });
      container.appendChild(tile);
    });

    container._loaded = true;
  } catch (e) {
    container.innerHTML = "";
  }
}

function setupVisualizer() {
  const input   = document.getElementById("visualizerPathInput");
  const scanBtn = document.getElementById("visualizerScanBtn");
  const jsonPre = document.getElementById("visualizer-json");
  treemapContextMenu = document.getElementById("treemap-context-menu");

// Ensure context menu exists even if the HTML doesn't include it.
if (!treemapContextMenu) {
  treemapContextMenu = document.createElement("div");
  treemapContextMenu.id = "treemap-context-menu";
  treemapContextMenu.className = "treemap-context-menu";
  treemapContextMenu.style.display = "none";
  treemapContextMenu.innerHTML = `
    <button data-action="open_files">Open in Files</button>
    <button data-action="reveal">Reveal in Explorer/Finder</button>
    <button data-action="open">Open</button>
    <button data-action="copy">Copy path</button>
    <button data-action="delete">Delete</button>
  `;
  document.body.appendChild(treemapContextMenu);
}

  treemapContextPath = null;

  const hideTinyCheckbox  = document.getElementById("visualizerHideTiny");
  const hideNoisyCheckbox = document.getElementById("visualizerHideNoisy");
  const resetBtn          = document.getElementById("visualizerResetViewBtn");

  if (!input || !scanBtn || !jsonPre) {
    console.log("[VIS] Missing core element(s)", { input, scanBtn, jsonPre });
    return;
  }

  // Make sure debug text is readable
  jsonPre.style.color = "#ffffff";
  jsonPre.style.whiteSpace = "pre";

  async function runScan(event) {
    if (event && event.preventDefault) event.preventDefault();

    const path = (input.value || "").trim();

    jsonPre.textContent = `DEBUG: Scan clicked for path:\n${path || "(empty)"}`;
    console.log("[VIS] Scan clicked for path:", path);

    if (!path) {
      jsonPre.textContent += "\n\nEnter a folder path to scan.";
      return;
    }

    try {
      jsonPre.textContent += "\n\nScanning…";
      const url  = "/scan_directory?path=" + encodeURIComponent(path) + "&max_depth=2";
      const resp = await fetch(url);

      console.log("[VIS] Response status:", resp.status);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error("HTTP " + resp.status + (txt ? " · " + txt : ""));
      }

      const data = await resp.json();
      // Mirror the response into the Visualizer JSON debug pane (if present)
      const jsonEl = document.getElementById('visualizer-json');
      if (jsonEl) {
        try { jsonEl.textContent = JSON.stringify(data, null, 2); } catch(e) { jsonEl.textContent = String(data); }
      }

      const jsonText = JSON.stringify(data, null, 2);

      lastVisualizerData = data;
      jsonPre.textContent = jsonText;
      console.log("[VIS] Scan complete, bytes:", jsonText.length);

      renderStorageExplorer(data);
    } catch (err) {
      console.error("Visualizer scan error:", err);
      jsonPre.textContent = "Scan failed:\n" + err.message;
    }
  }

  scanBtn.addEventListener("click", runScan);

  // Checkbox wiring
  if (hideTinyCheckbox) {
    hideTinyCheckbox.addEventListener("change", () => {
      visualizerState.hideTiny = !!hideTinyCheckbox.checked;
      console.log("[VIS] hideTiny ->", visualizerState.hideTiny);
      if (lastVisualizerData) renderStorageExplorer(lastVisualizerData);
    });
  }

  if (hideNoisyCheckbox) {
    hideNoisyCheckbox.addEventListener("change", () => {
      visualizerState.hideNoisy = !!hideNoisyCheckbox.checked;
      console.log("[VIS] hideNoisy ->", visualizerState.hideNoisy);
      if (lastVisualizerData) renderStorageExplorer(lastVisualizerData);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      visualizerState.hideTiny  = false;
      visualizerState.hideNoisy = false;
      if (hideTinyCheckbox)  hideTinyCheckbox.checked = false;
      if (hideNoisyCheckbox) hideNoisyCheckbox.checked = false;
      console.log("[VIS] view reset");
      if (lastVisualizerData) renderStorageExplorer(lastVisualizerData);
    });
  }
  // Close context menu on any regular click
  document.addEventListener("click", () => {
    if (treemapContextMenu) treemapContextMenu.style.display = "none";
  });

  // Handle clicks inside the Visualizer context menu
if (treemapContextMenu) {
  treemapContextMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");

    if (action === "open_files" && treemapContextPath) {
  openInFilesPanel(treemapContextPath, treemapContextIsDir);

} else if (action === "reveal" && treemapContextPath) {
  await revealPathOnHost(treemapContextPath);

} else if (action === "open" && treemapContextPath) {
  await openPathOnHost(treemapContextPath);

} else if (action === "copy" && treemapContextPath) {
  try {
    await navigator.clipboard.writeText(treemapContextPath);
    showToast("Copied path:\n" + treemapContextPath);
  } catch (err) {
    console.error("Clipboard failed:", err);
    showToast("Could not copy to clipboard.");
  }

} else if (action === "delete" && treemapContextPath) {
  await deletePathOnHost(treemapContextPath, treemapContextIsDir);
}

treemapContextMenu.style.display = "none";
  });
}

  console.log("[VIS] setupVisualizer wired");
}

// We still want this global formatter for sizes
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return value.toFixed(value >= 10 ? 0 : 1) + " " + units[i];
}
/* ============================================================
   VISUALIZER COLORS — CUSTOM FILE TYPE MAPPING
   ============================================================ */

// 🎨 Central color mapping for file types
// Edit these hex values to whatever colors you want.
const FILE_TYPE_COLORS = {
  ".mp4": "#c084fc",      // purple
  ".mov": "#e879f9",      // pink-purple
  ".7z":  "#22c55e",      // green
  ".zip": "#16a34a",      // darker green
  ".exe": "#38bdf8",      // light blue
  ".msi": "#0ea5e9",      // medium blue
  ".wav": "#facc15",      // yellow
  ".mp3": "#f97316",      // orange
  ".m4a": "#fb923c",      // softer orange
  ".bin": "#64748b",      // gray

  folder:  "#4ade80",     // folder blocks
  default: "#60a5fa",     // anything not matched above
};

// Extract ".ext" from a filename
function getFileExtension(name) {
  if (!name) return "";
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) return "";
  return name.slice(lastDot).toLowerCase();
}

// NEW colorForNode that uses FILE_TYPE_COLORS
function colorForNode(d) {
  if (!d || !d.data) return FILE_TYPE_COLORS.default;

  // Folders (nodes that have children)
  if (d.data.children && d.data.children.length) {
    return FILE_TYPE_COLORS.folder;
  }

  const ext = getFileExtension(d.data.name || "");
  return FILE_TYPE_COLORS[ext] || FILE_TYPE_COLORS.default;
}

// Categorize files by extension for colors
function getFileCategory(name) {
  if (!name) return "other";
  const lower = name.toLowerCase();

  const docs = [".txt", ".md", ".rtf", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"];
  const images = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"];
  const audio = [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"];
  const video = [".mp4", ".mov", ".mkv", ".avi", ".webm"];
  const archives = [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz"];
  const code = [
    ".js", ".ts", ".jsx", ".tsx",
    ".py", ".json", ".html", ".css",
    ".c", ".cpp", ".h", ".hpp",
    ".cs", ".java", ".php", ".rb", ".rs", ".go", ".sh", ".bat", ".ps1", ".sql"
  ];

  const matchExt = (list) => list.some(ext => lower.endsWith(ext));

  if (matchExt(docs))     return "documents";
  if (matchExt(images))   return "images";
  if (matchExt(audio))    return "audio";
  if (matchExt(video))    return "video";
  if (matchExt(archives)) return "archives";
  if (matchExt(code))     return "code";

  // Very rough system-ish folder hint
  if (
    lower.includes("windows") ||
    lower.includes("program files") ||
    lower.includes("appdata") ||
    lower.includes("node_modules") ||
    lower.startsWith(".")
  ) {
    return "system";
  }

  return "other";
}

function colorForNode(d) {
  const name = (d.data && d.data.name) || "";
  const category = getFileCategory(name);
  return TREEMAP_COLORS[category] || TREEMAP_COLORS.other;
}

// Simple “is this a noisy folder?” helper
function isNoisyName(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  const noisy = [
    "appdata",
    "node_modules",
    "temp",
    "tmp",
    "cache",
    "logs",
    "venv",
    "__pycache__"
  ];
  return noisy.some(n => lower === n || lower.includes(n));
}

// Clone + filter tree so tiny/noisy items are removed before layout
function filterTree(node, rootSize, opts) {
  if (!node) return null;

  const MIN_FRACTION = 0.003; // 0.3% of total; tweak if you want
  const minBytes = rootSize * MIN_FRACTION;

  // If this is a “noisy” folder and we’re hiding noisy stuff, drop the whole subtree
  if (opts.hideNoisy && isNoisyName(node.name)) {
    return null;
  }

  let children = null;
  if (Array.isArray(node.children) && node.children.length > 0) {
    children = node.children
      .map(child => filterTree(child, rootSize, opts))
      .filter(Boolean);
  }

  // Base size: either explicit size or sum of children
  let size = typeof node.size === "number" ? node.size : 0;
  if (children && children.length > 0) {
    size = children.reduce((acc, c) => acc + (c.size || 0), 0);
  }

  // Leaf-level tiny filter
  if (opts.hideTiny && (!children || children.length === 0) && size < minBytes) {
    return null;
  }

  return {
    name: node.name,
    size,
    children: children && children.length ? children : undefined
  };
}
  // Best-effort client-side mirror of backend Safe Mode rules
  function isProtectedSystemPathClient(fullPath) {
    if (!fullPath) return false;
    const lower = fullPath.replace(/\\/g, "/").toLowerCase();

    // Windows
    if (navigator.platform && navigator.platform.toLowerCase().includes("win")) {
      const protectedFiles = [
        "c:/hiberfil.sys",
        "c:/pagefile.sys",
      ];
      const protectedPrefixes = [
        "c:/windows",
        "c:/program files",
        "c:/program files (x86)",
        "c:/programdata",
        "c:/system volume information",
        "c:/$recycle.bin",
      ];

      if (protectedFiles.includes(lower)) return true;
      return protectedPrefixes.some(
        p => lower === p || lower.startsWith(p + "/")
      );
    }

    // macOS
    if (navigator.platform && navigator.platform.toLowerCase().includes("mac")) {
      const prefixes = [
        "/system",
        "/usr",
        "/bin",
        "/sbin",
        "/private",
        "/library",
        "/applications",
        "/volumes/recovery",
      ];
      return prefixes.some(
        p => lower === p || lower.startsWith(p + "/")
      );
    }

    // Generic Linux / Unix
    const posixPrefixes = [
      "/bin",
      "/boot",
      "/dev",
      "/etc",
      "/lib",
      "/lib32",
      "/lib64",
      "/proc",
      "/root",
      "/run",
      "/sbin",
      "/sys",
      "/usr",
      "/var",
      "/snap",
      "/opt",
    ];
    return posixPrefixes.some(
      p => lower === p || lower.startsWith(p + "/")
    );
  }

function renderStorageExplorer(data) {
  // ✅ AAA Visualizer V4: Table-first Storage Intelligence Explorer (no treemap).
  const treeEl   = document.getElementById("visualizerFolderTree");
  const tbody    = document.getElementById("visualizerTableBody");
  const breadcrumbEl = document.getElementById("visualizerBreadcrumb");
  const statusEl = document.getElementById("visualizerStatusLine");
  const selEl    = document.getElementById("visualizerSelectionLine");
  const centerTitle = document.getElementById("visualizerCenterTitle");
  const centerSub   = document.getElementById("visualizerCenterSubtitle");
  const insightsSub = document.getElementById("visualizerInsightsSubtitle");
  const typeBarsEl  = document.getElementById("visualizerTypeBars");
  const topFoldersEl= document.getElementById("visualizerTopFolders");
  const cleanupEl   = document.getElementById("visualizerCleanupHints");
  const detailsBar  = document.getElementById("visualizerDetailsBar");
  const dName       = document.getElementById("visualizerDetailsName");
  const dPath       = document.getElementById("visualizerDetailsPath");
  const dSize       = document.getElementById("visualizerDetailsSize");
  const copyBtn     = document.getElementById("visualizerCopyPathBtn");
  const openBtn     = document.getElementById("visualizerSendToFilesBtn");
  const searchInput = document.getElementById("visualizerSearchInput");
  const catSel      = document.getElementById("visualizerCategoryFilter");
  const extInput    = document.getElementById("visualizerExtFilter");
  const minSizeSel  = document.getElementById("visualizerMinSize");
  const clearBtn    = document.getElementById("visualizerClearFiltersBtn");
  const pillsWrap   = document.getElementById("visualizerModePills");
  const backBtn     = document.getElementById("visualizerBackBtn");

  const jsonEl      = document.getElementById("visualizer-json");
  const debugToggle = document.getElementById("visualizerDebugToggle");

  if (!treeEl || !tbody) return;

  // Debug JSON
  if (debugToggle && !debugToggle._v4Bound) {
    debugToggle._v4Bound = true;
    debugToggle.addEventListener("click", () => {
      if (!jsonEl) return;
      const showing = jsonEl.style.display !== "none";
      jsonEl.style.display = showing ? "none" : "block";
    });
  }
  if (jsonEl) {
    try { jsonEl.textContent = JSON.stringify(data, null, 2); } catch {}
  }

  // --- State ---
  if (!window.visualizerV4) window.visualizerV4 = {};
  const st = window.visualizerV4;

  st.root = data && (data.tree || data.root || data.data || data);
  st.scanPath = data && (data.path || data.scan_path || data.root_path || "");
  st.totalBytes = (st.root && (st.root.size || st.root.total_size)) || 0;

  // Mode pills
  if (!st.mode) st.mode = "map"; // map | offenders | folders | types
  // Folder focus
  if (!st.focusPath) st.focusPath = (st.root && st.root.path) || st.scanPath || "";
  if (!st.history) st.history = [st.focusPath];

  // Sorting
  if (!st.sort) st.sort = { key: "size", dir: "desc" };

  // Filters
  if (!st.filters) st.filters = { q: "", cat: "", ext: "", minMb: 0 };

  // --- Helpers ---
  function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
  function fmtBytes(bytes){
    const b = toNumber(bytes);
    const u = ["B","KB","MB","GB","TB"];
    let v=b, i=0;
    while(v>=1024 && i<u.length-1){ v/=1024; i++; }
    const d = (i===0)?0:(i===1?1:2);
    return v.toFixed(d) + " " + u[i];
  }
  function esc(s){
    return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  }
  function extOf(name){
    const s = String(name||"");
    const i = s.lastIndexOf(".");
    if (i <= 0 || i === s.length-1) return "";
    return s.slice(i).toLowerCase();
  }
  function categoryOf(name, isDir){
    if (isDir) return "Folder";
    const ext = extOf(name);
    const map = [
      ["Models", [".gguf",".safetensors",".pt",".pth",".onnx",".bin",".ckpt",".tflite",".mlmodel",".h5"]],
      ["Video",  [".mp4",".mkv",".mov",".avi",".wmv",".webm",".m4v"]],
      ["Archives",[ ".zip",".rar",".7z",".tar",".gz",".bz2",".xz",".iso",".dmg"]],
      ["Images", [".jpg",".jpeg",".png",".gif",".webp",".tif",".tiff",".bmp",".heic",".raw",".cr2",".nef"]],
      ["Audio",  [".wav",".mp3",".flac",".aiff",".aac",".m4a",".ogg"]],
      ["Dev",    [".js",".ts",".jsx",".tsx",".py",".ipynb",".go",".rs",".java",".cs",".cpp",".c",".h",".json",".yml",".yaml",".toml",".ini",".env",".sql"]],
      ["Docs",   [".pdf",".doc",".docx",".ppt",".pptx",".xls",".xlsx",".txt",".md",".rtf"]]
    ];
    for (const [cat, exts] of map){
      if (exts.includes(ext)) return cat;
    }
    return "Other";
  }

  function walk(node, fn){
    if (!node) return;
    fn(node);
    const ch = Array.isArray(node.children) ? node.children : [];
    for (const c of ch) walk(c, fn);
  }

  // Build index maps (once per scan)
  if (st._indexedAt !== st.root) {
    st._indexedAt = st.root;
    st.nodesByPath = new Map();
    st.files = [];
    st.folders = [];

    walk(st.root, (n) => {
      const path = n.path || n.full_path || n.name || "";
      if (path) st.nodesByPath.set(path, n);

      const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length > 0);
      const size  = toNumber(n.size);
      const name  = n.name || (path ? path.split(/[\\/]/).pop() : "(unnamed)");
      const item = { name, path, size, isDir, category: categoryOf(name, isDir) };

      if (isDir) st.folders.push(item);
      else st.files.push(item);
    });
  }

  function getNode(path){
    return st.nodesByPath.get(path) || st.root;
  }

  function focus(path){
    st.focusPath = path || st.focusPath;
    if (!st.history.length || st.history[st.history.length-1] !== st.focusPath) st.history.push(st.focusPath);
    st.selectedPath = null;
    renderAll();
  }

  function goBack(){
    if (st.history.length <= 1) return;
    st.history.pop();
    st.focusPath = st.history[st.history.length-1];
    st.selectedPath = null;
    renderAll();
  }

  // Bind back button once
  if (backBtn && !backBtn._v4Bound) {
    backBtn._v4Bound = true;
    backBtn.addEventListener("click", goBack);
  }

  // Bind mode pills
  if (pillsWrap && !pillsWrap._v4Bound) {
    pillsWrap._v4Bound = true;
    pillsWrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      st.mode = (btn.getAttribute("data-mode") || "offenders");
      [...pillsWrap.querySelectorAll("button[data-mode]")].forEach(b => b.classList.toggle("active", b===btn));
      renderAll();
    });
  }

  // Bind filters once
  function syncFilterUI(){
    if (searchInput) searchInput.value = st.filters.q || "";
    if (catSel) catSel.value = st.filters.cat || "";
    if (extInput) extInput.value = st.filters.ext || "";
    if (minSizeSel) minSizeSel.value = String(st.filters.minMb || 0);
  }
  syncFilterUI();

  if (searchInput && !searchInput._v4Bound){
    searchInput._v4Bound = true;
    searchInput.addEventListener("input", () => { st.filters.q = searchInput.value.trim(); renderTable(); });
  }
  if (catSel && !catSel._v4Bound){
    catSel._v4Bound = true;
    catSel.addEventListener("change", () => { st.filters.cat = catSel.value; renderTable(); });
  }
  if (extInput && !extInput._v4Bound){
    extInput._v4Bound = true;
    extInput.addEventListener("input", () => { st.filters.ext = extInput.value.trim().toLowerCase(); renderTable(); });
  }
  if (minSizeSel && !minSizeSel._v4Bound){
    minSizeSel._v4Bound = true;
    minSizeSel.addEventListener("change", () => { st.filters.minMb = Number(minSizeSel.value||0); renderTable(); });
  }
  if (clearBtn && !clearBtn._v4Bound){
    clearBtn._v4Bound = true;
    clearBtn.addEventListener("click", () => {
      st.filters = { q:"", cat:"", ext:"", minMb:0 };
      syncFilterUI();
      renderTable();
    });
  }

  // Copy path
  if (copyBtn && !copyBtn._v4Bound){
    copyBtn._v4Bound = true;
    copyBtn.addEventListener("click", async () => {
      if (!st.selectedPath) return;
      try {
        await navigator.clipboard.writeText(st.selectedPath);
        showToast("Copied path.", "success");
      } catch {
        const ta = document.createElement("textarea");
        ta.value = st.selectedPath;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("Copied path.", "success");
      }
    });
  }

  // Open in Files
  if (openBtn && !openBtn._v4Bound){
    openBtn._v4Bound = true;
    openBtn.addEventListener("click", async () => {
      const p = st.selectedPath;
      if (!p) return;
      try {
        const resp = await fetch("/visualizer/open_in_files?path=" + encodeURIComponent(p));
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        showToast("Sent to Files.", "success");
      } catch {
        try { window.__tli_open_path_in_files = p; } catch {}
        try { switchPanel("panel-files"); } catch {}
        showToast("Opening Files panel…", "success");
      }
    });
  }

  function renderBreadcrumb(){
    const fp = st.focusPath || st.scanPath || "(root)";
    if (breadcrumbEl) breadcrumbEl.textContent = fp;
    if (statusEl) statusEl.textContent = `Viewing: ${fp} • Total scanned: ${fmtBytes(st.totalBytes || 0)}`;
    if (insightsSub) insightsSub.textContent = `Scan: ${st.scanPath || fp}`;
    if (backBtn) backBtn.disabled = (st.history.length <= 1);
  }

  function renderSummaryStrip(rowCount){
    const el = document.getElementById("vis4-summary");
    if (!el) return;

    const fp = st.focusPath || st.scanPath || "(root)";
    const bytes = fmtBytes(st.totalBytes || 0);
    const rows = rowCount || 0;

    // Compute top category and top folder (lightweight)
    let topCat = "—", topCatBytes = 0;
    try{
      const focusNode = getNode(st.focusPath);
      const totals = new Map();
      walk(focusNode, (n) => {
        const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
        if (isDir) return;
        const name = n.name || "";
        const cat = categoryOf(name, false);
        totals.set(cat, (totals.get(cat)||0) + toNumber(n.size));
      });
      const entries = [...totals.entries()].sort((a,b)=>b[1]-a[1]);
      if (entries.length){ topCat = entries[0][0]; topCatBytes = entries[0][1]; }
    } catch {}

    let topFolder = "—", topFolderBytes = 0;
    try{
      const focusNode = getNode(st.focusPath);
      const kids = Array.isArray(focusNode.children) ? focusNode.children : [];
      const folders = kids
        .filter(n => (n.is_dir || (Array.isArray(n.children) && n.children.length)) )
        .map(n => [n.name || "(folder)", toNumber(n.size)]);
      folders.sort((a,b)=>b[1]-a[1]);
      if (folders.length){ topFolder = folders[0][0]; topFolderBytes = folders[0][1]; }
    } catch {}

    el.innerHTML = `
      <div class="meta">
        <span class="chip"><span class="k">Scanned</span><span class="v">${esc(bytes)}</span></span>
        <span class="chip"><span class="k">Rows</span><span class="v">${esc(String(rows))}</span></span>
        <span class="chip"><span class="k">Path</span><span class="v">${esc(fp)}</span></span>
      </div>
      <div class="right">
        <span class="chip"><span class="k">Top type</span><span class="v">${esc(topCat)}${topCatBytes ? " • " + esc(fmtBytes(topCatBytes)) : ""}</span></span>
        <span class="chip"><span class="k">Top folder</span><span class="v">${esc(topFolder)}${topFolderBytes ? " • " + esc(fmtBytes(topFolderBytes)) : ""}</span></span>
      </div>
    `;
  }

  function renderTree(){
    const focusNode = getNode(st.focusPath);
    const kids = Array.isArray(focusNode.children) ? focusNode.children : [];
    treeEl.innerHTML = "";
    if (!kids.length){
      const empty = document.createElement("div");
      empty.className = "vis4-empty";
      empty.textContent = "No subfolders found here.";
      treeEl.appendChild(empty);
      return;
    }
    const folders = kids
      .filter(n => (n.is_dir || (Array.isArray(n.children) && n.children.length)))
      .map(n => ({ name: n.name || "(folder)", path: n.path || "", size: toNumber(n.size) }))
      .sort((a,b)=>b.size-a.size)
      .slice(0, 250);

    folders.forEach((f) => {
      const row = document.createElement("div");
      row.className = "vis4-node";
      row.innerHTML = `<div class="tw">▸</div><div class="name">${esc(f.name)}</div><div class="badge">${esc(fmtBytes(f.size))}</div>`;
      row.title = f.path || f.name;
      row.addEventListener("click", () => focus(f.path || f.name));
      row.addEventListener("contextmenu", (e) => showVisContextMenu(e, f.path || f.name, true));
      treeEl.appendChild(row);
    });
  }

  function applyFilters(items){
    const q = (st.filters.q || "").toLowerCase();
    const cat = st.filters.cat || "";
    const ext = (st.filters.ext || "").toLowerCase();
    const minMb = toNumber(st.filters.minMb);
    const minBytes = minMb > 0 ? minMb * 1024 * 1024 : 0;

    return items.filter(it => {
      if (minBytes && it.size < minBytes) return false;
      if (cat && it.category !== cat) return false;

      if (ext){
        const parts = ext.split(/[\s,;]+/).filter(Boolean);
        const e = extOf(it.name);
        if (parts.length){
          let ok=false;
          for (const p of parts){
            const pe = p.startsWith(".") ? p.toLowerCase() : ("."+p.toLowerCase());
            if (e === pe) { ok=true; break; }
          }
          if (!ok) return false;
        }
      }

      if (q){
        const s = (it.name + " " + (it.path||"")).toLowerCase();
        if (!s.includes(q)) return false;
      }
      return true;
    });
  }

  function sortItems(items){
    const { key, dir } = st.sort || { key:"size", dir:"desc" };
    const mult = (dir === "asc") ? 1 : -1;
    return items.slice().sort((a,b) => {
      const av = (a[key] ?? "");
      const bv = (b[key] ?? "");
      if (key === "size"){
        return (toNumber(av) - toNumber(bv)) * mult;
      }
      return String(av).localeCompare(String(bv)) * mult;
    });
  }

  function itemsForMode(){
    const focusNode = getNode(st.focusPath);
    const kids = Array.isArray(focusNode.children) ? focusNode.children : [];

    if (st.mode === "folders"){
      return kids
        .filter(n => (n.is_dir || (Array.isArray(n.children) && n.children.length)))
        .map(n => ({ name: n.name || "(folder)", path: n.path || "", size: toNumber(n.size), isDir:true, category:"Folder" }));
    }

    if (st.mode === "types"){
      const byCat = new Map();
      walk(focusNode, (n) => {
        const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
        if (isDir) return;
        const name = n.name || "(file)";
        const cat = categoryOf(name, false);
        byCat.set(cat, (byCat.get(cat) || 0) + toNumber(n.size));
      });
      return [...byCat.entries()].map(([cat, size]) => ({ name: cat, path: st.focusPath, size, isDir:false, category:cat }));
    }

    const files = [];
    walk(focusNode, (n) => {
      const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
      if (isDir) return;
      const path = n.path || "";
      const name = n.name || (path ? path.split(/[\\/]/).pop() : "(file)");
      files.push({ name, path, size: toNumber(n.size), isDir:false, category: categoryOf(name,false) });
    });
    return files;
  }

  function setCenterTitles(){
    const fp = st.focusPath || st.scanPath || "";
    if (st.mode === "folders"){
      if (centerTitle) centerTitle.textContent = "Largest folders";
      if (centerSub)   centerSub.textContent = `Largest folders in: ${fp}`;
    } else if (st.mode === "types"){
      if (centerTitle) centerTitle.textContent = "File types";
      if (centerSub)   centerSub.textContent = `Storage breakdown inside: ${fp}`;
    } else if (st.mode === "map"){
      if (centerTitle) centerTitle.textContent = "Storage map";
      if (centerSub)   centerSub.textContent = `Visual treemap of: ${fp}`;
    } else {
      if (centerTitle) centerTitle.textContent = "Largest files";
      if (centerSub)   centerSub.textContent = `Largest files inside: ${fp}`;
    }
  }

  function renderTable(){
    setCenterTitles();

    const thead = tbody.closest("table")?.querySelector("thead");
    if (thead && !thead._v4Bound){
      thead._v4Bound = true;
      thead.addEventListener("click", (e) => {
        const th = e.target.closest("th[data-sort]");
        if (!th) return;
        const key = th.getAttribute("data-sort");
        if (!key) return;
        if (st.sort.key === key){
          st.sort.dir = (st.sort.dir === "asc") ? "desc" : "asc";
        } else {
          st.sort.key = key;
          st.sort.dir = (key === "size") ? "desc" : "asc";
        }
        renderTable();
      });
    }

    let items = itemsForMode();
    items = applyFilters(items);
    items = sortItems(items);

    const maxRows = 2500;
    const shown = items.slice(0, maxRows);

    tbody.innerHTML = "";
    if (!shown.length){
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="vis4-empty-row">No matches.</td>`;
      tbody.appendChild(tr);
      if (selEl) selEl.textContent = "No selection.";
      if (detailsBar) detailsBar.style.display = "none";
      if (openBtn) openBtn.disabled = true;
      return;
    }

    shown.forEach((it) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="col-name" title="${esc(it.name)}">${esc(it.name)}</td>
        <td class="col-type">${esc(it.category)}</td>
        <td class="col-size">${esc(fmtBytes(it.size))}</td>
        <td class="col-path" title="${esc(it.path || "")}">${esc(it.path || "")}</td>
      `;
      tr.addEventListener("click", () => select(it));
      tr.addEventListener("contextmenu", (e) => showVisContextMenu(e, it.path || it.name, !!it.isDir));
      tr.addEventListener("dblclick", () => {
        if (it.isDir && it.path) focus(it.path);
      });
      tbody.appendChild(tr);
    });

    if (statusEl){
      statusEl.textContent = `Rows: ${shown.length}${items.length>shown.length ? " (clamped)" : ""} • Total scanned: ${fmtBytes(st.totalBytes || 0)}`;
      renderSummaryStrip(shown.length);
    }
  }

  function select(it){
    st.selectedPath = it.path || it.name;
    st.selectedIsDir = !!it.isDir;
    if (selEl) selEl.textContent = `Selected: ${it.name} • ${fmtBytes(it.size)}`;
    if (detailsBar){
      detailsBar.style.display = "flex";
      dName.textContent = it.name;
      dPath.textContent = st.selectedPath;
      dSize.textContent = fmtBytes(it.size);
    }
    if (openBtn) openBtn.disabled = !st.selectedPath;
  }

  function renderInsights(){
    const focusNode = getNode(st.focusPath);
    const totals = new Map();
    walk(focusNode, (n) => {
      const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
      if (isDir) return;
      const name = n.name || "";
      const cat = categoryOf(name, false);
      totals.set(cat, (totals.get(cat)||0) + toNumber(n.size));
    });

    const entries = [...totals.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 8);
    const max = entries.length ? entries[0][1] : 1;

    if (typeBarsEl){
      typeBarsEl.innerHTML = "";
      if (!entries.length){
        typeBarsEl.innerHTML = `<div class="vis4-empty">No data.</div>`;
      } else {
        entries.forEach(([k,v]) => {
          const wrap = document.createElement("div");
          wrap.className = "vis4-item";
          wrap.innerHTML = `<div class="k">${esc(k)}</div><div class="v">${esc(fmtBytes(v))}</div>`;
          const bar = document.createElement("div");
          bar.className = "vis4-bar";
          const fill = document.createElement("div");
          fill.style.width = Math.max(6, Math.round((v/max)*100)) + "%";
          bar.appendChild(fill);
          typeBarsEl.appendChild(wrap);
          typeBarsEl.appendChild(bar);
        });
      }
    }

    if (topFoldersEl){
      topFoldersEl.innerHTML = "";
      const kids = Array.isArray(focusNode.children) ? focusNode.children : [];
      const folders = kids
        .filter(n => (n.is_dir || (Array.isArray(n.children) && n.children.length)))
        .map(n => ({ name: n.name || "(folder)", path: n.path || "", size: toNumber(n.size) }))
        .sort((a,b)=>b.size-a.size)
        .slice(0, 10);

      if (!folders.length){
        topFoldersEl.innerHTML = `<div class="vis4-empty">No folders.</div>`;
      } else {
        folders.forEach(f => {
          const row = document.createElement("div");
          row.className = "vis4-item";
          row.innerHTML = `<div class="k" title="${esc(f.path||f.name)}">${esc(f.name)}</div><div class="v">${esc(fmtBytes(f.size))}</div>`;
          row.addEventListener("click", () => focus(f.path || f.name));
          topFoldersEl.appendChild(row);
        });
      }
    }

    if (cleanupEl){
      const hints = [];
      const p = (st.focusPath || st.scanPath || "").toLowerCase();
      if (p.includes("downloads")) hints.push(["Downloads", "Review old installers & archives"]);
      if (p.includes("temp") || p.includes("cache")) hints.push(["Cache/Temp", "Often safe to clear (app-dependent)"]);
      cleanupEl.innerHTML = "";
      if (!hints.length){
        cleanupEl.innerHTML = `<div class="vis4-empty">No obvious signals here yet.</div>`;
      } else {
        hints.slice(0,6).forEach(([k,v]) => {
          const row = document.createElement("div");
          row.className = "vis4-item";
          row.innerHTML = `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`;
          cleanupEl.appendChild(row);
        });
      }
    }
  }

  // ── D3 Treemap ────────────────────────────────────────────────────────────
  const _TM_COLORS = {
    Folder: "#10b981", Models: "#7c3aed", Video: "#f59e0b",
    Archives: "#f97316", Images: "#ec4899", Audio: "#06b6d4",
    Dev: "#3b82f6", Docs: "#94a3b8", Other: "#6b7280",
  };

  function renderTreemapD3() {
    const container = document.getElementById("vis4-treemap-container");
    if (!container) return;
    container.innerHTML = "";

    if (typeof d3 === "undefined") {
      container.innerHTML = '<div class="vis4-empty">D3 not loaded — check /assets/d3.v7.min.js</div>';
      return;
    }

    const focusNode = getNode(st.focusPath);
    if (!focusNode) { container.innerHTML = '<div class="vis4-empty">No data.</div>'; return; }

    const W = Math.max(container.clientWidth || 600, 300);
    const H = Math.max(Math.round(W * 0.58), 340);

    const root = d3.hierarchy(focusNode)
      .sum(d => (!d.children || !d.children.length) ? Math.max(1, toNumber(d.size)) : 0)
      .sort((a, b) => b.value - a.value);

    d3.treemap()
      .size([W, H])
      .paddingOuter(3)
      .paddingInner(1)
      .paddingTop(18)
      .round(true)(root);

    const svg = d3.create("svg")
      .attr("width", W).attr("height", H)
      .attr("viewBox", `0 0 ${W} ${H}`)
      .style("display", "block").style("overflow", "hidden")
      .style("border-radius", "6px").style("background", "#0f172a");

    // Folder header bands (non-leaf nodes)
    svg.selectAll(".tm-dir")
      .data(root.descendants().filter(d => d.depth > 0 && d.children))
      .join("g").attr("class","tm-dir")
      .attr("transform", d => `translate(${d.x0},${d.y0})`)
      .call(g => {
        g.append("rect")
          .attr("width", d => Math.max(0, d.x1-d.x0))
          .attr("height", 16)
          .attr("fill", "#10b981").attr("opacity", 0.18).attr("rx", 2);
        g.append("text")
          .attr("x", 4).attr("y", 12)
          .attr("fill", "#a7f3d0").attr("font-size", "10px")
          .text(d => {
            const avail = Math.floor((d.x1-d.x0) / 6.2);
            const name = d.data.name || "";
            return name.length > avail ? name.slice(0, avail-1)+"…" : name;
          });
        g.style("cursor","pointer")
          .on("click", (_, d) => { if (d.data.path) focus(d.data.path); });
      });

    // Leaf tiles
    const leaf = svg.selectAll(".tm-leaf")
      .data(root.leaves())
      .join("g").attr("class","tm-leaf")
      .attr("transform", d => `translate(${d.x0},${d.y0})`);

    leaf.append("rect")
      .attr("width",  d => Math.max(0, d.x1-d.x0))
      .attr("height", d => Math.max(0, d.y1-d.y0))
      .attr("fill", d => _TM_COLORS[categoryOf(d.data.name||"", false)] || _TM_COLORS.Other)
      .attr("opacity", 0.72).attr("rx", 2).attr("stroke","#0f172a").attr("stroke-width",0.5);

    // Name label
    leaf.filter(d => (d.x1-d.x0) > 32 && (d.y1-d.y0) > 16)
      .append("text")
      .attr("x", 3).attr("y", 13)
      .attr("fill","#fff").attr("font-size","10px")
      .attr("pointer-events","none")
      .text(d => {
        const avail = Math.floor((d.x1-d.x0) / 5.8);
        const name = d.data.name || "";
        return name.length > avail ? name.slice(0, avail-1)+"…" : name;
      });

    // Size label
    leaf.filter(d => (d.x1-d.x0) > 44 && (d.y1-d.y0) > 30)
      .append("text")
      .attr("x", 3).attr("y", 25)
      .attr("fill","rgba(255,255,255,0.55)").attr("font-size","9px")
      .attr("pointer-events","none")
      .text(d => fmtBytes(d.data.size || d.value || 0));

    // Tooltip
    let _tip = document.getElementById("_tli_vis_tip");
    if (!_tip) {
      _tip = document.createElement("div");
      _tip.id = "_tli_vis_tip";
      _tip.style.cssText = "position:fixed;background:#0f172a;border:1px solid #10b981;color:#e2e8f0;padding:7px 11px;border-radius:6px;font-size:12px;pointer-events:none;z-index:9999;display:none;line-height:1.5;max-width:280px;word-break:break-all;";
      document.body.appendChild(_tip);
    }
    leaf.on("mousemove", (event, d) => {
      _tip.style.display = "block";
      _tip.style.left = (event.clientX+14)+"px";
      _tip.style.top  = (event.clientY-36)+"px";
      const cat = categoryOf(d.data.name||"",false);
      _tip.innerHTML = `<b style="color:#a7f3d0">${esc(d.data.name||"")}</b><br>${esc(fmtBytes(toNumber(d.data.size||d.value||0)))} · ${esc(cat)}<br><span style="color:#64748b;font-size:10px">${esc(d.data.path||"")}</span>`;
    }).on("mouseleave", () => { _tip.style.display = "none"; });

    leaf.style("cursor","pointer")
      .on("click", (_, d) => {
        select({ name: d.data.name||"", path: d.data.path||"", size: toNumber(d.data.size||d.value||0), isDir:false, category: categoryOf(d.data.name||"",false) });
      })
      .on("contextmenu", (event, d) => showVisContextMenu(event, d.data.path||d.data.name||"", false));

    container.appendChild(svg.node());
  }

  // ── renderAll ────────────────────────────────────────────────────────────
  function renderAll(){
    renderBreadcrumb();
    renderTree();
    renderInsights();

    const tableWrap = tbody && tbody.closest(".vis4-table-wrap");
    const tmContainer = document.getElementById("vis4-treemap-container");
    const isMap = st.mode === "map";

    if (tableWrap) tableWrap.style.display = isMap ? "none" : "";
    if (tmContainer) tmContainer.style.display = isMap ? "block" : "none";

    if (isMap) {
      renderTreemapD3();
    } else {
      renderTable();
    }
  }

  renderAll();
}

function getNodePath(node) {
  if (!node) return null;

  const ancestors = node.ancestors().reverse();
  const root = ancestors[0];

  // Full absolute path of the scanned directory
  const rootPath = root.data?.path || root.data?.name || "";

  // Build tail path from children
  const parts = ancestors
    .slice(1)
    .map(a => a.data?.name)
    .filter(Boolean);

  let sep = "\\"; // Windows default
  if (rootPath.includes("/")) sep = "/";

  const tail = parts.join(sep);

  // Ensure proper joining:
  // rootPath + "\" + subdirs...
  if (!tail) return rootPath;

  return rootPath.replace(/[\\\/]$/, "") + sep + tail;
}


// Re-render on resize so the treemap always fills the panel nicely
window.addEventListener("resize", () => {
  if (lastVisualizerData) {
    renderStorageExplorer(lastVisualizerData);
  }
});






// ---------- tools panel ----------
async function refreshToolsList() {
  const select = $("tools-select");
  if (!select) return;
  try {
    const res = await fetch("/tools/list");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const tools = data.tools || [];
    select.innerHTML = "";
    if (!tools.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "No tools registered";
      select.appendChild(opt);
      return;
    }
    const placeholder = document.createElement("option");
    placeholder.value = ""; placeholder.textContent = "Select a tool…";
    select.appendChild(placeholder);
    tools.forEach(tool => {
      const opt = document.createElement("option");
      opt.value = tool.id; opt.textContent = tool.label || tool.id;
      select.appendChild(opt);
    });
    debugLog("info", "GET /tools/list OK, tools=" + tools.length);
  } catch (err) {
    select.innerHTML = '<option value="">Error loading tools</option>';
    debugLog("error", "GET /tools/list failed: " + err.message);
  }
}

// NEW: ask /chat to interpret a tool's raw output for humans
async function explainToolOutput(toolLabel, rawOutput) {
  const summaryBox = $("tools-explain-box");
  if (!summaryBox) return;

  // Show interim status
  summaryBox.textContent = "Asking your LAN AI to interpret this tool’s output…";

  try {
    // MIGRATE TO: /api/ai/chat  (chat_routes.py /chat is legacy — see deprecation header)
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: currentDeviceId || "dev-browser",
        brain: "auto",
        mode: "default",
        teaching_mode: true,
        temperature: 0.3,
        max_tokens: 320,
        message:
          `A local diagnostic tool called "${toolLabel}" just ran and produced the following output:\n\n` +
          rawOutput +
          `\n\nExplain, in 3–6 short bullet points, what this result means in simple language for a non-technical user. ` +
          `Mention if everything looks healthy or if there are any obvious issues. Do NOT repeat the whole JSON.`
      })
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const reply = data.reply || data.answer || "";
    summaryBox.textContent = reply || "Could not interpret the output.";
    debugLog("info", "POST /chat (tool explain) OK");
  } catch (err) {
    summaryBox.textContent =
      "Couldn't interpret the output via local model: " + err.message;
    debugLog("error", "POST /chat (tool explain) failed: " + err.message);
  }
}

function setupToolsPanel() {
  const runBtn = $("tools-run-btn");
  if (!runBtn) return;

  // Set default explainer text
  const summaryBox = $("tools-explain-box");
  if (summaryBox) {
    summaryBox.textContent =
      "Run a tool to see a short explanation of the results here. The JSON below is the raw output for advanced users.";
  }

  runBtn.addEventListener("click", async () => {
    const id = $("tools-select").value;
    if (!id) return;
    const paramsText = $("tools-params").value.trim();
    let params = {};
    if (paramsText) {
      try { params = JSON.parse(paramsText); }
      catch { params = { raw: paramsText }; }
    }

    const outputCard = $("tools-output");
    const pre = outputCard ? outputCard.querySelector("pre") : null;
    const summaryBoxLocal = $("tools-explain-box");

    if (pre) pre.textContent = "Running tool…";
    if (summaryBoxLocal) {
      summaryBoxLocal.textContent = "Running tool and preparing a plain-language summary…";
    }

    // Grab the human-friendly label for the tool, if available
    const selectEl = $("tools-select");
    let toolLabel = id;
    if (selectEl && selectEl.selectedIndex >= 0) {
      const opt = selectEl.options[selectEl.selectedIndex];
      if (opt && opt.textContent) toolLabel = opt.textContent;
    }

    debugLog("info", "POST /tools/run tool_id=" + id);

    try {
      const res = await fetch("/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_id: id, params })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      const outputText = data.output || JSON.stringify(data, null, 2);
      if (pre) pre.textContent = outputText;

      debugLog("info", "POST /tools/run OK for " + id);

      // Now ask /chat to interpret the result
      await explainToolOutput(toolLabel, outputText);
    } catch (err) {
      if (pre) pre.textContent = "Error: " + err.message;
      if (summaryBoxLocal) {
        summaryBoxLocal.textContent = "The tool failed to run, so there is nothing to interpret.";
      }
      debugLog("error", "POST /tools/run failed: " + err.message);
    }
  });
}

// ---------- scripts presets powered by Files panel ----------

// Build a summary of whatever the Files panel last scanned,
// so the Scripts panel can reference it in backup prompts.
function getFilesContextForScripts() {
  const root = ($("filesRootInput")?.value || "").trim();
  const ctx = {
    root,
    totalFiles: 0,
    bucketNames: [],
    docBuckets: [],
    mediaBuckets: [],
    summaryText: ""
  };

  if (!filesLastScanBuckets || !filesLastScanBuckets.buckets) {
    ctx.summaryText =
      root
        ? `TLI previously scanned "${root}", but no structured bucket data is available.`
        : `No recent File Organizer scan is available yet.`;
    return ctx;
  }

  const buckets = filesLastScanBuckets.buckets || {};
  const names = Object.keys(buckets);
  ctx.bucketNames = names;

  let total = 0;
  names.forEach(name => {
    const files = buckets[name] || [];
    total += files.length;

    const lower = (name || "").toLowerCase();
    if (/(doc|pdf|office|word|text|docs)/.test(lower)) {
      ctx.docBuckets.push(name);
    }
    if (/(photo|image|picture|media|video|audio|music|jpg|jpeg|png|mp4|mov|wav|mp3)/.test(lower)) {
      ctx.mediaBuckets.push(name);
    }
  });
  ctx.totalFiles = total;

  const topBuckets = names.slice(0, 5).join(", ") || "no named buckets";
  ctx.summaryText =
    `TLI's File Organizer last scanned "${root || "(no path specified)"}" ` +
    `and grouped about ${total} files into buckets like: ${topBuckets}.`;

  return ctx;
}

// Build a natural-language prompt for the Scripts playground
// so it can ask the local model to write backup scripts.
function buildBackupScriptPrompt(kind) {
  const ctx = getFilesContextForScripts();

  const rootText = ctx.root || "the main working folder";
  const baseIntro =
    "You are my local automation assistant that writes real-world backup scripts " +
    "for Windows or Linux. Use robust, production-ready patterns (logging, error handling, " +
    "and safety checks) but keep the script readable.";

  const fileContextParagraph =
    ctx.summaryText +
    " Use this context purely as a hint about the kinds of files and folders involved.";

  if (kind === "folder") {
    return (
      `${baseIntro}\n\n` +
      `Write a PowerShell script that backs up the folder "${rootText}" to a user-configurable ` +
      `backup destination. Requirements:\n` +
      `- Preserve the folder structure.\n` +
      `- Only copy new or changed files (incremental style).\n` +
      `- Create a timestamped subfolder for each backup.\n` +
      `- Log what was copied and any errors to a .log file.\n` +
      `- Include clear comments so a non-expert can adjust source/target paths.\n\n` +
      fileContextParagraph
    );
  }

  if (kind === "docs") {
    const docHint =
      ctx.docBuckets.length
        ? `These buckets look document-heavy: ${ctx.docBuckets.join(", ")}.`
        : "Assume typical office documents like .docx, .xlsx, .pptx, and .pdf.";

    return (
      `${baseIntro}\n\n` +
      `Write a PowerShell script that finds and backs up important documents under "${rootText}".\n` +
      `Requirements:\n` +
      `- Target office-style files (.docx, .xlsx, .pptx, .pdf, .txt) recursively.\n` +
      `- Copy them into a "DocumentsBackup" folder under a user-chosen backup root.\n` +
      `- Use a timestamped subfolder so older backups are preserved.\n` +
      `- Skip temporary / cache folders if possible.\n` +
      `- Log a short summary of how many files were backed up.\n\n` +
      `${docHint}\n\n` +
      fileContextParagraph
    );
  }

  if (kind === "media") {
    const mediaHint =
      ctx.mediaBuckets.length
        ? `These buckets look media-heavy: ${ctx.mediaBuckets.join(", ")}.`
        : "Assume common photo/video/audio formats like .jpg, .png, .mp4, .mov, .wav, .mp3.";

    return (
      `${baseIntro}\n\n` +
      `Write a PowerShell script that backs up photos, videos, and audio files from "${rootText}".\n` +
      `Requirements:\n` +
      `- Target common media extensions (jpg, jpeg, png, gif, mp4, mov, wav, mp3, flac, etc.).\n` +
      `- Organize the backup into separate subfolders for Photos, Video, and Audio.\n` +
      `- Avoid duplicating files that already exist at the destination (compare name+size or hash).\n` +
      `- Generate a summary report at the end listing how many media files were copied or skipped.\n\n` +
      `${mediaHint}\n\n` +
      fileContextParagraph
    );
  }

  // Fallback generic backup suggestion
  return (
    `${baseIntro}\n\n` +
    `Write a PowerShell script that performs a safe backup of "${rootText}" with incremental ` +
    `behavior, timestamped backup folders, and a human-readable log file.\n\n` +
    fileContextParagraph
  );
}

// ---------- scripts panel ----------
function setupScriptsPanel() {
  if (setupScriptsPanel._done) return;
  setupScriptsPanel._done = true;
  const btn       = $("scripts-generate-btn");
  const promptBox = $("scripts-prompt");
  if (!btn || !promptBox) return;

  // Preset buttons that talk to the Files panel context
  const fullBackupBtn = $("scripts-preset-backup-folder");
  const docsBackupBtn = $("scripts-preset-backup-docs");
  const mediaBackupBtn = $("scripts-preset-backup-media");

  function applyPresetPrompt(text) {
    if (!text) return;
    promptBox.value = text;
    promptBox.focus();
    // Put cursor at end so you can tweak the prompt
    promptBox.selectionStart = promptBox.selectionEnd = promptBox.value.length;
  }

  if (fullBackupBtn) {
    fullBackupBtn.addEventListener("click", () => {
      const prompt = buildBackupScriptPrompt("folder");
      applyPresetPrompt(prompt);
    });
  }

  if (docsBackupBtn) {
    docsBackupBtn.addEventListener("click", () => {
      const prompt = buildBackupScriptPrompt("docs");
      applyPresetPrompt(prompt);
    });
  }

  if (mediaBackupBtn) {
    mediaBackupBtn.addEventListener("click", () => {
      const prompt = buildBackupScriptPrompt("media");
      applyPresetPrompt(prompt);
    });
  }

  // ── Danger scanner ───────────────────────────────────────────
  function _scanScriptDanger(code) {
    const flags = [];
    const c = code.toLowerCase();

    const checks = [
      // Deletion / wipe
      { re: /remove-item.{0,60}-recurse.{0,30}-force|rm\s+-rf|del\s+\/[fsq]/i,        msg: "Recursive force-delete detected — verify the target path carefully before running." },
      { re: /format-volume|format\s+[a-z]:|diskpart/i,                                  msg: "Drive formatting command detected — this will permanently erase a drive." },
      { re: /clear-disk|initialize-disk/i,                                               msg: "Disk initialisation detected — all data on the target will be lost." },
      // Registry
      { re: /reg\s+delete|remove-itemproperty|remove-item.{0,60}hk[lcu][mr]/i,          msg: "Registry deletion detected — incorrect registry changes can break Windows." },
      { re: /reg\s+add|set-itemproperty.{0,80}hk[lcu][mr]/i,                            msg: "Registry modification detected — review the key and value before running." },
      // System paths
      { re: /c:\\windows\\system32|%systemroot%|%windir%/i,                              msg: "System32/Windows directory targeted — modifying system files can destabilise the OS." },
      // Execution policy / code injection
      { re: /set-executionpolicy\s+unrestricted|bypass/i,                                msg: "Execution policy bypass — only use this intentionally and revert it after." },
      { re: /invoke-expression|iex\s*\(|\[scriptblock\]::create/i,                       msg: "Dynamic code execution (iex/Invoke-Expression) — review carefully for injection risk." },
      // Network downloads
      { re: /invoke-webrequest|iwr\s|wget\s|curl\s.{0,60}https?:/i,                     msg: "Network download detected — verify the source URL before running." },
      { re: /downloadstring|downloadfile|net\.webclient/i,                               msg: "Web download via .NET — confirm the URL is trusted." },
      // User / privilege management
      { re: /net\s+user\s+.{0,40}\/add|add-localuser|new-localuser/i,                   msg: "User account creation detected — review permissions being granted." },
      { re: /net\s+localgroup\s+administrators|add-localgroupmember.{0,40}administrator/i, msg: "Admin group modification — this grants full system privileges." },
      // Shutdown / restart
      { re: /stop-computer|restart-computer|shutdown\s+\/[rsf]/i,                        msg: "System shutdown or restart command present — make sure this is intentional." },
      // Process termination
      { re: /stop-process\s+-name\s+\*|get-process\s*\|\s*stop-process|taskkill\s+\/f\s+\/im\s+\*/i, msg: "Bulk process termination detected — this will kill running applications." },
      // Firewall / network config
      { re: /netsh\s+(advfirewall|firewall)\s+(set|add|delete)/i,                        msg: "Firewall rule modification — review the rule before applying." },
      // Credential exposure
      { re: /convertto-securestring.{0,60}-asplaintext|-password\s+['\"][^'"]{4}/i,      msg: "Plaintext password in script — consider using a Vault reference instead." },
    ];

    for (const { re, msg } of checks) {
      if (re.test(code)) flags.push(msg);
    }

    return flags;
  }

  function _showScriptWarning(flags, outputEl) {
    const existing = document.getElementById("scripts-danger-banner");
    if (existing) existing.remove();
    if (!flags.length) return;

    const banner = document.createElement("div");
    banner.id = "scripts-danger-banner";
    banner.style.cssText = `
      margin-bottom: 10px; padding: 12px 14px;
      background: rgba(239,68,68,0.08); border: 1.5px solid #ef4444;
      border-radius: var(--radius-md); font-size: 13px;
    `;
    const isCritical = flags.some(f => /format|wipe|erase|system32|admin|bulk process/i.test(f));
    banner.innerHTML =
      `<div style="font-weight:700; color:#ef4444; margin-bottom:6px;">` +
      (isCritical ? "⛔ HIGH RISK — Read before running" : "⚠️ Review before running") +
      `</div>` +
      `<ul style="margin:0; padding-left:18px; color:var(--text-main); line-height:1.7;">` +
      flags.map(f => `<li>${f}</li>`).join("") +
      `</ul>` +
      `<div style="margin-top:8px; font-size:12px; color:var(--text-muted);">` +
      `TLI never runs scripts automatically. Copy only after you understand every line.` +
      `</div>`;

    outputEl.parentNode.insertBefore(banner, outputEl);
  }

  // ── Safe system prompt ───────────────────────────────────────
  const SCRIPTS_SYSTEM_PROMPT = [
    "You are a careful, safety-conscious script writer for a local home server tool called TLI.",
    "Rules you MUST follow:",
    "1. Output only the script — no prose before or after it.",
    "2. For ANY destructive operation (delete, overwrite, format, stop service), add a -WhatIf dry-run",
    "   flag or a confirmation prompt BEFORE the real operation, with a clear comment explaining the risk.",
    "3. Wrap all file/registry/system operations in try/catch (PowerShell) or set -e / trap (Bash).",
    "4. Add a short comment above each logical block explaining what it does in plain English.",
    "5. Never use -Force on recursive deletions without a visible warning comment.",
    "6. Never hardcode credentials — add a comment to use a Vault reference or prompt for input.",
    "7. Prefer -WhatIf, -Confirm, or dry-run modes by default; let the user remove them to go live.",
    "8. If the request could cause irreversible data loss, output a dry-run version first and note it.",
  ].join("\n");

  // Generate — bundled AI streaming with LM Studio fallback
  btn.addEventListener("click", async () => {
    const prompt = promptBox.value.trim();
    if (!prompt) return;

    const outputEl = $("scripts-output");
    outputEl.value = "";
    const existing = document.getElementById("scripts-danger-banner");
    if (existing) existing.remove();

    btn.disabled = true;
    btn.textContent = "Generating…";

    let streamed = false;
    let accumulated = "";

    // 1) Try bundled AI (streaming)
    try {
      await tliBundledChatStream({
        message: SCRIPTS_SYSTEM_PROMPT + "\n\nScript request:\n" + prompt,
        max_tokens: 1200,
        temperature: 0.1,
        onDelta: (chunk) => {
          accumulated += chunk;
          outputEl.value = accumulated;
          outputEl.scrollTop = outputEl.scrollHeight;
        },
      });
      streamed = true;
      debugLog("info", "Scripts: bundled AI stream OK");
    } catch (e) {
      debugLog("warn", "Scripts: bundled stream failed, trying /chat: " + e.message);
    }

    // 2) Fallback: /chat
    if (!streamed) {
      try {
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id: currentDeviceId || "dev-browser",
            message: SCRIPTS_SYSTEM_PROMPT + "\n\nScript request:\n" + prompt,
            brain: "auto",
            mode: "dev",
          })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        accumulated = data.reply || data.answer || "";
        outputEl.value = accumulated;
        debugLog("info", "Scripts: /chat fallback OK");
      } catch (err) {
        outputEl.value = "# Error: " + err.message;
        debugLog("error", "Scripts: all AI routes failed: " + err.message);
      }
    }

    // Danger scan — runs regardless of which AI path was used
    if (accumulated && accumulated.trim() && !accumulated.startsWith("# Error")) {
      const flags = _scanScriptDanger(accumulated);
      if (flags.length) _showScriptWarning(flags, outputEl);
    }

    btn.disabled = false;
    btn.textContent = "Ask AI for script";
  });
}

// ---------- USB / Devices panel ----------

// Decide if a device looks like storage and extract its mount path (if any)
function getUsbStorageInfo(dev) {
  const name = (dev.name || dev.product || dev.description || "").toLowerCase();
  const cls  = (dev.device_class || dev.type || "").toLowerCase();

  const isMassStorage =
    !!dev.is_storage ||
    name.includes("mass storage") ||
    name.includes("external") ||
    cls.includes("storage");

  const mountPath =
    dev.mount_path ||
    dev.mount ||
    dev.drive_letter ||
    dev.drive ||
    "";

  return { isMassStorage, mountPath };
}

// ---------- Mesh / Nodes panel ----------

function renderMeshNode(node) {
  const summaryEl    = $("mesh-node-summary");
  const idEl         = $("mesh-node-id");
  const nameEl       = $("mesh-node-name");
  const roleEl       = $("mesh-node-role");
  const joinModeEl   = $("mesh-node-join-mode");
  const hostAddrEl   = $("mesh-node-host-address");
  const createdEl    = $("mesh-node-created");
  const lastSeenEl   = $("mesh-node-last-seen");
  const joinStatusEl = $("mesh-join-status");

  // If nothing configured yet
  if (!node) {
    if (summaryEl)    summaryEl.textContent    = "Mesh not configured on this node yet.";
    if (idEl)         idEl.textContent         = "—";
    if (nameEl)       nameEl.textContent       = "—";
    if (roleEl)       roleEl.textContent       = "—";
    if (joinModeEl)   joinModeEl.textContent   = "—";
    if (hostAddrEl)   hostAddrEl.textContent   = "—";
    if (createdEl)    createdEl.textContent    = "—";
    if (lastSeenEl)   lastSeenEl.textContent   = "—";
    if (joinStatusEl) joinStatusEl.textContent = "Not currently joined to a host.";
    return;
  }

  const isHost  = !!(node.is_host || node.role === "host");
  const roleRaw = (node.role || (isHost ? "host" : "node")).toString().toLowerCase();

  const roleLabel = isHost
    ? "Host"
    : roleRaw.charAt(0).toUpperCase() + roleRaw.slice(1);
  // Show/hide mesh controls based on role
  const becomeHostBtn = $("mesh-become-host-btn");
  const joinInput     = $("mesh-join-host-address");
  const joinBtn       = $("mesh-join-btn");

  if (becomeHostBtn) {
    // Only standalone nodes can promote themselves to Host
    if (isHost || roleRaw === "member") {
      becomeHostBtn.style.display = "none";
    } else {
      becomeHostBtn.style.display = "";
    }
  }

  if (joinInput && joinBtn) {
    // Host never joins another host
    const disableJoin = isHost;
    joinInput.disabled = disableJoin;
    joinBtn.disabled   = disableJoin;
  }

  const name =
    node.display_name ||
    node.node_name ||
    node.device_name ||
    node.device_id ||
    "Unnamed node";

  // Top-right pill-style summary
  if (summaryEl) {
    if (isHost) {
      summaryEl.textContent = `${name} · HOST of this Home Mesh`;
    } else if (roleRaw === "member") {
      const hostAddr = node.host_address || "host";
      summaryEl.textContent = `${name} · Joined to ${hostAddr}`;
    } else {
      summaryEl.textContent = `${name} · Standalone node`;
    }
  }

  // Detail fields
  if (idEl)       idEl.textContent       = node.node_id || node.device_id || "—";
  if (nameEl)     nameEl.textContent     = name;
  if (roleEl)     roleEl.textContent     = roleLabel;
  if (joinModeEl) joinModeEl.textContent = node.join_mode || node.mode || (isHost ? "host" : "standalone");
  if (hostAddrEl) hostAddrEl.textContent = node.host_address || (isHost ? "This node" : "—");
  if (createdEl)  createdEl.textContent  = node.created_at || "—";
  if (lastSeenEl) lastSeenEl.textContent = node.last_seen || "—";

  // Themed, human-readable join status line under the input
  if (joinStatusEl) {
    if (isHost) {
      joinStatusEl.textContent = "This node is the Host of the Home Mesh.";
    } else if (roleRaw === "member") {
      const hostAddr = node.host_address || "the host";
      joinStatusEl.textContent = `This node is joined to ${hostAddr}.`;
    } else {
      joinStatusEl.textContent = "Not currently joined to a host.";
    }
  }

  debugLog("mesh", "info", "Rendered mesh node config");
}

function renderMeshDirectory(directory) {
  const hostCard = $("mesh-host-card");
  const statusEl = $("mesh-directory-status");
  const listEl   = $("mesh-directory-list");

  if (!hostCard || !statusEl || !listEl) return;

  // Is this node currently the Host?
  const isHostNode =
    currentNodeConfig &&
    (currentNodeConfig.is_host || currentNodeConfig.role === "host");

  // If we have no directory data:
  //   - Non-host: hide the card
  //   - Host: keep the card visible, just clear the list
  if (!directory || !Array.isArray(directory.devices)) {
    if (!isHostNode) {
      hostCard.style.display = "none";
      statusEl.textContent =
        "This node is not acting as a Host. Only the Host can approve or block other nodes.";
    } else {
      hostCard.style.display = "";
      statusEl.textContent = "No other nodes have requested access yet.";
    }
    listEl.innerHTML = "";
    return;
  }

  // We have a directory and devices – always show the card
  hostCard.style.display = "";

  // 🔹 Filter + de-duplicate devices:
  //   - remove THIS node (is_self/self)
  //   - collapse multiple entries with the same IP
  const rawDevices = directory.devices || [];
  const deduped = [];
  const seenIps = new Set();

  for (const dev of rawDevices) {
    const isSelf = dev.is_self || dev.self || false;
    if (isSelf) continue; // don't show the Host itself in the list

    const ip = dev.ip || "";
    if (!ip) continue;    // 🔹 skip “ghost” nodes with no IP (they look gross + unusable)

    if (seenIps.has(ip)) continue; // de-dupe by IP
    seenIps.add(ip);

    deduped.push(dev);
  }

  const devices = deduped;


  if (!devices.length) {
    statusEl.textContent = "No other nodes have joined yet.";
    const emptyEl = $("mesh-directory-empty");
    if (emptyEl) emptyEl.style.display = "";
    return;
  }
  const emptyEl = $("mesh-directory-empty");
  if (emptyEl) emptyEl.style.display = "none";

  statusEl.textContent = `Total nodes: ${devices.length}`;

  // Helper: compute health state from last_seen + mesh status
  function computeNodeHealth(device) {
    try {
      const state = (device.state || device.status || "").toLowerCase();
      const lastSeenStr =
        device.last_seen || device.lastSeen || device.lastHeartbeat;
      const now = Date.now();

      let ageMs = null;
      if (lastSeenStr) {
        const t = Date.parse(lastSeenStr);
        if (!isNaN(t)) {
          ageMs = now - t;
        }
      }

      // If explicitly blocked, treat as "offline" from a control perspective
      if (state === "blocked") {
        return { key: "blocked", label: "Blocked" };
      }

      // If no age info, fall back to state alone
      if (ageMs == null) {
        if (state === "allowed") {
          return { key: "good", label: "Online" };
        }
        if (state === "pending") {
          return { key: "pending", label: "Pending" };
        }
        return { key: "unknown", label: "Unknown" };
      }

      // Age thresholds (tweak as you like)
      const sec = ageMs / 1000;

      if (sec <= 20) {
        return { key: "good", label: "Online" };
      } else if (sec <= 60) {
        return { key: "warn", label: "Stale" };
      } else {
        return { key: "bad", label: "Offline" };
      }
    } catch (e) {
      console.warn("computeNodeHealth failed", e, device);
      return { key: "unknown", label: "Unknown" };
    }
  }

  const html = devices
    .map((dev) => {
      const id   = dev.device_id || dev.node_id || "unknown";
      const ip   = dev.ip || "";
      const name =
        dev.display_name ||
        dev.node_name ||
        dev.device_name ||
        id;
      const state    = (dev.state || dev.status || "allowed").toLowerCase();
      const lastSeen = dev.last_seen || "—";
      const isSelf   = dev.is_self || dev.self || false;
      const health   = computeNodeHealth(dev);

      let stateLabel = state;
      if (state === "pending") stateLabel = "Pending approval";
      if (state === "allowed") stateLabel = "Allowed";
      if (state === "blocked") stateLabel = "Blocked";

      const healthPill =
  health && health.key
    ? `<span class="mesh-pill mesh-pill-health mesh-pill-${health.key}">
         ${health.label}
       </span>`
    : "";


      // Actions based on state (Host approval controls)
      const actions = [];
      if (!isSelf) {
        if (state === "pending" || state === "blocked") {
          actions.push(
            `<button class="btn btn-primary" data-mesh-action="allow" data-device-id="${id}">Allow</button>`
          );
        }
        if (state === "pending" || state === "allowed") {
          actions.push(
            `<button class="btn btn-ghost" data-mesh-action="block" data-device-id="${id}">Block</button>`
          );
        }
        actions.push(
          `<button class="btn btn-ghost" data-mesh-action="remove" data-device-id="${id}">Remove</button>`
        );
      }

      const selfTag = isSelf
        ? '<span class="mesh-pill">This node</span>'
        : "";

      // Multi-node launcher + Agent buttons
      const launchButtons = [];

      // Lightweight “chip” actions – always available when we know the node IP
      if (ip) {
        // Node info & ping (host proxies)
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-info="${id}">Node info</button>`
        );
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-ping="${id}">Ping node</button>`
        );

        // Node Agent maintenance hooks
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="refresh" data-device-id="${id}">Refresh stats</button>`
        );
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="clean_temp" data-device-id="${id}">Clean temp</button>`
        );
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="logs" data-device-id="${id}">View logs</button>`
        );
      }

      // Deep-links into the node's own console (only when Allowed)
      if (ip && state === "allowed") {
        launchButtons.push(
          `<button class="btn btn-primary" data-mesh-open="visualizer" data-ip="${ip}">Open Visualizer</button>`
        );
        launchButtons.push(
          `<button class="btn btn-primary" data-mesh-open="tools" data-ip="${ip}">Open Tools</button>`
        );
      }

      return `
        <div class="mesh-node-card">
          <div class="mesh-node-header">
            <div class="mesh-node-title">
              <span class="mesh-node-name">${name}</span>
              ${selfTag}
            </div>
            <div class="mesh-node-meta">
              <span class="mesh-pill">${stateLabel}</span>
              ${healthPill}
            </div>
          </div>
          <div class="mesh-node-body">
            <div class="mesh-node-row">
              <span class="mesh-node-label">ID</span>
              <span class="mesh-node-value">${id}</span>
            </div>
            <div class="mesh-node-row">
              <span class="mesh-node-label">IP</span>
              <span class="mesh-node-value">${ip || "—"}</span>
            </div>
            <div class="mesh-node-row">
              <span class="mesh-node-label">Last seen</span>
              <span class="mesh-node-value">${lastSeen}</span>
            </div>
          </div>
          <div class="mesh-node-footer">
            <div class="mesh-node-actions">
              ${actions.join("")}
            </div>
            <div class="mesh-node-launch">
              ${launchButtons.join("")}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  listEl.innerHTML = html;
}


async function refreshMeshDirectory() {
  const statusEl = $("mesh-directory-status");
  if (statusEl) {
    statusEl.textContent = "Loading directory…";
  }

  try {
    const res = await fetch("/mesh/directory");
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }

    const data = await res.json();

    // ✅ Cache for multi-node tools
    // NOTE: No "let" — we use the global declaration already at the top of the file
    meshDirectoryCache = data;

    // Expect shape: { host: {...}, devices: [...] }
    renderMeshDirectory(data);

    debugLog("mesh", "info", "Loaded mesh directory");
  } catch (err) {
    console.error("Mesh directory fetch failed:", err);

    if (statusEl) {
      statusEl.textContent =
        "Unable to load directory (host-only, or not configured).";
    }

    // Still render an empty directory so the Host UI remains visible when appropriate
    renderMeshDirectory(null);
  }
}


async function refreshMeshNodeAndMaybeDirectory() {
  try {
    // Prefer MeshService so every module shares the same caches
    const data = window.MeshService ? await window.MeshService.fetchNode({ force: true }) : await (await fetch("/mesh/node")).json();
    currentNodeConfig = data;
    window.currentNodeConfig = data;
    renderMeshNode(data);

    // Try to refresh directory even on non-host (best-effort) so header + Chat can reflect presence
    let dir = null;
    try {
      if (window.MeshService) dir = await window.MeshService.fetchDirectory({ force: true });
      else {
        const dres = await fetch("/mesh/directory");
        if (dres.ok) dir = await dres.json();
      }
    } catch {}

    if (dir) {
      meshDirectoryCache = dir;
      window.meshDirectoryCache = dir;
    }

    const isHost = data && (data.is_host || data.role === "host");
    if (isHost) {
      await refreshMeshDirectory();
    } else {
      // Host directory UI stays host-only; presence belongs in TLI Chat
      renderMeshDirectory(null);
      setInlineStatus(
        "mesh-directory-status",
        "Presence is shown in TLI Chat. This panel is for Host administration.",
        "muted"
      );
    }

    // Sync context tags everywhere
    try { syncMeshContextTags(); } catch {}
  } catch (err) {
    console.error("Mesh node fetch failed:", err);
    renderMeshNode(null);
    setInlineStatus(
      "mesh-directory-status",
      "Unable to load node info: " + err.message,
      "error"
    );
    showToast("Mesh node unreachable.", "error");
    throw err; // Let callers show their own UX if they want.
  }
}

async function performMeshPing(deviceId) {
  if (!deviceId) return;
  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/ping`,
      { method: "POST", headers: { "Accept": "application/json" } }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json();
    const ping = data.ping || {};

    const summary = [
      ping.node_name || ping.node_id || "Unknown node",
      ping.hostname ? `Host: ${ping.hostname}` : "",
      ping.os ? `OS: ${ping.os}` : "",
      ping.ts ? `Time: ${ping.ts}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    showToast("Ping successful:\n\n" + summary);
    debugLog("mesh", "info", `Ping ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh ping failed:", err);
    showToast("Ping failed: " + err.message);
  }
}
async function performMeshInfo(deviceId) {
  if (!deviceId) return;
  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/info`,
      { method: "POST", headers: { Accept: "application/json" } }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json();
    const info = data.info || {};
    const node = info.node || {};
    const sys  = info.system || {};

    const lines = [];

    // Node identity
    lines.push(node.node_name || node.node_id || "Unknown node");
    if (node.role)        lines.push(`Role: ${node.role}`);
    if (node.mesh_status) lines.push(`Mesh: ${node.mesh_status}`);
    if (node.host_name)   lines.push(`Host: ${node.host_name}`);
    if (node.host_address)lines.push(`Host address: ${node.host_address}`);

    lines.push(""); // spacer

    // System snapshot
    if (sys.hostname) lines.push(`Hostname: ${sys.hostname}`);
    if (sys.platform) lines.push(`OS: ${sys.platform}`);
    if (sys.cpu_count) lines.push(`CPU cores: ${sys.cpu_count}`);

    const mem = sys.memory || {};
    if (Object.keys(mem).length) {
      lines.push(
        `RAM: ${mem.used_gb}/${mem.total_gb} GB (${mem.percent_used}%)`
      );
    }

    const disks = sys.disks || [];
    if (disks.length) {
      const first = disks[0];
      lines.push(
        `Disk: ${first.used_gb}/${first.total_gb} GB (${first.percent_used}%) on ${first.mountpoint}`
      );
    }

    if (sys.timestamp) {
      lines.push("");
      lines.push(`Snapshot at: ${sys.timestamp}`);
    }

    showToast("Node info:\n\n" + lines.join("\n"));
    debugLog("mesh", "info", `Node info ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh node info failed:", err);
    showToast("Node info failed: " + err.message);
  }
}

async function performMeshMaintenanceRefresh(deviceId) {
  if (!deviceId) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/refresh`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    debugLog("mesh", "info", `Maintenance refresh ok for device ${deviceId}`);

    // Optionally show fresh node info afterwards
    try {
      await performMeshInfo(deviceId);
    } catch (err) {
      console.warn("performMeshInfo after refresh failed:", err);
    }

    if (!data || data.ok !== false) {
      showToast("Maintenance: stats refresh requested on this node.");
    }
  } catch (err) {
    console.error("Mesh maintenance refresh failed:", err);
    showToast("Refresh stats failed: " + err.message);
  }
}

async function performMeshMaintenanceCleanTemp(deviceId) {
  if (!deviceId) return;

  const ok = confirm(
    "Run a SAFE temp cleanup on this node?\n\n" +
      "This only touches OS temp folders and TLI cache directories."
  );
  if (!ok) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/clean_temp`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    const nodePayload = data && data.data ? data.data : data;
    const summary = nodePayload.summary || nodePayload.result || nodePayload;

    let msg = "Temp cleanup completed.";

    if (summary && typeof summary === "object") {
      const totalFiles =
        summary.total_files_deleted ??
        summary.total_files_removed ??
        summary.files_deleted ??
        summary.files_removed;

      const totalBytes =
        summary.total_bytes_reclaimed ??
        summary.bytes_reclaimed ??
        summary.bytesRemoved ??
        summary.totalBytesReclaimed;

      const parts = [];

      if (typeof totalFiles === "number") {
        parts.push("Files deleted: " + totalFiles);
      }
      if (typeof totalBytes === "number") {
        parts.push(
          "Bytes reclaimed: " + totalBytes.toLocaleString() + " bytes"
        );
      }

      if (Array.isArray(summary.directories)) {
        parts.push("", "Directories touched:");
        for (const d of summary.directories) {
          if (!d) continue;
          const p = d.path || d.dir || "";
          const f =
            typeof d.files_deleted === "number"
              ? ` (${d.files_deleted} files)`
              : "";
          parts.push("- " + p + f);
        }
      }

      if (parts.length) {
        msg = "Temp cleanup summary:\n\n" + parts.join("\n");
      }
    }

    showToast(msg);
    debugLog("mesh", "info", `Clean temp ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh clean temp failed:", err);
    showToast("Clean temp failed: " + err.message);
  }
}

async function performMeshViewLogs(deviceId) {
  if (!deviceId) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/logs/recent?limit=100`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    const nodePayload = data && data.data ? data.data : data;
    const entries = nodePayload.entries || nodePayload.logs || nodePayload;

    let text = "";

    if (Array.isArray(entries)) {
      text = entries
        .map((entry) => {
          if (!entry) return "";
          if (typeof entry === "string") return entry;

          const ts = entry.ts || entry.timestamp || entry.time || "";
          const level = entry.level || entry.severity || "";
          const msg =
            entry.message ||
            entry.msg ||
            (entry.raw ? entry.raw : JSON.stringify(entry));

          if (ts || level) {
            return `[${ts}${level ? " " + level : ""}] ${msg}`;
          }
          return msg;
        })
        .filter(Boolean)
        .join("\n");
    } else if (typeof entries === "string") {
      text = entries;
    } else if (entries && typeof entries === "object") {
      text = JSON.stringify(entries, null, 2);
    }

    if (!text) {
      text = "No recent logs returned.";
    }

    if (text.length > 4000) {
      text = text.slice(0, 4000) + "\n\n… (truncated)";
    }

    showToast("Recent Node Agent logs:\n\n" + text);
    debugLog("mesh", "info", `Viewed logs for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh view logs failed:", err);
    showToast("View logs failed: " + err.message);
  }
}

async function performMeshMaintenanceRefresh(deviceId) {
  if (!deviceId) return;
  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/refresh`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    // We don't depend on a specific shape; just log and show a small confirmation.
    const data = await res.json().catch(() => ({}));
    debugLog(
      "mesh",
      "info",
      `Maintenance refresh ok for device ${deviceId}`,
    );

    // Optionally re-run node info so you see fresh stats.
    try {
      await performMeshInfo(deviceId);
    } catch {
      // If info fails, ignore; the refresh itself already happened.
    }

    if (!data || data.ok !== false) {
      showToast("Maintenance: stats refresh requested on this node.");
    }
  } catch (err) {
    console.error("Mesh maintenance refresh failed:", err);
    showToast("Refresh stats failed: " + err.message);
  }
}

async function performMeshMaintenanceCleanTemp(deviceId) {
  if (!deviceId) return;

  const ok = confirm(
    "Run a SAFE temp cleanup on this node?\n\n" +
      "This only touches OS temp folders and TLI cache directories."
  );
  if (!ok) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/clean_temp`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json().catch(() => ({}));
    const summary = data.summary || data.result || data;

    let msg = "Temp cleanup completed.";

    if (summary && typeof summary === "object") {
      const totalFiles =
        summary.total_files_removed ??
        summary.totalFilesRemoved ??
        summary.files_removed ??
        summary.filesRemoved;

      const totalBytes =
        summary.total_bytes_reclaimed ??
        summary.totalBytesReclaimed ??
        summary.bytes_reclaimed ??
        summary.bytesReclaimed;

      const parts = [];

      if (typeof totalFiles === "number") {
        parts.push(`Files removed: ${totalFiles}`);
      }
      if (typeof totalBytes === "number") {
        parts.push(
          `Bytes reclaimed: ${totalBytes.toLocaleString()} bytes`
        );
      }

      if (Array.isArray(summary.directories)) {
        parts.push(
          "",
          "Directories touched:",
          ...summary.directories.map((d) => {
            const p = d.path || d.dir || "";
            const f =
              typeof d.files_removed === "number"
                ? ` (${d.files_removed} files)`
                : "";
            return `- ${p}${f}`;
          })
        );
      }

      if (parts.length) {
        msg = "Temp cleanup summary:\n\n" + parts.join("\n");
      }
    }

    showToast(msg);
    debugLog("mesh", "info", `Clean temp ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh clean temp failed:", err);
    showToast("Clean temp failed: " + err.message);
  }
}

async function performMeshViewLogs(deviceId) {
  if (!deviceId) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/logs/recent?limit=100`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json().catch(() => ({}));
    const payload = data.logs || data.entries || data.result || data;

    let text = "";

    if (Array.isArray(payload)) {
      text = payload
        .map((entry) => {
          if (!entry) return "";
          if (typeof entry === "string") return entry;

          const ts = entry.ts || entry.timestamp || entry.time || "";
          const level = entry.level || "";
          const msg =
            entry.message ||
            entry.msg ||
            (entry.extra ? JSON.stringify(entry.extra) : JSON.stringify(entry));

          if (ts || level) {
            return `[${ts}${level ? " " + level : ""}] ${msg}`;
          }
          return msg;
        })
        .filter(Boolean)
        .join("\n");
    } else if (typeof payload === "string") {
      text = payload;
    } else if (payload && typeof payload === "object") {
      text = JSON.stringify(payload, null, 2);
    }

    if (!text) {
      text = "No recent logs returned.";
    }

    if (text.length > 4000) {
      text = text.slice(0, 4000) + "\n\n… (truncated)";
    }

    showToast("Recent Node Agent logs:\n\n" + text);
    debugLog("mesh", "info", `Viewed logs for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh view logs failed:", err);
    showToast("View logs failed: " + err.message);
  }
}

async function performMeshAction(deviceId, action) {
  if (!deviceId || !action) return;
  try {
    const res = await fetch(`/mesh/directory/${encodeURIComponent(deviceId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    await refreshMeshDirectory();
    debugLog("mesh", "info", `Applied action ${action} to device ${deviceId}`);
  } catch (err) {
    console.error("Mesh action failed:", err);
    showToast("Mesh action failed: " + err.message);
  }
}
// ---------- MESH JOIN HELPERS (node side) ----------

// Keep track of the polling timer for /mesh/join_status so we don't double-poll
let meshJoinPollTimer = null;

// Update the status line under the "Join Host" input
function updateMeshJoinStatus(text) {
  const el = $("mesh-join-status");
  if (el) {
    el.textContent = text;
  }
}

async function pollMeshJoinStatus() {
  // avoid double polling
  if (meshJoinPollTimer) {
    clearTimeout(meshJoinPollTimer);
    meshJoinPollTimer = null;
  }

  try {
    const res = await fetch("/mesh/join_status", {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error("HTTP " + res.status + (txt ? " · " + txt : ""));
    }

    const data = await res.json();
    const meshStatus = (data.mesh_status || "pending").toLowerCase();

    if (meshStatus === "pending") {
      updateMeshJoinStatus("Join request pending on host…");
      // keep polling every 5 seconds
      meshJoinPollTimer = setTimeout(pollMeshJoinStatus, 5000);
    } else if (meshStatus === "approved") {
      updateMeshJoinStatus(
        "Joined mesh. Host: " + (data.host_address || "(unknown)")
      );
      // refresh node + directory so UI flips from Standalone → Member
      try {
        if (typeof refreshMeshNodeAndMaybeDirectory === "function") {
          refreshMeshNodeAndMaybeDirectory();
        }
      } catch (e) {
        console.warn("refreshMeshNodeAndMaybeDirectory after join:", e);
      }
    } else if (meshStatus === "blocked") {
      updateMeshJoinStatus("Host blocked this device from joining.");
    } else if (meshStatus === "removed") {
      updateMeshJoinStatus("Removed from mesh. This node is now standalone again.");

      // 🔁 NEW: auto-refresh the node card so Role/Join mode/Host address
      // instantly flip back to Standalone with no manual refresh.
      try {
        if (typeof refreshMeshNodeAndMaybeDirectory === "function") {
          refreshMeshNodeAndMaybeDirectory();
        }
      } catch (e) {
        console.warn("refreshMeshNodeAndMaybeDirectory after removal:", e);
      }
    } else {
      updateMeshJoinStatus("Join status: " + meshStatus);
    }
  } catch (err) {
  console.error("[MESH] join_status error:", err);
  const msg = "Join status error: " + err.message;
  updateMeshJoinStatus(msg);
  showToast(msg, "error");
}

}


async function requestMeshJoin(hostAddress) {
 if (!addr) {
  const msg = "Enter the Host address first (e.g. 192.168.x.xxx:8000)"
  updateMeshJoinStatus(msg);
  showToast(msg, "error");
  return;
}

  updateMeshJoinStatus("Sending join request to " + addr + "…");
  debugLog("mesh", "POST /mesh/join_request host=" + addr);

  try {
    const res = await fetch("/mesh/join_request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host_address: addr })
    });

    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j.detail || "";
      } catch {
        detail = await res.text().catch(() => "");
      }
      throw new Error(detail || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    const meshStatus = (data.mesh_status || "pending").toLowerCase();

    if (meshStatus === "pending") {
      updateMeshJoinStatus(
        "Join request sent to " + addr + ". Waiting for host approval…"
      );
      // start polling host for status
      pollMeshJoinStatus();
    } else if (meshStatus === "approved") {
      updateMeshJoinStatus(
        "Joined mesh. Host: " + (data.host_address || addr)
      );
      if (typeof refreshMeshNodeAndMaybeDirectory === "function") {
        refreshMeshNodeAndMaybeDirectory();
      }
    } else if (meshStatus === "blocked") {
      updateMeshJoinStatus("Host blocked this device from joining.");
    } else {
      updateMeshJoinStatus("Join request result: " + meshStatus);
    }
  } catch (err) {
  console.error("[MESH] join_request failed:", err);
  const msg = "Join request failed: " + err.message;
  updateMeshJoinStatus(msg);
  showToast(msg, "error");
}

}

function setupMeshPanel() {
  const refreshBtn    = $("mesh-node-refresh-btn");
  const listEl        = $("mesh-directory-list");
  const joinBtn       = $("mesh-join-btn");
  const hostInput     = $("mesh-join-host-address");
  const becomeHostBtn = $("mesh-become-host-btn");
  const killAllBtn    = $("mesh-kill-all-btn");  // Kill Switch button

  // Multi-node tools controls
  const multiRunBtn  = $("mesh-multi-run-btn");
  const multiSelect  = $("mesh-multi-action-select");
  const multiStatus  = $("mesh-multi-status");

  // Local diagnostics on THIS node
  const diagBtn = $("mesh-node-diagnostics-btn");
  if (diagBtn) {
    diagBtn.addEventListener("click", handleLocalDiagnosticsClick);
  }

// Refresh node + directory (host + directory panel)
if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    withButtonBusy(refreshBtn, "🔄 Refreshing…", async () => {
      setInlineStatus(
        "mesh-directory-status",
        "Refreshing mesh node & directory…",
        "muted"
      );
      try {
        await refreshMeshNodeAndMaybeDirectory();
        setInlineStatus(
          "mesh-directory-status",
          "Mesh directory up to date.",
          "ok"
        );
        showToast("Mesh node refreshed.", "ok");
      } catch (err) {
        console.error("Mesh refresh failed:", err);
        setInlineStatus(
          "mesh-directory-status",
          "Failed to refresh mesh: " + err.message,
          "error"
        );
        showToast("Mesh refresh failed: " + err.message, "error");
      }
    });
  });
}

  // Join host flow (member-side)
  if (joinBtn && hostInput) {
    joinBtn.addEventListener("click", () => {
      const addr = hostInput.value || "";
      requestMeshJoin(addr);
    });
  }

  // Become host
  if (becomeHostBtn) {
    becomeHostBtn.addEventListener("click", async () => {
      const ok = confirm("Enable Mesh Coordinator on this node?\n\nThis node will accept join requests from peers and relay agent heartbeats. Only one node on your LAN should be the coordinator.");
      if (!ok) return;
      try {
        const res = await fetch("/mesh/node/become_host", { method: "POST" });
        if (!res.ok) throw new Error("Failed to become coordinator: " + res.status);
        showToast("This node is now the Mesh Coordinator.");
        await refreshMeshNodeAndMaybeDirectory();
      } catch (err) {
        showToast("Coordinator activation failed: " + err);
      }
    });
  }

  // Kill Switch – disconnect ALL nodes from this host
  if (killAllBtn) {
    killAllBtn.addEventListener("click", async () => {
      const ok = confirm(
        "Disconnect ALL nodes from this host?\n\nThey will need to re-join."
      );
      if (!ok) return;

      try {
        const res = await fetch("/mesh/kill_all", { method: "POST" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || ("HTTP " + res.status));
        }
        const data  = await res.json().catch(() => ({}));
        const count = data.disconnected ?? "0";
        debugLog("mesh", "info", "Kill switch disconnected " + count + " nodes.");
        showToast("Kill Switch activated. Disconnected " + count + " node(s).");
        refreshMeshNodeAndMaybeDirectory();
      } catch (err) {
        console.error("[MESH] kill_all failed:", err);
        showToast("Kill Switch failed: " + (err.message || err));
      }
    });
  }

  // Multi-node tools: run action on all allowed nodes
if (multiRunBtn && multiSelect) {
  multiRunBtn.addEventListener("click", () => {
    const action = multiSelect.value;
    if (!action) {
      const msg = "Pick an action before running multi-node tools.";
      multiStatus.textContent = msg;
      showToast(msg, "error");
      return;
    }

    withButtonBusy(multiRunBtn, "Running…", async () => {
      multiStatus.textContent = "Running " + action + " across allowed nodes…";

      try {
        const directory = meshDirectoryCache;
        if (!directory || !Array.isArray(directory.devices)) {
          multiStatus.textContent =
            "No directory loaded yet. Refresh as Host first.";
          showToast("Load mesh directory as Host before multi-run.", "error");
          return;
        }

        const allowed = directory.devices.filter((d) => d.allowed !== false);
        if (!allowed.length) {
          multiStatus.textContent = "No allowed nodes to run this on.";
          showToast("No allowed nodes in directory.", "error");
          return;
        }

        let okCount = 0;
        let failCount = 0;

        for (const dev of allowed) {
          const id = dev.device_id;
          try {
            if (action === "ping") {
              await performMeshPing(id);
            } else if (action === "refresh") {
              await performMeshMaintenanceRefresh(id);
            }
            okCount++;
          } catch (err) {
            console.warn("Multi-node action failed for", id, err);
            failCount++;
          }
        }

        multiStatus.textContent =
          `Action "${action}" completed. ` +
          `${okCount} node(s) ok, ${failCount} failed.`;

        const toastKind = failCount ? "error" : "ok";
        showToast(
          `Multi-node ${action} finished: ${okCount} ok, ${failCount} failed.`,
          toastKind
        );
      } catch (err) {
        console.error("Multi-node action failed:", err);
        multiStatus.textContent = "Multi-node action failed: " + err.message;
        showToast("Multi-node action failed: " + err.message, "error");
      }
    });
  });
}

  // Host directory button actions (allow / block / remove) + launcher buttons
  if (listEl) {
    listEl.addEventListener("click", (ev) => {
      // 0) Node info
      const infoBtn = ev.target.closest("[data-mesh-info]");
      if (infoBtn) {
        const deviceId = infoBtn.getAttribute("data-mesh-info");
        if (deviceId) performMeshInfo(deviceId);
        return;
      }

      // 1) Agent Ping
      const pingBtn = ev.target.closest("[data-mesh-ping]");
      if (pingBtn) {
        const deviceId = pingBtn.getAttribute("data-mesh-ping");
        if (deviceId) performMeshPing(deviceId);
        return;
      }

      // 2) Maintenance hooks (Node Agent v0.3)
      const maintBtn = ev.target.closest("[data-mesh-maint][data-device-id]");
      if (maintBtn) {
        const deviceId = maintBtn.getAttribute("data-device-id");
        const kind     = maintBtn.getAttribute("data-mesh-maint");
        if (!deviceId || !kind) return;

        if (kind === "refresh") {
          performMeshMaintenanceRefresh(deviceId);
        } else if (kind === "clean_temp") {
          performMeshMaintenanceCleanTemp(deviceId);
        } else if (kind === "logs") {
          performMeshViewLogs(deviceId);
        }
        return;
      }

      // 3) Multi-node launcher: open node's own TLI console
      const launchBtn = ev.target.closest("[data-mesh-open][data-ip]");
      if (launchBtn) {
        const ip     = launchBtn.getAttribute("data-ip");
        const target = launchBtn.getAttribute("data-mesh-open"); // "visualizer" or "tools"
        if (!ip) return;

        let panelParam = "";
        if (target === "visualizer") {
          panelParam = "visualizer";
        } else if (target === "tools") {
          panelParam = "tools";
        }

        const url = panelParam
          ? `http://${ip}:8000/?panel=${encodeURIComponent(panelParam)}`
          : `http://${ip}:8000/`;

        window.open(url, "_blank");
        return;
      }

      // 4) Host management actions (allow / block / remove)
      const btn = ev.target.closest("[data-mesh-action][data-device-id]");
      if (!btn) return;
      const action   = btn.getAttribute("data-mesh-action");
      const deviceId = btn.getAttribute("data-device-id");
      if (!action || !deviceId) return;

      if (action === "remove") {
        const ok = confirm(
          "Remove this node from the host directory? It can re-request later."
        );
        if (!ok) return;
      }

      performMeshAction(deviceId, action);
    });
  }

  // On load, if this node is already in a join flow, reflect that
  try {
    pollMeshJoinStatus();
  } catch (e) {
    console.warn("Initial pollMeshJoinStatus failed:", e);
  }

  // Delay initial mesh load so it doesn't compete with the page-load burst
  setTimeout(refreshMeshNodeAndMaybeDirectory, 3000);

  // Periodic refresh so the host sees join requests / last-seen updates
  setInterval(() => {
    refreshMeshNodeAndMaybeDirectory();
  }, 60000); // every 60 seconds
}



// One-time wiring for USB buttons → Files / Scripts panels
let usbActionsWired = false;

function ensureUsbActionHandlers() {
  if (usbActionsWired) return;
  const listEl = $("devices-usb-list");
  if (!listEl) return;

  listEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-usb-path][data-usb-action]");
    if (!btn) return;

    const path   = btn.getAttribute("data-usb-path") || "";
    const action = btn.getAttribute("data-usb-action") || "";
    if (!path) return;

    if (action === "files-target") {
      // Push this USB path into the File Organizer root and jump to Files
      const rootInput = $("filesRootInput");
      if (rootInput) {
        rootInput.value = path;
        filesSetStatus(`Using ${path} as File Organizer root (from USB Snapshot).`);
      }
      switchPanel("panel-files");
    } else if (action === "scripts-backup") {
      // Prefill Scripts panel with a backup-script request for this drive
      const promptBox = $("scripts-prompt");
      if (promptBox) {
        const prompt =
          `Write a production-ready PowerShell backup script for this USB drive mounted at "${path}".\n\n` +
          `Requirements:\n` +
          `- Treat "${path}" as the backup destination.\n` +
          `- Back up my important user folders (Documents, Desktop, Pictures).\n` +
          `- Use timestamped subfolders for each backup run.\n` +
          `- Only copy new or changed files (incremental behaviour).\n` +
          `- Include basic logging and safety checks so a non-expert can use it.\n`;
        promptBox.value = prompt;
        promptBox.focus();
        promptBox.selectionStart = promptBox.selectionEnd = promptBox.value.length;
      }
      switchPanel("panel-scripts");
    }
  });

  usbActionsWired = true;
}

async function refreshUsbDevices() {
  const listEl  = $("devices-usb-list");
  const otherEl = $("devices-usb-other");
  if (!listEl) return;

  listEl.innerHTML = '<p class="small-meta">Scanning…</p>';

  try {
    const res = await fetch("/devices/usb");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const devices = data.devices || [];

    // Every device returned is already a USB storage drive with a mount path.
    // Filter defensively in case older backend sends mixed results.
    const drives = devices.filter(d => {
      const { isMassStorage, mountPath } = getUsbStorageInfo(d);
      return (d.is_storage || isMassStorage) && (d.mount_path || mountPath);
    });
    const otherCount = devices.length - drives.length;

    if (!drives.length) {
      listEl.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No USB storage detected</div>
          <div class="tli-empty-sub">${devices.length ? `${devices.length} non-storage USB devices present (hubs, controllers, etc.) — nothing actionable.` : "Plug in a USB drive and click Refresh."}</div>
        </div>`;
      if (otherEl) otherEl.style.display = "none";
      debugLog("info", "GET /devices/usb OK: no actionable drives");
      return;
    }

    // Render drive tiles
    listEl.innerHTML = drives.map(dev => {
      const mountPath = dev.mount_path || getUsbStorageInfo(dev).mountPath || "";
      const name = dev.name || dev.product || "USB Drive";
      const label = mountPath.replace(/\\$/, "");
      return `
        <div class="usb-drive-tile">
          <div class="usb-drive-icon">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="2" width="12" height="16" rx="2"/><circle cx="10" cy="14" r="1"/><path d="M7 6h6M7 9h4"/></svg>
          </div>
          <div class="usb-drive-info">
            <div class="usb-drive-name">${name}</div>
            <div class="usb-drive-path">${label}</div>
          </div>
          <div class="usb-drive-actions">
            <button class="pill-btn ghost btn-xs" data-usb-path="${mountPath}" data-usb-action="files-target">Open in Files</button>
            <button class="pill-btn ghost btn-xs" data-usb-path="${mountPath}" data-usb-action="scripts-backup">Backup script</button>
          </div>
        </div>`;
    }).join("");

    // Show "N other USB devices" footnote
    if (otherEl) {
      if (otherCount > 0) {
        otherEl.textContent = `${otherCount} other USB device${otherCount === 1 ? "" : "s"} present (hubs, controllers — not shown).`;
        otherEl.style.display = "";
      } else {
        otherEl.style.display = "none";
      }
    }

    ensureUsbActionHandlers();
    debugLog("info", `GET /devices/usb OK: ${drives.length} drives, ${otherCount} other`);
  } catch (err) {
    console.error("USB scan failed:", err);
    listEl.innerHTML = `<div class="usb-error">Error scanning USB devices: ${err.message}</div>`;
    debugLog("error", "GET /devices/usb failed: " + err.message);
  }
}

async function loadUsbRawOutput() {
  const statusEl   = $("devices-usb-status");
  const summaryEl  = $("devices-usb-summary");
  const rawDetails = $("devices-usb-raw");
  const rawPre     = $("devices-usb-raw-pre");

  if (!rawPre) {
    console.warn("devices-usb-raw-pre element not found.");
    return;
  }

  if (statusEl)  statusEl.textContent  = "Loading raw output…";
  if (summaryEl) summaryEl.textContent =
    "Fetching raw OS USB output from the backend (read-only).";

  rawPre.textContent = "Loading raw OS USB output…";

  try {
    const res = await fetch("/devices/usb/raw");
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json();
    const text = data.raw || JSON.stringify(data, null, 2);

    rawPre.textContent = text;

    if (rawDetails) {
      rawDetails.style.display = "block";
      rawDetails.open = true; // auto-expand <details>
    }
    if (statusEl) statusEl.textContent = "Raw OS output loaded";

    debugLog("info", "GET /devices/usb/raw OK");
  } catch (err) {
    console.error("USB raw output failed:", err);
    rawPre.textContent =
      "Error loading raw USB output: " + err.message;
    if (statusEl)  statusEl.textContent  = "Raw output error";
    if (summaryEl) summaryEl.textContent = "Raw output request failed.";
    debugLog("error", "GET /devices/usb/raw failed: " + err.message);
  }
}
async function refreshLanDevices() {
  const statusEl   = $("lan-devices-status");
  const summaryEl  = $("lan-devices-summary");
  const ifaceBox   = $("lan-devices-interfaces");
  const arpBox     = $("lan-devices-arp");

  if (!statusEl || !summaryEl || !ifaceBox || !arpBox) {
    console.warn("LAN devices panel elements missing; skipping scan.");
    return;
  }

  // Loading state
  statusEl.textContent  = "Scanning…";
  summaryEl.textContent = "Checking local interfaces and ARP table…";
  ifaceBox.innerHTML    = "";
  arpBox.innerHTML      = "";

  try {
    const res = await fetch("/devices/scan");
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    const data = await res.json();

    const interfaces = data.interfaces || {};
    const arpTable   = data.arp_table || [];

    // ---- Render interfaces on this node ----
    const ifaceNames = Object.keys(interfaces || {});
    if (ifaceNames.length) {
      const frag = document.createDocumentFragment();

      ifaceNames.forEach((name) => {
        const info = interfaces[name] || {};
        const ip   = info.ipv4 || info.ip || "";
        const gw   = info.gateway || "";
        const desc = info.description || info.friendly_name || "";

        const card = document.createElement("div");
        card.className = "lan-device-card";
        card.innerHTML = `
          <div class="lan-device-title">${name}${ip ? ` — ${ip}` : ""}</div>
          <div class="lan-device-meta">
            ${desc ? `<span>${desc}</span>` : ""}
            ${gw ? `<span>Gateway: ${gw}</span>` : ""}
          </div>
        `;
        frag.appendChild(card);
      });

      ifaceBox.innerHTML = "";
      const title = document.createElement("div");
      title.className = "lan-section-title";
      title.textContent = "This node’s network interfaces";
      ifaceBox.appendChild(title);
      ifaceBox.appendChild(frag);
    } else {
      ifaceBox.innerHTML =
        `<p class="hint">No network interfaces reported by the backend.</p>`;
    }

    // ---- Render ARP peers ----
    if (arpTable.length) {
      const frag2 = document.createDocumentFragment();

arpTable.forEach((entry) => {
  const ip     = entry.ip || "Unknown IP";
  const mac    = entry.mac || "Unknown MAC";
  const iface  = entry.interface || entry.iface || "";
  const vendor = entry.vendor || "";
  const src    = entry.source || "";
  const mesh   = entry.mesh_device || null;

  // Build an optional TLI-node line if this IP belongs to a Mesh device
  let meshLine = "";
  let cardClass = "lan-device-card";
  if (mesh) {
    cardClass += " mesh-node";

    const parts = [];
    if (mesh.display_name) {
      parts.push(mesh.display_name);
    } else if (mesh.device_id) {
      parts.push(mesh.device_id);
    }

    if (mesh.is_host) {
      parts.push("Host");
    }
    if (mesh.status) {
      const s = String(mesh.status);
      const niceStatus = s.charAt(0).toUpperCase() + s.slice(1);
      parts.push(niceStatus);
    }

    const label = parts.join(" · ");
    meshLine = `<span>TLI node: ${label}</span>`;
  }

  const card = document.createElement("div");
  card.className = cardClass;
  card.innerHTML = `
    <div class="lan-device-title">${ip}${iface ? ` · ${iface}` : ""}</div>
    <div class="lan-device-meta">
      <span>MAC: ${mac}</span>
      ${vendor ? `<span>${vendor}</span>` : ""}
      ${src ? `<span>${src}</span>` : ""}
      ${meshLine}
    </div>
  `;
  frag2.appendChild(card);
});

      arpBox.innerHTML = "";
      const title2 = document.createElement("div");
      title2.className = "lan-section-title";
      title2.textContent = "LAN peers (ARP table)";
      arpBox.appendChild(title2);
      arpBox.appendChild(frag2);
    } else {
      arpBox.innerHTML =
        `<p class="hint">No ARP entries found. Some systems hide ARP details or require admin rights.</p>`;
    }

    const ifaceCount = ifaceNames.length;
    const arpCount   = arpTable.length;

    statusEl.textContent = "Scan complete";
    summaryEl.textContent =
      `${ifaceCount} interface${ifaceCount === 1 ? "" : "s"}, ` +
      `${arpCount} ARP entr${arpCount === 1 ? "y" : "ies"}.`;

    debugLog("info", "GET /devices/scan OK.");
  } catch (err) {
    console.error("LAN devices scan failed:", err);
    statusEl.textContent  = "Scan failed";
    summaryEl.textContent = "Could not scan LAN devices.";
    ifaceBox.innerHTML =
      `<p class="usb-error">Error scanning LAN devices: ${err.message}</p>`;
    arpBox.innerHTML = "";
    debugLog("error", "GET /devices/scan failed: " + err.message);
  }
}

// Optional shim so any old code calling refreshUSBList() still works
function refreshUSBList() {
  return refreshUsbDevices();
}


// ---------- settings panel (local only) ----------
const settingsKey = "tli_settings";
function readSettings() {
  try {
    const raw = localStorage.getItem(settingsKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeSettings(s) {
  localStorage.setItem(settingsKey, JSON.stringify(s));
}

// Apply settings to the ACTIVE UI (header chips + theme)
function applySettingsToUI(s) {
  const modeEl  = $("mode-select");

  if (modeEl) {
    modeEl.value = s.defaultMode || "default";
  }

  const tgl = $("teaching-toggle");
  if (tgl) {
    if (s.teachingOn) tgl.classList.add("on");
    else tgl.classList.remove("on");
  }

  $("temperature-input").value = s.defaultTemp || "0.7";
  $("max-tokens-input").value  = s.defaultMax  || "768";

  // Apply theme to <html>
  const theme = s.defaultTheme || DEFAULT_THEME;
  applyTheme(theme);

  // (keep the rest of this function exactly as you have it now)

}

// ----- Settings: Model server + UI prefs -----

async function fetchModelSettings() {
  const urlSpan  = $("settings-model-url");
  const statusEl = $("settings-model-status");
  const select   = $("settings-model-id");
  const compatEl = $("settings-model-compat");


  if (!select) return;

  if (statusEl) statusEl.textContent = "Contacting model server…";

  try {
    const resp = await fetch("/models/available");
    if (!resp.ok) {
      throw new Error("HTTP " + resp.status);
    }
    const data = await resp.json();
        const compat = data.compat || null;
    if (compatEl && compat) {
      const badge = compat.ok ? "OK" : "DEGRADED";
      const extra = compat.ok
        ? `schema=${compat.schema_ok ? "ok" : "?"} · models=${compat.model_count} · ${compat.latency_ms || "?"}ms`
        : `error=${compat.error || "unknown"}`;
      compatEl.textContent = `Compatibility: ${badge} · ${extra}`;
    }


    // Show LM Studio URL
    if (urlSpan && data.server_url) {
      urlSpan.textContent = data.server_url;
    }

    // Populate dropdown
    select.innerHTML = "";
    const models = data.models || [];
    if (!models.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No models reported by server";
      select.appendChild(opt);
    } else {
      models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        select.appendChild(opt);
      });

      // Pre-select current default
      const current       = data.current || {};
      const currentKey    = current.default_key;
      const currentModels = current.models || {};
      const cfg           = currentModels[currentKey];
      if (cfg && cfg.id) {
        select.value = cfg.id;
      }
    }

    if (statusEl) statusEl.textContent = "Models loaded";
    debugLog("info", "Loaded model list from backend.");
  } catch (err) {
    if (statusEl) statusEl.textContent = "Could not reach model server";
    debugLog("error", "Failed to fetch model list: " + err);
  }
}
async function fetchSystemProfileSettings() {
  const select = $("settings-system-profile");
  const meta   = $("settings-system-profile-meta");
  if (!select) return;

  try {
    const resp = await fetch("/system/profile");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();

    if (data && data.current) {
      select.value = data.current;
    }

    // Apply suggested UI defaults (safe: only touches Settings controls)
    const ui = data.ui_defaults || {};
    const tempEl = $("settings-temp");
    const maxEl  = $("settings-max");
    if (tempEl && ui.temp) tempEl.value = ui.temp;
    if (maxEl && ui.max_tokens) maxEl.value = ui.max_tokens;

    if (meta && data.profiles && data.current && data.profiles[data.current]) {
      meta.textContent =
        "Profile: " + (data.profiles[data.current].label || data.current) +
        " · Suggested defaults applied in this Settings view.";
    }

    debugLog("info", "Loaded system profile from backend.");
  } catch (err) {
    if (meta) meta.textContent = "Could not load system profile (backend unreachable).";
    debugLog("error", "Failed to fetch system profile: " + err);
  }
}
async function fetchHardwareProbe() {
  const meta = $("settings-system-profile-meta");
  if (!meta) return;

  try {
    const resp = await fetch("/system/probe");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const p = await resp.json();

    const parts = [
      `${p.cpu_cores}C/${p.cpu_threads}T`,
      `${p.ram_total_gb} GB RAM`,
    ];
    if (p.gpu_vram_gb != null) parts.push(`${p.gpu_vram_gb} GB VRAM`);

    meta.textContent =
      `Hardware: ${parts.join(" · ")} · Suggested profile: ${String(p.suggested_profile).toUpperCase()}`;
  } catch (err) {
    // keep current text if probe fails; do not break Settings
    debugLog("warn", "Hardware probe failed: " + err);
  }
}

// Load Settings panel controls from localStorage
function loadSettingsPanel() {
  const s = readSettings() || {};

  const brainEl    = $("settings-brain");
  const modeEl     = $("settings-mode");
  const teachingBtn = $("settings-teaching");
  const tempEl     = $("settings-temp");
  const maxEl      = $("settings-max");
  const themeEl    = $("settings-theme");

  if (brainEl)  brainEl.value  = s.defaultBrain || "auto";
  if (modeEl)   modeEl.value   = s.defaultMode  || "default";

  if (teachingBtn) {
    if (s.teachingOn) teachingBtn.classList.add("on");
    else teachingBtn.classList.remove("on");
  }

  if (tempEl)   tempEl.value   = s.defaultTemp  || "0.7";
  if (maxEl)    maxEl.value    = s.defaultMax   || "768";
  if (themeEl)  themeEl.value  = s.defaultTheme || DEFAULT_THEME;

  // Ask backend which models exist & which one is current
  fetchModelSettings();
}
fetchSystemProfileSettings();
fetchHardwareProbe();

function setupSettingsPanel() {
  if (setupSettingsPanel._done) return;
  setupSettingsPanel._done = true;
  const teachingBtn = $("settings-teaching");
  const saveBtn     = $("settings-save");
  const applyBtn    = $("settings-apply");
  const clearBtn    = $("settings-clear-history");
  const exportBtn   = $("settings-export");
  const importInput = $("settings-import");
  const refreshModelsBtn = $("settings-model-refresh");
  const saveModelBtn     = $("settings-model-save");
  const saveProfileBtn = $("settings-system-profile-save");
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener("click", async () => {
      const select = $("settings-system-profile");
      if (!select) return;

      try {
        const resp = await fetch("/system/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: select.value }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        showToast("System profile saved: " + (data.current || select.value));
        fetchSystemProfileSettings(); // refresh meta + defaults
      } catch (err) {
        showToast("Could not save system profile: " + err);
        debugLog("error", "Failed to save system profile: " + err);
      }
    });
  }


  // Teaching toggle
  if (teachingBtn) {
    teachingBtn.addEventListener("click", () => {
      teachingBtn.classList.toggle("on");
    });
  }

  // Live theme preview
  const themeSelectEl = $("settings-theme");
  if (themeSelectEl) {
    themeSelectEl.addEventListener("change", () => {
      applyTheme(themeSelectEl.value);
    });
  }

  // Refresh model list
  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener("click", () => {
      fetchModelSettings();
    });
  }

  // Save default model on backend
  if (saveModelBtn) {
    saveModelBtn.addEventListener("click", async () => {
      const select = $("settings-model-id");
      if (!select || !select.value) {
        showToast("No model selected.");
        return;
      }

      const modelId = select.value;
      const label =
        (select.selectedOptions && select.selectedOptions[0]
          ? select.selectedOptions[0].textContent
          : modelId) || modelId;

      try {
        const resp = await fetch("/models/set-default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id: modelId, label }),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        showToast(
          "Saved default model: " +
          (data.model && data.model.label ? data.model.label : label)
        );
        debugLog("info", "Updated default model: " + JSON.stringify(data));
      } catch (err) {
        showToast("Could not save model setting: " + err);
        debugLog("error", "Failed to save default model: " + err);
      }
    });
  }

   // Save settings (including theme) to localStorage AND apply immediately
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const brainEl    = $("settings-brain");
      const teachingEl = $("settings-teaching");
      const tempEl     = $("settings-temp");
      const maxEl      = $("settings-max");
      const themeEl    = $("settings-theme");

      const s = {
        defaultBrain: brainEl ? brainEl.value : "auto",
        // defaultMode is omitted for now – there is no settings-mode element in the UI
        teachingOn:   teachingEl ? teachingEl.classList.contains("on") : false,
        defaultTemp:  tempEl ? tempEl.value : "0.7",
        defaultMax:   maxEl ? maxEl.value : "768",
        defaultTheme: themeEl ? themeEl.value : DEFAULT_THEME,
      };

      writeSettings(s);
      applySettingsToUI(s);
      showToast("Settings saved locally and applied.");
      debugLog("info", "Settings saved to localStorage and applied.");
    });
  }

  // Apply current controls immediately AND persist them
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const brainEl    = $("settings-brain");
      const teachingEl = $("settings-teaching");
      const tempEl     = $("settings-temp");
      const maxEl      = $("settings-max");
      const themeEl    = $("settings-theme");

      const s = {
        defaultBrain: brainEl ? brainEl.value : "auto",
        teachingOn:   teachingEl ? teachingEl.classList.contains("on") : false,
        defaultTemp:  tempEl ? tempEl.value : "0.7",
        defaultMax:   maxEl ? maxEl.value : "768",
        defaultTheme: themeEl ? themeEl.value : DEFAULT_THEME,
      };

      writeSettings(s);
      applySettingsToUI(s);
      showToast("Applied to header, advanced defaults, and theme (saved for next time).");
      debugLog("info", "Settings applied to UI and saved.");
    });
  }


  // Clear history (local only)
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!confirm("Clear previous prompts and conversations from this browser?")) return;
      localStorage.setItem(previousPromptsKey, JSON.stringify([]));
      localStorage.setItem(previousConversationsKey, JSON.stringify([]));
      loadPreviousPrompts();
      showToast("Local history cleared.");
      debugLog("info", "Local history cleared (prompts + conversations).");
    });
  }

  // Export settings + history
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const payload = {
        tli_settings: readSettings(),
        tli_previous_prompts:
          JSON.parse(localStorage.getItem(previousPromptsKey) || "[]"),
        tli_previous_conversations:
          JSON.parse(localStorage.getItem(previousConversationsKey) || "[]"),
        exported_at: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tli_export.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      debugLog("info", "Settings/history exported to tli_export.json.");
    });
  }

  // Import settings + history
  if (importInput) {
    importInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const j = JSON.parse(reader.result);
          if (j.tli_settings) writeSettings(j.tli_settings);
          if (Array.isArray(j.tli_previous_prompts))
            localStorage.setItem(previousPromptsKey, JSON.stringify(j.tli_previous_prompts));
          if (Array.isArray(j.tli_previous_conversations))
            localStorage.setItem(previousConversationsKey, JSON.stringify(j.tli_previous_conversations));

          loadSettingsPanel();
          applySettingsToUI(readSettings());
          loadPreviousPrompts();
          showToast("Import complete.");
          debugLog("info", "Settings/history import complete.");
        } catch (err) {
          showToast("Import failed: " + err.message);
          debugLog("error", "Settings/history import failed: " + err.message);
        } finally {
          e.target.value = "";
        }
      };
      reader.readAsText(file);
    });
  }

  // ── Node Identity ──────────────────────────────────────────
  async function _loadNodeIdentity() {
    try {
      const r = await fetch("/mesh/node", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const nameEl = $("settings-node-name");
      const roleEl = $("settings-node-role");
      const nodeIdEl = $("settings-node-id");
      if (nameEl) nameEl.value = d.display_name || d.node_name || "";
      if (roleEl) roleEl.value = d.role || "standalone";
      if (nodeIdEl) nodeIdEl.textContent = d.node_id || "—";
    } catch {}
  }

  const nodeIdentitySaveBtn = $("settings-node-identity-save");
  if (nodeIdentitySaveBtn) {
    nodeIdentitySaveBtn.addEventListener("click", async () => {
      const nameEl = $("settings-node-name");
      const roleEl = $("settings-node-role");
      const name = (nameEl ? nameEl.value : "").trim();
      const role = roleEl ? roleEl.value : "standalone";
      if (!name) { showToast("Node name cannot be empty.", "error"); return; }
      nodeIdentitySaveBtn.disabled = true;
      try {
        const r = await fetch("/mesh/node/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_name: name, role }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        showToast("Node identity saved.", "success");
      } catch (e) {
        showToast("Failed to save identity: " + e.message, "error");
      } finally {
        nodeIdentitySaveBtn.disabled = false;
      }
    });
  }

  _loadNodeIdentity();

  // ── PIN Lock settings ─────────────────────────────────────
  async function _refreshPinUI() {
    try {
      const r = await fetch("/system/pin/status", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const desc      = $("settings-pin-status-desc");
      const label     = $("settings-pin-action-label");
      const curInput  = $("settings-pin-current");
      const saveBtn   = $("settings-pin-save");
      const removeBtn = $("settings-pin-remove");
      const callout = $("settings-pin-callout");
      if (d.enabled) {
        if (desc)      desc.textContent = "PIN is set. Changing requires your current PIN.";
        if (label)     label.textContent = "Change PIN";
        if (curInput)  curInput.style.display = "";
        if (saveBtn)   saveBtn.textContent = "Change PIN";
        if (removeBtn) removeBtn.style.display = "";
        if (callout)   callout.style.display = "none";
        // Clear permanent nudge dismissal so it can reappear if PIN is later removed
        try { localStorage.removeItem("tli_pin_nudge_v1"); } catch {}
      } else {
        if (desc)      desc.textContent = "No PIN set — anyone on your LAN can access TLI.";
        if (label)     label.textContent = "Set PIN";
        if (curInput)  curInput.style.display = "none";
        if (saveBtn)   saveBtn.textContent = "Set PIN";
        if (removeBtn) removeBtn.style.display = "none";
        if (callout)   callout.style.display = "";
      }
    } catch {}
  }

  const pinSaveBtn   = $("settings-pin-save");
  const pinRemoveBtn = $("settings-pin-remove");

  if (pinSaveBtn) {
    pinSaveBtn.addEventListener("click", async () => {
      const cur     = ($("settings-pin-current")?.value || "").trim();
      const newPin  = ($("settings-pin-new")?.value     || "").trim();
      const confirm = ($("settings-pin-confirm")?.value || "").trim();
      if (!newPin) { showToast("Enter a new PIN.", "error"); return; }
      if (newPin.length < 4) { showToast("PIN must be at least 4 characters.", "error"); return; }
      if (newPin !== confirm) { showToast("PINs do not match.", "error"); return; }

      pinSaveBtn.disabled = true;
      try {
        const body = { pin: newPin };
        if (cur) body.current_pin = cur;
        const r = await fetch("/system/pin/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || "HTTP " + r.status);
        }
        // Mark session as unlocked since we just authenticated
        try { sessionStorage.setItem("tli_session_unlocked", "1"); } catch {}
        showToast("PIN saved. TLI is now locked until you unlock it.", "success");
        [$("settings-pin-current"), $("settings-pin-new"), $("settings-pin-confirm")]
          .forEach(el => { if (el) el.value = ""; });
        await _refreshPinUI();
        if (window.TLIPinLock) window.TLIPinLock.checkAndLock();
      } catch (e) {
        showToast("Failed to save PIN: " + e.message, "error");
      } finally {
        pinSaveBtn.disabled = false;
      }
    });
  }

  if (pinRemoveBtn) {
    pinRemoveBtn.addEventListener("click", async () => {
      const cur = ($("settings-pin-current")?.value || "").trim();
      if (!cur) { showToast("Enter your current PIN to remove it.", "error"); return; }
      pinRemoveBtn.disabled = true;
      try {
        const r = await fetch("/system/pin/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: cur }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || "HTTP " + r.status);
        }
        try { sessionStorage.removeItem("tli_session_unlocked"); } catch {}
        showToast("PIN removed. TLI is now open on your LAN.", "success");
        if ($("settings-pin-current")) $("settings-pin-current").value = "";
        await _refreshPinUI();
        const lockBtn = document.getElementById("tli-lock-btn");
        if (lockBtn) lockBtn.hidden = true;
      } catch (e) {
        showToast("Failed to remove PIN: " + e.message, "error");
      } finally {
        pinRemoveBtn.disabled = false;
      }
    });
  }

  _refreshPinUI();
}
async function handleLocalDiagnosticsClick() {
  const panel = $("mesh-node-diagnostics");
  if (!panel) return;

  panel.textContent = "Loading diagnostics…";

  try {
    const res = await fetch("/agent/system_summary");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const summary = await res.json();
    renderLocalDiagnostics(panel, summary);
  } catch (err) {
    console.error(err);
    panel.textContent = "Diagnostics failed: " + err.message;
  }
}

function renderLocalDiagnostics(panel, summary) {
  const { cpu, ram, disk, uptime } = summary;

  panel.innerHTML = `
    <div class="diag-row"><strong>CPU:</strong> ${cpu.percent.toFixed(1)}%</div>
    <div class="diag-row"><strong>RAM:</strong> ${ram.percent_used.toFixed(1)}%
      (${ram.used_human} / ${ram.total_human})
    </div>
    <div class="diag-row"><strong>Disk:</strong> ${disk.overall_percent_used.toFixed(1)}%</div>
    <div class="diag-row"><strong>Uptime:</strong> ${uptime.human_readable}</div>
  `;
}
// ---------- Home Automation: Shelly (Phase 1) ----------
// ---------- Shelly multi-device storage ----------
const shellyDevicesStorageKey = "tli_shelly_devices_v1"; // NEW (multi-device)
// 🔒 UI lock: prevents card re-render during inline rename
let shellyRenameLock = false;

function loadShellyDevicesFromStorage() {
  try {
    const raw = localStorage.getItem(shellyDevicesStorageKey);
    const obj = raw ? JSON.parse(raw) : {};
    // Ensure shellyDevices is populated (global already exists)
    Object.keys(shellyDevices).forEach(k => delete shellyDevices[k]);
    Object.entries(obj || {}).forEach(([ip, dev]) => {
      if (!ip) return;
      shellyDevices[ip] = {
        ip,
        name: dev?.name || "",
        status: dev?.status || null,
        updatedAt: dev?.updatedAt || null,
      };
    });
  } catch (e) {
    console.warn("Shelly: failed to load multi-device store:", e);
  }
}

function saveShellyDevicesToStorage() {
  try {
    localStorage.setItem(shellyDevicesStorageKey, JSON.stringify(shellyDevices));
  } catch (e) {
    console.warn("Shelly: failed to save multi-device store:", e);
  }
}

function upsertShellyDevice(ip, patch = {}) {
  if (!ip) return;

  const existing = shellyDevices[ip] || {
    ip,
    name: "",
    status: null,
    updatedAt: null
  };

  const next = {
    ...existing,
    ...patch,
    ip,
    updatedAt: new Date().toISOString()
  };

  // 🔒 PROTECT NAME
  if (
    patch.name === undefined ||
    patch.name === null ||
    patch.name.trim?.() === ""
  ) {
    next.name = existing.name;
  }

  shellyDevices[ip] = next;
  saveShellyDevicesToStorage();
}



let shellyAutoTimer = null;
let lastShellyStatus = null; // last known Shelly state for chat + self-awareness
const shellySelectedIpStorageKey = "tli_shelly_selected_ip_v1";

function getSelectedShellyIp() {
  try {
    return (localStorage.getItem(shellySelectedIpStorageKey) || "").trim() || null;
  } catch {
    return null;
  }
}

function setSelectedShellyIp(ip) {
  const trimmed = (ip || "").trim();
  try {
    if (trimmed) localStorage.setItem(shellySelectedIpStorageKey, trimmed);
    else localStorage.removeItem(shellySelectedIpStorageKey);
  } catch {}

  // Keep the existing UI inputs aligned (nice UX)
  const ipInput = $("shelly-ip-input");
  if (ipInput && trimmed) ipInput.value = trimmed;

  const nameInput = $("shelly-name-input");
  if (nameInput && trimmed) {
    const nm = (shellyDevices?.[trimmed]?.name || "").trim();
    if (nm) nameInput.value = nm;
  }
}

// ✅ Save name button (per selected device)
const renameBtn = $("shelly-rename-btn");
if (renameBtn) {
  renameBtn.addEventListener("click", () => {
    const ip = (typeof getSelectedShellyIp === "function" ? getSelectedShellyIp() : "").trim();
    if (!ip) {
      showToast("Select a Shelly card first, then rename it.", "warn");
      return;
    }

    const nm = (nameInput?.value || "").trim();
    if (!nm) {
      showToast("Enter a name first (example: Bedside lamp).", "warn");
      return;
    }

    upsertShellyDevice(ip, { name: nm });
    applyShellyNameToUI(nm);
    renderAllShellyCards();
    showToast(`Saved name: ${nm} (${ip})`, "ok");
  });
}


const SHELLY_AUTO_INTERVAL_MS = 3000; // 3s; tweak if you want

function buildShellySnapshotFromPayload(ip, payload) {
  const raw = payload && (payload.raw || payload);

  const sw = raw && raw["switch:0"] ? raw["switch:0"] : null;

  const snapshot = {
    ip,
    isOn: !!(sw && typeof sw.output === "boolean" ? sw.output : false),
    power: sw && typeof sw.apower === "number" ? sw.apower : null,
    voltage: sw && typeof sw.voltage === "number" ? sw.voltage : null,
    current: sw && typeof sw.current === "number" ? sw.current : null,
    temperature:
      raw && raw.temperature && typeof raw.temperature.tC === "number"
        ? raw.temperature.tC
        : null,
    checkedAt: Date.now(),
  };

  return snapshot;
}

function startShellyAutoRefresh() {
  if (shellyAutoTimer) return; // already running

  const perDeviceDelayMs = 800; // stagger between devices
  const cycleDelayMs = 5000; // wait between full cycles

  const tick = async () => {
    const devices = Object.values(shellyDevices || {}).filter((d) => d && d.ip);
    if (!devices.length) return;

    const selected = getSelectedShellyIp();

    // Always poll selected first, but DO NOT update Quick Control unless it's selected.
    const ordered = selected
      ? [
          ...devices.filter((d) => (d.ip || "").trim() === selected),
          ...devices.filter((d) => (d.ip || "").trim() !== selected),
        ]
      : devices;

    for (let i = 0; i < ordered.length; i++) {
      const ip = (ordered[i].ip || "").trim();
      if (!ip) continue;

      try {
        const res = await fetch("/shelly/status?ip=" + encodeURIComponent(ip));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        // ✅ Always update the CARD snapshot (no Quick Control UI changes here)
        const snap = buildShellySnapshotFromPayload(ip, data);
        const nm = (shellyDevices?.[ip]?.name || "").trim();
        upsertShellyDevice(ip, { name: nm, status: snap });

        // ✅ Only the SELECTED device is allowed to touch Quick Control widgets
        if (selected && ip === selected) {
          renderShellyStatus(ip, data);
        }

        renderAllShellyCards();
      } catch {
        // quiet failure; just mark this device stale/unavailable
        const nm = (shellyDevices?.[ip]?.name || "").trim();
        upsertShellyDevice(ip, { name: nm, status: null });
        renderAllShellyCards();
      }

      await new Promise((r) => setTimeout(r, perDeviceDelayMs));
    }
  };

  tick();
  shellyAutoTimer = window.setInterval(tick, cycleDelayMs);
}



function stopShellyAutoRefresh() {
  if (!shellyAutoTimer) return;
  window.clearInterval(shellyAutoTimer);
  shellyAutoTimer = null;
}

// Returns ONLY what the user configured (input or saved storage).
// IMPORTANT: No fallback IPs here — this is used for "Integration Health" logic.


function readShellyIpConfigured() {
  const input = $("shelly-ip-input");
  const typed = (input?.value || "").trim();
  if (typed) return typed;

  try {
    const stored = localStorage.getItem(shellyIpStorageKey);
    return (stored || "").trim() || null;
  } catch {
    return null;
  }
}


function readShellyIp() {
  const input = $("shelly-ip-input");
  if (!input) return null;
  // ✅ If a device is selected, that is the authoritative target for Quick Control
  const selected = getSelectedShellyIp();
  if (selected) return selected;

  let ip = (input.value || "").trim();

  if (!ip) {
    // Try localStorage first
    try {
      const stored = localStorage.getItem(shellyIpStorageKey);
      if (stored) {
        ip = stored;
        input.value = stored;
      }
    } catch (e) {
      console.warn("Shelly: unable to read stored IP:", e);
    }
  }

  if (!ip) {
  return null; // no configured IP yet
}

  return ip;
}
function readShellyName() {
  try {
    return localStorage.getItem(shellyNameStorageKey) || "";
  } catch {
    return "";
  }
}

function persistShellyName(name) {
  try {
    const trimmed = (name || "").trim();
    if (trimmed) {
      localStorage.setItem(shellyNameStorageKey, trimmed);
    } else {
      localStorage.removeItem(shellyNameStorageKey);
    }
  } catch {
    // ignore
  }
}

function applyShellyNameToUI(name) {
  const label = $("shelly-name-label");
  if (!label) return;

  const trimmed = (name || "").trim();
  if (!trimmed) {
    label.textContent = "";
    label.style.display = "none";
  } else {
    label.textContent = `Device name: ${trimmed}`;
    label.style.display = "";
  }
}
async function syncShellyRegistry() {
  try {
    const devices = Object.values(shellyDevices || {}).map(d => ({
      name: d.name || "",
      ip: d.ip,
    }));

    if (!devices.length) return;

    await fetch("/homeauto/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devices }),
    });
  } catch (e) {
    console.warn("Shelly registry sync failed:", e);
  }
}


function persistShellyIp(ip) {
  try {
    localStorage.setItem(shellyIpStorageKey, ip);
  } catch (e) {
    console.warn("Shelly: unable to persist IP:", e);
  }
}
const formatShellyStatusSummary = (s) => {
  if (!s) return "status unavailable";

  const parts = [];
  if (typeof s.isOn === "boolean") parts.push(s.isOn ? "ON" : "OFF");
  if (typeof s.power === "number") parts.push(`${s.power.toFixed(1)} W`);
  if (typeof s.voltage === "number") parts.push(`${s.voltage.toFixed(1)} V`);
  if (typeof s.current === "number") parts.push(`${s.current.toFixed(3)} A`);
  if (typeof s.temperature === "number") parts.push(`${s.temperature.toFixed(1)} °C`);

  return parts.length ? parts.join(" · ") : "status loaded";
};
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function isShellyInlineRenamingActive() {
  return !!document.querySelector(".shelly-device-card.is-renaming");
}

// =====================================================
// Shelly Cards (multi-device) — render + inline rename
// =====================================================

function beginShellyInlineRename(cardEl, ip) {
  if (!cardEl || !ip) return;

  const nameSpan = cardEl.querySelector("[data-shelly-name]");
  const input = cardEl.querySelector("[data-shelly-name-input]");
  if (!nameSpan || !input) return;

  // Prevent card click select while editing
  cardEl.classList.add("is-renaming");

  input.value = (nameSpan.textContent || "").trim();
  nameSpan.style.display = "none";
  input.style.display = "inline-block";

  // Focus/select
  try {
    input.focus();
    input.select();
  } catch {}
}

function cancelShellyInlineRename(cardEl) {
  if (!cardEl) return;
  cardEl.classList.remove("is-renaming");
  renderAllShellyCards(); // re-render restores normal view
}

function commitShellyInlineRename(cardEl, ip) {
  if (!cardEl || !ip) return;

  const input = cardEl.querySelector("[data-shelly-name-input]");
  if (!input) return;

  const newName = (input.value || "").trim();
  if (!newName) {
    showToast("Name can't be empty.", "warn");
    cancelShellyInlineRename(cardEl);
    return;
  }

  const prev = shellyDevices[ip] || { ip };
  shellyDevices[ip] = {
    ...prev,
    ip,
    name: newName,
  };

  try {
    if (typeof saveShellyDevicesToStorage === "function") {
      saveShellyDevicesToStorage();
    }
  } catch {}

  // If this device is selected, reflect into the "Device name" UI line too
  const selectedIp = (getSelectedShellyIp() || "").trim();
  if (selectedIp && selectedIp === ip) {
    try {
      const nameInput = $("shelly-name-input");
      if (nameInput) nameInput.value = newName;
      if (typeof applyShellyNameToUI === "function") applyShellyNameToUI(newName);
    } catch {}
  }

  showToast(`Saved name: ${newName} (${ip})`, "ok");
  renderAllShellyCards();
}

function _shellyAgo(ts) {
  if (!ts) return "";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 5)  return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function renderAllShellyCards() {
  const container = $("shellyCards");
  if (!container) return;

  container.innerHTML = "";

  const devices = Object.values(shellyDevices || {}).filter((d) => d && d.ip);

  if (!devices.length) {
    setHomeAutoHealth("degraded", "Home Automation not configured yet.");
    container.innerHTML = `<p class="sha-empty-state">No devices yet. Enter an IP above and click <strong>Add Device</strong>.</p>`;
    return;
  }

  let anyOn = false, anyOff = false, anyUnknown = false;

  devices.forEach((device) => {
    const ip = String(device.ip || "").trim();
    if (!ip) return;

    const name = String(device.name || "Shelly").trim() || "Shelly";
    const s = device.status || null;

    // Determine state: null status = unreachable
    const reachable = s !== null;
    const isOn = reachable && s.isOn === true;
    const isOff = reachable && s.isOn === false;

    if (isOn)          anyOn = true;
    else if (isOff)    anyOff = true;
    else               anyUnknown = true;

    // Dot + card state class
    const dotClass    = isOn ? "on" : isOff ? "off" : "unknown";
    const cardState   = isOn ? "sha-card--on" : isOff ? "sha-card--off" : "sha-card--unknown";
    const relayClass  = isOn ? "on" : isOff ? "off" : "unknown";
    const relayLabel  = isOn ? "ON" : isOff ? "OFF" : "—";

    // Metrics
    const powerStr   = s?.power   != null ? s.power.toFixed(1)   + " W" : "—";
    const voltageStr = s?.voltage != null ? s.voltage.toFixed(1) + " V" : "—";
    const currentStr = s?.current != null ? s.current.toFixed(3) + " A" : "—";
    const prominentPower = isOn && s?.power != null;

    const lastChecked = s?.checkedAt ? `Last checked: ${_shellyAgo(s.checkedAt)}` : "Not yet checked";

    const card = document.createElement("div");
    card.className = `card-section shelly-device-card sha-card ${cardState}`;
    card.dataset.ip = ip;

    card.innerHTML = `
      <div class="sha-card-header">
        <div class="sha-card-left">
          <span class="sha-dot sha-dot--${dotClass}" aria-hidden="true"></span>
          <div class="sha-card-name-wrap">
            <span class="shelly-card-name sha-card-name" data-shelly-name>${escapeHtml(name)}</span>
            <input class="shelly-rename-input" data-shelly-name-input type="text" value="${escapeHtml(name)}" style="display:none;" />
            <button class="btn-icon shelly-rename-btn" type="button" title="Rename device">✏️</button>
          </div>
        </div>
        <span class="sha-card-ip">${escapeHtml(ip)}</span>
      </div>

      <div class="sha-metrics">
        <div class="sha-metric${prominentPower ? " sha-metric--prominent" : ""}">
          <span class="sha-metric-label">Power</span>
          <span class="sha-metric-value">${powerStr}</span>
        </div>
        <div class="sha-metric">
          <span class="sha-metric-label">Voltage</span>
          <span class="sha-metric-value">${voltageStr}</span>
        </div>
        <div class="sha-metric">
          <span class="sha-metric-label">Current</span>
          <span class="sha-metric-value">${currentStr}</span>
        </div>
        <div class="sha-metric">
          <span class="sha-metric-label">Relay</span>
          <span class="sha-relay-badge sha-relay-badge--${relayClass}">${relayLabel}</span>
        </div>
      </div>

      <div class="sha-card-footer">
        <div class="sha-btn-row">
          <button class="btn-primary btn-sm sha-btn-action" data-sha-action="on"     type="button">Turn ON</button>
          <button class="btn-outline btn-sm sha-btn-action" data-sha-action="off"    type="button">Turn OFF</button>
          <button class="btn-outline btn-sm sha-btn-action" data-sha-action="toggle" type="button">Toggle</button>
          <button class="btn-outline btn-sm sha-btn-refresh-card"                    type="button">⟳ Refresh</button>
        </div>
        <span class="sha-last-checked">${lastChecked}</span>
      </div>
    `;

    // --- Rename button ---
    const renameBtn   = card.querySelector(".shelly-rename-btn");
    const renameInput = card.querySelector("[data-shelly-name-input]");

    if (renameBtn) {
      renameBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginShellyInlineRename(card, ip);
      });
    }
    if (renameInput) {
      renameInput.addEventListener("click", (e) => e.stopPropagation());
      renameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          commitShellyInlineRename(card, ip);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelShellyInlineRename(card);
        }
      });
      renameInput.addEventListener("blur", () => {
        if (card.classList.contains("is-renaming")) commitShellyInlineRename(card, ip);
      });
    }

    // --- Action buttons (on / off / toggle) ---
    card.querySelectorAll(".sha-btn-action").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = btn.dataset.shaAction;
        const orig   = btn.textContent;
        btn.disabled = true;
        btn.textContent = "…";
        try {
          await sendShellyAction(action, ip);
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      });
    });

    // --- Per-card Refresh ---
    const refreshBtn = card.querySelector(".sha-btn-refresh-card");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const orig = refreshBtn.textContent;
        refreshBtn.disabled = true;
        refreshBtn.textContent = "…";
        try {
          await fetchShellyStatusForIp(ip, true);
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.textContent = orig;
        }
      });
    }

    container.appendChild(card);
  });

  // Update home health pill
  if (anyOn || anyOff)       setHomeAutoHealth("ok",       "Shelly devices reachable.");
  else if (anyUnknown)       setHomeAutoHealth("degraded", "Some devices unreachable.");
}

async function fetchShellyStatusForIp(ip, silent = false) {
  const targetIp = (ip || "").trim();
  if (!targetIp) return;

  try {
    const res = await fetch("/shelly/status?ip=" + encodeURIComponent(targetIp));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    // Update single-device widgets (pill/summary/raw/quick card)
    renderShellyStatus(targetIp, data);

    // Save snapshot into the registry for cards
    const nm = (shellyDevices?.[targetIp]?.name || "").trim();
    const snap = buildShellySnapshotFromPayload(targetIp, data);
    upsertShellyDevice(targetIp, { name: nm, status: snap });

    renderAllShellyCards();
    if (!silent) showToast("Shelly status updated.", "ok");
  } catch (err) {
    if (!silent) showToast("Shelly status failed: " + err.message, "error");
  }
}

async function fetchAllShellyStatuses(silent = false) {
  suppressShellySelection = true;
  const selectedIp = (getSelectedShellyIp() || "").trim();

  try {
    const devices = Object.values(shellyDevices || {}).filter(d => d && d.ip);

    if (!devices.length) {
      setHomeAutoHealth("degraded", "Home Automation not configured yet.");
      if (!silent) showToast("Add a Shelly IP first.", "info");
      return;
    }

    const results = await Promise.allSettled(
      devices.map(d =>
        fetch("/shelly/status?ip=" + encodeURIComponent(d.ip))
          .then(r => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          })
          .then(payload => ({ ip: d.ip, payload }))
      )
    );

    let okCount = 0;
    let failCount = 0;

    for (const res of results) {
      if (res.status !== "fulfilled") {
        failCount++;
        continue;
      }

      const ip = (res.value?.ip || "").trim();
      const payload = res.value?.payload;

      if (!ip) {
        failCount++;
        continue;
      }

      // Normalize payload → status object (use your existing normalizer if present)
      const statusObj =
        (typeof normalizeShellyStatus === "function")
          ? normalizeShellyStatus(payload)
          : payload;

      upsertShellyDevice(ip, { status: statusObj });
      okCount++;

      // ✅ Only update single-device widgets for selected device
      if (selectedIp && ip === selectedIp) {
        try {
          if (typeof renderShellyStatus === "function") {
            renderShellyStatus(ip, payload);
          }
        } catch {}

        const ipInput = $("shelly-ip-input");
        if (ipInput) ipInput.value = ip;

        const nameInput = $("shelly-name-input");
        if (nameInput) {
          const nm = (shellyDevices?.[ip]?.name || "").trim();
          nameInput.value = nm || "";
        }
      }
    }

    // ✅ render cards once after updates
    renderAllShellyCards();
    if (typeof syncShellyRegistry === "function") syncShellyRegistry();

    // ✅ Update health once
    if (okCount > 0 && failCount === 0) {
      setHomeAutoHealth("ok", "All Shelly devices reachable.");
    } else if (okCount > 0) {
      setHomeAutoHealth("degraded", "Some Shelly devices unreachable.");
    } else {
      setHomeAutoHealth("down", "No Shelly devices reachable.");
    }
  } finally {
    suppressShellySelection = false;
  }
}


async function fetchShellyStatus(silent = false) {
  // For health: only treat Shelly as "configured" if user actually set an IP.
  const configuredIp = readShellyIpConfigured();

  if (!configuredIp) {
    // Don’t scream DOWN if the user never configured Home Automation.
    setHomeAutoHealth("degraded", "Home Automation not configured yet.");
    if (!silent) showToast("Enter a Shelly IP first.", "info");
    return;
  }

  // For actual fetch calls, keep your existing behavior (it can still default if you want)
  const ip = configuredIp;


  const pill = $("shelly-status-pill");
  const rawBox = $("shelly-status-raw");
  const summaryEl = $("shelly-status-summary");

  if (pill && !silent) {
    pill.textContent = "Checking…";
    pill.classList.remove("pill-ok", "pill-error");
    pill.classList.add("pill-muted");
  }
  if (rawBox && !silent) {
    rawBox.textContent = "Loading status from http://" + ip + "/status …";
  }

  try {
    const res = await fetch("/shelly/status?ip=" + encodeURIComponent(ip));
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    const data = await res.json();
    renderShellyStatus(ip, data);

upsertShellyDevice(ip, { name: (readShellyName() || "").trim(), status: lastShellyStatus });
syncShellyRegistry();
renderAllShellyCards();

    if (!silent) {
      showToast("Shelly status updated.", "ok");
    }

  } catch (err) {
    console.error("[Shelly] status failed:", err);
    if (pill) {
      pill.textContent = "Offline / unreachable";
      pill.classList.remove("pill-ok", "pill-muted");
      pill.classList.add("pill-error");
    }
    if (rawBox && !silent) {
      rawBox.textContent = "Status request failed: " + err.message;
    }
    if (summaryEl && !silent) {
      summaryEl.textContent = "";
    }
    if (!silent) {
      showToast("Shelly status failed: " + err.message, "error");
    }
  }
}

function renderShellyStatus(ip, payload) {
  const pill = $("shelly-status-pill");
  const rawBox = $("shelly-status-raw");
  const summaryEl = $("shelly-status-summary");
  const devEl = $("shelly-device-meta");
  const quickCard = $("shelly-quick-card");
  const powerDot = $("shelly-power-indicator");

  // --- normalize inputs from backend ---
  const raw = payload && payload.raw ? payload.raw : null;
  const device = payload && payload.device ? payload.device : null;

  // Pull Gen2 switch metrics from raw JSON
  const sw = raw && raw["switch:0"] ? raw["switch:0"] : null;

  const isOn =
    sw && typeof sw.output === "boolean" ? sw.output : null;

  const power =
    sw && typeof sw.apower === "number" ? sw.apower : null;

  const voltage =
    sw && typeof sw.voltage === "number" ? sw.voltage : null;

  const current =
    sw && typeof sw.current === "number" ? sw.current : null;

  const temperature =
    raw && raw.temperature && typeof raw.temperature.tC === "number"
      ? raw.temperature.tC
      : null;

  // --- Device meta line (model · fw) ---
  if (devEl) {
    if (device && device.ok) {
      const model = device.model || "Shelly";
      const ver = device.ver || device.fw_id || "fw?";
      devEl.textContent = `· ${model} · ${ver}`;
    } else if (device && device.ok === false) {
      devEl.textContent = `· device info unavailable`;
    } else {
      devEl.textContent = "";
    }
  }

  // --- Status pill (ONLINE, not "offline") ---
  if (pill) {
    if (isOn === true) {
      pill.textContent = "Relay ON";
      pill.classList.remove("pill-muted", "pill-error");
      pill.classList.add("pill-ok");
    } else if (isOn === false) {
      pill.textContent = "Relay OFF";
      pill.classList.remove("pill-muted", "pill-error");
      pill.classList.add("pill-ok");
    } else {
      pill.textContent = "Online";
      pill.classList.remove("pill-error");
      pill.classList.add("pill-muted");
    }
  }

  // --- Glow / ON state classes ---
  const on = isOn === true;

  if (quickCard) {
    quickCard.classList.toggle("shelly-on", on);
    quickCard.classList.toggle("shelly-off", !on);
  }
  if (powerDot) {
    powerDot.classList.toggle("shelly-on", on);
    powerDot.classList.toggle("shelly-off", !on);
  }

  // --- Summary line (this drives the text you see under the buttons) ---
  let summaryText = null;
  if (summaryEl) {
    const bits = [];
    bits.push("IP " + ip);

    if (typeof isOn === "boolean") bits.push(isOn ? "ON" : "OFF");
    if (power != null) bits.push(power.toFixed(1) + " W");
    if (voltage != null) bits.push(voltage.toFixed(1) + " V");
    if (current != null) bits.push(current.toFixed(3) + " A");
    if (temperature != null) bits.push(temperature.toFixed(1) + " °C");

    summaryText = bits.join(" · ");
    summaryEl.textContent = summaryText;

    // pulse refresh animation (if you have the CSS class)
    summaryEl.classList.remove("shelly-metric-pulse");
    void summaryEl.offsetWidth;
    summaryEl.classList.add("shelly-metric-pulse");
  }

  // --- Store last-known status for cards + other features ---
  lastShellyStatus = {
    ip,
    isOn,
    power,
    voltage,
    current,
    temperature,
    summaryText,
    at: new Date().toISOString(),
    raw,
  };

  // --- Raw JSON viewer ---
  if (rawBox) {
    try {
      rawBox.textContent = JSON.stringify(payload, null, 2);
    } catch {
      rawBox.textContent = String(payload);
    }
  }
    // ✅ Save normalized snapshot globally so multi-device cards can reuse it
  lastShellyStatus = {
    ip: (ip || "").trim(),
    isOn: typeof isOn === "boolean" ? isOn : null,
    power: typeof power === "number" ? power : null,
    voltage: typeof voltage === "number" ? voltage : null,
    current: typeof current === "number" ? current : null,
    temperature: typeof temperature === "number" ? temperature : null,
    at: new Date().toISOString(),
  };

}


// --- Home Automation health: SUCCESS path ---
// If we rendered Shelly status, Home automation is healthy.
setHomeAutoHealth(
  "ok",
  "Shelly reachable and responding. Home Automation layer is healthy."
);


async function sendShellyAction(action, ipOverride = null) {
  const ip = (ipOverride || getSelectedShellyIp() || readShellyIp() || "").trim();
  if (!ip) {
    showToast("Enter a Shelly IP first.", "info");
    return;
  }

  // If an override was used, keep the input in sync (nice UX)
  const ipInput = $("shelly-ip-input");
  if (ipInput && ipOverride) ipInput.value = ipOverride;

  
  // ensure device exists in registry
const typedName = ($("shelly-name-input")?.value || "").trim();
const existingName = (shellyDevices?.[ip]?.name || "").trim();
upsertShellyDevice(ip, { name: existingName || typedName || "" });
syncShellyRegistry();


  const btnId = action === "on" ? "shelly-on-btn" : "shelly-off-btn";
  const btn = $(btnId);

  await withButtonBusy(btn, "Working…", async () => {
    try {
      const res = await fetch("/shelly/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, action }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const j = await res.json();
          detail = j.detail || "";
        } catch {
          detail = await res.text();
        }
        throw new Error(detail || "HTTP " + res.status);
      }

      const data = await res.json();
      // Update pill immediately from this response
      renderShellyStatus(ip, data);
      showToast("Shelly action '" + action + "' sent.", "ok");

      // Then silently refresh full metrics (W/A/V) + keep auto refresh going
      await fetchAllShellyStatuses(true);

    } catch (err) {
      console.error("[Shelly] action failed:", err);
      showToast("Shelly action failed: " + err.message, "error");
    }
  });
}


function setupHomeAutomationPanel() {
    // ✅ On refresh: load saved Shelly devices + selection, render cards immediately
  loadShellyDevicesFromStorage();

  // Restore selected device (or pick first known IP)
  const savedSelected = getSelectedShellyIp();
  const firstIp = Object.keys(shellyDevices || {})[0] || null;
  if (savedSelected) {
    setSelectedShellyIp(savedSelected);
  } else if (firstIp) {
    setSelectedShellyIp(firstIp);
  }

  renderAllShellyCards();

  const ipInput = $("shelly-ip-input");
  if (ipInput) {
    const saved = (() => {
      try {
        return localStorage.getItem(shellyIpStorageKey);
      } catch {
        return null;
      }
    })();
    if (saved) {
      ipInput.value = saved;
    } else {
      ipInput.placeholder = "Enter Shelly IP (per device)";
    }
  }

  // NEW: Shelly friendly name
  const nameInput = $("shelly-name-input");
  if (nameInput) {
// ✅ On load: prefer selected device name (multi-device), fallback to legacy single-name
const selectedIp = (typeof getSelectedShellyIp === "function" ? getSelectedShellyIp() : null) || "";
const selectedName = (selectedIp && shellyDevices?.[selectedIp]?.name) ? String(shellyDevices[selectedIp].name).trim() : "";
const fallbackName = (readShellyName() || "").trim();
const initialName = (selectedName || fallbackName || "").trim();

if (initialName) nameInput.value = initialName;
applyShellyNameToUI(initialName);


nameInput.addEventListener("change", () => {
  const value = (nameInput.value || "").trim();

  // ✅ Multi-device: save name to the currently targeted IP (selected preferred, else typed)
  const selectedIp = (typeof getSelectedShellyIp === "function" ? getSelectedShellyIp() : null) || "";
  const typedIp = ($("shelly-ip-input")?.value || "").trim();
  const ip = (selectedIp || typedIp || "").trim();

  if (ip) {
    upsertShellyDevice(ip, { name: value });
    saveShellyDevicesToStorage();
    syncShellyRegistry();
    renderAllShellyCards();
    showToast(`Saved name for ${ip}`, "ok");
  } else {
    // fallback (no IP yet) — keep old behavior so you don’t lose UX
    persistShellyName(value);
    syncShellyRegistry();
  }

  applyShellyNameToUI(value);
});


  } else {
    // still ensure label reflects whatever is in storage
    applyShellyNameToUI(readShellyName());
  }

 const statusBtn = $("shelly-status-btn");
if (statusBtn) {
  statusBtn.addEventListener("click", () => {
    if (typeof fetchAllShellyStatuses === "function") {
      fetchAllShellyStatuses(true);
    } else {
      fetchShellyStatus(true);
    }
    startShellyAutoRefresh();
  });
}

  const refreshAllBtn = $("shelly-refresh-all-btn");
  if (refreshAllBtn) {
    refreshAllBtn.addEventListener("click", async () => {
      const orig = refreshAllBtn.textContent;
      refreshAllBtn.disabled = true;
      refreshAllBtn.textContent = "…";
      try {
        await fetchAllShellyStatuses(false);
      } finally {
        refreshAllBtn.disabled = false;
        refreshAllBtn.textContent = orig;
      }
    });
  }

  const onBtn = $("shelly-on-btn");
  if (onBtn) {
    onBtn.addEventListener("click", () => {
      sendShellyAction("on");
      startShellyAutoRefresh();
    });
  }

  const offBtn = $("shelly-off-btn");
  if (offBtn) {
    offBtn.addEventListener("click", () => {
      sendShellyAction("off");
      startShellyAutoRefresh();
    });
  }
  // ✅ Add Device button (inject if not present in HTML)
  let addBtn = $("shelly-add-device-btn");
  const nameInputEl = $("shelly-name-input");
  const ipInputEl = $("shelly-ip-input");

  if (!addBtn && nameInputEl && nameInputEl.parentElement) {
    addBtn = document.createElement("button");
    addBtn.id = "shelly-add-device-btn";
    addBtn.type = "button";
    addBtn.className = "btn"; // uses your existing button styling
    addBtn.textContent = "Add Device";

    // Insert right after the name input
    nameInputEl.parentElement.appendChild(addBtn);
  }

  if (addBtn) {
    addBtn.addEventListener("click", async () => {
      const ip = (ipInputEl?.value || "").trim();
      const name = (nameInputEl?.value || "").trim();

      if (!ip) {
        showToast("Enter the Shelly IP first.", "info");
        return;
      }

      upsertShellyDevice(ip, { ip, name, status: shellyDevices?.[ip]?.status || null });
      saveShellyDevicesToStorage();
      syncShellyRegistry();

      setSelectedShellyIp(ip);
      renderAllShellyCards();

      // Immediately fetch status so the card isn't blank
      await fetchShellyStatusForIp(ip, true);

      showToast(`Added ${name || "Shelly"} (${ip})`, "ok");
    });
  }

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

  // Sync UI from current prefs
  const radios = document.querySelectorAll('input[name="ai-policy"]');
  radios.forEach(r => { r.checked = (r.value === (AI_POLICY || AIUserPolicy.AUTO)); });

  // Populate detected info
  const localEl = $("ai-detected-local");
  const lanEl = $("ai-detected-lan");
  if (localEl) {
    localEl.textContent = AIStatus.local.available ? `✅ Available (${AIStatus.local.provider || "lmstudio"})` : "❌ Not available";
  }
  if (lanEl) {
    const c = (AIStatus.lan.nodes || []).length;
    lanEl.textContent = c ? `✅ ${c} host(s)` : "❌ None detected";
  }

  // Populate LAN host selector
  const sel = $("ai-lan-host-select");
  if (sel) {
    const pref = AI_LAN_PREFERRED || "AUTO";
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

    sel.value = pref;
  }

  updateAIRoutePreview();
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
  if (v === AIUserPolicy.LAN_ONLY) return "LAN Only";
  if (v === AIUserPolicy.PREFER_LOCAL_ALLOW_LAN) return "Prefer Local, Allow LAN";
  if (v === AIUserPolicy.PREFER_LAN_ALLOW_LOCAL) return "Prefer LAN, Allow Local";
  return "Auto (recommended)";
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

  // Preview updates
  document.querySelectorAll('input[name="ai-policy"]').forEach(r => {
    r.addEventListener("change", updateAIRoutePreview);
  });

  const hostSel = $("ai-lan-host-select");
  if (hostSel) hostSel.addEventListener("change", updateAIRoutePreview);

  // Test route (does not save)
  const testBtn = $("ai-modal-test");
  if (testBtn) testBtn.addEventListener("click", async () => {
    try {
      // temporarily preview route using UI selections (without saving globals)
      const oldPol = AI_POLICY;
      const oldPref = AI_LAN_PREFERRED;

      AI_POLICY = getSelectedPolicyFromModal();
      AI_LAN_PREFERRED = $("ai-lan-host-select") ? $("ai-lan-host-select").value : (AI_LAN_PREFERRED || "AUTO");

      const r = await resolveIntelligenceRoute({ forceRefresh: true });
      const preview = $("ai-route-preview");
      if (preview) preview.textContent = "Route preview: " + (r?.reason || "—");

      // revert
      AI_POLICY = oldPol;
      AI_LAN_PREFERRED = oldPref;
      await resolveIntelligenceRoute({ forceRefresh: true });
    } catch (e) {
      const preview = $("ai-route-preview");
      if (preview) preview.textContent = "Route preview: Error testing route.";
    }
  });

  // Save
  const saveBtn = $("ai-modal-save");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    AI_POLICY = getSelectedPolicyFromModal();
    saveAIPolicy(AI_POLICY);

    const sel = $("ai-lan-host-select");
    AI_LAN_PREFERRED = sel ? sel.value : (AI_LAN_PREFERRED || "AUTO");
    savePreferredLanNodeId(AI_LAN_PREFERRED);

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

(() => {
  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // Config
  // -----------------------------
  const SHARE_CONFIRM_GB = 5;
  const BYTES_IN_GB = 1024 * 1024 * 1024;

  const PRESENCE_OFFLINE_MS = 10 * 60 * 1000;
  const PRESENCE_IDLE_MS = 3 * 60 * 1000;
  const REFRESH_MS = 3500;

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    selectedNodeId: null,

    // rawNodes = "source of truth" (before search filtering)
    rawNodes: [],

    // nodes = filtered view (after search)
    nodes: [],

    threads: new Map(),
    transfers: [],

    refreshTimer: null,
    presenceEs: null,
    bound: false,

    lastDirectoryOk: false,
    nodeSearch: "",

    localNodeId: "local",
    localNodeName: "Me",
  };

  // Chat polling
  let _chatPollTimer = null;
  const _chatLastTs = {}; // threadId → last seen ts

  // -----------------------------
  // Utilities
  // -----------------------------
  function nowTs() { return Date.now(); }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function genId() {
    try {
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {}
    return `tli_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    const gb = bytes / BYTES_IN_GB;
    if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
    const kb = bytes / 1024;
    return `${Math.max(1, Math.round(kb))} KB`;
  }

  function parseLastSeen(value) {
    if (value == null) return null;
    if (typeof value === "number") return value < 2e10 ? value * 1000 : value;
    if (typeof value === "string") {
      const t = Date.parse(value);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  }

  function normalizeStatusFromLastSeen(lastSeenMs) {
    if (!lastSeenMs || Number.isNaN(lastSeenMs)) return "online";
    const age = nowTs() - lastSeenMs;
    if (age > PRESENCE_OFFLINE_MS) return "offline";
    if (age > PRESENCE_IDLE_MS) return "idle";
    return "online";
  }

  function presenceClass(status) {
    switch ((status || "").toLowerCase()) {
      case "online": return "tli-presence-online";
      case "idle": return "tli-presence-idle";
      case "busy": return "tli-presence-busy";
      case "sleep": return "tli-presence-sleep";
      default: return "tli-presence-offline";
    }
  }

  function ensureThread(nodeId) {
    if (!state.threads.has(nodeId)) state.threads.set(nodeId, []);
    return state.threads.get(nodeId);
  }

  async function safeFetchJson(url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // -----------------------------
  // Chat transport helpers
  // -----------------------------
  function makeThreadId(nodeId) {
    const ids = [state.localNodeId, nodeId].sort();
    return ids.join("--");
  }

  async function loadLocalNodeIdentity() {
    try {
      const r = await fetch("/mesh/node", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      state.localNodeId = d.node_id || "local";
      state.localNodeName = d.display_name || "Me";
    } catch {}
  }

  function startChatPolling(nodeId) {
    stopChatPolling();
    _chatPollTimer = setInterval(() => pollChatMessages(nodeId), 3000);
  }

  function stopChatPolling() {
    if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
  }

  async function pollChatMessages(nodeId) {
    if (!nodeId) return;
    const threadId = makeThreadId(nodeId);
    const since = _chatLastTs[threadId] || 0;
    try {
      const r = await fetch(
        `/mesh/chat/messages?thread_id=${encodeURIComponent(threadId)}&since=${since}`,
        { cache: "no-store" }
      );
      if (!r.ok) return;
      const data = await r.json();
      const incoming = (data.messages || []).filter(
        m => m.from_id !== state.localNodeId
      );
      if (!incoming.length) return;
      const thread = ensureThread(nodeId);
      for (const m of incoming) {
        thread.push({ kind: "text", from: "them", body: m.body, ts: m.ts, _msgId: m.ts + "|" + m.from_id });
        if (m.ts > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = m.ts;
      }
      if (state.selectedNodeId === nodeId) renderThread(nodeId);
    } catch {}
  }

  // -----------------------------
  // Local Loopback (for testing with 1 device)
  // -----------------------------
  function getLocalDeviceName() {
    const footer = document.getElementById("footer-device");
    if (footer && footer.textContent.trim()) return footer.textContent.trim();
    return "This Device";
  }

  function makeLocalLoopbackNode() {
    const name = getLocalDeviceName();
    return {
      id: "__local_loopback__",
      name: `${name} (Local Loopback)`,
      role: "Local",
      room: "This device",
      ip: "127.0.0.1",
      lastSeenMs: Date.now(),
      status: "online",
    };
  }

  // -----------------------------
  // Mesh directory mapping
  // -----------------------------
  function mapMeshDirectoryToNodes(data) {
    const nodes = [];

    const devices = Array.isArray(data?.devices) ? data.devices
                  : Array.isArray(data?.nodes) ? data.nodes
                  : [];

    const host = data?.host || data?.Host || null;

    if (host) {
      const id = String(host.id || host.nodeId || host.name || "Host");
      const lastSeenMs = parseLastSeen(host.lastSeen || host.last_seen || host.seenAt || host.heartbeat);
      nodes.push({
        id,
        name: String(host.name || id),
        role: "Host",
        room: String(host.room || host.location || "—"),
        ip: String(host.ip || host.addr || host.address || ""),
        lastSeenMs,
        status: String(host.status || normalizeStatusFromLastSeen(lastSeenMs)),
      });
    }

    for (const d of devices) {
      const id = String(d.device_id || d.id || d.nodeId || d.name || d.hostname || "Node");
      const lastSeenMs = parseLastSeen(d.last_seen || d.lastSeen || d.seenAt || d.heartbeat);
      nodes.push({
        id,
        name: String(
  d.display_name ||
  d.nickname ||
  d.displayName ||
  d.name ||
  d.hostname ||
  d.device_id ||
  d.id ||
  d.nodeId ||
  "Unknown Node"
),

        role: String(d.role || d.nodeRole || (d.is_host ? "Host" : "Member")),
        room: String(d.room || d.location || "—"),
        ip: String(d.ip || d.addr || d.address || ""),
        lastSeenMs,
        status: String(d.status || normalizeStatusFromLastSeen(lastSeenMs)),
      });
    }

    // Dedup
    const seen = new Set();
    const deduped = [];
    for (const n of nodes) {
      if (!n.id) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (!n.status || n.status === "—") n.status = normalizeStatusFromLastSeen(n.lastSeenMs);
      deduped.push(n);
    }

    // Sort
    const rank = (s) =>
      s === "online" ? 0 : s === "idle" ? 1 : s === "busy" ? 2 : s === "sleep" ? 3 : 9;

    deduped.sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return String(a.name).localeCompare(String(b.name));
    });

    return deduped;
  }

  // -----------------------------
  // Search filter (never wipes loopback)
  // -----------------------------
  function applyNodeSearch(nodes) {
    const q = (state.nodeSearch || "").trim().toLowerCase();
    if (!q) return nodes;

    return nodes.filter(n => {
      const hay = `${n.name} ${n.id} ${n.role} ${n.room} ${n.ip}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // -----------------------------
  // -----------------------------
  // SSE Presence stream
  // -----------------------------
  function startPresenceStream() {
    stopPresenceStream();
    const es = new EventSource("/mesh/presence/stream");
    state.presenceEs = es;

    es.onmessage = (e) => {
      try { handlePresenceEvent(JSON.parse(e.data)); } catch {}
    };

    es.onerror = () => {
      // SSE failed — fall back to polling
      stopPresenceStream();
      if (!state.refreshTimer) {
        state.refreshTimer = setInterval(refreshNodes, REFRESH_MS);
      }
    };
  }

  function stopPresenceStream() {
    if (state.presenceEs) {
      state.presenceEs.close();
      state.presenceEs = null;
    }
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  function handlePresenceEvent(evt) {
    const type = evt.type;

    if (type === "node_online") {
      const nodeId = evt.node_id;
      if (!nodeId || nodeId === state.localNodeId) return;

      const existing = state.rawNodes.find(n => n.id === nodeId);
      const nodeData = {
        id: nodeId,
        name: evt.name || nodeId,
        ip: evt.ip || "",
        tli_port: evt.tli_port || 8000,
        role: evt.role || "Member",
        room: evt.ip || "LAN",
        lastSeenMs: Date.now(),
        status: "online",
      };

      if (existing) {
        Object.assign(existing, nodeData);
      } else {
        // Replace loopback placeholder with first real node
        state.rawNodes = state.rawNodes.filter(n => n.id !== "__local_loopback__");
        state.rawNodes.push(nodeData);
      }
      state.nodes = applyNodeSearch(state.rawNodes);
      renderBuddyList();
      renderHeaderLivePill();
      updateComposerState();

    } else if (type === "node_offline") {
      const nodeId = evt.node_id;
      if (!nodeId) return;

      state.rawNodes = state.rawNodes.filter(n => n.id !== nodeId);
      if (state.rawNodes.length === 0) {
        state.rawNodes = [makeLocalLoopbackNode()];
      }
      state.nodes = applyNodeSearch(state.rawNodes);

      // If the open thread's node went offline, close it
      if (state.selectedNodeId === nodeId) {
        state.selectedNodeId = null;
        stopChatPolling();
        if (_isMobile()) _setChatMobileView("buddies");
        renderThread(null);
      }

      renderBuddyList();
      renderHeaderLivePill();
      updateComposerState();
    }
  }

  // -----------------------------
  // Refresh nodes
  // -----------------------------
  async function refreshNodes() {
    let data = meshDirectoryCache || window.meshDirectoryCache || null;

    // Prefer MeshService (shared cache + consistent parsing)
    let live = null;
    try {
      if (window.MeshService) live = await window.MeshService.fetchDirectory({ force: true });
      else live = await safeFetchJson("/mesh/directory");
    } catch {
      live = null;
    }

    if (live) {
      data = live;
      meshDirectoryCache = live;
      window.meshDirectoryCache = live;
      state.lastDirectoryOk = true;
    } else {
      state.lastDirectoryOk = !!data;
    }

    let mapped = mapMeshDirectoryToNodes(data || {});

    // ✅ Always inject loopback if empty
    if (mapped.length === 0) {
      mapped = [makeLocalLoopbackNode()];
    }

    state.rawNodes = mapped;
    state.nodes = applyNodeSearch(mapped);

    // if selected node vanished, reset
    if (state.selectedNodeId && !state.nodes.some(n => n.id === state.selectedNodeId)) {
      state.selectedNodeId = null;
      renderThread(null);
    }

    renderBuddyList();
    renderHeaderLivePill();
    updateComposerState();

    // Keep global mesh UI (header + tags) in sync
    try { syncMeshContextTags(); } catch {}

    if (state.selectedNodeId) renderThread(state.selectedNodeId);
  }

  function renderHeaderLivePill() {
    const pill = $("tli-chat-live-pill");
    if (!pill) return;

    // if we only have loopback, show "Local only"
    if (state.rawNodes.length === 1 && state.rawNodes[0].id === "__local_loopback__") {
      pill.textContent = "Local only";
      return;
    }

    if (!state.lastDirectoryOk) {
      pill.textContent = "Directory unavailable";
      return;
    }

    const onlineish = state.nodes.filter(n => (n.status || "") !== "offline").length;
    pill.textContent = onlineish === 0 ? "Waiting for nodes" : `${onlineish} online`;
  }

  // -----------------------------
  // Rendering: Buddy list
  // -----------------------------
  function renderBuddyList() {
    const list = $("tli-chat-buddies-list");
    const meta = $("tli-chat-buddies-meta");
    if (!list) return;

    const onlineCount = state.nodes.filter(n => (n.status || "") !== "offline").length;
    if (meta) meta.textContent = `${onlineCount}/${state.nodes.length}`;

    list.innerHTML = "";

    if (state.nodes.length === 0) {
      list.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No nodes match</div>
          <div class="tli-empty-sub">Try clearing the search.</div>
        </div>
      `;
      return;
    }

    for (const n of state.nodes) {
      const row = document.createElement("div");
      row.className = "tli-chat-buddy" + (state.selectedNodeId === n.id ? " active" : "");
      row.addEventListener("click", () => openThread(n.id));

      row.innerHTML = `
        <div class="tli-presence-dot ${presenceClass(n.status)}"></div>
        <div class="tli-chat-buddy-text">
          <div class="tli-chat-buddy-name">${escapeHtml(n.name)}</div>
          <div class="tli-chat-buddy-sub">${escapeHtml(`${n.room} · ${n.role}`)}</div>
        </div>
        <div class="tli-chat-buddy-actions" aria-label="Node quick actions">
          <div class="tli-chat-buddy-action" title="Open Visualizer" data-action="visualizer">📊</div>
          <div class="tli-chat-buddy-action" title="Open Tools" data-action="tools">🧰</div>
        </div>
      `;

      // Wire quick actions without triggering row selection
      const actions = row.querySelectorAll(".tli-chat-buddy-action");
      actions.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const action = btn.getAttribute("data-action") || "";

          // Local loopback routes to local panels
          if (n.id === "__local_loopback__") {
            if (action === "visualizer") switchPanel("panel-visualizer");
            if (action === "tools") switchPanel("panel-tools");
            return;
          }

          // Remote open (best-effort): use MeshService when possible
          if (window.MeshService && typeof window.MeshService.openNodePanel === "function") {
            window.MeshService.openNodePanel(n, action);
            return;
          }

          // Fallback: open remote console root
          if (n.ip) {
            window.open(`http://${n.ip}:8000/`, "_blank", "noopener");
          }
        });
      });

      list.appendChild(row);
    }
  }

  // -----------------------------
  // Rendering: Thread
  // -----------------------------
  function renderThread(nodeId) {
    const out = $("tli-chat-thread-output");
    const title = $("tli-chat-thread-title");
    const meta = $("tli-chat-thread-meta");
    if (!out || !title) return;

    if (!nodeId) {
      title.textContent = "Select a node";
      if (meta) meta.textContent = "—";
      out.innerHTML = `
        <div class="tli-empty-state">
          <div class="tli-empty-title">Ready when you are</div>
          <div class="tli-empty-sub">Pick a node on the left to start chatting or share a file.</div>
        </div>
      `;
      return;
    }

    const node = state.nodes.find(n => n.id === nodeId) || null;
    title.textContent = node ? node.name : nodeId;

    const lastSeen = node?.lastSeenMs ? new Date(node.lastSeenMs).toLocaleTimeString() : "—";
    const ip = node?.ip ? node.ip : "—";
    if (meta) meta.textContent = node ? `${node.room} · ${node.role} · ${node.status} · ${ip} · seen ${lastSeen}` : "—";

    const msgs = ensureThread(nodeId);
    out.innerHTML = "";

    if (msgs.length === 0) {
      out.innerHTML = `
        <div class="tli-empty-state">
          <div class="tli-empty-title">Say hello</div>
          <div class="tli-empty-sub">Send a message or share a file. (LAN-only)</div>
        </div>
      `;
      return;
    }

    for (const m of msgs) {
      if (m.kind === "file") {
        out.appendChild(renderFileCard(m));
        continue;
      }
      const bubble = document.createElement("div");
      bubble.className = "tli-chat-bubble " + (m.from === "me" ? "me" : "them");
      bubble.textContent = m.body;
      out.appendChild(bubble);
    }

    out.scrollTop = out.scrollHeight;
  }

  // -----------------------------
  // Composer state
  // -----------------------------
  function updateComposerState() {
    const shareBtn = $("tli-chat-share-btn");
    const sendBtn = $("tli-chat-send-btn");
    const input = $("tli-chat-input");

    const hasNode = !!state.selectedNodeId;

    if (shareBtn) shareBtn.disabled = !hasNode;
    if (sendBtn) sendBtn.disabled = !hasNode;

    if (input) {
      input.disabled = !hasNode;
      input.placeholder = hasNode ? "Message this node… (LAN-only)" : "Select a node to chat or share files…";
    }
  }

  function _isMobile() { return window.innerWidth <= 768; }

  function _setChatMobileView(view) {
    const shell = document.querySelector(".tli-chat-shell");
    if (shell) shell.setAttribute("data-mobile-view", view);
  }

  function openThread(nodeId) {
    state.selectedNodeId = nodeId;
    if (_isMobile()) _setChatMobileView("thread");
    renderBuddyList();
    renderThread(nodeId);
    updateComposerState();
    startChatPolling(nodeId);
    pollChatMessages(nodeId); // immediate first fetch

    const input = $("tli-chat-input");
    if (input) input.focus();
  }

  // -----------------------------
  // Text messaging — real transport
  // -----------------------------
  async function sendCurrentMessage() {
    const input = $("tli-chat-input");
    if (!input) return;
    const text = (input.value || "").trim();
    if (!text) return;
    if (!state.selectedNodeId) return;

    const ts = nowTs();
    const thread = ensureThread(state.selectedNodeId);
    thread.push({ kind: "text", from: "me", body: text, ts });
    input.value = "";
    renderThread(state.selectedNodeId);

    // Find remote node IP for forwarding
    const remoteNode = state.rawNodes.find(n => n.id === state.selectedNodeId);
    const toIp = remoteNode && remoteNode.ip && state.selectedNodeId !== "__local_loopback__"
      ? remoteNode.ip : null;

    const threadId = makeThreadId(state.selectedNodeId);
    // Track last ts for outgoing so we don't echo back our own messages on poll
    if (ts > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = ts;

    try {
      await fetch("/mesh/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: threadId,
          from_id: state.localNodeId,
          from_name: state.localNodeName,
          to_id: state.selectedNodeId,
          to_ip: toIp,
          body: text,
          ts,
        }),
      });
    } catch (e) {
      console.warn("[TLI Chat] send failed:", e);
    }
  }

  // -----------------------------
  // File sharing (UI-first)
  // -----------------------------
  async function createOutgoingFileOffer(file, toNodeId) {
    const id = genId();

    const msg = {
      kind: "file",
      direction: "outgoing",
      id,
      name: file.name,
      size: file.size,
      toNodeId,
      status: "offered",
      ts: nowTs(),
    };

    ensureThread(toNodeId).push(msg);
    renderThread(toNodeId);

    upsertTransfer({ id, name: file.name, size: file.size, toNodeId, status: "offered", progress: 0, ts: nowTs() });

    setTimeout(() => {
      updateMessageStatus(toNodeId, id, "pending");
      updateTransferStatus(id, "pending");
      simulateProgress(id);
    }, 250);
  }

  function renderFileCard(m) {
    const card = document.createElement("div");
    card.className = "tli-file-card";

    const sizeText = formatBytes(m.size);
    const isLarge = (m.size || 0) >= SHARE_CONFIRM_GB * BYTES_IN_GB;

    const badge = isLarge ? "Large" : "File";
    const status = m.status || "pending";

    card.innerHTML = `
      <div class="tli-file-card-title">
        <span>📦 ${escapeHtml(m.name || "file")}</span>
        <span class="pill">${escapeHtml(badge)}</span>
      </div>

      <div class="tli-file-card-meta">
        <span>Size: <strong>${escapeHtml(sizeText)}</strong></span>
        <span>To: <strong>${escapeHtml(m.toNodeId || "—")}</strong></span>
        <span>Status: <strong>${escapeHtml(status)}</strong></span>
      </div>

      <div class="tli-file-card-actions">
        ${
          m.direction === "incoming"
            ? `<button class="tli-file-btn primary" data-action="accept">Accept</button>
               <button class="tli-file-btn danger" data-action="decline">Decline</button>`
            : `<button class="tli-file-btn" data-action="cancel">Cancel</button>`
        }
      </div>
    `;

    card.querySelectorAll("button[data-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        if (action === "accept") return acceptFileOffer(m);
        if (action === "decline") return declineFileOffer(m);
        if (action === "cancel") return cancelOutgoingOffer(m);
      });
    });

    return card;
  }

  async function acceptFileOffer(m) {
    const isLarge = (m.size || 0) >= SHARE_CONFIRM_GB * BYTES_IN_GB;
    if (isLarge) {
      const ok = confirm(`Large transfer: ${formatBytes(m.size)}\n\nContinue?`);
      if (!ok) return;
    }

    updateMessageStatus(state.selectedNodeId, m.id, "accepted");
    upsertTransfer({ id: m.id, name: m.name, size: m.size, toNodeId: m.toNodeId, status: "downloading", progress: 0, ts: nowTs() });
    simulateProgress(m.id);
  }

  async function declineFileOffer(m) {
    updateMessageStatus(state.selectedNodeId, m.id, "declined");
    updateTransferStatus(m.id, "declined");
  }

  async function cancelOutgoingOffer(m) {
    updateMessageStatus(m.toNodeId, m.id, "canceled");
    updateTransferStatus(m.id, "canceled");
  }

  function updateMessageStatus(threadId, msgId, status) {
    if (!threadId) return;
    const t = ensureThread(threadId);
    const msg = t.find(x => x.kind === "file" && x.id === msgId);
    if (msg) msg.status = status;
    renderThread(threadId);
  }

  // -----------------------------
  // Transfers drawer
  // -----------------------------
  function upsertTransfer(t) {
    const idx = state.transfers.findIndex(x => x.id === t.id);
    if (idx >= 0) state.transfers[idx] = { ...state.transfers[idx], ...t };
    else state.transfers.unshift(t);
    renderTransfers();
  }

  function updateTransferStatus(id, status) {
    const tr = state.transfers.find(x => x.id === id);
    if (tr) tr.status = status;
    renderTransfers();
  }

  function setTransferProgress(id, pct) {
    const tr = state.transfers.find(x => x.id === id);
    if (tr) tr.progress = pct;
    renderTransfers();
  }

  function renderTransfers() {
    const box = $("tli-transfer-list");
    if (!box) return;

    if (!state.transfers.length) {
      box.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No transfers yet</div>
          <div class="tli-empty-sub">Share a file to create a transfer card.</div>
        </div>
      `;
      return;
    }

    box.innerHTML = "";
    for (const t of state.transfers.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = "tli-transfer-row";

      const pct = Math.max(0, Math.min(100, Number(t.progress || 0)));
      row.innerHTML = `
        <div class="tli-transfer-top">
          <div class="tli-transfer-name">📦 ${escapeHtml(t.name)} <span style="opacity:.65">· ${escapeHtml(formatBytes(t.size))}</span></div>
          <div class="tli-transfer-status">${escapeHtml(t.status || "—")}</div>
        </div>
        <div class="tli-transfer-bar"><div style="width:${pct}%"></div></div>
      `;
      box.appendChild(row);
    }
  }

  function simulateProgress(id) {
    const t0 = state.transfers.find(x => x.id === id);
    if (!t0) return;
    if (["canceled", "declined", "failed"].includes(String(t0.status))) return;

    updateTransferStatus(id, "transferring");

    let p = Number(t0.progress || 0);
    const timer = setInterval(() => {
      const tr = state.transfers.find(x => x.id === id);
      if (!tr) { clearInterval(timer); return; }
      if (["canceled", "declined", "failed"].includes(String(tr.status))) { clearInterval(timer); return; }

      p += 6 + Math.random() * 12;
      if (p >= 100) {
        p = 100;
        setTransferProgress(id, p);
        updateTransferStatus(id, "verified ✓");
        clearInterval(timer);
        return;
      }
      setTransferProgress(id, p);
    }, 280);
  }

  // -----------------------------
  // Bind UI once
  // -----------------------------
  function bindUIOnce() {
    if (state.bound) return;
    state.bound = true;

    // Send
    const sendBtn = $("tli-chat-send-btn");
    const input = $("tli-chat-input");
    if (sendBtn) sendBtn.addEventListener("click", sendCurrentMessage);
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendCurrentMessage();
        }
      });
    }

    // Share
    const shareBtn = $("tli-chat-share-btn");
    const fileInput = $("tli-chat-file-input");
    if (shareBtn && fileInput) {
      shareBtn.addEventListener("click", () => {
        if (!state.selectedNodeId) {
          alert("Select a node first (use Local Loopback if no Mesh).");
          return;
        }
        fileInput.value = "";
        fileInput.click();
      });

      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (!state.selectedNodeId) return;
        await createOutgoingFileOffer(file, state.selectedNodeId);
      });
    }

    // Search (filters rawNodes, doesn't wipe loopback)
    const search = $("tli-chat-node-search");
    if (search) {
      search.addEventListener("input", () => {
        state.nodeSearch = String(search.value || "");
        state.nodes = applyNodeSearch(state.rawNodes);
        renderBuddyList();
        renderHeaderLivePill();
      });
    }

    // Mobile: back button returns to buddy list
    const backBtn = $("tli-chat-back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        state.selectedNodeId = null;
        stopChatPolling();
        _setChatMobileView("buddies");
        renderBuddyList();
        renderThread(null);
        updateComposerState();
      });
    }
  }

  // -----------------------------
  // Public API
  // -----------------------------
  window.TLIChat = {
    async onOpen() {
      bindUIOnce();
      // Mobile: initialise view state
      if (_isMobile()) {
        _setChatMobileView(state.selectedNodeId ? "thread" : "buddies");
      }
      await loadLocalNodeIdentity();
      await refreshNodes();    // initial snapshot
      startPresenceStream();   // live updates via SSE (clears any polling timer)

      // Resume polling if a thread was already open
      if (state.selectedNodeId) {
        startChatPolling(state.selectedNodeId);
        pollChatMessages(state.selectedNodeId);
      }

      renderTransfers();
    },

    onClose() {
      stopChatPolling();
      stopPresenceStream();
    },
  };
})();

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
(function () {
  if (window.__TLI_AI_SOURCE_OF_TRUTH_V2__) return;
  window.__TLI_AI_SOURCE_OF_TRUTH_V2__ = true;

  const pillEl = () => document.getElementById("ai-source-pill");
  const pillTextEl = () => document.getElementById("ai-source-text");
  const chatBadgeEl = () => document.getElementById("ai-source-badge");
  const manageBtnEl = () => document.getElementById("ai-manage-btn");

  // AI badge polling state (avoid 'Checking…' flicker once satisfied)
  let __aiLastDisplay = null;
  let __aiPollMs = 20000;
  let __aiPollTimer = null;


  function setPill(text, state, title) {
    try {
      const p = pillEl();
      const t = pillTextEl();
      if (t) t.textContent = (text != null && text !== "" ? text : (t.textContent || "AI: Checking…"));
      if (p) {
        p.classList.remove("ai-online", "ai-degraded", "ai-offline");
        if (state === "ok") p.classList.add("ai-online");
        else if (state === "warn") p.classList.add("ai-degraded");
        else p.classList.add("ai-offline");
        if (title != null) p.title = title;
      }
    } catch {}
  }

  function setChatBadge(text, state) {
    try {
      const b = chatBadgeEl();
      if (!b) return;
      b.textContent = text || "AI: Checking…";
      b.classList.remove("badge-ok", "badge-warn", "badge-err");
      if (state === "ok") b.classList.add("badge-ok");
      else if (state === "warn") b.classList.add("badge-warn");
      else b.classList.add("badge-err");
    } catch {}
  }

  async function probeBundled() {
    const out = { modelExists: null, healthy: null, statusKnown: false };

    // Model presence
    try {
      const r = await fetch("/api/ai/model/info", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (typeof j.exists === "boolean") out.modelExists = j.exists;
      }
    } catch {}

    // Runtime status
    try {
      let r = null;
      try { r = await fetch("/api/ai/bundled/status", { cache: "no-store" }); } catch {}
      if (!r || !r.ok) {
        try { r = await fetch("/api/ai/status", { cache: "no-store" }); } catch {}
      }
      if (r && r.ok) {
        const j = await r.json().catch(() => ({}));
        if (typeof j.healthy === "boolean") out.healthy = j.healthy;
        if (out.modelExists == null && typeof j.model_exists === "boolean") out.modelExists = j.model_exists;
        out.statusKnown = true;
      }
    } catch {}

    try {
      window.__tliBundledStatus = {
        model_exists: out.modelExists,
        healthy: out.healthy,
        statusKnown: out.statusKnown
      };
    } catch {}

    return out;
  }

  function displayFromRoute(route, bundled) {
    const src = (route && route.source) ? String(route.source) : "none";
    const lmOk = !!((typeof AIStatus!=='undefined' ? AIStatus.local.available : (window.AIStatus?.local?.available)));
    const lanOk = !!((typeof AIStatus!=='undefined' ? AIStatus.lan.available : (window.AIStatus?.lan?.available)));
    const node = route?.node || ((typeof AIStatus!=='undefined' ? (AIStatus.lan.nodes && AIStatus.lan.nodes[0]) : (window.AIStatus?.lan?.nodes && window.AIStatus.lan.nodes[0]))) || null;

    // Normalize known enums
    const isLAN = (src === "lan_llm" || src === "LAN_LLM");
    const isLOCAL = (src === "local_llm" || src === "LOCAL_LLM");

    if (isLAN) {
      const nodeName = node?.name || node?.ip || "LAN host";
      return { text: "AI: Mesh", state: lanOk ? "ok" : "warn", title: `Mesh host: ${nodeName}`, kind: "mesh" };
    }

    if (isLOCAL) {
      if (lmOk) return { text: "AI: LM Studio", state: "ok", title: "Local provider: LM Studio", kind: "lmstudio" };

      // Local policy but LM Studio is down -> bundled can serve as local fallback if healthy
      if (bundled?.healthy === true) return { text: "AI: Bundled", state: "ok", title: "Local provider: Bundled AI", kind: "bundled" };

      return { text: "AI: Off", state: "warn", title: "Local AI unavailable", kind: "off" };
    }

    // NONE / unknown
    if (bundled?.healthy === true) return { text: "AI: Bundled", state: "ok", title: "Local provider: Bundled AI", kind: "bundled" };
    if (bundled?.modelExists === true) {
      const tip = (bundled?.statusKnown === true)
        ? "Bundled model is present. Runtime health not confirmed yet."
        : "Bundled model is present. Checking runtime status…";
      return { text: "AI: Bundled", state: "warn", title: tip, kind: "bundled" };
    }
    if (bundled?.modelExists === false) return { text: "AI: Off", state: "warn", title: "Bundled model missing (and no other providers)", kind: "off" };

    return { text: "AI: Off", state: "err", title: "No AI providers detected", kind: "off" };
  }

  async function refreshAll({ force = false } = {}) {
    // Only show "Checking…" on first load or when forced; keep stable label otherwise.
    try {
      const curTxt = pillTextEl()?.textContent || "";
      const needsCheck = force || !__aiLastDisplay || !curTxt || curTxt.includes("Checking");
      if (needsCheck) {
        setPill("AI: Checking…", "warn", "Checking AI route…");
        setChatBadge("AI: Checking…", "warn");
      }
    } catch {}

    // Refresh provider health so the badge can become "ready"
    try { await refreshLocalAI(); } catch {}
    try { refreshLanAI(); } catch {}

    // Resolve route via your existing policy engine
    let route = null;
    try {
      if (typeof resolveIntelligenceRoute === "function") {
        route = await resolveIntelligenceRoute({ forceRefresh: !!force });
      }
    } catch {}

    // Probe bundled (used only for fallback / labeling)
    const bundled = await probeBundled();
    const display = displayFromRoute(route, bundled);

    setPill(display.text, display.state, display.title);
    setChatBadge(display.text, display.state);

    // Remember last good state so we don't flicker back to "Checking…"
    __aiLastDisplay = display;

    // Once we have a resolved source, slow polling down (still keeps it fresh, but stops the UI spam)
    try {
      const resolved = !!display && display.kind && display.kind !== "checking";
      if (resolved && __aiPollMs < 20000) {
        __aiPollMs = 20000;
        if (__aiPollTimer) {
          clearInterval(__aiPollTimer);
          __aiPollTimer = window.setInterval(() => refreshAll({ force: false }), __aiPollMs);
        }
      }
    } catch {}

    try { window.__tliActiveAISource = display.kind; } catch {}
  }

  function openSettingsAI() {
    try {
      if (typeof switchPanel === "function") switchPanel("panel-settings");
    } catch {}
  }

  function openAiSourceModal() {
    try {
      if (typeof openAISourceModal === "function") { openAISourceModal(); return true; }
    } catch {}
    return false;
  }

  function openModelManager() {
    try {
      if (typeof window.tliOpenModelManagerModal === "function") { window.tliOpenModelManagerModal(); return true; }
      if (typeof window.tliOpenModelManager === "function") { window.tliOpenModelManager(); return true; }
      if (typeof window.openModelManagerModal === "function") { window.openModelManagerModal(); return true; }
    } catch {}
    return false;
  }

  function onManageClick(e) {
    // Header Settings button (explicit, not implied)
    try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
    openSettingsAI();
  }

  function onAiPillClick(e) {
    // Header AI pill opens the Model Manager (bundled AI download/folder/version)
    try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
    if (openModelManager()) return;
    if (typeof showToast === "function") showToast("Model Manager is not available in this build.", "warn");
    else alert("Model Manager is not available in this build.");
  }

  function bindAiPillOnce() {
    const pill = document.getElementById("ai-source-pill");
    if (!pill || pill.__tliBound) return;
    pill.__tliBound = true;
    pill.addEventListener("click", onAiPillClick);
    pill.addEventListener("keydown", (ev) => {
      const k = ev?.key;
      if (k === "Enter" || k === " ") onAiPillClick(ev);
    });
  }

function bindManageOnce() {
    const btn = manageBtnEl();
    if (!btn || btn.__tliBound) return;
    btn.__tliBound = true;

    // Premium clarity: this button navigates to Settings (not the Model Manager)
    try { btn.textContent = "Settings"; } catch {}
    try { btn.title = "Open Settings"; } catch {}

    btn.addEventListener("click", onManageClick);
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindManageOnce();
    bindAiPillOnce();
    // Delay first AI-pill refresh so it doesn't pile onto the startup fetch burst
    setTimeout(() => {
      refreshAll({ force: true });
      try {
        if (__aiPollTimer) clearInterval(__aiPollTimer);
        __aiPollTimer = window.setInterval(() => refreshAll({ force: false }), __aiPollMs);
      } catch {}
    }, 4000);
  });
})();

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
(function () {
  if (window.__TLI_MODEL_MANAGER_MM2_V2__) return;
  window.__TLI_MODEL_MANAGER_MM2_V2__ = true;

  const overlayId = "model-manager-modal-overlay";

  
  let __mm2AutoRefresh = null;
function el(id){ return document.getElementById(id); }

  function showOverlay(){
    const ov = el(overlayId);
    if (!ov) return false;
    ov.classList.remove("hidden");
    ov.setAttribute("aria-hidden", "false");
    return true;
  }

  function hideOverlay(){
    const ov = el(overlayId);
    if (!ov) return;
    ov.classList.add("hidden");
    ov.setAttribute("aria-hidden", "true");
    stopAutoRefresh();
  }


  function startAutoRefresh(){
    if (__mm2AutoRefresh) return;
    __mm2AutoRefresh = setInterval(function(){
      const ov = el(overlayId);
      if (!ov || ov.classList.contains("hidden") || ov.getAttribute("aria-hidden")==="true") return;
      refresh();
    }, 1000);
  }

  function stopAutoRefresh(){
    if (__mm2AutoRefresh){
      clearInterval(__mm2AutoRefresh);
      __mm2AutoRefresh = null;
    }
  }
  function setProgress(msg){
    const box = el("model-manager-progress");
    if (box) box.textContent = String(msg || "");
  }

  function setBar(pct, meta){
    const bar = el("model-manager-bar");
    if (bar){
      const v = Math.max(0, Math.min(100, Number(pct) || 0));
      bar.style.width = v.toFixed(1) + "%";
    }
    const m = el("model-manager-bar-meta");
    if (m) m.textContent = meta == null ? "—" : String(meta);
  }

  function fmtBytes(n){
    const v = Number(n) || 0;
    const mb = v / (1024*1024);
    if (mb < 1024) return mb.toFixed(1) + " MB";
    return (mb/1024).toFixed(2) + " GB";
  }

  async function refresh(){
    // Reset indicators (truth will set them)    setBar(0, "—");

    try{
      const r = await fetch("/api/ai/model/info", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const info = await r.json();

      if (el("model-manager-expected-name") && info.expected_name) el("model-manager-expected-name").textContent = info.expected_name;
      if (el("model-manager-expected-path") && info.expected_path) el("model-manager-expected-path").textContent = info.expected_path;

      if (el("model-manager-exists")){
        el("model-manager-exists").textContent = info.exists ? "Model found" : "Not downloaded";
        el("model-manager-exists").classList.toggle("yes", !!info.exists);
        el("model-manager-exists").classList.toggle("no", !info.exists);
      }

      // Always prefer backend recommended_url (it can be changed without frontend rebuild)
      const urlEl = el("model-manager-url");
      if (urlEl && info.recommended_url) urlEl.value = info.recommended_url;

      if (info.exists){
        setProgress("Model found.\nBundled AI can start.");
        // Hide the no-AI banner in the chat panel now that a model exists
        const noAiBanner = document.getElementById("tli-no-ai-banner");
        if (noAiBanner) noAiBanner.classList.add("hidden");
      } else {
        setProgress("Model file is missing.\nSelect it or download it here.");
      }
    } catch (e){
      setProgress("Could not query /api/ai/model/info.\n" + (e && e.message ? e.message : e));
    }
  }

  async function pollProgress(){
    const startedAt = Date.now();
    let lastDone = 0;
    let lastTs = startedAt;

    while (true){
      let st = null;
      try{
        const urlEl = el("model-manager-url");
        const qUrl = (urlEl && urlEl.value) ? ("?url=" + encodeURIComponent(urlEl.value)) : "";
        const r = await fetch("/api/ai/model/progress" + qUrl, { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        st = await r.json();
      } catch (e){
        setProgress("Could not read download progress.\n" + (e && e.message ? e.message : e));
        return;
      }

      const status = String(st.status || "idle");
      const done = Number(st.bytes_done || 0);
      const total = Number(st.bytes_total || 0);
      const pct = total > 0 ? (done / total * 100) : 0;

      const now = Date.now();
      const dt = Math.max(0.25, (now - lastTs) / 1000);
      const speed = (done - lastDone) / dt; // bytes/sec
      lastDone = done;
      lastTs = now;

      // UI updates
      if (status === "downloading"){
        const meta = total > 0
          ? `${fmtBytes(done)} / ${fmtBytes(total)} · ${(speed/(1024*1024)).toFixed(1)} MB/s`
          : `${fmtBytes(done)} · ${(speed/(1024*1024)).toFixed(1)} MB/s`;
        setBar(total > 0 ? pct : 0, meta);
        setProgress(`Downloading… ${total > 0 ? pct.toFixed(1) + "%" : ""}\n${meta}`);
      } else if (status === "starting_ai"){        setBar(100, "Download complete · starting AI…");
        setProgress("Download complete.\nStarting Bundled AI…");
      } else if (status === "complete"){        setBar(100, "Download complete.");
        setProgress("Download complete.\nModel saved. You can close this window.");
        await refresh();
        return;
      } else if (status === "error"){
        setBar(0, "—");
        setProgress("Download failed.\n" + (st.error || "Unknown error") + "\n\nTip: If download fails, you can still select a local .gguf and TLI will place it at the expected path.");
        return;
      } else {
        // idle/unknown
        const elapsed = (Date.now() - startedAt) / 1000;
        if (elapsed > 3){
          // not moving; bail with a useful message
          setProgress("Download did not start.\nIf your installer backend is missing the /api/ai/model/* endpoints, rebuild the installer backend.\n\nTip: Use the Open button for manual download.");
          return;
        }
      }

      await new Promise(res => setTimeout(res, 500));
    }
  }

  async function startDownload(){
    // Always clear visual indicators at the start    setBar(0, "—");

    const url = el("model-manager-url")?.value || "";
    if (!url) { setProgress("No download URL set."); return; }

    try{
      setProgress("Starting download via backend…");
      const r = await fetch("/api/ai/model/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      await r.json().catch(() => ({}));
      await pollProgress();
    } catch (e){
      // Do NOT auto-open browser (proxy/captive portal causes credential popups)
      setProgress(
        "Backend download not available.\n\n" +
        "This usually means your running backend build is missing /api/ai/model/* endpoints, OR the request is being blocked.\n\n" +
        "Workaround:\n" +
        "1) Click Open to open the URL manually\n" +
        "2) Download the .gguf in your browser\n" +
        "3) Place it at the expected path shown above\n" +
        "4) Click Recheck\n\n" +
        (e && e.message ? e.message : e)
      );
    }
  }

  function bindOnce(){
    const close = el("model-manager-close");
    if (close && !close.__b){ close.__b = true; close.addEventListener("click", hideOverlay); }

    const x = el("model-manager-x");
    if (x && !x.__b){ x.__b = true; x.addEventListener("click", hideOverlay); }

    const ov = el(overlayId);
    if (ov && !ov.__b){
      ov.__b = true;
      ov.addEventListener("click", (e) => { if (e.target && e.target.id === overlayId) hideOverlay(); });
    }
    const copy = el("model-manager-copy");
    if (copy && !copy.__b){
      copy.__b = true;
      copy.addEventListener("click", async () => {
        const url = el("model-manager-url")?.value || "";
        try{ await navigator.clipboard.writeText(url); setProgress("Link copied.\n" + url); }
        catch{ setProgress("Copy failed. Manually copy:\n" + url); }
      });
    }

    const reveal = el("model-manager-reveal");
    if (reveal && !reveal.__b){
      reveal.__b = true;
      reveal.addEventListener("click", async () => {
        try{
          await fetch("/api/ai/model/reveal", {method:"POST"});
          setProgress("Opened models folder.");
        }catch{ setProgress("Could not open models folder."); }
      });
    }

    const cancelBtn = el("model-manager-cancel");
    if (cancelBtn && !cancelBtn.__b){
      cancelBtn.__b = true;
      cancelBtn.addEventListener("click", async () => {
        cancelBtn.disabled = true;
        try{
          await fetch("/api/ai/model/cancel", {method:"POST"});
          setProgress("Download cancelled.");
          setBar(0);
          el("model-manager-bar-meta").textContent = "—";
          await refresh();
        }catch{ setProgress("Cancel failed."); }
        cancelBtn.disabled = false;
      });
    }

    const dl = el("model-manager-download");
    if (dl && !dl.__b){
      dl.__b = true;
      dl.addEventListener("click", startDownload);
    }

    const sel = el("model-manager-select");
    const file = el("model-manager-file");
    if (sel && file && !sel.__b){
      sel.__b = true;
      sel.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        setProgress("Selected: " + f.name + "\nAttempting upload…");
        try{
          const fd = new FormData();
          fd.append("file", f);
          const r = await fetch("/api/ai/model/upload", { method: "POST", body: fd });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const j = await r.json().catch(() => ({}));
          setProgress("Upload complete.\n" + (j.message || "Recheck to confirm."));
          await refresh();
        } catch (e){
          setProgress("Upload endpoint not available.\nPlace file manually at expected path, then Recheck.\n\nSelected: " + f.name);
        }
      });
    }
// NOTE: Header Manage button (#ai-manage-btn) is handled by AI Source-of-Truth v2.
// Here we only bind legacy buttons if present.
const legacyManage = document.getElementById("ai-status-manage-btn");
if (legacyManage && !legacyManage.__mm2b){
  legacyManage.__mm2b = true;
  legacyManage.addEventListener("click", open);
}}

  function open(){
    if (!showOverlay()){ alert("Model setup overlay not found."); return; }
    refresh();
  }

  // Expose API expected by header/manage
  window.tliOpenModelManagerModal = open;

  function boot(){
    bindOnce();
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      bindOnce();
      if (tries > 40) clearInterval(t);
    }, 250);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();



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
(() => {
  const TAG = "TLI_PRINTERS_NATIVE_SETTINGS_WIRE";

  async function _openNativePrinters() {
    try {
      await fetch("/api/printers/open_add", { method: "POST" });
      if (typeof toast === "function") toast("Opening system printer screen…");
      else if (typeof showToast === "function") showToast("Opening system printer screen…");
    } catch (e) {
      if (typeof toast === "function") toast("Printer screen not available (backend).", "warning");
      else if (typeof showToast === "function") showToast("Printer screen not available (backend).", "warning");
      console.warn(TAG, "open_add failed:", e);
    }
  }

  function _btnText(el) {
    try { return (el.textContent || "").trim().toLowerCase(); } catch { return ""; }
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t) return;

    // find closest button-like element
    const btn = t.closest("button, .btn, [role='button']");
    if (!btn) return;

    const txt = _btnText(btn);
    if (txt === "discover" || txt === "add printer") {
      ev.preventDefault();
      _openNativePrinters();
    }
  }, true);
})();



/* === TLI PRINTERS MODULE v2 (locked) === */
/* === TLI PRINTERS MODULE v2 (locked) ===
   Restores: Refresh list + WIA devices + OS open + Test Print
   Backend endpoints expected:
     GET /api/printers
     GET|POST /api/printers/open_add
     GET /api/scan/wia/devices
     POST /api/printers/test_print
     POST /api/printers/fix  (optional)
========================================= */
(function(){
  function pill(id, text, cls){
    const el = document.getElementById(id);
    if (!el) return;
    el.className = "pill " + (cls || "pill-muted");
    el.textContent = text;
  }
  function setText(id, text){
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
  }
  function esc(s){
    return String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  }
  async function fetchJson(url, opts){
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch {}
    return { r, j };
  }
  function renderPrinters(printers, meta){
    const box = document.getElementById("devices-printers-list");
    if (!box) return;
    if (!Array.isArray(printers) || printers.length === 0){
      box.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No printers found</div>
          <div class="tli-empty-sub">If your printer isn’t installed yet, click Add Printer.</div>
        </div>`;
      return;
    }
    const head = meta?.default_printer ? `<div class="small-meta" style="margin-bottom:8px;">Default: <b>${esc(meta.default_printer)}</b></div>` : "";
    box.innerHTML = head + printers.map(p => {
      const name = esc(p.Name || p.name || "Printer");
      const driver = esc(p.DriverName || p.driver || "—");
      const port = esc(p.PortName || p.port || "—");
      const isDefault = !!(p.Default || p.default || p.is_default);
      return `
        <div class="card-mini">
          <div class="card-mini-title">${name}${isDefault ? ' <span class="badge">Default</span>' : ""}</div>
          <div class="card-mini-sub">Driver: <code>${driver}</code> · Port: <code>${port}</code></div>
        </div>`;
    }).join("");
  }

  window.refreshPrinters = async function(){
    pill("devices-printers-status", "Scanning…", "pill-muted");
    setText("devices-printers-summary", "");
    try{
      const { r, j } = await fetchJson("/api/printers");
      // /api/printers returns a raw array on success, or {ok:false, error:"..."} on failure
      if (!r.ok || !j){
        const msg = (j && (j.error || j.detail)) ? (j.error || j.detail) : ("HTTP " + r.status);
        pill("devices-printers-status", "Error", "pill-warn");
        setText("devices-printers-summary", msg);
        return;
      }
      if (!Array.isArray(j) && j.ok === false){
        pill("devices-printers-status", "Error", "pill-warn");
        setText("devices-printers-summary", j.error || "Unknown error");
        return;
      }
      const printers = Array.isArray(j) ? j : [];
      const defaultPrinter = printers.find(p => p.is_default || p.Default)?.name || null;
      pill("devices-printers-status", "OK", "pill-ok");
      setText("devices-printers-summary", `Found ${printers.length} printer(s).`);
      renderPrinters(printers, { default_printer: defaultPrinter });
    }catch(e){
      pill("devices-printers-status", "Error", "pill-warn");
      setText("devices-printers-summary", String(e));
    }
  };

  window.openAddPrinter = async function(){
    try{
      // backend supports GET or POST (we'll POST)
      await fetch("/api/printers/open_add", { method: "POST" });
      if (typeof toast === "function") toast("Opening system printer screen…");
      else if (typeof showToast === "function") showToast("Opening system printer screen…");
    }catch(e){
      if (typeof toast === "function") toast("Could not open printer screen.", "warning");
      else if (typeof showToast === "function") showToast("Could not open printer screen.", "warning");
    }
  };

  window.discoverPrinters = async function(){
    try { await fetch("/api/printers/discover"); } catch {}
    try { await window.openAddPrinter(); } catch {}
    try { await window.refreshPrinters(); } catch {}
  };

  window.fixPrinter = async function(){
  pill("devices-printers-status", "Working…", "pill-muted");
  setText("devices-printers-summary", "Attempting repair…");
  try{
    const { r, j } = await fetchJson("/api/quick/fix_printer", { method: "POST" });
    if (!r.ok || !j || (j.status !== "ok" && j.ok !== true)){
      const msg = (j && (j.message || j.detail || j.error)) ? (j.message || j.detail || j.error) : ("HTTP " + r.status);
      pill("devices-printers-status", "Error", "pill-warn");
      setText("devices-printers-summary", msg);
      return;
    }
    // j.healthy=true means “nothing was wrong”
    pill("devices-printers-status", j.healthy ? "Healthy" : "OK", "pill-ok");
    setText("devices-printers-summary", j.message || "Repair completed.");
    try { await window.refreshPrinters(); } catch {}
  }catch(e){
    pill("devices-printers-status", "Error", "pill-warn");
    setText("devices-printers-summary", String(e));
  }
};

  // ---- WIA: devices dropdown ----
  window.refreshWiaDevices = async function(){
    pill("wia-status", "Loading…", "pill-muted");
    setText("wia-summary", "Loading WIA devices…");
    const sel = document.getElementById("wia-device");
    if (!sel) return;
    try{
      const { r, j } = await fetchJson("/api/scan/wia/devices");
      sel.innerHTML = "";
      if (!r.ok || !j || j.ok !== true){
        sel.innerHTML = `<option value="">No WIA devices</option>`;
        pill("wia-status", "WIA unavailable", "pill-warn");
        setText("wia-summary", (j && (j.message || j.detail)) ? (j.message || j.detail) : ("HTTP " + r.status));
        return;
      }
      const devs = Array.isArray(j.devices) ? j.devices : [];
      if (devs.length === 0){
        sel.innerHTML = `<option value="">No WIA devices</option>`;
        pill("wia-status", "No devices", "pill-warn");
        setText("wia-summary", "Windows reports no WIA scanners.");
        return;
      }
      for (const d of devs){
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.name || d.id;
        sel.appendChild(opt);
      }
      pill("wia-status", "WIA ready", "pill-ok");
      setText("wia-summary", `Found ${devs.length} device(s).`);
    }catch(e){
      sel.innerHTML = `<option value="">No WIA devices</option>`;
      pill("wia-status", "WIA error", "pill-warn");
      setText("wia-summary", String(e));
    }
  };

  // Ensure PDF option exists in format select
  try{
    const fmt = document.getElementById("wia-format");
    if (fmt){
      const hasPdf = Array.from(fmt.options).some(o => (o.value || "").toLowerCase() === "pdf");
      if (!hasPdf){
        const opt = document.createElement("option");
        opt.value = "pdf";
        opt.textContent = "PDF";
        fmt.appendChild(opt);
      }
    }
  }catch{}

  // ---- Test Print ----
  window.testPrint = async function(){
    pill("devices-printers-status", "Printing…", "pill-muted");
    setText("devices-printers-summary", "Sending TLI test page…");
    try{
      const { r, j } = await fetchJson("/api/printers/test_print", { method: "POST" });
      if (!r.ok || !j || j.ok !== true){
        const msg = (j && (j.message || j.detail)) ? (j.message || j.detail) : ("HTTP " + r.status);
        pill("devices-printers-status", "Error", "pill-warn");
        setText("devices-printers-summary", msg);
        return;
      }
      pill("devices-printers-status", "Sent", "pill-ok");
      setText("devices-printers-summary", "Test page sent to: " + (j.printer || "Default printer"));
      try{
        if (typeof toast === "function") toast("Test page sent.");
        else if (typeof showToast === "function") showToast("Test page sent.");
      }catch{}
    }catch(e){
      pill("devices-printers-status", "Error", "pill-warn");
      setText("devices-printers-summary", String(e));
    }
  };

  // Add a Test Print button next to Add Printer if it doesn't exist
  function ensureTestButton(){
    try{
      const btns = Array.from(document.querySelectorAll("button"));
      const add = btns.find(b => (b.textContent || "").trim().toLowerCase() === "add printer");
      if (add){
        const parent = add.parentElement;
        if (parent && !parent.querySelector('button[data-tli="test-print"]')){
          const b = document.createElement("button");
          b.className = add.className || "btn-ghost";
          b.textContent = "Test Print";
          b.setAttribute("data-tli", "test-print");
          b.onclick = () => window.testPrint();
          parent.insertBefore(b, add);
        }
      }
    }catch{}
  }
  let tries = 0;
  const t = setInterval(()=>{ ensureTestButton(); tries++; if (tries>10) clearInterval(t); }, 500);

  // Bootstrap — printer refresh moved to dedicated IIFE below to prevent duplicate startup calls
  // setTimeout(()=>{ try{ window.refreshPrinters(); }catch{} try{ window.refreshWiaDevices(); }catch{} }, 300);

  // Auto-load printers + WIA devices once UI is ready — suppressed (duplicate, see TLI_PRINTERS_HTTP_FALLBACK_V1)
  // try { setTimeout(() => { window.refreshPrinters && window.refreshPrinters(); window.refreshWiaDevices && window.refreshWiaDevices(); }, 250); } catch {}
})();


/* =========================================================
   TLI_PRINTERS_HPSMART_BUNDLE_V1
   Professional HP Smart-like renderer for Printers panel.
   - Search / Filters / Sort
   - Rollup strip (A): overall health + default + issue counts
   - Actions (B): Manage (open OS printers UI) + Test (default printer)
   - Truncation + tap-to-copy chips
   Safety: additive; discovery-only
   ========================================================= */
(() => {
  const TAG = "TLI_PRINTERS_HPSMART_BUNDLE_V1";

  const STATE = { printers: [], query: "", filter: "all", sort: "default", expanded: new Set(), showVirtual: false, suppliesByName: {} };
  const STATUS_ORDER = { ready: 0, unknown: 1, offline: 2, error: 3 };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function norm(s) { return String(s ?? "").trim().toLowerCase(); }
  function keyOf(p) { return String(p?.system_name || p?.name || "").trim() || "printer"; }

  function pillClassForStatus(status) {
    const s = norm(status);
    if (s === "ready") return "pill-ok";
    if (s === "offline") return "pill-warn";
    if (s === "error") return "pill-warn";
    return "pill-muted";
  }
  function statusIcon(status) {
    const s = norm(status);
    if (s === "ready") return "✅";
    if (s === "offline") return "📴";
    if (s === "error") return "⚠️";
    return "•";
  }
  

  function suppliesHtml(p) {
    try {
      const name = p?.name ? String(p.name) : "";
      const it = name ? STATE.suppliesByName?.[name] : null;
      if (!it) return `<div class="tli-supplies-note">Ink: <span class="pill pill-muted">not loaded</span></div>`;
      if (it.ok !== true) {
        const msg = esc(it.error || "Unavailable");
        return `<div class="tli-supplies-note">Ink: <span class="pill pill-warn">unavailable</span> <span class="small-meta">${msg}</span></div>`;
      }
      const arr = Array.isArray(it.supplies) ? it.supplies : [];
      if (!arr.length) return `<div class="tli-supplies-note">Ink: <span class="pill pill-muted">no data</span></div>`;
      const rows = arr.map(s => {
        const label = esc(s?.name || s?.description || "Supply");
        const pct = (typeof s?.percent === "number") ? s.percent : null;
        const pctText = (pct === null || Number.isNaN(pct)) ? "—" : `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
        const barW = (pct === null || Number.isNaN(pct)) ? 0 : Math.max(0, Math.min(100, Math.round(pct)));
        return `
          <div class="tli-supply-row">
            <div class="tli-supply-top"><span class="tli-supply-name">${label}</span><span class="tli-supply-pct">${pctText}</span></div>
            <div class="tli-supply-bar"><div class="tli-supply-fill" style="width:${barW}%"></div></div>
          </div>`;
      }).join("");
      return `<div class="tli-supplies">
        <div class="tli-supplies-head">Ink / Toner <span class="small-meta">via SNMP</span></div>
        ${rows}
      </div>`;
    } catch {
      return `<div class="tli-supplies-note">Ink: <span class="pill pill-muted">unknown</span></div>`;
    }
  }

function toastMsg(msg, kind) {
    try { if (typeof toast === "function") return toast(msg, kind); if (typeof showToast === "function") return showToast(msg, kind); } catch {}
  }

  function applyFilter(list) {
    const q = norm(STATE.query);
    const f = STATE.filter;
    return (list || []).filter((p) => {
      const name = norm(p?.name);
      const driver = norm(p?.driver);
      const port = norm(p?.port);
      const loc = norm(p?.location);
      const st = norm(p?.status);
      const matches = !q || name.includes(q) || driver.includes(q) || port.includes(q) || loc.includes(q) || st.includes(q);
      if (!matches) return false;
      if (!STATE.showVirtual && !!p?.is_virtual) return false;
      if (f === "all") return true;
      if (f === "default") return !!p?.is_default;
      if (f === "network") return !!p?.is_network;
      if (f === "local") return !p?.is_network;
      if (f === "issues") return st === "offline" || st === "error";
      return true;
    });
  }

  function applySort(list) {
    const s = STATE.sort;
    const arr = [...(list || [])];
    if (s === "name") { arr.sort((a, b) => norm(a?.name).localeCompare(norm(b?.name))); return arr; }
    if (s === "status") { arr.sort((a, b) => (STATUS_ORDER[norm(a?.status)] ?? 9) - (STATUS_ORDER[norm(b?.status)] ?? 9)); return arr; }
    arr.sort((a, b) => {
      const ad = a?.is_default ? 0 : 1;
      const bd = b?.is_default ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return norm(a?.name).localeCompare(norm(b?.name));
    });
    return arr;
  }

  function ensureToolbar() {
    const list = $("devices-printers-list");
    if (!list) return;
    const host = list.parentElement;
    if (!host) return;
    if ($("tli-printers-toolbar")) return;

    const toolbar = document.createElement("div");
    toolbar.id = "tli-printers-toolbar";
    toolbar.className = "tli-printers-toolbar";
    toolbar.innerHTML = `
      <div class="tli-printers-toolbar-row">
        <div class="tli-printers-search">
          <span class="tli-printers-search-ico" aria-hidden="true">🔎</span>
          <input id="tli-printers-search" class="input tli-printers-search-input" placeholder="Search printers, drivers, ports, status…" />
          <button id="tli-printers-clear" class="btn-ghost tli-printers-clear" title="Clear search" aria-label="Clear search">✕</button>
        </div>
        <div class="tli-printers-controls">
          <div class="tli-printers-seg" role="tablist" aria-label="Printer filters">
            <button class="tli-seg-btn" data-filter="all">All</button>
            <button class="tli-seg-btn" data-filter="default">Default</button>
            <button class="tli-seg-btn" data-filter="network">Network</button>
            <button class="tli-seg-btn" data-filter="local">Local</button>
            <button class="tli-seg-btn" data-filter="issues">Issues</button>
          </div>
          <select id="tli-printers-sort" class="input tli-printers-sort" aria-label="Sort printers">
            <option value="default">Sort: Default</option>
            <option value="name">Sort: Name</option>
            <option value="status">Sort: Status</option>
          </select>
          <label class="tli-printers-toggle" title="Show system/virtual printers (PDF, Fax, OneNote, XPS)"><input type="checkbox" id="tli-printers-show-virtual" /> System</label>
        </div
      </div>
      <div class="tli-printers-toolbar-meta"><span id="tli-printers-count" class="small-meta"></span></div>
    `;
    host.insertBefore(toolbar, list);

    const search = $("tli-printers-search");
    const clear = $("tli-printers-clear");
    const sort = $("tli-printers-sort");

    search?.addEventListener("input", () => { STATE.query = search.value || ""; render(); });
    clear?.addEventListener("click", () => { STATE.query = ""; if (search) search.value = ""; render(); search?.focus?.(); });

    toolbar.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("button[data-filter]");
      if (!btn) return;
      STATE.filter = btn.getAttribute("data-filter") || "all";
      render();
    });
    sort?.addEventListener("change", () => { STATE.sort = sort.value || "default"; render(); });


    const showVirtual = $("tli-printers-show-virtual");
    if (showVirtual) { showVirtual.checked = !!STATE.showVirtual; showVirtual.addEventListener("change", () => { STATE.showVirtual = !!showVirtual.checked; render(); }); }
    render();
  }

  function setSegActive(filter) {
    const toolbar = $("tli-printers-toolbar");
    if (!toolbar) return;
    const btns = Array.from(toolbar.querySelectorAll("button[data-filter]"));
    for (const b of btns) {
      const on = (b.getAttribute("data-filter") || "") === filter;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function updateRollup(list) {
    const host = $("tli-printers-rollup");
    if (!host) return;
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) { host.classList.add("hidden"); host.innerHTML = ""; return; }

    const def = arr.find((p) => !!p?.is_default);
    const defName = def?.name ? esc(def.name) : "";

    const offline = arr.filter((p) => norm(p?.status) === "offline").length;
    const error = arr.filter((p) => norm(p?.status) === "error").length;
    const issues = offline + error;

    const headline = issues ? "Needs attention" : "All good";
    const pillCls = issues ? "pill-warn" : "pill-ok";

    host.classList.remove("hidden");
    host.innerHTML = `
      <div class="tli-rollup-left">
        <span class="pill ${pillCls}">${esc(headline)}</span>
        <span class="tli-rollup-title">Printers</span>
        <span class="tli-rollup-meta">
          ${defName ? `Default: <b>${defName}</b> · ` : ""}
          ${issues ? `${issues} issue(s)` : `${arr.length} available`}
          ${offline ? ` · Offline: ${offline}` : ""}
          ${error ? ` · Errors: ${error}` : ""}
        </span>
      </div>
      <div class="tli-rollup-actions">
        <button class="btn-ghost" id="tli-rollup-manage" title="Open system printers">Manage</button>
        <button class="btn-ghost" id="tli-rollup-test" title="Send test page to default printer">Test page</button>
      </div>
    `;

    $("tli-rollup-manage")?.addEventListener("click", async () => {
      try { if (typeof window.openAddPrinter === "function") return await window.openAddPrinter(); await fetch("/api/printers/open_add", { method: "POST" }); }
      catch { toastMsg("Could not open printer settings.", "warning"); }
    });
    $("tli-rollup-test")?.addEventListener("click", async () => {
      try { if (typeof window.testPrint === "function") return await window.testPrint(); await fetch("/api/printers/test_print", { method: "POST" }); }
      catch { toastMsg("Could not send test page.", "warning"); }
    });
  }

  function renderEmpty(title, subtitle) {
    const box = $("devices-printers-list");
    if (!box) return;
    box.classList.remove("tli-printers-grid");
    box.innerHTML = `
      <div class="tli-empty-mini tli-empty-polished">
        <div class="tli-empty-title">${esc(title || "No printers found")}</div>
        <div class="tli-empty-sub">${esc(subtitle || "Click Refresh to load installed printers, or Add Printer to install one.")}</div>
      </div>
    `;
  }

  function renderLoading() {
    const box = $("devices-printers-list");
    if (!box) return;
    box.classList.remove("tli-printers-grid");
    box.innerHTML = `
      <div class="tli-printers-skeleton">
        ${Array.from({ length: 4 }).map(() => `
          <div class="tli-printer-card tli-skel">
            <div class="tli-printer-top">
              <div class="tli-skel-line w60"></div>
              <div class="tli-skel-pill"></div>
            </div>
            <div class="tli-skel-line w40"></div>
            <div class="tli-skel-line w80"></div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function render() {
    ensureToolbar();
    setSegActive(STATE.filter);

    const box = $("devices-printers-list");
    const count = $("tli-printers-count");
    if (!box) return;

    const filtered = applyFilter(STATE.printers);
    const sorted = applySort(filtered);

    if (count) count.textContent = `${sorted.length} shown · ${STATE.printers.length} total`;

    updateRollup(STATE.printers);

    if (!sorted.length) {
      renderEmpty(STATE.printers.length ? "No matches" : "No printers found", STATE.printers.length ? "Try a different search or filter." : "Click Refresh to load installed printers.");
      return;
    }

    box.classList.add("tli-printers-grid");
    box.innerHTML = sorted.map((p) => {
      const k = keyOf(p);
      const open = STATE.expanded.has(k);

      const name = esc(p?.name || "Printer");
      const driver = esc(p?.driver || "—");
      const port = esc(p?.port || "—");
      const location = esc(p?.location || "");
      const type = p?.is_network ? "Network" : "Local";
      const status = esc(norm(p?.status) || "unknown");

      const testDisabled = !p?.is_default;
      const testTitle = testDisabled ? "Test page prints to the default printer" : "Send test page";

      return `
        <div class="tli-printer-card" data-key="${esc(k)}">
          <div class="tli-printer-top">
            <div class="tli-printer-name">
              <span class="tli-printer-status-dot ${esc(pillClassForStatus(status))}" aria-hidden="true"></span>
              <span class="tli-printer-title">${esc(statusIcon(status))} ${name}</span>
              ${p?.is_default ? `<span class="badge tli-badge">Default</span>` : ``}
              <span class="badge tli-badge">${esc(type)}</span>
            </div>

            <div class="tli-printer-actions">
              <button class="btn-ghost" data-expand="${esc(k)}" aria-expanded="${open ? "true" : "false"}">${open ? "Hide" : "Details"}</button>
            </div>
          </div>

          <div class="tli-printer-sub">
            <span class="tli-kv"><span class="tli-k">Driver</span><span class="tli-v"><code class="tli-code" data-full="${driver}">${driver}</code></span></span>
            <span class="tli-kv"><span class="tli-k">Port</span><span class="tli-v"><code class="tli-code" data-full="${port}">${port}</code></span></span>
            <span class="tli-kv"><span class="tli-k">Status</span><span class="tli-v"><span class="pill ${esc(pillClassForStatus(status))}">${status}</span></span></span>
          </div>

          <div class="tli-printer-details ${open ? "is-open" : ""}">
            ${location ? `<div class="tli-detail-row"><span class="tli-detail-k">Location</span><span class="tli-detail-v"><code class="tli-code" data-full="${location}">${location}</code></span></div>` : ""}
            <div class="tli-detail-row"><span class="tli-detail-k">System name</span><span class="tli-detail-v"><code class="tli-code" data-full="${esc(p?.system_name || p?.name || "")}">${esc(p?.system_name || p?.name || "")}</code></span></div>
            ${(p?.ip || p?.hostname) ? `<div class="tli-detail-row"><span class="tli-detail-k">Host</span><span class="tli-detail-v"><code class="tli-code" data-full="${esc(p?.ip || p?.hostname)}">${esc(p?.ip || p?.hostname)}</code></span></div>` : ``}
            <div class="tli-detail-actions">
              <button class="btn-ghost" data-manage="${esc(k)}" title="Open system printers">Manage</button>
              <button class="btn-ghost" data-test="${esc(k)}" title="${esc(testTitle)}" ${testDisabled ? "disabled" : ""}>Test page</button>
            </div>
            ${suppliesHtml(p)}
          </div>
        </div>
      `;
    }).join("");

    box.onclick = async (ev) => {
      const expand = ev.target?.closest?.("button[data-expand]");
      if (expand) {
        const k = expand.getAttribute("data-expand") || "";
        if (!k) return;
        if (STATE.expanded.has(k)) STATE.expanded.delete(k);
        else STATE.expanded.add(k);
        render();
        return;
      }
      const manage = ev.target?.closest?.("button[data-manage]");
      if (manage) {
        try { if (typeof window.openAddPrinter === "function") return await window.openAddPrinter(); await fetch("/api/printers/open_add", { method: "POST" }); toastMsg("Opening system printer screen…"); }
        catch { toastMsg("Could not open printer screen.", "warning"); }
        return;
      }
      const test = ev.target?.closest?.("button[data-test]");
      if (test && !test.disabled) {
        try { if (typeof window.testPrint === "function") return await window.testPrint(); await fetch("/api/printers/test_print", { method: "POST" }); toastMsg("Test page sent."); }
        catch { toastMsg("Could not send test page.", "warning"); }
      }
    };
  }

  // Tap-to-copy
  document.addEventListener("click", (ev) => {
    const code = ev.target?.closest?.(".tli-code");
    if (!code) return;
    const val = code.getAttribute("data-full") || code.textContent || "";
    const t = String(val).trim();
    if (!t) return;
    navigator.clipboard?.writeText?.(t).catch(() => {});
    code.classList.add("is-copied");
    window.setTimeout(() => code.classList.remove("is-copied"), 450);
  });

  async function fetchPrinters() {
    const r = await fetch("/api/printers", { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error("Printer service error");
    if (Array.isArray(j)) return j;
    if (j && typeof j === "object" && j.ok === false) return [];
    if (j && j.ok === true && Array.isArray(j.printers)) {
      return j.printers.map((p) => ({
        name: p?.name || p?.Name,
        system_name: p?.system_name || p?.name || p?.Name,
        is_default: !!(p?.is_default || p?.Default || p?.default),
        status: (p?.status || p?.PrinterStatus || "unknown"),
        driver: (p?.driver || p?.DriverName || null),
        port: (p?.port || p?.PortName || null),
        location: (p?.location || p?.Location || null),
        is_network: !!(p?.is_network || p?.ip || p?.host),
        is_virtual: !!(p?.is_virtual),
        ip: (p?.ip || null),
        hostname: (p?.hostname || null),
        connection_type: (p?.connection_type || (p?.is_network ? "network" : "local")),
      }));
    }
    return [];
  }


  async function fetchSupplies() {
    // Returns map: printer_name -> result object from /api/printers/supplies
    try {
      const r = await fetch("/api/printers/supplies", { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok !== true || !Array.isArray(j.results)) return {};
      const out = {};
      for (const it of j.results) {
        const n = (it && it.name) ? String(it.name) : "";
        if (!n) continue;
        out[n] = it;
      }
      return out;
    } catch {
      return {};
    }
  }

  function wrapRefresh() {
    if (typeof window.refreshPrinters !== "function") return;
    const original = window.refreshPrinters;
    if (original.__tli_hp_smart__) return;

    window.refreshPrinters = async function () {
      try { ensureToolbar(); renderLoading(); } catch {}
      let res;
      try { res = await original(); } catch (e) { console.warn(TAG, "original refresh error:", e); }
      try {
        STATE.printers = await fetchPrinters();
        STATE.suppliesByName = await fetchSupplies();
        render();} catch (e) {
        console.warn(TAG, "fetch/render error:", e);
        STATE.printers = [];
        updateRollup([]);
        renderEmpty("Printer service error", "Could not load printers from the backend.");
      }
      return res;
    };

    window.refreshPrinters.__tli_hp_smart__ = true;
  }

  function boot() { try { ensureToolbar(); } catch {} try { wrapRefresh(); } catch {} try { render(); } catch {} }
  document.addEventListener("DOMContentLoaded", boot);
  console.debug(TAG, "loaded");
})();

/* =========================================================
   TLI_PRINTERS_HTTP_FALLBACK_V1
   Fix "Method Not Allowed" (405) by retrying GET when POST is rejected.
   Additive only: wraps existing openAddPrinter/testPrint safely.
   ========================================================= */
(() => {
  const TAG = "TLI_PRINTERS_HTTP_FALLBACK_V1";

  async function tryPostThenGetJson(url) {
    // Try POST first (current UI), fallback to GET on 405.
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const j = ct.includes("application/json") ? await r.json().catch(() => null) : null;
    return { r, j };
  }

  function safeToast(msg, kind) {
    try {
      if (typeof toast === "function") return toast(msg, kind);
      if (typeof showToast === "function") return showToast(msg, kind);
    } catch {}
  }

  // ---- Wrap openAddPrinter ----
  if (typeof window.openAddPrinter === "function" && !window.openAddPrinter.__tli_http_fallback__) {
    const original = window.openAddPrinter;
    window.openAddPrinter = async function () {
      try {
        // Call original first (it also updates UI/alerts in your app.js)
        await original();
        return;
      } catch (e) {
        // If original threw, still attempt fallback logic.
      }

      try {
        const { r, j } = await tryPostThenGetJson("/api/printers/open_add");
        if (!r.ok) throw new Error((j && (j.detail || j.message)) || `HTTP ${r.status}`);
        safeToast("Opening system printer screen…");
      } catch (e) {
        safeToast("Could not open printer settings.", "warning");
        console.warn(TAG, "openAddPrinter failed:", e);
      }
    };
    window.openAddPrinter.__tli_http_fallback__ = true;
  }

  // ---- Wrap testPrint ----
  if (typeof window.testPrint === "function" && !window.testPrint.__tli_http_fallback__) {
    const original = window.testPrint;
    window.testPrint = async function () {
      try {
        await original();
        return;
      } catch (e) {
        // If original threw, still attempt fallback logic.
      }

      try {
        const { r, j } = await tryPostThenGetJson("/api/printers/test_print");
        if (!r.ok || !j || j.ok !== true) {
          throw new Error((j && (j.message || j.detail)) || `HTTP ${r.status}`);
        }
        safeToast("Test page sent.");
      } catch (e) {
        safeToast("Could not send test page.", "warning");
        console.warn(TAG, "testPrint failed:", e);
      }
    };
    window.testPrint.__tli_http_fallback__ = true;
  }
})();

/* =====================================================
   TLI_PRINTERS_DISABLE_UNUSED_ACTIONS_V1
   Why:
   - Discover/Fix are not part of Phase 1 and may 404/405.
   ===================================================== */
(() => {
  // Keep functions defined if other code calls them, but make them no-ops.
  if (typeof window.discoverPrinters === "function") {
    window.discoverPrinters = async () => {
      try { if (typeof showToast === "function") showToast("Discover is not enabled in Phase 1.", "warning"); } catch {}
    };
  }
  if (typeof window.fixPrinter === "function") {
    window.fixPrinter = async () => {
      try { if (typeof showToast === "function") showToast("Fix Printer is not enabled in Phase 1.", "warning"); } catch {}
    };
  }
})();

/* =====================================================
   TLI_SCAN_LAUNCH_V1
   Opens Windows Scan (stable, packaged-friendly).
   Uses POST then GET fallback to avoid 405s.
   ===================================================== */
(() => {
  async function postThenGet(url) {
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    return r;
  }

  function toastMsg(msg, kind) {
    try {
      if (typeof showToast === "function") return showToast(msg, kind);
      if (typeof toast === "function") return toast(msg, kind);
    } catch {}
  }

  window.openScan = async function () {
    try {
      const r = await postThenGet("/api/printers/open_scan");
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok !== true) throw new Error(j.message || j.error || `HTTP ${r.status}`);
      toastMsg("Opening Windows Scan…");
    } catch (e) {
      toastMsg("Could not open Windows Scan.", "warning");
      console.warn("openScan failed:", e);
    }
  };
})();

/* =====================================================
   TLI_PRINTER_ACTIONS_WIRING_V1
   Fixes:
   - "Error HTTP 200" false errors (non-JSON 200 responses)
   - Buttons not working (missing openScan or method mismatch)
   Strategy:
   - POST then GET fallback
   - Accept JSON OR empty/text responses as success when HTTP 2xx
   - Provide consistent toasts
   ===================================================== */
(() => {
  async function fetchPostThenGet(url) {
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    return r;
  }

  async function parseJsonSafe(r) {
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return null;
    return await r.json().catch(() => null);
  }

  function toastMsg(msg, kind) {
    try {
      if (typeof showToast === "function") return showToast(msg, kind);
      if (typeof toast === "function") return toast(msg, kind);
    } catch {}
  }

  // Scan -> backend route we just added
  window.openScan = async function () {
    try {
      const r = await fetchPostThenGet("/api/printers/open_scan");
      const j = await parseJsonSafe(r);

      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      // If JSON exists and ok==false, treat as error; otherwise treat 2xx as success
      if (j && j.ok === false) throw new Error(j.message || j.error || "Scan failed");

      toastMsg("Opening Windows Scan…");
    } catch (e) {
      toastMsg("Could not open Windows Scan.", "warning");
      console.warn("openScan failed:", e);
    }
  };

  // Test page -> backend route we just added
  const prevTestPrint = window.testPrint;
  window.testPrint = async function () {
    try {
      const r = await fetchPostThenGet("/api/printers/test_print");
      const j = await parseJsonSafe(r);

      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Test print failed");

      toastMsg("Test page sent.");
    } catch (e) {
      toastMsg("Could not send test page.", "warning");
      console.warn("testPrint failed:", e);
      // if an older impl exists, try it as a last resort
      try { if (typeof prevTestPrint === "function") return await prevTestPrint(); } catch {}
    }
  };

  // Manage -> your main.py has /api/printers/open_add (may be GET-only and may not return JSON)
  const prevOpenAdd = window.openAddPrinter;
  window.openAddPrinter = async function () {
    try {
      const r = await fetchPostThenGet("/api/printers/open_add");
      const j = await parseJsonSafe(r);

      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Could not open settings");

      toastMsg("Opening printer settings…");
    } catch (e) {
      toastMsg("Could not open printer settings.", "warning");
      console.warn("openAddPrinter failed:", e);
      try { if (typeof prevOpenAdd === "function") return await prevOpenAdd(); } catch {}
    }
  };
})();

/* =====================================================
   TLI_PRINTERS_FINAL_WIRING_V3
   Fixes (production-safe):
   - Removes false "Error HTTP 200" by accepting array payloads from /api/printers
   - Ensures Manage/Test/Scan always work (POST -> GET fallback)
   - Treats any 2xx as success even if response is not JSON (prevents "HTTP 200" false errors)
   - Single authoritative handlers (prevents duplicate toasts)
   ===================================================== */
(() => {
  const TAG = "TLI_PRINTERS_FINAL_WIRING_V3";

  function toastMsg(msg, kind) {
    try {
      if (typeof showToast === "function") return showToast(msg, kind);
      if (typeof toast === "function") return toast(msg, kind);
    } catch {}
  }

  function setStatus(ok, msg) {
    try {
      if (typeof pill === "function") pill("devices-printers-status", ok ? "OK" : "Error", ok ? "pill-ok" : "pill-warn");
      if (typeof setText === "function") setText("devices-printers-summary", msg || "");
    } catch {}
  }

  async function postThenGet(url) {
    let r = await fetch(url, { method: "POST" });
    if (r.status === 405) r = await fetch(url, { method: "GET" });
    return r;
  }

  async function jsonOrNull(r) {
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return null;
    return await r.json().catch(() => null);
  }

  function normalizePrintersPayload(j) {
    if (Array.isArray(j)) return { ok: true, printers: j };
    if (j && typeof j === "object" && Array.isArray(j.printers)) return { ok: j.ok !== false, printers: j.printers };
    if (j && typeof j === "object" && j.ok === false) return { ok: false, error: j.error || j.message || "Not supported yet" };
    return { ok: false, error: "Unexpected printer payload" };
  }

  // Authoritative refresh: fetch /api/printers and render cards with existing renderPrinters()
  window.refreshPrinters = async function () {
    try {
      try {
        if (typeof pill === "function") pill("devices-printers-status", "Scanning…", "pill-muted");
        if (typeof setText === "function") setText("devices-printers-summary", "");
      } catch {}

      const r = await fetch("/api/printers", { cache: "no-store" });
      const j = await jsonOrNull(r) ?? await r.json().catch(() => null); // try json; tolerate failures

      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const norm = normalizePrintersPayload(j);
      if (!norm.ok) {
        setStatus(false, norm.error || "Printer service error");
        return;
      }

      const printers = norm.printers || [];
      const msg = `Found ${printers.length} printer(s).`;
      setStatus(true, msg);

      if (typeof renderPrinters === "function") {
        renderPrinters(printers, { total: printers.length });
      }
    } catch (e) {
      setStatus(false, String(e));
      console.warn(TAG, "refreshPrinters failed:", e);
    }
  };

  // Manage: main.py provides POST /api/printers/open_add returning {ok:true}
  window.openAddPrinter = async function () {
    try {
      const r = await postThenGet("/api/printers/open_add");
      const j = await jsonOrNull(r);
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Could not open settings");
      toastMsg("Opening printer settings…");
    } catch (e) {
      toastMsg("Could not open printer settings.", "warning");
      console.warn(TAG, "openAddPrinter failed:", e);
    }
  };

  // Test Page: router provides GET|POST /api/printers/test_print returning {ok:true}
  window.testPrint = async function () {
    try {
      const r = await postThenGet("/api/printers/test_print");
      const j = await jsonOrNull(r);
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Test print failed");
      toastMsg("Test page sent.");
    } catch (e) {
      toastMsg("Could not send test page.", "warning");
      console.warn(TAG, "testPrint failed:", e);
    }
  };

  // Scan: router provides GET|POST /api/printers/open_scan returning {ok:true}
  window.openScan = async function () {
    try {
      const r = await postThenGet("/api/printers/open_scan");
      const j = await jsonOrNull(r);
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      if (j && j.ok === false) throw new Error(j.message || j.error || "Scan launch failed");
      toastMsg("Opening Windows Scan…");
    } catch (e) {
      toastMsg("Could not open Windows Scan.", "warning");
      console.warn(TAG, "openScan failed:", e);
    }
  };

  // Auto-refresh once when loaded — delayed to avoid competing with startup activity
  try { window.setTimeout(() => { try { window.refreshPrinters(); } catch {} }, 8000); } catch {}
})();


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
window.TLIHomeAutoActions = (function(){
  "use strict";

  const state = {
    devices: [],   // from /system/capabilities
    actions: [],   // from /actions/list
    receipts: [],  // from /actions/receipts
  };

  function _el(id){ return document.getElementById(id); }

  async function _fetchJson(url, opts){
    const r = await fetch(url, Object.assign({ cache:"no-store" }, opts || {}));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }

  function _safe(s){ return (s == null ? "" : String(s)); }

  function _renderDevicesMeta(){
    const meta = _el("uae-devices-meta");
    if (!meta) return;
    if (!state.devices || !state.devices.length) meta.textContent = "No devices loaded yet";
    else meta.textContent = state.devices.length + " device(s) ready";
  }

  function _renderDevicePicker(show){
    const box = _el("uae-device-picker");
    if (!box) return;

    if (!show){
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }

    box.style.display = "";
    if (!state.devices || !state.devices.length){
      box.innerHTML = `<div class="muted">No devices found. Add devices below (Shelly) then press “Load devices”.</div>`;
      return;
    }

    box.innerHTML = state.devices.map((d, i) => {
      const name = _safe(d.name) || _safe(d.ip) || ("Device " + (i+1));
      const ip = _safe(d.ip);
      const relay = (d.relay != null) ? d.relay : 0;

      return `
        <div class="uae-pick-row" data-device-index="${i}">
          <div class="uae-pick-left">
            <input type="checkbox" class="uae-pick-check" data-idx="${i}" />
            <div>
              <div class="uae-pick-name">${name}</div>
              <div class="uae-pick-meta">${ip ? ("IP " + ip + " · ") : ""}Relay ${relay}</div>
            </div>
          </div>
          <select class="uae-select uae-pick-action" data-idx="${i}">
            <option value="on">Turn ON</option>
            <option value="off">Turn OFF</option>
          </select>
        </div>
      `;
    }).join("");
  }

  function _renderActions(){
    const box = _el("uae-actions-list");
    if (!box) return;

    const actions = (state.actions && state.actions.length) ? state.actions : [];
    if (!actions.length){
      box.innerHTML = `<div class="muted">No actions yet. Build one on the left.</div>`;
      return;
    }

    box.innerHTML = actions.slice().reverse().map(a => {
      const id = _safe(a.id);
      const name = _safe(a.name || "(unnamed)");
      const steps = Array.isArray(a.steps) ? a.steps.length : 0;
      return `
        <div class="uae-item">
          <div class="uae-item-top">
            <div class="uae-item-name">${name}</div>
            <button class="uae-mini-btn" data-run-action="${id}">Run</button>
          </div>
          <div class="uae-item-sub">${steps} step(s) · deterministic</div>
        </div>
      `;
    }).join("");

    // wire run buttons
    box.querySelectorAll("[data-run-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const actionId = btn.getAttribute("data-run-action");
        if (!actionId) return;
        btn.disabled = true;
        try {
          await _fetchJson("/actions/run/" + encodeURIComponent(actionId), { method:"POST" });
          if (typeof showToast === "function") showToast("Action ran. See receipts.", "success");
          await refreshReceipts();
        } catch (e){
          if (typeof showToast === "function") showToast("Action failed: " + (e?.message || e), "error");
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function _renderReceipts(){
    const box = _el("uae-receipts-list");
    if (!box) return;

    const items = (state.receipts && state.receipts.length) ? state.receipts : [];
    if (!items.length){
      box.innerHTML = `<div class="muted">Nothing yet. Run an action to generate receipts.</div>`;
      return;
    }

    box.innerHTML = items.slice().reverse().map(r => {
      const ts = _safe(r.ts || "");
      const sum = _safe(r.summary || r.kind || "receipt");
      const kind = _safe(r.kind || "");
      return `
        <div class="uae-item">
          <div class="uae-item-top">
            <div class="uae-item-name">${sum}</div>
            <div class="muted" style="font-size:12px;">${kind}</div>
          </div>
          <div class="uae-item-sub">${ts}</div>
        </div>
      `;
    }).join("");
  }

  async function refreshActions(){
    try {
      const data = await _fetchJson("/actions/list");
      state.actions = Array.isArray(data?.actions) ? data.actions : [];
    } catch {
      state.actions = [];
    }
    _renderActions();
  }

  async function refreshReceipts(){
    try {
      const data = await _fetchJson("/actions/receipts?limit=50");
      state.receipts = Array.isArray(data?.items) ? data.items : [];
    } catch {
      state.receipts = [];
    }
    _renderReceipts();
  }

  async function loadDevices(){
    // Source of truth: backend says what it can do now.
    // Uses Shelly registry but is tolerant to naming.
    try {
      const caps = await _fetchJson("/system/capabilities");
      state.devices = Array.isArray(caps?.devices) ? caps.devices : [];
    } catch {
      state.devices = [];
    }
    _renderDevicesMeta();
  }

  function _collectStepsFromPicker(){
    const picker = _el("uae-device-picker");
    if (!picker) return [];

    const steps = [];
    picker.querySelectorAll(".uae-pick-row").forEach(row => {
      const idx = Number(row.getAttribute("data-device-index"));
      const chk = row.querySelector(".uae-pick-check");
      const sel = row.querySelector(".uae-pick-action");
      if (!chk || !sel) return;
      if (!chk.checked) return;

      const d = state.devices[idx];
      if (!d) return;

      // We send the device "name" (or IP) — backend resolves against registry robustly.
      const devQuery = (d.name || d.ip || "").toString();
      const val = (sel.value || "on").toString();

      steps.push({ type: "shelly.switch", device: devQuery, value: val });
    });

    return steps;
  }

  async function saveAction(){
    const nameEl = _el("uae-action-name");
    const actionName = (nameEl?.value || "").trim() || "Game Mode";

    const steps = _collectStepsFromPicker();
    if (!steps.length){
      if (typeof showToast === "function") showToast("Pick at least one device for Game Mode.", "warn");
      return;
    }

    const payload = { name: actionName, steps };

    try {
      await _fetchJson("/actions/approve", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload),
      });
      if (typeof showToast === "function") showToast("Saved: " + actionName, "success");
      await refreshActions();
      await refreshReceipts();
    } catch (e){
      if (typeof showToast === "function") showToast("Save failed: " + (e?.message || e), "error");
    }
  }

  function buildGameMode(){
    // UX: load devices + open picker for selection
    loadDevices().then(() => {
      _renderDevicePicker(true);
    });
  }

  function setup(){
    const loadBtn = _el("uae-load-devices");
    if (loadBtn) loadBtn.addEventListener("click", async () => {
      loadBtn.disabled = true;
      try {
        await loadDevices();
        _renderDevicePicker(true);
      } finally {
        loadBtn.disabled = false;
      }
    });

    const buildBtn = _el("uae-build-game");
    if (buildBtn) buildBtn.addEventListener("click", buildGameMode);

    const saveBtn = _el("uae-save-action");
    if (saveBtn) saveBtn.addEventListener("click", saveAction);

    // default name
    const nameEl = _el("uae-action-name");
    if (nameEl && !nameEl.value) nameEl.value = "Game Mode";
  }

  async function onOpen(){
    // Keep it fast: render existing immediately, then refresh.
    _renderDevicesMeta();
    _renderActions();
    _renderReceipts();
    await refreshActions();
    await refreshReceipts();
  }

  return { setup, onOpen, loadDevices, refreshActions, refreshReceipts };
})();



/* =========================================================
   UPLIFT: Dock Smart Automations (Unified Action Engine) into
   a professional right-side slot inside Home Automation.
   - No regression: moves existing #uae-homeauto only.
   ========================================================= */
(function(){
  function dockUAE(){
    const slot = document.getElementById("homeauto-smart-slot");
    const panel = document.getElementById("uae-homeauto");
    if (!slot || !panel) return;

    // Already docked
    if (slot.contains(panel)) return;

    // Make it look like a native TLI card
    panel.classList.add("card");
    panel.style.margin = "0";
    panel.style.position = "sticky";
    panel.style.top = "12px";
    panel.style.zIndex = "1";

    slot.appendChild(panel);
  }

  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(dockUAE, 80);
    setTimeout(dockUAE, 350);
    setTimeout(dockUAE, 900);
  });
  window.addEventListener("hashchange", () => setTimeout(dockUAE, 120));
})();


/* =============================================================
   PWA Install Prompt
   - Android Chrome: deferred beforeinstallprompt → banner with Install button
   - iOS Safari:     banner with "Add to Home Screen" instructions
   - Dismissal stored in localStorage; never shown again once dismissed
   ============================================================= */
(function(){
  const LS_KEY = "tli_pwa_install_dismissed_v1";
  let _deferred = null;

  function _dismissed() { try { return !!localStorage.getItem(LS_KEY); } catch { return false; } }
  function _dismiss()   { try { localStorage.setItem(LS_KEY, "1"); } catch {} }

  function _showBanner(iosMode) {
    if (_dismissed()) return;
    const banner = document.getElementById("pwa-install-banner");
    if (!banner) return;
    if (iosMode) {
      const msg = banner.querySelector(".pwa-install-msg");
      const btn = document.getElementById("pwa-install-btn");
      if (msg) msg.textContent = 'Tap Share then "Add to Home Screen" to install TLI.';
      if (btn) btn.textContent = "Got it";
    }
    banner.hidden = false;
  }

  // TLI is a LAN tool — only show install banner on genuine mobile browsers.
  // Three independent signals must ALL agree it's mobile:
  //   1. Mobile user agent string
  //   2. Narrow viewport (phone/tablet width)
  //   3. Not a LAN/local hostname (fox.local, 192.168.x.x, localhost — all excluded)
  const _isMobileUA  = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  const _isNarrow    = window.innerWidth <= 900;
  const _host        = (window.location.hostname || "").toLowerCase();
  const _isLanHost   = _host === "localhost" || _host.endsWith(".local")
                       || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(_host)
                       || /^\d+\.\d+\.\d+\.\d+$/.test(_host);
  const _isMobile    = _isMobileUA && _isNarrow && !_isLanHost;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _deferred = e;
    if (_isMobile) _showBanner(false);
  });

  document.addEventListener("DOMContentLoaded", () => {
    const installBtn  = document.getElementById("pwa-install-btn");
    const dismissBtn  = document.getElementById("pwa-install-dismiss");

    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (_deferred) {
          _deferred.prompt();
          await _deferred.userChoice.catch(() => {});
          _deferred = null;
        }
        _dismiss();
        const banner = document.getElementById("pwa-install-banner");
        if (banner) banner.hidden = true;
      });
    }

    if (dismissBtn) {
      dismissBtn.addEventListener("click", () => {
        _dismiss();
        const banner = document.getElementById("pwa-install-banner");
        if (banner) banner.hidden = true;
      });
    }

    // iOS Safari — only on actual mobile, not LAN desktop
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
    if (isIOS && !isStandalone && _isMobile) {
      _showBanner(true);
    }
  });
})();


// [module] See /js/pin-lock.js

// [module] See /js/cmd-palette.js

// [module] See /js/fetch-interceptor.js
