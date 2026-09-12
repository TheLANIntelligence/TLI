"""Published synthetic evidence must not acquire an unearned passing label."""
import ast
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]


def test_published_reference_is_scored_but_not_certified():
    report=json.loads((ROOT/'frontend/assets/answer-validation.json').read_text(encoding='utf-8'))
    assert report['synthetic'] is True
    assert report['quality_acceptance']=='not_passed'
    assert report['physical_user_acceptance']=='not_run'
    assert report['response_report_sha256']==report['agent_review']['acceptance']['answers_sha256']
    reference_tree=ast.parse((ROOT/'backend/ai/answer_validation.py').read_text(encoding='utf-8'))
    reference=next(ast.literal_eval(node.value) for node in reference_tree.body
                   if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='REFERENCE' for target in node.targets))
    assert reference['response_report_sha256']==report['response_report_sha256']
    assert reference['model_sha256']==report['conditions']['model']['sha256']
    assert reference['runtime_sha256']==report['conditions']['runtime']['sha256']
    assert reference['quality_acceptance']==report['quality_acceptance']
    assert len(report['cases'])==23
    assert all(c['status']=='response_received' for c in report['cases'])
    for case in report['cases']:
        reviewed=next(c for c in report['agent_review']['acceptance']['cases'] if c['id']==case['id'])
        assert hashlib.sha256(case['answer'].encode('utf-8')).hexdigest()==reviewed['answer_sha256']
    html=(ROOT/'frontend/answer-validation.html').read_text(encoding='utf-8')
    assert '<script' not in html and 'quality has not fully passed acceptance' in html
