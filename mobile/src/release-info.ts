export type HostRelease = { source_id: string | null; backend_id: string | null; frontend_id: string | null; started_at: string; checked_at: string; identity_scope: string; capabilities: string[]; compatibility: { state: 'matched' | 'restart_required' | 'unknown'; reasons: string[] } };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const hash = (v: unknown) => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function hostRelease(value: unknown): HostRelease | undefined {
  const v = record(value) && value.release;
  if (!record(v) || v.schema_version !== 1 || v.protocol !== 'dependable-computers-v1' || ![v.source_id, v.backend_id, v.frontend_id].every(hash) || !text(v.started_at, 64) || !Number.isFinite(Date.parse(v.started_at)) || !text(v.checked_at, 64) || !Number.isFinite(Date.parse(v.checked_at)) || !text(v.identity_scope, 1000) || !Array.isArray(v.capabilities) || v.capabilities.length > 32 || !v.capabilities.every(s => text(s, 100)) || !record(v.compatibility) || !['matched', 'restart_required', 'unknown'].includes(v.compatibility.state) || !Array.isArray(v.compatibility.reasons) || v.compatibility.reasons.length > 12 || !v.compatibility.reasons.every(s => text(s, 1000))) return;
  if (v.compatibility.state !== 'unknown' && (!v.source_id || !v.backend_id || !v.frontend_id)) return;
  return v as HostRelease;
}
export function nativeBuildLabel(values: { nativeApplicationVersion: unknown; nativeBuildVersion: unknown; applicationId: unknown }, browser = false) {
  if (browser) return { label: 'Browser preview · no installed native build', id: 'Synthetic preview' };
  return { label: `TLI Companion ${text(values.nativeApplicationVersion, 64) ? values.nativeApplicationVersion : 'version unavailable'} · build ${text(values.nativeBuildVersion, 64) ? values.nativeBuildVersion : 'unavailable'}`, id: text(values.applicationId, 256) ? values.applicationId : 'Application identifier unavailable' };
}
export const releaseLabel = (value?: HostRelease) => !value || value.compatibility.state === 'unknown' ? 'Host release compatibility unknown' : value.compatibility.state === 'restart_required' ? 'Host restart required' : 'Host application files match its startup identity';
/** Explicit read only; lifecycle invalidation never repeats a request. */
export class ReleaseReview {
  value?: HostRelease; error = ''; busy = false; stale = false; private epoch = 0;
  suspend() { this.epoch++; this.busy = false; this.stale = true; }
  clear() { this.suspend(); this.value = undefined; this.error = ''; }
  async check(api: { json(path: string): Promise<unknown> }, current: () => boolean) {
    if (this.busy) return;
    const ticket = ++this.epoch; this.busy = true; this.error = '';
    try {
      const value = await api.json('/api/diagnostics/version');
      if (ticket !== this.epoch || !current()) return;
      this.value = hostRelease(value); this.stale = false;
      if (!this.value) this.error = 'This host did not provide a supported release identity. App/host feature compatibility remains unknown.';
    } catch { if (ticket === this.epoch && current()) { this.error = 'Host release identity could not be read. Check the connection before trying again.'; this.stale = true; } }
    finally { if (ticket === this.epoch) this.busy = false; }
  }
}
