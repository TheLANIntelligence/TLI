const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fixture, job, envelope, scan, root} = require('./helpers/free-space-fixture.cjs');

function sample() {
  return scan({tree:{name:'Downloads',path:root,size:1000,children:[
    {name:'system.sys',path:root+'\\system.sys',size:600,protected:true},
    {name:'Media',path:root+'\\Media',size:200,children:[
      {name:'disk.vhdx',path:root+'\\Media\\disk.vhdx',size:150},
      {name:'film.mp4',path:root+'\\Media\\film.mp4',size:50},
    ]},
    {name:'empty.txt',path:root+'\\empty.txt',size:0},
    {name:'unknown.txt',path:root+'\\unknown.txt',size:null},
  ],omitted_bytes:200,omitted_entries:12}});
}
function realCleanup(f) {
  delete f.window.TLIStorageCleanup;
  f.document.readyState='complete';
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/storage-cleanup.js'),'utf8'),f.ctx);
  f.document.readyState='loading';
}
async function loaded(data=sample(), withCleanup=false) {
  const j=job(), f=fixture(async url=>url.endsWith('/results')?envelope(j,data):envelope(j));
  if(withCleanup)realCleanup(f);
  f.api.prepare(root);await f.api.start();
  assert.ok(f.api.getState().observation);
  await f.nodes['fs-tree-expand'].click();
  return f;
}
function menu(f) { return f.document.getElementById('fs-entry-menu'); }
function action(box,label) { const result=box?.querySelectorAll('button').find(n=>n.textContent===label);assert.ok(result,`Action exists: ${label}`);return result; }
function tile(f,name) {const result=f.nodes['vis4-treemap-container'].querySelectorAll('.fs-map-item').find(n=>n.getAttribute('aria-label')?.startsWith(name+' ·')||n.title?.startsWith(name+'\n'));assert.ok(result,`Tile exists: ${name}`);return result;}
function row(f,name) {const result=f.nodes.visualizerTableBody.children.find(n=>n.querySelectorAll('button').some(b=>b.textContent===name));assert.ok(result,`List entry exists: ${name}`);return result;}
async function rightClick(f,name) {await tile(f,name).emit('contextmenu',{clientX:80,clientY:100});assert.ok(menu(f));return menu(f);}
function noHostActions(f,before=2) {assert.equal(f.calls.length,before);assert.deepEqual(f.navigation,[]);assert.equal(f.calls.some(c=>/delete|cleanup|open|reveal|ai\/chat/.test(c.url)),false);}

test('drive selection gates the real cleanup review and restores its selection without retaining approval',async()=>{
  const j=job();const f=fixture(async(url,options)=>{
    if(url==='/visualizer/cleanup/preview'){const files=JSON.parse(options.body).files;return {ok:true,preview_id:'cleanup-review-c',can_execute:true,total_bytes:150,items:files,space_note:'Review only'};}
    return url.endsWith('/results')?envelope(j,sample()):envelope(j);
  });f.ctx.AbortSignal=AbortSignal;realCleanup(f);f.api.prepare(root);await f.api.start();await f.nodes['fs-tree-expand'].click();
  const choice=row(f,'disk.vhdx').querySelector('input');choice.checked=true;await choice.emit('change');await f.nodes['cleanup-check'].click();assert.equal(f.nodes['cleanup-execute'].disabled,false);const requests=f.calls.length;
  f.api.prepare('E:\\');assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,1);assert.equal(f.nodes['cleanup-check'].disabled,true);assert.equal(f.nodes['cleanup-execute'].hidden,true);assert.match(f.nodes['cleanup-count'].textContent,/Selection from C:/);f.api.openCleanup();await f.nodes['cleanup-execute'].emit('click');assert.equal(f.calls.length,requests);
  await f.visibility(true);await f.visibility(false);await f.nodes['cleanup-check'].emit('click');assert.equal(f.calls.length,requests);f.api.prepare(root);assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,1);assert.equal(f.nodes['cleanup-check'].disabled,false);assert.equal(f.nodes['cleanup-execute'].hidden,true);
});

