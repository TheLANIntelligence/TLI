const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/storage-cleanup.js'), 'utf8');

function fixture(handler=async () => ({ok:true})) {
  const all = [], nodes = {}, calls = [], events = {}, documentEvents = {};
  let smallScreen=false;
  const window = {matchMedia:()=>({matches:smallScreen}),addEventListener:(name,fn)=>(events[name] ||= []).push(fn), dispatchEvent:event=>{for(const fn of events[event.type] || [])fn(event);}};
  function element(tag='div') {
    const e = {tag, textContent:'', children:[], dataset:{}, handlers:{}, disabled:false, hidden:false, value:'',
      append(...children){for(const child of children){child.remove?.();child.parentNode=this;this.children.push(child);}}, replaceChildren(...children){for(const child of this.children)child.parentNode=null;this.children=[];this.append(...children);},
      insertBefore(child,next){child.remove();child.parentNode=this;const at=this.children.indexOf(next);if(at<0)this.children.push(child);else this.children.splice(at,0,child);},
      remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(c=>c!==this);this.parentNode=null;}},
      get nextSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)+1]||null;},
      get isConnected(){let node=this;while(node.parentNode)node=node.parentNode;return node===document.body;},
      get tagName(){return this.tag.toUpperCase();}, focus(){document.activeElement=this;},
      ...(tag==='dialog'?{showModal(){this.open=true;this.opens=(this.opens||0)+1;},close(){this.open=false;this.handlers.close?.();}}:{}),
      setAttribute(){}, addEventListener(name, fn){this.handlers[name]=fn;},
      querySelector(tag){const match=c=>tag.startsWith('.')?c.className===tag.slice(1):c.tag===tag;return this.children.find(match) || this.children.map(c => c.querySelector(tag)).find(Boolean);},
      click(){return this.disabled ? Promise.resolve() : this.handlers.click?.({stopPropagation(){}});},
      change(value){if (this.disabled) return; if (this.tag === 'input') this.checked=value; else this.value=value; return this.handlers.change?.();}};
    all.push(e); return e;
  }
  const document = {readyState:'complete', hidden:false, addEventListener:(name,fn)=>(documentEvents[name] ||= []).push(fn), getElementById:id => nodes[id] ||= element(), createElement:element,
    body:element('body'), activeElement:null, querySelectorAll:selector => all.filter(e => selector==='[data-cleanup-path]' ? 'cleanupPath' in e.dataset : selector==='[data-cleanup-page]' ? 'cleanupPage' in e.dataset : 'cleanupKeeper' in e.dataset)};
  const ctx = vm.createContext({window, document, AbortSignal, CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;}}, fetch:async (url, options) => {
    calls.push([url, options]); const data = await handler(url, options.body ? JSON.parse(options.body) : null);
    return {ok:!data.httpError, status:data.httpError || 200, json:async () => data};
  }});
  vm.runInContext(source,ctx);
  return {nodes, all, calls, document, window, mobile:value=>smallScreen=value, element, emit:(name,detail)=>window.dispatchEvent({type:name,detail}), hide:()=>{document.hidden=true;for(const fn of documentEvents.visibilitychange || [])fn();}, show:()=>{document.hidden=false;for(const fn of documentEvents.visibilitychange || [])fn();}, api:ctx.window.TLIStorageCleanup};
}
const file = (path='C:\\Users\\demo\\large.bin') => ({path, size:1024});
const preview = (files, eligible=true) => ({ok:true, preview_id:'a'.repeat(32), can_execute:eligible,
  total_bytes:1024*files.length, space_note:'Trash may still occupy disk space.', items:files.map(f => ({...f,size:1024,eligible,reason:eligible?'':'Restricted location'}))});
const receipt = (files,statuses) => ({id:'a'.repeat(32),ok:statuses.every(s=>s==='trashed'), status:statuses.every(s=>s==='trashed')?'completed':'partial',
  summary:`Moved ${statuses.filter(s=>s==='trashed').length} of ${files.length} selected files to Trash.`,
  results:files.map((f,i)=>({...f,status:statuses[i],reason:statuses[i]==='failed'?'File is in use':''}))});
const text = node => [node.textContent,...node.children.map(text)].join(' ');

