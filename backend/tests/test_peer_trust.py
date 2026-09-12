"""Synthetic computers/keys and fake sockets only; never discover a live LAN."""
import base64
import copy
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import node_identity
import peer_trust as P
import tli_state as S
from routers import mesh_routes as mesh, node_routes as node


def computer(node_id="peer-b", address="192.168.2.20", port=8443):
    import ipaddress
    key = Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic computer")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(address))]), critical=False)
            .sign(key, None))
    der = cert.public_bytes(serialization.Encoding.DER)
    card = {"protocol": P.PROTOCOL, "node_id": node_id, "name": "Synthetic " + node_id,
            "origin": f"https://{address}:{port}", "public_key": pub, "identity_fingerprint": P._fingerprint(pub),
            "certificate_der": base64.b64encode(der).decode(), "certificate_sha256": hashlib.sha256(der).hexdigest(),
            "capabilities": ["system_observation_v1", "coordination_v1", "messages_v1"], "issued_at": now.isoformat()}
    card["signature"] = key.sign(P.canonical(card)).hex()
    return key, card


def entry(card, status="allowed", grants=None):
    from urllib.parse import urlsplit
    u = urlsplit(card["origin"])
    return {"display_name": card["name"], "ip": u.hostname, "tli_port": u.port, "status": status,
            "identity_fingerprint": card["identity_fingerprint"], "peer_trust": {"card": card,
            "grants": grants if grants is not None else ["observe", "coordinate", "messages"], "reviewed_at": "synthetic", "reviewed_by": "owner"}}


@pytest.fixture()
def peers(tmp_path, monkeypatch):
    key_a, card_a = computer("local-a", "192.168.2.10")
    key_b, card_b = computer()
    cfg = S.NodeConfig(node_id="local-a", node_name=card_a["name"], role="host", mesh_status="approved", created_at="synthetic", updated_at="synthetic")
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", tmp_path / "node_config.json")
    monkeypatch.setattr(S, "MESH_DIRECTORY_PATH", tmp_path / "mesh_directory.json")
    S._security.write_json(S.NODE_CONFIG_PATH, cfg.model_dump(), "synthetic")
    S.save_mesh_directory({"peer-b": entry(card_b)})
    monkeypatch.setattr(node_identity, "public_key_hex", lambda: card_a["public_key"])
    monkeypatch.setattr(node_identity, "fingerprint", lambda: card_a["identity_fingerprint"])
    monkeypatch.setattr(node_identity, "sign", lambda b: key_a.sign(b).hex())
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: token == "browser-token")
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "owner")
    monkeypatch.setattr(S, "log_debug", lambda *a, **kw: None)
    monkeypatch.setattr(P, "_exchange", lambda *a: pytest.fail("Unexpected peer I/O"))
    P._PREVIEWS.clear(); P._NONCES.clear()
    return NS(a=card_a, b=card_b, key_a=key_a, key_b=key_b, cfg=cfg, root=tmp_path)


def browser():
    return Request({"type": "http", "headers": [(b"cookie", b"tli_session=browser-token")]})


def signed(peers, path, body, *, sender=None, nonce=None):
    card = peers.b if sender is None else sender
    stamp = str(int(time.time())); nonce = nonce or "ab" * 24
    raw = P.canonical(body)
    value = P._signed("POST", path, raw, {"node_id": peers.a["node_id"], "public_key": peers.a["public_key"]}, stamp, nonce, card["node_id"])
    return raw, {"content-type": "application/json", "x-tli-peer-id": card["node_id"], "x-tli-peer-time": stamp,
                 "x-tli-peer-nonce": nonce, "x-tli-peer-signature": peers.key_b.sign(value).hex()}


@pytest.mark.parametrize("value", ["http://192.168.1.2:8000", "https://example.test:8000", "https://127.0.0.1", "https://8.8.8.8", "https://user@192.168.1.2", "https://192.168.1.2/x", "https://192.168.1.2?x", "https://192.168.1.2#x"])
def test_origin_rejects_unreviewable_destination(value):
    with pytest.raises(HTTPException): P.origin(value)


