// ---------- FILES PANEL ----------

const FILES_LAST_ROOT_KEY = "tli_files_last_root_v1";
const FILES_BUCKET_DEST_KEY = "tli_files_bucket_dests_v1";

let filesLastScanBuckets = null;
let filesBucketDestinations = {};

function filesLoadSavedDestinations() {
  try {
    const raw = window.localStorage.getItem(FILES_BUCKET_DEST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      filesBucketDestinations = parsed;
    }
  } catch (err) {
    console.warn("Failed to load saved File Organizer destinations:", err);
  }
}

function filesSaveDestinations() {
  try {
    window.localStorage.setItem(
      FILES_BUCKET_DEST_KEY,
      JSON.stringify(filesBucketDestinations || {})
    );
  } catch (err) {
    console.warn("Failed to persist File Organizer destinations:", err);
  }
}

// Category accent colors — must match the treemap + type-bar palette
const FO_CAT_COLORS = {
  Images: "#ec4899", Photos: "#ec4899",
  Video: "#f59e0b", Videos: "#f59e0b",
  Audio: "#22d3ee",
  Documents: "#60a5fa", Docs: "#60a5fa",
  Archives: "#a78bfa",
  Installers: "#f97316",
  Code: "#35c98b", Dev: "#35c98b",
  Models: "#a78bfa",
  Other: "#6b7280",
};

function _foSetActiveTile(kind) {
  document.querySelectorAll("[data-files-preset]").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-files-preset") === kind);
  });
}

function filesSetPreset(kind) {
  const path = _tliPathPreset(kind);
  const input = $("filesRootInput");
  if (input) {
    input.value = path;
    try { window.localStorage.setItem(FILES_LAST_ROOT_KEY, path); } catch { /* ignore */ }
  }
  _foSetActiveTile(kind);
  // Auto-scan on tile click
  filesScanFolder();
}

function filesSetStatus(msg) {
  const el = $("filesStatus");
  if (el) el.textContent = msg;
  debugLog("info", "[FILES] " + msg);
}

