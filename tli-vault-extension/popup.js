// TLI Vault Extension — popup script v2

const loginList = document.getElementById("login-list");
const statusBar = document.getElementById("status-bar");
const autofillBtn = document.getElementById("autofill-btn");
const settingsLink = document.getElementById("settings-link");
const searchInput = document.getElementById("search-input");

let _allLogins = [];

// ─── Settings link ────────────────────────────────────────────
settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ─── Status bar ───────────────────────────────────────────────
function showStatus(msg, type) {
  statusBar.textContent = msg;
  statusBar.className = `status-bar visible ${type || ""}`;
}

function clearStatus() {
  statusBar.className = "status-bar";
}

// ─── Helpers ──────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1400);
  }).catch(() => {
    // Fallback for older contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1400);
  });
}

function peekPassword(password, item) {
  const existing = item.querySelector(".peek-overlay");
  if (existing) { existing.remove(); return; }
  const el = document.createElement("div");
  el.className = "peek-overlay";
  el.textContent = password || "(empty)";
  item.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── SVG icons ───────────────────────────────────────────────
const SVG_COPY = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const SVG_LOCK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const SVG_EYE  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

// ─── Render logins ────────────────────────────────────────────
function renderLogins(logins) {
  loginList.innerHTML = "";
  if (!logins.length) {
    loginList.innerHTML = `<div class="empty-state">No logins found.</div>`;
    return;
  }

  logins.forEach((login) => {
    const item = document.createElement("div");
    item.className = "login-item";
    const initial = (login.name || "?")[0].toUpperCase();

    // Static HTML (safe — no raw user data in innerHTML)
    const iconEl = document.createElement("div");
    iconEl.className = "login-icon";
    iconEl.textContent = initial;

    const infoEl = document.createElement("div");
    infoEl.className = "login-info";
    const nameEl = document.createElement("div");
    nameEl.className = "login-name";
    nameEl.textContent = login.name;
    const subEl = document.createElement("div");
    subEl.className = "login-sub";
    subEl.textContent = login.username + " — " + login.domain;
    infoEl.appendChild(nameEl);
    infoEl.appendChild(subEl);

    // Action buttons
    const actionsEl = document.createElement("div");
    actionsEl.className = "login-actions";

    const copyUserBtn = document.createElement("button");
    copyUserBtn.className = "login-act-btn";
    copyUserBtn.title = "Copy username";
    copyUserBtn.innerHTML = SVG_COPY;
    copyUserBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(login.username, copyUserBtn);
    });

    const copyPwBtn = document.createElement("button");
    copyPwBtn.className = "login-act-btn";
    copyPwBtn.title = "Copy password";
    copyPwBtn.innerHTML = SVG_LOCK;
    copyPwBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(login.password || "", copyPwBtn);
    });

    const peekBtn = document.createElement("button");
    peekBtn.className = "login-act-btn";
    peekBtn.title = "Peek password";
    peekBtn.innerHTML = SVG_EYE;
    peekBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      peekPassword(login.password || "", item);
    });

    actionsEl.appendChild(copyUserBtn);
    actionsEl.appendChild(copyPwBtn);
    actionsEl.appendChild(peekBtn);

    item.appendChild(iconEl);
    item.appendChild(infoEl);
    item.appendChild(actionsEl);

    // Clicking the item body (not action buttons) triggers autofill
    item.addEventListener("click", (e) => {
      if (e.target.closest(".login-actions")) return;
      injectLogin(login);
    });

    loginList.appendChild(item);
  });
}

// ─── Search ───────────────────────────────────────────────────
function filterLogins(query) {
  if (!query.trim()) { renderLogins(_allLogins); return; }
  const q = query.toLowerCase();
  const filtered = _allLogins.filter(l =>
    (l.name || "").toLowerCase().includes(q) ||
    (l.username || "").toLowerCase().includes(q) ||
    (l.domain || "").toLowerCase().includes(q)
  );
  if (!filtered.length) {
    loginList.innerHTML = `<div class="empty-state">No matches for "${escHtml(query)}"</div>`;
  } else {
    renderLogins(filtered);
  }
}

searchInput.addEventListener("input", () => filterLogins(searchInput.value));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const first = loginList.querySelector(".login-item");
    if (first) first.focus();
  }
  if (e.key === "Escape") { searchInput.value = ""; filterLogins(""); }
});

// ─── Inject login into active tab ────────────────────────────
function injectLogin(login) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (username, password) => {
        function setVal(el, val) {
          const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
          if (nativeInput) nativeInput.set.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const pwField = document.querySelector('input[type="password"]');
        if (!pwField) return;
        const form = pwField.closest("form") || pwField.parentElement;
        const allInputs = form ? form.querySelectorAll("input") : document.querySelectorAll("input");
        let userField = null;
        for (const inp of allInputs) {
          const t = (inp.type || "").toLowerCase();
          if (t === "text" || t === "email" || t === "tel") { userField = inp; break; }
        }
        if (userField) setVal(userField, username);
        setVal(pwField, password);
      },
      args: [login.username, login.password],
    });
    showStatus("Filled: " + login.name, "ok");
    setTimeout(() => window.close(), 800);
  });
}

// ─── Load all logins on popup open ───────────────────────────
chrome.runtime.sendMessage({ type: "TLI_FETCH_ALL_LOGINS" }, (resp) => {
  if (chrome.runtime.lastError || !resp) {
    showStatus("Extension error — try reloading the browser.", "error");
    loginList.innerHTML = `<div class="empty-state">Could not connect to extension background.</div>`;
    return;
  }
  if (resp.error) {
    showStatus(resp.error, "error");
    loginList.innerHTML = `<div class="empty-state">${escHtml(resp.error)}</div>`;
    return;
  }
  clearStatus();
  _allLogins = resp.logins || [];
  if (!_allLogins.length) {
    loginList.innerHTML = `<div class="empty-state">No saved logins yet.<br>Add them in TLI Vault.</div>`;
    return;
  }
  renderLogins(_allLogins);
  // Auto-focus search when there are enough logins to benefit from filtering
  if (_allLogins.length > 4) searchInput.focus();
});

// ─── Autofill button (filter by current tab domain) ──────────
autofillBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    let domain = "";
    try { domain = new URL(tabs[0].url).hostname; } catch (_) {}
    chrome.runtime.sendMessage({ type: "TLI_FETCH_LOGINS", domain }, (resp) => {
      if (resp?.error) { showStatus(resp.error, "error"); return; }
      const logins = resp?.logins || [];
      if (!logins.length) { showStatus("No saved logins for " + domain, ""); return; }
      if (logins.length === 1) {
        injectLogin(logins[0]);
      } else {
        showStatus(logins.length + " matches for " + domain + " — click one to fill", "ok");
        renderLogins(logins);
      }
    });
  });
});
