const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const summarySource = fs.readFileSync(path.join(__dirname, '../js/activity-summary.js'), 'utf8');
const feedSource = fs.readFileSync(path.join(__dirname, '../js/live-feed.js'), 'utf8');
const interpreterSource = fs.readFileSync(path.join(__dirname, '../js/event_interpreter.js'), 'utf8');

function element() {
  return {children: [], handlers: {}, dataset: {}, style: {}, textContent: '', hidden: false,
    setAttribute(){}, append(...items){this.children.push(...items);},
    appendChild(item){this.append(item);}, replaceChildren(...items){this.children = items;},
    insertBefore(item){this.children.unshift(item);}, removeChild(item){this.children.splice(this.children.indexOf(item), 1);},
    get firstChild(){return this.children[0];}, get lastChild(){return this.children.at(-1);},
    addEventListener(type, fn){this.handlers[type] = fn;},
    click(){return this.disabled ? Promise.resolve() : this.handlers.click?.();}};
}
const recorded = (changes={}) => ({title:'Device changed', node:'Office', category:'device', level:'info',
  body:'Observed by TLI.', ts:1000, first_ts:1000, count:1, ...changes});
const snapshot = (changes={}) => ({ok:true, total:1, warning_count:0, cursor:{stream_id:'a'.repeat(32), sequence:1},
  coverage:'first_visit', coverage_note:'Showing retained activity. No previous review has been saved.',
  retention_limit:200, groups:[recorded()], group_count:1, events:[recorded()], ...changes});

function setup(handler=async () => snapshot()) {
  const nodes = {}, events = {}, calls = [];
  const get = id => nodes[id] ||= element();
  get('panel-dashboard2').hidden = true;
  get('activity-coverage-details');
  const ctx = vm.createContext({window:{addEventListener:(name, fn) => events[name] = fn}, document:{readyState:'complete', getElementById:get,
    createElement:element, addEventListener:(name, fn) => events[name] = fn}, AbortSignal,
    fetch:async (url, options) => {
      calls.push([url, options]);
      const body = await handler(url, options);
      return {ok:body.ok !== false, json:async () => body};
    }});
  vm.runInContext(summarySource, ctx);
  return {ctx, nodes, events, calls, refresh:ctx.window.TLIActivitySummary.refresh};
}
function allText(node) {return [node.textContent, ...node.children.map(allText)].join(' ');}

test('reading groups and full history never acknowledges activity or interprets markup', async () => {
  const entry = recorded({title:'<img onerror=attack()>', body:'<script>secret</script>', count:3});
  const f = setup(async () => snapshot({groups:[entry], events:[entry,entry,entry], total:3}));
  await f.refresh();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].method, undefined);
  assert.equal(f.nodes['activity-history'].children.length, 3);
  assert.match(allText(f.nodes['activity-groups']), /<img onerror=attack\(\)>/);
  assert.match(allText(f.nodes['activity-groups']), /×3/);
  assert.match(f.nodes['activity-history-note'].textContent, /warnings may have changed/);
});

test('review uses the visible cursor even when new events arrive and duplicate clicks send once', async () => {
  let finish, reviewed = false;
  const f = setup(async (url, options) => {
    if (options.method === 'POST') return new Promise(resolve => finish = () => { reviewed = true; resolve({ok:true}); });
    return reviewed ? snapshot({cursor:{stream_id:'a'.repeat(32), sequence:2}, events:[recorded({title:'New event'})]}) : snapshot();
  });
  await f.refresh();
  f.events['tli-activity-event']({detail:{stream_id:'a'.repeat(32), sequence:2}});
  assert.equal(f.nodes['activity-new'].hidden, false);
  const first = f.nodes['activity-review'].click();
  await f.nodes['activity-review'].click();
  const posts = f.calls.filter(([, options]) => options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0][1].body).sequence, 1);
  finish(); await first;
  assert.match(allText(f.nodes['activity-history']), /New event/);
});

