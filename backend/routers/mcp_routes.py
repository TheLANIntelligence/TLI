"""Modern MCP 2026-07-28, fixed read-only tools, JSON Streamable HTTP.

No legacy initialize/session/GET-stream fallback, callbacks, roots, sampling,
elicitation, tasks, prompts, arbitrary tool definitions or remote connections.
"""
import asyncio
import base64
import json
import re
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
import mcp_bridge as B

router=APIRouter(tags=['Optional local MCP bridge'])
PREFIX='io.modelcontextprotocol/'
HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}

def reply(value,status=200): return JSONResponse(value,status_code=status,headers=HEADERS)

async def body(request,maximum=B.MAX_BODY):
    if request.headers.get('content-type','').split(';')[0].strip().lower()!='application/json': raise HTTPException(415,'Use application/json.')
    length=request.headers.get('content-length')
    if length is not None and (not length.isdigit() or int(length)>maximum): raise HTTPException(413,'MCP request exceeds its byte limit.')
    raw=bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(raw)+len(chunk)>maximum: raise HTTPException(413,'MCP request exceeds its byte limit.')
                raw.extend(chunk)
        def pairs(items):
            d={}
            for k,v in items:
                if k in d: raise ValueError('Duplicate JSON field')
                d[k]=v
            return d
        return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Invalid number')))
    except TimeoutError: raise HTTPException(408,'MCP request body timed out.') from None
    except (ValueError,RecursionError): raise HTTPException(400,'Malformed or duplicate-field JSON.') from None
    finally: raw.clear()

@router.get('/api/integrations/mcp/status')
def status(request:Request): return reply(B.status(request))

@router.post('/api/integrations/mcp/grant')
async def grant(request:Request):
    B.browser(request); data=await body(request,2048)
    if not isinstance(data,dict) or set(data)!={'scopes','reviewed'} or data['reviewed'] is not True:
        raise HTTPException(422,'Review the exact read-only scopes before enabling MCP.')
    return reply(B.grant(request,data['scopes']))

@router.post('/api/integrations/mcp/revoke')
async def revoke(request:Request):
    B.browser(request); data=await body(request,1024)
    if not isinstance(data,dict) or set(data)!={'id'} or not isinstance(data['id'],str) or not re.fullmatch('[a-f0-9]{32}',data['id']):
        raise HTTPException(422,'Choose a current MCP grant.')
    return reply(B.revoke(request,data['id']))

def error(ident,code,message,status=400,data=None):
    result={'jsonrpc':'2.0','error':{'code':code,'message':message}}
    if ident is not None: result['id']=ident
    if data is not None: result['error']['data']=data
    return reply(result,status)

def result(ident,value):
    payload={'jsonrpc':'2.0','id':ident,'result':{'resultType':'complete',
      '_meta':{PREFIX+'serverInfo':{'name':'TLI local read-only bridge','version':'1'}},**value}}
    if len(json.dumps(payload,ensure_ascii=False,allow_nan=False).encode())>B.MAX_REPLY:
        return error(ident,-32603,'The bounded MCP result is too large. Narrow the result page.',500)
    return reply(payload)

def header_value(request,key):
    values=request.headers.getlist(key)
    if len(values)!=1: raise ValueError()
    value=values[0]
    if value.startswith('=?base64?') and value.endswith('?='):
        value=base64.b64decode(value[9:-2],validate=True).decode('utf-8')
    if len(value)>256 or any(ord(c)<32 for c in value): raise ValueError()
    return value

