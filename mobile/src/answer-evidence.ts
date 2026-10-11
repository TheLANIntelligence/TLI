import type { AnswerEvidence, SourceRef, ResponseTiming } from './types';
import { caseReportFacts, validCaseReceipt } from './case-context';
import { recordedReport, type RecordedReport } from './report-facts';

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validSourceRef(v: unknown): v is SourceRef { return record(v) && text(v.conversation_id, 200) && !!v.conversation_id && count(v.message_index) && hash(v.revision); }
/** Keep the server's additive receipts intact for live and saved conversations. */
export function answerEvidence(value: AnswerEvidence): AnswerEvidence {
  const result: AnswerEvidence = {};
  for (const key of ['memory_context', 'conversation_context', 'observation_context', 'input_budget', 'document_context', 'evidence_context', 'case_context'] as const) if (value[key] !== undefined) result[key] = value[key];
  for (const key of ['source_ref', 'user_source_ref'] as const) if (validSourceRef(value[key])) result[key] = { ...value[key] };
  return result;
}
export function documentCoverage(document: Record<string, any>): string {
  const c = document.coverage;
  if (c === undefined) return 'No coverage breakdown recorded.';
  if (!record(c) || !['excerpts', 'full', 'omitted'].includes(c.mode) || !['question_terms', 'representative', 'full', 'none'].includes(c.selection) || !count(c.included_lines) || !count(c.omitted_lines) || c.included_lines + c.omitted_lines !== document.line_count || !Array.isArray(c.ranges) || c.ranges.length > 32) return 'Coverage details unavailable.';
  let end = 0, included = 0;
  for (const range of c.ranges) {
    if (!record(range) || !count(range.start) || !count(range.end) || range.start <= end || range.end < range.start || range.end > document.line_count) return 'Coverage details unavailable.';
    included += range.end - range.start + 1; end = range.end;
  }
  if (included !== c.included_lines || c.mode === 'full' && (c.omitted_lines !== 0 || c.selection !== 'full') || c.mode === 'omitted' && (included !== 0 || c.selection !== 'none') || c.mode === 'excerpts' && (!included || !c.omitted_lines || !['question_terms', 'representative'].includes(c.selection))) return 'Coverage details unavailable.';
  return `${c.included_lines} lines included · ${c.omitted_lines} omitted.${c.ranges.length ? ` Original lines ${c.ranges.map((r: any) => r.start === r.end ? r.start : `${r.start}–${r.end}`).join(', ')}.` : ''}`;
}
function validatedEvidence(evidence: unknown): Record<string, any> | undefined {
const optional = (value: unknown, size: number) => value == null || text(value, size);
const citationMatches = (c: any, s: any) => {
  if (c.reference === '[' + s.handle + ']') return s.kind !== 'document';
  const prefix = '[' + s.label + ':L';
  if (s.kind !== 'document' || !c.reference.startsWith(prefix)) return false;
  const match = /^(\d+)(?:-L?(\d+))?\]$/.exec(c.reference.slice(prefix.length));
  return !!match && s.ranges.some((r: any) => r.start <= Number(match[1]) && Number(match[1]) <= Number(match[2] || match[1]) && Number(match[2] || match[1]) <= r.end);
};
const kinds: Record<string, string> = { note: 'N', report: 'R', document: 'D', observation: 'O', case: 'C' };
const valid = record(evidence) && evidence.version === 1 && ['ai', 'backend'].includes(evidence.interpretation) && typeof evidence.citations_checked === 'boolean'
  && Array.isArray(evidence.sources) && evidence.sources.length <= 12 && new Set(evidence.sources.map((s: any) => s?.handle)).size === evidence.sources.length
  && evidence.sources.every((s: any) => record(s) && kinds[s.kind] && new RegExp('^' + kinds[s.kind] + '[1-9][0-9]?$').test(s.handle) && text(s.id, 256) && !!s.id && text(s.label, 240) && !!s.label && text(s.provenance, 64) && !!s.provenance && (!['note', 'document', 'case'].includes(s.kind) || hash(s.revision)) && optional(s.saved_at, 64) && optional(s.observed_at, 64) && optional(s.host_id, 256) && optional(s.target_id, 256) && Array.isArray(s.ranges) && s.ranges.length <= 32 && (s.kind === 'document' || s.ranges.length === 0) && s.ranges.every((r: any, i: number) => record(r) && count(r.start) && r.start >= 1 && count(r.end) && r.end >= r.start && r.end <= 65537 && (!i || r.start > s.ranges[i - 1].end)))
  && Array.isArray(evidence.citations) && evidence.citations.length <= 32 && (evidence.citations_checked || !evidence.citations.length && !evidence.invalid_citations) && evidence.citations.every((c: any) => record(c) && text(c.reference, 160) && evidence.sources.some((s: any) => s.handle === c.handle && citationMatches(c, s))) && count(evidence.invalid_citations) && evidence.invalid_citations <= 10000;
  return valid ? evidence : undefined;
}
export function evidenceSources(value: AnswerEvidence): Array<Record<string, any>> { return validatedEvidence(value.evidence_context)?.sources || []; }
/** Bind a fact card to the exact saved report source, including host and subject. */
export function answerReport(value: AnswerEvidence): { supplied: boolean; facts?: RecordedReport } {
  const raw = value.evidence_context;
  const supplied = record(raw) && raw.recorded_report !== undefined;
  const evidence = validatedEvidence(raw);
  if (!supplied || !evidence) return { supplied };
  if (value.case_context !== undefined) return { supplied, facts: validCaseReceipt(value.case_context) ? caseReportFacts(value.case_context, evidence) : undefined };
  const source = evidence.sources.find((s: any) => s.kind === 'report' && s.id === evidence.recorded_report?.report_id);
  return { supplied, facts: source ? recordedReport(evidence.recorded_report, { reportId: source.id, hostId: source.host_id ?? null, targetId: source.target_id ?? null }) : undefined };
}
export function historicalNoteLines(value: unknown): string[] {
  if (!record(value) || value.checked !== true || !count(value.changed) || value.changed > 512 || !count(value.unavailable) || value.unavailable > 512) return ['Earlier source status details unavailable.'];
  if (!value.changed && !value.unavailable && value.references === undefined) return [];
  const summary = `Earlier answer references: ${value.changed} changed, ${value.unavailable} unavailable for this question. Old replies are not current saved facts.`;
  if (value.references === undefined) return [summary, 'Individual historical references were not recorded.'];
  const refs = value.references;
  if (!Array.isArray(refs) || refs.length > 256 || !refs.every((r: any) => record(r) && count(r.exchange_index) && r.exchange_index >= 1 && r.exchange_index <= 32 && text(r.note_id, 256) && !!r.note_id && text(r.title, 120) && !!r.title && hash(r.revision) && /^N[1-8]$/.test(r.handle) && ['changed', 'unavailable'].includes(r.status)) || new Set(refs.map((r: any) => `${r.exchange_index}:${r.handle}`)).size !== refs.length || refs.filter((r: any) => r.status === 'changed').length !== value.changed || refs.filter((r: any) => r.status === 'unavailable').length !== value.unavailable || refs.some((r: any, i: number) => i > 0 && (r.exchange_index < refs[i - 1].exchange_index || r.exchange_index === refs[i - 1].exchange_index && r.handle <= refs[i - 1].handle))) return [summary, 'Individual historical reference details unavailable.'];
  return [summary, 'Handles below belong only to their earlier exchange; they are not current source links.', ...refs.map((r: any) => `Earlier exchange ${r.exchange_index} · ${r.handle} · ${r.title} · ${r.status}. Saved note ${r.note_id} · referenced revision ${r.revision}.`)];
}