function filesRenderExtensionTable(extSummary) {
  const tbody = $("filesExtTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!extSummary || !extSummary.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3">No files detected in this folder.</td>`;
    tbody.appendChild(tr);
    return;
  }

  extSummary.forEach(row => {
    const tr = document.createElement("tr");
    const ext = row.extension || row.ext || "(none)";
    const count = row.count ?? 0;
    const example = row.example || "";
    tr.innerHTML = `<td>${ext}</td><td>${count}</td><td title="${example}">${example}</td>`;
    tbody.appendChild(tr);
  });
}

function filesRenderBuckets() {
  const container = $("filesBucketsContainer");
  if (!container) return;
  container.innerHTML = "";

  if (!filesLastScanBuckets) {
    container.innerHTML = '<p class="fo-empty-state">Scan a folder to see the plan.</p>';
    return;
  }

  const buckets = filesLastScanBuckets.buckets || {};
  const names = Object.keys(buckets);
  if (!names.length) {
    container.innerHTML = '<p class="fo-empty-state">No files found in this folder.</p>';
    return;
  }

  // Sort: largest bucket first
  names.sort((a, b) => (buckets[b] || []).length - (buckets[a] || []).length);

  const scanRoot = ($("filesRootInput")?.value || "").trim();

  names.forEach(name => {
    const files = buckets[name] || [];
    const catColor = FO_CAT_COLORS[name] || FO_CAT_COLORS.Other;

    if (!filesBucketDestinations[name]) {
      filesBucketDestinations[name] = name;
    }

    // Preview: first 3 filenames
    const preview = files.slice(0, 3).map(f => {
      const fn = typeof f === "string" ? f.split(/[\\\/]/).pop() : (f.name || f.filename || "");
      return fn;
    }).filter(Boolean).join(", ") + (files.length > 3 ? ` +${files.length - 3} more` : "");

    const row = document.createElement("div");
    row.className = "files-bucket-row";
    row.style.borderLeftColor = catColor;

    row.innerHTML = `
      <div class="files-bucket-main">
        <div class="files-bucket-name">${escapeHtml(name)}</div>
        <div class="files-bucket-count">${files.length} files</div>
        ${scanRoot ? `<button class="pill-btn ghost files-bucket-vis-btn" data-path="${escapeHtml(scanRoot)}" title="View ${escapeHtml(name)} files in Visualizer">⬡ Visualize</button>` : ""}
      </div>
      ${preview ? `<div class="files-bucket-preview">${escapeHtml(preview)}</div>` : ""}
      <div class="files-bucket-dest-row">
        <label class="files-bucket-dest-label">→ Destination subfolder</label>
        <input type="text" class="files-bucket-input" value="${escapeHtml(filesBucketDestinations[name])}"/>
      </div>`;

    const input = row.querySelector("input");
    input.addEventListener("input", () => {
      filesBucketDestinations[name] = input.value.trim();
      filesSaveDestinations();
    });

    const visBtn = row.querySelector(".files-bucket-vis-btn");
    if (visBtn) {
      visBtn.addEventListener("click", () => {
        const p = visBtn.getAttribute("data-path");
        if (p) switchPanelAndScan("panel-visualizer", p);
      });
    }

    container.appendChild(row);
  });
}
// Helper used by the Quick actions cards.
// It assumes /file/scan has already been run and filled filesLastScanBuckets.
function filesApplyQuick(bucketName, destName, description) {
  if (!filesLastScanBuckets) {
    showToast("Scan this folder first so TLI can see what's inside.");
    return;
  }

  const buckets = filesLastScanBuckets.buckets || {};
  const files = buckets[bucketName];

  if (!files || !files.length) {
    filesSetStatus(`No "${bucketName}" bucket found in this folder.`);
    debugLog("info", `[FILES] Quick action: no ${bucketName} bucket for current scan.`);
    return;
  }

  // Set or update the destination name for this bucket.
  filesBucketDestinations[bucketName] = destName;
  filesRenderBuckets();

  const msg = description || `Prepared quick action for "${bucketName}" → "${destName}/".`;
  filesSetStatus(msg);
  debugLog(
    "info",
    `[FILES] Quick action applied for ${bucketName} → ${destName}, ${files.length} files in bucket.`
  );
}

function filesBuildOrganizePayload() {
  if (!filesLastScanBuckets) return null;
  const basePath = ($("filesRootInput")?.value || "").trim();
  const buckets = filesLastScanBuckets.buckets || {};
  const actions = {};

  Object.entries(buckets).forEach(([bucketName, fileList]) => {
    const destName = (filesBucketDestinations[bucketName] || "").trim();
    if (!destName || !fileList || !fileList.length) return;
    actions[destName] = fileList.slice();
  });

  if (!basePath || !Object.keys(actions).length) return null;
  return { path: basePath, actions };
}

async function filesScanFolder() {
  const path = ($("filesRootInput")?.value || "").trim();
  if (!path) {
    showToast("Enter a folder path first.");
    return;
  }

  filesSetStatus("Scanning folder…");
  debugLog("info", "POST /files/scan root=" + path);

  // Persist last-used root for the next session.
  try {
    window.localStorage.setItem(FILES_LAST_ROOT_KEY, path);
  } catch {
    /* ignore */
  }

  try {
    const extRes = await fetch("/files/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: path })
    });
    if (!extRes.ok) {
      const txt = await extRes.text();
      filesSetStatus("Scan failed: " + extRes.status + " · " + txt);
      debugLog("error", "POST /files/scan failed: " + extRes.status + " · " + txt);
      return;
    }
    const extData = await extRes.json();
    filesRenderExtensionTable(extData.extension_summary || []);

    const bucketRes = await fetch("/file/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    if (!bucketRes.ok) {
      const txt = await bucketRes.text();
      filesSetStatus("Scan failed (buckets): " + bucketRes.status + " · " + txt);
      debugLog("error", "POST /file/scan failed: " + bucketRes.status + " · " + txt);
      return;
    }
    const bucketData = await bucketRes.json();
    filesLastScanBuckets = bucketData;
    filesRenderBuckets();

    const total = bucketData.total_files ?? 0;
    const bucketCount = Object.keys(bucketData.buckets || {}).length;
    filesSetStatus(`Scan complete: ${total} files in ${bucketCount} buckets.`);
    debugLog("info", "POST /file/scan OK, total_files=" + total + " buckets=" + bucketCount);

    // Show summary bar
    const summaryBar = $("fo-summary-bar");
    const summaryMeta = $("fo-summary-meta");
    const typeBars = $("fo-type-bars");
    const resultsSection = $("fo-results-section");
    if (summaryBar) summaryBar.style.display = "";
    if (resultsSection) resultsSection.style.display = "";
    if (summaryMeta) {
      const scanPath = ($("filesRootInput")?.value || "").trim();
      summaryMeta.innerHTML = `<strong>${total.toLocaleString()}</strong> files found across <strong>${bucketCount}</strong> categories in <code style="font-size:11px;opacity:.8">${scanPath}</code>`;
    }
    if (typeBars) {
      typeBars.innerHTML = "";
      const buckets = bucketData.buckets || {};
      const entries = Object.entries(buckets).sort((a,b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0));
      const maxCount = Math.max(1, entries[0]?.[1]?.length ?? 1);
      entries.forEach(([name, files]) => {
        const count = (files || []).length;
        const pct = Math.round((count / maxCount) * 100);
        const color = FO_CAT_COLORS[name] || FO_CAT_COLORS.Other;
        const row = document.createElement("div");
        row.className = "fo-type-bar-row";
        row.innerHTML = `<span class="fo-type-bar-label">${escapeHtml(name)}</span><div class="fo-type-bar-track"><div class="fo-type-bar-fill" style="width:${pct}%;background:${color}"></div></div><span class="fo-type-bar-count">${count}</span>`;
        typeBars.appendChild(row);
      });
    }
  } catch (err) {
    console.error(err);
    filesSetStatus("Scan error: " + err.message);
    filesLastScanBuckets = null;
    filesRenderBuckets();
    debugLog("error", "FILES scan error: " + err.message);
  }
}

async function filesPreviewOrganize() {
  const payload = filesBuildOrganizePayload();
  if (!payload) {
    showToast("Scan a folder first, then adjust bucket destinations.");
    return;
  }
  filesSetStatus("Building preview plan…");
  try {
    const res = await fetch("/file/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, confirm: false })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Preview failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/organize preview failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const plan = data.plan || {};
    let fileCount = 0;
    Object.values(plan).forEach(list => {
      fileCount += (list || []).length;
    });
    const destCount = Object.keys(plan).length;
    filesSetStatus(`Preview only – would move ${fileCount} files into ${destCount} folders.`);
    debugLog("info", "POST /file/organize preview OK, files=" + fileCount + " dests=" + destCount);
  } catch (err) {
    filesSetStatus("Preview error: " + err.message);
    debugLog("error", "FILES preview error: " + err.message);
  }
}

async function filesRunOrganize() {
  const payload = filesBuildOrganizePayload();
  if (!payload) {
    showToast("Scan a folder first, then adjust bucket destinations.");
    return;
  }
  if (
    !window.confirm(
      "Run organizer now? It will move files according to the suggested buckets (you can undo the last change)."
    )
  ) {
    return;
  }
  filesSetStatus("Organizing files…");
  try {
    const res = await fetch("/file/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, confirm: true })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Organize failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/organize confirm failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const moved = data.moved_count ?? 0;
    filesSetStatus(
      `Organize complete: moved ${moved} files. You can undo the last change if needed.`
    );
    filesLastScanBuckets = null;
    filesBucketDestinations = {};
    filesSaveDestinations();
    filesRenderBuckets();
    debugLog("info", "POST /file/organize confirm OK, moved=" + moved);
  } catch (err) {
    filesSetStatus("Organize error: " + err.message);
    debugLog("error", "FILES organize error: " + err.message);
  }
}

async function filesUndoLast() {
  if (!window.confirm("Undo the last file operation?")) return;
  filesSetStatus("Undoing last operation…");
  try {
    const res = await fetch("/file/undo", { method: "POST" });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Undo failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/undo failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const undone = data.undone ?? 0;
    const message = data.message || "Undo complete.";
    filesSetStatus(`${message} (${undone} entries reverted.)`);
    debugLog("info", "POST /file/undo OK, undone=" + undone);
  } catch (err) {
    filesSetStatus("Undo error: " + err.message);
    debugLog("error", "FILES undo error: " + err.message);
  }
}

async function filesBatchRename() {
  const prefix = ($("filesRenamePrefix")?.value || "").trim();
  const path = ($("filesRootInput")?.value || "").trim();
  if (!prefix || !path) {
    showToast("Enter both a folder path and a prefix before running batch rename.");
    return;
  }

  filesSetStatus("Renaming files…");
  debugLog("info", "POST /file/rename path=" + path + " prefix=" + prefix);

  try {
    const res = await fetch("/file/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, prefix })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Rename failed: " + res.status + " · " + txt);
      debugLog("error", "POST /file/rename failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const count = data.count ?? 0;
    filesSetStatus(`Renamed ${count} files with the new prefix.`);
    debugLog("info", "POST /file/rename OK, count=" + count);
  } catch (err) {
    filesSetStatus("Rename error: " + err.message);
    debugLog("error", "FILES rename error: " + err.message);
  }
}

async function filesUseCustomRules() {
  const path = ($("filesRootInput")?.value || "").trim();
  const rulesText = ($("filesRulesTextarea")?.value || "").trim();
  if (!path) {
    showToast("Enter a folder path first.");
    return;
  }
  if (!rulesText) {
    showToast("Describe your organization rules first.");
    return;
  }

  filesSetStatus("Asking AI to propose an organization plan…");

  try {
    const res = await fetch("/files/apply_rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: path, rules: rulesText })
    });
    if (!res.ok) {
      const txt = await res.text();
      filesSetStatus("Rules planner failed: " + res.status + " · " + txt);
      debugLog("error", "POST /files/apply_rules failed: " + res.status + " · " + txt);
      return;
    }
    const data = await res.json();
    const summary = data.summary || "No plan returned.";
    $("filesRulesSummary").textContent = summary;
    filesSetStatus("Rules plan ready – review the summary on the right.");
    debugLog("info", "POST /files/apply_rules OK");
  } catch (err) {
    filesSetStatus("Rules planner error: " + err.message);
    debugLog("error", "FILES rules planner error: " + err.message);
  }
}

// NEW: Files AI insight power
async function filesAskAiAboutFolder() {
  const path = ($("filesRootInput")?.value || "").trim();
  const box = $("filesInsightBox");
  const btn = $("filesInsightButton");

  if (!box) {
    console.warn("filesInsightBox element is missing.");
    debugLog("warn", "filesInsightBox missing in DOM.");
    return;
  }

  if (!path) {
    box.textContent = "Enter a folder path first, then ask for insight.";
    return;
  }

  let originalLabel = null;
  if (btn) {
    originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Analyzing…";
  }

  box.textContent =
    "Asking your local model for a high-level summary of this folder…";
  debugLog("info", "POST /files/insight root=" + path);

  try {
    const res = await fetch("/files/insight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: path })
    });

    if (!res.ok) {
      let detail = "";
      try {
        const txt = await res.text();
        detail = txt || res.statusText;
      } catch {
        detail = res.statusText;
      }
      box.textContent = "Insight request failed: " + res.status + " · " + detail;
      debugLog("error", "POST /files/insight failed: " + res.status + " · " + detail);
      return;
    }

    const data = await res.json();
    const text =
      data.summary ||
      data.insight ||
      "No insight returned from your local model.";

    box.textContent = text;
    debugLog("info", "POST /files/insight OK");
  } catch (err) {
    console.error("files/insight error:", err);
    box.textContent =
      "Error contacting your local model for folder insight: " + err.message;
    debugLog("error", "FILES insight error: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      if (originalLabel !== null) btn.textContent = originalLabel;
    }
  }
}

function setupFilesPanel() {
  const root = $("filesRootInput");
  if (!root) return;

  // Quick presets — auto-scan and mark active tile
  document.querySelectorAll("[data-files-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      filesSetPreset(btn.getAttribute("data-files-preset"));
    });
  });

  // Manual path entry → clear active tile selection
  root.addEventListener("input", () => {
    document.querySelectorAll("[data-files-preset]").forEach(b => b.classList.remove("active"));
  });

  // "Scan in Visualizer" button
  $("filesScanInVisButton")?.addEventListener("click", () => {
    const p = (root.value || "").trim();
    if (!p) { showToast("Enter a path first."); return; }
    switchPanelAndScan("panel-visualizer", p);
  });

  // Main controls
  $("filesScanButton")?.addEventListener("click", filesScanFolder);
  $("filesPreviewButton")?.addEventListener("click", filesPreviewOrganize);
  $("filesRunButton")?.addEventListener("click", filesRunOrganize);
  $("filesUndoButton")?.addEventListener("click", filesUndoLast);
  $("filesBatchRenameButton")?.addEventListener("click", filesBatchRename);
  $("filesCustomRulesButton")?.addEventListener("click", filesUseCustomRules);
  $("filesInsightButton")?.addEventListener("click", filesAskAiAboutFolder);

  // Quick action recipes
  $("filesQuickInstallers")?.addEventListener("click", () =>
    filesApplyQuick("Installers", "Installers", "installer files")
  );
  $("filesQuickArchives")?.addEventListener("click", () =>
    filesApplyQuick("Archives", "Archives", "archive files")
  );
  $("filesQuickImages")?.addEventListener("click", () =>
    filesApplyQuick("Images", "Images", "image files")
  );

  filesRenderBuckets();
  filesSetStatus("");
}


// ════════════════════════════════════════════════════════════════════════════
// PRINT & SCAN STUDIO
// ════════════════════════════════════════════════════════════════════════════

let _psScanToken  = null;   // token returned by /printshop/scan
let _psScanBlob   = null;   // downloaded blob for save-to-disk

function psSwitchTab(tab) {
  document.getElementById("ps-pane-print").hidden = tab !== "print";
  document.getElementById("ps-pane-scan").hidden  = tab !== "scan";
  document.getElementById("ps-tab-print").classList.toggle("active", tab === "print");
  document.getElementById("ps-tab-scan").classList.toggle("active",  tab === "scan");
}

function psSelectToggle(groupId, btn) {
  document.getElementById(groupId).querySelectorAll(".ps-toggle").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

function _psActiveVal(groupId) {
  const active = document.querySelector(`#${groupId} .ps-toggle.active`);
  return active ? active.dataset.val : null;
}

function psSetStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = "ps-status" + (type ? ` ps-status-${type}` : "");
  el.hidden = !msg;
}

