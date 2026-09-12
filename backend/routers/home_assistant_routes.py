"""PIN-browser-only routes for explicit session-scoped Home Assistant access."""
import asyncio
import json
from fastapi import APIRouter,Request,HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
import home_assistant_bridge as H
router=APIRouter(prefix='/api/integrations/home-assistant',tags=['Optional Home Assistant bridge'])
FIELDS={'connection-review':{'origin','allow_insecure_http'},'connect':{'review_token','token'},'disconnect':{'connection_id'},'states':{'connection_id'},'action-review':{'connection_id','entity_id','action'},'execute':{'connection_id','review_token','review_hash','request_id','reviewed'}}
def reply(value):return JSONResponse(value,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
@router.get('/status')
def status(request:Request):return reply(H.status(request))
async def read_body(request):
    if request.headers.get('content-type','').split(';')[0].strip().lower()!='application/json':raise HTTPException(415,'Use application/json.')
    raw=bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(raw)+len(chunk)>8192:raise HTTPException(413,'This Home Assistant request exceeds 8 KiB.')
                raw.extend(chunk)
        return H._json(raw)
    except TimeoutError:raise HTTPException(408,'The Home Assistant request body timed out.') from None
    except (ValueError,RecursionError):raise HTTPException(400,'Use valid JSON without duplicate fields.') from None
    finally:raw.clear()
@router.post('/{operation}')
async def operation(operation:str,request:Request):
    H.browser(request)
    if operation not in FIELDS:raise HTTPException(404,'Unknown Home Assistant operation.')
    data=await read_body(request)
    if not isinstance(data,dict) or set(data)!=FIELDS[operation]:raise HTTPException(422,'Supply only the fields for this explicit Home Assistant operation.')
    if any(type(value) is not bool if key in ('allow_insecure_http','reviewed') else not isinstance(value,str) for key,value in data.items()):
        raise HTTPException(422,'Home Assistant identifiers, token and origin must be text; review choices must be booleans.')
    return reply(await run_in_threadpool(getattr(H,operation.replace('-','_')),request,data))
