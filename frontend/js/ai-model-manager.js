// One controller owns model installation, selection and status.
(function () {
  if (window.__TLI_MODEL_LIBRARY__) return;
  window.__TLI_MODEL_LIBRARY__ = true;
  const el = id => document.getElementById(id);
  const _esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fmtBytes = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? `${(n / 1024 ** 3).toFixed(1)} GB` : 'Size unknown';
  let busy = false, polling = false, revision = 0;
  let returnFocus = null, isOpen = false;
  function status(message) { if (el("model-manager-progress")) el("model-manager-progress").textContent = message; }
  async function api(url, options = {}) {
    const r = await fetch(url, {cache: "no-store", ...options});
    const data = await r.json();
    if (!r.ok || data.ok === false) {
      const recovery = data.recovery;
      const suffix = recovery ? (recovery.restored ? " Previous model restored." : recovery.attempted ? " Previous model could not restart; AI is unavailable." : " Previous selection retained.") : "";
      throw new Error((typeof data.detail === "string" ? data.detail : data.error || `HTTP ${r.status}`) + suffix);
    }
    return data;
  }
  const post = (url, body) => api(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body || {})});
  function hideOverlay() {
    if (!isOpen) return;
    isOpen = false;
    el("model-manager-modal-overlay")?.classList.add("hidden"); el("model-manager-modal-overlay")?.setAttribute("aria-hidden", "true");
    if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null;
  }
  function validationDetails(v) {
    if (!v || !['evaluated_with_limitations', 'comparison_recorded'].includes(v.status)) return '';
    const compared = v.status === 'comparison_recorded';
    const known = ['standard', 'lite', 'power', 'qwen3_1_7b', 'qwen3_4b', 'qwen3_8b'];
    const anniversary = compared && v.study_id === 'anniversary_completion';
    const link = compared ? (anniversary ? '/model-comparison-anniversary.html' : '/model-comparison.html') + (known.includes(v.preset_id) ? '#model-' + v.preset_id : '') : '/answer-validation.html';
    const dimensions = [['factual_grounding', 'Grounding'], ['useful_next_steps', 'Useful next steps'], ['context_handling', 'Context handling'], ['truthful_action_claims', 'Truthful action claims']];
    return `<p class="mm2-tier-desc">Reference evaluation · ${_esc(v.evaluated_at)} · ${_esc(v.case_count)} synthetic questions. ${_esc(v.conditions)}</p>
      ${compared ? `<p class="mm2-tier-desc">${_esc(v.response_count)} of 55 answers received · ${_esc(v.timeout_count)} timed out · ${_esc(v.failed_count)} other failures · ${_esc(v.not_run_count)} not run or preparation failed. The 24 held-out questions are part of the 47 primary cases; 8 earlier stress cases are reported separately.</p>
        <p class="mm2-tier-desc">Primary cases meeting each rubric: ${dimensions.map(([key, label]) => `${label}: ${_esc(v.primary_dimensions?.[key]?.['2'] ?? 'unknown')}/47`).join(' · ')}. These are separate assessments, not an overall accuracy score.</p>` : ''}
      ${anniversary ? `<p class="mm2-tier-desc">Anniversary follow-up: real model replies to supplied synthetic context. This does not test live action execution. <a href="/model-comparison.html" target="_blank" rel="noopener">Earlier comparison</a></p>` : ''}
      <p class="mm2-tier-desc">This reference does not verify your installed copy or its current answers. Physical user acceptance has not been performed.</p>
      <p class="mm2-tier-desc">Evaluated model SHA-256: <code>${_esc(v.model_sha256)}</code><br>Runtime SHA-256: <code>${_esc(v.runtime_sha256)}</code></p>
      <a href="${link}" target="_blank" rel="noopener">${compared ? 'Read the model comparison' : 'Read the validation record'}</a>`;
  }
  async function render() {
    const current = ++revision, container = el("mm2-tiers");
    if (!container) return;
    try {
      const data = await api("/api/ai/models/presets");
      if (current !== revision) return;
      container.innerHTML = "";
      for (const p of data.presets || []) {
        const c = p.compatibility || {state:"unknown", reasons:["Recheck compatibility with an updated TLI host."]};
        const labels = {compatible:"Meets resource estimates", insufficient_resources:"Insufficient resources", unsupported:"Unsupported", unknown:"Compatibility unknown"};
        const running = p.running === true;
        const installed = p.installation_complete === true;
        const states = [running ? "Running" : "", p.is_selected ? "Selected" : "", installed ? "Installed" : "Not installed"].filter(Boolean);
        const card = document.createElement("div");
        card.className = "mm2-tier-card" + (running ? " active" : "");
        card.innerHTML = `<div class="mm2-tier-name">${_esc(p.name || p.id)}</div>
          <div class="mm2-tier-desc">${states.join(" · ")}</div>
          ${p.family ? `<div class="mm2-tier-desc">${_esc(p.family)} · ${p.is_vision ? "Image and text" : "Text only"}${p.non_thinking ? " · Non-thinking mode" : ""}</div>` : ""}
          <div class="mm2-tier-desc mm2-compatibility">${_esc(labels[c.state] || labels.unknown)}</div>
          <div class="mm2-tier-desc">${_esc((c.reasons || []).join(" "))}</div>
          <details class="mm2-technical"><summary>Technical details</summary>
          ${p.validation_note ? `<div class="mm2-tier-desc">${_esc(p.validation_note)}</div>` : ""}
          ${c.runtime?.reason ? `<div class="mm2-tier-desc">${_esc(c.runtime.reason)}</div>` : ""}
          <div class="mm2-tier-meta">${_esc(p.quantization || "GGUF")} · ${fmtBytes(c.download_bytes || p.size_bytes)} · Context ${_esc(c.context_size || p.ctx_size || "unknown")}</div>
          <div class="mm2-tier-desc">${_esc(c.execution_mode || "Execution mode unknown")}</div>
          <div class="mm2-tier-desc">${c.required_total_ram_gb ? `Estimated minimum ${_esc(c.required_total_ram_gb)} GB total RAM. ` : ""}${c.required_available_ram_bytes ? `${fmtBytes(c.required_available_ram_bytes)} available RAM estimated.` : ""}</div>
          <div class="mm2-tier-desc">${c.resources ? `Host RAM: ${c.resources.total_ram_bytes == null ? "unknown" : fmtBytes(c.resources.total_ram_bytes)} total · ${c.resources.available_ram_bytes == null ? "unknown" : fmtBytes(c.resources.available_ram_bytes)} available` : ""}</div>
          <div class="mm2-tier-desc">${_esc((c.installation?.components || []).map(x => `${x.filename}: ${x.valid ? "present" : "missing or invalid"}`).join(" · "))}</div>
          <h4>Answer validation</h4>
          <p class="mm2-tier-desc">${_esc(p.answer_validation?.summary || "No real-answer evaluation is recorded for this model. Startup checks only show that inference responds.")}</p>
          ${validationDetails(p.answer_validation)}
          </details>
          <div class="mm2-tier-actions"></div>`;
        const actions = card.querySelector(".mm2-tier-actions");
        function button(label, disabled, handler) {
          const b = document.createElement("button"); b.type = "button"; b.className = "mm2-tier-btn";
          b.textContent = label; b.disabled = disabled || busy; b.addEventListener("click", handler); actions.appendChild(b);
        }
        if (running) button("Running", true, () => {});
        else if (installed) button(c.state === "unknown" ? "Check and use" : "Use this model",
          c.state !== "unknown" && !c.selectable, () => operation(async () => {
            status(c.state === "unknown" ? "Checking model; the current model will pause. Recovery is attempted if the check fails…" : "Checking and switching model…");
            await post(c.state === "unknown" ? "/api/ai/models/check" : "/api/ai/models/select", {preset_id:p.id});
            status("Model is running. Startup and inference checks passed.");
          }));
        else if (!p.id.startsWith("custom:")) {
          button(`Download ${fmtBytes(c.download_bytes || p.size_bytes)}`, !c.download_allowed, () => operation(async () => {
            await post("/api/ai/model/download", {preset_id:p.id}); status("Downloading model files…"); poll();
          }));
          if (!c.download_allowed) {
            const reason = document.createElement("p"); reason.textContent = c.download_reason || "Recheck storage availability."; actions.appendChild(reason);
          }
        }
        if (installed && !p.is_selected && !running) button("Remove download", false, () => operation(async () => {
          if (!confirm(`Remove ${p.name || p.id} from model storage?`)) return;
          await api("/api/ai/model/" + encodeURIComponent(p.id), {method:"DELETE"});
          status("Model download removed.");
        }));
        button("Recheck", false, render);
        container.appendChild(card);
      }
    } catch (e) { status("Could not refresh models: " + e.message); }
  }
  async function operation(work) {
    if (busy) return;
    busy = true;
    try { await work(); } catch (e) { status(e.message); }
    finally { busy = false; await render(); }
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      while (true) {
        const s = await api("/api/ai/model/progress");
        el("mm2-progresswrap")?.classList.toggle("hidden", !s.in_progress);
        const pct = s.bytes_total ? Math.min(100, s.bytes_done / s.bytes_total * 100) : 0;
        if (el("model-manager-bar")) el("model-manager-bar").style.width = `${pct}%`;
        if (el("model-manager-bar-meta")) el("model-manager-bar-meta").textContent = `${fmtBytes(s.bytes_done)} / ${s.bytes_total ? fmtBytes(s.bytes_total) : "unknown size"}`;
        if (s.status === "done") { status("Installation complete. Choose Use this model when ready."); break; }
        if (s.status === "error") { status("Installation failed: " + (s.error || "Unknown error")); break; }
        if (s.status === "cancelled") { status("Installation cancelled. Previous files retained."); break; }
        if (!s.in_progress) break;
        status(s.status === "cancelling" ? "Cancelling; waiting for the worker to finish…" : `Downloading ${s.filename || "model files"}…`);
        await new Promise(resolve => setTimeout(resolve, 750));
      }
    } catch (e) { status("Progress unavailable: " + e.message + ". Reopen to check; the installation may still be running."); }
    finally { polling = false; await render(); }
  }
  function bind(id, fn) { const b = el(id); if (b && !b.__modelLibrary) { b.__modelLibrary = true; b.addEventListener("click", fn); } }
  function boot() {
    bind("model-manager-close", hideOverlay); bind("model-manager-x", hideOverlay);
    bind("model-manager-reveal", () => operation(async () => { await post("/api/ai/model/reveal"); status("Requested the models folder to open."); }));
    bind("model-manager-cancel", async () => { try { await post("/api/ai/model/cancel"); status("Cancellation requested; waiting for completion…"); poll(); } catch (e) { status("Cancellation failed: " + e.message); } });
    bind("model-manager-select", () => el("model-manager-file")?.click());
    bind("model-manager-download", () => operation(async () => { await post("/api/ai/model/download", {url:el("model-manager-url")?.value || ""}); poll(); }));
    bind("mm2-storage-go-devices-btn", () => { hideOverlay(); if (typeof switchPanel === "function") switchPanel("panel-devices"); });
    bind("ai-status-manage-btn", open);
    const file = el("model-manager-file");
    if (file && !file.__modelLibrary) { file.__modelLibrary = true; file.addEventListener("change", () => operation(async () => {
      const f = file.files?.[0]; if (!f) return;
      status("Installing " + f.name + "…"); const body = new FormData(); body.append("file", f);
      await api("/api/ai/model/upload", {method:"POST", body}); file.value = "";
      status("Installed. Use Check and use for custom models; current selection is unchanged.");
    })); }
    const overlay = el("model-manager-modal-overlay");
    if (overlay && !overlay.__modelLibrary) {
      overlay.__modelLibrary = true;
      overlay.addEventListener("click", e => { if (e.target === overlay) hideOverlay(); });
      overlay.addEventListener("keydown", e => {
        if (e.key === 'Escape' && !e.defaultPrevented && isOpen) { e.preventDefault(); e.stopPropagation(); hideOverlay(); }
      });
    }
  }
