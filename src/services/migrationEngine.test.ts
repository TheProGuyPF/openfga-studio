import { describe, it, expect, vi } from 'vitest';
import { applyTuples, rollbackTuples, retryFailed, dryRunDiff, findExistingTuples } from './migrationEngine';
import type { Tuple } from '../utils/migrationTransform';

function makeTuples(n: number): Tuple[] {
  return Array.from({ length: n }, (_, i) => ({
    user: `user:u${i}`,
    relation: 'member',
    object: `org:o${i}`,
  }));
}

describe('applyTuples', () => {
  it('writes all tuples in batches and reports progress', async () => {
    const tuples = makeTuples(10);
    const write = vi.fn(async () => {});
    const progress: number[] = [];
    const res = await applyTuples(tuples, {
      write,
      batchSize: 4,
      concurrency: 2,
      onProgress: (p) => progress.push(p.done),
    });
    expect(res.written).toBe(10);
    expect(res.failed).toEqual([]);
    expect(res.aborted).toBe(false);
    // 10 tuples / batch 4 → 3 batches (4,4,2).
    expect(write).toHaveBeenCalledTimes(3);
    expect(progress.at(-1)).toBe(10);
  });

  it('captures per-batch failures and keeps going', async () => {
    const tuples = makeTuples(9);
    const write = vi.fn(async (batch: Tuple[]) => {
      // Fail the batch containing u4.
      if (batch.some((t) => t.user === 'user:u4')) throw new Error('boom');
    });
    const res = await applyTuples(tuples, { write, batchSize: 3, concurrency: 1 });
    expect(res.written).toBe(6);
    expect(res.failed.map((t) => t.user)).toEqual(['user:u3', 'user:u4', 'user:u5']);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].error).toBe('boom');
  });

  it('surfaces axios-style error messages', async () => {
    const write = vi.fn(async () => {
      throw { response: { data: { message: 'validation error' } } };
    });
    const res = await applyTuples(makeTuples(2), { write, batchSize: 2 });
    expect(res.failures[0].error).toBe('validation error');
  });

  it('stops early when aborted and returns partial results', async () => {
    const controller = new AbortController();
    const write = vi.fn(async (batch: Tuple[]) => {
      if (batch.some((t) => t.user === 'user:u2')) controller.abort();
    });
    const res = await applyTuples(makeTuples(9), {
      write,
      batchSize: 3,
      concurrency: 1,
      signal: controller.signal,
    });
    expect(res.aborted).toBe(true);
    expect(res.written).toBeLessThan(9);
  });
});

describe('applyTuples abort bookkeeping', () => {
  it('partitions input into applied / failed / pending after an abort', async () => {
    const controller = new AbortController();
    const tuples = makeTuples(9);
    const write = vi.fn(async (batch: Tuple[]) => {
      if (batch.some((t) => t.user === 'user:u2')) controller.abort();
    });
    const res = await applyTuples(tuples, { write, batchSize: 3, concurrency: 1, signal: controller.signal });
    expect(res.aborted).toBe(true);
    expect(res.applied.map((t) => t.user)).toEqual(['user:u0', 'user:u1', 'user:u2']);
    expect(res.pending.map((t) => t.user)).toEqual(['user:u3', 'user:u4', 'user:u5', 'user:u6', 'user:u7', 'user:u8']);
    expect(res.failed).toEqual([]);
    expect(res.applied.length + res.failed.length + res.pending.length).toBe(9);
  });

  it('awaits in-flight batches so their results are counted', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const write = vi.fn(async (batch: Tuple[]) => {
      if (batch[0].user === 'user:u0') await gate;
      else if (batch[0].user === 'user:u3') controller.abort();
    });
    const p = applyTuples(makeTuples(9), { write, batchSize: 3, concurrency: 2, signal: controller.signal });
    setTimeout(release, 10);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.applied.map((t) => t.user).sort()).toEqual(['user:u0', 'user:u1', 'user:u2', 'user:u3', 'user:u4', 'user:u5']);
    expect(res.pending.map((t) => t.user)).toEqual(['user:u6', 'user:u7', 'user:u8']);
  });

  it('reports aborted false when abort fires after every batch was attempted', async () => {
    const controller = new AbortController();
    const write = vi.fn(async () => controller.abort());
    const res = await applyTuples(makeTuples(3), { write, batchSize: 3, concurrency: 1, signal: controller.signal });
    expect(res.aborted).toBe(false);
    expect(res.applied).toHaveLength(3);
  });
});

