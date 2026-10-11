/* Optional session-only HA workflow. No connection or action on navigation. */
(() => {
 'use strict';
 const P='tli-home-assistant-v1',BASE='/api/integrations/home-assistant/';
 const state={epoch:0,busy:false,abort:null,connection:null,originReview:null,review:null,rows:[],checkedAt:null,timer:null,reviewTimer:null,originTimer:null};
 const $=id=>document.getElementById(id),make=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const button=(id,text,fn)=>{const n=make('button',text);n.id=id;n.type='button';n.className='btn-outline';n.addEventListener('click',fn);return n;};
 const tell=text=>{if($('ha-status'))$('ha-status').textContent=text;};
 const selected=()=>state.rows.find(row=>row.entity_id===$('ha-entity')?.value);
 function sync(){
  for(const id of ['ha-check','ha-review-connection','ha-connect','ha-disconnect','ha-read','ha-review-on','ha-review-off','ha-run','ha-origin','ha-token','ha-http','ha-filter','ha-entity'])if($(id))$(id).disabled=state.busy;
  if($('ha-connect'))$('ha-connect').disabled=state.busy||!state.originReview||!$('ha-origin-reviewed')?.checked;
  for(const id of ['ha-read','ha-disconnect'])if($(id))$(id).disabled=state.busy||!state.connection;
  for(const id of ['ha-review-on','ha-review-off'])if($(id))$(id).disabled=state.busy||!state.connection||selected()?.can_review_action!==true;
  if($('ha-run'))$('ha-run').disabled=state.busy||!state.review||!$('ha-action-reviewed')?.checked;
 }
 function invalidateAction(message){state.review=null;clearTimeout(state.reviewTimer);state.reviewTimer=null;if($('ha-action-reviewed'))$('ha-action-reviewed').checked=false;if(message)$('ha-action-review')?.replaceChildren(make('p',message));sync();}
 function invalidateOrigin(){state.originReview=null;clearTimeout(state.originTimer);state.originTimer=null;if($('ha-origin-reviewed'))$('ha-origin-reviewed').checked=false;$('ha-origin-review')?.replaceChildren();sync();}
 function clear(message='Home Assistant view cleared. This does not disconnect an existing server-side session or cancel a submitted action.'){
  state.epoch++;state.abort?.abort();state.abort=null;state.busy=false;state.connection=null;state.rows=[];state.checkedAt=null;clearTimeout(state.timer);state.timer=null;invalidateAction();invalidateOrigin();
  for(const id of ['ha-current','ha-state-summary','ha-entity','ha-selected','ha-action-review','ha-result'])$(id)?.replaceChildren();
  for(const id of ['ha-token','ha-filter','ha-origin'])if($(id))$(id).value='';if($('ha-http'))$('ha-http').checked=false;
  tell(message);sync();
 }
 async function api(operation,body){
  const abort=state.abort,timer=setTimeout(()=>abort?.abort(),24000);
  try{
   const r=await fetch(BASE+operation,{method:body?'POST':'GET',cache:'no-store',signal:abort?.signal,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if(r.status===401){clear('The TLI PIN session expired. Home Assistant views were cleared. Unlock before reviewing another connection.');throw new Error('PIN session expired.');}
   let raw='',bytes=0;const reader=r.body?.getReader();
   if(reader){const decoder=new TextDecoder();while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2*1024*1024){await reader.cancel();throw new Error('The bridge response exceeded its supported size.');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}
   else{raw=await r.text();if(new TextEncoder().encode(raw).length>2*1024*1024)throw new Error('The bridge response exceeded its supported size.');}
   let data;try{data=JSON.parse(raw);}catch(_){throw new Error('The Home Assistant bridge returned unreadable data.');}
   if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:'The reviewed Home Assistant request failed.');
   if(data.protocol!==P)throw new Error('This host does not provide the supported Home Assistant bridge.');return data;
  }finally{clearTimeout(timer);}
 }
 async function run(message,fn){
  if(state.busy)return;const epoch=state.epoch;state.busy=true;state.abort=new AbortController();tell(message);sync();
  try{await fn(epoch);}catch(e){if(epoch===state.epoch)tell((e.name==='AbortError'?'This browser stopped waiting. A submitted operation may still finish; no automatic retry runs.':e.message)+(state.rows.length||$('ha-result')?.childNodes.length?' Previous displayed results are retained.':''));}
  finally{if(epoch===state.epoch){state.busy=false;state.abort=null;sync();}}
 }
 function adopt(value){
  const delay=Date.parse(value?.expires_at)-Date.now();if(!/^[a-f0-9]{32}$/.test(value?.id)||typeof value.origin!=='string'||!Array.isArray(value.addresses)||!Number.isFinite(delay)||delay<=0)throw new Error('The host did not confirm a valid temporary connection.');
  if(state.connection?.id!==value.id){state.rows=[];state.checkedAt=null;$('ha-entity').replaceChildren();$('ha-selected').replaceChildren();$('ha-state-summary').replaceChildren();$('ha-result').replaceChildren();invalidateAction();}
  state.connection=value;clearTimeout(state.timer);state.timer=setTimeout(()=>clear('The temporary Home Assistant session expired. No automatic reconnect runs.'),Math.min(delay,900000));
  $('ha-current').replaceChildren(make('strong','Connected origin: '+value.origin),make('p','Reviewed addresses: '+value.addresses.join(', ')),make('p','Session ends: '+value.expires_at),make('p',value.insecure_http?'Transport to Home Assistant is HTTP: the token and states travel unencrypted on that connection.':'Transport to Home Assistant uses verified HTTPS.'));
 }
 function check(){return run('Checking this PIN browser’s temporary Home Assistant connection…',async epoch=>{
  const d=await api('status');if(epoch!==state.epoch)return;if(d.ok!==true||!Array.isArray(d.connections)||d.connections.length>1)throw new Error('Connection status was not confirmed.');
  if(d.connections.length){adopt(d.connections[0]);tell('An existing session is available. Read states or disconnect explicitly; no Home Assistant request ran for this status check.');}
  else clear('No Home Assistant session is connected for this browser. Review an origin before connecting.');
 });}
 function reviewConnection(){return run('Reviewing the Home Assistant origin and its resolved private addresses… No token is sent.',async epoch=>{
  const d=await api('connection-review',{origin:$('ha-origin').value.trim(),allow_insecure_http:$('ha-http').checked});if(epoch!==state.epoch)return;
  if(d.ok!==true||d.credential_sent!==false||d.actions_performed!==false||!/^[a-f0-9]{64}$/.test(d.review_token)||!Array.isArray(d.addresses))throw new Error('The connection review was not confirmed.');
  state.originReview=d;$('ha-origin-reviewed').checked=false;$('ha-origin-review').replaceChildren(make('strong','Review origin: '+d.origin),make('p','Resolved addresses: '+d.addresses.join(', ')),make('p',d.insecure_http?'HTTP sends the token and returned states unencrypted to this exact origin.':'HTTPS verifies the configured hostname and certificate.'),make('p',d.scope));
  clearTimeout(state.originTimer);state.originTimer=setTimeout(()=>{invalidateOrigin();tell('The origin review expired. Review again before submitting a token.');},300000);tell('Review the address and transport, enter the HA token, then connect explicitly.');
 });}
 function connect(){return run('Checking the reviewed Home Assistant REST API… No states or actions are requested.',async epoch=>{
  if(!state.originReview||!$('ha-origin-reviewed').checked)throw new Error('Review the exact origin before submitting its token.');
  const d=await api('connect',{review_token:state.originReview.review_token,token:$('ha-token').value});if(epoch!==state.epoch)return;
  if(d.ok!==true||d.actions_performed!==false||d.states_read!==false)throw new Error('The candidate connection was not confirmed.');
  adopt(d.connection);$('ha-token').value='';invalidateOrigin();tell('Connected for this PIN session, up to 15 minutes. No state list, scene or action ran. Read states explicitly when ready.');
 });}
 function disconnect(){return run('Disconnecting this temporary Home Assistant session…',async epoch=>{
  if(!state.connection)return;const d=await api('disconnect',{connection_id:state.connection.id});if(epoch!==state.epoch)return;
  if(d.ok!==true||d.disconnected!==true)throw new Error('Disconnection was not confirmed.');clear('Disconnected from Home Assistant in TLI. The token still exists in Home Assistant; a submitted action is not cancelled.');
 });}
 function describeSelected(){const row=selected();$('ha-selected').replaceChildren();if(row)$('ha-selected').append(make('strong',row.name),make('p',row.entity_id+' · Home Assistant reported: '+row.state),make('p','Last changed: '+(row.last_changed||'not supplied')+' · Last updated: '+(row.last_updated||'not supplied')));sync();}
 function renderStates(){
  const q=$('ha-filter').value.trim().toLowerCase(),prior=$('ha-entity').value,filtered=state.rows.filter(r=>(r.entity_id+' '+r.name).toLowerCase().includes(q)),shown=filtered.slice(0,50),select=$('ha-entity');select.replaceChildren();
  for(const row of shown){const option=make('option',row.name+' · '+row.entity_id+' · '+row.state);option.value=row.entity_id;select.append(option);}if(shown.some(r=>r.entity_id===prior))select.value=prior;
  $('ha-state-summary').replaceChildren(make('p',`Showing ${shown.length} of ${filtered.length} matching lights/switches (${state.rows.length} total). Filter by exact entity ID or name to narrow large lists.`),make('p','Last explicit read: '+state.checkedAt+'. Reported state is not physical confirmation.'));
  invalidateAction('Select an exact entity and review Turn on or Turn off.');describeSelected();
 }
 function read(){return run('Reading the Home Assistant state list… Only bounded light/switch fields will be displayed.',async epoch=>{
  if(!state.connection)return;const id=state.connection.id,d=await api('states',{connection_id:id});if(epoch!==state.epoch)return;
  if(d.ok!==true||d.actions_performed!==false||d.connection_id!==id||!Array.isArray(d.items)||d.items.length>2000||new Set(d.items.map(r=>r.entity_id)).size!==d.items.length||d.items.some(r=>!/^((light)|(switch))\.[a-z0-9_]{1,120}$/.test(r.entity_id)||typeof r.name!=='string'||typeof r.state!=='string'))throw new Error('The exact Home Assistant state list was not confirmed.');
  state.rows=d.items;state.checkedAt=d.checked_at;renderStates();tell(`${d.items.length} light/switch states read. ${d.omitted_entities} other entities were excluded. No arbitrary attributes, history or private URLs were saved. Nothing was operated.`);
 });}
 function reviewAction(action){return run('Reading the exact entity again for an action review… Nothing is operated.',async epoch=>{
  const row=selected();if(!row||!state.connection)throw new Error('Choose an exact light or switch first.');
  const id=state.connection.id,d=await api('action-review',{connection_id:id,entity_id:row.entity_id,action});if(epoch!==state.epoch)return;
  if(d.ok!==true||d.actions_performed!==false||d.target?.connection_id!==id||d.target?.entity?.entity_id!==row.entity_id||d.target?.action!==action||!/^[a-f0-9]{64}$/.test(d.review_hash)||!/^[a-f0-9]{64}$/.test(d.review_token))throw new Error('The host did not confirm the exact reviewed target and effect.');
  state.review=d;$('ha-action-reviewed').checked=false;$('ha-action-review').replaceChildren(make('strong',(action==='turn_on'?'Turn on: ':'Turn off: ')+d.target.entity.name),make('p','Entity: '+row.entity_id),make('p','Origin: '+d.target.origin+' · addresses: '+d.target.addresses.join(', ')),make('p','Home Assistant reported '+d.target.entity.state+' at review. '+d.scope));
  clearTimeout(state.reviewTimer);state.reviewTimer=setTimeout(()=>invalidateAction('This action review expired. Read and review the exact target again.'),120000);tell('Review the exact entity and effect. Run submits one service action, with a fresh state check first.');
 });}
 function execute(){return run('Checking the reviewed state and submitting at most one Home Assistant action…',async epoch=>{
  if(!state.review||!$('ha-action-reviewed').checked)throw new Error('Review the exact entity and effect first.');
  if(typeof window.crypto?.randomUUID!=='function')throw new Error('This browser cannot create a safe action identifier. Use a current browser on HTTPS or localhost.');
  const reviewed=state.review,id=state.connection.id;
  try{
   const d=await api('execute',{connection_id:id,review_token:reviewed.review_token,review_hash:reviewed.review_hash,request_id:window.crypto.randomUUID(),reviewed:true});if(epoch!==state.epoch)return;
   if(d.connection_id!==id||!['accepted','failed','unknown'].includes(d.outcome)||typeof d.ok!=='boolean'||d.inference_called!==false)throw new Error('The action outcome was not confirmed. Read state before another review.');
   $('ha-result').replaceChildren(make('strong',d.outcome==='accepted'?'Home Assistant acknowledged the action':d.outcome==='unknown'?'Action outcome unconfirmed':'Action did not complete'),make('p',reviewed.target.entity.entity_id+' · '+reviewed.target.action+' · '+reviewed.target.origin),make('p',d.summary),make('p','Recorded: '+d.checked_at));tell(d.summary);
  }finally{if(epoch===state.epoch)invalidateAction('This submission is finished or unconfirmed. Read the entity state and create a new review before another action. No automatic retry runs.');}
 });}
 function init(){
  const mount=$('home-assistant-mount');if(!mount||$('ha-status'))return;const box=make('section');box.className='ha-bridge';mount.append(box);box.append(make('h3','Home Assistant · optional connection'),make('p','Connect your configured Home Assistant for explicit light/switch state reads and individually reviewed On/Off actions. Nothing connects, refreshes or runs automatically. The temporary connection stays separate from TLI’s device registry, scenes and AI.'));
  const status=make('p','No Home Assistant connection has been checked in this view.');status.id='ha-status';status.setAttribute('role','status');box.append(button('ha-check','Check temporary connection',check),status);
  const config=make('details');config.append(make('summary','Connect or replace a temporary session'));box.append(config);
  function field(id,label,type='text',placeholder=''){const wrapper=make('label',label),input=make('input');input.id=id;input.type=type;input.placeholder=placeholder;wrapper.append(input);return wrapper;}
  config.append(field('ha-origin','Home Assistant origin','url','http://192.168.1.20:8123'));$('ha-origin').addEventListener('input',invalidateOrigin);
  const http=make('label'),httpCheck=make('input');httpCheck.type='checkbox';httpCheck.id='ha-http';httpCheck.addEventListener('change',invalidateOrigin);http.append(httpCheck,make('span','If I choose HTTP, I accept that this token and states travel unencrypted to that exact private origin. Verified HTTPS is also supported.'));config.append(http,button('ha-review-connection','Review origin and addresses',reviewConnection));
  const review=make('div');review.id='ha-origin-review';config.append(review);const agreed=make('label'),agreedCheck=make('input');agreedCheck.id='ha-origin-reviewed';agreedCheck.type='checkbox';agreedCheck.addEventListener('change',sync);agreed.append(agreedCheck,make('span','I reviewed the exact Home Assistant origin, resolved addresses and transport.'));config.append(agreed,field('ha-token','Home Assistant long-lived access token','password'));$('ha-token').autocomplete='off';
  config.append(make('p','Create a token in your Home Assistant profile. Temporary access lasts up to 15 minutes; the token stays only in host process memory. Failed replacement retains the existing connection. The token is never copied into the device registry or backups.'),button('ha-connect','Connect reviewed origin',connect));box.append(config);
  const current=make('div');current.id='ha-current';box.append(current,button('ha-disconnect','Disconnect temporary session',disconnect),make('p','Closing this view hides its results and credentials. It does not cancel a submitted action or revoke the original token in Home Assistant. PIN-session revocation, expiry and TLI restart end temporary access.'),button('ha-read','Read lights & switches',read));
  box.append(make('p','Read requests Home Assistant’s state list and displays only light/switch IDs, names, state, unit and timestamps. Other attributes and domains are not retained. No history is requested.'),field('ha-filter','Find a light or switch','search','Name or exact entity ID'));$('ha-filter').addEventListener('input',renderStates);
  const summary=make('div');summary.id='ha-state-summary';const selectLabel=make('label','Exact Home Assistant entity'),select=make('select');select.id='ha-entity';select.size=5;select.addEventListener('change',()=>{invalidateAction('The selection changed. Review this exact entity before running an action.');describeSelected();});selectLabel.append(select);const chosen=make('div');chosen.id='ha-selected';box.append(summary,selectLabel,chosen,button('ha-review-on','Review Turn on',()=>reviewAction('turn_on')),button('ha-review-off','Review Turn off',()=>reviewAction('turn_off')));
  const actionReview=make('div');actionReview.id='ha-action-review';const approval=make('label'),approvalCheck=make('input');approvalCheck.id='ha-action-reviewed';approvalCheck.type='checkbox';approvalCheck.addEventListener('change',sync);approval.append(approvalCheck,make('span','I reviewed the exact origin, entity and On/Off effect.'));const result=make('div');result.id='ha-result';result.setAttribute('role','status');box.append(actionReview,approval,button('ha-run','Run reviewed action',execute),result);mount.append(box);sync();
  window.addEventListener('tli-session-locked',()=>clear('The PIN view locked. Temporary Home Assistant credentials, results and action reviews were cleared from this view.'));
  window.addEventListener('pagehide',()=>clear());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')clear();});document.addEventListener('tli-panel-switched',e=>{if(e.detail?.panelId!=='panel-homeauto')clear();});
 }
 window.TLIHomeAssistant={clear};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