let _savetoCurrentPath = "";
let _savetoEpoch = 0, _savetoRead = 0, _savetoReady = true, _savetoLocked = false, _savetoBusy = false, _savetoHasOptions = false;
const saveToCurrent = token => _savetoReady && !_savetoLocked && token.epoch === _savetoEpoch && token.read === _savetoRead;
function clearSaveToPicker() {
  _savetoEpoch++; _savetoReady = false; _savetoBusy = false; _savetoHasOptions = false; _savetoCurrentPath = "";
  for (const id of ['mm2-saveto-path', 'mm2-saveto-free', 'mm2-saveto-picker']) {
    const node = el(id); if (node) node.textContent = '';
  }
  el('mm2-saveto-picker')?.classList.add('hidden');
  if (el('mm2-saveto-path')) el('mm2-saveto-path').textContent = 'Unlock TLI, then check the destination again.';
  status('Storage access changed. Check the current destination before making another change.');
}
window.addEventListener?.('tli-session-locked', () => { _savetoLocked = true; clearSaveToPicker(); });
window.addEventListener?.('tli-session-unlocked', () => { _savetoLocked = false; _savetoEpoch++; });
window.addEventListener?.('tli-private-observation-ready', () => { if (!_savetoLocked) _savetoReady = true; });
window.addEventListener?.('pagehide', clearSaveToPicker);
async function saveToRequest(url, token, options = {}) {
  if (!saveToCurrent(token)) throw Error('Storage access changed.');
  const response = await fetch(url, {cache: 'no-store', signal: AbortSignal.timeout(10000), ...options});
  if (!saveToCurrent(token)) throw Error('Storage access changed.');
  const data = await response.json().catch(() => null);
  if (!saveToCurrent(token)) throw Error('Storage access changed.');
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent('tli-session-locked'));
    throw Error('Storage access changed.');
  }
  if (!response.ok || data?.ok === false) throw Error(typeof data?.detail === 'string' ? data.detail : data?.error || `HTTP ${response.status}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Storage response unreadable.');
  return data;
}

async function loadSaveToPicker() {
  const pathEl   = el("mm2-saveto-path");
  const freeEl   = el("mm2-saveto-free");
  const picker   = el("mm2-saveto-picker");
  const changeBtn = el("mm2-saveto-change-btn");
  if (!pathEl) return;
  // Bind recovery before any failed/paused read can return.
  if (changeBtn && !changeBtn.__stb) {
    changeBtn.__stb = true;
    changeBtn.addEventListener("click", async () => {
      if (_savetoLocked) return;
      if (!_savetoReady) { window.EventInterpreter?.retry?.(); return; }
      const epoch = _savetoEpoch;
      if (!_savetoHasOptions) await loadSaveToPicker();
      if (epoch !== _savetoEpoch || !_savetoReady || _savetoLocked || !_savetoHasOptions || !picker) return;
      const isHidden = picker.classList.contains("hidden");
      picker.classList.toggle("hidden", !isHidden);
      changeBtn.textContent = isHidden ? "Done" : "Change";
    });
  }
  // Opening or refreshing after recovery is read-only; previous choices are never replayed.
  if (!_savetoReady || _savetoLocked) return;
  const token = {epoch: _savetoEpoch, read: ++_savetoRead};
  _savetoHasOptions = false; _savetoCurrentPath = '';
  pathEl.textContent = 'Checking destination…';
  if (freeEl) freeEl.textContent = '';
  if (picker) picker.textContent = '';

  // Show the selected destination immediately; USB discovery may take longer.
  let locData = null, usbData = null;
  try {
    locData = await saveToRequest("/api/ai/storage/location", token);
    if (!saveToCurrent(token)) return;
    if (typeof locData.path !== 'string' || !locData.path) throw Error('Storage destination unreadable.');
  }
  catch (e) { if (saveToCurrent(token)) { pathEl.textContent = "Unknown"; status(e.message); } return; }
  _savetoCurrentPath = locData.path || "";
  pathEl.textContent = _savetoCurrentPath;
  if (freeEl) freeEl.textContent = locData.free_gb != null ? `${locData.free_gb} GB free` : "Free space unknown";
  try {
    usbData = await saveToRequest("/devices/usb", token, {signal: AbortSignal.timeout(5000)});
    if (!saveToCurrent(token)) return;
    if (!Array.isArray(usbData.devices)) throw Error('USB destinations unreadable.');
  } catch (e) {
    if (!saveToCurrent(token)) return;
    status('USB destinations unavailable: ' + e.message + '. The current storage destination is unchanged.');
    usbData = null;
  }
  if (!saveToCurrent(token)) return;

  // Build options: default TLI location + each USB drive
  const sep = _savetoCurrentPath.includes("/") ? "/" : "\\";
  const options = [
    {
      name: "TLI Default",
      path: _savetoCurrentPath,
      free_gb: locData.free_gb,
      icon: "💻",
    },
  ];

  const drives = (usbData && usbData.devices) || [];
  for (const d of drives) {
    const mount = (d.mount_path || "").replace(/[\\/]+$/, "");
    if (!mount) continue;
    const aiPath = mount + (mount.includes("/") ? "/TLI_Models" : "\\TLI_Models");
    options.push({
      name: d.name || mount,
      path: aiPath,
      free_gb: d.size_bytes != null ? null : null, // size_bytes is total; skip for now
      icon: "💾",
    });
  }

  // Render picker items
  if (picker) {
    picker.innerHTML = options.map((opt, i) => {
      const isActive = opt.path === _savetoCurrentPath;
      const freeStr = opt.free_gb != null ? ` · ${opt.free_gb} GB free` : "";
      return `<button class="mm2-saveto-option${isActive ? " active" : ""}" data-saveto-path="${_esc(opt.path)}">
        <span class="mm2-saveto-opt-icon">${opt.icon}</span>
        <span class="mm2-saveto-opt-info">
          <div class="mm2-saveto-opt-name">${_esc(opt.name)}${freeStr}</div>
          <div class="mm2-saveto-opt-path">${_esc(opt.path)}</div>
        </span>
      </button>`;
    }).join("");
    _savetoHasOptions = true;

    picker.querySelectorAll(".mm2-saveto-option").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!saveToCurrent(token) || _savetoBusy) return;
        const newPath = btn.getAttribute("data-saveto-path");
        if (!newPath) return;
        btn.disabled = true; _savetoBusy = token;
        try {
          const d = await saveToRequest("/api/ai/storage/location", token, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: newPath }),
          });
          if (!saveToCurrent(token)) return;
          if (d.ok === true && typeof d.path === 'string' && d.path) {
            _savetoCurrentPath = d.path || newPath;
            pathEl.textContent = _savetoCurrentPath;
            if (freeEl) freeEl.textContent = "";
            // Refresh with updated free space
            setTimeout(() => { if (saveToCurrent(token)) loadSaveToPicker(); }, 200);
            if (picker) picker.classList.add("hidden");
          } else { throw Error('Storage change acknowledgement unreadable.'); }
        } catch (e) { if (saveToCurrent(token)) status('Storage change unconfirmed: ' + e.message + '. Check the current destination before trying again.'); }
        finally {
          if (_savetoBusy === token) _savetoBusy = false;
          if (saveToCurrent(token)) btn.disabled = false;
        }
      });
    });
  }

}

// Expose so mesh.js "Use for AI models" can refresh it after setting a path
window._tliRefreshSaveToPicker = loadSaveToPicker;


  async function open() {
    boot();
    if (!isOpen) returnFocus = document.activeElement;
    isOpen = true;
    el("model-manager-modal-overlay")?.classList.remove("hidden");
    el("model-manager-modal-overlay")?.setAttribute("aria-hidden", "false");
    (el('model-manager-x') || el('model-manager-close'))?.focus();
    status(""); await render(); loadSaveToPicker();
    try { if ((await api("/api/ai/model/progress")).in_progress) poll(); } catch (e) { status(e.message); }
  }
  window.tliOpenModelManagerModal = open;
  window._mm4RenderTierCards = render;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
