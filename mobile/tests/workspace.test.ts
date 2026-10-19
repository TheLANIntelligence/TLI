import test from 'node:test';
import assert from 'node:assert/strict';
import { blocks,inline,safeURL } from '../src/markdown';
import { validateDocuments,validateDocumentContext } from '../src/documents';
import { settings,validateRun,runMessage,workspacePage,type HostRun } from '../src/workspace-model';
import { watchHostRun } from '../src/host-runs';
import { ApiError } from '../src/client';
import { appProject } from '../src/builder-model';
import { followChatRun } from '../src/chat-run-recovery';
const run=(patch:Partial<HostRun>={}):HostRun=>({id:'run_a',request_id:'request-a',kind:'chat',status:'running',cursor:1,events:[],text:'First',...patch});
test('rich text retains literal HTML, safe code fences, tables, and only explicit safe web links',()=>{
  assert.equal(blocks('<script>alert(1)</script>')[0]!.kind,'paragraph');
  assert.deepEqual(blocks('```js\n<danger>\n```'),[{kind:'code',language:'js',text:'<danger>'}]);
  assert.equal(blocks('| A | B |\n| --- | --- |\n| 1 | 2 |')[0]!.kind,'table');
  for(const url of ['javascript:alert(1)','file:///a','https://user:pass@example.com','https://a.test/\nfoo'])assert.equal(safeURL(url),undefined);
  assert.equal(inline('[N1](https://attacker.test)')[0]!.kind,'text');
  assert.equal(inline('[reference](https://example.com)')[0]!.kind,'link');
});
test('documents reject duplicate names, oversized contents, mixed authority and unproved rich files',()=>{
  const d={name:'plan.md',text:'A plan'};validateDocuments([d]);
  assert.throws(()=>validateDocuments([d,{...d,name:'PLAN.MD'}]));
  assert.throws(()=>validateDocuments([{...d,text:'a'.repeat(65537)}]));
  assert.throws(()=>validateDocuments([{...d,name:'../secret.txt'}]));
  assert.throws(()=>validateDocuments([{...d,name:'unproved.pdf'}]));
  assert.throws(()=>validateDocumentContext({documents:[d],note_refs:[{id:'note',revision:'a'.repeat(64)}]},'explain'));
  assert.throws(()=>validateDocumentContext({documents:[d]},'[vault:private]'));
});
test('saved settings and run receipts keep intended resource separate from executing host',()=>{
  const selection={peer_id:'peer',trust_revision:'a'.repeat(64),resource_id:'b'.repeat(64),resource_revision:'c'.repeat(64)};
  assert.deepEqual(settings({compute_selection:selection,settings_revision:2}).compute_selection,selection);
  assert.throws(()=>settings({compute_selection:{...selection,resource_revision:'bad'},settings_revision:2}));
  assert.equal(validateRun(run(),'request-a').id,'run_a');assert.throws(()=>validateRun(run(),'other'));
  assert.equal(runMessage(run({metadata:{host:{name:'Home'},inference_host:{id:'peer',name:'Worker'}}})).inference_host!.name,'Worker');
  assert.throws(()=>workspacePage({epoch:'a',cursor:1,reset:false,events:[{id:1,kind:'chat'}]}));
});
test('background watch makes no requests, resumes by read, and never replays submission',async()=>{
  let foreground=false,reads=0,sleeps=0;const seen:string[]=[];
  const result=await watchHostRun({json:async(path:string)=>{reads++;assert.match(path,/^\/api\/runs\/run_a\?after=/);return run({status:'completed',text:'Final',cursor:2}) as any;}},'run_a',{current:()=>true,foreground:()=>foreground,update:r=>seen.push(r.text),sleep:async()=>{sleeps++;foreground=true;}});
  assert.equal(reads,1);assert.equal(sleeps,1);assert.equal(result.status,'completed');assert.deepEqual(seen,['Final']);
});
test('missing acceptance and revoked access fail without any replay',async()=>{
  for(const status of [404,401]){let reads=0;await assert.rejects(watchHostRun({json:async()=>{reads++;throw new ApiError('Rejected',status);}},'run_a',{current:()=>true,foreground:()=>true,update:()=>{},sleep:async()=>{}}));assert.equal(reads,1);}
});
test('run watch preserves accepted result through a connection interruption',async()=>{
  let reads=0;const result=await watchHostRun({json:async()=>{if(++reads===1)throw Object.assign(new Error('offline'),{code:'E_NETWORK'});return run({status:'completed'}) as any;}},'run_a',{current:()=>true,foreground:()=>true,update:()=>{},sleep:async()=>{}});assert.equal(reads,2);assert.equal(result.status,'completed');
});
test('network-change transport pause waits and reads the same accepted run without submission',async()=>{
  const calls:string[]=[];let paused=true;
  const result=await watchHostRun({json:async(path:string,method?:string)=>{
    assert.equal(method,undefined);calls.push(path);
    if(paused)throw Object.assign(new Error('Route is being verified'),{code:'E_PAUSED'});
    return run({status:'completed',text:'Recovered'}) as any;
  }},'run_a',{current:()=>true,foreground:()=>true,update:()=>{},sleep:async()=>{paused=false;}});
  assert.deepEqual(calls,['/api/runs/run_a?after=0','/api/runs/run_a?after=0']);assert.equal(result.text,'Recovered');
});
test('run watch stops on certificate and local network permission failures for explicit review',async()=>{
  for(const code of ['E_TLS_TRUST','E_CERTIFICATE','E_IDENTITY','E_LOCAL_NETWORK_PERMISSION']){let reads=0,sleeps=0;await assert.rejects(watchHostRun({json:async()=>{reads++;throw Object.assign(new Error('Review connection'),{code});}},'run_a',{current:()=>true,foreground:()=>true,update:()=>{},sleep:async()=>{sleeps++;}}),/Review connection/);assert.equal(reads,1);assert.equal(sleeps,0);}
});
test('Builder project validation rejects foreign revision numbering and oversized sources',()=>{
  const project={id:'app_'+'a'.repeat(16),name:'Counter',brief:'Count',status:'ready_for_preview',revisions:[{revision:1,files:{'index.html':'<button>1</button>','style.css':'','app.js':''},checks:[],manual_checks:[]}]};
  assert.equal(appProject(project).id,project.id);assert.throws(()=>appProject({...project,revisions:[{...project.revisions[0],revision:3}]}));assert.throws(()=>appProject({...project,revisions:[{...project.revisions[0],files:{'index.html':'a'.repeat(96001),'style.css':'','app.js':''}}]}));
});

