import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCheckOptions, previewCheckReport, PREVIEW_COMPUTER } from '../src/guided-checks-preview';
import { checkOptions, checkRequest, checkReport } from '../src/guided-checks';
import { PreviewCases, PREVIEW_CASE } from '../src/cases-preview';
import { validateCase, draftCase, caseBody } from '../src/cases';
test('preview check choices use inventory identity and round-trip real host/scope validators', () => {
  const options = checkOptions(previewCheckOptions(PREVIEW_COMPUTER), PREVIEW_COMPUTER);
  for (const option of options.options.filter(o => o.kind !== 'performance')) for (const internet of [false, true]) {
    const request = checkRequest(option, internet, 'synthetic-request');
    assert.equal(request.expected_host_id, 'sample-home'); assert.equal(request.target_id, null);
    const result = checkReport(previewCheckReport(request, 1), request); assert.equal(result.host?.id, 'sample-home');
  }
  assert.ok(previewCheckOptions('sample-home').options.every(o => !o.available));
  assert.ok(previewCheckOptions('node-remote').options.every(o => !o.available));
});
test('preview conflict changes saved revision but retains original data for current-version review', () => {
  const store = new PreviewCases(), route = '/api/intelligence/cases/' + PREVIEW_CASE;
  const original = validateCase(structuredClone(store.request(route, 'GET', {}))); assert.equal(original.computer?.id, PREVIEW_COMPUTER);
  const draft = { ...draftCase(original), title: 'simulate conflict' };
  assert.throws(() => store.request(route, 'PUT', caseBody(draft, original, 'synthetic-save')), /record changed/);
  const current = validateCase(store.request(route, 'GET', {})); assert.notEqual(current.revision, original.revision); assert.equal(current.title, original.title); assert.deepEqual(current.evidence, original.evidence);
});
