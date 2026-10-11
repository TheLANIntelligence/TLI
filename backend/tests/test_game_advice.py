"""Specialist advice uses exact reviewed provider bindings and inert context."""
import asyncio
import contextlib
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import tli_state as S
from ai.ai_manager import BundledAIManager
from intelligence import read_only_inference as I
from routers import games as G
from routers.system_routes import require_session


@pytest.fixture
def inference(monkeypatch):
    manager = SimpleNamespace(active_preset_id='fixture-integrated', base_url='http://127.0.0.1:19991',
                              cfg=SimpleNamespace(model_path='fixture.gguf'), generation=contextlib.nullcontext,
                              is_healthy=lambda: True,
                              text_capacity=lambda: {'status': 'configured', 'context_tokens': 8192,
                                                     'source': 'owned_runtime_launch', 'model': 'fixture-integrated'})
    monkeypatch.setattr(BundledAIManager, 'get', lambda: manager)
    provider = SimpleNamespace(chat_url='http://127.0.0.1:19992/v1/chat/completions', text_capacity=lambda model: {})
    monkeypatch.setattr(S, 'lm_provider', provider)
    monkeypatch.setattr(S, 'MODEL_CONFIG', {'fixture': {'id': 'fixture-lm'}})
    monkeypatch.setattr(S, 'DEFAULT_MODEL_KEY', 'fixture')
    calls = []
    class Reply:
        status_code = 200
        lines = [('data: ' + json.dumps({'choices':[{'delta':{'content':json.dumps({'choices':['shadow_quality=Medium']})}}]})).encode(), b'data: [DONE]']
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def iter_lines(self, **kwargs): yield from self.lines
    reply = Reply()
    monkeypatch.setattr(I.requests, 'post', lambda url, **kw: (calls.append((url, kw)), reply)[1])
    return manager, provider, calls, reply


def collect(payload):
    async def run():
        data = {"game_name":"Cyberpunk 2077", "system": {"gpu": {"model": "Fixture GPU"}, "display": {"width": 1920, "height": 1080}}, **payload}
        return ''.join([chunk async for chunk in G.games_ask(data).body_iterator])
    return asyncio.run(run())


@pytest.mark.parametrize('provider,model', [('bundled', 'local'), ('lmstudio', 'fixture-lm')])
def test_selected_provider_streams_only_to_bound_endpoint(inference, provider, model):
    _, _, calls, _ = inference
    binding = G.games_advice_provider(provider)
    output = collect({'game_name': 'Cyberpunk 2077', 'provider': provider, 'provider_key': binding['provider_key'],
                      'corrections': {'gpu': 'Fixture GPU', 'resolution': '2560x1440', 'target_fps': 90}})
    assert 'Shadow Quality' in output and 'data: [DONE]' in output
    assert len(calls) == 1 and calls[0][1]['json']['model'] == model
    assert calls[0][0] == I.bind(provider).url and calls[0][1]['allow_redirects'] is False
    payload = calls[0][1]['json']
    assert 'tools' not in payload and 'tool_choice' not in payload
    assert payload['messages'][0]['role'] == 'system'
    assert 'Fixture GPU' in payload['messages'][-1]['content']
    assert 'input_budget' in output


def test_provider_lookup_does_not_probe_start_or_generate(inference):
    manager, _, calls, _ = inference
    manager.is_healthy = lambda: pytest.fail('A selection read must not probe generation')
    assert G.games_advice_provider('bundled')['readiness'] == 'not_tested'
    assert G.games_advice_provider('lmstudio')['model'] == 'fixture-lm'
    assert not calls


def test_reviewed_binding_rejects_model_or_endpoint_change_before_transport(inference):
    manager, provider, calls, _ = inference
    key = I.bind('bundled').key
    manager.cfg.model_path = 'another.gguf'
    with pytest.raises(HTTPException) as caught:
        G.games_ask({'game_name': 'Test Game', 'provider_key': key})
    assert caught.value.status_code == 409 and not calls
    selected, _ = I.prepare('lmstudio', None, [{'role':'user','content':'Fixture'}])
    provider.chat_url = 'http://changed.invalid/v1/chat/completions'
    with pytest.raises(HTTPException) as caught:
        list(I.stream(selected, [{'role':'user','content':'Fixture'}]))
    assert caught.value.status_code == 409 and not calls


