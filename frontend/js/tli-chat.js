// TLI Chat (LAN Mesh Messenger)
(() => {
  const $ = (id) => document.getElementById(id);
  let _lanLocked=false,_lanEpoch=0;
  const _lanAlive=t=>!_lanLocked&&t===_lanEpoch;


  // -----------------------------
  // Config
  // -----------------------------
  const SHARE_CONFIRM_GB = 5;
  const BYTES_IN_GB = 1024 * 1024 * 1024;

  const PRESENCE_OFFLINE_MS = 10 * 60 * 1000;
  const PRESENCE_IDLE_MS = 3 * 60 * 1000;
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
    transfers: [],

    refreshTimer: null,
    presenceEs: null,
    bound: false,

    lastDirectoryOk: false,
    nodeSearch: "",

    localNodeId: "local",
    localNodeName: "Me",
  };

  // Chat polling
  let _chatPollTimer   = null;
  let _bgPollTimer     = null;
  let _typingPollTimer = null;
  let _typingSendTimer = null;    // debounce handle for outgoing typing signal
  let _typingClearTimer = null;   // auto-clear typing indicator after inactivity
  const _chatLastTs    = {};      // threadId → last seen ts
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
    if (!lastSeenMs || Number.isNaN(lastSeenMs)) return "online";
    const age = nowTs() - lastSeenMs;
    if (age > PRESENCE_OFFLINE_MS) return "offline";
    if (age > PRESENCE_IDLE_MS) return "idle";
    return "online";
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
    if(_lanLocked)return null;const epoch=_lanEpoch;
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

  async function loadLocalNodeIdentity() {
    if(_lanLocked)return;const epoch=_lanEpoch;
    try {
      const r = await fetch("/mesh/node", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if(!_lanAlive(epoch))return;
      state.localNodeId = d.node_id || "local";
      state.localNodeName = d.display_name || "Me";
    } catch {}
  }

  function startChatPolling(nodeId) {
    stopChatPolling();
    _chatPollTimer = setInterval(() => {
      pollChatMessages(nodeId);
      fetchReadReceipts(nodeId);
    }, 3000);
  }

  function stopChatPolling() {
    if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
  }

  // Background poll — checks ALL non-selected threads every 10 s for new messages / file offers.
  // This is what drives toast notifications when you're in a different tab or have another thread open.
  function startBgPoll() {
    if (_bgPollTimer) return;
    _bgPollTimer = setInterval(async () => {
      const nodes = state.rawNodes || [];
      for (const node of nodes) {
        if (!node.id || node.id === state.localNodeId) continue;
        if (node.id === state.selectedNodeId) continue; // active thread handled by startChatPolling
        await pollChatMessages(node.id);
      }
    }, 10_000);
    // Stop cleanly on page unload
    window.addEventListener("beforeunload", () => {
      if (_bgPollTimer) { clearInterval(_bgPollTimer); _bgPollTimer = null; }
      if (_typingPollTimer) { clearInterval(_typingPollTimer); _typingPollTimer = null; }
      stopPresenceStream();
    }, { once: true });
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
    if(_lanLocked)return;const epoch=_lanEpoch;
    if (!nodeId) return;
    const threadId = makeThreadId(nodeId);
    const since = _chatLastTs[threadId] || 0;

    // Collect raw messages from both local store and peer's store (pull-based delivery)
    const allMsgs = [];
    const seen = new Set();

    const addMsgs = (msgs) => {
      for (const m of (msgs || [])) {
        const key = m.ts + "|" + m.from_id;
        if (!seen.has(key)) { seen.add(key); allMsgs.push(m); }
      }
    };

    // 1) Local store (messages received by push, stored here)
    try {
      const r = await fetch(
        `/mesh/chat/messages?thread_id=${encodeURIComponent(threadId)}&since=${since}`,
        { cache: "no-store" }
      );
      if (r.ok) addMsgs((await r.json()).messages);
    } catch {}

    // Received messages are stored locally by the authenticated peer endpoint.

    if(!_lanAlive(epoch))return;
    // Include ALL messages (own + peer) so history survives refresh.
    // Direction determined by from_id vs localNodeId.
    if (!allMsgs.length) return;

    const thread = ensureThread(nodeId);
    const existingIds = new Set(thread.map(m => m._msgId).filter(Boolean));
    let added = 0;
    for (const m of allMsgs) {
      // Use client ts; fall back to server_ts if missing or implausibly small (<2020)
      const msgTs = (m.ts && m.ts > 1577836800000) ? m.ts : (m.server_ts || m.ts || 0);
      const key = msgTs + "|" + m.from_id;
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
            if (state.selectedNodeId !== nodeId) {
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
        if (!isOwn && state.selectedNodeId !== nodeId) {
          _showMsgToast(m.from_name || "Peer", m.body, nodeId);
        }
      }

      if (msgTs > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = msgTs;
      added++;
    }
    if (added > 0 && state.selectedNodeId === nodeId) {
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
    return peers.map(p => ({
      id:         String(p.id || p.name || "peer"),
      name:       String(p.name || p.id || "Unknown TLI Node"),
      role:       "TLI Node",
      room:       String(p.ip || ""),
      ip:         String(p.ip || ""),
      port:       Number(p.port || 8000),
      lastSeenMs: p.last_seen ? Date.parse(p.last_seen) : 0,
      status:     p.online ? "online" : "offline",
    }));
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
        status: String(host.status || normalizeStatusFromLastSeen(lastSeenMs)),
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
        status: String(d.status || normalizeStatusFromLastSeen(lastSeenMs)),
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
    stopPresenceStream();
    if(_lanLocked)return;const epoch=_lanEpoch;
    const es = new EventSource("/mesh/presence/stream");
    state.presenceEs = es;

    es.onmessage = (e) => {
      if(!_lanAlive(epoch)||state.presenceEs!==es)return;
      try { handlePresenceEvent(JSON.parse(e.data)); } catch {}
    };

    es.onerror = () => {
      if(!_lanAlive(epoch)||state.presenceEs!==es)return;
      // SSE failed — fall back to polling
      stopPresenceStream();
      if (!state.refreshTimer) {
        state.refreshTimer = setInterval(refreshNodes, REFRESH_MS);
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
    if(type==='directory_changed'){refreshNodes();return;}

    if (type === "node_online") {
      const nodeId = evt.node_id;
      if (!nodeId || nodeId === state.localNodeId) return;

      const nodeData = {
        id: nodeId,
        name: evt.name || nodeId,
        ip: evt.ip || "",
        tli_port: evt.tli_port || 8000,
        role: evt.role || "TLI Node",
        room: evt.ip || "LAN",
        lastSeenMs: Date.now(),
        status: "online",
      };

      // Discovery cannot replace a different reviewed identity at the same IP.
      const existing = state.rawNodes.find(n => n.id === nodeId);
      if (existing) {
        Object.assign(existing, nodeData);
      } else {
        // Replace loopback placeholder with first real node
        state.rawNodes = state.rawNodes.filter(n => n.id !== "__local_loopback__");
        state.rawNodes.push(nodeData);
      }
      state.nodes = applyNodeSearch(state.rawNodes);
      renderBuddyList();
      renderHeaderLivePill();
      updateComposerState();

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

      state.rawNodes = state.rawNodes.filter(n => n.id !== nodeId);
      state.nodes = applyNodeSearch(state.rawNodes);

      // If the open thread's node went offline, close it
      if (state.selectedNodeId === nodeId) {
        state.selectedNodeId = null;
        stopChatPolling();
        stopTypingPoll();
        if (_isMobile()) _setChatMobileView("buddies");
        renderThread(null);
      }

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
    if(_lanLocked)return;const epoch=_lanEpoch;
    // Use /api/lan/peers — works without mesh pairing, deduped by IP, no license gate.
    // Any TLI on the LAN auto-appears the moment it broadcasts a UDP beacon.
    let lanData = null;
    try {
      lanData = await safeFetchJson("/api/lan/peers");
    } catch {
      lanData = null;
    }

    if(!_lanAlive(epoch))return;
    state.lastDirectoryOk = !!(lanData && Array.isArray(lanData.peers));

    const mapped = mapLanPeersToNodes(lanData || {});

    state.rawNodes = mapped;
    state.nodes = applyNodeSearch(mapped);

    // if selected node vanished, reset
    if (state.selectedNodeId && !state.nodes.some(n => n.id === state.selectedNodeId)) {
      state.selectedNodeId = null;
      renderThread(null);
    }

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

    const onlineish = state.rawNodes.filter(n => (n.status || "") !== "offline").length;
    pill.textContent = onlineish === 0 ? "No peers yet" : `${onlineish} online`;
  }

  // -----------------------------
  // Rendering: Buddy list
  // -----------------------------
  function renderBuddyList() {
    const list = $("tli-chat-buddies-list");
    const meta = $("tli-chat-buddies-meta");
    if (!list) return;

    const onlineCount = state.nodes.filter(n => (n.status || "") !== "offline").length;
    if (meta) meta.textContent = state.rawNodes.length === 0 ? "—" : `${onlineCount}/${state.nodes.length}`;

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

    for (const n of state.nodes) {
      const row = document.createElement("div");
      row.className = "tli-chat-buddy" + (state.selectedNodeId === n.id ? " active" : "");
      row.addEventListener("click", () => openThread(n.id));

      const unreadCount = (state.unread && state.unread[n.id]) || 0;
      const unreadBadge = unreadCount > 0
        ? `<span class="tli-chat-unread-badge">${unreadCount}</span>`
        : "";

      row.innerHTML = `
        <div class="tli-presence-dot ${presenceClass(n.status)}"></div>
        <div class="tli-chat-buddy-text">
          <div class="tli-chat-buddy-name">${escapeHtml(n.name)}${unreadBadge}</div>
          <div class="tli-chat-buddy-sub">${escapeHtml(`${n.room} · ${n.role}`)}</div>
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

      list.appendChild(row);
    }
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
    const isOnline = node ? !!node.online : false;

    // Header
    title.innerHTML = `<span class="tchat-peer-name">${escapeHtml(peerName)}</span>`;
    if (meta) {
      const dot = `<span class="tchat-status-dot ${isOnline ? "online" : "offline"}"></span>`;
      const statusText = isOnline ? "Online" : (node?.lastSeenMs ? "Last seen " + _fmtMsgTime(node.lastSeenMs) : "Offline");
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

    if (shareBtn) shareBtn.disabled = !hasNode;
    if (sendBtn) sendBtn.disabled = !hasNode;

    if (input) {
      input.disabled = !hasNode;
      input.placeholder = hasNode ? "Message… or @ai ask something together" : "Select a reviewed computer to message…";
    }
  }

  function _isMobile() { return window.innerWidth <= 768; }

  function _setChatMobileView(view) {
    const shell = document.querySelector(".tli-chat-shell");
    if (shell) shell.setAttribute("data-mobile-view", view);
  }

  function openThread(nodeId) {
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

    const input = $("tli-chat-input");
    if (input) input.focus();
  }

  // -----------------------------
  // Text messaging — real transport
  // -----------------------------
  async function sendCurrentMessage() {
    const input=$('tli-chat-input'),nodeId=state.selectedNodeId;
    if(_lanLocked||!input||!nodeId)return;
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
    return {kind,from:kind==='ai'?'ai':'me',body:text,ts,_msgId:ts+'|'+state.localNodeId,delivery:'pending',
      _payload:{message_id:id,thread_id:makeThreadId(nodeId),from_id:state.localNodeId,from_name:state.localNodeName,
        to_id:nodeId,to_ip:remote?.ip||null,body:text,ts}};
  }
  async function _deliverMessage(msg,nodeId) {
    if(_lanLocked||msg._sending)return false;
    const epoch=_lanEpoch;msg._sending=true;msg.delivery='pending';msg.deliveryError='';renderThread(nodeId);
    try {
      const r=await fetch('/mesh/chat/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg._payload)});
      if(!_lanAlive(epoch))return false;
      if(r.status===401){window.dispatchEvent(new CustomEvent('tli-session-locked'));return false;}
      const data=await r.json();if(!_lanAlive(epoch))return false;
      if(!r.ok||data.delivery!=='acknowledged')throw Error(typeof data.detail==='string'?data.detail:data.detail?.message||'Delivery was not acknowledged.');
      msg.delivery='acknowledged';const input=$('tli-chat-input');if(state.selectedNodeId===nodeId&&input?.value.trim()===msg._payload.body)input.value='';
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
    if(m.delivery==='failed'&&m._payload){const retry=document.createElement('button');retry.type='button';retry.className='btn btn-outline';retry.textContent='Retry this message';retry.addEventListener('click',()=>_deliverMessage(m,nodeId));bubble.appendChild(retry);}
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
  window.TLIChat = {
    async onOpen() {
      if(_lanLocked)return;const epoch=_lanEpoch;
      bindUIOnce();
      // Mobile: initialise view state
      if (_isMobile()) {
        _setChatMobileView(state.selectedNodeId ? "thread" : "buddies");
      }
      await loadLocalNodeIdentity();
      if(!_lanAlive(epoch))return;
      await refreshNodes();    // initial snapshot
      if(!_lanAlive(epoch))return;
      startPresenceStream();   // live updates via SSE (clears any polling timer)
      startBgPoll();           // background poll for toast notifications on non-selected threads

      // Resume polling if a thread was already open
      if (state.selectedNodeId) {
        startChatPolling(state.selectedNodeId);
        pollChatMessages(state.selectedNodeId);
      }

      renderTransfers();
    },

    onClose() {
      window.TLIPeerTransfers?.onClose();
      stopChatPolling();
      stopTypingPoll();
      // bgPoll and presenceStream intentionally kept alive for off-panel notifications
    },
  };
  window.addEventListener('tli-session-locked',()=>{
    _lanLocked=true;_lanEpoch++;stopChatPolling();stopBgPoll();stopTypingPoll();stopPresenceStream();
    if(state.refreshTimer)clearInterval(state.refreshTimer);state.refreshTimer=null;
    state.threads.clear();state.rawNodes=[];state.nodes=[];state.selectedNodeId=null;
    for(const key of Object.keys(_chatLastTs))delete _chatLastTs[key];
    const out=$('tli-chat-thread-output');if(out)out.replaceChildren();const input=$('tli-chat-input');if(input)input.value='';
  });
  window.addEventListener('tli-session-unlocked',()=>{_lanLocked=false;_lanEpoch++;});
})();
