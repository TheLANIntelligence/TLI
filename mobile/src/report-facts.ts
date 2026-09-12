/** Presentation of bounded, already-authorized saved observations. Never infer live health. */
export type ReportIdentity = { id: string | null; name: string | null };
export type RecordedReport = {
  version: 1; basis: 'saved_report'; report_id: string; kind: 'system' | 'network' | 'device' | 'performance' | 'unknown';
  host: ReportIdentity; target: ReportIdentity | null;
  process: { name: string | null; pid: number | null; create_time: number | null } | null;
  recorded_at: string | null; started_at: string | null; finished_at: string | null;
  duration_seconds: number | null; requested_duration_seconds: number | null;
  status: 'completed' | 'partial' | 'stopped' | 'failed' | 'unknown'; status_label: string;
  recorded_samples: number | null; expected_samples: number | null; raw_samples_included: 0;
  checks: Array<{ id: string | null; label: string; status: 'pass' | 'fail' | 'unavailable' | 'unknown'; detail: string | null; scope: 'host' | 'host_to_device' | 'unknown' }>;
  omitted_checks: number; measurements: Array<{ key: string; label: string; scope: 'host' | 'selected_process'; unit: 'percent' | 'bytes'; valid_samples: number; mean: number | null; minimum: number | null; maximum: number | null }>;
  limitations: string[];
};
export type ReportBinding = { reportId?: string; hostId?: string | null; targetId?: string | null };
const metrics: Record<string, readonly [string, string, string]> = {
  host_cpu_percent: ['Host CPU', 'host', 'percent'], host_ram_percent: ['Host RAM', 'host', 'percent'],
  host_ram_used_bytes: ['Host RAM used', 'host', 'bytes'], host_ram_total_bytes: ['Host RAM total', 'host', 'bytes'],
  process_cpu_percent: ['Selected process CPU (whole host capacity)', 'selected_process', 'percent'],
  process_rss_bytes: ['Selected process resident memory', 'selected_process', 'bytes'],
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const nullableText = (v: unknown, max: number) => v === null || text(v, max);
const num = (v: unknown, max = Number.MAX_VALUE): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const nullableNum = (v: unknown, max?: number) => v === null || num(v, max);
const count = (v: unknown, max = 3600): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const identity = (v: unknown) => object(v) && nullableText(v.id, 256) && (v.id === null || !!v.id) && nullableText(v.name, 240) && (v.name === null || !!v.name);
const stamp = (v: unknown) => v === null || text(v, 64) && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
export function recordedReport(value: unknown, expected: ReportBinding = {}): RecordedReport | undefined {
  const v = value;
  if (!object(v) || v.version !== 1 || v.basis !== 'saved_report' || !text(v.report_id, 256) || !v.report_id ||
    expected.reportId !== undefined && v.report_id !== expected.reportId || !['system', 'network', 'device', 'performance', 'unknown'].includes(v.kind) ||
    !identity(v.host) || v.target !== null && !identity(v.target) || expected.hostId !== undefined && v.host.id !== expected.hostId || expected.targetId !== undefined && (v.target?.id ?? null) !== expected.targetId ||
    !['completed', 'partial', 'stopped', 'failed', 'unknown'].includes(v.status) || !text(v.status_label, 100) ||
    ![v.recorded_at, v.started_at, v.finished_at].every(stamp) || !nullableNum(v.duration_seconds, 86400) || !nullableNum(v.requested_duration_seconds, 86400) ||
    v.recorded_samples !== null && !count(v.recorded_samples) || v.expected_samples !== null && (!count(v.expected_samples) || !v.expected_samples) ||
    v.raw_samples_included !== 0 || !Array.isArray(v.measurements) || v.measurements.length > 6 || new Set(v.measurements.map(m => m?.key)).size !== v.measurements.length ||
    !Array.isArray(v.checks) || v.checks.length > 64 || !count(v.omitted_checks, 10000) || !Array.isArray(v.limitations) || v.limitations.length > 12 || !v.limitations.every(s => text(s, 300))) return;
  if (v.process !== null && (!object(v.process) || !nullableText(v.process.name, 240) || v.process.pid !== null && (!count(v.process.pid, 4294967295) || !v.process.pid) || !nullableNum(v.process.create_time, 253402300799))) return;
  if (v.kind !== 'performance' && (v.process !== null || v.measurements.length)) return;
  if (!v.measurements.every(m => {
    const known = object(m) && metrics[m.key];
    if (!known || m.label !== known[0] || m.scope !== known[1] || m.unit !== known[2] || !count(m.valid_samples) || v.recorded_samples !== null && m.valid_samples > v.recorded_samples) return false;
    if (!m.valid_samples) return m.mean === null && m.minimum === null && m.maximum === null;
    return [m.minimum, m.mean, m.maximum].every(n => num(n, m.unit === 'percent' ? 100 : 9223372036854775807)) && m.minimum <= m.mean && m.mean <= m.maximum;
  })) return;
  if (!v.checks.every(c => object(c) && nullableText(c.id, 256) && text(c.label, 240) && nullableText(c.detail, 1000) && ['pass', 'fail', 'unavailable', 'unknown'].includes(c.status) && ['host', 'host_to_device', 'unknown'].includes(c.scope))) return;
  if (v.kind === 'performance' && v.status === 'completed' && (!v.host.id || !v.process?.pid || v.process.create_time === null || !v.expected_samples || v.recorded_samples !== v.expected_samples || v.measurements.length !== 6 || v.measurements.some(m => m.valid_samples !== v.expected_samples))) return;
  return v as RecordedReport;
}
export const reportTime = (v: string | null) => v === null ? 'Time not recorded' : new Date(v).toLocaleString();
export const reportIdentity = (v: ReportIdentity | null) => `${v?.name || 'Name not recorded'} · ${v?.id || 'ID not recorded'}`;
export const measuredValue = (v: number | null, unit: string) => v === null ? 'Unknown' : unit === 'percent' ? `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : `${(v / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
export function reportStatus(facts: RecordedReport) {
  return facts.kind === 'performance' ? { completed: 'Planned sampling completed', partial: 'Observation partially completed', stopped: 'Observation stopped', failed: 'Observation failed', unknown: 'Completion unknown' }[facts.status] : { completed: 'Check results recorded', partial: 'Some check results unavailable or unknown', stopped: 'Check stopped', failed: 'Check failed', unknown: 'Completion unknown' }[facts.status];
}
