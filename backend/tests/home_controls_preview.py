"""Disposable home-controls UI; every device read and action is a fake."""
import conftest as isolation
import pytest
import uvicorn
import psutil
import license
from pathlib import Path
from fastapi.responses import HTMLResponse, Response
from types import SimpleNamespace
import tli_state as S
from routers import home_power, shelly_routes, system_routes, dashboard_presence as dp


if __name__ == '__main__':
    patches = pytest.MonkeyPatch()
    isolation.isolated_background_services.__wrapped__(patches)
    system_routes._ONBOARDING_COMPLETE_FILE.write_text('{}')
    license.has_feature = lambda *args: True
    rows = [{'ip':'192.0.2.10', 'relay':0, 'name':'Desk left', 'id':'left', 'aliases':['reading lamp']},
            {'ip':'192.0.2.10', 'relay':1, 'name':'Desk right', 'id':'right'},
            {'ip':'192.0.2.20', 'relay':0, 'name':'A device with a long name and an unavailable status reading', 'id':'unavailable'}]
    S.save_shelly_registry(rows)
    states = {0:False, 1:True}
    def status(ip, relay):
        if ip.endswith('.20'):
            raise TimeoutError('Simulated unavailable device')
        return {'raw':{f'switch:{i}':{'output':on,'apower':12 if on else 0} for i,on in states.items()}, 'summary':'Simulated status'}
    def command(action, ip, relay):
        print(f'FAKE DEVICE COMMAND: {ip} relay {relay} action {action}', flush=True)
        if relay == 0:
            return {'raw':{'error':'simulated rejection'},'summary':'Simulated device rejection'}
        before = states[relay]
        states[relay] = not before if action == 'toggle' else action == 'on'
        return {'raw':{'was_on':before}, 'summary':'Simulated acknowledgement'}
    driver = SimpleNamespace(get_status=status, turn_on=lambda **kw:command('on',**kw),
                             turn_off=lambda **kw:command('off',**kw), toggle=lambda **kw:command('toggle',**kw))
    S.shelly_driver = driver
    shelly_routes.shelly_device_info_cached = lambda ip: {'ok':True,'model':'Simulated two-relay device'}
    hp_rows = [{**d,'device_id':d['id'],'vendor':'shelly','capabilities':['switch.on','switch.off','switch.toggle']} for d in rows]
    home_power.get_runtime = lambda: SimpleNamespace(load_devices=lambda:hp_rows, _driver_registry={}, shelly_driver=driver,
        _find_device=lambda ident:next((d for d in hp_rows if d['id']==ident),None), read_receipts=lambda **kw:[], load_scenes=lambda:[], load_automations=lambda:[])
    psutil.cpu_percent = lambda **kw:15
    psutil.virtual_memory = lambda:SimpleNamespace(total=16*1024**3,used=6*1024**3,available=10*1024**3,percent=37)
    psutil.disk_partitions = lambda **kw:[]
    dp._probe_metrics = lambda:{'cpu_pct':15,'ram_pct':37,'disk_pct_by_drive':{'C:\\':40}}
    dp._score_disk_actions = lambda _:None
    @isolation._main.app.get('/preview/companion', response_class=HTMLResponse)
    def companion_page():
        return (Path(S.FRONTEND_DIR) / 'companion.html').read_text(encoding='utf-8').replace('/js/companion.js', '/preview/companion.js')
    @isolation._main.app.get('/preview/companion.js')
    def companion_script():
        source = (Path(S.FRONTEND_DIR) / 'js/companion.js').read_text(encoding='utf-8')
        source = source.replace('localStorage.getItem("sat_node_id")', '"preview-node"').replace('localStorage.getItem("sat_secret")', '"preview-secret"')
        source = source.replace('  _beat();', '').replace('  setInterval(_beat, 30_000);', '')
        return Response(source, media_type='application/javascript')
    # The application mounts the frontend at '/', so fixture routes must precede it.
    routes = isolation._main.app.router.routes
    routes[:] = routes[-2:] + routes[:-2]
    print(f'Disposable home controls: {isolation.TEST_ROOT}',flush=True)
    uvicorn.run(isolation._main.app,host='127.0.0.1',port=8767,log_level='warning')
