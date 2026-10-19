"""Bundled offers must not promise an absent feature or rewrite installed data."""
import json

import pytest
from fastapi import HTTPException
import tli_state as S
from routers import hub_routes as hub


@pytest.fixture
def existing(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    installed = [{'id': 'app-wol-pad', 'type': 'app', 'name': 'My existing copy', 'custom': 'keep'}]
    registry = {'version': '1', 'packages': [{'id': 'app-wol-pad', 'type': 'app', 'name': 'My own package'}]}
    files = {tmp_path / 'hub_installed.json': installed, tmp_path / 'hub_local_registry.json': registry}
    for path, value in files.items():
        path.write_text(json.dumps(value, indent=3), encoding='utf-8')
    before = {path: path.read_bytes() for path in files}
    monkeypatch.setattr(hub, '_pkg_dir', lambda: pytest.fail('Read-only catalogue checks must not write packages'))
    return installed, registry, before


def test_both_sample_views_retire_dead_offer_without_touching_installed_copy(existing):
    installed, _, before = existing
    for result in [hub.hub_sample_registry(check=lambda: None), hub.hub_registry(sample=True, check=lambda: None)]:
        assert result['packages']
        assert 'app-wol-pad' not in {row['id'] for row in result['packages']}
        assert all('/mesh/wol' not in row.get('inline_html', '') for row in result['packages'])
    assert hub.hub_installed(check=lambda: None)['installed'] == installed
    assert all(path.read_bytes() == data for path, data in before.items())


def test_retired_bundled_install_refuses_before_any_package_write(existing, monkeypatch):
    _, _, before = existing
    monkeypatch.setattr(hub, '_fetch_registry', lambda *_: pytest.fail('A sample request must not use a remote registry'))
    with pytest.raises(HTTPException) as error:
        hub.hub_install(hub.InstallRequest(package_id='app-wol-pad', use_sample=True), check=lambda: None)
    assert error.value.status_code == 404
    assert all(path.read_bytes() == data for path, data in before.items())


def test_user_registry_with_same_id_remains_available(existing, monkeypatch):
    _, registry, before = existing
    monkeypatch.setattr(hub, '_load_settings', lambda *_: {'enabled': True, 'hub_url': 'https://registry.example.test'})
    monkeypatch.setattr(hub, '_fetch_registry', lambda *_: registry)
    assert hub.hub_registry(check=lambda: None)['packages'][0]['id'] == 'app-wol-pad'
    assert hub._load_local_registry() == registry
    assert all(path.read_bytes() == data for path, data in before.items())
