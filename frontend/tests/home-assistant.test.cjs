const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../js/home-assistant.js'),'utf8'),P='tli-home-assistant-v1';
const connection=()=>({id:'a'.repeat(32),origin:'http://192.168.4.9:8123',addresses:['192.168.4.9'],insecure_http:true,expires_at:new Date(Date.now()+890000).toISOString()});
const row=()=>({entity_id:'light.desk',name:'Desk lamp',state:'off',availability:'reported',revision:'b'.repeat(64),can_review_action:true,last_changed:'earlier',last_updated:'earlier'});
function fixture(){
 const nodes={},events={},calls=[],timers=new Map();let seq=0;
 function make(tag){const n={tag,textContent:'',value:'',checked:false,children:[],handlers:{},disabled:false,
  append(...items){this.children.push(...items);if(tag==='select'&&!this.value&&items[0])this.value=items[0].value;},replaceChildren(...items){this.children=[];if(tag==='select')this.value='';this.append(...items);},setAttribute(){},
  addEventListener(k,fn){(this.handlers[k]||=[]).push(fn);},fire(k='click'){return Promise.all((this.handlers[k]||[]).map(fn=>fn({})));},click(){return this.disabled?Promise.resolve():this.fire();}};
  Object.defineProperty(n,'id',{set(id){nodes[id]=this;}});Object.defineProperty(n,'childNodes',{get(){return this.children;}});return n;}
 nodes['home-assistant-mount']=make('div');const f={nodes,calls,handler:async(op,data)=>{
  const base={ok:true,protocol:P,actions_performed:false};
  if(op==='status')return {...base,connections:[],connected:false};
  if(op==='connection-review')return {...base,review_token:'c'.repeat(64),origin:connection().origin,addresses:connection().addresses,insecure_http:true,credential_sent:false,expires_in_seconds:300,scope:'One reviewed origin'};
  if(op==='connect')return {...base,connection:connection(),states_read:false};
  if(op==='states')return {...base,connection_id:connection().id,checked_at:'fixture-time',items:[row()],omitted_entities:2};
  if(op==='action-review')return {...base,review_token:'d'.repeat(64),review_hash:'e'.repeat(64),target:{connection_id:connection().id,entity:row(),action:data.action,origin:connection().origin,addresses:connection().addresses},scope:'One exact entity, no physical confirmation.'};
  if(op==='execute')return {...base,ok:true,connection_id:connection().id,outcome:'accepted',actions_performed:true,inference_called:false,summary:'HA acknowledged; physical state unverified.',checked_at:'fixture-time'};
  if(op==='disconnect')return {...base,disconnected:true};
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
 f.reviewOrigin=async()=>{nodes['ha-origin'].value=connection().origin;nodes['ha-http'].checked=true;nodes['ha-token'].value='private synthetic HA token';await nodes['ha-review-connection'].click();nodes['ha-origin-reviewed'].checked=true;await nodes['ha-origin-reviewed'].fire('change');};
 f.connect=async()=>{await f.reviewOrigin();await nodes['ha-connect'].click();};
 f.ready=async()=>{await f.connect();await nodes['ha-read'].click();await nodes['ha-review-on'].click();nodes['ha-action-reviewed'].checked=true;await nodes['ha-action-reviewed'].fire('change');};return f;
}
test('opening and origin review never send token, fetch states or execute actions',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);await f.emit('tli-panel-switched',{panelId:'panel-homeauto'});assert.equal(f.calls.length,0);
 await f.reviewOrigin();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{op:'connection-review',body:{origin:connection().origin,allow_insecure_http:true}});
});
test('connect, read, fresh review and exact service submission are separate',async()=>{
 const f=fixture();await f.ready();assert.deepEqual(f.calls.map(c=>c.op),['connection-review','connect','states','action-review']);assert.equal(f.nodes['ha-token'].value,'');
 await f.nodes['ha-run'].click();assert.equal(f.calls.at(-1).op,'execute');assert.equal(f.calls.at(-1).body.connection_id,connection().id);assert.equal(f.calls.at(-1).body.reviewed,true);assert.match(f.text('ha-result'),/physical state unverified/);assert.equal(f.nodes['ha-run'].disabled,true);
});
test('failed candidate connection preserves existing session, selected states and typed token',async()=>{
 const f=fixture();await f.connect();await f.nodes['ha-read'].click();const old=f.text('ha-current');await f.reviewOrigin();f.handler=async()=>({_status:502,detail:'Candidate HA rejected the token'});await f.nodes['ha-connect'].click();
 assert.equal(f.text('ha-current'),old);assert.match(f.text('ha-state-summary'),/1 total/);assert.equal(f.nodes['ha-token'].value,'private synthetic HA token');assert.equal(f.nodes['ha-read'].disabled,false);
});
test('failed replacement state read and failed disconnect preserve earlier dated results',async()=>{
 const f=fixture();await f.ready();const previous=f.text('ha-state-summary');f.handler=async()=>({_status:502,detail:'Home Assistant unavailable'});await f.nodes['ha-read'].click();assert.equal(f.text('ha-state-summary'),previous);
 await f.nodes['ha-disconnect'].click();assert.equal(f.nodes['ha-read'].disabled,false);assert.match(f.text('ha-status'),/retained/);
});
test('duplicate action events send once and uncertainty requires a new review',async()=>{
 const f=fixture();await f.ready();let finish;f.handler=()=>new Promise(resolve=>finish=resolve);const pending=f.nodes['ha-run'].fire();await f.nodes['ha-run'].fire();assert.equal(f.calls.filter(c=>c.op==='execute').length,1);
 finish({ok:false,protocol:P,connection_id:connection().id,outcome:'unknown',actions_performed:null,inference_called:false,summary:'Unconfirmed; nothing retries automatically.'});await pending;
 assert.match(f.text('ha-result'),/unconfirmed/i);assert.equal(f.nodes['ha-run'].disabled,true);
});
test('failed execute preserves old result but never permits replay of that review',async()=>{
 const f=fixture();await f.ready();await f.nodes['ha-run'].click();const old=f.text('ha-result');await f.nodes['ha-review-off'].click();f.nodes['ha-action-reviewed'].checked=true;await f.nodes['ha-action-reviewed'].fire('change');
 f.handler=async()=>({_status:502,detail:'Response lost after submission'});await f.nodes['ha-run'].click();assert.equal(f.text('ha-result'),old);assert.equal(f.nodes['ha-run'].disabled,true);assert.match(f.text('ha-action-review'),/No automatic retry/);
});
test('wrong target review cannot enable Run, even with same name',async()=>{
 const f=fixture();await f.connect();await f.nodes['ha-read'].click();const handler=f.handler;f.handler=async(op,data)=>{const result=await handler(op,data);if(op==='action-review')result.target.entity.entity_id='light.someone_else';return result;};
 await f.nodes['ha-review-on'].click();assert.match(f.text('ha-status'),/exact reviewed target/);assert.equal(f.nodes['ha-run'].disabled,true);
});
test('PIN lock discards late connection and source results without reconnecting',async()=>{
 const f=fixture();await f.reviewOrigin();let finish;f.handler=()=>new Promise(resolve=>finish=resolve);const pending=f.nodes['ha-connect'].click();await f.emit('tli-session-locked');finish({ok:true,protocol:P,connection:connection(),actions_performed:false,states_read:false});await pending;
 assert.equal(f.text('ha-current'),'');assert.equal(f.nodes['ha-token'].value,'');assert.equal(f.nodes['ha-read'].disabled,true);assert.equal(f.calls.length,2);
});
test('closing panel clears secrets and views without claiming server cancellation',async()=>{
 const f=fixture();await f.ready();await f.nodes['ha-run'].click();const count=f.calls.length;await f.emit('tli-panel-switched',{panelId:'panel-main'});
 assert.equal(f.calls.length,count);assert.equal(f.text('ha-result'),'');assert.equal(f.text('ha-current'),'');assert.match(f.text('ha-status'),/does not.*cancel/);
});
test('changing origin or filtering entities invalidates the reviewed intent without network',async()=>{
 const f=fixture();await f.reviewOrigin();const count=f.calls.length;f.nodes['ha-origin'].value='http://different:8123';await f.nodes['ha-origin'].fire('input');assert.equal(f.nodes['ha-connect'].disabled,true);assert.equal(f.calls.length,count);
 await f.ready();const after=f.calls.length;f.nodes['ha-filter'].value='desk';await f.nodes['ha-filter'].fire('input');assert.equal(f.calls.length,after);assert.equal(f.nodes['ha-run'].disabled,true);
});
test('large state lists are locally bounded and distinguish an unavailable target',async()=>{
 const f=fixture();await f.connect();const handler=f.handler;f.handler=async(op,data)=>{const result=await handler(op,data);if(op==='states')result.items=Array.from({length:120},(_,i)=>({...row(),entity_id:'light.entity_'+i,state:'unavailable',can_review_action:false}));return result;};
 await f.nodes['ha-read'].click();assert.equal(f.nodes['ha-entity'].children.length,50);assert.match(f.text('ha-state-summary'),/50 of 120/);assert.equal(f.nodes['ha-review-on'].disabled,true);
});
test('known connection expiry clears displayed source data without reconnection',async()=>{
 const f=fixture();await f.ready();const timer=[...f.timers.values()].find(t=>t.delay>800000);assert.ok(timer);const count=f.calls.length;timer.fn();assert.equal(f.calls.length,count);assert.equal(f.text('ha-current'),'');assert.equal(f.nodes['ha-run'].disabled,true);
});
