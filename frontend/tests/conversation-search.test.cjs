const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../chat_history.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const protocol='conversation-search-v1', base='/api/intelligence/conversation-search';
const item=(id='one',extra={})=>({id,title:'Printer setup',last_updated:'2026-09-07T12:00:00Z',message_count:2,provider:'bundled',snippet:'The printer is in the office.',match:{source:'assistant',at:'2026-09-07T12:00:00Z'},truncated:false,...extra});
const page=(items=[item()],extra={})=>({ok:true,protocol,query:'',items,next_cursor:null,coverage:{complete:true,text_limited:false,more_to_search:false,scanned_conversations:items.length,owned_conversations:items.length,limits:{messages_per_conversation:500,characters_per_message:16384}},...extra});
function fixture(){
  const nodes={},calls=[],events={},docEvents={},timers=[],storage=new Map(),opened=[],deleted=[];
  let handler=null;
  function element(tag){
    const classes=new Set();
    const el={tag,children:[],handlers:{},attributes:{},style:{},textContent:'',value:'',disabled:false,hidden:false,
      classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},
      append(...children){this.children.push(...children);},appendChild(child){this.append(child);return child;},
      replaceChildren(...children){this.children=children;},before(){},after(){},
      setAttribute(key,value){this.attributes[key]=value;},
      addEventListener(key,fn){(this.handlers[key]||=[]).push(fn);},
      fire(key,extra={}){return Promise.all((this.handlers[key]||[]).map(fn=>fn({preventDefault(){},...extra})));},
      click(){return this.disabled?Promise.resolve():this.fire('click');},focus(){this.focused=true;},scrollIntoView(){},
    };
    Object.defineProperty(el,'id',{set(id){nodes[id]=this;},get(){return Object.keys(nodes).find(k=>nodes[k]===this);}});
    return el;
  }
  for(const id of ['chat-history-list','chat-history-drawer','chat-history-btn','chat-history-close','recent-chats-list','chat-send-btn']){nodes[id]=element('div');}
  nodes['chat-history-drawer'].classList.add('hidden');
  const ctx=vm.createContext({console,Date,URL,Set,Map,CustomEvent,
    setTimeout:fn=>timers.push(fn),localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    document:{readyState:'complete',createElement:element,getElementById:id=>nodes[id]||null,addEventListener:(key,fn)=>(docEvents[key]||=[]).push(fn)},
    window:{addEventListener:(key,fn)=>(events[key]||=[]).push(fn),dispatchEvent:event=>(events[event.type]||[]).forEach(fn=>fn(event)),loadConversation:async(...args)=>{opened.push(args);return true;},TLIConversationLoad:{invalidate(){ctx.invalidated=(ctx.invalidated||0)+1;},deleted:id=>deleted.push(id)}},
    fetch:async(url,options={})=>{
      calls.push({url,options});let result=handler?await handler(url,options):undefined;
      if(result===undefined)result=url===base+'/capabilities'?{ok:true,protocol}:url==='/api/ai/conversations'?{conversations:[item()]}:page();
      return {ok:!result.status||result.status===200,status:result.status||200,json:async()=>{if(result.invalidJson)throw Error('Invalid JSON');return Object.hasOwn(result,'body')?result.body:result;}};
    }
  });
  vm.runInContext(script,ctx);
  return {nodes,calls,ctx,events,docEvents,timers,storage,opened,deleted,api:ctx.window.TLIConversationSearch,handler(fn){handler=fn;},
    async query(text){nodes['conversation-search-query'].value=text;await nodes['conversation-search-query'].fire('input');await nodes['conversation-search-form'].fire('submit');await tick();},
    async event(key){await Promise.all((events[key]||[]).map(fn=>fn()));}
  };
}
function descendants(el){return el.children.flatMap(child=>[child,...descendants(child)]);}
function button(el,text){const found=descendants(el).find(n=>n.tag==='button'&&n.textContent===text);assert.ok(found,'Button '+text);return found;}
function content(el){return [el.textContent,...descendants(el).map(n=>n.textContent)].join(' ');}

test('History opens explicitly, verifies capability, and shows bounded provenance without sending chat',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.api.open();
  assert.deepEqual(f.calls.map(c=>c.url),[base+'/capabilities',base+'?q=&limit=20']);
  assert.match(content(f.nodes['chat-history-list']),/Printer setup.*bundled.*Matching AI\/TLI message.*printer/);
  assert.match(f.nodes['conversation-search-status'].textContent,/Nothing was sent to AI/);
  assert.ok(f.calls.every(c=>!c.options.method));assert.equal(f.nodes['chat-history-drawer'].classList.contains('hidden'),false);
});

for(const capability of [{status:404,body:{detail:'Not found'}},{status:405,body:{detail:'Method not allowed'}}]){
  test('Explicit unsupported capability uses recent-only fallback '+JSON.stringify(capability),async()=>{
    const f=fixture();f.handler(url=>url===base+'/capabilities'?capability:undefined);await f.query('printer');
    assert.deepEqual(f.calls.map(c=>c.url),[base+'/capabilities','/api/ai/conversations']);
    assert.match(f.nodes['conversation-search-status'].textContent,/unsupported.*latest 20.*text was not applied/);
    assert.equal(f.nodes['conversation-search-more'].hidden,true);assert.equal(descendants(f.nodes['chat-history-list']).some(n=>n.textContent==='Delete'),false);
  });
}

