import { describe, it, expect } from 'vitest';
import { buildStructuredModel } from './modelGraph';
import { computeWeights, formatWeight, maxWeight } from './modelWeights';

const GITHUB_DSL = `model
  schema 1.1
type user
type organization
  relations
    define member: [user]
    define repo_admin: [user, organization#member]
type repo
  relations
    define owner: [organization]
    define admin: [user] or repo_admin from owner
    define maintainer: [user] or admin
    define reader: [user] or maintainer`;

const RECURSIVE_DSL = `model
  schema 1.1
type user
type folder
  relations
    define parent: [folder]
    define viewer: [user] or viewer from parent`;

describe('computeWeights', () => {
  const weights = computeWeights(buildStructuredModel(GITHUB_DSL));

  it('weights a direct assignment as 1', () => {
    expect(weights.byId.get('organization#member')?.worstCase).toBe(1);
    expect(weights.byId.get('organization#member')?.perType.get('user')).toBe(1);
    expect(weights.byId.get('repo#owner')?.perType.get('organization')).toBe(1);
  });

  it('adds a hop for a userset reference', () => {
    // [user, organization#member]: direct user = 1, via userset = 1 + member(1) = 2
    expect(weights.byId.get('organization#repo_admin')?.perType.get('user')).toBe(2);
  });

  it('adds a hop for tuple-to-userset and takes the union max', () => {
    // admin = [user](1) or (repo_admin from owner) = 1 + org#repo_admin(2) = 3
    expect(weights.byId.get('repo#admin')?.perType.get('user')).toBe(3);
  });

  it('propagates weight through chained computed usersets', () => {
    expect(weights.byId.get('repo#maintainer')?.worstCase).toBe(3);
    expect(weights.byId.get('repo#reader')?.worstCase).toBe(3);
  });

  it('lists all terminal types', () => {
    expect(weights.terminalTypes).toContain('user');
    expect(weights.terminalTypes).toContain('organization');
  });
});

describe('computeWeights — recursion', () => {
  const weights = computeWeights(buildStructuredModel(RECURSIVE_DSL));

  it('marks a self-referential relation as infinite', () => {
    const viewer = weights.byId.get('folder#viewer')!;
    expect(viewer.recursive).toBe(true);
    expect(viewer.worstCase).toBe('infinite');
  });

  it('keeps non-recursive relations bounded', () => {
    expect(weights.byId.get('folder#parent')?.worstCase).toBe(1);
  });
});

describe('weight helpers', () => {
  it('maxWeight treats infinite as the ceiling', () => {
    expect(maxWeight(3, 'infinite')).toBe('infinite');
    expect(maxWeight(3, 5)).toBe(5);
    expect(maxWeight(undefined, 2)).toBe(2);
  });

  it('formatWeight renders ∞ and dashes', () => {
    expect(formatWeight('infinite')).toBe('∞');
    expect(formatWeight(undefined)).toBe('–');
    expect(formatWeight(4)).toBe('4');
  });
});
