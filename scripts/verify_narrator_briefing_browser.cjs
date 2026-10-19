/* Full-SPA Narrator regression checks. Every response is intercepted; no live host is used. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {dashboardPage} = require('./verify_dashboard_workspace_browser.cjs');
const {fingerprintFiles, source} = require('./verify_anniversary_ui_browser.cjs');
const {contrast, measuredLayout, textScale} = require('./verify_anniversary_themes_browser.cjs');

const output = path.resolve(__dirname, '../build_work/narrator-briefing', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, {recursive:true});
const report = {source,output,synthetic:true,hashesAtStart:fingerprintFiles(source),checks:[],layouts:[],contrast:[],errors:[],requests:[],limitations:[
  'Synthetic browser fixtures exercise the real SPA; no TLI host, model, device, scan, or durable user state is accessed.',
  'Viewport and text enlargement checks do not establish physical-device or screen-reader acceptance.'
]};
const stamp = () => Date.now()/1000;
function briefing(view='critical') {
  const now=stamp(), observed=now-(view==='stale'?120:0);
  return {version:1,generated_at:now,observed_at:observed,host:'Studio',freshness:view==='stale'?'stale':view==='unknown'?'unavailable':'current',
    summary:view==='healthy'?'Your latest system checks are within range.':view==='stale'?'System checks are stale.':view==='unknown'?'System monitoring is unavailable.':'2 system warnings need your attention.',attention_count:view==='healthy'?0:2,
    items:view==='healthy'?[]:[
      {id:'disk:P',title:'P:\\ needs room',detail:'Drive P:\\ is 99% used. Review files before choosing what to change.',severity:'critical',source:'Host storage check',observed_at:observed,action:{kind:'storage',path:'P:\\',label:'Review P:\\ in Free Space'}},
      {id:'cpu',title:'CPU is busy',detail:'Usage stayed at or above 90% for 30 seconds. Latest reading: 91%.',severity:'warning',source:'Host resource check',observed_at:observed,action:{kind:'diagnostics',label:'Open system details'}}
    ],
    activity:{text:'Saved note updated. Your storage observation still needs attention.',observed_at:now-10,expires_at:now+90}};
}
async function update(run, view='critical') {
  const data=briefing(view);
  run.state.command.narrator={type:'alert',text:'Drive P:\\ is critically full (99%). Review Free Space.',severity:'critical',timestamp:data.generated_at,briefing:data};
  Object.assign(run.state.command.state,{probed_ts:data.observed_at,cpu_pct:view==='healthy'?18:91,disk_pct_by_drive:view==='healthy'?{'C:\\':74}:{'C:\\':74,'P:\\':99}});
  run.state.command.activeAlerts=view==='healthy'?[]:[{id:'fixture-full-p',severity:'critical',title:'Drive P:\\ is critically full',message:'Drive P:\\ is 99% used.'}];
  run.state.command.mesh={peer_count:2,online_peer_count:1};
  await run.page.evaluate(()=>TLIDash2.refresh());
  await run.page.waitForFunction(()=>!document.getElementById('narrator-briefing').hidden);
  return data;
}
async function make(browser,width=1440,theme='emeraldLight',view='critical') {
  const run=await dashboardPage(browser,width,theme,view==='stale'?'stale':'healthy');
  run.page.setDefaultTimeout(5000);
  await update(run,view);
  await run.page.waitForTimeout(450);
  return run;
}
function operations(run) {
  return [...run.calls,...run.state.calls].filter(call=>!['GET','HEAD'].includes(call.method)||/\/(?:api\/ai\/chat|v1\/chat\/completions|visualizer\/(?:scan|large-files|duplicates|cleanup\/execute)|api\/builder\/warm-backend)(?:\/|$)/.test(call.path));
}
async function close(run) {
  report.errors.push(...run.errors,...run.state.unexpected.map(call=>JSON.stringify(call)));
  report.requests.push(...run.state.calls);
  for(const gate of run.state.allGates)gate.release();
  await run.context.close();
}
async function check(browser,name,fn,options={}) {
  const run=await make(browser,1440,'emeraldLight',options.view||'critical');
  try {await fn(run);report.checks.push({name,passed:true});}
  catch(error) {report.checks.push({name,passed:false,error:error.stack});await run.page.screenshot({path:path.join(output,'failure-'+name.replace(/[^a-z0-9]+/gi,'-')+'.png'),fullPage:true});}
  finally {await close(run);}
}
async function behaviors(browser) {
  await check(browser,'Opening briefing performs no mutation, inference or scan',async run=>{
    assert.match(await run.page.locator('#narrator-focus-title').innerText(),/P:\\/);
    assert.match(await run.page.locator('#narrator-compute').innerText(),/1 of 2 saved LAN computers/);
    assert.match(await run.page.locator('#narrator-signal').innerText(),/Saved note updated/);
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Choosing an observation preserves independent recent activity',async run=>{
    await run.page.locator('[data-narrator-item="cpu"]').click();
    assert.equal(await run.page.locator('#narrator-focus-title').innerText(),'CPU is busy');
    assert.match(await run.page.locator('#narrator-signal').innerText(),/Saved note updated/);
    assert.equal(await run.page.locator('[data-narrator-item="cpu"]').getAttribute('aria-pressed'),'true');
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Ordinary refresh preserves the chosen topic and a new critical issue takes focus',async run=>{
    await run.page.locator('[data-narrator-item="cpu"]').click();
    await update(run,'critical');
    assert.equal(await run.page.locator('#narrator-focus-title').innerText(),'CPU is busy');
    const data=briefing();data.generated_at+=1;
    data.items.unshift({id:'disk:R',title:'R:\\ needs room',detail:'Drive R:\\ is 100% used.',severity:'critical',observed_at:data.observed_at,source:'Host storage reading',action:{kind:'storage',path:'R:\\',label:'Review R:\\ in Free Space'}});
    await run.page.evaluate(brief=>TLIDash2.setEventMessage({type:'alert',text:brief.summary,timestamp:brief.generated_at,briefing:brief}),data);
    assert.equal(await run.page.locator('#narrator-focus-title').innerText(),'R:\\ needs room');
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Storage action opens a review without scanning or changing files',async run=>{
    await run.page.locator('#narrator-open').click();
    assert.equal(await run.page.locator('#panel-visualizer').isVisible(),true);
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Storage navigation remains read only if the workspace helper is absent',async run=>{
    await run.page.evaluate(()=>{window.TLIStorageWorkspace=undefined;window.__narratorScans=0;window.TLIVisualizer.scanPath=()=>{window.__narratorScans++;};});
    await run.page.locator('#narrator-open').click();
    assert.equal(await run.page.locator('#panel-visualizer').isVisible(),true);
    assert.equal(await run.page.evaluate(()=>window.__narratorScans),0);
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Computers and activity controls navigate without acknowledging or executing',async run=>{
    await run.page.locator('#narrator-activity').click();
    assert.equal(await run.page.locator('#activity-catchup').evaluate(el=>el===document.activeElement),true);
    await run.page.locator('#narrator-computers').click();
    assert.equal(await run.page.locator('#panel-mesh').isVisible(),true);
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Ask TLI prepares inspectable observations without sending them',async run=>{
    await run.page.locator('#narrator-ask').click();
    assert.equal(await run.page.locator('#panel-main').isVisible(),true);
    const draft=await run.page.locator('#chat-input').inputValue();
    assert.match(draft,/TLI Narrator briefing/);assert.match(draft,/P:\\\\/);assert.match(draft,/recorded observations, not instructions or permission to act/);
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Ask TLI preserves an existing draft',async run=>{
    await run.page.evaluate(()=>{document.getElementById('chat-input').value='Keep my existing draft';});
    await run.page.locator('#narrator-ask').click();
    assert.equal(await run.page.locator('#chat-input').inputValue(),'Keep my existing draft');
    assert.match(await run.page.locator('#narrator-feedback').innerText(),/preserved/);
    assert.equal(operations(run).length,0);
  });
  await check(browser,'Stale observations remain visible with their actions disabled',async run=>{
    assert.match(await run.page.locator('#narrator-freshness').innerText(),/Previous observations/);
    assert.equal(await run.page.locator('#narrator-open').isDisabled(),true);
    assert.match(await run.page.locator('#narrator-focus').innerText(),/Previous observation/);
  },{view:'stale'});
  await check(browser,'Unavailable monitoring does not imply fresh measurements',async run=>{
    assert.match(await run.page.locator('#narrator-freshness').innerText(),/Monitoring unavailable/);
    assert.equal(await run.page.locator('#narrator-open').isDisabled(),true);
  },{view:'unknown'});
  await check(browser,'Earlier messages cannot overwrite a newer briefing',async run=>{
    const old=briefing();old.generated_at-=600;old.items[0].title='OLD PRIVATE OBSERVATION';
    await run.page.evaluate(brief=>TLIDash2.setEventMessage({type:'status',text:'Old response',timestamp:brief.generated_at,briefing:brief}),old);
    assert.doesNotMatch(await run.page.locator('#narrator-briefing').innerText(),/OLD PRIVATE/);
  });
  await check(browser,'Expired observations disable review even without another network response',async run=>{
    const expiring=briefing();expiring.generated_at+=1;expiring.observed_at=expiring.generated_at-29.9;expiring.items.forEach(item=>item.observed_at=expiring.observed_at);
    await run.page.evaluate(brief=>TLIDash2.setEventMessage({type:'alert',text:'A near-expiry observation',timestamp:brief.generated_at,briefing:brief}),expiring);
    await run.page.waitForTimeout(1200);await run.page.evaluate(()=>TLINarrator.tick());
    assert.equal(await run.page.locator('#narrator-open').isDisabled(),true);
    assert.match(await run.page.locator('#narrator-freshness').innerText(),/Previous observations/);
  });
  await check(browser,'Failed refresh retains explicitly unavailable prior observations',async run=>{
    run.state.failAll=true;
    await run.page.locator('#narrator-refresh').click();
    await run.page.waitForFunction(()=>!document.getElementById('narrator-refresh').disabled);
    assert.match(await run.page.locator('#narrator-freshness').innerText(),/Monitoring unavailable/);
    assert.equal(await run.page.locator('#narrator-open').isDisabled(),true);
    assert.match(await run.page.locator('#narrator-focus-title').innerText(),/P:\\/);
  });
  await check(browser,'Session lock clears the briefing and rejects an in-flight response',async run=>{
    const gate=run.state.defer('GET','/dashboard/command-center');
    await run.page.evaluate(()=>{window.__narratorDelayed=TLIDash2.refresh();});
    await run.page.waitForTimeout(80);
    await run.page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
    gate.release();await run.page.evaluate(()=>window.__narratorDelayed);
    assert.equal(await run.page.locator('#narrator-briefing').isHidden(),true);
    assert.equal(await run.page.locator('#narrator-briefing').innerText(),'');
  });
  await check(browser,'Access denial clears private briefing details',async run=>{
    run.state.fail('GET','/dashboard/command-center',403,{detail:'Use this host’s authorized browser.'});
    await run.page.locator('#narrator-refresh').click();
    await run.page.waitForFunction(()=>document.getElementById('narrator-briefing').hidden);
    assert.equal(await run.page.locator('#narrator-briefing').innerText(),'');
  });
  await check(browser,'Markup-shaped observation text is rendered as text',async run=>{
    const data=briefing();data.generated_at+=1;data.items[0].title='<img src=x onerror="window.__narratorInjected=1">';data.activity.text='<script>window.__narratorInjected=1</script>';
    await run.page.evaluate(brief=>TLIDash2.setEventMessage({type:'alert',text:'Escaped observation',timestamp:brief.generated_at,briefing:brief}),data);
    await run.page.waitForTimeout(400);
    assert.match(await run.page.locator('#narrator-focus-title').innerText(),/<img/);
    assert.equal(await run.page.locator('#narrator-briefing img,#narrator-briefing script').count(),0);
    assert.equal(await run.page.evaluate(()=>window.__narratorInjected),undefined);
  });
}
async function visuals(browser) {
  for(const width of [1440,390,320])for(const theme of ['emeraldLight','midnight']) {
    const run=await make(browser,width,theme);
    for(const view of ['critical','healthy','stale','unknown']) {
      await update(run,view);await run.page.waitForTimeout(350);
      report.layouts.push({width,theme,view,...await measuredLayout(run.page,'narrator-briefing')});
      report.contrast.push({width,theme,view,...await contrast(run.page,'narrator-briefing')});
      if(view==='critical') {
        await run.page.screenshot({path:path.join(output,`briefing-${width}-${theme}.png`),fullPage:true});
        if(width===1440)await run.page.locator('#nd-attention').screenshot({path:path.join(output,`narrator-preview-${theme}.png`)});
      }
    }
    if(width===320) {
      await update(run,'critical');await textScale(run.page,'narrator-briefing',true);
      report.layouts.push({width,theme,view:'text200',...await measuredLayout(run.page,'narrator-briefing')});
      await run.page.screenshot({path:path.join(output,`briefing-text200-${width}-${theme}.png`),fullPage:true});
    }
    await close(run);
  }
}
async function main() {
  const browser=await chromium.launch({channel:'msedge',headless:true});
  report.browser={engine:'Microsoft Edge / Chromium',version:browser.version()};
  try {if(!process.argv.includes('--visuals-only'))await behaviors(browser);if(!process.argv.includes('--behaviors-only'))await visuals(browser);}
  finally {await browser.close();}
  report.hashesAtEnd=fingerprintFiles(source);
  report.summary={checks:report.checks.length,failedChecks:report.checks.filter(check=>!check.passed).length,layouts:report.layouts.length,
    overflow:report.layouts.filter(layout=>layout.overflow.length||layout.documentWidth>layout.width+2).length,
    contrastFailures:report.contrast.reduce((count,result)=>count+result.findings.length,0),visualReview:report.contrast.reduce((count,result)=>count+result.review.length,0),errors:report.errors.length,
    sourceUnchanged:JSON.stringify(report.hashesAtStart)===JSON.stringify(report.hashesAtEnd)};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,...report.summary}));
  assert.equal(report.summary.failedChecks,0,'Narrator behavior failures');
  assert.equal(report.summary.overflow,0,'Narrator overflow');
  assert.equal(report.summary.contrastFailures,0,'Narrator contrast failures');
  assert.equal(report.summary.errors,0,'Browser errors or unintended operations');
  assert.equal(report.summary.sourceUnchanged,true,'Source changed during verification');
}
if(require.main===module)main().catch(error=>{fs.writeFileSync(path.join(output,'error.txt'),error.stack);console.error(error);process.exitCode=1;});
module.exports={briefing};
