import { ApiError, type Client } from './client';
import type { Bootstrap, Pairing, Preferences } from './types';

export type ConnectionIssue = { kind: 'unreachable' | 'trust' | 'permission' | 'credential' | 'incompatible' | 'cancelled' | 'storage' | 'server'; title: string; detail: string };
export class ConnectionError extends Error { constructor(readonly issue: ConnectionIssue) { super(issue.detail); } }
export function connectionIssue(error: unknown): ConnectionIssue {
  if (error instanceof ConnectionError) return error.issue;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (error instanceof ApiError && error.status === 401) return { kind: 'credential', title: 'Phone access was rejected', detail: 'This phone’s credential was rejected. Create a new pairing code on your TLI desktop to reconnect.' };
  if (code === 'E_IDENTITY') return { kind: 'trust', title: 'TLI identity could not be verified', detail: 'This address did not prove the TLI identity in your reviewed pairing. Check the desktop and review its pairing code before reconnecting. The saved identity will not be replaced automatically.' };
  if (['E_TLS_TRUST', 'E_CERTIFICATE'].includes(code)) return { kind: 'trust', title: 'Certificate could not be verified', detail: 'Check the TLI address and certificate on your desktop. Use a newly reviewed pairing code if they changed; the app will not bypass certificate checks.' };
  if (code === 'E_LOCAL_NETWORK_PERMISSION') return { kind: 'permission', title: 'Local network access needed', detail: 'Allow local network access in phone settings, then check the connection again.' };
  if (['E_TIMEOUT', 'ETIMEDOUT'].includes(code)) return { kind: 'unreachable', title: 'TLI did not respond in time', detail: 'The phone reported a timeout at the paired address. Check the desktop and your home-network or configured private-network route, then explicitly check again. This does not establish whether the AI is available.' };
  if (code === 'E_CONNECT') return { kind: 'unreachable', title: 'Could not connect to the paired address', detail: 'The phone could not establish a connection. Verify the exact address and HTTPS port in Phone Companion on the desktop. A refused or unreachable connection does not identify the cause.' };
  if (['E_NO_ROUTE', 'E_OFFLINE', 'E_DISCOVERY'].includes(code)) return { kind: 'unreachable', title: 'No network path to TLI', detail: 'No private route to the reviewed TLI address was found. Check its secure LAN setup and your home-network or configured private-network route. TLI will check again while the app is open; messages and commands are not replayed.' };
  if (code === 'E_NETWORK') return { kind: 'unreachable', title: 'TLI could not be reached', detail: 'Check the existing paired address, that TLI is running with HTTPS and LAN access enabled, and your home-network or configured private-network route. Then explicitly check again. The phone did not identify the cause.' };
  if (code === 'E_CANCELLED') return { kind: 'cancelled', title: 'Connection check interrupted', detail: 'Return to the app and explicitly check again. No message or command was replayed.' };
  return { kind: 'server', title: 'TLI connection check did not complete', detail: error instanceof Error ? error.message : 'TLI could not complete its connection checks. Check the desktop and try again.' };
}
const incompatible = (detail: string) => new ConnectionError({ kind: 'incompatible', title: 'App and TLI need compatible versions', detail });
export function validateBootstrap(value: unknown, expectedId: string): Bootstrap {
  const next = value as Bootstrap | undefined;
  if (!next || next.api_version !== 1) throw incompatible('This TLI connection API is unavailable or unsupported. Update TLI and Companion to compatible versions.');
  if (!next.node || typeof next.node.id !== 'string' || typeof next.node.name !== 'string' || next.node.id !== expectedId) throw new ConnectionError({ kind: 'trust', title: 'TLI identity could not be confirmed', detail: 'This response does not match the TLI identity in your reviewed pairing. Check the desktop and review a new code before replacing it.' });
  if (!next.capabilities || typeof next.capabilities.vision !== 'boolean') throw incompatible('TLI returned incomplete capability information. Update both clients if needed, then check again.');
  if (next.ai && (!['available', 'unavailable', 'unknown'].includes(next.ai.status) || typeof next.ai.detail !== 'string' || typeof next.ai.checked_at !== 'string' || !Number.isFinite(Date.parse(next.ai.checked_at)))) throw incompatible('TLI returned unsupported AI readiness information. Check the desktop version and try again.');
  return next;
}
export function validatePreferences(value: unknown): Preferences {
  const prefs = value as Preferences | undefined;
  if (!prefs || !['light', 'dark', 'system'].includes(prefs.theme) || !Array.isArray(prefs.favorite_devices) || !Array.isArray(prefs.favorite_scenes) || [...prefs.favorite_devices, ...prefs.favorite_scenes].some(id => typeof id !== 'string')) throw incompatible('TLI returned incomplete companion preferences. Check the desktop and try again.');
  return prefs;
}
export async function readConnection(api: Pick<Client, 'json'>, pairing: Pick<Pairing, 'node_id'>) {
  const [raw, preferences] = await Promise.all([api.json('/api/companion/v1/bootstrap'), api.json('/api/companion/v1/preferences')]);
  return { bootstrap: validateBootstrap(raw, pairing.node_id), preferences: validatePreferences(preferences) };
}
export class LatestConnectionCheck {
  private current = 0;
  begin() { return ++this.current; }
  invalidate() { this.current++; }
  accepts(ticket: number, sessionCurrent: boolean) { return this.current === ticket && sessionCurrent; }
}
