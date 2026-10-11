const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/files.js'), 'utf8');
const root = 'C:\\Users\\demo\\Downloads';
const pair = (name='one.txt', destination='Target\\one.txt', status='ready', reason='') =>
  ({source: root+'\\'+name, destination: root+'\\'+destination, status, reason, size:12});
const preview = (rows=[pair()], extra={}) => ({ok:true,preview:true,status:'preview',preview_id:'a'.repeat(32),
  expires_at:Date.now()/1000+600, can_execute:rows.some(r=>r.status==='ready')&&rows.every(r=>r.status!=='blocked'),
  results:rows, message:'Review every path. Nothing has changed.', history:[], ...extra});
const receipt = (rows=[pair('one.txt','Target\\one.txt','moved')], kind='organize', extra={}) => {
  const status = kind==='organize'?'moved':kind==='rename'?'renamed':'undone';
  const count = rows.filter(r=>r.status===status).length;
  const ok = rows.every(r=>r.status===status||r.status==='unchanged');
  return {ok,preview:false,status:ok?'completed':count?'partial':'failed',results:rows,
    message:`${kind==='undo'?'Restored':kind==='rename'?'Renamed':'Moved'} ${count} of ${rows.length} files.`,
    moved_count:kind==='organize'?count:0,count:kind==='rename'?count:0,undone:kind==='undo'?count:0,
    undo_available:kind!=='undo'&&count>0, ...extra};
};

function fixture(handler=async()=>preview(), capabilityHandler=async()=>({ok:true,protocol:'reviewed-file-operations-v1'})) {
  const nodes={}, all=[], calls=[], capabilityCalls=[], events={}, toasts=[];
  function element(tag='div') {
    const e = {tag, children:[], style:{}, handlers:{}, attributes:{}, textContent:'', value:'', disabled:false,
      classList:{toggle(){},remove(){}},
      set id(id){this._id=id;nodes[id]=this;},get id(){return this._id;},
      append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}},
      appendChild(child){this.append(child);return child;},
      replaceChildren(...children){for(const child of this.children){if(child.id)delete nodes[child.id];}this.children=[];this.append(...children);},
      set innerHTML(value){this._html=value;this.children=[];},get innerHTML(){return this._html||'';},
      setAttribute(name,value){this.attributes[name]=value;}, getAttribute(name){return this.attributes[name];},
      addEventListener(name,fn){(this.handlers[name] ||= []).push(fn);},
      querySelector(selector){if(selector==='input'&&this._html?.includes('<input'))return this.input ||= element('input');return null;},
      async fire(name){for(const fn of this.handlers[name]||[])await fn({target:this});},
      async click(){if(!this.disabled)await this.fire('click');}, scrollIntoView(){}
    };all.push(e);return e;
  }
  const ids=['filesRootInput','filesRenamePrefix','filesStatus','filesBucketsContainer','filesExtTableBody',
    'filesScanButton','filesPreviewButton','filesRunButton','filesUndoButton','filesBatchRenameButton'];
  for(const id of ids){const e=element(id.endsWith('Input')||id==='filesRenamePrefix'?'input':'div');e.id=id;}
  const card=element();card.appendChild(nodes.filesStatus);
  nodes.filesRootInput.value=root;nodes.filesRenamePrefix.value='new';
  const document={getElementById:id=>nodes[id]||null,createElement:element,querySelectorAll:()=>[]};
  const window={localStorage:{getItem(){return null;},setItem(){}},addEventListener:(event,fn)=>(events[event] ||= []).push(fn)};
  const ctx=vm.createContext({window,document,console,Date,debugLog(){},showToast:msg=>toasts.push(msg),
    $:id=>nodes[id]||null,escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    fetch:async(url,options)=>{
      if(url==='/file/operations/capabilities') {
        capabilityCalls.push({url,options});const result=await capabilityHandler();
        return {ok:!result.httpError,status:result.httpError||200,json:async()=>result};
      }
      const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
      const result=await handler(url,body);
      return {ok:!result.httpError,status:result.httpError||200,json:async()=>result,text:async()=>JSON.stringify(result)};
    }});
  vm.runInContext(source,ctx,{timeout:1000});ctx.setupFilesPanel();
  const seed=(buckets={Documents:['one.txt']},destinations={Documents:'Target'})=>{
    // Existing operation tests represent a user-selected plan, not scan defaults.
    vm.runInContext(`filesLastScanBuckets=${JSON.stringify({buckets})};filesLastScanRoot=${JSON.stringify(root)};filesBucketDestinations=${JSON.stringify(destinations)};filesSelectedNames=new Set(${JSON.stringify(Object.values(buckets).flat())});`,ctx);
    ctx.filesRenderBuckets();
  };
  seed();
  return {ctx,nodes,calls,capabilityCalls,all,toasts,seed,dispatch:async name=>{for(const fn of events[name]||[])await fn();}};
}
const text = node => node ? [node.textContent,...node.children.map(text)].join(' ') : '';
const reviewText = f => text(f.nodes['files-operation-review']);

