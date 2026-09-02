// Pure, IO-free transform engine: raw source CSV + a declarative MigrationTemplate
// → structural OpenFGA tuples. This replaces the bespoke `rowTo*Tuples` functions
// in the per-business-area backfill scripts (task / user / assessment / template)
// with one config-driven pipeline. Being pure, it is unit-tested for parity against
// those scripts (see migrationTransform.test.ts).
//
// Pipeline per row: rowFilters → requiredColumns guard → for each rule a
// whenColumnsPresent gate → resolve user/relation/object (enum lookup, case fold,
// `#userset` suffix) → per-segment validation (^[^\s]{2,256}$) under validationMode.
// Then an optional cross-row dedupe on user|relation|object.
import { parse } from 'csv-parse/sync';

export interface Tuple {
  user: string;
  relation: string;
  object: string;
}

/** How a tuple user/object string is built from a row. */
export interface Segment {
  /** Constant type prefix, e.g. `task` → `task:{id}`. Omit for a bare column value. */
  type?: string;
  /** Column supplying the id portion. */
  column?: string;
  /** Appends `#{usersetRelation}` (a userset reference), e.g. `team:{id}#member`. */
  usersetRelation?: string;
  /** Case-fold the id portion before assembling. */
  caseFold?: 'upper' | 'lower' | 'none';
  /**
   * Enum-driven type/userset: the value in `column` selects a `{type, usersetRelation?}`
   * entry; the id still comes from the segment's own `column`. An unmatched value
   * skips the tuple (mirrors the task script's USER/TEAM branch).
   */
  enum?: {
    column: string;
    caseInsensitive: boolean;
    map: Record<string, { type: string; usersetRelation?: string }>;
  };
}

/** How a tuple's relation is chosen. */
export interface RelationSpec {
  /** Fixed relation name. */
  constant?: string;
  /** Enum-driven relation, e.g. admin=TRUE → `admin`, else `default`. */
  enum?: {
    column: string;
    caseInsensitive: boolean;
    map: Record<string, string>;
    default?: string;
  };
}

export interface TupleRule {
  id: string;
  /** All listed columns must be non-empty for this rule to emit (else the rule is gated out). */
  whenColumnsPresent: string[];
  user: Segment;
  relation: RelationSpec;
  object: Segment;
}

/** Row-level boolean include/exclude filter over a case-folded truthy set. */
export interface RowFilter {
  column: string;
  mode: 'include' | 'exclude';
  truthyValues: string[];
  caseInsensitive: boolean;
}

export interface MigrationTemplate {
  name: string;
  description?: string;
  rowFilters: RowFilter[];
  /** Any empty ⇒ skip the whole row. */
  requiredColumns: string[];
  rules: TupleRule[];
  dedupe: boolean;
  /** On an invalid segment: drop just that tuple, or the whole row's tuples. */
  validationMode: 'drop-tuple' | 'drop-row';
}

export type SkipReason =
  | 'filtered'
  | 'missingRequired'
  | 'gatedOut'
  | 'enumUnmatched'
  | 'invalidSegment'
  | 'deduped';

export interface TransformStats {
  totalRows: number;
  produced: number;
  filtered: number;
  missingRequired: number;
  gatedOut: number;
  enumUnmatched: number;
  invalidSegment: number;
  deduped: number;
}

export interface SkippedRow {
  index: number;
  reason: SkipReason;
  detail?: string;
  row: Record<string, string>;
}

export interface TransformResult {
  tuples: Tuple[];
  stats: TransformStats;
  sample: Tuple[];
  /** Capped list of dropped rows/tuples, for the dry-run "skipped with reasons" panel. */
  skipped: SkippedRow[];
}

/** Per-rule outcome for the "transform one row" debugger. */
export interface RuleOutcome {
  ruleId: string;
  status: 'emitted' | 'gatedOut' | 'enumUnmatched' | 'invalid';
  tuple?: Tuple;
  detail?: string;
}

export interface RowTransform {
  tuples: Tuple[];
  outcome: 'produced' | 'filtered' | 'missingRequired';
  detail?: string;
  ruleOutcomes: RuleOutcome[];
}

/** OpenFGA rejects a TupleKey user/object that is not `^[^\s]{2,256}$`. */
export function isValidSegment(s: string): boolean {
  return typeof s === 'string' && /^[^\s]{2,256}$/.test(s);
}

