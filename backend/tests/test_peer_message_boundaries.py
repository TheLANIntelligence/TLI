"""Synthetic admission, exact acknowledgment, storage ordering and credential tests."""
import copy
import json
import time

import pytest
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.testclient import TestClient

from tests.test_peer_trust import peers, signed, browser
import peer_trust as P
import tli_state as S
from routers import mesh_routes as mesh


def outgoing(peers):
    return {'message_id':'synthetic-message-identifier','thread_id':'local-a--peer-b','from_id':'local-a','from_name':peers.a['name'],'to_id':'peer-b','body':'Hello from this exact computer','ts':time.time()*1000}


def incoming(peers):
    msg=outgoing(peers);msg.update(from_id='peer-b',from_name=peers.b['name'],to_id='local-a');return msg


def acknowledgment(msg):
    return dict({k:msg[k] for k in ('message_id','thread_id','from_id','to_id')},ok=True,duplicate=False)


@pytest.mark.parametrize('variant',['false','list','null','empty','bare_ok','numeric_ok','wrong_message','wrong_thread','wrong_sender','wrong_recipient','missing_duplicate','invalid_duplicate','invalid_json'])
def test_unmatched_success_ack_never_records_sent_or_claims_delivery(peers,monkeypatch,variant):
    msg=outgoing(peers);ack=acknowledgment(msg)
    if variant=='false':ack={'ok':False}
    elif variant=='list':ack=[]
    elif variant=='null':ack=None
    elif variant=='empty':ack={}
    elif variant=='bare_ok':ack={'ok':True}
    elif variant=='numeric_ok':ack['ok']=1
    elif variant.startswith('wrong_'):ack[{'wrong_message':'message_id','wrong_thread':'thread_id','wrong_sender':'from_id','wrong_recipient':'to_id'}[variant]]='other'
    elif variant=='missing_duplicate':ack.pop('duplicate')
    elif variant=='invalid_duplicate':ack['duplicate']=1
    raw=b'not json' if variant=='invalid_json' else P.canonical(ack)
    requests=[]
    monkeypatch.setattr(P,'request',lambda *a,**kw:(requests.append(kw['json_body']) or P.Response(200,raw)))
    monkeypatch.setattr(mesh,'_append_chat_msg',lambda *a:pytest.fail('Recorded sent without matching acknowledgment'))
    with pytest.raises(HTTPException) as error:
        mesh.mesh_chat_send(mesh.ChatMessageRequest(**msg),BackgroundTasks(),_session='owner')
    assert error.value.detail['delivery']=='uncertain'
    assert error.value.detail['code']=='message_acknowledgment_uncertain'
    assert len(requests)==1 and requests[0]['message_id']==msg['message_id']
    assert not (peers.root/'peer_message_receipts.json').exists()


def test_matching_ack_allows_sent_receipt_without_changing_browser_contract(peers,monkeypatch):
    msg=outgoing(peers);written=[]
    monkeypatch.setattr(P,'request',lambda *a,**kw:P.Response(200,P.canonical(acknowledgment(msg))))
    monkeypatch.setattr(mesh,'_append_chat_msg',lambda thread,row:written.append((thread,row)))
    result=mesh.mesh_chat_send(mesh.ChatMessageRequest(**msg),BackgroundTasks(),_session='owner')
    assert result=={'ok':True,'delivery':'acknowledged','duplicate':False,'automatic_retry':False}
    assert len(written)==1 and written[0][0]==msg['thread_id']


@pytest.mark.parametrize('thread',['local-a--peer-c','peer-b--local-a','local-a/peer-b','local-a--peer-b'+'x'*80])
def test_wrong_thread_rejected_before_outbound_or_receipt(peers,monkeypatch,thread):
    msg=outgoing(peers);msg['thread_id']=thread
    monkeypatch.setattr(P,'request',lambda *a,**kw:pytest.fail('Wrong-thread request sent'))
    with pytest.raises(HTTPException) as error:mesh.mesh_chat_send(mesh.ChatMessageRequest(**msg),BackgroundTasks(),_session='owner')
    assert error.value.detail['code']=='invalid_message_thread'
    assert not (peers.root/'peer_message_receipts.json').exists()


@pytest.mark.parametrize('sender,recipient',[('A','b'),('a--b','c'),('a','b--c'),('a/b','c'),('a.b','c'),('a'*60,'b'*30),('a','a'),('ñ','b')])
def test_new_thread_identifiers_cannot_alias_legacy_filenames(peers,sender,recipient):
    msg=outgoing(peers);msg.update(from_id=sender,to_id=recipient,thread_id='--'.join(sorted([sender,recipient])))
    with pytest.raises(HTTPException):P.validate_message(msg)
    # Retained history path normalization remains unchanged; new writes reject it.
    assert len(mesh._safe_thread_path('x'*100).stem)==80


