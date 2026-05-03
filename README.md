# TheLANIntelligence — v1.1.1 Beta

A private home operating system. Runs on your LAN. No cloud, no accounts, no subscriptions.
Works on **Windows, macOS, and Linux** — TLI detects your OS and adjusts automatically.

---

## Start Here

**Windows** — double-click `TLI_Start.bat`

**macOS** — double-click `TLI_Start.command`
(first time: right-click → Open to allow it past Gatekeeper, or use the one-line installer below)

**Linux** — open a terminal in this folder and run `bash TLI_Start.sh`

---

### macOS — One-Line Installer

Open Terminal and paste:

```
curl -fsSL https://thelanintelligence.com/install_mac.sh | bash
```

This downloads TLI, strips the quarantine flag, fixes permissions, and launches it — no security warnings.

**Already have the zip?**
```
bash ~/Downloads/TLI_Beta_V1.1.1/TLI_Start.command
```

---

## Requirements

- **Python 3.10 or later** — [python.org/downloads](https://www.python.org/downloads/)
  - Windows: tick "Add Python to PATH" during install
  - macOS / Linux: the launcher auto-installs Python if it is missing
- Windows 10+, macOS 12+, or Ubuntu 20.04+ (other Linux distros with CUPS will work)

---

## First Run

1. Run the start script for your platform — wait for the browser to open
2. Complete the **onboarding wizard** — set your node name, PIN, and optionally download an AI model
3. Everything else is optional — explore from the Dashboard

### AI Model (first-time setup)

On Mac and Linux, the launcher will ask if you want to download the bundled AI runtime on first run.
Say **Y** — it downloads the correct `llama-server` binary for your platform automatically (~50 MB).
Then go to **Settings → AI Model** to download a model (1–4 GB depending on tier).

If you prefer LM Studio, skip the runtime download and point TLI at your LM Studio URL instead.

---

## What is TLI?

TLI turns one machine into a home console accessible from any browser on your network.
It connects your AI model, smart home devices, encrypted vault, files, and LAN machines
into one interface — entirely offline.

Nine modules, all unlocked in beta:

| Module | What it does |
|---|---|
| AI Chat | Chat with a local LLM — no API key, no internet |
| Dashboard | Live system vitals + quick actions |
| Vault | AES-256 encrypted files, notes, passwords, and logins |
| Home Automation | Control Shelly, Hue, Kasa, Govee, Tasmota, and more — direct LAN |
| Game Optimizer | Detect running games, get AI tuning advice (Windows/macOS/Linux) |
| Storage Visualizer | Interactive disk map — find and clean what's taking space |
| Mesh | Connect multiple machines on your LAN into one console |
| Automations | Trigger device actions on schedule, power events, or node presence |
| Files & Tools | Bulk rename, organise, AI-generated scripts, diagnostics |

---

## Platform Feature Matrix

| Feature | Windows | macOS | Linux |
|---|:---:|:---:|:---:|
| AI Chat (LM Studio) | ✓ | ✓ | ✓ |
| AI Chat (Bundled model) | ✓ | ✓ auto-download | ✓ auto-download |
| Dashboard + System Info | ✓ | ✓ | ✓ |
| Vault | ✓ | ✓ | ✓ |
| Home Automation | ✓ | ✓ | ✓ |
| Game Detection | ✓ | ✓ | ✓ |
| Storage Visualizer | ✓ | ✓ | ✓ |
| Printers & Scan | ✓ WMI/WSD | ✓ CUPS | ✓ CUPS |
| USB / Removable Drives | ✓ | ✓ | ✓ |
| Mesh Networking | ✓ | ✓ | ✓ |
| Open in Finder / Explorer | ✓ | ✓ | ✓ |
| Bundled AI runtime | ✓ included | auto-downloaded | auto-downloaded |

---

## Accessing TLI from Other Devices

Once running, TLI is accessible from any device on your home network:

```
http://<this-machine-ip>:8000
```

Find your IP in **Settings → Node Identity**, or use your machine's hostname
(e.g. `http://desktop.local:8000`).

---

## Stopping TLI

Close the terminal window, or press `Ctrl+C` inside it.

---

## Uninstalling TLI

TLI is self-contained — nothing is written outside its folder.

| Platform | How to uninstall |
|---|---|
| Windows | Double-click `Uninstall_TLI.bat` |
| macOS | Double-click `Uninstall_TLI.command` (in `~/TLI`) |
| Linux | Run `bash Uninstall_TLI.sh` |

Each script stops TLI if running, then deletes the entire TLI folder including all data, models,
and settings. You are asked to confirm before anything is deleted.

If you installed the browser extension, remove it separately:
**Chrome/Edge → Extensions → TheLANIntelligence → Remove**.

---

## Updating

TLI checks for updates automatically a few seconds after startup. When a new version is available,
a notification appears in **Settings → Updates**. Updates are never applied without your approval.

---

## Help & Bug Reports

- Full user manual: open **TLI → Settings → Manual**, or read `TLI_MANUAL.md` in this folder
- macOS-specific guide: `docs/README_MAC.md`
- Bug reports: thelanintelligence@gmail.com
