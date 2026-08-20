// Benchmark run engine. Pure orchestration over OpenFGAService — no React.
//
// Cold vs warm: the robust, API-safe cache lever is the consistency preference.
// Cold mode forces HIGHER_CONSISTENCY (OpenFGA bypasses the check-query cache, so
// every sample measures full resolution ≈ true model cost). Warm mode uses the
// chosen consistency (default MINIMIZE_LATENCY) and repeats identical requests, so
// the cache can serve 2nd+ hits — representative of steady-state prod.
import { OpenFGAService, type Consistency } from '../../services/OpenFGAService';
import { computeStats } from '../../utils/latencyStats';
import type {
  BenchScenario,
  BenchmarkConfig,
  BenchmarkRun,
  ScenarioResult,
  BatchDiagnostic,
} from './types';
import { BASELINE_PROBE } from './presets';

export const MAX_CONCURRENCY = 20;

/** Consistency actually sent given the cache mode (cold forces cache bypass). */
export function effectiveConsistency(config: BenchmarkConfig): Consistency {
  return config.cacheMode === 'cold' ? 'HIGHER_CONSISTENCY' : config.consistency;
}

interface Sample {
  ms: number;
  status: 'ok' | 'error' | 'timeout';
  allowed?: boolean;
  /** Objects returned (list-objects only). */
  objectCount?: number;
}

class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/** One timed op (check or list-objects). Never throws — classifies the outcome. */
async function timedOp(
  storeId: string,
  authModelId: string,
  scenario: BenchScenario,
  config: BenchmarkConfig,
  signal?: AbortSignal,
): Promise<Sample> {
  const consistency = effectiveConsistency(config);

  if (scenario.op === 'list-objects') {
    const t0 = performance.now();
    try {
      const { objects } = await OpenFGAService.listObjects(
        storeId,
        {
          user: scenario.user,
          relation: scenario.relation,
          type: scenario.listType || scenario.object,
          authorizationModelId: authModelId || undefined,
          consistency,
        },
        { timeoutMs: config.timeoutMs, signal },
      );
      return { ms: performance.now() - t0, status: 'ok', objectCount: objects.length };
    } catch (err) {
      const ms = performance.now() - t0;
      const code = (err as { code?: string }).code;
      return { ms, status: code === 'ECONNABORTED' ? 'timeout' : 'error' };
    }
  }

  const t0 = performance.now();
  const res = await OpenFGAService.checkRaw(
    storeId,
    { user: scenario.user, relation: scenario.relation, object: scenario.object },
    {
      authorizationModelId: authModelId || undefined,
      consistency,
      timeoutMs: config.timeoutMs,
      signal,
    },
  );
  const ms = performance.now() - t0;
  if (res.timedOut) return { ms, status: 'timeout' };
  if (res.error) return { ms, status: 'error' };
  return { ms, status: 'ok', allowed: res.allowed };
}

/** Run async `fn` over `items` with a bounded concurrency. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Collect measured samples for one scenario (warmup iterations discarded). */
async function runScenario(
  storeId: string,
  authModelId: string,
  scenario: BenchScenario,
  config: BenchmarkConfig,
  signal?: AbortSignal,
): Promise<Sample[]> {
  // Warmup runs sequentially to prime connection/token/DNS regardless of load mode.
  for (let i = 0; i < config.warmup; i++) {
    throwIfAborted(signal);
    await timedOp(storeId, authModelId, scenario, config, signal);
  }

  const iters = Array.from({ length: config.iterations }, (_, i) => i);
  if (config.loadMode === 'parallel') {
    const limit = Math.max(1, Math.min(config.concurrency, MAX_CONCURRENCY));
    return mapWithConcurrency(iters, limit, () => {
      throwIfAborted(signal);
      return timedOp(storeId, authModelId, scenario, config, signal);
    });
  }

  const samples: Sample[] = [];
  for (let i = 0; i < config.iterations; i++) {
    throwIfAborted(signal);
    samples.push(await timedOp(storeId, authModelId, scenario, config, signal));
  }
  return samples;
}

function aggregate(scenario: BenchScenario, samples: Sample[], floorMs: number): ScenarioResult {
  const ok = samples.filter((s) => s.status === 'ok');
  const stats = computeStats(ok.map((s) => s.ms));
  const objectCounts = ok
    .map((s) => s.objectCount)
    .filter((n): n is number => typeof n === 'number');
  return {
    scenario,
    stats,
    p50MinusFloor: Math.max(0, stats.p50 - floorMs),
    errors: samples.filter((s) => s.status === 'error').length,
    timeouts: samples.filter((s) => s.status === 'timeout').length,
    allowedCount: ok.filter((s) => s.allowed === true).length,
    deniedCount: ok.filter((s) => s.allowed === false).length,
    avgObjects: objectCounts.length
      ? objectCounts.reduce((a, b) => a + b, 0) / objectCounts.length
      : undefined,
  };
}

