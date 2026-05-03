// ---------- Mesh / Nodes panel ----------

function renderMeshNode(node) {
  const summaryEl    = $("mesh-node-summary");
  const idEl         = $("mesh-node-id");
  const nameEl       = $("mesh-node-name");
  const roleEl       = $("mesh-node-role");
  const joinModeEl   = $("mesh-node-join-mode");
  const hostAddrEl   = $("mesh-node-host-address");
  const createdEl    = $("mesh-node-created");
  const lastSeenEl   = $("mesh-node-last-seen");
  const joinStatusEl = $("mesh-join-status");

  // If nothing configured yet
  if (!node) {
    if (summaryEl)    summaryEl.textContent    = "Mesh not configured on this node yet.";
    if (idEl)         idEl.textContent         = "—";
    if (nameEl)       nameEl.textContent       = "—";
    if (roleEl)       roleEl.textContent       = "—";
    if (joinModeEl)   joinModeEl.textContent   = "—";
    if (hostAddrEl)   hostAddrEl.textContent   = "—";
    if (createdEl)    createdEl.textContent    = "—";
    if (lastSeenEl)   lastSeenEl.textContent   = "—";
    if (joinStatusEl) joinStatusEl.textContent = "Not currently joined to a host.";
    return;
  }

  const isHost  = !!(node.is_host || node.role === "host");
  const roleRaw = (node.role || (isHost ? "host" : "node")).toString().toLowerCase();

  const roleLabel = isHost
    ? "Host"
    : roleRaw.charAt(0).toUpperCase() + roleRaw.slice(1);
  // Show/hide mesh controls based on role
  const becomeHostBtn = $("mesh-become-host-btn");
  const joinInput     = $("mesh-join-host-address");
  const joinBtn       = $("mesh-join-btn");

  if (becomeHostBtn) {
    // Only standalone nodes can promote themselves to Host
    if (isHost || roleRaw === "member") {
      becomeHostBtn.style.display = "none";
    } else {
      becomeHostBtn.style.display = "";
    }
  }

  if (joinInput && joinBtn) {
    // Host never joins another host
    const disableJoin = isHost;
    joinInput.disabled = disableJoin;
    joinBtn.disabled   = disableJoin;
  }

  const name =
    node.display_name ||
    node.node_name ||
    node.device_name ||
    node.device_id ||
    "Unnamed node";

  // Top-right pill-style summary
  if (summaryEl) {
    if (isHost) {
      summaryEl.textContent = `${name} · HOST of this Home Mesh`;
    } else if (roleRaw === "member") {
      const hostAddr = node.host_address || "host";
      summaryEl.textContent = `${name} · Joined to ${hostAddr}`;
    } else {
      summaryEl.textContent = `${name} · Standalone node`;
    }
  }

  // Detail fields
  if (idEl)       idEl.textContent       = node.node_id || node.device_id || "—";
  if (nameEl)     nameEl.textContent     = name;
  if (roleEl)     roleEl.textContent     = roleLabel;
  if (joinModeEl) joinModeEl.textContent = node.join_mode || node.mode || (isHost ? "host" : "standalone");
  if (hostAddrEl) hostAddrEl.textContent = node.host_address || (isHost ? "This node" : "—");
  if (createdEl)  createdEl.textContent  = node.created_at || "—";
  if (lastSeenEl) lastSeenEl.textContent = node.last_seen || "—";

  // Themed, human-readable join status line under the input
  if (joinStatusEl) {
    if (isHost) {
      joinStatusEl.textContent = "This node is the Host of the Home Mesh.";
    } else if (roleRaw === "member") {
      const hostAddr = node.host_address || "the host";
      joinStatusEl.textContent = `This node is joined to ${hostAddr}.`;
    } else {
      joinStatusEl.textContent = "Not currently joined to a host.";
    }
  }

  debugLog("mesh", "info", "Rendered mesh node config");
}

