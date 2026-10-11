import type { Client } from './client';
import { CASE_PROTOCOL, type TroubleshootingCase, type CaseStep } from './cases';
import { casePointer, caseReportFacts, confirmCaseReceipt, type CaseReceipt, type CaseRef, type SelectedCase } from './case-context';
import { checkOptions, type CheckOption, type CheckOptions } from './guided-checks';
import type { RecordedReport } from './report-facts';

export const NEXT_CHECK_PROTOCOL = 'tli-case-next-check-v1';
type Known = { id: string; label: string; text: string; source: 'C1' | 'R1'; recorded_at: string | null };
export type NextCheck = { checked_at: string; receipt: CaseReceipt; facts?: RecordedReport; selection: CaseRef; selection_sha256: string; status: 'suggested' | 'unavailable'; known: Known[]; missing: { id: string; text: string }[]; steps: CaseStep[]; limitations: string[]; options: CheckOptions | null; suggestion: { option_id: string; rule_id: string; rationale: string } | null };
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || !!v.length) && v.length <= max;
const date = (v: unknown) => text(v, 64) && Number.isFinite(Date.parse(v));
const rows = (v: any, max: number, valid: (r: any) => boolean) => Array.isArray(v) && v.length <= max && v.every(valid) && new Set(v.map(r => r.id)).size === v.length;
const pointerKey = (ref: CaseRef) => JSON.stringify(casePointer(ref));
const scopeKey = (o: CheckOption) => JSON.stringify([o.id, o.kind, o.execution_host.id, o.execution_host.name, o.execution_host.identity_fingerprint ?? null, o.measured_target.id, o.measured_target.name, o.target_id ?? null, o.scope_revision, o.internet]);

/** No inference or metric interpretation: validate only the server's bounded, reviewed facts. */
export function nextCheck(value: unknown, selected: SelectedCase, saved: TroubleshootingCase): NextCheck {
  const v = value as any, g = v?.guidance, ref = casePointer(selected.ref);
  if (ref.id !== saved.id || ref.revision !== saved.revision || selected.title !== saved.title || selected.updated_at !== saved.updated_at || v?.ok !== true || v.protocol !== CASE_PROTOCOL || v.actions_performed !== false || v.next_check_protocol !== NEXT_CHECK_PROTOCOL || !date(v.checked_at) || g?.version !== 1 || !['suggested', 'unavailable'].includes(g.status) || !/^[a-f0-9]{64}$/.test(g.selection_sha256) || pointerKey(g.selection) !== pointerKey(ref)) throw new Error('The host did not confirm this saved case selection. Review it again; nothing ran.');
  confirmCaseReceipt(ref, v.case_context, v.evidence_context);
  const receipt: CaseReceipt = v.case_context, facts = caseReportFacts(receipt, v.evidence_context), source = v.evidence_context;
  if (receipt.computer_id !== (saved.computer?.id ?? null) || receipt.title !== saved.title || receipt.updated_at !== saved.updated_at || receipt.status !== saved.status || receipt.archived !== saved.archived || receipt.omitted_step_count !== saved.steps.length - ref.step_ids.length || receipt.omitted_link_count !== saved.evidence.length - ref.evidence_refs.length || source?.version !== 1 || source.interpretation !== 'backend' || !Array.isArray(source.sources) || source.sources.length > 12 || new Set(source.sources.map((s: any) => s?.handle)).size !== source.sources.length || !source.sources.some((s: any) => s?.handle === 'C1' && s.kind === 'case' && s.id === ref.id && s.revision === ref.revision)) throw new Error('The guidance belongs to different or unconfirmed saved details. Review the saved case again.');
  if (!rows(g.known, 4, r => r && text(r.id, 80) && text(r.label, 240) && text(r.text, 4000, true) && ['C1', 'R1'].includes(r.source) && (r.source !== 'R1' || !!facts) && (r.recorded_at === null || date(r.recorded_at))) || !rows(g.missing, 8, r => r && text(r.id, 80) && text(r.text, 1000)) || !rows(g.steps, 8, s => s && text(s.id, 80) && text(s.text, 1000) && text(s.outcome, 2000, true) && ['planned', 'tried', 'skipped'].includes(s.status)) || !Array.isArray(g.limitations) || g.limitations.length > 8 || !g.limitations.every((s: unknown) => text(s, 1000))) throw new Error('The guidance contains unsupported or oversized details. Earlier results are retained.');
  const expectedSteps = ref.step_ids.map(id => saved.steps.find(s => s.id === id));
  if (g.known.some((r: Known) => r.recorded_at !== (r.source === 'C1' ? saved.updated_at : facts?.recorded_at))) throw new Error('A saved detail has a different recorded time. Review the exact sources again.');
  if (expectedSteps.some(s => !s) || g.steps.length !== expectedSteps.length || g.steps.some((s: CaseStep, i: number) => ['id', 'text', 'status', 'outcome'].some(k => s[k as keyof CaseStep] !== expectedSteps[i]![k as keyof CaseStep])) || receipt.steps.some((s, i) => s.status !== expectedSteps[i]?.status)) throw new Error('The guidance changed a selected step or its recorded outcome. Review the saved case again.');
  const options = g.check_options === null ? null : checkOptions(g.check_options, saved.computer?.id ?? null);
  if (!saved.computer && options || saved.computer && !options) throw new Error('Check choices do not match the saved computer association.');
  const suggestion = g.suggestion;
  if (g.status === 'suggested' ? !suggestion || !text(suggestion.rule_id, 80) || !text(suggestion.rationale, 1000) || !options?.options.some(o => o.id === suggestion.option_id && o.available && o.kind !== 'performance') : suggestion !== null) throw new Error('The host did not supply an available read-only check suggestion.');
  return { checked_at: v.checked_at, receipt, facts, selection: ref, selection_sha256: g.selection_sha256, status: g.status, known: g.known.map((r: Known) => ({ id: r.id, label: r.label, text: r.text, source: r.source, recorded_at: r.recorded_at })), missing: g.missing.map((r: any) => ({ id: r.id, text: r.text })), steps: g.steps.map((s: CaseStep) => ({ id: s.id, text: s.text, status: s.status, outcome: s.outcome })), limitations: [...g.limitations], options, suggestion: suggestion ? { option_id: suggestion.option_id, rule_id: suggestion.rule_id, rationale: suggestion.rationale } : null };
}

