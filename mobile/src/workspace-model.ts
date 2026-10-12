import type { ChatEvent, Message } from './types';

export type ComputeSelection = { peer_id: string; trust_revision: string; resource_id: string; resource_revision: string };
export type ConversationSettings = { compute_selection: ComputeSelection | null; settings_revision: number };
export function validSelection(value: unknown): value is ComputeSelection {
  const v = value as ComputeSelection | null;
  return !!v && typeof v.peer_id === 'string' && v.peer_id.length > 0 && v.peer_id.length <= 128 &&
    [v.trust_revision, v.resource_id, v.resource_revision].every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x));
}
export function settings(value: unknown): ConversationSettings {
  const v = value as ConversationSettings;
  if (!v || !Number.isInteger(v.settings_revision) || v.settings_revision < 0 || v.compute_selection !== null && !validSelection(v.compute_selection)) throw new Error('The host returned invalid conversation settings. Refresh before changing models.');
  return v;
}
export type HostRun = {
  id: string; request_id?:string; kind: 'chat' | 'builder_create' | 'builder_revise';
  status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  conversation_id?: string; cursor: number; events: { id: number; event: ChatEvent }[];
  text: string; metadata?: Partial<ChatEvent>; result?: Record<string, any>; error?: string;
};
export const terminalRun = (run: HostRun) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
export function validateRun(value: unknown, expectedId?: string): HostRun {
  const v = value as HostRun;
  if (!v || typeof v.id !== 'string' || expectedId && v.id !== expectedId && v.request_id!==expectedId || !['chat','builder_create','builder_revise'].includes(v.kind) || !['accepted','running','completed','failed','cancelled','interrupted'].includes(v.status) || !Number.isInteger(v.cursor) || v.cursor < 0 || typeof v.text !== 'string' || !Array.isArray(v.events) || v.events.some(e => !Number.isInteger(e.id) || e.id < 1 || !e.event || !['meta','delta','done','error'].includes(e.event.type))) throw new Error('The host returned an invalid saved run. The request was not resent.');
  return v;
}
export function runMessage(run: HostRun): Message {
  const {host,...metadata}=run.metadata||{};
  return { ...metadata,host:typeof host==='string'?host:host?.name, role: 'assistant', content: run.text || run.result?.reply || '', state: run.status === 'completed' ? 'complete' : terminalRun(run) ? 'interrupted' : 'streaming' };
}
export type WorkspaceEvent = { id: number; kind: string; resource_id: string };
export function workspacePage(value: unknown): { epoch: string; cursor: number; reset: boolean; events: WorkspaceEvent[] } {
  const v = value as any;
  if (!v || typeof v.epoch !== 'string' || !Number.isInteger(v.cursor) || v.cursor < 0 || typeof v.reset !== 'boolean' || !Array.isArray(v.events) || v.events.some((e: any) => !Number.isInteger(e.id) || typeof e.kind !== 'string' || typeof e.resource_id !== 'string')) throw new Error('Workspace changes could not be read.');
  return v;
}
