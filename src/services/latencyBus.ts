// Latency sample bus.
//
// A tiny synchronous pub/sub (mirrors environmentStore's listener pattern) that
// carries per-request latency samples from the OpenFGA axios interceptors to any
// passive-monitoring UI. It keeps a bounded ring buffer of recent samples so a
// newly-mounted subscriber can render history immediately, then receives new
// samples as they arrive. Everything stays in memory — nothing is persisted or
// transmitted.

import type { EnvKey } from '../environments';

/** Logical OpenFGA operation a sample measured. Derived from the request URL. */
export type LatencyOp =
  | 'check'
  | 'batch-check'
  | 'list-objects'
  | 'read'
  | 'write'
  | 'other';

/** Outcome of the timed request, kept distinct so errors ≠ denials. */
export type LatencyStatus = 'ok' | 'error' | 'timeout';

export interface LatencySample {
  /** Monotonic id for React keys / de-dup. */
  id: number;
  op: LatencyOp;
  storeId: string | null;
  envKey: EnvKey;
  /** Wall-clock ms from request start to settle (network + auth + server). */
  elapsedMs: number;
  status: LatencyStatus;
  /** HTTP status when known (present on ok and on error responses). */
  httpStatus?: number;
  /** Wall-clock timestamp (ms since epoch) the sample settled. */
  ts: number;
}

const MAX_BUFFER = 500;

const buffer: LatencySample[] = [];
let seq = 0;

type Listener = (sample: LatencySample) => void;
const listeners = new Set<Listener>();

/** Derive the logical op from an OpenFGA request path. */
export function opFromUrl(url: string | undefined): LatencyOp {
  if (!url) return 'other';
  if (url.endsWith('/batch-check')) return 'batch-check';
  if (url.endsWith('/check')) return 'check';
  if (url.endsWith('/list-objects')) return 'list-objects';
  if (url.endsWith('/read')) return 'read';
  if (url.endsWith('/write')) return 'write';
  return 'other';
}

/** Publish a sample. Called from the axios response/error interceptors. */
export function publishLatency(sample: Omit<LatencySample, 'id'>): void {
  const full: LatencySample = { ...sample, id: ++seq };
  buffer.push(full);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  listeners.forEach((l) => l(full));
}

/** Snapshot of recent samples (oldest → newest), for initial render. */
export function getRecentSamples(): LatencySample[] {
  return buffer.slice();
}

export function subscribeLatency(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
