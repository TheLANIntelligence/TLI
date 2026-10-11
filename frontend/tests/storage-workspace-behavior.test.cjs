const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const vault=fs.readFileSync(path.join(__dirname,'../js/vault.js'),'utf8');
const files=fs.readFileSync(path.join(__dirname,'../js/files.js'),'utf8');
function node() {
  const classes=new Set();
  return {style:{},dataset:{},textContent:'',hidden:false,children:[],attributes:{},
    classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){if(on)classes.add(x);else classes.delete(x);}},
    setAttribute(key,value){this.attributes[key]=value;},appendChild(child){this.children.push(child);},
    querySelector(){return null;},addEventListener(){}};
}
function vaultFixture(response) {
  const ids=['vault-setup-section','vault-auth-section','vault-status-pill','vault-content-area','vault-lock-btn',
    'vault-icon-glyph','vault-auth-hint','vault-forgot-btn','vault-reset-panel','vault-state-message','sv-setup-wrap','sv-manage-wrap','sv-status-desc'];
  const nodes=Object.fromEntries(ids.map(id=>[id,node()]));const calls=[];
  const context=vm.createContext({$:id=>nodes[id]||null,document:{querySelector:()=>null},console,Date,
    showToast(){},debugLog(){},fetch:async url=>{calls.push(url);if(response instanceof Error)throw response;
      return {ok:true,json:async()=>response};}});
  vm.runInContext(vault,context);
  return {context,nodes,calls};
}
test('Vault distinguishes setup, locked, unlocked and unknown without inventing an initialized state',()=>{
  const f=vaultFixture();
  for(const [status,label] of [[{initialized:false,unlocked:false},'Setup required'],[{initialized:true,unlocked:false},'Locked'],
    [{initialized:true,unlocked:true},'Unlocked'],[{},'Unavailable'],[{initialized:false,unlocked:true},'Unavailable']]){
    f.context.updateVaultUIFromStatus(status);
    assert.equal(f.nodes['vault-status-pill'].textContent,label);
    assert.equal(f.nodes['vault-content-area'].classList.contains('hidden'),label!=='Unlocked');
  }
  assert.equal(f.nodes['sv-setup-wrap'].style.display,'none');
  assert.match(f.nodes['sv-status-desc'].textContent,/unavailable/);
});
test('network and malformed Vault status failures hide previously unlocked contents and offer a truthful recheck',async()=>{
  for(const response of [new Error('Disconnected'),{initialized:true},null]) {
    const f=vaultFixture(response);f.context.updateVaultUIFromStatus({initialized:true,unlocked:true});
    await f.context.fetchVaultStatus();
    assert.equal(f.nodes['vault-status-pill'].dataset.state,'unavailable');
    assert.equal(f.nodes['vault-content-area'].classList.contains('hidden'),true);
    assert.match(f.nodes['vault-state-message'].textContent,/Reconnect and check again/);
    assert.deepEqual(f.calls,['/vault/status']);
  }
});
function printerFixture() {
  const ids=['ps-printer-select','ps-pane-print','ps-pane-scan','ps-tab-print','ps-tab-scan','ps-print-status','ps-platform-tag'];
  const nodes=Object.fromEntries(ids.map(id=>[id,node()]));const requests=[];let resolve;
  const select=nodes['ps-printer-select'];select.options=[];select.value='';
  Object.defineProperty(select,'innerHTML',{set(html){this.options=[...html.matchAll(/<option value="([^"]*)"/g)].map(match=>({value:match[1]}));},get(){return '';}});
  const context=vm.createContext({window:{},document:{getElementById:id=>nodes[id]||null},console,
    switchPanel(){},escapeHtml:value=>String(value),fetch:async url=>{requests.push(url);return new Promise(done=>{resolve=data=>done({ok:true,json:async()=>data});});},
    setTimeout(){throw new Error('Printer handoff must await options, not a timer');}});
  vm.runInContext(files,context);
  return {context,nodes,requests,finish:data=>resolve(data)};
}
test('printer handoff waits for a single slow enumeration and only selects the latest requested printer',async()=>{
  const f=printerFixture();
  const first=f.context.switchToPrintShop('First');const second=f.context.switchToPrintShop('Second');
  assert.equal(f.nodes['ps-printer-select'].value,'');assert.deepEqual(f.requests,['/printshop/printers']);
  f.finish({printers:[{name:'First',default:true},{name:'Second'}]});
  assert.equal(await first,false);assert.equal(await second,true);
  assert.equal(f.nodes['ps-printer-select'].value,'Second');
  assert.match(f.nodes['ps-print-status'].textContent,/Review the document.*before printing/);
  assert.deepEqual(f.requests,['/printshop/printers']);
});
test('an unavailable requested printer cannot silently retain a different default printer',async()=>{
  const f=printerFixture();const pending=f.context.switchToPrintShop('Missing');
  f.finish({printers:[{name:'Unrelated',default:true}]});
  assert.equal(await pending,false);assert.equal(f.nodes['ps-printer-select'].value,'');
  assert.match(f.nodes['ps-print-status'].textContent,/requested printer is unavailable/);
  assert.deepEqual(f.requests,['/printshop/printers']);
});
