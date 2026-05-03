const { app, BrowserWindow, Menu, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const http = require("http");
const net = require("net");

let backendProc = null;
let backendSpawnedByUs = false;
let splashWin = null;
let mainWin = null;
let chosenPort = null;
let isQuitting = false;

// ----------------------------------------------------
// Paths (dev vs packaged)
// ----------------------------------------------------
function baseResourcesDir() {
  // Packaged app: ...\TheLegatoIntelligence\resources
  // Dev:         <project>\resources
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "resources");
}
function rpath(...parts) {
  return path.join(baseResourcesDir(), ...parts);
}

// resources/backend/win/tli_backend.exe
function backendExePath() {
  if (process.platform === "win32") return rpath("backend", "win", "tli_backend.exe");
  if (process.platform === "darwin") return rpath("backend", "mac", "tli_backend");
  return rpath("backend", "linux", "tli_backend");
}

// Backend needs to find frontend/assets on disk (your backend uses TLI_ROOT)
function backendEnv(port) {
  const env = {
    ...process.env,
    TLI_ROOT: rpath("tli"),
    TLI_HOST: "0.0.0.0",
    TLI_PORT: String(port),
  };
  // Pass license secret if stored in userData config (written by user/admin setup)
  const cfgPath = path.join(app.getPath("userData"), "tli_config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && cfg.licenseSecret) env.TLI_LICENSE_SECRET = cfg.licenseSecret;
  } catch {}
  return env;
}

// ----------------------------------------------------
// Logging (works even when installed)
// ----------------------------------------------------
function logFilePath() {
  // userData is writable, unlike Program Files/resources
  return path.join(app.getPath("userData"), "tli_installer.log");
}
function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFilePath(), line, "utf8");
  } catch {}
}

// ----------------------------------------------------
// Stable port (persisted) + auto-recover
// - Keeps origin stable => localStorage (theme/onboarding) persists.
// - Tries saved port first, then scans 8000–8010, then last-resort ephemeral.
// ----------------------------------------------------
function portFilePath() {
  return path.join(app.getPath("userData"), "tli_port.json");
}
function readSavedPort(defaultPort = 8000) {
  try {
    const raw = fs.readFileSync(portFilePath(), "utf8");
    const obj = JSON.parse(raw);
    const p = Number(obj?.port);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) return p;
  } catch {}
  return defaultPort;
}
function savePort(port) {
  try {
    fs.writeFileSync(portFilePath(), JSON.stringify({ port }, null, 2), "utf8");
  } catch {}
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", () => resolve(0));
    req.setTimeout(1500, () => {
      try { req.destroy(); } catch {}
      resolve(0);
    });
  });
}

async function isBackendAlive(port) {
  // If /status responds, we consider the backend "alive enough".
  const code = await httpGet(`http://127.0.0.1:${port}/status`);
  return code >= 200 && code < 500;
}

async function pickPortStable() {
  const saved = readSavedPort(8000);

  // 1) If backend already responding on saved port, reuse it
  if (await isBackendAlive(saved)) return saved;

  // 2) If saved port is free, use it
  if (await isPortFree(saved)) return saved;

  // 3) Otherwise scan 8000–8010
  for (let p = 8000; p <= 8010; p++) {
    if (await isBackendAlive(p)) {
      savePort(p);
      return p;
    }
    if (await isPortFree(p)) {
      savePort(p);
      return p;
    }
  }

  // 4) Last resort: ephemeral free port (saved for next time to stabilize)
  const any = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      srv.close(() => resolve(port));
    });
  });

  if (!any) throw new Error("Could not allocate a free local port");
  savePort(any);
  return any;
}

