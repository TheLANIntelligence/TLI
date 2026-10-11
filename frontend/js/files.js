// ---------- FILES PANEL ----------

const FILES_LAST_ROOT_KEY = "tli_files_last_root_v1";
const FILES_BUCKET_DEST_KEY = "tli_files_bucket_dests_v1";

let filesLastScanBuckets = null;
let filesBucketDestinations = {};
let filesLastScanRoot = "";
let filesScanEpoch = 0;
let filesPrivateEpoch = 0;
let filesDraftRevision = 0;
let filesOperationBusy = false;
let filesOperationReview = null;
let filesPanelSetup = false;
let filesAdviceBusy = false;
const FILES_SELECTION_LIMIT = 500;
const FILES_PAGE_SIZE = 50;
let filesSelectedNames = new Set();
let filesSearch = "", filesCategory = "all", filesPage = 0;
let filesScanBusy = false, filesLocked = false;
let filesPendingCandidates = null;
let filesScanHostId = null;

function filesPathKey(path) {
  const value = String(path || "");
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : value.replace(/\/+$/, '') || '/';
}
function filesSamePath(a, b) { return !!a && !!b && filesPathKey(a) === filesPathKey(b); }
function filesKnownNames() { return Object.values(filesLastScanBuckets?.buckets || {}).flat(); }
function filesSelect(names, selected = true) {
  if (filesOperationBusy || filesScanBusy || filesLocked || !filesSamePath($("filesRootInput")?.value.trim(), filesLastScanRoot)) return false;
  const known = new Set(filesKnownNames()), next = new Set(filesSelectedNames);
  for (const name of names) { if (known.has(name)) { if (selected) next.add(name); else next.delete(name); } }
  if (next.size > FILES_SELECTION_LIMIT) {
    filesSetStatus(`Choose at most ${FILES_SELECTION_LIMIT} files. Narrow the selection or finish the current batch first. Your selection is unchanged.`); return false;
  }
  filesSelectedNames = next; filesInvalidateReview(); filesRenderSelection(); return true;
}
function filesPrepare(intent, replace = false) {
  if (filesLocked || filesOperationBusy || filesScanBusy || !intent || typeof intent.root !== 'string') return {status:'unavailable'};
  const input = $("filesRootInput"); if (!input) return {status:'unavailable'};
  const current = input.value.trim() || filesLastScanRoot;
  if (current && !filesSamePath(current, intent.root) && !replace) return {status:'draft-conflict', root:current};
  if (!filesSamePath(input.value.trim(), intent.root)) {
    input.value = intent.root; filesScanEpoch++; filesInvalidateReview();
  }
  filesPendingCandidates = intent.candidatePaths?.length ? {root:intent.root, paths:[...intent.candidatePaths], observation:intent.observation || null} : null;
  filesRenderSelection();
  filesSetStatus(filesSamePath(filesLastScanRoot, intent.root) ? 'Folder prepared. Review the current selection; no scan or move ran.' :
    `Folder prepared. Choose Scan folder to list its immediate files.${filesLastScanRoot ? ' The previous draft remains available until this scan succeeds.' : ''}`);
  return {status:'prepared'};
}
function filesDescribeDraft() {
  return {root:$("filesRootInput")?.value.trim() || '', scannedRoot:filesLastScanRoot, selectedCount:filesSelectedNames.size,
    busy:filesOperationBusy || filesScanBusy, hasScan:!!filesLastScanBuckets, hostId:filesScanHostId};
}

function filesInvalidateReview(message = "The plan changed. Review it again before changing files.") {
  filesDraftRevision++;
  filesOperationReview = null;
  const confirm = $("files-operation-confirm");
  if (confirm) confirm.disabled = true;
  const note = $("files-operation-note");
  if (note && $("files-operation-review")?.getAttribute('data-operation-phase') !== 'result') note.textContent = message;
}

function filesSetOperationBusy(busy) {
  filesOperationBusy = busy;
  for (const id of ["filesScanButton", "filesPreviewButton", "filesRunButton", "filesUndoButton",
    "filesBatchRenameButton", "filesRootInput", "filesRenamePrefix"]) {
    const el = $(id); if (el) el.disabled = busy;
  }
  document.querySelectorAll(".files-bucket-input, [data-files-preset], [data-files-select]").forEach(el => { el.disabled = busy; });
  const confirm = $("files-operation-confirm");
  if (confirm) confirm.disabled = busy || !filesOperationReview?.data.can_execute;
  filesRenderSelection();
}

function filesReviewBox() {
  let box = $("files-operation-review");
  if (!box) {
    box = document.createElement("section"); box.id = "files-operation-review";
    box.setAttribute("aria-label", "File operation review and results");
    box.style.minWidth = "0";
    $("filesStatus")?.parentElement?.appendChild(box);
  }
  return box;
}

function filesValidOperation(data, preview, kind) {
  const states = preview ? ["ready", "unchanged", "blocked"] :
    ["moved", "renamed", "undone", "unchanged", "blocked", "failed", "unknown", "not_attempted"];
  if (!data || typeof data.ok !== "boolean" || data.preview !== preview || typeof data.message !== "string" ||
      !Array.isArray(data.results) || data.results.length > 500 || data.results.some(row => !row ||
      typeof row.source !== "string" || typeof row.destination !== "string" ||
      typeof row.reason !== "string" || !states.includes(row.status))) return false;
  if (preview) return data.ok && data.status === "preview" && /^[a-f0-9]{32}$/.test(data.preview_id) &&
    typeof data.expires_at === "number" && Number.isFinite(data.expires_at) && typeof data.can_execute === "boolean" &&
    (!data.can_execute || (data.results.some(row => row.status === "ready") && data.results.every(row => row.status !== "blocked"))) &&
    (data.history === undefined || (Array.isArray(data.history) && data.history.length <= 101 && data.history.every(row => row &&
      typeof row.id === "string" && typeof row.type === "string" && (row.timestamp == null || typeof row.timestamp === "string"))));
  const success = kind === "undo" ? "undone" : kind === "rename" ? "renamed" : "moved";
  const countField = kind === "undo" ? "undone" : kind === "rename" ? "count" : "moved_count";
  return ["completed", "partial", "failed", "rejected", "no_op"].includes(data.status) &&
    typeof data.undo_available === "boolean" && data[countField] === data.results.filter(row => row.status === success).length &&
    (!data.ok || (["completed", "no_op"].includes(data.status) && data.results.every(row => [success, "unchanged"].includes(row.status)))) &&
    (data.ok || !["completed", "no_op"].includes(data.status));
}

