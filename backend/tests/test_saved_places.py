"""Favorites must remain inert, owner-scoped and usable after targets disappear."""
import json
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException
import tli_state as S
from intelligence import memory, places, store

URL = '/api/intelligence/places'


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})


def save(client, **values):
    response = client.post(URL, json={'name': 'Free space', 'kind': 'panel', 'target': 'panel-visualizer', **values})
    assert response.status_code == 200, response.text
    return response.json()['place']


def test_roundtrip_encrypted_duplicate_and_owner_bound(client, tmp_path, monkeypatch):
    monkeypatch.setattr(places, '_probe', lambda *_: pytest.fail('Saving must not probe paths'))
    original = save(client, name='Private folder', kind='folder', target=str(tmp_path / 'Not created'))
    path = store.private_path('local', 'places', create=False)
    before = path.read_bytes()
    assert b'Private folder' not in before and b'Not created' not in before
    duplicate = client.post(URL, json={'name': 'Other name', 'kind': 'folder', 'target': str(tmp_path / 'Not created')}).json()
    assert duplicate['created'] is False and duplicate['place'] == original
    assert path.read_bytes() == before
    assert places.listing('test-user')['places'] == []
    assert places.listing('local')['places'] == [original]
    assert not (tmp_path / 'Not created').exists()


def test_rename_and_removal_conflicts_preserve_target(client, tmp_path):
    folder = tmp_path / 'Keep me'; folder.mkdir(); (folder / 'file.txt').write_text('keep')
    saved = save(client, kind='folder', target=str(folder))
    changed = client.patch(URL + '/' + saved['id'], json={'name': 'Renamed favorite', 'expected_revision': saved['revision']})
    assert changed.status_code == 200
    row = changed.json()['place']; assert row['revision'] != saved['revision']
    before = store.private_path('local', 'places').read_bytes()
    assert client.delete(URL + '/' + row['id'], params={'expected_revision': saved['revision']}).status_code == 409
    assert client.patch(URL + '/' + row['id'], json={'name': 'Old edit', 'expected_revision': saved['revision']}).status_code == 409
    assert store.private_path('local', 'places').read_bytes() == before
    assert client.delete(URL + '/' + row['id'], params={'expected_revision': row['revision']}).status_code == 200
    assert (folder / 'file.txt').read_text() == 'keep'


def test_missing_drive_is_retained_then_reconnects(client, tmp_path):
    folder = tmp_path / 'Removable'
    saved = save(client, kind='folder', target=str(folder))
    before = store.private_path('local', 'places').read_bytes()
    url = URL + '/' + saved['id'] + '/check'
    assert client.post(url).json()['status'] == 'unavailable'
    assert store.private_path('local', 'places').read_bytes() == before
    folder.mkdir()
    assert client.post(url).json()['status'] == 'available'
    assert store.private_path('local', 'places').read_bytes() == before


def test_note_ownership_current_revision_and_deleted_note(client):
    note = memory.save_fact('local', 'Remember paper size', title='Printer')
    other = memory.save_fact('test-user', 'Other private note', title='Private')
    assert client.post(URL, json={'name': 'Not mine', 'kind': 'note', 'target': other['id']}).status_code == 404
    saved = save(client, name='Printer', kind='note', target=note['id'])
    check_url = URL + '/' + saved['id'] + '/check'
    assert client.post(check_url).json()['note'] == {'id': note['id'], 'revision': note['revision']}
    changed = client.patch('/api/intelligence/memory/' + note['id'], json={'text': 'New paper size', 'expected_revision': note['revision']}).json()
    assert client.post(check_url).json()['note']['revision'] == changed['revision']
    assert client.delete('/api/intelligence/memory/' + note['id'], params={'expected_revision': changed['revision']}).status_code == 200
    assert client.post(check_url).json()['status'] == 'unavailable'
    assert len(places.listing('local')['places']) == 1


def test_owned_legacy_note_can_be_favorited_without_migrating_original(client):
    path = Path(S.memory_path_for_user('local'))
    original = json.dumps({'facts': ['Paper is in the drawer']}).encode()
    path.write_bytes(original)
    note = memory.list_facts('local')[0]
    assert note['id'] == 'legacy-0'
    saved = save(client, name='Earlier note', kind='note', target=note['id'])
    result = client.post(URL + '/' + saved['id'] + '/check').json()
    assert result['note']['id'] == note['id']
    assert path.read_bytes() == original


@pytest.mark.parametrize('kind,target', [('folder', '../relative'), ('folder', '\\\\server\\share'), ('folder', 'https://example.com'), ('panel', 'delete-all'), ('note', 'device-legacy'), ('folder', 'C:\\bad\x00path')])
def test_invalid_target_rejected_without_side_effects(client, kind, target):
    assert client.post(URL, json={'name': 'Invalid', 'kind': kind, 'target': target}).status_code == 422
    assert not store.private_path('local', 'places', create=False).exists()


@pytest.mark.parametrize('raw', [b'broken', b'[]', b'{"_tli_enc":1,"data":"bad"}'])
def test_corrupt_store_preserved(client, raw):
    path = store.private_path('local', 'places'); path.write_bytes(raw)
    assert client.get(URL).status_code == 503
    assert client.post(URL, json={'name': 'New', 'kind': 'panel', 'target': 'panel-main'}).status_code == 503
    assert path.read_bytes() == raw


def test_future_schema_preserved(client):
    store.write_private('local', 'places', {'version': 2, 'places': []})
    path = store.private_path('local', 'places'); before = path.read_bytes()
    assert client.get(URL).status_code == 503
    assert path.read_bytes() == before


def test_auth_and_extra_fields(client, monkeypatch):
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True, 'pin': 'fake'})
    assert client.get(URL).status_code == 401
    assert client.post(URL, json={'name': 'New', 'kind': 'panel', 'target': 'panel-main'}).status_code == 401
    assert client.post(URL + '/missing/check').status_code == 401


def test_bound_checks_do_not_spawn_unlimited_blocked_threads(monkeypatch):
    release = threading.Event(); slots = threading.BoundedSemaphore(2); entered = []
    def blocked(_):
        entered.append(1); release.wait(2); return 'available', 'Test folder'
    monkeypatch.setattr(places, '_probe_slots', slots)
    monkeypatch.setattr(places, 'CHECK_SECONDS', .01)
    monkeypatch.setattr(places, '_probe', blocked)
    try:
        assert places._bounded_probe('first')[0] == 'unknown'
        assert places._bounded_probe('second')[0] == 'unknown'
        assert 'pending' in places._bounded_probe('third')[1]
        assert len(entered) == 2
    finally:
        release.set()


def test_limit_and_schema_validation(client, monkeypatch):
    monkeypatch.setattr(places, 'MAX_PLACES', 1)
    save(client)
    assert client.post(URL, json={'name': 'Chat', 'kind': 'panel', 'target': 'panel-main'}).status_code == 409
    assert client.post(URL, json={'name': 'Chat', 'kind': 'panel', 'target': 'panel-main', 'execute': True}).status_code == 422
