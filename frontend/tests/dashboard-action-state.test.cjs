const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/system-state-bar.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const action = {id:'synthetic-action', title:'Review synthetic storage', context:'Synthetic fixture only', handler:'review_storage'};
const reply = (data, status = 200) => ({ok:status >= 200 && status < 300, status, json:async () => data, clone(){return this;}});

// Run the actual controller with bounded I/O and a minimal, replacing DOM.
// No initialization, timers, server processes or persistent stores are started.
function fixture({intercepted=false,pinOff=false,monitoring=false} = {}) {
  const nodes = new Map(), events = new Map(), subscriptions = new Map(), calls = [], navigations = [];
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  let respond = async url => url === '/dashboard/action/current' ? reply(null) : reply({ok:true, receipt:{narrator_msg:'Review completed.'}});
  function element() {
    const node = {dataset:{}, attrs:{}, hidden:false, disabled:false, listeners:{}, children:[],
      classList:{toggle() {}}, setAttribute(name, value) {this.attrs[name] = value;},
      appendChild(child){this.children.push(child);},querySelector(){return null;},
      addEventListener(name, listener) {this.listeners[name] = listener;}, focus() {},
      click() {return this.listeners.click?.();},
      set innerHTML(html) {
        this.html = html;
        for (const child of this.children) nodes.delete(child);
        this.children = [];
        for (const match of html.matchAll(/id="([^"]+)"/g)) {
          this.children.push(match[1]); nodes.set(match[1], element());
        }
      }, get innerHTML() {return this.html || '';},
    };
    Object.defineProperty(node,'id',{set(id){nodes.set(id,this);}});return node;
  }
  const card = element(); nodes.set('nd-action-card', card);
  if(monitoring)nodes.set('tli-state-bar',element());
  const on = (name,listener) => {if(!events.has(name))events.set(name,[]);events.get(name).push(listener);};
  const window = {addEventListener:on, dispatchEvent(event) {for(const fn of events.get(event.type) || [])fn(event);},
    location:{href:'http://localhost/',origin:'http://localhost'}, EventInterpreter:{on:(name,fn)=>subscriptions.set(name,fn)},
    TLIDash2:{openStorage:location => navigations.push(location)}, TLINav:{open:target => navigations.push(target)}};
  const document = {readyState:'loading', addEventListener() {}, createElement:element, getElementById:id => nodes.get(id) || null};
  const context = vm.createContext({console, window, document, AbortSignal, Date:Clock, CustomEvent, URL, Headers,
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    fetch:async (url, options = {}) => {calls.push({url, options}); return respond(url, options);},
  });
  if(intercepted){
    window.fetch=context.fetch;
    if(pinOff)window.TLIPinLock={checkAndLock:()=>Promise.resolve().then(()=>window.dispatchEvent(new CustomEvent('tli-session-unlocked')))};
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/fetch-interceptor.js'),'utf8'),context);
    context.fetch=(...args)=>window.fetch(...args);
  }
  vm.runInContext(source, context);
  const presence = window.TLIPresence;
  presence.renderActionCard({...action});
  return {card, nodes, calls, navigations, presence, context,
    now:() => now, advance(milliseconds) { now += milliseconds; },
    respond(fn) {respond = fn;}, lock() {window.dispatchEvent(new CustomEvent('tli-session-locked'));},
    unlock() {window.dispatchEvent(new CustomEvent('tli-session-unlocked'));},
    recover() {subscriptions.get('access_ready')();},
    monitoringStatus:()=>nodes.get('ssb-monitoring-status')?.textContent || '',
    click(kind = 'confirm') {return nodes.get(`ac-${kind}-btn`).click();},
    posts() {return calls.filter(call => call.options.method === 'POST');},
    runDashboardRefresh() {
      // Execute the real aggregate reader, stubbing presentation only. The
      // shared action owner is the same production instance tested above.
      Object.assign(context, {_viewEpoch:0, _sessionLocked:false, _open:true,
        _lastData:null, _lastRefreshFailed:false, _el:() => null,
        _seedFeed() {}, _refreshMeshStrip() {}, _setVital() {}, _renderObservationSummary() {},
        _renderActions() {}, _renderQuickRead() {}, _renderSuggestions() {}, _feedLog() {}, setEventMessage() {},
      });
      const start = app.indexOf('  async function _refreshOnce()');
      const end = app.indexOf('\n  function _renderObservationSummary()', start);
      assert.ok(start >= 0 && end > start);
      vm.runInContext(app.slice(start, end) + '\nthis.refreshDashboard = _refreshOnce;', context);
      return context.refreshDashboard();
    },
  };
}

