"""Updater tests never contact a release server or modify a real installation."""
import hashlib
import io
import json
import ssl
import threading
import urllib.error
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auto_update as U
from routers import update_routes as R
from routers.system_routes import require_session


class Download(io.BytesIO):
    def __init__(self, data, length=None):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data) if length is None else length)}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(U.S, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(U.S, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(U.S, "TLI_VERSION", "1.4.0-beta")
    monkeypatch.setattr(U, "_SETTINGS_FILE", tmp_path / "data/update_settings.json")
    monkeypatch.setattr(U, "_state", U.UpdateState.IDLE)
    monkeypatch.setattr(U, "_info", {})
    monkeypatch.setattr(U, "_error", "")
    monkeypatch.setattr(U, "_ready_path", "")
    monkeypatch.setattr(U, "_checked_at", None)
    monkeypatch.setattr(U, "_progress", 0)
    monkeypatch.setattr(U, "_checking", False)
    monkeypatch.setattr(U, "_last_attempt", None)
    monkeypatch.setattr(U, "_last_check_error", "")
    monkeypatch.setattr(U, "_settings_revision", 0)
    monkeypatch.setattr(U, "_auto_wake", threading.Event())
    monkeypatch.setattr(U, "_platform_name", lambda: "windows")
    monkeypatch.setattr(U, "_open_url", lambda *a: pytest.fail("Unexpected network access"))


def manifest(**package):
    return {"version": "1.4.0", "notes": "New release", "platforms": {
        "windows": {"url": "https://releases.example/tli.zip", "sha256": "a" * 64, "updater": "guided-v1", **package},
        "macos": {"url": "https://releases.example/mac.zip", "sha256": "b" * 64, "updater": "guided-v1"}}}


def serve_manifest(monkeypatch, value):
    monkeypatch.setattr(U, "_open_url", lambda *a: Download(json.dumps(value).encode()))
    return U.check()


@pytest.mark.parametrize("remote,local,newer", [
    ("1.4.0", "1.4.0-beta", True), ("1.4.0-beta.10", "1.4.0-beta.2", True),
    ("1.4.0-beta", "1.4.0", False), ("1.4.0-beta", "1.4.0-beta", False),
    ("1.4.1-beta", "1.4.0", True), ("1.3.5-beta", "1.4.0-beta", False),
])
def test_prerelease_versions(remote, local, newer):
    assert U._is_newer(remote, local) is newer


def test_current_platform_and_explicit_updater_contract(monkeypatch):
    result = serve_manifest(monkeypatch, manifest())
    assert result["state"] == "available"
    assert result["current_version"] == "1.4.0-beta"
    assert result["can_prepare"] is True
    assert U._info["download_url"].endswith("tli.zip")
    assert result["checked_at"]


def test_legacy_release_remains_manual_even_with_valid_digest(monkeypatch):
    result = serve_manifest(monkeypatch, manifest(updater=None))
    assert result["state"] == "available"
    assert result["can_prepare"] is False
    assert U.apply() is False
    assert "manual" in result["message"]


@pytest.mark.parametrize("value", [[], {"version": "../unsafe"}, manifest(sha256=""), manifest(url="http://example.com/update.zip")])
def test_bad_manifest_fails_without_starting_download(monkeypatch, value, tmp_path):
    result = serve_manifest(monkeypatch, value)
    assert result["state"] == "error"
    assert U.apply() is False
    assert not (tmp_path / "data/updates").exists()


def test_missing_platform_has_clear_manual_guidance(monkeypatch):
    data = manifest()
    del data["platforms"]["windows"]
    result = serve_manifest(monkeypatch, data)
    assert result["can_prepare"] is False
    assert "No update package" in result["message"]


def test_check_cannot_replace_manifest_while_download_runs(monkeypatch):
    serve_manifest(monkeypatch, manifest())
    saved = dict(U._info)
    monkeypatch.setattr(U, "_state", U.UpdateState.DOWNLOADING)
    monkeypatch.setattr(U, "_open_url", lambda *a: pytest.fail("Busy check accessed network"))
    assert U.check()["state"] == "downloading"
    assert U._info == saved


def test_default_source_migration_preserves_disabled_check_and_custom_source():
    U.save_settings("https://thelanintelligence.com/latest.json", False)
    assert U.get_status()["update_url"] == U.DEFAULT_UPDATE_URL
    assert U.get_status()["auto_check"] is False
    U.save_settings("https://my.example/releases.json", False)
    assert U.get_status()["update_url"] == "https://my.example/releases.json"


def test_failed_check_can_be_retried(monkeypatch):
    assert serve_manifest(monkeypatch, None)["state"] == "error"
    result = serve_manifest(monkeypatch, manifest())
    assert result["state"] == "available"
    assert result["error"] == ""


@pytest.mark.parametrize("wrapped", [False, True])
def test_certificate_failure_has_recovery_guidance_and_can_retry(monkeypatch, tmp_path, wrapped):
    error = ssl.SSLCertVerificationError(1, "unable to get local issuer certificate")
    if wrapped:
        error = urllib.error.URLError(error)

    def fail(*args):
        raise error

    monkeypatch.setattr(U, "_open_url", fail)
    status = U.check()
    assert status["state"] == "error"
    assert "could not verify the update server's HTTPS certificate" in status["error"]
    assert "unable to get local issuer certificate" in status["error"]
    assert "Download from releases" in status["error"]
    assert "TLI_Update" in status["error"]
    assert not (tmp_path / "data/updates").exists()
    assert serve_manifest(monkeypatch, manifest())["state"] == "available"


def test_certificate_failure_during_download_cleans_staging_and_preserves_install(monkeypatch, tmp_path):
    existing = tmp_path / "frontend/index.html"
    existing.parent.mkdir()
    existing.write_text("original application")
    saved = tmp_path / "data/conversations.json"
    saved.parent.mkdir()
    saved.write_text("saved conversations")
    serve_manifest(monkeypatch, manifest())

    def fail(*args):
        raise urllib.error.URLError(ssl.SSLCertVerificationError(1, "certificate has expired"))

    monkeypatch.setattr(U, "_open_url", fail)
    U._apply_pipeline(dict(U._info))
    status = U.get_status()
    assert status["state"] == "error"
    assert "certificate has expired" in status["error"]
    assert "date and time" in status["error"]
    assert "No application files were changed" in status["error"]
    assert status["can_open"] is False
    assert existing.read_text() == "original application"
    assert saved.read_text() == "saved conversations"
    assert not list((tmp_path / "data/updates").iterdir())


def test_automatic_certificate_failure_remains_nonintrusive(monkeypatch):
    serve_manifest(monkeypatch, manifest())

    def fail(*args):
        raise urllib.error.URLError(ssl.SSLCertVerificationError(1, "unable to get local issuer certificate"))

    monkeypatch.setattr(U, "_open_url", fail)
    status = U.check(automatic=True)
    assert status["state"] == "available"
    assert not status["error"]
    assert "HTTPS certificate" in status["last_check_error"]


def test_bad_checksum_never_extracts_or_changes_application(monkeypatch, tmp_path):
    import update_install
    existing = tmp_path / "frontend/index.html"
    existing.parent.mkdir()
    existing.write_text("old")
    monkeypatch.setattr(U, "_open_url", lambda *a: Download(b"bad zip"))
    monkeypatch.setattr(update_install, "extract_archive", lambda *a, **k: pytest.fail("Unverified extraction"))
    U._apply_pipeline(U._manifest_info(manifest()))
    assert U.get_status()["state"] == "error"
    assert "checksum" in U.get_status()["error"]
    assert existing.read_text() == "old"
    assert not list((tmp_path / "data/updates").glob("job-*"))


def test_verified_preparation_is_persistent_but_never_claims_installed(monkeypatch, tmp_path):
    import update_install
    raw = b"synthetic package"
    manifest_info = U._manifest_info(manifest(sha256=hashlib.sha256(raw).hexdigest()))
    monkeypatch.setattr(U, "_info", manifest_info)
    monkeypatch.setattr(U, "_open_url", lambda *a: Download(raw))
    def extract(archive, destination, **options):
        assert archive.read_bytes() == raw
        assert options == {"expected_version": "1.4.0", "expected_platform": "windows"}
        destination.mkdir()
        (destination / "TLI_RELEASE.json").write_text("{}")
        return {"files": [{"path": path} for path in (
            "backend/main.py", "backend/tli_state.py", "backend/requirements.txt", "backend/update_install.py",
            "frontend/index.html", "TLI_Update.bat", "TLI_Update.ps1")]}
    monkeypatch.setattr(update_install, "extract_archive", extract)
    U._apply_pipeline(manifest_info)
    status = U.get_status()
    assert status["state"] == "ready"
    assert status["current_version"] == "1.4.0-beta"
    assert status["can_open"] is True
    assert not (tmp_path / "backend").exists()
    assert json.loads((Path(status["ready_path"]) / "update-target.json").read_text())["target"] == str(tmp_path)
    monkeypatch.setattr(U, "_state", U.UpdateState.IDLE)
    monkeypatch.setattr(U, "_info", {})
    monkeypatch.setattr(U, "_ready_path", "")
    assert U.get_status()["state"] == "ready"
    monkeypatch.setattr(U.S, "TLI_VERSION", "1.4.0")
    monkeypatch.setattr(U, "_state", U.UpdateState.IDLE)
    assert U.get_status()["state"] == "idle"


def test_removed_prepared_folder_allows_fresh_check(monkeypatch, tmp_path):
    monkeypatch.setattr(U, "_state", U.UpdateState.READY)
    monkeypatch.setattr(U, "_ready_path", str(tmp_path / "data/updates/missing/package"))
    assert U.get_status()["state"] == "error"
    assert U.get_status()["can_open"] is False
    assert serve_manifest(monkeypatch, manifest())["state"] == "available"


def test_host_startup_refuses_interrupted_update_before_config_access(monkeypatch, tmp_path):
    import main
    import startup_config
    import update_install
    journal = tmp_path / "data/updates/backups/interrupted/journal.json"
    journal.parent.mkdir(parents=True)
    journal.write_text(json.dumps({"schema_version": 1, "target": str(tmp_path), "status": "applying", "files": []}))
    monkeypatch.setattr(startup_config, "resolve", lambda *a: pytest.fail("Startup continued with mixed application files"))
    with pytest.raises(update_install.UpdateError, match="--rollback"):
        main._validate_startup()


def test_apply_starts_only_one_immutable_job(monkeypatch):
    serve_manifest(monkeypatch, manifest())
    jobs = []
    class Thread:
        def __init__(self, **kwargs):
            jobs.append(kwargs)
        def start(self):
            pass
    monkeypatch.setattr(threading, "Thread", Thread)
    assert U.apply() is True
    assert U.apply() is False
    assert len(jobs) == 1
    U._info["version"] = "unrelated"
    assert jobs[0]["args"][0]["version"] == "1.4.0"


@pytest.fixture
def local(monkeypatch):
    app = FastAPI()
    app.include_router(R.router)
    app.dependency_overrides[require_session] = lambda: "local"
    monkeypatch.setattr(U.S, "SERVER_BIND_PORT", 8000)
    monkeypatch.setattr(U.S, "TLS_ENABLED", False)
    monkeypatch.setattr(U.S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(U.S, "validate_session_token", lambda token: False)
    return app, TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 12345))


def test_download_and_open_require_local_browser_origin(local, monkeypatch):
    app, client = local
    monkeypatch.setattr(U, "apply", lambda: pytest.fail("Unauthorized download"))
    monkeypatch.setattr(U, "open_prepared_folder", lambda: pytest.fail("Unauthorized folder reveal"))
    for path in ("/update/apply", "/update/open"):
        assert client.post(path, json={}).status_code == 403
        assert client.post(path, json={}, headers={"Origin": "https://evil.example"}).status_code == 403
        remote = TestClient(app, base_url="http://localhost:8000", client=("192.168.1.5", 12345))
        assert remote.post(path, json={}, headers={"Origin": "http://localhost:8000"}).status_code == 403


def test_authorized_prepare_open_and_uncached_status(local, monkeypatch):
    _, client = local
    serve_manifest(monkeypatch, manifest())
    actions = []
    monkeypatch.setattr(U, "apply", lambda: actions.append("prepare") or True)
    monkeypatch.setattr(U, "open_prepared_folder", lambda: actions.append("open"))
    headers = {"Origin": "http://localhost:8000"}
    assert client.post("/update/apply", json={}, headers=headers).status_code == 200
    assert client.post("/update/open", json={}, headers=headers).status_code == 200
    assert actions == ["prepare", "open"]
    assert client.get("/update/status").headers["cache-control"] == "no-store"
