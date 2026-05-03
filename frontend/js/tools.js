// ---------- tools panel ----------
async function refreshToolsList() {
  const select = $("tools-select");
  if (!select) return;
  try {
    const res = await fetch("/tools/list");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const tools = data.tools || [];
    select.innerHTML = "";
    if (!tools.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "No tools registered";
      select.appendChild(opt);
      return;
    }
    const placeholder = document.createElement("option");
    placeholder.value = ""; placeholder.textContent = "Select a tool…";
    select.appendChild(placeholder);
    tools.forEach(tool => {
      const opt = document.createElement("option");
      opt.value = tool.id; opt.textContent = tool.label || tool.id;
      select.appendChild(opt);
    });
    debugLog("info", "GET /tools/list OK, tools=" + tools.length);
  } catch (err) {
    select.innerHTML = '<option value="">Error loading tools</option>';
    debugLog("error", "GET /tools/list failed: " + err.message);
  }
}

// NEW: ask /chat to interpret a tool's raw output for humans
async function explainToolOutput(toolLabel, rawOutput) {
  const summaryBox = $("tools-explain-box");
  if (!summaryBox) return;

  // Show interim status
  summaryBox.textContent = "Asking your LAN AI to interpret this tool’s output…";

  try {
    // MIGRATE TO: /api/ai/chat  (chat_routes.py /chat is legacy — see deprecation header)
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: currentDeviceId || "dev-browser",
        brain: "auto",
        mode: "default",
        teaching_mode: true,
        temperature: 0.3,
        max_tokens: 320,
        message:
          `A local diagnostic tool called "${toolLabel}" just ran and produced the following output:\n\n` +
          rawOutput +
          `\n\nExplain, in 3–6 short bullet points, what this result means in simple language for a non-technical user. ` +
          `Mention if everything looks healthy or if there are any obvious issues. Do NOT repeat the whole JSON.`
      })
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const reply = data.reply || data.answer || "";
    summaryBox.textContent = reply || "Could not interpret the output.";
    debugLog("info", "POST /chat (tool explain) OK");
  } catch (err) {
    summaryBox.textContent =
      "Couldn't interpret the output via local model: " + err.message;
    debugLog("error", "POST /chat (tool explain) failed: " + err.message);
  }
}

