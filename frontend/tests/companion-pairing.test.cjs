const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../js/native-companion.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const origin = 'https://192.0.2.8:8443';
const configured = { host: '0.0.0.0', port: 8443, https: true };
const startup = { ok: true, configured: true, saved: configured, running: configured, effective_next: configured, restart_required: false, environment_overrides: [] };
const setup = { pin_enabled: true, tls_enabled: true, lan_enabled: true, certificate_ready: true, pairing_ready: true, origins: [origin] };
const phone = { id: 'synthetic-phone', name: 'Test iPhone', platform: 'ios', created_at: '2026-09-07T13:00:00Z' };
const helperSetup = { schema_version:1, setup_command:'TLI_Setup.ps1', instructions:['Enable locally, then review on your phone.'], host_control:{schema_version:1,enabled:true,available:true,origin:'https://192.168.50.12:8001',helper_id:'helper-1',node_id:'host-1',certificate_sha256:'a'.repeat(64),capabilities:{start_backend:true,wake_host:false},reason:'Configured; check availability from your phone.'} };
function descendants(element) { return element.children.flatMap(child => [child, ...descendants(child)]); }
const text = element => [element.textContent, ...descendants(element).map(child => child.textContent)].join(' ');
function fixture({ browserOrigin = origin, mount = false } = {}) {
  const nodes = {}, events = {}, documentEvents = {}, calls = [], timers = new Map();
  let handler, now = Date.parse('2026-09-07T14:00:00Z'), nextTimer = 1;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  function element(tag) {
    const n = { tag, children: [], textContent: '', attrs: {}, dataset: {}, handlers: {}, value: '', hidden: false, disabled: false, checked: false,
      classList: { toggle() {}, contains() { return false; } }, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, fn) { (this.handlers[key] ||= []).push(fn); },
      fire(key) { return Promise.all((this.handlers[key] || []).map(fn => fn({}))); }, click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      focus() {}, scrollIntoView() {}, select() {}, querySelectorAll(selector) { return descendants(this).filter(child => child.tag === selector); },
    };
    Object.defineProperty(n, 'id', { set(id) { nodes[id] = n; }, get() { return Object.keys(nodes).find(key => nodes[key] === n); } }); return n;
  }
  nodes['panel-companion'] = element('section');
  if (mount) { const existing = element('section'); existing.id = 'native-companion-settings'; nodes['panel-companion'].append(existing); }
  const doc = { readyState: 'complete', hidden: false, getElementById: id => nodes[id] || null, createElement: element, addEventListener: (type, fn) => (documentEvents[type] ||= []).push(fn) };
  const win = { location: { origin: browserOrigin }, addEventListener: (type, fn) => (events[type] ||= []).push(fn) };
  const context = vm.createContext({ Date: Clock, AbortController, document: doc, window: win,
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      calls.push({ url, options }); let response = handler ? await handler(url, options) : undefined;
      if (response === undefined) response = { data: url.endsWith('/startup') ? startup : url.endsWith('/setup') ? setup : { devices: [phone] } };
      return { ok: (response.status || 200) >= 200 && (response.status || 200) < 300, status: response.status || 200, json: async () => response.data };
    },
  });
  vm.runInContext(script, context);
  const root = nodes['native-companion-settings'];
  return { nodes, calls, root, doc, events, api: win.TLICompanion,
    handler(value) { handler = value; }, async open() { await win.TLICompanion.onOpen(); await tick(); },
    refresh() { return win.TLICompanion.refresh(); }, close() { nodes['panel-companion'].hidden = true; win.TLICompanion.onClose(); },
    event(type) { for (const fn of events[type] || []) fn(); },
    background() { doc.hidden = true; for (const fn of documentEvents.visibilitychange || []) fn(); },
    foreground() { doc.hidden = false; for (const fn of documentEvents.visibilitychange || []) fn(); },
    pairing(extra = {}) { const expires_at = new Clock(now + 300000).toISOString(); return { bundle: JSON.stringify({ version: 1, origin, token: 'synthetic-invitation', certificate_der: 'synthetic-certificate', node_id: 'test-host', node_name: 'Test host', expires_at }), expires_at, ...extra }; },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await tick(); },
    mutations() { return calls.filter(call => call.options.method !== 'GET'); },
    generate(force = false) { return force ? nodes['native-companion-generate'].fire('click') : nodes['native-companion-generate'].click(); },
    button(label) { return descendants(nodes['native-companion-devices']).find(item => item.tag === 'button' && item.textContent === label); },
  };
}