function renderMeshDirectory(directory) {
  const hostCard = $("mesh-host-card");
  const statusEl = $("mesh-directory-status");
  const listEl   = $("mesh-directory-list");

  if (!hostCard || !statusEl || !listEl) return;

  // Is this node currently the Host?
  const isHostNode =
    currentNodeConfig &&
    (currentNodeConfig.is_host || currentNodeConfig.role === "host");

  // If we have no directory data:
  //   - Non-host: hide the card
  //   - Host: keep the card visible, just clear the list
  if (!directory || !Array.isArray(directory.devices)) {
    if (!isHostNode) {
      hostCard.style.display = "none";
      statusEl.textContent =
        "This node is not acting as a Host. Only the Host can approve or block other nodes.";
    } else {
      hostCard.style.display = "";
      statusEl.textContent = "No other nodes have requested access yet.";
    }
    listEl.innerHTML = "";
    return;
  }

  // We have a directory and devices – always show the card
  hostCard.style.display = "";

  // 🔹 Filter + de-duplicate devices:
  //   - remove THIS node (is_self/self)
  //   - collapse multiple entries with the same IP
  const rawDevices = directory.devices || [];
  const deduped = [];
  const seenIps = new Set();

  for (const dev of rawDevices) {
    const isSelf = dev.is_self || dev.self || false;
    if (isSelf) continue; // don't show the Host itself in the list

    const ip = dev.ip || "";
    if (!ip) continue;    // 🔹 skip “ghost” nodes with no IP (they look gross + unusable)

    if (seenIps.has(ip)) continue; // de-dupe by IP
    seenIps.add(ip);

    deduped.push(dev);
  }

  const devices = deduped;


  if (!devices.length) {
    statusEl.textContent = "No other nodes have joined yet.";
    const emptyEl = $("mesh-directory-empty");
    if (emptyEl) emptyEl.style.display = "";
    return;
  }
  const emptyEl = $("mesh-directory-empty");
  if (emptyEl) emptyEl.style.display = "none";

  statusEl.textContent = `Total nodes: ${devices.length}`;

  // Helper: compute health state from last_seen + mesh status
  function computeNodeHealth(device) {
    try {
      const state = (device.state || device.status || "").toLowerCase();
      const lastSeenStr =
        device.last_seen || device.lastSeen || device.lastHeartbeat;
      const now = Date.now();

      let ageMs = null;
      if (lastSeenStr) {
        const t = Date.parse(lastSeenStr);
        if (!isNaN(t)) {
          ageMs = now - t;
        }
      }

      // If explicitly blocked, treat as "offline" from a control perspective
      if (state === "blocked") {
        return { key: "blocked", label: "Blocked" };
      }

      // If no age info, fall back to state alone
      if (ageMs == null) {
        if (state === "allowed") {
          return { key: "good", label: "Online" };
        }
        if (state === "pending") {
          return { key: "pending", label: "Pending" };
        }
        return { key: "unknown", label: "Unknown" };
      }

      // Age thresholds (tweak as you like)
      const sec = ageMs / 1000;

      if (sec <= 20) {
        return { key: "good", label: "Online" };
      } else if (sec <= 60) {
        return { key: "warn", label: "Stale" };
      } else {
        return { key: "bad", label: "Offline" };
      }
    } catch (e) {
      console.warn("computeNodeHealth failed", e, device);
      return { key: "unknown", label: "Unknown" };
    }
  }

  const html = devices
    .map((dev) => {
      const id   = dev.device_id || dev.node_id || "unknown";
      const ip   = dev.ip || "";
      const name =
        dev.display_name ||
        dev.node_name ||
        dev.device_name ||
        id;
      const state    = (dev.state || dev.status || "allowed").toLowerCase();
      const lastSeen = dev.last_seen || "—";
      const isSelf   = dev.is_self || dev.self || false;
      const health   = computeNodeHealth(dev);

      let stateLabel = state;
      if (state === "pending") stateLabel = "Pending approval";
      if (state === "allowed") stateLabel = "Allowed";
      if (state === "blocked") stateLabel = "Blocked";

      const healthPill =
  health && health.key
    ? `<span class="mesh-pill mesh-pill-health mesh-pill-${health.key}">
         ${health.label}
       </span>`
    : "";


      // Actions based on state (Host approval controls)
      const actions = [];
      if (!isSelf) {
        if (state === "pending" || state === "blocked") {
          actions.push(
            `<button class="btn btn-primary" data-mesh-action="allow" data-device-id="${id}">Allow</button>`
          );
        }
        if (state === "pending" || state === "allowed") {
          actions.push(
            `<button class="btn btn-ghost" data-mesh-action="block" data-device-id="${id}">Block</button>`
          );
        }
        actions.push(
          `<button class="btn btn-ghost" data-mesh-action="remove" data-device-id="${id}">Remove</button>`
        );
      }

      const selfTag = isSelf
        ? '<span class="mesh-pill">This node</span>'
        : "";

      // Multi-node launcher + Agent buttons
      const launchButtons = [];

      // Lightweight “chip” actions – always available when we know the node IP
      if (ip) {
        // Node info & ping (host proxies)
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-info="${id}">Node info</button>`
        );
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-ping="${id}">Ping node</button>`
        );

        // Node Agent maintenance hooks
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="refresh" data-device-id="${id}">Refresh stats</button>`
        );
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="clean_temp" data-device-id="${id}">Clean temp</button>`
        );
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="logs" data-device-id="${id}">View logs</button>`
        );
      }

      // Deep-links into the node's own console (only when Allowed)
      if (ip && state === "allowed") {
        launchButtons.push(
          `<button class="btn btn-primary" data-mesh-open="visualizer" data-ip="${ip}">Open Visualizer</button>`
        );
        launchButtons.push(
          `<button class="btn btn-primary" data-mesh-open="tools" data-ip="${ip}">Open Tools</button>`
        );
      }

      return `
        <div class="mesh-node-card">
          <div class="mesh-node-header">
            <div class="mesh-node-title">
              <span class="mesh-node-name">${name}</span>
              ${selfTag}
            </div>
            <div class="mesh-node-meta">
              <span class="mesh-pill">${stateLabel}</span>
              ${healthPill}
            </div>
          </div>
          <div class="mesh-node-body">
            <div class="mesh-node-row">
              <span class="mesh-node-label">ID</span>
              <span class="mesh-node-value">${id}</span>
            </div>
            <div class="mesh-node-row">
              <span class="mesh-node-label">IP</span>
              <span class="mesh-node-value">${ip || "—"}</span>
            </div>
            <div class="mesh-node-row">
              <span class="mesh-node-label">Last seen</span>
              <span class="mesh-node-value">${lastSeen}</span>
            </div>
          </div>
          <div class="mesh-node-footer">
            <div class="mesh-node-actions">
              ${actions.join("")}
            </div>
            <div class="mesh-node-launch">
              ${launchButtons.join("")}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  listEl.innerHTML = html;
}


async function refreshMeshDirectory() {
  const statusEl = $("mesh-directory-status");
  if (statusEl) {
    statusEl.textContent = "Loading directory…";
  }

  try {
    const res = await fetch("/mesh/directory");
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }

    const data = await res.json();

    // ✅ Cache for multi-node tools
    // NOTE: No "let" — we use the global declaration already at the top of the file
    meshDirectoryCache = data;

    // Expect shape: { host: {...}, devices: [...] }
    renderMeshDirectory(data);

    debugLog("mesh", "info", "Loaded mesh directory");
  } catch (err) {
    console.error("Mesh directory fetch failed:", err);

    if (statusEl) {
      statusEl.textContent =
        "Unable to load directory (host-only, or not configured).";
    }

    // Still render an empty directory so the Host UI remains visible when appropriate
    renderMeshDirectory(null);
  }
}


