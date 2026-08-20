// Benchmark-run persistence + export. Run *summaries* only (config + per-scenario
// aggregates) are kept in localStorage, keyed per store — mirrors the query-history
// pattern in QueryTab. Raw samples are never persisted. Everything stays in-browser
// or downloads to a local file; nothing is transmitted (data is internal/Restricted).
import type { BenchmarkRun } from './types';
import { formatMs } from '../../utils/latencyStats';

const MAX_RUNS = 25;

function storageKey(storeId: string): string {
  return `benchmarks-${storeId}`;
}

export function loadRuns(storeId: string): BenchmarkRun[] {
  if (!storeId) return [];
  try {
    const raw = localStorage.getItem(storageKey(storeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BenchmarkRun[]) : [];
  } catch {
    return [];
  }
}

export function saveRun(storeId: string, run: BenchmarkRun): BenchmarkRun[] {
  const runs = [run, ...loadRuns(storeId)].slice(0, MAX_RUNS);
  try {
    localStorage.setItem(storageKey(storeId), JSON.stringify(runs));
  } catch {
    // Persistence is best-effort (private mode / quota).
  }
  return runs;
}

export function clearRuns(storeId: string): void {
  try {
    localStorage.removeItem(storageKey(storeId));
  } catch {
    // ignore
  }
}

function triggerDownload(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportRunJson(run: BenchmarkRun): void {
  triggerDownload(
    `benchmark-${run.envKey}-${run.ts}.json`,
    JSON.stringify(run, null, 2),
    'application/json',
  );
}

export function exportRunCsv(run: BenchmarkRun): void {
  const header = [
    'env', 'store', 'scenario', 'op', 'depth', 'count',
    'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'mean_ms',
    'floor_ms', 'p50_minus_floor_ms', 'errors', 'timeouts', 'allowed', 'denied', 'avg_objects',
  ];
  const rows = run.results.map((r) =>
    [
      run.envKey,
      run.storeId,
      r.scenario.label,
      r.scenario.op ?? 'check',
      r.scenario.depth,
      r.stats.count,
      r.stats.p50.toFixed(1),
      r.stats.p95.toFixed(1),
      r.stats.p99.toFixed(1),
      r.stats.max.toFixed(1),
      r.stats.mean.toFixed(1),
      run.floorMs.toFixed(1),
      r.p50MinusFloor.toFixed(1),
      r.errors,
      r.timeouts,
      r.allowedCount,
      r.deniedCount,
      r.avgObjects !== undefined ? r.avgObjects.toFixed(1) : '',
    ].join(','),
  );
  triggerDownload(
    `benchmark-${run.envKey}-${run.ts}.csv`,
    [header.join(','), ...rows].join('\n'),
    'text/csv',
  );
}

/** Human-readable run title for lists. */
export function runTitle(run: BenchmarkRun): string {
  const d = new Date(run.ts);
  return `${run.envKey} · ${run.config.cacheMode} · ${run.config.iterations}× · ${d.toLocaleString()}`;
}

export { formatMs };
