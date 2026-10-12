import { SSEParser } from './protocol';
import type { ChatEvent } from './types';

export type NativeRequest = { id: string; path: string; method: string; headers: Record<string, string>; body?: string; stream?: boolean };
export type NativeResponse = { status: number; headers: Record<string, string>; body: string };
export interface Transport {
  uploadFile?(options: {id:string;path:string;headers:Record<string,string>;fileUri:string;fileName?:string;mimeType?:string}): Promise<NativeResponse>;
  downloadFile?(options: {id:string;path:string;headers:Record<string,string>;fileName:string}): Promise<NativeResponse & {fileUri?:string}>;
  configure(options: { origin: string; certificateDer: string; nodeId?:string; publicKey?:string; resolvedAddresses?:string[] }): Promise<void>;
  discover?(options:{timeoutMs?:number}):Promise<{origin:string;nodeId:string;name:string;addresses:string[]}[]>;
  resolveConnection?(options:{origin:string;timeoutMs?:number}):Promise<string[]>;
  probeConnection?(options:{origin:string;certificateDer:string;nodeId:string;publicKey:string;resolvedAddresses?:string[];timeoutMs?:number}):Promise<{verified:true;origin:string;nodeId:string;publicKey:string;certificateSha256:string;resolvedAddresses:string[]}>;
  request(options: NativeRequest): Promise<NativeResponse>;
  cancel(id: string): void | Promise<void>;
  reset(): void | Promise<void>;
  addListener(event: 'onHeaders', listener: (event: { id: string; status: number; headers: Record<string, string> }) => void): { remove(): void };
  addListener(event: 'onChunk', listener: (event: { id: string; chunk: string }) => void): { remove(): void };
}
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export class InterruptedError extends Error { constructor() { super('Connection interrupted. Check conversation history and device status before trying again.'); } }
export function isConnectionError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return ['E_NETWORK', 'E_DISCOVERY', 'E_TLS_TRUST', 'E_CERTIFICATE', 'E_IDENTITY', 'E_LOCAL_NETWORK_PERMISSION', 'E_TIMEOUT', 'ETIMEDOUT', 'E_CONNECT', 'E_NO_ROUTE', 'E_OFFLINE'].includes(code);
}
let counter = 0;
export class Client {
  private active = new Set<string>();
  private mutations = new Set<string>();
  private paused = false;
  private observation = 0;
  get hasActiveMutations() { return !!this.mutations.size; }
  invalidateObservations() { this.observation++; }
  pause() { this.paused = true; this.invalidateObservations(); this.cancelAll(); }
  resume() { this.invalidateObservations(); this.paused = false; }
  private assertAvailable() { if (this.paused) throw Object.assign(new Error('The reviewed connection replacement is in progress. Wait for it to finish before making another request.'), { code: 'E_PAUSED' }); }
  constructor(readonly transport: Transport, readonly credential: string, private invalidated: () => void = () => {}, private disconnected: (error: unknown) => void = () => {}) {}
  private id() { return `tli-${Date.now()}-${++counter}`; }
  private headers(stream = false): Record<string, string> { return { ...(this.credential ? { Authorization: `Bearer ${this.credential}` } : {}), 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' }; }
  private validate(response: NativeResponse, observation: number) {
    if (response.status === 401 && observation === this.observation && !this.paused) this.invalidated();
    if (response.status < 200 || response.status >= 300) {
      let detail = `TLI returned ${response.status}.`;
      try { const data = JSON.parse(response.body); if (typeof data.detail === 'string') detail = data.detail; } catch {}
      throw new ApiError(detail, response.status);
    }
  }
  async json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    this.assertAvailable(); const observation = this.observation;
    const id = this.id(); this.active.add(id);
    if (!['GET', 'HEAD'].includes(method)) this.mutations.add(id);
    try {
      const response = await this.transport.request({ id, path, method, headers: this.headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      this.validate(response, observation);
      return response.body ? JSON.parse(response.body) as T : undefined as T;
    } catch (error) { if (observation === this.observation && !this.paused && isConnectionError(error)) this.disconnected(error); throw error; }
    finally { this.active.delete(id); this.mutations.delete(id); }
  }
  async text(path: string): Promise<NativeResponse> {
    this.assertAvailable(); const observation=this.observation,id=this.id();this.active.add(id);
    try {const response=await this.transport.request({id,path,method:'GET',headers:{...this.headers(),Accept:'text/html'}});this.validate(response,observation);return response;}
    catch(error){if(observation===this.observation&&!this.paused&&isConnectionError(error))this.disconnected(error);throw error;}
    finally{this.active.delete(id);}
  }
  async upload<T>(path:string,fileUri:string,fileName:string):Promise<T>{
    this.assertAvailable();if(!this.transport.uploadFile)throw new Error('Install the updated native app to send documents.');
    const observation=this.observation,id=this.id();this.active.add(id);this.mutations.add(id);
    try{const response=await this.transport.uploadFile({id,path,fileUri,fileName,headers:{...this.headers(),'Content-Type':'application/octet-stream'}});this.validate(response,observation);return JSON.parse(response.body) as T;}
    catch(error){if(observation===this.observation&&!this.paused&&isConnectionError(error))this.disconnected(error);throw error;}
    finally{this.active.delete(id);this.mutations.delete(id);}
  }
  async download(path:string,fileName:string):Promise<string>{
    this.assertAvailable();if(!this.transport.downloadFile)throw new Error('Install the updated native app to download app files.');
    const observation=this.observation,id=this.id();this.active.add(id);
    try{const response=await this.transport.downloadFile({id,path,fileName,headers:{...this.headers(),Accept:'application/zip'}});this.validate(response,observation);if(!response.fileUri)throw new Error('The download did not produce a file.');return response.fileUri;}
    catch(error){if(observation===this.observation&&!this.paused&&isConnectionError(error))this.disconnected(error);throw error;}
    finally{this.active.delete(id);}
  }
  async stream(path: string, body: unknown, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.assertAvailable(); const observation = this.observation;
    const id = this.id(); this.active.add(id);
    this.mutations.add(id);
    let done = false, status = 0, streamError: Error | undefined;
    const parser = new SSEParser(event => {
      if (event.type === 'error') streamError = new Error(event.detail || event.error || 'TLI could not complete this response.');
      if (event.type === 'done') done = true;
      onEvent(event);
    });
    const headers = this.transport.addListener('onHeaders', e => { if (e.id === id) status = e.status; });
    const chunks = this.transport.addListener('onChunk', e => {
      if (e.id !== id || status < 200 || status >= 300 || streamError || done) return;
      try { parser.push(e.chunk); } catch (error) { streamError = error as Error; void this.transport.cancel(id); }
    });
    try {
      const response = await this.transport.request({ id, path, method: 'POST', headers: this.headers(true), body: JSON.stringify(body), stream: true });
      this.validate(response, observation);
      parser.finish();
      if (streamError) throw streamError;
      if (!done) throw new InterruptedError();
    } catch (error) { if (observation === this.observation && !this.paused && isConnectionError(error)) this.disconnected(error); throw streamError || error; }
    finally { chunks.remove(); headers.remove(); this.active.delete(id); this.mutations.delete(id); }
  }
  cancelAll() { for (const id of this.active) void this.transport.cancel(id); }
}