const SAMPLE_CAP = 20;
const SKIPPED_CAP = 200;

function foldCase(value: string, mode: Segment['caseFold']): string {
  if (mode === 'upper') return value.toUpperCase();
  if (mode === 'lower') return value.toLowerCase();
  return value;
}

function cell(row: Record<string, string>, column: string | undefined): string {
  if (!column) return '';
  const v = row[column];
  return typeof v === 'string' ? v.trim() : '';
}

/** Look up an enum map with optional case-insensitivity. */
function enumLookup<T>(
  map: Record<string, T>,
  value: string,
  caseInsensitive: boolean,
): T | undefined {
  if (!caseInsensitive) return map[value];
  const needle = value.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === needle) return v;
  }
  return undefined;
}

interface SegmentResult {
  value: string | null;
  /** True when an enum lookup found no matching entry (distinct from an invalid string). */
  enumUnmatched?: boolean;
}

function resolveSegment(seg: Segment, row: Record<string, string>): SegmentResult {
  let type = seg.type;
  let userset = seg.usersetRelation;

  if (seg.enum) {
    const selector = cell(row, seg.enum.column);
    const match = enumLookup(seg.enum.map, selector, seg.enum.caseInsensitive);
    if (!match) return { value: null, enumUnmatched: true };
    type = match.type;
    userset = match.usersetRelation ?? seg.usersetRelation;
  }

  const id = foldCase(cell(row, seg.column), seg.caseFold);
  let value = type ? `${type}:${id}` : id;
  if (userset) value += `#${userset}`;
  return { value };
}

function resolveRelation(
  rel: RelationSpec,
  row: Record<string, string>,
): { value: string | null; enumUnmatched?: boolean } {
  if (rel.constant !== undefined) return { value: rel.constant };
  if (rel.enum) {
    const selector = cell(row, rel.enum.column);
    const match = enumLookup(rel.enum.map, selector, rel.enum.caseInsensitive);
    if (match !== undefined) return { value: match };
    if (rel.enum.default !== undefined) return { value: rel.enum.default };
    return { value: null, enumUnmatched: true };
  }
  return { value: null };
}

function rowPassesFilters(row: Record<string, string>, filters: RowFilter[]): boolean {
  for (const f of filters) {
    const raw = cell(row, f.column);
    const value = f.caseInsensitive ? raw.toLowerCase() : raw;
    const set = f.caseInsensitive
      ? f.truthyValues.map((v) => v.toLowerCase())
      : f.truthyValues;
    const isTruthy = set.includes(value);
    if (f.mode === 'include' && !isTruthy) return false;
    if (f.mode === 'exclude' && isTruthy) return false;
  }
  return true;
}

function missingRequired(row: Record<string, string>, columns: string[]): string | null {
  for (const c of columns) {
    if (!cell(row, c)) return c;
  }
  return null;
}

/**
 * Transform a single already-parsed row. Shared by `transform` (bulk) and
 * `transformRow` (the dry-run debugger). Does not dedupe (that is cross-row).
 */