// ----------------------------------------------------
// Backend lifecycle
// ----------------------------------------------------
function killOldBackendBestEffort() {
  // Auto-kill ONLY our backend executable to prevent testers from hitting port conflicts.
  // (Does not touch unrelated software.)
  if (process.platform !== "win32") return Promise.resolve();

  return new Promise((resolve) => {
    execFile("taskkill", ["/IM", "tli_backend.exe", "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

function startBackend(port) {
  const exe = backendExePath();
  log("TLI launcher starting…");
  log(`process.resourcesPath=${process.resourcesPath}`);
  log(`baseResourcesDir=${baseResourcesDir()}`);
  log(`backendExePath=${exe}`);
  log(`chosenPort=${port}`);

  if (!fs.existsSync(exe)) {
    log("Fatal startup error: Backend executable missing (ENOENT).");
    dialog.showErrorBox(
      "TLI Backend Failed",
      `Backend executable not found:\n\n${exe}\n\nCheck that resources/backend/* is included in the installer build.\n\nLog: ${logFilePath()}`
    );
    return false;
  }

  backendProc = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: backendEnv(port),
    windowsHide: true,
    stdio: "pipe",
  });

  backendProc.on("error", (err) => {
    log(`backend spawn error: ${err.message}`);
    dialog.showErrorBox(
      "TLI Backend Failed",
      `Backend failed to start:\n\n${exe}\n\n${err.message}\n\nLog: ${logFilePath()}`
    );
  });

  backendProc.stdout?.on("data", (d) => log(`[backend stdout] ${String(d).trimEnd()}`));
  backendProc.stderr?.on("data", (d) => log(`[backend stderr] ${String(d).trimEnd()}`));

  backendProc.on("exit", (code) => {
    log(`backend exit code=${code}`);
    backendProc = null;
    backendSpawnedByUs = false;
    if (!isQuitting) {
      dialog.showErrorBox(
        "TLI Startup Error",
        `Backend stopped unexpectedly (exit code ${code}).\n\nLog: ${logFilePath()}`
      );
    }
  });

  backendSpawnedByUs = true;  // mark that we own this process
  return true;
}

function stopBackend() {
  try {
    if (!backendProc) return;

    // If we did NOT spawn it (we reused an existing backend), do not kill it.
    if (!backendSpawnedByUs) {
      log("Backend not spawned by this app instance; leaving it running.");
      return;
    }

    log("Stopping backend…");
    const pid = backendProc.pid;
    backendProc = null;
    backendSpawnedByUs = false;

    if (process.platform === "win32" && pid) {
      // Kill backend + children (uvicorn/workers) to avoid zombies
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
      return;
    }

    // Non-Windows: best-effort
    try { process.kill(pid, "SIGTERM"); } catch {}
  } catch {}
}

// ----------------------------------------------------
// Wait for readiness
// ----------------------------------------------------
async function waitForStatus(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const code = await httpGet(url);
    if (code >= 200 && code < 500) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

// ----------------------------------------------------
// Windows
// ----------------------------------------------------
function createSplash() {
  splashWin = new BrowserWindow({
    width: 720,
    height: 360,
    resizable: false,
    movable: true,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true },
  });

  const splashFile = rpath("splash", "index.html");
  log(`splashFile=${splashFile} exists=${fs.existsSync(splashFile)}`);

  if (fs.existsSync(splashFile)) {
    splashWin.loadFile(splashFile).catch(() => {});
  } else {
    splashWin.loadURL(
      "data:text/html,<body style='background:#0b111b;color:#fff;font-family:sans-serif;padding:16px'>Starting TLI…</body>"
    ).catch(() => {});
  }

  splashWin.once("ready-to-show", () => splashWin && splashWin.show());
}

function buildAppMenu() {
  const template = [
    {
      label: "TheLegatoIntelligence",
      submenu: [
        {
          label: `About TLI v${app.getVersion()}`,
          click: () => {
            dialog.showMessageBox(mainWin, {
              type: "info",
              title: "About TheLegatoIntelligence",
              message: "TheLegatoIntelligence",
              detail: `Version ${app.getVersion()}\nLocal-first AI console. LAN-only. No cloud.\n\nRunning on port ${chosenPort}.`,
              buttons: ["OK"],
            });
          },
        },
        { type: "separator" },
        {
          label: "Quit TLI",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",
          click: () => { isQuitting = true; app.quit(); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(port) {
  mainWin = new BrowserWindow({
    width: 1320,
    height: 860,
    show: false,
    backgroundColor: "#0b111b",
    title: "TheLegatoIntelligence",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  log(`TLI UI port selected: ${port}`);

  // Block any window.open() calls from the frontend — TLI is a single-window app
  mainWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWin.webContents.on("did-fail-load", (e, code, desc) => {
    log(`did-fail-load: code=${code} desc=${desc}`);
  });

  const url = `http://127.0.0.1:${port}/?tli_port=${port}`;
  mainWin.loadURL(url).catch((e) => log(`loadURL error: ${e.message}`));

  mainWin.once("ready-to-show", () => {
    if (splashWin) splashWin.close();
    splashWin = null;
    buildAppMenu();
    mainWin.show();
  });

  mainWin.on("closed", () => {
    mainWin = null;
  });
}

// ----------------------------------------------------
// App lifecycle
// ----------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.whenReady().then(async () => {
  createSplash();

  // Reduce port conflicts from zombie backends during beta testing.
  await killOldBackendBestEffort();

  // Choose a stable port (persisted) and only fall back when needed.
  try {
    chosenPort = await pickPortStable();
  } catch (e) {
    log(`Failed to select stable port: ${e.message}`);
    dialog.showErrorBox("TLI Startup Error", `Could not select a local port.\n\nLog: ${logFilePath()}`);
    app.quit();
    return;
  }

  // If another TLI backend is already alive on that port, reuse it and skip spawning.
  const alive = await isBackendAlive(chosenPort);

  if (!alive) {
    const ok = startBackend(chosenPort);
    if (!ok) {
      app.quit();
      return;
    }

    const ready = await waitForStatus(`http://127.0.0.1:${chosenPort}/status`, 35000);
    if (!ready) {
      dialog.showErrorBox(
        "TLI Startup Error",
        `Backend did not respond in time on port ${chosenPort}.\n\nLog: ${logFilePath()}`
      );
      stopBackend();
      app.quit();
      return;
    }
  }

  // Persist chosen port so origin stays stable across launches
  savePort(chosenPort);

  createMainWindow(chosenPort);
});

app.on("second-instance", () => {
  try {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  } catch {}
});

app.on("window-all-closed", () => {
  isQuitting = true;
  stopBackend();
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});
