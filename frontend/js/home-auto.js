// ---------- Home Automation: Shelly (Phase 1) ----------
// ---------- Shelly multi-device storage ----------
const shellyDevicesStorageKey = "tli_shelly_devices_v1"; // NEW (multi-device)
// 🔒 UI lock: prevents card re-render during inline rename
let shellyRenameLock = false;

const shellyCommands = new Set();
const shellyReads = new Map();
const shellyRevisions = new Map();
const shellySelectedRelayStorageKey = "tli_shelly_selected_relay_v1";
const shellySelectedIpStorageKey = "tli_shelly_selected_ip_v1";
let shellyAutoTimer = null, shellyAgeTimer = null, shellyAutoEpoch = 0, lastShellyStatus = null;
let shellyPanelBound = false;
let shellyHostLoad = null;
let shellyCycle = null;
let shellyRenderedFreshness = new Map();
// Room/name context is user-entered metadata, never evidence of device state.
let shellyRoomContext = new Map();
let shellyAuthEpoch = 0, shellyLocked = false, shellyAccessReady = true, shellyVerifiedSession = false;
let shellyReloadHost = null;
let shellyRegistryReady = false, shellyRegistryMessage = 'Loading the host device registry…', shellyRegistryReadEpoch = 0, shellyRegistryWrite = null;
const shellyControlIds = ['shelly-add-device-btn', 'shelly-discover-btn', 'shelly-status-btn', 'shelly-on-btn', 'shelly-off-btn', 'shelly-import-cache-btn'];
function shellyCurrent(epoch = shellyAuthEpoch) { return epoch === shellyAuthEpoch && !shellyLocked && shellyAccessReady; }
function shellyCheck(epoch) { if (!shellyCurrent(epoch)) throw new Error('Smart-device access changed. Unlock TLI, then review current status before trying again.'); }
function shellyControlAccess() {
  for (const id of shellyControlIds) if ($(id)) $(id).disabled = !shellyCurrent() || (id !== 'shelly-status-btn' && (!shellyRegistryReady || !!shellyRegistryWrite));
  if ($('shelly-refresh-all-btn')) $('shelly-refresh-all-btn').disabled = shellyLocked || !!shellyRegistryWrite;
}
function shellyRegistryUnavailable(message) {
  shellyRegistryReady = false; shellyRegistryMessage = message; shellyRegistryReadEpoch++;
  stopShellyAutoRefresh(); shellyControlAccess(); renderAllShellyCards();
}
function shellyRegistryCheck(epoch) {
  shellyCheck(epoch);
  if (!shellyRegistryReady || shellyRegistryWrite) throw new Error('Host registry unavailable or a save is pending. Use Refresh All to verify it before saving changes.');
}
function shellySavedRegistryCheck(result, epoch) {
  shellyCheck(epoch);
  if (!shellyRegistryReady || shellyRegistryWrite || result?._registryEpoch !== shellyRegistryReadEpoch) throw new Error('The host registry changed after the save response. Refresh it before reviewing the saved changes.');
}
function shellyRegistryRows(rows) {
  if (!Array.isArray(rows)) throw new Error('The host returned no valid device registry.');
  const keys = new Set();
  return rows.map(row => {
    const ip = row?.ip ?? row?.host;
    if (!row || typeof row !== 'object' || typeof ip !== 'string' || !ip.trim() || row.name != null && typeof row.name !== 'string' ||
        row.relay != null && (!Number.isInteger(row.relay) || row.relay < 0 || row.relay > 255)) throw new Error('The host returned an invalid device registry.');
    const key = shellyKey(ip, row.relay ?? 0);
    if (keys.has(key)) throw new Error('The host returned duplicate device targets.');
    keys.add(key);
    // Legacy host-only rows get a view alias; the returned host data is not
    // mutated or implicitly written back as a registry migration.
    return {...row, ip};
  });
}
function clearShellyPrivateView(message) {
  stopShellyAutoRefresh(); shellyReads.clear(); shellyCommands.clear(); shellyRevisions.clear();
  shellyHostLoad = null; shellyCycle = null; shellyRoomContext.clear(); shellyRenderedFreshness.clear(); lastShellyStatus = null;
  shellyRegistryReady = false; shellyRegistryReadEpoch++; shellyRegistryWrite = null;
  Object.keys(shellyDevices).forEach(key => delete shellyDevices[key]);
  // Saved browser records are preserved; they are not rendered again on unlock.
  for (const id of ['shellyCards', 'shelly-status-raw', 'shelly-status-summary', 'shelly-device-meta', 'shelly-name-label']) if ($(id)) $(id).textContent = '';
  for (const id of ['shelly-ip-input', 'shelly-name-input', 'shelly-relay-input']) if ($(id)) $(id).value = '';
  if ($('shelly-status-pill')) $('shelly-status-pill').textContent = 'Access unavailable';
  if ($('shellyCards')) $('shellyCards').textContent = message;
  setHomeAutoHealth('degraded', message); shellyControlAccess();
}
window.addEventListener?.('tli-session-locked', () => {
  shellyLocked = true; shellyAccessReady = false; shellyVerifiedSession = false; shellyAuthEpoch++;
  clearShellyPrivateView('Unlock TLI to view smart devices.');
});
window.addEventListener?.('tli-session-unlocked', event => {
  const verified = event?.detail?.source === 'pin-verification';
  if (!shellyLocked && (!verified || shellyVerifiedSession)) return;
  shellyLocked = false; shellyAccessReady = false; if (verified) shellyVerifiedSession = true;
  shellyAuthEpoch++; clearShellyPrivateView('Waiting for verified access. Use Refresh All to recheck access.');
});
window.addEventListener?.('tli-private-observation-ready', () => {
  if (shellyLocked || shellyAccessReady) return;
  shellyAccessReady = true; shellyControlAccess();
  if (shellyReloadHost) {
    const epoch = shellyAuthEpoch, pending = shellyReloadHost(); shellyHostLoad = pending;
    pending.then(() => {
      if (shellyCurrent(epoch) && $('panel-homeauto')?.hidden === false) startShellyAutoRefresh();
    });
  }
});
function shellyReadingFresh(d) { return !!(d.status?.checkedAt && Date.now() - d.status.checkedAt <= 30000 && !d.statusError); }