test('unavailable summaries retain prior rows and disable review without claiming no changes', async () => {
  let fail = false;
  const f = setup(async () => fail ? {ok:false, detail:'Unlock TLI to view activity.'} : snapshot());
  await f.refresh();
  const previous = f.nodes['activity-groups'].children[0];
  fail = true; await f.refresh();
  assert.equal(f.nodes['activity-groups'].children[0], previous);
  assert.equal(f.nodes['activity-review'].disabled, true);
  assert.match(f.nodes['activity-error'].textContent, /Unlock TLI/);
  assert.doesNotMatch(f.nodes['activity-count'].textContent, /No new/);
});

test('failed review retains activity and supports explicit retry without automatic posts', async () => {
  const f = setup(async (url, options) => options.method === 'POST'
    ? {ok:false, detail:'Could not save your review position.'} : snapshot());
  await f.refresh(); await f.nodes['activity-review'].click();
  assert.equal(f.nodes['activity-groups'].children.length, 1);
  assert.equal(f.nodes['activity-review'].disabled, false);
  assert.match(f.nodes['activity-error'].textContent, /Could not save/);
  assert.equal(f.calls.filter(([, opts]) => opts.method === 'POST').length, 1);
});

test('restart and empty partial history display the coverage gap', async () => {
  const f = setup(async () => snapshot({total:0, events:[], groups:[], group_count:0, coverage:'restarted',
    reviewed_at:900, coverage_note:'TLI restarted. Earlier activity is unavailable.'}));
  await f.refresh();
  assert.match(f.nodes['activity-coverage'].textContent, /Earlier activity is unavailable/);
  assert.equal(f.nodes['activity-history-details'].hidden, true);
  assert.equal(f.nodes['activity-review'].disabled, false);
});

test('reviewed events remain available in retained history', async () => {
  const f = setup(async () => snapshot({total:0, events:[], groups:[], coverage:'complete',
    retained_events:[recorded()], reviewed_at:900}));
  await f.refresh();
  assert.equal(f.nodes['activity-history'].children.length, 1);
  assert.equal(f.nodes['activity-history-details'].hidden, false);
  assert.equal(f.nodes['activity-review'].disabled, true);
});

test('durable generic history explains scope and reviews only the visible history cursor', async () => {
  const f = setup(async (url, options) => options.method === 'POST' ? {ok:true} : snapshot({
    history:{limit:500, days:7, status:'recording'}, history_cursor:{stream_id:'b'.repeat(32), sequence:6},
    retained_events:[recorded({retained_generic:true, title:'Storage scan finished'})]}));
  await f.refresh();
  assert.match(allText(f.nodes['activity-history']), /private details were not saved/);
  assert.match(f.nodes['activity-history-note'].textContent, /500 entries for 7 days across restarts/);
  await f.nodes['activity-review'].click();
  const sent = JSON.parse(f.calls.find(([, options]) => options.method === 'POST')[1].body);
  assert.deepEqual(sent.history_cursor, {stream_id:'b'.repeat(32), sequence:6});
});

test('legacy responses describe unreported restart retention without claiming history was erased', async () => {
  const f = setup(async () => snapshot({checked_at:1000})); await f.refresh();
  assert.match(f.nodes['activity-history-note'].textContent, /Retention across restarts was not reported/);
  assert.doesNotMatch(f.nodes['activity-history-note'].textContent, /until it restarts/);
  assert.match(f.nodes['activity-coverage-summary'].textContent, /unreported/); assert.match(f.nodes['activity-checked-at'].textContent, /Checked/);
  assert.equal(f.nodes['activity-catchup'].dataset.state, 'ready');
});

