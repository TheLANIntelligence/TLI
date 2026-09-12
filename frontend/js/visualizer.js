// ---------- VISUALIZER (Treemap + filters) ----------
// ---------- Explicit saved storage observations ----------
(function () {
  const protocol = "storage-history-v1";
  let current = null, saved = [], busy = false, epoch = 0, initialized = false, pendingRemove = null;
  const $ = id => document.getElementById(id);
  const node = (tag, text, id) => { const el = document.createElement(tag); if (text) el.textContent = text; if (id) el.id = id; return el; };
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const validSummary = value => value && /^[a-f0-9]{32}$/.test(value.id) && value.version === 1 &&
    typeof value.root === "string" && typeof value.scanned_at === "string" && Number.isFinite(Date.parse(value.scanned_at)) &&
    typeof value.host?.id === "string" && typeof value.host.name === "string" &&
    ["known", "unknown", "changed"].includes(value.drive?.status) &&
    (value.drive.status !== "known" || /^[a-f0-9]{64}$/.test(value.drive.fingerprint)) &&
    typeof value.coverage?.complete === "boolean" && Array.isArray(value.coverage.reasons) && value.coverage.reasons.every(r => typeof r === "string") &&
    integer(value.total_bytes) && integer(value.direct_file_bytes) &&
    integer(value.filters?.max_depth) && integer(value.filters.max_entries) && integer(value.filters.max_seconds) &&
    value.filters.follow_links === false && Array.isArray(value.filters.excluded_names) && value.filters.excluded_names.every(n => typeof n === "string");
  const validScan = value => value?.protocol === protocol && value.available === true && value.version === 1 &&
    /^[a-f0-9]{32}$/.test(value.scan_id) && validSummary(value.summary) && value.summary.id === value.scan_id &&
    typeof value.expires_at === "number" && Number.isFinite(value.expires_at);
  const bytes = value => {
    const sign = value < 0 ? "−" : ""; let amount = Math.abs(value), unit = 0;
    const units = ["B", "KB", "MB", "GB", "TB"];
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return sign + amount.toLocaleString(undefined, {maximumFractionDigits: unit ? 1 : 0}) + " " + units[unit];
  };
  const delta = value => (value > 0 ? "+" : "") + bytes(value);
  const date = value => new Date(value).toLocaleString();
  function status(message) { if ($("storage-history-status")) $("storage-history-status").textContent = message; }
  function controls() {
    if (!initialized) return;
    const available = current && current.expires_at * 1000 > Date.now();
    $("storage-history-save").disabled = busy || !available || saved.some(s => s.id === current.scan_id);
    $("storage-history-load").disabled = busy;
    $("storage-history-baseline").disabled = busy || !saved.length;
    $("storage-history-remove").disabled = busy || !$("storage-history-baseline").value;
    const removeConfirm = $("storage-history-remove-confirm"); if (removeConfirm) removeConfirm.disabled = busy;
    $("storage-history-compare").disabled = busy || !available || !$("storage-history-baseline").value || $("storage-history-baseline").value === current?.scan_id;
  }
  function list() {
    const select = $("storage-history-baseline"), selected = select.value;
    select.replaceChildren(node("option", "Choose a saved scan")); select.children[0].value = "";
    for (const summary of saved) {
      const option = node("option", `${date(summary.scanned_at)} · ${summary.root} · ${summary.coverage.complete ? "Complete coverage" : "Partial coverage"}`);
      option.value = summary.id; select.appendChild(option);
    }
    select.value = saved.some(row => row.id === selected) ? selected : saved.find(row => row.id !== current?.scan_id)?.id || "";
    controls();
  }
  function describe(summary, label) {
    const line = node("p", `${label}: ${summary.root} · ${date(summary.scanned_at)} · ${summary.host.name} · ${bytes(summary.total_bytes)} inspected file bytes.`);
    line.appendChild(node("span", summary.coverage.complete ? " Coverage complete within the recorded scan policy." :
      " Partial coverage: " + summary.coverage.reasons.join("; ") + "."));
    if (summary.drive.status !== "known") line.appendChild(node("span", " Drive/folder identity unavailable or changed; comparison is blocked."));
    return line;
  }
  async function request(url, payload, method) {
    const res = await fetch(url, method === "DELETE" ? {method} : payload ? {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)} :
      {method: "GET", cache: "no-store"});
    let data; try { data = await res.json(); } catch { throw new Error("The host returned an unreadable result."); }
    if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Request failed (${res.status}).`);
    if (data?.ok !== true || data.protocol !== protocol) throw new Error("This running TLI host does not confirm saved-scan support. Restart the updated backend and scan again.");
    return data;
  }
  async function act(fn) {
    if (busy) return;
    busy = true; controls(); const revision = epoch;
    try { await fn(revision); } catch (error) { if (revision === epoch) status(error.message + " No scan or retry ran automatically."); }
    finally { if (revision === epoch) { busy = false; controls(); } }
  }
  function save() {
    if (!validScan(current) || current.expires_at * 1000 <= Date.now()) { status("Scan the folder again before saving; this observation is unavailable or expired."); return; }
    const scan = current;
    return act(async revision => {
      const data = await request("/visualizer/history/save", {scan_id: scan.scan_id, version: 1});
      if (revision !== epoch) return;
      if (data.saved !== true || !validSummary(data.snapshot) || data.snapshot.id !== scan.scan_id ||
          data.snapshot.root !== scan.summary.root || data.snapshot.scanned_at !== scan.summary.scanned_at ||
          data.snapshot.total_bytes !== scan.summary.total_bytes) throw new Error("Saving this scan was not confirmed. Reload saved scans before trying again.");
      saved = [data.snapshot, ...saved.filter(s => s.id !== data.snapshot.id)]; list();
      status("Scan summary saved for this account. No files or file contents were copied. Partial observations cannot establish growth.");
    });
  }
  function load() {
    return act(async revision => {
      const data = await request("/visualizer/history");
      if (revision !== epoch) return;
      if (!Array.isArray(data.snapshots) || data.snapshots.length > 20 || !data.snapshots.every(validSummary) ||
          new Set(data.snapshots.map(s => s.id)).size !== data.snapshots.length) throw new Error("Saved scan history has an invalid format; it was not displayed.");
      saved = data.snapshots; list(); status(`${saved.length} of 20 saved summaries loaded. Select an earlier scan to compare.`);
    });
  }
  function cancelRemove() {
    pendingRemove = null; $("storage-history-remove-review")?.replaceChildren();
  }
  function reviewRemove() {
    if (busy) return;
    const selected = saved.find(row => row.id === $("storage-history-baseline").value);
    if (!selected) return;
    pendingRemove = selected.id;
    const box = $("storage-history-remove-review");
    box.replaceChildren(node("p", `Remove the saved summary for ${selected.root}, observed ${date(selected.scanned_at)}? Only this summary will be removed. The folder and its files will not be touched.`));
    const confirm = node("button", "Remove this saved summary", "storage-history-remove-confirm"); confirm.className = "pill-btn ghost";
    confirm.addEventListener("click", () => {
      if (pendingRemove !== selected.id || $("storage-history-baseline").value !== selected.id) return;
      return act(async revision => {
        const data = await request("/visualizer/history/" + selected.id, null, "DELETE");
        if (revision !== epoch) return;
        if (data.deleted !== true || data.snapshot_id !== selected.id) throw new Error("Removal of the saved summary was not confirmed. Reload saved scans before trying again.");
        saved = saved.filter(row => row.id !== selected.id); cancelRemove(); list();
        $("storage-history-result").replaceChildren(); status("Saved summary removed. The folder and its files were not changed.");
      });
    });
    const cancel = node("button", "Cancel"); cancel.className = "pill-btn ghost"; cancel.addEventListener("click", cancelRemove);
    box.append(confirm, cancel);
  }
  function compare() {
    const baselineId = $("storage-history-baseline").value, scan = current;
    if (!validScan(scan) || scan.expires_at * 1000 <= Date.now() || !saved.some(s => s.id === baselineId)) {
      status("Select a saved baseline and scan the folder again if the current observation expired."); return;
    }
    return act(async revision => {
      const data = await request("/visualizer/history/compare", {baseline_id: baselineId, scan_id: scan.scan_id, version: 1});
      if (revision !== epoch) return;
      if (typeof data.comparable !== "boolean" || data.point_in_time !== true || !validSummary(data.baseline) || !validSummary(data.current) ||
          data.baseline.id !== baselineId || data.current.id !== scan.scan_id || !Array.isArray(data.reasons) ||
          data.reasons.some(r => typeof r !== "string") || !Array.isArray(data.folders) || data.folders.length > 200) throw new Error("The comparison result could not be validated.");
      if (data.comparable && (!data.baseline.coverage.complete || !data.current.coverage.complete || data.reasons.length ||
          data.baseline.root !== data.current.root || data.baseline.host.id === "unknown" || data.baseline.host.id !== data.current.host.id ||
          data.baseline.drive.status !== "known" || data.current.drive.status !== "known" || data.baseline.drive.fingerprint !== data.current.drive.fingerprint ||
          Date.parse(data.baseline.scanned_at) >= Date.parse(data.current.scanned_at) ||
          ["max_depth", "max_entries", "max_seconds"].some(k => data.baseline.filters[k] !== data.current.filters[k]) ||
          data.baseline.filters.excluded_names.join("\0") !== data.current.filters.excluded_names.join("\0") ||
          !integer(data.totals?.before_bytes) || !integer(data.totals.after_bytes) || !Number.isSafeInteger(data.totals.delta_bytes) ||
          !Number.isSafeInteger(data.totals.direct_file_delta_bytes) || data.totals.delta_bytes !== data.totals.after_bytes - data.totals.before_bytes ||
          data.totals.before_bytes !== data.baseline.total_bytes || data.totals.after_bytes !== data.current.total_bytes ||
          data.totals.direct_file_delta_bytes !== data.current.direct_file_bytes - data.baseline.direct_file_bytes ||
          data.folders.some(row => !row || typeof row.name !== "string" || !["grew", "shrank", "newly_observed", "not_observed"].includes(row.status) ||
            (row.before_bytes !== null && !integer(row.before_bytes)) || (row.after_bytes !== null && !integer(row.after_bytes)) ||
            (row.status === "newly_observed" ? row.before_bytes !== null || !integer(row.after_bytes) || row.delta_bytes !== null :
              row.status === "not_observed" ? row.after_bytes !== null || !integer(row.before_bytes) || row.delta_bytes !== null :
                !integer(row.before_bytes) || !integer(row.after_bytes) || !Number.isSafeInteger(row.delta_bytes) ||
                row.delta_bytes !== row.after_bytes - row.before_bytes || (row.status === "grew" ? row.delta_bytes <= 0 : row.delta_bytes >= 0))))) throw new Error("Growth was not confirmed by a consistent comparison result.");
      if (!data.comparable && (data.totals !== null || data.folders.length || !data.reasons.length)) throw new Error("An incomplete comparison returned unsupported growth claims.");
      const box = $("storage-history-result"); box.replaceChildren(describe(data.baseline, "Saved baseline"), describe(data.current, "Current observation"));
      if (!data.comparable) {
        box.appendChild(node("p", "Comparison unavailable: " + data.reasons.join(" ")));
      } else {
        box.appendChild(node("strong", `Inspected file bytes changed by ${delta(data.totals.delta_bytes)} (${bytes(data.totals.before_bytes)} → ${bytes(data.totals.after_bytes)}).`));
        box.appendChild(node("p", `Files directly in this folder changed by ${delta(data.totals.direct_file_delta_bytes)}.`));
        const rows = node("ol");
        for (const item of data.folders) {
          const change = item.status === "newly_observed" ? `Newly observed · ${bytes(item.after_bytes)}` :
            item.status === "not_observed" ? `Not observed in the later scan · previously ${bytes(item.before_bytes)}` :
            `${item.status === "grew" ? "Grew" : "Shrank"} ${delta(item.delta_bytes)} · ${bytes(item.before_bytes)} → ${bytes(item.after_bytes)}`;
          rows.appendChild(node("li", `${item.name}: ${change}`));
        }
        box.appendChild(rows);
        if (!data.folders.length) box.appendChild(node("p", "No immediate-folder size changes were observed."));
        if (data.folders_limited) box.appendChild(node("p", "Only the largest 200 changed folder entries are shown."));
        box.appendChild(node("p", "Newly observed and not observed names may reflect renames or moves; they do not prove creation or deletion."));
      }
      box.appendChild(node("p", "Point-in-time observations only. This did not check whether the drive is currently connected. File sizes can differ from space used on disk. No files were changed."));
      status(data.comparable ? "Comparison ready." : "Comparison unavailable; no growth or shrinkage is claimed.");
    });
  }
  function beginScan(preservePrevious = false) {
    epoch++; busy = preservePrevious;
    if (!preservePrevious) current = null;
    if (initialized) {
      cancelRemove();
      if (!preservePrevious) { $("storage-history-current").replaceChildren(); $("storage-history-result").replaceChildren(); }
      status(preservePrevious ? "A new scan is running. The previous observation stays visible until it succeeds." : "Finish a new scan to save or compare its observation."); controls();
    }
  }
  function scanFailed() {
    busy = false;
    if (initialized) { status(current ? "The new scan failed. The previous observation is retained with its original scan time and expiry." : "No new observation was saved. Retry the scan when the folder is available."); controls(); }
  }
  function receiveScan(data) {
    beginScan();
    if (!initialized) return;
    const scan = data?.meta?.saved_scan;
    if (!validScan(scan)) { status("Saving and comparison require a scan from the updated TLI backend. Existing scan results remain available."); return; }
    current = scan;
    const info = $("storage-history-current"); info.appendChild(describe(scan.summary, "Latest scan"));
    const filters = scan.summary.filters;
    info.appendChild(node("p", `Policy: depth ${filters.max_depth}, up to ${filters.max_entries.toLocaleString()} entries, ${filters.max_seconds} seconds; links excluded. Excluded names: ${filters.excluded_names.join(", ") || "none"}.`));
    status("Save this observation explicitly, or compare it with an earlier saved scan. The current summary expires after 30 minutes."); controls();
  }
  function setup() {
    if (initialized || !$("vis4-summary")) return;
    initialized = true;
    const box = node("section", "", "storage-history"); box.className = "storage-history card-section"; box.setAttribute("aria-labelledby", "storage-history-title");
    box.append(node("h3", "What grew?", "storage-history-title"),
      node("p", "Explicitly save a folder scan, then compare a later scan. History is private to this account. These summaries use the full scanned scope; map and display filters do not change saved totals."),
      node("div", "", "storage-history-current"));
    const buttons = node("div"); buttons.className = "storage-history-controls";
    for (const [id, label, action] of [["storage-history-save", "Save scan", save], ["storage-history-load", "Load saved scans", load]]) {
      const button = node("button", label, id); button.className = "pill-btn ghost"; button.addEventListener("click", action); buttons.appendChild(button);
    }
    const label = node("label", "Compare against saved scan ");
    const select = node("select", "", "storage-history-baseline"); select.addEventListener("change", () => { cancelRemove(); controls(); }); label.appendChild(select);
    const button = node("button", "Compare", "storage-history-compare"); button.className = "pill-btn primary"; button.addEventListener("click", compare);
    const remove = node("button", "Remove selected saved scan", "storage-history-remove"); remove.className = "pill-btn ghost"; remove.addEventListener("click", reviewRemove);
    const message = node("p", "Scan a folder to begin.", "storage-history-status"); message.setAttribute("role", "status");
    box.append(buttons, label, button, remove, node("div", "", "storage-history-remove-review"), message, node("div", "", "storage-history-result"));
    if ($("fs-view-history")) $("fs-view-history").append(box); else $("vis4-summary").after(box); list(); controls();
    const clear = () => { beginScan(); saved = []; list(); status(""); };
    window.addEventListener("tli-session-locked", clear); window.addEventListener("pagehide", event => { if (!event.persisted) clear(); });
  }
  window.TLIStorageHistory = {setup, beginScan, receiveScan, scanFailed};
})();
// ---------- End saved storage observations ----------
function visEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[c]);
}

async function visFetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.json();
}

function visScanFailure(error, received = false) {
  if (received) return "The scan returned, but its results could not be displayed. Refresh TLI and try again.";
  if (error.status === 401) return "Your TLI session expired. Unlock TLI, then try again.";
  if (error.status === 403) return "TLI denied access to this scan. Check your session and access permissions.";
  if (error.status === 404) return "The folder or scan endpoint was not found. Check the path on the TLI host; if you just updated TLI, restart its backend.";
  if (error.status === 400) return "The scan path was rejected. Choose an existing folder on the TLI host.";
  if (error.status === 422) return "The backend rejected the scan request. If you just updated TLI, restart its backend and refresh this page.";
  if (error.status >= 500) return `The TLI backend could not complete the scan (HTTP ${error.status}). If you just updated TLI, restart its backend and retry.`;
  return "The scan connection failed or returned an invalid response. Check that TLI is running, then retry.";
}

// Review candidates are not a claim that these bytes can safely be reclaimed.
function visReview(tree) {
  const files = [];
  let protectedBytes = 0;
  const visit = (node, inherited = false) => {
    if (!node || node.synthetic) return;
    const protectedPath = inherited || node.protected || isProtectedSystemPathClient(node.path || "");
    if (Array.isArray(node.children)) {
      node.children.forEach(child => visit(child, protectedPath));
    } else if (protectedPath) {
      protectedBytes += Number(node.size) || 0;
    } else if (node.size > 0) {
      files.push(node);
    }
  };
  visit(tree);
  files.sort((a, b) => b.size - a.size);
  return { files: files.slice(0, 3), protectedBytes };
}

function visCoverage(meta) {
  if (!meta || typeof meta.partial !== "boolean") return "Scan coverage is unknown. Sizes represent only files inspected.";
  const reasons = [];
  if (meta.denied) reasons.push(`${meta.denied} unreadable ${meta.denied === 1 ? "entry" : "entries"}`);
  if (meta.skipped) reasons.push(`${meta.skipped} excluded folders or links`);
  if (meta.depth_limited) reasons.push("folder depth limit reached");
  if (meta.entry_limited) reasons.push("entry limit reached");
  if (meta.time_limited) reasons.push("time limit reached");
  if (meta.cancelled) reasons.push("stopped before all entries were inspected");
  const representation = meta.representation_limited ? " The returned tree is limited; some inspected paths are grouped or omitted. Select a smaller location and scan explicitly to inspect them." : "";
  return (meta.partial
    ? `Partial scan: ${reasons.join("; ") || "some entries were not inspected"}. Scan a specific folder for more detail.`
    : "Scan finished within its limits. File sizes can differ from space used on disk.") + representation;
}

function visCleanupCoverage(target) {
  if (target.size_partial === false) return "File sizes inspected; this is not a promise of reclaimable space.";
  if (target.size_partial !== true) return "Estimate coverage is unknown. Review the folder before acting.";
  const meta = target.size_meta || {};
  const reasons = [];
  if (meta.denied) reasons.push("some entries could not be read");
  if (meta.skipped) reasons.push("links were skipped");
  if (meta.time_limited) reasons.push("time limit reached");
  if (meta.entry_limited) reasons.push("entry limit reached");
  if (meta.byte_limited) reasons.push("size limit reached");
  return `Partial estimate: ${reasons.join("; ") || "some entries were not inspected"}. Scan this folder for more detail.`;
}

function visDuplicateCoverage(meta) {
  if (meta?.verification !== "full_sha256") return "These matches have not been verified by a full-content check. Restart the updated TLI backend and scan again before relying on them.";
  const notes = ["Files of 4 KB or more; matching files were checked in full. Copies may be needed by separate apps or backups. Extra-copy bytes are not guaranteed recoverable space."];
  if (meta.partial) {
    const reasons = [];
    if (meta.time_limited) reasons.push("time limit reached");
    if (meta.entry_limited) reasons.push("entry limit reached");
    if (meta.denied) reasons.push("some files could not be read");
    if (meta.skipped) reasons.push("protected locations, excluded folders or links skipped");
    if (meta.changed) reasons.push("files changed during the check");
    notes.push(`Partial scan: ${reasons.join("; ") || "some files were not checked"}. Scan a smaller folder to continue reviewing.`);
  }
  if (meta.hardlinks_skipped) notes.push("Additional hard-link names were excluded from duplicate counts.");
  if (meta.results_limited) notes.push("Only the largest 100 groups were returned.");
  return notes.join(" ");
}


function getParentFolderPath(fullPath) {
  if (!fullPath) return fullPath;
  if (/^[a-z]:[\\/]?$/i.test(fullPath)) return fullPath.slice(0, 2) + (fullPath.includes('/') ? '/' : '\\');
  if (/^\/+$/u.test(fullPath)) return '/';

  // Strip trailing slashes first
  const norm = fullPath.replace(/[\\\/]+$/, "");
  const lastSlash = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));

  // If there's no parent, just return the normalized path
  if (lastSlash < 0) return norm;
  if (lastSlash === 0) return norm.slice(0, 1);
  if (lastSlash === 2 && /^[a-z]:/i.test(norm)) return norm.slice(0, 3);

  return norm.slice(0, lastSlash);
}


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


/* Free Space owns one in-memory observation lifecycle. No scans on navigation. */
(function () {
  'use strict';
  const protocol = 'storage-jobs-v1', PAGE_SIZE = 50;
  const terminal = new Set(['completed', 'partial', 'cancelled', 'failed']);
  const operations = ['scan', 'large_files', 'duplicates', 'common_folders'];
  const labels = {scan:'Folder scan', large_files:'Large file search', duplicates:'Duplicate check', common_folders:'Common folder check'};
  const state = {initialized:false, locked:false, paused:false, panelActive:true, epoch:0, sequence:0, drives:[], drivesLoaded:false, driveBusy:false,
    job:null, pendingStart:null, busy:false, timer:null, requests:new Set(), observation:null, tools:{}, tab:'explore',
    focus:'', mode:'map', surface:'map', mapGroup:null, mapView:null, sort:'size', direction:-1, page:0, selected:null, handoff:null};
  let mapObserver = null, mapMarks = [], tableMarks = [];
  const $ = id => document.getElementById(id);
  const make = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const button = (text, fn, className = 'fs-button') => { const n = make('button', text, className); n.type = 'button'; n.addEventListener('click', fn); return n; };
  const text = (id, value) => { if ($(id)) $(id).textContent = value; };
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const pathOK = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
  const normalized = value => /^[A-Za-z]:[\\/]/.test(value) ? value.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase() : value.replace(/\/+$/,'') || '/';
  const samePath = (a,b) => pathOK(a) && pathOK(b) && normalized(a) === normalized(b);
  const below = (path, root) => samePath(path,root) || normalized(path).startsWith(normalized(root).replace(/\/$/,'') + '/');
  const bytes = value => { if (!finite(value)) return 'Size unknown'; const units=['B','KiB','MiB','GiB','TiB','PiB']; let i=0; while(value>=1024 && i<units.length-1){value/=1024;i++;} return value.toLocaleString(undefined,{maximumFractionDigits:i?1:0})+' '+units[i]; };
  const date = value => { const d = new Date(typeof value === 'number' ? value*1000 : value); return Number.isFinite(d.getTime()) ? d.toLocaleString() : 'Observation time unavailable'; };
  const current = epoch => !state.locked && !state.paused && !document.hidden && epoch === state.epoch;
  const itemBytes = item => item?.size===null || item?.size_known===false || item?.size_unavailable===true ? 'Size unknown' : (item?.size_partial===true?'At least ':'')+bytes(item?.size);
  const status = message => text('visualizerStatus', message);
  const hostName = () => window.__tli_node_name || window.__tli_hostname || 'TLI host';
  const category = name => { const ext=(name.match(/\.([^.]*)$/)?.[1]||'').toLowerCase(); for(const [name,exts] of Object.entries({Images:['jpg','jpeg','png','webp','gif','heic','svg'],Video:['mp4','mov','mkv','avi','webm'],Audio:['mp3','flac','wav','m4a'],Documents:['pdf','doc','docx','txt','md','xlsx','csv','pptx'],Archives:['zip','7z','rar','tar','gz'],Installers:['exe','msi','dmg','pkg','deb','apk'],Models:['gguf','safetensors','onnx','pt']})) if(exts.includes(ext))return name; return 'Other'; };
  function requestId() { const c=window.crypto; if(c?.randomUUID)return c.randomUUID(); if(!c?.getRandomValues)throw Error('Secure request identifiers are unavailable in this browser.'); const b=new Uint8Array(16); c.getRandomValues(b); return Array.from(b,n=>n.toString(16).padStart(2,'0')).join(''); }
  async function api(url, payload, epoch=state.epoch) {
    const abort = new AbortController(); state.requests.add(abort); const timeout=setTimeout(()=>abort.abort(),20000);
    try {
      const response=await fetch(url,{method:payload?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:abort.signal,...(payload?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});
      if(!current(epoch))throw Error('View changed.');
      let data; try{data=await response.json();}catch{throw Error('The host returned an unreadable response.');}
      if(!current(epoch))throw Error('View changed.');
      if(!response.ok){const detail=data?.detail;const e=Error(typeof detail==='string'?detail:typeof detail?.message==='string'?detail.message:`Request failed (${response.status}).`);e.status=response.status; if(response.status===401){window.dispatchEvent(new CustomEvent('tli-session-locked'));} throw e;}
      return data;
    } finally {clearTimeout(timeout);state.requests.delete(abort);}
  }
  function validateJob(data, expected) {
    const j=data?.job;
    if(data?.ok!==true || data.protocol!==protocol || !j || typeof j.id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(j.id) || !operations.includes(j.operation) || !['quick','deep'].includes(j.profile) || !['queued','running','cancelling',...terminal].includes(j.status) || typeof j.result_available!=='boolean')throw Error('The host did not confirm a valid storage job.');
    if(expected && ((expected.id && j.id!==expected.id) || j.operation!==expected.operation || j.profile!==expected.profile || (j.operation!=='common_folders'&&!samePath(j.path,expected.path)) || (typeof j.include_excluded==='boolean' && typeof expected.include_excluded==='boolean' && j.include_excluded!==expected.include_excluded)))throw Error('The response belongs to a different storage job, location or inclusion policy.');
    return j;
  }
  function validateResult(data, job) {
    if(!data || typeof data!=='object' || (job.operation!=='common_folders' && (!data.meta || typeof data.meta!=='object')))throw Error('The observation is incomplete or malformed. Previous results are retained.');
    const validHost=h=>h&&typeof h.id==='string'&&h.id.length>0&&h.id.length<=256&&typeof h.name==='string'&&h.name.length>0&&h.name.length<=256;
    const savedHost=data.meta?.saved_scan?.summary?.host;
    if(validHost(job.host)&&validHost(savedHost)&&job.host.id!==savedHost.id)throw Error('The saved observation belongs to a different host.');
    const host=validHost(job.host)?{id:job.host.id,name:job.host.name}:validHost(savedHost)?{id:savedHost.id,name:savedHost.name}:{id:null,name:'Host identity unavailable'};
    if(job.operation==='scan') {
      if(!data.tree || !samePath(data.tree.path,job.path) || (data.path && !samePath(data.path,job.path)))throw Error('The returned scan root does not match the requested location.');
      const stack=[{node:data.tree,protected:false,parentPath:null}], seen=new Set(), files=[],folders=[],index=new Map();let count=0;
      while(stack.length){const entry=stack.pop(),n=entry.node;if(!n || ++count>25000 || typeof n.name!=='string' || n.name.length>4096 || !pathOK(n.path) || !below(n.path,job.path) || (entry.parentPath&&!samePath(getParentFolderPath(n.path),entry.parentPath)) || seen.has(normalized(n.path)) || (n.size!==null && n.size!==undefined && !finite(n.size)) || (n.children!==undefined && !Array.isArray(n.children)) || ['collapsed_entries','omitted_entries','unknown_entries'].some(k=>n[k]!==undefined&&(!Number.isSafeInteger(n[k])||n[k]<0||n[k]>500000)))throw Error('The scan contains invalid or repeated file entries.');seen.add(normalized(n.path));
        const isDir=n.is_dir===true || Array.isArray(n.children), protectedPath=entry.protected||n.protected===true||isProtectedSystemPathClient(n.path);
        const item={name:n.name,path:n.path,parentPath:entry.parentPath,size:n.size_known===false||n.size_unavailable===true?null:finite(n.size)?n.size:null,size_partial:n.size_partial===true,isDir,protected:protectedPath,synthetic:n.synthetic===true,collapsed_entries:n.collapsed_entries,omitted_entries:n.omitted_entries,unknown_entries:n.unknown_entries,category:isDir?'Folder':category(n.name),children:n.children?.map(c=>c.path)||[]};index.set(n.path,item);
        if(!item.synthetic){if(isDir)folders.push(item);else files.push(item);}for(const child of n.children||[])stack.push({node:child,protected:protectedPath,parentPath:n.path});
      }
      if(!window.TLIStorageMap)throw Error('The storage map component is unavailable. Refresh TLI; the previous observation is retained.');
      const map=window.TLIStorageMap.build(index,data.tree.path);
      return {raw:data,job,files,folders,index,map,root:data.tree.path,recordedAt:data.meta.saved_scan?.summary?.scanned_at||job.finished_at||job.updated_at,host};
    }
    if(job.operation==='large_files') {
      if(!Array.isArray(data.files)||data.files.length>10000||data.files.some(f=>!pathOK(f.path)||!below(f.path,job.path)||typeof f.name!=='string'||(f.size!==null&&f.size!==undefined&&!finite(f.size))))throw Error('The large-file results did not match this location.');
    } else if(job.operation==='duplicates') {
      if(!Array.isArray(data.groups)||data.groups.length>100||data.groups.some(g=>!finite(g.size)||!Array.isArray(g.paths)||g.paths.length<2||g.paths.length>500000||new Set(g.paths).size!==g.paths.length||g.paths.some(p=>!pathOK(p)||!below(p,job.path)))||data.groups.reduce((n,g)=>n+g.paths.length,0)>500000)throw Error('The duplicate result contains invalid paths or groups.');
    } else if(!Array.isArray(data.targets)||data.targets.length>100||data.targets.some(t=>typeof t.label!=='string'||!pathOK(t.path)||(t.size_bytes!==null&&t.size_bytes!==undefined&&!finite(t.size_bytes))))throw Error('The common-folder result is invalid.');
    return {raw:data,job,root:job.path,recordedAt:job.finished_at||job.updated_at,host};
  }
  function controls() {
    if(!state.initialized)return;
    const waiting=!!state.job&&!terminal.has(state.job.status), blocked=state.busy||waiting||!!state.pendingStart||state.locked||state.paused;
    for(const id of ['visualizerScanBtn','fs-start-large_files','fs-start-duplicates','fs-start-common_folders'])$(id).disabled=blocked;
    $('fs-job-stop').disabled=state.busy||state.paused||!waiting||state.job?.status==='cancelling';
    $('fs-job-stop').hidden=!waiting;
    $('fs-job-check').disabled=state.busy;
    $('fs-job').hidden=(!state.job&&!state.pendingStart)||(state.job&&['completed','partial'].includes(state.job.status)&&$('fs-job-check').hidden);
    $('fs-ask-chat').disabled=!state.observation||state.locked;
  }
  function showJob(job) {
    text('fs-job-title',`${labels[job.operation]} · ${job.status}`);
    const p=job.progress||{}, parts=[];
    for(const [key,label] of [['entries_seen','entries inspected'],['files','files inspected'],['found','matches found'],['files_hashed','files checked in full']])if(finite(p[key]))parts.push(p[key].toLocaleString()+' '+label);
    const phases={queued:'Waiting to start',starting:'Starting',scanning:'Inspecting entries',enumerating:'Inspecting entries',hashing:'Checking file contents',finishing:'Preparing result',completed:'Finished',cancelled:'Stopped'};
    const startTime=new Date(typeof job.started_at==='number'?job.started_at*1000:job.started_at).getTime();
    if(Number.isFinite(startTime))parts.push(Math.max(0,Math.floor((Date.now()-startTime)/1000))+'s since start');
    text('fs-job-progress',`${job.operation==='common_folders'?'Common folders on the TLI host':job.path} · ${job.profile} · ${phases[p.phase]||'Waiting for host progress'}. `+(parts.join(' · ') || (job.status==='cancelling'?'Stop requested; waiting for host confirmation.':'No progress counters received yet.')));
    controls();
  }
  function schedule(epoch) {clearTimeout(state.timer);if(current(epoch)&&state.job&&!terminal.has(state.job.status))state.timer=setTimeout(()=>poll(),1000);}
  async function finish(job, epoch, reviewPartial=false) {
    if(!current(epoch))return;
    if(job.status==='cancelled'&&job.result_available&&!reviewPartial){window.TLIStorageHistory?.scanFailed();status('The host confirmed cancellation. A partial observation is available for review; the previous observation is still displayed.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='View partial results';controls();return;}
    if(job.result_available){const data=await api(`/visualizer/jobs/${encodeURIComponent(job.id)}/results`,null,epoch);const resultJob=validateJob(data,job);if(resultJob.status!==job.status||!resultJob.result_available)throw Error('The host did not confirm this completed observation.');const observation=validateResult(data.result,job);if(!current(epoch))return;
      if(job.operation==='scan'){state.observation=observation;state.focus=observation.root;state.selected=null;state.mapGroup=null;state.mapView=null;state.page=0;$('visualizerDetailsBar').hidden=true;$('fs-selected-cleanup')?.replaceChildren();window.visualizerV4={scanPath:observation.root,meta:observation.raw.meta,root:observation.raw.tree};window.TLIStorageHistory?.receiveScan(data.result);if(state.tab==='explore')applyScope(observation);window.dispatchEvent(new CustomEvent('tli:storage-observation-change',{detail:{id:job.id,path:job.path}}));renderObservation();}
      else {state.tools[job.operation]=observation;if(state.tab===job.operation)applyScope(observation);renderTool(job.operation);}
      status(`${labels[job.operation]} ${job.status}. ${job.status==='cancelled'?'The host confirmed cancellation; the inspected portion is shown. ':''}Nothing was moved or deleted.`);
    }else{window.TLIStorageHistory?.scanFailed();status(`${labels[job.operation]} ${job.status}. ${typeof job.error?.message==='string'?job.error.message:typeof job.error==='string'?job.error:''} No replacement observation was returned. Previous results are unchanged.`);}
    $('fs-job-check').hidden=true;controls();
  }
  async function start(operation='scan', overridePath) {
    setup();if(state.busy||state.paused||state.pendingStart||(state.job&&!terminal.has(state.job.status))||state.locked||document.hidden)return false;
    const path=overridePath||$('visualizerPathInput').value.trim();if(operation!=='common_folders'&&!pathOK(path)){status('Choose a folder or drive on the TLI host first.');return false;}
    const profile=$('fs-profile').value;if(!['quick','deep'].includes(profile))return false;
    let request_id;try{request_id=requestId();}catch(e){status(e.message);return false;}
    const payload={operation,profile,path:operation==='common_folders'?undefined:path,include_excluded:profile==='deep'&&$('fs-include-excluded').checked===true,request_id};
    if(operation==='large_files'){const mb=Number($('vis4-largefiles-minmb').value);if(!Number.isFinite(mb)||mb<1||mb>50000){status('Choose a minimum from 1 to 50,000 MiB.');return false;}payload.min_mb=mb;payload.limit=500;}
    state.pendingStart=payload;state.job=null;if(operation==='scan'){setTab('explore');window.TLIStorageHistory?.beginScan(true);}return submitStart();
  }
  async function submitStart(){if(state.busy||!state.pendingStart)return false;const epoch=state.epoch,payload=state.pendingStart;state.busy=true;controls();text('fs-job-title','Starting '+labels[payload.operation].toLowerCase());text('fs-job-progress','The prior observation stays available while this request is checked.');$('fs-job-check').hidden=true;
    try{if(window.TLIRelease)await window.TLIRelease.requireCapability('storage_jobs_v1');if(!current(epoch))return false;const data=await api('/visualizer/jobs',payload,epoch);const job=validateJob(data,payload);if(!current(epoch))return false;state.job=job;state.pendingStart=null;showJob(job);if(terminal.has(job.status))await finish(job,epoch);else schedule(epoch);return true;}
    catch(e){if(current(epoch)){if(e.status){state.pendingStart=null;status(e.message+' The request was rejected. Previous observations are unchanged; nothing retries automatically.');window.TLIStorageHistory?.scanFailed();}else{status(e.message+' Start was not confirmed. An explicit retry uses the same request ID, but can start the job if the first request never arrived.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Retry this start request';}}}
    finally{if(current(epoch)){state.busy=false;controls();}}
    return false;
  }
  async function poll(){if(state.busy||!state.job||state.locked||document.hidden)return;const epoch=state.epoch,job=state.job;state.busy=true;controls();
    try{const data=await api(`/visualizer/jobs/${encodeURIComponent(job.id)}`,null,epoch);const updated=validateJob(data,job);if(!current(epoch))return;state.job=updated;showJob(updated);if(terminal.has(updated.status))await finish(updated,epoch);else schedule(epoch);}
    catch(e){if(current(epoch)){if([404,410].includes(e.status)){state.job=null;window.TLIStorageHistory?.scanFailed();status(e.message+' This job is no longer available. Previous observations are retained. Start a new scan explicitly if needed.');}else{status(e.message+' Watching paused. Previous observations are unchanged. Check status explicitly to continue.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Check status';}}}
    finally{if(current(epoch)){state.busy=false;controls();}}
  }
  async function stop(){if(state.busy||!state.job||terminal.has(state.job.status))return;const epoch=state.epoch,job=state.job;clearTimeout(state.timer);state.busy=true;controls();
    try{const data=await api(`/visualizer/jobs/${encodeURIComponent(job.id)}/cancel`,{},epoch);const updated=validateJob(data,job);if(!current(epoch))return;state.job=updated;showJob(updated);if(terminal.has(updated.status))await finish(updated,epoch);else schedule(epoch);}
    catch(e){if(current(epoch)){status(e.message+' Cancellation was not confirmed. The host may still be scanning; check status before starting again.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Check status';}}
    finally{if(current(epoch)){state.busy=false;controls();}}
  }
  function prepare(path){setup();if(state.locked||!pathOK(path))return false;$('visualizerPathInput').value=path;locationChanged();status('Location selected. Choose Scan to start; no scan has run from this navigation.');return true;}
  function locationChanged(){const path=$('visualizerPathInput').value.trim();text('fs-location-title',path||'Choose where to look');text('fs-location-summary-hint',path||'Choose a drive or folder');const drive=state.drives.find(d=>samePath(d.mountpoint,path));text('fs-location-capacity',drive?`${drive.label||drive.mountpoint} · ${bytes(drive.free)} free of ${bytes(drive.total)}. Capacity is a recorded drive reading.`:'This is a folder on the TLI host. Selecting it does not scan or change files.');for(const n of $('vis4-drives').querySelectorAll('button'))n.setAttribute('aria-pressed',String(samePath(n.dataset.mount,path)));if(state.observation&&!samePath(state.observation.root,path))status(`Showing the retained observation of ${state.observation.root}. Scan the selected location to replace it.`);}
  async function drives(force=false){setup();if(state.driveBusy||state.locked||state.paused||document.hidden||(!force&&state.drivesLoaded))return;if(state.pendingStart||state.job&&!terminal.has(state.job.status)){text('fs-drives-status','A storage job is active. Refresh capacity explicitly after it finishes. Previous readings are retained.');return;}const epoch=state.epoch;state.driveBusy=true;$('fs-drives-refresh').disabled=true;text('fs-drives-status','Reading drive capacity…');
    try{if(!window.TLI_PATHS&&typeof window._tliLoadCommonPaths==='function'){await window._tliLoadCommonPaths();if(!current(epoch))return;}const data=await api('/visualizer/drives',null,epoch);if(!Array.isArray(data.drives)||data.drives.length>256||data.drives.some(d=>!pathOK(d.mountpoint||d.mount||d.path)))throw Error('Drive information has an invalid format.');if(!current(epoch))return;state.drives=data.drives.map(d=>({...d,mountpoint:d.mountpoint||d.mount||d.path,free:d.free_bytes??d.free,total:d.total_bytes??d.total}));state.drivesLoaded=true;renderDrives();text('fs-drives-status',`${state.drives.length} drives · capacity read ${new Date().toLocaleTimeString()}`);}
    catch(e){if(current(epoch))text('fs-drives-status','Drive information is unavailable. Previous readings are retained; you can enter a folder or refresh explicitly.');}
    finally{if(current(epoch)){state.driveBusy=false;$('fs-drives-refresh').disabled=false;}}
  }
  function renderDrives(){const query=$('fs-drive-search').value.toLowerCase(),sort=$('fs-drive-sort').value,rows=state.drives.filter(d=>(String(d.label||'')+' '+d.mountpoint).toLowerCase().includes(query)).sort((a,b)=>sort==='free'?(finite(a.free)?a.free:Infinity)-(finite(b.free)?b.free:Infinity):sort==='used'?(finite(b.percent_used)?b.percent_used:-1)-(finite(a.percent_used)?a.percent_used:-1):String(a.label||a.mountpoint).localeCompare(String(b.label||b.mountpoint)));const list=$('vis4-drives');list.replaceChildren();
    for(const d of rows){const b=button('',()=>prepare(d.mountpoint),'fs-drive');b.dataset.mount=d.mountpoint;b.setAttribute('aria-pressed',String(samePath($('visualizerPathInput').value,d.mountpoint)));const top=make('span',undefined,'fs-drive-top');top.append(make('strong',d.label||d.mountpoint),make('span',finite(d.percent_used)&&d.percent_used<=100?Math.round(d.percent_used)+'% used':'Usage unknown','fs-help'));b.append(top,make('span',d.mountpoint,'fs-path'));const meter=make('span',undefined,'fs-meter'),fill=make('span');fill.style.width=(finite(d.percent_used)&&d.percent_used<=100?d.percent_used:0)+'%';meter.append(fill);b.append(meter,make('span',`${bytes(d.free)} free / ${bytes(d.total)}`,'fs-help'));if(d.availability&&d.availability!=='available'){b.append(make('span',({offline:'Offline',unavailable:'Capacity unavailable',unknown:'Capacity unknown'}[d.availability]||'Capacity unavailable')+(typeof d.detail==='string'?' · '+d.detail.slice(0,240):''),'fs-drive-availability'));}list.append(b);}if(!rows.length)list.append(make('p',state.drives.length?'No drives match your search.':'No drives returned. Enter a folder to continue.','fs-help'));}
  function applyScope(observation){if(observation)window.TLIStorageCleanup?.setScope?.({observationId:observation.job.id,root:observation.root||'common_folders',host:observation.host||{name:hostName(),id:null}});}
  function setTab(tab){if(!['explore','large_files','duplicates','common_folders','history'].includes(tab))return;const changed=state.tab!==tab;state.tab=tab;for(const b of document.querySelectorAll('[data-fs-tab]')){const active=b.dataset.fsTab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;$('fs-view-'+b.dataset.fsTab).hidden=!active;}if(changed){if(tab==='explore'&&state.observation){applyScope(state.observation);renderExplorer();}else if(state.tools[tab]){applyScope(state.tools[tab]);renderTool(tab);}}}
  function renderObservation(){const o=state.observation;$('fs-empty').hidden=!!o;$('storage-results').hidden=!o;$('panel-visualizer').classList.toggle('fs-has-observation',!!o);if(!o)return;const summary=$('vis4-summary');summary.replaceChildren();const heading=make('div',undefined,'fs-heading');heading.append(make('strong',`${itemBytes(o.index.get(o.root))} inspected`),make('span',o.job.status,'fs-badge'));summary.append(heading,make('p',`${o.host.name} · ${date(o.recordedAt)} · saved observation`,'fs-help'));
    const details=make('details',undefined,'fs-policy');details.append(make('summary','Recorded scope & limits'),make('p',o.root,'fs-path'),make('p',visCoverage(o.raw.meta)));details.append(make('p',`Host ID: ${o.host.id||'unavailable'} · Job: ${o.job.id} · ${o.job.profile} profile. This is a saved observation, not a current capacity reading.`));const filters=o.raw.meta.scan_filters||o.raw.meta.saved_scan?.summary?.filters;if(filters){const excluded=Array.isArray(filters.excluded_names)?filters.excluded_names.filter(n=>typeof n==='string').slice(0,100):null;details.append(make('p',`Limits: ${finite(filters.max_seconds)?filters.max_seconds+' seconds':'time unavailable'}, ${finite(filters.max_entries)?filters.max_entries.toLocaleString()+' entries':'entry limit unavailable'}, ${finite(filters.max_depth)?filters.max_depth+' folder levels':'depth unavailable'}. Excluded names: ${excluded?excluded.join(', ')||'none':'not recorded'}.`));}else details.append(make('p','The returned observation did not record a scan-policy breakdown.'));summary.append(details);
    const cats=$('visualizerCategoryFilter'),selected=cats.value;cats.replaceChildren();for(const c of ['all',...new Set(o.files.map(f=>f.category))].sort((a,b)=>a==='all'?-1:b==='all'?1:a.localeCompare(b))){const option=make('option',c==='all'?'All types':c);option.value=c;cats.append(option);}cats.value=Array.from(cats.options).some(x=>x.value===selected)?selected:'all';renderExplorer();}
  function matching() {
    const o=state.observation;if(!o)return [];
    const query=$('visualizerSearchInput').value.toLowerCase(),cat=$('visualizerCategoryFilter').value,min=Number($('visualizerMinSize').value)||0;
    const matches=f=>(!query||(f.name+' '+(f.path||f.parentPath)).toLowerCase().includes(query))&&(cat==='all'||f.category===cat)&&(min===0||finite(f.size)&&f.size>=min);
    state.mapView=window.TLIStorageMap.view(o.map,state.focus,matches,state.mapGroup);
    const rows=state.mode==='folders'?o.folders.filter(f=>f.path!==state.focus&&below(f.path,state.focus)&&matches(f)):state.mapView.rows;
    return rows.slice().sort((a,b)=>{const diff=state.sort==='size'?(a.size===null?-1:a.size)-(b.size===null?-1:b.size):String(a[state.sort]||'').localeCompare(String(b[state.sort]||''));return diff*state.direction||String(a.key||a.path).localeCompare(String(b.key||b.path));});
  }
  const itemKey=item=>item?.key||item?.path;
  const inspectable=(o,revision)=>o===state.observation&&!state.locked&&!state.paused&&(revision===undefined||revision===state.displayRevision);
  function highlightSelection(){
    const key=itemKey(state.selected);
    for(const {node,item} of [...mapMarks,...tableMarks]){const active=key===itemKey(item)||!!item.members?.includes(key)||!!state.selected?.members?.includes(itemKey(item));node.classList.toggle('fs-is-selected',active);node.setAttribute(node.tagName==='BUTTON'?'aria-pressed':'aria-current',String(active));}
  }
  function choose(item,o=state.observation,revision){
    if(!inspectable(o,revision))return;
    state.selected=item;
    const rows=matching(),position=rows.findIndex(row=>itemKey(row)===itemKey(item)||item.members?.includes(itemKey(row)));
    if(position>=0&&Math.floor(position/PAGE_SIZE)!==state.page){state.page=Math.floor(position/PAGE_SIZE);renderExplorer();}
    $('visualizerDetailsBar').hidden=false;text('visualizerDetailsName',item.name);
    text('visualizerDetailsPath',item.path||`Grouped under ${item.parentPath||state.focus} · no individual file path`);
    text('visualizerDetailsSize',`${itemBytes(item)} · ${item.aggregate?'Grouped indexed bytes; not an actionable file':item.isDir?'Folder in this observation':item.category}${item.protected?' · Protected location':''}${item.reason?' · '+item.reason:''}`);
    $('visualizerCopyPathBtn').disabled=!item.path||item.synthetic;
    $('visualizerSendToFilesBtn').disabled=!item.path||item.synthetic;
    const actions=$('fs-selected-cleanup');actions.replaceChildren();
    if(item.members){actions.append(button('Show grouped entries',()=>{if(!inspectable(o))return;state.mapGroup=new Set(item.members);state.page=0;state.selected=null;$('visualizerDetailsBar').hidden=true;renderExplorer();},'fs-button fs-small'));}
    else if(item.isDir&&!item.synthetic&&item.children?.length)actions.append(button('Open recorded folder',()=>drill(item.path,o),'fs-button fs-small'));
    else if(item.actionable!==false&&!item.isDir&&!item.synthetic)actions.append(window.TLIStorageCleanup?.choice?.(item)||make('span','Cleanup unavailable'));
    highlightSelection();$('visualizerDetailsBar').scrollIntoView?.({block:'nearest',behavior:'instant'});
  }
  function drill(path,o=state.observation){
    if(!inspectable(o))return;const item=o.index.get(path);if(!item?.isDir||item.synthetic)return;
    state.focus=path;state.mapGroup=null;state.page=0;state.selected=null;$('visualizerDetailsBar').hidden=true;$('fs-selected-cleanup').replaceChildren();renderExplorer();$('visualizerCenterTitle').focus();
  }
  function renderBreadcrumbs(o){
    const box=$('fs-map-breadcrumbs');box.replaceChildren();const trail=[];let item=o.index.get(state.focus);
    while(item){trail.unshift(item);item=o.index.get(item.parentPath);}
    for(const folder of trail){if(box.childElementCount)box.append(make('span','/'));const b=button(folder.path===o.root?folder.path:folder.name,()=>drill(folder.path,o),'fs-button fs-small');if(folder.path===state.focus&&!state.mapGroup)b.setAttribute('aria-current','location');box.append(b);}
    if(state.mapGroup){box.append(make('span','/'),button('Grouped display subset · show all',()=>{if(!inspectable(o))return;state.mapGroup=null;state.page=0;state.selected=null;$('visualizerDetailsBar').hidden=true;renderExplorer();},'fs-button fs-small'));}
  }
  function setSurface(surface){state.surface=surface;$('fs-map-workbench').dataset.surface=surface;$('fs-mobile-map').setAttribute('aria-pressed',String(surface==='map'));$('fs-mobile-list').setAttribute('aria-pressed',String(surface==='list'));}
  function renderExplorer(){
    const o=state.observation;if(!o)return;state.displayRevision=(state.displayRevision||0)+1;const revision=state.displayRevision;
    const rows=matching(),maxPage=Math.max(0,Math.ceil(rows.length/PAGE_SIZE)-1);state.page=Math.min(state.page,maxPage);
    text('visualizerCenterSubtitle',state.focus);$('visualizerBackBtn').disabled=samePath(state.focus,o.root);renderBreadcrumbs(o);
    text('visualizerStatusLine',`${rows.length.toLocaleString()} matching retained ${state.mode==='folders'?'folders':'entries'} · ${o.files.length.toLocaleString()} individual file paths recorded`);
    for(const b of $('visualizerModePills').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode));
    const body=$('visualizerTableBody');body.replaceChildren();tableMarks=[];
    for(const item of rows.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE)){
      const tr=make('tr'),name=make('td'),action=button(item.name,()=>{if(!inspectable(o,revision))return;choose(item,o,revision);if(state.mode==='folders'&&item.isDir)drill(item.path,o);},'fs-file-name storage-file-action');
      name.append(action,make('small',item.path||`Grouped under ${item.parentPath} · no individual path`,'fs-path'));
      const review=make('td');
      if(item.actionable!==false&&!item.isDir&&!item.synthetic)review.append(window.TLIStorageCleanup?.choice?.(item)||make('span','Cleanup unavailable'));
      else if(item.isDir&&!item.synthetic&&item.children?.length)review.append(button('Open folder',()=>{if(inspectable(o,revision))drill(item.path,o);},'fs-button fs-small'));
      else review.append(make('span',item.aggregate?'Grouped · review only':item.size===null?'Size unknown':'No file action','fs-help'));
      tr.append(name,make('td',item.aggregate?'Grouped':item.category),make('td',itemBytes(item)),review);body.append(tr);tableMarks.push({node:tr,item});
    }
    if(!rows.length){const tr=make('tr'),td=make('td',o.map.atoms.length?'No entries match these display filters. Change a filter or return to the scanned root.':'No indexed entries were retained. Check coverage before treating the folder as empty.');td.colSpan=4;tr.append(td);body.append(tr);}
    $('fs-map-workbench').hidden=state.mode==='types';$('fs-map-workbench').classList.toggle('fs-list-only',state.mode!=='map');
    $('fs-map-list-panel').hidden=state.mode==='types';$('fs-table-wrap').hidden=state.mode==='types';$('vis4-treemap-container').hidden=state.mode!=='map';$('visualizerTypeBars').hidden=state.mode!=='types';$('fs-mobile-map-list').hidden=state.mode!=='map';
    $('fs-paging').hidden=state.mode==='types'||rows.length<=PAGE_SIZE;text('fs-page-label',`${rows.length?state.page*PAGE_SIZE+1:0}–${Math.min((state.page+1)*PAGE_SIZE,rows.length)} of ${rows.length}`);$('fs-page-prev').disabled=state.page===0;$('fs-page-next').disabled=state.page>=maxPage;
    mapObserver?.disconnect();mapObserver=null;
    if(state.mode==='map')renderMap(state.mapView,o,revision);else mapMarks=[];
    if(state.mode==='types')renderTypes(rows);setSurface(state.surface);highlightSelection();updateCleanup();
  }
  function renderMap(view,o,revision){
    const box=$('vis4-treemap-container');box.replaceChildren();mapMarks=[];
    const representation=window.TLIStorageMap.hierarchy(view);
    const header=make('div',undefined,'fs-map-heading');header.append(make('strong','Space map'),make('span',`${bytes(view.total)} mapped known bytes`,'fs-map-total'));box.append(header);
    box.append(make('p',`${view.unknown} retained unknown-size${view.groupedUnknown?' · '+view.groupedUnknown+' additional unknown sizes inside groups':''} · ${view.zero} zero-byte entries outside map${view.aggregateBytes?' · '+bytes(view.aggregateBytes)+' grouped bytes':''}. Recorded bytes, not drive capacity.`,'fs-help'));
    const areaDetails=make('details',undefined,'fs-map-accounting');areaDetails.append(make('summary','Map accounting'),make('p',`${bytes(view.scopeTotal)} known indexed bytes in this recorded folder scope. The map uses ${bytes(view.total)} matching known bytes; display filters do not change saved totals. Folder and child bytes are never added twice. Unknown sizes are excluded from area, not treated as empty.`));
    if(representation.groupedCount)areaDetails.append(make('p',`${representation.groupedCount.toLocaleString()} entries are combined in “Other mapped entries” to bound drawing. Select that group to inspect its retained entries. All indexed bytes remain in the denominator.`));
    if(!view.total){box.append(make('p','No positive known sizes match. The linked list retains zero, unknown and grouped entries.'));return;}
    if(!window.d3?.treemap){box.append(make('p','The map library is unavailable. The linked list retains every recorded entry and size.'));return;}
    const canvas=make('div',undefined,'fs-map-canvas');canvas.setAttribute('role','group');canvas.setAttribute('aria-label','Recorded file bytes by folder and file type; small tiles are available in the linked list');box.append(canvas);
    const colors=new Set(), width=Math.max(1,Math.round(canvas.getBoundingClientRect?.().width||box.getBoundingClientRect?.().width||600)), height=420;
    const layout=window.TLIStorageMap.layout(window.d3,representation,width,height);
    for(const leaf of layout.leaves()){
      const item=leaf.data.item,w=leaf.x1-leaf.x0,h=leaf.y1-leaf.y0,large=w>=36&&h>=28;
      const category=item.aggregate?'Grouped':item.category,key=String(category).toLowerCase().replace(/[^a-z]/g,'');colors.add(category);
      const mark=large?button('',()=>choose(item,o,revision),'fs-map-item'):make('div',undefined,'fs-map-item fs-map-tiny');
      mark.classList.add('fs-map-type-'+key);mark.dataset.mapKey=itemKey(item);
      if(large)mark.setAttribute('aria-label',`${item.name} · ${itemBytes(item)} · ${item.path||'non-actionable grouped entries'}`);else mark.setAttribute('aria-hidden','true');
      Object.assign(mark.style,{left:leaf.x0/width*100+'%',top:leaf.y0/height*100+'%',width:w/width*100+'%',height:h/height*100+'%'});
      if(w>=80&&h>=54)mark.append(make('span',item.name),make('small',bytes(item.size)));
      canvas.append(mark);mapMarks.push({node:mark,item});
    }
    for(const folder of layout.descendants().filter(n=>n.depth===1&&n.children)){
      const w=folder.x1-folder.x0,h=folder.y1-folder.y0,frame=make('div',undefined,'fs-map-folder-boundary');frame.setAttribute('aria-hidden','true');Object.assign(frame.style,{left:folder.x0/width*100+'%',top:folder.y0/height*100+'%',width:w/width*100+'%',height:h/height*100+'%'});canvas.append(frame);
      if(w>=100&&h>=90){const b=button(folder.data.name,()=>{if(inspectable(o,revision))drill(folder.data.path,o);},'fs-map-folder-label');b.setAttribute('aria-label',`Open recorded folder ${folder.data.path} · ${bytes(folder.value)} in this map region`);Object.assign(b.style,{left:folder.x0/width*100+'%',top:folder.y0/height*100+'%',maxWidth:w/width*100+'%'});canvas.append(b);}
    }
    const legend=make('div',undefined,'fs-map-legend');legend.setAttribute('aria-label','File type colors');
    for(const category of [...colors].sort()){const item=make('span'),swatch=make('i',undefined,'fs-map-swatch fs-map-type-'+category.toLowerCase().replace(/[^a-z]/g,''));swatch.setAttribute('aria-hidden','true');item.append(swatch,make('span',category));legend.append(item);}box.append(legend,areaDetails,make('p','Choose a tile or list entry to inspect its path. Tiny tiles remain in the list. Cleanup selection is separate.','fs-help'));
    highlightSelection();
    if(window.ResizeObserver){mapObserver?.disconnect();let measured=width;mapObserver=new window.ResizeObserver(entries=>{const next=Math.round(entries[0]?.contentRect.width||0);if(next>0&&Math.abs(next-measured)>2&&inspectable(o,revision)&&state.mode==='map'){measured=next;mapObserver.disconnect();renderMap(view,o,revision);}});mapObserver.observe(canvas);}
  }

  function renderTypes(rows){const box=$('visualizerTypeBars');box.replaceChildren();const totals=new Map();for(const f of rows){const r=totals.get(f.category)||{size:0,count:0,unknown:0};r.count++;if(f.size===null)r.unknown++;else r.size+=f.size;totals.set(f.category,r);}const max=Math.max(1,...Array.from(totals.values(),r=>r.size));for(const [name,r] of [...totals].sort((a,b)=>b[1].size-a[1].size)){const row=make('div',undefined,'fs-type-row');row.append(make('strong',name),make('span',`${bytes(r.size)} · ${r.count} retained entries${r.unknown?' · '+r.unknown+' unknown sizes':''}`));const meter=make('span',undefined,'fs-meter'),fill=make('span');fill.style.width=r.size/max*100+'%';meter.append(fill);row.append(meter);box.append(row);}if(!totals.size)box.append(make('p','No file types match these filters.'));}
  function renderTool(operation){const o=state.tools[operation];if(!o)return;const data=o.raw,box=$('fs-'+operation+'-results');box.replaceChildren();text('fs-'+operation+'-status',`${labels[operation]} ${o.job.status} · ${operation==='common_folders'?'Common folders on the TLI host':o.root} · ${date(o.recordedAt)}`);
    if(operation==='large_files'){box.append(make('p',visCoverage(data.meta),'fs-help'),make('p',`${data.files.length} files returned${finite(data.meta.found)?' of '+data.meta.found+' matches found':''}. ${finite(o.job.min_mb)?'Minimum '+o.job.min_mb+' MiB.':''}`));let count=0;const show=()=>{const end=Math.min(count+PAGE_SIZE,data.files.length);for(;count<end;count++){const f=data.files[count],row=make('div',undefined,'fs-tool-row');row.append(make('strong',f.name),make('p',f.path,'fs-path'),make('span',itemBytes(f)),window.TLIStorageCleanup?.choice?.({...f,isDir:false})||make('span','Cleanup unavailable'),button('Select parent folder',()=>prepare(getParentFolderPath(f.path))));box.append(row);}more.hidden=count>=data.files.length;};const more=button('Show more files',show);show();box.append(more);if(!data.files.length)box.append(make('p','No matching files returned. Partial coverage does not establish that none exist.'));}
    else if(operation==='duplicates'){box.append(make('p',visDuplicateCoverage(data.meta),'fs-help'),make('p',`${data.groups.length} groups returned${finite(data.meta.groups_found)?' of '+data.meta.groups_found+' found':''}.`));for(const group of data.groups){const details=make('details',undefined,'fs-dupe');details.append(make('summary',`${group.paths.length} copies · ${bytes(group.size)} each · ${bytes(group.wasted_bytes)} in extra copies`));let mounted=false;details.addEventListener('toggle',()=>{if(!details.open||mounted)return;mounted=true;if(data.meta.verification==='full_sha256'&&window.TLIStorageCleanup?.duplicateControls)details.append(window.TLIStorageCleanup.duplicateControls(group));else{for(const path of group.paths.slice(0,100))details.append(make('p',path,'fs-path'));if(group.paths.length>100)details.append(make('p','Only the first 100 unverified paths are displayed. No cleanup selection is available without full-content verification.'));}});box.append(details);}if(!data.groups.length)box.append(make('p','No duplicate groups returned from the files checked.'));}
    else {for(const target of data.targets){const row=make('div',undefined,'fs-tool-row');row.append(make('strong',target.label),make('p',target.path,'fs-path'),make('span',target.size_partial?'At least '+bytes(target.size_bytes):bytes(target.size_bytes)),make('p',visCleanupCoverage(target),'fs-help'),button('Select this folder',()=>prepare(target.path)));box.append(row);}if(!data.targets.length)box.append(make('p','No supported common folders were returned. You can still scan a selected location.'));}updateCleanup();}
  function openCleanup(){if(window.TLIStorageCleanup?.openReview){window.TLIStorageCleanup.openReview();return true;}const box=$('storage-cleanup-review');if(!box)return false;box.open=true;box.scrollIntoView({block:'nearest'});box.querySelector('summary').focus();return true;}
  function updateCleanup(){const summary=$('storage-cleanup-review')?.querySelector('summary');if(summary)summary.textContent='Cleanup review · '+($('cleanup-count')?.textContent||'no files selected');}
  function closeHandoff(){state.handoff=null;$('fs-handoff')?.close();text('fs-handoff-text','');text('fs-handoff-status','');}
  function reviewHandoff(kind){const o=state.observation,item=state.selected;if(!o||(kind==='files'&&!item))return;const content=kind==='files'?(item.isDir?item.path:getParentFolderPath(item.path)):`Recorded storage observation on ${o.host.name}, ${date(o.recordedAt)}. Root: ${o.root}. Inspected file bytes: ${itemBytes(o.index.get(o.root))}. ${visCoverage(o.raw.meta)}\nLargest recorded files:\n${[...o.files].sort((a,b)=>(b.size||0)-(a.size||0)).slice(0,5).map(f=>`${f.path} — ${itemBytes(f)}`).join('\n')}\nPlease help me interpret this historical scan and suggest what I should review. Do not assume any file is safe to delete or that disk space has been freed.`;
    state.handoff={kind,content,epoch:state.epoch};text('fs-handoff-title',kind==='files'?'Review this folder in Files':'Review the scan summary for Chat');text('fs-handoff-text',content);text('fs-handoff-help',kind==='files'?'This selects the parent folder in Files. No file scan, plan or move runs. If Files already has a different path draft, it stays unchanged.':'This prepares plain reference text in an empty Chat draft. It does not send a message, attach a verified report or change any existing context.');text('fs-handoff-confirm',kind==='files'?'Open Files with this location':'Use in an empty Chat draft');text('fs-handoff-status','');$('fs-handoff').showModal();}
  function confirmHandoff(){const h=state.handoff;if(!h||!current(h.epoch))return;if(h.kind==='files'){const input=$('filesRootInput');if(!input){text('fs-handoff-status','Files is unavailable.');return;}if(input.value.trim()&&!samePath(input.value.trim(),h.content)){text('fs-handoff-status','Files already has a different folder draft. It was preserved. Copy this path and review the existing Files draft first.');return;}input.value=h.content;input.dispatchEvent(new Event('input',{bubbles:true}));closeHandoff();if(typeof switchPanel==='function')switchPanel('panel-files');input.focus();}
    else {const input=$('chat-input');const context=[window.TLIIntelligence,window.TLIDocuments,window.TLINotebook,window.TLICaseContext].flatMap(m=>m?.describeContext?.()||[]);if(!input||input.value.trim()||$('chat-send-btn')?.disabled||context.length){text('fs-handoff-status','Chat has a draft, an active reply or selected context. Those are preserved. Finish or clear them explicitly in Chat before using this summary.');return;}input.value=h.content;input.dispatchEvent(new Event('input',{bubbles:true}));closeHandoff();if(typeof switchPanel==='function')switchPanel('panel-main');input.focus();}}
  function clearPrivate(){mapObserver?.disconnect();mapObserver=null;mapMarks=[];tableMarks=[];state.mapView=null;state.mapGroup=null;state.epoch++;clearTimeout(state.timer);for(const a of state.requests)a.abort();state.requests.clear();state.job=null;state.pendingStart=null;state.busy=false;state.driveBusy=false;state.drives=[];state.drivesLoaded=false;state.observation=null;state.tools={};state.selected=null;state.focus='';state.page=0;window.visualizerV4=null;if(!state.initialized)return;closeHandoff();for(const id of ['fs-map-breadcrumbs','fs-selected-cleanup','vis4-drives','vis4-summary','visualizerTableBody','visualizerTypeBars','vis4-treemap-container','visualizerDetailsPath','visualizerDetailsName','visualizerDetailsSize','fs-large_files-results','fs-duplicates-results','fs-common_folders-results','visualizerPathSuggestions','fs-job-title','fs-job-progress','visualizerCenterSubtitle'])$(id)?.replaceChildren();for(const id of ['visualizerPathInput','visualizerSearchInput','fs-drive-search'])$(id).value='';$('visualizerDetailsBar').hidden=true;$('fs-drives-refresh').disabled=false;for(const op of operations.slice(1))text('fs-'+op+'-status','No observation loaded.');text('fs-drives-status','Refresh to read drive capacity.');status('Private observations cleared. Watching stopped; any host scan may continue within its limits. No cleanup or retry ran.');locationChanged();renderObservation();controls();}
  function setup(){if(state.initialized||!$('panel-visualizer'))return;state.initialized=true;
    const compact=window.matchMedia?.('(max-width: 800px)');let locationChoice=false;
    if(compact?.matches)$('fs-locations').open=false;
    $('fs-locations').querySelector('summary')?.addEventListener('click',()=>{locationChoice=true;});
    compact?.addEventListener?.('change',e=>{if(!locationChoice)$('fs-locations').open=!e.matches;});
    $('visualizerScanBtn').addEventListener('click',()=>start('scan'));$('visualizerPathInput').addEventListener('input',locationChanged);$('fs-drives-refresh').addEventListener('click',()=>drives(true));$('fs-drive-search').addEventListener('input',renderDrives);$('fs-drive-sort').addEventListener('change',renderDrives);
    for(const b of document.querySelectorAll('[data-vis-preset]'))b.addEventListener('click',()=>{const path=window.TLI_PATHS?.common?.[b.dataset.visPreset]||(b.dataset.visPreset==='home'?window.TLI_PATHS?.home:null);if(path)prepare(path);else status('The host has not supplied this folder path. Enter its absolute path or refresh TLI.');});
    for(const b of document.querySelectorAll('[data-fs-tab]')){b.addEventListener('click',()=>setTab(b.dataset.fsTab));b.addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('[data-fs-tab]')],i=tabs.indexOf(b);let next;if(e.key==='ArrowRight')next=(i+1)%tabs.length;if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();setTab(tabs[next].dataset.fsTab);tabs[next].focus();}});}
    $('fs-profile').addEventListener('change',()=>{const deep=$('fs-profile').value==='deep';$('fs-include-excluded').disabled=!deep;if(!deep)$('fs-include-excluded').checked=false;});
    for(const op of operations.slice(1))$('fs-start-'+op).addEventListener('click',()=>start(op));$('fs-job-stop').addEventListener('click',stop);$('fs-job-check').addEventListener('click',async()=>{if(state.pendingStart)return submitStart();if(state.job?.status==='cancelled'&&state.job.result_available){if(state.busy)return;const epoch=state.epoch;state.busy=true;controls();try{await finish(state.job,epoch,true);}catch(e){if(current(epoch))status(e.message+' The previous observation is retained.');}finally{if(current(epoch)){state.busy=false;controls();}}return;}return poll();});
    $('fs-mobile-map').addEventListener('click',()=>setSurface('map'));$('fs-mobile-list').addEventListener('click',()=>setSurface('list'));
    for(const b of $('visualizerModePills').querySelectorAll('button'))b.addEventListener('click',()=>{state.mode=b.dataset.mode;state.page=0;renderExplorer();});
    for(const id of ['visualizerSearchInput','visualizerCategoryFilter','visualizerMinSize'])$(id).addEventListener(id==='visualizerSearchInput'?'input':'change',()=>{state.page=0;renderExplorer();});
    for(const th of document.querySelectorAll('#panel-visualizer th[data-sort]'))th.querySelector('button').addEventListener('click',()=>{state.direction=state.sort===th.dataset.sort?-state.direction:th.dataset.sort==='size'?-1:1;state.sort=th.dataset.sort;state.page=0;for(const t of document.querySelectorAll('#panel-visualizer th[data-sort]'))t.setAttribute('aria-sort',t===th?(state.direction===1?'ascending':'descending'):'none');renderExplorer();});
    $('fs-page-prev').addEventListener('click',()=>{state.page=Math.max(0,state.page-1);renderExplorer();});$('fs-page-next').addEventListener('click',()=>{state.page++;renderExplorer();});$('visualizerBackBtn').addEventListener('click',()=>drill(getParentFolderPath(state.focus)));
    $('visualizerCopyPathBtn').addEventListener('click',async()=>{const epoch=state.epoch,path=state.selected?.path;if(!path)return;try{await navigator.clipboard.writeText(path);if(current(epoch))status('Selected path copied.');}catch{if(current(epoch))status('Copy is unavailable. Select the displayed path to copy it manually.');}});
    $('visualizerSendToFilesBtn').addEventListener('click',()=>reviewHandoff('files'));$('fs-ask-chat').addEventListener('click',()=>reviewHandoff('chat'));$('fs-handoff-close').addEventListener('click',closeHandoff);$('fs-handoff').addEventListener('cancel',e=>{e.preventDefault();closeHandoff();});$('fs-handoff-confirm').addEventListener('click',confirmHandoff);$('fs-open-cleanup').addEventListener('click',openCleanup);
    window.TLIStorageHistory?.setup();window.addEventListener('tli:cleanup-selection-change',updateCleanup);controls();
  }
  window.TLIFreeSpace={setup,prepare,startScan:({path}={})=>start('scan',path),start,stop,poll,loadDrives:drives,clearPrivate,openCleanup,updateCleanup,
    // Read-only validators also exercised by isolated controller tests.
    validateJob,validateResult,bytes,getState:()=>({busy:state.busy,job:state.job,observation:state.observation,tab:state.tab,epoch:state.epoch,mode:state.mode,focus:state.focus,selected:state.selected,mapView:state.mapView})};
  window.TLIVisualizer={scanPath:prepare,startScan:({path}={})=>start('scan',path)};
  function pause(){mapObserver?.disconnect();mapObserver=null;state.paused=true;state.epoch++;clearTimeout(state.timer);for(const a of state.requests)a.abort();state.requests.clear();state.busy=false;state.driveBusy=false;closeHandoff();controls();}
  function resume(){if(!state.paused||state.locked||document.hidden||!state.panelActive)return;state.paused=false;if(state.initialized)$('fs-drives-refresh').disabled=false;controls();if(state.observation&&state.tab==='explore')renderExplorer();if(state.job&&!terminal.has(state.job.status))poll();else if(state.pendingStart){status('Start response was interrupted. Retry this start request explicitly using its same request ID.');$('fs-job-check').hidden=false;$('fs-job-check').textContent='Retry this start request';}}
  window.addEventListener('tli-session-locked',()=>{
    const job=state.job;state.locked=true;clearPrivate();
    if(job&&!terminal.has(job.status))fetch(`/visualizer/jobs/${encodeURIComponent(job.id)}/cancel`,{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});
  });
  window.addEventListener('tli-session-unlocked',()=>{state.locked=false;state.paused=document.hidden||!state.panelActive;controls();});
  window.addEventListener('pagehide',event=>{if(event.persisted)pause();else clearPrivate();});
  window.addEventListener('pageshow',event=>{if(event.persisted)resume();});
  document.addEventListener?.('visibilitychange',()=>{if(document.hidden)pause();else resume();});
  document.addEventListener?.('tli-panel-switched',event=>{state.panelActive=event.detail?.panelId==='panel-visualizer';if(state.panelActive)resume();else pause();});
})();
function setupVisualizer(){window.TLIFreeSpace.setup();}
function loadVisualizerDrives(){return window.TLIFreeSpace.loadDrives();}
function renderStorageExplorer(){throw new Error('Storage observations require a validated job result.');}
