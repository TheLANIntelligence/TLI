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
  const window = { addEventListener: (type, fn) => (events[type] ||= []).push(fn), dispatchEvent: event => { (events[event.type] || []).forEach(fn => fn(event)); return true; }, confirm: () => false, location: { origin: 'https://synthetic.invalid' } };
  const ctx = vm.createContext({ window, document: { readyState: 'complete', getElementById: id => nodes[id] || null, createElement: element, createTextNode: text => Object.assign(element('#text'), { textContent: text }), querySelectorAll: () => [], querySelector: () => null, addEventListener: (type, fn) => (events[type] ||= []).push(fn) },
    Date, Set, Map, AbortController, TextDecoder, TextEncoder, CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }, console: { warn() {}, error() {}, log() {} }, setInterval() { return 1; }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options = {}) => { calls.push({ url, options }); return handler(url, options); },
    $: id => nodes[id], currentDeviceId: 'synthetic-host', debugLog() {}, showToast() {}, confirm: () => true,
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  function add(id, tag, value = '') { const el = element(tag); el.id = id; el.value = value; return el; }
  const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  return { nodes, events, calls, ctx, window, element, add, json, handler(fn) { handler = fn; }, load(file, transform = s => s) { vm.runInContext(transform(read(file)), ctx); } };
}


function gamesFixture() {
  const f=fixture(), root=f.element('section');
  for(const id of ['go-game-input','go-question','go-output-title','go-output-source','go-output','go-output-wrap','go-ask-btn','go-copy-btn','go-clear-btn','go-analyze-btn','go-read-config-btn','go-read-hardware-btn','go-hw-pills','go-hardware-status','go-detect-btn','go-detect-status','go-config-badge','go-config-note','go-settings-grid','go-settings-block','go-resolution','go-target-fps','go-cpu','go-gpu','go-ram','go-manual-settings','go-provider','go-check-provider','go-provider-status','go-context-receipt','go-include-history','go-empty-advice']) root.append(f.add(id));
  f.nodes['go-game-input'].value='Cyberpunk 2077';f.nodes['go-provider'].value='bundled';f.nodes['go-target-fps'].value='60';f.nodes['go-include-history'].checked=true;
  f.load('tli-games.js'); f.window.TLIGames.setup();return f;
}
const bound={provider:'bundled',provider_key:'a'.repeat(64),model:'fixture-integrated',label:'Integrated AI'};
function stream(text='A complete settings plan') { let used=false;return {ok:true,body:{getReader:()=>({async read(){if(used)return {done:true};used=true;return {done:false,value:new TextEncoder().encode('data: '+JSON.stringify({t:text})+'\n\ndata: [DONE]\n\n')};},async cancel(){}})}}; }
function normal(f, text) {f.handler(async(url)=>url.startsWith('/games/advice_provider')?f.json(bound):stream(text));}
const visible = node => [node.textContent, node.innerHTML, ...node.children.map(visible)].join(' ');
const specs = { cpu: { model: 'Synthetic Ryzen 7', cores: 8, threads: 16 }, gpu: { model: 'Synthetic RTX 4070', vram_gb: 12 }, memory: { total_gb: 32 }, display: { width: 2560, height: 1440, hz: 144 } };
const emit = (f, type) => f.window.dispatchEvent({ type });

test('Opening Game Optimizer reads this PC automatically with no game, settings read, inference or performance request',async()=>{
 const f=gamesFixture();f.nodes['go-game-input'].value='';let performanceOpened=0;f.window.TLIPerformance={onOpen:()=>performanceOpened++};
 f.handler(async url=>{assert.equal(url,'/system/summary');return f.json(specs);});
 await f.window.TLIGames.onOpen();
 assert.deepEqual(f.calls.map(call=>call.url),['/system/summary']);assert.equal(performanceOpened,0);
 const hardware=visible(f.nodes['go-hw-pills']);
 for(const expected of [/Processor|CPU/i,/Graphics card|GPU/i,/VRAM/i,/RAM/i,/Display/i,/Synthetic Ryzen 7/,/Synthetic RTX 4070/,/12\s*GB/,/32\s*GB/,/2560\s*[×x]\s*1440/,/144\s*Hz/i]) assert.match(hardware,expected);
 assert.doesNotMatch(f.nodes['go-hardware-status'].textContent,/failed|unable/i);
});