async function refreshMeshNodeAndMaybeDirectory() {
  try {
    // Prefer MeshService so every module shares the same caches
    const data = window.MeshService ? await window.MeshService.fetchNode({ force: true }) : await (await fetch("/mesh/node")).json();
    currentNodeConfig = data;
    window.currentNodeConfig = data;
    renderMeshNode(data);

    // Try to refresh directory even on non-host (best-effort) so header + Chat can reflect presence
    let dir = null;
    try {
      if (window.MeshService) dir = await window.MeshService.fetchDirectory({ force: true });
      else {
        const dres = await fetch("/mesh/directory");
        if (dres.ok) dir = await dres.json();
      }
    } catch {}

    if (dir) {
      meshDirectoryCache = dir;
      window.meshDirectoryCache = dir;
    }

    const isHost = data && (data.is_host || data.role === "host");
    if (isHost) {
      await refreshMeshDirectory();
    } else {
      // Host directory UI stays host-only; presence belongs in TLI Chat
      renderMeshDirectory(null);
      setInlineStatus(
        "mesh-directory-status",
        "Presence is shown in TLI Chat. This panel is for Host administration.",
        "muted"
      );
    }

    // Sync context tags everywhere
    try { syncMeshContextTags(); } catch {}
  } catch (err) {
    console.error("Mesh node fetch failed:", err);
    renderMeshNode(null);
    setInlineStatus(
      "mesh-directory-status",
      "Unable to load node info: " + err.message,
      "error"
    );
    showToast("Mesh node unreachable.", "error");
    throw err; // Let callers show their own UX if they want.
  }
}

async function performMeshPing(deviceId) {
  if (!deviceId) return;
  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/ping`,
      { method: "POST", headers: { "Accept": "application/json" } }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json();
    const ping = data.ping || {};

    const summary = [
      ping.node_name || ping.node_id || "Unknown node",
      ping.hostname ? `Host: ${ping.hostname}` : "",
      ping.os ? `OS: ${ping.os}` : "",
      ping.ts ? `Time: ${ping.ts}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    showToast("Ping successful:\n\n" + summary);
    debugLog("mesh", "info", `Ping ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh ping failed:", err);
    showToast("Ping failed: " + err.message);
  }
}
async function performMeshInfo(deviceId) {
  if (!deviceId) return;
  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/info`,
      { method: "POST", headers: { Accept: "application/json" } }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json();
    const info = data.info || {};
    const node = info.node || {};
    const sys  = info.system || {};

    const lines = [];

    // Node identity
    lines.push(node.node_name || node.node_id || "Unknown node");
    if (node.role)        lines.push(`Role: ${node.role}`);
    if (node.mesh_status) lines.push(`Mesh: ${node.mesh_status}`);
    if (node.host_name)   lines.push(`Host: ${node.host_name}`);
    if (node.host_address)lines.push(`Host address: ${node.host_address}`);

    lines.push(""); // spacer

    // System snapshot
    if (sys.hostname) lines.push(`Hostname: ${sys.hostname}`);
    if (sys.platform) lines.push(`OS: ${sys.platform}`);
    if (sys.cpu_count) lines.push(`CPU cores: ${sys.cpu_count}`);

    const mem = sys.memory || {};
    if (Object.keys(mem).length) {
      lines.push(
        `RAM: ${mem.used_gb}/${mem.total_gb} GB (${mem.percent_used}%)`
      );
    }

    const disks = sys.disks || [];
    if (disks.length) {
      const first = disks[0];
      lines.push(
        `Disk: ${first.used_gb}/${first.total_gb} GB (${first.percent_used}%) on ${first.mountpoint}`
      );
    }

    if (sys.timestamp) {
      lines.push("");
      lines.push(`Snapshot at: ${sys.timestamp}`);
    }

    showToast("Node info:\n\n" + lines.join("\n"));
    debugLog("mesh", "info", `Node info ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh node info failed:", err);
    showToast("Node info failed: " + err.message);
  }
}

async function performMeshMaintenanceRefresh(deviceId) {
  if (!deviceId) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/refresh`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    debugLog("mesh", "info", `Maintenance refresh ok for device ${deviceId}`);

    // Optionally show fresh node info afterwards
    try {
      await performMeshInfo(deviceId);
    } catch (err) {
      console.warn("performMeshInfo after refresh failed:", err);
    }

    if (!data || data.ok !== false) {
      showToast("Maintenance: stats refresh requested on this node.");
    }
  } catch (err) {
    console.error("Mesh maintenance refresh failed:", err);
    showToast("Refresh stats failed: " + err.message);
  }
}

async function performMeshMaintenanceCleanTemp(deviceId) {
  if (!deviceId) return;

  const ok = confirm(
    "Run a SAFE temp cleanup on this node?\n\n" +
      "This only touches OS temp folders and TLI cache directories."
  );
  if (!ok) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/clean_temp`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    const nodePayload = data && data.data ? data.data : data;
    const summary = nodePayload.summary || nodePayload.result || nodePayload;

    let msg = "Temp cleanup completed.";

    if (summary && typeof summary === "object") {
      const totalFiles =
        summary.total_files_deleted ??
        summary.total_files_removed ??
        summary.files_deleted ??
        summary.files_removed;

      const totalBytes =
        summary.total_bytes_reclaimed ??
        summary.bytes_reclaimed ??
        summary.bytesRemoved ??
        summary.totalBytesReclaimed;

      const parts = [];

      if (typeof totalFiles === "number") {
        parts.push("Files deleted: " + totalFiles);
      }
      if (typeof totalBytes === "number") {
        parts.push(
          "Bytes reclaimed: " + totalBytes.toLocaleString() + " bytes"
        );
      }

      if (Array.isArray(summary.directories)) {
        parts.push("", "Directories touched:");
        for (const d of summary.directories) {
          if (!d) continue;
          const p = d.path || d.dir || "";
          const f =
            typeof d.files_deleted === "number"
              ? ` (${d.files_deleted} files)`
              : "";
          parts.push("- " + p + f);
        }
      }

      if (parts.length) {
        msg = "Temp cleanup summary:\n\n" + parts.join("\n");
      }
    }

    showToast(msg);
    debugLog("mesh", "info", `Clean temp ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh clean temp failed:", err);
    showToast("Clean temp failed: " + err.message);
  }
}

