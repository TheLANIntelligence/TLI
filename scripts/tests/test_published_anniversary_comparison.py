"""Gate the actual anniversary publication; absent artifacts fail, never skip.

This suite reads only the published record and its passive report/reference
module. It does not import TLI, open private grading artifacts, run inference,
infer grades, or replace the independent blind assessment.
"""
import ast
from collections import Counter
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / 'frontend/assets/model-comparison-anniversary.json'
PAGE = ROOT / 'frontend/model-comparison-anniversary.html'
REFERENCE = ROOT / 'backend/ai/anniversary_validation.py'
POLICY_SHA256 = 'ab5397708c83fa675103c7d09f4b0e7484eb866ec168480a49bab12a3c7cb6f3'
FIELDS = ('factual_grounding', 'useful_next_steps', 'context_handling', 'truthful_action_claims')
PRESETS = {'standard', 'lite', 'power', 'qwen3_1_7b', 'qwen3_4b', 'qwen3_8b'}
STATUSES = {'response_received', 'failed', 'not_run', 'prepared', 'preparation_failed'}


def sha(value):
    assert isinstance(value, str)
    return hashlib.sha256(value.encode('utf8')).hexdigest()


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def load():
    def unique(items):
        result = {}
        for key, value in items:
            assert key not in result, 'Duplicate published JSON key'
            result[key] = value
        return result

    assert REPORT.is_file(), 'Actual frozen anniversary JSON has not been published'
    raw = REPORT.read_bytes()
    assert len(raw) <= 128 * 1024 * 1024
    report = json.loads(raw, object_pairs_hook=unique,
                        parse_constant=lambda _: (_ for _ in ()).throw(AssertionError('Nonfinite published JSON')))
    return report, hashlib.sha256(raw).hexdigest()


def references():
    assert REFERENCE.is_file(), 'Actual anniversary card references have not been published'
    tree = ast.parse(REFERENCE.read_text(encoding='utf8'))
    matches = [ast.literal_eval(node.value) for node in tree.body
               if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'COMPARISON_REFERENCES'
                       for target in node.targets)]
    assert len(matches) == 1, 'Require exactly one static reference mapping without application imports'
    return matches[0]


def test_actual_study_identity_is_distinct_and_has_six_complete_candidate_records():
    report, _ = load()
    assert report['schema_version'] == 1
    assert report['recorded'] is True and report['example_fixture'] is False
    assert report['record_kind'] == 'actual_model_responses_to_synthetic_cases'
    assert report['test_data'] == 'synthetic'
    assert report['selection_changed'] is False and report['live_tli_contacted'] is False
    assert report['physical_acceptance'] == 'not_run'
    assert report['policy_sha256'] == POLICY_SHA256, 'Do not relabel an earlier study as this anniversary run'
    assert valid_hash(report['source_fingerprint']) and valid_hash(report['corpus_sha256'])
    assert len(report['models']) == 6 and {m['preset_id'] for m in report['models']} == PRESETS
    assert [dimension['id'] for dimension in report['dimensions']] == list(FIELDS)
    assert all(set(dimension['scale']) == {'0', '1', '2'} for dimension in report['dimensions'])
    assert report['provenance']['blind_grade_files'] and report['provenance']['files']
    assert all(valid_hash(value) for value in report['provenance']['blind_grade_files'].values())
    assert all(valid_hash(value) for value in report['provenance']['files'].values())


def test_exact_requests_answers_and_statuses_preserve_null_empty_and_partial_text():
    report, _ = load()
    identities, common_requests = set(), None
    grade_hashes = set(report['provenance']['blind_grade_files'].values())
    for model in report['models']:
        assert model['source_fingerprint'] == report['source_fingerprint']
        cases = model['cases']
        assert len(cases) == 55 and len({c['case_id'] for c in cases}) == 55
        assert Counter(c['partition'] for c in cases) == {
            'production_regression': 15, 'development': 8, 'heldout': 24, 'raw_stress': 8,
        }
        requests = {}
        for case in cases:
            assert isinstance(case['case_id'], str) and case['case_id']
            assert isinstance(case['answer_id'], str) and case['answer_id'] not in identities
            identities.add(case['answer_id'])
            messages = case['supplied_messages']
            assert isinstance(messages, list) and messages
            assert all(isinstance(m, dict) and set(m) == {'role', 'content'}
                       and m['role'] in {'system', 'assistant', 'user'}
                       and isinstance(m['content'], str) for m in messages)
            assert case['question'] == messages[-1]['content']
            assert case['request_sha256'] == sha(json.dumps(messages, sort_keys=True, ensure_ascii=False))
            requests[case['case_id']] = case['request_sha256']
            assert case['answer'] is None or isinstance(case['answer'], str)
            assert case['answer_sha256'] == sha('' if case['answer'] is None else case['answer'])
            assert case['finish_reason'] is None or isinstance(case['finish_reason'], str)
            status = case['response_status']
            assert status in STATUSES
            assert case['request_evidence'] == ('reconstructed_not_sent'
                   if status in {'not_run', 'prepared', 'preparation_failed'} else 'actual_request_hash_verified')
            grade = case['assessment']
            assert grade['grade_sha256'] in grade_hashes
            assert isinstance(grade['reviewer'], str) and grade['reviewer'].strip()
            assert isinstance(grade['notes'], str) and grade['notes'].strip()
            assert isinstance(grade['hard_failures'], list)
            assert all(isinstance(reason, str) and reason.strip() for reason in grade['hard_failures'])
            assert grade['citations_supported'] is None or type(grade['citations_supported']) is bool
            if status == 'response_received':
                # Received empty text is still observed text. Do not strip it,
                # convert it to null, or manufacture a missing-response grade.
                assert isinstance(case['answer'], str)
                assert grade['assessment_status'] == 'assessed'
                assert all(type(grade[field]) is int and grade[field] in (0, 1, 2) for field in FIELDS)
            else:
                # Failed transport can retain exact partial text. Its assessment
                # remains missing; no qualitative hard failure is invented.
                assert grade['assessment_status'] == 'missing_response'
                assert all(grade[field] is None for field in FIELDS)
                assert grade['hard_failures'] == [] and grade['citations_supported'] is None
        if common_requests is None:
            common_requests = requests
        assert requests == common_requests
    assert len(identities) == 330