test('run organizer opens exact literal path review; only its explicit confirm sends a mutation',async()=>{
  const literal=pair('<img src=x>.txt');
  const f=fixture(async(url,body)=>body.confirm?receipt([ {...literal,status:'moved'} ]):preview([literal]));
  await f.nodes.filesRunButton.click();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.confirm,false);
  assert.match(reviewText(f), /From: C:\\Users\\demo\\Downloads\\<img src=x>.txt/);
  assert.equal(f.nodes['files-operation-confirm'].textContent,'Move 1 file');
  await f.nodes['files-operation-confirm'].click();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.preview_id,'a'.repeat(32));
  assert.equal(f.calls[1].body.confirm,true);assert.match(reviewText(f),/Moved 1 of 1/);
});

test('rename is previewed with exact names, and undo separately reviews original paths',async()=>{
  const f=fixture(async(url,body)=>body.confirm?receipt([pair('one.txt','new_1.txt',url.endsWith('undo')?'undone':'renamed')],url.endsWith('undo')?'undo':'rename'):
    preview([pair('one.txt','new_1.txt')],url.endsWith('undo')?{operation_id:'b'.repeat(32),history:[{id:'b'.repeat(32),type:'rename',timestamp:'2026-09-07',undo_status:'not_requested'}]}:{}));
  await f.nodes.filesBatchRenameButton.click();assert.equal(f.calls[0].body.confirm,false);
  assert.match(reviewText(f),/new_1.txt/);await f.nodes['files-operation-confirm'].click();
  assert.match(reviewText(f),/Renamed 1 of 1/);
  await f.nodes.filesUndoButton.click();assert.equal(f.calls.at(-1).body.confirm,false);
  assert.match(reviewText(f),/Recorded operation/);assert.equal(f.nodes['files-operation-confirm'].textContent,'Restore 1 file');
});

test('blocked later file prevents confirmation and displays the reason',async()=>{
  const f=fixture(async()=>preview([pair(),pair('two.txt','Target\\two.txt','blocked','Destination already exists.')]));
  await f.ctx.filesPreviewOrganize();assert.equal(f.nodes['files-operation-confirm'].disabled,true);
  await f.nodes['files-operation-confirm'].click();assert.equal(f.calls.length,1);
  assert.match(reviewText(f),/Destination already exists/);
});

test('partial completion retains the draft and reports every result without claiming success',async()=>{
  const rows=[pair(),pair('two.txt','Target\\two.txt')];
  const f=fixture(async(url,body)=>body.confirm?receipt([{...rows[0],status:'moved'},{...rows[1],status:'failed',reason:'File in use'}]):preview(rows));
  f.seed({Documents:['one.txt','two.txt']});await f.ctx.filesRunOrganize();await f.nodes['files-operation-confirm'].click();
  assert.match(reviewText(f),/partial completion/);assert.match(reviewText(f),/Moved 1 of 2/);assert.match(reviewText(f),/File in use/);
  assert.equal(f.ctx.filesBuildOrganizePayload().actions.Target.length,2);
  assert.equal(f.calls.filter(c=>c.body.confirm).length,1);assert.equal(f.nodes['files-operation-confirm'],undefined);
});

