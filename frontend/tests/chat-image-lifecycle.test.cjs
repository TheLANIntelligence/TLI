const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Exercise the real attachment controller; browser APIs are local, deferred fakes.
function fixture() {
  const nodes = {}, readers = [], images = [], notices = [], attachments = [], tasks = [], timers = new Map(), events = {};
  let timerId = 0, epoch = 0, locked = false;
  for (const id of ['chat-send-btn','chat-input','new-chat-btn','abort-chat-btn','chat-attach-btn','chat-image-input','chat-image-preview','chat-image-thumb','chat-image-remove']) {
    const classes = new Set(id === 'chat-image-preview' ? ['hidden'] : []);
    nodes[id] = {value: '', src: '', files: [], handlers: {}, disabled: false,
      classList: {add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},
      addEventListener(k,fn){(this.handlers[k] ||= []).push(fn);},
      fire(k,e={}){for(const fn of this.handlers[k] || []) fn(e);}, click(){this.fire('click');}};
  }
  const ctx = vm.createContext({console, Uint8Array, atob,
    $: id=>nodes[id], document: {getElementById:id=>nodes[id]},
    setTimeout: fn=>{timers.set(++timerId, fn); return timerId;}, clearTimeout: id=>timers.delete(id),
    showToast: (text)=>notices.push(text),
    window: {addEventListener:(type,fn)=>(events[type]||=[]).push(fn),TLIConversationLoad:{deleted(){}}, TLIIntelligence:{capture:()=>epoch,isCurrent:t=>!locked && t===epoch},
      TLIScreenshots:{chooseImage(){},prepareTask:task=>tasks.push(task),attachmentReadStarted:()=>tasks.at(-1),attachmentReadFailed(){},attachmentChanged:(file,task)=>attachments.push({file,task})}},
    FileReader: class {constructor(){readers.push(this);this.readyState=0;} readAsDataURL(file){this.file=file;this.readyState=1;} abort(){this.readyState=2;this.aborted=true;this.onabort?.();}},
    Image: class {constructor(){images.push(this);} set src(value){this.url=value;} get src(){return this.url;}}
  });
  const start = source.indexOf('let _chatImageB64 = null;');
  const end = source.indexOf('  // Wire no-AI banner action button', start);
  vm.runInContext(source.slice(start, end) + '\n}\nsetupChat();', ctx);
  const clear = source.indexOf('function clearLocalChatSession()');
  const clearEnd = source.indexOf('let meshDirectoryCache =', clear);
  assert.ok(clear >= 0 && clearEnd > clear, 'real chat lifecycle handler block');
  vm.runInContext(source.slice(clear, clearEnd),ctx);
  const data = id=>'data:image/png;base64,'+Buffer.from(id).toString('base64');
  function complete(reader, id='synthetic', {width=20,height=20,corrupt=false}={}) {
    const count=images.length; reader.readyState=2; reader.onload({target:{result:data(id)}});
    if(images.length>count) {const image=images.at(-1);image.naturalWidth=width;image.naturalHeight=height;if(corrupt)image.onerror?.();else image.onload?.();}
  }
  function pick(file={name:'screen.png',type:'image/png',size:50}) {nodes['chat-image-input'].click();nodes['chat-image-input'].files=[file];nodes['chat-image-input'].fire('change');return readers.at(-1);}
  const state=()=>JSON.parse(vm.runInContext('JSON.stringify({b64:_chatImageB64,mime:_chatImageMime,reading:_chatImageReading})',ctx));
  return {ctx,nodes,readers,images,notices,attachments,tasks,timers,pick,complete,state,data,
    lock(type='tli-session-locked'){locked=true;epoch++;for(const fn of events[type]||[])fn();},unlock(){locked=false;epoch++;for(const fn of events['tli-session-unlocked']||[])fn();},changeContext(){epoch++;}};
}

test('invalid replacement preserves the existing image, guidance and text draft',()=>{
  const f=fixture();f.complete(f.pick(),'first');f.nodes['chat-input'].value='Keep my question';
  const previous=f.state(), count=f.attachments.length;
  f.pick({name:'too-large.png',type:'image/png',size:6*1024*1024+1});
  assert.equal(f.state().b64,previous.b64);assert.equal(f.attachments.length,count);
  assert.equal(f.nodes['chat-input'].value,'Keep my question');assert.match(f.notices.at(-1),/6 MB/);
});
test('a failed replacement read retains the last preview and may be retried explicitly',()=>{
  const f=fixture();f.complete(f.pick(),'first');const previous=f.state().b64;
  const reader=f.pick();reader.onerror();assert.equal(f.state().b64,previous);assert.equal(f.state().reading,false);
  f.complete(f.pick(),'retry');assert.notEqual(f.state().b64,previous);
});
test('lock erases the attachment and invalidates a pending replacement',()=>{
  const f=fixture();f.complete(f.pick(),'first');const late=f.pick();f.lock();
  assert.equal(f.state().b64,null);assert.equal(f.nodes['chat-image-thumb'].src,'');
  f.complete(late,'late');assert.equal(f.state().b64,null);assert.equal(f.nodes['chat-image-preview'].classList.contains('hidden'),true);
});