def test_card_signature_and_certificate_must_both_match(peers):
    assert P.validate_card(peers.b) == peers.b
    for key, value in [("name", "Spoof"), ("certificate_sha256", "0"*64), ("origin", "https://192.168.2.30:8443"), ("public_key", peers.a["public_key"])]:
        changed = dict(peers.b, **{key:value})
        with pytest.raises(HTTPException): P.validate_card(changed)


def test_review_is_pure_and_commit_requires_exact_session_and_fingerprints(peers):
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    review = P.preview(peers.b, ["observe"], "owner", browser())
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    with pytest.raises(HTTPException): P.approve(review["review_id"], "wrong", peers.b["certificate_sha256"], "owner", browser())
    with pytest.raises(HTTPException): P.approve(review["review_id"], peers.b["identity_fingerprint"], peers.b["certificate_sha256"], "different-owner", browser())
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    result = P.approve(review["review_id"], peers.b["identity_fingerprint"], peers.b["certificate_sha256"], "owner", browser())
    assert result["trust_state"] == "verified"
    assert P.trusted("peer-b")[0]["peer_trust"]["grants"] == ["observe"]


def test_same_ip_new_id_never_inherits_approval_labels_or_removes_old(peers):
    old = S.load_mesh_directory()["peer-b"]; old.update({"status":"blocked", "labels":["Private"], "notes":"Keep"})
    S.save_mesh_directory({"peer-b": old})
    _, new = computer("replacement", "192.168.2.20")
    review = P.preview(new, ["observe"], "owner", browser())
    P.approve(review["review_id"], new["identity_fingerprint"], new["certificate_sha256"], "owner", browser())
    directory = S.load_mesh_directory()
    assert directory["peer-b"] == old
    assert directory["replacement"]["status"] == "allowed"
    assert "labels" not in directory["replacement"] and "notes" not in directory["replacement"]


@pytest.mark.parametrize("status,trust", [("blocked",True),("pending",True),("allowed",False)])
def test_untrusted_or_unapproved_peer_cannot_start_any_request(peers,status,trust):
    e = entry(peers.b,status)
    if not trust: del e["peer_trust"]
    S.save_mesh_directory({"peer-b":e})
    with pytest.raises(HTTPException): P.request("peer-b","GET","/agent/peer/health")
    with pytest.raises(HTTPException): mesh._resolve_mesh_target("peer-b")
    assert P.capability("peer-b")["available"] is False


def test_review_cannot_overwrite_concurrent_revocation(peers):
    review = P.preview(peers.b,["observe"],"owner",browser())
    mesh.mesh_trust_revoke("peer-b")
    with pytest.raises(HTTPException): P.approve(review["review_id"],peers.b["identity_fingerprint"],peers.b["certificate_sha256"],"owner",browser())
    assert S.load_mesh_directory()["peer-b"]["status"] == "blocked"


def test_pin_enabled_receiver_accepts_signed_observation_and_rejects_replay(peers,monkeypatch):
    app=FastAPI(); app.include_router(node.router)
    monkeypatch.setattr(node.psutil,"virtual_memory",lambda:NS(total=1000,used=400,available=600,percent=40))
    monkeypatch.setattr(node.psutil,"cpu_percent",lambda interval:12)
    monkeypatch.setattr(node.psutil,"cpu_count",lambda:8)
    monkeypatch.setattr(node.psutil,"boot_time",lambda:time.time()-100)
    raw,headers=signed(peers,"/agent/peer/observe",{"kind":"system"})
    with TestClient(app,base_url="https://192.168.2.10:8443") as client:
        response=client.post("/agent/peer/observe",content=raw,headers=headers)
        assert response.status_code==200, response.text
        assert response.json()["host"]["id"]=="local-a"
        assert response.json()["facts"]["cpu_percent"]==12
        assert client.post("/agent/peer/observe",content=raw,headers=headers).status_code==409
        assert client.post("/agent/peer/observe",json={"kind":"system"}).status_code==401


