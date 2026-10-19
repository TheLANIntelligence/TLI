// home-power-devices.js — multi-vendor device library for TLI Home Automation

(function () {
  // Extra field definitions per vendor
  const VENDOR_EXTRA_FIELDS = {
    shelly: [
      { id: "relay", label: "Relay index", type: "number", placeholder: "0", hint: "0 = channel 1" },
    ],
    hue: [
      { id: "bridge_ip", label: "Bridge IP", type: "text", placeholder: "192.168.x.x", required: true },
      { id: "api_key",   label: "API Key",   type: "text", placeholder: "Hue bridge username/key", required: true },
      { id: "light_id",  label: "Light / Group ID", type: "text", placeholder: "1" },
      { id: "resource",  label: "Resource", type: "select", options: ["lights", "groups"], placeholder: "lights" },
    ],
    govee: [
      { id: "port", label: "UDP Port", type: "number", placeholder: "4003" },
    ],
    wled: [
      { id: "brightness", label: "Default brightness %", type: "number", placeholder: "100" },
    ],
    yeelight: [
      { id: "port", label: "TCP Port", type: "number", placeholder: "55443" },
    ],
    sonoff: [
      { id: "device_id", label: "Device ID", type: "text", placeholder: "Sonoff device ID" },
      { id: "port", label: "HTTP Port", type: "number", placeholder: "8081" },
    ],
    kasa: [
      { id: "port", label: "TCP Port", type: "number", placeholder: "9999" },
      { id: "plug_index", label: "Plug index (power strip)", type: "number", placeholder: "leave blank for single plug" },
    ],
    tuya: [
      { id: "device_id", label: "Device ID", type: "text", placeholder: "Tuya device ID", required: true },
      { id: "local_key", label: "Local Key", type: "text", placeholder: "Device local key", required: true },
      { id: "version",   label: "Protocol version", type: "select", options: ["3.3", "3.1", "3.4"], placeholder: "3.3" },
    ],
    generic_http: [
      { id: "url_on",     label: "URL — ON",     type: "text", placeholder: "http://device/on" },
      { id: "url_off",    label: "URL — OFF",     type: "text", placeholder: "http://device/off" },
      { id: "url_toggle", label: "URL — Toggle",  type: "text", placeholder: "http://device/toggle (optional)" },
      { id: "url_status", label: "URL — Status",  type: "text", placeholder: "http://device/status (optional)" },
      { id: "method",     label: "HTTP method",   type: "select", options: ["GET", "POST"] },
    ],
  };

  const VENDOR_CAPS = {
    shelly:       ["switch.on", "switch.off", "switch.toggle"],
    hue:          ["switch.on", "switch.off", "switch.toggle", "light.brightness"],
    govee:        ["switch.on", "switch.off", "switch.toggle", "light.brightness"],
    wled:         ["switch.on", "switch.off", "switch.toggle", "light.brightness"],
    yeelight:     ["switch.on", "switch.off", "switch.toggle", "light.brightness", "light.color"],
    sonoff:       ["switch.on", "switch.off", "switch.toggle"],
    kasa:         ["switch.on", "switch.off", "switch.toggle"],
    tuya:         ["switch.on", "switch.off", "switch.toggle", "light.brightness"],
    generic_http: ["switch.on", "switch.off", "switch.toggle"],
  };

  function _uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function _el(id) { return document.getElementById(id); }

  // ---------- render extra fields ----------
  function renderExtraFields(vendor) {
    const container = _el("hp-extra-fields");
    if (!container) return;
    const fields = VENDOR_EXTRA_FIELDS[vendor] || [];
    if (!fields.length) {
      container.style.display = "none";
      container.innerHTML = "";
      return;
    }
    container.style.display = "flex";
    container.innerHTML = fields.map(f => {
      if (f.type === "select") {
        const opts = (f.options || []).map(o => `<option value="${o}">${o}</option>`).join("");
        return `
          <div class="hp-extra-field">
            <label class="hp-extra-label">${f.label}</label>
            <select id="hp-ex-${f.id}" class="field-input" style="min-width:120px;">${opts}</select>
          </div>`;
      }
      return `
        <div class="hp-extra-field">
          <label class="hp-extra-label">${f.label}${f.required ? ' <span style="color:var(--accent)">*</span>' : ""}</label>
          <input id="hp-ex-${f.id}" type="${f.type}" class="field-input" placeholder="${f.placeholder || ""}" style="min-width:140px;" />
        </div>`;
    }).join("");
  }

  // ---------- collect extra values ----------
  function collectExtra(vendor) {
    const fields = VENDOR_EXTRA_FIELDS[vendor] || [];
    const extra = {};
    fields.forEach(f => {
      const el = _el(`hp-ex-${f.id}`);
      if (!el) return;
      const val = el.value.trim();
      if (val) extra[f.id] = f.type === "number" ? Number(val) : val;
    });
    return extra;
  }

  // ---------- API ----------
  let libraryAvailable = false, savingDevice = false, libraryRead = 0;

  async function hpRequest(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
    if (!data || typeof data !== 'object') throw new Error('The host returned an invalid response.');
    return data;
  }

  async function hpGetDevices() {
    const data = await hpRequest('/homepower/devices');
    if (!Array.isArray(data.devices)) throw new Error('The saved device library could not be read.');
    return data.devices;
  }

  async function hpSaveDevice(device) {
    const result = await hpRequest("/homepower/devices/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device }),
    });
    if (result.ok !== true) throw new Error('The host did not confirm that the device was saved.');
    return result;
  }

  async function hpDeleteDevice(device_id) {
    const result = await hpRequest(`/homepower/devices/${encodeURIComponent(device_id)}`, { method: "DELETE" });
    if (result.ok !== true) throw new Error('The host did not confirm that the device was removed.');
    return result;
  }

  async function hpGetStatus(device_id) {
    return hpRequest(`/homepower/devices/${encodeURIComponent(device_id)}/status`);
  }

  function libraryUnavailable(message) {
    libraryAvailable = false;
    const list = _el('hp-device-list');
    if (list) {
      list.textContent = 'Device library unavailable. ' + message + ' Refresh after resolving the problem before making changes.';
      list.setAttribute('role', 'status');
    }
    const add = _el('hp-add-btn'); if (add) add.disabled = true;
  }

  // ---------- render device list ----------
  function vendorLabel(v) {
    const labels = {
      shelly: "Shelly", hue: "Hue", govee: "Govee", wled: "WLED",
      yeelight: "Yeelight", sonoff: "Sonoff", kasa: "Kasa",
      tuya: "Tuya", generic_http: "Generic HTTP",
    };
    return labels[v] || v;
  }

  function renderDeviceList(devices) {
    const el = _el("hp-device-list");
    if (!el) return;
    if (!devices.length) {
      el.innerHTML = `<p class="sha-empty-state" style="margin-top:8px;">No devices in library yet. Add one above.</p>`;
      return;
    }
    el.innerHTML = devices.map(d => {
      const vid = d.vendor || "shelly";
      const badge = `<span class="hp-vendor-badge hp-vendor-badge--${vid}">${vendorLabel(vid)}</span>`;
      const caps = (d.capabilities || []).map(c => `<span class="hp-cap">${c}</span>`).join(" ");
      return `
        <div class="hp-device-row" data-device-id="${d.device_id}">
          <div class="hp-device-left">
            ${badge}
            <span class="hp-device-name">${escapeHtml(d.name || d.device_id)}</span>
            <span class="hp-device-ip">${escapeHtml(d.ip || "")}</span>
            <span class="hp-caps">${caps}</span>
          </div>
          <div class="hp-device-actions">
            <button class="pill-btn ghost hp-status-btn" data-device-id="${d.device_id}" title="Check status">Status</button>
            <button class="pill-btn ghost hp-delete-btn" data-device-id="${d.device_id}" title="Remove device" style="color:var(--text-muted);">Remove</button>
          </div>
        </div>`;
    }).join("");

    // Status buttons
    el.querySelectorAll(".hp-status-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        const id = btn.dataset.deviceId;
        btn.disabled = true;
        btn.textContent = "…";
        try {
          const st = await hpGetStatus(id);
          btn.textContent = st?.summary || (st?.ok === false ? "Status unavailable" : "?");
        } catch (error) {
          btn.textContent = 'Status unavailable';
          showToast('Device status unavailable: ' + error.message, 'error');
        } finally {
          btn.disabled = false;
          setTimeout(() => { btn.textContent = "Status"; }, 3000);
        }
      });
    });

    // Delete buttons
    el.querySelectorAll(".hp-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (btn.disabled || !libraryAvailable) return;
        const id = btn.dataset.deviceId;
        if (!confirm(`Remove device "${id}"?`)) return;
        btn.disabled = true;
        try {
          await hpDeleteDevice(id);
          await refreshDeviceList();
          showToast("Device removed.", "ok");
        } catch (error) {
          libraryRead++;
          libraryUnavailable(error.message);
          showToast('Device removal unconfirmed. ' + error.message + ' Refresh the library before trying again.', 'error');
        } finally { btn.disabled = false; }
      });
    });
  }

  async function refreshDeviceList() {
    const read = ++libraryRead;
    libraryAvailable = false;
    const add = _el('hp-add-btn'); if (add) add.disabled = true;
    const list = _el('hp-device-list'); if (list) list.textContent = 'Checking device library…';
    try {
      const devices = await hpGetDevices();
      if (read !== libraryRead) return;
      libraryAvailable = true;
      renderDeviceList(devices);
      if (add) add.disabled = savingDevice;
    } catch (error) {
      if (read === libraryRead) libraryUnavailable(error.message);
    }
  }

  // ---------- init ----------
  function init() {
    const vendorSel = _el("hp-vendor-select");
    const addBtn    = _el("hp-add-btn");
    const refreshBtn = _el("hp-refresh-btn");

    if (!vendorSel) return; // panel not in DOM

    // Initial extra fields
    renderExtraFields(vendorSel.value);

    vendorSel.addEventListener("change", () => {
      renderExtraFields(vendorSel.value);
    });

    if (addBtn) {
      addBtn.addEventListener("click", async () => {
        if (savingDevice || !libraryAvailable) return;
        const vendor = vendorSel.value;
        const ip     = (_el("hp-ip-input")?.value || "").trim();
        const name   = (_el("hp-name-input")?.value || "").trim();

        if (!ip) { showToast("Enter the device IP.", "info"); return; }

        const extra = collectExtra(vendor);
        const device_id = `${vendor}_${ip.replace(/\./g, "_")}_${_uid()}`;
        const caps = VENDOR_CAPS[vendor] || ["switch.on", "switch.off", "switch.toggle"];

        const device = {
          device_id,
          name: name || `${vendorLabel(vendor)} ${ip}`,
          vendor,
          ip,
          relay: vendor === "shelly" ? (Number(extra.relay) || 0) : 0,
          extra,
          capabilities: caps,
          room: null,
          tags: [],
        };

        addBtn.textContent = "Saving…";
        savingDevice = true;
        addBtn.disabled = true;
        try {
          const resp = await hpSaveDevice(device);
          if (resp.ok) {
            showToast(`Added ${device.name}`, "ok");
            _el("hp-ip-input").value = "";
            _el("hp-name-input").value = "";
            renderExtraFields(vendor);
            await refreshDeviceList();
          } else {
            showToast("Failed to add device.", "error");
          }
        } catch (e) {
          libraryRead++;
          libraryUnavailable(e.message);
          showToast("Device save unconfirmed. " + e.message + " Refresh the library before trying again.", "error");
        } finally {
          savingDevice = false;
          addBtn.textContent = "Add to Library";
          addBtn.disabled = !libraryAvailable;
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener("click", refreshDeviceList);
    }

    // Load on panel open
    const observer = new MutationObserver(() => {
      const panel = _el("panel-homeauto");
      if (panel && !panel.hidden) refreshDeviceList();
    });
    const panel = _el("panel-homeauto");
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });

    // Also load immediately in case panel is already visible
    refreshDeviceList();
  }

  // Run after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
