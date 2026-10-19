// TLI Chat (LAN Mesh Messenger)
(() => {
  const $ = (id) => document.getElementById(id);
  let _lanLocked=document.getElementById('tli-lock-screen')?.getAttribute?.('aria-hidden') === 'false',_lanEpoch=0;
  let _lanReady=!_lanLocked,_identityReady=false,_identityRequest=null;
  let _panelOpen = false, _panelEpoch = 0, _bgPollPending = null, _unsubscribeExpiry = null;
  const _lanSessionCurrent=t=>!_lanLocked&&_lanReady&&t===_lanEpoch;
  const _lanAlive=t=>_lanSessionCurrent(t)&&_identityReady;
  const _panelVisible = () => _panelOpen && !document.hidden && !_lanLocked && _lanReady;


  // -----------------------------
  // Config
  // -----------------------------
  const SHARE_CONFIRM_GB = 5;
  const BYTES_IN_GB = 1024 * 1024 * 1024;

  const PRESENCE_OFFLINE_MS = 10 * 60 * 1000;
  const REFRESH_MS = 3500;

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    selectedNodeId: null,

    // rawNodes = "source of truth" (before search filtering)
    rawNodes: [],

    // nodes = filtered view (after search)
    nodes: [],

    threads: new Map(),
    drafts: new Map(),
    transfers: [],

    refreshTimer: null,
    presenceEs: null,
    bound: false,

    lastDirectoryOk: false,
    nodeSearch: "",
    previousOpen: false,

    localNodeId: null,
    localNodeName: "",
  };

  // Chat polling
  let _chatPollTimer   = null;
  let _bgPollTimer     = null;
  let _typingPollTimer = null;
  let _typingSendTimer = null;    // debounce handle for outgoing typing signal
  let _typingClearTimer = null;   // auto-clear typing indicator after inactivity
  const _chatLastTs    = {};      // threadId → last seen ts
  const _chatCursors   = {};      // host journal order, independent of sender clocks
  const _readReceipts  = {};      // threadId → { peerId: up_to_ts } — what peer has read
  let _typingState     = false;   // is peer currently typing in active thread

  // -----------------------------
  // Utilities
  // -----------------------------
  function nowTs() { return Date.now(); }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function genId() {
    try {
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {}
    return `tli_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    const gb = bytes / BYTES_IN_GB;
    if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
    const kb = bytes / 1024;
    return `${Math.max(1, Math.round(kb))} KB`;
  }

  function parseLastSeen(value) {
    if (value == null) return null;
    if (typeof value === "number") return value < 2e10 ? value * 1000 : value;
    if (typeof value === "string") {
      const t = Date.parse(value);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  }

  function normalizeStatusFromLastSeen(lastSeenMs) {
    return Number.isFinite(lastSeenMs) && lastSeenMs > 0 && nowTs() - lastSeenMs < PRESENCE_OFFLINE_MS ? 'discovered' : 'unknown';
  }

  const connectionNow = receipt => window.MeshService?.projectConnection(receipt) || {state:'unknown',fresh:false,online:null,ready_grants:[]};
  function projectNode(node) {
    if(node.id==='__local_loopback__')return node;
    const connection=connectionNow(node.connection);
    return {...node,connection,online:connection.online===true,status:connection.online===true?'online':connection.online===false?'offline':'unknown'};
  }
  function expireConnections() {
    if(!_panelVisible())return;
    const projected=state.rawNodes.map(projectNode);
    if(JSON.stringify(projected)===JSON.stringify(state.rawNodes))return;
    state.rawNodes=projected;state.nodes=applyNodeSearch(projected);
    renderBuddyList();renderHeaderLivePill();updateComposerState();
    if(state.selectedNodeId)renderThread(state.selectedNodeId);
  }

  function presenceClass(status) {
    switch ((status || "").toLowerCase()) {
      case "online": return "tli-presence-online";
      case "idle": return "tli-presence-idle";
      case "busy": return "tli-presence-busy";
      case "sleep": return "tli-presence-sleep";
      default: return "tli-presence-offline";
    }
  }

  function ensureThread(nodeId) {
    if (!state.threads.has(nodeId)) state.threads.set(nodeId, []);
    return state.threads.get(nodeId);
  }

  async function safeFetchJson(url) {
    if(!_lanAlive(_lanEpoch))return null;const epoch=_lanEpoch;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const data=await res.json();return _lanAlive(epoch)?data:null;
    } catch {
      return null;
    }
  }

  // -----------------------------
  // Chat transport helpers
  // -----------------------------
  function makeThreadId(nodeId) {
    const ids = [state.localNodeId, nodeId].sort();
    return ids.join("--");
  }

  function showIdentityUnavailable() {
    const list=$('tli-chat-buddies-list');
    if(list){
      list.replaceChildren();
      const message=document.createElement('p');message.textContent=_lanLocked||!_lanReady?'Unlock TLI and check access to read this computer’s identity.':'This computer’s identity is unavailable. Check saved identity before messaging. Your draft stays here.';
      const button=document.createElement('button');button.type='button';button.className='btn btn-ghost';button.textContent=_lanReady?'Check computer identity':'Check access';button.disabled=_lanLocked;
      const epoch=_lanEpoch;button.addEventListener('click',()=>{if(_lanLocked||epoch!==_lanEpoch)return;if(!_lanReady)return window.EventInterpreter?.retry?.();return resumePanel();});
      list.appendChild(message);list.appendChild(button);
    }
    const meta=$('tli-chat-buddies-meta');if(meta)meta.textContent='—';
    const pill=$('tli-chat-live-pill');if(pill)pill.textContent='Computer identity unavailable';
    updateComposerState();
  }
  async function loadLocalNodeIdentity() {
    if(!_lanSessionCurrent(_lanEpoch))return false;
    if(_identityRequest)return _identityRequest.promise;
    const request={epoch:_lanEpoch,promise:null};_identityRequest=request;_identityReady=false;
    stopChatPolling();stopPresenceStream();stopBgPoll();
    request.promise=(async()=>{
      try {
        const r=await fetch('/mesh/node',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
        if(!_lanSessionCurrent(request.epoch)||_identityRequest!==request)return false;
        if(r.status===401||r.status===403){window.dispatchEvent(new CustomEvent('tli-session-locked'));return false;}
        if(!r.ok)throw Error('Identity unavailable');
        const d=await r.json();if(!_lanSessionCurrent(request.epoch)||_identityRequest!==request)return false;
        const text=value=>typeof value==='string'&&!!value.trim();
        if(!d||typeof d!=='object'||Array.isArray(d)||!text(d.node_id)||!text(d.display_name))throw Error('Identity incomplete');
        state.localNodeId=d.node_id;state.localNodeName=d.display_name;_identityReady=true;return true;
      } catch {
        if(!_lanSessionCurrent(request.epoch)||_identityRequest!==request)return false;
        state.localNodeId=null;state.localNodeName='';state.lastDirectoryOk=false;showIdentityUnavailable();return false;
      } finally {if(_identityRequest===request)_identityRequest=null;}
    })();return request.promise;
  }

  function startChatPolling(nodeId) {
    stopChatPolling();
    if (!_panelVisible()) return;
    _chatPollTimer = setInterval(() => {
      pollChatMessages(nodeId);
      fetchReadReceipts(nodeId);
    }, 3000);
  }

  function stopChatPolling() {
    if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
  }

  // Keep unread notifications while another TLI panel is open, without retaining
  // a presence stream. Hidden browser tabs catch up when they become visible.
  async function pollBackgroundMessages() {
    if (!_lanAlive(_lanEpoch) || document.hidden || _bgPollPending) return;
    const epoch = _lanEpoch;
    _bgPollPending = (async () => {
      for (const node of state.rawNodes || []) {
        if (!_lanAlive(epoch) || document.hidden) return;
        if (!node.id || node.id === state.localNodeId) continue;
        if (_panelVisible() && node.id === state.selectedNodeId) continue;
        await pollChatMessages(node.id);
      }
    })();
    try { await _bgPollPending; } finally { _bgPollPending = null; }
  }

  function startBgPoll() {
    if (_bgPollTimer || !_lanAlive(_lanEpoch) || document.hidden) return;
    _bgPollTimer = setInterval(pollBackgroundMessages, 10_000);
  }

  function stopBgPoll() {
    if (_bgPollTimer) { clearInterval(_bgPollTimer); _bgPollTimer = null; }
  }

  // ── Typing indicator ────────────────────────────────────────────────

  function startTypingPoll(nodeId) { stopTypingPoll(); }

  function stopTypingPoll() {
    if (_typingPollTimer) { clearInterval(_typingPollTimer); _typingPollTimer = null; }
    if (_typingState) { _typingState = false; renderTypingIndicator(false, ""); }
  }

  function sendTypingSignal(nodeId) { /* Peer typing is not part of the reviewed text grant. */ }

  function renderTypingIndicator(isTyping, fromName) {
    const out = $("tli-chat-thread-output");
    if (!out) return;
    const existing = out.querySelector(".tchat-typing-row");
    if (!isTyping) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return; // already showing
    const row = document.createElement("div");
    row.className = "tchat-typing-row";
    row.innerHTML = `
      <div class="tchat-avatar them">${_nameInitial(fromName || "?")}</div>
      <div class="tchat-typing-bubble">
        <span class="tchat-typing-dot"></span>
        <span class="tchat-typing-dot"></span>
        <span class="tchat-typing-dot"></span>
      </div>
    `;
    out.appendChild(row);
    out.scrollTop = out.scrollHeight;
  }

  // ── Read receipts ────────────────────────────────────────────────────

  function sendReadReceipt(nodeId) { /* Delivery acknowledgement is distinct from a remote read. */ }

  async function fetchReadReceipts(nodeId) { return; }

  async function pollChatMessages(nodeId) {
    if(!_lanAlive(_lanEpoch) || document.hidden)return;const epoch=_lanEpoch;
    if (!nodeId) return;
    const threadId = makeThreadId(nodeId);
    const since = _chatLastTs[threadId] || 0;
    const requestedCursor = _chatCursors[threadId] || 0;

    // Collect raw messages from both local store and peer's store (pull-based delivery)
    const allMsgs = [];
    const seen = new Set();

    const addMsgs = (msgs) => {
      for (const m of (msgs || [])) {
        const key = (m.message_id || m.ts) + "|" + m.from_id;
        if (!seen.has(key)) { seen.add(key); allMsgs.push(m); }
      }
    };

    // 1) Local store (messages received by push, stored here)
    try {
      const r = await fetch(
        `/mesh/chat/messages?thread_id=${encodeURIComponent(threadId)}&cursor=${requestedCursor}&since=${since}`,
        { cache: "no-store" }
      );
      if (r.ok) { const data = await r.json(); if (!_lanAlive(epoch)) return; addMsgs(data.messages);
        if (Number.isSafeInteger(data.next_cursor) && data.next_cursor >= 0) {
          // A slower concurrent poll must not rewind a newer arrival cursor.
          const currentCursor = _chatCursors[threadId] || 0;
          if (data.cursor_reset && currentCursor === requestedCursor) _chatCursors[threadId] = data.next_cursor;
          else _chatCursors[threadId] = Math.max(currentCursor, data.next_cursor);
        } }
    } catch {}

    // Received messages are stored locally by the authenticated peer endpoint.

    if(!_lanAlive(epoch) || document.hidden)return;
    // Include ALL messages (own + peer) so history survives refresh.
    // Direction determined by from_id vs localNodeId.
    if (!allMsgs.length) return;

    const thread = ensureThread(nodeId);
    const existingIds = new Set(thread.map(m => m._msgId).filter(Boolean));
    let added = 0;
    for (const m of allMsgs) {
      // Use client ts; fall back to server_ts if missing or implausibly small (<2020)
      const msgTs = (m.ts && m.ts > 1577836800000) ? m.ts : (m.server_ts || m.ts || 0);
      const key = (m.message_id || msgTs) + "|" + m.from_id;
      if (existingIds.has(key)) continue;

      const isOwn = m.from_id === state.localNodeId;

      // Detect AI reply broadcast
      if (typeof m.body === "string" && m.body.startsWith("__AI_REPLY__:")) {
        try {
          const meta = JSON.parse(m.body.slice("__AI_REPLY__:".length));
          thread.push({
            kind:     "ai",
            from:     "ai",
            body:     meta.reply || "",
            question: meta.question || "",
            ts:       msgTs,
            _msgId:   key,
          });
        } catch {
          thread.push({ kind: "text", from: isOwn ? "me" : "them", body: m.body, ts: msgTs, _msgId: key });
        }
        if (msgTs > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = msgTs;
        added++;
        continue;
      }

      // Detect file offer signals written by /mesh/transfer/store
      if (typeof m.body === "string" && m.body.startsWith("__FILE_OFFER__:")) {
        if (!isOwn) {
          try {
            const meta = JSON.parse(m.body.slice("__FILE_OFFER__:".length));
            const senderNode = (state.rawNodes || []).find(n => n.id === m.from_id);
            // Historical downloads require the reviewed HTTPS computer and
            // its normal browser authentication; never guess an HTTP address.
            const reviewed = window.meshDirectoryCache?.devices?.find(n=>n.device_id===m.from_id);
            let serveBase="";
            try{const u=new URL(reviewed?.origin);if(reviewed.status==='allowed'&&reviewed.trust_state==='verified'&&u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/')serveBase=u.origin;}catch{}
            thread.push({
              kind:         "file",
              direction:    "incoming",
              id:           key,
              name:         meta.name,
              size:         meta.size,
              token:        meta.token,
              from_name:    m.from_name,
              download_url: serveBase ? `${serveBase}/mesh/transfer/serve/${encodeURIComponent(meta.token)}` : "",
              status:       "incoming",
              ts:           msgTs,
              _msgId:       key,
            });
            // Show toast if thread not currently open
            if (!_panelVisible() || state.selectedNodeId !== nodeId) {
              _showFileToast(meta.name, meta.size, m.from_name, serveBase ? `${serveBase}/mesh/transfer/serve/${encodeURIComponent(meta.token)}` : "", key, nodeId);
            }
          } catch {
            thread.push({ kind: "text", from: "them", body: m.body, ts: msgTs, _msgId: key });
          }
        }
        // skip own file offers — they're already in thread via createOutgoingFileOffer
      } else {
        thread.push({ kind: "text", from: isOwn ? "me" : "them", body: m.body, ts: msgTs, _msgId: key });
        // Toast only for peer messages when thread isn't open
        if (!isOwn && (!_panelVisible() || state.selectedNodeId !== nodeId)) {
          _showMsgToast(m.from_name || "Peer", m.body, nodeId);
        }
      }

      if (msgTs > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = msgTs;
      added++;
    }
    if (added > 0 && _panelVisible() && state.selectedNodeId === nodeId) {
      renderThread(nodeId);
      sendReadReceipt(nodeId);  // auto-mark read when viewing thread
    }
  }

  // -----------------------------
  // Local Loopback (for testing with 1 device)
  // -----------------------------
  function getLocalDeviceName() {
    const footer = document.getElementById("footer-device");
    if (footer && footer.textContent.trim()) return footer.textContent.trim();
    return "This Device";
  }

  function makeLocalLoopbackNode() {
    const name = getLocalDeviceName();
    return {
      id: "__local_loopback__",
      name: `${name} (Local Loopback)`,
      role: "Local",
      room: "This device",
      ip: "127.0.0.1",
      lastSeenMs: Date.now(),
      status: "online",
    };
  }

  // -----------------------------
  // LAN peers mapping (from /api/lan/peers)
  // -----------------------------
  function mapLanPeersToNodes(data) {
    const peers = Array.isArray(data?.peers) ? data.peers : [];
    return peers.map(p => projectNode({
      id:         String(p.id || p.name || "peer"),
      name:       String(p.name || p.id || "Unknown TLI Node"),
      role:       p.peer_profile === 'inference_node' ? "AI compute Node" : "TLI computer",
      room:       String(p.ip || ""),
      ip:         String(p.ip || ""),
      port:       Number(p.port || 8000),
      lastSeenMs: p.last_seen ? Date.parse(p.last_seen) : 0,
      online:     p.online === true,
      status:     p.online === true ? "online" : p.online === false ? "offline" : "unknown",
      connection: p.connection || null,
      discoveredRecently: p.discovered_recently === true,
      reviewedGrants: p.reviewed_grants || [],
      accessStatus: p.status || "pending",
      trustState: p.trust_state || "review_required",
      peerProfile: p.peer_profile || "host",
      messaging: p.messaging || null,
      previousDiscovery: p.previous_discovery === true,
      supersededBy: typeof p.superseded_by === 'string' ? p.superseded_by : null,
    }));
  }

  function messagingState(node) {
    if(!_lanAlive(_lanEpoch))return {available:false,code:'identity_unavailable',message:'This computer’s identity must be checked before messaging. Your draft stays here.'};
    if (!node) return {available: false, code: 'peer_missing', message: 'This computer is no longer in the directory. Refresh its connection before sending.'};
    if (node.id === '__local_loopback__') return {available: true, code: 'local', message: 'Notes stay on this computer.'};
    if (node.previousDiscovery) return {available:false, code:'previous_discovery', message:'This is an older discovery record. Its conversation and draft stay here. Select the current computer to request a connection.'};
    if (!state.lastDirectoryOk) return {available: false, code: 'unavailable', message: 'Message permissions could not be checked. Refresh status before sending. Your draft stays here.'};
    if (node.peerProfile === 'inference_node') return {available: false, code: 'inference_only', message: 'This TLI Node offers AI compute only. Use its models in Ask TLI.'};
    const connection=connectionNow(node.connection);
    if(connection.state==='connected'&&connection.fresh&&connection.ready_grants.includes('messages'))return {available:true,code:'checked',message:'Messages available on both computers.'};
    if (node.connection) return {available:false,code:connection.reason?.code||'connection_not_ready',message:connection.reason?.message||'Check this saved connection before sending. Your draft stays here.'};
    if (node.accessStatus === 'blocked') return {available: false, code: 'peer_not_allowed', message: 'Access to this computer is blocked here. Review its identity and text-message permission to reconnect.'};
    if (node.accessStatus !== 'allowed' || node.trustState !== 'verified') return {available: false, code: 'review_required', message: 'Text messages need a trust review here. Both computers must review each other’s identity and text-message permission.'};
    return {available: false, code: 'permission_unknown', message: 'Text-message permission could not be checked. Update TLI on this computer, then refresh status.'};
  }

  function reviewComputer(nodeId) {
    if (_lanLocked) return;
    const node = state.rawNodes.find(n=>n.id===nodeId);
    if(window.TLIConnectDevice?.open)window.TLIConnectDevice.open({kind:node?.peerProfile==='inference_node'?'node':'computer',deviceId:nodeId});
    else if (window.TLIPeerTrust?.open) window.TLIPeerTrust.open({deviceId: nodeId, name: node?.name, purpose: 'messages'});
    else window.switchPanel?.('panel-mesh');
  }

  // -----------------------------
  // Mesh directory mapping
  // -----------------------------
  function mapMeshDirectoryToNodes(data) {
    const nodes = [];

    const devices = Array.isArray(data?.devices) ? data.devices
                  : Array.isArray(data?.nodes) ? data.nodes
                  : [];

    const host = data?.host || data?.Host || null;

    if (host) {
      const id = String(host.id || host.nodeId || host.name || "Host");
      const lastSeenMs = parseLastSeen(host.lastSeen || host.last_seen || host.seenAt || host.heartbeat);
      nodes.push({
        id,
        name: String(host.name || id),
        role: "Host",
        room: String(host.room || host.location || "—"),
        ip: String(host.ip || host.addr || host.address || ""),
        lastSeenMs,
        connection: host.connection || null,
        status: connectionNow(host.connection).online===true?'online':normalizeStatusFromLastSeen(lastSeenMs),
      });
    }

    for (const d of devices) {
      const id = String(d.device_id || d.id || d.nodeId || d.name || d.hostname || "Node");
      const lastSeenMs = parseLastSeen(d.last_seen || d.lastSeen || d.seenAt || d.heartbeat);
      nodes.push({
        id,
        name: String(
  d.display_name ||
  d.nickname ||
  d.displayName ||
  d.name ||
  d.hostname ||
  d.device_id ||
  d.id ||
  d.nodeId ||
  "Unknown Node"
),

        role: String(d.role || d.nodeRole || (d.is_host ? "Host" : "Member")),
        room: String(d.room || d.location || "—"),
        ip: String(d.ip || d.addr || d.address || ""),
        lastSeenMs,
        connection: d.connection || null,
        status: connectionNow(d.connection).online===true?'online':normalizeStatusFromLastSeen(lastSeenMs),
      });
    }

    // Dedup
    const seen = new Set();
    const deduped = [];
    for (const n of nodes) {
      if (!n.id) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (!n.status || n.status === "—") n.status = normalizeStatusFromLastSeen(n.lastSeenMs);
      deduped.push(n);
    }

    // Sort
    const rank = (s) =>
      s === "online" ? 0 : s === "idle" ? 1 : s === "busy" ? 2 : s === "sleep" ? 3 : 9;

    deduped.sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return String(a.name).localeCompare(String(b.name));
    });

    return deduped;
  }

  // -----------------------------
  // Search filter (never wipes loopback)
  // -----------------------------
  function applyNodeSearch(nodes) {
    const q = (state.nodeSearch || "").trim().toLowerCase();
    if (!q) return nodes;

    return nodes.filter(n => {
      const hay = `${n.name} ${n.id} ${n.role} ${n.room} ${n.ip}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // -----------------------------
  // -----------------------------
  // SSE Presence stream
  // -----------------------------
  function startPresenceStream() {
    if (!_panelVisible() || state.presenceEs) return;
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    const epoch=_lanEpoch;
    const es = new EventSource("/mesh/presence/stream");
    state.presenceEs = es;

    es.onmessage = (e) => {
      if(!_lanAlive(epoch)||!_panelVisible()||state.presenceEs!==es)return;
      try { handlePresenceEvent(JSON.parse(e.data)); } catch {}
    };

    es.onerror = () => {
      if(!_lanAlive(epoch)||!_panelVisible()||state.presenceEs!==es)return;
      // SSE failed — fall back to polling
      stopPresenceStream();
      if (!state.refreshTimer) {
        state.refreshTimer = setInterval(() => { if (_panelVisible()) refreshNodes(); }, REFRESH_MS);
      }
    };
  }

  function stopPresenceStream() {
    if (state.presenceEs) {
      state.presenceEs.close();
      state.presenceEs = null;
    }
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  function handlePresenceEvent(evt) {
    const type = evt.type;
    if(type==='directory_changed'||type==='connection_changed'){refreshNodes();return;}

    if (type === "node_online") {
      const nodeId = evt.node_id;
      if (!nodeId || nodeId === state.localNodeId) return;
      // Beacons report presence, not permission. Read the local reviewed state.
      refreshNodes();

    } else if (type === "message_incoming") {
      const fromId = evt.from_id;
      if (!fromId || fromId === state.localNodeId) return;

      if (state.selectedNodeId === fromId) {
        // Thread is open — fetch immediately instead of waiting for poll interval
        pollChatMessages(fromId);
      } else {
        // Thread not open — mark as unread
        if (!state.unread) state.unread = {};
        state.unread[fromId] = (state.unread[fromId] || 0) + 1;
        renderBuddyList();
      }

    } else if (type === "node_offline") {
      const nodeId = evt.node_id;
      if (!nodeId) return;

      const node = state.rawNodes.find(n => n.id === nodeId);
      if (node && !node.connection) { node.online = false; node.status = 'unknown'; }
      state.nodes = applyNodeSearch(state.rawNodes);
      // Keep the exact recipient, saved history, and draft when presence expires.
      if (state.selectedNodeId === nodeId) renderThread(nodeId);

      renderBuddyList();
      renderHeaderLivePill();
      updateComposerState();

    } else if (type === "typing") {
      // Peer is typing — only relevant if active thread matches
      if (!evt.thread_id || !evt.from_id) return;
      if (evt.from_id === state.localNodeId) return;
      const expectedThread = state.selectedNodeId ? makeThreadId(state.selectedNodeId) : null;
      if (evt.thread_id !== expectedThread) return;
      if (_typingState !== true) {
        _typingState = true;
        renderTypingIndicator(true, evt.from_name || "");
      }
      // Auto-clear after 6s if no further typing events
      clearTimeout(_typingClearTimer);
      _typingClearTimer = setTimeout(() => {
        _typingState = false;
        renderTypingIndicator(false, "");
      }, 6000);

    } else if (type === "read_receipt") {
      if (!evt.thread_id) return;
      if (!_readReceipts[evt.thread_id]) _readReceipts[evt.thread_id] = {};
      const existing = _readReceipts[evt.thread_id][evt.reader_id] || 0;
      if ((evt.up_to_ts || 0) > existing) {
        _readReceipts[evt.thread_id][evt.reader_id] = evt.up_to_ts;
        // Re-render if active
        if (state.selectedNodeId) {
          const t = makeThreadId(state.selectedNodeId);
          if (t === evt.thread_id) renderThread(state.selectedNodeId);
        }
      }
    }
  }


  function _showMsgToast(fromName, body, nodeId) {
    // Deduplicate: one message toast at a time per sender
    const toastId = `tli-msg-toast-${nodeId}`;
    const old = document.getElementById(toastId);
    if (old) old.remove();

    const preview = (body || "").slice(0, 80) + ((body || "").length > 80 ? "…" : "");

    const toast = document.createElement("div");
    toast.id = toastId;
    toast.className = "tli-msg-toast";
    toast.innerHTML = `
      <div class="tli-msg-toast-avatar">${escapeHtml(_nameInitial(fromName))}</div>
      <div class="tli-msg-toast-body">
        <div class="tli-msg-toast-name">${escapeHtml(fromName)}</div>
        <div class="tli-msg-toast-preview">${escapeHtml(preview)}</div>
      </div>
      <button class="tli-msg-toast-close" aria-label="Dismiss">✕</button>
    `;

    toast.addEventListener("click", (e) => {
      if (e.target.classList.contains("tli-msg-toast-close")) { toast.remove(); return; }
      // Open the thread
      const node = (state.rawNodes || []).find(n => n.id === nodeId);
      if (node) {
        state.selectedNodeId = nodeId;
        renderBuddyList();
        renderThread(nodeId);
        startChatPolling(nodeId);
        if (_isMobile()) _setChatMobileView("thread");
      }
      toast.remove();
    });

    document.body.appendChild(toast);
    // Stack below any existing file toast
    const existingFile = document.querySelector(".tli-file-toast");
    if (existingFile) {
      const fileRect = existingFile.getBoundingClientRect();
      toast.style.bottom = (window.innerHeight - fileRect.top + 8) + "px";
    }

    setTimeout(() => { try { toast.remove(); } catch {} }, 6000);
  }

  function _showFileToast(filename, size, fromName, downloadUrl, msgId, threadKey) {
    // Remove any existing file-toast
    const old = document.querySelector(".tli-file-toast");
    if (old) old.remove();

    const toast = document.createElement("div");
    toast.className = "tli-file-toast";
    toast.innerHTML = `
      <div class="tli-file-toast-icon">📦</div>
      <div class="tli-file-toast-body">
        <div class="tli-file-toast-title">Incoming file from <strong>${escapeHtml(fromName)}</strong></div>
        <div class="tli-file-toast-name">${escapeHtml(filename)} &nbsp;·&nbsp; ${escapeHtml(formatBytes(size))}</div>
      </div>
      <div class="tli-file-toast-actions">
        <button class="tli-file-toast-btn primary" data-action="save">Save</button>
        <button class="tli-file-toast-btn" data-action="dismiss">Dismiss</button>
      </div>
    `;

    toast.querySelector("[data-action='save']").addEventListener("click", () => {
      if (downloadUrl) {
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = filename;
        a.click();
        // A browser request does not prove that saving succeeded
        const t = ensureThread(threadKey);
        const msg = t.find(x => x.id === msgId);
        if (msg) msg.status = "download requested";
        if (state.selectedNodeId) renderThread(state.selectedNodeId);
      }
      toast.remove();
    });

    toast.querySelector("[data-action='dismiss']").addEventListener("click", () => {
      toast.remove();
    });

    document.body.appendChild(toast);

    // Auto-dismiss after 30 s
    setTimeout(() => { try { toast.remove(); } catch {} }, 30_000);
  }

  // -----------------------------
  // Refresh nodes
  // -----------------------------
  async function refreshNodes() {
    if(!_lanAlive(_lanEpoch))return;const epoch=_lanEpoch;
    // Discovery is automatic; messaging readiness comes from reviewed local state.
    // Previous discoveries retain separate identities, history and drafts.
    let lanData = null;
    try {
      lanData = await safeFetchJson("/api/lan/peers");
    } catch {
      lanData = null;
    }

    if(!_lanAlive(epoch))return;
    state.lastDirectoryOk = !!(lanData && Array.isArray(lanData.peers));

    const mapped = state.lastDirectoryOk ? mapLanPeersToNodes(lanData) : state.rawNodes.map(projectNode);

    state.rawNodes = mapped;
    state.nodes = applyNodeSearch(mapped);

    // Keep a selected recipient and its draft if discovery temporarily disappears.

    renderBuddyList();
    renderHeaderLivePill();
    updateComposerState();

    // Keep global mesh UI (header + tags) in sync
    try { syncMeshContextTags(); } catch {}

    if (state.selectedNodeId) renderThread(state.selectedNodeId);
  }

  function renderHeaderLivePill() {
    const pill = $("tli-chat-live-pill");
    if (!pill) return;

    if (!state.lastDirectoryOk) {
      pill.textContent = "Searching…";
      return;
    }

    const onlineish = state.rawNodes.filter(n => !n.previousDiscovery && connectionNow(n.connection).online === true).length;
    const known=state.rawNodes.filter(n=>!n.previousDiscovery).length;
    pill.textContent = onlineish ? `${onlineish} connected` : known ? `${known} computers · select to check` : 'No peers yet';
  }

  // -----------------------------
  // Rendering: Buddy list
  // -----------------------------
  function renderBuddyList() {
    const list = $("tli-chat-buddies-list");
    const meta = $("tli-chat-buddies-meta");
    if (!list) return;

    const currentNodes = state.nodes.filter(n => !n.previousDiscovery);
    const previousNodes = state.nodes.filter(n => n.previousDiscovery);
    const onlineCount = currentNodes.filter(n => connectionNow(n.connection).online === true).length;
    if (meta) meta.textContent = state.rawNodes.length === 0 ? "—" : `${onlineCount}/${currentNodes.length}`;

    list.innerHTML = "";

    if (state.rawNodes.length === 0) {
      // No peers at all — show a waiting state
      list.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No other TLI nodes found</div>
          <div class="tli-empty-sub">Once another device on your LAN runs TLI, it will appear here automatically.</div>
        </div>
      `;
      return;
    }

    if (state.nodes.length === 0) {
      // Peers exist but search filtered them all out
      list.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No nodes match</div>
          <div class="tli-empty-sub">Try clearing the search.</div>
        </div>
      `;
      return;
    }

    let previousList;
    if (previousNodes.length) {
      previousList = document.createElement('details'); previousList.className = 'tli-chat-previous-discoveries';
      previousList.open = state.previousOpen;
      previousList.addEventListener('toggle', () => { state.previousOpen = previousList.open; });
      const summary = document.createElement('summary'); summary.textContent = `Previous discoveries (${previousNodes.length})`;
      previousList.appendChild(summary);
    }
    for (const n of [...currentNodes, ...previousNodes]) {
      const row = document.createElement("div");
      row.className = "tli-chat-buddy" + (state.selectedNodeId === n.id ? " active" : "");
      row.setAttribute('data-node-id', n.id);
      row.addEventListener("click", () => openThread(n.id));

      const unreadCount = (state.unread && state.unread[n.id]) || 0;
      const unreadBadge = unreadCount > 0
        ? `<span class="tli-chat-unread-badge">${unreadCount}</span>`
        : "";
      const duplicate = n.previousDiscovery || currentNodes.some(other => other.id !== n.id && (other.name === n.name || (n.ip && other.ip === n.ip)));
      const access = messagingState(n);
      const accessLabel = n.previousDiscovery ? 'Previous discovery · saved conversation' : access.available ? 'Messages reviewed here' : n.accessStatus === 'blocked' ? 'Blocked here' : n.peerProfile === 'inference_node' ? 'AI compute only' : 'Review messages';

      row.innerHTML = `
        <div class="tli-presence-dot ${presenceClass(n.status)}"></div>
        <div class="tli-chat-buddy-text">
          <div class="tli-chat-buddy-name">${escapeHtml(n.name)}${unreadBadge}</div>
          <div class="tli-chat-buddy-sub">${escapeHtml(`${n.room} · ${n.role}`)}</div>
          <div class="tli-chat-buddy-sub">${escapeHtml(accessLabel)}</div>
          ${duplicate ? `<div class="tli-chat-buddy-identity" title="${escapeHtml(n.id)}">ID ${escapeHtml(n.id)}</div>` : ''}
        </div>
        <div class="tli-chat-buddy-actions" aria-label="Node quick actions">
          <div class="tli-chat-buddy-action" title="Open Visualizer" data-action="visualizer">📊</div>
          <div class="tli-chat-buddy-action" title="Open Tools" data-action="tools">🧰</div>
        </div>
      `;

      // Wire quick actions without triggering row selection
      const actions = row.querySelectorAll(".tli-chat-buddy-action");
      actions.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const action = btn.getAttribute("data-action") || "";

          // Local loopback routes to local panels
          if (n.id === "__local_loopback__") {
            if (action === "visualizer") switchPanel("panel-visualizer");
            if (action === "tools") switchPanel("panel-tools");
            return;
          }

          // Remote open (best-effort): use MeshService when possible
          if (window.MeshService && typeof window.MeshService.openNodePanel === "function") {
            window.MeshService.openNodePanel(n, action);
            return;
          }

          // Fallback: open remote console root
          if (n.ip) {
            const remotePort = n.port || 8000;
            window.open(`https://${n.ip}:${remotePort}/`, "_blank", "noopener");
          }
        });
      });

      (n.previousDiscovery ? previousList : list).appendChild(row);
    }
    if (previousList) list.appendChild(previousList);
  }

  // -----------------------------
  // Rendering: Thread
  // -----------------------------
  // ── Chat timestamp helpers ─────────────────────────────────────────
  function _fmtMsgTime(ts) {
    if (!ts || ts < 1577836800000) return ""; // guard: pre-2020 or missing
    // ts is always milliseconds (Date.now() / time.time()*1000 from backend)
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return timeStr;
    const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${dateStr} · ${timeStr}`;
  }

  function _fmtDaySeparator(ts) {
    if (!ts || ts < 1577836800000) return null; // skip messages with bad/missing ts
    const d = new Date(ts);
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  }

  function _nameInitial(name) {
    return (name || "?").trim().charAt(0).toUpperCase();
  }

  function renderThread(nodeId) {
    const out = $("tli-chat-thread-output");
    const title = $("tli-chat-thread-title");
    const meta = $("tli-chat-thread-meta");
    if (!out || !title) return;

    if (!nodeId) {
      title.textContent = "TLI Chat";
      if (meta) meta.innerHTML = "";
      out.innerHTML = `
        <div class="tli-empty-state">
          <div class="tli-empty-title">Ready when you are</div>
          <div class="tli-empty-sub">Pick a node on the left to start chatting.</div>
        </div>
      `;
      return;
    }

    const node = (state.rawNodes || state.nodes || []).find(n => n.id === nodeId) || null;
    const peerName = node ? (node.name || node.display_name || nodeId) : nodeId;
    const connection=connectionNow(node?.connection),isOnline=connection.online===true;

    // Header
    title.innerHTML = `<span class="tchat-peer-name">${escapeHtml(peerName)}</span>`;
    if (meta) {
      const dot = `<span class="tchat-status-dot ${isOnline ? "online" : "offline"}"></span>`;
      const statusText = isOnline ? 'Connected' : connection.reason?.code==='connection_expired'?'Connection check expired':node?.connection?.error ? 'Connection check unavailable' : node?.discoveredRecently ? 'Discovered on LAN · connection not checked' : 'Select to check connection';
      meta.innerHTML = `${dot}<span class="tchat-status-text">${statusText}</span>`;
    }

    // Sort chronologically; fall back to server_ts then 0 for messages missing ts
    const msgs = (ensureThread(nodeId) || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    out.innerHTML = "";

    if (msgs.length === 0) {
      const init = _nameInitial(peerName);
      out.innerHTML = `
        <div class="tli-empty-state">
          <div class="tchat-empty-avatar">${escapeHtml(init)}</div>
          <div class="tli-empty-title">Start a conversation with ${escapeHtml(peerName)}</div>
          <div class="tli-empty-sub">Messages stay on your LAN — no internet, no servers.</div>
        </div>
      `;
      return;
    }

    const myName = state.localNodeName || "Me";
    let lastDay = null;
    let lastFrom = null;
    let lastTs = null;
    const GROUP_GAP_SEC = 90; // new group if >90s gap

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];

      // Day separator
      if (m.ts) {
        const dayLabel = _fmtDaySeparator(m.ts);
        if (dayLabel && dayLabel !== lastDay) {
          const sep = document.createElement("div");
          sep.className = "tchat-day-sep";
          sep.textContent = dayLabel;
          out.appendChild(sep);
          lastDay = dayLabel;
          lastFrom = null; // force new group after separator
        }
      }

      if (m.kind === "file") {
        out.appendChild(renderFileCard(m));
        lastFrom = null;
        continue;
      }

      if (m.kind === "ai") {
        const aiCard=renderAiCard(m);appendDelivery(aiCard,m,nodeId);out.appendChild(aiCard);
        lastFrom = null;
        lastTs = m.ts || lastTs;
        continue;
      }

      const isMe = m.from === "me";
      const senderName = isMe ? myName : peerName;
      const timeGap = m.ts && lastTs ? (m.ts - lastTs) > GROUP_GAP_SEC : false;
      const isNewGroup = m.from !== lastFrom || timeGap;

      // Row = avatar + bubble stack
      const row = document.createElement("div");
      row.className = "tchat-row " + (isMe ? "me" : "them");

      // Avatar (only on first message of a group for "them"; for "me" always on right)
      const avatarHtml = isNewGroup
        ? `<div class="tchat-avatar" title="${escapeHtml(senderName)}">${escapeHtml(_nameInitial(senderName))}</div>`
        : `<div class="tchat-avatar-spacer"></div>`;

      const bubble = document.createElement("div");
      bubble.className = "tchat-bubble" + (isNewGroup ? " first" : "");

      // Sender name label (only for "them", first in group)
      if (!isMe && isNewGroup) {
        const nameEl = document.createElement("div");
        nameEl.className = "tchat-sender-name";
        nameEl.textContent = senderName;
        bubble.appendChild(nameEl);
      }

      const bodyEl = document.createElement("div");
      bodyEl.className = "tchat-body";
      bodyEl.textContent = m.body;
      bubble.appendChild(bodyEl);
      appendDelivery(bubble,m,nodeId);


      // Timestamp (show on last message of a group or if next is different sender)
      const isLastInGroup = i === msgs.length - 1 ||
        msgs[i + 1].from !== m.from ||
        (msgs[i + 1].ts && m.ts && (msgs[i + 1].ts - m.ts) > GROUP_GAP_SEC);

      if (isLastInGroup && m.ts) {
        const tsEl = document.createElement("div");
        tsEl.className = "tchat-ts";
        tsEl.textContent = _fmtMsgTime(m.ts);

        // Read receipt tick on outgoing messages
        if (isMe && m.delivery === "acknowledged") {
          const threadId = makeThreadId(nodeId);
          const receipts = _readReceipts[threadId] || {};
          const peerReadTs = receipts[nodeId] || 0;
          const isRead = false; // Acknowledged delivery is not proof of a remote read.
          const isLastMsg = i === msgs.length - 1 || msgs.slice(i + 1).every(nm => nm.from !== "me");
          if (isLastMsg) {
            const tick = document.createElement("span");
            tick.className = "tchat-read-tick" + (isRead ? " read" : "");
            tick.textContent = isRead ? " ✓✓" : " ✓";
            tick.title = isRead ? "Read" : "Delivered";
            tsEl.appendChild(tick);
          }
        }

        bubble.appendChild(tsEl);
      }

      if (isMe) {
        row.appendChild(bubble);
        row.appendChild(isNewGroup
          ? (() => { const a = document.createElement("div"); a.className = "tchat-avatar me"; a.title = myName; a.textContent = _nameInitial(myName); return a; })()
          : (() => { const a = document.createElement("div"); a.className = "tchat-avatar-spacer"; return a; })()
        );
      } else {
        const avatarEl = document.createElement("div");
        if (isNewGroup) {
          avatarEl.className = "tchat-avatar them";
          avatarEl.title = senderName;
          avatarEl.textContent = _nameInitial(senderName);
        } else {
          avatarEl.className = "tchat-avatar-spacer";
        }
        row.appendChild(avatarEl);
        row.appendChild(bubble);
      }

      out.appendChild(row);
      lastFrom = m.from;
      lastTs = m.ts || lastTs;
    }

    out.scrollTop = out.scrollHeight;
  }

  // -----------------------------
  // Composer state
  // -----------------------------
  function updateComposerState() {
    const shareBtn = $("tli-chat-share-btn");
    const sendBtn = $("tli-chat-send-btn");
    const input = $("tli-chat-input");

    const hasNode = !!state.selectedNodeId;
    const node = state.rawNodes.find(n => n.id === state.selectedNodeId);
    const access = messagingState(node);

    if (shareBtn) shareBtn.disabled = !hasNode || !access.available;
    if (sendBtn) { sendBtn.disabled = !hasNode || !access.available; sendBtn.title = hasNode && !access.available ? access.message : 'Send message'; }

    if (input) {
      input.disabled = !hasNode;
      input.placeholder = hasNode ? "Message… or @ai ask something together" : "Select a reviewed computer to message…";
    }
    renderMessagingNotice(node, access);
  }

  function renderMessagingNotice(node, access) {
    const output = $('tli-chat-thread-output');
    let notice = $('tli-chat-message-readiness');
    if (!notice && output?.parentElement) {
      notice = document.createElement('div'); notice.id = 'tli-chat-message-readiness'; notice.className = 'tli-chat-message-readiness';
      output.parentElement.insertBefore(notice, output);
    }
    if (!notice) return;
    notice.hidden = !state.selectedNodeId;
    notice.replaceChildren();
    if (notice.hidden) return;
    const message = document.createElement('p'); message.setAttribute('role', 'status');
    message.textContent = access.available
      ? `Message permission is reviewed here. ${node?.name || 'The other computer'} must also review ${state.localNodeName}. Delivery is confirmed when you send.`
      : access.message;
    notice.appendChild(message);
    const controls = document.createElement('div'); controls.className = 'tli-chat-readiness-actions';
    if (!access.available && !node?.previousDiscovery && node?.accessStatus === 'pending' && node.peerProfile !== 'inference_node' && window.TLIPeerPairing) {
      const connect = document.createElement('button'); connect.type = 'button'; connect.className = 'btn btn-primary'; connect.textContent = 'Request connection';
      connect.addEventListener('click', () => window.TLIConnectDevice?.open({kind:'computer',deviceId:node.id})); controls.appendChild(connect);
    }
    if (node?.peerProfile !== 'inference_node') {
      const review = document.createElement('button'); review.type = 'button'; review.className = 'btn btn-outline'; review.textContent = 'Review computer trust';
      review.addEventListener('click', () => reviewComputer(state.selectedNodeId)); controls.appendChild(review);
    }
    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'btn btn-ghost'; refresh.textContent = 'Refresh status';
    refresh.addEventListener('click', () => resumePanel()); controls.appendChild(refresh);
    notice.appendChild(controls);
  }

  function _isMobile() { return window.innerWidth <= 768; }

  function _setChatMobileView(view) {
    const shell = document.querySelector(".tli-chat-shell");
    if (shell) shell.setAttribute("data-mobile-view", view);
  }

  function openThread(nodeId) {
    if(!_lanAlive(_lanEpoch))return;
    if (state.rawNodes.find(n => n.id === nodeId)?.previousDiscovery) state.previousOpen = true;
    const input = $('tli-chat-input');
    if (state.selectedNodeId !== nodeId && input) {
      if (state.selectedNodeId) state.drafts.set(state.selectedNodeId, input.value);
      input.value = state.drafts.get(nodeId) || '';
    }
    state.selectedNodeId = nodeId;
    _typingState = false;
    // Clear unread badge for this node
    if (state.unread && state.unread[nodeId]) {
      delete state.unread[nodeId];
    }
    if (_isMobile()) _setChatMobileView("thread");
    renderBuddyList();
    renderThread(nodeId);
    updateComposerState();
    startChatPolling(nodeId);
    pollChatMessages(nodeId).then(() => {
      sendReadReceipt(nodeId);  // mark as read after messages load
      fetchReadReceipts(nodeId);
    });
    startTypingPoll(nodeId);
    checkSelectedConnection(nodeId);

    if (input) input.focus();
  }

  async function checkSelectedConnection(nodeId) {
    if(!_lanAlive(_lanEpoch))return;
    const node=state.rawNodes.find(n=>n.id===nodeId),epoch=_lanEpoch;
    if(!node||node.peerProfile==='inference_node'||node.trustState!=='verified'||node.previousDiscovery)return;
    try{const response=await fetch('/mesh/directory/'+encodeURIComponent(nodeId)+'/connection',{method:'POST',cache:'no-store'});
      const result=await response.json();if(!_lanAlive(epoch))return;
      if(!response.ok||result.node_id!==nodeId||!Array.isArray(result.ready_grants))throw Error('Connection unavailable');
      const connection=connectionNow(result.connection),connected=connection.state==='connected'&&connection.fresh;
      node.connection=connection;node.online=connected;node.status=connected?'online':'unknown';
      const messages=connected&&connection.ready_grants.includes('messages');
      node.messaging={available:messages,code:connected?'checked':result.connection?.state||'unreachable',message:messages?'Messages available on both computers.':result.connection?.reason?.message||'The connection is not confirmed ready for messages.'};
    }catch{if(!_lanAlive(epoch))return;node.connection={error:true};node.online=false;node.status='unknown';}
    if(state.selectedNodeId===nodeId){renderThread(nodeId);updateComposerState();}renderBuddyList();renderHeaderLivePill();
  }

  // -----------------------------
  // Text messaging — real transport
  // -----------------------------
  async function sendCurrentMessage() {
    const input=$('tli-chat-input'),nodeId=state.selectedNodeId;
    if(!_lanAlive(_lanEpoch)||!input||!nodeId)return;
    if (nodeId !== '__local_loopback__' && !messagingState(state.rawNodes.find(n => n.id === nodeId)).available) { updateComposerState(); return; }
    const text=(input.value||'').trim();if(!text)return;
    if(nodeId==='__local_loopback__'){ensureThread(nodeId).push({kind:'text',from:'me',body:text,ts:nowTs(),delivery:'local'});input.value='';renderThread(nodeId);return;}
    if(/^@ai\b/i.test(text)){await _invokeAiInThread(text,nodeId);return;}
    const thread=ensureThread(nodeId);
    if(thread.some(m=>m._sending&&m._payload?.body===text))return;
    let msg=thread.find(m=>m.delivery==='failed'&&m.body===text&&m._payload);
    if(!msg){msg=_newDelivery(text,nodeId);thread.push(msg);}
    await _deliverMessage(msg,nodeId);
  }

  function _newDelivery(text,nodeId,kind='text') {
    const ts=nowTs(),remote=state.rawNodes.find(n=>n.id===nodeId),id=genId();
    return {kind,from:kind==='ai'?'ai':'me',body:text,ts,_msgId:id+'|'+state.localNodeId,delivery:'pending',
      _payload:{message_id:id,thread_id:makeThreadId(nodeId),from_id:state.localNodeId,from_name:state.localNodeName,
        to_id:nodeId,to_ip:remote?.ip||null,body:text,ts}};
  }
  async function _deliverMessage(msg,nodeId) {
    if(!_lanAlive(_lanEpoch)||msg._sending||msg._payload?.from_id!==state.localNodeId)return false;
    const access = messagingState(state.rawNodes.find(n => n.id === nodeId));
    if (!access.available) { msg.delivery = 'failed'; msg.deliveryError = access.message; updateComposerState(); renderThread(nodeId); return false; }
    const epoch=_lanEpoch;msg._sending=true;msg.delivery='pending';msg.deliveryError='';renderThread(nodeId);
    try {
      const r=await fetch('/mesh/chat/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg._payload)});
      if(!_lanAlive(epoch))return false;
      if(r.status===401){window.dispatchEvent(new CustomEvent('tli-session-locked'));return false;}
      const data=await r.json();if(!_lanAlive(epoch))return false;
      if(!r.ok||data.delivery!=='acknowledged')throw Error(typeof data.detail==='string'?data.detail:data.detail?.message||'Delivery was not acknowledged.');
      msg.delivery='acknowledged';const input=$('tli-chat-input');if(state.selectedNodeId===nodeId&&input?.value.trim()===msg._payload.body)input.value='';
      if (state.drafts.get(nodeId)?.trim() === msg._payload.body) state.drafts.delete(nodeId);
      _chatLastTs[msg._payload.thread_id]=Math.max(_chatLastTs[msg._payload.thread_id]||0,msg.ts);return true;
    } catch(e){if(_lanAlive(epoch)){msg.delivery='failed';msg.deliveryError=e.message||'Connection interrupted. No automatic retry.';}return false;}
    finally{msg._sending=false;if(_lanAlive(epoch)&&state.selectedNodeId===nodeId)renderThread(nodeId);}
  }

  // -----------------------------
  // @ai — shared AI in thread
  // -----------------------------
  async function _invokeAiInThread(rawText,toNodeId) {
    if(_lanLocked)return;
    const thread=ensureThread(toNodeId);if(thread.some(m=>m._sending&&m._payload?.body===rawText))return;const questionMsg=_newDelivery(rawText,toNodeId);thread.push(questionMsg);
    if(!await _deliverMessage(questionMsg,toNodeId))return;
    const epoch=_lanEpoch,question=rawText.replace(/^@ai\s*/i,'').trim()||rawText;
    const aiMsg={kind:'ai',from:'ai',body:'Thinking…',ts:nowTs(),_thinking:true};thread.push(aiMsg);renderThread(toNodeId);
    let reply;
    try {const r=await fetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:question,max_tokens:400,temperature:0.3})});
      if(!_lanAlive(epoch))return;const data=await r.json();if(!_lanAlive(epoch))return;
      reply=r.ok?(data.reply||data.message?.content||'(no response)'):'AI unavailable (HTTP '+r.status+').';
    }catch(e){if(!_lanAlive(epoch))return;reply='AI unavailable — '+e.message;}
    const outgoing=_newDelivery('__AI_REPLY__:'+JSON.stringify({question,reply}),toNodeId,'ai');
    Object.assign(aiMsg,outgoing,{body:reply,_thinking:false});await _deliverMessage(aiMsg,toNodeId);
  }

  // -----------------------------
  // File sharing (UI-first)
  // -----------------------------
  async function createOutgoingFileOffer(file, toNodeId) {
    if(!_lanAlive(_lanEpoch))return;
    const peer = (state.rawNodes || []).find(node => node.id === toNodeId);
    if (!peer || !window.TLIPeerTransfers) {
      showToast("Secure file transfer is unavailable. Refresh this installation first.", "error");
      return;
    }
    await window.TLIPeerTransfers.open(peer);
  }

  function appendDelivery(bubble,m,nodeId){
    if(!m.delivery)return;const status=document.createElement('div');status.className='tchat-ts';
    status.textContent=m.delivery==='pending'?'Sending…':m.delivery==='failed'?'Not acknowledged: '+(m.deliveryError||'Connection interrupted.'):m.delivery==='local'?'Local note':'Delivered to reviewed computer';bubble.appendChild(status);
    if(m.delivery==='failed'&&m._payload){
      const access = messagingState(state.rawNodes.find(n => n.id === nodeId));
      const retry=document.createElement('button');retry.type='button';retry.className='btn btn-outline';retry.textContent='Retry this message';retry.disabled=!access.available;retry.title=access.available?'Send this same message again':access.message;retry.addEventListener('click',()=>_deliverMessage(m,nodeId));bubble.appendChild(retry);
      const review=document.createElement('button');review.type='button';review.className='btn btn-ghost';review.textContent='Review computer trust';review.addEventListener('click',()=>reviewComputer(nodeId));bubble.appendChild(review);
    }
  }

  function renderAiCard(m) {
    const card = document.createElement("div");
    card.className = "tchat-ai-card" + (m._thinking ? " thinking" : "");

    const isThinking = !!m._thinking;
    card.innerHTML = `
      <div class="tchat-ai-card-header">
        <span class="tchat-ai-card-icon">✦</span>
        <span class="tchat-ai-card-label">TLI AI</span>
        <span class="tchat-ai-card-ts">${m.ts ? _fmtMsgTime(m.ts) : ""}</span>
      </div>
      <div class="tchat-ai-card-body${isThinking ? " tchat-ai-thinking" : ""}">${escapeHtml(m.body)}</div>
    `;
    return card;
  }

  function renderFileCard(m) {
    const card = document.createElement("div");
    card.className = "tli-file-card";

    const sizeText = formatBytes(m.size);
    const isLarge = (m.size || 0) >= SHARE_CONFIRM_GB * BYTES_IN_GB;

    const badge = isLarge ? "Large" : "File";
    const status = m.status || "pending";

    const dirMeta = m.direction === "incoming"
      ? `<span>From: <strong>${escapeHtml(m.from_name || "peer")}</strong></span>`
      : `<span>To: <strong>${escapeHtml(m.toNodeId || "—")}</strong></span>`;

    card.innerHTML = `
      <div class="tli-file-card-title">
        <span>📦 ${escapeHtml(m.name || "file")}</span>
        <span class="pill">${escapeHtml(badge)}</span>
      </div>

      <div class="tli-file-card-meta">
        <span>Size: <strong>${escapeHtml(sizeText)}</strong></span>
        ${dirMeta}
        <span>Status: <strong>${escapeHtml(status)}</strong></span>
      </div>

      <div class="tli-file-card-actions">
        ${
          m.direction === "incoming"
            ? `<button class="tli-file-btn primary" data-action="accept">Accept</button>
               <button class="tli-file-btn danger" data-action="decline">Decline</button>`
            : `<button class="tli-file-btn" data-action="cancel">Cancel</button>`
        }
      </div>
    `;

    card.querySelectorAll("button[data-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        if (action === "accept") return acceptFileOffer(m);
        if (action === "decline") return declineFileOffer(m);
        if (action === "cancel") return cancelOutgoingOffer(m);
      });
    });

    return card;
  }

  async function acceptFileOffer(m) {
    const isLarge = (m.size || 0) >= SHARE_CONFIRM_GB * BYTES_IN_GB;
    if (isLarge) {
      const ok = confirm(`Large file: ${formatBytes(m.size)}\n\nDownload from ${m.from_name || "peer"}?`);
      if (!ok) return;
    }

    if (!m.download_url) {
      showToast("Cannot download — sender address unknown.", "error");
      return;
    }

    updateMessageStatus(state.selectedNodeId, m.id, "downloading");
    upsertTransfer({ id: m.id, name: m.name, size: m.size, status: "downloading", progress: 0, ts: nowTs() });

    // Pull the file directly from the sender's backend — outbound from receiver, no firewall issue.
    const a = document.createElement("a");
    a.href = m.download_url;
    a.download = m.name || "file";
    a.click();

    // A browser download request is not evidence that a file was saved.
    updateTransferStatus(m.id, "download requested");
    updateMessageStatus(state.selectedNodeId, m.id, "download requested");

  }

  async function declineFileOffer(m) {
    updateMessageStatus(state.selectedNodeId, m.id, "declined");
    updateTransferStatus(m.id, "declined");
  }

  async function cancelOutgoingOffer(m) {
    updateMessageStatus(m.toNodeId, m.id, "canceled");
    updateTransferStatus(m.id, "canceled");
  }

  function updateMessageStatus(threadId, msgId, status) {
    if (!threadId) return;
    const t = ensureThread(threadId);
    const msg = t.find(x => x.kind === "file" && x.id === msgId);
    if (msg) msg.status = status;
    renderThread(threadId);
  }

  // -----------------------------
  // Transfers drawer
  // -----------------------------
  function upsertTransfer(t) {
    const idx = state.transfers.findIndex(x => x.id === t.id);
    if (idx >= 0) state.transfers[idx] = { ...state.transfers[idx], ...t };
    else state.transfers.unshift(t);
    renderTransfers();
  }

  function updateTransferStatus(id, status) {
    const tr = state.transfers.find(x => x.id === id);
    if (tr) tr.status = status;
    renderTransfers();
  }

  function setTransferProgress(id, pct) {
    const tr = state.transfers.find(x => x.id === id);
    if (tr) tr.progress = pct;
    renderTransfers();
  }

  function renderTransfers() {
    const box = $("tli-transfer-list");
    if (!box) return;

    if (!state.transfers.length) {
      box.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No historical downloads</div>
          <div class="tli-empty-sub">Use Encrypted file Inbox for new reviewed transfers.</div>
        </div>
      `;
      return;
    }

    box.innerHTML = "";
    for (const t of state.transfers.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = "tli-transfer-row";

      const pct = Math.max(0, Math.min(100, Number(t.progress || 0)));
      row.innerHTML = `
        <div class="tli-transfer-top">
          <div class="tli-transfer-name">📦 ${escapeHtml(t.name)} <span style="opacity:.65">· ${escapeHtml(formatBytes(t.size))}</span></div>
          <div class="tli-transfer-status">${escapeHtml(t.status || "—")}</div>
        </div>
        <div class="tli-transfer-bar"><div style="width:${pct}%"></div></div>
      `;
      box.appendChild(row);
    }
  }


  // -----------------------------
  // Bind UI once
  // -----------------------------
  function bindUIOnce() {
    if (state.bound) return;
    state.bound = true;

    // Send
    const sendBtn = $("tli-chat-send-btn");
    const input = $("tli-chat-input");
    if (sendBtn) sendBtn.addEventListener("click", sendCurrentMessage);
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendCurrentMessage();
        } else if (state.selectedNodeId) {
          sendTypingSignal(state.selectedNodeId);
        }
      });
    }

    // Share
    const shareBtn = $("tli-chat-share-btn");
    const fileInput = $("tli-chat-file-input");
    if (shareBtn) {
      shareBtn.title = 'Offer one file with explicit receiver review';
      shareBtn.addEventListener("click", () => createOutgoingFileOffer(null, state.selectedNodeId));
    }
    // Historical upload input stays inert; the new review owns its file picker.
    if (fileInput) fileInput.disabled = true;
    window.TLIPeerTransfers?.mount();

    // Search (filters rawNodes, doesn't wipe loopback)
    const search = $("tli-chat-node-search");
    if (search) {
      search.addEventListener("input", () => {
        state.nodeSearch = String(search.value || "");
        state.nodes = applyNodeSearch(state.rawNodes);
        renderBuddyList();
        renderHeaderLivePill();
      });
    }

    // Mobile: back button returns to buddy list
    const backBtn = $("tli-chat-back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        if (state.selectedNodeId) state.drafts.set(state.selectedNodeId, $('tli-chat-input')?.value || '');
        if ($('tli-chat-input')) $('tli-chat-input').value = '';
        state.selectedNodeId = null;
        stopChatPolling();
        _setChatMobileView("buddies");
        renderBuddyList();
        renderThread(null);
        updateComposerState();
      });
    }
  }

  // -----------------------------
  // Public API
  // -----------------------------
  async function resumePanel() {
    if (!_panelVisible()) return;
    const epoch = _lanEpoch, panelEpoch = ++_panelEpoch;
    const current = () => _lanAlive(epoch) && _panelVisible() && panelEpoch === _panelEpoch;
    bindUIOnce();
    expireConnections();
    if(!_unsubscribeExpiry&&window.MeshService?.subscribeExpiry)_unsubscribeExpiry=window.MeshService.subscribeExpiry(expireConnections);
    if (_isMobile()) _setChatMobileView(state.selectedNodeId ? "thread" : "buddies");
    if(!await loadLocalNodeIdentity())return;
    if (!current()) return;
    await refreshNodes();
    if (!current()) return;
    startPresenceStream();
    startBgPoll();
    pollBackgroundMessages();
    if (state.selectedNodeId) {
      startChatPolling(state.selectedNodeId);
      pollChatMessages(state.selectedNodeId);
    }
    renderTransfers();
  }

  function pausePanel() {
    _panelEpoch++;
    _unsubscribeExpiry?.();_unsubscribeExpiry=null;
    stopChatPolling();
    stopTypingPoll();
    stopPresenceStream();
  }

  window.TLIChat = {
    async openPeer(nodeId) {
      if (!_lanSessionCurrent(_lanEpoch) || typeof nodeId !== 'string') return false;
      if(!_identityReady&&!await loadLocalNodeIdentity())return false;
      if (state.selectedNodeId !== nodeId && $('tli-chat-input')?.value.trim()) { window.showToast?.('Finish or clear your current message before changing recipient.', 'warn'); return false; }
      const epoch = _lanEpoch;
      await refreshNodes();
      if (!_lanAlive(epoch)) return false;
      if (state.selectedNodeId !== nodeId && $('tli-chat-input')?.value.trim()) { window.showToast?.('Finish or clear your current message before changing recipient.', 'warn'); return false; }
      window.switchPanel?.('panel-tli-chat');
      if (!state.nodes.some(node => node.id === nodeId)) { window.showToast?.('This computer is not available for messaging. Review its connection and permissions.', 'warn'); return false; }
      openThread(nodeId); return true;
    },
    async onOpen() {
      _panelOpen = true;
      if(!_lanSessionCurrent(_lanEpoch)){showIdentityUnavailable();return;}
      return resumePanel();
    },

    onClose() {
      _panelOpen = false;
      window.TLIPeerTransfers?.onClose();
      pausePanel();
      // Unread notifications use the bounded background poll while TLI is visible.
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pausePanel(); stopBgPoll(); return; }
    if (!_lanSessionCurrent(_lanEpoch)) return;
    if (_panelOpen) resumePanel();
    else if (state.bound) { startBgPoll(); pollBackgroundMessages(); }
  });
  window.addEventListener('tli-peer-trust-changed', () => { if (_panelVisible()) refreshNodes(); });
  window.addEventListener('beforeunload', () => { _panelOpen = false; pausePanel(); stopBgPoll(); });
  for(const event of ['tli-session-locked','tli-account-changed','tli-user-changed'])window.addEventListener(event,()=>{
    _lanLocked=true;_lanReady=false;_identityReady=false;_identityRequest=null;_lanEpoch++;pausePanel();stopBgPoll();
    if(state.refreshTimer)clearInterval(state.refreshTimer);state.refreshTimer=null;
    state.threads.clear();state.drafts.clear();state.rawNodes=[];state.nodes=[];state.selectedNodeId=null;state.previousOpen=false;
    state.localNodeId=null;state.localNodeName='';state.lastDirectoryOk=false;
    for(const key of Object.keys(_chatLastTs))delete _chatLastTs[key];
    for(const key of Object.keys(_chatCursors))delete _chatCursors[key];
    for(const id of ['tli-chat-thread-output','tli-chat-thread-title','tli-chat-thread-meta'])$(''+id)?.replaceChildren();
    const input=$('tli-chat-input');if(input)input.value='';
    showIdentityUnavailable();
  });
  window.addEventListener('tli-session-unlocked',()=>{
    _lanLocked=false;_lanEpoch++;
    if(_panelOpen&&!_lanReady)showIdentityUnavailable();
  });
  window.addEventListener('tli-private-observation-ready',()=>{
    if(_lanLocked||_lanReady)return;_lanReady=true;
    if(_panelOpen)resumePanel();
  });
})();
