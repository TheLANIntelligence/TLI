"""Fixed-installation launcher and bounded proof of an existing local backend."""
from __future__ import annotations

import hashlib
import http.client
import json
import math
import os
import re
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import time
import webbrowser

import host_control as H
import startup_config
from runtime_preflight import RuntimeUnavailable, check_windows_runtime


def _loopback(settings):
    return "::1" if ":" in settings["host"] else "127.0.0.1"


def runtime_paths(root):
    """Windows venv redirectors spawn the configured base Python executable."""
    root = Path(root).resolve()
    commands = {str((root / 'backend/.venv/Scripts/python.exe').resolve()).casefold(),
                str((root / 'backend/.venv/Scripts/pythonw.exe').resolve()).casefold(),
                str((root / 'backend/.venv/bin/python').resolve()).casefold()}
    executables = set(commands)
    config = root / 'backend/.venv/pyvenv.cfg'
    if config.is_file():
        for line in config.read_text(encoding='utf-8').splitlines():
            key, _, value = line.partition('=')
            if key.strip().lower() == 'home':
                base = Path(value.strip())
                if base.is_absolute():
                    executables.update(str((base / name).resolve()).casefold() for name in ('python.exe', 'pythonw.exe'))
    return commands, executables


def matches_process(root, process, script_name):
    commands, executables = runtime_paths(root)
    command = process.cmdline()
    if len(command) < 2 or not _fixed_arguments(script_name, command[2:]):
        return False
    argv_python, executable = Path(command[0]), Path(process.exe())
    if not argv_python.is_absolute() or not executable.is_absolute():
        return False
    argv_python, executable = str(argv_python.resolve()).casefold(), str(executable.resolve()).casefold()
    # Python 3.12's Windows venv redirector rewrites argv[0] to the configured
    # base executable. Newer versions preserve the venv command. Both refer to
    # the same owned interpreter; an arbitrary Python path is never sufficient.
    if executable not in executables or not (
            argv_python in commands or (argv_python == executable and executable in executables - commands)):
        return False
    script = Path(command[1])
    if not script.is_absolute():
        script = Path(process.cwd()) / script
    return script.resolve() == Path(root).resolve() / 'backend' / script_name


def _fixed_arguments(script_name, arguments):
    if script_name == 'host_lifecycle.py':
        return len(arguments) == 2 and arguments[0] == '--request' and bool(re.fullmatch(r'[a-f0-9]{32,64}', arguments[1]))
    return script_name in {'main.py', 'host_control_server.py'} and not arguments


def pending_backend(root):
    """Recognize a still-starting owned child; never stop or adopt another PID."""
    try:
        import psutil
        root = Path(root).resolve()
        _, executables = runtime_paths(root)
        for process in psutil.process_iter(['exe', 'cmdline', 'cwd']):
            try:
                info = process.info
                executable = info.get('exe')
                if not executable or str(Path(executable).resolve()).casefold() not in executables:
                    continue
                if matches_process(root, process, 'main.py'):
                    return True
            except (OSError, ValueError, psutil.Error):
                continue
    except Exception:
        H._fail('Owned-process state could not be checked; no second backend was started.', 503)
    return False


