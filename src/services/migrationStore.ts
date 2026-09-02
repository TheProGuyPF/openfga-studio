// Durable run persistence for the Migrate tab: a thin promise wrapper over the
// native IndexedDB API (no new dependency). Run records carry a manifest (for
// reproducibility/audit) plus the applied-tuple set + failures, so rollback and
// retry-failed survive a page reload. Applied-tuple sets can be MB-scale, which
// is why this is IndexedDB (async, large quota, structured) rather than
// localStorage. Every call is wrapped in try/catch; when IndexedDB is
// unavailable (e.g. private mode) the API degrades gracefully (empty lists /
// false), and the UI falls back to session-only rollback + downloaded files.
//
// SAFETY: everything stays in-browser. Nothing here transmits data anywhere.
import type { MigrationTemplate, Tuple } from '../utils/migrationTransform';

const DB_NAME = 'openfga-studio-migrations';
const STORE = 'runs';
const DB_VERSION = 1;

export type RunStatus = 'applied' | 'partial' | 'failed' | 'rolledback';

/** Reproducibility/audit header persisted with every run. */
export interface RunManifest {
  id: string;
  envKey: string;
  storeId: string;
  storeName?: string;
  ts: number;
  modelId: string;
  templateName: string;
  csvName: string;
  csvHash: string;
  counts: { produced: number; written: number; failed: number };
  status: RunStatus;
}

export interface RunRecord extends RunManifest {
  config: MigrationTemplate;
  /** Successfully-applied tuples (the rollback set). */
  tuples: Tuple[];
  /** Tuples whose batch failed (the retry set). */
  failures: Tuple[];
}

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = fn(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

/** Persist (or overwrite) a run record. Returns false if storage is unavailable. */
export async function saveRun(record: RunRecord): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  try {
    await tx('readwrite', (store) => store.put(record));
    return true;
  } catch (err) {
    console.warn('migrationStore.saveRun failed:', err);
    return false;
  }
}

/** List runs for a given env + store, newest first. */
export async function listRuns(envKey: string, storeId: string): Promise<RunRecord[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    const all = await tx<RunRecord[]>('readonly', (store) => store.getAll() as IDBRequest<RunRecord[]>);
    return all
      .filter((r) => r.envKey === envKey && r.storeId === storeId)
      .sort((a, b) => b.ts - a.ts);
  } catch (err) {
    console.warn('migrationStore.listRuns failed:', err);
    return [];
  }
}

export async function getRun(id: string): Promise<RunRecord | null> {
  if (!isIndexedDbAvailable()) return null;
  try {
    const rec = await tx<RunRecord | undefined>('readonly', (store) => store.get(id) as IDBRequest<RunRecord | undefined>);
    return rec ?? null;
  } catch (err) {
    console.warn('migrationStore.getRun failed:', err);
    return null;
  }
}

export async function deleteRun(id: string): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  try {
    await tx('readwrite', (store) => store.delete(id));
    return true;
  } catch (err) {
    console.warn('migrationStore.deleteRun failed:', err);
    return false;
  }
}
