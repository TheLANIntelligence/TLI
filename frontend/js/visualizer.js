// ---------- VISUALIZER (Treemap + filters) ----------
// Open a file/folder on the host OS
async function openPathOnHost(fullPath) {
  if (!fullPath) return;
  try {
    const resp = await fetch("/open_path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error("HTTP " + resp.status + (txt ? " · " + txt : ""));
    }
    try { if (typeof showToast === "function") showToast("Revealed in file manager:\n" + fullPath); } catch {}
    console.log("[VIS] Opened path on host:", fullPath);
    try { if (typeof showToast === "function") showToast("Opened on host:\n" + fullPath); } catch {}
  } catch (err) {
    console.error("[VIS] Failed to open path:", err);
    showToast("Could not open this path in Explorer/Finder:\n" + err.message);
  }
}

async function revealPathOnHost(fullPath) {
  if (!fullPath) return;
  try {
    const resp = await fetch("/open_reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error("HTTP " + resp.status + (txt ? " · " + txt : ""));
    }
  } catch (err) {
    console.error("[VIS] Reveal failed:", err);
    showToast("Could not reveal this path:\n" + (err?.message || err));
  }
}

// Delete a file/folder on the host OS
// deletePathOnHost — defined once below

function getParentFolderPath(fullPath) {
  if (!fullPath) return fullPath;

  // Strip trailing slashes first
  const norm = fullPath.replace(/[\\\/]+$/, "");
  const lastSlash = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));

  // If there's no parent, just return the normalized path
  if (lastSlash <= 0) return norm;

  return norm.slice(0, lastSlash);
}

let lastVisualizerData = null;
let treemapContextMenu = null;
let treemapContextPath = null;
let treemapContextIsDir = false;
let treemapContextDeletable = true;  // false for system/protected paths

// Windows drive-root system files — Delete must be hidden for these.
const _WIN_SYSTEM_FILENAMES = new Set([
  "hiberfil.sys", "pagefile.sys", "swapfile.sys",
  "bootmgr", "bootnxt", "boot", "recovery",
  "system volume information", "$recycle.bin",
  "$windows.~bt", "$windows.~ws", "$winreagent",
  "config.sys", "autoexec.bat",
]);

function _isSystemPath(fullPath) {
  if (!fullPath) return false;
  const norm  = fullPath.replace(/\\/g, "/");
  const parts = norm.replace(/\/+$/, "").split("/");
  const name  = (parts[parts.length - 1] || "").toLowerCase();
  // Drive-root file: path has exactly one component after the drive (e.g. "C:/hiberfil.sys")
  const isDriveRoot = parts.length <= 2 || (parts.length === 3 && parts[0].match(/^[a-z]:$/i) && parts[1] === "");
  if (isDriveRoot && _WIN_SYSTEM_FILENAMES.has(name)) return true;
  // Any path whose parent IS the drive root
  const parentIsRoot = norm.replace(/\/+$/, "").split("/").length === 2;
  if (parentIsRoot && _WIN_SYSTEM_FILENAMES.has(name)) return true;
  return false;
}

const visualizerState = {
  hideTiny: false,
  hideNoisy: false,
};
// Delete a file/folder on the host OS.
// Always moves to Recycle Bin / Trash — never permanently deletes.
async function deletePathOnHost(fullPath, isDir) {
  if (!fullPath) return;

  // Stronger confirmation for directories
  let message;
  if (isDir) {
    message = `Move this folder to the Recycle Bin?\n\n${fullPath}\n\nThe entire folder and its contents will be moved to the Recycle Bin.`;
  } else {
    message = `Move to Recycle Bin?\n\n${fullPath}`;
  }
  if (!confirm(message)) return;

  try {
    const resp = await fetch("/visualizer/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath, permanent: false })
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.detail || "HTTP " + resp.status);
    }

    showToast("Moved to Recycle Bin.", "success");
    const scanBtn = document.getElementById("visualizerScanBtn");
    if (scanBtn) scanBtn.click();
  } catch (err) {
    console.error("[VIS] Delete failed:", err);
    showToast("Could not delete: " + err.message, "error");
  }
}

// Per-category colors (soft WinDirStat vibe)
const TREEMAP_COLORS = {
  documents: "#2b8cff",
  images:    "#ff7a45",
  audio:     "#ffb347",
  video:     "#c472faff",
  code:      "#9b6dff",
  archives:  "#3dd68c",
  system:    "#580f0fff",
  other:     "#4fb3ff"
};


function getParentDirFromFullPath(p) {
  // Works with both Windows (\) and Unix (/) separators
  const lastSep = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return lastSep >= 0 ? p.slice(0, lastSep) : p;
}

function openInFilesPanel(fullPath, isDir = false) {
  if (!fullPath) return;
  try {
    const dir = isDir ? fullPath : getParentDirFromFullPath(fullPath);
    if (typeof switchPanel === "function") switchPanel("panel-files");
    const input = document.getElementById("filesRootInput");
    if (input) input.value = dir;
    const btn = document.getElementById("filesScanButton");
    if (btn) btn.click();
    try { if (typeof showToast === "function") showToast("Opened in Files panel:\n" + dir); } catch {}
  } catch (err) {
    console.error("[VIS] Open in Files failed:", err);
  }
}

// Show the Visualizer context menu (V4 tables/tree) at the cursor, clamped to viewport.
function showVisContextMenu(evt, fullPath, isDir = false, deletable = true) {
  if (!treemapContextMenu || !fullPath) return;
  evt.preventDefault();
  evt.stopPropagation();
  treemapContextPath = fullPath;
  treemapContextIsDir = !!isDir;
  // Determine deletability: caller may pass explicit flag, or fall back to system-path check.
  treemapContextDeletable = deletable && !_isSystemPath(fullPath);

  // Show/hide Delete based on whether path is safe to delete.
  const deleteBtn = treemapContextMenu.querySelector("[data-action='delete']");
  if (deleteBtn) {
    deleteBtn.style.display = treemapContextDeletable ? "" : "none";
  }

  // Position (clamp inside viewport)
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  treemapContextMenu.style.display = "block";
  treemapContextMenu.style.left = "0px";
  treemapContextMenu.style.top = "0px";

  // Measure after display
  const rect = treemapContextMenu.getBoundingClientRect();
  const mw = rect.width || 220;
  const mh = rect.height || 160;

  let x = (evt.pageX ?? evt.clientX ?? 0);
  let y = (evt.pageY ?? evt.clientY ?? 0);

  x = Math.max(8, Math.min(x, (vw - mw - 8)));
  y = Math.max(8, Math.min(y, (vh - mh - 8)));

  treemapContextMenu.style.left = x + "px";
  treemapContextMenu.style.top = y + "px";
}

// ── Drive tiles — "This PC" style ────────────────────────────────────────
// Drive type → icon + label
const _DRIVE_META = {
  fixed:     { icon: "💾", label: "Local Disk"   },
  removable: { icon: "🔌", label: "Removable"    },
  network:   { icon: "🌐", label: "Network Drive" },
  cdrom:     { icon: "💿", label: "Optical Drive" },
  ram:       { icon: "⚡", label: "RAM Disk"      },
  unknown:   { icon: "📀", label: "Drive"         },
};

