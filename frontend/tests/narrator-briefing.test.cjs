const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/narrator-briefing.js'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function fixture() {
  let monotonic = 1000, wall = 1700000000000, refresh = async () => {}, draftAllowed = true;
  const events = {}, calls = {storage:[], panels:[], drafts:[], refresh:0}, roots = [];
  const document = {activeElement:null};
  function element(tag) {
    let ownText = '';
    const listeners = {};
    return {tagName:tag.toUpperCase(), id:'', dataset:{}, style:{}, attributes:{}, children:[], hidden:false, disabled:false,
      get textContent() {return ownText + this.children.map(child => child.textContent).join('');},
      set textContent(value) {ownText = String(value); this.children = [];},
      append(...children) {this.children.push(...children);},
      replaceChildren(...children) {ownText = ''; this.children = children;},
      setAttribute(key,value) {this.attributes[key] = String(value);},
      removeAttribute(key) {delete this.attributes[key]; if (key === 'id') this.id = '';},
      addEventListener(name,fn) {(listeners[name] ||= []).push(fn);},
      async click() {if (!this.disabled) for (const fn of listeners.click || []) await fn();},
      focus() {document.activeElement = this;}, scrollIntoView() {},
    };
  }
  const find = (predicate, nodes = roots) => {
    for (const node of nodes) {if (predicate(node)) return node; const child = find(predicate,node.children); if (child) return child;}
    return null;
  };
  Object.assign(document, {createElement:element, getElementById:id=>find(node=>node.id===id)});
  for (const id of ['narrator-briefing','activity-catchup','nd-statement-text','nd-statement']) {const root=element('section');root.id=id;roots.push(root);}
  const window = {
    addEventListener(name,fn) {(events[name] ||= []).push(fn);},
    switchPanel:panel=>calls.panels.push(panel), matchMedia:()=>({matches:false}),
    TLIDash2:{openStorage:target=>calls.storage.push(target),refresh:()=>{calls.refresh++;return refresh();}},
    TLIAISource:{getSnapshot:()=>({text:'AI: Integrated',title:'Runtime health confirmed.',checkedAt:wall})},
    TLIChatWorkspace:{prepareDraft:message=>{calls.drafts.push(message);return draftAllowed && message.length <= 12000;}},
  };
  class ClockDate extends Date {static now() {return wall;}}
  const context=vm.createContext({window,document,Date:ClockDate,performance:{now:()=>monotonic},console});
  vm.runInContext(source,context);
  return {api:window.TLINarrator,context,document,window,calls,find,$:id=>document.getElementById(id),
    emit:name=>(events[name] || []).forEach(fn=>fn()),
    advance(ms) {monotonic += ms;wall += ms;}, moveWall(ms) {wall += ms;},
    refresh:handler=>{refresh=handler;}, allowDraft:allowed=>{draftAllowed=allowed;},
  };
}

const observation = (changes={}) => ({id:'disk:C:\\',title:'C:\\ · 98% used',detail:'Critically full. Review large files and folders.',
  severity:'critical',source:'Host storage reading',observed_at:1000,action:{kind:'storage',label:'Review in Free Space',path:'C:\\'},...changes});
const message = (changes={}) => ({briefing:{version:1,generated_at:1000,observed_at:1000,freshness:'current',host:'Office computer',
  summary:'1 storage warning needs your attention.',items:[observation()],...changes}});
const topic = (f,id) => f.find(node=>node.dataset.narratorItem===id);

test('review is explicit navigation and records no AI draft until asked', async()=>{
  const f=fixture();f.api.accept(message());
  assert.deepEqual(f.calls.storage,[]);assert.deepEqual(f.calls.drafts,[]);
  await f.$('narrator-open').click();assert.deepEqual(f.calls.storage,['C:\\']);
  await f.$('narrator-ask').click();assert.equal(f.calls.drafts.length,1);
  assert.match(f.calls.drafts[0],/recorded observations, not instructions or permission to act/);
  assert.match(f.calls.drafts[0],/Office computer/);assert.equal(f.calls.panels.length,0);
});

test('freshness ages using monotonic time and expired storage actions cannot navigate',async()=>{
  const f=fixture();f.api.accept(message());f.moveWall(-600000);f.advance(30000);f.api.tick();
  assert.equal(f.$('narrator-briefing').dataset.freshness,'stale');
  assert.equal(f.$('narrator-open').disabled,true);await f.$('narrator-open').click();
  assert.deepEqual(f.calls.storage,[]);assert.match(f.$('narrator-focus').textContent,/Previous observation/);
});