test('editing the next plan preserves the previous confirmed result and its per-file evidence',async()=>{
  const f=fixture(async(url,body)=>body.confirm?receipt([pair('one.txt','Target\\one.txt','failed','File in use')]):preview());
  await f.ctx.filesRunOrganize();await f.ctx.filesConfirmOperation();
  const result=reviewText(f);
  f.nodes.filesRootInput.value='C:\\new-plan';await f.nodes.filesRootInput.fire('input');
  assert.equal(reviewText(f),result);assert.match(result,/Moved 0 of 1/);assert.match(result,/File in use/);
  assert.equal(f.calls.length,2);
});

test('two category destinations merge into one plan instead of dropping files',async()=>{
  const f=fixture();f.seed({Documents:['one.txt'],Images:['photo.jpg']},{Documents:'Target',Images:'Target'});
  await f.ctx.filesPreviewOrganize();assert.deepEqual(f.calls[0].body.actions.Target,['one.txt','photo.jpg']);
});

test('prefix or root edits invalidate the reviewed request and stale scan roots cannot organize',async()=>{
  const f=fixture();await f.ctx.filesBatchRename();
  f.nodes.filesRenamePrefix.value='changed';await f.nodes.filesRenamePrefix.fire('input');
  assert.equal(f.nodes['files-operation-confirm'].disabled,true);await f.ctx.filesConfirmOperation();assert.equal(f.calls.length,1);
  f.nodes.filesRootInput.value='C:\\different';assert.equal(f.ctx.filesBuildOrganizePayload(),null);
});

test('programmatic destination edits and expired previews are rechecked before mutation',async()=>{
  const f=fixture();await f.ctx.filesRunOrganize();
  vm.runInContext("filesBucketDestinations.Documents='changed'",f.ctx);await f.ctx.filesConfirmOperation();assert.equal(f.calls.length,1);
  const expired=fixture(async()=>preview([pair()],{expires_at:Date.now()/1000-1}));
  await expired.ctx.filesRunOrganize();await expired.ctx.filesConfirmOperation();assert.equal(expired.calls.length,1);
  assert.match(reviewText(expired),/expired or changed/);
});

test('duplicate clicks during preview and execution send one request each',async()=>{
  let finish;const f=fixture(async(url,body)=>new Promise(resolve=>{finish=()=>resolve(body.confirm?receipt():preview());}));
  const first=f.ctx.filesRunOrganize();await f.ctx.filesRunOrganize();await new Promise(setImmediate);assert.equal(f.calls.length,1);finish();await first;
  const second=f.ctx.filesConfirmOperation();await f.ctx.filesConfirmOperation();await new Promise(setImmediate);assert.equal(f.calls.length,2);finish();await second;
});

test('lost execution response preserves draft and requires inspection without automatic retry',async()=>{
  const f=fixture(async(url,body)=>{if(body.confirm)throw new Error('Disconnected');return preview();});
  await f.ctx.filesRunOrganize();await f.ctx.filesConfirmOperation();
  assert.match(f.nodes.filesStatus.textContent,/Outcome not confirmed.*No retry was sent/);
  assert.equal(f.calls.length,2);assert.ok(f.ctx.filesBuildOrganizePayload());
  await f.ctx.filesConfirmOperation();assert.equal(f.calls.length,2);
});

test('malformed successful response cannot display completion',async()=>{
  for(const malformed of [{ok:true},receipt([pair('one.txt','Target\\one.txt','failed')],'organize',{ok:true,status:'completed'}),
    receipt(undefined,'organize',{moved_count:100})]) {
    const f=fixture(async(url,body)=>body.confirm?malformed:preview());
    await f.ctx.filesRunOrganize();await f.ctx.filesConfirmOperation();
    assert.match(f.nodes.filesStatus.textContent,/Outcome not confirmed/);assert.doesNotMatch(reviewText(f),/File operation completed/);
    assert.ok(f.ctx.filesBuildOrganizePayload());
  }
});