test('right-click works on map tiles and list rows, with exact paths and no automatic operation',async()=>{
  const f=await loaded();
  const e=await tile(f,'disk.vhdx').emit('contextmenu',{clientX:100,clientY:140});
  assert.equal(e.defaultPrevented,true);assert.equal(e.stopped,true);
  assert.equal(menu(f).getAttribute('role'),'dialog');assert.match(menu(f).textContent,/Disk images/);
  assert.equal(f.api.getState().selected.path,root+'\\Media\\disk.vhdx');
  await action(menu(f),'Close actions').click();assert.equal(menu(f),null);
  const list=row(f,'film.mp4');await list.emit('contextmenu');
  assert.match(menu(f).textContent,/film\.mp4/);
  assert.equal(f.api.getState().selected.path,root+'\\Media\\film.mp4');
  await action(menu(f),'Inspect details').click();assert.equal(f.nodes.visualizerDetailsPath.textContent,root+'\\Media\\film.mp4');
  noHostActions(f);
});

test('keyboard context menu, focus navigation and Escape return focus to the original tile',async()=>{
  const f=await loaded(), invoker=tile(f,'disk.vhdx');invoker.focus();
  const e=await invoker.emit('keydown',{key:'F10',shiftKey:true});
  assert.equal(e.defaultPrevented,true);
  const box=menu(f), buttons=box.querySelectorAll('button');assert.equal(f.document.activeElement,buttons[0]);
  await buttons[0].emit('keydown',{key:'End'});assert.equal(f.document.activeElement,buttons.at(-1));
  await buttons.at(-1).emit('keydown',{key:'Tab'});assert.equal(f.document.activeElement,buttons[0]);
  await buttons[0].emit('keydown',{key:'ArrowDown'});assert.equal(f.document.activeElement,buttons[1]);
  await buttons[1].emit('keydown',{key:'Home'});assert.equal(f.document.activeElement,buttons[0]);
  await buttons[0].emit('keydown',{key:'Escape'});assert.equal(menu(f),null);assert.equal(f.document.activeElement,invoker);
  await invoker.emit('keydown',{key:'ContextMenu'});assert.ok(menu(f));noHostActions(f);
});

test('visible action-menu buttons have an accessible name and support touch and keyboard',async()=>{
  const f=await loaded(), list=row(f,'film.mp4');
  const more=list.querySelectorAll('button').find(button=>button.getAttribute('aria-label')==='Actions for film.mp4');
  assert.ok(more);assert.equal(more.textContent,'⋯');assert.equal(more.getAttribute('aria-haspopup'),'dialog');
  await more.click();assert.match(menu(f).textContent,/film\.mp4/);
  await action(menu(f),'Close actions').click();assert.equal(f.document.activeElement,more);
  await action(list,'film.mp4').emit('keydown',{key:'ContextMenu'});assert.match(menu(f).textContent,/film\.mp4/);
  noHostActions(f);
});

test('an offscreen map menu retains its target without scrolling until details are explicitly requested',async()=>{
  const data=scan();data.tree.children=Array.from({length:150},(_,i)=>({name:'file-'+i+'.bin',path:root+'\\file-'+i+'.bin',size:1}));data.tree.size=150;
  const f=await loaded(data);const target=tile(f,'file-99.bin');await target.emit('contextmenu');
  assert.match(menu(f).textContent,/file-99\.bin/);assert.equal(f.nodes['fs-table-wrap'].scrollTop,0);
  await action(menu(f),'Copy path').click();assert.deepEqual(f.clipboard,[root+'\\file-99.bin']);
  assert.equal(target.isConnected,true);assert.equal(f.document.activeElement,target);
  await target.emit('contextmenu');await action(menu(f),'Inspect details').click();
  assert.ok(f.nodes['fs-table-wrap'].scrollTop>0);assert.equal(f.nodes.visualizerDetailsPath.textContent,root+'\\file-99.bin');assert.equal(row(f,'file-99.bin').getAttribute('aria-selected'),'true');
  assert.equal(target.isConnected,true);noHostActions(f);
});