test('Phone Companion reuses its mount and opening any step only reads authenticated setup', async () => {
  const f = fixture({ mount: true }); assert.equal(f.calls.length, 0);
  await f.api.open({ step: 'pair' }); await tick();
  assert.equal(f.root.dataset.companionBound, '1');
  assert.equal(descendants(f.root).filter(node => node.id === 'native-companion-generate').length, 1);
  assert.equal(f.nodes['native-companion-generate'].disabled, false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/setup')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/startup')).length, 0, 'legacy startup form must not compete with guided setup');
  assert.equal(f.calls.filter(call => call.url.endsWith('/paired-devices')).length, 1);
  assert.equal(f.mutations().length, 0);
});

test('Android guide separates public installation from private pairing and does not claim phone or AI readiness', async () => {
  const f=fixture();await f.open();
  assert.equal(f.nodes['native-companion-download'].href,'https://thelanintelligence.com/download/#android');
  assert.equal(f.nodes['native-companion-install-qr'].src,'/assets/companion-install.svg');
  assert.match(f.nodes['native-companion-install-qr'].alt,/Public Android download/);
  assert.equal(f.nodes['native-companion-step-connection'].hidden,true);
  assert.equal(f.nodes['native-companion-step-install'].hidden,false);
  assert.equal(f.nodes['native-companion-step-pair'].hidden,true);
  await f.nodes['native-companion-installed'].click();
  assert.equal(f.nodes['native-companion-step-pair'].hidden,false);
  assert.equal(f.mutations().length,0);
  f.handler((url,options)=>options.method==='POST'?{data:f.pairing({qr_format:'https_fragment_v1'})}:undefined);await f.generate();
  assert.match(text(f.nodes['native-companion-pairing']),/Scan inside the TLI Android app/);
  await f.nodes['native-companion-scan-done'].click();
  assert.equal(f.nodes['native-companion-step-chat'].hidden,false);
  assert.match(f.nodes['native-companion-chat-status'].textContent,/does not mean the phone is online/);
  assert.match(text(f.nodes['native-companion-step-chat']),/Once the app confirms your connection/);
  assert.equal(f.mutations().length,1);
});

test('a reviewed stable Android hostname avoids arbitrary adapter selection and preserves an explicit fallback', async () => {
  const f=fixture({browserOrigin:'https://localhost:8000'}),stable='https://studio.local:8000',ip='https://192.168.50.12:8000';
  f.handler(url=>url.endsWith('/setup')?{data:{...setup,origins:['https://172.30.0.1:8000',ip,stable]}}:undefined);await f.open();
  assert.equal(f.nodes['native-companion-origin'].value,stable);
  assert.equal(f.mutations().length,0);
  f.nodes['native-companion-origin'].value=ip;await f.nodes['native-companion-origin'].fire('change');await f.refresh();
  assert.equal(f.nodes['native-companion-origin'].value,ip);
  assert.equal(f.mutations().length,0);
});

test('preparation is required before installation and pairing are shown', async () => {
  const f=fixture({browserOrigin:'http://localhost:8000'});await f.open();
  assert.equal(f.nodes['native-companion-step-install'].hidden,true);
  assert.equal(f.nodes['native-companion-step-pair'].hidden,true);
  assert.equal(f.nodes['native-companion-step-connection'].hidden,false);
});