test('A successful incomplete hardware read names each missing specification instead of hiding it',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json({cpu:{model:'Known CPU'}}));await f.window.TLIGames.onOpen();
 const hardware=visible(f.nodes['go-hw-pills']);assert.match(hardware,/Known CPU/);
 for(const label of ['Graphics card','Graphics memory','Memory','Display','Refresh rate']) assert.match(hardware,new RegExp(label,'i'));
 assert.equal((hardware.match(/Not reported/g)||[]).length,5);
});

test('An impossible legacy refresh rate is neither displayed nor sent for advice',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json({...specs,display:{width:3840,height:2160,hz:384021603260}}));await f.window.TLIGames.onOpen();
 const hardware=visible(f.nodes['go-hw-pills']);assert.match(hardware,/3840\s*[×x]\s*2160/);assert.match(hardware,/Refresh rate<\/dt><dd>Not reported/);assert.doesNotMatch(hardware,/384021603260/);
 normal(f);await f.nodes['go-ask-btn'].click();const body=JSON.parse(f.calls.find(call=>call.url==='/games/ask').options.body);
 assert.deepEqual(body.system.display,{width:3840,height:2160});
});

test('An initially locked open workspace shows no hardware failure and reads once after verified readiness',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json(specs));emit(f,'tli-session-locked');await f.window.TLIGames.onOpen();
 assert.equal(f.calls.length,0);assert.doesNotMatch(visible(f.nodes['go-hw-pills'])+' '+f.nodes['go-hardware-status'].textContent,/failed|unable|unavailable/i);
 emit(f,'tli-session-unlocked');await tick();assert.equal(f.calls.length,0);emit(f,'tli-private-observation-ready');await tick();
 assert.deepEqual(f.calls.map(call=>call.url),['/system/summary']);assert.match(visible(f.nodes['go-hw-pills']),/Synthetic Ryzen 7/);
});

test('Unlocking while Game Optimizer is closed does not read private hardware in the background',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json(specs));emit(f,'tli-session-locked');await f.window.TLIGames.onOpen();f.window.TLIGames.onClose();
 emit(f,'tli-session-unlocked');await tick();assert.equal(f.calls.length,0);
 emit(f,'tli-private-observation-ready');await tick();assert.equal(f.calls.length,0);
 await f.window.TLIGames.onOpen();assert.deepEqual(f.calls.map(call=>call.url),['/system/summary']);
});

test('Pending automatic hardware read is shared by Analyze and repeated hardware refresh',async()=>{
 const f=gamesFixture();let finish;
 f.handler(async url=>url==='/system/summary'?new Promise(resolve=>finish=resolve):f.json(url==='/games/config_read'?{game_name:'Cyberpunk 2077',supported:false,settings:[]}:bound));
 const opened=f.window.TLIGames.onOpen();await tick();
 const refresh=f.nodes['go-read-hardware-btn'].fire('click');
 const analyze=f.nodes['go-analyze-btn'].click();await tick();
 assert.equal(f.calls.filter(call=>call.url==='/system/summary').length,1);
 finish(f.json(specs));await Promise.all([opened,refresh,analyze]);
 assert.equal(f.calls.filter(call=>call.url==='/system/summary').length,1);assert.equal(f.calls.filter(call=>call.url==='/games/config_read').length,1);
 assert.match(visible(f.nodes['go-hw-pills']),/Synthetic RTX 4070/);assert.equal(f.nodes['go-ask-btn'].disabled,false);
});

