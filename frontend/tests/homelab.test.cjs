const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname,'../js/homelab.js'),'utf8');
const {inventory,filter,bytes} = require('../js/homelab.js');
const overview = () => ({checked_at:'2026-10-16T12:00:00Z', sources:{
  computers:{state:'available',items:[{id:'host-1',name:'Lab host',kind:'host',availability:'unknown'},{id:'peer-1',name:'GPU worker',kind:'inference_node',availability:'unknown'}]},
  devices:{state:'available',items:[{id:'lamp-1',name:'Rack light',kind:'Shelly',room:'Office'}]},
  ai:{state:'not_checked',selection:null,detail:'Readiness not checked.'}
}});
const proxmox = () => ({protocol:'tli-homelab-proxmox-v1',ok:true,actions_performed:false,tls_verification:'certificate_pin',origin:'https://192.168.1.20:8006',checked_at:'2026-10-16T12:01:00Z',resources:[
  {id:'node/lab',type:'node',name:'Lab node',node:'lab',status:'online',cpu:0,mem:0,maxmem:1024},
  {id:'qemu/100',type:'qemu',name:'NAS VM',node:'lab',status:'running'},
  {id:'lxc/101',type:'lxc',name:'Apps',node:'lab',status:'stopped'},
  {id:'storage/lab/local',type:'storage',name:'local',node:'lab',status:'available',disk:2048,maxdisk:4096}
]});
function fixture() {
  const events = {}, documentEvents = {}, calls = [], opened = [], timers = new Map(); let timerId = 0;
  function make(tag) {
    const el = {tagName:tag.toUpperCase(),children:[],parentNode:null,textContent:'',value:'',id:'',hidden:false,disabled:false,attributes:{},handlers:{},
      append(...items) { for (const child of items) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(value => value !== child); child.parentNode = this; this.children.push(child); } },
      replaceChildren(...items) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...items); },
      setAttribute(name,value) { this.attributes[name] = value; },
      addEventListener(name,fn) { (this.handlers[name] ||= []).push(fn); },
      async fire(name = 'click') { await Promise.all((this.handlers[name] || []).map(fn => fn({preventDefault(){}}))); }
    };
    Object.defineProperty(el,'innerHTML',{set(){assert.fail('Untrusted inventory must never render through innerHTML');}});
    return el;
  }
  const body = make('body'), mount = make('div'); mount.id = 'homelab-mount'; body.append(mount);
  function find(id,el = body) { return el.id === id ? el : el.children.map(child => find(id,child)).find(Boolean); }
  const document = {readyState:'complete',createElement:make,getElementById:find,addEventListener:(name,fn) => (documentEvents[name] ||= []).push(fn)};
  const window = {document,addEventListener:(name,fn) => (events[name] ||= []).push(fn),
    dispatchEvent:event => { for (const fn of events[event.type] || []) fn(event); },
    switchPanel:id => opened.push(id),TLIUI:{icon:() => make('span'),openNotes:() => opened.push('notes')},openModelManager:() => opened.push('model-manager')};
  const f = {calls,opened,window,document,find,timers,handler:async url => url.endsWith('/overview') ? overview() : proxmox()};
  const context = vm.createContext({window,document,console,Date,AbortController,TextDecoder,TextEncoder,
    CustomEvent:class {constructor(type,props) {this.type = type; this.detail = props?.detail;}},
    setTimeout(fn,delay){const id = ++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id => timers.delete(id),
    localStorage:{getItem(){assert.fail('No browser inventory or credential storage');},setItem(){assert.fail('No browser inventory or credential storage');}},
    fetch:async (url,options) => { calls.push({url,options,body:options.body ? JSON.parse(options.body) : null}); const result = await f.handler(url,options); return {ok:!result._status || result._status < 400,status:result._status || 200,body:null,text:result._text || (async () => JSON.stringify(result))}; }
  });
  vm.runInContext(code,context);
  f.emit = async (name,detail) => { await Promise.all([...(events[name] || []),...(documentEvents[name] || [])].map(fn => fn({detail}))); };
  f.text = id => { const collect = el => [el.textContent,...el.children.flatMap(collect)]; return collect(find(id)).join(' '); };
  f.click = async id => { const el = find(id); if (!el.disabled) await el.fire(); };
  f.credentials = () => { find('lab-proxmox-origin').value = 'https://192.168.1.20:8006';find('lab-proxmox-token').value = 'reader@pve!tli';find('lab-proxmox-secret').value = 'sensitive-token';find('lab-proxmox-pin').value = 'a'.repeat(64); };
  f.submit = async () => { if (!find('lab-inspect').disabled) await find('lab-inspect').parentNode.fire('submit'); };
  return f;
}
test('navigation mounts accessible controls without a request and requires an overview before Proxmox',async () => {
  const f = fixture();await f.emit('tli-panel-switched',{panelId:'panel-homelab'});
  assert.equal(f.calls.length,0);assert.equal(f.find('lab-inspect').disabled,true);
  assert.equal(f.find('lab-proxmox-origin').required,true);assert.equal(f.find('lab-proxmox-secret').type,'password');
  await f.window.TLIHomeLab.inspect();assert.equal(f.calls.length,0);
  assert.match(f.text('lab-inventory'),/Refresh overview/);
});
test('overview keeps inventory counts separate from health and leaves neutral AI unchecked',async () => {
  const f = fixture();await f.click('lab-refresh');
  assert.deepEqual(f.calls.map(call => call.url),['/api/homelab/overview']);assert.equal(f.find('lab-inspect').disabled,false);
  assert.match(f.text('lab-metrics'),/Computers 2/);assert.match(f.text('lab-metrics'),/Smart devices 1/);
  assert.match(f.text('lab-metrics'),/Choose AI/);assert.equal(f.text('lab-source-notices'),'');
  assert.match(f.text('lab-inventory'),/Availability unknown/);assert.doesNotMatch(f.text('lab-inventory'),/healthy|online/);
  assert.match(f.text('lab-receipt'),/Live availability is unknown/);assert.equal(f.find('lab-workspace').attributes['aria-busy'],'false');
});
test('partial unavailable source stays unavailable and cannot become a zero-device success',async () => {
  const f = fixture();f.handler = async () => {const value = overview();value.sources.devices = {state:'unavailable',detail:'Registry could not be read.'};return value;};
  await f.click('lab-refresh');assert.match(f.text('lab-metrics'),/Smart devices —/);assert.match(f.text('lab-source-notices'),/Registry could not be read/);
  assert.match(f.text('lab-inventory'),/Lab host/);assert.match(f.text('lab-status'),/unavailable sources/);
});
test('local category and search filters never fetch and display untrusted names as text',async () => {
  const f = fixture();f.handler = async () => {const value = overview();value.sources.devices.items[0].name = '<img src=x onerror=alert(1)>';return value;};
  await f.click('lab-refresh');f.find('lab-kind').value = 'devices';await f.find('lab-kind').fire('change');
  assert.doesNotMatch(f.text('lab-inventory'),/Lab host/);assert.match(f.text('lab-inventory'),/<img src=x/);
  f.find('lab-search').value = 'Office';await f.find('lab-search').fire('input');assert.match(f.text('lab-list-count'),/1 matching/);
  f.find('lab-search').value = 'absent';await f.find('lab-search').fire('input');assert.match(f.text('lab-inventory'),/No records match/);assert.equal(f.calls.length,1);
});
test('Proxmox submits exact explicit credentials once, clears fields immediately and filters locally',async () => {
  const f = fixture();await f.click('lab-refresh');f.credentials();let finish;
  f.handler = () => new Promise(resolve => finish = resolve);const pending = f.submit();
  assert.equal(f.find('lab-proxmox-secret').value,'');assert.equal(f.find('lab-proxmox-token').value,'');await f.submit();
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].body,{origin:'https://192.168.1.20:8006',token_id:'reader@pve!tli',token_secret:'sensitive-token',certificate_sha256:'a'.repeat(64)});
  finish(proxmox());await pending;
  assert.match(f.text('lab-proxmox-results'),/CPU 0%/);assert.match(f.text('lab-proxmox-results'),/Memory 0 B \/ 1.0 KiB/);
  assert.match(f.text('lab-proxmox-receipt'),/fingerprint matched/);
  f.find('lab-proxmox-kind').value = 'qemu';await f.find('lab-proxmox-kind').fire('change');
  assert.match(f.text('lab-proxmox-results'),/NAS VM/);assert.doesNotMatch(f.text('lab-proxmox-results'),/Lab node|Apps/);assert.equal(f.calls.length,2);
});
test('failed explicit reads preserve dated results, clear submitted secrets and do not retry',async () => {
  const f = fixture();await f.click('lab-refresh');f.credentials();await f.submit();const result = f.text('lab-proxmox-results');
  f.handler = async () => ({_status:502,detail:'Proxmox read unavailable.'});f.credentials();await f.submit();
  assert.equal(f.text('lab-proxmox-results'),result);assert.equal(f.find('lab-proxmox-secret').value,'');assert.match(f.text('lab-status'),/Earlier results remain dated/);
  await f.emit('tli-panel-switched',{panelId:'panel-homelab'});assert.equal(f.calls.length,3);
});
for (const boundary of ['tli-session-locked','tli-user-changed','tli-account-changed','pagehide']) test(`${boundary} clears private results and discards a late response`,async () => {
  const f = fixture();await f.click('lab-refresh');f.credentials();await f.submit();f.credentials();let finish;
  f.handler = () => new Promise(resolve => finish = resolve);const pending = f.click('lab-refresh');
  await f.emit(boundary);finish(overview());await pending;
  assert.doesNotMatch(f.text('lab-inventory'),/Lab host|GPU worker/);assert.equal(f.text('lab-proxmox-results'),'');assert.equal(f.find('lab-proxmox-origin').value,'');assert.equal(f.find('lab-proxmox-secret').value,'');
  assert.equal(f.find('lab-inspect').disabled,true);assert.equal(f.calls.length,3);
});
test('old response body cannot cross lock/unlock and recovery requires an explicit successful read',async () => {
  const f = fixture();let finish,bodyStarted;
  const started = new Promise(resolve => bodyStarted = resolve);
  f.handler = async () => ({_text:() => {bodyStarted();return new Promise(resolve => finish = resolve);}});
  const pending = f.click('lab-refresh');await started;await f.emit('tli-session-locked');await f.emit('tli-session-unlocked');
  finish(JSON.stringify(overview()));await pending;
  assert.equal(f.calls.length,1);assert.doesNotMatch(f.text('lab-inventory'),/Lab host/);assert.equal(f.find('lab-inspect').disabled,true);
  f.handler = async () => overview();await f.click('lab-refresh');assert.equal(f.find('lab-inspect').disabled,false);assert.match(f.text('lab-inventory'),/Lab host/);
});
for (const status of [401,403]) test(`current ${status} clears the entire HomeLab view instead of exposing its error body`,async () => {
  const f = fixture();await f.click('lab-refresh');f.handler = async () => ({_status:status,detail:'private internal response'});await f.click('lab-refresh');
  assert.equal(f.find('lab-refresh').disabled,true);assert.equal(f.find('lab-unlock').hidden,false);assert.doesNotMatch(f.text('lab-workspace'),/private internal response|Lab host/);
});
test('leaving the panel drops a pending read and clears unsent credentials without a retry',async () => {
  const f = fixture();await f.click('lab-refresh');f.credentials();let finish;f.handler = () => new Promise(resolve => finish = resolve);const pending = f.submit();
  await f.emit('tli-panel-switched',{panelId:'panel-main'});finish(proxmox());await pending;
  await f.emit('tli-panel-switched',{panelId:'panel-homelab'});assert.equal(f.calls.length,2);assert.equal(f.text('lab-proxmox-results'),'');assert.equal(f.find('lab-proxmox-secret').value,'');
});
test('unsupported Proxmox receipt never claims a verified connection',async () => {
  const f = fixture();await f.click('lab-refresh');f.credentials();f.handler = async () => ({...proxmox(),tls_verification:'insecure'});await f.submit();
  assert.equal(f.text('lab-proxmox-results'),'');assert.match(f.text('lab-status'),/not confirmed/);
});
test('unknown numeric readings stay unknown and the inventory projection is non-mutating',() => {
  for (const value of [undefined,null,'0',NaN,Infinity,-1]) assert.equal(bytes(value),null);
  assert.equal(bytes(0),'0 B');const value = overview(),before = JSON.stringify(value),projected = inventory(value);
  assert.equal(projected.ai.state,'not_checked');assert.equal(filter(projected.rows,'inference','computers').length,1);assert.equal(JSON.stringify(value),before);
});
