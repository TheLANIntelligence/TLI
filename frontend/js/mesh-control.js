// TLI Mesh Control Center
(function () {
  const REFRESH_INTERVAL = 30000; // auto-refresh every 30s
  let _timer = null, _unsubscribe = null, _unsubscribeExpiry = null, _visible = false, _locked = false;
  let _request = null, _lastSuccess = null, _epoch = 0, _ready = true;
  let _lastNodes = [], _lastRender = '';
  const current = epoch => !_locked && _ready && epoch === _epoch;
  const project = n => window.MeshService?.projectPeer(n) || (n.is_self ? n : {...n,online:null,ready_grants:[],connection:{state:'unknown',fresh:false,ready_grants:[]}});
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const registryId = n => n.peer_id || n.node_id || n.id;
  const isInferenceNode = n => !n.is_self && (n.peer_profile === 'inference_node' || n.connection_state === 'inference_only');
  const pendingDiscovery = n => !n.is_self && !isInferenceNode(n) && n.pairing_available === true;
  function discoveryEndpoint(n) {
    if (n.is_self || isInferenceNode(n)) return null;
    const ip = String(n.ip || ''), parts = ip.split('.'), port = Number(n.port ?? n.tli_port ?? 8000);
    if (parts.length !== 4 || parts.some(p => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return ip + ':' + port;
  }
  const stamp = value => { const parsed = typeof value === 'string' && value.length <= 64 && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
  function newerDiscovery(a, b) {
    const seenA = stamp(a.last_seen), seenB = stamp(b.last_seen);
    return (stamp(a.discovery_observed_at) ?? seenA ?? -Infinity) - (stamp(b.discovery_observed_at) ?? seenB ?? -Infinity) ||
      (seenA ?? -Infinity) - (seenB ?? -Infinity) ||
      (String(registryId(a)) > String(registryId(b)) ? 1 : -1);
  }
  function uniqueNodes(nodes) {
    const seen = new Set();
    const distinct = nodes.filter(n => {
      const key = n.peer_id || n.node_id || n.id || (n.ip ? n.ip + ':' + (n.port || n.tli_port || '') : null);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    // Only the presentation of unreviewed discoveries is grouped. All actions
    // retain the selected record's exact identity; saved trust is never merged.
    const current = new Map();
    for (const n of distinct) {
      const key = discoveryEndpoint(n);
      if (key && (!current.has(key) || newerDiscovery(n, current.get(key)) > 0)) current.set(key, n);
    }
    return distinct.filter(n => !pendingDiscovery(n) || !discoveryEndpoint(n) || current.get(discoveryEndpoint(n)) === n);
  }

  function fmt(id) { return document.getElementById(id); }

  function validHealth(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false || !Array.isArray(data.nodes)) return false;
    return data.nodes.every(n => {
      if (!n || typeof n !== 'object' || Array.isArray(n)) return false;
      // Older health rows omit is_self. Missing node identity is also valid
      // when the observation still carries a host name or address.
      if (n.is_self !== undefined && typeof n.is_self !== 'boolean') return false;
      const identity = ['peer_id','node_id','id','node_name','hostname','ip'];
      if (!identity.some(key => typeof n[key] === 'string' && n[key].trim())) return false;
      if ([...identity,'os','active_model','active_preset','ai_status','error'].some(key => n[key] != null && typeof n[key] !== 'string')) return false;
      if (['online','ai_healthy','has_ai'].some(key => n[key] != null && typeof n[key] !== 'boolean')) return false;
      if (['cpu_percent','ram_percent','disk_percent','ram_used_gb','ram_total_gb','disk_free_gb','uptime_seconds'].some(key => n[key] != null && (typeof n[key] !== 'number' || !Number.isFinite(n[key])))) return false;
      return true;
    });
  }

  function fmtUptime(sec) {
    if (!sec && sec !== 0) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtGb(gb) { return gb != null ? `${gb} GB` : "—"; }

  function pctColor(pct) {
    if (pct == null) return "";
    if (pct >= 90) return "crit";
    if (pct >= 70) return "warn";
    return "";
  }

  function initial(name) {
    return (name || "?").trim().charAt(0).toUpperCase();
  }

  function cleanOfflineError(err) {
    if (!err) return "Not reachable";
    const s = String(err).toLowerCase();
    if (s.includes("timed out") || s.includes("timeout"))  return "Connection timed out";
    if (s.includes("refused"))                              return "Connection refused";
    if (s.includes("not reachable") || s.includes("max retries")) return "Not reachable";
    if (s.includes("host not found") || s.includes("getaddrinfo")) return "Host not found";
    if (s.includes("http "))                               return err; // HTTP status codes are fine to show
    return "Not reachable"; // hide any other raw exceptions
  }

  function buildNodeCard(n) {
    const epoch = _epoch;
    n = project(n);
    const isSelf = !!n.is_self;
    const inferenceNode = !isSelf && (n.peer_profile === 'inference_node' || n.connection_state === 'inference_only');
    const online = isSelf ? n.online === true && !n.error : n.connection.state === 'connected' && n.connection.fresh === true;
    const needsReview = ['discovered','review_required','identity_changed'].includes(n.connection?.state) || n.connection_state === 'review_required' || n.pairing_available === true;
    const knownOffline = n.online === false;
    const name = escape(n.node_name || n.hostname || n.ip || "Unknown computer");

    const card = document.createElement("div");
    card.className = "mcd-node" + (isSelf ? " self" : "") + (knownOffline && !needsReview && !inferenceNode ? " offline" : "");

    // ── Top row ──
    const avClass = isSelf ? "self-av" : inferenceNode ? "" : (online ? "peer-av" : "offline-av");
    const dotClass = online ? "online" : "offline";
    const selfTag = isSelf ? `<span class="mcd-self-tag">TLI host</span>` : inferenceNode ? `<span class="mcd-self-tag">Compute-only Node</span>` : "";
    const osLabel = escape(n.os || '');
    const ipLabel = n.ip ? ` · ${escape(n.ip)}` : "";

    card.innerHTML = `
      <div class="mcd-node-top">
        <div class="mcd-node-avatar ${avClass}">${initial(name)}</div>
        <div class="mcd-node-nameblock">
          <div class="mcd-node-name">${name}${selfTag}</div>
          <div class="mcd-node-sub">${osLabel}${ipLabel}</div>
        </div>
        ${inferenceNode ? "" : `<div class="mcd-status-dot ${dotClass}" title="${online ? "Reported online" : knownOffline ? "Not reachable" : "Status unavailable"}"></div>`}
      </div>
    `;

    // Registry identity only. A duplicated display name or an IP is never a key.
    const registryId = n.peer_id || n.node_id || n.id;
    if (typeof registryId === 'string' && registryId.length && registryId.length <= 240) {
      const details = document.createElement('button'); details.type = 'button'; details.className = 'btn-outline';
      details.textContent = 'Device details'; details.dataset.deviceDetailsId = 'node-' + registryId;
      details.addEventListener('click', () => { if (current(epoch)) window.TLIDeviceDetails?.open('node-' + registryId); }); card.appendChild(details);
      if (!isSelf && !inferenceNode && online && n.connection.ready_grants.includes('messages')) { const messages = document.createElement('button'); messages.type = 'button'; messages.className = 'btn-outline'; messages.textContent = 'Messages & files'; messages.addEventListener('click', () => { if (current(epoch)) window.TLIChat?.openPeer?.(registryId); }); card.appendChild(messages); }
      if (!isSelf && needsReview) {
        const connect = document.createElement('button'); connect.type = 'button'; connect.className = 'btn-primary';
        connect.textContent = 'Connect'; connect.dataset.pairingDeviceId = registryId;
        connect.addEventListener('click', () => { if (current(epoch)) window.TLIConnectDevice?.open({kind:inferenceNode?'node':'computer',deviceId:registryId}); });
        card.appendChild(connect);
      } else if (!isSelf) {
        const review=document.createElement('button');review.type='button';review.className='btn-outline';review.textContent='Review connection';
        review.addEventListener('click',()=>{ if (current(epoch)) window.TLIConnectDevice?.open({kind:inferenceNode?'node':'computer',deviceId:registryId}); });card.appendChild(review);
      }
    }

    if (!isSelf && (n.connection || needsReview || inferenceNode)) {
      const summary=document.createElement('p');summary.className='mcd-ai-row';
      const labels={discovered:'Nearby · needs approval',review_required:'Needs approval on both computers',checking:'Checking the saved connection',connected:'Connected',unreachable:'Temporarily unreachable',identity_changed:'Identity changed · review before reconnecting',unknown:'Connection not checked'};
      summary.textContent=labels[n.connection?.state] || (needsReview?'Nearby · needs approval':'Saved Node · check availability');
      if(n.connection?.reason?.message)summary.textContent+=' · '+n.connection.reason.message;
      if(online&&n.connection?.ready_grants?.length)summary.textContent+=' · '+n.connection.ready_grants.map(g=>({messages:'Messages & files',observe:'Observations',coordinate:'Coordination',inference:'AI compute'}[g]||g)).join(' · ');
      if(inferenceNode)summary.textContent+=' · Check models in Ask TLI.';
      card.appendChild(summary);
      if(inferenceNode||!online)return card;
    }
    if (!online) {
      const err = document.createElement("div");
      err.className = "mcd-offline-msg";
      // Show a clean reason — never expose raw Python exceptions to the user
      const reason = n.error ? cleanOfflineError(n.error) : "Not reachable";
      err.textContent = n.connection_state === 'review_required' ? 'Computer access needs review; no connection check was sent.' : n.connection_state === 'status_unsupported' ? 'Update this computer to check shared permissions. Existing reviewed operations remain available.' : knownOffline ? `Not reachable — ${reason}` : 'Current health is unavailable. Refresh to check again.';
      card.appendChild(err);
      return card;
    }
    if(!isSelf && Array.isArray(n.ready_grants)){
      const ready=document.createElement('p');ready.className='mcd-ai-row';
      ready.textContent='Connected · '+(n.ready_grants.length?n.ready_grants.map(g=>({messages:'Messages & files',observe:'Observations',coordinate:'Coordination',inference:'AI compute'}[g]||g)).join(' · '):'No shared permissions');
      card.appendChild(ready);
    }

    // ── Metrics ──
    const cpu = n.cpu_percent != null ? `${Math.round(n.cpu_percent)}%` : "—";
    const ram = n.ram_percent != null ? `${Math.round(n.ram_percent)}%` : "—";
    const disk = n.disk_percent != null ? `${Math.round(n.disk_percent)}%` : "—";
    const ramDetail = (n.ram_used_gb != null && n.ram_total_gb != null)
      ? `${n.ram_used_gb} / ${n.ram_total_gb} GB` : "";
    const diskFree = n.disk_free_gb != null ? `${n.disk_free_gb} GB free` : "";

    const metrics = document.createElement("div");
    metrics.className = "mcd-metrics";
    for (const [label, val, pct, sub] of [
      ["CPU",  cpu,  n.cpu_percent,  ""],
      ["RAM",  ram,  n.ram_percent,  ramDetail],
      ["Disk", disk, n.disk_percent, diskFree],
    ]) {
      const col = pctColor(pct);
      metrics.innerHTML += `
        <div class="mcd-metric">
          <div class="mcd-metric-val">${val}</div>
          <div class="mcd-metric-label">${label}</div>
          ${pct != null ? `<div class="mcd-metric-bar"><div class="mcd-metric-bar-fill ${col}" style="width:${Math.min(100,pct)}%"></div></div>` : ""}
          ${sub ? `<div style="font-size:10px;color:var(--text-soft);margin-top:3px">${escape(sub)}</div>` : ""}
        </div>`;
    }
    card.appendChild(metrics);

    // ── AI row ──
    const aiRow = document.createElement("div");
    aiRow.className = "mcd-ai-row";
    if (n.ai_healthy === true) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot running"></div>
        <div class="mcd-ai-label">AI Running</div>
          <div class="mcd-ai-sublabel">${escape(n.active_model || n.active_preset || "")}</div>`;
    } else if (n.has_ai === true) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot has"></div>
        <div class="mcd-ai-label">Model files reported</div>
        <div class="mcd-ai-sublabel">Installation completeness and running status not confirmed</div>`;
    } else if (n.has_ai === false) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot none"></div>
        <div class="mcd-ai-label">No bundled model reported</div>
        <div class="mcd-ai-sublabel">Other provider availability not confirmed</div>`;
    } else {
      aiRow.textContent = 'AI availability unknown';
    }
    card.appendChild(aiRow);

    // ── Uptime ──
    if (n.uptime_seconds != null) {
      const up = document.createElement("div");
      up.className = "mcd-uptime";
      up.textContent = `Uptime: ${fmtUptime(n.uptime_seconds)}`;
      card.appendChild(up);
    }

    return card;
  }

  function renderCached(force=false) {
    if (_locked || !_ready || document.hidden) return;
    const grid=fmt('mcd-grid');if(!grid)return;
    const cached=new Map((window.MeshService?.getPeers()?.peers||[]).map(peer=>[peer.id,peer]));
    const nodes=_lastNodes.map(node=>{const peer=cached.get(registryId(node));return project(peer&&!node.is_self?{...node,connection:peer.connection,online:peer.online,ready_grants:peer.ready_grants}:node);});
    const signature=JSON.stringify(nodes);if(!force&&signature===_lastRender)return;_lastRender=signature;
    grid.innerHTML='';
    if(!nodes.length){grid.innerHTML='<div class="mcd-loading">No TLI computers were returned by the latest check.</div>';return;}
    const sorted=[...nodes.filter(n=>n.is_self),...nodes.filter(n=>!n.is_self&&n.online!==false),...nodes.filter(n=>!n.is_self&&n.online===false)];
    for(const node of uniqueNodes(sorted))grid.appendChild(buildNodeCard(node));
  }

  async function refresh() {
    if(_locked||!_ready||document.hidden)return;
    const grid = fmt("mcd-grid");
    const btn  = fmt("mcd-refresh-btn");
    const updated = fmt("mcd-last-updated");
    if (!grid) return;
    if (_request) return;
    const epoch = _epoch;
    const request = {controller:new AbortController()};
    _request = request;
    const active = () => current(epoch) && _request === request && !document.hidden;
    const options = {cache:'no-store', credentials:'same-origin', signal:AbortSignal.any([request.controller.signal, AbortSignal.timeout(12000)])};

    if (btn) btn.classList.add("spinning");

    try {
      const r = await fetch("/api/mesh/health", options);
      if (!active()) return;
      if (r.status === 401 || r.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (!active()) return;
      if (!validHealth(data)) throw new Error('Incomplete computer health response');

      // Older running backends already identify pairing-eligible records but
      // omit their timestamps from health. Read the local directory only when
      // needed so a browser refresh also cleans up an older server's cards.
      const endpoints = new Set();
      const hasDuplicates = data.nodes.some(n => {
        const key = discoveryEndpoint(n); if (!key) return false;
        if (endpoints.has(key)) return true; endpoints.add(key); return false;
      });
      if (hasDuplicates && data.nodes.some(pendingDiscovery) && data.nodes.some(n => discoveryEndpoint(n) && !n.last_seen)) {
        try {
          // Keep this optional compatibility read in the same captured session.
          const response = await fetch('/mesh/directory', options);
          if (!active()) return;
          if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('tli-session-locked')); return; }
          if (!response.ok) throw Error('Directory unavailable');
          const directory = await response.json();
          if (!active()) return;
          const saved = new Map((directory.devices || []).map(n => [n.device_id, n]));
          data.nodes = data.nodes.map(n => ({...n, last_seen:n.last_seen || saved.get(registryId(n))?.last_seen}));
        } catch (_) { /* The server's exact identities remain available. */ }
        if (!active()) return;
      }

      _lastNodes = data.nodes;renderCached(true);

      _lastSuccess = new Date();
      grid.classList.remove('mcd-stale');
      if (updated) updated.textContent = "Last successful check: " + _lastSuccess.toLocaleTimeString();
      if (_visible) subscribe();
    } catch (e) {
      if (!active()) return;
      if (_lastSuccess) {
        renderCached();
        grid.classList.add('mcd-stale');
        if (updated) updated.textContent = 'Check unavailable. Previous results from ' + _lastSuccess.toLocaleTimeString() + ' may be out of date.';
      } else grid.textContent = 'Computer health is unavailable. Check the TLI connection, then choose Refresh.';
    } finally {
      if (_request === request) {
        _request = null;
        if (btn) btn.classList.remove("spinning");
      }
    }
  }

  function subscribe() {
    if (!_ready || _locked || !_visible || document.hidden) return;
    if(!_unsubscribe&&window.MeshService?.subscribePeers)_unsubscribe=window.MeshService.subscribePeers(()=>{if(_visible&&_lastSuccess)renderCached();});
    if(!_unsubscribeExpiry&&window.MeshService?.subscribeExpiry)_unsubscribeExpiry=window.MeshService.subscribeExpiry(()=>{if(_visible&&_lastSuccess)renderCached();});
  }

  function start() {
    _visible=true;
    if (_locked || !_ready || document.hidden) return;
    if(_lastSuccess)renderCached();
    refresh();
    if (!_timer) _timer = setInterval(refresh, REFRESH_INTERVAL);
  }

  function stop(keepVisible=false) {
    if (!keepVisible) _visible=false;
    _epoch++; _request?.controller.abort(); _request=null; _lastRender='';
    fmt('mcd-refresh-btn')?.classList.remove('spinning');
    _unsubscribe?.();_unsubscribe=null;
    _unsubscribeExpiry?.();_unsubscribeExpiry=null;
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  // Wire refresh button
  function boot() {
    const btn = fmt("mcd-refresh-btn");
    if (btn && !btn.__mcdBound) {
      btn.__mcdBound = true;
      btn.addEventListener("click", () => {
        if (_locked) return;
        if (!_ready) return window.EventInterpreter?.retry?.();
        return refresh();
      });
    }

    // Start/stop polling when panel is opened/closed
    document.addEventListener("tli-panel-switched", (e) => {
      if (e.detail && e.detail.panelId === "panel-mesh") {
        start();
      } else {
        stop();
      }
    });
    for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event, () => {
      _locked=true;_ready=false;stop(true); _lastSuccess = null; _lastNodes=[];_lastRender='';
      const grid = fmt('mcd-grid'); if (grid) { grid.replaceChildren(); grid.textContent = 'Unlock TLI to check connected computers.'; grid.classList.remove('mcd-stale'); }
      const updated = fmt('mcd-last-updated'); if (updated) updated.textContent = '';
    });
    window.addEventListener('tli-session-unlocked',()=>{
      _locked=false;stop(true);
      if (!_ready) { const grid=fmt('mcd-grid'); if(grid)grid.textContent='Computer access needs a fresh check. Choose Refresh after unlocking; if the PIN is off, use a clean private window on localhost.'; }
    });
    window.addEventListener('tli-private-observation-ready',()=>{
      if (_locked) return;
      const recovering = !_ready; _ready=true;
      const panel=fmt('panel-mesh');
      if ((recovering || !_timer) && (_visible || (panel&&!panel.hidden&&!panel.classList.contains('hidden')))) start();
    });
    window.addEventListener('tli-peer-trust-changed',()=>{if(_visible)refresh();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stop(true);else if(_visible)start();});
    window.addEventListener('pagehide',()=>{_locked=true;_ready=false;stop();_lastSuccess=null;_lastNodes=[];_lastRender='';const grid=fmt('mcd-grid');if(grid)grid.replaceChildren();const updated=fmt('mcd-last-updated');if(updated)updated.textContent='';});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
