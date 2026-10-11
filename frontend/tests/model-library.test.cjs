const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/ai-model-manager.js'), 'utf8');

function element() {
  const e = {children: [], handlers: {}, textContent: '', style: {},
    classList: {add(){}, remove(){}, toggle(){}}, setAttribute(){},
    appendChild(child){this.children.push(child);},
    addEventListener(name, fn){(this.handlers[name] ||= []).push(fn);},
    querySelector(){return this.actions ||= element();}, querySelectorAll(){return [];},
    click(){return Promise.all((this.handlers.click || []).map(fn => fn({target:this})));}};
  Object.defineProperty(e, 'innerHTML', {get(){return this.html || '';}, set(value){this.html = value; this.children = [];}});
  return e;
}
function preset(changes={}) {
  return {id:'standard', name:'Qwen Standard', installation_complete:true, is_selected:true, running:false,
    compatibility:{state:'compatible', selectable:true, download_allowed:true, reasons:['Estimated resources fit.'], installation:{components:[]}}, ...changes};
}
function setup(presets, handler=async () => ({ok:true})) {
  const nodes = Object.fromEntries(['mm2-tiers','model-manager-progress','model-manager-modal-overlay','model-manager-cancel','model-manager-file','model-manager-select'].map(id => [id, element()]));
  const calls = [];
  const ctx = vm.createContext({window:{}, document:{readyState:'complete', getElementById:id => nodes[id], createElement:element},
    console, setTimeout, FormData: class {append(){}}, fetch:async (url, options={}) => {
      calls.push([url, options]);
      const data = url === '/api/ai/models/presets' ? {presets} : await handler(url, options);
      return {ok:true, status:200, json:async () => data};
    }});
  vm.runInContext(source, ctx);
  return {ctx,nodes,calls, render:() => ctx.window._mm4RenderTierCards()};
}
const buttons = fixture => fixture.nodes['mm2-tiers'].children[0].actions.children.filter(c => c.handlers.click);

test('reference answer validation is distinct from installed verification and runtime health', async()=>{
  const f=setup([preset({running:false,answer_validation:{status:'evaluated_with_limitations',summary:'Mixed answers <review>',case_count:23,evaluated_at:'2026-09-08',conditions:'CPU synthetic',model_sha256:'a'.repeat(64),runtime_sha256:'b'.repeat(64)}})]);
  await f.render();const html=f.nodes['mm2-tiers'].children[0].innerHTML;
  assert.match(html,/Mixed answers &lt;review&gt;/);assert.match(html,/does not verify your installed copy/);assert.match(html,/Physical user acceptance has not been performed/);assert.doesNotMatch(html,/Running/);
  assert.equal(f.calls.filter(([url])=>/select|check|completions/.test(url)).length,0);
});

test('selected and installed never imply running; unknown resource state disables ordinary use', async () => {
  const f = setup([preset({compatibility:{state:'insufficient_resources', selectable:false, reasons:['Close other apps.']}})]);
  await f.render();
  assert.match(f.nodes['mm2-tiers'].children[0].innerHTML, /Selected · Installed/);
  assert.doesNotMatch(f.nodes['mm2-tiers'].children[0].innerHTML, /Running/);
  assert.equal(buttons(f)[0].disabled, true);
  assert.equal(buttons(f)[1].textContent, 'Recheck');
});

test('technical details use a native disclosure while compatibility reasons stay visible', async () => {
  const f = setup([preset({ quantization: 'Q4_K_M', compatibility: { state: 'insufficient_resources', reasons: ['Close other apps.'], execution_mode: 'cpu', installation: { components: [{ filename: 'model.gguf', valid: true }] } } })]);
  await f.render(); const html = f.nodes['mm2-tiers'].children[0].innerHTML;
  assert.match(html, /<details class="mm2-technical"><summary>Technical details<\/summary>/);
  assert.ok(html.indexOf('Close other apps.') < html.indexOf('<details'));
  assert.ok(html.indexOf('Q4_K_M') > html.indexOf('<details'));
  assert.match(html, /model.gguf: present/); assert.match(html, /Size unknown/);
  assert.doesNotMatch(html, /<details[^>]+open/); assert.equal(f.calls.length, 1);
});

