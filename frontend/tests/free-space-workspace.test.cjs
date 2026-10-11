const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,job,envelope,scan,root}=require('./helpers/free-space-fixture.cjs');
const completed=(data=scan(),j=job())=>fixture(async url=>url.endsWith('/results')?envelope(j,data):envelope(j));
test('navigation and quick-folder selection prepare only; every tool tab is request-free',async()=>{
 const f=fixture();f.window.TLIVisualizer.scanPath(root);await f.presets[0].click();for(const tab of f.tabs)await tab.click();assert.equal(f.calls.length,0);assert.equal(f.nodes.visualizerPathInput.value,root);assert.match(f.nodes.visualizerStatus.textContent,/no scan has run/);
});
test('drive picker consumes actual byte fields, unknown readings and hostile labels as text',async()=>{
 const f=fixture(async()=>({drives:[{mountpoint:'C:\\',label:'<img src=x>',total_bytes:100,free_bytes:10,percent_used:90},{mountpoint:'Z:\\',label:'Offline'}]}));await f.api.loadDrives();assert.equal(f.nodes['vis4-drives'].children.length,2);assert.match(f.nodes['vis4-drives'].textContent,/<img src=x>/);assert.match(f.nodes['vis4-drives'].textContent,/10 B free \/ 100 B/);assert.match(f.nodes['vis4-drives'].textContent,/Usage unknown/);assert.doesNotMatch(f.nodes['vis4-drives'].textContent,/undefined/);await f.nodes['vis4-drives'].children[0].click();assert.equal(f.calls.length,1);assert.equal(f.nodes.visualizerPathInput.value,'C:\\');
});
test('drive retry failure retains readings; search and numeric sort are local',async()=>{
 let fail=false;const f=fixture(async()=>{if(fail)throw Error('offline');return{drives:[{mountpoint:'A:\\',label:'A',free_bytes:80},{mountpoint:'B:\\',label:'B',free_bytes:10}]};});await f.api.loadDrives();fail=true;await f.api.loadDrives(true);assert.equal(f.nodes['vis4-drives'].children.length,2);assert.match(f.nodes['fs-drives-status'].textContent,/Previous readings/);f.nodes['fs-drive-sort'].value='free';await f.nodes['fs-drive-sort'].emit('change');assert.equal(f.nodes['vis4-drives'].children[0].dataset.mount,'B:\\');f.nodes['fs-drive-search'].value='A:';await f.nodes['fs-drive-search'].emit('input');assert.equal(f.nodes['vis4-drives'].children.length,1);assert.equal(f.calls.length,2);
});

