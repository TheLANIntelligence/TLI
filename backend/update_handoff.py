"""Fixed prepared-package review for the desktop lifecycle worker.

No application state imports, network requests or process effects occur here.
The signed lifecycle intent supplies only a bounded job name and fingerprints.
"""
from __future__ import annotations

import re
import sys
import os
import math
import subprocess
import threading
from pathlib import Path

import host_control as H
import host_launcher as L
import update_install as I


def check_helper_blockers(root, *, check=lambda: None):
    """Recognize known conflicting launchers before stopping the host.

    The installer's complete stopped-process gate remains mandatory afterward.
    The backend/model are intentionally still running during this preflight.
    """
    import psutil
    names = {'host_control_server.py', 'host_launcher.py', 'desktop_launcher.py',
             'tli_sentinel.ps1', 'tli_node.py', 'tli_bootstrap.ps1', 'tli_start.sh'}
    for process in psutil.process_iter(['pid', 'name'], ad_value=None):
        check()
        info = process.info
        if info['pid'] == os.getpid():
            continue
        name = str(info.get('name') or '').casefold()
        if not (name.startswith(('python', 'pypy')) or name in {'tli.exe', 'powershell.exe', 'pwsh.exe', 'bash', 'bash.exe'}):
            continue
        try:
            info.update(process.as_dict(attrs=['exe', 'cmdline', 'cwd'], ad_value=None))
        except psutil.NoSuchProcess:
            continue
        check()
        if (str(info.get('name') or '').casefold() == 'tli.exe' and info.get('exe')
                and I._inside(I._no_links(info['exe']).resolve(), root)):
            H._fail('Close the separate TLI desktop launcher before installing. No stop was requested.')
        for value in info.get('cmdline') or []:
            path = Path(value.strip('"'))
            if path.name.casefold() not in names:
                continue
            if not path.is_absolute():
                if not info.get('cwd'):
                    H._fail('A TLI helper location could not be confirmed. Close it before reviewing installation.')
                path = Path(info['cwd']) / path
            if I._inside(path.resolve(), root):
                H._fail('Close the separate TLI launcher, phone-start helper or setup process before installing. No stop was requested.')


def review_package(root, package, *, check=lambda: None):
    check()
    root = H.root_path(root)
    if sys.platform not in {"win32", "darwin"}:
        H._fail("Install and restart is available for managed Windows and macOS desktops. Use the guided updater on this platform.")
    if (not isinstance(package, dict) or set(package) != {"folder", "version", "manifest_sha256"}
            or not isinstance(package.get("folder"), str) or not re.fullmatch(r"job-[a-f0-9]{32}", package["folder"])
            or not isinstance(package.get("version"), str) or len(package["version"]) > 100
            or not isinstance(package.get("manifest_sha256"), str) or not H.HEX.fullmatch(package["manifest_sha256"])):
        H._fail("Download this update again before reviewing installation. Its prepared-package proof is unavailable.")
    source = I._no_links(root / "data" / "updates" / package["folder"] / "package")
    manifest_path = I._no_links(source / I.MANIFEST_NAME)
    check()
    if I._hash(manifest_path, check=check)[1] != package["manifest_sha256"]:
        H._fail("The prepared package changed. Download and review it again.")
    manifest = I._validate_source(source, I._platform(), check=check)
    I.require_full_release(manifest, I._platform())
    required = {"backend/host_lifecycle.py", "backend/host_launcher.py", "backend/update_handoff.py",
                "TLI_Bootstrap.ps1" if sys.platform == "win32" else "TLI_Start.sh"}
    if manifest["version"] != package["version"] or not required.issubset({item["path"] for item in manifest["files"]}):
        H._fail("This package does not support the reviewed install-and-restart workflow. Use its guided updater.")
    check()
    if I._hash(manifest_path, check=check)[1] != package["manifest_sha256"]:
        H._fail("The prepared manifest changed during verification. Download and review it again.")
    L.python_path(root)
    check()
    check_helper_blockers(root, check=check)
    check()
    return source


class SetupUncertain(H.HostControlError):
    pass


def setup_generation_state(child):
    """Only the exact process created by our setup call can confirm its exit."""
    import psutil
    if (not isinstance(child, dict) or type(child.get('pid')) is not int
            or child['pid'] <= 0 or type(child.get('created_at')) not in (int, float)
            or not math.isfinite(child['created_at'])):
        return 'unknown'
    try:
        return 'running' if abs(psutil.Process(child['pid']).create_time() - child['created_at']) < 0.01 else 'exited'
    except psutil.NoSuchProcess:
        return 'exited'
    except Exception:
        return 'unknown'


def prepare_dependencies(root, settings, *, timeout=900, record_child=None, on_timeout=None, on_exit=None):
    """Run only the installed setup entry point; timeout never kills its tree."""
    root = H.root_path(root)
    if sys.platform == 'win32':
        shell = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        command = [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(root / 'TLI_Bootstrap.ps1'), '-SetupOnly']
    elif sys.platform == 'darwin':
        command = ['/bin/bash', str(root / 'TLI_Start.sh'), '--setup-only']
    else:
        H._fail('The automatic dependency setup is unavailable for this platform.')
    environment = L.child_environment(root, settings)
    for name in list(environment):
        if name.upper().startswith('PIP_') or name.casefold() in {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}:
            environment.pop(name)
    environment.update(PIP_CONFIG_FILE=os.devnull, PIP_NO_INPUT='1', PIP_KEYRING_PROVIDER='disabled')
    log = H.path_for(root, 'update-setup.log')
    log.parent.mkdir(parents=True, exist_ok=True)
    # Bounded private output. Raw setup output never becomes an HTTP error.
    stream = log.open('wb')
    from process_utils import hidden_process_kwargs
    try:
        child = subprocess.Popen(command, cwd=root, env=environment, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, shell=False,
                                 **hidden_process_kwargs())
    except Exception:
        stream.close()
        raise

    def drain():
        remaining = 2 * 1024 * 1024
        try:
            while chunk := child.stdout.read(8192):
                if remaining:
                    stream.write(chunk[:remaining]); stream.flush()
                    remaining = max(0, remaining - len(chunk))
        finally:
            stream.close()
            child.stdout.close()
    reader = threading.Thread(target=drain, name='tli-update-setup-output', daemon=True)
    reader.start()
    uncertain = False
    try:
        if record_child:
            import psutil
            record_child({'pid': child.pid, 'created_at': psutil.Process(child.pid).create_time()})
        result = child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        uncertain = True
        try:
            if on_timeout: on_timeout()
        finally:
            # Keep this worker and its bounded pipe drain alive. No second install
            # or restart is authorized by eventual completion of a timed-out job.
            result = child.wait()
    except Exception:
        # A process may already exist even when receipt capture failed. Retain
        # the worker and drain until this exact child exits; never kill it.
        child.wait()
        raise
    reader.join(timeout=5)
    if on_exit: on_exit()
    if uncertain:
        raise SetupUncertain(503, 'Dependency setup exceeded the confirmation timeout and has now exited. TLI was not restarted. Review update-setup.log, then explicitly open TLI; no automatic retry was scheduled.')
    if result != 0:
        H._fail('The application update was installed, but dependency setup failed. Review update-setup.log and run normal setup before opening TLI. Saved data, models and recovery files remain in place.', 503)
