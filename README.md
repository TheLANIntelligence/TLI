# TLI — TheLANIntelligence

TLI is a private, general-purpose AI for conversation, questions, learning,
writing, planning and coding. Start in **Ask TLI** without selecting a device or
computer problem. Connected tools extend that experience with computer help,
files, smart devices and small-app creation.

The host runs a FastAPI backend and serves a browser interface. With a local
model and dependencies installed, conversation can run without internet access.
Your selected AI provider and each integration determine where a request goes;
downloads, internet search and cloud integrations need connectivity. An explicitly
selected, trusted LAN computer can also provide text inference.

**Development status:** TLI is beta software. This README describes the current
source tree; published packages and native Companion builds may contain an
earlier feature set. Check the [release notes and available downloads](https://github.com/TheLANIntelligence/TLI/releases)
for the package you install. Source tests do not establish physical-device,
two-computer, offline or platform acceptance; see the recorded limits in the
[everyday experience guide](docs/TLI_EVERYDAY_EXPERIENCE.md).

## Start here

### Run a source checkout

Use Python 3.10 or newer. A Git clone or GitHub **Source code** archive does not
include a built `TLI.exe`, model weights or a ready-to-use Python environment.
From the repository root, prepare the environment and run the host:

**Windows (PowerShell):**

```powershell
py -3 -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.\backend\.venv\Scripts\python.exe backend\main.py
```

**macOS / Linux:**

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/main.py
```

Open `http://127.0.0.1:8000` in your browser for a fresh installation, or use the
address printed by the server if startup settings were previously saved. Stop
this foreground host with **Ctrl+C**. Configure a model in TLI before asking for
model-generated answers; model weights are a separate download. Bundled inference
also needs a compatible runtime for your platform. LM Studio is another supported
local provider.

### Run a prepared distribution

**Windows, when the package includes `TLI.exe`:** double-click it in the extracted
folder. The TLI app shows startup progress and guides first-time setup, which adds Desktop and Start menu
shortcuts. You can then search Windows for **TLI**. The launcher's **Add Desktop &
Start Menu shortcuts** button can recreate them. It opens
or reuses this installation's verified backend without a command window.
Closing the browser leaves TLI running. Local Setup provides Stop TLI and optional
phone host-start controls. `TLI_Start.bat` remains a command-line fallback, and
`TLI_Diagnostics.bat` provides a visible diagnostic launch. Source users can also
build the Windows launcher with `powershell -File build_launcher.ps1`.

**macOS:** open `TLI_Start.command` from the extracted folder.

**Linux:** run `bash TLI_Start.sh` from the extracted folder.

The script launchers can prepare dependencies and may offer software downloads;
complete setup before using TLI offline. Available runtime and device support
varies by platform.

Startup uses the saved address, port and HTTPS settings. The default is local
access. **Settings → Security & connections** explains secure LAN startup; saving a
change does not restart the running host. Review that setup before connecting
another computer or phone. These launchers do not replace a currently running
older backend automatically.

## Find your task

Home starts with editable task shortcuts, observed status, saved places,
favorite routines and recent activity. **Edit shortcuts** changes only this
browser's Home. **Back to** lists up to three workspaces opened during the visit
and clears on locking or leaving the page.

| Sidebar destination | Start with |
|---|---|
| Home | Choose a task or review an observation. |
| Ask TLI | Chat, learn, write, plan or discuss code; add context when useful. |
| Files | Scan a folder, select files, review their destinations. |
| Free Space | Inspect storage and review exact cleanup candidates. |
| Game Optimizer | Choose a game and goal, analyze hardware, request AI advice. |
| Vault | Open private files, notes and secrets with a separate passphrase. |
| Computers | Check connections, messages and reviewed file transfers. |
| Smart devices | Connect supported devices and review their reported state. |
| Routines | Save and explicitly run a reviewed sequence of device actions. |
| Phone Companion | Pair a compatible native app and manage its access. |
| Printers & scanners | Print, scan and check printer status. |
| USB drives | Open a removable drive in Files or Free Space. |

**Help** holds troubleshooting, saved reports and app performance checks.
**More** holds Installed apps and Advanced tools: Builder, Scripts, Utilities
and package management. Secondary workspaces can be pinned. Search with
**Ctrl+K** / **Cmd+K** using a name, an older name, or a task such as “make room.”
Compact phone browser navigation keeps every destination under **More**.

Related tools offer reviewed next steps: carry a folder into a problem
checklist, prepare a backup-script request, or record a manual game-settings
trial. A prepared draft still needs its own review and Save, Send or Run.
Routines are manual in this release; automatic schedules are not enabled.

**Connected tools** in Ask TLI also opens computer help, smart-home controls and
Builder. Builder creates small HTML/CSS/JavaScript apps with saved revisions and
an isolated browser preview. Review and try generated apps; its smoke checks are
advisory. See the [everyday workflows](docs/TLI_EVERYDAY_EXPERIENCE.md) for the
supported scope and [TLI Node](node/README.md) to set up a separate LAN inference
worker with explicit trust and permissions.

## Start TLI from Companion

The optional **host-start helper** stays available independently of the main
backend. Enable it locally through `TLI_Setup.bat`, then explicitly review and
save its connection in a compatible native Companion build while TLI is online.
It supports status and starting this installation only. The host must be awake,
the helper reachable, and the same Windows user signed in. It does not wake a
sleeping PC or run before Windows sign-in.

See [host setup](docs/HOST_START.md) and [Companion host start](docs/TLI_HOST_START.md).
Native source changes need a separate client build and distribution; updating
the browser does not update an installed phone app.

## Guides and development

- [General AI and connected tools](docs/TLI_EVERYDAY_EXPERIENCE.md)
- [LAN intelligence and model sharing](docs/TLI_LAN_INTELLIGENCE.md)
- [Lightweight inference Node setup](node/README.md)
- [Bundled browser manual](frontend/manual.html)
- [User manual](TLI_MANUAL.md)
- [Smart Hub changes and verification](docs/TLI_SMART_HUB_REFINEMENT.md)
- [Connected workspace workflows](docs/TLI_CONNECTED_WORKFLOWS.md)
- [Navigation and simplification guide](docs/TLI_SIMPLIFICATION_RELEASE.md)
- [Development commands and architecture](AGENTS.md)
- [Contributing and local checks](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)

The frontend is served directly; there is no frontend build step. For backend
tests, install `backend/requirements-test.txt` into the same virtual environment
and run its Python with `-m pytest backend/tests/` from the repository root.
Frontend tests use Node.js: `node --test frontend/tests/*.test.cjs`.

Report reproducible bugs through [GitHub Issues](https://github.com/TheLANIntelligence/TLI/issues),
including the version or commit, operating system, steps and observed result.
Remove tokens, passphrases, private files, addresses and personal conversation
content from reports and attachments.

Saved data belongs to this installation's `data/` directory. Review the scope of
backups in Settings and Vault before moving or removing an installation.
Windows local Setup can remove its optional sign-in shortcut and stop the helper.
No production restart, deployment or native app distribution is performed by
source verification.

TLI is provided under the [MIT license](LICENSE). Third-party dependencies,
runtimes and model weights retain their own licenses.