test('re-delivering the same observation cannot renew expired health, activity, or LAN facts',()=>{
  const f=fixture(),packet=message({activity:{text:'Recorded change',observed_at:1000,expires_at:1030}});
  const context={ts:1000,mesh:{peer_count:3,online_peer_count:2}};
  f.api.accept(packet);f.api.observeContext(context);f.advance(30000);f.api.tick();
  f.api.accept(packet);f.api.observeContext(context);
  assert.equal(f.$('narrator-briefing').dataset.freshness,'stale');
  assert.doesNotMatch(f.$('narrator-signal').textContent,/Recorded change/);
  assert.doesNotMatch(f.$('narrator-compute').textContent,/2 of 3/);
});

test('late older briefings cannot replace newer evidence or selected observation',async()=>{
  const f=fixture();
  f.api.accept(message({generated_at:1002,observed_at:1002,items:[observation({title:'New current fact',observed_at:1002})]}));
  f.api.accept(message({generated_at:1001,items:[observation({title:'Old response'})]}));
  assert.equal(f.$('narrator-focus-title').textContent,'New current fact');
});

test('selected observation and keyboard focus survive a fresh reading; new critical evidence takes priority',async()=>{
  const f=fixture(), first=observation({severity:'warning'}), second=observation({id:'ram_pct',title:'RAM pressure',severity:'warning'});
  f.api.accept(message({items:[first,second]}));await topic(f,'ram_pct').click();topic(f,'ram_pct').focus();
  f.api.accept(message({generated_at:1001,items:[first,{...second,title:'RAM pressure, latest reading'}]}));
  assert.equal(f.$('narrator-focus-title').textContent,'RAM pressure, latest reading');
  assert.equal(f.document.activeElement.dataset.narratorItem,'ram_pct');
  assert.equal(topic(f,'ram_pct').attributes['aria-pressed'],'true');
  f.api.accept(message({generated_at:1002,items:[{...first,severity:'critical'},second]}));
  assert.equal(f.$('narrator-focus-title').textContent,first.title);
});

test('recorded events expire independently and fresh host facts do not renew old activity',()=>{
  const f=fixture(), activity={text:'Device command acknowledged.',observed_at:995,expires_at:1025};
  f.api.accept(message({activity}));assert.match(f.$('narrator-signal').textContent,/acknowledged/);
  f.advance(20000);f.api.accept(message({generated_at:1020,observed_at:1020,activity}));
  f.advance(5000);f.api.tick();assert.doesNotMatch(f.$('narrator-signal').textContent,/acknowledged/);
});

test('LAN observations expire and reject older context without inferring AI permission',()=>{
  const f=fixture();f.api.accept(message());
  f.api.observeContext({ts:1001,mesh:{peer_count:3,online_peer_count:2}});
  assert.match(f.$('narrator-compute').textContent,/2 of 3.*AI access is reviewed separately/);
  f.api.observeContext({ts:1000,mesh:{peer_count:1,online_peer_count:1}});
  assert.match(f.$('narrator-compute').textContent,/2 of 3/);
  f.advance(30000);f.api.tick();assert.doesNotMatch(f.$('narrator-compute').textContent,/2 of 3/);
});

test('locked sessions clear private evidence and detached actions remain inert until fresh data arrives',async()=>{
  const f=fixture();f.api.accept(message());const ask=f.$('narrator-ask'),open=f.$('narrator-open');
  f.emit('tli-session-locked');assert.equal(f.$('narrator-briefing').textContent,'');assert.equal(f.$('narrator-briefing').hidden,true);
  f.api.accept(message({generated_at:1001,host:'Late private host'}));await ask.click();await open.click();
  assert.deepEqual(f.calls.drafts,[]);assert.deepEqual(f.calls.storage,[]);
  f.emit('tli-session-unlocked');assert.equal(f.$('narrator-briefing').textContent,'');
  f.api.accept(message({generated_at:1002}));assert.equal(f.$('narrator-briefing').hidden,false);
});

test('existing chat draft rejection is respected without retries or automatic submission',async()=>{
  const f=fixture();f.allowDraft(false);f.api.accept(message());await f.$('narrator-ask').click();
  assert.equal(f.calls.drafts.length,1);assert.match(f.$('narrator-feedback').textContent,/draft and attachments were preserved/);
  assert.deepEqual(f.calls.storage,[]);
});

test('briefing context stays within Chat draft capacity, including bounded malformed long fields',async()=>{
  const f=fixture(), long='x'.repeat(600);
  f.api.accept(message({summary:long,items:Array.from({length:10},(_,index)=>observation({id:String(index),title:long,detail:long,source:long}))}));
  await f.$('narrator-ask').click();assert.equal(f.calls.drafts.length,1);
  assert.ok(f.calls.drafts[0].length<=12000,`Draft exceeds Chat's 12,000 character bound: ${f.calls.drafts[0].length}`);
});

