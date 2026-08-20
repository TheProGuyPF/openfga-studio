import type { Consistency } from '../../services/OpenFGAService';
import type { LatencyStats } from '../../utils/latencyStats';

export type BenchOp = 'check' | 'list-objects';

/** A single scenario to benchmark. `depth` orders the model depth-ladder. */
export interface BenchScenario {
  id: string;
  label: string;
  /** Relative resolution depth (0 = shallow direct, higher = deeper TTU/intersection). */
  depth: number;
  user: string;
  relation: string;
  /** Target object (for `check`). Ignored for list-objects. */
  object: string;
  /** Operation. Defaults to 'check'. */
  op?: BenchOp;
  /** Object type to enumerate (for `list-objects`). */
  listType?: string;
  /** True for rungs expected to resolve denied — so a 0-allowed result isn't flagged as a seed error. */
  expectDenied?: boolean;
  /** Short note on what path this exercises (shown in the UI). */
  note?: string;
}

export type CacheMode = 'cold' | 'warm';
export type LoadMode = 'sequential' | 'parallel';

export interface BenchmarkConfig {
  iterations: number;
  warmup: number;
  cacheMode: CacheMode;
  consistency: Consistency;
  loadMode: LoadMode;
  /** Concurrency for parallel load mode (hard-capped). */
  concurrency: number;
  timeoutMs: number;
}

/** Aggregated result for one scenario in one run. */
export interface ScenarioResult {
  scenario: BenchScenario;
  stats: LatencyStats;
  /** p50 with the per-env network/auth floor subtracted (≈ model-compute cost). */
  p50MinusFloor: number;
  errors: number;
  timeouts: number;
  /** Distribution of allowed/denied among successful samples (check ops only). */
  allowedCount: number;
  deniedCount: number;
  /** Mean object count returned (list-objects ops only). */
  avgObjects?: number;
}

export interface BenchmarkRun {
  /** Wall-clock ms since epoch (stamped by the caller after the run). */
  ts: number;
  envKey: string;
  storeId: string;
  authModelId: string;
  config: BenchmarkConfig;
  /** Network/auth floor (p50 of a near-zero-cost probe check), ms. */
  floorMs: number;
  results: ScenarioResult[];
}

/** Result of the batch-check vs N-singles head-to-head. */
export interface BatchDiagnostic {
  n: number;
  batchTotalMs: number;
  sequentialTotalMs: number;
  parallelTotalMs: number;
  /** Per-single-check stats within the sequential leg. */
  singleStats: LatencyStats;
  errors: number;
}