// ── On panel open ─────────────────────────────────────────────────────────

let _psLoaded = false;

function switchToPrintShop(printerName) {
  switchPanel("panel-printshop");
  psSwitchTab("print");
  // Pre-select the printer — may need a moment if printers haven't loaded yet
  const trySelect = () => {
    const sel = document.getElementById("ps-printer-select");
    if (!sel) return;
    const opt = Array.from(sel.options).find(o => o.value === printerName);
    if (opt) {
      sel.value = printerName;
    } else if (sel.options.length <= 1) {
      // Still loading — wait and retry once
      setTimeout(() => {
        const opt2 = Array.from(sel.options).find(o => o.value === printerName);
        if (opt2) sel.value = printerName;
      }, 1200);
    }
  };
  // If printshop hasn't loaded yet, load it then select
  if (!_psLoaded) {
    psOnOpen();
    setTimeout(trySelect, 800);
  } else {
    trySelect();
  }
}

function psOnOpen() {
  if (_psLoaded) return;
  _psLoaded = true;
  psLoadPrinters();
  psLoadScanners();
}

// ── Printers ─────────────────────────────────────────────────────────────

async function psLoadPrinters() {
  const sel = document.getElementById("ps-printer-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const r = await fetch("/printshop/printers");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const printers = data.printers || [];

    // Show platform badge
    const tag = document.getElementById("ps-platform-tag");
    if (tag && data.platform) tag.textContent = data.platform;

    if (!printers.length) {
      sel.innerHTML = '<option value="">No printers found</option>';
      return;
    }
    const real    = printers.filter(p => !p.virtual);
    const virtual = printers.filter(p =>  p.virtual);
    let html = "";
    if (real.length) {
      html += real.map(p =>
        `<option value="${escapeHtml(p.name)}"${p.default ? " selected" : ""}>${escapeHtml(p.name)}${p.default ? " ✓" : ""}</option>`
      ).join("");
    }
    if (virtual.length) {
      html += `<optgroup label="Virtual printers">`;
      html += virtual.map(p =>
        `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`
      ).join("");
      html += `</optgroup>`;
    }
    sel.innerHTML = html;
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load printers</option>';
    console.error("[PS] printers:", e);
  }
}

