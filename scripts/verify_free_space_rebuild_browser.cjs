/* Real SPA, synthetic storage jobs and fake reviewed Trash. No application server. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
process.argv.push('--label','free-space-rebuild');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {contrast,textScale}=require('./verify_anniversary_themes_browser.cjs');
const quick=process.argv.includes('--quick');
const output=path.join(root,'build_work/free-space-rebuild','browser-'+new Date().toISOString().replace(/[:.]/g,'-'));
if(require.main===module)fs.mkdirSync(output,{recursive:true});
const report={synthetic:true,source,started_at:new Date().toISOString(),checks:[],layouts:[],contrast:[],screenshots:[],errors:[],failures:[],requests:[],limitations:['Intercepted synthetic responses; no live scans or Trash operations.','Computed contrast covers solid backgrounds; complex backgrounds are listed for visual review.','Doubled text simulates enlargement; physical phones and screen readers were not tested.']};
const now='2026-09-09T12:00:00Z',scanPath='C:\\Users\\Demo\\Downloads';
const drives=Array.from({length:12},(_,i)=>({mountpoint:String.fromCharCode(67+i)+':\\',device:String.fromCharCode(67+i)+':',label:['Studio system','Recovery','Archive','Media','Projects','Offline backup','Games','Recordings','Scratch','Music','Work','Spare'][i],drive_type:'fixed',total:500*1024**3,used:(i===0?485:250)*1024**3,free:(i===0?15:250)*1024**3,percent_used:i===0?97:50,free_human:i===0?'15 GB':'250 GB',total_human:'500 GB',checked_at:now,availability:'available'}));
drives[5]={...drives[5],availability:'unavailable',total:null,used:null,free:null,percent_used:null,detail:'Capacity check timed out.'};
fixtures['/visualizer/drives']={os:'Windows',drives,checked_at:now};
fixtures['/visualizer/paths']={home:'C:\\Users\\Demo',common:{downloads:scanPath,desktop:'C:\\Users\\Demo\\Desktop',documents:'C:\\Users\\Demo\\Documents',pictures:'C:\\Users\\Demo\\Pictures',videos:'C:\\Users\\Demo\\Videos'},extras:[]};
fixtures['/visualizer/cleanup/receipts']={ok:true,receipts:[]};
fixtures['/visualizer/history']={ok:true,protocol:'storage-history-v1',snapshots:[]};
function scan(rootPath=scanPath,count=120){
 const childPath=(name)=>rootPath+(rootPath.endsWith('\\')||rootPath==='/'?'':rootPath.includes('\\')?'\\':'/')+name;
 const children=Array.from({length:count},(_,i)=>({name:`Review item ${String(i).padStart(4,'0')}.${i%3?'zip':'mp4'}`,path:childPath(`Review item ${String(i).padStart(4,'0')}.${i%3?'zip':'mp4'}`),size:i===9?null:5e8-i*2e6,size_known:i!==9}));
 children.push({name:'Saved projects',path:childPath('Saved projects'),is_dir:true,size:900e6,children:[{name:'Project archive.zip',path:childPath('Saved projects')+'\\Project archive.zip',size:900e6}]});
 children.push({name:'<Untrusted name>.txt',path:childPath('<Untrusted name>.txt'),size:12});
 const total=children.reduce((n,c)=>n+(c.size||0),0);
 return {tree:{name:rootPath.split(/[\\/]/).filter(Boolean).at(-1)||rootPath,path:rootPath,is_dir:true,size:total,children},largest:children.filter(c=>!c.children&&c.size!==null).slice(0,50),meta:{root:rootPath,files:count+2,dirs:1,entries_seen:count+3,seconds:3,partial:true,denied:1,skipped:0,depth_limited:0,entry_limited:false,time_limited:false,max_entries:50000,max_depth:18,representation_limited:false,scan_filters:{excluded_names:['AppData','node_modules','.git'],follow_links:false,max_depth:18,max_entries:50000,max_seconds:15},observed_at:now}};
}
function resultFor(body){
 if(body.operation==='scan')return scan(body.path);
 if(body.operation==='large_files'){const s=scan(body.path,82);return {files:s.tree.children.filter(f=>!f.children),meta:{...s.meta,found:95,results_limited:true,total_bytes:123e6}};}
 if(body.operation==='duplicates')return {groups:[{size:1024,wasted_bytes:2048,hash:'a'.repeat(64),paths:[body.path+'\\First copy.zip',body.path+'\\Second copy.zip',body.path+'\\Third copy.zip']}],meta:{root:body.path,partial:false,verification:'full_sha256',groups_found:1,results_limited:false}};
 return {targets:[{label:'Downloads',path:scanPath,size_bytes:128e6,size_partial:true,size_meta:{partial:true,time_limited:true},safety:'manual'},{label:'Temporary files',path:'C:\\Users\\Demo\\AppData\\Local\\Temp',size_bytes:32e6,size_partial:false,size_meta:{partial:false},safety:'auto'}],meta:{scope:'host_common_folders',partial:true},os:'Windows'};
}
async function jobs(page){
 const records=[],store=new Map(),config={hold:false,failStart:false,failResult:false,failDrives:false,malformed:false,partialOnCancel:true};let serial=0;
 await page.route('**/visualizer/drives',r=>{records.push({method:r.request().method(),path:'/visualizer/drives'});return r.fulfill({status:config.failDrives?503:200,contentType:'application/json',body:JSON.stringify(config.failDrives?{detail:'Synthetic unavailable drive service'}:fixtures['/visualizer/drives'])});});
 await page.route('**/visualizer/jobs**',r=>{
  const req=r.request(),url=new URL(req.url()),parts=url.pathname.split('/').filter(Boolean),body=req.method()==='POST'?req.postDataJSON():null;
  records.push({method:req.method(),path:url.pathname,body});
  const send=(data,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(parts.length===2){
   if(config.failStart)return send({ok:false,detail:{code:'storage_busy',message:'A storage job is already active. Try again after it stops.'}},409);
   let found=[...store.values()].find(v=>v.job.request_id===body.request_id);
   if(!found){const id=(++serial).toString(16).padStart(32,'0');found={body,job:{id,host:{id:'fixture-studio',name:'Studio'},operation:body.operation,profile:body.profile,path:body.path??null,request_id:body.request_id,include_excluded:!!body.include_excluded,status:config.hold?'running':'partial',result_available:!config.hold,started_at:now,updated_at:now,finished_at:config.hold?null:now,elapsed_seconds:3,elapsed_s:3,progress:{phase:'enumerating',entries_seen:123,files:122},worker_stopped:!config.hold,error:null},result:resultFor(body)};store.set(id,found);}
   return send({ok:true,protocol:'storage-jobs-v1',job:found.job});
  }
  const value=store.get(parts[2]);if(!value)return send({detail:'Job expired'},404);
  if(parts[3]==='cancel'){value.job.status='cancelled';value.job.result_available=config.partialOnCancel;value.job.worker_stopped=true;value.job.finished_at=now;return send({ok:true,protocol:'storage-jobs-v1',job:value.job});}
  if(parts[3]==='results'){if(config.failResult)return send({detail:'Synthetic result unavailable'},503);return send({ok:true,protocol:'storage-jobs-v1',job:value.job,result:config.malformed?{tree:{path:'N:\\'},meta:{}}:value.result});}
  return send({ok:true,protocol:'storage-jobs-v1',job:value.job});
 });
 return {records,config,store,starts:()=>records.filter(r=>r.method==='POST'&&r.path==='/visualizer/jobs')};
}
async function ready(browser,width=1440,theme='emeraldLight',mode='modern'){
 const run=await makePage(browser,width,theme),mock=await jobs(run.page);
 await run.page.evaluate(mode=>{TLIInterface.set(mode);switchPanel('panel-visualizer');},mode);
 await run.page.waitForFunction(()=>window.TLIFreeSpace?.getState);
 await run.page.evaluate(()=>{window.__themeAuditVisible=el=>el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&el.getBoundingClientRect().width>0;});
 return {...run,mock};
}
async function recordView(run,name,width,theme,mode,save=true){
 const measured={name,width,theme,mode,...await layout(run.page,'panel-visualizer')};report.layouts.push(measured);
 assert.equal(measured.duplicateIds.length,0,`${name} duplicate ids`);assert.equal(measured.overflow.length,0,`${name} overflowing controls: ${JSON.stringify(measured.overflow)}`);assert.ok(measured.documentWidth<=width+2,`${name} document overflow ${measured.documentWidth}/${width}`);
 if(save){
  const capture=async(label)=>{const file=path.join(output,`${label}-${width}-${theme}-${mode}.png`);await run.page.screenshot({path:file,fullPage:true});report.screenshots.push({name:label,width,theme,mode,file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});};
  await run.page.evaluate(()=>{document.querySelectorAll('*').forEach(e=>{if(e.scrollTop)e.scrollTop=0;});window.scrollTo(0,0);});await capture(name);
  if(['explorer','results','large-text'].includes(name)&&await run.page.locator('#storage-results').isVisible()){await run.page.locator('#storage-results').evaluate(e=>e.scrollIntoView({block:'start'}));await capture(name+'-evidence');}
 }
}
async function check(name,fn){try{await fn();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:error.stack});report.failures.push({name,error:error.stack});}fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
async function cleanupWorkflow(browser){
 const run=await ready(browser,390,'midnight'),{page,mock}=run,requests=[];let files=[],resolved=false;
 const receipt=()=>({ok:true,id:'synthetic-review',status:resolved?'completed':'partial',started_at:1788948000,summary:resolved?'One file moved to Trash. Freed space was not measured.':'One move has an uncertain outcome.',results:files.map(f=>({...f,status:resolved?'trashed':'unknown',size:500000000,detail:resolved?'Moved to Trash':'Outcome could not be confirmed'}))});
 await page.route('**/visualizer/cleanup/**',route=>{
  const req=route.request(),pathname=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():null;requests.push({path:pathname,method:req.method(),body});
  let result;if(pathname.endsWith('/preview')){files=body.files;result={ok:true,preview_id:'synthetic-review',can_execute:true,total_bytes:500000000,space_note:'Sizes are observations, not confirmed freed space.',items:files.map(f=>({...f,size:500000000,eligible:true}))};}
  else if(pathname.endsWith('/execute'))result=receipt();else if(pathname.includes('/receipt/'))result=receipt();else result={ok:true,receipts:[receipt()]};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
 });
 try{await check('reviewed Trash guards duplicate execution and preserves uncertain receipts on Clear',async()=>{
  await page.locator('#visualizerPathInput').fill(scanPath);await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().observation);
  if(await page.locator('#fs-mobile-list').isVisible())await page.locator('#fs-mobile-list').click();
  await page.locator('#visualizerTableBody [data-cleanup-path]').first().check();await page.locator('#fs-open-cleanup').click();await page.locator('#cleanup-check').click();await page.waitForFunction(()=>!document.getElementById('cleanup-execute').hidden);
  const capacities=mock.records.filter(r=>r.path==='/visualizer/drives').length;
  await page.locator('#cleanup-execute').evaluate(e=>{e.click();e.click();});await page.waitForFunction(()=>document.getElementById('cleanup-receipt').textContent.includes('uncertain'));
  assert.equal(requests.filter(r=>r.path.endsWith('/execute')).length,1);await page.locator('#cleanup-clear').click();assert.match(await page.locator('#cleanup-receipt').innerText(),/uncertain/);assert.equal(await page.locator('#cleanup-result-check').isVisible(),true);
  resolved=true;await page.locator('#cleanup-result-check').click();await page.waitForFunction(()=>document.getElementById('cleanup-receipt').textContent.includes('One file moved'));
  assert.equal(requests.filter(r=>r.path.endsWith('/execute')).length,1);assert.equal(mock.records.filter(r=>r.path==='/visualizer/drives').length,capacities);
  assert.equal(await page.evaluate(()=>!!document.querySelector('dialog[open] #cleanup-receipt')),true,'Phone review must be a modal drawer');
  const file=path.join(output,'cleanup-review-390-midnight.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push({name:'cleanup-review',width:390,theme:'midnight',mode:'modern',file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'fs-open-cleanup');
 });}finally{report.errors.push(...run.errors);report.requests.push(...mock.records,...requests);await run.context.close();}
}
async function apiContract(browser){
 const i=process.argv.indexOf('--api-fixtures');const file=path.resolve(i>=0?process.argv[i+1]:path.join(root,'build_work/free-space-rebuild/api-fixtures/envelopes.json'));
 const data=JSON.parse(fs.readFileSync(file,'utf8'));report.apiFixtures={file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
 const run=await ready(browser);
 try{await check('actual authenticated backend envelopes validate in the browser without invented fields',async()=>{
  const rows=await run.page.evaluate(data=>Object.entries(data.fixtures).map(([name,value])=>{
   const start=TLIFreeSpace.validateJob(value.start,value.request),status=TLIFreeSpace.validateJob(value.status,start),result=TLIFreeSpace.validateResult(value.results.result,status);
   return {name,host:result.host,unknown:result.files?.find(f=>f.name==='unreadable.bin')?.size};
  }),data);
  assert.equal(rows.length,5);assert.ok(rows.every(r=>r.host.name==='Synthetic API fixture'));assert.equal(rows.find(r=>r.name==='scan').unknown,null);
 });}finally{report.errors.push(...run.errors);await run.context.close();}
}
async function delayedResponse(browser){
 const run=await ready(browser),{page,mock}=run;let release,arrived;
 const arrival=new Promise(resolve=>{arrived=resolve;});
 await page.route('**/visualizer/jobs/*/results',route=>new Promise(resolve=>{
  const id=new URL(route.request().url()).pathname.split('/')[3],value=mock.store.get(id);
  release=async()=>{try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,protocol:'storage-jobs-v1',job:value.job,result:value.result})});}catch{}finally{resolve();}};arrived();
 }));
 try{await check('a delayed result arriving after lock cannot repopulate private paths',async()=>{
  await page.locator('#visualizerPathInput').fill(scanPath);await page.locator('#visualizerScanBtn').click();await arrival;
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));await release();
  assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().observation),null);assert.equal(await page.locator('#visualizerTableBody').innerText(),'');assert.equal(await page.locator('#visualizerPathInput').inputValue(),'');
 });}finally{if(release)await release();report.errors.push(...run.errors);await run.context.close();}
}
async function workflow(browser){
 const run=await ready(browser),{page,mock}=run;
 try {
 await check('navigation and location choices do not start a storage job',async()=>{
  await page.locator('#fs-drives-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('#vis4-drives [data-mount]').length===12);
  await page.locator('#vis4-drives [data-mount]').first().click();assert.equal(mock.starts().length,0);assert.equal(await page.locator('#storage-results').isVisible(),false);
  await recordView(run,'empty',1440,'emeraldLight','modern');
 });
 await check('failed capacity refresh preserves observed drive list',async()=>{
  mock.config.failDrives=true;await page.locator('#fs-drives-refresh').click();await page.waitForFunction(()=>!document.getElementById('fs-drives-refresh').disabled);assert.equal(await page.locator('#vis4-drives [data-mount]').count(),12);mock.config.failDrives=false;
 });
 await check('scan, paging, sorting, unknown sizes and scope retention',async()=>{
  await page.locator('#visualizerPathInput').fill(scanPath);await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().observation);
  assert.equal(mock.starts().length,1);assert.equal(await page.locator('#visualizerTableBody tr').count(),50);assert.match(await page.locator('#fs-map-breadcrumbs').innerText(),/Downloads/);
  await page.locator('#fs-page-next').click();assert.match(await page.locator('#fs-page-label').innerText(),/51/);
  await page.locator('th[data-sort="name"] button').click();assert.equal(await page.locator('th[data-sort="name"]').getAttribute('aria-sort'),'ascending');
  if(await page.locator('#fs-explorer-filters').count())await page.locator('#fs-explorer-filters').evaluate(e=>{e.open=true;});
  await page.locator('#visualizerSearchInput').fill('0009');assert.match(await page.locator('#visualizerTableBody').innerText(),/unknown/i);await page.locator('#visualizerSearchInput').fill('');
  if(await page.locator('#fs-explorer-filters').count())await page.locator('#fs-explorer-filters').evaluate(e=>{e.open=false;});
  await page.locator('#visualizerPathInput').fill('N:\\');assert.match(await page.locator('#fs-map-breadcrumbs').innerText(),/Downloads/);assert.equal(mock.starts().length,1);
  await recordView(run,'results',1440,'emeraldLight','modern');
 });
 await check('failed replacement retains the old observation',async()=>{
  mock.config.failResult=true;await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>!TLIFreeSpace.getState().busy);
  assert.match(await page.locator('#fs-map-breadcrumbs').innerText(),/Downloads/);assert.equal(await page.locator('#storage-results').isVisible(),true);mock.config.failResult=false;
 });
 await check('cancelled partial result needs explicit review',async()=>{
  mock.config.hold=true;await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='running');
  await page.locator('#fs-job-stop').click();await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='cancelled');
  assert.match(await page.locator('#fs-map-breadcrumbs').innerText(),/Downloads/);
  const partial=page.getByRole('button',{name:'View partial results',exact:true});await partial.click();await page.waitForFunction(()=>TLIFreeSpace.getState().observation?.root==='N:\\');mock.config.hold=false;
 });
 await check('Files navigation and Chat preparation preserve drafts and execute nothing',async()=>{
  await page.locator('#visualizerTableBody .storage-file-action').first().click();await page.locator('#visualizerSendToFilesBtn').click();
  const before=mock.starts().length;await page.locator('#fs-handoff-close').click();assert.equal(mock.starts().length,before);
  await page.evaluate(()=>{document.getElementById('chat-input').value='Keep my unsent question';});await page.locator('#fs-ask-chat').click();await page.locator('#fs-handoff-confirm').click();
  assert.equal(await page.locator('#chat-input').inputValue(),'Keep my unsent question');assert.equal(await page.locator('#fs-handoff').evaluate(e=>e.open),true);await page.keyboard.press('Escape');
 });
 await check('secondary tools require explicit starts and preserve duplicate results on failure',async()=>{
  const before=mock.starts().length;for(const name of ['large_files','duplicates','common_folders','history','explore'])await page.locator(`[data-fs-tab="${name}"]`).click();assert.equal(mock.starts().length,before);
  await page.locator('[data-fs-tab="duplicates"]').click();await page.locator('#fs-start-duplicates').click();await page.waitForFunction(()=>document.querySelector('#fs-duplicates-results').textContent.includes('copies'));
  await page.locator('#fs-duplicates-results summary').first().click();const keep=page.locator('#fs-duplicates-results [data-cleanup-keeper]');await keep.selectOption({index:1});const chosen=await keep.inputValue();await page.locator('#fs-duplicates-results [data-cleanup-path]').nth(1).check();
  const old=await page.locator('#fs-duplicates-results').innerText();mock.config.failResult=true;await page.locator('#fs-start-duplicates').click();await page.waitForFunction(()=>!TLIFreeSpace.getState().busy);assert.equal(await page.locator('#fs-duplicates-results').innerText(),old);assert.equal(await keep.inputValue(),chosen);assert.equal(await page.locator('#fs-duplicates-results [data-cleanup-path]').nth(1).isChecked(),true);mock.config.failResult=false;
  await recordView(run,'duplicates',1440,'emeraldLight','modern');
 });
 await check('leaving and returning does not cancel or resubmit a running scan',async()=>{
  await page.locator('[data-fs-tab="explore"]').click();mock.config.hold=true;await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='running');
  const started=mock.starts().length,cancelled=mock.records.filter(r=>r.path.endsWith('/cancel')).length;
  await page.evaluate(()=>switchPanel('panel-settings'));await page.evaluate(()=>switchPanel('panel-visualizer'));assert.equal(mock.starts().length,started);assert.equal(mock.records.filter(r=>r.path.endsWith('/cancel')).length,cancelled);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().job?.status),'running');
 });
 await check('lock clears private results and late responses cannot restore them',async()=>{
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#visualizerPathInput').inputValue(),'');assert.equal(await page.locator('#visualizerTableBody').innerText(),'');assert.equal(await page.locator('#fs-duplicates-results').innerText(),'');assert.equal(await page.evaluate(()=>window.visualizerV4),null);
 });
 }finally{report.errors.push(...run.errors);report.requests.push(...mock.records);await run.context.close();}
}
async function appearances(browser){
 const run=await ready(browser),{page}=run;
 try{
  await page.locator('#visualizerPathInput').fill(scanPath);await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().observation);
  const themes=quick?['emeraldLight','midnight']:await page.evaluate(()=>TLIThemes.themes.map(t=>t.id));report.themes=themes;
  for(const mode of ['modern','classic'])for(const theme of themes)for(const width of quick?[1440,390]:[1440,900,390,320]){
   await check(`layout ${mode} ${theme} ${width}`,async()=>{
    await page.setViewportSize({width,height:1000});await page.evaluate(({mode,theme})=>{TLIInterface.set(mode);TLIThemes.apply(theme);}, {mode,theme});
    await recordView(run,'explorer',width,theme,mode,['emeraldLight','midnight'].includes(theme));
    if(width===390){const colors=await contrast(page,'panel-visualizer');report.contrast.push({theme,mode,...colors});assert.equal(colors.findings.length,0,JSON.stringify(colors.findings));}
   });
  }
  await check('keyboard modes, map equivalent and enlarged text',async()=>{
   await page.setViewportSize({width:390,height:1000});await page.evaluate(()=>{TLIInterface.set('modern');TLIThemes.apply('midnight');});
   await page.locator('[data-mode="map"]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#vis4-treemap-container').isVisible(),true);await recordView(run,'map',390,'midnight','modern');
   await page.locator('[data-mode="files"]').click();await textScale(page,'panel-visualizer',2);await recordView(run,'large-text',390,'midnight','modern');
   await page.locator('[data-fs-tab="explore"]').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.dataset.fsTab),'large_files');
  });
 }finally{report.errors.push(...run.errors);report.requests.push(...run.mock.records);await run.context.close();}
}
module.exports={ready,jobs,scan};
if(require.main===module)(async()=>{const before=fingerprintFiles(source),browser=await chromium.launch({channel:'msedge',headless:true});try{await workflow(browser);await cleanupWorkflow(browser);await apiContract(browser);await delayedResponse(browser);await appearances(browser);}finally{
 await browser.close();report.source_unchanged=JSON.stringify(before)===JSON.stringify(fingerprintFiles(source));report.finished_at=new Date().toISOString();report.passed=!report.failures.length&&!report.errors.length&&report.source_unchanged;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
 }console.log(JSON.stringify({output,checks:report.checks.length,layouts:report.layouts.length,screenshots:report.screenshots.length,failures:report.failures,errors:report.errors,source_unchanged:report.source_unchanged}));process.exitCode=report.passed?0:1;})().catch(e=>{console.error(e);process.exitCode=1;});
