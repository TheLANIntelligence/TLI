const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,job,envelope,scan,root}=require('./helpers/free-space-fixture.cjs');

const metadata={version:1,available:true,indexed_count:1503,inspected_count:1503,acquisition_complete:true};
const item=(name,extra={})=>({name,path:root+'\\'+name,kind:'file',size:30,allocated_size:4096,modified_at:'2026-10-14T12:00:00Z',...extra});
const page=(query,items,total=items.length,extra={})=>({version:1,job_id:job().id,root,items,total,offset:Number(query.get('offset')),limit:100,has_more:Number(query.get('offset'))+items.length<total,meta:metadata,...extra});
async function load(handler=async query=>page(query,[item('unretained.txt')]),capability=metadata,resultMeta={}){
  const data=scan();Object.assign(data.meta,resultMeta);if(capability)data.meta.inventory=capability;
  const f=fixture(async(url,options)=>url.includes('/inventory?')?handler(new URL(url,'http://fixture').searchParams):url==='/visualizer/investigate'?{ok:true,protocol:'storage-investigation-v1',local_only:true,reply:'This path was observed in the index.',evidence:{root,job_id:job().id,selected_path:JSON.parse(options.body).selected_path},recommendations:[]}:url.endsWith('/results')?envelope(job(),data):envelope(job()));
  f.api.prepare(root);await f.api.start();await new Promise(setImmediate);return f;
}
const rows=f=>f.nodes['fs-inventory-rows'].querySelectorAll('.fs-inventory-row');
const select=(f,name)=>rows(f).find(row=>row.querySelector('.storage-file-action').textContent===name).querySelector('.storage-file-action').click();

test('largest files visibly warns about incomplete acquisition and defaults to descending size',async()=>{
  const partial={...metadata,acquisition_complete:false};
  const f=await load(async query=>page(query,[item('observed-small.txt')],1,{meta:partial}),partial,{partial:true,time_limited:true});
  f.nodes['fs-inventory-sort'].value='name';f.nodes['fs-inventory-order'].value='asc';
  await f.nodes['fs-browser-largest'].click();
  assert.equal(f.nodes['fs-inventory-warning'].hidden,false);
  assert.match(f.nodes['fs-inventory-warning'].textContent,/larger files may be missing.*time limit/);
  const query=new URL(f.calls.at(-1).url,'http://fixture').searchParams;
  assert.equal(query.get('sort'),'size');assert.equal(query.get('order'),'desc');
  const complete=await load();assert.equal(complete.nodes['fs-inventory-warning'].hidden,true);
});

test('ordinary pagination is not described as a response-size limit',async()=>{
  for(const limited of [false,true]){
    const f=await load(async query=>page(query,[item('recorded.avi')],2,{meta:{...metadata,query_truncated:true,response_limited:limited}}));
    assert.equal(f.nodes['fs-inventory-status'].textContent.includes('Page limited by response size'),limited);
  }
});