def inspect_backend(root, settings):
    """Only loopback; never infer ownership from an open port or /status label."""
    identity = H.installation(root)
    host, port = _loopback(settings), settings["port"]
    # A free exclusive bind is stronger evidence than Windows' sometimes-delayed
    # connection-refused response. Never treat a timeout as proof of a free port.
    from launch_checks import check_port
    try:
        check_port(settings['host'], port)
        if pending_backend(root):
            return "starting", "An owned backend process exists but is not yet listening. No second process was started."
        return "stopped", "No backend is listening at this installation's saved address."
    except RuntimeError:
        pass  # occupied or unavailable: require positive ownership proof below
    challenge = secrets.token_hex(32)
    connection = None
    try:
        if settings["https"]:
            cert_path = Path(root) / "data/tls/cert.pem"
            context = ssl.create_default_context(cafile=str(cert_path))
            connection = http.client.HTTPSConnection("localhost", port, context=context, timeout=2)
            connection.connect()
            from cryptography import x509
            from cryptography.hazmat.primitives import serialization
            expected = x509.load_pem_x509_certificate(cert_path.read_bytes()).public_bytes(serialization.Encoding.DER)
            if not secrets.compare_digest(connection.sock.getpeercert(binary_form=True), expected):
                raise ValueError("Certificate mismatch")
        else:
            connection = http.client.HTTPConnection(host, port, timeout=2)
        connection.request("GET", "/api/host-control/v1/identity?challenge=" + challenge,
                           headers={"Accept": "application/json", "Connection": "close"})
        response = connection.getresponse()
        raw = response.read(4097)
        if response.status != 200 or len(raw) > 4096:
            raise ValueError("Unrecognized backend")
        value = json.loads(raw)
        if (value.get("schema_version") != 1 or value.get("installation_id") != identity["installation_id"]
                or not isinstance(value.get("proof"), str) or not secrets.compare_digest(value["proof"], H.proof(identity, challenge))):
            raise ValueError("Identity mismatch")
        return "running", "The running backend proved this installation's identity. Refresh the TLI connection for current readiness."
    except Exception:
        return "unavailable", "The saved port is occupied, but this TLI installation could not be verified. No process was stopped or replaced."
    finally:
        if connection:
            connection.close()


class ReleaseVerificationError(H.HostControlError):
    def __init__(self, detail, *, restart_required=False):
        super().__init__(409, detail)
        self.restart_required = restart_required


def verify_release(root, settings):
    """Do not open a process that still serves application code from before an update."""
    from release_identity import ReleaseIdentity
    expected = ReleaseIdentity(Path(root)).loaded
    connection = None
    restart_required = False
    try:
        if expected is None:
            raise ValueError("Local application identity is unavailable")
        if settings["https"]:
            context = ssl.create_default_context(cafile=str(Path(root) / "data/tls/cert.pem"))
            connection = http.client.HTTPSConnection("localhost", settings["port"], context=context, timeout=5)
        else:
            connection = http.client.HTTPConnection(_loopback(settings), settings["port"], timeout=5)
        connection.request("GET", "/api/diagnostics/version",
                           headers={"Accept": "application/json", "Connection": "close"})
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536:
            raise ValueError("Release identity response unavailable")
        release = json.loads(raw)["release"]
        restart_required = (release.get('compatibility', {}).get('state') == 'restart_required'
                            or (isinstance(release.get('source_id'), str)
                                and release['source_id'] != expected['source_id']))
        if (release.get("compatibility", {}).get("state") != "matched"
                or release.get("source_id") != expected["source_id"]
                or release.get("on_disk", {}).get("source_id") != expected["source_id"]):
            raise ValueError("Running application does not match this release")
    except Exception as error:
        raise ReleaseVerificationError("The running TLI has not confirmed this release's application files. "
                "Finish active work and use Restart TLI in the existing local app, or Stop TLI in local setup, "
                "then open this release again. No process was stopped or replaced.",
                restart_required=restart_required) from error
    finally:
        if connection:
            connection.close()


def python_path(root, *, windowless=False):
    root = H.root_path(root)
    if os.name == "nt":
        base = root / "backend/.venv/Scripts"
        selected = base / ("pythonw.exe" if windowless else "python.exe")
        if not selected.is_file() and windowless:
            selected = base / "python.exe"
    else:
        selected = root / "backend/.venv/bin/python"
    if not selected.is_file():
        H._fail("This installation's Python environment is missing. Run TLI_Start.bat locally to complete setup.", 503)
    return selected


def child_environment(root, settings):
    env = os.environ.copy()
    for key in ("TLI_ROOT", "TLI_HOST", "TLI_PORT", "TLI_ENABLE_TLS", "TLI_LAN_MODE", "TLI_OPEN_BROWSER", "PYTHONPATH", "PYTHONHOME"):
        env.pop(key, None)
    env.update(TLI_ROOT=str(H.root_path(root)), TLI_HOST=settings["host"], TLI_PORT=str(settings["port"]),
               TLI_ENABLE_TLS="1" if settings["https"] else "0", TLI_OPEN_BROWSER="0", PYTHONUTF8="1")
    env["TLI_MANAGED_CHILD"] = H.installation(root)["installation_id"]
    return env