/** RAM only; stale failures retain the last card but revoke its ability to open Run. */
export class NextCheckReview {
  result?: NextCheck; current = false; busy = false; private epoch = 0; private reviewedScope = '';
  invalidate(clear = false) { this.epoch++; this.busy = false; this.current = false; this.reviewedScope = ''; if (clear) this.result = undefined; }
  runRef(option: CheckOption) {
    const r = this.result, prior = r?.options?.options.find(o => o.id === r.suggestion?.option_id);
    if (!this.current || !r || !prior || scopeKey(prior) !== scopeKey(option) || this.reviewedScope !== scopeKey(option)) throw new Error('Review the saved-case guidance and exact suggested check again.');
    return { case_ref: casePointer(r.selection), selection_sha256: r.selection_sha256, option_id: prior.id };
  }
  async review(api: Pick<Client, 'json'>, selected: SelectedCase, saved: TroubleshootingCase, active: () => boolean) {
    if (this.busy) throw new Error('Wait for the current guidance review.');
    const ticket = ++this.epoch, fresh = () => ticket === this.epoch && active(); this.busy = true; this.current = false; this.reviewedScope = '';
    try {
      const capability = await api.json<any>('/api/intelligence/cases/capabilities');
      if (!fresh()) throw new Error('This guidance review is no longer current.');
      if (capability?.ok !== true || capability.protocol !== CASE_PROTOCOL || capability.actions_performed !== false || capability.next_check !== NEXT_CHECK_PROTOCOL) throw new Error('This host does not support saved-case next-check guidance. Review available checks below, or update and restart the host.');
      const value = await api.json('/api/intelligence/cases/next-check', 'POST', { case_ref: casePointer(selected.ref) });
      if (!fresh()) throw new Error('This guidance review is no longer current.');
      this.result = nextCheck(value, selected, saved); this.current = true;
      return this.result;
    } finally { if (ticket === this.epoch) this.busy = false; }
  }
  async reviewSuggested(api: Pick<Client, 'json'>, computer: string | null, active: () => boolean) {
    const result = this.result;
    if (this.busy || !this.current || !result?.suggestion || result.receipt.computer_id !== computer) throw new Error('Review current next-check guidance first.');
    const prior = result.options?.options.find(o => o.id === result.suggestion!.option_id);
    const ticket = ++this.epoch, fresh = () => ticket === this.epoch && active(); this.busy = true; this.reviewedScope = '';
    try {
      const value = await api.json('/api/intelligence/diagnostics/options?include_peer_observation=true' + (computer ? `&computer_id=${encodeURIComponent(computer)}` : ''));
      if (!fresh()) throw new Error('This check review is no longer current.');
      const options = checkOptions(value, computer), option = options.options.find(o => o.id === prior?.id);
      if (!prior || !option?.available || option.kind === 'performance' || scopeKey(option) !== scopeKey(prior) || options.host.id !== result.options?.host.id) throw new Error('The check scope changed or became unavailable. Review next-check guidance again before running anything.');
      this.reviewedScope = scopeKey(option); return { options, option };
    } catch (e) { if (fresh()) this.current = false; throw e; }
    finally { if (ticket === this.epoch) this.busy = false; }
  }
}
