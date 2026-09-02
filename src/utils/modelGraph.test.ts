import { describe, it, expect } from 'vitest';
import { buildStructuredModel, buildDiagram, rewriteToDsl } from './modelGraph';

const GITHUB_DSL = `model
  schema 1.1
type user
type organization
  relations
    define member: [user]
    define owner: [user]
    define repo_admin: [user, organization#member]
type repo
  relations
    define owner: [organization]
    define admin: [user] or repo_admin from owner
    define maintainer: [user] or admin
    define writer: [user] or maintainer
    define reader: [user] or writer
    define blocked: [user]
    define viewer: reader but not blocked
    define locked_admin: admin and owner`;

describe('buildStructuredModel', () => {
  const model = buildStructuredModel(GITHUB_DSL);

  it('parses all types and relations', () => {
    expect(model.types.map((t) => t.name).sort()).toEqual(['organization', 'repo', 'user']);
    const repo = model.types.find((t) => t.name === 'repo')!;
    expect(repo.relations.map((r) => r.name)).toContain('reader');
  });

  it('represents `[user] or X` as a union with a direct leaf', () => {
    const admin = model.relationsById.get('repo#admin')!;
    expect(admin.rewrite.kind).toBe('union');
    if (admin.rewrite.kind === 'union') {
      expect(admin.rewrite.children.map((c) => c.kind)).toEqual(['this', 'ttu']);
      const ttu = admin.rewrite.children[1];
      if (ttu.kind === 'ttu') {
        expect(ttu.tupleset).toBe('owner');
        expect(ttu.computedRelation).toBe('repo_admin');
      }
    }
  });

  it('represents `but not` as a difference', () => {
    const viewer = model.relationsById.get('repo#viewer')!;
    expect(viewer.rewrite.kind).toBe('difference');
    if (viewer.rewrite.kind === 'difference') {
      expect(viewer.rewrite.base.kind).toBe('computed');
      expect(viewer.rewrite.subtract.kind).toBe('computed');
    }
  });

  it('represents `and` as an intersection', () => {
    const locked = model.relationsById.get('repo#locked_admin')!;
    expect(locked.rewrite.kind).toBe('intersection');
  });

  it('captures directly-related user types including usersets', () => {
    const repoAdmin = model.relationsById.get('organization#repo_admin')!;
    const refs = repoAdmin.directlyRelated;
    expect(refs.some((d) => d.type === 'user')).toBe(true);
    expect(refs.some((d) => d.type === 'organization' && d.relation === 'member')).toBe(true);
  });

  it('round-trips a rewrite to a readable DSL snippet', () => {
    const reader = model.relationsById.get('repo#reader')!;
    expect(rewriteToDsl(reader.rewrite, reader.directlyRelated)).toContain('or');
  });

  it('accepts a JSON model as input', () => {
    const json = JSON.stringify({
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    });
    const m = buildStructuredModel(json);
    expect(m.relationsById.get('doc#viewer')?.rewrite.kind).toBe('this');
  });
});

describe('buildDiagram', () => {
  const model = buildStructuredModel(GITHUB_DSL);
  const diagram = buildDiagram(model);

  it('emits a node per type and per relation', () => {
    expect(diagram.nodes.some((n) => n.id === 'type:repo' && n.kind === 'type')).toBe(true);
    expect(diagram.nodes.some((n) => n.id === 'rel:repo#reader' && n.kind === 'relation')).toBe(true);
  });

  it('links a type to its relations', () => {
    expect(
      diagram.edges.some(
        (e) => e.kind === 'owns' && e.source === 'type:repo' && e.target === 'rel:repo#reader',
      ),
    ).toBe(true);
  });

  it('links a computed userset to its referenced relation', () => {
    expect(
      diagram.edges.some(
        (e) => e.kind === 'computed' && e.source === 'rel:repo#reader' && e.target === 'rel:repo#writer',
      ),
    ).toBe(true);
  });

  it('emits a labelled tuple-to-userset edge', () => {
    const ttuEdge = diagram.edges.find((e) => e.kind === 'ttu' && e.source === 'rel:repo#admin');
    expect(ttuEdge).toBeDefined();
    expect(ttuEdge?.label).toContain('from');
  });
});
