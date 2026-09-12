# TLI Builder — Actual Spec (Corrected Vision)

> This document replaces the original `N:\TLI_Builder_Local_First_Coding_Agent_Spec.md`.
> It reflects what was actually built and why several pieces of the original spec
> were misleading or out of scope.

---

## 1. What TLI Builder is

A focused, offline coding agent inside TLI. The user describes a change in
plain language. A local model (bundled Qwen by default, LM Studio as a
fallback) **suggests** a diff. TLI's deterministic patch engine **validates,
snapshots, and applies** that diff — only after explicit approval.

The model never writes to disk. It emits structured JSON edits. The engine
checks the find-text exists, hashes the result, and refuses to apply if
anything has drifted since the preview.

## 2. Core principle

> **AI suggests. TLI's deterministic engine executes.**

That sentence from the original spec is correct and remains the spine of the
implementation.

## 3. The one loop

There is one user-facing loop. The UI exists to make it observable and
approvable.

```
User describes a change
        │
        ▼
Explorer agent   — ranks relevant files (deterministic keyword retrieval)
        │
        ▼
Planner agent    — summary, strategy, risk, files involved (deterministic)
        │
        ▼
Patch agent      — local model (Qwen via bundled llama.cpp, or LM Studio)
                   emits {edits: [{file_path, find, replace, replace_all}]}
                   each edit validated against current file content
        │
        ▼
[ HALT — user approves the diff ]
        │
        ▼
Apply engine     — snapshot, hash-verified write, snapshot.id returned
        │
        ▼
Test agent       — only runs commands the user explicitly approved
        │
        ▼
Reviewer agent   — rule-based regression checks
        │
        ▼
Receipt agent    — final summary, audit row
```

Stages are **lifecycle phases of one task**, not tabs the user picks between.
This was the single biggest misread in the original spec — see §11.

## 4. Backends

Probed in this order on every patch agent call:

1. **Bundled runtime** — `BundledAIManager` in `backend/ai/ai_manager.py`,
   serves Qwen 2.5 1.5B / 3B / 7B / VL via llama.cpp on
   `http://127.0.0.1:8089/v1/chat/completions`. Default install ships
   Qwen 2.5 3B Standard.
2. **LM Studio** — `LMStudioProvider` in `backend/providers/lmstudio.py`,
   any OpenAI-compatible local server. Used when the bundled runtime is
   unavailable.
3. **Offline** — Builder blocks the patch agent with a clear error in the
   task card. Nothing crashes; the user can retry once a model is up.

`/api/builder/backend-status` returns the live backend so the header pill
shows which model is actually answering.

## 5. UI shape

One screen, three regions:

```
┌─ Header ───────────────────────────────────────────────────────────┐
│ TLI Builder                [project picker ▾]   ● Qwen 3B · bundled│
└────────────────────────────────────────────────────────────────────┘

┌─ Hero composer ────────────────────────────────────────────────────┐
│  Describe a change in plain language...                            │
│  [ Start build ]  [ Plan only ]  [ Inspect ]   try: …              │
└────────────────────────────────────────────────────────────────────┘

┌─ Stream of build cards ────────────────────────────────────────────┐
│  Each task is one card with: status chip · task text · age         │
│  Body: agent step list, model summary, inline diff, skipped edits  │
│  Actions: Approve & apply / Regenerate / Discard / Rollback        │
└────────────────────────────────────────────────────────────────────┘

▸ Developer tools (manual find/replace, command runner, snapshot browser)
```

### Behaviors

- **Autoplay through Patch.** Clicking *Start build* runs explorer → planner
  → patch automatically. The card halts at the diff for human approval.
  After approval, test → reviewer → receipt run automatically.
- **Plan only / Inspect** stop earlier in the same pipeline (after planner
  or explorer respectively) and require no approval — they don't touch
  files.
- **Regenerate** is per-card. It cancels the old task and starts a fresh
  one with edited prompt text. The hero composer is also still available
  for any new task.
- **Backend pill** polls `/api/builder/backend-status` every 15 seconds
  and on every panel open.
- **Status chips** map to lifecycle phase:
  - `running` — an agent step is in flight
  - `awaiting` — patch produced a diff, paused for approval
  - `applied` — patch applied, snapshot saved, rollback available
  - `blocked` / `cancelled` / `completed` — terminal states
- **No tabs**, no three-column shell. Old workbench survives only as
  `<details class="builder-advanced">` at the bottom for power users.

## 6. Safety guarantees

These are enforced in the backend, independent of any UI choice:

