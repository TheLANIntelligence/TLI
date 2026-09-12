import type { Note, Report, SourceRef } from './types';
export const CASE_PROTOCOL = 'tli-cases-v1';
export type CaseLink = { kind: 'note' | 'report' | 'chat'; id: string; revision: string; message_index?: number; label?: string; linked_at?: string; availability?: 'current' | 'changed' | 'unavailable' };
export type CaseStep = { id: string; text: string; status: 'planned' | 'tried' | 'skipped'; outcome: string };
export type CaseSummary = { id: string; title: string; symptom: string; computer: { id: string; name: string; node_id?: string | null } | null; status: 'open' | 'resolved'; archived: boolean; created_at: string; updated_at: string; revision: string };
export type TroubleshootingCase = CaseSummary & { steps: CaseStep[]; resolution: string; evidence: CaseLink[] };
export type CaseDraft = { title: string; symptom: string; computer_id: string | null; status: 'open' | 'resolved'; archived: boolean; steps: CaseStep[]; resolution: string; evidence: CaseLink[] };
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const bounded = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
export const emptyCase = (): CaseDraft => ({ title: '', symptom: '', computer_id: null, status: 'open', archived: false, steps: [], resolution: '', evidence: [] });
export function draftCase(value: TroubleshootingCase): CaseDraft { return { title: value.title, symptom: value.symptom, computer_id: value.computer?.id || null, status: value.status, archived: value.archived, steps: value.steps.map(s => ({ ...s })), resolution: value.resolution, evidence: value.evidence.map(e => ({ ...e })) }; }
export function validCaseLink(value: any): value is CaseLink { return !!value && ['note', 'report', 'chat'].includes(value.kind) && bounded(value.id, 256) && !!value.id && hash(value.revision) && (value.label === undefined || bounded(value.label, 240)) && (value.availability === undefined || ['current', 'changed', 'unavailable'].includes(value.availability)) && (value.kind !== 'chat' || Number.isSafeInteger(value.message_index) && value.message_index >= 0 && value.message_index <= 1000000); }
export function validCaseSummary(c: any): boolean { return !!c && bounded(c.id, 256) && !!c.id && hash(c.revision) && bounded(c.title, 120) && !!c.title.trim() && bounded(c.symptom, 4000) && ['open', 'resolved'].includes(c.status) && typeof c.archived === 'boolean' && timestamp(c.created_at) && timestamp(c.updated_at) && (c.computer === null || c.computer && bounded(c.computer.id, 256) && !!c.computer.id && bounded(c.computer.name, 240) && (c.computer.node_id == null || bounded(c.computer.node_id, 256))); }
export function evidenceAvailability(link: CaseLink): string { return link.availability === 'current' ? 'Matches saved source' : link.availability === 'changed' ? 'Saved source changed since review' : link.availability === 'unavailable' ? 'Saved source unavailable' : 'Reviewed for this draft'; }
export function linkPointer(evidence: CaseLink) { return { kind: evidence.kind, id: evidence.id, revision: evidence.revision, ...(evidence.kind === 'chat' ? { message_index: evidence.message_index } : {}) }; }
export function caseBody(draft: CaseDraft, original?: TroubleshootingCase, requestId?: string): CaseDraft & { expected_revision?: string; request_id?: string } {
  if (!bounded(draft.title, 120) || !draft.title.trim() || !bounded(draft.symptom, 4000) || !bounded(draft.resolution, 2000) || draft.status === 'resolved' && !draft.resolution.trim() || !['open', 'resolved'].includes(draft.status) || draft.steps.length > 30 || draft.evidence.length > 32 || !draft.evidence.every(validCaseLink) || draft.steps.some(s => !bounded(s.id, 80) || !s.id || !bounded(s.text, 1000) || !s.text.trim() || !bounded(s.outcome, 2000) || !['planned', 'tried', 'skipped'].includes(s.status))) throw new Error('Review the title, steps, evidence and resolution before saving. Mark resolved only after you confirm what worked.');
  if (original && !hash(original.revision)) throw new Error('Refresh and review the current case before saving.');
  return { ...draft, title: draft.title.trim(), evidence: draft.evidence.map(linkPointer), ...(original ? { expected_revision: original.revision } : { request_id: requestId }) };
}
export function validateCase(value: unknown): TroubleshootingCase {
  const result = value as any, c = result?.case;
  if (result?.ok !== true || result.protocol !== CASE_PROTOCOL || !validCaseSummary(c) || !Array.isArray(c.steps) || !Array.isArray(c.evidence) || !bounded(c.resolution, 2000) || !c.evidence.every(validCaseLink)) throw new Error('TLI did not return a supported Troubleshooting record. The prior view is unchanged.');
  caseBody(draftCase(c), c); return c;
}
export function validateEvidence(value: unknown, requested: { kind: string; id: string; message_index?: number }): CaseLink {
  const result = value as any, link = result?.evidence;
  if (result?.ok !== true || result.protocol !== CASE_PROTOCOL || !validCaseLink(link) || link.kind !== requested.kind || link.id !== requested.id || link.kind === 'chat' && link.message_index !== requested.message_index || !bounded(link.label, 300)) throw new Error('The source was not confirmed. No evidence link was added.');
  return { ...link };
}
export function caseEvidenceSource(kind: CaseLink['kind'], item: Note | Report | SourceRef) { return kind === 'chat' ? { kind, id: (item as SourceRef).conversation_id, message_index: (item as SourceRef).message_index } : { kind, id: (item as Note | Report).id }; }