def test_wrong_game_history_settings_and_unrelated_host_data_are_excluded(inference):
    collect({'game_name': 'Cyberpunk 2077', 'system': {'secret': 'private-unrelated', 'cpu': {'model': 'Known CPU'}, 'gpu': {'model':'GPU'}, 'display':{'width':1920,'height':1080}},
             'config_game_name': 'RDR2', 'current_settings': [{'label':'foreign-setting','value':'Ultra'}],
             'history':[{'game_name':'RDR2','question':'foreign-question','text':'foreign-answer'}]})
    messages = json.dumps(inference[2][0][1]['json']['messages'])
    assert 'Known CPU' in messages
    assert all(value not in messages for value in ['private-unrelated','foreign-setting','foreign-question','foreign-answer'])
    assert 'Unknown: no matching settings were read' in messages


def test_same_game_followup_and_corrections_have_explicit_provenance(inference):
    collect({'game_name':'Cyberpunk 2077','question':'Still stuttering after changing shadows',
             'config_game_name':'cyberpunk 2077','current_settings':[{'label':'Shadows','value':'High'}],
             'history':[{'game_name':'Cyberpunk 2077','question':'First plan','text':'Try medium shadows.'}],
             'corrections': {'manual_settings':'Shadows now Medium, 42 FPS in the city','cpu':'Corrected CPU'}})
    messages = inference[2][0][1]['json']['messages']
    assert [row['role'] for row in messages] == ['system','user','assistant','user']
    assert 'Try medium shadows.' == messages[2]['content']
    assert 'manual_settings' in messages[-1]['content'] and 'Corrected CPU' in messages[-1]['content']
    assert 'never facts' not in messages[0]['content'] and 'Never invent a candidate ID' in messages[0]['content']


@pytest.mark.parametrize('patch', [{'question':'a'*1601}, {'game_name':' '}, {'corrections':{'target_fps':-1}},
                                   {'current_settings':[{'value':'a'*241}], 'config_game_name':'Game'}])
def test_invalid_or_oversized_inputs_never_send(inference, patch):
    with pytest.raises(HTTPException) as caught:
        G.games_ask({'game_name':'Game', **patch})
    assert caught.value.status_code == 422 and not inference[2]


def test_context_budget_rechecked_before_transport(inference):
    manager, _, calls, _ = inference
    manager.text_capacity = lambda: {'status':'configured','context_tokens':512,
                                    'source':'owned_runtime_launch','model':'fixture-integrated'}
    with pytest.raises(HTTPException) as caught:
        G.games_ask({'game_name':'Game'})
    assert caught.value.status_code == 422 and not calls


@pytest.mark.parametrize('lines,expected', [
    ([], 'complete advice'),
    ([b'data: {"choices":[{"delta":{"content":"Partial advice"}}]}'], 'complete advice'),
    ([b'data: {"choices":[{"delta":{},"finish_reason":"length"}]}', b'data: [DONE]'], 'complete advice'),
])
def test_incomplete_replies_never_become_success_or_static_advice(inference, lines, expected):
    inference[3].lines = lines
    output = collect({'game_name':'Cyberpunk 2077'})
    assert '"incomplete": true' in output and expected in output
    assert 'static-guidance' not in output


def test_unavailable_selected_provider_does_not_fall_back(inference):
    inference[0].is_healthy = lambda: False
    output = collect({'game_name':'Cyberpunk 2077'})
    assert 'Integrated AI is unavailable' in output and '"incomplete": true' in output
    assert not inference[2]


def test_missing_gpu_resolution_requests_details_without_inference(inference):
    output = collect({'game_name':'Unknown game', 'system':{}})
    assert 'context-needed' in output and 'GPU model and playing resolution' in output
    assert not inference[2]


def test_provider_lookup_requires_session():
    app = FastAPI(); app.include_router(G.games_router)
    app.dependency_overrides[require_session] = lambda: (_ for _ in ()).throw(HTTPException(401, 'Locked'))
    with TestClient(app) as client:
        assert client.get('/games/advice_provider').status_code == 401


def choice_reply(inference, value):
    inference[3].lines = [('data: ' + json.dumps({'choices':[{'delta':{'content':json.dumps(value)}}]})).encode(), b'data: [DONE]']


def test_displayed_current_values_come_only_from_reads_or_user_overrides(inference):
    output = collect({'config_game_name':'Cyberpunk 2077','current_settings':[{'key':'shadow_quality','label':'Shadow Quality','value':'High'}]})
    assert 'High (read from this game)' in output
    choice_reply(inference, {'choices':['shadow_quality=Low']})
    output = collect({'config_game_name':'Cyberpunk 2077','current_settings':[{'key':'shadow_quality','value':'High'}],
                      'manual_values':{'shadow_quality':'Medium'}})
    assert 'Medium (you entered this value)' in output and 'High (read from this game)' not in output
    choice_reply(inference, {'choices':['shadow_quality=Medium']})
    output = collect({'manual_values':{'shadow_quality':''}})
    assert 'current value unknown' in output


