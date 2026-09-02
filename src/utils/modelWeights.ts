import type { DirectAssignment, Rewrite, StructuredModel } from './modelGraph';

/**
 * Faithful-enough port of OpenFGA's "weighted graph" idea for performance insight
 * (cf. github.com/openfga/model-visualizer). There is no JS library for this, so
 * it is hand-rolled over the structured model.
 *
 * A relation's weight, per terminal user-type, is the worst-case number of tuple
 * traversals needed to resolve it:
 *   - a directly-assignable concrete/wildcard type costs 1 (one tuple lookup);
 *   - a userset reference (`group#member`) costs 1 + the weight of that userset;
 *   - a computed userset (same object) adds no hop — it's a rewrite alias;
 *   - a tuple-to-userset (`X from Y`) costs 1 (the tupleset lookup) + the weight
 *     of `X` on each linked type;
 *   - union / intersection / difference take the MAX over operands (worst case);
 *   - a relation that can reach itself is recursive → weight ∞.
 *
 * Higher weight ⇒ more lookups ⇒ costlier checks. ∞ flags unbounded recursion.
 */

export type Weight = number | 'infinite';

export interface RelationWeights {
  id: string; // `${type}#${name}`
  type: string;
  name: string;
  /** Weight to reach each terminal user-type. */
  perType: Map<string, Weight>;
  /** Worst case across all terminal types (∞ if any path is unbounded). */
  worstCase: Weight;
  recursive: boolean;
}

export interface ModelWeights {
  byId: Map<string, RelationWeights>;
  relations: RelationWeights[];
  /** All terminal user-types seen, sorted. */
  terminalTypes: string[];
}

const RECURSIVE_KEY = '(recursive)';

export function maxWeight(a: Weight | undefined, b: Weight | undefined): Weight {
  if (a === undefined) return b ?? 1;
  if (b === undefined) return a;
  if (a === 'infinite' || b === 'infinite') return 'infinite';
  return Math.max(a, b);
}

function addHop(map: Map<string, Weight>, hops: number): Map<string, Weight> {
  const out = new Map<string, Weight>();
  for (const [k, v] of map) out.set(k, v === 'infinite' ? 'infinite' : v + hops);
  return out;
}

function mergeMax(into: Map<string, Weight>, from: Map<string, Weight>): void {
  for (const [k, v] of from) into.set(k, maxWeight(into.get(k), v));
}

export function computeWeights(model: StructuredModel): ModelWeights {
  const memo = new Map<string, Map<string, Weight>>();

  function weightsForRelation(
    type: string,
    relation: string,
    stack: Set<string>,
  ): Map<string, Weight> {
    const id = `${type}#${relation}`;
    const cached = memo.get(id);
    if (cached) return cached;
    if (stack.has(id)) return new Map([[RECURSIVE_KEY, 'infinite']]);

    const relDef = model.relationsById.get(id);
    if (!relDef) return new Map();

    stack.add(id);
    const result = weightsOfRewrite(type, relDef.rewrite, relDef.directlyRelated, stack);
    stack.delete(id);
    // Only memoize when this relation wasn't part of an active cycle above it.
    if (!result.has(RECURSIVE_KEY)) memo.set(id, result);
    return result;
  }

  function weightsOfRewrite(
    type: string,
    rewrite: Rewrite,
    directlyRelated: DirectAssignment[],
    stack: Set<string>,
  ): Map<string, Weight> {
    switch (rewrite.kind) {
      case 'this': {
        const m = new Map<string, Weight>();
        for (const d of directlyRelated) {
          if (d.relation) {
            // userset reference like group#member: 1 hop + weight of that userset
            const sub = weightsForRelation(d.type, d.relation, stack);
            mergeMax(m, addHop(sub, 1));
          } else {
            // concrete type or public wildcard: single tuple lookup
            m.set(d.type, maxWeight(m.get(d.type), 1));
          }
        }
        return m;
      }

      case 'computed':
        // rewrite alias on the same object — no extra tuple hop
        return weightsForRelation(type, rewrite.relation, stack);

      case 'ttu': {
        const m = new Map<string, Weight>();
        const tuplesetDef = model.relationsById.get(`${type}#${rewrite.tupleset}`);
        for (const linked of tuplesetDef?.directlyRelated ?? []) {
          if (linked.relation) continue; // tuplesets reference objects, not usersets
          const sub = weightsForRelation(linked.type, rewrite.computedRelation, stack);
          mergeMax(m, addHop(sub, 1)); // +1 for the tupleset lookup
        }
        return m;
      }

      case 'union':
      case 'intersection': {
        const m = new Map<string, Weight>();
        for (const child of rewrite.children) {
          mergeMax(m, weightsOfRewrite(type, child, directlyRelated, stack));
        }
        return m;
      }

      case 'difference': {
        const m = weightsOfRewrite(type, rewrite.base, directlyRelated, stack);
        mergeMax(m, weightsOfRewrite(type, rewrite.subtract, directlyRelated, stack));
        return m;
      }
    }
  }

  const relations: RelationWeights[] = [];
  const byId = new Map<string, RelationWeights>();
  const terminalTypes = new Set<string>();

  for (const type of model.types) {
    for (const rel of type.relations) {
      const raw = weightsForRelation(type.name, rel.name, new Set());
      const recursive = raw.has(RECURSIVE_KEY);
      const perType = new Map<string, Weight>();
      let worstCase: Weight = recursive ? 'infinite' : 0;
      for (const [k, v] of raw) {
        if (k === RECURSIVE_KEY) continue;
        perType.set(k, v);
        terminalTypes.add(k);
        worstCase = maxWeight(worstCase, v);
      }
      if (worstCase === 0 && !recursive) worstCase = 0; // unreachable / empty
      const entry: RelationWeights = {
        id: rel.id,
        type: type.name,
        name: rel.name,
        perType,
        worstCase,
        recursive,
      };
      relations.push(entry);
      byId.set(rel.id, entry);
    }
  }

  return {
    byId,
    relations,
    terminalTypes: [...terminalTypes].sort(),
  };
}

/** Map a weight to a color on a green → amber → red scale (∞ = deep red). */
export function weightColor(weight: Weight | undefined): string {
  if (weight === undefined || weight === 0) return '#9e9e9e';
  if (weight === 'infinite') return '#b71c1c';
  // 1 = green (140°) … 6+ = red (0°)
  const clamped = Math.min(weight, 6);
  const hue = 140 - ((clamped - 1) / 5) * 140;
  return `hsl(${Math.round(hue)}, 70%, 42%)`;
}

export function formatWeight(weight: Weight | undefined): string {
  if (weight === undefined) return '–';
  if (weight === 'infinite') return '∞';
  return String(weight);
}
