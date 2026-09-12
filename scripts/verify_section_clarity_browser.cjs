/* Full SPA, intercepted synthetic host responses only. No live TLI or device access. */
const {chromium}=require('playwright');
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
if(!process.argv.includes('--label'))process.argv.push('--label','section-clarity');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {contrast,textScale}=require('./verify_anniversary_themes_browser.cjs');
const before=process.argv.includes('--before'), quick=process.argv.includes('--quick');
const output=path.resolve(__dirname,'../build_work/section-clarity',`${before?'before':'after'}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(output,{recursive:true});
const report={source,output,before,synthetic:true,hashesAtStart:fingerprintFiles(source),views:[],layouts:[],guides:[],themes:[],behaviors:[],stateProbes:[],sessions:[],failures:[],limitations:[
  'Every host response and operation is synthetic and intercepted; no real printer, scanner, AI, household file or running TLI instance is used.',
  'Phone viewports and doubled text are browser simulations; physical-phone and screen-reader acceptance are not claimed.',
  'Theme contrast measures solid backgrounds; complex surfaces require visual review.'
]};
const now=new Date().toISOString(), json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
const a='a'.repeat(32), b='b'.repeat(32);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const sampleNote={id:'c'.repeat(32),revision:'d'.repeat(64),title:'Studio network fix',text:'The studio cable was replaced after intermittent connection drops.',source:'user',category:'general',created_at:now,updated_at:now,device_id:null};
Object.assign(fixtures,{
 '/api/intelligence/memory':{ok:true,facts:[sampleNote]},
 '/api/printers':[{name:'Studio printer',is_default:true,driver:'Synthetic driver',port:'192.0.2.40',status:'ready',is_network:true}],
 '/api/printers/supplies':{}, '/printshop/printers':{printers:[{name:'Studio printer',default:true}],default_printer:'Studio printer'},
 '/printshop/scanners':{scanners:[{id:'fixture-scanner',name:'Studio scanner'}]},
 '/actions/list':{actions:[],triggers:[]}, '/actions/capabilities':{devices:[]},
 '/hub/status':{enabled:false,installed:[]}, '/hub/sample':{source:'sample',packages:[{id:'fixture-theme',name:'Studio palette',type:'theme',author:'Synthetic fixture',version:'1.0',description:'A local sample for previewing package actions.',installed:false,tags:['theme']}]},
 '/hub/local-registry':{packages:[]},
 '/api/companion/v1/setup':{pin_enabled:true,tls_enabled:true,lan_enabled:true,certificate_ready:true,pairing_ready:true,origins:['https://192.0.2.10:8443'],node:{id:'fixture-studio',name:'Studio'}},
 '/api/companion/v1/paired-devices':{devices:[{id:'fixture-phone',name:'Studio phone',platform:'ios',created_at:now}]}
});
const capturePanels=new Set(['panel-files','panel-visualizer','panel-devices','panel-printshop','panel-companion','panel-settings','panel-builder']);
async function fixturePage(browser,width,theme){
  const run=await makePage(browser,width,theme);
  if(!before){await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});await run.page.waitForFunction(()=>typeof switchPanel==='function');await run.page.waitForTimeout(350);}
  return run;
}
async function check(page,panel,width,theme,variant='') {
  const result=await layout(page,panel); report.layouts.push({panel,width,theme,variant,...result});
  if(result.overflow.length||result.documentWidth>width+2||result.duplicateIds.length)report.failures.push({kind:'layout',panel,width,theme,variant,...result});
}
async function screenshot(page,name,fullPage=true) {
  const file=name+'.png'; await page.screenshot({path:path.join(output,file),fullPage});report.views.push({name,file});
}
async function guideMatrix(browser) {
  for(const width of before?[1440,390]:quick?[1440,390]:[1440,1024,390,320])for(const theme of ['emeraldLight','midnight']){
    const run=await fixturePage(browser,width,theme),{page}=run;
    const panels=await page.evaluate(()=>TLIUI.navigation.filter(item=>item.id.startsWith('panel-')&&document.getElementById(item.id)).map(item=>({id:item.id,label:item.label})));
    for(const {id,label} of panels){
      await page.evaluate(id=>switchPanel(id),id);await page.waitForTimeout(65);
      if(!before&&id==='panel-companion')await page.waitForFunction(()=>document.getElementById('native-companion-generate')&&!document.getElementById('native-companion-generate').disabled);
      if(!before){
        const guide=page.locator(`[data-section-help="${id}"]`);assert.equal(await guide.count(),1,`${label} has one guide`);
        await guide.locator('summary').focus();await page.keyboard.press('Enter');
        assert.equal(await guide.evaluate(node=>node.open),true);
        assert.equal(await guide.locator('dt').count(),3);
        report.guides.push({id,label,width,theme,keyboardOpen:true});
      }
      await check(page,id,width,theme,'about');
      if(capturePanels.has(id)&&(width===1440||width===390))await screenshot(page,`${id}-${width}-${theme}`);
      if(!before){await page.locator(`[data-section-help="${id}"]`).evaluate(node=>{node.open=false;});}
      if(!before&&id==='panel-companion'&&(width===1440||width===390)){
        await page.locator('#native-companion-step-pair').scrollIntoViewIfNeeded();await screenshot(page,`companion-pairing-steps-${width}-${theme}`,false);
      }
    }
    await page.evaluate(()=>TLIUI.openNotes());await page.locator('#notebook-dialog').waitFor({state:'visible'});
    await check(page,'notebook-dialog',width,theme);if(width===1440||width===390)await screenshot(page,`notes-${width}-${theme}`,false);
    await page.keyboard.press('Escape');
    if(before){
      await page.evaluate(()=>switchPanel('panel-settings'));
      const oldPairing=page.locator('#native-companion-settings');
      if(await oldPairing.count()){
        await oldPairing.evaluate(node=>{node.open=true;node.scrollIntoView({block:'start'});});await page.waitForTimeout(100);
        await screenshot(page,`companion-in-settings-${width}-${theme}`,false);
      }
    }
    const mutations=run.calls.filter(c=>!['GET','HEAD'].includes(c.method));
    report.sessions.push({width,theme,errors:run.errors,mutations,unknown:[...new Set(run.unknown)]});
    if(run.errors.length||mutations.length)report.failures.push({kind:'navigation',width,theme,errors:run.errors,mutations});
    await run.context.close(); console.log(`Guides ${width} ${theme}`);
  }
}
async function behaviorChecks(browser){
  const run=await fixturePage(browser,1440,'emeraldLight'),{page}=run,calls=[];
  let adviceFailure=false,scanFailure=false,imageFailure=false,testFailure=true,scanNumber=0;
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(!['/files/apply_rules','/files/insight','/printshop/scan','/api/printers/open_add','/api/printers/test_print','/shelly/discover','/api/companion/v1/pairings'].includes(url.pathname)&&!url.pathname.startsWith('/printshop/scan/'))return route.fallback();
    calls.push({path:url.pathname,method:request.method()});
    if(url.pathname==='/api/companion/v1/pairings'){
      const expires_at=new Date(Date.now()+60000).toISOString(),origin=request.postDataJSON().origin;
      return json(route,{bundle:JSON.stringify({version:1,origin,token:'synthetic-private-invitation',certificate_der:'synthetic-public-certificate',node_id:'fixture-studio',node_name:'Studio',expires_at}),expires_at,qr:'data:image/png;base64,'+png.toString('base64')});
    }
    if(url.pathname==='/files/apply_rules'||url.pathname==='/files/insight')return json(route,adviceFailure?{detail:'Synthetic AI unavailable'}:{summary:'Consider placing project documents in a clearly named folder after reviewing the exact files.'},adviceFailure?503:200);
    if(url.pathname==='/printshop/scan'){scanNumber++;return json(route,scanFailure?{detail:'Synthetic scanner disconnected'}:{status:'ok',token:scanNumber===1?a:b},scanFailure?503:200);}
    if(url.pathname.startsWith('/printshop/scan/'))return request.method()==='DELETE'?json(route,{status:'deleted'}):imageFailure?json(route,{detail:'Synthetic retrieval failed'},503):route.fulfill({contentType:'image/png',body:png});
    if(url.pathname==='/api/printers/test_print')return json(route,testFailure?{ok:false,message:'Synthetic printer unavailable'}:{ok:true,printer:'Studio printer'},testFailure?503:200);
    return json(route,{ok:true,devices:[]});
  });
  await page.evaluate(()=>switchPanel('panel-files'));
  await page.locator('#files-more-tools').evaluate(node=>{node.open=true;});await page.locator('#filesRootInput').fill('C:\\Synthetic\\Projects');await page.locator('#filesRulesTextarea').fill('Group documents by project');
  await page.locator('#filesCustomRulesButton').click();await page.waitForFunction(()=>document.getElementById('filesStatus').textContent.includes('suggestion received'));
  const advice=await page.locator('#filesRulesSummary').innerText();adviceFailure=true;await page.locator('#filesCustomRulesButton').click();
  await page.waitForFunction(()=>document.getElementById('filesStatus').textContent.includes('AI request failed'));
  assert.equal(await page.locator('#filesRulesSummary').innerText(),advice);report.behaviors.push('AI suggestion failure preserves prior advice and does not create a move plan');
  await screenshot(page,'files-retained-advice-1440-emeraldLight');
  await page.evaluate(()=>switchPanel('panel-printshop'));await page.evaluate(()=>psSwitchTab('scan'));await page.evaluate(()=>psLoadScanners());
  await page.locator('#ps-scanner-select').selectOption('fixture-scanner');await page.locator('#ps-scan-btn').click();
  await page.waitForFunction(()=>document.getElementById('ps-scan-status').textContent.includes('Scan ready'));
  const previous=await page.locator('#ps-preview-img').getAttribute('src');scanFailure=true;await page.locator('#ps-scan-btn').click();
  await page.waitForFunction(()=>document.getElementById('ps-scan-status').textContent.includes('previous scan is unchanged'));
  assert.equal(await page.locator('#ps-preview-img').getAttribute('src'),previous);assert.equal(calls.some(c=>c.method==='DELETE'),false);
  scanFailure=false;imageFailure=true;await page.locator('#ps-scan-btn').click();await page.waitForFunction(()=>!document.getElementById('ps-scan-btn').disabled);
  assert.equal(await page.locator('#ps-preview-img').getAttribute('src'),previous);assert.deepEqual(calls.filter(c=>c.method==='DELETE').map(c=>c.path),[`/printshop/scan/${b}`]);
  report.behaviors.push('Scanner and retrieval failure retain prior downloadable scan; only failed candidate is deleted');await screenshot(page,'scanner-retained-preview-1440-emeraldLight');
  await page.evaluate(()=>psSwitchTab('print'));await page.locator('#ps-test-print-btn').click();await page.waitForFunction(()=>document.getElementById('ps-print-status').textContent.includes('Test print failed'));
  assert.equal(calls.filter(c=>c.path==='/api/printers/test_print').length,1);report.behaviors.push('Failed test-print handler cannot display successful submission or automatically retry');
  await page.evaluate(()=>switchPanel('panel-devices'));await page.evaluate(()=>refreshPrinters());
  await page.waitForFunction(()=>document.querySelector('#devices-printers-list [data-printshop]'));
  await page.locator('#devices-printers-list [data-printshop]').first().click();
  assert.equal(await page.locator('#ps-printer-select').inputValue(),'Studio printer');assert.match(await page.locator('#ps-print-status').innerText(),/Review.*before printing/);
  assert.equal(calls.filter(c=>c.path==='/api/printers/test_print').length,1);report.behaviors.push('Printer inventory hands off to the selected Print & Scan target without submitting another job');
  await page.evaluate(()=>switchPanel('panel-homeauto'));await page.locator('#smart-device-open').click();
  const oldCount=calls.filter(c=>c.path==='/api/printers/open_add').length;
  await page.locator('#shelly-discover-btn').click();await page.waitForTimeout(70);
  assert.equal(calls.filter(c=>c.path==='/api/printers/open_add').length,oldCount);await page.keyboard.press('Escape');report.behaviors.push('Shelly discovery cannot launch printer settings');
  await page.evaluate(()=>TLIUI.openNotes());await page.getByRole('button',{name:'New note',exact:true}).click();
  await page.locator('#notebook-title').fill('Unsaved network fix');await page.locator('#notebook-text').fill('A private draft that has not been saved to the host.');
  await page.keyboard.press('Escape');await page.evaluate(()=>TLIUI.openNotes());
  const draft=page.getByRole('button',{name:/Resume/}).first();if(await draft.isVisible())await draft.click();
  assert.equal(await page.locator('#notebook-text').inputValue(),'A private draft that has not been saved to the host.');
  assert.equal(run.calls.some(c=>c.path==='/api/intelligence/memory'&&c.method==='POST'),false);report.behaviors.push('Closing and reopening Notes & fixes retains an unsaved draft without saving or attaching it');await screenshot(page,'notes-draft-1440-emeraldLight',false);await page.keyboard.press('Escape');
  const beforeOpen=calls.length;await page.evaluate(()=>switchPanel('panel-companion'));await page.waitForFunction(()=>document.getElementById('native-companion-generate')&&!document.getElementById('native-companion-generate').disabled);
  assert.equal(await page.locator('#native-companion-settings').count(),1);assert.equal(await page.locator('#native-companion-pairing').isVisible(),false);
  assert.equal(run.calls.some(c=>c.path.endsWith('/pairings')&&c.method==='POST'),false);assert.equal(calls.length,beforeOpen);report.behaviors.push('Phone Companion is discoverable and reads setup without generating an invitation');
  await page.locator('#native-companion-step-access-title').focus();await screenshot(page,'phone-companion-ready-1440-emeraldLight');
  await page.locator('#native-companion-generate').evaluate(button=>{button.click();button.click();});await page.locator('#native-companion-hide-code').waitFor({state:'visible'});
  assert.equal(calls.filter(c=>c.path==='/api/companion/v1/pairings').length,1);await page.locator('#native-companion-pairing').scrollIntoViewIfNeeded();await screenshot(page,'phone-companion-invitation-1440-emeraldLight',false);
  await page.locator('#native-companion-hide-code').click();assert.equal(await page.locator('#native-companion-pairing').isVisible(),false);
  assert.match(await page.locator('#native-companion-pair-status').innerText(),/remains valid/);report.behaviors.push('Explicit pairing creates one complete invitation; hiding it accurately reports that the invitation remains valid');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
  assert.equal(await page.locator('#native-companion-generate').isDisabled(),true);assert.equal(await page.locator('#native-companion-devices').innerText(),'');
  assert.equal(await page.locator('#notebook-dialog').evaluate(node=>node.open),false);report.behaviors.push('Session lock clears private drafts, paired-phone details and pending view access');
  report.sessions.push({name:'behavior',errors:run.errors,syntheticCalls:calls});if(run.errors.length)report.failures.push({kind:'behavior-errors',errors:run.errors});
  await run.context.close();console.log('Behavior checks complete');
}
async function themeChecks(browser){
  const run=await fixturePage(browser,390,'emeraldLight'),{page}=run;
  await page.evaluate(()=>{window.__themeAuditVisible=el=>{
    if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;
    for(let ancestor=el;ancestor;ancestor=ancestor.parentElement){if(Number(getComputedStyle(ancestor).opacity)===0)return false;if(ancestor!==el&&ancestor.tagName==='DETAILS'&&!ancestor.open&&!ancestor.querySelector(':scope > summary')?.contains(el))return false;}return true;
  };});
  const themes=await page.locator('#settings-theme option').evaluateAll(options=>options.filter(o=>o.value&&!o.disabled).map(o=>({value:o.value,label:o.textContent})));
  report.themes=themes;
  for(const theme of themes){await page.evaluate(value=>applyTheme(value),theme.value);
    for(const panel of ['panel-files','panel-printshop','panel-companion','panel-settings','panel-hub']){
      await page.evaluate(id=>switchPanel(id),panel);await page.waitForTimeout(30);
      await check(page,panel,390,theme.value,'all selectable themes');
      const result=await contrast(page,panel);if(result.findings?.length)report.failures.push({kind:'contrast',panel,theme:theme.value,findings:result.findings});
    }
    await page.evaluate(()=>TLIUI.openNotes());await page.locator('#notebook-dialog').waitFor({state:'visible'});
    await check(page,'notebook-dialog',390,theme.value,'all selectable themes');
    const notesContrast=await contrast(page,'notebook-dialog');if(notesContrast.findings.length)report.failures.push({kind:'contrast',panel:'notebook-dialog',theme:theme.value,findings:notesContrast.findings});
    await page.keyboard.press('Escape');
  }
  for(const theme of ['emeraldLight','midnight'])for(const width of [390,320]){
    await page.setViewportSize({width,height:1000});await page.evaluate(value=>applyTheme(value),theme);
    for(const panel of ['panel-files','panel-printshop','panel-companion','panel-settings']){
      await page.evaluate(id=>switchPanel(id),panel);const guide=page.locator(`[data-section-help="${panel}"]`);await guide.evaluate(node=>{node.open=true;});
      await contrast(page,panel);await textScale(page,panel,true);await check(page,panel,width,theme,'200% text');
      if(panel==='panel-companion')await screenshot(page,`phone-companion-${width}-${theme}-large-text`);
      await textScale(page,panel,false);await guide.evaluate(node=>{node.open=false;});
    }
  }
  report.sessions.push({name:'themes',errors:run.errors});if(run.errors.length)report.failures.push({kind:'theme-errors',errors:run.errors});
  await run.context.close();console.log(`${themes.length} themes complete`);
}
async function stateChecks(browser){
  const run=await fixturePage(browser,1024,'midnight'),{page}=run;
  const panels=await page.evaluate(()=>TLIUI.navigation.filter(item=>item.id.startsWith('panel-')&&document.getElementById(item.id)).map(item=>item.id));
  // Populate existing views before replacing future GET responses with failures.
  for(const panel of panels){await page.evaluate(id=>switchPanel(id),panel);await page.waitForTimeout(60);}
  await page.evaluate(()=>TLIUI.openNotes());await page.locator('#notebook-dialog').waitFor({state:'visible'});await page.keyboard.press('Escape');
  const failedReads=[];
  await page.route('**/*',route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    if(request.method()!=='GET'||/\.(js|css|svg|png|html|mp3)$/.test(pathname)||pathname==='/'||pathname==='/system/pin/status')return route.fallback();
    failedReads.push(pathname);return json(route,{ok:false,detail:'Synthetic host service unavailable. Previous observations are not current.',error:'Synthetic service unavailable'},503);
  });
  const refreshers={
    'panel-dashboard2':()=>window.TLIDash2?.refresh?.(),
    'panel-mesh':()=>document.getElementById('mcd-refresh-btn')?.click(),
    'panel-devices':()=>window.refreshPrinters?.(),
    'panel-printshop':()=>Promise.all([psLoadPrinters(),psLoadScanners()]),
    'panel-vault':()=>fetchVaultStatus(),
    'panel-automations':()=>window.TLIAutomations?.onOpen?.(),
    'panel-games':()=>window.TLIGames?.onOpen?.(),
    'panel-companion':()=>window.TLICompanion?.refresh?.()
  };
  for(const panel of panels){
    const start=failedReads.length;await page.evaluate(id=>switchPanel(id),panel);
    if(refreshers[panel])await page.evaluate(refreshers[panel]);await page.waitForTimeout(100);
    await check(page,panel,1024,'midnight','unavailable GET services');
    const messages=await page.locator(panel==='panel-companion'?'#native-companion-status':`#${panel}`).evaluate(node=>[...node.querySelectorAll('[role="status"], [id*="status"], [id*="updated"], [class*="error"]')].filter(el=>el.getClientRects().length).map(el=>el.textContent.trim()).filter(Boolean).slice(0,12));
    report.stateProbes.push({panel,scenario:'unavailable GET services',requests:[...new Set(failedReads.slice(start))],messages});
  }
  await page.evaluate(()=>TLIUI.openNotes());await page.locator('#notebook-refresh').click();await page.waitForTimeout(80);
  assert.match(await page.locator('#notebook-status').innerText(),/unavailable|out of date|could not|not current/i);
  assert.match(await page.locator('#notebook-list').innerText(),/Studio network fix/);report.behaviors.push('Failed Notes refresh preserves the loaded list with unavailable/stale feedback');await page.keyboard.press('Escape');
  await page.evaluate(()=>switchPanel('panel-companion'));await page.waitForTimeout(80);
  assert.equal(await page.locator('#native-companion-generate').isDisabled(),true);report.behaviors.push('Unavailable Companion setup disables pairing without creating an invitation');
  report.sessions.push({name:'unavailable GET probes',errors:run.errors,mutations:run.calls.filter(call=>!['GET','HEAD'].includes(call.method))});
  if(run.errors.length)report.failures.push({kind:'unavailable-js',errors:run.errors});
  assert.equal(run.calls.filter(call=>!['GET','HEAD'].includes(call.method)).length,0);await run.context.close();
  const replacements={
    '/api/intelligence/memory':{ok:true,facts:[]},'/api/printers':[], '/printshop/printers':{printers:[]},'/printshop/scanners':{scanners:[]},
    '/api/mesh/health':{ok:true,nodes:[]},'/homeauto/devices':{devices:[]},'/homepower/devices':{ok:true,devices:[]},
    '/actions/list':{actions:[],triggers:[]},'/actions/receipts':{receipts:[]},'/tools/list':{tools:[]},
    '/hub/sample':{source:'sample',packages:[]},'/api/companion/v1/paired-devices':{devices:[]},
    '/api/intelligence/places':{ok:true,protocol:'saved-places-v1',places:[]}, '/chat/conversations':{conversations:[]}
  };
  const originals=Object.fromEntries(Object.keys(replacements).map(key=>[key,fixtures[key]]));Object.assign(fixtures,replacements);
  const empty=await fixturePage(browser,390,'emeraldLight');
  try{
    for(const panel of panels){const start=empty.calls.length;await empty.page.evaluate(id=>switchPanel(id),panel);if(refreshers[panel])await empty.page.evaluate(refreshers[panel]);await empty.page.waitForTimeout(60);await check(empty.page,panel,390,'emeraldLight','empty inventories');
      report.stateProbes.push({panel,scenario:'empty inventories',requests:[...new Set(empty.calls.slice(start).map(call=>call.path))],fixtureScope:Object.keys(replacements)});
    }
    await empty.page.evaluate(()=>TLIUI.openNotes());await empty.page.getByRole('button',{name:'Setup detail',exact:true}).waitFor({state:'visible'});
    assert.match(await empty.page.locator('#notebook-list').innerText(),/Preference/);report.behaviors.push('Empty Notes & fixes offers setup, preference and remembered-fix starters without a save or AI call');
    await screenshot(empty.page,'notes-empty-390-emeraldLight',false);
    assert.equal(empty.calls.filter(call=>!['GET','HEAD'].includes(call.method)).length,0);report.sessions.push({name:'empty inventories',errors:empty.errors});if(empty.errors.length)report.failures.push({kind:'empty-js',errors:empty.errors});
  }finally{await empty.context.close();Object.assign(fixtures,originals);}
  console.log('Unavailable GET and empty inventory probes complete');
}
async function partialResultChecks(browser){
  const run=await fixturePage(browser,1440,'emeraldLight'),{page}=run,calls=[];let release;
  const root='C:\\Synthetic\\Documents',rows=['one.txt','two.txt'].map(name=>({source:root+'\\'+name,destination:root+'\\Documents\\'+name,status:'ready',reason:''}));
  await page.route('**/files/scan',route=>json(route,{extension_summary:[{extension:'.txt',count:2,example:'one.txt'}]}));
  await page.route('**/file/scan',route=>json(route,{buckets:{Documents:['one.txt','two.txt']},total_files:2}));
  await page.route('**/file/operations/capabilities',route=>json(route,{ok:true,protocol:'reviewed-file-operations-v1'}));
  await page.route('**/file/organize',async route=>{
    const body=route.request().postDataJSON();calls.push({confirm:body.confirm});
    if(!body.confirm)return json(route,{ok:true,preview:true,status:'preview',preview_id:'e'.repeat(32),expires_at:Date.now()/1000+600,can_execute:true,results:rows,message:'Review these exact paths. No files have moved.',history:[]});
    await new Promise(done=>{release=done;});
    return json(route,{ok:false,preview:false,status:'partial',results:[{...rows[0],status:'moved'},{...rows[1],status:'failed',reason:'Synthetic file in use'}],message:'Moved 1 of 2 files.',moved_count:1,undo_available:true,operation_id:'f'.repeat(32)});
  });
  try{
    await page.evaluate(()=>switchPanel('panel-files'));await page.locator('#filesRootInput').fill(root);await page.locator('#filesScanButton').click();
    await page.waitForFunction(()=>document.getElementById('filesStatus').textContent.includes('Scan complete'));
    await page.locator('#filesRunButton').click();await page.locator('#files-operation-confirm').waitFor({state:'visible'});
    assert.equal(calls.filter(call=>call.confirm).length,0);
    await page.locator('#files-operation-confirm').click();await page.waitForFunction(()=>document.getElementById('files-operation-confirm').disabled);
    await page.evaluate(()=>filesConfirmOperation());assert.equal(calls.filter(call=>call.confirm).length,1);
    report.behaviors.push('Exact file review sends no mutation until confirmed; pending execution blocks duplicate confirmation');
    await screenshot(page,'files-operation-pending-1440-emeraldLight',false);release();
    await page.waitForFunction(()=>document.getElementById('files-operation-review').textContent.includes('Moved 1 of 2'));
    assert.match(await page.locator('#files-operation-review').innerText(),/partial completion/i);assert.match(await page.locator('#files-operation-review').innerText(),/Synthetic file in use/);
    assert.equal(await page.evaluate(()=>Object.values(filesBuildOrganizePayload().actions).flat().length),2);
    report.behaviors.push('Partial file completion reports each result and preserves the original draft without automatic replay');
    for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.locator('#files-operation-stage').scrollIntoViewIfNeeded();await check(page,'panel-files',width,'emeraldLight','partial file result');await screenshot(page,`files-partial-result-${width}-emeraldLight`,false);}
    report.sessions.push({name:'reviewed partial file operation',errors:run.errors,syntheticCalls:calls});if(run.errors.length)report.failures.push({kind:'partial-js',errors:run.errors});
  }finally{release?.();await run.context.close();}
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{if(process.argv.includes('--themes-only'))await themeChecks(browser);else if(process.argv.includes('--states-only'))await stateChecks(browser);else if(process.argv.includes('--partial-only'))await partialResultChecks(browser);else{await guideMatrix(browser);if(!before){await behaviorChecks(browser);if(!quick){await partialResultChecks(browser);await stateChecks(browser);await themeChecks(browser);}}}}
  catch(error){report.failures.push({kind:'exception',message:error.stack});console.error(error);}
  finally{await browser.close();report.hashes=fingerprintFiles(source);report.sourceUnchanged=JSON.stringify(report.hashes)===JSON.stringify(report.hashesAtStart);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify({output,views:report.views.length,layouts:report.layouts.length,guides:report.guides.length,themes:report.themes.length,behaviors:report.behaviors.length,failures:report.failures.length,sourceUnchanged:report.sourceUnchanged}));
  if(!before&&(report.failures.length||!report.sourceUnchanged))process.exitCode=1;
})();
