// Pure, IO-free helpers backing the guided MappingBuilder. The Builder edits the
// SAME MigrationTemplate the JSON editor edits, so these functions define the
// two-way bridge between the raw config text and a well-formed working template:
//
//   JSON text ──parse──▶ normalizeTemplate() ──▶ Builder edits ──▶ cleanTemplate()
//                                                        │
//                                                        └──serializeTemplate()──▶ JSON text
//
// `normalizeTemplate` is defensive: partial / half-written JSON always yields a
// complete template so the Builder never crashes. `cleanTemplate` strips empty
// optionals so the round-tripped JSON stays tidy and matches what a human would
// hand-write. Kept out of the .tsx file so it is unit-testable in Node.
import type {
  MigrationTemplate,
  TupleRule,
  Segment,
  RelationSpec,
  RowFilter,
} from '../../utils/migrationTransform';

export const BLANK_TEMPLATE: MigrationTemplate = {
  name: 'Untitled template',
  description: '',
  rowFilters: [],
  requiredColumns: [],
  rules: [],
  dedupe: true,
  validationMode: 'drop-tuple',
};

let ruleSeq = 0;
/** Fresh, collision-resistant rule id for Builder-created rules. */
export function newRuleId(): string {
  ruleSeq += 1;
  return `rule-${Date.now().toString(36)}-${ruleSeq}`;
}

/** A blank rule in the common shape: constant relation, `type:{col}` segments. */
export function newRule(): TupleRule {
  return {
    id: newRuleId(),
    whenColumnsPresent: [],
    user: { column: '' },
    relation: { constant: '' },
    object: { type: '', column: '' },
  };
}

