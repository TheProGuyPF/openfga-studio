// Apply engine: dependency-injected batch write / delete / read over a set of
// tuples, with bounded concurrency, per-batch failure capture, progress, and
// abort. The concurrency pool + AbortedError/throwIfAborted pattern is lifted
// from BenchmarkTab/benchmarkEngine.ts. IO is injected (OpenFGAService.writeTuples
// / deleteTuples / readFiltered are wired in by the component) so the engine is
// unit-testable with plain mocks.
import type { Tuple } from '../utils/migrationTransform';

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/** Run async `fn` over `items` with a bounded concurrency (lifted from benchmarkEngine). */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface ApplyProgress {
  done: number;
  total: number;
}

export interface BatchFailure {
  batchIndex: number;
  tuples: Tuple[];
  error: string;
}

export interface ApplyResult {
  written: number;
  /** Tuples whose write succeeded — the rollback set. */
  applied: Tuple[];
  /** Tuples whose batch errored. */
  failed: Tuple[];
  /** Tuples never attempted because the run was aborted. */
  pending: Tuple[];
  failures: BatchFailure[];
  aborted: boolean;
}

export interface ApplyOptions {
  /** Writes a single batch of tuples (idempotent, on_duplicate:'ignore'). */
  write: (tuples: Tuple[]) => Promise<void>;
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: ApplyProgress) => void;
}

function errMessage(err: unknown): string {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || String(err);
}

interface BatchRunOptions {
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: ApplyProgress) => void;
}

interface BatchRunResult {
  done: Tuple[];
  failed: Tuple[];
  pending: Tuple[];
  failures: BatchFailure[];
  aborted: boolean;
}

/**
 * Run `op` over `tuples` in batches with bounded concurrency. Never throws on a
 * batch error. On abort, workers stop taking new batches but every in-flight batch
 * is awaited, so `done`/`failed` are exact and `pending` is precisely the set that
 * was never attempted.
 */
async function runBatches(
  tuples: Tuple[],
  options: BatchRunOptions,
  op: (batch: Tuple[]) => Promise<void>,
): Promise<BatchRunResult> {
  const batches = chunk(tuples, options.batchSize ?? 40);
  const concurrency = Math.min(Math.max(1, options.concurrency ?? 5), batches.length);
  const total = tuples.length;

  const done: Tuple[] = [];
  const failed: Tuple[] = [];
  const failures: BatchFailure[] = [];
  let finished = 0;
  let next = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (options.signal?.aborted) return;
      const i = next++;
      if (i >= batches.length) return;
      const batch = batches[i];
      try {
        await op(batch);
        done.push(...batch);
      } catch (err) {
        failed.push(...batch);
        failures.push({ batchIndex: i, tuples: batch, error: errMessage(err) });
      } finally {
        finished += batch.length;
        options.onProgress?.({ done: finished, total });
      }
    }
  });
  await Promise.all(workers);

  const pending = batches.slice(Math.min(next, batches.length)).flat();
  return { done, failed, pending, failures, aborted: pending.length > 0 };
}

/**
 * Apply `tuples` in batches with bounded concurrency. Never throws on a batch
 * error — failures are captured and the run continues (mirrors the scripts'
 * `*-failures.json`). An abort returns exact partial results: `applied`, `failed`,
 * and `pending` (never attempted) partition the input.
 */
export async function applyTuples(tuples: Tuple[], options: ApplyOptions): Promise<ApplyResult> {
  const r = await runBatches(tuples, options, options.write);
  return {
    written: r.done.length,
    applied: r.done,
    failed: r.failed,
    pending: r.pending,
    failures: r.failures,
    aborted: r.aborted,
  };
}

/** Retry only the previously-failed tuples (resumable). Thin alias over applyTuples. */
export function retryFailed(failedTuples: Tuple[], options: ApplyOptions): Promise<ApplyResult> {
  return applyTuples(failedTuples, options);
}

export interface RollbackOptions {
  /**
   * Deletes a single batch of tuples. Must throw on any real failure; a tuple that
   * is already absent must NOT count as a failure (rollback stays idempotent).
   */
  del: (tuples: Tuple[]) => Promise<void>;
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: ApplyProgress) => void;
}

export interface RollbackResult {
  deleted: number;
  /** Tuples whose delete errored. */
  failed: Tuple[];
  /** Tuples never attempted because the run was aborted. */
  pending: Tuple[];
  failures: BatchFailure[];
  aborted: boolean;
}

