/* HomeLab reads are explicit. Source records never grant infrastructure control. */
(function (root) {
  'use strict';
  const text = (value, fallback = '') => typeof value === 'string' ? value.slice(0, 1000) : fallback;
  const labels = {host:'TLI host', computer:'Computer', inference_node:'Inference node', smart_device:'Smart device', printer:'Printer', node:'Proxmox node', qemu:'Virtual machine', lxc:'Container', storage:'Storage'};
  function source(value, name) {
    if (value?.state !== 'available' || !Array.isArray(value.items) || value.items.length > 10000) return {state:'unavailable', items:[], detail:text(value?.detail, name + ' inventory is unavailable.')};
    return {state:'available', items:value.items.filter(row => row && typeof row === 'object'), detail:text(value.detail)};
  }
  function inventory(value) {
    const computers = source(value?.sources?.computers, 'Computer'), devices = source(value?.sources?.devices, 'Device');
    const ai = ['available','not_checked'].includes(value?.sources?.ai?.state) ? value.sources.ai : {state:'unavailable', detail:text(value?.sources?.ai?.detail, 'Saved AI selection is unavailable.')};
    const rows = [...computers.items.map(row => ({...row, category:'computers'})), ...devices.items.map(row => ({...row, category:'devices'}))];
    return {computers, devices, ai, rows, checkedAt:text(value?.checked_at)};
  }
  function filter(rows, query, category = 'all') {
    const needle = String(query || '').trim().toLowerCase();
    return rows.filter(row => (category === 'all' || row.category === category || row.type === category)
      && [row.id,row.name,row.node,row.room,row.kind,row.type,labels[row.kind],labels[row.type]].some(value => text(value).toLowerCase().includes(needle)));
  }
  function bytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    if (value < 1024) return Math.round(value) + ' B';
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
    return (value / 1024 ** unit).toFixed(1) + ' ' + ['B','KiB','MiB','GiB','TiB'][unit];
  }
  const helpers = {inventory, filter, bytes};
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (!root?.document) return;
  const document = root.document, $ = id => document.getElementById(id);
  const node = (tag, content, cls) => { const el = document.createElement(tag); if (content != null) el.textContent = content; if (cls) el.className = cls; return el; };
  const state = {epoch:0, locked:false, suspended:false, verified:false, busy:false, controller:null, overview:null, proxmox:null};
  const current = epoch => epoch === state.epoch && !state.locked && !state.suspended;
  const available = () => !state.locked && !state.suspended;
  const stamp = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time not supplied'; };
  function button(label, action, cls = 'btn-outline') {
    const el = node('button', label, cls); el.type = 'button'; el.addEventListener('click', action); return el;
  }
  function open(panel) { if (available()) root.switchPanel?.(panel); }
  function clearCredentials() { for (const id of ['lab-proxmox-token','lab-proxmox-secret']) if ($(id)) $(id).value = ''; }
  function tell(message) { if ($('lab-status')) $('lab-status').textContent = message; }
  function sync() {
    if ($('lab-refresh')) $('lab-refresh').disabled = !available() || state.busy;
    if ($('lab-inspect')) $('lab-inspect').disabled = !available() || !state.verified || state.busy;
    if ($('lab-unlock')) $('lab-unlock').hidden = !state.locked;
    for (const id of ['lab-proxmox-origin','lab-proxmox-token','lab-proxmox-secret','lab-proxmox-pin']) if ($(id)) $(id).disabled = !available() || state.busy;
    if ($('lab-proxmox-access')) $('lab-proxmox-access').hidden = state.verified;
    if ($('lab-workspace')) $('lab-workspace').setAttribute('aria-busy', String(state.busy));
  }
  function clear(message, locked = state.locked) {
    state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false;
    state.locked = locked; state.verified = false; state.overview = null; state.proxmox = null;
    clearCredentials();
    for (const id of ['lab-proxmox-origin','lab-proxmox-pin','lab-search','lab-proxmox-search']) if ($(id)) $(id).value = '';
    for (const id of ['lab-kind','lab-proxmox-kind']) if ($(id)) $(id).value = 'all';
    renderOverview(); renderProxmox(); tell(message); sync();
  }
  async function request(path, options, epoch) {
    if (!current(epoch)) throw Error('HomeLab access changed.');
    const response = await fetch(path, {cache:'no-store', credentials:'same-origin', ...options, signal:state.controller.signal,
      headers:{Accept:'application/json', ...(options?.body ? {'Content-Type':'application/json'} : {})}});
    if (!current(epoch)) throw Error('HomeLab access changed.');
    if (response.status === 401 || response.status === 403) { root.dispatchEvent(new CustomEvent('tli-session-locked')); throw Error('Verify TLI browser access before reading HomeLab.'); }
    let raw = '', length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const {done,value} = await reader.read();
        if (!current(epoch)) { await reader.cancel(); throw Error('HomeLab access changed.'); }
        if (done) break;
        length += value.byteLength;
        if (length > 4 * 1024 * 1024) { await reader.cancel(); throw Error('HomeLab returned more inventory than this view supports.'); }
        raw += decoder.decode(value, {stream:true});
      }
      raw += decoder.decode();
    } else { raw = await response.text(); if (new TextEncoder().encode(raw).length > 4 * 1024 * 1024) throw Error('HomeLab returned more inventory than this view supports.'); }
    if (!current(epoch)) throw Error('HomeLab access changed.');
    let value; try { value = JSON.parse(raw); } catch (_) { throw Error('HomeLab returned unreadable data.'); }
    if (!response.ok) throw Error(text(value.detail, 'The HomeLab read could not be completed.'));
    return value;
  }
  async function run(message, operation) {
    if (!available() || state.busy) return;
    const epoch = state.epoch, controller = new AbortController();
    state.controller = controller; state.busy = true; tell(message); sync();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try { await operation(epoch); }
    catch (error) { if (current(epoch)) tell((error.name === 'AbortError' ? 'The read timed out or was interrupted. Choose a new read to try again.' : error.message) + (state.overview || state.proxmox ? ' Earlier results remain dated below.' : '')); }
    finally { clearTimeout(timeout); if (current(epoch)) { state.busy = false; state.controller = null; sync(); } }
  }
  function refresh() {
    return run('Reading TLI’s saved computer and device inventory…', async epoch => {
      const value = await request('/api/homelab/overview', {}, epoch);
      if (!current(epoch)) return;
      if (!value?.sources || typeof value.sources !== 'object') throw Error('The HomeLab inventory response is incomplete.');
      state.overview = inventory(value); state.verified = true; renderOverview();
      const incomplete = [state.overview.computers,state.overview.devices,state.overview.ai].some(item => item.state === 'unavailable');
      tell(incomplete ? 'Inventory read finished with unavailable sources. Available records are shown below.' : 'Saved inventory refreshed. Device availability and live health have not been checked.');
    });
  }
  function inspect() {
    if (!state.verified || !available() || state.busy) return;
    const payload = {origin:$('lab-proxmox-origin').value.trim(), token_id:$('lab-proxmox-token').value.trim(), token_secret:$('lab-proxmox-secret').value, certificate_sha256:$('lab-proxmox-pin').value.trim()};
    clearCredentials();
    return run('Reading one Proxmox inventory snapshot…', async epoch => {
      const value = await request('/api/homelab/proxmox/inspect', {method:'POST', body:JSON.stringify(payload)}, epoch);
      payload.token_id = ''; payload.token_secret = '';
      if (!current(epoch)) return;
      if (value?.protocol !== 'tli-homelab-proxmox-v1' || value.ok !== true || value.actions_performed !== false || !['certificate_pin','system_trust'].includes(value.tls_verification) || typeof value.origin !== 'string' || !Array.isArray(value.resources) || value.resources.length > 10000 || value.resources.some(row => !row || typeof row !== 'object')) throw Error('The Proxmox inventory response was not confirmed.');
      state.proxmox = value; renderProxmox(); tell('Proxmox snapshot received. The token is not retained; another read needs its credentials again.');
    }).finally(() => { payload.token_id = ''; payload.token_secret = ''; });
  }
  function metric(label, value, detail) {
    const card = node('div', null, 'lab-metric'); card.append(node('span', label), node('strong', value), node('small', detail)); return card;
  }
  function renderOverview() {
    const stats = $('lab-metrics'), list = $('lab-inventory'), issues = $('lab-source-notices'); if (!stats || !list || !issues) return;
    stats.replaceChildren(); issues.replaceChildren(); list.replaceChildren();
    const value = state.overview;
    if (!value) {
      stats.append(metric('Computers', '—', 'Inventory not read'), metric('Smart devices', '—', 'Inventory not read'), metric('AI selection', '—', 'Not read'));
      list.append(node('p', 'Your lab starts with the computers and devices TLI already knows. Refresh overview to bring their saved records together.', 'lab-empty'));
      $('lab-receipt').textContent = 'No inventory read in this view.'; $('lab-list-count').textContent = 'Saved inventory'; return;
    }
    stats.append(metric('Computers', value.computers.state === 'available' ? String(value.computers.items.length) : '—', 'Recorded hosts and peers'),
      metric('Smart devices', value.devices.state === 'available' ? String(value.devices.items.length) : '—', 'Registered device records'),
      metric('AI selection', value.ai.state === 'available' ? text(value.ai.selection?.label, 'Not selected') : value.ai.state === 'not_checked' ? 'Choose AI' : 'Unavailable', text(value.ai.selection?.detail, 'Readiness not checked')));
    for (const [name, item] of [['Computers',value.computers],['Smart devices',value.devices],['AI',value.ai]]) {
      if (item.state === 'unavailable') issues.append(node('p', name + ': ' + text(item.detail, 'This source is unavailable.'), 'lab-source-error'));
    }
    $('lab-receipt').textContent = 'Saved inventory read: ' + stamp(value.checkedAt) + ' · Record membership only. Live availability is unknown.';
    const rows = filter(value.rows, $('lab-search').value, $('lab-kind').value);
    $('lab-list-count').textContent = rows.length + ' matching records · ' + value.rows.length + ' in available sources';
    if (!rows.length) list.append(node('p', value.rows.length ? 'No records match this search.' : 'No records were returned by the available sources. Connect a TLI computer or add a supported smart device to get started.', 'lab-empty'));
    for (const row of rows.slice(0, 100)) {
      const card = node('article', null, 'lab-record'), icon = root.TLIUI?.icon(row.category === 'computers' ? 'network' : 'home');
      if (icon) card.append(icon);
      const content = node('div', null, 'lab-record-copy');
      content.append(node('h3', text(row.name, text(row.id, 'Unnamed record'))), node('p', [labels[row.kind] || text(row.kind, row.category === 'computers' ? 'Computer' : 'Smart device'), text(row.room), text(row.role)].filter(Boolean).join(' · ')));
      if (row.id) content.append(node('small', text(row.id)));
      card.append(content, node('span', 'Availability unknown', 'lab-state'), button(row.category === 'computers' ? 'Computers →' : 'Smart home →', () => open(row.category === 'computers' ? 'panel-mesh' : 'panel-homeauto'), 'lab-text-button'));
      list.append(card);
    }
    if (rows.length > 100) list.append(node('p', 'Showing the first 100 matches. Narrow your search to find an exact record.', 'lab-muted'));
  }
  function renderProxmox() {
    const list = $('lab-proxmox-results'), receipt = $('lab-proxmox-receipt'); if (!list || !receipt) return;
    list.replaceChildren();
    if (!state.proxmox) { receipt.textContent = 'No Proxmox snapshot in this view.'; $('lab-proxmox-results-tools').hidden = true; $('lab-proxmox-scope').hidden = true; return; }
    const value = state.proxmox, rows = filter(value.resources, $('lab-proxmox-search').value, $('lab-proxmox-kind').value);
    $('lab-proxmox-results-tools').hidden = false;
    $('lab-proxmox-scope').hidden = false;
    receipt.textContent = 'Read from ' + text(value.origin, 'Proxmox') + ' · ' + stamp(value.checked_at) + ' · ' + value.resources.length + ' reported resources · ' + (value.tls_verification === 'certificate_pin' ? 'Certificate fingerprint matched.' : 'HTTPS certificate verified.');
    if (!rows.length) list.append(node('p', value.resources.length ? 'No resources match this search.' : 'No resources were visible to this token.', 'lab-empty'));
    for (const row of rows.slice(0, 100)) {
      const card = node('article', null, 'lab-proxmox-record'), title = node('div', null, 'lab-proxmox-record-title');
      title.append(node('h4', text(row.name, text(row.id, 'Unnamed resource'))), node('span', text(row.status, 'Status not supplied'), 'lab-state')); card.append(title);
      card.append(node('p', [labels[row.type] || text(row.type, 'Resource'), text(row.node), text(row.id)].filter(Boolean).join(' · ')));
      const readings = [];
      if (typeof row.cpu === 'number' && Number.isFinite(row.cpu) && row.cpu >= 0 && row.cpu <= 1) readings.push('CPU ' + Math.round(row.cpu * 100) + '%');
      if (bytes(row.mem) !== null) readings.push('Memory ' + bytes(row.mem) + (bytes(row.maxmem) !== null ? ' / ' + bytes(row.maxmem) : ''));
      if (bytes(row.disk) !== null) readings.push('Storage ' + bytes(row.disk) + (bytes(row.maxdisk) !== null ? ' / ' + bytes(row.maxdisk) : ''));
      card.append(node('small', readings.length ? readings.join(' · ') : 'Resource readings not supplied.')); list.append(card);
    }
    if (rows.length > 100) list.append(node('p', 'Showing the first 100 matches. Filter by name, node or resource ID.', 'lab-muted'));
  }
  function field(id, label, type = 'text', placeholder = '') {
    const wrapper = node('label', null, 'lab-field'); wrapper.append(node('span', label));
    const input = node('input'); input.id = id; input.type = type; input.placeholder = placeholder; wrapper.append(input); return wrapper;
  }
  function select(id, label, items) {
    const wrapper = node('label', null, 'lab-field'); wrapper.append(node('span', label));
    const input = node('select'); input.id = id;
    for (const [value, title] of items) { const option = node('option', title); option.value = value; input.append(option); }
    input.value = 'all'; wrapper.append(input); return wrapper;
  }
  function init() {
    const mount = $('homelab-mount'); if (!mount || $('lab-workspace')) return;
    const box = node('div', null, 'lab-workspace'); box.id = 'lab-workspace'; mount.append(box);
    const hero = node('section', null, 'lab-hero'), copy = node('div');
    copy.append(node('p', 'YOUR CONNECTED WORLD', 'lab-eyebrow'), node('h2', 'A home for your HomeLab.'), node('p', 'Bring your TLI computers, smart devices and AI into one view. Inspect your Proxmox resources when you need a closer look.'));
    const actions = node('div', null, 'lab-hero-actions'), refreshButton = button('Refresh overview', refresh, 'btn-primary'); refreshButton.id = 'lab-refresh';
    const unlock = button('Unlock TLI', () => root.TLIPinLock?.checkAndLock?.()); unlock.id = 'lab-unlock'; unlock.hidden = true;
    actions.append(refreshButton, unlock, node('small', 'Reads saved TLI inventory. No live network scan.')); hero.append(copy, actions); box.append(hero);
    const status = node('p', 'Choose Refresh overview to read this host’s saved inventory.', 'lab-status'); status.id = 'lab-status'; status.setAttribute('role','status'); box.append(status);
    const stats = node('div', null, 'lab-metrics'); stats.id = 'lab-metrics'; box.append(stats);
    const shortcuts = node('nav', null, 'lab-shortcuts'); shortcuts.setAttribute('aria-label','HomeLab workspaces');
    for (const [label, panel] of [['Computers','panel-mesh'],['Smart home','panel-homeauto'],['Free Space','panel-visualizer'],['Troubleshooting','panel-troubleshooting'],['Ask TLI','panel-main']]) shortcuts.append(button(label, () => open(panel), 'lab-shortcut'));
    shortcuts.append(button('Choose AI', () => { if (available()) root.openModelManager?.(); }, 'lab-shortcut'), button('Saved notes', () => { if (available()) root.TLIUI?.openNotes?.(); }, 'lab-shortcut')); box.append(shortcuts);
    const inventorySection = node('section', null, 'lab-section'); inventorySection.setAttribute('aria-labelledby','lab-inventory-title');
    const heading = node('div', null, 'lab-section-heading'), title = node('h2', 'Your inventory'); title.id = 'lab-inventory-title'; const count = node('p'); count.id = 'lab-list-count'; heading.append(title,count); inventorySection.append(heading);
    const tools = node('div', null, 'lab-filter-row'); tools.append(field('lab-search','Find a computer or device','search','Name, room or identifier'), select('lab-kind','Show',[['all','Everything'],['computers','Computers'],['devices','Smart devices']])); inventorySection.append(tools);
    const issues = node('div'); issues.id = 'lab-source-notices'; const list = node('div', null, 'lab-inventory'); list.id = 'lab-inventory'; const receipt = node('p', null, 'lab-receipt'); receipt.id = 'lab-receipt'; inventorySection.append(issues,list,receipt); box.append(inventorySection);
    const proxmox = node('section', null, 'lab-section lab-proxmox'); box.append(proxmox); proxmox.setAttribute('aria-labelledby','lab-proxmox-title');
    const proxHead = node('div', null, 'lab-section-heading'), proxTitle = node('h2', 'Proxmox VE'); proxTitle.id = 'lab-proxmox-title'; proxHead.append(proxTitle,node('span','Read-only snapshot','lab-badge')); proxmox.append(proxHead,node('p','Inspect nodes, virtual machines, containers and storage using your Proxmox API token. Each read contacts only the address you enter.'));
    const config = node('details', null, 'lab-proxmox-config'); proxmox.append(config); config.append(node('summary','Read a Proxmox host'));
    config.append(node('p','Use a dedicated token with read-only permissions for the resources you want to see. TLI requests inventory only; it cannot start, stop, restart or modify Proxmox resources here.'));
    const form = node('form', null, 'lab-proxmox-form'); config.append(form); form.autocomplete = 'off'; form.addEventListener('submit', event => { event.preventDefault(); return inspect(); });
    form.append(field('lab-proxmox-origin','Proxmox HTTPS address','url','https://192.168.1.20:8006'),field('lab-proxmox-token','API token ID','text','reader@pve!tli'),field('lab-proxmox-secret','API token secret','password'),field('lab-proxmox-pin','Certificate SHA-256 fingerprint (optional)','text','For a self-signed certificate'));
    $('lab-proxmox-origin').required = true; $('lab-proxmox-token').required = true; $('lab-proxmox-secret').required = true;
    for (const id of ['lab-proxmox-token','lab-proxmox-secret']) $(id).autocomplete = 'off';
    const transport = node('p','Use a private literal IP address, including brackets for IPv6. HTTPS verifies the server certificate. For a self-signed certificate, independently verify its SHA-256 fingerprint in Proxmox and enter it here. An empty fingerprint uses system trust.', 'lab-form-note'); form.append(transport);
    form.append(node('p','Credentials are used for this read only and cleared from the form when submitted. This view does not save a connection or retry automatically.', 'lab-form-note'));
    const access = node('p','Refresh overview first to confirm this browser’s access.', 'lab-form-note'); access.id = 'lab-proxmox-access';
    const submit = button('Read Proxmox inventory', () => {} ,'btn-primary'); submit.type = 'submit'; submit.id = 'lab-inspect'; form.append(access,submit); config.append(form); proxmox.append(config);
    const proxReceipt = node('p',null,'lab-receipt'); proxReceipt.id = 'lab-proxmox-receipt'; proxmox.append(proxReceipt);
    const proxScope = node('p','This snapshot includes only resources visible to this API token. Proxmox reported states such as “running” do not confirm application health. Storage readings belong to individual resources and are not a total of unique physical capacity.','lab-receipt'); proxScope.id = 'lab-proxmox-scope'; proxScope.hidden = true; proxmox.append(proxScope);
    const proxTools = node('div',null,'lab-filter-row'); proxTools.id = 'lab-proxmox-results-tools'; proxTools.hidden = true;
    proxTools.append(field('lab-proxmox-search','Find a Proxmox resource','search','Name, node or resource ID'),select('lab-proxmox-kind','Resource type',[['all','All resources'],['node','Nodes'],['qemu','Virtual machines'],['lxc','Containers'],['storage','Storage']]));
    const proxResults = node('div',null,'lab-proxmox-results'); proxResults.id = 'lab-proxmox-results'; proxmox.append(proxTools,proxResults); box.append(proxmox);
    $('lab-search').addEventListener('input',renderOverview); $('lab-kind').addEventListener('change',renderOverview);
    $('lab-proxmox-search').addEventListener('input',renderProxmox); $('lab-proxmox-kind').addEventListener('change',renderProxmox);
    renderOverview(); renderProxmox(); sync();
  }
  for (const type of ['tli-session-locked','tli-account-changed','tli-user-changed']) root.addEventListener(type, () => clear('HomeLab is locked. Unlock TLI, then explicitly refresh overview to read inventory again.', true));
  root.addEventListener('tli-session-unlocked', () => { clear('Access unlocked. Choose Refresh overview before reading inventory again.', false); });
  root.addEventListener('pagehide', () => { state.suspended = true; clear('HomeLab was cleared when this page closed. Refresh overview to read it again.'); });
  root.addEventListener('pageshow', () => { state.suspended = false; sync(); });
  document.addEventListener('tli-panel-switched', event => { if (event.detail?.panelId !== 'panel-homelab') { clearCredentials(); state.controller?.abort(); state.epoch++; state.busy = false; state.controller = null; sync(); } });
  root.TLIHomeLab = {refresh, inspect};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})(typeof window === 'undefined' ? null : window);