export function newRowFilter(): RowFilter {
  return { column: '', mode: 'include', truthyValues: [], caseInsensitive: true };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asStr = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function normalizeSegment(raw: unknown): Segment {
  const o = isObj(raw) ? raw : {};
  const seg: Segment = {};
  if (typeof o.type === 'string') seg.type = o.type;
  if (typeof o.column === 'string') seg.column = o.column;
  else seg.column = '';
  if (typeof o.usersetRelation === 'string') seg.usersetRelation = o.usersetRelation;
  if (o.caseFold === 'upper' || o.caseFold === 'lower' || o.caseFold === 'none') {
    seg.caseFold = o.caseFold;
  }
  if (isObj(o.enum)) {
    const e = o.enum;
    const map: Record<string, { type: string; usersetRelation?: string }> = {};
    if (isObj(e.map)) {
      for (const [k, v] of Object.entries(e.map)) {
        if (isObj(v)) {
          map[k] = {
            type: asStr(v.type),
            ...(typeof v.usersetRelation === 'string' && v.usersetRelation
              ? { usersetRelation: v.usersetRelation }
              : {}),
          };
        }
      }
    }
    seg.enum = {
      column: asStr(e.column),
      caseInsensitive: e.caseInsensitive !== false,
      map,
    };
  }
  return seg;
}

function normalizeRelation(raw: unknown): RelationSpec {
  const o = isObj(raw) ? raw : {};
  if (isObj(o.enum)) {
    const e = o.enum;
    const map: Record<string, string> = {};
    if (isObj(e.map)) {
      for (const [k, v] of Object.entries(e.map)) map[k] = asStr(v);
    }
    return {
      enum: {
        column: asStr(e.column),
        caseInsensitive: e.caseInsensitive !== false,
        map,
        ...(typeof e.default === 'string' ? { default: e.default } : {}),
      },
    };
  }
  return { constant: asStr(o.constant) };
}

function normalizeRule(raw: unknown, index: number): TupleRule {
  const o = isObj(raw) ? raw : {};
  return {
    // Deterministic fallback id (never Date.now here) so React keys stay stable
    // across renders when the raw JSON omits an id.
    id: typeof o.id === 'string' && o.id ? o.id : `rule-${index}`,
    whenColumnsPresent: Array.isArray(o.whenColumnsPresent)
      ? o.whenColumnsPresent.filter((c): c is string => typeof c === 'string')
      : [],
    user: normalizeSegment(o.user),
    relation: normalizeRelation(o.relation),
    object: normalizeSegment(o.object),
  };
}

function normalizeRowFilter(raw: unknown): RowFilter {
  const o = isObj(raw) ? raw : {};
  return {
    column: asStr(o.column),
    mode: o.mode === 'exclude' ? 'exclude' : 'include',
    truthyValues: Array.isArray(o.truthyValues)
      ? o.truthyValues.filter((v): v is string => typeof v === 'string')
      : [],
    caseInsensitive: o.caseInsensitive !== false,
  };
}

/** Coerce any (possibly partial) parsed value into a complete working template. */
export function normalizeTemplate(raw: unknown): MigrationTemplate {
  const o = isObj(raw) ? raw : {};
  return {
    name: asStr(o.name, BLANK_TEMPLATE.name),
    description: typeof o.description === 'string' ? o.description : '',
    rowFilters: Array.isArray(o.rowFilters) ? o.rowFilters.map(normalizeRowFilter) : [],
    requiredColumns: Array.isArray(o.requiredColumns)
      ? o.requiredColumns.filter((c): c is string => typeof c === 'string')
      : [],
    rules: Array.isArray(o.rules) ? o.rules.map(normalizeRule) : [],
    dedupe: typeof o.dedupe === 'boolean' ? o.dedupe : true,
    validationMode: o.validationMode === 'drop-row' ? 'drop-row' : 'drop-tuple',
  };
}

function cleanSegment(seg: Segment): Segment {
  const out: Segment = {};
  if (seg.enum) {
    out.enum = {
      column: seg.enum.column,
      caseInsensitive: seg.enum.caseInsensitive,
      map: Object.fromEntries(
        Object.entries(seg.enum.map).map(([k, v]) => [
          k,
          v.usersetRelation ? { type: v.type, usersetRelation: v.usersetRelation } : { type: v.type },
        ]),
      ),
    };
  } else if (seg.type) {
    out.type = seg.type;
  }
  if (seg.column) out.column = seg.column;
  if (seg.usersetRelation) out.usersetRelation = seg.usersetRelation;
  if (seg.caseFold && seg.caseFold !== 'none') out.caseFold = seg.caseFold;
  return out;
}

function cleanRelation(rel: RelationSpec): RelationSpec {
  if (rel.enum) {
    return {
      enum: {
        column: rel.enum.column,
        caseInsensitive: rel.enum.caseInsensitive,
        map: { ...rel.enum.map },
        ...(rel.enum.default ? { default: rel.enum.default } : {}),
      },
    };
  }
  return { constant: rel.constant ?? '' };
}

/** Strip empty optionals so the serialized JSON stays tidy and human-legible. */
export function cleanTemplate(t: MigrationTemplate): MigrationTemplate {
  const out: MigrationTemplate = {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    rowFilters: t.rowFilters.map((f) => ({
      column: f.column,
      mode: f.mode,
      truthyValues: [...f.truthyValues],
      caseInsensitive: f.caseInsensitive,
    })),
    requiredColumns: [...t.requiredColumns],
    rules: t.rules.map((r) => ({
      id: r.id,
      whenColumnsPresent: [...r.whenColumnsPresent],
      user: cleanSegment(r.user),
      relation: cleanRelation(r.relation),
      object: cleanSegment(r.object),
    })),
    dedupe: t.dedupe,
    validationMode: t.validationMode,
  } as MigrationTemplate;
  return out;
}

/** Serialize a working template to tidy, round-trippable JSON text. */
export function serializeTemplate(t: MigrationTemplate): string {
  return JSON.stringify(cleanTemplate(t), null, 2);
}

/** Move an array item from one index to another (immutably). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length || from === to) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