- **Hash verification.** Every proposed edit stores SHA-256 of the pre-image
  and the post-image. Apply refuses if either has changed since preview.
- **Snapshot before write.** Every apply produces
  `.backups/tli-builder/<timestamp>-<slug>/original_files/...` with a
  `manifest.json`, `patch.diff`, and `receipt.md`. Rollback is always
  available.
- **Project root containment.** No edit can resolve outside the selected
  project root.
- **Protected paths.** `.env*`, `secrets.json`, `credentials.json`,
  `*_secret`, `*_credentials`, `*.key`, `*.pem`, etc. are blocked at
  every write path. Source files with words like "auth" or "vault" in
  their names are *not* falsely blocked.
- **Permission levels.** `locked` rejects apply and run-command entirely.
  `ask` (default) requires explicit `approved=true` on every write. `trusted`
  is the same with friendlier UI copy.
- **Command runner.** Substring blocklist on dangerous commands (`rm -rf`,
  `git reset --hard`, `format`, `diskpart`, etc.); network commands require
  `allow_network=true`. Shell injection is possible via shell=True — this is
  a local-user tool, but operators should understand that.

## 7. API surface

Stable routes:

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/builder/status` | Selected project, permission level, last patch state |
| GET  | `/api/builder/backend-status` | Live local AI backend probe |
| POST | `/api/builder/select-project` | Open and index a folder |
| POST | `/api/builder/create-project` | Create + open a blank/python/web template |
| GET  | `/api/builder/project-map` | Cached or refreshed project map |
| POST | `/api/builder/analyze` | Read-only Q&A over the project map |
| POST | `/api/builder/plan` | Deterministic plan (summary/risk/files) |
| POST | `/api/builder/generate-diff` | Manual find/replace → proposal (developer tool) |
| POST | `/api/builder/apply-patch` | Apply approved proposal (requires `approved=true`) |
| POST | `/api/builder/rollback` | Restore from a snapshot (requires `approved=true`) |
| POST | `/api/builder/run-command` | Execute approved command (requires `approved=true`) |
| GET  | `/api/builder/tasks` | List tasks (used by the stream) |
| POST | `/api/builder/tasks` | Create a task |
| POST | `/api/builder/tasks/{id}/advance` | Run the next agent step |
| POST | `/api/builder/tasks/{id}/status` | Pause or cancel a task |
| GET  | `/api/builder/snapshots` | Snapshot browser |
| GET  | `/api/builder/receipts` | Audit log |
| GET  | `/api/builder/patch-proposals` | Recent proposals (audit) |
| POST | `/api/builder/classify-command` | Pre-check a command without running it |

## 8. File layout

```
backend/
  routers/
    builder.py                 — API router; thin glue over backend/builder/
  builder/
    __init__.py
    safety.py                  — protected paths, dangerous commands, root containment
    project_indexer.py         — file scan, language detection, framework hints
    project_creator.py         — blank / python / web templates
    retrieval.py               — deterministic keyword + alias ranking
    planner.py                 — plan synthesis, file excerpts for the LLM
    diff_generator.py          — find/replace → unified diff + sha256
    patch_engine.py            — hash-verified apply
    snapshots.py               — backup, list, rollback
    command_runner.py          — subprocess.run with classification + timeout
    receipts.py                — JSON audit log
    tasks.py                   — explorer/planner/patch/test/reviewer/receipt
    llm_client.py              — bundled → lmstudio backend selection + JSON parsing
    prompts/
      patch.txt                — strict-JSON system prompt
  ai/
    ai_manager.py              — bundled llama.cpp runtime lifecycle (Qwen presets)
  providers/
    lmstudio.py                — OpenAI-compatible LM Studio wrapper

frontend/
  index.html                   — panel-builder section (single-column shell)
  builder.css                  — uses TLI theme vars, no hardcoded dark overlays
  js/builder.js                — hero composer, autoplay, task cards, backend pill
