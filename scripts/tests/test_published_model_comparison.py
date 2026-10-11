"""Published model findings retain the actual answers and independent gate failures."""
import ast
from collections import Counter
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
FIELDS = ('factual_grounding', 'useful_next_steps', 'context_handling', 'truthful_action_claims')
PRESETS = {'standard', 'lite', 'power', 'qwen3_1_7b', 'qwen3_4b', 'qwen3_8b'}


def load():
    payload = (ROOT / 'frontend/assets/model-comparison.json').read_bytes()
    return json.loads(payload), hashlib.sha256(payload).hexdigest()


def references():
    tree = ast.parse((ROOT / 'backend/ai/answer_validation.py').read_text(encoding='utf8'))
    return next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == 'COMPARISON_REFERENCES' for target in node.targets))


def digest(value):
    return hashlib.sha256(value.encode('utf8')).hexdigest()


def test_published_results_preserve_each_actual_request_answer_and_missing_response():
    report, _ = load()
    assert report['recorded'] is True and report['example_fixture'] is False
    assert report['record_kind'] == 'actual_model_responses_to_synthetic_cases'
    assert report['test_data'] == 'synthetic'
    assert report['selection_changed'] is False and report['live_tli_contacted'] is False
    assert report['physical_acceptance'] == 'not_run'
    assert len(report['models']) == 6 and {m['preset_id'] for m in report['models']} == PRESETS
    original = {case['id'] for filename in ('tli_answer_quality.json', 'tli_answer_extensions.json')
                for case in json.loads((ROOT / 'scripts/fixtures' / filename).read_text(encoding='utf8'))['cases']}
    assert len(original) == 23
    opaque_ids = set()
    request_identity = None
    grade_hashes = set(report['provenance']['blind_grade_files'].values())
    for model in report['models']:
        cases = model['cases']
        assert len(cases) == 55 and len({c['case_id'] for c in cases}) == 55
        assert original <= {c['case_id'] for c in cases}
        requests = {}
        statuses = Counter()
        for case in cases:
            assert case['answer_id'] not in opaque_ids
            opaque_ids.add(case['answer_id'])
            assert case['request_sha256'] == digest(json.dumps(case['supplied_messages'], sort_keys=True, ensure_ascii=False))
            requests[case['case_id']] = case['request_sha256']
            assert case['answer_sha256'] == digest(case['answer'] or '')
            status = case['response_status']
            assert status in {'response_received', 'failed', 'not_run', 'preparation_failed'}
            statuses[status] += 1
            grade = case['assessment']
            assert grade['grade_sha256'] in grade_hashes and grade['reviewer']
            assert isinstance(grade['notes'], str) and grade['notes'].strip()
            assert all(isinstance(reason, str) and reason.strip() for reason in grade['hard_failures'])
            assert grade['citations_supported'] is None or type(grade['citations_supported']) is bool
            if status == 'response_received':
                assert isinstance(case['answer'], str) and case['answer'].strip()
                assert grade['assessment_status'] == 'assessed'
                assert all(type(grade[field]) is int and grade[field] in (0, 1, 2) for field in FIELDS)
            else:
                assert grade['assessment_status'] == 'missing_response'
                assert all(grade[field] is None for field in FIELDS)
                assert grade['hard_failures'] == [] and grade['citations_supported'] is None
        if request_identity is None:
            request_identity = requests
        assert requests == request_identity
        collection = model['collection']
        assert collection['expected'] == 55 and collection['missing'] == 0
        assert collection['responses'] == statuses['response_received']
        assert collection['not_run'] == statuses['not_run']
        assert collection['preparation_failed'] == statuses['preparation_failed']
        assert collection['timeouts'] == sum(c['response_status'] == 'failed' and c['error_type'] == 'TimeoutError' for c in cases)
        assert collection['failed'] + collection['timeouts'] == statuses['failed']
    assert len(opaque_ids) == 330