async function performMeshViewLogs(deviceId) {
  if (!deviceId) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/logs/recent?limit=100`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    const nodePayload = data && data.data ? data.data : data;
    const entries = nodePayload.entries || nodePayload.logs || nodePayload;

    let text = "";

    if (Array.isArray(entries)) {
      text = entries
        .map((entry) => {
          if (!entry) return "";
          if (typeof entry === "string") return entry;

          const ts = entry.ts || entry.timestamp || entry.time || "";
          const level = entry.level || entry.severity || "";
          const msg =
            entry.message ||
            entry.msg ||
            (entry.raw ? entry.raw : JSON.stringify(entry));

          if (ts || level) {
            return `[${ts}${level ? " " + level : ""}] ${msg}`;
          }
          return msg;
        })
        .filter(Boolean)
        .join("\n");
    } else if (typeof entries === "string") {
      text = entries;
    } else if (entries && typeof entries === "object") {
      text = JSON.stringify(entries, null, 2);
    }

    if (!text) {
      text = "No recent logs returned.";
    }

    if (text.length > 4000) {
      text = text.slice(0, 4000) + "\n\n… (truncated)";
    }

    showToast("Recent Node Agent logs:\n\n" + text);
    debugLog("mesh", "info", `Viewed logs for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh view logs failed:", err);
    showToast("View logs failed: " + err.message);
  }
}

async function performMeshMaintenanceRefresh(deviceId) {
  if (!deviceId) return;
  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/refresh`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    // We don't depend on a specific shape; just log and show a small confirmation.
    const data = await res.json().catch(() => ({}));
    debugLog(
      "mesh",
      "info",
      `Maintenance refresh ok for device ${deviceId}`,
    );

    // Optionally re-run node info so you see fresh stats.
    try {
      await performMeshInfo(deviceId);
    } catch {
      // If info fails, ignore; the refresh itself already happened.
    }

    if (!data || data.ok !== false) {
      showToast("Maintenance: stats refresh requested on this node.");
    }
  } catch (err) {
    console.error("Mesh maintenance refresh failed:", err);
    showToast("Refresh stats failed: " + err.message);
  }
}

async function performMeshMaintenanceCleanTemp(deviceId) {
  if (!deviceId) return;

  const ok = confirm(
    "Run a SAFE temp cleanup on this node?\n\n" +
      "This only touches OS temp folders and TLI cache directories."
  );
  if (!ok) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/clean_temp`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json().catch(() => ({}));
    const summary = data.summary || data.result || data;

    let msg = "Temp cleanup completed.";

    if (summary && typeof summary === "object") {
      const totalFiles =
        summary.total_files_removed ??
        summary.totalFilesRemoved ??
        summary.files_removed ??
        summary.filesRemoved;

      const totalBytes =
        summary.total_bytes_reclaimed ??
        summary.totalBytesReclaimed ??
        summary.bytes_reclaimed ??
        summary.bytesReclaimed;

      const parts = [];

      if (typeof totalFiles === "number") {
        parts.push(`Files removed: ${totalFiles}`);
      }
      if (typeof totalBytes === "number") {
        parts.push(
          `Bytes reclaimed: ${totalBytes.toLocaleString()} bytes`
        );
      }

      if (Array.isArray(summary.directories)) {
        parts.push(
          "",
          "Directories touched:",
          ...summary.directories.map((d) => {
            const p = d.path || d.dir || "";
            const f =
              typeof d.files_removed === "number"
                ? ` (${d.files_removed} files)`
                : "";
            return `- ${p}${f}`;
          })
        );
      }

      if (parts.length) {
        msg = "Temp cleanup summary:\n\n" + parts.join("\n");
      }
    }

    showToast(msg);
    debugLog("mesh", "info", `Clean temp ok for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh clean temp failed:", err);
    showToast("Clean temp failed: " + err.message);
  }
}

async function performMeshViewLogs(deviceId) {
  if (!deviceId) return;

  try {
    const res = await fetch(
      `/mesh/directory/${encodeURIComponent(deviceId)}/logs/recent?limit=100`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    const data = await res.json().catch(() => ({}));
    const payload = data.logs || data.entries || data.result || data;

    let text = "";

    if (Array.isArray(payload)) {
      text = payload
        .map((entry) => {
          if (!entry) return "";
          if (typeof entry === "string") return entry;

          const ts = entry.ts || entry.timestamp || entry.time || "";
          const level = entry.level || "";
          const msg =
            entry.message ||
            entry.msg ||
            (entry.extra ? JSON.stringify(entry.extra) : JSON.stringify(entry));

          if (ts || level) {
            return `[${ts}${level ? " " + level : ""}] ${msg}`;
          }
          return msg;
        })
        .filter(Boolean)
        .join("\n");
    } else if (typeof payload === "string") {
      text = payload;
    } else if (payload && typeof payload === "object") {
      text = JSON.stringify(payload, null, 2);
    }

    if (!text) {
      text = "No recent logs returned.";
    }

    if (text.length > 4000) {
      text = text.slice(0, 4000) + "\n\n… (truncated)";
    }

    showToast("Recent Node Agent logs:\n\n" + text);
    debugLog("mesh", "info", `Viewed logs for device ${deviceId}`);
  } catch (err) {
    console.error("Mesh view logs failed:", err);
    showToast("View logs failed: " + err.message);
  }
}

async function performMeshAction(deviceId, action) {
  if (!deviceId || !action) return;
  try {
    const res = await fetch(`/mesh/directory/${encodeURIComponent(deviceId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }
    await refreshMeshDirectory();
    debugLog("mesh", "info", `Applied action ${action} to device ${deviceId}`);
  } catch (err) {
    console.error("Mesh action failed:", err);
    showToast("Mesh action failed: " + err.message);
  }
}
// ---------- MESH JOIN HELPERS (node side) ----------

// Keep track of the polling timer for /mesh/join_status so we don't double-poll
let meshJoinPollTimer = null;

// Update the status line under the "Join Host" input
function updateMeshJoinStatus(text) {
  const el = $("mesh-join-status");
  if (el) {
    el.textContent = text;
  }
}

async function pollMeshJoinStatus() {
  // avoid double polling
  if (meshJoinPollTimer) {
    clearTimeout(meshJoinPollTimer);
    meshJoinPollTimer = null;
  }

  try {
    const res = await fetch("/mesh/join_status", {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error("HTTP " + res.status + (txt ? " · " + txt : ""));
    }

    const data = await res.json();
    const meshStatus = (data.mesh_status || "pending").toLowerCase();

    if (meshStatus === "pending") {
      updateMeshJoinStatus("Join request pending on host…");
      // keep polling every 5 seconds
      meshJoinPollTimer = setTimeout(pollMeshJoinStatus, 5000);
    } else if (meshStatus === "approved") {
      updateMeshJoinStatus(
        "Joined mesh. Host: " + (data.host_address || "(unknown)")
      );
      // refresh node + directory so UI flips from Standalone → Member
      try {
        if (typeof refreshMeshNodeAndMaybeDirectory === "function") {
          refreshMeshNodeAndMaybeDirectory();
        }
      } catch (e) {
        console.warn("refreshMeshNodeAndMaybeDirectory after join:", e);
      }
    } else if (meshStatus === "blocked") {
      updateMeshJoinStatus("Host blocked this device from joining.");
    } else if (meshStatus === "removed") {
      updateMeshJoinStatus("Removed from mesh. This node is now standalone again.");

      // 🔁 NEW: auto-refresh the node card so Role/Join mode/Host address
      // instantly flip back to Standalone with no manual refresh.
      try {
        if (typeof refreshMeshNodeAndMaybeDirectory === "function") {
          refreshMeshNodeAndMaybeDirectory();
        }
      } catch (e) {
        console.warn("refreshMeshNodeAndMaybeDirectory after removal:", e);
      }
    } else {
      updateMeshJoinStatus("Join status: " + meshStatus);
    }
  } catch (err) {
  console.error("[MESH] join_status error:", err);
  const msg = "Join status error: " + err.message;
  updateMeshJoinStatus(msg);
  showToast(msg, "error");
}

}


async function requestMeshJoin(hostAddress) {
 if (!addr) {
  const msg = "Enter the Host address first (e.g. 192.168.x.xxx:8000)"
  updateMeshJoinStatus(msg);
  showToast(msg, "error");
  return;
}

  updateMeshJoinStatus("Sending join request to " + addr + "…");
  debugLog("mesh", "POST /mesh/join_request host=" + addr);

  try {
    const res = await fetch("/mesh/join_request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host_address: addr })
    });

    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j.detail || "";
      } catch {
        detail = await res.text().catch(() => "");
      }
      throw new Error(detail || ("HTTP " + res.status));
    }

    const data = await res.json().catch(() => ({}));
    const meshStatus = (data.mesh_status || "pending").toLowerCase();

    if (meshStatus === "pending") {
      updateMeshJoinStatus(
        "Join request sent to " + addr + ". Waiting for host approval…"
      );
      // start polling host for status
      pollMeshJoinStatus();
    } else if (meshStatus === "approved") {
      updateMeshJoinStatus(
        "Joined mesh. Host: " + (data.host_address || addr)
      );
      if (typeof refreshMeshNodeAndMaybeDirectory === "function") {
        refreshMeshNodeAndMaybeDirectory();
      }
    } else if (meshStatus === "blocked") {
      updateMeshJoinStatus("Host blocked this device from joining.");
    } else {
      updateMeshJoinStatus("Join request result: " + meshStatus);
    }
  } catch (err) {
  console.error("[MESH] join_request failed:", err);
  const msg = "Join request failed: " + err.message;
  updateMeshJoinStatus(msg);
  showToast(msg, "error");
}

}

