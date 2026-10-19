/* Local owner network setup. An uncertain confirmation is recovered by receipt,
   never by posting it again. This module performs no automatic restart. */
(() => {
  'use strict';
  const n=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;};
  const local=()=>['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&!/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const localURL=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password?u:null;}catch{return null;}};
  let receiptId=null,receipt=null;
  function mount(container,{record,api,current,onSettled=()=>{}}){
    let preview=null,busy=false,pollCount=0,standaloneRestart=false;
    const button=(text,work)=>{const e=n('button',text);e.type='button';e.className='btn-outline';e.addEventListener('click',()=>{if(!current()||busy)return;Promise.resolve(work(e)).catch(error=>{if(current())result.replaceChildren(n('p',error.message));});});return e;};
    const result=n('div');result.setAttribute('role','status');
    container.append(n('p','Allow your phone to use TLI on your home network.'));
    if(!local()){container.append(n('p','Open TLI in a local desktop browser on the hosting computer to change network setup.'));return;}
    const label=n('label','HTTPS port'),port=n('input');port.type='number';port.min='1';port.max='65535';port.value=String(record?.startup?.effective_next?.port||record?.running?.port||8443);label.append(port);
    const technical=n('details');technical.append(n('summary','Advanced connection settings'),label);container.append(technical);
    function showReceipt(value){
      if(value?.schema_version!==1||value.request_id!==receiptId||!['accepted','applying','completed','failed','uncertain'].includes(value.status)||typeof value.message!=='string')throw Error('The setup receipt was incomplete. Check the saved request before trying again.');
      receipt=value;result.replaceChildren(n('p',value.message));
      const running=value.running||record?.running,settings=value.settings;
      // Matching listener settings cannot prove a live TLS context has loaded a
      // replacement certificate. Keep the explicit repair restart requirement.
      const alreadyRunning=value.action!=='repair_certificate'&&running&&settings&&['host','port','https'].every(key=>running[key]===settings[key]);
      if(value.restart_required&&!alreadyRunning&&!standaloneRestart)result.append(n('p','Restart TLI to finish preparing this computer. After restart, open the reviewed HTTPS address and unlock again. Your setup progress will resume.'),button('Restart TLI and continue',e=>window.TLIHostLifecycle?.open('restart',e)));
      result.append(button('Check saved setup request',()=>checkReceipt()));
      if(value.status==='failed')result.append(n('p','This request will not run again automatically. Read its result before reviewing another change.'));
    }
    async function checkReceipt(id=receiptId){
      const value=await api('/api/network-setup/v1/receipt/'+id);
      if(!current()||receiptId!==id)return;
      showReceipt(value);
      if(['completed','failed'].includes(value.status))onSettled();
      return value;
    }
    function watchReceipt(id){
      if(!current()||receiptId!==id||++pollCount>30)return;
      setTimeout(async()=>{
        if(!current()||receiptId!==id)return;
        try{const value=await api('/api/network-setup/v1/receipt/'+id);if(!current()||receiptId!==id)return;showReceipt(value);
          if(['accepted','applying'].includes(value.status))watchReceipt(id);else if(['completed','failed'].includes(value.status))onSettled();
        }catch(error){if(current())result.append(n('p',error.message+' Use Check saved setup request to read the outcome. Nothing is repeated.'));}
      },1500);
    }
    async function prepare(action,migrate=false){
      busy=true;preview=null;result.replaceChildren(n('p','Preparing a review…'));
      try{
        const value=await api('/api/network-setup/v1/preview',{action,...(action==='prepare'?{port:Number(port.value)}:{}),...(action==='firewall'?{migrate_legacy:migrate}:{})});
        if(!current())return;
        if(typeof value.preview_id!=='string'||value.preview_id.length>160||value.action!==action||!Number.isFinite(value.expires_at)||value.expires_at*1000<=Date.now()||!Array.isArray(value.warnings)||!localURL(value.next_url))throw Error('The host did not return a complete setup review.');
        preview=value;result.replaceChildren(n('h4',action==='prepare'?'Review secure home-network access':action==='repair_certificate'?'Review certificate replacement':'Review Private-network firewall access'),n('p','After restart: '+value.next_url));
        const settings=value.settings;
        if(!settings||typeof settings.host!=='string'||!Number.isInteger(settings.port)||typeof settings.https!=='boolean')throw Error('The reviewed listener settings were incomplete.');
        const facts=n('dl');facts.className='connection-review-facts';const fact=(label,value)=>facts.append(n('dt',label),n('dd',String(value)));
        fact('Listener',`${settings.https?'HTTPS':'HTTP'} · ${settings.host} · TCP ${settings.port}`);
        if(Array.isArray(value.certificate?.names))fact('Certificate names',value.certificate.names.join(', ')||'No names supplied');
        if(action==='firewall'){
          const firewall=value.firewall;
          if(!firewall||typeof firewall.program!=='string'||firewall.profile!=='Private'||firewall.remote_addresses!=='LocalSubnet'||!Array.isArray(firewall.rules)||!firewall.rules.length||firewall.rules.some(rule=>!['TCP','UDP'].includes(rule.protocol)||!Number.isInteger(rule.port)||rule.port<1||rule.port>65535))throw Error('The firewall program, Private-network scope or reviewed ports were incomplete.');
          fact('Program',firewall.program);fact('Network profile',firewall.profile);fact('Remote addresses',firewall.remote_addresses);fact('Allowed inbound ports',firewall.rules.map(rule=>`${rule.protocol} ${rule.port}`).join(', '));
          fact('Older rules',firewall.migrate_legacy?'Replace exactly the older rules listed below':'Keep existing rules unchanged');
          if(firewall.migrate_legacy){if(!Array.isArray(firewall.legacy_rules))throw Error('The reviewed older firewall rules were incomplete.');const list=n('ul');
            for(const rule of firewall.legacy_rules){const row=n('li');row.append(n('strong',rule.display_name||rule.name),n('p',`Rule ID: ${rule.name}; ${rule.direction}; ${rule.action}; enabled ${rule.enabled}; profile ${rule.profile}; ${rule.protocol} ${rule.local_port}; program ${rule.program}; remote ${rule.remote_address}.`));list.append(row);}facts.append(n('dt','Rules to replace'),n('dd',firewall.legacy_rules.length?'':'None'));facts.lastChild.append(list);}
        }
        const factsDetails=n('details');factsDetails.append(n('summary','Review technical details'),facts);result.append(factsDetails);
        value.warnings.forEach(message=>result.append(n('p',String(message))));
        if(value.certificate?.previous_fingerprint)factsDetails.append(n('p','Current certificate: '+value.certificate.previous_fingerprint));
        if(value.certificate?.fingerprint)factsDetails.append(n('p','Reviewed certificate: '+value.certificate.fingerprint));
        if(action==='repair_certificate')result.append(n('p','Replacing the certificate can require phones and computers to review this host again.'));
        result.append(button('Confirm '+(action==='prepare'?'network setup':action==='repair_certificate'?'certificate repair':'firewall change'),async confirm=>{
          if(preview!==value)return;
          if(value.expires_at*1000<=Date.now()){preview=null;result.replaceChildren(n('p','This review expired. Review setup again.'));return;}
          busy=true;confirm.disabled=true;preview=null;
          const bytes=crypto.getRandomValues(new Uint8Array(16)),id=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');receiptId=id;receipt=null;
          try{const data=await api('/api/network-setup/v1/confirm',{preview_id:value.preview_id,request_id:id});if(current()){showReceipt(data);pollCount=0;if(['accepted','applying'].includes(data.status))watchReceipt(id);else onSettled();}}
          catch(error){if(current())result.replaceChildren(n('p',error.message+' The request will not be repeated.'),button('Check saved setup request',()=>checkReceipt(id)));}
          finally{busy=false;}
        }),button('Keep current setup',()=>{preview=null;result.replaceChildren();}));
      }finally{busy=false;}
    }
    const saved=record?.startup?.effective_next;
    if(saved?.https!==true||saved?.host!=='0.0.0.0'||record?.certificate?.status!=='ready')container.append(button('Review secure home-network setup',()=>prepare('prepare')));
    else if(record?.running?.https!==true||record?.running?.host!==saved.host||record?.running?.port!==saved.port){standaloneRestart=true;container.append(n('p','Secure settings are saved. Restart to use them, then unlock again to continue.'),button('Restart TLI and continue',e=>window.TLIHostLifecycle?.open('restart',e)));}
    if(record?.certificate?.status==='repair_required')container.append(button('Review certificate repair',()=>prepare('repair_certificate')));
    if(record?.certificate?.reason)container.append(n('p',record.certificate.reason));
    if(record?.firewall?.reason)container.append(n('p',record.firewall.reason));
    if(record?.firewall?.supported===false)container.append(n('p','In this operating system’s firewall, allow the TLI backend application’s HTTPS TCP port '+port.value+' and discovery UDP ports 5353 and 47474 on your trusted local network only. Keep the backend unelevated. Review these rules locally with your administrator; this flow does not change them.'));
    if(record?.firewall?.supported&&saved?.https===true&&record?.certificate?.status==='ready'){container.append(n('p','If Windows needs permission for phone connections, review access on Private networks and approve its administrator prompt.'),button('Review Windows network access',()=>prepare('firewall')));if(record.firewall.legacy_rules?.length){const advanced=n('details');advanced.append(n('summary','Review older firewall rules'),n('p','Replace TLI’s older broad rules only through a separate explicit review.'),button('Review migration of older rules',()=>prepare('firewall',true)));container.append(advanced);}}
    if(record?.manual_restart)container.append(n('p','This installation may require a normal launcher restart. The restart review will explain what is available.'));
    if(record?.startup?.environment_overrides?.length)container.append(n('p','Startup environment overrides: '+record.startup.environment_overrides.join(', ')+'. Check these if saved settings do not take effect.'));
    container.append(result);
    if(receipt){showReceipt(receipt);if(['accepted','applying'].includes(receipt.status))watchReceipt(receiptId);}
    else if(receiptId){
      result.append(n('p','Reading the saved setup receipt…'));
      void checkReceipt().then(value=>{if(value&&['accepted','applying'].includes(value.status))watchReceipt(receiptId);})
        .catch(error=>{if(current())result.replaceChildren(n('p',error.message),button('Check saved setup request',()=>checkReceipt()));});
    }
  }
  function mountPin(container,{api,current,onStart,onVerified,onSettled}){
    let busy=false,stage='set';const heading=n('h3','Protect this workspace with an owner PIN'),message=n('p'),form=n('div');message.setAttribute('role','status');container.append(heading,n('p','Set a PIN for this home workspace, then unlock this browser to continue. Your PIN is never included in a connection invitation.'),form,message);
    const firstLabel=n('label','New owner PIN'),first=n('input'),secondLabel=n('label','Confirm owner PIN'),second=n('input');
    for(const input of [first,second]){input.type='password';input.minLength=4;input.maxLength=32;input.autocomplete='new-password';}
    first.id='tli-connection-new-pin';second.id='tli-connection-confirm-pin';firstLabel.append(first);secondLabel.append(second);
    const submit=n('button','Set PIN & unlock');submit.type='button';submit.className='btn-primary';const check=n('button','Check PIN status');check.type='button';check.className='btn-outline';check.hidden=true;form.append(firstLabel,secondLabel,submit,check);
    const controls=()=>{first.disabled=second.disabled=submit.disabled=check.disabled=busy;submit.hidden=stage==='unknown';check.hidden=stage!=='unknown';secondLabel.hidden=stage!=='set';firstLabel.firstChild.textContent=stage==='set'?'New owner PIN':'Saved owner PIN';first.autocomplete=stage==='set'?'new-password':'current-password';submit.textContent=stage==='set'?'Set PIN & unlock':'Unlock & continue';};
    check.addEventListener('click',async()=>{if(busy||!current())return;busy=true;controls();try{const state=await api('/system/pin/status');if(typeof state.enabled!=='boolean')throw Error('PIN status could not be confirmed.');stage=state.enabled?'verify':'set';message.textContent=state.enabled?'A PIN is enabled. Enter it to unlock and continue.':'No PIN is enabled. Review a new PIN before submitting.';}catch(error){if(current())message.textContent=error.message;}finally{busy=false;if(current())controls();}});
    submit.addEventListener('click',async()=>{
      if(busy||!current())return;const pin=first.value.trim();
      if(pin.length<4||pin.length>32){message.textContent='Use a PIN with 4–32 characters.';return;}
      if(stage==='set'&&pin!==second.value.trim()){message.textContent='PINs do not match.';return;}
      if(!window.TLIPinLock?.verifyForSetup){message.textContent='Reload the updated host to use PIN setup here.';return;}
      first.value=second.value='';busy=true;controls();onStart();
      try{if(stage==='set'){stage='unknown';const result=await api('/system/pin/set',{pin});if(result.ok!==true)throw Error('Saving the PIN was not confirmed. Check its status before trying again.');stage='verify';}
        if(!current())return;await window.TLIPinLock.verifyForSetup(pin);if(current()){message.textContent='Owner PIN verified. Continuing connection setup…';onVerified();}
      }catch(error){if(current())message.textContent=error.message+(stage==='unknown'?' The save request will not be repeated. Check PIN status first.':'');}
      finally{busy=false;onSettled();if(current())controls();}
    });controls();
  }
  window.TLIConnectionSetup={local,mount,mountPin,receipt:()=>receiptId,result:()=>receipt,resume:id=>{receiptId=/^[a-f0-9]{32,64}$/.test(id||'')?id:null;receipt=null;},suspend:()=>{receipt=null;},clear:()=>{receiptId=receipt=null;}};
})();