test('session locking clears private review and ignores an in-flight response',async()=>{
  let finish;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.ctx.filesRunOrganize();await new Promise(setImmediate);await f.dispatch('tli-session-locked');finish(preview());await pending;
  assert.equal(reviewText(f),'');assert.equal(f.ctx.filesBuildOrganizePayload(),null);assert.equal(f.nodes.filesStatus.textContent,'');
});

test('late scan response cannot associate old filenames with a different folder',async()=>{
  let finish;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.ctx.filesScanFolder();f.nodes.filesRootInput.value='C:\\different';await f.nodes.filesRootInput.fire('input');
  finish({extension_summary:[]});await pending;assert.equal(f.calls.length,1);assert.equal(f.ctx.filesBuildOrganizePayload(),null);
});

test('a failed replacement scan keeps both previous tables and the original scan identity', async () => {
  const f=fixture(async url=>url==='/files/scan'?{extension_summary:[{extension:'.new',count:4}]}:{httpError:403});
  f.ctx.filesRenderBuckets();
  f.ctx.filesRenderExtensionTable([{extension:'.old',count:1,example:'one.txt'}]);
  const oldBuckets=f.nodes.filesBucketsContainer.children.slice();
  const oldExtensions=f.nodes.filesExtTableBody.children.slice();
  f.nodes.filesRootInput.value='C:\\unavailable';
  await f.nodes.filesRootInput.fire('input');
  assert.deepEqual(f.nodes.filesBucketsContainer.children,oldBuckets);
  await f.ctx.filesScanFolder();
  assert.deepEqual(f.nodes.filesBucketsContainer.children,oldBuckets);
  assert.deepEqual(f.nodes.filesExtTableBody.children,oldExtensions);
  assert.equal(f.ctx.filesBuildOrganizePayload(),null);
  assert.match(f.nodes.filesStatus.textContent,/Previous results for C:.*Downloads remain visible/);
  assert.equal(f.calls.filter(call=>call.url==='/file/organize').length,0);
});

test('replacement file-type results commit only after the second scan succeeds', async () => {
  let finish;
  const f=fixture(async url=>url==='/files/scan'?{extension_summary:[{extension:'.new',count:2}]}:
    new Promise(resolve=>{finish=resolve;}));
  f.ctx.filesRenderExtensionTable([{extension:'.old',count:1}]);
  const previous=f.nodes.filesExtTableBody.children.slice();
  const pending=f.ctx.filesScanFolder();await new Promise(setImmediate);
  assert.deepEqual(f.nodes.filesExtTableBody.children,previous);
  finish({buckets:{Documents:['first.new','second.new']},total_files:2});await pending;
  assert.match(f.nodes.filesExtTableBody.children[0].innerHTML,/\.new/);
  assert.match(f.nodes.filesStatus.textContent,/Scan complete: 2 files/);
  assert.equal(f.ctx.filesBuildOrganizePayload(),null);
  f.ctx.filesSelect(['first.new','second.new']);
  assert.deepEqual(Array.from(f.ctx.filesBuildOrganizePayload().actions.Target),['first.new','second.new']);
});

test('malformed replacement scans do not clear a working plan or display new extension data', async () => {
  const f=fixture(async url=>url==='/files/scan'?{extension_summary:[{extension:'.new'}]}:{buckets:{Documents:[null]}});
  f.ctx.filesRenderExtensionTable([{extension:'.old'}]);
  const previous=f.nodes.filesExtTableBody.children.slice();
  await f.ctx.filesScanFolder();
  assert.deepEqual(f.nodes.filesExtTableBody.children,previous);
  assert.deepEqual(Array.from(f.ctx.filesBuildOrganizePayload().actions.Target),['one.txt']);
  assert.match(f.nodes.filesStatus.textContent,/invalid file lists/);
});

