// ---------- vault ----------
function updateVaultUIFromStatus(status) {
  const initialized  = !!status.initialized;
  const unlocked     = !!status.unlocked;
  const setupSection = $("vault-setup-section");
  const authSection  = $("vault-auth-section");
  const pill         = $("vault-status-pill");
  const contentArea  = $("vault-content-area");
  const lockBtn      = $("vault-lock-btn");
  const iconGlyph    = $("vault-icon-glyph");
  const authCard     = document.querySelector(".vault-auth-card");

  if (!pill || !setupSection || !authSection) return;

  const hint         = $("vault-auth-hint");
  const forgotBtn    = $("vault-forgot-btn");

  pill.className = "vault-pill";
  if (!initialized) {
    setupSection.style.display = "block";  // shows the redirect note
    authSection.style.display  = "none";
    pill.textContent = "Setup required";
    pill.dataset.state = "setup";
  } else if (!unlocked) {
    setupSection.style.display = "none";
    authSection.style.display  = "block";
    pill.textContent = "Locked";
    pill.dataset.state = "locked";

    // Lockout state
    const lockedUntil  = status.locked_until;
    const failedCount  = status.failed_attempts || 0;
    const remaining    = 5 - failedCount;

    if (hint) {
      if (lockedUntil) {
        const until = new Date(lockedUntil);
        const mins  = Math.ceil((until - Date.now()) / 60000);
        hint.textContent = `Too many failed attempts. Try again in ~${mins} minute${mins !== 1 ? "s" : ""}.`;
        hint.style.display = "block";
      } else if (failedCount > 0) {
        hint.textContent = `Wrong passphrase. ${remaining > 0 ? `${remaining} attempt${remaining !== 1 ? "s" : ""} before lockout.` : ""}`;
        hint.style.display = "block";
      } else {
        hint.textContent = "";
        hint.style.display = "none";
      }
    }

    // Show forgot link after first failed attempt
    if (forgotBtn) forgotBtn.style.display = failedCount > 0 ? "" : "none";
  } else {
    setupSection.style.display = "none";
    authSection.style.display  = "none";
    pill.textContent = "Unlocked";
    pill.dataset.state = "unlocked";
    if (hint) { hint.textContent = ""; hint.style.display = "none"; }
    if (forgotBtn) forgotBtn.style.display = "none";
    // Collapse reset panel if it was open
    const resetPanel = $("vault-reset-panel");
    if (resetPanel) resetPanel.classList.add("hidden");
  }

  if (contentArea) contentArea.classList.toggle("hidden", !unlocked);
  if (lockBtn) lockBtn.style.display = unlocked ? "" : "none";
  if (iconGlyph) iconGlyph.textContent = unlocked ? "🔓" : "🔒";
  if (authCard) authCard.classList.toggle("is-unlocked", unlocked);

  // Mirror state into Settings vault section
  _updateSettingsVaultUI(status);
}

function _updateSettingsVaultUI(status) {
  const initialized = !!status.initialized;
  const unlocked    = !!status.unlocked;
  const setupWrap   = $("sv-setup-wrap");
  const manageWrap  = $("sv-manage-wrap");
  const statusDesc  = $("sv-status-desc");
  if (!setupWrap || !manageWrap) return;

  if (!initialized) {
    setupWrap.style.display  = "";
    manageWrap.style.display = "none";
  } else {
    setupWrap.style.display  = "none";
    manageWrap.style.display = "";
    if (statusDesc) statusDesc.textContent = unlocked
      ? "Unlocked — content is accessible."
      : "Locked — passphrase required to access content.";
  }
}

async function fetchVaultStatus() {
  try {
    const res = await fetch("/vault/status");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    updateVaultUIFromStatus(data);
    if (data.unlocked) {
      await Promise.all([refreshVaultFiles(), refreshVaultSecrets(), refreshVaultNotes()]);
    }
    debugLog("info", "GET /vault/status OK: " + JSON.stringify(data));
  } catch (err) {
    debugLog("warn", "GET /vault/status failed: " + err.message);
    showToast("Vault unavailable — backend unreachable.");
  }
}