test('closed menu buttons and detached cleanup controls cannot change the selection',async()=>{
  const f=await loaded(sample(),true), box=await rightClick(f,'disk.vhdx');
  const hide=action(box,'Hide from this view'), copy=action(box,'Copy path'), input=box.querySelector('input');assert.ok(input);
  await action(box,'Close actions').click();assert.equal(input.disabled,true);assert.equal(box.isConnected,false);
  await hide.click();await copy.click();input.checked=true;const e=await input.emit('change');
  assert.equal(e.defaultPrevented,true);assert.equal(e.immediate,true);
  assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,0);
  assert.equal(f.api.getState().mapView.hiddenCount,0);assert.deepEqual(f.clipboard,[]);noHostActions(f);
});

for(const scenario of ['lock','background','panel','tool tab','resize','background wheel','outside pointer','filter']){
  test(`${scenario} invalidates an open menu and prevents delayed actions after returning`,async()=>{
    const f=await loaded(sample(),true), box=await rightClick(f,'disk.vhdx');
    const copy=action(box,'Copy path'), prepare=action(box,'Prepare folder scan'), input=box.querySelector('input');
    if(scenario==='lock'){f.emit('tli-session-locked');f.emit('tli-session-unlocked');}
    if(scenario==='background'){await f.visibility(true);await f.visibility(false);}
    if(scenario==='panel'){await f.panel('panel-main');await f.panel('panel-visualizer');}
    if(scenario==='tool tab'){await f.tabs.find(n=>n.dataset.fsTab==='large_files').click();await f.tabs[0].click();}
    if(scenario==='resize')f.emit('resize');
    if(scenario==='background wheel')await f.documentEvent('wheel');
    if(scenario==='outside pointer')await f.documentEvent('pointerdown');
    if(scenario==='filter'){f.nodes.visualizerSearchInput.value='film';await f.nodes.visualizerSearchInput.emit('input');}
    assert.equal(menu(f),null);assert.equal(box.isConnected,false);assert.equal(input.disabled,true);
    const previous=f.nodes.visualizerPathInput.value;await copy.click();await prepare.click();input.checked=true;await input.emit('change');
    assert.deepEqual(f.clipboard,[]);assert.equal(f.nodes.visualizerPathInput.value,previous);
    assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,0);noHostActions(f);
  });
}

test('queued programmatic scroll leaves the newly opened menu usable without requests',async()=>{
  const f=await loaded(), box=await rightClick(f,'disk.vhdx');
  await f.documentEvent('scroll');
  assert.equal(menu(f),box);assert.equal(box.isConnected,true);
  await action(box,'Copy path').click();
  assert.deepEqual(f.clipboard,[root+'\\Media\\disk.vhdx']);assert.equal(menu(f),null);noHostActions(f);
});

test('replacement start closes actions immediately; failed replacement retains the original map and rejects old actions',async()=>{
  let fail=false;const j=job(), f=fixture(async url=>{if(fail)throw Error('Offline');return url.endsWith('/results')?envelope(j,sample()):envelope(j);});
  f.api.prepare(root);await f.api.start();const before=f.api.getState().observation, box=await rightClick(f,'disk.vhdx');
  const copy=action(box,'Copy path');fail=true;const pending=f.api.start();assert.equal(menu(f),null);await pending;
  assert.equal(f.api.getState().observation,before);assert.equal(f.api.getState().mapView.total,1000);
  await copy.click();assert.deepEqual(f.clipboard,[]);noHostActions(f,3);
});

test('successful replacement makes detached old map tiles and menu actions inert',async()=>{
  let data=sample(), j=job();const f=fixture(async url=>url.endsWith('/results')?envelope(j,data):envelope(j));f.api.prepare(root);await f.api.start();
  const oldTile=tile(f,'disk.vhdx'), box=await rightClick(f,'disk.vhdx'), hide=action(box,'Hide from this view');
  data=scan();j=job({id:'b'.repeat(32)});await f.api.start();await oldTile.emit('contextmenu');await hide.click();
  assert.equal(menu(f),null);assert.equal(f.api.getState().mapView.total,12);assert.equal(f.api.getState().selected,null);noHostActions(f,4);
});

