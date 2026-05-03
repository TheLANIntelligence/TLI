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
    let src = String(raw || "");

    // Fix smart quotes and dashes — both clean Unicode and Win-1252 mojibake.
    //
    // Mojibake happens when UTF-8 bytes are misread as Windows-1252:
    //   each 3-byte UTF-8 sequence [0xE2, 0x80, 0xNN] becomes
    //   [U+00E2 â, U+20AC €, Win1252(0xNN)].
    //
    // En/em dash mojibake 3rd-char happens to be a smart-quote codepoint
    // (0x93→U+201C, 0x94→U+201D), so dash patterns must run BEFORE the
    // smart-quote normalisation pass.
    src = src
      // -- mojibake: en dash  (E2 80 93 → â € "  where 0x93 Win-1252 = U+201C) --
      .replace(/\u00e2\u20ac\u201c/g, "\u2013")
      // -- mojibake: em dash  (E2 80 94 → â € "  where 0x94 Win-1252 = U+201D) --
      .replace(/\u00e2\u20ac\u201d/g, "\u2014")
      // -- mojibake: right single quote  (E2 80 99 → â € ™  where 0x99 Win-1252 = U+2122) --
      .replace(/\u00e2\u20ac\u2122/g, "'")
      // -- mojibake: left single quote   (E2 80 98 → â € ˜  where 0x98 Win-1252 = U+02DC) --
      .replace(/\u00e2\u20ac\u02dc/g,  "'")
      // -- mojibake: left double quote   (E2 80 9C → â € œ  where 0x9C Win-1252 = U+0153) --
      .replace(/\u00e2\u20ac\u0153/g,  '"')
      // -- mojibake: right double quote  (E2 80 9D → â € ?  0x9D undefined in Win-1252) --
      .replace(/\u00e2\u20ac[\u009d\ufffd]/g, '"')
      // -- normalise any remaining well-formed Unicode typographic quotes --
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"');
    // En/em dashes (U+2013, U+2014) render fine in HTML — leave as-is.

    src = src.replace(/\r\n/g, "\n");

    // Extract code blocks first (protect them from other transforms)
    const codeBlocks = [];
    src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
      return `\x00CB${idx}\x00`;
    });

    // Escape HTML (but preserve our placeholders)
    src = src
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Inline code (must be before bold/italic)
    src = src.replace(/`([^`\n]+)`/g,
      '<code>$1</code>');

    // Bold + italic
    src = src.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    src = src.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    src = src.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headers (must be at line start)
    src = src.replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>');
    src = src.replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>');
    src = src.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>');
    src = src.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>');
    src = src.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>');
    src = src.replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>');

    // Horizontal rules
    src = src.replace(/^[-*_]{3,}\s*$/gm, '<hr>');

    // Blockquotes
    src = src.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
    // Merge adjacent blockquotes
    src = src.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Unordered lists
    src = src.replace(/^(\s*)[-*•]\s+(.+)$/gm, (_, indent, item) => {
      return `<li>${item}</li>`;
    });
    // Wrap consecutive <li> in <ul>
    src = src.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Ordered lists
    src = src.replace(/^(\s*)\d+[.)]\s+(.+)$/gm, (_, indent, item) => {
      return `<oli>${item}</oli>`;
    });
    src = src.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (match) => {
      return '<ol>' + match.replace(/<\/?oli>/g, (t) => t.replace('oli', 'li')) + '</ol>';
    });

    // Links
    src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>');

    // Paragraphs: convert double newlines to paragraph breaks
    src = src.replace(/\n{2,}/g, '</p><p>');
    // Single newlines to <br>
    src = src.replace(/\n/g, '<br>');

    // Wrap in paragraph
    src = '<p>' + src + '</p>';
    // Clean up empty paragraphs
    src = src.replace(/<p>\s*<\/p>/g, '');
    // Don't wrap block elements in <p>
    src = src.replace(/<p>(<h[1-6]>)/g, '$1');
    src = src.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
    src = src.replace(/<p>(<ul>)/g, '$1');
    src = src.replace(/(<\/ul>)<\/p>/g, '$1');
    src = src.replace(/<p>(<ol>)/g, '$1');
    src = src.replace(/(<\/ol>)<\/p>/g, '$1');
    src = src.replace(/<p>(<blockquote>)/g, '$1');
    src = src.replace(/(<\/blockquote>)<\/p>/g, '$1');
    src = src.replace(/<p>(<hr>)<\/p>/g, '$1');
    src = src.replace(/<p>(<hr>)/g, '$1');

    // Restore code blocks with styled wrappers
    src = src.replace(/\x00CB(\d+)\x00/g, (_, idx) => {
      const block = codeBlocks[parseInt(idx)];
      if (!block) return '';
      const escaped = block.code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const langLabel = block.lang ? block.lang.toUpperCase() : "CODE";
      return `<div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-block-lang">${langLabel}</span>
          <button class="code-block-copy" onclick="tliCopyCode(this)" title="Copy code">Copy</button>
        </div>
        <code class="code-block-code">${escaped}</code>
      </div>`;
    });

    return src;
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
