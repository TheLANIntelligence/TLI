/* Full current SPA, intercepted synthetic responses, and live DOM continuity.
 * No TLI service, archived controller, inference, printer or device is contacted.
 * --source accepts a frozen source tree; --before captures its original interface.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {makePage, fixtures, source, panelIds, fingerprintFiles, layout, unexpectedRequests} = require('./verify_anniversary_ui_browser.cjs');
const {contrast, textScale} = require('./verify_anniversary_themes_browser.cjs');
const before = process.argv.includes('--before'), quick = process.argv.includes('--quick');
const arg = key => {const i=process.argv.indexOf(key); return i<0?null:process.argv[i+1];};
const output = path.resolve(arg('--output') || path.join(__dirname,'../build_work/classic-interface',(before?'before-':'browser-')+new Date().toISOString().replace(/[:.]/g,'-')));
if(fs.existsSync(path.join(output,'report.json'))) throw new Error('Preserve existing reports; choose a new output directory.');
fs.mkdirSync(output,{recursive:true});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {schema_version:1,source,output,before,synthetic:true,source_start:fingerprintFiles(source),checks:[],layouts:[],themes:[],screenshots:[],sessions:[],failures:[],limitations:[
 'Every browser request is intercepted. No live TLI, model inference, operating-system action, device or physical phone is used.',
 'Historical pictures are inert synthetic exhibits of retained source, not an executed archived application.',
 'The tests exercise browser keyboard, files, DOM identity and controlled streaming. Physical input devices and screen-reader acceptance are not claimed.',
 'Each recorded layout names its interface, color theme and viewport. A palette does not establish historical layout equivalence.'
]};
const modes=before?['modern']:['modern','classic'];
fixtures['/api/ai/documents/capabilities']={ok:true,protocol:'tli-document-questions-v1'};
const step=(name,evidence={})=>report.checks.push({name,...evidence});
async function capture(page,name) {const filename=name+'.png',file=path.join(output,filename);await page.screenshot({path:file,fullPage:false});report.screenshots.push({path:filename,sha256:sha(file),viewport:page.viewportSize()});}
async function apply(page,mode) {if(before)return;await page.evaluate(value=>window.TLIInterface.set(value),mode);await page.waitForTimeout(35);assert.equal(await page.locator('html').getAttribute('data-interface'),mode);}
async function checkLayout(page,panel,metadata={}) {const result=await layout(page,panel);report.layouts.push({...metadata,panel,...result});assert.deepEqual(result.duplicateIds,[]);assert.deepEqual(result.overflow,[],JSON.stringify({panel,...metadata,overflow:result.overflow}));assert.ok(result.documentWidth<=result.width+2,JSON.stringify({panel,...metadata,documentWidth:result.documentWidth,width:result.width}));return result;}
async function ready(browser,width,theme,options={}) {const run=await makePage(browser,width,theme,options);if(!before)await run.page.waitForFunction(()=>typeof window.TLIInterface?.set==='function');await run.page.evaluate(()=>{window.__themeAuditVisible=el=>{if(el.closest('[hidden],.hidden,[aria-hidden="true"]')||!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;for(let ancestor=el;ancestor;ancestor=ancestor.parentElement){if(Number(getComputedStyle(ancestor).opacity)===0)return false;if(ancestor!==el&&ancestor.tagName==='DETAILS'&&!ancestor.open&&!ancestor.querySelector(':scope > summary')?.contains(el))return false;}return true;};});return run;}
async function close(run,label) {report.sessions.push({label,errors:run.errors,unexpected:unexpectedRequests(run.calls),unknown:[...new Set(run.unknown)]});assert.deepEqual(run.errors,[],label);assert.deepEqual(unexpectedRequests(run.calls),[],label);await run.context.close();}

async function controlledStream(page) {
 await page.evaluate(()=>{
  const original=window.fetch;window.__interfaceStreams=[];
  window.fetch=function(input,options={}) {
   const url=typeof input==='string'?input:input.url;
   if(!String(url).includes('/api/ai/chat/stream'))return original.call(this,input,options);
   const entry={body:JSON.parse(options.body||'{}'),signal:options.signal,closed:false,cancelled:false};window.__interfaceStreams.push(entry);
   return Promise.resolve(new Response(new ReadableStream({start(controller){entry.frame=data=>{if(!entry.closed)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(data)+'\n\n'));};entry.close=()=>{if(!entry.closed){entry.closed=true;controller.close();}};},cancel(){entry.cancelled=true;entry.closed=true;}}),{headers:{'Content-Type':'text/event-stream'}}));
  };
 });
}
async function observeSwitch(page,next) {
 return page.evaluate(async next=>{
  const requests=[],events=[];const original=window.fetch,originalXhr=XMLHttpRequest.prototype.open;
  window.fetch=function(...args){requests.push({kind:'fetch',url:String(args[0]?.url||args[0])});return original.apply(this,args);};
  XMLHttpRequest.prototype.open=function(method,url,...args){requests.push({kind:'xhr',method,url});return originalXhr.call(this,method,url,...args);};
  const listener=e=>events.push(e.detail);window.addEventListener('tli:interface-change',listener);
  // Keep this causal audit within the switch and its queued microtasks. Existing
  // unrelated dashboard polling can run on later tasks and is recorded separately.
  try {TLIInterface.set(next);for(let i=0;i<4;i++)await Promise.resolve();return {requests,events};}
  finally {window.fetch=original;XMLHttpRequest.prototype.open=originalXhr;window.removeEventListener('tli:interface-change',listener);}
 },next);
}
async function continuity(browser) {
 const run=await ready(browser,1440,'emeraldLight'),{page}=run;
 await page.evaluate(()=>switchPanel('panel-main'));await controlledStream(page);
 // An actual File stays selected in the live input while an unsent draft is moved.
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZukAAAAASUVORK5CYII=','base64');
 await page.locator('#chat-image-input').setInputFiles({name:'interface-fixture.png',mimeType:'image/png',buffer:png});
 await page.locator('#chat-input').fill('My unsent question remains selected.');
 await page.evaluate(()=>{
  const ids=['panel-main','chat-input','chat-image-input','chat-output','chat-composer-shell','quickstart-chips','recent-chats-list','builder-chat-input'];
  window.__interfaceNodes=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
  window.__interfaceFile=document.getElementById('chat-image-input').files[0];
  window.__interfaceTheme=document.documentElement.getAttribute('data-theme');
  const input=document.getElementById('chat-input');input.focus();input.setSelectionRange(3,17,'forward');
 });
 for(const mode of ['classic','modern','classic']) {
  const observation=await observeSwitch(page,mode);assert.deepEqual(observation.requests,[],'Changing interface must not fetch');assert.deepEqual(observation.events,[{interface:mode}]);
  const preserved=await page.evaluate(()=>({nodes:Object.entries(__interfaceNodes).every(([id,node])=>document.getElementById(id)===node),file:document.getElementById('chat-image-input').files[0]===__interfaceFile,draft:document.getElementById('chat-input').value,focus:document.activeElement.id,selection:[document.getElementById('chat-input').selectionStart,document.getElementById('chat-input').selectionEnd],theme:document.documentElement.getAttribute('data-theme')===__interfaceTheme,active:!document.getElementById('panel-main').hidden}));
  assert.deepEqual(preserved,{nodes:true,file:true,draft:'My unsent question remains selected.',focus:'chat-input',selection:[3,17],theme:true,active:true});
 }
 step('Same nodes, selected File object, draft, focus/selection, active Chat and independent color theme survive three interface changes; zero fetch/XHR');
 await page.locator('#chat-image-remove').click();await page.locator('#chat-input').fill('Explain this saved observation.');await page.locator('#chat-send-btn').click();await page.waitForFunction(()=>__interfaceStreams.length===1);
 await page.evaluate(()=>__interfaceStreams[0].frame({type:'delta',text:'The recorded host observation is historical. '}));await page.waitForFunction(()=>document.getElementById('chat-output').innerText.includes('recorded host'));
 await page.locator('#chat-input').fill('A newer unsent draft');
 await page.evaluate(()=>{window.__streamBubble=document.querySelector('#chat-output .chat-bubble-ai:last-child');});
 for(const mode of ['modern','classic']){assert.deepEqual((await observeSwitch(page,mode)).requests,[]);assert.equal(await page.evaluate(()=>__interfaceStreams.length),1);assert.equal(await page.evaluate(()=>__interfaceStreams[0].cancelled||__interfaceStreams[0].signal?.aborted||false),false);}
 await page.evaluate(()=>{__interfaceStreams[0].frame({type:'delta',text:'No new check was run.'});__interfaceStreams[0].frame({type:'done'});__interfaceStreams[0].close();});await page.waitForFunction(()=>!document.getElementById('chat-send-btn').disabled);
 assert.match(await page.locator('#chat-output').innerText(),/historical.*No new check was run/s);assert.equal(await page.locator('#chat-input').inputValue(),'A newer unsent draft');assert.equal(await page.evaluate(()=>__streamBubble===document.querySelector('#chat-output .chat-bubble-ai:last-child')),true);
 step('One controlled SSE request continues across both layouts; existing bubble, AbortSignal and newer composer draft survive until completion');await capture(page,'continuity-stream-classic-1440');await apply(page,'modern');await capture(page,'continuity-stream-modern-1440');await apply(page,'classic');
 // Long existing message history: preserve the scroll container and reading offset.
 await page.evaluate(()=>{const output=document.getElementById('chat-output');for(let i=0;i<40;i++){const p=document.createElement('p');p.className='chat-bubble chat-bubble-ai';p.textContent=('Retained synthetic conversation line '+i+'. ').repeat(8);output.append(p);}output.scrollTop=120;const r=output.getBoundingClientRect();window.__savedChatAnchor=[...output.children].find(el=>{const b=el.getBoundingClientRect();return b.height&&b.top>=r.top&&b.top<r.bottom;});window.__savedChatOffset=__savedChatAnchor?__savedChatAnchor.getBoundingClientRect().top-r.top:null;});
 await apply(page,'modern');const anchorError=await page.evaluate(()=>__savedChatAnchor?Math.abs(__savedChatAnchor.getBoundingClientRect().top-document.getElementById('chat-output').getBoundingClientRect().top-__savedChatOffset):null);assert.notEqual(anchorError,null);assert.ok(anchorError<=2,'Preserve the reading anchor as message wrapping changes');
 step('Existing Chat history reading anchor remains stable when switching its layout');
 await page.evaluate(()=>switchPanel('panel-builder'));await page.locator('#builder-chat-input').fill('Keep this unsent Builder task.');
 let attachmentUploads=0;await page.route('**/api/builder/attachments',route=>{attachmentUploads++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({attachments:[{id:'fixture-attachment',name:'draft-context.txt',size:37,kind:'text'}]})});});
 await page.locator('#builder-attach-input').setInputFiles({name:'draft-context.txt',mimeType:'text/plain',buffer:Buffer.from('Local synthetic attachment, never sent.')});
 await page.waitForFunction(()=>document.getElementById('builder-attachment-tray').innerText.includes('draft-context.txt'));
 const builderBefore=await page.locator('#builder-attachment-tray').innerText();await page.evaluate(()=>{window.__builderFile=document.getElementById('builder-attach-input').files[0];});
 await apply(page,'classic');await apply(page,'modern');assert.equal(await page.locator('#builder-chat-input').inputValue(),'Keep this unsent Builder task.');assert.equal(await page.locator('#builder-attachment-tray').innerText(),builderBefore);assert.equal(await page.evaluate(()=>__builderFile===document.getElementById('builder-attach-input').files[0]),true);
 assert.equal(attachmentUploads,1);step('Builder draft and attachment remain unchanged; one deliberately selected attachment uses a synthetic intercepted upload, no duplicate upload/project/task');
 await page.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('access','settings-section-node-identity');});await page.locator('#settings-node-name').fill('Unsaved room computer label');
 await page.evaluate(()=>{window.__settingsDraft=document.getElementById('settings-node-name');__settingsDraft.focus();__settingsDraft.setSelectionRange(8,12);});
 for(const mode of ['classic','modern']){assert.deepEqual((await observeSwitch(page,mode)).requests,[]);assert.equal(await page.evaluate(()=>document.getElementById('settings-node-name')===__settingsDraft&&document.activeElement===__settingsDraft),true);assert.equal(await page.locator('#settings-node-name').isVisible(),true);assert.equal(await page.locator('#settings-node-name').inputValue(),'Unsaved room computer label');assert.deepEqual(await page.locator('#settings-node-name').evaluate(el=>[el.selectionStart,el.selectionEnd]),[8,12]);}
 step('Settings moves the original content/sidebar; a dirty field in another category stays visible and focused in Modern, without saving');
 await apply(page,'classic');await page.evaluate(()=>TLISettingsWorkspace.open('ai','settings-section-intelligence'));await page.locator('#settings-mesh-cpu-threshold').fill('65');await page.locator('#tli-interface-select').focus();await page.locator('#tli-interface-select').selectOption('modern');assert.equal(await page.locator('#settings-group-ai').isVisible(),true);assert.equal(await page.locator('#settings-mesh-cpu-threshold').isVisible(),true);assert.equal(await page.locator('#settings-mesh-cpu-threshold').inputValue(),'65');assert.equal(await page.locator('#tli-interface-select').evaluate(el=>el===document.activeElement),true);
 step('Using the header switch after editing Classic AI settings keeps that category and unsaved value visible in Modern');
 await page.evaluate(()=>TLINotebook.open());await page.getByRole('button',{name:'New note',exact:true}).click();await page.locator('#notebook-title').fill('Unsent household note');await page.locator('#notebook-text').fill('This draft must remain private and unsaved.');
 await page.evaluate(()=>{window.__noteDraft=document.getElementById('notebook-text');__noteDraft.focus();__noteDraft.setSelectionRange(2,9);});
 await apply(page,'classic');assert.equal(await page.evaluate(()=>document.getElementById('notebook-text')===__noteDraft&&document.activeElement===__noteDraft),true);assert.equal(await page.locator('#notebook-text').inputValue(),'This draft must remain private and unsaved.');assert.equal(await page.locator('#notebook-dialog').evaluate(el=>el.open),true);
 step('An open Notes & fixes dialog and dirty note draft stay open, focused and unsaved');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.evaluate(()=>TLIInterface.get()),'classic');assert.equal(await page.locator('#notebook-text').count(),0);await apply(page,'modern');await apply(page,'classic');assert.equal(await page.locator('#notebook-text').count(),0);
 step('Session lock retains the browser layout preference while private draft controls clear and do not resurrect on a switch');
 await close(run,'continuity');
}

