/* Actual SPA with synthetic, intercepted game/provider traffic only. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,layout,source}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build_work/simplification/game-browser',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});
const controls=['shadow_quality','texture_quality','mirror_quality'].map(key=>({key,label:key.split('_').map(word=>word[0].toUpperCase()+word.slice(1)).join(' '),values:['Low','Medium','High','Ultra']}));
const report={source,synthetic:true,passed:false,behaviors:[],layouts:[],screenshots:[],errors:[]};
async function session(browser,width,theme){
 const f=await makePage(browser,width,theme),state={calls:[],fail:false};
 await f.page.route('**/system/summary',route=>{state.calls.push({path:'/system/summary',method:'GET'});return route.fulfill({json:{cpu:{model:'Synthetic CPU',cores:8,threads:16},gpu:{model:'Synthetic GPU',vram_gb:8},memory:{total_gb:32},display:{width:2560,height:1440,hz:144}}});});
 await f.page.route('**/games/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;let body=null;try{body=req.postDataJSON()}catch{}
  state.calls.push({path:p,method:req.method(),body});
  if(p==='/games/advice_provider'){const provider=url.searchParams.get('provider');return route.fulfill({json:{provider,label:provider==='bundled'?'Integrated AI':'LM Studio',model:'Synthetic model',provider_key:(provider==='bundled'?'a':'b').repeat(64),readiness:'not_tested',inference_host:provider==='bundled'?'127.0.0.1':'studio.example'}});}
  if(p==='/games/config_read'){const supported=body.game_name==='Cyberpunk 2077';return route.fulfill({json:{game_name:body.game_name,supported,error:supported?null:'No installed reader',settings:supported?[{key:'shadow_quality',label:'Shadow Quality',value:'High'}]:[],advice_controls:supported?controls:[]}});}
  if(p==='/games/ask'){
   if(state.fail)return route.fulfill({status:409,json:{detail:'The selected AI model changed. Check selection again.'}});
   const custom=body.custom_settings?.[0],current=custom?.current||body.manual_values?.shadow_quality||'High',label=custom?.label||'Shadow Quality',key=custom?'custom_0':'shadow_quality';
   const plan={key,label,current,current_source:custom||body.manual_values?.shadow_quality?'user':'read',suggested:body.preset==='max_visual'?'High':'Low',scope:custom?'user-named; options unverified':'installed reader vocabulary',reason:'Compare this setting in the same scene.',tradeoff:'Image detail and frame times may differ.'};
   const text=`1. ${label} — ${current} (${plan.current_source==='user'?'you entered this value':'read from this game'}) → try ${plan.suggested}. Why: ${plan.reason} Tradeoff: ${plan.tradeoff}\n\nAchievable FPS is unknown until compared; no settings changed.`;
   return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({meta:{source:'ai-advice',provider:body.provider,model:'Synthetic model',settings_plan:[plan]}})+'\n\ndata: '+JSON.stringify({t:text})+'\n\ndata: [DONE]\n\n'});
  }
  return route.fulfill({status:404,json:{detail:'No synthetic route'}});
 });
 await f.page.evaluate(()=>switchPanel('panel-games'));
 await f.page.locator('#go-analyze-btn').waitFor();await f.page.locator('.game-ai-options > summary').click();await f.page.locator('.game-corrections > summary').click();return{...f,state};
}
async function check(f,width,theme,label){const value=await layout(f.page,'panel-games');report.layouts.push({width,theme,label,...value});assert.equal(value.overflow.length,0,JSON.stringify(value.overflow));assert.ok(value.documentWidth<=width+2);assert.equal(value.duplicateIds.length,0);const name=`${label}-${width}-${theme}.png`;await f.page.screenshot({path:path.join(out,name),fullPage:true});report.screenshots.push(name);}
async function main(){const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const f=await session(browser,1440,'emeraldLight');await f.page.waitForFunction(()=>document.getElementById('go-hardware-status').textContent.startsWith('Detected'));
 assert.deepEqual(f.state.calls.map(c=>c.path),['/system/summary']);assert.equal(await f.page.locator('#go-game-input').inputValue(),'');
 for(const text of ['Synthetic CPU','Synthetic GPU','8 GB VRAM','32 GB RAM','2560 × 1440','144 Hz'])assert.ok((await f.page.locator('#go-hw-pills').innerText()).includes(text),text);
 assert.ok(await f.page.locator('#go-read-hardware-btn').isVisible());report.behaviors.push('Opening Game Optimizer reads and shows PC specs before choosing a game, with a visible refresh and no game read, inference, or performance observation.');
 await check(f,1440,'emeraldLight','automatic-specs');
 await f.page.locator('#go-game-input').fill('Cyberpunk 2077');await f.page.locator('#go-analyze-btn').click();await f.page.getByLabel('Shadow Quality current value',{exact:true}).waitFor();
 assert.match(await f.page.locator('#go-settings-block').innerText(),/Choices use reader vocabulary; confirm they exist in your game version/);
 assert.equal(f.state.calls.filter(c=>c.path==='/system/summary').length,2);assert.equal(f.state.calls.filter(c=>c.path==='/games/config_read').length,1);assert.equal(f.state.calls.filter(c=>c.path==='/games/ask').length,0);
 await f.page.getByLabel('Shadow Quality current value',{exact:true}).selectOption('Medium');await f.page.locator('#go-question').fill('A follow-up about the busy city scene');await f.page.locator('#go-ask-btn').click();await f.page.waitForFunction(()=>document.getElementById('go-request-status').textContent.includes('Advice received'));
 assert.match(await f.page.locator('#go-output').innerText(),/Medium \(you entered this value\)/);let last=f.state.calls.filter(c=>c.path==='/games/ask').at(-1);assert.equal(last.body.manual_values.shadow_quality,'Medium');assert.equal(last.body.provider_key,'a'.repeat(64));report.behaviors.push('Reviewed values and exact provider binding travel with one deliberate advice request.');
 await f.page.locator('#go-question').fill('Try another setting after shadows did not help');await f.page.locator('#go-ask-btn').click();await f.page.waitForFunction(()=>document.getElementById('go-request-status').textContent.includes('Advice received'));last=f.state.calls.filter(c=>c.path==='/games/ask').at(-1);assert.equal(last.body.history.length,1);assert.deepEqual(last.body.avoid_settings,['shadow_quality']);report.behaviors.push('Completed same-game history and the explicit different-settings choice are retained.');
 const previous=await f.page.locator('#go-output').innerText();f.state.fail=true;await f.page.locator('#go-ask-btn').click();await f.page.waitForFunction(()=>document.getElementById('go-request-status').textContent.includes('model changed'));assert.equal(await f.page.locator('#go-output').innerText(),previous);report.behaviors.push('A rejected model binding retains the earlier advice and request draft.');f.state.fail=false;
 await check(f,1440,'emeraldLight','reader-plan');
 await f.page.locator('#go-game-input').fill('Synthetic new game');await f.page.locator('#go-analyze-btn').click();await f.page.getByLabel('Quality setting 1 name',{exact:true}).fill('Shadow detail');await f.page.getByLabel('Current value for quality setting 1',{exact:true}).selectOption('High');await f.page.locator('#go-provider').selectOption('lmstudio');await f.page.locator('#go-ask-btn').click();await f.page.waitForFunction(()=>document.getElementById('go-request-status').textContent.includes('Advice received'));
 last=f.state.calls.filter(c=>c.path==='/games/ask').at(-1);assert.deepEqual(last.body.custom_settings,[{label:'Shadow detail',current:'High'}]);assert.equal(last.body.history.length,0);assert.equal(last.body.provider,'lmstudio');assert.equal(last.body.provider_key,'b'.repeat(64));report.behaviors.push('Other games retain user-named settings with unverified menu scope; game changes exclude foreign history.');
 await check(f,1440,'emeraldLight','manual-game');report.errors.push(...f.errors);await f.context.close();
 for(const theme of ['emeraldLight','midnight'])for(const width of [768,390,320]){const g=await session(browser,width,theme);await g.page.locator('#go-game-input').fill('Cyberpunk 2077');await g.page.locator('#go-analyze-btn').click();await g.page.getByLabel('Shadow Quality current value',{exact:true}).waitFor();await check(g,width,theme,'review');report.errors.push(...g.errors);await g.context.close();}
 assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.passed=true;
 }finally{await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,out,behaviors:report.behaviors.length,layouts:report.layouts.length,errors:report.errors}));}}
main().catch(error=>{console.error(error);process.exitCode=1});