function setupToolsPanel() {
  const runBtn = $("tools-run-btn");
  if (!runBtn) return;

  // Set default explainer text
  const summaryBox = $("tools-explain-box");
  if (summaryBox) {
    summaryBox.textContent =
      "Run a tool to see a short explanation of the results here. The JSON below is the raw output for advanced users.";
  }

  runBtn.addEventListener("click", async () => {
    const id = $("tools-select").value;
    if (!id) return;
    const paramsText = $("tools-params").value.trim();
    let params = {};
    if (paramsText) {
      try { params = JSON.parse(paramsText); }
      catch { params = { raw: paramsText }; }
    }

    const outputCard = $("tools-output");
    const pre = outputCard ? outputCard.querySelector("pre") : null;
    const summaryBoxLocal = $("tools-explain-box");

    if (pre) pre.textContent = "Running tool…";
    if (summaryBoxLocal) {
      summaryBoxLocal.textContent = "Running tool and preparing a plain-language summary…";
    }

    // Grab the human-friendly label for the tool, if available
    const selectEl = $("tools-select");
    let toolLabel = id;
    if (selectEl && selectEl.selectedIndex >= 0) {
      const opt = selectEl.options[selectEl.selectedIndex];
      if (opt && opt.textContent) toolLabel = opt.textContent;
    }

    debugLog("info", "POST /tools/run tool_id=" + id);

    try {
      const res = await fetch("/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_id: id, params })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      const outputText = data.output || JSON.stringify(data, null, 2);
      if (pre) pre.textContent = outputText;

      debugLog("info", "POST /tools/run OK for " + id);

      // Now ask /chat to interpret the result
      await explainToolOutput(toolLabel, outputText);
    } catch (err) {
      if (pre) pre.textContent = "Error: " + err.message;
      if (summaryBoxLocal) {
        summaryBoxLocal.textContent = "The tool failed to run, so there is nothing to interpret.";
      }
      debugLog("error", "POST /tools/run failed: " + err.message);
    }
  });
}

// ---------- scripts presets powered by Files panel ----------

// Build a summary of whatever the Files panel last scanned,
// so the Scripts panel can reference it in backup prompts.
function getFilesContextForScripts() {
  const root = ($("filesRootInput")?.value || "").trim();
  const ctx = {
    root,
    totalFiles: 0,
    bucketNames: [],
    docBuckets: [],
    mediaBuckets: [],
    summaryText: ""
  };

  if (!filesLastScanBuckets || !filesLastScanBuckets.buckets) {
    ctx.summaryText =
      root
        ? `TLI previously scanned "${root}", but no structured bucket data is available.`
        : `No recent File Organizer scan is available yet.`;
    return ctx;
  }

  const buckets = filesLastScanBuckets.buckets || {};
  const names = Object.keys(buckets);
  ctx.bucketNames = names;

  let total = 0;
  names.forEach(name => {
    const files = buckets[name] || [];
    total += files.length;

    const lower = (name || "").toLowerCase();
    if (/(doc|pdf|office|word|text|docs)/.test(lower)) {
      ctx.docBuckets.push(name);
    }
    if (/(photo|image|picture|media|video|audio|music|jpg|jpeg|png|mp4|mov|wav|mp3)/.test(lower)) {
      ctx.mediaBuckets.push(name);
    }
  });
  ctx.totalFiles = total;

  const topBuckets = names.slice(0, 5).join(", ") || "no named buckets";
  ctx.summaryText =
    `TLI's File Organizer last scanned "${root || "(no path specified)"}" ` +
    `and grouped about ${total} files into buckets like: ${topBuckets}.`;

  return ctx;
}

// Build a natural-language prompt for the Scripts playground
// so it can ask the local model to write backup scripts.
function buildBackupScriptPrompt(kind) {
  const ctx = getFilesContextForScripts();

  const rootText = ctx.root || "the main working folder";
  const baseIntro =
    "You are my local automation assistant that writes real-world backup scripts " +
    "for Windows or Linux. Use robust, production-ready patterns (logging, error handling, " +
    "and safety checks) but keep the script readable.";

  const fileContextParagraph =
    ctx.summaryText +
    " Use this context purely as a hint about the kinds of files and folders involved.";

  if (kind === "folder") {
    return (
      `${baseIntro}\n\n` +
      `Write a PowerShell script that backs up the folder "${rootText}" to a user-configurable ` +
      `backup destination. Requirements:\n` +
      `- Preserve the folder structure.\n` +
      `- Only copy new or changed files (incremental style).\n` +
      `- Create a timestamped subfolder for each backup.\n` +
      `- Log what was copied and any errors to a .log file.\n` +
      `- Include clear comments so a non-expert can adjust source/target paths.\n\n` +
      fileContextParagraph
    );
  }

  if (kind === "docs") {
    const docHint =
      ctx.docBuckets.length
        ? `These buckets look document-heavy: ${ctx.docBuckets.join(", ")}.`
        : "Assume typical office documents like .docx, .xlsx, .pptx, and .pdf.";

    return (
      `${baseIntro}\n\n` +
      `Write a PowerShell script that finds and backs up important documents under "${rootText}".\n` +
      `Requirements:\n` +
      `- Target office-style files (.docx, .xlsx, .pptx, .pdf, .txt) recursively.\n` +
      `- Copy them into a "DocumentsBackup" folder under a user-chosen backup root.\n` +
      `- Use a timestamped subfolder so older backups are preserved.\n` +
      `- Skip temporary / cache folders if possible.\n` +
      `- Log a short summary of how many files were backed up.\n\n` +
      `${docHint}\n\n` +
      fileContextParagraph
    );
  }

  if (kind === "media") {
    const mediaHint =
      ctx.mediaBuckets.length
        ? `These buckets look media-heavy: ${ctx.mediaBuckets.join(", ")}.`
        : "Assume common photo/video/audio formats like .jpg, .png, .mp4, .mov, .wav, .mp3.";

    return (
      `${baseIntro}\n\n` +
      `Write a PowerShell script that backs up photos, videos, and audio files from "${rootText}".\n` +
      `Requirements:\n` +
      `- Target common media extensions (jpg, jpeg, png, gif, mp4, mov, wav, mp3, flac, etc.).\n` +
      `- Organize the backup into separate subfolders for Photos, Video, and Audio.\n` +
      `- Avoid duplicating files that already exist at the destination (compare name+size or hash).\n` +
      `- Generate a summary report at the end listing how many media files were copied or skipped.\n\n` +
      `${mediaHint}\n\n` +
      fileContextParagraph
    );
  }

  // Fallback generic backup suggestion
  return (
    `${baseIntro}\n\n` +
    `Write a PowerShell script that performs a safe backup of "${rootText}" with incremental ` +
    `behavior, timestamped backup folders, and a human-readable log file.\n\n` +
    fileContextParagraph
  );
}

// ---------- scripts panel ----------
function setupScriptsPanel() {
  if (setupScriptsPanel._done) return;
  setupScriptsPanel._done = true;
  const btn       = $("scripts-generate-btn");
  const promptBox = $("scripts-prompt");
  if (!btn || !promptBox) return;

  // Preset buttons that talk to the Files panel context
  const fullBackupBtn = $("scripts-preset-backup-folder");
  const docsBackupBtn = $("scripts-preset-backup-docs");
  const mediaBackupBtn = $("scripts-preset-backup-media");

  function applyPresetPrompt(text) {
    if (!text) return;
    promptBox.value = text;
    promptBox.focus();
    // Put cursor at end so you can tweak the prompt
    promptBox.selectionStart = promptBox.selectionEnd = promptBox.value.length;
  }

  if (fullBackupBtn) {
    fullBackupBtn.addEventListener("click", () => {
      const prompt = buildBackupScriptPrompt("folder");
      applyPresetPrompt(prompt);
    });
  }

  if (docsBackupBtn) {
    docsBackupBtn.addEventListener("click", () => {
      const prompt = buildBackupScriptPrompt("docs");
      applyPresetPrompt(prompt);
    });
  }

  if (mediaBackupBtn) {
    mediaBackupBtn.addEventListener("click", () => {
      const prompt = buildBackupScriptPrompt("media");
      applyPresetPrompt(prompt);
    });
  }

  // ── Danger scanner ───────────────────────────────────────────
  function _scanScriptDanger(code) {
    const flags = [];
    const c = code.toLowerCase();

    const checks = [
      // Deletion / wipe
      { re: /remove-item.{0,60}-recurse.{0,30}-force|rm\s+-rf|del\s+\/[fsq]/i,        msg: "Recursive force-delete detected — verify the target path carefully before running." },
      { re: /format-volume|format\s+[a-z]:|diskpart/i,                                  msg: "Drive formatting command detected — this will permanently erase a drive." },
      { re: /clear-disk|initialize-disk/i,                                               msg: "Disk initialisation detected — all data on the target will be lost." },
      // Registry
      { re: /reg\s+delete|remove-itemproperty|remove-item.{0,60}hk[lcu][mr]/i,          msg: "Registry deletion detected — incorrect registry changes can break Windows." },
      { re: /reg\s+add|set-itemproperty.{0,80}hk[lcu][mr]/i,                            msg: "Registry modification detected — review the key and value before running." },
      // System paths
      { re: /c:\\windows\\system32|%systemroot%|%windir%/i,                              msg: "System32/Windows directory targeted — modifying system files can destabilise the OS." },
      // Execution policy / code injection
      { re: /set-executionpolicy\s+unrestricted|bypass/i,                                msg: "Execution policy bypass — only use this intentionally and revert it after." },
      { re: /invoke-expression|iex\s*\(|\[scriptblock\]::create/i,                       msg: "Dynamic code execution (iex/Invoke-Expression) — review carefully for injection risk." },
      // Network downloads
      { re: /invoke-webrequest|iwr\s|wget\s|curl\s.{0,60}https?:/i,                     msg: "Network download detected — verify the source URL before running." },
      { re: /downloadstring|downloadfile|net\.webclient/i,                               msg: "Web download via .NET — confirm the URL is trusted." },
      // User / privilege management
      { re: /net\s+user\s+.{0,40}\/add|add-localuser|new-localuser/i,                   msg: "User account creation detected — review permissions being granted." },
      { re: /net\s+localgroup\s+administrators|add-localgroupmember.{0,40}administrator/i, msg: "Admin group modification — this grants full system privileges." },
      // Shutdown / restart
      { re: /stop-computer|restart-computer|shutdown\s+\/[rsf]/i,                        msg: "System shutdown or restart command present — make sure this is intentional." },
      // Process termination
      { re: /stop-process\s+-name\s+\*|get-process\s*\|\s*stop-process|taskkill\s+\/f\s+\/im\s+\*/i, msg: "Bulk process termination detected — this will kill running applications." },
      // Firewall / network config
      { re: /netsh\s+(advfirewall|firewall)\s+(set|add|delete)/i,                        msg: "Firewall rule modification — review the rule before applying." },
      // Credential exposure
      { re: /convertto-securestring.{0,60}-asplaintext|-password\s+['\"][^'"]{4}/i,      msg: "Plaintext password in script — consider using a Vault reference instead." },
    ];

    for (const { re, msg } of checks) {
      if (re.test(code)) flags.push(msg);
    }

    return flags;
  }

  function _showScriptWarning(flags, outputEl) {
    const existing = document.getElementById("scripts-danger-banner");
    if (existing) existing.remove();
    if (!flags.length) return;

    const banner = document.createElement("div");
    banner.id = "scripts-danger-banner";
    banner.style.cssText = `
      margin-bottom: 10px; padding: 12px 14px;
      background: rgba(239,68,68,0.08); border: 1.5px solid #ef4444;
      border-radius: var(--radius-md); font-size: 13px;
    `;
    const isCritical = flags.some(f => /format|wipe|erase|system32|admin|bulk process/i.test(f));
    banner.innerHTML =
      `<div style="font-weight:700; color:#ef4444; margin-bottom:6px;">` +
      (isCritical ? "⛔ HIGH RISK — Read before running" : "⚠️ Review before running") +
      `</div>` +
      `<ul style="margin:0; padding-left:18px; color:var(--text-main); line-height:1.7;">` +
      flags.map(f => `<li>${f}</li>`).join("") +
      `</ul>` +
      `<div style="margin-top:8px; font-size:12px; color:var(--text-muted);">` +
      `TLI never runs scripts automatically. Copy only after you understand every line.` +
      `</div>`;

    outputEl.parentNode.insertBefore(banner, outputEl);
  }

  // ── Safe system prompt ───────────────────────────────────────
  const SCRIPTS_SYSTEM_PROMPT = [
    "You are a careful, safety-conscious script writer for a local home server tool called TLI.",
    "Rules you MUST follow:",
    "1. Output only the script — no prose before or after it.",
    "2. For ANY destructive operation (delete, overwrite, format, stop service), add a -WhatIf dry-run",
    "   flag or a confirmation prompt BEFORE the real operation, with a clear comment explaining the risk.",
    "3. Wrap all file/registry/system operations in try/catch (PowerShell) or set -e / trap (Bash).",
    "4. Add a short comment above each logical block explaining what it does in plain English.",
    "5. Never use -Force on recursive deletions without a visible warning comment.",
    "6. Never hardcode credentials — add a comment to use a Vault reference or prompt for input.",
    "7. Prefer -WhatIf, -Confirm, or dry-run modes by default; let the user remove them to go live.",
    "8. If the request could cause irreversible data loss, output a dry-run version first and note it.",
  ].join("\n");

  // Generate — bundled AI streaming with LM Studio fallback
  btn.addEventListener("click", async () => {
    const prompt = promptBox.value.trim();
    if (!prompt) return;

    const outputEl = $("scripts-output");
    outputEl.value = "";
    const existing = document.getElementById("scripts-danger-banner");
    if (existing) existing.remove();

    btn.disabled = true;
    btn.textContent = "Generating…";

    let streamed = false;
    let accumulated = "";

    // 1) Try bundled AI (streaming)
    try {
      await tliBundledChatStream({
        message: SCRIPTS_SYSTEM_PROMPT + "\n\nScript request:\n" + prompt,
        max_tokens: 1200,
        temperature: 0.1,
        onDelta: (chunk) => {
          accumulated += chunk;
          outputEl.value = accumulated;
          outputEl.scrollTop = outputEl.scrollHeight;
        },
      });
      streamed = true;
      debugLog("info", "Scripts: bundled AI stream OK");
    } catch (e) {
      debugLog("warn", "Scripts: bundled stream failed, trying /chat: " + e.message);
    }

    // 2) Fallback: /chat
    if (!streamed) {
      try {
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id: currentDeviceId || "dev-browser",
            message: SCRIPTS_SYSTEM_PROMPT + "\n\nScript request:\n" + prompt,
            brain: "auto",
            mode: "dev",
          })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        accumulated = data.reply || data.answer || "";
        outputEl.value = accumulated;
        debugLog("info", "Scripts: /chat fallback OK");
      } catch (err) {
        outputEl.value = "# Error: " + err.message;
        debugLog("error", "Scripts: all AI routes failed: " + err.message);
      }
    }

    // Danger scan — runs regardless of which AI path was used
    if (accumulated && accumulated.trim() && !accumulated.startsWith("# Error")) {
      const flags = _scanScriptDanger(accumulated);
      if (flags.length) _showScriptWarning(flags, outputEl);
    }

    btn.disabled = false;
    btn.textContent = "Ask AI for script";
  });
}

// ---------- USB / Devices panel ----------

// Decide if a device looks like storage and extract its mount path (if any)
function getUsbStorageInfo(dev) {
  const name = (dev.name || dev.product || dev.description || "").toLowerCase();
  const cls  = (dev.device_class || dev.type || "").toLowerCase();

  const isMassStorage =
    !!dev.is_storage ||
    name.includes("mass storage") ||
    name.includes("external") ||
    cls.includes("storage");

  const mountPath =
    dev.mount_path ||
    dev.mount ||
    dev.drive_letter ||
    dev.drive ||
    "";

  return { isMassStorage, mountPath };
}