test('Leaving during hardware loading aborts the request and ignores its late response after reopening',async()=>{
 const f=gamesFixture();let finish;let reads=0;
 f.handler(async()=>++reads===1?new Promise(resolve=>finish=resolve):f.json({...specs,cpu:{model:'New visit CPU'}}));
 const original=f.window.TLIGames.onOpen();await tick();f.window.TLIGames.onClose();
 assert.equal(f.calls[0].options.signal.aborted,true);
 await f.window.TLIGames.onOpen();finish(f.json({...specs,cpu:{model:'Late old CPU'}}));await original;
 assert.equal(reads,2);assert.match(visible(f.nodes['go-hw-pills']),/New visit CPU/);assert.doesNotMatch(visible(f.nodes['go-hw-pills']),/Late old CPU/);
});

test('Session lock clears hardware and rejects late responses while verified readiness starts a fresh read',async()=>{
 const f=gamesFixture();let finish;let reads=0;
 f.handler(async()=>++reads===1?new Promise(resolve=>finish=resolve):f.json({...specs,cpu:{model:'Unlocked CPU'}}));
 const original=f.window.TLIGames.onOpen();await tick();emit(f,'tli-session-locked');
 assert.equal(f.calls[0].options.signal.aborted,true);assert.doesNotMatch(visible(f.nodes['go-hw-pills']),/Synthetic|failed|unable/i);
 emit(f,'tli-session-unlocked');await tick();assert.equal(reads,1);emit(f,'tli-private-observation-ready');await tick();finish(f.json({...specs,cpu:{model:'Private previous CPU'}}));await original;
 assert.equal(reads,2);assert.match(visible(f.nodes['go-hw-pills']),/Unlocked CPU/);assert.doesNotMatch(visible(f.nodes['go-hw-pills']),/Private previous CPU/);
});

test('A current unauthorized hardware read locks without claiming hardware detection failed',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json({detail:'Locked'},401));await f.window.TLIGames.onOpen();
 assert.match(f.nodes['go-hardware-status'].textContent,/unlock/i);assert.doesNotMatch(f.nodes['go-hardware-status'].textContent,/failed|could not read/i);
 assert.equal(f.calls[0].options.signal.aborted,true);
 f.handler(async()=>f.json(specs));emit(f,'tli-session-unlocked');await tick();
 assert.equal(f.calls.length,1);emit(f,'tli-private-observation-ready');await tick();
 assert.equal(f.calls.length,2);assert.match(visible(f.nodes['go-hw-pills']),/Synthetic Ryzen 7/);
});

test('Game hardware403 clears private specs and stays paused until verified readiness without advice/config replay',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json(specs));await f.window.TLIGames.onOpen();
 f.handler(async()=>f.json({detail:'Private access denied'},403));await f.nodes['go-read-hardware-btn'].click();
 assert.doesNotMatch(visible(f.nodes['go-hw-pills']),/Synthetic/);assert.match(f.nodes['go-hardware-status'].textContent,/unlock/i);
 emit(f,'tli-session-unlocked');await tick();await f.window.TLIGames.onOpen();assert.equal(f.calls.length,2);
 let retries=0;f.window.EventInterpreter={retry:()=>{retries++;}};await f.nodes['go-read-hardware-btn'].click();assert.equal(retries,1);assert.equal(f.calls.length,2);
 f.handler(async()=>f.json(specs));emit(f,'tli-private-observation-ready');emit(f,'tli-private-observation-ready');await tick();
 assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.url==='/system/summary'));assert.match(visible(f.nodes['go-hw-pills']),/Synthetic/);
});

test('Game hardware recovery while hidden waits until visible and reads only specs',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json(specs));emit(f,'tli-session-locked');await f.window.TLIGames.onOpen();
 f.ctx.document.hidden=true;emit(f,'tli-session-unlocked');emit(f,'tli-private-observation-ready');await tick();assert.equal(f.calls.length,0);
 f.ctx.document.hidden=false;emit(f,'visibilitychange');await tick();assert.deepEqual(f.calls.map(call=>call.url),['/system/summary']);
});

