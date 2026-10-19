/* Real SPA, intercepted synthetic update/restart responses. Never contacts a host. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,layout,fixtures}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build_work','update-in-app-2026-10-19');
fs.mkdirSync(out,{recursive:true});
const initial={state:'available',current_version:'1.4.6-beta',latest_version:'1.4.7-beta',platform:'windows',can_prepare:true,can_open:false,can_install:false,progress:0,auto_check:false,update_url:'https://thelanintelligence.com/downloads.json',notes:'Synthetic update release.'};
const preview={schema_version:1,instance_id:'old_process',installation_id:'original_install',action:'install',preview_id:'fixture_review',expires_at:Date.now()/1000+3600,current_version:initial.current_version,version:initial.latest_version,current_url:'http://127.0.0.1:8000/',next_url:'http://127.0.0.1:8000/',consequences:['Active work will stop. Updated Python and runtime components may require internet access; model weights are preserved.'],preserves:['data','settings','models','Python environment']};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg','.json':'application/json','.woff2':'font/woff2'};
const report={synthetic:true,sessions:[],screens:[],failures:[]};
async function main(){
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  for(const width of [1440,390,320])for(const theme of ['emeraldLight','midnight']){
   const run=await makePage(browser,width,theme),calls=[];let status={...initial},operation=null,newProcess=false;
   await run.page.route('http://127.0.0.1:8000/**',async route=>{
    const req=route.request(),url=new URL(req.url()),pathname=decodeURIComponent(url.pathname),method=req.method();
    calls.push({path:pathname,method});
    const json=(value,code=200)=>route.fulfill({status:code,json:value});
    if(pathname==='/update/status')return json(status);
    if(pathname==='/update/check')return json(status);
    if(pathname==='/update/apply'){status={...status,state:'ready',can_prepare:false,can_open:true,can_install:true,progress:100,ready_path:'C:\\TLI\\data\\updates\\prepared'};return json({ok:true});}
    if(pathname==='/update/install/preview')return json(preview);
    if(pathname==='/update/install/confirm'){const body=req.postDataJSON();assert.equal(body.preview_id,preview.preview_id);operation={...preview,request_id:body.request_id,status:'accepted'};return json(operation,202);}
    if(pathname.startsWith('/update/install/receipt/')){operation.status='preparing';return json(operation);}
    if(pathname==='/api/host-control/v1/lifecycle/ready')return json({schema_version:1,installation_id:preview.installation_id,instance_id:newProcess?'new_process':'old_process',current_version:newProcess?initial.latest_version:initial.current_version});
    if(!['GET','HEAD'].includes(method))return json({detail:'Synthetic fixture blocks host actions.'},409);
    const file=path.resolve(root,'frontend','.'+(pathname==='/'?'/index.html':pathname));
    if(file.startsWith(path.join(root,'frontend')+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({contentType:mime[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
    return json(Object.hasOwn(fixtures,pathname)?fixtures[pathname]:{detail:'Synthetic service unavailable'},Object.hasOwn(fixtures,pathname)?200:503);
   });
   await run.page.goto('http://127.0.0.1:8000/',{waitUntil:'load'});
   await run.page.waitForFunction(()=>typeof switchPanel==='function');
   await run.page.evaluate(()=>switchPanel('panel-settings'));
   await run.page.locator('[data-settings-category="app"]').click();
   await run.page.locator('#settings-section-updates .settings-section-header').click();
   const screen=async name=>{const file=path.join(out,`${width}-${theme}-${name}.png`);await run.page.screenshot({path:file});report.screens.push(file);};
   await run.page.locator('#settings-update-action-btn').click();
   await run.page.waitForFunction(()=>document.getElementById('settings-update-action-btn').textContent==='Install and restart…');
   await run.page.locator('#settings-section-updates').scrollIntoViewIfNeeded();await screen('downloaded');
   await run.page.locator('#settings-update-action-btn').click();
   await run.page.waitForFunction(()=>!document.getElementById('tli-update-install-confirm').disabled);
   assert.equal(calls.filter(c=>c.path.endsWith('/confirm')).length,0);
   const reviewLayout=await layout(run.page,'tli-update-install-dialog');assert.deepEqual(reviewLayout.overflow,[]);assert.deepEqual(reviewLayout.duplicateIds,[]);
   const geometry=await run.page.locator('#tli-update-install-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
   assert(geometry.left>=0&&geometry.right<=geometry.width&&geometry.top>=0&&geometry.bottom<=geometry.height);
   await screen('review');
   await run.page.locator('#tli-update-install-confirm').click();
   await run.page.waitForFunction(()=>document.getElementById('tli-update-install-status').textContent.includes('Preparing updated Python'));
   await screen('preparing');newProcess=true;
   await run.page.locator('#tli-update-install-check').click();
   await run.page.waitForFunction(()=>document.getElementById('tli-update-install-title').textContent==='Update confirmed');
   await screen('confirmed');assert.equal(calls.filter(c=>c.path.endsWith('/confirm')).length,1);
   assert.equal(await run.page.url(),'http://127.0.0.1:8000/');
   await run.page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
   assert.equal(await run.page.locator('#tli-update-install-dialog').evaluate(el=>el.open),false);
   const errors=run.errors.filter(value=>/tli-update\.js|update-workspace/.test(value));assert.deepEqual(errors,[]);
   report.sessions.push({width,theme,reviewLayout,geometry,updateCalls:calls.filter(c=>c.path.startsWith('/update/')||c.path.endsWith('/lifecycle/ready')),updateErrors:errors});
   await run.context.close();
  }
 }finally{await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));}
 console.log(JSON.stringify({sessions:report.sessions.length,screens:report.screens.length,out}));
}
main().catch(error=>{report.failures.push(error.stack);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
