/* Real SPA with intercepted fixture evidence. No running TLI server or live scan. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {ready}=require('../../scripts/verify_free_space_rebuild_browser.cjs');
const output=path.resolve(__dirname,'../../build_work/storage-inventory/browser');
const root='C:\\Users\\Demo\\Downloads',now=new Date().toISOString();
const metadata={version:1,available:true,indexed_count:123,inspected_entries:123,acquisition_complete:true};
const job={id:'a'.repeat(32),host:{id:'fixture-studio',name:'Studio'},operation:'scan',profile:'quick',path:root,status:'completed',result_available:true,started_at:now,updated_at:now,finished_at:now,progress:{phase:'complete'}};
const result={tree:{name:'Downloads',path:root,size:12,children:[{name:'retained.txt',path:root+'\\retained.txt',size:12}]},meta:{partial:false,entries_seen:121,files:120,representation_limited:true,inventory:metadata}};
const items=Array.from({length:120},(_,index)=>({name:'Indexed file '+String(index).padStart(3,'0')+'.txt',path:root+'\\Indexed file '+String(index).padStart(3,'0')+'.txt',kind:'file',size:120-index,logical_size:120-index,allocated_size:4096,modified_at:now}));
const folder={name:'Projects',path:root+'\\Projects',kind:'directory',size:1000,allocated_size:4096,child_count:1,children_complete:true};
const inside={name:'Nested recording.txt',path:folder.path+'\\Nested recording.txt',kind:'file',size:1000,allocated_size:4096};
const report={synthetic:true,checks:[],requests:[],screenshots:[],errors:[],limitations:['Intercepted synthetic metadata; no live scan or file action.','Headless Edge; physical touch devices and screen readers were not tested.']};
async function main(){
  fs.mkdirSync(output,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});
  const run=await ready(browser,1440),{page}=run;let releaseSlow;
  await page.route('**/visualizer/jobs**',async route=>{
    const request=route.request(),url=new URL(request.url());report.requests.push({path:url.pathname,query:url.search,method:request.method()});let response={ok:true,protocol:'storage-jobs-v1',job,...(url.pathname.endsWith('/results')?{result}:{})};
    if(url.pathname.endsWith('/inventory')){
      const q=url.searchParams,offset=Number(q.get('offset')),mode=q.get('mode');let matches=mode==='children'?(q.get('path')===folder.path?[inside]:[folder,...items]):items;
      if(mode==='search')matches=[...items,inside].filter(item=>item.path.toLowerCase().includes(q.get('q').toLowerCase()));
      if(mode==='extension')matches=q.get('extension')==='.txt'?[...items,inside]:[];
      if(q.get('q')==='delayed-old-query'){await new Promise(resolve=>{releaseSlow=resolve;});matches=[{...items[0],name:'Obsolete response.txt',path:root+'\\Obsolete response.txt'}];}
      // Deliberately short pages exercise byte-capped responses.
      const rows=matches.slice(offset,offset+80);response={version:1,job_id:job.id,root,items:rows,total:matches.length,offset,limit:100,has_more:offset+rows.length<matches.length,meta:metadata};
    }
    try{return await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});}catch(error){if(!/closed|disposed|cancel/i.test(error.message))throw error;}
  });
  await page.route('**/visualizer/investigate',route=>{
    const body=route.request().postDataJSON();report.requests.push({path:'/visualizer/investigate',method:'POST',body});return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,protocol:'storage-investigation-v1',local_only:true,evidence:{root,job_id:job.id,selected_path:body.selected_path},reply:'Selected indexed metadata is available. No file was changed.',recommendations:[]})});
  });
  const check=async(name,fn)=>{await fn();report.checks.push({name,passed:true});};
  const waitRows=count=>page.waitForFunction(count=>TLIFreeSpace.getState().inventory?.rows.length===count&&!TLIFreeSpace.getState().inventory?.busy,count);
  try{
    await check('Completed indexed scans open the primary file browser and page beyond the retained tree',async()=>{
      await page.locator('#visualizerPathInput').fill(root);await page.locator('#visualizerScanBtn').click();await waitRows(80);
      assert.equal(await page.locator('#fs-browser-files').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#fs-inventory').isVisible(),true);assert.equal(report.requests.filter(row=>row.path.endsWith('/inventory')).length,1);
      assert.equal(await page.locator('.fs-inventory-row').count(),80);await page.locator('#fs-inventory-next').click();await page.waitForFunction(()=>TLIFreeSpace.getState().inventory?.offset===80);assert.equal(await page.locator('.fs-inventory-row').count(),41);assert.equal(await page.locator('#fs-inventory-next').isDisabled(),true);
      assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().observation.index.size),2);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().mapView.total),12);
    });
    await check('Indexed selection shares the inspector and Explain without receiving cleanup controls',async()=>{
      await page.locator('.fs-inventory-row .storage-file-action').first().click();const selected=await page.locator('#visualizerDetailsPath').innerText();assert.equal(selected,items[79].path);assert.match(await page.locator('#visualizerDetailsSize').textContent(),/Indexed evidence/);assert.equal(await page.locator('#fs-selected-cleanup input').count(),0);assert.equal(await page.locator('.fs-inventory-row[aria-selected="true"]').count(),1);
      await page.locator('#fs-selected-explain').click();await page.waitForFunction(()=>document.getElementById('fs-investigation-result').textContent.includes('Selected indexed metadata'));assert.equal(report.requests.at(-1).body.selected_path,selected);assert.equal(report.requests.some(row=>row.path.includes('cleanup')),false);
    });
    await check('Search finds off-tree paths while typing and clearing or Escape restores folder contents',async()=>{
      await page.locator('#fs-inventory-query').fill('file 119');await waitRows(1);assert.match(await page.locator('.fs-inventory-row').innerText(),/Indexed file 119/);assert.equal(await page.locator('#visualizerDetailsBar').isVisible(),false);
      await page.locator('#fs-inventory-query').fill('');await waitRows(80);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().inventory.mode),'children');
      await page.locator('#fs-inventory-query').fill('file 119');await page.locator('#fs-inventory-query').press('Enter');await waitRows(1);await page.locator('#fs-inventory-query').press('Escape');await waitRows(80);assert.equal(await page.locator('#fs-inventory-query').inputValue(),'');
    });
    await check('Arrow navigation and context actions keep the selection and visible inspector synchronized',async()=>{
      await page.locator('.fs-inventory-row').first().focus();await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().selected.path),items[0].path);assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('fs-inventory-row')),true);
      await page.keyboard.press('End');assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().selected.path),items[78].path);await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().selected.path),folder.path);
      await page.locator('.fs-inventory-row .storage-file-action').filter({hasText:'Indexed file 001.txt'}).click({button:'right'});await page.keyboard.press('Escape');assert.equal(await page.locator('#visualizerDetailsPath').innerText(),items[1].path);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().selected.path),items[1].path);
    });
    await check('Enter opens indexed folders and breadcrumbs return without rescanning',async()=>{
      await page.locator('.fs-inventory-row').first().focus();await page.keyboard.press('Enter');await waitRows(1);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().inventory.path),folder.path);assert.match(await page.locator('.fs-inventory-row').innerText(),/Nested recording/);
      await page.locator('#fs-inventory-breadcrumbs button').first().click();await waitRows(80);assert.equal(await page.evaluate(()=>TLIFreeSpace.getState().inventory.path),root);assert.equal(report.requests.filter(row=>row.path==='/visualizer/jobs'&&row.method==='POST').length,1);
    });
    await check('Files, Largest files, and Map & tree use the same recorded scan',async()=>{
      await page.locator('#fs-browser-largest').click();await page.waitForFunction(()=>TLIFreeSpace.getState().inventory?.mode==='largest'&&!TLIFreeSpace.getState().inventory?.busy);assert.equal(await page.locator('#fs-browser-largest').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.fs-inventory-row').count(),80);
      await page.locator('#fs-browser-tree').click();assert.equal(await page.locator('#fs-inventory').isVisible(),false);assert.equal(await page.locator('#fs-table-wrap').isVisible(),true);await page.locator('#fs-browser-files').click();await waitRows(80);assert.equal(report.requests.filter(row=>row.path==='/visualizer/jobs'&&row.method==='POST').length,1);
    });
    await check('New search supersedes delayed responses and zero matches cannot retain an old selection',async()=>{
      await page.locator('.fs-inventory-row .storage-file-action').first().click();await page.locator('#fs-inventory-query').fill('delayed-old-query');await page.locator('#fs-inventory-query').press('Enter');
      for(let i=0;i<50&&!releaseSlow;i++)await page.waitForTimeout(20);assert.equal(typeof releaseSlow,'function');assert.equal(await page.locator('#visualizerDetailsBar').isVisible(),false);
      await page.locator('#fs-inventory-query').fill('no-such-recorded-path');await page.locator('#fs-inventory-query').press('Enter');await waitRows(0);releaseSlow();releaseSlow=null;await page.waitForTimeout(100);assert.equal(await page.locator('.fs-inventory-row').count(),0);assert.match(await page.locator('#fs-inventory-status').innerText(),/No .*match|0.*matches/i);assert.equal(await page.locator('#visualizerDetailsBar').isVisible(),false);
      await page.locator('#fs-inventory-query').press('Escape');await waitRows(80);
    });
    await check('Desktop and phone layouts keep inventory controls inside the viewport',async()=>{
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:1000});await page.waitForTimeout(150);if(await page.locator('#fs-mobile-list').isVisible())await page.locator('#fs-mobile-list').click();await page.locator('#fs-inventory').scrollIntoViewIfNeeded();
        const geometry=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,overflow:[...document.querySelectorAll('#fs-inventory button,#fs-inventory input,#fs-inventory select')].filter(node=>node.checkVisibility()).filter(node=>{const bounds=node.getBoundingClientRect();return bounds.left<0||bounds.right>innerWidth+1;}).map(node=>node.id)}));assert.equal(geometry.overflow.length,0,JSON.stringify(geometry));assert.ok(geometry.document<=geometry.viewport+2,JSON.stringify(geometry));
        const file=path.join(output,'inventory-'+width+'.png');await page.locator('#fs-inventory').screenshot({path:file});report.screenshots.push(file);
      }
    });
    await check('Phone selection opens a reachable sheet and closing returns focus to its row',async()=>{
      for(const width of [390,320]){
        await page.setViewportSize({width,height:720});await page.waitForTimeout(100);await page.locator('#fs-mobile-list').click();
        await page.locator('.fs-inventory-row .storage-file-action').nth(1).click();
        const geometry=await page.locator('#visualizerDetailsBar').evaluate(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:innerWidth,height:innerHeight};});
        assert.ok(geometry.top>=0&&geometry.bottom<=geometry.height-70&&geometry.left>=0&&geometry.right<=geometry.width,JSON.stringify(geometry));
        assert.equal(await page.locator('#fs-selected-explain').isVisible(),true);const file=path.join(output,'selection-'+width+'.png');await page.screenshot({path:file});report.screenshots.push(file);
        await page.locator('#fs-selected-close').click();assert.equal(await page.locator('#visualizerDetailsBar').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('fs-inventory-row')),true);
      }
    });
    await check('Partial largest-file results warn visibly that larger files may be missing',async()=>{
      result.meta.partial=true;result.meta.time_limited=true;metadata.acquisition_complete=false;
      await page.setViewportSize({width:1440,height:1000});await page.locator('#visualizerScanBtn').click();await waitRows(80);
      await page.locator('#fs-browser-largest').click();await page.waitForFunction(()=>TLIFreeSpace.getState().inventory?.mode==='largest'&&!TLIFreeSpace.getState().inventory?.busy);
      assert.equal(await page.locator('#fs-inventory-warning').isVisible(),true);assert.match(await page.locator('#fs-inventory-warning').innerText(),/larger files may be missing.*time limit/);
      assert.doesNotMatch(await page.locator('#fs-inventory-status').innerText(),/limited by response size/);
    });
    await check('Session lock clears indexed paths, search text and selection',async()=>{
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#fs-inventory-rows').textContent(),'');assert.equal(await page.locator('#fs-inventory-query').inputValue(),'');assert.equal(await page.locator('#visualizerDetailsPath').textContent(),'');
    });
  }catch(error){report.errors.push(error.stack);await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;}
  finally{if(releaseSlow)releaseSlow();report.errors.push(...run.errors);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
  console.log(JSON.stringify({checks:report.checks.length,errors:report.errors,output},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
