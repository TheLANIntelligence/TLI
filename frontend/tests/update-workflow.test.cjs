const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/tli-update.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const flush = () => new Promise(setImmediate);
const available = { state: 'available', current_version: '1.3.4', latest_version: '1.3.5', platform: 'windows',
  update_method: 'guided', can_prepare: true, can_open: false, progress: 0, checked_at: '2026-10-11T15:30:00Z',
  auto_check: false, update_url: 'https://thelanintelligence.com/downloads.json', notes: 'A useful release.' };
const ready = { ...available, state: 'ready', can_prepare: false, can_open: true, ready_path: 'C:\\TLI\\updates\\1.3.5', progress: 100 };

function fixture(initial = available, options = {}) {
  const nodes = {}, calls = [], timers = new Map(), documentEvents = {}, windowEvents = {}, lifecycle = [], toasts = [], navigations = [];
  let serial = 0, handler = null, current = initial;
  class Element {
    constructor(id, markup = '') { this.id = id; this.handlers = {}; this.textContent = ''; this.value = ''; this.attrs = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.hidden = /\shidden(?:\s|>)/.test(markup); this.disabled = /\sdisabled(?:\s|>)/.test(markup); this.checked = false; }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    emit(name) { return Promise.all((this.handlers[name] || []).map(fn => fn({ target: this, currentTarget: this }))); }
    click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
  }
  for (const match of html.matchAll(/<[^>]+\bid="((?:tli-update-|settings-update-|settings-check-update-|settings-tli-version|version-pill-settings)[^"]*)"[^>]*>/g)) nodes[match[1]] = new Element(match[1], match[0]);
  const document = { readyState: 'loading', hidden: false, getElementById: id => nodes[id] || null, createElement: () => new Element(),
    addEventListener(name, fn) { (documentEvents[name] ||= []).push(fn); } };
  const window = { crypto:{randomUUID:()=> 'a'.repeat(32)}, location: { href: options.url || 'http://127.0.0.1:8000/', assign: url => navigations.push(url), reload() { assert.fail('Preparing an update must never reload'); } },
    TLIHostLifecycle: { open: (...args) => lifecycle.push(args) }, addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); } };
  const context = vm.createContext({ document, window, navigator: { userAgent: options.mobile ? 'iPhone Mobile' : 'Desktop', userAgentData: { mobile: !!options.mobile } }, URL, Date, AbortController,
    setTimeout(fn, ms) { timers.set(++serial, { fn, ms }); return serial; }, clearTimeout(id) { timers.delete(id); },
    showToast: (...args) => toasts.push(args), fetch: async (url, request = {}) => {
      calls.push({ url, ...request });
      let result = handler ? await handler(url, request) : undefined;
      if (result === undefined) result = url === '/update/status' || url === '/update/check' ? current : { ok: true };
      return result && typeof result.json === 'function' ? result : { ok: true, status: 200, json: async () => result };
    } });
  vm.runInContext(source, context);
  return { nodes, calls, timers, lifecycle, toasts, document, navigations, setStatus(value) { current = value; }, handler(fn) { handler = fn; },
    async start() { for (const fn of documentEvents.DOMContentLoaded || []) await fn(); await flush(); },
    async poll(ms) { const timer = [...timers].find(([, value]) => !ms || value.ms === ms); assert.ok(timer, 'Expected a scheduled poll'); timers.delete(timer[0]); await timer[1].fn(); await flush(); },
    async visibility(hidden) { document.hidden = hidden; for (const fn of documentEvents.visibilitychange || []) await fn(); await flush(); },
    async event(name) { for (const fn of windowEvents[name] || []) await fn(); await flush(); } };
}

test('a dismissed banner leaves Settings download, release notes and current version available', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.nodes['tli-update-banner'].hidden, false);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
  assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.4');
  assert.match(f.nodes['settings-update-platform'].textContent, /Windows/);
  assert.doesNotMatch(f.nodes['settings-update-checked'].textContent, /not yet/);
  await f.nodes['tli-update-dismiss-btn'].click();
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  assert.equal(f.nodes['settings-update-action-btn'].hidden, false);
  await f.nodes['settings-update-notes-btn'].click();
  assert.equal(f.nodes['tli-update-notes-body'].textContent, available.notes);
  assert.equal(f.nodes['tli-update-notes-pop'].hidden, false);
  assert.equal(f.calls.length, 1, 'Release notes use the checked result');
});

