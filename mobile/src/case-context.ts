import type { Client } from './client';
import type { ChatContext } from './types';
import { CASE_PROTOCOL, linkPointer, validateCase, type CaseLink, type TroubleshootingCase } from './cases';
import { recordedReport, type RecordedReport } from './report-facts';

export const CASE_CONTEXT_PROTOCOL = 'tli-case-context-v1';
export type CaseRef = { id: string; revision: string; step_ids: string[]; include_resolution: boolean; evidence_refs: ReturnType<typeof linkPointer>[]; report_refs?: Array<{ kind: 'report'; id: string; revision: string }> };
export type SelectedCase = { title: string; updated_at: string; ref: CaseRef };
export type CaseReceipt = { schema_version: 1; id: string; revision: string; title: string; updated_at: string; computer_id: string | null; status: 'open' | 'resolved'; archived: boolean; steps: { id: string; status: 'planned' | 'tried' | 'skipped' }[]; omitted_step_count: number; resolution_included: boolean; evidence_links: CaseLink[]; omitted_link_count: number; linked_bodies_included: false; actions_performed: false; included_reports?: Array<{ id: string; revision: string; handle: 'R1'; host_id: string; target_id: string | null; recorded_at: string | null }> };
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= limit;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const caseId = (v: unknown) => typeof v === 'string' && /^case-[a-f0-9]{32}$/.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export const caseLinkKey = (p: CaseLink) => JSON.stringify(linkPointer(p));
function validPointer(p: any): boolean { return p && ['note', 'report', 'chat'].includes(p.kind) && text(p.id, 256) && hash(p.revision) && (p.kind === 'chat' ? count(p.message_index) && p.message_index <= 1000000 : p.message_index == null); }
export function validCaseRef(value: unknown): value is CaseRef {
  const r = value as CaseRef;
  return !!r && caseId(r.id) && hash(r.revision) && typeof r.include_resolution === 'boolean' && Array.isArray(r.step_ids) && r.step_ids.length <= 8 && r.step_ids.every(s => text(s, 80)) && new Set(r.step_ids).size === r.step_ids.length && Array.isArray(r.evidence_refs) && r.evidence_refs.length <= 8 && r.evidence_refs.every(validPointer) && new Set(r.evidence_refs.map(caseLinkKey)).size === r.evidence_refs.length && (r.report_refs === undefined || Array.isArray(r.report_refs) && r.report_refs.length <= 1 && r.report_refs.every(p => p && p.kind === 'report' && validPointer(p) && r.evidence_refs.some(e => e.kind === 'report' && e.id === p.id && e.revision === p.revision)));
}
export function casePointer(ref: CaseRef): CaseRef { if (!validCaseRef(ref)) throw new Error('Review a supported case selection before sending.'); return { id: ref.id, revision: ref.revision, step_ids: [...ref.step_ids], include_resolution: ref.include_resolution, evidence_refs: ref.evidence_refs.map(linkPointer), ...(ref.report_refs?.length ? { report_refs: ref.report_refs.map(p => ({ kind: 'report' as const, id: p.id, revision: p.revision })) } : {}) }; }
export function validateCaseContext(context: ChatContext, message = '') {
  if (!context.case_ref) return;
  casePointer(context.case_ref);
  if (context.photo || context.screenshot || context.image_provider_key || context.target_id || context.diagnostic_id || context.note_refs?.length || /\[vault:[^\]]+\]/i.test(message)) throw new Error('Ask about this case selection on its own. Remove other attached context or remove the case; nothing is removed automatically.');
}
export function validCaseReceipt(value: unknown): value is CaseReceipt {
  const r = value as CaseReceipt;
  if (!r || r.schema_version !== 1 || !caseId(r.id) || !hash(r.revision) || !text(r.title, 120) || !text(r.updated_at, 64) || !Number.isFinite(Date.parse(r.updated_at)) || !(r.computer_id === null || text(r.computer_id, 256)) || !['open', 'resolved'].includes(r.status) || typeof r.archived !== 'boolean' || typeof r.resolution_included !== 'boolean' || r.linked_bodies_included !== false || r.actions_performed !== false) return false;
  if (r.included_reports !== undefined && (!Array.isArray(r.included_reports) || r.included_reports.length > 1 || !Array.isArray(r.evidence_links) || !r.included_reports.every(p => p && text(p.id, 256) && hash(p.revision) && p.handle === 'R1' && text(p.host_id, 256) && (p.target_id === null || text(p.target_id, 256)) && (p.recorded_at === null || text(p.recorded_at, 64) && Number.isFinite(Date.parse(p.recorded_at))) && r.evidence_links.some(e => e.kind === 'report' && e.id === p.id && e.revision === p.revision)))) return false;
  return Array.isArray(r.steps) && r.steps.length <= 8 && r.steps.every(s => text(s.id, 80) && ['planned', 'tried', 'skipped'].includes(s.status)) && new Set(r.steps.map(s => s.id)).size === r.steps.length && count(r.omitted_step_count) && r.steps.length + r.omitted_step_count <= 30 && Array.isArray(r.evidence_links) && r.evidence_links.length <= 8 && r.evidence_links.every(l => validPointer(l) && text(l.label, 240) && ['current', 'changed', 'unavailable'].includes(l.availability || '')) && new Set(r.evidence_links.map(caseLinkKey)).size === r.evidence_links.length && count(r.omitted_link_count) && r.evidence_links.length + r.omitted_link_count <= 32;
}
export function caseReportFacts(receipt: CaseReceipt, evidence: any): RecordedReport | undefined {
  const p = receipt.included_reports?.[0];
  if (!p || evidence?.version !== 1 || !['backend', 'ai'].includes(evidence.interpretation) || !Array.isArray(evidence.sources) || evidence.sources.length > 12 || new Set(evidence.sources.map((s: any) => s?.handle)).size !== evidence.sources.length || !receipt.evidence_links.some(l => l.kind === 'report' && l.id === p.id && l.revision === p.revision && l.availability === 'current') || !evidence.sources.some((s: any) => s?.handle === 'C1' && s.kind === 'case' && s.id === receipt.id && s.revision === receipt.revision) || !evidence.sources.some((s: any) => s?.handle === p.handle && s.kind === 'report' && s.id === p.id && s.revision === p.revision && s.host_id === p.host_id && (s.target_id ?? null) === p.target_id)) return;
  const facts = recordedReport(evidence.recorded_report, { reportId: p.id, hostId: p.host_id, targetId: p.target_id });
  return facts?.recorded_at === p.recorded_at ? facts : undefined;
}
export function confirmCaseReceipt(ref: CaseRef, receipt: unknown, evidence?: unknown) {
  if (!validCaseReceipt(receipt) || receipt.id !== ref.id || receipt.revision !== ref.revision || receipt.resolution_included !== ref.include_resolution || JSON.stringify(receipt.steps.map(s => s.id)) !== JSON.stringify(ref.step_ids) || JSON.stringify(receipt.evidence_links.map(caseLinkKey)) !== JSON.stringify(ref.evidence_refs.map(caseLinkKey))) throw new Error('TLI did not confirm the reviewed case selection. Your draft is retained; review the case before retrying.');
  const expected = ref.report_refs || [], actual = receipt.included_reports || [];
  if (expected.length !== actual.length || expected.some((p, i) => p.id !== actual[i]?.id || p.revision !== actual[i]?.revision) || actual.length > 0 && !caseReportFacts(receipt, evidence)) throw new Error('TLI did not confirm the exact reviewed report facts. Your draft is retained; review before retrying.');
}
export async function checkCaseCapability(api: Pick<Client, 'json'>, current: () => boolean, needReport = false) {
  const value = await api.json<{ ok?: boolean; protocol?: string; case_context?: string; case_report_context?: string; max_case_reports?: number; actions_performed?: boolean }>('/api/intelligence/cases/capabilities');
  if (!current()) throw new Error('The case request is no longer current.');
  if (value?.ok !== true || value.protocol !== CASE_PROTOCOL || value.case_context !== CASE_CONTEXT_PROTOCOL || value.actions_performed !== false) throw new Error('Update and restart the TLI host before asking about reviewed cases. No case question was sent.');
  if (needReport && (value.case_report_context !== 'tli-case-report-context-v1' || value.max_case_reports !== 1)) throw new Error('This host does not support reviewed case report facts. No case question was sent.');
  return value;
}

