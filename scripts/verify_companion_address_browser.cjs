/* Isolated address-choice checks for the real Phone Companion controller. No live host. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1]};
const root=path.resolve(__dirname,'..'),source=path.resolve(arg('--source')||root),before=process.argv.includes('--before');
const output=path.join(root,'build_work','companion-address',(before?'before-':'browser-')+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const assets=['style.css','themes.css','ui-foundation.css','native-companion.css','js/native-companion.js','assets/companion-install.svg'];
const sources=Object.fromEntries(assets.map(file=>[file,fs.readFileSync(path.join(source,'frontend',file),'utf8')]));
const hashes=()=>Object.fromEntries(assets.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(source,'frontend',file))).digest('hex')]));
const APIPA='https://169.254.10.20:8000',WSL='https://172.30.128.1:8000',LAN='https://192.168.50.12:8000',BROWSER='https://companion.test';
const report={source,output,before,synthetic:true,hashesAtStart:hashes(),checks:[],screenshots:[],sessions:[],failures:[],limitations:['The real Phone Companion browser controller is loaded with existing shared styles and intercepted synthetic endpoints. No live host, native application, real invitation, phone Wi-Fi reachability or certificate trust was exercised.','Desktop and390/320-pixel browser layouts in Emerald Light and Midnight are checked. This is not physical-phone or screen-reader acceptance.']};
function fixtureBundle(origin){const expires_at=new Date(Date.now()+300000).toISOString();return{bundle:JSON.stringify({version:1,origin,token:'synthetic-only-token',certificate_der:'synthetic-certificate',node_id:'synthetic-studio',node_name:'Studio fixture',expires_at}),expires_at,qr:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="M8 8h40v40H8z M80 8h40v40H80z M8 80h40v40H8z M64 64h24v24H64z M96 96h24v24H96z" fill="black"/></svg>').toString('base64')}}
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
async function setup(browser,width,theme){
 const context=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce'}),page=await context.newPage();
 const calls=[],errors=[],pairObserved=deferred();let origins=[APIPA,WSL,LAN],setupCalls=0,pairHold=null;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==BROWSER){errors.push('Blocked unexpected origin '+url.origin);return route.abort();}
  const file=assets.find(file=>'/'+file===url.pathname);
  if(file)return route.fulfill({contentType:file.endsWith('.svg')?'image/svg+xml':file.endsWith('.css')?'text/css':'application/javascript',body:sources[file]});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"},body:'<!doctype html><html lang="en" data-theme="'+theme+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'+assets.filter(file=>file.endsWith('.css')).map(file=>'<link rel="stylesheet" href="/'+file+'">').join('')+'</head><body data-tli-ui="anniversary" style="padding:16px;margin:0;min-width:0"><main id="panel-companion"></main><script src="/js/native-companion.js"></script></body></html>'});
  calls.push({method:request.method(),path:url.pathname,body:request.method()==='POST'?request.postDataJSON():null});
  if(url.pathname.endsWith('/setup')){setupCalls++;return json(route,{tls_enabled:true,lan_enabled:true,pin_enabled:true,certificate_ready:true,pairing_ready:true,origins:[...origins],node:{id:'synthetic-studio',name:'Studio fixture'}});}
  if(url.pathname.endsWith('/startup'))return json(route,{ok:true,configured:true,saved:{host:'0.0.0.0',port:8000,https:true},running:{host:'0.0.0.0',port:8000,https:true},effective_next:{host:'0.0.0.0',port:8000,https:true},restart_required:false,environment_overrides:[]});
  if(url.pathname.endsWith('/paired-devices'))return json(route,{devices:[]});
  if(url.pathname.endsWith('/pairings')&&request.method()==='POST'){pairObserved.resolve();const origin=request.postDataJSON().origin;assert.ok(origins.includes(origin));if(pairHold)await pairHold;return json(route,fixtureBundle(origin));}
  errors.push('Blocked unapproved request '+request.method()+' '+url.pathname);return json(route,{detail:'Unexpected synthetic request'},409);
 });
 await page.goto(BROWSER+'/');await page.evaluate(()=>TLICompanion.open({step:'pair'}));await page.waitForFunction(()=>!document.getElementById('native-companion-refresh').disabled);
 await page.locator('#native-companion-installed').click();await page.locator('#native-companion-address-details > summary').click();
 return{page,context,calls,errors,received:pairObserved.promise,get setupCalls(){return setupCalls},set origins(value){origins=value},set pairHold(value){pairHold=value},get posts(){return calls.filter(c=>c.method==='POST')}};
}
async function shot(page,name){await page.locator('#native-companion-step-pair').screenshot({path:path.join(output,name+'.png')});report.screenshots.push(name+'.png');}
async function checkLayout(page,width){const result=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('#panel-companion input,#panel-companion select,#panel-companion textarea,#panel-companion button')].filter(el=>el.getClientRects().length&&!el.closest('[hidden]')).map(el=>({id:el.id,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right})).filter(r=>r.left<0||r.right>innerWidth+1)}));assert.ok(result.documentWidth<=width+1);assert.deepEqual(result.overflow,[]);return result;}
async function refresh(page){await page.evaluate(()=>TLICompanion.refresh());await page.waitForFunction(()=>!document.getElementById('native-companion-refresh').disabled);}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
async function exercise(browser,width,theme){const f=await setup(browser,width,theme),{page}=f;
 const select=page.locator('#native-companion-origin'),generate=page.locator('#native-companion-generate'),pairing=page.locator('.native-companion-pairing');
 assert.equal(f.posts.length,0);
 if(before){await shot(page,`before-address-${width}-${theme}`);report.checks.push({width,theme,observedDefault:await select.inputValue(),generateDisabled:await generate.isDisabled(),posts:0});await f.context.close();return;}
 assert.equal(await select.inputValue(),'');assert.equal(await generate.isDisabled(),true);assert.equal(await select.isEnabled(),true);
 await generate.evaluate(button=>{button.dispatchEvent(new Event('click'));button.dispatchEvent(new Event('click'));});await page.evaluate(()=>Promise.resolve());assert.equal(f.posts.length,0);
 await shot(page,`choose-address-${width}-${theme}`);report.checks.push({width,theme,case:'Multiple addresses require an explicit choice; forced disabled-button clicks create no invitation',layout:await checkLayout(page,width)});
 await select.selectOption(LAN);assert.equal(await generate.isEnabled(),true);assert.equal(f.posts.length,0);
 const previous=f.setupCalls;f.origins=[LAN,WSL,APIPA];await refresh(page);assert.equal(f.setupCalls,previous+1);assert.equal(await select.inputValue(),LAN);assert.equal(f.posts.length,0);
 report.checks.push({width,theme,case:'Selected LAN address persists through a reordered refresh without a pairing POST'});
 const hold=deferred();f.pairHold=hold.promise;const request=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/pairings'));
 await generate.evaluate(button=>{button.dispatchEvent(new Event('click'));button.dispatchEvent(new Event('click'));});await request;await f.received;
 assert.equal(f.posts.length,1);assert.deepEqual(f.posts[0].body,{origin:LAN});assert.equal(await select.isDisabled(),true);
 await select.evaluate((control,origin)=>{control.value=origin;control.dispatchEvent(new Event('change'));},WSL);assert.equal(await select.inputValue(),LAN);assert.equal(f.posts.length,1);
 hold.resolve();f.pairHold=null;
 await pairing.waitFor({state:'visible'});assert.equal(JSON.parse(await page.locator('#native-companion-bundle').inputValue()).origin,LAN);assert.match(await pairing.innerText(),new RegExp(LAN.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 await shot(page,`selected-lan-qr-${width}-${theme}`);report.checks.push({width,theme,case:'One explicit pairing POST despite forced duplicate clicks and forced address change during the request; visible origin and bundle match selected LAN address',layout:await checkLayout(page,width)});
 await select.selectOption(WSL);assert.equal(await pairing.isVisible(),false);assert.equal(await page.locator('#native-companion-bundle').count(),0);assert.equal(f.posts.length,1);assert.equal(await generate.isEnabled(),true);
 await shot(page,`changed-address-${width}-${theme}`);report.checks.push({width,theme,case:'Changing address removes the old QR, bundle and visible invitation origin; no automatic replacement POST'});
 // A disappearing selected address must not silently choose a different entry from a multi-address list.
 f.origins=[LAN,'https://10.8.0.2:8000'];await refresh(page);assert.equal(await select.inputValue(),'');assert.equal(await generate.isDisabled(),true);
 report.checks.push({width,theme,case:'Removed selection requires a new explicit choice when several addresses remain'});
 // Current browser origin is a useful exact default only when the host actually lists it.
 f.origins=[LAN,BROWSER];await refresh(page);assert.equal(await select.inputValue(),BROWSER);assert.equal(await generate.isEnabled(),true);assert.equal(f.posts.length,1);
 report.checks.push({width,theme,case:'Exact listed browser origin is selected without generating a code'});
 // Explicit user choice survives even while the browser origin is among the alternatives.
 await select.selectOption(LAN);await refresh(page);assert.equal(await select.inputValue(),LAN);assert.equal(f.posts.length,1);
 f.origins=[LAN];await refresh(page);assert.equal(await select.inputValue(),LAN);assert.equal(await generate.isEnabled(),true);assert.equal(f.posts.length,1);
 report.checks.push({width,theme,case:'An explicit choice takes precedence on refresh; a single listed address remains usable without automatic pairing'});
 assert.deepEqual(f.errors,[]);report.sessions.push({width,theme,calls:f.calls,errors:f.errors});await f.context.close();console.log(`Address choice ${width} ${theme}`);
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{for(const width of before?[1100,320]:[1100,390,320])for(const theme of before?[width===1100?'emeraldLight':'midnight']:['emeraldLight','midnight'])await exercise(browser,width,theme);}catch(error){report.failures.push(error.stack||String(error));}finally{await browser.close();}
report.hashes=hashes();report.sourceUnchanged=JSON.stringify(report.hashes)===JSON.stringify(report.hashesAtStart);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,checks:report.checks.length,screenshots:report.screenshots.length,failures:report.failures,sourceUnchanged:report.sourceUnchanged}));if(report.failures.length)process.exitCode=1;})();