test('idle startup discovers a delayed background result and keeps polling visible status without automatic POST checks', async () => {
  const f = fixture({ ...available, state: 'idle', latest_version: '' }); await f.start();
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [15000]);
  f.setStatus(available); await f.poll(15000);
  assert.equal(f.nodes['tli-update-banner'].hidden, false);
  assert.deepEqual([...f.timers.values()].map(t => t.ms), [60000]);
  await f.poll(60000); assert.ok(f.calls.every(call => call.url === '/update/status' && !call.method));
  await f.visibility(true); assert.equal(f.timers.size, 0);
  const before = f.calls.length; await f.visibility(false); assert.equal(f.calls.length, before + 1);
  await f.event('pagehide'); assert.equal(f.timers.size, 0);
});

test('dismissed releases stay quiet through repeated checks and errors while a different release prompts again', async () => {
  const f = fixture(); await f.start(); await f.nodes['tli-update-dismiss-btn'].click();
  await f.poll(15000);
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  f.setStatus({ ...available, latest_version: 'v1.3.5', last_check_error: 'Release source unavailable' });
  await f.poll(60000);
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  assert.match(f.nodes['settings-update-message'].textContent, /Automatic update check could not finish.*Release source unavailable/);
  f.setStatus({ ...available, state: 'error', latest_version: '', error: 'Release source unavailable' });
  await f.poll(60000);
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Retry check');
  f.handler(url => url === '/update/status' ? { ok: false, status: 503, json: async () => ({ detail: 'Host unavailable' }) } : undefined);
  await f.poll(60000);
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  f.handler(() => undefined); f.setStatus(available); await f.visibility(false);
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  assert.equal(f.nodes['settings-update-action-btn'].hidden, false);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
  f.setStatus({ ...available, latest_version: '1.3.6' }); await f.poll(60000);
  assert.equal(f.nodes['tli-update-banner'].hidden, false);
  assert.equal(f.nodes['tli-update-version'].textContent, 'v1.3.6');
  assert.ok(f.calls.every(call => call.url === '/update/status' && !call.method));
  assert.equal(f.toasts.length, 0); assert.equal(f.lifecycle.length, 0);
});

test('manual Settings checks keep a same-release dismissal while retaining the download action', async () => {
  const f = fixture(); await f.start(); await f.nodes['tli-update-dismiss-btn'].click();
  await f.nodes['settings-check-update-btn'].click();
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  assert.equal(f.nodes['settings-update-action-btn'].hidden, false);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.at(-1).url, '/update/check');
});

test('failed automatic checks stay in Settings without unsolicited attention banners or downloads', async () => {
  for (const state of ['idle', 'up_to_date', 'available']) {
    const f = fixture({ ...available, state, latest_version: state === 'available' ? available.latest_version : '' });
    await f.start();
    f.setStatus({ ...available, state, latest_version: state === 'available' ? available.latest_version : '', last_check_error: 'Release source unavailable' });
    await f.poll(15000);
    assert.match(f.nodes['settings-update-message'].textContent, /Automatic update check could not finish.*Release source unavailable/);
    assert.equal(f.nodes['tli-update-banner'].hidden, state !== 'available');
    assert.equal(f.nodes['tli-update-banner-title'].textContent, 'TLI update available');
    assert.equal(f.nodes['settings-update-manual-link'].hidden, false);
    assert.equal(f.nodes['settings-update-manual-link'].href, 'https://github.com/TheLANIntelligence/TLI/releases');
    f.setStatus({ ...available, state, latest_version: state === 'available' ? available.latest_version : '' });
    await f.poll(60000);
    assert.equal(f.nodes['settings-update-manual-link'].hidden, true);
    assert.ok(f.calls.every(call => call.url === '/update/status' && !call.method));
    assert.equal(f.toasts.length, 0); assert.equal(f.lifecycle.length, 0);
  }
});

test('the saved disabled automatic-check preference survives polling and release-source changes', async () => {
  const f = fixture(); await f.start();
  assert.equal(f.nodes['settings-update-auto-check'].checked, false);
  f.setStatus({ ...available, latest_version: '1.3.6' }); await f.poll(15000);
  assert.equal(f.nodes['settings-update-auto-check'].checked, false);
  f.nodes['settings-update-url'].value = 'https://custom.example/releases.json';
  await f.nodes['settings-update-url-save'].click();
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { update_url: 'https://custom.example/releases.json', auto_check: false });
  assert.match(f.nodes['settings-update-save-status'].textContent, /applies immediately/);
  assert.doesNotMatch(f.nodes['settings-update-save-status'].textContent, /next time|restart/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.at(-1).url, '/update/settings');
  assert.match(html, /Check automatically for updates/);
  assert.match(html, /at startup and every six hours while TLI runs/);
});