// ── Scanners ──────────────────────────────────────────────────────────────

async function psLoadScanners() {
  const sel = document.getElementById("ps-scanner-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const r = await fetch("/printshop/scanners");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const scanners = data.scanners || [];
    if (!scanners.length) {
      sel.innerHTML = '<option value="">No scanners found</option>';
      return;
    }
    sel.innerHTML = scanners.map(s =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
    ).join("");
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load scanners</option>';
    console.error("[PS] scanners:", e);
  }
}

// ── File pick / drop ──────────────────────────────────────────────────────

let _psPrintFile = null;

function psPickFile(input) {
  const f = input.files[0];
  if (!f) return;
  _psPrintFile = f;
  const label = document.getElementById("ps-chosen-file");
  const dz    = document.getElementById("ps-dropzone");
  if (label) {
    label.textContent = `📄 ${f.name}  (${_psHumanSize(f.size)})`;
    label.hidden = false;
  }
  if (dz) dz.classList.add("ps-dropzone-has-file");
  psSetStatus("ps-print-status", "", "");
}

function psDrop(event) {
  event.preventDefault();
  document.getElementById("ps-dropzone")?.classList.remove("ps-dropzone-hover");
  const f = event.dataTransfer?.files?.[0];
  if (!f) return;
  _psPrintFile = f;
  const label = document.getElementById("ps-chosen-file");
  const dz    = document.getElementById("ps-dropzone");
  if (label) {
    label.textContent = `📄 ${escapeHtml(f.name)}  (${_psHumanSize(f.size)})`;
    label.hidden = false;
  }
  if (dz) dz.classList.add("ps-dropzone-has-file");
  psSetStatus("ps-print-status", "", "");
}