test('Authentication failure does not fall back to another history endpoint',async()=>{
  const f=fixture();f.handler(()=>({status:401,body:{detail:'Unlock TLI first.'}}));await f.api.open();
  assert.equal(f.calls.length,1);assert.match(f.nodes['conversation-search-status'].textContent,/Unlock TLI/);assert.equal(f.nodes['chat-history-list'].children.length,0);
});

for(const failure of [
  {status:401,invalidJson:true},{status:403,invalidJson:true},{status:503,body:{detail:'History unavailable.'}},
  {ok:true,protocol:'old'},{unexpected:true},{body:null},{invalidJson:true},new TypeError('Network unavailable'),
])test('unavailable or invalid search capability cannot start legacy fallback: '+JSON.stringify(failure),async()=>{
  const f=fixture();f.handler(()=>{if(failure instanceof Error)throw failure;return failure;});
  await f.query('my unfinished query');
  assert.deepEqual(f.calls.map(call=>call.url),[base+'/capabilities']);
  assert.equal(f.nodes['chat-history-list'].children.length,0);assert.equal(f.opened.length,0);
  const denied=[401,403].includes(failure.status);
  assert.equal(f.nodes['conversation-search-submit'].disabled,denied);
  assert.equal(f.nodes['conversation-search-query'].value,denied?'':'my unfinished query');
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide'])test('history clears on '+event+' and detached controls stay inert after verified recovery',async()=>{
  const f=fixture();await f.api.open();const row=f.nodes['chat-history-list'].children[0],oldOpen=row.children[0],oldDelete=button(row,'Delete');
  await oldDelete.click();const oldConfirm=f.nodes['conversation-search-delete-confirm'];
  f.nodes['conversation-search-query'].value='private query';await f.event(event);
  assert.equal(f.nodes['chat-history-list'].children.length,0);assert.equal(f.nodes['conversation-search-delete-review'].children.length,0);
  assert.equal(f.nodes['conversation-search-query'].value,'');assert.equal(f.nodes['chat-history-drawer'].classList.contains('hidden'),true);
  await f.event('tli-private-observation-ready');await f.api.open();assert.equal(f.calls.length,2);
  await f.event('tli-session-unlocked');await f.api.refresh();await f.api.open();assert.equal(f.calls.length,2);
  assert.equal(f.nodes['conversation-search-submit'].disabled,true);
  await f.event('tli-private-observation-ready');assert.equal(f.calls.length,2,'Verified recovery does not replay the old search or delete');
  await oldOpen.fire('click');await oldDelete.fire('click');await oldConfirm.fire('click');
  assert.equal(f.calls.length,2);assert.equal(f.opened.length,0);assert.equal(f.nodes['conversation-search-delete-review'].children.length,0);
  await f.api.open();assert.equal(f.calls.length,4);assert.equal(f.nodes['chat-history-list'].children.length,1);
  await f.nodes['chat-history-list'].children[0].children[0].click();assert.deepEqual(f.opened,[['one','Printer setup']]);
  assert.ok(f.calls.every(call=>!call.options.method));
});

for(const [phase,status] of [['capabilities',200],['capabilities',403],['capabilities',404],['query',200],['query',401],['query',403]])test('old '+phase+' response '+status+' cannot disclose, fall back or relock recovered search',async()=>{
  const f=fixture();let release;
  f.handler(url=>(phase==='capabilities'?url.endsWith('/capabilities'):url.includes('?'))?new Promise(resolve=>{release=resolve;}):undefined);
  const old=f.api.open();await tick();await f.event('tli-account-changed');await f.event('tli-session-unlocked');await f.event('tli-private-observation-ready');
  f.handler(()=>undefined);await f.api.open();const count=f.calls.length;
  release(status===200?(phase==='capabilities'?{ok:true,protocol}:page([item('old',{title:'Private stale result'})])):{status,invalidJson:true});await old;
  assert.equal(f.calls.length,count);assert.match(content(f.nodes['chat-history-list']),/Printer setup/);
  assert.doesNotMatch(content(f.nodes['chat-history-list']),/Private stale result/);assert.equal(f.nodes['conversation-search-submit'].disabled,false);
  assert.equal(f.nodes['chat-history-drawer'].classList.contains('hidden'),false);
});

for(const status of [401,403])test('search result denial '+status+' clears retained rows and waits for verified access',async()=>{
  const f=fixture();await f.api.open();f.nodes['conversation-search-query'].value='private draft';
  f.handler(url=>url.includes('?')?{status,invalidJson:true}:undefined);await f.api.refresh();
  assert.equal(f.nodes['chat-history-list'].children.length,0);assert.equal(f.nodes['conversation-search-query'].value,'');
  await f.event('tli-session-unlocked');await f.api.open();assert.equal(f.calls.length,4);
  await f.event('tli-private-observation-ready');assert.equal(f.calls.length,4);assert.equal(f.opened.length,0);
});