test('nothing is preselected; review is separate from execution and lists blocked paths literally', async () => {
  const f = fixture(async (url,body) => preview(body.files,false));
  const item = file('C:\\<img onerror=attack()>');
  const checkbox = f.api.choice(item).querySelector('input');
  assert.equal(!!checkbox.checked,false); assert.equal(f.calls.length,0);
  checkbox.change(true); await f.nodes['cleanup-check'].click();
  assert.equal(f.calls.length,1); assert.match(f.calls[0][0],/preview$/);
  assert.equal(f.nodes['cleanup-execute'].hidden,true);
  assert.match(text(f.nodes['cleanup-preview']), /<img onerror=attack\(\)>/);
  assert.match(text(f.nodes['cleanup-preview']), /Blocked/);
});

test('partial execution stays truthful and retry reviews only unmoved files', async () => {
  const chosen = [file('C:\\one'),file('C:\\two')];
  const f = fixture(async (url,body) => url.endsWith('/preview') ? preview(body.files) : receipt(chosen,['trashed','failed']));
  for (const item of chosen) f.api.choice(item).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click(); await f.nodes['cleanup-execute'].click();
  assert.match(text(f.nodes['cleanup-receipt']), /Moved 1 of 2/);
  assert.match(text(f.nodes['cleanup-receipt']), /Failed/);
  assert.match(f.nodes['cleanup-count'].textContent,/1 of 100/);
  f.nodes['cleanup-receipt'].children.find(c=>c.tag==='button').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(([url])=>url.endsWith('/execute')).length,1);
  const latest = JSON.parse(f.calls.at(-1)[1].body);
  assert.deepEqual(latest.files.map(f=>f.path),['C:\\two']);
});

test('changing selection invalidates the reviewed request', async () => {
  const f = fixture(async (url,body)=>preview(body.files));
  f.api.choice(file('C:\\one')).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click();
  assert.equal(f.nodes['cleanup-execute'].disabled,false);
  f.api.choice(file('C:\\two')).querySelector('input').change(true);
  assert.equal(f.nodes['cleanup-execute'].disabled,true);
  await f.nodes['cleanup-execute'].click();
  assert.equal(f.calls.length,1);
});

test('changing location preserves selection but revokes approval until its original scope is selected and reviewed again', async () => {
  const f=fixture(async (url,body)=>preview(body.files)), scope={root:'C:\\',observationId:'scan-c',host:{id:'host'}};
  f.api.setScope(scope);f.api.setLocation('C:\\');f.api.choice(file('C:\\one')).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click();assert.equal(f.nodes['cleanup-execute'].disabled,false);
  f.api.setLocation('E:\\');assert.equal(f.api.getSelectionState().count,1);assert.equal(f.nodes['cleanup-check'].disabled,true);assert.equal(f.nodes['cleanup-execute'].hidden,true);assert.match(f.nodes['cleanup-count'].textContent,/Selection from C:.*Return/);
  await f.nodes['cleanup-execute'].handlers.click();await f.nodes['cleanup-check'].handlers.click();f.api.openReview();f.hide();f.show();f.emit('tli-panel-switched',{panelId:'panel-visualizer'});f.api.openReview();await f.nodes['cleanup-execute'].handlers.click();await f.nodes['cleanup-check'].handlers.click();assert.equal(f.calls.length,1);assert.equal(f.nodes['cleanup-check'].disabled,true);
  f.api.setLocation('c:/');f.api.setScope(scope);assert.equal(f.api.getSelectionState().count,1);assert.equal(f.nodes['cleanup-check'].disabled,false);assert.equal(f.nodes['cleanup-execute'].hidden,true);
  await f.nodes['cleanup-check'].click();assert.equal(f.calls.length,2);assert.equal(f.nodes['cleanup-execute'].disabled,false);
});

test('a preview completing after location changed cannot restore approval or trigger a move', async () => {
  let resolve;const f=fixture(()=>new Promise(r=>resolve=r));f.api.setScope({root:'C:\\',observationId:'scan-c'});f.api.setLocation('C:\\');const selected=file('C:\\one');f.api.choice(selected).querySelector('input').change(true);
  const pending=f.nodes['cleanup-check'].click();f.api.setLocation('E:\\');resolve(preview([selected]));await pending;
  assert.equal(f.api.getSelectionState().count,1);assert.equal(f.nodes['cleanup-execute'].hidden,true);assert.equal(f.nodes['cleanup-check'].disabled,true);f.api.setLocation('C:\\');await f.nodes['cleanup-execute'].handlers.click();assert.equal(f.calls.length,1);
});

