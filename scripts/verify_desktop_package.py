"""Verify an exact desktop ZIP in a fresh synthetic installation under build_work.

The application import and ASGI requests run in a separate process with network,
process creation, discovery, browser opening and inference disabled. Only the
packaged native runtime's --version and --help commands and standard-library host
metadata probes execute outside that guard. No model is downloaded or loaded,
and no live TLI installation is used.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform as host_platform
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
from urllib.parse import unquote, urlsplit
import urllib.request
from unittest.mock import patch
import webbrowser
import zipfile


ROOT = Path(__file__).resolve().parents[1]
# Validate the release inventory using trusted verifier source, never code from
# the ZIP. This standalone policy imports no application state or services.
_policy_spec = importlib.util.spec_from_file_location("tli_desktop_package_policy", ROOT / "backend/update_install.py")
_policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(_policy)
MANIFEST_NAME = "TLI_RELEASE.json"
MARKER = "synthetic desktop package verification only"
MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES = 5000, 128 * 1024 * 1024, 1024 * 1024 * 1024
COMMON_ROOT = {"README.md", "START_HERE.md", "LICENSE", "SECURITY.md", "TLI_MANUAL.md"}
PUBLIC_GUIDES = {"TLI_SHARED_WORKSPACE.md", "TLI_COMPUTER_CONNECTION_REQUESTS.md", "TLI_SEAMLESS_CONNECTIONS.md", "SSE_SCHEMA.md",
                 "HOST_START.md", "TLI_HOST_START.md", "TLI_SMART_HUB_REFINEMENT.md",
                 "TLI_CONNECTED_WORKFLOWS.md", "TLI_SIMPLIFICATION_RELEASE.md",
                 "TLI_SIMPLIFICATION_ACCEPTANCE.md", "TLI_SIDEBAR_DIRECT_ACCESS.md",
                 "TLI_CAPABILITIES.md", "TLI_ANNIVERSARY_COMPLETION_PROGRAM.md", "RELEASE_1.4.0_BETA.md",
                 "RELEASE_1.4.1_BETA.md", "TLI_UPDATES.md", "TLI_UNINSTALL.md"}
PLATFORM_ROOT = {
    "windows": {"TLI.exe", "TLI_Start.bat", "TLI_Diagnostics.bat", "TLI_Bootstrap.ps1",
                "TLI_Setup.bat", "TLI_Setup.ps1", "TLI_Network_Setup.ps1", "tli_sentinel.ps1",
                "TLI_Update.bat", "TLI_Update.ps1", "Uninstall_TLI.bat", "TLI_Uninstall.ps1"},
    "macos": {"TLI_Start.command", "TLI_Start.sh", "TLI_Update.command", "TLI_Update.sh",
              "Uninstall_TLI.command", "Uninstall_TLI.sh"},
}
REQUIRED_SOURCE = {"backend/main.py", "backend/tli_state.py", "backend/requirements.txt",
                   "backend/host_launcher.py", "backend/launch_checks.py", "backend/release_identity.py",
                   "backend/desktop_launcher.py", "backend/ai/runtime_support.py", "backend/update_install.py",
                   "docs/TLI_UPDATES.md", "docs/TLI_UNINSTALL.md",
                   "frontend/index.html", "frontend/app.js", "frontend/style.css"}
PRIVATE_DIRS = {"data", "tli_data", "vault_data", "vault", "memory", "models", "session", "sessions",
                "keys", "tls", "secrets", "node_modules", "tests", "scripts", "build", "build_work",
                "dist", "dist_build", "tli_installer", "tli_confidential", "mobile", "landing", "artifacts"}
PRIVATE_NAMES = {"devices.json", "active_model.json", "tli_model_config.json", "vault_meta.json",
                 "credentials.json", "node_identity.json", "tli_pin.json", "tli_system_profile.json",
                 "conversations.json", "vault_sessions.json", "startup.json", "printers_snmp.json",
                 "secrets.json", "secrets.yaml", "secrets.yml", "credentials.yaml", "credentials.yml"}
PRIVATE_SUFFIXES = {".pem", ".key", ".crt", ".pfx", ".p12", ".jks", ".keystore", ".mobileprovision",
                    ".gguf", ".ggml", ".bin", ".safetensors", ".onnx", ".pt", ".pth", ".db", ".sqlite",
                    ".sqlite3", ".enc", ".log", ".jsonl", ".bak", ".pyc", ".pyo", ".zip", ".rar", ".7z"}
LICENSE_NAMES = {"LICENSE-llama.cpp.txt", "LICENSE-jsonhpp.txt", "LICENSE-cpp-httplib.txt", "RUNTIME-NOTICES.txt"}
FRONTEND_SUFFIXES = {".js", ".css", ".html", ".json", ".svg", ".png", ".ico", ".jpg", ".jpeg", ".webp",
                     ".woff", ".woff2", ".ttf", ".mp3", ".txt"}
WINDOWS_DLL = re.compile(r"(?:ggml(?:-[a-z0-9-]+)?|llama|mtmd|libomp140\.x86_64)\.dll\Z", re.I)


class PackageError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PackageError(message)


def require_process(result, message):
    """Keep failed synthetic-child diagnostics visible even without artifacts."""
    if result.returncode != 0:
        output = (result.stdout or "") + "\n" + (result.stderr or "")
        raise PackageError(message + "\n--- child output (last 12000 characters) ---\n" + output[-12000:])


def member_path(name):
    require(name and "\\" not in name and not name.startswith("/") and "\x00" not in name,
            "ZIP contains a nonportable or absolute member path")
    parts = name.rstrip("/").split("/")
    require(all(part not in {"", ".", ".."} and ":" not in part and not part.endswith((".", " "))
                for part in parts), "ZIP contains a traversal or ambiguous member path")
    reserved = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z", re.I)
    require(not any(reserved.fullmatch(part) for part in parts), "ZIP contains a Windows reserved filename")
    return PurePosixPath(*parts)


def allowed_file(path, target):
    parts, name, suffix = path.parts, path.name, path.suffix.lower()
    lower = [part.casefold() for part in parts]
    if any(part.startswith(".") or part in PRIVATE_DIRS for part in lower[:-1]):
        return False
    if name.casefold() in PRIVATE_NAMES or name.startswith(".") or suffix in PRIVATE_SUFFIXES:
        return False
    if len(parts) == 1:
        return name in COMMON_ROOT | PLATFORM_ROOT[target] | {MANIFEST_NAME}
    if parts[:3] == ("backend", "ai", "runtime"):
        if target == "windows":
            return len(parts) == 4 and (name == "llama_server.exe" or WINDOWS_DLL.fullmatch(name)
                                       or name in LICENSE_NAMES | {"LICENSE-LLVM-OpenMP.txt"})
        return (len(parts) == 5 and parts[3] in {"macos-arm64", "macos-x64"}
                and (name == "llama-server" or name == "LICENSE" or name in LICENSE_NAMES
                     or bool(re.fullmatch(r"lib(?:llama|mtmd|ggml(?:-[a-z0-9-]+)?)(?:\.[0-9]+)*\.dylib", name))))
    if parts[0] == "backend":
        return suffix == ".py" or path.as_posix() == "backend/requirements.txt" or (
            suffix == ".txt" and "prompts" in parts[1:-1])
    if parts[0] == "frontend":
        return suffix in FRONTEND_SUFFIXES
    return len(parts) == 2 and parts[0] == "docs" and name in PUBLIC_GUIDES


def inspect_archive(archive, target, expected_version):
    """Validate the entire inventory before extracting even one file."""
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        require(0 < len(infos) <= MAX_FILES, "ZIP member count is outside the verification limit")
        seen, files, total = set(), {}, 0
        for info in infos:
            path = member_path(info.orig_filename)
            key = path.as_posix().casefold()
            require(key not in seen, "ZIP contains duplicate or case-colliding member paths")
            seen.add(key)
            mode = info.external_attr >> 16
            require(stat.S_IFMT(mode) in {0, stat.S_IFREG, stat.S_IFDIR}, "ZIP contains a link or special file")
            require(not info.flag_bits & 1, "Encrypted ZIP members are not supported")
            require(info.file_size <= MAX_FILE_BYTES, "ZIP member exceeds the size limit")
            if info.is_dir():
                require(path.parts[0] in {"backend", "frontend", "docs"}
                        and not any(part.startswith(".") or part.casefold() in PRIVATE_DIRS for part in path.parts),
                        "ZIP contains a private or developer-only directory")
                continue
            require(allowed_file(path, target), "ZIP contains a private, developer-only or wrong-platform path: " + path.as_posix())
            files[path.as_posix()] = info
            total += info.file_size
        require(total <= MAX_TOTAL_BYTES, "ZIP expanded size exceeds the verification limit")
        file_keys = {value.casefold() for value in files}
        for name in files:
            require(not any(parent.as_posix().casefold() in file_keys
                            for parent in PurePosixPath(name).parents if parent != PurePosixPath(".")),
                    "ZIP contains conflicting file and directory paths")
        for name in COMMON_ROOT | PLATFORM_ROOT[target] | REQUIRED_SOURCE | {MANIFEST_NAME}:
            require(name in files, "ZIP is missing a required file: " + name)
        if {"frontend/assets/fonts/InterVariable.woff2", "frontend/assets/fonts/InterVariable-Italic.woff2"} & files.keys():
            require("frontend/assets/fonts/Inter-LICENSE.txt" in files, "ZIP is missing bundled Inter font licensing")
        runtime_dirs = ["backend/ai/runtime"] if target == "windows" else [
            "backend/ai/runtime/macos-arm64", "backend/ai/runtime/macos-x64"]
        for directory in runtime_dirs:
            runtime = directory + ("/llama_server.exe" if target == "windows" else "/llama-server")
            require(runtime in files, "ZIP is missing its platform runtime: " + runtime)
            licenses = LICENSE_NAMES | ({"LICENSE-LLVM-OpenMP.txt"} if target == "windows" else set())
            for name in licenses:
                require(directory + "/" + name in files, "ZIP is missing runtime licensing: " + name)
            if target == "macos":
                require(files[runtime].external_attr >> 16 & 0o111, "macOS runtime has no executable ZIP mode")
        if target == "macos":
            for name in PLATFORM_ROOT[target]:
                require(files[name].external_attr >> 16 & 0o111, "macOS launcher has no executable ZIP mode")
                require(b"\r" not in bundle.read(name), "macOS launcher must use LF line endings")
        for name in ("backend/tli_state.py", "frontend/app.js"):
            text = bundle.read(name).decode("utf-8-sig")
            version = re.search(r'\bTLI_VERSION\s*=\s*["\']([^"\']+)["\']', text)
            require(version is not None and version[1] == expected_version, "Packaged version does not match: " + name)
        require(bundle.testzip() is None, "ZIP member CRC verification failed")
        try:
            manifest = _policy.validate_archive(archive, expected_version, target)
        except _policy.UpdateError as error:
            raise PackageError("Release inventory validation failed: " + str(error)) from error
        require(manifest["platform"] == target, "Release inventory platform must match the platform-specific ZIP")
        for entry in manifest["files"]:
            require(files[entry["path"]].external_attr >> 16 & 0o7777 == entry["mode"],
                    "ZIP permissions disagree with the release inventory: " + entry["path"])
        return {"files": len(files), "expanded_bytes": total, "paths": sorted(files),
                "release_inventory_verified": True, "release_inventory_files": len(manifest["files"])}


def extract_fresh(archive, destination):
    require(not destination.exists(), "Extraction destination must be new")
    destination.mkdir()
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            path = destination.joinpath(*member_path(info.orig_filename).parts)
            if info.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, path.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            mode = info.external_attr >> 16
            if os.name != "nt":
                path.chmod(0o755 if mode & 0o111 else 0o644)


class AssetReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script", "img", "audio", "video", "source"} and attrs.get("src"):
            self.urls.add(attrs["src"])
        if tag == "link" and attrs.get("href"):
            self.urls.add(attrs["href"])


def asset_paths(frontend):
    parser = AssetReferences()
    parser.feed((frontend / "index.html").read_text("utf-8"))
    pending = [("index.html", url) for url in parser.urls]
    paths = {"index.html"}
    while pending:
        base, url = pending.pop()
        split = urlsplit(url)
        if split.scheme or split.netloc or not split.path:
            continue
        relative = unquote(split.path)
        path = frontend / relative.lstrip("/") if relative.startswith("/") else frontend / Path(base).parent / relative
        resolved = path.resolve()
        require(resolved.is_relative_to(frontend.resolve()) and resolved.is_file(), "HTML or stylesheet references a missing/outside asset")
        name = resolved.relative_to(frontend.resolve()).as_posix()
        if name in paths:
            continue
        paths.add(name)
        if resolved.suffix == ".css":
            css = resolved.read_text("utf-8")
            pending.extend((name, value.strip().strip("\"'")) for value in re.findall(r"url\(([^)]+)\)", css))
    return sorted(paths)


def clean_environment(installation=None):
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("TLI_", "UVICORN_")) and key.upper() not in
           {"PYTHONPATH", "PYTHONHOME", "PYTEST_ADDOPTS", "PYTHONSTARTUP"}}
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1", TLI_OPEN_BROWSER="0")
    if installation:
        env["TLI_ROOT"] = str(installation)
    return env


def host_metadata():
    # CPython platform() uses uname -p and file on macOS. Populate its own cache
    # before forbidding application subprocesses, without patching the guard or
    # supplying fabricated platform results to the real diagnostics endpoint.
    return {"platform": host_platform.platform(),
            "scope": "Python standard-library host metadata captured before application isolation"}


def child_smoke(installation, expected_version, report_file):
    require(installation.is_relative_to((ROOT / "build_work").resolve()) and installation.is_dir()
            and installation.name == "installation", "Smoke installation must be a fresh build_work extraction")
    require(report_file is not None and report_file.resolve().parent == installation.parent,
            "Smoke report must remain with the synthetic installation")
    require((installation.parent / ".tli-package-check").read_text("utf-8") == MARKER,
            "Synthetic package marker is missing")
    environment = clean_environment(installation)
    os.environ.clear()
    os.environ.update(environment)
    os.chdir(installation)
    sys.path.insert(0, str(installation / "backend"))
    metadata = host_metadata()
    attempts = []
    def blocked(*args, **kwargs):
        attempts.append("blocked live effect")
        raise RuntimeError("Live side effects are disabled in desktop package verification")
    pair_context = threading.local()
    original_pair, original_connect = socket.socketpair, socket.socket.connect
    def private_pair(*args, **kwargs):
        pair_context.active = True
        try:
            return original_pair(*args, **kwargs)
        finally:
            pair_context.active = False
    def guarded_connect(sock, address):
        if getattr(pair_context, "active", False) and address[0] in ("127.0.0.1", "::1"):
            return original_connect(sock, address)
        return blocked()
    with ExitStack() as effects:
        for obj, name, replacement in (
            (subprocess, "Popen", blocked), (os, "system", blocked), (webbrowser, "open", blocked),
            (socket, "socketpair", private_pair), (socket.socket, "connect", guarded_connect),
            (socket.socket, "connect_ex", blocked), (socket.socket, "sendto", blocked),
            (urllib.request, "urlopen", blocked),
        ):
            effects.enter_context(patch.object(obj, name, replacement))
        import requests
        import httpx
        effects.enter_context(patch.object(requests.sessions.Session, "request", blocked))
        effects.enter_context(patch.object(httpx.HTTPTransport, "handle_request", blocked))
        effects.enter_context(patch.object(httpx.AsyncHTTPTransport, "handle_async_request", blocked))
        with patch.object(threading.Thread, "start", lambda self: None):
            import data_protection
            effects.enter_context(patch.object(data_protection, "is_windows", lambda: False))
            import tli_state as state
            require(Path(state.DATA_DIR).resolve() == installation / "data", "Application data escaped the synthetic installation")
            require(Path(state.FRONTEND_DIR).resolve() == installation / "frontend", "Application assets escaped the extracted package")
            from ai import ai_manager
            for name in ("ensure_running", "is_healthy", "stop"):
                effects.enter_context(patch.object(ai_manager.BundledAIManager, name, lambda self: False))
            effects.enter_context(patch.object(ai_manager, "urlopen", blocked))
            import main as application
        from fastapi.testclient import TestClient
        import release_identity
        require(state.TLI_VERSION == expected_version, "Imported backend version is incorrect")
        require(Path(application.__file__).resolve() == installation / "backend/main.py", "Smoke imported a different backend")
        assets = asset_paths(installation / "frontend")
        # No lifespan context: startup tasks, hardware checks and network services never run.
        client = TestClient(application.app)
        try:
            version = client.get("/tli/capabilities")
            require(version.status_code == 200 and version.json().get("version") == expected_version,
                    "Version advertisement does not match the package")
            diagnostics = client.get("/api/diagnostics/version")
            require(diagnostics.status_code == 200, "Release diagnostics route is unavailable")
            release = diagnostics.json()["release"]
            require(release["compatibility"]["state"] == "matched", "Loaded and packaged source identities differ")
            require(set(release["capabilities"]) == set(release_identity.CAPABILITIES), "Packaged routes do not advertise all release capabilities")
            for name in assets:
                response = client.get("/" if name == "index.html" else "/" + name)
                require(response.status_code == 200, "Packaged static route is unavailable: " + name)
                require(response.content == (installation / "frontend" / name).read_bytes(), "Static route differs from ZIP source: " + name)
            from ai.runtime_support import select_runtime
            selected = select_runtime(installation / "backend/ai/runtime").resolve()
            manager = ai_manager.BundledAIManager.get()
            require(Path(manager.cfg.runtime_path).resolve() == selected, "Application manager selected a different runtime")
            runtime = selected.relative_to(installation).as_posix()
        finally:
            client.close()
        require(not attempts, "Application attempted a live effect during inert import/API verification")
        report = {"version": state.TLI_VERSION, "source_id": release["source_id"],
                  "capabilities": sorted(release["capabilities"]), "static_assets_verified": len(assets),
                  "selected_runtime": runtime, "live_effect_attempts": len(attempts),
                  "host_metadata_probe": metadata,
                  "scope": "inert import, ASGI read routes and exact extracted static bytes; no startup lifespan"}
        report_file.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def output_parent(requested):
    base = ROOT / "build_work"
    require(not base.is_symlink() and not (hasattr(base, "is_junction") and base.is_junction()), "build_work must not be a filesystem link")
    base.mkdir(exist_ok=True)
    selected = (requested if requested and requested.is_absolute() else ROOT / requested) if requested else base / "desktop-package-checks"
    require(selected.resolve().is_relative_to(base.resolve()), "Verification output must remain under this checkout's build_work")
    selected.mkdir(parents=True, exist_ok=True)
    return selected.resolve()


def verify(archive, target, expected_version, output_dir=None, check_setup=False):
    archive = archive.resolve(strict=True)
    require((target == "windows" and os.name == "nt") or (target == "macos" and sys.platform == "darwin"),
            "Runtime smoke must run on the package's Windows or macOS platform")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    inventory = inspect_archive(archive, target, expected_version)
    work = Path(tempfile.mkdtemp(prefix=target + "-", dir=output_parent(output_dir)))
    (work / ".tli-package-check").write_text(MARKER, encoding="utf-8")
    installation = work / "installation"
    extract_fresh(archive, installation)
    report_file = work / "application.json"
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    interpreter = sys.executable
    if check_setup:
        environment = clean_environment(installation)
        environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "")
        if target == "windows":
            shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            command = [str(shell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                       str(installation / "TLI_Bootstrap.ps1"), "-SetupOnly"]
            interpreter = str(installation / "backend/.venv/Scripts/python.exe")
        else:
            command = [str(installation / "TLI_Start.sh"), "--setup-only"]
            interpreter = str(installation / "backend/.venv/bin/python")
        result = subprocess.run(command, cwd=installation,
                                env=environment, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=900, **flags)
        (work / "setup.log").write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
        require_process(result, "Packaged setup-only launcher failed; inspect " + str(work / "setup.log"))
        require(Path(interpreter).is_file(), "Setup-only launcher did not create its installation's Python environment")
    result = subprocess.run([interpreter, "-I", "-B", str(Path(__file__).resolve()), "--_smoke-child",
                             str(installation), "--expected-version", expected_version, "--_report", str(report_file)],
                            env=clean_environment(installation), cwd=installation,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, **flags)
    (work / "application.log").write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
    require_process(result, "Extracted application smoke failed; inspect " + str(work / "application.log"))
    require(report_file.is_file(), "Extracted application smoke did not write its report; inspect " + str(work / "application.log"))
    application = json.loads(report_file.read_text("utf-8"))
    expected_runtime = "backend/ai/runtime/llama_server.exe"
    if target == "macos":
        architecture = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(host_platform.machine().lower())
        require(architecture is not None, "Unrecognized macOS Python process architecture")
        expected_runtime = f"backend/ai/runtime/macos-{architecture}/llama-server"
    require(application["selected_runtime"] == expected_runtime, "Application selected a runtime for the wrong platform or CPU")
    runtime = installation / expected_runtime
    outputs = {}
    for argument in ("--version", "--help"):
        result = subprocess.run([str(runtime), argument], cwd=runtime.parent, env=clean_environment(),
                                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=30, **flags)
        output = result.stdout + "\n" + result.stderr
        (work / ("runtime-" + argument[2:] + ".txt")).write_text(output, encoding="utf-8")
        require_process(result, "Packaged runtime inspection failed: " + argument)
        outputs[argument] = output
    build = re.search(r"\bversion:\s*b?(\d+)\b", outputs["--version"], re.I)
    require(build is not None and build[1] == "7896", "Packaged runtime does not match pinned build b7896")
    for flag in ("--jinja", "--chat-template-kwargs", "--reasoning-budget", "--reasoning-format"):
        require(flag in outputs["--help"], "Runtime lacks a required supported-model flag")
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == digest, "Archive changed during verification")
    report = {"passed": True, "archive": archive.name, "archive_sha256": digest, "platform": target,
              "expected_version": expected_version, "inventory": {key: value for key, value in inventory.items() if key != "paths"},
              "application": application, "runtime_build": build[1], "model_inference_run": False,
              "setup_only_verified": check_setup,
              "native_launcher_or_physical_acceptance": False}
    (work / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return {**report, "report_path": str(work / "report.json")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--platform", choices=("windows", "macos"))
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--check-setup", action="store_true", help="Run the platform setup-only launcher in the new extraction and use its fresh venv (downloads dependencies)")
    parser.add_argument("--_smoke-child", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--_report", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args._smoke_child:
        child_smoke(args._smoke_child.resolve(), args.expected_version, args._report)
        return
    if not args.archive or not args.platform:
        parser.error("--archive and --platform are required")
    try:
        print(json.dumps(verify(args.archive, args.platform, args.expected_version, args.output_dir, args.check_setup), indent=2))
    except (PackageError, OSError, zipfile.BadZipFile, subprocess.TimeoutExpired) as error:
        print("Desktop package verification failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