test('setup is idempotent and selecting earlier undo history only previews it',async()=>{
  const f=fixture(async()=>preview([pair()],{operation_id:'a'.repeat(32),history:[
    {id:'a'.repeat(32),type:'organize',timestamp:null},{id:'b'.repeat(32),type:'rename',timestamp:null}]}));
  f.ctx.setupFilesPanel();await f.nodes.filesUndoButton.click();assert.equal(f.calls.length,1);
  f.nodes['files-operation-history'].value='b'.repeat(32);await f.nodes['files-operation-history'].fire('change');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.operation_id,'b'.repeat(32));assert.equal(f.calls[1].body.confirm,false);
});

test('old or malformed host capability responses send zero organize, rename or undo POSTs',async()=>{
  for(const result of [{httpError:404},{ok:true},{ok:false,protocol:'reviewed-file-operations-v1'},
    {ok:true,protocol:'other-protocol'}]) {
    const f=fixture(async()=>{throw new Error('Must not POST to old handlers');},async()=>result);
    await f.ctx.filesRunOrganize();await f.ctx.filesBatchRename();await f.ctx.filesUndoLast();
    assert.equal(f.calls.length,0);assert.equal(f.capabilityCalls.length,3);
    assert.match(f.nodes.filesStatus.textContent,/restart TLI with the updated code/);
  }
});

test('host capability is rechecked before confirming and cannot be cached across host rollback',async()=>{
  let available=true;
  const f=fixture(async()=>preview(),async()=>available?{ok:true,protocol:'reviewed-file-operations-v1'}:{httpError:404});
  await f.ctx.filesRunOrganize();available=false;await f.ctx.filesConfirmOperation();
  assert.equal(f.calls.length,1);assert.equal(f.capabilityCalls.length,2);
  assert.ok(f.capabilityCalls.every(c=>c.options.method==='GET'&&c.options.cache==='no-store'));
  assert.match(f.nodes.filesStatus.textContent,/File operation not sent/);
});

test('locking while the capability check runs prevents the subsequent POST',async()=>{
  let finish;const f=fixture(async()=>preview(),async()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.ctx.filesBatchRename();await f.dispatch('tli-session-locked');
  finish({ok:true,protocol:'reviewed-file-operations-v1'});await pending;assert.equal(f.calls.length,0);
});

test('fresh scans select no files and only an explicit subset enters the review',async()=>{
  const f=fixture(async url=>url==='/files/scan'?{extension_summary:[]}:
    url==='/file/scan'?{buckets:{Images:['one.jpg','two.jpg'],Documents:['note.txt']},total_files:3}:preview());
  await f.ctx.filesScanFolder();assert.equal(f.ctx.filesBuildOrganizePayload(),null);
  assert.equal(f.ctx.filesSelect(['two.jpg']),true);await f.ctx.filesPreviewOrganize();
  assert.deepEqual(f.calls.at(-1).body.actions,{Images:['two.jpg']});assert.equal(f.calls.at(-1).body.confirm,false);
});

test('500 selected files are accepted and a 501st or oversized bulk leaves selection unchanged',()=>{
  const f=fixture();const names=Array.from({length:501},(_,i)=>`file-${i}.txt`);f.seed({Documents:names});
  vm.runInContext('filesSelectedNames.clear()',f.ctx);
  assert.equal(f.ctx.filesSelect(names),false);assert.equal(f.ctx.filesBuildOrganizePayload(),null);
  assert.equal(f.ctx.filesSelect(names.slice(0,500)),true);assert.equal(f.ctx.filesSelect([names[500]]),false);
  assert.equal(f.ctx.filesBuildOrganizePayload().actions.Target.length,500);assert.match(f.nodes.filesStatus.textContent,/selection is unchanged/);
});

test('search and category filters page display without changing selected files',async()=>{
  const f=fixture();f.seed({Documents:Array.from({length:60},(_,i)=>`note-${i}.txt`),Images:['photo.jpg']},{Documents:'Docs',Images:'Photos'});
  vm.runInContext('filesSelectedNames=new Set(["photo.jpg"])',f.ctx);f.ctx.filesRenderBuckets();
  assert.equal(f.nodes['files-file-list'].children.length,50);
  f.nodes['files-selection-search'].value='note-1';await f.nodes['files-selection-search'].fire('input');
  assert.equal(f.nodes['files-file-list'].children.length,11);assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.filesBuildOrganizePayload().actions)),{Photos:['photo.jpg']});
  f.nodes['files-selection-category'].value='Images';await f.nodes['files-selection-category'].fire('change');
  assert.match(text(f.nodes['files-file-list']),/No files match/);assert.equal(f.ctx.filesDescribeDraft().selectedCount,1);
});

