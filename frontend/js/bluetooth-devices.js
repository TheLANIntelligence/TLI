/* Host Bluetooth controls. Navigation reads saved metadata only; radio work is explicit. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { epoch: 0, revision: 0, locked: $('tli-lock-screen')?.getAttribute('aria-hidden') === 'false',
    ready: false, verified: false, initialized: false, active: false, pending: null, available: false, inventoryReady: false, profiles: [], devices: [], candidates: [], readings: new Map(), needsCheck: new Set() };
  state.ready = !state.locked;
  const addressPattern = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
  const capture = () => ({ epoch: state.epoch, revision: state.revision });
  const current = token => token.epoch === state.epoch && token.revision === state.revision && !state.locked && state.ready;
  const check = token => { if (!current(token)) throw new Error('Bluetooth access changed.'); };
  const make = (tag, text, css) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (css) n.className = css; return n; };
  const tell = message => { if ($('bluetooth-message')) $('bluetooth-message').textContent = message; };
  const selected = () => state.candidates.find(d => d.address === $('bluetooth-candidate')?.value);
  const selectedProfile = () => state.profiles.find(p => p.id === $('bluetooth-profile')?.value);
  const profileLabel = p => p.brand + ' ' + p.model;
  const metadataEnabled = () => !state.locked && state.ready && state.inventoryReady && !state.pending;
  const enabled = () => metadataEnabled() && state.available;
  const saved = address => state.devices.some(d => d.extra.address === address);
  const supportReasons = {
    dependency_missing: 'Optional Bluetooth support is not installed.',
    windows_required: 'This experimental Bluetooth integration requires a Windows 11 host.',
    windows_11_required: 'Windows 11 build 22000 or newer is required.',
    python_version_unsupported: 'The host needs Python 3.10 or newer for this optional integration.',
    dependency_version_unsupported: 'The installed Bluetooth dependency is not a supported version. Review Setup instructions.',
    dependency_unavailable: 'The optional Bluetooth dependency could not be loaded.',
    runtime_unavailable: 'Bluetooth software availability could not be checked.',
    cleanup_pending: 'A previous Bluetooth operation has not finished cleanup. Review the host before trying again.',
    runtime_ready: 'Optional Bluetooth software is ready.',
  };
  function sync() {
    if (!$('bluetooth-refresh')) return;
    $('bluetooth-refresh').disabled = state.locked || !!state.pending;
    $('bluetooth-refresh').textContent = state.ready ? 'Refresh saved devices and support' : 'Check Bluetooth access';
    $('bluetooth-scan').disabled = !enabled();
    for (const id of ['bluetooth-candidate', 'bluetooth-profile', 'bluetooth-name', 'bluetooth-room', 'bluetooth-confirm']) $(id).disabled = !enabled();
    $('bluetooth-profile').disabled ||= state.profiles.length === 0;
    $('bluetooth-enroll').disabled = !enabled() || !selected() || !selectedProfile() || saved(selected().address) || !$('bluetooth-confirm').checked;
    for (const button of $('bluetooth-devices').querySelectorAll('button')) {
      const needsCheck = state.needsCheck.has(button.dataset.deviceId);
      button.disabled = button.dataset.action === 'forget' ? !metadataEnabled() : !enabled() || (button.dataset.action !== 'status' && needsCheck);
    }
  }
  function clearCandidates() {
    state.candidates = [];
    const option = make('option', 'Choose a discovered device'); option.value = '';
    $('bluetooth-candidate')?.replaceChildren(option);
    if ($('bluetooth-candidate')) $('bluetooth-candidate').value = '';
    if ($('bluetooth-confirm')) $('bluetooth-confirm').checked = false;
  }
  function renderProfiles() {
    const select = $('bluetooth-profile'); if (!select) return;
    const empty = make('option', 'Choose the supported brand and model'); empty.value = ''; select.replaceChildren(empty); select.value = '';
    for (const p of state.profiles) { const option = make('option', profileLabel(p) + ' · ' + p.validation); option.value = p.id; select.append(option); }
    $('bluetooth-profiles').textContent = state.profiles.length ? 'Installed model integrations: ' + state.profiles.map(p => profileLabel(p) + ' (' + p.validation + ')').join(', ') + '.' : 'No supported Bluetooth model integrations are available in this view.';
    $('bluetooth-confirm-label').textContent = ' I checked the device’s printed label and it matches the selected supported brand and model.';
  }
  function clear(message) {
    state.epoch++; state.revision++; state.pending = null; state.available = false; state.inventoryReady = false;
    state.devices = []; state.profiles = []; state.readings.clear(); state.needsCheck.clear(); clearCandidates(); renderProfiles();
    for (const id of ['bluetooth-name', 'bluetooth-room']) if ($(id)) $(id).value = '';
    $('bluetooth-devices')?.replaceChildren();
    if ($('bluetooth-support')) $('bluetooth-support').textContent = 'Bluetooth support has not been checked for this session.';
    tell(message); sync();
  }
  function accessLost() {
    const pending = !!state.pending;
    state.locked = true; state.ready = false; state.verified = false;
    clear('Unlock TLI to view Bluetooth devices.' + (pending ? ' An operation may have completed. Its outcome is unconfirmed; no retry was sent.' : ''));
  }
  async function request(url, options, token) {
    if (!current(token)) throw new Error('Bluetooth access changed.');
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(40000), ...options });
    if (!current(token)) throw new Error('Bluetooth access changed.');
    if (response.status === 401 || response.status === 403) {
      window.dispatchEvent(new CustomEvent('tli-session-locked'));
      throw new Error('Unlock TLI before reviewing Bluetooth devices.');
    }
    const data = await response.json();
    if (!current(token)) throw new Error('Bluetooth access changed.');
    if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : data?.detail?.message || `Bluetooth request failed (${response.status}).`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The host returned an unreadable Bluetooth response.');
    return data;
  }
  const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function operation(message, work) {
    if (!state.ready || state.locked || state.pending) return;
    const token = capture(); state.pending = token; tell(message); sync();
    try { await work(token); }
    catch (error) { if (current(token)) tell(error.message); }
    finally { if (state.pending === token) { state.pending = null; sync(); } }
  }
  function catalog(data) {
    const ids = new Set(), bindings = new Set(), prefixes = new Set();
    const label = value => typeof value === 'string' && value.trim() === value && value.length > 0 && Array.from(value).length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
    if (!Array.isArray(data) || data.length > 32) throw new Error('The host did not confirm a supported Bluetooth model catalog.');
    for (const p of data) {
      if (!p || typeof p.id !== 'string' || typeof p.vendor !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(p.id) || !/^[a-z][a-z0-9_]{0,63}$/.test(p.vendor) || !label(p.brand) || !label(p.model) ||
          typeof p.id_prefix !== 'string' || p.id_prefix.length > 52 || !/^[a-z][a-z0-9-]*-$/.test(p.id_prefix) || !['experimental', 'verified'].includes(p.validation) ||
          !Array.isArray(p.capabilities) || !p.capabilities.length || p.capabilities.length > 2 || new Set(p.capabilities).size !== p.capabilities.length ||
          p.capabilities.some(c => !['switch.on', 'switch.off'].includes(c)) || ids.has(p.id) || bindings.has(p.vendor + '\0' + p.model) || prefixes.has(p.id_prefix))
        throw new Error('The host returned an invalid or ambiguous Bluetooth model catalog.');
      ids.add(p.id); bindings.add(p.vendor + '\0' + p.model); prefixes.add(p.id_prefix);
    }
    return data;
  }
  function recordShape(d) {
    return d && typeof d === 'object' && typeof d.device_id === 'string' && d.device_id.length > 0 && d.device_id.length <= 64 && typeof d.name === 'string' &&
      typeof d.vendor === 'string' && typeof d.extra?.model === 'string' && typeof d.extra?.profile === 'string' && typeof d.extra.transport === 'string' && addressPattern.test(d.extra.address) &&
      typeof d.ip === 'string' && d.ip.toLowerCase() === ('ble://' + d.extra.address).toLowerCase() && Array.isArray(d.capabilities) && d.capabilities.every(c => typeof c === 'string') && (d.room == null || typeof d.room === 'string');
  }
  function binding(d, p) {
    return recordShape(d) && !!p && d.vendor === p.vendor && d.extra.profile === p.id && d.extra.model === p.model && d.extra.transport === 'bluetooth' && d.ip === 'ble://' + d.extra.address &&
      (d.relay === undefined || d.relay === 0) &&
      d.device_id === p.id_prefix + d.extra.address.replaceAll(':', '').toLowerCase() &&
      d.capabilities.length === p.capabilities.length && d.capabilities.every((c, i) => c === p.capabilities[i]);
  }
  function deviceRows(data) {
    if (!Array.isArray(data.devices)) throw new Error('The saved device inventory is unavailable.');
    const rows = data.devices.filter(d => typeof d?.extra?.transport === 'string' && d.extra.transport.toLowerCase() === 'bluetooth' || typeof d?.ip === 'string' && d.ip.toLowerCase().startsWith('ble://') ||
      state.profiles.some(p => typeof d?.vendor === 'string' && p.vendor === d.vendor.toLowerCase() || p.id === d?.extra?.profile)), ids = new Set(), addresses = new Set();
    for (const d of rows) {
      if (!recordShape(d) || ids.has(d.device_id) || addresses.has(d.extra.address)) throw new Error('The saved Bluetooth device inventory is invalid. Preserve the host data and review it before making changes.');
      ids.add(d.device_id); addresses.add(d.extra.address);
    }
    return rows;
  }
  function describeState(d, text) {
    state.readings.set(d.device_id, text); renderDevices();
  }
  function renderDevices() {
    const list = $('bluetooth-devices'); if (!list) return; list.replaceChildren();
    if (!state.inventoryReady) { list.append(make('p', 'Saved Bluetooth devices are unavailable. Refresh the saved inventory before using controls.')); sync(); return; }
    if (!state.devices.length) list.append(make('p', 'No Bluetooth devices are saved. Scan explicitly, choose an installed model integration, then confirm the label printed on your device before adding it.'));
    const token = capture();
    for (const d of state.devices) {
      const profile = state.profiles.find(p => binding(d, p));
      const card = make('article', null, 'card');
      card.append(make('h4', d.name || (profile ? profileLabel(profile) : 'Saved Bluetooth device')), make('p', (profile ? profileLabel(profile) : 'Saved model ' + d.extra.model) + ' · Host Bluetooth · ' + d.extra.address + (d.room ? ' · ' + d.room : '')),
        make('p', state.readings.get(d.device_id) || (state.needsCheck.has(d.device_id) ? 'Earlier command outcome is unconfirmed. Choose Check state before another deliberate command.' : 'State unknown. No connection or state query has run for this view.')),
        make('p', !profile ? 'This saved model has no matching installed integration. Its record is preserved, but radio controls are unavailable.' : profile.validation === 'experimental' ? 'Experimental model integration: physical-device validation is pending. A sent command is not proof that the light changed.' : 'Model integration validated. A sent command is not proof that this light changed.'),
        make('p', 'Forget device removes only its saved TLI entry. It does not unpair Windows Bluetooth or send a light command.'));
      const actions = profile ? [['status', 'Check state'], ...profile.capabilities.map(c => [c, c === 'switch.on' ? 'Turn on' : 'Turn off']), ['forget', 'Forget device']] : [['forget', 'Forget device']];
      for (const [action, label] of actions) {
        const button = make('button', label, 'btn-outline btn-sm'); button.type = 'button'; button.dataset.deviceId = d.device_id; button.dataset.action = action;
        button.addEventListener('click', () => {
          if (!current(token) || button.disabled || !(action === 'forget' ? metadataEnabled() : enabled()) || (action.startsWith('switch.') && state.needsCheck.has(d.device_id))) return;
          if (action === 'forget') {
            if (!window.confirm('Forget “' + (d.name || 'Bluetooth device') + '” in TLI? This only removes its saved entry; it does not unpair Windows Bluetooth or send a light command.') || !current(token)) return;
            return forget(d);
          }
          return action === 'status' ? checkState(d) : command(d, action);
        }); card.append(button);
      }
      list.append(card);
    }
    sync();
  }
  async function readState(d, token, prefix = '') {
    const data = await request('/homepower/devices/' + encodeURIComponent(d.device_id) + '/status', {}, token);
    check(token);
    if (typeof data.ok !== 'boolean' || (data.on !== null && typeof data.on !== 'boolean') || typeof data.verified !== 'boolean' ||
        (data.verified && (data.ok !== true || typeof data.on !== 'boolean'))) throw new Error('The host did not confirm a readable Bluetooth state response.');
    const verified = data.ok === true && data.verified === true && typeof data.on === 'boolean';
    describeState(d, prefix + (verified ? 'Device reported ' + (data.on ? 'ON' : 'OFF') + ' at ' + new Date().toLocaleTimeString() + '. This is a reported reading, not physical confirmation.' : 'State unknown. No verified state was returned. Check the light before deliberately sending another command.'));
    return data;
  }
  function checkState(d) {
    return operation('Checking the selected light through the TLI host…', async token => {
      try {
        await readState(d, token); check(token); state.needsCheck.delete(d.device_id);
        tell('State check finished. An unknown reading is not OFF and does not confirm an earlier command.');
      } catch (error) {
        if (current(token)) { describeState(d, 'State unavailable. ' + error.message); tell('State check failed. No command was sent. ' + error.message); }
      }
    });
  }
  function forget(d) {
    return operation('Removing only the selected saved TLI entry…', async token => {
      try {
        const data = await request('/homepower/devices/' + encodeURIComponent(d.device_id), { method: 'DELETE' }, token);
        check(token);
        if (data.ok !== true) throw new Error('The host did not confirm removal.');
        state.devices = state.devices.filter(row => row.device_id !== d.device_id);
        state.readings.delete(d.device_id); state.needsCheck.delete(d.device_id); clearCandidates(); renderDevices();
        tell('Saved TLI entry removed. Windows Bluetooth pairing and the light were not changed.');
      } catch (error) {
        if (current(token)) { state.inventoryReady = false; clearCandidates(); renderDevices(); tell('Removal outcome unconfirmed. The entry may have been removed. Refresh saved devices before another deliberate action. No retry was sent. ' + error.message); }
      }
    });
  }
  function requestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  function command(d, capability) {
    return operation('Sending one explicit command to the selected light…', async token => {
      state.needsCheck.add(d.device_id); describeState(d, 'Command pending. The light state is unknown.');
      try {
        const id = requestId(), data = await request('/homepower/devices/' + encodeURIComponent(d.device_id) + '/execute', post({ capability, request_id: id }), token);
        check(token);
        if (data.ok !== true || data.outcome !== 'sent' || data.acknowledged !== false || data.verified !== false || data.request_id !== id)
          throw new Error('The host did not confirm a sent command.');
        const prefix = 'Command sent; the lamp did not acknowledge it. ';
        describeState(d, prefix + 'Physical state remains unknown.');
        tell('Command sent, not verified. No automatic command retry runs.');
        if (data.cleanup_pending === true) {
          state.available = false;
          $('bluetooth-support').textContent = supportReasons.cleanup_pending;
          describeState(d, prefix + 'Connection cleanup is pending. Radio controls are paused; refresh support after reviewing the host.');
          return;
        }
        // This is the only automatic radio read: one check after this explicit
        // command, and only while its originating view and session remain active.
        if (state.active && !document.hidden && current(token)) {
          try { await readState(d, token, prefix); check(token); state.needsCheck.delete(d.device_id); }
          catch (error) { if (current(token)) describeState(d, prefix + 'State check unavailable. Choose Check state before another deliberate command. ' + error.message); }
        }
      } catch (error) {
        if (current(token)) {
          describeState(d, 'Command outcome unconfirmed. It may have run. Choose Check state before another deliberate command.');
          tell('Command outcome unconfirmed. No retry was sent. ' + error.message);
        }
      }
    });
  }
  function refresh() {
    if (!state.initialized) return;
    if (!state.ready) { if (!state.locked && !state.pending) return window.EventInterpreter?.retry(); return; }
    if (state.pending) return;
    state.revision++; state.inventoryReady = false; state.available = false; state.profiles = []; state.readings.clear(); clearCandidates(); renderProfiles(); renderDevices();
    $('bluetooth-support').textContent = 'Checking Bluetooth software availability…';
    return operation('Checking optional Bluetooth software and saved devices. No radio scan or connection runs…', async token => {
      try {
        const support = await request('/homepower/bluetooth/status', {}, token);
        check(token);
        if (typeof support.available !== 'boolean' || typeof support.platform !== 'string' || typeof support.reason !== 'string') throw new Error('The host did not confirm Bluetooth software availability.');
        state.profiles = catalog(support.profiles); renderProfiles();
        state.available = support.available;
        $('bluetooth-support').textContent = support.available ? 'Bluetooth software is available on ' + support.platform + '. This does not confirm an adapter or a nearby light.' : 'Bluetooth support is unavailable. ' + (supportReasons[support.reason] || support.reason) + ' See Setup instructions for the optional Bluetooth dependency and Windows requirements.';
        const devices = await request('/homepower/devices', {}, token);
        check(token);
        state.devices = deviceRows(devices); state.inventoryReady = true; renderDevices();
        tell(support.available ? 'Saved devices loaded. Scan, connect and send commands only when you choose a control.' : 'Saved devices loaded; radio controls remain disabled until host Bluetooth support is available.');
      } catch (error) {
        if (current(token)) { state.inventoryReady = false; state.devices = []; renderDevices(); tell('Bluetooth inventory unavailable. ' + error.message); }
      }
    });
  }
  function scan() {
    if (!enabled()) return;
    clearCandidates();
    return operation('Scanning nearby Bluetooth advertisements with the TLI host. No light command is sent…', async token => {
      const data = await request('/homepower/bluetooth/discover', post({}), token), addresses = new Set();
      check(token);
      if (!Array.isArray(data.devices)) throw new Error('The host did not return a valid Bluetooth scan.');
      for (const d of data.devices) {
        if (!d || !addressPattern.test(d.address) || typeof d.name !== 'string' || !Array.isArray(d.profile_hints) || d.profile_hints.length > 32 || new Set(d.profile_hints).size !== d.profile_hints.length ||
            d.profile_hints.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(id)) || addresses.has(d.address)) throw new Error('The host returned invalid Bluetooth candidates.');
        addresses.add(d.address);
      }
      state.candidates = data.devices;
      for (const d of data.devices) {
        const hints = state.profiles.filter(p => d.profile_hints.includes(p.id)).map(profileLabel);
        const option = make('option', (d.name || 'Unnamed device') + ' · ' + d.address + (saved(d.address) ? ' · already saved' : hints.length ? ' · advertisement hint: ' + hints.join(', ') : ' · no installed model hint'));
        option.value = d.address; $('bluetooth-candidate').append(option);
      }
      tell(data.devices.length ? 'Scan complete. A Bluetooth name or hint is not model verification. Select the exact device, choose its supported brand and model, then check its printed label. Nearby unsupported devices need an integration before TLI can control them.' : 'No Bluetooth advertisements were returned. This does not prove that no compatible light is nearby.');
    });
  }
  function enroll() {
    const candidate = selected(), profile = selectedProfile(); if (!enabled() || !candidate || !profile || saved(candidate.address) || !$('bluetooth-confirm').checked) return;
    const rawName = $('bluetooth-name').value, rawRoom = $('bluetooth-room').value, name = rawName.trim(), room = rawRoom.trim();
    if (!name || Array.from(name).length > 64 || Array.from(room).length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(rawName + rawRoom)) { tell('Enter a device name and optional room of up to 64 characters, without control characters.'); return; }
    return operation('Checking the selected ' + profileLabel(profile) + ' service and saving its enrollment. No light command is sent…', async token => {
      try {
        const data = await request('/homepower/bluetooth/enroll', post({ address: candidate.address, name, room: room || null, profile: profile.id, model: profile.model, confirm_model: true }), token);
        check(token);
        if (data.ok !== true || !binding(data.device, profile) || data.device.extra.address !== candidate.address || data.device.name !== name || (data.device.room || '') !== room)
          throw new Error('The host did not confirm this exact enrollment.');
        state.devices = state.devices.filter(d => d.device_id !== data.device.device_id).concat(data.device); clearCandidates(); renderDevices();
        $('bluetooth-name').value = ''; $('bluetooth-room').value = '';
        tell(profileLabel(profile) + ' saved. No light command was sent and its state is unknown.' + (profile.validation === 'experimental' ? ' Physical-device validation is still pending.' : ''));
      } catch (error) {
        if (current(token)) { state.inventoryReady = false; clearCandidates(); renderDevices(); tell('Enrollment outcome unconfirmed. The device may have been saved. Refresh saved devices before another deliberate attempt. No retry was sent. ' + error.message); }
      }
    });
  }
  function init() {
    const mount = $('bluetooth-devices-mount'); if (!mount || state.initialized) return;
    state.initialized = true;
    const add = (tag, id, text, css) => { const n = make(tag, text, css); n.id = id; return n; };
    const support = add('p', 'bluetooth-support', 'Bluetooth support has not been checked.');
    const refreshButton = add('button', 'bluetooth-refresh', 'Refresh saved devices and support', 'btn-outline'); refreshButton.type = 'button'; refreshButton.addEventListener('click', refresh);
    const scanButton = add('button', 'bluetooth-scan', 'Scan Bluetooth devices', 'btn-outline'); scanButton.type = 'button'; scanButton.addEventListener('click', scan);
    const select = add('select', 'bluetooth-candidate', null, 'field-input'); select.setAttribute('aria-label', 'Discovered Bluetooth device');
    const profileSelect = add('select', 'bluetooth-profile', null, 'field-input'); profileSelect.setAttribute('aria-label', 'Supported Bluetooth brand and model');
    const name = add('input', 'bluetooth-name', null, 'field-input'); name.placeholder = 'Device name'; name.setAttribute('aria-label', 'Bluetooth device name');
    const room = add('input', 'bluetooth-room', null, 'field-input'); room.placeholder = 'Room (optional)'; room.setAttribute('aria-label', 'Bluetooth device room');
    const confirmLabel = make('label'), confirmation = add('input', 'bluetooth-confirm'); confirmation.type = 'checkbox';
    confirmLabel.append(confirmation, add('span', 'bluetooth-confirm-label', ' I checked the device’s printed label and it matches the selected supported brand and model.'));
    const enrollButton = add('button', 'bluetooth-enroll', 'Add confirmed device', 'btn-primary'); enrollButton.type = 'button'; enrollButton.addEventListener('click', enroll);
    const message = add('p', 'bluetooth-message', '', 'page-subtitle'); message.setAttribute('role', 'status');
    mount.append(support, refreshButton, scanButton, make('p', 'Scanning uses the TLI host’s Bluetooth radio, not this browser or phone. Adding a device checks its service without switching the light.'), add('p', 'bluetooth-profiles'), select, profileSelect, name, room, confirmLabel, enrollButton, message, add('div', 'bluetooth-devices'));
    select.addEventListener('change', () => { confirmation.checked = false; sync(); }); confirmation.addEventListener('change', sync);
    profileSelect.addEventListener('change', () => { confirmation.checked = false; const profile = selectedProfile(); $('bluetooth-confirm-label').textContent = profile ? ' I checked the device’s printed label: it is a ' + profileLabel(profile) + '.' : ' I checked the device’s printed label and it matches the selected supported brand and model.'; sync(); });
    clearCandidates(); renderProfiles(); sync();
    if (state.locked) tell('Unlock TLI to view Bluetooth devices.');
    if ($('panel-homeauto')?.hidden === false) { state.active = true; if (state.ready) refresh(); }
  }
  for (const event of ['tli-session-locked', 'tli-account-changed', 'tli-user-changed']) window.addEventListener(event, accessLost);
  window.addEventListener('tli-session-unlocked', event => {
    const verified = event.detail?.source === 'pin-verification';
    if (!state.locked && (!verified || state.verified)) return;
    state.locked = false; state.ready = false; if (verified) state.verified = true;
    clear('Waiting for verified access. No Bluetooth scan, connection or command will resume automatically.');
  });
  window.addEventListener('tli-private-observation-ready', () => { if (state.locked || state.ready) return; state.ready = true; sync(); if (state.active && !document.hidden) refresh(); });
  document.addEventListener('tli-panel-switched', event => { state.active = event.detail?.panelId === 'panel-homeauto'; if (state.active && state.ready && !state.pending) refresh(); });
  window.addEventListener('pagehide', () => { state.ready = false; clear('Bluetooth views cleared. No automatic retry runs.'); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
