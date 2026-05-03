window.TLISystem = (function () {
  const state = {
    cache: null,
    lastFetchMs: 0,
    ttlMs: 10_000, // refresh at most every 10s when opening panel
  };

  function _el(id) { return document.getElementById(id); }
  function _now() { return Date.now(); }
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

  // Try the "real" endpoint first; fallback to your existing /system/probe (minimal)
  async function fetchSummary() {
    // Throttle
    if (state.cache && (_now() - state.lastFetchMs) < state.ttlMs) return state.cache;

    // Endpoint #1: preferred
    try {
      const res = await fetch("/system/summary", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        state.cache = data;
        state.lastFetchMs = _now();
        return data;
      }
    } catch (e) {
      // ignore, fallback
    }

    // Endpoint #2: fallback minimal probe (already exists in your Settings)
    try {
      const res2 = await fetch("/system/probe", { cache: "no-store" });
      if (!res2.ok) throw new Error("HTTP " + res2.status);
      const p = await res2.json();

      // Normalize to a "summary-like" object so the UI still works today
      const normalized = {
        taken_at: new Date().toISOString(),
        cpu: {
          name: p.cpu_model || null,
          cores: p.cpu_cores,
          threads: p.cpu_threads,
        },
        gpu: {
          name: p.gpu_name || null,
          vram_gb: p.gpu_vram_gb,
        },
        memory: { total_gb: p.ram_total_gb },
        display: null,
        storage: null,
        board: null,
        os: null,
        _source: "fallback:/system/probe",
      };

      state.cache = normalized;
      state.lastFetchMs = _now();
      return normalized;
    } catch (err) {
      throw err;
    }
  }

  function render(summary) {
    if (!summary) return;

    const stamp =
      summary.taken_at
        ? new Date(summary.taken_at).toLocaleString()
        : new Date().toLocaleString();

    _setSnapshotTime("Snapshot: " + stamp);

    // CPU
    const cpuName = summary.cpu?.name || "Unknown CPU";
    const cpuCT =
      (summary.cpu?.cores && summary.cpu?.threads)
        ? `${summary.cpu.cores}C / ${summary.cpu.threads}T`
        : "";
    _setCard("card-cpu", `<div><strong>${cpuName}</strong></div><div class="muted">${cpuCT}</div>`);

    // GPU
    const gpuName = summary.gpu?.name || "Unknown GPU";
    const vram = summary.gpu?.vram_gb != null ? _fmtGB(summary.gpu.vram_gb) : null;
    _setCard("card-gpu", `<div><strong>${gpuName}</strong></div><div class="muted">${vram ? (vram + " VRAM") : ""}</div>`);

    // Memory
    const ram = summary.memory?.total_gb != null ? _fmtGB(summary.memory.total_gb) : null;
    _setCard("card-memory", `<div><strong>${ram || "Unknown RAM"}</strong></div><div class="muted">Installed memory</div>`);

    // Display (optional)
    if (summary.display) {
      const d = summary.display;
      const res = (d.width && d.height) ? `${d.width}×${d.height}` : "Unknown res";
      const hz = d.hz ? `${d.hz} Hz` : "";
      _setCard("card-display", `<div><strong>${res}</strong></div><div class="muted">${hz}</div>`);
    } else {
      _setCard("card-display", `<div class="muted">Display info not loaded yet.</div>`);
    }

    // Storage (optional)
    if (summary.storage && Array.isArray(summary.storage.drives)) {
      const list = summary.storage.drives.slice(0, 6).map(d => {
        const name = d.model || d.name || "Drive";
        const cap = d.size_gb ? _fmtGB(d.size_gb) : (d.size_tb ? (d.size_tb + " TB") : "");
        const iface = d.interface || d.bus || "";
        return `<div>• ${name}${cap ? " — " + cap : ""}${iface ? " (" + iface + ")" : ""}</div>`;
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
      _setCard("card-board", `<div><strong>${mb}</strong></div><div class="muted">${bios} ${date}</div>`);
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
      lines.push(`CPU: ${summary.cpu.name || "Unknown"} ${summary.cpu.cores && summary.cpu.threads ? `(${summary.cpu.cores}C/${summary.cpu.threads}T)` : ""}`.trim());
    }
    if (summary.gpu) {
      lines.push(`GPU: ${summary.gpu.name || "Unknown"}${summary.gpu.vram_gb != null ? ` (${summary.gpu.vram_gb} GB VRAM)` : ""}`);
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
    lines.push(`Snapshot: ${summary.taken_at ? summary.taken_at : new Date().toISOString()}`);
    if (summary._source) lines.push(`Source: ${summary._source}`);

    return lines.join("\n");
  }

  async function copyText() {
    const txt = buildCopyText(state.cache);
    try {
      await navigator.clipboard.writeText(txt);
      showToast("Copied system summary.");
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied system summary.");
    }
  }

  async function copyJson() {
    const txt = JSON.stringify(state.cache || {}, null, 2);
    try {
      await navigator.clipboard.writeText(txt);
      showToast("Copied JSON.");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied JSON.");
    }
  }

  function setup() {
    const btnText = _el("btn-copy-system-text");
    const btnJson = _el("btn-copy-system-json");
    if (btnText) btnText.addEventListener("click", copyText);
    if (btnJson) btnJson.addEventListener("click", copyJson);

    // Leave your existing "Loading…" placeholders until we fetch
    _setSnapshotTime("Snapshot not loaded");
  }

  async function onOpen() {
    // show immediate feedback (no spinner yet; just update placeholder)
    _setSnapshotTime("Loading snapshot…");

    try {
      const summary = await fetchSummary();
      render(summary);
      debugLog("info", "System Summary loaded.");
    } catch (err) {
      _setSnapshotTime("Snapshot failed to load");
      _setCard("card-cpu", `<div class="muted">Could not load system summary.</div>`);
      _setCard("card-gpu", `<div class="muted">Could not load system summary.</div>`);
      _setCard("card-memory", `<div class="muted">Could not load system summary.</div>`);
      _setCard("card-display", `<div class="muted">Could not load system summary.</div>`);
      _setCard("card-storage", `<div class="muted">Could not load system summary.</div>`);
      _setCard("card-board", `<div class="muted">Could not load system summary.</div>`);
      debugLog("warn", "System Summary failed: " + (err?.message || err));
      showToast("System Summary failed (backend endpoint missing).", "warning");
    }
  }

  return {
    setup,
    onOpen,
    refresh: onOpen,
    getCache: () => state.cache
  };
})();