function setupMeshPanel() {
  const refreshBtn    = $("mesh-node-refresh-btn");
  const listEl        = $("mesh-directory-list");
  const joinBtn       = $("mesh-join-btn");
  const hostInput     = $("mesh-join-host-address");
  const becomeHostBtn = $("mesh-become-host-btn");
  const killAllBtn    = $("mesh-kill-all-btn");  // Kill Switch button

  // Multi-node tools controls
  const multiRunBtn  = $("mesh-multi-run-btn");
  const multiSelect  = $("mesh-multi-action-select");
  const multiStatus  = $("mesh-multi-status");

  // Local diagnostics on THIS node
  const diagBtn = $("mesh-node-diagnostics-btn");
  if (diagBtn) {
    diagBtn.addEventListener("click", handleLocalDiagnosticsClick);
  }

// Refresh node + directory (host + directory panel)
if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    withButtonBusy(refreshBtn, "🔄 Refreshing…", async () => {
      setInlineStatus(
        "mesh-directory-status",
        "Refreshing mesh node & directory…",
        "muted"
      );
      try {
        await refreshMeshNodeAndMaybeDirectory();
        setInlineStatus(
          "mesh-directory-status",
          "Mesh directory up to date.",
          "ok"
        );
        showToast("Mesh node refreshed.", "ok");
      } catch (err) {
        console.error("Mesh refresh failed:", err);
        setInlineStatus(
          "mesh-directory-status",
          "Failed to refresh mesh: " + err.message,
          "error"
        );
        showToast("Mesh refresh failed: " + err.message, "error");
      }
    });
  });
}

  // Join host flow (member-side)
  if (joinBtn && hostInput) {
    joinBtn.addEventListener("click", () => {
      const addr = hostInput.value || "";
      requestMeshJoin(addr);
    });
  }

  // Become host
  if (becomeHostBtn) {
    becomeHostBtn.addEventListener("click", async () => {
      const ok = confirm("Enable Mesh Coordinator on this node?\n\nThis node will accept join requests from peers and relay agent heartbeats. Only one node on your LAN should be the coordinator.");
      if (!ok) return;
      try {
        const res = await fetch("/mesh/node/become_host", { method: "POST" });
        if (!res.ok) throw new Error("Failed to become coordinator: " + res.status);
        showToast("This node is now the Mesh Coordinator.");
        await refreshMeshNodeAndMaybeDirectory();
      } catch (err) {
        showToast("Coordinator activation failed: " + err);
      }
    });
  }

  // Kill Switch – disconnect ALL nodes from this host
  if (killAllBtn) {
    killAllBtn.addEventListener("click", async () => {
      const ok = confirm(
        "Disconnect ALL nodes from this host?\n\nThey will need to re-join."
      );
      if (!ok) return;

      try {
        const res = await fetch("/mesh/kill_all", { method: "POST" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || ("HTTP " + res.status));
        }
        const data  = await res.json().catch(() => ({}));
        const count = data.disconnected ?? "0";
        debugLog("mesh", "info", "Kill switch disconnected " + count + " nodes.");
        showToast("Kill Switch activated. Disconnected " + count + " node(s).");
        refreshMeshNodeAndMaybeDirectory();
      } catch (err) {
        console.error("[MESH] kill_all failed:", err);
        showToast("Kill Switch failed: " + (err.message || err));
      }
    });
  }

  // Multi-node tools: run action on all allowed nodes
