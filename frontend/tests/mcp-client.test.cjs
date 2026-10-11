const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../js/mcp-client.js'),'utf8'),P='tli-mcp-client-v1';
const connection=()=>({id:'a'.repeat(32),endpoint:'http://127.0.0.1:8124/mcp',expires_at:new Date(Date.now()+890000).toISOString(),protocol_version:'2026-07-28',catalogue_fingerprint:'b'.repeat(64),server_info:{name:'Synthetic MCP'},checked_at:'earlier'});
const tool=()=>({definition:{name:'fixture.echo',description:'<script>untrusted</script>',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true}},fingerprint:'c'.repeat(64),supported:true,reason:null});
function fixture(){
 const nodes={},events={},calls=[],timers=new Map();let seq=0;
 function make(tag){const n={tag,textContent:'',value:'',checked:false,children:[],handlers:{},disabled:false,
  append(...items){this.children.push(...items);if(tag==='select'&&!this.value&&items[0])this.value=items[0].value;},replaceChildren(...items){this.children=[];if(tag==='select')this.value='';this.append(...items);},setAttribute(){},
  addEventListener(k,fn){(this.handlers[k]||=[]).push(fn);},fire(k='click'){return Promise.all((this.handlers[k]||[]).map(fn=>fn({})));},click(){return this.disabled?Promise.resolve():this.fire();}};
  Object.defineProperty(n,'id',{set(id){nodes[id]=this;}});Object.defineProperty(n,'childNodes',{get(){return this.children;}});return n;}
 nodes['settings-mcp-client-mount']=make('div');const f={nodes,calls,handler:async(op,data)=>{
  const base={ok:true,protocol:P};
  if(op==='status')return {...base,connections:[],connected:false,remote_requests:false};
  if(op==='connection-review')return {...base,review_token:'d'.repeat(64),endpoint:connection().endpoint,insecure_http:true,remote_requests:false,scope:'Only discovery and list'};
  if(op==='connect'||op==='list')return {...base,connection:connection(),tools:[tool()],tool_invoked:false};
  if(op==='tool-review')return {...base,review_token:'e'.repeat(64),review_hash:'f'.repeat(64),expires_at:new Date(Date.now()+119000).toISOString(),tool_invoked:false,review:{endpoint:connection().endpoint,tool_fingerprint:tool().fingerprint,tool:tool().definition,arguments:data.arguments,actual_effect:'unknown',mirrored_headers:{}}};
  if(op==='invoke')return {...base,request_id:data.request_id,outcome:'completed',checked_at:'fixture-time',requires_review:true,endpoint:connection().endpoint,tool_name:tool().definition.name,output:{text:['<script>untrusted returned text</script>'],structured:{message:'fixture'},omitted_content_items:1},message:'Server returned result; effect unverified.'};
  if(op==='disconnect')return {...base,disconnected:true,remote_requests:false};
 }};
 const ctx=vm.createContext({console,Date,AbortController,TextEncoder,TextDecoder,
  setTimeout(fn,delay){const id=++seq;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
  document:{readyState:'complete',visibilityState:'visible',getElementById:id=>nodes[id],createElement:make,addEventListener:(k,fn)=>(events[k]||=[]).push(fn)},
  window:{crypto:{randomUUID:()=> '12345678-1234-4234-8234-123456789abc'},addEventListener:(k,fn)=>(events[k]||=[]).push(fn)},
  localStorage:{setItem(){assert.fail('No credentials or states persisted');}},
  fetch:async(url,options)=>{const op=url.split('/').pop(),body=options.body?JSON.parse(options.body):undefined;calls.push({op,body});const value=await f.handler(op,body);return {status:value._status||200,ok:!value._status||value._status<400,body:null,text:async()=>JSON.stringify(value)};}
 });vm.runInContext(code,ctx);f.ctx=ctx;f.timers=timers;
 f.emit=(k,detail)=>Promise.all((events[k]||[]).map(fn=>fn({detail})));
 f.text=id=>{const flat=n=>[n.textContent,...n.children.flatMap(flat)];return flat(nodes[id]).join(' ');};
 f.reviewEndpoint=async()=>{nodes['mc-endpoint'].value=connection().endpoint;nodes['mc-token'].value='synthetic external token';await nodes['mc-review-endpoint'].click();nodes['mc-endpoint-reviewed'].checked=true;await nodes['mc-endpoint-reviewed'].fire('change');};
 f.connect=async()=>{await f.reviewEndpoint();await nodes['mc-connect'].click();};
 f.review=async()=>{nodes['mc-tool'].value=tool().definition.name;await nodes['mc-tool'].fire('change');nodes['mc-arguments'].value='{"text":"only this input"}';await nodes['mc-arguments'].fire('input');await nodes['mc-tool-review'].click();nodes['mc-tool-reviewed'].checked=true;await nodes['mc-tool-reviewed'].fire('change');};
 f.ready=async()=>{await f.connect();await f.review();};return f;
}
test('opening performs no request and endpoint review never sends credentials',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);await f.emit('tli-panel-switched',{panelId:'panel-settings'});assert.equal(f.calls.length,0);await f.reviewEndpoint();assert.deepEqual(f.calls,[{op:'connection-review',body:{endpoint:connection().endpoint}}]);
});
test('connect, exact schema review and explicit invocation remain distinct',async()=>{
 const f=fixture();await f.ready();assert.deepEqual(f.calls.map(c=>c.op),['connection-review','connect','tool-review']);assert.equal(f.nodes['mc-token'].value,'');assert.match(f.text('mc-definition'),/<script>untrusted/);assert.match(f.text('mc-review'),/Actual effect is unknown/);
 assert.deepEqual(f.calls[2].body.arguments,{text:'only this input'});await f.nodes['mc-invoke'].click();assert.equal(f.calls.at(-1).body.reviewed,true);assert.equal(f.nodes['mc-invoke'].disabled,true);assert.match(f.text('mc-result'),/untrusted returned text/);
});
test('duplicate invocation events send one request and every review is consumed',async()=>{
 const f=fixture();await f.ready();const original=f.handler;let finish;f.handler=(op,data)=>op==='invoke'?new Promise(resolve=>finish=()=>original(op,data).then(resolve)):original(op,data);
 const pending=f.nodes['mc-invoke'].fire();await f.nodes['mc-invoke'].fire();assert.equal(f.calls.filter(c=>c.op==='invoke').length,1);finish();await pending;assert.equal(f.nodes['mc-invoke'].disabled,true);
});
test('failed candidate and failed list retain prior source, catalogue and arguments',async()=>{
 const f=fixture();await f.ready();const old=f.text('mc-current'),def=f.text('mc-definition');f.handler=async()=>({_status:502,detail:'Candidate failed'});await f.nodes['mc-list'].click();assert.equal(f.text('mc-current'),old);assert.equal(f.text('mc-definition'),def);assert.equal(f.nodes['mc-arguments'].value,'{"text":"only this input"}');
});
test('unknown or failed replacement preserves previous completed result and prohibits replay',async()=>{
 const f=fixture();await f.ready();await f.nodes['mc-invoke'].click();const old=f.text('mc-result');await f.review();f.handler=async(op,data)=>({ok:true,protocol:P,request_id:data.request_id,outcome:'unknown',requires_review:true,checked_at:'later',message:'A remote effect may have occurred. No retry.'});await f.nodes['mc-invoke'].click();assert.equal(f.text('mc-result'),old);assert.match(f.text('mc-attempt'),/outcome unknown/);assert.equal(f.nodes['mc-invoke'].disabled,true);
});
test('server reported tool error is shown separately from previous completed output',async()=>{
 const f=fixture();await f.ready();await f.nodes['mc-invoke'].click();const old=f.text('mc-result');await f.review();const original=f.handler;f.handler=async(op,data)=>{const d=await original(op,data);if(op==='invoke'){d.outcome='server_error';d.output.text=['Synthetic error'];}return d;};await f.nodes['mc-invoke'].click();assert.equal(f.text('mc-result'),old);assert.match(f.text('mc-attempt'),/Synthetic error/);
});
test('transport failure retains prior output but disables old invocation review',async()=>{
 const f=fixture();await f.ready();await f.nodes['mc-invoke'].click();const old=f.text('mc-result');await f.review();f.handler=async()=>({_status:502,detail:'Response lost'});await f.nodes['mc-invoke'].click();assert.equal(f.text('mc-result'),old);assert.equal(f.nodes['mc-invoke'].disabled,true);assert.match(f.text('mc-status'),/retained/);
});
test('argument changes and tool changes invalidate review without remote requests',async()=>{
 const f=fixture();await f.ready();const n=f.calls.length;f.nodes['mc-arguments'].value='{"text":"changed"}';await f.nodes['mc-arguments'].fire('input');assert.equal(f.calls.length,n);assert.equal(f.nodes['mc-invoke'].disabled,true);assert.match(f.text('mc-review'),/changed/);
});
test('invalid or oversized JSON and unsupported tools cannot prepare invocation',async()=>{
 const f=fixture();await f.connect();f.nodes['mc-tool'].value=tool().definition.name;await f.nodes['mc-tool'].fire('change');f.nodes['mc-arguments'].value='[]';await f.nodes['mc-tool-review'].click();assert.equal(f.calls.length,2);
 f.nodes['mc-arguments'].value='x'.repeat(16385);await f.nodes['mc-tool-review'].click();assert.equal(f.calls.length,2);assert.match(f.text('mc-status'),/16 KiB/);
 const original=f.handler;f.handler=async(op,data)=>{const d=await original(op,data);if(op==='list'){d.tools[0].supported=false;d.tools[0].reason='Unsupported reference';}return d;};await f.nodes['mc-list'].click();assert.equal(f.nodes['mc-tool-review'].disabled,true);assert.match(f.text('mc-definition'),/Unsupported reference/);
});
test('PIN lock and close discard late private results with no automatic reconnect',async()=>{
 for(const event of ['tli-session-locked','pagehide']){const f=fixture();await f.ready();const original=f.handler;let finish;f.handler=(op,data)=>new Promise(resolve=>finish=()=>original(op,data).then(resolve));const pending=f.nodes['mc-invoke'].click();await f.emit(event);finish();await pending;assert.equal(f.text('mc-current'),'');assert.equal(f.text('mc-result'),'');assert.equal(f.nodes['mc-arguments'].value,'');assert.equal(f.nodes['mc-invoke'].disabled,true);assert.equal(f.calls.length,4);}
});
test('Stop waiting preserves prior output but discards late new result and invocation review',async()=>{
 const f=fixture();await f.ready();await f.nodes['mc-invoke'].click();const old=f.text('mc-result');await f.review();const original=f.handler;let finish;f.handler=(op,data)=>new Promise(resolve=>finish=()=>original(op,data).then(resolve));const pending=f.nodes['mc-invoke'].click();await f.nodes['mc-stop'].click();finish();await pending;assert.equal(f.text('mc-result'),old);assert.match(f.text('mc-status'),/did not prove cancellation/);assert.equal(f.nodes['mc-invoke'].disabled,true);
});
test('expired connection and review clear authority without a network retry',async()=>{
 const f=fixture();await f.ready();let timer=[...f.timers.values()].find(t=>t.delay>100000&&t.delay<=120000);assert.ok(timer);const n=f.calls.length;timer.fn();assert.equal(f.nodes['mc-invoke'].disabled,true);assert.equal(f.calls.length,n);
 timer=[...f.timers.values()].find(t=>t.delay>800000);timer.fn();assert.equal(f.text('mc-current'),'');assert.equal(f.nodes['mc-token'].value,'');assert.equal(f.calls.length,n);
});
test('server permission failure does not claim TLI PIN expiry; real PIN401 clears fields',async()=>{
 const f=fixture();await f.ready();f.handler=async()=>({_status:502,detail:'Remote server rejected its token'});await f.nodes['mc-list'].click();assert.notEqual(f.text('mc-current'),'');f.handler=async()=>({_status:401,detail:'PIN expired'});await f.nodes['mc-list'].click();assert.equal(f.text('mc-current'),'');assert.equal(f.nodes['mc-arguments'].value,'');
});
test('late401 from a stopped view cannot clear a subsequently reopened connection',async()=>{
 const f=fixture();await f.ready();const original=f.handler;let finish;f.handler=()=>new Promise(resolve=>finish=resolve);const pending=f.nodes['mc-list'].click();await f.nodes['mc-stop'].click();f.handler=original;await f.connect();const current=f.text('mc-current');finish({_status:401,detail:'Old session request expired'});await pending;assert.equal(f.text('mc-current'),current);assert.equal(f.nodes['mc-list'].disabled,false);
});
