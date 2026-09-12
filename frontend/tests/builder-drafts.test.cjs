const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/builder.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };

function fixture() {
  const nodes = {}, events = {}, calls = [], toasts = [], copied = [];
  let handler, sequence = 0;
  function element(tag = 'div') {
    const node = {tag, value:'', checked:false, disabled:false, hidden:false, children:[], handlers:{}, attributes:{}, dataset:{},
      classList:{toggle() {}, add() {}, remove() {}},
      addEventListener(name, fn) {(this.handlers[name] ||= []).push(fn);},
      fire(name, extra = {}) {return Promise.all((this.handlers[name] || []).map(fn => fn({target:this, preventDefault() {}, stopPropagation() {}, ...extra})));},
      click() {return this.disabled ? Promise.resolve() : this.fire('click');},
      setAttribute(k,v) {this.attributes[k] = String(v);}, getAttribute(k) {return this.attributes[k];},
      hasAttribute(k) {return k in this.attributes;}, removeAttribute(k) {delete this.attributes[k];},
      appendChild(n) {this.children.push(n); return n;}, append(...items) {this.children.push(...items);},
      focus() {}, querySelectorAll() {return [];}, contains(n) {return n === this;},
    };
    let text = '';
    Object.defineProperty(node, 'textContent', {get() {return text + this.children.map(n => n.textContent).join('');}, set(v) {text = String(v); this.children = [];}});
    Object.defineProperty(node, 'innerHTML', {get() {return text;}, set(v) {text = String(v); this.children = [];}});
    return node;
  }
  const ids = ['panel-builder','builder-chat-input','builder-chat-send-btn','builder-start-btn',
    'builder-chat-project-path','builder-project-path','builder-chat-scan-btn','builder-project-name','builder-readiness',
    'builder-new-parent','builder-new-name','builder-create-project-btn','builder-attach-input','builder-attachment-tray',
    'builder-diff-file','builder-find-text','builder-replace-text','builder-replace-all','builder-generate-diff-btn',
    'builder-copy-diff-btn','builder-apply-approved','builder-apply-patch-btn','builder-diff-output','builder-before-output',
    'builder-after-output','builder-apply-output','builder-command-input','builder-command-cwd','builder-command-approved',
    'builder-rollback-id','builder-rollback-approved','builder-plan-output','builder-command-output','builder-rollback-output',
    'builder-project-map','builder-project-summary','builder-risk-files','builder-relevant-files','builder-analysis-output',
    'builder-snapshots','builder-receipts','builder-task-output'];
  for (const id of ids) nodes[id] = element(id.includes('input') ? 'input' : 'div');
  nodes['panel-builder'].hidden = true;
  const starter = element('button'); starter.setAttribute('data-builder-prompt','Explain the existing project before changing it.');
  const body = element('body');
  const context = vm.createContext({console, Date, Map, Set, FormData:class {append() {}},
    document:{body, getElementById:id => nodes[id] || null, createElement:element, createTextNode:text => ({textContent:text}),
      querySelectorAll:selector => selector === '[data-builder-prompt]' ? [starter] : [], addEventListener() {}},
    window:{addEventListener:(name, fn) => (events[name] ||= []).push(fn), confirm:() => true},
    localStorage:{getItem:() => null, setItem() {throw Error('Private drafts must stay in memory.');}},
    navigator:{clipboard:{writeText:async text => copied.push(text)}},
    escapeHtml:value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
    showToast:(text,type) => toasts.push({text,type}),
    setTimeout, clearTimeout, setInterval:() => 1, clearInterval() {},
    fetch:async (url, options = {}) => {
      calls.push({url,options});
      let result = handler ? await handler(url, options) : undefined;
      if (result === undefined) {
        if (url.endsWith('/select-project')) result = {project_map:{root:JSON.parse(options.body).path}};
        else if (url.endsWith('/attachments')) result = {attachments:[{id:'a' + ++sequence,name:'attachment-' + sequence,size:7}]};
        else if (url.startsWith('/api/builder/tasks?')) result = {tasks:[]};
        else if (url.startsWith('/api/builder/snapshots?')) result = {snapshots:[]};
        else if (url.startsWith('/api/builder/receipts?')) result = {receipts:[]};
        else if (url.endsWith('/backend-status')) result = {backend:'integrated',label:'Local AI'};
        else if (url.endsWith('/chat')) result = {message:{id:'chat-1',backend:'integrated',response:'Reply saved'}};
        else if (url.endsWith('/tasks')) result = {task:{id:'task-1',next_agent_index:3,status:'completed'}};
        else if (url.endsWith('/generate-diff')) result = {proposal:{id:'patch-1',diff:'-before\n+after',before_excerpt:'before',after_excerpt:'after'}};
        else result = {};
      }
      const status = result.status || 200;
      return {status,ok:status >= 200 && status < 300,json:async () => result.body || result};
    },
  });
  vm.runInContext(source, context); context.window.TLIBuilder.setup();
  return {nodes, calls, toasts, copied, starter, api:context.window.TLIBuilder,
    handle(fn) {handler = fn;},
    async event(name) {await Promise.all((events[name] || []).map(fn => fn()));},
    async open(project = 'J:/fixture/A') {nodes['builder-chat-project-path'].value = project; await nodes['builder-chat-scan-btn'].click();},
    async attach() {await nodes['builder-attach-input'].fire('change',{target:{files:[{name:'synthetic.txt'}]}});},
    posts(url) {return calls.filter(c => c.url.endsWith(url) && c.options.method === 'POST');},
  };
}

