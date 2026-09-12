const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/ai-source.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let now = 100000, handler = async () => ({ ok: true, json: async () => ({}) });
  const calls = [], events = {}, timers = new Map(), nodes = {};
  let timerID = 0;
  for (const id of ['ai-source-pill', 'ai-source-text', 'ai-source-badge', 'ai-manage-btn']) {
    const classes = new Set();
    nodes[id] = { textContent: '', title: '', addEventListener() {},
      classList: { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value) } };
  }
  const window = { addEventListener: (event, fn) => (events[event] ||= []).push(fn), setInterval() {} };
  const context = vm.createContext({ window, document: { readyState: 'loading', getElementById: id => nodes[id], addEventListener: (event, fn) => (events[event] ||= []).push(fn) },
    Date: { now: () => now }, AbortController, Set, Promise, Number,
    AI_POLICY: 'AUTO', AIStatus: { local: { available: false, health: 'unknown', lastCheckedMs: 0 }, lan: { available: false, lastCheckedMs: 0, nodes: [] } },
    resolveIntelligenceRoute: async () => ({ source: 'none' }),
    fetch: async (url, options) => { calls.push({ url, options }); return handler(url, options); },
    setTimeout(fn, ms) { const id = ++timerID; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return { window, context, nodes, calls, events, timers,
    setHandler(fn) { handler = fn; },
    json(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data }; },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await tick(); },
    setHealthy(healthy) { handler = async url => ({ ok: true, json: async () => url.endsWith('/model/info') ? { exists: true, healthy } : url.endsWith('/mesh/status') ? { available: false, source: 'none', peer: null } : { healthy, model_exists: true } }); },
  };
}

test('confirmed bundled runtime stays Ready in both displays when the older router returns NONE', async () => {
  const f = fixture(); f.setHealthy(true);
  await f.window.TLIAISource.refresh(); await tick();
  assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Integrated');
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Integrated · Ready');
  f.window.TLIAISource.renderRoute({ source: 'none', reason: 'No LM Studio or LAN host' });
  assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Integrated');
  assert.equal(f.window.__tliActiveAISource, 'bundled');
});

test('empty and unavailable probes remain unknown instead of reporting Off or a missing model', async () => {
  const f = fixture();
  await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Not confirmed');
  assert.equal(f.window.__tliBundledStatus.statusKnown, false);
  assert.equal(f.window.__tliBundledStatus.model_exists, null);
  assert.doesNotMatch(f.nodes['ai-source-pill'].title, /no model|not installed|\bno\b.*providers/i);
  f.setHandler(async () => f.json({}, 503)); await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Not confirmed');
});

test('explicit model info health works on older servers without bundled status', async () => {
  const f = fixture();
  f.setHandler(async url => url.endsWith('/model/info') ? f.json({ exists: true, healthy: true }) : f.json({}, 404));
  await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Integrated · Ready');
});

test('installed files never imply a running model and explicit failed health clears Ready', async () => {
  const f = fixture(); f.setHealthy(true); await f.window.TLIAISource.refresh();
  f.setHealthy(false); await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Unavailable');
  assert.doesNotMatch(f.nodes['ai-source-badge'].textContent, /Ready|starting/i);
  f.setHandler(async url => f.json(url.endsWith('/model/info') ? { exists: true } : {}));
  await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Not confirmed');
  assert.match(f.nodes['ai-source-pill'].title, /installed.*not been confirmed/);
});

test('availability follows strict provider policy and mesh availability is not presented as a routed answer', async () => {
  const f = fixture();
  f.context.AI_POLICY = 'LOCAL_ONLY';
  f.setHandler(async url => f.json(url.endsWith('/mesh/status') ? { available: true, source: 'mesh', peer: { name: 'Office', ip: '192.0.2.5' } } : { healthy: false, exists: false }));
  await f.window.TLIAISource.refresh();
  assert.doesNotMatch(f.nodes['ai-source-badge'].textContent, /Mesh|Ready/);
  f.context.AI_POLICY = 'LAN_ONLY'; f.window.TLIAISource.renderRoute({ source: 'none' });
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Mesh · Ready');
  assert.match(f.nodes['ai-source-pill'].title, /available on Office/);
  assert.doesNotMatch(f.nodes['ai-source-pill'].title, /routed to|using Office/i);
  f.setHealthy(true); await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Not confirmed');
  assert.match(f.nodes['ai-source-pill'].title, /LAN-only/);
});

test('fresh LM Studio route facts remain supported; stale checks cannot keep Ready', async () => {
  const f = fixture();
  f.context.AIStatus.local = { available: true, health: 'ok', provider: 'lmstudio', lastCheckedMs: 100000 };
  f.context.resolveIntelligenceRoute = async () => ({ source: 'local_llm' });
  await f.window.TLIAISource.refresh(); await tick();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: LM Studio · Ready');
  assert.equal(f.window.__tliActiveAISource, 'lmstudio');
  await f.advance(30001); f.window.TLIAISource.renderRoute();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Not confirmed');
  assert.match(f.nodes['ai-source-pill'].title, /30 seconds/);
});

test('duplicate refreshes share a poll and a slow route never blocks bundled health', async () => {
  const f = fixture(); let release;
  f.context.resolveIntelligenceRoute = () => new Promise(() => {});
  f.setHandler(async url => url.endsWith('/model/info') ? new Promise(resolve => { release = () => resolve(f.json({ exists: true })); }) : f.json({ healthy: true, available: false }));
  const first = f.window.TLIAISource.refresh(); const second = f.window.TLIAISource.refresh({ force: true });
  assert.equal(first, second); assert.equal(f.calls.length, 3);
  release(); await first;
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Integrated · Ready');
});

test('hanging fetches are bounded and aborted, then a later successful poll recovers', async () => {
  const f = fixture(); f.setHandler(() => new Promise(() => {}));
  const pending = f.window.TLIAISource.refresh();
  await f.advance(3000); await f.advance(3000); await pending;
  assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Not confirmed');
  assert.ok(f.calls.every(call => call.options.signal.aborted));
  f.setHealthy(true); await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Integrated · Ready');
});

test('locked sessions invalidate pending checks and never restore stale provider labels', async () => {
  const f = fixture(); let release;
  f.setHandler(async url => url.endsWith('/model/info') ? new Promise(resolve => { release = () => resolve(f.json({ exists: true, healthy: true })); }) : f.json({ healthy: true }));
  const pending = f.window.TLIAISource.refresh();
  f.events['tli-session-locked'].forEach(fn => fn());
  release(); await pending;
  assert.equal(f.window.__tliBundledStatus, null);
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Check access');
  f.window.__tliSetAIPill('Mesh AI · Private name', 'ok', 'Answer source');
  assert.equal(f.nodes['ai-source-text'].textContent, 'AI: Check access');
});

test('actual answer-source updates keep header and Chat together; access failures are actionable', async () => {
  const f = fixture();
  f.window.__tliSetAIPill('Mesh AI · Office', 'ok', 'This answer came from Office');
  assert.equal(f.nodes['ai-source-text'].textContent, 'Mesh AI · Office');
  assert.equal(f.nodes['ai-source-badge'].textContent, 'Mesh AI · Office · Ready');
  f.setHandler(async () => f.json({}, 401)); await f.window.TLIAISource.refresh();
  assert.equal(f.nodes['ai-source-badge'].textContent, 'AI: Check access');
  assert.match(f.nodes['ai-source-pill'].title, /Unlock TLI/);
  assert.equal(f.calls.length, 3);
});