async function loadVisualizerDrives() {
  const container = document.getElementById("vis4-drives");
  if (!container) return;
  // Allow forced reload (don't cache forever)
  if (container._loaded && !container._forceReload) return;
  container._forceReload = false;

  container.innerHTML = `<div class="vis4-drives-loading">Detecting drives…</div>`;

  try {
    const data = await _fetchJson("/visualizer/drives");
    const drives = (data && data.drives) || [];

    if (!drives.length) {
      container.innerHTML = `<div class="vis4-drives-loading">No drives detected.</div>`;
      return;
    }

    container.innerHTML = "";

    // Section header
    const hdr = document.createElement("div");
    hdr.className = "vis4-drives-header";
    hdr.textContent = "This Device";
    container.appendChild(hdr);

    const grid = document.createElement("div");
    grid.className = "vis4-drives-grid";
    container.appendChild(grid);

    drives.forEach(d => {
      const pct      = Math.round(d.percent_used || 0);
      const isCrit   = pct >= 90;
      const isWarn   = pct >= 75;
      const mount    = d.mountpoint || d.device || "?";
      const meta     = _DRIVE_META[d.drive_type] || _DRIVE_META.unknown;

      // Build display name: volume label + mount letter, or just mount
      const mountShort = mount.replace(/[\\\/]+$/, "").split(/[\\\/]/).pop() || mount;
      const driveId    = window.TLI_SERVER_OS === "Windows"
        ? mount.replace(/[\\\/]/g, "").toUpperCase()   // "C:"
        : mountShort || mount;                          // "/" or "sda1"

      const displayName = d.label ? `${d.label}` : (meta.label + (driveId ? ` (${driveId})` : ""));
      const subtitle    = d.label ? driveId : "";

      const tile = document.createElement("button");
      tile.className = "vis4-drive-tile"
        + (isCrit ? " crit" : isWarn ? " warn" : "")
        + (d.drive_type === "network" ? " is-network" : "")
        + (d.drive_type === "removable" ? " is-removable" : "");
      tile.title = `${mount}\n${d.used_human} used of ${d.total_human} (${pct}% full)`;
      tile.setAttribute("data-mount", mount);

      tile.innerHTML = `
        <div class="vis4-drive-icon">${meta.icon}</div>
        <div class="vis4-drive-name">
          <div class="vis4-drive-label">${escapeHtml(displayName)}</div>
          ${subtitle ? `<div class="vis4-drive-sub">${escapeHtml(subtitle)}</div>` : ""}
        </div>
        <div class="vis4-drive-usage">
          <div class="vis4-drive-bar"><div class="vis4-drive-fill" style="width:${pct}%"></div></div>
          <span class="vis4-drive-pct">${pct}%</span>
        </div>
        <div class="vis4-drive-stats">
          <span class="vis4-drive-free">${d.free_human} free</span>
          <span class="vis4-drive-total">of ${d.total_human}</span>
        </div>
      `;

      tile.addEventListener("click", () => {
        // Mark this tile active
        grid.querySelectorAll(".vis4-drive-tile").forEach(t => t.classList.remove("active"));
        tile.classList.add("active");
        // Fill input and scan
        const inp = document.getElementById("visualizerPathInput");
        if (inp) inp.value = mount;
        const btn = document.getElementById("visualizerScanBtn");
        if (btn) btn.click();
      });

      grid.appendChild(tile);
    });

    container._loaded = true;
  } catch (e) {
    container.innerHTML = `<div class="vis4-drives-loading">Could not load drives.</div>`;
  }
}

function setupVisualizer() {
  const input   = document.getElementById("visualizerPathInput");
  const scanBtn = document.getElementById("visualizerScanBtn");
  const jsonPre = document.getElementById("visualizer-json");
  treemapContextMenu = document.getElementById("treemap-context-menu");

// Ensure context menu exists even if the HTML doesn't include it.
if (!treemapContextMenu) {
  treemapContextMenu = document.createElement("div");
  treemapContextMenu.id = "treemap-context-menu";
  treemapContextMenu.className = "treemap-context-menu";
  treemapContextMenu.style.display = "none";
  treemapContextMenu.innerHTML = `
    <button data-action="open_files">Open in Files</button>
    <button data-action="reveal">Reveal in Explorer/Finder</button>
    <button data-action="open">Open</button>
    <button data-action="copy">Copy path</button>
    <button data-action="delete">Delete</button>
  `;
  document.body.appendChild(treemapContextMenu);
}

  treemapContextPath = null;

  const hideTinyCheckbox  = document.getElementById("visualizerHideTiny");
  const hideNoisyCheckbox = document.getElementById("visualizerHideNoisy");
  const resetBtn          = document.getElementById("visualizerResetViewBtn");

  if (!input || !scanBtn || !jsonPre) {
    console.log("[VIS] Missing core element(s)", { input, scanBtn, jsonPre });
    return;
  }

  // Make sure debug text is readable
  jsonPre.style.color = "#ffffff";
  jsonPre.style.whiteSpace = "pre";

  async function runScan(event) {
    if (event && event.preventDefault) event.preventDefault();

    const path = (input.value || "").trim();

    jsonPre.textContent = `DEBUG: Scan clicked for path:\n${path || "(empty)"}`;
    console.log("[VIS] Scan clicked for path:", path);

    if (!path) {
      jsonPre.textContent += "\n\nEnter a folder path to scan.";
      return;
    }

    try {
      jsonPre.textContent += "\n\nScanning…";
      const url  = "/scan_directory?path=" + encodeURIComponent(path) + "&max_depth=2";
      const resp = await fetch(url);

      console.log("[VIS] Response status:", resp.status);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error("HTTP " + resp.status + (txt ? " · " + txt : ""));
      }

      const data = await resp.json();
      // Mirror the response into the Visualizer JSON debug pane (if present)
      const jsonEl = document.getElementById('visualizer-json');
      if (jsonEl) {
        try { jsonEl.textContent = JSON.stringify(data, null, 2); } catch(e) { jsonEl.textContent = String(data); }
      }

      const jsonText = JSON.stringify(data, null, 2);

      lastVisualizerData = data;
      jsonPre.textContent = jsonText;
      console.log("[VIS] Scan complete, bytes:", jsonText.length);

      renderStorageExplorer(data);
    } catch (err) {
      console.error("Visualizer scan error:", err);
      jsonPre.textContent = "Scan failed:\n" + err.message;
    }
  }

  scanBtn.addEventListener("click", runScan);

  // Quick folder buttons — wire after paths are loaded
  function _wireVisQuickFolders() {
    document.querySelectorAll("[data-vis-preset]").forEach(btn => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-vis-preset");
        const path = typeof _tliPathPreset === "function" ? _tliPathPreset(kind) : kind;
        if (path && path !== "~") {
          input.value = path;
          runScan();
        }
      });
    });
  }
  _wireVisQuickFolders();
  // Re-wire once real paths arrive (TLI_PATHS may not be set yet at DOM ready)
  document.addEventListener("tli:paths-loaded", _wireVisQuickFolders, { once: true });

  // Public API — lets other panels trigger a scan programmatically
  window.TLIVisualizer = window.TLIVisualizer || {};
  window.TLIVisualizer.scanPath = function(path) {
    if (path) input.value = path;
    runScan();
  };

  // Checkbox wiring
  if (hideTinyCheckbox) {
    hideTinyCheckbox.addEventListener("change", () => {
      visualizerState.hideTiny = !!hideTinyCheckbox.checked;
      console.log("[VIS] hideTiny ->", visualizerState.hideTiny);
      if (lastVisualizerData) renderStorageExplorer(lastVisualizerData);
    });
  }

  if (hideNoisyCheckbox) {
    hideNoisyCheckbox.addEventListener("change", () => {
      visualizerState.hideNoisy = !!hideNoisyCheckbox.checked;
      console.log("[VIS] hideNoisy ->", visualizerState.hideNoisy);
      if (lastVisualizerData) renderStorageExplorer(lastVisualizerData);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      visualizerState.hideTiny  = false;
      visualizerState.hideNoisy = false;
      if (hideTinyCheckbox)  hideTinyCheckbox.checked = false;
      if (hideNoisyCheckbox) hideNoisyCheckbox.checked = false;
      console.log("[VIS] view reset");
      if (lastVisualizerData) renderStorageExplorer(lastVisualizerData);
    });
  }
  // Close context menu on any regular click
  document.addEventListener("click", () => {
    if (treemapContextMenu) treemapContextMenu.style.display = "none";
  });

  // Handle clicks inside the Visualizer context menu
if (treemapContextMenu) {
  treemapContextMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");

    if (action === "open_files" && treemapContextPath) {
  openInFilesPanel(treemapContextPath, treemapContextIsDir);

} else if (action === "reveal" && treemapContextPath) {
  await revealPathOnHost(treemapContextPath);

} else if (action === "open" && treemapContextPath) {
  await openPathOnHost(treemapContextPath);

} else if (action === "copy" && treemapContextPath) {
  try {
    await navigator.clipboard.writeText(treemapContextPath);
    showToast("Copied path:\n" + treemapContextPath);
  } catch (err) {
    console.error("Clipboard failed:", err);
    showToast("Could not copy to clipboard.");
  }

} else if (action === "delete" && treemapContextPath) {
  await deletePathOnHost(treemapContextPath, treemapContextIsDir);
}

treemapContextMenu.style.display = "none";
  });
}

  console.log("[VIS] setupVisualizer wired");
}

// We still want this global formatter for sizes
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return value.toFixed(value >= 10 ? 0 : 1) + " " + units[i];
}
/* ============================================================
   VISUALIZER COLORS — CUSTOM FILE TYPE MAPPING
   ============================================================ */