for (const kind of ['confirm', 'dismiss']) {
  test(`${kind}: a queue read started before completion cannot resurrect the suggestion or erase its receipt`, async () => {
    const f = fixture(), old = deferred(); let reads = 0;
    f.respond(async url => url === '/dashboard/action/current'
      ? ++reads === 1 ? old.promise : reply(null)
      : reply({ok:true, receipt:{narrator_msg:'Synthetic review completed.'}}));
    const pendingRead = f.presence.fetchActionCurrent();
    assert.equal(await f.click(kind), true);
    assert.equal(f.card.dataset.state, 'completed');
    const receipt = kind === 'dismiss' ? 'Suggestion snoozed. No action was run.' : 'Synthetic review completed.';
    assert.ok(f.card.innerHTML.includes(receipt));
    old.resolve(reply({...action})); await pendingRead; await tick();
    assert.equal(f.card.dataset.state, 'completed');
    assert.ok(f.card.innerHTML.includes(receipt));
    assert.equal(f.nodes.has('ac-confirm-btn'), false);
    assert.equal(reads, 2, 'check the new queue only after the obsolete read finishes');
    assert.equal(f.posts().length, 1);
  });
}

for (const [label, response] of [['failed', reply({detail:'Unavailable'}, 503)], ['malformed', reply({ok:true, title:'Missing action identity'})]]) {
  test(`${label} suggestion refresh retains the previous reviewable action and explains failure`, async () => {
    const f = fixture(); f.respond(async () => response);
    assert.equal(await f.presence.fetchActionCurrent(), false);
    assert.ok(f.card.innerHTML.includes(action.title));
    assert.ok(f.card.innerHTML.includes('previous suggestion is retained'));
    assert.equal(f.card.dataset.state, 'unavailable');
    assert.equal(f.nodes.get('ac-confirm-btn').disabled, false);
    assert.equal(f.posts().length, 0);
  });
}

test('locking in the click turn cancels an unsent action before its queued POST starts', async () => {
  const f = fixture(), pending = f.click();
  f.lock();
  assert.equal(await pending, false);
  assert.equal(f.posts().length, 0);
  assert.equal(f.card.hidden, true);
  assert.equal(f.nodes.has('ac-confirm-btn'), false);
  assert.equal(f.navigations.length, 0);
});

function diskAction(f) {
  const now = f.now() / 1000;
  return {id:'disk-action', kind:'disk_observation', handler:'open_visualizer:L:\\', server_time:now,
    target:{kind:'drive',host_id:'synthetic-host',host_name:'Synthetic host',id:'l:\\',path:'L:\\'},
    observation:{id:'observation-1',host_id:'synthetic-host',target_id:'l:\\',scope:'host_drive',
      metric:'disk_percent',value:99,observed_at:now,expires_at:now + 30},
  };
}

test('drive card shows exact recorded host, target, value and time independently', () => {
  const f = fixture(); f.presence.renderActionCard(diskAction(f));
  for (const label of ['Recorded suggestion', 'Synthetic host', 'L:\\', '99% used', 'observed', 'Independent recorded suggestion']) {
    assert.ok(f.card.innerHTML.includes(label), label);
  }
  assert.equal(f.nodes.get('ac-confirm-btn').disabled, false);
  assert.equal(f.posts().length, 0);
});

test('expired drive card cannot post even when its stale button was retained', async () => {
  const f = fixture(); f.presence.renderActionCard(diskAction(f));
  const button = f.nodes.get('ac-confirm-btn');
  f.advance(30000);
  assert.equal(await button.click(), false);
  assert.equal(f.posts().length, 0);
  assert.ok(f.card.innerHTML.includes('reading expired'));
  assert.equal(f.nodes.get('ac-confirm-btn').disabled, true);
});

test('drive evidence expiry between click and queued request prevents submission', async () => {
  const f = fixture(); f.presence.renderActionCard(diskAction(f));
  const pending = f.click(); f.advance(30000);
  assert.equal(await pending, false);
  assert.equal(f.posts().length, 0);
});