test('location changes retain an uncertain dispatched move and require receipt lookup rather than another execution', async () => {
  let resolve;const selected=file('C:\\one');const f=fixture(async(url,body)=>url.endsWith('/preview')?preview(body.files):url.endsWith('/execute')?new Promise(r=>resolve=r):receipt([selected],['trashed']));
  f.api.setScope({root:'C:\\',observationId:'scan-c'});f.api.setLocation('C:\\');f.api.choice(selected).querySelector('input').change(true);await f.nodes['cleanup-check'].click();const pending=f.nodes['cleanup-execute'].click();f.api.setLocation('E:\\');resolve(receipt([selected],['trashed']));await pending;
  assert.equal(f.api.getSelectionState().unresolved,true);assert.equal(f.nodes['cleanup-result-check'].disabled,true);f.api.setLocation('C:\\');assert.equal(f.nodes['cleanup-check'].disabled,true);await f.nodes['cleanup-execute'].handlers.click();await f.nodes['cleanup-result-check'].click();assert.equal(f.calls.filter(([url])=>url.endsWith('/execute')).length,1);assert.equal(f.api.getSelectionState().unresolved,false);assert.equal(f.api.getSelectionState().count,0);
});

test('duplicate selection requires an explicit keeper and ordinary rows retain that constraint', async () => {
  const f = fixture(async (url,body)=>preview(body.files));
  const a=file('C:\\a'), b=file('C:\\b');
  const box=f.api.duplicateControls({paths:[a.path,b.path],size:1024});
  const keep=box.querySelector('select');
  assert.equal(keep.value,'');
  let inputs=f.all.filter(e=>'cleanupPath' in e.dataset);
  assert.ok(inputs.every(e=>e.disabled && !e.checked));
  keep.change(b.path);
  inputs=f.all.filter(e=>'cleanupPath' in e.dataset).slice(-2);
  assert.equal(inputs[0].disabled,false); assert.equal(inputs[1].disabled,true);
  f.api.choice(a).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click();
  assert.equal(JSON.parse(f.calls[0][1].body).files[0].keep_path,b.path);
  const forbidden=f.api.choice(b).querySelector('input'); forbidden.change(true);
  assert.equal(forbidden.checked,false);
});

test('duplicate clicks execute once and lost response uses read-only status lookup', async () => {
  let finish;
  const chosen=[file()];
  const f=fixture(async (url,body)=>url.endsWith('/preview')?preview(body.files):url.endsWith('/execute')?
    new Promise((resolve,reject)=>finish=()=>reject(new Error('Connection lost'))):receipt(chosen,['trashed']));
  f.api.choice(chosen[0]).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click();
  const first=f.nodes['cleanup-execute'].click(); await f.nodes['cleanup-execute'].click();
  assert.equal(f.calls.filter(([u])=>u.endsWith('/execute')).length,1);
  finish(); await first;
  assert.equal(f.nodes['cleanup-execute'].disabled,true);
  assert.equal(f.nodes['cleanup-result-check'].hidden,false);
  await f.nodes['cleanup-result-check'].click();
  assert.equal(f.calls.filter(([u])=>u.endsWith('/execute')).length,1);
  assert.match(text(f.nodes['cleanup-receipt']),/Moved 1 of 1/);
});

test('selection is bounded and protected files cannot be checked', () => {
  const f=fixture();
  assert.equal(f.api.choice({...file(),protected:true}).querySelector('input').disabled,true);
  assert.equal(f.api.choice({...file(),isDir:true}).querySelector('input').disabled,true);
  for(let n=0;n<101;n++) f.api.choice(file('C:\\'+n)).querySelector('input').change(true);
  assert.match(f.nodes['cleanup-count'].textContent,/100 of 100/);
  assert.match(f.nodes['cleanup-error'].textContent,/up to 100/);
});

test('opening a historical receipt does not remove current selections', async () => {
  const old={...receipt([file()],['trashed']),started_at:1000};
  const f=fixture(async ()=>({ok:true,receipts:[old]}));
  f.api.choice(file()).querySelector('input').change(true);
  await f.nodes['cleanup-history-load'].click();
  f.nodes['cleanup-history'].children[0].click();
  assert.match(f.nodes['cleanup-count'].textContent,/1 of 100/);
  assert.equal(f.calls.length,1);
});


