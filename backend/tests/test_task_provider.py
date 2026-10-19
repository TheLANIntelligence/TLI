"""Transport-level task protocol checks; no real model or network access."""
import json
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

import task_provider as provider
import task_agent
import tli_state as S


@pytest.fixture
def local(monkeypatch):
    monkeypatch.setattr(S, 'lm_provider', SimpleNamespace(chat_url='http://127.0.0.1:1234/v1/chat/completions'))
    return {'kind':'lmstudio','model':'local-model','tool_mode':'json'}


def local_reply(step, finish='stop', model='local-model'):
    return {'model':model,'choices':[{'finish_reason':finish,'message':{'content':json.dumps(step)}}]}


@pytest.mark.parametrize('step', [
    {'kind':'tool','tool':'workspace_read','arguments':{'path':'C:/game/log.txt','start_line':1}},
    {'kind':'final','text':'The checked configuration parses. Game launch remains unverified.','status':'completed'},
])
def test_json_mode_normalizes_exact_step_without_fallback(local, monkeypatch, step):
    send=Mock(return_value=local_reply(step));monkeypatch.setattr(provider,'post_json',send)
    assert provider.complete(local,[{'role':'user','content':'review'}],lambda:None) == step
    assert send.call_count == 1
    payload=send.call_args.args[1]
    assert payload['model']=='local-model'
    assert 'tools' not in payload


@pytest.mark.parametrize('step', [
    {'kind':'tool','tool':'shell','arguments':{'command':'anything'}},
    {'kind':'tool','tool':'workspace_read','arguments':{'path':'x','start_line':True}},
    {'kind':'tool','tool':'workspace_read','arguments':{'path':'x','other':'injected'}},
    {'kind':'tool','tool':'workspace_read','arguments':{}},
    {'kind':'tool','tool':'workspace_write','arguments':{'path':'x','content':'x','create':'true'}},
    {'kind':'tool','tool':'run_command','arguments':{'executable':'C:/python.exe','cwd':'C:/game','args':[{'injected':'argument'}]}},
    {'kind':'final','text':'done','status':'unsupported'},
    {'kind':'final','text':'done','status':'completed','action':{'delete':'x'}},
])
def test_unknown_extra_and_wrong_type_tool_fields_are_rejected(step):
    with pytest.raises(HTTPException) as exc:
        provider.parse_step(step)
    assert exc.value.status_code==502


@pytest.mark.parametrize('finish',['length','content_filter',None])
def test_incomplete_local_generation_never_yields_a_tool(local, monkeypatch, finish):
    send=Mock(return_value=local_reply({'kind':'tool','tool':'workspace_write','arguments':{'path':'x','content':'changed','create':True}},finish))
    monkeypatch.setattr(provider,'post_json',send)
    with pytest.raises(HTTPException):
        provider.complete(local,[{'role':'user','content':'fix'}],lambda:None)
    assert send.call_count==1


def test_native_mode_accepts_one_normalized_function_call(local, monkeypatch):
    local['tool_mode']='native'
    send=Mock(return_value={'model':'local-model','choices':[{'finish_reason':'tool_calls','message':{'tool_calls':[{'type':'function','function':{'name':'workspace_read','arguments':'{"path":"C:/game/config.json"}'}}]}}]})
    monkeypatch.setattr(provider,'post_json',send)
    step=provider.complete(local,[{'role':'user','content':'inspect'}],lambda:None)
    assert step=={'kind':'tool','tool':'workspace_read','arguments':{'path':'C:/game/config.json'}}
    assert send.call_args.args[1]['parallel_tool_calls'] is False
    assert all(item['type']=='function' and 'function' in item for item in send.call_args.args[1]['tools'])


def test_native_multiple_calls_and_json_mode_native_calls_are_rejected(local, monkeypatch):
    call={'type':'function','function':{'name':'sonos_list','arguments':'{}'}}
    send=Mock(return_value={'model':'local-model','choices':[{'finish_reason':'tool_calls','message':{'tool_calls':[call]}}]})
    monkeypatch.setattr(provider,'post_json',send)
    with pytest.raises(HTTPException):
        provider.complete(local,[],lambda:None)
    local['tool_mode']='native';send.return_value['choices'][0]['message']['tool_calls'].append(call)
    with pytest.raises(HTTPException):
        provider.complete(local,[],lambda:None)


