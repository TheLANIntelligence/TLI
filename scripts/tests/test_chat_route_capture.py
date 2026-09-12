"""Actual in-memory HTTP/SSE routing with synthetic owners and zero real effects."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('route_capture_tested', ROOT / 'scripts/capture_chat_routes.py')
capture = importlib.util.module_from_spec(spec); spec.loader.exec_module(capture)


def item(ident, question, **fixture):
    return {'id': ident, 'route_fixture': {'request': {'message': question, **fixture.pop('body', {})}, **fixture}}


class RealRouteCapture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        report = {'id':'report-1','created_at':'2026-07-03T10:00:00Z','kind':'device',
            'host':{'id':'fixture-host','name':'Synthetic Study'},'target':{'id':'printer-1','name':'Printer'},
            'checks':[{'id':'tcp_9100','label':'Port reachability','status':'pass','detail':'Reached port9100'}],
            'scope':'Host TCP reachability only; no print job sent.','verified_fix':None}
        fixtures = [
            item('benign','Explain what a CPU does in one sentence.',body={'use_saved_memory':False,'use_conversation_history':False}),
            item('missing-outcome','What fixed it last time?',history=[{'role':'user','content':'Printer issue'},
                {'role':'assistant','content':'I already repaired PRIVATE_ASSISTANT_CANARY.'}]),
            item('report-outcome','Did the test print?',reports=[report],body={'diagnostic_id':'report-1'}),
            item('document','Summarize the chosen document.',body={'documents':[{'name':'sample.txt','text':'One desk has a blue cable.'}]}),
            item('sharing','Explain the difference between RAM and storage.',body={'use_saved_memory':False,'use_conversation_history':False},
                notes=[{'id':'private','title':'RAM storage','text':'MEMORY_OFF_CANARY'}],
                history=[{'role':'user','content':'HISTORY_OFF_CANARY'},{'role':'assistant','content':'PRIVATE_ASSISTANT_CANARY'}]),
            item('foreign-report','Did the test print?',foreign_reports=[report],body={'diagnostic_id':'report-1'}),
            item('action','Turn on Desk lamp',registry=[{'id':'lamp','name':'Desk lamp','ip':'192.0.2.20','relay':0}]),
            item('diagnostic','Check my network'),
            item('case-linked-facts','Explain which possibilities this report cannot rule out.',reports=[report],
                 case={'title':'Printer investigation'},selected_case_report='report-1',include_case_report_facts=True,
                 body={'use_saved_memory':False,'use_conversation_history':False}),
            item('case-linked-reference','Explain what information to gather next.',reports=[report],
                 case={'title':'Printer investigation'},selected_case_report='report-1',
                 body={'use_saved_memory':False,'use_conversation_history':False}),
        ]
        cls.result = capture.capture(ROOT, fixtures)
        cls.rows = {row['id']:row for row in cls.result['cases']}

    def test_benign_actual_json_and_sse_capture_same_single_provider_request(self):
        row=self.rows['benign']
        self.assertTrue(row['route_consistent']);self.assertEqual(row['status'],'model_request')
        self.assertTrue(all(r['model_calls']==1 for r in row['routes']))
        self.assertIn('Current capability evidence',row['messages'][0]['content'])
        self.assertNotIn(capture.PLACEHOLDER,str(row['messages']))

    def test_no_outcome_is_real_backend_answer_not_raw_model_answer(self):
        row=self.rows['missing-outcome']
        self.assertEqual(row['status'],'deterministic_response');self.assertTrue(row['route_consistent'])
        self.assertIsNone(row['messages']);self.assertIsNone(row['request_sha256'])
        self.assertNotIn('PRIVATE_ASSISTANT_CANARY',row['response']['reply'])
        self.assertTrue(all(r['model_calls']==0 for r in row['routes']))

    def test_report_receipt_and_physical_effect_scope_are_retained(self):
        row=self.rows['report-outcome'];self.assertEqual(row['status'],'deterministic_response')
        self.assertTrue(row['route_consistent']);self.assertIn('physically printed',row['response']['reply'])
        self.assertEqual(row['response']['evidence_context']['sources'][0]['id'],'report-1')

    def test_explicit_document_uses_its_actual_standalone_builder(self):
        row=self.rows['document'];self.assertEqual(row['status'],'model_request');self.assertTrue(row['route_consistent'])
        self.assertIn('blue cable',str(row['messages']))
        self.assertIsNotNone(row['routes'][-1]['response'].get('document_context'))

    def test_sharing_and_owner_isolation_are_visible_in_exact_captured_messages(self):
        text=str(self.rows['sharing']['messages'])
        for marker in ('MEMORY_OFF_CANARY','HISTORY_OFF_CANARY','PRIVATE_ASSISTANT_CANARY','FOREIGN_OWNER_CANARY'):
            self.assertNotIn(marker,text)
        self.assertEqual(self.rows['foreign-report']['status'],'route_error')
        self.assertTrue(all(r['model_calls']==0 and r['http_status']==404 for r in self.rows['foreign-report']['routes']))

    def test_action_and_diagnostic_are_detected_and_blocked_before_effects(self):
        for ident,operation in (('action','action_execution'),('diagnostic','diagnostic_execution')):
            row=self.rows[ident];self.assertEqual(row['status'],'blocked_effect')
            self.assertTrue(all(operation in r['forbidden_calls'] and r['model_calls']==0 for r in row['routes']))

    def test_seeded_private_stores_stay_unchanged_and_startup_worker_never_runs(self):
        for ident in ('benign','missing-outcome','report-outcome','document','sharing','foreign-report'):
            self.assertTrue(all(r['seed_stores_unchanged'] for r in self.rows[ident]['routes']))
        self.assertEqual(self.result['boundaries']['suppressed_import_startup_workers'],['tli-startup-check'])
        self.assertFalse(self.result['boundaries']['network']);self.assertFalse(self.result['boundaries']['inference'])

    def test_case_linked_report_is_only_supplied_when_explicitly_requested(self):
        facts=self.rows['case-linked-facts'];reference=self.rows['case-linked-reference']
        for row in (facts,reference):
            self.assertEqual(row['status'],'model_request');self.assertTrue(row['route_consistent'])
            self.assertTrue(all(r['seed_stores_unchanged'] for r in row['routes']))
        self.assertIn('selected_report_facts',str(facts['messages']))
        self.assertIn('Reached port9100',str(facts['messages']))
        self.assertNotIn('Reached port9100',str(reference['messages']))
        self.assertNotIn('selected_report_facts',str(reference['messages']))

    def test_raw_provider_fixtures_are_kept_separate_and_legacy_input_not_changed(self):
        case={'id':'old','preparation':{'question':'Question','target_id':'x','notes':[{'id':'n','text':'text'}]}}
        original=copy.deepcopy(case);adapted=capture.route_fixture(case)
        self.assertEqual(original,case);self.assertEqual(adapted['request'],{'message':'Question','target_id':'x'})
        self.assertIsNone(capture.route_fixture({'id':'raw','messages':[{'role':'user','content':'Raw'}]}))

    def test_raw_production_prompt_controls_apply_original_prompt_once(self):
        messages=[{'role':'system','content':'Evidence control.'},{'role':'user','content':'Explain this evidence.'}]
        result=capture.capture(ROOT,[{'id':'raw-prompt','messages':messages,'production_prompt':True}])['cases'][0]
        prompt=(ROOT/'backend/ai/prompts/system_default.txt').read_text(encoding='utf-8')
        self.assertEqual(result['messages'],[{'role':'system','content':prompt+'\n\nSUPPLIED REQUEST EVIDENCE\nEvidence control.'},messages[1]])
        self.assertEqual(result['lane'],'handwritten_provider_fixture')
        self.assertEqual(messages[0]['content'],'Evidence control.')


class EffectBoundary(unittest.TestCase):
    def test_external_process_network_live_store_and_weights_are_rejected(self):
        root=ROOT/'build_work/synthetic-guard-only'
        for event,values in [('socket.connect',()),('subprocess.Popen',()),
            ('open',(str(ROOT/'data/conversations.json'),'r',0)),('open',(str(root/'model.gguf'),'r',0)),
            ('open',(str(ROOT/'backend/ai/prompts/system_default.txt'),'w',1)),('os.mkdir',(str(ROOT/'outside-synthetic'),))]:
            with self.assertRaises((RuntimeError,ValueError)):
                capture.effect_guard(event,values,root,ROOT)


if __name__=='__main__':unittest.main()