def test_collection_accounting_counts_prepared_as_subset_and_keeps_observed_statuses():
    report, _ = load()
    for model in report['models']:
        cases, counts = model['cases'], model['collection']
        observed = Counter(case['response_status'] for case in cases)
        expected = {
            'expected': 55, 'missing': 0, 'responses': observed['response_received'],
            'timeouts': sum(c['response_status'] == 'failed' and c['error_type'] == 'TimeoutError' for c in cases),
            'failed': sum(c['response_status'] == 'failed' and c['error_type'] != 'TimeoutError' for c in cases),
            'not_run': observed['not_run'] + observed['prepared'],
            'prepared_not_sent': observed['prepared'], 'preparation_failed': observed['preparation_failed'],
        }
        assert all(type(counts[key]) is int and counts[key] == value for key, value in expected.items())
        assert sum(counts[key] for key in ('responses', 'timeouts', 'failed', 'not_run', 'preparation_failed')) == 55
        assert counts['prepared_not_sent'] <= counts['not_run']
        assert counts['status'] == model['provenance']['collection_entry']['status']
        raw, runtime = model['provenance']['raw_answers'], model['provenance']['runtime']
        if raw is None:
            assert counts['status'] in {'failed', 'artifact_invalid'}
            assert observed == {'not_run': 55}
            assert all(c['answer'] is None and c['finish_reason'] is None for c in cases)
        else:
            assert valid_hash(raw['sha256']) and isinstance(raw['path'], str)
            assert valid_hash(model['provenance']['runtime_manifest']['sha256'])
            assert valid_hash(runtime['sha256']) and valid_hash(model['artifact']['sha256'])
            assert model['artifact']['filename'] and type(model['artifact']['bytes']) is int
            assert model['artifact']['bytes'] > 0


def test_four_dimensions_and_frozen_eligibility_are_recomputed_without_a_combined_score():
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
            assert set(partition['dimension_tallies']) == set(FIELDS)
            for field in FIELDS:
                counts = Counter(row['assessment'][field] for row in rows)
                assert partition['dimension_tallies'][field] == {str(n): counts[n] for n in (0, 1, 2)} | {'not_assessed': counts[None]}
            assert partition['hard_failures'] == [{'case_id': c['case_id'], 'reason': reason}
                                                  for c in rows for reason in c['assessment']['hard_failures']]
            assert partition['invalid_citations'] == [c['case_id'] for c in rows if c['assessment']['citations_supported'] is False]
        primary, heldout = groups['primary'], model['partitions']['heldout']['dimension_tallies']
        expected = {
            'all55_scored_responses': model['collection']['responses'] == 55,
            'zero_primary_hard_failures': not any(c['assessment']['hard_failures'] for c in primary),
            'zero_primary_grounding_or_context_failures': all(c['assessment'][field] != 0
                 for c in primary for field in ('factual_grounding', 'context_handling')),
            'heldout_grounding_at_least22_meets': heldout['factual_grounding']['2'] >= 22,
            'heldout_context_at_least22_meets': heldout['context_handling']['2'] >= 22,
            'heldout_usefulness_at_least18_meets': heldout['useful_next_steps']['2'] >= 18,
            'all_primary_citations_supported': all(c['assessment']['citations_supported'] is not False for c in primary),
        }
        assert model['gate']['checks'] == expected
        assert model['gate']['qualified'] is all(expected.values())
        assert model['gate']['reasons'] == [key.replace('_', ' ') for key, passed in expected.items() if not passed]
        if all(expected.values()):
            qualified.append(model['preset_id'])
    assert report['qualified_presets'] == qualified
    assert report['recommendation']['preset_id'] is None
    assert report['recommendation']['status'] == ('requires_paired_standard_review' if qualified else 'none_qualified')


