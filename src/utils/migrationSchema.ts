// JSON Schema for MigrationTemplate + a lightweight hand-rolled validator + a
// plain-English rule describer. The schema feeds Monaco (autocomplete + inline
// validation) and the "Copy AI prompt" helper; the validator backs paste-time
// checks (no runtime JSON-Schema dependency — the shapes are small and closed);
// `describeRule` renders each rule as a self-documenting, AI-verifiable sentence.
import type { TupleRule, Segment, RelationSpec } from './migrationTransform';

/** Published JSON Schema (draft-07) for a MigrationTemplate. */
export const MIGRATION_TEMPLATE_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://openfga-studio/migration-template.schema.json',
  title: 'MigrationTemplate',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'rowFilters', 'requiredColumns', 'rules', 'dedupe', 'validationMode'],
  properties: {
    name: { type: 'string', minLength: 1, description: 'Human-readable template name.' },
    description: { type: 'string' },
    rowFilters: {
      type: 'array',
      description: 'Row-level include/exclude filters over a case-folded truthy set.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['column', 'mode', 'truthyValues', 'caseInsensitive'],
        properties: {
          column: { type: 'string', minLength: 1 },
          mode: { enum: ['include', 'exclude'] },
          truthyValues: { type: 'array', items: { type: 'string' } },
          caseInsensitive: { type: 'boolean' },
        },
      },
    },
    requiredColumns: {
      type: 'array',
      description: 'If any of these columns is empty in a row, the whole row is skipped.',
      items: { type: 'string' },
    },
    rules: {
      type: 'array',
      minItems: 1,
      description: 'Per-row fan-out: each rule may emit one tuple.',
      items: { $ref: '#/definitions/rule' },
    },
    dedupe: { type: 'boolean', description: 'Drop duplicate user|relation|object tuples across rows.' },
    validationMode: {
      enum: ['drop-tuple', 'drop-row'],
      description: 'On an invalid segment: drop just that tuple, or the whole row.',
    },
  },
  definitions: {
    segment: {
      type: 'object',
      additionalProperties: false,
      description: 'Builds a tuple user/object string from a row.',
      properties: {
        type: { type: 'string', description: 'Constant type prefix, e.g. "task" → task:{id}.' },
        column: { type: 'string', description: 'Column supplying the id portion.' },
        usersetRelation: { type: 'string', description: 'Appends #{relation} (a userset reference).' },
        caseFold: { enum: ['upper', 'lower', 'none'] },
        enum: {
          type: 'object',
          additionalProperties: false,
          required: ['column', 'caseInsensitive', 'map'],
          description: 'Selects {type, usersetRelation?} from a column value; unmatched ⇒ skip tuple.',
          properties: {
            column: { type: 'string', minLength: 1 },
            caseInsensitive: { type: 'boolean' },
            map: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                additionalProperties: false,
                required: ['type'],
                properties: {
                  type: { type: 'string' },
                  usersetRelation: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    relationSpec: {
      type: 'object',
      additionalProperties: false,
      description: 'Chooses a tuple relation. Provide exactly one of constant/enum.',
      properties: {
        constant: { type: 'string' },
        enum: {
          type: 'object',
          additionalProperties: false,
          required: ['column', 'caseInsensitive', 'map'],
          properties: {
            column: { type: 'string', minLength: 1 },
            caseInsensitive: { type: 'boolean' },
            map: { type: 'object', additionalProperties: { type: 'string' } },
            default: { type: 'string' },
          },
        },
      },
    },
    rule: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'whenColumnsPresent', 'user', 'relation', 'object'],
      properties: {
        id: { type: 'string', minLength: 1 },
        whenColumnsPresent: {
          type: 'array',
          items: { type: 'string' },
          description: 'All must be non-empty for this rule to emit.',
        },
        user: { $ref: '#/definitions/segment' },
        relation: { $ref: '#/definitions/relationSpec' },
        object: { $ref: '#/definitions/segment' },
      },
    },
  },
};

/** A small, dependency-free validator. Returns a list of human-readable errors ([] = valid). */
export function validateTemplate(value: unknown): string[] {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (!isObj(value)) return ['Template must be a JSON object.'];

  if (typeof value.name !== 'string' || value.name.trim() === '') {
    errors.push('`name` is required and must be a non-empty string.');
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    errors.push('`description` must be a string.');
  }
  if (!Array.isArray(value.rowFilters)) {
    errors.push('`rowFilters` must be an array.');
  } else {
    value.rowFilters.forEach((f, i) => {
      if (!isObj(f)) return errors.push(`rowFilters[${i}] must be an object.`);
      if (typeof f.column !== 'string' || !f.column) errors.push(`rowFilters[${i}].column is required.`);
      if (f.mode !== 'include' && f.mode !== 'exclude')
        errors.push(`rowFilters[${i}].mode must be "include" or "exclude".`);
      if (!Array.isArray(f.truthyValues)) errors.push(`rowFilters[${i}].truthyValues must be an array.`);
      if (typeof f.caseInsensitive !== 'boolean')
        errors.push(`rowFilters[${i}].caseInsensitive must be a boolean.`);
    });
  }
  if (!Array.isArray(value.requiredColumns)) {
    errors.push('`requiredColumns` must be an array of strings.');
  } else if (value.requiredColumns.some((c) => typeof c !== 'string')) {
    errors.push('`requiredColumns` must contain only strings.');
  }
  if (typeof value.dedupe !== 'boolean') errors.push('`dedupe` must be a boolean.');
  if (value.validationMode !== 'drop-tuple' && value.validationMode !== 'drop-row') {
    errors.push('`validationMode` must be "drop-tuple" or "drop-row".');
  }
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    errors.push('`rules` must be a non-empty array.');
  } else {
    value.rules.forEach((r, i) => validateRule(r, i, errors, isObj));
  }
  return errors;
}

function validateSegment(
  seg: unknown,
  path: string,
  errors: string[],
  isObj: (v: unknown) => v is Record<string, unknown>,
): void {
  if (!isObj(seg)) return void errors.push(`${path} must be an object.`);
  if (seg.enum !== undefined) {
    const e = seg.enum;
    if (!isObj(e)) errors.push(`${path}.enum must be an object.`);
    else {
      if (typeof e.column !== 'string' || !e.column) errors.push(`${path}.enum.column is required.`);
      if (typeof e.caseInsensitive !== 'boolean') errors.push(`${path}.enum.caseInsensitive must be a boolean.`);
      if (!isObj(e.map)) errors.push(`${path}.enum.map must be an object.`);
    }
  } else if (typeof seg.column !== 'string' || !seg.column) {
    errors.push(`${path} must set either \`column\` or \`enum\`.`);
  }
  if (seg.caseFold !== undefined && !['upper', 'lower', 'none'].includes(seg.caseFold as string)) {
    errors.push(`${path}.caseFold must be upper/lower/none.`);
  }
}

function validateRelation(
  rel: unknown,
  path: string,
  errors: string[],
  isObj: (v: unknown) => v is Record<string, unknown>,
): void {
  if (!isObj(rel)) return void errors.push(`${path} must be an object.`);
  const hasConstant = typeof rel.constant === 'string';
  const hasEnum = isObj(rel.enum);
  if (!hasConstant && !hasEnum) {
    errors.push(`${path} must set either \`constant\` or \`enum\`.`);
  }
  if (hasEnum) {
    const e = rel.enum as Record<string, unknown>;
    if (typeof e.column !== 'string' || !e.column) errors.push(`${path}.enum.column is required.`);
    if (typeof e.caseInsensitive !== 'boolean') errors.push(`${path}.enum.caseInsensitive must be a boolean.`);
    if (!isObj(e.map)) errors.push(`${path}.enum.map must be an object.`);
  }
}

function validateRule(
  rule: unknown,
  i: number,
  errors: string[],
  isObj: (v: unknown) => v is Record<string, unknown>,
): void {
  const path = `rules[${i}]`;
  if (!isObj(rule)) return void errors.push(`${path} must be an object.`);
  if (typeof rule.id !== 'string' || !rule.id) errors.push(`${path}.id is required.`);
  if (!Array.isArray(rule.whenColumnsPresent)) errors.push(`${path}.whenColumnsPresent must be an array.`);
  validateSegment(rule.user, `${path}.user`, errors, isObj);
  validateRelation(rule.relation, `${path}.relation`, errors, isObj);
  validateSegment(rule.object, `${path}.object`, errors, isObj);
}

function describeSegment(seg: Segment): string {
  if (seg.enum) {
    const entries = Object.entries(seg.enum.map)
      .map(([k, v]) => `"${k}"→${v.type}${v.usersetRelation ? `#${v.usersetRelation}` : ''}`)
      .join(', ');
    return `a type chosen from column "${seg.enum.column}" (${entries}) with id from column "${seg.column}"`;
  }
  const fold = seg.caseFold && seg.caseFold !== 'none' ? ` (${seg.caseFold}-cased)` : '';
  const userset = seg.usersetRelation ? `#${seg.usersetRelation}` : '';
  const prefix = seg.type ? `${seg.type}:` : '';
  return `\`${prefix}{${seg.column ?? '?'}}${userset}\`${fold}`;
}

function describeRelation(rel: RelationSpec): string {
  if (rel.constant !== undefined) return `\`${rel.constant}\``;
  if (rel.enum) {
    const entries = Object.entries(rel.enum.map)
      .map(([k, v]) => `"${k}"→${v}`)
      .join(', ');
    const dflt = rel.enum.default !== undefined ? `, else "${rel.enum.default}"` : '';
    return `a relation from column "${rel.enum.column}" (${entries}${dflt})`;
  }
  return '(unspecified)';
}

/** Render one rule as a plain-English sentence (self-documenting / AI-verifiable). */
export function describeRule(rule: TupleRule): string {
  const gate =
    rule.whenColumnsPresent.length > 0
      ? `When ${rule.whenColumnsPresent.map((c) => `"${c}"`).join(' and ')} present, `
      : 'Always, ';
  return `${gate}write ${describeSegment(rule.user)} — ${describeRelation(rule.relation)} → ${describeSegment(
    rule.object,
  )}.`;
}