test('Expired authentication clears earlier results even when the denial body is unreadable',async()=>{
  const f=fixture();await f.api.open();assert.equal(f.nodes['chat-history-list'].children.length,1);
  f.handler(()=>({status:401,invalidJson:true}));await f.api.refresh();
  assert.equal(f.calls.length,3);assert.equal(f.nodes['chat-history-list'].children.length,0);
  assert.equal(f.nodes['conversation-search-submit'].disabled,true);
});

test('Bounded Unicode snippets are validated by characters rather than UTF-16 code units',async()=>{
  const f=fixture();f.handler(url=>url.includes('?')?page([item('one',{snippet:'🎹'.repeat(240)})]):undefined);
  await f.api.open();assert.equal(f.nodes['chat-history-list'].children.length,1);
});

test('Results remain literal text and opening delegates to the guarded conversation loader',async()=>{
  const f=fixture();f.handler(url=>url.includes('?')?page([item('owned',{title:'<img src=x onerror=alert(1)>',snippet:'<script>bad()</script>'})]):undefined);
  await f.api.open();const row=f.nodes['chat-history-list'].children[0];
  assert.match(content(row),/<img src=x.*<script>/);assert.equal(descendants(row).some(n=>n.tag==='script'||n.tag==='img'),false);
  await row.children[0].click();assert.deepEqual(f.opened,[['owned','<img src=x onerror=alert(1)>']]);
  assert.equal(f.nodes['chat-history-drawer'].classList.contains('hidden'),true);assert.equal(f.calls.length,2);
});

test('Search paging continues past an empty bounded page and appends older matches',async()=>{
  const f=fixture(),cursor='a'.repeat(32);let pages=0;
  f.handler(url=>url.includes('?')?(++pages===1?page([],{query:'printer',next_cursor:cursor,coverage:{...page().coverage,complete:false,more_to_search:true,scanned_conversations:250,owned_conversations:251}}):page([item('older')],{query:'printer',coverage:{...page().coverage,scanned_conversations:251,owned_conversations:251}})):undefined);
  await f.query('printer');assert.equal(f.nodes['conversation-search-more'].hidden,false);assert.match(f.nodes['conversation-search-status'].textContent,/Load more/);
  await f.nodes['conversation-search-more'].click();await tick();
  assert.equal(f.nodes['chat-history-list'].children.length,1);assert.match(f.calls.at(-1).url,/cursor=aaaaaaaa/);assert.equal(f.nodes['conversation-search-more'].hidden,true);
});

test('Changed store errors retain existing results and require an explicit fresh search',async()=>{
  const f=fixture();let pages=0;
  f.handler(url=>url.includes('?')?(++pages===1?page([item()],{next_cursor:'a'.repeat(32),coverage:{...page().coverage,complete:false,more_to_search:true,owned_conversations:2}}):{status:409,body:{detail:'Saved conversations changed while paging.'}}):undefined);
  await f.api.open();await f.nodes['conversation-search-more'].click();await tick();
  assert.equal(f.nodes['chat-history-list'].children.length,1);assert.match(f.nodes['conversation-search-status'].textContent,/changed.*Start the search again/);assert.equal(f.nodes['conversation-search-more'].hidden,true);assert.equal(pages,2);
});

test('Late results cannot replace a newer query or reappear after locking',async()=>{
  for(const action of ['input','lock']){
    const f=fixture();let release;f.handler(url=>url.includes('?')?new Promise(resolve=>release=resolve):undefined);
    const pending=f.api.open();await tick();
    if(action==='input'){f.nodes['conversation-search-query'].value='newer';await f.nodes['conversation-search-query'].fire('input');}
    else { f.nodes['conversation-search-query'].value='private question';await f.event('tli-session-locked'); }
    release(page());await pending;
    assert.equal(f.nodes['chat-history-list'].children.length,0);assert.equal(f.nodes['conversation-search-submit'].disabled,action==='lock');
    if(action==='lock'){assert.equal(f.nodes['chat-history-drawer'].classList.contains('hidden'),true);assert.equal(f.nodes['conversation-search-query'].value,'');}
  }
});

test('Malformed search success never displays an unvalidated result',async()=>{
  for(const result of [page([item('one',{snippet:'x'.repeat(243)})]),page([item(),item()]),page([item()],{next_cursor:'invalid'}),page([item()],{ok:false})]){
    const f=fixture();f.handler(url=>url.includes('?')?result:undefined);await f.api.open();
    assert.equal(f.nodes['chat-history-list'].children.length,0);assert.match(f.nodes['conversation-search-status'].textContent,/could not be validated/);
  }
});

test('Partial inspection clearly limits negative search claims',async()=>{
  const f=fixture();f.handler(url=>url.includes('?')?page([],{coverage:{...page().coverage,complete:false,text_limited:true,scanned_conversations:1,owned_conversations:1}}):undefined);
  await f.api.open();assert.match(f.nodes['conversation-search-status'].textContent,/Some text was not inspected.*500.*16,384.*does not mean a conversation is missing/);
});

