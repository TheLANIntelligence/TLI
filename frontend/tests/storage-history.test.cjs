const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const full=fs.readFileSync(path.join(__dirname,'../js/visualizer.js'),'utf8');
const source=full.slice(full.indexOf('// ---------- Explicit saved storage observations'),full.indexOf('// ---------- End saved storage observations'));
const protocol='storage-history-v1';
const summary=(id='a',extra={})=>({id:id.repeat(32),version:1,root:'C:\\Users\\demo\\Downloads',scanned_at:id==='a'?'2026-09-01T12:00:00Z':'2026-09-07T12:00:00Z',
  host:{id:'host',name:'Desktop'},drive:{status:'known',fingerprint:'d'.repeat(64)},coverage:{complete:true,reasons:[]},
  filters:{max_depth:18,max_entries:50000,max_seconds:15,excluded_names:['node_modules'],follow_links:false},
  total_bytes:id==='a'?100:150,direct_file_bytes:0,...extra});
const scan=(extra={})=>({meta:{saved_scan:{protocol,available:true,version:1,scan_id:'b'.repeat(32),expires_at:Date.now()/1000+1800,summary:summary('b'),...extra}}});
const comparison=(extra={})=>({ok:true,protocol,comparable:true,reasons:[],point_in_time:true,baseline:summary(),current:summary('b'),
  totals:{before_bytes:100,after_bytes:150,delta_bytes:50,direct_file_delta_bytes:0},
  folders:[{name:'Photos',status:'grew',before_bytes:100,after_bytes:150,delta_bytes:50}],...extra});
const text=n=>n?[n.textContent,...n.children.map(text)].join(' '):'';
function fixture(handler=async()=>({ok:true,protocol,snapshots:[summary()]})) {
  const nodes={},calls=[],events={},all=[];
  function node(tag='div') {
    const el={tag,textContent:'',value:'',children:[],handlers:{},disabled:false,style:{},
      set id(id){this._id=id;nodes[id]=this;},get id(){return this._id;},
      setAttribute(){},append(...children){this.children.push(...children);},appendChild(child){this.append(child);return child;},
      replaceChildren(...children){this.children=children;},after(child){this.sibling=child;},
      addEventListener(type,fn){this.handlers[type]=fn;},click(){return this.disabled?undefined:this.handlers.click?.();},
      change(value){this.value=value;return this.handlers.change?.();}};
    all.push(el);return el;
  }
  const anchor=node();anchor.id='vis4-summary';
  const ctx=vm.createContext({document:{getElementById:id=>nodes[id]||null,createElement:node},
    window:{addEventListener:(name,fn)=>(events[name] ||= []).push(fn)},Date,fetch:async(url,options)=>{
      calls.push({url,options,body:options.body?JSON.parse(options.body):null});const data=await handler(url,options.body?JSON.parse(options.body):null);
      return {ok:!data.httpError,status:data.httpError||200,json:async()=>data};}});
  vm.runInContext(source,ctx,{timeout:1000});ctx.window.TLIStorageHistory.setup();
  return {nodes,calls,all,api:ctx.window.TLIStorageHistory,dispatch:async name=>{for(const fn of events[name]||[])await fn();}};
}
async function ready(f){f.api.receiveScan(scan());await f.nodes['storage-history-load'].click();}

test('history performs no background requests; old or invalid scans cannot save or compare',()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.nodes['storage-history-save'].disabled,true);
  for(const data of [{tree:{}},scan({protocol:'old'}),scan({scan_id:'forged'})]){
    f.api.receiveScan(data);f.nodes['storage-history-save'].click();assert.equal(f.nodes['storage-history-compare'].disabled,true);
  }
  assert.equal(f.calls.length,0);assert.match(text(f.nodes['storage-history-status']),/updated TLI backend/);
});

test('explicit save posts only server scan id/version and confirms saved metadata',async()=>{
  const f=fixture(async()=>({ok:true,protocol,saved:true,snapshot:summary('b')}));f.api.receiveScan(scan());
  assert.equal(f.calls.length,0);await f.nodes['storage-history-save'].click();
  assert.deepEqual(f.calls[0].body,{scan_id:'b'.repeat(32),version:1});
  assert.match(text(f.nodes['storage-history-status']),/Scan summary saved/);assert.equal(f.nodes['storage-history-save'].disabled,true);
});

