from pathlib import Path
import json

import release_identity as identity


def source(tmp_path):
    (tmp_path / "backend/routers").mkdir(parents=True)
    (tmp_path / "frontend/js").mkdir(parents=True)
    (tmp_path / "backend/main.py").write_text("print('app')")
    (tmp_path / "backend/routers/test_route.py").write_text("VERSION=1")
    (tmp_path / "frontend/index.html").write_text("<main>App</main>")
    (tmp_path / "frontend/js/app.js").write_text("let version=1")
    return tmp_path


def test_changed_router_detected_without_changing_old_version_file(tmp_path):
    root = source(tmp_path)
    now = [0]
    running = identity.ReleaseIdentity(root, clock=lambda: now[0])
    old = running.status()
    assert old["compatibility"]["state"] == "matched"
    (root / "backend/routers/test_route.py").write_text("VERSION=2")
    now[0] = 6
    new = running.status()
    assert new["source_id"] == old["source_id"]
    assert new["on_disk"]["backend_id"] != new["backend_id"]
    assert new["compatibility"]["state"] == "restart_required"
    assert identity.ReleaseIdentity(root).status()["compatibility"]["state"] == "matched"


def test_browser_changes_and_new_application_files_are_detected(tmp_path):
    root = source(tmp_path)
    running = identity.ReleaseIdentity(root)
    (root / "frontend/js/new-panel.js").write_text("let panel=1")
    assert running.status()["compatibility"]["state"] == "restart_required"
    assert running.status()["frontend_id"] != running.status()["on_disk"]["frontend_id"]


def test_private_data_models_tests_and_dependencies_never_enter_identity(tmp_path):
    root = source(tmp_path)
    before = identity.ReleaseIdentity(root).status()["source_id"]
    for name in ["data/secret.py", "backend/ai/memory/private.py", "backend/models/weights.py",
                 "backend/tests/test_private.py", "backend/.venv/secret.py", "frontend/tests/test.js"]:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("private")
    assert identity.ReleaseIdentity(root).status()["source_id"] == before


def test_missing_or_oversized_application_files_are_unknown(tmp_path, monkeypatch):
    root = source(tmp_path)
    monkeypatch.setattr(identity, "MAX_BYTES", 1)
    result = identity.ReleaseIdentity(root).status()
    assert result["compatibility"]["state"] == "unknown"
    assert result["source_id"] is None


def test_source_scan_failure_preserves_loaded_identity(tmp_path, monkeypatch):
    running = identity.ReleaseIdentity(source(tmp_path))
    previous = running.loaded.copy()
    monkeypatch.setattr(running, "_inspect", lambda: None)
    result = running.status()
    assert result["source_id"] == previous["source_id"]
    assert result["compatibility"]["state"] == "unknown"


def test_inaccessible_application_directory_cannot_be_a_partial_match(tmp_path, monkeypatch):
    root = source(tmp_path)
    running = identity.ReleaseIdentity(root)
    previous = running.loaded.copy()
    real_walk = identity.os.walk
    def inaccessible(base, **kwargs):
        for row in real_walk(base, **kwargs):
            yield row
            kwargs["onerror"](PermissionError("Synthetic unreadable directory"))
    monkeypatch.setattr(identity.os, "walk", inaccessible)
    result = running.status()
    assert result["compatibility"]["state"] == "unknown"
    assert result["source_id"] == previous["source_id"] and result["on_disk"] is None
    assert identity.ReleaseIdentity(root).loaded is None


def test_effective_browser_root_is_identified_independently_from_loaded_code(tmp_path):
    root = source(tmp_path / "source")
    alternate = tmp_path / "override"
    (alternate / "frontend").mkdir(parents=True)
    (alternate / "frontend/index.html").write_text("Alternate browser assets")
    running = identity.ReleaseIdentity(root, frontend_root=alternate)
    assert running.loaded["frontend_id"] != identity.ReleaseIdentity(root).loaded["frontend_id"]
    (alternate / "frontend/index.html").write_text("New alternate browser assets")
    assert running.status()["compatibility"]["state"] == "restart_required"


def test_linked_included_source_is_unknown_instead_of_silently_omitted(tmp_path, monkeypatch):
    root = source(tmp_path)
    original = identity._linked
    monkeypatch.setattr(identity, "_linked", lambda p: p.name == "app.js" or original(p))
    assert identity.ReleaseIdentity(root).status()["compatibility"]["state"] == "unknown"


def test_missing_registered_routes_cannot_claim_a_feature(tmp_path, monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(identity, "_runtime", identity.ReleaseIdentity(source(tmp_path)))
    routes = [SimpleNamespace(path="/api/intelligence/cases/context-review", methods={"POST"})]
    assert identity.public_status(routes)["capabilities"] == ["case_report_review_v1"]
    assert identity.public_status([])["capabilities"] == []


def test_status_is_a_copy_and_probe_is_bounded_by_cache(tmp_path, monkeypatch):
    running = identity.ReleaseIdentity(source(tmp_path))
    value = running.status()
    value["capabilities"].clear()
    monkeypatch.setattr(running, "_inspect", lambda: (_ for _ in ()).throw(AssertionError("cached")))
    assert running.status()["capabilities"]


def test_next_check_requires_both_review_and_existing_execution_routes(tmp_path, monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(identity, "_runtime", identity.ReleaseIdentity(source(tmp_path)))
    routes = [SimpleNamespace(path="/api/intelligence/cases/next-check", methods={"POST"})]
    assert "case_next_check_v1" not in identity.public_status(routes)["capabilities"]
    routes.extend([SimpleNamespace(path="/api/intelligence/diagnostics/options", methods={"GET"}),
                   SimpleNamespace(path="/api/intelligence/diagnostics", methods={"POST"})])
    assert "case_next_check_v1" in identity.public_status(routes)["capabilities"]


def test_frozen_identity_binds_executable_and_browser_without_source(tmp_path):
    (tmp_path / "frontend").mkdir()
    (tmp_path / "frontend/index.html").write_text("<main>App</main>")
    exe = tmp_path / "tli_backend.exe"
    exe.write_bytes(b"synthetic executable")
    running = identity.ReleaseIdentity(tmp_path, executable=exe)
    exe.write_bytes(b"different synthetic executable")
    assert running.status()["compatibility"]["state"] == "restart_required"


def test_file_transfer_requires_local_controls_and_peer_ingress(tmp_path, monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(identity, "_runtime", identity.ReleaseIdentity(source(tmp_path)))
    required = identity.REQUIRED_ROUTES["trusted_file_transfer_v1"]
    routes = [SimpleNamespace(path=path, methods={method}) for method, path in required]
    assert "trusted_file_transfer_v1" in identity.public_status(routes)["capabilities"]
    for missing in range(len(routes)):
        partial = routes[:missing] + routes[missing + 1:]
        assert "trusted_file_transfer_v1" not in identity.public_status(partial)["capabilities"]


def test_existing_version_endpoint_adds_release_without_changing_fields(client, monkeypatch, tmp_path):
    monkeypatch.setattr(identity, "_runtime", identity.ReleaseIdentity(source(tmp_path)))
    result = client.get("/api/diagnostics/version")
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    value = result.json()
    assert all(key in value for key in ("ok", "build_id", "build_utc", "python", "platform"))
    assert value["release"]["compatibility"]["state"] == "matched"
    assert str(tmp_path) not in json.dumps(value)
