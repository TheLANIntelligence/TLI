// TLI SATELLITE SYSTEM
// Phone onboarding + presence heartbeat + desktop management
// =====================================================
(function TLISatellite() {

  // ── Detect platform from UA ──────────────────────────────────
  function _platform() {
    const ua = navigator.userAgent;
    if (/iphone|ipad|ipod/i.test(ua)) return "ios";
    if (/android/i.test(ua)) return "android";
    return "unknown";
  }

  function _defaultName() {
    const p = _platform();
    if (p === "ios") {
      if (/ipad/i.test(navigator.userAgent)) return "iPad";
      return "iPhone";
    }
    if (p === "android") return "Android Phone";
    return "Phone";
  }

  // ── Phone-side: join flow ────────────────────────────────────

  function _showJoinScreen(token) {
    const screen = document.getElementById("tli-sat-join");
    if (!screen) return;
    screen.hidden = false;
    screen.classList.remove("hidden");
    screen.removeAttribute("aria-hidden");

    const nameInput = document.getElementById("tli-sat-join-name");
    if (nameInput && !nameInput.value) nameInput.value = _defaultName();

    const btn    = document.getElementById("tli-sat-join-btn");
    const errEl  = document.getElementById("tli-sat-join-error");

    async function _doJoin() {
      const name = (nameInput?.value || "Phone").trim() || "Phone";
      if (btn) { btn.textContent = "Joining…"; btn.disabled = true; }
      if (errEl) errEl.hidden = true;

      try {
        const r = await fetch("/mesh/satellite/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, name, platform: _platform() }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.detail || `HTTP ${r.status}`);
        }
        const data = await r.json();
        localStorage.setItem("sat_node_id", data.node_id);
        localStorage.setItem("sat_secret",  data.secret);
        localStorage.setItem("sat_name",    data.name);

        if (btn) btn.textContent = "Joined! Loading TLI…";
        // Redirect to the phone companion shell
        setTimeout(() => { window.location.href = "/companion.html"; }, 900);

      } catch (e) {
        if (btn) { btn.textContent = "Join Mesh"; btn.disabled = false; }
        if (errEl) {
          errEl.textContent = e.message.includes("expired")
            ? "This link has expired. Ask the desktop to generate a new QR code."
            : `Join failed: ${e.message}`;
          errEl.hidden = false;
        }
      }
    }

    if (btn) btn.addEventListener("click", _doJoin);
    if (nameInput) nameInput.addEventListener("keydown", e => { if (e.key === "Enter") _doJoin(); });
    if (nameInput) setTimeout(() => nameInput.focus(), 100);
  }

  // ── Phone-side: heartbeat ────────────────────────────────────

  async function _beat() {
    const node_id = localStorage.getItem("sat_node_id");
    const secret  = localStorage.getItem("sat_secret");
    if (!node_id || !secret) return;

    const payload = { node_id, secret, platform: _platform() };

    // Battery Status API (Android Chrome; gracefully absent on iOS)
    try {
      if (navigator.getBattery) {
        const bat = await navigator.getBattery();
        payload.battery_level    = Math.round(bat.level * 100);
        payload.battery_charging = bat.charging;
      }
    } catch (_) {}

    // Network Information API (Android Chrome only)
    try {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) payload.connection_type = conn.type || conn.effectiveType || "unknown";
    } catch (_) {}

    try {
      const r = await fetch("/mesh/satellite/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.status === 403) {
        // Satellite was removed from the registry — clear local credentials
        localStorage.removeItem("sat_node_id");
        localStorage.removeItem("sat_secret");
        localStorage.removeItem("sat_name");
      }
    } catch (_) {}
  }

  function _startHeartbeat() {
    _beat();
    setInterval(_beat, 30_000);
  }

  // ── Desktop-side: QR modal ────────────────────────────────────

  function _openQrModal() {
    const modal     = document.getElementById("tli-sat-qr-modal");
    const imgWrap   = document.getElementById("tli-sat-qr-img-wrap");
    const urlEl     = document.getElementById("tli-sat-qr-url");
    const countEl   = document.getElementById("tli-sat-qr-countdown");
    const closeBtn  = document.getElementById("tli-sat-qr-close");
    const copyBtn   = document.getElementById("tli-sat-qr-copy");
    if (!modal) return;

    modal.classList.remove("hidden");
    if (imgWrap) imgWrap.innerHTML = '<div class="tli-sat-qr-loading">Generating…</div>';
    if (urlEl) urlEl.textContent = "";
    if (countEl) countEl.textContent = "";

    let _countTimer = null;

    function _close() {
      modal.classList.add("hidden");
      if (_countTimer) clearInterval(_countTimer);
    }

    if (closeBtn) closeBtn.onclick = _close;
    modal.addEventListener("click", e => { if (e.target === modal) _close(); }, { once: true });
    document.addEventListener("keydown", e => { if (e.key === "Escape") _close(); }, { once: true });

    fetch("/mesh/satellite/generate-token", { method: "POST" })
      .then(r => r.json())
      .then(data => {
        if (urlEl) urlEl.textContent = data.url || "";

        if (data.qr && imgWrap) {
          imgWrap.innerHTML = `<img class="tli-sat-qr-img" src="${data.qr}" alt="QR code — scan to join as satellite">`;
        } else if (imgWrap) {
          imgWrap.innerHTML = `<div class="tli-sat-qr-no-qr">QR generation unavailable.<br>Copy the URL and open it on your phone.</div>`;
        }

        // Countdown timer
        let remaining = data.expires_in || 600;
        function tick() {
          if (!countEl) return;
          if (remaining <= 0) {
            countEl.textContent = "Expired — close and generate a new code";
            clearInterval(_countTimer);
            return;
          }
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          countEl.textContent = `Expires in ${m}:${String(s).padStart(2, "0")}`;
          remaining--;
        }
        tick();
        _countTimer = setInterval(tick, 1000);
      })
      .catch(e => {
        if (imgWrap) imgWrap.innerHTML = `<div class="tli-sat-qr-no-qr">Failed: ${e.message}</div>`;
      });

    if (copyBtn) {
      copyBtn.onclick = () => {
        const url = urlEl?.textContent?.trim();
        if (!url) return;
        navigator.clipboard.writeText(url)
          .then(() => { copyBtn.textContent = "Copied!"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000); })
          .catch(() => {});
      };
    }
  }

  // ── Desktop-side: satellite cards ────────────────────────────

  function _buildSatCard(sat) {
    const online = sat.online !== false;
    const card   = document.createElement("div");
    card.className = "mcd-node satellite" + (online ? "" : " offline");

    const platform = sat.platform || "unknown";
    const platLabel = platform === "ios" ? "iOS" : platform === "android" ? "Android" : "Phone";
    const connRaw   = sat.connection_type || "";
    const connLabel = connRaw === "wifi"     ? "WiFi"
                    : connRaw === "cellular" ? "Cellular"
                    : connRaw && connRaw !== "unknown" ? connRaw
                    : "";
    const subLine = [platLabel, connLabel].filter(Boolean).join(" · ");
    const dotClass = online ? "online" : "offline";

    // Battery row
    let battHtml = "";
    if (sat.battery_level != null) {
      const pct      = sat.battery_level;
      const col      = pct < 20 ? "crit" : pct < 40 ? "warn" : "";
      const charging = sat.battery_charging ? " ⚡" : "";
      battHtml = `
        <div class="mcd-sat-battery">
          <span class="mcd-sat-bat-label">Battery</span>
          <div class="mcd-metric-bar" style="flex:1">
            <div class="mcd-metric-bar-fill ${col}" style="width:${pct}%"></div>
          </div>
          <span class="mcd-sat-bat-val">${pct}%${charging}</span>
        </div>`;
    }

    // Last seen (if offline)
    let lastSeenHtml = "";
    if (!online && sat.last_seen) {
      try {
        const d = new Date(sat.last_seen);
        lastSeenHtml = `<div class="mcd-offline-msg">Last seen ${d.toLocaleString()}</div>`;
      } catch (_) {}
    }

    card.innerHTML = `
      <div class="mcd-node-top">
        <div class="mcd-node-avatar sat-av">📱</div>
        <div class="mcd-node-nameblock">
          <div class="mcd-node-name">${sat.name || "Phone"}</div>
          <div class="mcd-node-sub">${subLine}</div>
        </div>
        <div class="mcd-status-dot ${dotClass}" title="${online ? "Online" : "Offline"}"></div>
      </div>
      ${lastSeenHtml}
      ${battHtml}
      <div class="mcd-ai-row">
        <div class="mcd-ai-dot running"></div>
        <div class="mcd-ai-label">AI via Host</div>
        <div class="mcd-ai-sublabel">Proxied</div>
      </div>
      <button class="mcd-sat-remove-btn" data-sat-id="${sat.node_id}">Remove</button>
    `;

    card.querySelector(".mcd-sat-remove-btn").addEventListener("click", async () => {
      if (!confirm(`Remove "${sat.name || "this phone"}" from the mesh?`)) return;
      try {
        await fetch(`/mesh/satellite/${sat.node_id}`, { method: "DELETE" });
        _loadSatellites();
      } catch (_) {}
    });

    return card;
  }

  async function _loadSatellites() {
    const section = document.getElementById("mcd-satellites-section");
    const grid    = document.getElementById("mcd-sat-grid");
    const countEl = document.getElementById("mcd-sat-count");
    if (!grid) return;

    try {
      const r = await fetch("/mesh/satellite/list", { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      const sats = data.satellites || [];

      if (section) section.hidden = sats.length === 0;
      if (countEl) {
        const on = sats.filter(s => s.online).length;
        countEl.textContent = on > 0 ? `${on} online` : "all offline";
      }

      grid.innerHTML = "";
      for (const sat of sats) grid.appendChild(_buildSatCard(sat));
    } catch (_) {}
  }

  // ── Boot ─────────────────────────────────────────────────────

  function _boot() {
    // Phone path: check if this page load is a join link
    const params = new URLSearchParams(window.location.search || "");
    const isSatJoin = params.get("join") === "satellite";
    const joinToken = params.get("token") || "";

    if (isSatJoin && joinToken) {
      // Already registered? Skip join, go straight to app
      if (localStorage.getItem("sat_node_id")) {
        // Already joined — go to companion shell
        window.location.href = "/companion.html";
        return;
      }
      // Show join screen after DOM is ready
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => _showJoinScreen(joinToken));
      } else {
        _showJoinScreen(joinToken);
      }
      return;
    }

    // Phone path: already registered — run heartbeat
    if (localStorage.getItem("sat_node_id")) {
      _startHeartbeat();
    }

    // Desktop path: wire controls after DOM ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _wireDesktop);
    } else {
      _wireDesktop();
    }
  }

  function _wireDesktop() {
    const addBtn = document.getElementById("mcd-add-sat-btn");
    if (addBtn) addBtn.addEventListener("click", _openQrModal);

    // Load satellite cards whenever the mesh panel is opened
    document.addEventListener("tli-panel-switched", e => {
      if (e.detail?.panelId === "panel-mesh") _loadSatellites();
    });
  }

  _boot();
})();


// [module] See /js/pin-lock.js

// [module] See /js/cmd-palette.js

// [module] See /js/fetch-interceptor.js

// =====================================================