test('prompt starters append to an existing draft and never submit it', async () => {
  const f = fixture(); f.nodes['builder-chat-input'].value = 'Keep this unfinished requirement.';
  await f.starter.click();
  assert.equal(f.nodes['builder-chat-input'].value,'Keep this unfinished requirement.\n\nExplain the existing project before changing it.');
  assert.equal(f.calls.length,0);
});

for (const [button, endpoint] of [['builder-chat-send-btn','/chat'],['builder-start-btn','/tasks']]) {
  test(`${endpoint} consumes only accepted text and attachments while keeping a newer draft`, async () => {
    const f = fixture(); await f.open(); await f.attach();
    const pending = deferred();
    f.handle(url => url.endsWith(endpoint) ? pending.promise : undefined);
    f.nodes['builder-chat-input'].value = 'Original request';
    const sending = f.nodes[button].click(); await tick();
    f.nodes['builder-chat-input'].value = 'New work typed while waiting'; await f.attach();
    pending.resolve(endpoint === '/chat' ? {message:{id:'chat-new',backend:'integrated'}} : {task:{id:'task-new',status:'completed',next_agent_index:3}});
    await sending;
    assert.equal(f.nodes['builder-chat-input'].value,'New work typed while waiting');
    assert.doesNotMatch(f.nodes['builder-attachment-tray'].textContent,/attachment-1/);
    assert.match(f.nodes['builder-attachment-tray'].textContent,/attachment-2/);
    const submitted = JSON.parse(f.posts(endpoint)[0].options.body);
    assert.deepEqual(submitted.attachments.map(a => a.id),['a1']);
    f.handle(() => undefined); await f.nodes['builder-chat-send-btn'].click();
    assert.equal(f.nodes['builder-chat-input'].value,'');
    assert.equal(f.nodes['builder-attachment-tray'].textContent,'');
    assert.deepEqual(JSON.parse(f.posts('/chat').at(-1).options.body).attachments.map(a => a.id),['a2']);
  });

  test(`${endpoint} rejects duplicate and competing submissions and project changes while pending`, async () => {
    const f = fixture(); await f.open(); const pending = deferred();
    f.handle(url => url.endsWith(endpoint) ? pending.promise : undefined);
    f.nodes['builder-chat-input'].value = 'One request';
    const sending = f.nodes[button].fire('click');
    await f.nodes['builder-chat-send-btn'].fire('click'); await f.nodes['builder-start-btn'].fire('click');
    await f.open('J:/fixture/B');
    assert.equal(f.posts('/chat').length + f.posts('/tasks').length,1);
    assert.equal(f.posts('/select-project').length,1);
    assert.equal(f.nodes['builder-project-name'].textContent,'A');
    pending.resolve(endpoint === '/chat' ? {message:{id:'reply',backend:'integrated'}} : {task:{id:'work',status:'completed',next_agent_index:3}});
    await sending;
    assert.equal(f.nodes['builder-chat-input'].value,'');
  });
}