// 🎨 Central color mapping for file types
// Edit these hex values to whatever colors you want.
const FILE_TYPE_COLORS = {
  ".mp4": "#c084fc",      // purple
  ".mov": "#e879f9",      // pink-purple
  ".7z":  "#22c55e",      // green
  ".zip": "#16a34a",      // darker green
  ".exe": "#38bdf8",      // light blue
  ".msi": "#0ea5e9",      // medium blue
  ".wav": "#facc15",      // yellow
  ".mp3": "#f97316",      // orange
  ".m4a": "#fb923c",      // softer orange
  ".bin": "#64748b",      // gray

  folder:  "#4ade80",     // folder blocks
  default: "#60a5fa",     // anything not matched above
};

// Extract ".ext" from a filename
function getFileExtension(name) {
  if (!name) return "";
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) return "";
  return name.slice(lastDot).toLowerCase();
}

// NEW colorForNode that uses FILE_TYPE_COLORS
function colorForNode(d) {
  if (!d || !d.data) return FILE_TYPE_COLORS.default;

  // Folders (nodes that have children)
  if (d.data.children && d.data.children.length) {
    return FILE_TYPE_COLORS.folder;
  }

  const ext = getFileExtension(d.data.name || "");
  return FILE_TYPE_COLORS[ext] || FILE_TYPE_COLORS.default;
}

