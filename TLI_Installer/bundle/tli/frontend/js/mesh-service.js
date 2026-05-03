// =====================================================
// MeshService (inline, single source of truth)
// Presence • Authority • Routing • Context
// =====================================================
window.MeshService = (function () {
  const _state = {
    lastNodeFetchMs: 0,
    lastDirFetchMs: 0,
    ttlMs: 2500,
    defaultConsolePort: 8000,
  };

  function _now() { return Date.now(); }
  function _isFresh(lastMs) { return (_now() - (lastMs || 0)) < _state.ttlMs; }

  function _pickIp(device) {
    return (device && (device.ip || device.addr || device.address || device.host || device.host_ip))
      ? String(device.ip || device.addr || device.address || device.host || device.host_ip).trim()
      : "";
  }

  function _pickPort(device) {
    const p = device?.console_port ?? device?.port ?? device?.ui_port ?? device?.http_port;
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : _state.defaultConsolePort;
  }

  function _consoleUrl(device, panel) {
    const ip = _pickIp(device);
    const port = _pickPort(device);
    if (!ip) return null;
    const p = (panel || "").trim();
    const qs = p ? `?panel=${encodeURIComponent(p)}` : "";
    return `http://${ip}:${port}/${qs}`;
  }

  function _parseLastSeenMs(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (!v) return 0;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : 0;
  }

  function _presenceFromLastSeenMs(lastSeenMs) {
    if (!lastSeenMs) return "offline";
    const age = _now() - lastSeenMs;
    if (age < 20_000) return "online";
    if (age < 120_000) return "idle";
    if (age < 600_000) return "sleep";
    return "offline";
  }

  async function fetchNode({ force = false } = {}) {
    if (!force && _isFresh(_state.lastNodeFetchMs) && currentNodeConfig) return currentNodeConfig;
    const res = await fetch("/mesh/node", { headers: { "Accept": "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    currentNodeConfig = data;
    // Backward-compat for older code paths
    window.currentNodeConfig = data;
    _state.lastNodeFetchMs = _now();
    return data;
  }

  async function fetchDirectory({ force = false } = {}) {
    if (!force && _isFresh(_state.lastDirFetchMs) && meshDirectoryCache) return meshDirectoryCache;
    const res = await fetch("/mesh/directory", { headers: { "Accept": "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    meshDirectoryCache = data;
    // Backward-compat for older code paths
    window.meshDirectoryCache = data;
    _state.lastDirFetchMs = _now();
    return data;
  }

  function getThisNode() { return currentNodeConfig || null; }

  function getRoleLabel() {
    const n = getThisNode();
    if (!n) return "UNKNOWN";
    if (n.is_host || n.role === "host") return "HOST";
    const r = String(n.role || "").toLowerCase();
    if (r === "member") return "MEMBER";
    if (r) return r.toUpperCase();
    return "STANDALONE";
  }

  function isHost() {
    const n = getThisNode();
    return !!(n && (n.is_host || n.role === "host"));
  }

  function can(action) {
    const a = String(action || "").toLowerCase();
    if (a.startsWith("host:")) {
      if (!isHost()) return { ok: false, reason: "Host-only action." };
      return { ok: true };
    }
    // extra safety
    if (a.includes("disconnect_all") || a.includes("kill_all")) {
      if (!isHost()) return { ok: false, reason: "Host-only action." };
    }
    return { ok: true };
  }

  function getRoster() {
    const dir = meshDirectoryCache;
    const devices = Array.isArray(dir?.devices) ? dir.devices
                 : Array.isArray(dir?.nodes) ? dir.nodes
                 : [];

    const out = [];
    const seen = new Set();
    for (const d of devices) {
      const ip = _pickIp(d);
      if (!ip) continue;
      if (seen.has(ip)) continue;
      seen.add(ip);

      const id = d.device_id || d.node_id || d.id || ip;
      const name = d.display_name || d.nickname || d.node_name || d.device_name || d.hostname || id;
      const role = String(d.role || d.nodeRole || d.node_role || "member").toLowerCase();
      const lastSeenMs = _parseLastSeenMs(d.last_seen || d.lastSeen || d.seen_at || d.updated_at || d.heartbeat);
      const presence = _presenceFromLastSeenMs(lastSeenMs);
      out.push({ id, name, ip, role, lastSeenMs, presence, raw: d });
    }
    return out;
  }

  function openNodePanel(deviceLike, panel) {
    const url = _consoleUrl(deviceLike, panel);
    if (!url) {
      showToast("No IP available for that node.", "warning");
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function setHeaderMeshPill() {
    const pill = $("mesh-model-pill");
    if (!pill) return;

    const role = getRoleLabel();
    const roster = getRoster();
    const nodes = roster.length;

    // Keep it compact + premium
    // Examples:
    //  - Mesh: HOST · 2 nodes
    //  - Mesh: MEMBER · 1 node
    //  - LAN-only · No mesh
    if (role === "UNKNOWN" || role === "STANDALONE") {
      pill.textContent = "LAN-only · No mesh";
      pill.classList.add("mesh-offline");
      pill.classList.remove("mesh-online");
      return;
    }

    pill.textContent = `Mesh: ${role} · ${nodes} node${nodes === 1 ? "" : "s"}`;
    pill.classList.add("mesh-online");
    pill.classList.remove("mesh-offline");
  }

  return {
    fetchNode,
    fetchDirectory,
    getThisNode,
    getRoleLabel,
    isHost,
    can,
    getRoster,
    openNodePanel,
    setHeaderMeshPill,
    _setTTL(ms) {
      const n = parseInt(ms, 10);
      if (Number.isFinite(n) && n >= 250) _state.ttlMs = n;
    },
    _setConsolePort(port) {
      const n = parseInt(port, 10);
      if (Number.isFinite(n)) _state.defaultConsolePort = n;
    }
  };
})();
