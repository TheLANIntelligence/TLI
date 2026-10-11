const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,job,envelope,scan,root}=require('./helpers/free-space-fixture.cjs');
const nested=()=>scan({tree:{name:'Downloads',path:root,size:120,files:4,children:[
 {name:'A',path:root+'\\A',size:80,files:3,children:[{name:'B',path:root+'\\A\\B',size:70,files:2,children:[{name:'big.txt',path:root+'\\A\\B\\big.txt',size:60},{name:'small.bin',path:root+'\\A\\B\\small.bin',size:10}]},{name:'photo.png',path:root+'\\A\\photo.png',size:10}]},
 {name:'top.txt',path:root+'\\top.txt',size:40}
]}});
async function load(data=nested(),extra){const j=job(),f=fixture(async(url,options)=>{const custom=extra?await extra(url,options):undefined;return custom===undefined?url.endsWith('/results')?envelope(j,data):envelope(j):custom;});f.api.prepare(root);await f.api.start();return f;}
const rows=f=>f.nodes.visualizerTableBody.querySelectorAll('.fs-tree-row');
const row=(f,name)=>rows(f).find(row=>row.querySelector('.storage-file-action')?.textContent===name);
const choose=(f,name)=>row(f,name).querySelector('.storage-file-action').click();

test('map selection expands exact ancestors, reveals one row, and uses recorded parent percentage',async()=>{
 const f=await load();assert.equal(f.api.getState().treeRows.length,2);const selected=[];f.window.TLIStorageHistory.selectPath=value=>selected.push(value);
 const tile=f.nodes['vis4-treemap-container'].querySelectorAll('.fs-map-item').find(mark=>mark.dataset.mapKey===root+'\\A\\B\\big.txt');await tile.click();
 assert.ok(f.api.getState().expanded.has(root+'\\A'));assert.ok(f.api.getState().expanded.has(root+'\\A\\B'));const target=row(f,'big.txt');assert.equal(target.getAttribute('aria-level'),'3');assert.equal(target.getAttribute('aria-selected'),'true');assert.equal(target.children[4].textContent,'85.71%');assert.equal(target.children[4].style['--fs-parent-percent'],(60/70*100)+'%');
 assert.equal(selected.at(-1),root+'\\A\\B\\big.txt');assert.match(f.nodes.visualizerDetailsSize.textContent,/Modified unknown.*Observed/);assert.equal(f.calls.length,2);
});
test('filters retain ancestors and preserve unfiltered extension distribution and manual expansion',async()=>{
 const f=await load();const types=()=>f.nodes.visualizerTypeBars.querySelectorAll('[data-extension]');assert.equal(types().length,3);
 await types().find(row=>row.dataset.extension==='.txt').click();assert.equal(f.api.getState().mapView.total,100);assert.equal(types().length,3);assert.match(f.nodes.visualizerTypeBars.textContent,/4 retained file paths/);assert.deepEqual(Array.from(f.api.getState().treeRows,row=>row.item.name),['A','B','big.txt','top.txt']);
 assert.equal(f.api.getState().expanded.size,0);await f.nodes.visualizerTypeBars.querySelectorAll('button').find(button=>button.textContent==='Clear extension filter').click();assert.equal(f.api.getState().treeRows.length,2);assert.equal(f.api.getState().mapView.total,120);assert.equal(f.calls.length,2);
});
test('keyboard arrows expand and select, Enter drills folder and sorting stays within siblings',async()=>{
 const f=await load();await row(f,'A').emit('keydown',{key:'ArrowRight'});assert.ok(row(f,'B'));await row(f,'A').emit('keydown',{key:'ArrowDown'});assert.equal(f.api.getState().selected.name,'B');await row(f,'B').emit('keydown',{key:'ArrowRight'});assert.ok(row(f,'big.txt'));await f.sorts[0].children[0].click();assert.deepEqual(Array.from(f.api.getState().treeRows,row=>row.item.name),['A','B','big.txt','small.bin','photo.png','top.txt']);
 await row(f,'B').emit('keydown',{key:'Enter'});assert.equal(f.api.getState().focus,root+'\\A\\B');assert.equal(f.api.getState().mapView.total,70);assert.equal(f.calls.length,2);
});
test('virtual scroll preserves a focused checkbox and bounded DOM even when its row leaves the window',async()=>{
 const data=scan();data.tree.children=Array.from({length:2000},(_,i)=>({name:'file-'+i+'.txt',path:root+'\\file-'+i+'.txt',size:1}));data.tree.size=2000;const f=await load(data);f.window.TLIStorageCleanup.choice=()=>{const label=new f.El('label'),input=new f.El('input');label.append(input);return label;};await f.sorts[0].children[0].click();
 const target=rows(f).at(-1),input=target.querySelector('input');input.focus();f.nodes['fs-table-wrap'].scrollTop=44*1900;await f.nodes['fs-table-wrap'].emit('scroll');assert.equal(input.isConnected,true);assert.equal(f.document.activeElement,input);assert.ok(rows(f).length<=38);assert.equal(f.nodes['fs-tree-table'].getAttribute('aria-rowcount'),'2001');
 await target.emit('keydown',{key:'End',target});assert.equal(f.api.getState().selected.name,'file-999.txt');assert.equal(f.calls.length,2);
});
test('many unique extensions remain bounded with complete denominator and local page controls',async()=>{
 const data=scan();data.tree.children=Array.from({length:3000},(_,i)=>({name:'file.x'+i,path:root+'\\file.x'+i,size:1}));data.tree.size=3000;const f=await load(data);assert.equal(f.nodes.visualizerTypeBars.querySelectorAll('.fs-extension-row').length,80);assert.match(f.nodes.visualizerTypeBars.textContent,/3,000 retained file paths/);assert.equal(f.api.getState().mapView.total,3000);
 await f.nodes.visualizerTypeBars.querySelectorAll('button').find(button=>button.textContent==='Next extensions').click();assert.equal(f.nodes.visualizerTypeBars.querySelectorAll('.fs-extension-row').length,80);assert.match(f.nodes.visualizerTypeBars.textContent,/81–160 of 3000/);assert.equal(f.calls.length,2);
});
test('selected explanation binds receipt and path and discards responses after changing selection',async()=>{
 let finish;const f=await load(nested(),url=>url==='/visualizer/investigate'?new Promise(resolve=>{finish=resolve;}):undefined);await choose(f,'top.txt');const pending=f.nodes['fs-selected-explain'].click();await new Promise(setImmediate);assert.deepEqual(f.calls.at(-1).body,{job_id:job().id,question:'',selected_path:root+'\\top.txt'});
 await choose(f,'A');finish({ok:true,protocol:'storage-investigation-v1',local_only:true,reply:'Old selected file answer',evidence:{root,job_id:job().id,selected_path:root+'\\top.txt'},recommendations:[]});await pending;assert.equal(f.nodes['fs-investigation-result'].textContent,'');assert.equal(f.nodes['fs-selected-explain'].disabled,false);
 const next=f.nodes['fs-selected-explain'].click();await new Promise(setImmediate);finish({ok:true,protocol:'storage-investigation-v1',local_only:true,reply:'Wrong path answer',evidence:{root,job_id:job().id,selected_path:root+'\\top.txt'},recommendations:[]});await next;assert.match(f.nodes['fs-investigation-status'].textContent,/did not confirm evidence for the selected path/);assert.equal(f.nodes['fs-investigation-result'].textContent,'');
});
test('Changes and responsive view controls are local, pane ratio clamps, and lock clears every new private index',async()=>{
 const f=await load();const changes=[];f.window.TLIStorageHistory.selectPath=value=>changes.push(value);await choose(f,'top.txt');await f.nodes['fs-show-changes'].click();assert.equal(f.api.getState().tab,'history');assert.equal(changes.at(-1),root+'\\top.txt');await f.tabs[0].click();
 await f.nodes['fs-mobile-types'].click();assert.equal(f.nodes['fs-map-workbench'].dataset.surface,'types');await f.nodes['fs-tree-splitter'].emit('keydown',{key:'End'});assert.equal(f.nodes['fs-tree-splitter'].getAttribute('aria-valuenow'),'75');await f.nodes['fs-tree-splitter'].emit('keydown',{key:'ArrowRight'});assert.equal(f.nodes['fs-tree-splitter'].getAttribute('aria-valuenow'),'75');assert.equal(f.calls.length,2);
 await f.nodes['fs-tree-expand'].click();f.nodes['fs-extension-filter'].value='private-extension';f.emit('tli-session-locked');assert.equal(f.api.getState().treeRows.length,0);assert.equal(f.api.getState().expanded.size,0);assert.equal(f.nodes['fs-tree-summary'].textContent,'');assert.equal(f.nodes.visualizerTypeBars.textContent,'');assert.equal(f.nodes['fs-extension-filter'].value,'');assert.equal(changes.at(-1),null);
});
test('partial allocation remains a lower bound, aggregate kind cannot acquire actions, and metric sort is announced',async()=>{
 const data=scan({tree:{name:'Downloads',path:root,size:30,children:[{name:'partial.txt',path:root+'\\partial.txt',size:10,allocated_size:4,allocated_partial:true,size_reason:'Allocation coverage is incomplete.'},{name:'group',path:root+'\\__MORE__',kind:'aggregate',size:20,files:50,collapsed_entries:50}]}});const f=await load(data);await choose(f,'partial.txt');assert.match(f.nodes.visualizerDetailsSize.textContent,/At least 4 B allocated.*Allocation coverage is incomplete/);
 f.nodes['fs-size-metric'].value='allocated_size';await f.nodes['fs-size-metric'].emit('change');assert.equal(f.api.getState().mapView.total,0);assert.equal(f.api.getState().mapView.unknown,2);assert.equal(f.sorts.find(th=>th.dataset.sort==='allocated_size').getAttribute('aria-sort'),'descending');assert.equal(f.sorts.find(th=>th.dataset.sort==='size').getAttribute('aria-sort'),'none');
 const group=row(f,'group');assert.equal(group.children[5].textContent,'—');await group.querySelector('.storage-file-action').click();assert.equal(f.nodes['fs-selected-explain'].disabled,true);assert.equal(f.nodes['fs-selected-reveal'].disabled,true);assert.match(f.nodes.visualizerDetailsSize.textContent,/50 entries grouped without individual paths/);assert.doesNotMatch(f.nodes.visualizerDetailsSize.textContent,/50 recorded files/);assert.equal(f.calls.length,2);
});
