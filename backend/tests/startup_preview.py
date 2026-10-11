"""Disposable secure-startup Settings preview; all writes stay in a test root."""
import conftest as isolation  # isolate persistence/processes before application imports
import argparse
import os
from types import SimpleNamespace

import pytest
import uvicorn
import psutil
import tli_state as S
import startup_config
from routers import system_routes, dashboard_presence, home_power


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['normal', 'save-failure', 'env-override'], default='normal')
    args = parser.parse_args()
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    for name in ('TLI_HOST', 'TLI_PORT', 'TLI_ENABLE_TLS', 'TLI_LAN_MODE', 'TLI_OPEN_BROWSER'):
        patches.delenv(name, raising=False)
    S.save_pin_config(system_routes._hash_pin('2468', 'b' * 64), 'b' * 64)  # preview-only PIN
    cfg = S.load_node_config()
    cfg.node_name = 'Sample Studio'
    S.save_node_config(cfg)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text('{}')
    S.SERVER_BIND_HOST, S.SERVER_BIND_PORT = '127.0.0.1', 8772
    token = S.create_session_token('local')
    @isolation._main.app.middleware('http')
    async def fixture_session(request, call_next):
        response = await call_next(request)
        response.set_cookie('tli_session', token, httponly=True, samesite='strict')
        return response
    patches.setattr(S, 'load_shelly_registry', lambda: [])
    patches.setattr(S, 'load_mesh_directory', lambda: {})
    patches.setattr(home_power, 'get_runtime', lambda: SimpleNamespace(load_devices=lambda: [], load_scenes=lambda: [], load_automations=lambda: [], read_receipts=lambda **kw: []))
    patches.setattr(dashboard_presence, '_probe_metrics', lambda: {'cpu_pct': None, 'ram_pct': None, 'disk_pct_by_drive': {}})
    patches.setattr(dashboard_presence, '_score_disk_actions', lambda _: None)
    patches.setattr(psutil, 'cpu_percent', lambda **kw: 12)
    patches.setattr(psutil, 'virtual_memory', lambda: SimpleNamespace(total=16*1024**3, used=5*1024**3, available=11*1024**3, percent=31))
    patches.setattr(psutil, 'disk_partitions', lambda **kw: [])
    patches.setattr(psutil, 'disk_usage', lambda *a: SimpleNamespace(total=100*1024**3, used=40*1024**3, free=60*1024**3, percent=40))
    if args.case == 'save-failure':
        patches.setattr(startup_config, 'write', lambda *a: (_ for _ in ()).throw(OSError('Simulated save failure')))
    if args.case == 'env-override':
        patches.setenv('TLI_PORT', '9443')
    print(f'Disposable startup preview: {isolation.TEST_ROOT} ({args.case})', flush=True)
    uvicorn.run(isolation._main.app, host='127.0.0.1', port=8772, log_level='warning')