test('protected files and grouped bytes keep truthful details and cannot become cleanup candidates',async()=>{
  const f=await loaded(sample(),true);let box=await rightClick(f,'system.sys');
  assert.match(box.textContent,/Protected location/);assert.equal(box.querySelector('input').disabled,true);
  await action(box,'Copy path').click();assert.deepEqual(f.clipboard,[root+'\\system.sys']);
  box=await rightClick(f,'Other indexed contents');assert.match(box.textContent,/individual paths were not retained/);
  assert.equal(box.querySelector('input'),null);
  assert.equal(box.querySelectorAll('button').some(n=>['Copy path','Review folder in Files','Review selected files'].includes(n.textContent)),false);
  await action(box,'Prepare folder scan').click();assert.equal(f.nodes.visualizerPathInput.value,root);
  assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,0);noHostActions(f);
});

test('hiding a giant tile and grouped bytes preserves reviewed file selections and observed totals; reset is local',async()=>{
  const f=await loaded(sample(),true), box=await rightClick(f,'disk.vhdx'), input=box.querySelector('input');input.checked=true;await input.emit('change');
  assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,1);await action(box,'Close actions').click();
  await action(await rightClick(f,'system.sys'),'Hide from this view').click();
  assert.equal(f.api.getState().mapView.total,400);assert.equal(f.api.getState().mapView.hiddenBytes,600);
  await action(f.nodes['vis4-treemap-container'],'Hide grouped bytes').click();
  assert.equal(f.api.getState().mapView.total,200);assert.equal(f.api.getState().mapView.scopeTotal,1000);
  assert.equal(f.api.getState().mapView.hiddenCount,2);assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,1);
  await action(f.nodes['fs-map-hidden'],'Show hidden entries').click();
  assert.equal(f.api.getState().mapView.total,1000);assert.equal(f.api.getState().mapView.hiddenCount,0);
  assert.equal(f.window.TLIStorageCleanup.getSelectionState().count,1);noHostActions(f);
});

test('preparing a folder scan hides another scope; returning restores local double-click navigation',async()=>{
  const f=await loaded(), before=f.api.getState().observation;
  await action(await rightClick(f,'disk.vhdx'),'Prepare folder scan').click();
  assert.equal(f.nodes.visualizerPathInput.value,root+'\\Media');assert.equal(f.api.getState().observation,before);
  assert.equal(f.api.getState().focus,root);
  assert.equal(f.nodes['storage-results'].hidden,true);assert.equal(f.api.getState().mapView,null);
  f.api.prepare(root);assert.equal(f.nodes['storage-results'].hidden,false);
  await tile(f,'disk.vhdx').emit('dblclick');assert.equal(f.api.getState().focus,root+'\\Media');
  assert.equal(f.api.getState().mapView.total,200);noHostActions(f);
});

test('reviewed Files handoff preserves a different folder draft and never scans or opens a host file',async()=>{
  const f=await loaded();f.nodes.filesRootInput.value='D:\\Existing draft';
  await action(await rightClick(f,'disk.vhdx'),'Review folder in Files').click();
  assert.equal(f.nodes['fs-handoff'].open,true);assert.equal(f.nodes['fs-handoff-text'].textContent,root+'\\Media');
  await f.nodes['fs-handoff-confirm'].click();assert.equal(f.nodes.filesRootInput.value,'D:\\Existing draft');
  assert.match(f.nodes['fs-handoff-status'].textContent,/preserved/);noHostActions(f);
  await f.nodes['fs-handoff-close'].click();f.nodes.filesRootInput.value='';
  await action(await rightClick(f,'disk.vhdx'),'Review folder in Files').click();await f.nodes['fs-handoff-confirm'].click();
  assert.equal(f.nodes.filesRootInput.value,root+'\\Media');assert.deepEqual(f.navigation,['panel-files']);assert.equal(f.calls.length,2);
});

test('clipboard completion after locking cannot recreate private status or stale paths',async()=>{
  const f=await loaded();let done;f.ctx.navigator.clipboard.writeText=()=>new Promise(resolve=>{done=resolve;});
  await action(await rightClick(f,'disk.vhdx'),'Copy path').click();f.emit('tli-session-locked');const status=f.nodes.visualizerStatus.textContent;
  done();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.nodes.visualizerStatus.textContent,status);
  assert.equal(f.nodes.visualizerDetailsPath.textContent,'');assert.equal(menu(f),null);noHostActions(f);
});

