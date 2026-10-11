const test=require('node:test'),assert=require('node:assert/strict');
const map=require('../js/storage-map.js'),d3=require('../assets/d3.v7.min.js');
const {fixture,job,envelope,scan,root}=require('./helpers/free-space-fixture.cjs');
function tree(){return scan({tree:{name:'Downloads',path:root,size:100,children:[
 {name:'Media',path:root+'\\Media',size:70,children:[{name:'a.mov',path:root+'\\Media\\a.mov',size:50},{name:'b.jpg',path:root+'\\Media\\b.jpg',size:20}]},
 {name:'small.txt',path:root+'\\small.txt',size:10},
 {name:'(+2 more)',path:root+'\\__MORE__',size:12,synthetic:true,protected:true,collapsed_entries:2},
 {name:'Restricted',path:root+'\\Restricted',size:0,size_known:false,size_partial:true,children:[]}
],omitted_bytes:8,omitted_entries:3}});}
function completed(data=tree()){const j=job();return fixture(async url=>url.endsWith('/results')?envelope(j,data):envelope(j));}
test('hierarchical leaves account parent bytes once, synthetic bucket and omitted bytes remain nonactionable',()=>{
 const f=fixture(),o=f.api.validateResult(tree(),job()),view=map.view(o.map,root),r=map.hierarchy(view),layout=map.layout(d3,r,800,400);
 assert.equal(o.map.total,100);assert.equal(layout.value,100);assert.equal(view.aggregateBytes,20);assert.equal(view.unknown,1);
 assert.equal(layout.leaves().reduce((s,n)=>s+n.value,0),100);
 assert.equal(layout.leaves().reduce((s,n)=>s+(n.x1-n.x0)*(n.y1-n.y0),0),800*400);
 assert.ok(layout.descendants().some(n=>n.data.path===root+'\\Media'&&n.value===70));
 const aggregates=view.rows.filter(n=>n.aggregate);assert.equal(aggregates.length,2);for(const a of aggregates){assert.equal(a.path,null);assert.equal(a.actionable,false);}
 assert.equal(o.files.length,3);assert.equal(o.map.atoms.find(a=>a.name==='Restricted').size,null);
});
test('more than40 and bounded240 drawing preserves every byte and explicit grouped-member identity',()=>{
 const data=scan();data.tree.children=Array.from({length:1100},(_,i)=>({name:`file-${i}.bin`,path:root+`\\file-${i}.bin`,size:i+1}));data.tree.size=1100*1101/2;
 const o=fixture().api.validateResult(data,job()),v=map.view(o.map,root),r=map.hierarchy(v),layout=map.layout(d3,r,600,420);
 assert.equal(v.rows.length,1100);assert.equal(r.renderedLeaves,240);assert.equal(r.groupedCount,861);assert.equal(layout.value,data.tree.size);
 const group=layout.leaves().find(n=>n.data.item.members).data.item;assert.equal(group.members.length,861);assert.equal(group.actionable,false);assert.equal(group.path,null);
 const expanded=map.view(o.map,root,()=>true,new Set(group.members));assert.equal(expanded.rows.length,861);assert.equal(expanded.total,group.size);
 assert.equal(map.hierarchy(expanded).total,group.size);
});
test('filter and folder view denominators exclude unknowns but preserve scope totals without double counting',()=>{
 const o=fixture().api.validateResult(tree(),job());const v=map.view(o.map,root+'\\Media',n=>n.category==='Video');assert.equal(v.total,50);assert.equal(v.scopeTotal,70);
 const full=map.view(o.map,root);assert.equal(full.total,100);assert.equal(full.unknown,1);assert.equal(map.hierarchy(full).positiveCount,5);
});
test('mixed collapsed lower bounds retain unknown entries inside the group separately from individual unknown paths',async()=>{
 const data=scan({tree:{name:'Downloads',path:root,size:10,size_partial:true,children:[{name:'(+2 more)',path:root+'\\__MORE__',size:10,size_known:true,size_partial:true,synthetic:true,collapsed_entries:2,unknown_entries:1}]}});
 const f=completed(data);f.api.prepare(root);await f.api.start();const s=f.api.getState(),view=s.mapView;
 assert.equal(view.total,10);assert.equal(view.unknown,0);assert.equal(view.groupedUnknown,1);assert.equal(s.observation.map.groupedUnknown,1);
 assert.match(f.nodes['vis4-treemap-container'].textContent,/1 additional unknown sizes inside groups/);
 const group=f.nodes['vis4-treemap-container'].querySelectorAll('button').find(n=>n.getAttribute('aria-label')?.startsWith('(+2 more)'));await group.click();assert.match(f.nodes.visualizerDetailsSize.textContent,/At least 10 B/);assert.match(f.nodes.visualizerDetailsSize.textContent,/1 additional unknown-size/);assert.equal(f.nodes.visualizerSendToFilesBtn.disabled,true);
});
test('reject inconsistent child totals, cross-folder paths, excess nodes and malformed group counts',()=>{
 const f=fixture(),bad=tree();bad.tree.size=1;assert.throws(()=>f.api.validateResult(bad,job()),/exceed/);
 const moved=tree();moved.tree.children[0].children[0].path=root+'\\other.mov';assert.throws(()=>f.api.validateResult(moved,job()),/invalid/);
 const huge=scan();huge.tree.children=Array.from({length:25000},(_,i)=>({name:''+i,path:root+'\\'+i,size:0}));assert.throws(()=>f.api.validateResult(huge,job()),/invalid/);
 const count=tree();count.tree.children[2].collapsed_entries=-1;assert.throws(()=>f.api.validateResult(count,job()),/invalid/);
});
test('default map and list share exact selection; folder zoom and cleanup review selection are separate from requests',async()=>{
 const f=completed();f.api.prepare(root);await f.api.start();assert.equal(f.api.getState().mode,'map');assert.equal(f.nodes['fs-table-wrap'].hidden,false);assert.equal(f.nodes['vis4-treemap-container'].hidden,false);
 const before=f.calls.length,marks=f.nodes['vis4-treemap-container'].querySelectorAll('button');const mark=marks.find(n=>n.getAttribute('aria-label')?.includes(root+'\\Media\\a.mov'));await mark.click();
 assert.equal(f.nodes.visualizerDetailsPath.textContent,root+'\\Media\\a.mov');assert.ok(f.nodes.visualizerTableBody.children.some(n=>n.getAttribute('aria-selected')==='true'&&n.textContent.includes('a.mov')));
 assert.equal(f.nodes['fs-selected-cleanup'].children.length,1);assert.equal(f.calls.length,before);assert.equal(f.scopes.length,1);
 const folder=f.nodes['vis4-treemap-container'].querySelectorAll('button').find(n=>n.getAttribute('aria-label')?.startsWith('Select recorded folder'));await folder.emit('dblclick');assert.equal(f.api.getState().focus,root+'\\Media');assert.equal(f.api.getState().mapView.total,70);assert.equal(f.calls.length,before);
 await f.nodes.visualizerBackBtn.click();assert.equal(f.api.getState().mapView.total,100);assert.equal(f.calls.length,before);
 await f.nodes['fs-mobile-list'].click();assert.equal(f.nodes['fs-map-workbench'].dataset.surface,'list');assert.equal(f.calls.length,before);
});
test('aggregate inspector never exposes fake filesystem or cleanup action; explicit group drill retains list paths',async()=>{
 const data=scan();data.tree.children=Array.from({length:300},(_,i)=>({name:`file-${i}.bin`,path:root+`\\file-${i}.bin`,size:i+1}));data.tree.size=45150;
 const f=completed(data);f.api.prepare(root);await f.api.start();const group=f.nodes['vis4-treemap-container'].querySelectorAll('button').find(n=>n.getAttribute('aria-label')?.startsWith('Other mapped entries'));await group.click();
 assert.ok(f.nodes.visualizerTableBody.children.some(n=>n.getAttribute('aria-selected')==='true'),'Grouped map selection highlights its visible member rows without choosing cleanup');
 assert.equal(f.nodes.visualizerCopyPathBtn.disabled,true);assert.equal(f.nodes.visualizerSendToFilesBtn.disabled,true);assert.match(f.nodes.visualizerDetailsPath.textContent,/no individual file path/);
 assert.equal(f.nodes['fs-selected-cleanup'].children[0].textContent,'Show grouped entries');await f.nodes['fs-selected-cleanup'].children[0].click();assert.equal(f.api.getState().mapView.rows.length,61);assert.equal(f.calls.length,2);
});
test('list selection of a tiny grouped file highlights its containing map group and preserves exact path',async()=>{
 const data=scan();data.tree.children=Array.from({length:300},(_,i)=>({name:`file-${i}.bin`,path:root+`\\file-${i}.bin`,size:i+1}));data.tree.size=45150;
 const f=completed(data);f.api.prepare(root);await f.api.start();f.nodes['fs-table-wrap'].scrollTop=300*44;await f.nodes['fs-table-wrap'].emit('scroll');
 const row=f.nodes.visualizerTableBody.querySelectorAll('button').find(n=>n.textContent==='file-0.bin');await row.click();
 assert.equal(f.nodes.visualizerDetailsPath.textContent,root+'\\file-0.bin');
 assert.equal(f.nodes['vis4-treemap-container'].querySelectorAll('button').find(n=>n.getAttribute('aria-label')?.startsWith('Other mapped entries')).getAttribute('aria-pressed'),'true');assert.equal(f.calls.length,2);
});
test('old map/list handlers cannot restore paths after replacement or lock; failed replacement retains denominator',async()=>{
 let data=tree(),j=job();const f=fixture(async url=>url.endsWith('/results')?envelope(j,data):envelope(j));f.api.prepare(root);await f.api.start();const old=f.nodes['vis4-treemap-container'].querySelectorAll('button')[0];
 data=scan();data.tree.size=1;j=job({id:'b'.repeat(32)});await f.api.start();assert.equal(f.api.getState().mapView.total,100);
 data=scan();j=job({id:'c'.repeat(32)});await f.api.start();assert.equal(f.api.getState().mapView.total,12);await old.click();assert.equal(f.api.getState().selected,null);
 const latest=f.nodes['vis4-treemap-container'].querySelectorAll('button')[0];f.emit('tli-session-locked');await latest.click();assert.equal(f.nodes.visualizerDetailsPath.textContent,'');assert.equal(f.nodes['fs-map-breadcrumbs'].textContent,'');assert.equal(f.api.getState().mapView,null);
});
