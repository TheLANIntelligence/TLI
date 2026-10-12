import { requireNativeModule, type NativeModule } from 'expo-modules-core';

export type TransportConfiguration = {
  /** Private IPv4 HTTPS origin, or a reviewed single-label .local hostname. */
  origin: string;
  /** Standard base64-encoded DER leaf certificate scanned from the desktop QR. */
  certificateDer: string;
  resolvedAddresses?: string[];
  nodeId?: string;
  publicKey?: string;
};

export type ConnectionHint = { origin: string; nodeId: string; name: string; addresses: string[] };
export type ConnectionProbe = TransportConfiguration & { nodeId: string; publicKey: string; timeoutMs?: number };
export type VerifiedConnection = { verified: true; origin: string; nodeId: string; publicKey: string; certificateSha256: string; resolvedAddresses: string[] };
export type FileRequest = { id: string; path: string; headers: Record<string, string>; fileUri?: string; fileName?: string; mimeType?: string };
export type DownloadResponse = TransportResponse & { fileUri?: string };

export type TransportRequest = {
  /** Unique among requests still in flight. Also identifies stream events. */
  id: string;
  /** Absolute path on the configured origin, optionally including a query. */
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  stream?: boolean;
};

export type TransportResponse = {
  status: number;
  /** Response header names are lower case. */
  headers: Record<string, string>;
  /** Empty for successful streamed responses. HTTP errors resolve with their body. */
  body: string;
};

export type TransportHeadersEvent = Omit<TransportResponse, 'body'> & { id: string };
export type TransportChunkEvent = { id: string; chunk: string };
export type TransportEvents = {
  onHeaders: (event: TransportHeadersEvent) => void;
  onChunk: (event: TransportChunkEvent) => void;
  onNetworkChanged: (event: { generation: number }) => void;
};

declare class TliTransportNativeModule extends NativeModule<TransportEvents> {
  /** Cancels previous requests and clears previous trust, even if configuration fails. */
  configure(configuration: TransportConfiguration): Promise<void>;
  request(request: TransportRequest): Promise<TransportResponse>;
  /** Raw POST, at most 8 MiB, only a file copied into this application's cache. */
  uploadFile(request: FileRequest & { fileUri: string }): Promise<TransportResponse>;
  /** Bounded 16 MiB native cache file; error responses remain bounded text. */
  downloadFile(request: FileRequest): Promise<DownloadResponse>;
  /** Android DNS-SD hints, never authorization. Explicitly unsupported on iOS. */
  discover(options: { timeoutMs?: number }): Promise<ConnectionHint[]>;
  /** Bounded private DNS hints; no credentials, identity or trust changes. */
  resolveConnection(options: { origin: string; timeoutMs?: number }): Promise<string[]>;
  /** Isolated pinned, signed challenge. Never sends a bearer or replaces trust. */
  probeConnection(options: ConnectionProbe): Promise<VerifiedConnection>;
  /** Isolated per-request pinning for reviewed helper status/start; does not change configure(). */
  requestHelper(configuration: TransportConfiguration & { certificateSha256: string }, request: TransportRequest): Promise<TransportResponse>;
  cancel(id: string): void;
  /** Cancels pending requests, drops connections and removes in-memory trust. */
  reset(): Promise<void>;
}

// Intentionally no web/Expo Go fallback: private node requests must use this module.
const TliTransport = requireNativeModule<TliTransportNativeModule>('TliTransport');
export default TliTransport;
