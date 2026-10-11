// Browser-only, in-memory fixtures. No host, files, devices or AI are accessed.
import { CASE_PROTOCOL, caseBody, draftCase, emptyCase, type CaseLink, type TroubleshootingCase } from './cases';
import { PreviewNotebookError } from './notebook-preview';
import { PREVIEW_COMPUTER, previewCheckOptions } from './guided-checks-preview';
import { CASE_CONTEXT_PROTOCOL, caseLinkKey, casePointer, validCaseRef, type CaseReceipt } from './case-context';
import { PREVIEW_REPORT, PREVIEW_REPORT_FACTS, PREVIEW_REPORT_REVISION, previewReportSource } from './report-preview';
export const PREVIEW_CASE = 'case-' + '1'.padStart(32, '0');
export class PreviewCases {
  private sequence = 1;
  private records: TroubleshootingCase[] = [{ ...emptyCase(), id: PREVIEW_CASE, title: 'Studio printer pauses', symptom: 'Paper-path warning after loading a new stack.', computer: { id: PREVIEW_COMPUTER, name: 'Legato Home', node_id: 'sample-home' }, status: 'open', revision: '1'.padStart(64, '0'), created_at: '2026-09-08T12:00:00Z', updated_at: '2026-09-08T12:00:00Z', steps: [{ id: 'step-one', text: 'Check the paper tray', status: 'tried', outcome: 'Tray label says A4.' }], evidence: [] }];
  private requests = new Map<string, TroubleshootingCase>();
  constructor() { this.records[0]!.evidence.push({ kind: 'report', id: PREVIEW_REPORT.id, revision: PREVIEW_REPORT_REVISION, label: 'Synthetic stopped observation', availability: 'current', linked_at: PREVIEW_REPORT.created_at! }); }
  request(path: string, method: string, body: Record<string, any>) {
    if (!path.startsWith('/api/intelligence/cases')) return;
    const checked_at = new Date().toISOString(), base = { ok: true, protocol: CASE_PROTOCOL, checked_at, actions_performed: false };
    if (path.endsWith('/capabilities')) return { ...base, case_context: CASE_CONTEXT_PROTOCOL, case_report_context: 'tli-case-report-context-v1', max_case_reports: 1, next_check: 'tli-case-next-check-v1' };
    if (path.endsWith('/next-check') && method === 'POST') return { ...base, ...this.nextCheck(body) };
    if (path.endsWith('/context-review') && method === 'POST') return { ...base, case_report_context: 'tli-case-report-context-v1', ...this.context(body) };
    if (path.endsWith('/evidence/review')) {
      if (!['note', 'report', 'chat'].includes(body.kind) || typeof body.id !== 'string') throw new PreviewNotebookError('Sample evidence unavailable.', 404);
      return { ...base, evidence: { kind: body.kind, id: body.id, revision: '1'.padStart(64, '0'), ...(body.kind === 'chat' ? { message_index: body.message_index } : {}), label: `Sample ${body.kind}: ${body.id}` } };
    }
    const url = new URL(path, 'https://preview.invalid'), id = url.pathname.split('/')[4];
    if (method === 'GET' && !id) { const status = url.searchParams.get('status') || 'open', q = (url.searchParams.get('q') || '').toLowerCase(); const items = this.records.filter(c => (status === 'archived' ? c.archived : !c.archived && c.status === status) && `${c.title} ${c.symptom}`.toLowerCase().includes(q)); return { ...base, items, total: items.length }; }
    const original = this.records.find(c => c.id === id);
    if (method === 'GET') { if (!original) throw new PreviewNotebookError('Sample record unavailable.', 404); return { ...base, case: original }; }
    if (method === 'PUT' && (!original || body.expected_revision !== original.revision)) throw new PreviewNotebookError('This record changed. Review the current version before saving.', 409);
    if (method === 'DELETE') { if (!original || url.searchParams.get('expected_revision') !== original.revision) throw new PreviewNotebookError('Review the current record before deletion.', 409); this.records = this.records.filter(c => c !== original); return { ...base, deleted: true, id }; }
    if (method === 'POST' && this.requests.has(body.request_id)) return { ...base, case: this.requests.get(body.request_id), already_saved: true };
    if (/simulate save failure/i.test(body.title || '')) throw new PreviewNotebookError('Sample save failed; previous record retained.', 503);
    if (/simulate conflict/i.test(body.title || '') && original) { original.revision = (++this.sequence).toString(16).padStart(64, '0'); original.updated_at = checked_at; throw new PreviewNotebookError('This record changed. Review the current version before saving.', 409); }
    const validated = caseBody(body as any, original, body.request_id);
    const computer = body.computer_id ? { id: body.computer_id, name: 'Legato Home', node_id: 'sample-home' } : null;
    const next: TroubleshootingCase = { ...draftCase(original || this.records[0]!), ...validated, id: original?.id || `case-${(++this.sequence).toString(16).padStart(32, '0')}`, computer, revision: (++this.sequence).toString(16).padStart(64, '0'), created_at: original?.created_at || checked_at, updated_at: checked_at, evidence: validated.evidence.map((link: CaseLink) => ({ ...link, label: `Sample ${link.kind}: ${link.id}`, linked_at: checked_at, availability: 'current' })) };
    if (original) this.records = this.records.map(c => c === original ? next : c); else { this.records.unshift(next); this.requests.set(body.request_id, next); }
    return { ...base, case: next, already_saved: false };
  }
  nextCheck(body: Record<string, any>) {
    const context = this.context(body)!;
    const row = this.records.find(c => c.id === body.case_ref.id)!;
    const ref = casePointer(body.case_ref), options = row.computer ? previewCheckOptions(row.computer.id) : null;
    const option = options?.options.find(o => o.available && (o.kind === 'system' || o.kind === 'peer_system'));
    const suggest = option && row.status === 'open' && !row.archived && /slow|memory|cpu/i.test(row.symptom);
    return { ...context, next_check_protocol: 'tli-case-next-check-v1', guidance: { version: 1, status: suggest ? 'suggested' : 'unavailable', selection: { ...ref, report_refs: ref.report_refs || [] }, selection_sha256: 'f'.repeat(64),
      known: [{ id: 'symptom', label: 'User-recorded symptom', text: row.symptom, source: 'C1', recorded_at: row.updated_at }],
      missing: [{ id: 'current', text: 'No new observation was taken. This preview contains synthetic saved details only.' }],
      steps: ref.step_ids.map(id => row.steps.find(s => s.id === id)!), limitations: ['Synthetic rule-based preview only. No AI, diagnosis or device action.', 'Planned and skipped steps are not attempts. Saved outcomes do not prove current health.'],
      check_options: options, suggestion: suggest ? { option_id: option.id, rule_id: 'synthetic_resources', rationale: 'Review one available resource observation for the saved responsiveness symptom. This cannot establish a cause.' } : null } };
  }
  context(body: Record<string, any>) {
    const ref = body.case_ref; if (!ref) return undefined;
    if (!validCaseRef(ref) || ['note_refs', 'documents', 'image_b64', 'target_id', 'diagnostic_id'].some(key => Array.isArray(body[key]) ? body[key].length : body[key])) throw new PreviewNotebookError('Sample cases require a standalone reviewed question.', 422);
    const row = this.records.find(c => c.id === ref.id); if (!row) throw new PreviewNotebookError('Sample case unavailable.', 404);
    if (row.revision !== ref.revision || ref.step_ids.some(id => !row.steps.some(s => s.id === id)) || ref.evidence_refs.some(p => !row.evidence.some(l => caseLinkKey(l) === caseLinkKey(p)))) throw new PreviewNotebookError('This sample case changed. Review it again; nothing was sent to AI.', 409);
    const case_context: CaseReceipt = { schema_version: 1, id: row.id, revision: row.revision, title: row.title, updated_at: row.updated_at, computer_id: row.computer?.id || null, status: row.status, archived: row.archived, steps: ref.step_ids.map(id => ({ id, status: row.steps.find(s => s.id === id)!.status })), omitted_step_count: row.steps.length - ref.step_ids.length, resolution_included: ref.include_resolution, evidence_links: ref.evidence_refs.map(p => row.evidence.find(l => caseLinkKey(l) === caseLinkKey(p))!), omitted_link_count: row.evidence.length - ref.evidence_refs.length, linked_bodies_included: false, actions_performed: false };
    const evidence_context: Record<string, any> = { version: 1, interpretation: 'backend', citations_checked: true, citations: [{ handle: 'C1', reference: '[C1]' }], invalid_citations: 0, sources: [{ handle: 'C1', kind: 'case', id: row.id, revision: row.revision, label: row.title, provenance: 'user_case', saved_at: row.updated_at, ranges: [] }] };
    if (ref.report_refs?.length) {
      const p = ref.report_refs[0]!;
      if (p.id !== PREVIEW_REPORT.id || p.revision !== PREVIEW_REPORT_REVISION) throw new PreviewNotebookError('Sample report revision is unavailable.', 409);
      case_context.included_reports = [{ id: p.id, revision: p.revision, handle: 'R1', host_id: 'sample-home', target_id: null, recorded_at: PREVIEW_REPORT.created_at! }];
      evidence_context.sources.push(previewReportSource()); evidence_context.recorded_report = PREVIEW_REPORT_FACTS;
    }
    return { case_context, evidence_context };
  }
}
