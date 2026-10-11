const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/mesh.js'), 'utf8');
function fixture(failNode, failDirectory, service = true) {
  const previous = {node_id:'preserved-id', role:'host'}, oldDirectory={devices:[{id:'a'}]}, rendered=[], messages=[];
  const context = vm.createContext({window:{},meshUiLocked:false,meshUiEpoch:0,meshUiCurrent:()=>true,document:{hidden:false}, currentNodeConfig:previous, meshDirectoryCache:oldDirectory,
    console:{error(){}}, $:()=>({textContent:''}), setInlineStatus: (...args)=>messages.push(args), showToast(){}, debugLog(){}, syncMeshContextTags(){},
    renderMeshNode: data=>rendered.push(data), renderMeshDirectory: data=>rendered.push(data),
    fetch: async url=>({ok:!failDirectory&&(!failNode||url!='/mesh/node'),status:503,json:async()=>url==='/mesh/node'?previous:oldDirectory})
  });
  if(service) context.window.MeshService={fetchNode:async()=>{if(failNode)throw new Error('HTTP 503');return previous;},fetchDirectory:async()=>{if(failDirectory)throw new Error("HTTP 503");return oldDirectory;}};
  const first=source.indexOf('async function refreshMeshDirectory()');
  const last=source.indexOf('\n}',source.indexOf('async function refreshMeshNodeAndMaybeDirectory()'))+2;
  vm.runInContext(source.slice(first,last),context);
  return {context, previous, oldDirectory, rendered, messages};
}
test('background computer refresh resolves failure and retains identity instead of rendering unconfigured',async()=>{
  for(const service of [true,false]){
    const f=fixture(true,false,service);
    assert.equal(await f.context.refreshMeshNodeAndMaybeDirectory(),false);
    assert.equal(f.context.currentNodeConfig,f.previous);
    assert.equal(f.rendered.length,0);
    assert.match(f.messages[0][1],/unavailable.*retained/);
  }
});
test('failed directory refresh preserves prior entries and cannot report complete refresh success',async()=>{
  const f=fixture(false,true);
  assert.equal(await f.context.refreshMeshNodeAndMaybeDirectory(),false);
  assert.equal(f.context.meshDirectoryCache,f.oldDirectory);
  assert.deepEqual(f.rendered,[f.previous]);
});
test('successful computer refresh still updates node and directory',async()=>{
  const f=fixture(false,false);
  assert.equal(await f.context.refreshMeshNodeAndMaybeDirectory(),true);
  assert.deepEqual(f.rendered,[f.previous,f.oldDirectory]);
});
