// =====================================================
// MeshService (inline, single source of truth)
// Presence • Authority • Routing • Context
// =====================================================
window.MeshService = (function () {
  let epoch=0,locked=false;
  const current=t=>!locked&&t===epoch;
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
    if(locked||record?.status!=='allowed'||record?.trust_state!=='verified')return null;
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

  async function fetchNode({ force = false } = {}) {
    if(locked)throw Error("Unlock TLI first.");const token=epoch;
    if (!force && _isFresh(_state.lastNodeFetchMs) && currentNodeConfig) return currentNodeConfig;
    const res = await fetch("/mesh/node", { headers: { "Accept": "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if(!current(token))throw Error("Computer session changed; response ignored.");
    currentNodeConfig = data;
    // Backward-compat for older code paths
    window.currentNodeConfig = data;
    _state.lastNodeFetchMs = _now();
    return data;
  }

  async function fetchDirectory({ force = false } = {}) {
    if(locked)throw Error("Unlock TLI first.");const token=epoch;
    if (!force && _isFresh(_state.lastDirFetchMs) && meshDirectoryCache) return meshDirectoryCache;
    const res = await fetch("/mesh/directory", { headers: { "Accept": "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if(!current(token))throw Error("Computer session changed; response ignored.");
    meshDirectoryCache = data;
    // Backward-compat for older code paths
    window.meshDirectoryCache = data;
    _state.lastDirFetchMs = _now();
    return data;
  }

  function getThisNode() { return currentNodeConfig || null; }

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
    if (locked) return [];
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
  function getPeers(){return locked||!peers?null:{...peers,peers:peers.peers.map(peer=>projectPeer(peer))};}
  function publishPeers(error=null,onlyChanged=false){const value=getPeers(),signature=JSON.stringify(value);if(onlyChanged&&signature===lastPublished)return;lastPublished=signature;
    for(const observer of observers){try{observer(value,error);}catch(error){console.warn('Computer view could not update.',error);}}}
  function tickExpiry(){if(locked||document.hidden)return;publishPeers(null,true);for(const observer of expiryObservers){try{observer();}catch(error){console.warn('Computer status could not update.',error);}}}
  function stopExpiry(){clearInterval(expiryTimer);expiryTimer=null;}
  function startExpiry(){if(!locked&&!document.hidden&&(observers.size||expiryObservers.size)&&!expiryTimer)expiryTimer=setInterval(tickExpiry,1000);}
  function subscribeExpiry(observer){expiryObservers.add(observer);startExpiry();return()=>{expiryObservers.delete(observer);if(!observers.size&&!expiryObservers.size)stopExpiry();};}
  async function refreshPeers(){
    if(locked||document.hidden)return getPeers();
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
  function schedulePeers(){if(!observers.size||locked||document.hidden)return;clearTimeout(peersDebounce);peersDebounce=setTimeout(()=>refreshPeers(),180);}
  function startPeers(){
    if(!observers.size||locked||document.hidden)return;
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

  for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event,()=>{locked=true;epoch++;_state.lastNodeFetchMs=0;_state.lastDirFetchMs=0;
    stopPeers();stopExpiry();peersRequest?.abort();peersRequest=null;peers=null;peersPending=null;publishPeers();
    if(typeof currentNodeConfig!=='undefined')currentNodeConfig=null;if(typeof meshDirectoryCache!=='undefined')meshDirectoryCache=null;
    window.currentNodeConfig=null;window.meshDirectoryCache=null;});
  window.addEventListener('tli-session-unlocked',()=>{locked=false;epoch++;startExpiry();startPeers();});

  return {
    fetchNode,
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
