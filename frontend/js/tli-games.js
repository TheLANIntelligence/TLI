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
    activePreset: "stable_60",
    providerBinding: null,
    providerEpoch: 0,
    history: [],
    readBusy: false,
    contextGame: "",
    hardwareStale: false,
    hardwareStatus: 'idle',
    hardwareEpoch: 0,
    hardwarePromise: null,
    hardwareController: null,
    hardwareReady: true,
    open: false,
    manualValues: {},
    customValues: [],
    streaming:   false,
    autoTimer:   null,
    controller: null,
    epoch: 0,
    configEpoch: 0,
    detectEpoch: 0,
    locked: false,
  };

  // ── DOM helpers ────────────────────────────────────
  const _el = id => document.getElementById(id);

  // ── Hardware pills ─────────────────────────────────
  function _renderHWPills(summary) {
    const box = _el("go-hw-pills");
    if (!box) return;
    const status = _el('go-hardware-status');
    if (status) status.textContent = state.locked ? 'Unlock TLI to read this PC’s specs.'
      : !state.hardwareReady ? 'Check access with Refresh specs before reading this PC.'
      : state.hardwareStatus === 'loading' ? 'Reading this PC’s specs. Windows hardware detection can take a few moments…'
      : state.hardwareStatus === 'error' ? (summary ? 'Refresh failed. These are historical specs from the previous read; they will not be sent with new advice.' : 'Could not read this PC’s specs. Choose Refresh specs to try again, or enter corrections below.')
      : summary ? 'Detected on the TLI host. Not reported means Windows or the operating system did not provide that detail.'
      : 'PC specs will appear here when Game Optimizer opens.';
    box.setAttribute('aria-busy', String(state.hardwareStatus === 'loading'));
    const refresh = _el('go-read-hardware-btn');
    if (refresh) { refresh.disabled = state.locked || state.streaming || state.readBusy || state.hardwareStatus === 'loading'; refresh.textContent = state.hardwareStatus === 'loading' ? 'Reading specs…' : 'Refresh specs'; }
    summary = summary || {};
    const cpu  = summary.cpu    || {};
    const gpu  = summary.gpu    || {};
    const mem  = summary.memory || {};
    const disp = summary.display || {};

    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const cpuName = cpu.model || cpu.name;
    const fields = [
      ['Processor', cpuName ? cpuName.replace(/\(R\)|\(TM\)/gi, '').trim() : null],
      ['Graphics card', gpu.model || gpu.name],
      ['Graphics memory', positive(gpu.vram_gb) ? `${gpu.vram_gb} GB VRAM` : null],
      ['Memory', positive(mem.total_gb) ? `${mem.total_gb} GB RAM` : null],
      ['Display resolution', positive(disp.width) && positive(disp.height) ? `${disp.width} × ${disp.height}` : null],
      ['Refresh rate', positive(disp.hz) && disp.hz <= 1000 ? `${disp.hz} Hz` : null],
    ];
    box.innerHTML = fields.map(([label, value]) => `<div class="go-hw-spec"><dt>${label}</dt><dd>${_esc(value || (state.hardwareStatus === 'loading' ? 'Reading…' : 'Not reported'))}</dd></div>`).join('');
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
      _changeGame(name);
    }

    if (status) {
      const metrics = det?.metrics || null;
      let txt = `Detected: ${name} · ${store || "Running"}`;
      if (metrics?.cpu_percent != null) txt += ` · CPU ${Math.round(metrics.cpu_percent)}%`;
      if (metrics?.gpu_util_percent != null) txt += ` · GPU ${Math.round(metrics.gpu_util_percent)}%`;
      status.replaceChildren(); status.textContent = txt;
      if (inp && !_sameGame(inp.value, name)) {
        const epoch = state.epoch, configEpoch = state.configEpoch, detectEpoch = state.detectEpoch, originalInput = inp.value;
        const use = document.createElement('button'); use.id = 'go-use-detected-game'; use.type = 'button'; use.className = 'btn-outline'; use.textContent = 'Use this game';
        use.addEventListener('click', () => {
          if (state.locked || !state.hardwareReady || state.streaming || state.readBusy || epoch !== state.epoch ||
              configEpoch !== state.configEpoch || detectEpoch !== state.detectEpoch || state.lastDetect !== det || inp.value !== originalInput) return;
          inp.value = name; inp.dataset.userEdited = '1'; _changeGame(name);
          use.remove(); status.textContent = `Selected ${name}. Choose settings to compare, or explicitly read its saved settings.`;
        });
        status.append(use);
      }
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
        const body = _inline(numMatch[2]);
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
      html += `<div class="go-rec-line">${_inline(trimmed)}</div>`;
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
  function _inline(text) {
    return _esc(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }

  function _selectPreset(preset) {
    state.activePreset = preset;
    document.querySelectorAll(".go-preset").forEach(b => {
      b.classList.toggle("active", b.dataset.preset === preset);
      b.setAttribute("aria-pressed", String(b.dataset.preset === preset));
    });
    // Choosing a goal preserves the written question and never starts AI.
  }

  // ── Main ask ───────────────────────────────────────
  async function _ask() {
    if (state.streaming || state.readBusy || state.locked) return;
    if (state.hardwareStatus === 'loading') { const status = _el('go-hardware-status'); if (status) status.textContent = 'Please wait for this PC’s specs to finish loading before asking for advice.'; return; }

    const gameName = (_el("go-game-input")?.value || "").trim();
    if (!gameName) { const status = _el('go-detect-status'); if (status) status.textContent = 'Enter a game name first.'; _el('go-game-input')?.focus(); return; }
    const question = (_el("go-question")?.value || "").trim();
    const preset   = state.activePreset || "stable_60";

    if (!question && !state.activePreset) {
      if (typeof showToast === "function") showToast("Pick an optimization goal or ask a question.", "warn");
      return;
    }

    let corrections;
    try { corrections = _corrections(); }
    catch (error) { const status = _el('go-detect-status'); if (status) status.textContent = error.message; return; }
    const provider = _el('go-provider')?.value || 'bundled';
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
    _setReadControls(true);
    let received = '', completed = false, incomplete = false, source = 'ai-advice', failureMessage = '', providerLabel = '', planKeys = [];

    try {
      const binding = _el('go-provider') ? await _checkProvider(false, state.controller.signal) : null;
      if (epoch !== state.epoch) return;
      const includeHistory = _el('go-include-history')?.checked !== false;
      const history = includeHistory ? state.history.filter(item => _sameGame(item.game_name, gameName)).slice(-1) : [];
      const settings = state.lastConfig && !state.lastConfig.stale && _sameGame(state.lastConfig.requestedName, gameName) ? state.lastConfig.settings || [] : [];
      const receipt = _el('go-context-receipt');
      if (receipt) receipt.textContent = `${settings.length ? settings.length + ' read settings' : 'Current game settings unknown unless entered below'} · ${history.length ? 'Last completed advice included' : 'No previous advice included'} · ${corrections.resolution ? 'Playing resolution: ' + corrections.resolution : 'Playing resolution unknown'}.`;
      const resp = await fetch("/games/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_name: gameName,
          question,
          preset,
          system: _adviceHardware(state.hardwareStale ? null : state.lastSummary),
          current_settings: settings,
          config_game_name: settings.length ? gameName : null,
          provider, provider_key: binding?.provider_key || null, corrections, history,
          manual_values: _sameGame(state.lastConfig?.requestedName, gameName) ? state.manualValues : {},
          custom_settings: _sameGame(state.lastConfig?.requestedName, gameName) ? state.customValues.filter(item => item.label.trim()) : [],
          avoid_settings: _el('go-try-other-settings')?.checked && history.length ? history[0].setting_keys || [] : [],
        }),
        cache: "no-store",
        signal: state.controller.signal,
      });

      if (resp.status === 401 && epoch === state.epoch) window.dispatchEvent(new CustomEvent("tli-session-locked"));
      if (!resp.ok) { const failure = await resp.json().catch(() => ({})); throw new Error(typeof failure.detail === 'string' ? failure.detail : "HTTP " + resp.status); }
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
            if (meta?.model) providerLabel = (meta.label || meta.provider || '') + ' · ' + meta.model;
            if (Array.isArray(meta?.settings_plan)) planKeys = meta.settings_plan.map(item => item.key).filter(key => typeof key === 'string');
            if (error) failureMessage = String(error);
            if (error || meta?.incomplete) incomplete = true;
            if (typeof t === 'string' && t) {
              received += t; _renderOutput(received, false);
              if (status) status.textContent = 'Receiving advice…';
            }
          } catch {}
        }
        if (completed) { await reader.cancel(); break; }
      }
      if (!completed || incomplete || !received.trim()) throw new Error(failureMessage || 'The response ended before complete advice was received.');
      if (src) src.textContent = source === 'context-needed' ? 'More PC details needed · no AI request made' : source === "static-guidance" ? "General guidance · AI reply unavailable" : `${providerLabel || "AI advice"} · not a measured performance result`;
      if (source === 'ai-advice') { state.history = [...state.history.filter(item => !_sameGame(item.game_name, gameName)), { game_name: gameName, question, text: received, setting_keys: planKeys }].slice(-5); if (_el('go-try-other-wrap')) _el('go-try-other-wrap').hidden = !planKeys.length; }
      if (_el('go-empty-advice')) _el('go-empty-advice').hidden = true;
      if (status) status.textContent = source === 'context-needed' ? 'Add the missing PC details, then get your settings plan.' : source === 'static-guidance' ? 'General guidance shown because an AI reply was unavailable. It is not tailored performance analysis; no settings changed.' : 'Advice received. No game or computer settings were changed.';

    } catch (err) {
      if (epoch !== state.epoch) return;
      const stopped = state.controller?.signal.aborted;
      if (!received) { state.lastText = previous; if (previous && title) title.textContent = previousTitle; }
      if (status) status.textContent = (stopped ? 'Stopped receiving advice. This does not confirm that the server stopped its work.' : 'Advice could not complete: ' + err.message) + (received ? ' The partial reply remains below and may be incomplete.' : previous ? ' Your previous advice is unchanged.' : ' No advice was received.');
      if (src) src.textContent = received ? 'Incomplete reply' : previous ? 'Previous advice' : 'AI unavailable';
    } finally {
      if (epoch !== state.epoch) return;
      state.streaming = false;
      _setReadControls(false);
      state.controller = null;
      if (stop) stop.hidden = true;
      if (clearBtn) clearBtn.disabled = false;
      if (askBtn) { askBtn.disabled = false; askBtn.textContent = "Ask AI about this game"; }
    }
  }

  function _presetLabel(preset) {
    return { stable_60: "Smooth & steady", high_fps: "Competitive", max_visual: "Best looking" }[preset] || preset;
  }

  // ── Config read & render ───────────────────────────
  async function _loadGameConfig(gameName) {
    if (!gameName || state.locked) return;
    const ticket = ++state.configEpoch, epoch = state.epoch;
    if (state.lastConfig) state.lastConfig.stale = true;
    window.TLIGameTrials?.settingsChanged?.();
    const badge = _el('go-config-badge'), status = _el('go-detect-status');
    if (status) status.textContent = 'Reading settings for ' + gameName + '…';
    try {
      const result = await _fetchJson('/games/config_read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_name: gameName }) });
      if (state.locked || ticket !== state.configEpoch || epoch !== state.epoch || _el('go-game-input')?.value.trim() !== gameName) return;
      if (result.game_name !== gameName) throw new Error('The settings response belongs to a different game.');

      state.lastConfig = { ...result, requestedName: gameName, readAt: new Date().toLocaleTimeString() };
      window.TLIGameTrials?.settingsChanged?.();
      const note = _el('go-config-note'); if (note) note.textContent = result.supported && result.settings?.length ? 'Settings read on this host at ' + state.lastConfig.readAt + '. Verify the values still match your game.' : 'Current settings are unknown for this game. Choose settings to compare, then enter the current and trial values from your game menu.';
      _renderConfigStatus(state.lastConfig); _renderConfigSettings(state.lastConfig);
      if (status) status.textContent = result.error ? 'Settings were not read. Enter the current values you know below.' : result.supported ? 'Settings read for ' + gameName + '. Nothing changed.' : 'No settings reader supports this exact game name; choose settings to compare and enter the exact values from your game menu.';
    } catch (e) {
      if (state.locked || ticket !== state.configEpoch || epoch !== state.epoch) return;
      if (state.lastConfig) state.lastConfig.stale = true;
      window.TLIGameTrials?.settingsChanged?.();
      const note = _el('go-config-note'); if (note) note.textContent = 'Current settings are unknown after the failed read. Enter values manually or retry.';
      if (status) status.textContent = 'Settings could not be read: ' + e.message + (state.lastConfig ? ' Previous settings remain labeled for ' + state.lastConfig.requestedName + '.' : '');
      if (badge && state.lastConfig) badge.textContent = 'Previous read · ' + state.lastConfig.requestedName;
    }
  }

  function _renderConfigStatus(result) {
    const badge = _el("go-config-badge");
    const block = _el("go-settings-block");
    if (!badge || !block) return;
    badge.className = "go-config-badge";

    if (!result) { block.style.display = "none"; return; }
    if (!result.supported) { block.style.display = ''; badge.textContent = 'User-named settings · menu options unverified'; return; }

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

    if (Array.isArray(result.advice_controls)) {
      _renderCurrentControls(result, grid);
      return;
    }

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
    const epoch = state.epoch;
    const r = await fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    if ((r.status === 401 || url === '/system/summary' && r.status === 403) && epoch === state.epoch && !opts?.signal?.aborted) window.dispatchEvent(new CustomEvent("tli-session-locked"));
    if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(typeof data.detail === 'string' ? data.detail : "HTTP " + r.status); }
    return r.json();
  }

  function _loadHardware() {
    if (state.locked || !state.hardwareReady || document.hidden) return;
    if (state.hardwarePromise) return state.hardwarePromise;
    const epoch = state.epoch;
    const ticket = ++state.hardwareEpoch;
    const controller = new AbortController(); state.hardwareController = controller;
    state.hardwareStatus = 'loading'; _renderHWPills(state.lastSummary);
    const promise = (async () => { try {
      const s = await _fetchJson("/system/summary", { signal: controller.signal });
      if (state.locked || epoch !== state.epoch || ticket !== state.hardwareEpoch) return;
      const sections = ['cpu','gpu','memory','display','storage','board'];
      if (!s || typeof s !== 'object' || Array.isArray(s) || s.ok === false || !sections.some(key => Object.hasOwn(s, key)) ||
          !sections.every(key => !Object.hasOwn(s, key) || s[key] === null || typeof s[key] === 'object' && !Array.isArray(s[key]))) throw new Error('Invalid hardware summary');
      state.lastSummary = s;
      state.hardwareStale = false;
      state.hardwareStatus = 'ready';
      _renderHWPills(s);
      const resolution = _el('go-resolution');
      if (resolution && !resolution.value && s.display?.width && s.display?.height) resolution.value = `${s.display.width} × ${s.display.height}`;
      return s;
    } catch {
      if (!state.locked && epoch === state.epoch && ticket === state.hardwareEpoch) { state.hardwareStale = true; state.hardwareStatus = 'error'; _renderHWPills(state.lastSummary); }
    } finally {
      if (ticket === state.hardwareEpoch) { state.hardwarePromise = null; state.hardwareController = null; }
    } })();
    state.hardwarePromise = promise;
    return promise;
  }

  async function _detectGame() {
    if (state.locked || state.streaming || state.readBusy) return;
    const epoch = state.epoch, ticket = ++state.detectEpoch;
    _el('go-use-detected-game')?.remove();
    const btn = _el("go-detect-btn");
    if (btn) btn.textContent = "…";
    try {
      const det = await _fetchJson("/games/detect_best");
      if (state.locked || epoch !== state.epoch || ticket !== state.detectEpoch) return;
      state.lastDetect = det;
      _renderDetectStatus(det);
      // Reading settings is a separate explicit operation.
    } catch {
      const s = _el("go-detect-status");
      if (s && !state.locked && epoch === state.epoch && ticket === state.detectEpoch) s.textContent = "Detection failed. Your game name is unchanged.";
    } finally {
      if (btn && ticket === state.detectEpoch) btn.textContent = "Detect running game";
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
    const differentWrap = document.createElement('label'); differentWrap.id = 'go-try-other-wrap'; differentWrap.className = 'game-history-choice'; differentWrap.hidden = true;
    const different = document.createElement('input'); different.type = 'checkbox'; different.id = 'go-try-other-settings'; different.checked = true;
    differentWrap.append(different, document.createTextNode('Try different settings in my follow-up'));
    const actionRow = _el('go-ask-btn')?.parentElement;
    if (actionRow?.classList?.contains('button-row')) actionRow.before(differentWrap);
    else _el('go-ask-btn')?.before(differentWrap);
    const clearPrivateGameContext = () => {
      state.hardwareReady = false;
      state.hardwareEpoch++; state.hardwareController?.abort(); state.hardwareController = null; state.hardwarePromise = null; state.hardwareStatus = 'idle';
      state.locked = true; state.configEpoch++; state.providerEpoch++; state.providerBinding = null; state.history = []; state.readBusy = false; state.lastSummary = null; state.lastConfig = null; state.lastDetect = null;
      ['go-cpu','go-gpu','go-ram','go-resolution','go-manual-settings'].forEach(id => { if (_el(id)) _el(id).value = ''; });
      ['go-context-receipt','go-provider-status'].forEach(id => { if (_el(id)) _el(id).textContent = ''; });
      _setReadControls(false);
      _renderHWPills(null); _renderConfigSettings(null); _renderConfigStatus(null); const game = _el('go-game-input'); if (game) { game.value = ''; delete game.dataset.userEdited; } const question = _el('go-question'); if (question) question.value = '';
      state.contextGame = ''; state.hardwareStale = false; state.manualValues = {}; state.customValues = [];
      differentWrap.hidden = true;
      if (_el('go-config-note')) _el('go-config-note').textContent = '';
      if (_el('go-detect-status')) _el('go-detect-status').textContent = '';
      if (_el('go-output-source')) _el('go-output-source').textContent = '';
      if (_el('go-output-title')) _el('go-output-title').textContent = 'Your settings plan';
      if (_el('go-output-wrap')) _el('go-output-wrap').style.display = 'none';
      if (_el('go-empty-advice')) _el('go-empty-advice').hidden = false;
      state.controller?.abort(); state.epoch++; state.streaming = false; state.controller = null; state.lastText = '';
      content.textContent = ''; previous.hidden = true; requestStatus.textContent = ''; stop.hidden = true;
      const box = _el('go-output'); if (box) box.textContent = '';
      const ask = _el('go-ask-btn'); if (ask) { ask.disabled = false; ask.textContent = 'Ask AI about this game'; }
      const clear = _el('go-clear-btn'); if (clear) clear.disabled = false;
    };
    for (const event of ['tli-session-locked', 'tli-account-changed', 'tli-user-changed']) window.addEventListener(event, clearPrivateGameContext);
    window.addEventListener('tli-session-unlocked', () => { state.locked = false; _renderHWPills(state.lastSummary); });
    window.addEventListener('tli-private-observation-ready', () => {
      if (state.locked || state.hardwareReady) return;
      state.hardwareReady = true; _renderHWPills(state.lastSummary);
      if (state.open) _loadHardware();
    });
    document.addEventListener('visibilitychange', () => {
      if (state.open && !document.hidden && state.hardwareReady && !state.lastSummary) _loadHardware();
    });
    _el('go-analyze-btn')?.addEventListener('click', _analyze);
    _el('go-check-provider')?.addEventListener('click', () => _checkProvider(true).catch(error => { const status = _el('go-provider-status'); if (status) status.textContent = error.message; }));
    _el('go-provider')?.addEventListener('change', () => { state.providerEpoch++; state.providerBinding = null; const status = _el('go-provider-status'); if (status) status.textContent = 'Selection changed. Check the selected model or request advice when ready.'; });
    const providerInput = _el('go-provider');
    if (providerInput && typeof readSettings === 'function') { const brain = readSettings()?.defaultBrain; if (/^(lmstudio|lm_studio|lm-studio|lms)$/i.test(brain || '')) providerInput.value = 'lmstudio'; }
    document.addEventListener('tli-panel-switched', event => { const panel = event.detail?.panelId || event.detail?.panel || event.detail?.id; if (panel && panel !== 'panel-games') onClose(); });
    _el('go-read-config-btn')?.addEventListener('click', () => _loadGameConfig(_el('go-game-input')?.value.trim()));
    _el('go-read-hardware-btn')?.addEventListener('click', () => {
      if (state.locked) return;
      if (!state.hardwareReady) return window.EventInterpreter?.retry?.();
      return _loadHardware();
    });
    // Game input: mark as user-edited if they type; load config on commit
    const inp = _el("go-game-input");
    if (inp) {
      inp.addEventListener("input", () => { inp.dataset.userEdited = "1"; state.configEpoch++; _changeGame(inp.value.trim()); const badge = _el("go-config-badge"); if (badge && state.lastConfig) badge.textContent = "Previous read · " + state.lastConfig.requestedName; });
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
    }

    // Copy / Clear
    const copyBtn = _el("go-copy-btn");
    if (copyBtn) copyBtn.addEventListener("click", _copy);

    const clearBtn = _el("go-clear-btn");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (state.streaming) return;
      state.lastText = "";
      state.history = []; if (_el('go-empty-advice')) _el('go-empty-advice').hidden = false;
      differentWrap.hidden = true;
      content.textContent = ''; previous.hidden = true; requestStatus.textContent = '';
      const box = _el("go-output");
      if (box) box.innerHTML = "";
      const wrap = _el("go-output-wrap");
      if (wrap) wrap.style.display = "none";
      document.querySelectorAll(".go-preset.active").forEach(b => b.classList.remove("active"));
      state.activePreset = null;
    });
    _renderHWPills(state.lastSummary);
  }

  function _renderCurrentControls(result, grid) {
    grid.replaceChildren();
    const heading = _el('go-settings-block')?.querySelector('strong'); if (heading) heading.textContent = 'Current values for this advice';
    function selector(value, update) {
      const select = document.createElement('select'); select.className = 'field-select';
      for (const item of ['', 'Low', 'Medium', 'High', 'Ultra']) { const option = document.createElement('option'); option.value = item; option.textContent = item || 'Unknown'; select.append(option); }
      select.value = value || ''; select.addEventListener('change', () => { update(select.value); window.TLIGameTrials?.settingsChanged?.(); }); return select;
    }
    function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
    const controls = result.advice_controls;
    if (!controls.length) {
      if (!state.customValues.length) state.customValues = Array.from({length:3}, () => ({label:'',current:null}));
      state.customValues.forEach((item,index) => {
        const wrap = document.createElement('label'); wrap.className = 'go-setting-chip'; wrap.textContent = 'Quality setting ' + (index+1);
        const name = document.createElement('input'); name.className = 'field-input'; name.maxLength = 80; name.placeholder = 'Name shown in the game menu'; name.value = item.label;
        name.setAttribute('aria-label', 'Quality setting ' + (index+1) + ' name'); name.addEventListener('input', () => { item.label = name.value; window.TLIGameTrials?.settingsChanged?.(); });
        const select = selector(item.current, value => { item.current = value || null; }); select.setAttribute('aria-label', 'Current value for quality setting ' + (index+1));
        wrap.append(name, select); grid.append(wrap);
      });
      return;
    }
    for (const control of controls) {
      const read = (result.settings || []).find(item => normalize(item.key) === normalize(control.key) || normalize(item.label) === normalize(control.label));
      const previous = Object.prototype.hasOwnProperty.call(state.manualValues,control.key) ? state.manualValues[control.key] : read?.value;
      const wrap = document.createElement('label'); wrap.className = 'go-setting-chip'; wrap.textContent = control.label;
      const select = selector(['Low','Medium','High','Ultra'].includes(previous) ? previous : '', value => { state.manualValues[control.key]=value; });
      select.setAttribute('aria-label', control.label + ' current value');
      const note = document.createElement('span'); note.className='small-meta'; note.textContent = (read ? 'Read: ' + read.value + '. Change the selection to correct it.' : 'Not read. Choose only a value you know.') + ' Choices use reader vocabulary; confirm they exist in your game version.';
      wrap.append(select,note); grid.append(wrap);
    }
  }

  function _sameGame(left, right) { return String(left || '').trim().toLowerCase().replace(/\s+/g, ' ') === String(right || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function _changeGame(game) {
    const changed = !_sameGame(state.contextGame, game);
    if (changed) state.configEpoch++;
    if (state.contextGame && changed) {
      for (const id of ['go-resolution', 'go-manual-settings']) { if (_el(id)) _el(id).value = ''; }
      state.manualValues = {}; state.customValues = []; _renderConfigStatus(null);
      const note = _el('go-config-note'); if (note) note.textContent = 'Game changed. Analyze this PC or enter this game’s current settings. Earlier read settings will not be used.';
    }
    state.contextGame = game;
    if (changed) window.TLIGameTrials?.settingsChanged?.();
  }
  function _corrections() {
    const text = id => (_el(id)?.value || '').trim();
    const number = (id, low, high) => { const raw = text(id); if (!raw) return null; const value = Number(raw); if (!Number.isFinite(value) || value < low || value > high) throw new Error('Enter a valid ' + (id === 'go-ram' ? 'RAM size' : 'target FPS') + '.'); return value; };
    const target = number('go-target-fps', 20, 1000); if (target != null && !Number.isInteger(target)) throw new Error('Target FPS must be a whole number.');
    return { cpu: text('go-cpu'), gpu: text('go-gpu'), ram_gb: number('go-ram', 1, 4096), resolution: text('go-resolution'), target_fps: target, manual_settings: text('go-manual-settings') };
  }
  function _adviceHardware(summary) {
    const result = {};
    for (const [part, fields] of Object.entries({ cpu:['model','name','cores','threads'],gpu:['model','name','vram_gb'],memory:['total_gb'],display:['width','height','hz'] })) {
      result[part] = {};
      for (const key of fields) { const value = summary?.[part]?.[key]; if (key === 'hz' && value > 1000) continue; if ((typeof value === 'string' && value) || (typeof value === 'number' && Number.isFinite(value) && value > 0)) result[part][key] = value; }
    }
    return result;
  }
  function _setReadControls(busy) {
    for (const id of ['go-analyze-btn','go-read-hardware-btn','go-read-config-btn','go-detect-btn','go-check-provider','go-provider']) if (_el(id)) _el(id).disabled = busy || (id === 'go-read-hardware-btn' && state.hardwareStatus === 'loading');
  }
  async function _checkProvider(force = false, signal) {
    const provider = _el('go-provider')?.value || 'bundled';
    if (!force && state.providerBinding?.provider === provider) return state.providerBinding;
    const ticket = ++state.providerEpoch, epoch = state.epoch;
    const value = await _fetchJson('/games/advice_provider?provider=' + encodeURIComponent(provider), signal ? { signal } : {});
    if (state.locked || ticket !== state.providerEpoch || epoch !== state.epoch || (_el('go-provider')?.value || 'bundled') !== provider) throw new Error('The AI selection changed. Check it again.');
    if (value.provider !== provider || !value.provider_key || !value.model) throw new Error('The selected model could not be confirmed.');
    state.providerBinding = value;
    const host = value.inference_host;
    const location = ['127.0.0.1', 'localhost', '::1'].includes(host) ? 'the computer hosting TLI' : (host || 'an unreported host');
    const status = _el('go-provider-status'); if (status) status.textContent = `${value.label || provider} · ${value.model}. AI runs at ${location}. Readiness is tested when you ask.`;
    return value;
  }
  async function _analyze() {
    if (state.locked || state.streaming || state.readBusy) return;
    const game = (_el('go-game-input')?.value || '').trim();
    const status = _el('go-detect-status');
    if (!game) { if (status) status.textContent = 'Enter a game name first, or detect the running game.'; _el('go-game-input')?.focus(); return; }
    _changeGame(game); state.readBusy = true; _setReadControls(true);
    const ask = _el('go-ask-btn'); if (ask) ask.disabled = true;
    const epoch = state.epoch;
    if (status) status.textContent = 'Reading this PC and the game’s available settings…';
    try {
      await Promise.allSettled([_loadHardware(), _loadGameConfig(game)]);
      if (state.locked || epoch !== state.epoch) return;
      if (status) status.textContent = state.hardwareStale ? 'Hardware could not be refreshed. Enter settings manually to build a trial plan, or retry the read.' : 'Saved settings reviewed. Choose settings to build a trial plan; missing values can be entered manually.';
    } finally { if (epoch === state.epoch) { state.readBusy = false; _setReadControls(false); if (ask) ask.disabled = false; } }
  }
  function onClose() {
    state.open = false;
    state.detectEpoch++; _el('go-use-detected-game')?.remove();
    state.hardwareEpoch++; state.hardwareController?.abort(); state.hardwareController = null; state.hardwarePromise = null;
    if (state.hardwareStatus === 'loading') { state.hardwareStatus = state.lastSummary ? 'ready' : 'idle'; _renderHWPills(state.lastSummary); }
    if (!state.streaming && !state.readBusy) return;
    state.controller?.abort(); state.epoch++; state.configEpoch++; state.providerEpoch++;
    state.streaming = false; state.readBusy = false; state.controller = null; _setReadControls(false);
    const status = _el('go-request-status'); if (status) status.textContent = 'Request stopped when leaving Game Optimizer. Retained advice may be incomplete; retry deliberately.';
    if (_el('go-stop-btn')) _el('go-stop-btn').hidden = true;
    if (_el('go-clear-btn')) _el('go-clear-btn').disabled = false;
    if (_el('go-ask-btn')) { _el('go-ask-btn').disabled = false; _el('go-ask-btn').textContent = 'Ask AI about this game'; }
  }
  async function onOpen() { setup(); state.open = true; await _loadHardware(); }

  function trialContext() {
    const game = (_el('go-game-input')?.value || '').trim();
    const config = !state.locked && state.lastConfig && !state.lastConfig.stale && _sameGame(state.lastConfig.requestedName, game) ? state.lastConfig : null;
    return {preset: state.activePreset || 'stable_60', current_settings: config ? (config.settings || []).map(item => ({...item})) : [],
      config_game_name: config?.settings?.length ? game : null, manual_values: config ? {...state.manualValues} : {},
      busy: state.streaming || state.readBusy, locked: state.locked};
  }
  return { setup, onOpen, onClose, trialContext };
})();
