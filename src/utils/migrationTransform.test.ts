import { describe, it, expect } from 'vitest';
import { transform, transformRow, type MigrationTemplate, type Tuple } from './migrationTransform';

// Parity fixtures reproduce each of the four backfill scripts (task / user /
// assessment / assessment-template) from small SYNTHETIC CSV strings. We never
// read anything under scripts/data/* (Moody's Confidential).

const key = (t: Tuple) => `${t.user}|${t.relation}|${t.object}`;
const keys = (ts: Tuple[]) => ts.map(key).sort();

describe('task migration parity', () => {
  const template: MigrationTemplate = {
    name: 'task',
    rowFilters: [],
    requiredColumns: ['task_id', 'institution_id'],
    dedupe: true,
    validationMode: 'drop-tuple',
    rules: [
      {
        id: 'inst-task',
        whenColumnsPresent: [],
        user: { type: 'institution', column: 'institution_id' },
        relation: { constant: 'parent_institution' },
        object: { type: 'task', column: 'task_id' },
      },
      {
        id: 'type-task',
        whenColumnsPresent: ['task_type_id'],
        user: { type: 'task_type', column: 'task_type_id' },
        relation: { constant: 'parent_task_type' },
        object: { type: 'task', column: 'task_id' },
      },
      {
        id: 'inst-type',
        whenColumnsPresent: ['task_type_id'],
        user: { type: 'institution', column: 'institution_id' },
        relation: { constant: 'parent_institution' },
        object: { type: 'task_type', column: 'task_type_id' },
      },
      {
        id: 'assignee',
        whenColumnsPresent: ['assigned_to_id', 'assigned_to_type'],
        user: {
          column: 'assigned_to_id',
          enum: {
            column: 'assigned_to_type',
            caseInsensitive: true,
            map: { USER: { type: 'user' }, TEAM: { type: 'team', usersetRelation: 'member' } },
          },
        },
        relation: { constant: 'task_assignee' },
        object: { type: 'task', column: 'task_id' },
      },
    ],
  };

  const csv = `task_id,institution_id,task_type_id,assigned_to_id,assigned_to_type
t1,i1,tt1,u1,USER
t2,i1,tt1,tm1,TEAM
t3,i2,,,
t4,i2,,x1,OTHER
,i9,tt9,u9,USER`;

  const result = transform(csv, template);

  it('produces the exact deduped tuple set (1–4 fan-out, USER vs TEAM userset)', () => {
    expect(keys(result.tuples)).toEqual(
      keys([
        { user: 'institution:i1', relation: 'parent_institution', object: 'task:t1' },
        { user: 'task_type:tt1', relation: 'parent_task_type', object: 'task:t1' },
        { user: 'institution:i1', relation: 'parent_institution', object: 'task_type:tt1' },
        { user: 'user:u1', relation: 'task_assignee', object: 'task:t1' },
        { user: 'institution:i1', relation: 'parent_institution', object: 'task:t2' },
        { user: 'task_type:tt1', relation: 'parent_task_type', object: 'task:t2' },
        { user: 'team:tm1#member', relation: 'task_assignee', object: 'task:t2' },
        { user: 'institution:i2', relation: 'parent_institution', object: 'task:t3' },
        { user: 'institution:i2', relation: 'parent_institution', object: 'task:t4' },
      ]),
    );
  });

  it('reports skip stats (missingRequired, gatedOut, enumUnmatched, deduped)', () => {
    expect(result.stats.totalRows).toBe(5);
    expect(result.stats.produced).toBe(9);
    expect(result.stats.missingRequired).toBe(1);
    expect(result.stats.deduped).toBe(1);
    expect(result.stats.enumUnmatched).toBe(1);
    expect(result.stats.gatedOut).toBe(5);
  });
});

describe('user migration parity (is_active filter, admin→admin/member)', () => {
  const template: MigrationTemplate = {
    name: 'user',
    rowFilters: [{ column: 'is_active', mode: 'include', truthyValues: ['true'], caseInsensitive: true }],
    requiredColumns: [],
    dedupe: false,
    validationMode: 'drop-tuple',
    rules: [
      {
        id: 'membership',
        whenColumnsPresent: [],
        user: { type: 'user', column: 'id' },
        relation: { enum: { column: 'admin', caseInsensitive: true, map: { true: 'admin' }, default: 'member' } },
        object: { type: 'institution', column: 'institution_id' },
      },
    ],
  };

  const csv = `id,institution_id,is_active,admin
u1,i1,TRUE,TRUE
u2,i1,true,false
u3,i2,FALSE,TRUE
u4,i2,TRUE,`;

  const result = transform(csv, template);

  it('keeps only active rows and maps admin/member', () => {
    expect(keys(result.tuples)).toEqual(
      keys([
        { user: 'user:u1', relation: 'admin', object: 'institution:i1' },
        { user: 'user:u2', relation: 'member', object: 'institution:i1' },
        { user: 'user:u4', relation: 'member', object: 'institution:i2' },
      ]),
    );
    expect(result.stats.filtered).toBe(1);
  });
});