@pytest.mark.parametrize("change",["body","sender","signature","clock"])
def test_signature_binds_entire_request_before_measurement(peers,monkeypatch,change):
    app=FastAPI();app.include_router(node.router)
    monkeypatch.setattr(node.psutil,"virtual_memory",lambda:pytest.fail("No observation admitted"))
    raw,headers=signed(peers,"/agent/peer/observe",{"kind":"system"})
    if change=="body": raw=P.canonical({"kind":"other"})
    if change=="sender":headers["x-tli-peer-id"]="stranger"
    if change=="signature":headers["x-tli-peer-signature"]="0"*128
    if change=="clock":headers["x-tli-peer-time"]="1"
    with TestClient(app,base_url="https://192.168.2.10:8443") as client:
        assert client.post("/agent/peer/observe",content=raw,headers=headers).status_code in (401,403,404)


def test_unsigned_legacy_join_cannot_mutate_or_inherit(peers):
    app=FastAPI();app.include_router(mesh.router)
    from license_gate import gate
    before=S.MESH_DIRECTORY_PATH.read_bytes()
    with TestClient(app,base_url="https://192.168.2.10:8443") as client:
        r=client.post("/mesh/join",json={"device_id":"other","display_name":"Other","ip":"192.168.2.20"})
        assert r.status_code in (401,402)
    assert S.MESH_DIRECTORY_PATH.read_bytes()==before


def test_receiver_binds_body_identity_to_authenticated_sender(peers):
    app=FastAPI();app.include_router(mesh.router)
    raw,headers=signed(peers,"/agent/tasks/next",{"device_id":"different"})
    with TestClient(app,base_url="https://192.168.2.10:8443") as client:
        assert client.post("/agent/tasks/next",content=raw,headers=headers).status_code==403


def test_revocation_during_request_discards_response(peers,monkeypatch):
    def exchange(*args):
        args[-1]()
        mesh.mesh_trust_revoke("peer-b")
        return P.Response(200,b'{}')
    monkeypatch.setattr(P,"_exchange",exchange)
    with pytest.raises(HTTPException): P.request("peer-b","GET","/agent/peer/health")


@pytest.mark.parametrize("task",["clean_temp","rotate_logs"])
def test_old_maintenance_cannot_delete_or_run_unreviewed_tasks(peers,monkeypatch,task):
    monkeypatch.setattr(node.os,"remove",lambda *a:pytest.fail("Deletion forbidden"))
    monkeypatch.setattr(node.os,"scandir",lambda *a:pytest.fail("Probe forbidden"))
    with pytest.raises(HTTPException) as e: node.agent_tasks_run(node.AgentTaskRunRequest(task_id=task))
    assert e.value.status_code==409
    with pytest.raises(HTTPException):node.agent_maintenance_clean_temp()
    with pytest.raises(HTTPException):mesh.mesh_node_maintenance_clean_temp("peer-b")


def test_directory_corruption_is_preserved_and_missing_trust_does_not_reset(peers):
    S.MESH_DIRECTORY_PATH.write_bytes(b'{corrupt')
    with pytest.raises(HTTPException):S.load_mesh_directory()
    with pytest.raises(HTTPException):S.save_mesh_directory({})
    assert S.MESH_DIRECTORY_PATH.read_bytes()==b'{corrupt'
    S.MESH_DIRECTORY_PATH.unlink()
    raw=json.loads(S.NODE_CONFIG_PATH.read_text());raw["peer_trust_established"]=True
    S.NODE_CONFIG_PATH.write_text(json.dumps(raw))
    with pytest.raises(HTTPException):S.load_mesh_directory()
    assert not S.MESH_DIRECTORY_PATH.exists()


