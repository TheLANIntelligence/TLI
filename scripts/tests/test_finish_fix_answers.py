"""Inference is never launched by these corpus and capture-boundary checks."""
import copy
import importlib.util
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
spec = importlib.util.spec_from_file_location('finish_fix_harness', ROOT/'scripts/verify_finish_fix_answers.py')
harness = importlib.util.module_from_spec(spec); spec.loader.exec_module(harness)


def example():
    return {'cases': [{'id': 'case', 'status': 'model_request', 'route_consistent': True,
        'lane': 'actual_bundled_chat_routes', 'messages': [{'role': 'user', 'content': 'Synthetic question'}],
        'request_sha256': 'a'*64, 'routes': [{'http_status': 200, 'forbidden_calls': [],
        'seed_stores_unchanged': True} for _ in range(2)]}]}


def fixture():
    return [{'id': 'case', 'purpose': 'Synthetic question', 'rubric': ['No action'], 'partition': 'prospective_confirmation'}]


def test_preserves_actual_supplied_messages_and_partition():
    routes = example()
    result = harness.prepared_requests(routes, fixture())
    assert result[0]['messages'] == routes['cases'][0]['messages']
    assert result[0]['partition'] == 'prospective_confirmation'


@pytest.mark.parametrize('defect', ['omitted', 'duplicated', 'inconsistent', 'missing_sse', 'forbidden', 'changed_store', 'bad_status'])
def test_rejects_incomplete_or_effectful_capture(defect):
    routes = example(); row = routes['cases'][0]
    if defect == 'omitted': routes['cases'] = []
    elif defect == 'duplicated': routes['cases'].append(copy.deepcopy(row))
    elif defect == 'inconsistent': row['route_consistent'] = False
    elif defect == 'missing_sse': row['routes'].pop()
    elif defect == 'forbidden': row['routes'][0]['forbidden_calls'] = ['diagnostic_execution']
    elif defect == 'changed_store': row['routes'][1]['seed_stores_unchanged'] = False
    else: row['routes'][0]['http_status'] = 500
    with pytest.raises(ValueError): harness.prepared_requests(routes, fixture())


def test_deterministic_reply_is_not_synthesized_as_a_model_request():
    routes = example(); row = routes['cases'][0]
    row.update(status='deterministic_response', messages=None, request_sha256=None)
    assert harness.prepared_requests(routes, fixture()) == []