test('download submits JSON once, shows Settings progress and exposes pending installation without changing the running version', async () => {
  const f = fixture(); await f.start(); await f.nodes['tli-update-dismiss-btn'].click();
  let finish;
  f.handler(url => url === '/update/apply' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const pending = f.nodes['settings-update-action-btn'].click(); await flush();
  await f.nodes['tli-update-apply-btn'].emit('click');
  assert.equal(f.calls.filter(call => call.url === '/update/apply').length, 1);
  const call = f.calls.find(call => call.url === '/update/apply');
  assert.equal(call.method, 'POST'); assert.equal(call.headers['Content-Type'], 'application/json'); assert.equal(call.body, '{}');
  f.setStatus({ ...available, state: 'downloading', progress: 46 }); finish({ ok: true }); await pending;
  assert.equal(f.nodes['settings-update-progress-wrap'].hidden, false);
  assert.equal(f.nodes['settings-update-progress'].value, 46);
  assert.equal(f.nodes['tli-update-progress-bar'].style['--w'], '46%');
  assert.equal(f.nodes['tli-update-banner'].hidden, true);
  f.setStatus({ ...available, state: 'verifying' }); await f.poll(1500);
  f.setStatus({ ...available, state: 'preparing' }); await f.poll(1500);
  f.setStatus(ready); await f.poll(1500);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Open update folder');
  assert.match(f.nodes['settings-update-state'].textContent, /installation pending/);
  assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.4');
  assert.equal(f.nodes['settings-update-ready'].hidden, false);
  assert.match(f.nodes['settings-update-installer'].textContent, /TLI_Update\.bat/);
  assert.equal(f.nodes['settings-update-action-btn'].handlers.click.length, 1);
  assert.equal(f.nodes['tli-update-apply-btn'].handlers.click.length, 1);
  assert.equal(f.lifecycle.length, 0);
  await f.nodes['settings-update-quit-btn'].click();
  assert.equal(f.lifecycle.length, 1); assert.equal(f.lifecycle[0][0], 'quit');
  assert.equal(f.calls.some(call => /restart|quit|host-control/.test(call.url)), false);
});

test('preparation errors offer a fresh check instead of resubmitting apply, then restore download on success', async () => {
  const f = fixture(); await f.start();
  f.handler(url => url === '/update/apply' ? { ok: false, status: 503, json: async () => ({ detail: 'Download interrupted' }) } : undefined);
  await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Retry check');
  assert.match(f.nodes['settings-update-message'].textContent, /Download interrupted.*Retry/);
  assert.equal(f.nodes['settings-update-manual-link'].hidden, false);
  await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.calls.filter(call => call.url === '/update/apply').length, 1);
  assert.equal(f.calls.filter(call => call.url === '/update/check').length, 1);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
  assert.equal(f.nodes['settings-update-manual-link'].hidden, true);
});

test('TLS failures offer only the fixed manual release link without reviving dismissed banners or bypassing host gating', async () => {
  for (const options of [{}, { url: 'https://192.168.1.4:8000/' }]) {
    const f = fixture(available, options); await f.start(); await f.nodes['tli-update-dismiss-btn'].click();
    f.setStatus({ ...available, state: 'error', error: 'TLS could not verify the release certificate. Download in your browser and run the update script.', manual_url: 'https://untrusted.example/download' });
    await f.poll(15000);
    assert.match(f.nodes['settings-update-message'].textContent, /TLS could not verify.*Download in your browser/);
    assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Retry check');
    assert.equal(f.nodes['tli-update-banner'].hidden, true);
    const before = f.calls.length;
    for (const id of ['settings-update-manual-link', 'tli-update-manual-link']) {
      assert.equal(f.nodes[id].hidden, false);
      assert.equal(f.nodes[id].href, 'https://github.com/TheLANIntelligence/TLI/releases');
      await f.nodes[id].click();
    }
    assert.equal(f.calls.length, before, 'Manual links never trigger update API requests');
    assert.ok(f.calls.every(call => call.url === '/update/status' && !call.method));
    assert.equal(f.lifecycle.length, 0);
    f.setStatus(available); await f.nodes['settings-update-action-btn'].click();
    assert.equal(f.nodes['settings-update-manual-link'].hidden, true);
    assert.equal(f.nodes['tli-update-banner'].hidden, true);
    assert.equal(f.nodes['settings-update-action-btn'].hidden, !!options.url, 'Remote browsers still cannot download onto the host');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.calls.at(-1).url, '/update/check');
  }
});

