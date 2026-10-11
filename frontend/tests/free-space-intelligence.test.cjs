const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,job,envelope,scan,root}=require('./helpers/free-space-fixture.cjs');
const map=require('../js/storage-map.js');
const d3=require('../assets/d3.v7.min.js');
function metadata(){return scan({tree:{name:'Downloads',path:root,size:10240,allocated_size:null,allocated_known_bytes:4096,files:3,children:[
{name:'sparse.gguf',path:root+'\\sparse.gguf',size:8192,allocated_size:1024,files:1,modified_at:'2026-10-07T12:00:00Z',extension:'.gguf'},
{name:'small.txt',path:root+'\\small.txt',size:1024,allocated_size:3072,files:1,extension:'.txt'},
{name:'unknown.txt',path:root+'\\unknown.txt',size:1024,allocated_size:null,files:1,extension:'.txt'}]}});}
async function scanned(f){f.api.prepare(root);await f.api.startScan();}
test('allocated map weights measured allocation, retains unknowns, and never substitutes logical size',()=>{
 const f=fixture(),o=f.api.validateResult(metadata(),job());
 const view=map.view(o.map,root,()=>true,null,new Set(),'allocated_size');
 assert.equal(view.total,4096);assert.equal(view.unknown,1);assert.equal(view.rows.length,3);
 const leaves=map.layout(d3,map.hierarchy(view),800,400).leaves();assert.equal(leaves.length,2);
 const sparse=leaves.find(n=>n.data.item.name==='sparse.gguf'),small=leaves.find(n=>n.data.item.name==='small.txt');
 assert.equal(small.value/sparse.value,3);assert.equal(o.map.total,10240);
 assert.equal(o.index.get(root+'\\sparse.gguf').modified_at,'2026-10-07T12:00:00Z');
});
test('extension filtering, allocation ordering and detailed columns operate locally on bounded results',async()=>{
 const j=job(),f=fixture(async url=>url==='/visualizer/jobs'?envelope(j):envelope(j,metadata()));await scanned(f);const calls=f.calls.length;
 f.nodes['fs-size-metric'].value='allocated_size';await f.nodes['fs-size-metric'].emit('change');
 assert.equal(f.nodes.visualizerTableBody.children[0].children[0].textContent.includes('small.txt'),true);
 assert.equal(f.nodes.visualizerTableBody.children[0].children.length,8);
 f.nodes['fs-extension-filter'].value='gguf';await f.nodes['fs-extension-filter'].emit('input');
 assert.equal(f.api.getState().mapView.total,1024);assert.equal(f.nodes.visualizerTableBody.children.length,1);assert.equal(f.calls.length,calls);
});
test('allocation and timestamp validation rejects malformed scanner metadata before replacement',()=>{
 const f=fixture();for(const changes of [{allocated_size:-1},{files:0.2},{modified_at:'not-a-date'}]){const s=metadata();Object.assign(s.tree.children[0],changes);assert.throws(()=>f.api.validateResult(s,job()),/invalid allocation or timestamp/);}
});
test('investigation sends server receipt only and discards late private response after lock',async()=>{
 const j=job();let resolve;const f=fixture(async url=>url==='/visualizer/investigate'?new Promise(r=>{resolve=r;}):url==='/visualizer/jobs'?envelope(j):envelope(j,metadata()));
 await scanned(f);f.nodes['fs-investigation-question'].value='What grew?';const pending=f.nodes['fs-investigate'].click();await new Promise(setImmediate);
 assert.deepEqual(f.calls.at(-1).body,{job_id:j.id,question:'What grew?'});
 f.emit('tli-session-locked');resolve({ok:true,protocol:'storage-investigation-v1',local_only:true,reply:'secret.gguf',evidence:{root,job_id:j.id},recommendations:[]});await pending;
 assert.doesNotMatch(f.nodes['fs-investigation-result'].textContent,/secret/);assert.equal(f.nodes['fs-investigation-question'].value,'');
});
test('investigation requires local-only confirmation and keeps recommendations non-executing',async()=>{
 const j=job(),f=fixture(async url=>url==='/visualizer/investigate'?{ok:true,protocol:'storage-investigation-v1',local_only:true,reply:'Observed models occupy the largest measured files.',evidence:{root,job_id:j.id},recommendations:[{path:root+'\\sparse.gguf',size_bytes:8192,classification:'requires_review',reason:'May be an active model.',consequence:'Removing it may disable local inference.',action:'review'}]}:url==='/visualizer/jobs'?envelope(j):envelope(j,metadata()));
 await scanned(f);await f.nodes['fs-investigate'].click();assert.match(f.nodes['fs-investigation-result'].textContent,/Requires review/);assert.equal(f.nodes['fs-investigation-result'].querySelectorAll('button').length,0);assert.equal(f.calls.length,3);
});
const monitorSettings={enabled:false,sample_interval_seconds:120,warn_percent:85,critical_percent:95,sudden_bytes:5*1024**3,window_hours:12,cooldown_hours:6,schedule_enabled:false,scan_interval_hours:24};
test('monitor setup is request-free, scheduling requires enabled monitoring and a completed selected scan',async()=>{
 const j=job(),f=fixture(async(url,options)=>url==='/visualizer/monitor'?{ok:true,active:true,settings:{...monitorSettings,...JSON.parse(options.body)},schedule_scope:root,samples:{},findings:[],detail:'Mount identity unconfirmed; at most 256 samples per drive are retained.'}:url==='/visualizer/jobs'?envelope(j):envelope(j,metadata()));
 assert.equal(f.calls.length,0);f.nodes['fs-monitor-schedule_enabled'].checked=true;await f.nodes['fs-monitor-save'].click();assert.equal(f.calls.length,0);
 f.nodes['fs-monitor-enabled'].checked=true;await f.nodes['fs-monitor-save'].click();assert.equal(f.calls.length,0);assert.match(f.nodes['fs-monitor-status'].textContent,/Scan the selected location/);
 await scanned(f);await f.nodes['fs-monitor-save'].click();assert.equal(f.calls.at(-1).options.method,'PUT');assert.equal(f.calls.at(-1).body.job_id,j.id);assert.equal(f.calls.at(-1).body.path,undefined);assert.match(f.nodes['fs-monitor-readings'].textContent,/Downloads/);assert.match(f.nodes['fs-monitor-readings'].textContent,/Mount identity unconfirmed; at most 256/);
});
test('private monitor findings clear on lock and delayed response cannot restore them; unlock enables a deliberate reload',async()=>{
 let resolve;const f=fixture(async()=>new Promise(r=>{resolve=r;}));const pending=f.nodes['fs-monitor-load'].click();await new Promise(setImmediate);
 f.emit('tli-session-locked');resolve({ok:true,settings:monitorSettings,active:true,schedule_scope:root,samples:{},findings:[{message:'private model path'}]});await pending;
 assert.equal(f.nodes['fs-monitor-readings'].textContent,'');f.emit('tli-session-unlocked');assert.equal(f.nodes['fs-monitor-load'].disabled,false);assert.equal(f.calls.length,1);
});
test('investigation baseline is opt-in and stale location responses do not reappear after returning',async()=>{
 let resolve;const j=job(),f=fixture(async url=>url==='/visualizer/investigate'?new Promise(r=>{resolve=r;}):url==='/visualizer/jobs'?envelope(j):envelope(j,metadata()));await scanned(f);
 f.window.TLIStorageHistory.selectedBaseline=()=> 'b'.repeat(32);f.nodes['fs-investigation-baseline'].checked=true;const pending=f.nodes['fs-investigate'].click();await new Promise(setImmediate);assert.equal(f.calls.at(-1).body.baseline_id,'b'.repeat(32));
 f.api.prepare('D:\\');f.api.prepare(root);resolve({ok:true,protocol:'storage-investigation-v1',local_only:true,reply:'obsolete answer',evidence:{root,job_id:j.id},recommendations:[]});await pending;assert.equal(f.nodes['fs-investigation-result'].textContent,'');
});

