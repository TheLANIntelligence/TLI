(function () {
  "use strict";

  // ── Guard ─────────────────────────────────────────────────────
  const SAT_ID     = localStorage.getItem("sat_node_id");
  const SAT_SECRET = localStorage.getItem("sat_secret");
  const SAT_NAME   = localStorage.getItem("sat_name") || "Phone";
  if (!SAT_ID || !SAT_SECRET) {
    // Keep join tokens while avoiding a mobile root → Companion redirect loop.
    const query = new URLSearchParams(window.location.search);
    query.set("desktop", "1");
    window.location.replace("/?" + query.toString());
    return;
  }

  // ── DOM refs ──────────────────────────────────────────────────
  const dot        = document.getElementById("comp-dot");
  const hdrBat     = document.getElementById("hdr-bat");
  const panelLabel = document.getElementById("panel-label");
  const chatOut    = document.getElementById("chat-output");
  const chatInput  = document.getElementById("chat-input");
  const chatSend   = document.getElementById("chat-send");
  const devList    = document.getElementById("devices-list");
  const leaveBtn   = document.getElementById("leave-btn");
  const toastEl    = document.getElementById("toast");

  // ── Toast ─────────────────────────────────────────────────────
  let _toastTimer;
  function toast(msg, ms = 2000, kind = 'info') {
    toastEl.textContent = msg;
    toastEl.dataset.kind = kind;
    toastEl.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  // ── Panel order for swipe ─────────────────────────────────────
  const PANELS = ["panel-chat", "panel-devices", "panel-scenes", "panel-vault", "panel-status"];
  let _activeIdx = 0;
  let _activePanel = PANELS[0];

  function _switchTab(targetId, direction) {
    if (targetId === _activePanel) return;
    const newIdx = PANELS.indexOf(targetId);
    const goingRight = direction === "right" || (direction === undefined && newIdx > _activeIdx);

    const prev = document.getElementById(_activePanel);
    const next = document.getElementById(targetId);
    if (!prev || !next) return;

    // Outgoing slide
    prev.classList.remove("active");
    prev.classList.add(goingRight ? "slide-left" : "");
    prev.style.transform = goingRight ? "translateX(-30px)" : "translateX(30px)";
    prev.style.opacity = "0";
    prev.style.pointerEvents = "none";
    setTimeout(() => {
      prev.classList.remove("slide-left");
      prev.style.transform = "";
      prev.style.opacity = "";
      prev.style.pointerEvents = "";
    }, 240);

    // Incoming: start offset
    next.style.transform = goingRight ? "translateX(30px)" : "translateX(-30px)";
    next.style.opacity = "0";
    next.style.pointerEvents = "none";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        next.classList.add("active");
        next.style.transform = "";
        next.style.opacity = "";
        next.style.pointerEvents = "";
      });
    });

    _activePanel = targetId;
    _activeIdx = newIdx;

    // Update tab bar
    document.querySelectorAll(".comp-tab").forEach(b => b.classList.remove("active"));
    const activeBtn = document.querySelector(`[data-panel="${targetId}"]`);
    if (activeBtn) {
      activeBtn.classList.add("active");
      panelLabel.textContent = activeBtn.dataset.label || "";
    }

    // Panel-specific loads
    if (targetId === "panel-devices") _loadDevices();
    if (targetId === "panel-scenes")  _loadScenes();
    if (targetId === "panel-vault")   _loadVault();
    if (targetId === "panel-status")  _loadStatus();
    try { navigator.vibrate?.(8); } catch(_) {}
  }

  document.querySelectorAll(".comp-tab").forEach(btn => {
    btn.addEventListener("click", () => _switchTab(btn.dataset.panel));
  });

  // ── Swipe gesture ─────────────────────────────────────────────
  let _swX = null, _swY = null, _swLocked = false;
  const panelsEl = document.getElementById("panels");

  panelsEl.addEventListener("touchstart", e => {
    _swX = e.touches[0].clientX;
    _swY = e.touches[0].clientY;
    _swLocked = false;
  }, { passive: true });

  panelsEl.addEventListener("touchmove", e => {
    if (_swX === null) return;
    const dx = e.touches[0].clientX - _swX;
    const dy = e.touches[0].clientY - _swY;
    if (!_swLocked && Math.abs(dy) > Math.abs(dx)) { _swX = null; return; } // vertical scroll
    _swLocked = true;
  }, { passive: true });

  panelsEl.addEventListener("touchend", e => {
    if (_swX === null) return;
    const dx = e.changedTouches[0].clientX - _swX;
    _swX = null; _swLocked = false;
    if (Math.abs(dx) < 55) return;
    if (dx < 0 && _activeIdx < PANELS.length - 1) {
      _switchTab(PANELS[_activeIdx + 1], "right");
    } else if (dx > 0 && _activeIdx > 0) {
      _switchTab(PANELS[_activeIdx - 1], "left");
    }
  }, { passive: true });

  // ── Keyboard viewport (iOS/Android) ──────────────────────────
  // Shrink shell when software keyboard opens so compose stays visible
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      const vvH = window.visualViewport.height;
      document.getElementById("shell").style.height = vvH + "px";
    });
  }

  // ── Battery tracking ──────────────────────────────────────────
  let _bat = null;

  async function _initBattery() {
    try {
      if (!navigator.getBattery) return;
      const b = await navigator.getBattery();
      const _upd = () => {
        _bat = { level: Math.round(b.level * 100), charging: b.charging };
        hdrBat.textContent = `${_bat.level}%${_bat.charging ? "⚡" : ""}`;
      };
      _upd();
      b.addEventListener("levelchange",   _upd);
      b.addEventListener("chargingchange", _upd);
    } catch (_) {}
  }
  _initBattery();

  // ── Heartbeat ─────────────────────────────────────────────────
  async function _beat() {
    const payload = {
      node_id:  SAT_ID,
      secret:   SAT_SECRET,
      platform: /iphone|ipad|ipod/i.test(navigator.userAgent) ? "ios"
               : /android/i.test(navigator.userAgent) ? "android" : "unknown",
    };
    if (_bat) { payload.battery_level = _bat.level; payload.battery_charging = _bat.charging; }
    try {
      const conn = navigator.connection || navigator.mozConnection;
      if (conn) payload.connection_type = conn.type || conn.effectiveType;
    } catch (_) {}
    try {
      const r = await fetch("/mesh/satellite/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.status === 403) { _leave(false); return; }
      dot.className = "comp-dot online";
    } catch (_) {
      dot.className = "comp-dot warn";
    }
  }
  _beat();
  setInterval(_beat, 30_000);

  // ── Chat — history in localStorage ───────────────────────────
  const HIST_KEY = `tli_chat_hist_${SAT_ID}`;
  let _history = [];

  function _saveHistory() {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(_history.slice(-40))); } catch (_) {}
  }

  function _loadHistory() {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return;
      _history = arr;
      arr.slice(-12).forEach(m => {
        const el = document.createElement("div");
        el.className = "chat-bubble " + (m.role === "user" ? "user" : "ai");
        el.textContent = m.content;
        chatOut.appendChild(el);
      });
      chatOut.scrollTop = chatOut.scrollHeight;
    } catch (_) {}
  }
  _loadHistory();

  if (!_history.length) {
    chatOut.innerHTML = `<div class="empty"><div class="empty-icon">✦</div>Ask your home AI anything —<br>devices, schedules, quick questions.</div>`;
  }

  function _bubble(role, text) {
    const empty = chatOut.querySelector(".empty");
    if (empty) empty.remove();
    const el = document.createElement("div");
    el.className = "chat-bubble " + role;
    if (role === "ai thinking") {
      el.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div>`;
    } else {
      el.textContent = text;
    }
    chatOut.appendChild(el);
    chatOut.scrollTop = chatOut.scrollHeight;
    return el;
  }

  async function _sendChat(text) {
    if (!text || chatSend.disabled) return;
    chatInput.value = "";
    chatInput.style.height = "";
    chatSend.disabled = true;

    _bubble("user", text);
    _history.push({ role: "user", content: text });

    const thinking = _bubble("ai thinking", "");
    let acc = "";

    let completed = false;
    try {
      const r = await fetch("/api/ai/chat/stream", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, device_id: SAT_ID, max_tokens: 512, temperature: 0.7 }),
      });
      if (!r.ok || !r.body) {
        const error = await r.json().catch(() => ({}));
        throw new Error(error.detail || `HTTP ${r.status}`);
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buffer = "";
      thinking.className = "chat-bubble ai"; thinking.textContent = "";
      try {
        while (!completed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
            for (const line of block.split("\n")) {
              if (!line.startsWith("data:")) continue;
              let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
              if (ev.type === "error") throw new Error(ev.detail || "Provider error");
              if (ev.type === "delta" && ev.text) {
                acc += ev.text; thinking.textContent = acc; chatOut.scrollTop = chatOut.scrollHeight;
              }
              if (ev.type === "done") completed = true;
            }
          }
        }
        if (!completed) throw new Error("The response was interrupted.");
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      thinking.className = "chat-bubble ai";
      thinking.textContent = (acc ? acc + "\n\n" : "") + "Request failed: " + error.message + " It was not automatically retried.";
    }

    if (acc && completed) {
      _history.push({ role: "assistant", content: acc });
      if (_history.length > 60) _history = _history.slice(-50);
      _saveHistory();
    }
    chatSend.disabled = false;
    chatOut.scrollTop = chatOut.scrollHeight;
  }

  chatSend.addEventListener("click", () => _sendChat(chatInput.value.trim()));
  chatInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _sendChat(chatInput.value.trim()); }
  });
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + "px";
  });
  document.querySelectorAll(".chat-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const prompt = chip.dataset.prompt;
      chatInput.value = prompt;
      chatInput.dispatchEvent(new Event("input"));
      _sendChat(prompt);
    });
  });

  // ── Vendor dot color ──────────────────────────────────────────
  function _vendorClass(vendor) {
    const v = (vendor || "").toLowerCase().replace(/[^a-z_]/g, "");
    const known = ["shelly","hue","govee","wled","yeelight","sonoff","kasa","tuya","generic_http"];
    return "device-vendor-dot vc-" + (known.includes(v) ? v : "default");
  }

  // ── Devices ───────────────────────────────────────────────────
  async function _loadDevices() {
    const safeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    devList.innerHTML = "<div class='spinner'></div>";
    try {
      const r = await fetch("/homepower/devices");
      const data = await r.json();
      if (!r.ok || !Array.isArray(data.devices)) throw new Error('Device list unavailable');
      const devs = data.devices;
      if (!devs.length) {
        devList.innerHTML = "<div class='empty'><div class='empty-icon'>🏠</div>No devices yet.<br>Add devices in the Home Automation panel on desktop.</div>";
        return;
      }
      devList.innerHTML = "";
      devs.forEach(dev => {
        const caps = dev.capabilities || [];
        const canSwitch = caps.includes("switch.on") && caps.includes("switch.off");
        const row = document.createElement("div");
        row.className = "device-row";
        row.innerHTML = `
          <div class="device-left">
            <div class="${_vendorClass(dev.vendor)}"></div>
            <div class="device-info">
              <div class="device-name">${safeText(dev.name || dev.device_id)}</div>
              <div class="device-meta">${safeText(dev.vendor || "device")}${dev.vendor === 'shelly' ? ' · Relay ' + safeText(dev.relay ?? 0) : ''}</div>
            </div>
          </div>
          ${canSwitch ? `<label class="toggle"><input type="checkbox" /><span class="toggle-track"></span></label>`
                      : `<span style="font-size:12px;color:var(--muted)">${safeText(caps[0] || "")}</span>`}`;

        if (canSwitch) {
          const cb = row.querySelector("input");
          const status = document.createElement('span'); status.className = 'device-meta'; status.setAttribute('role','status');
          row.querySelector('.device-info').appendChild(status);
          cb.setAttribute('aria-label', `Power for ${dev.name || dev.device_id}`);
          let busy = false, revision = 0;
          async function readState() {
            const version = ++revision;
            cb.disabled = true; cb.indeterminate = true; status.textContent = 'Checking state…';
            try {
              const response = await fetch(`/homepower/devices/${encodeURIComponent(dev.device_id)}/status`, {signal:AbortSignal.timeout(45000)});
              const result = await response.json();
              if (version !== revision) return;
              if (!response.ok || result.ok !== true || typeof result.on !== 'boolean') throw new Error('State unavailable');
              cb.checked = result.on; cb.indeterminate = false; status.textContent = result.on ? 'Reported ON' : 'Reported OFF';
              cb.disabled = busy;
            } catch (_) {
              if (version === revision) { cb.disabled = true; cb.indeterminate = true; status.textContent = 'State unavailable · refresh to check'; }
            }
          }
          readState();
          cb.addEventListener('change', async () => {
            if (busy || cb.disabled) return;
            busy = true; revision++; cb.disabled = true;
            const cap = cb.checked ? 'switch.on' : 'switch.off';
            status.textContent = 'Sending command…';
            try {
              const response = await fetch(`/homepower/devices/${encodeURIComponent(dev.device_id)}/execute`, {
                method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(45000),
                body:JSON.stringify({capability:cap, request_id:Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('')})
              });
              const result = await response.json();
              if (!response.ok || result.ok !== true) throw new Error(result.summary || 'Command not confirmed');
              toast(`${dev.name || 'Device'}: command acknowledged`);
              busy = false; await readState();
            } catch (error) {
              cb.indeterminate = true; cb.disabled = true;
              status.textContent = 'Command unconfirmed · refresh to check state';
              toast(error.message || 'Command unconfirmed. Check status before retrying.', 4000, 'error');
            } finally { busy = false; }
          });
        }
        devList.appendChild(row);
      });
    } catch {
      devList.innerHTML = "<div class='empty'><div class='empty-icon'>⚠️</div>Could not load devices.</div>";
    }
  }

  document.getElementById("devices-refresh-btn").addEventListener("click", _loadDevices);

  // ── Scenes ────────────────────────────────────────────────────
  const SCENE_ICONS = ["⚡","🌙","🎮","☀️","🎬","🏠","🔆","🌅","🎵","✦"];
  let _scenesLoaded = false;

  async function _loadScenes() {
    if (_scenesLoaded) return;
    const list = document.getElementById("scenes-list");
    if (!list) return;
    list.innerHTML = "<div class='spinner'></div>";
    try {
      const r = await fetch("/homepower/scenes");
      const data = await r.json();
      const scenes = data.scenes || [];
      if (!scenes.length) {
        list.innerHTML = "<div class='empty'><div class='empty-icon'>✦</div>No scenes yet.<br>Create scenes in the Automations panel on desktop.</div>";
        _scenesLoaded = true;
        return;
      }
      const grid = document.createElement("div");
      grid.id = "scenes-grid";
      scenes.forEach((scene, i) => {
        const card = document.createElement("button");
        card.className = "scene-card";
        const icon = SCENE_ICONS[i % SCENE_ICONS.length];
        card.innerHTML = `
          <div class="scene-run-pulse"></div>
          <span class="scene-card-icon">${icon}</span>
          <div class="scene-card-name">${scene.name || scene.scene_id}</div>
          ${scene.description ? `<div class="scene-card-desc">${scene.description}</div>` : ""}`;
        card.addEventListener("click", async () => {
          if (card.disabled) return;
          card.disabled = true;
          card.classList.add("running");
          try {
            const resp = await fetch("/homepower/scenes/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scene_id: scene.scene_id, dry_run: false }),
            });
            const d = await resp.json();
            const ok = resp.ok && d.ok === true;
            toast(ok ? `${scene.name} ✓` : "Scene failed", ok ? 1800 : 3000);
            try { navigator.vibrate?.(ok ? [20, 40, 20] : 200); } catch(_) {}
          } catch (_) { toast("Could not run scene"); }
          finally { card.disabled = false; card.classList.remove("running"); }
        });
        grid.appendChild(card);
      });
      list.innerHTML = "";
      list.appendChild(grid);
      _scenesLoaded = true;
    } catch {
      list.innerHTML = "<div class='empty'><div class='empty-icon'>⚠️</div>Could not load scenes.</div>";
    }
  }

  document.getElementById("scenes-refresh-btn")?.addEventListener("click", () => {
    _scenesLoaded = false; _loadScenes();
  });

  // ── Send to desktop ───────────────────────────────────────────
  document.getElementById("push-msg-btn")?.addEventListener("click", async () => {
    const msg = document.getElementById("push-msg-input")?.value?.trim();
    if (!msg) { toast("Type a message first"); return; }
    try {
      const r = await fetch("/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_id: SAT_ID, from_name: SAT_NAME + " (phone)", text: msg, to: "broadcast" }),
      });
      if (r.ok) {
        toast("Sent to desktop ✓");
        const inp = document.getElementById("push-msg-input");
        if (inp) inp.value = "";
        try { navigator.vibrate?.(40); } catch(_) {}
      } else { toast("Send failed"); }
    } catch (_) { toast("Could not reach desktop"); }
  });

  // ── Vault ─────────────────────────────────────────────────────
  let _vaultUnlocked = false;

  async function _loadVault() {
    const wrap      = document.getElementById("vault-status-wrap");
    const secCard   = document.getElementById("vault-secrets-card");
    const loginCard = document.getElementById("vault-logins-card");
    const secList   = document.getElementById("vault-secrets-list");
    const loginList = document.getElementById("vault-logins-list");

    wrap.innerHTML = "<div class='spinner'></div>";
    secCard.hidden = true; loginCard.hidden = true;

    let status;
    try {
      const r = await fetch("/vault/status");
      if (r.status === 401) {
        wrap.innerHTML = `<div class="vault-badge locked">🔒 Session required — open TLI in a browser first</div>`;
        return;
      }
      status = await r.json();
    } catch {
      wrap.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div>Could not reach vault.</div>`;
      return;
    }

    _vaultUnlocked = status.unlocked === true;
    if (!status.initialized) {
      wrap.innerHTML = `<div class="vault-badge locked">🔒 Vault not set up yet</div>`;
      return;
    }

    if (_vaultUnlocked) {
      wrap.innerHTML = `<div class="vault-badge unlocked">🔓 Vault Unlocked</div>`;
      await _loadVaultContents(secCard, secList, loginCard, loginList);
    } else {
      wrap.innerHTML = `
        <div class="c-card">
          <div class="vault-badge locked" style="margin-bottom:12px">🔒 Vault Locked</div>
          <div class="vault-unlock-form">
            <input type="password" class="vault-pw-input" id="vault-pw" placeholder="Vault password…" autocomplete="current-password" />
            <button class="comp-btn sm" id="vault-unlock-btn" style="width:auto;padding:11px 18px">Unlock</button>
          </div>
          <div id="vault-unlock-err" style="font-size:12px;color:var(--danger);margin-top:8px;min-height:16px"></div>
        </div>`;
      document.getElementById("vault-unlock-btn").addEventListener("click", _tryUnlock);
      document.getElementById("vault-pw").addEventListener("keydown", e => { if (e.key === "Enter") _tryUnlock(); });
    }
  }

  async function _tryUnlock() {
    const pw  = document.getElementById("vault-pw")?.value;
    const err = document.getElementById("vault-unlock-err");
    const btn = document.getElementById("vault-unlock-btn");
    if (!pw) return;
    btn.disabled = true; btn.textContent = "…";
    try {
      const r = await fetch("/vault/unlock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const d = await r.json();
      if (d.success) { _vaultUnlocked = true; toast("Vault unlocked ✓"); _loadVault(); }
      else {
        if (err) err.textContent = d.detail?.reason === "locked_out" ? "Too many attempts — try again later." : "Wrong password.";
        btn.disabled = false; btn.textContent = "Unlock";
      }
    } catch {
      if (err) err.textContent = "Network error.";
      btn.disabled = false; btn.textContent = "Unlock";
    }
  }

  async function _loadVaultContents(secCard, secList, loginCard, loginList) {
    try {
      const r = await fetch("/vault/secrets");
      const d = await r.json();
      const keys = d.keys || [];
      if (keys.length) {
        secCard.hidden = false;
        secList.innerHTML = keys.map(k => `
          <div class="secret-row" data-secret-key="${encodeURIComponent(k)}">
            <div class="secret-name">${k}</div>
            <div class="secret-val">••••••</div>
            <button class="copy-btn" data-key="${encodeURIComponent(k)}">Copy</button>
          </div>`).join("");
        secList.querySelectorAll(".copy-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            const key = decodeURIComponent(btn.dataset.key);
            try {
              const r2 = await fetch(`/vault/secret/${encodeURIComponent(key)}`);
              const d2 = await r2.json();
              await navigator.clipboard.writeText(d2.value || "");
              btn.textContent = "✓"; btn.classList.add("copied");
              toast("Copied to clipboard");
              setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
            } catch { toast("Copy failed"); }
          });
        });
      }
    } catch (_) {}
    try {
      const r = await fetch("/vault/logins");
      const d = await r.json();
      const logins = d.logins || [];
      if (logins.length) {
        loginCard.hidden = false;
        loginList.innerHTML = logins.map(l => `
          <div class="secret-row">
            <div style="flex:1;min-width:0">
              <div class="secret-name">${l.name || l.domain}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:1px">${l.username}</div>
            </div>
            <button class="copy-btn" data-login-id="${l.id}">Copy pw</button>
          </div>`).join("");
        loginList.querySelectorAll(".copy-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            const id = btn.dataset.loginId;
            try {
              const r2 = await fetch(`/vault/logins/${encodeURIComponent(id)}`);
              const d2 = await r2.json();
              await navigator.clipboard.writeText(d2.password || "");
              btn.textContent = "✓"; btn.classList.add("copied");
              toast("Password copied");
              setTimeout(() => { btn.textContent = "Copy pw"; btn.classList.remove("copied"); }, 2000);
            } catch { toast("Copy failed"); }
          });
        });
      }
    } catch (_) {}
  }

  // ── Status ────────────────────────────────────────────────────
  async function _loadStatus() {
    document.getElementById("st-name").textContent = SAT_NAME;
    document.getElementById("st-satid").textContent = SAT_ID;
    if (_bat) {
      const pct = _bat.level;
      document.getElementById("st-bat").textContent = `${pct}%${_bat.charging ? " ⚡" : ""}`;
      const bar = document.getElementById("st-bat-bar");
      bar.style.width = pct + "%";
      bar.className = "battery-fill" + (pct < 20 ? " crit" : pct < 40 ? " warn" : "");
    } else {
      document.getElementById("st-bat").textContent = "Not available";
    }
    const ua = navigator.userAgent;
    const plat = /iphone|ipad|ipod/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : "Desktop";
    document.getElementById("st-platform").textContent = plat;
    try {
      const conn = navigator.connection || navigator.mozConnection;
      if (conn) document.getElementById("st-conn").textContent =
        (conn.type && conn.type !== "unknown" ? conn.type : conn.effectiveType) || "Unknown";
    } catch (_) {}
    try {
      const r = await fetch("/system/summary");
      const d = await r.json();
      const aiEl = document.getElementById("st-ai");
      if (aiEl) {
        const aiStatus = d.ai?.status || "unknown";
        aiEl.textContent = aiStatus;
        aiEl.className = "stat-val " + (aiStatus === "running" ? "good" : "warn");
      }
      const devEl = document.getElementById("st-devcount");
      if (devEl) devEl.textContent = d.devices?.count ?? "—";
      const nodeEl = document.getElementById("st-node");
      if (nodeEl) nodeEl.textContent = d.node?.name || d.name || "TLI Node";
    } catch (_) {}
  }

  // ── Leave mesh ────────────────────────────────────────────────
  function _leave(callApi = true) {
    if (callApi) fetch(`/mesh/satellite/${SAT_ID}`, { method: "DELETE" }).catch(() => {});
    localStorage.removeItem("sat_node_id");
    localStorage.removeItem("sat_secret");
    localStorage.removeItem("sat_name");
    localStorage.removeItem(HIST_KEY);
    window.location.href = "/?desktop=1";
  }
  leaveBtn?.addEventListener("click", () => {
    if (confirm("Leave the TLI mesh?\n\nYou can rejoin by scanning a new QR code from the TLI Mesh panel.")) _leave();
  });

})();
