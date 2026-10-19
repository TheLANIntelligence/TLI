window.TLISystem = (function () {
  const state = {
    cache: null,
    lastFetchMs: 0,
    ttlMs: 10_000, // refresh at most every 10s when opening panel
    epoch: 0, locked: false, ready: true, open: false, request: null,
  };

  function _el(id) { return document.getElementById(id); }
  function _now() { return Date.now(); }
  const _esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const _current = ticket => ticket === state.request && ticket.epoch === state.epoch && !state.locked && state.ready;
  const sections = ['cpu','gpu','memory','display','storage','board'];
  const _summary = value => value && typeof value === 'object' && !Array.isArray(value) && value.ok !== false &&
    sections.some(key => Object.hasOwn(value,key)) && sections.every(key => !Object.hasOwn(value,key) || value[key] === null || typeof value[key] === 'object' && !Array.isArray(value[key]));
  function _fmtGB(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    return (Math.round(n * 10) / 10) + " GB";
  }

  function _setCard(id, html) {
    const card = _el(id);
    if (!card) return;
    const body = card.querySelector(".card-body");
    if (!body) return;
    body.innerHTML = html;
  }

  function _setSnapshotTime(text) {
    const el = _el("system-snapshot-time");
    if (el) el.textContent = text;
  }

  function _clear(message) {
    state.cache = null; state.lastFetchMs = 0;
    _setSnapshotTime(message);
    for (const id of ['card-cpu','card-gpu','card-memory','card-display','card-storage','card-board']) _setCard(id, `<div class="muted">${_esc(message)}</div>`);
    for (const id of ['btn-copy-system-text','btn-copy-system-json']) { const button = _el(id); if (button) button.disabled = true; }
  }
  function _invalidate() {
    state.epoch++; state.request?.controller.abort(); state.request = null;
  }
  window.addEventListener('tli-session-locked', () => {
    state.locked = true; state.ready = false; _invalidate(); _clear('Unlock TLI and check access to read system information.');
  });
  window.addEventListener('tli-session-unlocked', () => { state.locked = false; _invalidate(); });
  window.addEventListener('tli-private-observation-ready', () => {
    if (state.locked || state.ready) return;
    state.ready = true; if (state.open && !document.hidden) onOpen();
  });
  document.addEventListener('tli-panel-switched', event => { if ((event.detail?.panelId || event.detail?.panel) !== 'panel-system') onClose(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _invalidate();
    else if (state.open && state.ready && !state.locked) onOpen();
  });
  window.addEventListener('pagehide', () => { state.open = false; state.ready = false; _invalidate(); _clear('System information is not loaded.'); });

  async function fetchSummary(force = false) {
    if (!state.ready || state.locked || document.hidden) return null;
    if (state.request) return state.request.promise;
    if (!force && state.cache && (_now() - state.lastFetchMs) < state.ttlMs) return state.cache;
    const ticket = {epoch:state.epoch, controller:new AbortController(), promise:null}; state.request = ticket;
    const options = {credentials:'same-origin', cache:'no-store', signal:AbortSignal.any([ticket.controller.signal, AbortSignal.timeout(30000)])};
    const accepted = response => {
      if (!_current(ticket)) return false;
      if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return false; }
      return true;
    };
    ticket.promise = (async () => {
      try {
        const response = await fetch('/system/summary', options);
        if (!accepted(response)) return null;
        let data;
        // Only an older host missing this endpoint can use the legacy probe.
        // Access failures and unavailable observations never trigger more work.
        if (response.status === 404 || response.status === 405) {
          const fallback = await fetch('/system/probe', options);
          if (!accepted(fallback)) return null;
          if (!fallback.ok) throw Error('System information unavailable.');
          const p = await fallback.json(); if (!_current(ticket)) return null;
          if (!p || typeof p !== 'object' || !['cpu_cores','cpu_threads','ram_total_gb'].some(key => typeof p[key] === 'number' && Number.isFinite(p[key]))) throw Error('System information unreadable.');
          data = {taken_at:new Date().toISOString(), cpu:{name:p.cpu_model || null,cores:p.cpu_cores,threads:p.cpu_threads},
            gpu:{name:p.gpu_name || null,vram_gb:p.gpu_vram_gb}, memory:{total_gb:p.ram_total_gb},
            display:null,storage:null,board:null,os:null,_source:'fallback:/system/probe'};
        } else {
          if (!response.ok) throw Error('System information unavailable.');
          data = await response.json(); if (!_current(ticket)) return null;
          if (!_summary(data)) throw Error('System information unreadable.');
        }
        state.cache = data; state.lastFetchMs = _now(); return data;
      } catch (error) {
        if (!_current(ticket)) return null;
        _clear('System information unavailable. Refresh to try again.');
        throw Error('System information unavailable.');
      } finally { if (state.request === ticket) state.request = null; }
    })();
    return ticket.promise;
  }

  function render(summary) {
    if (!summary) return;

    const stamp =
      (summary.taken_at || summary.timestamp)
        ? new Date(summary.taken_at || summary.timestamp).toLocaleString()
        : new Date().toLocaleString();

    _setSnapshotTime("Snapshot: " + stamp);

    // CPU
    const cpuName = summary.cpu?.name || summary.cpu?.model || "Unknown CPU";
    const cpuCT =
      (summary.cpu?.cores && summary.cpu?.threads)
        ? `${summary.cpu.cores}C / ${summary.cpu.threads}T`
        : "";
    _setCard("card-cpu", `<div><strong>${_esc(cpuName)}</strong></div><div class="muted">${_esc(cpuCT)}</div>`);

    // GPU
    const gpuName = summary.gpu?.name || summary.gpu?.model || "Unknown GPU";
    const vram = summary.gpu?.vram_gb != null ? _fmtGB(summary.gpu.vram_gb) : null;
    _setCard("card-gpu", `<div><strong>${_esc(gpuName)}</strong></div><div class="muted">${vram ? (vram + " VRAM") : ""}</div>`);

    // Memory
    const ram = summary.memory?.total_gb != null ? _fmtGB(summary.memory.total_gb) : null;
    _setCard("card-memory", `<div><strong>${ram || "Unknown RAM"}</strong></div><div class="muted">Installed memory</div>`);

    // Display (optional)
    if (summary.display) {
      const d = summary.display;
      const res = (d.width && d.height) ? `${d.width}×${d.height}` : "Unknown res";
      const hz = d.hz ? `${d.hz} Hz` : "";
      _setCard("card-display", `<div><strong>${_esc(res)}</strong></div><div class="muted">${_esc(hz)}</div>`);
    } else {
      _setCard("card-display", `<div class="muted">Display info not loaded yet.</div>`);
    }

    // Storage (optional)
    if (summary.storage && Array.isArray(summary.storage.drives)) {
      const list = summary.storage.drives.slice(0, 6).map(d => {
        const name = d.model || d.name || "Drive";
        const cap = d.size_gb ? _fmtGB(d.size_gb) : (d.size_tb ? (d.size_tb + " TB") : "");
        const iface = d.interface || d.bus || "";
        return `<div>• ${_esc(name)}${cap ? " — " + _esc(cap) : ""}${iface ? " (" + _esc(iface) + ")" : ""}</div>`;
      }).join("");
      _setCard("card-storage", list || `<div class="muted">No drives reported.</div>`);
    } else {
      _setCard("card-storage", `<div class="muted">Storage info not loaded yet.</div>`);
    }

    // Board & BIOS (optional)
    if (summary.board) {
      const b = summary.board;
      const mb = b.model || b.name || "Board";
      const bios = b.bios_version ? `BIOS ${b.bios_version}` : "";
      const date = b.bios_date ? `(${b.bios_date})` : "";
      _setCard("card-board", `<div><strong>${_esc(mb)}</strong></div><div class="muted">${_esc(bios)} ${_esc(date)}</div>`);
    } else {
      _setCard("card-board", `<div class="muted">Board/BIOS info not loaded yet.</div>`);
    }
  }

  function buildCopyText(summary) {
    if (!summary) return "No system summary loaded.";

    const lines = [];
    lines.push("TLI System Summary (local, read-only)");
    lines.push("----------------------------------");

    if (summary.cpu) {
      lines.push(`CPU: ${summary.cpu.name || summary.cpu.model || "Unknown"} ${summary.cpu.cores && summary.cpu.threads ? `(${summary.cpu.cores}C/${summary.cpu.threads}T)` : ""}`.trim());
    }
    if (summary.gpu) {
      lines.push(`GPU: ${summary.gpu.name || summary.gpu.model || "Unknown"}${summary.gpu.vram_gb != null ? ` (${summary.gpu.vram_gb} GB VRAM)` : ""}`);
    }
    if (summary.memory) {
      lines.push(`RAM: ${summary.memory.total_gb != null ? `${summary.memory.total_gb} GB` : "Unknown"}`);
    }
    if (summary.display?.width && summary.display?.height) {
      lines.push(`Display: ${summary.display.width}x${summary.display.height}${summary.display.hz ? ` @ ${summary.display.hz}Hz` : ""}`);
    }
    if (summary.board?.model || summary.board?.name) {
      lines.push(`Board: ${summary.board.model || summary.board.name}`);
    }
    if (summary.board?.bios_version) {
      lines.push(`BIOS: ${summary.board.bios_version}${summary.board.bios_date ? ` (${summary.board.bios_date})` : ""}`);
    }
    if (summary.os?.name || summary.os?.build) {
      lines.push(`OS: ${(summary.os.name || "Windows")}${summary.os.build ? ` (Build ${summary.os.build})` : ""}`);
    }

    lines.push("");
    lines.push(`Snapshot: ${summary.taken_at || summary.timestamp || new Date().toISOString()}`);
    if (summary._source) lines.push(`Source: ${summary._source}`);

    return lines.join("\n");
  }

  async function copyText() {
    return copySnapshot(false);
  }

  async function copyJson() {
    return copySnapshot(true);
  }
  async function copySnapshot(json) {
    if (state.locked || !state.ready || !state.cache) return;
    const epoch = state.epoch, cached = state.cache;
    const current = () => !state.locked && state.ready && epoch === state.epoch && cached === state.cache;
    const txt = json ? JSON.stringify(cached, null, 2) : buildCopyText(cached);
    try {
      await navigator.clipboard.writeText(txt);
      if (current()) showToast(json ? 'Copied JSON.' : 'Copied system summary.');
    } catch {
      if (!current()) return;
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      try {
        if (current() && document.execCommand("copy") && current()) showToast(json ? 'Copied JSON.' : 'Copied system summary.');
      } finally { document.body.removeChild(ta); }
    }
  }

  function setup() {
    if (setup.done) return; setup.done = true;
    const btnText = _el("btn-copy-system-text");
    const btnJson = _el("btn-copy-system-json");
    if (btnText) btnText.addEventListener("click", copyText);
    if (btnJson) btnJson.addEventListener("click", copyJson);

    _clear('Snapshot not loaded');
  }

  async function onOpen({force = false, explicit = false} = {}) {
    state.open = true;
    if (state.locked || !state.ready) {
      _clear('Unlock TLI and check access to read system information.');
      if (explicit && !state.locked) window.EventInterpreter?.retry?.();
      return;
    }
    if (document.hidden) return;
    const epoch = state.epoch;
    // show immediate feedback (no spinner yet; just update placeholder)
    _setSnapshotTime("Loading snapshot…");

    try {
      const summary = await fetchSummary(force);
      if (epoch !== state.epoch || !state.open || state.locked || !state.ready || !summary) return;
      render(summary);
      for (const id of ['btn-copy-system-text','btn-copy-system-json']) { const button = _el(id); if (button) button.disabled = false; }
      debugLog("info", "System Summary loaded.");
    } catch (err) {
      if (epoch !== state.epoch || !state.open || state.locked || !state.ready) return;
      _clear('System information unavailable. Refresh to try again.');
      debugLog("warn", "System information unavailable.");
    }
  }
  function onClose() { state.open = false; _invalidate(); }

  return {
    setup,
    onOpen,
    onClose,
    refresh: () => onOpen({force:true, explicit:true}),
    getCache: () => state.locked || !state.ready ? null : state.cache
  };
})();
