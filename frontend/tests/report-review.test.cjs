const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const script=fs.readFileSync(path.resolve(__dirname,'../js/report-review.js'),'utf8');
const old={id:'old',kind:'system',created_at:'2026-09-08T10:00:00Z',host:{id:'host',name:'Study'},target:null};
const revision='a'.repeat(64),scope='b'.repeat(64);
const envelope={ok:true,protocol:'tli-report-review-v1',actions_performed:false,checked_at:'2026-09-08T11:00:00Z'};
function review(){return {...envelope,source:old,source_revision:revision,available:true,reason:'',scope:{host:old.host,target:null,kind:'system',internet:false,revision:scope},request:{kind:'system',target_id:null,internet:false,expected_host_id:'host',expected_scope:scope,repeat_of:'old',expected_report_revision:revision}};}
function report(){return {...old,id:'new',internet_checks:false,created_at:'2026-09-08T11:00:00Z',checks:[{status:'unavailable',label:'CPU',detail:'No sample.'}],comparison:null};}
function harness(handler,cryptoOptions={randomUUID:()=> 'request-one'}){
  const calls=[],events=[];let open=true;
  function node(tag){return {tag,textContent:'',children:[],handlers:{},disabled:false,value:'',append(...n){this.children.push(...n);if(this.tag==='select'&&!this.value)this.value=n[0]?.value||'';},replaceChildren(...n){this.children=n;},setAttribute(){},focus(){},contains(){return false;},addEventListener(k,fn){(this.handlers[k]||=[]).push(fn);},fire(){return Promise.all((this.handlers.click||[]).map(fn=>fn()));}};}
  const box=node('section');
  const context=vm.createContext({Date,Promise,crypto:cryptoOptions,CustomEvent,
    document:{createElement:node},window:{dispatchEvent:e=>events.push(e)},
    fetch:async(url,options)=>{calls.push({url,options});const value=await handler(url,options);return value?.httpStatus?{status:value.httpStatus,ok:false,json:async()=>value}:{status:200,ok:true,json:async()=>value};}});
  vm.runInContext(script,context);
  const controller=context.window.TLIReportReview.mount(box,old,{current:()=>open,open:()=>assert.fail('Navigation not requested')});
  const flatten=n=>[n,...n.children.flatMap(flatten)];
  return {box,calls,events,controller,close:()=>{open=false;controller.dispose();},button:label=>flatten(box).find(n=>n.tag==='button'&&n.textContent===label),text:()=>flatten(box).map(n=>n.textContent).join(' ')};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('opening review and reading options produce zero diagnostic mutations',async()=>{
  const h=harness(async()=>review());
  assert.equal(h.calls.length,0);
  await h.button('Review repeat check').fire();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.method,'GET');
  assert.match(h.text(),/Nothing has run/);assert.match(h.text(),/Runs on Study/);
  await h.button('Cancel review').fire();assert.equal(h.calls.length,1);
});

test('double Run sends one source-bound request and missing sample stays unavailable',async()=>{
  let finish;const h=harness(async(url,options)=>options.method==='POST'?await new Promise(resolve=>finish=resolve):review());
  await h.button('Review repeat check').fire();const button=h.button('Run reviewed repeat check');
  const a=button.fire(),b=button.fire();await tick();
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
  const sent=JSON.parse(h.calls[1].options.body);assert.equal(sent.repeat_of,'old');assert.equal(sent.expected_report_revision,revision);assert.equal(sent.request_id,'request-one');
  finish(report());await Promise.all([a,b]);assert.match(h.text(),/unavailable.*CPU.*No sample/);assert.doesNotMatch(h.text(),/repair completed/i);
});

test('failed or malformed repeat result offers no automatic retry and retains review',async()=>{
  const h=harness(async(url,options)=>options.method==='POST'?{httpStatus:409,detail:'Scope changed.'}:review());
  await h.button('Review repeat check').fire();await h.button('Run reviewed repeat check').fire();
  assert.match(h.text(),/Scope changed.*no automatic retry/);assert.equal(h.button('Run reviewed repeat check').disabled,true);
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
});

