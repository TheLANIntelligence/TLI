const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/host-lifecycle.js'),'utf8');
const base='/api/host-control/v1/lifecycle';
const currentURL='http://127.0.0.1:8000/';
const identity={schema_version:1,instance_id:'instance-one',installation_id:'installation-one'};
const capabilities={...identity,available:true,capabilities:{restart:true,quit:true},reason:'Supported local launcher'};
const preview=(action='restart',extra={})=>({...identity,preview_id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',expires_at:Date.now()/1000+60,action,current_url:currentURL,next_url:currentURL,consequences:['Background work stops.'],...extra});
const flush=()=>new Promise(setImmediate);
function fixture(handler,{url=currentURL,userAgent='Desktop test',mobile=false}={}){
 const nodes={},events={},docEvents={},calls=[],timers=new Map(),navigations=[];let serial=0,document;
 class El{
  constructor(id){this.id=id;this.dataset={};this.events={};this.attrs={};this.textContent='';this.disabled=false;this.hidden=false;this.open=false;this.isConnected=true;}
  addEventListener(name,fn){(this.events[name]||=[]).push(fn);}setAttribute(k,v){this.attrs[k]=v;}getAttribute(k){return this.attrs[k];}
  focus(){document.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;this.emit('close');}
  emit(name,event={}){return Promise.all((this.events[name]||[]).map(fn=>fn({target:this,currentTarget:this,preventDefault(){},...event})));}
  click(){return this.disabled?Promise.resolve():this.emit('click');}
 }
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 for(const match of html.matchAll(/<[^>]+\bid="(tli-host-[^"]+|tli-device-trigger)"[^>]*>/g)){const node=new El(match[1]);node.disabled=/\sdisabled(?:\s|>)/.test(match[0]);node.hidden=/\shidden(?:\s|>)/.test(match[0]);const action=match[0].match(/data-host-lifecycle="([^"]+)"/);if(action)node.dataset.hostLifecycle=action[1];nodes[node.id]=node;}
 document={readyState:'complete',hidden:false,activeElement:null,getElementById:id=>nodes[id]||null,addEventListener:(name,fn)=>(docEvents[name]||=[]).push(fn)};
 const location=new URL(url);location.assign=next=>navigations.push(next);
 const window={location,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},TLIHostIdentity:{get:()=>({status:'known'})},addEventListener:(name,fn)=>(events[name]||=[]).push(fn)};
 const ctx=vm.createContext({window,document,navigator:{userAgent,userAgentData:{mobile}},URL,URLSearchParams,AbortController,Uint8Array,Date,console,setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimeout:id=>timers.delete(id),fetch:async(url,options)=>{const body=options.body?JSON.parse(options.body):null;calls.push({url,options,body});let result=handler?await handler(url,body,options):undefined;if(result===undefined)result=url===base?capabilities:url===base+'/preview'?preview(body.action):url===base+'/confirm'?{schema_version:1,status:'accepted',request_id:body.request_id,action:nodes['tli-host-lifecycle-title'].textContent.includes('Quit')?'quit':'restart'}:identity;return result&&typeof result.json==='function'?result:{ok:true,status:200,json:async()=>result};}});
 vm.runInContext(source,ctx);
 return {nodes,window,document,calls,timers,navigations,async open(action='restart'){await nodes['tli-host-settings-'+action].click();await flush();},async event(name){for(const fn of events[name]||[])await fn();await flush();},async visibility(hidden){document.hidden=hidden;for(const fn of docEvents.visibilitychange||[])await fn();await flush();},async poll(){const entry=[...timers].find(([,v])=>v.ms===1000||v.ms===2000);if(entry){timers.delete(entry[0]);await entry[1].fn();await flush();}}};
}

test('restart and quit use native review, fresh capabilities and explicit confirmation only',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);await f.open();assert.equal(f.nodes['tli-host-lifecycle-dialog'].open,true);assert.equal(f.document.activeElement,f.nodes['tli-host-lifecycle-cancel']);assert.match(f.nodes['tli-host-lifecycle-warning'].textContent,/chats, scans.*phones/);
 assert.deepEqual(f.calls.map(c=>[c.url,c.options.method]),[[base,'GET'],[base+'/preview','POST']]);assert.equal(f.nodes['tli-host-lifecycle-confirm'].disabled,false);
 await f.nodes['tli-host-lifecycle-cancel'].click();assert.equal(f.document.activeElement,f.nodes['tli-host-settings-restart']);assert.equal(f.calls.length,2);
 await f.open('quit');await f.nodes['tli-host-lifecycle-confirm'].click();assert.equal(f.calls.at(-1).url,base+'/confirm');assert.deepEqual(f.calls.at(-1).body,{preview_id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',request_id:'11111111111141118111111111111111'});assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/acknowledgement does not prove/);assert.equal([...f.timers.values()].some(t=>t.ms===1000),false);
});

test('connection setup handoff adds only a continuation at explicit reviewed navigation',async()=>{
 const next='https://localhost:8443/';
 const f=fixture((url,body)=>url===base+'/preview'?preview('restart',{next_url:next}):undefined);
 let handoffs=0;
 f.window.TLIConnectDevice={isOpen:()=>true,resumeURL:value=>{handoffs++;assert.equal(value,next);return value+'#connect_device=computer&setup_receipt='+'a'.repeat(32);}};
 await f.open();await f.nodes['tli-host-lifecycle-confirm'].click();assert.equal(handoffs,1);assert.equal(f.navigations.length,0);
 await f.nodes['tli-host-lifecycle-reload'].click();assert.equal(handoffs,1);assert.equal(f.navigations.length,1);
 assert.equal(f.calls.filter(c=>c.url===base+'/confirm').length,1);assert.equal(f.calls.some(c=>c.url.startsWith('https:')),false);
});

test('accepted setup restart retains only reviewed navigation after a background session lock',async()=>{
 const next='https://localhost:8443/';
 const f=fixture((url,body)=>url===base+'/preview'?preview('restart',{next_url:next}):undefined);
 f.window.TLIConnectDevice={isOpen:()=>true,resumeURL:()=>next+'#connect_device=computer&peer=peer-one&setup_receipt='+'b'.repeat(32)+'&token=private-token&pin=1234&grants=inference'};
 await f.open();await f.nodes['tli-host-lifecycle-confirm'].click();
 const link=f.nodes['tli-host-restart-handoff'];assert.equal(link.hidden,false);
 // This is the same lock event dispatched when a background fetch receives401.
 f.window.TLIConnectDevice={isOpen:()=>false,resumeURL:()=>{throw Error('Guide was cleared');}};
 await f.event('tli-session-locked');assert.equal(f.nodes['tli-host-lifecycle-dialog'].open,false);assert.equal(link.hidden,false);
 const destination=link.getAttribute('href');assert.equal(new URL(destination).origin,'https://localhost:8443');assert.match(destination,/setup_receipt=b{32}/);assert.doesNotMatch(destination,/token|pin|grants|private/);
 assert.equal(f.navigations.length,0);assert.equal(f.calls.filter(c=>c.url===base+'/confirm').length,1);
});
test('remote browsers and mobile loopback cannot request application control',async()=>{
 for(const options of [{url:'https://192.168.1.30:8000/'},{mobile:true},{userAgent:'Mozilla/5.0 iPhone Mobile'}]){const f=fixture(null,options);await f.open();assert.equal(f.calls.length,0);assert.equal(f.nodes['tli-host-settings-quit'].disabled,true);assert.match(f.nodes['tli-host-lifecycle-help'].textContent,/Remote browsers and phones/);}
});
test('unsupported, changed-instance and expired previews cannot become confirmed operations',async()=>{
 for(const override of [{instance_id:'different-instance'},{expires_at:1},{next_url:'https://external.example/'}]){const f=fixture((url,body)=>url.endsWith('/preview')?preview(body.action,override):undefined);await f.open();assert.equal(f.nodes['tli-host-lifecycle-confirm'].disabled,true);await f.nodes['tli-host-lifecycle-confirm'].click();assert.equal(f.calls.some(c=>c.url.endsWith('/confirm')),false);}
 const f=fixture(url=>url===base?{...capabilities,available:false,reason:'Start from the supported launcher first.'}:undefined);await f.open();assert.equal(f.calls.length,1);assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/supported launcher/);
});
test('legacy host without lifecycle routes gives one-time exact fallback and cannot send a command',async()=>{
 const f=fixture(url=>url===base?{ok:false,status:404,json:async()=>({detail:'Not Found'})}:undefined);await f.open();
 assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/TLI_Setup\.bat, choose 9 — Stop TLI, confirm STOP/);assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/No stop or restart command was sent/);assert.equal(f.nodes['tli-host-lifecycle-confirm'].disabled,true);await f.nodes['tli-host-lifecycle-confirm'].click();assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'GET');
});
test('double confirmation sends once; accepted restart polls GET readiness and matches installation plus new instance',async()=>{
 let complete;const f=fixture((url,body)=>url.endsWith('/confirm')?new Promise(resolve=>{complete=()=>resolve({schema_version:1,status:'accepted',action:'restart',request_id:body.request_id});}):url.endsWith('/ready')?{...identity,instance_id:'instance-two'}:undefined);
 await f.open();const pending=f.nodes['tli-host-lifecycle-confirm'].click();await flush();await f.nodes['tli-host-lifecycle-confirm'].click();assert.equal(f.calls.filter(c=>c.url.endsWith('/confirm')).length,1);complete();await pending;await f.poll();
 assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/TLI restarted/);assert.equal(f.calls.at(-1).options.method,'GET');assert.equal(f.calls.at(-1).options.redirect,'error');assert.equal(f.nodes['tli-host-lifecycle-reload'].hidden,false);await f.nodes['tli-host-lifecycle-reload'].click();assert.deepEqual(f.navigations,[currentURL]);
 assert.equal(f.calls.some(c=>c.url.includes('/receipt/')),false);
});
test('same-instance failed receipt reports the host reason and stops polling without replay',async()=>{
 const f=fixture(url=>url.includes('/receipt/')?{schema_version:1,status:'failed',action:'restart',request_id:'11111111111141118111111111111111',message:'The restart helper could not start.'}:undefined);
 await f.open();await f.nodes['tli-host-lifecycle-confirm'].click();await f.poll();assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/Restart failed: The restart helper could not start/);
 const receipt=f.calls.find(c=>c.url.includes('/receipt/'));assert.equal(receipt.options.method,'GET');assert.equal(receipt.options.credentials,'same-origin');assert.equal([...f.timers.values()].some(t=>[1000,2000].includes(t.ms)),false);
 const count=f.calls.length;await f.poll();assert.equal(f.calls.length,count);await f.nodes['tli-host-lifecycle-cancel'].click();await f.open('quit');assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/restart helper could not start/);await f.nodes['tli-host-lifecycle-confirm'].click();assert.equal(f.calls.filter(c=>c.url.endsWith('/confirm')).length,1);
});
test('lost command response is ambiguous and is never replayed by check, close or reopen',async()=>{
 const f=fixture(url=>{if(url.endsWith('/confirm'))throw Error('Connection lost');});await f.open();await f.nodes['tli-host-lifecycle-confirm'].click();assert.match(f.nodes['tli-host-lifecycle-status'].textContent,/not confirmed.*may already be restarting/);
 await f.nodes['tli-host-lifecycle-check'].click();await f.nodes['tli-host-lifecycle-cancel'].click();await f.open('quit');await f.nodes['tli-host-lifecycle-confirm'].click();assert.equal(f.calls.filter(c=>c.url.endsWith('/confirm')).length,1);assert.equal(f.calls.filter(c=>c.url.endsWith('/preview')).length,1);assert.equal(f.nodes['tli-host-lifecycle-title'].textContent,'Restart TLI');
});
test('readiness with another installation never claims restart completion',async()=>{
 const f=fixture(url=>url.endsWith('/ready')?{...identity,instance_id:'new',installation_id:'other'}:undefined);await f.open();await f.nodes['tli-host-lifecycle-confirm'].click();await f.poll();assert.doesNotMatch(f.nodes['tli-host-lifecycle-status'].textContent,/TLI restarted/);assert.equal(f.nodes['tli-host-lifecycle-reload'].hidden,true);
});
test('changed reviewed origin is opened only by explicit user navigation with no cross-origin polling',async()=>{
 const next='https://127.0.0.1:9443/';const f=fixture((url,body)=>url.endsWith('/preview')?preview(body.action,{next_url:next}):undefined);await f.open();assert.match(f.nodes['tli-host-lifecycle-destination'].textContent,/9443/);await f.nodes['tli-host-lifecycle-confirm'].click();await f.poll();assert.equal(f.calls.some(c=>c.url.endsWith('/ready')),false);assert.equal(f.nodes['tli-host-lifecycle-reload'].hidden,false);await f.nodes['tli-host-lifecycle-check'].click();assert.equal(f.calls.length,3);await f.nodes['tli-host-lifecycle-reload'].click();assert.deepEqual(f.navigations,[next]);
});
test('lock invalidates a delayed review and cancels accepted restart polling',async()=>{
 let release;const f=fixture(url=>url===base?new Promise(resolve=>{release=resolve;}):undefined);await f.nodes['tli-host-settings-restart'].click();await flush();await f.event('tli-session-locked');release(capabilities);await flush();assert.equal(f.calls.length,1);assert.equal(f.nodes['tli-host-lifecycle-dialog'].open,false);assert.equal(f.nodes['tli-host-lifecycle-confirm'].disabled,true);
 const second=fixture();await second.open();await second.nodes['tli-host-lifecycle-confirm'].click();await second.event('tli-session-locked');await second.poll();assert.equal(second.calls.length,3);
});
test('hidden and closed dialogs stop readiness polling without sending another command',async()=>{
 const f=fixture();await f.open();await f.nodes['tli-host-lifecycle-confirm'].click();await f.visibility(true);await f.poll();assert.equal(f.calls.length,3);await f.visibility(false);await f.poll();assert.equal(f.calls.filter(c=>c.url.endsWith('/ready')).length,1);assert.equal(f.calls.filter(c=>c.url.includes('/receipt/')).length,1);const count=f.calls.length;await f.nodes['tli-host-lifecycle-cancel'].click();await f.poll();assert.equal(f.calls.length,count);
});