def test_durable_message_retry_never_duplicates_or_changes_text(peers):
    msg={"message_id":"m"*32,"thread_id":"a--b","from_id":"a","from_name":"A","to_id":"b","body":"hello","ts":time.time()*1000}
    writes=[]
    assert P.record_message_once(msg,"received",lambda:writes.append(1)) is False
    assert P.record_message_once(msg,"received",lambda:writes.append(2)) is True
    with pytest.raises(HTTPException):P.record_message_once(dict(msg,body="changed"),"received",lambda:writes.append(3))
    assert writes==[1]


def test_uncertain_message_write_is_not_replayed(peers):
    msg={"message_id":"u"*32,"thread_id":"a--b","from_id":"a","from_name":"A","to_id":"b","body":"hello","ts":time.time()*1000}
    def interrupted(): raise OSError("synthetic crash")
    with pytest.raises(OSError):P.record_message_once(msg,"received",interrupted)
    with pytest.raises(HTTPException) as e:P.record_message_once(msg,"received",lambda:pytest.fail("Replayed uncertain message"))
    assert e.value.detail["code"]=="message_uncertain"


def test_tls_pin_and_revocation_checks_precede_credentials(peers,monkeypatch):
    # Get the production function, not the fixture's no-network replacement.
    import ast
    from pathlib import Path
    source=Path(P.__file__).read_text(encoding="utf-8")
    function=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=="_exchange")
    namespace=dict(vars(P));exec(compile(ast.Module(body=[function],type_ignores=[]),P.__file__,"exec"),namespace)
    exchange=namespace["_exchange"]
    sent=[];closed=[]
    class Socket:
        def getpeercert(self,binary_form=False): return b"wrong certificate"
    class Connection:
        def __init__(self,*a,**kw):self.sock=Socket()
        def connect(self):pass
        def request(self,*a,**kw):sent.append(kw)
        def close(self):closed.append(True)
    monkeypatch.setattr(P.http.client,"HTTPSConnection",Connection)
    with pytest.raises(HTTPException) as e:exchange(peers.b,"POST","/agent/peer/observe",b'{}',{"X-TLI-Peer-Signature":"sensitive-signature"},lambda:None)
    assert e.value.detail["code"]=="peer_certificate_changed"
    assert sent==[] and closed==[True]


def test_observation_rejects_naive_time_and_wrong_host_without_fallback(peers,monkeypatch):
    valid={"protocol":"tli-peer-observation-v1","host":{"id":"peer-b","name":peers.b["name"],"identity_fingerprint":peers.b["identity_fingerprint"]},
           "observed_at":datetime.now(timezone.utc).isoformat(),"facts":{"cpu_percent":1,"logical_cpus":8,"ram_total_bytes":1000,"ram_used_bytes":400,"ram_available_bytes":600,"ram_percent":40,"uptime_seconds":12},"scope":"Measured here","limitations":[]}
    monkeypatch.setattr(P,"request",lambda *a,**kw:P.Response(200,P.canonical(valid)))
    revision=P.capability("peer-b")["revision"]
    assert P.observe("peer-b",revision)["host"]==valid["host"]
    valid["observed_at"]=datetime.now().isoformat()
    with pytest.raises(HTTPException):P.observe("peer-b",revision)
    valid["observed_at"]=datetime.now(timezone.utc).isoformat();valid["host"]["id"]="wrong-host"
    with pytest.raises(HTTPException):P.observe("peer-b",revision)


def test_trust_marker_failure_cannot_publish_approval(peers,monkeypatch):
    before=S.MESH_DIRECTORY_PATH.read_bytes()
    review=P.preview(peers.b,["observe"],"owner",browser())
    original=S._security.write_json
    def write(path,*args,**kwargs):
        if path==S.NODE_CONFIG_PATH:raise OSError("synthetic marker failure")
        return original(path,*args,**kwargs)
    monkeypatch.setattr(S._security,"write_json",write)
    with pytest.raises(OSError):P.approve(review["review_id"],peers.b["identity_fingerprint"],peers.b["certificate_sha256"],"owner",browser())
    assert S.MESH_DIRECTORY_PATH.read_bytes()==before