test('opening a verified folder is retriable without losing ready state or automatically quitting TLI', async () => {
  const f = fixture(ready); await f.start();
  f.handler(url => url === '/update/open' ? { ok: false, status: 503, json: async () => ({ detail: 'File browser unavailable' }) } : undefined);
  await f.nodes['settings-update-action-btn'].click();
  assert.match(f.nodes['settings-update-message'].textContent, /Could not open.*File browser unavailable/);
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Open update folder');
  assert.equal(f.nodes['settings-update-ready'].hidden, false);
  assert.match(f.nodes['settings-update-path'].textContent, /1\.3\.5/);
  f.handler(() => undefined); await f.nodes['tli-update-apply-btn'].click();
  const opens = f.calls.filter(call => call.url === '/update/open'); assert.equal(opens.length, 2);
  assert.ok(opens.every(call => call.body === '{}' && call.headers['Content-Type'] === 'application/json'));
  assert.match(f.nodes['settings-update-message'].textContent, /Update folder opened/);
  assert.equal(f.lifecycle.length, 0);
  assert.equal(f.calls.some(call => call.url === '/update/apply'), false);
});

test('remote browsers and phones cannot open host folders or quit; Mac ready instructions select the command updater', async () => {
  for (const options of [{ url: 'https://192.168.1.4:8000/' }, { mobile: true }]) {
    const unprepared = fixture(available, options); await unprepared.start();
    assert.equal(unprepared.nodes['settings-update-action-btn'].hidden, true);
    await unprepared.nodes['settings-update-action-btn'].emit('click'); assert.equal(unprepared.calls.length, 1);
    assert.match(unprepared.nodes['settings-update-message'].textContent, /local desktop browser/);
    const f = fixture(ready, options); await f.start();
    assert.equal(f.nodes['settings-update-action-btn'].hidden, true);
    assert.equal(f.nodes['settings-update-quit-btn'].hidden, true);
    await f.nodes['settings-update-action-btn'].emit('click'); await f.nodes['settings-update-quit-btn'].emit('click');
    assert.equal(f.calls.length, 1); assert.equal(f.lifecycle.length, 0);
    assert.match(f.nodes['settings-update-message'].textContent, /local desktop browser on the host/);
  }
  const mac = fixture({ ...ready, platform: 'macos' }); await mac.start();
  assert.match(mac.nodes['settings-update-installer'].textContent, /TLI_Update\.command/);
  assert.match(mac.nodes['settings-update-stop'].textContent, /Control\+C.*Host Start helper/);
  assert.equal(mac.nodes['settings-update-quit-btn'].hidden, true);
});

test('unsupported release packages use the official download page and never send apply', async () => {
  const f = fixture({ ...available, can_prepare: false, message: 'This release uses the website installer.' }); await f.start();
  assert.equal(f.nodes['settings-update-action-btn'].hidden, true);
  assert.equal(f.nodes['settings-update-manual-link'].hidden, false);
  assert.equal(f.nodes['settings-update-manual-link'].href, 'https://github.com/TheLANIntelligence/TLI/releases');
  assert.match(f.nodes['settings-update-message'].textContent, /website installer/);
  await f.nodes['settings-update-action-btn'].emit('click'); assert.equal(f.calls.length, 1);
});

test('HTTP failures, unreadable JSON and unsupported legacy done states never report success', async () => {
  for (const result of [{ ok: false, status: 403, json: async () => ({ detail: 'Unlock TLI first' }) },
    { ok: true, json: async () => { throw Error('Invalid JSON'); } }, {}, { ...ready, state: 'done' }]) {
    const f = fixture(); await f.start(); f.handler(url => url === '/update/check' ? result : undefined);
    await f.nodes['settings-check-update-btn'].click();
    assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Retry check');
    assert.equal(f.nodes['settings-update-action-btn'].disabled, false);
    assert.doesNotMatch(f.nodes['settings-update-state'].textContent, /Up to date|installation pending/);
    assert.equal(f.toasts.at(-1)[1], 'error');
    assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.4');
  }
});

test('status refresh failure can retry while preparation was previously active', async () => {
  const f = fixture({ ...available, state: 'verifying' }); await f.start();
  f.handler(url => url === '/update/status' ? { ok: false, status: 503, json: async () => ({ detail: 'Host unavailable' }) } : undefined);
  await f.poll(1500);
  assert.match(f.nodes['settings-update-message'].textContent, /Host unavailable/);
  assert.equal(f.nodes['settings-update-action-btn'].disabled, false);
  assert.equal(f.nodes['settings-update-manual-link'].hidden, false);
  assert.equal(f.nodes['settings-update-manual-link'].href, 'https://github.com/TheLANIntelligence/TLI/releases');
  f.handler(() => undefined); f.setStatus(available); await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Download update');
  assert.equal(f.nodes['settings-update-manual-link'].hidden, true);
});