test('malformed save success retains observation and does not claim it was saved',async()=>{
  for(const result of [{ok:true,protocol},{ok:true,protocol,saved:true,snapshot:summary('a')},
    {ok:true,protocol,saved:true,snapshot:summary('b',{total_bytes:999})}]){
    const f=fixture(async()=>result);f.api.receiveScan(scan());await f.nodes['storage-history-save'].click();
    assert.match(text(f.nodes['storage-history-status']),/not confirmed/);assert.equal(f.nodes['storage-history-save'].disabled,false);
  }
});

test('comparison reports observed growth and literal names with time and scope',async()=>{
  const f=fixture(async(url)=>url.endsWith('/compare')?comparison({folders:[{name:'<img onerror=attack()>',status:'grew',before_bytes:100,after_bytes:150,delta_bytes:50}]}):{ok:true,protocol,snapshots:[summary()]});
  await ready(f);await f.nodes['storage-history-compare'].click();const result=text(f.nodes['storage-history-result']);
  assert.match(result,/changed by \+50 B/);assert.match(result,/<img onerror=attack\(\)>/);
  assert.match(result,/Point-in-time observations/);assert.match(result,/not prove creation or deletion/);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].body,{baseline_id:'a'.repeat(32),scan_id:'b'.repeat(32),version:1});
});

test('partial or changed-drive comparisons never display numerical growth',async()=>{
  const f=fixture(async(url)=>url.endsWith('/compare')?comparison({comparable:false,reasons:['Coverage is incomplete.'],totals:null,folders:[],
    current:summary('b',{coverage:{complete:false,reasons:['Unreadable entries']}})}):{ok:true,protocol,snapshots:[summary()]});
  await ready(f);await f.nodes['storage-history-compare'].click();
  assert.match(text(f.nodes['storage-history-result']),/Comparison unavailable: Coverage is incomplete/);
  assert.doesNotMatch(text(f.nodes['storage-history-result']),/changed by|Grew|Shrank/);
});

test('inconsistent totals, wrong direction, partial claims and wrong identities fail validation',async()=>{
  const invalid=[comparison({totals:{before_bytes:100,after_bytes:150,delta_bytes:999,direct_file_delta_bytes:0}}),
    comparison({folders:[{name:'Photos',status:'grew',before_bytes:150,after_bytes:100,delta_bytes:-50}]}),
    comparison({current:summary('b',{coverage:{complete:false,reasons:['Denied']}})}),
    comparison({current:summary('b',{drive:{status:'known',fingerprint:'e'.repeat(64)}})}),
    comparison({comparable:false,reasons:['Denied']})];
  for(const result of invalid){
    const f=fixture(async(url)=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});
    await ready(f);await f.nodes['storage-history-compare'].click();
    assert.doesNotMatch(text(f.nodes['storage-history-result']),/changed by/);
    assert.match(text(f.nodes['storage-history-status']),/not confirmed|unsupported growth claims/);
  }
});

test('new and not-observed names do not invent a zero baseline or a deleted-file claim',async()=>{
  const f=fixture(async(url)=>url.endsWith('/compare')?comparison({folders:[
    {name:'New',status:'newly_observed',before_bytes:null,after_bytes:50,delta_bytes:null},
    {name:'Old',status:'not_observed',before_bytes:40,after_bytes:null,delta_bytes:null}]}):{ok:true,protocol,snapshots:[summary()]});
  await ready(f);await f.nodes['storage-history-compare'].click();const result=text(f.nodes['storage-history-result']);
  assert.match(result,/Newly observed · 50 B/);assert.match(result,/Not observed in the later scan · previously 40 B/);
  assert.doesNotMatch(result,/0 B → 50 B|40 B → 0 B|deleted/);
});

test('duplicate saves send once and late result cannot replace a newer scan',async()=>{
  let finish;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));f.api.receiveScan(scan());
  const pending=f.nodes['storage-history-save'].click();await f.nodes['storage-history-save'].click();assert.equal(f.calls.length,1);
  f.api.beginScan();f.api.receiveScan(scan({scan_id:'c'.repeat(32),summary:summary('c')}));
  finish({ok:true,protocol,saved:true,snapshot:summary('b')});await pending;
  assert.doesNotMatch(text(f.nodes['storage-history-status']),/Scan summary saved/);assert.equal(f.nodes['storage-history-save'].disabled,false);
});

