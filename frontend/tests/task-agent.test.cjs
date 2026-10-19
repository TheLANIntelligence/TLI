const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/task-agent.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const response = (value, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => value});
const saved = (overrides = {}) => ({id: 'task_fixture', status: 'completed', revision: 4, receipts: [], reply: 'Repaired.', ...overrides});
const done = (overrides = {}) => ({id: 'run_fixture', status: 'completed', conversation_id: 'existing-conversation',
  result: {reply: 'Repaired.', task_id: 'task_fixture'}, metadata: {}, ...overrides});

function fixture(handler = () => undefined) {
  const ids = {}, events = {}, calls = [], loaded = []; let uuid = 0;
  function element(tag = 'div') {
    let content = '';
    const value = {tag, children: [], handlers: {}, attrs: {}, value: '', disabled: false, hidden: false, checked: false,
      classList: {contains: () => false},
      append(...nodes) { for (const n of nodes) { if(n.parent)n.parent.children=n.parent.children.filter(child=>child!==n); n.parent = this; this.children.push(n); if (this.tag === 'select' && !this.value) this.value = n.value; } },
      replaceChildren(...nodes) { this.children = []; if (this.tag === 'select') this.value = ''; this.append(...nodes); },
      before(n) { n.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this), 0, n); },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      querySelector(selector) { for(const child of this.children){if(child.tag===selector)return child;const found=child.querySelector(selector);if(found)return found;}return null; },
      dispatchEvent(event) { this.fire(event.type); },focus(){this.focused=true;},
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      fire(name, extra = {}) { const event = {target: this, currentTarget: this, preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; }, ...extra}; for (const fn of this.handlers[name] || []) fn(event); return event; },
      click() { if (!this.disabled) this.fire('click'); },
      closest(selector) { return selector === '#' + this.id || selector === '.' + this.className ? this : this.parent?.closest(selector)||null; },
    };
    Object.defineProperty(value, 'id', {get() { return this._id; }, set(v) { this._id = v; ids[v] = this; }});
    Object.defineProperty(value, 'textContent', {get() { return content + this.children.map(child => child.textContent).join(''); },
      set(v) { content = String(v); this.children = []; }});
    return value;
  }
  const document = {readyState: 'complete', body: element('body'), createElement: element, getElementById: id => ids[id],
    addEventListener: (name, fn) => (events['document:' + name] ||= []).push(fn)};
  for (const id of ['chat-output', 'chat-input', 'chat-send-btn', 'chat-image-preview', 'memory-use-saved', 'memory-use-history']) {
    const el = element(); el.id = id; document.body.append(el);
  }
  ids['chat-image-preview'].classList.contains = name => name === 'hidden';
  ids['memory-use-history'].checked = true;
  ids['chat-output'].textContent = 'Existing chat messages';
  const composer=element();composer.id='chat-composer-shell';document.body.append(composer);
  const row=element();row.className='chat-input-row';composer.append(row);row.append(ids['chat-input'],ids['chat-send-btn']);
  const sendLabel=element('span');sendLabel.textContent='Send';ids['chat-send-btn'].append(sendLabel);
  const window = {currentConversationId: 'existing-conversation',
    addEventListener: (name, fn) => (events[name] ||= []).push(fn),
    loadConversation: async (...args) => { assert.equal(ids['chat-send-btn'].disabled, false, 'Chat must be unlocked before loading its saved result'); loaded.push(args); },
  };
  const context = vm.createContext({window, document, console, Event, crypto: {randomUUID: () => `request-${++uuid}`},
    setTimeout: fn => setImmediate(fn),
    fetch: async (url, options = {}) => {
      calls.push({url, options}); const result = await handler(url, options, calls);
      if (result) return result;
      if (url === '/api/tasks/areas') return response({areas: [{id: 'area_fixture', name: 'My game', revision: 3}]});
      if (url === '/api/tasks/task_fixture') return response(saved());
      if (url === '/api/tasks') return response({tasks: []});
      return response(done());
    },
  });
  vm.runInContext(source, context);
  const all = (root = document.body) => [root, ...root.children.flatMap(child => all(child))];
  return {ids, calls, loaded, window, document, all, sendLabel, api: window.TLITaskAgent,
    button: text => all().find(el => el.tag === 'button' && el.textContent === text),
    text: () => ids['task-agent'].textContent,
    emit: (name, detail) => { for (const fn of events[name] || []) fn({detail}); },
    documentClick: target => { const event = {target, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }};
      for (const fn of events['document:click'] || []) fn(event); return event; },
    async enable() { ids['task-agent-mode'].click(); await flush(); ids['task-agent-area'].value = 'area_fixture'; },
  };
}

