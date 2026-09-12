/* Actual SPA with intercepted synthetic responses only. No TLI server or actions. */
const {chromium}=require('playwright'), fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,layout,fixtures}=require('./verify_anniversary_ui_browser.cjs');
const output=path.resolve(__dirname,'../build_work/anniversary-continuity/troubleshooting-browser');fs.mkdirSync(output,{recursive:true});
const stamp=new Date().toISOString(), protocol='tli-cases-v1';
const problem={id:'case-'+'a'.repeat(32),revision:'b'.repeat(64),title:'Studio connection drops during a call',symptom:'The studio computer lost Wi-Fi twice yesterday. The saved checks did not identify a cause.',computer:{id:'fixture-computer',name:'Studio computer',node_id:'studio'},status:'open',archived:false,
  steps:[{id:'one',text:'Reviewed the network report from yesterday',status:'tried',outcome:'No repair or new test has been performed.'}],
  evidence:[{kind:'note',id:'fixture-note',revision:'a'.repeat(64),label:'Studio backup location',availability:'changed',linked_at:stamp}],resolution:'',created_at:stamp,updated_at:stamp};
const response=data=>({ok:true,protocol,checked_at:stamp,actions_performed:false,...data});
fixtures['/api/intelligence/cases']=response({items:[problem],total:1});fixtures['/api/intelligence/cases/'+problem.id]=response({case:problem});
fixtures['/api/intelligence/devices']={devices:[{id:'fixture-computer',name:'Studio computer',kind:'computer',node_id:'studio'}]};
const result={synthetic:true,views:[],checks:[],errors:[],limitations:['Browser fixtures only; no native phone, real account, device action or running TLI was used.']};
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  for(const theme of ['emeraldLight','midnight'])for(const width of [1440,1024,390,320]){
    const run=await makePage(browser,width,theme),{page}=run;
    await page.evaluate(()=>switchPanel('panel-troubleshooting'));await page.getByRole('button',{name:problem.title,exact:true}).click();await page.locator('#troubleshooting-title').waitFor();
    for(const scale of [1,2]){
      if(scale===2)await page.evaluate(()=>{document.querySelectorAll('#panel-troubleshooting *').forEach(n=>{n.style.fontSize=parseFloat(getComputedStyle(n).fontSize)*2+'px';});});
      const measured=await layout(page,'panel-troubleshooting');result.checks.push({width,theme,scale,...measured});
      assert.equal(measured.overflow.length,0,JSON.stringify(measured));assert.equal(measured.duplicateIds.length,0);
      if(scale===1&&(width===1440||width===390)){const file=`${theme}-${width}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});result.views.push(file);}
    }
    assert.equal(run.calls.filter(c=>!['GET','HEAD'].includes(c.method)).length,0,'Navigation must not mutate');
    result.errors.push(...run.errors);await run.context.close();
  }
  const run=await makePage(browser,1440,'emeraldLight'),{page}=run;
  await page.evaluate(()=>switchPanel('panel-troubleshooting'));await page.getByRole('button',{name:problem.title,exact:true}).click();await page.locator('#troubleshooting-title').fill('Draft kept across views');
  await page.evaluate(()=>switchPanel('panel-dashboard2'));await page.evaluate(()=>switchPanel('panel-troubleshooting'));assert.equal(await page.locator('#troubleshooting-title').inputValue(),'Draft kept across views');
  await page.route('**/api/intelligence/cases/'+problem.id,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'Changed in another view'})}));
  await page.locator('#troubleshooting-save').click();await page.waitForFunction(()=>document.getElementById('troubleshooting-status').textContent.includes('Your draft remains'));assert.equal(await page.locator('#troubleshooting-title').inputValue(),'Draft kept across views');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));assert.equal(await page.locator('#troubleshooting-title').count(),0);
  result.checks.push({behavior:'draft retained across panels and conflict, cleared on lock',passed:true});result.errors.push(...run.errors);await run.context.close();
  assert.equal(result.errors.length,0);result.passed=true;
}catch(error){result.passed=false;result.failure=error.stack;process.exitCode=1;}finally{await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output,passed:result.passed,checks:result.checks.length,errors:result.errors,failure:result.failure}));}})();