def spawn_fixed(root, script_name, arguments=(), *, settings=None):
    """All callers provide compile-time script names, never HTTP inputs."""
    if not _fixed_arguments(script_name, arguments):
        H._fail("Unsupported launcher entry point.")
    root = H.root_path(root)
    script = root / "backend" / script_name
    if not script.is_file() or script.is_symlink() or script.resolve().parent != (root / "backend").resolve():
        H._fail("The fixed backend entry point is unavailable.")
    log = H.path_for(root, {"main.py": "backend.log", "host_control_server.py": "helper.log", "host_lifecycle.py": "lifecycle.log"}[script_name])
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists() and log.stat().st_size > 2 * 1024 * 1024:
        os.replace(log, log.with_suffix(".previous.log"))
    env = child_environment(root, settings or startup_config.resolve(root, environ={})["effective_next"])
    kwargs = {"cwd": str(root / "backend"), "env": env, "stdin": subprocess.DEVNULL,
              "shell": False, "close_fds": True}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    with log.open("ab", buffering=0) as stream:
        child = subprocess.Popen([str(python_path(root, windowless=True)), str(script), *arguments],
                                 stdout=stream, stderr=stream, **kwargs)
    import psutil
    def capture_failed(message):
        H._fail(message + "\n\nOpen logs to review " + str(log)
                + ". No second process was started.", 503)

    try:
        process = psutil.Process(child.pid)
        commands, executables = runtime_paths(root)
        # Record the real interpreter generation, not Windows' venv redirector PID.
        # Reach it through the exact Popen child, never by port or process-name guessing.
        if os.name == 'nt' and executables - commands:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                exit_code = child.poll()
                if exit_code is not None:
                    capture_failed(f"TLI's background process stopped during startup (exit code {exit_code}).")
                try:
                    candidates = [proc for proc in process.children() if matches_process(root, proc, script_name)]
                    if len(candidates) > 1:
                        capture_failed("More than one background interpreter matched this launch. TLI could not safely choose one.")
                    if len(candidates) == 1:
                        process = candidates[0]
                        break
                    if str(Path(process.exe()).resolve()).casefold() in executables - commands:
                        break
                except (OSError, ValueError, psutil.Error):
                    pass  # Windows may not expose the new child's metadata immediately.
                time.sleep(0.02)
            else:
                capture_failed("Windows has not confirmed the identity of TLI's background process.")
        if not matches_process(root, process, script_name):
            capture_failed("The launched interpreter did not match this TLI installation.")
        return {"pid": process.pid, "created_at": process.create_time(), "script": script_name}
    except (OSError, ValueError, psutil.Error):
        exit_code = child.poll()
        if exit_code is not None:
            capture_failed(f"TLI's background process stopped before startup could be confirmed (exit code {exit_code}).")
        capture_failed("Windows could not inspect TLI's background process.")


def child_alive(root, child):
    if not isinstance(child, dict) or type(child.get("pid")) is not int or child.get("script") not in {"main.py", "host_control_server.py", "host_lifecycle.py"}:
        return False
    try:
        import psutil
        process = psutil.Process(child["pid"])
        return (abs(process.create_time() - child["created_at"]) < 0.01
                and matches_process(root, process, child['script']))
    except Exception:
        return False


def process_generation_state(root, child):
    """A failed process probe is never evidence that the owned generation exited."""
    if (not isinstance(child, dict) or type(child.get('pid')) is not int or child['pid'] <= 0
            or type(child.get('created_at')) not in (int, float) or not math.isfinite(child['created_at'])
            or child.get('script') not in {'main.py', 'host_lifecycle.py'}):
        return 'unknown'
    try:
        import psutil
    except ImportError:
        return 'unknown'
    try:
        process = psutil.Process(child['pid'])
        if abs(process.create_time() - child['created_at']) >= 0.01:
            return 'exited'  # PID reuse proves only the recorded generation ended.
        return 'running' if matches_process(root, process, child['script']) else 'unknown'
    except psutil.NoSuchProcess:
        return 'exited'
    except Exception:
        return 'unknown'


def spawn_backend(root, settings):
    # Recheck inside launch lease immediately before spawn. No port killing.
    state, reason = inspect_backend(root, settings)
    if state != "stopped":
        H._fail(reason)
    from launch_checks import check_port
    check_port(settings["host"], settings["port"])
    return spawn_fixed(root, "main.py", settings=settings)


