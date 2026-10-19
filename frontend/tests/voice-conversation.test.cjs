const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/voice-conversation.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({secure=true}={}){
 const ids={},events={},calls=[],timers=new Map(),instances=[],audioInstances=[],responses={};let sequence=0,mediaFactory=null,fetchFactory=null;
 const document={hidden:false,readyState:'complete'};
 function element(tag){
  const node={tag,children:[],handlers:{},attrs:{},value:'',disabled:false,hidden:false,selectedIndex:0,open:false,
   append(...children){for(const child of children){this.children.push(child);child.parentElement=this;}},replaceChildren(...children){this.children=[];this.append(...children);},
   insertAdjacentElement(_,child){this.parentElement.append(child);},setAttribute(key,value){this.attrs[key]=value;},getAttribute(key){return this.attrs[key];},
   addEventListener(event,handler){(this.handlers[event]||=[]).push(handler);},fire(event,payload={}){for(const handler of this.handlers[event]||[])handler({preventDefault(){},button:0,pointerId:1,...payload});},
   click(){if(!this.disabled)this.fire('click');},dispatchEvent(event){this.fire(event.type,event);},showModal(){this.open=true;},close(){this.open=false;},setPointerCapture(){}};
  Object.defineProperty(node,'id',{set(value){ids[value]=node;},get(){return Object.keys(ids).find(key=>ids[key]===node);}});
  Object.defineProperty(node,'firstChild',{get(){return this.children[0];}});
  return node;
 }
 document.body=element('body');document.createElement=element;document.getElementById=id=>ids[id];document.addEventListener=(event,fn)=>(events[event]||=[]).push(fn);
 for(const id of ['chat-input','chat-mic-btn','panel-main']){const node=element('div');node.id=id;document.body.append(node);}
 const emit=(event,payload={})=>{for(const fn of events[event]||[])fn(payload);};
 const window={isSecureContext:secure,addEventListener:(event,fn)=>(events[event]||=[]).push(fn),dispatchEvent:event=>{calls.push(['event',event.type,event.detail]);emit(event.type,event);return true;}};
 class MediaRecorder{static isTypeSupported(){return true;}constructor(stream,options){this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';instances.push(this);}start(){this.state='recording';calls.push(['record']);}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();}}
 class Audio{constructor(url){this.url=url;audioInstances.push(this);}async play(){calls.push(['play']);if(responses.play)return responses.play();}pause(){calls.push(['pause']);}}
 const track={stop(){calls.push(['track-stop']);}};
 const navigator={mediaDevices:{getUserMedia:async()=>{calls.push(['mic']);return mediaFactory?mediaFactory():{getTracks:()=>[track]};}}};
 const fetch=async(url,options={})=>{calls.push(['fetch',url,options]);if(fetchFactory){const result=fetchFactory(url,options);if(result)return result;}let value={};
  if(url.endsWith('/capabilities'))value={host_voice_supported:true,transcription_installed:true,settings:{model_path:'C:/model',port:8766},interfaces:['192.168.1.2']};
  if(url.endsWith('/devices'))value={devices:[]};
  if(url.endsWith('/transcribe'))value={text:'repair the game'};
  if(url.endsWith('/speak'))value=responses.speak || {clip_id:'clip',outcome:'ready',duration_seconds:1,capture_hold_seconds:11};
  if(url.endsWith('/announce'))value=responses.announce || {clip_id:'announcement',outcome:'accepted',duration_seconds:1,capture_hold_seconds:11};
  return{ok:true,json:async()=>value,blob:async()=>new Blob(['wav'])};};
 const context={window,document,navigator,MediaRecorder,Audio,fetch,Blob,FormData,AbortController,Event,
  CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail;}},crypto:{randomUUID:()=>`request-${++sequence}-0123456789`},
  URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:()=>calls.push(['revoke'])},setTimeout:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;},clearTimeout:id=>timers.delete(id),console};
 vm.runInNewContext(source,context);
 return{ids,calls,timers,instances,audioInstances,responses,window,document,emit,api:window.TLIVoice,mediaFactory:fn=>{mediaFactory=fn;},fetchFactory:fn=>{fetchFactory=fn;},async open(){this.api.open();await tick();},status:()=>ids['voice-conversation-status']?.textContent,
  requests:suffix=>calls.filter(call=>call[0]==='fetch'&&call[1].endsWith(suffix))};
}

test('opening host voice neither records nor starts media sharing',async()=>{const f=fixture();await f.open();f.api.setup();assert(!f.calls.some(x=>x[0]==='mic'));assert.equal(f.requests('/media/enable').length,0);assert.equal(f.ids['voice-conversation-talk'].disabled,false);});

test('insecure context refuses microphone capture',async()=>{const f=fixture({secure:false});await f.open();f.ids['voice-conversation-talk'].fire('pointerdown');await tick();assert(!f.calls.some(x=>x[0]==='mic'));assert.match(f.status(),/HTTPS/);});

