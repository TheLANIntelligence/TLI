"""PIN-browser management; never authenticated by a delegated MCP credential."""
import asyncio
from fastapi import APIRouter,Request,HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
import mcp_client as M
router=APIRouter(prefix='/api/integrations/mcp-client',tags=['Optional manual MCP client'])
FIELDS={'connection-review':{'endpoint'},'connect':{'review_token','token','reviewed'},'disconnect':{'connection_id'},'list':{'connection_id'},'tool-review':{'connection_id','tool_name','tool_fingerprint','arguments'},'invoke':{'connection_id','review_token','review_hash','request_id','reviewed'}}
def reply(value):return JSONResponse(value,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
@router.get('/status')
def status(request:Request):return reply(M.status(request))
@router.post('/{operation}')
async def operation(operation:str,request:Request):
    M.browser(request)
    if operation not in FIELDS:raise HTTPException(404,'Unknown MCP client operation.')
    if request.headers.get('content-type','').split(';')[0].strip().lower()!='application/json':raise HTTPException(415,'Use application/json.')
    raw=bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(raw)+len(chunk)>24576:raise HTTPException(413,'This MCP client request exceeds 24 KiB.')
                raw.extend(chunk)
        data=M.strict_json(raw)
    except TimeoutError:raise HTTPException(408,'The MCP client request body timed out.') from None
    except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,'Use valid bounded JSON without duplicate fields.') from None
    finally:raw.clear()
    if not isinstance(data,dict) or set(data)!=FIELDS[operation]:raise HTTPException(422,'Supply exactly the fields for this explicit MCP client operation.')
    for key,value in data.items():
        if (key=='reviewed' and type(value) is not bool) or (key=='arguments' and not isinstance(value,dict)) or (key not in ('reviewed','arguments') and (not isinstance(value,str) or len(value)>4096)):raise HTTPException(422,'MCP identifiers and credentials must be bounded text; arguments must be an object and review must be boolean.')
    handler=M.list_tools if operation=='list' else getattr(M,operation.replace('-','_'))
    return reply(await run_in_threadpool(handler,request,data))