test('leave-here and deterministic recipe include only the advertised category',()=>{
  const f=fixture();f.seed({Documents:['one.txt'],Images:['photo.jpg']},{Documents:'Docs',Images:'Photos'});
  f.ctx.filesSelect(['one.txt','photo.jpg'],false);f.ctx.filesApplyQuick('Images','Images','image files');
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.filesBuildOrganizePayload().actions)),{Images:['photo.jpg']});
  f.ctx.filesSelect(['photo.jpg'],false);assert.equal(f.ctx.filesBuildOrganizePayload(),null);
});

test('blank destinations never silently omit explicitly selected files',()=>{
  const f=fixture();f.seed({Documents:['one.txt'],Images:['photo.jpg']},{Documents:'Docs',Images:''});
  assert.equal(f.ctx.filesBuildOrganizePayload(),null);f.ctx.filesSelect(['photo.jpg'],false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.filesBuildOrganizePayload().actions)),{Docs:['one.txt']});
});

test('removing blocked files invalidates the old preview and a new review contains only remaining selections',async()=>{
  const f=fixture(async()=>preview([pair(),pair('two.txt','Target\\two.txt','blocked','Destination already exists.')]));
  f.seed({Documents:['one.txt','two.txt']});await f.ctx.filesPreviewOrganize();
  await f.nodes['files-leave-blocked'].click();await f.ctx.filesConfirmOperation();assert.equal(f.calls.length,1);
  assert.deepEqual(Array.from(f.ctx.filesBuildOrganizePayload().actions.Target),['one.txt']);
  await f.ctx.filesPreviewOrganize();assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.confirm,false);
  assert.deepEqual(f.calls[1].body.actions.Target,['one.txt']);
});

test('folder preparation keeps current draft until explicitly replaced and never scans',()=>{
  const f=fixture();const next='C:\\Other';
  assert.equal(f.ctx.filesPrepare({root:next}).status,'draft-conflict');assert.equal(f.nodes.filesRootInput.value,root);
  assert.equal(f.ctx.filesPrepare({root:next},true).status,'prepared');assert.equal(f.calls.length,0);
  assert.equal(f.ctx.filesDescribeDraft().scannedRoot,root);assert.equal(f.ctx.filesDescribeDraft().selectedCount,1);
  assert.equal(f.ctx.filesBuildOrganizePayload(),null);
  f.ctx.filesPrepare({root},true);assert.deepEqual(Array.from(f.ctx.filesBuildOrganizePayload().actions.Target),['one.txt']);
});

test('handoff candidates require explicit addition and match only immediate scanned files',async()=>{
  const f=fixture();f.ctx.filesRenderBuckets();f.ctx.filesSelect(['one.txt'],false);
  f.ctx.filesPrepare({root,candidatePaths:[root+'\\one.txt',root+'\\nested\\two.txt','C:\\Other\\one.txt']});
  assert.equal(f.ctx.filesBuildOrganizePayload(),null);assert.match(text(f.nodes['files-candidates']),/1 suggested file matches.*2 are unavailable/);
  await f.nodes['files-add-candidates'].click();assert.deepEqual(Array.from(f.ctx.filesBuildOrganizePayload().actions.Target),['one.txt']);assert.equal(f.calls.length,0);
});

test('duplicate scan clicks coalesce and presets prepare without any scan request',async()=>{
  let finish;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));
  const scan=f.ctx.filesScanFolder();await f.ctx.filesScanFolder();assert.equal(f.calls.length,1);
  finish({httpError:503});await scan;
  f.ctx._tliPathPreset=()=>root;f.ctx.filesSetPreset('downloads');assert.equal(f.calls.length,1);
});
