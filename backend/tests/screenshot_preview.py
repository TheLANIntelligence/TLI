"""Disposable screenshot-guidance UI. No real image provider or hardware calls."""
import conftest as isolation
import io
import pytest
import uvicorn
from types import SimpleNamespace
from PIL import Image, ImageDraw
import tli_state as S
from intelligence import chat, models
from routers import system_routes, home_power, dashboard_presence as dp


if __name__ == '__main__':
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text('{}')
    preview_node = S.NodeConfig(node_id='preview-host', node_name='Preview Office',
                               created_at=S.now_iso(), updated_at=S.now_iso())
    patches.setattr(S, 'load_node_config', lambda: preview_node)
    patches.setattr(S, 'load_shelly_registry', lambda: [])
    patches.setattr(S, 'load_mesh_directory', lambda: {'preview-peer': {'node_name': 'Work laptop', 'ip': '192.0.2.10'}})
    patches.setattr(home_power, 'get_runtime', lambda: SimpleNamespace(load_devices=lambda: [],
        load_scenes=lambda: [], load_automations=lambda: [], read_receipts=lambda **kw: []))
    provider = {'provider': 'lmstudio', 'model': 'Fixture vision only', 'url': 'http://127.0.0.1:19999/v1/chat/completions'}
    patches.setattr(models, 'image_provider', lambda: dict(provider))
    def fake_post(url, **kw):
        if url != provider['url']:
            return isolation._no_network()
        payload = kw['json']
        text = payload['messages'][-1]['content'][0]['text']
        print('FAKE IMAGE ANALYSIS: ' + text, flush=True)
        if 'simulate failure' in text.lower():
            raise TimeoutError('Fixture provider failure')
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None, json=lambda: {'choices': [{'message': {'content':
            'The screenshot shows a setup error: "Destination folder unavailable." This does not establish why the folder is unavailable.\n\nChoose **Browse** and inspect an accessible destination folder. Before pressing Next, confirm it is the folder you intended. Share the next screen if you need help continuing.'}}]})
    patches.setattr(chat.requests, 'post', fake_post)
    import psutil
    patches.setattr(psutil, 'cpu_percent', lambda **kw: 15)
    patches.setattr(psutil, 'virtual_memory', lambda: SimpleNamespace(total=16*1024**3, used=6*1024**3, available=10*1024**3, percent=37))
    patches.setattr(psutil, 'disk_partitions', lambda **kw: [])
    patches.setattr(dp, '_probe_metrics', lambda: {'cpu_pct': 15, 'ram_pct': 37, 'disk_pct_by_drive': {}})
    patches.setattr(dp, '_score_disk_actions', lambda _: None)
    screenshot = Image.new('RGB', (1000, 560), '#edf6f4')
    draw = ImageDraw.Draw(screenshot)
    draw.rounded_rectangle((90, 65, 910, 485), 15, fill='white', outline='#708080', width=2)
    draw.text((135, 105), 'Demo setup - screenshot fixture', fill='#102c30', font_size=30)
    draw.text((135, 185), 'Destination folder unavailable.', fill='#b02030', font_size=28)
    draw.text((135, 240), 'Choose a folder to continue.', fill='#102c30', font_size=24)
    for x, label in [(135, 'Browse'), (460, 'Cancel'), (690, 'Next')]:
        draw.rounded_rectangle((x, 355, x+165, 417), 8, fill='#d8ede7', outline='#397566')
        draw.text((x+25, 372), label, fill='#102c30', font_size=23)
    image_bytes = io.BytesIO()
    screenshot.save(image_bytes, 'PNG')
    fixture_path = isolation.TEST_ROOT / 'screenshot-fixture.png'
    fixture_path.write_bytes(image_bytes.getvalue())
    print(f'Disposable screenshot preview: {isolation.TEST_ROOT}', flush=True)
    print(f'Screenshot fixture: {fixture_path}', flush=True)
    uvicorn.run(isolation._main.app, host='127.0.0.1', port=8768, log_level='warning')
