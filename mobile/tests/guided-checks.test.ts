import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOptions, checkReport, checkRequest, type CheckOption } from '../src/guided-checks';
const host = { id: 'host', name: 'Study' }, peer = { id: 'peer', name: 'Study' };
const option: CheckOption = { id: 'network', kind: 'network', title: 'Host network', detail: 'Host only', available: true, reason: '', execution_host: host, measured_target: host, target_id: null, internet: false, scope_revision: 'a'.repeat(64), internet_scope_revision: 'b'.repeat(64), internet_detail: '1.1.1.1:443; example.com' };
const options = () => ({ ok: true, protocol: 'tli-guided-checks-v1', checked_at: '2026-09-08T12:00:00Z', host, computer_id: host.id, options: [option], actions_performed: false });
test('reviewed checks retain exact host identity, explicit internet choice and stable request ID', () => {
  const reviewed = checkOptions(options(), 'host');
  assert.ok(reviewed.options[0]);
  const local = checkRequest(reviewed.options[0], false, 'same');
  assert.equal(local.expected_host_id, 'host'); assert.equal(local.expected_scope, 'a'.repeat(64)); assert.equal(local.internet, false);
  assert.equal(checkRequest(option, true, 'same').expected_scope, 'b'.repeat(64));
  assert.equal(checkRequest(option, true, 'same').request_id, 'same');
});
test('old hosts, malformed choices, changed targets and unavailable checks fail closed', () => {
  for (const v of [{}, { ...options(), actions_performed: true }, { ...options(), options: [] }, { ...options(), options: [option, option] }, { ...options(), computer_id: 'peer' }, { ...options(), options: [{ ...option, execution_host: peer }] }]) assert.throws(() => checkOptions(v, 'host'));
  assert.throws(() => checkRequest({ ...option, available: false }, false, 'x'));
  assert.throws(() => checkRequest({ ...option, kind: 'performance' }, false, 'x'));
  assert.throws(() => checkRequest(option, true, ''));
  assert.throws(() => checkOptions({ ...options(), options: [{ ...option, measured_target: peer }] }, 'host'));
});
test('reports must match the requested host and target; zero values remain valid observations', () => {
  const request = checkRequest(option, false, 'once');
  const report = { id: 'r1', kind: 'network', host, target: null, internet_checks: false, created_at: '2026-09-08T12:00:00Z', scope: 'Host network only', checks: [{ id: 'tcp', label: 'Gateway', status: 'unavailable', detail: 'No usable sample' }] };
  assert.equal(checkReport(report, request).id, 'r1');
  for (const v of [{ ...report, host: peer }, { ...report, target: peer }, { ...report, internet_checks: true }, { ...report, checks: null }, { ...report, checks: [{ ...report.checks[0], status: 'healthy' }] }]) assert.throws(() => checkReport(v, request));
});