test('hold to talk releases microphone and reviews transcription without sending',async()=>{const f=fixture();await f.open();f.ids['voice-conversation-talk'].fire('pointerdown');await tick();assert.equal(f.instances.length,1);assert([...f.timers.values()].some(timer=>timer.ms===30000));f.ids['voice-conversation-talk'].fire('pointerup');await tick();assert.equal(f.ids['voice-conversation-transcript'].value,'repair the game');assert(f.calls.some(x=>x[0]==='track-stop'));assert(!f.calls.some(x=>x[0]==='event'&&x[1]==='tli:voice-turn'));assert.equal(f.ids['chat-input'].value,'');});

test('release before microphone permission resolves discards late capture',async()=>{const f=fixture();await f.open();let resolve;f.mediaFactory(()=>new Promise(done=>{resolve=done;}));f.ids['voice-conversation-talk'].fire('pointerdown');f.ids['voice-conversation-talk'].fire('pointerup');resolve({getTracks:()=>[{stop:()=>f.calls.push(['late-stopped'])}]});await tick();assert(f.calls.some(x=>x[0]==='late-stopped'));assert.equal(f.instances.length,0);assert.equal(f.requests('/transcribe').length,0);});

test('reviewed send uses explicit callback and failure never speaks',async()=>{const f=fixture();await f.open();let detail;f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});f.ids['voice-conversation-transcript'].value='fix this';f.ids['voice-conversation-transcript'].fire('input');f.ids['voice-conversation-send'].click();assert.equal(detail.text,'fix this');detail.fail('interrupted');await tick();assert.equal(f.requests('/speak').length,0);assert.match(f.status(),/interrupted/);});

test('speech requests only saved run identity after completed callback, once',async()=>{const f=fixture();await f.open();let detail;f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});f.ids['voice-conversation-transcript'].value='hello';f.ids['voice-conversation-transcript'].fire('input');f.ids['voice-conversation-send'].click();await detail.complete('saved answer',{run_id:'owned-run'});await detail.complete('duplicate',{run_id:'owned-run'});assert.equal(f.requests('/speak').length,1);const body=JSON.parse(f.requests('/speak')[0][2].body);assert.equal(body.run_id,'owned-run');assert(!('text'in body));assert(f.calls.some(x=>x[0]==='play'));});

test('lock stops recording and rejects late completion',async()=>{const f=fixture();await f.open();let detail;f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});f.ids['voice-conversation-transcript'].value='private';f.ids['voice-conversation-transcript'].fire('input');f.ids['voice-conversation-send'].click();f.emit('tli-session-locked');await detail.complete('late answer',{run_id:'owned-run'});assert.equal(f.requests('/speak').length,0);assert.equal(f.ids['voice-conversation-dialog'].open,false);assert.equal(f.ids['voice-conversation-transcript'].value,'');assert(f.calls.some(x=>x[0]==='event'&&x[1]==='tli:voice-stop'));});

test('announcements require selected speaker and deliberate reviewed text send',async()=>{const f=fixture();await f.open();f.ids['voice-conversation-announcement'].value='Dinner is ready';f.ids['voice-conversation-announcement'].fire('input');assert.equal(f.ids['voice-conversation-announce'].disabled,true);f.ids['voice-conversation-speaker'].value='owned-speaker';f.ids['voice-conversation-speaker'].fire('change');assert.equal(f.requests('/announce').length,0);f.ids['voice-conversation-announce'].click();await tick();const body=JSON.parse(f.requests('/announce')[0][2].body);assert.equal(body.text,'Dinner is ready');assert.equal(body.speaker_id,'owned-speaker');assert(!('url' in body));assert.equal(f.requests('/speak').length,0);assert(!f.calls.some(x=>x[0]==='event'&&x[1]==='tli:voice-turn'));});

for(const terminal of ['onended','onerror'])test(`browser output blocks capture until ${terminal}`,async()=>{
 const f=fixture();await f.open();let detail;
 f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});
 f.ids['voice-conversation-transcript'].value='hello';f.ids['voice-conversation-transcript'].fire('input');f.ids['voice-conversation-send'].click();
 await detail.complete('saved answer',{run_id:'owned-run'});
 assert.equal(f.ids['voice-conversation-talk'].disabled,true);
 f.ids['voice-conversation-talk'].fire('pointerdown');await tick();assert.equal(f.calls.filter(x=>x[0]==='mic').length,0);
 f.audioInstances[0][terminal]();assert.equal(f.ids['voice-conversation-talk'].disabled,false);assert(f.calls.some(x=>x[0]==='revoke'));
});

