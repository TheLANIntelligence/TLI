/* Current SPA: every selectable theme, actual toggle handlers, no audio/model. */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,layout,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const {textScale}=require('./verify_anniversary_themes_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/anniversary-completion/chat-toggle-contrast-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const report={synthetic:true,source_before:fingerprintFiles(root),themes:[],checks:[],layouts:[],screens:[],errors:[],physical_acceptance:'not_run',limitations:['Actual computed browser text/background colors, with alpha compositing. Synthetic local voice; no audio is played.','200% text doubles computed typography for the open Chat controls; no physical-device or OS-wide zoom claim.']};
async function measure(page){return page.evaluate(()=>{
 const rgb=c=>{const n=c.match(/[\d.]+/g).map(Number);return [n[0],n[1],n[2],n[3]??1];},blend=(a,b)=>a.slice(0,3).map((c,i)=>c*a[3]+b[i]*(1-a[3])).concat(1),lum=rgb=>rgb.slice(0,3).map(v=>(v/=255)<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
 return ['teaching-toggle','tts-toggle'].map(id=>{const el=document.getElementById(id),label=el.querySelector('span:last-child'),style=getComputedStyle(label),layers=[];for(let node=label;node;node=node.parentElement){const s=getComputedStyle(node);if(s.backgroundImage!=='none'||Number(s.opacity)!==1||s.filter!=='none')throw new Error('Unmeasured background/opacity/filter on '+id);const color=rgb(s.backgroundColor);layers.push(color);if(color[3]===1)break;}const bg=layers.reverse().reduce((bottom,top)=>blend(top,bottom),[255,255,255,1]),fg=blend(rgb(style.color),bg),a=lum(fg),b=lum(bg),button=getComputedStyle(el);return {id,foreground:style.color,background:bg.slice(0,3),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fontSize:style.fontSize,on:el.classList.contains('on')||el.classList.contains('active'),ariaPressed:el.getAttribute('aria-pressed'),buttonBackground:button.backgroundColor,buttonColor:button.color,accentBackground:getComputedStyle(document.documentElement).getPropertyValue('--accent-soft').trim(),accentColor:getComputedStyle(document.documentElement).getPropertyValue('--accent-strong').trim(),visible:el.checkVisibility({visibilityProperty:true})};});
});}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  for(const width of [768,320]){
   const run=await makePage(browser,width,'emeraldLight'),{page}=run;await page.evaluate(()=>{
    switchPanel('panel-main');document.getElementById('chat-options').open=true;window.__themeAuditVisible=e=>e.checkVisibility({visibilityProperty:true})&&!e.closest('[hidden],.hidden');window.__played=0;
    speechSynthesis.getVoices=()=>[{name:'Synthetic local playback voice',voiceURI:'fixture-local',lang:'en-US',localService:true,default:true}];speechSynthesis.speak=()=>{window.__played++;};speechSynthesis.cancel=()=>{};TLILocalVoice.setup();
   });
   const themes=await page.locator('#settings-theme option').evaluateAll(options=>options.filter(o=>!o.disabled&&o.value).map(o=>({id:o.value,name:o.textContent})));if(!report.themes.length)report.themes=themes;assert.equal(themes.length,23);
   for(const theme of themes){
    await page.evaluate(id=>applyTheme(id),theme.id);
     assert.equal(await page.locator('html').getAttribute('data-theme'),theme.id,'Requested theme must be applied without fallback');
    for(const scale of [1,2]){
     if(scale===2)await textScale(page,'panel-main',true);
     for(const on of [false,true]){
      await page.evaluate(on=>{const teaching=document.getElementById('teaching-toggle'),tts=document.getElementById('tts-toggle');if(teaching.classList.contains('on')!==on)teaching.click();if((tts.getAttribute('aria-pressed')==='true')!==on)tts.click();},on);
      const colors=await measure(page);assert.ok(colors.every(c=>c.visible&&c.on===on));assert.equal(colors[1].ariaPressed,String(on));for(const color of colors)assert.ok(color.ratio>=4.5,`${theme.id}/${width}/${scale}/${on}/${color.id}: ${color.ratio}`);
      if(on)assert.equal(colors[0].buttonBackground,colors[1].buttonBackground,'Both current handlers use the established active palette');
      report.checks.push({theme:theme.id,width,scale,on,colors,passed:true});
     }
     const measured=await layout(page,'panel-main');assert.deepEqual(measured.overflow,[]);assert.ok(measured.documentWidth<=width+2);report.layouts.push({theme:theme.id,width,scale,measured,passed:true});
     if(['emeraldLight','midnight','classicTli'].includes(theme.id)){
      await page.evaluate(()=>{document.getElementById('teaching-toggle').click();document.getElementById('tts-toggle').click();});await page.locator('#chat-options').scrollIntoViewIfNeeded();const file=`${theme.id}-${width}-text${scale*100}-off.png`;await page.screenshot({path:path.join(output,file)});report.screens.push(file);
     }
     if(scale===2)await textScale(page,'panel-main',false);
    }
   }
   assert.equal(await page.evaluate(()=>window.__played),0);assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion:reduce)').matches),true);assert.equal(run.calls.filter(c=>c.method!=='GET'&&c.method!=='HEAD').length,0);report.errors.push(...run.errors);await run.context.close();
  }
  assert.deepEqual(report.errors,[]);report.passed=true;report.minimumContrast=Math.min(...report.checks.flatMap(c=>c.colors.map(s=>s.ratio)));
 }catch(e){report.passed=false;report.error=String(e.stack||e);process.exitCode=1;}
 finally{report.source_after=fingerprintFiles(root);report.source_changed=JSON.stringify(report.source_before)!==JSON.stringify(report.source_after);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({output,passed:report.passed,themes:report.themes.length,checks:report.checks.length,layouts:report.layouts.length,screens:report.screens.length,minimumContrast:report.minimumContrast,error:report.error}));}
})();
