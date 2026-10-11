"""Frontend roster correctness retains distinct reviewed registry identities."""
from types import SimpleNamespace

import peer_trust
from routers import mesh_routes, system_routes
from tests.test_peer_trust import computer, entry


def test_health_keeps_same_name_computers_and_shared_address_installations(monkeypatch):
    records = {}
    cards = {}
    for ident, address, port in [('peer-a','192.168.2.2',8000),('peer-b','192.168.2.3',8000),('peer-c','192.168.2.3',8443)]:
        _,card=computer(ident,address,port); cards[ident]=card;records[ident]=entry(card)
        records[ident]['display_name']='Studio'
    monkeypatch.setattr(mesh_routes.S,'load_mesh_directory',lambda:records)
    monkeypatch.setattr(mesh_routes.S,'load_node_config',lambda:SimpleNamespace(node_id='self'))
    monkeypatch.setattr(system_routes,'agent_health',lambda:{'node_id':'self'})
    calls=[]
    def request(ident,method,path,**kw):
        peer_trust.trusted(ident,'coordinate')
        card=cards[ident];calls.append((ident,card['origin'],method,path))
        return peer_trust.Response(200,peer_trust.canonical({'ok':True,'online':True,'node_id':ident,'node_name':card['name'],'identity_fingerprint':card['identity_fingerprint'],'observed_at':mesh_routes.S.now_iso(),'capabilities':card['capabilities']}))
    monkeypatch.setattr(peer_trust,'request',request)
    result=mesh_routes.mesh_health()
    peers=[n for n in result['nodes'] if not n['is_self']]
    assert {n['peer_id'] for n in peers}=={'peer-a','peer-b','peer-c'}
    assert all(n['online'] for n in peers)
    assert len(calls)==3
    assert ('peer-c','https://192.168.2.3:8443','GET','/agent/peer/health') in calls
    assert records['peer-a']['display_name']==records['peer-b']['display_name']


def test_health_keeps_unreviewed_record_visible_without_transport(monkeypatch):
    monkeypatch.setattr(mesh_routes.S,'load_mesh_directory',lambda:{'peer-a':{'ip':'192.168.2.2','display_name':'Retained computer','tli_port':8000,'status':'allowed'}})
    monkeypatch.setattr(mesh_routes.S,'load_node_config',lambda:SimpleNamespace(node_id='self'))
    monkeypatch.setattr(system_routes,'agent_health',lambda:{'node_id':'self'})
    calls=[]
    monkeypatch.setattr(peer_trust,'_exchange',lambda *a,**kw:calls.append(a))
    result=mesh_routes.mesh_health()
    peers=[n for n in result['nodes'] if not n['is_self']]
    assert len(peers)==1 and peers[0]['peer_id']=='peer-a' and peers[0]['online'] is None and peers[0]['connection_state']=='review_required'
    assert calls==[]

