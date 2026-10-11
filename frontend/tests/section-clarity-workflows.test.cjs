const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../js', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const reply = (data, status = 200) => ({ok: status >= 200 && status < 300, status, headers: {get: () => 'application/json'}, json: async () => data});
const png = () => new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0])], {type: 'image/png'});
const tokenA = 'a'.repeat(32), tokenB = 'b'.repeat(32);

function fixture(script = 'files.js') {
  const nodes = {}, calls = [], events = {}, documentEvents = {}, revoked = [], toasts = [];
  let handler = async () => reply({ok: true}), url = 0;
  function element(id) {
    return nodes[id] ||= {id, value: '', textContent: '', src: '', hidden: false, disabled: false, attributes: {}, dataset: {}, style: {},
      classList: {add(){}, remove(){}, toggle(){}}, setAttribute(key, value) {this.attributes[key] = value;},
      removeAttribute(key) {delete this.attributes[key];}, addEventListener(){}, querySelector() {return null;}, click(){}};
  }
  ['filesRootInput', 'filesRulesTextarea', 'filesRulesSummary', 'filesInsightBox', 'filesCustomRulesButton', 'filesInsightButton', 'filesStatus',
    'ps-scanner-select', 'ps-scan-btn', 'ps-preview-wrap', 'ps-preview-img', 'ps-scan-status', 'ps-test-print-btn', 'ps-print-status',
    'devices-printers-status', 'devices-printers-summary'].forEach(element);
  nodes['filesRootInput'].value = 'C:\\Synthetic'; nodes['filesRulesTextarea'].value = 'Group photos';
  nodes['ps-scanner-select'].value = 'synthetic-scanner';
  const context = vm.createContext({console: {log(){}, warn(){}, debug(){}, error(){}}, Date, Blob, Uint8Array, FormData, Map,
    URL: {createObjectURL: () => `blob:synthetic-${++url}`, revokeObjectURL: value => revoked.push(value)},
    $: id => nodes[id] || null, showToast: (...args) => toasts.push(args), debugLog(){},
    document: {readyState: 'loading', getElementById: id => nodes[id] || null, createElement: () => element('created'),
      querySelector: () => null, querySelectorAll: () => [], addEventListener: (name, fn) => (documentEvents[name] ||= []).push(fn)},
    fetch: async (url, options = {}) => { calls.push({url, method: options.method || 'GET'}); return handler(url, options); },
    setTimeout(){}, clearTimeout(){}, setInterval(){}, clearInterval(){},
    addEventListener: (name, fn) => (events[name] ||= []).push(fn)
  });
  context.window = context;
  vm.runInContext(read(script), context);
  return {context, nodes, calls, revoked, toasts, documentEvents, handler: fn => {handler = fn;},
    emit: name => (events[name] || []).forEach(fn => fn()), eval: code => vm.runInContext(code, context)};
}

test('printer module never intercepts another panel’s Discover or Add Printer button text', async () => {
  const f = fixture('printers-ext.js');
  for (const textContent of ['Discover', 'Add Printer']) {
    const button = {textContent, closest: selector => selector.includes('button') ? button : null};
    for (const handler of f.documentEvents.click || []) await handler({target: button, preventDefault() {}});
  }
  assert.deepEqual(f.calls, []);
});

test('one pending printer request is shared by duplicate invocations and returns confirmed results', async () => {
  const f = fixture('printers-ext.js'), pending = deferred(); f.handler(() => pending.promise);
  const first = f.context.testPrint(), second = f.context.testPrint();
  assert.equal(first, second); await tick(); assert.equal(f.calls.length, 1);
  pending.resolve(reply({ok: true, printer: 'Synthetic default'}));
  assert.equal((await first).ok, true);
  assert.equal(f.toasts.length, 1); assert.match(f.toasts[0][0], /submitted.*physical output/);
});

test('HTTP failure, application failure and unconfirmed printer results cannot produce success or retry', async () => {
  for (const response of [reply({ok: false, message: 'unavailable'}, 500), reply({ok: false}), reply({})]) {
    const f = fixture('printers-ext.js'); f.handler(async () => response);
    assert.equal((await f.context.openAddPrinter()).ok, false);
    assert.equal(f.calls.length, 1); assert.equal(f.nodes['devices-printers-status'].textContent, 'Failed');
    assert.match(f.toasts[0][0], /Could not open printer settings/);
  }
});