async function preferences(browser) {
 const run=await ready(browser,1440,'midnight',{preserveSettingsOnReload:true}),{page,context}=run;
 assert.equal(await page.evaluate(()=>TLIInterface.get()),'modern');assert.equal(await page.locator('#tli-interface-select').inputValue(),'modern');
 await page.locator('#tli-interface-select').selectOption('classic');assert.equal(await page.evaluate(()=>localStorage.getItem('tli_interface_style')),'classic');await page.reload({waitUntil:'load'});await page.waitForFunction(()=>window.TLIInterface?.get()==='classic');assert.equal(await page.locator('html').getAttribute('data-theme'),'midnight');
 await page.waitForFunction(()=>document.querySelectorAll('.sidebar .tli-nav-group').length===3);assert.equal(await page.locator('.sidebar .tli-nav-group').evaluateAll(groups=>groups.every(g=>g.open)),true);
 step('Modern default and explicit Classic preference survive a real page reload independently of the selected color theme');
 await page.evaluate(()=>switchPanel('panel-settings'));await page.locator('input[name="tli-interface-style"][value="modern"]').check();assert.equal(await page.locator('#tli-interface-select').inputValue(),'modern');
 await page.locator('#tli-interface-select').focus();await page.keyboard.press('c');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>TLIInterface.get()),'classic');
 step('Header select and Settings radio controls synchronize; the quick switch works from the keyboard');
 await page.evaluate(()=>localStorage.setItem('tli_interface_style','<invalid>'));await page.reload({waitUntil:'load'});await page.waitForFunction(()=>!!window.TLIInterface);assert.equal(await page.evaluate(()=>TLIInterface.get()),'modern');
 step('Unrecognized persisted interface values safely use Modern');
 // Only the interface key fails; existing unrelated settings remain readable.
 await context.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(key){if(key==='tli_interface_style')throw new DOMException('Fixture storage unavailable','SecurityError');return get.call(this,key);};Storage.prototype.setItem=function(key,value){if(key==='tli_interface_style')throw new DOMException('Fixture storage unavailable','QuotaExceededError');return set.call(this,key,value);};});
 await page.reload({waitUntil:'load'});await page.waitForFunction(()=>!!window.TLIInterface);assert.equal(await page.evaluate(()=>TLIInterface.get()),'modern');await page.locator('#tli-interface-select').selectOption('classic');assert.equal(await page.evaluate(()=>TLIInterface.get()),'classic');assert.equal(await page.locator('#tli-interface-select').inputValue(),'classic');
 step('Unavailable browser storage does not prevent changing the live interface or corrupting unrelated preferences');
 await close(run,'preferences');
}

