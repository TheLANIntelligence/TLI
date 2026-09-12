// Browser-only synthetic fixtures. No network, measurements, files or devices.
import type { CheckOptions, CheckRequest } from './guided-checks';
import type { Report } from './types';
export const PREVIEW_HOST = { id: 'sample-home', name: 'Legato Home' };
export const PREVIEW_COMPUTER = 'node-sample-home';
export const PREVIEW_PEER = 'node-sample-peer';
const peer = { id: 'sample-peer', name: 'Sample workshop computer', identity_fingerprint: '1234:5678:90ab:cdef:1234:5678:90ab:cdef' };
export function previewCheckOptions(computer: string | null): CheckOptions {
  const local = computer === PREVIEW_COMPUTER;
  return { ok: true, protocol: 'tli-guided-checks-v1', checked_at: new Date().toISOString(), host: PREVIEW_HOST, computer_id: computer, actions_performed: false,
    options: [...(['system', 'network', 'performance'] as const).map((kind, index) => ({ id: kind, kind,
      title: kind === 'system' ? 'Host system check' : kind === 'network' ? 'Host network check' : 'Performance & apps',
      detail: 'Synthetic preview only. Measures the paired TLI host; no remote computer is inspected.',
      available: local, reason: local ? '' : 'Choose the paired TLI host to review this host-only check.',
      execution_host: PREVIEW_HOST, measured_target: PREVIEW_HOST, target_id: null, internet: false as const,
      ...(kind === 'performance' ? { panel: 'panel-games' } : { scope_revision: String(index + 1).repeat(64) }),
      ...(kind === 'network' ? { internet_scope_revision: '3'.repeat(64), internet_detail: 'Optional synthetic internet check; no real connection is made in this preview.' } : {}) })), ...(computer === PREVIEW_PEER ? [{ id: 'peer_system', kind: 'peer_system' as const, title: "Observe this TLI peer's resources", detail: 'One synthetic peer CPU, RAM and uptime observation. No local-host fallback.', available: true, reason: '', execution_host: peer, measured_target: { id: PREVIEW_PEER, name: peer.name, node_id: peer.id }, target_id: PREVIEW_PEER, scope_revision: 'd'.repeat(64), internet: false as const }] : [])] };
}
export function previewCheckReport(request: CheckRequest, sequence: number): Report & { internet_checks: boolean } {
  if (request.kind === 'peer_system') {
    const stamp = new Date().toISOString(), scope = 'Synthetic peer CPU, RAM and uptime only. No real device or host was observed.', target = { id: PREVIEW_PEER, name: peer.name }, revision = 'e'.repeat(64);
    const checks = [{ id: 'cpu_percent', label: 'Peer CPU', status: 'pass', detail: 'Recorded 12 percent in this synthetic fixture.' }];
    return { id: `sample-guided-${sequence}`, kind: 'system', host: peer, target, created_at: stamp, internet_checks: false, scope, checks,
      execution: { kind: 'peer_system', peer_revision: revision, identity_fingerprint: peer.identity_fingerprint, requesting_host: PREVIEW_HOST },
      peer_observation: { protocol: 'tli-peer-observation-v1', host: peer, peer_revision: revision, observed_at: stamp, scope, facts: { cpu_percent: 12, logical_cpus: 4, ram_total_bytes: 8589934592, ram_used_bytes: 2147483648, ram_available_bytes: 6442450944, ram_percent: 25, uptime_seconds: 1200 }, limitations: ['Synthetic preview only.'] },
      recorded_facts: { version: 1, basis: 'saved_report', report_id: `sample-guided-${sequence}`, kind: 'system', host: { id: peer.id, name: peer.name }, target, process: null, recorded_at: stamp, started_at: null, finished_at: null, duration_seconds: null, requested_duration_seconds: null, status: 'completed', status_label: 'Check results recorded', recorded_samples: null, expected_samples: null, raw_samples_included: 0, checks: checks.map(c => ({ ...c, scope: 'host' })), omitted_checks: 0, measurements: [], limitations: ['Saved synthetic peer observation, not current health.'] },
    } as Report & { internet_checks: boolean };
  }
  const id = `sample-guided-${sequence}`, stamp = new Date().toISOString(), checks = [{ id: 'sample-memory', label: 'Sample host memory', status: 'pass', detail: '42% used in this simulated observation. This is not the phone or a remote computer.' }];
  return { id, kind: request.kind, host: PREVIEW_HOST, created_at: stamp, internet_checks: request.internet,
    scope: `Synthetic ${request.kind} report from ${PREVIEW_HOST.name}. No real measurement, repair or device action occurred.`, checks,
    recorded_facts: { version: 1, basis: 'saved_report', report_id: id, kind: request.kind, host: PREVIEW_HOST, target: null, process: null, recorded_at: stamp, started_at: null, finished_at: null, duration_seconds: null, requested_duration_seconds: null, status: 'completed', status_label: 'Check results recorded', recorded_samples: null, expected_samples: null, raw_samples_included: 0, checks: checks.map(c => ({ ...c, scope: 'host' })), omitted_checks: 0, measurements: [], limitations: ['Saved synthetic observation only; no real measurement.'] } };
}