async function revealFixture(reveal=async()=>({status:'ok'}),data=sample()){
  const j=job(),f=fixture(async(url,options)=>url==='/open_reveal'?reveal(options):url.endsWith('/results')?envelope(j,data):envelope(j));
  f.api.prepare(root);await f.api.start();await f.nodes['fs-tree-expand'].click();return f;
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('file reveal is explicit, targets the recorded path on the host, and never opens the file itself',async()=>{
  const name='disk, image & backup.vhdx',filePath=root+'\\'+name;
  const f=await revealFixture(undefined,scan({tree:{name:'Downloads',path:root,size:12,children:[{name,path:filePath,size:12}]}}));
  const box=await rightClick(f,name);assert.match(box.textContent,/Opens on the TLI host \(Fixture host\)/);noHostActions(f);
  await action(box,'Show in File Explorer').click();await settle();
  const request=f.calls.at(-1);assert.equal(request.url,'/open_reveal');assert.deepEqual(request.body,{path:filePath});
  assert.equal(request.options.method,'POST');assert.equal(request.options.credentials,'same-origin');
  assert.equal(menu(f),null);assert.match(f.nodes.visualizerStatus.textContent,/Requested File Explorer on the TLI host/);
  assert.equal(f.calls.some(call=>call.url==='/open_path'),false);
});

test('folder and file list actions use the same explicit reveal endpoint',async()=>{
  const f=await revealFixture();
  await row(f,'Media').emit('contextmenu');await action(menu(f),'Open folder in File Explorer').click();await settle();
  assert.deepEqual(f.calls.at(-1).body,{path:root+'\\Media'});
  await row(f,'film.mp4').emit('contextmenu');
  await action(menu(f),'Show in File Explorer').click();await settle();assert.deepEqual(f.calls.at(-1).body,{path:root+'\\Media\\film.mp4'});
});

test('missing paths and unconfirmed reveal responses show failure without retrying',async()=>{
  for(const response of [{ok:false,status:404,json:async()=>({detail:'The file no longer exists.'})},{status:'unknown'}]){
    const f=await revealFixture(async()=>response);await action(await rightClick(f,'disk.vhdx'),'Show in File Explorer').click();await settle();
    assert.match(f.nodes.visualizerStatus.textContent,/Could not show this location/);
    assert.equal(f.calls.filter(call=>call.url==='/open_reveal').length,1);
  }
});

test('pending reveal cannot launch duplicates and its completion cannot restore private status after locking',async()=>{
  let finish;const f=await revealFixture(()=>new Promise(resolve=>{finish=resolve;}));
  await action(await rightClick(f,'disk.vhdx'),'Show in File Explorer').click();
  const duplicate=action(await rightClick(f,'film.mp4'),'Show in File Explorer');assert.equal(duplicate.disabled,true);await duplicate.click();
  assert.equal(f.calls.filter(call=>call.url==='/open_reveal').length,1);
  f.emit('tli-session-locked');const previous=f.nodes.visualizerStatus.textContent;
  finish({status:'ok'});await settle();assert.equal(f.nodes.visualizerStatus.textContent,previous);
});

test('stale reveal buttons and grouped placeholders cannot launch a host file manager',async()=>{
  const f=await revealFixture();const old=action(await rightClick(f,'disk.vhdx'),'Show in File Explorer');
  await action(menu(f),'Close actions').click();await old.click();
  const grouped=await rightClick(f,'Other indexed contents');
  assert.equal(grouped.querySelectorAll('button').some(n=>/File Explorer/.test(n.textContent)),false);
  noHostActions(f);
});

test('Mac host folders describe Finder reveal rather than opening their contents',async()=>{
  const f=await revealFixture();f.ctx._tliIsWindows=()=>false;f.ctx._tliIsMac=()=>true;
  await row(f,'Media').emit('contextmenu');
  await action(menu(f),'Show in Finder').click();await settle();
  assert.deepEqual(f.calls.at(-1).body,{path:root+'\\Media'});
});
