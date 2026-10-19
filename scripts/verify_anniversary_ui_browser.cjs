/* Entire real SPA against synthetic intercepted responses. No application server. */
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const source = path.resolve(arg('--source') || root);
const label = arg('--label') || 'after';
const baseline = path.resolve(arg('--baseline') || path.join(root,'build_work/anniversary-ui/release-snapshot-s68b3uxw/source'));
const out = path.join(root, 'build_work', 'anniversary-ui', label + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, {recursive:true});
const now = new Date().toISOString(), epoch = Math.floor(Date.now()/1000);
const host = {node_id:'fixture-studio', device_id:'fixture-studio', node_name:'Studio', display_name:'Studio', hostname:'Studio', node_role:'standalone', role:'standalone', ip:'192.0.2.10', os:'Windows', platform:'Windows', port:8000};
const note = {id:'fixture-note',revision:'a'.repeat(64),title:'Studio backup location',text:'The spare backup drive is kept in the studio drawer.',source:'user',category:'general',created_at:now,updated_at:now,device_id:null};
const state = {cpu_pct:18,ram_pct:43,disk_pct_by_drive:{'C:':74},last_event_ts:epoch,probed_ts:epoch,metrics_checked_at:now,device_count:2};
const disk = {ok:true,system:{drive:'C:',mount:'C:\\',pct:74,used_gb:370,total_gb:500,free_gb:130}};
const sampleDevices = [{id:'fixture-lamp',name:'Desk lamp',ip:'192.0.2.20',relay:0,online:true,state:false,on:false}, {id:'fixture-fan',name:'Studio fan',ip:'192.0.2.21',relay:0,online:true,state:true,on:true}];
const bundled = {ok:true,healthy:true,running:true,model_exists:true,state:'running',model_name:'Qwen2.5 3B',model:'Qwen2.5 3B',preset:'standard',selected_preset:'standard',selected_model:'standard',provider:'bundled'};
const baseFixtures = {
 '/api/diagnostics/version':{ok:true,build_id:'synthetic',release:{schema_version:1,protocol:'dependable-computers-v1',source_id:'a'.repeat(64),backend_id:'b'.repeat(64),frontend_id:'c'.repeat(64),started_at:now,capabilities:['storage_jobs_v1','trusted_peers_v1','case_report_review_v1'],compatibility:{state:'matched',reasons:[]}}},
 '/system/pin/status':{enabled:true}, '/system/onboarding/status':{complete:true,started:false},
 '/agent/ping':{...host,ok:true}, '/status':{...host,ok:true,device_nickname:'Studio',model_online:false,mesh_status:'unpaired',cpu_usage:18,ram_usage:43,vault_status:{initialized:true,unlocked:false}},
 '/system/node':host, '/system/node/config':host, '/node/config':host,
 '/license/status':{ok:true,tier:'pro',valid:true,pro:true,features:{vault:true,home_automation:true,peer_nodes:true}},
 '/system/profile':{profile:'balanced',current:'balanced',suggested:'balanced',hardware:{cpu_count:8,total_ram_gb:32}},
 '/api/system/disk':disk, '/api/ai/status':bundled, '/api/ai/bundled/status':bundled,
 '/api/ai/model/info':{ok:true,exists:true,healthy:true,provider:'bundled',mode:'bundled',active_preset:'standard',model_name:'Qwen2.5 3B',runtime:bundled},
 '/api/ai/mesh/status':{ok:true,peers:[],available:false},
 '/api/ai/model/download/status':{ok:true,state:'idle',status:'idle',active:false},
 '/api/ai/models/presets':{ok:true,presets:[{id:'standard',name:'Qwen2.5 3B',description:'Everyday local conversations.',quantization:'Q4_K_M',ram_gb:8,size_gb:2,filename:'fixture-model.gguf',is_selected:true,running:true,installation_complete:true,compatibility:{state:'compatible',checked_at:now,reasons:['Meets conservative resource estimates.']}}]},
 '/dashboard/state':{state}, '/dashboard/presence':{state},
 '/dashboard/command-center':{ok:true,...host,state,nickname:'Studio',node:host,aiOk:true,lmOnline:false,devCount:2,devNames:['Desk lamp','Studio fan'],nodeRole:'standalone',meshSt:'unpaired',diskData:disk,storage:disk,activeAlerts:[],suggestions:[],current_action:null,health:{score:92,level:'good',summary:'No issues detected in the latest system checks.'},narrator:{message:'No issues detected in the latest system checks.',text:'No issues detected in the latest system checks.',severity:'info',title:'Latest system checks',category:'health'},smart_home:{count:2}},
 '/status/alerts':{alerts:[]}, '/events/recent':{events:[]},
 '/homeauto/devices':{devices:sampleDevices}, '/homepower/devices':{ok:true,devices:sampleDevices},
 '/api/mesh/health':{ok:true,nodes:[{...host,is_self:true,online:true,has_ai:true,cpu_pct:18,ram_pct:43,checked_at:now},{node_id:'fixture-den',peer_id:'fixture-den',node_name:'Den',ip:'192.0.2.11',port:8000,is_self:false,online:true,has_ai:false,cpu_pct:9,ram_pct:31,checked_at:now}]},
 '/mesh/directory':{mode:'standalone',this_device_id:'fixture-studio',devices:[]},
 '/api/intelligence/devices':{devices:[]}, '/api/intelligence/memory':{ok:true,facts:[note]},
 '/api/intelligence/places':{ok:true,protocol:'saved-places-v1',places:[{id:'fixture-place',revision:'b'.repeat(64),name:'Studio documents',kind:'folder',target:'C:\\Users\\Demo\\Documents',created_at:now,updated_at:now}]},
 '/api/intelligence/conversation-search/capabilities':{ok:true,protocol:'conversation-search-v1'},
 '/api/intelligence/conversation-search':{ok:true,protocol:'conversation-search-v1',conversations:[],results:[],next_cursor:null,coverage:{retained:0}},
 '/chat/conversations':{conversations:[]}, '/chat/history':{conversations:[]},
 '/vault/status':{ok:true,initialized:true,unlocked:false},
 '/update/status':{current_version:'1.3.5-beta',auto_check:false,update_available:false},
 '/visualizer/paths':{home:'C:\\Users\\Demo',downloads:'C:\\Users\\Demo\\Downloads',desktop:'C:\\Users\\Demo\\Desktop',documents:'C:\\Users\\Demo\\Documents',pictures:'C:\\Users\\Demo\\Pictures',videos:'C:\\Users\\Demo\\Videos'},
 '/visualizer/drives':{os:'Windows',drives:[{mountpoint:'C:\\',device:'C:',label:'Studio system',drive_type:'fixed',total:536870912000,used:397284474880,free:139586437120,percent_used:74,free_human:'130 GB',used_human:'370 GB',total_human:'500 GB'}]},
 '/actions/list':{actions:[]}, '/actions/receipts':{receipts:[]},
 '/tools/list':{tools:[{id:'sys_snapshot',label:'System snapshot'},{id:'sys_top_processes',label:'Top processes'},{id:'net_connectivity',label:'Connectivity check'}]},
 '/games/detect':{ok:true,games:[],game:null}, '/games/summary':{ok:true,cpu:'8-core processor',ram_gb:32,gpu:'Graphics adapter'},
 '/hub/packages':{packages:[]}, '/hub/list':{packages:[]},
 '/mesh/node':host, '/mesh/join_status':{paired:false,role:'standalone'}, '/api/lan/peers':{peers:[],self_id:'fixture-studio'},
 '/api/ai/model/progress':{state:'idle',status:'idle',active:false}, '/api/ai/conversations':{conversations:[]},
 '/api/ai/mesh/preference':{prefer_mesh:false,cpu_threshold:80}, '/models/available':{models:[]},
 '/devices/usb':{devices:[],drives:[]}, '/printshop/printers':{printers:[],default_printer:null}, '/printshop/scanners':{scanners:[]},
 '/identity':{node_id:'fixture-studio',public_key:'Synthetic public identity',fingerprint:'fixture-fingerprint'},
 '/hub/status':{installed:[],packages:[]}, '/hub/apps':{apps:[]}, '/federation/status':{enabled:false,peers:[]}, '/federation/messages':{messages:[]}, '/relay/status':{connected:false},
 '/games/detect_best':{ok:true,game:null}, '/api/builder/status':{ok:true,tasks:[],projects:[]}, '/api/builder/backend-status':{ok:true,ready:false,available:false,detail:'Synthetic provider unavailable.'},
 '/dashboard/action/current':null, '/dashboard/narrator/current':{type:'status',message:'No issues detected in the latest system checks.',severity:'info',text:'No issues detected in the latest system checks.'},
};
const panelIds = [...fs.readFileSync(path.join(source,'frontend/index.html'),'utf8').matchAll(/<section\b[^>]*id="(panel-[^"]+)"/g)].map(m=>m[1]);
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg','.json':'application/json'};
const reports=[], sessions=[];
const inferenceOrActionPath = /\/(?:api\/ai\/chat|v1\/chat\/completions|api\/ai\/completions|api\/builder\/warm-backend|printshop\/print|visualizer\/cleanup\/execute)(?:\/|$)/;
function unexpectedRequests(calls) {
 return calls.filter(call=>!['GET','HEAD'].includes(call.method)||inferenceOrActionPath.test(call.path));
}
function fingerprintFiles(directory) {
 const files=[];
 function walk(dir) { for(const entry of fs.readdirSync(dir,{withFileTypes:true})) { const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(?:html|js|css)$/.test(entry.name))files.push(full); } }
 walk(path.join(directory,'frontend'));
 return Object.fromEntries(files.sort().map(file=>[path.relative(directory,file).replaceAll(path.sep,'/'),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}
async function makePage(browser,width,theme,{preserveSettingsOnReload=false}={}) {
 const context = await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
 const calls=[],errors=[],unknown=[];
 await context.addInitScript(({theme,preserveSettingsOnReload})=>{localStorage.setItem('tli_onboard_seen_v1','1');if(!preserveSettingsOnReload||localStorage.getItem('tli_settings')===null)localStorage.setItem('tli_settings',JSON.stringify({defaultTheme:theme,searchEnabled:false,defaultBrain:'bundled'}));sessionStorage.setItem('tli_session_unlocked','1');}, {theme,preserveSettingsOnReload});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),pathname=decodeURIComponent(url.pathname);
  calls.push({method:request.method(),path:pathname});
  if(url.hostname!=='tli-ui.test') return route.abort('blockedbyclient');
  if(!['GET','HEAD'].includes(request.method())) return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,detail:'Synthetic fixture: no operation executed.'})});
  const file = path.resolve(source,'frontend','.'+(pathname==='/'?'/index.html':pathname));
  if(file.startsWith(path.join(source,'frontend')+path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  if(Object.hasOwn(baseFixtures,pathname)) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(baseFixtures[pathname])});
  unknown.push(pathname);
  return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,detail:'Synthetic service unavailable.',error:'Synthetic service unavailable.'})});
 });
 const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.stack || e.message));
 await page.goto('http://tli-ui.test/',{waitUntil:'load'});
 await page.waitForFunction(()=>typeof switchPanel==='function');
 await page.waitForTimeout(450);
 return {page,context,calls,errors,unknown};
}
async function layout(page,id){return page.evaluate(id=>{
 const root=document.getElementById(id),vw=document.documentElement.clientWidth;
 const visible=e=>{
  if(!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||e.closest('[hidden],.hidden'))return false;
  // Chromium can retain nonzero, offscreen rectangles for children of closed
  // native details. Those controls are neither painted nor keyboard reachable.
  if(typeof e.checkVisibility==='function'&&!e.checkVisibility({visibilityProperty:true}))return false;
  // Retain this native-disclosure check for browser versions without the API;
  // a control inside the first direct summary must still be measured.
  for(let parent=e.parentElement;parent;parent=parent.parentElement){
   if(parent.tagName==='DETAILS'&&!parent.open){
    const summary=[...parent.children].find(child=>child.tagName==='SUMMARY');
    if(!summary?.contains(e))return false;
   }
  }
  return true;
 };
 const elements=[...root.querySelectorAll('input,select,textarea,button')].filter(visible);
 return {width:vw,documentWidth:document.documentElement.scrollWidth,panelWidth:root.getBoundingClientRect().width,
  overflow:elements.filter(e=>{const r=e.getBoundingClientRect();return r.right>vw+2||r.left < -2;}).map(e=>({id:e.id,text:e.textContent.trim().slice(0,35),right:Math.round(e.getBoundingClientRect().right)})),
  duplicateIds:[...document.querySelectorAll('[id]')].map(e=>e.id).filter((id,i,a)=>a.indexOf(id)!==i)};
},id);}
async function main(){
 const baselineHtml=fs.readFileSync(path.join(baseline,'frontend/index.html'),'utf8');
 const baselineChat=fs.readFileSync(path.join(baseline,'frontend/js/chat-workspace.js'),'utf8');
 // This container was already removed before this batch. Its quickstart controls
 // are moved intact to chat-starters-slot by the pre-existing chat workspace.
 const exceptions=baselineChat.includes("$('chat-starters-slot').append(chips); starter?.remove();") ? {
  'chat-starters':{reason:'Pre-existing presentation container replacement; quickstart-chips remains in chat-starters-slot.',
   evidence:'frontend/js/chat-workspace.js',baselineHash:crypto.createHash('sha256').update(baselineChat).digest('hex')}
 } : {};
 const runtimeReplacements={};
 // The anniversary manual-routine editor intentionally replaces the dormant
 // trigger form. Record that precise contract change rather than requiring
 // hidden duplicate controls. Every other baseline markup ID remains checked.
 const markupReplacements={};
 const routinePath=path.join(source,'frontend/js/routine-workspace.js');
 const sourceHtml=fs.readFileSync(path.join(source,'frontend/index.html'),'utf8');
 if(fs.existsSync(routinePath)&&sourceHtml.includes('id="routine-workspace"')) {
  const controller=fs.readFileSync(routinePath,'utf8');
  if(controller.includes('window.TLIManualRoutines =')) for(const id of ['auto-kind','auto-name','auto-cooldown','auto-device','auto-capability','auto-create','auto-create-disabled','auto-status','auto-table','auto-rows','auto-receipts']) {
   markupReplacements[id]={replacement:'routine-workspace',reason:'Dormant trigger form replaced by explicitly reviewed saved manual routines; no trigger executor enabled.',evidence:'frontend/js/routine-workspace.js',sourceHash:crypto.createHash('sha256').update(controller).digest('hex')};
  }
 }
 for(const [id,file,pattern,reason] of [
  ['mcd-loading','frontend/js/mesh-control.js','grid.innerHTML = ""','Original loading placeholder is replaced by the computer list.'],
  ['mesh-directory-empty','frontend/js/mesh.js','listEl.innerHTML = ""','Original directory placeholder is replaced when the mesh directory renders.'],
  ['hub-empty','frontend/js/hub.js','grid.innerHTML = ""','Original sample placeholder is replaced by the package response.'],
  ['hub-browse-sample-btn','frontend/js/hub.js','grid.innerHTML = ""','Original placeholder sample button was already removed by the package renderer before this batch.'],
 ]) {
  const evidence=fs.readFileSync(path.join(baseline,file),'utf8');
  if(evidence.includes(pattern)) runtimeReplacements[id]={reason,evidence:file,baselineHash:crypto.createHash('sha256').update(evidence).digest('hex')};
 }
 const hashesAtStart=fingerprintFiles(source);
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const quick=process.argv.includes('--quick');
  const sizes=quick?[1440,390]:[1440,1024,768,390,320];
  for(const width of sizes) for(const theme of ['emeraldLight','midnight']){
   const run=await makePage(browser,width,theme);
   const originalIds=await run.page.evaluate(html=>[...new DOMParser().parseFromString(html,'text/html').querySelectorAll('[id]')].map(e=>e.id),baselineHtml);
   const currentMarkupIds=await run.page.evaluate(html=>[...new DOMParser().parseFromString(html,'text/html').querySelectorAll('[id]')].map(e=>e.id),fs.readFileSync(path.join(source,'frontend/index.html'),'utf8'));
   const missingMarkupIds=[...new Set(originalIds)].filter(id=>!currentMarkupIds.includes(id)&&!markupReplacements[id]);
   for(const id of panelIds){
    await run.page.evaluate(id=>switchPanel(id),id); await run.page.waitForTimeout(id==='panel-dashboard2'?450:120);
    if(id==='panel-automations'&&Object.keys(markupReplacements).length) {
     assert.equal(await run.page.evaluate(()=>typeof window.TLIManualRoutines?.onOpen),'function');
     assert.equal(await run.page.locator('#routine-workspace #routine-status').count(),1,'Replacement routine controller must actually render its current state');
    }
    const record=await layout(run.page,id); reports.push({width,theme,panel:id,...record});
    if(width===1440||width===390) await run.page.screenshot({path:path.join(out,`${id}-${width}-${theme}.png`)});
   }
   const interactions=[];
   if(label!=='before') {
    try {
     const notes=run.page.locator('#ui-open-notes');
     if(width>768) {await notes.click();await run.page.waitForTimeout(100);assert.ok(await run.page.locator('#notebook-dialog').evaluate(e=>e.open));await run.page.keyboard.press('Escape');}
     else {await run.page.locator('#tli-bn-more-btn').click();if(width===390)await run.page.screenshot({path:path.join(out,`more-${width}-${theme}.png`)});await run.page.keyboard.press('Escape');assert.equal(await run.page.locator('#tli-more-drawer').getAttribute('hidden'),'');}
    } catch(error) {interactions.push(error.stack||error.message);}
   }
   const ids=await run.page.evaluate(()=>[...document.querySelectorAll('[id]')].map(e=>e.id));
   const missingIds=[...new Set(originalIds)].filter(id=>!ids.includes(id)&&!exceptions[id]&&!runtimeReplacements[id]&&!markupReplacements[id]);
   const session={width,theme,errors:run.errors,unexpectedRequests:unexpectedRequests(run.calls),missingIds,missingMarkupIds,interactions,
    preservedOriginalIds:originalIds.filter(id=>ids.includes(id)).length,exceptions:Object.keys(exceptions).filter(id=>!ids.includes(id)),
    runtimeReplacements:Object.keys(runtimeReplacements).filter(id=>!ids.includes(id)),markupReplacements:Object.keys(markupReplacements).filter(id=>!currentMarkupIds.includes(id))};
   sessions.push(session);
   fs.writeFileSync(path.join(out,`requests-${width}-${theme}.json`),JSON.stringify({calls:run.calls,errors:run.errors,unknown:[...new Set(run.unknown)],integrity:session},null,2));
   await run.context.close();
  }
 } finally {await browser.close();}
 const hashes=fingerprintFiles(source);
 const changedDuringRun=[...new Set([...Object.keys(hashesAtStart),...Object.keys(hashes)])].filter(file=>hashesAtStart[file]!==hashes[file]);
 const failedSessions=sessions.filter(s=>s.errors.length||s.unexpectedRequests.length||s.missingIds.length||s.missingMarkupIds.length||s.interactions.length);
 const report={label,source,baseline,synthetic:true,createdAt:new Date().toISOString(),hashes,changedDuringRun,exceptions,runtimeReplacements,markupReplacements,sessions,failedSessions,
  checks:reports,overflow:reports.filter(r=>r.overflow.length||r.documentWidth>r.width+2),duplicates:reports.filter(r=>r.duplicateIds.length)};
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({output:out,views:reports.length,overflow:report.overflow.length,duplicates:report.duplicates.length,failedSessions:failedSessions.length,changedDuringRun}));
 if(label!=='before') {
  assert.equal(report.overflow.length,0,'Unexpected page/control overflow');
  assert.equal(report.duplicates.length,0,'Duplicate control IDs');
  assert.equal(failedSessions.length,0,'Browser errors, action requests, missing IDs or failed navigation interactions');
  assert.equal(changedDuringRun.length,0,'Source changed while screenshots were captured; rerun this candidate');
 }
}
module.exports = {makePage,layout,fixtures:baseFixtures,panelIds,out,source,unexpectedRequests,fingerprintFiles};
if(require.main===module) main().catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);console.error(e);process.exitCode=1;});
