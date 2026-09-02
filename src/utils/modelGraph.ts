import { transformer } from '@openfga/syntax-transformer';
import { dslToJson } from './modelConverter';

/**
 * Structured, semantic representation of an OpenFGA authorization model.
 *
 * The legacy `authModelParser` only split relation definitions on ` or ` and
 * treated each fragment as an opaque leaf. That is too shallow for the weighted
 * graph and the resolution-path visualiser, both of which need the full
 * userset-rewrite tree (`this` / computedUserset / tupleToUserset / union /
 * intersection / difference). This module is the single source of truth those
 * features (and the redesigned diagram) consume.
 */

// ---------------------------------------------------------------------------
// Rewrite tree
// ---------------------------------------------------------------------------

export type Rewrite =
  | { kind: 'this' }
  | { kind: 'computed'; relation: string }
  | { kind: 'ttu'; tupleset: string; computedRelation: string }
  | { kind: 'union'; children: Rewrite[] }
  | { kind: 'intersection'; children: Rewrite[] }
  | { kind: 'difference'; base: Rewrite; subtract: Rewrite };

export interface DirectAssignment {
  /** The referenced type, e.g. `user` or `group`. */
  type: string;
  /** For userset references like `group#member`, the relation on `type`. */
  relation?: string;
  /** True for public wildcards like `user:*`. */
  wildcard?: boolean;
  /** Name of a condition guarding this assignment, if any. */
  condition?: string;
}

export interface RelationDef {
  /** The owning type, e.g. `repo`. */
  type: string;
  /** The relation name, e.g. `reader`. */
  name: string;
  /** Stable id `${type}#${name}`. */
  id: string;
  rewrite: Rewrite;
  directlyRelated: DirectAssignment[];
  /** Short DSL-like rendering of the rewrite, for tooltips. */
  dsl: string;
}

export interface TypeDef {
  name: string;
  relations: RelationDef[];
}

export interface StructuredModel {
  schemaVersion: string;
  types: TypeDef[];
  /** Every relation keyed by `${type}#${name}`. */
  relationsById: Map<string, RelationDef>;
  conditionNames: string[];
}

// Minimal shape of the OpenFGA JSON model we read. Kept local so we don't have
// to widen the shared `OpenFGAModel` type (which lacks `difference`).
interface RawRelation {
  this?: Record<string, unknown>;
  computedUserset?: { relation: string };
  tupleToUserset?: {
    tupleset: { relation: string };
    computedUserset: { relation: string };
  };
  union?: { child: RawRelation[] };
  intersection?: { child: RawRelation[] };
  difference?: { base: RawRelation; subtract: RawRelation };
}

interface RawType {
  type: string;
  relations?: Record<string, RawRelation>;
  metadata?: {
    relations?: Record<
      string,
      {
        directly_related_user_types?: Array<{
          type: string;
          relation?: string;
          wildcard?: Record<string, never>;
          condition?: string;
        }>;
      }
    >;
  };
}

interface RawModel {
  schema_version?: string;
  type_definitions?: RawType[];
  conditions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a model (DSL or JSON string) into a {@link RawModel}.
 *
 * Models loaded from a live store are already JSON, so JSON is tried first.
 * For editor DSL we prefer the official `@openfga/syntax-transformer` (handles
 * `and` / `but not` / modular models), falling back to the in-repo `dslToJson`
 * only if the transformer rejects an in-progress edit.
 */
function toRawModel(input: string): RawModel {
  const trimmed = input.trim();
  if (!trimmed) return { type_definitions: [] };

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as RawModel;
  }

  try {
    return transformer.transformDSLToJSONObject(trimmed) as unknown as RawModel;
  } catch (transformerError) {
    try {
      return dslToJson(trimmed) as unknown as RawModel;
    } catch {
      // Surface the richer transformer error (it has line/column info).
      throw transformerError;
    }
  }
}

function toRewrite(def: RawRelation): Rewrite {
  if (def.this !== undefined) return { kind: 'this' };
  if (def.computedUserset) {
    return { kind: 'computed', relation: def.computedUserset.relation };
  }
  if (def.tupleToUserset) {
    return {
      kind: 'ttu',
      tupleset: def.tupleToUserset.tupleset.relation,
      computedRelation: def.tupleToUserset.computedUserset.relation,
    };
  }
  if (def.union) {
    return { kind: 'union', children: def.union.child.map(toRewrite) };
  }
  if (def.intersection) {
    return {
      kind: 'intersection',
      children: def.intersection.child.map(toRewrite),
    };
  }
  if (def.difference) {
    return {
      kind: 'difference',
      base: toRewrite(def.difference.base),
      subtract: toRewrite(def.difference.subtract),
    };
  }
  // Unknown/empty rewrite — treat as a direct leaf so callers stay total.
  return { kind: 'this' };
}