for (const field of ['target path', 'observation target', 'observation host', 'unknown time', 'invalid value']) {
  test(`mismatched drive evidence (${field}) cannot navigate or submit`, async () => {
    const f = fixture(), record = diskAction(f);
    if (field === 'target path') record.target.path = 'C:\\';
    if (field === 'observation target') record.observation.target_id = 'c:\\';
    if (field === 'observation host') record.observation.host_id = 'other-host';
    if (field === 'unknown time') delete record.observation.observed_at;
    if (field === 'invalid value') record.observation.value = true;
    f.presence.renderActionCard(record);
    assert.equal(f.nodes.get('ac-confirm-btn').disabled, true);
    assert.equal(await f.click(), false);
    assert.equal(f.posts().length, 0);
    assert.equal(f.navigations.length, 0);
    assert.ok(f.card.innerHTML.includes('could not be verified'));
  });
}

test('failed drive refresh keeps recorded evidence but cannot extend its expiry', async () => {
  const f = fixture(); f.presence.renderActionCard(diskAction(f));
  f.advance(30000); f.respond(async () => reply({}, 503));
  assert.equal(await f.presence.fetchActionCurrent(), false);
  assert.equal(f.nodes.get('ac-confirm-btn').disabled, true);
  assert.ok(f.card.innerHTML.includes('reading expired'));
  assert.equal(f.posts().length, 0);
});

test('a successful response naming another drive does not navigate or claim completion', async () => {
  const f = fixture(); f.presence.renderActionCard(diskAction(f));
  f.respond(async () => reply({ok:true,receipt:{navigate_to:'panel-visualizer',scan_path:'C:\\'}}));
  assert.equal(await f.click(), false);
  assert.equal(f.navigations.length, 0);
  assert.equal(f.card.dataset.state, 'failed');
  assert.ok(f.card.innerHTML.includes('does not match the reviewed drive'));
});

test('only accepted current command-center identity is forwarded to the shared identity owner', () => {
  const f = fixture(), identities = [];
  f.context.window.TLIUI = {hostIdentity:{observe:row => identities.push(row)}};
  const payload = {node:{id:'host-a',name:'Synthetic host'},ts:1000,state:{probed_ts:1000}};
  f.presence.acceptSnapshot(payload);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].observedAt, 1000000);
  f.presence.acceptSnapshot({...payload, node:{id:'host-old',name:'Older host'}, state:{probed_ts:999}});
  assert.equal(identities.length, 1);
  f.lock(); f.presence.acceptSnapshot({...payload,ts:1001,state:{probed_ts:1001}});
  assert.equal(identities.length, 1);
});

test('duplicate confirmation shares one pending operation and one reviewed target', async () => {
  const f = fixture(), result = deferred();
  f.respond(async (url, options) => options.method === 'POST' ? result.promise : reply(null));
  const button = f.nodes.get('ac-confirm-btn');
  const first = button.click(), duplicate = button.click();
  assert.equal(first, duplicate);
  await tick(); assert.equal(f.posts().length, 1);
  assert.equal(f.nodes.get('ac-confirm-btn').disabled, true);
  assert.deepEqual(JSON.parse(f.posts()[0].options.body), {action_id:action.id});
  result.resolve(reply({ok:true, receipt:{narrator_msg:'Review completed.'}}));
  assert.equal(await first, true); await tick();
  assert.equal(f.card.dataset.state, 'completed');
  assert.equal(f.posts().length, 1);
});

test('partial handler failure preserves explicit retry and does not navigate or claim success', async () => {
  const f = fixture(); f.respond(async () => reply({ok:false, receipt:{ok:false,
    narrator_msg:'1 of 2 steps completed; review the failed step before retrying.',
    navigate_to:'panel-visualizer', scan_path:'S:\\', results:[{ok:true}, {ok:false}],
  }}));
  assert.equal(await f.click(), false); await tick();
  assert.equal(f.card.dataset.state, 'failed');
  assert.ok(f.card.innerHTML.includes('1 of 2 steps completed'));
  assert.equal(f.nodes.get('ac-confirm-btn').disabled, false);
  assert.equal(f.navigations.length, 0);
  assert.equal(f.posts().length, 1, 'no automatic retry');
});