test('model overlay takes initial focus and Escape returns to the opener without cancelling work', async () => {
  const f = setup([]); let returned = 0, focused = 0;
  f.ctx.document.activeElement = { isConnected: true, focus() { returned++; } };
  f.nodes['model-manager-x'] = element(); f.nodes['model-manager-x'].focus = () => focused++;
  await f.ctx.window.tliOpenModelManagerModal(); assert.equal(focused, 1);
  const keydown = f.nodes['model-manager-modal-overlay'].handlers.keydown[0];
  let prevented = 0;
  keydown({ key: 'Escape', defaultPrevented: true, preventDefault() { prevented++; }, stopPropagation() {} });
  assert.equal(returned, 0);
  keydown({ key: 'Escape', preventDefault() { prevented++; }, stopPropagation() {} });
  assert.equal(returned, 1); assert.equal(prevented, 1);
  assert.ok(f.calls.every(([url]) => !url.endsWith('/cancel') && !url.endsWith('/select')));
  keydown({ key: 'Escape', preventDefault() { prevented++; }, stopPropagation() {} });
  assert.equal(returned, 1);
});

test('unknown model uses explicit check endpoint and escaped custom filename', async () => {
  const f = setup([preset({id:'custom:x.gguf',name:'<unsafe>',compatibility:{state:'unknown', reasons:['Unknown requirements.']}})]);
  await f.render();
  assert.match(f.nodes['mm2-tiers'].children[0].innerHTML, /&lt;unsafe&gt;/);
  assert.equal(buttons(f)[0].textContent, 'Check and use');
  await buttons(f)[0].click();
  assert.equal(f.calls.filter(([u]) => u === '/api/ai/models/check').length, 1);
});

test('duplicate clicks issue one request and failed recovery never displays success', async () => {
  let finish;
  const f = setup([preset()], async url => url.endsWith('/select') ? new Promise(resolve => finish=resolve) : {});
  await f.render();
  const use = buttons(f)[0];
  const first = use.click();
  await use.click();
  assert.equal(f.calls.filter(([u]) => u.endsWith('/select')).length, 1);
  finish({ok:false,error:'Candidate failed.',recovery:{attempted:true,restored:false}});
  await first;
  assert.match(f.nodes['model-manager-progress'].textContent, /Previous model could not restart/);
  assert.doesNotMatch(f.nodes['model-manager-progress'].textContent, /checks passed/);
});

test('restored previous model is reported as a failed candidate, not a successful switch', async () => {
  const f = setup([preset()], async () => ({ok:false,error:'Startup failed.',recovery:{attempted:true,restored:true}}));
  await f.render(); await buttons(f)[0].click();
  assert.equal(f.nodes['model-manager-progress'].textContent, 'Startup failed. Previous model restored.');
});

test('successful installation does not send a selection request', async () => {
  const f = setup([preset({installation_complete:false,is_selected:false})], async url => url.endsWith('/progress') ? {status:'done',in_progress:false} : {ok:true});
  await f.render(); await buttons(f)[0].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.nodes['model-manager-progress'].textContent, /Installation complete/);
  assert.equal(f.calls.filter(([u]) => /models\/(select|check)$/.test(u)).length, 0);
});

test('opening repeatedly binds one upload and cancellation handler', async () => {
  const f = setup([preset()], async () => ({in_progress:false}));
  await f.ctx.window.tliOpenModelManagerModal(); await f.ctx.window.tliOpenModelManagerModal();
  assert.equal(f.nodes['model-manager-file'].handlers.change.length, 1);
  assert.equal(f.nodes['model-manager-cancel'].handlers.click.length, 1);
});

test('optional Qwen shows its actual quantization and blocks download for an unsupported runtime', async () => {
  const f = setup([preset({id:'qwen3_1_7b', name:'Qwen3 1.7B (Optional)', family:'Qwen3',
    quantization:'Q8_0', is_vision:false, non_thinking:true, installation_complete:false, is_selected:false,
    validation_note:'Not benchmarked on this host.',
    compatibility:{state:'unsupported',download_allowed:false,selectable:false,
      download_reason:'Runtime is too old.',reasons:['Runtime is too old.'],
      runtime:{reason:'Needs a newer runtime.'}}})]);
  await f.render();
  const html = f.nodes['mm2-tiers'].children[0].innerHTML;
  assert.match(html, /Q8_0/);
  assert.match(html, /Text only · Non-thinking mode/);
  assert.match(html, /Not benchmarked/);
  assert.equal(buttons(f)[0].disabled, true);
  assert.equal(buttons(f).at(-1).textContent, 'Recheck');
  assert.equal(f.calls.filter(([u]) => u.endsWith('/download')).length, 0);
});