def test_normal_configuration_save_preserves_missing_directory_marker(peers):
    raw=json.loads(S.NODE_CONFIG_PATH.read_text());raw["peer_trust_established"]=True
    S.NODE_CONFIG_PATH.write_text(json.dumps(raw))
    cfg=S.load_node_config();cfg.node_name="Renamed"
    S.save_node_config(cfg)
    assert json.loads(S.NODE_CONFIG_PATH.read_text())["peer_trust_established"] is True
    S.MESH_DIRECTORY_PATH.unlink()
    with pytest.raises(HTTPException):S.load_mesh_directory()


def test_peer_401_is_not_reported_as_local_browser_session_expiry(peers,monkeypatch):
    monkeypatch.setattr(P,"_exchange",lambda *a:P.Response(401,b'{}'))
    with pytest.raises(HTTPException) as e:P.request("peer-b","GET","/agent/peer/health")
    assert e.value.status_code==409 and e.value.detail["code"]=="peer_review_required"


@pytest.mark.parametrize("mode",["valid","changed_certificate","revoked_before_send"])
def test_real_loopback_https_binds_certificate_before_signed_headers(peers,monkeypatch,mode):
    """Real TLS on 127.0.0.1 only; advertised private address never connected."""
    import ast
    import http.client
    import http.server
    import socket
    import ssl
    import threading
    from pathlib import Path
    original_connection=http.client.HTTPSConnection
    source=Path(P.__file__).read_text(encoding="utf-8")
    function=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=="_exchange")
    namespace=dict(vars(P));exec(compile(ast.Module(body=[function],type_ignores=[]),P.__file__,"exec"),namespace)
    exchange=namespace["_exchange"]
    key,card=(computer() if mode=="changed_certificate" else (peers.key_b,peers.b))
    cert=P._certificate(card)
    certpath=peers.root/"server.pem";keypath=peers.root/"server-key.pem"
    certpath.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    keypath.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    received=[]
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            body=self.rfile.read(int(self.headers.get("Content-Length","0")))
            received.append(dict(self.headers))
            value=P._signed("GET",self.path,body,{"node_id":peers.b["node_id"],"public_key":peers.b["public_key"]},self.headers["X-TLI-Peer-Time"],self.headers["X-TLI-Peer-Nonce"],peers.a["node_id"])
            valid=node_identity.verify(value,self.headers["X-TLI-Peer-Signature"],peers.a["public_key"])
            payload=P.canonical({"verified_sender":valid,"node_id":peers.b["node_id"]})
            self.send_response(200 if valid else 401);self.send_header("Content-Length",str(len(payload)));self.end_headers();self.wfile.write(payload)
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler)
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(certpath,keypath)
    server.socket=ctx.wrap_socket(server.socket,server_side=True)
    thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=0.05),daemon=True);thread.start()
    original_init=original_connection.__init__;original_connect=original_connection.connect
    def loopback_init(self,*args,**kwargs):
        original_init(self,*args,**kwargs)
        self._create_connection=lambda address,timeout,source_address=None:socket.create_connection(("127.0.0.1",server.server_port),timeout)
    def connect(self):
        original_connect(self)
        if mode=="revoked_before_send":mesh.mesh_trust_revoke("peer-b")
    monkeypatch.setattr(original_connection,"__init__",loopback_init)
    monkeypatch.setattr(original_connection,"connect",connect)
    monkeypatch.setattr(P,"_exchange",exchange)
    try:
        if mode=="valid":
            response=P.request("peer-b","GET","/agent/peer/health")
            assert response.json()=={"node_id":"peer-b","verified_sender":True}
            assert len(received)==1
            assert "Authorization" not in received[0] and "Cookie" not in received[0]
        else:
            with pytest.raises(HTTPException):P.request("peer-b","GET","/agent/peer/health")
            assert received==[]
    finally:
        server.shutdown();server.server_close();thread.join(2)
        assert not thread.is_alive()

