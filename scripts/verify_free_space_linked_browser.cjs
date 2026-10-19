/* Actual SPA and synthetic retained observations. No live server, scan or cleanup. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {ready}=require('./verify_free_space_rebuild_browser.cjs');
const output=path.resolve(__dirname,'../build_work/free-space-linked/browser');
const root='C:\\Users\\Demo\\Downloads',now=new Date().toISOString();
const report={synthetic:true,checks:[],screenshots:[],measurements:[],requests:[],errors:[],limitations:['Synthetic retained tree, not a full-drive indexing benchmark.','No live scan, file read, or cleanup.','Headless Edge; physical devices and screen readers were not tested.']};
function inventory(){
 const children=[];let serial=0;
 for(let folder=0;folder<100;folder++){
  const name=`Folder ${String(folder).padStart(3,'0')}`,folderPath=root+'\\'+name,files=[];
  for(let i=0;i<(folder===99?248:249);i++){
   const index=serial++,extension=['.zip','.mp4','.txt','.gguf'][index%4],name=`Item ${String(index).padStart(5,'0')}${extension}`;
   const unknown=index===20,alias=index===21,size=unknown?null:alias?0:100000+index;
   files.push({name,path:folderPath+'\\'+name,kind:'file',size,logical_size:alias?500000:size,size_known:!unknown,allocated_size:unknown?null:size,allocated_partial:unknown,hardlink_duplicate:alias,files:1,modified_at:now,extension});
  }
  children.push({name,path:folderPath,kind:'directory',size:files.reduce((n,f)=>n+(f.size||0),0),allocated_size:folder===0?null:files.reduce((n,f)=>n+(f.size||0),0),allocated_partial:folder===0,size_known:true,files:files.length,children:files});
 }
 return {tree:{name:'Downloads',path:root,kind:'directory',size:children.reduce((n,f)=>n+f.size,0),size_known:true,allocated_size:null,allocated_partial:true,files:24899,children},meta:{root,partial:true,files:24899,dirs:100,entries_seen:25000,denied:1,allocation_unknown:1,hardlinks_skipped:1,scan_filters:{excluded_names:['AppData'],follow_links:false,max_entries:50000,max_depth:18,max_seconds:15}}};
}
async function main(){
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const run=await ready(browser,1800),{page,mock}=run,result=inventory();
 const job={id:'a'.repeat(32),host:{id:'fixture-studio',name:'Studio'},operation:'scan',profile:'quick',include_excluded:false,path:root,status:'partial',result_available:true,started_at:now,updated_at:now,finished_at:now,worker_stopped:true,progress:{phase:'complete'},error:null};
 let expired=false;
 await page.route('**/visualizer/jobs**',route=>{
  const request=route.request(),url=new URL(request.url());report.requests.push({path:url.pathname,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null});
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,protocol:'storage-jobs-v1',job,...(url.pathname.endsWith('/results')?{result}:{})})});
 });
 await page.route('**/visualizer/investigate',route=>{
  const body=route.request().postDataJSON();report.requests.push({path:'/visualizer/investigate',method:'POST',body});
  return route.fulfill({status:expired?410:200,contentType:'application/json',body:JSON.stringify(expired?{detail:'Retained results expired. Start a new scan when ready.'}:{ok:true,protocol:'storage-investigation-v1',local_only:true,evidence:{job_id:job.id,root,selected_path:body.selected_path,selection:{path:body.selected_path}},reply:'This explanation uses recorded metadata. Ownership and cleanup safety are unknown. No contents were read.',recommendations:[]})});
 });
 const check=async(name,fn)=>{try{await fn();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:error.stack,layout:await page.evaluate(()=>({window:innerWidth,document:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,bench:document.getElementById('fs-map-workbench').getBoundingClientRect().toJSON(),dataset:{...document.getElementById('fs-map-workbench').dataset}}))});await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;}finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}};
 const capture=async name=>{const file=path.join(output,name+'.png');await page.locator('#storage-results').scrollIntoViewIfNeeded();await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);};
 try{
  await check('25,000 retained nodes mount a bounded tree with split panes',async()=>{
   const start=Date.now();await page.locator('#visualizerPathInput').fill(root);await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().observation);
   await page.waitForSelector('.fs-tree-row');
   const data=await page.evaluate(()=>({mounted:document.querySelectorAll('.fs-tree-row').length,total:document.getElementById('fs-tree-table').getAttribute('aria-rowcount'),layout:document.getElementById('fs-map-workbench').dataset.layout,width:document.getElementById('fs-map-workbench').clientWidth}));
   report.measurements.push({initialRenderMs:Date.now()-start,...data});assert.equal(data.layout,'split');assert.ok(data.mounted<80);assert.equal(await page.locator('#fs-tree-splitter').getAttribute('aria-valuenow'),'60');
   await page.locator('#fs-tree-expand').click();await page.waitForTimeout(100);
   assert.ok(await page.locator('.fs-tree-row').count()<80);
   const scroll=await page.locator('#fs-table-wrap').evaluate(e=>{e.scrollTop=e.scrollHeight;return e.scrollHeight;});assert.ok(scroll>1000000);await page.waitForTimeout(100);assert.ok(await page.locator('.fs-tree-row').count()<80);
   report.measurements.push({expandedRows:await page.locator('#fs-tree-table').getAttribute('aria-rowcount'),scrollHeight:scroll});
   await page.locator('#fs-tree-collapse').click();await capture('desktop-linked');
  });
  await check('Selection, disclosure, keyboard and map share the same retained item',async()=>{
   await page.locator('#fs-table-wrap').evaluate(e=>e.scrollTop=0);await page.waitForTimeout(100);
   const folder=page.locator('.fs-tree-row').first();await folder.locator('.fs-file-name').click();const selected=await page.locator('#visualizerDetailsPath').innerText();
   await folder.locator('.fs-tree-toggle').click();assert.equal(await page.locator('#visualizerDetailsPath').innerText(),selected);
   await page.locator('.fs-tree-row').first().focus();await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('fs-tree-row')),true);
   const tile=page.locator('.fs-map-item[data-map-key]:not([data-map-key="display-remainder"])').first();await tile.dispatchEvent('click');assert.ok(await page.locator('.fs-tree-row.fs-is-selected').count()===1);assert.ok(await page.locator('.fs-map-item.fs-is-selected').count()>=1);
   await page.locator('#fs-tree-table th[data-sort="name"] button').click();assert.equal(await page.locator('.fs-tree-row.fs-is-selected').count(),1);
  });
  await check('Extension filters keep ancestors and the distribution visible without changing recorded totals',async()=>{
   const total=await page.locator('#vis4-summary').innerText();
   await page.locator('#visualizerTypeBars .fs-extension-row').filter({hasText:'.gguf'}).click();
   assert.match(await page.locator('#visualizerTypeBars').innerText(),/\.zip/);assert.equal(await page.locator('#vis4-summary').innerText(),total);
   assert.ok(await page.locator('.fs-tree-row[aria-expanded]').count()>0);assert.match(await page.locator('#visualizerStatusLine').innerText(),/hidden|filtered|matching/i);
   await page.getByRole('button',{name:'Clear Extension: .gguf',exact:true}).click();
  });
  await check('Selected explanations are explicit, scoped and handle expired evidence',async()=>{
   assert.equal(report.requests.filter(r=>r.path==='/visualizer/investigate').length,0);
   await page.locator('.fs-map-item[data-map-key]:not([data-map-key="display-remainder"])').first().dispatchEvent('click');const selected=await page.locator('#visualizerDetailsPath').innerText();
   await page.locator('#fs-selected-explain').click();await page.waitForFunction(()=>document.getElementById('fs-investigation-result').textContent.includes('Ownership'));
   assert.equal(report.requests.filter(r=>r.path==='/visualizer/investigate').at(-1).body.selected_path,selected);
   expired=true;await page.locator('#fs-selected-explain').click();await page.waitForFunction(()=>document.getElementById('fs-investigation-status').textContent.includes('expired'));
   assert.equal(report.requests.filter(r=>r.path==='/visualizer/jobs'&&r.method==='POST').length,1);
   assert.equal(report.requests.some(r=>r.path.includes('cleanup')),false);
  });
  await check('Folder focus and breadcrumbs update the shared scope without scanning',async()=>{
   await page.locator('#fs-tree-collapse').click();await page.locator('#fs-table-wrap').evaluate(e=>e.scrollTop=0);await page.waitForTimeout(100);
   await page.locator('.fs-tree-row .fs-file-name').first().dblclick();assert.ok(await page.locator('#fs-map-breadcrumbs button').count()>1);
   await page.locator('#fs-map-breadcrumbs button').first().click();assert.equal(report.requests.filter(r=>r.path==='/visualizer/jobs'&&r.method==='POST').length,1);
   await page.locator('.fs-tree-row').first().focus();await page.keyboard.press('Enter');assert.ok(await page.locator('#fs-map-breadcrumbs button').count()>1);await page.locator('#fs-map-breadcrumbs button').first().click();
  });
  await check('Pane resizing is keyboard operable and only presentation is persisted',async()=>{
   await page.locator('#fs-tree-splitter').focus();await page.keyboard.press('ArrowLeft');assert.ok(Number(await page.locator('#fs-tree-splitter').getAttribute('aria-valuenow'))<60);
   const stored=await page.evaluate(()=>Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]));assert.ok(!JSON.stringify(stored).includes(root));
  });
  await check('Dark theme, stacked workspace, mobile tabs and 200% zoom retain the selection',async()=>{
   await page.evaluate(()=>applyTheme('midnight'));await page.setViewportSize({width:1280,height:900});await page.waitForTimeout(200);assert.equal(await page.locator('#fs-map-workbench').getAttribute('data-layout'),'stacked');await capture('dark-stacked');
   await page.setViewportSize({width:700,height:900});await page.waitForTimeout(200);assert.equal(await page.locator('#fs-map-workbench').getAttribute('data-layout'),'tabs');
   for(const tab of ['fs-mobile-list','fs-mobile-map','fs-mobile-types'])await page.locator('#'+tab).click();assert.equal(await page.locator('#visualizerTypeBars').isVisible(),true);await capture('narrow-types');
   await page.setViewportSize({width:1600,height:1000});await page.evaluate(()=>document.documentElement.style.zoom='2');await page.waitForTimeout(250);
   assert.equal(await page.locator('#fs-map-workbench').getAttribute('data-layout'),'tabs');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2));await capture('zoom-200');
  });
  await check('Lock clears selections, expanded paths and explanation output',async()=>{
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
   assert.equal(await page.locator('#visualizerDetailsPath').innerText(),'');assert.equal(await page.locator('#visualizerTableBody').innerText(),'');assert.equal(await page.locator('#fs-investigation-result').innerText(),'');
  });
 }finally{report.errors.push(...run.errors);report.requests.push(...mock.records);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
 console.log(JSON.stringify({checks:report.checks.length,passed:report.checks.filter(c=>c.passed).length,output,measurements:report.measurements,errors:report.errors},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
