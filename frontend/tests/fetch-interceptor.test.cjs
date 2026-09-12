const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../js/fetch-interceptor.js'),'utf8');
function fixture(fetcher){const events=[],calls=[],listeners={};let checked=0;const response={status:401,clone(){return this;}};
 const window={location:{href:'https://tli-ui.test/',origin:'https://tli-ui.test'},fetch:async(...args)=>{calls.push(args);return fetcher?fetcher(...args):response;},addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),dispatchEvent:e=>{events.push(e.type);for(const fn of listeners[e.type]||[])fn(e);},TLIPinLock:{checkAndLock(){checked++;}}};
 vm.runInNewContext(code,{window,URL,Headers,Request,CustomEvent});return {window,events,calls,response,checked:()=>checked};}
test('independent MCP grant expiry preserves unrelated PIN-session drafts',async()=>{
 const f=fixture(),header={Authorization:'Bearer tlim_'+'a'.repeat(43)};
 assert.equal(await f.window.fetch('/api/mcp',{headers:header}),f.response);
 await f.window.fetch(new Request('https://tli-ui.test/api/mcp',{headers:header}));
 await f.window.fetch(new URL('https://tli-ui.test/api/mcp'),{headers:new Headers(header)});
 assert.deepEqual(f.events,[]);assert.equal(f.checked(),0);assert.equal(f.calls.length,3);
});
test('management, sibling, remote and ordinary credentials retain session relock',async()=>{
 const header={Authorization:'Bearer tlim_'+'a'.repeat(43)};
 for(const [url,options] of [['/api/integrations/mcp/status',{}],['/api/integrations/mcp/grant',{headers:header}],['/api/mcp/',{headers:header}],['/api/mcp-evil',{headers:header}],['https://other.test/api/mcp',{headers:header}],['/api/mcp',{}],['/api/mcp',{headers:{Authorization:'Bearer companion-credential'}}]]){
  const f=fixture();await f.window.fetch(url,options);assert.deepEqual(f.events,['tli-session-locked'],url);assert.equal(f.checked(),1);
 }
});
test('explicit init headers replace Request headers when deciding relock',async()=>{
 const f=fixture();await f.window.fetch(new Request('https://tli-ui.test/api/mcp',{headers:{Authorization:'Bearer tlim_'+'a'.repeat(43)}}),{headers:{}});
 assert.deepEqual(f.events,['tli-session-locked']);
});
test('old unauthorized response cannot relock a newly unlocked session',async()=>{
 let finish;const response=new Response('expired old request',{status:401});
 const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=f.window.fetch('/api/intelligence/diagnostics/old-report');
 f.window.dispatchEvent(new CustomEvent('tli-session-locked'));
 f.window.dispatchEvent(new CustomEvent('tli-session-unlocked'));
 finish(response);
 assert.equal(await pending,response);
 assert.equal(await response.text(),'expired old request');
 assert.deepEqual(f.events,['tli-session-locked','tli-session-unlocked']);
 assert.equal(f.checked(),0);
});
test('concurrent rejections relock once and a later session still handles its own rejection',async()=>{
 const pending=[];const f=fixture(()=>new Promise(resolve=>pending.push(resolve)));
 const first=f.window.fetch('/api/one'),second=f.window.fetch('/api/two');
 pending[0](f.response);await first;pending[1](f.response);await second;
 assert.equal(f.checked(),1);assert.deepEqual(f.events,['tli-session-locked']);
 f.window.dispatchEvent(new CustomEvent('tli-session-unlocked'));
 const third=f.window.fetch('/api/three');pending[2](f.response);await third;
 assert.equal(f.checked(),2);
 assert.deepEqual(f.events,['tli-session-locked','tli-session-unlocked','tli-session-locked']);
});
test('success and network failures retain their caller-visible behavior across a session change',async()=>{
 let finish;const response=new Response('retained caller result',{status:200});
 const f=fixture(()=>new Promise(resolve=>{finish=resolve;})),pending=f.window.fetch('/api/read');
 f.window.dispatchEvent(new CustomEvent('tli-session-locked'));finish(response);
 assert.equal(await pending,response);assert.equal(f.checked(),0);
 const failed=fixture(()=>Promise.reject(new TypeError('network unavailable')));
 await assert.rejects(failed.window.fetch('/api/read'),/network unavailable/);
 assert.deepEqual(failed.events,[]);
});