```

## 9. State files

- `data/tli_builder_state.json` — selected project, permission level, last patch status
- `data/tli_builder_tasks.json` — task queue (rolling 200)
- `data/tli_builder_receipts.json` — audit log
- `data/tli_builder_patch_proposals.json` — recent proposals
- `<project>/.backups/tli-builder/<timestamp>-<slug>/` — per-edit snapshots

## 10. What got dropped vs. the original spec

These items from the original spec were either out of scope, double-duty, or
were UI framings that pushed the previous build off-course. They are
intentionally **not** in the implementation.

| Dropped | Why |
|---|---|
| **Mode tabs** (Analyze / Plan / Patch / Test / Package as parallel surfaces) | These are stages of one task, not modes the user picks between. The previous UI treated them as tabs and got dead space everywhere. |
| **File tree preview** | The user types a task; Builder picks files. A tree adds weight for an action the user doesn't take. |
| **Receipt history as a parallel panel** | A completed task card is its receipt. The JSON receipt log lives in audit storage; the UI doesn't need a second view. |
| **Task Queue side panel** | Stream replaces it. |
| **Artifacts side panel** | Artifacts live inside the task card they belong to. |
| **Quick Prompts chip strip above the composer** | Replaced by inline `try:` hints below the composer, clearly secondary. |
| **Model selector** (Local Qwen / LM Studio / LAN AI) | Don't ask the user; backend probes in order. Pill shows which one answered. |
| **Golden Build Guard post-patch verification** (smoke-test Overview / Devices / Visualizer / AI status after every edit) | Out of scope — Builder shouldn't run a regression suite of TLI's own panels after every patch. Kept the boolean flag, dropped the ceremony. |
| **Downloadable patch ZIP** | Out of scope. Builder writes locally. ZIP export is a different feature. |
| **Compare folder to golden build** | Separate feature, not part of the coding loop. |
| **"Turn RackScan into a TLI module"** as the design target | Multi-file scaffolding is the ambitious edge case, not the common one. Designing for it produced an over-broad UI. |
| **Phase 1–5 as separately accessible UI surfaces** | All phases ship together. UI is one flow. |
| **`auth`/`secret`/`stripe` as substring protected fragments** | Over-broad — falsely blocked `auth_routes.py`, `vault_routes.py`, `secrets-panel.js`. Replaced with exact-name and prefix/suffix rules so real config files (`.env*`, `secrets.json`, `*_credentials`) are blocked but normal source isn't. |
| **Subagents as separate models** | Same model, different prompts/workflows. Already the case. |
| **Static "Local Builder" pill** | Replaced with live backend signal. |

## 11. What the original spec got right

Re-emphasized so it's clear which guarantees are load-bearing:

- *AI suggests. Deterministic engine executes.* — load-bearing.
- Snapshot before every applied patch — load-bearing.
- Rollback always available — load-bearing.
- Project root containment — load-bearing.
- Protected files require explicit confirmation (or block entirely) — load-bearing.
- Receipt for every action — load-bearing.
- Permission levels (Ask / Trusted / Locked) — load-bearing.
- Dangerous command blocklist + network command warning — load-bearing.
- Subagents (Explorer / Planner / Patch / Test / Reviewer / Receipt) as
  prompt workflows on the same model — implemented.

## 12. Known limitations

- **Find/replace patches only.** No unified-diff apply. Multi-hunk edits are
  proposed as multiple separate find/replace edits. This is a deliberate
  tradeoff for safety (every edit is hash-verifiable).
- **No model-driven explorer or planner.** Those stages are deterministic
  keyword retrieval and templated plan synthesis. Only the *patch* step
  uses the LLM. (This is by current design — see the "Patch agent only"
  scope decision. Easy to extend later if needed.)
- **Single-project context.** Tasks reference the currently-open project.
  Switching projects mid-task is supported but isn't an explicit workflow.
- **Step-through inside the developer tools** still requires clicks for the
  manual agent task workbench. The hero composer autoplays — the workbench
  is the escape hatch.
- **Local model quality varies.** Qwen 3B sometimes uses `//` for Python
  comments. The pre-image hash check still protects you. Switch to the 7B
  Power preset if quality matters.
- **`subprocess.run(..., shell=True)`** in command runner can be tricked
  by obfuscated dangerous commands. Approval gate is the real safety net,
  not the substring blocklist.

## 13. Build & run

```bash
# From repo root
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows
pip install -r requirements.txt
python main.py                     # serves http://localhost:8000
```

Open the Builder panel. The header pill should turn green and read
`Qwen2.5 3B (Standard) · bundled` once the bundled runtime is healthy.

### Smoke test

1. Open a project (header → project picker → paste path → Open).
2. Type "Add a comment that says hello at the top of backend/main.py".
3. Click **Start build**.
4. Watch explorer → planner → patch run automatically.
5. Diff appears inline. Click **Approve & apply**.
6. Card shows applied + snapshot id. Verify the file changed.
7. Click **Rollback** to restore.

If the diff looks wrong, click **Regenerate**, edit the prompt, and try
again. No file write happens until you explicitly approve.

---

*Last updated: 2026-05-17. Reflects backend/builder/* and frontend Builder
panel as shipped in v1.3.5-beta.*
