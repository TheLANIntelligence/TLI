/* Portable Vault recovery. Passwords, file selections and reviews stay in memory. */
(() => {
  'use strict';
  const PROTOCOL = 'tli-vault-backup-v1';
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  function init() {
    const mount = document.getElementById('vault-backups-mount');
    if (!mount || mount.dataset.bound) return;
    mount.dataset.bound = '1';
    const state = {caps:null, busy:false, epoch:0, controller:null, vault:'unavailable', locked:false, review:null, download:null, downloadStarted:false};
    const controls = [], passwords = [];
    const root = node('details', '', 'vb-workspace'); root.id = 'vault-backups';
    root.append(node('summary', 'Backup & recovery'));
    const content = node('div', '', 'vb-content'); root.append(content);
    content.append(node('h3', 'Keep a separate, portable copy.'), node('p', 'Shared Vault files and Vault notes, plus this account’s secrets and saved logins. Your archive has its own password.'));
    const scope = node('details', '', 'vb-scope'); scope.append(node('summary', 'What this backup includes'));
    scope.append(node('p', 'Includes shared Vault files and notes, and this account’s secrets and saved logins. Excludes other accounts’ private records, Notes & fixes, chat history, PIN, identity, phone pairings, unlock sessions and browser-extension access. This is not a whole-installation backup.'));
    scope.append(node('p', 'Up to 250 MiB per file, 4 GiB total content and 10,000 entries. Oversized, unsupported or unreadable content stops the backup; it is never silently omitted.'));
    content.append(scope);
    const capability = node('p', 'Review support to begin. Password operations require HTTPS or this host’s loopback address.', 'vb-status'); capability.id='vb-capability'; capability.setAttribute('role','status');
    const toolbar = node('div', '', 'vb-actions');
    function button(id, text, handler, parent, primary=false) {
      const el=node('button',text,primary?'btn-primary':'btn-outline'); el.id=id; el.type='button'; controls.push(el); el.addEventListener('click',handler); parent.append(el); return el;
    }
    const refresh = button('vb-refresh','Review backup support',loadCapabilities,toolbar);
    const stop = button('vb-stop','Stop waiting',()=>invalidate('Stopped waiting. Server work may still finish. Check the destination or browser download before retrying.'),toolbar); stop.hidden=true;
    content.append(toolbar,capability);
    const grid=node('div','','vb-grid'); content.append(grid);
    function card(title,text) { const el=node('section','','vb-card'); el.append(node('h4',title),node('p',text)); grid.append(el); return el; }
    function field(id,label,type,parent) {
      const el=node('input'); el.type=type; el.id=id; el.autocomplete='off'; if(type==='password') {passwords.push(el); el.maxLength=1024;}
      const wrap=node('label','','vb-field'); wrap.htmlFor=id; wrap.append(node('span',label),el); parent.append(wrap); controls.push(el); return el;
    }
    function status(id,parent) {const el=node('p','','vb-status'); el.id=id; el.setAttribute('role','status'); parent.append(el); return el;}
    const checkCard=card('Check Vault','Check whether the scoped Vault content can be read. This does not create or verify a backup. Unlock Vault first.');
    const check=button('vb-check','Check Vault',()=>perform('check'),checkCard);
    const checkResult=status('vb-check-result',checkCard);
    const createCard=card('Create backup','Use a separate archive password. Keep it somewhere safe: TLI cannot recover it. Unlock Vault before creating a backup.');
    const createPassword=field('vb-create-password','New archive password (12+ characters)','password',createCard);
    const createConfirm=field('vb-create-confirm','Confirm archive password','password',createCard);
    const scopeChoice=field('vb-scope-confirm','I reviewed the scope and will keep the archive password.','checkbox',createCard);
    const create=button('vb-create','Create encrypted backup',()=>perform('create'),createCard,true);
    const createResult=status('vb-create-result',createCard);
    const download=node('a','Download prepared archive','btn-primary'); download.id='vb-download'; download.hidden=true; download.download='';
    download.addEventListener('click',event=>{
      if (!state.download || state.downloadStarted || state.locked || state.busy) {event.preventDefault();return;}
      state.downloadStarted=true;
      createResult.textContent='Browser download requested. Check your Downloads folder. TLI cannot confirm that the archive was saved. This one-transfer link does not resume an interrupted download.';
      download.setAttribute('aria-disabled','true');
    });
    createCard.append(download);
    const prepared=button('vb-prepared','Find prepared download',()=>perform('prepared'),createCard);
    createCard.append(node('p','If you left this view or stopped waiting, find an archive that is still waiting to be downloaded. This does not create another backup.','vb-fineprint'));
    const discard=button('vb-discard','Discard prepared download',()=>perform('discard'),createCard); discard.hidden=true;
    const archiveCard=card('Verify backup','Choose a portable .tlivaultbackup archive. Verification reads and authenticates it; it does not restore data.');
    const file=field('vb-file','Portable Vault archive','file',archiveCard); file.accept='.tlivaultbackup';
    const archivePassword=field('vb-archive-password','Archive password','password',archiveCard);
    const verify=button('vb-verify','Verify backup',()=>perform('verify'),archiveCard);
    const verifyResult=status('vb-verify-result',archiveCard);
    const recoverCard=card('Recover into a separate folder','Use the archive selected above. Review a new folder on the TLI host. Recovery never replaces or activates the current Vault.');
    const destination=field('vb-destination','New recovery folder on the TLI host','text',recoverCard); destination.placeholder='Full path to a new, separate folder'; destination.maxLength=2048;
    const review=button('vb-review','Review recovery destination',()=>perform('review'),recoverCard);
    const reviewResult=status('vb-review-result',recoverCard);
    const newPassword=field('vb-new-password','New passphrase for the recovered Vault','password',recoverCard);
    const newConfirm=field('vb-new-confirm','Confirm new Vault passphrase','password',recoverCard);
    const recoverChoice=field('vb-recovery-confirm','Create a separate copy at the reviewed path.','checkbox',recoverCard);
    const recover=button('vb-recover','Create separate recovered Vault',()=>perform('recover'),recoverCard,true);
    const recoverResult=status('vb-recover-result',recoverCard);
    recoverCard.append(node('p','The recovered copy starts locked. Phone pairing, PIN and extension access are not copied. You must keep the new Vault passphrase.','vb-fineprint'));
    const error=status('vb-error',content); error.setAttribute('role','alert');
    mount.append(root);

    const validPassword=value=>typeof value==='string'&&value.length>=12&&value.length<=1024;
    const privateTransport=()=>location.protocol==='https:'||['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname);
    function sync() {
      controls.forEach(el=>{el.disabled=state.busy||state.locked;});
      stop.hidden=!state.busy; stop.disabled=!state.busy;
      const ready=!!state.caps&&!state.busy&&!state.locked&&privateTransport();
      check.disabled=create.disabled=!ready||state.vault!=='unlocked';
      prepared.disabled=check.disabled;
      verify.disabled=!ready;
      review.disabled=!ready||state.caps.recovery_available!==true;
      recover.disabled=review.disabled||!state.review;
      discard.hidden=!state.download; download.hidden=!state.download;
      download.setAttribute('aria-disabled',String(state.busy||state.locked||state.downloadStarted));
    }
    function clearReview() {state.review=null; reviewResult.textContent=''; recoverChoice.checked=false; sync();}
    for(const el of [file,archivePassword,destination]) {el.addEventListener('input',clearReview); el.addEventListener('change',clearReview);}
    function invalidate(message='',clearAll=false) {
      state.epoch++; state.controller?.abort(); state.review=null;
      if(state.activeTarget)state.activeTarget.textContent=state.previousResult||'';
      state.activeTarget=null;
      passwords.forEach(el=>{el.value='';}); file.value=''; destination.value=''; scopeChoice.checked=false; recoverChoice.checked=false;
      state.download=null; state.downloadStarted=false; download.removeAttribute('href');
      reviewResult.textContent='';
      if(clearAll) for(const el of [checkResult,createResult,verifyResult,recoverResult,error]) el.textContent='';
      if(message) error.textContent=message;
      sync();
    }
    async function api(url,options={}) {
      const epoch=state.epoch;
      const response=await fetch(url,{cache:'no-store',credentials:'same-origin',signal:state.controller?.signal,...options});
      if((response.status===401||response.status===403)&&epoch===state.epoch) {
        // Backup calls can discover owner/Vault expiry before the status-only poll.
        // Clear every private view immediately, without claiming that server work stopped.
        if(response.status===401)state.locked=true;
        state.caps=null;state.vault='unavailable';invalidate('',true);
        window.TLIVault?.clear?.();
        capability.textContent='Backup access needs to be checked again.';
        error.textContent='Vault backup access was refused. Private inputs were cleared. Check Vault status or unlock TLI before trying again. No automatic retry was started.';
        throw new Error('Vault backup access was refused.');
      }
      let data; try {data=await response.json();}catch {throw new Error('The host returned an unreadable result. No success was confirmed.');}
      if(!response.ok||data?.ok!==true) throw new Error(typeof data?.detail==='string'?data.detail:'The host did not confirm this operation. Check its result before retrying.');
      return data;
    }
    async function loadCapabilities() {
      if(state.busy||state.locked)return;
      state.busy=true; state.controller=new AbortController(); const epoch=state.epoch; error.textContent=''; sync();
      try {
        const data=await api('/vault/backups/capabilities');
        if(epoch!==state.epoch)return;
        if(data.protocol!==PROTOCOL||!Number.isSafeInteger(data.limits?.archive_bytes)||data.limits.archive_bytes<1||typeof data.recovery_available!=='boolean') throw new Error('This host did not provide compatible Vault backup information.');
        state.caps=data; capability.textContent=!privateTransport()?'Open TLI over HTTPS or on this host’s loopback address before entering archive passwords.':
          'Portable Vault backups are supported. '+(data.recovery_available?'Separate-copy recovery is available.':data.recovery_reason||'Separate-copy recovery is unavailable on this host.');
      }catch(e){if(epoch===state.epoch)error.textContent=e.message;}finally{state.busy=false;state.controller=null;sync();}
    }
    function receipt(data,kind) {
      if(data.protocol!==PROTOCOL||!data.counts||!['file','note','secrets','logins'].every(key=>Number.isSafeInteger(data.counts[key])&&data.counts[key]>=0)||!Number.isFinite(Date.parse(data.checked_at))) throw new Error('The host response did not contain a complete verified result.');
      if(kind!=='check'&&(!['archive_authenticated','all_entries_readable','entry_hashes'].every(key=>data.checks?.[key]===true)||data.restored!==false)) throw new Error('Archive validation was not confirmed.');
      return `${data.counts.file} files · ${data.counts.note} Vault notes · ${data.counts.secrets} secrets · ${data.counts.logins} saved logins. Checked ${new Date(data.checked_at).toLocaleString()}.`;
    }
    async function perform(kind) {
      if(state.busy||state.locked)return;
      error.textContent='';
      const current={file:file.files?.[0],password:archivePassword.value,destination:destination.value.trim(),review:state.review};
      let body,url,method='POST';
      try {
        if(!state.caps)throw new Error('Review backup support first.');
        if(!privateTransport())throw new Error('Use HTTPS or this host’s loopback address for Vault backup operations. No password was sent.');
        if(['check','create','prepared'].includes(kind)&&state.vault!=='unlocked')throw new Error('Unlock Vault before checking content or retrieving a prepared backup.');
        if(kind==='create') {
          if(!validPassword(createPassword.value)||createPassword.value!==createConfirm.value||!scopeChoice.checked)throw new Error('Review the scope and enter matching archive passwords of at least 12 characters.');
          body=JSON.stringify({password:createPassword.value,request_id:crypto.randomUUID()}); url='/vault/backups/create';
        }else if(kind==='check') {body=JSON.stringify({request_id:crypto.randomUUID()});url='/vault/backups/check';}
        else if(kind==='prepared') {url='/vault/backups/prepared';method='GET';}
        else if(kind==='discard') {if(!state.download)return;url=state.download;method='DELETE';}
        else {
          if(!current.file||current.file.size<1||current.file.size>state.caps.limits.archive_bytes||!validPassword(current.password))throw new Error('Choose a bounded portable Vault archive and enter its archive password (12+ characters).');
          body=new FormData(); body.append('file',current.file);body.append('password',current.password);body.append('request_id',crypto.randomUUID());
          url='/vault/backups/'+(kind==='verify'?'verify':'recovery/'+(kind==='review'?'review':'create'));
          if(kind!=='verify') {if(!state.caps.recovery_available||!current.destination)throw new Error('Choose a new recovery folder on a host that supports separate-copy recovery.');body.append('destination',current.destination);}
          if(kind==='recover') {
            if(!current.review||!recoverChoice.checked||!validPassword(newPassword.value)||newPassword.value!==newConfirm.value)throw new Error('Review the destination, confirm the separate copy and enter matching new Vault passphrases of at least 12 characters.');
            body.append('review_token',current.review);body.append('new_vault_password',newPassword.value);
          }
        }
      }catch(e){error.textContent=e.message;return;}
      state.busy=true;state.controller=new AbortController();const epoch=state.epoch;sync();
      const target={check:checkResult,create:createResult,prepared:createResult,verify:verifyResult,review:reviewResult,recover:recoverResult,discard:createResult}[kind];
      const previous=target.textContent;
      state.activeTarget=target;state.previousResult=previous;
      target.textContent='Working… Previous results are retained if this request fails.';
      try {
        const data=await api(url,{method,body,...(typeof body==='string'?{headers:{'Content-Type':'application/json'}}:{})});
        if(epoch!==state.epoch)return;
        if(kind==='discard') {if(data.discarded!==true)throw new Error('Discard was not confirmed.');state.download=null;download.removeAttribute('href');target.textContent='Prepared download discarded. Existing saved archives are unchanged.';return;}
        if(kind==='prepared') {
          if(data.protocol!==PROTOCOL||typeof data.prepared!=='boolean')throw new Error('The prepared download could not be checked.');
          if(!data.prepared){state.download=null;download.removeAttribute('href');target.textContent='No prepared download is waiting on this host. Previously saved archives are unchanged.';return;}
        }
        const summary=receipt(data,kind);
        if(kind==='create'||kind==='prepared') {
          if(typeof data.download_url!=='string'||!/^\/vault\/backups\/download\/[A-Za-z0-9_-]{30,80}$/.test(data.download_url)||data.downloaded!==false)throw new Error('The host did not provide a valid prepared download.');
          state.download=data.download_url;state.downloadStarted=false;download.href=data.download_url;
          target.textContent='Encrypted archive prepared. '+summary+' Download before its ten-minute preparation window expires. This view has not confirmed a saved copy on your device.';
          createPassword.value=createConfirm.value='';scopeChoice.checked=false;
        }else if(kind==='verify') target.textContent='Archive authenticated and checked. '+summary+' No data was restored.';
        else if(kind==='review') {
          if(typeof data.review_token!=='string'||data.review_token.length<20||typeof data.destination!=='string')throw new Error('The recovery review was incomplete.');
          state.review=data.review_token;destination.value=data.destination;
          target.textContent='Reviewed destination: '+data.destination+'. '+summary+' No folder has been created. The recovered local owner will receive this archive’s scoped content.';
        }else if(kind==='recover') {
          if(data.created!==true||data.restored!==false||data.readback?.ok!==true||data.readback?.reader!=='current-application'||!['passphrase_authenticated','current_readers','exact_content','owner_mapping','locked_without_sessions','files_unchanged'].every(key=>data.readback?.checks?.[key]===true)||typeof data.destination!=='string')throw new Error('Creation and current-application verification were not both confirmed. Check the reviewed destination before retrying.');
          target.textContent='Separate Vault created and reopened successfully by the current application at '+data.destination+'. '+summary+' It starts locked. Your current installation was not replaced or activated.';
          clearReview();newPassword.value=newConfirm.value=archivePassword.value='';file.value='';
        }else {if(data.checked!==true||data.source_unchanged!==true)throw new Error('The source-content check was not confirmed.');target.textContent='Scoped Vault content can be read. '+summary+' No backup was created.';}
      }catch(e){if(epoch===state.epoch){target.textContent=previous;error.textContent=e.message+' Previous results are unchanged. No automatic retry was started.';if(kind==='recover')clearReview();}}
      finally{state.busy=false;state.controller=null;state.activeTarget=null;sync();}
    }
    root.addEventListener('toggle',()=>{if(root.open&&!state.caps)loadCapabilities();});
    window.addEventListener('tli-vault-state-changed',event=>{const next=event.detail?.state||'unavailable';if(next!==state.vault&&next!=='unlocked')invalidate('',true);state.vault=next;sync();});
    window.addEventListener('tli-session-locked',()=>{state.locked=true;state.caps=null;invalidate('',true);});
    window.addEventListener('tli-session-unlocked',()=>{state.locked=false;sync();});
    window.addEventListener('pagehide',()=>invalidate('',true));
    document.addEventListener('visibilitychange',()=>{if(document.hidden)invalidate('',true);});
    document.addEventListener('tli-panel-switched',event=>{if(event.detail?.panelId!=='panel-vault')invalidate('',true);});
    sync();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
