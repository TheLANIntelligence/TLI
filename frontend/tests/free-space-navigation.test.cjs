const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const navigation=source.slice(source.indexOf('function switchPanelAndScan('),source.indexOf('function openPanelFromQuery('));
const dashboard=source.slice(source.indexOf('  function _openStorage('),source.indexOf('  // ── Vitals'));
function fixture(controller=true){
 const calls=[],input={value:'Previous draft',focus(){calls.push(['focus']);},dispatchEvent(e){calls.push(['input',e.type]);},click(){assert.fail('Navigation must not click Scan.');}};
 const ctx=vm.createContext({window:controller?{TLIVisualizer:{scanPath:p=>calls.push(['prepare',p])}}:{},
  switchPanel:p=>calls.push(['panel',p]),document:{getElementById:id=>id==='visualizerPathInput'?input:null},Event,
  setTimeout(){assert.fail('No delayed location mutation after navigation or session lock.');},fetch(){assert.fail('Navigation cannot inspect storage or execute actions.');}});
 vm.runInContext(navigation+dashboard,ctx);
 return {ctx,calls,input};
}
test('legacy navigation name prepares the exact Windows/POSIX root without scanning or timers',()=>{
 for(const root of ['N:\\','/','\\\\archive\\media']){
  const f=fixture();f.ctx.switchPanelAndScan('panel-visualizer',root);
  assert.deepEqual(f.calls,[['panel','panel-visualizer'],['prepare',root]]);
 }
});
test('navigation to another panel does not retarget Free Space',()=>{
 const f=fixture();f.ctx.switchPanelAndScan('panel-files','N:\\');
 assert.deepEqual(f.calls,[['panel','panel-files']]);assert.equal(f.input.value,'Previous draft');
});
test('fallback navigation updates the path draft and dispatches input without inspection',()=>{
 const f=fixture(false);f.ctx.switchPanelAndScan('panel-visualizer','N:\\');
 assert.equal(f.input.value,'N:\\');assert.deepEqual(f.calls,[['panel','panel-visualizer'],['input','input'],['focus']]);
});
test('Dashboard storage handoff uses the same prepared-location contract',()=>{
 const f=fixture();f.ctx._openStorage('C:\\');
 assert.deepEqual(f.calls,[['panel','panel-visualizer'],['prepare','C:\\']]);
});

test('common host paths arriving after session lock cannot restore private suggestions',async()=>{
 const listeners={},nodes={visualizerPathSuggestions:{replaceChildren(){this.cleared=true;}},visualizerPathInput:{placeholder:'private old path'}};
 let resolve;const response=new Promise(r=>{resolve=r;});
 const context=vm.createContext({window:{TLI_PATHS:{home:'old'} ,addEventListener:(name,handler)=>listeners[name]=handler},document:{getElementById:id=>nodes[id],dispatchEvent(){assert.fail('Late path data must not publish');}},fetch:()=>response,_tliApplyPathSuggestions(){assert.fail('Late path data must not render');},CustomEvent:class{}});
 vm.runInContext('let _tliPathsEpoch=0,_tliPathsLocked=false;'+source.slice(source.indexOf('async function _tliLoadCommonPaths()'),source.indexOf('function _tliApplyPathSuggestions(')),context);
 const loading=context._tliLoadCommonPaths();listeners['tli-session-locked']();resolve({ok:true,json:async()=>({home:'C:\\Private',common:{downloads:'C:\\Private\\Downloads'}})});await loading;
 assert.equal(context.window.TLI_PATHS,null);assert.equal(nodes.visualizerPathSuggestions.cleared,true);assert.doesNotMatch(nodes.visualizerPathInput.placeholder,/private/i);
});
