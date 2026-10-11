/* Bounded large-result coverage through current job APIs. All responses are synthetic. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
process.argv.push('--label','storage-large');
const {layout,out,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {ready,scan}=require('./verify_free_space_rebuild_browser.cjs');
const rootPath='C:\\Users\\Demo\\Documents\\Annual archive',fileCount=500;
const folders=Array.from({length:10},(_,group)=>{
 const name=`Collection ${String(group).padStart(2,'0')} — Annual recordings and supporting production material`,folderPath=rootPath+'\\'+name;
 const nestedName='Reviewed exports and their original supporting documents',nestedPath=folderPath+'\\'+nestedName;
 const children=Array.from({length:50},(_,offset)=>{const index=group*50+offset,extension=index%2===0?'jpg':'zip';
  const name=`${index===42?'needle-042':`record-${String(index).padStart(3,'0')}`} — Complete production reference with a deliberately long descriptive filename for review.${extension}`;
  return{name,path:nestedPath+'\\'+name,size:(index+1)*1024**2};});
 const size=children.reduce((n,c)=>n+c.size,0);return{name,path:folderPath,size,children:[{name:nestedName,path:nestedPath,size,children}]};
});
const tree={name:'Annual archive',path:rootPath,size:folders.reduce((n,f)=>n+f.size,0),children:folders};
async function main(){
 const hashesAtStart=fingerprintFiles(source),records=[],sessions=[],screenshots=[];
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [1440,320])for(const theme of ['emeraldLight','midnight']){
  const run=await ready(browser,width,theme),page=run.page,requests=[];
  const result=scan(rootPath);result.tree=tree;result.largest=[];Object.assign(result.meta,{files:500,dirs:20,partial:false,denied:0});
  let job;await page.route('**/visualizer/jobs**',route=>{const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),path:url.pathname});
   if(request.method()==='POST'){const body=request.postDataJSON();job={id:'a'.repeat(32),host:{id:'fixture-studio',name:'Studio'},operation:body.operation,profile:body.profile,path:body.path,status:'completed',result_available:true,started_at:'2026-09-11T12:00:00Z',updated_at:'2026-09-11T12:00:00Z',finished_at:'2026-09-11T12:00:00Z',progress:{phase:'completed'},include_excluded:false};}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,protocol:'storage-jobs-v1',job,...(url.pathname.endsWith('/results')?{result}:{})})});});
  try{
   await page.locator('#visualizerPathInput').fill(rootPath);await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>!!TLIFreeSpace.getState().observation);
   if(width===320)await page.locator('#fs-mobile-list').click();
   const rows=page.locator('#visualizerTableBody .storage-file-action');assert.equal(await rows.count(),50);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.rows.length),500);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.total),tree.size);
   async function record(phase){const measured={width,theme,phase,...await layout(page,'panel-visualizer')};records.push(measured);assert.equal(measured.overflow.length,0,JSON.stringify(measured.overflow));assert.equal(measured.duplicateIds.length,0);assert.ok(measured.documentWidth<=width+2);await page.locator('#fs-map-workbench').scrollIntoViewIfNeeded();const file=path.join(out,`${phase}-${width}-${theme}.png`);await page.screenshot({path:file});screenshots.push(file);}
   const wrap=page.locator('#fs-table-wrap');
   const bounded=await wrap.evaluate(el=>({height:el.clientHeight,content:el.scrollHeight,tabindex:el.tabIndex,label:el.getAttribute('aria-label')}));
   assert.ok(bounded.height>=240&&bounded.height<=562,JSON.stringify(bounded));assert.ok(bounded.content>bounded.height*2);assert.equal(bounded.tabindex,0);assert.ok(bounded.label);
   await wrap.focus();await page.keyboard.press('PageDown');await page.waitForFunction(()=>document.getElementById('fs-table-wrap').scrollTop>100);
   await wrap.evaluate(el=>el.scrollTop=el.scrollHeight);
   const sticky=await wrap.evaluate(el=>({top:el.getBoundingClientRect().top,header:el.querySelector('th').getBoundingClientRect().top}));assert.ok(Math.abs(sticky.top-sticky.header)<=2,JSON.stringify(sticky));
   const savedScroll=await wrap.evaluate(el=>el.scrollTop);
   await page.evaluate(()=>{switchPanel('panel-settings');switchPanel('panel-visualizer');});
   assert.ok(Math.abs(await wrap.evaluate(el=>el.scrollTop)-savedScroll)<=2,'Returning to Free Space preserves list scroll');
   await wrap.evaluate(el=>el.scrollTop=0);await record('500-retained-50-mounted');
   // A map selection may be below the visible rows, including a different page.
   if(width===320)await page.locator('#fs-mobile-map').click();
   await page.evaluate(()=>{
    const selected=TLIFreeSpace.getState().mapView.rows.find(item=>item.name.startsWith('record-424'));
    const tile=[...document.querySelectorAll('.fs-map-item')].find(el=>el.dataset.mapKey===selected.path);
    if(!tile)throw Error('Expected a real file tile');
    tile.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
   });
   if(width===320)await page.locator('#fs-mobile-list').click();
   const selected=await wrap.evaluate(el=>{const box=el.getBoundingClientRect(),row=el.querySelector('.fs-is-selected').getBoundingClientRect();return{scroll:el.scrollTop,top:row.top,bottom:row.bottom,visibleTop:box.top+el.querySelector('thead').getBoundingClientRect().height,visibleBottom:box.bottom};});
   assert.ok(selected.scroll>0&&selected.top>=selected.visibleTop-2&&selected.bottom<=selected.visibleBottom+2,JSON.stringify(selected));
   assert.match(await page.locator('#fs-page-label').innerText(),/51–100 of 500/);
   await page.locator('#fs-page-prev').click();assert.equal(await wrap.evaluate(el=>el.scrollTop),0,'Changing pages resets list scroll');
   await page.locator('#fs-page-next').click();assert.match(await page.locator('#fs-page-label').innerText(),/51–100 of 500/);assert.equal(await wrap.evaluate(el=>el.scrollTop),0);
   await page.locator('#fs-explorer-filters summary').click();await page.locator('#visualizerSearchInput').fill('needle-042');assert.equal(await rows.count(),1);
   await rows.first().focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#visualizerDetailsPath').innerText(),folders[0].children[0].children[42].path);assert.equal(await page.locator('#visualizerSendToFilesBtn').isEnabled(),true);await record('long-path-selection');
   await page.locator('#visualizerSearchInput').fill('.jpg');assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.rows.length),250);
   await page.locator('#visualizerCategoryFilter').selectOption('Images');await page.locator('#visualizerMinSize').selectOption('104857600');assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.rows.length),200);assert.ok((await rows.allTextContents()).every(name=>name.endsWith('.jpg')));
   await page.locator('#visualizerCategoryFilter').selectOption('all');await page.locator('#visualizerMinSize').selectOption('0');await page.locator('#visualizerSearchInput').fill('Collection 07');assert.equal(await rows.count(),50);
   await page.locator('#visualizerSearchInput').fill('no-such-synthetic-file');assert.equal(await rows.count(),0);assert.match(await page.locator('#visualizerTableBody').innerText(),/No entries match/);await page.locator('#visualizerSearchInput').fill('');await page.locator('#fs-explorer-filters summary').click();
   await page.locator('[data-mode="folders"]').click();const folder=rows.filter({hasText:'Collection 07'});await folder.first().focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'visualizerCenterTitle');
   await rows.first().focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'visualizerCenterTitle');assert.match(await page.locator('#fs-map-breadcrumbs').innerText(),/Collection 07[\s\S]*Reviewed exports/);
   await page.locator('[data-mode="files"]').click();assert.equal(await rows.count(),50);await record('nested-keyboard-folder');
   for(let i=0;i<2;i++){await page.locator('#visualizerBackBtn').focus();await page.keyboard.press('Enter');}assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.rows.length),500);
   assert.deepEqual(requests,[{method:'POST',path:'/visualizer/jobs'},{method:'GET',path:'/visualizer/jobs/'+'a'.repeat(32)+'/results'}],'Selection, filters and cached zoom must not make requests');assert.deepEqual(run.errors,[]);sessions.push({width,theme,fileCount,requests,errors:run.errors});
  }finally{await run.context.close();}
 }}finally{await browser.close();}
 const hashes=fingerprintFiles(source),changedDuringRun=[...new Set([...Object.keys(hashesAtStart),...Object.keys(hashes)])].filter(file=>hashesAtStart[file]!==hashes[file]);
 fs.writeFileSync(path.join(out,'large-results-report.json'),JSON.stringify({source,synthetic:true,fileCount,hashes,changedDuringRun,sessions,records,screenshots},null,2));
 console.log(JSON.stringify({out,checks:records.length,fileCount,changedDuringRun}));assert.equal(changedDuringRun.length,0);
}
if(require.main===module)main().catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),error.stack);console.error(error);process.exitCode=1;});