test('expired scan stays unselectable and network failure never starts a scan or retries',async()=>{
  const f=fixture(async()=>{throw new Error('Disconnected');});f.api.receiveScan(scan({expires_at:Date.now()/1000-1}));
  assert.equal(f.nodes['storage-history-save'].disabled,true);f.api.receiveScan(scan());
  await f.nodes['storage-history-save'].click();assert.equal(f.calls.length,1);assert.match(text(f.nodes['storage-history-status']),/No scan or retry ran automatically/);
});

test('failed replacement scan retains the prior observation without extending its expiry or making requests',async()=>{
  const f=fixture(async()=>({ok:true,protocol,saved:true,snapshot:summary('b')}));
  f.api.receiveScan(scan());const previous=text(f.nodes['storage-history-current']);
  f.api.beginScan(true);
  assert.equal(text(f.nodes['storage-history-current']),previous);
  assert.equal(f.nodes['storage-history-save'].disabled,true);
  await f.nodes['storage-history-save'].click();assert.equal(f.calls.length,0);
  f.api.scanFailed();
  assert.equal(text(f.nodes['storage-history-current']),previous);
  assert.equal(f.nodes['storage-history-save'].disabled,false);
  assert.match(text(f.nodes['storage-history-status']),/previous observation is retained/);
  await f.nodes['storage-history-save'].click();
  assert.deepEqual(f.calls[0].body,{scan_id:'b'.repeat(32),version:1});
  f.api.receiveScan(scan({expires_at:Date.now()/1000-1}));
  f.api.beginScan(true);f.api.scanFailed();
  assert.equal(f.nodes['storage-history-save'].disabled,true);
});

test('private history and pending responses clear on session lock',async()=>{
  let finish;const f=fixture(async()=>new Promise(resolve=>{finish=resolve;}));f.api.receiveScan(scan());
  const pending=f.nodes['storage-history-load'].click();await f.dispatch('tli-session-locked');
  finish({ok:true,protocol,snapshots:[summary()]});await pending;
  assert.equal(text(f.nodes['storage-history-current']),'');assert.equal(f.nodes['storage-history-baseline'].children.length,1);
  assert.equal(f.nodes['storage-history-save'].disabled,true);assert.equal(text(f.nodes['storage-history-status']),'');
});

test('display filters do not change host summary totals or trigger any requests',()=>{
  const f=fixture();const data=scan();f.api.receiveScan(data);
  assert.match(text(f.nodes['storage-history']),/map and display filters do not change saved totals/);
  assert.match(text(f.nodes['storage-history-current']),/150 B inspected file bytes/);assert.equal(f.calls.length,0);
});

test('removing one selected summary needs explicit review and never starts a filesystem request',async()=>{
  const f=fixture(async(url)=>url.endsWith('/'+ 'a'.repeat(32))?{ok:true,protocol,deleted:true,snapshot_id:'a'.repeat(32)}:
    {ok:true,protocol,snapshots:[summary()]});
  await ready(f);await f.nodes['storage-history-remove'].click();
  assert.equal(f.calls.length,1);assert.match(text(f.nodes['storage-history-remove-review']),/folder and its files will not be touched/);
  await f.nodes['storage-history-remove-confirm'].click();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.method,'DELETE');
  assert.match(text(f.nodes['storage-history-status']),/Saved summary removed/);assert.equal(f.nodes['storage-history-baseline'].children.length,1);
});

test('failed or malformed removal retains saved selection and duplicate clicks send once',async()=>{
  let finish;const f=fixture(async(url)=>url.endsWith('/'+ 'a'.repeat(32))?new Promise(resolve=>{finish=resolve;}):
    {ok:true,protocol,snapshots:[summary()]});
  await ready(f);await f.nodes['storage-history-remove'].click();const pending=f.nodes['storage-history-remove-confirm'].click();
  await f.nodes['storage-history-remove-confirm'].click();assert.equal(f.calls.length,2);
  finish({ok:true,protocol,deleted:true,snapshot_id:'b'.repeat(32)});await pending;
  assert.match(text(f.nodes['storage-history-status']),/not confirmed/);assert.equal(f.nodes['storage-history-baseline'].children.length,2);
});