function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('unknown scan size remains explicitly unknown and selection events contain no paths', () => {
  const f=fixture();const events=[];f.window.addEventListener('cleanup_state',e=>events.push(e.detail));
  f.api.choice({path:'C:\\sensitive-name',size:null}).querySelector('input').change(true);
  f.api.choice(file('C:\\known')).querySelector('input').change(true);
  assert.match(f.nodes['cleanup-count'].textContent,/At least 1.00 KB.*1 sizes unknown/);
  assert.equal(events.at(-1).unknownSizeCount,1);assert.equal(events.at(-1).knownBytes,1024);
  assert.ok(!JSON.stringify(events).includes('sensitive-name'));
});

test('Clear and Remove preserve a lost execution result and cannot dispatch again', async () => {
  const f=fixture(async (url,body)=>url.endsWith('/preview')?preview(body.files):Promise.reject(new Error('Lost result')));
  f.api.choice(file()).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click();await f.nodes['cleanup-execute'].click();
  f.nodes['cleanup-selection'].children[0].children.find(c=>c.tag==='button').click();
  await f.nodes['cleanup-clear'].click();
  assert.equal(f.api.getSelectionState().count,0);
  assert.equal(f.api.getSelectionState().pendingActivityCount,1);
  assert.equal(f.nodes['cleanup-result-check'].hidden,false);
  const next=f.api.choice(file('C:\\next')).querySelector('input');assert.equal(next.disabled,true);
  await f.nodes['cleanup-execute'].click();assert.equal(f.calls.filter(([url])=>url.endsWith('/execute')).length,1);
});

test('a final unknown receipt remains separate while unrelated files can be reviewed', async () => {
  const a=file('C:\\uncertain'),b=file('C:\\unrelated');
  const f=fixture(async (url,body)=>url.endsWith('/preview')?preview(body.files):receipt([a],['unknown']));
  f.api.choice(a).querySelector('input').change(true);await f.nodes['cleanup-check'].click();await f.nodes['cleanup-execute'].click();
  await f.nodes['cleanup-clear'].click();assert.equal(f.api.getSelectionState().unresolved,true);
  assert.match(text(f.nodes['cleanup-receipt']),/Unconfirmed/);
  assert.equal(f.api.choice(a).querySelector('input').disabled,true);
  f.api.choice(b).querySelector('input').change(true);await f.nodes['cleanup-check'].click();
  assert.equal(f.api.getSelectionState().unresolved,true);
  assert.match(text(f.nodes['cleanup-receipt']),/Unconfirmed/);
  assert.equal(f.calls.filter(([url])=>url.endsWith('/execute')).length,1);
});

test('lock during preview clears private state and ignores its late result', async () => {
  const wait=deferred();const f=fixture(()=>wait.promise);
  const a=file('C:\\private-path');f.api.choice(a).querySelector('input').change(true);
  const task=f.nodes['cleanup-check'].click();f.emit('tli-session-locked');wait.resolve(preview([a]));await task;
  assert.equal(f.api.getSelectionState().count,0);assert.equal(f.nodes['cleanup-execute'].disabled,true);
  for(const id of ['cleanup-preview','cleanup-selection','cleanup-receipt','cleanup-history'])assert.ok(!text(f.nodes[id]).includes('private-path'));
  assert.equal(f.api.getSelectionState().pendingActivityCount,0);
});

