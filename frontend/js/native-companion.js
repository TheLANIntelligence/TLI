/* Native companion pairing uses a separate, owner-authenticated identity. */
(() => {
  'use strict';
  const base = '/api/companion/v1';
  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  async function api(path, method = 'GET', body, signal) {
    let response;
    const controller = signal ? null : new AbortController();
    const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      response = await fetch(path.startsWith('/api/host-control/v1/') ? path : base + path, { method, cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || controller.signal });
    } catch (_) {
      throw new Error('TLI could not be reached. Check that the host is running and this browser can open its address. For HTTPS, resolve any certificate warning on the host before reconnecting.');
    } finally { if (timeout !== null) clearTimeout(timeout); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      let message = typeof result?.detail === 'string' ? result.detail : `Request failed (${response.status}).`;
      if (response.status === 401) message = 'Unlock TLI with your owner PIN, then refresh this section.';
      else if (response.status === 404 && ['/startup', '/setup'].includes(path)) {
        message = `The running TLI server does not provide ${path === '/startup' ? 'connection settings' : 'phone pairing setup'}. On the host computer, check that you are using the matching TLI installation. If its files were updated, stop and start TLI normally. Refreshing this page alone cannot add this feature.`;
      } else if (response.status === 403) {
        message += /https/i.test(message) ? ' Open TLI using its HTTPS address before trying again.' : ' Use the TLI browser page on the host, unlocked with its owner PIN.';
      }
      const error = new Error(message);
      error.status = response.status; throw error;
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('TLI returned an incomplete response. Refresh before trying again.');
    return result;
  }
  function hostStartControls() {
    let epoch = 0, pending = null, active = false;
    const section = node('section', null, 'native-companion-step native-companion-host-start'); section.id = 'native-companion-host-start';
    section.append(node('h3', 'Start TLI from your phone'), node('p', 'Use a compatible Companion app while this Windows computer stays awake and signed in. Host Start cannot wake or power on the computer.'));
    const status = node('p', 'Host Start has not been checked.', 'native-companion-status'); status.id = 'native-host-start-status'; status.setAttribute('role', 'status');
    const address = node('p', null, 'native-companion-address'); address.id = 'native-host-start-address'; address.hidden = true;
    const connection = node('details', null, 'native-host-start-disclosure'); connection.id = 'native-host-start-connection'; connection.hidden = true; connection.open = false;
    const connectionSummary = node('summary', 'Connection details'); connectionSummary.id = 'native-host-start-connection-summary';
    const details = node('div'); details.id = 'native-host-start-details';
    connection.append(connectionSummary, details);
    const button = node('button', 'Check Host Start setup', 'btn-outline'); button.id = 'native-host-start-check'; button.type = 'button';
    const setup = node('details', null, 'native-host-start-disclosure'); setup.id = 'native-host-start-setup'; setup.open = false;
    const setupSummary = node('summary', 'Set up on this computer'); setupSummary.id = 'native-host-start-setup-summary';
    const guide = node('ol');
    for (const text of ['On this computer, open its TLI installation folder and run TLI_Setup.bat. Choose Enable phone host start. Review the separate HTTPS helper port and local startup behavior before confirming.', 'Keep the same owner PIN and reviewed certificate. Use the setup tool to start the helper, then return here to check the saved configuration.', 'While TLI is online, open Settings in a compatible installed Companion app. Choose Review Host Start setup, check the helper address, and allow this phone. The restricted credential is saved in protected phone storage.', 'When TLI is unavailable, use Check helper status on the phone. Start TLI appears only when the verified helper confirms TLI is stopped. After a start request, check the paired TLI connection for readiness.']) guide.append(node('li', text));
    const limits = node('p', 'The helper runs under the signed-in Windows user; enabling it is a separate local setup action. This page does not install or start it. Away from home, the private-network route must allow the exact helper port as well as TLI’s port. Removing a paired phone or changing the owner PIN also ends its helper access.', 'native-companion-help');
    const instructions = node('div'); instructions.id = 'native-host-start-instructions';
    setup.append(setupSummary, guide, instructions, limits);
    section.append(status, address, button, connection, setup);
    function clearDetails() { address.textContent = ''; address.hidden = true; connection.open = false; connection.hidden = true; details.replaceChildren(); instructions.replaceChildren(); }
    button.addEventListener('click', async () => {
      if (pending || document.hidden || !active) return;
      const ticket = epoch, controller = new AbortController(); pending = controller; button.disabled = true; status.textContent = 'Reading this computer’s saved Host Start setup…';
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const value = await api('/api/host-control/v1/setup', 'GET', undefined, controller.signal);
        if (ticket !== epoch || document.hidden) return;
        const d = value.host_control;
        if (value.schema_version !== 1 || value.setup_command !== 'TLI_Setup.ps1' || !Array.isArray(value.instructions) || value.instructions.length > 20 || !value.instructions.every(item => typeof item === 'string' && item.length <= 1500) || !d || d.schema_version !== 1 || typeof d.enabled !== 'boolean' || typeof d.available !== 'boolean' || typeof d.reason !== 'string' || d.reason.length > 1500 || d.available && !d.enabled) throw new Error('TLI did not provide complete Host Start setup details. Check the matching installation on this computer.');
        if (d.enabled && (!/^https:\/\/(?:[0-9]+\.){3}[0-9]+(?::[0-9]+)?$/.test(d.origin || '') || typeof d.helper_id !== 'string' || typeof d.node_id !== 'string' || !/^[a-fA-F0-9]{64}$/.test(d.certificate_sha256 || '') || d.capabilities?.start_backend !== true || d.capabilities?.wake_host !== false)) throw new Error('The helper identity or secure address was incomplete. It was not marked ready.');
        status.textContent = d.enabled ? 'Saved helper configuration. Listener availability has not been checked from this browser.' : 'Host Start is not enabled. Open Set up on this computer to get started.';
        clearDetails();
        if (d.enabled) {
          address.textContent = 'Helper: ' + d.origin; address.hidden = false; connection.hidden = false;
          details.append(node('p', d.reason, 'native-companion-help'));
          for (const [label, text] of [['Computer identity', d.node_id], ['Helper identity', d.helper_id], ['Certificate fingerprint', d.certificate_sha256]]) details.append(node('strong', label), node('p', text, 'native-companion-address'));
        } else instructions.append(node('p', d.reason));
        const list = node('ul'); value.instructions.forEach(text => list.append(node('li', text))); instructions.append(list);
      } catch (error) {
        if (ticket === epoch && !document.hidden) { clearDetails(); status.textContent = error.status === 404 ? 'This running TLI version does not provide Host Start setup. Use matching updated TLI files and restart normally before reviewing this optional feature.' : error.message; }
      } finally { clearTimeout(timeout); if (pending === controller) pending = null; if (ticket === epoch) button.disabled = false; }
    });
    function clear() { epoch++; active = false; pending?.abort(); pending = null; clearDetails(); setup.open = false; status.textContent = 'Check Host Start setup after unlocking this TLI.'; button.disabled = true; }
    return { section, clear, activate() { active = true; button.disabled = false; } };
  }
  function start() {
    const panel = document.getElementById('panel-companion');
    if (!panel) return;
    const section = document.getElementById('native-companion-settings') || node('section');
    if (section.dataset.companionBound) return;
    section.id = 'native-companion-settings'; section.className = 'native-companion'; section.dataset.companionBound = '1';
    const body = node('div', null, 'native-companion-body');
    const state = {active:false, locked:false, epoch:0, setup:null, checkedAt:null, selectedOrigin:'', devices:null, devicesCheckedAt:null, loading:null, mutation:null, remoteReceipt:null, remotePhase:'unknown',flowPrepared:true};
    const requests = new Set(); let expiryTimer = null;
    const hostStart = hostStartControls();
    const header = node('div', null, 'native-companion-overview');
    const intro = node('div', null, 'native-companion-intro');
    intro.append(node('span', 'TLI ON ANDROID · PRIVATE BETA', 'native-companion-eyebrow'), node('h2', 'Your personal AI, on your phone.'),
      node('p', 'Ask questions, write, learn and continue your conversations from your phone. This computer keeps your workspace and needs to stay on.'));
    const refresh = node('button', 'Refresh connection setup', 'btn-outline'); refresh.type='button'; refresh.id='native-companion-refresh';
    header.append(intro, refresh);
    const status=node('p','Open this page to check the connection.','native-companion-status'); status.id='native-companion-status'; status.setAttribute('role','status');
    const steps=node('ol',null,'native-companion-steps'); steps.setAttribute('aria-label','Phone connection steps');
    const content=node('div',null,'native-companion-sections'); const blocks={};
    for (const [index, key, title, hint] of [[0,'access','Owner access','Protect your workspace'],[1,'connection','Prepare this computer','Only the setup you need'],[2,'install','Install the Android app','Get the current beta'],[3,'pair','Scan and connect','Use the scanner in TLI'],[4,'chat','Start chatting','Continue on your phone'],[0,'devices','Saved phone access','Review or remove access']]) {
      const item=node('li'), button=node('button',null,'native-companion-step-link');button.type='button';button.dataset.companionStep=key;
      button.append(node('span',String(index),'native-companion-step-number'),node('strong',title),node('span',hint));
      button.addEventListener('click',()=>focusStep(key));item.append(button);if(index)steps.append(item);
      const block=node('section',null,'native-companion-step');block.id='native-companion-step-'+key;
      const heading=node('h3',index?index+' · '+title:title);heading.tabIndex=-1;heading.id=block.id+'-title';block.setAttribute('aria-labelledby',heading.id);
      const badge=node('span','Not checked','native-companion-step-status');badge.dataset.state='unknown';badge.id='native-companion-'+key+'-state';
      const head=node('div',null,'native-companion-step-head');head.append(heading,badge);block.append(head);content.append(block);blocks[key]={block,heading,badge};
    }
    const accessCopy=node('p','TLI’s owner PIN protects pairing and phone access.');accessCopy.id='native-companion-access-copy';
    const accessButton=node('button','Open access settings','btn-outline');accessButton.type='button';accessButton.id='native-companion-open-access';
    accessButton.addEventListener('click',()=>{
      if(state.locked&&window.TLIPinLock?.showRecovery){window.TLIPinLock.showRecovery('Unlock TLI with your owner PIN to connect a phone.');return;}
      window.TLIConnectDevice?.close?.();
      if(typeof window.switchPanel==='function')window.switchPanel('panel-settings');
      window.TLISettingsWorkspace?.open?.('access','settings-section-security');
    });
    blocks.access.block.append(accessCopy,accessButton);
    const connectionCopy=node('p','HTTPS, a reachable LAN address and a matching certificate are checked here.');connectionCopy.id='native-companion-connection-copy';
    const originText=node('p','Current browser: '+(window.location?.origin||'Address unavailable'),'native-companion-address');
    const prepare=node('button','Prepare this computer','btn-primary');prepare.type='button';prepare.id='native-companion-prepare';prepare.addEventListener('click',()=>window.TLIConnectDevice?.open({kind:'phone'}));
    blocks.connection.block.append(connectionCopy,prepare);
    const downloadURL='https://thelanintelligence.com/download/#android';
    const installLayout=node('div',null,'native-companion-install-layout'),installCopy=node('div');
    const download=node('a','Get TLI for Android','btn-primary');download.id='native-companion-download';download.href=downloadURL;download.target='_blank';download.rel='noopener noreferrer';
    const installQR=node('img');installQR.id='native-companion-install-qr';installQR.src='/assets/companion-install.svg';installQR.alt='Public Android download link. Scan with your phone camera to get TLI.';installQR.width=180;installQR.height=180;
    const installed=node('button','I have the Android app','btn-outline');installed.type='button';installed.id='native-companion-installed';
    let appInstalled=false,chatOpened=false;
    const installStatus=node('p','Scan this public download code with your phone camera. It opens the download page; it does not pair your phone.','native-companion-help');
    installCopy.append(node('p','Install the current TLI Android beta on your phone, then return here. Keep your phone and this computer on the same home network.'),download,installStatus,installed);
    installLayout.append(installQR,installCopy);blocks.install.block.append(installLayout);
    const installAgain=node('button','Show app download','btn-outline');installAgain.type='button';installAgain.id='native-companion-install-again';installAgain.hidden=true;
    blocks.install.block.append(installAgain);
    installed.addEventListener('click',()=>{if(!current(state.epoch))return;appInstalled=true;paintFlow();focusStep('pair');});
    installAgain.addEventListener('click',()=>{appInstalled=false;paintFlow();focusStep('install');});
    const pairCopy=node('p','In the Android app, choose Scan pairing QR. Scan the private code below, review this computer’s name, then confirm on your phone.');
    const controls=node('div',null,'native-companion-controls');
    const label=node('label','TLI’s address on your home network'),select=node('select');select.id='native-companion-origin';select.setAttribute('aria-label','TLI LAN address');label.append(select);
    const generate=node('button','Create pairing QR','btn-primary');generate.type='button';generate.id='native-companion-generate';generate.disabled=true;
    const addressDetails=node('details',null,'native-companion-address-details');addressDetails.id='native-companion-address-details';addressDetails.append(node('summary','Connection address and alternatives'),label,originText);
    controls.append(generate);
    const addressHelp=node('p','Choose the Ethernet or Wi-Fi address on the same network as your phone. Virtual-machine and disconnected-adapter addresses may not be reachable from your phone.','native-companion-help');addressHelp.id='native-companion-address-help';select.setAttribute('aria-describedby',addressHelp.id);
    const pairing=node('div',null,'native-companion-pairing');pairing.id='native-companion-pairing';pairing.hidden=true;
    const pairNotice=node('p','Complete the owner and connection checks before creating a code.','native-companion-help');pairNotice.id='native-companion-pair-status';pairNotice.setAttribute('role','status');
    const inviteHelp=node('p','Codes are single use and expire after five minutes. Hiding a code or leaving this page does not revoke its invitation.','native-companion-help');
    addressDetails.append(addressHelp);
    blocks.pair.block.append(pairCopy,controls,pairNotice,pairing,inviteHelp,addressDetails);
    const scanDone=node('button','I have scanned the code','btn-outline');scanDone.id='native-companion-scan-done';scanDone.type='button';scanDone.hidden=true;blocks.pair.block.append(scanDone);
    scanDone.addEventListener('click',()=>{if(!current(state.epoch))return;chatOpened=true;paintFlow();focusStep('chat');});
    blocks.chat.block.append(node('p','Once the app confirms your connection, open Chat on your phone. Start a new conversation or continue one from this computer.'),node('p','Try “Help me plan my week” or “Explain something I’m learning.” Photos, documents and saved notes are there when you need them.'));
    const chatStatus=node('p','Your phone checks its connection and AI availability. A saved phone below confirms access was granted; it does not mean the phone is online.','native-companion-help');chatStatus.id='native-companion-chat-status';blocks.chat.block.append(chatStatus);
    const checkPhones=node('button','Refresh saved phone access','btn-outline');checkPhones.type='button';checkPhones.id='native-companion-check-phones';checkPhones.addEventListener('click',()=>current(state.epoch)?loadDevices(state.epoch):undefined);blocks.chat.block.append(checkPhones);
    const devicesNotice=node('p','Paired phones have not been checked.','native-companion-help');devicesNotice.id='native-companion-devices-status';devicesNotice.setAttribute('role','status');
    const devices=node('div',null,'native-companion-devices');devices.id='native-companion-devices';
    blocks.devices.block.append(node('p','Removing access disconnects that phone from this host. It must pair again to reconnect.'),devicesNotice,devices);
    const remote=node('details',null,'native-companion-remote');remote.id='native-companion-remote';
    const remoteSummary=node('summary','Away from home · optional private network');remoteSummary.id='native-companion-remote-summary';
    const remoteBody=node('div',null,'native-companion-remote-body');
    const remoteStatus=node('p','Host setup has not been checked. Remote path: not tested.','native-companion-status');remoteStatus.id='native-companion-remote-status';remoteStatus.setAttribute('role','status');
    const remotePlan=node('div',null,'native-companion-remote-plan');remotePlan.id='native-companion-remote-plan';
    const remoteRefresh=node('button','Recheck host setup','btn-outline');remoteRefresh.type='button';remoteRefresh.id='native-companion-remote-refresh';remoteRefresh.addEventListener('click',load);
    const remoteChoose=node('button','Review the pairing address','btn-outline');remoteChoose.type='button';remoteChoose.addEventListener('click',()=>focusStep('pair'));
    const remoteActions=node('div',null,'native-companion-remote-actions');remoteActions.append(remoteRefresh,remoteChoose);
    const guide=node('ol',null,'native-companion-remote-guide');
    for(const text of [
      'Pair at home first. Match the selected address below to the exact address in Companion Settings. An existing pairing keeps its address and certificate.',
      'Set up your private network outside TLI. For Tailscale, sign in on your phone and a compatible home subnet-router device. For an existing WireGuard gateway, ask its administrator to provide the route.',
      'Ask the network administrator to route only the TLI host address (/32) and allow only your intended phone or account to its HTTPS TCP port. Approve the route and review existing broader access rules. TLI has not configured any route, firewall or VPN.',
      'Keep the TLI host and home gateway running. Away from home, enable the private-network client and use Check connection in Companion Settings. No new pairing is needed while the address and certificate stay the same.',
      'A successful check confirms the paired host responded. It does not verify which network carried the connection. Test from cellular or another network yourself; interrupted messages and actions are never replayed.'
    ])guide.append(node('li',text));
    const links=node('div',null,'native-companion-remote-links');
    for(const [label,url] of [['Tailscale subnet-router setup','https://tailscale.com/docs/features/subnet-routers'],['Tailscale access rules','https://tailscale.com/docs/reference/syntax/grants'],['WireGuard setup reference','https://www.wireguard.com/quickstart/']]){const a=node('a',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}
    remoteBody.append(node('p','Reach your existing paired HTTPS address through an externally managed private network. This is optional; normal home-network pairing stays the same.'),remoteStatus,remotePlan,remoteActions,guide,
      node('p','This workflow uses a routed private LAN IPv4 address. Link-local (169.254), direct Tailscale (100.x), public URLs and MagicDNS names are not supported here. Keep the existing TLS certificate; do not disable verification or publish TLI through a public tunnel.','native-companion-help'),
      node('p','Remote traffic crosses the Internet through your chosen encrypted private network. Its account, gateway availability and access policy are managed outside TLI. A desktop check cannot verify your phone’s remote path.','native-companion-help'),links);
    remote.append(remoteSummary,remoteBody);
    const management=node('details',null,'native-companion-management');management.id='native-companion-management';management.append(node('summary','Saved phones and advanced connection options'),blocks.devices.block,blocks.access.block,hostStart.section,remote);
    const ios=node('details',null,'native-companion-ios');ios.id='native-companion-ios';ios.append(node('summary','iPhone and other ways to connect'),node('p','The guided app setup is for Android. Existing iPhone beta pairings keep their access. An iPhone beta needs a reviewed IPv4 address; hostname recovery is currently Android-only. You can also open this host’s HTTPS address in your phone browser and unlock with your owner PIN.'));
    management.append(ios);content.append(management);
    const note=node('p','Keep this computer awake with TLI running. Away-from-home access is an optional private-network setup under advanced options.','native-companion-footer');
    body.append(header,status,steps,content,note);section.append(body);panel.append(section);

    function current(epoch){return state.active&&!state.locked&&!document.hidden&&epoch===state.epoch;}
    function notice(text,error=false){status.textContent=text;status.classList.toggle('error',error);status.hidden=!!embeddedAt&&!error&&ready();}
    function badge(key,text,kind='unknown'){blocks[key].badge.textContent=text;blocks[key].badge.dataset.state=kind;}
    function focusStep(key){if(key==='remote'){management.open=true;remote.open=true;remoteSummary.focus?.({preventScroll:true});remote.scrollIntoView?.({block:'start'});return;}if(['access','devices'].includes(key))management.open=true;const step=blocks[key];if(step){step.heading.focus?.({preventScroll:true});step.block.scrollIntoView?.({block:'start'});}}
    function paintFlow(){
      const prepared=ready();
      blocks.connection.block.hidden=!!embeddedAt||prepared;
      blocks.install.block.hidden=!prepared;installLayout.hidden=appInstalled;installAgain.hidden=!appInstalled;
      blocks.pair.block.hidden=!prepared||!appInstalled;blocks.chat.block.hidden=!prepared||!chatOpened;
      scanDone.hidden=pairing.hidden;controls.hidden=!pairing.hidden;badge('install',appInstalled?'App installed':'Next step',appInstalled?'ready':'needed');badge('chat','Confirm on your phone','unknown');
    }
    function ready(){return state.flowPrepared&&state.setup?.pairing_ready===true&&/^https:/.test(window.location?.origin||'')&&current(state.epoch);}
    function canPair(){return ready()&&!!state.selectedOrigin&&state.selectedOrigin===select.value&&state.setup.origins.includes(state.selectedOrigin);}
    function busy(){refresh.disabled=!!state.loading||!!state.mutation;remoteRefresh.disabled=!!state.loading||!!state.mutation||!current(state.epoch);generate.disabled=!canPair()||!!state.loading||!!state.mutation;select.disabled=!ready()||!!state.loading||!!state.mutation;checkPhones.disabled=!!state.loading||!!state.mutation||!current(state.epoch);for(const button of devices.querySelectorAll?.('button')||[])button.disabled=!!state.loading||!!state.mutation||!current(state.epoch);section.setAttribute('aria-busy',state.loading||state.mutation?'true':'false');paintFlow();}
    function privateAddress(origin){const match=/^https:\/\/((?:[0-9]+\.){3}[0-9]+)(?::([0-9]+))?$/.exec(origin||'');if(!match)return null;const parts=match[1].split('.').map(Number),canonical=parts.join('.'),port=match[2]?Number(match[2]):443;if(canonical!==match[1]||parts.some(n=>n>255)||port<1||port>65535||(match[2]&&String(port)!==match[2]))return null;const[a,b]=parts;return a===10||a===172&&b>=16&&b<=31||a===192&&b===168?{host:canonical,port}:null;}
    function acceptRemote(value){const r=value.remote_access,expected=value.origins.filter(privateAddress);if(!r||r.schema_version!==1||r.mode!=='routed_lan'||r.route_status!=='not_tested'||r.tunnel_status!=='unknown'||typeof r.host_ready!=='boolean'||r.host_ready!==!!(value.pairing_ready&&expected.length)||typeof r.checked_at!=='string'||!Number.isFinite(Date.parse(r.checked_at))||typeof r.reason!=='string'||r.reason.length>1000||!Array.isArray(r.eligible_origins)||r.eligible_origins.length!==expected.length||!r.eligible_origins.every((origin,i)=>origin===expected[i]))return false;state.remoteReceipt=r;return true;}
    function paintRemote(phase=state.remotePhase){state.remotePhase=phase;const r=state.remoteReceipt;remotePlan.replaceChildren();remoteStatus.dataset.state=phase==='current'&&r?.host_ready?'ready':'unknown';
      remoteStatus.textContent=phase==='locked'?'Unlock TLI to review the host setup. Remote path: not tested.':phase==='checking'?'Checking host setup. Remote path: not tested.':phase==='current'&&r?(r.host_ready?'Host setup ready. ':'Host setup needs attention. ')+'Checked '+new Date(r.checked_at).toLocaleString()+'. Remote path: not tested.':phase==='unavailable'?'Host setup unavailable. Remote path: not tested.':'Remote readiness is not provided by this host. Refresh after using matching TLI files. Remote path: not tested.';
      if(!r)return;if(phase!=='current'){remotePlan.append(node('p','Previous host details from '+new Date(r.checked_at).toLocaleString()+'. They may be out of date.','native-companion-help'));}
      remotePlan.append(node('p',r.reason));
      const selected=state.selectedOrigin,address=privateAddress(selected);
      if(!selected){remotePlan.append(node('p','Review the address in Pair your phone, then match it to the address already saved in Companion Settings.'));return;}
      if(!address||!r.eligible_origins.includes(selected)){remotePlan.append(node('p','The selected address is unsuitable for this routed remote workflow. Review a certificate-covered private LAN address at home. Existing phone pairings have not changed.'));return;}
      const fields=node('dl');for(const [label,value] of [['Selected HTTPS address',selected],['Single-host route',address.host+'/32'],['Allowed transport','TCP port '+address.port]]){fields.append(node('dt',label),node('dd',value,'native-companion-address'));}remotePlan.append(fields,node('p','Match this address to Companion Settings. This selection does not change any phone’s stored pairing.','native-companion-help'));
    }
    function pairingGuidance(){
      badge('pair',canPair()?'Ready to pair':ready()?'Choose an address':'Waiting for setup',canPair()?'ready':'needed');
      pairNotice.textContent=state.setup?.pairing_ready&&!/^https:/.test(window.location?.origin||'')?'Open TLI using its HTTPS address and unlock with your owner PIN before creating a code.':
        canPair()?'Ready to create a pairing code for '+state.selectedOrigin+'.':ready()?'Choose the address reachable from your phone before creating a code.':'Complete the owner and connection setup before creating a code.';
    }
    function clearPairing(){clearTimeout(expiryTimer);expiryTimer=null;pairing.replaceChildren();pairing.hidden=true;scanDone.hidden=true;controls.hidden=false;chatOpened=false;}
    async function read(path,method='GET',data){
      const controller=new AbortController();requests.add(controller);
      const timer=setTimeout(()=>controller.abort(),15000);
      try{return await api(path,method,data,controller.signal);}finally{clearTimeout(timer);requests.delete(controller);}
    }
    function validSetup(value){return value&&['pin_enabled','tls_enabled','lan_enabled','certificate_ready','pairing_ready'].every(key=>typeof value[key]==='boolean')&&
      Array.isArray(value.origins)&&value.origins.length<=30&&value.origins.every(origin=>typeof origin==='string'&&/^https:\/\/[^/\s]+$/.test(origin))&&
      (!value.pairing_ready||value.pin_enabled&&value.tls_enabled&&value.lan_enabled&&value.certificate_ready&&value.origins.length>0);}
    function paintSetup(value){
      state.setup=value;state.checkedAt=Date.now();select.replaceChildren();
      // Prefer the reviewed stable identity for Android. Literal addresses remain
      // explicit fallbacks; never guess the first adapter or replace a prior choice.
      const previous=state.selectedOrigin;
      const stable=value.origins.find(origin=>/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.local:[0-9]+$/.test(origin));
      state.selectedOrigin=value.origins.includes(previous)?previous:previous?'':stable|| (value.origins.includes(window.location?.origin)?window.location.origin:value.origins.length===1?value.origins[0]:'');
      const placeholder=node('option','Choose your home-network address');placeholder.value='';placeholder.disabled=true;select.append(placeholder);
      for(const origin of value.origins){const option=node('option',origin);option.value=origin;select.append(option);}
      select.value=state.selectedOrigin;
      badge('access',value.pin_enabled?'PIN enabled':'Set a PIN',value.pin_enabled?'ready':'needed');
      accessButton.textContent=value.pin_enabled?'Access settings':'Set owner PIN';
      accessCopy.textContent=value.pin_enabled?'An owner PIN is enabled. Creating invitations requires this browser to be unlocked with that PIN.':'First, set an owner PIN in Access settings, then unlock TLI. This protects pairing and every phone’s access.';
      badge('connection',value.tls_enabled&&value.lan_enabled&&value.certificate_ready?'Ready':'Setup needed',value.tls_enabled&&value.lan_enabled&&value.certificate_ready?'ready':'needed');
      connectionCopy.textContent=ready()?'This computer is prepared. Continue with the Android app.':'Use Connect phone to prepare this computer, including owner access and a reviewed restart when needed.';
      pairingGuidance();paintFlow();
      paintRemote(acceptRemote(value)?'current':'unknown');
      busy();
    }
    select.addEventListener('change',()=>{
      if(!ready()||state.loading||state.mutation){select.value=state.selectedOrigin;return;}
      const value=state.setup.origins.includes(select.value)?select.value:'';
      if(value===state.selectedOrigin)return;
      const hadCode=!pairing.hidden;state.selectedOrigin=value;select.value=value;clearPairing();pairingGuidance();
      paintRemote();
      if(hadCode)pairNotice.textContent='Address changed. Create a new code for the selected address. The previous invitation remains valid until used or expired.';
      notice(canPair()?'Ready to pair securely.':'Choose your home-network address to pair a phone.');busy();
    });
    function validDevices(value){return value&&Array.isArray(value.devices)&&value.devices.length<=1000&&value.devices.every(device=>device&&typeof device.id==='string'&&device.id.length>0&&typeof device.name==='string'&&['ios','android'].includes(device.platform)&&Number.isFinite(Date.parse(device.created_at))&&(!device.revoked_at||Number.isFinite(Date.parse(device.revoked_at))));}
    function paintDevices(){
      devices.replaceChildren();const active=(state.devices||[]).filter(device=>!device.revoked_at);
      if(!active.length)devices.append(node('p','No native phones paired yet.','native-companion-empty'));
      for(const device of active){
        const row=node('div',null,'native-companion-device'),identity=node('div');
        identity.append(node('strong',device.name),node('span',`${device.platform==='ios'?'iPhone / iPad':'Android'} · paired ${new Date(device.created_at).toLocaleDateString()}`));
        const actions=node('div',null,'native-companion-device-actions'),revoke=node('button','Remove access','btn-outline'),cancel=node('button','Keep access','btn-outline');revoke.type=cancel.type='button';cancel.hidden=true;
        let confirming=false;
        revoke.addEventListener('click',()=>{
          if(state.mutation||!current(state.epoch))return;
          if(!confirming){confirming=true;revoke.textContent='Confirm removal';cancel.hidden=false;return;}
          return mutate('revoke',async epoch=>{
            const result=await read('/paired-devices/'+encodeURIComponent(device.id),'DELETE');
            if(!current(epoch))return;
            if(result.ok!==true)throw new Error('TLI did not confirm removal. The phone’s access may still be active; refresh before retrying.');
            state.devices=state.devices.filter(item=>item.id!==device.id);paintDevices();
            devicesNotice.textContent=`Access removed for ${device.name}. It must pair again to reconnect.`;badge('devices','Access updated','ready');
          });
        });
        cancel.addEventListener('click',()=>{if(state.mutation)return;confirming=false;revoke.textContent='Remove access';cancel.hidden=true;revoke.focus?.();});
        revoke.setAttribute('aria-label','Remove access for '+device.name);cancel.setAttribute('aria-label','Keep access for '+device.name);
        actions.append(revoke,cancel);row.append(identity,actions);devices.append(row);
      }
      badge('devices',active.length?`${active.length} paired`:'No paired phones','ready');
    }
    async function loadDevices(epoch){
      try{
        const result=await read('/paired-devices');if(!current(epoch))return;
        if(!validDevices(result))throw new Error('TLI returned an incomplete phone list.');
        state.devices=result.devices;state.devicesCheckedAt=Date.now();paintDevices();
        devicesNotice.textContent='Checked '+new Date(state.devicesCheckedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})+'.';
      }catch(error){
        if(!current(epoch))return;
        if(error.status===401){lockView();return;}
        badge('devices','Unavailable','unavailable');
        devicesNotice.textContent=error.message+(state.devicesCheckedAt?' Previous phones are retained from '+new Date(state.devicesCheckedAt).toLocaleTimeString()+'.':' No phone list has been confirmed in this view.');
      }
    }
    function load(){
      if(!current(state.epoch))return Promise.resolve();
      if(state.loading)return state.loading;
      if(state.mutation)return state.mutation.then(()=>load());
      const epoch=state.epoch;state.setup=null;clearPairing();paintRemote('checking');notice('Checking this host’s connection…');badge('access','Checking');badge('connection','Checking');badge('pair','Checking');
      state.loading=Promise.resolve().then(async()=>{
        if(!current(epoch))return;
        try{
          const value=await read('/setup');if(!current(epoch))return;
          if(!validSetup(value))throw new Error('TLI returned incomplete phone connection details. Readiness is unknown.');
          paintSetup(value);if(value.pin_enabled)await loadDevices(epoch);else{state.devices=null;state.devicesCheckedAt=null;devices.replaceChildren();badge('devices','Owner access needed','needed');devicesNotice.textContent='Unlock with your owner PIN to check paired phones.';}
          if(current(epoch))notice(canPair()?'Ready to pair securely.':ready()?'Choose your home-network address to pair a phone.':'Complete connection setup to pair a phone.');
        }catch(error){
          if(!current(epoch))return;
          if(error.status===401){lockView();return;}
          state.setup=null;paintRemote('unavailable');badge('access','Not confirmed','unavailable');badge('connection','Unavailable','unavailable');badge('pair','Unavailable','unavailable');
          accessCopy.textContent='Owner access could not be confirmed. Refresh after resolving the connection issue.';connectionCopy.textContent='Connection readiness is not confirmed. '+error.message;
          pairNotice.textContent='Pairing is unavailable until the connection can be checked.';
          badge('devices','Not refreshed','unavailable');
          devicesNotice.textContent=state.devicesCheckedAt?'Previous phones are retained from '+new Date(state.devicesCheckedAt).toLocaleTimeString()+'. Refresh after the connection is available.':'No phone list has been confirmed in this view.';
          notice(error.message,true);
        }
      }).finally(()=>{state.loading=null;busy();});busy();return state.loading;
    }
    function mutate(kind,work){
      if(state.mutation)return state.mutation;
      if(!current(state.epoch)||state.loading)return Promise.resolve();
      const epoch=state.epoch;
      state.mutation=Promise.resolve().then(async()=>{
        if(!current(epoch))return;
        try{await work(epoch);}catch(error){if(current(epoch)){if(error.status===401){lockView();return;}if(kind==='pair')pairNotice.textContent=error.message;else devicesNotice.textContent=error.message;notice(error.message,true);}}
      }).finally(()=>{state.mutation=null;busy();});busy();return state.mutation;
    }
    generate.addEventListener('click',()=>{
      if(!canPair())return;return mutate('pair',async epoch=>{
        clearPairing();pairNotice.textContent='Creating a single-use invitation…';const origin=select.value;
        if(!state.setup.origins.includes(origin))throw new Error('Choose one of this host’s checked LAN addresses.');
        const result=await read('/pairings','POST',{origin});if(!current(epoch))return;
        let bundle;try{bundle=JSON.parse(result.bundle);}catch{throw new Error('The server returned an invalid pairing bundle. Refresh before trying again.');}
        const expiry=Date.parse(result.expires_at);
        if(![1,2].includes(bundle?.version)||bundle.version===2&&!/^[a-f0-9]{64}$/.test(bundle.public_key||'')||bundle.origin!==origin||typeof bundle.token!=='string'||!bundle.token||typeof bundle.certificate_der!=='string'||!bundle.certificate_der||typeof bundle.node_id!=='string'||!bundle.node_id||typeof bundle.node_name!=='string'||!Number.isFinite(expiry)||expiry<=Date.now()||Date.parse(bundle.expires_at)!==expiry)throw new Error('TLI did not confirm a complete, current pairing invitation. Create a fresh code after checking the connection.');
        const cameraLink=['https_fragment_v1','https_fragment_v2'].includes(result.qr_format);
        const pairingHeading=node('h4','Scan inside the TLI Android app');pairingHeading.tabIndex=-1;pairing.append(pairingHeading);
        pairing.append(node('p','Your phone will connect to '+origin+'.','native-companion-address'));
        if(typeof result.qr==='string'&&/^data:image\/(?:svg\+xml|png);base64,/.test(result.qr)){const img=node('img');img.src=result.qr;img.alt='Single-use QR code for pairing this TLI host';pairing.append(img);}
        else pairing.append(node('p','A QR image is unavailable. Use the complete pairing bundle below.'));
        pairing.append(node('p',`For ${bundle.node_name} · expires ${new Date(expiry).toLocaleTimeString()}. Only scan this code with your own phone.`));
        if(cameraLink){const cameraHelp=node('details');cameraHelp.append(node('summary','Using your phone camera instead?'),node('p','The camera link opens this computer’s local HTTPS page. A browser certificate warning may appear. Use the scanner inside TLI to avoid that browser step. Opening a link does not pair your phone.'));pairing.append(cameraHelp);}
        const manual=node('details');manual.append(node('summary','Use a pairing bundle instead'));const field=node('textarea');field.id='native-companion-bundle';field.value=result.bundle;field.readOnly=true;field.rows=4;field.setAttribute('aria-label','Complete pairing bundle');field.addEventListener('focus',()=>field.select());
        manual.append(node('p','Copy the complete bundle into the phone app. It contains a temporary private invitation.'),field);pairing.append(manual);
        const hide=node('button','Hide code','btn-outline');hide.type='button';hide.id='native-companion-hide-code';hide.addEventListener('click',()=>{clearPairing();pairNotice.textContent='Code hidden. Its invitation remains valid until used or expired.';badge('pair','Ready to pair','ready');generate.focus?.();});pairing.append(hide);pairing.hidden=false;
        pairNotice.textContent='Private pairing code ready. Scan it inside the TLI Android app. Only share it with your own phone.';badge('pair','Code ready','ready');paintFlow();
        pairingHeading.focus?.({preventScroll:true});pairing.scrollIntoView?.({block:'start'});
        expiryTimer=setTimeout(()=>{if(current(epoch)){clearPairing();pairNotice.textContent='Pairing code expired. Create a fresh one to continue.';badge('pair','Ready to pair','ready');}},expiry-Date.now());
      });
    });
    refresh.addEventListener('click',load);
    function leave(){state.epoch++;state.active=false;state.setup=null;state.selectedOrigin='';state.remoteReceipt=null;paintRemote('locked');select.replaceChildren();select.value='';for(const controller of requests)controller.abort();clearPairing();hostStart.clear();busy();}
    function lockView(){leave();state.locked=true;state.devices=null;state.devicesCheckedAt=null;devices.replaceChildren();for(const key of Object.keys(blocks))badge(key,'Unlock TLI','unknown');accessButton.textContent='Unlock TLI';accessCopy.textContent='Unlock this browser with your owner PIN to review phone access.';pairNotice.textContent='Unlock TLI with your owner PIN before pairing.';devicesNotice.textContent='Unlock TLI to check paired phones.';notice('Unlock TLI with your owner PIN, then refresh this page.');}
    function onOpen(){if(state.locked||document.hidden)return Promise.resolve();if(state.active)return state.loading||Promise.resolve();state.active=true;hostStart.activate();return Promise.allSettled([state.loading,state.mutation]).then(()=>current(state.epoch)?load():undefined);}
    function open(options={}){if(window.TLIConnectDevice?.open)return window.TLIConnectDevice.open({kind:'phone'});if(typeof window.switchPanel==='function')window.switchPanel('panel-companion');const opening=onOpen();if(options.step)focusStep(options.step);return opening;}
    for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event,lockView);
    window.addEventListener('tli-session-unlocked',()=>{state.locked=false;if(embeddedAt||!panel.hidden&&!panel.classList?.contains?.('hidden'))onOpen();});
    window.addEventListener('pagehide',leave);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)leave();else if(embeddedAt||!panel.hidden&&!panel.classList?.contains?.('hidden'))onOpen();});
    let embeddedAt=null;
    function mount(container){
      if(embeddedAt)return()=>{};
      const marker=document.createComment('Phone pairing returns here');section.before(marker);embeddedAt=container;state.flowPrepared=false;management.open=false;remote.open=false;ios.open=false;addressDetails.open=false;section.dataset.embedded='true';container.append(section);paintFlow();onOpen();
      return()=>{leave();embeddedAt=null;state.flowPrepared=true;section.dataset.embedded='false';marker.replaceWith(section);paintFlow();};
    }
    window.TLICompanion={open,onOpen,onClose:leave,refresh:load,mount,setPrepared(value){state.flowPrepared=value===true;if(!state.flowPrepared)clearPairing();pairingGuidance();if(ready())notice('This computer is prepared for your phone.');busy();}};
    busy();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