@pytest.mark.parametrize('value', [
    {'choices':['shadow_quality=Medium'], 'current':'Ultra'},
    {'choices':['ray_tracing=On']},
    {'choices':['shadow_quality=Medium','shadow_quality=Medium']},
    {'choices':[]},
])
def test_unreliable_or_invented_plan_is_never_displayed(inference, value):
    choice_reply(inference,value)
    output=collect({})
    assert '"incomplete": true' in output
    assert 'data: {"t"' not in output and 'settings_plan' not in output


def test_visual_goal_rejects_a_lower_quality_trial(inference):
    output=collect({'preset':'max_visual','config_game_name':'Cyberpunk 2077',
                    'current_settings':[{'key':'shadow_quality','value':'High'}]})
    assert '"incomplete": true' in output and 'data: {"t"' not in output
    choice_reply(inference,{'choices':['shadow_quality=Ultra']})
    output=collect({'preset':'max_visual','config_game_name':'Cyberpunk 2077',
                    'current_settings':[{'key':'shadow_quality','value':'High'}]})
    assert 'try Ultra' in output and 'Increasing detail' in output


def test_unsupported_game_can_use_user_named_quality_settings(inference):
    choice_reply(inference,{'choices':['custom_0=Medium']})
    output=collect({'game_name':'Another game','custom_settings':[{'label':'Shadow detail','current':'High'}]})
    assert 'Shadow detail' in output and 'High (you entered this value)' in output
    assert 'options unverified' in output and 'not verified by a TLI reader' in output


def test_invented_benchmark_prose_fails_validation_without_display(inference):
    choice_reply(inference,{'choices':['shadow_quality=Medium'],'gain':'A measured 40 FPS increase'})
    output=collect({})
    assert 'A measured 40 FPS increase' not in output and '"incomplete": true' in output


def test_followup_excludes_explicitly_avoided_settings(inference):
    output = collect({'avoid_settings':['shadow_quality']})
    assert '"incomplete": true' in output and 'data: {"t"' not in output
    assert '"id": "shadow_quality=' not in inference[2][0][1]['json']['messages'][-1]['content']
    choice_reply(inference, {'choices':['texture_quality=Medium']})
    output = collect({'avoid_settings':['shadow_quality']})
    assert 'Texture Quality' in output and '"incomplete": true' not in output


def test_unknown_manual_value_keeps_goal_direction_explicit(inference):
    choice_reply(inference, {'choices':['custom_0=High']})
    output = collect({'game_name':'Another game','preset':'max_visual','custom_settings':[{'label':'Shadow detail'}]})
    assert 'current value unknown' in output and 'only if it raises the current value' in output


def test_lm_response_from_another_model_is_rejected_without_advice(inference):
    inference[3].lines = [b'data: {"model":"unreviewed-model","choices":[{"delta":{"content":"Invented advice"}}]}',b'data: [DONE]']
    output = collect({'provider':'lmstudio'})
    assert 'different model' in output and '"incomplete": true' in output
    assert 'Invented advice' not in output and 'data: {"t"' not in output


def test_public_binding_exposes_hostname_without_credentials_or_path():
    value = I.Binding('lmstudio', 'fixture-model', 'https://user:private@studio.example:1234/private?token=secret', 'identity', None).public()
    assert value['inference_host'] == 'studio.example'
    assert 'private' not in json.dumps(value) and 'secret' not in json.dumps(value)


def test_known_game_plan_keeps_current_provenance_and_visible_menu_uncertainty(inference):
    output = collect({'config_game_name':'Cyberpunk 2077','current_settings':[{'key':'shadow_quality','value':'High'}]})
    frames = [json.loads(line[6:]) for line in output.splitlines() if line.startswith('data: {')]
    rendered = ''.join(frame.get('t','') for frame in frames)
    assert 'High (read from this game)' in rendered
    assert 'Reader vocabulary: confirm each suggested option exists in your game version' in rendered


def test_visual_goal_explains_known_hardware_without_claiming_headroom(inference):
    choice_reply(inference, {'choices':['texture_quality=Ultra']})
    output = collect({'preset':'max_visual','system':{'gpu':{'model':'Fixture GPU','vram_gb':16},'display':{'width':2560,'height':1440}},
                      'manual_values':{'texture_quality':'High'}})
    assert 'High (you entered this value)' in output
    assert 'Fixture GPU (reported VRAM: 16 GB)' in output and 'headroom is not measured' in output