function shellyKey(ip, relay = 0) { return `${String(ip).trim().toLowerCase()}#${relay}`; }
function shellyTarget(ip, relay = null) {
  ip = String(ip || '').trim();
  if (!ip) throw new Error('Enter a Shelly address first.');
  const matches = Object.values(shellyDevices).filter(d => d.ip.toLowerCase() === ip.toLowerCase());
  if (relay == null) {
    const relays = [...new Set(matches.map(d => d.relay))];
    if (relays.length > 1) throw new Error('This address has multiple relays. Choose a relay explicitly.');
    relay = relays[0] ?? 0;
  }
  if (!Number.isInteger(Number(relay)) || Number(relay) < 0 || Number(relay) > 255 || relay === '') throw new Error('Enter a relay index from 0 to 255.');
  return {ip, relay:Number(relay), key:shellyKey(ip, Number(relay))};
}
function loadShellyDevicesFromStorage() {
  if (!shellyCurrent()) return;
  try {
    const saved = JSON.parse(localStorage.getItem(shellyDevicesStorageKey) || '{}');
    Object.keys(shellyDevices).forEach(k => delete shellyDevices[k]);
    for (const [key, d] of Object.entries(saved || {})) {
      if (!d || typeof d !== 'object') continue;
      const target = shellyTarget(d.ip || key, d.relay ?? 0);
      // A browser cache is not evidence of the host's current relay state.
      shellyDevices[target.key] = {...d, ...target, status:null, statusError:null, commandResult:''};
    }
  } catch (e) { console.warn('Shelly cache unavailable:', e); }
}
function saveShellyDevicesToStorage() {
  if (!shellyRegistryReady || shellyRegistryWrite) return;
  try { localStorage.setItem(shellyDevicesStorageKey, JSON.stringify(shellyDevices)); } catch {}
}
function upsertShellyDevice(ip, patch = {}) {
  if (!shellyCurrent()) return null;
  const target = shellyTarget(ip, patch.relay ?? null);
  const old = shellyDevices[target.key] || {name:'', status:null};
  shellyDevices[target.key] = {...old, ...patch, ...target, updatedAt:new Date().toISOString()};
  saveShellyDevicesToStorage();
  return shellyDevices[target.key];
}
function getSelectedShellyIp() {
  try { return localStorage.getItem(shellySelectedIpStorageKey)?.trim() || null; } catch { return null; }
}
function setSelectedShellyIp(ip, relay = null) {
  if (!shellyCurrent()) return;
  const target = shellyTarget(ip, relay);
  try {
    localStorage.setItem(shellySelectedIpStorageKey, target.ip);
    localStorage.setItem(shellySelectedRelayStorageKey, String(target.relay));
  } catch {}
  if ($('shelly-ip-input')) $('shelly-ip-input').value = target.ip;
  if ($('shelly-relay-input')) $('shelly-relay-input').value = String(target.relay);
  if ($('shelly-name-input')) $('shelly-name-input').value = shellyDevices[target.key]?.name || '';
}
function readShellyTarget() {
  const ip = $('shelly-ip-input')?.value.trim() || getSelectedShellyIp();
  return shellyTarget(ip, $('shelly-relay-input')?.value ?? null);
}
async function shellyRequest(url, options = {}, epoch = shellyAuthEpoch) {
  shellyCheck(epoch);
  const response = await fetch(url, {credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(45000), ...options});
  const data = await response.json().catch(() => null);
  shellyCheck(epoch);
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent?.(new CustomEvent('tli-session-locked'));
    window.TLIPinLock?.checkAndLock();
  }
  if (!data || typeof data !== 'object') throw new Error('Smart-device response is unavailable.');
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
  return data;
}
function buildShellySnapshotFromPayload(ip, payload, relay = 0) {
  const raw = payload?.raw;
  const sw = raw?.[`switch:${relay}`];
  const valid = payload?.ok !== false && raw && !('error' in raw) && !('code' in raw) && !('text' in raw) && typeof sw?.output === 'boolean';
  const metric = key => valid && Number.isFinite(sw[key]) ? sw[key] : null;
  return {ip, relay, isOn:valid ? sw.output : null, power:metric('apower'), voltage:metric('voltage'), current:metric('current'),
    temperature:valid && Number.isFinite(sw?.temperature?.tC) ? sw.temperature.tC : null,
    checkedAt:valid ? Date.now() : null};
}
function startShellyAutoRefresh() {
  if (!shellyCurrent() || !shellyRegistryReady || shellyAutoTimer !== null) return;
  const epoch = ++shellyAutoEpoch;
  const age = () => {
    if (epoch !== shellyAutoEpoch) return;
    if (Object.values(shellyDevices).some(d => shellyReadingFresh(d) !== shellyRenderedFreshness.get(d.key))) renderAllShellyCards();
    shellyAgeTimer = window.setTimeout(age, 1000);
  };
  shellyAgeTimer = window.setTimeout(age, 1000);
  const tick = async () => {
    if (epoch !== shellyAutoEpoch) return;
    await fetchAllShellyStatuses(true);
    if (epoch === shellyAutoEpoch) shellyAutoTimer = window.setTimeout(tick, 5000);
  };
  shellyAutoTimer = window.setTimeout(tick, 0);
}
function stopShellyAutoRefresh() {
  shellyAutoEpoch++;
  if (shellyAutoTimer !== null) window.clearTimeout(shellyAutoTimer);
  if (shellyAgeTimer !== null) window.clearTimeout(shellyAgeTimer);
  shellyAutoTimer = null;
  shellyAgeTimer = null;
}

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
async function loadShellyHostRegistry(epoch = shellyAuthEpoch) {
  shellyCheck(epoch);
  if (shellyRegistryWrite) throw new Error('A registry save is still pending. Wait before refreshing.');
  const request = ++shellyRegistryReadEpoch;
  shellyRegistryReady = false; shellyRegistryMessage = 'Loading the host device registry…';
  stopShellyAutoRefresh(); shellyControlAccess(); renderAllShellyCards();
  try {
  const [data, context] = await Promise.all([
    shellyRequest('/homeauto/devices', {}, epoch),
    shellyRequest('/api/intelligence/devices', {}, epoch).catch(() => null),
  ]);
  shellyCheck(epoch);
  if (request !== shellyRegistryReadEpoch) throw new Error('A newer registry check replaced this response.');
  const devices = shellyRegistryRows(data.devices);
  if (Array.isArray(context?.devices)) {
    const nextContext = new Map();
    for (const d of context.devices) {
      if (d.kind === 'smart_device' && d.vendor === 'shelly' && d.address) {
        nextContext.set(shellyKey(d.address, d.relay ?? 0), d);
      }
    }
    shellyRoomContext = nextContext;
  }
  const next = {};
  for (const d of devices) {
    const target = shellyTarget(d.ip, d.relay ?? 0);
    const old = shellyDevices[target.key];
    next[target.key] = {...d, ...target, status:old?.status || null,
      statusError:old?.statusError || null, commandResult:old?.commandResult || ''};
  }
  Object.keys(shellyDevices).forEach(k => delete shellyDevices[k]);
  Object.assign(shellyDevices, next);
  shellyRegistryReady = true; shellyRegistryMessage = '';
  saveShellyDevicesToStorage(); shellyControlAccess(); renderAllShellyCards();
  } catch (error) {
    if (request !== shellyRegistryReadEpoch) error.shellyObsolete = true;
    if (shellyCurrent(epoch) && request === shellyRegistryReadEpoch) shellyRegistryUnavailable('Host registry unavailable. ' + error.message + ' Saved browser records are preserved. Use Refresh All after recovery.');
    throw error;
  }
}
async function syncShellyRegistry(changes = null, epoch = shellyAuthEpoch) {
  shellyRegistryCheck(epoch);
  const devices = changes || Object.values(shellyDevices);
  if (!devices.length) return;
  const write = {}; shellyRegistryWrite = write; const registry = ++shellyRegistryReadEpoch; shellyControlAccess();
  try {
  const result = await shellyRequest('/homeauto/devices', {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({merge:true, devices:devices.map(d => ({ip:d.ip, relay:d.relay ?? 0, name:d.name || ''}))})}, epoch);
  if (result.ok !== true || !Number.isInteger(result.count) || !Array.isArray(result.devices) || result.count !== result.devices.length) throw new Error('The host did not confirm a complete registry save.');
  const saved = shellyRegistryRows(result.devices);
  if (!devices.every(device => saved.some(row => shellyKey(row.ip, row.relay ?? 0) === shellyKey(device.ip, device.relay ?? 0) && String(row.name || '') === String(device.name || '')))) throw new Error('The host did not confirm the requested device changes.');
  return {...result, _registryEpoch:registry};
  } catch (error) {
    if (shellyCurrent(epoch)) {
      const message = 'Registry save unconfirmed. ' + error.message + ' Saved browser records are preserved. Refresh the host registry before trying again; no save will retry automatically.';
      shellyRegistryUnavailable(message);
      throw new Error(message);
    }
    throw error;
  } finally { if (shellyRegistryWrite === write) { shellyRegistryWrite = null; if (shellyCurrent(epoch)) shellyControlAccess(); } }
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

async function commitShellyInlineRename(cardEl, ip, relay = null) {
  if (!shellyCurrent() || !shellyRegistryReady || !cardEl || cardEl.dataset.saving === 'true') return;
  const epoch = shellyAuthEpoch;
  const name = cardEl.querySelector('[data-shelly-name-input]')?.value.trim();
  if (!name) { showToast("Name can't be empty.", 'warn'); return; }
  cardEl.dataset.saving = 'true';
  try {
    const target = shellyTarget(ip, relay);
    const saved = await syncShellyRegistry([{...target, name}], epoch);
    shellySavedRegistryCheck(saved, epoch);
    upsertShellyDevice(ip, {relay:target.relay, name});
    showToast(`Saved name: ${name} (${ip}, relay ${target.relay})`, 'ok');
    cardEl.classList.remove('is-renaming'); renderAllShellyCards();
  } catch (e) { if (shellyCurrent(epoch)) showToast('Name save unconfirmed: ' + e.message, 'error'); }
  finally { cardEl.dataset.saving = 'false'; }
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

// Decoration only: a familiar name selects fixed artwork, never capabilities,
// permissions, state, or an action. Unknown names keep the neutral plug.
function shellyDeviceArtwork(name) {
  const label = String(name || '').toLowerCase();
  let path = '<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-6 6v4M12 17a6 6 0 0 1-6-6"/>';
  if (/\b(hdd|ssd|hard[ -]?drive|storage|disk)\b/.test(label)) {
    path = '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M3 14h18M7 17h.01M11 17h.01"/>';
  } else if (/\b(psvr\d*|playstation|xbox|console|gamepad|vr)\b/.test(label)) {
    path = '<path d="M6 7h12a3 3 0 0 1 3 2.5l1 7a2 2 0 0 1-3.4 1.7L15 15H9l-3.6 3.2A2 2 0 0 1 2 16.5l1-7A3 3 0 0 1 6 7Z"/><path d="M7 9v5M4.5 11.5h5M16 10h.01M18 13h.01"/>';
  } else if (/\b(lamp|light|lighting|bulb)\b/.test(label)) {
    path = '<path d="M8 17h8M9 21h6M8 13a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z"/>';
  } else if (/\b(fan|ventilator)\b/.test(label)) {
    path = '<circle cx="12" cy="12" r="2"/><path d="M10.4 10.8C5 9 7 3 10 3s3 4 2 7M13.7 11c4-4 8 1 6.5 3.5s-5 .4-7-1M11.6 14c1 5.6-5.4 6.5-6.9 4s2.2-4.5 5.6-5"/>';
  }
  return '<span class="sha-device-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + path + '</svg></span>';
}

function renderAllShellyCards() {
  if (!shellyCurrent()) return;
  const container = $("shellyCards");
  if (!container) return;
  if (!shellyRegistryReady) {
    container.textContent = shellyRegistryMessage;
    setHomeAutoHealth('degraded', shellyRegistryMessage);
    return;
  }

  if (isShellyInlineRenamingActive()) return;
  const openedDetails = new Set();
  for (const card of container.querySelectorAll('.shelly-device-card')) {
    if (card.querySelector('.sha-device-details')?.open) openedDetails.add(shellyKey(card.dataset.ip, card.dataset.relay));
  }
  const focused = document.activeElement;
  const focusedCard = focused?.closest?.('.shelly-device-card');
  const focusKey = focusedCard ? shellyKey(focusedCard.dataset.ip, focusedCard.dataset.relay) : null;
  const focusControl = focused?.dataset?.shaControl || null;
  container.innerHTML = "";
  shellyRenderedFreshness = new Map();

  const roomFor = d => String(shellyRoomContext.get(d.key)?.room || d.room || '').trim();
  const nameFor = d => String(d.name || shellyRoomContext.get(d.key)?.name || 'Shelly').trim() || 'Shelly';
  const devices = Object.values(shellyDevices || {}).filter((d) => d && d.ip).sort((a, b) => {
    const ar = roomFor(a), br = roomFor(b);
    return Number(!ar) - Number(!br) || ar.localeCompare(br) || nameFor(a).localeCompare(nameFor(b)) || a.key.localeCompare(b.key);
  });

  if (!devices.length) {
    setHomeAutoHealth("degraded", "Home Automation not configured yet.");
    container.innerHTML = `<p class="sha-empty-state">No devices yet. Click <strong>Discover</strong> to scan your LAN, or enter an IP manually.</p>`;
    return;
  }

  let anyOn = false, anyOff = false, anyUnknown = false;
  let currentRoom = null, roomCards = null;

  devices.forEach((device) => {
    const ip = String(device.ip || "").trim();
    if (!ip) return;

    const name = nameFor(device);
    const relay = device.relay ?? 0;
    const key = shellyKey(ip, relay);
    const observed = device.status;
    const fresh = shellyReadingFresh(device);
    shellyRenderedFreshness.set(key, fresh);
    const s = fresh ? observed : null;
    const pending = shellyCommands.has(key);
    const room = roomFor(device);
    if (currentRoom !== room || !roomCards) {
      currentRoom = room;
      const group = document.createElement('section'); group.className = 'sha-room';
      const heading = document.createElement('h3'); heading.className = 'sha-room-heading';
      heading.textContent = room || 'Not assigned to a room';
      group.appendChild(heading);
      roomCards = document.createElement('div'); roomCards.className = 'sha-room-devices';
      group.appendChild(roomCards); container.appendChild(group);
    }

    // Missing or stale observations never imply that the relay is OFF.
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

    const lastChecked = device.statusError ? 'Status unavailable · ' + device.statusError :
      observed?.checkedAt ? `${fresh ? 'Last checked' : 'Stale reading'}: ${_shellyAgo(observed.checkedAt)}` : 'Not yet checked';

    const card = document.createElement("div");
    card.className = `card-section shelly-device-card sha-card ${cardState}`;
    card.dataset.ip = ip;
    card.dataset.relay = String(relay);
    card.dataset.pending = String(pending);
    const powerLabel = pending ? 'Checking…' : isOn ? 'Turn off' : isOff ? 'Turn on' : 'Check state';
    const stateLabel = pending ? 'Updating device' : isOn ? 'On · verified' : isOff ? 'Off · verified' : device.statusError ? 'State unavailable' : observed?.checkedAt ? 'Reading expired' : 'Not checked yet';

    card.innerHTML = `
      <div class="sha-card-header">
        <div class="sha-card-left">
          ${shellyDeviceArtwork(name)}
          <span class="sha-dot sha-dot--${dotClass}" aria-hidden="true"></span>
          <div class="sha-card-name-wrap">
            <span class="shelly-card-name sha-card-name" data-shelly-name>${escapeHtml(name)}</span>
            <input class="shelly-rename-input" data-shelly-name-input type="text" value="${escapeHtml(name)}" style="display:none;" />
            <button class="btn-icon shelly-rename-btn" data-sha-control="rename" type="button" title="Rename device" aria-label="Rename ${escapeHtml(name)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg></button>
          </div>
        </div>
        <span class="sha-vendor-label">Shelly</span>
      </div>
      <div class="sha-device-primary">
        <div><span class="sha-device-state">${stateLabel}</span><span class="sha-device-reading">${fresh ? (s?.power != null ? powerStr + ' · ' : '') + 'Checked ' + _shellyAgo(observed.checkedAt) : 'A fresh reading is needed'}</span></div>
        <button class="sha-power-control ${isOn ? 'is-on' : ''}" data-sha-control="power" type="button" ${pending ? 'disabled' : ''} aria-label="${escapeHtml(powerLabel + ' ' + name + ', relay ' + relay)}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2v10M6 5a9 9 0 1 0 12 0"/></svg><span>${powerLabel}</span></button>
      </div>
      <p class="sha-command-result" role="status">${escapeHtml(device.commandResult || '')}</p>
      <details class="sha-device-details" ${openedDetails.has(key) ? 'open' : ''}>
      <summary data-sha-control="details">Device details</summary>
      <span class="sha-card-ip">${escapeHtml(ip)} · Relay ${relay}</span>
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
          <button class="btn-outline btn-sm sha-btn-refresh-card" data-sha-control="refresh" type="button">Refresh</button>
        </div>
        <span class="sha-last-checked">${escapeHtml(lastChecked)}</span>
      </div>
      </details>
    `;

    card.querySelector('.sha-power-control')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (shellyCommands.has(key)) return;
      // Recheck freshness when clicked: a card can age while it remains focused.
      const latest = shellyDevices[key];
      if (!latest || !shellyReadingFresh(latest)) { await fetchShellyStatusForIp(ip, true, relay); return; }
      await sendShellyAction(latest.status.isOn ? 'off' : 'on', ip, relay);
    });

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
          commitShellyInlineRename(card, ip, relay);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelShellyInlineRename(card);
        }
      });
      renameInput.addEventListener("blur", () => {
        if (card.classList.contains("is-renaming")) commitShellyInlineRename(card, ip, relay);
      });
    }

    // --- Action buttons (on / off / toggle) ---
    card.querySelectorAll(".sha-btn-action").forEach((btn) => {
      btn.disabled = shellyCommands.has(key);
      btn.dataset.shaControl = btn.dataset.shaAction;
      btn.setAttribute('aria-label', `${btn.textContent.trim()} ${name}, relay ${relay}`);
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = btn.dataset.shaAction;
        const orig   = btn.textContent;
        btn.disabled = true;
        btn.textContent = "…";
        try {
          await sendShellyAction(action, ip, relay);
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      });
    });

    // --- Per-card Refresh ---
    const refreshBtn = card.querySelector(".sha-btn-refresh-card");
    if (refreshBtn) {
      refreshBtn.setAttribute('aria-label', `Refresh ${name}, relay ${relay}`);
      refreshBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const orig = refreshBtn.textContent;
        refreshBtn.disabled = true;
        refreshBtn.textContent = "…";
        try {
          await fetchShellyStatusForIp(ip, true, relay);
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.textContent = orig;
        }
      });
    }

    roomCards.appendChild(card);
    if (key === focusKey && focusControl) {
      card.querySelector('[data-sha-control="' + focusControl + '"]')?.focus?.({preventScroll:true});
    }
  });

  // Update home health pill
  if (anyUnknown) setHomeAutoHealth("degraded", "Some relay states are unavailable, stale or not yet checked.");
  else if (anyOn || anyOff) setHomeAutoHealth("ok", "Registered relay states were reported in the latest checks.");
}

