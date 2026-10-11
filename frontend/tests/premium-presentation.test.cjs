const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const presentation = fs.readFileSync(path.join(__dirname, '../js/premium-presentation.js'), 'utf8');
const interfaceStyle = fs.readFileSync(path.join(__dirname, '../js/interface-style.js'), 'utf8');

function fixture({experience, legacy = 'classic', readFailure = false, writeFailure = false, url = 'https://tli.test/'} = {}) {
  const events = [], writes = [], queued = [], windowListeners = new Map(), documentListeners = new Map();
  const storage = new Map([['tli_interface_style', legacy], ['tli_settings', '{"defaultTheme":"pacific","other":true}']]);
  if (experience !== undefined) storage.set('tli_experience_v1', experience);
  const listener = (store, type, fn) => { if (!store.has(type)) store.set(type, []); store.get(type).push(fn); };
  const control = value => ({value, hidden:false, textContent:'', isConnected:true, selectionStart:null,
    listeners: new Map(), addEventListener(type, fn) { listener(this.listeners,type,fn); },
    change() { for (const fn of this.listeners.get('change') || []) fn({target:this}); },
    click() { for (const fn of this.listeners.get('click') || []) fn({target:this}); },
    getClientRects() { return this.hidden ? [] : [{}]; },
    focus() { document.activeElement = this; },
    setSelectionRange(start,end,direction) { this.selectionStart=start; this.selectionEnd=end; this.selectionDirection=direction; }});
  const nodes = Object.fromEntries(['tli-experience-select','tli-legacy-interface','tli-experience-status',
    'tli-interface-select','tli-interface-status','tli-interface-notice','tli-use-new-experience'].map(id => [id,control('')]));
  const scrolls = [];
  const document = {readyState:'loading', documentElement:{dataset:{theme:'pacific'}}, body:{}, activeElement:null,
    getElementById:id => nodes[id] || null,
    querySelectorAll(selector) {
      if (selector === '.main-scroll, .sidebar, #chat-output, #chat-history-list') return scrolls;
      if (selector === '.sidebar .tli-nav-group' || selector === 'input[name="tli-interface-style"]') return [];
      throw Error('Unexpected query: ' + selector);
    },
    addEventListener(type,fn) { listener(documentListeners,type,fn); }};
  document.activeElement = document.body;
  const window = {
    addEventListener(type,fn) { listener(windowListeners,type,fn); },
    dispatchEvent(event) { events.push(event); for (const fn of windowListeners.get(event.type) || []) fn(event); return true; },
    location:{href:url,search:new URL(url).search,reload:() => assert.fail('Presentation must not reload'),assign:() => assert.fail('Presentation must not navigate')},
    history:{state:{keep:true},replaceState(state,unused,next) { this.replaced={state,url:next}; }},
  };
  const context = vm.createContext({window,document,URL,
    CustomEvent:class { constructor(type,{detail}={}) { this.type=type; this.detail=detail; } },
    queueMicrotask:fn => queued.push(fn),
    localStorage:{getItem(key) { if (readFailure) throw Error('Denied'); return storage.get(key) ?? null; },
      setItem(key,value) { if (writeFailure) throw Error('Denied'); writes.push([key,value]); storage.set(key,value); }},
    fetch:() => assert.fail('Presentation must not fetch'),
    XMLHttpRequest:class { constructor() { assert.fail('Presentation must not request'); } },
    setInterval:() => assert.fail('Presentation must not poll'),
  });
  vm.runInContext(presentation,context); vm.runInContext(interfaceStyle,context);
  return {api:window.TLIPresentation, interface:window.TLIInterface, window, document, nodes, storage, events, writes, scrolls, control,
    load() { document.readyState='complete'; for (const fn of documentListeners.get('DOMContentLoaded') || []) fn(); while (queued.length) queued.shift()(); },
    failWrites(value) { writeFailure=value; }};
}

test('new and invalid preferences default to premium before painting without overwriting legacy or colors', () => {
  for (const experience of [undefined,'','PREMIUM','unknown','null','legacy\n']) {
    const f=fixture({experience});
    assert.equal(f.api.get(),'premium'); assert.equal(f.document.documentElement.dataset.experience,'premium');
    assert.equal(f.interface.get(),'modern'); assert.equal(f.interface.getLegacy(),'classic');
    assert.deepEqual(f.writes,[]); assert.equal(f.document.documentElement.dataset.theme,'pacific');
    f.load(); assert.equal(f.nodes['tli-experience-select'].value,'premium'); assert.equal(f.nodes['tli-legacy-interface'].hidden,true);
    assert.equal(f.storage.get('tli_interface_style'),'classic'); assert.deepEqual(f.events,[]);
  }
});

test('saved legacy Classic opens directly and premium round trips preserve the saved choice', () => {
  const f=fixture({experience:'legacy'}); f.load();
  assert.equal(f.interface.get(),'classic'); assert.equal(f.nodes['tli-legacy-interface'].hidden,false);
  f.api.set('premium'); assert.equal(f.interface.get(),'modern'); assert.equal(f.interface.getLegacy(),'classic');
  f.api.set('legacy'); assert.equal(f.interface.get(),'classic');
  assert.deepEqual(f.writes,[['tli_experience_v1','premium'],['tli_experience_v1','legacy']]);
  assert.equal(f.storage.get('tli_settings'),'{"defaultTheme":"pacific","other":true}');
  assert.equal(f.storage.get('tli_interface_style'),'classic');
  assert.deepEqual(f.events.map(event => event.type),['tli:experience-change','tli:interface-change','tli:experience-change','tli:interface-change']);
});