test('Delete requires review, sends once, and clears only the confirmed owned conversation',async()=>{
  const f=fixture();await f.api.open();f.storage.set('tli_active_conv_id','one');await button(f.nodes['chat-history-list'],'Delete').click();
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);assert.match(content(f.nodes['conversation-search-delete-review']),/Printer setup.*Starting a new chat does not delete/);
  let release;f.handler((url,options)=>options.method==='POST'?new Promise(resolve=>release=resolve):undefined);
  const first=f.nodes['conversation-search-delete-confirm'].click();await tick();await f.nodes['conversation-search-delete-confirm'].click();
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);assert.deepEqual(JSON.parse(f.calls.at(-1).options.body),{session_id:'one'});
  release({ok:true,session_id:'one',deleted:true});await first;
  assert.equal(f.nodes['chat-history-list'].children.length,0);assert.deepEqual(f.deleted,['one']);assert.equal(f.storage.has('tli_active_conv_id'),false);assert.match(f.nodes['conversation-search-status'].textContent,/Conversation deleted/);
});

test('Failed or malformed deletion preserves the row and explicit review without automatic retry',async()=>{
  for(const response of [{status:503,body:{detail:'History unavailable.'}},{ok:true,session_id:'other',deleted:true},{ok:true,session_id:'one'},{ok:false,session_id:'one',deleted:true}]){
    const f=fixture();await f.api.open();await button(f.nodes['chat-history-list'],'Delete').click();f.handler((url,options)=>options.method==='POST'?response:undefined);
    await f.nodes['conversation-search-delete-confirm'].click();
    assert.equal(f.nodes['chat-history-list'].children.length,1);assert.match(content(f.nodes['conversation-search-delete-review']),/Delete the retained/);assert.equal(f.nodes['conversation-search-delete-confirm'].disabled,false);
    assert.match(f.nodes['conversation-search-status'].textContent,/No retry ran automatically/);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);assert.equal(f.deleted.length,0);
  }
});

test('A reply in progress blocks both delete review and a previously opened confirmation',async()=>{
  const f=fixture();await f.api.open();f.nodes['chat-send-btn'].disabled=true;
  await button(f.nodes['chat-history-list'],'Delete').click();
  assert.equal(f.nodes['conversation-search-delete-review'].children.length,0);assert.match(f.nodes['conversation-search-status'].textContent,/Wait for the current reply or cancel/);
  f.nodes['chat-send-btn'].disabled=false;await button(f.nodes['chat-history-list'],'Delete').click();
  f.nodes['chat-send-btn'].disabled=true;await f.nodes['conversation-search-delete-confirm'].click();
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);assert.equal(f.nodes['chat-history-list'].children.length,1);
  assert.match(content(f.nodes['conversation-search-delete-review']),/Delete the retained conversation/);
});

test('New Chat resets local context without deleting retained backend conversations',()=>{
  const f=fixture();f.ctx.window.chatHistory=[{role:'user',content:'private'}];f.storage.set('tli_active_conv_id','one');
  f.ctx.window.resetChatHistory({alsoClearStorage:true});
  assert.equal(f.ctx.window.chatHistory.length,0);assert.equal(f.storage.has('tli_active_conv_id'),false);assert.equal(f.calls.length,0);assert.equal(f.ctx.invalidated,1);
});

test('Page restore uses the guarded loader and never writes retained messages into context itself',async()=>{
  const f=fixture();f.storage.set('tli_active_conv_id','one');
  for(const callback of f.docEvents.DOMContentLoaded||[])callback();
  for(const callback of f.timers)await callback();
  assert.deepEqual(JSON.parse(JSON.stringify(f.opened)),[['one','Last conversation',{restore:true}]]);assert.equal(f.ctx.window.chatHistory.length,0);assert.equal(f.calls.length,0);
});

function loaderFixture(){
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),events={},pending=[],rendered=[],decorations=[],storage=new Map();
  const nodes={'chat-input':{value:'',focus(){}},'chat-send-btn':{disabled:false},'abort-chat-btn':{disabled:true},'chat-output':{innerHTML:''}};
  const ctx=vm.createContext({console,Date,Map,CustomEvent,setTimeout(){},$:id=>nodes[id],
    document:{readyState:'complete',getElementById:id=>nodes[id],addEventListener(){}},
    addEventListener:(key,fn)=>(events[key]||=[]).push(fn),
    dispatchEvent:event=>(events[event.type]||[]).forEach(fn=>fn(event)),
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetch:(url,options={})=>new Promise(resolve=>pending.push({url,options,resolve})),
    appendMessage:(role,content)=>{const bubble={role,content};rendered.push(bubble);return bubble;},
    clearChatWithPlaceholder:()=>{rendered.length=0;},
    TLIMemory:{clear(){},decorateMessage:(bubble,message)=>decorations.push(['user',message]),decorateReply:(bubble,message)=>decorations.push(['assistant',message])},
    TLIDocuments:{clear(){},annotateReply(){}},
  });
  ctx.window=ctx;
  vm.runInContext(script,ctx);
  vm.runInContext(app.slice(app.indexOf('let currentConversationId ='),app.indexOf('let meshDirectoryCache =')),ctx);
  const start=app.indexOf('async function loadConversation(');
  vm.runInContext(app.slice(start,app.indexOf('function addPreviousPrompt',start)),ctx);
  const reply=(index,messages)=>pending[index].resolve({ok:true,json:async()=>({messages})});
  return {ctx,nodes,events,pending,rendered,decorations,storage,reply};
}