test('an older passive GET cannot overwrite a newer user check', async () => {
  const f = fixture(); await f.start();
  let finish;
  f.handler(url => url === '/update/status' ? new Promise(resolve => { finish = resolve; }) : { ...available, state: 'up_to_date' });
  const pending = f.poll(15000); await flush();
  await f.nodes['settings-check-update-btn'].click(); finish(available); await pending;
  assert.equal(f.nodes['settings-update-state'].textContent, 'Up to date');
  assert.equal(f.nodes['settings-update-action-btn'].hidden, true);
});

test('reconnecting recovers unknown saved preferences without overwriting later unsaved edits', async () => {
  const f = fixture({ ...available, auto_check: null }); await f.start();
  assert.equal(f.nodes['settings-update-url-save'].disabled, true);
  f.setStatus(available); await f.nodes['settings-check-update-btn'].click();
  assert.equal(f.nodes['settings-update-url-save'].disabled, false);
  assert.equal(f.nodes['settings-update-auto-check'].checked, false);
  f.nodes['settings-update-url'].value = 'https://custom.example/releases.json';
  f.nodes['settings-update-auto-check'].checked = true;
  await f.nodes['settings-check-update-btn'].click();
  assert.equal(f.nodes['settings-update-url'].value, 'https://custom.example/releases.json');
  assert.equal(f.nodes['settings-update-auto-check'].checked, true);
});

const installReady = {...ready, can_install:true, install_reason:'', install_operation:null};
const preview = () => ({schema_version:1, protocol:'host-lifecycle-v1', instance_id:'old_process', installation_id:'original_install',
  preview_id:'review_fixture', action:'install', expires_at:Date.now()/1000+60, current_version:'1.3.4', version:'1.3.5',
  current_url:'http://127.0.0.1:8000/', next_url:'http://127.0.0.1:8000/',
  consequences:['Active work will stop.'], preserves:['data','settings','models','Python environment']});
const receipt = (overrides={}) => ({...preview(), request_id:'a'.repeat(32), status:'accepted', accepted:true, ...overrides});
const installFixture = (overrides={}) => {
  const f = fixture(installReady, overrides);
  f.handler(url => url === '/update/install/preview' ? preview() : url === '/update/install/confirm' || url.startsWith('/update/install/receipt/') ? receipt() : url.endsWith('/lifecycle/ready') ? {schema_version:1, instance_id:'new_process', installation_id:'original_install', current_version:'1.3.5'} : undefined);
  return f;
};

test('verified download requires an explicit interruption review before one install request', async () => {
  const f = installFixture(); await f.start();
  assert.equal(f.nodes['settings-update-action-btn'].textContent, 'Install and restart…');
  assert.equal(f.calls.length, 1); assert.equal(f.nodes['tli-update-install-dialog'].open, undefined);
  await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.nodes['tli-update-install-dialog'].open, true);
  assert.equal(f.nodes['tli-update-install-cancel'].focused, true);
  assert.equal(f.nodes['tli-update-install-confirm'].disabled, false);
  assert.match(f.nodes['tli-update-install-preserves'].textContent, /original installation: data, settings, models/);
  assert.match(html, /Finish active chats, tasks, scans and downloads/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/confirm')).length, 0);
  await f.nodes['tli-update-install-confirm'].click(); await f.nodes['tli-update-install-confirm'].emit('click');
  const confirms = f.calls.filter(call => call.url.endsWith('/confirm')); assert.equal(confirms.length, 1);
  assert.deepEqual(JSON.parse(confirms[0].body), {preview_id:'review_fixture', request_id:'a'.repeat(32)});
  assert.match(f.nodes['tli-update-install-status'].textContent, /accepted.*Waiting/);
  assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.4'); assert.equal(f.navigations.length, 0);
});

test('restart confirmation requires same installation, a new process and exact reviewed version before explicit reload', async () => {
  const f = installFixture(); await f.start(); await f.nodes['settings-update-action-btn'].click(); await f.nodes['tli-update-install-confirm'].click();
  await f.poll(1000);
  assert.equal(f.nodes['tli-update-install-title'].textContent, 'Update confirmed');
  assert.equal(f.nodes['settings-tli-version'].textContent, 'v1.3.5');
  assert.match(f.nodes['tli-update-install-status'].textContent, /v1\.3\.5.*new process/);
  assert.equal(f.nodes['tli-update-install-reload'].hidden, false); assert.equal(f.navigations.length, 0);
  assert.equal(f.calls.filter(call => call.url.includes('/receipt/')).length, 0, 'A restarted process has lost the old PIN session; public identity is sufficient');
  await f.nodes['tli-update-install-reload'].click(); assert.deepEqual(f.navigations, ['http://127.0.0.1:8000/']);
});

