"""Uninstall discovery never removes files, launches programs or registers apps."""
import hashlib
from pathlib import Path
import sys
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import tli_state as S
import uninstall_info as U
from routers import system_routes as R


def test_discovery_reports_missing_entrypoint_without_mutation(tmp_path, monkeypatch):
    monkeypatch.setattr(U, "windows_registered", lambda root: False)
    before = list(tmp_path.iterdir())
    info = U.describe(tmp_path, system="Windows")
    assert not info["supported"] and not info["registered"]
    assert info["entrypoint"] is None
    assert "does not include" in info["reason"]
    assert list(tmp_path.iterdir()) == before


def test_release_and_source_checkout_are_distinguished(tmp_path, monkeypatch):
    monkeypatch.setattr(U, "windows_registered", lambda root: False)
    root = tmp_path / "TLI with spaces"
    root.mkdir()
    for name in ("TLI_Uninstall.ps1", "Uninstall_TLI.bat"):
        (root / name).write_text("synthetic entry point")
    info = U.describe(root, system="Windows")
    assert info["supported"] and Path(info["entrypoint"]).parent == root
    (tmp_path / ".git").write_text("gitdir: fixture")
    assert not U.describe(root, system="Windows")["supported"]
    assert "source checkout" in U.describe(root, system="Windows")["reason"]


@pytest.mark.parametrize("system", ["Darwin", "Linux"])
def test_other_hosts_do_not_advertise_windows_removal(tmp_path, system):
    info = U.describe(tmp_path, system=system)
    assert info["platform"] == system
    assert not info["supported"] and not info["registered"]
    assert info["entrypoint"] is None


def test_registration_is_installation_specific(tmp_path):
    assert U.registration_name(tmp_path) == "TLI-" + hashlib.sha256(str(tmp_path).lower().encode()).hexdigest()[:12].upper()
    assert U.registration_name(tmp_path / "one") != U.registration_name(tmp_path / "two")


def test_windows_registration_only_matches_the_exact_install_location(tmp_path, monkeypatch):
    from contextlib import nullcontext
    opened = []
    location = {"value": str(tmp_path / "other")}
    def open_key(hive, key, reserved, access):
        opened.append((hive, key, access))
        return nullcontext("fixture")
    def no_keys(handle, index):
        raise OSError("End of fixture keys")
    registry = SimpleNamespace(HKEY_CURRENT_USER="current-user", KEY_READ=1,
                               OpenKey=open_key,
                               EnumKey=no_keys,
                               QueryValueEx=lambda key, value: (location["value"], 1))
    monkeypatch.setitem(sys.modules, "winreg", registry)
    assert not U.windows_registered(tmp_path)
    location["value"] = str(tmp_path)
    assert U.windows_registered(tmp_path)
    assert all(hive == "current-user" and access == 1 and (key.endswith(U.registration_name(tmp_path)) or key.endswith("Uninstall"))
               for hive, key, access in opened)


def test_registry_discovery_handles_windows_unicode_casing(tmp_path, monkeypatch):
    from contextlib import nullcontext
    root = tmp_path / "TLI \u0130"
    windows_name = "TLI-123456ABCDEF"  # Deliberately differs from Python's lowercase hash.
    def enumerate_keys(parent, index):
        if index == 0:
            return "Other-app"
        if index == 1:
            return windows_name
        raise OSError("End")
    def query(handle, name):
        if not handle.endswith(windows_name):
            raise OSError("Not registered under Python casing")
        return str(root), 1
    monkeypatch.setitem(sys.modules, "winreg", SimpleNamespace(
        HKEY_CURRENT_USER="current-user", KEY_READ=1,
        OpenKey=lambda hive, key, reserved, access: nullcontext(key),
        EnumKey=enumerate_keys, QueryValueEx=query))
    assert U.windows_registered(root)


def test_route_requires_session_and_has_no_mutation_methods(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "BASE_DIR", str(tmp_path))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: token == "valid-session")
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "local")
    monkeypatch.setattr(U, "windows_registered", lambda root: False)
    app = FastAPI()
    app.include_router(R.router)
    client = TestClient(app)
    assert client.get("/system/uninstall").status_code == 401
    client.cookies.set("tli_session", "valid-session")
    response = client.get("/system/uninstall")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["installation_path"] == str(tmp_path)
    assert client.post("/system/uninstall").status_code == 405
    assert list(tmp_path.iterdir()) == []
