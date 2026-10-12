"""Synthetic Windows interpreter trees; no executable, server, or browser runs."""
from pathlib import Path
from types import SimpleNamespace

import pytest
import psutil

import host_control as H
import host_launcher as L
import launch_checks


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        assert 0 < seconds <= 1
        self.now += seconds


class Process:
    def __init__(self, pid, executable, command, cwd, *, created=1700000000.5):
        self.pid = pid
        self.executable = str(executable)
        self.command = list(map(str, command))
        self.directory = str(cwd)
        self.created = created
        self.descendants = []
        self.alive = True
        self.denied = False

    def _check(self):
        if not self.alive:
            raise psutil.NoSuchProcess(self.pid)
        if self.denied:
            raise psutil.AccessDenied(self.pid)

    def exe(self):
        self._check()
        return self.executable

    def cmdline(self):
        self._check()
        return list(self.command)

    def cwd(self):
        self._check()
        return self.directory

    def create_time(self):
        self._check()
        return self.created

    def is_running(self):
        return self.alive

    def children(self, recursive=False):
        self._check()
        assert recursive is False, "This fixture exercises the supported direct-child topology."
        return [child for child in self.descendants if child.alive]

    @property
    def info(self):
        return {"exe": self.exe(), "cmdline": self.cmdline(), "cwd": self.cwd()}


