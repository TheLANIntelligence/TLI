/* Real SPA, synthetic intercepted responses only. No scans, sends or device actions. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
if(!process.argv.includes('--label'))process.argv.push('--label','connected-workflows');
const {makePage,layout,fixtures,source}=require('./verify_anniversary_ui_browser.cjs');
const output=path.resolve(__dirname,'../build_work/connected-workflows',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const owned=['frontend/js/workflow-assistant.js','frontend/workflow-assistant.css'];
const hashes=()=>Object.fromEntries(owned.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(source,file))).digest('hex')]));
const report={source,output,synthetic:true,hashesAtStart:hashes(),checks:[],layouts:[],screenshots:[],failures:[],limitations:['Synthetic intercepted APIs; no live host, files, device operations or AI generation.','Viewports emulate desktop and narrow browsers; physical-device and screen-reader acceptance are not claimed.','Only new workflow assets are held stable while other agents work.']};
const now=new Date().toISOString();fixtures['/api/intelligence/cases']={ok:true,protocol:'tli-cases-v1',actions_performed:false,checked_at:now,items:[],total:0};
fixtures['/api/intelligence/devices']={devices:[{id:'fixture-studio',name:'Studio',kind:'computer'}]};
async function ownLayout(page,selector){return page.locator(selector).evaluate(root=>{const width=document.documentElement.clientWidth;return [root,...root.querySelectorAll('button,input,textarea,pre')].filter(el=>el.checkVisibility()).filter(el=>{const box=el.getBoundingClientRect();return box.left<0||box.right>width+1||el.scrollWidth>el.clientWidth+2;}).map(el=>({id:el.id,text:el.textContent.slice(0,40),width:el.clientWidth,scrollWidth:el.scrollWidth}));});}
async function capture(page,viewport,theme,mode,name){assert.deepEqual(await ownLayout(page,'#workflow-dialog'),[],'Dialog contents fit');const file=`${name}-${viewport}-${theme}-${mode}.png`;await page.screenshot({path:path.join(output,file),fullPage:false});report.screenshots.push(file);}
async function scenario(browser,width,theme,mode){
 const run=await makePage(browser,width,theme),{page}=run;
 try{
  await page.goto('https://tli-ui.test/',{waitUntil:'load'});
  if(!await page.evaluate(()=>!!window.TLIWorkflowAssistant))await page.addScriptTag({url:'/js/workflow-assistant.js'});
  if(!await page.locator('link[href*="workflow-assistant.css"]').count())await page.addStyleTag({url:'/workflow-assistant.css'});
  await page.evaluate(({mode,theme})=>{TLIInterface.set(mode);TLIThemes.apply(theme);},{mode,theme});
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme);assert.equal(await page.locator('#tli-interface-select').inputValue(),mode);
  await page.waitForSelector('[data-workflow-panel="panel-files"]',{state:'attached'});
  const panels=await page.locator('[data-workflow-panel]').evaluateAll(rows=>rows.map(row=>row.dataset.workflowPanel));
  assert.equal(panels.length,16);
  for(const id of panels){
   await page.evaluate(id=>switchPanel(id),id);await page.locator(`[data-workflow-panel="${id}"]`).scrollIntoViewIfNeeded();
   const result=await layout(page,id);report.layouts.push({width,theme,mode,id,...result});
   assert.deepEqual(await ownLayout(page,`[data-workflow-panel="${id}"]`),[],id+' workflow controls fit');assert.equal(result.duplicateIds.length,0,id+' unique IDs');
  }
  await page.evaluate(()=>switchPanel('panel-files'));await page.locator('#filesRootInput').fill('C:\\Synthetic\\Photos & <family>');
  const before=run.calls.length;
  await page.locator('[data-workflow-panel="panel-files"]').getByRole('button',{name:'Folder checklist',exact:true}).click();
  await page.locator('#workflow-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('.workflow-context').innerText(),/C:\\Synthetic\\Photos & <family>/);
  assert.equal(await page.locator('.workflow-context family').count(),0,'Untrusted path is plain text');
  await page.locator('#workflow-symptom').fill('Access failed on the first attempt.\nThe previous folder draft is retained.');
  await capture(page,width,theme,mode,'folder-checklist');
  await page.locator('#workflow-prepare').click();await page.locator('#workflow-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.getElementById('troubleshooting-symptom').value.includes('C:\\Synthetic'));
  const original=await page.locator('#troubleshooting-symptom').inputValue();
  assert.match(original,/previous folder draft is retained/);assert.match(original,/not a fresh observation/);
  assert.equal(await page.locator('#filesRootInput').inputValue(),'C:\\Synthetic\\Photos & <family>');
  assert.ok(run.calls.slice(before).every(call=>call.method==='GET'),'Preparing checklist only loads existing records');
  report.checks.push({width,theme,mode,name:'Exact folder retained as plain text; unsaved checklist only; no scan, save or operation'});

  await page.evaluate(()=>switchPanel('panel-games'));await page.locator('#go-game-input').fill('My Synthetic Game');
  await page.locator('[data-workflow-panel="panel-games"]').getByRole('button',{name:'Record a settings trial'}).click();
  await page.locator('#workflow-prepare').click();await expectText(page,'#workflow-status','existing problem draft was kept');
  assert.equal(await page.locator('#troubleshooting-symptom').inputValue(),original);
  await capture(page,width,theme,mode,'existing-draft-kept');await page.locator('#workflow-dialog').getByRole('button',{name:'Close',exact:true}).click();

  await page.evaluate(()=>switchPanel('panel-files'));
  await page.locator('[data-workflow-panel="panel-files"]').getByRole('button',{name:'Plan a backup',exact:true}).click();
  assert.match(await page.locator('#workflow-draft').inputValue(),/C:\\\\Synthetic\\\\Photos & <family>/);
  await page.locator('#workflow-draft').fill((await page.locator('#workflow-draft').inputValue())+'\nAsk me which destination drive to use.');
  await capture(page,width,theme,mode,'editable-starter');
  const beforeStarter=run.calls.length;await page.locator('#workflow-prepare').click();await page.locator('#workflow-dialog').waitFor({state:'hidden'});
  const script=await page.locator('#scripts-prompt').inputValue();assert.match(script,/dry-run plan/);assert.match(script,/Synthetic/);assert.match(script,/Ask me which destination drive/);
  assert.ok(run.calls.slice(beforeStarter).every(call=>call.method==='GET'),'Starter never generates or executes');
  await page.locator('[data-workflow-panel="panel-scripts"]').getByRole('button',{name:'Read-only file inventory'}).click();
  await page.locator('#workflow-prepare').click();await expectText(page,'#workflow-status','existing draft was kept');assert.equal(await page.locator('#scripts-prompt').inputValue(),script);
  await page.locator('#workflow-dialog').getByRole('button',{name:'Close',exact:true}).click();
  report.checks.push({width,theme,mode,name:'Problem and script drafts survive conflicting incoming work; starter only fills an empty unsent editor'});

  await page.evaluate(()=>switchPanel('panel-vault'));
  await page.locator('[data-workflow-panel="panel-vault"]').getByRole('button',{name:'Choose a backup'}).click();
  await capture(page,width,theme,mode,'backup-choices');
  await page.locator('#workflow-dialog').getByRole('button',{name:'Vault files, notes and secrets'}).click();
  assert.equal(await page.locator('#vault-backups').getAttribute('open'),'');
  await page.locator('[data-workflow-panel="panel-vault"]').getByRole('button',{name:'Choose a backup'}).click();
  await page.locator('#workflow-dialog').getByRole('button',{name:'TLI notes, chats and reports'}).click();
  assert.equal(await page.locator('#panel-settings').getAttribute('hidden'),null);
  assert.equal(await page.locator('#settings-group-data').isVisible(),true);
  report.checks.push({width,theme,mode,name:'Backup chooser reaches actual Vault controls or Saved data settings without starting a backup'});

  await page.evaluate(()=>switchPanel('panel-builder'));await page.locator('[data-workflow-panel="panel-builder"]').getByRole('button',{name:'Prepare an inspection question'}).click();
  await page.locator('#workflow-prepare').click();await page.locator('#workflow-dialog').waitFor({state:'hidden'});
  assert.match(await page.locator('#builder-chat-input').inputValue(),/do not edit files/);
  await page.locator('[data-workflow-panel="panel-builder"]').getByRole('button',{name:'Review AI setup'}).click();
  assert.equal(await page.locator('#settings-group-ai').isVisible(),true);
  report.checks.push({width,theme,mode,name:'Builder starter stays unsent; AI setup link opens its real settings group'});

  await page.evaluate(()=>switchPanel('panel-files'));await page.locator('[data-workflow-panel="panel-files"]').getByRole('button',{name:'Folder checklist',exact:true}).click();
  await page.evaluate(()=>{window._workflowOriginalHost=TLIUI.hostIdentity;TLIUI.hostIdentity={get:()=>({id:'different-host'})};});
  await page.locator('#workflow-prepare').click();await expectText(page,'#workflow-status','connected host changed');
  assert.equal(await page.locator('#troubleshooting-symptom').inputValue(),original);
  await page.evaluate(()=>{TLIUI.hostIdentity=window._workflowOriginalHost;delete window._workflowOriginalHost;});
  await page.locator('#workflow-dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('[data-workflow-panel="panel-files"]').getByRole('button',{name:'Folder checklist',exact:true}).click();
  await page.evaluate(()=>{window._workflowOriginalOpen=TLITroubleshooting.open;TLITroubleshooting.open=()=>new Promise(resolve=>window._workflowResume=resolve);});
  await page.locator('#workflow-prepare').click();await page.locator('#workflow-dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.evaluate(()=>{window._workflowResume();TLITroubleshooting.open=window._workflowOriginalOpen;delete window._workflowOriginalOpen;delete window._workflowResume;});
  assert.equal(await page.locator('#workflow-dialog').getAttribute('open'),null);assert.equal(await page.locator('#troubleshooting-symptom').inputValue(),original);
  report.checks.push({width,theme,mode,name:'Changed host refuses context handoff; close cancels a pending preparation without touching the existing draft'});

  await page.evaluate(()=>switchPanel('panel-files'));await page.locator('[data-workflow-panel="panel-files"]').getByRole('button',{name:'Folder checklist',exact:true}).click();
  await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));
  assert.equal(await page.locator('#workflow-dialog').getAttribute('open'),null);assert.equal(await page.locator('#workflow-review').innerText(),'');
  assert.equal(await page.locator('[data-workflow-panel]:not([hidden])').count(),0);
  report.checks.push({width,theme,mode,name:'Lock clears sensitive review and hides next steps'});
  assert.deepEqual(run.errors,[],'No JavaScript page errors');
 }finally{await run.context.close();}
}
async function expectText(page,selector,text){await page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text});}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const [width,theme,mode]of[[1440,'emeraldLight','modern'],[1440,'classicTli','classic'],[390,'midnight','modern'],[320,'horizon','classic']])await scenario(browser,width,theme,mode);}
 catch(error){report.failures.push(error.stack||String(error));process.exitCode=1;}
 finally{await browser.close();report.hashesAtEnd=hashes();if(JSON.stringify(report.hashesAtStart)!==JSON.stringify(report.hashesAtEnd)){report.failures.push('Owned source changed during QA');process.exitCode=1;}fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,layouts:report.layouts.length,screenshots:report.screenshots.length,failures:report.failures},null,2));}
})();
