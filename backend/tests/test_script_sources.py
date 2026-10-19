"""Read-only legacy source export uses synthetic stores, never host execution."""
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import script_sources as sources
import tli_state as S


@pytest.fixture
def saved(tmp_path, monkeypatch):
    scripts = tmp_path / "tools" / "scripts"
    scripts.mkdir(parents=True)
    package_dir = tmp_path / "hub_packages"
    package_dir.mkdir()
    index = scripts.parent / "tools_index.json"
    source = scripts / "original.py"
    text = "# Saved source, never executed\nprint('review only')\n"
    source.write_bytes(text.encode("utf-8"))
    row = {"id":"legacy-one", "name":"Original tool", "language":"py", "script_path":str(source),
           "task_description":"Original task", "created_at":"original timestamp", "custom":{"keep":True}}
    index.write_text(json.dumps({row["id"]:row}), encoding="utf-8")
    installed = tmp_path / "hub_installed.json"
    installed.write_text(json.dumps([{"id":"package-one", "name":"Original package", "type":"script", "custom":7}]), encoding="utf-8")
    package = package_dir / "script_package-one.json"
    package.write_text(json.dumps({"id":"package-one", "shell":"powershell", "code":"# Source only\nWrite-Output 'review'", "custom":9}), encoding="utf-8")
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "SCRIPTS_DIR", scripts)
    monkeypatch.setattr(S, "TOOLS_INDEX_PATH", index)
    return SimpleNamespace(root=tmp_path, scripts=scripts, source=source, text=text, row=row, index=index,
                           installed=installed, package=package, package_dir=package_dir)


def snapshot(root):
    return {str(path.relative_to(root)):path.read_bytes() for path in root.rglob("*") if path.is_file() and not path.is_symlink()}


def invoke(saved, kind, check=lambda:None):
    if kind == "metadata":
        return sources.list_tool_metadata()
    if kind == "tool":
        return sources.read_tool_source("legacy-one", check)
    return sources.read_hub_source("package-one", check)


def rejected(status, call):
    with pytest.raises(HTTPException) as error:
        call()
    assert error.value.status_code == status, repr(error.value.__context__)
    assert error.value.headers == {"Cache-Control": "no-store"}
    return error.value


def test_metadata_keeps_legacy_fields_and_source_contracts_do_not_write(saved):
    before = snapshot(saved.root)
    metadata = sources.list_tool_metadata()
    assert len(metadata) == 1
    assert all(metadata[0][key] == value for key, value in saved.row.items())
    assert metadata[0]["path"] == str(saved.source)
    assert metadata[0]["kind"] == "script" and metadata[0]["executable"] is False
    assert "retired" in metadata[0]["unavailable_reason"]
    assert sources.list_hub_metadata(lambda: None) == json.loads(saved.installed.read_text(encoding="utf-8"))
    assert invoke(saved, "tool") == {"id":"legacy-one", "name":"Original tool", "language":"py",
                                      "contents":saved.text, "execution_allowed":False}
    assert invoke(saved, "hub") == {"id":"package-one", "name":"Original package", "shell":"powershell",
                                    "contents":"# Source only\nWrite-Output 'review'", "execution_allowed":False}
    assert snapshot(saved.root) == before


def test_missing_store_is_empty_without_creating_any_directories(tmp_path, monkeypatch):
    root = tmp_path / "absent"
    monkeypatch.setattr(S, "TOOLS_INDEX_PATH", root / "tools" / "tools_index.json")
    monkeypatch.setattr(S, "DATA_DIR", str(root))
    assert sources.list_tool_metadata() == []
    assert sources.list_hub_metadata(lambda: None) == []
    rejected(404, lambda:sources.read_tool_source("missing", lambda:None))
    rejected(404, lambda:sources.read_hub_source("missing", lambda:None))
    assert not root.exists()


@pytest.mark.parametrize("kind", ["tool", "hub"])
@pytest.mark.parametrize("raw", [b"", b"{broken", b"null", b"true", b'"text"', b"\xff", b" " * (sources.INDEX_LIMIT + 1),
    b'{"x":1,"x":2}', b'{"nested":{"x":1,"x":2}}', b'{"value":NaN}', b'{"value":Infinity}', b'{"value":1e999}'],
    ids=["empty", "broken", "null", "boolean", "string", "encoding", "oversize", "duplicate", "nested-duplicate", "nan", "infinity", "overflow"])
