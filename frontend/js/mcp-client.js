/* Explicit manual MCP workflow. Remote text is data, never markup or AI context. */
(() => {
 'use strict';
 const P='tli-mcp-client-v1',BASE='/api/integrations/mcp-client/',state={epoch:0,busy:false,abort:null,connection:null,endpointReview:null,review:null,tools:[],timer:null,reviewTimer:null,endpointTimer:null};
 const $=id=>document.getElementById(id),make=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const button=(id,label,fn)=>{const n=make('button',label);n.id=id;n.type='button';n.className='btn-outline';n.addEventListener('click',fn);return n;};
 const tell=text=>{if($('mc-status'))$('mc-status').textContent=text;};
 const selected=()=>state.tools.find(t=>t.definition.name===$('mc-tool')?.value);
 const json=value=>JSON.stringify(value,null,2);
 function sync(){
  for(const id of ['mc-check','mc-review-endpoint','mc-connect','mc-disconnect','mc-list','mc-tool-review','mc-invoke','mc-endpoint','mc-token','mc-tool','mc-arguments'])if($(id))$(id).disabled=state.busy;
  if($('mc-connect'))$('mc-connect').disabled=state.busy||!state.endpointReview||!$('mc-endpoint-reviewed')?.checked;
  for(const id of ['mc-list','mc-disconnect'])if($(id))$(id).disabled=state.busy||!state.connection;
  if($('mc-tool-review'))$('mc-tool-review').disabled=state.busy||!state.connection||selected()?.supported!==true;
  if($('mc-invoke'))$('mc-invoke').disabled=state.busy||!state.review||!$('mc-tool-reviewed')?.checked;
  if($('mc-stop'))$('mc-stop').disabled=!state.busy;
 }
 function invalidateReview(message){state.review=null;clearTimeout(state.reviewTimer);state.reviewTimer=null;if($('mc-tool-reviewed'))$('mc-tool-reviewed').checked=false;$('mc-review')?.replaceChildren(...(message?[make('p',message)]:[]));sync();}
 function invalidateEndpoint(){state.endpointReview=null;clearTimeout(state.endpointTimer);state.endpointTimer=null;if($('mc-endpoint-reviewed'))$('mc-endpoint-reviewed').checked=false;$('mc-endpoint-review')?.replaceChildren();sync();}
 function clear(message='This view was cleared. A submitted invocation may still finish; no automatic retry or reconnect runs.'){
  state.epoch++;state.abort?.abort();state.abort=null;state.busy=false;state.connection=null;state.tools=[];clearTimeout(state.timer);state.timer=null;invalidateReview();invalidateEndpoint();
  for(const id of ['mc-current','mc-tool','mc-definition','mc-result','mc-attempt'])$(id)?.replaceChildren();
  for(const id of ['mc-endpoint','mc-token','mc-arguments'])if($(id))$(id).value='';tell(message);sync();
 }
 function stop(){state.epoch++;state.abort?.abort();state.abort=null;state.busy=false;invalidateReview('Waiting stopped. Any submitted invocation has an unknown outcome. Review again deliberately; nothing will be replayed.');invalidateEndpoint();tell('This browser stopped waiting. It did not prove cancellation of server work. Previous results remain visible.');sync();}
 async function api(operation,body){
  const abort=state.abort,requestEpoch=state.epoch,timer=setTimeout(()=>abort?.abort(),125000);
  try{
   const r=await fetch(BASE+operation,{method:body?'POST':'GET',cache:'no-store',signal:abort?.signal,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if(r.status===401){if(requestEpoch===state.epoch)clear('The owner PIN session expired. The MCP client view was cleared.');throw new Error('Unlock the PIN before reviewing another connection.');}
   let raw='',bytes=0;const reader=r.body?.getReader();
   if(reader){const decoder=new TextDecoder();while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2*1024*1024){await reader.cancel();throw new Error('The bridge response exceeded its display limit.');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}
   else{raw=await r.text();if(new TextEncoder().encode(raw).length>2*1024*1024)throw new Error('The bridge response exceeded its display limit.');}
   let d;try{d=JSON.parse(raw);}catch(_){throw new Error('This host returned unreadable MCP client data.');}
   if(!r.ok)throw new Error(typeof d.detail==='string'?d.detail:'This MCP client request failed.');
   if(d?.protocol!==P||d.ok!==true)throw new Error('This host did not confirm a supported MCP client response.');return d;
  }finally{clearTimeout(timer);}
 }
 async function run(message,fn){
  if(state.busy)return;state.busy=true;state.abort=new AbortController();const epoch=state.epoch;tell(message);sync();
  try{await fn(epoch);}catch(e){if(epoch===state.epoch)tell((e.name==='AbortError'?'This browser stopped waiting. A submitted invocation may have run; no automatic retry follows.':e.message)+($('mc-result')?.childNodes.length?' Previous displayed output is retained.':''));}
  finally{if(epoch===state.epoch){state.busy=false;state.abort=null;sync();}}
 }
 function adopt(c){
  const delay=Date.parse(c?.expires_at)-Date.now();if(!/^[a-f0-9]{32}$/.test(c?.id)||typeof c.endpoint!=='string'||c.protocol_version!=='2026-07-28'||!/^[a-f0-9]{64}$/.test(c.catalogue_fingerprint)||!Number.isFinite(delay)||delay<=0)throw new Error('A valid temporary MCP connection was not confirmed.');
  if(state.connection?.id!==c.id){state.tools=[];$('mc-tool').replaceChildren();$('mc-definition').replaceChildren();invalidateReview();}
  state.connection=c;clearTimeout(state.timer);state.timer=setTimeout(()=>clear('This temporary MCP connection expired. Nothing reconnects automatically.'),Math.min(delay,900000));
  $('mc-current').replaceChildren(make('strong','Exact endpoint: '+c.endpoint),make('p','Server identity is self-reported: '+json(c.server_info)),make('p','Protocol '+c.protocol_version+' · expires '+c.expires_at),make('p','Catalogue observed: '+c.checked_at),make('p','Previous output keeps its own source and time, even when you replace this connection.'));
 }
 function renderTools(tools){
  if(!Array.isArray(tools)||tools.length>64||tools.some(t=>typeof t.definition?.name!=='string'||!/^[a-f0-9]{64}$/.test(t.fingerprint)||typeof t.supported!=='boolean')||new Set(tools.map(t=>t.definition.name)).size!==tools.length)throw new Error('The exact bounded tool catalogue was not confirmed.');
  const prior=$('mc-tool').value;state.tools=tools;$('mc-tool').replaceChildren();const blank=make('option','Choose an exact tool…');blank.value='';$('mc-tool').append(blank);
  for(const t of tools){const option=make('option',t.definition.name+(t.supported?'':' · unsupported schema'));option.value=t.definition.name;$('mc-tool').append(option);}
  if(tools.some(t=>t.definition.name===prior))$('mc-tool').value=prior;else $('mc-tool').value='';describe();
 }
 function describe(){
  invalidateReview('Review this exact tool and your JSON arguments before invoking.');const tool=selected();$('mc-definition').replaceChildren();if(!tool)return;
  $('mc-definition').append(make('strong',tool.definition.name),make('p',tool.supported?'Supported bounded input schema. Actual effect is unknown; annotations do not enforce read-only behavior.':'Invocation disabled: '+tool.reason),make('p','Definition fingerprint: '+tool.fingerprint),make('pre',json(tool.definition)));
 }
 function check(){return run('Checking this PIN browser’s temporary connection… No remote request runs.',async epoch=>{
  const d=await api('status');if(epoch!==state.epoch)return;if(d.remote_requests!==false||!Array.isArray(d.connections)||d.connections.length>1)throw new Error('Connection status was not confirmed.');
  if(d.connections.length){adopt(d.connections[0]);tell('A temporary connection exists. List tools explicitly to review its current catalogue. No remote request ran for this status check.');}
  else{state.connection=null;state.tools=[];$('mc-current').replaceChildren();$('mc-tool').replaceChildren();$('mc-definition').replaceChildren();invalidateReview();tell('No temporary connection exists for this PIN browser. Previous output, if shown, is historical.');}
 });}
 function reviewEndpoint(){return run('Reviewing the endpoint locally… No credential or protocol request is sent.',async epoch=>{
  const d=await api('connection-review',{endpoint:$('mc-endpoint').value.trim()});if(epoch!==state.epoch)return;
  if(d.remote_requests!==false||typeof d.endpoint!=='string'||!/^[a-f0-9]{64}$/.test(d.review_token))throw new Error('The exact endpoint review was not confirmed.');
  state.endpointReview=d;$('mc-endpoint-reviewed').checked=false;$('mc-endpoint-review').replaceChildren(make('strong',d.endpoint),make('p',d.insecure_http?'HTTP: the optional external token and protocol data are sent unencrypted over loopback.':'HTTPS: the certificate and literal IP address must validate normally.'),make('p',d.scope));
  clearTimeout(state.endpointTimer);state.endpointTimer=setTimeout(()=>{invalidateEndpoint();tell('Endpoint review expired. Review it again before connecting.');},300000);tell('Review this exact endpoint and transport. Connecting will discover the server and list tools; it does not invoke a tool.');
 });}
 function connect(){return run('Connecting to the reviewed endpoint and listing its tools… No tool is invoked.',async epoch=>{
  if(!state.endpointReview||!$('mc-endpoint-reviewed').checked)throw new Error('Review the exact endpoint first.');
  const d=await api('connect',{review_token:state.endpointReview.review_token,token:$('mc-token').value,reviewed:true});if(epoch!==state.epoch)return;
  if(d.tool_invoked!==false)throw new Error('The candidate connection outcome was not confirmed.');adopt(d.connection);renderTools(d.tools);$('mc-token').value='';invalidateEndpoint();tell('Connected for up to 15 minutes. Choose a tool and enter only the JSON you intend to send. No chat, saved notes, Vault content or documents are attached.');
 });}
 function disconnect(){return run('Disconnecting this temporary client…',async epoch=>{
  const d=await api('disconnect',{connection_id:state.connection?.id||''});if(epoch!==state.epoch)return;if(d.disconnected!==true||d.remote_requests!==false)throw new Error('Disconnection was not confirmed.');clear('Temporary connection disconnected. This does not revoke the original external credential or prove cancellation of earlier work.');
 });}
 function list(){return run('Explicitly refreshing server discovery and its tool catalogue… No tool is invoked.',async epoch=>{
  const d=await api('list',{connection_id:state.connection.id});if(epoch!==state.epoch)return;if(d.tool_invoked!==false||d.connection?.id!==state.connection.id)throw new Error('Catalogue refresh was not confirmed.');adopt(d.connection);renderTools(d.tools);tell('Catalogue refreshed. Any changed definition needs a new invocation review.');
 });}
 function reviewTool(){return run('Rechecking the exact server and schema for your invocation review… No tool is invoked.',async epoch=>{
  const t=selected();if(!t?.supported)throw new Error('Choose a supported tool first.');const raw=$('mc-arguments').value;if(new TextEncoder().encode(raw).length>16384)throw new Error('Arguments exceed 16 KiB.');let args;try{args=JSON.parse(raw);}catch(_){throw new Error('Enter one valid JSON object.');}if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Arguments must be one JSON object.');
  const d=await api('tool-review',{connection_id:state.connection.id,tool_name:t.definition.name,tool_fingerprint:t.fingerprint,arguments:args});if(epoch!==state.epoch)return;
  if(d.tool_invoked!==false||d.review?.endpoint!==state.connection.endpoint||d.review?.tool_fingerprint!==t.fingerprint||d.review?.actual_effect!=='unknown'||!/^[a-f0-9]{64}$/.test(d.review_token)||!/^[a-f0-9]{64}$/.test(d.review_hash))throw new Error('The exact invocation review was not confirmed.');
  const delay=Date.parse(d.expires_at)-Date.now();if(!Number.isFinite(delay)||delay<=0)throw new Error('The invocation review already expired.');state.review=d;$('mc-tool-reviewed').checked=false;
  $('mc-review').replaceChildren(make('strong','Review one invocation: '+d.review.tool.name),make('p','Actual effect is unknown. The server may change files, contact other services or perform actions even if it labels the tool read-only.'),make('p','Exact source: '+d.review.endpoint),make('p','Server-provided definition and effect claims'),make('pre',json(d.review.tool)),make('p','Exact arguments to send'),make('pre',json(d.review.arguments)),make('p','Arguments mirrored into protocol headers'),make('pre',json(d.review.mirrored_headers)),make('p','One-use review expires: '+d.expires_at));
  clearTimeout(state.reviewTimer);state.reviewTimer=setTimeout(()=>invalidateReview('This invocation review expired. Review again before running.'),Math.min(delay,120000));tell('Read the exact tool definition, source and arguments. Invoke is a separate action, with no automatic retry.');
 });}
 function invoke(){return run('Rechecking the reviewed schema, then sending at most one tool invocation…',async epoch=>{
  if(!state.review||!$('mc-tool-reviewed').checked)throw new Error('Confirm the exact invocation review first.');if(typeof window.crypto?.randomUUID!=='function')throw new Error('This browser cannot create a safe invocation ID. Use HTTPS or localhost.');
  const r=state.review,id=state.connection.id,requestId=window.crypto.randomUUID();
  try{
   const d=await api('invoke',{connection_id:id,review_token:r.review_token,review_hash:r.review_hash,request_id:requestId,reviewed:true});if(epoch!==state.epoch)return;
   if(d.request_id!==requestId||!['completed','server_error','not_sent','unknown'].includes(d.outcome)||d.requires_review!==true)throw new Error('The invocation outcome was not confirmed. No retry runs.');
   if(d.outcome==='completed'||d.outcome==='server_error'){
    if(!d.output||!Array.isArray(d.output.text)||d.output.text.some(x=>typeof x!=='string')||d.endpoint!==r.review.endpoint||d.tool_name!==r.review.tool.name)throw new Error('The returned source/output was not confirmed.');
    const nodes=[make('strong',d.outcome==='completed'?'Server returned a result':'Server reported a tool error'),make('p',d.endpoint+' · '+d.tool_name),make('p','Received: '+d.checked_at+' · actual effect remains unverified'),make('p',d.message)];
    for(const text of d.output.text)nodes.push(make('pre',text));if(Object.prototype.hasOwnProperty.call(d.output,'structured'))nodes.push(make('p','Structured JSON supplied by server'),make('pre',json(d.output.structured)));nodes.push(make('p',`${d.output.omitted_content_items} non-text content items excluded. No linked resource, image, application or follow-up instruction was opened.`));
    $(d.outcome==='completed'?'mc-result':'mc-attempt').replaceChildren(...nodes);if(d.outcome==='completed')$('mc-attempt').replaceChildren();
   }
   else $('mc-attempt').replaceChildren(make('strong',d.outcome==='unknown'?'Latest invocation outcome unknown':'Latest invocation was not sent'),make('p',r.review.endpoint+' · '+r.review.tool.name),make('p','Recorded: '+d.checked_at),make('p',d.message));
   tell(d.message+(d.outcome==='unknown'||d.outcome==='not_sent'?' Previous output is retained, if available.':''));
  }finally{if(epoch===state.epoch)invalidateReview('This review was consumed or its outcome is unknown. Nothing will be replayed. Inspect the external system before deliberately preparing another invocation.');}
 });}
 function init(){
  const mount=$('settings-mcp-client-mount');if(!mount||$('mc-status'))return;const box=make('section');box.className='mcp-manual';mount.append(box);
  box.append(make('h3','Use an MCP tool · manual connection'),make('p','Connect a compatible MCP server already running on this TLI host. Review the exact tool and JSON for every invocation. This does not launch programs, register tools with AI or attach private TLI context.'));
  const status=make('p','No temporary connection has been checked in this view.');status.id='mc-status';status.setAttribute('role','status');box.append(button('mc-check','Check temporary connection',check),status);
  const config=make('details');config.append(make('summary','Connect or replace a temporary session'));box.append(config);
  function field(id,label,type='text',placeholder=''){const wrap=make('label',label),input=make('input');input.id=id;input.type=type;input.placeholder=placeholder;wrap.append(input);return wrap;}
  config.append(field('mc-endpoint','Exact loopback MCP endpoint','url','http://127.0.0.1:8124/mcp'));$('mc-endpoint').addEventListener('input',invalidateEndpoint);config.append(make('p','Use an explicit different port and /mcp or /api/mcp. Only literal 127.x.x.x or ::1 loopback addresses are supported. Older MCP protocols, remote hosts and stdio launches are unavailable.'),button('mc-review-endpoint','Review endpoint',reviewEndpoint));
  const endpoint=make('div');endpoint.id='mc-endpoint-review';config.append(endpoint);
  function checkfield(id,label){const wrap=make('label'),input=make('input');input.id=id;input.type='checkbox';input.addEventListener('change',sync);wrap.append(input,make('span',label));return wrap;}
  config.append(checkfield('mc-endpoint-reviewed','I reviewed this exact endpoint, transport and discovery scope.'),field('mc-token','External Bearer token (optional)','password'));$('mc-token').autocomplete='off';config.append(make('p','Use a credential for that server only. TLI never forwards its PIN cookie or Companion credentials. The token lives only in server memory for this PIN browser, up to 15 minutes; it is not saved in configuration or backups.'),button('mc-connect','Connect & list tools',connect));
  const current=make('div');current.id='mc-current';box.append(current,button('mc-disconnect','Disconnect temporary session',disconnect),make('p','Closing or backgrounding this view hides its private results and reviews. It does not prove cancellation of submitted work. PIN revocation, expiry and TLI restart end temporary client access.'),button('mc-list','Refresh tool catalogue',list));
  const toolLabel=make('label','Exact server tool'),tool=make('select');tool.id='mc-tool';tool.addEventListener('change',describe);toolLabel.append(tool);const definition=make('details');definition.append(make('summary','Full server definition · untrusted claims'));const def=make('div');def.id='mc-definition';definition.append(def);box.append(toolLabel,definition);
  const argsLabel=make('label','JSON arguments to send'),args=make('textarea');args.id='mc-arguments';args.rows=6;args.spellcheck=false;args.placeholder='{}';args.addEventListener('input',()=>invalidateReview('Arguments changed. Prepare a new exact review.'));argsLabel.append(args);const review=make('div');review.id='mc-review';const result=make('div');result.id='mc-result';
  const attempt=make('div');attempt.id='mc-attempt';box.append(argsLabel,button('mc-tool-review','Prepare invocation review',reviewTool),review,checkfield('mc-tool-reviewed','I reviewed the exact tool, JSON and source. Its actual effect is unknown; I choose to invoke it once.'),button('mc-invoke','Invoke reviewed tool once',invoke),button('mc-stop','Stop waiting',stop),attempt,result);sync();
  window.addEventListener('tli-session-locked',()=>clear('The PIN view locked. MCP credentials, results and invocation reviews were cleared.'));
  window.addEventListener('pagehide',()=>clear());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')clear();});document.addEventListener('tli-panel-switched',e=>{if(e.detail?.panelId!=='panel-settings')clear();});
  // A Settings group/disclosure can close without switching the SPA panel.
  const section=mount.closest?.('.settings-section'),group=mount.closest?.('.settings-group');
  if(typeof MutationObserver==='function'&&(section||group)){
   const observer=new MutationObserver(()=>{if(section?.classList.contains('collapsed')||section?.hidden||group?.hidden)clear('This MCP settings view closed. Private results and reviews were cleared; submitted work may still finish.');});
   for(const node of [section,group])if(node)observer.observe(node,{attributes:true,attributeFilter:['class','hidden']});
  }
 }
 window.TLIMCPClient={onOpen:init,onClose:clear,clear};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