def test_coordinate_does_not_authorize_legacy_native_metrics(peers, monkeypatch):
    app=FastAPI();app.include_router(node.router)
    monkeypatch.setattr(node.psutil,"disk_partitions",lambda *a,**kw:pytest.fail("Legacy disk probe ran"))
    with TestClient(app) as client:
        response=client.get("/agent/disk",headers={"x-tli-peer-id":"peer-b"})
        assert response.status_code==401


def test_health_requires_reviewed_identity_and_current_aware_time(peers,monkeypatch):
    value={"ok":True,"online":True,"node_id":"peer-b","node_name":peers.b["name"],"identity_fingerprint":peers.b["identity_fingerprint"],"observed_at":datetime.now(timezone.utc).isoformat(),"capabilities":peers.b["capabilities"]}
    monkeypatch.setattr(P,"request",lambda *a,**kw:P.Response(200,P.canonical(value)))
    assert P.health("peer-b")["node_id"]=="peer-b"
    for key,wrong in [("node_id","another-host"),("node_name","Spoof"),("observed_at",datetime.now().isoformat()),("online",False)]:
        old=value[key];value[key]=wrong
        with pytest.raises(HTTPException):P.health("peer-b")
        value[key]=old


def test_null_observation_metrics_remain_unknown(peers,monkeypatch):
    value={"protocol":"tli-peer-observation-v1","host":{"id":"peer-b","name":peers.b["name"],"identity_fingerprint":peers.b["identity_fingerprint"]},"observed_at":datetime.now(timezone.utc).isoformat(),"facts":dict.fromkeys(["cpu_percent","logical_cpus","ram_total_bytes","ram_used_bytes","ram_available_bytes","ram_percent","uptime_seconds"]),"scope":"Peer only","limitations":["Unavailable metrics"],"coverage":{"complete":True}}
    monkeypatch.setattr(P,"request",lambda *a,**kw:P.Response(200,P.canonical(value)))
    result=P.observe("peer-b",P.capability("peer-b")["revision"])
    assert result["coverage"]=={"complete":False,"known_metrics":0,"total_metrics":7}
    assert all(x is None for x in result["facts"].values())

def test_review_envelope_and_optional_synthetic_browser_export(peers,monkeypatch):
    import os
    from pathlib import Path
    app=FastAPI();app.include_router(mesh.router)
    with TestClient(app) as client:
        response=client.post('/mesh/trust/preview',json={'card':peers.b,'grants':['observe','coordinate','messages']},cookies={'tli_session':'browser-token'})
        assert response.status_code==200,response.text
        value=response.json()
        assert value['card']==peers.b and value['grants']==['coordinate','messages','observe']
        if os.environ.get('TLI_SYNTHETIC_PEER_EXPORT'):
            path=Path(os.environ['TLI_SYNTHETIC_PEER_EXPORT']);path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps({'synthetic':True,'preview':value,'local_card':peers.a},indent=2),encoding='utf-8')

def test_unsigned_discovery_preserves_reviewed_endpoint_and_block(peers,monkeypatch):
    import lan_discovery as lan
    events=[];monkeypatch.setattr(lan,'_presence_broadcast_fn',events.append)
    original=S.load_mesh_directory()['peer-b'];original['status']='blocked';original['labels']=['Private']
    S.save_mesh_directory({'peer-b':original})
    lan._handle_beacon(json.dumps({'tli':1,'id':'peer-b','name':'Spoof','port':9999}).encode(),'192.168.2.99')
    saved=S.load_mesh_directory()['peer-b'];discovery=saved.pop('discovery')
    assert saved==original
    assert discovery['ip']=='192.168.2.99' and discovery['verified'] is False
    assert events==[{'type':'directory_changed'}]
    lan._upsert_peer('new-node','Spoof','192.168.2.20',8443)
    new=S.load_mesh_directory()['new-node']
    assert new['status']=='pending' and 'peer_trust' not in new and new['labels']==[]