test('background during an execution preserves only a result lookup and no automatic replay', async () => {
  const wait=deferred(),a=file('C:\\private-result');
  const f=fixture(async(url,body)=>url.endsWith('/preview')?preview(body.files):url.endsWith('/execute')?wait.promise:receipt([a],['trashed']));
  f.api.choice(a).querySelector('input').change(true);await f.nodes['cleanup-check'].click();
  const task=f.nodes['cleanup-execute'].click();f.hide();wait.resolve(receipt([a],['trashed']));await task;
  assert.equal(f.api.getSelectionState().pendingActivityCount,1);assert.ok(!f.nodes['cleanup-receipt'] || text(f.nodes['cleanup-receipt']).trim()==='');
  f.document.hidden=false;f.api.openReview();assert.equal(f.calls.length,2);
  await f.nodes['cleanup-result-check'].click();
  assert.match(f.calls.at(-1)[0],/\/receipt\//);assert.equal(f.api.getSelectionState().pendingActivityCount,0);
  assert.equal(f.calls.filter(([url])=>url.endsWith('/execute')).length,1);
});

test('older receipts cannot resolve an outstanding request after close', async () => {
  const wait=deferred(),a=file();
  const f=fixture(async(url,body)=>url.endsWith('/preview')?preview(body.files):url.endsWith('/execute')?wait.promise:{ok:true,receipts:[{...receipt([a],['trashed']),id:'older'}]});
  f.api.choice(a).querySelector('input').change(true);await f.nodes['cleanup-check'].click();
  const task=f.nodes['cleanup-execute'].click();f.api.clearPrivate();f.api.openReview();
  await f.nodes['cleanup-history-load'].click();assert.equal(f.api.getSelectionState().pendingActivityCount,1);
  assert.equal(f.nodes['cleanup-check'].disabled,true);
  wait.reject(new Error('lost'));await task;
});

test('late 401 from an old preview does not lock a newly reopened review', async () => {
  const wait=deferred();let calls=0;
  const f=fixture(async(url,body)=>++calls===1?wait.promise:preview(body.files));
  f.api.choice(file()).querySelector('input').change(true);const first=f.nodes['cleanup-check'].click();
  f.api.clearPrivate();f.api.openReview();f.api.choice(file('C:\\new')).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click();wait.resolve({httpError:401,detail:'Old session'});await first;
  assert.equal(f.nodes['cleanup-execute'].disabled,false);assert.equal(f.api.getSelectionState().count,1);
});

test('scope change clears selection and keeper identities without erasing uncertain results', async () => {
  const f=fixture(async(url,body)=>url.endsWith('/preview')?preview(body.files):receipt([file('C:\\a')],['unknown']));
  f.api.setScope({host:'one',root:'C:\\',observationId:'one'});
  const old=f.api.choice(file('C:\\a')).querySelector('input');old.change(true);
  await f.nodes['cleanup-check'].click();await f.nodes['cleanup-execute'].click();
  f.api.setScope({host:'one',root:'D:\\',observationId:'two'});assert.equal(f.api.getSelectionState().count,0);
  assert.equal(f.api.getSelectionState().unresolved,true);old.change(true);assert.equal(f.api.getSelectionState().count,0);
});

test('failed receipt reload preserves the previously displayed result and selection', async () => {
  let count=0;const old={...receipt([file('C:\\old')],['trashed']),id:'old'};
  const f=fixture(async()=>++count===1?{ok:true,receipts:[old]}:{httpError:503,detail:'Storage unavailable'});
  f.api.choice(file('C:\\selected')).querySelector('input').change(true);
  await f.nodes['cleanup-history-load'].click();f.nodes['cleanup-history'].children[0].click();
  const before=text(f.nodes['cleanup-receipt']);await f.nodes['cleanup-history-load'].click();
  assert.equal(text(f.nodes['cleanup-receipt']),before);assert.equal(f.api.getSelectionState().count,1);
  assert.equal(f.nodes['cleanup-history'].children.length,1);
});

test('a malformed successful execute response remains unresolved', async () => {
  const f=fixture(async(url,body)=>url.endsWith('/preview')?preview(body.files):{...receipt([file('C:\\wrong')],['trashed']),ok:true});
  f.api.choice(file('C:\\submitted')).querySelector('input').change(true);
  await f.nodes['cleanup-check'].click();await f.nodes['cleanup-execute'].click();
  assert.equal(f.api.getSelectionState().unresolved,true);assert.equal(f.api.getSelectionState().count,1);
  assert.equal(f.nodes['cleanup-execute'].disabled,true);
});


test('background retains selection and receipt, invalidates preview, and resumes existing controls without a request', async () => {
  const f=fixture(async(url,body)=>preview(body.files));
  const a=f.api.choice(file('C:\\retained')).querySelector('input'),b=f.api.choice(file('C:\\also-retained')).querySelector('input');
  a.change(true);await f.nodes['cleanup-check'].click();f.hide();
  assert.equal(f.api.getSelectionState().count,1);assert.equal(f.nodes['cleanup-execute'].disabled,true);
  f.show();b.change(true);assert.equal(f.api.getSelectionState().count,2);assert.equal(f.calls.length,1);
});


test('an unrelated valid receipt never resolves the outstanding request', async () => {
  const f=fixture(async(url,body)=>url.endsWith('/preview')?preview(body.files):{...receipt([file()],['trashed']),id:'different-request'});
  f.api.choice(file()).querySelector('input').change(true);await f.nodes['cleanup-check'].click();await f.nodes['cleanup-execute'].click();
  assert.equal(f.api.getSelectionState().pendingActivityCount,1);await f.nodes['cleanup-result-check'].click();
  assert.equal(f.api.getSelectionState().pendingActivityCount,1);assert.equal(f.api.getSelectionState().count,1);
});


function drawerSetup(f){
  const box=f.nodes['storage-cleanup-review'];box.tag='details';
  const summary=f.element('summary'),section=f.element('section');section.className='storage-cleanup';
  for(const [id,node] of Object.entries(f.nodes))if(id.startsWith('cleanup-'))section.append(node);
  box.append(summary,section);f.document.body.append(box);
  const invoker=f.element('button');f.document.body.append(invoker);invoker.focus();
  f.mobile(true);return {box,summary,section,invoker};
}

test('phone review moves the same controls into one native dialog and Escape restores focus without requests', () => {
  const f=fixture(),{box,section,invoker}=drawerSetup(f);
  const check=f.nodes['cleanup-check'];f.api.openReview();
  const dialog=f.all.find(e=>e.tag==='dialog');assert.equal(dialog.open,true);
  assert.equal(dialog.querySelector('.storage-cleanup'),section);assert.ok(section.children.includes(check));
  f.api.openReview();assert.equal(f.all.filter(e=>e.tag==='dialog').length,1);assert.equal(dialog.opens,1);
  assert.equal(f.document.activeElement,dialog.querySelector('button'));
  let prevented=false;dialog.handlers.cancel({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(section.parentNode,box);assert.equal(f.document.activeElement,invoker);
  assert.equal(dialog.isConnected,false);assert.equal(f.calls.length,0);
});

test('locking an open phone drawer restores original DOM and clears selected private paths', () => {
  const f=fixture(),{box,section}=drawerSetup(f);f.api.choice(file('C:\\private-drawer')).querySelector('input').change(true);
  f.api.openReview();const dialog=f.all.find(e=>e.tag==='dialog');f.emit('tli-session-locked');
  assert.equal(dialog.isConnected,false);assert.equal(section.parentNode,box);
  assert.equal(f.api.getSelectionState().count,0);assert.ok(!text(f.nodes['cleanup-selection']).includes('private-drawer'));
  f.api.openReview();assert.equal(f.all.filter(e=>e.tag==='dialog').length,1);assert.equal(f.calls.length,0);
});

test('phone-to-desktop resize restores the existing details with selection intact', () => {
  const f=fixture(),{box,section}=drawerSetup(f);f.api.choice(file()).querySelector('input').change(true);
  f.api.openReview();f.mobile(false);f.emit('resize');
  assert.equal(section.parentNode,box);assert.equal(box.open,true);assert.equal(f.api.getSelectionState().count,1);
  f.api.openReview();assert.equal(f.all.filter(e=>e.tag==='dialog').length,1);assert.equal(f.calls.length,0);
});


test('large duplicate groups render at most100 paths and preserve an off-page keeper with no unseen selection', async () => {
  const f=fixture(async(url,body)=>preview(body.files));
  const paths=Array.from({length:1105},(_,i)=>'C:\\duplicate-'+i);
  const box=f.api.duplicateControls({paths,size:8192});
  function descendants(node){return node.children.flatMap(child=>[child,...descendants(child)]);}
  const checks=()=>descendants(box).filter(e=>'cleanupPath'in e.dataset);
  const next=()=>descendants(box).find(e=>e.textContent==='Next paths');
  assert.equal(checks().length,100);assert.match(text(box),/Showing 1\u2013100 of 1105/);
  box.querySelector('select').change(paths[0]);checks()[1].change(true);
  next().click();assert.equal(checks().length,100);assert.match(text(box),/Showing 101\u2013200 of 1105/);
  const keep=box.querySelector('select');assert.equal(keep.value,paths[0]);assert.equal(keep.children.length,102);
  checks()[0].change(true);assert.equal(f.api.getSelectionState().count,2);
  assert.ok(checks().slice(1).every(e=>!e.checked));
  await f.nodes['cleanup-check'].click();
  const sent=JSON.parse(f.calls[0][1].body);assert.deepEqual(sent.files.map(row=>row.path),[paths[1],paths[100]]);
  assert.ok(sent.files.every(row=>row.keep_path===paths[0]));
  assert.equal(f.calls.length,1);
});
