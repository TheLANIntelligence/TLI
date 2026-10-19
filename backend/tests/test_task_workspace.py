import codecs
import json
import os
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

import task_workspace as workspace
import tli_state as S


@pytest.fixture
def area(tmp_path, monkeypatch):
    root = tmp_path / 'game'
    root.mkdir()
    (root / 'mods').mkdir()
    (root / 'logs').mkdir()
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path / 'private'))
    monkeypatch.setattr(S, 'VAULT_DIR', str(tmp_path / 'private' / 'vault'))
    return root, workspace.save_area('alice', name='Game repair', read_roots=[str(root)], write_roots=[str(root / 'mods')])


def call(area, name, args, owner='alice', check=lambda: None):
    return workspace.dispatch(owner, area[1]['id'], name, args, check, task_id='task_fixture')


def test_log_driven_mod_repair_preserves_other_files_and_undo(area):
    root, _ = area
    config = root / 'mods' / 'settings.json'
    config.write_bytes(codecs.BOM_UTF8 + b'{\r\n  "hotkey": "F8",\r\n}\r\n')
    (root / 'logs' / 'latest.log').write_text('JSONDecodeError in mods/settings.json line 3\n')
    protected = [root / 'saves' / 'slot.sav', root / 'game.exe', root / 'mods' / 'plugin.dll']
    for path in protected:
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b'untouched\x00binary')
    search = call(area, 'workspace_search', {'path': str(root), 'query': 'JSONDecodeError'})
    assert search['matches'][0]['path'].endswith('latest.log')
    before = call(area, 'workspace_read', {'path': str(config)})
    assert call(area, 'workspace_validate', {'path': str(config)})['valid'] is False
    result = call(area, 'workspace_write', {'path': str(config), 'content': '{\n  "hotkey": "F8"\n}\n',
                                           'expected_sha256': before['sha256']})
    assert config.read_bytes() == codecs.BOM_UTF8 + b'{\r\n  "hotkey": "F8"\r\n}\r\n'
    assert call(area, 'workspace_validate', {'path': str(config)})['valid'] is True
    assert all(path.read_bytes() == b'untouched\x00binary' for path in protected)
    assert result['receipt']['task_id'] == 'task_fixture'
    call(area, 'workspace_undo', {'operation_id': result['receipt']['id']})
    assert config.read_bytes() == codecs.BOM_UTF8 + b'{\r\n  "hotkey": "F8",\r\n}\r\n'


def test_utf16_and_current_hash_guard(area):
    path = area[0] / 'mods' / 'settings.ini'
    original = codecs.BOM_UTF16_LE + '[mod]\r\nlevel=1\r\n'.encode('utf-16-le')
    path.write_bytes(original)
    before = call(area, 'workspace_read', {'path': str(path)})
    result = call(area, 'workspace_write', {'path': str(path), 'content': '[mod]\nlevel=2\n', 'expected_sha256': before['sha256']})
    assert path.read_bytes() == codecs.BOM_UTF16_LE + '[mod]\r\nlevel=2\r\n'.encode('utf-16-le')
    with pytest.raises(HTTPException, match='changed'):
        call(area, 'workspace_write', {'path': str(path), 'content': 'stale', 'expected_sha256': before['sha256']})
    path.write_bytes(b'new user work')
    with pytest.raises(HTTPException, match='newer work'):
        call(area, 'workspace_undo', {'operation_id': result['receipt']['id']})
    assert path.read_bytes() == b'new user work'


def test_owner_revocation_and_area_revision(area):
    root, saved = area
    with pytest.raises(HTTPException) as denied:
        call(area, 'workspace_list', {'path': str(root)}, owner='bob')
    assert denied.value.status_code == 404
    with pytest.raises(HTTPException) as stale:
        workspace.save_area('alice', area_id=saved['id'], name='Changed', read_roots=[str(root)], write_roots=[])
    assert stale.value.status_code == 409
    workspace.revoke_area('alice', saved['id'])
    with pytest.raises(HTTPException):
        call(area, 'workspace_list', {'path': str(root)})


@pytest.mark.parametrize('relative', ['saves/config.json', 'profiles/config.json', 'mods/plugin.dll',
                                     'mods/package.zip', 'mods/appmanifest_123.acf', 'mods/.env'])
def test_protected_paths_cannot_be_edited(area, relative):
    root, _ = area
    path = root / relative
    path.parent.mkdir(exist_ok=True)
    path.write_text('{}')
    with pytest.raises(HTTPException):
        call(area, 'workspace_write', {'path': str(path), 'content': '{}', 'expected_sha256': '0' * 64})
    assert path.read_text() == '{}'