for(const interrupted of ['run','history','settings'])test('attaching shared Chat retries only reads after foreground reconnection at '+interrupted,async()=>{
  let ready=true,failed=false,runReads=0,sleeps=0;const paths:string[]=[],contexts:any[]=[],updates:string[]=[],reconciled:any[]=[];
  const result=await followChatRun({json:async(path:string,method?:string)=>{assert.equal(method,undefined);assert.equal(ready,true);paths.push(path);const step=path.startsWith('/api/runs/')?'run':path.endsWith('/settings')?'settings':'history';
    if(!failed&&step===interrupted){failed=true;ready=false;throw Object.assign(new Error('Network interrupted'),{code:'E_NETWORK'});}
    if(step==='run')return run({conversation_id:'shared',status:++runReads===1?'running':'completed',text:runReads===1?'Partial':'Final'}) as any;
    if(step==='settings')return {compute_selection:null,settings_revision:4} as any;
    return {id:'shared',messages:[{role:'assistant',content:runReads>1?'Saved final':'Earlier answer'}]} as any;
  }},'run_a',{current:()=>true,ready:()=>ready,sharedSettings:true,context:(conversation,config)=>contexts.push({conversation,config}),update:value=>updates.push(value.text),reconcile:conversation=>reconciled.push(conversation),sleep:async()=>{sleeps++;ready=true;}});
  assert.equal(result.status,'completed');assert.equal(contexts.length,1);assert.equal(contexts[0].config.settings_revision,4);assert.equal(contexts[0].conversation.messages[0].content,'Earlier answer');assert.deepEqual(updates,['Partial','Final']);assert.equal(reconciled[0].messages[0].content,'Saved final');assert.ok(sleeps>=1);assert.ok(paths.every(path=>path.startsWith('/api/')));
});
test('a delayed run attachment cannot replace a newer session or show an obsolete history',async()=>{
  let current=true,release!:(value:unknown)=>void,published=0;const pending=new Promise(resolve=>{release=resolve;});
  const result=followChatRun({json:async()=>pending as any},'run_a',{current:()=>current,ready:()=>true,sharedSettings:true,context:()=>published++,update:()=>published++,reconcile:()=>published++});
  current=false;release(run({conversation_id:'old'}));await assert.rejects(result,/workspace changed/);assert.equal(published,0);
});
test('run attachment stops on missing records, revoked credentials and identity failures',async()=>{
  for(const error of [new ApiError('Missing',404),new ApiError('Revoked',401),Object.assign(new Error('Identity changed'),{code:'E_IDENTITY'})]){let reads=0;await assert.rejects(followChatRun({json:async()=>{reads++;throw error;}},'run_a',{current:()=>true,ready:()=>true,sharedSettings:true,context:()=>assert.fail(),update:()=>assert.fail(),reconcile:()=>assert.fail(),sleep:async()=>assert.fail('No automatic retry')}));assert.equal(reads,1);}
});