/** Render a rewrite back to a compact DSL-like string for tooltips. */
export function rewriteToDsl(
  rewrite: Rewrite,
  directlyRelated: DirectAssignment[] = [],
): string {
  switch (rewrite.kind) {
    case 'this': {
      if (directlyRelated.length === 0) return '[]';
      return `[${directlyRelated.map(formatDirect).join(', ')}]`;
    }
    case 'computed':
      return rewrite.relation;
    case 'ttu':
      return `${rewrite.computedRelation} from ${rewrite.tupleset}`;
    case 'union':
      return rewrite.children
        .map((c) => rewriteToDsl(c, directlyRelated))
        .join(' or ');
    case 'intersection':
      return rewrite.children
        .map((c) => rewriteToDsl(c, directlyRelated))
        .join(' and ');
    case 'difference':
      return `${rewriteToDsl(rewrite.base, directlyRelated)} but not ${rewriteToDsl(
        rewrite.subtract,
        directlyRelated,
      )}`;
  }
}

function formatDirect(d: DirectAssignment): string {
  let s = d.type;
  if (d.relation) s += `#${d.relation}`;
  else if (d.wildcard) s += ':*';
  if (d.condition) s += ` with ${d.condition}`;
  return s;
}

/** Build the structured model from a DSL or JSON string. */
export function buildStructuredModel(input: string): StructuredModel {
  const raw = toRawModel(input);
  const relationsById = new Map<string, RelationDef>();
  const types: TypeDef[] = [];

  for (const rawType of raw.type_definitions ?? []) {
    const relations: RelationDef[] = [];
    const relEntries = Object.entries(rawType.relations ?? {});
    for (const [name, def] of relEntries) {
      const directlyRelated: DirectAssignment[] = (
        rawType.metadata?.relations?.[name]?.directly_related_user_types ?? []
      ).map((d) => ({
        type: d.type,
        relation: d.relation,
        wildcard: d.wildcard !== undefined,
        condition: d.condition,
      }));

      const rewrite = toRewrite(def);
      const relation: RelationDef = {
        type: rawType.type,
        name,
        id: `${rawType.type}#${name}`,
        rewrite,
        directlyRelated,
        dsl: rewriteToDsl(rewrite, directlyRelated),
      };
      relations.push(relation);
      relationsById.set(relation.id, relation);
    }
    types.push({ name: rawType.type, relations });
  }

  return {
    schemaVersion: raw.schema_version ?? '1.1',
    types,
    relationsById,
    conditionNames: Object.keys(raw.conditions ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Diagram derivation (types + relations as nodes, rewrite references as edges)
// ---------------------------------------------------------------------------

export type DiagramNodeKind = 'type' | 'relation';

export interface DiagramNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  /** The owning type (for relation nodes) or the type itself (for type nodes). */
  type: string;
  /** For relation nodes, the owning type. */
  parentType?: string;
  /** For relation nodes, the DSL rewrite (tooltip). */
  dsl?: string;
  /** For relation nodes, whether a condition guards any direct assignment. */
  hasCondition?: boolean;
  /** For type nodes, how many relations it owns. */
  relationCount?: number;
  /**
   * For relation nodes, the directly-assignable concrete/wildcard types shown
   * as chips ON the node (e.g. `user`, `user:*`) instead of edges to a shared
   * hub — this is what keeps large graphs from turning into spaghetti.
   */
  terminalChips?: string[];
}

export type DiagramEdgeKind = 'owns' | 'computed' | 'ttu' | 'direct';

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  kind: DiagramEdgeKind;
  label?: string;
  /** Owning type of the source/target nodes — used to aggregate edges when a
   * type group is collapsed. */
  sourceType: string;
  targetType: string;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const typeNodeId = (type: string) => `type:${type}`;
const relNodeId = (type: string, relation: string) => `rel:${type}#${relation}`;

/**
 * Collect the relation names referenced by a rewrite on the SAME type
 * (computed usersets and the tupleset side of a TTU).
 */
function collectRefs(
  rewrite: Rewrite,
  computed: Set<string>,
  ttu: Array<{ tupleset: string; computedRelation: string }>,
): void {
  switch (rewrite.kind) {
    case 'computed':
      computed.add(rewrite.relation);
      break;
    case 'ttu':
      ttu.push({ tupleset: rewrite.tupleset, computedRelation: rewrite.computedRelation });
      break;
    case 'union':
    case 'intersection':
      rewrite.children.forEach((c) => collectRefs(c, computed, ttu));
      break;
    case 'difference':
      collectRefs(rewrite.base, computed, ttu);
      collectRefs(rewrite.subtract, computed, ttu);
      break;
    case 'this':
      break;
  }
}

/**
 * Derive a playground-style diagram from the structured model: a node per type
 * and per relation, with edges for ownership, computed usersets, tuple-to-userset
 * references, and direct userset assignments (`group#member`).
 */
export function buildDiagram(model: StructuredModel): Diagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const edgeIds = new Set<string>();

  const relationExists = (type: string, relation: string) =>
    model.relationsById.has(`${type}#${relation}`);
  const relTypeOf = (id: string) => id.replace(/^rel:/, '').split('#')[0];

  const addEdge = (edge: Omit<DiagramEdge, 'sourceType' | 'targetType'>) => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push({ ...edge, sourceType: relTypeOf(edge.source), targetType: relTypeOf(edge.target) });
  };

  // Only types that own relations become nodes; pure terminal types (e.g. `user`)
  // live as chips on the relations that reference them.
  for (const type of model.types) {
    if (type.relations.length === 0) continue;
    nodes.push({
      id: typeNodeId(type.name),
      kind: 'type',
      label: type.name,
      type: type.name,
      relationCount: type.relations.length,
    });
  }

  for (const type of model.types) {
    const tId = typeNodeId(type.name);

    for (const rel of type.relations) {
      const rId = relNodeId(type.name, rel.name);

      // Concrete / wildcard direct types → chips on the node. Userset references
      // (`group#member`) stay as edges (they're meaningful cross-node links).
      const terminalChips = rel.directlyRelated
        .filter((d) => !d.relation)
        .map((d) => (d.wildcard ? `${d.type}:*` : d.type));

      nodes.push({
        id: rId,
        kind: 'relation',
        label: rel.name,
        type: type.name,
        parentType: type.name,
        dsl: rel.dsl,
        hasCondition: rel.directlyRelated.some((d) => d.condition),
        terminalChips: [...new Set(terminalChips)],
      });

      addEdge({ id: `owns:${tId}->${rId}`, source: tId, target: rId, kind: 'owns' });

      const computed = new Set<string>();
      const ttus: Array<{ tupleset: string; computedRelation: string }> = [];
      collectRefs(rel.rewrite, computed, ttus);

      for (const other of computed) {
        if (!relationExists(type.name, other)) continue;
        const target = relNodeId(type.name, other);
        addEdge({ id: `computed:${rId}->${target}`, source: rId, target, kind: 'computed' });
      }

      for (const ttu of ttus) {
        if (relationExists(type.name, ttu.tupleset)) {
          const tuplesetNode = relNodeId(type.name, ttu.tupleset);
          addEdge({
            id: `ttu:${rId}->${tuplesetNode}`,
            source: rId,
            target: tuplesetNode,
            kind: 'ttu',
            label: `${ttu.computedRelation} from`,
          });
          const tuplesetRel = model.relationsById.get(`${type.name}#${ttu.tupleset}`);
          for (const linked of tuplesetRel?.directlyRelated ?? []) {
            if (relationExists(linked.type, ttu.computedRelation)) {
              const target = relNodeId(linked.type, ttu.computedRelation);
              addEdge({
                id: `ttu-target:${rId}->${target}`,
                source: rId,
                target,
                kind: 'ttu',
                label: ttu.computedRelation,
              });
            }
          }
        }
      }

      // Userset direct assignments only (e.g. `group#member`) — concrete types
      // are chips, handled above.
      for (const d of rel.directlyRelated) {
        if (d.relation && relationExists(d.type, d.relation)) {
          const target = relNodeId(d.type, d.relation);
          addEdge({ id: `direct:${rId}->${target}`, source: rId, target, kind: 'direct' });
        }
      }
    }
  }

  return { nodes, edges };
}
