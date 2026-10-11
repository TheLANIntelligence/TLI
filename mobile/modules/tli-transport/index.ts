import { requireNativeModule, type NativeModule } from 'expo-modules-core';

export type TransportConfiguration = {
  /** HTTPS origin with a numeric private LAN IPv4 address. */
  origin: string;
  /** Standard base64-encoded DER leaf certificate scanned from the desktop QR. */
  certificateDer: string;
};

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
};

declare class TliTransportNativeModule extends NativeModule<TransportEvents> {
  /** Cancels previous requests and clears previous trust, even if configuration fails. */
  configure(configuration: TransportConfiguration): Promise<void>;
  request(request: TransportRequest): Promise<TransportResponse>;
  /** Isolated per-request pinning for reviewed helper status/start; does not change configure(). */
  requestHelper(configuration: TransportConfiguration & { certificateSha256: string }, request: TransportRequest): Promise<TransportResponse>;
  cancel(id: string): void;
  /** Cancels pending requests, drops connections and removes in-memory trust. */
  reset(): Promise<void>;
}

// Intentionally no web/Expo Go fallback: private node requests must use this module.
const TliTransport = requireNativeModule<TliTransportNativeModule>('TliTransport');
export default TliTransport;
