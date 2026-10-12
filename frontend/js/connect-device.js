/* One persistent workflow; discovery hints never confer authority. */
(() => {
  'use strict';
  const everyday=['messages','observe','coordinate'],grantNames={messages:'Messages & files',observe:'Observations',coordinate:'Coordination',inference:'AI compute'};
  let dialog,body,status,opener,epoch=0,locked=false,kind='',selected='',requestId='',requestsView=false;
  let nearby,review,verification,setupBox,unsubscribe,phoneUnmount,peers=[],selection=0,readinessRead=0,resuming=false,pinContinuation=null;
  const requests=new Set(),n=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
  const live=t=>!locked&&dialog?.open&&epoch===t&&!document.hidden;
  const identifier=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\x00-\x1f]/.test(v);
  const b=(text,work,cls='btn-outline')=>{const e=n('button',text,cls);e.type='button';e.addEventListener('click',()=>{if(!locked)Promise.resolve(work(e)).catch(error=>{if(dialog?.open)status.textContent=error.message;});});return e;};
  const project=p=>window.MeshService?.projectConnection(p)||{state:'unknown',fresh:false,online:null,ready_grants:[]};
  const stateLabel=p=>({discovered:'Nearby · needs approval',review_required:'Needs approval',checking:'Checking connection',connected:'Connected',unreachable:'Temporarily unreachable',identity_changed:'Identity changed · review needed',unknown:'Connection not checked'}[p.connection?project(p.connection).state:null]||(['allowed','blocked'].includes(p.status)?p.status==='blocked'?'Access removed · review needed':'Saved connection · not checked':'Nearby · needs approval'));
  async function api(path,payload,ticket=epoch){
    if(!live(ticket))throw Error('Connection view is no longer active.');
    const controller=new AbortController();requests.add(controller);const timeout=setTimeout(()=>controller.abort(),15000);
    try{const response=await fetch(path,{cache:'no-store',credentials:'same-origin',redirect:'error',signal:controller.signal,...(payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})});const data=await response.json().catch(()=>({}));
      if(!live(ticket))throw Error('Connection view changed; response ignored.');
      if(!response.ok){const error=Error(typeof data.detail==='string'?data.detail:data.detail?.message||`Connection request unavailable (${response.status}).`);error.status=response.status;throw error;}return data;
    }finally{clearTimeout(timeout);requests.delete(controller);}
  }
  function detach(){unsubscribe?.();unsubscribe=null;window.TLIPeerPairing?.unmount?.();phoneUnmount?.();phoneUnmount=null;for(const request of requests)request.abort();requests.clear();}
  function close(){epoch++;selection++;detach();dialog?.close();opener?.focus?.();}
  function ensure(){if(dialog)return;dialog=n('dialog',null,'peer-pairing-dialog connect-device-dialog');dialog.id='tli-connect-device-dialog';dialog.setAttribute('aria-labelledby','tli-connect-device-title');const heading=n('h2','Connect a device');heading.id='tli-connect-device-title';heading.tabIndex=-1;body=n('div',null,'peer-pairing-body');status=n('p',null,'peer-pairing-muted');status.id='tli-connect-device-status';status.setAttribute('role','status');dialog.append(heading,body,status,b('Close',close));dialog.addEventListener('cancel',event=>{event.preventDefault();close();});document.body.append(dialog);}
  function selectKind(value){kind=value;selected='';requestId='';requestsView=false;render();}
  async function readiness(ticket){
    const slot=setupBox,read=++readinessRead;
    const results=await Promise.allSettled([api('/mesh/trust/setup',undefined,ticket),api('/api/companion/v1/setup',undefined,ticket),window.TLIConnectionSetup?.local()?api('/api/network-setup/v1/status',undefined,ticket):Promise.resolve(null)]);
    if(!live(ticket)||slot!==setupBox||read!==readinessRead)return;
    const computer=results[0].status==='fulfilled'?results[0].value:null,phone=results[1].status==='fulfilled'?results[1].value:null,network=results[2].status==='fulfilled'?results[2].value:null;
    const ready=kind==='phone'?phone?.pairing_ready:computer?.ready||computer?.stable_origins?.length>0;
    if(resuming&&results[2].status==='fulfilled'&&network){history.replaceState(null,'',location.pathname+location.search);resuming=false;}
    slot.replaceChildren(n('h3',ready?'This workspace is ready to connect':'Prepare this workspace'));
    slot.append(n('p',ready?'Secure LAN access is configured. Review what the other device can share.':computer?.reason||phone?.reason||'Secure LAN access is not ready. Review network setup below.'));
    const origin=computer?.stable_origins?.[0]||phone?.origins?.[0]||computer?.origins?.[0];if(origin)slot.append(n('p',origin,'peer-pairing-address'));
    if(phone?.pin_enabled===false){const pin=n('section');slot.append(pin);window.TLIConnectionSetup?.mountPin(pin,{api:(path,payload)=>api(path,payload,ticket),current:()=>live(ticket),onStart:()=>{pinContinuation={kind,deviceId:selected,requestId,requests:requestsView};},onVerified:()=>{void readiness(ticket);if(kind==='phone')void window.TLICompanion?.refresh?.();},onSettled:()=>{if(!locked)pinContinuation=null;}});}
    const controls=n('section');window.TLIConnectionSetup?.mount(controls,{record:network,api:(path,payload)=>api(path,payload,ticket),current:()=>live(ticket)});
    if(ready){const details=n('details');details.open=!!window.TLIConnectionSetup?.receipt();details.append(n('summary','Network setup & repair'),controls);slot.append(details);}else slot.append(controls);
    slot.append(b('Refresh readiness',()=>readiness(ticket)));
  }
  function actionsFor(peer,ready,slot){
    if(ready.includes('messages'))slot.append(b('Open messages & files',()=>{close();window.TLIChat?.openPeer?.(peer.id);},'btn-primary'));
    if(ready.includes('observe'))slot.append(b('View computer',()=>{close();window.TLIDeviceDetails?.open?.('node-'+peer.id);}));
    if(ready.includes('coordinate'))slot.append(b('Open Computers',()=>{close();window.switchPanel?.('panel-mesh');}));
    if(ready.includes('inference'))slot.append(b('Choose an AI model',()=>{close();window.switchPanel?.('panel-main');const choice=document.querySelector('#chat-lan-inference details');if(choice){choice.open=true;choice.querySelector('summary')?.focus();}}));
  }
  function showConnection(peer,result,slot){
    const connection=project(result.connection),ready=connection.ready_grants.filter(g=>Object.hasOwn(grantNames,g));
    const connected=connection.state==='connected'&&connection.fresh;
    slot.replaceChildren(n('h3',connected?'Connected to '+peer.name:stateLabel({connection})),n('p',connected?'Shared now: '+(ready.map(g=>grantNames[g]).join(', ')||'No shared capabilities yet')+'.':connection.reason?.message||'Saved approval remains. Check that the other computer is running on this network.'));
    if(connected)actionsFor(peer,ready,slot);
  }
  async function verify(peer,ticket,chosen=selection){
    const slot=verification;slot.dataset.peerId=peer.id;slot.replaceChildren(n('h3','Check the connection'),n('p','Checking this reviewed computer…'));
    try{const result=await api('/mesh/directory/'+encodeURIComponent(peer.id)+'/connection',{},ticket);if(!live(ticket)||chosen!==selection||slot!==verification)return;
      if(result.node_id!==peer.id||!Array.isArray(result.ready_grants)||result.ready_grants.some(g=>!Object.hasOwn(grantNames,g)))throw Error('The connection check did not match this computer.');
      showConnection(peer,result,slot);slot.append(b('Check again',()=>verify(peer,ticket,chosen)));window.MeshService?.refreshPeers?.();
    }catch(error){if(live(ticket)&&chosen===selection&&slot===verification)slot.replaceChildren(n('h3','Connection needs attention'),n('p',error.message),n('p','Saved approval remains. Discovery alone does not prove the route is available.'),b('Check again',()=>verify(peer,ticket,chosen)));}
  }
  function choosePeer(peer,ticket,options={}){
    selected=peer.id;requestId='';const chosen=++selection;window.TLIPeerPairing?.unmount?.();review.replaceChildren();verification.replaceChildren();paintNearby(ticket);
    const reviewed=['allowed','blocked'].includes(peer.status)||peer.trust_state==='verified'||peer.review_update===true;
    const settings={deviceId:peer.id,name:peer.name||peer.id,reviewUpdate:reviewed,node:peer.peer_profile==='inference_node',grants:peer.peer_profile==='inference_node'?['inference']:reviewed?(peer.reviewed_grants||peer.local_grants||[]):[...everyday]};
    const pair=()=>window.TLIPeerPairing?.mount(review,settings,receipt=>{if(live(ticket)&&chosen===selection&&receipt.peer.id===peer.id)completedPairing(peer,receipt,ticket,chosen);},receipt=>{if(live(ticket)&&chosen===selection&&receipt.peer.id===peer.id)requestId=receipt.request_id;});
    if(reviewed&&peer.status!=='blocked'&&!options.review){review.append(n('h3',peer.name||peer.id),n('p','Your saved permissions are preserved.'),b('Review or change sharing',pair));void verify(peer,ticket,chosen);}else pair();
  }
  function completedPairing(peer,receipt,ticket,chosen=selection){
    requestId=receipt.request_id;window.TLIPeerPairing?.unmount?.();review.replaceChildren(n('h3','Approved on both computers'),n('p',receipt.grants.map(g=>grantNames[g]).join(' · ')));void verify(peer,ticket,chosen);
  }
  function paintNearby(ticket){
    if(!nearby||!live(ticket))return;
    const allowed=peers.filter(p=>identifier(p.id)&&!p.previous_discovery&&(kind==='node'?p.peer_profile==='inference_node':p.peer_profile!=='inference_node'));
    nearby.replaceChildren(n('h3','Nearby & saved computers'));
    if(!allowed.length)nearby.append(n('p',kind==='node'?'Start a local pairing window on the Node. It appears here when discovered.':'Open TLI and enable secure home-network access on the other computer. Nearby computers appear here automatically.'));
    for(const peer of allowed){const row=n('div',null,'connect-device-peer');row.dataset.peerId=peer.id;row.dataset.selected=String(selected===peer.id);const copy=n('div');copy.append(n('strong',peer.name||peer.id),n('p',stateLabel(peer),'peer-pairing-muted'));const choose=b(selected===peer.id?'Selected':'Connect',()=>choosePeer(peer,ticket),selected===peer.id?'btn-outline':'btn-primary');choose.disabled=selected===peer.id;choose.setAttribute('aria-label',(selected===peer.id?'Selected ':'Connect to ')+(peer.name||peer.id));row.append(copy,choose);nearby.append(row);}
  }
  function invitation(ticket){
    const details=n('details',null,'connect-device-fallback');details.append(n('summary','Computer not appearing?'),n('p','Keep both computers on the same network. Scan nearby, or copy a public invitation from the other computer. Importing one only finds its identity; both owners still compare and approve.'));
    const message=n('p');message.setAttribute('role','status');
    const adapterLabel=n('label','Network to scan'),adapter=n('select');adapter.id='tli-discovery-adapter';adapterLabel.append(adapter);adapterLabel.hidden=true;
    const scan=b('Scan this network',async button=>{if(!adapter.value)return;button.disabled=true;try{await api('/mesh/discovery/scan',{adapter:adapter.value},ticket);message.textContent='Discovery scan started. Nearby results update automatically.';await window.MeshService?.refreshPeers?.();}finally{if(live(ticket))button.disabled=!adapter.value;}});scan.disabled=true;
    let discoveryLoaded=false;
    const loadDiscovery=async()=>{const value=await api('/mesh/discovery/status',undefined,ticket);if(!Array.isArray(value.adapters)||value.adapters.length>64)throw Error('Available networks could not be read.');adapter.replaceChildren();const empty=n('option','Choose an active network');empty.value='';adapter.append(empty);for(const item of value.adapters){if(typeof item.address!=='string')continue;const option=n('option',item.address+(item.subnet?' · '+item.subnet:''));option.value=item.address;adapter.append(option);}if(value.adapters.length===1)adapter.value=value.adapters[0].address;adapterLabel.hidden=false;scan.disabled=!adapter.value;message.textContent=value.reason||'Select the local network to check. Scanning sends discovery probes only; it grants no access.';discoveryLoaded=true;};
    adapter.addEventListener('change',()=>{scan.disabled=!adapter.value;});details.addEventListener('toggle',()=>{if(details.open&&!discoveryLoaded&&live(ticket))void loadDiscovery().catch(error=>{if(live(ticket))message.textContent=error.message;});});
    details.append(adapterLabel,scan,b('Refresh network choices',loadDiscovery));
    const label=n('label','Invitation from the other computer'),input=n('textarea');input.id='tli-connection-invitation-import';input.rows=3;input.maxLength=32768;label.append(input);
    details.append(label,b('Use invitation',async button=>{if(!input.value.trim()){message.textContent='Paste the complete invitation first.';return;}button.disabled=true;try{
      const value=await api('/mesh/pairing/invitation/import',{invitation:input.value.trim()},ticket);if(!identifier(value.device_id)||typeof value.name!=='string'||value.trust_granted!==false)throw Error('The invitation did not identify a computer.');
      // Reload the authoritative local list to preserve existing exact grants.
      const roster=await api('/api/lan/peers',undefined,ticket);if(!Array.isArray(roster.peers))throw Error('Refresh the computer list before reviewing this invitation.');peers=roster.peers;
      const peer=peers.find(p=>p.id===value.device_id)||{id:value.device_id,name:value.name,peer_profile:value.peer_profile,review_update:value.review_update};
      if(value.review_update&&!Array.isArray(peer.reviewed_grants))throw Error('Saved permissions could not be read. Refresh before reviewing this existing connection.');
      input.value='';kind=value.peer_profile==='inference_node'?'node':'computer';if(!peers.some(p=>p.id===peer.id))peers.push(peer);choosePeer(peer,ticket,{review:true});message.textContent='Invitation read. Compare the code before granting access.';
    }finally{if(live(ticket))button.disabled=false;}},'btn-primary'));
    const exported=n('textarea');exported.rows=3;exported.readOnly=true;exported.hidden=true;exported.setAttribute('aria-label','This computer’s public invitation');
    const copy=b('Copy invitation',async()=>{if(!exported.value)return;try{await navigator.clipboard.writeText(exported.value);message.textContent='Public invitation copied.';}catch{exported.focus();exported.select();message.textContent='Select and copy the complete public invitation.';}});copy.hidden=true;
    details.append(b('Show this computer’s invitation',async()=>{const value=await api('/mesh/pairing/invitation',undefined,ticket);if(value.protocol!=='tli-connection-invitation-v1'||typeof value.invitation!=='string'||value.invitation.length>32768)throw Error('The public invitation was incomplete.');exported.value=value.invitation;exported.hidden=false;copy.hidden=false;}),exported,copy,message);
    const advanced=n('details');advanced.append(n('summary','Advanced compatibility'),b('Review public cards manually',()=>{close();window.TLIPeerTrust?.open({purpose:kind==='node'?'inference':undefined});}));details.append(advanced);return details;
  }
  function nodeInstructions(){const details=n('details');details.append(n('summary','Set up an inference Node'),n('p','Run the Node on its own computer with LM Studio and a loaded text model. Open its pairing window locally, then compare the entire code here and in its terminal.'),n('pre','TLI_Node.bat run --state-dir "<Node state folder>" --pair\n\n# If discovery is unavailable, copy a public invitation:\nTLI_Node.bat invitation --state-dir "<Node state folder>"'),n('p','For a saved connection replacement, review the update on both computers. The Node shares AI inference only.'));return details;}
  function render(){
    epoch++;selection++;detach();const ticket=epoch;body.replaceChildren();status.textContent='';nearby=review=verification=setupBox=null;
    if(!kind){body.append(n('p','Connect your phone or another computer to this home workspace.'),b('Phone or phone browser',()=>selectKind('phone'),'btn-primary'),b('Full TLI computer',()=>selectKind('computer'),'btn-primary'),b('Inference Node',()=>selectKind('node'),'btn-primary'));return;}
    body.append(b('Choose another device type',()=>selectKind('')));
    setupBox=n('section');setupBox.append(n('p','Checking this workspace…'));body.append(setupBox);void readiness(ticket).catch(error=>{if(live(ticket))status.textContent=error.message;});
    if(kind==='phone'){const phone=n('section',null,'connect-device-phone');body.append(phone);if(window.TLICompanion?.mount)phoneUnmount=window.TLICompanion.mount(phone);else phone.append(n('p','Pair the installed phone app using a temporary QR invitation.'),b('Open phone pairing',()=>{close();window.TLICompanion?.open({step:'pair'});}));const browser=n('details');browser.append(n('summary','Use the full phone browser workspace'),n('p','Open this host’s HTTPS address on your phone, unlock with your owner PIN, and add it to your home screen.'));const legacy=n('a','Legacy companion and local history');legacy.href='/companion/legacy';browser.append(legacy);body.append(browser);return;}
    if(kind==='node')body.append(nodeInstructions());
    nearby=n('section');review=n('section');review.id='tli-connect-device-review';verification=n('section');verification.id='tli-connect-device-verification';body.append(nearby,review,verification,invitation(ticket));
    const startingSelection=selected,pendingRequest=requestId,showRequests=requestsView;let attached=!!pendingRequest||showRequests;
    const apply=(value,error)=>{if(!live(ticket))return;if(value){peers=value.peers;paintNearby(ticket);if(!attached&&startingSelection&&!selected){const peer=peers.find(p=>p.id===startingSelection);if(peer){attached=true;choosePeer(peer,ticket);}}else if(!attached&&startingSelection===selected){const peer=peers.find(p=>p.id===selected);if(peer){attached=true;choosePeer(peer,ticket);}}else if(selected){const peer=peers.find(p=>p.id===selected);if(peer?.connection&&verification?.children.length&&verification.dataset.peerId===selected){showConnection(peer,{connection:peer.connection},verification);verification.append(b('Check again',()=>verify(peer,ticket)));}}}if(error)status.textContent='Nearby updates are unavailable. Previously listed computers are retained.';};
    if(window.MeshService?.subscribePeers)unsubscribe=window.MeshService.subscribePeers(apply);else void api('/api/lan/peers',undefined,ticket).then(apply).catch(error=>{if(live(ticket))status.textContent=error.message;});paintNearby(ticket);
    if(pendingRequest||showRequests){window.TLIPeerPairing?.mount(review,pendingRequest?{requestId:pendingRequest}:{},receipt=>{const peer={id:receipt.peer.id,name:receipt.peer.name,peer_profile:receipt.peer.profile};selected=peer.id;completedPairing(peer,receipt,ticket);},receipt=>{if(live(ticket)){requestId=receipt.request_id;selected=receipt.peer.id;paintNearby(ticket);}});}
  }
  function open(options={}){if(locked||document.hidden)return;ensure();kind=['phone','computer','node'].includes(options.kind)?options.kind:'';selected=identifier(options.deviceId)?options.deviceId:'';requestId=identifier(options.requestId)?options.requestId:'';requestsView=options.requests===true;opener=document.activeElement;if(!dialog.open)dialog.showModal();render();document.getElementById('tli-connect-device-title').focus();}
  function resumeURL(value){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)return value;const params=new URLSearchParams({connect_device:kind||'computer'});if(identifier(selected))params.set('peer',selected);if(identifier(requestId))params.set('request',requestId);const receipt=window.TLIConnectionSetup?.receipt();if(/^[a-f0-9]{32,64}$/.test(receipt||''))params.set('setup_receipt',receipt);url.hash=params.toString();return url.href;}catch{return value;}}
  function resume(){if(locked||!location.hash.startsWith('#connect_device='))return;const params=new URLSearchParams(location.hash.slice(1)),value=params.get('connect_device');if(!['computer','node','phone'].includes(value))return;resuming=true;window.TLIConnectionSetup?.resume(params.get('setup_receipt'));open({kind:value,deviceId:params.get('peer'),requestId:params.get('request')});}
  function install(){for(const[id,selector]of[['mesh','#panel-mesh .mcd-header-right'],['messages','#panel-tli-chat .tli-chat-titleblock'],['phone','#native-companion-settings .native-companion-overview']]){const anchor=document.querySelector(selector);if(anchor&&!document.getElementById('tli-connect-device-'+id)){const entry=b('Connect device',()=>open(),'btn-primary');entry.id='tli-connect-device-'+id;anchor.prepend(entry);}}}
  window.TLIConnectDevice={open,close,install,resumeURL,isOpen:()=>!!dialog?.open};
  for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event,()=>{locked=true;if(event!=='tli-session-locked')pinContinuation=null;close();peers=[];window.TLIConnectionSetup?.clear();body?.replaceChildren();if(status)status.textContent='';});
  window.addEventListener('tli-session-unlocked',()=>{locked=false;install();if(pinContinuation&&!dialog?.open){const options=pinContinuation;pinContinuation=null;open(options);}else resume();});window.addEventListener('pagehide',close);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){epoch++;for(const request of requests)request.abort();requests.clear();}else if(dialog?.open)render();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{install();resume();});else{install();resume();}
})();