async function fetchShellyStatusForIp(ip, silent = false, relay = null) {
  if (!shellyCurrent()) return false;
  const epoch = shellyAuthEpoch;
  const registry = shellyRegistryReadEpoch;
  const target = shellyTarget(ip, relay);
  if (shellyReads.has(target.key)) return shellyReads.get(target.key);
  const revision = shellyRevisions.get(target.key) || 0;
  const request = (async () => {
    try {
      const data = await shellyRequest(`/shelly/status?ip=${encodeURIComponent(target.ip)}&relay=${target.relay}`, {}, epoch);
      shellyCheck(epoch);
      if (registry !== shellyRegistryReadEpoch) return false;
      const snapshot = buildShellySnapshotFromPayload(target.ip, data, target.relay);
      if (snapshot.isOn === null) throw new Error(data.summary || 'The requested relay state is unavailable.');
      if ((shellyRevisions.get(target.key) || 0) !== revision) return false;
      upsertShellyDevice(target.ip, {relay:target.relay, status:snapshot, statusError:null});
      renderShellyStatus(target.ip, data, target.relay);
      if (!silent) showToast(`Relay ${target.relay} status updated.`, 'ok');
      return true;
    } catch (e) {
      if (!shellyCurrent(epoch) || registry !== shellyRegistryReadEpoch) return false;
      if ((shellyRevisions.get(target.key) || 0) !== revision) return false;
      upsertShellyDevice(target.ip, {relay:target.relay, statusError:e.message});
      if (!silent) showToast('Status unavailable: ' + e.message, 'error');
      return false;
    } finally { if (shellyCurrent(epoch)) renderAllShellyCards(); }
  })();
  shellyReads.set(target.key, request);
  try { return await request; } finally { if (shellyReads.get(target.key) === request) shellyReads.delete(target.key); }
}
async function fetchAllShellyStatuses(silent = false) {
  if (!shellyCurrent() || !shellyRegistryReady) return;
  const epoch = shellyAuthEpoch;
  const registry = shellyRegistryReadEpoch;
  if (shellyCycle) return shellyCycle;
  const cycle = (async () => {
    if (shellyHostLoad) await shellyHostLoad;
    if (!shellyCurrent(epoch) || registry !== shellyRegistryReadEpoch) return;
    const devices = Object.values(shellyDevices).filter(d => !shellyCommands.has(d.key));
    let reported = 0;
    for (const d of devices) {
      if (!shellyCurrent(epoch) || registry !== shellyRegistryReadEpoch) return;
      if (await fetchShellyStatusForIp(d.ip, true, d.relay)) reported++;
    }
    if (!shellyCurrent(epoch) || registry !== shellyRegistryReadEpoch) return;
    renderAllShellyCards();
    if (!silent) showToast(`${reported} of ${devices.length} relay states reported.`, reported === devices.length ? 'ok' : 'warn');
  })();
  shellyCycle = cycle;
  try { return await cycle; } finally { if (shellyCycle === cycle) shellyCycle = null; }
}
async function fetchShellyStatus(silent = false) {
  try { const t = readShellyTarget(); return await fetchShellyStatusForIp(t.ip, silent, t.relay); }
  catch (e) { if (!silent) showToast(e.message, 'error'); return false; }
}
function renderShellyStatus(ip, payload, relay = 0) {
  if (!shellyCurrent()) return;
  const snapshot = buildShellySnapshotFromPayload(ip, payload, relay);
  lastShellyStatus = snapshot;
  const pill = $('shelly-status-pill');
  if (pill) pill.textContent = snapshot.isOn === null ? 'State unavailable' : `Relay ${relay} ${snapshot.isOn ? 'ON' : 'OFF'}`;
  if ($('shelly-status-summary')) $('shelly-status-summary').textContent = `${ip} · Relay ${relay} · ${formatShellyStatusSummary(snapshot)}`;
  if ($('shelly-status-raw')) $('shelly-status-raw').textContent = JSON.stringify(payload, null, 2);
}
async function sendShellyAction(action, ipOverride = null, relayOverride = null) {
  const epoch = shellyAuthEpoch;
  const registry = shellyRegistryReadEpoch;
  let target;
  const current = () => shellyCurrent(epoch) && registry === shellyRegistryReadEpoch;
  const unavailable = () => {
    if (target && shellyCurrent(epoch)) { shellyCommands.delete(target.key); renderAllShellyCards(); }
    return {ok:false, outcome:'unknown', summary:'Access or the host registry changed. Review current status before trying again.'};
  };
  if (!current()) return unavailable();
  if (!shellyRegistryReady || shellyRegistryWrite) return {ok:false, summary:'Host registry unavailable or a save is pending. Refresh the registry before sending a device command.'};
  try { target = ipOverride ? shellyTarget(ipOverride, relayOverride) : readShellyTarget(); }
  catch (e) { showToast(e.message, 'error'); return {ok:false, summary:e.message}; }
  if (shellyCommands.has(target.key)) return {ok:false, summary:'Another command for this relay is running.'};
  if (!['on','off','toggle'].includes(action)) return {ok:false, summary:'Unsupported action.'};
  shellyCommands.add(target.key);
  shellyRevisions.set(target.key, (shellyRevisions.get(target.key) || 0) + 1);
  upsertShellyDevice(target.ip, {relay:target.relay, commandResult:'Sending command…', statusError:'Awaiting a fresh reading after the command.'});
  renderAllShellyCards();
  let result;
  try {
    result = await shellyRequest('/shelly/relay', {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ip:target.ip, relay:target.relay, action,
      request_id:Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('')})}, epoch);
    if (!current()) return unavailable();
    if (result.ok !== true) {
      result = {...result, ok:false, summary:result.summary || 'The device did not confirm the command.'};
    } else {
      result.summary = `Relay ${target.relay}: command acknowledged. Checking current state…`;
    }
  } catch (e) {
    if (!current()) return unavailable();
    result = {ok:false, outcome:'unknown', summary:'Command outcome unconfirmed. Check status before trying again. ' + e.message};
  }
  upsertShellyDevice(target.ip, {relay:target.relay, commandResult:result.summary});
  showToast(result.summary, result.ok ? 'ok' : 'error');
  try {
    if (result.ok) {
      if (shellyReads.has(target.key)) await shellyReads.get(target.key);
      if (!current()) return unavailable();
      const verified = await fetchShellyStatusForIp(target.ip, true, target.relay);
      if (!current()) return unavailable();
      const observed = shellyDevices[target.key]?.status;
      const expected = action === 'on' ? true : action === 'off' ? false : null;
      const message = verified ? `Command acknowledged. Relay ${target.relay} now reports ${observed.isOn ? 'ON' : 'OFF'}.` +
        (expected !== null && observed.isOn !== expected ? ' This differs from the requested state.' : '') :
        'Command acknowledged; current relay state could not be verified. Check status before trying again.';
      upsertShellyDevice(target.ip, {relay:target.relay, commandResult:message});
      result = {...result, state_verified:verified, on:verified ? observed.isOn : null, summary:message};
    }
  } finally { if (shellyCurrent(epoch)) { shellyCommands.delete(target.key); renderAllShellyCards(); } }
  return result;
}

