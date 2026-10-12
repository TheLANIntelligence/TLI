/* Explicit LAN connection requests. Discovery never grants permission. */
(() => {
  'use strict';
  const base = '/mesh/pairing';
  let dialog, body, status, target = null, selectedId = null, opener;
  let epoch = 0, locked = false, busy = false, timer = null, polling = false, supported = null;
  let requests = [], renderKey = '', remoteRefreshAt = 0;
  let supportsV2 = false;
  let embedded = null, onConnected = null, onProgress = null, notified = '';
  const everyday = ['messages','observe','coordinate'];
  const opened = () => embedded ? embedded.isConnected && !!embedded.closest('dialog')?.open : !!dialog?.open;
  const grantNames = {messages:'Messages and reviewed file offers', observe:'Read-only computer observations', coordinate:'Connection coordination', inference:'Explicitly selected AI compute'};
  const checks = new Map();
  const n = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const live = token => !locked && token === epoch;
  const active = token => live(token) && opened() && !document.hidden;
  const validView = r => r && typeof r.request_id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(r.request_id) &&
    ['incoming', 'outgoing'].includes(r.direction) && r.peer && typeof r.peer.id === 'string' && typeof r.peer.name === 'string' &&
    typeof r.peer.origin === 'string' && Array.isArray(r.grants) && r.grants.length > 0 && r.grants.length <= 4 && new Set(r.grants).size === r.grants.length && r.grants.every(g => Object.hasOwn(grantNames,g)) &&
    typeof r.local_confirmed === 'boolean' && typeof r.remote_confirmed === 'boolean' && Number.isFinite(Date.parse(r.expires_at)) &&
    (r.code == null || /^[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}$/i.test(r.code)) &&
    ['comparing', 'waiting', 'connected', 'cancelled'].includes(r.state) &&
    (r.peer.profile !== 'inference_node' || r.protocol === 'tli-computer-pairing-v2' && r.grants.length === 1 && r.grants[0] === 'inference');
  const expired = r => Date.parse(r.expires_at) <= Date.now();
  function button(text, fn, cls = 'btn btn-outline') {
    const e = n('button', text, cls); e.type = 'button';
    e.addEventListener('click', () => { if (!locked && !busy) Promise.resolve(fn()).catch(error => { if (opened()) status.textContent = error.message; }); });
    return e;
  }
  async function api(path, payload, token) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(base + path, {method:payload === undefined ? 'GET' : 'POST', cache:'no-store', signal:controller.signal,
        ...(payload === undefined ? {} : {headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})});
      if (!live(token)) throw Error('Connection review closed.');
      const data = await response.json().catch(() => ({}));
      if (!live(token)) throw Error('Connection review closed.');
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { requests = []; checks.clear(); renderKey = ''; document.getElementById('tli-peer-pairing-banner')?.remove(); }
        const unavailable = response.status === 404 && !data.detail?.code;
        const nodeWindowRequired = target?.node && (unavailable || data.detail?.code === 'pairing_update_required');
        const error = Error(nodeWindowRequired
          ? 'Use updated TLI on this host and Node. Start the Node locally with run --pair, then request a connection during its five-minute window. Replacing saved trust also needs --review-update on the Node.'
          : unavailable
          ? 'Connection requests need updated TLI on both computers. Update and restart both installations, or use manual card review.'
          : typeof data.detail === 'string' ? data.detail : data.detail?.message || 'The connection request could not be completed.');
        error.status = response.status; error.detail = data.detail; error.unavailable = unavailable; throw error;
      }
      if (data.ok !== true) throw Error('TLI did not confirm the connection request. Refresh its status.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('The connection request timed out. Refresh its status before trying again.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function useView(data) {
    if (!validView(data.request)) throw Error('TLI returned incomplete connection details. No confirmation was accepted.');
    const view = data.request;
    requests = requests.filter(r => r.request_id !== view.request_id).concat(view);
    selectedId = view.request_id; renderKey = ''; paint(); banner();
  }
  async function operation(path, payload) {
    if (busy || locked) return;
    const token = epoch; busy = true;
    body?.querySelectorAll('button,input,select').forEach(e => { e.disabled = true; });
    status.textContent = 'Checking the connection request…';
    try {
      const data = await api(path, payload, token);
      if (!active(token)) return;
      useView(data); status.textContent = '';
      window.dispatchEvent(new CustomEvent('tli-peer-trust-changed'));
    } catch (error) {
      if (active(token)) {
        status.textContent = error.message;
        if (error.detail?.code === 'pairing_origin_required' && Array.isArray(error.detail.origins)) showOrigins(error.detail.origins);
      }
    } finally {
      if (live(token)) { busy = false; renderKey = ''; paint(); }
    }
  }
  let chosenOrigin = '';
  function showOrigins(origins) {
    target = {...target, origins:origins.filter(x => typeof x === 'string')}; renderKey = '';
  }
  function manual() { const options = target || {}; close(); window.TLIPeerTrust?.open(options); }
  function chooseRequest(id) { selectedId = id; renderKey = ''; status.textContent = ''; paint(); }
  function paint() {
    if (!opened() || locked) return;
    let current = requests.find(r => r.request_id === selectedId);
    if (!current && target?.deviceId) current = requests.find(r => r.peer.id === target.deviceId && !expired(r) && r.state !== 'cancelled');
    if (current) selectedId = current.request_id;
    if(current&&onProgress){const token=epoch,view=current,callback=onProgress;queueMicrotask(()=>{if(active(token))callback(view);});}
    const key = JSON.stringify({target, selectedId, current, available:supported, rows:requests.map(r => [r.request_id,r.state,r.local_confirmed,r.remote_confirmed]), expired:current && expired(current)});
    if (key === renderKey) return;
    renderKey = key; body.replaceChildren();
    if (supported === false) {
      body.append(n('p','Install the updated TLI on both computers to use connection requests. Your existing manual card review is still available.'),button('Manual card review',manual)); return;
    }
    if (current && (current.state === 'connected' || !expired(current)) && current.state !== 'cancelled') {
      const peer = current.peer;
      body.append(n('h3', peer.name),n('p', current.direction === 'incoming' ? 'This computer is asking to connect.' : 'Your connection request was sent.'),n('p',peer.origin,'peer-pairing-address'));
      if (!current.code) body.append(n('p','Waiting for the other computer to finish exchanging connection details. No permission has been granted.'));
      else {
        const code = n('div',current.code.toUpperCase(),'peer-pairing-code');code.id='tli-peer-pairing-code';code.setAttribute('aria-label','Connection comparison code');
        body.append(n('p',peer.profile === 'inference_node'
          ? 'Compare this entire code with the Node terminal. Approve inference there and on this computer.'
          : 'Open Connection requests on the other computer. Compare this entire code on both screens.'),code);
        body.append(n('p','Permissions: '+current.grants.map(g=>grantNames[g]).join('; ')+'.'));
        if(current.review_update) body.append(n('p','This review replaces the saved connection details and permissions on each computer when its owner confirms.'));
        if (current.local_confirmed && current.remote_confirmed) {
          body.append(n('p',onConnected?'Both computers confirmed this connection. Checking shared capabilities…':'Both computers confirmed this connection. Your selected capabilities are ready to check.','peer-pairing-result'));
          if (notified !== current.request_id) { notified=current.request_id; const receipt=current, callback=onConnected, token=epoch; queueMicrotask(()=>{if(active(token))callback?.(receipt);}); }
        }
        else if (current.local_confirmed) body.append(n('p','Permissions saved here. Waiting for confirmation on the other computer. Keep this window open while both computers confirm.','peer-pairing-result'));
        else {
          if (current.remote_confirmed) body.append(n('p','The other computer confirmed. Review the code and permission here to finish.'));
          const key = current.request_id+'|'+current.code;
          const draft = checks.get(key) || {match:false,messages:false};checks.set(key,draft);
          const matchLabel=n('label',null,'peer-pairing-check'),match=n('input');match.type='checkbox';match.id='peer-pairing-code-match';match.checked=draft.match;
          matchLabel.append(match,n('span','I compared both screens and the entire codes match.'));
          const permissionLabel=n('label',null,'peer-pairing-check'),permission=n('input');permission.type='checkbox';permission.id='peer-pairing-messages';permission.checked=draft.messages;
          permissionLabel.append(permission,n('span',peer.profile === 'inference_node'
            ? 'Allow explicitly selected AI inference on this Node.'
            : 'Allow the permissions listed above. Each file still needs receiver consent; AI compute is selected separately.'));
          const confirm=button('Codes match — connect',()=>operation('/'+encodeURIComponent(current.request_id)+'/confirm',{code:current.code,allow_messages:true,...(current.protocol==='tli-computer-pairing-v2'?{grants:current.grants}:{})}),'btn btn-primary');
          const update=()=>{draft.match=match.checked;draft.messages=permission.checked;confirm.disabled=busy||!draft.match||!draft.messages;};
          match.addEventListener('change',update);permission.addEventListener('change',update);update();
          body.append(matchLabel,permissionLabel,confirm);
        }
      }
      body.append(n('p',current.local_confirmed&&current.remote_confirmed?'The saved connection remains after this temporary invitation expires.':'Request expires '+new Date(current.expires_at).toLocaleTimeString()+'.','peer-pairing-muted'));
      const actions=n('div',null,'peer-pairing-actions');actions.append(button('Refresh status',()=>refresh(true)));
      if (!current.local_confirmed) actions.append(button(current.direction==='incoming'?'Decline request':'Cancel request',()=>operation('/'+encodeURIComponent(current.request_id)+'/cancel',{})));
      body.append(actions);
    } else if (target?.deviceId && supported === true) {
      body.append(n('h3',target.name||'Selected computer'),n('p',target.node
        ? 'Connect this Node for AI inference by comparing a code in this browser and its local terminal.'
        : 'Choose what these computers can share, then compare the code on both screens. Trust approval stays on the computers.'));
      if(target.node){
        if(!supportsV2){body.append(n('p','Update this host and the Node to use guided inference pairing.'),button('Manual card review',manual));return;}
        target.grants=['inference'];
        body.append(n('p','Permission: explicitly selected AI compute only. Start the Node with run --pair, then compare the code with its terminal.'));
        if(target.reviewUpdate)body.append(n('p','To replace a saved Node connection, start it with run --pair --review-update and review the replacement on both computers.'));
      }else if(supportsV2){
        if(!target.grants)target.grants=[...everyday];
        body.append(n('p',target.reviewUpdate?'Your saved permission selection is shown below.':'Everyday connection: messages, read-only observations and coordination. AI compute is optional and must be selected separately.'));
        const extras=n('details');extras.append(n('summary','Optional AI compute'));
        for(const [grant,label] of Object.entries(grantNames)) { const row=n('label',null,'peer-pairing-check'),input=n('input');input.type='checkbox';input.checked=target.grants.includes(grant);input.addEventListener('change',()=>{target.grants=input.checked?[...new Set([...target.grants,grant])].sort():target.grants.filter(g=>g!==grant);});row.append(input,n('span',label));(grant==='inference'?extras:body).append(row); }
        extras.open=target.grants.includes('inference');body.append(extras);
        if(target.reviewUpdate)body.append(n('p','Reviewing this connection replaces its saved permissions with the exact selection above.'));
      }
      if (current?.state==='cancelled') body.append(n('p','This connection request was cancelled. No further confirmation will be accepted.'));
      else if (selectedId) body.append(n('p','The previous request expired or is no longer available. You can send a new request.'));
      if (target.origins?.length) {
        const label=n('label','This computer’s LAN address'),select=n('select');select.id='peer-pairing-origin';
        const empty=n('option','Choose an address on the other computer’s network');empty.value='';select.append(empty);
        target.origins.forEach(origin=>{const option=n('option',origin);option.value=origin;select.append(option);});select.value=chosenOrigin;
        select.addEventListener('change',()=>{chosenOrigin=select.value;});label.append(select);body.append(label);
      }
      body.append(button('Request connection',()=>{if(supportsV2&&!target.grants.length){status.textContent='Choose at least one permission.';return;}return operation('/start',{device_id:target.deviceId,...(chosenOrigin?{origin:chosenOrigin}:{}),...(supportsV2?{version:2,grants:[...target.grants].sort(),review_update:!!target.reviewUpdate}:{})});},'btn btn-primary'));
      const advanced=n('details');advanced.append(n('summary','Advanced connection options'),button('Manual card review',manual));body.append(advanced);
    } else if (supported === true) {
      if (current?.state === 'cancelled') body.append(n('p','This connection request was cancelled. No further confirmation will be accepted.'));
      else if (selectedId) body.append(n('p','This connection request expired or is no longer available. Send a new request from the other computer.'));
      body.append(n('p',requests.some(r=>!expired(r)&&r.state!=='cancelled')?'Choose a request below to review it.':'No connection requests are waiting. Select a discovered computer in Computers or LAN Messages to request a connection.'));
    }
    else body.append(n('p','Loading connection requests…'));
    const others=requests.filter(r=>r.request_id!==current?.request_id&&!expired(r)&&r.state!=='cancelled');
    if (others.length) {
      const list=n('section');list.append(n('h3','Connection requests'));
      others.forEach(r=>list.append(button((r.direction==='incoming'?'From ':'To ')+r.peer.name+(r.local_confirmed?' · confirmed here':''),()=>chooseRequest(r.request_id))));body.append(list);
    }
  }
  async function refresh(force=false) {
    if (locked || document.hidden || polling || busy || supported===false&&!force) return;
    const token=epoch,poll={};polling=poll;
    try {
      const data=await api('/requests',undefined,token);
      if (!live(token)) return;
      if (data.supported!==true||!Array.isArray(data.requests)||data.requests.length>64||!data.requests.every(validView)) throw Error('TLI returned incomplete connection requests. Refresh before confirming.');
      supported=true;supportsV2=Array.isArray(data.protocols)&&data.protocols.includes('tli-computer-pairing-v2');requests=data.requests;
      const current=requests.find(r=>r.request_id===selectedId);
      if (active(token)&&current?.direction==='outgoing'&&!expired(current)&&current.state!=='cancelled'&&Date.now()-remoteRefreshAt>3000) {
        remoteRefreshAt=Date.now();const result=await api('/'+encodeURIComponent(current.request_id)+'/refresh',{},token);
        if (!active(token)) return;useView(result);
      }
      if (active(token)) {if(force)status.textContent='';paint();}
      banner();
    } catch (error) {
      if (live(token)) {
        if(error.unavailable)supported=false;
        if(opened()){status.textContent=error.message;renderKey='';paint();}
        if(error.status===403||error.unavailable)document.getElementById('tli-peer-pairing-banner')?.remove();
      }
    } finally {if(polling===poll)polling=false;}
  }
  function banner() {
    let box=document.getElementById('tli-peer-pairing-banner');
    const pending=requests.filter(r=>r.direction==='incoming'&&!r.local_confirmed&&!expired(r)&&r.state!=='cancelled');
    if(locked||!pending.length){box?.remove();return;}
    if(!box){box=n('aside',null,'peer-pairing-banner');box.id='tli-peer-pairing-banner';box.setAttribute('aria-label','Incoming computer connection request');document.body.append(box);}
    const signature=pending.map(r=>r.request_id).join('|');if(box.dataset.requests===signature)return;box.dataset.requests=signature;box.replaceChildren();
    box.append(n('strong',pending.length===1?pending[0].peer.name+' wants to connect':pending.length+' computer connection requests'),n('p','Compare the code and requested permissions on both computers.'),button('Review request',()=>window.TLIConnectDevice?window.TLIConnectDevice.open({kind:'computer',requestId:pending[0].request_id}):open({requestId:pending[0].request_id})));
  }
  function open(options={}) {
    if(locked||document.hidden)return;
    embedded=null;onConnected=null;onProgress=null;notified='';
    if(!dialog){
      dialog=n('dialog',null,'peer-pairing-dialog');dialog.id='tli-peer-pairing-dialog';dialog.setAttribute('aria-labelledby','peer-pairing-heading');
      const heading=n('h2','Connect TLI computers');heading.id='peer-pairing-heading';heading.tabIndex=-1;
      status=n('p');status.id='tli-peer-pairing-status';status.setAttribute('role','status');body=n('div',null,'peer-pairing-body');
      const closeButton=n('button','Close','btn btn-outline');closeButton.type='button';closeButton.addEventListener('click',close);
      dialog.append(heading,status,body,closeButton);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});document.body.append(dialog);
    }
    body=dialog.querySelector('.peer-pairing-body');status=dialog.querySelector('#tli-peer-pairing-status');
    configure(options);
    opener=document.activeElement;
    status.textContent='';if(!dialog.open)dialog.showModal();paint();dialog.querySelector('h2').focus();refresh(true);startPolling();
  }
  function configure(options){
    epoch++;busy=false;polling=false;renderKey='';chosenOrigin='';remoteRefreshAt=0;notified='';checks.clear();
    target=typeof options.deviceId==='string'?{deviceId:options.deviceId,name:options.name||null,reviewUpdate:options.reviewUpdate===true,node:options.node===true,
      grants:options.node===true?['inference']:Array.isArray(options.grants)?options.grants.filter(g=>Object.hasOwn(grantNames,g)):[...everyday]}:null;
    selectedId=typeof options.requestId==='string'?options.requestId:null;
  }
  function mount(container,options={},callback,progress){
    dialog?.close();embedded=container;onConnected=callback;onProgress=progress;configure(options);
    body=n('div',null,'peer-pairing-body');status=n('p');status.setAttribute('role','status');status.id='tli-embedded-pairing-status';
    container.replaceChildren(body,status);paint();refresh(true);startPolling();
  }
  function unmount(){epoch++;busy=false;polling=false;renderKey='';checks.clear();embedded?.replaceChildren();embedded=null;onConnected=null;onProgress=null;}
  function close(){unmount();dialog?.close();opener?.focus?.();}
  function startPolling(){if(!timer&&!locked&&!document.hidden)timer=setInterval(()=>refresh(),5000);}
  function install(){
    const anchor=document.querySelector('#panel-mesh .mcd-header');
    if(anchor&&!document.getElementById('tli-peer-pairing-open')){const launcher=button('Connection requests',()=>window.TLIConnectDevice?window.TLIConnectDevice.open({kind:'computer',requests:true}):open());launcher.id='tli-peer-pairing-open';(document.getElementById('tli-connections-advanced')||anchor.parentElement).append(launcher);}
    startPolling();refresh();
  }
  for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event,()=>{locked=true;epoch++;busy=false;requests=[];checks.clear();dialog?.close();body?.replaceChildren();if(status)status.textContent='';document.getElementById('tli-peer-pairing-banner')?.remove();clearInterval(timer);timer=null;});
  window.addEventListener('tli-session-unlocked',()=>{locked=false;epoch++;supported=null;install();});
  window.addEventListener('pagehide',()=>{epoch++;dialog?.close();clearInterval(timer);timer=null;});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){epoch++;busy=false;clearInterval(timer);timer=null;}else{polling=false;startPolling();refresh(true);}});
  window.TLIPeerPairing={open,close,install,mount,unmount,refresh};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