class PackagedRuntimeUnavailable(H.HostControlError):
    """Only a failed optional inference prerequisite can become a launch advisory."""


def check_packaged_runtime(root):
    """Strict diagnostic check; everyday launch handles this optional failure."""
    try:
        check_windows_runtime(Path(root) / "backend/ai/runtime/llama_server.exe")
    except RuntimeUnavailable as error:
        raise PackagedRuntimeUnavailable(503, str(error)) from error


def launch(root, *, open_browser=True, wait_seconds=300, progress=None, settings=None):
    root = H.root_path(root)
    report = progress or (lambda message: None)
    report("Checking whether TLI is already running...")
    child = None
    runtime_warning = None
    with H.FileLock(H.path_for(root, "launch.lock")):
        H.installation(root, create=True)
        settings = startup_config.resolve(root)["effective_next"] if settings is None else startup_config.validate(settings)
        state, reason = inspect_backend(root, settings)
        if state == "unavailable":
            H._fail(reason)
        if state == "stopped":
            try:
                check_packaged_runtime(root)
            except PackagedRuntimeUnavailable as error:
                runtime_warning = error.detail
                report("Local AI needs attention. Opening TLI so you can continue setup.")
            report("Starting TLI. Local AI can take a few minutes to load; this window will show progress.")
            child = spawn_backend(root, settings)
            H.write_json(H.path_for(root, "desktop-child.json"), child)
        elif state == "starting":
            report("TLI is already starting. Waiting for it to open; no second copy will be started.")
    started = time.monotonic()
    deadline = started + wait_seconds
    next_progress = started + 5
    while state != "running" and time.monotonic() < deadline:
        time.sleep(0.3)
        state, reason = inspect_backend(root, settings)
        if state != "running" and (state == "stopped" or (child is not None and not child_alive(root, child))):
            H._fail(
                "TLI stopped before it could open. See " + str(H.path_for(root, "backend.log"))
                + ". Run TLI_Diagnostics.bat to see the startup error. No second process was started.", 503)
        now = time.monotonic()
        if state != "running" and now >= next_progress:
            report(f"Still starting TLI ({int(now - started)} seconds). Waiting for its secure readiness check...")
            next_progress = now + 5
    if state != "running":
        if state == "starting":
            H._fail(
                "TLI is still starting and has not confirmed readiness. Run TLI_Start.bat again to keep waiting; "
                "it will reuse the existing process. See " + str(H.path_for(root, "backend.log")) + ".", 503)
        H._fail("TLI has not confirmed readiness. See " + str(H.path_for(root, "backend.log"))
                + "; no second process was started.", 503)
    report("Verifying this release before opening TLI...")
    verify_release(root, settings)
    url = startup_config.browser_url(settings)
    report("TLI is ready at " + url)
    if open_browser:
        if not webbrowser.open(url):
            report("Your browser did not open automatically. Open the address above to use TLI.")
    result = {"backend_state": state, "reason": reason, "url": url}
    if runtime_warning:
        result["runtime_warning"] = runtime_warning
    return result


def recorded_backend_generations(root):
    candidates = []
    try:
        candidates.append(H.read_json(H.path_for(root, 'desktop-child.json'), 16384))
    except FileNotFoundError:
        pass
    try:
        receipt = H.read_json(H.path_for(root, 'requests.json'))
        candidates.extend(item.get('child') for item in receipt['requests'] if item.get('phase') == 'accepted')
    except FileNotFoundError:
        pass
    return [child for child in candidates if isinstance(child, dict) and child.get('script') == 'main.py']


def recorded_backend_children(root):
    return [child for child in recorded_backend_generations(root) if child_alive(root, child)]


def current_backend_settings(root, child):
    """Read only the fixed startup fields of the positively identified process.

    Saved preferences can already describe the *next* listener. They must not
    prevent a user from closing the current listener after a network change.
    """
    import psutil
    if process_generation_state(root, child) != 'running':
        H._fail('TLI process status could not be confirmed. Check status again.', 503)
    environment = psutil.Process(child['pid']).environ()
    startup = {key: environment[key] for key in
               ('TLI_HOST', 'TLI_PORT', 'TLI_ENABLE_TLS', 'TLI_LAN_MODE') if key in environment}
    if process_generation_state(root, child) != 'running':
        H._fail('The TLI process changed while checking its address. Check status again.')
    return startup_config.resolve(root, environ=startup)['effective_next']