test('refreshing capacity updates the selected drive without changing the location or starting a scan',async()=>{
 let free=50;const f=fixture(async()=>({drives:[{mountpoint:'E:\\',total_bytes:100,free_bytes:free}]}));f.api.prepare('E:\\');await f.api.loadDrives();assert.equal(f.nodes['fs-location-capacity'].textContent,'50 B free of 100 B');free=25;await f.api.loadDrives(true);assert.equal(f.nodes['fs-location-capacity'].textContent,'25 B free of 100 B');assert.equal(f.nodes.visualizerPathInput.value,'E:\\');assert.deepEqual(f.calls.map(c=>c.url),['/visualizer/drives','/visualizer/drives']);
});
test('root path helper retains Windows and POSIX roots',()=>{
 const {ctx}=fixture();for(const [a,b]of [['C:\\','C:\\'],['C:\\a.txt','C:\\'],['/','/'],['/a.txt','/'],['C:\\Users\\file.txt','C:\\Users']])assert.equal(ctx.getParentFolderPath(a),b);
});
test('explicit scan uses HTTP-safe secure IDs and guards duplicate starts',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>resolve=r));f.api.prepare(root);const pending=f.api.start();f.api.start();assert.equal(f.calls.length,1);const p=f.calls[0].body;assert.equal(p.operation,'scan');assert.equal(p.profile,'quick');assert.equal(p.include_excluded,false);assert.match(p.request_id,/^[a-f0-9]{32}$/);resolve(envelope(job({status:'running',result_available:false})));await pending;assert.equal(f.api.getState().job.status,'running');assert.equal(f.nodes.visualizerScanBtn.disabled,true);
});
test('Deep inclusion resets on Quick; invalid large-file minimum starts nothing',async()=>{
 const f=completed();f.api.prepare(root);f.nodes['fs-profile'].value='deep';await f.nodes['fs-profile'].emit('change');assert.equal(f.nodes['fs-include-excluded'].disabled,false);f.nodes['fs-include-excluded'].checked=true;f.nodes['fs-profile'].value='quick';await f.nodes['fs-profile'].emit('change');assert.equal(f.nodes['fs-include-excluded'].checked,false);f.nodes['vis4-largefiles-minmb'].value='50001';await f.api.start('large_files');assert.equal(f.calls.length,0);assert.match(f.nodes.visualizerStatus.textContent,/50,000/);
});
test('validated result binds scope, updates history and never auto-checks common folders',async()=>{
 const f=completed();f.api.prepare(root);await f.api.start();assert.equal(f.api.getState().observation.root,root);assert.equal(f.nodes['fs-empty'].hidden,true);assert.equal(f.nodes['storage-results'].hidden,false);assert.equal(f.scopes[0].observationId,'a'.repeat(32));assert.equal(f.scopes[0].root,root);assert.equal(f.history.filter(x=>x[0]==='receive').length,1);assert.deepEqual(f.calls.map(c=>c.url),['/visualizer/jobs','/visualizer/jobs/'+'a'.repeat(32)+'/results']);
});
test('rejected start is correctable; lost start requires deliberate same-ID retry',async()=>{
 let mode='reject';const f=fixture(async()=>{if(mode==='reject')return{ok:false,status:409,json:async()=>({detail:{code:'busy',message:'Another scan is active'}})};if(mode==='lost')throw Error('connection lost');return envelope(job({status:'running',result_available:false}));});f.api.prepare(root);await f.api.start();assert.equal(f.nodes.visualizerScanBtn.disabled,false);assert.match(f.nodes.visualizerStatus.textContent,/Another scan is active/);mode='lost';await f.api.start();const id=f.calls.at(-1).body.request_id;assert.match(f.nodes['fs-job-check'].textContent,/Retry/);assert.match(f.nodes.visualizerStatus.textContent,/can start the job/);mode='okay';await f.nodes['fs-job-check'].click();assert.equal(f.calls.at(-1).body.request_id,id);assert.equal(f.calls.length,3);
});
test('failed and malformed replacement observations retain original data and time',async()=>{
 let data=scan(),j=job();const f=fixture(async url=>url.endsWith('/results')?envelope(j,data):envelope(j));f.api.prepare(root);await f.api.start();const original=f.api.getState().observation;data=scan({tree:{name:'wrong',path:'D:\\',size:1,children:[]}});j=job({id:'b'.repeat(32)});await f.api.start();assert.equal(f.api.getState().observation,original);assert.match(f.nodes.visualizerStatus.textContent,/does not match/);j=job({id:'c'.repeat(32),status:'failed',result_available:false,error:{message:'Fixture access denied'}});await f.api.start();assert.equal(f.api.getState().observation,original);assert.match(f.nodes.visualizerStatus.textContent,/Fixture access denied.*unchanged/);
});
test('cancelled partial results require explicit review before GET and replacement',async()=>{
 let j=job({status:'running',result_available:false});const f=fixture(async url=>{if(url.endsWith('/cancel'))j=job({status:'cancelled',result_available:true});return url.endsWith('/results')?envelope(j,scan({meta:{partial:true}})):envelope(j);});f.api.prepare(root);await f.api.start();await f.api.stop();assert.equal(f.api.getState().observation,null);assert.equal(f.calls.filter(c=>c.url.endsWith('/results')).length,0);assert.equal(f.nodes['fs-job-check'].textContent,'View partial results');await f.nodes['fs-job-check'].click();assert.equal(f.api.getState().observation.job.status,'cancelled');assert.equal(f.calls.filter(c=>c.url.endsWith('/results')).length,1);
});
test('failed Stop is explicitly unconfirmed; status lookup never resubmits the scan',async()=>{
 const j=job({status:'running',result_available:false});const f=fixture(async url=>{if(url.endsWith('/cancel'))throw Error('offline');return envelope(j);});f.api.prepare(root);await f.api.start();await f.api.stop();assert.match(f.nodes.visualizerStatus.textContent,/Cancellation was not confirmed/);await f.nodes['fs-job-check'].click();assert.equal(f.calls.filter(c=>c.url==='/visualizer/jobs').length,1);assert.equal(f.api.getState().job.id,j.id);
});
test('lock invalidates a delayed start with no private data restored after unlock',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>resolve=r));f.api.prepare(root);const pending=f.api.start();f.emit('tli-session-locked');f.emit('tli-session-unlocked');resolve(envelope(job()));await pending;assert.equal(f.api.getState().job,null);assert.equal(f.api.getState().observation,null);assert.equal(f.nodes.visualizerPathInput.value,'');assert.equal(f.calls.length,1);
});
test('old unauthorized response cannot relock a subsequently unlocked session',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>resolve=r));f.api.prepare(root);const pending=f.api.start();f.emit('tli-session-locked');f.emit('tli-session-unlocked');resolve({ok:false,status:401,json:async()=>({detail:'old session'})});await pending;assert.equal(f.events.filter(e=>e.type==='tli-session-locked').length,1);assert.equal(f.api.prepare(root),true);
});
test('background pauses polling and resumes same job without automatic POST',async()=>{
 const f=fixture(async()=>envelope(job({status:'running',result_available:false})));f.api.prepare(root);await f.api.start();await f.visibility(true);assert.equal([...f.timers.values()].filter(t=>t.ms===1000).length,0);await f.visibility(false);await new Promise(r=>setImmediate(r));assert.equal(f.calls.filter(c=>c.body).length,1);assert.equal(f.calls.at(-1).url,'/visualizer/jobs/'+'a'.repeat(32));
});
test('validation rejects wrong identities, duplicate/negative entries, retaining explicit unknown size',()=>{
 const f=fixture();assert.throws(()=>f.api.validateJob(envelope(job({id:'b'.repeat(32)})),job()),/different/);assert.throws(()=>f.api.validateResult(scan({tree:{name:'x',path:root,size:-1}}),job()),/invalid/);const duplicate=scan();duplicate.tree.children.push({...duplicate.tree.children[0]});assert.throws(()=>f.api.validateResult(duplicate,job()),/repeated/);const unknown=scan();unknown.tree.children[0].size_known=false;assert.equal(f.api.validateResult(unknown,job()).files[0].size,null);assert.equal(f.api.bytes(null),'Size unknown');
});
test('tree virtualizes real counts, sorts and drills cached folders without requests',async()=>{
 const data=scan();data.tree.children=Array.from({length:121},(_,i)=>({name:`File${String(i).padStart(3,'0')}.txt`,path:root+`\\File${i}.txt`,size:i}));data.tree.children.push({name:'Photos',path:root+'\\Photos',size:1,children:[{name:'photo.jpg',path:root+'\\Photos\\photo.jpg',size:1}]});data.tree.size=data.tree.children.reduce((n,c)=>n+c.size,0);const f=completed(data);f.api.prepare(root);await f.api.start();assert.ok(f.nodes.visualizerTableBody.children.length<50);assert.match(f.nodes['fs-tree-summary'].textContent,/122 visible tree rows/);f.nodes['fs-table-wrap'].scrollTop=44*110;await f.nodes['fs-table-wrap'].emit('scroll');assert.ok(f.nodes.visualizerTableBody.querySelectorAll('.fs-tree-row').length<50);await f.sorts[0].children[0].click();assert.equal(f.sorts[0].getAttribute('aria-sort'),'ascending');f.nodes['fs-table-wrap'].scrollTop=44*121;await f.nodes['fs-table-wrap'].emit('scroll');const folder=f.nodes.visualizerTableBody.querySelectorAll('.storage-file-action').find(row=>row.textContent==='Photos');await folder.emit('dblclick');assert.match(f.nodes.visualizerCenterSubtitle.textContent,/Photos/);await f.nodes.visualizerBackBtn.click();assert.equal(f.nodes.visualizerCenterSubtitle.textContent,root);assert.equal(f.calls.length,2);
});
test('type and minimum-size filters distinguish unknown sizes and empty matches',async()=>{
 const data=scan();data.tree.children.push({name:'photo.jpg',path:root+'\\photo.jpg',size:1024*1024},{name:'unknown.txt',path:root+'\\unknown.txt',size:null});data.tree.size+=1024*1024;const f=completed(data);f.api.prepare(root);await f.api.start();assert.match(f.nodes.visualizerTableBody.textContent,/Size unknown/);f.nodes.visualizerCategoryFilter.value='Images';await f.nodes.visualizerCategoryFilter.emit('change');assert.equal(f.nodes.visualizerTableBody.children.length,1);f.nodes.visualizerMinSize.value=String(2*1024*1024);await f.nodes.visualizerMinSize.emit('change');assert.match(f.nodes.visualizerTableBody.textContent,/No entries match/);
});
test('reviewed Chat handoff protects drafts/context and prepares text only in empty Chat',async()=>{
 const f=completed();f.api.prepare(root);await f.api.start();f.nodes['chat-input'].value='My new draft';await f.nodes['fs-ask-chat'].click();assert.equal(f.nodes['fs-handoff'].open,true);await f.nodes['fs-handoff-confirm'].click();assert.equal(f.nodes['chat-input'].value,'My new draft');assert.equal(f.navigation.length,0);f.nodes['chat-input'].value='';f.window.TLIDocuments={describeContext:()=>[{id:'doc'}]};await f.nodes['fs-handoff-confirm'].click();assert.equal(f.nodes['chat-input'].value,'');f.window.TLIDocuments.describeContext=()=>[];await f.nodes['fs-handoff-confirm'].click();assert.match(f.nodes['chat-input'].value,/Recorded storage observation.*Fixture host/);assert.match(f.nodes['chat-input'].value,/historical scan/);assert.deepEqual(f.navigation,['panel-main']);assert.equal(f.calls.length,2);
});
test('reviewed Files handoff selects parent only and preserves a different path draft',async()=>{
 const f=completed();f.api.prepare(root);await f.api.start();await f.nodes.visualizerTableBody.children[0].children[0].children[0].click();await f.nodes.visualizerSendToFilesBtn.click();f.nodes.filesRootInput.value='D:\\Draft';await f.nodes['fs-handoff-confirm'].click();assert.equal(f.nodes.filesRootInput.value,'D:\\Draft');assert.match(f.nodes['fs-handoff-status'].textContent,/preserved/);f.nodes.filesRootInput.value='';await f.nodes['fs-handoff-confirm'].click();assert.equal(f.nodes.filesRootInput.value,root);assert.deepEqual(f.navigation,['panel-files']);assert.equal(f.calls.length,2);
});
test('large-file/duplicate searches are independent and preserve results on failed replacement',async()=>{
 let op='large_files',fail=false;const f=fixture(async url=>{const j=job({operation:op});if(fail)throw Error('offline');return url.endsWith('/results')?envelope(j,op==='large_files'?{files:[{name:'big.bin',path:root+'\\big.bin',size:100}],meta:{partial:true,found:3}}:{groups:[{paths:[root+'\\a.txt',root+'\\b.txt'],size:12,wasted_bytes:12}],meta:{verification:'full_sha256',partial:false}}):envelope(j);});f.api.prepare(root);await f.api.start(op);assert.match(f.nodes['fs-large_files-results'].textContent,/big.bin/);assert.match(f.nodes['fs-large_files-results'].textContent,/of 3 matches/);op='duplicates';await f.api.start(op);const before=f.nodes['fs-duplicates-results'].textContent;fail=true;await f.api.start(op);assert.equal(f.nodes['fs-duplicates-results'].textContent,before);assert.equal(f.calls.some(c=>c.body?.operation==='common_folders'),false);
});
test('empty common-folder results leave independent search controls available',async()=>{
 const j=job({operation:'common_folders',path:null});const f=fixture(async url=>url.endsWith('/results')?envelope(j,{targets:[]}):envelope(j));await f.api.start('common_folders');assert.match(f.nodes['fs-common_folders-results'].textContent,/No supported common folders/);assert.equal(f.nodes['fs-start-large_files'].disabled,false);assert.equal(f.nodes['fs-start-duplicates'].disabled,false);
});
test('actual authenticated synthetic route envelopes validate every operation and cancellation',()=>{
 const actual=require('./fixtures/free-space-api.json');assert.equal(actual.synthetic,true);const f=fixture();
 for(const entry of Object.values(actual.fixtures)){
   f.api.validateJob(entry.start,entry.request);
   if(entry.status)f.api.validateJob(entry.status,entry.start.job);
   if(entry.results){const j=entry.results.job;f.api.validateJob(entry.results,entry.start.job);const o=f.api.validateResult(entry.results.result,j);assert.equal(o.host.id,'synthetic-host');if(j.operation==='scan'){assert.ok(o.files.some(n=>n.size===null));assert.ok(o.folders.some(n=>n.size_partial));}}
 }
});
test('unknown and partial folder totals retain lower-bound labels and recorded host identity',async()=>{
 const data=scan();data.tree.size_partial=true;const f=completed(data,job({host:{id:'saved-host',name:'Recorded host'}}));f.api.prepare(root);await f.api.start();assert.match(f.nodes['vis4-summary'].textContent,/At least 12 B inspected/);assert.match(f.nodes['vis4-summary'].textContent,/Recorded host/);assert.doesNotMatch(f.nodes['vis4-summary'].textContent,/Fixture host/);const wrong=scan();wrong.meta.saved_scan={summary:{host:{id:'wrong',name:'Other'}}};assert.throws(()=>f.api.validateResult(wrong,job()),/different host/);
});
test('panel leave and BFcache retain same job; only lock requests cancellation and clears every displayed path',async()=>{
 const f=fixture(async()=>envelope(job({status:'running',result_available:false})));f.api.prepare(root);await f.api.start();await f.panel('panel-main');await f.api.start();assert.equal(f.calls.length,1);await f.panel('panel-visualizer');await new Promise(r=>setImmediate(r));f.emit('pagehide',{persisted:true});f.emit('pageshow',{persisted:true});await new Promise(r=>setImmediate(r));assert.equal(f.calls.filter(c=>c.body).length,1);f.emit('tli-session-locked');assert.equal(f.calls.filter(c=>c.url.endsWith('/cancel')).length,1);assert.equal(f.api.getState().job,null);for(const id of ['fs-job-title','fs-job-progress','visualizerCenterSubtitle','visualizerDetailsPath','vis4-summary'])assert.doesNotMatch(f.nodes[id].textContent,/Fixture|Downloads/);assert.equal(f.nodes.visualizerPathInput.value,'');
});
test('expired job lookup permits a new explicit scan without claiming cancellation or auto-starting',async()=>{
 let expired=false;const f=fixture(async()=>expired?{ok:false,status:410,json:async()=>({detail:'Expired job'})}:envelope(job({status:'running',result_available:false})));f.api.prepare(root);await f.api.start();expired=true;await f.api.poll();assert.equal(f.api.getState().job,null);assert.equal(f.nodes.visualizerScanBtn.disabled,false);assert.match(f.nodes.visualizerStatus.textContent,/no longer available/);assert.equal(f.calls.filter(c=>c.body).length,1);
});
test('drive refresh awaits missing common paths and skips extra host readers during an active scan',async()=>{
 const order=[];const f=fixture(async url=>{order.push(url);return url==='/visualizer/drives'?{drives:[]}:envelope(job({status:'running',result_available:false}));});f.window.TLI_PATHS=null;f.window._tliLoadCommonPaths=async()=>{order.push('paths');f.window.TLI_PATHS={home:root};};await f.api.loadDrives();assert.deepEqual(order,['paths','/visualizer/drives']);f.api.prepare(root);await f.api.start();await f.api.loadDrives(true);assert.equal(order.filter(x=>x==='/visualizer/drives').length,1);assert.match(f.nodes['fs-drives-status'].textContent,/job is active/);
});
test('explicit unavailable drive reasons display without inventing capacity',async()=>{
 const f=fixture(async()=>({drives:[{mountpoint:'Z:\\',label:'Archive',availability:'unavailable',detail:'Drive did not answer'}]}));await f.api.loadDrives();assert.match(f.nodes['vis4-drives'].textContent,/Capacity unavailable.*Drive did not answer/);assert.doesNotMatch(f.nodes['vis4-drives'].textContent,/0 B|0%/);
});
test('large duplicate groups validate but mount cleanup controls only when their disclosure opens',async()=>{
 const group={size:12,wasted_bytes:12*1104,paths:Array.from({length:1105},(_,i)=>root+'\\copy'+i+'.txt')},j=job({operation:'duplicates'});const f=completed({groups:[group],meta:{verification:'full_sha256',partial:false}},j);let renders=0;f.window.TLIStorageCleanup.duplicateControls=g=>{renders++;assert.equal(g.paths.length,1105);return new f.El('div');};f.api.prepare(root);await f.api.start('duplicates');assert.equal(renders,0);const disclosure=f.nodes['fs-duplicates-results'].querySelector('.fs-dupe');disclosure.open=true;await disclosure.emit('toggle');await disclosure.emit('toggle');assert.equal(renders,1);assert.match(disclosure.textContent,/1105 copies/);
});

