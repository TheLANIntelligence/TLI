// =====================================================
// System Summary (TLI System Passport) — v1 (read-only)
// - Offline-first (no internet needed)
// - Fetches summary from backend
// - Provides Copy Summary + Copy JSON
// - Cached; refreshes when panel opens (throttled)
// =====================================================


// =====================================================
// Games (Offline Game Optimizer) — v1 (copy-only)
// - Detect running game (foreground window + process)
// - Pull hardware from /system/summary
// - Generate preset recommendations via /games/recommend
// =====================================================
window.TLIGames = (function () {
  const STORAGE_KEY = "tli_games_allowlist";

  const state = {
    lastDetect: null,
    lastSummary: null,
    lastRecsText: "",
    selectedPreset: null,
    autoTimer: null,
    lastFpPid: null,
    lastFpTitle: null,
    autoIntervalMs: 2500,
    allowList: [],
  };

  function _el(id){ return document.getElementById(id); }

  function _loadAllowList(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      state.allowList = Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch {
      state.allowList = [];
    }
  }

  function _saveAllowList(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.allowList.slice(0, 50))); } catch {}
  }

  function _allowParam(){
    const items = (state.allowList || []).slice(0, 20);
    if (!items.length) return "";
    return "?allow=" + encodeURIComponent(items.join("|"));
  }

  async function _fetchJson(url, opts){
    const r = await fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }

  function _setText(id, txt){
    const el = _el(id);
    if (el) el.textContent = (txt == null ? "—" : String(txt));
  }

  function _renderHW(summary){
    const box = _el("games-hw");
    if (!box) return;
    if (!summary){
      box.innerHTML = '<div class="games-hw-empty">Hardware info unavailable. Try clicking Refresh.</div>';
      return;
    }
    const cpu = summary.cpu || {};
    const gpu = summary.gpu || {};
    const mem = summary.memory || {};
    const disp = summary.display || {};
    const tiles = [
      { k:"CPU", v: (cpu.model || cpu.name || "Unknown") + (cpu.cores ? ` · ${cpu.cores}C/${cpu.threads||"?"}T` : "") },
      { k:"GPU", v: (gpu.model || gpu.name || "Unknown") + (gpu.vram_gb ? ` · ${gpu.vram_gb} GB VRAM` : "") },
      { k:"RAM", v: (mem.total_gb ? `${mem.total_gb} GB` : "Unknown") },
      { k:"Display", v: (disp.width && disp.height ? `${disp.width}×${disp.height}` : "Unknown") + (disp.hz ? ` · ${disp.hz} Hz` : "") },
    ];
    box.innerHTML = tiles.map(t => `
      <div class="games-hw-tile">
        <div class="games-hw-k">${t.k}</div>
        <div class="games-hw-v">${t.v}</div>
      </div>
    `).join("");
  }

  function _renderDetect(det){
    const game = det?.game || null;

    const titleEl = document.getElementById("games-detect-title");
    const metaEl  = document.getElementById("games-detect-meta");
    const pathEl  = document.getElementById("games-detect-path");

    if (!game){
      if (titleEl) titleEl.textContent = "No game detected";
      if (metaEl)  metaEl.textContent  = "No running game detected";
      if (pathEl)  pathEl.textContent  = "—";
      return;
    }

    const title = game?.name || game?.exe_name || "Detected game";
    if (titleEl) titleEl.textContent = title;
    const store = (game?.store || det?.store || det?.mode || "process_scan").toUpperCase();
    const exePath = game?.exe_path || "—";

    // Metrics (best-effort)
    const metrics = det?.metrics || game?.metrics || null;

    const parts = [];
    parts.push(`<span class="games-pill games-pill-muted">🧩 ${store}</span>`);
    const pid = game?.pid ?? det?.foreground?.pid ?? null;
    if (pid != null) parts.push(`<span class="games-pill games-pill-muted">🆔 PID ${pid}</span>`);
    parts.push(`<span class="games-pill games-pill-running">🟢 RUNNING</span>`);

    if (metrics){
      const cpu = (metrics.cpu_percent != null) ? `${Math.round(metrics.cpu_percent)}%` : "—";
      const ram = (metrics.ram_mb != null) ? `${Math.round(metrics.ram_mb)}MB` : "—";
      const gpu = (metrics.gpu_util_percent != null) ? `${Math.round(metrics.gpu_util_percent)}%` : "—";
      const vram = (metrics.gpu_mem_used_mb_pid != null) ? metrics.gpu_mem_used_mb_pid : metrics.gpu_mem_used_mb;
      const vramTxt = (vram != null) ? `${Math.round(vram)}MB` : "—";
      parts.push(`<span class="games-pill games-pill-muted">CPU ${cpu}</span>`);
      parts.push(`<span class="games-pill games-pill-muted">RAM ${ram}</span>`);
      parts.push(`<span class="games-pill games-pill-muted">GPU ${gpu}</span>`);
      parts.push(`<span class="games-pill games-pill-muted">VRAM ${vramTxt}</span>`);
    }

    if (metaEl) metaEl.innerHTML = parts.join("");

    if (pathEl) pathEl.textContent = exePath;
  }

    

