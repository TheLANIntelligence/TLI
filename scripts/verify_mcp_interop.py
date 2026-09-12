"""Opt-in SDK 2.x interoperability against an owned synthetic loopback server.

Run with the ordinary source Python and --sdk-python pointing to an isolated
environment containing mcp==2.2.0. Never imports main or touches a live TLI host.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT=Path(__file__).resolve().parents[1]

async def sdk_client():
    from mcp import Client
    from mcp.client.streamable_http import streamable_http_client
    import httpx2
    supplied=json.loads(sys.stdin.read(8192))
    assert supplied['url'].startswith('http://127.0.0.1:')
    async with httpx2.AsyncClient(headers={'Authorization':'Bearer '+supplied['credential']},timeout=10) as http:
        async with Client(streamable_http_client(supplied['url'],http_client=http),read_timeout_seconds=10) as client:
            protocol=client.protocol_version
            assert protocol=='2026-07-28',protocol
            listed=await client.list_tools()
            assert {t.name for t in listed.tools}=={'tli_reported_health','tli_registered_devices'}
            read=await client.call_tool('tli_reported_health',{})
            data=read.model_dump(by_alias=True)
            assert data['isError'] is False and data['structuredContent']['actions_performed'] is False
            assert data['structuredContent']['data']['fixture'] is True
            devices=(await client.call_tool('tli_registered_devices',{'offset':0,'limit':1})).model_dump(by_alias=True)
            assert len(devices['structuredContent']['data']['items'])==1
    print(json.dumps({'ok':True,'sdk_version':importlib.metadata.version('mcp'),'protocol':protocol,
                      'checks':['SDK modern discovery','Scoped tool list','Structured health result','Paginated registry read'],
                      'dependencies':sorted(f'{d.metadata["Name"]}=={d.version}' for d in importlib.metadata.distributions())}))

def run(args):
    if getattr(sys,'frozen',False): raise RuntimeError('Use a source Python environment for the synthetic verifier.')
    output=Path(args.output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='tli-mcp-interop-') as scratch:
        os.environ['TLI_ROOT']=scratch
        sys.path.insert(0,str(ROOT/'backend'))
        import tli_state as S
        import mcp_bridge as B
        import companion_auth as A
        from routers.mcp_routes import router
        from fastapi import FastAPI
        import uvicorn
        import httpx
        # These are synthetic saved projections. Real grant/auth/wire code is used.
        S.load_pin_config=lambda:{'enabled':True}
        B._health=lambda:{'fixture':True,'status':'unknown','cpu':None,'observed_at':None}
        B._registry=lambda:([{'id':'fixture-computer','name':'Synthetic host','source':'fixture'}],[])
        app=FastAPI();app.include_router(router);app.middleware('http')(A.validate_authorization)
        requests=[]
        @app.middleware('http')
        async def observed(request,call_next):
            requests.append((request.method,request.url.path,request.headers.get('mcp-method')))
            return await call_next(request)
        sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(16)
        origin=f'http://127.0.0.1:{sock.getsockname()[1]}'
        server=uvicorn.Server(uvicorn.Config(app,log_level='error',access_log=False,lifespan='off',proxy_headers=False))
        thread=threading.Thread(target=server.run,kwargs={'sockets':[sock]},daemon=True);thread.start()
        deadline=time.monotonic()+10
        while not server.started:
            if not thread.is_alive() or time.monotonic()>deadline: raise RuntimeError('Synthetic server did not start.')
            time.sleep(.01)
        try:
            token=S.create_session_token('synthetic-owner')
            with httpx.Client(base_url=origin,cookies={'tli_session':token},timeout=10) as http:
                receipt=http.post('/api/integrations/mcp/grant',json={'scopes':['registry','health'],'reviewed':True})
                receipt.raise_for_status();grant=receipt.json()
                before={str(p.relative_to(scratch)):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(scratch).rglob('*') if p.is_file()}
                env={k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','PATH','TEMP','TMP','LANG','LC_ALL'}}
                proc=subprocess.run([str(Path(args.sdk_python).resolve()),'-I',str(Path(__file__).resolve()),'--sdk-child'],
                    input=json.dumps({'url':origin+B.ENDPOINT,'credential':grant['credential']}),capture_output=True,text=True,encoding='utf-8',timeout=40,env=env)
                if proc.returncode: raise RuntimeError('SDK interoperability failed: '+proc.stderr[-6000:])
                result=json.loads(proc.stdout)
                assert result['sdk_version']=='2.2.0',result['sdk_version']
                assert http.post('/api/integrations/mcp/revoke',json={'id':grant['id']}).json()['revoked'] is True
                assert http.post('/api/mcp',headers={'Authorization':'Bearer '+grant['credential']}).status_code==401
                after={str(p.relative_to(scratch)):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(scratch).rglob('*') if p.is_file()}
                assert before==after,'A read changed synthetic persistence.'
                assert not any(method in {'initialize','notifications/initialized'} for _,_,method in requests)
                result.update({'synthetic':True,'source_unchanged':True,'live_host_used':False,'requests':requests,
                    'source_files':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['backend/mcp_bridge.py','backend/routers/mcp_routes.py','backend/companion_auth.py','scripts/verify_mcp_interop.py']}})
                output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
                print(json.dumps({'ok':True,'report':str(output),'checks':len(result['checks'])+3}))
        finally:
            server.should_exit=True;thread.join(10);sock.close()
            if thread.is_alive(): raise RuntimeError('Owned synthetic server did not stop.')

if __name__=='__main__':
    if '--sdk-child' in sys.argv: asyncio.run(sdk_client())
    else:
        parser=argparse.ArgumentParser();parser.add_argument('--sdk-python',required=True);parser.add_argument('--output',required=True)
        run(parser.parse_args())
