"""Captured-input loading is opt-in, bounded and hash-bound; no inference."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('captured_runner',ROOT/'scripts/evaluate_isolated_model.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

def fixture():
    messages=[{'role':'system','content':'Captured policy.'},{'role':'user','content':'Keep 音楽 literal.'}]
    return {'version':1,'cases':[{'id':'captured-one','purpose':'Preserve exact captured input.','rubric':['Unicode unchanged'],'messages':messages,
        'captured_request_sha256':hashlib.sha256(json.dumps(messages,sort_keys=True,ensure_ascii=False).encode()).hexdigest(),
        'route_lane':'actual_bundled_chat_routes'}]}

class CapturedRequests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'captured.json'
    def tearDown(self):self.temp.cleanup()
    def load(self,value):
        self.path.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
        return runner.prepared_cases(self.path)
    def test_exact_unicode_messages_and_file_hash_preserved(self):
        value=fixture();cases,digest=self.load(value)
        self.assertEqual(cases,value['cases']);self.assertEqual(digest,hashlib.sha256(self.path.read_bytes()).hexdigest())
    def test_changed_message_with_old_hash_fails(self):
        value=fixture();value['cases'][0]['messages'][-1]['content']='Changed'
        with self.assertRaises(ValueError):self.load(value)
    def test_missing_reporting_fields_rejected_before_runtime(self):
        for field in ('purpose','rubric'):
            value=fixture();del value['cases'][0][field]
            with self.assertRaises(ValueError):self.load(value)
    def test_no_duplicate_empty_or_invalid_id_corpus(self):
        for cases in ([],fixture()['cases']*2,[{**fixture()['cases'][0],'id':'../../bad'}]):
            with self.assertRaises(ValueError):self.load({'version':1,'cases':cases})
    def test_no_hidden_preparation_or_multimodal_fields(self):
        for mutation in (lambda v:v['cases'][0].update(preparation={}),
                         lambda v:v['cases'][0].update(production_prompt=True),
                         lambda v:v['cases'][0]['messages'][0].update(tool_call='hidden'),
                         lambda v:v['cases'][0]['messages'][0].update(content=[{'type':'image'}])):
            value=fixture();mutation(value)
            with self.assertRaises(ValueError):self.load(value)
    def test_invalid_envelope_and_byte_count_fail(self):
        for value in ([],None,{'version':2,'cases':fixture()['cases']}):
            with self.assertRaises(ValueError):self.load(value)
        self.path.write_bytes(b' '*(4*1024*1024+1))
        with self.assertRaises(ValueError):runner.prepared_cases(self.path)

if __name__=='__main__':unittest.main()