test('printer compatibility retries only a rejected method; lock prevents a queued launch', async () => {
  const f = fixture('printers-ext.js'); f.handler(async (_url, opts) => opts.method === 'POST' ? reply({}, 405) : reply({ok: true}));
  assert.equal((await f.context.openScan()).ok, true); assert.deepEqual(f.calls.map(x => x.method), ['POST', 'GET']);
  const g = fixture('printers-ext.js'); const pending = g.context.testPrint(); g.emit('tli-session-locked');
  assert.equal((await pending).ok, false); assert.deepEqual(g.calls, []);
});

test('Print & Scan does not claim successful submission when the printer handler reports failure', async () => {
  const f = fixture(); f.context.testPrint = async () => ({ok: false, message: 'Printer is unavailable'});
  await f.context.psTestPrint(); assert.match(f.nodes['ps-print-status'].textContent, /Test print failed.*unavailable/);
  assert.equal(f.nodes['ps-print-status'].className, 'ps-status ps-status-error');
});

test('document printing guards duplicate submissions and rejects HTTP success without a sent receipt', async () => {
  const f=fixture(), pending=deferred();
  f.nodes['ps-printer-select']={value:'Synthetic printer'};
  f.eval('_psPrintFile = new Blob(["Synthetic print document"], {type:"text/plain"})');
  f.handler(()=>pending.promise);
  const first=f.context.psSendPrint(); assert.equal((await f.context.psSendPrint()).busy,true);
  pending.resolve(reply({ok:true})); assert.equal((await first).ok,false);
  assert.equal(f.calls.length,1); assert.match(f.nodes['ps-print-status'].textContent,/did not confirm print-job submission/);
  f.handler(async()=>reply({status:'sent',printer:'Synthetic printer',copies:1,orientation:'portrait',scale:100}));
  assert.equal((await f.context.psSendPrint()).ok,true); assert.match(f.nodes['ps-print-status'].textContent,/Check the printer for physical output/);
});

async function existingScan(f) {
  f.handler(async url => url === '/printshop/scan' ? reply({status: 'ok', token: tokenA}) : {ok: true, blob: async () => png()});
  assert.equal((await f.context.psTriggerScan()).ok, true);
  return f.nodes['ps-preview-img'].src;
}

test('failed replacement scan retains the previous preview and downloadable blob without deleting it', async () => {
  const f = fixture(), oldUrl = await existingScan(f); f.calls.length = 0;
  f.handler(async () => reply({detail: 'Scanner disconnected'}, 503));
  assert.equal((await f.context.psTriggerScan()).ok, false);
  assert.equal(f.nodes['ps-preview-img'].src, oldUrl); assert.equal(f.nodes['ps-preview-wrap'].hidden, false);
  assert.equal(f.eval('_psScanToken'), tokenA); assert.ok(f.eval('_psScanBlob'));
  assert.deepEqual(f.calls.map(x => x.method), ['POST']); assert.match(f.nodes['ps-scan-status'].textContent, /previous scan is unchanged/);
});

test('failed image retrieval cleans only its owned candidate; successful replacement deletes old scan only after retrieval', async () => {
  const f = fixture(), oldUrl = await existingScan(f); f.calls.length = 0;
  f.handler(async (url, opts) => opts.method === 'POST' ? reply({status: 'ok', token: tokenB}) : opts.method === 'DELETE' ? reply({status:'deleted'}) : reply({}, 404));
  await f.context.psTriggerScan();
  assert.equal(f.nodes['ps-preview-img'].src, oldUrl);
  assert.deepEqual(f.calls.filter(x => x.method === 'DELETE').map(x => x.url), [`/printshop/scan/${tokenB}`]);
  f.calls.length = 0;
  const image = deferred();
  f.handler(async (url, opts) => opts.method === 'POST' ? reply({status:'ok', token:tokenB}) : opts.method === 'DELETE' ? reply({status:'deleted'}) : image.promise);
  const pending = f.context.psTriggerScan(); await tick();
  assert.equal(f.nodes['ps-preview-img'].src, oldUrl); assert.equal(f.calls.some(x => x.method === 'DELETE'), false);
  image.resolve({ok:true, blob:async()=>png()}); assert.equal((await pending).ok, true);
  assert.equal(f.eval('_psScanToken'), tokenB); assert.ok(f.revoked.includes(oldUrl));
  assert.deepEqual(f.calls.filter(x=>x.method === 'DELETE').map(x=>x.url), [`/printshop/scan/${tokenA}`]);
});