function _psHumanSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

// ── Print job ─────────────────────────────────────────────────────────────

async function psSendPrint() {
  const printer = document.getElementById("ps-printer-select")?.value;
  if (!printer) { psSetStatus("ps-print-status", "Select a printer first.", "warn"); return; }
  if (!_psPrintFile) { psSetStatus("ps-print-status", "Drop or pick a file to print.", "warn"); return; }

  const copies      = parseInt(document.getElementById("ps-copies")?.value || "1", 10);
  const scale       = parseInt(document.getElementById("ps-scale")?.value  || "100", 10);
  const colorVal    = _psActiveVal("ps-color-group")   || "color";
  const duplex      = _psActiveVal("ps-duplex-group")  || "none";
  const orientation = _psActiveVal("ps-orient-group")  || "portrait";
  const quality     = _psActiveVal("ps-quality-group") || "normal";
  const paperSize   = document.getElementById("ps-paper-size")?.value || "Letter";

  const btn = document.getElementById("ps-print-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  psSetStatus("ps-print-status", "Sending to printer…", "");

  try {
    const form = new FormData();
    form.append("file",        _psPrintFile);
    form.append("printer",     printer);
    form.append("copies",      String(copies));
    form.append("color",       colorVal === "color" ? "true" : "false");
    form.append("paper_size",  paperSize);
    form.append("duplex",      duplex);
    form.append("scale",       String(scale));
    form.append("orientation", orientation);
    form.append("quality",     quality);

    const r = await fetch("/printshop/print", { method: "POST", body: form });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(txt || "HTTP " + r.status);
    }
    const data = await r.json();
    const duplexLabel = { none: "", long: " · Duplex ↕", short: " · Duplex ↔" }[data.duplex] || "";
    psSetStatus("ps-print-status",
      `✓ Sent to ${data.printer} — ${data.copies} cop${data.copies === 1 ? "y" : "ies"} · ${data.orientation} · ${data.scale}%${duplexLabel}`,
      "ok");
  } catch (e) {
    psSetStatus("ps-print-status", "Print failed: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🖨️\u00a0 Print Document"; }
  }
}

