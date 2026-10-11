"""Disposable LAN inference browser QA; no real nodes, models or user data.

Run with backend/.venv/Scripts/python.exe backend/tests/lan_inference_preview.py,
then open http://127.0.0.1:8788/?desktop=1. The complete application uses a fresh
temporary data directory and inert providers. "simulate failure" interrupts the
synthetic stream; the unavailable sample peer returns a model-check error.
"""
import conftest as isolation  # Establish temporary state BEFORE any app import.
import time
from types import SimpleNamespace

import pytest
import uvicorn
from fastapi import HTTPException

import lan_inference as L
import tli_state as S
from ai import ai_manager
from routers import dashboard_presence as dp, home_power, system_routes


PEER = {"id": "synthetic-gaming-pc", "name": "Sample Gaming PC"}
OFFLINE = {"id": "synthetic-offline-pc", "name": "Sample unavailable PC"}
RESOURCE = {"id": "c" * 64, "revision": "b" * 64, "provider": "bundled",
            "model_id": "synthetic-qwen", "label": "Sample local model (fixture)", "context_window": 32768}


def models(peer_id, *, check=None):
    if check:
        check()
    if peer_id != PEER["id"]:
        raise HTTPException(503, "The sample computer is unavailable. Your current AI choice is unchanged.")
    return {"protocol": L.PROTOCOL, "peer": PEER, "trust_revision": "a" * 64,
            "resources": [RESOURCE], "checked_at": S.now_iso()}


def selection(value):
    if value != {"peer_id": PEER["id"], "trust_revision": "a" * 64,
                 "resource_id": RESOURCE["id"], "resource_revision": RESOURCE["revision"]}:
        raise HTTPException(409, "Check and select the sample model again.")
    return {**value, "peer": PEER}


def stream(selected, messages, *, max_tokens, temperature, check=None):
    if check:
        check()
    yield {"type": "meta", "peer": PEER, "model": RESOURCE["model_id"]}
    answer = ("This is a synthetic LAN reply from the Sample Gaming PC. The primary TLI host retains "
              "this conversation and its context choices. No real computer, model or smart device was contacted. ")
    for sentence in filter(None, answer.split('. ')):
        if check:
            check()
        time.sleep(0.04)
        yield {"type": "delta", "text": sentence + '. '}
    if any('simulate failure' in str(message.get('content', '')).lower() for message in messages if message.get('role') == 'user'):
        raise HTTPException(503, "The sample stream was interrupted. No automatic retry was sent.")
    yield {"type": "done"}


if __name__ == '__main__':
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text('{}')
    cfg = S.NodeConfig(node_id='synthetic-primary-host', node_name='Sample TLI Host',
                       created_at=S.now_iso(), updated_at=S.now_iso())
    patches.setattr(S, 'load_node_config', lambda: cfg)
    patches.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    patches.setattr(S, 'load_shelly_registry', lambda: [])
    patches.setattr(S, 'load_mesh_directory', lambda: {})
    patches.setattr(home_power, 'get_runtime', lambda: SimpleNamespace(load_devices=lambda: [],
        load_scenes=lambda: [], load_automations=lambda: [], read_receipts=lambda **kw: []))
    patches.setattr(dp, '_probe_metrics', lambda: {'cpu_pct': 12, 'ram_pct': 31, 'disk_pct_by_drive': {}})
    patches.setattr(dp, '_score_disk_actions', lambda _: None)
    import psutil
    patches.setattr(psutil, 'cpu_percent', lambda **kw: 12)
    patches.setattr(psutil, 'virtual_memory', lambda: SimpleNamespace(total=16*1024**3, used=5*1024**3, available=11*1024**3, percent=31))
    patches.setattr(psutil, 'disk_partitions', lambda **kw: [])
    mgr = ai_manager.BundledAIManager.get()
    patches.setattr(mgr, 'status', lambda: {'healthy': False, 'running': False, 'model_exists': False,
        'active_preset': 'standard', 'base_url': 'http://127.0.0.1:19998', 'model_name': 'No local fixture model'})
    patches.setattr(L, 'peers', lambda: {'protocol': L.PROTOCOL, 'peers': [PEER, OFFLINE]})
    patches.setattr(L, 'models', models)
    patches.setattr(L, 'selection', selection)
    patches.setattr(L, 'stream', stream)
    print(f'Disposable LAN inference preview: {isolation.TEST_ROOT}', flush=True)
    uvicorn.run(isolation._main.app, host='127.0.0.1', port=8788, log_level='warning')