test('changing baseline cancels its removal confirmation',async()=>{
  const f=fixture(async()=>({ok:true,protocol,snapshots:[summary(),summary('c')]}));
  await ready(f);await f.nodes['storage-history-remove'].click();
  const confirm=f.nodes['storage-history-remove-confirm'];f.nodes['storage-history-baseline'].change('c'.repeat(32));
  await confirm.click();assert.equal(f.calls.length,1);assert.equal(text(f.nodes['storage-history-remove-review']),'');
});

test('volume capacity remains distinct from unsupported partial file-growth claims',async()=>{
  const before={total:1000,used:700,free:300,root_is_volume:true},after={total:1000,used:800,free:200,root_is_volume:true};
  const f=fixture(async url=>url.endsWith('/compare')?comparison({comparable:false,reasons:['Coverage is incomplete.'],totals:null,folders:[],current:summary('b',{coverage:{complete:false,reasons:['Unreadable entries']}}),capacity:{available:true,before,after,used_delta_bytes:100,free_delta_bytes:-100,scanned_logical_delta_bytes:null,scanned_allocated_delta_bytes:null,unexplained_delta_bytes:null,explanation:'No cause established.'}}):{ok:true,protocol,snapshots:[summary('a',{capacity:before})]});
  await ready(f);await f.nodes['storage-history-compare'].click();const result=text(f.nodes['storage-history-result']);assert.match(result,/Available space changed by −100 B/);assert.doesNotMatch(result,/Inspected file bytes changed|Difference not explained/);
  assert.match(text(f.nodes['storage-history-timeline']),/300 B free/);await f.dispatch('tli-session-locked');assert.doesNotMatch(text(f.nodes['storage-history-timeline']),/300 B|Downloads/);
});
test('retention changes are explicit and use configured PUT without touching scanned files',async()=>{
  const settings={max_snapshots:5,max_age_days:30,auto_prune:true};const f=fixture(async url=>({ok:true,protocol,...settings}));
  f.nodes['storage-retention-count'].value=5;f.nodes['storage-retention-days'].value=30;f.nodes['storage-retention-auto'].checked=true;
  assert.equal(f.calls.length,0);await f.all.find(n=>n.textContent==='Save retention settings').click();assert.equal(f.calls[0].url,'/visualizer/history/retention');assert.equal(f.calls[0].options.method,'PUT');assert.deepEqual(f.calls[0].body,settings);
});

test('partial compatible scans display only measured overlapping file changes without whole-scan attribution',async()=>{
 const result=comparison({comparable:false,reasons:['Coverage is incomplete.'],totals:null,folders:[],current:summary('b',{coverage:{complete:false,reasons:['Unreadable entries']}}),file_comparison:{available:true,complete:false,reason:'Only overlapping retained paths can be compared.'},files:[{path:'C:\\Users\\demo\\Downloads\\model.gguf',status:'grew',before_bytes:100,after_bytes:150,delta_bytes:50},{path:'unproven-new.txt',status:'newly_observed',before_bytes:null,after_bytes:400,delta_bytes:null}]});
 const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});await ready(f);await f.nodes['storage-history-compare'].click();const displayed=text(f.nodes['storage-history-result']);
 assert.match(displayed,/model.gguf · grew · \+50 B/);assert.doesNotMatch(displayed,/unproven-new|Inspected file bytes changed|Files directly in this folder changed/);assert.match(text(f.nodes['storage-history-status']),/Individual measured file changes/);
});
test('partial file evidence cannot cross drive identity or policy boundaries',async()=>{
 const result=comparison({comparable:false,reasons:['Different drive.'],totals:null,folders:[],current:summary('b',{drive:{status:'known',fingerprint:'e'.repeat(64)},coverage:{complete:false,reasons:['Unreadable entries']}}),file_comparison:{available:true,complete:false},files:[{path:'untrusted.txt',status:'grew',before_bytes:100,after_bytes:150,delta_bytes:50}]});
 const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});await ready(f);await f.nodes['storage-history-compare'].click();assert.doesNotMatch(text(f.nodes['storage-history-result']),/untrusted.txt|\+50 B/);
});
test('hardlink attribution suppression keeps root change while withholding folder and direct-file deltas',async()=>{
 const result=comparison({totals:{before_bytes:100,after_bytes:150,delta_bytes:50,direct_file_delta_bytes:null,direct_file_delta_available:false},folders:[],folder_comparison:{available:false,reason:'Hard-link alias attribution can move counted bytes between folders.'},message:'Root totals count linked content once.'});
 const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});await ready(f);await f.nodes['storage-history-compare'].click();const displayed=text(f.nodes['storage-history-result']);assert.match(displayed,/Inspected file bytes changed by \+50 B/);assert.match(displayed,/Hard-link alias attribution|Root totals count/);assert.doesNotMatch(displayed,/Files directly in this folder changed|No immediate-folder size changes/);
});

