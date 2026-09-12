const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const nodes = {}, events = {}, calls = [];
  let handler = async () => ({ ok: true });
  function element(tag = 'div') {
    const classes = new Set();
    const el = { tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, handlers: {}, textContent: '', value: '', hidden: false, disabled: false, checked: false, _html: '',
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle(name, force) { const value = force ?? !classes.has(name); value ? classes.add(name) : classes.delete(name); return value; } },
      append(...items) { items.forEach(item => { item.parentNode = item.parentElement = this; this.children.push(item); }); }, appendChild(item) { this.append(item); return item; },
      replaceChildren(...items) { this.children = []; this._html = ''; this.textContent = ''; this.append(...items); },
      before(...items) { if (this.parentNode) this.parentNode.append(...items); }, after(...items) { if (this.parentNode) this.parentNode.append(...items); },
      setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; }, removeAttribute(key) { delete this.attrs[key]; },
      addEventListener(key, fn) { (this.handlers[key] ||= []).push(fn); }, fire(key) { return Promise.all((this.handlers[key] || []).map(fn => fn({ target: this, preventDefault() {} }))); }, click() { return this.disabled ? Promise.resolve() : this.fire('click'); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }, querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return all.filter(child => selector === '*' || selector.startsWith('.') ? selector === '*' || child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase()); },
      get options() { return this.children.flatMap(child => child.tagName === 'OPTGROUP' ? child.children : [child]).filter(child => child.tagName === 'OPTION'); },
      get selectedIndex() { return this.options.findIndex(option => option.value === this.value); },
      focus() {}, select() {}, remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
    };
    Object.defineProperty(el, 'id', { set(id) { nodes[id] = el; el._id = id; }, get() { return el._id; } });
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(html) {
      this._html = html; this.children = [];
      for (const match of html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
        const button = element('button'); button.textContent = match[2];
        button.className = match[1].match(/class="([^"]+)"/)?.[1] || '';
        this.append(button);
      }
    } });
    return el;
  }
  const window = { addEventListener: (type, fn) => (events[type] ||= []).push(fn), confirm: () => false, location: { origin: 'https://synthetic.invalid' } };
  const ctx = vm.createContext({ window, document: { readyState: 'complete', getElementById: id => nodes[id] || null, createElement: element, createTextNode: text => Object.assign(element('#text'), { textContent: text }), querySelectorAll: () => [], querySelector: () => null, addEventListener: (type, fn) => (events[type] ||= []).push(fn) },
    Date, Set, Map, AbortController, TextDecoder, TextEncoder, console: { warn() {}, error() {}, log() {} }, setInterval() { return 1; }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options = {}) => { calls.push({ url, options }); return handler(url, options); },
    $: id => nodes[id], currentDeviceId: 'synthetic-host', debugLog() {}, showToast() {}, confirm: () => true,
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  function add(id, tag, value = '') { const el = element(tag); el.id = id; el.value = value; return el; }
  const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  return { nodes, events, calls, ctx, window, element, add, json, handler(fn) { handler = fn; }, load(file, transform = s => s) { vm.runInContext(transform(read(file)), ctx); } };
}