test('Actual conversation loader lets the newest response win and retains body-free source decorations',async()=>{
  const f=loaderFixture();const first=f.ctx.loadConversation('old','Old'),second=f.ctx.loadConversation('new','New');
  const messages=[{role:'user',content:'A current question',source_ref:{conversation_id:'new'}},{role:'assistant',content:'A current answer',memory_context:{actions_performed:false}}];
  f.reply(1,messages);assert.equal(await second,true);
  f.reply(0,[{role:'assistant',content:'Stale answer'}]);assert.equal(await first,false);
  assert.equal(f.ctx.currentConversationId,'new');assert.deepEqual(f.rendered.map(b=>b.content),['A current question','A current answer']);
  assert.deepEqual(f.decorations.map(d=>d[0]),['user','assistant']);assert.equal(f.ctx.chatHistory.length,2);
  assert.equal(f.ctx.chatHistory[0].source_ref,undefined);assert.equal(f.ctx.chatHistory[1].memory_context,undefined);
});

test('Actual startup restore never overwrites an existing or newly typed draft',async()=>{
  const f=loaderFixture();f.nodes['chat-input'].value='My unsent question';
  assert.equal(await f.ctx.loadConversation('saved','Saved',{restore:true}),false);assert.equal(f.pending.length,0);
  f.nodes['chat-input'].value='';const pending=f.ctx.loadConversation('saved','Saved',{restore:true});
  f.nodes['chat-input'].value='A newer draft';f.reply(0,[{role:'assistant',content:'Old answer'}]);
  assert.equal(await pending,false);assert.equal(f.nodes['chat-input'].value,'A newer draft');assert.equal(f.rendered.length,0);assert.equal(f.ctx.currentConversationId,undefined);
});

test('Actual load is invalidated by New Chat without deleting retained conversations',async()=>{
  const f=loaderFixture();const pending=f.ctx.loadConversation('saved','Saved');
  f.ctx.resetChatHistory({alsoClearStorage:true});f.reply(0,[{role:'assistant',content:'Old answer'}]);
  assert.equal(await pending,false);assert.equal(f.rendered.length,0);assert.equal(f.ctx.chatHistory.length,0);
  assert.equal(f.pending.length,1);assert.equal(f.pending[0].url,'/api/ai/conversations/saved');
});

test('Actual session lock clears pending history and an active reply blocks navigation',async()=>{
  const f=loaderFixture();f.nodes['chat-send-btn'].disabled=true;
  assert.equal(await f.ctx.loadConversation('saved','Saved'),false);assert.equal(f.pending.length,0);
  f.nodes['chat-send-btn'].disabled=false;const pending=f.ctx.loadConversation('saved','Saved');
  for(const callback of f.events['tli-session-locked'])callback();
  f.reply(0,[{role:'assistant',content:'Private old answer'}]);assert.equal(await pending,false);
  assert.equal(f.rendered.length,0);assert.equal(f.ctx.currentConversationId,null);assert.equal(f.ctx.chatHistory.length,0);
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide'])test('actual loader clears private context on '+event+' and requires verified explicit navigation',async()=>{
  const f=loaderFixture(),emit=type=>f.ctx.dispatchEvent(new CustomEvent(type));
  let load=f.ctx.loadConversation('visible','Visible');f.reply(0,[{role:'assistant',content:'Private visible answer'}]);assert.equal(await load,true);
  f.storage.set('tli_active_conv_id','visible');f.nodes['chat-input'].value='Private draft';
  const pending=f.ctx.loadConversation('old','Old');emit(event);
  assert.equal(f.ctx.currentConversationId,null);assert.equal(f.ctx.chatHistory.length,0);assert.equal(f.rendered.length,0);
  assert.equal(f.nodes['chat-input'].value,'');assert.equal(f.storage.has('tli_active_conv_id'),false);
  emit('tli-private-observation-ready');assert.equal(await f.ctx.loadConversation('blocked','Blocked'),false);
  emit('tli-session-unlocked');f.nodes['chat-input'].value='Fresh unsent draft';assert.equal(await f.ctx.loadConversation('blocked','Blocked'),false);
  assert.equal(f.pending.length,2);emit('tli-private-observation-ready');assert.equal(f.pending.length,2,'Recovery never opens the old conversation');
  load=f.ctx.loadConversation('new','New');f.reply(2,[{role:'assistant',content:'Current answer'}]);assert.equal(await load,true);
  f.pending[1].resolve({ok:false,status:403,json:()=>assert.fail('Stale denial body must not be read')});assert.equal(await pending,false);
  assert.equal(f.ctx.TLIConversationLoad.canRead(),true);assert.equal(f.ctx.currentConversationId,'new');assert.equal(f.ctx.chatHistory[0].content,'Current answer');
  assert.equal(f.nodes['chat-input'].value,'Fresh unsent draft');assert.equal(f.pending.length,3);
});

for(const status of [401,403])test('current detail denial '+status+' clears visible conversation even with unreadable denial body',async()=>{
  const f=loaderFixture();let load=f.ctx.loadConversation('visible','Visible');f.reply(0,[{role:'assistant',content:'Private answer'}]);await load;
  load=f.ctx.loadConversation('denied','Denied');f.pending[1].resolve({ok:false,status,json:()=>assert.fail('No denial body needed')});assert.equal(await load,false);
  assert.equal(f.ctx.TLIConversationLoad.canRead(),false);assert.equal(f.ctx.chatHistory.length,0);assert.equal(f.rendered.length,0);assert.equal(f.ctx.currentConversationId,null);
  f.ctx.dispatchEvent(new CustomEvent('tli-session-unlocked'));assert.equal(await f.ctx.loadConversation('denied','Denied'),false);assert.equal(f.pending.length,2);
});