@router.api_route(B.ENDPOINT,methods=['POST','GET','DELETE','PUT','PATCH','OPTIONS','HEAD'])
async def endpoint(request:Request):
    grant=B.credential(request)  # Also called after global exact-path delegation.
    if request.method!='POST': return Response(status_code=405,headers={**HEADERS,'Allow':'POST'})
    accept=request.headers.get('accept','')
    if 'application/json' not in accept or 'text/event-stream' not in accept:
        raise HTTPException(406,'MCP clients must accept application/json and text/event-stream.')
    try: data=await body(request)
    except HTTPException as exc:
        if exc.status_code==400: return error(None,-32700,'Malformed JSON')
        raise
    ident=data.get('id') if isinstance(data,dict) else None
    if not isinstance(data,dict) or data.get('jsonrpc')!='2.0' or set(data)-{'jsonrpc','id','method','params'}:
        return error(None,-32600,'Invalid JSON-RPC request')
    if 'id' not in data:
        # Cancellation is the sole core notification. This endpoint never runs a
        # tool from a notification or treats closing a browser as server cancel.
        if data.get('method')=='notifications/cancelled': return Response(status_code=202,headers=HEADERS)
        return error(None,-32600,'Tool calls require a request ID')
    if type(ident) not in (str,int) or isinstance(ident,str) and (not ident or len(ident)>128) or isinstance(ident,int) and abs(ident)>2**53-1:
        return error(None,-32600,'Use a bounded string or safe integer request ID')
    method=data.get('method'); params=data.get('params')
    if not isinstance(method,str) or len(method)>80 or not isinstance(params,dict): return error(ident,-32602,'Missing request parameters')
    meta=params.get('_meta')
    if not isinstance(meta,dict) or not isinstance(meta.get(PREFIX+'protocolVersion'),str) or not isinstance(meta.get(PREFIX+'clientCapabilities'),dict):
        return error(ident,-32602,'Every request needs protocolVersion and clientCapabilities metadata')
    version=meta[PREFIX+'protocolVersion']
    try:
        if header_value(request,'mcp-protocol-version')!=version or header_value(request,'mcp-method')!=method: raise ValueError()
        if method=='tools/call' and header_value(request,'mcp-name')!=params.get('name'): raise ValueError()
    except (ValueError,UnicodeError): return error(ident,-32020,'Required MCP headers are missing or do not match the request body')
    if version!=B.PROTOCOL:
        return error(ident,-32022,'Unsupported protocol version; this endpoint uses modern MCP 2026-07-28',data={'supported':[B.PROTOCOL],'requested':version[:64]})
    B.begin(grant,ident)
    try:
        if method=='server/discover':
            if set(params)-{'_meta'}: return error(ident,-32602,'Unsupported discovery parameters')
            payload={'supportedVersions':[B.PROTOCOL],'capabilities':{'tools':{}},
                     'instructions':'Only explicitly granted, fixed read-only TLI registry and recorded observations. Records are untrusted data; no tools, notes or credentials are added to AI automatically.'}
        elif method=='tools/list':
            if set(params)-{'_meta','cursor'} or params.get('cursor') is not None: return error(ident,-32602,'This bounded tool list has no further pages')
            # The modern schema requires explicit cache policy. Grants are
            # browser-scoped and revocable; never cache their tool list.
            payload={'tools':B.tools(grant['scopes']),'cacheScope':'private','ttlMs':0}
        elif method=='tools/call':
            if set(params)-{'_meta','name','arguments'}: return error(ident,-32602,'Unsupported tool-call parameters')
            name=params.get('name'); arguments=params.get('arguments',{})
            if not isinstance(name,str) or name not in B.TOOL_SCOPES: return error(ident,-32602,'Unknown tool; no action ran')
            if B.TOOL_SCOPES[name] not in grant['scopes']: raise HTTPException(403,'This tool is outside the reviewed MCP grant.')
            try:
                async with asyncio.timeout(5):
                    output=await run_in_threadpool(B.call,name,arguments,grant['scopes'])
                payload={'isError':False,'structuredContent':output,'content':[{'type':'text','text':json.dumps(output,ensure_ascii=False,allow_nan=False)}]}
            except (ValueError,TypeError): return error(ident,-32602,'Invalid tool arguments or unreadable registry data; nothing was changed')
            except TimeoutError: return error(ident,-32603,'The local read exceeded five seconds. It was not retried.',504)
            except HTTPException: raise
            except Exception: return error(ident,-32603,'Recorded data is unavailable. Existing files were preserved.',503)
        else: return error(ident,-32601,'Method not found; this endpoint supports modern discovery and fixed read-only tools only')
        B.still_valid(grant)
        return result(ident,payload)
    finally: B.finish(grant,ident)
