/* Actual SPA + bundled D3. Synthetic intercepted jobs; no application server or file actions. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
process.argv.push('--label','storage-map');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),stamp=new Date().toISOString().replace(/[:.]/g,'-');
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const output=path.resolve(arg('--output')||path.join(root,'build_work/workspace-cohesion','storage-map-'+stamp));fs.mkdirSync(output,{recursive:true});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report={synthetic:true,source,source_before:fingerprintFiles(source),checks:[],layouts:[],screenshots:[],errors:[],requests:[],limitations:['Synthetic intercepted storage jobs, not household scans or cleanup.','Map area is recorded indexed bytes, not disk capacity.','Small tiles have the same entries in a paginated keyboard-accessible list.']};
const scanRoot='C:\\Users\\Demo\\Downloads',now='2026-09-11T14:00:00Z';
function scan(){
 const folders=['Media','Projects','Backups'].map((name,g)=>{const p=scanRoot+'\\'+name;const children=Array.from({length:100},(_,i)=>{const ext=['mp4','jpg','zip','pdf','gguf'][i%5];return{name:`Saved ${String(i).padStart(3,'0')} reference.${ext}`,path:p+`\\Saved ${String(i).padStart(3,'0')} reference.${ext}`,size:(i===0?20000:g*100+i+1)*1024**2};});return{name,path:p,size:children.reduce((n,c)=>n+c.size,0),children};});
 folders.push({name:'(+102 more)',path:scanRoot+'\\__MORE__',size:250*1024**2,size_known:true,size_partial:true,synthetic:true,protected:true,collapsed_entries:102,unknown_entries:1});
 folders.push({name:'Restricted',path:scanRoot+'\\Restricted',size:0,size_known:false,size_partial:true,children:[]});
 return{tree:{name:'Downloads',path:scanRoot,size:folders.reduce((n,c)=>n+c.size,0)+80*1024**2,omitted_bytes:80*1024**2,omitted_entries:2,size_partial:true,children:folders},meta:{root:scanRoot,partial:true,denied:1,files:404,dirs:4,representation_limited:true,scan_filters:{excluded_names:['AppData','node_modules','.git'],follow_links:false,max_depth:18,max_entries:50000,max_seconds:15}}};
}
fixtures['/visualizer/cleanup/receipts']={ok:true,receipts:[]};
async function ready(browser,width=1440,theme='emeraldLight',mode='modern'){
 const run=await makePage(browser,width,theme);const records=[];let serial=0,malformed=false;const jobs=new Map();
 await run.page.route('**/visualizer/jobs**',route=>{const request=route.request(),url=new URL(request.url()),parts=url.pathname.split('/').filter(Boolean),body=request.method()==='POST'?request.postDataJSON():null;records.push({path:url.pathname,method:request.method(),body});let job;
  if(parts.length===2){job={id:(++serial).toString(16).padStart(32,'0'),host:{id:'fixture-studio',name:'Studio'},operation:'scan',profile:body.profile,path:body.path,status:'partial',result_available:true,started_at:now,updated_at:now,finished_at:now,progress:{phase:'completed',entries_seen:409},limits:{},include_excluded:body.include_excluded};jobs.set(job.id,job);}else job=jobs.get(parts[2]);
  const result=scan();if(malformed)result.tree.size=1;
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,protocol:'storage-jobs-v1',job,...(parts[3]==='results'?{result}:{} )})});
 });
 await run.page.evaluate(mode=>{TLIInterface.set(mode);switchPanel('panel-visualizer');},mode);
 await run.page.locator('#visualizerPathInput').fill(scanRoot);await run.page.locator('#visualizerScanBtn').click();await run.page.waitForFunction(()=>!!TLIFreeSpace.getState().observation);
 return{...run,records,malformed:()=>{malformed=true;}};
}
async function capture(run,name,width,theme,mode,save=true){
 const measured=await layout(run.page,'panel-visualizer');assert.equal(measured.duplicateIds.length,0);assert.equal(measured.overflow.length,0,JSON.stringify(measured.overflow));assert.ok(measured.documentWidth<=width+2);
 report.layouts.push({name,width,theme,mode,...measured});
 if(save){for(const [suffix,target] of [['','#storage-results'],['-detail','#fs-map-workbench']]){await run.page.locator(target).evaluate(e=>e.scrollIntoView({block:'start'}));const file=path.join(output,`${name}${suffix}-${mode}-${theme}-${width}.png`);await run.page.screenshot({path:file});report.screenshots.push({name:name+suffix,width,theme,mode,file,sha256:hash(file)});}}
}
async function check(name,fn){try{await fn();report.checks.push({name,passed:true});}catch(e){report.checks.push({name,passed:false,error:e.stack});throw e;}}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const run=await ready(browser),page=run.page;
 try{
 await check('full-byte default hierarchy, exact area and explicit unknown/grouped coverage',async()=>{
  const fact=await page.evaluate(()=>{const s=TLIFreeSpace.getState(),canvas=document.querySelector('.fs-map-canvas'),r=canvas.getBoundingClientRect();return{mode:s.mode,total:s.mapView.total,raw:s.observation.raw.tree.size,rows:s.mapView.rows.length,unknown:s.mapView.unknown,cells:canvas.querySelectorAll('.fs-map-item').length,area:[...canvas.querySelectorAll('.fs-map-item')].reduce((n,e)=>{const b=e.getBoundingClientRect();return n+b.width*b.height;},0),canvas:r.width*r.height,groups:canvas.querySelectorAll('.fs-map-folder-label').length};});
  assert.equal(fact.mode,'map');assert.equal(fact.total,fact.raw);assert.equal(fact.rows,303);assert.equal(fact.unknown,1);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.groupedUnknown),1);assert.match(await page.locator('#vis4-treemap-container').innerText(),/1 additional unknown sizes inside groups/);assert.equal(fact.cells,240);assert.ok(Math.abs(fact.area/fact.canvas-1)<.004);assert.ok(fact.groups>0);assert.equal(run.records.length,2);
 });
 await check('map/list select same path; grouped byte row cannot request file operations',async()=>{
  const mark=page.locator('button.fs-map-item[aria-label*="reference"]').first();const expected=(await mark.getAttribute('data-map-key'));await mark.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#visualizerDetailsPath').innerText(),expected);assert.ok(await page.locator('#visualizerTableBody tr.fs-is-selected').count());assert.equal(await page.evaluate(()=>{const details=document.getElementById('visualizerDetailsBar'),map=document.getElementById('fs-map-workbench'),r=details.getBoundingClientRect();return details.nextElementSibling===map&&r.top>=0&&r.bottom<=innerHeight;}),true,'The same inspector is visible directly beside the workbench after explicit selection');
  await page.locator('.fs-map-item[aria-label^="Other mapped entries"]').click();assert.equal(await page.locator('#visualizerSendToFilesBtn').isEnabled(),false);await page.getByRole('button',{name:'Show grouped entries',exact:true}).click();assert.equal(await page.locator('#fs-map-breadcrumbs').innerText().then(t=>t.includes('subset')),true);assert.equal(run.records.length,2);await page.locator('#fs-map-breadcrumbs button').last().click();
 });
 await check('folder zoom and filters use existing observation without starts or cleanup',async()=>{
  await page.locator('.fs-map-folder-label').first().click();assert.notEqual(await page.evaluate(()=>TLIFreeSpace.getState().focus),scanRoot);await page.locator('#visualizerBackBtn').click();assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().focus),scanRoot);
  await page.locator('#fs-explorer-filters summary').click();await page.locator('#visualizerSearchInput').fill('Restricted');assert.match(await page.locator('#visualizerTableBody').innerText(),/Size unknown/);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.total),0);await page.locator('#visualizerSearchInput').fill('');await page.locator('#fs-explorer-filters summary').click();assert.equal(run.records.length,2);
 });
 const themes=process.argv.includes('--quick')?['emeraldLight','midnight']:await page.evaluate(()=>TLIThemes.themes.map(t=>t.id));
 for(const mode of ['modern','classic'])for(const theme of themes)for(const width of [1440,320]){
  await page.setViewportSize({width,height:1000});await page.evaluate(({theme,mode})=>{TLIThemes.apply(theme);TLIInterface.set(mode);},{theme,mode});
  await page.locator('#fs-mobile-map').evaluate(e=>e.click());await page.waitForTimeout(40);
  await capture(run,'map',width,theme,mode,['emeraldLight','midnight','classic'].includes(theme));
  if(width===320){await page.locator('#fs-mobile-list').click();await capture(run,'list',width,theme,mode,['emeraldLight','midnight','classic'].includes(theme));await page.locator('#fs-page-next').click();assert.match(await page.locator('#fs-page-label').innerText(),/51/);await page.locator('#fs-page-prev').click();}
 }
 await check('narrow list keyboard selection and enlarged text',async()=>{
  await page.setViewportSize({width:390,height:1000});await page.locator('#fs-mobile-list').click();const file=page.locator('#visualizerTableBody .storage-file-action').first();await file.focus();await page.keyboard.press('Enter');assert.ok(await page.locator('#visualizerDetailsPath').innerText());
  await page.evaluate(()=>document.querySelector('#panel-visualizer').style.fontSize='24px');await capture(run,'enlarged',390,'midnight','classic');await page.evaluate(()=>document.querySelector('#panel-visualizer').style.fontSize='');
 });
 await check('failed replacement preserves map bytes and lock clears source/inspector DOM',async()=>{
  const before=await page.evaluate(()=>TLIFreeSpace.getState().mapView.total);run.malformed();await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>document.querySelector('#visualizerStatus').textContent.includes('exceed'));assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.total),before);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#visualizerDetailsPath').textContent(),'');assert.equal(await page.locator('#fs-map-breadcrumbs').textContent(),'');assert.equal(await page.locator('#vis4-treemap-container').textContent(),'');
 });
 report.requests.push(...run.records);report.errors.push(...run.errors);
 }finally{await run.context.close();}
 report.source_after=fingerprintFiles(source);report.source_unchanged=JSON.stringify(report.source_before)===JSON.stringify(report.source_after);assert.equal(report.errors.length,0);report.completed=true;
 }catch(error){report.error=error.stack;process.exitCode=1;}finally{await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify({output,checks:report.checks.length,layouts:report.layouts.length,screenshots:report.screenshots.length,errors:report.errors,error:report.error,source_unchanged:report.source_unchanged}));})();