def test_invalid_index_is_preserved_and_never_defaulted(saved, kind, raw):
    path = saved.index if kind == "tool" else saved.installed
    path.write_bytes(raw)
    before = snapshot(saved.root)
    rejected(503, lambda:invoke(saved, kind))
    if kind == "tool":
        rejected(503, sources.list_tool_metadata)
    else:
        rejected(503, lambda: sources.list_hub_metadata(lambda: None))
    assert snapshot(saved.root) == before


@pytest.mark.parametrize("value", [[], {"wrong":{}}, {"wrong":{"id":"another", "name":"Name", "language":"py", "script_path":"x"}},
    {"wrong":{"id":"wrong", "name":"Name", "language":"py"}}, {"wrong":{"id":"wrong", "name":None, "language":"py", "script_path":"x"}}])
def test_wrong_tool_shape_fails_preserving_bytes(saved, value):
    raw = json.dumps(value).encode()
    saved.index.write_bytes(raw)
    rejected(503, sources.list_tool_metadata)
    assert saved.index.read_bytes() == raw


@pytest.mark.parametrize("value", [{}, [None], [{"id":"package-one", "type":"script"}],
    [{"id":"same", "name":"One", "type":"script"}, {"id":"same", "name":"Two", "type":"script"}]])
def test_wrong_hub_shape_or_duplicate_identity_fails(saved, value):
    raw = json.dumps(value).encode()
    saved.installed.write_bytes(raw)
    rejected(503, lambda:invoke(saved, "hub"))
    assert saved.installed.read_bytes() == raw


@pytest.mark.parametrize("kind", ["tool", "hub"])
def test_row_limit(saved, kind):
    rows = [{"id":f"entry-{number}", "name":"Name", "type":"script", "language":"py", "script_path":str(saved.source)}
            for number in range(sources.ROW_LIMIT + 1)]
    (saved.index if kind == "tool" else saved.installed).write_text(json.dumps({r["id"]:r for r in rows} if kind == "tool" else rows))
    rejected(503, lambda:invoke(saved, kind))


@pytest.mark.parametrize("kind", ["tool", "hub"])
def test_missing_registered_source_is_not_deleted_or_recreated(saved, kind):
    (saved.source if kind == "tool" else saved.package).unlink()
    before = snapshot(saved.root)
    rejected(404, lambda:invoke(saved, kind))
    assert snapshot(saved.root) == before


@pytest.mark.parametrize("kind", ["tool", "hub"])
def test_unknown_id_does_not_read_source(saved, monkeypatch, kind):
    open_file = sources.os.open
    calls = []
    def observed(path, *args, **kwargs):
        calls.append(Path(path))
        return open_file(path, *args, **kwargs)
    monkeypatch.setattr(sources.os, "open", observed)
    call = sources.read_tool_source if kind == "tool" else sources.read_hub_source
    rejected(404, lambda:call("unknown", lambda:None))
    assert calls == [saved.index if kind == "tool" else saved.installed]


@pytest.mark.parametrize("pkg_id", ["../outside", "a/b", "a\\b", "*", "?", ".", "C:\\outside", "name:stream", "a" * 129])
def test_unsafe_hub_id_is_rejected_before_read(saved, monkeypatch, pkg_id):
    monkeypatch.setattr(sources.os, "open", lambda *a, **k:pytest.fail("Invalid ID must not open a file"))
    rejected(400, lambda:sources.read_hub_source(pkg_id, lambda:None))


@pytest.mark.parametrize("variant", ["outside", "traversal", "relative", "stream"])
def test_registered_tool_path_cannot_escape_or_use_alternate_stream(saved, variant):
    outside = saved.root / "outside.py"
    outside.write_text("private outside contents")
    path = {"outside":str(outside), "traversal":str(saved.scripts / ".." / ".." / "outside.py"),
            "relative":"original.py", "stream":str(saved.source) + ":hidden"}[variant]
    saved.index.write_text(json.dumps({"legacy-one":{**saved.row, "script_path":path}}))
    before = snapshot(saved.root)
    error = rejected(503, lambda:invoke(saved, "tool"))
    assert "private outside" not in error.detail and str(outside) not in error.detail
    assert snapshot(saved.root) == before


