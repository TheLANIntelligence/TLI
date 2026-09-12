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
