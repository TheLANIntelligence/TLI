const test = require('node:test');
const assert = require('node:assert/strict');
const {assess, PROTOCOL} = require('../js/release-status.js');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const valid = () => ({ok:true,release:{schema_version:1,protocol:PROTOCOL,source_id:'a'.repeat(64),backend_id:'b'.repeat(64),frontend_id:'c'.repeat(64),capabilities:['storage_jobs_v1'],compatibility:{state:'matched'}}});
test('legacy hosts and malformed identities remain unknown', () => {
  for (const v of [null,{ok:true,build_id:'old'}, {...valid(),ok:false}]) assert.equal(assess(v).state,'unknown');
  for (const field of ['source_id','backend_id','frontend_id']) { const v=valid();v.release[field]='bad';assert.equal(assess(v).state,'unknown'); }
  const other=valid();other.release.protocol='future';assert.equal(assess(other).state,'unknown');
});
test('backend drift requests reviewed restart without claiming cancellation',()=>{
 const value=valid();value.release.compatibility.state='restart_required';const r=assess(value);
 assert.equal(r.state,'restart_required');assert.match(r.message,/Existing work has not been cancelled/);
});
test('matching application exposes only reported capability support',()=>{
 assert.deepEqual(assess(valid()).capabilities,['storage_jobs_v1']);
});
function runtime(response,{init=false}={}) {
 const calls=[],events=[],reviews=[],nodes={};
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 for(const match of html.matchAll(/<[^>]+\bid="((?:tli|settings)-release-[^"]+)"[^>]*>/g))nodes[match[1]]={hidden:/\shidden(?:\s|>)/.test(match[0]),textContent:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},click(){this.listeners.click?.({currentTarget:this});}};
 const document={readyState:init?'complete':'loading',hidden:false,addEventListener(){},getElementById:id=>nodes[id]||null};
 const window={document,TLIHostLifecycle:{open:(...args)=>reviews.push(args)},addEventListener(){},dispatchEvent:e=>events.push(e),fetch:async(url,options)=>{calls.push({url,options});if(response instanceof Error)throw response;return {ok:true,json:async()=>response};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/release-status.js'),'utf8'),{window,document,setTimeout,clearTimeout,AbortController,CustomEvent:class{constructor(name,opts){this.name=name;this.detail=opts?.detail;}},Date,Error});
 return {api:window.TLIRelease,calls,events,nodes,reviews};
}
test('simultaneous checks coalesce and never execute or restart anything',async()=>{
 const r=runtime(valid());await Promise.all([r.api.check(),r.api.check(),r.api.requireCapability('storage_jobs_v1')]);
 assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,'/api/diagnostics/version');assert.equal(r.calls[0].options.method,undefined);
});
test('unavailable host rejects a new operation with a deliberate retry message',async()=>{
 const r=runtime({ok:true});await assert.rejects(r.api.requireCapability('storage_jobs_v1'),e=>e.status===409&&e.code==='host_version_not_ready');
 assert.equal(r.calls.length,1);
});
test('unknown capability cannot start even on a matched host',async()=>{
 const r=runtime(valid());await assert.rejects(r.api.requireCapability('unknown_feature'),e=>e.status===409);
});
test('validated drift exposes banner and Settings restart buttons that open review without a mutation',async()=>{
 const value=valid();value.release.compatibility.state='restart_required';const r=runtime(value,{init:true});await r.api.check();
 assert.equal(r.nodes['tli-release-notice'].hidden,false);assert.equal(r.nodes['tli-release-title'].textContent,'Restart TLI to finish updating');assert.match(r.nodes['tli-release-message'].textContent,/review the restart before it runs/);
 for(const id of ['tli-release-restart','settings-release-restart']){assert.equal(r.nodes[id].hidden,false);r.nodes[id].click();assert.deepEqual(r.reviews.at(-1),['restart',r.nodes[id]]);}
 assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,'/api/diagnostics/version');assert.equal(r.calls[0].options.method,undefined);
 await assert.rejects(r.api.requireCapability('storage_jobs_v1'),error=>error.code==='host_version_not_ready');
});
test('matched host and unknown connection hide update restart and cannot open its review',async()=>{
 for(const response of [valid(),{ok:true},new Error('Connection lost')]){
  const r=runtime(response,{init:true});await r.api.check();for(const id of ['tli-release-restart','settings-release-restart']){assert.equal(r.nodes[id].hidden,true);r.nodes[id].click();}assert.equal(r.reviews.length,0);assert.equal(r.calls.length,1);
  if(response instanceof Error)assert.match(r.nodes['tli-release-message'].textContent,/Check the connection/);
 }
});