if (multiRunBtn && multiSelect) {
  multiRunBtn.addEventListener("click", () => {
    const action = multiSelect.value;
    if (!action) {
      const msg = "Pick an action before running multi-node tools.";
      multiStatus.textContent = msg;
      showToast(msg, "error");
      return;
    }

    withButtonBusy(multiRunBtn, "Running…", async () => {
      multiStatus.textContent = "Running " + action + " across allowed nodes…";

      try {
        const directory = meshDirectoryCache;
        if (!directory || !Array.isArray(directory.devices)) {
          multiStatus.textContent =
            "No directory loaded yet. Refresh as Host first.";
          showToast("Load mesh directory as Host before multi-run.", "error");
          return;
        }

        const allowed = directory.devices.filter((d) => d.allowed !== false);
        if (!allowed.length) {
          multiStatus.textContent = "No allowed nodes to run this on.";
          showToast("No allowed nodes in directory.", "error");
          return;
        }

        let okCount = 0;
        let failCount = 0;

        for (const dev of allowed) {
          const id = dev.device_id;
          try {
            if (action === "ping") {
              await performMeshPing(id);
            } else if (action === "refresh") {
              await performMeshMaintenanceRefresh(id);
            }
            okCount++;
          } catch (err) {
            console.warn("Multi-node action failed for", id, err);
            failCount++;
          }
        }

        multiStatus.textContent =
          `Action "${action}" completed. ` +
          `${okCount} node(s) ok, ${failCount} failed.`;

        const toastKind = failCount ? "error" : "ok";
        showToast(
          `Multi-node ${action} finished: ${okCount} ok, ${failCount} failed.`,
          toastKind
        );
      } catch (err) {
        console.error("Multi-node action failed:", err);
        multiStatus.textContent = "Multi-node action failed: " + err.message;
        showToast("Multi-node action failed: " + err.message, "error");
      }
    });
  });
}

  // Host directory button actions (allow / block / remove) + launcher buttons
  if (listEl) {
    listEl.addEventListener("click", (ev) => {
      // 0) Node info
      const infoBtn = ev.target.closest("[data-mesh-info]");
      if (infoBtn) {
        const deviceId = infoBtn.getAttribute("data-mesh-info");
        if (deviceId) performMeshInfo(deviceId);
        return;
      }

      // 1) Agent Ping
      const pingBtn = ev.target.closest("[data-mesh-ping]");
      if (pingBtn) {
        const deviceId = pingBtn.getAttribute("data-mesh-ping");
        if (deviceId) performMeshPing(deviceId);
        return;
      }

      // 2) Maintenance hooks (Node Agent v0.3)
      const maintBtn = ev.target.closest("[data-mesh-maint][data-device-id]");
      if (maintBtn) {
        const deviceId = maintBtn.getAttribute("data-device-id");
        const kind     = maintBtn.getAttribute("data-mesh-maint");
        if (!deviceId || !kind) return;

        if (kind === "refresh") {
          performMeshMaintenanceRefresh(deviceId);
        } else if (kind === "clean_temp") {
          performMeshMaintenanceCleanTemp(deviceId);
        } else if (kind === "logs") {
          performMeshViewLogs(deviceId);
        }
        return;
      }

      // 3) Multi-node launcher: open node's own TLI console
      const launchBtn = ev.target.closest("[data-mesh-open][data-ip]");
      if (launchBtn) {
        const ip     = launchBtn.getAttribute("data-ip");
        const target = launchBtn.getAttribute("data-mesh-open"); // "visualizer" or "tools"
        if (!ip) return;

        let panelParam = "";
        if (target === "visualizer") {
          panelParam = "visualizer";
        } else if (target === "tools") {
          panelParam = "tools";
        }

        const url = panelParam
          ? `http://${ip}:8000/?panel=${encodeURIComponent(panelParam)}`
          : `http://${ip}:8000/`;

        window.open(url, "_blank");
        return;
      }

      // 4) Host management actions (allow / block / remove)
      const btn = ev.target.closest("[data-mesh-action][data-device-id]");
      if (!btn) return;
      const action   = btn.getAttribute("data-mesh-action");
      const deviceId = btn.getAttribute("data-device-id");
      if (!action || !deviceId) return;

      if (action === "remove") {
        const ok = confirm(
          "Remove this node from the host directory? It can re-request later."
        );
        if (!ok) return;
      }

      performMeshAction(deviceId, action);
    });
  }

  // On load, if this node is already in a join flow, reflect that
  try {
    pollMeshJoinStatus();
  } catch (e) {
    console.warn("Initial pollMeshJoinStatus failed:", e);
  }

  // Delay initial mesh load so it doesn't compete with the page-load burst
  setTimeout(refreshMeshNodeAndMaybeDirectory, 3000);

  // Periodic refresh so the host sees join requests / last-seen updates
  setInterval(() => {
    refreshMeshNodeAndMaybeDirectory();
  }, 60000); // every 60 seconds
}



// One-time wiring for USB buttons → Files / Scripts panels
let usbActionsWired = false;