test('ordinary chat is preserved until explicit task mode intercepts send', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  const event = f.documentClick(f.ids['chat-send-btn']);
  assert.equal(event.prevented, undefined);
  assert.equal(f.ids['chat-output'].textContent, 'Existing chat messages');
  f.ids['chat-input'].value = 'Private draft';
  await f.enable();
  assert.equal(f.ids['chat-input'].value, 'Private draft');
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 0);
});

test('task entry lives inside the composer before its input and starts collapsed without private reads',async()=>{
  const f=fixture(),composer=f.ids['chat-composer-shell'],box=f.ids['task-agent'],mode=f.ids['task-agent-mode'];
  assert.equal(box.parent,composer);assert.equal(composer.children[0],box);assert.equal(composer.children[1].className,'chat-input-row');
  assert.equal(mode.tag,'button');assert.equal(mode.type,'button');assert.equal(mode.attrs['aria-controls'],'task-agent-body');
  assert.equal(mode.attrs['aria-expanded'],'false');assert.equal(f.ids['task-agent-body'].hidden,true);
  assert.equal(f.sendLabel.textContent,'Send');assert.equal(f.calls.length,0);assert.match(mode.textContent,/Task toolsOptional.*Read folders, edit text files/);
  assert.doesNotMatch(f.text(),/Work on a task/);assert.equal(f.ids['chat-output'].textContent,'Existing chat messages');
});

test('expanding is explicit setup, closing restores ordinary Send and preserves the draft',async()=>{
  const f=fixture();f.ids['chat-input'].value='Keep my ordinary question';await f.enable();
  assert.equal(f.ids['task-agent-body'].hidden,false);assert.equal(f.ids['task-agent-mode'].attrs['aria-expanded'],'true');
  assert.match(f.ids['task-agent-mode'].textContent,/Task mode on/);assert.equal(f.sendLabel.textContent,'Start task');
  assert.deepEqual(f.calls.map(call=>call.url),['/api/tasks/areas']);assert.ok(f.calls.every(call=>!call.options.method));
  const advanced=f.all().find(el=>el.tag==='details'&&el.children[0]?.textContent==='Model & internet options');assert(advanced);assert.notEqual(advanced.open,true);
  f.ids['task-agent-mode'].click();assert.equal(f.ids['task-agent-body'].hidden,true);assert.equal(f.sendLabel.textContent,'Send');
  assert.equal(f.ids['chat-input'].value,'Keep my ordinary question');assert.equal(f.calls.length,1);
  assert.equal(f.documentClick(f.ids['chat-send-btn']).prevented,undefined);
});

for(const label of ['Understand a project','Fix a text file','Investigate an error'])test(label+' only adds an editable draft and never grants access or submits',async()=>{
  const f=fixture();await f.enable();f.ids['chat-input'].value='My existing instructions';let inputEvents=0;
  f.ids['chat-input'].addEventListener('input',()=>inputEvents++);
  const example=f.all().find(el=>el.tag==='button'&&el.children[0]?.textContent===label);assert(example);example.click();await flush();
  assert.match(f.ids['chat-input'].value,/^My existing instructions\n\n/);assert.match(f.ids['chat-input'].value,/approved work area/);
  assert.equal(f.ids['chat-input'].focused,true);assert.equal(inputEvents,1);assert.equal(f.calls.length,1);
  assert.equal(f.ids['task-agent-area'].value,'area_fixture');assert.ok(f.all().filter(el=>el.type==='checkbox').every(el=>el.checked===false));
  assert.match(f.text(),/Example added to your draft.*Start task when ready/);assert.equal(f.loaded.length,0);
});