def test_outside_and_reparse_and_hard_link_rejected(area, tmp_path, monkeypatch):
    path = area[0] / 'mods' / 'file.json'
    path.write_text('{}')
    outside = tmp_path / 'outside.json'
    outside.write_text('private')
    with pytest.raises(HTTPException):
        call(area, 'workspace_read', {'path': str(outside)})
    os.link(path, area[0] / 'mods' / 'second.json')
    with pytest.raises(HTTPException):
        call(area, 'workspace_read', {'path': str(path)})
    original = Path.lstat
    monkeypatch.setattr(Path, 'lstat', lambda p: SimpleNamespace(st_mode=stat_mode, st_file_attributes=0x400) if p == path.parent else original(p))
    stat_mode = 0
    with pytest.raises(HTTPException, match='junctions'):
        call(area, 'workspace_read', {'path': str(path)})


def test_snapshot_failure_prevents_target_write(area, monkeypatch):
    path = area[0] / 'mods' / 'file.json'
    path.write_text('{}')
    before = call(area, 'workspace_read', {'path': str(path)})
    def fail(*args, **kwargs):
        raise workspace.security_state.SecurityStateUnavailable('test snapshots')
    monkeypatch.setattr(workspace, '_save', fail)
    with pytest.raises(HTTPException):
        call(area, 'workspace_write', {'path': str(path), 'content': '{"changed":true}', 'expected_sha256': before['sha256']})
    assert path.read_text() == '{}'


def test_corrupt_state_is_preserved_and_new_files_can_be_undone(area):
    path = area[0] / 'mods' / 'new.py'
    result = call(area, 'workspace_write', {'path': str(path), 'content': 'value = 1\n', 'create': True})
    assert call(area, 'workspace_validate', {'path': str(path)})['valid'] is True
    call(area, 'workspace_undo', {'operation_id': result['receipt']['id']})
    assert not path.exists()
    store = workspace._store('alice')
    store.write_text('{broken')
    with pytest.raises(HTTPException) as error:
        workspace.list_areas('alice')
    assert error.value.status_code == 503 and store.read_text() == '{broken'


def test_authorization_revoked_before_write_preserves_target(area):
    path = area[0] / 'mods' / 'file.json'
    path.write_text('{}')
    before = call(area, 'workspace_read', {'path': str(path)})
    calls = 0
    def check():
        nonlocal calls
        calls += 1
        if calls == 3:
            raise HTTPException(401, 'Revoked')
    with pytest.raises(HTTPException, match='Revoked'):
        call(area, 'workspace_write', {'path': str(path), 'content': '[]', 'expected_sha256': before['sha256']}, check=check)
    assert path.read_text() == '{}'
    operations = workspace._load('alice')['operations']
    pending = next(value for value in operations.values() if value['status'] == 'prepared')
    recovered = call(area, 'workspace_undo', {'operation_id': pending['id']})
    assert recovered['already_restored'] and path.read_text() == '{}'


def test_replaced_root_and_filename_search(area, tmp_path):
    root, saved = area
    path = root / 'mods' / 'settings.json'
    path.write_text('{}')
    result = call(area, 'workspace_search', {'path': str(root), 'query': 'settings.json'})
    assert result['matches'][0]['kind'] == 'filename'
    root.rename(tmp_path / 'original-game')
    root.mkdir()
    (root / 'mods').mkdir()
    path.write_text('{"different":true}')
    with pytest.raises(HTTPException, match='replaced'):
        call(area, 'workspace_read', {'path': str(path)})


@pytest.mark.parametrize('layout', ['Steam/steamapps/common', 'Epic Games', 'GOG Galaxy/Games', 'GOG Games'])
def test_installed_game_grants_are_narrow_and_never_elevate(area, tmp_path, monkeypatch, layout):
    programs = tmp_path / 'Program Files'
    library = programs / layout
    game = library / 'FixtureGame'
    mods = game / 'mods'
    mods.mkdir(parents=True)
    monkeypatch.setenv('ProgramFiles', str(programs))
    monkeypatch.setattr(S, 'is_protected_system_path', lambda p: p.is_relative_to(programs))
    saved = workspace.save_area('alice', name='Installed game', read_roots=[str(game)], write_roots=[str(mods)])
    assert saved['read_roots'] == [str(game)] and saved['write_roots'] == [str(mods)]
    for root in (programs, library):
        with pytest.raises(HTTPException):
            workspace.save_area('alice', name='Broad launcher', read_roots=[str(root)], write_roots=[])
    with pytest.raises(HTTPException):
        workspace.save_area('alice', name='Broad writes', read_roots=[str(game)], write_roots=[str(game)])


def test_final_journal_failure_retains_snapshot_for_explicit_recovery(area, monkeypatch):
    path = area[0] / 'mods' / 'settings.json'
    path.write_text('{}')
    before = call(area, 'workspace_read', {'path': str(path)})
    save = workspace._save
    count = 0
    def fail_after_effect(*args):
        nonlocal count
        count += 1
        if count == 2:
            raise workspace.security_state.SecurityStateUnavailable('simulated final journal failure')
        save(*args)
    monkeypatch.setattr(workspace, '_save', fail_after_effect)
    result = call(area, 'workspace_write', {'path': str(path), 'content': '[]', 'expected_sha256': before['sha256']})
    assert result['outcome'] == 'unknown' and result['undo_available']
    assert path.read_text() == '[]'
    pending = next(iter(workspace._load('alice')['operations'].values()))
    assert pending['status'] == 'prepared'
    assert result['receipt']['id'] == pending['id'] and result['receipt']['task_id'] == 'task_fixture'
    call(area, 'workspace_undo', {'operation_id': pending['id']})
    assert path.read_text() == '{}'