test('late Game hardware403 cannot clear a renewed hardware result',async()=>{
 const f=gamesFixture();let finish;f.handler(async()=>new Promise(resolve=>finish=resolve));const old=f.window.TLIGames.onOpen();await tick();
 emit(f,'tli-session-locked');emit(f,'tli-session-unlocked');f.handler(async()=>f.json(specs));emit(f,'tli-private-observation-ready');await tick();
 finish(f.json({detail:'Old denied session'},403));await old;assert.match(visible(f.nodes['go-hw-pills']),/Synthetic/);assert.equal(f.nodes['go-read-hardware-btn'].disabled,false);
});

test('late Game hardware body cannot replace specs from renewed access',async()=>{
 const f=gamesFixture();let finish;f.handler(async()=>({ok:true,status:200,json:()=>new Promise(resolve=>finish=resolve)}));const old=f.window.TLIGames.onOpen();await tick();
 emit(f,'tli-session-locked');emit(f,'tli-session-unlocked');f.handler(async()=>f.json(specs));emit(f,'tli-private-observation-ready');await tick();
 finish({...specs,cpu:{model:'Old private CPU'}});await old;assert.match(visible(f.nodes['go-hw-pills']),/Synthetic/);assert.doesNotMatch(visible(f.nodes['go-hw-pills']),/Old private/);
});

test('A late unauthorized response from abandoned hardware detection cannot lock a newly opened workspace',async()=>{
 const f=gamesFixture();let finish;let reads=0;
 f.handler(async()=>++reads===1?new Promise(resolve=>finish=resolve):f.json(specs));
 const original=f.window.TLIGames.onOpen();await tick();f.window.TLIGames.onClose();await f.window.TLIGames.onOpen();
 finish(f.json({detail:'Old expired session'},401));await original;
 assert.match(visible(f.nodes['go-hw-pills']),/Synthetic Ryzen 7/);assert.doesNotMatch(f.nodes['go-hardware-status'].textContent,/unlock/i);
 assert.equal(f.nodes['go-read-hardware-btn'].disabled,false);
});

test('Failed refresh keeps previous specifications visibly historical but excludes them from new advice',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json(specs));await f.window.TLIGames.onOpen();
 f.handler(async()=>{throw new Error('Synthetic unavailable host');});await f.nodes['go-read-hardware-btn'].click();
 assert.match(visible(f.nodes['go-hw-pills']),/Synthetic Ryzen 7/);assert.match(f.nodes['go-hardware-status'].textContent,/previous|historical|stale/i);
 f.nodes['go-cpu'].value='Corrected CPU';normal(f);await f.nodes['go-ask-btn'].click();
 const body=JSON.parse(f.calls.find(call=>call.url==='/games/ask').options.body);
 assert.deepEqual(body.system,{cpu:{},gpu:{},memory:{},display:{}});assert.equal(body.corrections.cpu,'Corrected CPU');
});

test('Automatic hardware read and refresh preserve all manually corrected fields',async()=>{
 const f=gamesFixture();const corrections={'go-cpu':'My CPU','go-gpu':'My GPU','go-ram':'48','go-resolution':'1920 x 1080','go-manual-settings':'Shadows Medium'};
 for(const [id,value]of Object.entries(corrections))f.nodes[id].value=value;
 f.handler(async()=>f.json(specs));await f.window.TLIGames.onOpen();await f.nodes['go-read-hardware-btn'].click();
 for(const [id,value]of Object.entries(corrections))assert.equal(f.nodes[id].value,value,id);
});

test('Analyze reads hardware and supported settings without AI selection or inference and preserves corrections',async()=>{
 const f=gamesFixture();f.nodes['go-gpu'].value='My corrected GPU';f.nodes['go-resolution'].value='1920 x 1080';
 f.handler(async url=>f.json(url==='/system/summary'?{cpu:{model:'Read CPU'},gpu:{model:'Read GPU'},display:{width:2560,height:1440}}:url==='/games/config_read'?{game_name:'Cyberpunk 2077',supported:true,settings:[{label:'Shadows',value:'High'}]}:bound));
 await f.nodes['go-analyze-btn'].click();assert.deepEqual(f.calls.map(c=>c.url).sort(),['/games/config_read','/system/summary'].sort());
 assert.equal(f.nodes['go-gpu'].value,'My corrected GPU');assert.equal(f.nodes['go-resolution'].value,'1920 x 1080');assert.match(f.nodes['go-config-badge'].textContent,/1 settings read/);
 assert.equal(f.nodes['go-ask-btn'].disabled,false);
});