test('duplicate scan requests cannot start a second scanner job and a cleared preview cannot be repopulated by late work', async () => {
  const f = fixture(), pending = deferred(); f.handler(async (_url, opts) => opts.method === 'POST' ? pending.promise : reply({status:'deleted'}));
  const first = f.context.psTriggerScan(); assert.equal((await f.context.psTriggerScan()).busy, true);
  f.context.psClearScanPreview(); pending.resolve(reply({status:'ok', token:tokenB}));
  assert.equal((await first).discarded, true); assert.equal(f.eval('_psScanBlob'), null);
  assert.equal(f.calls.filter(x=>x.method === 'POST').length, 1);
  assert.deepEqual(f.calls.filter(x=>x.method === 'DELETE').map(x=>x.url), [`/printshop/scan/${tokenB}`]);
});

test('a malformed scan token is never fetched or deleted and a non-image candidate cannot replace a scan', async () => {
  const f=fixture(), oldUrl=await existingScan(f); f.calls.length=0;
  f.handler(async()=>reply({status:'ok',token:'../private'})); await f.context.psTriggerScan();
  assert.equal(f.calls.length,1); assert.equal(f.nodes['ps-preview-img'].src,oldUrl);
  f.calls.length=0;
  f.handler(async(_url,opts)=>opts.method==='POST'?reply({status:'ok',token:tokenB}):opts.method==='DELETE'?reply({}):{ok:true,blob:async()=>new Blob(['failed'],{type:'text/html'})});
  await f.context.psTriggerScan(); assert.equal(f.nodes['ps-preview-img'].src,oldUrl);
  assert.equal(f.eval('_psScanToken'),tokenA);
});

test('AI organization requests return suggestions without editing the file plan; failures preserve previous advice', async () => {
  const f = fixture(); f.eval('filesBucketDestinations={Images:"Photos"}; filesDraftRevision=7');
  f.handler(async()=>reply({summary:'Consider organizing photos by year.'}));
  assert.equal((await f.context.filesUseCustomRules()).ok,true);
  const prior=f.nodes['filesRulesSummary'].textContent; assert.match(prior,/Folder: C:\\Synthetic/);
  assert.match(f.nodes.filesStatus.textContent,/edit the destination categories yourself/);
  assert.equal(f.eval('filesDraftRevision'),7); assert.equal(f.eval('filesBucketDestinations.Images'),'Photos');
  for(const response of [reply({summary:''}),reply({ok:false,summary:'not usable'}),reply({},503)]) {
    f.handler(async()=>response); assert.equal((await f.context.filesUseCustomRules()).ok,false);
    assert.equal(f.nodes['filesRulesSummary'].textContent,prior); assert.match(f.nodes.filesStatus.textContent,/unchanged/);
  }
});

test('AI request duplication, changed targets and session lock do not replace advice with an obsolete response', async () => {
  const f=fixture(), pending=deferred(); f.nodes.filesInsightBox.textContent='Prior folder advice'; f.handler(()=>pending.promise);
  const first=f.context.filesAskAiAboutFolder(); assert.equal((await f.context.filesAskAiAboutFolder()).busy,true);
  f.nodes.filesRootInput.value='D:\\Another'; pending.resolve(reply({summary:'Obsolete'}));
  assert.equal((await first).stale,true); assert.equal(f.nodes.filesInsightBox.textContent,'Prior folder advice');
  assert.equal(f.calls.length,1);
  const second=deferred(); f.handler(()=>second.promise); const work=f.context.filesAskAiAboutFolder();
  f.eval('filesPrivateEpoch++'); f.nodes.filesInsightBox.textContent=''; second.resolve(reply({summary:'Private old result'}));
  await work; assert.equal(f.nodes.filesInsightBox.textContent,'');
});
