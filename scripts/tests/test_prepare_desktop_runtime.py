"""Runtime preparation uses synthetic archives; never downloads or runs a model."""
import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import tarfile
import zipfile

import pytest

spec = importlib.util.spec_from_file_location("prepare_runtime", Path(__file__).resolve().parents[1] / "prepare_desktop_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def zip_archive(tmp_path, entries):
    path = tmp_path / "runtime.zip"
    with zipfile.ZipFile(path, "w") as archive:
        for name, raw in entries.items():
            archive.writestr(name, raw)
    return path


def tar_archive(tmp_path, entries):
    path = tmp_path / "runtime.tar.gz"
    with tarfile.open(path, "w:gz") as archive:
        for name, raw in entries.items():
            member = tarfile.TarInfo(name)
            if isinstance(raw, tuple):
                member.type = tarfile.SYMTYPE
                member.linkname = raw[0]
                archive.addfile(member)
            else:
                member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
    return path


def mac_entries(architecture="arm64"):
    raw = b"\xcf\xfa\xed\xfe" + (b"\x0c\x00\x00\x01" if architecture == "arm64" else b"\x07\x00\x00\x01") + b"synthetic"
    entries = {"llama-b7896/llama-server": raw, "llama-b7896/LICENSE": b"synthetic license"}
    for name in ("llama", "mtmd", "ggml", "ggml-base", "ggml-cpu", "ggml-blas", "ggml-rpc", "ggml-metal"):
        entries[f"llama-b7896/lib{name}.0.1.dylib"] = raw
        entries[f"llama-b7896/lib{name}.0.dylib"] = (f"lib{name}.0.1.dylib",)
        entries[f"llama-b7896/lib{name}.dylib"] = (f"lib{name}.0.dylib",)
    return entries


def test_windows_selects_server_and_runtime_libraries(tmp_path):
    required = {"llama-server.exe", "llama.dll", "mtmd.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-x64.dll", "libomp140.x86_64.dll"}
    entries = dict.fromkeys(required | {"llama-cli.exe", "rpc-server.exe", "private.json", "model.gguf"}, b"synthetic")
    selected = runtime.read_windows(zip_archive(tmp_path, entries))
    assert set(selected) == (required - {"llama-server.exe"}) | {"llama_server.exe"}


@pytest.mark.parametrize("name", ["../escape.dll", "/absolute.dll", "C:/escape.dll", "a/../../escape.dll"])
def test_unsafe_paths_are_rejected_even_if_unselected(tmp_path, name):
    with pytest.raises(ValueError, match="Unsafe archive path"):
        runtime.read_windows(zip_archive(tmp_path, {name: b"synthetic"}))


def test_tar_windows_separator_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="Unsafe archive path"):
        runtime.read_macos(tar_archive(tmp_path, {"a\\escape.dll": b"synthetic"}), "arm64")


def test_zip_symlinks_are_rejected(tmp_path):
    path = tmp_path / "linked.zip"
    with zipfile.ZipFile(path, "w") as archive:
        member = zipfile.ZipInfo("llama-server.exe")
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(member, "outside.exe")
    with pytest.raises(ValueError, match="ZIP links"):
        runtime.read_windows(path)


def test_macos_alias_chain_becomes_regular_identical_bytes(tmp_path):
    entries = mac_entries()
    entries["llama-b7896/llama-cli"] = b"unselected"
    selected = runtime.read_macos(tar_archive(tmp_path, entries), "arm64")
    assert selected["libllama.dylib"] == selected["libllama.0.dylib"] == selected["libllama.0.1.dylib"]
    assert "llama-cli" not in selected
    assert all(isinstance(value, bytes) for value in selected.values())


@pytest.mark.parametrize("target", ["../../outside.dylib", "/outside.dylib", "missing.dylib", "libllama.dylib"])
def test_macos_outside_missing_or_cyclic_alias_fails(tmp_path, target):
    entries = mac_entries()
    entries["llama-b7896/libllama.dylib"] = (target,)
    with pytest.raises(ValueError):
        runtime.read_macos(tar_archive(tmp_path, entries), "arm64")


def test_wrong_architecture_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="architecture"):
        runtime.read_macos(tar_archive(tmp_path, mac_entries("x64")), "arm64")


def test_wrong_cached_digest_never_reaches_archive_reader(tmp_path, monkeypatch):
    path = tmp_path / "asset.zip"
    path.write_bytes(b"wrong cached file")
    monkeypatch.setattr(runtime.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("no replacement download"))
    with pytest.raises(ValueError, match="SHA-256"):
        runtime.cached_download("https://example.invalid/asset.zip", "0" * 64, tmp_path, path.name)
    assert path.read_bytes() == b"wrong cached file"


def test_cached_asset_verified_without_network(tmp_path, monkeypatch):
    path = tmp_path / "asset.zip"
    path.write_bytes(b"pinned bytes")
    monkeypatch.setattr(runtime.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("cached asset should not download"))
    assert runtime.cached_download("https://example.invalid/asset.zip", hashlib.sha256(path.read_bytes()).hexdigest(), tmp_path, path.name) == path


def test_prepare_preserves_existing_different_files_before_any_writes(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir()
    placeholder = cache / "placeholder"
    placeholder.write_bytes(b"synthetic license")
    monkeypatch.setattr(runtime, "cached_download", lambda *a: placeholder)
    monkeypatch.setattr(runtime, "read_windows", lambda *a: {"llama_server.exe": b"new", "llama.dll": b"new"})
    output = tmp_path / "output"
    output.mkdir()
    (output / "llama.dll").write_bytes(b"old")
    with pytest.raises(ValueError, match="Refusing to replace"):
        runtime.prepare("windows", output, cache)
    assert (output / "llama.dll").read_bytes() == b"old"
    assert not (output / "llama_server.exe").exists()


def test_prepare_stages_licenses_and_is_repeatable(tmp_path, monkeypatch):
    license_path = tmp_path / "license.txt"
    license_path.write_bytes(b"synthetic license")
    monkeypatch.setattr(runtime, "cached_download", lambda *a: license_path)
    monkeypatch.setattr(runtime, "read_windows", lambda *a: {"llama_server.exe": b"server"})
    output = tmp_path / "output"
    first = runtime.prepare("windows", output, tmp_path / "cache")
    assert runtime.prepare("windows", output, tmp_path / "cache") == first
    assert set(runtime.LICENSES) <= {path.name for path in output.iterdir()}
    assert runtime.ASSETS["windows"][1] in (output / "RUNTIME-NOTICES.txt").read_text()


def test_output_reparse_point_is_rejected(tmp_path, monkeypatch):
    original = Path.lstat
    from types import SimpleNamespace
    monkeypatch.setattr(Path, "lstat", lambda path: SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400) if path == tmp_path else original(path))
    with pytest.raises(ValueError, match="Linked output"):
        runtime.unlinked(tmp_path / "output")
