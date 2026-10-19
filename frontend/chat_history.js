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
      window.TLIConversationLoad?.invalidate();
    }
  };

  // Restore through the single guarded loader; a newer draft or navigation wins.
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(async () => {
      try {
        const savedConvId = localStorage.getItem(ACTIVE_CONV_KEY);
        if (savedConvId && typeof window.loadConversation === "function") {
          await window.loadConversation(savedConvId, "Last conversation", {restore: true});
        }
      } catch (_) { /* Keep the current draft usable when retained history is unavailable. */ }
    }, 200);
  });

})();

// Search is a history-browser operation; results are never sent to a model.
(function () {
  "use strict";
  const protocol = "conversation-search-v1", base = "/api/intelligence/conversation-search";
  let initialized = false, busy = false, epoch = 0, cursor = null, items = [], supported = false, loadedQuery = "";
  let locked = document.getElementById('tli-lock-screen')?.getAttribute?.('aria-hidden') === 'false', ready = !locked;
  const available = () => !locked && ready;
  const current = revision => available() && revision === epoch;
  let deletion = null;
  const $ = id => document.getElementById(id);
  const element = (tag, text, id) => { const el = document.createElement(tag); if (text) el.textContent = text; if (id) el.id = id; return el; };
  const natural = value => Number.isSafeInteger(value) && value >= 0;
  const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Date not recorded";
  function validItem(item, legacy = false) {
    return item && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && typeof item.title === "string" &&
      (item.last_updated === null || typeof item.last_updated === "string" || (legacy && item.last_updated === undefined)) &&
      (legacy || (natural(item.message_count) && typeof item.provider === "string" && item.provider.length <= 64 && typeof item.snippet === "string" && [...item.snippet].length <= 242 &&
      ["title", "user", "assistant", "none"].includes(item.match?.source) && typeof item.truncated === "boolean"));
  }
  function status(text) { if ($("conversation-search-status")) $("conversation-search-status").textContent = text; }
  function controls() {
    if (!initialized) return;
    $("conversation-search-submit").disabled = !available() || busy;
    $("conversation-search-more").disabled = !available() || busy || !cursor;
    $("conversation-search-more").hidden = !cursor;
    $("conversation-search-more").style.display = cursor ? "" : "none";
    $("conversation-search-form").setAttribute("aria-busy", String(busy));
  }
  function cancelDelete() { deletion = null; $("conversation-search-delete-review")?.replaceChildren(); }
  function clear() {
    epoch++; busy = false; cursor = null; items = []; supported = false; loadedQuery = "";
    if (!initialized) return;
    cancelDelete(); $("chat-history-list").replaceChildren(); status(""); controls();
  }
  async function json(url, options) {
    const response = await fetch(url, options || {cache: "no-store"});
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Unlock TLI and verify access before reading history.'), {status:response.status});
    let data; try { data = await response.json(); } catch {
      const error = new Error("TLI returned unreadable history."); error.status = response.status; throw error;
    }
    if (!response.ok) {
      const error = new Error(typeof data?.detail === "string" ? data.detail : `History request failed (${response.status}).`);
      error.status = response.status; throw error;
    }
    return data;
  }
  async function deleteConversation(id) {
    const result = await json("/api/ai/clear-session", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({session_id: id})});
    if (result?.ok !== true || result.session_id !== id || typeof result.deleted !== "boolean") {
      throw new Error("Conversation deletion was not confirmed. Refresh history before trying again.");
    }
    return result.deleted;
  }
  window.deleteConversation = deleteConversation;
  function replyInProgress() {
    if (!$("chat-send-btn")?.disabled) return false;
    status("Wait for the current reply or cancel it before deleting a conversation.");
    return true;
  }
  function reviewDelete(item) {
    if (!available() || busy || !supported) return;
    if (replyInProgress()) return;
    deletion = item.id;
    const box = $("conversation-search-delete-review");
    box.replaceChildren(element("p", `Delete the retained conversation “${item.title}” (${date(item.last_updated)})? This removes its saved messages. Starting a new chat does not delete history.`));
    const confirm = element("button", "Delete this conversation", "conversation-search-delete-confirm"); confirm.className = "pill-btn ghost";
    const cancel = element("button", "Cancel"); cancel.className = "pill-btn ghost";
    const reviewEpoch = epoch;
    cancel.addEventListener("click", () => { if (current(reviewEpoch)) cancelDelete(); });
    confirm.addEventListener("click", async () => {
      if (!current(reviewEpoch) || busy || deletion !== item.id) return;
      if (replyInProgress()) return;
      busy = true; controls(); confirm.disabled = true; const revision = epoch;
      try {
        const removed = await window.deleteConversation(item.id);
        if (revision !== epoch) return;
        cancelDelete(); cursor = null; items = items.filter(row => row.id !== item.id); render();
        try { if (localStorage.getItem("tli_active_conv_id") === item.id) localStorage.removeItem("tli_active_conv_id"); } catch (_) {}
        window.TLIConversationLoad?.deleted?.(item.id);
        status(removed ? "Conversation deleted. Search again to refresh the remaining pages." : "That conversation is already unavailable. Search again to refresh history.");
      } catch (error) {
        if (revision === epoch) {
          if (error.status === 401 || error.status === 403) { denyAccess(); return; }
          status(error.message + " No retry ran automatically.");
        }
      }
      finally { if (revision === epoch) { busy = false; controls(); confirm.disabled = false; } }
    });
    box.append(confirm, cancel); box.scrollIntoView?.({block: "nearest"});
  }
  function render() {
    const renderedEpoch = epoch;
    const list = $("chat-history-list"); list.replaceChildren();
    for (const item of items) {
      const row = element("div"); row.className = "conversation-search-row";
      row.style.padding = "6px 12px";
      const open = element("button"); open.className = "recent-chat-btn"; open.style.display = "block"; open.style.width = "100%"; open.style.whiteSpace = "normal"; open.style.textAlign = "left";
      open.style.color = "var(--text-main)"; open.style.background = "var(--bg-elevated-alt)"; open.style.padding = "10px"; open.style.lineHeight = "1.5";
      open.append(element("strong", item.title || "Untitled conversation"), element("div", `${date(item.last_updated)} · ${item.provider || "Provider not recorded"} · ${item.message_count ?? "?"} messages`));
      if (item.snippet) {
        const source = {title: "Matching title", user: "Matching user message", assistant: "Matching AI/TLI message"}[item.match?.source] || "Matching saved text";
        open.append(element("small", `${source} · ${date(item.match?.at)}`), element("div", item.snippet));
      }
      if (item.truncated) open.append(element("small", "Only part of this conversation's text was inspected."));
      let opening = false;
      open.addEventListener("click", async () => {
        if (!current(renderedEpoch) || opening || busy || typeof window.loadConversation !== "function") return;
        opening = true; open.disabled = true; const revision = epoch;
        try {
          const loaded = await window.loadConversation(item.id, item.title);
          if (revision === epoch && loaded === true) close();
        } catch (error) { if (revision === epoch) status(error.message || "This conversation could not be opened."); }
        finally { opening = false; open.disabled = false; }
      });
      row.appendChild(open);
      if (supported) { const remove = element("button", "Delete"); remove.className = "pill-btn ghost"; remove.setAttribute("aria-label", "Delete conversation: " + item.title); remove.addEventListener("click", () => { if (current(renderedEpoch)) reviewDelete(item); }); row.appendChild(remove); }
      list.appendChild(row);
    }
  }
  async function run(more = false) {
    if (!initialized || !available() || busy || (more && !cursor)) return;
    const query = $("conversation-search-query").value.trim();
    if (query.length > 120) { status("Use at most 120 characters."); return; }
    const revision = ++epoch, pageCursor = more ? cursor : null;
    cancelDelete(); busy = true; controls(); status("Searching retained conversations… Nothing is being sent to AI.");
    try {
      let capability, unsupported = false;
      try { capability = await json(base + "/capabilities"); }
      catch (error) { if (![404,405].includes(error.status)) throw error; unsupported = true; }
      if (!current(revision)) return;
      if (!unsupported && (capability?.ok !== true || capability.protocol !== protocol)) throw Error('The history capability response could not be validated.');
      supported = !unsupported;
      if (unsupported) {
        const legacy = await json("/api/ai/conversations");
        if (revision !== epoch) return;
        if (!Array.isArray(legacy?.conversations) || !legacy.conversations.every(item => validItem(item, true))) throw new Error("Recent history returned an invalid format.");
        items = legacy.conversations.slice(0, 20); cursor = null; render();
        status("Search is unsupported by this running TLI backend. Showing the latest 20 conversations only; the search text was not applied. Restart the updated backend to search older history.");
        return;
      }
      const url = base + "?q=" + encodeURIComponent(query) + "&limit=20" + (pageCursor ? "&cursor=" + encodeURIComponent(pageCursor) : "");
      const data = await json(url);
      if (revision !== epoch) return;
      const coverage = data?.coverage;
      if (data?.ok !== true || data.protocol !== protocol || data.query !== query || !Array.isArray(data.items) || data.items.length > 20 ||
          !data.items.every(item => validItem(item)) || new Set(data.items.map(i => i.id)).size !== data.items.length ||
          (data.next_cursor !== null && !/^[a-f0-9]{32}$/.test(data.next_cursor)) || typeof coverage?.complete !== "boolean" ||
          typeof coverage.text_limited !== "boolean" || coverage.more_to_search !== (data.next_cursor !== null) ||
          !natural(coverage.scanned_conversations) || !natural(coverage.owned_conversations) || coverage.scanned_conversations > coverage.owned_conversations ||
          !natural(coverage.limits?.messages_per_conversation) || !natural(coverage.limits.characters_per_message)) throw new Error("The search result could not be validated.");
      if (more && (loadedQuery !== query || data.items.some(item => items.some(old => old.id === item.id)))) throw new Error("History changed while paging. Search again.");
      items = more ? [...items, ...data.items] : data.items;
      cursor = data.next_cursor; loadedQuery = query; render();
      const limitation = coverage.text_limited ? ` Some text was not inspected (up to ${coverage.limits.messages_per_conversation} messages per conversation and ${coverage.limits.characters_per_message.toLocaleString()} characters per message). Absence from these results does not mean a conversation is missing.` : "";
      status(`${items.length} ${query ? "matching" : "retained"} conversations shown. ${coverage.scanned_conversations} of ${coverage.owned_conversations} owned conversations inspected.${cursor ? " Load more to continue searching older history." : ""}${limitation} Nothing was sent to AI.`);
    } catch (error) {
      if (revision === epoch) {
        if (error.status === 401 || error.status === 403) { denyAccess(); return; }
        cursor = null; render(); status(error.message + " Start the search again to refresh history.");
      }
    } finally { if (revision === epoch) { busy = false; controls(); } }
  }
  function close() { clear(); $("chat-history-drawer")?.classList.add("hidden"); $("chat-history-btn")?.setAttribute("aria-expanded", "false"); }
  function suspend() {
    locked = true; ready = false; close();
    if ($('conversation-search-query')) $('conversation-search-query').value = '';
  }
  function denyAccess() {
    suspend();
    window.dispatchEvent(new CustomEvent('tli-session-locked'));
    status('Unlock TLI and verify access before reading history.');
  }
  function open() {
    setup(); if (!initialized) return;
    if (!available()) { status('Unlock TLI and verify access before reading history.'); return; }
    $("chat-history-drawer").classList.remove("hidden"); $("chat-history-btn")?.setAttribute("aria-expanded", "true");
    $("conversation-search-query").focus(); return run();
  }
  function setup() {
    if (initialized || !$("chat-history-list") || !$("chat-history-drawer")) return;
    initialized = true;
    $("chat-history-drawer").style.background = "var(--bg-elevated)";
    $("chat-history-drawer").style.color = "var(--text-main)";
    $("chat-history-drawer").style.overflowY = "auto";
    $("chat-history-drawer").setAttribute("role", "region");
    const form = element("form", "", "conversation-search-form"); form.style.padding = "12px"; form.style.minWidth = "0";
    const label = element("label", "Search retained conversations ");
    const input = element("input", "", "conversation-search-query"); input.type = "search"; input.maxLength = 120; input.placeholder = "Title or message text";
    input.style.width = "100%"; input.style.minWidth = "0"; input.style.margin = "8px 0"; label.appendChild(input);
    input.style.color = "var(--text-main)"; input.style.background = "var(--bg-elevated-alt)";
    input.style.border = "1px solid var(--border-subtle)"; input.style.borderRadius = "8px"; input.style.padding = "8px";
    const submit = element("button", "Search", "conversation-search-submit"); submit.type = "submit"; submit.className = "pill-btn primary";
    const message = element("p", "", "conversation-search-status"); message.setAttribute("role", "status"); message.style.overflowWrap = "anywhere";
    form.append(label, submit, message); form.addEventListener("submit", event => { event.preventDefault(); run(); });
    input.addEventListener("input", () => { if (!available()) return; clear(); status("Press Search to apply this text. Nothing is sent to AI."); });
    $("chat-history-list").before(form);
    const more = element("button", "Load more", "conversation-search-more"); more.className = "pill-btn ghost"; more.style.margin = "12px"; more.addEventListener("click", () => run(true));
    $("chat-history-list").after(more, element("div", "", "conversation-search-delete-review"));
    $("conversation-search-delete-review").style.padding = "0 12px 12px";
    $("chat-history-list").style.overflowWrap = "anywhere";
    $("chat-history-list").style.maxHeight = "min(50vh, 480px)";
    $("chat-history-list").style.overflowY = "auto";
    $("chat-history-btn")?.addEventListener("click", open); $("chat-history-close")?.addEventListener("click", close);
    const recent = $("recent-chats-list");
    if (recent) { const button = element("button", "Search older chats", "conversation-search-open"); button.className = "pill-btn ghost"; button.addEventListener("click", open); recent.before(button); }
    $("chat-history-drawer").addEventListener("keydown", event => { if (event.key === "Escape") close(); });
    controls();
  }
  for (const event of ['tli-session-locked','tli-account-changed','tli-user-changed','pagehide']) window.addEventListener(event, suspend);
  window.addEventListener('tli-session-unlocked', () => { locked = false; controls(); });
  window.addEventListener('tli-private-observation-ready', () => { if (!locked) { ready = true; controls(); } });
  window.TLIConversationSearch = {open, clear, refresh: () => run()};
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup); else setup();
})();