test('Host Start setup is a deliberate owner read, with local installation guidance and no readiness claim', async () => {
  const f=fixture();await f.open();assert.equal(f.calls.some(c=>c.url.includes('/host-control/')),false);
  f.handler(url=>url==='/api/host-control/v1/setup'?{data:helperSetup}:undefined);
  await f.nodes['native-host-start-check'].click();
  assert.match(f.nodes['native-host-start-status'].textContent,/Listener availability has not been checked/);
  assert.match(text(f.nodes['native-companion-host-start']), /cannot wake.*TLI_Setup\.bat.*Enable phone host start/s);
  assert.match(f.nodes['native-host-start-address'].textContent,/192\.168\.50\.12:8001/);
  assert.equal(f.nodes['native-host-start-address'].hidden,false);
  for(const [id,label] of [['connection','Connection details'],['setup','Set up on this computer']]){
    const disclosure=f.nodes['native-host-start-'+id];assert.equal(disclosure.tag,'details');assert.equal(disclosure.open,false);
    assert.equal(disclosure.children[0].tag,'summary');assert.equal(disclosure.children[0].textContent,label);
  }
  assert.match(text(f.nodes['native-host-start-details']),/Computer identity.*host-1.*Helper identity.*helper-1.*Certificate fingerprint/s);
  assert.equal(f.mutations().length,0);
});

test('Host Start setup never trusts incomplete identity or an unsupported host response', async () => {
  for(const response of [{status:404,data:{}},{data:{...helperSetup,host_control:{...helperSetup.host_control,certificate_sha256:'bad'}}}]){
    const f=fixture();await f.open();f.handler(url=>url==='/api/host-control/v1/setup'?response:undefined);await f.nodes['native-host-start-check'].click();
    assert.match(f.nodes['native-host-start-status'].textContent,/does not provide Host Start|incomplete/);assert.equal(f.mutations().length,0);assert.equal(f.nodes['native-host-start-details'].children.length,0);
  }
});

test('Host Start setup ignores late results and cannot read after lock or leaving', async () => {
  for(const leave of ['close','background','lock']){
    const f=fixture();await f.open();let resolve;f.handler(url=>url==='/api/host-control/v1/setup'?new Promise(done=>{resolve=done}):undefined);
    const pending=f.nodes['native-host-start-check'].click();await tick();if(leave==='lock')f.event('tli-session-locked');else f[leave]();
    resolve({data:helperSetup});await pending;assert.equal(f.nodes['native-host-start-details'].children.length,0);
    const count=f.calls.length;await f.nodes['native-host-start-check'].fire('click');assert.equal(f.calls.length,count);
  }
});

function remoteSetup(origins = ['https://192.168.50.12:8443']) {
  return { ...setup, origins, remote_access: { schema_version:1, mode:'routed_lan', host_ready:origins.some(value=>!value.includes('169.254')), checked_at:'2026-09-07T14:00:00Z', eligible_origins:origins.filter(value=>!value.includes('169.254')), route_status:'not_tested', tunnel_status:'unknown', reason:'Existing host HTTPS setup checked. No private-network route was tested or configured.' } };
}

test('optional remote guide shows the exact selected host route and performs only ordinary setup reads', async () => {
  const f=fixture();f.handler(url=>url.endsWith('/setup')?{data:remoteSetup()}:undefined);
  await f.api.open({step:'remote'});await tick();
  assert.equal(f.nodes['native-companion-remote'].open,true);
  assert.match(f.nodes['native-companion-remote-status'].textContent,/Host setup ready.*Remote path: not tested/);
  assert.match(text(f.nodes['native-companion-remote-plan']),/192\.168\.50\.12\/32.*TCP port 8443/);
  assert.match(text(f.nodes['native-companion-remote']),/not configured any route, firewall or VPN/);
  assert.equal(f.mutations().length,0);
  assert.deepEqual(f.calls.map(c=>c.url).sort(),['/api/companion/v1/paired-devices','/api/companion/v1/setup']);
});