test('changing drives hides the old map and actions immediately without scanning or clearing cleanup selection',async()=>{
 const f=completed();let changes=0;f.window.TLIStorageCleanup.choice=()=>{const label=new f.El('label'),input=new f.El('input');input.addEventListener('change',()=>changes++);label.append(input);return label;};
 f.api.prepare(root);await f.api.start();const original=f.api.getState().observation,rows=f.nodes.visualizerTableBody.children[0],choice=rows.querySelector('input'),map=f.nodes['vis4-treemap-container'].querySelector('.fs-map-item');
 await map.emit('contextmenu');const menu=f.document.getElementById('fs-entry-menu'),reveal=menu.querySelectorAll('button').find(b=>b.textContent==='Show in File Explorer');await choice.emit('change');assert.equal(changes,1);
 const requests=f.calls.length,scopeChanges=f.scopes.length;f.api.prepare('E:\\');
 assert.equal(f.calls.length,requests);assert.equal(f.scopes.length,scopeChanges);assert.equal(f.nodes['storage-results'].hidden,true);assert.equal(f.nodes['fs-empty'].hidden,false);assert.match(f.nodes['fs-empty-title'].textContent,/Scan E:\\ to see/);assert.equal(f.nodes.visualizerScanBtn.textContent,'Scan E:\\');assert.equal(f.nodes.visualizerDetailsBar.hidden,true);assert.equal(f.nodes.visualizerTableBody.children.length,0);assert.equal(f.document.getElementById('fs-entry-menu'),null);assert.equal(f.window.visualizerV4,null);
 await reveal.click();await map.click();await choice.emit('change');await f.nodes.visualizerSendToFilesBtn.click();assert.equal(f.calls.length,requests);assert.equal(changes,1);assert.equal(f.api.getState().selected,null);assert.equal(f.nodes['fs-handoff'].open,false);
 f.api.prepare(root);assert.equal(f.calls.length,requests);assert.equal(f.api.getState().observation,original);assert.equal(f.nodes['storage-results'].hidden,false);assert.equal(f.nodes.visualizerScanBtn.textContent,'Scan again');assert.equal(f.nodes['vis4-summary'].children[0].children[0].textContent,root);assert.match(f.nodes.visualizerTableBody.textContent,/a.txt/);
});