/** Render only validated observations. Missing receipts never imply no context. */
export function evidenceLines(value: AnswerEvidence): string[] {
  const lines: string[] = [];
  const memory = value.memory_context;
  if (memory !== undefined) {
    if (record(memory) && typeof memory.use_saved_memory === 'boolean' && ['included', 'none', 'disabled'].includes(memory.status) && Array.isArray(memory.notes) && memory.notes.length <= 8 && memory.notes.every((n: any) => record(n) && text(n.id, 200) && hash(n.revision) && text(n.title, 120)) && count(memory.omitted_for_budget) && (memory.status === 'disabled' ? !memory.use_saved_memory && !memory.notes.length : memory.use_saved_memory && (memory.status === 'included' ? !!memory.notes.length : !memory.notes.length))) {
      lines.push(memory.status === 'disabled' ? 'Saved-note recall was off for this answer. Earlier conversation may still apply.' : memory.status === 'included' ? `Saved notes recalled: ${memory.notes.map((n: any) => n.title || 'Untitled note').join(', ')}. Saved information is not measured health.` : 'No saved notes were recalled for this answer.');
      if (memory.omitted_for_budget) lines.push(`${memory.omitted_for_budget} saved notes omitted for the input budget.`);
    } else lines.push('Saved-note recall details unavailable.');
  }
  const conversation = value.conversation_context;
  if (conversation !== undefined) lines.push(record(conversation) && ['included', 'none', 'limited', 'disabled'].includes(conversation.status) && ['included_messages', 'included_exchanges', 'omitted_messages', 'character_budget'].every(k => count(conversation[k])) && (conversation.status !== 'disabled' || conversation.use_conversation_history === false && conversation.included_messages === 0 && conversation.omitted_messages === 0) ? conversation.status === 'disabled' ? 'Earlier conversation was off for this question. No previous exchanges or follow-up topic were supplied.' : `Earlier conversation: ${conversation.included_messages} messages included, ${conversation.omitted_messages} omitted. This is the context recorded for this answer.` : 'Earlier-conversation details unavailable.');
  const evidence = validatedEvidence(value.evidence_context);
  if (value.evidence_context !== undefined) {
    if (!evidence) lines.push('Source identities could not be checked. References remain unverified.');
    else {
      lines.push(evidence.interpretation === 'backend' ? evidence.sources.some((s: any) => s.kind === 'observation') ? 'Backend observation summary. Its time and coverage describe the checks available.' : evidence.sources.length ? 'Backend summary of supplied saved records. No new check or repair ran.' : 'No admissible recorded outcome was supplied. No new check or repair ran.' : 'AI interpretation. Checked references identify supplied sources; they do not prove the answer is correct.');
      if (!evidence.sources.length) lines.push('No saved-note, report or document source was supplied.');
      for (const source of evidence.sources) {
        lines.push(`${source.handle} · ${source.label} · ${source.kind === 'note' ? source.provenance === 'chat_ai' ? 'Saved AI suggestion, unconfirmed' : source.provenance === 'user_confirmation' ? 'User-confirmed historical fix, not an independent test' : 'Saved statement, not a current measurement' : source.kind === 'report' ? 'Saved diagnostic checks, historical observation' : source.kind === 'document' ? 'Selected document, not current measured health' : source.kind === 'case' ? 'User-recorded troubleshooting, not measured health' : 'Host observation'}. Recorded ${source.observed_at || source.saved_at || 'time unknown'}${source.host_id ? ' · Host ' + source.host_id : ''}${source.target_id ? ' · Target ' + source.target_id : ''}.`);
        if (source.kind === 'document') lines.push(`Supplied lines ${source.ranges.map((r: any) => r.start === r.end ? r.start : `${r.start}–${r.end}`).join(', ')}. Reselect the matching file to review its text; document bodies are not saved in this receipt.`);
      }
      lines.push(evidence.citations_checked ? `${evidence.citations.length} distinct references matched supplied source identities or line ranges; ${evidence.invalid_citations} could not be verified.` : 'References have not been checked against a completed answer.');
      const h = evidence.historical_notes;
      if (h !== undefined) lines.push(...historicalNoteLines(h));
    }
  }
  const observation = value.observation_context;
  if (value.case_context !== undefined) {
    const c = value.case_context;
    if (validCaseReceipt(c)) {
      lines.push(`Case: ${c.title} · saved ${c.updated_at} · ${c.status === 'resolved' ? 'user-marked resolved' : 'open'}${c.archived ? ' · archived' : ''}. ${c.steps.length} steps included, ${c.omitted_step_count} omitted; resolution ${c.resolution_included ? 'included' : 'excluded'}.`);
      lines.push(`${c.evidence_links.length} link descriptions included, ${c.omitted_link_count} omitted. Linked bodies and earlier chat were excluded. No actions ran.`);
      if (c.included_reports?.length) lines.push(caseReportFacts(c, value.evidence_context) ? 'Bounded facts from one explicitly reviewed saved report were supplied separately. These are saved observations, not current health.' : 'The separately declared report facts could not be checked.');
      for (const link of c.evidence_links) lines.push(`${link.label} · ${link.availability} when prepared · body not supplied${c.included_reports?.some(p => p.id === link.id && p.revision === link.revision) ? '; bounded report facts declared separately' : ''}.`);
    } else lines.push('Case selection could not be checked. Review the original record before relying on this answer.');
  }
  if (observation !== undefined) {
    if (record(observation) && observation.schema_version === 1 && ['cpu', 'ram', 'storage', 'network', 'printers', 'system'].includes(observation.topic) && ['current', 'stale', 'unknown', 'unavailable'].includes(observation.status) && record(observation.host) && text(observation.host.id, 200) && text(observation.host.name, 200) && text(observation.resource) && text(observation.source) && text(observation.coverage, 2000) && date(observation.checked_at) && (observation.observed_at === null || date(observation.observed_at))) lines.push(`Host observation: ${observation.host.name} (${observation.host.id}) · ${observation.resource} · ${observation.status} when answered. Observed ${observation.observed_at || 'time unknown'}; checked ${observation.checked_at}. Source: ${observation.source}. ${observation.coverage}`);
    else lines.push('Host observation details unavailable.');
  }
  const documents = value.document_context;
  if (documents !== undefined) {
    if (record(documents) && documents.actions_performed === false && Array.isArray(documents.documents) && documents.documents.length <= 4 && documents.documents.every((d: any) => record(d) && text(d.name, 120) && hash(d.sha256) && count(d.line_count) && d.line_count > 0 && count(d.chars))) for (const d of documents.documents) lines.push(`Document: ${d.name} · ${d.line_count} original lines · SHA-256 ${d.sha256}. ${documentCoverage(d)}`);
    else lines.push('Document evidence unavailable.');
  }
  const budget = value.input_budget;
  if (budget !== undefined) {
    if (record(budget) && budget.version === 1 && budget.estimation === 'heuristic' && ['bundled', 'lmstudio', 'unknown'].includes(budget.provider) && ['configured', 'unknown'].includes(budget.capacity_status) && count(budget.input_characters) && budget.input_characters > 0 && count(budget.character_limit) && budget.character_limit <= 12000 && budget.input_characters <= budget.character_limit && count(budget.estimated_input_tokens) && budget.estimated_input_tokens > 0 && count(budget.reserved_output_tokens) && budget.reserved_output_tokens > 0 && date(budget.checked_at) && (budget.capacity_status === 'configured' ? count(budget.context_tokens) && budget.context_tokens >= budget.estimated_input_tokens + budget.reserved_output_tokens && budget.fit === 'estimated' && budget.capacity_source === 'owned_runtime_launch' : budget.context_tokens === null && budget.fit === 'unknown')) lines.push(`Input budget: ${budget.input_characters} of ${budget.character_limit} characters. ${budget.capacity_status === 'configured' ? `${budget.context_tokens} configured context tokens; fit estimated.` : 'Model context capacity unknown.'} Token counts are estimates, not an answer-quality score.`);
    else lines.push('Input-budget details unavailable.');
  }
  return lines;
}
export function timingText(timing?: ResponseTiming): string | undefined {
  if (!timing || !Number.isFinite(timing.elapsed_ms) || timing.elapsed_ms < 0) return;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return `${timing.outcome === 'waiting' ? 'Waiting for response' : timing.outcome === 'streaming' ? 'Receiving response' : timing.outcome === 'complete' ? 'Response completed' : 'Response interrupted'} · ${seconds(timing.elapsed_ms)} on this phone${timing.first_text_ms !== undefined ? ` · first text ${seconds(timing.first_text_ms)}` : ' · no response text yet'}`;
}