export interface RunProgress {
  scenarioId: string;
  done: number;
  total: number;
}

/**
 * Run the full benchmark: a baseline floor probe first, then each scenario.
 * The returned run has no `ts` — the caller stamps it (Date.now is unavailable in
 * some contexts; the component stamps on completion).
 */
export async function runBenchmark(
  storeId: string,
  authModelId: string,
  scenarios: BenchScenario[],
  config: BenchmarkConfig,
  envKey: string,
  signal?: AbortSignal,
  onProgress?: (p: RunProgress) => void,
): Promise<Omit<BenchmarkRun, 'ts'>> {
  // Baseline floor: p50 of the near-zero-cost probe in THIS env.
  const floorSamples = await runScenario(storeId, authModelId, BASELINE_PROBE, config, signal);
  const floorMs = computeStats(
    floorSamples.filter((s) => s.status === 'ok').map((s) => s.ms),
  ).p50;

  const results: ScenarioResult[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    throwIfAborted(signal);
    const scenario = scenarios[i];
    const samples = await runScenario(storeId, authModelId, scenario, config, signal);
    results.push(aggregate(scenario, samples, floorMs));
    onProgress?.({ scenarioId: scenario.id, done: i + 1, total: scenarios.length });
  }

  return { envKey, storeId, authModelId, config, floorMs, results };
}

/**
 * Batch-check vs N-singles head-to-head over the given scenarios (each scenario
 * contributes one check). Measures total wall-clock for: one batch-check of N,
 * N sequential single checks, and N parallel single checks.
 */
export async function runBatchDiagnostic(
  storeId: string,
  authModelId: string,
  scenarios: BenchScenario[],
  config: BenchmarkConfig,
  signal?: AbortSignal,
): Promise<BatchDiagnostic> {
  // Batch-check only applies to `check` scenarios; list-objects rungs are excluded.
  scenarios = scenarios.filter((s) => (s.op ?? 'check') === 'check');
  const n = scenarios.length;
  const consistency = effectiveConsistency(config);
  let errors = 0;

  if (n === 0) {
    return { n: 0, batchTotalMs: 0, sequentialTotalMs: 0, parallelTotalMs: 0, singleStats: computeStats([]), errors: 0 };
  }

  // Warmup one pass sequentially.
  for (const s of scenarios) {
    throwIfAborted(signal);
    await timedOp(storeId, authModelId, s, config, signal);
  }

  // Leg 1: one batch-check of N.
  throwIfAborted(signal);
  const tBatch = performance.now();
  const batchResults = await OpenFGAService.batchCheck(
    storeId,
    scenarios.map((s, i) => ({
      user: s.user,
      relation: s.relation,
      object: s.object,
      correlationId: `c${i}`,
    })),
    { authorizationModelId: authModelId || undefined, consistency, timeoutMs: config.timeoutMs, signal },
  );
  const batchTotalMs = performance.now() - tBatch;
  errors += batchResults.filter((r) => r.error).length;

  // Leg 2: N sequential singles.
  throwIfAborted(signal);
  const singleMs: number[] = [];
  const tSeq = performance.now();
  for (const s of scenarios) {
    throwIfAborted(signal);
    const sample = await timedOp(storeId, authModelId, s, config, signal);
    singleMs.push(sample.ms);
    if (sample.status !== 'ok') errors++;
  }
  const sequentialTotalMs = performance.now() - tSeq;

  // Leg 3: N parallel singles (bounded).
  throwIfAborted(signal);
  const limit = Math.max(1, Math.min(config.concurrency || n, MAX_CONCURRENCY));
  const tPar = performance.now();
  const parSamples = await mapWithConcurrency(scenarios, limit, (s) =>
    timedOp(storeId, authModelId, s, config, signal),
  );
  const parallelTotalMs = performance.now() - tPar;
  errors += parSamples.filter((s) => s.status !== 'ok').length;

  return {
    n,
    batchTotalMs,
    sequentialTotalMs,
    parallelTotalMs,
    singleStats: computeStats(singleMs),
    errors,
  };
}

export { AbortedError };
