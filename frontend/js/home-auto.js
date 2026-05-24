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
    container.innerHTML = `<p class="sha-empty-state">No devices yet. Click <strong>Discover</strong> to scan your LAN, or enter an IP manually.</p>`;
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

async function discoverShellyDevices() {
  const btn = $("shelly-discover-btn");
  const orig = btn?.textContent || "Discover";

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Scanning...";
  }

  try {
    showToast("Scanning your LAN for Shelly devices...", "info");
    const res = await fetch("/shelly/discover");
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j.detail || "";
      } catch {
        detail = await res.text();
      }
      if (res.status === 404) {
        throw new Error("Discovery endpoint is not loaded yet. Restart TLI, then try Discover again.");
      }
      throw new Error(detail || "HTTP " + res.status);
    }

    const data = await res.json();
    const found = Array.isArray(data.found) ? data.found : [];
    if (!found.length) {
      showToast(`No Shelly devices found on ${data.subnet || "this subnet"}.`, "info");
      return;
    }

    let added = 0;
    found.forEach((device) => {
      const ip = String(device.ip || "").trim();
      if (!ip) return;
      const existingName = (shellyDevices?.[ip]?.name || "").trim();
      const discoveredName = String(device.name || device.model || "Shelly").trim();
      upsertShellyDevice(ip, {
        ip,
        name: existingName || discoveredName,
        status: shellyDevices?.[ip]?.status || null,
        discovered: {
          model: device.model || null,
          app: device.app || null,
          gen: device.gen || null,
          ver: device.ver || null,
        },
      });
      added += 1;
    });

    saveShellyDevicesToStorage();
    syncShellyRegistry();

    const firstIp = String(found[0]?.ip || "").trim();
    if (firstIp) setSelectedShellyIp(firstIp);

    renderAllShellyCards();
    await fetchAllShellyStatuses(true);
    startShellyAutoRefresh();

    showToast(`Found ${added} Shelly device${added === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    console.error("[Shelly] discovery failed:", err);
    showToast("Shelly discovery failed: " + (err?.message || "unknown error"), "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
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

  const discoverBtn = $("shelly-discover-btn");
  if (discoverBtn) {
    discoverBtn.addEventListener("click", () => {
      discoverShellyDevices();
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