const prefix = '/api/intelligence/performance';
const processRow = {pid:77,create_time:1200,name:'Synthetic editor',exe:'C:\\Fixture\\editor.exe'};
const observed = status => ({id:'observation-one',process:processRow,host:{id:'host',name:'Synthetic host'},status,started_at:new Date().toISOString(),expected_samples:30,sample_count:status === 'running' ? 0 : 1,samples:status === 'running' ? [] : [{elapsed_seconds:1,observed_at:new Date().toISOString(),host_cpu_percent:20,host_ram_percent:40,process_cpu_percent:10,process_rss_bytes:1048576}],summary:{host_cpu_percent:{mean:20,max:20,samples:1}}});
function performanceFixture() {
  const f=fixture();
  for(const id of ['performance-workspace','perf-setup','perf-observation','perf-status','perf-start','perf-stop','perf-save','perf-resolve','perf-new-request','perf-refresh','perf-refresh-observations','perf-saved-actions','perf-discuss','perf-link','perf-open-report','perf-host','perf-result','perf-history']) f.add(id);
  f.add('perf-processes','select');f.add('perf-search','input');
  f.nodes['perf-setup'].append(f.nodes['perf-search']);
  f.starters=['obs','chrome',''].map(value=>{const b=f.element('button');b.dataset.perfStarter=value;return b;});
  f.ctx.document.querySelectorAll=selector=>selector==='[data-perf-starter]'?f.starters:[];
  f.window.dispatchEvent=e=>(f.events[e.type]||[]).forEach(fn=>fn(e));f.ctx.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options?.detail;}};
  f.handler(async url=>f.json({ok:true,protocol:'tli-performance-v1',observations:[],...(url.includes('/processes')?{processes:[processRow]}:{})}));
  f.load('performance-workspace.js');
  return f;
}
async function choose(f) {await f.window.TLIPerformance.onOpen();await f.nodes['perf-refresh'].click(); f.nodes['perf-processes'].value='77:1200';await f.nodes['perf-processes'].fire('change');}
test('Performance navigation checks capabilities/history only; explicit picker does not sample',async()=>{
 const f=performanceFixture();await choose(f);
 assert.deepEqual(f.calls.map(c=>c.url),[prefix+'/capabilities',prefix+'/observations',prefix+'/processes?q=&limit=100']);assert.ok(f.calls.every(c=>(c.options.method||'GET')==='GET'));
 assert.equal(f.nodes['perf-start'].disabled,false);
});
test('Performance duplicate start sends one exact app identity and lock discards late results',async()=>{
 const f=performanceFixture();await choose(f);let finish;f.handler(()=>new Promise(r=>finish=r));
 const pending=f.nodes['perf-start'].click();await tick();await f.nodes['perf-start'].click();assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
 const body=JSON.parse(f.calls.at(-1).options.body);assert.equal(body.pid,77);assert.equal(body.create_time,1200);assert.ok(body.request_id);
 f.window.dispatchEvent(new f.ctx.CustomEvent('tli-session-locked'));finish(f.json({ok:true,protocol:'tli-performance-v1',observation:observed('running')}));await pending;
 assert.equal(f.nodes['perf-status'].textContent,'');assert.equal(f.nodes['perf-save'].hidden,true);assert.equal(f.nodes['perf-processes'].children.length,0);
});
test('Uncertain start offers GET original request with no automatic retry',async()=>{
 const f=performanceFixture();await choose(f);f.handler(async()=>{throw new TypeError('network');});await f.nodes['perf-start'].click();
 assert.equal(f.nodes['perf-resolve'].hidden,false);assert.equal(f.nodes['perf-start'].disabled,true);assert.match(f.nodes['perf-status'].textContent,/uncertain.*No request will be repeated/);
 f.handler(async()=>f.json({ok:true,protocol:'tli-performance-v1',observation:observed('stopped')}));await f.nodes['perf-resolve'].click();
 assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);assert.match(f.calls.at(-1).url,/by-request/);assert.equal(f.nodes['perf-save'].hidden,false);
});
test('Leaving an uncertain request requires a new explicit process review and never resubmits',async()=>{
 const f=performanceFixture();await choose(f);f.handler(async()=>{throw new TypeError('lost');});await f.nodes['perf-start'].click();
 const count=f.calls.length;await f.nodes['perf-new-request'].click();assert.equal(f.calls.length,count);assert.equal(f.nodes['perf-processes'].value,'');assert.equal(f.nodes['perf-start'].disabled,true);assert.match(f.nodes['perf-status'].textContent,/original outcome is still unknown/);
});
test('Stop awaits server result; explicit Save is idempotent and failed refresh preserves report',async()=>{
 const f=performanceFixture();await choose(f);f.handler(async()=>f.json({ok:true,protocol:'tli-performance-v1',observation:observed('running')}));await f.nodes['perf-start'].click();
 f.handler(async()=>f.json({ok:true,protocol:'tli-performance-v1',observation:observed('stopped')}));await f.nodes['perf-stop'].click();assert.match(f.nodes['perf-status'].textContent,/stopped.*Partial/);
 let first;f.handler(async(url,opts)=>{first=JSON.parse(opts.body).request_id;throw new TypeError('lost');});await f.nodes['perf-save'].click();
 f.handler(async(url,opts)=>{assert.equal(JSON.parse(opts.body).request_id,first);return f.json({ok:true,protocol:'tli-performance-v1',report:{id:'saved'}});});await f.nodes['perf-save'].click();await f.nodes['perf-save'].click();assert.equal(f.calls.filter(c=>c.url.endsWith('/save')).length,2);
 const previous=f.nodes['perf-result'].children[0];f.handler(async()=>f.json({detail:'Unavailable'},503));await f.nodes['perf-refresh-observations'].click();assert.equal(f.nodes['perf-result'].children[0],previous);assert.equal(f.nodes['perf-saved-actions'].hidden,false);
});
test('Background clears performance private results without a Stop request',async()=>{
 const f=performanceFixture();await choose(f);f.handler(async()=>f.json({ok:true,protocol:'tli-performance-v1',observation:observed('running')}));await f.nodes['perf-start'].click();
 f.ctx.document.hidden=true;(f.events.visibilitychange||[]).forEach(fn=>fn());assert.equal(f.calls.filter(c=>c.url.endsWith('/stop')).length,0);assert.equal(f.nodes['perf-processes'].children.length,0);
});
test('A stale 401 from a closed Performance view cannot lock a new session',async()=>{
 const f=performanceFixture();await choose(f);let finish;f.handler(()=>new Promise(r=>finish=r));const pending=f.nodes['perf-refresh'].click();await tick();
 f.window.dispatchEvent(new f.ctx.CustomEvent('tli-session-locked'));f.window.dispatchEvent(new f.ctx.CustomEvent('tli-session-unlocked'));
 let locks=0;f.events['tli-session-locked'].push(()=>locks++);finish(f.json({detail:'Old session'},401));await pending;assert.equal(locks,0);
});

