/* Automatic, browser-authorized Sonos observations and compact playback. */
(() => {
  'use strict';
  const BASE = '/api/sonos';
  const state = {epoch: 0, ready: false, locked: false, denied: false, hidden: false, installed: false,
    request: null, timer: null, busy: false, data: null, hasDevices: false, selected: null, failures: 0,
    status: 'Checking your Sonos connection…', message: '', volumes: new Map(), volumeViews: new Map()};
  const $ = id => document.getElementById(id);
  const make = (tag, text, cls) => {const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el;};
  const text = (id, value) => {const el = $(id); if (el && el.textContent !== value) el.textContent = value;};
  const visible = () => !state.hidden && !document.hidden;
  const allowed = () => state.installed && visible() && !state.locked && !state.denied;
  const groups = () => state.data?.groups || [];
  const playing = () => groups().filter(group => group.playback === 'PLAYING');
  const chosen = rows => rows.find(group => group.device_id === state.selected) || rows.find(group => group.playback === 'PLAYING') || rows[0];
  const current = (epoch, request) => epoch === state.epoch && request === state.request && allowed() && !request.signal.aborted;
  function button(id, label, handler, cls = 'btn-outline') {
    const el = make('button', label, cls); el.id = id; el.type = 'button'; el.addEventListener('click', handler); return el;
  }
  function clearTimer() {clearTimeout(state.timer); state.timer = null;}
  function clearView(status) {
    state.epoch++; clearTimer(); state.request?.abort(); state.request = null;
    clearVolumes();
    state.ready = false; state.busy = false; state.data = null; state.hasDevices = false; state.selected = null; state.message = '';
    state.status = status; render();
  }
  function locked() {
    state.locked = true; state.denied = true;
    clearView('Unlock TLI to check your Sonos rooms.');
  }
  async function api(path, controller, method = 'GET', body, timeout = 15000) {
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {method, signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
        headers: {Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {})});
      const data = await response.json();
      if (!response.ok) {const error = Error(typeof data?.detail === 'string' ? data.detail : 'Sonos is unavailable.'); error.status = response.status; throw error;}
      if (path.startsWith(BASE) && data.protocol !== 'tli-sonos-v1') throw Error('Restart TLI to load automatic Sonos playback.');
      return data;
    } finally {clearTimeout(timer);}
  }
  function validSummary(data) {
    return data && Number.isInteger(data.devices_count) && data.devices_count >= 0 && Array.isArray(data.groups) &&
      data.groups.every(group => typeof group.device_id === 'string' && group.device_id && typeof group.name === 'string' &&
        typeof group.playback === 'string' && typeof group.title === 'string');
  }
  function schedule() {
    clearTimer(); if (!allowed() || state.request || state.busy) return;
    // An empty enrollment needs no recurring speaker checks. Enrollment
    // events and returning to TLI will check again through the same admission.
    if (state.data?.devices_count === 0) return;
    const delay = state.failures ? Math.min(60000, 15000 * 2 ** Math.min(state.failures - 1, 2))
      : playing().length ? 10000 : 20000;
    state.timer = setTimeout(() => {state.timer = null; refresh();}, delay);
  }
  function fail(error) {
    state.data = null; clearVolumes();
    if (error.status === 401 || error.status === 403) {
      locked(); window.dispatchEvent(new CustomEvent('tli-session-locked')); return;
    }
    state.failures++;
    state.status = error.name === 'AbortError' ? 'Sonos did not respond. Checking again shortly.' : 'Sonos connection unavailable. Checking again shortly.';
    render();
  }
  async function refresh() {
    if (!allowed() || state.request || state.busy) return;
    clearTimer(); const epoch = state.epoch, controller = new AbortController(); state.request = controller;
    let failureReported = false;
    render();
    try {
      if (!state.ready) {
        const access = await api('/api/events/recent?n=0', controller, 'GET', null, 10000);
        if (!current(epoch, controller)) return;
        if (!Array.isArray(access?.events)) throw Error('TLI access could not be verified.');
        state.ready = true;
      }
      const data = await api(BASE + '/now-playing', controller);
      if (!current(epoch, controller)) return;
      if (!validSummary(data)) throw Error('Sonos returned an incomplete playback status.');
      state.data = data; state.hasDevices = data.devices_count > 0; state.failures = 0; state.status = ''; render(); syncVolumes(true);
    } catch (error) {
      if (epoch === state.epoch && controller === state.request && allowed()) {failureReported = true; fail(error);}
    } finally {
      if (epoch === state.epoch && controller === state.request) {
        // A response can settle at the timeout boundary. Discarding that reply
        // must also retire the previous claim that music is still playing.
        if (controller.signal.aborted && !failureReported) fail({name: 'AbortError'});
        state.request = null; render(); schedule();
      }
    }
  }
  async function command(action, group, params = {}, targetId = group?.device_id, volumeContext = null, focusId = null) {
    if (!allowed() || !state.ready || state.busy || !group || !groups().includes(group)) return;
    if (volumeContext && !volumeCurrent(volumeContext.record, volumeContext.controls)) return;
    // Cancel an older observation before the explicit command; its response
    // cannot overwrite the subsequent playback read.
    clearTimer(); state.request?.abort(); stopVolumeReads(); const epoch = ++state.epoch;
    const controller = new AbortController(); state.request = controller; state.busy = true;
    for (const record of state.volumes.values()) record.stale = true;
    state.message = action === 'play' ? 'Starting playback…' : 'Updating Sonos…'; render();
    let submitted = false, outcomeReported = false;
    try {
      const review = await api(BASE + '/devices/' + encodeURIComponent(targetId) + '/review', controller, 'POST', {action, params}, 45000);
      if (!current(epoch, controller)) return;
      if (typeof review.review_id !== 'string' || !review.review_id || review.action !== action || review.device?.id !== targetId)
        throw Error('Sonos could not confirm the requested command. Nothing was submitted.');
      submitted = true;
      const result = await api(BASE + '/execute', controller, 'POST', {review_id: review.review_id, request_id: crypto.randomUUID()}, 45000);
      if (!current(epoch, controller)) return;
      outcomeReported = true;
      state.message = result.summary || 'Sonos command finished. Checking playback…';
      if (result.outcome === 'unknown' || result.ok === false) window.showToast?.(state.message, 'warn', 6000);
      // An acknowledgment alone cannot keep a playing banner on screen.
      if (!volumeContext) {state.data = null; clearVolumes(); state.status = 'Checking playback…';}
      render();
    } catch (error) {
      if (epoch !== state.epoch || controller !== state.request || !allowed()) return;
      outcomeReported = true;
      if (error.status === 401 || error.status === 403) {fail(error); return;}
      if (!volumeContext) {state.data = null; clearVolumes(); state.status = 'Playback needs a fresh check.';}
      state.message = submitted ? 'The command may have reached Sonos. It was not retried. Check Recent activity before repeating it.'
        : error.name === 'AbortError' ? 'Could not prepare the command. Nothing was submitted.' : error.message;
      window.showToast?.(state.message, 'warn', 6000); render();
    } finally {
      if (epoch === state.epoch && controller === state.request) {
        if (controller.signal.aborted && !outcomeReported) {
          if (!volumeContext) {state.data = null; clearVolumes(); state.status = 'Playback needs a fresh check.';}
          state.message = submitted ? 'The command may have reached Sonos. It was not retried. Check Recent activity before repeating it.'
            : 'Could not prepare the command. Nothing was submitted.';
          window.showToast?.(state.message, 'warn', 6000);
        }
        state.request = null; state.busy = false; render();
        // Read the displayed coordinator again, even when a child room was
        // adjusted. Its receipt may describe a different group after regrouping.
        if (volumeContext) syncVolumes(true, focusId);
        refresh();
      }
    }
  }
  const volumeGroups = () => [...new Map([chosen(playing()), chosen(groups())].filter(Boolean).map(group => [group.device_id, group])).values()];
  const volumeCurrent = (record, controls) => allowed() && state.ready && !state.busy && !record.stale &&
    state.volumes.get(record.id) === record && record.controls === controls && volumeGroups().some(group => group.device_id === record.id);
  function stopVolumeReads() {
    for (const record of state.volumes.values()) {record.request?.abort(); record.request = null;}
  }
  function clearVolumes() {
    stopVolumeReads(); state.volumes.clear();
    for (const view of state.volumeViews.values()) {
      view.record = null; view.controls = null; view.open = false; view.editing = null;
      view.inline.replaceChildren(); view.mixer.replaceChildren(); view.note.textContent = ''; toggleMixer(view, false); view.root.hidden = true;
    }
  }
  function volumeEditing(record) {
    return [...state.volumeViews.values()].some(view => view.record === record &&
      (view.editing || (view.root.contains(document.activeElement) && document.activeElement?.type === 'range')));
  }
  function validVolumes(value) {
    const level = number => Number.isInteger(number) && number >= 0 && number <= 100;
    return value && Array.isArray(value.rooms) && new Set(value.rooms.map(room => room.device_id)).size === value.rooms.length &&
      value.rooms.every(room => typeof room.device_id === 'string' && room.device_id && typeof room.name === 'string' &&
        level(room.volume) && level(room.volume_cap) && typeof room.muted === 'boolean') &&
      (value.group == null || (value.rooms.length >= 1 && level(value.group.volume) && level(value.group.max) && typeof value.group.muted === 'boolean'));
  }
  function syncVolumes(force = false, focusId = null) {
    if (!allowed() || !state.ready || state.busy) return;
    const targets = volumeGroups(), ids = new Set(targets.map(group => group.device_id));
    for (const [id, record] of state.volumes) if (!ids.has(id)) {record.request?.abort(); state.volumes.delete(id);}
    for (const group of targets) {
      let record = state.volumes.get(group.device_id);
      const membership = JSON.stringify([group.uid, group.member_names]);
      if (record && record.membership !== membership) {record.request?.abort(); state.volumes.delete(record.id); record = null;}
      if (!record) {
        record = {id: group.device_id, membership, controls: null, request: null, stale: true, error: ''}; state.volumes.set(record.id, record);
      }
      if (!record.request && (!record.controls || force) && (!volumeEditing(record) || record.stale)) readVolumes(record, focusId);
    }
    renderVolumes();
  }
  async function readVolumes(record, focusId) {
    const epoch = state.epoch, controller = new AbortController(); record.request = controller;
    const fresh = () => epoch === state.epoch && state.volumes.get(record.id) === record && record.request === controller && allowed();
    record.error = ''; renderVolumes();
    try {
      const data = await api(BASE + '/devices/' + encodeURIComponent(record.id) + '/volume-controls', controller, 'GET', null, 28000);
      if (!fresh() || controller.signal.aborted) return;
      if (data.device_id !== record.id || !validVolumes(data.volume_controls)) throw Error('Sonos returned incomplete volume levels.');
      // A read started before a drag must not move the thumb underneath it.
      if (volumeEditing(record) && !record.stale) return;
      record.controls = data.volume_controls; record.stale = false;
    } catch (error) {
      if (!fresh()) return;
      if (error.status === 401 || error.status === 403) {fail(error); return;}
      record.stale = true; record.error = 'Volume unavailable. Try again.';
    } finally {
      if (fresh()) {
        if (controller.signal.aborted) {record.stale = true; record.error = 'Volume check timed out. Try again.';}
        record.request = null; renderVolumes();
        if (focusId && document.activeElement === document.body && !$(focusId)?.disabled) $(focusId)?.focus?.({preventScroll: true});
      }
    }
  }
  function speakerIcon(muted = false) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) icon.setAttribute(key, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M11 4 5 9H2v6h3l6 5V4Z ' + (muted ? 'm5 5 6 6m0-6-6 6' : 'M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14'));
    icon.append(path); return icon;
  }
  function volumeRow(view, record, room, group, inline = false) {
    const controls = record.controls, prefix = view.prefix, name = group ? 'Group Volume' : room.name;
    const id = inline ? prefix + '-volume-range' : group ? prefix + '-volume-group' : prefix + '-volume-room-' + room.device_id;
    const cap = group ? room.max : room.volume_cap, row = make('div', null, 'sonos-mini-volume-row');
    const heading = make('div', null, 'sonos-mini-volume-heading'), label = make('label', name); label.setAttribute('for', id);
    const output = make('output', String(room.volume)); output.id = inline ? prefix + '-volume-value' : id + '-value'; output.setAttribute('for', id);
    heading.append(label, output);
    const slider = make('input'); slider.type = 'range'; slider.id = id; slider.min = '0'; slider.max = String(cap); slider.step = '1';
    slider.value = String(Math.min(cap, room.volume)); slider.setAttribute('aria-label', name + ' volume');
    slider.setAttribute('aria-valuetext', room.volume + ' out of 100; limit ' + cap);
    slider.title = name + ' · Limit ' + cap;
    const valid = () => view.record === record && view.controls === controls && volumeCurrent(record, controls);
    const commit = (action, params, focus) => {
      if (!valid()) return;
      const displayed = groups().find(item => item.device_id === record.id);
      command(action, displayed, params, group ? record.id : room.device_id, {record, controls}, focus);
    };
    const mute = button(inline ? prefix + '-volume-mute' : id + '-mute', null,
      () => commit(group ? 'group_mute' : 'mute', {muted: !room.muted}, mute.id), 'sonos-mini-mute');
    mute.append(speakerIcon(room.muted)); mute.setAttribute('aria-label', (room.muted ? 'Unmute ' : 'Mute ') + name);
    mute.setAttribute('aria-pressed', String(room.muted)); mute.title = (room.muted ? 'Unmute ' : 'Mute ') + name;
    const preview = () => {
      output.textContent = slider.value; slider.setAttribute('aria-valuetext', slider.value + ' out of 100; limit ' + cap);
      slider.style.backgroundSize = (cap ? Number(slider.value) / cap * 100 : 0) + '% 100%';
    };
    const release = () => {if (view.editing === slider) view.editing = null;};
    slider.addEventListener('pointerdown', () => {if (valid()) view.editing = slider;});
    for (const event of ['pointerup', 'pointercancel', 'blur']) slider.addEventListener(event, release);
    slider.addEventListener('input', () => {if (valid()) {view.editing = slider; preview();}});
    slider.addEventListener('change', () => {
      release(); if (!valid()) return;
      const value = Number(slider.value); if (!Number.isInteger(value) || value < 0 || value > cap) return;
      preview(); if (value !== room.volume) commit(group ? 'group_volume' : 'volume', {volume: value}, slider.id);
    });
    slider.style.backgroundSize = (cap ? Number(slider.value) / cap * 100 : 0) + '% 100%';
    const line = make('div', null, 'sonos-mini-volume-line'); line.append(mute, slider);
    if (inline) {
      label.textContent = group ? 'Group' : 'Volume'; row.classList.add('is-inline'); row.append(label, line, output);
    } else {row.append(heading, line);}
    return row;
  }
  function toggleMixer(view, open = !view.open) {
    view.open = open; view.mixer.hidden = !open; view.toggle.setAttribute('aria-expanded', String(open));
  }
  function createVolumeView(prefix) {
    const root = make('div', null, 'sonos-mini-volume'); root.id = prefix + '-volume'; root.hidden = true;
    const inline = make('div', null, 'sonos-mini-volume-main'), mixer = make('div', null, 'sonos-mini-mixer');
    mixer.id = prefix + '-volume-mixer'; mixer.hidden = true; mixer.setAttribute('aria-label', 'Sonos room volumes');
    const toggle = button(prefix + '-volume-toggle', 'Rooms', () => {
      if (!allowed() || state.busy) return;
      for (const other of state.volumeViews.values()) if (other !== view) toggleMixer(other, false);
      toggleMixer(view);
    }, 'sonos-mini-volume-toggle');
    toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', mixer.id);
    const note = make('span', null, 'sonos-mini-volume-note'); note.id = prefix + '-volume-note';
    const retry = button(prefix + '-volume-retry', 'Retry', () => {if (view.record && allowed() && !state.busy && !view.record.request) readVolumes(view.record);}, 'sonos-mini-volume-toggle');
    root.append(inline, toggle, note, retry, mixer);
    const view = {prefix, root, inline, toggle, mixer, note, retry, open: false, editing: null, record: null, controls: null};
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && view.open) {toggleMixer(view, false); toggle.focus(); event.preventDefault();}
    });
    root.addEventListener('focusout', event => {if (event.relatedTarget && !root.contains(event.relatedTarget)) toggleMixer(view, false);});
    state.volumeViews.set(prefix, view); return root;
  }
  function renderVolumes() {
    for (const view of state.volumeViews.values()) {
      const group = chosen(view.prefix === 'sonos-quick' ? playing() : groups()), record = state.volumes.get(group?.device_id);
      view.root.hidden = !allowed() || !state.ready || !group;
      if (view.record !== record || view.controls !== record?.controls) {
        const sameRoom = view.record === record;
        view.record = record; view.controls = record?.controls; view.editing = null;
        view.inline.replaceChildren(); view.mixer.replaceChildren();
        if (!sameRoom) toggleMixer(view, false);
        const controls = record?.controls;
        if (controls) {
          const grouped = controls.rooms.length > 1 && !!controls.group;
          const partial = !controls.group && !!controls.reason;
          const master = grouped ? controls.group : controls.rooms.length === 1 && !partial ? controls.rooms[0] : null;
          if (master) view.inline.append(volumeRow(view, record, master, grouped, true));
          if (controls.rooms.length > 1 || (partial && controls.rooms.length)) {
            view.mixer.append(make('strong', 'Room volumes', 'sonos-mini-mixer-title'));
            for (const room of controls.rooms) view.mixer.append(volumeRow(view, record, room, false));
            if (controls.group) view.mixer.append(volumeRow(view, record, controls.group, true));
            if (controls.reason) view.mixer.append(make('p', controls.reason, 'sonos-mini-volume-note'));
          }
        }
      }
      const controls = record?.controls, hasMixer = controls?.rooms.length > 1 || (controls?.rooms.length && !controls.group && controls.reason);
      view.toggle.hidden = !hasMixer; view.toggle.textContent = hasMixer ? controls.rooms.length + (controls.rooms.length === 1 ? ' room' : ' rooms') : 'Rooms';
      view.toggle.disabled = state.busy || !allowed();
      if (!hasMixer) toggleMixer(view, false);
      view.note.textContent = record?.error || (!controls ? 'Checking volume…' : !controls.rooms.length ? controls.reason || 'Volume unavailable' : '');
      view.note.hidden = !view.note.textContent; view.retry.hidden = !record?.error; view.retry.disabled = !!record?.request || state.busy;
      for (const control of [...view.inline.querySelectorAll('input, button'), ...view.mixer.querySelectorAll('input, button')])
        control.disabled = !record || record.stale || state.busy || !allowed();
    }
  }
  function options(id, rows) {
    const select = $(id), signature = JSON.stringify(rows.map(group => [group.device_id, group.name]));
    if (select.dataset.options !== signature) {
      select.dataset.options = signature;
      select.replaceChildren(...rows.map(group => {const option = make('option', group.name); option.value = group.device_id; return option;}));
    }
    select.value = chosen(rows)?.device_id || '';
    select.hidden = rows.length < 2; select.disabled = state.busy || !allowed();
  }
  function description(group) {
    if (!group) return '';
    return [group.name, group.artist, group.source?.label].filter(value => typeof value === 'string' && value).join(' · ');
  }
  function render() {
    if (!state.installed) return;
    const active = chosen(playing()), room = chosen(groups()), enabled = allowed() && state.ready;
    $('sonos-quick-player').hidden = !enabled || !state.hasDevices || !active;
    $('dashboard-sonos').hidden = !enabled || !state.hasDevices;
    text('sonos-quick-title', active?.title || (active ? 'Playing on Sonos' : ''));
    text('sonos-quick-meta', description(active)); options('sonos-quick-room', playing());
    for (const id of ['previous', 'pause', 'next', 'open']) $('sonos-quick-' + id).disabled = !enabled || state.busy || !active;
    const label = state.status || (!state.data?.devices_count ? 'No Sonos rooms connected' : !groups().length ? 'Sonos is unavailable'
      : room?.playback === 'PLAYING' ? 'Playing on Sonos' : room?.playback === 'PAUSED_PLAYBACK' ? 'Sonos is paused'
      : room?.playback === 'TRANSITIONING' ? 'Starting music…' : 'Sonos is connected');
    text('sonos-dashboard-state', label);
    text('sonos-dashboard-title', room?.title || (room ? 'Your rooms are ready' : 'Your Sonos rooms'));
    text('sonos-dashboard-meta', description(room)); options('sonos-dashboard-room', groups());
    const play = $('sonos-dashboard-play'); play.hidden = !room;
    play.textContent = room?.playback === 'PLAYING' ? 'Pause' : 'Play';
    play.disabled = !enabled || state.busy || !room || !['PLAYING', 'PAUSED_PLAYBACK', 'STOPPED'].includes(room.playback);
    $('sonos-dashboard-open').disabled = !enabled || state.busy;
    $('sonos-dashboard-refresh').disabled = !allowed() || !!state.request || state.busy;
    text('sonos-dashboard-note', state.data?.partial ? 'Some rooms could not be checked. Available rooms are shown.'
      : 'Updates automatically while TLI is open.');
    text('sonos-player-message', state.message); $('sonos-player-message').hidden = !state.message;
    $('dashboard-sonos').dataset.state = state.locked || state.denied ? 'locked' : active ? 'playing' : room ? 'connected' : 'unavailable';
    renderVolumes();
  }
  function open(group) {
    if (!allowed() || !state.ready || state.busy) return;
    window.TLISonos?.open?.(group?.device_id);
  }
  function install() {
    if (!$('sonos-quick-player') || !$('dashboard-sonos')) return;
    const quick = $('sonos-quick-player'), info = make('div', null, 'sonos-quick-info');
    const badge = make('span', 'SONOS', 'sonos-quick-badge');
    const title = make('strong'); title.id = 'sonos-quick-title'; const meta = make('span'); meta.id = 'sonos-quick-meta';
    const picker = make('select'); picker.id = 'sonos-quick-room'; picker.setAttribute('aria-label', 'Playing Sonos group');
    info.append(title, meta); const controls = make('div', null, 'sonos-quick-controls');
    for (const [action, glyph, label] of [['previous', 'Ⅰ◀', 'Previous track'], ['pause', 'Ⅱ', 'Pause Sonos'], ['next', '▶Ⅰ', 'Next track']]) {
      const control = button('sonos-quick-' + action, glyph, () => command(action, chosen(playing())), 'sonos-quick-transport');
      control.setAttribute('aria-label', label); control.title = label; controls.append(control);
    }
    const details = button('sonos-quick-open', '•••', () => open(chosen(playing())), 'sonos-quick-open');
    details.setAttribute('aria-label', 'Open Sonos rooms'); details.title = 'Open Sonos rooms'; controls.append(details);
    quick.append(badge, info, picker, controls, createVolumeView('sonos-quick'));
    const dashboard = $('dashboard-sonos'), head = make('div', null, 'sonos-dashboard-head');
    const heading = make('h2', 'Sonos'); heading.id = 'sonos-dashboard-heading';
    const status = make('span'); status.id = 'sonos-dashboard-state'; head.append(heading, status);
    const track = make('h3'); track.id = 'sonos-dashboard-title'; const detail = make('p'); detail.id = 'sonos-dashboard-meta';
    const rooms = make('select'); rooms.id = 'sonos-dashboard-room'; rooms.setAttribute('aria-label', 'Sonos group');
    const actions = make('div', null, 'sonos-dashboard-actions');
    actions.append(button('sonos-dashboard-play', 'Play', () => {const room = chosen(groups()); command(room?.playback === 'PLAYING' ? 'pause' : 'play', room);}, 'btn-primary'),
      button('sonos-dashboard-open', 'Manage rooms', () => open(chosen(groups()))),
      button('sonos-dashboard-refresh', 'Refresh', () => refresh(), 'btn-ghost'));
    const note = make('p'); note.id = 'sonos-dashboard-note'; const message = make('p'); message.id = 'sonos-player-message'; message.setAttribute('role', 'status');
    dashboard.append(head, track, detail, rooms, createVolumeView('sonos-dashboard'), actions, note, message);
    for (const el of [picker, rooms]) el.addEventListener('change', () => {
      if (!allowed() || state.busy) return;
      const choices = el === picker ? playing() : groups();
      if (choices.some(group => group.device_id === el.value)) {state.selected = el.value; render(); syncVolumes();}
    });
    document.addEventListener('pointerdown', event => {
      for (const view of state.volumeViews.values()) if (view.open && !view.root.contains(event.target)) toggleMixer(view, false);
    });
    state.installed = true; state.hidden = document.hidden; render(); refresh();
  }
  window.addEventListener('tli-session-locked', locked);
  for (const name of ['tli-user-changed', 'tli-account-changed']) window.addEventListener(name, locked);
  window.addEventListener('tli-session-unlocked', event => {
    if (event?.detail?.source === 'pin-verification') {
      state.locked = false; state.denied = false; state.failures = 0; clearView('Checking your Sonos connection…'); refresh();
    } else {state.locked = false; render(); if (!state.denied) refresh();}
  });
  window.addEventListener('tli-private-observation-ready', () => {
    if (!state.installed || state.locked || !visible() || state.ready) return;
    // A protected access-ready signal can recover PIN-disabled local access,
    // but this feature still performs its own fresh admission before polling.
    state.denied = false; refresh();
  });
  document.addEventListener('visibilitychange', () => {
    state.hidden = document.hidden;
    if (state.hidden) clearView('Sonos updates resume when you return.'); else refresh();
  });
  window.addEventListener('pagehide', () => {state.hidden = true; clearView('Sonos updates resume when you return.');});
  window.addEventListener('pageshow', () => {state.hidden = document.hidden; refresh();});
  window.addEventListener('tli-sonos-changed', () => {
    if (!allowed() || state.busy) return;
    clearView('Checking Sonos…'); refresh();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once: true}); else install();
})();
