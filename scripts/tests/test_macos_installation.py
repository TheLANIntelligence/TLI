"""Synthetic macOS installer archives and source-launcher control flow."""
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = (ROOT / "landing/install_mac.sh").read_text(encoding="utf-8")
PYTHON_SOURCE = INSTALLER.split("<<'TLI_INSTALLER_PY'\n", 1)[1].split("\nTLI_INSTALLER_PY", 1)[0]
INSTALL = {"__name__": "tli_installer_test"}
exec(compile(PYTHON_SOURCE, "install_mac.sh:embedded-python", "exec"), INSTALL)
BASH = (str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
        if os.name == "nt" else shutil.which("bash"))
VERSION = "1.4.0-beta"


class MacInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tli-install-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.applications = self.root / "Applications"

    def archive(self, extra=None, prefix=""):
        path = self.root / "release.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for name in sorted(INSTALL["REQUIRED"]):
                archive.writestr(prefix + name, "synthetic source\n")
            for name, body in (extra or {}).items():
                archive.writestr(name, body)
        # Windows ZipInfo normalizes backslashes when writing; restore the raw
        # name in both ZIP headers to exercise an actual hostile archive name.
        raw = path.read_bytes()
        for name in (extra or {}):
            if isinstance(name, str) and "\\" in name:
                raw = raw.replace(name.replace("\\", "/").encode(), name.encode())
        path.write_bytes(raw)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def install(self, path, digest):
        return INSTALL["install_archive"](path, digest, VERSION, self.applications)

    def test_verified_fresh_install_preserves_old_folder_and_supports_spaces(self):
        old = self.root / "TLI/data/notes.json"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"private synthetic note")
        self.applications = self.root / "Applications With Spaces"
        archive, digest = self.archive()
        target = self.install(archive, digest)
        self.assertEqual(target, self.applications / ("TLI-" + VERSION))
        self.assertTrue((target / "backend/main.py").is_file())
        self.assertEqual(old.read_bytes(), b"private synthetic note")
        if os.name != "nt":
            self.assertTrue((target / "TLI_Start.command").stat().st_mode & stat.S_IXUSR)

    def test_existing_version_is_never_merged_or_removed(self):
        target = self.applications / ("TLI-" + VERSION)
        private = target / "data/notes.json"
        private.parent.mkdir(parents=True)
        private.write_bytes(b"keep exactly")
        archive, digest = self.archive()
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.install(archive, digest)
        self.assertEqual(private.read_bytes(), b"keep exactly")
        self.assertFalse((target / "backend").exists())

    def test_checksum_failure_writes_no_installation(self):
        archive, _ = self.archive()
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.install(archive, "0" * 64)
        self.assertFalse(self.applications.exists())

    def test_unsafe_archive_entries_are_rejected_before_install(self):
        for name in ("../escape.txt", "/absolute.txt", "C:/drive.txt", "backend\\escape.txt",
                     "data/private.json", "frontend/INDEX.HTML"):
            with self.subTest(name=name):
                archive, digest = self.archive({name: "synthetic"})
                with self.assertRaises(ValueError):
                    self.install(archive, digest)
                self.assertFalse(self.applications.exists())
        link = zipfile.ZipInfo("backend/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive, digest = self.archive({link: "../../outside"})
        with self.assertRaisesRegex(ValueError, "unsafe"):
            self.install(archive, digest)

    def test_optional_enclosing_folder_and_runtime_permissions(self):
        runtime = zipfile.ZipInfo("TLI/backend/ai/runtime/macos-arm64/llama-server")
        runtime.create_system = 3
        runtime.external_attr = (stat.S_IFREG | 0o6755) << 16
        archive, digest = self.archive({runtime: "synthetic executable"}, prefix="TLI/")
        target = self.install(archive, digest)
        installed = target / "backend/ai/runtime/macos-arm64/llama-server"
        self.assertTrue(installed.is_file())
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o755)

    def test_manifest_requires_exact_official_asset_and_sha256(self):
        filename = "TLI_" + VERSION + "_macOS.zip"
        asset = {"url": "https://github.com/TheLANIntelligence/TLI/releases/download/v" + VERSION + "/" + filename,
                 "filename": filename, "sha256": "a" * 64}
        manifest = {"version": VERSION, "platforms": {"macos": asset}}
        self.assertEqual(INSTALL["validate_manifest"](manifest), (VERSION, asset["url"], "a" * 64))
        for key, value in (("url", "http://example.com/download.zip"), ("sha256", ""), ("filename", "other.zip")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                INSTALL["validate_manifest"]({"version": VERSION, "platforms": {"macos": {**asset, key: value}}})

    def test_guided_update_and_uninstall_launchers_remain_executable(self):
        launchers = {"TLI_Update.command", "TLI_Update.sh", "Uninstall_TLI.command", "Uninstall_TLI.sh"}
        archive, digest = self.archive({name: "#!/bin/bash\nexit 0\n" for name in launchers})
        target = self.install(archive, digest)
        self.assertTrue(launchers.issubset(INSTALL["EXECUTABLES"]))
        for name in launchers:
            self.assertTrue((target / name).is_file())
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE((target / name).stat().st_mode), 0o755)