def test_card_references_bind_only_recorded_artifacts_and_the_exact_anniversary_report():
    report, report_hash = load()
    cards = references()
    recorded = [model for model in report['models'] if model['artifact'] and model['provenance']['runtime']]
    assert isinstance(cards, dict)
    assert set(cards) == {model['artifact']['filename'] for model in recorded}
    for model in recorded:
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
        assert not {'running', 'healthy', 'recommended'}.intersection(value)
        assert value['report_url'] == '/model-comparison-anniversary.html#model-' + model['preset_id']


class PassiveReport(HTMLParser):
    """Parse exact case-local evidence without executing the report or TLI."""
    VOID = {'meta', 'br', 'hr', 'wbr'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids, self.links, self.text, self.stack, self.cases = set(), [], [], [], {}
        self.current, self.case_depth, self.pre, self.pre_depth = None, None, None, None

    def handle_starttag(self, tag, attributes):
        assert tag not in {'script', 'iframe', 'object', 'embed', 'form', 'input', 'img', 'video', 'audio', 'link', 'base', 'svg', 'math'}
        attrs = dict(attributes)
        assert not any(key.startswith('on') for key in attrs)
        assert not {'src', 'srcset', 'ping', 'action', 'formaction'}.intersection(attrs)
        assert not (tag == 'meta' and attrs.get('http-equiv', '').lower() == 'refresh')
        if 'id' in attrs:
            assert attrs['id'] not in self.ids
            self.ids.add(attrs['id'])
        if tag == 'a':
            assert attrs.get('href', '').startswith('#')
            self.links.append(attrs['href'][1:])
        if tag not in self.VOID:
            self.stack.append(tag)
        if tag == 'details' and 'case' in attrs.get('class', '').split():
            assert self.current is None
            self.current, self.case_depth = attrs['id'], len(self.stack)
            self.cases[self.current] = {'text': [], 'pre': []}
        if tag == 'pre' and self.current:
            assert self.pre is None
            self.pre, self.pre_depth = [], len(self.stack)

    def handle_endtag(self, tag):
        assert self.stack and self.stack[-1] == tag, 'Malformed passive report markup'
        if self.pre is not None and len(self.stack) == self.pre_depth:
            self.cases[self.current]['pre'].append(''.join(self.pre))
            self.pre, self.pre_depth = None, None
        if self.current and len(self.stack) == self.case_depth:
            self.current, self.case_depth = None, None
        self.stack.pop()

    def handle_data(self, value):
        self.text.append(value)
        if self.current:
            self.cases[self.current]['text'].append(value)
        if self.pre is not None:
            self.pre.append(value)


def test_passive_html_preserves_exact_case_evidence_and_never_promotes_it_to_markup():
    report, report_hash = load()
    assert PAGE.is_file(), 'Actual inert anniversary report has not been published'
    raw = PAGE.read_text(encoding='utf8')
    page = PassiveReport()
    page.feed(raw)
    page.close()
    assert not page.stack and page.current is None
    assert set(page.links) <= page.ids and len(page.cases) == 330
    visible = ''.join(page.text)
    assert report_hash in visible and report['policy_sha256'] in visible
    assert 'SYNTHETIC PREVIEW' not in visible
    assert 'Content-Security-Policy' in raw and "default-src 'none'" in raw
    assert "base-uri 'none'" in raw and "form-action 'none'" in raw
    for css in re.findall(r'<style\b[^>]*>(.*?)</style\s*>', raw, re.I | re.S):
        assert not re.search(r'url\s*\(|@import', css, re.I), 'Passive report cannot fetch external CSS assets'
    for number, model in enumerate(report['models'], 1):
        assert 'model-' + model['preset_id'] in page.ids
        for position, case in enumerate(model['cases'], 1):
            part = page.cases[f'case-{number}-{position}']
            case_text = ''.join(part['text'])
            assert case['case_id'] in case_text and case['response_status'] in case_text
            assert case['answer_sha256'] in case_text and case['request_sha256'] in case_text
            assert case['assessment']['grade_sha256'] in case_text
            assert all(message['content'] in part['pre'] for message in case['supplied_messages'])
            if case['answer'] is None:
                assert 'No answer recorded. Missing text is not inferred.' in case_text
            else:
                assert case['answer'] in part['pre'], 'Preserve even received empty or failed partial text exactly'
                if case['response_status'] != 'response_received':
                    assert 'retained partial output, not a completed answer' in case_text
            if case['request_evidence'] == 'reconstructed_not_sent':
                assert 'not established as sent to the model' in case_text
            else:
                assert 'recorded sent-request hash matches these exact messages' in case_text
            assert case['assessment']['notes'] in part['pre']
    if not report['qualified_presets']:
        assert 'No validated winner' in visible