/** In-memory review only. Each successful read invalidates acknowledgement. */
export class CaseReview {
  row?: TroubleshootingCase;
  steps: string[] = []; links: string[] = []; resolution = false; acknowledged = false;
  reportKey?: string; preview?: RecordedReport; reportSupported = false; private previewKey = '';
  checked = false; busy = false; private epoch = 0;
  invalidatePreview() { this.preview = undefined; this.previewKey = ''; this.acknowledged = false; }
  close() { this.epoch++; this.busy = false; this.checked = false; this.invalidatePreview(); }
  clear() { this.close(); this.row = undefined; this.steps = []; this.links = []; this.resolution = false; this.reportKey = undefined; this.reportSupported = false; }
  async load(api: Pick<Client, 'json'>, id: string, current: () => boolean) {
    if (this.busy) throw new Error('Wait for the saved case check to finish.');
    if (!caseId(id)) throw new Error('Choose a saved case first.');
    const ticket = ++this.epoch, fresh = () => ticket === this.epoch && current();
    this.busy = true; this.checked = false; this.invalidatePreview();
    try {
      const capabilities = await checkCaseCapability(api, fresh);
      const value = await api.json<any>('/api/intelligence/cases/' + encodeURIComponent(id));
      if (!fresh()) throw new Error('This case review is no longer current.');
      if (value?.actions_performed !== false) throw new Error('The saved case could not be checked.');
      const row = validateCase(value);
      if (row.id !== id || !caseId(row.id) || new Set(row.steps.map(s => s.id)).size !== row.steps.length || new Set(row.evidence.map(caseLinkKey)).size !== row.evidence.length || row.evidence.some(l => !validPointer(l) || !text(l.label, 240) || !['current', 'changed', 'unavailable'].includes(l.availability || ''))) throw new Error('The host returned different or unsupported case details.');
      const previous = this.row?.id === id;
      this.steps = previous ? this.steps.filter(id => row.steps.some(s => s.id === id)) : [];
      this.links = previous ? this.links.filter(key => row.evidence.some(l => caseLinkKey(l) === key)) : [];
      this.reportSupported = capabilities.case_report_context === 'tli-case-report-context-v1' && capabilities.max_case_reports === 1;
      if (!previous || !this.links.includes(this.reportKey || '')) this.reportKey = undefined;
      this.resolution = previous && this.resolution; this.row = row; this.checked = true;
    } finally { if (ticket === this.epoch) this.busy = false; }
  }
  toggle(kind: 'step' | 'link', id: string, selected: boolean) {
    if (!this.checked || this.busy || !this.row) return;
    const values = kind === 'step' ? this.steps : this.links;
    if (!(kind === 'step' ? this.row.steps.some(s => s.id === id) : this.row.evidence.some(l => caseLinkKey(l) === id))) throw new Error('Review a current saved item.');
    if (selected && !values.includes(id) && values.length >= 8) throw new Error('Choose up to eight whole steps and eight link descriptions.');
    const next = selected ? [...new Set([...values, id])] : values.filter(v => v !== id);
    if (kind === 'step') this.steps = next; else this.links = next;
    if (this.reportKey && !this.links.includes(this.reportKey)) this.reportKey = undefined;
    this.invalidatePreview();
  }
  chooseReport(key?: string) {
    if (!this.checked || this.busy) return;
    if (key && (!this.reportSupported || !this.links.includes(key) || !this.row?.evidence.some(l => caseLinkKey(l) === key && l.kind === 'report' && l.availability === 'current'))) throw new Error('Choose one current report link before reviewing its facts.');
    this.reportKey = key; this.invalidatePreview();
  }
  private pointer(): CaseRef {
    if (!this.row) throw new Error('Review a saved case first.');
    const report = this.row.evidence.find(l => caseLinkKey(l) === this.reportKey);
    return casePointer({ id: this.row.id, revision: this.row.revision, step_ids: this.steps, include_resolution: this.resolution, evidence_refs: this.row.evidence.filter(l => this.links.includes(caseLinkKey(l))).map(linkPointer), ...(report ? { report_refs: [{ kind: 'report', id: report.id, revision: report.revision }] } : {}) });
  }
  async previewReport(api: Pick<Client, 'json'>, current: () => boolean) {
    if (!this.checked || this.busy || !this.reportKey) throw new Error('Select a current report link first.');
    const ref = this.pointer(), ticket = ++this.epoch, fresh = () => ticket === this.epoch && current();
    this.busy = true; this.invalidatePreview();
    try {
      await checkCaseCapability(api, fresh, true);
      const value = await api.json<any>('/api/intelligence/cases/context-review', 'POST', { case_ref: ref });
      if (!fresh()) throw new Error('This report review is no longer current.');
      if (value?.ok !== true || value.protocol !== CASE_PROTOCOL || value.actions_performed !== false || value.case_report_context !== 'tli-case-report-context-v1' || !Number.isFinite(Date.parse(value.checked_at))) throw new Error('The host did not confirm a supported report review.');
      confirmCaseReceipt(ref, value.case_context, value.evidence_context);
      this.preview = caseReportFacts(value.case_context, value.evidence_context); this.previewKey = JSON.stringify(ref);
    } finally { if (ticket === this.epoch) this.busy = false; }
  }
  selection(): SelectedCase {
    if (!this.checked || this.busy || !this.acknowledged || !this.row) throw new Error('Check and acknowledge the current saved case selection first.');
    const ref = this.pointer();
    if (ref.report_refs?.length && (!this.preview || this.previewKey !== JSON.stringify(ref))) throw new Error('Preview the report facts for this exact case selection before acknowledging it.');
    return { title: this.row.title, updated_at: this.row.updated_at, ref };
  }
}
