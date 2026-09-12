import type { ChatEvent, PairingCode, Result, Bootstrap } from './types';

export function validateOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the secure home-network address from your TLI pairing code.');
  const parts = url.hostname.split('.').map(Number);
  const [a, b] = parts;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || parts.some(n => n < 0 || n > 255) || !(a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 169 && b === 254)) throw new Error('This beta connects to TLI on a private home-network IPv4 address.');
  return url.origin;
}

export function parsePairingCode(raw: string, now = Date.now()): PairingCode {
  if (raw.length > 14000) throw new Error('This is not a TLI pairing code.');
  let value: PairingCode;
  try { value = JSON.parse(raw); } catch { throw new Error('Scan the native companion pairing code in Phone Companion on TLI desktop.'); }
  if (!value || value.version !== 1 || typeof value.origin !== 'string' || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(value.token) || typeof value.certificate_der !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.certificate_der) || value.certificate_der.length < 128 || value.certificate_der.length > 12000 || typeof value.node_id !== 'string' || !value.node_id || typeof value.node_name !== 'string') throw new Error('This pairing code is incomplete. Create a new code on your TLI desktop.');
  const expiry = typeof value.expires_at === 'number' ? value.expires_at * 1000 : Date.parse(value.expires_at);
  if (!Number.isFinite(expiry) || expiry <= now) throw new Error('This pairing code has expired. Create a new code on your TLI desktop.');
  return { ...value, origin: validateOrigin(value.origin) };
}

// Native modules deliver complete Unicode text chunks, but SSE lines and JSON may
// span any number of chunks. Delimiters can also be split between CR and LF.
export class SSEParser {
  private buffer = '';
  private data: string[] = [];
  private frameSize = 0;
  constructor(private onEvent: (event: ChatEvent) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length + this.frameSize > 1_000_000) throw new Error('TLI sent an oversized stream event.');
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match || match[0] === '\r' && match.index === this.buffer.length - 1) return;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (!line) {
        if (this.data.length) {
          const raw = this.data.join('\n');
          this.data = []; this.frameSize = 0;
          const event: ChatEvent = JSON.parse(raw);
          if (event && ['meta', 'delta', 'done', 'error'].includes(event.type)) this.onEvent(event);
        }
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '');
        this.data.push(data); this.frameSize += data.length;
      }
    }
  }
  finish() { /* EOF is not an SSE frame delimiter. Discard any incomplete frame. */ }
}

export function chatRoute(bootstrap: Bootstrap | null, photo = false, message = ''): { path: string; streaming: boolean } {
  // Explicit control and diagnostics requests use TLI's existing intent engine.
  const action = /\b(turn|switch)\s+(?:\w+\s+){0,5}(on|off)\b|\b(toggle|dim)\b|\b(run|activate)\s+(?:\w+\s+){0,4}scene\b/i.test(message);
  const diagnostic = ['check my network', 'check the network', 'run network diagnostics', 'check host resources', 'check my system', 'run system diagnostics', 'check this device'].includes(message.trim().toLowerCase().replace(/[?.!]+$/, ''));
  if (photo || action || diagnostic) return { path: '/api/ai/chat/stream', streaming: true };
  const transport = bootstrap?.chat || bootstrap?.chat_transport;
  if (typeof transport === 'object' && transport && ['/api/ai/chat/stream', '/chat'].includes(transport.path)) return { path: transport.path, streaming: transport.path === '/api/ai/chat/stream' };
  if (bootstrap?.capabilities.chat_path === '/chat' || transport === 'json' || bootstrap?.capabilities.chat_transport === 'json') return { path: '/chat', streaming: false };
  return { path: '/api/ai/chat/stream', streaming: true };
}

export function outcome(result: Result): string {
  const rows = result.results;
  if (rows?.length) {
    const passed = rows.filter(r => r.ok === true).length;
    return passed === rows.length ? `${passed} of ${rows.length} actions completed` : passed > 0 ? `Partly completed · ${passed} of ${rows.length} actions succeeded` : `No actions succeeded · ${rows.length} failed`;
  }
  if (rows && !rows.length) return 'This scene has no actions';
  return result.ok === true ? 'Action completed' : 'Action did not complete';
}

export function formatTime(value?: string | number): string {
  if (value === undefined || value === null || value === '') return 'Time unavailable';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