test('a detail body finishing after recovery cannot replace the new conversation',async()=>{
  const f=loaderFixture();let release;const old=f.ctx.loadConversation('old','Old');
  f.pending[0].resolve({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})});await tick();
  for(const type of ['tli-session-locked','tli-session-unlocked','tli-private-observation-ready'])f.ctx.dispatchEvent(new CustomEvent(type));
  const fresh=f.ctx.loadConversation('new','New');f.reply(1,[{role:'assistant',content:'New answer'}]);assert.equal(await fresh,true);
  release({messages:[{role:'assistant',content:'Old private answer'}]});assert.equal(await old,false);
  assert.deepEqual(f.rendered.map(row=>row.content),['New answer']);assert.equal(f.ctx.currentConversationId,'new');
});

for(const failure of [{ok:false,status:503},{ok:true,status:200,body:{messages:null}},{ok:true,status:200,body:{messages:[{role:'assistant',content:42}]}}])test('ordinary failed detail read preserves existing conversation and unsent draft: '+JSON.stringify(failure),async()=>{
  const f=loaderFixture();let load=f.ctx.loadConversation('visible','Visible');f.reply(0,[{role:'assistant',content:'Retained answer'}]);await load;
  f.nodes['chat-input'].value='Unsent question';load=f.ctx.loadConversation('bad','Bad');f.pending[1].resolve({...failure,json:async()=>failure.body});assert.equal(await load,false);
  assert.equal(f.ctx.currentConversationId,'visible');assert.equal(f.ctx.chatHistory[0].content,'Retained answer');assert.equal(f.nodes['chat-input'].value,'Unsent question');assert.equal(f.ctx.TLIConversationLoad.canRead(),true);
});

for(const outcome of ['failure','draft','success'])test('history and AI settings commit together after settings '+outcome,async()=>{
  const f=loaderFixture();let initial=f.ctx.loadConversation('old','Old');f.reply(0,[{role:'assistant',content:'Old answer'}]);assert.equal(await initial,true);
  let resolve,reject,commits=0;const prepared=new Promise((res,rej)=>{resolve=res;reject=rej;});
  f.ctx.TLILanInference={prepareConversation:()=>prepared,annotateReply(){}};
  const loading=f.ctx.loadConversation('new','New');f.reply(1,[{role:'assistant',content:'New answer'}]);await tick();
  assert.equal(f.ctx.currentConversationId,'old');assert.equal(f.ctx.chatHistory[0].content,'Old answer');assert.equal(f.ctx.TLIConversationLoad.loading,true);
  if(outcome==='failure')reject(Error('Settings unavailable'));else{if(outcome==='draft')f.nodes['chat-input'].value='New draft';resolve(()=>{commits++;return true;});}
  assert.equal(await loading,outcome==='success');assert.equal(f.ctx.TLIConversationLoad.loading,false);
  assert.equal(f.ctx.currentConversationId,outcome==='success'?'new':'old');assert.equal(commits,outcome==='success'?1:0);
  assert.equal(f.ctx.chatHistory[0].content,outcome==='success'?'New answer':'Old answer');
});

function recentFixture(){
  const f=loaderFixture(),app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  function element(tag){
    const value={tag,children:[],handlers:{},textContent:'',append(...children){this.children.push(...children);},
      appendChild(child){this.children.push(child);},addEventListener(type,fn){this.handlers[type]=fn;}};
    let html='';Object.defineProperty(value,'innerHTML',{get:()=>html,set(text){html=text;value.children=[];}});return value;
  }
  f.nodes['recent-chats-list']=element('div');f.ctx.document.createElement=element;
  f.ctx.fetch=(url,options={})=>new Promise(resolve=>f.pending.push({url,options,resolve}));
  const start=app.indexOf('// ---------- recent chats ----------');
  vm.runInContext(app.slice(start,app.indexOf('async function loadConversation(',start)),f.ctx);
  return {...f,async emit(type){await Promise.all((f.events[type]||[]).map(fn=>fn()));},
    complete(index,{status=200,title='Current saved chat',invalid=false}={}){
      f.pending[index].resolve({ok:status===200,status,json:async()=>{
        if(invalid)throw Error('Invalid JSON');return{conversations:[{id:'saved-chat',title,message_count:2}]};
      }});
    },list:()=>f.nodes['recent-chats-list'],
  };
}

function clearAllFixture(){
  const f=loaderFixture(),app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),notes=[];let refreshes=0,confirms=0;
  const button={disabled:false,addEventListener(type,fn){this[type]=fn;}};f.nodes['recent-chats-clear']=button;
  f.ctx.sendBtn=f.nodes['chat-send-btn'];f.ctx.confirm=()=>{confirms++;return true;};f.ctx.showToast=text=>notes.push(text);
  f.ctx.loadPreviousPrompts=()=>{refreshes++;};
  const start=app.indexOf('// ── Recent chats buttons');
  vm.runInContext(app.slice(start,app.indexOf('// ── Voice input',start)),f.ctx);
  return {...f,button,notes,refreshes:()=>refreshes,confirms:()=>confirms,emit:type=>f.ctx.dispatchEvent(new CustomEvent(type))};
}

