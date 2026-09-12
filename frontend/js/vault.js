// Vault view state is intentionally memory-only. Decrypted values never enter browser storage.
const _vaultView = { epoch: 0, state: "unavailable", statusRequest: 0, statusPending: null, statusRefreshContents: false, lockedUntil: 0, unlockedUntil: 0, accessTimer: null, expiryTimer: null,
  files: [], secrets: [], notes: [], loaded: {}, observed: {}, requests: {}, busy: new Map(), urls: new Set(),
  noteRequest: 0, noteVersion: 0, noteOriginal: { title: "", content: "" } };
let _vaultNoteActiveId = null;
function _vaultText(id, text) { const node = $(id); if (node) node.textContent = text; }
function _vaultCurrent(epoch) { return epoch === _vaultView.epoch && _vaultView.state === "unlocked"; }
function _vaultMessage(id, text, failed = false) { const node = $(id); if (node) { node.textContent = text; node.dataset.state = failed ? "failed" : "ready"; } }
function _vaultError(error) { return String(error?.message || "The request could not be completed.").slice(0, 300); }
function _vaultClearPrivate() {
  if (_vaultView.accessTimer !== null && typeof clearTimeout === "function") clearTimeout(_vaultView.accessTimer);
  if (_vaultView.expiryTimer !== null && typeof clearTimeout === "function") clearTimeout(_vaultView.expiryTimer);
  _vaultView.accessTimer = null; _vaultView.expiryTimer = null; _vaultView.unlockedUntil = 0;
  _vaultView.epoch++; _vaultView.statusRequest++; _vaultView.statusPending = null; _vaultView.statusRefreshContents = false;
  _vaultView.noteRequest++; _vaultView.noteVersion++; _vaultNoteActiveId = null;
  _vaultView.files = []; _vaultView.secrets = []; _vaultView.notes = [];
  _vaultView.loaded = {}; _vaultView.observed = {}; _vaultView.requests = {};
  _vaultView.noteOriginal = { title: "", content: "" };
  for (const id of ["vault-files-list", "vault-secrets-list", "vault-notes-list"]) { const node = $(id); if (node) node.innerHTML = ""; }
  for (const id of ["vault-password", "vault-secret-key-input", "vault-secret-val-input", "vault-note-title-input", "vault-note-body", "vault-file-input", "vault-files-search", "vault-secrets-search", "vault-notes-search", "vault-reset-password-input", "vault-reset-confirm-input", "sv-reset-confirm", "sv-reset-password", "sv-passphrase", "sv-passphrase-confirm"]) { const node = $(id); if (node) node.value = ""; }
  $("vault-reset-panel")?.classList.add("hidden"); $("vault-forgot-btn")?.setAttribute("aria-expanded", "false");
  const password = $("vault-password"); if (password) password.type = "password";
  const toggle = $("vault-passphrase-toggle"); if (toggle) { toggle.setAttribute("aria-pressed", "false"); toggle.setAttribute("aria-label", "Show passphrase"); toggle.textContent = "Show"; }
  for (const id of ["vault-message", "vault-note-status", "vault-files-status", "vault-secrets-status", "vault-notes-status", "vault-secret-status"]) _vaultText(id, "");
  for (const kind of ["files", "secrets", "notes"]) _vaultText(`vault-${kind}-count`, "—");
  _vaultText("vault-chosen-filename", "No file chosen");
  const editor = $("vault-note-editor"); if (editor) { editor.classList.add("hidden"); editor.dataset.noteId = ""; editor.dataset.noteOrigTitle = ""; }
  $("vault-note-empty")?.classList.remove("hidden"); $("vault-content-area")?.classList.add("hidden");
  for (const url of _vaultView.urls) URL.revokeObjectURL(url); _vaultView.urls.clear();
}
function updateVaultUIFromStatus(status) {
  const known = !!status && typeof status.initialized === "boolean" && typeof status.unlocked === "boolean" && (status.initialized || !status.unlocked);
  const state = !known ? "unavailable" : !status.initialized ? "setup" : status.unlocked ? "unlocked" : "locked";
  if (state !== "unlocked") _vaultClearPrivate(); _vaultView.state = state; _vaultView.lockedUntil = 0;
  const setup = $("vault-setup-section"), auth = $("vault-auth-section"), pill = $("vault-status-pill");
  if (setup) setup.style.display = state === "setup" ? "block" : "none";
  if (auth) auth.style.display = state === "locked" ? "block" : "none";
  if (pill) { pill.className = "vault-pill"; pill.dataset.checked = "true"; pill.dataset.state = state; pill.textContent = { setup: "Setup required", locked: "Locked", unlocked: "Unlocked", unavailable: "Unavailable" }[state]; }
  _vaultText("vault-gate-title", { setup: "Your private space starts here", locked: "Welcome back to your Vault", unlocked: "Your Vault is open", unavailable: "Let’s reconnect to your Vault" }[state]);
  _vaultText("vault-state-message", { setup: "Set a separate Vault passphrase in Security settings to protect files, secrets and private notes.",
    locked: "Enter your Vault passphrase. Your TLI PIN and Vault passphrase are separate.",
    unlocked: "Unlocked for this TLI account for up to 30 minutes. Locking ends Vault access for its other sessions too.",
    unavailable: "Vault status could not be confirmed. Reconnect and check again. Private content has been cleared from this view." }[state]);
  const hint = $("vault-auth-hint");
  if (hint) {
    hint.textContent = ""; hint.style.display = "none"; hint.dataset.state = "";
    if (state === "locked") {
      const raw = status.locked_until;
      const until = raw ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + "Z").getTime() : 0;
      _vaultView.lockedUntil = Number.isFinite(until) ? until : 0;
      const minutes = Math.ceil((until - Date.now()) / 60000), failed = Number.isFinite(status.failed_attempts) ? status.failed_attempts : 0;
      if (minutes > 0) hint.textContent = `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
      else if (failed > 0) hint.textContent = `Wrong passphrase. ${Math.max(0, 10 - failed)} attempt${10 - failed === 1 ? "" : "s"} before a temporary lockout.`;
      if (hint.textContent) hint.style.display = "block";
    }
  }
  const forgot = $("vault-forgot-btn"); if (forgot) forgot.style.display = state === "locked" ? "" : "none";
  if (state !== "locked") $("vault-reset-panel")?.classList.add("hidden");
  $("vault-content-area")?.classList.toggle("hidden", state !== "unlocked");
  const lock = $("vault-lock-btn"); if (lock) lock.style.display = state === "unlocked" ? "" : "none";
  const unlock = $("vault-unlock-btn"); if (unlock) unlock.disabled = _vaultView.busy.has("unlock") || _vaultView.lockedUntil > Date.now();
  const card = document.querySelector(".vault-auth-card"); if (card) { card.dataset.state = state; card.classList.toggle("is-unlocked", state === "unlocked"); }
  _updateSettingsVaultUI(known ? status : null);
  if (state === "unlocked") _vaultScheduleAccessCheck();
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") window.dispatchEvent(new CustomEvent("tli-vault-state-changed", { detail: { state } }));
}
function _updateSettingsVaultUI(status) {
  const setup = $("sv-setup-wrap"), manage = $("sv-manage-wrap");
  if (setup) setup.style.display = status?.initialized === false ? "" : "none";
  if (manage) manage.style.display = status?.initialized === true ? "" : "none";
  _vaultText("sv-status-desc", !status ? "Vault status is unavailable. Reconnect and check again before making changes." : status.unlocked ? "Unlocked for this TLI account. Locking ends access for its other sessions too." : status.initialized ? "Locked — a separate Vault passphrase is required." : "Create a separate passphrase to set up your Vault.");
}
async function _vaultJSON(url, options = {}, requireSuccess = false) {
  const epoch = _vaultView.epoch;
  const res = await fetch(url, options), data = await res.json().catch(() => null);
  if (!res.ok) {
    if (epoch === _vaultView.epoch && (res.status === 401 || res.status === 403) && url !== "/vault/unlock") updateVaultUIFromStatus(null);
    throw new Error(typeof data?.detail === "string" ? data.detail : `Request failed (HTTP ${res.status}).`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || (requireSuccess && data.ok !== true) || data.ok === false) throw new Error(typeof data?.detail === "string" ? data.detail : "TLI did not confirm this result. Check the current state before retrying.");
  return data;
}
function _vaultPost(body) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
function _vaultTask(key, buttons, work) {
  if (_vaultView.busy.has(key)) return _vaultView.busy.get(key);
  const controls = buttons.filter(Boolean).map(button => ({ button, disabled: button.disabled }));
  controls.forEach(({ button }) => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
  const epoch = _vaultView.epoch;
  const task = Promise.resolve().then(() => epoch === _vaultView.epoch ? work() : false).finally(() => {
    _vaultView.busy.delete(key);
    controls.forEach(({ button, disabled }) => { button.disabled = disabled; button.setAttribute("aria-busy", "false"); });
    const unlock = $("vault-unlock-btn"); if (unlock) unlock.disabled = _vaultView.busy.has("unlock") || _vaultView.lockedUntil > Date.now();
    _vaultUpdateNoteState();
  });
  _vaultView.busy.set(key, task); return task;
}
function _vaultTime(value) { return typeof value === "string" ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z").getTime() : 0; }
function _vaultScheduleAccessCheck() {
  if (typeof setTimeout !== "function") return;
  if (_vaultView.accessTimer !== null && typeof clearTimeout === "function") clearTimeout(_vaultView.accessTimer);
  if (_vaultView.expiryTimer !== null && typeof clearTimeout === "function") clearTimeout(_vaultView.expiryTimer);
  const epoch = _vaultView.epoch;
  // The deadline is independent of the network probe: a hanging request cannot keep content visible.
  if (_vaultView.unlockedUntil) _vaultView.expiryTimer = setTimeout(() => {
    if (!_vaultCurrent(epoch)) return;
    updateVaultUIFromStatus(null);
    _vaultText("vault-state-message", "The last confirmed unlock window has ended. Private content has been cleared. Check status to confirm current Vault access.");
  }, Math.max(0, _vaultView.unlockedUntil - Date.now()));
  _vaultView.accessTimer = setTimeout(() => {
    _vaultView.accessTimer = null;
    if (!_vaultCurrent(epoch)) return;
    if (_vaultView.unlockedUntil && Date.now() >= _vaultView.unlockedUntil) {
      updateVaultUIFromStatus(null);
      _vaultText("vault-state-message", "The last confirmed unlock window has ended. Private content has been cleared. Check status to confirm current Vault access.");
      return;
    }
    // Access checks only. Never re-read decrypted content in the background.
    fetchVaultStatus({ refreshContents: false });
  }, 30000);
}
async function _vaultReadStatus() {
  if (typeof setTimeout !== "function") return _vaultJSON("/vault/status");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    return await Promise.race([
      _vaultJSON("/vault/status", controller ? { signal: controller.signal } : {}),
      new Promise((resolve, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error("Vault access check timed out.")); }, 15000); }),
    ]);
  } finally { if (typeof clearTimeout === "function") clearTimeout(timer); }
}
async function fetchVaultStatus(options = {}) {
  if (_vaultView.statusPending) { if (options.refreshContents !== false) _vaultView.statusRefreshContents = true; return _vaultView.statusPending; }
  _vaultView.statusRefreshContents = options.refreshContents !== false;
  const request = ++_vaultView.statusRequest, epoch = _vaultView.epoch;
  const pending = (async () => {
    try {
      const data = await _vaultReadStatus();
      if (epoch !== _vaultView.epoch || request !== _vaultView.statusRequest) return null;
      if (typeof data.initialized !== "boolean" || typeof data.unlocked !== "boolean" || (!data.initialized && data.unlocked)) throw new Error("Invalid Vault status response.");
      updateVaultUIFromStatus(data);
      if (data.unlocked && _vaultView.statusRefreshContents) await Promise.all([refreshVaultFiles(), refreshVaultSecrets(), refreshVaultNotes()]);
      return data;
    } catch (error) {
      if (epoch !== _vaultView.epoch || request !== _vaultView.statusRequest) return null;
      updateVaultUIFromStatus(null); debugLog("warn", "Vault status unavailable: " + _vaultError(error)); return null;
    } finally { if (_vaultView.statusPending === pending) _vaultView.statusPending = null; }
  })();
  _vaultView.statusPending = pending; return pending;
}
const _vaultCollections = {
  files: { url: "/vault/list", field: "files", validate: row => typeof row?.id === "string" && typeof row?.name === "string" },
  secrets: { url: "/vault/secrets", field: "keys", validate: row => typeof row === "string" },
  notes: { url: "/vault/notes", field: "notes", validate: row => typeof row?.id === "string" && typeof row?.title === "string" },
};
async function _vaultRefresh(kind) {
  if (_vaultView.state !== "unlocked" || !$("vault-" + kind + "-list")) return false;
  const epoch = _vaultView.epoch, request = (_vaultView.requests[kind] || 0) + 1; _vaultView.requests[kind] = request;
  _vaultMessage(`vault-${kind}-status`, `Checking ${kind}…`);
  try {
    const config = _vaultCollections[kind], data = await _vaultJSON(config.url);
    if (!_vaultCurrent(epoch) || request !== _vaultView.requests[kind]) return false;
    if (!Array.isArray(data[config.field]) || !data[config.field].every(config.validate)) throw new Error(`TLI returned an incomplete ${kind} list.`);
    _vaultView[kind] = data[config.field]; _vaultView.loaded[kind] = true; _vaultView.observed[kind] = Date.now(); _vaultRender(kind);
    _vaultMessage(`vault-${kind}-status`, `Checked at ${new Date(_vaultView.observed[kind]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`); return true;
  } catch (error) {
    if (!_vaultCurrent(epoch) || request !== _vaultView.requests[kind]) return false;
    const retained = _vaultView.loaded[kind] ? ` Previous list from ${new Date(_vaultView.observed[kind]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} is still shown.` : " Check again to retry.";
    _vaultMessage(`vault-${kind}-status`, `Could not load ${kind}.${retained}`, true);
    if (!_vaultView.loaded[kind]) _vaultEmpty($("vault-" + kind + "-list"), `Could not load ${kind}. Check again to retry.`);
    debugLog("warn", `Vault ${kind} unavailable: ` + _vaultError(error)); return false;
  }
}
function refreshVaultFiles() { return _vaultRefresh("files"); }
function refreshVaultSecrets() { return _vaultRefresh("secrets"); }
function refreshVaultNotes() { return _vaultRefresh("notes"); }
function _vaultEmpty(list, text) { if (!list) return; list.innerHTML = ""; const empty = document.createElement("div"); empty.className = "vault-file-empty"; empty.textContent = text; list.appendChild(empty); }
function _vaultButton(label, className, handler) { const button = document.createElement("button"); button.type = "button"; button.className = className || "btn-outline"; button.textContent = label; button.addEventListener("click", handler); return button; }
function _vaultRender(kind) {
  const list = $("vault-" + kind + "-list"); if (!list || _vaultView.state !== "unlocked") return; list.innerHTML = "";
  const term = ($(`vault-${kind}-search`)?.value || "").trim().toLocaleLowerCase(), label = row => kind === "files" ? row.name : kind === "notes" ? row.title : row;
  const matches = _vaultView[kind].filter(row => label(row).toLocaleLowerCase().includes(term)).sort((a, b) => kind === "files" && $("vault-files-sort")?.value === "size" ? (Number(b.size) || 0) - (Number(a.size) || 0) || label(a).localeCompare(label(b)) : label(a).localeCompare(label(b)));
  _vaultText(`vault-${kind}-count`, String(_vaultView[kind].length));
  if (!matches.length) return _vaultEmpty(list, term ? "No matches. Try another name or clear the search." : { files: "No encrypted files yet. Choose a file to protect.", secrets: "No secrets yet. Save a value using the form above.", notes: "No Vault notes yet. Create your first private note." }[kind]);
  for (const row of matches.slice(0, 200)) list.appendChild(kind === "files" ? _vaultFileRow(row) : kind === "secrets" ? _vaultSecretRow(row) : _vaultNoteRow(row));
  if (matches.length > 200) { const more = document.createElement("p"); more.className = "vault-list-limit"; more.textContent = `Showing 200 of ${matches.length} matches. Search to narrow the list.`; list.appendChild(more); }
}
function _vaultFileRow(file) {
  const row = document.createElement("div"); row.className = "vault-file-row";
  const name = document.createElement("span"); name.className = "vault-file-name"; name.textContent = file.name; name.title = file.name;
  const size = document.createElement("span"); size.className = "vault-file-size"; size.textContent = file.size_display || "Size unavailable"; size.title = "Encrypted size on the TLI host";
  const actions = document.createElement("span"); actions.className = "vault-file-actions";
  const download = _vaultButton("Download", "btn-outline", () => _vaultDownload("/vault/get_file?file_id=" + encodeURIComponent(file.id), file.name, download, true));
  const remove = _vaultButton("Delete", "btn-outline danger", () => _vaultTask("file-delete:" + file.id, [remove], async () => {
    if (!confirm(`Delete “${file.name}” from the Vault? This cannot be undone.`)) return;
    const epoch = _vaultView.epoch;
    try { const result = await _vaultJSON("/vault/delete_file", _vaultPost({ file_id: file.id }), true); if (!_vaultCurrent(epoch)) return;
      if (typeof result.deleted !== "boolean") throw new Error("TLI did not confirm whether the file was deleted.");
      _vaultMessage("vault-message", result.deleted ? "File deleted from the Vault." : "This file was already absent. The list has been refreshed."); await refreshVaultFiles();
    } catch (error) { if (_vaultCurrent(epoch)) _vaultMessage("vault-message", "Delete failed. " + _vaultError(error), true); }
  }));
  actions.appendChild(download); actions.appendChild(remove); row.appendChild(name); row.appendChild(size); row.appendChild(actions); return row;
}
function _vaultSecretRow(key) {
  const row = document.createElement("div"); row.className = "vault-secret-row";
  const name = document.createElement("span"); name.className = "vault-secret-key"; name.textContent = key;
  const value = document.createElement("span"); value.className = "vault-secret-val"; value.textContent = "••••••••"; let revealed = false;
  const reveal = _vaultButton("Show", "btn-outline", () => {
    if (revealed) { value.textContent = "••••••••"; reveal.textContent = "Show"; reveal.setAttribute("aria-pressed", "false"); revealed = false; return; }
    return _vaultTask("secret-reveal:" + key, [reveal], async () => {
      const epoch = _vaultView.epoch;
      try { const data = await _vaultJSON(`/vault/secret/${encodeURIComponent(key)}`); if (!_vaultCurrent(epoch) || !row.isConnected) return;
        if (typeof data.value !== "string") throw new Error("Secret value was not returned.");
        value.textContent = data.value; reveal.textContent = "Hide"; reveal.setAttribute("aria-pressed", "true"); revealed = true;
      } catch (error) { if (_vaultCurrent(epoch)) showToast("Could not reveal secret. " + _vaultError(error), "error"); }
    });
  });
  reveal.setAttribute("aria-label", `Show or hide ${key}`); reveal.setAttribute("aria-pressed", "false");
  const copy = _vaultButton("Copy", "btn-outline", () => _vaultTask("secret-copy:" + key, [copy], async () => {
    const epoch = _vaultView.epoch;
    try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard access requires HTTPS or opening TLI on the host computer.");
      const data = await _vaultJSON(`/vault/secret/${encodeURIComponent(key)}`); if (!_vaultCurrent(epoch)) return;
      if (typeof data.value !== "string") throw new Error("Secret value was not returned."); await navigator.clipboard.writeText(data.value);
      if (_vaultCurrent(epoch)) showToast("Copied. Your clipboard is outside the Vault; locking does not clear it.", "info");
    } catch (error) { if (_vaultCurrent(epoch)) showToast("Could not copy secret. " + _vaultError(error), "error"); }
  }));
  copy.setAttribute("aria-label", `Copy ${key}`);
  const remove = _vaultButton("Delete", "btn-outline danger", () => _vaultTask("secret-delete:" + key, [remove], async () => {
    if (!confirm(`Delete secret “${key}”? This cannot be undone.`)) return;
    const epoch = _vaultView.epoch;
    try { const result = await _vaultJSON(`/vault/secret/${encodeURIComponent(key)}`, { method: "DELETE" }, true); if (!_vaultCurrent(epoch)) return;
      if (typeof result.existed !== "boolean") throw new Error("TLI did not confirm whether the secret was deleted.");
      _vaultMessage("vault-secret-status", result.existed ? "Secret deleted." : "This secret was already absent."); await refreshVaultSecrets();
    } catch (error) { if (_vaultCurrent(epoch)) _vaultMessage("vault-secret-status", "Delete failed. " + _vaultError(error), true); }
  }));
  const actions = document.createElement("span"); actions.className = "vault-secret-actions"; actions.appendChild(reveal); actions.appendChild(copy); actions.appendChild(remove);
  row.appendChild(name); row.appendChild(value); row.appendChild(actions); return row;
}
function _vaultNoteRow(note) { const row = _vaultButton(note.title || "Untitled note", "vault-note-item" + (note.id === _vaultNoteActiveId ? " is-active" : ""), () => loadVaultNote(note.id)); row.setAttribute("aria-label", `Open Vault note: ${note.title || note.id}`); row.setAttribute("aria-pressed", String(note.id === _vaultNoteActiveId)); row.title = note.title; return row; }
function _vaultDraft() { return { title: $("vault-note-title-input")?.value || "", content: $("vault-note-body")?.value || "" }; }
function _vaultNoteDirty() { const draft = _vaultDraft(); return draft.title !== _vaultView.noteOriginal.title || draft.content !== _vaultView.noteOriginal.content; }
function _vaultUpdateNoteState() {
  const title = $("vault-note-title-input")?.value.trim() || "", changedTitle = !!_vaultNoteActiveId && title !== _vaultView.noteOriginal.title.trim();
  const save = $("vault-note-save-btn"); if (save) save.textContent = _vaultView.busy.has("note-save") ? "Saving…" : changedTitle ? "Save as new note" : "Save note";
  const remove = $("vault-note-delete-btn"); if (remove) remove.textContent = _vaultNoteActiveId ? "Delete note" : "Discard draft";
}
function _vaultLeaveNote() {
  if (_vaultView.busy.has("note-save") || _vaultView.busy.has("note-delete")) { _vaultMessage("vault-note-status", "Wait for the current note request to finish."); return false; }
  return !_vaultNoteDirty() || confirm("Discard unsaved changes to this Vault note? They are kept only in this unlocked view.");
}
async function loadVaultNote(noteId) {
  if (_vaultView.state !== "unlocked" || !_vaultLeaveNote()) return;
  const epoch = _vaultView.epoch, request = ++_vaultView.noteRequest, version = _vaultView.noteVersion; _vaultMessage("vault-note-status", "Opening note…");
  try { const data = await _vaultJSON(`/vault/note/${encodeURIComponent(noteId)}`); if (!_vaultCurrent(epoch) || request !== _vaultView.noteRequest || version !== _vaultView.noteVersion) return;
    if (typeof data.title !== "string" || typeof data.content !== "string" || data.id !== noteId) throw new Error("TLI returned an incomplete or different note.");
    _vaultNoteActiveId = noteId; _vaultView.noteOriginal = { title: data.title, content: data.content };
    const editor = $("vault-note-editor"); if (!editor) return;
    $("vault-note-title-input").value = data.title; $("vault-note-body").value = data.content; editor.dataset.noteId = noteId; editor.dataset.noteOrigTitle = data.title; editor.classList.remove("hidden");
    $("vault-note-empty")?.classList.add("hidden"); _vaultMessage("vault-note-status", ""); _vaultRender("notes"); _vaultUpdateNoteState();
  } catch (error) { if (_vaultCurrent(epoch) && request === _vaultView.noteRequest) _vaultMessage("vault-note-status", "Could not open this note. Your previous note or draft is unchanged. " + _vaultError(error), true); }
}
function _vaultOpenNewNote() {
  if (_vaultView.state !== "unlocked" || !_vaultLeaveNote()) return;
  _vaultView.noteRequest++; _vaultView.noteVersion++; _vaultNoteActiveId = null; _vaultView.noteOriginal = { title: "", content: "" };
  const editor = $("vault-note-editor"); if (!editor) return;
  $("vault-note-title-input").value = ""; $("vault-note-body").value = ""; editor.dataset.noteId = ""; editor.dataset.noteOrigTitle = ""; editor.classList.remove("hidden");
  $("vault-note-empty")?.classList.add("hidden"); _vaultMessage("vault-note-status", "Draft — saved only when you choose Save note."); _vaultRender("notes"); _vaultUpdateNoteState(); $("vault-note-title-input")?.focus();
}
async function _vaultSaveNote() {
  if (_vaultView.state !== "unlocked") return;
  return _vaultTask("note-save", [$("vault-note-save-btn"), $("vault-note-delete-btn"), $("vault-newnote-btn")], async () => {
    const epoch = _vaultView.epoch, draft = _vaultDraft(), oldId = _vaultNoteActiveId, title = draft.title.trim(), content = draft.content;
    if (!title) { _vaultMessage("vault-note-status", "Give this note a title before saving.", true); return; }
    _vaultMessage("vault-note-status", "Saving…"); _vaultUpdateNoteState();
    try {
      // The preserved format derives identity from the title. A different existing note needs explicit review.
      if (!await refreshVaultNotes()) throw new Error("The note list could not be checked. Your draft is unchanged."); if (!_vaultCurrent(epoch)) return;
      const targetId = "__note_" + title.replace(/[^a-zA-Z0-9_-]+/g, "_"), collision = _vaultView.notes.find(note => note.id === targetId && note.id !== oldId);
      if (collision && !confirm(`A Vault note named “${collision.title}” already exists. Replace its contents with this draft?`)) { _vaultMessage("vault-note-status", "Replacement cancelled. Your draft is unchanged."); return; }
      const data = await _vaultJSON("/vault/note", _vaultPost({ title, content }), true); if (!_vaultCurrent(epoch)) return;
      if (typeof data.id !== "string" || !data.id) throw new Error("TLI did not return the saved note identity. Check the list before retrying.");
      _vaultNoteActiveId = data.id; _vaultView.noteOriginal = { title: draft.title, content };
      const editor = $("vault-note-editor"); editor.dataset.noteId = data.id; editor.dataset.noteOrigTitle = draft.title;
      _vaultMessage("vault-note-status", _vaultNoteDirty() ? "Saved the submitted version. Your newer edits are not saved yet." : oldId && oldId !== data.id ? "Saved as a separate note. The original note is unchanged." : "Note saved."); await refreshVaultNotes();
    } catch (error) { if (_vaultCurrent(epoch)) _vaultMessage("vault-note-status", "Save failed. Your draft is still here. " + _vaultError(error), true); }
  });
}
async function _vaultDeleteNote() {
  if (_vaultView.state !== "unlocked") return;
  if (!_vaultNoteActiveId) {
    if (!_vaultLeaveNote()) return; _vaultView.noteRequest++; _vaultView.noteVersion++; _vaultView.noteOriginal = { title: "", content: "" };
    $("vault-note-title-input").value = ""; $("vault-note-body").value = ""; $("vault-note-editor")?.classList.add("hidden"); $("vault-note-empty")?.classList.remove("hidden"); _vaultMessage("vault-note-status", "Draft discarded."); return;
  }
  return _vaultTask("note-delete", [$("vault-note-delete-btn"), $("vault-note-save-btn"), $("vault-newnote-btn")], async () => {
    const epoch = _vaultView.epoch, id = _vaultNoteActiveId; if (!confirm("Delete this Vault note and any unsaved edits? This cannot be undone.")) return;
    try { await _vaultJSON(`/vault/note/${encodeURIComponent(id)}`, { method: "DELETE" }, true); if (!_vaultCurrent(epoch)) return;
      _vaultNoteActiveId = null; _vaultView.noteRequest++; _vaultView.noteVersion++; _vaultView.noteOriginal = { title: "", content: "" };
      $("vault-note-title-input").value = ""; $("vault-note-body").value = ""; const editor = $("vault-note-editor"); editor.dataset.noteId = ""; editor.dataset.noteOrigTitle = ""; editor.classList.add("hidden");
      $("vault-note-empty")?.classList.remove("hidden"); _vaultMessage("vault-note-status", "Note deleted."); await refreshVaultNotes();
    } catch (error) { if (_vaultCurrent(epoch)) _vaultMessage("vault-note-status", "Delete failed. Your note is unchanged. " + _vaultError(error), true); }
  });
}
async function _vaultUnlock(password) {
  if (!password || _vaultView.busy.has("lock") || _vaultView.lockedUntil > Date.now()) return;
  return _vaultTask("unlock", [$("vault-unlock-btn"), $("vault-status-recheck"), $("vault-refresh-content")], async () => {
    const epoch = _vaultView.epoch, hint = $("vault-auth-hint"); _vaultText("vault-auth-hint", "Unlocking…"); if (hint) { hint.style.display = "block"; hint.dataset.state = "working"; }
    try { const result = await _vaultJSON("/vault/unlock", _vaultPost({ password })); if (epoch !== _vaultView.epoch) return;
      if (result.success !== true) throw new Error("TLI did not confirm that the Vault unlocked.");
      const expires = _vaultTime(result.unlocked_until); _vaultView.unlockedUntil = Number.isFinite(expires) ? expires : 0;
      if ($("vault-password")) $("vault-password").value = ""; _vaultView.statusRequest++; _vaultView.statusPending = null;
      const status = await fetchVaultStatus();
      if (!status?.unlocked && hint) { hint.textContent = "Unlock result could not be verified. Check Vault status before retrying."; hint.style.display = "block"; }
    } catch (error) {
      if (epoch !== _vaultView.epoch) return;
      await fetchVaultStatus(); if (hint && !hint.textContent) { hint.textContent = _vaultError(error); hint.style.display = "block"; }
      debugLog("warn", "Vault unlock failed: " + _vaultError(error));
    }
  });
}
async function _vaultLock() {
  if (_vaultView.busy.has("lock")) return _vaultView.busy.get("lock");
  if (_vaultNoteDirty() && !confirm("Lock the Vault and discard unsaved note edits? Private content will be cleared from this view.")) return false;
  const unlocking = _vaultView.busy.get("unlock");
  updateVaultUIFromStatus(null); _vaultText("vault-state-message", "Locking Vault access for this TLI account… Private content has been cleared from this view.");
  return _vaultTask("lock", [$("vault-lock-btn"), $("vault-status-recheck"), $("vault-unlock-btn")], async () => {
    const epoch = _vaultView.epoch;
    try { if (unlocking) await unlocking; await _vaultJSON("/vault/lock", { method: "POST" }, true); if (epoch !== _vaultView.epoch) return false;
      updateVaultUIFromStatus({ initialized: true, unlocked: false }); _vaultText("vault-state-message", "Vault locked for this TLI account. Private content has been cleared from this view."); return true;
    } catch (error) {
      _vaultText("vault-state-message", "Private content is hidden, but TLI did not confirm the server lock. " + _vaultError(error) + " Choose Lock again to retry.");
      const retry = $("vault-lock-btn"); if (retry) retry.style.display = ""; showToast("Vault lock was not confirmed. " + _vaultError(error), "error"); return false;
    }
  });
}
async function _vaultDownload(url, filename, button, decrypted = false) {
  return _vaultTask("download:" + url, [button], async () => {
    const epoch = _vaultView.epoch;
    try {
      const res = await fetch(url); if (!res.ok) { if (res.status === 401 || res.status === 403) updateVaultUIFromStatus(null); throw new Error(`Request failed (HTTP ${res.status}).`); }
      const blob = await res.blob(); if (epoch !== _vaultView.epoch || (decrypted && !_vaultCurrent(epoch))) return;
      const objectURL = URL.createObjectURL(blob); _vaultView.urls.add(objectURL); const anchor = document.createElement("a"); anchor.href = objectURL; anchor.download = filename; anchor.hidden = true;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => { URL.revokeObjectURL(objectURL); _vaultView.urls.delete(objectURL); }, 1000);
      showToast(decrypted ? "Download started. Your browser saves an unencrypted copy outside the Vault." : "Encrypted file export started. Keep the original installation, key metadata and Vault passphrase; this is not a verified recovery backup.", "info");
    } catch (error) { if (epoch === _vaultView.epoch) showToast("Download failed. " + _vaultError(error), "error"); }
  });
}
function _vaultWire(id, event, handler) { const node = $(id); if (!node) return; const key = "__vault_" + event; if (node[key]) return; node[key] = true; node.addEventListener(event, handler); }
function setupSettingsVault() {
  const initialize = () => _vaultTask("setup", [$("sv-setup-btn")], async () => {
    const password = $("sv-passphrase")?.value || "", confirmation = $("sv-passphrase-confirm")?.value || "";
    if (password.length < 8) { showToast("Passphrase must be at least 8 characters.", "error"); return; }
    if (password !== confirmation) { showToast("Passphrases do not match.", "error"); return; }
    const epoch = _vaultView.epoch;
    try { await _vaultJSON("/vault/setup", _vaultPost({ password }), true); if (epoch !== _vaultView.epoch) return;
      $("sv-passphrase").value = ""; $("sv-passphrase-confirm").value = ""; showToast("Vault passphrase created. Open the Vault to unlock it.", "success"); await fetchVaultStatus();
    } catch (error) { if (epoch === _vaultView.epoch) showToast("Vault setup failed. " + _vaultError(error), "error"); }
  });
  _vaultWire("sv-setup-btn", "click", initialize);
  for (const id of ["sv-passphrase", "sv-passphrase-confirm"]) _vaultWire(id, "keydown", event => { if (event.key === "Enter") { event.preventDefault(); initialize(); } });
  _vaultWire("sv-open-btn", "click", () => { if (typeof switchPanel === "function") switchPanel("panel-vault"); });
  _vaultWire("sv-export-btn", "click", () => _vaultDownload("/vault/export_backup", "tli-vault-encrypted-files.zip", $("sv-export-btn")));
  _vaultSetupReset("sv-reset-confirm", "sv-reset-password", "sv-reset-btn");
}
function _vaultSetupReset(confirmId, passwordId, buttonId) {
  const button = $(buttonId); if (!button) return;
  const ready = () => { button.disabled = _vaultView.busy.has("reset") || $(confirmId)?.value !== "RESET VAULT" || !$(passwordId)?.value; };
  _vaultWire(confirmId, "input", ready); _vaultWire(passwordId, "input", ready);
  _vaultWire(buttonId, "click", async () => {
    const password = $(passwordId)?.value || ""; if ($(confirmId)?.value !== "RESET VAULT" || !password) return;
    await _vaultTask("reset", [$("sv-reset-btn"), $("vault-hard-reset-btn")], async () => {
      if (!confirm("Permanently delete all Vault files, secrets, notes and saved logins? This requires the current Vault passphrase. This cannot be undone.")) return;
      const epoch = _vaultView.epoch;
      try { await _vaultJSON("/vault/reset", _vaultPost({ confirmation: "RESET VAULT", password }), true); if (epoch !== _vaultView.epoch) return;
        $(confirmId).value = ""; $(passwordId).value = ""; updateVaultUIFromStatus({ initialized: false, unlocked: false }); showToast("Vault data deleted. You can now create a new passphrase.", "success");
      } catch (error) { if (epoch === _vaultView.epoch) showToast("Reset failed. " + _vaultError(error), "error"); }
    }); ready();
  }); ready();
}
function setupVaultPanel() {
  // The shared navigation/settings owners handle the setup button's data-panel-target.
  _vaultWire("vault-status-recheck", "click", () => _vaultTask("status", [$("vault-status-recheck")], fetchVaultStatus));
  _vaultWire("vault-refresh-content", "click", () => _vaultTask("refresh", [$("vault-refresh-content")], fetchVaultStatus));
  _vaultWire("vault-unlock-btn", "click", () => _vaultUnlock($("vault-password")?.value || ""));
  _vaultWire("vault-password", "keydown", event => { if (event.key === "Enter") { event.preventDefault(); _vaultUnlock($("vault-password")?.value || ""); } });
  _vaultWire("vault-lock-btn", "click", _vaultLock);
  _vaultWire("vault-passphrase-toggle", "click", () => { const input = $("vault-password"), button = $("vault-passphrase-toggle"); if (!input || !button) return; const showing = input.type === "password"; input.type = showing ? "text" : "password"; button.textContent = showing ? "Hide" : "Show"; button.setAttribute("aria-pressed", String(showing)); button.setAttribute("aria-label", showing ? "Hide passphrase" : "Show passphrase"); });
  document.querySelector(".vault-tab-bar")?.setAttribute("role", "tablist");
  const tabs = [...document.querySelectorAll(".vault-tab")];
  tabs.forEach((tab, index) => {
    const target = tab.dataset.vaultTab; tab.id = tab.id || "vault-tab-button-" + target; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", "vault-tab-" + target);
    tab.setAttribute("aria-selected", String(tab.classList.contains("is-active"))); tab.tabIndex = tab.classList.contains("is-active") ? 0 : -1;
    const pane = $("vault-tab-" + target); pane?.setAttribute("role", "tabpanel"); pane?.setAttribute("aria-labelledby", tab.id);
    if (tab.__vaultWired) return; tab.__vaultWired = true;
    tab.addEventListener("click", () => { tabs.forEach(other => { const active = other === tab; other.classList.toggle("is-active", active); other.setAttribute("aria-selected", String(active)); other.tabIndex = active ? 0 : -1; }); document.querySelectorAll(".vault-tab-pane").forEach(other => other.classList.toggle("hidden", other.id !== "vault-tab-" + target)); if (target !== "secrets") _vaultRender("secrets"); });
    tab.addEventListener("keydown", event => { const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null; if (next === null) return; event.preventDefault(); tabs[next].focus(); tabs[next].click(); });
  });
  for (const kind of ["files", "secrets", "notes"]) _vaultWire(`vault-${kind}-search`, "input", () => _vaultRender(kind));
  _vaultWire("vault-files-sort", "change", () => _vaultRender("files"));
  _vaultWire("vault-file-input", "change", () => _vaultText("vault-chosen-filename", $("vault-file-input")?.files?.[0]?.name || "No file chosen"));
  _vaultWire("vault-upload-btn", "click", () => _vaultTask("upload", [$("vault-upload-btn")], async () => {
    const input = $("vault-file-input"), file = input?.files?.[0], epoch = _vaultView.epoch; if (!_vaultCurrent(epoch)) return;
    if (!file) { _vaultMessage("vault-message", "Choose a file first.", true); return; }
    if (file.size > 250 * 1024 * 1024) { _vaultMessage("vault-message", "Choose a file smaller than 250 MB.", true); return; }
    _vaultMessage("vault-message", "Checking the destination…");
    try { if (!await refreshVaultFiles()) throw new Error("The file list could not be checked. Your chosen file is unchanged."); if (!_vaultCurrent(epoch)) return;
      const base = file.name.replace(/\.vault$/i, "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
      if (base.startsWith("__")) throw new Error("Names beginning with two underscores are reserved for Vault stores. Rename this file before uploading.");
      const existing = _vaultView.files.find(entry => entry.id === base);
      if (existing && !confirm(`“${existing.name}” already exists in the Vault. Replace that encrypted file with “${file.name}”?`)) { _vaultMessage("vault-message", "Replacement cancelled. Your chosen file is unchanged."); return; }
      const form = new FormData(); form.append("file", file); _vaultMessage("vault-message", "Uploading and encrypting…");
      const result = await _vaultJSON("/vault/upload", { method: "POST", body: form }, true); if (!_vaultCurrent(epoch)) return;
      if (typeof result.file_id !== "string") throw new Error("TLI did not return the stored file identity. Check the list before retrying.");
      _vaultMessage("vault-message", `Encrypted file saved as ${result.file_id}. Your original file is unchanged.`);
      if (input.files?.[0] === file) { input.value = ""; _vaultText("vault-chosen-filename", "No file chosen"); } await refreshVaultFiles();
    } catch (error) { if (_vaultCurrent(epoch)) _vaultMessage("vault-message", "Upload failed. " + _vaultError(error), true); }
  }));
  _vaultWire("vault-forgot-btn", "click", () => { const panel = $("vault-reset-panel"); if (!panel) return; const hidden = panel.classList.toggle("hidden"); $("vault-forgot-btn")?.setAttribute("aria-expanded", String(!hidden)); });
  _vaultWire("vault-export-backup-btn", "click", () => _vaultDownload("/vault/export_backup", "tli-vault-encrypted-files.zip", $("vault-export-backup-btn")));
  _vaultSetupReset("vault-reset-confirm-input", "vault-reset-password-input", "vault-hard-reset-btn");
  const addSecret = () => _vaultTask("secret-save", [$("vault-secret-add-btn")], async () => {
    const epoch = _vaultView.epoch, keyInput = $("vault-secret-key-input"), valueInput = $("vault-secret-val-input"), key = keyInput?.value.trim() || "", value = valueInput?.value || "";
    if (!_vaultCurrent(epoch)) return; if (!key) { _vaultMessage("vault-secret-status", "Give this secret a name.", true); return; }
    try { if (!await refreshVaultSecrets()) throw new Error("The secret list could not be checked. Your draft is unchanged."); if (!_vaultCurrent(epoch)) return;
      if (_vaultView.secrets.includes(key) && !confirm(`Replace the existing value of “${key}”?`)) { _vaultMessage("vault-secret-status", "Replacement cancelled. Your draft is unchanged."); return; }
      _vaultMessage("vault-secret-status", "Saving secret…"); await _vaultJSON(`/vault/secret/${encodeURIComponent(key)}`, _vaultPost({ value }), true); if (!_vaultCurrent(epoch)) return;
      if (keyInput.value.trim() === key && valueInput.value === value) { keyInput.value = ""; valueInput.value = ""; }
      _vaultMessage("vault-secret-status", "Secret saved. Its value stays hidden until you choose Show or Copy."); await refreshVaultSecrets();
    } catch (error) { if (_vaultCurrent(epoch)) _vaultMessage("vault-secret-status", "Save failed. Your draft is still here. " + _vaultError(error), true); }
  });
  _vaultWire("vault-secret-add-btn", "click", addSecret);
  _vaultWire("vault-secret-val-input", "keydown", event => { if (event.key === "Enter") { event.preventDefault(); addSecret(); } });
  _vaultWire("vault-newnote-btn", "click", _vaultOpenNewNote); _vaultWire("vault-note-save-btn", "click", _vaultSaveNote); _vaultWire("vault-note-delete-btn", "click", _vaultDeleteNote);
  for (const id of ["vault-note-title-input", "vault-note-body"]) _vaultWire(id, "input", () => { _vaultView.noteVersion++; _vaultUpdateNoteState(); _vaultMessage("vault-note-status", _vaultNoteDirty() ? "Unsaved changes — kept only in this unlocked view." : "No unsaved changes."); });
  _vaultUpdateNoteState();
}
if (typeof window !== "undefined") {
  window.TLIVault = { lock: _vaultLock, clear: () => updateVaultUIFromStatus(null), refresh: fetchVaultStatus };
  window.addEventListener?.("tli-session-locked", () => updateVaultUIFromStatus(null)); window.addEventListener?.("pagehide", () => updateVaultUIFromStatus(null));
  window.addEventListener?.("beforeunload", event => { if (_vaultView.state === "unlocked" && _vaultNoteDirty()) { event.preventDefault(); event.returnValue = ""; } });
  const checkVisibleAccess = () => {
    if (_vaultView.state !== "unlocked" || document.hidden) return;
    if (_vaultView.unlockedUntil && Date.now() >= _vaultView.unlockedUntil) { updateVaultUIFromStatus(null); _vaultText("vault-state-message", "The last confirmed unlock window has ended. Private content has been cleared. Check status to continue."); }
    else fetchVaultStatus({ refreshContents: false });
  };
  window.addEventListener?.("focus", checkVisibleAccess); document.addEventListener?.("visibilitychange", checkVisibleAccess);
  document.addEventListener?.("tli-panel-switched", event => { if (event.detail?.panelId !== "panel-vault" && _vaultView.state === "unlocked") _vaultRender("secrets"); });
}