async function refreshVaultFiles() {
  const list = $("vault-files-list");
  if (!list) return;
  list.innerHTML = "";
  try {
    const res = await fetch("/vault/list");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const files = data.files || [];

    if (!files.length) {
      list.innerHTML = '<div class="vault-file-empty">No encrypted files yet. Upload one above.</div>';
      return;
    }

    files.forEach(file => {
      const row = document.createElement("div");
      row.className = "vault-file-row";

      const nameEl = document.createElement("span");
      nameEl.className = "vault-file-name";
      nameEl.textContent = file.name || "(unnamed)";
      nameEl.title = file.name || "";

      const sizeEl = document.createElement("span");
      sizeEl.className = "vault-file-size";
      sizeEl.textContent = file.size_display || "";

      const actionsEl = document.createElement("span");
      actionsEl.className = "vault-file-actions";

      const dl = document.createElement("button");
      dl.textContent = "Download";
      dl.className = "btn-outline";
      dl.style.cssText = "font-size:11px;padding:3px 8px;";
      dl.addEventListener("click", () => {
        window.location.href = "/vault/get_file?file_id=" + encodeURIComponent(file.id);
      });

      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "btn-outline danger";
      del.style.cssText = "font-size:11px;padding:3px 8px;";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this vault file? This cannot be undone.")) return;
        try {
          await fetch("/vault/delete_file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file_id: file.id })
          });
          await refreshVaultFiles();
          debugLog("info", "POST /vault/delete_file OK for " + (file.id || file.name));
        } catch (err) {
          debugLog("error", "POST /vault/delete_file failed: " + err.message);
        }
      });

      actionsEl.appendChild(dl);
      actionsEl.appendChild(del);
      row.appendChild(nameEl);
      row.appendChild(sizeEl);
      row.appendChild(actionsEl);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '<div class="vault-file-empty" style="color:var(--danger,#f87171)">Could not load files. Is the backend running?</div>';
    debugLog("warn", "GET /vault/list failed: " + err.message);
  }
}

// ---- Vault secrets ----
async function refreshVaultSecrets() {
  const list = $("vault-secrets-list");
  if (!list) return;
  list.innerHTML = "";
  try {
    const res = await fetch("/vault/secrets");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const keys = data.keys || [];

    if (!keys.length) {
      list.innerHTML = '<div class="vault-secrets-empty">No secrets stored yet.</div>';
      return;
    }

    keys.forEach(key => {
      const row = document.createElement("div");
      row.className = "vault-secret-row";

      const keyEl = document.createElement("span");
      keyEl.className = "vault-secret-key";
      keyEl.textContent = key;

      const valEl = document.createElement("span");
      valEl.className = "vault-secret-val";
      valEl.textContent = "••••••••";
      let revealed = false;

      const revealBtn = document.createElement("button");
      revealBtn.className = "btn-outline";
      revealBtn.style.cssText = "font-size:11px;padding:3px 8px;white-space:nowrap;";
      revealBtn.textContent = "Show";
      revealBtn.addEventListener("click", async () => {
        if (revealed) {
          valEl.textContent = "••••••••";
          revealBtn.textContent = "Show";
          revealed = false;
          return;
        }
        try {
          const r = await fetch(`/vault/secret/${encodeURIComponent(key)}`);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const d = await r.json();
          valEl.textContent = d.value;
          revealBtn.textContent = "Hide";
          revealed = true;
        } catch (err) {
          showToast("Could not reveal secret: " + err.message);
        }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "btn-outline danger";
      delBtn.style.cssText = "font-size:11px;padding:3px 8px;";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete secret "${key}"?`)) return;
        try {
          await fetch(`/vault/secret/${encodeURIComponent(key)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
          });
          await refreshVaultSecrets();
        } catch (err) {
          showToast("Delete failed: " + err.message);
        }
      });

      const actEl = document.createElement("span");
      actEl.className = "vault-secret-actions";
      actEl.appendChild(revealBtn);
      actEl.appendChild(delBtn);

      row.appendChild(keyEl);
      row.appendChild(valEl);
      row.appendChild(actEl);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '<div class="vault-secrets-empty" style="color:var(--danger,#f87171)">Could not load secrets.</div>';
    debugLog("warn", "GET /vault/secrets failed: " + err.message);
  }
}