test('clear-all is blocked before verified access and no session recovery replays its write',async()=>{
  const f=clearAllFixture();f.emit('tli-session-locked');await f.button.click();f.emit('tli-session-unlocked');await f.button.click();
  assert.equal(f.pending.length,0);assert.equal(f.confirms(),0);f.emit('tli-private-observation-ready');assert.equal(f.pending.length,0);
  const clear=f.button.click();await f.button.click();assert.equal(f.pending.length,1);assert.equal(f.pending[0].url,'/api/ai/conversations');assert.equal(f.pending[0].options.method,'DELETE');
  f.pending[0].resolve({ok:true,status:200,json:async()=>({ok:true})});await clear;
  assert.equal(f.confirms(),1);assert.equal(f.refreshes(),1);assert.equal(f.button.disabled,false);
});

for(const phase of ['response','body'])test('old clear-all '+phase+' cannot erase a new session conversation or trigger another read',async()=>{
  const f=clearAllFixture();let load=f.ctx.loadConversation('old','Old');f.reply(0,[{role:'assistant',content:'Old answer'}]);await load;
  let release;const clear=f.button.click();
  if(phase==='body'){f.pending[1].resolve({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})});await tick();}
  for(const type of ['tli-account-changed','tli-session-unlocked','tli-private-observation-ready'])f.emit(type);
  f.nodes['chat-input'].value='New unsent draft';load=f.ctx.loadConversation('new','New');f.reply(2,[{role:'assistant',content:'New answer'}]);assert.equal(await load,true);
  if(phase==='body')release({ok:true});else f.pending[1].resolve({ok:true,status:200,json:()=>assert.fail('Stale clear response must not be decoded')});
  await clear;assert.equal(f.ctx.currentConversationId,'new');assert.equal(f.ctx.chatHistory[0].content,'New answer');assert.equal(f.nodes['chat-input'].value,'New unsent draft');
  assert.equal(f.refreshes(),0);assert.equal(f.pending.length,3);assert.deepEqual(f.notes,['Resumed: Old','Resumed: New']);assert.equal(f.button.disabled,false);
  assert.equal(f.pending.filter(request=>request.options.method==='DELETE').length,1);
});

for(const status of [401,403])test('clear-all denial '+status+' uses the current session guard without a denial body',async()=>{
  const f=clearAllFixture(),clear=f.button.click();f.pending[0].resolve({ok:false,status,json:()=>assert.fail('No denial body needed')});await clear;
  assert.equal(f.ctx.TLIConversationLoad.canRead(),false);assert.equal(f.refreshes(),0);assert.equal(f.button.disabled,false);
  f.emit('tli-session-unlocked');await f.button.click();f.emit('tli-private-observation-ready');assert.equal(f.pending.length,1);
});

test('recent chats recover once after confirmed private access without restoring a conversation',async()=>{
  const f=recentFixture();f.storage.set('tli_active_conv_id','previous-chat');
  const initial=f.ctx.loadPreviousPrompts();assert.equal(f.pending.length,1);
  await f.emit('tli-session-locked');f.complete(0,{status:401});await initial;
  assert.match(f.list().innerHTML,/Unlock TLI/);assert.equal(f.storage.has('tli_active_conv_id'),false);
  await f.emit('tli-private-observation-ready');assert.equal(f.pending.length,1,'Ready while locked is ignored');
  await f.emit('tli-session-unlocked');assert.equal(f.pending.length,1,'Bare unlock does not read private history');
  f.nodes['chat-input'].value='A new unsent question';
  const generation=f.ctx.TLIConversationLoad.generation;
  const recovered=f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2);
  await f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2,'Repeated readiness does not duplicate an in-flight read');
  f.complete(1);await recovered;
  assert.match(content(f.list()),/Current saved chat/);
  await f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2);
  assert.equal(f.ctx.TLIConversationLoad.generation,generation);
  assert.equal(f.nodes['chat-input'].value,'A new unsent question');assert.equal(f.ctx.currentConversationId,null);
  assert.equal(f.storage.has('tli_active_conv_id'),false);assert.equal(f.ctx.chatHistory.length,0);
  assert.ok(f.pending.every(request=>request.url==='/api/ai/conversations'&&!request.options.method));
});

for(const status of [200,401,403])test('old recent-chat response cannot replace recovery or relock its list: '+status,async()=>{
  const f=recentFixture(),old=f.ctx.loadPreviousPrompts();
  await f.emit('tli-session-locked');await f.emit('tli-session-unlocked');
  const recovered=f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2);
  f.complete(1,{title:'New session list'});await recovered;
  f.complete(0,{status,title:'Private stale list'});await old;
  assert.match(content(f.list()),/New session list/);assert.doesNotMatch(content(f.list()),/Private stale list/);
  await f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2);
});

