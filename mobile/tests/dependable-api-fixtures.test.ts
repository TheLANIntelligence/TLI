import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { casePointer, confirmCaseReceipt } from '../src/case-context';
import { answerReport } from '../src/answer-evidence';
import { checkOptions, checkReport, checkRequest } from '../src/guided-checks';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
test('actual isolated case-review handler envelope binds exact source identities and bounded facts', () => {
  const f = fixture('case-report-preview'); assert.equal(f.synthetic, true);
  const ref = casePointer(f.request.case_ref); confirmCaseReceipt(ref, f.response.case_context, f.response.evidence_context);
  assert.equal(answerReport(f.response).facts?.report_id, ref.report_refs![0]!.id);
});
test('actual isolated peer options produce exact peer request and accept peer-owned report without host fallback', () => {
  const f = fixture('peer-guided-report'); assert.equal(f.synthetic, true);
  const options = checkOptions(f.options, f.options.computer_id), peer = options.options.find(o => o.kind === 'peer_system')!;
  assert.equal(options.options.length, 5); assert.notEqual(peer.execution_host.id, options.host.id); assert.equal(peer.measured_target.id, options.computer_id);
  const request = checkRequest(peer, false, f.request.request_id); assert.deepEqual(request, f.request);
  const report = checkReport(f.response, request, peer); assert.equal(report.host?.id, 'fixture-peer'); assert.equal(report.kind, 'system');
  for (const replacement of [{ ...f.response, host: options.host }, { ...f.response, target: options.host }, { ...f.response, internet_checks: true }, { ...f.response, peer_observation: { ...f.response.peer_observation, observed_at: '2020-01-01T00:00:00Z' } }, { ...f.response, execution: { ...f.response.execution, identity_fingerprint: 'other' } }]) assert.throws(() => checkReport(replacement, request, peer));
  assert.throws(() => checkReport(f.response, request));
});
test('peer observations are explicit, unavailable peers stay unavailable, and ordinary host scope remains local', () => {
  const f = fixture('peer-guided-report'), changed = structuredClone(f.options); const p = changed.options.find((o: any) => o.kind === 'peer_system');
  p.available = false; delete p.execution_host.identity_fingerprint; const options = checkOptions(changed, changed.computer_id); assert.throws(() => checkRequest(options.options.find(o => o.kind === 'peer_system')!, false, 'new'));
  p.available = true; assert.throws(() => checkOptions(changed, changed.computer_id));
  p.execution_host = changed.host; assert.throws(() => checkOptions(changed, changed.computer_id));
});

test('partial peer observations preserve unknown measurements and verify declared coverage without rejecting legacy complete reports', () => {
  const f = fixture('peer-guided-report'), peer = checkOptions(f.options, f.options.computer_id).options.find(o => o.kind === 'peer_system')!;
  const request = checkRequest(peer, false, f.request.request_id);
  f.response.peer_observation.facts.ram_percent = null;
  f.response.peer_observation.coverage = { complete: false, known_metrics: 6, total_metrics: 7 };
  assert.equal((checkReport(f.response, request, peer) as any).peer_observation.facts.ram_percent, null);
  for (const coverage of [undefined, { complete: true, known_metrics: 6, total_metrics: 7 }, { complete: false, known_metrics: 7, total_metrics: 7 }, { complete: false, known_metrics: 6, total_metrics: 8 }]) assert.throws(() => checkReport({ ...f.response, peer_observation: { ...f.response.peer_observation, coverage } }, request, peer));
  f.response.peer_observation.facts.ram_percent = -1; assert.throws(() => checkReport(f.response, request, peer));
  f.response.peer_observation.facts.ram_percent = undefined; assert.throws(() => checkReport(f.response, request, peer));
});
