/* Real SPA with synthetic storage jobs. No TLI server, file scan or cleanup action. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {ready}=require('../../scripts/verify_free_space_rebuild_browser.cjs');
const output=path.resolve(__dirname,'../../build_work/free-space-scan-controls/browser');
const report={synthetic:true,checks:[],geometry:[],screenshots:[],errors:[],limitations:['Intercepted synthetic responses; no live scan or file action.','Headless Edge; physical touch and screen readers were not tested.']};
const check=async(name,fn)=>{await fn();report.checks.push({name,passed:true});};
const waitDrives=page=>page.waitForFunction(()=>document.querySelectorAll('#vis4-drives [data-mount]').length===12);
async function screenshot(page,name){
  await page.evaluate(()=>{document.querySelectorAll('*').forEach(node=>{if(node.scrollTop)node.scrollTop=0;});window.scrollTo(0,0);});
  const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);
}
async function geometry(page,name,width){
  const value=await page.evaluate(()=>{
    const visible=node=>node.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})&&!node.closest('[hidden],.hidden');
    const overflow=[...document.querySelectorAll('#panel-visualizer button,#panel-visualizer input,#panel-visualizer select')].filter(visible).filter(node=>{const r=node.getBoundingClientRect();return r.left< -2||r.right>innerWidth+2;}).map(node=>({id:node.id,text:node.textContent.slice(0,30)}));
    return {documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,heroHeight:document.querySelector('.fs-location-hero').getBoundingClientRect().height,overflow};
  });
  report.geometry.push({name,width,...value});assert.equal(value.overflow.length,0,JSON.stringify({name,width,...value}));assert.ok(value.documentWidth<=width+2,JSON.stringify(value));return value;
}
async function workflow(browser){
  const run=await ready(browser,1440),{page,mock}=run;let releaseStart;
  try{
    await waitDrives(page);
    await check('Entry has a compact always-visible scan row and collapsed secondary controls',async()=>{
      assert.equal(await page.locator('#fs-locations').evaluate(node=>node.open),false);
      for(const id of ['visualizerPathInput','fs-profile','visualizerScanBtn'])assert.equal(await page.locator('#'+id).isVisible(),true,id);
      assert.equal(await page.locator('#fs-more-tools').evaluate(node=>node.open),false);
      assert.equal(await page.locator('.fs-workspace-tools').evaluate(node=>!!node.closest('#fs-more-tools')),true);
      assert.equal(await page.locator('#fs-show-changes').isVisible(),false);
      assert.equal(await page.locator('.fs-policy').evaluate(node=>node.open),false);
      assert.equal(mock.starts().length,0);
      const measured=await geometry(page,'initial',1440);assert.ok(measured.heroHeight<=220,JSON.stringify(measured));
    });
    await check('The twelve-drive picker closes after choosing a target and starts no job',async()=>{
      await page.locator('#fs-locations > summary').click();
      assert.equal(await page.locator('#vis4-drives [data-mount]').count(),12);
      await page.locator('#vis4-drives [data-mount="C:\\\\"]').click();
      assert.equal(await page.locator('#visualizerPathInput').inputValue(),'C:\\');
      assert.equal(await page.locator('#fs-locations').evaluate(node=>node.open),false);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'visualizerPathInput');
      await page.locator('#fs-profile').selectOption('deep');
      await page.locator('.fs-policy > summary').click();assert.equal(await page.locator('#fs-include-excluded').isEnabled(),true);
      await page.locator('#fs-profile').selectOption('quick');assert.equal(await page.locator('#fs-include-excluded').isEnabled(),false);
      assert.equal(mock.starts().length,0);
    });
    await check('A pending or running scan has one progress surface with no stale idle prompt',async()=>{
      let arrived;const arrival=new Promise(resolve=>{arrived=resolve;});
      const gate=new Promise(resolve=>{releaseStart=resolve;});
      await page.route('**/visualizer/jobs',async route=>{if(route.request().method()==='POST'){arrived();await gate;}return route.fallback();});
      mock.config.hold=true;await page.locator('#fs-locations > summary').click();
      await page.locator('#visualizerScanBtn').click();await arrival;
      assert.equal(await page.locator('#fs-empty').isVisible(),false);assert.equal(await page.locator('#fs-job').isVisible(),true);
      assert.equal(await page.locator('#fs-locations').evaluate(node=>node.open),false);
      assert.equal(await page.locator('.fs-policy').evaluate(node=>node.open),false);
      assert.doesNotMatch(await page.locator('#visualizerStatus').textContent(),/Location selected; no scan has run/);
      releaseStart();releaseStart=null;await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='running');
      assert.equal(await page.locator('#visualizerScanBtn').innerText(),'Scanning…');
      assert.equal(await page.locator('#fs-job-stop').isVisible(),true);
      assert.match(await page.locator('#fs-job-title').textContent(),/C:\\/);
      await page.locator('#visualizerPathInput').fill('L:\\');
      assert.match(await page.locator('#fs-job-title').textContent(),/C:\\/,'The running job retains its actual path when the next target changes');
      assert.equal(await page.locator('#fs-empty').isVisible(),false);
      assert.equal(mock.starts().length,1);
    });
    await check('Cancellation preserves explicit partial-result review and never resubmits',async()=>{
      await page.locator('#fs-job-stop').click();await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='cancelled'&&!TLIFreeSpace.getState().busy);
      assert.equal(await page.locator('#storage-results').isVisible(),false);
      assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().observation),null);
      const partial=page.getByRole('button',{name:'View partial results',exact:true});assert.equal(await partial.isVisible(),true);
      await page.locator('#visualizerPathInput').fill('C:\\');await partial.click();await page.waitForFunction(()=>TLIFreeSpace.getState().observation);
      assert.equal(await page.locator('#storage-results').isVisible(),true);assert.equal(mock.starts().length,1);
      assert.equal(await page.locator('#visualizerScanBtn').innerText(),'Scan again');
    });
    await check('A replacement scan keeps matching recorded results available',async()=>{
      const previous=await page.evaluate(()=>TLIFreeSpace.getState().observation.job.id);
      await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='running');
      assert.equal(await page.locator('#storage-results').isVisible(),true);assert.equal(await page.locator('#fs-empty').isVisible(),false);
      assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().observation.job.id),previous);
      await page.locator('#fs-job-stop').click();await page.waitForFunction(()=>!TLIFreeSpace.getState().busy&&TLIFreeSpace.getState().job?.status==='cancelled');
    });
  }finally{if(releaseStart)releaseStart();report.errors.push(...run.errors);await run.context.close();}
}
async function rejectionAndHandoff(browser){
  const run=await ready(browser,1440),{page,mock}=run;
  try{
    await check('Prepared locations reuse scan controls without adding a duplicate context card',async()=>{
      for(const observation of [null,{id:'earlier-observation',recordedAt:'2026-09-09T12:00:00Z',coverage:'Partial scan'}]){
        const result=await page.evaluate(observation=>TLIStorageWorkspace.prepare({view:'space',root:'L:\\',observation}),observation);
        assert.equal(result.status,'prepared');assert.equal(await page.locator('#visualizerPathInput').inputValue(),'L:\\');
        assert.equal(await page.locator('#storage-context-space').count(),0);assert.equal(mock.starts().length,0);
      }
    });
    await check('Rejected starts return to a usable scan row and retain the explanation',async()=>{
      mock.config.failStart=true;await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>!TLIFreeSpace.getState().busy&&!TLIFreeSpace.getState().pendingStart);
      assert.equal(await page.locator('#visualizerScanBtn').isEnabled(),true);assert.equal(await page.locator('#visualizerScanBtn').innerText(),'Scan');
      assert.equal(await page.locator('#fs-empty').isVisible(),true);assert.match(await page.locator('#visualizerStatus').textContent(),/rejected/);
      assert.equal(mock.starts().length,1);
    });
  }finally{report.errors.push(...run.errors);await run.context.close();}
}
async function appearances(browser){
  for(const width of [1920,1440,390,320]){
    const run=await ready(browser,width),{page,mock}=run;
    try{
      await waitDrives(page);
      await check(`Scan controls, expanded drive choices and long paths fit ${width}px`,async()=>{
        await page.evaluate(()=>TLIStorageWorkspace.prepare({view:'space',root:'L:\\'}));
        const idle=await geometry(page,'idle',width);if(width>=1440)assert.ok(idle.heroHeight<=220,JSON.stringify(idle));
        await screenshot(page,'after-idle-'+width);
        await page.locator('#fs-locations > summary').click();await geometry(page,'picker',width);await screenshot(page,'after-picker-'+width);
        await page.locator('#fs-locations > summary').click();
        const longPath='L:\\Projects\\'+Array(8).fill('A long folder name for a recorded media project').join('\\');
        await page.locator('#visualizerPathInput').fill(longPath);await geometry(page,'long-path',width);
        mock.config.hold=true;await page.locator('#visualizerScanBtn').click();await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='running');
        assert.equal(await page.locator('#fs-empty').isVisible(),false);
        const running=await geometry(page,'running-long-path',width);assert.ok(running.heroHeight<=400,`Long running paths must not crowd out controls: ${JSON.stringify(running)}`);
        const heading=await page.locator('#fs-job-title').boundingBox();assert.ok(heading.height<=43,`The running path should occupy at most two lines: ${JSON.stringify(heading)}`);
        assert.ok((await page.locator('#fs-job-title').textContent()).includes(longPath),'The full path remains available to assistive technology');
        await screenshot(page,'after-running-'+width);
        await page.locator('#fs-job-stop').click();await page.waitForFunction(()=>TLIFreeSpace.getState().job?.status==='cancelled');
      });
    }finally{report.errors.push(...run.errors);await run.context.close();}
  }
}
async function main(){
  fs.mkdirSync(output,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});
  try{await workflow(browser);await rejectionAndHandoff(browser);await appearances(browser);}
  catch(error){report.errors.push(error.stack);throw error;}
  finally{await browser.close();report.passed=report.errors.length===0;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));console.log(JSON.stringify({checks:report.checks.length,geometry:report.geometry.length,errors:report.errors,output},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
