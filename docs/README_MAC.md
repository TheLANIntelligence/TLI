# TheLANIntelligence — macOS Guide
*v1.1.1-beta · All features supported on macOS*

---

## Installing TLI

### Option A — One-line installer (recommended)

Open **Terminal** (`⌘ Cmd + Space` → type **Terminal** → press **Return**), paste the command below, and press **Return**:

```
curl -fsSL https://thelanintelligence.com/install_mac.sh | bash
```

TLI downloads, installs to `~/TLI`, strips the Gatekeeper quarantine flag, and opens in your browser. Takes about 30 seconds.

---

### Option B — Already downloaded the zip?

1. Extract the zip if you haven't already
2. Open **Terminal** (`⌘ Cmd + Space` → type **Terminal** → press **Return**)
3. Run:

```
bash ~/Downloads/TLI_Beta_V1.1.1/TLI_Start.command
```

Replace the path with wherever you extracted the zip.

**Gatekeeper note:** If macOS says "cannot be opened because the developer cannot be verified", right-click `TLI_Start.command` → **Open** → **Open**. You only need to do this once.

---

## Starting TLI after the first install

Double-click `TLI_Start.command` inside the `~/TLI` folder.

Or from Terminal:

```
bash ~/TLI/TLI_Start.command
```

TLI opens at `http://localhost:8000` in your browser.

---

## First run — AI runtime setup

On the first launch, the installer will ask:

```
Bundled AI runtime not found.
Download AI runtime now? [Y/n]
```

Type **Y** and press Return. TLI will:
1. Detect your Mac's chip (Apple Silicon arm64 or Intel x86_64)
2. Download the correct `llama-server` binary from the official llama.cpp releases (~50 MB)
3. Place it in `backend/ai/runtime/` and set the right permissions

This only happens once. After that, go to **Settings → AI Model** to download a model (1–4 GB).

If you'd rather use **LM Studio**, say **N** and configure the LM Studio URL in **Settings → AI**.

---

## First run checklist

1. TLI opens automatically — wait for the browser tab to appear
2. Complete the **onboarding wizard** — set your node name and PIN
3. Download an AI model if prompted (or skip and use LM Studio)
4. Everything else is optional — explore from the Dashboard

---

## What works on macOS

Everything. TLI detects macOS and uses the right tools automatically:

| Feature | How TLI handles it on Mac |
|---|---|
| Printer list | CUPS via `lpstat` |
| Test print | `lp` command |
| Open scanner | Image Capture (falls back to Preview) |
| Add printer | System Preferences → Printers & Scanners |
| Game detection | `osascript` frontmost app + psutil process scan |
| Steam library | `~/Library/Application Support/Steam` |
| GOG Galaxy | `~/Library/Application Support/GOG.com/Games` |
| Disk info | `diskutil info` per drive |
| GPU / display info | `system_profiler SPDisplaysDataType` |
| USB / drives | `mount` + `statvfs` for size |
| Open in Finder | `open -R <path>` |
| AI runtime | Auto-downloaded on first run (`macos-arm64` or `macos-x64`) |

---

## Accessing TLI from other devices (phones, tablets, other Macs)

Once TLI is running, open a browser on any device on your home Wi-Fi and go to:

```
http://<this-mac-ip>:8000
```

Find your Mac's IP in TLI under **Settings → Node Identity**.

---

## Stopping TLI

Close the Terminal window, or click inside it and press `Ctrl + C`.

---

## Updates

TLI checks for updates automatically a few seconds after startup. When one is available you'll see a notification in **Settings → Updates**. Updates are never applied without your approval.

---

## Uninstalling TLI

**Option A — Uninstall script (recommended)**

Double-click `Uninstall_TLI.command` inside the `~/TLI` folder, or run:

```
bash ~/TLI/Uninstall_TLI.command
```

Type **YES** when prompted. This removes the entire TLI folder including all data, models, and settings.

---

**Option B — Manual removal**

Open Terminal and run:

```bash
# Stop TLI if running
lsof -ti tcp:8000 | xargs kill -9 2>/dev/null; echo "Stopped."

# Delete TLI
rm -rf ~/TLI
echo "TLI removed."
```

If you installed the browser extension, remove it separately: **Chrome/Edge → Extensions → TheLANIntelligence → Remove**.

---

## Help & bug reports

- Full manual: **TLI → Settings → Manual**, or `TLI_MANUAL.md`
- Email: thelanintelligence@gmail.com