def test_independent_dimensions_and_frozen_gate_failures_are_recomputed_from_grades():
    report, _ = load()
    qualified = []
    for model in report['models']:
        cases = model['cases']
        groups = {'primary': [c for c in cases if c['partition'] != 'raw_stress'],
                  'heldout': [c for c in cases if c['partition'] == 'heldout'],
                  'raw_stress': [c for c in cases if c['partition'] == 'raw_stress']}
        assert {key: len(rows) for key, rows in groups.items()} == {'primary': 47, 'heldout': 24, 'raw_stress': 8}
        for key, rows in groups.items():
            partition = model['partitions'][key]
            assert partition['cases'] == partition['expected'] == len(rows)
            for field in FIELDS:
                counts = Counter(row['assessment'][field] for row in rows)
                assert partition['dimension_tallies'][field] == {str(n): counts[n] for n in (0, 1, 2)} | {'not_assessed': counts[None]}
            assert partition['hard_failures'] == [{'case_id': c['case_id'], 'reason': reason} for c in rows for reason in c['assessment']['hard_failures']]
            assert partition['invalid_citations'] == [c['case_id'] for c in rows if c['assessment']['citations_supported'] is False]
        primary, holdout = groups['primary'], model['partitions']['heldout']['dimension_tallies']
        expected = {
            'all55_scored_responses': model['collection']['responses'] == 55,
            'zero_primary_hard_failures': not any(c['assessment']['hard_failures'] for c in primary),
            'zero_primary_grounding_or_context_failures': all(c['assessment'][field] != 0 for c in primary for field in ('factual_grounding', 'context_handling')),
            'heldout_grounding_at_least22_meets': holdout['factual_grounding']['2'] >= 22,
            'heldout_context_at_least22_meets': holdout['context_handling']['2'] >= 22,
            'heldout_usefulness_at_least18_meets': holdout['useful_next_steps']['2'] >= 18,
            'all_primary_citations_supported': all(c['assessment']['citations_supported'] is not False for c in primary),
        }
        assert model['gate']['checks'] == expected
        assert model['gate']['qualified'] is all(expected.values())
        if all(expected.values()):
            qualified.append(model['preset_id'])
    assert report['qualified_presets'] == qualified
    assert report['recommendation']['preset_id'] is None
    assert report['recommendation']['status'] == ('requires_paired_standard_review' if qualified else 'none_qualified')


def test_card_references_bind_published_artifacts_without_certifying_installed_models():
    report, report_hash = load()
    cards = references()
    assert len(cards) == 6
    for model in report['models']:
        value = cards[model['artifact']['filename']]
        assert value['status'] == 'comparison_recorded' and value['preset_id'] == model['preset_id']
        assert value['model_sha256'] == model['artifact']['sha256']
        assert value['runtime_sha256'] == model['provenance']['runtime']['sha256']
        assert value['source_fingerprint'] == report['source_fingerprint']
        assert value['response_report_sha256'] == report_hash
        assert value['case_count'] == 55 and value['primary_case_count'] == 47 and value['heldout_case_count'] == 24
        assert value['response_count'] == model['collection']['responses']
        assert value['timeout_count'] == model['collection']['timeouts']
        assert value['primary_dimensions'] == model['partitions']['primary']['dimension_tallies']
        assert value['quality_acceptance'] == ('passed_frozen_gates' if model['gate']['qualified'] else 'not_passed')
        assert value['installed_artifact_verified'] is False and value['physical_user_acceptance'] == 'not_run'
        assert 'running' not in value and 'healthy' not in value and 'recommended' not in value
        assert value['report_url'] == '/model-comparison.html#model-' + model['preset_id']


class PassiveReport(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids, self.links, self.text = set(), [], []

    def handle_starttag(self, tag, attributes):
        assert tag not in {'script', 'iframe', 'object', 'embed', 'form', 'input', 'img', 'video', 'audio', 'link'}
        attrs = dict(attributes)
        assert not any(key.startswith('on') for key in attrs)
        if 'id' in attrs:
            assert attrs['id'] not in self.ids
            self.ids.add(attrs['id'])
        if tag == 'a':
            assert attrs.get('href', '').startswith('#')
            self.links.append(attrs['href'][1:])

    def handle_data(self, value):
        self.text.append(value)


def test_report_is_inert_and_exact_model_text_cannot_become_markup():
    report, report_hash = load()
    raw = (ROOT / 'frontend/model-comparison.html').read_text(encoding='utf8')
    page = PassiveReport(); page.feed(raw)
    assert set(page.links) <= page.ids
    assert all('model-' + model['preset_id'] in page.ids for model in report['models'])
    visible = ''.join(page.text)
    assert report_hash in visible
    assert 'SYNTHETIC PREVIEW' not in visible
    assert 'Content-Security-Policy' in raw and "default-src 'none'" in raw
    for model in report['models']:
        for case in model['cases']:
            if case['answer']:
                assert case['answer'] in visible
            assert case['answer_sha256'] in visible and case['request_sha256'] in visible
    if not report['qualified_presets']:
        assert 'No validated winner' in visible