test('remote address plan follows deliberate LAN selection and never treats link-local as remotely routable', async () => {
  const f=fixture();f.handler(url=>url.endsWith('/setup')?{data:remoteSetup(['https://169.254.8.2:8443','https://192.168.50.12:8443'])}:undefined);await f.open();
  assert.match(text(f.nodes['native-companion-remote-plan']),/Review the address/);
  f.nodes['native-companion-origin'].value='https://169.254.8.2:8443';await f.nodes['native-companion-origin'].fire('change');
  assert.match(text(f.nodes['native-companion-remote-plan']),/unsuitable.*Existing phone pairings have not changed/);
  assert.doesNotMatch(text(f.nodes['native-companion-remote-plan']),/169\.254\.8\.2\/32/);
  f.nodes['native-companion-origin'].value='https://192.168.50.12:8443';await f.nodes['native-companion-origin'].fire('change');
  assert.match(text(f.nodes['native-companion-remote-plan']),/192\.168\.50\.12\/32/);assert.equal(f.mutations().length,0);
});

test('missing or contradictory remote metadata cannot claim readiness or disrupt ordinary LAN pairing', async () => {
  for(const alter of [value=>delete value.remote_access,value=>value.remote_access.route_status='verified',value=>value.remote_access.eligible_origins=['https://8.8.8.8'],value=>value.remote_access.host_ready=false,value=>value.remote_access.checked_at='invalid']){
    const f=fixture(),value=remoteSetup();alter(value);f.handler(url=>url.endsWith('/setup')?{data:value}:undefined);await f.open();
    assert.match(f.nodes['native-companion-remote-status'].textContent,/not provided.*not tested/);
    assert.equal(f.nodes['native-companion-generate'].disabled,false);assert.equal(f.mutations().length,0);
  }
});

test('failed remote recheck retains dated prior facts but cannot leave current ready status', async () => {
  const f=fixture();f.handler(url=>url.endsWith('/setup')?{data:remoteSetup()}:undefined);await f.open();
  f.handler(url=>url.endsWith('/setup')?{status:503,data:{detail:'Synthetic unavailable'}}:undefined);await f.nodes['native-companion-remote-refresh'].click();
  assert.match(f.nodes['native-companion-remote-status'].textContent,/Host setup unavailable.*not tested/);
  assert.match(text(f.nodes['native-companion-remote-plan']),/Previous host details.*192\.168\.50\.12\/32/);
  assert.equal(f.nodes['native-companion-remote-status'].dataset.state,'unknown');assert.equal(f.mutations().length,0);
});

test('late remote setup cannot restore host addresses after lock, close or background', async () => {
  for(const leave of [f=>f.event('tli-session-locked'),f=>f.close(),f=>f.background()]){
    const f=fixture();let finish;f.handler(url=>url.endsWith('/setup')?new Promise(resolve=>{finish=resolve;}):undefined);
    const open=f.open();await tick();leave(f);finish({data:remoteSetup()});await open;
    assert.equal(f.nodes['native-companion-remote-plan'].children.length,0);assert.match(f.nodes['native-companion-remote-status'].textContent,/Unlock TLI/);assert.equal(f.mutations().length,0);
  }
});

test('forced duplicate remote rechecks coalesce and remain read-only', async () => {
  const f=fixture();await f.open();let finish;f.handler(url=>url.endsWith('/setup')?new Promise(resolve=>{finish=resolve;}):undefined);
  const a=f.nodes['native-companion-remote-refresh'].fire('click'),b=f.nodes['native-companion-remote-refresh'].fire('click');await tick();
  assert.equal(f.calls.filter(c=>c.url.endsWith('/setup')).length,2);finish({data:remoteSetup()});await Promise.all([a,b]);assert.equal(f.mutations().length,0);
});