for (const outcome of [{status:503,body:{detail:'Unavailable'}},{ok:false,error:'Rejected'}, {}, {message:{id:'offline',backend:'offline'}}]) {
  test(`unsuccessful chat retains its draft and attachments: ${JSON.stringify(outcome)}`, async () => {
    const f = fixture(); await f.attach(); f.nodes['builder-chat-input'].value = 'Do not lose this';
    f.handle(url => url.endsWith('/chat') ? outcome : undefined);
    await f.nodes['builder-chat-send-btn'].click();
    assert.equal(f.nodes['builder-chat-input'].value,'Do not lose this');
    assert.match(f.nodes['builder-attachment-tray'].textContent,/attachment-1/);
    assert.equal(f.nodes['builder-chat-send-btn'].disabled,false);
    assert.equal(f.posts('/chat').length,1);
  });
}

test('rejected task creation preserves the submitted draft and does not advance or retry', async () => {
  const f = fixture(); await f.open(); await f.attach(); f.nodes['builder-chat-input'].value = 'Keep the task';
  f.handle(url => url.endsWith('/tasks') ? {status:409,body:{detail:'Project is locked'}} : undefined);
  await f.nodes['builder-start-btn'].click();
  assert.equal(f.nodes['builder-chat-input'].value,'Keep the task');
  assert.match(f.nodes['builder-attachment-tray'].textContent,/attachment-1/);
  assert.equal(f.posts('/tasks').length,1);
  assert.equal(f.calls.some(c => c.url.includes('/advance')),false);
});

test('project drafts return to their own target; old manual diffs and approvals cannot transfer', async () => {
  const f = fixture(); await f.open(); await f.attach();
  f.nodes['builder-chat-input'].value = 'A draft'; f.nodes['builder-diff-file'].value = 'src/a.js';
  f.nodes['builder-find-text'].value = 'before'; f.nodes['builder-replace-text'].value = 'after';
  await f.nodes['builder-generate-diff-btn'].click();
  f.nodes['builder-apply-approved'].checked = true; await f.nodes['builder-apply-approved'].fire('change');
  assert.equal(f.nodes['builder-apply-patch-btn'].disabled,false);
  await f.open('J:/fixture/B');
  assert.equal(f.nodes['builder-chat-input'].value,''); assert.equal(f.nodes['builder-diff-file'].value,'');
  assert.equal(f.nodes['builder-apply-approved'].checked,false);
  assert.equal(f.nodes['builder-copy-diff-btn'].disabled,true);
  await f.nodes['builder-apply-patch-btn'].fire('click'); assert.equal(f.posts('/apply-patch').length,0);
  f.nodes['builder-chat-input'].value = 'B draft';
  await f.open('J:/fixture/A');
  assert.equal(f.nodes['builder-chat-input'].value,'A draft'); assert.equal(f.nodes['builder-diff-file'].value,'src/a.js');
  assert.match(f.nodes['builder-attachment-tray'].textContent,/attachment-1/);
  assert.match(f.nodes['builder-diff-output'].textContent,/fresh diff/);
  assert.equal(f.nodes['builder-apply-approved'].checked,false);
  await f.open('J:/fixture/B'); assert.equal(f.nodes['builder-chat-input'].value,'B draft');
});

