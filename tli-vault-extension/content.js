// TLI Vault Extension — content script v2
// Inline field icons, focus dropdown, keyboard shortcut (Ctrl+Shift+L), save-login prompt

(function () {
  "use strict";

  const Z = 2147483647;
  const _icons = new Map(); // HTMLInputElement → button element

  let _domainLogins = null;   // null = not fetched, [] or [...] = fetched
  let _fetching = false;
  let _fetchCallbacks = [];
  let _dropdown = null;
  let _saveBanner = null;
  let _pendingSave = null;
  let _toastTimer = null;
  let _debounceTimer = null;

  // ─── Styles ──────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("tli-ext-css")) return;
    const s = document.createElement("style");
    s.id = "tli-ext-css";
    s.textContent = `
      #tli-dropdown {
        position: absolute !important;
        z-index: ${Z} !important;
        background: #0c1322 !important;
        border: 1px solid #1e3a2a !important;
        border-radius: 8px !important;
        box-shadow: 0 6px 20px rgba(0,0,0,.45) !important;
        min-width: 200px !important;
        max-width: 300px !important;
        overflow: hidden !important;
        font-family: system-ui, -apple-system, sans-serif !important;
        font-size: 13px !important;
        color: #e2e8f0 !important;
        animation: tli-dd-in .12s ease !important;
      }
      @keyframes tli-dd-in {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .tli-dd-hdr {
        padding: 7px 12px 5px !important;
        font-size: 9px !important;
        font-weight: 700 !important;
        letter-spacing: 1.2px !important;
        color: #10b981 !important;
        border-bottom: 1px solid #18293a !important;
        text-transform: uppercase !important;
      }
      .tli-dd-item {
        display: flex !important;
        align-items: center !important;
        gap: 9px !important;
        padding: 9px 12px !important;
        cursor: pointer !important;
        border-bottom: 1px solid #0d1f2a !important;
        outline: none !important;
        transition: background .1s !important;
      }
      .tli-dd-item:last-of-type { border-bottom: none !important; }
      .tli-dd-item:hover, .tli-dd-item:focus { background: #1a2f3a !important; }
      .tli-dd-ic {
        width: 26px !important;
        height: 26px !important;
        background: #0e2d1f !important;
        border-radius: 6px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        color: #10b981 !important;
        flex-shrink: 0 !important;
        text-transform: uppercase !important;
      }
      .tli-dd-info { flex: 1 !important; min-width: 0 !important; overflow: hidden !important; }
      .tli-dd-name {
        font-weight: 600 !important;
        font-size: 13px !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        color: #e2e8f0 !important;
      }
      .tli-dd-user {
        font-size: 11px !important;
        color: #64748b !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      .tli-dd-empty {
        padding: 14px 12px !important;
        color: #475569 !important;
        font-size: 12px !important;
        text-align: center !important;
      }
      .tli-dd-hint {
        padding: 5px 12px 6px !important;
        font-size: 10px !important;
        color: #334155 !important;
        border-top: 1px solid #18293a !important;
        text-align: center !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── Toast ───────────────────────────────────────────────────
  function showToast(msg, isError) {
    let t = document.getElementById("tli-toast");
    if (!t) { t = document.createElement("div"); t.id = "tli-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", bottom: "16px", right: "16px",
      zIndex: String(Z),
      background: isError ? "#ef4444" : "#10b981",
      color: "#fff", padding: "8px 14px", borderRadius: "8px",
      fontFamily: "system-ui, sans-serif", fontSize: "13px",
      boxShadow: "0 4px 16px rgba(0,0,0,.35)", maxWidth: "260px",
      lineHeight: "1.4", pointerEvents: "none", display: "block",
    });
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { const el = document.getElementById("tli-toast"); if (el) el.remove(); }, 3000);
  }

  // ─── Form detection ──────────────────────────────────────────
  function findLoginForms() {
    const results = [];
    for (const pwField of document.querySelectorAll('input[type="password"]')) {
      if (!document.body.contains(pwField)) continue;
      const ctx = pwField.closest("form") || document.body;
      let userField = null;
      for (const inp of ctx.querySelectorAll("input")) {
        if (inp === pwField) break;
        const t = (inp.type || "text").toLowerCase();
        if (!inp.hidden && !inp.disabled && inp.offsetParent !== null &&
            (t === "text" || t === "email" || t === "tel")) {
          userField = inp;
        }
      }
      results.push({ usernameField: userField, passwordField: pwField });
    }
    return results;
  }

  // ─── Visibility check ────────────────────────────────────────
  function _isVisible(el) {
    if (!document.body.contains(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 12) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    let node = el;
    while (node && node !== document.body) {
      const s = window.getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
      node = node.parentElement;
    }
    return true;
  }

  // ─── Field icon ──────────────────────────────────────────────
  function injectFieldIcon(field, formInfo) {
    if (_icons.has(field)) return _icons.get(field);

    const icon = document.createElement("button");
    icon.type = "button";
    icon.setAttribute("aria-label", "Autofill from TLI Vault");
    icon.title = "Autofill from TLI Vault (Ctrl+Shift+L)";
    icon.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

    Object.assign(icon.style, {
      position: "absolute",
      zIndex: String(Z),
      width: "20px", height: "20px",
      background: "#10b981",
      border: "none", outline: "none",
      borderRadius: "4px",
      cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#fff", padding: "0",
      boxShadow: "0 1px 4px rgba(0,0,0,.25)",
      opacity: "0.55",
      transition: "opacity .15s, background .15s",
      pointerEvents: "all",
    });

    document.body.appendChild(icon);
    _icons.set(field, icon);
    updateIconPos(icon, field);

    const reflow = () => updateIconPos(icon, field);
    window.addEventListener("resize", reflow, { passive: true });
    window.addEventListener("scroll", reflow, { passive: true, capture: true });

    icon.addEventListener("mouseenter", () => { icon.style.opacity = "1"; icon.style.background = "#059669"; });
    icon.addEventListener("mouseleave", () => { icon.style.opacity = "0.55"; icon.style.background = "#10b981"; });
    field.addEventListener("focus", () => { icon.style.opacity = "0.85"; });
    field.addEventListener("blur", () => { icon.style.opacity = "0.55"; });
    icon.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (_dropdown) { closeDropdown(); return; }
      getDomainLogins((logins) => openDropdown(formInfo, field, logins));
    });

    return icon;
  }

  function updateIconPos(icon, field) {
    if (!_isVisible(field)) { icon.style.display = "none"; return; }
    const rect = field.getBoundingClientRect();
    icon.style.display = "flex";
    icon.style.top = (rect.top + window.scrollY + Math.max(0, (rect.height - 20) / 2)) + "px";
    icon.style.left = (rect.right + window.scrollX - 24) + "px";
  }

  // ─── Login fetching ──────────────────────────────────────────
  function getDomainLogins(cb) {
    if (_domainLogins !== null) { cb(_domainLogins); return; }
    _fetchCallbacks.push(cb);
    if (_fetching) return;
    _fetching = true;
    chrome.runtime.sendMessage({ type: "TLI_FETCH_LOGINS", domain: window.location.hostname }, (resp) => {
      _fetching = false;
      _domainLogins = (resp && !resp.error) ? (resp.logins || []) : [];
      _fetchCallbacks.splice(0).forEach(fn => fn(_domainLogins));
    });
  }

  // ─── Dropdown ────────────────────────────────────────────────
  function openDropdown(formInfo, anchorField, logins) {
    closeDropdown();

    const fieldRect = anchorField.getBoundingClientRect();
    const dd = document.createElement("div");
    dd.id = "tli-dropdown";
    dd.style.top = (fieldRect.bottom + window.scrollY + 4) + "px";
    dd.style.left = (fieldRect.left + window.scrollX) + "px";

    const hdr = document.createElement("div");
    hdr.className = "tli-dd-hdr";
    hdr.textContent = "TLI Vault";
    dd.appendChild(hdr);

    if (!logins.length) {
      const empty = document.createElement("div");
      empty.className = "tli-dd-empty";
      empty.textContent = "No saved logins for " + window.location.hostname;
      dd.appendChild(empty);
    } else {
      logins.forEach((login, i) => {
        const item = document.createElement("div");
        item.className = "tli-dd-item";
        item.tabIndex = 0;
        item.innerHTML = `
          <div class="tli-dd-ic">${esc((login.name || "?")[0].toUpperCase())}</div>
          <div class="tli-dd-info">
            <div class="tli-dd-name">${esc(login.name)}</div>
            <div class="tli-dd-user">${esc(login.username)}</div>
          </div>
        `;
        const doFill = () => {
          fillForm(formInfo, login);
          closeDropdown();
          showToast("Filled: " + login.name, false);
        };
        item.addEventListener("click", doFill);
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doFill(); }
          if (e.key === "Escape") closeDropdown();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            const items = dd.querySelectorAll(".tli-dd-item");
            (items[i + 1] || items[0]).focus();
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            const items = dd.querySelectorAll(".tli-dd-item");
            (items[i - 1] || items[items.length - 1]).focus();
          }
        });
        dd.appendChild(item);
      });
    }

    const hint = document.createElement("div");
    hint.className = "tli-dd-hint";
    hint.textContent = "Ctrl+Shift+L to autofill";
    dd.appendChild(hint);

    document.body.appendChild(dd);
    _dropdown = dd;

    // Flip above if off-screen at bottom
    requestAnimationFrame(() => {
      if (!_dropdown) return;
      const ddRect = dd.getBoundingClientRect();
      if (ddRect.bottom > window.innerHeight - 8 && fieldRect.top > ddRect.height + 8) {
        dd.style.top = (fieldRect.top + window.scrollY - ddRect.height - 4) + "px";
      }
    });

    const first = dd.querySelector(".tli-dd-item");
    if (first) requestAnimationFrame(() => first && first.focus());

    setTimeout(() => document.addEventListener("click", _clickOutside, true), 0);
  }

  function _clickOutside(e) {
    if (_dropdown &&
        !_dropdown.contains(e.target) &&
        !Array.from(_icons.values()).some(ic => ic === e.target || ic.contains(e.target))) {
      closeDropdown();
    }
  }

  function closeDropdown() {
    if (_dropdown) { _dropdown.remove(); _dropdown = null; }
    document.removeEventListener("click", _clickOutside, true);
  }

  // ─── Fill ─────────────────────────────────────────────────────
  function fillForm(formInfo, login) {
    function setVal(el, val) {
      try {
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
      } catch (_) { el.value = val; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (formInfo.usernameField) setVal(formInfo.usernameField, login.username);
    setVal(formInfo.passwordField, login.password);
  }

  // ─── Save login prompt ────────────────────────────────────────
  function showSaveBanner(data) {
    closeSaveBanner();
    const b = document.createElement("div");
    b.id = "tli-save-banner";
    Object.assign(b.style, {
      position: "fixed", bottom: "20px", left: "50%",
      transform: "translateX(-50%)",
      zIndex: String(Z),
      background: "#0c1322",
      border: "1px solid #10b981",
      borderRadius: "12px",
      boxShadow: "0 8px 28px rgba(0,0,0,.55)",
      padding: "13px 15px",
      minWidth: "270px", maxWidth: "370px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      display: "flex", flexDirection: "column", gap: "9px",
    });

    const top = document.createElement("div");
    Object.assign(top.style, { display: "flex", alignItems: "center", gap: "7px", fontSize: "13px", fontWeight: "600", color: "#e2e8f0" });
    const badge = document.createElement("span");
    Object.assign(badge.style, { background: "#10b981", color: "#fff", fontSize: "9px", fontWeight: "800", letterSpacing: "1px", padding: "2px 5px", borderRadius: "3px", textTransform: "uppercase" });
    badge.textContent = "TLI";
    top.appendChild(badge);
    top.appendChild(document.createTextNode(" Save this login?"));

    const meta = document.createElement("div");
    Object.assign(meta.style, { fontSize: "12px", color: "#64748b" });
    meta.textContent = (data.username || "(no username)") + " · " + data.domain;

    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", gap: "8px" });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save to Vault";
    Object.assign(saveBtn.style, { flex: "1", padding: "7px", background: "#10b981", color: "#fff", border: "none", borderRadius: "7px", fontSize: "13px", fontWeight: "600", cursor: "pointer" });
    saveBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "TLI_SAVE_LOGIN", data }, (resp) => {
        closeSaveBanner();
        if (resp && resp.ok) {
          showToast("Login saved to TLI Vault", false);
          _domainLogins = null; // invalidate cache
        } else {
          showToast((resp && resp.error) || "Could not save login", true);
        }
      });
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Not now";
    Object.assign(dismissBtn.style, { padding: "7px 12px", background: "transparent", color: "#64748b", border: "1px solid #1e293b", borderRadius: "7px", fontSize: "13px", cursor: "pointer" });
    dismissBtn.addEventListener("click", closeSaveBanner);

    actions.appendChild(saveBtn);
    actions.appendChild(dismissBtn);
    b.appendChild(top);
    b.appendChild(meta);
    b.appendChild(actions);
    document.body.appendChild(b);
    _saveBanner = b;
    _pendingSave = null;

    setTimeout(closeSaveBanner, 12000);
  }

  function closeSaveBanner() {
    if (_saveBanner) { _saveBanner.remove(); _saveBanner = null; }
  }

  // ─── Save detection helpers ───────────────────────────────────
  function _collectFormData() {
    // Collect filled password + nearest username from any visible password field
    for (const pwField of document.querySelectorAll('input[type="password"]')) {
      if (!pwField.value) continue;
      const ctx = pwField.closest("form") || document.body;
      let userField = null;
      for (const inp of ctx.querySelectorAll("input")) {
        if (inp === pwField) break;
        const t = (inp.type || "text").toLowerCase();
        if (!inp.hidden && !inp.disabled && (t === "text" || t === "email" || t === "tel")) {
          userField = inp;
        }
      }
      const username = userField ? userField.value.trim() : "";
      const password = pwField.value;
      if (!password) continue;
      return { username, password };
    }
    return null;
  }

  function _maybeSave(data) {
    if (!data || !data.password) return;
    const domain = window.location.hostname;
    // Skip if already saved
    if ((_domainLogins || []).some(l => l.username === data.username)) return;
    _pendingSave = { name: document.title || domain, domain, username: data.username, password: data.password };
    setTimeout(() => { if (_pendingSave) showSaveBanner(_pendingSave); }, 800);
  }

  // ─── Form submit watcher ──────────────────────────────────────
  // Catches: (1) real form submits, (2) submit-button clicks in SPAs,
  // (3) Enter key on password field, (4) history.pushState navigation
  function watchFormSubmits() {
    // (1) Real form submit
    document.addEventListener("submit", (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      _maybeSave(_collectFormData());
    }, true);

    // (2) Click on submit-like buttons (SPAs like Google, Microsoft, etc.)
    const _SUBMIT_WORDS = /sign.?in|log.?in|next|continue|submit|enter|verify/i;
    document.addEventListener("click", (e) => {
      const btn = e.target.closest('button, [role="button"], input[type="submit"]');
      if (!btn) return;
      const text = (btn.textContent || btn.value || btn.getAttribute("aria-label") || "").trim();
      const isSubmitType = btn.type === "submit" || _SUBMIT_WORDS.test(text);
      if (!isSubmitType) return;
      const data = _collectFormData();
      if (data) _maybeSave(data);
    }, true);

    // (3) Enter key on password field
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (!(e.target instanceof HTMLInputElement)) return;
      if (e.target.type !== "password") return;
      const data = _collectFormData();
      if (data) _maybeSave(data);
    }, true);

    // (4) SPA navigation via history.pushState / replaceState
    const _origPush = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);
    let _navData = null;
    const _onNav = () => {
      if (_navData) { _maybeSave(_navData); _navData = null; }
    };
    history.pushState = function (...args) {
      _navData = _collectFormData();
      const r = _origPush(...args);
      _onNav();
      return r;
    };
    history.replaceState = function (...args) {
      _navData = _collectFormData();
      const r = _origReplace(...args);
      _onNav();
      return r;
    };
  }

  // ─── Keyboard shortcut (Ctrl+Shift+L) ────────────────────────
  function triggerAutofill() {
    const forms = findLoginForms();
    if (!forms.length) { showToast("No login form found on this page.", true); return; }
    getDomainLogins((logins) => {
      if (!logins.length) { showToast("No TLI Vault logins for " + window.location.hostname, false); return; }
      if (logins.length === 1) {
        fillForm(forms[0], logins[0]);
        showToast("Filled: " + logins[0].name, false);
      } else {
        openDropdown(forms[0], forms[0].passwordField, logins);
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      e.stopImmediatePropagation();
      triggerAutofill();
    }
  }, true);

  // ─── Init ────────────────────────────────────────────────────
  function setupForms() {
    for (const formInfo of findLoginForms()) {
      if (!_isVisible(formInfo.passwordField)) continue;
      injectFieldIcon(formInfo.passwordField, formInfo);
    }
    if (document.querySelector('input[type="password"]')) {
      getDomainLogins(() => {}); // pre-warm cache
    }
  }

  function init() {
    injectStyles();
    setupForms();
    watchFormSubmits();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // SPA navigation: re-scan for new forms
  new MutationObserver(() => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(setupForms, 400);
  }).observe(document.body, { childList: true, subtree: true });

})();