// ── Test Print ───────────────────────────────────────────────────────────

async function psTestPrint() {
  const btn = document.getElementById("ps-test-print-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  psSetStatus("ps-print-status", "Sending TLI test page to default printer…", "");
  try {
    // Delegate to the existing window.testPrint if available (has the ASCII art + status updates)
    if (typeof window.testPrint === "function") {
      await window.testPrint();
      psSetStatus("ps-print-status", "✓ TLI test page sent to default printer", "ok");
    } else {
      const r = await fetch("/api/printers/test_print", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.message || j.detail || "HTTP " + r.status);
      psSetStatus("ps-print-status", "✓ TLI test page sent to default printer", "ok");
    }
  } catch (e) {
    psSetStatus("ps-print-status", "Test print failed: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Test Print"; }
  }
}

// ── Scan job ──────────────────────────────────────────────────────────────

async function psTriggerScan() {
  const scannerId = document.getElementById("ps-scanner-select")?.value;
  if (!scannerId) { psSetStatus("ps-scan-status", "Select a scanner first.", "warn"); return; }

  const resolution = parseInt(_psActiveVal("ps-res-group") || "300", 10);
  const colorMode  = _psActiveVal("ps-mode-group") || "color";

  // Clean up previous scan
  if (_psScanToken) {
    fetch(`/printshop/scan/${_psScanToken}`, { method: "DELETE" }).catch(() => {});
    _psScanToken = null;
    _psScanBlob  = null;
  }

  const btn = document.getElementById("ps-scan-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
  document.getElementById("ps-preview-wrap").hidden = true;
  psSetStatus("ps-scan-status", "Scanning — please wait…", "");

  try {
    const form = new FormData();
    form.append("scanner_id", scannerId);
    form.append("resolution", String(resolution));
    form.append("color_mode", colorMode);

    const r = await fetch("/printshop/scan", { method: "POST", body: form });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(txt || "HTTP " + r.status);
    }
    const data = await r.json();
    _psScanToken = data.token;

    // Fetch the scan result and show preview
    const imgResp = await fetch(`/printshop/scan/${_psScanToken}`);
    if (!imgResp.ok) throw new Error("Could not retrieve scan");
    _psScanBlob = await imgResp.blob();

    const url = URL.createObjectURL(_psScanBlob);
    const img = document.getElementById("ps-preview-img");
    if (img) img.src = url;
    document.getElementById("ps-preview-wrap").hidden = false;
    psSetStatus("ps-scan-status", `✓ Scan complete — ${resolution} DPI · ${colorMode}`, "ok");
  } catch (e) {
    psSetStatus("ps-scan-status", "Scan failed: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "📸\u00a0 Scan Now"; }
  }
}

function psDownloadScan() {
  if (!_psScanBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(_psScanBlob);
  a.download = `tli-scan-${Date.now()}.png`;
  a.click();
}

function psDiscardScan() {
  if (_psScanToken) {
    fetch(`/printshop/scan/${_psScanToken}`, { method: "DELETE" }).catch(() => {});
    _psScanToken = null;
  }
  _psScanBlob = null;
  const img = document.getElementById("ps-preview-img");
  if (img) img.src = "";
  document.getElementById("ps-preview-wrap").hidden = true;
  psSetStatus("ps-scan-status", "", "");
}