@pytest.mark.parametrize("kind", ["tool", "hub"])
@pytest.mark.parametrize("mode", ["hardlink", "symlink", "broken-symlink", "parent-link"])
def test_link_aliases_are_rejected_without_reading_the_target(saved, monkeypatch, kind, mode):
    target = saved.source if kind == "tool" else saved.package
    original = target.read_bytes()
    outside = saved.root / "outside"
    outside.mkdir()
    other = outside / target.name
    other.write_bytes(original)
    target.unlink()
    try:
        if mode == "hardlink":
            os.link(other, target)
        elif mode == "parent-link":
            target.parent.rmdir()
            target.parent.symlink_to(outside, target_is_directory=True)
        else:
            target.symlink_to(other if mode == "symlink" else outside / "absent")
    except OSError as error:
        pytest.skip(f"Host cannot create test link: {error}")
    open_file = sources.os.open
    opened = []
    def observed(path, *args, **kwargs):
        opened.append(Path(path))
        return open_file(path, *args, **kwargs)
    monkeypatch.setattr(sources.os, "open", observed)
    rejected(503, lambda:invoke(saved, kind))
    assert opened == [saved.index if kind == "tool" else saved.installed]
    assert other.read_bytes() == original


@pytest.mark.parametrize("kind", ["tool", "hub"])
def test_reparse_attributes_are_rejected_without_open(saved, monkeypatch, kind):
    path = saved.source if kind == "tool" else saved.package
    lstat = Path.lstat
    def replaced(current):
        info = lstat(current)
        if current != path:
            return info
        return SimpleNamespace(st_mode=info.st_mode, st_nlink=info.st_nlink, st_file_attributes=0x400)
    monkeypatch.setattr(Path, "lstat", replaced)
    rejected(503, lambda:invoke(saved, kind))


@pytest.mark.parametrize("kind", ["tool", "hub"])
@pytest.mark.parametrize("broken", [False, True])
def test_linked_index_is_not_treated_as_missing_or_trusted(saved, kind, broken):
    path = saved.index if kind == "tool" else saved.installed
    original = path.read_bytes()
    other = saved.root / "index-copy"
    other.write_bytes(original)
    path.unlink()
    try:
        path.symlink_to(other if not broken else saved.root / "missing-index-target")
    except OSError as error:
        pytest.skip(f"Host cannot create test link: {error}")
    rejected(503, lambda:invoke(saved, kind))
    assert path.is_symlink() and other.read_bytes() == original


@pytest.mark.parametrize("kind", ["tool", "hub"])
@pytest.mark.parametrize("raw", [b"\xff", b"x" * (sources.SOURCE_LIMIT + 1)], ids=["encoding", "oversize"])
def test_source_encoding_and_size_are_bounded(saved, kind, raw):
    path = saved.source if kind == "tool" else saved.package
    path.write_bytes(raw if kind == "tool" or raw == b"\xff" else json.dumps({"code":raw.decode()}).encode())
    before = path.read_bytes()
    rejected(503, lambda:invoke(saved, kind))
    assert path.read_bytes() == before


@pytest.mark.parametrize("raw", [b"null", b"[]", b'{"code":3}', b'{"code":"a","code":"b"}',
    b'{"code":"a","metadata":1e999}', b'{"id":"another","code":"a"}'])
def test_invalid_hub_source_document_is_preserved(saved, raw):
    saved.package.write_bytes(raw)
    rejected(503, lambda:invoke(saved, "hub"))
    assert saved.package.read_bytes() == raw


def test_non_script_hub_package_has_no_source(saved):
    saved.installed.write_text(json.dumps([{"id":"package-one", "name":"Theme", "type":"theme"}]))
    rejected(400, lambda:invoke(saved, "hub"))


@pytest.mark.parametrize("kind", ["tool", "hub"])
@pytest.mark.parametrize("location", ["index", "source"])
def test_permission_failure_is_generic_and_preserves_files(saved, monkeypatch, kind, location):
    open_file = sources.os.open
    path = (saved.index if kind == "tool" else saved.installed) if location == "index" else (saved.source if kind == "tool" else saved.package)
    before = snapshot(saved.root)
    def denied(current, *args, **kwargs):
        if Path(current) == path:
            raise PermissionError("private system details")
        return open_file(current, *args, **kwargs)
    monkeypatch.setattr(sources.os, "open", denied)
    error = rejected(503, lambda:invoke(saved, kind))
    assert "private system" not in error.detail
    assert snapshot(saved.root) == before


