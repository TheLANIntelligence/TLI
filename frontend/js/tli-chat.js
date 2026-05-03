// TLI Chat (LAN Mesh Messenger)
(() => {
  const $ = (id) => document.getElementById(id);

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
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
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
    try {
      const r = await fetch("/mesh/node", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
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

  function startTypingPoll(nodeId) {
    stopTypingPoll();
    const remoteNode = (state.rawNodes || []).find(n => n.id === nodeId);
    if (!remoteNode || !remoteNode.ip) return;
    const threadId = makeThreadId(nodeId);
    const baseUrl = `http://${remoteNode.ip}:${remoteNode.port || 8000}`;
    _typingPollTimer = setInterval(async () => {
      try {
        const r = await fetch(`${baseUrl}/mesh/chat/typing?thread_id=${encodeURIComponent(threadId)}`,
          { cache: "no-store", signal: AbortSignal.timeout(2000) });
        if (!r.ok) return;
        const d = await r.json();
        if (_typingState !== d.typing) {
          _typingState = d.typing;
          renderTypingIndicator(d.typing, d.from_name || "");
        }
      } catch {}
    }, 2000);
  }

  function stopTypingPoll() {
    if (_typingPollTimer) { clearInterval(_typingPollTimer); _typingPollTimer = null; }
    if (_typingState) { _typingState = false; renderTypingIndicator(false, ""); }
  }

  function sendTypingSignal(nodeId) {
    if (!nodeId || nodeId === "__local_loopback__") return;
    if (_typingSendTimer) return; // already pending, debounce
    _typingSendTimer = setTimeout(() => { _typingSendTimer = null; }, 3000);
    const threadId = makeThreadId(nodeId);
    fetch(`/mesh/chat/typing?thread_id=${encodeURIComponent(threadId)}&from_id=${encodeURIComponent(state.localNodeId)}&from_name=${encodeURIComponent(state.localNodeName)}`,
      { method: "POST" }).catch(() => {});
    // Also push directly to peer's backend for lower latency
    const remoteNode = (state.rawNodes || []).find(n => n.id === nodeId);
    if (remoteNode?.ip) {
      const base = `http://${remoteNode.ip}:${remoteNode.port || 8000}`;
      fetch(`${base}/mesh/chat/typing?thread_id=${encodeURIComponent(threadId)}&from_id=${encodeURIComponent(state.localNodeId)}&from_name=${encodeURIComponent(state.localNodeName)}`,
        { method: "POST" }).catch(() => {});
    }
  }

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

  function sendReadReceipt(nodeId) {
    if (!nodeId || nodeId === "__local_loopback__") return;
    const threadId = makeThreadId(nodeId);
    const thread = ensureThread(nodeId);
    if (!thread.length) return;
    const upToTs = Math.max(...thread.map(m => m.ts || 0));
    if (!upToTs) return;
    // Record on our own backend so the peer can poll it
    fetch(`/mesh/chat/read?thread_id=${encodeURIComponent(threadId)}&reader_id=${encodeURIComponent(state.localNodeId)}&up_to_ts=${upToTs}`,
      { method: "POST" }).catch(() => {});
    // Also push to peer's backend directly for immediacy
    const remoteNode = (state.rawNodes || []).find(n => n.id === nodeId);
    if (remoteNode?.ip) {
      const base = `http://${remoteNode.ip}:${remoteNode.port || 8000}`;
      fetch(`${base}/mesh/chat/read?thread_id=${encodeURIComponent(threadId)}&reader_id=${encodeURIComponent(state.localNodeId)}&up_to_ts=${upToTs}`,
        { method: "POST" }).catch(() => {});
    }
  }

  async function fetchReadReceipts(nodeId) {
    const threadId = makeThreadId(nodeId);
    const remoteNode = (state.rawNodes || []).find(n => n.id === nodeId);
    if (!remoteNode?.ip) return;
    const base = `http://${remoteNode.ip}:${remoteNode.port || 8000}`;
    try {
      const r = await fetch(`${base}/mesh/chat/read_status?thread_id=${encodeURIComponent(threadId)}`,
        { cache: "no-store", signal: AbortSignal.timeout(2000) });
      if (!r.ok) return;
      const d = await r.json();
      if (d.receipts) {
        _readReceipts[threadId] = d.receipts;
        // Re-render if this is the active thread
        if (state.selectedNodeId === nodeId) renderThread(nodeId);
      }
    } catch {}
  }

  async function pollChatMessages(nodeId) {
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

    // 2) Peer's store (poll their backend directly — bypasses firewall asymmetry)
    const remoteNode = (state.rawNodes || []).find(n => n.id === nodeId);
    if (remoteNode && remoteNode.ip) {
      const baseUrl = `http://${remoteNode.ip}:${remoteNode.port || 8000}`;
      try {
        const r2 = await fetch(
          `${baseUrl}/mesh/chat/messages?thread_id=${encodeURIComponent(threadId)}&since=${since}`,
          { cache: "no-store", signal: AbortSignal.timeout(3000) }
        );
        if (r2.ok) addMsgs((await r2.json()).messages);
      } catch {}
    }

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
            const serveBase  = senderNode?.ip
              ? `http://${senderNode.ip}:${senderNode.tli_port || 8000}`
              : "";
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
    const es = new EventSource("/mesh/presence/stream");
    state.presenceEs = es;

    es.onmessage = (e) => {
      try { handlePresenceEvent(JSON.parse(e.data)); } catch {}
    };

    es.onerror = () => {
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

      // Dedup by ID first, then by IP — mirrors /api/lan/peers server-side dedup.
      // The mesh directory can have multiple dev_ids for the same physical machine
      // (e.g. after an IP change), causing the SSE snapshot to emit both entries.
      const existingById = state.rawNodes.find(n => n.id === nodeId);
      const existingByIp = nodeData.ip
        ? state.rawNodes.find(n => n.ip === nodeData.ip)
        : null;
      const existing = existingById || existingByIp;

      if (existing) {
        // Update in place — prefer the newer node_id if we matched by IP
        Object.assign(existing, nodeData);
        if (existingByIp && !existingById) existing.id = nodeId;
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
        // Mark the queued message as saved
        const t = ensureThread(threadKey);
        const msg = t.find(x => x.id === msgId);
        if (msg) msg.status = "saved";
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
    // Use /api/lan/peers — works without mesh pairing, deduped by IP, no license gate.
    // Any TLI on the LAN auto-appears the moment it broadcasts a UDP beacon.
    let lanData = null;
    try {
      lanData = await safeFetchJson("/api/lan/peers");
    } catch {
      lanData = null;
    }

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
    title.innerHTML = `<span class="tchat-peer-name">${peerName}</span>`;
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
          <div class="tchat-empty-avatar">${init}</div>
          <div class="tli-empty-title">Start a conversation with ${peerName}</div>
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
        out.appendChild(renderAiCard(m));
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
        ? `<div class="tchat-avatar" title="${senderName}">${_nameInitial(senderName)}</div>`
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

      // Timestamp (show on last message of a group or if next is different sender)
      const isLastInGroup = i === msgs.length - 1 ||
        msgs[i + 1].from !== m.from ||
        (msgs[i + 1].ts && m.ts && (msgs[i + 1].ts - m.ts) > GROUP_GAP_SEC);

      if (isLastInGroup && m.ts) {
        const tsEl = document.createElement("div");
        tsEl.className = "tchat-ts";
        tsEl.textContent = _fmtMsgTime(m.ts);

        // Read receipt tick on outgoing messages
        if (isMe) {
          const threadId = makeThreadId(nodeId);
          const receipts = _readReceipts[threadId] || {};
          const peerReadTs = receipts[nodeId] || 0;
          const isRead = peerReadTs >= m.ts;
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
      input.placeholder = hasNode ? "Message… or @ai ask something together" : "Select a node to chat or share files…";
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
    const input = $("tli-chat-input");
    if (!input) return;
    const text = (input.value || "").trim();
    if (!text) return;
    if (!state.selectedNodeId) return;

    // @ai trigger — invoke shared AI in this thread
    if (/^@ai\b/i.test(text)) {
      input.value = "";
      await _invokeAiInThread(text, state.selectedNodeId);
      return;
    }

    const ts = nowTs();
    const thread = ensureThread(state.selectedNodeId);
    thread.push({ kind: "text", from: "me", body: text, ts, _msgId: ts + "|" + state.localNodeId });
    input.value = "";
    renderThread(state.selectedNodeId);

    // Find remote node IP for forwarding
    const remoteNode = state.rawNodes.find(n => n.id === state.selectedNodeId);
    const toIp = remoteNode && remoteNode.ip && state.selectedNodeId !== "__local_loopback__"
      ? remoteNode.ip : null;

    const threadId = makeThreadId(state.selectedNodeId);
    // Track last ts for outgoing so we don't echo back our own messages on poll
    if (ts > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = ts;

    try {
      await fetch("/mesh/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: threadId,
          from_id: state.localNodeId,
          from_name: state.localNodeName,
          to_id: state.selectedNodeId,
          to_ip: toIp,
          body: text,
          ts,
        }),
      });
    } catch (e) {
      console.warn("[TLI Chat] send failed:", e);
    }
  }

  // -----------------------------
  // @ai — shared AI in thread
  // -----------------------------
  async function _invokeAiInThread(rawText, toNodeId) {
    // Strip @ai prefix to get the actual question
    const question = rawText.replace(/^@ai\s*/i, "").trim() || rawText;
    const threadId  = makeThreadId(toNodeId);
    const remoteNode = (state.rawNodes || []).find(n => n.id === toNodeId);
    const toIp = remoteNode?.ip && toNodeId !== "__local_loopback__" ? remoteNode.ip : null;

    const qTs = nowTs();

    // 1. Post the question into the local thread immediately (so sender sees it)
    const thread = ensureThread(toNodeId);
    thread.push({ kind: "text", from: "me", body: rawText, ts: qTs, _msgId: qTs + "|" + state.localNodeId });
    if (qTs > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = qTs;
    renderThread(toNodeId);

    // 2. Send the question message to the peer so they see it too
    try {
      await fetch("/mesh/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: threadId,
          from_id:   state.localNodeId,
          from_name: state.localNodeName,
          to_id:     toNodeId,
          to_ip:     toIp,
          body:      rawText,
          ts:        qTs,
        }),
      });
    } catch {}

    // 3. Show "thinking" placeholder in local thread
    const thinkTs = nowTs();
    thread.push({ kind: "ai", from: "ai", body: "Thinking…", ts: thinkTs, _thinking: true });
    renderThread(toNodeId);

    // 4. Call the AI
    let reply = "";
    try {
      const r = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, max_tokens: 400, temperature: 0.3 }),
      });
      if (r.ok) {
        const d = await r.json();
        reply = d.reply || d.message?.content || "(no response)";
      } else {
        reply = "AI unavailable right now. (HTTP " + r.status + ")";
      }
    } catch (e) {
      reply = "AI unavailable — " + (e?.message || "check that a model is loaded.");
    }

    // 5. Replace thinking placeholder with real reply
    const idx = thread.findIndex(m => m._thinking);
    const aiTs = nowTs();
    const aiMsg = { kind: "ai", from: "ai", body: reply, ts: aiTs, _msgId: aiTs + "|__tli_ai__" };
    if (idx >= 0) thread.splice(idx, 1, aiMsg);
    else thread.push(aiMsg);
    if (aiTs > (_chatLastTs[threadId] || 0)) _chatLastTs[threadId] = aiTs;
    renderThread(toNodeId);

    // 6. Broadcast the AI reply into the shared thread so the peer sees it
    const broadcastBody = "__AI_REPLY__:" + JSON.stringify({ question, reply });
    try {
      await fetch("/mesh/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: threadId,
          from_id:   "__tli_ai__",
          from_name: "TLI AI",
          to_id:     toNodeId,
          to_ip:     toIp,
          body:      broadcastBody,
          ts:        aiTs,
        }),
      });
    } catch {}
  }

  // -----------------------------
  // File sharing (UI-first)
  // -----------------------------
  async function createOutgoingFileOffer(file, toNodeId) {
    const id    = genId();
    const ts    = nowTs();
    const threadId = makeThreadId(toNodeId);

    // Show outgoing card immediately
    const msg = {
      kind: "file", direction: "outgoing",
      id, name: file.name, size: file.size,
      toNodeId, status: "uploading", ts,
    };
    ensureThread(toNodeId).push(msg);
    renderThread(toNodeId);
    upsertTransfer({ id, name: file.name, size: file.size, toNodeId, status: "uploading", progress: 0, ts });

    // Upload to LOCAL backend via XHR — same origin, no CORS, no firewall issues.
    // The backend stores the file and signals the receiver via the pull-based chat store.
    const form = new FormData();
    form.append("file", file, file.name);

    const _toNode = (state.rawNodes || []).find(n => n.id === toNodeId);
    const params = new URLSearchParams({
      thread_id: threadId,
      from_id:   state.localNodeId || "",
      from_name: state.localNodeName || "Me",
      to_id:     toNodeId,
      to_ip:     _toNode?.ip || "",
      ts:        String(ts),
    });

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setTransferProgress(id, pct);
        updateTransferStatus(id, "uploading");
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setTransferProgress(id, 100);
        updateTransferStatus(id, "ready · awaiting peer");
        updateMessageStatus(toNodeId, id, "offered");
      } else {
        updateTransferStatus(id, "failed");
        updateMessageStatus(toNodeId, id, "failed");
        showToast(`File upload failed (${xhr.status}).`, "error");
      }
    });

    xhr.addEventListener("error", () => {
      updateTransferStatus(id, "failed");
      updateMessageStatus(toNodeId, id, "failed");
      showToast("File upload failed.", "error");
    });

    xhr.open("POST", `/mesh/transfer/store?${params}`);
    xhr.send(form);
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

    // Mark complete (browser handles the actual download)
    setTimeout(() => {
      setTransferProgress(m.id, 100);
      updateTransferStatus(m.id, "saved ✓");
      updateMessageStatus(state.selectedNodeId, m.id, "saved");
    }, 800);
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
          <div class="tli-empty-title">No transfers yet</div>
          <div class="tli-empty-sub">Share a file to create a transfer card.</div>
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

  function simulateProgress(id) {
    const t0 = state.transfers.find(x => x.id === id);
    if (!t0) return;
    if (["canceled", "declined", "failed"].includes(String(t0.status))) return;

    updateTransferStatus(id, "transferring");

    let p = Number(t0.progress || 0);
    const timer = setInterval(() => {
      const tr = state.transfers.find(x => x.id === id);
      if (!tr) { clearInterval(timer); return; }
      if (["canceled", "declined", "failed"].includes(String(tr.status))) { clearInterval(timer); return; }

      p += 6 + Math.random() * 12;
      if (p >= 100) {
        p = 100;
        setTransferProgress(id, p);
        updateTransferStatus(id, "verified ✓");
        clearInterval(timer);
        return;
      }
      setTransferProgress(id, p);
    }, 280);
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
    if (shareBtn && fileInput) {
      shareBtn.addEventListener("click", () => {
        if (!state.selectedNodeId) {
          alert("Select a node first (use Local Loopback if no Mesh).");
          return;
        }
        fileInput.value = "";
        fileInput.click();
      });

      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (!state.selectedNodeId) return;
        await createOutgoingFileOffer(file, state.selectedNodeId);
      });
    }

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
      bindUIOnce();
      // Mobile: initialise view state
      if (_isMobile()) {
        _setChatMobileView(state.selectedNodeId ? "thread" : "buddies");
      }
      await loadLocalNodeIdentity();
      await refreshNodes();    // initial snapshot
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
      stopChatPolling();
      stopTypingPoll();
      // bgPoll and presenceStream intentionally kept alive for off-panel notifications
    },
  };
})();