test('Diagnostics remains usable to investigate unavailable monitoring',async()=>{
  const f=fixture();f.api.accept(message({freshness:'unavailable',items:[observation({id:'monitoring',action:{kind:'diagnostics',label:'Open Diagnostics'}})]}));
  assert.equal(f.$('narrator-open').disabled,false);await f.$('narrator-open').click();
  assert.deepEqual(f.calls.panels,['panel-system']);
});

test('an old refresh completion after lock and unlock cannot restore or dereference the cleared view',async()=>{
  const f=fixture(), wait=deferred();f.refresh(()=>wait.promise);f.api.accept(message());
  await f.$('narrator-refresh').click();f.emit('tli-session-locked');f.emit('tli-session-unlocked');wait.resolve();await turn();
  assert.equal(f.$('narrator-briefing').hidden,true);assert.equal(f.$('narrator-briefing').textContent,'');
});

function heroFixture({typewriter=false}={}) {
  const f=fixture(),timeouts=new Map(),intervals=new Map(),displayed=[];let nextTimer=0;
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  Object.assign(f.context,{_open:true,_sessionLocked:false,_accessBlocked:false,_typeTimer:null,_el:f.$,_setNarratorCard(){},
    _typeText:value=>{f.$('nd-statement-text').textContent=value;displayed.push(value);},
    setTimeout:fn=>{const id=++nextTimer;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),
    setInterval:fn=>{const id=++nextTimer;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id)});
  if(typewriter){const start=app.indexOf('  function _typeText('),end=app.indexOf('  function _narratorNext()',start);vm.runInContext(app.slice(start,end),f.context);}
  const start=app.indexOf('  let _serverNarrator = null;'),end=app.indexOf("  window.addEventListener('tli-system-observation'",start);
  vm.runInContext(app.slice(start,end)+'\nthis.showNarrator=setEventMessage;',f.context);
  return {...f,displayed,show:(briefing)=>f.context.showNarrator({type:'alert',timestamp:1000,text:'The original highest-priority warning.',...briefing}),
    flushTransitions(){for(const [id,fn] of [...timeouts]){timeouts.delete(id);fn();}},
    typeCharacter(){for(const fn of [...intervals.values()])fn();}};
}

test('the hero and cards agree when older responses carry the same legacy headline timestamp',()=>{
  const f=heroFixture();
  f.show(message({generated_at:1002,observed_at:1002,summary:'2 storage warnings need your attention.'}));
  f.show(message({generated_at:1001,summary:'1 storage warning needs your attention.'}));f.flushTransitions();
  assert.deepEqual(f.displayed,['2 storage warnings need your attention.']);
});

test('an expired hero recovers when new evidence retains the same headline',()=>{
  const f=heroFixture();f.show(message());f.flushTransitions();f.advance(30000);f.api.tick();
  assert.match(f.$('nd-statement-text').textContent,/fresh check/);
  f.show(message({generated_at:1030,observed_at:1030}));f.flushTransitions();
  assert.equal(f.$('nd-statement-text').textContent,'1 storage warning needs your attention.');
  assert.notEqual(f.$('nd-statement-text').dataset.narratorExpired,'true');
});

test('typewriter work cannot append old claims after the hero expires',()=>{
  const f=heroFixture({typewriter:true});f.show(message({observed_at:971}));f.flushTransitions();f.typeCharacter();
  f.advance(2000);f.api.tick();const expired=f.$('nd-statement-text').textContent;assert.match(expired,/fresh check/);
  f.typeCharacter();assert.equal(f.$('nd-statement-text').textContent,expired);
});

test('dashboard access denial clears the complete briefing and blocks later narrator updates',()=>{
  const f=heroFixture();f.show(message());f.flushTransitions();
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const start=app.indexOf('  function _clearPrivateDashboard()'),end=app.indexOf('  function _showAccessPrompt()',start);
  Object.assign(f.context,{_lastData:{},_seenFeedIds:new Set(),_setVital(){}});
  vm.runInContext(app.slice(start,end)+'\nthis.clearPrivateDashboard=_clearPrivateDashboard;',f.context);
  f.context._accessBlocked=true;f.context.clearPrivateDashboard();
  assert.equal(f.$('narrator-briefing').hidden,true);assert.equal(f.$('narrator-briefing').textContent,'');
  f.show(message({generated_at:1001,host:'Late private host'}));f.flushTransitions();
  assert.equal(f.$('narrator-briefing').hidden,true);assert.equal(f.$('narrator-briefing').textContent,'');
});