def _desktop_snapshot(root):
    root = H.root_path(root)
    next_settings = startup_config.resolve(root, environ={})['effective_next']
    children = {}
    for child in recorded_backend_generations(root):
        generation = process_generation_state(root, child)
        if generation == 'unknown':
            H._fail('TLI process status could not be confirmed. Check status again; it has not been reported stopped.', 503)
        if generation == 'running':
            children[child['pid']] = child
    if len(children) > 1:
        H._fail('More than one recorded TLI process is running. Open logs to review this installation.')
    child = next(iter(children.values()), None)
    settings = current_backend_settings(root, child) if child else next_settings
    state, reason = inspect_backend(root, settings)
    if child and state == 'stopped':
        state, reason = 'starting', 'TLI has a running background process but its listener is not ready.'
    return {'state': state, 'message': reason, 'child': child,
            'current_settings': settings, 'next_settings': next_settings}


def _desktop_token(root, snapshot, bucket):
    """A short-lived review bound to this installation and exact generation.

    Polling does not invalidate an open confirmation. A reused PID, new process
    or changed listener preferences invalidate every outstanding confirmation.
    """
    import hmac
    identity = H.installation(root)
    payload = {key: snapshot[key] for key in ('child', 'current_settings', 'next_settings')}
    payload.update(installation_id=identity['installation_id'], bucket=bucket)
    return hmac.new(bytes.fromhex(identity['secret']), b'tli-launcher-review-v1:' +
                    json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode(),
                    hashlib.sha256).hexdigest()