test('typing a different location has the same scope guard and case-equivalent roots restore locally',async()=>{
 const f=completed();f.api.prepare(root);await f.api.start();const before=f.calls.length;
 f.nodes.visualizerPathInput.value='E:\\';await f.nodes.visualizerPathInput.emit('input');assert.equal(f.nodes['storage-results'].hidden,true);assert.equal(f.nodes['fs-ask-chat'].disabled,true);
 f.nodes.visualizerPathInput.value=root.toLowerCase().replace(/\\/g,'/')+'/';await f.nodes.visualizerPathInput.emit('input');assert.equal(f.nodes['storage-results'].hidden,false);assert.equal(f.nodes['fs-ask-chat'].disabled,false);assert.equal(f.calls.length,before);
});

test('finishing a scan after selecting another drive retains its result without showing it under the new drive',async()=>{
 let resolve;const f=fixture(async url=>url.endsWith('/results')?envelope(job(),scan()):new Promise(r=>resolve=r));f.api.prepare(root);const pending=f.api.start();f.api.prepare('E:\\');assert.match(f.nodes.visualizerScanBtn.textContent,/Scanning C:/);
 resolve(envelope(job()));await pending;assert.equal(f.api.getState().observation.root,root);assert.equal(f.nodes['storage-results'].hidden,true);assert.equal(f.nodes.visualizerTableBody.children.length,0);assert.equal(f.nodes.visualizerScanBtn.textContent,'Scan E:\\');assert.match(f.nodes.visualizerStatus.textContent,/Select that location/);assert.equal(f.scopes.length,0);
 f.api.prepare(root);assert.equal(f.nodes['storage-results'].hidden,false);assert.equal(f.calls.length,2);assert.match(f.nodes.visualizerTableBody.textContent,/a.txt/);
});

