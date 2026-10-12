const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname,'../js/workspace-client.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handler){
 const events={},calls=[];
 const window={addEventListener(k,v){(events[k]||=[]).push(v);},dispatchEvent(){}};
 const document={hidden:false,getElementById(){return null;},addEventListener(){}};
 const context=vm.createContext({window,document,crypto:{randomUUID:()=> 'request_fixture_uuid'},CustomEvent:class{},setInterval(){},setTimeout(fn){setImmediate(fn);},fetch:async(path,options)=>{calls.push({path,options});return handler(path,options,calls);}});
 vm.runInContext(source,context);
 return {api:window.TLIWorkspace,calls,emit:name=>(events[name]||[]).forEach(fn=>fn())};
}
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
const ready=()=>response({capabilities:{host_runs:true}});
const done=()=>response({id:'run_fixture',request_id:'request_fixture_uuid',status:'completed',cursor:3,text:'Answer',metadata:{model:'fixture'},result:{reply:'Answer',conversation_id:'conv_fixture'}});
test('a session change while checking support cannot submit the prior private draft',async()=>{
 let resolve;
 const pending=new Promise(r=>resolve=r);
 const h=fixture(path=>path.endsWith('/bootstrap')?pending:done());
 const work=h.api.chat({message:'private draft'});await tick();h.emit('tli-session-locked');resolve(ready());
 await assert.rejects(work,/Stop requested/);assert.equal(h.calls.length,1);
});
test('a lost submission acknowledgement looks up original request identity without replay',async()=>{
 const h=fixture((path,options)=>path.endsWith('/bootstrap')?ready():options.method==='POST'?Promise.reject(new TypeError('Disconnected')):done());
 const result=await h.api.chat({message:'hello'},{chatPath:'/chat'});
 assert.equal(result.reply,'Answer');assert.equal(h.calls.filter(x=>x.options.method==='POST').length,1);
 assert.equal(JSON.parse(h.calls[1].options.body).payload.lan_inference,null);
 assert.equal(h.calls[2].path,'/api/runs/request_fixture_uuid');
});
test('a stale unauthorized workspace poll cannot relock a newer session',async()=>{
 let settle;const pending=new Promise(r=>settle=r);
 const h=fixture(path=>path.endsWith('/bootstrap')?ready():path.startsWith('/api/workspace/events')?pending:done());
 const work=h.api.refresh();await tick();h.emit('tli-session-locked');h.emit('tli-session-unlocked');settle(response({},401));await work;
 assert.equal(await h.api.supported(),true);
});
test('an explicit Stop requests host cancellation; pagehide only detaches the display',async()=>{
 for(const leave of [false,true]){
  let settle;const pending=new Promise(r=>settle=r),controller=new AbortController();
  const h=fixture((path,options)=>path.endsWith('/bootstrap')?ready():path.endsWith('/cancel')?response({}):options.method==='POST'?pending:done());
  const work=h.api.chat({message:'hello'},{signal:controller.signal});await tick();
  if(leave)h.emit('pagehide');else controller.abort();
  settle(response({id:'run_fixture',status:'running',cursor:0,text:'',metadata:{}}));
  await assert.rejects(work,/Stop requested/);
  assert.equal(h.calls.some(x=>x.path.endsWith('/cancel')),!leave);
 }
});