test('a delayed aggregate Dashboard response cannot restore an action dismissed since that request began', async () => {
  const f = fixture(), aggregate = deferred();
  f.respond(async (url, options) => url === '/dashboard/command-center' ? aggregate.promise
    : options.method === 'POST' ? reply({ok:true, receipt:{}}) : reply(null));
  const refresh = f.runDashboardRefresh();
  assert.equal(await f.click('dismiss'), true); await tick();
  aggregate.resolve(reply({ok:true, current_action:{...action}, nickname:'Synthetic host', activeAlerts:[]}));
  await refresh; await tick();
  assert.equal(f.nodes.has('ac-confirm-btn'), false);
  assert.equal(f.card.dataset.state, 'completed');
  assert.ok(f.card.innerHTML.includes('Suggestion snoozed. No action was run.'));
  assert.ok(f.calls.filter(call => call.url === '/dashboard/action/current').length >= 2);
});

test('legacy Dashboard fallback does not treat missing action data as an empty queue', async () => {
  const f = fixture();
  f.respond(async url => url === '/dashboard/command-center' ? reply({}, 503)
    : url === '/dashboard/action/current' ? reply({}, 503)
    : url === '/status' ? reply({device_nickname:'Synthetic host',model_online:false,node_role:'standalone',mesh_status:'unpaired'})
    : url === '/api/system/disk' ? reply({ok:true,system:{pct:25,mount:'C:\\'}})
    : url === '/status/alerts' ? reply({alerts:[]}) : reply(null));
  await f.runDashboardRefresh(); await tick();
  assert.ok(f.card.innerHTML.includes(action.title));
  assert.ok(f.card.innerHTML.includes('previous suggestion is retained'));
  assert.equal(f.nodes.get('ac-confirm-btn').disabled, false);
  assert.equal(f.posts().length, 0);
});

for(const kind of ['confirm','secondary','dismiss'])for(const status of [401,403]){
  test(`${kind} ${status} clears the action and private receipt, then waits for explicit authorized recovery`,async()=>{
    const f=fixture({monitoring:true});f.presence.renderActionCard({...action,secondary_label:'Secondary action'});
    const oldButton=f.nodes.get(`ac-${kind}-btn`);
    f.respond(async()=>reply({detail:'Use this host’s authorized browser.',receipt:{narrator_msg:'PRIVATE RECEIPT',navigate_to:'private-panel'}},status));
    assert.equal(await oldButton.click(),false);await tick();
    assert.equal(f.card.hidden,true);assert.doesNotMatch(f.card.innerHTML,/PRIVATE RECEIPT|Synthetic fixture|Review synthetic/);
    assert.equal(f.nodes.has('ac-confirm-btn'),false);assert.equal(f.navigations.length,0);
    assert.match(f.monitoringStatus(),/review activity and current status.*may already have run/);
    f.unlock();f.presence.renderActionCard({...action});await oldButton.click();await f.presence.fetchActionCurrent();
    assert.equal(f.calls.length,1);assert.equal(f.posts()[0].url,`/dashboard/action/${kind}`);
    assert.equal(f.card.hidden,true);
  });
}

for(const status of [401,403])test(`a non-JSON ${status} response still clears private actions before parsing failure handling`,async()=>{
  const f=fixture({monitoring:true});
  f.respond(async()=>({...reply(null,status),json:async()=>{throw new SyntaxError('not JSON');}}));
  assert.equal(await f.click(),false);assert.equal(f.card.hidden,true);assert.equal(f.posts().length,1);
  assert.match(f.monitoringStatus(),/Unlock TLI.*may already have run/);
  assert.doesNotMatch(f.card.innerHTML,/Synthetic fixture|Review synthetic/);
});

test('a revoked POST through the real interceptor with PIN off cannot repeat, navigate, or retain its private receipt',async()=>{
  const f=fixture({intercepted:true,pinOff:true,monitoring:true});
  f.respond(async()=>reply({detail:'Clear this site’s cookies or use a new private window on localhost.',receipt:{narrator_msg:'PRIVATE RESULT'}},401));
  assert.equal(await f.click(),false);await tick();
  assert.equal(f.card.hidden,true);assert.doesNotMatch(f.card.innerHTML,/PRIVATE RESULT/);
  assert.match(f.monitoringStatus(),/cookies.*may already have run/);
  await f.presence.fetchActionCurrent();f.unlock();await tick();assert.equal(f.calls.length,1);assert.equal(f.navigations.length,0);
});

