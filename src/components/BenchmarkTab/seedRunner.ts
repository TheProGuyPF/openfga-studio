// In-app benchmark-store seeding. The UI equivalent of scripts/seed-benchmark-store.mjs,
// but using the app's authenticated OpenFGA client (no hand-pasted token needed).
// Callers MUST gate this to non-prod + canary before invoking.
import { OpenFGAService } from '../../services/OpenFGAService';
import { BENCHMARK_STORE_NAME, buildSeedTuples, type ScaleParams } from './seedData';

export interface SeedResult {
  storeId: string;
  modelId: string;
  written: number;
  createdStore: boolean;
}

export interface TeardownResult {
  found: boolean;
  storeId?: string;
}

export type SeedStep =
  | 'finding-store'
  | 'creating-store'
  | 'copying-model'
  | 'writing-tuples'
  | 'done';

async function findBenchmarkStore(): Promise<{ id: string; name: string } | undefined> {
  const stores = await OpenFGAService.listStores();
  return stores.find((s) => s.name === BENCHMARK_STORE_NAME);
}

/**
 * Create-or-reuse the benchmark store, copy the raw model from `sourceStoreId`,
 * and write the seed tuples for the chosen scale. Idempotent for the base chain
 * (writes ignore duplicates); higher scales add fresh cardinality each run, so
 * teardown-then-seed is the clean way to switch scales.
 */
export async function seedBenchmarkStore(
  sourceStoreId: string,
  scale: ScaleParams,
  onStep?: (step: SeedStep) => void,
): Promise<SeedResult> {
  if (!sourceStoreId) throw new Error('Pick a source store to copy the model from.');

  onStep?.('finding-store');
  const existing = await findBenchmarkStore();
  let storeId = existing?.id;
  let createdStore = false;
  if (!storeId) {
    onStep?.('creating-store');
    const created = await OpenFGAService.createStore(BENCHMARK_STORE_NAME);
    storeId = created.id;
    createdStore = true;
  }

  onStep?.('copying-model');
  const { model } = await OpenFGAService.getAuthorizationModelRaw(sourceStoreId);
  if (!model) throw new Error(`Source store ${sourceStoreId} has no authorization model.`);
  const { authorization_model_id: modelId } = await OpenFGAService.writeAuthorizationModelRaw(
    storeId,
    model,
  );

  onStep?.('writing-tuples');
  const tuples = buildSeedTuples(scale);
  const written = await OpenFGAService.writeTuples(storeId, tuples, modelId, 100);

  onStep?.('done');
  return { storeId, modelId, written, createdStore };
}

/**
 * Delete the benchmark store entirely (all seeded data + model). Deleting the
 * whole isolated store is the clean teardown at any scale — individual-tuple
 * deletes can't cover the generated cardinality.
 */
export async function teardownBenchmarkStore(): Promise<TeardownResult> {
  const store = await findBenchmarkStore();
  if (!store) return { found: false };
  await OpenFGAService.deleteStore(store.id);
  return { found: true, storeId: store.id };
}