function ensureUsbActionHandlers() {
  if (usbActionsWired) return;
  const listEl = $("devices-usb-list");
  if (!listEl) return;

  listEl.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-usb-path][data-usb-action]");
    if (!btn) return;

    const path   = btn.getAttribute("data-usb-path") || "";
    const action = btn.getAttribute("data-usb-action") || "";
    if (!path) return;

    if (action === "files-target") {
      // Push this USB path into the File Organizer root and jump to Files
      const rootInput = $("filesRootInput");
      if (rootInput) {
        rootInput.value = path;
        filesSetStatus(`Using ${path} as File Organizer root (from USB Snapshot).`);
      }
      switchPanel("panel-files");
    } else if (action === "ai-storage") {
      // Set this drive as AI model storage location
      const aiPath = path.replace(/[\\/]+$/, "") + (path.includes("/") ? "/TLI_Models" : "\\TLI_Models");
      const btn = event.target.closest("[data-usb-action]");
      const origText = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
      try {
        const r = await fetch("/api/ai/storage/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: aiPath }),
        });
        const d = await r.json();
        if (d.ok) {
          if (btn) { btn.textContent = "Set ✓"; btn.classList.add("active"); }
          // Open model manager so user can see + confirm the save destination
          if (typeof window.tliOpenModelManagerModal === "function") {
            setTimeout(() => {
              window.tliOpenModelManagerModal();
              // Refresh the save-to picker inside the now-open modal
              if (typeof window._tliRefreshSaveToPicker === "function") {
                setTimeout(window._tliRefreshSaveToPicker, 150);
              }
            }, 300);
          }
        } else {
          if (typeof showToast === "function") showToast(d.detail || "Failed to set storage location.", "warn");
          if (btn) { btn.disabled = false; btn.textContent = origText; }
        }
      } catch (e) {
        if (typeof showToast === "function") showToast("Error setting storage location.", "error");
        if (btn) { btn.disabled = false; btn.textContent = origText; }
      }
    } else if (action === "scripts-backup") {
      // Prefill Scripts panel with a backup-script request for this drive
      const promptBox = $("scripts-prompt");
      if (promptBox) {
        const prompt =
          `Write a production-ready PowerShell backup script for this USB drive mounted at "${path}".\n\n` +
          `Requirements:\n` +
          `- Treat "${path}" as the backup destination.\n` +
          `- Back up my important user folders (Documents, Desktop, Pictures).\n` +
          `- Use timestamped subfolders for each backup run.\n` +
          `- Only copy new or changed files (incremental behaviour).\n` +
          `- Include basic logging and safety checks so a non-expert can use it.\n`;
        promptBox.value = prompt;
        promptBox.focus();
        promptBox.selectionStart = promptBox.selectionEnd = promptBox.value.length;
      }
      switchPanel("panel-scripts");
    }
  });

  usbActionsWired = true;
}

async function refreshUsbDevices() {
  const listEl  = $("devices-usb-list");
  const otherEl = $("devices-usb-other");
  if (!listEl) return;

  listEl.innerHTML = '<p class="small-meta">Scanning…</p>';

  try {
    const res = await fetch("/devices/usb");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const devices = data.devices || [];

    // Every device returned is already a USB storage drive with a mount path.
    // Filter defensively in case older backend sends mixed results.
    const drives = devices.filter(d => {
      const { isMassStorage, mountPath } = getUsbStorageInfo(d);
      return (d.is_storage || isMassStorage) && (d.mount_path || mountPath);
    });
    const otherCount = devices.length - drives.length;

    if (!drives.length) {
      listEl.innerHTML = `
        <div class="tli-empty-mini">
          <div class="tli-empty-title">No USB storage detected</div>
          <div class="tli-empty-sub">${devices.length ? `${devices.length} non-storage USB devices present (hubs, controllers, etc.) — nothing actionable.` : "Plug in a USB drive and click Refresh."}</div>
        </div>`;
      if (otherEl) otherEl.style.display = "none";
      debugLog("info", "GET /devices/usb OK: no actionable drives");
      return;
    }

    // Render drive tiles
    listEl.innerHTML = drives.map(dev => {
      const mountPath = dev.mount_path || getUsbStorageInfo(dev).mountPath || "";
      const name = dev.name || dev.product || "USB Drive";
      const label = mountPath.replace(/\\$/, "");
      return `
        <div class="usb-drive-tile">
          <div class="usb-drive-icon">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="2" width="12" height="16" rx="2"/><circle cx="10" cy="14" r="1"/><path d="M7 6h6M7 9h4"/></svg>
          </div>
          <div class="usb-drive-info">
            <div class="usb-drive-name">${name}</div>
            <div class="usb-drive-path">${label}</div>
          </div>
          <div class="usb-drive-actions">
            <button class="pill-btn ghost btn-xs" data-usb-path="${mountPath}" data-usb-action="files-target">Open in Files</button>
            <button class="pill-btn ghost btn-xs" data-usb-path="${mountPath}" data-usb-action="scripts-backup">Backup script</button>
            <button class="pill-btn ghost btn-xs" data-usb-path="${mountPath}" data-usb-action="ai-storage">Use for AI models</button>
          </div>
        </div>`;
    }).join("");

    // Show "N other USB devices" footnote
    if (otherEl) {
      if (otherCount > 0) {
        otherEl.textContent = `${otherCount} other USB device${otherCount === 1 ? "" : "s"} present (hubs, controllers — not shown).`;
        otherEl.style.display = "";
      } else {
        otherEl.style.display = "none";
      }
    }

    ensureUsbActionHandlers();
    debugLog("info", `GET /devices/usb OK: ${drives.length} drives, ${otherCount} other`);
  } catch (err) {
    console.error("USB scan failed:", err);
    listEl.innerHTML = `<div class="usb-error">Error scanning USB devices: ${err.message}</div>`;
    debugLog("error", "GET /devices/usb failed: " + err.message);
  }
}