test('same process, wrong installation and wrong version never report update confirmation', async () => {
  for (const host of [
    {instance_id:'old_process', installation_id:'original_install', current_version:'1.3.5'},
    {instance_id:'new_process', installation_id:'other_install', current_version:'1.3.5'},
    {instance_id:'new_process', installation_id:'original_install', current_version:'1.3.4'},
    {instance_id:'new_process', installation_id:'original_install'},
  ]) {
    const f = installFixture(); f.handler(url => url === '/update/install/preview' ? preview() : url.endsWith('/confirm') ? receipt() : url.includes('/receipt/') ? receipt({status:'completed'}) : url.endsWith('/lifecycle/ready') ? {schema_version:1,...host} : undefined);
    await f.start(); await f.nodes['settings-update-action-btn'].click(); await f.nodes['tli-update-install-confirm'].click(); await f.poll(1000);
    assert.notEqual(f.nodes['tli-update-install-title'].textContent, 'Update confirmed');
    assert.equal(f.nodes['tli-update-install-reload'].hidden, true);
    assert.equal(f.calls.filter(call => call.url.endsWith('/confirm')).length, 1);
    if (host.instance_id !== 'old_process') assert.equal(f.calls.filter(call => call.url.includes('/receipt/')).length, 0);
  }
});

