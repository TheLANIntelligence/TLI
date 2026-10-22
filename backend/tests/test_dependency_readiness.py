"""Installed requirement provenance using disposable distribution metadata only."""
import importlib.metadata
import json
from pathlib import Path

import pytest
from pip._vendor.packaging import markers

import host_launcher as launcher


HASH = "a" * 64
URL = "https://example.test/releases/crypto/cryptography-50.0.2%2Btli.1-cp311-abi3-macosx_13_3_x86_64.whl"
REQUIREMENT = "cryptography @ " + URL + "#sha256=" + HASH
INTEL = 'sys_platform == "darwin" and platform_machine == "x86_64"'


@pytest.fixture
def installed(tmp_path, monkeypatch):
    backend = tmp_path / "backend"
    backend.mkdir()
    requirements = backend / "requirements.txt"
    requirements.write_text(REQUIREMENT + "\n", encoding="utf-8")
    info = tmp_path / "site/cryptography-50.0.2+tli.1.dist-info"
    info.mkdir(parents=True)
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: cryptography\nVersion: 50.0.2+tli.1\n", encoding="utf-8")
    (info / "RECORD").write_text(info.name + "/direct_url.json,,\n", encoding="utf-8")
    direct = info / "direct_url.json"
    direct.write_text(json.dumps({"url": URL, "archive_info": {"hashes": {"sha256": HASH}}}), encoding="utf-8")
    distribution = importlib.metadata.PathDistribution(info)
    calls = []
    def lookup(name):
        calls.append(name)
        assert name == "cryptography"
        return distribution
    monkeypatch.setattr(importlib.metadata, "distribution", lookup)
    return tmp_path, requirements, info, direct, calls


@pytest.mark.parametrize("legacy", [False, True])
def test_exact_installed_pinned_wheel_is_ready_offline(installed, legacy):
    root, _, _, direct, calls = installed
    if legacy:
        direct.write_text(json.dumps({"url": URL, "archive_info": {"hash": "sha256=" + HASH}}), encoding="utf-8")
    assert launcher.dependencies_ready(root)
    assert calls == ["cryptography"]


@pytest.mark.parametrize("version", ["48.0.0", "50.0.2", "50.0.2+tli.2"])
def test_old_upstream_or_different_vendor_version_never_satisfies_direct_url(installed, version):
    root, _, info, _, _ = installed
    (info / "METADATA").write_text("Name: cryptography\nVersion: " + version + "\n", encoding="utf-8")
    assert not launcher.dependencies_ready(root)


@pytest.mark.parametrize("origin", [
    {}, [], {"url": URL}, {"url": URL, "archive_info": []},
    {"url": URL, "archive_info": {}},
    {"url": URL + "?different", "archive_info": {"hashes": {"sha256": HASH}}},
    {"url": URL, "archive_info": {"hashes": {"sha256": "b" * 64}}},
    {"url": URL, "archive_info": {"hashes": [], "hash": "sha256=" + HASH}},
    {"url": URL, "archive_info": {"hashes": {"sha256": HASH}, "hash": "sha256=" + "b" * 64}},
    {"url": URL, "archive_info": {"hashes": {"sha256": HASH}}, "dir_info": {}},
    {"url": URL, "archive_info": {"hashes": {"sha256": HASH}}, "vcs_info": {}},
])
def test_missing_or_changed_provenance_is_not_ready(installed, origin):
    root, _, _, direct, _ = installed
    direct.write_text(json.dumps(origin), encoding="utf-8")
    assert not launcher.dependencies_ready(root)


@pytest.mark.parametrize("damage", ["missing", "invalid-json", "oversized", "duplicate", "no-record", "wrong-name"])
def test_damaged_dependency_metadata_fails_closed(installed, damage):
    root, _, info, direct, _ = installed
    if damage == "missing":
        direct.unlink()
    elif damage == "invalid-json":
        direct.write_bytes(b"not JSON")
    elif damage == "oversized":
        direct.write_bytes(b" " * (16 * 1024) + b"{}")
    elif damage == "duplicate":
        direct.write_text('{"url":"first","url":"second"}', encoding="utf-8")
    elif damage == "no-record":
        (info / "RECORD").unlink()
    else:
        (info / "METADATA").write_text("Name: another-package\nVersion: 50.0.2+tli.1\n", encoding="utf-8")
    assert not launcher.dependencies_ready(root)


@pytest.mark.parametrize("requirement", [
    REQUIREMENT.split("#", 1)[0], REQUIREMENT.replace("https:", "http:"),
    REQUIREMENT.replace(HASH, "short"), REQUIREMENT.replace("sha256=", "sha1="),
    REQUIREMENT.replace("cryptography @", "another-package @"),
])
def test_direct_requirement_must_identify_an_https_wheel_and_sha256(installed, requirement):
    root, requirements, _, _, _ = installed
    requirements.write_text(requirement + "\n", encoding="utf-8")
    assert not launcher.dependencies_ready(root)


@pytest.mark.parametrize("system,machine,active", [
    ("darwin", "x86_64", True), ("darwin", "arm64", False),
    ("win32", "AMD64", False), ("linux", "x86_64", False),
])
def test_hash_fragment_and_following_machine_marker_survive_comment_parsing(installed, monkeypatch, system, machine, active):
    root, requirements, _, direct, calls = installed
    requirements.write_text("# ordinary comment\n" + REQUIREMENT + " ; " + INTEL + " # inline comment\n", encoding="utf-8")
    environment = markers.default_environment()
    environment.update(sys_platform=system, platform_machine=machine)
    monkeypatch.setattr(markers, "default_environment", lambda: environment.copy())
    # No metadata on other platforms: skipping the marker must precede reads.
    if not active:
        direct.unlink()
    assert launcher.dependencies_ready(root)
    assert calls == (["cryptography"] if active else [])


@pytest.mark.parametrize("requirement,ready", [("cryptography>=50.0.2", True), ("cryptography>=51", False)])
def test_normal_version_requirements_keep_existing_behavior(installed, requirement, ready):
    root, requirements, _, _, _ = installed
    requirements.write_text(requirement + " # existing comment\n", encoding="utf-8")
    assert launcher.dependencies_ready(root) is ready


def test_direct_url_metadata_read_has_a_hard_byte_limit(installed, monkeypatch):
    root, _, _, direct, _ = installed
    original_open = Path.open
    class BoundedReader:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self, size):
            assert size == 16 * 1024 + 1
            return b" " * size
    def open_file(path, *args, **kwargs):
        return BoundedReader() if path == direct else original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, "open", open_file)
    assert not launcher.dependencies_ready(root)
