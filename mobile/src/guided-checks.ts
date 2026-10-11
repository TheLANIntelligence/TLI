import type { Report } from './types';
import type { CaseRef } from './case-context';
export type CheckTarget = { id: string; name: string; node_id?: string | null; identity_fingerprint?: string };
export type CheckOption = { id: string; title: string; detail: string; kind: 'system' | 'network' | 'device' | 'performance' | 'peer_system'; available: boolean; reason: string; execution_host: CheckTarget; measured_target: CheckTarget; target_id?: string | null; scope_revision?: string; internet: false; internet_scope_revision?: string; internet_detail?: string; panel?: string };
export type CheckOptions = { ok: true; protocol: 'tli-guided-checks-v1'; checked_at: string; host: CheckTarget; computer_id: string | null; options: CheckOption[]; actions_performed: false };
export type CheckRequest = { kind: 'system' | 'network' | 'device' | 'peer_system'; target_id: string | null; internet: boolean; expected_host_id: string; expected_scope: string; request_id: string; next_check_ref?: { case_ref: CaseRef; selection_sha256: string; option_id: string } };
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const target = (v: any): v is CheckTarget => v && text(v.id) && !!v.id && text(v.name, 240);
export function checkOptions(value: unknown, computer: string | null): CheckOptions {
  const v = value as any;
  if (v?.ok !== true || v.protocol !== 'tli-guided-checks-v1' || v.actions_performed !== false || !target(v.host) ||
    v.computer_id !== computer || !Number.isFinite(Date.parse(v.checked_at)) || !Array.isArray(v.options) || !v.options.length || v.options.length > 5 || new Set(v.options.map((o: any) => o?.id)).size !== v.options.length ||
    !v.options.every((o: any) => o && ['system', 'network', 'device', 'performance', 'peer_system'].includes(o.kind) && o.id === o.kind &&
      text(o.title) && text(o.detail, 2000) && typeof o.available === 'boolean' && text(o.reason, 2000) &&
      target(o.execution_host) && (o.kind === 'peer_system' ? o.execution_host.id !== v.host.id && (!o.available || text(o.execution_host.identity_fingerprint, 128) && !!o.execution_host.identity_fingerprint) : o.execution_host.id === v.host.id) && target(o.measured_target) && o.internet === false &&
      (o.kind === 'performance' ? o.panel === 'panel-games' : hash(o.scope_revision)) &&
      (o.kind !== 'network' || hash(o.internet_scope_revision) && text(o.internet_detail, 2000)) &&
      (['device', 'peer_system'].includes(o.kind) ? !!computer && o.target_id === computer && o.measured_target.id === o.target_id :
        (o.target_id === null || o.target_id === undefined) && o.measured_target.id === v.host.id)))
    throw new Error('This host did not return supported check choices. Previous results are retained.');
  return v;
}
export function checkRequest(option: CheckOption, internet: boolean, requestId: string): CheckRequest {
  if (!option.available || option.kind === 'performance' || !target(option.execution_host) || !text(requestId, 128) || !requestId) throw new Error('Review an available check before running it.');
  const external = option.kind === 'network' && internet;
  const revision = external ? option.internet_scope_revision : option.scope_revision;
  if (!hash(revision)) throw new Error('The reviewed scope is unavailable. Refresh check choices.');
  return { kind: option.kind, target_id: option.target_id || null, internet: external, expected_host_id: option.execution_host.id, expected_scope: revision, request_id: requestId };
}
export function checkReport(value: unknown, request: CheckRequest, reviewed?: CheckOption): Report {
  const v = value as any;
  if (!v || !text(v.id) || !v.id || v.kind !== (request.kind === 'peer_system' ? 'system' : request.kind) || !target(v.host) || v.host.id !== request.expected_host_id ||
    (v.target?.id || null) !== request.target_id || v.internet_checks !== request.internet || !Number.isFinite(Date.parse(v.created_at)) || !text(v.scope, 2000) ||
    !Array.isArray(v.checks) || v.checks.length > 64 || !v.checks.every((c: any) => c && text(c.label) && ['pass', 'fail', 'unavailable'].includes(c.status) && text(c.detail, 2000)))
    throw new Error('The returned check report could not be confirmed. Review saved reports before another request.');
  if (request.kind === 'peer_system') {
    const e = v.execution, p = v.peer_observation, facts = p?.facts;
    const keys = ['cpu_percent', 'logical_cpus', 'ram_total_bytes', 'ram_used_bytes', 'ram_available_bytes', 'ram_percent', 'uptime_seconds'];
    if (!reviewed || reviewed.kind !== 'peer_system' || reviewed.execution_host.id !== request.expected_host_id || reviewed.target_id !== request.target_id || reviewed.scope_revision !== request.expected_scope || request.internet || !reviewed.execution_host.identity_fingerprint || v.host.identity_fingerprint !== reviewed.execution_host.identity_fingerprint || v.host.name !== reviewed.execution_host.name ||
      e?.kind !== 'peer_system' || !hash(e.peer_revision) || e.identity_fingerprint !== v.host.identity_fingerprint || !target(e.requesting_host) || e.requesting_host.id === v.host.id ||
      p?.protocol !== 'tli-peer-observation-v1' || p.host?.id !== v.host.id || p.host?.name !== v.host.name || p.host?.identity_fingerprint !== v.host.identity_fingerprint || p.peer_revision !== e.peer_revision || p.observed_at !== v.created_at || p.scope !== v.scope || !facts || Object.keys(facts).length !== keys.length || !keys.every(key => facts[key] === null || typeof facts[key] === 'number' && Number.isFinite(facts[key]) && facts[key] >= 0 && facts[key] <= (key.endsWith('percent') ? 100 : 2 ** 60)) || !Array.isArray(p.limitations) || p.limitations.length > 8 || !p.limitations.every((s: unknown) => text(s, 512))) throw new Error('The peer observation did not match the reviewed computer and scope. No local host result is substituted.');
    const known = keys.filter(key => facts[key] !== null).length;
    if ((p.coverage !== undefined || known !== keys.length) && (p.coverage?.complete !== (known === keys.length) || p.coverage?.known_metrics !== known || p.coverage?.total_metrics !== keys.length)) throw new Error('The peer observation coverage could not be confirmed. Missing values are not zero measurements.');
  }
  return v;
}
