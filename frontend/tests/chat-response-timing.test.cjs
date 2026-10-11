const {test}=require('node:test');
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/chat-workspace.js'),'utf8');
function fixture(){
 let now=0,id=0; const timers=new Map(),nodes={};
 const element=()=>({textContent:'',children:[],hidden:true,append(n){this.children.push(n);if(n.id)nodes[n.id]=n},setAttribute(){}});
 nodes['chat-response-status']=element();nodes['chat-response-status-text']=element();
 const ctx=vm.createContext({presentMessage(){},performance:{now:()=>now},document:{getElementById:id=>nodes[id],createElement:element},setInterval:fn=>{timers.set(++id,fn);return id},clearInterval:id=>timers.delete(id)});
 const start=source.indexOf('  let activeResponse = null;'),end=source.indexOf('  window.TLIChatWorkspace = api;',start);
 vm.runInContext(source.slice(start,end)+'\nthis.begin=beginResponse;this.clear=clearResponse;',ctx);
 return{nodes,timers,element,begin:ctx.begin,clear:ctx.clear,advance(ms){now+=ms;for(const fn of [...timers.values()])fn()}};
}
test('browser clock distinguishes wait, first displayed text and completed receipt without network calls',()=>{
 const f=fixture(),bubble=f.element(),request=f.begin();f.advance(2400);
 assert.match(f.nodes['chat-response-status-text'].textContent,/Waiting/);assert.match(f.nodes['chat-response-elapsed'].textContent,/2.4s in this browser/);
 request.responding();f.advance(3100);request.responding();request.finish({outcome:'completed',bubble});
 assert.match(bubble.children[0].textContent,/First text 2.4s.*Response received in 5.5s.*Browser timing/);
 assert.match(bubble.children[0].title,/not a measurement of model speed/);assert.equal(f.timers.size,0);assert.equal(f.nodes['chat-response-status'].hidden,true);
});
for(const outcome of ['stopped','interrupted'])test(`${outcome} timing cannot claim a completed or cancelled action`,()=>{
 const f=fixture(),bubble=f.element(),request=f.begin();f.advance(1200);request.finish({outcome,bubble});
 assert.doesNotMatch(bubble.children[0].textContent,/First text|Response received|cancelled/);assert.equal(f.timers.size,0);
});
test('replacement and session clear invalidate old handles and stop timers',()=>{
 const f=fixture(),bubble=f.element(),old=f.begin();f.advance(500);const current=f.begin();
 assert.equal(f.timers.size,1);old.responding();old.finish({outcome:'completed',bubble});assert.equal(bubble.children.length,0);
 f.clear();current.responding();current.finish({outcome:'completed',bubble});assert.equal(bubble.children.length,0);assert.equal(f.timers.size,0);
});
test('waiting timer has one bounded interval and long wait never claims model progress',()=>{
 const f=fixture(),request=f.begin();f.advance(61000);assert.match(f.nodes['chat-response-status-text'].textContent,/Still waiting/);
 f.advance(600000);assert.equal(f.timers.size,0);assert.match(f.nodes['chat-response-elapsed'].textContent,/10m\+/);
 request.finish();assert.equal(f.nodes['chat-response-status'].hidden,true);
});
