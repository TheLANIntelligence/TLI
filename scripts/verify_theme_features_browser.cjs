const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
process.argv.push('--label','feature-themes');
const {makePage,layout,out,unexpectedRequests,fixtures}=require('./verify_anniversary_ui_browser.cjs');
fixtures['/visualizer/scan']={path:'C:\\Demo',tree:{name:'Demo',path:'C:\\Demo',is_dir:true,size:300000000,children:[{name:'Photo.jpg',path:'C:\\Demo\\Photo.jpg',size:100000000},{name:'Archive.zip',path:'C:\\Demo\\Archive.zip',size:200000000}]}};
async function inspect(page,selector,property,variable){return page.evaluate(({selector,property,variable})=>{
 const element=document.querySelector(selector);if(!element)throw new Error('Missing '+selector);
 const reference=document.createElement('span');reference.style[property]=`var(${variable})`;document.body.append(reference);
 const expected=getComputedStyle(reference)[property],actual=getComputedStyle(element)[property];reference.remove();
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
 function rgba(value){ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((n,i)=>i===3?n/255:n);}
 function blend(fg,bg){return fg.slice(0,3).map((n,i)=>n*fg[3]+bg[i]*(1-fg[3]));}
 const ancestors=[];for(let parent=element;parent;parent=parent.parentElement)ancestors.unshift(parent);
 let background=[255,255,255];for(const ancestor of ancestors)background=blend(rgba(getComputedStyle(ancestor).backgroundColor),background);
 const foreground=blend(rgba(actual),background);
 const luminance=rgb=>rgb.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
 const a=luminance(foreground),b=luminance(background),contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 const effectiveOpacity=ancestors.reduce((opacity,ancestor)=>opacity*Number(getComputedStyle(ancestor).opacity),1);
 return {selector,property,variable,actual,expected,matched:actual===expected,contrast:Math.round(contrast*100)/100,effectiveOpacity};
},{selector,property,variable});}
async function main(){const browser=await chromium.launch({channel:'msedge',headless:true}),reports=[];
 try{for(const theme of ['oled','lavenderMidnight','lavenderLite','sandLight']){
  const run=await makePage(browser,1440,theme),page=run.page,checks=[];
  await page.evaluate(()=>switchPanel('panel-main'));
  checks.push(await inspect(page,'#chat-send-btn','color','--on-accent, var(--bg-main)'));
  await page.screenshot({path:path.join(out,`chat-${theme}.png`)});
  await page.evaluate(()=>{switchPanel('panel-settings');TLISettingsWorkspace.open('access','settings-section-security');});
  await page.locator('.settings-danger-details').evaluate(e=>{e.open=true;});
  checks.push(await inspect(page,'.settings-danger-details summary','color','--danger'));
  await page.locator('.settings-danger-details').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,`danger-${theme}.png`)});
  await page.evaluate(()=>{const status=document.getElementById('settings-model-status');status.classList.add('error');});
  checks.push(await inspect(page,'#settings-model-status','color','--danger'));
  await page.evaluate(()=>{switchPanel('panel-tools');const status=document.getElementById('tools-description');status.dataset.state='warning';});
  checks.push(await inspect(page,'#tools-description','borderLeftColor','--warning'));
  for(const type of ['success','error','warning','info']){
   await page.evaluate(type=>tliToast('Synthetic '+type+' status',type),type);
   checks.push(await inspect(page,`.tli-toast--${type} .tli-toast-icon`,'color',type==='error'?'--danger':type==='success'?'--success, var(--accent)':'--'+type));
  }
  await page.waitForTimeout(350);
  await page.screenshot({path:path.join(out,`statuses-${theme}.png`)});
  await page.evaluate(()=>tliOpenModelManagerModal());await page.waitForTimeout(50);
  await page.screenshot({path:path.join(out,`models-${theme}.png`)});await page.keyboard.press('Escape');
  await page.evaluate(()=>TLINotebook.open());await page.waitForTimeout(50);
  await page.screenshot({path:path.join(out,`notes-${theme}.png`)});await page.keyboard.press('Escape');
  await page.evaluate(()=>switchPanel('panel-automations'));await page.waitForTimeout(80);
  checks.push(await inspect(page,'#auto-status','color','--danger'));
  await page.evaluate(()=>switchPanel('panel-visualizer'));
  await page.locator('#visualizerPathInput').fill('C:\\Demo');await page.locator('#visualizerScanBtn').click();
  await page.waitForFunction(()=>document.querySelectorAll('#visualizerTableBody .storage-file-action').length===2);
  checks.push(await inspect(page,'#visualizer-json','color','--text-main'));
  await page.locator('#visualizerModePills [data-mode="map"]').click();
  await page.locator('.tm-leaf').first().hover();
  checks.push(await inspect(page,'#_tli_vis_tip','color','--text-main'));
  checks.push(await inspect(page,'#_tli_vis_tip span:last-child','color','--text-muted'));
  await page.screenshot({path:path.join(out,`map-tooltip-${theme}.png`)});
  reports.push({theme,checks,layout:await layout(page,'panel-tools'),errors:run.errors,unexpectedRequests:unexpectedRequests(run.calls)});
  await run.context.close();
 }}finally{await browser.close();}
 fs.writeFileSync(path.join(out,'feature-theme-report.json'),JSON.stringify(reports,null,2));
 console.log(JSON.stringify({out,checks:reports.reduce((sum,report)=>sum+report.checks.length,0),mismatches:reports.flatMap(report=>report.checks.filter(check=>!check.matched).map(check=>({theme:report.theme,...check}))),lowContrast:reports.flatMap(report=>report.checks.filter(check=>check.contrast<(check.property==='color'?4.5:3)).map(check=>({theme:report.theme,...check})))}));
 assert.ok(reports.every(report=>!report.errors.length&&!report.unexpectedRequests.length&&report.checks.every(check=>check.matched)));
 assert.ok(reports.every(report=>report.checks.every(check=>check.contrast>=(check.property==='color'?4.5:3))),'Text and semantic edges retain readable contrast');
 assert.ok(reports.every(report=>report.checks.filter(check=>check.selector.startsWith('.tli-toast')).every(check=>check.effectiveOpacity===1)),'Toast notices remain visible with reduced motion');
}
main().catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),error.stack);console.error(error);process.exitCode=1;});
