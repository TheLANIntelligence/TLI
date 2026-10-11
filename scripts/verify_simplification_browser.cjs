/* Full SPA navigation and presentation checks. All host responses are synthetic. */
const {chromium}=require('playwright');
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {makePage,layout,fixtures,source,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const quick=process.argv.includes('--quick');
const before=process.argv.includes('--before');
const output=path.resolve(__dirname,'../build_work/simplification/browser-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const report={source,output,synthetic:true,hashesAtStart:fingerprintFiles(source),layouts:[],captures:[],behaviors:[],sessions:[],failures:[]};
Object.assign(fixtures,{
 '/dashboard/activity-summary':{ok:true,cursor:{sequence:0},total:0,warning_count:0,group_count:0,coverage:'retained',coverage_note:'Eligible activity is retained on this host.',retention_limit:100,groups:[],events:[],checked_at:Math.floor(Date.now()/1000),history:{limit:500,days:30,status:'recording'}},
 '/api/intelligence/places':{ok:true,protocol:'saved-places-v1',places:[{id:'a'.repeat(32),revision:'b'.repeat(64),name:'Documents',kind:'folder',target:'C:\\Users\\Demo\\Documents',created_at:new Date().toISOString(),updated_at:new Date().toISOString()}]},
 '/actions/list':{actions:[],triggers:[]},'/actions/capabilities':{devices:[]},
 '/hub/status':{enabled:false,installed:[]},'/hub/local-registry':{packages:[]},
 '/games/advice_provider':{provider:'bundled',label:'Integrated AI',model:'Synthetic model',provider_key:'a'.repeat(64),readiness:'not_tested'},
 '/api/intelligence/diagnostics':{reports:[]},
 '/api/printers':[], '/api/printers/supplies':{},
 '/api/companion/v1/setup':{pin_enabled:true,tls_enabled:true,lan_enabled:true,certificate_ready:true,pairing_ready:true,origins:['https://192.0.2.10:8443'],node:{id:'fixture-studio',name:'Studio'}},
 '/api/companion/v1/paired-devices':{devices:[]},
});
async function check(page,id,meta){
 const value=await layout(page,id);report.layouts.push({...meta,id,...value});
 if(value.overflow.length||value.documentWidth>value.width+2||value.duplicateIds.length)report.failures.push({kind:'layout',...meta,id,...value});
}
async function capture(page,name){const file=name+'.png';await page.screenshot({path:path.join(output,file),fullPage:true});report.captures.push(file);}
async function matrix(browser){
 for(const width of quick?[1440,390]:[1440,1024,390,320])for(const theme of ['emeraldLight','midnight']){
  const run=await makePage(browser,width,theme),{page}=run;
  for(const style of ['modern','classic']){
   await page.evaluate(style=>TLIInterface.set(style),style);
   const main=await page.locator('.simplified-main-nav .ui-nav-label').allTextContents();
   assert.deepEqual(main,['Home','Ask TLI','Files','Free Space','Game Optimizer','Vault','Computers','Smart devices','Routines','Phone Companion','Printers & scanners','USB drives']);
   const items=await page.evaluate(()=>TLIUI.navigation.filter(n=>n.kind==='panel').map(n=>({id:n.id,parent:n.parent,primary:n.primary})));
   for(const item of items){
    // Use a visible route: main rail on desktop; full destination drawer on narrow screens.
    if(width<769){await page.locator('#tli-bn-more-btn').click();await page.locator('.tli-more-grid [data-panel-target="'+item.id+'"]').click();}
    else if(item.primary) {await page.locator('.simplified-main-nav [data-panel-target="'+item.id+'"]').click();}
    else {await page.evaluate(id=>switchPanel(id),item.id);}
    await page.waitForTimeout(40);
    assert.equal(await page.locator('#'+item.id).evaluate(e=>e.hidden),false,item.id+' reachable');
    assert.equal(await page.locator('.sidebar-nav [data-panel-target="'+item.parent+'"]').first().getAttribute('aria-current'),'page',item.id+' parent selected');
    await check(page,item.id,{width,theme,style});
    if([1440,390].includes(width)&&['panel-dashboard2','panel-files','panel-devices-home','panel-games','panel-help','panel-more','panel-automations'].includes(item.id))await capture(page,`${item.id}-${width}-${theme}-${style}`);
   }
   await page.evaluate(()=>TLIUI.openNotes());await page.locator('#notebook-dialog').waitFor({state:'visible'});
   await check(page,'notebook-dialog',{width,theme,style});await page.keyboard.press('Escape');
  }
  const mutations=run.calls.filter(c=>!['GET','HEAD'].includes(c.method));
  report.sessions.push({width,theme,errors:run.errors,mutations,unknown:[...new Set(run.unknown)]});
  if(run.errors.length||mutations.length)report.failures.push({kind:'navigation',width,theme,errors:run.errors,mutations});
  await run.context.close();console.log('Navigation matrix',width,theme);
 }
}
async function interactions(browser){
 const run=await makePage(browser,1440,'emeraldLight',{preserveSettingsOnReload:true}),{page}=run;
 const direct=await page.evaluate(()=>TLIUI.navigation.filter(n=>n.primary).map(n=>n.id));
 await page.setViewportSize({width:1280,height:720});
 for(const style of ['modern','classic']){
  await page.evaluate(style=>TLIInterface.set(style),style);
  for(const id of [...direct,'panel-help','panel-more','panel-settings']){
   const item=page.locator('.sidebar-nav [data-panel-target="'+id+'"]').first();
   await item.click();assert.equal(await item.getAttribute('aria-current'),'page');
   const bounds=await item.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=720,id+' scrolls into the sidebar viewport');
   assert.equal(await page.locator('#'+id).evaluate(e=>e.hidden),false,id+' opens directly');
  }
  await page.locator('.sidebar-nav [data-panel-target="panel-visualizer"]').click();
  assert.equal(await page.locator('.sidebar-nav [data-panel-target="panel-files"]').getAttribute('aria-current'),null);
  await check(page,'panel-visualizer',{width:1280,height:720,style,variant:'expanded-sidebar'});
  await capture(page,'expanded-sidebar-'+style+'-720');
 }
 report.behaviors.push('All direct destinations and footer tools remain clickable in the scrolling desktop sidebar in both interfaces at 720px height');
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>TLIInterface.set('modern'));
 await page.locator('.sidebar-nav [data-panel-target="panel-more"]').click();
 await page.locator('#panel-more [data-panel-target="panel-advanced"]').click();
 await page.locator('#panel-advanced [data-panel-target="panel-builder"]').click();
 await page.locator('#panel-builder [data-pin-destination]').click();
 assert.equal(await page.locator('.simplified-pins [data-panel-target="panel-builder"]').count(),1);
 await page.reload();await page.waitForFunction(()=>typeof switchPanel==='function');await page.waitForTimeout(250);
 await page.locator('.simplified-pins [data-panel-target="panel-builder"]').click();
 assert.equal(await page.locator('#panel-builder').evaluate(e=>e.hidden),false);
 await page.locator('#panel-builder [data-pin-destination]').click();
  assert.equal(await page.locator('.simplified-pins [data-panel-target="panel-builder"]').count(),0);
  report.behaviors.push('Pin, reload, open and unpin a secondary destination');
 const secondary=await page.evaluate(()=>TLIUI.navigation.filter(n=>n.pinnable).map(n=>({id:n.id,label:n.label,kind:n.kind})));
 for(const item of secondary){
  await page.evaluate(id=>TLIUI.setPinned(id,true),item.id);
  const pinned=page.locator('.simplified-pins button').filter({has:page.locator('.ui-nav-label',{hasText:item.label})}).first();
  await pinned.click();
  if(item.kind==='shortcut'){await page.locator('#notebook-dialog').waitFor({state:'visible'});await page.keyboard.press('Escape');}
  else assert.equal(await page.locator('#'+item.id).evaluate(e=>e.hidden),false);
  await page.evaluate(id=>TLIUI.setPinned(id,false),item.id);
 }
 report.behaviors.push('Every secondary destination can be pinned and opened through its visible shortcut');
 const saved=fixtures['/api/intelligence/places'];
 const destinations=await page.evaluate(()=>TLIUI.navigation.filter(n=>n.kind==='panel').map(n=>({id:n.id,label:n.label})));
 const favoriteRows=destinations.map((item,i)=>({id:(i+1).toString(16).padStart(32,'0'),revision:'b'.repeat(64),kind:'panel',target:item.id,name:item.label,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}));
 fixtures['/api/intelligence/places']={ok:true,protocol:'saved-places-v1',places:favoriteRows};
 await page.route('**/api/intelligence/places/*/check',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,revision:'b'.repeat(64),status:'available',detail:'Synthetic destination available.',checked_at:new Date().toISOString()})}));
 for(const row of favoriteRows){
  await page.evaluate(id=>TLIPlaces.openFavorite(id),row.id);
  await page.locator('#places-entry-'+row.id).getByRole('button',{name:'Open',exact:true}).click();
  assert.equal(await page.locator('#'+row.target).evaluate(e=>e.hidden),false,row.name+' saved link');
 }
 fixtures['/api/intelligence/places']=saved;
 report.behaviors.push('Every panel opens through a revision-checked saved-place link');
 for(const [alias,label,id] of [['File Organizer','Files','panel-files'],['Files & Storage','Files','panel-files'],['Automations','Routines','panel-automations'],['TLI Hub','Package management','panel-hub'],['Performance & apps','App performance check','panel-performance'],['Print & Scan','Printers & scanners','panel-printshop'],['Notes & fixes','Saved notes','panel-main']]){
  await page.keyboard.press('Control+k');await page.locator('#tli-cmd-input').fill(alias);
  await page.locator('.tli-cmd-item').filter({has:page.locator('.tli-cmd-item-label',{hasText:label})}).first().click();
  assert.equal(await page.locator('#'+id).evaluate(e=>e.hidden),false,alias+' route');
  if(label==='Saved notes')await page.keyboard.press('Escape');
 }
 report.behaviors.push('Legacy labels resolve through keyboard search');
 await page.evaluate(()=>switchPanel('panel-main'));
 await page.locator('#chat-input').fill('Keep this unfinished question');
 await page.evaluate(()=>{TLIInterface.set('classic');TLIThemes.apply('midnight');switchPanel('panel-more');switchPanel('panel-main');TLIInterface.set('modern');});
 assert.equal(await page.locator('#chat-input').inputValue(),'Keep this unfinished question');
 report.behaviors.push('Chat draft survives navigation, palette and interface changes');
 await page.locator('#tli-device-trigger').click();await page.locator('#node-switcher-btn').click();
 await check(page,'tli-device-popover',{width:1440,theme:'emeraldLight',style:'modern',variant:'host-menu'});await page.keyboard.press('Escape');
 await page.evaluate(()=>switchPanel('panel-files'));
 await page.locator('#filesRootInput').fill('C:\\Synthetic\\Documents');
 const requests=run.calls.length;
 await page.evaluate(()=>TLIStorageWorkspace.prepare({view:'space',hostId:null,root:'C:\\Synthetic\\Downloads',source:'dashboard'}));
 assert.ok(!run.calls.slice(requests).some(r=>/scan|execute/.test(r.path)),'Storage prepare must not scan or execute');
 report.behaviors.push('Storage handoff prepares without scanning or executing');
 fixtures['/devices/usb']={devices:[{name:'<b>Backup drive</b>',mount_path:'E:\\',is_storage:true}]};
 await page.evaluate(()=>switchPanel('panel-usb'));await page.locator('[data-usb-action="space-target"]').waitFor();
 assert.equal(await page.locator('#devices-usb-list b').count(),0);
 await page.setViewportSize({width:320,height:1000});await check(page,'panel-usb',{width:320,theme:'midnight',variant:'populated USB'});
 await page.locator('.usb-advanced summary').click();await check(page,'panel-usb',{width:320,variant:'advanced USB'});
 await page.setViewportSize({width:1440,height:1000});
 const usbRequests=run.calls.length;await page.locator('[data-usb-action="space-target"]').click();
 assert.equal(await page.locator('#panel-visualizer').evaluate(e=>e.hidden),false);
 assert.equal(await page.locator('#visualizerPathInput').inputValue(),'E:\\');
 assert.ok(!run.calls.slice(usbRequests).some(r=>/scan|execute/.test(r.path)));
 report.behaviors.push('USB drive handoff shares preparation and escapes device names');fixtures['/devices/usb']={devices:[]};
 // Installed app interfaces are only loaded on opening; package names are rendered as text.
 fixtures['/hub/apps']={apps:[{id:'fixture-app',name:'<b>Local notebook</b>',description:'Synthetic installed app',permissions:[]}]};
 await page.evaluate(()=>switchPanel('panel-installed-apps'));await page.locator('#installed-app-list [data-app-id="fixture-app"]').waitFor();
 assert.equal(await page.locator('#installed-app-list b').count(),0);
 assert.equal(await page.locator('#panel-app-fixture-app iframe').getAttribute('src'),null);
 await page.locator('#installed-app-list [data-app-id="fixture-app"]').click();
 assert.ok(await page.locator('#panel-app-fixture-app iframe').getAttribute('src'));
 assert.equal(await page.locator('.sidebar-nav [data-panel-target="panel-more"]').getAttribute('aria-current'),'page');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
 assert.equal(await page.locator('#panel-app-fixture-app').count(),0);
 assert.equal(await page.locator('#installed-app-list').innerText(),'');
 report.behaviors.push('Installed apps load lazily, preserve text names, select More and clear on session lock');
 fixtures['/hub/apps']={apps:[]};
 if(run.errors.length)report.failures.push({kind:'interactions',errors:run.errors});
 await run.context.close();
 // Access enforcement must not depend on whether a secondary sidebar item exists.
 const prior=fixtures['/license/status'];fixtures['/license/status']={tier:'free',features:{vault:false,home_automation:false,peer_nodes:false}};
 const limited=await makePage(browser,1440,'emeraldLight');
 await limited.page.evaluate(()=>{switchPanel('panel-dashboard2');document.querySelectorAll('[data-panel-target="panel-homeauto"]').forEach(e=>e.remove());switchPanel('panel-homeauto');});
 assert.equal(await limited.page.locator('#panel-homeauto').evaluate(e=>e.hidden),true);
 report.behaviors.push('Direct restricted navigation remains blocked after matching controls are removed');
 await limited.context.close();fixtures['/license/status']=prior;
}
async function palettes(browser){
 const run=await makePage(browser,390,'emeraldLight'),{page}=run;
 const themes=await page.evaluate(()=>TLIThemes.themes.map(t=>t.id));
 for(const style of ['modern','classic'])for(const theme of themes){
  await page.evaluate(({style,theme})=>{TLIInterface.set(style);TLIThemes.apply(theme);},{style,theme});
  for(const id of ['panel-dashboard2','panel-files','panel-games','panel-devices-home','panel-help','panel-more']){await page.evaluate(id=>switchPanel(id),id);await check(page,id,{width:390,theme,style,smoke:true});}
 }
 report.behaviors.push(`${themes.length} palettes smoke checked in Modern and Classic`);
 if(run.errors.length)report.failures.push({kind:'palettes',errors:run.errors});await run.context.close();
}
async function baselineCaptures(browser){
 for(const width of [1440,390]){
  const run=await makePage(browser,width,'emeraldLight');
  for(const style of ['modern','classic']){
   await run.page.evaluate(style=>TLIInterface.set(style),style);
   for(const id of ['panel-dashboard2','panel-files','panel-games','panel-automations','panel-hub','panel-devices']){
    await run.page.evaluate(id=>switchPanel(id),id);await run.page.waitForTimeout(100);
    await check(run.page,id,{before:true,width,style,theme:'emeraldLight'});await capture(run.page,`${id}-${width}-emeraldLight-${style}`);
   }
  }
  if(run.errors.length)report.failures.push({kind:'baseline',errors:run.errors});await run.context.close();
 }
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{if(before)await baselineCaptures(browser);else{await matrix(browser);await interactions(browser);await palettes(browser);}}catch(e){report.failures.push({kind:'assertion',error:e.stack});}finally{await browser.close();report.sourceUnchanged=JSON.stringify(report.hashesAtStart)===JSON.stringify(fingerprintFiles(source));fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,layouts:report.layouts.length,captures:report.captures.length,failures:report.failures,sourceUnchanged:report.sourceUnchanged},null,2));if(report.failures.length||!report.sourceUnchanged)process.exitCode=1;}})();
