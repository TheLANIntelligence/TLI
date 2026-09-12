/* Optional local MCP inspector. Nothing connects or grants access on navigation. */
(() => {
 'use strict';
 const VERSION='2026-07-28',PROTOCOL='tli-mcp-bridge-v1',PREFIX='io.modelcontextprotocol/';
 const allowed={tli_registered_devices:'Registered computers & devices',tli_reported_health:'Recorded host metrics',tli_recorded_rooms:'Recorded room assignments'};
 const scopes={registry:'Names, identifiers and addresses in registered computer/device records.',health:'Existing host CPU, RAM and drive metrics with their observation time. No new probe.',rooms:'Recorded room labels and assignments. No detected occupancy or location.'};
 const state={epoch:0,busy:false,grant:null,credential:null,tools:[],review:null,abort:null,timer:null,seq:0};
 const $=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const btn=(id,text,handler)=>{const n=node('button',text);n.id=id;n.type='button';n.className='btn-outline';n.addEventListener('click',handler);return n;};
 const tell=text=>{if($('mcp-status'))$('mcp-status').textContent=text;};
 const invalidate=()=>{state.review=null;if($('mcp-reviewed'))$('mcp-reviewed').checked=false;if($('mcp-review'))$('mcp-review').replaceChildren();sync();};
 function sync(){
  const active=!!state.grant;
  for(const id of ['mcp-check','mcp-enable','mcp-inspect','mcp-preview','mcp-call','mcp-copy','mcp-show','mcp-disconnect'])if($(id))$(id).disabled=state.busy;
  if($('mcp-enable'))$('mcp-enable').disabled=state.busy||active;
  if($('mcp-inspect'))$('mcp-inspect').disabled=state.busy||!state.credential;
  if($('mcp-preview'))$('mcp-preview').disabled=state.busy||!state.tools.length;
  if($('mcp-call'))$('mcp-call').disabled=state.busy||!state.review||!$('mcp-reviewed')?.checked;
  if($('mcp-disconnect'))$('mcp-disconnect').disabled=state.busy||!active;
  for(const id of ['mcp-allow',...Object.keys(scopes).map(s=>'mcp-scope-'+s)])if($(id))$(id).disabled=state.busy||active;
  for(const id of ['mcp-copy','mcp-show'])if($(id))$(id).disabled=state.busy||!state.credential;
  if($('mcp-secret'))$('mcp-secret').value=state.credential||'';
  if($('mcp-tool'))$('mcp-tool').disabled=state.busy||!state.tools.length;
  for(const id of ['mcp-offset','mcp-limit'])if($(id))$(id).disabled=state.busy||$('mcp-tool')?.value==='tli_reported_health';
 }
 function clear(message='MCP view cleared. Existing grants require Disconnect, PIN lock or expiry to revoke access.'){
  state.epoch++;state.abort?.abort();state.abort=null;state.busy=false;state.grant=null;state.credential=null;state.tools=[];state.review=null;
  clearTimeout(state.timer);state.timer=null;
  for(const id of ['mcp-tools','mcp-result','mcp-review','mcp-grant-details'])$(id)?.replaceChildren();
  if($('mcp-tool'))$('mcp-tool').replaceChildren();if($('mcp-secret'))$('mcp-secret').type='password';
  if($('mcp-show'))$('mcp-show').textContent='Show credential';if($('mcp-reviewed'))$('mcp-reviewed').checked=false;
  if($('mcp-allow'))$('mcp-allow').checked=false;Object.keys(scopes).forEach(s=>{if($('mcp-scope-'+s))$('mcp-scope-'+s).checked=false;});
  tell(message);sync();
 }
 async function response(url,options={}){
  const controller=state.abort;const timer=setTimeout(()=>controller?.abort(),8000);
  try{
   const r=await fetch(url,{...options,signal:controller?.signal,cache:'no-store',headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
   if(r.status===401){clear('MCP access or the PIN browser session expired. Check access deliberately after unlocking.');throw new Error('MCP access expired.');}
   const reader=r.body?.getReader();let raw='';
   if(reader){const decoder=new TextDecoder();let count=0;while(true){const {value,done}=await reader.read();if(done)break;count+=value.byteLength;if(count>128*1024){await reader.cancel();throw new Error('MCP response exceeded the supported size.');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}
   else{raw=await r.text();if(new TextEncoder().encode(raw).length>128*1024)throw new Error('MCP response exceeded the supported size.');}
   let data;try{data=JSON.parse(raw);}catch(_){throw new Error('This endpoint did not return the supported JSON protocol.');}
   if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:typeof data.error?.message==='string'?data.error.message:'The local MCP request failed.');
   return data;
  }finally{clearTimeout(timer);}
 }
 async function run(message,fn){
  if(state.busy)return;const epoch=state.epoch;state.busy=true;state.abort=new AbortController();tell(message);sync();
  try{await fn(epoch);}catch(e){if(epoch===state.epoch)tell((e.name==='AbortError'?'The local request timed out or this browser stopped waiting. No automatic retry ran.':e.message)+($('mcp-result')?.childNodes.length?' Previous displayed results are retained.':''));}
  finally{if(epoch===state.epoch){state.busy=false;state.abort=null;sync();}}
 }
 function showGrant(grant){
  const delay=Date.parse(grant?.expires_at)-Date.now();
  if(!Number.isFinite(delay)||delay<=0||!/^\w{32}$/.test(grant?.id)||!Array.isArray(grant?.scopes)||!grant.scopes.length||grant.scopes.some(s=>!Object.hasOwn(scopes,s))||typeof grant.endpoint!=='string')throw new Error('The host returned an invalid grant receipt. Check access before retrying.');
  state.grant=grant;const box=$('mcp-grant-details');box.replaceChildren();
  box.append(node('p','Endpoint: '+grant.endpoint),node('p','Scopes: '+grant.scopes.join(', ')),node('p','Expires: '+grant.expires_at));
  clearTimeout(state.timer);
  state.timer=setTimeout(()=>clear('MCP grant expired. Enable a new grant deliberately if needed.'),Math.min(delay,900000));
 }
 function check(){return run('Checking local MCP access…',async epoch=>{
  const data=await response('/api/integrations/mcp/status');if(epoch!==state.epoch)return;
  if(data.ok!==true||data.protocol!==PROTOCOL||data.mcp_protocol!==VERSION||!Array.isArray(data.grants)||data.grants.length>1)throw new Error('This host does not provide the supported local MCP checkpoint.');
  if(data.grants.length){showGrant(data.grants[0]);tell(state.credential?'This browser has a temporary grant. Connect the inspector explicitly.':'A temporary grant exists, but its credential is no longer in this view. Disconnect it before enabling a new grant.');}
  else{clear('MCP is disabled for this browser. Review the scopes before enabling it.');}
 });}
 function enable(){return run('Enabling only the reviewed local reads…',async epoch=>{
  const selected=Object.keys(scopes).filter(s=>$('mcp-scope-'+s).checked);
  if(!selected.length||!$('mcp-allow').checked)throw new Error('Select and review the read-only scopes first.');
  const data=await response('/api/integrations/mcp/grant',{method:'POST',body:JSON.stringify({scopes:selected,reviewed:true})});if(epoch!==state.epoch)return;
  if(data.ok!==true||data.protocol!==PROTOCOL||!/^tlim_[A-Za-z0-9_-]{40,64}$/.test(data.credential)||data.scopes?.join(',')!==selected.join(','))throw new Error('The host did not confirm the reviewed MCP grant. Check access before retrying.');
  showGrant(data);state.credential=data.credential;tell('Temporary access enabled. No tool was called. The credential is shown only in this view and is separate from Companion pairing.');
 });}
 async function rpc(method,params={}){
  const id=++state.seq,meta={[PREFIX+'protocolVersion']:VERSION,[PREFIX+'clientInfo']:{name:'TLI local inspector',version:'1'},[PREFIX+'clientCapabilities']:{}};
  const headers={Accept:'application/json, text/event-stream',Authorization:'Bearer '+state.credential,'MCP-Protocol-Version':VERSION,'Mcp-Method':method};
  if(method==='tools/call')headers['Mcp-Name']=params.name;
  const data=await response('/api/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params:{...params,_meta:meta}})});
  if(data.jsonrpc!=='2.0'||data.id!==id||data.error||data.result?.resultType!=='complete')throw new Error(data.error?.message||'MCP response identity or result type was not confirmed.');
  return data.result;
 }
 function inspect(){return run('Connecting the local inspector and listing tools… No tool calls.',async epoch=>{
  if(!state.credential)throw new Error('Enable a temporary grant first.');
  const discovered=await rpc('server/discover');if(epoch!==state.epoch)return;
  if(!discovered.supportedVersions?.includes(VERSION))throw new Error('The server does not support this MCP protocol.');
  const listed=await rpc('tools/list');if(epoch!==state.epoch)return;
  if(!Array.isArray(listed.tools)||listed.tools.length>3||listed.tools.some(t=>!Object.hasOwn(allowed,t.name))||new Set(listed.tools.map(t=>t.name)).size!==listed.tools.length)throw new Error('The local bridge advertised unexpected tools. Nothing was registered with AI.');
  state.tools=listed.tools;invalidate();const select=$('mcp-tool');select.replaceChildren();listed.tools.forEach(t=>{const option=node('option',allowed[t.name]);option.value=t.name;select.append(option);});
  const box=$('mcp-tools');box.replaceChildren(node('p',`${listed.tools.length} granted tools. Tool metadata is reported by the server; annotations do not grant extra permissions.`));
  tell('Inspector connected. Select a tool and review its exact read before running it. No AI tools were registered.');
 });}
 function preview(){
  if(state.busy||!state.tools.length)return;const name=$('mcp-tool').value;
  if(!state.tools.some(t=>t.name===name))return;
  const args=name==='tli_reported_health'?{}:{offset:Number($('mcp-offset').value),limit:Number($('mcp-limit').value)};
  if(name!=='tli_reported_health'&&(!Number.isInteger(args.offset)||args.offset<0||args.offset>2000||!Number.isInteger(args.limit)||args.limit<1||args.limit>50)){tell('Use offset 0–2000 and a result limit 1–50.');return;}
  state.review={name,arguments:args};$('mcp-reviewed').checked=false;
  $('mcp-review').replaceChildren(node('strong','Review read: '+allowed[name]),node('p','Source: this TLI host’s existing registry or observations. No current device check, repair or AI request runs.'),node('pre',JSON.stringify(args,null,2)));
  tell('Review the selected scope and arguments, then explicitly run this read.');sync();
 }
 function call(){return run('Reading the reviewed local source…',async epoch=>{
  if(!state.review||!$('mcp-reviewed').checked)throw new Error('Review the exact read first.');
  const reviewed=JSON.stringify(state.review),data=await rpc('tools/call',state.review);if(epoch!==state.epoch)return;
  if(reviewed!==JSON.stringify(state.review))throw new Error('The reviewed tool changed while reading.');
  if(data.isError===true||data.structuredContent?.ok!==true||data.structuredContent.actions_performed!==false||data.structuredContent.inference_called!==false)throw new Error('The read failed or returned an unsupported result.');
  $('mcp-result').replaceChildren(node('strong',allowed[state.review.name]),node('p','Read completed: '+data.structuredContent.read_at),node('pre',JSON.stringify(data.structuredContent.data,null,2)));
  tell('Read completed. Registry facts and dated readings are not proof of current health. Nothing was sent to AI.');
 });}
 function disconnect(){return run('Revoking this browser’s local MCP grant…',async epoch=>{
  if(!state.grant)return;const data=await response('/api/integrations/mcp/revoke',{method:'POST',body:JSON.stringify({id:state.grant.id})});if(epoch!==state.epoch)return;
  if(data.ok!==true||data.protocol!==PROTOCOL||data.revoked!==true)throw new Error('Revocation was not confirmed.');
  clear('MCP access revoked. A new grant requires deliberate review.');
 });}
 function init(){
  const mount=$('settings-mcp-mount');if(!mount||$('mcp-status'))return;
  const box=node('section');box.className='mcp-bridge';box.append(node('h3','Local MCP bridge'),node('p','Optional read-only access for an MCP client running on the TLI host. Disabled by default. Requires an unlocked PIN browser on localhost; LAN/public and arbitrary remote-server connections are outside this checkpoint.'));
  box.append(node('p','A grant lasts 15 minutes and ends on PIN lock, session expiry, Disconnect or TLI restart. Closing Settings only hides the credential; it does not revoke access. External clients control what they do with returned data.'));
  const status=node('p');status.id='mcp-status';status.setAttribute('role','status');status.textContent='No connection has been checked or enabled in this view.';box.append(btn('mcp-check','Check local access',check),status);
  const fields=node('fieldset');fields.append(node('legend','Choose what this grant may read'));
  Object.entries(scopes).forEach(([scope,description])=>{const label=node('label');const input=node('input');input.type='checkbox';input.id='mcp-scope-'+scope;label.append(input,node('span',description));fields.append(label);});
  const allow=node('label');const accept=node('input');accept.id='mcp-allow';accept.type='checkbox';allow.append(accept,node('span','I reviewed these read-only scopes and understand that the temporary credential allows a local MCP client to read them.'));fields.append(allow);box.append(fields,btn('mcp-enable','Enable reviewed access · 15 minutes',enable));
  const details=node('div');details.id='mcp-grant-details';box.append(details);
  const credentialLabel=node('label','Temporary MCP credential');const secret=node('input');secret.id='mcp-secret';secret.type='password';secret.readOnly=true;secret.autocomplete='off';credentialLabel.append(secret);box.append(credentialLabel);
  const copy=btn('mcp-copy','Copy credential',async()=>{if(!state.credential||state.busy)return;const epoch=state.epoch;try{await navigator.clipboard.writeText(state.credential);if(epoch===state.epoch)tell('Temporary credential copied. Keep it private.');}catch(_){if(epoch===state.epoch)tell('Copy was unavailable. Use Show credential only if you need to copy it manually.');}});
  box.append(btn('mcp-show','Show credential',()=>{if(!state.credential)return;secret.type=secret.type==='password'?'text':'password';$('mcp-show').textContent=secret.type==='password'?'Show credential':'Hide credential';}),copy,btn('mcp-disconnect','Disconnect & revoke access',disconnect));
  const inspector=node('details');inspector.append(node('summary','Inspect and explicitly run a local read'),btn('mcp-inspect','Connect local inspector',inspect));
  const tools=node('div');tools.id='mcp-tools';const select=node('select');select.id='mcp-tool';const selectLabel=node('label','Granted tool');selectLabel.append(select);select.addEventListener('change',invalidate);inspector.append(tools,selectLabel);
  for(const [id,label,value,max] of [['mcp-offset','Start at item',0,2000],['mcp-limit','Maximum items',25,50]]){const field=node('label',label);const input=node('input');input.id=id;input.type='number';input.min=id==='mcp-offset'?'0':'1';input.max=String(max);input.value=String(value);input.addEventListener('input',invalidate);field.append(input);inspector.append(field);}
  const review=node('div');review.id='mcp-review';const reviewed=node('label');const checkBox=node('input');checkBox.id='mcp-reviewed';checkBox.type='checkbox';checkBox.addEventListener('change',sync);reviewed.append(checkBox,node('span','I reviewed this exact local read.'));
  const output=node('div');output.id='mcp-result';inspector.append(btn('mcp-preview','Review selected read',preview),review,reviewed,btn('mcp-call','Run reviewed read',call),output);box.append(inspector);mount.append(box);sync();
  window.addEventListener('tli-session-locked',()=>clear('PIN view locked. MCP credentials and results were cleared from this view. The server rejects grants when their PIN session is revoked or expires.'));
  window.addEventListener('pagehide',()=>clear());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')clear();});
  document.addEventListener('tli-panel-switched',event=>{if(event.detail?.panelId!=='panel-settings')clear();});
 }
 window.TLIMCPBridge={clear};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