test('Advice carries selected provider, corrected context and exact game config; same game follow-up includes completed answer',async()=>{
 const f=gamesFixture();f.nodes['go-question'].value='Stutters in the city';f.nodes['go-gpu'].value='Corrected GPU';f.nodes['go-manual-settings'].value='Shadows now Medium';f.nodes['go-target-fps'].value='90';normal(f,'First complete answer');
 await f.nodes['go-ask-btn'].click();const first=JSON.parse(f.calls.find(c=>c.url==='/games/ask').options.body);
 assert.equal(first.provider_key,bound.provider_key);assert.equal(first.corrections.gpu,'Corrected GPU');assert.equal(first.corrections.target_fps,90);assert.equal(first.history.length,0);
 f.nodes['go-question'].value='Still stuttering after trying medium';await f.nodes['go-ask-btn'].click();const second=JSON.parse(f.calls.filter(c=>c.url==='/games/ask')[1].options.body);
 assert.equal(second.history[0].text,'First complete answer');assert.equal(second.history[0].game_name,'Cyberpunk 2077');assert.match(f.nodes['go-context-receipt'].textContent,/Last completed advice included/);
 f.nodes['go-game-input'].value='A different game';await f.nodes['go-game-input'].fire('input');await f.nodes['go-ask-btn'].click();const third=JSON.parse(f.calls.filter(c=>c.url==='/games/ask')[2].options.body);assert.equal(third.history.length,0);
});

test('History choice excludes earlier answer and unsupported games state unknown settings',async()=>{
 const f=gamesFixture();f.handler(async url=>f.json(url==='/system/summary'?{}:url==='/games/config_read'?{game_name:'Cyberpunk 2077',supported:false,error:'No reader',settings:[]}:bound));await f.nodes['go-analyze-btn'].click();assert.match(f.nodes['go-config-note'].textContent,/unknown/);
 normal(f);await f.nodes['go-ask-btn'].click();f.nodes['go-include-history'].checked=false;await f.nodes['go-ask-btn'].click();const body=JSON.parse(f.calls.filter(c=>c.url==='/games/ask')[1].options.body);assert.equal(body.history.length,0);assert.equal(body.current_settings.length,0);
});

test('Changing games clears manually supplied old game settings but keeps hardware corrections',async()=>{
 const f=gamesFixture();await f.nodes['go-game-input'].fire('input');f.nodes['go-manual-settings'].value='Old game Ultra';f.nodes['go-resolution'].value='4K';f.nodes['go-cpu'].value='Host CPU';
 f.nodes['go-game-input'].value='Another Game';await f.nodes['go-game-input'].fire('input');assert.equal(f.nodes['go-manual-settings'].value,'');assert.equal(f.nodes['go-resolution'].value,'');assert.equal(f.nodes['go-cpu'].value,'Host CPU');
});

test('A rejected binding retains advice and draft and never retries automatically',async()=>{
 const f=gamesFixture();normal(f,'Keep this answer');await f.nodes['go-ask-btn'].click();const previous=f.nodes['go-output'].innerHTML;
 f.nodes['go-question'].value='Follow up';f.handler(async()=>f.json({detail:'The selected model changed. Check selection again.'},409));await f.nodes['go-ask-btn'].click();
 assert.equal(f.nodes['go-output'].innerHTML,previous);assert.equal(f.nodes['go-question'].value,'Follow up');assert.match(f.nodes['go-request-status'].textContent,/selected model changed/);assert.equal(f.calls.filter(c=>c.url==='/games/ask').length,2);
});