test('lost install acknowledgement recovers with reads and never replays installation after reopening', async () => {
  const f = installFixture(); f.handler(url => url === '/update/install/preview' ? preview() : url.endsWith('/confirm') ? Promise.reject(new TypeError('Disconnected')) : url.endsWith('/lifecycle/ready') ? {schema_version:1, instance_id:'new_process', installation_id:'original_install', current_version:'1.3.5'} : undefined);
  await f.start(); await f.nodes['settings-update-action-btn'].click(); await f.nodes['tli-update-install-confirm'].click();
  assert.match(f.nodes['tli-update-install-status'].textContent, /not confirmed.*Nothing will be resent/);
  await f.nodes['tli-update-install-cancel'].click(); await f.nodes['settings-update-action-btn'].click();
  await f.nodes['tli-update-install-confirm'].emit('click'); await f.nodes['tli-update-install-check'].click();
  assert.equal(f.calls.filter(call => call.url.endsWith('/confirm')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/preview')).length, 1);
  assert.equal(f.nodes['tli-update-install-title'].textContent, 'Update confirmed');
});

test('changed reviewed address requires deliberate navigation and receives no automatic credentials or checks', async () => {
  const f = installFixture(); f.handler(url => url === '/update/install/preview' ? {...preview(),next_url:'https://localhost:9443/'} : url.endsWith('/confirm') ? receipt({next_url:'https://localhost:9443/'}) : undefined);
  await f.start(); await f.nodes['settings-update-action-btn'].click(); await f.nodes['tli-update-install-confirm'].click();
  assert.equal(f.nodes['tli-update-install-reload'].hidden, false);
  await f.nodes['tli-update-install-check'].click(); assert.equal(f.calls.filter(call => call.url.endsWith('/lifecycle/ready')).length, 0);
  assert.ok(f.calls.every(call => call.url.startsWith('/'))); assert.equal(f.navigations.length, 0);
  await f.nodes['tli-update-install-reload'].click(); assert.deepEqual(f.navigations, ['https://localhost:9443/']);
});

for (const change of [{next_url:'https://attacker.invalid/'},{version:'9.9.9'},{expires_at:0},{installation_id:null},{consequences:'Not a list'}]) test('invalid install review is nonexecuting: '+JSON.stringify(change), async () => {
  const f = installFixture(); f.handler(url => url === '/update/install/preview' ? {...preview(),...change} : undefined);
  await f.start(); await f.nodes['settings-update-action-btn'].click();
  assert.equal(f.nodes['tli-update-install-confirm'].disabled, true);
  await f.nodes['tli-update-install-confirm'].emit('click'); assert.equal(f.calls.filter(call => call.url.endsWith('/confirm')).length, 0);
  assert.equal(f.nodes['tli-update-install-manual'].hidden, false);
});

for (const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide']) test(event+' clears private update views and rejects late reviews; unlock alone never resumes', async () => {
  const f = installFixture(); let finish;
  f.handler(url => url === '/update/install/preview' ? new Promise(resolve => {finish=resolve;}) : undefined);
  await f.start(); const work=f.nodes['settings-update-action-btn'].click(); await flush();
  await f.event(event); await f.event('tli-session-unlocked');
  finish({...preview(), consequences:['PRIVATE OLD PATH']}); await work;
  assert.equal(f.nodes['tli-update-install-dialog'].open, false);
  assert.equal(f.nodes['settings-update-path'].textContent, ''); assert.equal(f.nodes['settings-update-url'].value, '');
  assert.doesNotMatch(f.nodes['tli-update-install-details'].textContent, /PRIVATE/);
  const before=f.calls.length; await f.nodes['tli-update-install-confirm'].emit('click'); await f.nodes['settings-check-update-btn'].emit('click'); await f.nodes['settings-update-url-save'].emit('click');
  assert.equal(f.calls.length, before);
  if(event==='pagehide')await f.event('pageshow');
  await f.event('tli-private-observation-ready');
  assert.equal(f.calls.length, before+1); assert.equal(f.calls.at(-1).url, '/update/status');
  assert.equal(f.calls.filter(call=>call.url.endsWith('/confirm')).length,0);
});

test('closing the review never installs and a late closed review cannot replace a new review', async () => {
  const f = installFixture(); let finish; let count=0;
  f.handler(url => url === '/update/install/preview' ? (++count===1 ? new Promise(resolve=>{finish=resolve;}) : {...preview(),preview_id:'new_review'}) : undefined);
  await f.start(); const first=f.nodes['settings-update-action-btn'].click(); await flush(); await f.nodes['tli-update-install-cancel'].click();
  await f.nodes['settings-update-action-btn'].click(); finish({...preview(),preview_id:'old_review'}); await first;
  await f.nodes['tli-update-install-confirm'].click();
  assert.equal(JSON.parse(f.calls.find(call=>call.url.endsWith('/confirm')).body).preview_id,'new_review');
});

test('an old download completion and preference save cannot write into a later session or trigger follow-up reads', async () => {
  for (const kind of ['apply','settings']) {
    const f=fixture(); let finish; await f.start(); f.handler(url=>url==='/update/'+kind ? new Promise(resolve=>{finish=resolve;}) : undefined);
    const pending=f.nodes[kind==='apply'?'settings-update-action-btn':'settings-update-url-save'].click(); await flush();
    await f.event('tli-session-locked'); await f.event('tli-session-unlocked'); const before=f.calls.length;
    finish({ok:true}); await pending;
    assert.equal(f.calls.length,before); assert.equal(f.nodes['settings-update-url-save'].disabled,true);
    assert.equal(f.nodes['settings-update-url'].value,''); assert.equal(f.toasts.length,0);
  }
});

test('dependency preparation and a failed installer remain distinct from a confirmed new version', async () => {
  const f=installFixture();let phase='preparing';
  f.handler(url=>url.endsWith('/preview')?preview():url.endsWith('/confirm')?receipt():url.includes('/receipt/')?receipt({status:phase,installed:true,message:'Dependency setup needs attention.'}):url.endsWith('/lifecycle/ready')?{schema_version:1,installation_id:'original_install',instance_id:'old_process',current_version:'1.3.4'}:undefined);
  await f.start();await f.nodes['settings-update-action-btn'].click();await f.nodes['tli-update-install-confirm'].click();await f.poll(1000);
  assert.match(f.nodes['tli-update-install-status'].textContent,/Preparing updated Python.*Model weights remain/);
  assert.equal(f.nodes['settings-tli-version'].textContent,'v1.3.4');phase='failed';await f.poll(2000);
  assert.match(f.nodes['tli-update-install-status'].textContent,/Dependency setup needs attention/);
  assert.equal(f.nodes['tli-update-install-reload'].hidden,true);assert.equal(f.nodes['tli-update-install-manual'].hidden,false);
  assert.equal([...f.timers.values()].filter(t=>t.ms===2000).length,0);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/confirm')).length,1);
});

test('an existing installation receipt is opened for explicit connection checks without a fresh review or command',async()=>{
  const f=installFixture();f.setStatus({...installReady,install_operation:receipt({status:'installing'})});await f.start();
  assert.equal(f.nodes['settings-update-action-btn'].textContent,'View installation');assert.equal(f.calls.length,1);
  await f.nodes['settings-update-action-btn'].click();assert.equal(f.calls.length,1);
  assert.match(f.nodes['tli-update-install-status'].textContent,/Installing the verified application files/);
  await f.nodes['tli-update-install-check'].click();assert.equal(f.nodes['tli-update-install-title'].textContent,'Update confirmed');
  assert.ok(f.calls.every(call=>!call.method));
});

test('a late accepted install cannot revive old progress after account change or enable another command',async()=>{
  const f=installFixture();let finish;
  f.handler(url=>url.endsWith('/preview')?preview():url.endsWith('/confirm')?new Promise(resolve=>{finish=resolve;}):undefined);
  await f.start();await f.nodes['settings-update-action-btn'].click();const pending=f.nodes['tli-update-install-confirm'].click();await flush();
  await f.event('tli-account-changed');await f.event('tli-session-unlocked');finish(receipt());await pending;
  assert.equal(f.nodes['tli-update-install-dialog'].open,false);assert.equal(f.nodes['tli-update-install-status'].textContent,'');
  assert.equal([...f.timers.values()].filter(t=>[1000,2000].includes(t.ms)).length,0);
  await f.nodes['tli-update-install-confirm'].emit('click');assert.equal(f.calls.filter(call=>call.url.endsWith('/confirm')).length,1);
});

test('phone and remote clients cannot request installation even if a malformed status advertises it',async()=>{
  for(const options of [{mobile:true},{url:'https://192.168.1.4:8000/'}]){
    const f=installFixture(options);await f.start();await f.nodes['settings-update-action-btn'].emit('click');await f.nodes['tli-update-install-confirm'].emit('click');
    assert.equal(f.nodes['settings-update-action-btn'].hidden,true);assert.equal(f.calls.length,1);
  }
});

test('an initially denied status stays empty until verified unlock recovers preferences with only a read',async()=>{
  const f=fixture();f.handler(url=>url==='/update/status'?{ok:false,status:401,json:async()=>({detail:'Unlock TLI first'})}:undefined);
  await f.start();assert.equal(f.nodes['settings-update-url-save'].disabled,true);assert.equal(f.nodes['settings-update-path'].textContent,'');
  await f.event('tli-session-locked');await f.event('tli-session-unlocked');const before=f.calls.length;
  assert.equal(f.calls.length,before);assert.equal(f.nodes['settings-update-url-save'].disabled,true);
  f.handler(()=>undefined);await f.event('tli-private-observation-ready');
  assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1).url,'/update/status');assert.ok(f.calls.every(call=>!call.method));
  assert.equal(f.nodes['settings-update-url'].value,available.update_url);assert.equal(f.nodes['settings-update-url-save'].disabled,false);
  assert.equal(f.nodes['settings-update-auto-check'].checked,false);
});