test('Sonos acknowledgement gates capture for measured audio plus delivery grace',async()=>{
 const f=fixture();await f.open();let detail;
 f.responses.speak={outcome:'accepted',clip_id:'clip',duration_seconds:1,capture_hold_seconds:11};
 f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});
 f.ids['voice-conversation-speaker'].value='speaker';f.ids['voice-conversation-transcript'].value='hello';f.ids['voice-conversation-transcript'].fire('input');f.ids['voice-conversation-send'].click();
 await detail.complete('saved answer',{run_id:'owned-run'});assert.equal(f.ids['voice-conversation-talk'].disabled,true);
 f.ids['voice-conversation-talk'].fire('pointerdown');await tick();assert.equal(f.calls.filter(x=>x[0]==='mic').length,0);
 const timer=[...f.timers.values()].find(timer=>timer.ms===11000);assert(timer);timer.fn();assert.equal(f.ids['voice-conversation-talk'].disabled,false);assert.match(f.status(),/estimated/);
});

test('uncertain speaker output without timing requires Stop before capture',async()=>{
 const f=fixture();await f.open();f.responses.announce={outcome:'unknown',clip_id:'clip'};
 f.ids['voice-conversation-speaker'].value='speaker';f.ids['voice-conversation-announcement'].value='hello';f.ids['voice-conversation-announcement'].fire('input');f.ids['voice-conversation-announce'].click();await tick();
 assert.equal(f.ids['voice-conversation-talk'].disabled,true);assert.equal(f.timers.size,0);
 f.api.stop();assert.equal(f.ids['voice-conversation-talk'].disabled,false);assert.equal(f.requests('/cancel').length,1);
});

test('opt-in send on release serializes transcription, response and playback',async()=>{
 const f=fixture();await f.open();let detail;
 assert.equal(f.ids['voice-conversation-auto'].checked,false);f.ids['voice-conversation-auto'].checked=true;
 f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});
 f.ids['voice-conversation-talk'].fire('pointerdown');await tick();f.ids['voice-conversation-talk'].fire('pointerup');await tick();
 assert.equal(detail.text,'repair the game');assert.equal(f.calls.filter(x=>x[0]==='event'&&x[1]==='tli:voice-turn').length,1);
 assert.equal(f.ids['voice-conversation-talk'].disabled,true);assert.equal(f.requests('/speak').length,0);
 f.ids['voice-conversation-talk'].fire('pointerdown');await tick();assert.equal(f.calls.filter(x=>x[0]==='mic').length,1);
 await detail.complete('saved answer',{run_id:'owned-run'});assert.equal(f.ids['voice-conversation-talk'].disabled,true);
 f.audioInstances[0].onended();assert.equal(f.ids['voice-conversation-talk'].disabled,false);
 f.api.close();assert.equal(f.ids['voice-conversation-auto'].checked,false);
});

test('Stop rejects a late transcription even with send on release enabled',async()=>{
 const f=fixture();await f.open();let resolve;
 f.fetchFactory(url=>url.endsWith('/transcribe')?new Promise(done=>{resolve=done;}):null);
 f.ids['voice-conversation-auto'].checked=true;f.ids['voice-conversation-talk'].fire('pointerdown');await tick();f.ids['voice-conversation-talk'].fire('pointerup');await tick();
 assert(resolve);f.api.stop();resolve({ok:true,json:async()=>({text:'late private instruction'})});await tick();
 assert(!f.calls.some(x=>x[0]==='event'&&x[1]==='tli:voice-turn'));assert.equal(f.ids['voice-conversation-transcript'].value,'');assert.equal(f.requests('/speak').length,0);
});

test('blocked autoplay keeps capture gated until an explicit Stop',async()=>{
 const f=fixture();await f.open();let detail;f.responses.play=()=>{throw new Error('gesture needed');};
 f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});
 f.ids['voice-conversation-transcript'].value='hello';f.ids['voice-conversation-transcript'].fire('input');f.ids['voice-conversation-send'].click();
 await detail.complete('saved answer',{run_id:'owned-run'});assert.equal(f.ids['voice-conversation-talk'].disabled,true);assert.equal(f.ids['voice-conversation-play'].hidden,false);
 f.api.stop();assert.equal(f.ids['voice-conversation-talk'].disabled,false);assert.equal(f.ids['voice-conversation-play'].hidden,true);
});

test('late playback rejection after Stop cannot restore a stale playback control',async()=>{
 const f=fixture();await f.open();let detail,reject;
 f.responses.play=()=>new Promise((resolve,fail)=>{reject=fail;});
 f.window.addEventListener('tli:voice-turn',e=>{detail=e.detail;detail.handled=true;});
 f.ids['voice-conversation-transcript'].value='hello';f.ids['voice-conversation-transcript'].fire('input');f.ids['voice-conversation-send'].click();
 const completed=detail.complete('saved answer',{run_id:'owned-run'});await tick();assert(reject);f.api.stop();reject(new Error('late'));await completed;
 assert.equal(f.ids['voice-conversation-play'].hidden,true);assert.equal(f.ids['voice-conversation-talk'].disabled,false);assert.match(f.status(),/Voice stopped/);
});
