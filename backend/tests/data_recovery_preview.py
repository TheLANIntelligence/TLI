"""Disposable Data & Recovery UI fixture; no live data, providers or actions.

Run with --case unavailable to damage only a temporary sample key, or
--case fail-refresh to fail checks after the first successful response.
"""
import conftest as isolation  # persistence and integration isolation before app imports
import argparse
from pathlib import Path
from types import SimpleNamespace

import pytest
import uvicorn
from fastapi import HTTPException
import tli_state as S
from intelligence import data_health
from intelligence.store import write_private
from routers import home_power, system_routes, dashboard_presence


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['readable', 'unavailable', 'fail-refresh'], default='readable')
    options = parser.parse_args()
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text('{}')
    cfg = S.NodeConfig(node_id='data-preview-host', node_name='Sample Studio', created_at=S.now_iso(), updated_at=S.now_iso())
    S.NODE_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    S.NODE_CONFIG_PATH.write_text(cfg.model_dump_json(), encoding='utf-8')
    patches.setattr(S, 'load_node_config', lambda: cfg)
    patches.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    patches.setattr(S, 'load_shelly_registry', lambda: [])
    patches.setattr(S, 'load_mesh_directory', lambda: {})
    patches.setattr(home_power, 'get_runtime', lambda: SimpleNamespace(load_devices=lambda: [], load_scenes=lambda: [], load_automations=lambda: [], read_receipts=lambda **kw: []))
    patches.setattr(dashboard_presence, '_probe_metrics', lambda: {'cpu_pct': None, 'ram_pct': None, 'disk_pct_by_drive': {}})
    patches.setattr(dashboard_presence, '_score_disk_actions', lambda _: None)
    import psutil
    patches.setattr(psutil, 'cpu_percent', lambda **kw: 12)
    patches.setattr(psutil, 'virtual_memory', lambda: SimpleNamespace(total=16*1024**3, used=5*1024**3, available=11*1024**3, percent=31))
    patches.setattr(psutil, 'disk_partitions', lambda **kw: [])
    patches.setattr(psutil, 'disk_usage', lambda *args: SimpleNamespace(total=100*1024**3, used=40*1024**3, free=60*1024**3, percent=40))
    S.save_memory('local', {'facts': [{'id': 'sample-note', 'text': 'Disposable sample note', 'category': 'general'}]})
    S.save_conversations({'sample-chat': {'id': 'sample-chat', 'user_id': 'local', 'title': 'Sample chat', 'messages': []}})
    write_private('local', 'diagnostics', [{'id': 'sample-report', 'kind': 'system', 'checks': []}])
    if options.case == 'unavailable':
        (Path(S.DATA_DIR) / 'memory_key.bin').write_bytes(b'simulated-unreadable-key')
    elif options.case == 'fail-refresh':
        inspect = data_health.inspect
        calls = 0
        def sample_check(owner):
            global calls
            calls += 1
            if calls > 1:
                raise HTTPException(503, 'Simulated check interruption. No files were changed.')
            return inspect(owner)
        patches.setattr(data_health, 'inspect', sample_check)
    print(f'Disposable data-recovery preview: {isolation.TEST_ROOT} ({options.case})', flush=True)
    uvicorn.run(isolation._main.app, host='127.0.0.1', port=8772, log_level='warning')
