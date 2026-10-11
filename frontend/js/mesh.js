// ---------- Mesh / Nodes panel ----------
let meshUiEpoch = 0, meshUiLocked = false;
const meshEscape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const meshUiCurrent = token => !meshUiLocked && token === meshUiEpoch && !document.hidden;
window.addEventListener('tli-session-locked', () => {
  meshUiLocked = true; meshUiEpoch++;
  if (meshJoinPollTimer) clearTimeout(meshJoinPollTimer);
  meshJoinPollTimer = null; meshDirectoryCache = null;
  if (typeof currentNodeConfig !== 'undefined') currentNodeConfig = null;
  const list = document.getElementById('mesh-directory-list'); if (list) list.replaceChildren();
  updateMeshJoinStatus('Unlock TLI to view this connection.');
});
window.addEventListener('tli-session-unlocked', () => { meshUiLocked = false; meshUiEpoch++; });
window.addEventListener('pagehide', () => { meshUiEpoch++; if (meshJoinPollTimer) clearTimeout(meshJoinPollTimer); meshJoinPollTimer = null; });


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
  window.TLIPeerTrust?.renderDirectory(directory);
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
    // An unavailable address remains visible; it grants no ability to contact the peer.

    const identity = dev.device_id || dev.node_id;
    if (!identity || seenIps.has(identity)) continue;
    seenIps.add(identity);

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
      if (device.peer_profile === "inference_node" && state === "allowed" && device.trust_state === "verified") {
        return { key: "unknown", label: "Compute only" };
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
      const id   = meshEscape(dev.device_id || dev.node_id || "unknown");
      const ip   = meshEscape(dev.ip || "");
      const name = meshEscape(dev.display_name || dev.node_name || dev.device_name || id);
      const state    = (dev.status || "pending").toLowerCase();
      const verified = dev.trust_state === "verified" && state === "allowed";
      const inferenceOnly = dev.peer_profile === "inference_node";
      const lastSeen = meshEscape(dev.last_seen || "—");
      const isSelf   = dev.is_self || dev.self || false;
      const health   = computeNodeHealth(dev);

      let stateLabel = meshEscape(state);
      if (state === "pending") stateLabel = "Pending approval";
      if (state === "allowed") stateLabel = verified ? "Reviewed identity" : "Trust review required";
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
        if (!verified) {
          actions.push(
            `<button class="btn btn-primary" data-mesh-action="allow" data-device-id="${id}">Review trust</button>`
          );
        }
        if (state === "pending" || state === "allowed") {
          actions.push(
            `<button class="btn btn-ghost" data-mesh-action="block" data-device-id="${id}">Revoke trust</button>`
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
      if (ip && verified && !inferenceOnly) {
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
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="clean_temp" data-device-id="${id}">Review Free Space</button>`
        );
        launchButtons.push(
          `<button class="btn btn-ghost mesh-launch-btn" data-mesh-maint="logs" data-device-id="${id}">View logs</button>`
        );
      }

      // Deep-links into the node's own console (only when Allowed)
      if (ip && verified && !inferenceOnly) {
        launchButtons.push(
          `<button class="btn btn-primary" data-mesh-open="visualizer" data-device-id="${id}" data-ip="${ip}">Open Free Space</button>`
        );
        launchButtons.push(
          `<button class="btn btn-primary" data-mesh-open="tools" data-device-id="${id}" data-ip="${ip}">Open Tools</button>`
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
              <span class="mesh-node-label">${inferenceOnly ? "Availability" : "Last seen"}</span>
              <span class="mesh-node-value">${inferenceOnly ? (verified ? "Checked when you check models in Ask TLI." : "Review inference permission before checking models.") : lastSeen}</span>
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
  if (meshUiLocked || document.hidden) return false;
  const epoch = meshUiEpoch;
  const statusEl = $("mesh-directory-status");
  if (statusEl) {
    statusEl.textContent = "Loading directory…";
  }

  try {
    const res = await fetch("/mesh/directory");
    if (res.status === 401 || !meshUiCurrent(epoch)) return false;
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }

    if (res.status === 401) return false;
    const data = await res.json();
    if (!meshUiCurrent(epoch)) return false;

    // ✅ Cache for multi-node tools
    // NOTE: No "let" — we use the global declaration already at the top of the file
    meshDirectoryCache = data;

    // Expect shape: { host: {...}, devices: [...] }
    renderMeshDirectory(data);

    debugLog("mesh", "info", "Loaded mesh directory");
    return true;
  } catch (err) {
    if (!meshUiCurrent(epoch) || /401/.test(String(err.message))) return false;
    console.error("Mesh directory fetch failed:", err);

    if (statusEl) {
      statusEl.textContent =
        "Computer directory unavailable. Previous entries, if any, are retained; their observation times still apply.";
    }

    return false;
  }
}


async function refreshMeshNodeAndMaybeDirectory() {
  if (meshUiLocked || document.hidden) return false;
  const epoch = meshUiEpoch;
  try {
    // Prefer MeshService so every module shares the same caches
    let data;
    if (window.MeshService) data = await window.MeshService.fetchNode({ force: true });
    else {
      const response = await fetch('/mesh/node');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      data = await response.json();
    }
    if (!meshUiCurrent(epoch)) return false;
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

    if (!meshUiCurrent(epoch)) return false;
    if (dir) {
      meshDirectoryCache = dir;
      window.meshDirectoryCache = dir;
    }

    if (dir) renderMeshDirectory(dir);
    else if (await refreshMeshDirectory() === false) return false;

    // Sync context tags everywhere
    try { syncMeshContextTags(); } catch {}
    return true;
  } catch (err) {
    if (!meshUiCurrent(epoch) || /401/.test(String(err.message))) return false;
    console.error("Mesh node fetch failed:", err);
    // Preserve the last reported identity; failure does not mean unconfigured.
    setInlineStatus(
      "mesh-directory-status",
      "Computer info unavailable: " + err.message + ". Previous information, if any, is retained.",
      "error"
    );
    showToast("Mesh node unreachable.", "error");
    // This refresh is also called by timers and navigation without await.
    // Return failure explicitly instead of leaking an unhandled rejection.
    return false;
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
    return true;
  } catch (err) {
    console.error("Mesh ping failed:", err);
    showToast("Ping failed: " + err.message);
    return false;
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
    const node = info.node || info;
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
  if (!deviceId || meshUiLocked) return false;
  const epoch=meshUiEpoch;
  try {
    const response=await fetch(`/mesh/directory/${encodeURIComponent(deviceId)}/maintenance/refresh`,{method:'POST'});
    if(!meshUiCurrent(epoch))return false;
    const data=await response.json();if(!meshUiCurrent(epoch))return false;
    if(!response.ok||!data.ok||data.data?.protocol!=='tli-peer-observation-v1')throw Error(data.detail?.message||'No valid peer observation was received.');
    const observation=data.data, facts=observation.facts;
    const metric=value=>value==null?'Unknown':String(value);
    showToast(observation.host.name+' · '+observation.observed_at+'\nCPU: '+metric(facts.cpu_percent)+'% · RAM: '+metric(facts.ram_percent)+'%\n'+observation.scope);
    return true;
  } catch(error) {if(meshUiCurrent(epoch))showToast('Peer observation unavailable: '+error.message,'error');return false;}
}

function performMeshMaintenanceCleanTemp(deviceId) { return openReviewedPeerConsole(deviceId, "visualizer"); }

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



function performMeshMaintenanceCleanTemp(deviceId) { return openReviewedPeerConsole(deviceId, "visualizer"); }

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
  if (meshUiLocked || document.hidden) return false;
  const epoch = meshUiEpoch;
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

    if (!meshUiCurrent(epoch) || res.status === 401) return;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      if (res.status === 400) {
        let detail;
        try { detail = JSON.parse(txt).detail; } catch {}
        if (detail === "This node is not joined to any host.") {
          updateMeshJoinStatus("Standalone — no host connection configured.");
          return;
        }
      }
      throw new Error("HTTP " + res.status + (txt ? " · " + txt : ""));
    }

    const data = await res.json();
    if (!meshUiCurrent(epoch)) return;
    const meshStatus = (data.mesh_status || "pending").toLowerCase();

    if (meshStatus === "not_joined") {
      updateMeshJoinStatus("Standalone — no host connection configured.");
      return;
    } else if (meshStatus === "pending") {
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
  if (!meshUiCurrent(epoch)) return;
  console.error("[MESH] join_status error:", err);
  const msg = "Join status error: " + err.message;
  updateMeshJoinStatus(msg);
  showToast(msg, "error");
}

}


async function requestMeshJoin(hostAddress) {
 const addr = String(hostAddress || "").trim();
 if (meshUiLocked || document.hidden) return;
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
  window.TLIPeerTrust?.install();
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
        if (await refreshMeshNodeAndMaybeDirectory() === false) return;
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

        const allowed = directory.devices.filter(d => d.status === "allowed" && d.trust_state === "verified" && d.peer_profile !== "inference_node");
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
              if(await performMeshPing(id)===false)throw Error("Ping failed");
            } else if (action === "refresh") {
              if(await performMeshMaintenanceRefresh(id)===false)throw Error("Observation failed");
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

        openReviewedPeerConsole(launchBtn.getAttribute('data-device-id'), panelParam);
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

      if (action === 'allow') { window.TLIPeerTrust.open(); return; }
      if (action === 'block') { window.TLIPeerTrust.revoke(deviceId); return; }
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
const usbEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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

    if (action === "files-target" || action === "space-target") {
      if (window.TLIStorageWorkspace?.prepare) window.TLIStorageWorkspace.prepare({view:action === 'space-target' ? 'space' : 'organize',root:path,source:'usb'});
      else if (typeof showToast === 'function') showToast('Files & Storage is unavailable. Refresh TLI to try again.', 'warn');
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
            <div class="usb-drive-name">${usbEscape(name)}</div>
            <div class="usb-drive-path">${usbEscape(label)}</div>
          </div>
          <div class="usb-drive-actions">
            <button class="pill-btn ghost btn-xs" data-usb-path="${usbEscape(mountPath)}" data-usb-action="files-target">Organize files</button>
            <button class="pill-btn ghost btn-xs" data-usb-path="${usbEscape(mountPath)}" data-usb-action="space-target">Review space</button>
            <details class="usb-advanced"><summary>More drive tools</summary>
            <button class="pill-btn ghost btn-xs" data-usb-path="${usbEscape(mountPath)}" data-usb-action="scripts-backup">Backup script</button>
            <button class="pill-btn ghost btn-xs" data-usb-path="${usbEscape(mountPath)}" data-usb-action="ai-storage">Use for AI models</button></details>
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



function openReviewedPeerConsole(id,panel) {
  if(meshUiLocked)return false;
  const peer=meshDirectoryCache?.devices?.find(x=>x.device_id===id);
  if(peer?.peer_profile==='inference_node'){showToast('This TLI Node offers AI compute only. Check its models in Ask TLI.','error');return false;}
  try { const u=new URL(peer?.origin); if(peer.status!=='allowed'||peer.trust_state!=='verified'||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/')throw Error();
    window.open(u.origin+'/?panel='+encodeURIComponent(panel||'visualizer'),'_blank','noopener,noreferrer');return true;
  } catch {showToast('Review this computer’s exact identity and HTTPS address first.','error');return false;}
}
window.TLIPeerTrust=(()=>{
  let dialog,body,notice,review=null,epoch=0,busy=false,focus;
  const n=(tag,text)=>{const x=document.createElement(tag);if(text!=null)x.textContent=text;return x;};
  const alive=t=>dialog?.open&&!meshUiLocked&&t===epoch;
  function button(text,fn){const b=n('button',text);b.type='button';b.className='btn btn-outline';Object.assign(b.style,{minWidth:'0',maxWidth:'100%',whiteSpace:'normal',overflowWrap:'anywhere'});b.addEventListener('click',()=>{if((busy&&text!=='Close')||meshUiLocked)return;Promise.resolve().then(fn).catch(e=>{if(dialog?.open&&!meshUiLocked)notice.textContent=e.message;});});return b;}
  function field(text,tag='input'){const label=n('label'),input=n(tag);label.style.minWidth='0';input.style.minWidth='0';input.style.width='100%';input.style.boxSizing='border-box';input.maxLength=24576;label.append(n('span',text),input);body.append(label);return input;}
  async function api(path,payload,t){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!alive(t))throw Error('Review closed.');if(r.status===401){window.dispatchEvent(new CustomEvent('tli-session-locked'));throw Error('Unlock TLI to review trust.');}const j=await r.json();if(!alive(t))throw Error('Review closed.');if(!r.ok)throw Error(typeof j.detail==='string'?j.detail:j.detail?.message||'Trust review unavailable.');return j;}
  async function run(fn){if(busy)return;const t=epoch;busy=true;try{await fn();}finally{if(t===epoch)busy=false;}}
  async function compatible(t){if(!window.TLIRelease?.requireCapability)throw Error('Refresh TLI to load its computer trust capability check.');await window.TLIRelease.requireCapability('trusted_peers_v1');return alive(t);}
  function cardProfile(card){
    const capabilities=card?.capabilities;
    if(!Array.isArray(capabilities))return null;
    if(capabilities.length===1&&capabilities[0]==='inference_v1')return 'node';
    const host=['system_observation_v1','coordination_v1','messages_v1'];
    return capabilities.length===host.length&&capabilities.every((value,index)=>value===host[index])?'host':null;
  }
  function close(){epoch++;review=null;busy=false;dialog?.close();focus?.focus?.();}
  function home(){review=null;body.replaceChildren();notice.textContent='';body.append(n('p','Exchange public cards on both computers. Compare both fingerprints on the other computer’s own screen. Names and discovered addresses are not proof of identity.'));
    const address=field('This computer’s HTTPS LAN IPv4 address and port');address.placeholder='https://192.168.1.20:8000';
    const output=field('Your public computer card; contains no private key','textarea');output.readOnly=true;output.rows=6;
    body.append(button('Show this computer’s card',()=>run(async()=>{const t=epoch,j=await api('/mesh/trust/card',{origin:address.value.trim()},t);output.value=JSON.stringify(j.card,null,2);notice.textContent='Identity: '+j.card.identity_fingerprint+' · HTTPS: '+j.card.certificate_sha256;})));
    const input=field('Paste the other computer’s public card','textarea');input.rows=6;const checks=[];
    const profileNotice=n('p');profileNotice.setAttribute('role','status');body.append(profileNotice);
    for(const [id,text] of [['observe','Allow short CPU, RAM and uptime observations'],['coordinate','Allow connection status and read-only coordination/ping'],['messages','Allow explicit LAN messages and file offers (files need separate receiver consent)'],['inference','Allow explicitly selected AI inference (shared prompts and enabled conversation/notes; no device actions)']]){const label=n('label'),c=n('input');c.type='checkbox';c.value=id;c.checked=false;label.append(c,n('span',text));body.append(label);checks.push(c);}
    let cardRevision=0;
    function updateProfile(){
      cardRevision++;let profile=null;
      if(input.value.length<=24576){try{profile=cardProfile(JSON.parse(input.value));}catch{}}
      for(const c of checks){c.checked=false;c.disabled=!profile||(profile==='node'&&c.value!=='inference');}
      profileNotice.textContent=profile==='node'?'This TLI Node offers AI compute only. Select inference explicitly to share prepared prompts and enabled conversation/notes. Complete pairing on the Node too.':profile==='host'?'This card describes a full TLI host. Choose only the permissions you want to review.':'Paste a complete supported public card to choose permissions. The server verifies its signature during review.';
    }
    input.addEventListener('input',updateProfile);updateProfile();
    body.append(button('Review selected permissions',()=>run(async()=>{
      const t=epoch,revision=cardRevision,raw=input.value;
      if(raw.length>24576)throw Error('Public card is too large.');
      let card;try{card=JSON.parse(raw);}catch{throw Error('Paste the complete public JSON card.');}
      const profile=cardProfile(card);if(!profile)throw Error('This public card has an unsupported capability profile.');
      const grants=checks.filter(x=>x.checked&&!x.disabled&&(profile==='host'||x.value==='inference')).map(x=>x.value);
      if(!grants.length)throw Error('Select at least one permission to review.');
      if(!await compatible(t))return;
      if(revision!==cardRevision||raw!==input.value)throw Error('The card changed. Select permissions and review it again.');
      const result=await api('/mesh/trust/preview',{card,grants},t);
      if(revision!==cardRevision||raw!==input.value)throw Error('The card changed. Select permissions and review it again.');
      review=result;paint();
    })));
  }
  function paint(){body.replaceChildren();const c=review.card;body.append(n('p',c.name+' · '+c.node_id),n('p',c.origin),n('p','Identity: '+c.identity_fingerprint),n('p','HTTPS certificate SHA-256: '+c.certificate_sha256),n('p','Permissions: '+review.grants.join(', ')+'. '+(cardProfile(c)==='node'?'This TLI Node offers AI compute only. Prepared prompts and enabled conversation/notes are shared when you explicitly select its model. No device actions are granted. Complete pairing on the Node too.':'No cleanup, arbitrary commands or device actions. File offers require a separate receiver review for each file; this trust review never accepts a file. Complete this review on both computers.')));
    if(review.replaces_existing)body.append(n('p','This replaces trust for this exact node ID. Other same-name or same-address records are preserved.'));
    const fp=field('Paste the matching identity fingerprint from the other computer’s screen');fp.maxLength=39;const cert=field('Paste the matching HTTPS SHA-256 from that screen');cert.maxLength=64;
    body.append(button('Trust these exact details',()=>run(async()=>{const t=epoch;if(!await compatible(t))return;await api('/mesh/trust/approve',{review_id:review.review_id,identity_fingerprint:fp.value.trim(),certificate_sha256:cert.value.trim()},t);home();notice.textContent='Trust saved here. The other computer must review your card too.';await refreshMeshNodeAndMaybeDirectory();})),button('Back to card',home));
  }
  function open(){if(meshUiLocked||document.hidden)return;if(!dialog){dialog=n('dialog');dialog.id='tli-peer-trust-dialog';dialog.setAttribute('aria-labelledby','tli-peer-trust-heading');Object.assign(dialog.style,{width:'min(720px, calc(100vw - 24px))',maxHeight:'90vh',overflow:'auto',color:'var(--text)',background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'14px',padding:'20px',boxSizing:'border-box'});const h=n('h2','Trust a computer');h.id='tli-peer-trust-heading';h.tabIndex=-1;body=n('div');Object.assign(body.style,{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:'12px',minWidth:'0',overflowWrap:'anywhere'});notice=n('p');notice.setAttribute('role','status');dialog.append(h,body,notice,button('Close',close));dialog.addEventListener('cancel',e=>{e.preventDefault();close();});document.body.append(dialog);}epoch++;busy=false;focus=document.activeElement;home();dialog.showModal();dialog.querySelector('h2').focus();}
  async function revoke(id){if(meshUiLocked||!confirm('Revoke this computer’s access here? Saved identity and history remain. Another explicit review will be required.'))return;const t=meshUiEpoch;try{const r=await fetch('/mesh/trust/'+encodeURIComponent(id)+'/revoke',{method:'POST'});if(!meshUiCurrent(t))return;if(!r.ok)throw Error('Could not revoke this computer.');await refreshMeshNodeAndMaybeDirectory();}catch(e){if(meshUiCurrent(t))showToast(e.message,'error');}}
  function renderDirectory(directory){
    const list=document.getElementById('tli-peer-trust-list');if(!list)return;list.replaceChildren();
    if(meshUiLocked)return;
    const entries=directory?.devices;if(!Array.isArray(entries)){list.append(n('p','Computer access is unavailable. Refresh to read saved identities.'));return;}
    if(!entries.length){list.append(n('p','No other computer identities are recorded here yet.'));return;}
    for(const entry of entries){const row=n('div');Object.assign(row.style,{borderTop:'1px solid var(--border-subtle)',padding:'12px 0',overflowWrap:'anywhere'});
      row.append(n('strong',entry.display_name||entry.device_id),n('p','ID: '+entry.device_id),n('p',entry.status==='blocked'?'Access revoked':entry.trust_state==='verified'?'Reviewed permissions saved here':'Review required before communication'));
      if(entry.origin)row.append(n('p',entry.origin));
      row.append(button('Review computer',open));if(entry.status!=='blocked')row.append(button('Revoke access',()=>revoke(entry.device_id)));list.append(row);}
  }
  function install(){if(document.getElementById('tli-peer-trust-open'))return;const anchor=document.querySelector('#panel-mesh .mcd-header');if(!anchor)return;
    const wrap=n('div'),b=button('Review computer trust',open);b.id='tli-peer-trust-open';wrap.style.padding='0 0 18px';wrap.append(b,n('p','Both computers explicitly review identity and HTTPS fingerprints before communicating.'));
    const details=n('details');details.append(n('summary','Reviewed computer access'));const list=n('div');list.id='tli-peer-trust-list';details.append(list);wrap.append(details);anchor.after(wrap);renderDirectory(meshDirectoryCache);
  }
  window.addEventListener('tli-session-locked',()=>{epoch++;review=null;busy=false;if(dialog){body.replaceChildren();notice.textContent='';dialog.close();}document.getElementById('tli-peer-trust-list')?.replaceChildren();});window.addEventListener('pagehide',()=>{epoch++;review=null;dialog?.close();});return{open,revoke,install,renderDirectory};
})();