@unittest.skipUnless(BASH and Path(BASH).is_file(), "Bash is required for installer checks")
class MacInstallerShellTests(unittest.TestCase):
    """Exercise the actual piped shell entry point without network or installs."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tli-installer-shell-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "Synthetic Mac With Spaces"
        self.root.mkdir()
        self.python = self.root / "python3"
        self.python.write_text('''#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TEST_PYTHON_LOG"
if [ "${PYTHONHOME+x}" = x ] || [ "${PYTHONPATH+x}" = x ]; then
    printf 'Unexpected inherited Python configuration\\n' >&2
    exit 47
fi
if [ "$1" = "-I" ]; then shift; fi
if [ "$1" = "-c" ]; then exit "${TEST_PYTHON_UNSUPPORTED:-0}"; fi
if [ "$1" = "-" ]; then cat > "$TEST_PYTHON_SOURCE"; exit 0; fi
exit 48
''', encoding="utf-8", newline="\n")
        self.python.chmod(0o755)
        self.env = {**os.environ, "TEST_PYTHON": self.python.as_posix(),
                    "TEST_PYTHON_LOG": (self.root / "python-calls.txt").as_posix(),
                    "TEST_PYTHON_SOURCE": (self.root / "received.py").as_posix(),
                    "TEST_OS": "Darwin", "TEST_ARCH": "arm64",
                    "TEST_MAC_VERSION": "14.0", "TEST_PYTHON_AVAILABLE": "1"}

    def run_installer(self):
        # Isolate OS/interpreter discovery even on a real Mac: absolute Homebrew
        # and python.org fallback paths must never select the host's interpreter.
        # Everything after this prelude is the unchanged downloaded shell script.
        prelude = '''
uname() { if [ "$1" = "-s" ]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi; }
sw_vers() { echo "$TEST_MAC_VERSION"; }
command() {
    if [ "$#" = 2 ] && [ "$1" = "-v" ]; then
        case "$2" in
            python*|*/python*)
                if [ "$2" = "${TEST_PYTHON_CANDIDATE:-python3}" ] && [ "$TEST_PYTHON_AVAILABLE" = 1 ]; then
                    printf '%s\\n' "$TEST_PYTHON"
                    return 0
                fi
                return 1 ;;
        esac
    fi
    builtin command "$@"
}
'''
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        return subprocess.run([BASH, "--noprofile", "--norc"], input=prelude + INSTALLER,
                              cwd=self.root, env=self.env, capture_output=True,
                              text=True, encoding="utf-8", timeout=30, **options)

    def test_piped_installer_delivers_complete_embedded_python(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "received.py").read_text(encoding="utf-8"),
                         PYTHON_SOURCE + "\n")
        calls = (self.root / "python-calls.txt").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].startswith("-I -c "))
        self.assertEqual(calls[1], "-")

    def test_stale_python_environment_is_cleared_before_candidate_check(self):
        self.env.update(PYTHONHOME="/unrelated/missing-python", PYTHONPATH="/unrelated/modules")
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "received.py").read_text(encoding="utf-8"),
                         PYTHON_SOURCE + "\n")

    def test_missing_python_explains_prerequisite_without_running_installer(self):
        self.env["TEST_PYTHON_AVAILABLE"] = "0"
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Install standard Python 3.13", result.stderr)
        self.assertFalse((self.root / "python-calls.txt").exists())
        self.assertFalse((self.root / "received.py").exists())

    def test_unsupported_python_stops_before_downloading(self):
        self.env["TEST_PYTHON_UNSUPPORTED"] = "1"
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("final CPython 3.10–3.14 without free-threading", result.stderr)
        self.assertFalse((self.root / "received.py").exists())

    def test_versioned_framework_and_homebrew_are_discovered_without_path(self):
        for candidate in (
                "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13",
                "/usr/local/opt/python@3.13/bin/python3.13",
                "/opt/homebrew/opt/python@3.13/bin/python3.13"):
            with self.subTest(candidate=candidate):
                self.env["TEST_PYTHON_CANDIDATE"] = candidate
                result = self.run_installer()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual((self.root / "received.py").read_text(encoding="utf-8"),
                                 PYTHON_SOURCE + "\n")

    def test_unsupported_platform_stops_before_python_or_network(self):
        for system, architecture, version, message in (
                ("Linux", "x86_64", "14.0", "for macOS"),
                ("Darwin", "arm64", "13.9", "macOS 14 or newer"),
                ("Darwin", "x86_64", "13.2", "macOS 13.3 or newer"),
                ("Darwin", "arm64", "unknown", "Could not determine")):
            with self.subTest(system=system, architecture=architecture, version=version):
                self.env.update(TEST_OS=system, TEST_ARCH=architecture, TEST_MAC_VERSION=version)
                result = self.run_installer()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.root / "python-calls.txt").exists())
                self.assertFalse((self.root / "received.py").exists())


@unittest.skipUnless(BASH and Path(BASH).is_file(), "Bash is required for launcher checks")
class SourceLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tli-launch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "Installation With Spaces"
        self.root.mkdir()
        (self.root / "backend").mkdir()
        for name in ("TLI_Start.sh", "TLI_Start.command"):
            shutil.copyfile(ROOT / name, self.root / name)
        for name in ("main.py", "host_launcher.py", "launch_checks.py", "requirements.txt"):
            (self.root / "backend" / name).write_text("synthetic fixture", encoding="utf-8")
        self.bin = self.root / "fake-bin"
        self.bin.mkdir()
        self.python = self.bin / "python3"
        self.python.write_text('''#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TEST_LOG"
if [ "$1" = "-I" ]; then shift; fi
if [ "$1" = "-c" ]; then
    case "$0" in */.venv/bin/python) exit "${TEST_VENV_UNSUPPORTED:-0}" ;; esac
    exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
    mkdir -p "$3/bin"; cp "$0" "$3/bin/python"; chmod +x "$3/bin/python"; exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
    [ "${TEST_PIP_FAIL:-0}" = "0" ] || exit 2
    touch "$TEST_READY"; exit 0
fi
case "$1" in
    */host_launcher.py)
        [ -f "$TEST_READY" ] || exit 1
        if [ "${2:-}" = --check-dependencies ]; then exit "${TEST_VERIFY_FAIL:-0}"; fi
        [ "${TEST_PORT_FAIL:-0}" = 0 ] || exit 1
        if [ "${2:-}" = --no-browser ]; then echo 0; else echo 1; fi > "$TEST_STARTED"
        exit 0 ;;
    */main.py|*/launch_checks.py) exit 49 ;;
esac
exit 9
''', encoding="utf-8", newline="\n")
        self.python.chmod(0o755)
        shell_bin = self.bin.as_posix()
        if os.name == "nt":
            shell_bin = "/" + shell_bin[0].lower() + shell_bin[2:]
        self.env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", ""), "TEST_BIN": shell_bin,
                    "TEST_LOG": (self.root / "calls.txt").as_posix(), "TEST_READY": (self.root / "ready").as_posix(),
                    "TEST_STARTED": (self.root / "started").as_posix(), "TLI_ROOT": "unrelated-installation",
                    "TLI_OPEN_BROWSER": "1"}

    def launch(self, *arguments, wrapper=False):
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        # Git Bash prepends its own /usr/bin during startup. Put the synthetic
        # commands first inside the shell as well, so uname is fake on Windows.
        prelude = '''
export PATH="$TEST_BIN:$PATH"
command() {
    if [ "$#" = 2 ] && [ "$1" = "-v" ]; then
        case "$2" in
            python*|*/python*)
                if [ "$2" = python3 ]; then printf '%s\\n' "$TEST_BIN/python3"; return 0; fi
                return 1 ;;
        esac
    fi
    builtin command "$@"
}
export -f command
exec bash "$@"
'''
        return subprocess.run([BASH, "-c", prelude, "test-launcher",
                               "TLI_Start.command" if wrapper else "TLI_Start.sh", *arguments],
                              cwd=self.root, env=self.env, capture_output=True, text=True,
                              encoding="utf-8", timeout=30, **options)

    def test_setup_only_then_offline_ready_launch(self):
        result = self.launch("--setup-only", wrapper=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "started").exists())
        calls = (self.root / "calls.txt").read_text()
        self.assertEqual(calls.count("-m pip "), 1)
        self.assertIn("install --only-binary=cryptography -r ", calls)
        result = self.launch("--no-browser")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "started").read_text().strip(), "0")
        self.assertEqual((self.root / "calls.txt").read_text().count("-m pip "), 1)
        self.assertNotIn("/main.py", (self.root / "calls.txt").read_text())
        self.assertIn("Quit TLI", result.stdout)

    def test_default_launch_and_environment_no_browser_use_managed_host(self):
        self.assertEqual(self.launch("--setup-only").returncode, 0)
        result = self.launch(wrapper=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "started").read_text().strip(), "1")
        self.env["TLI_OPEN_BROWSER"] = "0"
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "started").read_text().strip(), "0")

    def test_dependency_failure_and_busy_port_never_start_backend(self):
        self.env["TEST_PIP_FAIL"] = "1"
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertFalse((self.root / "started").exists())
        self.env["TEST_PIP_FAIL"] = "0"
        self.env["TEST_PORT_FAIL"] = "1"
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertFalse((self.root / "started").exists())

    def test_incomplete_existing_environment_is_preserved(self):
        private = self.root / "backend/.venv/keep.txt"
        private.parent.mkdir()
        private.write_bytes(b"do not remove")
        result = self.launch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("incomplete or belongs to another platform", result.stderr)
        self.assertEqual(private.read_bytes(), b"do not remove")
        self.assertFalse((self.root / "started").exists())

    def test_post_install_verification_failure_points_to_recovery_without_starting(self):
        saved = self.root / "data/notes.json"
        saved.parent.mkdir()
        saved.write_bytes(b"saved before dependency repair")
        self.env["TEST_VERIFY_FAIL"] = "1"
        result = self.launch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Installed components could not be verified", result.stderr)
        self.assertIn("docs/TLI_UPDATES.md", result.stderr)
        self.assertIn("Saved data was kept", result.stderr)
        self.assertEqual(saved.read_bytes(), b"saved before dependency repair")
        self.assertFalse((self.root / "started").exists())
        calls = (self.root / "calls.txt").read_text()
        self.assertEqual(calls.count("-m pip "), 1)
        self.assertEqual(calls.count("--check-dependencies"), 2)
        self.assertIn("--only-binary=cryptography", calls)

    def test_unsupported_existing_environment_stops_before_pip_and_preserves_files(self):
        environment = self.root / "backend/.venv"
        (environment / "bin").mkdir(parents=True)
        shutil.copyfile(self.python, environment / "bin/python")
        (environment / "bin/python").chmod(0o755)
        (environment / "keep.txt").write_bytes(b"keep old environment")
        saved = self.root / "data/notes.json"
        saved.parent.mkdir()
        saved.write_bytes(b"keep saved data")
        original = (environment / "bin/python").read_bytes()
        self.env["TEST_VENV_UNSUPPORTED"] = "1"
        result = self.launch("--setup-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported Python build", result.stderr)
        self.assertIn("docs/TLI_UPDATES.md", result.stderr)
        self.assertIn("ORIGINAL folder", result.stderr)
        self.assertEqual((environment / "bin/python").read_bytes(), original)
        self.assertEqual((environment / "keep.txt").read_bytes(), b"keep old environment")
        self.assertEqual(saved.read_bytes(), b"keep saved data")
        calls = (self.root / "calls.txt").read_text()
        self.assertNotIn("-m pip", calls)
        self.assertNotIn("-m venv", calls)
        self.assertNotIn("host_launcher.py", calls)
        self.assertFalse((self.root / "started").exists())

    def test_unsupported_macos_is_stopped_before_environment_setup(self):
        (self.bin / "uname").write_text('#!/usr/bin/env bash\nif [ "$1" = "-s" ]; then echo Darwin; else echo "$TEST_ARCH"; fi\n', encoding="utf-8", newline="\n")
        (self.bin / "sw_vers").write_text('#!/usr/bin/env bash\necho "$TEST_MAC_VERSION"\n', encoding="utf-8", newline="\n")
        (self.bin / "uname").chmod(0o755)
        (self.bin / "sw_vers").chmod(0o755)
        for architecture, version in (("arm64", "13.9"), ("x86_64", "13.2")):
            with self.subTest(architecture=architecture, version=version):
                self.env.update(TEST_ARCH=architecture, TEST_MAC_VERSION=version)
                result = self.launch("--setup-only")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires macOS", result.stderr)
                self.assertFalse((self.root / "backend/.venv").exists())
        self.env.update(TEST_ARCH="arm64", TEST_MAC_VERSION="14.0")
        self.assertEqual(self.launch("--setup-only").returncode, 0)
        self.env.update(TEST_ARCH="x86_64", TEST_MAC_VERSION="13.3")
        self.assertEqual(self.launch("--setup-only").returncode, 0)


if __name__ == "__main__":
    unittest.main()