// Categorize files by extension for colors
function getFileCategory(name) {
  if (!name) return "other";
  const lower = name.toLowerCase();

  const docs = [".txt", ".md", ".rtf", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"];
  const images = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"];
  const audio = [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"];
  const video = [".mp4", ".mov", ".mkv", ".avi", ".webm"];
  const archives = [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz"];
  const code = [
    ".js", ".ts", ".jsx", ".tsx",
    ".py", ".json", ".html", ".css",
    ".c", ".cpp", ".h", ".hpp",
    ".cs", ".java", ".php", ".rb", ".rs", ".go", ".sh", ".bat", ".ps1", ".sql"
  ];

  const matchExt = (list) => list.some(ext => lower.endsWith(ext));

  if (matchExt(docs))     return "documents";
  if (matchExt(images))   return "images";
  if (matchExt(audio))    return "audio";
  if (matchExt(video))    return "video";
  if (matchExt(archives)) return "archives";
  if (matchExt(code))     return "code";

  // Very rough system-ish folder hint
  if (
    lower.includes("windows") ||
    lower.includes("program files") ||
    lower.includes("appdata") ||
    lower.includes("node_modules") ||
    lower.startsWith(".")
  ) {
    return "system";
  }

  return "other";
}

function colorForNode(d) {
  const name = (d.data && d.data.name) || "";
  const category = getFileCategory(name);
  return TREEMAP_COLORS[category] || TREEMAP_COLORS.other;
}

// Simple “is this a noisy folder?” helper
function isNoisyName(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  const noisy = [
    "appdata",
    "node_modules",
    "temp",
    "tmp",
    "cache",
    "logs",
    "venv",
    "__pycache__"
  ];
  return noisy.some(n => lower === n || lower.includes(n));
}

// Clone + filter tree so tiny/noisy items are removed before layout
function filterTree(node, rootSize, opts) {
  if (!node) return null;

  const MIN_FRACTION = 0.003; // 0.3% of total; tweak if you want
  const minBytes = rootSize * MIN_FRACTION;

  // If this is a “noisy” folder and we’re hiding noisy stuff, drop the whole subtree
  if (opts.hideNoisy && isNoisyName(node.name)) {
    return null;
  }

  let children = null;
  if (Array.isArray(node.children) && node.children.length > 0) {
    children = node.children
      .map(child => filterTree(child, rootSize, opts))
      .filter(Boolean);
  }

  // Base size: either explicit size or sum of children
  let size = typeof node.size === "number" ? node.size : 0;
  if (children && children.length > 0) {
    size = children.reduce((acc, c) => acc + (c.size || 0), 0);
  }

  // Leaf-level tiny filter
  if (opts.hideTiny && (!children || children.length === 0) && size < minBytes) {
    return null;
  }

  return {
    name: node.name,
    size,
    children: children && children.length ? children : undefined
  };
}
  // Best-effort client-side mirror of backend Safe Mode rules
  function isProtectedSystemPathClient(fullPath) {
    if (!fullPath) return false;
    const lower = fullPath.replace(/\\/g, "/").toLowerCase();

    // Windows
    if (_tliIsWindows()) {
      const protectedFiles = [
        "c:/hiberfil.sys",
        "c:/pagefile.sys",
        "c:/swapfile.sys",
        "c:/bootmgr",
        "c:/bootnxt",
        "c:/boot/bcd",
        "c:/boot/bootstat.dat",
      ];
      // Any .sys file directly on any drive root (e.g. D:/hiberfil.sys)
      if (/^[a-z]:\/[^/]+\.sys$/.test(lower)) return true;
      const protectedPrefixes = [
        "c:/windows",
        "c:/program files",
        "c:/program files (x86)",
        "c:/programdata",
        "c:/system volume information",
        "c:/$recycle.bin",
      ];

      if (protectedFiles.includes(lower)) return true;
      return protectedPrefixes.some(
        p => lower === p || lower.startsWith(p + "/")
      );
    }

    // macOS
    if (_tliIsMac()) {
      const prefixes = [
        "/system",
        "/usr",
        "/bin",
        "/sbin",
        "/private",
        "/library",
        "/applications",
        "/volumes/recovery",
      ];
      return prefixes.some(
        p => lower === p || lower.startsWith(p + "/")
      );
    }

    // Generic Linux / Unix
    const posixPrefixes = [
      "/bin",
      "/boot",
      "/dev",
      "/etc",
      "/lib",
      "/lib32",
      "/lib64",
      "/proc",
      "/root",
      "/run",
      "/sbin",
      "/sys",
      "/usr",
      "/var",
      "/snap",
      "/opt",
    ];
    return posixPrefixes.some(
      p => lower === p || lower.startsWith(p + "/")
    );
  }

function renderStorageExplorer(data) {
  // ✅ AAA Visualizer V4: Table-first Storage Intelligence Explorer (no treemap).
  const treeEl   = document.getElementById("visualizerFolderTree");
  const tbody    = document.getElementById("visualizerTableBody");
  const breadcrumbEl = document.getElementById("visualizerBreadcrumb");
  const statusEl = document.getElementById("visualizerStatusLine");
  const selEl    = document.getElementById("visualizerSelectionLine");
  const centerTitle = document.getElementById("visualizerCenterTitle");
  const centerSub   = document.getElementById("visualizerCenterSubtitle");
  const insightsSub = document.getElementById("visualizerInsightsSubtitle");
  const typeBarsEl  = document.getElementById("visualizerTypeBars");
  const topFoldersEl= document.getElementById("visualizerTopFolders");
  const cleanupEl   = document.getElementById("visualizerCleanupHints");
  const detailsBar  = document.getElementById("visualizerDetailsBar");
  const dName       = document.getElementById("visualizerDetailsName");
  const dPath       = document.getElementById("visualizerDetailsPath");
  const dSize       = document.getElementById("visualizerDetailsSize");
  const copyBtn     = document.getElementById("visualizerCopyPathBtn");
  const openBtn     = document.getElementById("visualizerSendToFilesBtn");
  const searchInput = document.getElementById("visualizerSearchInput");
  const catSel      = document.getElementById("visualizerCategoryFilter");
  const extInput    = document.getElementById("visualizerExtFilter");
  const minSizeSel  = document.getElementById("visualizerMinSize");
  const clearBtn    = document.getElementById("visualizerClearFiltersBtn");
  const pillsWrap   = document.getElementById("visualizerModePills");
  const backBtn     = document.getElementById("visualizerBackBtn");

  const jsonEl      = document.getElementById("visualizer-json");
  const debugToggle = document.getElementById("visualizerDebugToggle");

  if (!treeEl || !tbody) return;

  // Debug JSON
  if (debugToggle && !debugToggle._v4Bound) {
    debugToggle._v4Bound = true;
    debugToggle.addEventListener("click", () => {
      if (!jsonEl) return;
      const showing = jsonEl.style.display !== "none";
      jsonEl.style.display = showing ? "none" : "block";
    });
  }
  if (jsonEl) {
    try { jsonEl.textContent = JSON.stringify(data, null, 2); } catch {}
  }

  // --- State ---
  if (!window.visualizerV4) window.visualizerV4 = {};
  const st = window.visualizerV4;

  st.root = data && (data.tree || data.root || data.data || data);
  st.scanPath = data && (data.path || data.scan_path || data.root_path || "");
  st.totalBytes = (st.root && (st.root.size || st.root.total_size)) || 0;

  // Reset cleanup panel so it re-fetches on next render
  if (cleanupEl) cleanupEl._fetched = false;

  // Mode pills
  if (!st.mode) st.mode = "map"; // map | offenders | folders | types
  // Folder focus
  if (!st.focusPath) st.focusPath = (st.root && st.root.path) || st.scanPath || "";
  if (!st.history) st.history = [st.focusPath];

  // Sorting
  if (!st.sort) st.sort = { key: "size", dir: "desc" };

  // Filters
  if (!st.filters) st.filters = { q: "", cat: "", ext: "", minMb: 0 };

  // --- Helpers ---
  function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
  function fmtBytes(bytes){
    const b = toNumber(bytes);
    const u = ["B","KB","MB","GB","TB"];
    let v=b, i=0;
    while(v>=1024 && i<u.length-1){ v/=1024; i++; }
    const d = (i===0)?0:(i===1?1:2);
    return v.toFixed(d) + " " + u[i];
  }
  function esc(s){
    return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  }
  function extOf(name){
    const s = String(name||"");
    const i = s.lastIndexOf(".");
    if (i <= 0 || i === s.length-1) return "";
    return s.slice(i).toLowerCase();
  }
  function categoryOf(name, isDir){
    if (isDir) return "Folder";
    const ext = extOf(name);
    const map = [
      ["Models", [".gguf",".safetensors",".pt",".pth",".onnx",".bin",".ckpt",".tflite",".mlmodel",".h5"]],
      ["Video",  [".mp4",".mkv",".mov",".avi",".wmv",".webm",".m4v"]],
      ["Archives",[ ".zip",".rar",".7z",".tar",".gz",".bz2",".xz",".iso",".dmg"]],
      ["Images", [".jpg",".jpeg",".png",".gif",".webp",".tif",".tiff",".bmp",".heic",".raw",".cr2",".nef"]],
      ["Audio",  [".wav",".mp3",".flac",".aiff",".aac",".m4a",".ogg"]],
      ["Dev",    [".js",".ts",".jsx",".tsx",".py",".ipynb",".go",".rs",".java",".cs",".cpp",".c",".h",".json",".yml",".yaml",".toml",".ini",".env",".sql"]],
      ["Docs",   [".pdf",".doc",".docx",".ppt",".pptx",".xls",".xlsx",".txt",".md",".rtf"]]
    ];
    for (const [cat, exts] of map){
      if (exts.includes(ext)) return cat;
    }
    return "Other";
  }

  function walk(node, fn){
    if (!node) return;
    fn(node);
    const ch = Array.isArray(node.children) ? node.children : [];
    for (const c of ch) walk(c, fn);
  }

  // Build index maps (once per scan)
  if (st._indexedAt !== st.root) {
    st._indexedAt = st.root;
    st.nodesByPath = new Map();
    st.files = [];
    st.folders = [];

    walk(st.root, (n) => {
      const path = n.path || n.full_path || n.name || "";
      if (path) st.nodesByPath.set(path, n);

      const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length > 0);
      const size  = toNumber(n.size);
      const name  = n.name || (path ? path.split(/[\\/]/).pop() : "(unnamed)");
      const item = { name, path, size, isDir, category: categoryOf(name, isDir) };

      if (isDir) st.folders.push(item);
      else st.files.push(item);
    });
  }

  function getNode(path){
    return st.nodesByPath.get(path) || st.root;
  }

  function focus(path){
    st.focusPath = path || st.focusPath;
    if (!st.history.length || st.history[st.history.length-1] !== st.focusPath) st.history.push(st.focusPath);
    st.selectedPath = null;
    renderAll();
  }

  function goBack(){
    if (st.history.length <= 1) return;
    st.history.pop();
    st.focusPath = st.history[st.history.length-1];
    st.selectedPath = null;
    renderAll();
  }

  // Bind back button once
  if (backBtn && !backBtn._v4Bound) {
    backBtn._v4Bound = true;
    backBtn.addEventListener("click", goBack);
  }

  // Bind mode pills
  if (pillsWrap && !pillsWrap._v4Bound) {
    pillsWrap._v4Bound = true;
    pillsWrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      st.mode = (btn.getAttribute("data-mode") || "offenders");
      [...pillsWrap.querySelectorAll("button[data-mode]")].forEach(b => b.classList.toggle("active", b===btn));
      renderAll();
    });
  }

  // Bind filters once
  function syncFilterUI(){
    if (searchInput) searchInput.value = st.filters.q || "";
    if (catSel) catSel.value = st.filters.cat || "";
    if (extInput) extInput.value = st.filters.ext || "";
    if (minSizeSel) minSizeSel.value = String(st.filters.minMb || 0);
  }
  syncFilterUI();

  if (searchInput && !searchInput._v4Bound){
    searchInput._v4Bound = true;
    searchInput.addEventListener("input", () => { st.filters.q = searchInput.value.trim(); renderTable(); });
  }
  if (catSel && !catSel._v4Bound){
    catSel._v4Bound = true;
    catSel.addEventListener("change", () => { st.filters.cat = catSel.value; renderTable(); });
  }
  if (extInput && !extInput._v4Bound){
    extInput._v4Bound = true;
    extInput.addEventListener("input", () => { st.filters.ext = extInput.value.trim().toLowerCase(); renderTable(); });
  }
  if (minSizeSel && !minSizeSel._v4Bound){
    minSizeSel._v4Bound = true;
    minSizeSel.addEventListener("change", () => { st.filters.minMb = Number(minSizeSel.value||0); renderTable(); });
  }
  if (clearBtn && !clearBtn._v4Bound){
    clearBtn._v4Bound = true;
    clearBtn.addEventListener("click", () => {
      st.filters = { q:"", cat:"", ext:"", minMb:0 };
      syncFilterUI();
      renderTable();
    });
  }

  // Copy path
  if (copyBtn && !copyBtn._v4Bound){
    copyBtn._v4Bound = true;
    copyBtn.addEventListener("click", async () => {
      if (!st.selectedPath) return;
      try {
        await navigator.clipboard.writeText(st.selectedPath);
        showToast("Copied path.", "success");
      } catch {
        const ta = document.createElement("textarea");
        ta.value = st.selectedPath;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("Copied path.", "success");
      }
    });
  }

  // Open in Files
  if (openBtn && !openBtn._v4Bound){
    openBtn._v4Bound = true;
    openBtn.addEventListener("click", async () => {
      const p = st.selectedPath;
      if (!p) return;
      try {
        const resp = await fetch("/visualizer/open_in_files?path=" + encodeURIComponent(p));
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        showToast("Sent to Files.", "success");
      } catch {
        try { window.__tli_open_path_in_files = p; } catch {}
        try { switchPanel("panel-files"); } catch {}
        showToast("Opening Files panel…", "success");
      }
    });
  }

  function renderBreadcrumb(){
    const fp = st.focusPath || st.scanPath || "(root)";
    if (statusEl) statusEl.textContent = `Viewing: ${fp} • Total scanned: ${fmtBytes(st.totalBytes || 0)}`;
    if (insightsSub) insightsSub.textContent = `Scan: ${st.scanPath || fp}`;
    if (backBtn) backBtn.disabled = (st.history.length <= 1);
    // Keep pane-head subtitle in sync as a short label
    if (breadcrumbEl) {
      const parts = fp.replace(/[\\\/]+$/, "").split(/[\\\/]/);
      breadcrumbEl.textContent = parts.slice(-2).join("/") || fp;
    }

    // Build interactive breadcrumb — clickable path segments
    const crumbTarget = document.getElementById("vis4-breadcrumb-row") || breadcrumbEl;
    if (!crumbTarget) return;

    // If it's the simple text element (old DOM), just update text
    if (crumbTarget === breadcrumbEl && crumbTarget.tagName !== "DIV") {
      crumbTarget.textContent = fp;
      return;
    }

    // Split path by / or \ into segments with cumulative paths
    const sep = fp.includes("\\") ? "\\" : "/";
    const raw = fp.replace(/[\\\/]+$/, ""); // strip trailing sep
    const parts = raw.split(/[\\\/]/);
    crumbTarget.innerHTML = "";

    let cumPath = "";
    parts.forEach((seg, i) => {
      if (!seg && i === 0) {
        // Unix root "/"
        cumPath = "/";
        seg = "/";
      } else {
        cumPath = cumPath ? (cumPath.replace(/[\\\/]$/, "") + sep + seg) : seg;
      }

      const isLast = (i === parts.length - 1);
      const chip = document.createElement("span");
      chip.className = "vis4-crumb" + (isLast ? " active" : "");
      chip.textContent = seg || sep;
      chip.title = cumPath;

      if (!isLast) {
        const captured = cumPath;
        chip.addEventListener("click", () => focus(captured));
      }
      crumbTarget.appendChild(chip);

      if (!isLast) {
        const sep_el = document.createElement("span");
        sep_el.className = "vis4-crumb-sep";
        sep_el.textContent = sep;
        crumbTarget.appendChild(sep_el);
      }
    });
  }

  function renderSummaryStrip(rowCount){
    const el = document.getElementById("vis4-summary");
    if (!el) return;

    const fp = st.focusPath || st.scanPath || "(root)";
    const bytes = fmtBytes(st.totalBytes || 0);
    const rows = rowCount || 0;

    // Compute top category and top folder (lightweight)
    let topCat = "—", topCatBytes = 0;
    try{
      const focusNode = getNode(st.focusPath);
      const totals = new Map();
      walk(focusNode, (n) => {
        const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
        if (isDir) return;
        const name = n.name || "";
        const cat = categoryOf(name, false);
        totals.set(cat, (totals.get(cat)||0) + toNumber(n.size));
      });
      const entries = [...totals.entries()].sort((a,b)=>b[1]-a[1]);
      if (entries.length){ topCat = entries[0][0]; topCatBytes = entries[0][1]; }
    } catch {}

    let topFolder = "—", topFolderBytes = 0;
    try{
      const focusNode = getNode(st.focusPath);
      const kids = Array.isArray(focusNode.children) ? focusNode.children : [];
      const folders = kids
        .filter(n => (n.is_dir || (Array.isArray(n.children) && n.children.length)) )
        .map(n => [n.name || "(folder)", toNumber(n.size)]);
      folders.sort((a,b)=>b[1]-a[1]);
      if (folders.length){ topFolder = folders[0][0]; topFolderBytes = folders[0][1]; }
    } catch {}

    el.innerHTML = `
      <div class="meta">
        <span class="chip"><span class="k">Scanned</span><span class="v">${esc(bytes)}</span></span>
        <span class="chip"><span class="k">Rows</span><span class="v">${esc(String(rows))}</span></span>
        <span class="chip"><span class="k">Path</span><span class="v">${esc(fp)}</span></span>
      </div>
      <div class="right">
        <span class="chip"><span class="k">Top type</span><span class="v">${esc(topCat)}${topCatBytes ? " • " + esc(fmtBytes(topCatBytes)) : ""}</span></span>
        <span class="chip"><span class="k">Top folder</span><span class="v">${esc(topFolder)}${topFolderBytes ? " • " + esc(fmtBytes(topFolderBytes)) : ""}</span></span>
      </div>
    `;
  }

  // File-type icon map for tree sidebar
  const _treeIcons = {
    Folder: "📁", Video: "🎬", Audio: "🎵", Images: "🖼",
    Models: "🤖", Archives: "📦", Dev: "💻", Docs: "📄", Other: "📎",
  };

  function renderTree(){
    const focusNode = getNode(st.focusPath);
    const kids = Array.isArray(focusNode.children) ? focusNode.children : [];
    treeEl.innerHTML = "";

    if (!kids.length){
      const empty = document.createElement("div");
      empty.className = "vis4-empty";
      empty.textContent = "Nothing here.";
      treeEl.appendChild(empty);
      return;
    }

    // Inject interactive breadcrumb row at the top of the tree pane
    const breadcrumbRow = document.createElement("div");
    breadcrumbRow.id = "vis4-breadcrumb-row";
    breadcrumbRow.className = "vis4-breadcrumb-row";
    treeEl.appendChild(breadcrumbRow);

    // Separate into folders and files, both sorted by size desc
    const folders = kids
      .filter(n => n.is_dir || (Array.isArray(n.children) && n.children.length))
      .map(n => ({ name: n.name || "(folder)", path: n.path || "", size: toNumber(n.size), isDir: true, protected: !!n.protected }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 200);

    const files = kids
      .filter(n => !n.is_dir && !(Array.isArray(n.children) && n.children.length))
      .map(n => ({ name: n.name || "(file)", path: n.path || "", size: toNumber(n.size), isDir: false, protected: !!n.protected }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 100);

    const addNode = (f) => {
      const row = document.createElement("div");
      const isActive = (f.path === st.selectedPath);
      const catIcon = f.isDir ? "📁" : (_treeIcons[categoryOf(f.name, false)] || "📎");
      row.className = "vis4-node" + (f.isDir ? " is-dir" : " is-file") + (isActive ? " active" : "") + (f.protected ? " vis4-protected" : "");
      row.innerHTML = `<div class="tw">${catIcon}</div><div class="name">${esc(f.name)}</div><div class="badge">${esc(fmtBytes(f.size))}</div>`;
      row.title = f.path || f.name;
      if (!f.protected) {
        row.addEventListener("click", () => {
          if (f.isDir) focus(f.path || f.name);
          else select({ name: f.name, path: f.path, size: f.size, isDir: false, category: categoryOf(f.name, false) });
        });
        row.addEventListener("contextmenu", (e) => showVisContextMenu(e, f.path || f.name, f.isDir, f.deletable !== false));
      }
      treeEl.appendChild(row);
    };

    folders.forEach(addNode);

    if (files.length) {
      // Thin separator between folders and files
      if (folders.length) {
        const sep = document.createElement("div");
        sep.style.cssText = "height:1px;background:var(--border-subtle);margin:6px 8px;";
        treeEl.appendChild(sep);
      }
      files.forEach(addNode);
    }

    // Now render the breadcrumb inside the injected row
    renderBreadcrumb();
  }

  function applyFilters(items){
    const q = (st.filters.q || "").toLowerCase();
    const cat = st.filters.cat || "";
    const ext = (st.filters.ext || "").toLowerCase();
    const minMb = toNumber(st.filters.minMb);
    const minBytes = minMb > 0 ? minMb * 1024 * 1024 : 0;

    return items.filter(it => {
      if (minBytes && it.size < minBytes) return false;
      if (cat && it.category !== cat) return false;

      if (ext){
        const parts = ext.split(/[\s,;]+/).filter(Boolean);
        const e = extOf(it.name);
        if (parts.length){
          let ok=false;
          for (const p of parts){
            const pe = p.startsWith(".") ? p.toLowerCase() : ("."+p.toLowerCase());
            if (e === pe) { ok=true; break; }
          }
          if (!ok) return false;
        }
      }

      if (q){
        const s = (it.name + " " + (it.path||"")).toLowerCase();
        if (!s.includes(q)) return false;
      }
      return true;
    });
  }

  function sortItems(items){
    const { key, dir } = st.sort || { key:"size", dir:"desc" };
    const mult = (dir === "asc") ? 1 : -1;
    return items.slice().sort((a,b) => {
      const av = (a[key] ?? "");
      const bv = (b[key] ?? "");
      if (key === "size"){
        return (toNumber(av) - toNumber(bv)) * mult;
      }
      return String(av).localeCompare(String(bv)) * mult;
    });
  }

  function itemsForMode(){
    const focusNode = getNode(st.focusPath);
    const kids = Array.isArray(focusNode.children) ? focusNode.children : [];

    if (st.mode === "folders"){
      return kids
        .filter(n => (n.is_dir || (Array.isArray(n.children) && n.children.length)))
        .map(n => ({ name: n.name || "(folder)", path: n.path || "", size: toNumber(n.size), isDir:true, category:"Folder", protected: !!n.protected }));
    }

    if (st.mode === "types"){
      const byCat = new Map();
      walk(focusNode, (n) => {
        const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
        if (isDir) return;
        const name = n.name || "(file)";
        const cat = categoryOf(name, false);
        byCat.set(cat, (byCat.get(cat) || 0) + toNumber(n.size));
      });
      return [...byCat.entries()].map(([cat, size]) => ({ name: cat, path: st.focusPath, size, isDir:false, category:cat }));
    }

    const files = [];
    walk(focusNode, (n) => {
      const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
      if (isDir) return;
      const path = n.path || "";
      const name = n.name || (path ? path.split(/[\\/]/).pop() : "(file)");
      const prot = !!n.protected || isProtectedSystemPathClient(path);
      files.push({ name, path, size: toNumber(n.size), isDir:false, category: categoryOf(name,false), protected: prot });
    });
    return files;
  }

  function setCenterTitles(){
    const fp = st.focusPath || st.scanPath || "";
    if (st.mode === "folders"){
      if (centerTitle) centerTitle.textContent = "Largest folders";
      if (centerSub)   centerSub.textContent = `Largest folders in: ${fp}`;
    } else if (st.mode === "types"){
      if (centerTitle) centerTitle.textContent = "File types";
      if (centerSub)   centerSub.textContent = `Storage breakdown inside: ${fp}`;
    } else if (st.mode === "map"){
      if (centerTitle) centerTitle.textContent = "Storage map";
      if (centerSub)   centerSub.textContent = `Visual treemap of: ${fp}`;
    } else {
      if (centerTitle) centerTitle.textContent = "Largest files";
      if (centerSub)   centerSub.textContent = `Largest files inside: ${fp}`;
    }
  }

  function renderTable(){
    setCenterTitles();

    const thead = tbody.closest("table")?.querySelector("thead");
    if (thead && !thead._v4Bound){
      thead._v4Bound = true;
      thead.addEventListener("click", (e) => {
        const th = e.target.closest("th[data-sort]");
        if (!th) return;
        const key = th.getAttribute("data-sort");
        if (!key) return;
        if (st.sort.key === key){
          st.sort.dir = (st.sort.dir === "asc") ? "desc" : "asc";
        } else {
          st.sort.key = key;
          st.sort.dir = (key === "size") ? "desc" : "asc";
        }
        renderTable();
      });
    }

    let items = itemsForMode();
    items = applyFilters(items);
    items = sortItems(items);

    const maxRows = 2500;
    const shown = items.slice(0, maxRows);

    tbody.innerHTML = "";
    if (!shown.length){
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="vis4-empty-row">No matches.</td>`;
      tbody.appendChild(tr);
      if (selEl) selEl.textContent = "No selection.";
      if (detailsBar) detailsBar.style.display = "none";
      if (openBtn) openBtn.disabled = true;
      return;
    }

    shown.forEach((it) => {
      const tr = document.createElement("tr");
      if (it.protected) tr.classList.add("vis4-protected");
      const shield = it.protected
        ? `<span class="vis4-shield" title="System path — do not delete">🛡</span> `
        : "";
      tr.innerHTML = `
        <td class="col-name" title="${esc(it.path || it.name)}">${shield}${esc(it.name)}</td>
        <td class="col-type">${esc(it.category)}</td>
        <td class="col-size">${esc(fmtBytes(it.size))}</td>
        <td class="col-path" title="${esc(it.path || "")}">${esc(it.path || "")}</td>
      `;
      tr.addEventListener("click", () => { if (!it.protected) select(it); });
      tr.addEventListener("contextmenu", (e) => { if (!it.protected) showVisContextMenu(e, it.path || it.name, !!it.isDir, it.deletable !== false); });
      tr.addEventListener("dblclick", () => {
        if (it.isDir && it.path && !it.protected) focus(it.path);
      });
      tbody.appendChild(tr);
    });

    if (statusEl){
      statusEl.textContent = `Rows: ${shown.length}${items.length>shown.length ? " (clamped)" : ""} • Total scanned: ${fmtBytes(st.totalBytes || 0)}`;
      renderSummaryStrip(shown.length);
    }
  }

  function select(it){
    st.selectedPath = it.path || it.name;
    st.selectedIsDir = !!it.isDir;
    if (selEl) selEl.textContent = `Selected: ${it.name} • ${fmtBytes(it.size)}`;
    if (detailsBar){
      detailsBar.style.display = "flex";
      dName.textContent = it.name;
      dPath.textContent = st.selectedPath;
      dSize.textContent = fmtBytes(it.size);
    }
    if (openBtn) openBtn.disabled = !st.selectedPath;
  }

  function renderInsights(){
    const focusNode = getNode(st.focusPath);
    const totals = new Map();
    walk(focusNode, (n) => {
      const isDir = !!n.is_dir || (Array.isArray(n.children) && n.children.length);
      if (isDir) return;
      const name = n.name || "";
      const cat = categoryOf(name, false);
      totals.set(cat, (totals.get(cat)||0) + toNumber(n.size));
    });

    const entries = [...totals.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 8);
    const max = entries.length ? entries[0][1] : 1;

    if (typeBarsEl){
      typeBarsEl.innerHTML = "";
      if (!entries.length){
        typeBarsEl.innerHTML = `<div class="vis4-empty">No data.</div>`;
      } else {
        entries.forEach(([k,v]) => {
          const wrap = document.createElement("div");
          wrap.className = "vis4-item";
          wrap.innerHTML = `<div class="k">${esc(k)}</div><div class="v">${esc(fmtBytes(v))}</div>`;
          const bar = document.createElement("div");
          bar.className = "vis4-bar";
          const fill = document.createElement("div");
          fill.style.width = Math.max(6, Math.round((v/max)*100)) + "%";
          bar.appendChild(fill);
          typeBarsEl.appendChild(wrap);
          typeBarsEl.appendChild(bar);
        });
      }
    }

    if (topFoldersEl){
      topFoldersEl.innerHTML = "";
      const kids = Array.isArray(focusNode.children) ? focusNode.children : [];
      const folders = kids
        .filter(n => (n.is_dir || (Array.isArray(n.children) && n.children.length)))
        .map(n => ({ name: n.name || "(folder)", path: n.path || "", size: toNumber(n.size) }))
        .sort((a,b)=>b.size-a.size)
        .slice(0, 10);

      if (!folders.length){
        topFoldersEl.innerHTML = `<div class="vis4-empty">No folders.</div>`;
      } else {
        folders.forEach(f => {
          const row = document.createElement("div");
          row.className = "vis4-item";
          row.innerHTML = `<div class="k" title="${esc(f.path||f.name)}">${esc(f.name)}</div><div class="v">${esc(fmtBytes(f.size))}</div>`;
          row.addEventListener("click", () => focus(f.path || f.name));
          topFoldersEl.appendChild(row);
        });
      }
    }

    if (cleanupEl && !cleanupEl._fetched){
      cleanupEl._fetched = true;
      cleanupEl.innerHTML = `<div class="vis4-empty">Loading cleanup analysis…</div>`;
      fetch("/visualizer/cleanup-targets")
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d || !d.targets) {
            cleanupEl.innerHTML = `<div class="vis4-empty">Cleanup analysis unavailable.</div>`;
            return;
          }
          const safetyLabel = { auto: "Safe to clear", manual: "Review first", caution: "Caution" };
          const safetyClass = { auto: "vis4-safe", manual: "vis4-manual", caution: "vis4-caution" };
          const targets = d.targets.filter(t => t.exists && t.size_bytes > 0);
          if (!targets.length){
            cleanupEl.innerHTML = `<div class="vis4-empty">No large cleanup targets found — your common temp/cache folders are empty or small.</div>`;
            return;
          }
          cleanupEl.innerHTML = "";
          // Show the strip now that we have data
          const stripEl = document.getElementById("vis4-cleanup-strip");
          if (stripEl) stripEl.hidden = false;
          // Grid wrapper for the target cards only (deep-clean goes outside it)
          const rowsGrid = document.createElement("div");
          rowsGrid.className = "vis4-cleanup-rows-grid";
          cleanupEl.appendChild(rowsGrid);
          // "Still full?" deep-clean section (rendered after target cards)
          const _renderDeepClean = () => {
            const scanRoot = (st.root && st.root.path) || (window.TLI_SERVER_OS === "Windows" ? "C:\\" : "/");
            const sec = document.createElement("div");
            sec.className = "vis4-deepclean-section";
            sec.innerHTML = `
              <div class="vis4-deepclean-header">Still need more space?</div>
              <p class="vis4-deepclean-sub">Common cleanup targets not enough? Go deeper — hunt large files or find duplicates taking up hidden space.</p>
              <div class="vis4-deepclean-cards">
                <div class="vis4-deepclean-card" id="vis4-largefile-card">
                  <div class="vis4-deepclean-icon">&#128269;</div>
                  <div class="vis4-deepclean-title">Hunt Large Files</div>
                  <div class="vis4-deepclean-desc">Find every file over 100 MB. Sorted by size — spot the biggest offenders instantly.</div>
                  <div class="vis4-deepclean-controls">
                    <label>Min size: <select id="vis4-largefiles-minmb">
                      <option value="50">50 MB</option>
                      <option value="100" selected>100 MB</option>
                      <option value="500">500 MB</option>
                      <option value="1000">1 GB</option>
                    </select></label>
                    <button class="pill-btn primary vis4-deepclean-btn" id="vis4-largefiles-btn">Scan Now</button>
                  </div>
                  <div id="vis4-largefile-results"></div>
                </div>
                <div class="vis4-deepclean-card" id="vis4-dupes-card">
                  <div class="vis4-deepclean-icon">&#128203;</div>
                  <div class="vis4-deepclean-title">Find Duplicates</div>
                  <div class="vis4-deepclean-desc">Groups identical files by content — not just name. See exactly how much space duplicates are wasting.</div>
                  <button class="pill-btn primary vis4-deepclean-btn" id="vis4-dupes-btn">Scan Now</button>
                  <div id="vis4-dupes-results"></div>
                </div>
                <div class="vis4-deepclean-card">
                  <div class="vis4-deepclean-icon">&#129302;</div>
                  <div class="vis4-deepclean-title">Ask the AI</div>
                  <div class="vis4-deepclean-desc">Send your current scan summary to the AI for analysis and personalised cleanup recommendations.</div>
                  <button class="pill-btn secondary vis4-deepclean-btn" id="vis4-askai-btn">Analyse with AI</button>
                </div>
              </div>
            `;
            cleanupEl.appendChild(sec);

            // Large files handler
            sec.querySelector("#vis4-largefiles-btn").addEventListener("click", () => {
              const minMb = sec.querySelector("#vis4-largefiles-minmb").value;
              const resEl = sec.querySelector("#vis4-largefile-results");
              resEl.innerHTML = `<div class="vis4-deepclean-loading">Scanning for files over ${minMb} MB…</div>`;
              fetch(`/visualizer/large-files?path=${encodeURIComponent(scanRoot)}&min_mb=${minMb}&limit=200`)
                .then(r => r.ok ? r.json() : Promise.reject(r.status))
                .then(data => {
                  if (!data.files || !data.files.length) {
                    resEl.innerHTML = `<div class="vis4-deepclean-empty">No files over ${minMb} MB found.</div>`;
                    return;
                  }
                  const totalMb = data.meta.total_mb >= 1000
                    ? (data.meta.total_mb / 1024).toFixed(1) + " GB"
                    : data.meta.total_mb + " MB";
                  let html = `<div class="vis4-deepclean-summary">Found <strong>${data.files.length}</strong> files — <strong>${totalMb}</strong> total (took ${data.meta.seconds}s)</div>
                    <table class="vis4-deepclean-table">
                      <thead><tr><th>File</th><th>Size</th><th></th></tr></thead><tbody>`;
                  data.files.slice(0, 100).forEach(f => {
                    const mb = f.size >= 1073741824
                      ? (f.size / 1073741824).toFixed(2) + " GB"
                      : (f.size / 1048576).toFixed(1) + " MB";
                    html += `<tr>
                      <td class="vis4-deepclean-fname" title="${esc(f.path)}">${esc(f.name)}</td>
                      <td class="vis4-deepclean-fsize">${mb}</td>
                      <td><button class="vis4-deepclean-reveal pill-btn secondary" data-path="${esc(f.path)}">Reveal</button></td>
                    </tr>`;
                  });
                  html += `</tbody></table>`;
                  if (data.files.length > 100) html += `<div class="vis4-deepclean-more">…and ${data.files.length - 100} more</div>`;
                  resEl.innerHTML = html;
                  resEl.querySelectorAll(".vis4-deepclean-reveal").forEach(btn => {
                    btn.addEventListener("click", () => {
                      const p = btn.getAttribute("data-path");
                      const parent = p.substring(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
                      if (parent && window.TLIVisualizer?.scanPath) window.TLIVisualizer.scanPath(parent);
                    });
                  });
                })
                .catch(err => { resEl.innerHTML = `<div class="vis4-deepclean-empty">Scan failed (${err}). Check the path and try again.</div>`; });
            });

            // Duplicates handler
            sec.querySelector("#vis4-dupes-btn").addEventListener("click", () => {
              const resEl = sec.querySelector("#vis4-dupes-results");
              resEl.innerHTML = `<div class="vis4-deepclean-loading">Scanning for duplicates in ${esc(scanRoot)}…<br><small>This may take a while for large drives.</small></div>`;
              fetch(`/visualizer/duplicates?path=${encodeURIComponent(scanRoot)}`)
                .then(r => r.ok ? r.json() : Promise.reject(r.status))
                .then(data => {
                  if (!data.groups || !data.groups.length) {
                    resEl.innerHTML = `<div class="vis4-deepclean-empty">No duplicate files found.</div>`;
                    return;
                  }
                  const wastedMb = data.meta.total_wasted_mb >= 1000
                    ? (data.meta.total_wasted_mb / 1024).toFixed(1) + " GB"
                    : data.meta.total_wasted_mb + " MB";
                  let html = `<div class="vis4-deepclean-summary">Found <strong>${data.groups.length}</strong> duplicate groups — <strong>${wastedMb}</strong> wasted (took ${data.meta.seconds}s)</div>`;
                  data.groups.slice(0, 30).forEach((g, i) => {
                    const gWasted = g.wasted_bytes >= 1073741824
                      ? (g.wasted_bytes / 1073741824).toFixed(2) + " GB"
                      : (g.wasted_bytes / 1048576).toFixed(1) + " MB";
                    const gSize = g.size >= 1073741824
                      ? (g.size / 1073741824).toFixed(2) + " GB"
                      : (g.size / 1048576).toFixed(1) + " MB";
                    html += `<details class="vis4-dupe-group">
                      <summary>${g.count} copies &times; ${gSize} = <strong>${gWasted} wasted</strong></summary>
                      <ul class="vis4-dupe-list">`;
                    g.paths.forEach(p => {
                      html += `<li title="${esc(p)}">${esc(p)}</li>`;
                    });
                    html += `</ul></details>`;
                  });
                  if (data.groups.length > 30) html += `<div class="vis4-deepclean-more">…and ${data.groups.length - 30} more groups</div>`;
                  resEl.innerHTML = html;
                })
                .catch(err => { resEl.innerHTML = `<div class="vis4-deepclean-empty">Scan failed (${err}).</div>`; });
            });

            // Ask AI handler
            sec.querySelector("#vis4-askai-btn").addEventListener("click", () => {
              // Build a concise scan summary from current state
              const root = st.root;
              const totalMb = root ? Math.round((root.size || 0) / 1048576) : 0;
              const largest = (st.largest || []).slice(0, 5).map(f => {
                const mb = Math.round(f.size / 1048576);
                return `${f.name} (${mb} MB)`;
              }).join(", ");
              const alerts = (window._tliAlerts || []).filter(a => !a.dismissed).map(a => a.message).join("; ");
              let prompt = `My TLI storage scan shows: root="${scanRoot}", total size ≈${totalMb} MB`;
              if (largest) prompt += `, largest files: ${largest}`;
              if (alerts)  prompt += `, active alerts: ${alerts}`;
              prompt += `. Can you analyse this and give me specific recommendations to free up space?`;
              // Inject into chat and switch panel
              const chatInput = document.getElementById("chatInput") || document.querySelector(".chat-input textarea") || document.querySelector("#chat-panel textarea");
              if (chatInput) {
                chatInput.value = prompt;
                chatInput.dispatchEvent(new Event("input", { bubbles: true }));
              }
              switchPanel("panel-chat");
              showToast("Scan summary sent to AI chat");
            });
          };
          // Append deep-clean section after all target rows render
          setTimeout(_renderDeepClean, 0);

          targets.forEach(t => {
            const sizeMb = t.size_mb >= 1000
              ? (t.size_mb / 1024).toFixed(1) + " GB"
              : t.size_mb.toFixed(0) + " MB";
            const row = document.createElement("div");
            row.className = "vis4-cleanup-row";
            row.innerHTML = `
              <div class="vis4-cleanup-header">
                <span class="vis4-cleanup-label">${esc(t.label)}</span>
                <span class="vis4-cleanup-size">${esc(sizeMb)}</span>
                <span class="vis4-cleanup-safety ${esc(safetyClass[t.safety] || "")}">${esc(safetyLabel[t.safety] || t.safety)}</span>
              </div>
              <div class="vis4-cleanup-tip">${esc(t.tip)}</div>
              <div class="vis4-cleanup-how"><strong>How:</strong> ${esc(t.how)}</div>
              <button class="vis4-cleanup-scan-btn pill-btn secondary" data-path="${esc(t.path)}">Scan this folder</button>
            `;
            row.querySelector(".vis4-cleanup-scan-btn").addEventListener("click", (e) => {
              const p = e.currentTarget.getAttribute("data-path");
              if (p && window.TLIVisualizer?.scanPath) window.TLIVisualizer.scanPath(p);
            });
            rowsGrid.appendChild(row);
          });
        })
        .catch(() => {
          cleanupEl.innerHTML = `<div class="vis4-empty">Could not load cleanup targets.</div>`;
        });
    }
  }

  // ── D3 Treemap ────────────────────────────────────────────────────────────
  // Colors drawn from TLI's emerald palette + complementary accents
  const _TM_COLORS = {
    Folder:   "#35c98b",   // TLI accent emerald
    Models:   "#a78bfa",   // soft violet
    Video:    "#f59e0b",   // amber
    Archives: "#f97316",   // orange
    Images:   "#ec4899",   // pink
    Audio:    "#22d3ee",   // cyan
    Dev:      "#60a5fa",   // blue
    Docs:     "#94a3b8",   // slate
    Other:    "#4b5563",   // gray
  };

  function renderTreemapD3() {
    const container = document.getElementById("vis4-treemap-container");
    if (!container) return;
    container.innerHTML = "";

    if (typeof d3 === "undefined") {
      container.innerHTML = '<div class="vis4-empty">D3 not loaded — check /assets/d3.v7.min.js</div>';
      return;
    }

    const focusNode = getNode(st.focusPath);
    if (!focusNode) { container.innerHTML = '<div class="vis4-empty">No data.</div>'; return; }

    const W = Math.max(container.clientWidth || 600, 300);
    const H = Math.max(Math.round(W * 0.58), 340);

    const root = d3.hierarchy(focusNode)
      .sum(d => (!d.children || !d.children.length) ? Math.max(1, toNumber(d.size)) : 0)
      .sort((a, b) => b.value - a.value);

    d3.treemap()
      .size([W, H])
      .paddingOuter(3)
      .paddingInner(1)
      .paddingTop(18)
      .round(true)(root);

    const svg = d3.create("svg")
      .attr("width", W).attr("height", H)
      .attr("viewBox", `0 0 ${W} ${H}`)
      .style("display", "block").style("overflow", "hidden")
      .style("border-radius", "8px").style("background", "#070f18");

    // Folder header bands (non-leaf nodes)
    svg.selectAll(".tm-dir")
      .data(root.descendants().filter(d => d.depth > 0 && d.children))
      .join("g").attr("class","tm-dir")
      .attr("transform", d => `translate(${d.x0},${d.y0})`)
      .call(g => {
        g.append("rect")
          .attr("width", d => Math.max(0, d.x1-d.x0))
          .attr("height", 17)
          .attr("fill", "#35c98b").attr("opacity", 0.22).attr("rx", 2);
        g.append("text")
          .attr("x", 4).attr("y", 12)
          .attr("fill", "#6ee7b7").attr("font-size", "10px").attr("font-weight", "600")
          .text(d => {
            const avail = Math.floor((d.x1-d.x0) / 6.2);
            const name = d.data.name || "";
            return name.length > avail ? name.slice(0, avail-1)+"…" : name;
          });
        g.style("cursor","pointer")
          .on("click", (_, d) => { if (d.data.path) focus(d.data.path); });
      });

    // Leaf tiles
    const leaf = svg.selectAll(".tm-leaf")
      .data(root.leaves())
      .join("g").attr("class","tm-leaf")
      .attr("transform", d => `translate(${d.x0},${d.y0})`);

    leaf.append("rect")
      .attr("width",  d => Math.max(0, d.x1-d.x0))
      .attr("height", d => Math.max(0, d.y1-d.y0))
      .attr("fill", d => _TM_COLORS[categoryOf(d.data.name||"", false)] || _TM_COLORS.Other)
      .attr("opacity", 0.68).attr("rx", 2).attr("stroke","#070f18").attr("stroke-width",0.75);

    // Name label
    leaf.filter(d => (d.x1-d.x0) > 32 && (d.y1-d.y0) > 16)
      .append("text")
      .attr("x", 3).attr("y", 13)
      .attr("fill","#fff").attr("font-size","10px")
      .attr("pointer-events","none")
      .text(d => {
        const avail = Math.floor((d.x1-d.x0) / 5.8);
        const name = d.data.name || "";
        return name.length > avail ? name.slice(0, avail-1)+"…" : name;
      });

    // Size label
    leaf.filter(d => (d.x1-d.x0) > 44 && (d.y1-d.y0) > 30)
      .append("text")
      .attr("x", 3).attr("y", 25)
      .attr("fill","rgba(255,255,255,0.55)").attr("font-size","9px")
      .attr("pointer-events","none")
      .text(d => fmtBytes(d.data.size || d.value || 0));

    // Tooltip
    let _tip = document.getElementById("_tli_vis_tip");
    if (!_tip) {
      _tip = document.createElement("div");
      _tip.id = "_tli_vis_tip";
      _tip.style.cssText = "position:fixed;background:#050c14;border:1px solid #35c98b;color:#f5f7ff;padding:8px 12px;border-radius:8px;font-size:12px;pointer-events:none;z-index:9999;display:none;line-height:1.6;max-width:300px;word-break:break-all;box-shadow:0 4px 16px rgba(0,0,0,.5);";
      document.body.appendChild(_tip);
    }
    leaf.on("mousemove", (event, d) => {
      _tip.style.display = "block";
      _tip.style.left = (event.clientX+14)+"px";
      _tip.style.top  = (event.clientY-36)+"px";
      const cat = categoryOf(d.data.name||"",false);
      _tip.innerHTML = `<b style="color:#6ee7b7">${esc(d.data.name||"")}</b><br>${esc(fmtBytes(toNumber(d.data.size||d.value||0)))} · <span style="color:#35c98b">${esc(cat)}</span><br><span style="color:#6b7a8a;font-size:10px">${esc(d.data.path||"")}</span>`;
    }).on("mouseleave", () => { _tip.style.display = "none"; });

    leaf.style("cursor","pointer")
      .on("click", (_, d) => {
        select({ name: d.data.name||"", path: d.data.path||"", size: toNumber(d.data.size||d.value||0), isDir:false, category: categoryOf(d.data.name||"",false) });
      })
      .on("contextmenu", (event, d) => showVisContextMenu(event, d.data.path||d.data.name||"", false, d.data.deletable !== false));

    container.appendChild(svg.node());
  }

  // ── renderAll ────────────────────────────────────────────────────────────
  function renderAll(){
    renderTree();       // creates #vis4-breadcrumb-row, then calls renderBreadcrumb internally
    renderInsights();

    const tableWrap = tbody && tbody.closest(".vis4-table-wrap");
    const tmContainer = document.getElementById("vis4-treemap-container");
    const isMap = st.mode === "map";

    if (tableWrap) tableWrap.style.display = isMap ? "none" : "";
    if (tmContainer) tmContainer.style.display = isMap ? "block" : "none";

    if (isMap) {
      renderTreemapD3();
    } else {
      renderTable();
    }
  }

  renderAll();
}

function getNodePath(node) {
  if (!node) return null;

  const ancestors = node.ancestors().reverse();
  const root = ancestors[0];

  // Full absolute path of the scanned directory
  const rootPath = root.data?.path || root.data?.name || "";

  // Build tail path from children
  const parts = ancestors
    .slice(1)
    .map(a => a.data?.name)
    .filter(Boolean);

  let sep = "\\"; // Windows default
  if (rootPath.includes("/")) sep = "/";

  const tail = parts.join(sep);

  // Ensure proper joining:
  // rootPath + "\" + subdirs...
  if (!tail) return rootPath;

  return rootPath.replace(/[\\\/]$/, "") + sep + tail;
}


// Re-render on resize so the treemap always fills the panel nicely
window.addEventListener("resize", () => {
  if (lastVisualizerData) {
    renderStorageExplorer(lastVisualizerData);
  }
});






