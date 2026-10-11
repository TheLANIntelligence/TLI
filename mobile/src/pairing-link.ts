import { parsePairingCode } from './protocol';

type Invitation = { id: string; raw?: string; error?: string };
let staged: Invitation | undefined;
let sequence = 0;

/** Native URL ingress only stages review. No transport, credentials or storage. */
export function redirectPairingLink(path: string, now = Date.now()): string | null {
  if (!/^tli-companion(?:-beta)?:\/\//i.test(path)) return null;
  let url: URL;
  try { url = new URL(path); } catch { return '/pair?incoming=invalid'; }
  if (!url.pathname.startsWith('/pair') && url.hostname !== 'pair') return null;
  const id = String(++sequence);
  try { staged = { id, raw: JSON.stringify(parsePairingCode(path, now)) }; }
  catch { staged = { id, error: 'This pairing link is invalid or expired. Create a fresh code on your TLI desktop.' }; }
  // Only a non-secret one-time review reference enters navigation state.
  return '/pair?incoming=' + id;
}

export function takePairingLink(id: string): Invitation {
  if (!staged || staged.id !== id) return { id, error: 'This invitation is no longer available. Scan or open a fresh pairing code.' };
  const invitation = staged;
  staged = undefined;
  return invitation;
}
