import test from 'node:test';
import assert from 'node:assert/strict';
import { answerEvidence, documentCoverage, evidenceLines, evidenceSources, timingText, validSourceRef } from '../src/answer-evidence';
const revision = 'a'.repeat(64), checked_at = '2026-09-08T12:00:00Z';
test('live and historical receipts preserve independent server facts and valid saved pointers', () => {
  const source_ref = { conversation_id: 'saved', message_index: 1, revision };
  const raw = { source_ref, user_source_ref: { ...source_ref, message_index: 0 }, memory_context: { use_saved_memory: false, status: 'disabled', notes: [], omitted_for_budget: 0 }, conversation_context: { status: 'included', included_messages: 2, included_exchanges: 1, omitted_messages: 0, character_budget: 2000 } };
  assert.deepEqual(answerEvidence(raw), raw); assert.deepEqual(evidenceLines(JSON.parse(JSON.stringify(raw))), evidenceLines(raw));
  assert.match(evidenceLines(raw)[0]!, /off.*Earlier conversation/); assert.match(evidenceLines(raw)[1]!, /2 messages/);
  assert.deepEqual(answerEvidence({ source_ref: { ...source_ref, revision: 'bad' } }), {});
});
test('missing and malformed receipts never claim no notes or current observations', () => {
  assert.deepEqual(evidenceLines({}), []);
  assert.deepEqual(evidenceLines({ memory_context: {} }), ['Saved-note recall details unavailable.']);
  for (const memory of [{ use_saved_memory: false, status: 'included', notes: [], omitted_for_budget: 0 }, { use_saved_memory: true, status: 'none', notes: [{ id: 'x', title: 'x', revision }], omitted_for_budget: 0 }]) assert.match(evidenceLines({ memory_context: memory })[0]!, /unavailable/);
  assert.match(evidenceLines({ observation_context: { status: 'current' } })[0]!, /unavailable/);
});
test('observations are explicitly historical and identify the actual host and source', () => {
  const lines = evidenceLines({ observation_context: { schema_version: 1, topic: 'cpu', status: 'stale', host: { id: 'desk-id', name: 'Desk' }, resource: 'CPU', source: '/system/status', coverage: 'CPU only; no device actions.', observed_at: checked_at, checked_at } });
  assert.match(lines[0]!, /Desk \(desk-id\).*stale when answered/); assert.match(lines[0]!, /CPU only/);
});
test('document evidence distinguishes full, excerpts, omitted and legacy', () => {
  const doc = { name: 'Setup.md', sha256: revision, line_count: 10, chars: 300 };
  assert.match(documentCoverage(doc), /No coverage breakdown/);
  assert.match(documentCoverage({ ...doc, coverage: { mode: 'excerpts', selection: 'question_terms', ranges: [{ start: 4, end: 6 }], included_lines: 3, omitted_lines: 7 } }), /3 lines included.*7 omitted.*4–6/);
  assert.match(documentCoverage({ ...doc, coverage: { mode: 'full', selection: 'full', ranges: [{ start: 1, end: 10 }], included_lines: 10, omitted_lines: 0 } }), /10 lines included/);
  assert.match(documentCoverage({ ...doc, coverage: { mode: 'omitted', selection: 'none', ranges: [], included_lines: 0, omitted_lines: 10 } }), /0 lines included/);
});
test('malformed, overlapping or misleading document coverage is refused', () => {
  for (const ranges of [[{ start: 0, end: 2 }], [{ start: 1, end: 4 }, { start: 4, end: 5 }], [{ start: 9, end: 20 }]]) assert.match(documentCoverage({ line_count: 10, coverage: { mode: 'excerpts', selection: 'question_terms', ranges, included_lines: 3, omitted_lines: 7 } }), /unavailable/);
  assert.match(documentCoverage({ line_count: 10, coverage: { mode: 'full', selection: 'full', ranges: [{ start: 1, end: 3 }], included_lines: 3, omitted_lines: 7 } }), /unavailable/);
});
test('budget receipt is explicitly an estimate and rejects impossible fit', () => {
  const input_budget = { version: 1, provider: 'bundled', estimation: 'heuristic', capacity_status: 'configured', input_characters: 1000, character_limit: 12000, estimated_input_tokens: 500, reserved_output_tokens: 1000, checked_at, context_tokens: 2048, fit: 'estimated', capacity_source: 'owned_runtime_launch' };
  assert.match(evidenceLines({ input_budget })[0]!, /fit estimated.*not an answer-quality/);
  assert.match(evidenceLines({ input_budget: { ...input_budget, context_tokens: 100 } })[0]!, /unavailable/);
});
test('phone timing is bounded to observed request and missing history timing stays absent', () => {
  assert.equal(timingText(), undefined); assert.match(timingText({ elapsed_ms: 2500, first_text_ms: 1200, outcome: 'interrupted' })!, /interrupted.*2.5s on this phone.*first text 1.2s/);
  assert.equal(timingText({ elapsed_ms: -1, outcome: 'complete' }), undefined);
  assert.equal(validSourceRef({ conversation_id: 'x', message_index: -1, revision }), false);
});


test('final source identities preserve provenance and cannot authorize invented references', () => {
  const source={handle:'N1',kind:'note',id:'note-fixture',label:'Printer fix',revision:'a'.repeat(64),provenance:'chat_ai',ranges:[]};
  const evidence={version:1,interpretation:'ai',sources:[source],citations_checked:true,citations:[{reference:'[N1]',handle:'N1'}],invalid_citations:1,historical_notes:{checked:true,changed:1,unavailable:1}};
  const value={evidence_context:evidence,conversation_context:{status:'disabled',use_conversation_history:false,included_messages:0,included_exchanges:0,omitted_messages:0,character_budget:12000}};
  assert.deepEqual(answerEvidence(value),value);
  assert.match(evidenceLines(value).join(' '),/Earlier conversation was off.*AI interpretation.*unconfirmed.*1 could not be verified.*1 changed, 1 unavailable/);
  assert.equal(evidenceSources(value)[0]!.id,'note-fixture');
  const bad={evidence_context:{...evidence,citations:[{reference:'[N9]',handle:'N1'}]}};
  assert.equal(evidenceSources(bad).length,0);assert.match(evidenceLines(bad).join(' '),/could not be checked/);
});

test('document citation identity cannot bridge omitted text or manufacture persisted contents', () => {
  const evidence={version:1,interpretation:'ai',sources:[{handle:'D1',kind:'document',id:'a'.repeat(64),revision:'a'.repeat(64),label:'manual.txt',provenance:'selected_document',ranges:[{start:1,end:3},{start:8,end:9}]}],citations_checked:true,citations:[{reference:'[manual.txt:L2-L8]',handle:'D1'}],invalid_citations:0};
  assert.match(evidenceLines({evidence_context:evidence})[0]!,/could not be checked/);
  const pending={...evidence,citations_checked:false,citations:[]};
  assert.match(evidenceLines({evidence_context:pending}).join(' '),/Reselect the matching file.*not been checked/);
});
