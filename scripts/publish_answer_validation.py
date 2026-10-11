"""Publish synthetic, scored reference results as an inert local help page."""
import argparse
import hashlib
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIMENSIONS = ('factual_grounding', 'useful_next_steps', 'context_handling', 'truthful_action_claims')


def publish(directory):
    raw = (directory / 'answers.json').read_bytes()
    answers = json.loads(raw)
    manifest = json.loads((directory / 'runtime-manifest.json').read_text(encoding='utf-8'))
    review = json.loads((directory / 'agent-review.json').read_text(encoding='utf-8'))
    scores = {c['id']:([c['assessment'][d] for d in DIMENSIONS],c['assessment']['rationale']) for c in review['acceptance']['cases']}
    reviewed_cases = {c['id']:c for c in review['acceptance']['cases']}
    if len(scores) != len(review['acceptance']['cases']) or len({c['id'] for c in answers['cases']}) != len(answers['cases']):
        raise ValueError('Duplicate review or answer identities.')
    if manifest['status'] != 'responses_collected' or not manifest['child_stopped'] or manifest['answer_report_sha256'] != hashlib.sha256(raw).hexdigest():
        raise ValueError('Reference responses must match a completed, stopped isolated run.')
    if (review['acceptance']['answers_sha256'] != hashlib.sha256(raw).hexdigest()
            or review['acceptance']['source_sha256'] != answers['source']['sha256']
            or review['acceptance']['corpus_sha256'] != answers['corpus_sha256']):
        raise ValueError('Agent review must identify the same answers, source and corpus.')
    if set(scores) != {c['id'] for c in answers['cases']}:
        raise ValueError('Every case requires a distinct agent assessment.')
    cases = []
    for case in answers['cases']:
        if reviewed_cases[case['id']]['answer_sha256'] != hashlib.sha256(case.get('answer','').encode('utf-8')).hexdigest():
            raise ValueError('An answer does not match its reviewed text.')
        values, note = scores[case['id']]
        if len(values) != 4 or any(type(value) is not int or value not in (0, 1, 2) for value in values):
            raise ValueError('Invalid rubric score.')
        cases.append({**case, 'agent_assessment': {'reviewer':'Codex independent reviewing agent',
            **dict(zip(DIMENSIONS, values)), 'notes':note}, 'physical_user_acceptance':'not_run'})
    record = {'schema_version':1, 'synthetic':True, 'status':'quality_limitations_found',
        'quality_acceptance':'not_passed', 'physical_user_acceptance':'not_run',
        'scale':{'0':'Failed rubric', '1':'Limited', '2':'Meets rubric'},
        'conditions':{k:manifest[k] for k in ('created_at','execution_mode','context_tokens','threads','model','runtime','resources')},
        'response_report_sha256':hashlib.sha256(raw).hexdigest(),
        'corpus_sha256':answers['corpus_sha256'], 'source':answers['source'],
        'automated_checks':'Preparation assertions and mechanical flags are separate from agent answer assessment.',
        'agent_review':review, 'cases':cases}
    target = ROOT / 'frontend/assets/answer-validation.json'
    target.write_text(json.dumps(record,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    rows=[]
    for case in cases:
        grade=case['agent_assessment']
        rows.append('<tr><th scope="row">'+html.escape(case['id'])+'</th>'+''.join(f'<td>{grade[key]}</td>' for key in DIMENSIONS)+'</tr>')
        rows.append('<tr><td colspan="5"><details><summary>Answer, evidence and assessment</summary><p>'+html.escape(case['purpose'])+'</p><p>Input: '+html.escape(case['input_source'])+'</p><blockquote>'+html.escape(case.get('answer','No usable response'))+'</blockquote><p>'+html.escape(grade['notes'])+'</p><p>Mechanical flags: '+html.escape('; '.join(case.get('flags',[])) or 'None. Absence of a flag is not an accuracy claim.')+'</p></details></td></tr>')
    page='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>TLI answer validation</title><style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#f4f7f3;color:#193d31;font:16px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:40px 22px}h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.1;letter-spacing:-.04em}a{color:#08694e;text-underline-offset:4px}.notice{border:1px solid #b9cfc2;border-radius:14px;background:#fff;padding:24px;margin:28px 0}table{border-collapse:collapse;width:100%;font-size:.88rem}td,th{text-align:left;padding:12px 8px;border-bottom:1px solid #b9cfc2;overflow-wrap:anywhere}th{font-weight:600}details summary{cursor:pointer}blockquote{white-space:pre-wrap;margin:16px 0;padding:18px;border-left:3px solid #237858;background:#e7f1e9;overflow-wrap:anywhere}code{overflow-wrap:anywhere}a:focus-visible,summary:focus-visible{outline:3px solid #237858;outline-offset:4px}.table-wrap{overflow:auto}footer{font-size:.85rem;padding-top:25px}@media(prefers-color-scheme:dark){body{background:#111e17;color:#e0eee4}a{color:#8de1b1}.notice{background:#192d20;border-color:#547760}td,th{border-color:#547760}blockquote{background:#213929}}@media(max-width:500px){main{padding:24px 12px}table{font-size:.73rem}td,th{padding:9px 4px}.notice{padding:18px}}
    </style></head><body><main><a href="/">← Back to TLI</a><h1>How useful are the answers?</h1><p>Real responses from the installed Standard Qwen artifact, evaluated separately from live TLI with synthetic information.</p>
    <div class="notice"><strong>Limitations found. Answer quality has not fully passed acceptance.</strong><p>The model can use corrected notes and extract a documented fix, but still makes factual errors, mishandles some source citations and can overstate what a historical note proves. Improvements to individual answers did not make the full corpus pass. Review its advice. These results do not certify your installed copy or future answers.</p><p>Automated preparation checks, agent scoring and physical user acceptance are different checks. Physical user acceptance has not been run. No live model selection, household data or device action was used in this evaluation.</p></div>
    <p>Windows CPU · 4 threads · 4096-token context · up to 384 output tokens · temperature 0 · 60-second request limit. One installed Qwen2.5-3B-Instruct Q4_K_M artifact; other presets remain unevaluated.</p><p>Scores are separate: <strong>0 = failed, 1 = limited, 2 = meets the case rubric.</strong> They are agent assessments, not a measured overall accuracy percentage. Handwritten stress fixtures are labeled separately from requests prepared by current TLI code.</p>
    <div class="table-wrap"><table><thead><tr><th>Case</th><th>Grounding</th><th>Next step</th><th>Context</th><th>Action claims</th></tr></thead><tbody>'''+''.join(rows)+'''</tbody></table></div><footer><a href="/assets/answer-validation.json">Complete synthetic responses, scores, source identity and artifact hashes</a><p>Recorded September 8, 2026. Classic appearance and normal model selection do not change this reference evaluation.</p></footer></main></body></html>'''
    (ROOT / 'frontend/answer-validation.html').write_text(page,encoding='utf-8')
    print(json.dumps({'cases':len(cases),'report_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'raw_answers_sha256':hashlib.sha256(raw).hexdigest()}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    publish(parser.parse_args().directory.resolve(strict=True))
