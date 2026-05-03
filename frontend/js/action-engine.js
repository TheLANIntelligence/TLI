// TLI Action Engine (Home Auto UI)
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
    if (!state.devices || !state.devices.length) meta.textContent = "No devices loaded yet — add in Home Automation";
    else meta.textContent = state.devices.length + " device(s) ready";
  }

  const _CAP_LABELS = {
    “switch.on”: “Turn ON”, “switch.off”: “Turn OFF”, “switch.toggle”: “Toggle”,
    “light.brightness”: “Set Brightness”, “light.color”: “Set Color”,
  };

  function _renderDevicePicker(show){
    const box = _el(“uae-device-picker”);
    if (!box) return;

    if (!show){
      box.style.display = “none”;
      box.innerHTML = “”;
      return;
    }

    box.style.display = “”;
    if (!state.devices || !state.devices.length){
      box.innerHTML = `<div class=”muted”>No devices found. Add devices in Home Automation → Device Library, then press “Load devices”.</div>`;
      return;
    }

    box.innerHTML = state.devices.map((d, i) => {
      const name = _safe(d.name) || _safe(d.ip) || (“Device “ + (i+1));
      const ip = _safe(d.ip);
      const vendor = (_safe(d.vendor) || “shelly”).toUpperCase();
      const caps = Array.isArray(d.capabilities) && d.capabilities.length
        ? d.capabilities
        : [“switch.on”, “switch.off”, “switch.toggle”];
      const capOpts = caps.map(c => `<option value=”${c}”>${_CAP_LABELS[c] || c}</option>`).join(“”);

      return `
        <div class=”uae-pick-row” data-device-index=”${i}”>
          <div class=”uae-pick-left”>
            <input type=”checkbox” class=”uae-pick-check” data-idx=”${i}” />
            <div>
              <div class=”uae-pick-name”><span class=”hp-vendor-badge hp-vendor-${_safe(d.vendor)||'shelly'}”>${vendor}</span> ${name}</div>
              <div class=”uae-pick-meta”>${ip ? (“IP “ + ip) : “”}</div>
            </div>
          </div>
          <select class=”uae-select uae-pick-action” data-idx=”${i}”>${capOpts}</select>
        </div>
      `;
    }).join(“”);
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
    // Primary: multi-vendor homepower device library
    try {
      const data = await _fetchJson("/homepower/devices");
      if (Array.isArray(data?.devices) && data.devices.length) {
        state.devices = data.devices;
        _renderDevicesMeta();
        return;
      }
    } catch {}
    // Fallback: legacy shelly registry
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

      const capability = sel.value || "switch.on";

      if (d.device_id) {
        // Multi-vendor homepower device
        steps.push({ type: "homepower.execute", device_id: d.device_id, capability });
      } else {
        // Legacy shelly (from /system/capabilities fallback)
        const devQuery = (d.name || d.ip || "").toString();
        const val = capability === "switch.off" ? "off" : "on";
        steps.push({ type: "shelly.switch", device: devQuery, value: val });
      }
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