def desktop_status(root, *, issue_token=True):
    """Local UI projection. A failed check never means the host has stopped."""
    result = {'state': 'unverified', 'can_stop': False, 'can_restart': False,
              'can_open': False, 'requires_restart': False}
    try:
        snapshot = _desktop_snapshot(root)
        state = snapshot['state']
        result.update(state=state if state in {'running', 'stopped', 'starting'} else 'unverified',
                      message=snapshot['message'])
        if state == 'stopped':
            result['message'] = 'TLI is stopped. Close this window before running the updater.'
        elif state == 'running':
            controlled = snapshot['child'] is not None
            result.update(can_stop=controlled, can_restart=controlled)
            if controlled and issue_token:
                result['action_token'] = _desktop_token(root, snapshot, int(time.time() // 30))
            try:
                verify_release(root, snapshot['current_settings'])
                result.update(can_open=True, url=startup_config.browser_url(snapshot['current_settings']),
                              message='TLI is running. You can open, restart or stop it here.' if controlled else
                              'TLI is running in a diagnostic session. Close it in its original console.')
            except H.HostControlError as error:
                required = bool(getattr(error, 'restart_required', False))
                message = ('TLI is still running with earlier application files. Restart TLI to load the update.' if required else
                           'TLI is running, but its current application files could not be confirmed. Check status again or restart TLI.')
                result.update(requires_restart=required, message=message if controlled else
                              'TLI is still running in a diagnostic session. Close its original console, then open TLI again.')
        return result
    except Exception as error:
        result.update(state='unverified', can_stop=False, can_restart=False, can_open=False,
                      message=str(getattr(error, 'detail', error)))
        result.pop('action_token', None)
        result.pop('url', None)
        return result


def desktop_action(root, action, token, *, progress=None):
    """Explicit native confirmation; never exposed as an unauthenticated API."""
    if action not in {'stop', 'restart'} or not isinstance(token, str) or not H.HEX.fullmatch(token):
        H._fail('Check TLI status and review Stop or Restart before continuing.', 422)
    root = H.root_path(root)
    report = progress or (lambda message: None)
    with H.FileLock(H.path_for(root, 'desktop-action.lock')):
        snapshot = _desktop_snapshot(root)
        bucket = int(time.time() // 30)
        if (snapshot['state'] != 'running' or snapshot['child'] is None or
                not any(secrets.compare_digest(token, _desktop_token(root, snapshot, candidate))
                        for candidate in range(bucket, bucket - 4, -1))):
            H._fail('TLI or its settings changed, or this review expired. Check status and review the action again.')
        report('Stopping TLI. Waiting for its background process to finish...')
        stop_owned_backend(root, expected_child=snapshot['child'], settings=snapshot['current_settings'])
        if process_generation_state(root, snapshot['child']) != 'exited':
            H._fail('TLI shutdown could not be confirmed. Check status again; no restart was attempted.', 503)
        if action == 'stop':
            return None
        if startup_config.resolve(root, environ={})['effective_next'] != snapshot['next_settings']:
            H._fail('TLI stopped, but startup settings changed. Review them before opening TLI again.')
        report('TLI has stopped. Starting the updated application...')
        return launch(root, open_browser=False, wait_seconds=300, progress=report,
                      settings=snapshot['next_settings'])


def stop_owned_backend(root, *, wait_seconds=40, expected_child=None, settings=None):
    """Gracefully stop a recorded generation after local explicit confirmation.

    Managed desktop lifecycle uses an independent helper and an exact previewed
    generation. HTTP handlers must never wait here for their own process exit.
    """
    root = H.root_path(root)
    identity = H.installation(root)
    settings = startup_config.resolve(root)['effective_next'] if settings is None else startup_config.validate(settings)
    with H.FileLock(H.path_for(root, 'launch.lock')):
        children = {child['pid']: child for child in recorded_backend_children(root)}
        if len(children) != 1:
            H._fail('Exactly one recorded owned backend is required. No process was stopped; use the original diagnostic console if applicable.')
        child = next(iter(children.values()))
        if expected_child is not None and child != expected_child:
            H._fail('The reviewed backend generation changed. No stop was requested.')
        state, reason = inspect_backend(root, settings)
        if state != 'running':
            H._fail('A running owned backend must prove its identity before Stop TLI. ' + reason)
        # Bind the local request to the process generation, not just a recycled PID.
        nonce = secrets.token_hex(16)
        issued_at = time.time()
        message = f"stop:{child['pid']}:{child['created_at']}:{nonce}:{issued_at}"
        import hmac
        signature = hmac.new(bytes.fromhex(identity['secret']), message.encode(), hashlib.sha256).hexdigest()
        if not child_alive(root, child):
            H._fail('The recorded backend changed before stop. No stop was requested.')
        if process_generation_state(root, child) != 'running':
            H._fail('The reviewed backend process could not be verified before stop. No stop was requested.')
        H.write_json(H.path_for(root, 'stop-backend.json'), {**child, 'nonce': nonce, 'proof': signature, 'at': issued_at})
        deadline = time.monotonic() + wait_seconds
        while True:
            state = process_generation_state(root, child)
            if state == 'exited':
                return {'stopped': True, 'reason': 'The reviewed backend generation exited. No process was forcibly terminated.'}
            if state == 'unknown':
                H._fail('The reviewed backend exit could not be confirmed. No forced termination or restart was used.', 503)
            if time.monotonic() >= deadline:
                H._fail('The owned backend has not confirmed graceful shutdown. No forced termination was used; inspect backend.log.', 503)
            time.sleep(0.2)


def dependencies_ready(root):
    """Check installed metadata; do not hit a package index during everyday launch."""
    import importlib.metadata
    try:
        from pip._vendor.packaging.requirements import Requirement
        for line in (Path(root) / "backend/requirements.txt").read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            requirement = Requirement(line)
            if requirement.marker is not None and not requirement.marker.evaluate():
                continue
            if importlib.metadata.version(requirement.name) not in requirement.specifier:
                return False
        return True
    except Exception:
        return False


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-dependencies", action="store_true")
    parser.add_argument("--check-runtime", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent  # fixed code installation; ignore inherited TLI_ROOT
    if args.check_dependencies:
        raise SystemExit(0 if dependencies_ready(root) else 1)
    if args.check_runtime:
        try:
            check_packaged_runtime(root)
        except H.HostControlError as error:
            print(error.detail, file=sys.stderr, flush=True)
            raise SystemExit(1)
        return
    try:
        launch(root, open_browser=not args.no_browser, progress=lambda message: print(message, flush=True))
    except Exception as error:
        detail = str(getattr(error, "detail", error))
        print("TLI was not confirmed ready: " + detail, file=sys.stderr, flush=True)
        if os.name == "nt":
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, detail + "\n\nUse TLI_Diagnostics.bat for a visible diagnostic launch.", "TLI could not open", 0x10)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
