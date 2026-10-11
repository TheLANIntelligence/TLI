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
  const ctx=vm.createContext({console,Date,URL,Set,Map,
    setTimeout:fn=>timers.push(fn),localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    document:{readyState:'complete',createElement:element,getElementById:id=>nodes[id]||null,addEventListener:(key,fn)=>(docEvents[key]||=[]).push(fn)},
    window:{addEventListener:(key,fn)=>(events[key]||=[]).push(fn),loadConversation:async(...args)=>{opened.push(args);return true;},TLIConversationLoad:{invalidate(){ctx.invalidated=(ctx.invalidated||0)+1;},deleted:id=>deleted.push(id)}},
    fetch:async(url,options={})=>{
      calls.push({url,options});let result=handler?await handler(url,options):undefined;
      if(result===undefined)result=url===base+'/capabilities'?{ok:true,protocol}:url==='/api/ai/conversations'?{conversations:[item()]}:page();
      return {ok:!result.status||result.status===200,status:result.status||200,json:async()=>{if(result.invalidJson)throw Error('Invalid JSON');return result.body||result;}};
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

for(const capability of [{status:404,body:{detail:'Not found'}},{ok:true,protocol:'old'},{unexpected:true}]){
  test('Old or malformed capability uses explicit recent-only fallback '+JSON.stringify(capability),async()=>{
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

test('Expired authentication clears earlier results even when the denial body is unreadable',async()=>{
  const f=fixture();await f.api.open();assert.equal(f.nodes['chat-history-list'].children.length,1);
  f.handler(()=>({status:401,invalidJson:true}));await f.api.refresh();
  assert.equal(f.calls.length,3);assert.equal(f.nodes['chat-history-list'].children.length,0);
  assert.equal(f.nodes['conversation-search-submit'].disabled,false);
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
    assert.equal(f.nodes['chat-history-list'].children.length,0);assert.equal(f.nodes['conversation-search-submit'].disabled,false);
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
  const ctx=vm.createContext({console,Date,Map,setTimeout(){},$:id=>nodes[id],
    document:{readyState:'complete',getElementById:id=>nodes[id],addEventListener(){}},
    addEventListener:(key,fn)=>(events[key]||=[]).push(fn),
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetch:url=>new Promise(resolve=>pending.push({url,resolve})),
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