test('restart PIN lock retains only an explicit version check after verified access, without installation replay',async()=>{
  const f=installFixture();await f.start();await f.nodes['settings-update-action-btn'].click();await f.nodes['tli-update-install-confirm'].click();
  await f.event('tli-session-locked');await f.event('tli-session-locked');const before=f.calls.length;
  assert.equal(f.nodes['tli-update-install-dialog'].open,false);assert.equal(f.nodes['tli-update-install-destination'].textContent,'');
  assert.equal(f.nodes['settings-update-path'].textContent,'');
  await f.event('tli-session-unlocked');assert.equal(f.calls.length,before);await f.nodes['settings-update-action-btn'].emit('click');assert.equal(f.calls.length,before);
  await f.event('tli-private-observation-ready');assert.equal(f.calls.length,before);
  assert.equal(f.nodes['settings-update-action-btn'].textContent,'View installation');
  await f.nodes['settings-update-action-btn'].click();assert.equal(f.calls.length,before);
  assert.equal(f.nodes['tli-update-install-confirm'].hidden,true);await f.nodes['tli-update-install-confirm'].emit('click');
  await f.nodes['tli-update-install-check'].click();assert.equal(f.nodes['tli-update-install-title'].textContent,'Update confirmed');
  assert.equal(f.calls.filter(call=>call.url.endsWith('/confirm')).length,1);assert.equal(f.calls.filter(call=>call.url.endsWith('/preview')).length,1);
  assert.equal(f.calls.at(-1).url,'/api/host-control/v1/lifecycle/ready');
});

for(const event of ['tli-account-changed','tli-user-changed','pagehide'])test(event+' discards an install retained during PIN lock',async()=>{
  const f=installFixture();await f.start();await f.nodes['settings-update-action-btn'].click();await f.nodes['tli-update-install-confirm'].click();
  await f.event('tli-session-locked');await f.event(event);await f.event('tli-session-unlocked');if(event==='pagehide')await f.event('pageshow');
  await f.event('tli-private-observation-ready');assert.equal(f.nodes['settings-update-action-btn'].textContent,'Install and restart…');
  assert.equal(f.nodes['tli-update-install-dialog'].open,false);assert.equal(f.calls.filter(call=>call.url.endsWith('/confirm')).length,1);
  assert.equal(f.calls.at(-1).url,'/update/status');
});
