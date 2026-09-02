import { describe, it, expect } from 'vitest';
import {
  BLANK_TEMPLATE,
  normalizeTemplate,
  cleanTemplate,
  serializeTemplate,
  moveItem,
  newRule,
} from './mappingBuilderModel';
import type { MigrationTemplate } from '../../utils/migrationTransform';

const FULL: MigrationTemplate = {
  name: 'Task migration',
  description: 'typed + assignee fan-out',
  rowFilters: [{ column: 'is_active', mode: 'include', truthyValues: ['true', '1'], caseInsensitive: true }],
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
      id: 'assignee',
      whenColumnsPresent: ['assigned_to_id', 'assigned_to_type'],
      user: {
        column: 'assigned_to_id',
        caseFold: 'lower',
        enum: {
          column: 'assigned_to_type',
          caseInsensitive: true,
          map: { USER: { type: 'user' }, TEAM: { type: 'team', usersetRelation: 'member' } },
        },
      },
      relation: {
        enum: { column: 'role', caseInsensitive: true, map: { admin: 'admin' }, default: 'member' },
      },
      object: { type: 'task', column: 'task_id', usersetRelation: 'x' },
    },
  ],
};

describe('normalizeTemplate', () => {
  it('fills defaults from an empty / non-object input', () => {
    expect(normalizeTemplate(undefined)).toEqual(BLANK_TEMPLATE);
    expect(normalizeTemplate('nope')).toEqual(BLANK_TEMPLATE);
    expect(normalizeTemplate({})).toEqual(BLANK_TEMPLATE);
  });

  it('coerces a partial template without throwing', () => {
    const t = normalizeTemplate({ name: 'x', rules: [{ user: { column: 'a' } }] });
    expect(t.name).toBe('x');
    expect(t.dedupe).toBe(true);
    expect(t.validationMode).toBe('drop-tuple');
    expect(t.rules).toHaveLength(1);
    // Missing id → deterministic index-based fallback (stable across renders).
    expect(t.rules[0].id).toBe('rule-0');
    expect(t.rules[0].relation).toEqual({ constant: '' });
  });

  it('drops non-string entries in string arrays', () => {
    const t = normalizeTemplate({ requiredColumns: ['a', 3, null, 'b'] });
    expect(t.requiredColumns).toEqual(['a', 'b']);
  });
});

describe('cleanTemplate / serializeTemplate round-trip', () => {
  it('preserves every primitive through serialize → parse → normalize', () => {
    const round = normalizeTemplate(JSON.parse(serializeTemplate(FULL)));
    expect(round).toEqual(normalizeTemplate(FULL));
  });

  it('strips empty optionals for tidy JSON', () => {
    const cleaned = cleanTemplate(normalizeTemplate({ name: 'x', rules: [newRule()] }));
    const rule = cleaned.rules[0];
    // A blank rule has no type/userset/caseFold noise.
    expect(rule.user).toEqual({}); // column '' is dropped
    expect(rule.object).toEqual({});
    expect(rule.relation).toEqual({ constant: '' });
    expect(cleaned.description).toBeUndefined();
  });

  it('keeps enum usersetRelation only when set', () => {
    const cleaned = cleanTemplate(FULL);
    const userEnum = cleaned.rules[1].user.enum!;
    expect(userEnum.map.USER).toEqual({ type: 'user' });
    expect(userEnum.map.TEAM).toEqual({ type: 'team', usersetRelation: 'member' });
  });

  it('keeps relation enum default when present', () => {
    const cleaned = cleanTemplate(FULL);
    expect(cleaned.rules[1].relation.enum!.default).toBe('member');
  });
});

describe('moveItem', () => {
  it('reorders immutably and is a no-op out of bounds', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    const arr = [1, 2, 3];
    expect(moveItem(arr, 0, 5)).toBe(arr);
    expect(moveItem(arr, 1, 1)).toBe(arr);
  });
});
