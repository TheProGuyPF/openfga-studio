import { describe, it, expect, vi } from 'vitest';
import { buildStructuredModel } from './modelGraph';
import { resolveCheck, type ResolutionDeps, type ResolutionNode } from './resolutionEngine';

const DSL = `model
  schema 1.1
type user
type team
  relations
    define member: [user]
type org
  relations
    define member: [user]
type repo
  relations
    define owner: [org]
    define direct_reader: [user, team#member]
    define admin: [user] or member from owner
    define reader: [user] or admin`;

const model = buildStructuredModel(DSL);

/** Build deps from a tuple store keyed `${object}#${relation}` -> subject list. */
function makeDeps(tuples: Record<string, string[]>): ResolutionDeps & { checkSpy: ReturnType<typeof vi.fn> } {
  const read = async (object: string, relation: string) => tuples[`${object}#${relation}`] ?? [];
  const checkSpy = vi.fn(async (items: { user: string; relation: string; object: string }[]) =>
    // Simulate the server for the direct-tuple case used by these fixtures.
    items.map((i) => (tuples[`${i.object}#${i.relation}`] ?? []).includes(i.user)),
  );
  return { model, read, check: checkSpy, checkSpy };
}

/** Depth-first search for a node matching a predicate. */
function find(node: ResolutionNode, pred: (n: ResolutionNode) => boolean): ResolutionNode | null {
  if (pred(node)) return node;
  for (const c of node.children) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

describe('resolveCheck', () => {
  it('allows via a direct tuple on a union branch', async () => {
    const deps = makeDeps({ 'repo:x#reader': ['user:anne'] });
    const tree = await resolveCheck({ user: 'user:anne', object: 'repo:x', relation: 'reader' }, deps, 'acl');
    expect(tree.status).toBe('allowed');
    expect(find(tree, (n) => n.kind === 'tuple' && n.label === 'user:anne')).not.toBeNull();
  });

  it('denies and still builds the full attempted tree', async () => {
    const deps = makeDeps({});
    const tree = await resolveCheck({ user: 'user:anne', object: 'repo:x', relation: 'reader' }, deps, 'full');
    expect(tree.status).toBe('denied');
    // reader = [user] or admin -> a union operator with an admin expansion
    expect(find(tree, (n) => n.kind === 'operator' && n.label === 'OR')).not.toBeNull();
    expect(find(tree, (n) => n.relation === 'admin')).not.toBeNull();
  });

  it('traverses a tuple-to-userset edge (member from owner)', async () => {
    const deps = makeDeps({
      'repo:x#owner': ['org:acme'],
      'org:acme#member': ['user:anne'],
    });
    const tree = await resolveCheck({ user: 'user:anne', object: 'repo:x', relation: 'admin' }, deps, 'full');
    expect(tree.status).toBe('allowed');
    const ttu = find(tree, (n) => n.kind === 'ttu');
    expect(ttu?.status).toBe('allowed');
    // The linked org's member relation should have been resolved.
    expect(find(tree, (n) => n.object === 'org:acme' && n.relation === 'member')).not.toBeNull();
  });

  it('resolves userset membership on a direct branch via a batched check', async () => {
    const deps = makeDeps({
      'repo:x#direct_reader': ['team:eng#member'],
      'team:eng#member': ['user:anne'],
    });
    const tree = await resolveCheck(
      { user: 'user:anne', object: 'repo:x', relation: 'direct_reader' },
      deps,
      'full',
    );
    expect(tree.status).toBe('allowed');
    expect(deps.checkSpy).toHaveBeenCalled();
    // The userset subject was probed with (user:anne, member, team:eng).
    const calledWith = deps.checkSpy.mock.calls.flatMap((c) => c[0]);
    expect(calledWith).toContainEqual({ user: 'user:anne', relation: 'member', object: 'team:eng' });
  });
});
