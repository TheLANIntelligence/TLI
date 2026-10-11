/* Normal-camera handoff QA with synthetic invitation and intercepted LAN page.
 * No live TLI, credentials, physical phone or network request is used. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build_work','companion-pair-link','browser-'+new Date().toISOString().replace(/[:.]/g,'-'));
const router=fs.readFileSync(path.join(root,'backend/routers/companion_routes.py'),'utf8');
const html=router.match(/return HTMLResponse\('''([\s\S]*?)''', headers=/)?.[1];
assert.ok(html,'Fixed production landing HTML must be present');
const policy="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const files={'/api/companion/v1/pair.js':'js/companion-pair-link.js','/themes.css':'themes.css','/native-companion.css':'native-companion.css','/companion-pair-link.css':'companion-pair-link.css'};
const sources=Object.fromEntries(Object.entries(files).map(([url,file])=>[url,fs.readFileSync(path.join(root,'frontend',file),'utf8')]));
const origin='https://192.168.1.2:8000',landing=origin+'/api/companion/v1/pair';
const token='synthetic_only_never_issued_'+'x'.repeat(20);
const fields=new URLSearchParams({v:'1',c:'A'.repeat(256),t:token,e:String(Math.floor(Date.now()/1000)+300),i:'synthetic-node',n:'Studio TLI'});
const report={synthetic_only:true,checks:[],requests:[],screenshots:[],errors:[],sourceHashes:Object.fromEntries(Object.entries(sources).map(([url,value])=>[url,crypto.createHash('sha256').update(value).digest('hex')])),limitations:['Camera detection, Android certificate-warning UI and installed native app dispatch require a physical phone. Edge verifies the production landing script and requested custom-scheme navigation only.','Every invitation and request here is synthetic; no pairing is created or redeemed.']};
async function check(name,work){await work();report.checks.push(name);}
(async()=>{
  fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    for(const width of [390,320]){
      const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
      page.on('pageerror',()=>report.errors.push('JavaScript error in synthetic landing'));
      await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        assert.equal(url.origin,origin);assert.equal(url.search,'');assert.equal(url.hash,'');assert.equal(request.method(),'GET');
        assert.equal(request.headers().referer,undefined,'Landing must send no referrer');
        report.requests.push({width,method:request.method(),path:url.pathname});
        if(url.pathname==='/api/companion/v1/pair')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':policy,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'},body:html});
        if(sources[url.pathname])return route.fulfill({contentType:url.pathname.endsWith('.js')?'application/javascript':'text/css',body:sources[url.pathname]});
        throw Error('Unexpected synthetic request path');
      });
      const cdp=await context.newCDPSession(page);await cdp.send('Page.enable');
      const openers=[];cdp.on('Page.frameRequestedNavigation',event=>{if(/^tli-companion(?:-beta)?:/.test(event.url))openers.push(event.url);});
      await page.goto(landing+'#'+fields);
      await page.locator('#pair-open-beta:enabled').waitFor();
      await check(width+' history scrub and no automatic native open',async()=>{assert.equal(page.url(),landing);assert.equal(openers.length,0);assert.equal(await page.locator('#pair-link-host').textContent(),'Studio TLI · '+origin);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);});
      await check(width+' fits viewport and native-review disclosure is visible',async()=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.match(await page.locator('#pair-link-status').textContent(),/Nothing has been paired/);assert.match(await page.locator('#pair-link-fallback').textContent(),/Scan pairing code/);});
      const file=path.join(out,'camera-landing-'+width+'.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);
      await page.locator('#pair-open-beta').click();
      await check(width+' explicit Beta opener requests only the bounded existing scheme',async()=>{
        await page.waitForTimeout(80);assert.equal(openers.length,1);const url=new URL(openers[0]);assert.equal(url.protocol,'tli-companion-beta:');assert.equal(url.pathname,'/pair');assert.equal(url.search,'');
        const payload=new URLSearchParams(url.hash.slice(1));assert.equal(payload.get('o'),origin);assert.equal(payload.get('t'),token);assert.equal(payload.get('c'),fields.get('c'));assert.equal(page.url(),landing);
      });
      await page.goto(landing+'#'+fields+'&t=duplicate');await page.locator('#pair-link-status').filter({hasText:'invalid'}).waitFor();
      await check(width+' duplicate invitation is refused without opener or persistence',async()=>{assert.equal(await page.locator('#pair-open-beta').isDisabled(),true);assert.equal(await page.locator('#pair-open-app').isDisabled(),true);assert.equal(page.url(),landing);assert.equal(openers.length,1);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);});
      await context.close();
    }
    assert.deepEqual(report.errors,[]);report.status='passed';
  }catch(error){report.status='failed';report.failure=error.message;process.exitCode=1;}
  finally{await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output:out,status:report.status,checks:report.checks.length,errors:report.errors.length,failure:report.failure}));}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