test('invalid presentation inputs have no visible or persistent side effects', () => {
  const f=fixture(); f.load();
  for (const value of [null,undefined,{},1,'classic','modern','<img>']) assert.equal(f.api.set(value),false);
  assert.equal(f.api.get(),'premium'); assert.deepEqual(f.events,[]); assert.deepEqual(f.writes,[]);
});

test('visible legacy upgrade switches immediately and saves only experience', () => {
  const f=fixture({experience:'legacy'}); f.load();
  assert.equal(f.nodes['tli-use-new-experience'].hidden,false);
  f.nodes['tli-use-new-experience'].click();
  assert.equal(f.api.get(),'premium'); assert.equal(f.nodes['tli-use-new-experience'].hidden,true);
  assert.deepEqual(f.writes,[['tli_experience_v1','premium']]);
  assert.equal(f.storage.get('tli_interface_style'),'classic');
  assert.equal(f.storage.get('tli_settings'),'{"defaultTheme":"pacific","other":true}');
});

test('explicit new-experience link overrides legacy once and preserves destination and history state', () => {
  const f=fixture({experience:'legacy',url:'https://tli.test/?panel=main&experience=premium#context'}); f.load();
  assert.equal(f.api.get(),'premium'); assert.deepEqual(f.writes,[['tli_experience_v1','premium']]);
  assert.equal(f.window.history.replaced.url,'/?panel=main#context');
  assert.equal(f.window.history.replaced.state.keep,true);
  assert.equal(f.storage.get('tli_interface_style'),'classic');
  assert.equal(f.storage.get('tli_settings'),'{"defaultTheme":"pacific","other":true}');
});

test('activation link remains usable if saving is denied; unrelated query preserves explicit legacy', () => {
  const f=fixture({experience:'legacy',url:'https://tli.test/?experience=premium',writeFailure:true}); f.load();
  assert.equal(f.api.get(),'premium'); assert.equal(f.storage.get('tli_experience_v1'),'legacy');
  assert.match(f.nodes['tli-experience-status'].textContent,/Applied for this page/);
  for (const value of ['legacy','modern','unknown']) {
    const old=fixture({experience:'legacy',url:'https://tli.test/?experience='+value}); old.load();
    assert.equal(old.api.get(),'legacy'); assert.deepEqual(old.writes,[]);
  }
});

test('denied reads and writes keep controls usable and explain actual persistence', () => {
  const f=fixture({experience:'legacy',readFailure:true,writeFailure:true}); f.load();
  assert.equal(f.api.get(),'premium'); assert.match(f.nodes['tli-experience-status'].textContent,/Applied for this page.*unavailable/);
  f.nodes['tli-experience-select'].value='legacy'; f.nodes['tli-experience-select'].change();
  assert.equal(f.api.get(),'legacy'); assert.equal(f.nodes['tli-legacy-interface'].hidden,false);
  assert.match(f.nodes['tli-experience-status'].textContent,/Applied for this page.*unavailable/);
  assert.equal(f.writes.length,0);
  f.failWrites(false); f.api.set('legacy');
  assert.match(f.nodes['tli-experience-status'].textContent,/Saved in this browser/);
  assert.deepEqual(f.writes,[['tli_experience_v1','legacy']]);
});

test('setting the same experience updates persistence without rebuilding owners', () => {
  const f=fixture(); f.load();
  f.api.set('premium'); f.api.set('premium');
  assert.deepEqual(f.events,[]); assert.equal(f.writes.length,2);
});

test('premium keeps the effective Modern layout while an explicit legacy choice changes', () => {
  const f=fixture({legacy:'modern'}); f.load();
  f.interface.set('classic'); assert.equal(f.interface.get(),'modern'); assert.equal(f.interface.getLegacy(),'classic');
  f.api.set('legacy'); assert.equal(f.interface.get(),'classic');
  assert.equal(f.storage.get('tli_interface_style'),'classic');
  assert.equal(f.storage.get('tli_settings'),'{"defaultTheme":"pacific","other":true}');
});

test('experience changes restore the same focused draft and selection after DOM movement', () => {
  const f=fixture(); f.load(); const input=f.control('Unsent user text'); input.setSelectionRange(3,9,'backward'); f.document.activeElement=input;
  f.window.addEventListener('tli:experience-change',() => { f.document.activeElement=f.document.body; input.setSelectionRange(0,0,'forward'); });
  f.api.set('legacy');
  assert.equal(f.document.activeElement,input); assert.equal(input.value,'Unsent user text');
  assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection],[3,9,'backward']);
});

test('experience owner snapshots reader anchor before CSS and reparenting change geometry', () => {
  const f=fixture(); f.load(); let anchorTop=40;
  const anchor={getClientRects:() => [{}],getBoundingClientRect:() => ({top:anchorTop,height:10})};
  const output={id:'chat-output',children:[anchor],scrollTop:120,scrollLeft:2,scrollHeight:1000,clientHeight:200,
    matches:() => false,getBoundingClientRect:() => ({top:0,bottom:200})};
  f.scrolls.push(output); f.window.addEventListener('tli:experience-change',() => { anchorTop=75; });
  f.api.set('legacy'); assert.equal(output.scrollTop,155); assert.equal(output.scrollLeft,2);
});
