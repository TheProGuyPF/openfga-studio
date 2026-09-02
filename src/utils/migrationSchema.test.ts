import { describe, it, expect } from 'vitest';
import { validateTemplate, describeRule, MIGRATION_TEMPLATE_SCHEMA } from './migrationSchema';
import type { MigrationTemplate, TupleRule } from './migrationTransform';

const valid: MigrationTemplate = {
  name: 'user',
  rowFilters: [{ column: 'is_active', mode: 'include', truthyValues: ['true'], caseInsensitive: true }],
  requiredColumns: ['id'],
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

describe('validateTemplate', () => {
  it('accepts a valid template', () => {
    expect(validateTemplate(valid)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateTemplate('nope').length).toBeGreaterThan(0);
  });

  it('reports missing name / empty rules / bad validationMode', () => {
    const errs = validateTemplate({
      rowFilters: [],
      requiredColumns: [],
      rules: [],
      dedupe: false,
      validationMode: 'nope',
    });
    expect(errs.some((e) => e.includes('name'))).toBe(true);
    expect(errs.some((e) => e.includes('rules'))).toBe(true);
    expect(errs.some((e) => e.includes('validationMode'))).toBe(true);
  });

  it('reports a rule with neither constant nor enum relation', () => {
    const bad = {
      ...valid,
      rules: [{ id: 'r', whenColumnsPresent: [], user: { column: 'id' }, relation: {}, object: { column: 'o' } }],
    };
    expect(validateTemplate(bad).some((e) => e.includes('constant') || e.includes('enum'))).toBe(true);
  });

  it('reports a segment missing both column and enum', () => {
    const bad = {
      ...valid,
      rules: [{ id: 'r', whenColumnsPresent: [], user: {}, relation: { constant: 'member' }, object: { column: 'o' } }],
    };
    expect(validateTemplate(bad).some((e) => e.includes('column') || e.includes('enum'))).toBe(true);
  });

  it('exposes a draft-07 schema with the template title', () => {
    expect(MIGRATION_TEMPLATE_SCHEMA.title).toBe('MigrationTemplate');
    expect(String(MIGRATION_TEMPLATE_SCHEMA.$schema)).toContain('draft-07');
  });
});

describe('describeRule', () => {
  it('describes a constant-relation, always-on rule', () => {
    const rule: TupleRule = {
      id: 'inst',
      whenColumnsPresent: [],
      user: { type: 'institution', column: 'institution_id' },
      relation: { constant: 'parent_institution' },
      object: { type: 'assessment', column: 'id' },
    };
    const s = describeRule(rule);
    expect(s).toContain('Always');
    expect(s).toContain('parent_institution');
    expect(s).toContain('institution:{institution_id}');
    expect(s).toContain('assessment:{id}');
  });

  it('describes a gated, enum-user rule with userset', () => {
    const rule: TupleRule = {
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
    };
    const s = describeRule(rule);
    expect(s).toContain('When "assigned_to_id" and "assigned_to_type" present');
    expect(s).toContain('team#member');
    expect(s).toContain('task_assignee');
  });

  it('describes an enum relation with default', () => {
    const rule: TupleRule = {
      id: 'membership',
      whenColumnsPresent: [],
      user: { type: 'user', column: 'id' },
      relation: { enum: { column: 'admin', caseInsensitive: true, map: { true: 'admin' }, default: 'member' } },
      object: { type: 'institution', column: 'institution_id' },
    };
    const s = describeRule(rule);
    expect(s).toContain('"true"→admin');
    expect(s).toContain('else "member"');
  });
});
