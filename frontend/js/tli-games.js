// =====================================================
// TLI Game Optimizer — v2
// AI-powered, hardware-aware, streaming recommendations
// =====================================================
window.TLIGames = (function () {

  const state = {
    lastDetect:  null,
    lastSummary: null,
    lastConfig:  null,
    lastText:    "",
    activePreset: null,
    streaming:   false,
    autoTimer:   null,
    controller: null,
    epoch: 0,
    configEpoch: 0,
    locked: false,
  };

  // ── DOM helpers ────────────────────────────────────
  const _el = id => document.getElementById(id);

  // ── Hardware pills ─────────────────────────────────
  function _renderHWPills(summary) {
    const box = _el("go-hw-pills");
    if (!box) return;
    if (!summary) {
      box.innerHTML = '<span class="go-hw-loading">Unable to read hardware.</span>';
      return;
    }
    const cpu  = summary.cpu    || {};
    const gpu  = summary.gpu    || {};
    const mem  = summary.memory || {};
    const disp = summary.display || {};

    const pills = [
      gpu.model || gpu.name   ? (gpu.model || gpu.name)  : null,
      cpu.model || cpu.name   ? (cpu.model || cpu.name).replace(/\(R\)|\(TM\)/gi, "").trim() : null,
      mem.total_gb            ? `${mem.total_gb} GB RAM`  : null,
      disp.width && disp.height
        ? `${disp.width}×${disp.height}${disp.hz ? ` · ${disp.hz}Hz` : ""}`
        : null,
    ].filter(Boolean);

    box.innerHTML = pills.length
      ? pills.map(p => `<span class="go-hw-pill">${_esc(p)}</span>`).join("")
      : '<span class="go-hw-loading">Hardware info unavailable.</span>';
  }

  // ── Detect status ──────────────────────────────────
  function _renderDetectStatus(det) {
    const inp = _el("go-game-input");
    const status = _el("go-detect-status");
    const game = det?.game || null;

    if (!game) {
      if (status) status.textContent = "No running game detected — type a game name above.";
      return;
    }

    const name = game.name || game.exe_name || "Unknown";
    const store = (game.store || det?.mode || "").toUpperCase();

    // Only pre-fill input if user hasn't typed something
    if (inp && !inp.dataset.userEdited) {
      inp.value = name;
    }

    if (status) {
      const metrics = det?.metrics || null;
      let txt = `Auto-detected · ${store || "Running"}`;
      if (metrics?.cpu_percent != null) txt += ` · CPU ${Math.round(metrics.cpu_percent)}%`;
      if (metrics?.gpu_util_percent != null) txt += ` · GPU ${Math.round(metrics.gpu_util_percent)}%`;
      status.textContent = txt;
    }
  }

  // ── Output rendering ───────────────────────────────
  function _renderOutput(text, append) {
    const box = _el("go-output");
    const wrap = _el("go-output-wrap");
    if (!box) return;

    if (!append) {
      state.lastText = "";
      box.innerHTML = "";
    }

    if (text === null || text === undefined) return;
    state.lastText += text;

    if (wrap) wrap.style.display = "";

    // Render incrementally — parse numbered list into styled items
    box.innerHTML = _parseOutput(state.lastText);

    // Scroll to bottom while streaming
    box.scrollTop = box.scrollHeight;
  }

  function _parseOutput(raw) {
    if (!raw.trim()) return "";

    const lines = raw.split("\n");
    let html = "";
    let inList = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (inList) { html += "</div>"; inList = false; }
        continue;
      }

      // Numbered list item: "1. Something"
      const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
      if (numMatch) {
        if (!inList) { html += '<div class="go-recs-list">'; inList = true; }
        const num = numMatch[1];
        const body = _esc(numMatch[2]);
        // Split on " — " or " - " to bold the first part
        const dashIdx = body.indexOf(" — ");
        const dashIdx2 = body.indexOf(" - ");
        const splitAt = dashIdx >= 0 ? dashIdx : dashIdx2 >= 0 ? dashIdx2 : -1;
        let content;
        if (splitAt >= 0) {
          const head = body.slice(0, splitAt);
          const tail = body.slice(splitAt + 3);
          content = `<strong>${head}</strong> — ${tail}`;
        } else {
          content = body;
        }
        html += `<div class="go-rec-item"><span class="go-rec-num">${num}</span><span class="go-rec-body">${content}</span></div>`;
        continue;
      }

      // Bracket header like "[AI offline — ...]"
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        if (inList) { html += "</div>"; inList = false; }
        html += `<div class="go-rec-note">${_esc(trimmed)}</div>`;
        continue;
      }

      // Regular line
      if (inList) { html += "</div>"; inList = false; }
      html += `<div class="go-rec-line">${_esc(trimmed)}</div>`;
    }

    if (inList) html += "</div>";
    return html;
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Preset selection ───────────────────────────────
  function _selectPreset(preset) {
    state.activePreset = preset;
    document.querySelectorAll(".go-preset").forEach(b => {
      b.classList.toggle("active", b.dataset.preset === preset);
    });
    // Choosing a goal preserves the written question and never starts AI.
  }

  // ── Main ask ───────────────────────────────────────
  async function _ask() {
    if (state.streaming || state.locked) return;

    const gameName = (_el("go-game-input")?.value || "").trim() || "an unspecified game";
    const question = (_el("go-question")?.value || "").trim();
    const preset   = state.activePreset || "stable_60";

    if (!question && !state.activePreset) {
      if (typeof showToast === "function") showToast("Pick an optimization goal or ask a question.", "warn");
      return;
    }

    const previous = state.lastText;
    const previousTitle = _el('go-output-title')?.textContent || 'Previous advice';
    const epoch = ++state.epoch;
    state.controller = new AbortController();
    const previousBox = _el('go-previous-output'), previousWrap = _el('go-previous-advice');
    if (previousBox && previousWrap && previous) {
      previousBox.textContent = previousTitle + '\n\n' + previous;
      previousWrap.hidden = false;
    }
    // Header
    const title = _el("go-output-title");
    if (title) {
      title.textContent = question
        ? `Advice for "${gameName}"`
        : `${_presetLabel(preset)} — ${gameName}`;
    }
    const src = _el("go-output-source");
    if (src) src.textContent = "";

    const wrap = _el("go-output-wrap");
    if (wrap) wrap.style.display = "";

    const box = _el("go-output");
    if (!previous && box) box.textContent = '';
    const status = _el('go-request-status');
    if (status) status.textContent = 'Preparing advice…' + (previous ? ' Previous advice remains below until text arrives.' : '');
    const stop = _el('go-stop-btn'); if (stop) { stop.hidden = false; stop.disabled = false; }

    const askBtn = _el("go-ask-btn");
    if (askBtn) { askBtn.disabled = true; askBtn.textContent = "Thinking…"; }
    const clearBtn = _el('go-clear-btn'); if (clearBtn) clearBtn.disabled = true;

    state.streaming = true;
    let received = '', completed = false, incomplete = false, source = 'ai-advice';

    try {
      const resp = await fetch("/games/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_name: gameName,
          question,
          preset,
          system:           state.lastSummary || {},
          current_settings: state.lastConfig?.requestedName === gameName ? state.lastConfig.settings || [] : [],
          config_game_name: state.lastConfig?.requestedName === gameName ? gameName : null,
        }),
        cache: "no-store",
        signal: state.controller.signal,
      });

      if (resp.status === 401) window.dispatchEvent(new CustomEvent("tli-session-locked"));
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (epoch !== state.epoch) { await reader.cancel(); return; }
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload.trim() === "[DONE]") { completed = true; break; }
          try {
            const { t, meta, error } = JSON.parse(payload);
            if (meta?.source) source = meta.source;
            if (error || meta?.incomplete) incomplete = true;
            if (typeof t === 'string' && t) {
              received += t; _renderOutput(received, false);
              if (status) status.textContent = 'Receiving advice…';
            }
          } catch {}
        }
        if (completed) { await reader.cancel(); break; }
      }
      if (!completed || incomplete || !received.trim()) throw new Error('The response ended before complete advice was received.');
      if (src) src.textContent = source === "static-guidance" ? "General guidance · AI reply unavailable" : "AI advice · not a measured performance result";
      if (status) status.textContent = source === 'static-guidance' ? 'General guidance shown because an AI reply was unavailable. It is not tailored performance analysis; no settings changed.' : 'Advice received. No game or computer settings were changed.';

    } catch (err) {
      if (epoch !== state.epoch) return;
      const stopped = state.controller?.signal.aborted;
      if (!received) { state.lastText = previous; if (previous && title) title.textContent = previousTitle; }
      if (status) status.textContent = (stopped ? 'Stopped receiving advice. This does not confirm that the server stopped its work.' : 'Advice could not complete. Check the AI provider and connection, then retry.') + (received ? ' The partial reply remains below and may be incomplete.' : previous ? ' Your previous advice is unchanged.' : ' No advice was received.');
      if (src) src.textContent = received ? 'Incomplete reply' : previous ? 'Previous advice' : 'AI unavailable';
    } finally {
      if (epoch !== state.epoch) return;
      state.streaming = false;
      state.controller = null;
      if (stop) stop.hidden = true;
      if (clearBtn) clearBtn.disabled = false;
      if (askBtn) { askBtn.disabled = false; askBtn.textContent = "Get Advice →"; }
    }
  }

  function _presetLabel(preset) {
    return { stable_60: "Stable 60 FPS", high_fps: "High FPS", max_visual: "Max Visuals" }[preset] || preset;
  }

  // ── Config read & render ───────────────────────────
  async function _loadGameConfig(gameName) {
    if (!gameName || state.locked) return;
    const ticket = ++state.configEpoch, epoch = state.epoch;
    const badge = _el('go-config-badge'), status = _el('go-detect-status');
    if (status) status.textContent = 'Reading settings for ' + gameName + '…';
    try {
      const result = await _fetchJson('/games/config_read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_name: gameName }) });
      if (state.locked || ticket !== state.configEpoch || epoch !== state.epoch || _el('go-game-input')?.value.trim() !== gameName) return;
      if (result.game_name !== gameName) throw new Error('The settings response belongs to a different game.');
      if (result.error) throw new Error(result.error);
      state.lastConfig = { ...result, requestedName: gameName };
      _renderConfigStatus(state.lastConfig); _renderConfigSettings(state.lastConfig);
      if (status) status.textContent = result.supported ? 'Settings read for ' + gameName + '. Nothing changed.' : 'No settings reader supports this exact game name.';
    } catch (e) {
      if (state.locked || ticket !== state.configEpoch || epoch !== state.epoch) return;
      if (status) status.textContent = 'Settings could not be read: ' + e.message + (state.lastConfig ? ' Previous settings remain labeled for ' + state.lastConfig.requestedName + '.' : '');
      if (badge && state.lastConfig) badge.textContent = 'Previous read · ' + state.lastConfig.requestedName;
    }
  }

  function _renderConfigStatus(result) {
    const badge = _el("go-config-badge");
    const block = _el("go-settings-block");
    if (!badge || !block) return;
    badge.className = "go-config-badge";

    if (!result || !result.supported) {
      block.style.display = "none";
      return;
    }

    block.style.display = "";

    if (result.error) {
      badge.classList.add("go-config-badge--unsupported");
      badge.textContent = "Config not found";
      return;
    }

    const count = result.settings?.length || 0;
    if (count > 0) {
      badge.classList.add("go-config-badge--supported");
      badge.textContent = `${count} settings read · ${result.requestedName || result.game_name}`;
    } else {
      badge.classList.add("go-config-badge--partial");
      badge.textContent = "Partial read";
    }
  }

  function _renderConfigSettings(result) {
    const grid = _el("go-settings-grid");
    if (!grid) return;

    if (!result) { grid.innerHTML = ""; return; }

    if (result.error) {
      grid.innerHTML = `<div class="go-settings-note">${_esc(result.error)}</div>`;
      return;
    }

    const settings = result.settings || [];
    if (!settings.length) { grid.innerHTML = ""; return; }

    grid.innerHTML = settings.map(s => {
      const valMod = s.category === "performance"
        ? " go-setting-chip__value--perf"
        : "";
      const tip = s.note ? ` title="${_esc(s.note)}"` : "";
      return `<div class="go-setting-chip"${tip}>` +
        `<span class="go-setting-chip__label">${_esc(s.label)}</span>` +
        `<span class="go-setting-chip__value${valMod}">${_esc(s.value)}</span>` +
        `</div>`;
    }).join("");
  }

  // ── Fetch data ─────────────────────────────────────
  async function _fetchJson(url, opts) {
    const r = await fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    if (r.status === 401) window.dispatchEvent(new CustomEvent("tli-session-locked"));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function _loadHardware() {
    const epoch = state.epoch;
    try {
      const s = await _fetchJson("/system/summary");
      if (state.locked || epoch !== state.epoch) return;
      state.lastSummary = s;
      _renderHWPills(s);
    } catch {
      if (!state.locked && epoch === state.epoch) { _renderHWPills(state.lastSummary); const status = _el("go-detect-status"); if (status) status.textContent = "Hardware refresh failed. Previous hardware, if shown, is historical."; }
    }
  }

  async function _detectGame() {
    const epoch = state.epoch;
    const btn = _el("go-detect-btn");
    if (btn) btn.textContent = "…";
    try {
      const det = await _fetchJson("/games/detect_best");
      if (state.locked || epoch !== state.epoch) return;
      state.lastDetect = det;
      _renderDetectStatus(det);
      const detectedName = det?.game?.name || det?.game?.exe_name || null;
      // Reading settings is a separate explicit operation.
    } catch {
      const s = _el("go-detect-status");
      if (s && !state.locked && epoch === state.epoch) s.textContent = "Detection failed. Your game name is unchanged.";
    } finally {
      if (btn) btn.textContent = "Detect";
    }
  }

  // ── Copy ───────────────────────────────────────────
  async function _copy() {
    if (!state.lastText) return;
    try {
      await navigator.clipboard.writeText(state.lastText);
      if (typeof showToast === "function") showToast("Copied to clipboard.");
    } catch {}
  }

  // ── Setup ──────────────────────────────────────────
  function setup() {
    if (setup._done) return;
    setup._done = true;
    const requestStatus = document.createElement('p'); requestStatus.id = 'go-request-status'; requestStatus.setAttribute('role', 'status');
    _el('go-output')?.before(requestStatus);
    const stop = document.createElement('button'); stop.id = 'go-stop-btn'; stop.type = 'button'; stop.className = 'btn-outline'; stop.textContent = 'Stop advice'; stop.hidden = true;
    _el('go-ask-btn')?.after(stop);
    stop.addEventListener('click', () => { if (state.streaming) { stop.disabled = true; requestStatus.textContent = 'Stopping…'; state.controller?.abort(); } });
    const previous = document.createElement('details'); previous.id = 'go-previous-advice'; previous.hidden = true;
    const summary = document.createElement('summary'); summary.textContent = 'Previous advice';
    const content = document.createElement('pre'); content.id = 'go-previous-output'; previous.append(summary, content); _el('go-output')?.after(previous);
    window.addEventListener('tli-session-locked', () => {
      state.locked = true; state.configEpoch++; state.lastSummary = null; state.lastConfig = null; state.lastDetect = null;
      _renderHWPills(null); _renderConfigSettings(null); const game = _el('go-game-input'); if (game) game.value = ''; const question = _el('go-question'); if (question) question.value = '';
      state.controller?.abort(); state.epoch++; state.streaming = false; state.controller = null; state.lastText = '';
      content.textContent = ''; previous.hidden = true; requestStatus.textContent = ''; stop.hidden = true;
      const box = _el('go-output'); if (box) box.textContent = '';
      const ask = _el('go-ask-btn'); if (ask) { ask.disabled = false; ask.textContent = 'Get Advice →'; }
      const clear = _el('go-clear-btn'); if (clear) clear.disabled = false;
    });
    window.addEventListener('tli-session-unlocked', () => { state.locked = false; });
    window.TLIPerformance?.setup?.();
    _el('go-read-config-btn')?.addEventListener('click', () => _loadGameConfig(_el('go-game-input')?.value.trim()));
    _el('go-read-hardware-btn')?.addEventListener('click', _loadHardware);
    // Game input: mark as user-edited if they type; load config on commit
    const inp = _el("go-game-input");
    if (inp) {
      inp.addEventListener("input", () => { inp.dataset.userEdited = "1"; state.configEpoch++; const badge = _el("go-config-badge"); if (badge && state.lastConfig) badge.textContent = "Previous read · " + state.lastConfig.requestedName; });
    }

    // Detect button
    const detectBtn = _el("go-detect-btn");
    if (detectBtn) detectBtn.addEventListener("click", _detectGame);

    // Preset buttons
    document.querySelectorAll(".go-preset[data-preset]").forEach(btn => {
      btn.addEventListener("click", () => {
        _selectPreset(btn.dataset.preset);
      });
    });

    // Ask button
    const askBtn = _el("go-ask-btn");
    if (askBtn) askBtn.addEventListener("click", _ask);

    // Question textarea — Enter (without Shift) triggers ask
    const q = _el("go-question");
    if (q) {
      q.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _ask(); }
      });
      // Typing in question clears preset highlight
      q.addEventListener("input", () => {
        if (q.value.trim()) {
          document.querySelectorAll(".go-preset.active").forEach(b => b.classList.remove("active"));
          state.activePreset = null;
        }
      });
    }

    // Copy / Clear
    const copyBtn = _el("go-copy-btn");
    if (copyBtn) copyBtn.addEventListener("click", _copy);

    const clearBtn = _el("go-clear-btn");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (state.streaming) return;
      state.lastText = "";
      content.textContent = ''; previous.hidden = true; requestStatus.textContent = '';
      const box = _el("go-output");
      if (box) box.innerHTML = "";
      const wrap = _el("go-output-wrap");
      if (wrap) wrap.style.display = "none";
      document.querySelectorAll(".go-preset.active").forEach(b => b.classList.remove("active"));
      state.activePreset = null;
    });
  }

  async function onOpen() {
    await window.TLIPerformance?.onOpen?.();
  }

  return { setup, onOpen };
})();
