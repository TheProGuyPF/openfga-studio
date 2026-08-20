// Persistent, per-(environment, store) history of checks and lookups.
//
// Store IDs are already unique per OpenFGA instance, so the env in the key is
// belt-and-suspenders — but it also lets a future combined view label entries by
// environment. FIFO-capped; localStorage-backed; pub/sub so open panels refresh.
import type { EnvKey } from '../environments';
import { getCurrentEnvKey } from './environmentStore';

export type HistoryOp = 'check' | 'list-objects' | 'read';
export type HistoryOutcome = 'allowed' | 'denied' | 'error';

export interface HistoryEntry {
  id: string;
  op: HistoryOp;
  envKey: EnvKey;
  storeId: string;
  authModelId?: string;
  ts: number;
  /** check: the tuple; list-objects: user + relation + objectType. */
  user?: string;
  relation?: string;
  object?: string;
  objectType?: string;
  /** read: the filter used. */
  filters?: { user?: string; relation?: string; object?: string };
  context?: Record<string, string | number | boolean>;
  outcome: HistoryOutcome;
  allowed?: boolean;
  objectCount?: number;
  error?: string;
  latencyMs?: number;
  /** Human-readable one-liner for display. */
  label: string;
}

const MAX_ENTRIES = 200;

function storageKey(envKey: string, storeId: string): string {
  return `openfga-studio.history.${envKey}.${storeId}`;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((l) => l());
}

function read(envKey: string, storeId: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(envKey, storeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function write(envKey: string, storeId: string, entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(storageKey(envKey, storeId), JSON.stringify(entries));
  } catch {
    // best-effort (quota / private mode)
  }
}

export function getHistory(envKey: string, storeId: string): HistoryEntry[] {
  return read(envKey, storeId);
}

/** Fields the caller supplies; id/envKey/ts are stamped here. */
export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'envKey' | 'ts'>;

export function addHistoryEntry(entry: NewHistoryEntry): HistoryEntry {
  const envKey = getCurrentEnvKey();
  const full: HistoryEntry = {
    ...entry,
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.round(performance.now())}`,
    envKey,
    ts: Date.now(),
  };
  const next = [full, ...read(envKey, entry.storeId)].slice(0, MAX_ENTRIES);
  write(envKey, entry.storeId, next);
  emit();
  return full;
}

export function deleteHistoryEntry(envKey: string, storeId: string, id: string): void {
  write(
    envKey,
    storeId,
    read(envKey, storeId).filter((e) => e.id !== id),
  );
  emit();
}

export function clearHistory(envKey: string, storeId: string): void {
  try {
    localStorage.removeItem(storageKey(envKey, storeId));
  } catch {
    // ignore
  }
  emit();
}

export function subscribeHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * One-time migration of the legacy per-store query list (`queries-${storeId}`,
 * capped at 10, checks only) into the new per-(env,store) history. No-op after
 * the legacy key is gone.
 */
export function migrateLegacyQueries(envKey: string, storeId: string): void {
  if (!storeId) return;
  const legacyKey = `queries-${storeId}`;
  let legacy: unknown;
  try {
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return;
    legacy = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(legacy)) return;

  interface LegacyQuery {
    timestamp: number;
    query: { user: string; relation: string; object: string };
    result: { allowed: boolean };
    queryText?: string;
    latencyMs?: number;
  }

  const existing = read(envKey, storeId);
  const seen = new Set(existing.map((e) => e.ts));
  const migrated: HistoryEntry[] = (legacy as LegacyQuery[])
    .filter((q) => q?.query && !seen.has(q.timestamp))
    .map((q, i) => ({
      id: `legacy-${q.timestamp}-${i}`,
      op: 'check' as const,
      envKey: envKey as EnvKey,
      storeId,
      ts: q.timestamp,
      user: q.query.user,
      relation: q.query.relation,
      object: q.query.object,
      outcome: q.result?.allowed ? ('allowed' as const) : ('denied' as const),
      allowed: q.result?.allowed,
      latencyMs: q.latencyMs,
      label: q.queryText || `${q.query.user} · ${q.query.relation} · ${q.query.object}`,
    }));

  if (migrated.length > 0) {
    const merged = [...existing, ...migrated].sort((a, b) => b.ts - a.ts).slice(0, MAX_ENTRIES);
    write(envKey, storeId, merged);
    emit();
  }
  try {
    localStorage.removeItem(legacyKey);
  } catch {
    // ignore
  }
}

// ---- Export helpers ----------------------------------------------------------

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

export function exportHistoryJson(entries: HistoryEntry[]): void {
  triggerDownload(`history-${Date.now()}.json`, JSON.stringify(entries, null, 2), 'application/json');
}

export function exportHistoryCsv(entries: HistoryEntry[]): void {
  const header = ['ts', 'env', 'store', 'op', 'user', 'relation', 'object', 'objectType', 'outcome', 'objects', 'latency_ms', 'error'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) =>
    [
      new Date(e.ts).toISOString(),
      e.envKey,
      e.storeId,
      e.op,
      e.user ?? '',
      e.relation ?? '',
      e.object ?? '',
      e.objectType ?? '',
      e.outcome,
      e.objectCount ?? '',
      e.latencyMs != null ? Math.round(e.latencyMs) : '',
      e.error ?? '',
    ]
      .map(esc)
      .join(','),
  );
  triggerDownload(`history-${Date.now()}.csv`, [header.join(','), ...rows].join('\n'), 'text/csv');
}