async function navigate(page,id,width) {
 if(width>768){const button=page.locator(`.sidebar-nav [data-panel-target="${id}"]`).first();if(before&&!await button.count()){(report.baseline_missing_navigation||=[]).push({width,panel:id});await page.evaluate(id=>switchPanel(id),id);return;}const group=button.locator('xpath=ancestor::details[1]');if(await group.count()&&!await group.evaluate(el=>el.open))await group.locator(':scope > summary').click();await button.click();}
 else {
  const bottom=page.locator(`#tli-bottom-nav [data-panel-target="${id}"]`);
  if(await bottom.count()&&await bottom.first().isVisible())await bottom.first().click();
  else {await page.locator('#tli-bn-more-btn').click();await page.locator(`#tli-more-drawer [data-panel-target="${id}"]`).first().click();}
 }
 await page.waitForTimeout(65);assert.equal(await page.locator('#'+id).isVisible(),true,`Navigation to ${id}`);
}
async function phoneDrawer(browser) {
 const run=await ready(browser,320,'emeraldLight'),{page}=run;
 for(const mode of modes) {
  await apply(page,mode);await page.locator('#tli-bn-more-btn').click();
  assert.equal(await page.locator('#tli-more-drawer').evaluate(el=>getComputedStyle(el).overflowY),'auto');
  const swipe=selector=>page.evaluate(selector=>{const target=document.querySelector(selector);for(const [type,key,y] of [['touchstart','touches',200],['touchend','changedTouches',340]]){const event=new Event(type,{bubbles:true});Object.defineProperty(event,key,{value:[{clientY:y}]});target.dispatchEvent(event);}},selector);
  await swipe('#tli-more-drawer .tli-more-item');assert.equal(await page.locator('#tli-more-drawer').isVisible(),true,'Ordinary list scroll must not dismiss More');
  await swipe('#tli-more-drawer .tli-more-handle');assert.equal(await page.locator('#tli-more-drawer').isVisible(),false);assert.equal(await page.locator('#tli-bn-more-btn').getAttribute('aria-expanded'),'false');
  await page.locator('#tli-bn-more-btn').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#tli-more-drawer').isVisible(),false);assert.equal(await page.locator('#tli-bn-more-btn').evaluate(el=>el===document.activeElement),true);
  await navigate(page,'panel-settings',320);assert.equal(await page.locator('#panel-settings').isVisible(),true);step('320px More list scrolls to its last destination; content swipe stays open, handle swipe closes, Escape restores focus',{interface:mode});
 }
 await close(run,'phone drawer');
}
async function shell(browser) {
 const widths=quick?[1440,390]:[1440,1024,768,390,320];
 for(const width of widths)for(const theme of ['emeraldLight','midnight']) {
  const run=await ready(browser,width,theme),{page}=run;
  for(const mode of modes) {
   await apply(page,mode);
   for(const id of panelIds) {
    await navigate(page,id,width);await checkLayout(page,id,{width,theme,interface:mode});
    if([1440,390,320].includes(width)&&['panel-dashboard2','panel-main','panel-settings','panel-files','panel-vault'].includes(id))await capture(page,`${mode}-${id}-${width}-${theme}`);
   }
   step(before?'Baseline panel layouts (any missing visible entry is recorded separately)':'Every current panel is reachable through visible navigation without actions',{width,theme,interface:mode,panels:panelIds.length});
  }
  await close(run,`shell ${width} ${theme}`);console.log(`Shell ${width} ${theme}`);
 }
}
async function themes(browser) {
 const run=await ready(browser,390,'emeraldLight'),{page}=run;
 const themes=await page.locator('#settings-theme option').evaluateAll(nodes=>nodes.filter(n=>n.value&&!n.disabled).map(n=>({id:n.value,label:n.textContent})));
 assert.ok(themes.length>=23,'All registered themes must be enumerated');report.themes=themes;
 for(const width of [390,320]){await page.setViewportSize({width,height:1000});for(const theme of themes){await page.evaluate(id=>applyTheme(id),theme.id);for(const mode of modes){await apply(page,mode);for(const id of ['panel-main','panel-settings','panel-dashboard2']){await page.evaluate(id=>switchPanel(id),id);await checkLayout(page,id,{width,theme:theme.id,interface:mode,themeSmoke:true});if(width===390){const colors=await contrast(page,id);(report.contrast||=[]).push({theme:theme.id,interface:mode,panel:id,...colors});if(mode==='classic'&&id==='panel-main')await capture(page,`classic-chat-390-${theme.id}-theme`);}}}}}
 for(const theme of themes){await page.evaluate(id=>applyTheme(id),theme.id);const colors=await contrast(page,'tli-interface-select');(report.contrast||=[]).push({theme:theme.id,panel:'tli-interface-select',...colors});}
 for(const theme of ['emeraldLight','midnight'])for(const mode of modes){await page.evaluate(id=>applyTheme(id),theme);await apply(page,mode);for(const id of ['panel-main','panel-settings']){await page.evaluate(id=>switchPanel(id),id);await textScale(page,id,true);await checkLayout(page,id,{width:320,theme,interface:mode,textScale:200});await capture(page,`${mode}-${id}-320-${theme}-text200`);await textScale(page,id,false);}}
 assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);step('All registered palettes remain available in both interfaces; enlarged text and reduced-motion layouts are exercised',{themes:themes.length});await close(run,'themes');
}
async function geometry(browser) {
 const run=await ready(browser,1440,'emeraldLight'),{page}=run,records=[];
 for(const panel of ['panel-main','panel-settings','panel-dashboard2'])for(const mode of modes){await page.evaluate(id=>switchPanel(id),panel);await apply(page,mode);records.push(await page.evaluate(({panel,mode})=>{const box=selector=>{const e=document.querySelector(selector);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(e).display,columns:getComputedStyle(e).gridTemplateColumns};};return {panel,mode,sidebar:box('#sidebar'),panelBox:box('#'+panel),chat:box('#ai-chat-card'),starter:box('#quickstart-chips'),recent:box('#recent-chats-list'),settings:box('#panel-settings .settings-workspace'),settingsContent:box('#panel-settings .settings-main-card'),settingsSidebar:box('#panel-settings .settings-sidebar'),visibleSettingsGroups:[...document.querySelectorAll('.settings-group')].filter(el=>!el.hidden).map(el=>el.id)};},{panel,mode}));}
 report.geometry=records;
 if(!before){for(const panel of ['panel-main','panel-settings']){const pair=records.filter(r=>r.panel===panel);assert.notDeepEqual({...pair[0],mode:null},{...pair[1],mode:null},'Classic must change actual arrangement: '+panel);}const settings=records.filter(r=>r.panel==='panel-settings');assert.ok(settings[0].settingsSidebar.x<settings[0].settingsContent.x);assert.ok(settings[1].settingsSidebar.x>settings[1].settingsContent.x);assert.equal(settings[0].visibleSettingsGroups.length,1);assert.equal(settings[1].visibleSettingsGroups.length,5);const chat=records.filter(r=>r.panel==='panel-main');assert.ok(chat[1].starter.x>chat[1].chat.x+chat[1].chat.width-1);step('Measured Chat starter relocation and Settings content/sidebar order plus all-group visibility demonstrate a real layout switch');}
 await close(run,'geometry');
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try {
 if(process.argv.includes('--themes-only'))await themes(browser);
 else {if(!before&&!process.argv.includes('--visual-only')){await continuity(browser);await preferences(browser);await phoneDrawer(browser);}
 if(!process.argv.includes('--behavior-only')){await geometry(browser);await shell(browser);if(!before&&!quick)await themes(browser);}}
}catch(error){report.failures.push(error.stack||String(error));}finally{await browser.close();}
const colorFailures=(report.contrast||[]).filter(row=>row.findings.length);if(colorFailures.length)report.failures.push(JSON.stringify({kind:'contrast',scopes:colorFailures}));
report.source_end=fingerprintFiles(source);report.changed_source_files=[...new Set([...Object.keys(report.source_start),...Object.keys(report.source_end)])].filter(file=>report.source_start[file]!==report.source_end[file]);report.source_unchanged=!report.changed_source_files.length;
const manifest=path.resolve(source,'../manifest.json');if(fs.existsSync(manifest)){const data=JSON.parse(fs.readFileSync(manifest));report.frozen_source={manifest,manifest_sha256:sha(manifest),fingerprint:data.source_fingerprint,file_count:data.files.length};}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,layouts:report.layouts.length,themes:report.themes.length,screenshots:report.screenshots.length,failures:report.failures,source_unchanged:report.source_unchanged}));if(report.failures.length||!report.source_unchanged)process.exitCode=1;
})();
