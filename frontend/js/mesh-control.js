// TLI Mesh Control Center
(function () {
  const REFRESH_INTERVAL = 30000; // auto-refresh every 30s
  let _timer = null;

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
    const online = n.online !== false;
    const name = n.node_name || n.hostname || n.ip || "Unknown";

    const card = document.createElement("div");
    card.className = "mcd-node" + (isSelf ? " self" : "") + (!online ? " offline" : "");

    // ── Top row ──
    const avClass = isSelf ? "self-av" : (online ? "peer-av" : "offline-av");
    const dotClass = online ? "online" : "offline";
    const selfTag = isSelf ? `<span class="mcd-self-tag">This device</span>` : "";
    const osLabel = n.os ? n.os : "";
    const ipLabel = n.ip ? ` · ${n.ip}` : "";

    card.innerHTML = `
      <div class="mcd-node-top">
        <div class="mcd-node-avatar ${avClass}">${initial(name)}</div>
        <div class="mcd-node-nameblock">
          <div class="mcd-node-name">${name}${selfTag}</div>
          <div class="mcd-node-sub">${osLabel}${ipLabel}</div>
        </div>
        <div class="mcd-status-dot ${dotClass}" title="${online ? "Online" : "Offline"}"></div>
      </div>
    `;

    if (!online) {
      const err = document.createElement("div");
      err.className = "mcd-offline-msg";
      // Show a clean reason — never expose raw Python exceptions to the user
      const reason = n.error ? cleanOfflineError(n.error) : "Not reachable";
      err.textContent = `Offline — ${reason}`;
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
    if (n.ai_healthy) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot running"></div>
        <div class="mcd-ai-label">AI Running</div>
        <div class="mcd-ai-sublabel">${n.active_model || n.active_preset || ""}</div>`;
    } else if (n.has_ai) {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot has"></div>
        <div class="mcd-ai-label">AI Downloaded</div>
        <div class="mcd-ai-sublabel">Not running</div>`;
    } else {
      aiRow.innerHTML = `
        <div class="mcd-ai-dot none"></div>
        <div class="mcd-ai-label">No AI</div>
        <div class="mcd-ai-sublabel">No model</div>`;
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

    if (btn) btn.classList.add("spinning");

    try {
      const r = await fetch("/api/mesh/health", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();

      grid.innerHTML = "";
      const nodes = data.nodes || [];
      if (!nodes.length) {
        grid.innerHTML = '<div class="mcd-loading">No nodes found yet — discovery is running in the background.</div>';
      } else {
        // Self first, then online peers, then offline
        const sorted = [
          ...nodes.filter(n => n.is_self),
          ...nodes.filter(n => !n.is_self && n.online !== false),
          ...nodes.filter(n => !n.is_self && n.online === false),
        ];
        // Frontend dedup safety net — same machine can appear under multiple IPs/IDs
        const seenIps   = new Set();
        const seenNames = new Set();
        const deduped   = sorted.filter(n => {
          const ip   = n.ip || "";
          const name = (n.node_name || n.hostname || "").trim().toLowerCase();
          if (ip && seenIps.has(ip))     return false;
          if (name && seenNames.has(name)) return false;
          if (ip)   seenIps.add(ip);
          if (name) seenNames.add(name);
          return true;
        });
        for (const n of deduped) grid.appendChild(buildNodeCard(n));
      }

      if (updated) updated.textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) {
      grid.innerHTML = `<div class="mcd-loading">Could not load mesh health: ${e.message}</div>`;
    } finally {
      if (btn) btn.classList.remove("spinning");
    }
  }

  function start() {
    refresh();
    _timer = setInterval(refresh, REFRESH_INTERVAL);
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
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