test('each explicit starter replaces the previous starter and reads processes once without selecting or sampling',async()=>{
 const f=performanceFixture();await f.window.TLIPerformance.onOpen();
 for(const [i,q]of [[0,'obs'],[1,'chrome'],[2,'']]){const count=f.calls.length;await f.starters[i].click();assert.equal(f.nodes['perf-search'].value,q);assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1).url,prefix+'/processes?q='+q+'&limit=100');assert.equal(f.nodes['perf-start'].disabled,true);}
 assert.ok(f.calls.every(c=>(c.options.method||'GET')==='GET'));
});

test('a custom app search requires an explicit replacement choice and cannot be overwritten by stale starter review',async()=>{
 const f=performanceFixture();await f.window.TLIPerformance.onOpen();f.nodes['perf-search'].value='My custom app';await f.nodes['perf-search'].fire('input');
 const count=f.calls.length;await f.starters[0].click();assert.equal(f.calls.length,count);assert.equal(f.nodes['perf-search'].value,'My custom app');assert.equal(f.nodes['perf-starter-review'].hidden,false);
 const use=f.nodes['perf-starter-review'].querySelectorAll('button').find(b=>b.textContent==='Use starter & read processes');
 f.nodes['perf-search'].value='A newer draft';await f.nodes['perf-search'].fire('input');await use.click();assert.equal(f.calls.length,count);assert.equal(f.nodes['perf-search'].value,'A newer draft');
 await f.starters[1].click();await use.click();assert.equal(f.calls.length,count+1);assert.equal(f.nodes['perf-search'].value,'chrome');assert.equal(f.nodes['perf-start'].disabled,true);
});

test('setup stays full-width without results and compacts only for an actual retained observation',async()=>{
 const f=performanceFixture();await choose(f);assert.equal(f.nodes['perf-observation'].hidden,true);assert.equal(f.nodes['performance-workspace'].classList.contains('perf-has-result'),false);
 f.handler(async()=>f.json({ok:true,protocol:'tli-performance-v1',observation:observed('running')}));await f.nodes['perf-start'].click();
 assert.equal(f.nodes['perf-observation'].hidden,false);assert.equal(f.nodes['performance-workspace'].classList.contains('perf-has-result'),true);assert.equal(f.nodes['performance-workspace'].classList.contains('perf-setup-expanded'),false);
 const count=f.calls.length;await f.starters[0].click();assert.equal(f.calls.length,count);assert.equal(f.nodes['perf-change-app'].disabled,true);
});
test('Games opening and choosing a preset preserve question and never call inference',async()=>{
 const f=fixture();const parent=f.element();for(const id of ['go-output','go-ask-btn','go-game-input','go-question'])parent.append(f.add(id));f.nodes['go-question'].value='My existing question';
 const preset=f.element('button');preset.dataset.preset='stable_60';f.ctx.document.querySelectorAll=selector=>selector.includes('go-preset')?[preset]:[];f.load('tli-games.js');f.window.TLIGames.setup();await f.window.TLIGames.onOpen();await preset.click();assert.equal(f.calls.length,0);assert.equal(f.nodes['go-question'].value,'My existing question');
});
test('Late game configuration cannot attach to a newly typed game',async()=>{
 const f=fixture();const parent=f.element();for(const id of ['go-output','go-ask-btn','go-game-input','go-question','go-read-config-btn','go-detect-status','go-config-badge','go-settings-grid','go-settings-block'])parent.append(f.add(id));
 f.load('tli-games.js');f.window.TLIGames.setup();let finish;f.handler(()=>new Promise(r=>finish=r));f.nodes['go-game-input'].value='Cyberpunk 2077';const pending=f.nodes['go-read-config-btn'].click();await tick();f.nodes['go-game-input'].value='Red Dead Redemption 2';await f.nodes['go-game-input'].fire('input');finish(f.json({supported:true,game_name:'Cyberpunk 2077',settings:[{label:'Resolution',value:'4K'}]}));await pending;assert.equal(f.nodes['go-settings-grid'].innerHTML,'');
});