test('malformed replacement snapshots preserve earlier content and disable review', async () => {
  let malformed = false; const f = setup(async () => malformed ? snapshot({groups:[null]}) : snapshot()); await f.refresh();
  const previous = f.nodes['activity-groups'].children[0], previousCount = f.nodes['activity-count'].textContent;
  malformed = true; await f.refresh(); assert.equal(f.nodes['activity-groups'].children[0], previous); assert.equal(f.nodes['activity-count'].textContent, previousCount);
  assert.equal(f.nodes['activity-review'].disabled, true); assert.equal(f.nodes['activity-catchup'].dataset.state, 'stale');
});

test('complete retained history with nothing new shows Up to date without a review write', async () => {
  const f = setup(async () => snapshot({total:0, groups:[], events:[], group_count:0, coverage:'retained', reviewed_at:900, history:{limit:500, days:7, status:'recording'}}));
  await f.refresh(); assert.equal(f.nodes['activity-review'].textContent, 'Up to date'); assert.equal(f.nodes['activity-review'].disabled, true);
  await f.nodes['activity-review'].click(); assert.equal(f.calls.length, 1); assert.match(f.nodes['activity-coverage-summary'].textContent, /retained across restarts/);
});

test('session lock clears counts, observed metadata and expanded history; late reads cannot restore them', async () => {
  let release, pending = false; const f = setup(async () => pending ? new Promise(resolve => {release=resolve;}) : snapshot()); await f.refresh();
  f.nodes['activity-history-details'].open = true; f.nodes['activity-coverage-details'].open = true; pending = true; const read = f.refresh();
  f.events['tli-session-locked'](); release(snapshot({groups:[recorded({title:'Late private event'})]})); await read;
  assert.equal(f.nodes['activity-groups'].children.length, 0); assert.equal(f.nodes['activity-history'].children.length, 0); assert.equal(f.nodes['activity-count'].textContent, '');
  assert.equal(f.nodes['activity-history-details'].open, false); assert.equal(f.nodes['activity-coverage-details'].open, false); assert.equal(f.nodes['activity-review'].disabled, true);
});

test('401 access failure clears private event rows even without a global fetch interceptor', async () => {
  const f = setup(); await f.refresh(); f.ctx.fetch = async () => ({ok:false,status:401,json:async()=>({detail:'Unlock TLI.'})}); await f.refresh();
  assert.equal(f.nodes['activity-groups'].children.length, 0); assert.equal(f.nodes['activity-count'].textContent, ''); assert.match(f.nodes['activity-error'].textContent, /Unlock TLI/);
});

function narratorFixture(handler) {
  const nodes = {}, events = {}, calls = [];
  const create = tag => {
    const item = element(); item.tagName = tag;
    Object.defineProperty(item, 'id', {set(value){nodes[value] = item;}, get(){return Object.keys(nodes).find(key => nodes[key] === item);}});
    return item;
  };
  for (const id of ['nd-narrator', 'activity-catchup', 'activity-refresh', 'activity-review', 'panel-dashboard2']) nodes[id] = create('div');
  nodes['panel-dashboard2'].hidden = true;
  const win = {addEventListener:(name, fn) => (events[name] ||= []).push(fn)};
  const ctx = vm.createContext({window:win, document:{readyState:'complete',
    getElementById:id => id === 'narrator-preferences' || id === 'nd-narrator' ? nodes[id] : nodes[id] ||= create('div'),
    createElement:create, addEventListener(){}}, AbortSignal,
    fetch:async (url, options) => {calls.push([url, options]); const body = await handler(url, options); return {ok:body.ok !== false, json:async () => body};}});
  vm.runInContext(summarySource, ctx);
  const details = nodes['narrator-preferences'];
  const find = (item, text) => item.textContent === text ? item : item.children.map(child => find(child, text)).find(Boolean);
  return {nodes, calls, events, details, select:nodes['narrator-mode'], save:find(details, 'Save mode'),
    open:() => {details.open = true; details.handlers.toggle();}, refresh:() => find(details, 'Refresh settings and explanation').click()};
}