test('Leaving Game Optimizer aborts advice and does not open Performance or accept late output',async()=>{
 const f=gamesFixture();let perf=0,finish;f.window.TLIPerformance={onOpen:()=>perf++};f.handler(async()=>f.json(specs));await f.window.TLIGames.onOpen();assert.equal(perf,0);assert.deepEqual(f.calls.map(call=>call.url),['/system/summary']);
 f.handler(async(url)=>url.startsWith('/games/advice_provider')?f.json(bound):new Promise(resolve=>finish=resolve));const pending=f.nodes['go-ask-btn'].click();await tick();f.window.TLIGames.onClose();
 finish(stream('Late text'));await pending;assert.equal(f.nodes['go-output'].innerHTML,'');assert.equal(f.nodes['go-ask-btn'].disabled,false);assert.equal(f.calls.find(c=>c.url==='/games/ask').options.signal.aborted,true);
});

test('Session lock clears private advice, game and corrections',async()=>{
 const f=gamesFixture();normal(f);await f.nodes['go-ask-btn'].click();f.nodes['go-manual-settings'].value='Private reading';f.nodes['go-cpu'].value='Private host';
 for(const handler of f.events['tli-session-locked']) handler();assert.equal(f.nodes['go-game-input'].value,'');assert.equal(f.nodes['go-manual-settings'].value,'');assert.equal(f.nodes['go-output'].textContent,'');assert.equal(f.nodes['go-context-receipt'].textContent,'');assert.equal(f.nodes['go-output-wrap'].style.display,'none');
});

for(const value of [{},{detail:'Unexpected success'},{cpu:[]},{cpu:{model:'Bad result'},ok:false}])test('malformed Game hardware success is unavailable and never replaces retained historical specs',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json(specs));await f.window.TLIGames.onOpen();f.handler(async()=>f.json(value));await f.nodes['go-read-hardware-btn'].click();
 assert.match(f.nodes['go-hardware-status'].textContent,/historical|previous/);assert.match(visible(f.nodes['go-hw-pills']),/Synthetic Ryzen/);assert.doesNotMatch(visible(f.nodes['go-hw-pills']),/Bad result/);
});

test('legitimate null Game hardware sections remain unknown rather than a failed request',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json({cpu:null,gpu:null,memory:{total_gb:null},display:null}));await f.window.TLIGames.onOpen();
 assert.doesNotMatch(f.nodes['go-hardware-status'].textContent,/failed|Could not/);assert.match(visible(f.nodes['go-hw-pills']),/Not reported/);
});

const settingsRead = (value='High') => ({game_name:'Cyberpunk 2077',supported:true,
 settings:[{key:'shadow_quality',label:'Shadow Quality',value}],
 advice_controls:[{key:'shadow_quality',label:'Shadow Quality',values:['Low','Medium','High','Ultra']}]});

test('detected game changes invalidate trial context without relying on an input event',async()=>{
 const f=gamesFixture();let invalidated=0,name='Cyberpunk 2077';f.window.TLIGameTrials={settingsChanged:()=>invalidated++};
 f.handler(async url=>{assert.equal(url,'/games/detect_best');return f.json({game:{name}});});
 await f.nodes['go-detect-btn'].click();assert.equal(invalidated,1);
 name='The Witcher 3';await f.nodes['go-detect-btn'].click();
 assert.equal(f.nodes['go-game-input'].value,name);assert.equal(invalidated,2);
 assert.ok(f.calls.every(call=>call.url==='/games/detect_best'));
});

