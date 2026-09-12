const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../js/mcp-bridge.js'),'utf8');
const credential='tlim_'+'a'.repeat(43),protocol='tli-mcp-bridge-v1',version='2026-07-28';
const grant=()=>({ok:true,protocol,mcp_protocol:version,id:'b'.repeat(32),credential,scopes:['health'],endpoint:'http://127.0.0.1:8000/api/mcp',expires_at:new Date(Date.now()+890000).toISOString()});
function fixture(){
 const nodes={},events={},calls=[],timers=new Map();let serial=0;
 function element(tag){const n={tag,textContent:'',value:'',checked:false,disabled:false,children:[],handlers:{},
  append(...items){this.children.push(...items);if(this.tag==='select'&&!this.value&&items[0])this.value=items[0].value;},replaceChildren(...items){this.children=[];this.value=this.tag==='select'?'':this.value;this.append(...items);},
  setAttribute(){},addEventListener(k,fn){(this.handlers[k]||=[]).push(fn);},fire(k='click'){return Promise.all((this.handlers[k]||[]).map(fn=>fn({})));},click(){return this.disabled?Promise.resolve():this.fire();}};
  Object.defineProperty(n,'id',{set(v){nodes[v]=this;}});Object.defineProperty(n,'childNodes',{get(){return this.children;}});return n;}
 nodes['settings-mcp-mount']=element('div');
 const emit=(name,detail)=>Promise.all((events[name]||[]).map(fn=>fn({detail})));
 const f={nodes,calls,emit,handler:async(url,options)=>{
  if(url.endsWith('/grant'))return grant();
  if(url.endsWith('/revoke'))return {ok:true,protocol,revoked:true};
  if(url.endsWith('/status'))return {ok:true,protocol,mcp_protocol:version,enabled:false,grants:[]};
  const body=JSON.parse(options.body);return {jsonrpc:'2.0',id:body.id,result:{resultType:'complete',...(body.method==='server/discover'?{supportedVersions:[version]}:body.method==='tools/list'?{tools:[{name:'tli_reported_health',annotations:{destructiveHint:true}}]}:{isError:false,structuredContent:{ok:true,actions_performed:false,inference_called:false,read_at:'fixture-time',data:{cpu_percent:12,private:'fixture record'}}})}};
 }};
 const ctx=vm.createContext({Date,console,TextEncoder,TextDecoder,AbortController,
  setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
  navigator:{clipboard:{async writeText(value){f.copied=value;}}},
  document:{readyState:'complete',visibilityState:'visible',getElementById:id=>nodes[id],createElement:element,addEventListener:(k,fn)=>(events[k]||=[]).push(fn)},
  window:{addEventListener:(k,fn)=>(events[k]||=[]).push(fn)},
  localStorage:{setItem(){assert.fail('No credential persistence');}},
  fetch:async(url,options)=>{calls.push({url,options});const v=await f.handler(url,options);return{ok:!v._status||v._status<400,status:v._status||200,body:null,text:async()=>JSON.stringify(v)};}
 });
 vm.runInContext(code,ctx);f.ctx=ctx;f.timers=timers;
 f.enable=async()=>{nodes['mcp-scope-health'].checked=true;nodes['mcp-allow'].checked=true;await nodes['mcp-enable'].click();};
 f.ready=async()=>{await f.enable();await nodes['mcp-inspect'].click();nodes['mcp-preview'].click();nodes['mcp-reviewed'].checked=true;await nodes['mcp-reviewed'].fire('change');};
 f.text=id=>{const flatten=n=>[n.textContent,...n.children.flatMap(flatten)];return flatten(nodes[id]).join(' ');};
 return f;
}
test('navigation never grants, connects, reads stores or registers tools with AI',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);await f.emit('tli-panel-switched',{panelId:'panel-settings'});assert.equal(f.calls.length,0);
 await f.nodes['mcp-enable'].click();assert.equal(f.calls.length,0);assert.match(f.text('mcp-status'),/review.*scopes/i);assert.doesNotMatch(f.text('mcp-status'),/previous.*retained/i);
});
test('enable, discovery, review and one explicit call are separate wire operations',async()=>{
 const f=fixture();await f.ready();assert.deepEqual(f.calls.map(c=>c.url),['/api/integrations/mcp/grant','/api/mcp','/api/mcp']);
 assert.equal(f.nodes['mcp-scope-health'].disabled,true,'Changing a checkbox cannot imply that an active grant changed');
 await f.nodes['mcp-call'].click();assert.equal(f.calls.length,4);const req=f.calls[3],b=JSON.parse(req.options.body);
 assert.equal(req.options.headers.Authorization,'Bearer '+credential);assert.equal(req.options.headers['Mcp-Method'],'tools/call');assert.equal(req.options.headers['Mcp-Name'],b.params.name);
 assert.equal(b.params._meta['io.modelcontextprotocol/protocolVersion'],version);assert.deepEqual(b.params.arguments,{});assert.match(f.text('mcp-result'),/fixture record/);
});
test('duplicate button events cannot create competing grants or reads',async()=>{
 const f=fixture();let finish;f.handler=()=>new Promise(resolve=>finish=resolve);f.nodes['mcp-scope-health'].checked=true;f.nodes['mcp-allow'].checked=true;
 const pending=f.nodes['mcp-enable'].fire();await f.nodes['mcp-enable'].fire();assert.equal(f.calls.length,1);finish(grant());await pending;
});
test('PIN lock clears credential and private result; late grant cannot repopulate',async()=>{
 const f=fixture();let finish;f.handler=()=>new Promise(resolve=>finish=resolve);const pending=f.enable();await f.emit('tli-session-locked');finish(grant());await pending;
 assert.equal(f.nodes['mcp-secret'].value,'');assert.equal(f.nodes['mcp-inspect'].disabled,true);assert.doesNotMatch(f.text('mcp-status'),/enabled/);
});
test('leaving Settings clears views without claiming or sending server cancellation',async()=>{
 const f=fixture();await f.ready();await f.nodes['mcp-call'].click();await f.nodes['mcp-show'].click();assert.equal(f.nodes['mcp-secret'].type,'text');
 const count=f.calls.length;await f.emit('tli-panel-switched',{panelId:'panel-main'});assert.equal(f.calls.length,count);assert.equal(f.nodes['mcp-secret'].value,'');assert.equal(f.text('mcp-result'),'');assert.equal(f.nodes['mcp-secret'].type,'password');
});
test('failed repeat and failed revoke retain the prior result with accurate error',async()=>{
 const f=fixture();await f.ready();await f.nodes['mcp-call'].click();const old=f.text('mcp-result');f.handler=async()=>({_status:503,detail:'Saved registry unavailable'});
 await f.nodes['mcp-call'].click();assert.equal(f.text('mcp-result'),old);assert.match(f.text('mcp-status'),/retained/);
 await f.nodes['mcp-disconnect'].click();assert.equal(f.nodes['mcp-secret'].value,credential);assert.doesNotMatch(f.text('mcp-status'),/access revoked/);
});
test('successful revoke clears; unauthorized responses clear even after prior success',async()=>{
 for(const action of ['revoke','unauthorized']){const f=fixture();await f.ready();await f.nodes['mcp-call'].click();
  if(action==='unauthorized'){f.handler=async()=>({_status:401,detail:'Expired'});await f.nodes['mcp-call'].click();}else await f.nodes['mcp-disconnect'].click();
  assert.equal(f.nodes['mcp-secret'].value,'');assert.equal(f.text('mcp-result'),'');}
});
test('metadata cannot introduce arbitrary tools or authority from annotations',async()=>{
 const f=fixture();await f.enable();const handler=f.handler;f.handler=async(u,o)=>{const d=await handler(u,o);if(d.result?.tools)d.result.tools.push({name:'execute_shell',annotations:{readOnlyHint:true}});return d;};
 await f.nodes['mcp-inspect'].click();assert.match(f.text('mcp-status'),/unexpected tools/);assert.equal(f.nodes['mcp-preview'].disabled,true);assert.equal(f.calls.length,3);
});
test('late tool response after lock is ignored and never replayed',async()=>{
 const f=fixture();await f.ready();const handler=f.handler;let finish;f.handler=(u,o)=>new Promise(resolve=>finish=async()=>resolve(await handler(u,o)));
 const pending=f.nodes['mcp-call'].click();await f.emit('tli-session-locked');await finish();await pending;assert.equal(f.text('mcp-result'),'');assert.equal(f.calls.length,4);
});
test('an existing grant can be explicitly found and revoked without recovering its credential',async()=>{
 const f=fixture();f.handler=async()=>({ok:true,protocol,mcp_protocol:version,enabled:true,grants:[grant()]});await f.nodes['mcp-check'].click();
 assert.equal(f.nodes['mcp-secret'].value,'');assert.equal(f.nodes['mcp-enable'].disabled,true);assert.equal(f.nodes['mcp-disconnect'].disabled,false);assert.match(f.text('mcp-status'),/no longer in this view/);
});
test('invalid grant receipt does not adopt or reveal returned credential',async()=>{
 const f=fixture();f.handler=async()=>({...grant(),expires_at:'not a date'});await f.enable();assert.equal(f.nodes['mcp-secret'].value,'');assert.equal(f.nodes['mcp-inspect'].disabled,true);
});
test('response identity is checked before displaying a source read',async()=>{
 const f=fixture();await f.ready();const old=f.handler;f.handler=async(u,o)=>({...await old(u,o),id:'unrelated-request'});await f.nodes['mcp-call'].click();
 assert.equal(f.text('mcp-result'),'');assert.match(f.text('mcp-status'),/identity/);
});