test('hard-link aliases show their logical length without adding map bytes or offering cleanup',async()=>{
 const j=job(),result=scan({tree:{name:'Downloads',path:root,size:1073741824,allocated_size:4096,children:[{name:'original.bin',path:root+'\\original.bin',size:1073741824,allocated_size:4096,logical_size:1073741824},{name:'alias.bin',path:root+'\\alias.bin',size:0,allocated_size:0,logical_size:1073741824,hardlink_duplicate:true}]}});
 const f=fixture(async url=>url==='/visualizer/jobs'?envelope(j):envelope(j,result));await scanned(f);
 const alias=f.api.getState().observation.map.atoms.find(row=>row.hardlink_duplicate);assert.equal(alias.size,0);assert.equal(alias.actionable,false);assert.equal(f.api.getState().mapView.total,1073741824);
 const row=f.nodes.visualizerTableBody.children.find(row=>row.children[0].textContent.includes('alias.bin'));assert.match(row.children[2].textContent,/1 GiB logical · counted elsewhere/);assert.equal(row.children[4].textContent,'0%');assert.match(row.children[7].textContent,/cleanup unavailable/);
 await row.children[0].querySelector('button').click();assert.match(f.nodes.visualizerDetailsSize.textContent,/1 GiB logical · counted elsewhere/);assert.doesNotMatch(f.nodes.visualizerDetailsSize.textContent,/counted elsewhere logical/);assert.equal(f.nodes['fs-selected-cleanup'].children.length,0);assert.equal(f.choices.some(item=>item.hardlink_duplicate),false);
});
