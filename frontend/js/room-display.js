/* Optional browser room display. Registry and saved observations only; no polling. */
(() => {
  'use strict';
  const protocol = 'tli-device-details-v1', base = '/api/intelligence';
  const text = (v, max = 2000) => typeof v === 'string' && v.length <= max;
  const id = v => text(v, 256) && v.length > 0;
  const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
  const stamp = v => date(v) ? new Date(v).toLocaleString() : 'Not recorded';
  const node = (tag, value, cls) => { const e = document.createElement(tag); if (value != null) e.textContent = value; if (cls) e.className = cls; return e; };
  const sameTarget = (a, b) => a?.id === b?.id && a?.kind === b?.kind && (a?.address ?? null) === (b?.address ?? null) && (a?.relay ?? null) === (b?.relay ?? null);
  const ref = d => d && id(d.id) && text(d.name, 120) && id(d.kind) && ['normal', 'important', 'critical'].includes(d.importance) &&
    (d.room === null || text(d.room, 120)) && (d.address == null || text(d.address, 1000)) && (d.relay == null || Number.isInteger(d.relay) && d.relay >= 0);
  const envelope = v => v?.ok === true && v.protocol === protocol && v.actions_performed === false && date(v.checked_at) && id(v.host?.id) && text(v.host.name, 120);
  function validRooms(v) {
    if (!envelope(v) || !text(v.scope) || !Array.isArray(v.rooms) || v.rooms.length > 2000) return false;
    const names = new Set(), ids = new Set(); let count = 0;
    return v.rooms.every(r => {
      if (!r || !(r.name === null || text(r.name, 120)) || names.has(r.name) || !Array.isArray(r.devices) || r.devices.length > 2000) return false;
      names.add(r.name);
      return r.devices.every(d => { if (!ref(d) || d.room !== r.name || ids.has(d.id) || ++count > 2000) return false; ids.add(d.id); return true; });
    });
  }
  let dialog, body, status, heading, returnFocus, epoch = 0, pending = null, locked = false;
  let rooms = null, chosen = false, roomName = null, limit = 24, observations = new Map(), notice = '', failed = false;
  const alive = token => !locked && dialog?.open && epoch === token;
  const group = () => chosen ? rooms?.rooms.find(r => r.name === roomName) : null;
  const visible = () => group()?.devices.slice(0, limit) || [];
  function button(label, action, primary = false) {
    const b = node('button', label, primary ? 'btn-primary' : 'btn-outline'); b.type = 'button'; b.disabled = !!pending;
    b.addEventListener('click', () => { if (b.disabled || locked || !dialog?.open || pending) return; return Promise.resolve(action()).catch(error => { if (dialog.open && !locked) { notice = error.message; failed = true; paint(); } }); }); return b;
  }
  function controls(...items) { const e = node('div', null, 'room-display-actions'); e.append(...items); return e; }
  function ensure() {
    if (dialog) return;
    dialog = node('dialog', null, 'room-display-dialog'); dialog.id = 'room-display-dialog'; dialog.setAttribute('aria-labelledby', 'room-display-heading');
    const header = node('header'); heading = node('h2', 'Room display'); heading.id = 'room-display-heading'; heading.tabIndex = -1;
    const close = node('button', 'Close room display', 'btn-outline'); close.type = 'button'; close.addEventListener('click', clear);
    header.append(node('div', 'TLI · Optional browser view', 'room-display-eyebrow'), heading, close);
    status = node('p', '', 'room-display-status'); status.id = 'room-display-status'; status.setAttribute('role', 'status');
    body = node('div'); body.id = 'room-display-body'; dialog.append(header, status, body); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (document.fullscreenElement === dialog) leaveFullscreen(); else clear(); });
    dialog.addEventListener('close', () => { if (!dialog.open && (rooms || chosen || pending)) clear(false); });
  }
  function leaveFullscreen() { if (document.fullscreenElement === dialog && typeof document.exitFullscreen === 'function') Promise.resolve(document.exitFullscreen()).catch(() => {}); }
  function clear(close = true) {
    epoch++; pending?.abort(); pending = null; rooms = null; chosen = false; roomName = null; limit = 24; observations.clear(); notice = ''; failed = false;
    body?.replaceChildren(); if (status) status.textContent = ''; leaveFullscreen(); if (close && dialog?.open) dialog.close(); returnFocus?.focus?.();
  }
  function open() {
    if (locked || document.hidden) return;
    ensure(); clear(false); returnFocus = document.activeElement; if (!dialog.open) dialog.showModal(); heading.focus(); return refreshRooms();
  }
  async function api(path, controller, token) {
    const response = await fetch(base + path, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (response.status === 401) { if (alive(token)) window.dispatchEvent(new CustomEvent('tli-session-locked')); throw new Error('Unlock TLI to read saved room details.'); }
    const v = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof v?.detail === 'string' ? v.detail : 'Saved details are unavailable (' + response.status + ').');
    return v;
  }
  async function refreshRooms() {
    if (pending || locked || !dialog?.open) return;
    const token = ++epoch, controller = new AbortController(); pending = controller; notice = 'Reading configured rooms…'; failed = false; paint();
    try {
      const value = await api('/rooms', controller, token); if (!alive(token)) return;
      if (!validRooms(value)) throw new Error('The room list did not contain complete, uniquely identified registered devices.');
      if (rooms && rooms.host.id !== value.host.id) throw new Error('The responding host identity changed. Close this display before reviewing another host.');
      for (const [key, saved] of observations) if (!value.rooms.some(r => r.devices.some(d => sameTarget(d, saved.device)))) observations.delete(key);
      rooms = value;
      notice = chosen && !group() ? 'The selected room is no longer configured. Choose another room explicitly.' : 'Configured rooms read. No device was contacted and no room was selected automatically.';
    } catch (error) { if (alive(token)) { failed = true; notice = error.message + (rooms ? ' The previous room list and saved observations are retained.' : ' No room list is available yet.'); } }
    finally { if (pending === controller) pending = null; if (alive(token)) paint(); }
  }
  function validObservation(v, device) {
    return envelope(v) && v.host.id === rooms.host.id && ref(v.device) && sameTarget(v.device, device) &&
      ['unknown', 'reported', 'stale'].includes(v.observed?.status) && (v.observed.observed_at === null || date(v.observed.observed_at)) && text(v.observed.scope) &&
      (v.observed.status === 'unknown' || date(v.observed.observed_at));
  }
  async function readSaved(devices) {
    if (pending || !devices.length || locked || !dialog?.open) return;
    const selected = devices.slice(0, 24), token = ++epoch, controller = new AbortController(); pending = controller; notice = 'Reading retained observation metadata. This does not contact the device…'; failed = false; paint();
    let succeeded = 0, failures = 0;
    try {
      for (const device of selected) {
        if (!alive(token)) return;
        try {
          const value = await api('/devices/' + encodeURIComponent(device.id) + '/details', controller, token); if (!alive(token)) return;
          if (!validObservation(value, device)) throw new Error('Saved observation identity or metadata did not match this registered target.');
          observations.set(device.id, { device, observed: value.observed, checked_at: value.checked_at, error: null }); succeeded++;
        } catch (error) {
          if (!alive(token)) return;
          const prior = observations.get(device.id); observations.set(device.id, { ...(prior || { device }), error: error.message }); failures++;
        }
      }
      const recordCount = succeeded + ' saved observation record' + (succeeded === 1 ? '' : 's');
      notice = failures ? recordCount + ' read; ' + failures + ' unavailable. Earlier observations are retained where present.' : recordCount + ' read. No fresh device check ran.'; failed = failures > 0;
    } finally { if (pending === controller) pending = null; if (alive(token)) paint(); }
  }
  function showFullscreen() {
    if (document.fullscreenElement === dialog) { leaveFullscreen(); return; }
    if (typeof dialog.requestFullscreen !== 'function') { notice = 'Fullscreen is unavailable in this browser. The room display remains usable in this view.'; paint(); return; }
    const token = epoch;
    return Promise.resolve(dialog.requestFullscreen()).then(() => { if (!alive(token)) { leaveFullscreen(); return; } notice = document.fullscreenElement === dialog ? 'Fullscreen opened. Escape exits fullscreen; closing clears this private display.' : 'Fullscreen was not confirmed by the browser.'; paint(); }).catch(() => { if (alive(token)) { notice = 'The browser did not allow fullscreen. This room display remains open.'; paint(); } });
  }
  function observationRow(device, displayedAt) {
    const box = node('div', null, 'room-display-observation'), saved = observations.get(device.id);
    if (!saved?.observed) box.append(node('strong', saved?.error ? 'Saved observation unavailable' : 'Observation not read'), node('p', saved?.error || 'Read this device’s saved metadata explicitly. Registration alone does not establish health.'));
    else {
      const observed = saved.observed, age = observed.observed_at ? Math.floor((displayedAt - Date.parse(observed.observed_at)) / 1000) : null;
      const known = observed.status !== 'unknown' && age !== null && age >= 0;
      const stale = known && (age > 30 || observed.status === 'stale');
      box.append(node('strong', known ? stale ? 'Older recorded observation' : 'Recently recorded observation' : 'Observation time unknown'),
        node('p', 'Observed: ' + stamp(observed.observed_at)), node('p', 'Saved metadata read: ' + stamp(saved.checked_at)),
        node('p', known ? 'Age at this display update: ' + age + ' seconds' + (stale ? ' · beyond the current 30-second window.' : ' · within 30 seconds at this update.') : 'No usable present observation age is established.'), node('p', observed.scope));
      if (saved.error) box.append(node('p', 'Latest read failed: ' + saved.error + ' Earlier metadata retained.', 'room-display-warning'));
    }
    return box;
  }
  function paint() {
    if (!dialog?.open) return;
    const displayedAt = Date.now(); heading.textContent = chosen ? (roomName === null ? 'Unassigned devices' : roomName || 'Unnamed configured room') : 'Room display';
    status.textContent = notice; status.classList.toggle('error', failed); body.replaceChildren(); body.setAttribute('aria-busy', String(!!pending));
    body.append(node('p', 'Uses this browser’s existing TLI access. This is not a restricted kiosk account.', 'room-display-authority'));
    const actions = controls(button('Refresh room list', refreshRooms), button(document.fullscreenElement === dialog ? 'Exit fullscreen' : 'Open fullscreen', showFullscreen)); body.append(actions);
    if (!rooms) { body.append(node('p', pending ? 'Loading the configured room list…' : 'Room details are unavailable. Use Refresh room list to try again.')); return; }
    body.append(node('p', 'TLI host: ' + rooms.host.name + ' · ' + rooms.host.id + ' · Room list read ' + stamp(rooms.checked_at), 'room-display-meta'));
    const label = node('label', null, 'room-display-choice'), select = node('select'); select.id = 'room-display-room'; select.setAttribute('aria-label', 'Choose a configured room'); select.disabled = !!pending;
    const placeholder = node('option', 'Choose a room…'); placeholder.value = ''; select.append(placeholder);
    rooms.rooms.forEach((r, i) => { const o = node('option', (r.name === null ? 'Unassigned devices' : r.name || 'Unnamed configured room') + ' · ' + r.devices.length + ' registered'); o.value = String(i); select.append(o); });
    const index = chosen ? rooms.rooms.findIndex(r => r.name === roomName) : -1; select.value = index < 0 ? '' : String(index);
    select.addEventListener('change', () => { if (pending || locked || !dialog.open) { select.value = index < 0 ? '' : String(index); return; } const n = Number(select.value); if (select.value === '' || !Number.isInteger(n) || !rooms.rooms[n]) { chosen = false; roomName = null; } else { chosen = true; roomName = rooms.rooms[n].name; } limit = 24; notice = chosen ? 'Room selected. Saved observations are read only when you choose them.' : 'Choose a room explicitly.'; failed = false; paint(); });
    label.append(node('span', 'Configured room'), select); body.append(label, node('p', rooms.scope, 'room-display-meta'));
    if (!rooms.rooms.length) { body.append(node('p', 'No configured room groups or registered devices were returned.')); return; }
    const selected = group(); if (!selected) { body.append(node('p', chosen ? 'The previously selected room is unavailable. No other room has been substituted.' : 'Choose the room this screen should show. TLI does not detect this browser’s location or occupancy.')); return; }
    const refreshable = visible().filter(d => observations.get(d.id)?.observed).slice(0, 24);
    if (refreshable.length) body.append(button('Refresh ' + refreshable.length + ' saved observations', () => readSaved(refreshable)));
    body.append(node('p', selected.devices.length + ' registered devices · importance is a shared household preference, not measured severity.', 'room-display-meta'));
    const grid = node('div', null, 'room-display-grid');
    for (const device of visible()) {
      const card = node('article', null, 'room-display-card'); card.append(node('p', device.kind.replaceAll('_', ' '), 'room-display-eyebrow'), node('h3', device.name || 'Unnamed device'), node('p', 'Shared importance: ' + device.importance, 'room-display-importance'), node('p', device.id, 'room-display-id'));
      if (device.address || device.relay != null) card.append(node('p', (device.address || 'Address not recorded') + (device.relay != null ? ' · relay ' + device.relay : ''), 'room-display-meta'));
      card.append(observationRow(device, displayedAt), button('Read saved observation: ' + (device.name || device.id), () => readSaved([device]))); grid.append(card);
    }
    body.append(grid); if (!selected.devices.length) body.append(node('p', 'No registered devices in this configured room.'));
    if (selected.devices.length > limit) body.append(button('Show 24 more devices', () => { limit += 24; paint(); }));
    body.append(node('p', 'Display updated ' + new Date(displayedAt).toLocaleString() + '. Times are evaluated when this view updates; no clock, device polling or background refresh runs. No occupancy, AI availability or current device health is inferred.', 'room-display-meta'));
  }
  window.TLIRoomDisplay = { open, close: clear };
  window.addEventListener('tli-session-locked', () => { locked = true; clear(); }); window.addEventListener('tli-session-unlocked', () => { locked = false; });
  window.addEventListener('pagehide', clear); document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  document.addEventListener('fullscreenchange', () => { if (dialog?.open) paint(); });
})();
