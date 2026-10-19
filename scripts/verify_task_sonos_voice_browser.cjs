/* Actual SPA with intercepted synthetic APIs and fake microphone bytes.
 * No server, model, filesystem access, LAN discovery or speaker is contacted.
 * NODE_PATH may point at the bundled Playwright packages used by other checks.
 */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makePage,fingerprintFiles}=require('./verify_anniversary_ui_browser.cjs');
const root=path.resolve(__dirname,'..');
const taskOnly=process.argv.includes('--task-only'),outputArgument=process.argv.indexOf('--output');
const output=outputArgument>=0?path.resolve(process.argv[outputArgument+1]):path.join(root,'build_work/task-agent/browser-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const protocol='tli-sonos-v1',now=()=>new Date().toISOString();
const beam={id:'beam-fixture',uid:'RINCON_BEAM',name:'Living room Beam <fixture>',room:'Living room',model:'Beam',ip:'192.168.4.20',volume_cap:35,revision:1};
const play1={id:'play1-fixture',uid:'RINCON_PLAY1',name:'Theater surround',room:'Theater',model:'PLAY:1',ip:'192.168.4.21',volume_cap:30,revision:1};
const play1Second={id:'play1-second-456def',uid:'RINCON_PLAY1_SECOND',name:'Theater surround',room:'Theater',model:'PLAY:1',ip:'192.168.4.22',volume_cap:30,revision:1};
const amplifier={id:'amp-fixture',uid:'RINCON_AMP',name:'Dining room',room:'Dining room',model:'CONNECT:AMP',ip:'192.168.4.23',volume_cap:25,revision:1};
const playbar={id:'playbar-fixture',uid:'RINCON_PLAYBAR',name:'TV room',room:'TV room',model:'PLAYBAR',ip:'192.168.4.24',volume_cap:35,revision:1};
const speakers=[beam,play1,play1Second,amplifier,playbar];
const groupMembers=[beam,play1,play1Second,amplifier];
function topology(all=true){
 const member=device=>({uid:device.uid,device_id:device.id,name:device.name,room:device.room,model:device.model,
  bonded:[play1,play1Second].includes(device),parent_uid:[play1,play1Second].includes(device)?beam.uid:null,bond_source:[play1,play1Second].includes(device)?'satellite':null});
 return {checked_at:now(),groups:[{coordinator:beam.uid,member_count:4,complete:true,members:groupMembers.map(member)},...(all?[{coordinator:playbar.uid,member_count:1,complete:true,members:[member(playbar)]}]:[])]};
}
const report={synthetic:true,source_before:fingerprintFiles(root),checks:[],screens:[],errors:[],physical_acceptance:'not_run',limitations:['All APIs are intercepted. No work-area files, model, speaker, LAN listener or microphone are used.','Microphone tests exercise UI lifecycle using injected fake MediaRecorder bytes, not transcription accuracy or audible output.']};
async function setup(browser,width,theme){
 const run=await makePage(browser,width,theme),calls=[],fixtureErrors=[];
 let areas=[],devices=[playbar],task=null,runNumber=0,activeKind='',activeRun='',polls=0,reviewNumber=0,review=null,mediaEnabled=false,discoveries=0;
 const candidates=new Map(),executedRequests=new Set();
 let reading={playback:'PAUSED_PLAYBACK',volume:18,muted:false,title:'Synthetic music track'};
 let roomVolumes=[{device_id:beam.id,uid:beam.uid,name:beam.name,volume:18,muted:false,volume_cap:beam.volume_cap},
  {device_id:amplifier.id,uid:amplifier.uid,name:amplifier.name,volume:12,muted:false,volume_cap:amplifier.volume_cap}];
 const volumeControls=()=>{const volume=Math.round(roomVolumes.reduce((sum,row)=>sum+row.volume,0)/roomVolumes.length);
  return {rooms:roomVolumes,group:{volume,max:Math.min(100,volume+Math.min(...roomVolumes.map(row=>row.volume_cap-row.volume)))}};};
 await run.page.addInitScript(()=>{
  window.fixtureMicrophone={requested:0,started:0,stopped:0};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
   window.fixtureMicrophone.requested++;return {getTracks:()=>[{stop:()=>window.fixtureMicrophone.stopped++}]};
  }}});
  window.MediaRecorder=class{
   static isTypeSupported(){return true;}
   constructor(stream,options={}){this.stream=stream;this.mimeType=options.mimeType||'audio/webm';this.state='inactive';}
   start(){this.state='recording';window.fixtureMicrophone.started++;}
   stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['synthetic microphone bytes'],{type:this.mimeType})});this.onstop?.();});}
  };
 });
 await run.page.route('**/api/events/recent*',route=>route.fulfill({json:{events:[]}}));
 await run.page.route(/\/api\/(?:tasks|runs|sonos|voice)(?:\/|$)/,async route=>{
  const request=route.request(),pathname=new URL(request.url()).pathname,method=request.method();
  let body=null;if(request.headers()['content-type']?.includes('application/json'))body=request.postDataJSON();
  calls.push({path:pathname,method,body});
  let value={ok:true};
  try{
   if(pathname==='/api/tasks/areas'&&method==='GET')value={areas};
   else if(pathname==='/api/tasks/areas'&&method==='POST'){
    assert.deepEqual(body.read_roots,['C:\\Synthetic Games']);assert.deepEqual(body.write_roots,['C:\\Synthetic Games\\mods']);
    value={...body,id:'area-fixture',revision:1};areas=[value];
   }else if(pathname==='/api/tasks/game-locations')value={locations:[],hint:'No synthetic game installations.'};
   else if(pathname==='/api/runs'&&method==='POST'){
    assert.ok(body.request_id);activeRun='run-fixture-'+(++runNumber);activeKind=body.kind;polls=0;
    if(activeKind==='agent_task'){
     assert.equal(body.payload.area_id,'area-fixture');assert.equal(body.payload.area_revision,1);
     task={id:'task-fixture',revision:1,status:'running',activity:'reading_files',receipts:[]};
     value={id:activeRun,status:'running',metadata:{agent:task}};
    }else{assert.equal(body.kind,'chat');assert.ok(['How do games load mods?','Explain how mod load order works.'].includes(body.payload.message));value={id:activeRun,status:'completed',result:{reply:'A synthetic response explaining how games load mods.'}};}
   }else if(pathname.startsWith('/api/runs/')&&method==='GET'){
    if(++polls===1)value={id:activeRun,status:'running',metadata:{agent:task}};
    else{
     if(task.revision===1)task={...task,status:'needs_input',activity:'awaiting_review',receipts:[{tool:'workspace_read',outcome:'completed',result:{path:'C:\\Synthetic Games\\mods\\fixture.txt',text:'inert <script>fixture</script>'}}],pending:{id:'approval-fixture',approved:false,disclosure:'Run the exact synthetic checker in the approved work area.',reviewed_command:{argv:['python','-m','pytest'],cwd:'C:\\Synthetic Games\\mods'}}};
     else task={...task,revision:3,status:'completed',activity:'complete',pending:null,reply:'Synthetic task completed and its checks passed.',receipts:[...task.receipts,{tool:'command_run',outcome:'completed',result:{exit_code:0,stdout:'1 passed'}}]};
     value={id:activeRun,status:'completed',result:{task_id:task.id,reply:task.reply||'Review the exact command before continuing.'}};
    }
   }else if(pathname==='/api/tasks/task-fixture'&&method==='GET')value=task;
   else if(pathname==='/api/tasks/task-fixture/approve'){
    assert.equal(body.review_id,'approval-fixture');assert.equal(body.expected_revision,1);task={...task,revision:2,pending:{...task.pending,approved:true}};value=task;
   }else if(pathname==='/api/tasks/task-fixture/resume'){
    assert.equal(body.expected_revision,2);assert.equal(body.follow_up,'Use the reviewed synthetic check.');activeRun='run-fixture-'+(++runNumber);polls=0;task={...task,status:'running',activity:'checking_work'};value={id:activeRun,status:'running',metadata:{agent:task}};
   }else if(pathname==='/api/tasks')value={tasks:task?[{...task,message:'Fix the synthetic mod loading error.'}]:[]};
   else if(pathname==='/api/sonos/now-playing'&&method==='GET')value={devices_count:devices.length,connected_count:devices.length,
    groups:[...(devices.some(device=>device.id===beam.id)?[{device_id:beam.id,uid:beam.uid,name:beam.name,member_names:groupMembers.map(device=>device.name),playback:reading.playback,title:reading.title,artist:'',source:{label:'Synthetic music'}}]:[]),
     {device_id:playbar.id,uid:playbar.uid,name:playbar.name,member_names:[playbar.name],playback:'STOPPED',title:'',artist:'',source:{label:'Sonos'}}],
    checked_at:now(),unavailable_count:0,partial:false};
   else if(pathname==='/api/sonos/devices'&&method==='GET')value={devices,availability:{music:true,clips_runtime:true}};
   else if(pathname.startsWith('/api/sonos/devices/')&&pathname.endsWith('/volume-controls')){
    const id=pathname.split('/').at(-2),device=devices.find(row=>row.id===id);assert.ok(device);
    value={device_id:id,volume_controls:id===beam.id?volumeControls():{rooms:[{device_id:device.id,uid:device.uid,name:device.name,volume:12,muted:false,volume_cap:device.volume_cap}],group:null},checked_at:now()};
   }
   else if(pathname==='/api/sonos/discover'&&method==='POST'){
    discoveries++;value={candidates:speakers.map(device=>{
     const discovery_id=`found-${discoveries}-${device.id}`;candidates.set(discovery_id,device);
     return {discovery_id,name:device.name,room:device.room,model:device.model,already_enrolled:devices.some(row=>row.id===device.id),...(devices.some(row=>row.id===device.id)?{device_id:device.id}:{})};
    }),expires_in_seconds:120,partial:false};
   }
   else if(pathname==='/api/sonos/devices'&&method==='POST'){
    assert.deepEqual(Object.keys(body),['discovery_id'],'Primary enrollment submits only the selected discovery identity');
    const device=candidates.get(body.discovery_id);assert(device,'Choose a current named discovery result');
    if(!devices.some(row=>row.id===device.id))devices.push(device);value={device};
   }else if(pathname==='/api/sonos/devices/beam-fixture/status')value={device:beam,group:{coordinator:beam.uid,members:groupMembers},topology:topology(),reading,volume_controls:volumeControls(),clip_support:{state:'supported'},checked_at:now()};
   else if(pathname==='/api/sonos/devices/beam-fixture/favorites')value={items:[{id:'fav-fixture',name:'Synthetic favorite <untrusted>',queue:true}]};
   else if([`/api/sonos/devices/${beam.id}/review`,`/api/sonos/devices/${amplifier.id}/review`].includes(pathname)){
    const device=pathname.includes(amplifier.id)?amplifier:beam;
    if(body.action==='favorite')assert.deepEqual(body.params,{favorite_id:'fav-fixture',replace_queue:true});
    review={review_id:'review-fixture-'+(++reviewNumber),action:body.action,device,affected:groupMembers,topology:topology(false),effect:'This exact action affects Living room and Dining room. Play now may replace the queue.',params:body.params,expires_at:new Date(Date.now()+120000).toISOString(),actions_performed:false};value=review;
   }else if(pathname==='/api/sonos/execute'){
    assert.equal(body.review_id,review.review_id);assert.ok(body.request_id);assert.ok(!executedRequests.has(body.request_id),'Every explicit command uses a new request identity');executedRequests.add(body.request_id);
    if(['play','favorite'].includes(review.action))reading={...reading,playback:'PLAYING'};
    if(review.action==='pause')reading={...reading,playback:'PAUSED_PLAYBACK'};
    if(review.action==='stop')reading={...reading,playback:'STOPPED'};
    if(review.action==='volume')roomVolumes=roomVolumes.map(row=>row.device_id===review.device.id?{...row,volume:review.params.volume}:row);
    if(review.action==='mute')roomVolumes=roomVolumes.map(row=>row.device_id===review.device.id?{...row,muted:review.params.muted}:row);
    if(review.action==='group_volume'){const delta=review.params.volume-volumeControls().group.volume;roomVolumes=roomVolumes.map(row=>({...row,volume:Math.max(0,Math.min(row.volume_cap,row.volume+delta))}));}
    reading={...reading,volume:roomVolumes[0].volume,muted:roomVolumes[0].muted};
    value={outcome:'accepted',summary:'Synthetic speaker acknowledged the action. Physical playback remains unverified.',observed:reading};
   }else if(pathname==='/api/sonos/receipts')value={receipts:[{checked_at:now(),action:'pause',outcome:'accepted',summary:'Synthetic acknowledged action.'}]};
   else if(pathname==='/api/voice/capabilities')value={host_voice_supported:true,transcription_installed:true,settings:{model_path:'C:\\Models\\faster-whisper-base.en',port:8766,bind_ip:'192.168.4.2'},interfaces:['192.168.4.2'],media_enabled:mediaEnabled,reason:null};
   else if(pathname==='/api/voice/transcribe'){assert.equal(method,'POST');assert.ok(request.headers()['content-type'].startsWith('multipart/form-data'));value={text:calls.filter(c=>c.path===pathname).length===1?'Synthetic transcription to review.':'Explain how mod load order works.'};}
   else if(pathname==='/api/voice/speak'){assert.equal(body.speaker_id,beam.id);assert.ok(body.run_id.startsWith('run-fixture-'));value={outcome:calls.filter(c=>c.path===pathname).length===1?'accepted':'unknown',duration_seconds:1,capture_hold_seconds:11};}
   else if(pathname==='/api/voice/announce'){assert.equal(body.speaker_id,beam.id);assert.equal(body.text,'Dinner is ready.');value={outcome:'accepted',duration_seconds:1,capture_hold_seconds:11};}
   else if(pathname==='/api/voice/media/enable'){mediaEnabled=true;value={enabled:true};}
   else if(pathname==='/api/voice/media/disable'){mediaEnabled=false;value={enabled:false};}
   else if(pathname==='/api/voice/cancel')value={cancelled:true};
   else throw Error('Unexpected fixture request '+method+' '+pathname);
   if(pathname.startsWith('/api/sonos/'))value={ok:true,protocol,...value};
   await route.fulfill({json:value});
  }catch(error){fixtureErrors.push(String(error.stack||error));await route.fulfill({status:500,json:{detail:error.message}});}
 });
 await run.page.goto('https://tli-ui.test/',{waitUntil:'load'});
 await run.page.waitForFunction(()=>window.TLITaskAgent&&window.TLISonos&&window.TLIVoice);
 await run.page.evaluate(()=>switchPanel('panel-main'));
 return {...run,featureCalls:calls,fixtureErrors};
}
async function measure(page,id){return page.evaluate(id=>{
 const box=document.getElementById(id),rect=box.getBoundingClientRect();
 return {pageOverflow:document.documentElement.scrollWidth>innerWidth+1,localOverflow:box.scrollWidth>box.clientWidth+1,left:rect.left,right:rect.right,width:innerWidth};
},id);}
async function screen(page,name){await page.screenshot({path:path.join(output,name)});report.screens.push(name);}
async function taskGeometry(page){return page.evaluate(()=>{
 const task=document.getElementById('task-agent'),composer=document.getElementById('chat-composer-shell'),input=document.getElementById('chat-input');
 const box=task.getBoundingClientRect(),draft=input.getBoundingClientRect(),shell=composer.getBoundingClientRect();
 const visible=element=>element.checkVisibility({visibilityProperty:true})&&!element.closest('[hidden],.hidden');
 const escaped=[...task.querySelectorAll('button,input,select,textarea')].filter(visible).filter(element=>{const r=element.getBoundingClientRect();return r.left<box.left-1||r.right>box.right+1;}).map(element=>element.id||element.textContent.slice(0,40));
 const buttons=[...composer.querySelectorAll('.chat-input-row button')].filter(visible),buttonCollisions=[];
 for(let i=0;i<buttons.length;i++){const a=buttons[i],ar=a.getBoundingClientRect();if(a.scrollWidth>a.clientWidth+1)buttonCollisions.push(a.id+' text overflow');for(const b of buttons.slice(i+1)){const br=b.getBoundingClientRect();if(Math.min(ar.right,br.right)>Math.max(ar.left,br.left)+1&&Math.min(ar.bottom,br.bottom)>Math.max(ar.top,br.top)+1)buttonCollisions.push(a.id+' / '+b.id);}}
 const clipped=[];for(let ancestor=task.parentElement;ancestor;ancestor=ancestor.parentElement){const style=getComputedStyle(ancestor),r=ancestor.getBoundingClientRect();if(['auto','scroll'].includes(style.overflowY))break;if(['hidden','clip'].includes(style.overflowY)&&(box.top<r.top-1||draft.bottom>r.bottom+1))clipped.push(ancestor.id||ancestor.className);}
 return {inComposer:task.parentElement===composer,taskBottom:box.bottom,inputTop:draft.top,composerBottom:shell.bottom,inputBottom:draft.bottom,
  noOverlap:box.bottom<=draft.top+1,inputVisible:input.checkVisibility({visibilityProperty:true}),inputWidth:draft.width,inputHeight:draft.height,escaped,clipped,buttonCollisions,
  pageOverflow:document.documentElement.scrollWidth>innerWidth+1,localOverflow:task.scrollWidth>task.clientWidth+1,experience:document.documentElement.dataset.experience};
});}
function assertTaskGeometry(value){assert.equal(value.inComposer,true);assert.equal(value.noOverlap,true);assert.equal(value.inputVisible,true);assert.ok(value.inputWidth>100&&value.inputHeight>=40);assert.deepEqual(value.escaped,[]);assert.deepEqual(value.clipped,[]);assert.deepEqual(value.buttonCollisions,[]);assert.equal(value.pageOverflow,false);assert.equal(value.localOverflow,false);assert.ok(value.inputBottom<=value.composerBottom);}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});let live;
 try{
  for(const theme of ['emeraldLight','midnight'])for(const width of taskOnly?[1440,390,320]:[1440,390]){
   const run=await setup(browser,width,theme),{page}=run;live=page;
   assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
   assert.ok(run.featureCalls.every(call=>call.method==='GET'&&(call.path==='/api/sonos/now-playing'||call.path.endsWith('/volume-controls'))),'Opening Chat permits only automatic read-only Sonos observations');
   const task=page.locator('#task-agent');
   assert.equal(await page.locator('#task-agent-mode').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#task-agent-body').isVisible(),false);
   assert.equal(await page.locator('#chat-send-btn > span').first().textContent(),'Send');
   await task.scrollIntoViewIfNeeded();const collapsed=await taskGeometry(page);assertTaskGeometry(collapsed);await screen(page,`${theme}-${width}-task-collapsed.png`);
   await page.locator('#chat-input').fill('Keep my existing instructions.');
   const writesBefore=run.featureCalls.filter(call=>call.method!=='GET').length;
   await page.locator('#task-agent-mode').click();
   assert.equal(await page.locator('#task-agent-mode').getAttribute('aria-expanded'),'true');assert.equal(await page.locator('#task-agent-body').isVisible(),true);
   assert.equal(await page.locator('#chat-send-btn > span').first().textContent(),'Start task');
   await task.getByRole('button',{name:'Understand a project Read and explain a folder',exact:true}).click();
   assert.match(await page.locator('#chat-input').inputValue(),/^Keep my existing instructions\.\n\nInspect the files in my approved work area/);
   assert.equal(run.featureCalls.filter(call=>call.method!=='GET').length,writesBefore,'Opening task tools and using an example never submits or grants access');
   const expanded=await taskGeometry(page);assertTaskGeometry(expanded);await page.locator('#task-agent-mode').scrollIntoViewIfNeeded();await screen(page,`${theme}-${width}-task-expanded.png`);
   await page.locator('#chat-send-btn').evaluate(element=>element.scrollIntoView({block:'center'}));
   const sendReachable=await page.locator('#chat-send-btn').evaluate(element=>{const r=element.getBoundingClientRect(),nav=document.getElementById('tli-bottom-nav'),navTop=nav.checkVisibility()?nav.getBoundingClientRect().top:innerHeight;return r.bottom<=navTop&&r.top>=0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('#chat-send-btn')===element;});
   assert.equal(sendReachable,true,'Task composer Send remains reachable above fixed phone navigation');
   await screen(page,`${theme}-${width}-task-composer.png`);
   await page.locator('#task-agent-mode').click();assert.equal(await page.locator('#chat-send-btn > span').first().textContent(),'Send');
   assert.match(await page.locator('#chat-input').inputValue(),/^Keep my existing instructions\./);assert.equal(run.featureCalls.filter(call=>call.method!=='GET').length,writesBefore);
   await page.locator('#task-agent-mode').click();
   await task.getByText('Approve a work area',{exact:true}).click();
   await task.getByLabel('Name',{exact:true}).fill('Synthetic mod folder');
   await task.getByLabel('Folders TLI may read · absolute paths, one per line',{exact:true}).fill('C:\\Synthetic Games');
   await task.getByLabel('Folders TLI may edit · optional, one per line',{exact:true}).fill('C:\\Synthetic Games\\mods');
   await task.getByRole('button',{name:'Approve these folders',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('task-agent-area').value==='area-fixture');
   await page.locator('#chat-input').fill('Fix the synthetic mod loading error.');
   assert.equal(await page.getByRole('button',{name:'Start task',exact:true}).count(),1);
   await page.locator('#chat-send-btn').click();
   await task.getByRole('heading',{name:'Task · running · reading files',exact:true}).waitFor();
   await task.getByRole('button',{name:'Approve for this task',exact:true}).waitFor();
   assert.equal(run.featureCalls.filter(c=>c.path.endsWith('/resume')).length,0);
   await task.locator('.task-agent-review').scrollIntoViewIfNeeded();
   const taskLayout=await measure(page,'task-agent');assert.equal(taskLayout.pageOverflow,false);assert.equal(taskLayout.localOverflow,false);
   await screen(page,`${theme}-${width}-task-review.png`);
   await task.getByRole('button',{name:'Approve for this task',exact:true}).click();
   await task.getByLabel('Answer or further instructions (optional)',{exact:true}).fill('Use the reviewed synthetic check.');
   await task.getByRole('button',{name:'Continue task',exact:true}).click();
   await task.getByRole('heading',{name:'Task · completed · complete',exact:true}).waitFor();
   assert.equal(await task.locator('.task-agent-notice').textContent(),'Synthetic task completed and its checks passed.');
   await page.locator('#task-agent-mode').click();
   if(taskOnly){
    assert.equal(await page.locator('#task-agent-mode').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#chat-send-btn > span').first().textContent(),'Send');
    assert.deepEqual(run.fixtureErrors,[]);assert.deepEqual(run.errors,[]);
    report.checks.push({theme,width,task:taskLayout,collapsed,expanded,draftOnlyExamples:true,taskSendLabel:true,reviewAndExplicitContinue:true,passed:true});
    fs.writeFileSync(path.join(output,`${theme}-${width}-requests.json`),JSON.stringify(run.featureCalls,null,2));await run.context.close();live=null;continue;
   }
   await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/sonos/devices'),page.evaluate(()=>switchPanel('panel-homeauto'))]);
   const sonos=page.locator('#sonos-box'),sonosOpeningCalls=run.featureCalls.filter(c=>c.path.startsWith('/api/sonos/')&&c.path!=='/api/sonos/now-playing'&&!c.path.endsWith('/volume-controls'));
   assert.ok(sonosOpeningCalls.length>0,'Opening Smart home loads the saved room directory');
   assert.ok(sonosOpeningCalls.every(c=>c.method==='GET'&&c.path==='/api/sonos/devices'),'Opening Smart home must not discover, contact or operate speakers');
   assert.equal(await sonos.evaluate(element=>element.tagName),'SECTION');
   const homeAssistant=await page.evaluate(()=>{const optional=document.getElementById('home-assistant-mount').closest('details'),sonos=document.getElementById('sonos-box');return{collapsed:!optional.open,afterSonos:!!(sonos.compareDocumentPosition(optional)&Node.DOCUMENT_POSITION_FOLLOWING),samePanel:optional.closest('#panel-homeauto')===sonos.closest('#panel-homeauto')};});
   assert.deepEqual(homeAssistant,{collapsed:true,afterSonos:true,samePanel:true},'Home Assistant remains optional and collapsed below Sonos');
   assert.equal(run.calls.filter(call=>call.path.startsWith('/api/integrations/home-assistant/')).length,0);
   assert.equal(await page.locator('#sonos-advanced,#sonos-ip,#sonos-name,#sonos-room,#sonos-cap,#sonos-box details,#sonos-box summary').count(),0,'The simple player has no advanced or address controls');
   assert.equal(await page.locator('#sonos-player').isVisible(),false);
   assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);
   await page.getByRole('button',{name:'Find speakers',exact:true}).focus();await page.keyboard.press('Enter');
   const found=page.locator('#sonos-found');await found.getByRole('button',{name:'Add to TLI',exact:true}).nth(3).waitFor();
   assert.equal(await found.locator('article').count(),5);assert.equal(await found.locator('article').filter({hasText:'Theater surround'}).count(),2,'Same-name/model speakers remain separate discovery choices');
   assert.equal(await found.getByRole('button',{name:'Reconnect speaker',exact:true}).count(),1,'Previously saved Playbar can reconnect without creating a duplicate');
   assert.ok((await found.textContent()).includes(beam.name));assert.ok((await found.textContent()).includes(play1.name));
   assert.ok((await found.textContent()).includes(beam.model));assert.ok((await found.textContent()).includes(play1.model));
   assert.equal(await found.locator('script,img,fixture').count(),0,'Discovered names must be rendered as text');
   assert.equal((await found.textContent()).includes('192.168.'),false,'Discovery cards identify rooms and models rather than addresses');
   assert.equal(run.featureCalls.filter(c=>c.path==='/api/sonos/devices'&&c.method==='POST').length,0,'Finding speakers is not enrollment');
   await found.locator('article').first().scrollIntoViewIfNeeded();const discoveryLayout=await measure(page,'sonos-box');assert.equal(discoveryLayout.pageOverflow,false);assert.equal(discoveryLayout.localOverflow,false);
   await screen(page,`${theme}-${width}-sonos-discovery.png`);
   await found.locator('article').nth(2).scrollIntoViewIfNeeded();await screen(page,`${theme}-${width}-sonos-discovery-duplicate-rooms.png`);
   for(const [index,device] of [beam,play1,play1Second,amplifier].entries()){
    await found.locator(`[data-discovery-id="found-1-${device.id}"]`).click();
    await page.waitForFunction(count=>document.getElementById('sonos-device').options.length===count,index+3);
   }
   const enrollments=run.featureCalls.filter(c=>c.path==='/api/sonos/devices'&&c.method==='POST');
   assert.deepEqual(enrollments.map(c=>c.body.discovery_id),[beam,play1,play1Second,amplifier].map(device=>'found-1-'+device.id));
   await page.getByRole('button',{name:'Find speakers',exact:true}).click();
   await found.getByRole('button',{name:'Reconnect speaker',exact:true}).nth(4).waitFor();
   await found.locator(`[data-discovery-id="found-2-${playbar.id}"]`).click();
   await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled);
   assert.equal(run.featureCalls.filter(c=>c.path==='/api/sonos/devices'&&c.method==='POST').at(-1).body.discovery_id,'found-2-'+playbar.id);
   assert.equal(await page.locator('#sonos-device option').count(),6,'Reconnection updates one enrollment without duplicating it');
   await page.locator('#sonos-discovery-close').focus();await page.keyboard.press('Enter');assert.equal(await found.isVisible(),false,'Done closes the discovery picker');
   await page.locator('#sonos-device').selectOption(beam.id);assert.equal(await found.locator('article').count(),0,'Changing room clears discovery results');
   assert.equal(await page.locator('#sonos-topology').getAttribute('data-state'),'unknown','Selecting a saved room never invents current group membership');
   await page.getByRole('button',{name:'Refresh status',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('sonos-status').textContent.includes('Synthetic music track'));
   const groupView=page.locator('#sonos-topology'),groupContent=page.locator('#sonos-topology-content');
   assert.equal(await groupView.getAttribute('data-state'),'current');assert.equal(await groupView.isVisible(),true);
   const groupText=await groupContent.textContent();for(const device of speakers){assert.ok(groupText.includes(device.name));assert.ok(groupText.includes(device.model));}
   assert.equal(groupText.includes('192.168.'),false,'Group identity is shown through speaker names/models, not raw addresses');
   assert.equal(await groupContent.locator('.sonos-group-card').count(),2,'The separate Playbar is not merged by its saved enrollment');
   const selectedGroup=groupContent.locator(`[data-coordinator="${beam.uid}"]`),separateGroup=groupContent.locator(`[data-coordinator="${playbar.uid}"]`);
   assert.equal(await selectedGroup.getAttribute('data-selected'),'true');assert.equal(await separateGroup.getAttribute('data-selected'),'false');
   assert.equal(await selectedGroup.locator(`li[data-uid="${beam.uid}"]`).getAttribute('aria-current'),'true');
   const nestedUids=await selectedGroup.locator(`li[data-uid="${beam.uid}"] > ul > li`).evaluateAll(elements=>elements.map(element=>element.dataset.uid));
   assert.deepEqual(nestedUids,[play1.uid,play1Second.uid],'Only explicitly reported satellite parent relationships become nested speakers');
   assert.equal(await selectedGroup.locator(`li[data-uid="${amplifier.uid}"]`).evaluate(element=>element.parentElement.closest('li')?.dataset.uid||null),null,'Grouped Connect:Amp remains a separate room member');
   assert.equal(await separateGroup.locator('li').count(),1);
   assert.equal(await page.locator('#sonos-scope').isVisible(),true);assert.ok((await page.locator('#sonos-scope').textContent()).trim());
   const topologyLayout=await measure(page,'sonos-topology');assert.equal(topologyLayout.localOverflow,false);assert.equal(topologyLayout.pageOverflow,false);
   await groupView.scrollIntoViewIfNeeded();await screen(page,`${theme}-${width}-sonos-groups.png`);
   await separateGroup.scrollIntoViewIfNeeded();await screen(page,`${theme}-${width}-sonos-separate-group.png`);
   assert.equal(await page.locator('#sonos-player').isVisible(),true);
   for(const id of ['sonos-favorite','sonos-destination','sonos-receipts','sonos-confirmation'])assert.equal(await page.locator('#'+id).isVisible(),false,`${id} stays hidden until requested`);
   const roomVolumesView=page.locator('#sonos-room-volumes');assert.equal(await roomVolumesView.isVisible(),true);
   assert.deepEqual(await roomVolumesView.locator('[data-volume-device]').evaluateAll(rows=>rows.map(row=>row.dataset.volumeDevice)),[beam.id,amplifier.id],'Room sliders exclude bonded satellites and separate groups');
   assert.equal(await page.locator('#sonos-single-volume').isVisible(),false,'Room controls replace the selected-speaker fallback');
   for(const [device,value,cap] of [[beam,18,35],[amplifier,12,25]]){
    const slider=page.locator('#sonos-volume-'+device.id);assert.equal(await slider.getAttribute('type'),'range');assert.equal(await slider.inputValue(),String(value));assert.equal(await slider.getAttribute('max'),String(cap));
    assert.equal(await slider.evaluate(element=>element.labels.length>0||!!element.getAttribute('aria-label')),true,'Every room volume slider has an accessible label');
    assert.equal(await roomVolumesView.getByRole('button',{name:'Mute '+device.name,exact:true}).getAttribute('aria-pressed'),'false');
   }
   assert.equal(await page.locator('#sonos-group-volume').inputValue(),'15');assert.equal(await page.locator('#sonos-group-volume').getAttribute('max'),'28');
   const roomVolumesLayout=await measure(page,'sonos-room-volumes');assert.equal(roomVolumesLayout.pageOverflow,false);assert.equal(roomVolumesLayout.localOverflow,false);
   await roomVolumesView.scrollIntoViewIfNeeded();await screen(page,`${theme}-${width}-sonos-room-volumes.png`);
   for(const name of ['Play','Pause','Previous','Next','Stop'])assert.equal(await sonos.getByRole('button',{name,exact:true}).evaluate(element=>element.tagName),'BUTTON');
   await sonos.locator('.sonos-transport').scrollIntoViewIfNeeded();const playerLayout=await measure(page,'sonos-box');assert.equal(playerLayout.pageOverflow,false);assert.equal(playerLayout.localOverflow,false);
   await screen(page,`${theme}-${width}-sonos-player.png`);
   const executions=()=>run.featureCalls.filter(c=>c.path==='/api/sonos/execute');
   const reviews=()=>run.featureCalls.filter(c=>c.path.endsWith('/review')&&c.path.startsWith('/api/sonos/'));
   await sonos.getByRole('button',{name:'Play',exact:true}).click();
   await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled&&document.getElementById('sonos-message').textContent.includes('acknowledged the action'));
   assert.equal(executions().length,1,'One Play click submits playback without Confirm');
   assert.equal(reviews().at(-1).body.action,'play');assert.equal(executions().at(-1).body.review_id,'review-fixture-1');
   assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);
   assert.equal(await page.locator('#sonos-status .sonos-playback').textContent(),'Playing');
   const reviewedGroupText=await groupContent.textContent();for(const device of groupMembers)assert.ok(reviewedGroupText.includes(device.name));
   await sonos.getByRole('button',{name:'Pause',exact:true}).focus();await page.keyboard.press('Space');
   await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled&&document.getElementById('sonos-status').textContent.includes('Paused'));
   assert.equal(executions().length,2,'Keyboard Pause submits exactly once without Confirm');assert.equal(reviews().at(-1).body.action,'pause');
   assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);
   assert.equal(await page.locator('#sonos-status .sonos-playback').textContent(),'Paused','The follow-up observation uses the readable playback state');
   assert.equal(await groupView.getAttribute('data-state'),'stale','Playback acknowledgement does not claim group membership was rechecked');
   assert.equal(await groupContent.textContent(),reviewedGroupText,'The last observed group stays visible after a command');
   await groupView.scrollIntoViewIfNeeded();await screen(page,`${theme}-${width}-sonos-groups-after-pause.png`);
   await page.locator('#sonos-group-refresh').click();await page.waitForFunction(()=>document.getElementById('sonos-topology').dataset.state==='current');
   assert.ok((await groupContent.textContent()).includes(playbar.name),'Explicit Refresh group restores the full reported groups, including the separate Playbar');
   assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);assert.equal(executions().length,2);
   for(const [label,action,params] of [['Previous','previous',{}],['Next','next',{}],['Stop','stop',{}]]){
    const before=executions().length;await sonos.getByRole('button',{name:label,exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled&&document.getElementById('sonos-message').textContent.includes('acknowledged the action'));
    assert.equal(executions().length,before+1,`${label} submits once without Confirm`);assert.deepEqual(reviews().at(-1).body,{action,params});
    assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);
   }
   const statusReads=()=>run.featureCalls.filter(c=>c.path.endsWith('/status')&&c.path.startsWith('/api/sonos/')).length;
   const beforeRoomVolume=executions().length,beforeVolumeRead=statusReads();
   await page.locator('#sonos-volume-'+amplifier.id).evaluate(element=>{element.value='21';element.dispatchEvent(new Event('input',{bubbles:true}));});
   assert.equal(executions().length,beforeRoomVolume,'Dragging a room slider updates only its displayed value');
   await page.locator('#sonos-volume-'+amplifier.id).dispatchEvent('change');
   await page.waitForFunction(id=>!document.getElementById('sonos-device').disabled&&document.getElementById('sonos-volume-'+id).value==='21',amplifier.id);
   assert.equal(executions().length,beforeRoomVolume+1);assert.equal(reviews().at(-1).path,`/api/sonos/devices/${amplifier.id}/review`);
   assert.deepEqual(reviews().at(-1).body,{action:'volume',params:{volume:21}});assert.equal(statusReads(),beforeVolumeRead+1,'Volume confirmation refreshes the whole group with one read');
   assert.equal(await page.locator('#sonos-volume-'+beam.id).inputValue(),'18','Changing Dining room leaves Living room volume unchanged');
   for(const [label,muted] of [['Mute ',true],['Unmute ',false]]){
    const before=executions().length;await roomVolumesView.getByRole('button',{name:label+amplifier.name,exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled);
    assert.equal(executions().length,before+1);assert.equal(reviews().at(-1).path,`/api/sonos/devices/${amplifier.id}/review`);
    assert.deepEqual(reviews().at(-1).body,{action:'mute',params:{muted}});
    assert.equal(await roomVolumesView.getByRole('button',{name:(muted?'Unmute ':'Mute ')+amplifier.name,exact:true}).getAttribute('aria-pressed'),String(muted));
    assert.equal(await page.evaluate(()=>document.activeElement.id),'sonos-mute-'+amplifier.id,'The refreshed mute control retains keyboard focus');
   }
   const beforeGroupVolume=executions().length;
   await page.locator('#sonos-group-volume').focus();await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled&&document.getElementById('sonos-group-volume').value==='21');
   assert.equal(executions().length,beforeGroupVolume+1,'Keyboard group-volume change commits once');
   assert.deepEqual(reviews().at(-1).body,{action:'group_volume',params:{volume:21}});
   assert.equal(await page.evaluate(()=>document.activeElement.id),'sonos-group-volume','The refreshed group slider retains keyboard focus');
   await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled&&document.getElementById('sonos-group-volume').value==='22');
   assert.equal(executions().length,beforeGroupVolume+2,'A second keyboard change works without refocusing the replaced slider');
   assert.deepEqual(reviews().at(-1).body,{action:'group_volume',params:{volume:22}});
   assert.equal(await page.evaluate(()=>document.activeElement.id),'sonos-group-volume');
   assert.equal(await page.locator('#sonos-volume-'+beam.id).inputValue(),'20');assert.equal(await page.locator('#sonos-volume-'+amplifier.id).inputValue(),'23');
   assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);
   await roomVolumesView.scrollIntoViewIfNeeded();await screen(page,`${theme}-${width}-sonos-room-volumes-adjusted.png`);
   const commandsBeforeFavorite=executions().length;assert.equal(commandsBeforeFavorite,10);
   assert.equal(run.featureCalls.filter(c=>c.path.endsWith('/favorites')).length,0,'Favorites are loaded only when opened');
   await sonos.getByRole('button',{name:'Favorites',exact:true}).click();await page.waitForFunction(()=>document.getElementById('sonos-favorite').options.length===2);
   await page.locator('#sonos-favorite').selectOption('fav-fixture');await sonos.getByRole('button',{name:'Play favorite',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('sonos-review').textContent.includes('replace the queue'));
   assert.equal(executions().length,commandsBeforeFavorite,'Favorites still require confirmation before replacing the source or queue');
   await page.locator('#sonos-review').scrollIntoViewIfNeeded();
   const sonosLayout=await measure(page,'sonos-box');assert.equal(sonosLayout.pageOverflow,false);assert.equal(sonosLayout.localOverflow,false);
   await screen(page,`${theme}-${width}-sonos-review.png`);
   assert.equal(await groupView.getAttribute('data-state'),'current','A fresh favorite review displays the checked topology separately from playback');
   await page.locator('#sonos-confirmation').getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Enter');
   assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);assert.equal(executions().length,commandsBeforeFavorite,'Cancel never sends the favorite');
   await sonos.getByRole('button',{name:'Play favorite',exact:true}).click();await page.locator('#sonos-run').waitFor({state:'visible'});
   await page.locator('#sonos-volume-'+beam.id).evaluate(element=>{element.value='21';element.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await page.locator('#sonos-confirmation').isVisible(),false,'Moving volume invalidates a pending action');
   assert.equal(executions().length,commandsBeforeFavorite,'Preparing favorites and moving the slider without committing never execute an action');
   await sonos.getByRole('button',{name:'Play favorite',exact:true}).click();await page.locator('#sonos-run').waitFor({state:'visible'});
   await page.locator('#sonos-run').focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>!document.getElementById('sonos-device').disabled&&document.getElementById('sonos-message').textContent.includes('acknowledged the action'));
   assert.equal(executions().length,commandsBeforeFavorite+1,'Confirm submits the selected favorite once');assert.equal(reviews().at(-1).body.action,'favorite');
   assert.equal(await page.locator('#sonos-confirmation').isVisible(),false);
   assert.equal(await page.locator('#sonos-status .sonos-playback').textContent(),'Playing');
   await sonos.getByRole('button',{name:'Favorites',exact:true}).click();assert.equal(await page.locator('#sonos-favorite').isVisible(),false);
   await sonos.getByRole('button',{name:'Group rooms',exact:true}).click();assert.equal(await page.locator('#sonos-destination').isVisible(),true);
   assert.equal(await page.locator('#sonos-join').isDisabled(),true);assert.equal(await page.locator('#sonos-leave').isDisabled(),true,'Bonded sets remain managed through Sonos');
   await sonos.getByRole('button',{name:'Group rooms',exact:true}).click();assert.equal(await page.locator('#sonos-destination').isVisible(),false);
   await sonos.getByRole('button',{name:'Recent activity',exact:true}).click();await page.waitForFunction(()=>document.getElementById('sonos-receipts').textContent.includes('Synthetic acknowledged action.'));
   await sonos.getByRole('button',{name:'Recent activity',exact:true}).click();assert.equal(await page.locator('#sonos-receipts').isVisible(),false);
   assert.equal(await page.locator('#sonos-box script,#sonos-box img,#sonos-box fixture,#sonos-box untrusted').count(),0,'Untrusted names must remain text');
   await page.evaluate(()=>switchPanel('panel-main'));await page.locator('#voice-conversation-open').click();
   await page.waitForFunction(()=>!document.getElementById('voice-conversation-talk').disabled);
   const dialog=page.locator('#voice-conversation-dialog');await page.waitForFunction(()=>document.getElementById('voice-conversation-speaker').options.length===6);
   assert.equal(await page.locator('#voice-conversation-auto').isChecked(),false,'Send on release is an explicit opt-in');
   await page.locator('#voice-conversation-speaker').selectOption(beam.id);
   const chatBefore=run.featureCalls.filter(c=>c.path==='/api/runs'&&c.method==='POST').length;
   await page.locator('#voice-conversation-talk').focus();await page.keyboard.down('Space');
   await page.waitForFunction(()=>document.getElementById('voice-conversation-talk').getAttribute('aria-pressed')==='true');await page.keyboard.up('Space');
   await page.waitForFunction(()=>document.getElementById('voice-conversation-transcript').value==='Synthetic transcription to review.');
   assert.equal(run.featureCalls.filter(c=>c.path==='/api/runs'&&c.method==='POST').length,chatBefore,'Transcription is not automatic submission');
   await page.locator('#voice-conversation-transcript').fill('How do games load mods?');await page.locator('#voice-conversation-send').click();
   await page.waitForFunction(()=>document.getElementById('voice-conversation-status').textContent.includes('acknowledged the audio clip'));
   assert.equal(await page.locator('#voice-conversation-talk').isDisabled(),true,'Sonos output must pause microphone capture');
   assert.equal(await page.locator('#voice-conversation-send').isDisabled(),true);
   await page.locator('#voice-conversation-talk').dispatchEvent('keydown',{key:' ',repeat:false});await page.locator('#voice-conversation-talk').dispatchEvent('keyup',{key:' '});
   assert.equal(await page.evaluate(()=>window.fixtureMicrophone.requested),1,'Even a dispatched keyboard event cannot recapture output');
   await dialog.getByRole('button',{name:'Stop',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('voice-conversation-talk').disabled);
   await page.locator('#voice-conversation-auto').check();
   await page.locator('#voice-conversation-talk').focus();await page.keyboard.down('Space');
   await page.waitForFunction(()=>document.getElementById('voice-conversation-talk').getAttribute('aria-pressed')==='true');await page.keyboard.up('Space');
   await page.waitForFunction(()=>document.getElementById('voice-conversation-status').textContent.includes('did not confirm playback'));
   assert.equal(run.featureCalls.filter(c=>c.path==='/api/runs'&&c.method==='POST').length,chatBefore+2,'The second turn sends on release only after explicit opt-in');
   assert.equal(await page.locator('#voice-conversation-talk').isDisabled(),true,'Unknown Sonos delivery also pauses microphone capture');
   await page.locator('#voice-conversation-talk').dispatchEvent('keydown',{key:' ',repeat:false});await page.locator('#voice-conversation-talk').dispatchEvent('keyup',{key:' '});
   assert.equal(await page.evaluate(()=>window.fixtureMicrophone.requested),2);
   await dialog.getByRole('button',{name:'Stop',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('voice-conversation-talk').disabled);
   await dialog.getByText('Announce a message on Sonos',{exact:true}).click();await page.locator('#voice-conversation-announcement').fill('Dinner is ready.');
   await page.locator('#voice-conversation-announce').click();await page.waitForFunction(()=>document.getElementById('voice-conversation-status').textContent.includes('acknowledged your announcement'));
   assert.equal(await page.locator('#voice-conversation-talk').isDisabled(),true);
   const voiceLayout=await measure(page,'voice-conversation-dialog');assert.equal(voiceLayout.pageOverflow,false);assert.equal(voiceLayout.localOverflow,false);assert.ok(voiceLayout.left>=0&&voiceLayout.right<=width+1);
   await dialog.evaluate(element=>{element.scrollTop=0;});await screen(page,`${theme}-${width}-voice.png`);
   const mic=await page.evaluate(()=>window.fixtureMicrophone);assert.equal(mic.requested,2);assert.equal(mic.started,2);assert.equal(mic.stopped,2);
   await page.evaluate(()=>window.dispatchEvent(new Event('tli-session-locked')));
   assert.equal(await dialog.evaluate(el=>el.open),false);assert.equal(await page.locator('#voice-conversation-transcript').inputValue(),'');assert.equal(await page.locator('#task-agent-mode').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#sonos-status').textContent(),'');
   assert.equal(await groupView.getAttribute('data-state'),'unknown');assert.equal(await groupContent.textContent(),'','Lock clears retained private group names');
   assert.equal(await page.locator('#voice-conversation-auto').isChecked(),false,'Lock clears send-on-release opt-in');
   await page.waitForFunction(()=>document.getElementById('voice-conversation-status').textContent.includes('Voice stopped'));
   assert.ok(run.featureCalls.some(c=>c.path==='/api/voice/cancel'));assert.ok(run.featureCalls.some(c=>c.path==='/api/voice/media/disable'));
   assert.deepEqual(run.fixtureErrors,[]);assert.deepEqual(run.errors,[]);
   report.checks.push({theme,width,task:taskLayout,sonos:sonosLayout,player:playerLayout,topology:topologyLayout,roomVolumes:roomVolumesLayout,persistentGroupAfterCommand:true,groupRefreshExplicit:true,homeAssistant,discovery:discoveryLayout,discoverySpeakers:5,duplicateDiscoveryNames:2,namedSpeakerEnrollments:4,namedReconnect:true,manualAddressControls:false,extrasHiddenByDefault:true,oneClickPlayback:true,keyboardPause:true,immediateTransportVolumeMute:true,individualRoomSliders:true,groupVolumeKeyboard:true,bondedSatellitesExcludedFromSliders:true,favoriteRequiresConfirm:true,keyboardDiscoveryCancelConfirm:true,voice:voiceLayout,fakeMicrophone:mic,reviewedThenOptInTurns:2,captureBlockedDuringAcceptedAndUnknownOutput:true,passed:true});
   fs.writeFileSync(path.join(output,`${theme}-${width}-requests.json`),JSON.stringify(run.featureCalls,null,2));
   await run.context.close();live=null;
  }
  report.passed=true;
 }catch(error){report.passed=false;report.failure=String(error.stack||error);if(live)await screen(live,'failure.png').catch(()=>{});process.exitCode=1;}
 finally{report.source_after=fingerprintFiles(root);report.source_changed=JSON.stringify(report.source_before)!==JSON.stringify(report.source_after);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,screens:report.screens.length,source_changed:report.source_changed,failure:report.failure}));}
})();
