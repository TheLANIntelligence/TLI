/* Actual SPA; synthetic API responses only. No host, model or game changes. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {makePage,layout}=require('./verify_anniversary_ui_browser.cjs');
const outputIndex=process.argv.indexOf('--output');
const out=outputIndex<0?path.resolve(__dirname,'../build_work/ui-refinement-2026-10-17'):path.resolve(process.argv[outputIndex+1]);
fs.mkdirSync(out,{recursive:true});
const controls=[{key:'shadow_quality',label:'Shadow Quality',values:['Low','Medium','High','Ultra']}];
const report={synthetic:true,passed:false,behaviors:[],layouts:[],screenshots:[],errors:[]};
function plan(body){
 // Use the real pure planner against fixture inputs; no app import or host reads.
 const code="import json,sys; from types import SimpleNamespace as N; from intelligence.game_plans import build_plan; d=json.load(sys.stdin); settings=[N(**x) for x in d.pop('current_settings',[])]; d['custom_trials']=[N(**x) for x in d.get('custom_trials',[])]; d['custom_settings']=[]; d['avoid_settings']=[]; print(json.dumps(build_plan(N(**d),settings,check=lambda:None)))";
 return JSON.parse(execFileSync(path.resolve(__dirname,'../backend/.venv/Scripts/python.exe'),['-c',code],{cwd:path.resolve(__dirname,'../backend'),input:JSON.stringify(body),encoding:'utf8',windowsHide:true}));
}
async function session(browser,width,theme){
 const f=await makePage(browser,width,theme),state={calls:[],pending:null,delay:false,configValue:'High'};
 await f.page.route('**/system/summary',route=>route.fulfill({json:{cpu:{model:'Example CPU',cores:8,threads:16},gpu:{model:'Example GPU',vram_gb:8},memory:{total_gb:32},display:{width:2560,height:1440,hz:144}}}));
 await f.page.route('**/games/**',async route=>{
  const req=route.request(),p=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():null;state.calls.push({path:p,body});
  if(p==='/games/plan'){const fulfill=()=>route.fulfill({json:plan(body)}).catch(()=>{});if(state.delay){state.pending=fulfill;return;}return fulfill();}
  if(p==='/games/config_read')return route.fulfill({json:{game_name:body.game_name,supported:true,settings:[{key:'shadow_quality',label:'Shadow Quality',value:state.configValue}],advice_controls:controls}});
  if(p==='/games/detect_best')return route.fulfill({json:{ok:true,game:{name:'A different game'}}});
  if(p==='/games/advice_provider')return route.fulfill({status:503,json:{detail:'AI unavailable in this fixture.'}});
  return route.fulfill({status:503,json:{detail:'Synthetic service unavailable.'}});
 });
 await f.page.evaluate(()=>switchPanel('panel-games'));
 await f.page.waitForFunction(()=>document.getElementById('go-hardware-status').textContent.startsWith('Detected'));
 return {...f,state};
}
async function settled(f){await f.page.waitForFunction(()=>!document.getElementById('go-plan-btn').disabled);}
async function buildKnown(f){
 await f.page.locator('#go-game-input').fill('Cyberpunk 2077');await f.page.locator('#go-analyze-btn').click();
 await f.page.waitForFunction(()=>!TLIGames.trialContext().busy);
 await f.page.locator('#go-plan-btn').click();await f.page.locator('.game-setting-trial').waitFor();await settled(f);
}
async function check(f,width,theme,label){
 const value=await layout(f.page,'panel-games');report.layouts.push({width,theme,label,...value});assert.equal(value.overflow.length,0,JSON.stringify(value.overflow));assert.ok(value.documentWidth<=width+2);assert.equal(value.duplicateIds.length,0);
 const name=`games-${label}-${width}-${theme}.png`;await f.page.screenshot({path:path.join(out,name),fullPage:true});report.screenshots.push(name);
}
async function main(){const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const f=await session(browser,1440,'emeraldLight');await check(f,1440,'emeraldLight','start');
 await buildKnown(f);assert.match(await f.page.locator('#go-trial-cards').innerText(),/High\s*→\s*Medium/);
 assert.equal(f.state.calls.filter(c=>/advice_provider|\/ask/.test(c.path)).length,0);
 report.behaviors.push('Saved settings produce a current-to-trial card without any AI request.');
 await f.page.getByRole('button',{name:'Compare this setting',exact:true}).click();
 await f.page.locator('#go-compare-scene').fill('City market, same route');await f.page.locator('#go-compare-before').fill('60');await f.page.locator('#go-compare-after').fill('75');await f.page.locator('#go-compare-same').check();await f.page.locator('#go-compare-btn').click();
 assert.match(await f.page.locator('#go-compare-result').innerText(),/25.0% higher average FPS/i);assert.ok(await f.page.locator('#go-copy-comparison').isVisible());
 await check(f,1440,'emeraldLight','comparison');report.behaviors.push('60 to 75 FPS reports 25% and labels the measurements as user-entered.');
 await f.page.locator('#go-compare-metric').selectOption('frame-time');await f.page.locator('#go-compare-before').fill('20');await f.page.locator('#go-compare-after').fill('15');await f.page.locator('#go-compare-btn').click();assert.match(await f.page.locator('#go-compare-result').innerText(),/25.0% lower/);assert.match(await f.page.locator('#go-compare-result').innerText(),/favorable/);
 await f.page.locator('#go-compare-same').uncheck();await f.page.locator('#go-compare-btn').click();assert.match(await f.page.locator('#go-compare-result').innerText(),/confirm/);assert.ok(await f.page.locator('#go-copy-comparison').isHidden());
 report.behaviors.push('Frame-time improvements use the correct direction; unmatched conditions cannot produce a comparison.');
 await f.page.locator('#go-detect-btn').click();await f.page.getByRole('button',{name:'Use this game',exact:true}).click();await f.page.waitForFunction(()=>document.getElementById('go-game-input').value==='A different game');assert.equal(await f.page.locator('.game-setting-trial').count(),0);assert.ok(await f.page.locator('#go-comparison').isHidden());
 report.behaviors.push('Detected game changes clear the old trial and private comparison label.');
 await f.page.locator('#go-plan-btn').click();await f.page.getByLabel('Setting for trial 1',{exact:true}).waitFor();
 await f.page.getByLabel('Setting for trial 1',{exact:true}).fill('Motion blur');await f.page.getByLabel('Current value for trial 1',{exact:true}).fill('On');await f.page.getByLabel('Trial value for trial 1',{exact:true}).fill('Off');await f.page.locator('#go-plan-btn').click();await f.page.locator('.game-setting-trial').waitFor();
 assert.match(await f.page.locator('#go-trial-cards').innerText(),/On\s*→\s*Off/);assert.equal(f.state.calls.at(-1).body.custom_trials[0].label,'Motion blur');await check(f,1440,'emeraldLight','manual');report.behaviors.push('Unlisted games support exact menu options such as On to Off, without invented quality levels.');
 f.state.delay=true;await f.page.locator('#go-plan-btn').click();await f.page.waitForTimeout(100);assert.ok(f.state.pending);await f.page.locator('#go-game-input').fill('Next game');await f.state.pending();await f.page.waitForTimeout(100);assert.equal(await f.page.locator('.game-setting-trial').count(),0);f.state.delay=false;
 report.behaviors.push('A late previous-game plan cannot reappear after switching games.');
 await buildKnown(f);await f.page.getByRole('button',{name:'Compare this setting',exact:true}).click();const before=f.state.calls.length;
 await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await f.page.locator('#go-compare-setting').textContent(),'');assert.equal(await f.page.locator('.game-setting-trial').count(),0);assert.ok(await f.page.locator('#go-plan-btn').isDisabled());
 await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-unlocked')));assert.ok(await f.page.locator('#go-plan-btn').isDisabled());await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-private-observation-ready')));assert.equal(f.state.calls.length,before);
 report.behaviors.push('Lock clears private results; unlock does not replay reads or planning.');report.errors.push(...f.errors);await f.context.close();
 for(const [width,theme] of [[390,'emeraldLight'],[320,'midnight'],[768,'midnight']]){const g=await session(browser,width,theme);await buildKnown(g);await g.page.getByRole('button',{name:'Compare this setting',exact:true}).click();await g.page.locator('#go-compare-scene').fill('Repeatable benchmark');await g.page.locator('#go-compare-before').fill('60');await g.page.locator('#go-compare-after').fill('75');await g.page.locator('#go-compare-same').check();await g.page.locator('#go-compare-btn').click();assert.match(await g.page.locator('#go-compare-result').innerText(),/25.0%/);await g.page.locator('#go-compare-result').scrollIntoViewIfNeeded();await check(g,width,theme,'trial');report.errors.push(...g.errors);await g.context.close();}
 assert.deepEqual(report.errors,[]);report.passed=true;
 }finally{await browser.close();fs.writeFileSync(path.join(out,'game-trials-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,out,behaviors:report.behaviors.length,layouts:report.layouts.length,errors:report.errors}));}}
module.exports={session,buildKnown,settled,plan};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1});