for(const status of [200,401,403])test(`late action ${status} from a prior session cannot overwrite fresh observations or navigate`,async()=>{
  const f=fixture({intercepted:true,monitoring:true}),late=deferred();f.respond(()=>late.promise);
  const work=f.click();await tick();f.lock();f.unlock();
  f.presence.acceptSnapshot({ok:true,ts:2000,state:{probed_ts:2000,cpu_pct:12},smart_home:{count:1,names:['Fresh session device']}});
  const currentStatus=f.monitoringStatus();
  late.resolve(reply({ok:true,detail:'Old session revoked',receipt:{ok:true,narrator_msg:'PRIVATE OLD RECEIPT',navigate_to:'private-panel'}},status));
  assert.equal(await work,false);await tick();
  assert.equal(f.calls.length,1);assert.equal(f.navigations.length,0);assert.equal(f.card.hidden,true);
  assert.equal(f.monitoringStatus(),currentStatus);assert.equal(f.presence.getObservation().devNames[0],'Fresh session device');
  f.presence.renderActionCard({...action,title:'Fresh authorized suggestion'});assert.match(f.card.innerHTML,/Fresh authorized suggestion/);
  assert.doesNotMatch(f.card.innerHTML,/PRIVATE OLD RECEIPT|Old session revoked/);
});

for(const failure of ['network','invalid JSON','unavailable host','unconfirmed body'])test(`${failure} leaves an unknown result and sends no automatic retry`,async()=>{
  const f=fixture();f.respond(async()=>{
    if(failure==='network')throw new Error('Connection lost');
    if(failure==='invalid JSON')return {...reply(null),json:async()=>{throw new SyntaxError('not JSON');}};
    return failure==='unavailable host'?reply({detail:'Unavailable'},503):reply({});
  });
  assert.equal(await f.click(),false);await tick();assert.equal(f.calls.length,1);assert.equal(f.posts().length,1);
  assert.equal(f.card.dataset.state,'unknown');assert.match(f.card.innerHTML,/may have run.*before explicitly retrying/);
  assert.equal(f.navigations.length,0);assert.doesNotMatch(f.card.innerHTML,/Action completed/);
});

test('a successful guarded recovery refreshes observations and suggestions without repeating the denied action',async()=>{
  const f=fixture();f.respond(async()=>reply({detail:'Access revoked.'},403));await f.click();
  f.respond(async url=>url==='/dashboard/action/current'?reply({...action,title:'Fresh action'}):reply({ok:true,ts:2000,state:{probed_ts:2000}}));
  f.recover();await tick();assert.match(f.card.innerHTML,/Fresh action/);assert.equal(f.posts().length,1);
  assert.equal(f.calls.length,3);assert.equal(f.navigations.length,0);
});

test('contradictory successful envelope with a failed receipt cannot claim completion or navigate',async()=>{
  const f=fixture();f.respond(async()=>reply({ok:true,receipt:{ok:false,narrator_msg:'Partial action failure',navigate_to:'private-panel'}}));
  assert.equal(await f.click(),false);assert.equal(f.card.dataset.state,'failed');assert.match(f.card.innerHTML,/Partial action failure/);
  assert.equal(f.posts().length,1);assert.equal(f.navigations.length,0);
});

for(const kind of ['confirm','secondary'])test(`${kind} success without its action receipt remains an unknown outcome`,async()=>{
  const f=fixture();f.presence.renderActionCard({...action,secondary_label:'Secondary action'});f.respond(async()=>reply({ok:true}));
  assert.equal(await f.click(kind),false);assert.equal(f.card.dataset.state,'unknown');
  assert.match(f.card.innerHTML,/may have run/);assert.doesNotMatch(f.card.innerHTML,/Action completed/);
  assert.equal(f.posts().length,1);assert.equal(f.navigations.length,0);
});

for(const status of [401,403])test(`denied ${status} headers clear private actions before the delayed error body arrives`,async()=>{
  const f=fixture({monitoring:true}),body=deferred();
  f.respond(async()=>({...reply(null,status),json:()=>body.promise}));
  const work=f.click();await tick();
  assert.equal(f.card.hidden,true);assert.equal(f.nodes.has('ac-confirm-btn'),false);
  assert.doesNotMatch(f.card.innerHTML,/Synthetic fixture|Review synthetic/);assert.match(f.monitoringStatus(),/may already have run/);
  body.resolve({detail:'Clear browser cookies before continuing.',receipt:{narrator_msg:'PRIVATE DENIED BODY'}});
  assert.equal(await work,false);assert.match(f.monitoringStatus(),/cookies/);assert.equal(f.posts().length,1);
  assert.doesNotMatch(f.card.innerHTML,/PRIVATE DENIED BODY/);
});
