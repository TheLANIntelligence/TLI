import type { Client } from './client';

export type DataHealthStatus = 'readable' | 'not_created' | 'unavailable' | 'not_checked';
export type DataHealth = {
  schema_version: 1; checked_at: string; host: { id: string; name: string }; scope: string;
  checks: { id: 'notebook' | 'conversations' | 'diagnostics'; label: string; status: DataHealthStatus; detail: string }[];
  backup: { status: 'unknown'; detail: string };
  guidance: { summary: string; steps: string[]; limitations: string[] };
};
export type DataHealthState = { data?: DataHealth; checkedFor?: Pick<Client, 'json'>; busy: boolean; stale: boolean; error: string };
const CHECKS = ['notebook', 'conversations', 'diagnostics'] as const;
const STATUSES = ['readable', 'not_created', 'unavailable', 'not_checked'] as const;
const invalid = () => new Error('TLI returned incomplete or unsupported data checks. Update both clients if needed, then explicitly check again.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4000): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(); return value; }
function lines(value: unknown): string[] { if (!Array.isArray(value) || value.length > 30) throw invalid(); return value.map(item => text(item)); }

/** An omitted store check or a different paired host cannot become a green result. */
export function validateDataHealth(value: unknown, expectedHostId: string): DataHealth {
  const raw = object(value), host = object(raw.host), backup = object(raw.backup), guidance = object(raw.guidance);
  if (raw.schema_version !== 1 || backup.status !== 'unknown') throw invalid();
  const hostId = text(host.id, 256), checkedAt = text(raw.checked_at, 100);
  if (!expectedHostId || hostId !== expectedHostId) throw new Error('TLI could not confirm these checks belong to your paired host. Reconnect and check again.');
  if (!/^\d{4}-\d\d-\d\dT/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) throw invalid();
  if (!Array.isArray(raw.checks) || raw.checks.length !== CHECKS.length) throw invalid();
  const checks = raw.checks.map(value => {
    const check = object(value);
    if (!CHECKS.includes(check.id as typeof CHECKS[number]) || !STATUSES.includes(check.status as DataHealthStatus)) throw invalid();
    return { id: check.id as typeof CHECKS[number], label: text(check.label, 200), status: check.status as DataHealthStatus, detail: text(check.detail) };
  });
  if (new Set(checks.map(check => check.id)).size !== CHECKS.length) throw invalid();
  return { schema_version: 1, checked_at: checkedAt, host: { id: hostId, name: text(host.name, 256) }, scope: text(raw.scope), checks,
    backup: { status: 'unknown', detail: text(backup.detail) }, guidance: { summary: text(guidance.summary), steps: lines(guidance.steps), limitations: lines(guidance.limitations) } };
}
export const dataHealthLabel = (status: DataHealthStatus): string => ({ readable: 'Readable at check time', not_created: 'Not created', unavailable: 'Unavailable', not_checked: 'Not checked' })[status];

/** No polling or cache: one explicit check owns one ticket until it settles. */
export class DataHealthCheck {
  private ticket?: object;
  private state: DataHealthState = { busy: false, stale: false, error: '' };
  private listeners = new Set<(state: DataHealthState) => void>();
  get snapshot() { return this.state; }
  subscribe(listener: (state: DataHealthState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<DataHealthState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener(this.state)); }
  clear() { this.ticket = undefined; this.state = { busy: false, stale: false, error: '' }; this.listeners.forEach(listener => listener(this.state)); }
  suspend() {
    const interrupted = !!this.ticket; this.ticket = undefined;
    this.publish({ busy: false, stale: !!this.state.data, ...(interrupted ? { error: 'The check was interrupted. Check saved data again when connected.' } : {}) });
  }
  async check(api: Pick<Client, 'json'>, expectedHostId: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    if (this.ticket) return false;
    const ticket = {}; this.ticket = ticket;
    const current = () => this.ticket === ticket && isCurrent();
    this.publish({ busy: true, stale: !!this.state.data, error: '' });
    try {
      const data = validateDataHealth(await api.json('/api/intelligence/data-health'), expectedHostId);
      if (!current()) return false;
      this.publish({ data, checkedFor: api, stale: false, error: '' }); return true;
    } catch (error) {
      if (current()) this.publish({ stale: !!this.state.data, error: error instanceof Error ? error.message : 'TLI could not check this account’s saved data.' });
      return false;
    } finally {
      if (this.ticket === ticket) {
        this.ticket = undefined;
        this.publish({ busy: false, ...(!isCurrent() ? { error: 'The connection changed before this check completed. Check saved data again when connected.' } : {}) });
      }
    }
  }
}