test('detection names the discovered game and explicit Use this game preserves the typed choice until clicked',async()=>{
 const f=gamesFixture();let invalidated=0;f.window.TLIGameTrials={settingsChanged:()=>invalidated++};
 await f.nodes['go-game-input'].fire('input');const prior=invalidated;
 const name='Different <game> & title';f.handler(async url=>{assert.equal(url,'/games/detect_best');return f.json({game:{name}});});
 await f.nodes['go-detect-btn'].click();
 assert.equal(f.nodes['go-game-input'].value,'Cyberpunk 2077');assert.match(f.nodes['go-detect-status'].textContent,/Different <game> & title/);
 assert.equal(f.nodes['go-detect-status'].innerHTML,'');assert.equal(f.nodes['go-use-detected-game'].textContent,'Use this game');
 await f.nodes['go-use-detected-game'].click();
 assert.equal(f.nodes['go-game-input'].value,name);assert.equal(f.nodes['go-game-input'].dataset.userEdited,'1');
 assert.equal(invalidated,prior+1);assert.deepEqual(f.calls.map(call=>call.url),['/games/detect_best']);
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])test('detected game choice cannot survive '+event,async()=>{
 const f=gamesFixture();await f.nodes['go-game-input'].fire('input');
 f.handler(async()=>f.json({game:{name:'Previously detected private game'}}));await f.nodes['go-detect-btn'].click();
 const old=f.nodes['go-use-detected-game'];emit(f,event);emit(f,'tli-session-unlocked');emit(f,'tli-private-observation-ready');
 f.nodes['go-game-input'].value='New session choice';await old.click();
 assert.equal(f.nodes['go-game-input'].value,'New session choice');assert.equal(f.calls.length,1);
});

test('editing the game or leaving the panel makes an old detected-game button inert',async()=>{
 const f=gamesFixture();await f.nodes['go-game-input'].fire('input');
 f.handler(async()=>f.json({game:{name:'Detected game'}}));await f.nodes['go-detect-btn'].click();const first=f.nodes['go-use-detected-game'];
 f.nodes['go-game-input'].value='New typed game';await f.nodes['go-game-input'].fire('input');await first.click();
 assert.equal(f.nodes['go-game-input'].value,'New typed game');
 await f.nodes['go-detect-btn'].click();const second=f.nodes['go-use-detected-game'];f.window.TLIGames.onClose();await second.click();
 assert.equal(f.nodes['go-game-input'].value,'New typed game');assert.ok(f.calls.every(call=>call.url==='/games/detect_best'));
});

test('a delayed detection cannot replace a newer result or add an old use button',async()=>{
 const f=gamesFixture();await f.nodes['go-game-input'].fire('input');let finish;
 f.handler(async()=>new Promise(resolve=>finish=resolve));const old=f.nodes['go-detect-btn'].click();await tick();
 f.handler(async()=>f.json({game:{name:'New detection'}}));await f.nodes['go-detect-btn'].click();
 finish(f.json({game:{name:'Old detection'}}));await old;
 assert.match(f.nodes['go-detect-status'].textContent,/New detection/);assert.doesNotMatch(f.nodes['go-detect-status'].textContent,/Old detection/);
 await f.nodes['go-use-detected-game'].click();assert.equal(f.nodes['go-game-input'].value,'New detection');
});

test('direct settings refresh invalidates old trials before waiting and publishes only the latest read',async()=>{
 const f=gamesFixture();let invalidated=0;f.window.TLIGameTrials={settingsChanged:()=>invalidated++};
 f.handler(async()=>f.json(settingsRead()));await f.nodes['go-read-config-btn'].click();assert.equal(invalidated,2);
 const detached=f.window.TLIGames.trialContext();detached.current_settings[0].value='Modified outside';
 assert.equal(f.window.TLIGames.trialContext().current_settings[0].value,'High');
 let finish;f.handler(async()=>new Promise(resolve=>finish=resolve));const old=f.nodes['go-read-config-btn'].click();await tick();
 assert.equal(invalidated,3);assert.equal(f.window.TLIGames.trialContext().current_settings.length,0);
 f.handler(async()=>f.json(settingsRead('Low')));await f.nodes['go-read-config-btn'].click();
 assert.equal(invalidated,5);assert.equal(f.window.TLIGames.trialContext().current_settings[0].value,'Low');
 finish(f.json(settingsRead('Ultra')));await old;
 assert.equal(invalidated,5);assert.equal(f.window.TLIGames.trialContext().current_settings[0].value,'Low');
});

