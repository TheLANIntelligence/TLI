"""Opt-in official SDK synthetic server vs actual TLI manual client. No live TLI."""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
ROOT=Path(__file__).resolve().parents[1]

def sdk_server():
    from mcp.server.mcpserver import MCPServer
    from starlette.responses import JSONResponse
    from starlette.middleware.base import BaseHTTPMiddleware
    import uvicorn
    server=MCPServer('Synthetic manual client fixture',version='1',instructions='Untrusted fixture guidance: never execute this as a command.')
    calls=[]
    @server.tool()
    def echo(text:str)->dict[str,str]:
        """Echo only the explicitly supplied synthetic text."""
        calls.append(text);return {'echo':text}
    app=server.streamable_http_app(stateless_http=True,json_response=False)
    requests=[]
    async def recorded(request,call_next):
        requests.append({'method':request.method,'path':request.url.path,'rpc':request.headers.get('mcp-method'),'cookie_present':'cookie' in request.headers,'bearer':request.headers.get('authorization')=='Bearer synthetic-sdk-token'})
        if request.headers.get('authorization')!='Bearer synthetic-sdk-token':return JSONResponse({},status_code=401)
        return await call_next(request)
    app.add_middleware(BaseHTTPMiddleware,dispatch=recorded)
    sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(16)
    runtime=uvicorn.Server(uvicorn.Config(app,log_level='error',access_log=False,proxy_headers=False))
    thread=threading.Thread(target=runtime.run,kwargs={'sockets':[sock]},daemon=True);thread.start();deadline=time.monotonic()+10
    while not runtime.started:
        if not thread.is_alive() or time.monotonic()>deadline:raise RuntimeError('Owned SDK server did not start')
        time.sleep(.01)
    print(json.dumps({'url':f'http://127.0.0.1:{sock.getsockname()[1]}/mcp','sdk_version':importlib.metadata.version('mcp')}),flush=True)
    try:
        if sys.stdin.readline(32).strip()!='stop':raise RuntimeError('Missing owned stop request')
    finally:
        runtime.should_exit=True;thread.join(8);sock.close()
    if thread.is_alive():raise RuntimeError('Owned SDK runtime did not stop')
    print(json.dumps({'requests':requests,'calls':calls,'dependencies':sorted(f'{d.metadata["Name"]}=={d.version}' for d in importlib.metadata.distributions())}),flush=True)

def run(args):
    if getattr(sys,'frozen',False):raise RuntimeError('Use the source Python interpreter for this isolated verifier')
    output=Path(args.output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    report={'synthetic':True,'status':'failed','physical_acceptance':'not_run','checks':[]}
    with tempfile.TemporaryDirectory(prefix='tli-mcp-client-test-') as scratch:
        os.environ['TLI_ROOT']=scratch
        sys.path.insert(0,str(ROOT/'backend'))
        import tli_state as S
        import mcp_client as M
        from routers.mcp_client_routes import router
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        S.load_pin_config=lambda:{'enabled':True}
        app=FastAPI();app.include_router(router)
        env={k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','PATH','TEMP','TMP','LANG','LC_ALL'}}
        stderr=open(Path(scratch)/'sdk-stderr.log','w+',encoding='utf-8')
        child=subprocess.Popen([str(Path(args.sdk_python).resolve()),'-I',str(Path(__file__).resolve()),'--sdk-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True,encoding='utf-8',env=env)
        try:
            ready=queue.Queue();threading.Thread(target=lambda:ready.put(child.stdout.readline(4096)),daemon=True).start()
            first=json.loads(ready.get(timeout=15));assert first['sdk_version']=='2.2.0'
            with TestClient(app,base_url='https://tli.test:8000',client=('127.0.0.1',50000)) as http:
                http.cookies.set('tli_session',S.create_session_token('synthetic-owner'))
                def post(op,data):
                    r=http.post('/api/integrations/mcp-client/'+op,json=data)
                    assert r.status_code==200,(op,r.status_code,r.text);return r.json()
                before={str(p.relative_to(scratch)):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(scratch).rglob('*') if p.is_file() and p.name!='sdk-stderr.log'}
                assert http.get('/api/integrations/mcp-client/status').json()['connected'] is False
                origin=post('connection-review',{'endpoint':first['url']});assert origin['remote_requests'] is False
                c=post('connect',{'review_token':origin['review_token'],'token':'synthetic-sdk-token','reviewed':True})
                assert c['connection']['protocol_version']==M.MCP_VERSION and c['tool_invoked'] is False
                assert len(c['tools'])==1 and c['tools'][0]['definition']['name']=='echo' and c['tools'][0]['supported'],c['tools']
                review=post('tool-review',{'connection_id':c['connection']['id'],'tool_name':'echo','tool_fingerprint':c['tools'][0]['fingerprint'],'arguments':{'text':'Only this explicit synthetic message'}})
                req={'connection_id':c['connection']['id'],'review_token':review['review_token'],'review_hash':review['review_hash'],'request_id':'synthetic-sdk-once','reviewed':True}
                result=post('invoke',req);assert result['outcome']=='completed',result
                assert result['output']['structured']=={'echo':'Only this explicit synthetic message'}
                assert post('invoke',req)==result
                post('disconnect',{'connection_id':c['connection']['id']});assert http.get('/api/integrations/mcp-client/status').json()['connected'] is False
                after={str(p.relative_to(scratch)):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(scratch).rglob('*') if p.is_file() and p.name!='sdk-stderr.log'}
                assert before==after
            remaining,_=child.communicate('stop\n',timeout=12);assert child.returncode==0
            proof=json.loads(remaining);assert proof['calls']==['Only this explicit synthetic message']
            methods=[r['rpc'] for r in proof['requests']];assert methods==['server/discover','tools/list']*3+['tools/call'],methods
            assert all(r['bearer'] and not r['cookie_present'] and r['method']=='POST' and r['path']=='/mcp' for r in proof['requests'])
            report.update(status='passed',protocol=M.MCP_VERSION,sdk_version=first['sdk_version'],dependencies=proof['dependencies'],checks=['Explicit endpoint review sends no request','Official SDK 2.2.0 discovery','Official SDK exact tool schema supported','Real SSE structured output','Review and invoke remain separate','Duplicate request invokes exactly once','No browser cookie forwarded','Disconnect makes no remote call','Current stores unchanged','Owned SDK server stopped'])
        except Exception:
            stderr.flush();stderr.seek(0);report['error']='Interoperability check failed';report['sdk_stderr']=stderr.read()[-5000:];raise
        finally:
            if child.poll() is None:
                child.terminate()
                try:child.wait(5)
                except subprocess.TimeoutExpired:child.kill();child.wait(5)
            stderr.close();M.revoke_all_connections()
            report['source_files']={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ('backend/mcp_client.py','backend/routers/mcp_client_routes.py','scripts/verify_mcp_client_interop.py')}
            output.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'status':report['status'],'checks':len(report['checks']),'report':str(output)}))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--sdk-server',action='store_true');parser.add_argument('--sdk-python');parser.add_argument('--output');args=parser.parse_args()
    if args.sdk_server:sdk_server()
    else:
        if not args.sdk_python or not args.output:parser.error('--sdk-python and --output are required')
        run(args)