test('selected history uses cached root, immediate-folder and relative-file evidence without requests',async()=>{
 const result=comparison({file_comparison:{available:true,complete:false},files:[{path:'Photos/movie.mov',status:'grew',before_bytes:10,after_bytes:30,delta_bytes:20}]});
 const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});
 await ready(f);f.api.selectPath(summary().root+'\\Photos');
 assert.equal(f.calls.length,1);assert.match(text(f.nodes['storage-history-selection']),/Comparison unavailable.*run Compare/);
 await f.nodes['storage-history-compare'].click();
 assert.match(text(f.nodes['storage-history-selection']),/Recorded immediate folder logical size changed by \+50 B/);
 f.api.selectPath(summary().root);assert.match(text(f.nodes['storage-history-selection']),/Recorded root bytes changed by \+50 B/);
 f.api.selectPath('c:/users/demo/downloads/photos/MOVIE.mov');assert.match(text(f.nodes['storage-history-selection']),/Recorded file path logical size changed by \+20 B/);
 assert.equal(f.calls.length,2);
 f.api.selectPath(null);assert.equal(text(f.nodes['storage-history-selection']),'');assert.equal(f.calls.length,2);
});

test('missing or unretained selected paths never imply an unchanged size, even for complete scans',async()=>{
 const f=fixture(async url=>url.endsWith('/compare')?comparison({files:[],file_comparison:{available:true,complete:true}}):{ok:true,protocol,snapshots:[summary()]});
 await ready(f);await f.nodes['storage-history-compare'].click();
 for(const suffix of ['\\missing.txt','\\Photos\\unretained.txt','\\Photos\\Nested']) {
   f.api.selectPath(summary().root+suffix);const selected=text(f.nodes['storage-history-selection']);
   assert.match(selected,/Comparison unavailable/);assert.match(selected,/Missing entries are not evidence of no change/);assert.doesNotMatch(selected,/changed by|unchanged|0 B/);
 }
 f.api.selectPath(summary().root+'-other\\Photos');assert.match(text(f.nodes['storage-history-selection']),/outside the compared root/);
 assert.equal(f.calls.length,2);
});

test('selected partial history exposes only supported overlapping file sizes, never folder or root totals',async()=>{
 const result=comparison({comparable:false,reasons:['Coverage is incomplete.'],totals:null,folders:[],current:summary('b',{coverage:{complete:false,reasons:['Denied']}}),
   file_comparison:{available:true,complete:false},files:[{path:'Photos/movie.mov',status:'grew',before_bytes:10,after_bytes:30,delta_bytes:20},
     {path:'new.txt',status:'newly_observed',before_bytes:null,after_bytes:70,delta_bytes:null}]});
 const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});await ready(f);await f.nodes['storage-history-compare'].click();
 f.api.selectPath(summary().root+'\\Photos\\movie.mov');
 assert.match(text(f.nodes['storage-history-selection']),/changed by \+20 B/);assert.match(text(f.nodes['storage-history-selection']),/Partial coverage.*Whole-scan growth is unavailable/);
 for(const path of [summary().root,summary().root+'\\Photos',summary().root+'\\new.txt']) {
   f.api.selectPath(path);assert.match(text(f.nodes['storage-history-selection']),/Comparison unavailable/);assert.doesNotMatch(text(f.nodes['storage-history-selection']),/changed by|70 B/);
 }
});

test('selected file claims reject malformed rows, ambiguous paths and mismatched accounting policy',async()=>{
 const row={path:'model.gguf',status:'grew',before_bytes:10,after_bytes:30,delta_bytes:20};
 for(const extra of [
   {files:[{...row,delta_bytes:80}]},{files:[row,row]},
   {files:[{...row,path:'../model.gguf'}]},{files:[{...row,path:summary().root+'\\model.gguf'}]},
   {files:[{...row,status:'added',before_bytes:null,delta_bytes:null}],file_comparison:{available:true,complete:false}},
   {files:[row],current:summary('b',{filters:{...summary().filters,hardlink_accounting:'different'}})},
   {files:[row],current:summary('b',{accounting:{identity_unknown:1}})}
 ]) {
   const result=comparison({file_comparison:{available:true,complete:false},...extra});
   const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});await ready(f);await f.nodes['storage-history-compare'].click();
   f.api.selectPath(summary().root+'\\model.gguf');assert.match(text(f.nodes['storage-history-selection']),/Comparison unavailable/);assert.doesNotMatch(text(f.nodes['storage-history-selection']),/changed by|30 B/);
 }
});