test('task Enter is explicit while Shift+Enter, IME and ordinary chat retain their behavior',async()=>{
  const f=fixture(),input=f.ids['chat-input'];input.value='Explain this folder';
  assert.equal(input.fire('keydown',{key:'Enter'}).prevented,undefined);assert.equal(f.calls.length,0);
  await f.enable();assert.equal(input.fire('keydown',{key:'Enter',shiftKey:true}).prevented,undefined);
  assert.equal(input.fire('keydown',{key:'Enter',isComposing:true}).prevented,undefined);assert.equal(f.calls.length,1);
  const event=input.fire('keydown',{key:'Enter'});assert.equal(event.prevented,true);assert.equal(event.stopped,true);await flush();
  assert.equal(f.calls.filter(call=>call.url==='/api/runs').length,1);
  assert.equal(JSON.parse(f.calls.find(call=>call.url==='/api/runs').options.body).payload.message,'Explain this folder');
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide'])test(event+' collapses task tools and unlock never restores task mode or repeats setup',async()=>{
  const f=fixture();await f.enable();f.emit(event);
  assert.equal(f.ids['task-agent-body'].hidden,true);assert.equal(f.ids['task-agent-mode'].attrs['aria-expanded'],'false');
  assert.equal(f.sendLabel.textContent,'Send');assert.equal(f.ids['task-agent-mode'].disabled,true);
  f.ids['task-agent-mode'].click();assert.equal(f.calls.length,1);f.emit('tli-session-unlocked');
  assert.equal(f.ids['task-agent-mode'].disabled,false);assert.equal(f.ids['task-agent-body'].hidden,true);assert.equal(f.calls.length,1);
  assert.equal(f.documentClick(f.ids['chat-send-btn']).prevented,undefined);
});

test('active task keeps its mode and draft examples disabled while explicit Stop remains available',async()=>{
  const pending=deferred(),f=fixture(url=>url==='/api/runs'?pending.promise:undefined);await f.enable();f.ids['chat-input'].value='Read the logs';
  const work=f.api.run('Read the logs');await tick();
  assert.equal(f.ids['task-agent-mode'].disabled,true);assert.equal(f.button('Stop task').disabled,false);
  const example=f.all().find(el=>el.className==='task-agent-example');assert.equal(example.disabled,true);example.click();
  f.ids['task-agent-mode'].click();assert.equal(f.ids['task-agent-body'].hidden,false);assert.equal(f.ids['chat-input'].value,'Read the logs');
  f.button('Stop task').click();await flush();assert.equal(f.calls.filter(call=>call.url.endsWith('/cancel')).length,1);
  pending.resolve(response(done()));await work;
  assert.equal(f.ids['task-agent-mode'].disabled,false);assert.equal(f.calls.filter(call=>call.url==='/api/runs').length,1);
});

test('task submission preserves conversation/context and loads the terminal answer after enabling chat', async () => {
  const f = fixture(); await f.enable();
  f.ids['chat-input'].value = 'Repair the mod';
  const result = await f.api.run('Repair the mod');
  const request = JSON.parse(f.calls.find(call => call.url === '/api/runs').options.body);
  assert.equal(request.kind, 'agent_task');
  assert.equal(request.payload.conversation_id, 'existing-conversation');
  assert.equal(request.payload.area_id, 'area_fixture');
  assert.equal(request.payload.area_revision, 3);
  assert.equal(request.payload.use_saved_memory, false);
  assert.equal(request.payload.use_conversation_history, true);
  assert.equal(f.ids['chat-input'].value, '');
  assert.equal(result.run_id, 'run_fixture');
  assert.equal(f.loaded[0][0], 'existing-conversation');
  assert.equal(f.ids['chat-output'].textContent, 'Existing chat messages');
});

test('command approval sends exact review and only explicit continue resumes the task', async () => {
  let state = saved({status: 'needs_input', revision: 5, pending: {id: 'review_fixture', tool: 'run_command', approved: false,
    arguments: {executable: 'C:/Python/python.exe', args: ['verify.py'], cwd: 'C:/game/mods'}, disclosure: 'Runs with host access'}});
  const f = fixture((url, options) => {
    if (url === '/api/tasks/task_fixture') return response(state);
    if (url.endsWith('/approve')) { state = {...state, revision: 6, pending: {...state.pending, approved: true}}; return response(state); }
    if (url.endsWith('/resume')) { state = saved({revision: 9}); return response(done()); }
  });
  await f.enable(); await f.api.run('Repair the mod');
  assert(f.button('Approve for this task'));
  assert.equal(f.button('Continue task'), undefined);
  f.button('Approve for this task').click(); await flush();
  assert.deepEqual(JSON.parse(f.calls.find(c => c.url.endsWith('/approve')).options.body), {review_id: 'review_fixture', expected_revision: 5});
  assert.equal(f.calls.filter(c => c.url.endsWith('/resume')).length, 0);
  f.button('Continue task').click(); await flush();
  const resume = JSON.parse(f.calls.find(c => c.url.endsWith('/resume')).options.body);
  assert.equal(resume.expected_revision, 6);
  assert.equal(f.calls.filter(c => c.url.endsWith('/resume')).length, 1);
  assert.match(f.text(), /Task · completed/);
});