def test_discovery_whole_transaction_cannot_overwrite_concurrent_revoke(peers,monkeypatch):
    import threading
    import lan_discovery as lan
    original_load=S.load_mesh_directory
    loaded,release,revoked=threading.Event(),threading.Event(),threading.Event()
    once=[False]
    def paused_load():
        value=original_load()
        if threading.current_thread().name=='synthetic-discovery' and not once[0]:
            once[0]=True;loaded.set();assert release.wait(2)
        return value
    monkeypatch.setattr(S,'load_mesh_directory',paused_load)
    errors=[]
    def discover():
        try:lan._upsert_peer('peer-b','Unsigned name','192.168.2.99',9000)
        except Exception as exc:errors.append(exc)
    def revoke():
        try:mesh.mesh_trust_revoke('peer-b');revoked.set()
        except Exception as exc:errors.append(exc)
    first=threading.Thread(target=discover,name='synthetic-discovery');second=threading.Thread(target=revoke)
    first.start()
    try:
        assert loaded.wait(2);second.start();assert not revoked.wait(.05)
    finally:
        release.set();first.join(2)
        if second.ident is not None:second.join(2)
    assert not first.is_alive() and not second.is_alive() and errors==[]
    assert S.load_mesh_directory()['peer-b']['status']=='blocked'


@pytest.mark.parametrize('payload',[[],{'tli':1,'id':7},{'tli':1,'id':'x','port':True},{'tli':1,'id':'x','port':70000}])
def test_malformed_discovery_is_nonmutating(peers,monkeypatch,payload):
    import lan_discovery as lan
    monkeypatch.setattr(lan,'_presence_broadcast_fn',lambda event:pytest.fail('Invalid discovery event'))
    previous=S.MESH_DIRECTORY_PATH.read_bytes()
    lan._handle_beacon(json.dumps(payload).encode(),'192.168.2.99')
    assert S.MESH_DIRECTORY_PATH.read_bytes()==previous

def test_discovery_during_human_review_does_not_expire_unchanged_authority(peers):
    import lan_discovery as lan
    review=P.preview(peers.b,['observe'],'owner',browser())
    lan._upsert_peer('peer-b','Unsigned name','192.168.2.99',9000)
    discovery=S.load_mesh_directory()['peer-b']['discovery']
    P.approve(review['review_id'],peers.b['identity_fingerprint'],peers.b['certificate_sha256'],'owner',browser())
    saved=S.load_mesh_directory()['peer-b']
    assert saved['discovery']==discovery
    assert saved['ip']=='192.168.2.20' and saved['tli_port']==8443
    assert P.trusted('peer-b')[0]['peer_trust']['grants']==['observe']

def test_presence_snapshot_keeps_same_ip_ids_and_rejects_malformed_time(peers,monkeypatch):
    import asyncio
    async def disconnected():return True
    records={key:{'display_name':key,'ip':'192.168.2.30','last_seen':stamp,'status':'pending'} for key,stamp in [('first',S.now_iso()),('second',S.now_iso()),('invalid-time','invalid')]}
    monkeypatch.setattr(S,'load_mesh_directory',lambda:records)
    async def snapshot():
        response=await mesh.mesh_presence_stream(NS(is_disconnected=disconnected),_session='owner')
        return [json.loads(chunk.split('data: ',1)[1]) async for chunk in response.body_iterator]
    payloads=asyncio.run(snapshot())
    assert [x['node_id'] for x in payloads]==['first','second']
