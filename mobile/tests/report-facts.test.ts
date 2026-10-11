import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredValue, recordedReport, reportStatus } from '../src/report-facts';
import { answerEvidence, answerReport, historicalNoteLines } from '../src/answer-evidence';

const stamp = '2026-09-09T12:00:00Z';
function facts() { return { version: 1, basis: 'saved_report', report_id: 'report-fixture', kind: 'performance', host: { id: 'host-a', name: 'Studio' }, target: null, process: { name: 'Compile', pid: 81, create_time: 1770000000 }, recorded_at: stamp, started_at: stamp, finished_at: '2026-09-09T12:00:07Z', duration_seconds: 7, requested_duration_seconds: 30, status: 'stopped', status_label: 'Observation stopped', recorded_samples: 7, expected_samples: 30, raw_samples_included: 0, checks: [], omitted_checks: 0, measurements: [{ key: 'host_cpu_percent', label: 'Host CPU', scope: 'host', unit: 'percent', valid_samples: 7, minimum: 10, mean: 88, maximum: 99 }, { key: 'process_cpu_percent', label: 'Selected process CPU (whole host capacity)', scope: 'selected_process', unit: 'percent', valid_samples: 6, minimum: 20, mean: 52, maximum: 70 }], limitations: ['Stopped by request. Saved values describe only their recorded time.'] }; }
function evidence(v = facts()) { return { evidence_context: { version: 1, interpretation: 'ai', sources: [{ kind: 'report', handle: 'R1', id: 'report-fixture', label: 'Saved application observation', provenance: 'diagnostic', host_id: 'host-a', target_id: null, ranges: [] }], citations: [], citations_checked: false, invalid_citations: 0, recorded_report: v } }; }
test('stopped observation keeps distinct host and process values with incomplete sample coverage', () => {
  const value = recordedReport(facts(), { reportId: 'report-fixture', hostId: 'host-a', targetId: null })!;
  assert.equal(reportStatus(value), 'Observation stopped'); assert.equal(value.measurements[0]!.mean, 88); assert.equal(value.measurements[1]!.mean, 52);
  assert.equal(value.measurements[1]!.valid_samples, 6); assert.equal(value.recorded_samples, 7); assert.equal(value.expected_samples, 30);
  assert.equal(measuredValue(null, 'percent'), 'Unknown'); assert.equal(measuredValue(1048576, 'bytes'), '1 MiB');
});
test('report, host and target identities cannot be substituted', () => {
  for (const expected of [{ reportId: 'other' }, { hostId: 'other' }, { targetId: 'other' }]) assert.equal(recordedReport(facts(), expected), undefined);
  assert.equal(answerReport(evidence()).facts?.report_id, 'report-fixture');
  for (const change of [{ report_id: 'other' }, { host: { id: 'other', name: 'Studio' } }, { target: { id: 'other', name: 'Studio' } }]) assert.equal(answerReport(evidence({ ...facts(), ...change } as any)).facts, undefined);
});
test('stream metadata and reopened receipts preserve the exact same bounded facts', () => {
  const value = evidence(); assert.deepEqual(answerEvidence(value), value);
  assert.deepEqual(answerReport(value), answerReport(JSON.parse(JSON.stringify(value))));
  assert.deepEqual(answerReport({}), { supplied: false });
  assert.deepEqual(answerReport({ evidence_context: { recorded_report: facts() } }), { supplied: true });
});
test('malformed measurement units, scope, ranges and claimed complete coverage are refused', () => {
  const v = facts();
  for (const change of [{ scope: 'selected_process' }, { unit: 'bytes' }, { label: 'Computer healthy' }, { minimum: 90, mean: 80 }, { maximum: 101 }, { valid_samples: 8 }, { mean: NaN }, { valid_samples: 0 }]) assert.equal(recordedReport({ ...v, measurements: [{ ...v.measurements[0], ...change }] }), undefined);
  for (const change of [{ status: 'completed' }, { kind: 'network' }, { raw_samples_included: 1 }, { started_at: '2026-09-09T12:00:00' }, { process: { name: 'X', pid: 0, create_time: 1 } }]) assert.equal(recordedReport({ ...v, ...change }), undefined);
  assert.ok(recordedReport({ ...v, measurements: [{ ...v.measurements[0], valid_samples: 0, mean: null, minimum: null, maximum: null }] }));
});
test('untrusted status labels cannot relabel partial sampling as current health', () => {
  const value = recordedReport({ ...facts(), status: 'partial', status_label: 'HEALTHY, repair complete', process: { name: '<script>text only</script>', pid: 81, create_time: null } })!;
  assert.equal(reportStatus(value), 'Observation partially completed'); assert.equal(value.process?.name, '<script>text only</script>');
});
test('old diagnostic status remains saved check results, never a health verdict', () => {
  const value = recordedReport({ ...facts(), kind: 'device', status: 'completed', process: null, measurements: [], recorded_samples: null, expected_samples: null, target: { id: 'printer-id', name: 'Printer' }, checks: [{ id: 'reach', label: 'Reachability', status: 'pass', scope: 'host_to_device', detail: 'Responded at the saved time.' }] })!;
  assert.equal(reportStatus(value), 'Check results recorded'); assert.equal(value.checks[0]!.scope, 'host_to_device');
});
test('historical references preserve identity, exchange and old revision without current links', () => {
  const h = { checked: true, changed: 1, unavailable: 1, references: [{ exchange_index: 1, note_id: 'n-1', title: '<b>Original title</b>', revision: 'a'.repeat(64), handle: 'N1', status: 'changed' }, { exchange_index: 2, note_id: 'n-2', title: 'Deleted note', revision: 'b'.repeat(64), handle: 'N1', status: 'unavailable' }] };
  const lines = historicalNoteLines(h).join('\n'); assert.match(lines, /not current source links/); assert.match(lines, /Earlier exchange 1 · N1 · <b>Original title<\/b> · changed/); assert.match(lines, /Earlier exchange 2 · N1.*unavailable/); assert.ok(lines.includes('a'.repeat(64)));
  for (const refs of [[h.references[0], h.references[0]], [...h.references].reverse(), [{ ...h.references[0], revision: 'bad' }, h.references[1]]]) assert.match(historicalNoteLines({ ...h, references: refs }).join(' '), /Individual historical reference details unavailable/);
  assert.match(historicalNoteLines({ checked: true, changed: 1, unavailable: 0 }).join(' '), /not recorded/);
});