def test_signed_peer_cannot_write_into_another_peers_thread(peers,monkeypatch):
    app=FastAPI();app.include_router(mesh.router);msg=incoming(peers);msg['thread_id']='local-a--peer-c'
    monkeypatch.setattr(mesh,'_append_chat_msg',lambda *a:pytest.fail('Cross-thread injection'))
    raw,headers=signed(peers,'/mesh/chat/receive',msg)
    with TestClient(app,base_url='https://192.168.2.10:8443') as client:
        result=client.post('/mesh/chat/receive',content=raw,headers=headers)
    assert result.status_code==409 and result.json()['detail']['code']=='invalid_message_thread'
    assert not (peers.root/'peer_message_receipts.json').exists()


def test_signed_receive_and_replay_return_exact_ack_after_synced_append(peers,monkeypatch):
    app=FastAPI();app.include_router(mesh.router);msg=incoming(peers);order=[]
    monkeypatch.setattr(mesh,'MESH_CHAT_DIR',peers.root)
    monkeypatch.setattr(mesh,'_broadcast_presence',lambda data:None)
    monkeypatch.setattr(S,'encrypt_jsonl_line',lambda data:(order.append('encode') or 'synthetic encrypted bytes'))
    write=S._security.write_json;sync=mesh.os.fsync
    def record_write(path,data,label):
        if str(path).endswith('peer_message_receipts.json'):order.append(next(iter(data.values()))['status'])
        return write(path,data,label)
    monkeypatch.setattr(S._security,'write_json',record_write)
    monkeypatch.setattr(mesh.os,'fsync',lambda fd:(order.append('fsync'),sync(fd))[1])
    with TestClient(app,base_url='https://192.168.2.10:8443') as client:
        for i in (1,2):
            raw,headers=signed(peers,'/mesh/chat/receive',msg,nonce=str(i)*48)
            result=client.post('/mesh/chat/receive',content=raw,headers=headers)
            assert result.status_code==200,result.text
            assert result.json()==dict(acknowledgment(msg),duplicate=i==2)
    assert (peers.root/'local-a--peer-b.jsonl').read_text().count('synthetic encrypted bytes')==1
    assert order.index('encode')<order.index('fsync',order.index('encode'))<order.index('complete')


def test_append_sync_failure_cannot_acknowledge_or_repeat_uncertain_write(peers,monkeypatch):
    app=FastAPI();app.include_router(mesh.router);msg=incoming(peers);encoded=[]
    monkeypatch.setattr(mesh,'MESH_CHAT_DIR',peers.root)
    monkeypatch.setattr(mesh,'_broadcast_presence',lambda data:None)
    monkeypatch.setattr(S,'encrypt_jsonl_line',lambda data:(encoded.append(True) or 'synthetic encrypted bytes'))
    sync=mesh.os.fsync
    def fail_append(fd):
        if encoded:raise OSError('Synthetic append fsync failure')
        return sync(fd)
    monkeypatch.setattr(mesh.os,'fsync',fail_append)
    with TestClient(app,base_url='https://192.168.2.10:8443',raise_server_exceptions=False) as client:
        raw,headers=signed(peers,'/mesh/chat/receive',msg,nonce='3'*48)
        assert client.post('/mesh/chat/receive',content=raw,headers=headers).status_code==500
        raw,headers=signed(peers,'/mesh/chat/receive',msg,nonce='4'*48)
        result=client.post('/mesh/chat/receive',content=raw,headers=headers)
        assert result.status_code==409 and result.json()['detail']['code']=='message_uncertain'
    ledger=json.loads((peers.root/'peer_message_receipts.json').read_text())
    assert next(iter(ledger.values()))['status']=='started' and encoded==[True]


def test_trust_review_rejects_bearer_even_with_same_owner_browser_cookie(peers,monkeypatch):
    import companion_auth
    monkeypatch.setattr(companion_auth,'credential_owner',lambda value:'owner' if value in ('credential-one','credential-two') else None)
    app=FastAPI();app.include_router(mesh.router);original=S.MESH_DIRECTORY_PATH.read_bytes()
    with TestClient(app,base_url='https://192.168.2.10:8443') as client:
        for token in ('credential-one', 'credential-two'):
            headers={'Authorization':'Bearer '+token,'Cookie':'tli_session=browser-token'}
            review=client.post('/mesh/trust/preview',json={'card':peers.b,'grants':['observe']},headers=headers)
            assert review.status_code==403,review.text
            assert review.json()['detail']['code']=='pairing_browser_required'
            payload={'review_id':'absent','identity_fingerprint':peers.b['identity_fingerprint'],'certificate_sha256':peers.b['certificate_sha256']}
            assert client.post('/mesh/trust/approve',json=payload,headers=headers).status_code==403
            assert S.MESH_DIRECTORY_PATH.read_bytes()==original