async function loadUsbRawOutput() {
  const statusEl   = $("devices-usb-status");
  const summaryEl  = $("devices-usb-summary");
  const rawDetails = $("devices-usb-raw");
  const rawPre     = $("devices-usb-raw-pre");

  if (!rawPre) {
    console.warn("devices-usb-raw-pre element not found.");
    return;
  }

  if (statusEl)  statusEl.textContent  = "Loading raw output…";
  if (summaryEl) summaryEl.textContent =
    "Fetching raw OS USB output from the backend (read-only).";

  rawPre.textContent = "Loading raw OS USB output…";

  try {
    const res = await fetch("/devices/usb/raw");
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || ("HTTP " + res.status));
    }

    const data = await res.json();
    const text = data.raw || JSON.stringify(data, null, 2);

    rawPre.textContent = text;

    if (rawDetails) {
      rawDetails.style.display = "block";
      rawDetails.open = true; // auto-expand <details>
    }
    if (statusEl) statusEl.textContent = "Raw OS output loaded";

    debugLog("info", "GET /devices/usb/raw OK");
  } catch (err) {
    console.error("USB raw output failed:", err);
    rawPre.textContent =
      "Error loading raw USB output: " + err.message;
    if (statusEl)  statusEl.textContent  = "Raw output error";
    if (summaryEl) summaryEl.textContent = "Raw output request failed.";
    debugLog("error", "GET /devices/usb/raw failed: " + err.message);
  }
}
async function refreshLanDevices() {
  const statusEl   = $("lan-devices-status");
  const summaryEl  = $("lan-devices-summary");
  const ifaceBox   = $("lan-devices-interfaces");
  const arpBox     = $("lan-devices-arp");

  if (!statusEl || !summaryEl || !ifaceBox || !arpBox) {
    console.warn("LAN devices panel elements missing; skipping scan.");
    return;
  }

  // Loading state
  statusEl.textContent  = "Scanning…";
  summaryEl.textContent = "Checking local interfaces and ARP table…";
  ifaceBox.innerHTML    = "";
  arpBox.innerHTML      = "";

  try {
    const res = await fetch("/devices/scan");
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    const data = await res.json();

    const interfaces = data.interfaces || {};
    const arpTable   = data.arp_table || [];

    // ---- Render interfaces on this node ----
    const ifaceNames = Object.keys(interfaces || {});
    if (ifaceNames.length) {
      const frag = document.createDocumentFragment();

      ifaceNames.forEach((name) => {
        const info = interfaces[name] || {};
        const ip   = info.ipv4 || info.ip || "";
        const gw   = info.gateway || "";
        const desc = info.description || info.friendly_name || "";

        const card = document.createElement("div");
        card.className = "lan-device-card";
        card.innerHTML = `
          <div class="lan-device-title">${name}${ip ? ` — ${ip}` : ""}</div>
          <div class="lan-device-meta">
            ${desc ? `<span>${desc}</span>` : ""}
            ${gw ? `<span>Gateway: ${gw}</span>` : ""}
          </div>
        `;
        frag.appendChild(card);
      });

      ifaceBox.innerHTML = "";
      const title = document.createElement("div");
      title.className = "lan-section-title";
      title.textContent = "This node’s network interfaces";
      ifaceBox.appendChild(title);
      ifaceBox.appendChild(frag);
    } else {
      ifaceBox.innerHTML =
        `<p class="hint">No network interfaces reported by the backend.</p>`;
    }

    // ---- Render ARP peers ----
    if (arpTable.length) {
      const frag2 = document.createDocumentFragment();

arpTable.forEach((entry) => {
  const ip     = entry.ip || "Unknown IP";
  const mac    = entry.mac || "Unknown MAC";
  const iface  = entry.interface || entry.iface || "";
  const vendor = entry.vendor || "";
  const src    = entry.source || "";
  const mesh   = entry.mesh_device || null;

  // Build an optional TLI-node line if this IP belongs to a Mesh device
  let meshLine = "";
  let cardClass = "lan-device-card";
  if (mesh) {
    cardClass += " mesh-node";

    const parts = [];
    if (mesh.display_name) {
      parts.push(mesh.display_name);
    } else if (mesh.device_id) {
      parts.push(mesh.device_id);
    }

    if (mesh.is_host) {
      parts.push("Host");
    }
    if (mesh.status) {
      const s = String(mesh.status);
      const niceStatus = s.charAt(0).toUpperCase() + s.slice(1);
      parts.push(niceStatus);
    }

    const label = parts.join(" · ");
    meshLine = `<span>TLI node: ${label}</span>`;
  }

  const card = document.createElement("div");
  card.className = cardClass;
  card.innerHTML = `
    <div class="lan-device-title">${ip}${iface ? ` · ${iface}` : ""}</div>
    <div class="lan-device-meta">
      <span>MAC: ${mac}</span>
      ${vendor ? `<span>${vendor}</span>` : ""}
      ${src ? `<span>${src}</span>` : ""}
      ${meshLine}
    </div>
  `;
  frag2.appendChild(card);
});

      arpBox.innerHTML = "";
      const title2 = document.createElement("div");
      title2.className = "lan-section-title";
      title2.textContent = "LAN peers (ARP table)";
      arpBox.appendChild(title2);
      arpBox.appendChild(frag2);
    } else {
      arpBox.innerHTML =
        `<p class="hint">No ARP entries found. Some systems hide ARP details or require admin rights.</p>`;
    }

    const ifaceCount = ifaceNames.length;
    const arpCount   = arpTable.length;

    statusEl.textContent = "Scan complete";
    summaryEl.textContent =
      `${ifaceCount} interface${ifaceCount === 1 ? "" : "s"}, ` +
      `${arpCount} ARP entr${arpCount === 1 ? "y" : "ies"}.`;

    debugLog("info", "GET /devices/scan OK.");
  } catch (err) {
    console.error("LAN devices scan failed:", err);
    statusEl.textContent  = "Scan failed";
    summaryEl.textContent = "Could not scan LAN devices.";
    ifaceBox.innerHTML =
      `<p class="usb-error">Error scanning LAN devices: ${err.message}</p>`;
    arpBox.innerHTML = "";
    debugLog("error", "GET /devices/scan failed: " + err.message);
  }
}

// Optional shim so any old code calling refreshUSBList() still works
function refreshUSBList() {
  return refreshUsbDevices();
}