/** Delete a previously-applied tuple set (durable rollback). */
export async function rollbackTuples(tuples: Tuple[], options: RollbackOptions): Promise<RollbackResult> {
  const r = await runBatches(tuples, options, options.del);
  return {
    deleted: r.done.length,
    failed: r.failed,
    pending: r.pending,
    failures: r.failures,
    aborted: r.aborted,
  };
}

export interface ExistingScanOptions {
  /** Returns EVERY existing tuple on an object (callers must follow pagination). */
  read: (object: string) => Promise<Tuple[]>;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: ApplyProgress) => void;
}

/**
 * Full (non-sampled) scan for tuples that already exist in the store, grouped by
 * object. Used to keep pre-existing tuples out of a run's rollback set: writes use
 * `on_duplicate:'ignore'`, so without this a rollback would delete tuples the run
 * never created. Fails closed — any read error or abort rejects, because a partial
 * scan would silently reintroduce that data-loss.
 */
export async function findExistingTuples(
  tuples: Tuple[],
  options: ExistingScanOptions,
): Promise<Set<string>> {
  const objects = [...new Set(tuples.map((t) => t.object))];
  const wanted = new Set(tuples.map(tupleKey));
  const existing = new Set<string>();
  let scanned = 0;

  await mapWithConcurrency(objects, options.concurrency ?? 8, async (object) => {
    throwIfAborted(options.signal);
    for (const t of await options.read(object)) {
      const key = tupleKey(t);
      if (wanted.has(key)) existing.add(key);
    }
    scanned++;
    options.onProgress?.({ done: scanned, total: objects.length });
  });
  return existing;
}

export function tupleKey(t: Tuple): string {
  return `${t.user}|${t.relation}|${t.object}`;
}

export interface DiffOptions {
  /** Returns the existing tuples on a given object (e.g. via readFiltered {object}). */
  read: (object: string) => Promise<Tuple[]>;
  /** Cap on distinct objects probed (keeps the dry-run cheap on big migrations). */
  sampleObjects?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface DiffResult {
  totalObjects: number;
  probedObjects: number;
  /** Among probed objects: tuples not yet present (would be created). */
  newCount: number;
  /** Among probed objects: tuples already present (writes are no-ops). */
  presentCount: number;
  newSample: Tuple[];
  presentSample: Tuple[];
  /** True when not every object could be probed (sample cap hit). */
  partial: boolean;
}

const DIFF_SAMPLE_TUPLES = 20;

/**
 * Dry-run diff: classify produced tuples as new vs already-present by reading the
 * live store. Groups by object and probes up to `sampleObjects` distinct objects
 * so the dry-run stays cheap; un-probed objects are reflected via `partial`.
 */
export async function dryRunDiff(tuples: Tuple[], options: DiffOptions): Promise<DiffResult> {
  const sampleObjects = options.sampleObjects ?? 50;
  const concurrency = options.concurrency ?? 5;

  const byObject = new Map<string, Tuple[]>();
  for (const t of tuples) {
    const arr = byObject.get(t.object);
    if (arr) arr.push(t);
    else byObject.set(t.object, [t]);
  }

  const objects = [...byObject.keys()];
  const probe = objects.slice(0, sampleObjects);
  const partial = probe.length < objects.length;

  const existingByObject = await mapWithConcurrency(probe, concurrency, async (object) => {
    throwIfAborted(options.signal);
    try {
      const existing = await options.read(object);
      return new Set(existing.map(tupleKey));
    } catch {
      return new Set<string>();
    }
  });

  let newCount = 0;
  let presentCount = 0;
  const newSample: Tuple[] = [];
  const presentSample: Tuple[] = [];

  probe.forEach((object, i) => {
    const existing = existingByObject[i];
    for (const t of byObject.get(object) ?? []) {
      if (existing.has(tupleKey(t))) {
        presentCount++;
        if (presentSample.length < DIFF_SAMPLE_TUPLES) presentSample.push(t);
      } else {
        newCount++;
        if (newSample.length < DIFF_SAMPLE_TUPLES) newSample.push(t);
      }
    }
  });

  return {
    totalObjects: objects.length,
    probedObjects: probe.length,
    newCount,
    presentCount,
    newSample,
    presentSample,
    partial,
  };
}