test('a failed replacement preview retains the old diff but requires fresh approval', async () => {
  const f = fixture(); await f.open(); f.nodes['builder-diff-file'].value = 'a.js'; f.nodes['builder-find-text'].value = 'before';
  await f.nodes['builder-generate-diff-btn'].click();
  const previous = f.nodes['builder-diff-output'].innerHTML;
  f.nodes['builder-apply-approved'].checked = true;
  f.nodes['builder-replace-text'].value = 'Keep this failed proposal draft';
  f.handle(url => url.endsWith('/generate-diff') ? {status:422,body:{detail:'Find text did not match'}} : undefined);
  await f.nodes['builder-generate-diff-btn'].click();
  assert.equal(f.nodes['builder-diff-output'].innerHTML,previous);
  assert.equal(f.nodes['builder-replace-text'].value,'Keep this failed proposal draft');
  assert.equal(f.nodes['builder-apply-approved'].checked,false);
  assert.equal(f.nodes['builder-apply-patch-btn'].disabled,true);
  await f.nodes['builder-copy-diff-btn'].click(); assert.equal(f.copied[0],'-before\n+after');
  assert.ok(f.toasts.some(t => /previous preview is retained/.test(t.text)));
});

for (const event of ['tli-session-locked','pagehide']) {
  test(`${event} clears private drafts and ignores a late accepted reply`, async () => {
    const f = fixture(); await f.open(); await f.attach();
    f.nodes['builder-chat-input'].value = 'Private draft'; f.nodes['builder-find-text'].value = 'Private code';
    const pending = deferred(); f.handle(url => url.endsWith('/chat') ? pending.promise : undefined);
    const sending = f.nodes['builder-chat-send-btn'].click();
    await f.event(event);
    for (const id of ['builder-chat-input','builder-find-text','builder-chat-project-path']) assert.equal(f.nodes[id].value,'');
    for (const id of ['builder-attachment-tray','builder-project-map','builder-project-summary']) assert.equal(f.nodes[id].textContent,'');
    await f.event('tli-session-unlocked'); f.nodes['builder-chat-input'].value = 'Fresh session draft';
    pending.resolve({message:{id:'old-private-reply',backend:'integrated',response:'Private response'}}); await sending;
    assert.equal(f.nodes['builder-chat-input'].value,'Fresh session draft');
    assert.equal(f.nodes['builder-attachment-tray'].textContent,'');
    await f.open(); assert.equal(f.nodes['builder-find-text'].value,'');
    assert.equal(f.nodes['builder-chat-send-btn'].disabled,false);
  });
}

test('an unauthorized attachment response clears existing readable state and cannot add content', async () => {
  const f = fixture(); await f.open(); f.nodes['builder-chat-input'].value = 'Private draft';
  f.handle(url => url.endsWith('/attachments') ? {status:401,body:{detail:'Unlock TLI'}} : undefined);
  await f.attach(); assert.equal(f.nodes['builder-chat-input'].value,'');
  assert.equal(f.nodes['builder-attachment-tray'].textContent,'');
  await f.starter.click(); assert.equal(f.nodes['builder-chat-input'].value,'');
});

test('Builder Locked Mode rejection preserves private draft and preview; only session expiry clears them', async () => {
  const f = fixture(); await f.open(); f.nodes['builder-chat-input'].value = 'Keep my draft';
  f.nodes['builder-diff-file'].value = 'a.js'; f.nodes['builder-find-text'].value = 'before';
  await f.nodes['builder-generate-diff-btn'].click();
  f.nodes['builder-apply-approved'].checked = true; await f.nodes['builder-apply-approved'].fire('change');
  f.handle(url => url.endsWith('/apply-patch') ? {status:403,body:{detail:'Builder is in Locked Mode. Patch application is disabled.'}} : undefined);
  await f.nodes['builder-apply-patch-btn'].click();
  assert.equal(f.nodes['builder-chat-input'].value,'Keep my draft');
  assert.match(f.nodes['builder-diff-output'].textContent,/before.*after/);
  assert.match(f.nodes['builder-apply-output'].textContent,/Locked Mode/);
  assert.equal(f.nodes['builder-project-name'].textContent,'A');
});