def test_crash_recovery_receipts_are_owner_area_and_task_scoped(area):
    path = area[0] / 'mods' / 'created.json'
    result = call(area, 'workspace_write', {'path': str(path), 'content': '{}', 'create': True})
    state = workspace._load('alice')
    state['operations'][result['receipt']['id']]['status'] = 'prepared'
    workspace._save('alice', state)
    receipts = workspace.list_operation_receipts('alice', area[1]['id'], 'task_fixture')
    assert receipts == [{**result['receipt'], 'status': 'prepared'}]
    assert all('before' not in entry and 'content' not in entry for entry in receipts)
    assert workspace.list_operation_receipts('alice', area[1]['id'], 'another_task') == []
    with pytest.raises(HTTPException):
        workspace.list_operation_receipts('bob', area[1]['id'], 'task_fixture')
    with pytest.raises(HTTPException):
        workspace.list_operation_receipts('alice', 'another_area', 'task_fixture')
    call(area, 'workspace_undo', {'operation_id': receipts[0]['id']})
    assert not path.exists()


def test_target_flush_failure_returns_uncertain_receipt_instead_of_retry(area, monkeypatch):
    path = area[0] / 'mods' / 'settings.json'
    path.write_text('{}')
    before = call(area, 'workspace_read', {'path': str(path)})
    original_fsync, calls = workspace.os.fsync, 0
    def fail_target(fd):
        nonlocal calls
        calls += 1
        if calls == 2:  # first fsync durably prepared the snapshot
            raise OSError('simulated target flush failure')
        return original_fsync(fd)
    monkeypatch.setattr(workspace.os, 'fsync', fail_target)
    result = call(area, 'workspace_write', {'path': str(path), 'content': '[]', 'expected_sha256': before['sha256']})
    assert result['outcome'] == 'unknown' and result['receipt']['status'] == 'prepared'
    assert path.read_text() == '[]'
    call(area, 'workspace_undo', {'operation_id': result['receipt']['id']})
    assert path.read_text() == '{}'


def test_failed_final_undo_journal_can_be_recovered_without_reapplying(area, monkeypatch):
    path = area[0] / 'mods' / 'settings.json'
    path.write_text('{}')
    before = call(area, 'workspace_read', {'path': str(path)})
    result = call(area, 'workspace_write', {'path': str(path), 'content': '[]', 'expected_sha256': before['sha256']})
    save, count = workspace._save, 0
    def fail_final(*args):
        nonlocal count
        count += 1
        if count == 2:
            raise workspace.security_state.SecurityStateUnavailable('simulated final undo journal failure')
        save(*args)
    monkeypatch.setattr(workspace, '_save', fail_final)
    operation_id = result['receipt']['id']
    result = call(area, 'workspace_undo', {'operation_id': operation_id})
    assert result['outcome'] == 'unknown' and path.read_text() == '{}'
    assert workspace._load('alice')['operations'][operation_id]['status'] == 'undo_prepared'
    recovered = call(area, 'workspace_undo', {'operation_id': operation_id})
    assert recovered['already_restored'] and path.read_text() == '{}'


def test_undo_flush_uncertainty_is_not_automatically_repeated(area, monkeypatch):
    path = area[0] / 'mods' / 'settings.json'
    path.write_text('{}')
    before = call(area, 'workspace_read', {'path': str(path)})
    result = call(area, 'workspace_write', {'path': str(path), 'content': '[]', 'expected_sha256': before['sha256']})
    original_fsync, calls = workspace.os.fsync, 0
    def fail_target(fd):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError('simulated undo flush failure')
        return original_fsync(fd)
    monkeypatch.setattr(workspace.os, 'fsync', fail_target)
    operation_id = result['receipt']['id']
    result = call(area, 'workspace_undo', {'operation_id': operation_id})
    assert result['outcome'] == 'unknown' and result['receipt']['status'] == 'undo_prepared'
    assert path.read_text() == '{}'
    recovered = call(area, 'workspace_undo', {'operation_id': operation_id})
    assert recovered['already_restored'] and path.read_text() == '{}'


def test_search_reports_entry_limit_even_when_files_are_excluded(area, monkeypatch):
    for index in range(20):
        (area[0] / 'mods' / f'{index}.bin').write_bytes(b'binary')
    monkeypatch.setattr(workspace, 'MAX_ENTRIES', 5)
    result = call(area, 'workspace_search', {'path': str(area[0] / 'mods'), 'query': 'missing'})
    assert result['truncated'] and result['matches'] == []
