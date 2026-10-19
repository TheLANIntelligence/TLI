/* Sonos rooms. Opening this panel reads saved enrollment, never the speakers. */
(() => {
  'use strict';
  const BASE = '/api/sonos';
  const state = {epoch: 0, busy: false, locked: false, rows: [], candidates: [], discoveryExpires: 0,
    discoveryTimer: null, review: null, reviewTimer: null, reviewEpoch: 0, requestId: null, abort: null, expanded: null,
    topology: null, topologyState: 'unknown', topologySource: 'status', volumes: null, volumesStale: false, pendingOpen: null};
  const $ = id => document.getElementById(id);
  const make = (tag, text, cls) => {const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n;};
  const say = text => {if ($('sonos-message')) $('sonos-message').textContent = text;};
  const selected = () => state.rows.find(d => d.id === $('sonos-device')?.value);
  function button(text, handler, id) {
    const n = make('button', text, 'btn-outline'); n.type = 'button'; if (id) n.id = id;
    n.addEventListener('click', handler); return n;
  }
  function selection(id, label) {
    const l = make('label', label), n = make('select'); n.id = id; n.className = 'field-input'; l.append(n); return l;
  }
  const needs = n => {n.dataset.needsSpeaker = '1'; return n;};
  function roomLabel(row) {
    const parts = [row.name || 'Sonos speaker'];
    if (row.room && row.room !== row.name) parts.push(row.room);
    if (row.model) parts.push(row.model);
    if (state.rows.filter(r => r.name === row.name && r.room === row.room && r.model === row.model).length > 1)
      parts.push('Speaker ' + row.id.slice(-6));
    return parts.join(' · ');
  }
  function memberLabel(member) {
    const saved = member.uid ? state.rows.find(row => row.uid === member.uid) : null;
    return saved ? roomLabel(saved) : member.name || 'Sonos speaker';
  }
  function selectedGroup() {
    const row = selected();
    return row && state.topology?.groups.find(group => group.members.some(member => member.uid === row.uid || member.device_id === row.id));
  }
  function resetTopology() {state.topology = null; state.topologyState = 'unknown'; state.topologySource = 'status'; renderTopology();}
  function staleTopology() {state.topologyState = state.topology ? 'stale' : 'unknown'; renderTopology();}
  function showTopology(topology, source = 'status') {
    if (!topology || !Array.isArray(topology.groups) || !topology.groups.length) {resetTopology(); return;}
    state.topology = topology; state.topologyState = 'current'; state.topologySource = source; renderTopology();
  }
  function renderTopology() {
    const panel = $('sonos-topology'), content = $('sonos-topology-content'); if (!panel || !content) return;
    panel.dataset.state = state.topologyState; content.replaceChildren();
    const row = selected(), current = selectedGroup();
    const lastChecked = state.topology?.checked_at, date = new Date(lastChecked);
    const checked = lastChecked && Number.isFinite(date.getTime()) ? 'Last checked ' + date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : 'Check time unavailable';
    $('sonos-topology-note').textContent = state.topologyState === 'unknown'
      ? 'Group not checked. Refresh group to see which speakers belong together.'
      : checked + (state.topologyState === 'stale' ? ' · Refresh needed. The grouping may have changed.' : ' · Reported by Sonos; other controllers can change it.')
        + (state.topologySource === 'review' ? ' Showing groups checked for this action; refresh to see all saved groups.' : '');
    $('sonos-scope').textContent = row ? 'Playback controls the whole group. Use each room’s volume or adjust the group together.' : '';
    const groups = [...(state.topology?.groups || [])].sort((a, b) => Number(b === current) - Number(a === current));
    for (const group of groups) {
      const card = make('section', null, 'sonos-group-card' + (group === current ? ' sonos-group-selected' : ''));
      card.dataset.coordinator = group.coordinator || ''; card.dataset.selected = String(group === current);
      const coordinator = group.members.find(member => member.uid === group.coordinator);
      const header = make('div', null, 'sonos-group-heading');
      header.append(make('h5', coordinator?.name || 'Group leader unavailable in TLI'),
        make('span', group === current ? 'Selected group' : 'Separate group', 'sonos-group-badge'));
      card.append(header, make('p', group.member_count + ' speaker' + (group.member_count === 1 ? '' : 's') + ' in this reported group', 'sonos-muted'));
      const list = make('ul', null, 'sonos-member-list'), visited = new Set();
      const appendMember = (member, parent, depth = 0) => {
        if (visited.has(member.uid) || depth > 64) return; visited.add(member.uid);
        const item = make('li', null, 'sonos-group-member'); item.dataset.uid = member.uid;
        const isSelected = row && (row.uid === member.uid || row.id === member.device_id);
        const title = make('div', null, 'sonos-member-title'); title.append(make('strong', member.name || 'Sonos speaker'));
        if (member.uid === group.coordinator) title.append(make('span', 'Group leader', 'sonos-member-badge'));
        if (isSelected) {title.append(make('span', 'Selected speaker', 'sonos-member-badge')); item.setAttribute('aria-current', 'true');}
        const detail = [member.model || 'Model unavailable'];
        if (group.members.filter(m => m.name === member.name && m.model === member.model).length > 1)
          detail.push('Speaker ' + (member.device_id || member.uid).slice(-6));
        const source = member.bond_source;
        if (source === 'satellite') detail.push('Bonded speaker');
        else if (source === 'channel_map' || source === 'home_theater_map' || source === 'satellite_parent') detail.push('Bonded set');
        else if (member.bonded) detail.push('Sonos-managed speaker · role not reported');
        if (member.parent_uid && !group.members.some(m => m.uid === member.parent_uid)) detail.push('Parent not shown');
        item.append(title, make('p', detail.join(' · '), 'sonos-muted')); parent.append(item);
        const children = group.members.filter(m => m.parent_uid === member.uid && m.uid !== member.uid);
        if (children.length) {const nested = make('ul', null, 'sonos-member-list sonos-bonded-members'); item.append(nested); for (const child of children) appendMember(child, nested, depth + 1);}
      };
      for (const member of group.members) if (!member.parent_uid || !group.members.some(m => m.uid === member.parent_uid) || member.parent_uid === member.uid) appendMember(member, list);
      for (const member of group.members) if (!visited.has(member.uid)) appendMember(member, list);
      card.append(list);
      if (!group.complete) card.append(make('p', 'Some speakers are not saved in TLI or their connection changed. Find and add them before controlling the whole group.', 'sonos-group-notice'));
      content.append(card);
    }
    const restricted = current?.members.some(member => member.bonded);
    $('sonos-group-guidance').textContent = state.topologyState !== 'current' || !current
      ? 'Refresh group before changing which rooms play together.'
      : restricted ? 'This group includes a bonded or Sonos-managed set. Change its grouping in the Sonos app.'
      : !current.complete ? 'Add the missing speakers before changing this group.'
      : 'Join another ordinary room, or separate this speaker from its current group.';
    sync();
  }
  function sync() {
    const box = $('sonos-box'); if (!box) return;
    const blocked = state.busy || state.locked, row = selected();
    for (const e of box.querySelectorAll('button,input,select')) e.disabled = blocked;
    for (const e of box.querySelectorAll('[data-needs-speaker]')) e.disabled = blocked || !row;
    for (const e of box.querySelectorAll('[data-room-volume-control]')) e.disabled = blocked || !row || state.volumesStale;
    for (const e of box.querySelectorAll('[data-discovery-id]'))
      e.disabled = blocked || Date.now() >= state.discoveryExpires || e.dataset.connected === 'true';
    $('sonos-run').disabled = blocked || !state.review;
    $('sonos-confirmation').hidden = !state.review;
    $('sonos-player').hidden = !row;
    $('sonos-empty').hidden = !!row;
    $('sonos-discovery').hidden = !$('sonos-found').children.length;
    for (const name of ['favorites', 'groups', 'activity']) {
      const visible = state.expanded === name && (name === 'activity' || !!row);
      $('sonos-' + name + '-panel').hidden = !visible;
      $('sonos-' + name + '-open').setAttribute('aria-expanded', String(visible));
    }
    $('sonos-play-favorite').disabled = blocked || !row || !$('sonos-favorite').value;
    const current = selectedGroup(), destination = $('sonos-destination').value;
    const targetGroup = state.topology?.groups.find(group => group.members.some(member => member.device_id === destination));
    const mayGroup = state.topologyState === 'current' && current?.complete && !current.members.some(member => member.bonded);
    $('sonos-join').disabled = blocked || !row || !mayGroup || !destination || !targetGroup?.complete || targetGroup === current || targetGroup.members.some(member => member.bonded);
    $('sonos-leave').disabled = blocked || !row || !mayGroup || current.member_count < 2;
  }
  function invalidate() {
    clearTimeout(state.reviewTimer); state.reviewTimer = null; state.review = null; state.requestId = null; state.reviewEpoch++;
    $('sonos-review')?.replaceChildren(); sync();
  }
  function clearDiscovery() {
    clearTimeout(state.discoveryTimer); state.discoveryTimer = null; state.discoveryExpires = 0;
    state.candidates = []; $('sonos-found')?.replaceChildren();
  }
  function stopWaiting() {state.epoch++; state.abort?.abort(); state.abort = null; state.busy = false;}
  function clear() {
    stopWaiting(); clearDiscovery(); state.rows = []; state.expanded = null; state.pendingOpen = null; resetVolumes(); resetTopology();
    for (const id of ['sonos-device', 'sonos-destination', 'sonos-favorite', 'sonos-status', 'sonos-receipts', 'sonos-room-name', 'sonos-room-model']) $(id)?.replaceChildren();
    $('sonos-volume').max = '35'; $('sonos-volume').value = '20'; volumeLabel(); $('sonos-volume-limit').textContent = 'Limit 35';
    invalidate(); say('Choose Refresh rooms to load your saved speakers.');
  }
  async function api(path, method = 'GET', payload) {
    const response = await fetch(BASE + path, {method, credentials: 'same-origin', cache: 'no-store', signal: state.abort?.signal,
      headers: {Accept: 'application/json', ...(payload ? {'Content-Type': 'application/json'} : {})},
      ...(payload ? {body: JSON.stringify(payload)} : {})});
    const value = await response.json();
    if (!response.ok) throw Error(typeof value.detail === 'string' ? value.detail : 'Sonos request failed.');
    if (value.protocol !== 'tli-sonos-v1') throw Error('Unsupported Sonos response.');
    return value;
  }
  async function work(text, fn, restoreFocusId) {
    if (state.busy || state.locked) return;
    state.busy = true; state.abort = new AbortController();
    const controller = state.abort, epoch = state.epoch;
    say(text); sync(); const timer = setTimeout(() => controller.abort(), 45000);
    try {await fn(epoch);}
    catch (error) {if (epoch === state.epoch) say(error.name === 'AbortError'
      ? 'Stopped waiting. Check Recent activity and refresh status before trying the action again.' : error.message);}
    finally {clearTimeout(timer); if (epoch === state.epoch) {
      state.busy = false; state.abort = null; sync();
      // Rebuilding checked levels must not strand keyboard users after one
      // adjustment. Respect focus moved elsewhere while the request ran.
      if (restoreFocusId && document.activeElement === document.body && !$(restoreFocusId)?.disabled)
        $(restoreFocusId)?.focus?.({preventScroll: true});
    }}
  }
  function volumeLabel() {$('sonos-volume-value').textContent = $('sonos-volume').value;}
  function resetVolumes() {
    state.volumes = null; state.volumesStale = false;
    $('sonos-room-volumes')?.replaceChildren();
    if ($('sonos-room-volumes')) $('sonos-room-volumes').hidden = true;
    if ($('sonos-single-volume')) $('sonos-single-volume').hidden = false;
  }
  function staleVolumes() {
    if (!state.volumes) return;
    state.volumesStale = true;
    $('sonos-volume-note').textContent = 'Refresh status to check each room’s volume before adjusting it again.';
    sync();
  }
  function showVolumes(controls) {
    if (!controls || !Array.isArray(controls.rooms)) {resetVolumes(); return;}
    state.volumes = controls; state.volumesStale = false;
    const epoch = state.epoch, box = $('sonos-room-volumes'); box.replaceChildren(); box.hidden = false;
    $('sonos-single-volume').hidden = true;
    const current = () => state.volumes === controls && epoch === state.epoch && !state.volumesStale && !state.busy && !state.locked;
    const rowControl = (room, group = false) => {
      const name = group ? 'Group Volume' : room.name || 'Sonos room';
      const id = group ? 'sonos-group-volume' : 'sonos-volume-' + room.device_id;
      const cap = Math.max(0, Math.min(100, Number(group ? room.max : room.volume_cap) || 0));
      const row = make('div', null, 'sonos-volume-row' + (group ? ' sonos-group-volume-row' : ''));
      if (!group) row.dataset.volumeDevice = room.device_id;
      const heading = make('div', null, 'sonos-volume-title'), label = make('label', name); label.setAttribute('for', id);
      const output = make('output', String(room.volume)); output.setAttribute('for', id);
      heading.append(label, output, make('span', 'Limit ' + cap, 'sonos-muted'));
      const line = make('div', null, 'sonos-volume-line');
      const icon = make('span', null, 'sonos-volume-icon' + (room.muted ? ' is-muted' : '')); icon.setAttribute('aria-hidden', 'true');
      if (group) line.append(icon);
      else {
        const mute = button('', () => {if (current()) review('mute', {muted: !room.muted}, true, room.device_id);});
        mute.id = 'sonos-mute-' + room.device_id; mute.className = 'sonos-volume-mute'; mute.dataset.roomVolumeControl = '1';
        const title = (room.muted ? 'Unmute ' : 'Mute ') + name;
        mute.setAttribute('aria-label', title); mute.setAttribute('title', title); mute.setAttribute('aria-pressed', String(!!room.muted));
        mute.append(icon); line.append(mute);
      }
      const slider = make('input'); slider.id = id; slider.type = 'range'; slider.min = '0'; slider.max = String(cap);
      slider.step = '1'; slider.value = String(Math.max(0, Math.min(cap, room.volume))); slider.dataset.roomVolumeControl = '1';
      slider.setAttribute('aria-label', name + ' volume');
      slider.setAttribute('aria-valuetext', room.volume + ' out of 100');
      const preview = () => {output.textContent = slider.value; slider.setAttribute('aria-valuetext', slider.value + ' out of 100');};
      slider.addEventListener('input', () => {if (current()) {invalidate(); preview();}});
      slider.addEventListener('change', () => {
        if (!current()) return;
        invalidate(); preview();
        const volume = Math.max(0, Math.min(cap, Number(slider.value)));
        if (volume === room.volume) return;
        review(group ? 'group_volume' : 'volume', {volume}, true, group ? undefined : room.device_id);
      });
      line.append(slider); row.append(heading, line); box.append(row);
    };
    for (const room of controls.rooms) rowControl(room);
    if (controls.rooms.length > 1 && controls.group) rowControl(controls.group, true);
    const note = make('p', controls.reason || ('Release a slider to set the volume.' + (controls.rooms.length > 1 ? ' Group Volume keeps the room balance where limits allow.' : '')), 'sonos-muted');
    note.id = 'sonos-volume-note'; box.append(note); sync();
  }
  function setRoom() {
    resetVolumes();
    const row = selected();
    $('sonos-room-name').textContent = row?.name || '';
    $('sonos-room-model').textContent = row ? roomLabel(row) : '';
    $('sonos-volume').max = String(row?.volume_cap ?? 35);
    $('sonos-volume').value = String(Math.min(20, row?.volume_cap ?? 35)); volumeLabel();
    $('sonos-volume-limit').textContent = 'Limit ' + (row?.volume_cap ?? 35);
    $('sonos-status').replaceChildren(make('p', 'Refresh status to see what’s playing.', 'sonos-muted'));
    $('sonos-favorite').replaceChildren(); state.expanded = null; invalidate();
    resetTopology();
  }
  function render() {
    const prior = $('sonos-device').value;
    for (const id of ['sonos-device', 'sonos-destination']) {
      const s = $(id), placeholder = make('option', id === 'sonos-device' ? 'Choose a room or speaker' : 'Choose another room');
      placeholder.value = ''; s.replaceChildren(placeholder);
      for (const row of state.rows) {const option = make('option', roomLabel(row)); option.value = row.id; s.append(option);}
    }
    if (state.rows.some(r => r.id === prior)) $('sonos-device').value = prior;
    setRoom();
  }
  async function load(epoch) {
    const d = await api('/devices'); if (epoch !== state.epoch || state.abort?.signal.aborted) return;
    state.rows = d.devices; render();
    say(d.availability.music ? (state.rows.length ? 'Choose a room to control its music.' : 'Find speakers to connect your Sonos rooms.')
      : 'Sonos needs its optional packages installed on this TLI computer.');
    return true;
  }
  function list() {
    if (state.busy || state.locked) return;
    const pending = state.pendingOpen, epoch = state.epoch; let loaded = false;
    return work('Loading saved rooms…', async epoch => {loaded = await load(epoch) === true;}).then(() => {
      if (!loaded || !pending || pending !== state.pendingOpen || epoch !== state.epoch || state.locked) return;
      state.pendingOpen = null;
      const row = pending.id ? state.rows.find(room => room.id === pending.id) : state.rows[0];
      if (!row) return;
      $('sonos-device').value = row.id; setRoom(); return read();
    });
  }
  function open(id) {
    if (state.locked || state.busy) return;
    state.pendingOpen = {id};
    if (typeof window.switchPanel === 'function') {
      window.switchPanel('panel-homeauto');
      if ($('panel-homeauto').hidden) state.pendingOpen = null;
    } else list();
    $('sonos-box')?.scrollIntoView?.({block: 'start', behavior: 'smooth'});
  }
  function renderFound() {
    const box = $('sonos-found'); box.replaceChildren();
    for (const row of state.candidates) {
      const card = make('article', null, 'sonos-speaker-card');
      card.append(make('strong', row.name || 'Sonos speaker'), make('p', row.model || 'Sonos'));
      if (row.room && row.room !== row.name) card.append(make('p', row.room));
      const action = button(row.connected ? 'Added to TLI' : row.already_enrolled ? 'Reconnect speaker' : 'Add to TLI', () => addDiscovered(row));
      action.dataset.discoveryId = row.discovery_id; action.dataset.connected = String(!!row.connected);
      card.append(action); box.append(card);
    }
    if (state.candidates.length) {
      const hint = make('p', Date.now() >= state.discoveryExpires ? 'Search results expired. Choose Find speakers again.' : 'Add the speakers you want, then choose Done.', 'sonos-muted');
      hint.id = 'sonos-discovery-hint'; box.append(hint);
    }
    sync();
  }
  function discover() {return work('Finding Sonos speakers…', async epoch => {
    clearDiscovery(); invalidate();
    const d = await api('/discover', 'POST'); if (epoch !== state.epoch) return;
    state.candidates = (d.candidates || []).map(row => ({...row, connected: false}));
    state.discoveryExpires = Date.now() + Math.max(0, Math.min(120, Number(d.expires_in_seconds) || 0)) * 1000;
    renderFound();
    if (state.candidates.length) {
      state.discoveryTimer = setTimeout(() => {if (epoch === state.epoch) {
        state.discoveryExpires = 0; const hint = $('sonos-discovery-hint');
        if (hint) hint.textContent = 'Search results expired. Choose Find speakers again.'; sync();
      }}, Math.max(0, state.discoveryExpires - Date.now()));
      say(state.candidates.length + ' speakers found.' + (d.partial ? ' Some speakers could not be checked. You can search again.' : ''));
    } else {
      $('sonos-found').append(make('p', 'No speakers found. Check that the Sonos app can see them and that TLI is on the same home network.'));
      say('Choose Find speakers to try again.');
    }
  });}
  function addDiscovered(row) {
    if (row.connected) return;
    if (!state.candidates.includes(row) || Date.now() >= state.discoveryExpires) {say('Search results expired. Choose Find speakers again.'); return;}
    return work('Connecting ' + (row.name || 'Sonos speaker') + '…', async epoch => {
      const result = await api('/devices', 'POST', {discovery_id: row.discovery_id}); if (epoch !== state.epoch) return;
      await load(epoch); if (epoch !== state.epoch) return;
      $('sonos-device').value = result.device.id; row.connected = true; setRoom(); renderFound();
      say(result.device.name + ' is ready. Add more speakers or choose Done.');
      window.dispatchEvent(new CustomEvent('tli-sonos-changed'));
    });
  }
  function showReading(reading = {}, extra = {}) {
    const labels = {PLAYING: 'Playing', PAUSED_PLAYBACK: 'Paused', STOPPED: 'Stopped', TRANSITIONING: 'Changing playback', UNKNOWN: 'Playback unavailable'};
    const box = $('sonos-status'); box.replaceChildren(make('span', labels[reading.playback] || 'Playback unavailable', 'sonos-playback'));
    box.append(make('strong', reading.title || (reading.playback === 'STOPPED' ? 'Nothing playing' : 'Track information unavailable'), 'sonos-track'));
    if (typeof reading.source?.label === 'string' && reading.source.label) box.append(make('p', 'Source: ' + reading.source.label, 'sonos-muted sonos-source'));
    if (reading.reason) box.append(make('p', reading.reason, 'sonos-muted'));
    const facts = [];
    if (typeof reading.volume === 'number') {
      facts.push('Volume ' + reading.volume);
      $('sonos-volume').value = String(Math.min(reading.volume, Number($('sonos-volume').max))); volumeLabel();
    }
    if (typeof reading.muted === 'boolean') facts.push(reading.muted ? 'Muted' : 'Sound on');
    if (facts.length) box.append(make('p', facts.join(' · '), 'sonos-muted'));
    if (extra.checked_at) box.append(make('p', 'Checked ' + new Date(extra.checked_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}), 'sonos-checked'));
  }
  function read() {
    const row = selected(); if (!row) return;
    return work('Checking playback…', async epoch => {
      invalidate(); staleTopology(); staleVolumes();
      const d = await api('/devices/' + encodeURIComponent(row.id) + '/status'); if (epoch !== state.epoch) return;
      $('sonos-volume').max = String(d.device.volume_cap); $('sonos-volume-limit').textContent = 'Limit ' + d.device.volume_cap;
      showReading(d.reading, d); showTopology(d.topology); showVolumes(d.volume_controls);
      say(d.topology ? 'Playback and groups checked.' : 'Playback checked. Restart TLI to load the updated group view.');
    });
  }
  function reviewTitle(d) {
    if (d.action === 'volume') return 'Set volume to ' + d.params.volume + '?';
    if (d.action === 'mute') return d.params.muted ? 'Mute this speaker?' : 'Unmute this speaker?';
    return ({play: 'Play music?', pause: 'Pause music?', stop: 'Stop music?', previous: 'Previous track?', next: 'Next track?',
      favorite: 'Play this favorite?', join: 'Group these rooms?', leave: 'Leave this group?'})[d.action] || 'Confirm this action?';
  }
  function review(action, params = {}, immediate = false, targetId) {
    const row = targetId ? state.rows.find(device => device.id === targetId) : selected(); if (!row) return;
    const focused = document.activeElement;
    const restoreFocusId = focused?.dataset.roomVolumeControl ? focused.id : null;
    return work(immediate ? (action === 'play' ? 'Starting playback…' : 'Sending your Sonos command…') : 'Checking the speakers affected…', async epoch => {
      invalidate(); staleTopology();
      if (['volume', 'mute', 'group_volume'].includes(action)) staleVolumes();
      const revision = state.reviewEpoch;
      const d = await api('/devices/' + encodeURIComponent(row.id) + '/review', 'POST', {action, params});
      if (epoch !== state.epoch || revision !== state.reviewEpoch || state.abort?.signal.aborted) return;
      if (d.topology) showTopology(d.topology, 'review');
      // An explicit player click authorizes this command. Keep preparation and
      // submission in one busy operation so another click cannot duplicate it.
      if (immediate) {await sendCommand(d, crypto.randomUUID(), epoch); return;}
      state.review = d; state.requestId = crypto.randomUUID();
      const box = $('sonos-review'); box.replaceChildren(make('h4', reviewTitle(d)),
        make('p', d.affected.length + ' speaker' + (d.affected.length === 1 ? '' : 's') + ': ' + d.affected.map(memberLabel).join(', ')), make('p', d.effect));
      if (d.favorite_name) box.append(make('strong', d.favorite_name));
      if (d.action === 'favorite') box.append(make('p', 'This replaces the current source and may replace the group’s queue.'));
      const expiry = typeof d.expires_at === 'number' ? d.expires_at * 1000 : Date.parse(d.expires_at);
      const duration = Number.isFinite(expiry) ? Math.max(0, Math.min(120000, expiry - Date.now())) : 120000;
      state.reviewTimer = setTimeout(() => {if (epoch === state.epoch && state.review === d) {
        invalidate(); say('Confirmation expired. Choose the control again to check the current rooms.');
      }}, duration);
      say('Check the affected speakers, then confirm.'); sync(); $('sonos-confirmation').focus?.({preventScroll: true});
    }, restoreFocusId);
  }
  async function sendCommand(reviewed, requestId, epoch) {
    staleTopology();
    const volumeAction = ['volume', 'mute', 'group_volume'].includes(reviewed.action);
    if (volumeAction || ['join', 'leave'].includes(reviewed.action)) staleVolumes();
    const d = await api('/execute', 'POST', {review_id: reviewed.review_id, request_id: requestId}); if (epoch !== state.epoch) return;
    if (d.observed && (!reviewed.device?.id || reviewed.device.id === selected()?.id)) showReading(d.observed);
    else if (!d.observed) $('sonos-status').replaceChildren(make('strong', 'Playback has not been checked'), make('p', 'Refresh status before repeating an uncertain action.', 'sonos-muted'));
    say(d.summary);
    if (volumeAction && state.volumes) {
      if (d.volume_controls && reviewed.device?.id === selected()?.id) showVolumes(d.volume_controls);
      else {
        // Read back all rooms after a committed adjustment. Never resend an
        // effect when delivery or the follow-up observation is uncertain.
        try {
          const updated = await api('/devices/' + encodeURIComponent(selected().id) + '/status');
          if (epoch !== state.epoch || state.abort?.signal.aborted) return;
          showReading(updated.reading, updated); showTopology(updated.topology); showVolumes(updated.volume_controls);
        } catch (error) {
          if (epoch === state.epoch) {staleVolumes(); say(d.summary + ' Room volumes could not be refreshed. Use Refresh status.');}
        }
      }
    }
    if (epoch === state.epoch) window.dispatchEvent(new CustomEvent('tli-sonos-changed'));
  }
  function execute() {
    if (!state.review) return;
    const reviewed = state.review, requestId = state.requestId;
    return work(reviewed.remove ? 'Removing saved speaker…' : 'Sending your Sonos command…', async epoch => {
      clearTimeout(state.reviewTimer); state.reviewTimer = null;
      staleTopology();
      try {
        if (reviewed.remove) {
          await api('/devices/' + encodeURIComponent(reviewed.device.id), 'DELETE'); if (epoch !== state.epoch) return;
          clearDiscovery(); await load(epoch); if (epoch === state.epoch) say('Speaker removed from TLI. Its Sonos setup is unchanged.');
          if (epoch === state.epoch) window.dispatchEvent(new CustomEvent('tli-sonos-changed'));
        } else await sendCommand(reviewed, requestId, epoch);
      } finally {if (epoch === state.epoch) invalidate();}
    });
  }
  function toggle(name) {state.expanded = state.expanded === name ? null : name; sync(); return state.expanded === name;}
  function favorites() {
    if (!selected() || state.busy || state.locked || !toggle('favorites')) return;
    const row = selected();
    return work('Loading Sonos favorites…', async epoch => {
      const d = await api('/devices/' + encodeURIComponent(row.id) + '/favorites'); if (epoch !== state.epoch) return;
      const s = $('sonos-favorite'), placeholder = make('option', 'Choose a favorite'); placeholder.value = ''; s.replaceChildren(placeholder);
      for (const item of d.items) {const o = make('option', item.name); o.value = item.id; s.append(o);}
      say(d.items.length ? 'Choose a favorite to play.' : 'No favorites found. Add one in the Sonos app first.');
    });
  }
  function receipts() {
    if (state.busy || state.locked || !toggle('activity')) return;
    return work('Loading recent activity…', async epoch => {
      const d = await api('/receipts'); if (epoch !== state.epoch) return;
      const box = $('sonos-receipts'); box.replaceChildren();
      for (const r of d.receipts.slice(0, 15)) {
        const item = make('div', null, 'sonos-activity-item');
        item.append(make('p', r.summary), make('small', new Date(r.checked_at).toLocaleString())); box.append(item);
      }
      if (!d.receipts.length) box.append(make('p', 'No Sonos commands yet.'));
      say('Recent Sonos activity loaded.');
    });
  }
  function remove() {
    const row = selected(); if (!row || state.busy || state.locked) return;
    invalidate(); state.review = {remove: true, device: row};
    $('sonos-review').replaceChildren(make('h4', 'Remove ' + row.name + ' from TLI?'), make('p', 'Its Sonos setup and music stay unchanged. You can find and add it again.'));
    say('Confirm to remove this saved speaker.'); sync();
  }
  function init() {
    const panel = $('panel-homeauto'); if (!panel || $('sonos-box')) return;
    const box = make('section', null, 'card sonos-box'); box.id = 'sonos-box'; box.setAttribute('aria-labelledby', 'sonos-heading');
    const optional = $('home-assistant-section');
    if (optional?.parentNode === panel) {optional.open = false; panel.insertBefore(box, optional);} else panel.append(box);
    const header = make('div', null, 'sonos-header'), title = make('div');
    const heading = make('h3', 'Sonos'); heading.id = 'sonos-heading'; title.append(heading, make('p', 'Music for your rooms.', 'sonos-muted'));
    const actions = make('div', null, 'sonos-actions'); actions.append(button('Find speakers', discover, 'sonos-discover'), button('Refresh rooms', list));
    header.append(title, actions); box.append(header);
    const message = make('p', 'Find speakers to connect Sonos, or refresh your saved rooms.'); message.id = 'sonos-message'; message.setAttribute('role', 'status'); box.append(message);
    const discovery = make('div', null, 'sonos-discovery'); discovery.id = 'sonos-discovery'; discovery.hidden = true;
    const discoveryHeader = make('div', null, 'sonos-header'); discoveryHeader.append(make('h4', 'Speakers on your network'), button('Done', () => {clearDiscovery(); sync(); say(selected() ? 'Your room is ready. Refresh status to check playback.' : 'Choose a saved room below.');}, 'sonos-discovery-close'));
    const found = make('div'); found.id = 'sonos-found'; discovery.append(discoveryHeader, found); box.append(discovery);
    const picker = selection('sonos-device', 'Room or speaker'); picker.className = 'sonos-room-picker'; box.append(picker);
    const empty = make('p', 'Choose a saved room above, or find speakers to get started.', 'sonos-empty'); empty.id = 'sonos-empty'; box.append(empty);
    const player = make('div', null, 'sonos-player'); player.id = 'sonos-player'; player.hidden = true; box.append(player);
    const topology = make('section', null, 'sonos-topology'); topology.id = 'sonos-topology'; topology.dataset.state = 'unknown'; topology.setAttribute('aria-label', 'Sonos groups');
    const topologyHeader = make('div', null, 'sonos-header'); topologyHeader.append(make('h4', 'Sonos groups'), needs(button('Refresh group', read, 'sonos-group-refresh')));
    const topologyNote = make('p', null, 'sonos-muted'); topologyNote.id = 'sonos-topology-note';
    const topologyContent = make('div', null, 'sonos-topology-content'); topologyContent.id = 'sonos-topology-content';
    topology.append(topologyHeader, topologyNote, topologyContent); player.append(topology);
    const now = make('div', null, 'sonos-now'), roomHeading = make('div', null, 'sonos-header'), roomTitle = make('div');
    const roomName = make('h4'); roomName.id = 'sonos-room-name'; const model = make('p', null, 'sonos-muted'); model.id = 'sonos-room-model';
    roomTitle.append(roomName, model); roomHeading.append(roomTitle, needs(button('Refresh status', read)));
    const status = make('div', null, 'sonos-status'); status.id = 'sonos-status'; now.append(roomHeading, status); player.append(now);
    const scope = make('p', null, 'sonos-muted sonos-scope'); scope.id = 'sonos-scope'; player.append(scope);
    const controls = make('div', null, 'sonos-transport');
    for (const [action, label] of [['previous', 'Previous'], ['play', 'Play'], ['pause', 'Pause'], ['next', 'Next'], ['stop', 'Stop']]) {
      const control = needs(button(label, () => review(action, {}, true))); if (action === 'play') control.className = 'btn-primary'; controls.append(control);
    }
    player.append(controls);
    player.append(make('p', 'Play continues the source selected on Sonos, including Spotify, AirPlay and other music services.', 'sonos-muted'));
    const roomVolumes = make('section', null, 'sonos-room-volumes'); roomVolumes.id = 'sonos-room-volumes'; roomVolumes.hidden = true; roomVolumes.setAttribute('aria-label', 'Room and group volumes'); player.append(roomVolumes);
    const volume = make('div', null, 'sonos-volume'), volumeControl = make('div', null, 'sonos-volume-control'); volume.id = 'sonos-single-volume';
    const volumeTitle = make('div', null, 'sonos-volume-title'), label = make('label', 'Volume'); label.setAttribute('for', 'sonos-volume');
    const output = make('output', '20'); output.id = 'sonos-volume-value'; output.setAttribute('for', 'sonos-volume');
    const limit = make('span', 'Limit 35', 'sonos-muted'); limit.id = 'sonos-volume-limit'; volumeTitle.append(label, output, limit);
    const slider = make('input'); slider.id = 'sonos-volume'; slider.type = 'range'; slider.min = '0'; slider.max = '35'; slider.step = '1'; slider.value = '20'; slider.setAttribute('aria-label', 'Speaker volume');
    volumeControl.append(volumeTitle, slider);
    const volumeActions = make('div', null, 'sonos-actions'); volumeActions.append(needs(button('Apply volume', () => review('volume', {volume: Number(slider.value)}, true))),
      needs(button('Mute', () => review('mute', {muted: true}, true))), needs(button('Unmute', () => review('mute', {muted: false}, true))));
    volume.append(volumeControl, volumeActions); player.append(volume);
    const extras = make('div', null, 'sonos-extras');
    for (const [name, label, handler] of [['favorites', 'Favorites', favorites], ['groups', 'Group rooms', () => {if (!state.busy && !state.locked) toggle('groups');}], ['activity', 'Recent activity', receipts]]) {
      const control = button(label, handler, 'sonos-' + name + '-open'); control.setAttribute('aria-controls', 'sonos-' + name + '-panel'); control.setAttribute('aria-expanded', 'false');
      if (name !== 'activity') needs(control); extras.append(control);
    }
    box.append(extras);
    const fav = make('div', null, 'sonos-extra-panel'); fav.id = 'sonos-favorites-panel'; fav.hidden = true;
    fav.append(selection('sonos-favorite', 'Sonos favorite'), needs(button('Play favorite', () => {if ($('sonos-favorite').value) review('favorite', {favorite_id: $('sonos-favorite').value, replace_queue: true});}, 'sonos-play-favorite'))); box.append(fav);
    const group = make('div', null, 'sonos-extra-panel'); group.id = 'sonos-groups-panel'; group.hidden = true;
    const guidance = make('p'); guidance.id = 'sonos-group-guidance'; group.append(guidance, selection('sonos-destination', 'Play together with'));
    const groupActions = make('div', null, 'sonos-actions'); groupActions.append(needs(button('Join group', () => {if (!$('sonos-join').disabled && $('sonos-destination').value) review('join', {target_id: $('sonos-destination').value});}, 'sonos-join')), needs(button('Leave group', () => {if (!$('sonos-leave').disabled) review('leave');}, 'sonos-leave'))); group.append(groupActions); box.append(group);
    const activity = make('div', null, 'sonos-extra-panel'); activity.id = 'sonos-activity-panel'; activity.hidden = true;
    const receiptList = make('div'); receiptList.id = 'sonos-receipts'; activity.append(receiptList, needs(button('Remove speaker from TLI', remove))); box.append(activity);
    const confirmation = make('div', null, 'sonos-confirmation'); confirmation.id = 'sonos-confirmation'; confirmation.hidden = true; confirmation.tabIndex = -1; confirmation.setAttribute('role', 'region'); confirmation.setAttribute('aria-label', 'Confirm Sonos action');
    const reviewBox = make('div'); reviewBox.id = 'sonos-review'; const confirmActions = make('div', null, 'sonos-actions');
    const confirm = button('Confirm', execute, 'sonos-run'); confirm.className = 'btn-primary';
    confirmActions.append(confirm, button('Cancel', () => {invalidate(); say('Action cancelled. Nothing was sent.');})); confirmation.append(reviewBox, confirmActions); box.append(confirmation);
    $('sonos-device').addEventListener('change', () => {stopWaiting(); state.pendingOpen = null; clearDiscovery(); setRoom(); say(selected() ? 'Room selected. Refresh status to load playback and the room volume sliders.' : 'Choose a room to get started.');});
    for (const id of ['sonos-volume', 'sonos-destination', 'sonos-favorite']) $(id).addEventListener('change', () => {invalidate(); volumeLabel();});
    slider.addEventListener('input', () => {invalidate(); volumeLabel();});
    window.addEventListener('tli-session-locked', () => {state.locked = true; clear();});
    window.addEventListener('tli-session-unlocked', () => {state.locked = false; sync();});
    for (const name of ['tli-user-changed', 'tli-account-changed']) window.addEventListener(name, () => {state.locked = true; clear();});
    window.addEventListener('pagehide', clear); document.addEventListener('visibilitychange', () => {if (document.hidden) clear();});
    document.addEventListener('tli-panel-switched', e => {if (e.detail?.panelId === 'panel-homeauto') list(); else clear();});
    resetTopology(); sync();
  }
  window.TLISonos = {clear, open};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