async function filesOperationRequest(kind, payload, preview) {
  // Older rename/undo handlers ignore confirm:false. Never POST until the host
  // explicitly advertises the reviewed protocol, including after a restart.
  const epoch = filesPrivateEpoch;
  try {
    const gate = await fetch("/file/operations/capabilities", {method: "GET", cache: "no-store"});
    let capabilities; try { capabilities = await gate.json(); } catch { /* Fail closed below. */ }
    if (!gate.ok || capabilities?.ok !== true || capabilities.protocol !== "reviewed-file-operations-v1") {
      throw new Error("Reviewed file operations are unavailable on this running TLI host. Finish any active work, then restart TLI with the updated code before using Organizer, Rename or Undo.");
    }
    if (epoch !== filesPrivateEpoch) throw new Error("The browser session changed. Review the operation again after unlocking.");
  } catch (error) {
    error.fileRequestSent = false; throw error;
  }
  const res = await fetch("/file/" + kind, {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload)});
  let data; try { data = await res.json(); } catch { throw new Error("TLI returned an unreadable result."); }
  if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Request failed (${res.status}).`);
  if (!filesValidOperation(data, preview, kind)) throw new Error("TLI did not return a complete, confirmed file-operation result.");
  return data;
}

function filesRenderOperation(data, kind, preview) {
  const box = filesReviewBox(); box.replaceChildren();
  box.setAttribute('data-operation-phase', preview ? 'review' : 'result');
  const heading = document.createElement("h4");
  heading.textContent = preview ? `Review ${kind === "organize" ? "file moves" : kind === "rename" ? "renames" : "undo"}` :
    ({completed: "File operation completed", partial: "Files need attention — partial completion", failed: "File operation failed",
      rejected: "File operation rejected", no_op: "No file changes needed"}[data.status]);
  const note = document.createElement("p"); note.id = "files-operation-note"; note.setAttribute("role", "status");
  note.textContent = data.message;
  box.append(heading, note);
  if (preview && kind === "undo" && data.history?.length) {
    const label = document.createElement("label"); label.textContent = "Recorded operation ";
    const history = document.createElement("select"); history.id = "files-operation-history";
    history.style.maxWidth = "100%";
    for (const item of data.history) {
      const option = document.createElement("option"); option.value = item.id;
      option.textContent = `${item.type} · ${item.timestamp || "Date not recorded"} · ${item.undo_status || item.status || "Review required"}`;
      history.appendChild(option);
    }
    history.value = data.operation_id || "";
    history.addEventListener("change", () => filesUndoLast(history.value));
    label.appendChild(history); box.appendChild(label);
  }
  const list = document.createElement("ol"); list.style.paddingInlineStart = "22px";
  list.style.maxHeight = "360px"; list.style.overflowY = "auto"; list.style.overflowWrap = "anywhere";
  const labels = {ready:"Ready", unchanged:"Unchanged", blocked:"Blocked", moved:"Moved", renamed:"Renamed",
    undone:"Restored", failed:"Failed", unknown:"Outcome unconfirmed — inspect both paths", not_attempted:"Not attempted"};
  for (const row of data.results) {
    const item = document.createElement("li"); item.style.marginBlock = "12px";
    const state = document.createElement("strong"); state.textContent = labels[row.status];
    const from = document.createElement("div"); from.textContent = "From: " + row.source;
    const to = document.createElement("div"); to.textContent = "To: " + row.destination;
    item.append(state, from, to);
    if (row.reason) { const reason = document.createElement("div"); reason.textContent = row.reason; item.appendChild(reason); }
    list.appendChild(item);
  }
  box.appendChild(list);
  if (preview) {
    const warning = document.createElement("p");
    warning.textContent = data.can_execute ? "Nothing has changed. Check every path, then confirm this review. It expires in ten minutes." :
      "Nothing has changed. Resolve blocked entries before reviewing again." + (kind === 'undo' ? " Older records without file identity require manual undo." : '');
    box.appendChild(warning);
    if (kind === 'organize' && data.results.some(row => row.status === 'blocked')) {
      const leave = document.createElement('button'); leave.type = 'button'; leave.className = 'pill-btn ghost';
      leave.id = 'files-leave-blocked'; leave.textContent = 'Leave blocked files here';
      const revision = filesDraftRevision;
      leave.addEventListener('click', () => {
        if (filesOperationBusy || revision !== filesDraftRevision || filesOperationReview?.data !== data) return;
        const blocked = new Set(data.results.filter(row => row.status === 'blocked').map(row => filesPathKey(row.source)));
        const names = filesKnownNames().filter(name => blocked.has(filesPathKey(filesLastScanRoot.replace(/[\\/]$/, '') + '/' + name)));
        if (filesSelect(names, false)) filesSetStatus('Blocked files were removed from the draft. Review moves again to check the remaining files. Nothing moved.');
        leave.disabled = true;
      });
      box.appendChild(leave);
    }
    const confirm = document.createElement("button"); confirm.id = "files-operation-confirm"; confirm.className = "pill-btn primary";
    const count = data.results.filter(row => row.status === "ready").length;
    confirm.textContent = `${kind === "undo" ? "Restore" : kind === "rename" ? "Rename" : "Move"} ${count} file${count === 1 ? "" : "s"}`;
    confirm.disabled = !data.can_execute; confirm.addEventListener("click", filesConfirmOperation); box.appendChild(confirm);
  } else {
    const guidance = document.createElement("p");
    guidance.textContent = data.undo_available ? "Undo evidence was saved. Use Review undo to inspect the original paths before restoring." :
      "Keep this result. Inspect any unconfirmed paths before another operation.";
    if (kind !== "undo") guidance.textContent += " Scan the folder again before organizing another batch.";
    box.appendChild(guidance);
  }
  box.scrollIntoView?.({block: "nearest", behavior: "smooth"});
}

async function filesPreviewOperation(kind, payload) {
  if (filesOperationBusy || filesScanBusy || filesLocked) return;
  filesScanEpoch++;
  filesInvalidateReview("");
  const revision = filesDraftRevision, epoch = filesPrivateEpoch;
  filesSetOperationBusy(true); filesSetStatus("Checking the complete plan. No files are being changed…");
  try {
    const data = await filesOperationRequest(kind, {...payload, confirm: false}, true);
    if (epoch !== filesPrivateEpoch || revision !== filesDraftRevision) return;
    filesOperationReview = {kind, payload: JSON.parse(JSON.stringify(payload)), data, revision};
    filesRenderOperation(data, kind, true); filesSetStatus(data.message);
  } catch (error) {
    if (epoch === filesPrivateEpoch) filesSetStatus("Review unavailable: " + error.message + " No file-change request was sent.");
  } finally { if (epoch === filesPrivateEpoch) filesSetOperationBusy(false); }
}

async function filesConfirmOperation() {
  const review = filesOperationReview;
  if (filesOperationBusy || !review?.data.can_execute) return;
  const current = review.kind === "organize" ? filesBuildOrganizePayload() : review.kind === "rename" ?
    {path: ($("filesRootInput")?.value || "").trim(), prefix: ($("filesRenamePrefix")?.value || "").trim()} : review.payload;
  if (review.revision !== filesDraftRevision || JSON.stringify(current) !== JSON.stringify(review.payload) || review.data.expires_at * 1000 <= Date.now()) {
    filesInvalidateReview("This review expired or changed. Preview again before changing files."); return;
  }
  const epoch = filesPrivateEpoch;
  filesOperationReview = null; filesSetOperationBusy(true);
  filesSetStatus("Applying the reviewed file operation…");
  try {
    const data = await filesOperationRequest(review.kind, {...review.payload, confirm: true, preview_id: review.data.preview_id}, false);
    if (epoch !== filesPrivateEpoch) return;
    filesRenderOperation(data, review.kind, false); filesSetStatus(data.message);
    if (data.ok && data.status === "completed") {
      filesLastScanBuckets = null; filesLastScanRoot = ""; filesSelectedNames.clear(); filesPendingCandidates = null; filesScanEpoch++; filesRenderBuckets();
    }
  } catch (error) {
    if (epoch === filesPrivateEpoch) {
      const message = error.fileRequestSent === false ? "File operation not sent: " + error.message :
        "Outcome not confirmed: " + error.message + " No retry was sent. Inspect the reviewed paths and Review undo before another request.";
      filesSetStatus(message); const note = $("files-operation-note"); if (note) note.textContent = message;
    }
  } finally { if (epoch === filesPrivateEpoch) filesSetOperationBusy(false); }
}

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
  if (filesOperationBusy || filesScanBusy || filesLocked) return;
  const path = _tliPathPreset(kind);
  const prepared = window.TLIStorageWorkspace?.prepare ? window.TLIStorageWorkspace.prepare({view:'organize',root:path,source:'organize'}) : filesPrepare({root:path});
  if (prepared.status === 'prepared') _foSetActiveTile(kind);
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
    tr.innerHTML = `<td>${escapeHtml(String(ext))}</td><td>${escapeHtml(String(count))}</td><td title="${escapeHtml(example)}">${escapeHtml(example)}</td>`;
    tbody.appendChild(tr);
  });
}

function filesRenderBuckets() {
  const container = $("filesBucketsContainer");
  if (!container) return;
  container.replaceChildren();
  if (!filesLastScanBuckets) {
    container.innerHTML = '<p class="fo-empty-state">Scan a folder to see the plan.</p>';
    for (const id of ['filesRunButton','filesPreviewButton']) { const button = $(id); if (button) button.disabled = true; }
    return;
  }
  const make = (tag, text, id) => { const node = document.createElement(tag); if (text) node.textContent = text; if (id) node.id = id; return node; };
  const tools = make('div', '', 'files-selection-tools'); tools.className = 'files-selection-tools';
  const searchLabel = make('label', 'Find files');
  const search = make('input', '', 'files-selection-search'); search.type = 'search'; search.value = filesSearch; search.placeholder = 'Search filenames';
  search.addEventListener('input', () => { filesSearch = search.value; filesPage = 0; filesRenderSelection(); }); searchLabel.append(search);
  const categoryLabel = make('label', 'File type');
  const category = make('select', '', 'files-selection-category');
  for (const name of ['all', ...Object.keys(filesLastScanBuckets.buckets || {}).sort()]) { const option = make('option', name === 'all' ? 'All types' : name); option.value = name; category.append(option); }
  if (!Object.hasOwn(filesLastScanBuckets.buckets || {}, filesCategory)) filesCategory = 'all';
  category.value = filesCategory; category.addEventListener('change', () => { filesCategory = category.value; filesPage = 0; filesRenderSelection(); }); categoryLabel.append(category);
  tools.append(searchLabel, categoryLabel);
  const count = make('p', '', 'files-selection-count'); count.setAttribute('role', 'status');
  const resume = make('button', 'Return to the previous folder draft', 'files-return-draft'); resume.type = 'button'; resume.className = 'pill-btn ghost';
  resume.addEventListener('click', () => {
    if (!filesLastScanRoot) return;
    const intent = {view:'organize',root:filesLastScanRoot,source:'organize'};
    if (filesPrepare(intent,true).status === 'prepared') window.TLIStorageWorkspace?.prepare?.(intent);
  });
  const actions = make('div'); actions.className = 'files-selection-actions';
  for (const [id, text, action] of [
    ['files-select-matching', 'Select matching files', () => filesSelect(filesMatchingRows().map(row => row.name))],
    ['files-leave-matching', 'Leave matching files here', () => filesSelect(filesMatchingRows().map(row => row.name), false)],
    ['files-clear-selection', 'Leave all files here', () => filesSelect([...filesSelectedNames], false)]
  ]) { const button = make('button', text, id); button.type = 'button'; button.className = 'pill-btn ghost'; button.setAttribute('data-files-select', ''); button.addEventListener('click', action); actions.append(button); }
  const candidates = make('div', '', 'files-candidates'); candidates.className = 'files-candidate-note';
  const destinations = make('details', '', 'files-destinations'); destinations.className = 'files-destinations'; destinations.open = true;
  destinations.append(make('summary', 'Destination folders', 'files-destination-title'));
  const destinationList = make('div'); destinationList.className = 'files-destination-list';
  for (const name of Object.keys(filesLastScanBuckets.buckets || {}).sort()) {
    if (!Object.hasOwn(filesBucketDestinations, name)) filesBucketDestinations[name] = name;
    const label = make('label', name + ' →'); label.setAttribute('data-files-destination',name); const input = make('input'); input.type = 'text'; input.className = 'files-bucket-input'; input.value = filesBucketDestinations[name];
    input.setAttribute('aria-label', name + ' destination subfolder');
    input.addEventListener('input', () => { filesBucketDestinations[name] = input.value.trim(); filesSaveDestinations(); filesInvalidateReview(); filesRenderSelection(); });
    label.append(input); destinationList.append(label);
  }
  destinations.append(destinationList);
  const list = make('div', '', 'files-file-list'); list.className = 'files-file-list';
  const pagination = make('div'); pagination.className = 'files-selection-actions';
  const previous = make('button', 'Previous', 'files-page-prev'), next = make('button', 'Next', 'files-page-next');
  for (const button of [previous,next]) { button.type = 'button'; button.className = 'pill-btn ghost'; }
  previous.addEventListener('click', () => { filesPage--; filesRenderSelection(); }); next.addEventListener('click', () => { filesPage++; filesRenderSelection(); });
  pagination.append(previous, make('span', '', 'files-page-count'), next);
  container.append(make('p', 'Only selected files enter the move review. Unselected files stay where they are. Subfolders are not scanned.'), resume, tools, candidates, count, actions, destinations, list, pagination);
  filesRenderSelection();
}

function filesMatchingRows() {
  return Object.entries(filesLastScanBuckets?.buckets || {}).flatMap(([category,names]) => names.map(name => ({name,category})))
    .filter(row => (filesCategory === 'all' || row.category === filesCategory) && row.name.toLocaleLowerCase().includes(filesSearch.toLocaleLowerCase()))
    .sort((a,b) => a.name.localeCompare(b.name) || a.category.localeCompare(b.category));
}
function filesRenderSelection() {
  const list = $('files-file-list'); if (!list) return;
  const focus = document.activeElement?.id;
  const current = filesSamePath($('filesRootInput')?.value.trim(), filesLastScanRoot);
  const disabled = filesOperationBusy || filesScanBusy || filesLocked || !current;
  const resume = $('files-return-draft'); if (resume) { resume.hidden = current; resume.disabled = filesOperationBusy || filesScanBusy || filesLocked; }
  const rows = filesMatchingRows(); filesPage = Math.max(0, Math.min(filesPage, Math.max(0, Math.ceil(rows.length / FILES_PAGE_SIZE) - 1)));
  const remaining = filesKnownNames().length - filesSelectedNames.size;
  $('files-selection-count').textContent = `${filesSelectedNames.size} of ${FILES_SELECTION_LIMIT} files selected · ${remaining} ${remaining === 1 ? 'stays' : 'stay'} here · ${rows.length} match${current ? '' : ' · Previous folder draft'}`;
  const selectedCategories = new Set(Object.entries(filesLastScanBuckets?.buckets || {}).filter(([,names]) => names.some(name => filesSelectedNames.has(name))).map(([category])=>category));
  $('files-destination-title').textContent = selectedCategories.size ? 'Destinations for selected files' : 'Destination folders';
  document.querySelectorAll('[data-files-destination]').forEach(label => { label.hidden = selectedCategories.size > 0 && !selectedCategories.has(label.getAttribute('data-files-destination')); });
  list.replaceChildren();
  let ordinal = filesPage * FILES_PAGE_SIZE;
  for (const row of rows.slice(filesPage * FILES_PAGE_SIZE, (filesPage + 1) * FILES_PAGE_SIZE)) {
    const label = document.createElement('label'); label.className = 'files-file-choice';
    const input = document.createElement('input'); input.id = 'files-choice-' + ordinal++; input.type = 'checkbox'; input.checked = filesSelectedNames.has(row.name); input.disabled = disabled; input.setAttribute('data-files-select', ''); input.setAttribute('aria-label', 'Select ' + row.name);
    input.addEventListener('change', () => { const checked = input.checked; if (!filesSelect([row.name], checked)) input.checked = filesSelectedNames.has(row.name); });
    const name = document.createElement('span'); name.textContent = row.name; name.className = 'files-choice-name';
    const detail = document.createElement('span'); detail.className = 'files-choice-destination'; detail.textContent = filesSelectedNames.has(row.name) ? `To: ${filesBucketDestinations[row.category] || 'Choose a destination'}` : 'Leave here';
    label.append(input, name, detail); list.append(label);
  }
  if (!rows.length) { const empty = document.createElement('p'); empty.textContent = 'No files match this view.'; list.append(empty); }
  for (const id of ['files-select-matching','files-leave-matching','files-clear-selection']) $(id).disabled = disabled;
  for (const id of ['filesRunButton','filesPreviewButton']) { const button = $(id); if (button) button.disabled = disabled || !filesBuildOrganizePayload(); }
  $('files-page-prev').disabled = filesPage === 0; $('files-page-next').disabled = (filesPage + 1) * FILES_PAGE_SIZE >= rows.length;
  $('files-page-count').textContent = rows.length ? `${filesPage * FILES_PAGE_SIZE + 1}–${Math.min(rows.length,(filesPage + 1) * FILES_PAGE_SIZE)} of ${rows.length}` : '0 files';
  const box = $('files-candidates'); box.replaceChildren();
  if (filesPendingCandidates && filesSamePath(filesPendingCandidates.root, filesLastScanRoot) && current) {
    const paths = new Set(filesPendingCandidates.paths.map(filesPathKey));
    const names = filesKnownNames().filter(name => paths.has(filesPathKey(filesLastScanRoot.replace(/[\\/]$/, '') + '/' + name)));
    const note = document.createElement('p'); note.textContent = `${names.length} suggested ${names.length === 1 ? 'file matches' : 'files match'} this folder; ${paths.size - names.length} are unavailable or outside its immediate files. Check the names before adding them.`;
    const namesReview = document.createElement('details'), summary = document.createElement('summary'), namesList = document.createElement('ul');
    summary.textContent = 'Review suggested filenames'; namesList.className = 'files-suggested-names';
    for (const name of names) { const item = document.createElement('li'); item.textContent = name; namesList.append(item); }
    namesReview.append(summary,namesList);
    const add = document.createElement('button'); add.type = 'button'; add.className = 'pill-btn'; add.textContent = `Add ${names.length} matching ${names.length === 1 ? 'file' : 'files'} to plan`; add.disabled = disabled || !names.length; add.id = 'files-add-candidates';
    add.addEventListener('click', () => { if (filesSelect(names)) { filesPendingCandidates = null; filesRenderSelection(); } }); box.append(note,namesReview,add);
  }
  if (focus) $(focus)?.focus?.({preventScroll:true});
}
// Helper used by the Quick actions cards.
// It assumes /file/scan has already been run and filled filesLastScanBuckets.
function filesApplyQuick(bucketName, destName, description) {
  if (filesOperationBusy || filesScanBusy || filesLocked) return;
  if (!filesLastScanBuckets) {
    showToast("Scan this folder first so TLI can see what's inside.");
    return;
  }

  const buckets = filesLastScanBuckets.buckets || {};
  const files = buckets[bucketName];

  if (!files || !files.length) {
    filesSetStatus(`No files in the "${bucketName}" category were found in this folder.`);
    debugLog("info", `[FILES] Quick action: no ${bucketName} bucket for current scan.`);
    return;
  }

  // A recipe adds exactly its advertised category; other selections stay explicit.
  if (!filesSelect(files)) return;
  filesBucketDestinations[bucketName] = destName;
  filesInvalidateReview();
  filesRenderBuckets();

  const msg = `Added ${files.length} ${description || bucketName} to the plan → ${destName}/. Review moves before anything changes.`;
  filesSetStatus(msg);
  debugLog(
    "info",
    `[FILES] Quick action applied for ${bucketName} → ${destName}, ${files.length} files in bucket.`
  );
}

function filesBuildOrganizePayload() {
  if (!filesLastScanBuckets || !filesSelectedNames.size || filesSelectedNames.size > FILES_SELECTION_LIMIT) return null;
  const basePath = ($("filesRootInput")?.value || "").trim();
  if (!filesSamePath(basePath, filesLastScanRoot)) return null;
  const buckets = filesLastScanBuckets.buckets || {};
  const actions = {};
  let missingDestination = false, included = 0;

  Object.entries(buckets).forEach(([bucketName, fileList]) => {
    const destName = (filesBucketDestinations[bucketName] || "").trim();
    const selected = (fileList || []).filter(name => filesSelectedNames.has(name));
    if (!selected.length) return;
    if (!destName) { missingDestination = true; return; }
    if (!Object.hasOwn(actions, destName)) Object.defineProperty(actions, destName, {value: [], enumerable: true});
    actions[destName].push(...selected); included += selected.length;
  });

  if (!basePath || missingDestination || included !== filesSelectedNames.size || !Object.keys(actions).length) return null;
  return { path: basePath, actions };
}

async function filesScanFolder() {
  if (filesOperationBusy || filesScanBusy || filesLocked) return;
  const path = ($("filesRootInput")?.value || "").trim();
  if (!path) {
    showToast("Enter a folder path first.");
    return;
  }

  filesInvalidateReview();
  filesScanBusy = true;
  filesRenderSelection();
  const epoch = ++filesScanEpoch, privateEpoch = filesPrivateEpoch;
  const current = () => epoch === filesScanEpoch && privateEpoch === filesPrivateEpoch && path === ($("filesRootInput")?.value || "").trim();
  const previous = filesLastScanRoot ? ` Previous results for ${filesLastScanRoot} remain visible until this scan succeeds.` : "";
  filesSetStatus("Scanning folder…" + previous);
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
    if (!current()) return;
    if (!extRes.ok) {
      const txt = await extRes.text();
      filesSetStatus("Scan failed: " + extRes.status + " · " + txt + previous);
      debugLog("error", "POST /files/scan failed: " + extRes.status + " · " + txt);
      return;
    }
    const extData = await extRes.json();
    if (!current()) return;
    if (!extData || !Array.isArray(extData.extension_summary) || extData.extension_summary.some(row => !row || typeof row !== "object")) {
      throw new Error("Folder scan returned an invalid file-type summary.");
    }

    const bucketRes = await fetch("/file/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    if (!current()) return;
    if (!bucketRes.ok) {
      const txt = await bucketRes.text();
      filesSetStatus("Could not read file categories: " + bucketRes.status + " · " + txt + previous);
      debugLog("error", "POST /file/scan failed: " + bucketRes.status + " · " + txt);
      return;
    }
    const bucketData = await bucketRes.json();
    if (!current()) return;
    if (!bucketData || !bucketData.buckets || typeof bucketData.buckets !== "object" || Array.isArray(bucketData.buckets) ||
        Object.values(bucketData.buckets).some(list => !Array.isArray(list) || list.some(name => typeof name !== "string"))) {
      throw new Error("Folder scan returned invalid file lists.");
    }
    const scannedNames = Object.values(bucketData.buckets).flat();
    if (new Set(scannedNames).size !== scannedNames.length || scannedNames.some(name => !name || /[\/\\\x00-\x1f]/.test(name))) throw new Error('Folder scan returned invalid file lists.');
    const sameRoot = filesSamePath(path, filesLastScanRoot);
    const selected = sameRoot ? new Set([...filesSelectedNames].filter(name => scannedNames.includes(name))) : new Set();
    if (!sameRoot) { filesSearch = ''; filesCategory = 'all'; }
    filesLastScanBuckets = bucketData;
    filesLastScanRoot = path;
    filesSelectedNames = selected; filesPage = 0;
    filesScanHostId = window.TLIUI?.hostIdentity?.get?.().id || window.TLIHostIdentity?.get?.().id || null;
    filesRenderExtensionTable(extData.extension_summary);
    filesRenderBuckets();

    const total = bucketData.total_files ?? 0;
    const bucketCount = Object.keys(bucketData.buckets || {}).length;
    filesSetStatus(`Scan complete: ${total} ${total === 1 ? 'file' : 'files'} in ${bucketCount} ${bucketCount === 1 ? 'category' : 'categories'}. ${filesSelectedNames.size} selected. Choose files for the plan.`);
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
      summaryMeta.innerHTML = `<strong>${escapeHtml(String(total))}</strong> ${total === 1 ? 'file' : 'files'} found across <strong>${bucketCount}</strong> ${bucketCount === 1 ? 'category' : 'categories'} in <code style="font-size:11px;opacity:.8">${escapeHtml(scanPath)}</code>`;
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
    if (!current()) return;
    console.error(err);
    filesSetStatus("Scan error: " + err.message + previous);
    debugLog("error", "FILES scan error: " + err.message);
  } finally { if (privateEpoch === filesPrivateEpoch) { filesScanBusy = false; filesRenderSelection(); } }
}

async function filesPreviewOrganize() {
  const payload = filesBuildOrganizePayload();
  if (!payload) { showToast("Scan the current folder, select up to 500 files and choose a destination for every selected category."); return; }
  return filesPreviewOperation("organize", payload);
}

// Both entry points open the same exact-path review; neither executes a move.
async function filesRunOrganize() { return filesPreviewOrganize(); }

async function filesUndoLast(operationId = null) {
  return filesPreviewOperation("undo", {operation_id: typeof operationId === "string" ? operationId : null});
}

async function filesBatchRename() {
  const prefix = ($("filesRenamePrefix")?.value || "").trim();
  const path = ($("filesRootInput")?.value || "").trim();
  if (!prefix || !path) { showToast("Enter a folder path and prefix before reviewing renames."); return; }
  return filesPreviewOperation("rename", {path, prefix});
}

// Suggestions are text for review; neither endpoint edits the reviewed file plan.
async function filesRequestAdvice(kind) {
  if (filesAdviceBusy) return {ok: false, busy: true};
  const path = ($("filesRootInput")?.value || "").trim();
  const rules = ($("filesRulesTextarea")?.value || "").trim();
  const box = $(kind === "rules" ? "filesRulesSummary" : "filesInsightBox");
  if (!box) return {ok: false};
  if (!path || (kind === "rules" && !rules)) {
    filesSetStatus(!path ? "Enter a folder path first." : "Describe the organization suggestion you want.");
    return {ok: false};
  }
  const epoch = filesPrivateEpoch;
  const current = () => epoch === filesPrivateEpoch && path === ($("filesRootInput")?.value || "").trim() &&
    (kind !== "rules" || rules === ($("filesRulesTextarea")?.value || "").trim());
  const buttons = [$("filesCustomRulesButton"), $("filesInsightButton")].filter(Boolean);
  filesAdviceBusy = true;
  buttons.forEach(button => { button.disabled = true; });
  box.setAttribute("aria-busy", "true");
  filesSetStatus(kind === "rules" ? "Asking AI for an organization suggestion. Your current draft stays unchanged…" :
    "Asking AI for a folder summary. Previous advice remains available…");
  try {
    const response = await fetch(kind === "rules" ? "/files/apply_rules" : "/files/insight", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(kind === "rules" ? {root: path, rules} : {root: path})
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.detail || data?.message || data?.error || `HTTP ${response.status}`);
    const answer = data?.summary || (kind === "insight" && data?.insight);
    if (typeof answer !== "string" || !answer.trim()) throw new Error("AI returned no usable suggestion.");
    if (!current()) {
      if (epoch === filesPrivateEpoch) filesSetStatus("The folder or request changed. Previous advice is unchanged; ask again for the current folder.");
      return {ok: false, stale: true};
    }
    const checked = new Date().toLocaleString();
    box.textContent = `Folder: ${path}\nAI response received: ${checked}\n\n${answer.trim()}`;
    filesSetStatus(kind === "rules" ? "AI suggestion received. Review it below, then edit the destination categories yourself if useful. Your draft and files are unchanged." :
      "AI summary received. This is advice about the folder, not a file operation.");
    return {ok: true};
  } catch (error) {
    if (epoch === filesPrivateEpoch) filesSetStatus("AI request failed: " + error.message + " Previous advice and your file plan are unchanged. Retry when ready.");
    return {ok: false, error: error.message};
  } finally {
    filesAdviceBusy = false;
    buttons.forEach(button => { button.disabled = false; });
    box.removeAttribute("aria-busy");
  }
}
function filesUseCustomRules() { return filesRequestAdvice("rules"); }
function filesAskAiAboutFolder() { return filesRequestAdvice("insight"); }

function setupFilesPanel() {
  const root = $("filesRootInput");
  if (!root || filesPanelSetup) return;
  filesPanelSetup = true;

  // Quick presets — auto-scan and mark active tile
  document.querySelectorAll("[data-files-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      filesSetPreset(btn.getAttribute("data-files-preset"));
    });
  });

  // Manual path entry → clear active tile selection
  root.addEventListener("input", () => {
    filesScanEpoch++;
    filesInvalidateReview();
    if (filesLastScanRoot) filesSetStatus(`Showing results for ${filesLastScanRoot}. Scan the entered folder to replace them.`);
    document.querySelectorAll("[data-files-preset]").forEach(b => b.classList.remove("active"));
    filesRenderSelection();
  });

  // Prepare the folder in Free Space without starting another scan.
  $("filesScanInVisButton")?.addEventListener("click", () => {
    const p = (root.value || "").trim();
    if (!p) { showToast("Enter a path first."); return; }
    if (window.TLIStorageWorkspace?.prepare) window.TLIStorageWorkspace.prepare({view:'space',root:p,source:'organize'});
    else switchPanelAndScan("panel-visualizer", p);
  });

  // Main controls
  $("filesScanButton")?.addEventListener("click", filesScanFolder);
  $("filesPreviewButton")?.addEventListener("click", filesPreviewOrganize);
  $("filesRunButton")?.addEventListener("click", filesRunOrganize);
  $("filesUndoButton")?.addEventListener("click", () => filesUndoLast());
  $("filesBatchRenameButton")?.addEventListener("click", filesBatchRename);
  $("filesCustomRulesButton")?.addEventListener("click", filesUseCustomRules);
  $("filesInsightButton")?.addEventListener("click", filesAskAiAboutFolder);
  $("filesRenamePrefix")?.addEventListener("input", () => filesInvalidateReview());
  for (const [id, label] of [["filesRunButton", "Review moves"], ["filesUndoButton", "Review undo"], ["filesBatchRenameButton", "Preview rename"]]) {
    const button = $(id); if (button) button.textContent = label;
  }
  const clearPrivate = () => {
    filesPrivateEpoch++; filesScanEpoch++; filesInvalidateReview("");
    for (const id of ["filesRulesSummary", "filesInsightBox"]) { const box = $(id); if (box) box.textContent = ""; }
    psClearScanPreview();
    _psPrintFile = null;
    for (const id of ["ps-chosen-file", "ps-print-status", "ps-scan-status"]) {
      const element = $(id); if (element) element.textContent = "";
    }
    const printInput = $("ps-file-input"); if (printInput) printInput.value = "";
    filesLastScanBuckets = null; filesLastScanRoot = ""; filesSelectedNames.clear(); filesPendingCandidates = null; filesScanHostId = null;
    filesSearch = ''; filesCategory = 'all'; filesPage = 0; filesScanBusy = false;
    root.value = ''; filesBucketDestinations = {};
    $("files-operation-review")?.replaceChildren(); filesRenderBuckets();
    $("filesExtTableBody")?.replaceChildren();
    const summary = $("fo-summary-meta"); if (summary) summary.textContent = "";
    const status = $("filesStatus"); if (status) status.textContent = "";
    filesSetOperationBusy(false);
  };
  window.addEventListener("tli-session-locked", () => { filesLocked = true; clearPrivate(); });
  window.addEventListener("tli-session-unlocked", () => { filesLocked = false; });
  window.addEventListener("pagehide", clearPrivate);

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

window.TLIFiles = {prepare:filesPrepare, describeDraft:filesDescribeDraft, select:filesSelect};


// ════════════════════════════════════════════════════════════════════════════
// PRINT & SCAN STUDIO
// ════════════════════════════════════════════════════════════════════════════

let _psScanToken  = null;   // token returned by /printshop/scan
let _psScanBlob   = null;   // downloaded blob for save-to-disk
let _psScanUrl = null;
let _psScanBusy = false;
let _psScanEpoch = 0;
let _psTestPrintBusy = false;
let _psPrintBusy = false;

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

let _psLoaded = false, _psOpenPromise = null, _psPrinterPromise = null, _psHandoff = 0;

async function switchToPrintShop(printerName) {
  const handoff = ++_psHandoff;
  switchPanel("panel-printshop");
  psSwitchTab("print");
  await psOnOpen();
  if (_psPrinterPromise) await _psPrinterPromise;
  if (handoff !== _psHandoff) return false;
  const sel = document.getElementById("ps-printer-select");
  const found = !!sel && Array.from(sel.options).some(option => option.value === printerName && printerName);
  if (sel) sel.value = found ? printerName : "";
  psSetStatus("ps-print-status", found ? `Selected ${printerName}. Review the document and options before printing.` : `The requested printer is unavailable. Refresh printers and choose a printer before printing.`, found ? "" : "error");
  return found;
}

function psOnOpen() {
  if (_psOpenPromise) return _psOpenPromise;
  if (_psLoaded) return Promise.resolve();
  _psLoaded = true;
  psLoadScanners();
  _psOpenPromise = psLoadPrinters().finally(() => { _psOpenPromise = null; });
  return _psOpenPromise;
}

// ── Printers ─────────────────────────────────────────────────────────────

function psLoadPrinters() {
  if (_psPrinterPromise) return _psPrinterPromise;
  _psPrinterPromise = psFetchPrinters().finally(() => { _psPrinterPromise = null; });
  return _psPrinterPromise;
}

async function psFetchPrinters() {
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
  if (_psPrintBusy) return {ok: false, busy: true};
  const printer = document.getElementById("ps-printer-select")?.value;
  if (!printer) { psSetStatus("ps-print-status", "Select a printer first.", "warn"); return; }
  if (!_psPrintFile) { psSetStatus("ps-print-status", "Drop or pick a file to print.", "warn"); return; }
  const epoch = filesPrivateEpoch;
  _psPrintBusy = true;

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
    if (data?.status !== "sent" || data?.ok === false || typeof data.printer !== "string" || !data.printer ||
        !Number.isInteger(data.copies) || data.copies < 1) throw new Error("The host did not confirm print-job submission. Check the printer queue before retrying.");
    if (epoch !== filesPrivateEpoch) return {ok: true, hidden: true};
    const duplexLabel = { none: "", long: " · Duplex ↕", short: " · Duplex ↔" }[data.duplex] || "";
    psSetStatus("ps-print-status",
      `Submitted to ${data.printer} — ${data.copies} cop${data.copies === 1 ? "y" : "ies"} · ${data.orientation} · ${data.scale}%${duplexLabel}. Check the printer for physical output.`,
      "ok");
    return {ok: true};
  } catch (e) {
    if (epoch === filesPrivateEpoch) psSetStatus("ps-print-status", "Print submission failed: " + e.message, "error");
    return {ok: false, error: e.message};
  } finally {
    _psPrintBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = "🖨️\u00a0 Print Document"; }
  }
}

// ── Test Print ───────────────────────────────────────────────────────────

async function psTestPrint() {
  if (_psTestPrintBusy) return {ok: false, busy: true};
  _psTestPrintBusy = true;
  const epoch = filesPrivateEpoch;
  const btn = document.getElementById("ps-test-print-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  psSetStatus("ps-print-status", "Sending TLI test page to default printer…", "");
  try {
    // Delegate to the existing window.testPrint if available (has the ASCII art + status updates)
    if (typeof window.testPrint === "function") {
      const result = await window.testPrint();
      if (epoch !== filesPrivateEpoch) return;
      if (result?.ok !== true) throw new Error(result?.message || "The host did not confirm test-page submission.");
      psSetStatus("ps-print-status", "✓ TLI test page sent to default printer", "ok");
    } else {
      const r = await fetch("/api/printers/test_print", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (epoch !== filesPrivateEpoch) return;
      if (!r.ok || j.ok === false) throw new Error(j.message || j.detail || "HTTP " + r.status);
      psSetStatus("ps-print-status", "✓ TLI test page sent to default printer", "ok");
    }
  } catch (e) {
    if (epoch === filesPrivateEpoch) psSetStatus("ps-print-status", "Test print failed: " + e.message, "error");
  } finally {
    _psTestPrintBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = "Send test page to default printer"; }
  }
}

// ── Scan job ──────────────────────────────────────────────────────────────

async function psDeleteScanToken(token) {
  if (!/^[a-f0-9]{32}$/.test(token || "")) return false;
  try { return (await fetch(`/printshop/scan/${token}`, {method: "DELETE"})).ok; } catch { return false; }
}

// Clearing a browser preview is separate from stopping a scanner on the host.
function psClearScanPreview() {
  _psScanEpoch++;
  const token = _psScanToken;
  _psScanToken = null; _psScanBlob = null;
  if (_psScanUrl) URL.revokeObjectURL(_psScanUrl);
  _psScanUrl = null;
  const img = document.getElementById("ps-preview-img"); if (img) img.src = "";
  const wrap = document.getElementById("ps-preview-wrap"); if (wrap) wrap.hidden = true;
  return token;
}

async function psTriggerScan() {
  if (_psScanBusy) return {ok: false, busy: true};
  const scannerId = document.getElementById("ps-scanner-select")?.value;
  if (!scannerId) { psSetStatus("ps-scan-status", "Select a scanner first.", "warn"); return {ok: false}; }
  const resolution = parseInt(_psActiveVal("ps-res-group") || "300", 10);
  const colorMode = _psActiveVal("ps-mode-group") || "color";
  const epoch = ++_psScanEpoch;
  const privateEpoch = filesPrivateEpoch;
  const previousToken = _psScanToken;
  const current = () => epoch === _psScanEpoch && privateEpoch === filesPrivateEpoch;
  let candidateToken = null, candidateUrl = null, accepted = false;
  _psScanBusy = true;
  const btn = document.getElementById("ps-scan-btn");
  const controls = [...(document.querySelectorAll?.('#panel-printshop [data-action="psTriggerScan"]') || [])];
  controls.forEach(control => { control.disabled = true; });
  if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
  psSetStatus("ps-scan-status", _psScanBlob ? "Scanning again. Your previous scan remains available until its replacement is ready…" : "Scanning — please wait…", "");
  try {
    const form = new FormData();
    form.append("scanner_id", scannerId); form.append("resolution", String(resolution)); form.append("color_mode", colorMode);
    const response = await fetch("/printshop/scan", {method: "POST", body: form});
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) throw new Error(data?.detail || data?.message || `HTTP ${response.status}`);
    if (!/^[a-f0-9]{32}$/.test(data?.token || "") || data?.status !== "ok") throw new Error("The scanner returned an invalid result.");
    candidateToken = data.token;
    if (!current()) return {ok: false, discarded: true};
    const imageResponse = await fetch(`/printshop/scan/${candidateToken}`);
    if (!imageResponse.ok) throw new Error("Could not retrieve the new scan.");
    const blob = await imageResponse.blob();
    const signature = [...new Uint8Array(await blob.slice(0, 8).arrayBuffer())];
    if (blob.type !== "image/png" || signature.join(',') !== '137,80,78,71,13,10,26,10') throw new Error("The new scan was not a valid PNG image.");
    if (!current()) return {ok: false, discarded: true};
    candidateUrl = URL.createObjectURL(blob);
    const oldUrl = _psScanUrl;
    _psScanToken = candidateToken; _psScanBlob = blob; _psScanUrl = candidateUrl;
    accepted = true;
    const image = document.getElementById("ps-preview-img"); if (image) image.src = candidateUrl;
    document.getElementById("ps-preview-wrap").hidden = false;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    psSetStatus("ps-scan-status", `Scan ready to download — ${resolution} DPI · ${colorMode}. Nothing has been saved to your folders.`, "ok");
    if (previousToken && previousToken !== candidateToken) await psDeleteScanToken(previousToken);
    return {ok: true};
  } catch (error) {
    if (current()) psSetStatus("ps-scan-status", "Scan failed: " + error.message + (_psScanBlob ? " Your previous scan is unchanged and can still be downloaded." : " Retry when ready."), "error");
    return {ok: false, error: error.message};
  } finally {
    // A rejected candidate belongs to this request; never delete the retained scan.
    if (!accepted && candidateToken && candidateToken !== previousToken) await psDeleteScanToken(candidateToken);
    if (!accepted && candidateUrl) URL.revokeObjectURL(candidateUrl);
    _psScanBusy = false;
    controls.forEach(control => { control.disabled = false; });
    if (btn) { btn.disabled = false; btn.textContent = "Scan now"; }
  }
}

function psDownloadScan() {
  if (!_psScanBlob) return;
  const a = document.createElement("a");
  const url = URL.createObjectURL(_psScanBlob);
  a.href = url; a.download = `tli-scan-${Date.now()}.png`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function psDiscardScan() {
  const token = psClearScanPreview();
  psSetStatus("ps-scan-status", _psScanBusy ? "Preview discarded. The scanner may still be working on the host; its pending result will not replace this view." : "Scan preview discarded.", "");
  if (token) await psDeleteScanToken(token);
}
