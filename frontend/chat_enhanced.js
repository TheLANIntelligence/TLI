/* ============================================
   TLI Chat Enhanced — drop-in after app.js
   
   Upgrades:
   - Proper markdown rendering (headers, bold, italic, lists, code blocks, tables)
   - Code blocks with language label + copy button
   - Animated typing dots during thinking
   - Streaming cursor (blinking caret)
   - Timestamps + copy button on hover
   - Smooth auto-scroll
   ============================================ */

(function () {
  "use strict";

  // ========================================
  //  Lightweight Markdown → HTML renderer
  // ========================================

  function mdToHTML(raw) {
    if (window.TLIChatFormat) return window.TLIChatFormat.render(raw);
    // A partially updated frontend still displays escaped plain text safely.
    return String(raw ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }


  // ========================================
  //  Global: copy code block content
  // ========================================
  window.tliCopyCode = function (btn) {
    const wrapper = btn.closest(".code-block-wrapper");
    if (!wrapper) return;
    const codeEl = wrapper.querySelector(".code-block-code");
    if (!codeEl) return;
    const text = codeEl.textContent || "";
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      btn.style.color = "var(--accent)";
      setTimeout(() => { btn.textContent = orig; btn.style.color = ""; }, 1500);
    }).catch(() => {});
  };


  // ========================================
  //  Override: renderAssistantHTML
  // ========================================
  window.renderAssistantHTML = function (raw) {
    return mdToHTML(raw);
  };


  // ========================================
  //  Timestamp helper
  // ========================================
  function _timeStr() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }


  // ========================================
  //  Override: appendMessage
  // ========================================
  const _origAppendMessage = window.appendMessage;

  window.appendMessage = function (role, text, options) {
    options = options || {};
    const output = document.getElementById("chat-output");
    if (!output) return _origAppendMessage ? _origAppendMessage(role, text, options) : null;

    // Remove empty state
    const empty = output.querySelector(".chat-output-empty");
    if (empty) empty.remove();

    // Wrapper
    const wrapper = document.createElement("div");
    wrapper.className = "chat-msg " + (role === "user" ? "chat-msg--user" : "chat-msg--ai");

    // Bubble
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble " + (role === "user" ? "chat-bubble-user" : "chat-bubble-ai");

    if (options.thinking) {
      bubble.classList.add("chat-bubble-thinking");
      bubble.innerHTML = '<span class="chat-thinking-dots"><span></span><span></span><span></span></span>';
    } else if (role === "user") {
      bubble.textContent = text;
    } else {
      bubble.innerHTML = mdToHTML(text);
    }

    if (role === "user" && options.imageDataUrl) {
      const image = document.createElement("img");
      image.className = "chat-bubble-image"; image.alt = "Attached image";
      image.src = options.imageDataUrl; bubble.prepend(image);
    }

    wrapper.appendChild(bubble);

    // Meta row (timestamp + copy) — shown on hover via CSS
    if (!options.thinking) {
      const meta = document.createElement("div");
      meta.className = "chat-meta";

      const ts = document.createElement("span");
      ts.className = "chat-meta-ts";
      ts.textContent = _timeStr();
      meta.appendChild(ts);

      if (role !== "user") {
        const copyBtn = document.createElement("button");
        copyBtn.className = "chat-meta-copy";
        copyBtn.textContent = "Copy";
        copyBtn.title = "Copy message";
        copyBtn.addEventListener("click", () => {
          const raw = bubble.textContent || bubble.innerText || "";
          navigator.clipboard.writeText(raw).then(() => {
            copyBtn.textContent = "Copied!";
            setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
          }).catch(() => {});
        });
        meta.appendChild(copyBtn);
      }

      wrapper.appendChild(meta);
    }

    output.appendChild(wrapper);

    // Smooth scroll to bottom
    requestAnimationFrame(() => {
      output.scrollTo({ top: output.scrollHeight, behavior: "smooth" });
    });

    return bubble;
  };


  // ========================================
  //  Streaming cursor: add/remove during streaming
  // ========================================

  // Patch the streaming handler to add cursor during token delivery
  const _origTliBundledChatStream = window.tliBundledChatStream;

  if (typeof _origTliBundledChatStream === "function") {
    window.tliBundledChatStream = async function (opts) {
      const origOnDelta = opts.onDelta;
      let targetBubble = null;

      // Find the current thinking bubble (the one we'll stream into)
      try {
        const output = document.getElementById("chat-output");
        if (output) {
          const bubbles = output.querySelectorAll(".chat-bubble-thinking, .chat-bubble-ai");
          targetBubble = bubbles[bubbles.length - 1] || null;
        }
      } catch {}

      // Wrap onDelta to append streaming cursor
      opts.onDelta = function (chunk) {
        if (origOnDelta) origOnDelta(chunk);

        // After the original handler updates innerHTML, append cursor
        if (targetBubble) {
          try {
            // Remove any existing cursor first
            const existing = targetBubble.querySelector(".chat-cursor");
            if (existing) existing.remove();

            // Add cursor at end
            const cursor = document.createElement("span");
            cursor.className = "chat-cursor";
            targetBubble.appendChild(cursor);
          } catch {}
        }
      };

      try {
        const result = await _origTliBundledChatStream(opts);

        // Remove cursor when streaming ends
        if (targetBubble) {
          try {
            const cursor = targetBubble.querySelector(".chat-cursor");
            if (cursor) cursor.remove();
          } catch {}
        }

        return result;
      } catch (e) {
        // Remove cursor on error too
        if (targetBubble) {
          try {
            const cursor = targetBubble.querySelector(".chat-cursor");
            if (cursor) cursor.remove();
          } catch {}
        }
        throw e;
      }
    };
  }


  console.log("[TLI] Chat Enhanced loaded — markdown, code blocks, streaming cursor active");
})();
