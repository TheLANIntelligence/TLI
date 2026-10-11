const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = 'C:\\Users\\demo\\Downloads';

function fixture() {
  const nodes = {}, events = {}, navigation = [], space = [], messages = [], calls = [];
  let host = 'host-one';
  function node(tag = 'div') {
    return {tag,children:[],value:'',textContent:'',style:{},handlers:{},dataset:{},attributes:{},
      classList:{remove(){},toggle(){}},
      set id(value){this._id=value;nodes[value]=this;},get id(){return this._id;},
      append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}},
      appendChild(item){this.append(item);return item;},replaceChildren(...items){this.children=[];this.append(...items);},
      remove(){if(this.id)delete nodes[this.id];if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(item=>item!==this);},
      setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name];},
      addEventListener(name,handler){(this.handlers[name] ||= []).push(handler);},
      querySelector(){return null;},focus(){},scrollIntoView(){},
      async click(){for(const handler of this.handlers.click||[])await handler({target:this});}};
  }
  for(const id of ['panel-files','panel-visualizer','files-prepare','filesRootInput','filesStatus','filesBucketsContainer','filesExtTableBody']){const element=node();element.id=id;}
  nodes.filesRootInput.value=root;nodes['panel-files'].append(nodes['files-prepare'],nodes.filesStatus);
  const document={readyState:'loading',getElementById:id=>nodes[id]||null,createElement:node,querySelectorAll:()=>[],addEventListener(){}};
  const window={addEventListener:(name,handler)=>(events[name] ||= []).push(handler),localStorage:{getItem(){return null;},setItem(){}},
    TLIHostIdentity:{get:()=>({id:host})},TLIFreeSpace:{prepare:value=>{space.push(value);return true;}}};
  const ctx=vm.createContext({window,document,console,Date,$:id=>nodes[id]||null,debugLog(){},showToast:text=>messages.push(text),
    switchPanel:id=>navigation.push(id),fetch:async(...args)=>{calls.push(args);throw new Error('No host requests are allowed in this fixture');}});
  for(const file of ['files.js','storage-workspace.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'),ctx);
  ctx.setupFilesPanel();
  vm.runInContext(`filesLastScanRoot=${JSON.stringify(root)};filesLastScanBuckets={buckets:{Documents:['one.txt']}};filesSelectedNames=new Set(['one.txt']);filesBucketDestinations={Documents:'Documents'};`,ctx);
  return {ctx,window,nodes,navigation,space,messages,calls,setHost:value=>host=value,dispatch:async name=>{for(const handler of events[name]||[])await handler();}};
}

test('shared preparation navigates both views without launching scans or operations',()=>{
  const f=fixture();const api=f.window.TLIStorageWorkspace;
  assert.equal(api.prepare({view:'space',root,source:'saved-place'}).status,'prepared');
  assert.equal(api.prepare({view:'organize',root,source:'dashboard'}).status,'prepared');
  assert.deepEqual(f.navigation,['panel-visualizer','panel-files']);assert.deepEqual(f.space,[root]);assert.equal(f.calls.length,0);
  assert.equal(f.ctx.filesDescribeDraft().selectedCount,1);
});

test('a different folder offers a pending handoff and leaves the current draft intact',async()=>{
  const f=fixture();const api=f.window.TLIStorageWorkspace;
  assert.equal(api.prepare({view:'organize',root:'C:\\Other',candidatePaths:['C:\\Other\\a.txt']}).status,'draft-conflict');
  assert.equal(f.nodes.filesRootInput.value,root);assert.equal(f.ctx.filesDescribeDraft().selectedCount,1);
  await f.nodes['storage-keep-draft'].click();assert.equal(f.nodes['storage-folder-handoff'],undefined);assert.equal(f.nodes.filesRootInput.value,root);
  api.prepare({view:'organize',root:'C:\\Other'});await f.nodes['storage-use-folder'].click();
  assert.equal(f.nodes.filesRootInput.value,'C:\\Other');assert.equal(f.ctx.filesDescribeDraft().scannedRoot,root);
  assert.equal(f.ctx.filesDescribeDraft().selectedCount,1);assert.equal(f.calls.length,0);
});

test('malformed, oversized and wrong-host handoffs cannot overwrite draft or navigate',()=>{
  const f=fixture();for(const value of [null,{view:'wrong',root},{view:'organize',root:'x\nsecret'},
    {view:'organize',root,hostId:'host-two'}, {view:'organize',root,candidatePaths:Array(501).fill(root+'\\one.txt')},
    {view:'organize',root,observation:{coverage:{}}}])assert.equal(f.window.TLIStorageWorkspace.prepare(value).status,'unavailable');
  assert.equal(f.navigation.length,0);assert.equal(f.nodes.filesRootInput.value,root);assert.equal(f.calls.length,0);
});

test('host changes after a pending handoff prevent using its old location',async()=>{
  const f=fixture();f.window.TLIStorageWorkspace.prepare({view:'organize',root:'C:\\Other',hostId:'host-one'});
  f.setHost('host-two');await f.nodes['storage-use-folder'].click();assert.equal(f.nodes.filesRootInput.value,root);assert.equal(f.calls.length,0);
});

test('lock clears pending context and detached confirmation cannot repopulate it',async()=>{
  const f=fixture();f.window.TLIStorageWorkspace.prepare({view:'organize',root:'C:\\Other'});const use=f.nodes['storage-use-folder'];
  await f.dispatch('tli-session-locked');await use.click();assert.equal(f.nodes.filesRootInput.value,'');assert.equal(f.nodes['storage-folder-handoff'],undefined);
  assert.equal(f.window.TLIStorageWorkspace.prepare({view:'space',root}).status,'unavailable');assert.equal(f.calls.length,0);
});

test('Free Space hands the selected file, host and observation to the coordinator without another request',async()=>{
  const {fixture:spaceFixture,job,envelope,scan,root:spaceRoot}=require('./helpers/free-space-fixture.cjs');
  const f=spaceFixture(async url=>url.endsWith('/results')?envelope(job(),scan()):envelope(job()));
  const handoffs=[];f.window.TLIStorageWorkspace={prepare:intent=>{handoffs.push(intent);return{status:'draft-conflict'};}};
  f.api.prepare(spaceRoot);await f.api.start();
  await f.nodes.visualizerTableBody.children[0].children[0].children[0].click();await f.nodes.visualizerSendToFilesBtn.click();
  await f.nodes['fs-handoff-confirm'].click();assert.equal(handoffs.length,1);const intent=handoffs[0];
  assert.equal(intent.view,'organize');assert.equal(intent.root,spaceRoot);assert.equal(intent.hostId,'fixture-host');
  assert.deepEqual(Array.from(intent.candidatePaths),[spaceRoot+'\\a.txt']);assert.equal(intent.observation.id,'a'.repeat(32));
  assert.equal(f.calls.length,2);assert.equal(f.nodes['fs-handoff'].open,false);
});