@pytest.mark.parametrize("kind", ["tool", "hub"])
@pytest.mark.parametrize("stage", ["initial", "after-index", "after-source", "before-return"])
def test_original_authority_rechecked_and_revocation_propagates(saved, monkeypatch, kind, stage):
    error = HTTPException(401, "Original session revoked")
    revoked = stage == "initial"
    checks = []
    def check():
        checks.append(True)
        if revoked:
            raise error
    raw = sources._read_raw
    def read_and_revoke(path, *args, **kwargs):
        nonlocal revoked
        value = raw(path, *args, **kwargs)
        if (stage == "after-index" and Path(path) in (saved.index, saved.installed)
                or stage == "after-source" and Path(path) in (saved.source, saved.package)):
            revoked = True
        return value
    monkeypatch.setattr(sources, "_read_raw", read_and_revoke)
    if kind == "hub" and stage == "after-index":
        import hub_store
        read_artifact = hub_store.read_artifact
        def read_hub_index_and_revoke(path, *args, **kwargs):
            nonlocal revoked
            value = read_artifact(path, *args, **kwargs)
            if Path(path) == saved.installed:
                revoked = True
            return value
        monkeypatch.setattr(hub_store, "read_artifact", read_hub_index_and_revoke)
    if stage == "before-return":
        # Find the final check count for this complete read, then reject exactly
        # that disclosure check while all preceding reads remain authorized.
        invoke(saved, kind, check)
        target = len(checks)
        checks.clear()
        def check():
            checks.append(True)
            if len(checks) == target:
                raise error
    before = snapshot(saved.root)
    with pytest.raises(HTTPException) as result:
        invoke(saved, kind, check)
    assert result.value is error
    assert snapshot(saved.root) == before


@pytest.mark.parametrize("kind", ["tool", "hub"])
def test_disappearing_existing_index_does_not_become_empty(saved, monkeypatch, kind):
    path = saved.index if kind == "tool" else saved.installed
    open_file = sources.os.open
    def changed(current, *args, **kwargs):
        if Path(current) == path:
            path.unlink()
        return open_file(current, *args, **kwargs)
    monkeypatch.setattr(sources.os, "open", changed)
    rejected(503, lambda:invoke(saved, kind))


@pytest.mark.parametrize("kind", ["tool", "hub"])
@pytest.mark.parametrize("stage", ["open", "read"])
def test_source_changed_during_read_is_preserved_and_never_disclosed(saved, monkeypatch, kind, stage):
    target = saved.source if kind == "tool" else saved.package
    replacement = target.read_bytes() + b"\n# externally changed"
    open_file, fdopen = sources.os.open, sources.os.fdopen
    source_descriptors = set()
    source_reads = []
    def open_changed(path, *args, **kwargs):
        if Path(path) == target and stage == "open":
            target.write_bytes(replacement)
        descriptor = open_file(path, *args, **kwargs)
        if Path(path) == target:
            source_descriptors.add(descriptor)
        return descriptor
    class ObservedStream:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): return self
        def __exit__(self, *args): return self.stream.__exit__(*args)
        def fileno(self): return self.stream.fileno()
        def read(self, limit):
            source_reads.append(limit)
            result = self.stream.read(limit)
            target.write_bytes(replacement)
            return result
    def observed(descriptor, *args, **kwargs):
        stream = fdopen(descriptor, *args, **kwargs)
        return ObservedStream(stream) if descriptor in source_descriptors else stream
    monkeypatch.setattr(sources.os, "open", open_changed)
    monkeypatch.setattr(sources.os, "fdopen", observed)
    rejected(503, lambda:invoke(saved, kind))
    assert target.read_bytes() == replacement
    assert len(source_reads) == (1 if stage == "read" else 0)


@pytest.mark.parametrize("kind", ["tool", "hub"])
def test_authority_loss_during_read_failure_keeps_original_denial(saved, monkeypatch, kind):
    path = saved.source if kind == "tool" else saved.package
    revoked = False
    denial = HTTPException(403, "Original access changed")
    def check():
        if revoked:
            raise denial
    open_file = sources.os.open
    def changed(current, *args, **kwargs):
        nonlocal revoked
        if Path(current) == path:
            revoked = True
            raise PermissionError("private failure")
        return open_file(current, *args, **kwargs)
    monkeypatch.setattr(sources.os, "open", changed)
    with pytest.raises(HTTPException) as result:
        invoke(saved, kind, check)
    assert result.value is denial
