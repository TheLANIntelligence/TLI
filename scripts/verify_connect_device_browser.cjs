/* Real SPA and local setup surface, synthetic intercepted APIs only. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {makePage,layout}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build_work/connected-computers/continuous-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const everyday=['messages','observe','coordinate'];
const ready=grants=>({state:'connected',online:true,fresh:true,ready_grants:grants,checked_at:new Date().toISOString(),expires_at:new Date(Date.now()+90000).toISOString(),reason:null});
async function main(){
 const browser=await chromium.launch({channel:'msedge',headless:true}),report={synthetic:true,checks:[]};
 try{
  for(const width of [1440,390]){
   const {page,errors}=await makePage(browser,width,'emeraldLight'),posts=[];
   let peers=[{id:'new-peer',name:'Workshop',status:'pending',connection:{state:'discovered'}},{id:'saved-peer',name:'Studio',status:'allowed',trust_state:'verified',reviewed_grants:['messages']},{id:'node-peer',name:'Compute Node',peer_profile:'inference_node',status:'pending'}],requests=[],connectionState=null,holdCheck=null,pinEnabled=true,pinSets=0,pinVerifies=0;
   await page.route('**/mesh/trust/setup',r=>json(r,{ok:true,ready:true,stable_origins:['https://home.local:8443']}));
   await page.route('**/api/companion/v1/setup',r=>json(r,{pin_enabled:pinEnabled,tls_enabled:true,lan_enabled:true,certificate_ready:true,pairing_ready:pinEnabled,origins:['https://home.local:8443']}));
   await page.route('**/system/pin/status',r=>json(r,{enabled:pinEnabled}));
   await page.route('**/system/pin/set',r=>{assert.deepEqual(r.request().postDataJSON(),{pin:'fixture-new-pin'});pinSets++;pinEnabled=true;return json(r,{ok:true});});
   await page.route('**/system/pin/verify',r=>{assert.deepEqual(r.request().postDataJSON(),{pin:'fixture-new-pin'});pinVerifies++;return json(r,{ok:true});});
   await page.route('**/api/lan/peers',r=>json(r,{peers}));
   await page.route('**/mesh/discovery/status',r=>json(r,{enabled:true,reason:'Choose an active interface.',adapters:[{address:'192.168.1.5',subnet:'192.168.1.0/24'},{address:'10.0.0.5',subnet:'10.0.0.0/24'}]}));
   await page.route('**/mesh/discovery/scan',r=>{posts.push({path:'/mesh/discovery/scan',body:r.request().postDataJSON()});return json(r,{scan:{state:'running'}});});
   await page.route('**/mesh/pairing/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname,body=req.postData()?req.postDataJSON():undefined;
    if(req.method()==='POST')posts.push({path:p,body});
    if(p.endsWith('/requests'))return json(route,{ok:true,supported:true,protocols:['tli-computer-pairing-v2'],requests});
    if(p.endsWith('/start')){const peer=peers.find(p=>p.id===body.device_id);requests=[{request_id:'fixture-request-'+peer.id,direction:'outgoing',protocol:'tli-computer-pairing-v2',peer:{id:peer.id,name:peer.name,origin:'https://workshop.local:8443',...(peer.peer_profile?{profile:peer.peer_profile}:{})},code:'abcd-ef12-3456',grants:body.grants,review_update:body.review_update,local_confirmed:false,remote_confirmed:false,state:'comparing',expires_at:new Date(Date.now()+300000).toISOString()}];return json(route,{ok:true,request:requests[0]});}
    if(p.endsWith('/confirm')){assert.equal(body.code,'abcd-ef12-3456');requests[0]={...requests[0],local_confirmed:true,remote_confirmed:true,state:'connected'};const peer=peers.find(p=>p.id===requests[0].peer.id);peer.status='allowed';peer.reviewed_grants=[...requests[0].grants];peer.connection=ready(peer.reviewed_grants);return json(route,{ok:true,request:requests[0]});}
    if(p.endsWith('/refresh'))return json(route,{ok:true,request:requests[0]});
    if(p.endsWith('/invitation/import'))return json(route,{protocol:'tli-connection-invitation-v1',device_id:'new-peer',name:'Workshop',peer_profile:'full_host',review_update:true,trust_granted:false});
    if(p.endsWith('/invitation'))return json(route,{protocol:'tli-connection-invitation-v1',invitation:'tli-public-fixture-invitation'});
    return json(route,{detail:'Unexpected synthetic path'},409);
   });
   await page.route('**/mesh/directory/*/connection',async route=>{const id=new URL(route.request().url()).pathname.split('/')[3];posts.push({path:'/mesh/directory/'+id+'/connection',body:route.request().postDataJSON()});if(holdCheck)return holdCheck(route);const peer=peers.find(p=>p.id===id),connection=connectionState||ready(peer.reviewed_grants||['messages']);return json(route,{node_id:id,online:connection.online===true,ready_grants:connection.ready_grants||[],connection});});
   await page.evaluate(()=>TLIConnectDevice.open({kind:'computer'}));
   const guide=page.locator('#tli-connect-device-dialog'),review=guide.locator('#tli-connect-device-review');
   await guide.getByRole('button',{name:'Connect to Workshop',exact:true}).click();
   await review.getByText(/Everyday connection:/).waitFor();
   assert.equal(await review.locator('input:checked').count(),3);assert.equal(posts.length,0);
   assert.equal(await review.getByText('Optional AI compute',{exact:true}).count(),1);
   await review.getByRole('button',{name:'Request connection',exact:true}).click();
   assert.deepEqual(posts[0],{path:'/mesh/pairing/start',body:{device_id:'new-peer',version:2,grants:[...everyday].sort(),review_update:false}});
   await review.locator('#peer-pairing-code-match').check();
   // An unrelated discovery update cannot clear consent or switch the target.
   peers.push({id:'newcomer',name:'Arrived while comparing',status:'pending'});
   await page.evaluate(()=>MeshService.refreshPeers());
   assert.equal(await review.locator('#peer-pairing-code-match').isChecked(),true);
   await guide.getByRole('button',{name:'Connect to Arrived while comparing'}).waitFor();
   assert.equal(await review.getByRole('button',{name:'Codes match — connect'}).isDisabled(),true);
   await review.locator('#peer-pairing-messages').check();await review.getByRole('button',{name:'Codes match — connect'}).click();
   await guide.getByRole('heading',{name:'Connected to Workshop',exact:true}).waitFor();
   assert.equal(await guide.evaluate(e=>e.open),true);assert.equal(await page.locator('#tli-peer-pairing-dialog[open]').count(),0);
   assert.equal(await guide.getByRole('button',{name:'Open messages & files'}).count(),1);
   assert.equal(await guide.getByRole('button',{name:'Choose an AI model'}).count(),0);
   assert.equal(posts.filter(p=>p.path.endsWith('/confirm')).length,1);
   report.checks.push(width+': persistent comparison, Everyday defaults, live discovery, automatic read-only verification');
   requests=[];
   await guide.getByRole('button',{name:'Connect to Studio',exact:true}).click();
   await guide.getByRole('button',{name:'Review or change sharing'}).click();
   await review.getByText('Your saved permission selection is shown below.',{exact:true}).waitFor();
   assert.equal(await review.locator('input:checked').count(),1);
   assert.equal(await review.locator('input').first().isChecked(),true);
   report.checks.push(width+': existing exact permissions preserved');
   requests=[{request_id:'fixture-pending-connection',direction:'outgoing',protocol:'tli-computer-pairing-v2',peer:{id:'saved-peer',name:'Studio',origin:'https://studio.local:8443'},code:'abcd-ef12-3456',grants:['messages'],local_confirmed:true,remote_confirmed:false,state:'waiting',expires_at:new Date(Date.now()+300000).toISOString()}];
   await page.evaluate(()=>TLIConnectDevice.open({kind:'computer',deviceId:'saved-peer',requestId:'fixture-pending-connection'}));
   await review.getByText(/Permissions saved here/).waitFor();
   assert.match(await page.evaluate(()=>TLIConnectDevice.resumeURL('https://localhost:8443/')),/request=fixture-pending-connection/);
   report.checks.push(width+': cached roster cannot replace an explicitly resumed comparison');requests=[];
   await page.evaluate(()=>TLIConnectDevice.open({kind:'node',deviceId:'node-peer'}));
   await review.getByText(/Permission: explicitly selected AI compute only/).waitFor();
   await guide.getByText('Set up an inference Node',{exact:true}).click();
   assert.match(await guide.locator('pre').innerText(),/invitation --state-dir/);
   await guide.getByText('Set up an inference Node',{exact:true}).click();
   await review.getByRole('button',{name:'Request connection',exact:true}).click();
   await review.locator('#peer-pairing-code-match').check();await review.locator('#peer-pairing-messages').check();
   await review.getByRole('button',{name:'Codes match — connect'}).click();
   await guide.getByRole('button',{name:'Choose an AI model'}).waitFor();
   assert.deepEqual(posts.filter(p=>p.path.endsWith('/start')).at(-1).body.grants,['inference']);
   report.checks.push(width+': Node connection in same flow, separate AI capability');
   const measured=await layout(page,'tli-connect-device-dialog');assert.deepEqual(measured.overflow,[]);assert.deepEqual(measured.duplicateIds,[]);
   await page.screenshot({path:path.join(output,'connected-'+width+'.png'),fullPage:true});
   requests=[];await page.evaluate(()=>TLIConnectDevice.open({kind:'computer'}));
   await guide.getByText('Computer not appearing?',{exact:true}).click();
   await guide.locator('#tli-discovery-adapter option[value="10.0.0.5"]').waitFor({state:'attached'});
   assert.equal(await guide.getByRole('button',{name:'Scan this network',exact:true}).isDisabled(),true);
   await guide.locator('#tli-discovery-adapter').selectOption('192.168.1.5');await guide.getByRole('button',{name:'Scan this network',exact:true}).click();
   assert.deepEqual(posts.filter(p=>p.path==='/mesh/discovery/scan').at(-1).body,{adapter:'192.168.1.5'});
   await guide.getByRole('button',{name:'Show this computer’s invitation',exact:true}).click();
   assert.equal(await guide.getByRole('textbox',{name:'This computer’s public invitation'}).inputValue(),'tli-public-fixture-invitation');
   const starts=posts.filter(p=>p.path.endsWith('/start')).length;
   await guide.locator('#tli-connection-invitation-import').fill('tli-public-fixture-invitation');await guide.getByRole('button',{name:'Use invitation',exact:true}).click();
   await review.getByText('Your saved permission selection is shown below.',{exact:true}).waitFor();
   assert.equal(await review.locator('input:checked').count(),3);assert.equal(posts.filter(p=>p.path.endsWith('/start')).length,starts);
   report.checks.push(width+': adapter-selected diagnostic scan and public invitation preserve review boundary');
   // HTTP 200 with checking/backoff must not unlock actions.
   connectionState={state:'checking',online:null,ready_grants:[],fresh:false};peers.find(p=>p.id==='saved-peer').connection=connectionState;
   await page.evaluate(()=>TLIConnectDevice.open({kind:'computer',deviceId:'saved-peer'}));
   await guide.locator('#tli-connect-device-verification').getByRole('heading',{name:'Checking connection',exact:true}).waitFor();
   assert.equal(await guide.getByRole('button',{name:'Open messages & files'}).count(),0);
   report.checks.push(width+': checking is distinct from connected');
   // Late verification cannot replace another computer's review.
   let held;holdCheck=route=>{held=route;};
   await guide.getByRole('button',{name:'Check again'}).click();await page.waitForFunction(()=>true);
   while(!held)await new Promise(resolve=>setTimeout(resolve,10));
   await guide.getByRole('button',{name:'Connect to Arrived while comparing'}).click();
   await json(held,{node_id:'saved-peer',online:true,ready_grants:['messages'],connection:ready(['messages'])}).catch(()=>{});holdCheck=null;
   assert.equal(await guide.getByRole('heading',{name:'Connected to Studio'}).count(),0);
   await page.evaluate(()=>TLIConnectDevice.open({kind:'phone'}));
   assert.equal(await guide.locator('#native-companion-settings').count(),1);
   const phoneLayout=await layout(page,'tli-connect-device-dialog');assert.deepEqual(phoneLayout.overflow,[]);assert.deepEqual(phoneLayout.duplicateIds,[]);
   await guide.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.locator('#panel-companion #native-companion-settings').count(),1);
   pinEnabled=false;await page.evaluate(()=>TLIConnectDevice.open({kind:'computer',deviceId:'newcomer'}));
   await guide.locator('#tli-connection-new-pin').fill('fixture-new-pin');await guide.locator('#tli-connection-confirm-pin').fill('fixture-new-pin');
   const address=page.url(),panel=await page.evaluate(()=>document.querySelector('section.panel-container:not([hidden])')?.id);
   await guide.getByRole('button',{name:'Set PIN & unlock',exact:true}).click();
   await guide.locator('#tli-connection-new-pin').waitFor({state:'detached'});
   assert.equal(pinSets,1);assert.equal(pinVerifies,1);assert.equal(page.url(),address);assert.equal(await guide.evaluate(e=>e.open),true);
   assert.equal(await page.evaluate(()=>document.querySelector('section.panel-container:not([hidden])')?.id),panel);
   assert.equal(await guide.getByRole('button',{name:'Selected Arrived while comparing'}).count(),1);
   assert.equal(await guide.locator('input[type=password]').count(),0);report.checks.push(width+': first PIN setup and established verification stay in the controller without navigation');
   pinEnabled=false;
   await page.route('**/system/pin/set',async route=>{pinSets++;pinEnabled=true;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));return json(route,{ok:true});});
   await guide.getByRole('button',{name:'Refresh readiness',exact:true}).click();await guide.locator('#tli-connection-new-pin').fill('fixture-new-pin');await guide.locator('#tli-connection-confirm-pin').fill('fixture-new-pin');
   await guide.getByRole('button',{name:'Set PIN & unlock',exact:true}).click();await guide.waitFor({state:'hidden'});
   assert.equal(pinSets,2);assert.equal(pinVerifies,1);
   await page.locator('#tli-lock-input').fill('fixture-new-pin');await page.locator('#tli-lock-submit').click();await guide.waitFor({state:'visible'});
   await guide.getByRole('button',{name:'Selected Arrived while comparing'}).waitFor();assert.equal(pinSets,2);assert.equal(pinVerifies,2);assert.equal(page.url(),address);
   report.checks.push(width+': background lock during PIN activation clears secrets and resumes selected device after normal unlock without replay');
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tli-session-locked')));
   assert.equal(await guide.evaluate(e=>e.open),false);assert.equal(await guide.locator('input').count(),0);
   assert.deepEqual(errors,[]);report.checks.push(width+': stale verification, embedded phone continuity and session invalidation');await page.close();
  }
  // Local owner setup fixture: no server, listener, firewall, restart or OS calls.
  const context=await browser.newContext(),page=await context.newPage(),operations=[];let receipt=null;
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;if(url.hostname!=='127.0.0.1')return route.abort();
   if(p==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"></head><body><main id="setup"></main><script src="/js/connection-setup.js"></script></body></html>'});
   if(p==='/js/connection-setup.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,'frontend/js/connection-setup.js'))});
   operations.push({path:p,method:req.method(),body:req.postData()?req.postDataJSON():undefined});
   if(p.endsWith('/preview'))return json(route,{preview_id:'setup-preview-fixture',expires_at:Math.floor(Date.now()/1000)+120,action:req.postDataJSON().action,next_url:'https://localhost:8443',settings:{host:'0.0.0.0',port:8443,https:true},warnings:['Only Private-network access will be reviewed.'],certificate:{fingerprint:'a'.repeat(64),names:['home.local','localhost']},firewall:{program:'C:\\TLI\\python.exe',profile:'Private',remote_addresses:'LocalSubnet',rules:[{protocol:'TCP',port:8443},{protocol:'UDP',port:5353},{protocol:'UDP',port:47474}],migrate_legacy:req.postDataJSON().migrate_legacy||false,legacy_rules:[{name:'old-web-id',display_name:'TLI-Web',direction:'Inbound',action:'Allow',enabled:'True',profile:'Any',protocol:'TCP',local_port:'8000',program:'Any',remote_address:'Any'}]}});
   if(p.endsWith('/confirm')){receipt={schema_version:1,request_id:req.postDataJSON().request_id,status:'completed',message:'Secure startup settings saved.',restart_required:true};return route.abort('connectionreset');}
   if(p.includes('/receipt/'))return json(route,receipt);
   return json(route,{detail:'Unexpected fixture route'},404);
  });
  await page.goto('http://127.0.0.1/');await page.evaluate(()=>TLIConnectionSetup.mount(document.getElementById('setup'),{record:{running:{port:8443},firewall:{supported:true,legacy_rules:['old']}},current:()=>true,api:async(path,body)=>{const response=await fetch(path,{method:body?'POST':'GET',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return response.json();}}));
  await page.getByRole('button',{name:'Review secure network setup'}).click();await page.getByRole('button',{name:'Confirm network setup'}).click();
  await page.getByText(/The request will not be repeated/).waitFor();await page.getByRole('button',{name:'Check saved setup request'}).click();
  await page.getByRole('button',{name:'Review restart & continue'}).waitFor();assert.equal(operations.filter(p=>p.path.endsWith('/confirm')).length,1);assert.equal(operations.filter(p=>p.path.includes('/receipt/')).length,1);
  assert.equal(operations.filter(p=>p.body?.action==='firewall').length,0);
  await page.getByRole('button',{name:'Review Private-network firewall access'}).click();
  await page.getByText('C:\\TLI\\python.exe',{exact:true}).waitFor();await page.getByText('Private',{exact:true}).waitFor();await page.getByText('LocalSubnet',{exact:true}).waitFor();await page.getByText('TCP 8443, UDP 5353, UDP 47474',{exact:true}).waitFor();await page.getByText('home.local, localhost',{exact:true}).waitFor();await page.getByText('HTTPS · 0.0.0.0 · TCP 8443',{exact:true}).waitFor();
  assert.equal(operations.filter(p=>p.path.endsWith('/confirm')).length,1);
  await page.getByText('Review older firewall rules',{exact:true}).click();await page.getByRole('button',{name:'Review migration of older rules'}).click();await page.getByText(/Rule ID: old-web-id; Inbound; Allow; enabled True; profile Any; TCP 8000; program Any; remote Any/).waitFor();
  assert.equal(operations.filter(p=>p.path.endsWith('/confirm')).length,1);report.checks.push('Exact listener, certificate names and firewall program/profile/scope/ports/migration rows shown before confirmation');
  report.checks.push('Local setup: explicit preview/confirm, lost acknowledgement read by receipt, no replay or implicit firewall/restart');await context.close();
 }finally{await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
 console.log(JSON.stringify({output,checks:report.checks.length,passed:true}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
