/* TLI Builder — corrected vision frontend.
 * Hero composer → autoplay (explorer → planner → patch) → approve → finish.
 * Single source of UI truth: state.tasks rendered as cards in #builder-stream.
 * Bottom <details class="builder-advanced"> is the developer escape hatch
 * (manual find/replace, command runner, snapshot browser, receipts log).
 */
window.TLIBuilder = (function () {
  const AGENT_ORDER = ["explorer", "planner", "patch", "test", "reviewer", "receipt"];
  const INTENT_TARGET = { inspect: 1, plan: 2, build: 3 };
  const BACKEND_POLL_MS = 15000;

  const state = {
    statusLoaded: false,
    mode: "build",
    projectMap: null,
    selectedProject: "",
    permissionLevel: "ask",
    goldenGuard: true,
    backend: { backend: "checking", label: "Checking…", error: "" },
    tasks: [],
    receipts: [],
    snapshots: [],
    pendingAttachments: [],
    selectedTaskId: null,
    lastDiff: null,
    lastPlan: null,
    advancing: {},
    collapsed: new Set(),
    regenerateOpen: new Set(),
    followupOpen: new Set(),
    epoch: 0, locked: false, operation: null, mutations: new Set(), uploads: 0, drafts: new Map(),
  };

  // ---------------------------------------------------------------------------
  // utilities
  // ---------------------------------------------------------------------------

  function el(id) { return document.getElementById(id); }

  async function api(path, options) {
    if (state.locked) throw new Error('Unlock TLI before using Builder.');
    const epoch = state.epoch, mutation = options?.method && options.method !== 'GET' ? {} : null;
    if (mutation) state.mutations.add(mutation);
    try {
      const res = await fetch(path, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        ...(options || {}),
      });
      if (res.status === 401) clearPrivate();
      const data = await res.json().catch(() => ({}));
      if (epoch !== state.epoch || state.locked) throw new Error('The Builder workspace changed. This response was ignored.');
      if (!res.ok) throw new Error(data.detail || ("HTTP " + res.status));
      if (data.ok === false) throw new Error(data.detail || data.error || 'Builder did not complete the request.');
      return data;
    } finally { if (mutation) state.mutations.delete(mutation); }
  }

  const draftFields = ['builder-chat-input', 'builder-diff-file', 'builder-find-text', 'builder-replace-text',
    'builder-command-input', 'builder-command-cwd', 'builder-rollback-id'];
  function unavailable(projectChange = false) {
    return state.locked || !!state.operation || state.mutations.size > 0 || (projectChange && state.uploads > 0);
  }
  function beginOperation(kind) {
    if (unavailable(kind === 'project')) { toast('Wait for the current Builder request before starting another or changing projects.', 'warning'); return null; }
    const token = {kind, epoch:state.epoch}; state.operation = token; return token;
  }
  function endOperation(token) { if (state.operation === token) state.operation = null; }
  function rememberProjectDraft() {
    state.drafts.set(state.selectedProject, {fields:Object.fromEntries(draftFields.map(id => [id, el(id)?.value || ''])),
      attachments:state.pendingAttachments.slice(), replaceAll:!!el('builder-replace-all')?.checked});
  }
  function changeProject(project) {
    if (project === state.selectedProject) return;
    const previous = state.selectedProject;
    rememberProjectDraft(); state.epoch++; state.selectedProject = project;
    const draft = state.drafts.get(project) || (!previous ? state.drafts.get('') : null);
    for (const id of draftFields) if (el(id)) el(id).value = draft?.fields[id] || '';
    state.pendingAttachments = draft?.attachments.slice() || [];
    if (el('builder-replace-all')) el('builder-replace-all').checked = draft?.replaceAll || false;
    for (const id of ['builder-apply-approved', 'builder-rollback-approved', 'builder-command-approved']) if (el(id)) el(id).checked = false;
    state.lastDiff = null; state.lastPlan = null; state.selectedTaskId = null;
    state.tasks = []; state.receipts = []; state.snapshots = [];
    renderStream(); renderReceipts([]); renderSnapshots([]);
    for (const id of ['builder-diff-output', 'builder-before-output', 'builder-after-output', 'builder-apply-output', 'builder-plan-output', 'builder-command-output', 'builder-rollback-output']) setHtml(id, '');
    setHtml('builder-diff-output', 'Generate a fresh diff for this project before approving changes.');
    if (el('builder-copy-diff-btn')) el('builder-copy-diff-btn').disabled = true;
    updateApplyButton(); renderAttachmentTray();
    if (draft && previous) toast('Unfinished project draft restored. Review a fresh diff before approving changes.');
  }
  function clearPrivate() {
    state.locked = true; state.epoch++; state.statusLoaded = false; state.operation = null;
    state.selectedProject = ''; state.projectMap = null; state.tasks = []; state.receipts = []; state.snapshots = [];
    state.pendingAttachments = []; state.lastDiff = null; state.lastPlan = null; state.selectedTaskId = null;
    state.advancing = {}; state.drafts.clear(); state.collapsed.clear(); state.regenerateOpen.clear(); state.followupOpen.clear();
    if (backendPollTimer) clearInterval(backendPollTimer); backendPollTimer = null;
    for (const field of document.querySelectorAll('#panel-builder input, #panel-builder textarea')) { field.value = ''; if (field.type === 'checkbox') field.checked = false; }
    for (const id of [...draftFields, 'builder-chat-project-path', 'builder-project-path', 'builder-new-parent', 'builder-new-name']) if (el(id)) el(id).value = '';
    for (const id of ['builder-apply-approved', 'builder-rollback-approved', 'builder-command-approved']) if (el(id)) el(id).checked = false;
    for (const id of ['builder-stream', 'builder-stream-count', 'builder-attachment-tray', 'builder-project-summary-mini', 'builder-project-summary', 'builder-project-map', 'builder-risk-files', 'builder-analysis-output', 'builder-relevant-files', 'builder-diff-output', 'builder-before-output', 'builder-after-output', 'builder-apply-output', 'builder-plan-output', 'builder-command-output', 'builder-rollback-output', 'builder-receipts', 'builder-snapshots', 'builder-file-options', 'builder-task-detail', 'builder-task-list', 'builder-task-output']) if (el(id)) el(id).textContent = '';
    if (el('builder-project-name')) el('builder-project-name').textContent = 'Unlock TLI';
    if (el('builder-readiness')) el('builder-readiness').textContent = 'Unlock TLI to open Builder. Unsaved drafts were cleared.';
    updateApplyButton();
  }
  function consumeSubmitted(raw, attachments) {
    const input = el('builder-chat-input'); if (input?.value === raw) input.value = '';
    const ids = new Set(attachments.map(item => item.id));
    state.pendingAttachments = state.pendingAttachments.filter(item => !ids.has(item.id));
    renderAttachmentTray();
  }

  async function uploadAttachments(files) {
    if (state.locked) throw new Error('Unlock TLI before attaching files.');
    const epoch = state.epoch;
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const res = await fetch("/api/builder/attachments", {
      method: "POST",
      cache: "no-store",
      body: form,
    });
    if (res.status === 401) clearPrivate();
    const data = await res.json().catch(() => ({}));
    if (epoch !== state.epoch || state.locked) throw new Error('The Builder workspace changed. Uploaded results were not added.');
    if (!res.ok) throw new Error(data.detail || ("HTTP " + res.status));
    if (!Array.isArray(data.attachments) || data.attachments.some(item => !item || typeof item.id !== 'string')) throw new Error('Builder did not confirm the uploaded attachments.');
    return data.attachments;
  }

  function toast(msg, type) {
    if (state.locked) return;
    if (typeof showToast === "function") showToast(msg, type || "success");
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function setBusy(id, busy, text) {
    const node = el(id);
    if (!node) return;
    node.disabled = !!busy || state.locked;
    if (text != null) node.textContent = text;
  }

  function setHtml(id, html) {
    if (state.locked) return;
    const node = el(id);
    if (node) node.innerHTML = html;
  }

  function renderError(id, message) {
    if (state.locked) return;
    const node = el(id);
    if (!node) return;
    node.textContent = "";
    const err = document.createElement("div");
    err.className = "builder-error";
    err.textContent = message;
    node.appendChild(err);
  }

  function projectShortName(path) {
    if (!path) return "No project";
    const norm = String(path).replace(/[\\/]+$/, "");
    const parts = norm.split(/[\\/]/);
    return parts[parts.length - 1] || norm;
  }

  function relativeAge(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds} sec ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function upsertTask(list, task) {
    if (!task || !task.id) return list;
    const idx = list.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      const next = list.slice();
      next[idx] = task;
      return next;
    }
    return list.concat([task]);
  }

  function normalizeMode(mode) {
    return INTENT_TARGET[mode] != null ? mode : "build";
  }

  function targetIndexForIntent(intent) {
    return INTENT_TARGET[normalizeMode(intent)];
  }

  function modeLabel(mode) {
    return ({ build: "Build", plan: "Plan", inspect: "Inspect" })[normalizeMode(mode)];
  }

  function setMode(mode) {
    state.mode = normalizeMode(mode);
    renderModeControls();
    renderReadiness();
  }

  function renderModeControls() {
    document.querySelectorAll("[data-builder-mode]").forEach(btn => {
      const active = btn.getAttribute("data-builder-mode") === state.mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function renderReadiness() {
    const host = el("builder-readiness");
    if (!host) return;
    if (state.locked) { host.textContent = 'Unlock TLI to open Builder. Unsaved drafts were cleared.'; return; }
    const backend = state.backend || {};
    const mode = normalizeMode(state.mode);
    const parts = [];
    if (!state.selectedProject) {
      parts.push("Open a repo to start the local code-agent loop.");
    } else {
      parts.push(`${modeLabel(mode)} mode is ready for ${projectShortName(state.selectedProject)}.`);
    }
    if (backend.backend === "offline") {
      parts.push(mode === "build"
        ? "AI offline: Inspect and Plan still work; Build will pause before a diff until a local model is available."
        : "AI offline: this mode uses the deterministic project engine.");
    }
    host.textContent = parts.join(" ");
    host.dataset.state = backend.backend === "offline" ? "warn" : "ready";
  }

  // ---------------------------------------------------------------------------
  // backend pill
  // ---------------------------------------------------------------------------

  async function backendPillRefresh() {
    if (state.locked) return;
    const epoch = state.epoch;
    const pill = el("builder-backend-pill");
    if (pill) pill.dataset.busy = "true";
    try {
      const data = await api("/api/builder/backend-status");
      state.backend = data;
      applyBackendPill(data);
      renderReadiness();
    } catch (err) {
      if (epoch !== state.epoch || state.locked) return;
      state.backend = { backend: "offline", label: "AI offline", error: err.message };
      applyBackendPill(state.backend);
      renderReadiness();
    } finally {
      if (pill) pill.dataset.busy = "false";
    }
  }

  function applyBackendPill(data) {
    const pill = el("builder-backend-pill");
    const label = el("builder-backend-label");
    if (!pill || !label) return;
    pill.dataset.state = data.backend || "checking";
    label.textContent = data.label || "Unknown";
    pill.title = (data.error
      ? `${data.label || "Backend"} — ${data.error}`
      : `Local AI backend: ${data.label || "Unknown"}`) + " (click to refresh)";
  }

  async function warmBackend() {
    try {
      await api("/api/builder/warm-backend", { method: "POST" });
    } catch (_) { /* ignore */ }
    // Quick follow-up probes so the pill goes green as soon as the runtime is up
    setTimeout(backendPillRefresh, 1500);
    setTimeout(backendPillRefresh, 4000);
    setTimeout(backendPillRefresh, 9000);
  }

  // ---------------------------------------------------------------------------
  // project picker
  // ---------------------------------------------------------------------------

  function openProjectMenu(open) {
    const menu = el("builder-project-menu");
    const btn = el("builder-project-btn");
    if (!menu || !btn) return;
    const willOpen = open == null ? menu.hasAttribute("hidden") : !!open;
    if (willOpen) menu.removeAttribute("hidden");
    else menu.setAttribute("hidden", "");
    btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function applyProjectLabel() {
    const node = el("builder-project-name");
    if (node) node.textContent = projectShortName(state.selectedProject);
  }

  function renderProjectMenuSummary(map) {
    const host = el("builder-project-summary-mini");
    if (!host) return;
    host.textContent = "";
    if (!map) return;
    const rows = [
      ["Files", String(map.file_count || 0)],
      ["Stack", (map.frameworks || []).slice(0, 3).join(", ") || "—"],
      ["Languages", Object.keys(map.languages || {}).slice(0, 4).join(", ") || "—"],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      const lab = document.createElement("span");
      lab.className = "label";
      lab.textContent = label + ":";
      row.appendChild(lab);
      row.appendChild(document.createTextNode(" " + value));
      host.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // status + project loading
  // ---------------------------------------------------------------------------

  async function loadStatus() {
    if (unavailable()) return;
    try {
      const status = await api("/api/builder/status");
      if (state.operation) return;
      state.statusLoaded = true;
      changeProject(status.selected_project || "");
      state.permissionLevel = status.permission_level || "ask";
      state.goldenGuard = !!status.golden_build_guard;
      applyProjectLabel();
      const pathInput = el("builder-chat-project-path");
      if (pathInput && state.selectedProject && !pathInput.value) {
        pathInput.value = state.selectedProject;
      }
      const projectPathLegacy = el("builder-project-path");
      if (projectPathLegacy && state.selectedProject && !projectPathLegacy.value) {
        projectPathLegacy.value = state.selectedProject;
      }
      const perm = el("builder-permission");
      if (perm && state.permissionLevel) perm.value = state.permissionLevel;
      const golden = el("builder-golden");
      if (golden) golden.checked = state.goldenGuard;
      if (state.selectedProject) await loadProjectMap(false);
      await Promise.all([loadTasks(), loadReceipts(), loadSnapshots()]);
      renderReadiness();
    } catch (err) {
      toast("Builder status load failed: " + err.message, "warning");
      renderReadiness();
    }
  }

  async function scanProject() {
    if (unavailable(true)) { toast('Wait for the current Builder request before opening another project.', 'warning'); return false; }
    const path = (el("builder-chat-project-path")?.value
              || el("builder-project-path")?.value
              || "").trim();
    if (!path) { toast("Enter a project folder path first.", "warning"); return; }
    const operation = beginOperation('project'); if (!operation) return false;
    setBusy("builder-chat-scan-btn", true, "Opening…");
    try {
      const data = await api("/api/builder/select-project", {
        method: "POST",
        body: JSON.stringify({
          path,
          permission_level: el("builder-permission")?.value || state.permissionLevel,
          golden_build_guard: el("builder-golden")?.checked == null
            ? state.goldenGuard
            : !!el("builder-golden").checked,
        }),
      });
      if (!data.project_map || typeof data.project_map.root !== 'string') throw new Error('Builder did not confirm the selected project.');
      changeProject(data.project_map.root);
      state.projectMap = data.project_map;
      applyProjectLabel();
      renderProjectMenuSummary(data.project_map);
      if (el("builder-project-path")) el("builder-project-path").value = state.selectedProject;
      if (el("builder-chat-project-path")) el("builder-chat-project-path").value = state.selectedProject;
      renderProjectMap(data.project_map);
      await Promise.all([loadTasks(), loadReceipts(), loadSnapshots()]);
      openProjectMenu(false);
      renderReadiness();
      toast("Project opened.");
      return true;
    } catch (err) {
      toast("Open failed: " + err.message, "warning");
      return false;
    } finally {
      setBusy("builder-chat-scan-btn", false, "Open");
      endOperation(operation);
    }
  }

  async function loadProjectMap(refresh) {
    try {
      const data = await api("/api/builder/project-map?refresh=" + (refresh ? "true" : "false"));
      state.projectMap = data.project_map;
      renderProjectMenuSummary(data.project_map);
      renderProjectMap(data.project_map);
      if (refresh) toast("Project map refreshed.");
    } catch (err) {
      if (refresh) toast("Refresh failed: " + err.message, "warning");
    }
  }

  async function createNewProject() {
    if (unavailable(true)) { toast('Wait for the current Builder request before creating a project.', 'warning'); return; }
    const parent = (el("builder-new-parent")?.value || "").trim();
    const name = (el("builder-new-name")?.value || "").trim();
    const template = el("builder-new-template")?.value || "blank";
    if (!parent || !name) { toast("Enter a parent folder and project name.", "warning"); return; }
    const operation = beginOperation('project'); if (!operation) return;
    setBusy("builder-create-project-btn", true, "Creating…");
    try {
      const data = await api("/api/builder/create-project", {
        method: "POST",
        body: JSON.stringify({
          parent_path: parent,
          name,
          template,
          create_parent: !!el("builder-new-create-parent")?.checked,
          open_after: true,
          permission_level: el("builder-permission")?.value || "ask",
          golden_build_guard: el("builder-golden")?.checked == null ? true : !!el("builder-golden").checked,
        }),
      });
      const root = data.project_map?.root || data.created?.root;
      if (typeof root !== 'string' || !root) throw new Error('Builder did not confirm the new project.');
      changeProject(root); state.projectMap = data.project_map;
      applyProjectLabel();
      renderProjectMenuSummary(data.project_map);
      renderProjectMap(data.project_map);
      await Promise.all([loadTasks(), loadReceipts(), loadSnapshots()]);
      openProjectMenu(false);
      renderReadiness();
      toast(`Created ${data.created?.project_name || name}.`);
    } catch (err) {
      toast("Project create failed: " + err.message, "warning");
    } finally {
      setBusy("builder-create-project-btn", false, "Create and open");
      endOperation(operation);
    }
  }

  async function handleAttachmentFiles(fileList) {
    if (state.locked || state.operation?.kind === 'project') return;
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    state.uploads++;
    const dropzone = el("builder-attach-dropzone");
    if (dropzone) dropzone.dataset.active = "true";
    try {
      const attachments = await uploadAttachments(files);
      state.pendingAttachments = state.pendingAttachments.concat(attachments);
      renderAttachmentTray();
      toast(`Attached ${attachments.length} file${attachments.length === 1 ? "" : "s"}.`);
    } catch (err) {
      toast("Attachment failed: " + err.message, "warning");
    } finally {
      state.uploads--;
      if (dropzone) dropzone.dataset.active = "false";
      const input = el("builder-attach-input");
      if (input) input.value = "";
    }
  }

  function removePendingAttachment(id) {
    state.pendingAttachments = state.pendingAttachments.filter(item => item.id !== id);
    renderAttachmentTray();
  }

  function renderAttachmentTray() {
    const tray = el("builder-attachment-tray");
    if (!tray) return;
    tray.textContent = "";
    for (const item of state.pendingAttachments) {
      tray.appendChild(renderAttachmentChip(item, true));
    }
  }

  function renderAttachmentChip(item, removable) {
    const chip = document.createElement("span");
    chip.className = "builder-attachment-chip";
    chip.title = `${item.name || "attachment"} (${formatBytes(item.size || 0)})`;
    const name = document.createElement("span");
    name.className = "builder-attachment-chip-name";
    name.textContent = item.name || "attachment";
    chip.appendChild(name);
    const size = document.createElement("span");
    size.textContent = formatBytes(item.size || 0);
    chip.appendChild(size);
    if (removable) {
      const x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", "Remove attachment");
      x.textContent = "x";
      x.addEventListener("click", () => removePendingAttachment(item.id));
      chip.appendChild(x);
    }
    return chip;
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  }

  // ---------------------------------------------------------------------------
  // tasks + stream
  // ---------------------------------------------------------------------------

  async function loadTasks() {
    const epoch = state.epoch, operation = state.operation;
    try {
      const data = await api("/api/builder/tasks?limit=50");
      if (epoch !== state.epoch || operation !== state.operation) return;
      state.tasks = data.tasks || [];
      renderStream();
    } catch (err) {
      // Keep the last completed view on a failed refresh; a lock clears it explicitly.
    }
  }

  function deriveStatus(task) {
    if (!task) return "unknown";
    if (task.kind === "chat") return "chat";
    if (task.status === "cancelled") return "cancelled";
    if (task.status === "blocked")   return "blocked";
    const proposal = task.artifacts && task.artifacts.patch_proposal;
    if (state.advancing[task.id])    return "running";
    if (task.status === "running")   return "running";
    if (proposal && proposal.applied) return "applied";
    if (proposal && task.next_agent_index >= 3) return "awaiting";
    if (task.status === "completed") {
      return proposal ? "applied" : "completed";
    }
    return "queued";
  }

  function statusLabel(status) {
    return {
      running: "Working",
      awaiting: "Waiting on you",
      applied: "Done",
      completed: "Done",
      blocked: "Stuck",
      cancelled: "Cancelled",
      queued: "Ready",
      chat: "Chat",
      unknown: "—",
    }[status] || status;
  }

  async function sendChat() {
    if (unavailable()) return;
    const raw = el("builder-chat-input")?.value || '', text = raw.trim();
    if (!text) { toast("Type a message first.", "warning"); return; }
    const operation = beginOperation('submit'); if (!operation) return;
    setBusy("builder-chat-send-btn", true, "Asking…");
    setBusy("builder-start-btn", true, "Start paused");
    try {
      const attachments = state.pendingAttachments.slice();
      const data = await api("/api/builder/chat", {
        method: "POST",
        body: JSON.stringify({ message: text, attachments }),
      });
      if (!data.message || typeof data.message.id !== 'string') throw new Error('Builder did not confirm the saved reply. Your draft is retained.');
      state.tasks = upsertTask(state.tasks, data.message);
      if (data.message.backend === 'offline') {
        renderStream(); toast('AI was unavailable. Your message and attachments are retained for explicit retry.', 'warning'); return;
      }
      consumeSubmitted(raw, attachments);
      renderStream();
      backendPillRefresh();
    } catch (err) {
      toast("Builder chat failed: " + err.message, "warning");
    } finally {
      setBusy("builder-chat-send-btn", false, "Ask");
      setBusy("builder-start-btn", false, "Start");
      endOperation(operation);
    }
  }

  function sendBuilderMessage() {
    return sendChat();
  }

  function startSelectedMode() {
    return startBuild(state.mode);
  }

  function startBuild(intent) {
    if (unavailable()) return;
    const mode = normalizeMode(intent);
    const targetIndex = targetIndexForIntent(mode);
    const raw = el("builder-chat-input")?.value || '', text = raw.trim();
    if (!text) { toast("Describe what you want the agent to do first.", "warning"); return; }
    if (!state.selectedProject) {
      const pathInput = el("builder-chat-project-path");
      if (pathInput && pathInput.value.trim()) {
        const attachments = state.pendingAttachments.slice();
        return scanProject().then(opened => opened && !state.locked && startBuildInner(text, targetIndex, mode, raw, attachments));
      }
      toast("Open a project first.", "warning");
      openProjectMenu(true);
      return;
    }
    return startBuildInner(text, targetIndex, mode, raw);
  }

  async function startBuildInner(text, targetIndex, intent, raw = el('builder-chat-input')?.value || '', submittedAttachments = null) {
    const operation = beginOperation('submit'); if (!operation) return;
    const mode = normalizeMode(intent);
    setBusy("builder-start-btn", true, "Working...");
    setBusy("builder-chat-send-btn", true, "Ask paused");
    try {
      const attachments = submittedAttachments || state.pendingAttachments.slice();
      const data = await api("/api/builder/tasks", {
        method: "POST",
        body: JSON.stringify({ task: text, intent: mode, attachments }),
      });
      const task = data.task;
      if (!task || typeof task.id !== 'string') throw new Error('Builder did not confirm the task. Your draft is retained.');
      task._intent = mode;
      state.tasks = upsertTask(state.tasks, task);
      consumeSubmitted(raw, attachments);
      renderStream();
      backendPillRefresh();
      await autoplayToTarget(task.id, targetIndex);
      backendPillRefresh();
    } catch (err) {
      toast("Agent task failed to start: " + err.message, "warning");
    } finally {
      setBusy("builder-start-btn", false, "Start");
      setBusy("builder-chat-send-btn", false, "Ask");
      endOperation(operation);
    }
  }

  async function autoplayToTarget(taskId, targetIndex) {
    const epoch = state.epoch;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (state.locked || epoch !== state.epoch) return;
      const t = state.tasks.find(x => x.id === taskId);
      if (!t) return;
      if (t.next_agent_index >= targetIndex) return;
      if (["completed", "cancelled", "blocked"].includes(t.status)) return;
      state.advancing[taskId] = AGENT_ORDER[t.next_agent_index] || "step";
      renderStream();
      let task;
      try {
        const data = await api(`/api/builder/tasks/${encodeURIComponent(taskId)}/advance`, {
          method: "POST",
          body: JSON.stringify({ approve_test_command: false, allow_network: false }),
        });
        task = data.task;
        state.tasks = upsertTask(state.tasks, task);
      } catch (err) {
        toast("Agent step failed: " + err.message, "warning");
        delete state.advancing[taskId];
        renderStream();
        return;
      }
      delete state.advancing[taskId];
      renderStream();
      if (!task || ["completed", "cancelled", "blocked"].includes(task.status)) return;
      if (task.next_agent_index >= targetIndex) return;
      await sleep(60);
    }
  }

  async function approveTask(taskId) {
    if (unavailable()) return;
    const task = state.tasks.find(x => x.id === taskId);
    const proposal = task && task.artifacts && task.artifacts.patch_proposal;
    if (!proposal || !proposal.id) { toast("No diff to approve.", "warning"); return; }
    state.advancing[taskId] = "apply";
    renderStream();
    try {
      const data = await api("/api/builder/apply-patch", {
        method: "POST",
        body: JSON.stringify({ patch_id: proposal.id, task_id: taskId, approved: true }),
      });
      if (data.task) state.tasks = upsertTask(state.tasks, data.task);
      toast("Patch applied. Snapshot saved.");
    } catch (err) {
      toast("Apply failed: " + err.message, "warning");
      delete state.advancing[taskId];
      renderStream();
      return;
    }
    delete state.advancing[taskId];
    // Refresh task to pick up applied=true on the proposal artifact
    await refreshTask(taskId);
    // Continue agents through test → reviewer → receipt
    await autoplayToTarget(taskId, AGENT_ORDER.length);
    await loadSnapshots();
    backendPillRefresh();
  }

  async function refreshTask(taskId) {
    try {
      const data = await api("/api/builder/tasks?limit=50");
      state.tasks = data.tasks || [];
    } catch (_) { /* ignore */ }
    renderStream();
  }

  async function discardTask(taskId) {
    if (unavailable()) return;
    try {
      const data = await api(`/api/builder/tasks/${encodeURIComponent(taskId)}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "cancelled" }),
      });
      state.tasks = upsertTask(state.tasks, data.task);
      renderStream();
      toast("Build discarded.");
    } catch (err) {
      toast("Discard failed: " + err.message, "warning");
    }
  }

  function toggleRegenerate(taskId) {
    if (state.regenerateOpen.has(taskId)) state.regenerateOpen.delete(taskId);
    else state.regenerateOpen.add(taskId);
    renderStream();
    if (state.regenerateOpen.has(taskId)) {
      const input = document.getElementById(`builder-regen-input-${taskId}`);
      if (input) input.focus();
    }
  }

  async function regenerateTask(taskId, intent) {
    if (unavailable()) return;
    const input = document.getElementById(`builder-regen-input-${taskId}`);
    const text = (input?.value || "").trim();
    if (!text) { toast("Describe the regeneration first.", "warning"); return; }
    state.regenerateOpen.delete(taskId);
    try { await discardTask(taskId); } catch (_) {}
    const inputMain = el("builder-chat-input");
    if (inputMain) inputMain.value = text;
    const mode = normalizeMode(intent);
    await startBuildInner(text, targetIndexForIntent(mode), mode);
  }

  function toggleFollowup(parentId) {
    if (state.followupOpen.has(parentId)) state.followupOpen.delete(parentId);
    else state.followupOpen.add(parentId);
    renderStream();
    if (state.followupOpen.has(parentId)) {
      const input = document.getElementById(`builder-followup-input-${parentId}`);
      if (input) input.focus();
    }
  }

  async function submitFollowup(parentId, intent) {
    if (unavailable()) return;
    const input = document.getElementById(`builder-followup-input-${parentId}`);
    const text = (input?.value || "").trim();
    if (!text) { toast("Describe the follow-up first.", "warning"); return; }
    state.followupOpen.delete(parentId);
    const mode = normalizeMode(intent);
    const targetIndex = targetIndexForIntent(mode);
    try {
      const data = await api("/api/builder/tasks", {
        method: "POST",
        body: JSON.stringify({ task: text, intent: mode, parent_id: parentId }),
      });
      const task = data.task;
      task._intent = mode;
      state.tasks = upsertTask(state.tasks, task);
      renderStream();
      backendPillRefresh();
      await autoplayToTarget(task.id, targetIndex);
      backendPillRefresh();
    } catch (err) {
      toast("Follow-up failed: " + err.message, "warning");
    }
  }

  async function turnChatIntoBuild(chatId) {
    if (unavailable()) return;
    const input = document.getElementById(`builder-followup-input-${chatId}`);
    const text = (input?.value || "").trim();
    if (!text) { toast("Describe what to build from this chat.", "warning"); return; }
    state.followupOpen.delete(chatId);
    try {
      const data = await api("/api/builder/tasks", {
        method: "POST",
        body: JSON.stringify({ task: text, intent: "build", parent_id: chatId }),
      });
      const task = data.task;
      task._intent = "build";
      state.tasks = upsertTask(state.tasks, task);
      renderStream();
      backendPillRefresh();
      await autoplayToTarget(task.id, 3);
      backendPillRefresh();
    } catch (err) {
      toast("Turn-into-build failed: " + err.message, "warning");
    }
  }

  async function rollbackPatch(snapshotId) {
    if (unavailable()) return;
    if (!snapshotId) return;
    if (!window.confirm("Roll back to snapshot " + snapshotId + "?")) return;
    try {
      await api("/api/builder/rollback", {
        method: "POST",
        body: JSON.stringify({ snapshot_id: snapshotId, approved: true }),
      });
      await Promise.all([loadTasks(), loadSnapshots()]);
      toast("Rollback complete.");
    } catch (err) {
      toast("Rollback failed: " + err.message, "warning");
    }
  }

  function toggleCollapsed(taskId) {
    if (state.collapsed.has(taskId)) state.collapsed.delete(taskId);
    else state.collapsed.add(taskId);
    renderStream();
  }

  // ---------------------------------------------------------------------------
  // stream renderers (DOM-based, no innerHTML for multiline content)
  // ---------------------------------------------------------------------------

  function renderStream() {
    if (state.locked) return;
    const host = el("builder-stream");
    if (!host) return;
    host.textContent = "";
    const tasks = (state.tasks || []).slice().sort((a, b) => {
      const ka = (a.updated_at || a.created_at || "");
      const kb = (b.updated_at || b.created_at || "");
      if (ka === kb) return (a.id || "").localeCompare(b.id || "");
      return kb.localeCompare(ka);
    });
    const visibleTasks = [];
    for (const task of tasks) {
      const status = deriveStatus(task);
      const isLatest = visibleTasks.length === 0;
      if (isLatest || !["blocked", "cancelled"].includes(status)) visibleTasks.push(task);
      if (visibleTasks.length >= 2) break;
    }
    const archivedCount = Math.max(0, tasks.length - visibleTasks.length);
    if (!state.autocollapsed) state.autocollapsed = new Set();
    for (const task of visibleTasks) {
      const status = deriveStatus(task);
      const terminal = status === "blocked" || status === "completed" || status === "cancelled" || status === "applied";
      if (terminal && !state.autocollapsed.has(task.id)) {
        state.autocollapsed.add(task.id);
        state.collapsed.add(task.id);
      }
    }
    const count = el("builder-stream-count");
    if (count) {
      count.textContent = tasks.length
        ? `${visibleTasks.length} shown${archivedCount ? ` · ${archivedCount} archived` : ""}`
        : "";
    }
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "builder-stream-empty";
      if (state.selectedProject) {
        empty.textContent = "Describe work above, then Start the local code-agent loop.";
      } else {
        const title = document.createElement("div");
        title.className = "builder-stream-empty-title";
        title.textContent = "Open a repo first.";
        const copy = document.createElement("div");
        copy.textContent = "Builder needs a project root before it can inspect, plan, or prepare code changes.";
        const button = makeButton("Open repo", "btn-primary", () => openProjectMenu(true));
        empty.appendChild(title);
        empty.appendChild(copy);
        empty.appendChild(button);
      }
      host.appendChild(empty);
      return;
    }
    for (const task of visibleTasks) host.appendChild(renderTaskCard(task));
    if (archivedCount) {
      const archive = document.createElement("div");
      archive.className = "builder-thread-archive";
      archive.textContent = `${archivedCount} older Builder item${archivedCount === 1 ? "" : "s"} hidden to keep the workspace focused.`;
      host.appendChild(archive);
    }
  }

  function renderTaskCard(task) {
    if (task.kind === "chat") return renderChatCard(task);
    const card = document.createElement("article");
    card.className = "builder-card";
    const status = deriveStatus(task);
    card.dataset.status = status;
    card.dataset.taskId = task.id;
    const collapsed = state.collapsed.has(task.id);
    card.dataset.collapsed = collapsed ? "true" : "false";

    card.appendChild(renderCardHead(task, status));
    if (!collapsed) {
      card.appendChild(renderCardBody(task, status));
      const actions = renderCardActions(task, status);
      if (actions) card.appendChild(actions);
    }
    return card;
  }

  function renderChatCard(item) {
    const card = document.createElement("article");
    card.className = "builder-card builder-chat-card";
    card.dataset.status = "chat";
    card.dataset.taskId = item.id;

    const head = document.createElement("header");
    head.className = "builder-card-head";
    const chip = document.createElement("span");
    chip.className = "builder-status-chip";
    const dot = document.createElement("span");
    dot.className = "builder-status-dot";
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode("Chat"));
    head.appendChild(chip);
    const title = document.createElement("div");
    title.className = "builder-card-title";
    const prompt = document.createElement("div");
    prompt.className = "builder-card-task";
    prompt.textContent = item.task || "Message";
    const meta = document.createElement("div");
    meta.className = "builder-card-meta";
    const metaParts = [item.backend ? `local model: ${item.backend}` : "local model"];
    if (item.updated_at || item.created_at) metaParts.push(relativeAge(item.updated_at || item.created_at));
    meta.textContent = metaParts.join(" · ");
    title.appendChild(prompt);
    title.appendChild(meta);
    head.appendChild(title);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "builder-card-body";
    if (Array.isArray(item.attachments) && item.attachments.length) {
      const box = document.createElement("div");
      box.className = "builder-card-attachments";
      for (const att of item.attachments) box.appendChild(renderAttachmentChip(att, false));
      body.appendChild(box);
    }
    const answer = document.createElement("div");
    answer.className = "builder-chat-answer";
    answer.textContent = item.response || "";
    body.appendChild(answer);
    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "builder-card-actions";
    actions.appendChild(makeButton("Turn this into a build", "btn-primary", () => toggleFollowup(item.id)));
    if (state.followupOpen.has(item.id)) {
      const followup = document.createElement("div");
      followup.className = "builder-regenerate";
      followup.dataset.open = "true";
      const ta = document.createElement("textarea");
      ta.id = `builder-followup-input-${item.id}`;
      ta.className = "builder-regenerate-input";
      ta.placeholder = "Describe the change you want Builder to make (carries this chat as context)";
      const row = document.createElement("div");
      row.className = "builder-regenerate-actions";
      row.appendChild(makeButton("Send", "btn-primary", () => turnChatIntoBuild(item.id)));
      row.appendChild(makeButton("Cancel", "btn-outline", () => toggleFollowup(item.id)));
      followup.appendChild(ta);
      followup.appendChild(row);
      actions.appendChild(followup);
    }
    card.appendChild(actions);
    return card;
  }

  function renderCardHead(task, status) {
    const head = document.createElement("header");
    head.className = "builder-card-head";

    const chip = document.createElement("span");
    chip.className = "builder-status-chip";
    const dot = document.createElement("span");
    dot.className = "builder-status-dot";
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(statusLabel(status)));
    head.appendChild(chip);

    const title = document.createElement("div");
    title.className = "builder-card-title";
    const taskLine = document.createElement("div");
    taskLine.className = "builder-card-task";
    taskLine.textContent = task.task || "(no task description)";
    const meta = document.createElement("div");
    meta.className = "builder-card-meta";
    const metaParts = [];
    metaParts.push(task.id);
    const ts = task.updated_at || task.created_at;
    if (ts) metaParts.push(relativeAge(ts));
    const activeAgent = state.advancing[task.id] || task.active_agent;
    if (status === "running" && activeAgent) metaParts.push(`${agentLabel(activeAgent)} running…`);
    else if (status === "awaiting") metaParts.push("ready for approval");
    meta.textContent = metaParts.join(" · ");
    title.appendChild(taskLine);
    title.appendChild(meta);
    head.appendChild(title);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "builder-card-toggle";
    toggle.textContent = state.collapsed.has(task.id) ? "▾ expand" : "▴ collapse";
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCollapsed(task.id);
    });
    head.appendChild(toggle);

    head.addEventListener("click", () => toggleCollapsed(task.id));
    return head;
  }

  function renderCardBody(task, status) {
    const body = document.createElement("div");
    body.className = "builder-card-body";

    body.appendChild(renderStepList(task));

    const artifacts = task.artifacts || {};
    if (artifacts.model_summary) {
      const summary = document.createElement("div");
      summary.className = "builder-card-summary";
      summary.textContent = artifacts.model_summary;
      body.appendChild(summary);
    }

    if (Array.isArray(artifacts.attachments) && artifacts.attachments.length) {
      const box = document.createElement("div");
      box.className = "builder-card-attachments";
      for (const item of artifacts.attachments) box.appendChild(renderAttachmentChip(item, false));
      body.appendChild(box);
    }

    if (artifacts.patch_proposal) body.appendChild(renderDiffBlock(artifacts.patch_proposal));
    const more = artifacts.patch_proposals;
    if (Array.isArray(more) && more.length > 1) {
      for (let i = 1; i < more.length; i++) body.appendChild(renderDiffBlock(more[i]));
    }

    if (status === "awaiting") {
      const note = document.createElement("div");
      note.className = "builder-card-note builder-card-note-warn";
      const detail = document.createElement("div");
      detail.className = "builder-card-note-message";
      detail.textContent = "Awaiting approval. TLI will snapshot before writing, then continue checks and summary.";
      note.appendChild(detail);
      body.appendChild(note);
    }

    const skipped = Array.isArray(artifacts.skipped_edits) ? artifacts.skipped_edits : [];
    const hasError = !!(artifacts.model_error || task.blocked_reason);
    if (hasError || skipped.length) {
      const note = document.createElement("div");
      note.className = hasError ? "builder-card-note builder-card-note-error" : "builder-card-note builder-card-note-warn";
      const detail = document.createElement("div");
      detail.className = "builder-card-note-message";
      if (hasError) {
        const msg = artifacts.model_error
          ? friendlyModelError(artifacts.model_error.message || "")
          : friendlyModelError(task.blocked_reason || "Unknown error");
        detail.textContent = msg;
      } else {
        detail.textContent = `Skipped ${skipped.length} edit${skipped.length === 1 ? "" : "s"}`;
      }
      note.appendChild(detail);
      if (skipped.length) {
        const list = document.createElement("ul");
        list.className = "builder-card-note-list";
        for (const item of skipped) {
          const li = document.createElement("li");
          li.textContent = `${item.file_path} — ${item.reason}`;
          list.appendChild(li);
        }
        note.appendChild(list);
      }
      if (artifacts.model_raw) {
        const raw = document.createElement("details");
        raw.className = "builder-card-note-raw";
        const sum = document.createElement("summary");
        sum.textContent = "raw model output";
        raw.appendChild(sum);
        const pre = document.createElement("pre");
        pre.textContent = artifacts.model_raw;
        raw.appendChild(pre);
        note.appendChild(raw);
      }
      body.appendChild(note);
    }

    return body;
  }

  function friendlyModelError(message) {
    const text = String(message || "");
    if (text.includes("exceeds the available context size") || text.includes("exceed_context_size")) {
      return "The local model's context window was too small for the selected files. Builder now retries with a smaller file window.";
    }
    if (text.includes("none could be validated")) {
      return "The model suggested an edit, but the exact text was not found in the chosen file. Regenerate with a more specific file or phrase.";
    }
    if (text.includes("not reachable") || text.includes("no model is loaded")) {
      return "No local model is reachable. Start the bundled model or LM Studio, then regenerate.";
    }
    return text.length > 220 ? text.slice(0, 220) + "..." : text;
  }

  function renderStepList(task) {
    const wrap = document.createElement("div");
    wrap.className = "builder-steps";
    const agents = Array.isArray(task.agents) ? task.agents : [];
    const completedAgents = new Map();
    for (const step of agents) completedAgents.set(step.agent, step);
    for (let i = 0; i < AGENT_ORDER.length; i++) {
      const agent = AGENT_ORDER[i];
      const row = document.createElement("div");
      row.className = "builder-step";
      const step = completedAgents.get(agent);
      let stateName = "pending";
      if (step) {
        stateName = step.status === "blocked" ? "blocked" : "complete";
      } else if (state.advancing[task.id] === agent) {
        stateName = "running";
      } else if (task.next_agent_index === i && !["completed", "cancelled"].includes(task.status)) {
        stateName = "next";
      }
      row.dataset.state = stateName;
      const mark = document.createElement("span");
      mark.className = "builder-step-mark";
      mark.textContent = ({
        complete: "✓",
        running: "◐",
        blocked: "✕",
        next: "○",
        pending: "○",
      })[stateName] || "·";
      const { label: labelText, detail: detailText } = agentIntent(agent, step, stateName, task);
      const labelWrap = document.createElement("div");
      const label = document.createElement("span");
      label.className = "builder-step-label";
      label.textContent = labelText;
      labelWrap.appendChild(label);
      if (detailText) {
        const detail = document.createElement("span");
        detail.className = "builder-step-detail";
        detail.textContent = "— " + detailText;
        labelWrap.appendChild(detail);
      }
      row.appendChild(mark);
      row.appendChild(labelWrap);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function agentLabel(agent) {
    return {
      explorer: "Inspecting repo",
      planner: "Planning change",
      patch: "Preparing diff",
      test: "Checking result",
      reviewer: "Reviewing changes",
      receipt: "Summary",
      apply: "Applying approved patch",
    }[agent] || agent;
  }

  function shortFile(path) {
    if (!path) return "";
    const norm = String(path).replace(/\\/g, "/");
    const parts = norm.split("/");
    return parts[parts.length - 1] || norm;
  }

  function agentIntent(agent, step, stateName, task) {
    // Build a concrete "action + object" line for a step.
    // Returns { label, detail } where label is the verb, detail is the object.
    const baseLabel = agentLabel(agent);
    if (!step) {
      if (stateName === "running") {
        return { label: baseLabel, detail: "thinking…" };
      }
      return { label: baseLabel, detail: "" };
    }
    const artifacts = step.artifacts || {};
    if (agent === "explorer" && step.status === "complete") {
      const files = artifacts.relevant_files || [];
      if (files.length) {
        const names = files.slice(0, 3).map(f => shortFile(f.path || f)).join(", ");
        const extra = files.length > 3 ? ` (+${files.length - 3} more)` : "";
        return { label: `Inspected ${files.length} file${files.length === 1 ? "" : "s"}`, detail: `${names}${extra}` };
      }
      return { label: "Inspected repo", detail: "no strong file match" };
    }
    if (agent === "planner" && step.status === "complete") {
      const plan = artifacts.plan || {};
      const risk = plan.risk || "";
      return { label: "Planned the change", detail: risk ? `risk: ${risk}` : "" };
    }
    if (agent === "patch") {
      if (step.status === "complete") {
        const proposal = artifacts.patch_proposal || {};
        const file = shortFile(proposal.file_path);
        if (file) return { label: "Prepared diff", detail: `in ${file}` };
        return { label: "Prepared diff", detail: "" };
      }
      if (step.status === "blocked") {
        return { label: "Could not prepare diff", detail: friendlyModelError(step.message || "") };
      }
    }
    if (agent === "test" && step.status === "complete") {
      const test = artifacts.test_result || {};
      if (test.status === "not_run") return { label: "Skipped checks", detail: "no test command" };
      if (typeof test.exit_code === "number") {
        return { label: "Ran the check", detail: `exit ${test.exit_code}${test.timed_out ? " (timed out)" : ""}` };
      }
      return { label: "Verified", detail: "" };
    }
    if (agent === "reviewer" && step.status === "complete") {
      const review = artifacts.review || {};
      const issues = review.issues || [];
      return { label: "Reviewed", detail: issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "no issues" };
    }
    if (agent === "receipt" && step.status === "complete") {
      return { label: "Wrapped up", detail: "" };
    }
    // Fall back to whatever the backend supplied.
    return { label: baseLabel, detail: step.message || "" };
  }

  function renderDiffBlock(proposal) {
    const wrap = document.createElement("div");
    wrap.className = "builder-diff";
    const head = document.createElement("div");
    head.className = "builder-diff-head";
    const fileBadge = document.createElement("span");
    fileBadge.className = "builder-diff-file";
    fileBadge.textContent = proposal.file_path || "diff";
    head.appendChild(fileBadge);
    const right = document.createElement("span");
    const parts = [];
    if (proposal.risk) parts.push("risk: " + proposal.risk);
    if (proposal.replace_all) parts.push("replace all");
    if (proposal.applied) parts.push("applied");
    right.textContent = parts.join(" · ");
    head.appendChild(right);
    wrap.appendChild(head);
    const body = document.createElement("div");
    body.className = "builder-diff-body";
    const diffText = proposal.diff || "";
    const lines = diffText.split(/\r?\n/);
    for (const raw of lines) {
      const ln = document.createElement("span");
      ln.className = "builder-diff-line";
      if (raw.startsWith("+++") || raw.startsWith("---")) ln.dataset.kind = "meta";
      else if (raw.startsWith("@@")) ln.dataset.kind = "hunk";
      else if (raw.startsWith("+")) ln.dataset.kind = "add";
      else if (raw.startsWith("-")) ln.dataset.kind = "del";
      else ln.dataset.kind = "ctx";
      ln.textContent = raw + "\n";
      body.appendChild(ln);
    }
    wrap.appendChild(body);
    return wrap;
  }

  function renderCardActions(task, status) {
    const wrap = document.createElement("div");
    wrap.className = "builder-card-actions";
    const intent = normalizeMode(task.intent || task._intent || "build");
    const proposal = task.artifacts && task.artifacts.patch_proposal;
    const buttons = [];

    if (status === "awaiting" && proposal && !proposal.applied) {
      buttons.push(makeButton("Approve & apply", "btn-primary", () => approveTask(task.id)));
      buttons.push(makeButton("Regenerate", "btn-outline", () => toggleRegenerate(task.id)));
      buttons.push(makeButton("Discard", "btn-outline", () => discardTask(task.id)));
    } else if (status === "applied" && proposal) {
      const snapId = proposal.snapshot_id || (task.artifacts && task.artifacts.last_snapshot_id);
      buttons.push(makeButton("Follow up", "btn-primary", () => toggleFollowup(task.id)));
      if (snapId) buttons.push(makeButton("Rollback", "btn-outline", () => rollbackPatch(snapId)));
    } else if (status === "blocked" || status === "cancelled") {
      buttons.push(makeButton("Follow up", "btn-primary", () => toggleFollowup(task.id)));
      buttons.push(makeButton("Regenerate", "btn-outline", () => toggleRegenerate(task.id)));
    } else if (status === "completed") {
      buttons.push(makeButton("Follow up", "btn-primary", () => toggleFollowup(task.id)));
      buttons.push(makeButton("Run again", "btn-outline", () => toggleRegenerate(task.id)));
    } else if (status === "running") {
      // No actions while a step is in flight
    } else if (status === "queued") {
      const target = Number(task.target_agent_index || targetIndexForIntent(intent));
      buttons.push(makeButton("Resume", "btn-primary", () => autoplayToTarget(task.id, target)));
      buttons.push(makeButton("Discard", "btn-outline", () => discardTask(task.id)));
    }

    const regenOpen = state.regenerateOpen.has(task.id);
    const followOpen = state.followupOpen.has(task.id);
    if (!buttons.length && !regenOpen && !followOpen) return null;
    for (const b of buttons) wrap.appendChild(b);

    if (regenOpen) {
      const regen = document.createElement("div");
      regen.className = "builder-regenerate";
      regen.dataset.open = "true";
      const ta = document.createElement("textarea");
      ta.id = `builder-regen-input-${task.id}`;
      ta.className = "builder-regenerate-input";
      ta.placeholder = "Tweak the request and try again…";
      ta.value = task.task || "";
      const actions = document.createElement("div");
      actions.className = "builder-regenerate-actions";
      actions.appendChild(makeButton("Send", "btn-primary", () => regenerateTask(task.id, intent)));
      actions.appendChild(makeButton("Cancel", "btn-outline", () => toggleRegenerate(task.id)));
      regen.appendChild(ta);
      regen.appendChild(actions);
      wrap.appendChild(regen);
    }

    if (followOpen) {
      const followup = document.createElement("div");
      followup.className = "builder-regenerate";
      followup.dataset.open = "true";
      const ta = document.createElement("textarea");
      ta.id = `builder-followup-input-${task.id}`;
      ta.className = "builder-regenerate-input";
      ta.placeholder = "What should Builder do next? (carries this thread's context)";
      const actions = document.createElement("div");
      actions.className = "builder-regenerate-actions";
      actions.appendChild(makeButton("Send", "btn-primary", () => submitFollowup(task.id, intent)));
      actions.appendChild(makeButton("Cancel", "btn-outline", () => toggleFollowup(task.id)));
      followup.appendChild(ta);
      followup.appendChild(actions);
      wrap.appendChild(followup);
    }

    return wrap;
  }

  function makeButton(text, klass, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = klass;
    b.textContent = text;
    b.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
    return b;
  }

  // ---------------------------------------------------------------------------
  // Power tools plus quarantined legacy workbench helpers. Only the Power tools
  // bindings are registered in setup().
  // ---------------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function analyze() {
    const task = (el("builder-chat-input")?.value || "").trim();
    if (!task) { toast("Ask Builder a question first.", "warning"); return; }
    setBusy("builder-analyze-btn", true, "Analyzing…");
    setHtml("builder-analysis-output", '<div class="builder-empty">Reading project map…</div>');
    try {
      const data = await api("/api/builder/analyze", {
        method: "POST",
        body: JSON.stringify({ task, limit: 12 }),
      });
      renderAnalysis(data.analysis);
      populateFileOptions(data.analysis.relevant_files || []);
      toast("Analysis complete.");
    } catch (err) {
      renderError("builder-analysis-output", err.message);
      toast("Analyze failed.", "warning");
    } finally {
      setBusy("builder-analyze-btn", false, "Analyze");
    }
  }

  async function createPlan() {
    const task = (el("builder-task")?.value || "").trim();
    if (!task) { toast("Ask Builder a task first.", "warning"); return; }
    setBusy("builder-plan-btn", true, "Planning…");
    setHtml("builder-plan-output", '<div class="builder-empty">Creating plan…</div>');
    try {
      const data = await api("/api/builder/plan", {
        method: "POST",
        body: JSON.stringify({ task, limit: 10 }),
      });
      state.lastPlan = data.plan;
      renderPlan(data.plan);
      populateFileOptions(data.plan.relevant_files || []);
      toast("Plan ready.");
    } catch (err) {
      renderError("builder-plan-output", err.message);
      toast("Plan failed.", "warning");
    } finally {
      setBusy("builder-plan-btn", false, "Create plan");
    }
  }

  async function generateDiff() {
    if (unavailable()) return;
    const filePath = (el("builder-diff-file")?.value || "").trim();
    const findText = el("builder-find-text")?.value || "";
    const replaceText = el("builder-replace-text")?.value || "";
    const task = (el("builder-chat-input")?.value || "").trim();
    if (!filePath || !findText) { toast("Choose a file and paste exact find text first.", "warning"); return; }
    const operation = beginOperation('preview'); if (!operation) return;
    setBusy("builder-generate-diff-btn", true, "Generating…");
    try {
      const data = await api("/api/builder/generate-diff", {
        method: "POST",
        body: JSON.stringify({
          task, file_path: filePath, find_text: findText, replace_text: replaceText,
          replace_all: !!el("builder-replace-all")?.checked,
        }),
      });
      if (!data.proposal || typeof data.proposal.id !== 'string' || typeof data.proposal.diff !== 'string') throw new Error('Builder did not confirm a readable diff.');
      state.lastDiff = data.proposal;
      if (el('builder-apply-approved')) el('builder-apply-approved').checked = false;
      renderDiff(data.proposal);
      toast("Diff preview generated.");
    } catch (err) {
      if (el('builder-apply-approved')) el('builder-apply-approved').checked = false;
      updateApplyButton();
      if (!state.lastDiff) renderError("builder-diff-output", err.message);
      toast('Diff preview failed: ' + err.message + (state.lastDiff ? ' The previous preview is retained; review it again before applying.' : ''), 'warning');
    } finally {
      setBusy("builder-generate-diff-btn", false, "Generate diff");
      endOperation(operation);
    }
  }

  async function copyDiff() {
    const diff = state.lastDiff?.diff || "";
    if (!diff) { toast("No diff to copy yet.", "warning"); return; }
    try {
      await navigator.clipboard.writeText(diff);
      toast("Patch copied.");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = diff;
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      toast("Patch copied.");
    }
  }

  async function applyPatch() {
    if (unavailable()) return;
    if (!state.lastDiff?.id) { toast("Generate a diff preview before applying.", "warning"); return; }
    if (!el("builder-apply-approved")?.checked) { toast("Confirm approval before applying.", "warning"); return; }
    setBusy("builder-apply-patch-btn", true, "Applying…");
    try {
      const data = await api("/api/builder/apply-patch", {
        method: "POST",
        body: JSON.stringify({ patch_id: state.lastDiff.id, approved: true }),
      });
      renderApplyResult(data.result);
      state.lastDiff.applied = true;
      await loadSnapshots();
      toast("Patch applied. Snapshot saved.");
    } catch (err) {
      renderError("builder-apply-output", err.message);
      toast("Apply failed.", "warning");
    } finally {
      setBusy("builder-apply-patch-btn", false, "Apply approved patch");
      updateApplyButton();
    }
  }

  async function loadSnapshots() {
    try {
      const data = await api("/api/builder/snapshots?limit=20");
      state.snapshots = data.snapshots || [];
      renderSnapshots(state.snapshots);
    } catch { renderSnapshots([]); }
  }

  async function rollbackSnapshot() {
    if (unavailable()) return;
    const snapshotId = (el("builder-rollback-id")?.value || "").trim();
    if (!snapshotId) { toast("Enter a snapshot ID first.", "warning"); return; }
    if (!el("builder-rollback-approved")?.checked) { toast("Confirm rollback approval first.", "warning"); return; }
    setBusy("builder-rollback-btn", true, "Rolling back…");
    try {
      const data = await api("/api/builder/rollback", {
        method: "POST",
        body: JSON.stringify({ snapshot_id: snapshotId, approved: true }),
      });
      const out = el("builder-rollback-output");
      if (out) {
        out.textContent = "";
        const head = document.createElement("div");
        head.textContent = "Rollback complete.";
        out.appendChild(head);
        const list = document.createElement("ul");
        for (const path of (data.result.files_restored || [])) {
          const li = document.createElement("li");
          li.textContent = path;
          list.appendChild(li);
        }
        out.appendChild(list);
      }
      await Promise.all([loadSnapshots(), loadTasks()]);
      toast("Rollback complete.");
    } catch (err) {
      renderError("builder-rollback-output", err.message);
      toast("Rollback failed.", "warning");
    } finally {
      setBusy("builder-rollback-btn", false, "Rollback snapshot");
    }
  }

  async function runCommand() {
    if (unavailable()) return;
    const command = (el("builder-command-input")?.value || "").trim();
    if (!command) { toast("Enter a command first.", "warning"); return; }
    if (!el("builder-command-approved")?.checked) { toast("Confirm command approval first.", "warning"); return; }
    setBusy("builder-run-command-btn", true, "Running…");
    setHtml("builder-command-output", "Running command…");
    try {
      const data = await api("/api/builder/run-command", {
        method: "POST",
        body: JSON.stringify({
          command,
          cwd: (el("builder-command-cwd")?.value || "").trim(),
          approved: true,
          allow_network: !!el("builder-command-network")?.checked,
          timeout_seconds: Number(el("builder-command-timeout")?.value || 120),
        }),
      });
      renderCommandResult(data.result);
      toast("Command exited with " + data.result.exit_code + ".");
    } catch (err) {
      renderError("builder-command-output", err.message);
      toast("Command blocked or failed.", "warning");
    } finally {
      setBusy("builder-run-command-btn", false, "Run command");
    }
  }

  async function createAgentTask() {
    const task = (el("builder-agent-task")?.value || "").trim();
    if (!task) { toast("Enter an agent task first.", "warning"); return; }
    setBusy("builder-create-task-btn", true, "Creating…");
    try {
      const data = await api("/api/builder/tasks", {
        method: "POST",
        body: JSON.stringify({
          task,
          file_path: (el("builder-agent-file")?.value || "").trim(),
          find_text: el("builder-agent-find")?.value || "",
          replace_text: el("builder-agent-replace")?.value || "",
          replace_all: !!el("builder-agent-replace-all")?.checked,
          test_command: (el("builder-agent-test")?.value || "").trim(),
        }),
      });
      state.selectedTaskId = data.task.id;
      state.tasks = upsertTask(state.tasks, data.task);
      renderStream();
      renderLegacyTaskList(state.tasks);
      renderTaskOutput(data.task);
      toast("Agent task created.");
    } catch (err) {
      renderError("builder-task-output", err.message);
      toast("Task create failed.", "warning");
    } finally {
      setBusy("builder-create-task-btn", false, "Create task");
      updateLegacyTaskButtons();
    }
  }

  async function advanceSelectedTask() {
    if (!state.selectedTaskId) { toast("Select or create a task first.", "warning"); return; }
    setBusy("builder-advance-task-btn", true, "Advancing…");
    try {
      const data = await api(`/api/builder/tasks/${encodeURIComponent(state.selectedTaskId)}/advance`, {
        method: "POST",
        body: JSON.stringify({
          approve_test_command: !!el("builder-task-test-approved")?.checked,
          allow_network: !!el("builder-task-network")?.checked,
        }),
      });
      state.tasks = upsertTask(state.tasks, data.task);
      renderStream();
      renderLegacyTaskList(state.tasks);
      renderTaskOutput(data.task);
      applyTaskArtifacts(data.task);
      toast("Agent step complete.");
    } catch (err) {
      renderError("builder-task-output", err.message);
      toast("Advance failed.", "warning");
    } finally {
      setBusy("builder-advance-task-btn", false, "Advance next agent");
      updateLegacyTaskButtons();
    }
  }

  async function updateSelectedTaskStatus(status) {
    if (!state.selectedTaskId) return;
    try {
      const data = await api(`/api/builder/tasks/${encodeURIComponent(state.selectedTaskId)}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      state.tasks = upsertTask(state.tasks, data.task);
      renderStream();
      renderLegacyTaskList(state.tasks);
      renderTaskOutput(data.task);
      toast("Task " + status + ".");
    } catch (err) {
      renderError("builder-task-output", err.message);
      toast("Task update failed.", "warning");
    }
  }

  async function loadReceipts() {
    try {
      const data = await api("/api/builder/receipts?limit=20");
      state.receipts = data.receipts || [];
      renderReceipts(state.receipts);
    } catch { renderReceipts([]); }
  }

  function renderProjectMap(map) {
    if (!map) return;
    const languages = map.languages || {};
    const frameworks = map.frameworks || [];
    const features = map.detected_features || [];
    const risk = map.risk_files || [];

    setHtml("builder-project-summary", `
      ${stat("Project", map.project_name || "Unknown")}
      ${stat("Files", map.file_count || 0)}
      ${stat("Languages", Object.keys(languages).slice(0, 4).join(", ") || "None")}
      ${stat("Stack", frameworks.slice(0, 3).join(", ") || "Unknown")}
    `);

    setHtml("builder-risk-files", risk.length
      ? risk.slice(0, 24).map(p => fileItem(p, "Protected or sensitive-looking path")).join("")
      : '<div class="builder-empty">No protected paths detected.</div>');

    const mapItems = [
      ["Root", map.root],
      ["Entry points", (map.entry_points || []).join(", ") || "None detected"],
      ["Features", features.join(", ") || "None detected"],
      ["Package files", (map.package_files || []).join(", ") || "None detected"],
      ["Routes", (map.backend_routes || []).slice(0, 8).map(r => `${r.method} ${r.path}`).join(", ") || "None"],
      ["Ignored dirs", (map.ignored_dirs || []).join(", ") || "None"],
    ];
    setHtml("builder-project-map", mapItems.map(([label, value]) => `
      <div class="builder-map-item">
        <div class="builder-map-label">${escapeHtml(label)}</div>
        <div class="builder-map-value">${escapeHtml(value)}</div>
      </div>
    `).join(""));
    populateFileOptions([]);
  }

  function renderAnalysis(analysis) {
    setHtml("builder-analysis-output", escapeHtml(analysis.answer || "No analysis returned.").replace(/\n/g, "<br>"));
    const files = analysis.relevant_files || [];
    setHtml("builder-relevant-files", files.length
      ? files.map(item => fileItem(item.path, [
          item.language || "file",
          item.score ? "score " + item.score : "",
          item.summary || "",
        ].filter(Boolean).join(" — "))).join("")
      : '<div class="builder-empty">No relevant files found.</div>');
  }

  function renderPlan(plan) {
    const strategy = (plan.change_strategy || []).map(step => "- " + step).join("\n");
    const tests = (plan.test_plan || []).map(step => "- " + step).join("\n");
    const text = [
      plan.summary || "Plan ready.",
      "",
      "Risk: " + (plan.risk || "unknown"),
      "",
      "Files:",
      ...(plan.files_involved || []).map(p => "- " + p),
      "",
      "Strategy:",
      strategy,
      "",
      "Test plan:",
      tests,
      "",
      plan.permission_note || "",
    ].join("\n");
    setHtml("builder-plan-output", escapeHtml(text).replace(/\n/g, "<br>"));
  }

  function renderDiff(proposal) {
    setHtml("builder-diff-output", escapeHtml(proposal.diff || "No diff generated.").replace(/\n/g, "<br>"));
    setHtml("builder-before-output", escapeHtml(proposal.before_excerpt || "No before excerpt.").replace(/\n/g, "<br>"));
    setHtml("builder-after-output", escapeHtml(proposal.after_excerpt || "No after excerpt.").replace(/\n/g, "<br>"));
    const copyBtn = el("builder-copy-diff-btn");
    if (copyBtn) copyBtn.disabled = !proposal.diff;
    updateApplyButton();
  }

  function renderApplyResult(result) {
    const snap = result.snapshot || {};
    const out = el("builder-apply-output");
    if (!out) return;
    out.textContent = "";
    const lines = [
      "Patch applied.",
      "File changed: " + (result.file_path || ""),
      "Matches replaced: " + (result.matches_replaced || 0),
      "Snapshot: " + (snap.id || ""),
      "Backup: " + (snap.snapshot_dir || ""),
      "Rollback is available.",
    ];
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      out.appendChild(div);
    }
    const rollbackInput = el("builder-rollback-id");
    if (rollbackInput && snap.id) rollbackInput.value = snap.id;
  }

  function renderCommandResult(result) {
    const out = el("builder-command-output");
    if (!out) return;
    out.textContent = "";
    const lines = [
      "$ " + result.command,
      "cwd: " + result.cwd,
      `exit: ${result.exit_code}   runtime: ${result.runtime_ms}ms`,
      "timed out: " + (result.timed_out ? "yes" : "no"),
      "",
      "stdout:",
      result.stdout || "",
      "",
      "stderr:",
      result.stderr || "",
    ];
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      out.appendChild(div);
    }
  }

  function renderSnapshots(snapshots) {
    setHtml("builder-snapshots", snapshots.length
      ? snapshots.map(item => `
          <div class="builder-snapshot-item">
            <div class="builder-snapshot-title">${escapeHtml(item.id || "snapshot")}</div>
            <div class="builder-snapshot-meta">${escapeHtml(item.task || "")}</div>
            <div class="builder-snapshot-meta">${escapeHtml((item.files_changed || []).join(", "))}</div>
          </div>
        `).join("")
      : '<div class="builder-empty">No rollback snapshots yet.</div>');
    const rollbackInput = el("builder-rollback-id");
    if (rollbackInput && !rollbackInput.value && snapshots[0]?.id) rollbackInput.value = snapshots[0].id;
  }

  function renderLegacyTaskList(tasks) {
    setHtml("builder-task-list", tasks.length
      ? tasks.map(task => `
          <div class="builder-task-item ${task.id === state.selectedTaskId ? "active" : ""}" data-task-id="${escapeHtml(task.id)}">
            <div class="builder-task-title">${escapeHtml(task.id)} · ${escapeHtml(task.status || "")}</div>
            <div class="builder-task-meta">${escapeHtml(task.task || "")}</div>
            <div class="builder-task-meta">Next: ${escapeHtml(task.active_agent || "none")} · ${escapeHtml(task.updated_at || "")}</div>
          </div>
        `).join("")
      : '<div class="builder-empty">No Builder tasks yet.</div>');
    document.querySelectorAll("#builder-task-list .builder-task-item[data-task-id]").forEach(node => {
      node.addEventListener("click", () => selectLegacyTask(node.getAttribute("data-task-id")));
    });
    updateLegacyTaskButtons();
  }

  function selectLegacyTask(taskId) {
    state.selectedTaskId = taskId;
    const task = state.tasks.find(item => item.id === taskId);
    renderTaskOutput(task);
    renderLegacyTaskList(state.tasks);
  }

  function renderTaskOutput(task) {
    const out = el("builder-task-output");
    if (!out) return;
    out.textContent = "";
    if (!task) { out.textContent = "No active agent task yet."; return; }
    const lines = [
      `${task.id} · ${task.status}`,
      `Next agent: ${task.active_agent || "none"}`,
      task.blocked_reason ? `Blocked: ${task.blocked_reason}` : "",
      "",
      task.task || "",
      "",
      "Agent steps:",
      ...((task.agents || []).map(s => `- ${s.agent}: ${s.status} · ${s.message}`)),
    ].filter(Boolean);
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      out.appendChild(div);
    }
    const receipt = task.artifacts?.task_receipt;
    if (receipt) {
      const head = document.createElement("div");
      head.textContent = "Receipt:";
      out.appendChild(head);
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(receipt, null, 2);
      out.appendChild(pre);
    }
    updateLegacyTaskButtons();
  }

  function applyTaskArtifacts(task) {
    const proposal = task?.artifacts?.patch_proposal;
    if (proposal) {
      state.lastDiff = proposal;
      renderDiff(proposal);
      const fileInput = el("builder-diff-file");
      if (fileInput) fileInput.value = proposal.file_path || "";
    }
    const plan = task?.artifacts?.plan;
    if (plan) renderPlan(plan);
  }

  function updateLegacyTaskButtons() {
    const hasTask = !!state.selectedTaskId;
    const task = state.tasks.find(item => item.id === state.selectedTaskId);
    const terminal = task && ["completed", "cancelled"].includes(task.status);
    const advance = el("builder-advance-task-btn");
    const pause = el("builder-pause-task-btn");
    const cancel = el("builder-cancel-task-btn");
    if (advance) advance.disabled = !hasTask || terminal;
    if (pause) pause.disabled = !hasTask || terminal;
    if (cancel) cancel.disabled = !hasTask || terminal;
  }

  function updateApplyButton() {
    const btn = el("builder-apply-patch-btn");
    if (!btn) return;
    btn.disabled = state.locked || !(state.lastDiff?.id && !state.lastDiff?.applied && el("builder-apply-approved")?.checked);
  }

  function populateFileOptions(extraFiles) {
    const options = new Set();
    (extraFiles || []).forEach(item => {
      if (typeof item === "string") options.add(item);
      else if (item && item.path) options.add(item.path);
    });
    if (state.projectMap) {
      (state.projectMap.important_files || []).slice(0, 80).forEach(p => options.add(p));
      (state.projectMap.entry_points || []).forEach(p => options.add(p));
      (state.projectMap.frontend_modules || []).slice(0, 80).forEach(p => options.add(p));
    }
    const list = el("builder-file-options");
    if (list) {
      list.innerHTML = Array.from(options).sort()
        .map(p => `<option value="${escapeHtml(p)}"></option>`).join("");
    }
    const fileInput = el("builder-diff-file");
    if (fileInput && !fileInput.value && options.size) fileInput.value = Array.from(options)[0];
  }

  function renderReceipts(receipts) {
    setHtml("builder-receipts", receipts.length
      ? receipts.map(r => `
          <div class="builder-receipt-item">
            <div class="builder-receipt-title">${escapeHtml(r.action || "receipt")}</div>
            <div class="builder-receipt-meta">${escapeHtml(r.summary || "")}</div>
            <div class="builder-receipt-meta">${escapeHtml(r.created_at || "")}</div>
          </div>
        `).join("")
      : '<div class="builder-empty">No Builder receipts yet.</div>');
  }

  function stat(label, value) {
    return `
      <div class="builder-stat">
        <div class="builder-stat-label">${escapeHtml(label)}</div>
        <div class="builder-stat-value">${escapeHtml(value)}</div>
      </div>
    `;
  }

  function fileItem(path, meta) {
    return `
      <div class="builder-file-item">
        <div class="builder-file-path">${escapeHtml(path)}</div>
        <div class="builder-file-meta">${escapeHtml(meta || "")}</div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // setup + bindings
  // ---------------------------------------------------------------------------

  function switchBuilderView(view) {
    document.querySelectorAll(".builder-tab[data-builder-tab]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.builderTab === view);
    });
    document.querySelectorAll(".builder-view[data-builder-view]").forEach(panel => {
      panel.classList.toggle("active", panel.dataset.builderView === view);
    });
  }

  function setup() {
    if (state.bound) return; state.bound = true;
    window.TLIWebApps?.setup();
    // Project picker
    el("builder-backend-pill")?.addEventListener("click", () => {
      warmBackend();
      backendPillRefresh();
    });

    const streamSection = el("builder-stream-section");
    const streamToggle = el("builder-stream-toggle");
    if (streamSection && streamToggle) {
      const stored = localStorage.getItem("tli-builder-stream-collapsed");
      if (stored === "true") {
        streamSection.dataset.collapsed = "true";
        streamToggle.setAttribute("aria-expanded", "false");
      }
      streamToggle.addEventListener("click", () => {
        const collapsed = streamSection.dataset.collapsed === "true";
        const next = !collapsed;
        streamSection.dataset.collapsed = next ? "true" : "false";
        streamToggle.setAttribute("aria-expanded", next ? "false" : "true");
        localStorage.setItem("tli-builder-stream-collapsed", next ? "true" : "false");
      });
    }

    el("builder-project-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectMenu();
    });
    document.addEventListener("click", (event) => {
      const menu = el("builder-project-menu");
      const btn = el("builder-project-btn");
      if (!menu || menu.hasAttribute("hidden")) return;
      if (menu.contains(event.target) || (btn && btn.contains(event.target))) return;
      openProjectMenu(false);
    });
    el("builder-chat-scan-btn")?.addEventListener("click", scanProject);
    el("builder-create-project-btn")?.addEventListener("click", createNewProject);

    // Hero composer
    el("builder-new-project-open-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectMenu(true);
      setTimeout(() => el("builder-chat-project-path")?.focus(), 0);
    });
    el("builder-attach-btn")?.addEventListener("click", () => el("builder-attach-input")?.click());
    el("builder-attach-input")?.addEventListener("change", (event) => handleAttachmentFiles(event.target.files));
    const dropzone = el("builder-attach-dropzone");
    if (dropzone) {
      ["dragenter", "dragover"].forEach(type => {
        dropzone.addEventListener(type, (event) => {
          event.preventDefault();
          dropzone.dataset.active = "true";
        });
      });
      ["dragleave", "drop"].forEach(type => {
        dropzone.addEventListener(type, (event) => {
          event.preventDefault();
          dropzone.dataset.active = "false";
        });
      });
      dropzone.addEventListener("drop", (event) => handleAttachmentFiles(event.dataTransfer?.files));
      dropzone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          el("builder-attach-input")?.click();
        }
      });
    }
    document.querySelectorAll("[data-builder-mode]").forEach(btn => {
      btn.addEventListener("click", () => setMode(btn.getAttribute("data-builder-mode")));
    });
    el("builder-start-btn")?.addEventListener("click", startSelectedMode);
    el("builder-chat-send-btn")?.addEventListener("click", sendBuilderMessage);
    el("builder-chat-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        startSelectedMode();
      }
    });
    document.querySelectorAll("[data-builder-prompt]").forEach(btn => {
      btn.addEventListener("click", () => {
        const input = el("builder-chat-input");
        if (input && !state.locked) {
          const prompt = btn.getAttribute("data-builder-prompt") || '';
          input.value = input.value.trim() ? input.value + '\n\n' + prompt : prompt;
          input.focus();
        }
      });
    });

    // Project settings sync
    el("builder-permission")?.addEventListener("change", (event) => {
      state.permissionLevel = event.target.value;
    });
    el("builder-golden")?.addEventListener("change", (event) => {
      state.goldenGuard = !!event.target.checked;
    });

    // Power tools bindings. The removed tabbed workbench is intentionally not wired here.
    el("builder-generate-diff-btn")?.addEventListener("click", generateDiff);
    el("builder-copy-diff-btn")?.addEventListener("click", copyDiff);
    el("builder-apply-patch-btn")?.addEventListener("click", applyPatch);
    el("builder-apply-approved")?.addEventListener("change", updateApplyButton);
    el("builder-load-snapshots-btn")?.addEventListener("click", loadSnapshots);
    el("builder-rollback-btn")?.addEventListener("click", rollbackSnapshot);
    el("builder-run-command-btn")?.addEventListener("click", runCommand);

    // Panel switch trigger
    document.addEventListener("tli-panel-switched", (event) => {
      if (event.detail?.panelId === "panel-builder") onOpen();
      else if (backendPollTimer) { clearInterval(backendPollTimer); backendPollTimer = null; }
    });
    window.addEventListener('tli-session-locked', clearPrivate);
    window.addEventListener('pagehide', clearPrivate);
    window.addEventListener('tli-session-unlocked', () => {
      state.locked = false;
      setBusy('builder-chat-send-btn', false, 'Ask'); setBusy('builder-start-btn', false, 'Start');
      if (el('panel-builder') && !el('panel-builder').hidden) onOpen();
    });
    renderModeControls();
    renderReadiness();
    if (document.getElementById("panel-builder") && !document.getElementById("panel-builder").hidden) {
      onOpen();
    }
  }

  let backendPollTimer = null;

  function onOpen() {
    if (unavailable()) return;
    window.TLIWebApps?.onOpen();
    if (!state.statusLoaded) loadStatus();
    else {
      loadTasks();
      loadReceipts();
      loadSnapshots();
    }
    backendPillRefresh();
    // Opening a workspace only reads status. Explicit task/start controls own inference.
    if (backendPollTimer) clearInterval(backendPollTimer);
    backendPollTimer = setInterval(backendPillRefresh, BACKEND_POLL_MS);
  }

  document.addEventListener("DOMContentLoaded", setup);

  return {
    setup,
    onOpen,
    refresh: () => loadProjectMap(true),
  };
})();