describe('retryFailed', () => {
  it('re-applies only the failed subset', async () => {
    const failed = makeTuples(3);
    const write = vi.fn(async () => {});
    const res = await retryFailed(failed, { write, batchSize: 40 });
    expect(res.written).toBe(3);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('rollbackTuples', () => {
  it('deletes tuples and tolerates per-batch failures', async () => {
    const tuples = makeTuples(6);
    const del = vi.fn(async (batch: Tuple[]) => {
      if (batch.some((t) => t.user === 'user:u3')) throw new Error('missing');
    });
    const res = await rollbackTuples(tuples, { del, batchSize: 3, concurrency: 1 });
    expect(res.deleted).toBe(3);
    expect(res.failures).toHaveLength(1);
    expect(res.failed.map((t) => t.user)).toEqual(['user:u3', 'user:u4', 'user:u5']);
    expect(res.pending).toEqual([]);
  });
});

describe('findExistingTuples', () => {
  const tuples: Tuple[] = [
    { user: 'user:a', relation: 'member', object: 'org:1' },
    { user: 'user:b', relation: 'member', object: 'org:1' },
    { user: 'user:c', relation: 'member', object: 'org:2' },
  ];

  it('returns the keys of tuples already present, across every object', async () => {
    const read = vi.fn(async (object: string) =>
      object === 'org:1'
        ? [{ user: 'user:a', relation: 'member', object: 'org:1' }, { user: 'user:zzz', relation: 'member', object: 'org:1' }]
        : [{ user: 'user:c', relation: 'member', object: 'org:2' }],
    );
    const existing = await findExistingTuples(tuples, { read });
    expect([...existing].sort()).toEqual(['user:a|member|org:1', 'user:c|member|org:2']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('fails closed when any read errors', async () => {
    const read = vi.fn(async (object: string) => {
      if (object === 'org:2') throw new Error('401');
      return [];
    });
    await expect(findExistingTuples(tuples, { read })).rejects.toThrow('401');
  });

  it('rejects on abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(findExistingTuples(tuples, { read: async () => [], signal: controller.signal })).rejects.toThrow('aborted');
  });
});

describe('dryRunDiff', () => {
  it('classifies produced tuples as new vs already-present', async () => {
    const tuples: Tuple[] = [
      { user: 'user:a', relation: 'member', object: 'org:1' },
      { user: 'user:b', relation: 'member', object: 'org:1' },
      { user: 'user:c', relation: 'member', object: 'org:2' },
    ];
    // org:1 already has user:a; org:2 is empty.
    const read = vi.fn(async (object: string) =>
      object === 'org:1' ? [{ user: 'user:a', relation: 'member', object: 'org:1' }] : [],
    );
    const diff = await dryRunDiff(tuples, { read });
    expect(diff.presentCount).toBe(1);
    expect(diff.newCount).toBe(2);
    expect(diff.partial).toBe(false);
    expect(diff.totalObjects).toBe(2);
  });

  it('marks partial when the object sample cap is hit', async () => {
    const tuples: Tuple[] = [
      { user: 'user:a', relation: 'member', object: 'org:1' },
      { user: 'user:b', relation: 'member', object: 'org:2' },
    ];
    const read = vi.fn(async () => []);
    const diff = await dryRunDiff(tuples, { read, sampleObjects: 1 });
    expect(diff.partial).toBe(true);
    expect(diff.probedObjects).toBe(1);
    expect(diff.newCount).toBe(1);
  });
});