function _renderRecs(text){
    const pre = _el("games-output-pre");
    if (pre) pre.textContent = text || "Pick a preset to generate recommendations.";
  }

  function stopAuto(){
    if (state.autoTimer){
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
  }

  function startAuto(){
    stopAuto();
    // Auto-detect runs continuously; hide manual Refresh to reduce confusion.
    try { const b = _el("games-refresh-btn"); if (b) b.style.display = "none"; } catch {}
state.autoTimer = setInterval(async () => {
      try {
        const det = await _fetchJson("/games/detect_best" + _allowParam());
        state.lastDetect = det;
        _renderDetect(det);

        const fp = det?.foreground || {};
        const changed = (fp.pid && fp.pid !== state.lastFpPid) || (fp.title && fp.title !== state.lastFpTitle);
        state.lastFpPid = fp.pid || null;
        state.lastFpTitle = fp.title || null;

        if (changed) {
          try {
            const summary = await _fetchJson("/system/summary");
            state.lastSummary = summary;
            _renderHW(summary);
          } catch {}
        }
      } catch {
        // keep UI stable
      }
    }, state.autoIntervalMs);
  }

  async function refreshAll(){
    _loadAllowList();

    try {
      const summary = await _fetchJson("/system/summary");
      state.lastSummary = summary;
      _renderHW(summary);
    } catch (e) {
      console.warn("Games: system summary failed:", e);
      _renderHW(null);
    }

    try {
      const det = await _fetchJson("/games/detect_best" + _allowParam());
      state.lastDetect = det;
      _renderDetect(det);
    } catch (e) {
      console.warn("Games: detect failed:", e);
      _renderDetect(null);
    }
  }

  async function generatePreset(preset){
    state.selectedPreset = preset;
    _renderRecs("Generating recommendations…");

    const payload = {
      preset,
      detected: state.lastDetect || null,
      system: state.lastSummary || null,
      allow: state.allowList || [],
    };

    try {
      const rec = await _fetchJson("/games/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const txt = rec?.text || JSON.stringify(rec, null, 2);
      state.lastRecsText = txt;
      _renderRecs(txt);
    } catch (e) {
      console.warn("Games: recommend failed:", e);
      _renderRecs("Failed to generate recommendations. Check backend logs.");
    }
  }

  async function copyRecs(){
    const t = state.lastRecsText || "";
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      if (typeof showToast === "function") showToast("Copied recommendations.");
    } catch (e) {
      console.warn("clipboard write failed", e);
    }
  }

  function clearRecs(){
    state.lastRecsText = "";
    _renderRecs("");
  }

  function manualAddExe(){
    _loadAllowList();
    const p = prompt("Add a game EXE path (full path). Example:\nC:\\Program Files (x86)\\Steam\\steamapps\\common\\Game\\Game.exe");
    if (!p) return;
    const v = String(p).trim();
    if (!v.toLowerCase().endsWith(".exe")) {
      if (typeof showToast === "function") showToast("That doesn't look like an .exe path.", "warn");
      return;
    }
    if (!state.allowList.includes(v)) state.allowList.push(v);
    _saveAllowList();
    if (typeof showToast === "function") showToast("Added to Games allowlist.");
    refreshAll();
  }

  function setup(){
    _loadAllowList();

    try {
      const panel = document.getElementById("panel-games");
      if (panel && !panel.__gamesPanelObserver) {
        const obs = new MutationObserver(() => {
          const active = panel.classList.contains("active") && panel.hidden !== true;
          if (!active) stopAuto();
        });
        obs.observe(panel, { attributes: true, attributeFilter: ["class", "hidden"] });
        panel.__gamesPanelObserver = obs;
      }
    } catch {}

    const refreshBtn = _el("games-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshAll);

    const manualBtn = _el("games-use-manual-btn");
    if (manualBtn) manualBtn.addEventListener("click", manualAddExe);

    const copyBtn = _el("games-copy-recs");
    if (copyBtn) copyBtn.addEventListener("click", copyRecs);

    const clearBtn = _el("games-clear-recs");
    if (clearBtn) clearBtn.addEventListener("click", clearRecs);

    document.querySelectorAll(".games-preset[data-preset]").forEach(btn => {
      btn.addEventListener("click", () => {
        // UI: mark active preset
        document.querySelectorAll(".games-preset.active").forEach(x => x.classList.remove("active"));
        btn.classList.add("active");
        generatePreset(btn.dataset.preset);
      });
    });
  }

  async function onOpen(){
    await refreshAll();
    startAuto();
  }

  return { setup, onOpen, refreshAll, generatePreset, stopAuto, startAuto };
})();
