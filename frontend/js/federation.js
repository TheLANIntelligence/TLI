// FEDERATED CHAT + BUILT-IN RELAY
// =====================================================
function setupFederatedChat() {
  if (setupFederatedChat._done) return;
  setupFederatedChat._done = true;

  // ── Element refs ─────────────────────────────────────────────────
  const dot           = document.getElementById("fed-dot");
  const statusLabel   = document.getElementById("fed-status-label");
  const disconnectBtn = document.getElementById("fed-disconnect-btn");
  const pairPane      = document.getElementById("fed-pair-pane");
  const chatPane      = document.getElementById("fed-chat-pane");
  const createBtn     = document.getElementById("fed-create-btn");
  const joinInput     = document.getElementById("fed-join-input");
  const joinBtn       = document.getElementById("fed-join-btn");
  const codeDisplay   = document.getElementById("fed-code-display");
  const codeValue     = document.getElementById("fed-code-value");
  const relayInput    = document.getElementById("fed-relay-input");
  const relaySave     = document.getElementById("fed-relay-save");
  const relayHint     = document.getElementById("fed-relay-hint");
  const peersRow      = document.getElementById("fed-peers-row");
  const thread        = document.getElementById("fed-thread");
  const fedInput      = document.getElementById("fed-input");
  const sendBtn       = document.getElementById("fed-send-btn");

  // Relay panel refs
  const relayDot      = document.getElementById("fed-relay-dot");
  const relaySub      = document.getElementById("fed-relay-sub");
  const relayToggle   = document.getElementById("fed-relay-toggle");
  const relayUrlBadge = document.getElementById("fed-relay-url-badge");
  const relayPortRow  = document.getElementById("fed-relay-port-row");
  const relayPort     = document.getElementById("fed-relay-port");
  const relayCopyUrl  = document.getElementById("fed-relay-copy-url");

  if (!dot) return;

  let _connected = false;
  let _sse = null;
  let _relayRunning = false;
  let _relayUrl = null;

  // ── Load federation status ──────────────────────────────────────
  fetch("/federation/status").then(r => r.json()).then(d => {
    if (relayInput) relayInput.value = d.relay_url || "ws://localhost:9000";
    if (d.connected || d.connecting) _applyStatus(d);
    if (d.room && (d.connected || d.connecting)) {
      if (codeDisplay) codeDisplay.hidden = false;
      if (codeValue)   codeValue.textContent = d.room;
    }
  }).catch(() => {});

  // Load existing messages
  fetch("/federation/messages").then(r => r.json()).then(d => {
    (d.messages || []).forEach(m => _appendMsg(m));
  }).catch(() => {});

  // ── Relay panel ──────────────────────────────────────────────────
  async function _loadRelayStatus() {
    try {
      const d = await fetch("/relay/status").then(r => r.json());
      _relayRunning = d.running;
      _relayUrl     = d.ws_url || null;

      if (relayDot) {
        relayDot.className = "fed-relay-dot" + (d.running ? " running" : "");
      }
      if (relaySub) {
        relaySub.textContent = d.running
          ? `Running on port ${d.port} · ${d.rooms} room(s) · ${d.peers} peer(s)`
          : "Off — enable to let others connect through this node";
      }
      if (relayToggle) {
        relayToggle.textContent = d.running ? "Stop" : "Enable";
        relayToggle.className   = d.running ? "pill-btn danger" : "pill-btn";
      }
      if (relayPortRow) relayPortRow.hidden = !d.running;
      if (relayUrlBadge) {
        relayUrlBadge.hidden = !d.running;
        relayUrlBadge.textContent = d.ws_url || "";
      }

      // Auto-fill relay input with local relay URL if it's running and input is default/empty
      if (d.running && d.ws_url && relayInput) {
        const cur = (relayInput.value || "").trim();
        if (!cur || cur === "ws://localhost:9000") {
          relayInput.value = d.ws_url;
        }
        if (relayHint) {
          relayHint.textContent = `Your relay is running at ${d.ws_url} — share this URL with your contact.`;
          relayHint.style.color = "var(--accent)";
        }
      } else if (relayHint && !_relayRunning) {
        relayHint.textContent = "";
      }

      if (relayPort && !d.running) {
        relayPort.value = d.port || 9000;
      }
    } catch {}
  }

  if (relayToggle) {
    relayToggle.addEventListener("click", async () => {
      relayToggle.disabled = true;
      try {
        if (_relayRunning) {
          await fetch("/relay/stop", { method: "POST" });
        } else {
          const port = parseInt(relayPort?.value || "9000", 10);
          const r = await fetch("/relay/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ port }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            if (typeof showToast === "function") showToast(d.detail || "Could not start relay", "error");
            return;
          }
          const d = await r.json();
          if (typeof showToast === "function") showToast(`Relay started at ${d.ws_url}`, "success");
        }
        await _loadRelayStatus();
      } catch (e) {
        if (typeof showToast === "function") showToast("Relay error: " + e.message, "error");
      } finally {
        relayToggle.disabled = false;
      }
    });
  }

  if (relayCopyUrl) {
    relayCopyUrl.addEventListener("click", () => {
      if (_relayUrl) {
        navigator.clipboard.writeText(_relayUrl)
          .then(() => { if (typeof showToast === "function") showToast("Relay URL copied"); });
      }
    });
  }

  _loadRelayStatus();
  // Refresh relay stats every 15 s while panel is open
  setInterval(() => {
    if (!document.getElementById("panel-mesh")?.hidden === false) return;
    if (_relayRunning) _loadRelayStatus();
  }, 15000);

  // ── Relay URL settings ───────────────────────────────────────────
  if (relaySave && relayInput) {
    relaySave.addEventListener("click", async () => {
      relaySave.textContent = "Saving…";
      try {
        await fetch("/federation/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ relay_url: relayInput.value.trim() }),
        });
        relaySave.textContent = "Saved ✓";
        setTimeout(() => { relaySave.textContent = "Save"; }, 2000);
      } catch { relaySave.textContent = "Save"; }
    });
  }

  // ── Create pairing code ──────────────────────────────────────────
  if (createBtn) {
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      createBtn.textContent = "Generating…";
      try {
        const r = await fetch("/federation/pair/create", { method: "POST" });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.detail || "Failed");
        }
        const d = await r.json();
        if (codeDisplay) codeDisplay.hidden = false;
        if (codeValue)   codeValue.textContent = d.code;
        _startSSE();
      } catch (e) {
        if (typeof showToast === "function") showToast("Failed to create pairing: " + e.message, "error");
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = "Generate Code";
      }
    });
  }

  // ── Join with code ───────────────────────────────────────────────
  if (joinBtn && joinInput) {
    const _doJoin = async () => {
      const code = joinInput.value.trim().toUpperCase();
      if (!code) return;
      joinBtn.disabled = true;
      joinBtn.textContent = "Joining…";
      try {
        const r = await fetch("/federation/pair/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.detail || "Failed");
        }
        const d = await r.json();
        if (codeDisplay) codeDisplay.hidden = false;
        if (codeValue)   codeValue.textContent = d.code;
        _startSSE();
      } catch (e) {
        if (typeof showToast === "function") showToast("Failed to join: " + e.message, "error");
      } finally {
        joinBtn.disabled = false;
        joinBtn.textContent = "Join";
      }
    };
    joinBtn.addEventListener("click", _doJoin);
    joinInput.addEventListener("keydown", e => { if (e.key === "Enter") _doJoin(); });
  }

  // ── Disconnect ───────────────────────────────────────────────────
  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", async () => {
      await fetch("/federation/pair", { method: "DELETE" }).catch(() => {});
      _stopSSE();
      _applyStatus({ connected: false, connecting: false, peers: [] });
      if (thread)      thread.innerHTML = "";
      if (codeDisplay) codeDisplay.hidden = true;
      if (joinInput)   joinInput.value = "";
    });
  }

  // ── Send message ─────────────────────────────────────────────────
  const _doSend = async () => {
    const text = fedInput?.value?.trim();
    if (!text || !_connected) return;
    fedInput.value = "";
    try {
      const r = await fetch("/federation/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (d.message) _appendMsg(d.message);
    } catch {}
  };

  if (sendBtn) sendBtn.addEventListener("click", _doSend);
  if (fedInput) fedInput.addEventListener("keydown", e => { if (e.key === "Enter") _doSend(); });

  // ── SSE ──────────────────────────────────────────────────────────
  function _startSSE() {
    _stopSSE();
    _sse = new EventSource("/federation/events");
    _sse.onmessage = e => {
      try { _handleEvent(JSON.parse(e.data)); } catch {}
    };
    _sse.onerror = () => { setTimeout(_startSSE, 3000); };
  }

  function _stopSSE() {
    if (_sse) { _sse.close(); _sse = null; }
  }

  function _handleEvent(ev) {
    const t = ev.type;
    if (t === "status") {
      _applyStatus(ev);
    } else if (t === "message") {
      _appendMsg(ev);
    } else if (t === "peer_joined" || t === "peer_left") {
      _renderPeers(ev.peers || []);
      _appendMsg({ from: "system",
                   text: t === "peer_joined" ? `${ev.name} joined` : `${ev.name} left`,
                   own: false });
      if (t === "peer_joined" && typeof showToast === "function")
        showToast(`${ev.name} joined the room`, "success");
    } else if (t === "error") {
      if (typeof showToast === "function") showToast(ev.detail, "error");
    }
  }

  // ── UI updates ───────────────────────────────────────────────────
  function _applyStatus(d) {
    _connected = d.connected || false;
    const connecting = d.connecting || false;

    dot.className = "fed-status-dot"
      + (_connected ? " connected" : connecting ? " connecting" : "");
    statusLabel.textContent = _connected
      ? `Connected · Room ${d.room || ""} · ${(d.peers || []).length} peer(s)`
      : connecting ? "Connecting to relay…" : "Not connected";

    if (disconnectBtn) disconnectBtn.hidden = !_connected && !connecting;

    if (_connected) {
      if (pairPane) pairPane.hidden = true;
      if (chatPane) chatPane.hidden = false;
      _renderPeers(d.peers || []);
      if (fedInput) fedInput.focus();
    } else if (!connecting) {
      if (pairPane) pairPane.hidden = false;
      if (chatPane) chatPane.hidden = true;
    }
  }

  function _renderPeers(peers) {
    if (!peersRow) return;
    peersRow.innerHTML = peers.length
      ? peers.map(p => `<span class="fed-peer-chip">${p}</span>`).join("")
      : `<span style="font-size:12px;color:var(--text-muted)">Waiting for peer to join…</span>`;
  }

  function _appendMsg(msg) {
    if (!thread) return;
    const div = document.createElement("div");
    if (msg.from === "system") {
      div.className = "fed-msg system";
      div.textContent = msg.text;
    } else {
      div.className = "fed-msg " + (msg.own ? "own" : "peer");
      if (!msg.own) {
        const sender = document.createElement("div");
        sender.className = "fed-msg-sender";
        sender.textContent = msg.from;
        div.appendChild(sender);
      }
      const body = document.createElement("div");
      body.textContent = msg.text;
      div.appendChild(body);
    }
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  // Start SSE if already paired
  fetch("/federation/status").then(r => r.json()).then(d => {
    if (d.connected || d.connecting) _startSSE();
  }).catch(() => {});
}