test('close or lock while a request is pending does not restore private results',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));
  const pending=h.button('Review repeat check').fire();await tick();h.close();finish(review());await pending;
  assert.equal(h.box.children.length,0);assert.equal(h.calls.length,1);
});

test('malformed reviewed target or scope cannot enable Run',async()=>{
  const value=review();value.scope.host={id:'different',name:'Other'};
  const h=harness(async()=>value);await h.button('Review repeat check').fire();
  assert.match(h.text(),/scope is incomplete/);assert.equal(h.button('Run reviewed repeat check'),undefined);
});

test('comparison does not run checks and malformed replacement preserves prior differences',async()=>{
  let count=0;
  const c={before:old,after:{...old,id:'second'},comparable:true,reason:'',scope:'Recorded statuses; not proof of a repair.',changes:[{}],checks:[{label:'CPU',before:'fail',after:'not_recorded'}]};
  const h=harness(async url=>url.endsWith('/diagnostics')?{reports:[old,{...old,id:'second'}]}:++count===1?{...envelope,comparison:c}:{...envelope,comparison:{...c,changes:null}});
  await h.button('Compare saved reports').fire();await h.button('Compare selected reports').fire();
  assert.match(h.text(),/not recorded/);
  await h.button('Compare selected reports').fire();assert.match(h.text(),/comparison is incomplete/);assert.match(h.text(),/not recorded/);
  assert(h.calls.every(c=>c.options.method==='GET'));
});

test('authentication failure dispatches lock and never attempts an action',async()=>{
  const h=harness(async()=>({httpStatus:401,detail:'Locked'}));await h.button('Review repeat check').fire();
  assert.equal(h.events[0].type,'tli-session-locked');assert.equal(h.calls.length,1);assert.equal(h.button('Run reviewed repeat check'),undefined);
});
test('a late 401 from a disposed report view cannot lock a replacement session',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));
  const pending=h.button('Review repeat check').fire();await tick();h.close();
  finish({httpStatus:401,detail:'The previous session expired.'});await pending;
  assert.equal(h.events.length,0);assert.equal(h.box.children.length,0);assert.equal(h.calls.length,1);
});
test('disposing before a queued reviewed run sends no diagnostic request',async()=>{
  const h=harness(async()=>review());await h.button('Review repeat check').fire();
  const pending=h.button('Run reviewed repeat check').fire();h.close();await pending;
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);assert.equal(h.box.children.length,0);
});

test('an HTTP browser without randomUUID sends one reviewed request using secure random bytes',async()=>{
  const h=harness(async(url,options)=>options.method==='POST'?report():review(),{getRandomValues:bytes=>{bytes.fill(7);return bytes;}});
  await h.button('Review repeat check').fire();await h.button('Run reviewed repeat check').fire();
  const posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,1);
  const body=JSON.parse(posts[0].options.body);assert.equal(body.request_id,'07'.repeat(16));assert.equal(body.expected_report_revision,revision);
  assert.match(h.text(),/New report saved/);assert.doesNotMatch(h.text(),/outcome may be uncertain/);
});

test('failure to prepare a request identifier is explicitly not a dispatched diagnostic',async()=>{
  const h=harness(async()=>review(),{});await h.button('Review repeat check').fire();await h.button('Run reviewed repeat check').fire();
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
  assert.match(h.text(),/No diagnostic request was sent/);assert.doesNotMatch(h.text(),/outcome may be uncertain/);
  assert.equal(h.button('Run reviewed repeat check').disabled,false);
});

test('transport failure after dispatch remains uncertain and never automatically repeats',async()=>{
  const h=harness(async(url,options)=>{if(options.method==='POST')throw new Error('Connection ended.');return review();});
  await h.button('Review repeat check').fire();await h.button('Run reviewed repeat check').fire();
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
  assert.match(h.text(),/outcome may be uncertain/);assert.equal(h.button('Run reviewed repeat check').disabled,true);
});
