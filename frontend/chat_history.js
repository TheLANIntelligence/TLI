// TLI Chat History — persistent AI conversation across page reloads
// Defines the 6 history functions called (but never defined) in app.js:
//   chatHistoryAdd, saveChatHistoryToStorage, loadChatHistoryFromStorage,
//   clearChatHistoryStorage, saveConversation, resetChatHistory
// Also restores the last conversation from the backend on page load.

(function () {
  "use strict";

  const ACTIVE_CONV_KEY = "tli_active_conv_id";

  // ── In-memory history (used by LAN AI for context window) ──────────
  if (typeof window.chatHistory === "undefined") {
    window.chatHistory = [];
  }

  // ── chatHistoryAdd ─────────────────────────────────────────────────
  // Called after every user/assistant exchange to maintain LAN AI context.
  window.chatHistoryAdd = function chatHistoryAdd(role, content) {
    if (!Array.isArray(window.chatHistory)) window.chatHistory = [];
    window.chatHistory.push({ role, content });
    // Keep a reasonable window — don't grow forever
    if (window.chatHistory.length > 80) {
      window.chatHistory = window.chatHistory.slice(-60);
    }
    // Persist active conversation ID so we can reload it on next visit
    if (window.currentConversationId) {
      try { localStorage.setItem(ACTIVE_CONV_KEY, window.currentConversationId); } catch (_) {}
    }
  };

  // ── saveChatHistoryToStorage ───────────────────────────────────────
  // Called when the draft conversation ID is migrated to a real conv_id.
  window.saveChatHistoryToStorage = function saveChatHistoryToStorage(convId) {
    if (convId && convId !== "__draft__") {
      try { localStorage.setItem(ACTIVE_CONV_KEY, convId); } catch (_) {}
    }
  };

  // ── loadChatHistoryFromStorage ─────────────────────────────────────
  // Called once on DOMContentLoaded by app.js. Return empty — the real
  // restore happens in our own DOMContentLoaded listener below, which
  // uses the already-defined loadConversation() to do a proper backend fetch.
  window.loadChatHistoryFromStorage = function loadChatHistoryFromStorage(_convId) {
    return [];
  };

  // ── clearChatHistoryStorage ────────────────────────────────────────
  // Called when the draft key should be removed (draft migrated to real id).
  window.clearChatHistoryStorage = function clearChatHistoryStorage(_convId) {
    try { localStorage.removeItem(ACTIVE_CONV_KEY); } catch (_) {}
  };

  // ── saveConversation ───────────────────────────────────────────────
  // Called after each exchange. The backend already saved the message;
  // we just need to keep the conv_id in localStorage.
  window.saveConversation = function saveConversation(_userText, _aiReply, convId) {
    if (convId) {
      try { localStorage.setItem(ACTIVE_CONV_KEY, convId); } catch (_) {}
    }
  };

  // ── resetChatHistory ───────────────────────────────────────────────
  // Called by the "New Chat" button in app.js.
  window.resetChatHistory = function resetChatHistory({ alsoClearStorage = false } = {}) {
    window.chatHistory = [];
    if (alsoClearStorage) {
      try { localStorage.removeItem(ACTIVE_CONV_KEY); } catch (_) {}
      // Best-effort delete from backend so it doesn't reappear on reload
      const convId = window.currentConversationId;
      if (convId) {
        fetch("/api/ai/clear-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: convId }),
        }).catch(() => {});
      }
    }
  };

  // ── Restore last conversation on page load ─────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    // Short delay so app.js DOMContentLoaded finishes first
    // (renders the chat panel skeleton before we inject messages into it)
    setTimeout(async () => {
      const savedConvId = localStorage.getItem(ACTIVE_CONV_KEY);
      if (!savedConvId) return;

      try {
        const resp = await fetch(`/api/ai/conversations/${encodeURIComponent(savedConvId)}`);

        if (resp.status === 404) {
          // Conversation was cleared server-side — remove stale key
          localStorage.removeItem(ACTIVE_CONV_KEY);
          return;
        }
        if (!resp.ok) return;

        const conv = await resp.json();
        const messages = conv.messages || [];
        if (!messages.length) return;

        // Restore in-memory context for LAN AI
        window.chatHistory = messages.map(m => ({ role: m.role, content: m.content }));
        window.currentConversationId = savedConvId;

        // Render into the chat output
        const output = document.getElementById("chat-output");
        if (!output) return;

        // Remove the empty-state placeholder
        const empty = output.querySelector(".chat-output-empty");
        if (empty) empty.remove();

        // Divider: oldest messages at top, divider first
        const divider = document.createElement("div");
        divider.className = "chat-history-resumed";
        const count = messages.length;
        divider.textContent = `— ${count} message${count !== 1 ? "s" : ""} from last session —`;
        output.appendChild(divider);

        // Render each message using the existing appendMessage function
        for (const msg of messages) {
          try {
            const role = msg.role === "user" ? "user" : "ai";
            if (typeof appendMessage === "function") {
              appendMessage(role, msg.content);
            }
          } catch (_) {}
        }

        // Scroll to bottom so latest message is visible
        output.scrollTop = output.scrollHeight;

      } catch (_) {
        // Never break the chat panel — silent fail
      }
    }, 200);
  });

})();
