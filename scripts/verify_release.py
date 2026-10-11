"""Verify a frozen, private anniversary candidate; never operate on live TLI.

Use --clean-environment --with-mobile --rollback-ref <commit> for the complete
beta source gate. Native builds and physical acceptance are separate manifest
entries and cannot be inferred from successful source verification.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import zipfile

REPO = Path(__file__).resolve().parents[1]
EXTRACTED_EXCLUSIONS = {
    "backend/tests/test_release_packaging.py": "Packager is developer tooling, intentionally absent from the installed package.",
    "backend/tests/test_anniversary_regressions.py::test_previous_actions_reader_can_read_current_files": "Requires Git history, intentionally absent from the installed package.",
}
PHONE_SCENARIOS = (
    "pairing_and_app_restart", "host_restart_identity_and_port", "replacement_cancel_and_trust",
    "revocation", "wifi_loss_and_background_no_replay", "shared_conversations_and_notebook",
    "screenshot_send_recovery", "data_recovery_and_ai_readiness", "permissions_keyboard_accessibility",
    "production_companion_unchanged",
)


def clean_environment(source=None):
    """Do not let the invoking installation choose test storage, ports or workers."""
    env = {key: value for key, value in (os.environ if source is None else source).items()
           if not key.upper().startswith("TLI_") and key.upper() not in {
               "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTEST_ADDOPTS", "UVICORN_HOST", "UVICORN_PORT",
               "PIP_TARGET", "PIP_PREFIX", "PIP_USER", "PIP_ROOT", "PIP_CONFIG_FILE",
               "NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG_PREFIX", "NPM_CONFIG_GLOBAL", "NPM_CONFIG_USERCONFIG"}}
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONOPTIMIZE="0",
               PYTHONNOUSERSITE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", TLI_OPEN_BROWSER="0",
               PIP_CONFIG_FILE=os.devnull, NPM_CONFIG_GLOBAL="false", NPM_CONFIG_USERCONFIG=os.devnull)
    return env


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def safe_extract(archive, destination, allowed):
    destination = destination.resolve()
    for item in archive.infolist():
        raw = item.filename.replace("\\", "/")
        path = Path(raw)
        if path.is_absolute() or ".." in path.parts or ":" in raw or not allowed(path):
            raise RuntimeError(f"Unexpected archive member: {raw}")
        if not (destination / path).resolve().is_relative_to(destination):
            raise RuntimeError("Archive member leaves the installation")
        if (item.external_attr >> 16) & 0o170000 == 0o120000:
            raise RuntimeError("Linked archive members are not allowed")
    archive.extractall(destination)


def extract_git_baseline(repo, revision, destination, allowed):
    """Filter tree metadata before reading blobs; never archive historical stores."""
    tree = subprocess.check_output(["git", "ls-tree", "-rz", revision, "--", "backend", "frontend"], cwd=repo)
    selected = []
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, object_id = metadata.split()
        name = raw_path.decode("utf-8")
        path = Path(name)
        if kind != b"blob" or mode not in (b"100644", b"100755") or not allowed(path):
            continue
        target = (destination / path).resolve()
        if path.is_absolute() or ".." in path.parts or ":" in name or not target.is_relative_to(destination.resolve()):
            raise RuntimeError("Invalid baseline source path")
        selected.append((object_id, target))
    if not selected:
        raise RuntimeError("No allowed source files found in the rollback baseline")
    blobs = subprocess.run(["git", "cat-file", "--batch"], cwd=repo,
                           input=b"".join(oid + b"\n" for oid, _ in selected), capture_output=True, check=True)
    stream = io.BytesIO(blobs.stdout)
    for object_id, target in selected:
        found, kind, raw_size = stream.readline().strip().split()
        if found != object_id or kind != b"blob":
            raise RuntimeError("Baseline source object did not match the reviewed tree")
        size = int(raw_size)
        data = stream.read(size)
        if len(data) != size or stream.read(1) != b"\n":
            raise RuntimeError("Incomplete baseline source object")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return len(selected)


def extracted_test_command(python, extracted):
    # conftest changes cwd before collection to isolate legacy relative stores.
    # An absolute ignore stays bound to the candidate through that transition.
    return [python, "-m", "pytest", "backend/tests", "-q", "--tb=short",
            "--ignore=" + str(Path(extracted).resolve() / "backend/tests/test_release_packaging.py"),
            "--deselect=backend/tests/test_anniversary_regressions.py::test_previous_actions_reader_can_read_current_files"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, help="Parent for the unique snapshot and verification workspace")
    parser.add_argument("--clean-environment", action="store_true")
    parser.add_argument("--rollback-ref", help="Explicit Git compatibility baseline; not a published-release claim")
    parser.add_argument("--with-mobile", action="store_true", help="Install locked mobile dependencies, test and export from the snapshot")
    parser.add_argument("--node", default="node", help="Node 22.13+ executable for Companion checks")
    parser.add_argument("--npm-cli", type=Path, help="npm-cli.js to run with the selected Node executable")
    args = parser.parse_args()
    from release_snapshot import create_snapshot, verify_snapshot
    created = create_snapshot(REPO, **({"output_dir": args.output_dir} if args.output_dir else {}))
    workspace = Path(created["workspace"])
    source = Path(created["snapshot_root"])
    source_manifest = Path(created["manifest_path"])
    extracted = workspace / "installation"
    extracted.mkdir()
    archive_path = workspace / "TLI_candidate.zip"
    env = clean_environment()
    report = {"schema_version": 1, "status": "failed", "created_at": datetime.now(timezone.utc).isoformat(),
              "workspace": str(workspace), "source": created, "checks": {}, "artifacts": {},
              "extracted_exclusions": EXTRACTED_EXCLUSIONS,
              "native_builds": {"android": {"status": "not_run"}, "ios": {"status": "not_run"}},
              "physical_acceptance": {platform: {"status": "not_run", "device": None, "os": None,
                  "source_fingerprint": created["fingerprint"], "native_build_id": None,
                  "scenarios": {scenario: {"status": "not_run", "notes": ""} for scenario in PHONE_SCENARIOS}}
                  for platform in ("android", "ios")},
              "remaining_gates": ["Signed separate beta apps and physical acceptance on both phones",
                                  "In-place production Companion upgrades", "Native Windows/macOS/Linux installer acceptance",
                                  "Real-data backup/restore; cross-account DPAPI recovery"]}
    report["requested"] = {"clean_environment": args.clean_environment, "mobile": args.with_mobile, "rollback_ref": args.rollback_ref}
    report["deferred_source_gates"] = [name for name, enabled in (
        ("fresh_dependency_environment", args.clean_environment), ("mobile_tests_and_exports", args.with_mobile),
        ("synthetic_rollback", bool(args.rollback_ref))) if not enabled]

    def save_report():
        # Only verification metadata, never fixture PINs, bearer tokens or keys.
        (workspace / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    def run_logged(label, command, cwd, timeout=180, extra_env=None):
        print(f"Checking {label}...", flush=True)
        log_path = workspace / f"{label}.log"
        checked = {"passed": False, "log": str(log_path)}
        report["checks"][label] = checked
        save_report()
        try:
            with log_path.open("w", encoding="utf-8") as log:
                result = subprocess.run([str(arg) for arg in command], cwd=cwd,
                                        env={**env, **(extra_env or {})}, stdout=log,
                                        stderr=subprocess.STDOUT, timeout=timeout)
            checked.update(passed=result.returncode == 0, exit_code=result.returncode)
        except subprocess.TimeoutExpired:
            checked["timed_out"] = True
            raise RuntimeError(f"{label} exceeded {timeout} seconds; see {log_path.name}") from None
        if not checked["passed"]:
            raise RuntimeError(f"{label} failed; see {log_path.name}")
        checked["summary"] = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-10:]
        save_report()

    def fixture_root(name):
        path = workspace / name
        path.mkdir()
        (path / ".tli-rehearsal").write_text("synthetic test data only", encoding="utf-8")
        return path

    try:
        verify_snapshot(source, source_manifest, source_root=REPO)
        spec = importlib.util.spec_from_file_location("frozen_packager", source / "build_dist.py")
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        packager.build(archive_path)
        with zipfile.ZipFile(archive_path) as archive:
            members = set(archive.namelist())
            required = {"backend/main.py", "backend/requirements.txt", "backend/startup_config.py",
                        "backend/security_state.py", "backend/companion_auth.py", "backend/launch_checks.py",
                        "backend/routers/companion_routes.py", "backend/intelligence/notebook.py",
                        "frontend/index.html", "frontend/js/native-companion.js", "frontend/js/notebook.js",
                        "frontend/js/data-recovery.js", "TLI_Start.bat", "TLI_Start.command", "TLI_Start.sh"}
            if required - members:
                raise RuntimeError(f"Missing runtime files: {sorted(required - members)}")
            safe_extract(archive, extracted, lambda p: not packager._should_skip(p)[0])
        report["checks"]["package_contents"] = {"passed": True, "files": len(members)}
        report["archive_sha256"] = sha256(archive_path)
        report["artifacts"]["desktop"] = {"path": str(archive_path), "sha256": report["archive_sha256"], "kind": "source_zip"}
        asset_count = 0
        for page in ("index.html", "companion.html"):
            html = (extracted / "frontend" / page).read_text(encoding="utf-8")
            for ref in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', html):
                relative = ref.split("?", 1)[0].split("#", 1)[0]
                if ":" in relative or relative.startswith("//") or not relative.endswith((".js", ".css")):
                    continue
                if not (extracted / "frontend" / relative.lstrip("/")).is_file():
                    raise RuntimeError(f"Missing asset referenced by {page}: {ref}")
                asset_count += 1
        report["checks"]["frontend_assets"] = {"passed": True, "references": asset_count}
        python = Path(sys.executable)
        runner = source / "scripts" / "release_rehearsal.py"
        if args.clean_environment:
            venv = extracted / "backend" / ".venv"
            run_logged("create_environment", [python, "-m", "venv", venv], extracted)
            python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            run_logged("install_runtime_dependencies", [python, "-m", "pip", "install", "--disable-pip-version-check",
                "--timeout", "30", "--retries", "1", "-r", extracted / "backend" / "requirements.txt"], extracted, 900)
            run_logged("runtime_dependency_check", [python, "-m", "pip", "check"], extracted)
            run_logged("runtime_import", [python, runner, "--code-dir", extracted,
                "--data-root", fixture_root("clean-import-data"), "--stage", "import"], extracted)
            run_logged("install_test_dependencies", [python, "-m", "pip", "install", "--disable-pip-version-check",
                "--timeout", "30", "--retries", "1", "-r", source / "backend" / "requirements-test.txt"], extracted, 600)
        report["python"] = str(python)
        run_logged("all_dependency_check", [python, "-m", "pip", "check"], extracted)
        run_logged("dependency_versions", [python, "-m", "pip", "freeze"], extracted)
        run_logged("source_backend", [python, "-m", "pytest", "backend/tests", "-q", "--tb=short"], source, 1200)
        if (source / "scripts" / "tests").is_dir():
            run_logged("release_tooling", [python, "-m", "pytest", "scripts/tests", "-q", "--tb=short"], source, 1200)
        shutil.copytree(source / "backend" / "tests", extracted / "backend" / "tests",
                        ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
        command = extracted_test_command(python, extracted)
        run_logged("extracted_installation", command, extracted, 1200)
        if args.clean_environment and os.name == "nt":
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0)); listener.listen()
                launch = subprocess.run(["cmd.exe", "/d", "/c", "TLI_Start.bat"], cwd=extracted,
                    env={**env, "TLI_PORT": str(listener.getsockname()[1]), "TLI_HOST": "127.0.0.1"},
                    input="\n", text=True, encoding="utf-8", errors="replace", capture_output=True,
                    creationflags=subprocess.CREATE_NO_WINDOW, timeout=180)
                (workspace / "windows-launcher.log").write_text(launch.stdout + launch.stderr, encoding="utf-8")
                if launch.returncode != 1 or "No process was stopped" not in launch.stdout + launch.stderr:
                    raise RuntimeError("Windows launcher did not refuse the occupied test port")
                if listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1:
                    raise RuntimeError("Owned test listener was stopped")
            report["checks"]["windows_launcher_busy_port"] = {"passed": True}
        https_report = workspace / "https-rehearsal.json"
        run_logged("https_restart", [python, source / "scripts" / "https_rehearsal.py", "--code-dir", extracted,
            "--data-root", fixture_root("https-data"), "--report-path", https_report], workspace, 240)
        report["checks"]["https_restart"]["report"] = str(https_report)
        if args.rollback_ref:
            revision = subprocess.check_output(["git", "rev-parse", "--verify", args.rollback_ref + "^{commit}"], cwd=REPO, text=True).strip()
            report["rollback_baseline"] = revision
            report["rollback_scope"] = "Synthetic source/data compatibility; baseline predates Companion, not a published-release claim"
            baseline = workspace / "previous-code"; baseline.mkdir()
            report["rollback_source_files"] = extract_git_baseline(REPO, revision, baseline, lambda path: not packager._should_skip(path)[0])
            shared = fixture_root("rollback-data")
            for stage, installation in (("seed", baseline), ("upgrade", extracted), ("rollback", baseline), ("return", extracted)):
                run_logged(f"rollback_{stage}", [python, runner, "--code-dir", installation, "--data-root", shared, "--stage", stage], workspace)
                if stage == "seed":
                    shutil.copytree(shared, workspace / "synthetic-backup")
            restored = workspace / "restored-backup"
            shutil.copytree(workspace / "synthetic-backup", restored)
            run_logged("backup_restore", [python, runner, "--code-dir", baseline, "--data-root", restored, "--stage", "restore"], workspace)
        node = shutil.which(args.node) or args.node
        run_logged("node_version", [node, "--version"], source)
        frontend_tests = sorted((source / "frontend" / "tests").glob("*.test.cjs"))
        if not frontend_tests:
            raise RuntimeError("No desktop regression tests found in the snapshot")
        run_logged("source_frontend", [node, "--test", "--test-concurrency=4", *frontend_tests], source, 600)
        if args.with_mobile:
            version = subprocess.check_output([node, "-p", "process.versions.node"], text=True).strip()
            major, minor = map(int, version.split(".")[:2])
            if (major, minor) < (22, 13):
                raise RuntimeError("Companion verification requires Node 22.13+")
            mobile = source / "mobile"
            node_dir = Path(node).resolve().parent
            npm_cli = args.npm_cli or node_dir / "node_modules" / "npm" / "bin" / "npm-cli.js"
            if not npm_cli.is_file() and not args.npm_cli and shutil.which("npm"):
                npm_cli = Path(shutil.which("npm")).parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
            if not npm_cli.is_file():
                raise RuntimeError("Use a Node installation with its bundled npm CLI")
            mobile_env = {"PATH": str(node_dir) + os.pathsep + env.get("PATH", ""), "CI": "1", "TLI_APP_VARIANT": "beta"}
            run_logged("mobile_install", [node, npm_cli, "--prefix", mobile, "ci", "--no-audit", "--no-fund"], mobile, 600, mobile_env)
            run_logged("mobile_dependencies", [node, npm_cli, "ls", "--depth=0"], mobile, 120, mobile_env)
            run_logged("mobile_typecheck", [node, "node_modules/typescript/bin/tsc", "--noEmit"], mobile, 120, mobile_env)
            run_logged("mobile_tests", [node, "--import", "tsx", "--test", *sorted((mobile / "tests").glob("*.test.ts"))], mobile, 120, mobile_env)
            # Metro can reuse transforms across source snapshots. A release check
            # must compile these exact inputs, including the browser QA export.
            run_logged("mobile_exports", [node, "node_modules/expo/bin/cli", "export", "--clear", "--platform", "ios", "--platform", "android", "--platform", "web",
                "--output-dir", ".expo/beta-verification"], mobile, 300, {**mobile_env, "EXPO_OFFLINE": "1"})
            export = mobile / ".expo" / "beta-verification"
            report["artifacts"]["mobile_exports"] = {"path": str(export), "files": {
                path.relative_to(export).as_posix(): sha256(path) for path in sorted(export.rglob("*")) if path.is_file()}}
        verify_snapshot(source, source_manifest, source_root=REPO)
        report["checks"]["source_unchanged"] = {"passed": True}
        report["status"] = "source_verified" if not report["deferred_source_gates"] else "partial_source_verified"
    except Exception as error:
        report["error"] = str(error)
    finally:
        save_report()
    print(json.dumps({"status": report["status"], "workspace": str(workspace), "source": str(source),
                      "report": str(workspace / "report.json"), "error": report.get("error")}, indent=2))
    return 0 if report["status"] in {"source_verified", "partial_source_verified"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
