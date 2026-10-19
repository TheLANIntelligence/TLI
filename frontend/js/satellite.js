// TLI SATELLITE SYSTEM
// Phone onboarding + presence heartbeat + desktop management
// =====================================================
(function TLISatellite() {
  let _epoch = 0, _locked = false, _ready = true, _verified = false, _pausedFrom = null;
  let _read = 0, _qrEpoch = 0, _qrTimer = null, _qrPending = false;
  const _removing = new Set();
  const _current = epoch => epoch === _epoch && !_locked && _ready;
  const _el = id => document.getElementById(id);
  const _message = data => typeof data?.detail === 'string' ? data.detail : data?.detail?.message;
  function _controls() {
    const add = _el('mcd-add-sat-btn');
    if (add) { add.disabled = _locked || _qrPending; add.textContent = _ready ? 'Browser satellite' : 'Check satellite access'; }
  }
  function _status(message) {
    if (_el('mcd-satellites-section')) _el('mcd-satellites-section').hidden = false;
    if (_el('mcd-sat-count')) _el('mcd-sat-count').textContent = message;
  }
  function _closeQr() {
    _qrEpoch++;
    if (_qrTimer !== null) clearInterval(_qrTimer);
    _qrTimer = null;
    _el('tli-sat-qr-modal')?.classList.add('hidden');
    for (const id of ['tli-sat-qr-img-wrap','tli-sat-qr-url','tli-sat-qr-countdown']) if (_el(id)) _el(id).textContent = '';
    const copy = _el('tli-sat-qr-copy'); if (copy) { copy.onclick = null; copy.disabled = true; copy.textContent = 'Copy'; }
  }
  function _clear() {
    const pending = _qrPending || _removing.size > 0;
    _epoch++; _read++; _qrPending = false; _removing.clear(); _closeQr();
    if (_el('mcd-sat-grid')) _el('mcd-sat-grid').textContent = '';
    if (_el('mcd-sat-count')) _el('mcd-sat-count').textContent = '';
    if (_el('mcd-satellites-section')) _el('mcd-satellites-section').hidden = true;
    _controls();
    if (pending) _status('Satellite operation interrupted. Outcome not confirmed. No retry was sent.');
  }
  async function _request(url, options, epoch) {
    if (!_current(epoch)) throw new Error('Satellite access changed.');
    const response = await fetch(url, {credentials:'same-origin',cache:'no-store',...options});
    const data = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      const current = _current(epoch);
      if (current || epoch === _pausedFrom && !_ready && !_verified) {
        if (current) window.dispatchEvent(new CustomEvent('tli-session-locked'));
        _status((_message(data) || 'Unlock TLI to manage browser satellites.') + (options.method ? ' Change outcome not confirmed.' : '') + ' No retry was sent.');
        if (current) window.TLIPinLock?.checkAndLock();
      }
    }
    if (!_current(epoch)) throw new Error('Satellite access changed.');
    if (!response.ok) throw new Error(_message(data) || `Request failed (${response.status}).`);
    if (!data || typeof data !== 'object') throw new Error('The host returned an unreadable response.');
    return data;
  }
  window.addEventListener('tli-session-locked', () => { _pausedFrom = _epoch; _locked = true; _ready = false; _verified = false; _clear(); });
  window.addEventListener('tli-session-unlocked', event => {
    const verified = event?.detail?.source === 'pin-verification';
    if (!_locked && (!verified || _verified)) return;
    const replace = !_locked && _ready; _locked = false; _ready = false; if (verified) _verified = true;
    if (replace) _clear(); _controls();
  });
  window.addEventListener('tli-private-observation-ready', () => {
    if (_locked || _ready) return; _ready = true; _pausedFrom = null; _controls();
    if (_el('panel-mesh')?.hidden === false) _loadSatellites();
  });
  window.addEventListener('pagehide', () => { _ready = false; _pausedFrom = null; _clear(); });

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

    let joining = false;
    async function _doJoin() {
      if (joining) return; joining = true;
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
          throw new Error(_message(d) || `HTTP ${r.status}`);
        }
        const data = await r.json();
        if (data.ok !== true || typeof data.node_id !== 'string' || !data.node_id || typeof data.secret !== 'string' || !data.secret || typeof data.name !== 'string') throw new Error('The host did not confirm enrollment.');
        if (localStorage.getItem('sat_node_id')) throw new Error('This browser pairing changed. Reload to review it.');
        localStorage.setItem("sat_node_id", data.node_id);
        localStorage.setItem("sat_secret",  data.secret);
        localStorage.setItem("sat_name",    data.name);

        if (btn) btn.textContent = "Joined! Loading TLI…";
        // Redirect to the phone companion shell
        setTimeout(() => { if (localStorage.getItem('sat_node_id') === data.node_id && localStorage.getItem('sat_secret') === data.secret) window.location.href = "/companion.html"; }, 900);

      } catch (e) {
        joining = false;
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
      if (localStorage.getItem('sat_node_id') !== node_id || localStorage.getItem('sat_secret') !== secret) return;
      const r = await fetch("/mesh/satellite/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => null);
      if (r.status === 403 && data?.detail?.code === 'satellite_credential_invalid' && localStorage.getItem('sat_node_id') === node_id && localStorage.getItem('sat_secret') === secret) {
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

  async function _openQrModal() {
    if (_locked || _qrPending) return;
    if (!_ready) { await window.EventInterpreter?.retry(); return; }
    const modal = _el('tli-sat-qr-modal'), wrap = _el('tli-sat-qr-img-wrap');
    if (!modal) return;
    _closeQr(); const epoch = _epoch, generation = _qrEpoch;
    const current = () => _current(epoch) && generation === _qrEpoch;
    modal.classList.remove('hidden'); if (wrap) wrap.textContent = 'Generating…';
    _qrPending = true; _controls();
    const close = _el('tli-sat-qr-close'); if (close) close.onclick = _closeQr;
    try {
      const data = await _request('/mesh/satellite/generate-token', {method:'POST'}, epoch);
      if (!current()) return;
      const url = new URL(data.url);
      const token = new URLSearchParams(url.hash.slice(1)).get('token') || url.searchParams.get('token');
      const join = new URLSearchParams(url.hash.slice(1)).get('join') || url.searchParams.get('join');
      if (data.ok !== true || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || join !== 'satellite' ||
          url.origin !== window.location.origin || !token || token !== data.token || !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 600) throw new Error('The host did not return a valid invitation.');
      const image = data.qr;
      if (image && (typeof image !== 'string' || image.length > 500000 || !/^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(image))) throw new Error('The invitation QR image is invalid.');
      const urlEl = _el('tli-sat-qr-url'), count = _el('tli-sat-qr-countdown'), copy = _el('tli-sat-qr-copy');
      if (urlEl) urlEl.textContent = url.href;
      if (wrap) {
        wrap.textContent = '';
        if (image) { const img = document.createElement('img'); img.className = 'tli-sat-qr-img'; img.src = image; img.alt = 'QR code — scan to join as satellite'; wrap.appendChild(img); }
        else wrap.textContent = 'QR image unavailable. Copy the URL and open it on your phone.';
      }
      const expires = Date.now() + data.expires_in * 1000;
      function tick() {
        if (!current()) return;
        const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
        if (!remaining) { _closeQr(); _status('Invitation expired. Generate a new code when ready.'); return; }
        if (count) count.textContent = `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
      }
      tick(); _qrTimer = setInterval(tick, 1000);
      if (copy) {
        copy.disabled = false;
        copy.onclick = async () => {
          if (!current() || Date.now() >= expires) return;
          try { await navigator.clipboard.writeText(url.href); if (current()) copy.textContent = 'Copied!'; } catch (_) {}
        };
      }
    } catch (error) {
      if (current() && wrap) wrap.textContent = 'Invitation not confirmed. ' + error.message + ' No retry was sent.';
    } finally { if (epoch === _epoch) { _qrPending = false; _controls(); } }
  }

  // ── Desktop-side: satellite cards ────────────────────────────

  function _buildSatCard(sat) {
    const epoch = _epoch, read = _read;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
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
      const pct      = Number.isFinite(sat.battery_level) ? Math.max(0, Math.min(100, sat.battery_level)) : 0;
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
          <div class="mcd-node-name">${escape(sat.name || "Phone")}</div>
          <div class="mcd-node-sub">${escape(subLine)}</div>
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
      <button class="mcd-sat-remove-btn">Remove</button>
    `;

    const remove = card.querySelector(".mcd-sat-remove-btn");
    remove.addEventListener("click", async () => {
      if (!_current(epoch) || read !== _read || _removing.has(sat.node_id)) return;
      if (!confirm(`Remove "${sat.name || "this phone"}" from the mesh?`)) return;
      if (!_current(epoch) || read !== _read) return;
      _removing.add(sat.node_id); remove.disabled = true;
      try {
        const data = await _request(`/mesh/satellite/${encodeURIComponent(sat.node_id)}`, {method:'DELETE'}, epoch);
        if (!_current(epoch) || read !== _read) return;
        if (data.ok !== true || !Number.isInteger(data.removed) || data.removed < 0 || data.removed > 1) throw new Error('The host did not confirm removal.');
        await _loadSatellites();
      } catch (error) { if (_current(epoch) && read === _read) _status('Removal not confirmed. ' + error.message + ' No retry was sent. Reopen Computers to check the saved list.'); }
      finally { if (_current(epoch)) { _removing.delete(sat.node_id); remove.disabled = false; } }
    });

    return card;
  }

  async function _loadSatellites() {
    if (!_current(_epoch)) return;
    const epoch = _epoch, read = ++_read;
    const section = document.getElementById("mcd-satellites-section");
    const grid    = document.getElementById("mcd-sat-grid");
    const countEl = document.getElementById("mcd-sat-count");
    if (!grid) return;

    try {
      const data = await _request('/mesh/satellite/list', {}, epoch);
      if (!_current(epoch) || read !== _read) return;
      const sats = data.satellites;
      if (!Array.isArray(sats) || sats.some(sat => !sat || typeof sat.node_id !== 'string' || !sat.node_id || sat.name != null && typeof sat.name !== 'string')) throw new Error('The host returned an invalid satellite list.');

      if (section) section.hidden = sats.length === 0;
      if (countEl) {
        const on = sats.filter(s => s.online).length;
        countEl.textContent = on > 0 ? `${on} online` : "all offline";
      }

      grid.innerHTML = "";
      for (const sat of sats) grid.appendChild(_buildSatCard(sat));
    } catch (error) { if (_current(epoch) && read === _read) { grid.textContent = ''; _status('Satellite list unavailable. ' + error.message); } }
  }

  // ── Boot ─────────────────────────────────────────────────────

  function _boot() {
    // Phone path: check if this page load is a join link
    const fragment = new URLSearchParams((window.location.hash || '').slice(1));
    const params = fragment.get('join') === 'satellite' ? fragment : new URLSearchParams(window.location.search || "");
    const isSatJoin = params.get("join") === "satellite";
    const joinToken = params.get("token") || "";

    if (isSatJoin && joinToken) {
      const clean = new URL(window.location.href); clean.searchParams.delete('join'); clean.searchParams.delete('token');
      if (fragment.get('join') === 'satellite') clean.hash = '';
      window.history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
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
    _controls();
    _el('tli-sat-qr-modal')?.addEventListener('click', event => { if (event.target === _el('tli-sat-qr-modal')) _closeQr(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') _closeQr(); });

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
