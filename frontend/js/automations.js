// TLI Automations Panel
(function () {
  const TRIGGER_KINDS = [
    { value: "presence.node_online",  label: "Node comes online",     group: "Presence" },
    { value: "presence.node_offline", label: "Node goes offline",     group: "Presence" },
    { value: "power.above",           label: "Power exceeds threshold",group: "Power"    },
    { value: "power.below",           label: "Power drops below threshold", group: "Power" },
    { value: "schedule.daily",        label: "Daily at a set time",   group: "Schedule" },
  ];

  let _caps = { devices: [] };
  let _hpDevices = [];   // from /homepower/devices
  let _meshNodes = [];
  let _bound = false;

  // ── helpers ───────────────────────────────────────────────────────

  function $a(id) { return document.getElementById(id); }

  function _kindLabel(type) {
    return (TRIGGER_KINDS.find(k => k.value === type) || {}).label || type;
  }

  function _fmt(isoStr) {
    if (!isoStr) return "—";
    try {
      const d = new Date(isoStr);
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch { return isoStr; }
  }

  function _setStatus(msg, isErr) {
    const el = $a("auto-status");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? "#e05c5c" : "var(--accent)";
    if (!isErr) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
  }

  // ── load data ─────────────────────────────────────────────────────

  async function _loadCaps() {
    try {
      const r = await fetch("/homepower/devices");
      if (r.ok) {
        const data = await r.json();
        _hpDevices = Array.isArray(data.devices) ? data.devices : [];
      }
    } catch {}
    // fallback: also load legacy shelly caps
    try {
      const r = await fetch("/actions/capabilities");
      if (r.ok) _caps = await r.json();
    } catch {}
    _populateDeviceDropdown();
  }

  async function _loadMeshNodes() {
    try {
      const r = await fetch("/api/lan/peers", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        _meshNodes = Array.isArray(d.peers) ? d.peers : [];
      }
    } catch {}
  }

  // ── form population ───────────────────────────────────────────────

  function _populateKindDropdown() {
    const sel = $a("auto-kind");
    if (!sel) return;
    // Group options
    const groups = {};
    for (const k of TRIGGER_KINDS) {
      if (!groups[k.group]) groups[k.group] = [];
      groups[k.group].push(k);
    }
    sel.innerHTML = "";
    for (const [grp, items] of Object.entries(groups)) {
      const og = document.createElement("optgroup");
      og.label = grp;
      for (const k of items) {
        const o = document.createElement("option");
        o.value = k.value;
        o.textContent = k.label;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
  }

  function _populateDeviceDropdown() {
    const sel = $a("auto-device");
    if (!sel) return;
    sel.innerHTML = "";

    // Prefer multi-vendor homepower devices
    if (_hpDevices.length) {
      for (const d of _hpDevices) {
        const o = document.createElement("option");
        // value encodes device_id + default capability
        o.value = JSON.stringify({ device_id: d.device_id, vendor: d.vendor, caps: d.capabilities || [] });
        const vendor = (d.vendor || "").toUpperCase();
        o.textContent = `[${vendor}] ${d.name || d.ip || d.device_id}`;
        sel.appendChild(o);
      }
      sel.addEventListener("change", _updateCapabilityDropdown);
      _updateCapabilityDropdown();
      return;
    }

    // Fallback: legacy shelly devices
    if (_caps.devices && _caps.devices.length) {
      for (const d of _caps.devices) {
        const o = document.createElement("option");
        o.value = JSON.stringify({ shelly_legacy: true, device: d.name || d.ip });
        o.textContent = `[SHELLY] ${d.name || d.ip}`;
        sel.appendChild(o);
      }
      return;
    }

    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No devices — add one in Home Automation";
    sel.appendChild(o);
  }

  function _updateCapabilityDropdown() {
    const sel = $a("auto-device");
    const capSel = $a("auto-capability");
    if (!capSel) return;
    capSel.innerHTML = "";

    let caps = ["switch.on", "switch.off", "switch.toggle"];
    try {
      const v = JSON.parse(sel?.value || "{}");
      if (Array.isArray(v.caps) && v.caps.length) caps = v.caps;
    } catch {}

    const capLabels = {
      "switch.on": "Turn ON", "switch.off": "Turn OFF", "switch.toggle": "Toggle",
      "light.brightness": "Set Brightness", "light.color": "Set Color",
    };
    for (const c of caps) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = capLabels[c] || c;
      capSel.appendChild(o);
    }
  }

  function _renderTriggerExtras(kind) {
    const box = $a("auto-trigger-extras");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = true;

    if (kind === "presence.node_online" || kind === "presence.node_offline") {
      box.hidden = false;
      box.innerHTML = `
        <div class="auto-extras-row">
          <div>
            <div class="field-label">Watch node</div>
            <select id="auto-ext-node" class="field-input">
              <option value="*">Any node</option>
              ${_meshNodes.map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name || n.id)}</option>`).join("")}
            </select>
          </div>
        </div>`;
    } else if (kind === "power.above" || kind === "power.below") {
      box.hidden = false;
      // Use homepower devices if available, fallback to legacy shelly caps
      const sensorList = _hpDevices.length
        ? _hpDevices.map(d => ({ label: `[${(d.vendor||"").toUpperCase()}] ${d.name || d.ip || d.device_id}`, value: d.device_id }))
        : (_caps.devices || []).map(d => ({ label: d.name || d.ip, value: d.name || d.ip }));
      const deviceOpts = sensorList.map(d =>
        `<option value="${escapeHtml(d.value)}">${escapeHtml(d.label)}</option>`).join("");
      box.innerHTML = `
        <div class="auto-extras-row">
          <div>
            <div class="field-label">Sensor device</div>
            <select id="auto-ext-sensor" class="field-input">${deviceOpts}</select>
          </div>
          <div>
            <div class="field-label">Threshold (W)</div>
            <input id="auto-ext-threshold" class="field-input" type="number" min="0" step="0.1" value="5" />
          </div>
        </div>`;
    } else if (kind === "schedule.daily") {
      box.hidden = false;
      const days = ["mon","tue","wed","thu","fri","sat","sun"];
      const dayLabels = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
      box.innerHTML = `
        <div class="auto-extras-row">
          <div>
            <div class="field-label">Time (HH:MM)</div>
            <input id="auto-ext-time" class="field-input" type="time" value="08:00" />
          </div>
          <div>
            <div class="field-label">Days</div>
            <div class="auto-day-checks">
              ${days.map(d => `
                <label class="auto-day-check">
                  <input type="checkbox" value="${d}" checked />
                  ${dayLabels[d]}
                </label>`).join("")}
            </div>
          </div>
        </div>`;
    }
  }

  // ── create automation ─────────────────────────────────────────────

  function _collectTrigger(kind) {
    const base = {
      type: kind,
      cooldown_sec: parseInt($a("auto-cooldown")?.value || "30", 10),
    };
    if (kind === "presence.node_online" || kind === "presence.node_offline") {
      base.node_id = $a("auto-ext-node")?.value || "*";
    } else if (kind === "power.above" || kind === "power.below") {
      base.device = $a("auto-ext-sensor")?.value || "";
      base.threshold_w = parseFloat($a("auto-ext-threshold")?.value || "5");
    } else if (kind === "schedule.daily") {
      base.time = $a("auto-ext-time")?.value || "08:00";
      base.days = Array.from(document.querySelectorAll(".auto-day-check input:checked")).map(cb => cb.value);
    }
    return base;
  }

  async function _createAutomation(enabled) {
    const kind = $a("auto-kind")?.value;
    const name = ($a("auto-name")?.value || "").trim();
    const deviceRaw = $a("auto-device")?.value;
    const capability = $a("auto-capability")?.value || "switch.on";

    if (!kind) { _setStatus("Pick a trigger type.", true); return; }
    if (!deviceRaw) { _setStatus("Pick a control device.", true); return; }

    const trigger = _collectTrigger(kind);
    trigger.enabled = enabled;

    let step, stepLabel;
    try {
      const dv = JSON.parse(deviceRaw);
      if (dv.shelly_legacy) {
        step = { type: "shelly.switch", device: dv.device, value: capability === "switch.off" ? "off" : "on" };
        stepLabel = `${dv.device} ${step.value}`;
      } else {
        step = { type: "homepower.execute", device_id: dv.device_id, capability };
        stepLabel = `${dv.device_id} → ${capability}`;
      }
    } catch {
      _setStatus("Invalid device selection.", true); return;
    }

    const payload = {
      name: name || `${_kindLabel(kind)} → ${stepLabel}`,
      steps: [step],
      trigger,
    };

    try {
      const r = await fetch("/actions/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      _setStatus("Automation created.");
      $a("auto-name").value = "";
      await _renderList();
      await _renderReceipts();
    } catch (e) {
      _setStatus("Failed: " + e.message, true);
    }
  }

  // ── render active list ────────────────────────────────────────────

  async function _renderList() {
    const box = $a("auto-rows");
    if (!box) return;
    let store;
    try {
      const r = await fetch("/actions/list");
      store = r.ok ? await r.json() : {};
    } catch { store = {}; }

    const actions = store.actions || [];
    const triggers = store.triggers || [];

    if (!triggers.length) {
      box.innerHTML = `<div class="table-row auto-row" style="opacity:.6;grid-template-columns:1fr"><div>No automations yet.</div></div>`;
      return;
    }

    box.innerHTML = "";
    for (const t of triggers) {
      const action = actions.find(a => a.id === t.action_id) || {};
      const steps = action.steps || [];
      const stepDesc = steps.map(s => `${s.device} → ${s.value}`).join(", ") || "—";
      const enabled = t.enabled !== false;
      const lastFired = t.last_fired ? _fmt(new Date(t.last_fired * 1000).toISOString()) : "Never";

      let triggerDesc = _kindLabel(t.type);
      if (t.node_id && t.node_id !== "*") {
        const n = _meshNodes.find(x => x.id === t.node_id);
        triggerDesc += ` · ${n ? n.name : t.node_id}`;
      } else if (t.node_id === "*") {
        triggerDesc += " · Any node";
      }
      if (t.device && (t.type === "power.above" || t.type === "power.below")) {
        triggerDesc += ` · ${t.device} ${t.threshold_w}W`;
      }
      if (t.type === "schedule.daily" && t.time) {
        triggerDesc += ` · ${t.time}`;
      }

      const row = document.createElement("div");
      row.className = "table-row auto-row";
      row.innerHTML = `
        <div class="auto-toggle">
          <label class="auto-switch" title="${enabled ? "Enabled — click to disable" : "Disabled — click to enable"}">
            <input type="checkbox" ${enabled ? "checked" : ""} data-tid="${escapeHtml(t.id)}" class="auto-toggle-cb" />
            <span class="auto-switch-slider"></span>
          </label>
        </div>
        <div><span class="auto-pill">${escapeHtml(triggerDesc)}</span></div>
        <div style="font-size:12.5px">${escapeHtml(action.name || stepDesc)}</div>
        <div style="font-size:12px;opacity:.7">${escapeHtml(String(t.cooldown_sec || 30))}s</div>
        <div style="font-size:12px;opacity:.7">${escapeHtml(lastFired)}</div>
        <div class="auto-actions-cell">
          <button class="auto-linkbtn" data-del="${escapeHtml(t.id)}" title="Delete">✕</button>
        </div>
      `;
      box.appendChild(row);
    }

    // Wire toggle + delete
    box.querySelectorAll(".auto-toggle-cb").forEach(cb => {
      cb.addEventListener("change", async () => {
        await fetch(`/triggers/${encodeURIComponent(cb.dataset.tid)}/toggle`, { method: "PATCH" });
        await _renderList();
      });
    });
    box.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this automation?")) return;
        await fetch(`/triggers/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" });
        await _renderList();
      });
    });
  }

  // ── receipts ──────────────────────────────────────────────────────

  async function _renderReceipts() {
    const box = $a("auto-receipts");
    if (!box) return;
    let items = [];
    try {
      const r = await fetch("/actions/receipts?limit=12");
      if (r.ok) items = (await r.json()).items || [];
    } catch {}

    if (!items.length) {
      box.innerHTML = `<div style="opacity:.5;font-size:12px">No receipts yet.</div>`;
      return;
    }

    box.innerHTML = items.slice().reverse().map(item => `
      <div class="auto-receipt">
        <div class="top">
          <span class="kind">${escapeHtml(item.kind || "—")}</span>
          <span class="ts">${escapeHtml(_fmt(item.ts))}</span>
        </div>
        <div>${escapeHtml(item.summary || "")}</div>
      </div>
    `).join("");
  }

  // ── bind UI once ──────────────────────────────────────────────────

  function _bindUI() {
    if (_bound) return;
    _bound = true;

    const kindSel = $a("auto-kind");
    if (kindSel) {
      kindSel.addEventListener("change", () => _renderTriggerExtras(kindSel.value));
    }

    const btnCreate = $a("auto-create");
    const btnDisabled = $a("auto-create-disabled");
    if (btnCreate) btnCreate.addEventListener("click", () => _createAutomation(true));
    if (btnDisabled) btnDisabled.addEventListener("click", () => _createAutomation(false));
  }

  // ── public API ────────────────────────────────────────────────────

  window.TLIAutomations = {
    async onOpen() {
      _bindUI();
      _populateKindDropdown();
      await Promise.all([_loadCaps(), _loadMeshNodes()]);
      const kindSel = $a("auto-kind");
      if (kindSel) _renderTriggerExtras(kindSel.value);
      await _renderList();
      await _renderReceipts();
    },
  };
})();