export function transformRow(row: Record<string, string>, template: MigrationTemplate): RowTransform {
  if (!rowPassesFilters(row, template.rowFilters)) {
    return { tuples: [], outcome: 'filtered', ruleOutcomes: [] };
  }
  const missing = missingRequired(row, template.requiredColumns);
  if (missing) {
    return {
      tuples: [],
      outcome: 'missingRequired',
      detail: `required column "${missing}" is empty`,
      ruleOutcomes: [],
    };
  }

  const ruleOutcomes: RuleOutcome[] = [];
  const tuples: Tuple[] = [];
  let rowInvalid = false;

  for (const rule of template.rules) {
    const gate = missingRequired(row, rule.whenColumnsPresent);
    if (gate) {
      ruleOutcomes.push({
        ruleId: rule.id,
        status: 'gatedOut',
        detail: `column "${gate}" is empty`,
      });
      continue;
    }

    const user = resolveSegment(rule.user, row);
    const object = resolveSegment(rule.object, row);
    const relation = resolveRelation(rule.relation, row);

    if (user.enumUnmatched || object.enumUnmatched || relation.enumUnmatched) {
      ruleOutcomes.push({
        ruleId: rule.id,
        status: 'enumUnmatched',
        detail: 'no enum entry matched the row value',
      });
      continue;
    }

    if (user.value === null || object.value === null || relation.value === null) {
      ruleOutcomes.push({ ruleId: rule.id, status: 'enumUnmatched', detail: 'unresolved segment' });
      continue;
    }

    const tuple: Tuple = { user: user.value, relation: relation.value, object: object.value };
    if (!isValidSegment(tuple.user) || !isValidSegment(tuple.object)) {
      ruleOutcomes.push({
        ruleId: rule.id,
        status: 'invalid',
        tuple,
        detail: 'user/object fails ^[^\\s]{2,256}$',
      });
      rowInvalid = true;
      continue;
    }

    ruleOutcomes.push({ ruleId: rule.id, status: 'emitted', tuple });
    tuples.push(tuple);
  }

  // drop-row: any invalid tuple voids the whole row's output.
  if (template.validationMode === 'drop-row' && rowInvalid) {
    return {
      tuples: [],
      outcome: 'produced',
      detail: 'row dropped: contained an invalid segment (drop-row mode)',
      ruleOutcomes,
    };
  }

  return { tuples, outcome: 'produced', ruleOutcomes };
}

/** Parse CSV text into records + the header list (RFC-4180 via csv-parse/sync). */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  let headers: string[] = [];
  try {
    const headerRecord = parse(text, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      to: 1,
    }) as string[][];
    headers = headerRecord[0] ?? [];
  } catch {
    headers = rows.length ? Object.keys(rows[0]) : [];
  }
  return { headers, rows };
}

/** Full transform: raw CSV text + template → tuples + stats + skip diagnostics. */
export function transform(csvText: string, template: MigrationTemplate): TransformResult {
  const { rows } = parseCsv(csvText);
  return transformRows(rows, template);
}

/** Transform already-parsed rows (avoids re-parsing when the caller already has records). */
export function transformRows(
  rows: Record<string, string>[],
  template: MigrationTemplate,
): TransformResult {
  const stats: TransformStats = {
    totalRows: rows.length,
    produced: 0,
    filtered: 0,
    missingRequired: 0,
    gatedOut: 0,
    enumUnmatched: 0,
    invalidSegment: 0,
    deduped: 0,
  };
  const skipped: SkippedRow[] = [];
  const collected: Tuple[] = [];

  const note = (index: number, reason: SkipReason, detail: string | undefined, row: Record<string, string>) => {
    if (skipped.length < SKIPPED_CAP) skipped.push({ index, reason, detail, row });
  };

  rows.forEach((row, index) => {
    const result = transformRow(row, template);

    if (result.outcome === 'filtered') {
      stats.filtered++;
      note(index, 'filtered', 'excluded by a row filter', row);
      return;
    }
    if (result.outcome === 'missingRequired') {
      stats.missingRequired++;
      note(index, 'missingRequired', result.detail, row);
      return;
    }

    // outcome === 'produced' — tally per-rule outcomes.
    for (const ro of result.ruleOutcomes) {
      if (ro.status === 'gatedOut') stats.gatedOut++;
      else if (ro.status === 'enumUnmatched') {
        stats.enumUnmatched++;
        note(index, 'enumUnmatched', ro.detail, row);
      } else if (ro.status === 'invalid') {
        stats.invalidSegment++;
        note(index, 'invalidSegment', ro.detail, row);
      }
    }
    if (result.detail && result.tuples.length === 0 && result.ruleOutcomes.some((r) => r.status === 'invalid')) {
      // drop-row voided the whole row.
      note(index, 'invalidSegment', result.detail, row);
    }

    collected.push(...result.tuples);
  });

  let tuples = collected;
  if (template.dedupe) {
    const seen = new Set<string>();
    const unique: Tuple[] = [];
    for (const t of collected) {
      const key = `${t.user}|${t.relation}|${t.object}`;
      if (seen.has(key)) {
        stats.deduped++;
        continue;
      }
      seen.add(key);
      unique.push(t);
    }
    tuples = unique;
  }

  stats.produced = tuples.length;
  return { tuples, stats, sample: tuples.slice(0, SAMPLE_CAP), skipped };
}