for(const event of ['tli-account-changed','tli-user-changed','pagehide'])test(event+' also erases the private attachment and retires its pending decoder',()=>{
  const f=fixture();f.complete(f.pick(),'private');const pending=f.pick();f.nodes['chat-input'].value='Private text';f.lock(event);
  assert.equal(f.state().b64,null);assert.equal(f.nodes['chat-image-thumb'].src,'');assert.equal(f.nodes['chat-input'].value,'');
  f.unlock();f.complete(pending,'stale');assert.equal(f.state().b64,null);
});
test('corrupt images and excessive decoded dimensions cannot replace a valid preview',()=>{
  for(const options of [{corrupt:true},{width:8000,height:8000}]) {
    const f=fixture();f.complete(f.pick(),'first');const previous=f.state().b64;
    f.complete(f.pick(),'bad',options);assert.equal(f.state().b64,previous);assert.equal(f.state().reading,false);
  }
});
test('explicit image paste prepares screenshot guidance without sending or replacing the question',()=>{
  const f=fixture();f.nodes['chat-input'].value='Where do I click next?';let prevented=false;
  f.nodes['chat-input'].fire('paste',{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>({name:'paste.png',type:'image/png',size:20})}]},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(f.readers.length,1);f.complete(f.readers[0]);
  assert.equal(f.nodes['chat-input'].value,'Where do I click next?');assert.equal(f.attachments.at(-1).task,'explain');
});
test('plain-text paste remains native text input',()=>{
  const f=fixture();f.nodes['chat-input'].fire('paste',{clipboardData:{items:[{kind:'string',type:'text/plain'}]},preventDefault:()=>assert.fail('Text paste was intercepted')});
  assert.equal(f.readers.length,0);
});
test('replaced and removed readers cannot repopulate the attachment',()=>{
  const f=fixture(), first=f.pick(), second=f.pick();f.complete(second,'second');f.complete(first,'first');
  assert.equal(f.nodes['chat-image-thumb'].src,f.data('second'));
  const pending=f.pick();f.nodes['chat-image-remove'].click();f.complete(pending,'removed');assert.equal(f.state().b64,null);
});
test('a blocked local read stops waiting without discarding the previous attachment',()=>{
  const f=fixture();f.complete(f.pick(),'first');const previous=f.state().b64;f.pick();
  assert.equal(f.timers.size,1);for(const timer of [...f.timers.values()])timer();
  assert.equal(f.state().reading,false);assert.equal(f.state().b64,previous);assert.match(f.notices.at(-1),/try again/i);
});
test('conversation context changes during read release the Send guard',()=>{
  for(const finish of ['load','timeout']) {
    const f=fixture();f.complete(f.pick(),'first');const previous=f.state().b64, pending=f.pick();f.changeContext();
    if(finish==='load')f.complete(pending,'late');else for(const timer of [...f.timers.values()])timer();
    assert.equal(f.state().reading,false);assert.equal(f.state().b64,previous);assert.equal(f.timers.size,0);
  }
});
test('returning from a picker opened before lock cannot attach into the next session',()=>{
  const f=fixture();f.nodes['chat-image-input'].click();f.lock();f.unlock();
  f.nodes['chat-image-input'].files=[{name:'old-session.png',type:'image/png',size:50}];f.nodes['chat-image-input'].fire('change');
  assert.equal(f.readers.length,0);assert.equal(f.state().b64,null);
  f.complete(f.pick(),'explicit-new-session');assert.ok(f.state().b64);
});
test('lock and timeout detach a pending local decoder and its image data',()=>{
  for(const finish of ['lock','timeout']) {
    const f=fixture(), reader=f.pick();reader.readyState=2;reader.onload({target:{result:f.data('pending-decode')}});const image=f.images.at(-1);
    if(finish==='lock')f.lock();else for(const timer of [...f.timers.values()])timer();
    assert.equal(image.src,'');assert.equal(image.onload,null);assert.equal(image.onerror,null);assert.equal(f.state().reading,false);
  }
});
test('unsupported clipboard image does not swallow available plain text',()=>{
  const f=fixture();f.nodes['chat-input'].fire('paste',{clipboardData:{getData:()=> 'The exact error message',items:[{kind:'file',type:'image/webp'}]},preventDefault:()=>assert.fail('Mixed plain text was intercepted')});
  assert.equal(f.readers.length,0);
});