for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide'])test('recent list clears on '+event+' and detached old buttons cannot navigate later',async()=>{
  const f=recentFixture(),opened=[];f.ctx.loadConversation=async(...args)=>opened.push(args);
  const loading=f.ctx.loadPreviousPrompts();f.complete(0,{title:'Old title'});await loading;const oldButton=f.list().children[0];
  await f.emit(event);assert.equal(f.list().children.length,0);assert.doesNotMatch(content(f.list()),/Old title/);
  await f.emit('tli-private-observation-ready');await f.ctx.loadPreviousPrompts();assert.equal(f.pending.length,1);
  await f.emit('tli-session-unlocked');await f.ctx.loadPreviousPrompts();assert.equal(f.pending.length,1);
  const recovered=f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2);f.complete(1,{title:'Current title'});await recovered;
  await oldButton.handlers.click();assert.equal(opened.length,0);assert.equal(f.pending.length,2);
  await f.list().children[0].handlers.click();assert.deepEqual(opened,[['saved-chat','Current title']]);
  const nowOld=f.list().children[0],refresh=f.ctx.loadPreviousPrompts();f.complete(2,{title:'Refreshed title'});await refresh;
  await nowOld.handlers.click();assert.equal(opened.length,1,'A superseded same-session list also retires its buttons');
  assert.ok(f.pending.every(request=>!request.options.method));
});

for(const status of [401,403])test('current recent-list denial '+status+' clears list and invalidates private read admission',async()=>{
  const f=recentFixture();let request=f.ctx.loadPreviousPrompts();f.complete(0);await request;
  request=f.ctx.loadPreviousPrompts();f.complete(1,{status,invalid:true});await request;
  assert.equal(f.list().children.length,0);assert.match(f.list().innerHTML,/Unlock TLI/);assert.equal(f.ctx.TLIConversationLoad.canRead(),false);
  await f.emit('tli-session-unlocked');await f.ctx.loadPreviousPrompts();assert.equal(f.pending.length,2);
  const recovery=f.emit('tli-private-observation-ready');f.complete(2);await recovery;assert.equal(f.list().children.length,1);assert.equal(f.ctx.currentConversationId,null);
});

for(const value of [{},{conversations:null},{conversations:[{id:'one',title:'Missing count'}]},{conversations:[{id:'same',title:'One',message_count:1},{id:'same',title:'Duplicate',message_count:2}]}])test('malformed recent list remains unavailable rather than empty success: '+JSON.stringify(value),async()=>{
  const f=recentFixture(),request=f.ctx.loadPreviousPrompts();f.pending[0].resolve({ok:true,status:200,json:async()=>value});await request;
  assert.match(f.list().innerHTML,/Could not load chats/);assert.doesNotMatch(f.list().innerHTML,/No chats yet/);assert.equal(f.pending.length,1);
});

test('recent list body cannot return private rows after a session change during decoding',async()=>{
  const f=recentFixture();let release;const old=f.ctx.loadPreviousPrompts();
  f.pending[0].resolve({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})});await tick();
  await f.emit('tli-session-locked');await f.emit('tli-session-unlocked');const recovery=f.emit('tli-private-observation-ready');f.complete(1,{title:'New current list'});await recovery;
  release({conversations:[{id:'old',title:'Private old list',message_count:2}]});await old;
  assert.match(content(f.list()),/New current list/);assert.doesNotMatch(content(f.list()),/Private old list/);assert.equal(f.ctx.TLIConversationLoad.canRead(),true);
});

test('a second lock clears the recovery list and prevents late private data from returning',async()=>{
  const f=recentFixture();await f.emit('tli-session-locked');await f.emit('tli-session-unlocked');
  const recovered=f.emit('tli-private-observation-ready');assert.equal(f.pending.length,1);
  await f.emit('tli-session-locked');f.complete(0,{title:'Private late list'});await recovered;
  assert.match(f.list().innerHTML,/Unlock TLI/);assert.equal(f.list().children.length,0);
  await f.emit('tli-private-observation-ready');assert.equal(f.pending.length,1);
});

test('failed startup list retries on guarded readiness, but healthy startup and navigation epochs stay unchanged',async()=>{
  const f=recentFixture(),first=f.ctx.loadPreviousPrompts();f.complete(0,{status:503});await first;
  assert.match(f.list().innerHTML,/Could not load chats/);
  const retry=f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2);
  f.complete(1);await retry;await f.emit('tli-private-observation-ready');assert.equal(f.pending.length,2);
  const next=f.ctx.loadPreviousPrompts();f.ctx.TLIConversationLoad.invalidate();
  f.complete(2,{title:'Late after navigation'});await next;
  assert.doesNotMatch(content(f.list()),/Late after navigation/);
  assert.match(f.list().innerHTML,/Refresh recent chats/);assert.doesNotMatch(f.list().innerHTML,/Loading/);
  const final=f.ctx.loadPreviousPrompts();assert.equal(f.pending.length,4,'Navigation invalidation releases the request slot');
  f.complete(3,{title:'Current after navigation'});await final;
  assert.match(content(f.list()),/Current after navigation/);
  const healthy=recentFixture(),loaded=healthy.ctx.loadPreviousPrompts();healthy.complete(0);await loaded;
  await healthy.emit('tli-private-observation-ready');assert.equal(healthy.pending.length,1);
});
