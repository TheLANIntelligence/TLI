const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const interpreter = fs.readFileSync(path.join(__dirname, '../js/event_interpreter.js'), 'utf8');
const feed = fs.readFileSync(path.join(__dirname, '../js/live-feed.js'), 'utf8');

function fixture({hidden = false} = {}) {
  const sources = [], timers = new Map(), handlers = {}, dispatched = [];
  let nextTimer = 1;
  const on = (name, fn) => (handlers[name] ||= []).push(fn);
  const document = {hidden, addEventListener:on, getElementById:() => null,
    dispatchEvent:event => dispatched.push(event)};
  const window = {addEventListener:on};
  class Source {
    constructor(url) {this.url = url; this.closed = false; sources.push(this);}
    close() {this.closed = true;}
    emit(value) {this.onmessage({data:JSON.stringify(value)});}
  }
  const context = vm.createContext({window, document, CustomEvent, EventSource:Source,
    setTimeout:(fn, delay) => {const id = nextTimer++; timers.set(id, {fn, delay}); return id;},
    clearTimeout:id => timers.delete(id)});
  vm.runInContext(interpreter, context);
  return {window, document, sources, timers, dispatched, api:window.EventInterpreter,
    event:name => {for (const fn of handlers[name] || []) fn();},
    loadFeed:() => {vm.runInContext(feed, context); for (const fn of handlers.DOMContentLoaded || []) fn();},
    retry:() => {const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn();}};
}

test('activity and metric subscribers use one connection and retain both event contracts', () => {
  const f = fixture(), metrics = [], activity = [];
  f.api.on('state_update', value => metrics.push(value));
  f.api.on('classified_event', value => activity.push(value));
  f.api.init();
  f.loadFeed();
  f.api.init();
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].url, '/api/events/stream');
  f.sources[0].emit({type:'state_update', ts:1234, payload:{cpu_pct:37}});
  assert.equal(metrics[0].cpu_pct, 37);
  assert.equal(metrics[0].ts, 1234);
  f.sources[0].emit({id:'activity', title:'Device changed', category:'device', level:'info'});
  assert.equal(activity.length, 1);
  assert.equal(activity[0]._classified.category, 'device');
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].type, 'tli-activity-event');
  assert.equal(f.dispatched[0].detail.id, 'activity');
});

test('hidden tabs release their connection and reconnect once when visible', () => {
  const f = fixture({hidden:true}), received = [];
  f.api.on('classified_event', event => received.push(event));
  f.api.init();
  assert.equal(f.sources.length, 0);
  f.document.hidden = false; f.event('visibilitychange');
  const first = f.sources[0];
  first.emit({title:'Visible event'});
  f.document.hidden = true; f.event('visibilitychange');
  assert.equal(first.closed, true);
  first.emit({title:'Queued stale event'});
  assert.equal(received.length, 1);
  f.document.hidden = false; f.event('visibilitychange'); f.api.init();
  assert.equal(f.sources.length, 2);
  first.onerror();
  assert.equal(f.sources[1].closed, false);
  assert.equal(f.timers.size, 0);
  f.sources[1].emit({title:'Fresh event'});
  assert.equal(received.length, 2);
});

test('session lock closes the stream, cancels retries and rejects late events until unlock', () => {
  const f = fixture(), received = [];
  f.api.on('classified_event', event => received.push(event)); f.api.init();
  const first = f.sources[0]; first.emit({title:'Before lock'}); first.onerror();
  assert.equal(f.timers.size, 1);
  f.event('tli-session-locked');
  assert.equal(f.timers.size, 0);
  assert.equal(f.api.getLastEvent(), null);
  f.api.init(); f.event('visibilitychange');
  assert.equal(f.sources.length, 1);
  first.emit({title:'Late private event'});
  assert.equal(received.length, 1);
  f.event('tli-session-unlocked'); f.event('tli-session-unlocked');
  assert.equal(f.sources.length, 2);
  f.sources[1].emit({title:'After unlock'});
  assert.equal(received.length, 2);
});

test('one retry survives repeated init and obsolete stream callbacks cannot close its replacement', () => {
  const f = fixture(); f.api.init(); const first = f.sources[0];
  first.onerror(); first.onerror(); f.api.init();
  assert.equal(first.closed, true); assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 5000);
  assert.equal(f.sources.length, 1);
  f.retry(); assert.equal(f.sources.length, 2); assert.equal(f.timers.size, 0);
  first.onerror(); assert.equal(f.sources[1].closed, false); assert.equal(f.timers.size, 0);
  f.sources[1].onerror(); f.document.hidden = true; f.event('visibilitychange');
  assert.equal(f.timers.size, 0);
});

test('page cache suspension releases sockets and resumes delivery on return', () => {
  const f = fixture(); f.api.init(); f.event('pagehide');
  assert.equal(f.sources[0].closed, true);
  f.api.init(); assert.equal(f.sources.length, 1);
  f.event('pageshow'); assert.equal(f.sources.length, 2);
});