@pytest.mark.parametrize('status',['incomplete','failed','in_progress',None])
def test_nonfinal_cloud_status_never_yields_actions(monkeypatch,status):
    monkeypatch.setenv('TLI_OPENAI_API_KEY','test-placeholder')
    send=Mock(return_value={'status':status,'output':[{'type':'function_call','name':'sonos_list','arguments':'{}'}]})
    monkeypatch.setattr(provider,'post_json',send)
    with pytest.raises(HTTPException):
        provider.complete({'kind':'openai','model':'selected-cloud-model'},[],lambda:None)
    assert send.call_count==1


def test_cloud_binds_explicit_model_and_disables_store_and_parallel_calls(monkeypatch):
    monkeypatch.setenv('TLI_OPENAI_API_KEY','test-placeholder')
    send=Mock(return_value={'status':'completed','output':[{'type':'function_call','name':'workspace_read','arguments':'{"path":"C:/game/config"}'}]})
    monkeypatch.setattr(provider,'post_json',send)
    messages=[{'role':'user','content':'User-reviewed task context'}]
    step=provider.complete({'kind':'openai','model':'selected-cloud-model','reasoning':'high'},messages,lambda:None)
    assert step['tool']=='workspace_read'
    assert send.call_args.args[0]=='https://api.openai.com/v1/responses'
    payload=send.call_args.args[1]
    assert payload['model']=='selected-cloud-model'
    assert payload['store'] is False and payload['parallel_tool_calls'] is False
    assert payload['input']==messages


def test_provider_failure_is_single_attempt_without_alternate_transport(local,monkeypatch):
    send=Mock(side_effect=HTTPException(502,'selected provider unavailable'))
    monkeypatch.setattr(provider,'post_json',send)
    with pytest.raises(HTTPException):
        provider.complete(local,[],lambda:None)
    assert send.call_count==1


@pytest.mark.parametrize('url',['http://192.168.1.20:1234/v1/chat/completions','https://remote.example:443/v1/chat/completions','http://user:secret@127.0.0.1:1234/v1/chat/completions'])
def test_local_provider_cannot_silently_send_task_context_to_remote_host(local,monkeypatch,url):
    monkeypatch.setattr(S,'lm_provider',SimpleNamespace(chat_url=url))
    send=Mock();monkeypatch.setattr(provider,'post_json',send)
    with pytest.raises(HTTPException) as exc:
        provider.complete(local,[{'role':'user','content':'private source excerpt'}],lambda:None)
    assert exc.value.status_code==409
    send.assert_not_called()


def test_wrong_local_model_cannot_propose_an_action(local,monkeypatch):
    send=Mock(return_value=local_reply({'kind':'tool','tool':'sonos_list','arguments':{}},model='different-model'))
    monkeypatch.setattr(provider,'post_json',send)
    with pytest.raises(HTTPException) as exc:
        provider.complete(local,[],lambda:None)
    assert exc.value.status_code==502
    assert send.call_count==1


@pytest.mark.parametrize('kind',['openai','lan'])
def test_external_task_context_requires_explicit_share_before_provider(kind,monkeypatch):
    send=Mock();monkeypatch.setattr(provider,'post_json',send)
    with pytest.raises(HTTPException) as exc:
        task_agent.validate_request('owner',{'message':'private task','provider':{'kind':kind},'share_context':False})
    assert exc.value.status_code==409
    send.assert_not_called()


def test_post_json_refuses_redirects_and_does_not_use_environment_proxy(monkeypatch):
    response=Mock(status_code=302)
    client=Mock();client.stream.return_value=nullcontext(response)
    factory=Mock(return_value=nullcontext(client));monkeypatch.setattr(provider.httpx,'Client',factory)
    with pytest.raises(HTTPException):
        provider.post_json('https://api.openai.com/v1/responses',{},lambda:None,key='placeholder')
    assert factory.call_args.kwargs['trust_env'] is False
    assert factory.call_args.kwargs['follow_redirects'] is False
    response.iter_bytes.assert_not_called()


def test_transport_checks_authority_between_response_chunks(monkeypatch):
    check=Mock(side_effect=[None,HTTPException(401,'revoked')])
    response=Mock(status_code=200);response.iter_bytes.return_value=[b'{}']
    client=Mock();client.stream.return_value=nullcontext(response)
    monkeypatch.setattr(provider.httpx,'Client',lambda **_:nullcontext(client))
    with pytest.raises(HTTPException) as exc:
        provider.post_json('http://127.0.0.1:1234/v1/chat/completions',{},check)
    assert exc.value.status_code==401