test('a newer draft survives a delayed task submission', async () => {
  const pending = deferred();
  const f = fixture(url => url === '/api/runs' ? pending.promise : undefined);
  await f.enable(); f.ids['chat-input'].value = 'Original';
  const work = f.api.run('Original'); await tick();
  f.ids['chat-input'].value = 'Next task draft';
  pending.resolve(response(done())); await work;
  assert.equal(f.ids['chat-input'].value, 'Next task draft');
});

test('late private task results after lock and unlock are never rendered or spoken', async () => {
  const pending = deferred(); let spoken = 0;
  const f = fixture(url => url === '/api/tasks/task_fixture' ? pending.promise : undefined);
  await f.enable(); const work = f.api.run('Private request', {complete: () => { spoken++; }});
  const rejected = assert.rejects(work, /Session changed/);
  await tick(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  pending.resolve(response(saved({reply: 'PRIVATE OLD ANSWER', receipts: [{tool: 'workspace_read', outcome: 'returned', result: {content: 'PRIVATE OLD FILE'}}]})));
  await rejected;
  assert.doesNotMatch(f.text(), /PRIVATE OLD/);
  assert.equal(spoken, 0); assert.equal(f.loaded.length, 0);
});

test('voice completes with the saved run ID in task and ordinary chat modes', async () => {
  for (const taskMode of [false, true]) {
    const f = fixture(); if (taskMode) await f.enable();
    const completed = []; const voice = {text: 'Repair the mod', complete: (...args) => completed.push(args), fail: text => assert.fail(text)};
    f.emit('tli:voice-turn', voice); await flush();
    assert.equal(voice.handled, true);
    assert.equal(completed.length, 1);
    assert.equal(completed[0][0], 'Repaired.');
    assert.equal(completed[0][1].run_id, 'run_fixture');
    const body = JSON.parse(f.calls.find(c => c.url === '/api/runs').options.body);
    assert.equal(body.kind, taskMode ? 'agent_task' : 'chat');
  }
});

test('a lost submission response recovers by request ID without replay', async () => {
  const f = fixture((url, options) => url === '/api/runs' && options.method === 'POST' ? Promise.reject(new TypeError('Disconnected')) : undefined);
  await f.enable(); await f.api.run('Repair the mod');
  assert.equal(f.calls.filter(c => c.url === '/api/runs' && c.options.method === 'POST').length, 1);
  assert(f.calls.some(c => c.url === '/api/runs/request-1'));
});

test('locking while submission is pending detaches without cancelling from a newer session', async () => {
  const pending = deferred();
  const f = fixture(url => url === '/api/runs' ? pending.promise : undefined);
  await f.enable();
  const work = f.api.run('Private work');
  const rejected = assert.rejects(work, /Session changed/);
  await tick(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  pending.resolve(response(done())); await rejected;
  assert.equal(f.calls.filter(c => c.url.endsWith('/cancel')).length, 0);
});

test('an old voice request failure cannot disclose private error detail after unlock', async () => {
  const pending = deferred(); const failed = [];
  const f = fixture(url => url === '/api/runs' ? pending.promise : undefined);
  await f.enable();
  f.emit('tli:voice-turn', {text: 'Private work', complete: () => assert.fail('Must not speak'), fail: text => failed.push(text)});
  await tick(); f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  pending.resolve(response({detail: 'PRIVATE OLD FILE PATH'}, 403)); await flush();
  assert.doesNotMatch(f.text(), /PRIVATE OLD FILE PATH/);
  assert.deepEqual(failed, []);
});

const reviewStates = [
  ['Approve for this task', saved({status:'needs_input', pending:{id:'review_fixture', approved:false, arguments:{command:'review only'}}})],
  ['Continue task', saved({status:'interrupted'})],
  ['Undo this change', saved({receipts:[{tool:'workspace_write', outcome:'returned', result:{receipt:{id:'write_fixture'}}}]})],
];

for (const [label, state] of reviewStates) {
  test(label + ' from a cleared session cannot issue a request after unlock', async () => {
    const f = fixture(url => url === '/api/tasks/task_fixture' ? response(state) : undefined);
    await f.enable(); await f.api.run('Review this task');
    const oldButton = f.button(label); assert(oldButton);
    f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
    const before = f.calls.length; oldButton.click(); await flush();
    assert.equal(f.calls.length, before, 'Detached controls must stop before fetching or mutating');
    assert.equal(f.ids['task-agent-body'].hidden, true);
  });

  test(label + ' from a replaced task view cannot act on the old task', async () => {
    const f = fixture(url => {
      if (url === '/api/tasks/task_fixture') return response(state);
      if (url === '/api/tasks') return response({tasks:[{id:'task_second', message:'Another saved task', status:'completed'}]});
      if (url === '/api/tasks/task_second') return response(saved({id:'task_second', reply:'The second task is current.'}));
    });
    await f.enable(); await f.api.run('First task');
    const oldButton = f.button(label); assert(oldButton);
    f.button('Saved tasks').click(); await flush(); f.button('Another saved task · completed').click(); await flush();
    const before = f.calls.length; oldButton.click(); await flush();
    assert.equal(f.calls.length, before);
    assert.match(f.text(), /The second task is current/);
  });
}

test('detached Saved-task entries cannot read a previous session after unlock', async () => {
  const f = fixture(url => url === '/api/tasks' ? response({tasks:[{id:'task_fixture', message:'Saved work', status:'completed'}]}) : undefined);
  await f.enable(); f.button('Saved tasks').click(); await flush();
  const entry = f.button('Saved work · completed'); assert(entry);
  f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  const before = f.calls.length; entry.click(); await flush();
  assert.equal(f.calls.length, before);
});

test('selecting another saved task discards the older detail and its error', async () => {
  for (const failure of [false, true]) {
    const pending = deferred(), f = fixture(url => {
      if (url === '/api/tasks') return response({tasks:[
        {id:'task_old', message:'Old work', status:'completed'}, {id:'task_new', message:'New work', status:'completed'},
      ]});
      if (url === '/api/tasks/task_old') return pending.promise;
      if (url === '/api/tasks/task_new') return response(saved({id:'task_new', reply:'Current saved result.'}));
    });
    await f.enable(); f.button('Saved tasks').click(); await flush();
    f.button('Old work · completed').click(); await tick();
    f.button('New work · completed').click(); await flush();
    pending.resolve(response(failure ? {detail:'STALE PRIVATE ERROR'} : saved({id:'task_old', reply:'STALE PRIVATE RESULT'}), failure ? 403 : 200));
    await flush();
    assert.match(f.text(), /Current saved result/);
    assert.doesNotMatch(f.text(), /STALE PRIVATE/);
    assert.equal(f.calls.filter(call => call.options.method).length, 0, 'Opening saved results is read-only');
  }
});

test('a delayed approval cannot replace another saved task or disclose its stale error', async () => {
  for (const failure of [false, true]) {
    const pending = deferred(), review = reviewStates[0][1];
    const f = fixture(url => {
      if (url === '/api/tasks/task_fixture') return response(review);
      if (url.endsWith('/approve')) return pending.promise;
      if (url === '/api/tasks') return response({tasks:[{id:'task_new', message:'Other saved work', status:'completed'}]});
      if (url === '/api/tasks/task_new') return response(saved({id:'task_new', reply:'New saved result.'}));
    });
    await f.enable(); await f.api.run('Review first task');
    f.button('Approve for this task').click(); await tick();
    f.button('Saved tasks').click(); await flush(); f.button('Other saved work · completed').click(); await flush();
    pending.resolve(response(failure ? {detail:'STALE APPROVAL ERROR'} : saved({reply:'STALE APPROVAL RESULT'}), failure ? 403 : 200));
    await flush(); assert.match(f.text(), /New saved result/); assert.doesNotMatch(f.text(), /STALE APPROVAL/);
    assert.equal(f.calls.filter(call => call.url.endsWith('/resume')).length, 0);
  }
});

test('an uncertain approval is submitted once and requires an explicit saved-state check before continuation', async () => {
  const review = reviewStates[0][1]; let approved = false;
  const f = fixture(url => {
    if (url === '/api/tasks/task_fixture') return response(approved ? {...review, revision:5, pending:{...review.pending, approved:true}} : review);
    if (url.endsWith('/approve')) { approved = true; return Promise.reject(new TypeError('Connection lost')); }
    if (url === '/api/tasks') return response({tasks:[{id:'task_fixture', message:'Saved review', status:'needs_input'}]});
  });
  await f.enable(); await f.api.run('Review this task');
  const approve = f.button('Approve for this task'); approve.click(); approve.click(); await flush(); approve.click(); await flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/approve')).length, 1);
  assert.equal(approve.disabled, true); assert.match(f.text(), /Open Saved tasks.*Nothing was retried/);
  assert.equal(f.button('Continue task'), undefined);
  f.button('Saved tasks').click(); await flush(); f.button('Saved review · needs_input').click(); await flush();
  assert(f.button('Continue task')); assert.equal(f.calls.filter(call => call.url.endsWith('/resume')).length, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/approve')).length, 1);
});

for (const provider of ['lmstudio', 'openai']) test(provider + ' requires a model ID before accepting or clearing the task draft', async () => {
  const f = fixture(); await f.enable(); f.ids['task-agent-provider'].value = provider; f.ids['chat-input'].value = 'Keep this task draft';
  f.documentClick(f.ids['chat-send-btn']); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/runs').length, 0);
  assert.equal(f.ids['chat-input'].value, 'Keep this task draft'); assert.equal(f.ids['chat-send-btn'].disabled, false);
  const options = f.all().find(el => el.tag === 'details' && el.children[0]?.textContent === 'Model & internet options');
  assert.equal(options.open, true); assert.match(f.text(), /model ID.*before starting/);
  assert.ok(f.all().some(el => el.tag === 'input' && el.focused));
});

test('a completed work-area revocation cannot refresh private folders or display success in a later session', async () => {
  const pending = deferred(), f = fixture((url, options) => options.method === 'DELETE' ? pending.promise : undefined);
  await f.enable(); f.button('Revoke selected area').click(); await tick();
  assert.equal(f.calls.filter(call => call.options.method === 'DELETE').length, 1);
  f.emit('tli-session-locked'); f.emit('tli-session-unlocked');
  const before = f.calls.length; pending.resolve(response({revoked:true})); await flush();
  assert.equal(f.calls.length, before, 'Old completion must not issue a new-session read');
  assert.equal(f.ids['task-agent-area'].children.length, 0);
  assert.doesNotMatch(f.text(), /Work area access revoked/);
});

test('locked task tools cannot start work-area reads from retained controls or the refresh API', async () => {
  const f = fixture(); await f.enable(); const refresh = f.button('Refresh work areas'), locations = f.button('Find game locations');
  f.emit('tli-session-locked'); const before = f.calls.length;
  refresh.click(); locations.click(); await f.api.refresh(); await flush();
  assert.equal(f.calls.length, before);
});

for (const code of [401, 403, 409, 503]) test('task admission HTTP ' + code + ' preserves the draft and never retries or changes provider', async () => {
  const f = fixture(url => url === '/api/runs' ? response({detail:'Selected task model or access is unavailable.'}, code) : undefined);
  await f.enable(); f.ids['chat-input'].value = 'My unsent task'; f.documentClick(f.ids['chat-send-btn']); await flush();
  assert.equal(f.ids['chat-input'].value, 'My unsent task'); assert.equal(f.ids['chat-send-btn'].disabled, false);
  assert.match(f.text(), /Selected task model or access is unavailable/);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/tasks/areas', '/api/runs']);
  assert.equal(JSON.parse(f.calls[1].options.body).payload.provider.kind, 'bundled'); assert.equal(f.loaded.length, 0);
});

test('saved completed results and receipts are useful without reopening chat or replaying writes', async () => {
  const f = fixture(url => {
    if (url === '/api/tasks') return response({tasks:[{id:'task_fixture', message:'Update README', status:'completed'}]});
    if (url === '/api/tasks/task_fixture') return response(saved({reply:'README now explains the installation steps.', receipts:[
      {tool:'workspace_write', outcome:'returned', result:{receipt:{id:'write_fixture'}, path:'C:/Projects/README.md'}},
    ]}));
  });
  await f.enable(); f.button('Saved tasks').click(); await flush(); f.button('Update README · completed').click(); await flush();
  assert.match(f.text(), /README now explains the installation steps/); assert.match(f.text(), /C:\/Projects\/README\.md/);
  assert(f.button('Undo this change')); assert.equal(f.calls.filter(call => call.options.method).length, 0); assert.equal(f.loaded.length, 0);
});