test('inventory is capability gated and opens the completed scan index as the default browser',async()=>{
  const old=await load(undefined,null);assert.equal(old.nodes['fs-inventory'].hidden,true);await old.nodes['fs-inventory-browse'].click();assert.equal(old.calls.length,2);
  const f=await load();assert.equal(f.nodes['fs-inventory'].hidden,false);assert.equal(f.calls.length,3);assert.match(f.nodes['fs-inventory-coverage'].textContent,/1,503 indexed paths.*Acquisition complete/);
  const query=new URL(f.calls.at(-1).url,'http://fixture').searchParams;assert.equal(query.get('mode'),'children');assert.equal(query.get('path'),root);assert.equal(query.get('limit'),'100');assert.equal(rows(f).length,1);assert.equal(f.api.getState().observation.index.has(root+'\\unretained.txt'),false);assert.equal(f.api.getState().mapView.total,12);
  assert.equal(f.nodes['fs-browser-files'].getAttribute('aria-pressed'),'true');assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('pagination stays bounded, preserves query sorting, and makes detached controls inert',async()=>{
  const f=await load(async query=>{const offset=Number(query.get('offset'));return page(query,Array.from({length:offset?3:100},(_,i)=>item('file-'+(offset+i)+'.bin')),103);});
  await f.nodes['fs-inventory-browse'].click();assert.equal(rows(f).length,100);assert.equal(f.nodes['fs-inventory-next'].disabled,false);const detached=rows(f)[0].querySelector('button');
  await f.nodes['fs-inventory-next'].click();assert.equal(rows(f).length,3);assert.equal(f.nodes['fs-inventory-next'].disabled,true);assert.equal(f.api.getState().inventory.offset,100);assert.match(f.nodes['fs-inventory-status'].textContent,/101–103 of 103/);
  await detached.click();assert.equal(f.api.getState().selected,null);
  f.nodes['fs-inventory-sort'].value='name';await f.nodes['fs-inventory-sort'].emit('change');const query=new URL(f.calls.at(-1).url,'http://fixture').searchParams;assert.equal(query.get('sort'),'name');assert.equal(query.get('offset'),'0');assert.equal(rows(f).length,100);
});
test('byte-limited short pages advance by returned count without skipping or duplicating paths',async()=>{
  const f=await load(async query=>{const offset=Number(query.get('offset'));return page(query,Array.from({length:Math.min(3,8-offset)},(_,i)=>item('file-'+(offset+i))),8);});
  await f.nodes['fs-inventory-browse'].click();assert.equal(rows(f).length,3);await f.nodes['fs-inventory-next'].click();assert.equal(f.api.getState().inventory.offset,3);await f.nodes['fs-inventory-next'].click();assert.equal(f.api.getState().inventory.offset,6);assert.equal(rows(f).length,2);assert.equal(f.nodes['fs-inventory-next'].disabled,true);await f.nodes['fs-inventory-previous'].click();assert.equal(f.api.getState().inventory.offset,3);await f.nodes['fs-inventory-previous'].click();assert.equal(f.api.getState().inventory.offset,0);
});
test('skipped links and unreadable names remain visible without browse, Explain, or cleanup authority',async()=>{
  const f=await load(async query=>page(query,[item('Link',{kind:'link',size:null,allocated_size:null,coverage_reason:'reparse_point'}),item('Denied',{kind:'unknown',size:null,allocated_size:null,coverage_reason:'permission_denied'})]));await f.nodes['fs-inventory-browse'].click();assert.equal(rows(f).length,2);assert.match(rows(f)[0].textContent,/Skipped link.*reparse_point/);assert.equal(rows(f)[0].querySelectorAll('button').length,1);const choices=f.choices.length;await select(f,'Denied');assert.equal(f.nodes['fs-selected-explain'].disabled,true);assert.equal(f.nodes['fs-selected-reveal'].disabled,true);assert.equal(f.choices.length,choices);assert.match(f.nodes.visualizerDetailsSize.textContent,/permission_denied/);
});
test('indexed folder navigation distinguishes unloaded and observed empty children without implying full coverage',async()=>{
  const f=await load(async query=>query.get('path')===root?page(query,[item('Unloaded',{kind:'directory',child_count:6,children_complete:true}),item('ObservedEmpty',{kind:'directory',child_count:0,children_complete:true}),item('Unknown',{kind:'directory'})]):page(query,[],0,{meta:{...metadata,acquisition_complete:false}}));
  await f.nodes['fs-inventory-browse'].click();assert.match(rows(f)[0].textContent,/6 indexed children · not loaded here/);assert.match(rows(f)[1].textContent,/No child entries observed within the scan policy/);assert.match(rows(f)[2].textContent,/empty status unconfirmed/);
  await rows(f)[0].querySelectorAll('button').find(button=>button.getAttribute('aria-label')==='Browse folder Unloaded').click();assert.equal(f.api.getState().inventory.path,root+'\\Unloaded');assert.equal(f.nodes['fs-inventory-up'].disabled,false);assert.match(f.nodes['fs-inventory-status'].textContent,/Check acquisition coverage before treating this folder as empty/);assert.match(f.nodes['fs-inventory-coverage'].textContent,/Partial or unconfirmed/);
  await f.nodes['fs-inventory-up'].click();assert.equal(f.api.getState().inventory.path,root);assert.equal(rows(f).length,3);
});
test('name search, extension filters, and largest files query the indexed scope with bounded pages',async()=>{
  const f=await load();f.nodes['fs-inventory-query'].value='unretained';await f.nodes['fs-inventory-search'].click();let query=new URL(f.calls.at(-1).url,'http://fixture').searchParams;assert.equal(query.get('mode'),'search');assert.equal(query.get('q'),'unretained');assert.equal(query.get('path'),root);
  f.nodes['fs-inventory-extension'].value='TXT';await f.nodes['fs-inventory-filter'].click();query=new URL(f.calls.at(-1).url,'http://fixture').searchParams;assert.equal(query.get('extension'),'.txt');assert.equal(query.has('q'),false);
  await f.nodes['fs-inventory-largest'].click();query=new URL(f.calls.at(-1).url,'http://fixture').searchParams;assert.equal(query.get('mode'),'largest');assert.equal(query.has('extension'),false);assert.equal(query.get('limit'),'100');assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('off-tree selection explains the indexed job and path without receiving cleanup authority',async()=>{
  const f=await load();await f.nodes['fs-inventory-browse'].click();const choices=f.choices.length;await select(f,'unretained.txt');assert.equal(f.api.getState().selected.actionable,false);assert.equal(f.choices.length,choices);assert.equal(f.nodes['fs-selected-explain'].disabled,false);assert.match(f.nodes.visualizerDetailsSize.textContent,/Indexed evidence.*Cleanup requires/);assert.equal(f.nodes['fs-selected-cleanup'].children.length,0);
  await f.nodes['fs-selected-explain'].click();assert.deepEqual(f.calls.at(-1).body,{job_id:job().id,question:'',selected_path:root+'\\unretained.txt'});assert.match(f.nodes['fs-investigation-result'].textContent,/observed in the index/);assert.equal(f.api.getState().observation.index.size,2);
});
test('malformed, cross-job, out-of-scope, and excessive pages never replace indexed evidence',async()=>{
  for(const corrupt of [p=>({...p,job_id:'another-job'}),p=>({...p,root:'D:\\'}),p=>({...p,items:[item('bad',{path:'C:\\outside.txt'})]}),p=>({...p,items:Array.from({length:101},(_,i)=>item('x'+i)),total:101}),p=>({...p,items:[item('child',{path:root+'\\nested\\child'})]}),p=>({...p,has_more:true})]){
    const f=await load(async query=>corrupt(page(query,[item('file')])));await f.nodes['fs-inventory-browse'].click();assert.equal(rows(f).length,0);assert.match(f.nodes['fs-inventory-status'].textContent,/Indexed paths unavailable/);assert.equal(f.api.getState().mapView.total,12);
  }
});
test('lock, changed locations, and paused requests cannot restore private indexed rows',async()=>{
  let finish;const f=await load(query=>new Promise(resolve=>{finish=()=>resolve(page(query,[item('private.bin')]));}));f.emit('tli-session-locked');finish();await new Promise(setImmediate);assert.equal(f.api.getState().inventory,null);assert.equal(f.nodes['fs-inventory'].hidden,true);assert.equal(f.nodes['fs-inventory-rows'].textContent,'');
  const g=await load(query=>new Promise(resolve=>{finish=()=>resolve(page(query,[item('old.bin')]));}));g.api.prepare('C:\\Elsewhere');finish();await new Promise(setImmediate);assert.equal(g.api.getState().inventory,null);assert.equal(g.nodes['fs-inventory-rows'].textContent,'');
  const h=await load(query=>new Promise(resolve=>{finish=()=>resolve(page(query,[item('paused.bin')]));}));await h.visibility(true);finish();await new Promise(setImmediate);await h.visibility(false);assert.equal(h.api.getState().inventory.busy,false);assert.equal(rows(h).length,0);assert.equal(h.nodes['fs-inventory-browse'].disabled,false);
});
test('indexed rows announce selection and support arrow, Home, and End navigation',async()=>{
  const f=await load(async query=>page(query,[item('first.txt'),item('second.txt'),item('third.txt')]));
  await select(f,'first.txt');assert.equal(rows(f)[0].getAttribute('aria-selected'),'true');assert.equal(rows(f)[1].getAttribute('aria-selected'),'false');
  await rows(f)[0].emit('keydown',{key:'ArrowDown'});assert.equal(f.api.getState().selected.name,'second.txt');assert.equal(rows(f)[1].getAttribute('aria-selected'),'true');assert.equal(f.document.activeElement,rows(f)[1]);
  await rows(f)[1].emit('keydown',{key:'End'});assert.equal(f.api.getState().selected.name,'third.txt');
  await rows(f)[2].emit('keydown',{key:'Home'});assert.equal(f.api.getState().selected.name,'first.txt');assert.equal(f.calls.length,3);
});
test('clearing or escaping an indexed search restores folder contents and clears stale selection',async()=>{
  const f=await load(async query=>page(query,query.get('mode')==='search'?[item('needle.txt')]:[item('first.txt'),item('needle.txt')]));
  f.nodes['fs-inventory-query'].value='needle';await f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});assert.equal(rows(f).length,1);await select(f,'needle.txt');
  f.nodes['fs-inventory-query'].value='';await f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});assert.equal(rows(f).length,2);assert.equal(f.api.getState().inventory.mode,'children');assert.equal(f.api.getState().selected,null);assert.equal(f.nodes.visualizerDetailsBar.hidden,true);
  f.nodes['fs-inventory-query'].value='needle';await f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});await f.nodes['fs-inventory-query'].emit('keydown',{key:'Escape'});assert.equal(f.nodes['fs-inventory-query'].value,'');assert.equal(f.api.getState().inventory.mode,'children');assert.equal(rows(f).length,2);
});
test('folder Enter and breadcrumbs browse recorded children without starting another scan',async()=>{
  const f=await load(async query=>query.get('path')===root?page(query,[item('Folder',{kind:'directory',child_count:1,children_complete:true})]):page(query,[item('inside.txt',{path:root+'\\Folder\\inside.txt'})]));
  await rows(f)[0].emit('keydown',{key:'Enter'});await new Promise(setImmediate);assert.equal(f.api.getState().inventory.path,root+'\\Folder');assert.equal(rows(f)[0].querySelector('.storage-file-action').textContent,'inside.txt');
  const crumbs=f.nodes['fs-inventory-breadcrumbs'].querySelectorAll('button');assert.equal(crumbs.length,2);await crumbs[0].click();assert.equal(f.api.getState().inventory.path,root);assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('new indexed requests suppress stale results and empty results clear the inspector',async()=>{
  let release;const f=await load(query=>query.get('q')==='slow'?new Promise(resolve=>{release=()=>resolve(page(query,[item('obsolete.txt')]));}):Promise.resolve(page(query,query.get('q')==='nothing'?[]:[item('current.txt')])));
  await select(f,'current.txt');f.nodes['fs-inventory-query'].value='slow';const old=f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});await new Promise(setImmediate);assert.equal(f.api.getState().selected,null);
  f.nodes['fs-inventory-query'].value='nothing';await f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});release();await old;assert.equal(rows(f).length,0);assert.equal(f.api.getState().inventory.total,0);assert.match(f.nodes['fs-inventory-status'].textContent,/No .*match|0.*matches/i);assert.equal(f.nodes.visualizerDetailsBar.hidden,true);
});
test('context actions keep the visible inspector bound to the selected indexed path',async()=>{
  const f=await load(async query=>page(query,[item('first.txt'),item('second.txt')]));await select(f,'first.txt');
  await rows(f)[1].emit('contextmenu',{clientX:10,clientY:10});assert.equal(f.api.getState().selected.path,root+'\\second.txt');assert.equal(f.nodes.visualizerDetailsPath.textContent,root+'\\second.txt');
  await f.nodes['fs-entry-menu'].emit('keydown',{key:'Escape'});assert.equal(f.nodes.visualizerDetailsPath.textContent,f.api.getState().selected.path);
});
test('interrupted indexed searches expose a retry state instead of claiming an inactive request is loading',async()=>{
  let release;const f=await load(query=>query.get('q')==='waiting'?new Promise(resolve=>{release=()=>resolve(page(query,[item('late.txt')]));}):Promise.resolve(page(query,[item('current.txt')])));
  await f.panel('panel-visualizer');f.nodes['fs-inventory-query'].value='waiting';const pending=f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});await new Promise(setImmediate);
  await f.visibility(true);release();await pending;await f.visibility(false);assert.equal(f.api.getState().inventory.busy,false);assert.doesNotMatch(f.nodes['fs-inventory-status'].textContent,/Loading recorded files/);assert.match(f.nodes['fs-inventory-status'].textContent,/paused|retry|Enter/i);assert.equal(rows(f).length,0);
});
test('returning from another storage tool rebinds cached rows without a rescan or extra index request',async()=>{
  const f=await load(async query=>page(query,[item('first.txt'),item('second.txt')]));const detached=rows(f)[0].querySelector('.storage-file-action'),calls=f.calls.length;
  await f.tabs[1].click();await f.tabs[0].click();await detached.click();assert.equal(f.api.getState().selected,null);
  await select(f,'second.txt');assert.equal(f.api.getState().selected.path,root+'\\second.txt');assert.equal(rows(f)[1].getAttribute('aria-selected'),'true');assert.equal(f.calls.length,calls);
});
test('leaving Free Space cancels a pending search debounce without making a background query',async()=>{
  const f=await load();await f.panel('panel-visualizer');const calls=f.calls.length;f.nodes['fs-inventory-query'].value='not-submitted';await f.nodes['fs-inventory-query'].emit('input');assert.ok([...f.timers.values()].some(timer=>timer.ms===250));
  await f.panel('panel-main');assert.equal([...f.timers.values()].some(timer=>timer.ms===250),false);assert.equal(f.calls.length,calls);
});
test('switching storage tools during a query shows retry state instead of old rows under new search text',async()=>{
  let release;const f=await load(query=>query.get('q')==='pending'?new Promise(resolve=>{release=()=>resolve(page(query,[item('late.txt')]));}):Promise.resolve(page(query,[item('old.txt')])));
  f.nodes['fs-inventory-query'].value='pending';const pending=f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});await new Promise(setImmediate);await f.tabs[1].click();await f.tabs[0].click();release();await pending;
  assert.equal(rows(f).length,0);assert.equal(f.api.getState().inventory.busy,false);assert.match(f.nodes['fs-inventory-status'].textContent,/paused|retry|continue/i);assert.equal(f.nodes['fs-inventory-query'].value,'pending');
});
test('indexed retained-file review explicitly switches to the retained evidence before exposing cleanup choice',async()=>{
  const f=await load(async query=>page(query,[item('a.txt',{size:999})]));await select(f,'a.txt');assert.equal(f.api.getState().selected.actionable,false);assert.equal(f.nodes['fs-selected-cleanup'].querySelectorAll('input').length,0);
  const review=f.nodes['fs-selected-cleanup'].querySelectorAll('button').find(button=>button.textContent==='Review recorded file');assert.ok(review);const choices=f.choices.length;await review.click();
  assert.equal(f.api.getState().browserView,'tree');assert.equal(f.api.getState().selected.inventoryJob,undefined);assert.equal(f.api.getState().selected.size,12);assert.ok(f.choices.length>choices);assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
});
test('rapid typing disables paging and sorting until the new query replaces previous results',async()=>{
  const f=await load(async query=>page(query,[item((query.get('q')||'base')+'.txt')],3));
  f.nodes['fs-inventory-query'].value='old';await f.nodes['fs-inventory-query'].emit('keydown',{key:'Enter'});assert.equal(f.nodes['fs-inventory-next'].disabled,false);
  const calls=f.calls.length;f.nodes['fs-inventory-query'].value='new';await f.nodes['fs-inventory-query'].emit('input');
  for(const id of ['fs-inventory-next','fs-inventory-previous','fs-inventory-sort','fs-inventory-order'])assert.equal(f.nodes[id].disabled,true,id);
  await f.nodes['fs-inventory-next'].click();assert.equal(f.calls.length,calls);
  const [id,timer]=[...f.timers].find(([,timer])=>timer.ms===250);f.timers.delete(id);timer.fn();await new Promise(setImmediate);
  const query=new URL(f.calls.at(-1).url,'http://fixture').searchParams;assert.equal(query.get('q'),'new');assert.equal(query.get('offset'),'0');assert.equal(f.nodes['fs-inventory-query'].value,'new');assert.match(f.nodes['fs-inventory-rows'].textContent,/new\.txt/);assert.equal(f.nodes['fs-inventory-sort'].disabled,false);
});
test('leaving and returning during pending typing exposes a retry state with no old-query rows',async()=>{
  for(const via of ['tool','panel']){
    const f=await load();await f.panel('panel-visualizer');const calls=f.calls.length;f.nodes['fs-inventory-query'].value='pending-draft';await f.nodes['fs-inventory-query'].emit('input');
    if(via==='tool'){await f.tabs[1].click();await f.tabs[0].click();}else{await f.panel('panel-main');await f.panel('panel-visualizer');}
    assert.equal([...f.timers.values()].some(timer=>timer.ms===250),false);assert.equal(f.calls.length,calls);assert.equal(f.api.getState().inventory.busy,false);assert.equal(rows(f).length,0);assert.equal(f.nodes['fs-inventory-query'].value,'pending-draft');assert.match(f.nodes['fs-inventory-status'].textContent,/paused|retry|continue/i);
  }
});
test('native progress counters keep record and byte units without inventing a percentage',async()=>{
  const pending=job({status:'running',result_available:false,progress:{phase:'scanning',records_examined:400,bytes_read:8192}}),f=fixture(async()=>envelope(pending));f.api.prepare(root);await f.api.start();assert.match(f.nodes['fs-job-progress'].textContent,/400 native records examined.*8 KiB native data read/);assert.doesNotMatch(f.nodes['fs-job-progress'].textContent,/400 entries|%/);
});
