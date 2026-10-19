const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/connection-setup.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const settings={host:'0.0.0.0',port:8000,https:true};
const original={host:'127.0.0.1',port:8000,https:false};
const descendants=e=>e.children.flatMap(c=>[c,...descendants(c)]);
const text=e=>[e.textContent,...descendants(e).map(c=>c.textContent)].join(' ');
function fixture({running=original,saved=original,receipt,receiptAction='prepare',local=true}={}){
 const calls=[],timers=[],restarts=[];let active=true,handler,settled=0;
 function n(tag){return{tag,children:[],textContent:'',value:'',hidden:false,disabled:false,handlers:{},append(...v){this.children.push(...v)},replaceChildren(...v){this.children=v},setAttribute(){},addEventListener(k,fn){this.handlers[k]=fn},click(){if(!this.disabled)return this.handlers.click?.()},focus(){}};}
 const root=n('div');const document={createElement:n},window={TLIHostLifecycle:{open:(...a)=>restarts.push(a)}};
 vm.runInNewContext(source,{document,window,location:{hostname:local?'localhost':'192.168.1.2'},navigator:{userAgent:'Desktop'},URL,Date,Uint8Array,crypto:require('node:crypto').webcrypto,setTimeout:fn=>timers.push(fn)});
 const preview={schema_version:1,preview_id:'a'.repeat(32),action:'prepare',expires_at:Date.now()/1000+300,next_url:'https://127.0.0.1:8000',settings,certificate:{names:['studio.local'],fingerprint:'b'.repeat(64)},warnings:['Encrypted connections are available after restart.']};
 const api=async(url,body)=>{calls.push({url,body});if(handler)return handler(url,body);if(url.endsWith('/preview'))return preview;if(url.endsWith('/confirm'))return{schema_version:1,request_id:body.request_id,status:'accepted',message:'Accepted'};return{schema_version:1,action:receiptAction,request_id:window.TLIConnectionSetup.receipt(),status:'completed',message:'Saved',restart_required:true,settings,running};};
 if(receipt)window.TLIConnectionSetup.resume(receipt);
 const mount=()=>{root.replaceChildren();window.TLIConnectionSetup.mount(root,{record:{running,startup:{effective_next:saved},certificate:{status:saved.https?'ready':'missing'},firewall:{supported:false,reason:'Manual firewall guidance'}},api,current:()=>active,onSettled:()=>settled++});};mount();
 return{root,calls,restarts,timers,api:window.TLIConnectionSetup,preview,mount,set handler(v){handler=v},get settled(){return settled},deactivate(){active=false},activate(){active=true},button(label){return descendants(root).find(e=>e.tag==='button'&&e.textContent===label)},async poll(){await timers.shift()?.();await tick();}};
}
test('guided preparation is explicit and legacy startup controls are absent',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.ok(f.button('Review secure home-network setup'));
 await f.button('Review secure home-network setup').click();await tick();assert.deepEqual(f.calls.map(c=>c.url),['/api/network-setup/v1/preview']);
 assert.match(text(f.root),/Review secure home-network access/);assert.equal(f.restarts.length,0);
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../js/native-companion.js'),'utf8'),/startupControls|native-startup-mode|\/startup', 'PUT'/);
});
test('confirmed setup polls only its receipt then offers a reviewed restart',async()=>{
 const f=fixture();await f.button('Review secure home-network setup').click();await tick();
 const confirm=f.button('Confirm network setup');confirm.click();confirm.click();await tick();
 assert.equal(f.calls.filter(c=>c.url.endsWith('/confirm')).length,1);await f.poll();
 assert.equal(f.calls.filter(c=>c.url.includes('/receipt/')).length,1);assert.equal(f.settled,1);assert.equal(f.restarts.length,0);
 await f.button('Restart TLI and continue').click();assert.equal(f.restarts[0][0],'restart');
});
test('an unconfirmed setup request is never posted again by receipt checking',async()=>{
 const f=fixture();f.handler=async(url,body)=>{if(url.endsWith('/preview'))return f.preview;if(url.endsWith('/confirm'))throw Error('Connection interrupted');return{schema_version:1,request_id:f.api.receipt(),status:'uncertain',message:'Outcome unknown'};};
 await f.button('Review secure home-network setup').click();await tick();await f.button('Confirm network setup').click();await tick();
 assert.match(text(f.root),/will not be repeated/);await f.button('Check saved setup request').click();await tick();
 assert.equal(f.calls.filter(c=>c.url.endsWith('/confirm')).length,1);assert.equal(f.restarts.length,0);assert.equal(f.settled,0);
});
test('manual receipt completion advances readiness without replaying the setup request',async()=>{
 const f=fixture();f.handler=async(url,body)=>{if(url.endsWith('/preview'))return f.preview;if(url.endsWith('/confirm'))throw Error('Connection interrupted');return{schema_version:1,request_id:f.api.receipt(),status:'completed',message:'Saved'};};
 await f.button('Review secure home-network setup').click();await tick();await f.button('Confirm network setup').click();await tick();
 await f.button('Check saved setup request').click();await tick();assert.equal(f.settled,1);assert.equal(f.calls.filter(c=>c.url.endsWith('/confirm')).length,1);assert.equal(f.restarts.length,0);
});
test('a receipt returning after access ends cannot disclose a result or advance readiness',async()=>{
 const f=fixture();await f.button('Review secure home-network setup').click();await tick();await f.button('Confirm network setup').click();await tick();
 let finish;const id=f.api.receipt();f.handler=()=>new Promise(resolve=>{finish=resolve;});f.button('Check saved setup request').click();f.deactivate();f.api.suspend();
 finish({schema_version:1,request_id:id,status:'completed',message:'Private completion'});await tick();assert.equal(f.settled,0);assert.equal(f.api.result(),null);assert.doesNotMatch(text(f.root),/Private completion/);
});
test('same-owner lock retains only the opaque receipt ID and resumes by reading after unlock',async()=>{
 const f=fixture();await f.button('Review secure home-network setup').click();await tick();await f.button('Confirm network setup').click();await tick();
 const id=f.api.receipt(),count=f.calls.length;assert.equal(f.api.result().status,'accepted');f.deactivate();f.api.suspend();assert.equal(f.api.receipt(),id);assert.equal(f.api.result(),null);await f.poll();assert.equal(f.calls.length,count);
 f.activate();f.mount();await tick();assert.equal(f.calls.at(-1).url,'/api/network-setup/v1/receipt/'+id);assert.equal(f.calls.at(-1).body,undefined);assert.equal(f.settled,1);assert.equal(f.calls.filter(c=>c.url.endsWith('/confirm')).length,1);
});
test('owner changes discard the receipt ID and never read a prior owner’s setup on remount',async()=>{
 const f=fixture();await f.button('Review secure home-network setup').click();await tick();await f.button('Confirm network setup').click();await tick();
 f.deactivate();f.api.clear();assert.equal(f.api.receipt(),null);assert.equal(f.api.result(),null);await f.poll();const count=f.calls.length;f.activate();f.mount();await tick();assert.equal(f.calls.length,count);assert.equal(f.settled,0);
});
test('backgrounding or closing stops automatic receipt polling without replay',async()=>{
 const f=fixture();await f.button('Review secure home-network setup').click();await tick();await f.button('Confirm network setup').click();await tick();
 const count=f.calls.length;f.deactivate();await f.poll();assert.equal(f.calls.length,count);assert.equal(f.settled,0);
});
test('resumed completion with matching live settings does not ask for another restart',async()=>{
 const f=fixture({running:settings,saved:settings,receipt:'d'.repeat(32)});await tick();
 assert.match(text(f.root),/Saved/);assert.equal(f.button('Restart TLI and continue'),undefined);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,undefined);
});
test('saved secure settings offer restart without preparing or replacing a certificate again',()=>{
 const f=fixture({saved:settings});assert.ok(f.button('Restart TLI and continue'));assert.equal(f.button('Review secure home-network setup'),undefined);assert.equal(f.calls.length,0);
});
test('matching listener settings never dismiss a certificate-repair restart',async()=>{
 const f=fixture({running:settings,saved:settings,receipt:'e'.repeat(32),receiptAction:'repair_certificate'});await tick();
 assert.ok(f.button('Restart TLI and continue'));assert.equal(f.restarts.length,0);
});
test('network configuration remains local desktop only',()=>{
 const f=fixture({local:false});assert.match(text(f.root),/local desktop browser/);assert.equal(f.button('Review secure home-network setup'),undefined);assert.equal(f.calls.length,0);
});
