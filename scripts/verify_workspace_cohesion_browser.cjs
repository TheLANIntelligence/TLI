/* Cohesive real SPA views from a frozen source, with every request intercepted. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {dashboardPage}=require('./verify_dashboard_workspace_browser.cjs');
const {jobs}=require('./verify_free_space_rebuild_browser.cjs');
const {layout,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {textScale}=require('./verify_anniversary_themes_browser.cjs');
const root=path.resolve(__dirname,'..'),before=process.argv.includes('--before'),quick=process.argv.includes('--quick');
const out=path.join(root,'build_work/workspace-cohesion',`${before?'before':'after'}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(out,{recursive:true});
const record={source,before,synthetic:true,started_at:new Date().toISOString(),source_before:fingerprintFiles(source),views:[],checks:[],errors:[],limitations:['Headless Edge, synthetic accounts/files/processes and intercepted requests only. No live scans, diagnostics, cleanup, inference or host restarts.','Physical phones, native platforms and screen-reader acceptance are not run.']};
const panels=[['dashboard','panel-dashboard2'],['troubleshooting','panel-troubleshooting'],['free-space','panel-visualizer'],['performance','panel-games']];
async function capture(page,name){await page.evaluate(()=>{for(const el of document.querySelectorAll('*'))if(el.scrollTop)el.scrollTop=0;});await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});return name+'.png';}
async function fixtures(run){
 const calls=[];const now=new Date().toISOString();
 await run.page.route('**/api/intelligence/**',route=>{
  const req=route.request(),p=new URL(req.url()).pathname;
  if(!p.startsWith('/api/intelligence/cases')&&!p.startsWith('/api/intelligence/performance')&&p!=='/api/intelligence/devices')return route.fallback();
  calls.push({method:req.method(),path:p});
  if(req.method()!=='GET')return route.fulfill({status:409,json:{detail:'Unexpected operation refused'}});
  if(p==='/api/intelligence/devices')return route.fulfill({json:{devices:[{id:'host-studio',name:'Studio',kind:'computer',source:'local_node',source_id:'fixture-studio'}]}});
  if(p.startsWith('/api/intelligence/cases'))return route.fulfill({json:{ok:true,protocol:'tli-cases-v1',actions_performed:false,items:[],total:0,checked_at:now,next_check:'tli-case-next-check-v1',case_context:'tli-case-context-v1',case_report_context:'tli-case-report-context-v1',max_case_reports:1}});
  return route.fulfill({json:{ok:true,protocol:'tli-performance-v1',checked_at:now,observations:[],duration_seconds:30,processes:[]}});
 });
 return calls;
}
async function main(){
 const browser=await chromium.launch({channel:'msedge',headless:true});record.browser=browser.version();
 try {
  for(const width of quick?[1440,390]:[1920,1440,1024,390,320])for(const theme of ['emeraldLight','midnight'])for(const mode of quick?['modern']:['modern','classic']){
   const run=await dashboardPage(browser,width,theme,'critical'),{page}=run;
   const other=await fixtures(run),storage=await jobs(page);await page.evaluate(mode=>TLIInterface.set(mode),mode);
   try{
    for(const[name,panel]of panels){
     await page.evaluate(panel=>switchPanel(panel),panel);await page.waitForTimeout(220);
     if(name==='troubleshooting'){
      assert.equal(await page.locator('#troubleshooting-status').evaluate(e=>e.classList.contains('error')),false,'Synthetic saved-problem list must load');
      if(!before)assert.equal(await page.locator('#troubleshooting-symptom').isVisible(),true,'First open offers an unsaved symptom draft');
     }
     if(name==='free-space'){
      await page.locator('#visualizerPathInput').fill('C:\\Users\\Demo\\Downloads');
      await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().observation);
     }
     const measured=await layout(page,panel),shot=await capture(page,`${name}-${width}-${theme}-${mode}`);
     record.views.push({name,panel,width,theme,mode,shot,...measured});
     if(name==='free-space'){
      await page.locator('#storage-results').evaluate(e=>e.scrollIntoView({block:'start'}));
      await page.screenshot({path:path.join(out,`map-${width}-${theme}-${mode}.png`),fullPage:true});
     }
     if(!before){
      assert.equal(measured.overflow.length,0,JSON.stringify(measured.overflow));assert.ok(measured.documentWidth<=width+2);assert.equal(measured.duplicateIds.length,0);
      if(mode==='modern'&&width>=1024){
       const geometry=await page.evaluate(panel=>{const p=document.getElementById(panel),title=p.querySelector('.ui-page-header'),body=p.querySelector('.nd-wrap,#troubleshooting-workspace,.fs-layout,.performance-workspace'),main=document.querySelector('.main-scroll');return{title:title?.getBoundingClientRect().x,body:body?.getBoundingClientRect().x,shell:main.getBoundingClientRect().x+parseFloat(getComputedStyle(main).paddingLeft)};},panel);
       assert.ok(Math.abs(geometry.title-geometry.body)<=2,`${name} header/workspace alignment: ${JSON.stringify(geometry)}`);
       assert.ok(Math.abs(geometry.title-geometry.shell)<=2,`${name} shared shell alignment: ${JSON.stringify(geometry)}`);
      }
      if(width===320){await textScale(page,panel,true);record.views.push({name,panel,width,theme,mode,state:'text200',...await layout(page,panel)});await capture(page,`${name}-text200-${width}-${theme}-${mode}`);await textScale(page,panel,false);}
     }
    }
    assert.equal(storage.starts().length,1,'One explicit synthetic scan');
    assert.equal([...run.state.calls,...other,...run.calls].filter(c=>!['GET','HEAD'].includes(c.method)).length,0,'Navigation sent an unintended mutation');
    if(!before){
     await page.evaluate(()=>switchPanel('panel-dashboard2'));await page.waitForTimeout(50);
     const labels=await page.locator('#device-name-chip,#footer-device,#ndv-node-val,#node-switcher-label').allTextContents();assert.ok(labels.every(s=>s==='Studio'),labels.join('|'));
     run.state.locked=true;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
     assert.equal(await page.locator('#dashboard-access').isVisible(),true);assert.equal(await page.locator('#activity-catchup').isVisible(),false);assert.equal(await page.locator('#dashboard-places-mount').isVisible(),false);
     const cleared=await page.locator('#device-name-chip,#footer-device,#ndv-node-val,#node-switcher-label').allTextContents();assert.ok(cleared.every(s=>s==='Not confirmed'),cleared.join('|'));
    }
    record.checks.push({width,theme,mode,passed:true});record.errors.push(...run.errors);
   }finally{await run.context.close();}
  }
  record.source_after=fingerprintFiles(source);record.sourceUnchanged=JSON.stringify(record.source_before)===JSON.stringify(record.source_after);
  assert.ok(record.sourceUnchanged,'Source changed while capturing candidate');assert.equal(record.errors.length,0,JSON.stringify(record.errors));
  if(!before)assert.equal(record.views.filter(v=>v.overflow.length||v.documentWidth>v.width+2).length,0,'Layout overflow');
  record.passed=true;
 }catch(error){record.passed=false;record.error=error.stack;process.exitCode=1;}
 finally{await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(record,null,2));console.log(JSON.stringify({out,passed:record.passed,views:record.views.length,checks:record.checks.length,error:record.error}));}
}
main();
