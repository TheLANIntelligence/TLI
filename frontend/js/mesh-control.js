// TLI Mesh Control Center
(function () {
  const REFRESH_INTERVAL = 30000; // auto-refresh every 30s
  let _timer = null;
  let _pending = false, _lastSuccess = null, _epoch = 0;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function uniqueNodes(nodes) {
    const seen = new Set();
    return nodes.filter(n => {
      const key = n.peer_id || n.node_id || n.id || (n.ip ? n.ip + ':' + (n.port || n.tli_port || '') : null);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  function fmt(id) { return document.getElementById(id); }

  function fmtUptime(sec) {
    if (!sec && sec !== 0) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtGb(gb) { return gb != null ? `${gb} GB` : "—"; }

  function pctColor(pct) {
    if (pct == null) return "";
    if (pct >= 90) return "crit";
    if (pct >= 70) return "warn";
    return "";
  }

  function initial(name) {
    return (name || "?").trim().charAt(0).toUpperCase();
  }

  function cleanOfflineError(err) {
    if (!err) return "Not reachable";
    const s = String(err).toLowerCase();
    if (s.includes("timed out") || s.includes("timeout"))  return "Connection timed out";
    if (s.includes("refused"))                              return "Connection refused";
    if (s.includes("not reachable") || s.includes("max retries")) return "Not reachable";
    if (s.includes("host not found") || s.includes("getaddrinfo")) return "Host not found";
    if (s.includes("http "))                               return err; // HTTP status codes are fine to show
    return "Not reachable"; // hide any other raw exceptions
  }

  function buildNodeCard(n) {
    const isSelf = !!n.is_self;
    const inferenceNode = !isSelf && (n.peer_profile === 'inference_node' || n.connection_state === 'inference_only');
    const online = n.online === true && !n.error;
    const knownOffline = n.online === false;
    const name = escape(n.node_name || n.hostname || n.ip || "Unknown computer");

    const card = document.createElement("div");
    card.className = "mcd-node" + (isSelf ? " self" : "") + (!online && !inferenceNode ? " offline" : "");

    // ── Top row ──
    const avClass = isSelf ? "self-av" : inferenceNode ? "" : (online ? "peer-av" : "offline-av");
    const dotClass = online ? "online" : "offline";
    const selfTag = isSelf ? `<span class="mcd-self-tag">TLI host</span>` : inferenceNode ? `<span class="mcd-self-tag">Compute-only Node</span>` : "";
    const osLabel = escape(n.os || '');
    const ipLabel = n.ip ? ` · ${escape(n.ip)}` : "";

    card.innerHTML = `
      <div class="mcd-node-top">
        <div class="mcd-node-avatar ${avClass}">${initial(name)}</div>
        <div class="mcd-node-nameblock">
          <div class="mcd-node-name">${name}${selfTag}</div>
          <div class="mcd-node-sub">${osLabel}${ipLabel}</div>
        </div>
        ${inferenceNode ? "" : `<div class="mcd-status-dot ${dotClass}" title="${online ? "Reported online" : knownOffline ? "Not reachable" : "Status unavailable"}"></div>`}
      </div>
    `;

    if (inferenceNode) {
      const availability = document.createElement('div');
      availability.className = 'mcd-ai-row';
      availability.textContent = 'Check models in Ask TLI to check this Node’s current availability.';
      card.appendChild(availability);
      return card;
    }

    // Registry identity only. A duplicated display name or an IP is never a key.
    const registryId = n.peer_id || n.node_id || n.id;
    if (typeof registryId === 'string' && registryId.length && registryId.length <= 240) {
      const details = document.createElement('button'); details.type = 'button'; details.className = 'btn-outline';
      details.textContent = 'Device details'; details.dataset.deviceDetailsId = 'node-' + registryId;
      details.addEventListener('click', () => window.TLIDeviceDetails?.open('node-' + registryId)); card.appendChild(details);
      if (!isSelf) { const messages = document.createElement('button'); messages.type = 'button'; messages.className = 'btn-outline'; messages.textContent = 'Messages & files'; messages.addEventListener('click', () => window.TLIChat?.openPeer?.(registryId)); card.appendChild(messages); }
      if (!isSelf && n.pairing_available === true) {
        const connect = document.createElement('button'); connect.type = 'button'; connect.className = 'btn-primary';
        connect.textContent = 'Request connection'; connect.dataset.pairingDeviceId = registryId;
        connect.addEventListener('click', () => window.TLIPeerPairing?.open({deviceId:registryId,name:n.node_name || n.hostname || registryId}));
        card.appendChild(connect);
      }
    }

    if (!online) {
      const err = document.createElement("div");
      err.className = "mcd-offline-msg";
      // Show a clean reason — never expose raw Python exceptions to the user
      const reason = n.error ? cleanOfflineError(n.error) : "Not reachable";
      err.textContent = n.connection_state === 'review_required' ? 'Computer access needs review; no connection check was sent.' : knownOffline ? `Not reachable — ${reason}` : 'Current health is unavailable. Refresh to check again.';
      card.appendChild(err);
      return card;
    }

    // ── Metrics ──
    const cpu = n.cpu_percent != null ? `${Math.round(n.cpu_percent)}%` : "—";
    const ram = n.ram_percent != null ? `${Math.round(n.ram_percent)}%` : "—";
    const disk = n.disk_percent != null ? `${Math.round(n.disk_percent)}%` : "—";
    const ramDetail = (n.ram_used_gb != null && n.ram_total_gb != null)
      ? `${n.ram_used_gb} / ${n.ram_total_gb} GB` : "";
    const diskFree = n.disk_free_gb != null ? `${n.disk_free_gb} GB free` : "";

    const metrics = document.createElement("div");
    metrics.className = "mcd-metrics";
    for (const [label, val, pct, sub] of [
      ["CPU",  cpu,  n.cpu_percent,  ""],
      ["RAM",  ram,  n.ram_percent,  ramDetail],
      ["Disk", disk, n.disk_percent, diskFree],
    ]) {
      const col = pctColor(pct);
      metrics.innerHTML += `
        <div class="mcd-metric">
          <div class="mcd-metric-val">${val}</div>
          <div class="mcd-metric-label">${label}</div>
          ${pct != null ? `<div class="mcd-metric-bar"><div class="mcd-metric-bar-fill ${col}" style="width:${Math.min(100,pct)}%"></div></div>` : ""}
          ${sub ? `<div style="font-size:10px;color:var(--text-soft);margin-top:3px">${sub}</div>` : ""}
        </div>`;
    }
    card.appendChild(metrics);

    // ── AI row ──
    const aiRow = document.createElement("div");
    aiRow.className = "mcd-ai-row";
    if (n.ai_healthy === true) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot running"></div>
        <div class="mcd-ai-label">AI Running</div>
          <div class="mcd-ai-sublabel">${escape(n.active_model || n.active_preset || "")}</div>`;
    } else if (n.has_ai === true) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot has"></div>
        <div class="mcd-ai-label">Model files reported</div>
        <div class="mcd-ai-sublabel">Installation completeness and running status not confirmed</div>`;
    } else if (n.has_ai === false) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot none"></div>
        <div class="mcd-ai-label">No bundled model reported</div>
        <div class="mcd-ai-sublabel">Other provider availability not confirmed</div>`;
    } else {
      aiRow.textContent = 'AI availability unknown';
    }
    card.appendChild(aiRow);

    // ── Uptime ──
    if (n.uptime_seconds != null) {
      const up = document.createElement("div");
      up.className = "mcd-uptime";
      up.textContent = `Uptime: ${fmtUptime(n.uptime_seconds)}`;
      card.appendChild(up);
    }

    return card;
  }

  async function refresh() {
    const grid = fmt("mcd-grid");
    const btn  = fmt("mcd-refresh-btn");
    const updated = fmt("mcd-last-updated");
    if (!grid) return;
    if (_pending) return;
    _pending = true;
    const epoch = _epoch;

    if (btn) btn.classList.add("spinning");

    try {
      const r = await fetch("/api/mesh/health", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (epoch !== _epoch) return;
      if (!Array.isArray(data.nodes)) throw new Error('Incomplete computer health response');

      grid.innerHTML = "";
      const nodes = data.nodes || [];
      if (!nodes.length) {
        grid.innerHTML = '<div class="mcd-loading">No TLI computers were returned by the latest check.</div>';
      } else {
        // Self first, then online peers, then offline
        const sorted = [
          ...nodes.filter(n => n.is_self),
          ...nodes.filter(n => !n.is_self && n.online !== false),
          ...nodes.filter(n => !n.is_self && n.online === false),
        ];
        // Frontend dedup safety net — same machine can appear under multiple IPs/IDs
        const deduped = uniqueNodes(sorted);
        for (const n of deduped) grid.appendChild(buildNodeCard(n));
      }

      _lastSuccess = new Date();
      grid.classList.remove('mcd-stale');
      if (updated) updated.textContent = "Last successful check: " + _lastSuccess.toLocaleTimeString();
    } catch (e) {
      if (epoch !== _epoch) return;
      if (_lastSuccess) {
        grid.classList.add('mcd-stale');
        if (updated) updated.textContent = 'Check unavailable. Previous results from ' + _lastSuccess.toLocaleTimeString() + ' may be out of date.';
      } else grid.textContent = 'Computer health is unavailable. Check the TLI connection, then choose Refresh.';
    } finally {
      _pending = false;
      if (btn) btn.classList.remove("spinning");
    }
  }

  function start() {
    refresh();
    if (!_timer) _timer = setInterval(refresh, REFRESH_INTERVAL);
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  // Wire refresh button
  function boot() {
    const btn = fmt("mcd-refresh-btn");
    if (btn && !btn.__mcdBound) {
      btn.__mcdBound = true;
      btn.addEventListener("click", refresh);
    }

    // Start/stop polling when panel is opened/closed
    document.addEventListener("tli-panel-switched", (e) => {
      if (e.detail && e.detail.panelId === "panel-mesh") {
        start();
      } else {
        stop();
      }
    });
    window.addEventListener('tli-session-locked', () => {
      stop(); _epoch++; _lastSuccess = null;
      const grid = fmt('mcd-grid'); if (grid) grid.textContent = 'Unlock TLI to check connected computers.';
      const updated = fmt('mcd-last-updated'); if (updated) updated.textContent = '';
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