test('unknown or contradictory connection facts never enable a pairing mutation', async () => {
  for (const value of [{ pairing_ready: true }, { ...setup, pin_enabled: false }, { ...setup, origins: [] }, { ...setup, origins: ['http://192.0.2.8:8443'] }]) {
    const f = fixture(); f.handler(url => url.endsWith('/setup') ? { data: value } : undefined); await f.open(); await f.generate(true);
    assert.equal(f.nodes['native-companion-generate'].disabled, true); assert.equal(f.nodes['native-companion-pair-state'].dataset.state, 'unavailable');
    assert.match(f.nodes['native-companion-status'].textContent, /Readiness is unknown/); assert.equal(f.mutations().length, 0);
  }
});

test('a browser using HTTP must switch to HTTPS before creating a native invitation', async () => {
  const f = fixture({ browserOrigin: 'http://192.0.2.8:8000' }); await f.open(); await f.generate(true);
  assert.equal(f.nodes['native-companion-generate'].disabled, true); assert.match(f.nodes['native-companion-pair-status'].textContent, /HTTPS address.*owner PIN/);
  assert.equal(f.mutations().length, 0);
});

test('forced duplicate pairing clicks reserve one request and validate the complete bundle', async () => {
  const f = fixture(); await f.open(); let finish;
  f.handler((url, options) => options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const first = f.generate(true), second = f.generate(true); await tick();
  assert.equal(f.mutations().length, 1); assert.equal(f.nodes['native-companion-generate'].disabled, true);
  assert.deepEqual(JSON.parse(f.mutations()[0].options.body), { origin });
  finish({ data: f.pairing() }); await Promise.all([first, second]);
  assert.equal(f.nodes['native-companion-pairing'].hidden, false); assert.match(text(f.nodes['native-companion-pairing']), /QR image is unavailable.*complete pairing bundle/);
  assert.equal(JSON.parse(f.nodes['native-companion-bundle'].value).token, 'synthetic-invitation'); assert.equal(f.nodes['native-companion-bundle'].readOnly, true);
});

test('malformed, expired and mismatched pairing responses cannot display a usable invitation', async () => {
  for (const change of [() => ({ ok: true }), f => f.pairing({ bundle: '{}' }), f => f.pairing({ expires_at: '2026-09-06T14:00:00Z' }), f => {
    const result = f.pairing(); const bundle = JSON.parse(result.bundle); bundle.origin = 'https://192.0.2.9:8443'; result.bundle = JSON.stringify(bundle); return result;
  }]) {
    const f = fixture(); await f.open(); f.handler((url, options) => options.method === 'POST' ? { data: change(f) } : undefined); await f.generate();
    assert.equal(f.nodes['native-companion-pairing'].hidden, true); assert.equal(f.mutations().length, 1);
    assert.match(f.nodes['native-companion-pair-status'].textContent, /invalid pairing bundle|did not confirm/);
  }
});

test('hiding an invitation clears private display without claiming or sending server cancellation', async () => {
  const f = fixture(); await f.open(); f.handler((url, options) => options.method === 'POST' ? { data: f.pairing() } : undefined); await f.generate();
  await f.nodes['native-companion-hide-code'].click();
  assert.equal(f.nodes['native-companion-pairing'].hidden, true); assert.equal(f.nodes['native-companion-pairing'].children.length, 0);
  assert.match(f.nodes['native-companion-pair-status'].textContent, /invitation remains valid until used or expired/);
  assert.equal(f.mutations().length, 1); assert.equal(f.nodes['native-companion-pair-state'].textContent, 'Ready to pair');
});

test('the local invitation display expires without retrying or creating another pairing', async () => {
  const f = fixture(); await f.open(); f.handler((url, options) => options.method === 'POST' ? { data: f.pairing() } : undefined); await f.generate();
  await f.advance(300001); assert.equal(f.nodes['native-companion-pairing'].children.length, 0); assert.match(f.nodes['native-companion-pair-status'].textContent, /expired/);
  assert.equal(f.mutations().length, 1);
});

test('late invitations are ignored after closing, locking or backgrounding the page', async () => {
  for (const end of [f => f.close(), f => f.event('tli-session-locked'), f => f.background()]) {
    const f = fixture(); await f.open(); let finish;
    f.handler((url, options) => options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : undefined);
    const sending = f.generate(true); await tick(); end(f); finish({ data: f.pairing() }); await sending;
    assert.equal(f.nodes['native-companion-pairing'].hidden, true); assert.equal(f.nodes['native-companion-pairing'].children.length, 0);
    assert.equal(f.mutations().length, 1); assert.equal(f.mutations()[0].options.signal.aborted, true);
  }
});

test('locking before queued request work starts sends no pairing or refresh request', async () => {
  for (const action of [f => f.generate(true), f => f.refresh()]) {
    const f = fixture(); await f.open(); const before = f.calls.length;
    const work = action(f); f.event('tli-session-locked'); await work;
    assert.equal(f.calls.length, before); assert.equal(f.nodes['native-companion-devices'].children.length, 0);
  }
});

test('overlapping refresh requests coalesce and do not create an invitation', async () => {
  const f = fixture(); await f.open(); let finish;
  f.handler(url => url.endsWith('/setup') ? new Promise(resolve => { finish = resolve; }) : undefined);
  const first = f.refresh(), second = f.refresh(); await tick(); assert.equal(f.calls.filter(call => call.url.endsWith('/setup')).length, 2);
  finish({ data: setup }); await Promise.all([first, second]); assert.equal(f.mutations().length, 0);
});

test('failed and malformed phone refreshes retain the previous list with its observation time', async () => {
  for (const failure of [{ status: 503, data: { detail: 'Phone access is unavailable.' } }, { data: { devices: [{ id: 'missing-fields' }] } }, { data: { ok: true } }]) {
    const f = fixture(); await f.open(); const previous = text(f.nodes['native-companion-devices']);
    f.handler(url => url.endsWith('/paired-devices') ? failure : undefined); await f.refresh();
    assert.equal(text(f.nodes['native-companion-devices']), previous); assert.match(f.nodes['native-companion-devices-status'].textContent, /Previous phones are retained from/);
    assert.equal(f.nodes['native-companion-devices-state'].textContent, 'Unavailable'); assert.equal(f.mutations().length, 0);
  }
});

test('a setup failure retains known phones but clears readiness and marks their list as not refreshed', async () => {
  const f = fixture(); await f.open(); f.handler(url => url.endsWith('/setup') ? { status: 503, data: { detail: 'Host unavailable' } } : undefined); await f.refresh();
  assert.match(text(f.nodes['native-companion-devices']), /Test iPhone/); assert.match(f.nodes['native-companion-devices-status'].textContent, /Previous phones are retained/);
  assert.equal(f.nodes['native-companion-devices-state'].textContent, 'Not refreshed'); assert.equal(f.nodes['native-companion-generate'].disabled, true);
});

test('removing phone access requires deliberate confirmation and permits cancellation', async () => {
  const f = fixture(); await f.open(); await f.button('Remove access').click();
  assert.equal(f.mutations().length, 0); assert.equal(f.button('Keep access').hidden, false); await f.button('Keep access').click();
  assert.ok(f.button('Remove access')); assert.equal(f.mutations().length, 0);
  await f.button('Remove access').click(); let finish;
  f.handler((url, options) => options.method === 'DELETE' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const removing = f.button('Confirm removal').fire('click'); const duplicate = f.button('Confirm removal').fire('click'); await tick(); assert.equal(f.mutations().length, 1);
  assert.equal(f.mutations()[0].url, '/api/companion/v1/paired-devices/synthetic-phone');
  finish({ data: { ok: true } }); await Promise.all([removing, duplicate]);
  assert.match(f.nodes['native-companion-devices-status'].textContent, /Access removed for Test iPhone/); assert.match(text(f.nodes['native-companion-devices']), /No native phones paired/);
});

test('failed removal keeps the phone and reports that access was not confirmed removed', async () => {
  const f = fixture(); await f.open(); f.handler((url, options) => options.method === 'DELETE' ? { data: { ok: false } } : undefined);
  await f.button('Remove access').click(); await f.button('Confirm removal').click();
  assert.match(text(f.nodes['native-companion-devices']), /Test iPhone/); assert.match(f.nodes['native-companion-devices-status'].textContent, /did not confirm removal.*may still be active/);
  assert.equal(f.mutations().length, 1);
});

test('a pending phone-list response cannot restore private names after locking', async () => {
  const f = fixture(); let finish; f.handler(url => url.endsWith('/paired-devices') ? new Promise(resolve => { finish = resolve; }) : undefined);
  const opening = f.open(); await tick(); f.event('tli-session-locked'); finish({ data: { devices: [phone] } }); await opening;
  assert.equal(f.nodes['native-companion-devices'].children.length, 0); assert.match(f.nodes['native-companion-devices-status'].textContent, /Unlock TLI/);
});

test('returning to Companion rechecks facts without replaying the prior invitation', async () => {
  const f = fixture(); await f.open(); f.handler((url, options) => options.method === 'POST' ? { data: f.pairing() } : undefined); await f.generate();
  f.close(); f.nodes['panel-companion'].hidden = false; await f.open();
  assert.equal(f.nodes['native-companion-pairing'].hidden, true); assert.equal(f.mutations().length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/setup')).length, 2);
});

const virtualOrigin = 'https://172.30.128.1:8000';
const ethernetOrigin = 'https://192.168.4.156:8000';
const alternateOrigin = 'https://10.0.0.20:8000';
function pairingFor(f, selectedOrigin) {
  const result = f.pairing(), bundle = JSON.parse(result.bundle);
  bundle.origin = selectedOrigin;
  return { ...result, bundle: JSON.stringify(bundle) };
}

test('multiple checked addresses require a deliberate choice from a localhost browser', async () => {
  const f = fixture({ browserOrigin: 'https://localhost:8000' });
  f.handler(url => url.endsWith('/setup') ? { data: { ...setup, origins: [virtualOrigin, ethernetOrigin] } } : undefined);
  await f.open();
  const select = f.nodes['native-companion-origin'];
  assert.equal(select.value, '');
  assert.equal(select.disabled, false, 'the user must be able to resolve an ambiguous address');
  assert.equal(f.nodes['native-companion-generate'].disabled, true);
  await f.generate(true);
  assert.equal(f.mutations().length, 0, 'a forced click cannot silently choose the first adapter');
});

test('an exact checked LAN browser origin is preferred over the first virtual adapter', async () => {
  const f = fixture({ browserOrigin: ethernetOrigin });
  f.handler(url => url.endsWith('/setup') ? { data: { ...setup, origins: [virtualOrigin, ethernetOrigin] } } : undefined);
  await f.open();
  assert.equal(f.nodes['native-companion-origin'].value, ethernetOrigin);
  assert.equal(f.nodes['native-companion-generate'].disabled, false);
  assert.equal(f.mutations().length, 0);
});

test('an explicit checked address survives refresh and is the address submitted for pairing', async () => {
  const f = fixture({ browserOrigin: 'https://localhost:8000' });
  f.handler((url, options) => url.endsWith('/setup') ? { data: { ...setup, origins: [virtualOrigin, ethernetOrigin] } } :
    options.method === 'POST' ? { data: pairingFor(f, ethernetOrigin) } : undefined);
  await f.open();
  const select = f.nodes['native-companion-origin'];
  select.value = ethernetOrigin; await select.fire('change');
  assert.equal(f.nodes['native-companion-generate'].disabled, false);
  assert.equal(f.mutations().length, 0, 'choosing an address must not create an invitation');
  await f.refresh();
  assert.equal(select.value, ethernetOrigin);
  assert.equal(f.mutations().length, 0);
  await f.generate();
  assert.equal(f.mutations().length, 1);
  assert.deepEqual(JSON.parse(f.mutations()[0].options.body), { origin: ethernetOrigin });
  assert.equal(JSON.parse(f.nodes['native-companion-bundle'].value).origin, ethernetOrigin);
});

test('when the chosen address disappears, refresh requires a fresh deliberate choice', async () => {
  const f = fixture({ browserOrigin: 'https://localhost:8000' });
  let origins = [virtualOrigin, ethernetOrigin, alternateOrigin];
  f.handler(url => url.endsWith('/setup') ? { data: { ...setup, origins } } : undefined);
  await f.open();
  const select = f.nodes['native-companion-origin'];
  select.value = ethernetOrigin; await select.fire('change');
  origins = [virtualOrigin, alternateOrigin];
  await f.refresh();
  assert.equal(select.value, '');
  assert.equal(select.disabled, false);
  assert.equal(f.nodes['native-companion-generate'].disabled, true);
  await f.generate(true);
  assert.equal(f.mutations().length, 0);
});

test('changing the address hides the previous invitation without cancelling or replacing it', async () => {
  const f = fixture({ browserOrigin: 'https://localhost:8000' });
  f.handler((url, options) => url.endsWith('/setup') ? { data: { ...setup, origins: [virtualOrigin, ethernetOrigin] } } :
    options.method === 'POST' ? { data: pairingFor(f, ethernetOrigin) } : undefined);
  await f.open();
  const select = f.nodes['native-companion-origin'];
  select.value = ethernetOrigin; await select.fire('change'); await f.generate();
  assert.equal(f.nodes['native-companion-pairing'].hidden, false);
  select.value = virtualOrigin; await select.fire('change');
  assert.equal(f.nodes['native-companion-pairing'].hidden, true);
  assert.equal(f.nodes['native-companion-pairing'].children.length, 0);
  assert.match(f.nodes['native-companion-pair-status'].textContent, /(?:valid|active).*?(?:used|expire)/i);
  assert.equal(f.nodes['native-companion-generate'].disabled, false);
  assert.equal(f.mutations().length, 1, 'address changes must not cancel or create server invitations');
});

test('closing or locking clears the chosen address and private invitation display', async () => {
  for (const end of [f => f.close(), f => f.event('tli-session-locked')]) {
    const f = fixture({ browserOrigin: 'https://localhost:8000' });
    f.handler((url, options) => url.endsWith('/setup') ? { data: { ...setup, origins: [virtualOrigin, ethernetOrigin] } } :
      options.method === 'POST' ? { data: pairingFor(f, ethernetOrigin) } : undefined);
    await f.open();
    const select = f.nodes['native-companion-origin'];
    select.value = ethernetOrigin; await select.fire('change'); await f.generate();
    end(f);
    assert.equal(select.value, '');
    assert.equal(f.nodes['native-companion-pairing'].hidden, true);
    assert.equal(f.nodes['native-companion-pairing'].children.length, 0);
    assert.equal(f.nodes['native-companion-generate'].disabled, true);
    assert.equal(f.mutations().length, 1);
  }
});

test('a forced address change during a pairing request cannot change its captured target', async () => {
  const f = fixture({ browserOrigin: 'https://localhost:8000' });
  let finish;
  f.handler((url, options) => url.endsWith('/setup') ? { data: { ...setup, origins: [virtualOrigin, ethernetOrigin] } } :
    options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : undefined);
  await f.open();
  const select = f.nodes['native-companion-origin'];
  select.value = ethernetOrigin; await select.fire('change');
  const sending = f.generate(true); await tick();
  assert.equal(select.disabled, true);
  select.value = virtualOrigin; await select.fire('change');
  assert.equal(select.value, ethernetOrigin, 'a forced event must restore the in-flight target');
  finish({ data: pairingFor(f, ethernetOrigin) }); await sending;
  assert.equal(f.mutations().length, 1);
  assert.deepEqual(JSON.parse(f.mutations()[0].options.body), { origin: ethernetOrigin });
  assert.equal(select.value, ethernetOrigin);
  assert.equal(JSON.parse(f.nodes['native-companion-bundle'].value).origin, ethernetOrigin);
});
