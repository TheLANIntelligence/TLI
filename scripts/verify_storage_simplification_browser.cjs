/* Real SPA with synthetic intercepted file APIs. Never connects to a TLI host. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
if(!process.argv.includes('--label'))process.argv.push('--label','storage-simplification');
const {makePage,layout,fixtures,source}=require('./verify_anniversary_ui_browser.cjs');
const output=path.resolve(__dirname,'../build_work/simplification/storage-browser',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const storageFiles=['frontend/js/files.js','frontend/js/storage-workspace.js','frontend/js/visualizer.js','frontend/js/saved-places.js','frontend/file-operations.css'];
const hashes=()=>Object.fromEntries(storageFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(source,file))).digest('hex')]));
const report={source,output,synthetic:true,hashesAtStart:hashes(),behaviors:[],layouts:[],screenshots:[],sessions:[],failures:[],limitations:[
  'Host/file APIs are intercepted synthetic responses. No household file listing, move, rename, Trash operation or live TLI server is used.',
  'Browser viewports simulate desktop and narrow screens; physical-device, native-app and screen-reader acceptance are not claimed.',
  'Only storage source hashes are held stable because other release work may run concurrently.'
]};
const root='C:\\Synthetic\\Storage',incoming='D:\\Synthetic\\Incoming';
const longName='photo-'+('long-name-'.repeat(14))+'final.jpg';
const buckets={Documents:Array.from({length:498},(_,i)=>`document-${String(i).padStart(3,'0')}.txt`),Images:['photo.jpg',longName],Archives:['backup.zip']};
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
fixtures['/file/operations/capabilities']={ok:true,protocol:'reviewed-file-operations-v1'};
async function check(page,width,theme,phase){
  const measured=await layout(page,'panel-files');report.layouts.push({width,theme,phase,...measured});
  assert.deepEqual(measured.overflow,[],`${phase}: controls fit at ${width}`);assert.equal(measured.duplicateIds.length,0,`${phase}: unique IDs`);
  assert.ok(measured.documentWidth<=width+2,`${phase}: document ${measured.documentWidth} fits ${width}`);
}
async function capture(page,width,theme,phase,target){
  if(target)await page.locator(target).scrollIntoViewIfNeeded();
  await check(page,width,theme,phase);const file=`${phase}-${width}-${theme}.png`;
  await page.screenshot({path:path.join(output,file),fullPage:false});report.screenshots.push({file,width,theme,phase});
}
async function scenario(browser,width,theme){
  const run=await makePage(browser,width,theme),{page}=run,calls=[];let failIncoming=false,previewNumber=0;
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(!['/files/scan','/file/scan','/file/operations/capabilities','/file/organize','/file/rename','/file/undo'].includes(url.pathname))return route.fallback();
    assert.equal(url.hostname,'tli-ui.test');const body=request.postData()?request.postDataJSON():null;
    calls.push({path:url.pathname,method:request.method(),body});
    if(url.pathname==='/file/operations/capabilities')return json(route,fixtures[url.pathname]);
    if(url.pathname==='/files/scan')return json(route,{path:body.root,extension_summary:[{extension:'.txt',count:body.root===root?498:1,example:'present.txt'}]});
    if(url.pathname==='/file/scan'){
      if(body.path===incoming&&failIncoming)return json(route,{detail:'Synthetic replacement scan unavailable'},503);
      return json(route,{path:body.path,buckets:body.path===root?buckets:{Documents:['present.txt']},total_files:body.path===root?501:1});
    }
    assert.equal(url.pathname,'/file/organize','Only organize previews are used');assert.equal(body.confirm,false,'No mutation request is permitted by this harness');
    previewNumber++;
    const rows=Object.entries(body.actions).flatMap(([folder,names])=>names.map(name=>({source:body.path+'\\'+name,destination:body.path+'\\'+folder+'\\'+name,
      size:2048,status:name==='photo.jpg'?'blocked':'ready',reason:name==='photo.jpg'?'Destination already exists. TLI will not overwrite it.':''})));
    return json(route,{ok:true,preview:true,status:'preview',preview_id:previewNumber.toString(16).padStart(32,'0'),expires_at:Date.now()/1000+600,
      can_execute:rows.some(row=>row.status==='ready')&&rows.every(row=>row.status!=='blocked'),results:rows,message:'Review these synthetic paths. No files have moved.',history:[]});
  });
  try{
    await page.goto('https://tli-ui.test/',{waitUntil:'load'});await page.waitForFunction(()=>window.TLIStorageWorkspace?.prepare&&window.TLIFiles);
    await page.evaluate(()=>switchPanel('panel-files'));
    await page.evaluate(()=>TLIPlaces.open());await page.locator('#places-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#places-panel option[value="panel-dashboard2"]').innerText(),'Home');
    assert.equal(await page.locator('#places-panel option[value="panel-reports"]').innerText(),'Saved reports');
    assert.equal(await page.locator('#places-panel option[value="panel-games"]').innerText(),'Game Optimizer');
    assert.equal(await page.locator('#places-panel option').count(),await page.evaluate(()=>TLIUI.navigation.filter(item=>item.kind!=='shortcut'&&item.id.startsWith('panel-')).length));
    await page.keyboard.press('Escape');await page.locator('#places-dialog').waitFor({state:'hidden'});
    await page.locator('[data-files-preset="downloads"]').click();
    assert.equal(calls.length,0,'Opening Organize and choosing a preset must not scan');
    await page.locator('#filesRootInput').fill(root);await page.locator('#filesScanButton').click();
    await page.waitForFunction(()=>document.getElementById('filesStatus').textContent.includes('Scan complete: 501'));
    assert.match(await page.locator('#files-selection-count').innerText(),/^0 of 500/);assert.equal(await page.locator('#filesRunButton').isDisabled(),true);
    assert.equal(await page.locator('.files-file-choice').count(),50);
    await page.locator('#files-select-matching').click();assert.match(await page.locator('#filesStatus').innerText(),/selection is unchanged/);
    assert.match(await page.locator('#files-selection-count').innerText(),/^0 of 500/);
    await page.locator('#files-page-next').click();assert.match(await page.locator('#files-page-count').innerText(),/51–100 of 501/);
    await page.locator('#files-selection-category').selectOption('Images');await page.locator('#files-selection-search').fill('photo');
    assert.equal(await page.locator('.files-file-choice').count(),2);await page.locator('#files-select-matching').click();
    await page.getByLabel('Images destination subfolder',{exact:true}).fill('Sorted photos');
    assert.match(await page.locator('#files-selection-count').innerText(),/^2 of 500/);
    assert.deepEqual(await page.evaluate(()=>filesBuildOrganizePayload().actions),{'Sorted photos':['photo.jpg',longName]});
    await capture(page,width,theme,'selected-images','#files-selection-tools');
    await page.locator('#files-selection-search').fill('');await page.locator('#files-selection-category').selectOption('Documents');
    await page.locator('#files-select-matching').click();assert.match(await page.locator('#files-selection-count').innerText(),/^500 of 500/);
    await page.locator('#files-selection-category').selectOption('Archives');await page.locator('#files-select-matching').click();
    assert.match(await page.locator('#files-selection-count').innerText(),/^500 of 500/);assert.match(await page.locator('#filesStatus').innerText(),/selection is unchanged/);
    await page.locator('#files-clear-selection').click();assert.match(await page.locator('#files-selection-count').innerText(),/^0 of 500/);
    await page.locator('#files-selection-category').selectOption('Images');await page.locator('#files-select-matching').click();
    await page.locator('#files-selection-category').selectOption('Archives');await page.locator('#files-select-matching').click();
    assert.match(await page.locator('#files-selection-count').innerText(),/^3 of 500/);await page.locator('#files-leave-matching').click();
    assert.match(await page.locator('#files-selection-count').innerText(),/^2 of 500/);await page.locator('#files-selection-category').selectOption('Images');
    report.behaviors.push({width,theme,check:'Saved places matches the shared catalogue; 501-file listing, 50-row pages, search/category display, exact subset/destinations, 500/501 boundary and leave-here controls'});

    await page.locator('#filesRunButton').click();await page.locator('#files-leave-blocked').waitFor({state:'visible'});
    assert.equal(await page.locator('#files-operation-confirm').isDisabled(),true);await capture(page,width,theme,'blocked-review','#files-operation-review');
    await page.locator('#files-leave-blocked').click();const requestCount=calls.length;
    await page.evaluate(()=>filesConfirmOperation());assert.equal(calls.length,requestCount,'An invalidated preview must not execute');
    assert.deepEqual(await page.evaluate(()=>filesBuildOrganizePayload().actions),{'Sorted photos':[longName]});
    await page.locator('#filesRunButton').click();await page.waitForFunction(()=>!document.getElementById('files-operation-confirm').disabled);
    assert.equal(calls.filter(call=>call.path==='/file/organize').length,2);
    await page.getByLabel('Images destination subfolder',{exact:true}).fill('Reviewed photos');assert.equal(await page.locator('#files-operation-confirm').isDisabled(),true);
    const beforeStale=calls.length;await page.evaluate(()=>filesConfirmOperation());assert.equal(calls.length,beforeStale);
    await page.locator('#filesRunButton').click();await page.waitForFunction(()=>!document.getElementById('files-operation-confirm').disabled);
    assert.deepEqual(calls.filter(call=>call.path==='/file/organize').at(-1).body.actions,{'Reviewed photos':[longName]});
    await capture(page,width,theme,'fresh-review','#files-operation-review');
    report.behaviors.push({width,theme,check:'Blocked removal and destination editing invalidate previews; new preview contains exactly the remaining reviewed files'});

    const intent={view:'organize',root:incoming,source:'space',hostId:'fixture-studio',candidatePaths:[incoming+'\\present.txt',incoming+'\\missing.txt',incoming+'\\nested\\present.txt'],observation:{id:'c'.repeat(32),recordedAt:new Date().toISOString(),coverage:'Synthetic prior observation; partial coverage.'}};
    const handoffCount=calls.length;
    assert.equal((await page.evaluate(intent=>TLIStorageWorkspace.prepare(intent),intent)).status,'draft-conflict');
    assert.equal(await page.locator('#filesRootInput').inputValue(),root);assert.equal(calls.length,handoffCount);
    await capture(page,width,theme,'draft-conflict','#storage-folder-handoff');await page.locator('#storage-keep-draft').click();
    assert.equal(await page.locator('#filesRootInput').inputValue(),root);
    await page.evaluate(intent=>TLIStorageWorkspace.prepare(intent),intent);await page.locator('#storage-use-folder').click();
    assert.equal(calls.length,handoffCount);assert.equal(await page.locator('#filesRootInput').inputValue(),incoming);
    assert.deepEqual(await page.evaluate(()=>({root:TLIFiles.describeDraft().scannedRoot,count:TLIFiles.describeDraft().selectedCount})),{root,count:1});
    failIncoming=true;await page.locator('#filesScanButton').click();await page.waitForFunction(()=>document.getElementById('filesStatus').textContent.includes('Could not read file categories'));
    assert.equal(await page.locator('#filesRunButton').isDisabled(),true);assert.match(await page.locator('#files-selection-count').innerText(),/^1 of 500/);
    await capture(page,width,theme,'failed-replacement','#files-selection-count');
    await page.locator('#files-return-draft').click();assert.equal(await page.locator('#filesRootInput').inputValue(),root);
    assert.deepEqual(await page.evaluate(()=>filesBuildOrganizePayload().actions),{'Reviewed photos':[longName]});
    await page.evaluate(intent=>TLIStorageWorkspace.prepare(intent),intent);await page.locator('#storage-use-folder').click();failIncoming=false;
    await page.locator('#filesScanButton').click();await page.waitForFunction(()=>document.getElementById('filesStatus').textContent.includes('Scan complete: 1 file'));
    assert.match(await page.locator('#files-selection-count').innerText(),/^0 of 500/);assert.match(await page.locator('#files-candidates').innerText(),/1 suggested file matches.*2 are unavailable/);
    await page.locator('#files-candidates summary').click();await capture(page,width,theme,'candidate-review','#files-candidates');
    await page.locator('#files-add-candidates').click();assert.deepEqual(await page.evaluate(()=>filesBuildOrganizePayload().actions),{Documents:['present.txt']});
    report.behaviors.push({width,theme,check:'Different draft is retained; explicit replacement failure preserves it; returning restores selection; incoming candidates require scan match and explicit addition'});

    const beforeNavigation=calls.length;await page.evaluate(()=>switchPanel('panel-visualizer'));await page.evaluate(()=>switchPanel('panel-files'));
    assert.equal(calls.length,beforeNavigation);assert.match(await page.locator('#files-selection-count').innerText(),/^1 of 500/);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
    assert.equal(await page.locator('#filesRootInput').inputValue(),'');assert.equal(await page.locator('#files-file-list').count(),0);
    assert.equal(await page.locator('#storage-folder-handoff').count(),0);assert.equal(calls.some(call=>call.body?.confirm===true),false);
    report.behaviors.push({width,theme,check:'Subview navigation preserves draft without scanning; lock clears private file list and pending handoff; no execution request occurred'});
    assert.deepEqual(run.errors,[],'No SPA JavaScript errors');
    report.sessions.push({width,theme,errors:run.errors,syntheticCalls:calls,unknown:[...new Set(run.unknown)]});
  } finally { await run.context.close(); }
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try { for(const [width,theme] of [[1440,'emeraldLight'],[390,'emeraldLight'],[320,'midnight']])await scenario(browser,width,theme); }
  catch(error){report.failures.push({message:error.stack});console.error(error);}
  finally { await browser.close();report.hashesAtEnd=hashes();report.storageSourceUnchanged=JSON.stringify(report.hashesAtStart)===JSON.stringify(report.hashesAtEnd);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); }
  console.log(JSON.stringify({output,behaviors:report.behaviors.length,layouts:report.layouts.length,screenshots:report.screenshots.length,failures:report.failures.length,storageSourceUnchanged:report.storageSourceUnchanged}));
  if(report.failures.length||!report.storageSourceUnchanged)process.exitCode=1;
})();