test('failed scan of a newly selected drive does not reveal an older drive or destroy its retained scan',async()=>{
 let failed=false;const f=fixture(async url=>failed?envelope(job({id:'b'.repeat(32),path:'E:\\',status:'failed',result_available:false,error:{message:'Drive unavailable'}})):url.endsWith('/results')?envelope(job(),scan()):envelope(job()));
 f.api.prepare(root);await f.api.start();const original=f.api.getState().observation;failed=true;f.api.prepare('E:\\');await f.api.start();assert.equal(f.nodes['storage-results'].hidden,true);assert.equal(f.nodes.visualizerTableBody.textContent,'');assert.equal(f.api.getState().observation,original);assert.match(f.nodes.visualizerStatus.textContent,/Drive unavailable/);
 f.api.prepare(root);assert.equal(f.nodes['storage-results'].hidden,false);assert.equal(f.calls.length,3);
});

test('large-file and duplicate results follow the selected root while common folders are explicitly host-wide',async()=>{
 let operation='large_files';const f=fixture(async url=>{const j=job({operation,path:operation==='common_folders'?null:root});const data=operation==='large_files'?{files:[{name:'big.bin',path:root+'\\big.bin',size:100}],meta:{partial:true}}:operation==='duplicates'?{groups:[{paths:[root+'\\a.txt',root+'\\b.txt'],size:12,wasted_bytes:12}],meta:{verification:'full_sha256'}}:{targets:[{label:'Downloads',path:root,size_bytes:12}]};return url.endsWith('/results')?envelope(j,data):envelope(j);});
 f.api.prepare(root);await f.api.start(operation);const staleParent=f.nodes['fs-large_files-results'].querySelectorAll('button').find(b=>b.textContent==='Select parent folder');operation='duplicates';await f.api.start(operation);const duplicate=f.nodes['fs-duplicates-results'].querySelector('.fs-dupe');operation='common_folders';await f.api.start(operation);const requests=f.calls.length;
 f.api.prepare('E:\\');for(const op of ['large_files','duplicates']){assert.equal(f.nodes['fs-'+op+'-results'].textContent,'');assert.match(f.nodes['fs-'+op+'-status'].textContent,/No results for E:/);}assert.match(f.nodes['fs-common_folders-status'].textContent,/across the TLI host/);assert.match(f.nodes['fs-common_folders-results'].textContent,/Downloads/);
 await staleParent.click();duplicate.open=true;await duplicate.emit('toggle');assert.equal(f.nodes.visualizerPathInput.value,'E:\\');assert.equal(duplicate.children.length,1);assert.equal(f.calls.length,requests);
 f.api.prepare(root);assert.match(f.nodes['fs-large_files-results'].textContent,/big.bin/);assert.match(f.nodes['fs-duplicates-results'].textContent,/2 copies/);assert.equal(f.calls.length,requests);
});

