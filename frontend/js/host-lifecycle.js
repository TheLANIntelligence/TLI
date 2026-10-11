/* Reviewed lifecycle control for the local TLI host. Never replay a command. */
(() => {
  'use strict';
  const base = '/api/host-control/v1/lifecycle';
  const $ = id => document.getElementById(id);
  const state = {initialized:false,locked:false,epoch:0,action:null,opener:null,preview:null,command:null,pending:null,timer:null,pollUntil:0,polls:0};
  const ids = ['tli-host-menu-restart','tli-host-menu-quit','tli-host-settings-restart','tli-host-settings-quit'];
  const dialog = () => $('tli-host-lifecycle-dialog');
  const set = (id,value) => {if($(id))$(id).textContent=value;};
  const identity = value => typeof value==='string' && value.length>0 && value.length<=160 && !/[\x00-\x20\x7f]/.test(value);
  const localURL = value => {try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname.toLowerCase())&&!url.username&&!url.password&&!url.hash?url:null;}catch{return null;}};
  const localDesktop = () => !!localURL(window.location.href) && navigator.userAgentData?.mobile!==true && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent||'');
  const validIdentity = value => value?.schema_version===1 && identity(value.instance_id) && identity(value.installation_id);
  const fresh = ticket => ticket===state.epoch && !state.locked;
  const active = ticket => fresh(ticket) && dialog()?.open && !document.hidden;
  const text = message => set('tli-host-lifecycle-status',message);
  function stopPolling(){clearTimeout(state.timer);state.timer=null;}
  function cancelRequest(){state.pending?.abort();state.pending=null;}
  function controls(){
    const restricted=state.locked||!localDesktop();
    for(const id of [...ids,'tli-release-restart','settings-release-restart'])if($(id))$(id).disabled=restricted;
    const review=state.preview;
    $('tli-host-lifecycle-confirm').disabled=restricted||!!state.pending||!!state.command||!review||review.expires_at*1000<=Date.now();
    $('tli-host-lifecycle-confirm').hidden=!!state.command;
    $('tli-host-lifecycle-check').disabled=restricted||!!state.pending;
    $('tli-host-lifecycle-cancel').textContent=state.command?'Close':'Keep TLI running';
  }
  async function request(path,method='GET',body){
    const controller=new AbortController();state.pending=controller;controls();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(base+path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
      let data;try{data=await response.json();}catch{throw Error('The host returned an unreadable response.');}
      if(!response.ok){const error=Error(typeof data?.detail==='string'?data.detail:`The request was rejected (${response.status}).`);error.status=response.status;throw error;}
      return data;
    }finally{clearTimeout(timeout);if(state.pending===controller)state.pending=null;controls();}
  }
  function showCommand(){
    const command=state.command;if(!command)return;
    set('tli-host-lifecycle-title',command.action==='restart'?'Restart TLI':'Quit TLI');
    $('tli-host-lifecycle-check').hidden=false;
    $('tli-host-lifecycle-check').textContent='Check connection';
    $('tli-host-lifecycle-reload').hidden=!(command.status==='completed'||command.status==='accepted'&&command.action==='restart'&&new URL(command.next_url).origin!==window.location.origin);
    set('tli-host-lifecycle-reload',new URL(command.next_url).origin===window.location.origin?'Reload TLI':'Open TLI');
    if(command.status==='completed')text('TLI restarted and the new host process is responding. Reload TLI to reconnect; enter your PIN if asked.');
    else if(command.status==='failed')text((command.action==='restart'?'Restart':'Quit')+' failed: '+command.message+' This command will not be sent again.');
    else if(command.status==='accepted')text(command.action==='restart'?(new URL(command.next_url).origin===window.location.origin?'Restart was accepted. Waiting for the new TLI process to respond…':'Restart was accepted. Choose Open TLI to reconnect at the reviewed address. No connection checks or credentials are sent to that other address automatically.'):'Quit was accepted. TLI is stopping; this acknowledgement does not prove that it has finished. You can close this page and start TLI again with its launcher when needed.');
    else text('The command response was not confirmed. TLI may already be '+(command.action==='restart'?'restarting':'stopping')+'. Check the connection before taking another action. This command will not be sent again.');
    controls();
  }
  async function review(){
    if(state.pending||state.command||state.locked||!localDesktop())return;
    const ticket=state.epoch,action=state.action;state.preview=null;controls();text('Checking this computer’s application controls…');
    $('tli-host-lifecycle-check').hidden=true;
    try{
      const capability=await request('');if(!active(ticket))return;
      if(!validIdentity(capability)||typeof capability.available!=='boolean'||typeof capability.capabilities?.restart!=='boolean'||typeof capability.capabilities?.quit!=='boolean')throw Error('This TLI host did not confirm compatible application controls.');
      if(!capability.available||capability.capabilities[action]!==true)throw Error(typeof capability.reason==='string'?capability.reason:'This action is unavailable for the running host.');
      const preview=await request('/preview','POST',{action});if(!active(ticket))return;
      if(!validIdentity(preview)||preview.instance_id!==capability.instance_id||preview.installation_id!==capability.installation_id||!identity(preview.preview_id)||preview.action!==action||!Number.isFinite(preview.expires_at)||preview.expires_at*1000<=Date.now()||!localURL(preview.current_url)||!localURL(preview.next_url)||!Array.isArray(preview.consequences)||preview.consequences.length>20||preview.consequences.some(item=>typeof item!=='string'||item.length>2000))throw Error('The host did not confirm a valid review for this action. Nothing was requested to stop.');
      state.preview=preview;
      set('tli-host-lifecycle-destination',action==='restart'?`Current address: ${preview.current_url}. After restart: ${preview.next_url}.`:`Current address: ${preview.current_url}. Use the TLI launcher to start it again.`);
      if(preview.consequences.length)set('tli-host-lifecycle-warning','Active chats, scans and other work will be interrupted. Connected phones and other browsers will disconnect. '+preview.consequences.join(' '));
      text('Review this action, then choose '+(action==='restart'?'Restart TLI':'Quit TLI')+'.');
    }catch(error){if(active(ticket)){state.preview=null;text(error.status===404?'This running version does not have in-app restart controls yet. Finish active work, open TLI_Setup.bat, choose 9 — Stop TLI, confirm STOP, then open the TLI shortcut and refresh this page. This one-time restart loads the updated controls. No stop or restart command was sent.':error.status===401?'Unlock TLI before reviewing application controls.':error.message);$('tli-host-lifecycle-check').hidden=false;$('tli-host-lifecycle-check').textContent='Refresh review';}}
    finally{if(fresh(ticket))controls();}
  }
  function requestId(){if(window.crypto?.randomUUID)return window.crypto.randomUUID().replace(/-/g,'');if(!window.crypto?.getRandomValues)throw Error('Secure request identifiers are unavailable.');const bytes=new Uint8Array(16);window.crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
  async function confirm(){
    const preview=state.preview;if(state.command||state.pending||state.locked||!localDesktop()||!dialog().open||document.hidden||!preview)return;
    if(preview.expires_at*1000<=Date.now()){state.preview=null;controls();text('This review expired. Refresh the review before continuing.');$('tli-host-lifecycle-check').hidden=false;$('tli-host-lifecycle-check').textContent='Refresh review';return;}
    let id;try{id=requestId();}catch(error){text(error.message);return;}
    const ticket=state.epoch;state.command={action:preview.action,request_id:id,instance_id:preview.instance_id,installation_id:preview.installation_id,next_url:preview.next_url,status:'uncertain'};state.preview=null;
    controls();text('Sending the confirmed '+preview.action+' request…');
    try{
      const result=await request('/confirm','POST',{preview_id:preview.preview_id,request_id:id});
      if(!fresh(ticket))return;
      if(result?.schema_version!==1||result.request_id!==id||result.action!==preview.action||!['accepted','stopping','restarting'].includes(result.status))throw Error('The host did not confirm this command receipt.');
      state.command.status='accepted';showCommand();
      if(preview.action==='restart'&&new URL(preview.next_url).origin===window.location.origin&&dialog().open&&!document.hidden){state.pollUntil=Date.now()+90000;state.polls=0;schedulePoll();}
    }catch(error){if(fresh(ticket)){
      if([400,401,403,404,409,410,422].includes(error.status)){state.command=null;state.preview=null;controls();text(error.message+' The request was rejected; no retry ran.');$('tli-host-lifecycle-check').hidden=false;$('tli-host-lifecycle-check').textContent='Refresh review';}
      else showCommand();
    }}
  }
  function schedulePoll(){
    stopPolling();if(!dialog().open||state.locked||document.hidden||state.command?.status!=='accepted'||state.command.action!=='restart')return;
    if(Date.now()>=state.pollUntil||state.polls>=45){text('Restart was accepted, but the new process has not been confirmed yet. Check the connection when ready, or open TLI with its launcher. No command was repeated.');return;}
    state.timer=setTimeout(()=>checkConnection(true),state.polls?2000:1000);
  }
  async function checkConnection(automatic=false){
    if(state.pending||state.locked||document.hidden||!dialog().open||!localDesktop())return;
    if(!state.command)return review();
    stopPolling();const command=state.command,ticket=state.epoch;
    if(new URL(command.next_url).origin!==window.location.origin){text('The reviewed restart address differs from this page. Choose Open TLI to reconnect there. No credentials or checks are sent to the other address automatically.');$('tli-host-lifecycle-reload').hidden=false;return;}
    if(automatic)state.polls++;
    try{
      const ready=await request('/ready');if(!active(ticket)||state.command!==command)return;
      if(!validIdentity(ready)||ready.installation_id!==command.installation_id)throw Error('The responding installation could not be matched to this review.');
      if(command.action==='restart'&&ready.instance_id!==command.instance_id){command.status='completed';showCommand();return;}
      if(ready.instance_id===command.instance_id){
        // Read receipts only from the reviewed process: a restarted host has lost the old PIN session.
        try{
          const receipt=await request('/receipt/'+encodeURIComponent(command.request_id));if(!active(ticket)||state.command!==command)return;
          if(receipt?.schema_version===1&&receipt.request_id===command.request_id&&receipt.action===command.action&&receipt.status==='failed'){
            command.status='failed';command.message=typeof receipt.message==='string'&&receipt.message.trim()&&receipt.message.length<=4000?receipt.message:'The host could not complete the requested action.';showCommand();return;
          }
        }catch{if(!active(ticket)||state.command!==command)return;}
      }
      if(command.status==='failed'){showCommand();return;}
      text(command.action==='restart'?'The original TLI process is still responding. Waiting for a new process; the command will not be repeated.':'TLI is still responding. Quit completion has not been confirmed. The command will not be repeated.');
    }catch(error){if(active(ticket))text('TLI is not confirmed reachable at this address. A lost connection alone does not prove it stopped. '+(command.action==='restart'?'Waiting for the new process, or check again when ready.':'Start it again with the TLI launcher when needed.')+' No command was repeated.');}
    finally{if(active(ticket)&&automatic&&state.command?.status==='accepted')schedulePoll();}
  }
  function open(action,opener){
    if(!['restart','quit'].includes(action)||state.locked||!localDesktop())return;
    if(dialog().open)return;
    stopPolling();cancelRequest();state.epoch++;state.opener=opener?.id?.startsWith('tli-host-menu-')?$('tli-device-trigger'):opener;state.action=action;state.preview=null;
    if(state.command?.status==='completed')state.command=null;
    if(state.command){action=state.command.action;state.action=action;}
    set('tli-host-lifecycle-title',action==='restart'?'Restart TLI?':'Quit TLI?');
    set('tli-host-lifecycle-description',action==='restart'?'Restart the TLI application on this computer using its saved startup settings. Your computer will stay on.':'Stop the TLI application on this computer. Closing only the browser leaves the host running for phones and background work.');
    set('tli-host-lifecycle-warning','Active chats, scans and other work will be interrupted. Connected phones and other browsers will disconnect. Finish any work you want to keep before continuing.');
    set('tli-host-lifecycle-destination','');set('tli-host-lifecycle-confirm',action==='restart'?'Restart TLI':'Quit TLI');
    $('tli-host-lifecycle-reload').hidden=true;$('tli-host-lifecycle-check').hidden=true;
    dialog().showModal();$('tli-host-lifecycle-cancel').focus();controls();
    if(state.command)showCommand();else review();
  }
  function init(){
    if(state.initialized||!dialog())return;state.initialized=true;state.locked=window.TLIHostIdentity?.get?.().status==='locked';
    for(const id of ids)$(id)?.addEventListener('click',event=>open(event.currentTarget.dataset.hostLifecycle,event.currentTarget));
    $('tli-host-lifecycle-cancel').addEventListener('click',()=>dialog().close());
    $('tli-host-lifecycle-confirm').addEventListener('click',confirm);
    $('tli-host-lifecycle-check').addEventListener('click',()=>checkConnection());
    $('tli-host-lifecycle-reload').addEventListener('click',()=>{if(state.locked||!state.command||!localURL(state.command.next_url))return;stopPolling();window.location.assign(state.command.next_url);});
    dialog().addEventListener('close',()=>{state.epoch++;stopPolling();cancelRequest();state.preview=null;if(!state.locked&&state.opener?.isConnected)state.opener.focus({preventScroll:true});});
    window.addEventListener('tli-session-locked',()=>{state.locked=true;state.epoch++;stopPolling();cancelRequest();state.preview=null;if(dialog().open)dialog().close();controls();});
    window.addEventListener('tli-session-unlocked',()=>{state.locked=false;controls();});
    window.addEventListener('pagehide',()=>{state.epoch++;stopPolling();cancelRequest();state.preview=null;});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPolling();if(state.pending){state.epoch++;cancelRequest();state.preview=null;controls();}}else if(dialog().open&&state.command?.status==='accepted')schedulePoll();else if(dialog().open&&!state.command&&!state.preview){text('The review was interrupted. Refresh it before continuing.');$('tli-host-lifecycle-check').hidden=false;$('tli-host-lifecycle-check').textContent='Refresh review';}});
    set('tli-host-lifecycle-help',localDesktop()?'Review either action here or in the Device menu. No action runs until you confirm.':'Restart and quit are available only from a local desktop browser on the computer hosting TLI. Remote browsers and phones cannot use these controls.');
    controls();window.TLIHostLifecycle={open};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
