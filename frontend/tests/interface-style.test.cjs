const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/interface-style.js'),'utf8');
function fixture({stored=null,readFailure=false,writeFailure=false,loading=false}={}) {
 const events=[],writes=[],windowListeners={},documentListeners={},queued=[];
 const attrs=new Map(),root={dataset:{theme:'midnight'}}, nodes={};
 const handlers=()=>({listeners:{},addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);},emit(type){for(const fn of this.listeners[type]||[])fn({target:this});}});
 const control=value=>Object.assign(handlers(),{value,checked:false,isConnected:true,selectionStart:null,getClientRects:()=>[{}],focus(){document.activeElement=this;},setSelectionRange(a,b,d){this.selectionStart=a;this.selectionEnd=b;this.selectionDirection=d;}});
 const select=nodes['tli-interface-select']=control(''),radios=[control('modern'),control('classic')];
 nodes['tli-interface-status']={textContent:''};nodes['tli-interface-notice']={textContent:''};
 const groups=[true,false,false].map((open,index)=>{
  const group={open,index,current:false,children:[],contains(el){return this.children.includes(el);},querySelector(selector){return selector==='summary'?summary:selector==='[aria-current="page"]'&&this.current?{}:null;}};
  const summary={getAttribute:key=>attrs.get(index+key)??null,setAttribute:(key,value)=>attrs.set(index+key,String(value)),removeAttribute:key=>attrs.delete(index+key),matches:()=>true,closest:()=>summary};group.summary=summary;return group;
 });
 const scrolls=[];
 const document={readyState:loading?'loading':'complete',documentElement:root,body:{},activeElement:null,getElementById:id=>nodes[id]||null,querySelectorAll(selector){if(selector==='input[name="tli-interface-style"]')return radios;if(selector==='.sidebar .tli-nav-group')return groups;if(selector==='.main-scroll, .sidebar, #chat-output, #chat-history-list')return scrolls;throw new Error('Unexpected selector: '+selector);},addEventListener(type,fn){(documentListeners[type]||=[]).push(fn);}};document.activeElement=document.body;
 const window={addEventListener(type,fn){(windowListeners[type]||=[]).push(fn);},dispatchEvent(event){events.push(event);for(const fn of windowListeners[event.type]||[])fn(event);return true;},location:{reload:()=>assert.fail('No reload'),assign:()=>assert.fail('No navigation')}};
 const storage=new Map(stored===null?[]:[['tli_interface_style',stored]]);storage.set('tli_settings','{"defaultTheme":"midnight"}');
 const ctx=vm.createContext({window,document,localStorage:{getItem(key){if(readFailure)throw Error('unavailable');return storage.get(key)||null;},setItem(key,value){if(writeFailure)throw Error('unavailable');writes.push([key,value]);storage.set(key,value);}},CustomEvent:class{constructor(type,{detail}={}){this.type=type;this.detail=detail;}},queueMicrotask:fn=>queued.push(fn),fetch:()=>assert.fail('No network'),XMLHttpRequest:class{constructor(){assert.fail('No network');}},setInterval:()=>assert.fail('No polling')});
 vm.runInContext(source,ctx);
 return {api:window.TLIInterface,root,select,radios,nodes,groups,scrolls,events,writes,storage,document,window,control,loaded(){for(const fn of documentListeners.DOMContentLoaded||[])fn();while(queued.length)queued.shift()();},dispatch(type,event){for(const fn of documentListeners[type]||[])fn(event);},failWrites(value=true){writeFailure=value;}};
}
test('early preference applies before DOM readiness without rewriting theme settings or firing actions',()=>{
 const f=fixture({stored:'classic',loading:true});assert.equal(f.api.get(),'classic');assert.equal(f.root.dataset.interface,'classic');assert.equal(f.root.dataset.theme,'midnight');assert.equal(f.writes.length,0);assert.equal(f.events.length,0);f.loaded();assert.equal(f.select.value,'classic');assert.equal(f.radios[1].checked,true);assert.match(f.nodes['tli-interface-status'].textContent,/Classic UI.*Saved/);assert.equal(f.writes.length,0);
});
test('missing and invalid saved values default to Modern without saving a replacement',()=>{
 for(const stored of [null,'','CLASSIC','<script>','classicTli','false']){const f=fixture({stored});assert.equal(f.api.get(),'modern');assert.equal(f.writes.length,0);assert.equal(f.root.dataset.theme,'midnight');}
});
test('persisted Classic reconciles navigation constructed after the early head controller initialized',()=>{
 const f=fixture({stored:'classic'});const later=f.groups.splice(0);for(const group of later){group.open=false;group.summary.removeAttribute('aria-disabled');}f.groups.push(...later);f.window.dispatchEvent({type:'tli:ui-ready'});assert.ok(f.groups.every(g=>g.open));assert.ok(f.groups.every(g=>g.summary.getAttribute('aria-disabled')==='true'));assert.equal(f.writes.length,0);
});
test('invalid values cannot change a layout, persist a value, or dispatch events',()=>{
 const f=fixture();for(const value of [null,undefined,{},1,'classicTli','<img>'])assert.equal(f.api.set(value),false);assert.equal(f.api.get(),'modern');assert.deepEqual(f.writes,[]);assert.deepEqual(f.events,[]);
});
test('one genuine switch dispatches one exact presentation event and keeps unrelated storage unchanged',()=>{
 const f=fixture();assert.equal(f.api.set('classic'),true);assert.equal(f.api.get(),'classic');assert.equal(f.select.value,'classic');assert.deepEqual(f.radios.map(r=>r.checked),[false,true]);assert.deepEqual(JSON.parse(JSON.stringify(f.events)),[{type:'tli:interface-change',detail:{interface:'classic'}}]);assert.deepEqual(f.writes,[['tli_interface_style','classic']]);assert.equal(f.storage.get('tli_settings'),'{"defaultTheme":"midnight"}');f.api.set('classic');assert.equal(f.events.length,1);
});
test('header and checked settings radio use the same controller and synchronize in both directions',()=>{
 const f=fixture();f.select.value='classic';f.select.emit('change');assert.equal(f.api.get(),'classic');f.radios[0].checked=true;f.radios[0].emit('change');assert.equal(f.api.get(),'modern');assert.equal(f.select.value,'modern');f.radios[1].checked=false;f.radios[1].emit('change');assert.equal(f.api.get(),'modern');assert.equal(f.events.length,2);
});
test('storage read and write failures retain usable in-page controls with truthful persistence feedback',()=>{
 const f=fixture({stored:'classic',readFailure:true,writeFailure:true});assert.equal(f.api.get(),'modern');assert.match(f.nodes['tli-interface-status'].textContent,/Applied for this page.*storage is unavailable/);f.api.set('classic');assert.equal(f.api.get(),'classic');assert.equal(f.select.value,'classic');assert.match(f.nodes['tli-interface-notice'].textContent,/may not survive a reload/);assert.doesNotMatch(f.nodes['tli-interface-notice'].textContent,/Saved in this browser/);f.failWrites(false);f.api.set('classic');assert.match(f.nodes['tli-interface-status'].textContent,/Saved in this browser/);
});
test('Classic expands existing nav groups while Modern restores collapsed state and keeps the active route visible',()=>{
 const f=fixture();f.groups[1].summary.setAttribute('tabindex','2');f.api.set('classic');assert.ok(f.groups.every(g=>g.open));assert.ok(f.groups.every(g=>g.summary.getAttribute('aria-disabled')==='true'));f.groups[2].current=true;f.api.set('modern');assert.deepEqual(f.groups.map(g=>g.open),[true,false,true]);assert.equal(f.groups[1].summary.getAttribute('tabindex'),'2');assert.equal(f.groups[0].summary.getAttribute('tabindex'),null);assert.equal(f.groups[1].summary.getAttribute('aria-disabled'),null);
});
test('a focused navigation item is never hidden by restoring Modern collapsed groups',()=>{
 const f=fixture(),item=f.control('draft');f.api.set('classic');f.groups[1].children.push(item);f.document.activeElement=item;f.api.set('modern');assert.equal(f.groups[1].open,true);assert.equal(f.document.activeElement,item);
});
test('same focused input and selection restore after a presentation owner moves its containing node',()=>{
 const f=fixture(),input=f.control('draft remains');input.setSelectionRange(2,8,'backward');f.document.activeElement=input;f.window.addEventListener('tli:interface-change',()=>{f.document.activeElement=f.document.body;input.setSelectionRange(0,0,'forward');});f.api.set('classic');assert.equal(f.document.activeElement,input);assert.equal(input.value,'draft remains');assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection],[2,8,'backward']);
});
test('chat reader anchor is preserved while changed geometry adjusts the existing scroll container',()=>{
 const f=fixture();let anchorTop=40;const anchor={getBoundingClientRect:()=>({top:anchorTop,height:10}),getClientRects:()=>[{}]};const scroller={id:'chat-output',children:[anchor],scrollTop:120,scrollLeft:3,scrollHeight:1000,clientHeight:200,matches:()=>false,getBoundingClientRect:()=>({top:0,bottom:200})};f.scrolls.push(scroller);f.window.addEventListener('tli:interface-change',()=>{anchorTop=75;});f.api.set('classic');assert.equal(scroller.scrollTop,155);assert.equal(scroller.scrollLeft,3);
});
test('a reader following the current reply remains at the end of the same chat output',()=>{
 const f=fixture(),scroller={id:'chat-output',children:[],scrollTop:800,scrollLeft:0,scrollHeight:1000,clientHeight:200,matches:()=>false,getBoundingClientRect:()=>({top:0,bottom:200})};f.scrolls.push(scroller);f.window.addEventListener('tli:interface-change',()=>scroller.scrollHeight=1200);f.api.set('classic');assert.equal(scroller.scrollTop,1200);
});
test('preventing Classic group collapse never handles unrelated feature buttons or keys',()=>{
 const f=fixture();f.api.set('classic');let prevented=0;f.dispatch('click',{target:{closest:()=>null},preventDefault(){prevented++;}});f.dispatch('keydown',{key:'x',target:{matches:()=>true},preventDefault(){prevented++;}});assert.equal(prevented,0);f.dispatch('click',{target:f.groups[0].summary,preventDefault(){prevented++;}});assert.equal(prevented,1);f.api.set('modern');f.dispatch('click',{target:f.groups[0].summary,preventDefault(){prevented++;}});assert.equal(prevented,1);
});