test('host Narrator settings await confirmed results and reject duplicate requests', async () => {
  let finish;
  const f = narratorFixture(async (url, options) => options.method === 'PUT'
    ? new Promise(resolve => finish = resolve)
    : {ok:true, scope:'host', mode:'balanced', narrator:{explanations:[{why:'<script>warning</script>', clears_when:'A fresh reading changes.'}]}});
  f.details.open = true; await f.refresh();
  assert.match(allText(f.details), /everyone using this TLI host/);
  assert.match(allText(f.details), /<script>warning<\/script>/);
  assert.equal(f.select.value, 'balanced'); f.select.value = 'quiet';
  const running = f.save.click(); await f.save.click();
  assert.equal(f.calls.filter(([, options]) => options.method === 'PUT').length, 1);
  finish({ok:false, detail:'Could not save mode.'}); await running;
  assert.equal(f.select.value, 'balanced'); assert.equal(f.save.disabled, false);
  assert.match(allText(f.details), /Could not save mode.*No automatic retry/s);
  assert.doesNotMatch(allText(f.details), /Saved host mode: quiet/);
});

test('locking clears warning details and ignores late settings responses', async () => {
  let finish;
  const f = narratorFixture(() => new Promise(resolve => finish = resolve));
  f.details.open = true; const pending = f.refresh();
  f.events['tli-session-locked'].forEach(fn => fn());
  finish({ok:true, scope:'host', mode:'quiet', narrator:{explanations:[{why:'PRIVATE OLD WARNING', clears_when:'Later'}]}});
  await pending;
  assert.equal(f.details.open, false); assert.equal(f.select.value, '');
  assert.doesNotMatch(allText(f.details), /PRIVATE OLD WARNING|Current host mode: quiet/);
});

function setupFeed(handler=async () => ({ok:true})) {
  const nodes = {'nd-feed':element(), 'panel-dashboard2':element()}, events = {}, calls = [], sources = [];
  const ctx = vm.createContext({window:{location:{origin:'http://tli.test'}}, URL, AbortSignal, Date,
    CustomEvent:class {constructor(type, options){this.type = type; this.detail = options.detail;}},
    document:{getElementById:id => nodes[id], createElement:element,
      addEventListener:(name, fn) => events[name] = fn, dispatchEvent:()=>{}},
    MutationObserver:class {observe(){}}, EventSource:class {constructor(){sources.push(this);} close(){}},
    fetch:async (url, options) => {calls.push([url, options]); const body = await handler(); return {ok:body.ok, json:async () => body};}});
  vm.runInContext(interpreterSource, ctx);
  vm.runInContext(feedSource, ctx);
  events.DOMContentLoaded();
  return {nodes, calls, emit:event => sources[0].onmessage({data:JSON.stringify(event)})};
}
test('live feed preserves repeats, nodes and escalation across reconnect IDs', () => {
  const f = setupFeed();
  for (let i=0; i<4; i++) f.emit({id:String(i), title:'Repeated title', level:i===3?'critical':'info',
    node:'host '+i, ts:Date.now()/1000-30, ts_fmt:'<img onerror=attack()>'});
  f.emit({id:'3', title:'Repeated title', ts:Date.now()/1000});
  assert.equal(f.nodes['nd-feed'].children.length, 4);
  assert.match(f.nodes['nd-feed'].children[0].innerHTML, /🔴/);
  assert.match(f.nodes['nd-feed'].children[0].innerHTML, /host 3/);
  assert.doesNotMatch(f.nodes['nd-feed'].children[0].innerHTML, /<img/);
});
test('feed action failure stays retryable and duplicate submissions execute once', async () => {
  let finish;
  const f = setupFeed(() => new Promise(resolve => finish = resolve));
  f.emit({id:'action', title:'An alert', ts:Date.now()/1000,
    actions:[{label:'Dismiss', endpoint:'/status/alerts/example/dismiss'}]});
  const button = f.nodes['nd-feed'].children[0].children[0].children[0];
  const first = button.click(); await button.click();
  assert.equal(f.calls.length, 1);
  finish({ok:false}); await first;
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /Failed/);
});
