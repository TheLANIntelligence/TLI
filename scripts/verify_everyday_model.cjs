/* Independent behavior checks for real generated synthetic briefs, no TLI data. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const dir=path.resolve(__dirname,'../build_work/everyday-experience/model-trial');
(async()=>{
 const browser=await chromium.launch({headless:true}); const results=[];
 try {
  for(const name of ['counter','calculator']) {
   const project=JSON.parse(fs.readFileSync(path.join(dir,name+'.json'),'utf8'));
   const revision=project.revisions.at(-1),page=await browser.newPage({viewport:{width:640,height:640}}),errors=[];
   await page.route('**/*',route=>route.abort()); page.on('pageerror',error=>errors.push(error.message));
   await page.setContent('<iframe title="App under test" sandbox="allow-scripts" style="width:600px;height:580px;border:0"></iframe>');
   await page.locator('iframe').evaluate((el,r)=>{el.srcdoc='<!doctype html><html><head><style>'+r.files['style.css'].replace(/<\/style/gi,'<\\/style')+'</style></head><body>'+r.preview_html+'<script>'+r.files['app.js'].replace(/<\/script/gi,'<\\/script')+'</script></body></html>';},revision);
   const app=page.frameLocator('iframe'); let failure=null;
   try {
    if(name==='counter') {await app.locator('#add').click();await app.locator('#add').click();assert.equal(await app.locator('#count').innerText(),'2');await app.locator('#reset').click();assert.equal(await app.locator('#count').innerText(),'0');}
    else {await app.locator('#calculate').click();assert.match(await app.locator('#total').innerText(),/115\.00/);await app.locator('#bill').fill('80');await app.locator('#percent').fill('20');await app.locator('#calculate').click();assert.match(await app.locator('#total').innerText(),/96\.00/);}
    assert.deepEqual(errors,[]);
   } catch(error){failure=error.message;}
   const result={name,revision:revision.revision,passed:!failure,failure,errors}; results.push(result); console.log(JSON.stringify(result));
   await page.screenshot({path:path.join(dir,name+'-v'+revision.revision+'.png')}); await page.close();
  }
 } finally {await browser.close();}
 fs.writeFileSync(path.join(dir,'independent-browser-results.json'),JSON.stringify({model:'Qwen2.5-3B-Instruct-Q4_K_M',results},null,2));
 if(results.some(result=>!result.passed))process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