test('detecting another game and returning cannot accept a config read from the earlier game visit',async()=>{
 const f=gamesFixture();let finish,name='Cyberpunk 2077';
 f.handler(async url=>url==='/games/detect_best'?f.json({game:{name}}):new Promise(resolve=>finish=resolve));
 await f.nodes['go-detect-btn'].click();const old=f.nodes['go-read-config-btn'].click();await tick();
 name='The Witcher 3';await f.nodes['go-detect-btn'].click();name='Cyberpunk 2077';await f.nodes['go-detect-btn'].click();
 finish(f.json(settingsRead()));await old;
 assert.equal(f.window.TLIGames.trialContext().current_settings.length,0);
 assert.equal(f.window.TLIGames.trialContext().config_game_name,null);
});

test('failed direct config refresh invalidates trials and cannot supply stale current values',async()=>{
 const f=gamesFixture();let invalidated=0;f.window.TLIGameTrials={settingsChanged:()=>invalidated++};
 f.handler(async()=>f.json(settingsRead()));await f.nodes['go-read-config-btn'].click();
 f.handler(async()=>{throw Error('Synthetic unreadable settings');});await f.nodes['go-read-config-btn'].click();
 assert.equal(invalidated,4);assert.equal(f.window.TLIGames.trialContext().current_settings.length,0);
 assert.equal(f.window.TLIGames.trialContext().config_game_name,null);
 assert.match(f.nodes['go-config-badge'].textContent,/Previous read/);
});

test('legacy current-value corrections invalidate trials and retain user override provenance in context',async()=>{
 const f=gamesFixture();let invalidated=0;f.window.TLIGameTrials={settingsChanged:()=>invalidated++};
 f.handler(async()=>f.json(settingsRead()));await f.nodes['go-read-config-btn'].click();
 const select=f.nodes['go-settings-grid'].querySelector('select');select.value='Low';await select.fire('change');
 assert.equal(invalidated,3);const context=f.window.TLIGames.trialContext();
 assert.equal(context.current_settings[0].value,'High');assert.equal(context.manual_values.shadow_quality,'Low');
 context.manual_values.shadow_quality='Ultra';assert.equal(f.window.TLIGames.trialContext().manual_values.shadow_quality,'Low');
});

test('legacy manual setting names and values invalidate trials without requesting AI',async()=>{
 const f=gamesFixture();let invalidated=0;f.window.TLIGameTrials={settingsChanged:()=>invalidated++};
 f.handler(async()=>f.json({game_name:'Cyberpunk 2077',supported:false,settings:[],advice_controls:[]}));
 await f.nodes['go-read-config-btn'].click();
 const name=f.nodes['go-settings-grid'].querySelector('input'),select=f.nodes['go-settings-grid'].querySelector('select');
 name.value='Menu shadows';await name.fire('input');select.value='Medium';await select.fire('change');
 assert.equal(invalidated,4);assert.deepEqual(f.calls.map(call=>call.url),['/games/config_read']);
});

for(const event of ['tli-account-changed','tli-user-changed'])test(event+' clears shared private config and rejects an old pending read',async()=>{
 const f=gamesFixture();f.handler(async()=>f.json(settingsRead()));await f.nodes['go-read-config-btn'].click();
 const select=f.nodes['go-settings-grid'].querySelector('select');select.value='Medium';await select.fire('change');
 let finish;f.handler(async()=>new Promise(resolve=>finish=resolve));const old=f.nodes['go-read-config-btn'].click();await tick();
 emit(f,event);assert.equal(f.nodes['go-game-input'].value,'');assert.equal(f.window.TLIGames.trialContext().locked,true);
 assert.equal(f.nodes['go-settings-grid'].innerHTML,'');
 emit(f,'tli-session-unlocked');emit(f,'tli-private-observation-ready');f.nodes['go-game-input'].value='Cyberpunk 2077';
 finish(f.json(settingsRead('Ultra')));await old;
 const context=f.window.TLIGames.trialContext();assert.equal(context.current_settings.length,0);assert.equal(Object.keys(context.manual_values).length,0);
 assert.equal(context.config_game_name,null);assert.equal(f.calls.length,2);
});