test('model comparison shows independent findings and missing responses without activating a model', async () => {
  const f = setup([preset({answer_validation:{status:'comparison_recorded',preset_id:'standard',
    summary:'Some findings need <review>',case_count:55,response_count:54,timeout_count:1,failed_count:0,not_run_count:0,
    evaluated_at:'2026-09-08',conditions:'CPU synthetic',model_sha256:'a'.repeat(64),runtime_sha256:'b'.repeat(64),
    primary_dimensions:{factual_grounding:{'2':31},useful_next_steps:{'2':32},context_handling:{'2':33},truthful_action_claims:{'2':34}},
    report_url:'javascript:alert(1)'}})]);
  await f.render(); const html = f.nodes['mm2-tiers'].children[0].innerHTML;
  assert.match(html,/Some findings need &lt;review&gt;/);
  assert.match(html,/54 of 55 answers received · 1 timed out/);
  assert.match(html,/Grounding: 31\/47/); assert.match(html,/Useful next steps: 32\/47/);
  assert.match(html,/Context handling: 33\/47/); assert.match(html,/Truthful action claims: 34\/47/);
  assert.match(html,/24 held-out questions are part of the 47 primary cases/);
  assert.match(html,/href="\/model-comparison\.html#model-standard"/);
  assert.doesNotMatch(html,/javascript:|Running|verified model|accurate answers/i);
  assert.match(html,/does not verify your installed copy/);
  assert.deepEqual(f.calls.map(([url]) => url), ['/api/ai/models/presets']);
});

test('comparison link cannot be redirected by an unknown preset or server-provided URL', async () => {
  const f = setup([preset({answer_validation:{status:'comparison_recorded',preset_id:'../other" onclick="bad',
    summary:'Reference only',case_count:55,report_url:'https://untrusted.invalid/'}})]);
  await f.render(); const html = f.nodes['mm2-tiers'].children[0].innerHTML;
  assert.match(html,/href="\/model-comparison\.html"/);
  assert.doesNotMatch(html,/untrusted\.invalid|onclick=|#model-\.\./);
  assert.equal(f.calls.length, 1);
});

test('anniversary evidence links to its fixed report and preserves historical comparison without a mutation', async () => {
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/model-comparison-anniversary.json'), 'utf8'));
  const standard = report.models.find(model => model.preset_id === 'standard');
  const f = setup([preset({answer_validation:{status:'comparison_recorded',study_id:'anniversary_completion',preset_id:'standard',
    summary:'No validated winner',case_count:standard.collection.expected,response_count:standard.collection.responses,
    timeout_count:standard.collection.timeouts,primary_dimensions:standard.partitions.primary.dimension_tallies,
    report_url:'https://untrusted.invalid/model'}})]);
  await f.render(); const html = f.nodes['mm2-tiers'].children[0].innerHTML;
  assert.match(html,/href="\/model-comparison-anniversary\.html#model-standard"/);
  assert.match(html,/href="\/model-comparison\.html"[^>]*>Earlier comparison/);
  assert.match(html,/This does not test live action execution/);
  assert.match(html,/does not verify your installed copy/);
  assert.doesNotMatch(html,/untrusted\.invalid|Running/);
  assert.deepEqual(f.calls.map(([url]) => url), ['/api/ai/models/presets']);
});

test('unrecognized study names and unsafe preset identities cannot change a comparison destination', async () => {
  for (const study_id of ['anniversary_completion', 'https://untrusted.invalid/', 'other-study']) {
    const f = setup([preset({answer_validation:{status:'comparison_recorded',study_id,
      preset_id:'../unsafe" onclick="bad',report_url:'javascript:alert(1)',summary:'Reference evidence'}})]);
    await f.render(); const html = f.nodes['mm2-tiers'].children[0].innerHTML;
    const page = study_id === 'anniversary_completion' ? 'model-comparison-anniversary' : 'model-comparison';
    assert.ok(html.includes(`href="/${page}.html"`));
    assert.doesNotMatch(html,/javascript:|onclick=|untrusted\.invalid|#model-\.\./);
    assert.deepEqual(f.calls.map(([url]) => url), ['/api/ai/models/presets']);
  }
});
