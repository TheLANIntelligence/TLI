// =====================================================
// MeshService (inline, single source of truth)
// Presence • Authority • Routing • Context
// =====================================================
window.MeshService = (function () {
  let epoch=0,locked=document.getElementById?.('tli-lock-screen')?.getAttribute?.('aria-hidden') === 'false';
  let accessReady=!locked,nodeAvailable=false,nodeRequest=null,directoryRequest=null;
  const current=t=>!locked&&accessReady&&t===epoch;
  const _state = {
    lastNodeFetchMs: 0,
    lastDirFetchMs: 0,
    ttlMs: 2500,
    defaultConsolePort: 8000,
  };

  function _now() { return Date.now(); }
  function _isFresh(lastMs) { return (_now() - (lastMs || 0)) < _state.ttlMs; }

  function _pickIp(device) {
    return (device && (device.ip || device.addr || device.address || device.host || device.host_ip))
      ? String(device.ip || device.addr || device.address || device.host || device.host_ip).trim()
      : "";
  }

  function _pickPort(device) {
    const p = device?.console_port ?? device?.port ?? device?.ui_port ?? device?.http_port;
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : _state.defaultConsolePort;
  }

  function _consoleUrl(device, panel) {
    const record=device?.raw||device;
    if(locked||!accessReady||record?.status!=='allowed'||record?.trust_state!=='verified')return null;
    try {const url=new URL(record.origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
      return url.origin+'/?panel='+encodeURIComponent((panel||'').trim());
    }catch{return null;}
  }

  function _parseLastSeenMs(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (!v) return 0;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : 0;
  }

  // A saved grant or discovery timestamp is not a live connection receipt.
  // Project at every read as well as on a visible timer: a failed host request
  // must not extend the lifetime of the last successful verification.
  function projectConnection(receipt, now = _now()) {
    const source = receipt && typeof receipt === 'object' ? receipt : {};
    const expires = typeof source.expires_at === 'string' && source.expires_at.length <= 64 && /(?:Z|[+-]\d{2}:\d{2})$/i.test(source.expires_at)
      ? Date.parse(source.expires_at) : NaN;
    const fresh = source.fresh === true && Number.isFinite(expires) && expires > now;
    const connected = fresh && source.state === 'connected';
    const expired = !fresh && source.state === 'connected';
    const capabilities = Object.fromEntries(Object.entries(source.capabilities || {}).map(([name, value]) => {
      if (connected || !['ready','no_model'].includes(value?.state)) return [name, value];
      const {models, ...rest} = value;
      return [name, {...rest, state:'not_checked'}];
    }));
    return {...source, state:expired ? 'unknown' : source.state || 'unknown', fresh,
      online:connected ? true : fresh && source.online === false ? false : null,
      ready_grants:connected && Array.isArray(source.ready_grants) ? source.ready_grants.slice() : [], capabilities,
      reason:expired ? {code:'connection_expired',message:'Connection check expired. Saved permissions remain; check again before using shared capabilities.'} : source.reason || null};
  }

  function projectPeer(peer, now = _now()) {
    if (peer?.is_self) return {...peer};
    const connection = projectConnection(peer?.connection || {state:peer?.pairing_available || peer?.status === 'pending' ? 'discovered' : 'unknown'}, now);
    const ready = connection.state === 'connected' && connection.fresh;
    const messages = ready && connection.ready_grants.includes('messages');
    return {...peer, connection, online:connection.online, ready_grants:connection.ready_grants,
      messaging:{...peer?.messaging, available:messages,
        reason:messages ? null : connection.reason?.message || peer?.messaging?.reason || 'Check this saved connection before sending.',
        message:messages ? peer?.messaging?.message || 'Messages available on both computers.' : connection.reason?.message || peer?.messaging?.message || 'Check this saved connection before sending.'}};
  }

  // Read compatibility follows the bounded host store; new-edit limits belong
  // to the save boundary, not to already saved names or identifiers.
  const text = value => typeof value === 'string' && !!value.trim();
  function validNode(data) {
    return data && typeof data === 'object' && !Array.isArray(data) && text(data.node_id) && text(data.display_name) &&
      ['standalone','host','member'].includes(data.role) && data.join_mode === data.role && data.is_host === (data.role === 'host') &&
      ['host_address','created_at','last_seen'].every(key => data[key] == null || typeof data[key] === 'string');
  }
  function validDirectory(data) {
    return data && typeof data === 'object' && !Array.isArray(data) && ['standalone','host','member'].includes(data.mode) && text(data.this_device_id) &&
      (data.host_device_id == null || text(data.host_device_id)) && Array.isArray(data.devices) &&
      data.devices.every(row => row && typeof row === 'object' && !Array.isArray(row) && text(row.device_id) && text(row.display_name)) &&
      new Set(data.devices.map(row => row.device_id)).size === data.devices.length;
  }
  function requireCurrent(token) { if (!current(token)) throw Error('Computer session changed; response ignored.'); }
  async function checkedRead(path,token,validate) {
    const res = await fetch(path, {headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
    requireCurrent(token);
    if (res.status === 401 || res.status === 403) {
      window.dispatchEvent(new CustomEvent('tli-session-locked'));
      throw Error('Unlock TLI and check access before reading computer information.');
    }
    if (!res.ok) throw Error('Computer information unavailable (HTTP '+res.status+').');
    const data = await res.json(); requireCurrent(token);
    if (!validate(data)) throw Error('Computer information is incomplete. Check saved state before continuing.');
    return data;
  }
  async function fetchNode({ force = false } = {}) {
    if (!current(epoch)) throw Error('Unlock TLI and check access first.');
    if (nodeRequest) return nodeRequest.promise;
    if (!force && nodeAvailable && _isFresh(_state.lastNodeFetchMs) && currentNodeConfig) return currentNodeConfig;
    const request={epoch,promise:null}; nodeRequest=request;
    request.promise=(async()=>{
      try {
        const data=await checkedRead('/mesh/node',request.epoch,validNode);requireCurrent(request.epoch);
        currentNodeConfig=data;window.currentNodeConfig=data;nodeAvailable=true;_state.lastNodeFetchMs=_now();return data;
      } catch(error) { if(current(request.epoch)){nodeAvailable=false;_state.lastNodeFetchMs=0;} throw error; }
      finally {if(nodeRequest===request)nodeRequest=null;}
    })();
    return request.promise;
  }
  async function fetchDirectory({ force = false } = {}) {
    if (!current(epoch)) throw Error('Unlock TLI and check access first.');
    if (directoryRequest) return directoryRequest.promise;
    const request={epoch,promise:null};directoryRequest=request;
    request.promise=(async()=>{
      try {
        const node=await fetchNode();requireCurrent(request.epoch);
        if(!force&&_isFresh(_state.lastDirFetchMs)&&meshDirectoryCache&&meshDirectoryCache.this_device_id===node.node_id)return meshDirectoryCache;
        const data=await checkedRead('/mesh/directory',request.epoch,validDirectory);requireCurrent(request.epoch);
        if(data.this_device_id!==node.node_id)throw Error('Computer identity changed. Check saved state before continuing.');
        meshDirectoryCache=data;window.meshDirectoryCache=data;_state.lastDirFetchMs=_now();return data;
      } catch(error) {if(current(request.epoch))_state.lastDirFetchMs=0;throw error;}
      finally {if(directoryRequest===request)directoryRequest=null;}
    })();return request.promise;
  }

  function getThisNode() { return current(epoch)&&nodeAvailable ? currentNodeConfig || null : null; }

  function getRoleLabel() {
    const n = getThisNode();
    if (!n) return "UNKNOWN";
    if (n.is_host || n.role === "host") return "HOST";
    const r = String(n.role || "").toLowerCase();
    if (r === "member") return "MEMBER";
    if (r) return r.toUpperCase();
    return "STANDALONE";
  }

  function isHost() {
    const n = getThisNode();
    return !!(n && (n.is_host || n.role === "host"));
  }

  function can(action) {
    const a = String(action || "").toLowerCase();
    if (a.startsWith("host:")) {
      if (!isHost()) return { ok: false, reason: "Host-only action." };
      return { ok: true };
    }
    // extra safety
    if (a.includes("disconnect_all") || a.includes("kill_all")) {
      if (!isHost()) return { ok: false, reason: "Host-only action." };
    }
    return { ok: true };
  }

  function getRoster() {
    if (locked || !accessReady) return [];
    const dir = meshDirectoryCache;
    const devices = Array.isArray(dir?.devices) ? dir.devices
                 : Array.isArray(dir?.nodes) ? dir.nodes
                 : [];

    const cached = new Map((getPeers()?.peers || []).map(peer => [peer.id || peer.node_id || peer.device_id, peer]));
    const out = [];
    const seen = new Set();
    for (const d of devices) {
      const ip = _pickIp(d);
      if (!ip) continue;
      const id = d.device_id || d.node_id || d.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = d.display_name || d.nickname || d.node_name || d.device_name || d.hostname || id;
      const role = String(d.role || d.nodeRole || d.node_role || "member").toLowerCase();
      const lastSeenMs = _parseLastSeenMs(d.last_seen || d.lastSeen || d.seen_at || d.updated_at || d.heartbeat);
      const peer = projectPeer({...d, ...cached.get(id), id});
      const presence = peer.connection.state === 'connected' && peer.connection.fresh ? 'online' : peer.online === false ? 'offline' : 'unknown';
      out.push({ id, name, ip, role, lastSeenMs, presence, connection:peer.connection, online:peer.online, ready_grants:peer.ready_grants, raw:peer });
    }
    return out;
  }

  function openNodePanel(deviceLike, panel) {
    const url = _consoleUrl(deviceLike, panel);
    if (!url) {
      showToast("Review this computer’s identity and HTTPS address before opening its console.", "warning");
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function setHeaderMeshPill() {
    const pill = $("mesh-model-pill");
    if (!pill) return;

    const role = getRoleLabel();
    const roster = getRoster();
    const nodes = roster.length;

    // Keep it compact + premium
    // Examples:
    //  - Mesh: HOST · 2 nodes
    //  - Mesh: MEMBER · 1 node
    //  - LAN-only · No mesh
    if (role === "UNKNOWN" || role === "STANDALONE") {
      pill.textContent = "LAN-only · No mesh";
      pill.classList.add("mesh-offline");
      pill.classList.remove("mesh-online");
      return;
    }

    pill.textContent = `Mesh: ${role} · ${nodes} node${nodes === 1 ? "" : "s"}`;
    pill.classList.add("mesh-online");
    pill.classList.remove("mesh-offline");
  }

  // Cached directory observations are hints. Only a separately verified
  // connection receipt can enable a capability; discovery never grants it.
  let peers=null, peersPending=null, peersStream=null, peersTimer=null, peersDebounce=null, peersRequest=null;
  const observers=new Set(),expiryObservers=new Set();
  let expiryTimer=null,lastPublished='null';
  function getPeers(){return locked||!accessReady||!peers?null:{...peers,peers:peers.peers.map(peer=>projectPeer(peer))};}
  function publishPeers(error=null,onlyChanged=false){const value=getPeers(),signature=JSON.stringify(value);if(onlyChanged&&signature===lastPublished)return;lastPublished=signature;
    for(const observer of observers){try{observer(value,error);}catch(error){console.warn('Computer view could not update.',error);}}}
  function tickExpiry(){if(locked||!accessReady||document.hidden)return;publishPeers(null,true);for(const observer of expiryObservers){try{observer();}catch(error){console.warn('Computer status could not update.',error);}}}
  function stopExpiry(){clearInterval(expiryTimer);expiryTimer=null;}
  function startExpiry(){if(!locked&&accessReady&&!document.hidden&&(observers.size||expiryObservers.size)&&!expiryTimer)expiryTimer=setInterval(tickExpiry,1000);}
  function subscribeExpiry(observer){expiryObservers.add(observer);startExpiry();return()=>{expiryObservers.delete(observer);if(!observers.size&&!expiryObservers.size)stopExpiry();};}
  async function refreshPeers(){
    if(locked||!accessReady||document.hidden)return getPeers();
    if(peersPending)return peersPending;
    const ticket=epoch,controller=new AbortController();peersRequest=controller;const timeout=setTimeout(()=>controller.abort(),10000);
    const pending=(async()=>{
      try{const response=await fetch('/api/lan/peers',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('Nearby computers could not be refreshed.');const value=await response.json();
        if(!current(ticket))return null;
        if(!Array.isArray(value.peers)||value.peers.length>4096)throw Error('The computer list is incomplete.');
        peers=value;publishPeers();return getPeers();
      }catch(error){if(current(ticket))publishPeers(error);return getPeers();}
      finally{clearTimeout(timeout);if(peersRequest===controller)peersRequest=null;if(peersPending===pending)peersPending=null;}
    })();peersPending=pending;return pending;
  }
  function stopPeers(){peersStream?.close();peersStream=null;clearInterval(peersTimer);peersTimer=null;clearTimeout(peersDebounce);peersDebounce=null;}
  function schedulePeers(){if(!observers.size||locked||!accessReady||document.hidden)return;clearTimeout(peersDebounce);peersDebounce=setTimeout(()=>refreshPeers(),180);}
  function startPeers(){
    if(!observers.size||locked||!accessReady||document.hidden)return;
    tickExpiry();startExpiry();refreshPeers();if(!peersTimer)peersTimer=setInterval(refreshPeers,5000);
    if(!peersStream&&typeof EventSource==='function'){
      const stream=new EventSource('/mesh/presence/stream');peersStream=stream;
      for(const event of ['message','snapshot','peer_online','peer_offline','peer_updated','presence','connection_changed'])stream.addEventListener(event,schedulePeers);
      stream.onerror=()=>{if(peersStream===stream)schedulePeers();};
    }
  }
  function subscribePeers(observer){observers.add(observer);if(peers&&!locked)observer(getPeers(),null);startPeers();return()=>{observers.delete(observer);if(!observers.size)stopPeers();if(!observers.size&&!expiryObservers.size)stopExpiry();};}
  window.addEventListener('tli-peer-trust-changed',schedulePeers);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPeers();stopExpiry();}else{tickExpiry();startExpiry();startPeers();}});
  window.addEventListener('pagehide',()=>{stopPeers();stopExpiry();});

  for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event,()=>{locked=true;accessReady=false;nodeAvailable=false;nodeRequest=null;directoryRequest=null;epoch++;_state.lastNodeFetchMs=0;_state.lastDirFetchMs=0;
    stopPeers();stopExpiry();peersRequest?.abort();peersRequest=null;peers=null;peersPending=null;publishPeers();
    if(typeof currentNodeConfig!=='undefined')currentNodeConfig=null;if(typeof meshDirectoryCache!=='undefined')meshDirectoryCache=null;
    window.currentNodeConfig=null;window.meshDirectoryCache=null;});
  window.addEventListener('tli-session-unlocked',()=>{locked=false;epoch++;});
  window.addEventListener('tli-private-observation-ready',()=>{if(locked||accessReady)return;accessReady=true;startExpiry();startPeers();});

  return {
    fetchNode,
    validNode, validDirectory,
    fetchDirectory,
    getThisNode,
    getRoleLabel,
    isHost,
    can,
    getRoster,
    openNodePanel,
    setHeaderMeshPill,
    subscribePeers,refreshPeers,getPeers,projectConnection,projectPeer,subscribeExpiry,
    _setTTL(ms) {
      const n = parseInt(ms, 10);
      if (Number.isFinite(n) && n >= 250) _state.ttlMs = n;
    },
    _setConsolePort(port) {
      const n = parseInt(port, 10);
      if (Number.isFinite(n)) _state.defaultConsolePort = n;
    }
  };
})();