test('selected absence evidence retains unknown baseline instead of inventing zero or deletion',async()=>{
 const result=comparison({file_comparison:{available:true,complete:true},files:[{path:'new.txt',status:'added',before_bytes:null,after_bytes:50,delta_bytes:null},
   {path:'old.txt',status:'removed',before_bytes:30,after_bytes:null,delta_bytes:null}]});
 const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});await ready(f);await f.nodes['storage-history-compare'].click();
 f.api.selectPath(summary().root+'\\new.txt');let selected=text(f.nodes['storage-history-selection']);
 assert.match(selected,/newly observed at 50 B/);assert.match(selected,/No measured before-and-after size delta/);assert.doesNotMatch(selected,/0 B →|changed by/);
 f.api.selectPath(summary().root+'\\old.txt');selected=text(f.nodes['storage-history-selection']);
 assert.match(selected,/not observed in the later scan; previously 30 B/);assert.doesNotMatch(selected,/→ 0 B|changed by|was deleted/);
});

test('selected history can identify retained files beyond the bounded generic display list',async()=>{
 const files=Array.from({length:150},(_,i)=>({path:'file-'+i+'.txt',status:'grew',before_bytes:10,after_bytes:30,delta_bytes:20}));
 const f=fixture(async url=>url.endsWith('/compare')?comparison({file_comparison:{available:true,complete:false},files}):{ok:true,protocol,snapshots:[summary()]});
 await ready(f);await f.nodes['storage-history-compare'].click();f.api.selectPath(summary().root+'\\file-149.txt');
 assert.match(text(f.nodes['storage-history-selection']),/changed by \+20 B/);assert.equal(f.calls.length,2);
});

test('selected history clears comparison on baseline change, new scan and lock, including pending comparisons',async()=>{
 let pendingResolve,pending=false;
 const f=fixture(async url=>url.endsWith('/compare')?pending?new Promise(resolve=>pendingResolve=resolve):comparison():{ok:true,protocol,snapshots:[summary(),summary('c')]});
 await ready(f);await f.nodes['storage-history-compare'].click();f.api.selectPath(summary().root);assert.match(text(f.nodes['storage-history-selection']),/changed by/);
 f.nodes['storage-history-baseline'].change('c'.repeat(32));assert.doesNotMatch(text(f.nodes['storage-history-selection']),/changed by/);
 f.nodes['storage-history-baseline'].change('a'.repeat(32));assert.doesNotMatch(text(f.nodes['storage-history-selection']),/changed by/);
 pending=true;const request=f.nodes['storage-history-compare'].click();f.nodes['storage-history-baseline'].change('c'.repeat(32));pendingResolve(comparison());await request;
 assert.doesNotMatch(text(f.nodes['storage-history-selection']),/changed by/);
 f.api.beginScan(true);assert.equal(text(f.nodes['storage-history-selection']),'');f.api.scanFailed();f.api.selectPath(summary().root);assert.match(text(f.nodes['storage-history-selection']),/Comparison unavailable/);
 await f.dispatch('tli-session-locked');assert.equal(text(f.nodes['storage-history-selection']),'');
});

test('hardlink folder suppression applies to selected history while keeping measured root evidence',async()=>{
 const result=comparison({totals:{before_bytes:100,after_bytes:150,delta_bytes:50,direct_file_delta_bytes:null,direct_file_delta_available:false},folders:[],folder_comparison:{available:false,reason:'Hard-link alias attribution is ambiguous.'}});
 const f=fixture(async url=>url.endsWith('/compare')?result:{ok:true,protocol,snapshots:[summary()]});await ready(f);await f.nodes['storage-history-compare'].click();
 f.api.selectPath(summary().root+'\\Photos');assert.match(text(f.nodes['storage-history-selection']),/Comparison unavailable.*Hard-link alias/);
 f.api.selectPath(summary().root);assert.match(text(f.nodes['storage-history-selection']),/Recorded root bytes changed by \+50 B/);
});