test('more tools opens for a selected tool and closing it returns to the main view without requests',async()=>{
 const f=fixture();await f.tabs[1].click();assert.equal(f.nodes['fs-more-tools'].open,true);assert.equal(f.nodes['fs-view-explore'].hidden,true);f.nodes['fs-more-tools'].open=false;await f.nodes['fs-more-tools'].emit('toggle');assert.equal(f.api.getState().tab,'explore');assert.equal(f.nodes['fs-view-explore'].hidden,false);assert.equal(f.calls.length,0);
});

test('activating Scan results focuses its result or empty heading while automatic scan setup preserves focus',async()=>{
 const f=completed();f.api.prepare(root);await f.tabs[1].click();await f.tabs[0].click();assert.equal(f.document.activeElement,f.nodes['fs-empty-title']);
 f.nodes.visualizerScanBtn.focus();await f.api.start();assert.equal(f.document.activeElement,f.nodes.visualizerScanBtn);await f.tabs[1].click();await f.tabs[0].click();assert.equal(f.document.activeElement,f.nodes['vis4-summary'].querySelector('strong'));assert.equal(f.document.activeElement.getAttribute('tabindex'),'-1');assert.equal(f.calls.length,2);
});

test('empty folders remain in the tree without a competing folder-mode disclosure',async()=>{
 const data=scan();data.tree.children.push({name:'Empty',path:root+'\\Empty',size:0,children:[]});const f=completed(data);const disclosure=new f.El('details');disclosure._fixtureRoot=true;disclosure.append(f.nodes['fs-map-folders']);f.api.prepare(root);await f.api.start();assert.equal(disclosure.hidden,true);assert.ok(f.api.getState().treeRows.some(row=>row.item.name==='Empty'));assert.equal(f.nodes['vis4-treemap-container'].hidden,false);assert.equal(f.calls.length,2);
});

test('release mismatch remains blocked but has a concise recovery message for the selected location',async()=>{
 const f=fixture();f.window.TLIRelease={requireCapability:async()=>{const error=Error('Long internal compatibility explanation');error.status=409;error.code='host_version_not_ready';throw error;}};f.api.prepare('E:\\');await f.api.start();assert.equal(f.calls.length,0);assert.equal(f.nodes.visualizerScanBtn.disabled,false);assert.match(f.nodes.visualizerStatus.textContent,/Restart TLI.*scan E:/);assert.doesNotMatch(f.nodes.visualizerStatus.textContent,/internal compatibility/);
});