describe('assessment migration parity (2-tuple all-or-nothing, drop-row)', () => {
  const template: MigrationTemplate = {
    name: 'assessment',
    rowFilters: [],
    requiredColumns: ['id', 'template_id', 'institution_id'],
    dedupe: false,
    validationMode: 'drop-row',
    rules: [
      {
        id: 'tpl',
        whenColumnsPresent: [],
        user: { type: 'assessment_template', column: 'template_id' },
        relation: { constant: 'parent_template' },
        object: { type: 'assessment', column: 'id' },
      },
      {
        id: 'inst',
        whenColumnsPresent: [],
        user: { type: 'institution', column: 'institution_id' },
        relation: { constant: 'parent_institution' },
        object: { type: 'assessment', column: 'id' },
      },
    ],
  };

  const csv = `id,template_id,institution_id
a1,tpl1,i1
a2,,i2
a3,tpl3,i3
a b,tpl4,i4`;

  const result = transform(csv, template);

  it('emits both tuples per complete row, skips incomplete rows, drops invalid-segment rows whole', () => {
    expect(keys(result.tuples)).toEqual(
      keys([
        { user: 'assessment_template:tpl1', relation: 'parent_template', object: 'assessment:a1' },
        { user: 'institution:i1', relation: 'parent_institution', object: 'assessment:a1' },
        { user: 'assessment_template:tpl3', relation: 'parent_template', object: 'assessment:a3' },
        { user: 'institution:i3', relation: 'parent_institution', object: 'assessment:a3' },
      ]),
    );
    expect(result.stats.missingRequired).toBe(1);
    // "a b" has an internal space → object assessment:a b is invalid → drop-row voids both tuples.
    expect(result.stats.invalidSegment).toBeGreaterThanOrEqual(1);
    expect(result.tuples.some((t) => t.object.includes(' '))).toBe(false);
  });
});

describe('assessment-template migration parity (deleted skip, single tuple)', () => {
  const template: MigrationTemplate = {
    name: 'templates',
    rowFilters: [{ column: 'deleted', mode: 'exclude', truthyValues: ['true'], caseInsensitive: true }],
    requiredColumns: ['id', 'institution_id'],
    dedupe: false,
    validationMode: 'drop-row',
    rules: [
      {
        id: 'inst',
        whenColumnsPresent: [],
        user: { type: 'institution', column: 'institution_id' },
        relation: { constant: 'parent_institution' },
        object: { type: 'assessment_template', column: 'id' },
      },
    ],
  };

  const csv = `id,institution_id,deleted
tpl1,i1,false
tpl2,i2,true
tpl3,i3,
tpl4,,false`;

  const result = transform(csv, template);

  it('skips deleted=true and rows missing institution_id', () => {
    expect(keys(result.tuples)).toEqual(
      keys([
        { user: 'institution:i1', relation: 'parent_institution', object: 'assessment_template:tpl1' },
        { user: 'institution:i3', relation: 'parent_institution', object: 'assessment_template:tpl3' },
      ]),
    );
    expect(result.stats.filtered).toBe(1);
    expect(result.stats.missingRequired).toBe(1);
  });
});

describe('transformRow debugger', () => {
  const template: MigrationTemplate = {
    name: 't',
    rowFilters: [{ column: 'active', mode: 'include', truthyValues: ['yes'], caseInsensitive: true }],
    requiredColumns: ['id'],
    dedupe: false,
    validationMode: 'drop-tuple',
    rules: [
      {
        id: 'r',
        whenColumnsPresent: [],
        user: { type: 'user', column: 'id' },
        relation: { constant: 'member' },
        object: { type: 'org', column: 'org' },
      },
    ],
  };

  it('explains a filtered row', () => {
    expect(transformRow({ id: 'x', org: 'o', active: 'no' }, template).outcome).toBe('filtered');
  });

  it('explains a missing-required row', () => {
    expect(transformRow({ id: '', org: 'o', active: 'yes' }, template).outcome).toBe('missingRequired');
  });

  it('emits a tuple for a good row', () => {
    const r = transformRow({ id: 'x', org: 'o', active: 'yes' }, template);
    expect(r.tuples).toEqual([{ user: 'user:x', relation: 'member', object: 'org:o' }]);
    expect(r.ruleOutcomes[0].status).toBe('emitted');
  });
});