// ---- Vault notes ----
let _vaultNoteActiveId = null;

async function refreshVaultNotes() {
  const noteList = $("vault-notes-list");
  if (!noteList) return;
  noteList.innerHTML = "";
  try {
    const res = await fetch("/vault/notes");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const notes = data.notes || [];

    if (!notes.length) {
      noteList.innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 2px;">No notes yet.</div>';
    } else {
      notes.forEach(note => {
        const item = document.createElement("div");
        item.className = "vault-note-item" + (note.id === _vaultNoteActiveId ? " is-active" : "");
        item.textContent = note.title || note.id;
        item.title = note.title;
        item.addEventListener("click", () => loadVaultNote(note.id, note.title));
        noteList.appendChild(item);
      });
    }
  } catch (err) {
    noteList.innerHTML = '<div style="font-size:0.78rem;color:var(--danger,#f87171);padding:6px 2px;">Could not load notes.</div>';
    debugLog("warn", "GET /vault/notes failed: " + err.message);
  }
}

async function loadVaultNote(noteId, title) {
  _vaultNoteActiveId = noteId;
  const editor     = $("vault-note-editor");
  const empty      = $("vault-note-empty");
  const titleInput = $("vault-note-title-input");
  const body       = $("vault-note-body");
  const status     = $("vault-note-status");

  if (!editor || !body) return;

  editor.classList.add("hidden");
  if (empty) empty.classList.remove("hidden");
  if (status) status.textContent = "Loading…";

  try {
    const res = await fetch(`/vault/note/${encodeURIComponent(noteId)}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    if (titleInput) titleInput.value = data.title || "";
    body.value = data.content || "";
    if (status) status.textContent = "";

    editor.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
    editor.dataset.noteId = noteId;
    editor.dataset.noteOrigTitle = data.title || "";

    await refreshVaultNotes();
  } catch (err) {
    if (status) status.textContent = "Load failed";
    debugLog("warn", "GET /vault/note failed: " + err.message);
  }
}

function _vaultOpenNewNote() {
  _vaultNoteActiveId = null;
  const editor     = $("vault-note-editor");
  const empty      = $("vault-note-empty");
  const titleInput = $("vault-note-title-input");
  const body       = $("vault-note-body");
  const status     = $("vault-note-status");

  if (!editor) return;
  if (titleInput) titleInput.value = "";
  if (body) body.value = "";
  if (status) status.textContent = "";

  editor.classList.remove("hidden");
  if (empty) empty.classList.add("hidden");
  editor.dataset.noteId = "";

  document.querySelectorAll(".vault-note-item").forEach(el => el.classList.remove("is-active"));
  if (titleInput) titleInput.focus();
}

async function _vaultUnlock(pw) {
  const hint = $("vault-auth-hint");
  try {
    const res = await fetch("/vault/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || "HTTP " + res.status);
    }
    $("vault-password").value = "";
    if (hint) { hint.textContent = ""; hint.style.display = "none"; }
    await fetchVaultStatus();
    await Promise.all([refreshVaultFiles(), refreshVaultSecrets(), refreshVaultNotes()]);
    debugLog("info", "POST /vault/unlock OK");
  } catch (err) {
    // Re-fetch status to get updated failed_attempts count and lockout info
    await fetchVaultStatus();
    debugLog("error", "POST /vault/unlock failed: " + err.message);
  }
}

function setupSettingsVault() {
  // ---- Initialize ----
  const svSetupBtn = $("sv-setup-btn");
  if (svSetupBtn && !svSetupBtn.__tliWired) {
    svSetupBtn.__tliWired = true;
    const doInit = async () => {
      const p1 = ($("sv-passphrase")?.value || "").trim();
      const p2 = ($("sv-passphrase-confirm")?.value || "").trim();
      if (!p1 || p1.length < 8) { showToast("Passphrase must be at least 8 characters.", "error"); return; }
      if (p1 !== p2) { showToast("Passphrases do not match.", "error"); return; }
      svSetupBtn.disabled = true;
      try {
        const res = await fetch("/vault/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: p1 }),
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || "HTTP " + res.status); }
        showToast("Vault initialized. Go to the Vault panel to unlock.", "success");
        if ($("sv-passphrase")) $("sv-passphrase").value = "";
        if ($("sv-passphrase-confirm")) $("sv-passphrase-confirm").value = "";
        await fetchVaultStatus();
      } catch (e) {
        showToast("Vault setup failed: " + e.message, "error");
      } finally {
        svSetupBtn.disabled = false;
      }
    };
    svSetupBtn.addEventListener("click", doInit);
    [$("sv-passphrase"), $("sv-passphrase-confirm")].forEach(el => {
      if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") doInit(); });
    });
  }

  // ---- Open Vault → ----
  const svOpenBtn = $("sv-open-btn");
  if (svOpenBtn && !svOpenBtn.__tliWired) {
    svOpenBtn.__tliWired = true;
    svOpenBtn.addEventListener("click", () => {
      if (typeof switchPanel === "function") switchPanel("panel-vault");
    });
  }

  // ---- Export backup ----
  const svExportBtn = $("sv-export-btn");
  if (svExportBtn && !svExportBtn.__tliWired) {
    svExportBtn.__tliWired = true;
    svExportBtn.addEventListener("click", () => {
      window.location.href = "/vault/export_backup";
    });
  }

  // ---- Hard reset ----
  const svResetConfirm  = $("sv-reset-confirm");
  const svResetPassword = $("sv-reset-password");
  const svResetBtn      = $("sv-reset-btn");
  if (svResetConfirm && svResetBtn && !svResetBtn.__tliWired) {
    svResetBtn.__tliWired = true;
    const _checkReady = () => {
      svResetBtn.disabled =
        svResetConfirm.value !== "RESET VAULT" ||
        !(svResetPassword?.value?.trim());
    };
    svResetConfirm.addEventListener("input", _checkReady);
    svResetPassword?.addEventListener("input", _checkReady);

    svResetBtn.addEventListener("click", async () => {
      if (svResetConfirm.value !== "RESET VAULT") return;
      const password = svResetPassword?.value?.trim() || "";
      if (!password) { showToast("Enter your current vault passphrase.", "error"); return; }
      const confirmed = confirm(
        "PERMANENT DATA DESTRUCTION\n\n" +
        "This will delete ALL encrypted vault files — files, secrets, and notes.\n\n" +
        "This cannot be undone. There is no recovery.\n\nClick OK only if you are certain."
      );
      if (!confirmed) return;
      svResetBtn.disabled = true;
      svResetBtn.textContent = "Resetting…";
      try {
        const res = await fetch("/vault/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "RESET VAULT", password }),
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || "HTTP " + res.status); }
        svResetConfirm.value = "";
        if (svResetPassword) svResetPassword.value = "";
        showToast("Vault reset. You can now set a new passphrase.", "success");
        await fetchVaultStatus();
      } catch (e) {
        showToast("Reset failed: " + e.message, "error");
      } finally {
        svResetBtn.disabled = false;
        svResetBtn.textContent = "Destroy & Reset";
      }
    });
  }
}

function setupVaultPanel() {
  // ---- Unlock ----
  const unlockBtn = $("vault-unlock-btn");
  if (unlockBtn) {
    unlockBtn.addEventListener("click", () => {
      const pw = $("vault-password").value.trim();
      if (pw) _vaultUnlock(pw);
    });
  }
  const pwInput = $("vault-password");
  if (pwInput) {
    pwInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const pw = pwInput.value.trim();
        if (pw) _vaultUnlock(pw);
      }
    });
  }

  // ---- Lock ----
  const lockBtn = $("vault-lock-btn");
  if (lockBtn) {
    lockBtn.addEventListener("click", async () => {
      try { await fetch("/vault/lock", { method: "POST" }); } catch {}
      // Clear all vault content areas
      const list = $("vault-files-list");
      if (list) list.innerHTML = "";
      const sl = $("vault-secrets-list");
      if (sl) sl.innerHTML = "";
      const nl = $("vault-notes-list");
      if (nl) nl.innerHTML = "";
      const editor = $("vault-note-editor");
      if (editor) editor.classList.add("hidden");
      const empty = $("vault-note-empty");
      if (empty) empty.classList.remove("hidden");
      _vaultNoteActiveId = null;
      await fetchVaultStatus();
    });
  }

  // ---- Tab bar ----
  document.querySelectorAll(".vault-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".vault-tab").forEach(t => t.classList.remove("is-active"));
      document.querySelectorAll(".vault-tab-pane").forEach(p => p.classList.add("hidden"));
      tab.classList.add("is-active");
      const target = tab.dataset.vaultTab;
      const pane = $("vault-tab-" + target);
      if (pane) pane.classList.remove("hidden");
    });
  });

  // ---- File upload ----
  const fileInput = $("vault-file-input");
  const chosenName = $("vault-chosen-filename");
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      if (chosenName) chosenName.textContent = fileInput.files.length ? fileInput.files[0].name : "No file chosen";
    });
  }
  const uploadBtn = $("vault-upload-btn");
  const msgEl = $("vault-message");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      if (!fileInput || !fileInput.files.length) { showToast("Choose a file first."); return; }
      const file = fileInput.files[0];
      const form = new FormData();
      form.append("file", file);
      if (msgEl) msgEl.textContent = "Uploading…";
      try {
        const res = await fetch("/vault/upload", { method: "POST", body: form });
        if (!res.ok) { const txt = await res.text(); throw new Error("HTTP " + res.status + " · " + txt); }
        if (msgEl) msgEl.textContent = "Uploaded.";
        if (chosenName) chosenName.textContent = "No file chosen";
        fileInput.value = "";
        await refreshVaultFiles();
      } catch (err) {
        if (msgEl) msgEl.textContent = "Upload failed: " + err.message;
      }
    });
  }

  // ---- Forgot passphrase toggle ----
  const forgotBtn   = $("vault-forgot-btn");
  const resetPanel  = $("vault-reset-panel");
  if (forgotBtn && resetPanel) {
    forgotBtn.addEventListener("click", () => {
      resetPanel.classList.toggle("hidden");
    });
  }

  // ---- Export encrypted backup ----
  const exportBtn = $("vault-export-backup-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      window.location.href = "/vault/export_backup";
    });
  }

  // ---- Hard reset confirmation input ----
  const resetConfirmInput  = $("vault-reset-confirm-input");
  const resetPasswordInput = $("vault-reset-password-input");
  const hardResetBtn       = $("vault-hard-reset-btn");
  if (resetConfirmInput && hardResetBtn) {
    const _checkResetReady = () => {
      hardResetBtn.disabled =
        resetConfirmInput.value !== "RESET VAULT" ||
        !(resetPasswordInput?.value?.trim());
    };
    resetConfirmInput.addEventListener("input", _checkResetReady);
    resetPasswordInput?.addEventListener("input", _checkResetReady);

    hardResetBtn.addEventListener("click", async () => {
      if (resetConfirmInput.value !== "RESET VAULT") return;
      const password = resetPasswordInput?.value?.trim() || "";
      if (!password) { showToast("Enter your vault passphrase to confirm the reset."); return; }

      // Final explicit warning before irreversible action
      const confirmed = confirm(
        "PERMANENT DATA DESTRUCTION\n\n" +
        "This will delete ALL encrypted vault files — files, secrets, and notes.\n\n" +
        "This cannot be undone. There is no recovery.\n\n" +
        "Click OK only if you are certain."
      );
      if (!confirmed) return;

      hardResetBtn.disabled = true;
      hardResetBtn.textContent = "Resetting…";
      try {
        const res = await fetch("/vault/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "RESET VAULT", password })
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.detail || "HTTP " + res.status);
        }
        resetConfirmInput.value = "";
        if (resetPasswordInput) resetPasswordInput.value = "";
        if (resetPanel) resetPanel.classList.add("hidden");
        const forgotBtnEl = $("vault-forgot-btn");
        if (forgotBtnEl) forgotBtnEl.style.display = "none";
        showToast("Vault reset. You can now set a new passphrase.");
        await fetchVaultStatus();
      } catch (err) {
        hardResetBtn.disabled = false;
        hardResetBtn.textContent = "Destroy & Reset";
        showToast("Reset failed: " + err.message);
      }
    });
  }

  // ---- Add secret ----
  const secretAddBtn = $("vault-secret-add-btn");
  if (secretAddBtn) {
    const doAddSecret = async () => {
      const keyEl = $("vault-secret-key-input");
      const valEl = $("vault-secret-val-input");
      const key = keyEl ? keyEl.value.trim() : "";
      const val = valEl ? valEl.value : "";
      if (!key) { showToast("Enter a key name."); return; }
      try {
        const res = await fetch(`/vault/secret/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: val })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        if (keyEl) keyEl.value = "";
        if (valEl) valEl.value = "";
        await refreshVaultSecrets();
      } catch (err) {
        showToast("Could not save secret: " + err.message);
      }
    };
    secretAddBtn.addEventListener("click", doAddSecret);
    const valInput = $("vault-secret-val-input");
    if (valInput) valInput.addEventListener("keydown", e => { if (e.key === "Enter") doAddSecret(); });
  }

  // ---- New note ----
  const newNoteBtn = $("vault-newnote-btn");
  if (newNoteBtn) newNoteBtn.addEventListener("click", _vaultOpenNewNote);

  // ---- Save note ----
  const noteSaveBtn = $("vault-note-save-btn");
  if (noteSaveBtn) {
    noteSaveBtn.addEventListener("click", async () => {
      const titleInput = $("vault-note-title-input");
      const body       = $("vault-note-body");
      const status     = $("vault-note-status");
      const title = titleInput ? titleInput.value.trim() : "";
      const content = body ? body.value : "";
      if (!title) { showToast("Note needs a title."); return; }
      if (status) status.textContent = "Saving…";
      try {
        const res = await fetch("/vault/note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (status) status.textContent = "Saved.";
        _vaultNoteActiveId = data.id;
        await refreshVaultNotes();
        setTimeout(() => { if (status) status.textContent = ""; }, 2000);
      } catch (err) {
        if (status) status.textContent = "Save failed";
        showToast("Could not save note: " + err.message);
      }
    });
  }

  // ---- Delete note ----
  const noteDeleteBtn = $("vault-note-delete-btn");
  if (noteDeleteBtn) {
    noteDeleteBtn.addEventListener("click", async () => {
      const editor = $("vault-note-editor");
      const noteId = editor ? editor.dataset.noteId : "";
      if (!noteId) {
        // New unsaved note — just close editor
        editor.classList.add("hidden");
        const empty = $("vault-note-empty");
        if (empty) empty.classList.remove("hidden");
        return;
      }
      if (!confirm("Delete this note? This cannot be undone.")) return;
      try {
        await fetch(`/vault/note/${encodeURIComponent(noteId)}`, { method: "DELETE" });
        _vaultNoteActiveId = null;
        editor.classList.add("hidden");
        const empty = $("vault-note-empty");
        if (empty) empty.classList.remove("hidden");
        await refreshVaultNotes();
      } catch (err) {
        showToast("Could not delete note: " + err.message);
      }
    });
  }
}

