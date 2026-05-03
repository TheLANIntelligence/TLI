/* =============================================================
   TLI Search — SearXNG integration
   ---------------------------------------------------------------
   Exposes three globals used by the sendChat() gate in app.js:
     window.tliSearchIsEnabled()
     window.tliShouldGateForSearch(text)
     window.tliShowSearchBannerFor(text)

   Settings live in the main tli_settings localStorage key
   (read via readSettings / writeSettings from app.js).
   Search goes through /search/query on the TLI backend — no CORS.
   ============================================================= */
(function () {
  "use strict";

  // ── Storage keys ────────────────────────────────────────────
  const RECEIPTS_KEY = "tli_search_receipts_v1";
  const MAX_RECEIPTS = 200;

  // ── Settings helpers (use main tli_settings blob) ───────────
  function _readSettings() {
    try {
      return (typeof readSettings === "function" ? readSettings() : null) || {};
    } catch { return {}; }
  }

  function _patchSettings(patch) {
    try {
      if (typeof readSettings !== "function" || typeof writeSettings !== "function") return;
      writeSettings(Object.assign({}, readSettings() || {}, patch));
    } catch {}
  }

  function _getSearchSettings() {
    const s = _readSettings();
    return {
      enabled:  !!s.searchEnabled,
      url:      (s.searxUrl || "http://localhost:8080").trim(),
      topK:     Math.max(1, Math.min(10, Number(s.searchTopK) || 5)),
      rules:    s.searchRules || { always: {}, never: {} },
    };
  }

  // ── Receipts ─────────────────────────────────────────────────
  function _loadReceipts() {
    try { return JSON.parse(localStorage.getItem(RECEIPTS_KEY) || "[]") || []; } catch { return []; }
  }

  function _saveReceipts(list) {
    try { localStorage.setItem(RECEIPTS_KEY, JSON.stringify(list || [])); } catch {}
  }

  function _addReceipt(r) {
    const list = _loadReceipts();
    list.unshift(r);
    while (list.length > MAX_RECEIPTS) list.pop();
    _saveReceipts(list);
    _renderReceipts();
  }

  function _renderReceipts() {
    const host = document.getElementById("settings-search-receipts");
    if (!host) return;
    const list = _loadReceipts();
    if (!list.length) {
      host.innerHTML = `<div class="small-meta">No receipts yet.</div>`;
      return;
    }
    host.innerHTML = list.map(r => {
      const dt  = new Date(r.ts || Date.now()).toLocaleString();
      const q   = String(r.query || "").replace(/</g, "&lt;");
      const ep  = String(r.endpoint || "").replace(/</g, "&lt;");
      const k   = r.k || "";
      const ms  = typeof r.ms === "number" ? `${r.ms}ms` : "";
      const items = (r.results || []).map(x =>
        `<li><a href="${String(x.url).replace(/"/g,"&quot;")}" target="_blank" rel="noreferrer">${String(x.title || x.url).replace(/</g,"&lt;")}</a></li>`
      ).join("");
      return `<details class="receipt-item">
        <summary><b>${dt}</b> — ${q} <span class="small-meta">(K=${k} ${ms} ${ep})</span></summary>
        ${items ? `<ul>${items}</ul>` : ""}
      </details>`;
    }).join("");
  }

  // ── Heuristics ────────────────────────────────────────────────
  const RE_STRONG = [
    /\b(latest|today|current|new|release|updated|yesterday|this\s+(week|month|year)|202\d)\b/i,
    /\b(driver|firmware|release\s*notes|version|build|patch)\b/i,
    /\b(price|cost|where\s+to\s+buy|in\s+stock|deal|availability)\b/i,
    /\b(news|headline|what\s+happened)\b/i,
    /\b(error\s*code|0x[0-9a-f]{3,}|bsod|event\s*id)\b/i,
  ];
  const RE_EXCLUDE = [
    /\b(write|draft|poem|lyrics|story|fiction|screenplay)\b/i,
    /\b(journal|diary|feelings|therapy)\b/i,
  ];

  function _inferCategory(text) {
    const t = String(text || "");
    if (/\b(driver|firmware|release\s*notes|version|build|patch)\b/i.test(t))       return "drivers";
    if (/\b(error\s*code|0x[0-9a-f]{3,}|bsod|event\s*id)\b/i.test(t))              return "troubleshooting";
    if (/\b(news|headline|what\s+happened|today|yesterday|this\s+(week|month))\b/i.test(t)) return "news";
    if (/\b(price|cost|where\s+to\s+buy|in\s+stock|deal|availability)\b/i.test(t)) return "prices";
    return "general";
  }

  // ── Window globals used by sendChat() in app.js ───────────────
  window.tliSearchIsEnabled = function () {
    return _getSearchSettings().enabled;
  };

  window.tliShouldGateForSearch = function (text) {
    const s = _getSearchSettings();
    const cat = _inferCategory(text);
    if (s.rules.never?.[cat])  return false;
    if (s.rules.always?.[cat]) return true;
    for (const rx of RE_EXCLUDE) if (rx.test(text)) return false;
    return RE_STRONG.some(rx => rx.test(text));
  };

  window.tliShowSearchBannerFor = function (text) {
    _pendingPrompt   = String(text || "").trim();
    _pendingCategory = _inferCategory(_pendingPrompt);
    const sub = document.getElementById("search-suggest-sub");
    if (sub) sub.textContent = `Category detected: ${_pendingCategory}. Online retrieval only — thinking stays local.`;
    _updateMenuTitle(_pendingCategory);
    _showBanner();
  };

  // ── Banner state ──────────────────────────────────────────────
  let _pendingPrompt   = null;
  let _pendingCategory = null;

  function _showBanner() {
    const b = document.getElementById("search-suggest-banner");
    if (b) { b.classList.remove("hidden"); b.removeAttribute("hidden"); }
  }

  function _hideBanner() {
    const b = document.getElementById("search-suggest-banner");
    if (b) b.classList.add("hidden");
    _closeMenu();
  }

  function _openMenu() {
    const pop = document.getElementById("search-suggest-menu-pop");
    if (pop) pop.classList.remove("hidden");
  }

  function _closeMenu() {
    const pop = document.getElementById("search-suggest-menu-pop");
    if (pop) pop.classList.add("hidden");
  }

  function _updateMenuTitle(cat) {
    const el = document.getElementById("search-suggest-menu-title");
    if (el) el.textContent = `Rules for "${cat}"`;
  }

  // ── Search via backend proxy ──────────────────────────────────
  async function _doSearch(query) {
    const s = _getSearchSettings();
    const url = new URL("/search/query", location.origin);
    url.searchParams.set("q", query);
    url.searchParams.set("k", String(s.topK));
    url.searchParams.set("endpoint", s.url);

    const t0 = performance.now();
    const resp = await fetch(url.toString());
    const ms = Math.round(performance.now() - t0);
    if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);
    const data = await resp.json();
    return { results: data.results || [], ms: data.ms ?? ms, endpoint: data.endpoint || s.url };
  }

  // ── Build augmented prompt ────────────────────────────────────
  function _buildAugment(original, searchData) {
    const lines = [original, "", "----", "Web search results (SearXNG):"];
    (searchData.results || []).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
    });
    lines.push("----");
    lines.push("Answer using the search results above as your external facts. Cite sources at the end.");
    return lines.join("\n");
  }

  // ── Banner button wiring ──────────────────────────────────────
  function _wireBanner() {
    const runBtn     = document.getElementById("search-suggest-run");
    const offBtn     = document.getElementById("search-suggest-offline");
    const dismissBtn = document.getElementById("search-suggest-dismiss");
    const menuBtn    = document.getElementById("search-suggest-menu-btn");
    const alwaysBtn  = document.getElementById("search-rule-always");
    const neverBtn   = document.getElementById("search-rule-never");

    if (runBtn && !runBtn.__tliBound) {
      runBtn.__tliBound = true;
      runBtn.addEventListener("click", async () => {
        const prompt = _pendingPrompt || (document.getElementById("chat-input")?.value || "").trim();
        _hideBanner();
        if (!prompt) return;

        // Disable button briefly to avoid double-click
        runBtn.disabled = true;
        try {
          const data = await _doSearch(prompt);
          _addReceipt({
            ts:       new Date().toISOString(),
            query:    prompt,
            endpoint: data.endpoint,
            k:        _getSearchSettings().topK,
            ms:       data.ms,
            results:  (data.results || []).map(r => ({ title: r.title, url: r.url })),
          });

          window.__tliInjectedUserMessage = _buildAugment(prompt, data);
          window.__tliSearchGateBypassOnce = true;
          document.getElementById("chat-send-btn")?.click();
        } catch {
          // Search failed — fall through to offline
          window.__tliSearchGateBypassOnce = true;
          document.getElementById("chat-send-btn")?.click();
        } finally {
          _pendingPrompt = null;
          runBtn.disabled = false;
        }
      });
    }

    if (offBtn && !offBtn.__tliBound) {
      offBtn.__tliBound = true;
      offBtn.addEventListener("click", () => {
        _hideBanner();
        window.__tliSearchGateBypassOnce = true;
        document.getElementById("chat-send-btn")?.click();
        _pendingPrompt = null;
      });
    }

    if (dismissBtn && !dismissBtn.__tliBound) {
      dismissBtn.__tliBound = true;
      dismissBtn.addEventListener("click", () => {
        _hideBanner();
        _pendingPrompt = null;
      });
    }

    if (menuBtn && !menuBtn.__tliBound) {
      menuBtn.__tliBound = true;
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pop = document.getElementById("search-suggest-menu-pop");
        if (pop) pop.classList.toggle("hidden");
      });
      document.addEventListener("click", () => _closeMenu());
    }

    function _setRule(which) {
      const cat = _pendingCategory || "general";
      const s   = _getSearchSettings();
      const rules = {
        always: { ...(s.rules.always || {}) },
        never:  { ...(s.rules.never  || {}) },
      };
      if (which === "always") { rules.always[cat] = true;  delete rules.never[cat]; }
      if (which === "never")  { rules.never[cat]  = true;  delete rules.always[cat]; }
      _patchSettings({ searchRules: rules });
      _closeMenu();
    }

    if (alwaysBtn && !alwaysBtn.__tliBound) {
      alwaysBtn.__tliBound = true;
      alwaysBtn.addEventListener("click", () => _setRule("always"));
    }

    if (neverBtn && !neverBtn.__tliBound) {
      neverBtn.__tliBound = true;
      neverBtn.addEventListener("click", () => _setRule("never"));
    }
  }

  // ── Settings panel wiring ─────────────────────────────────────
  function _syncSettingsUI() {
    const s = _getSearchSettings();

    const enableBtn = document.getElementById("settings-search-enable");
    const urlInput  = document.getElementById("settings-searx-url");
    const topkSel   = document.getElementById("settings-search-topk");

    if (enableBtn) enableBtn.classList.toggle("on", s.enabled);
    if (urlInput && !urlInput._tliDirty) urlInput.value = s.url;
    if (topkSel)  topkSel.value = String(s.topK);

    _renderReceipts();
  }

  function _wireSettings() {
    const enableBtn = document.getElementById("settings-search-enable");
    const urlInput  = document.getElementById("settings-searx-url");
    const topkSel   = document.getElementById("settings-search-topk");
    const exportBtn = document.getElementById("settings-search-export");
    const clearBtn  = document.getElementById("settings-search-clear");

    if (enableBtn && !enableBtn.__tliBound) {
      enableBtn.__tliBound = true;
      enableBtn.addEventListener("click", () => {
        const s = _getSearchSettings();
        _patchSettings({ searchEnabled: !s.enabled });
        _syncSettingsUI();
      });
    }

    if (urlInput && !urlInput.__tliBound) {
      urlInput.__tliBound = true;
      urlInput.addEventListener("focus",  () => { urlInput._tliDirty = true; });
      urlInput.addEventListener("change", () => {
        _patchSettings({ searxUrl: urlInput.value.trim() });
        urlInput._tliDirty = false;
      });
    }

    if (topkSel && !topkSel.__tliBound) {
      topkSel.__tliBound = true;
      topkSel.addEventListener("change", () => {
        _patchSettings({ searchTopK: Number(topkSel.value) });
      });
    }

    if (exportBtn && !exportBtn.__tliBound) {
      exportBtn.__tliBound = true;
      exportBtn.addEventListener("click", () => {
        const data = _loadReceipts();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `tli_search_receipts_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
    }

    if (clearBtn && !clearBtn.__tliBound) {
      clearBtn.__tliBound = true;
      clearBtn.addEventListener("click", () => {
        _saveReceipts([]);
        _renderReceipts();
      });
    }

    // Re-sync settings UI when user navigates to the Settings panel
    document.querySelectorAll("[data-panel-target='panel-settings'], [onclick*='panel-settings']").forEach(el => {
      if (!el.__tliSearchSyncBound) {
        el.__tliSearchSyncBound = true;
        el.addEventListener("click", () => setTimeout(_syncSettingsUI, 50));
      }
    });

    _syncSettingsUI();
  }

  // ── Init ─────────────────────────────────────────────────────
  function _init() {
    _wireBanner();
    _wireSettings();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
})();