@pytest.fixture
def tree(tmp_path, monkeypatch):
    root = tmp_path / "Synthetic TLI installation"
    backend = root / "backend"
    scripts = backend / ".venv/Scripts"
    scripts.mkdir(parents=True)
    for name in ("python.exe", "pythonw.exe"):
        (scripts / name).write_bytes(b"fixture only - never executed")
    main = backend / "main.py"
    main.write_text("# fixture only - never executed\n", encoding="utf-8")
    base = tmp_path / "Configured Python 3.12"
    base.mkdir()
    (backend / ".venv/pyvenv.cfg").write_text(f"home = {base}\nversion = 3.12.9\n", encoding="utf-8")
    H.installation(root, create=True)
    settings = {"host": "127.0.0.1", "port": 18765, "https": False}
    clock = Clock()
    redirector = Process(4100, scripts / "pythonw.exe", [scripts / "pythonw.exe", main], backend)
    interpreter = Process(4110, base / "pythonw.exe", [base / "pythonw.exe", main], backend, created=1700000000.75)
    redirector.descendants = [interpreter]
    processes = {p.pid: p for p in (redirector, interpreter)}
    calls = []
    state = SimpleNamespace(root=root, backend=backend, scripts=scripts, base=base, main=main,
                            settings=settings, clock=clock, redirector=redirector,
                            interpreter=interpreter, processes=processes, calls=calls,
                            after_spawn=lambda: None)

    # Swap this module's OS facade, not shared os.name; pathlib/pytest retain
    # their native path classes if these portable synthetic tests run on Linux.
    monkeypatch.setattr(L, "os", SimpleNamespace(name="nt", environ=L.os.environ.copy(), replace=L.os.replace))
    monkeypatch.setattr(L, "time", SimpleNamespace(monotonic=clock.monotonic, sleep=clock.sleep))
    monkeypatch.setattr(L.startup_config, "resolve", lambda *_a, **_k: {"effective_next": settings})
    monkeypatch.setattr(L.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    monkeypatch.setattr(L.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200, raising=False)

    def popen(command, **options):
        calls.append((list(command), options))
        assert command == [str(scripts / "pythonw.exe"), str(main)]
        assert options["shell"] is False
        assert options["creationflags"] & L.subprocess.CREATE_NO_WINDOW
        state.after_spawn()
        return SimpleNamespace(pid=redirector.pid, poll=lambda: None if redirector.alive else 1)

    def process(pid):
        value = processes.get(pid)
        if value is None or not value.alive:
            raise psutil.NoSuchProcess(pid)
        return value

    monkeypatch.setattr(L.subprocess, "Popen", popen)
    monkeypatch.setattr(psutil, "Process", process)
    monkeypatch.setattr(psutil, "process_iter", lambda *_a, **_k: iter([p for p in processes.values() if calls and p.alive]))
    monkeypatch.setattr(launch_checks, "check_port", lambda *_a, **_k: None)
    monkeypatch.setattr(L, "check_packaged_runtime", lambda *_a, **_k: None)
    monkeypatch.setattr(L, "verify_release", lambda *_a, **_k: pytest.fail("No listener proved readiness"))
    monkeypatch.setattr(L.webbrowser, "open", lambda *_a, **_k: pytest.fail("No real browser should open"))
    return state


@pytest.mark.parametrize("command_form", ["3.12-base-argv", "3.13-venv-argv"])
def test_configured_windows_interpreter_command_forms_match(tree, command_form):
    if command_form == "3.13-venv-argv":
        tree.interpreter.command[0] = str(tree.scripts / "pythonw.exe")
    assert L.matches_process(tree.root, tree.interpreter, "main.py")
    commands, executables = L.runtime_paths(tree.root)
    assert str((tree.scripts / "pythonw.exe").resolve()).casefold() in commands
    assert str((tree.base / "pythonw.exe").resolve()).casefold() in executables


@pytest.mark.parametrize("tamper", [
    "foreign-argv", "foreign-exe", "different-base-exe", "foreign-script",
    "relative-script-foreign-cwd", "extra-args", "relative-argv", "relative-exe",
])
def test_process_match_rejects_wrong_installation_executable_or_arguments(tree, tamper):
    process = tree.interpreter
    if tamper == "foreign-argv":
        process.command[0] = str(tree.root.parent / "Foreign Python/pythonw.exe")
    elif tamper == "foreign-exe":
        process.executable = str(tree.root.parent / "Foreign Python/pythonw.exe")
    elif tamper == "different-base-exe":
        # Both are allowed base paths, but a base argv[0] must agree with exe().
        process.command[0] = str(tree.base / "python.exe")
    elif tamper == "foreign-script":
        process.command[1] = str(tree.root.parent / "Another TLI/backend/main.py")
    elif tamper == "relative-script-foreign-cwd":
        process.command[1] = "main.py"
        process.directory = str(tree.root.parent / "Another TLI/backend")
    elif tamper == "extra-args":
        process.command += ["--root", str(tree.root.parent)]
    elif tamper == "relative-argv":
        process.command[0] = "pythonw.exe"
    elif tamper == "relative-exe":
        process.executable = "pythonw.exe"
    assert not L.matches_process(tree.root, process, "main.py")


def test_matching_relative_script_requires_this_backend_directory(tree):
    tree.interpreter.command[1] = "main.py"
    assert L.matches_process(tree.root, tree.interpreter, "main.py")


def test_executable_path_is_canonicalized_before_comparison(tree):
    # psutil and the recorded command can spell the same absolute path differently.
    tree.interpreter.executable = str(tree.base / "unused" / ".." / "pythonw.exe")
    assert L.matches_process(tree.root, tree.interpreter, "main.py")


@pytest.mark.parametrize("command_form", ["3.12-base-argv", "3.13-venv-argv"])
def test_spawn_records_single_real_interpreter_descendant_not_redirector(tree, command_form):
    if command_form == "3.13-venv-argv":
        tree.interpreter.command[0] = str(tree.scripts / "pythonw.exe")
    child = L.spawn_fixed(tree.root, "main.py", settings=tree.settings)
    assert child == {"pid": tree.interpreter.pid, "created_at": tree.interpreter.created, "script": "main.py"}
    assert child["pid"] != tree.redirector.pid
    assert L.child_alive(tree.root, child)
    assert L.pending_backend(tree.root)
    assert len(tree.calls) == 1


def test_direct_interpreter_can_appear_after_old_three_second_deadline(tree, monkeypatch):
    children = tree.redirector.children
    monkeypatch.setattr(tree.redirector, "children", lambda recursive=False: [] if tree.clock.now < 4 else children(recursive))
    child = L.spawn_fixed(tree.root, "main.py", settings=tree.settings)
    assert child["pid"] == tree.interpreter.pid
    assert 4 <= tree.clock.now < 5
    assert len(tree.calls) == 1


def test_transient_child_metadata_access_denied_is_retried_within_capture_bound(tree, monkeypatch):
    children = tree.redirector.children

    def initially_unavailable(recursive=False):
        if tree.clock.now < 0.1:
            raise psutil.AccessDenied(tree.redirector.pid)
        return children(recursive)

    monkeypatch.setattr(tree.redirector, "children", initially_unavailable)
    child = L.spawn_fixed(tree.root, "main.py", settings=tree.settings)
    assert child["pid"] == tree.interpreter.pid
    assert 0.1 <= tree.clock.now < 1
    assert len(tree.calls) == 1


def test_multiple_matching_direct_children_are_never_selected_arbitrarily(tree):
    other = Process(4111, tree.base / "pythonw.exe", [tree.base / "pythonw.exe", tree.main], tree.backend)
    tree.redirector.descendants.append(other)
    tree.processes[other.pid] = other
    with pytest.raises(H.HostControlError) as failure:
        L.spawn_fixed(tree.root, "main.py", settings=tree.settings)
    assert failure.value.status == 503
    assert str(H.path_for(tree.root, "backend.log")) in failure.value.detail
    assert tree.clock.now < 1, "Ambiguous identity should fail immediately."
    assert len(tree.calls) == 1
    assert tree.redirector.alive and tree.interpreter.alive and other.alive


@pytest.mark.parametrize("failure_mode", ["exited", "metadata-denied", "identity-mismatch"])
def test_capture_failure_is_clear_and_does_not_spawn_or_terminate_again(tree, failure_mode):
    if failure_mode == "exited":
        def exit_on_spawn():
            tree.redirector.alive = tree.interpreter.alive = False
        tree.after_spawn = exit_on_spawn
    elif failure_mode == "metadata-denied":
        tree.redirector.denied = True
    else:
        tree.interpreter.command[1] = str(tree.root.parent / "Foreign TLI/backend/main.py")
    with pytest.raises(H.HostControlError) as failure:
        L.spawn_fixed(tree.root, "main.py", settings=tree.settings)
    assert failure.value.status == 503
    assert str(H.path_for(tree.root, "backend.log")) in failure.value.detail
    assert tree.clock.now <= 11, "Identity capture must stay bounded."
    assert len(tree.calls) == 1
    if failure_mode == "exited":
        assert "exit code 1" in failure.value.detail.lower()
    if failure_mode != "exited":
        assert tree.redirector.alive and tree.interpreter.alive


def test_live_base_argv_interpreter_prevents_duplicate_on_desktop_retry(tree):
    # Keep the port free: only actual process identity, not a mocked startup
    # state or an HTTP response, proves that this installation is still starting.
    for attempt in range(2):
        with pytest.raises(H.HostControlError) as failure:
            L.launch(tree.root, open_browser=False, wait_seconds=1)
        assert failure.value.status == 503
        assert "still starting" in failure.value.detail.lower()
        if attempt == 0:
            # The retry must recognize the base-argv interpreter itself; a
            # surviving venv wrapper must not make this regression pass by proxy.
            tree.redirector.alive = False
    assert len(tree.calls) == 1
    assert L.pending_backend(tree.root)
    recorded = H.read_json(H.path_for(tree.root, "desktop-child.json"))
    assert recorded == {"pid": tree.interpreter.pid, "created_at": tree.interpreter.created, "script": "main.py"}