async function discoverShellyDevices() {
  const epoch = shellyAuthEpoch;
  if (!shellyCurrent(epoch) || !shellyRegistryReady || shellyRegistryWrite) return;
  const registry = shellyRegistryReadEpoch;
  const btn = $("shelly-discover-btn");
  const orig = btn?.textContent || "Discover";

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Scanning...";
  }

  try {
    showToast("Scanning your LAN for Shelly devices...", "info");
    const data = await shellyRequest('/shelly/discover', {}, epoch);
    shellyCheck(epoch);
    if (!shellyRegistryReady || registry !== shellyRegistryReadEpoch) throw new Error('The host registry changed during discovery. Refresh it before discovering devices again.');
    if (!Array.isArray(data.found)) throw new Error('Discovery did not return a valid device list.');
    const found = data.found;
    if (!found.length) {
      showToast(`No Shelly devices found on ${data.subnet || "this subnet"}.`, "info");
      return;
    }

    const staged = [];
    found.forEach((device) => {
      const ip = String(device.ip || "").trim();
      if (!ip) return;
      const existingName = (shellyDevices?.[shellyKey(ip, 0)]?.name || "").trim();
      const discoveredName = String(device.name || device.model || "Shelly").trim();
      staged.push({
        ip, relay:0,
        name: existingName || discoveredName,
        status: shellyDevices?.[shellyKey(ip, 0)]?.status || null,
        discovered: {
          model: device.model || null,
          app: device.app || null,
          gen: device.gen || null,
          ver: device.ver || null,
        },
      });
    });
    if (!staged.length) throw new Error('Discovery did not return valid device addresses.');
    const saved = await syncShellyRegistry(staged, epoch);
    shellySavedRegistryCheck(saved, epoch);
    staged.forEach(device => upsertShellyDevice(device.ip, device));

    const firstIp = String(found[0]?.ip || "").trim();
    if (firstIp) setSelectedShellyIp(firstIp, 0);

    renderAllShellyCards();
    await fetchAllShellyStatuses(true);
    shellySavedRegistryCheck(saved, epoch);
    startShellyAutoRefresh();

    showToast(`Found and saved ${staged.length} Shelly device${staged.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    if (!shellyCurrent(epoch)) return;
    console.error("[Shelly] discovery failed:", err);
    showToast("Shelly discovery failed: " + (err?.message || "unknown error"), "error");
  } finally {
    if (btn && shellyCurrent(epoch)) {
      btn.disabled = !shellyRegistryReady || !!shellyRegistryWrite;
      btn.textContent = orig;
    }
  }
}


function setupHomeAutomationPanel() {
  if (shellyPanelBound) return;
  shellyPanelBound = true;
  shellyRegistryReady = false;
  loadShellyDevicesFromStorage(); renderAllShellyCards();
  // Existing browser-only records remain readable, but are never automatically
  // written over the host registry. Importing them is an explicit action.
  let cached = Object.values(shellyDevices).map(d => ({ip:d.ip, relay:d.relay, name:d.name}));
  try {
    const backup = localStorage.getItem('tli_shelly_browser_import_v1');
    if (backup) cached = JSON.parse(backup);
    else {
      // Setup may happen behind the lock. Preserve browser-only records for
      // explicit import without rendering them or replacing them with host data.
      if (!shellyCurrent()) cached = Object.entries(JSON.parse(localStorage.getItem(shellyDevicesStorageKey) || '{}'))
        .filter(([, device]) => device && typeof device === 'object')
        .map(([key, device]) => ({ip:device.ip || key, relay:device.relay ?? 0, name:device.name || ''}));
      if (cached.length) localStorage.setItem('tli_shelly_browser_import_v1', JSON.stringify(cached));
    }
  } catch {}
  const importBtn = $('shelly-import-cache-btn');
  const load = async (epoch = shellyAuthEpoch) => {
    try {
      await loadShellyHostRegistry(epoch);
      shellyCheck(epoch);
      if (importBtn) importBtn.hidden = !cached.some(d => !shellyDevices[shellyKey(d.ip,d.relay)]);
      if ($('panel-homeauto')?.hidden === false) startShellyAutoRefresh();
      return true;
    } catch (e) { if (shellyCurrent(epoch) && !e.shellyObsolete) showToast('Host registry unavailable. ' + e.message, 'error'); return false; }
  };
  shellyReloadHost = load;
  shellyHostLoad = shellyCurrent() ? load() : Promise.resolve();
  const bind = (id, fn) => $(id)?.addEventListener('click', async () => {
    const button = $(id); if (button.disabled || shellyLocked) return;
    if (!shellyAccessReady) { if (id === 'shelly-refresh-all-btn') await window.EventInterpreter?.retry(); return; }
    const epoch = shellyAuthEpoch; button.disabled = true;
    try { await shellyHostLoad; if (shellyCurrent(epoch)) await fn(epoch); }
    catch (e) { if (shellyCurrent(epoch)) showToast(e.message, 'error'); }
    finally { if (shellyCurrent(epoch)) shellyControlAccess(); }
  });
  bind('shelly-refresh-all-btn', async epoch => { const loaded = await load(epoch); if (loaded && shellyCurrent(epoch)) { await fetchAllShellyStatuses(false); if ($('panel-homeauto')?.hidden === false) startShellyAutoRefresh(); } });
  bind('shelly-status-btn', async () => { await fetchShellyStatus(false); });
  bind('shelly-discover-btn', discoverShellyDevices);
  bind('shelly-on-btn', () => sendShellyAction('on'));
  bind('shelly-off-btn', () => sendShellyAction('off'));
  bind('shelly-import-cache-btn', async epoch => { const saved = await syncShellyRegistry(cached, epoch); shellySavedRegistryCheck(saved, epoch); const loaded = await load(epoch); if (loaded && shellyCurrent(epoch)) showToast('Browser devices merged into the host registry.', 'ok'); });
  bind('shelly-add-device-btn', async epoch => {
    const target = readShellyTarget(), name = $('shelly-name-input')?.value.trim() || '';
    const saved = await syncShellyRegistry([{...target,name}], epoch);
    shellySavedRegistryCheck(saved, epoch);
    upsertShellyDevice(target.ip, {relay:target.relay, name});
    setSelectedShellyIp(target.ip, target.relay); renderAllShellyCards();
    showToast(`Saved ${name || target.ip} · relay ${target.relay}.`, 'ok');
    await fetchShellyStatusForIp(target.ip, true, target.relay);
  });
  shellyControlAccess();
}
