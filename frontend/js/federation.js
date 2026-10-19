// The legacy room relay is retired. Keep private history and explicit cleanup;
// trusted LAN messaging, inference and Companion use separate modules.
function setupFederatedChat() {
  if (setupFederatedChat._done) return;
  setupFederatedChat._done = true;
  const dot = document.getElementById("fed-dot");
  if (!dot) return;
  const statusLabel = document.getElementById("fed-status-label");
  const disconnectBtn = document.getElementById("fed-disconnect-btn");
  const pairPane = document.getElementById("fed-pair-pane");
  const chatPane = document.getElementById("fed-chat-pane");
  const thread = document.getElementById("fed-thread");
  const fedInput = document.getElementById("fed-input");
  const sendBtn = document.getElementById("fed-send-btn");
  const peersRow = document.getElementById("fed-peers-row");
  const relayDot = document.getElementById("fed-relay-dot");
  const relaySub = document.getElementById("fed-relay-sub");
  const relayToggle = document.getElementById("fed-relay-toggle");
  const relayUrlBadge = document.getElementById("fed-relay-url-badge");
  const relayPortRow = document.getElementById("fed-relay-port-row");
  const relayHint = document.getElementById("fed-relay-hint");
  const relayCopyUrl = document.getElementById("fed-relay-copy-url");
  const card = document.getElementById("fed-chat-card");
  const reason = "Legacy cross-network relay is unavailable. Trusted LAN messaging and inference are separate.";
  let locked = false, relayRunning = null, relayBusy = false, relayLoading = false, relayEpoch = 0;
  let fedEpoch = 0, fedLoading = false, fedBusy = false, fedConnected = null;
  let relayNeedsRecovery = true, fedNeedsRecovery = true;
  const refresh = document.createElement("button");
  refresh.type = "button"; refresh.className = "pill-btn ghost";
  refresh.textContent = "Refresh saved messages";
  if (card) card.appendChild(refresh);
  if (pairPane) pairPane.hidden = true;
  if (chatPane) chatPane.hidden = false;
  if (fedInput) { fedInput.disabled = true; fedInput.placeholder = "Legacy relay is unavailable"; }
  if (sendBtn) sendBtn.disabled = true;
  if (relayCopyUrl) relayCopyUrl.hidden = true;
  if (relayUrlBadge) { relayUrlBadge.hidden = true; relayUrlBadge.textContent = ""; }
  if (relayPortRow) relayPortRow.hidden = true;
  if (relayHint) relayHint.textContent = "";
  if (statusLabel) statusLabel.textContent = reason;
  if (disconnectBtn) disconnectBtn.hidden = true;

  function errorText(response, data, fallback) {
    if (typeof data?.detail === "string" && data.detail.trim()) return data.detail;
    if (response.status === 401) return "Unlock TLI, then check status again.";
    if (response.status === 403) return "Access denied. Check your access, then check status again.";
    return fallback;
  }
  function accessDenied(response, ticket, area) {
    if (![401, 403].includes(response.status) || locked || ticket !== (area === "relay" ? relayEpoch : fedEpoch)) return false;
    window.dispatchEvent(new CustomEvent("tli-session-locked"));
    return true;
  }
  function relayUnknown(message) {
    relayRunning = null;
    if (relayDot) relayDot.className = "fed-relay-dot";
    if (relaySub) relaySub.textContent = message;
    if (relayToggle) { relayToggle.textContent = "Check status"; relayToggle.className = "pill-btn"; }
  }
  function relayAccessError(ticket, response, data) {
    const deniedHere = locked && ticket + 1 === relayEpoch;
    const reopened = !locked && !relayLoading && relayRunning === null && ticket + 2 === relayEpoch;
    if (response.status === 401 && (deniedHere || reopened)) {
      relayUnknown(errorText(response, data, "Unlock TLI to check relay status."));
    }
  }
  async function loadRelayStatus() {
    if (locked || relayLoading) return;
    relayLoading = true; relayNeedsRecovery = false;
    const ticket = ++relayEpoch;
    if (relayToggle) relayToggle.disabled = true;
    try {
      const response = await fetch("/relay/status");
      const data = await response.json().catch(() => null);
      relayAccessError(ticket, response, data);
      if (ticket !== relayEpoch || locked) return;
      if (accessDenied(response, ticket, "relay")) { relayUnknown(errorText(response, data, "Unlock TLI to check relay status.")); return; }
      if (!response.ok) throw Error(errorText(response, data, "Could not read relay status."));
      if (!data || typeof data.running !== "boolean") throw Error("Relay status could not be confirmed.");
      relayRunning = data.running;
      if (relayDot) relayDot.className = "fed-relay-dot" + (relayRunning ? " running" : "");
      if (relaySub) relaySub.textContent = relayRunning
        ? "Legacy relay cleanup is still needed. Stop it to close any remaining connections."
        : reason + " No listener is running.";
      if (relayToggle) { relayToggle.textContent = relayRunning ? "Stop" : "Check status"; relayToggle.className = relayRunning ? "pill-btn danger" : "pill-btn"; }
    } catch (error) {
      if (ticket === relayEpoch && !locked) { relayNeedsRecovery = true; relayUnknown("Relay status unavailable. " + error.message + " Use Check status to try again."); }
    } finally {
      if (ticket === relayEpoch) { relayLoading = false; if (relayToggle) relayToggle.disabled = relayBusy || locked; }
    }
  }
  if (relayToggle) relayToggle.addEventListener("click", async () => {
    if (relayBusy || relayLoading || locked) return;
    if (relayRunning !== true) { await loadRelayStatus(); return; }
    relayBusy = true; relayToggle.disabled = true;
    const ticket = ++relayEpoch;
    try {
      const response = await fetch("/relay/stop", {method:"POST"});
      const data = await response.json().catch(() => null);
      relayAccessError(ticket, response, data);
      if (ticket !== relayEpoch || locked) return;
      if (accessDenied(response, ticket, "relay")) { relayUnknown(errorText(response, data, "Unlock TLI to check relay status.")); return; }
      if (!response.ok) throw Error(errorText(response, data, "Could not stop relay."));
      if (data?.ok !== true) throw Error("Relay request outcome could not be confirmed.");
      await loadRelayStatus();
    } catch (error) {
      if (ticket === relayEpoch && !locked) {
        relayUnknown("Relay request could not be confirmed. " + error.message + " Check status before retrying.");
        if (typeof showToast === "function") showToast("Relay error: " + error.message, "error");
      }
    } finally { relayBusy = false; relayToggle.disabled = locked || relayLoading; }
  });

  async function loadHistory() {
    if (locked || fedLoading || fedBusy) return;
    const ticket = ++fedEpoch;
    fedLoading = true; fedNeedsRecovery = false; refresh.disabled = true;
    if (disconnectBtn) disconnectBtn.disabled = true;
    try {
      const response = await fetch("/federation/status");
      const data = await response.json().catch(() => null);
      if (ticket !== fedEpoch || locked) return;
      if (accessDenied(response, ticket, "federation")) return;
      if (!response.ok) throw Error(errorText(response, data, "Could not read saved federation status."));
      if (!data || data.available !== false || typeof data.connected !== "boolean" || typeof data.connecting !== "boolean") throw Error("Saved federation status could not be confirmed.");
      fedConnected = data.connected || data.connecting;
      if (disconnectBtn) disconnectBtn.hidden = !fedConnected;
      if (statusLabel) statusLabel.textContent = fedConnected ? reason + " An existing connection needs to be disconnected." : reason;
      const history = await fetch("/federation/messages");
      const result = await history.json().catch(() => null);
      if (ticket !== fedEpoch || locked) return;
      if (accessDenied(history, ticket, "federation")) return;
      if (!history.ok) throw Error(errorText(history, result, "Could not read saved messages."));
      if (!Array.isArray(result?.messages)) throw Error("Saved messages could not be confirmed.");
      if (thread) {
        thread.textContent = "";
        for (const message of result.messages) {
          const row = document.createElement("div"); row.className = "fed-msg";
          row.textContent = `${message.from || "Unknown"}: ${message.text || ""}`;
          thread.appendChild(row);
        }
        if (!result.messages.length) thread.textContent = "No messages are retained in this running session.";
      }
    } catch (error) {
      if (ticket === fedEpoch && !locked) {
        fedConnected = null; fedNeedsRecovery = true;
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (statusLabel) statusLabel.textContent = reason + " " + error.message;
      }
    } finally {
      if (ticket === fedEpoch) {
        fedLoading = false; refresh.disabled = locked || fedBusy;
        if (disconnectBtn) disconnectBtn.disabled = locked || fedBusy;
      }
    }
  }
  refresh.addEventListener("click", loadHistory);
  if (disconnectBtn) disconnectBtn.addEventListener("click", async () => {
    if (locked || fedBusy || fedLoading || fedConnected !== true) return;
    fedBusy = true; disconnectBtn.disabled = true; refresh.disabled = true;
    const ticket = ++fedEpoch;
    try {
      const response = await fetch("/federation/pair", {method:"DELETE"});
      const data = await response.json().catch(() => null);
      if (ticket !== fedEpoch || locked) return;
      if (accessDenied(response, ticket, "federation")) return;
      if (!response.ok || data?.ok !== true) throw Error(errorText(response, data, "Disconnect outcome could not be confirmed."));
      fedConnected = false; disconnectBtn.hidden = true;
      if (statusLabel) statusLabel.textContent = reason + " Existing connection disconnected; retained messages are unchanged.";
    } catch (error) {
      if (ticket === fedEpoch && !locked) {
        fedConnected = null; disconnectBtn.hidden = true;
        if (statusLabel) statusLabel.textContent = error.message + " Refresh saved messages to check status before retrying.";
      }
    } finally {
      fedBusy = false; disconnectBtn.disabled = locked || fedLoading; refresh.disabled = locked || fedLoading;
    }
  });
  window.addEventListener("tli-session-locked", () => {
    locked = true; relayEpoch++; fedEpoch++; relayLoading = false; fedLoading = false; fedConnected = null;
    relayNeedsRecovery = true; fedNeedsRecovery = true;
    relayUnknown("Unlock TLI to check relay status.");
    if (relayToggle) relayToggle.disabled = true;
    if (thread) thread.textContent = "";
    if (peersRow) peersRow.textContent = "";
    if (fedInput) fedInput.value = "";
    if (statusLabel) statusLabel.textContent = "Unlock TLI to view retained messages.";
    if (disconnectBtn) { disconnectBtn.hidden = true; disconnectBtn.disabled = true; }
    refresh.disabled = true;
  });
  window.addEventListener("tli-session-unlocked", () => {
    locked = false; relayEpoch++; fedEpoch++; relayLoading = false; fedLoading = false;
    relayNeedsRecovery = true; fedNeedsRecovery = true;
    if (relayToggle) relayToggle.disabled = relayBusy || relayLoading;
    refresh.disabled = fedBusy || fedLoading;
  });
  window.addEventListener("tli-private-observation-ready", () => {
    if (!locked) { if (relayNeedsRecovery) loadRelayStatus(); if (fedNeedsRecovery) loadHistory(); }
  });
  relayUnknown("Checking relay status…");
  loadRelayStatus(); loadHistory();
  setInterval(() => {
    if (!document.hidden && document.getElementById("panel-mesh")?.hidden === false && !locked && !relayBusy && relayRunning === true) loadRelayStatus();
  }, 15000);
}
