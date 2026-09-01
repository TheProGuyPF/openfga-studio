import type { Rewrite, StructuredModel } from './modelGraph';

/**
 * Client-side resolution-path builder.
 *
 * OpenFGA's Check API returns only a boolean — no trace of *why*. This engine
 * reconstructs an explanation by walking the model's userset-rewrite tree and
 * probing the server: same-object branches (computed usersets, direct
 * assignments) are resolved with Check, and tuple-to-userset (`X from Y`) edges
 * are traversed by Reading the linking tuples and recursing on the linked
 * objects.
 *
 * It is deliberately dependency-injected (see {@link ResolutionDeps}) so it can
 * be unit-tested with mocked IO and so the authoritative verdict still comes
 * from the real Check the caller already ran.
 */

export type NodeStatus = 'allowed' | 'denied' | 'error';

export type ResolutionNodeKind =
  | 'relation' // an (object#relation) expansion
  | 'operator' // union / intersection / difference
  | 'direct' // a `this` (directly-assignable) branch
  | 'computed' // a computed-userset branch
  | 'ttu' // a tuple-to-userset branch
  | 'tuple' // a concrete granting tuple / userset membership
  | 'recursive'; // cycle guard hit

export interface ResolutionNode {
  id: string;
  kind: ResolutionNodeKind;
  label: string;
  detail?: string;
  status: NodeStatus;
  /** True when this node lies on a path that grants access (the ACL path). */
  contributed: boolean;
  children: ResolutionNode[];
  /** True when there are un-evaluated children (lazy / capped). */
  expandable?: boolean;
  object?: string;
  relation?: string;
}

export interface CheckItem {
  user: string;
  relation: string;
  object: string;
}

export interface ResolutionDeps {
  model: StructuredModel;
  /** Batched checks — results aligned to the input order. */
  check: (items: CheckItem[]) => Promise<boolean[]>;
  /** Read the subject side of tuples matching (object, relation). */
  read: (object: string, relation: string) => Promise<string[]>;
}

export interface ResolutionParams {
  user: string;
  object: string;
  relation: string;
}

export type ResolutionMode = 'acl' | 'full';

/** Max userset/linked-object fan-out probed per branch before we mark it expandable. */
const FANOUT_CAP = 25;

const typeOf = (ref: string) => ref.split(':')[0];

export async function resolveCheck(
  params: ResolutionParams,
  deps: ResolutionDeps,
  mode: ResolutionMode = 'acl',
): Promise<ResolutionNode> {
  const { model, check, read } = deps;
  let idSeq = 0;
  const nextId = () => `n${idSeq++}`;

  const statusFor = (allowed: boolean): NodeStatus => (allowed ? 'allowed' : 'denied');

  async function evalRelation(
    object: string,
    relation: string,
    visited: Set<string>,
  ): Promise<ResolutionNode> {
    const key = `${object}#${relation}`;
    const base: ResolutionNode = {
      id: nextId(),
      kind: 'relation',
      label: `${object}#${relation}`,
      status: 'denied',
      contributed: false,
      children: [],
      object,
      relation,
    };

    if (visited.has(key)) {
      base.kind = 'recursive';
      base.detail = 'recursive reference (cycle guard)';
      base.expandable = true;
      // Fall back to an authoritative check so status is still correct.
      const [allowed] = await check([{ user: params.user, relation, object }]);
      base.status = statusFor(allowed);
      base.contributed = allowed;
      return base;
    }

    const relDef = model.relationsById.get(`${typeOf(object)}#${relation}`);
    if (!relDef) {
      const [allowed] = await check([{ user: params.user, relation, object }]);
      base.status = statusFor(allowed);
      base.contributed = allowed;
      return base;
    }

    const visited2 = new Set(visited).add(key);
    const child = await evalRewrite(object, relation, relDef.rewrite, visited2);
    base.children = [child];
    base.status = child.status;
    base.contributed = child.contributed;
    return base;
  }

  async function evalRewrite(
    object: string,
    relation: string,
    rewrite: Rewrite,
    visited: Set<string>,
  ): Promise<ResolutionNode> {
    switch (rewrite.kind) {
      case 'this':
        return evalDirect(object, relation, visited);

      case 'computed': {
        const child = await evalRelation(object, rewrite.relation, visited);
        return {
          id: nextId(),
          kind: 'computed',
          label: rewrite.relation,
          detail: `computed userset on ${object}`,
          status: child.status,
          contributed: child.contributed,
          children: [child],
        };
      }

      case 'ttu':
        return evalTtu(object, rewrite.tupleset, rewrite.computedRelation, visited);

      case 'union': {
        const children: ResolutionNode[] = [];
        let allowed = false;
        for (const c of rewrite.children) {
          if (mode === 'acl' && allowed) {
            children.push({
              id: nextId(),
              kind: 'operator',
              label: describeRewrite(c),
              detail: 'not evaluated (already satisfied)',
              status: 'denied',
              contributed: false,
              children: [],
              expandable: true,
            });
            continue;
          }
          const node = await evalRewrite(object, relation, c, visited);
          children.push(node);
          if (node.status === 'allowed') allowed = true;
        }
        return {
          id: nextId(),
          kind: 'operator',
          label: 'OR',
          detail: 'union — any child grants access',
          status: statusFor(allowed),
          contributed: allowed,
          children,
        };
      }

      case 'intersection': {
        const children: ResolutionNode[] = [];
        for (const c of rewrite.children) {
          children.push(await evalRewrite(object, relation, c, visited));
        }
        const allowed = children.every((n) => n.status === 'allowed');
        // On the ACL path only when the whole intersection holds.
        children.forEach((n) => (n.contributed = allowed && n.status === 'allowed'));
        return {
          id: nextId(),
          kind: 'operator',
          label: 'AND',
          detail: 'intersection — all children required',
          status: statusFor(allowed),
          contributed: allowed,
          children,
        };
      }

      case 'difference': {
        const baseNode = await evalRewrite(object, relation, rewrite.base, visited);
        const subtractNode = await evalRewrite(object, relation, rewrite.subtract, visited);
        const allowed = baseNode.status === 'allowed' && subtractNode.status !== 'allowed';
        baseNode.contributed = allowed;
        // If the subtract branch matched, it's the reason access is denied.
        subtractNode.detail = subtractNode.detail
          ? `${subtractNode.detail} (excludes when satisfied)`
          : 'exclusion — denies when satisfied';
        return {
          id: nextId(),
          kind: 'operator',
          label: 'BUT NOT',
          detail: 'difference — base grants unless exclusion matches',
          status: statusFor(allowed),
          contributed: allowed,
          children: [baseNode, subtractNode],
        };
      }
    }
  }

  /** Resolve a `this` (directly-assignable) branch by reading granting tuples. */
  async function evalDirect(
    object: string,
    relation: string,
    visited: Set<string>,
  ): Promise<ResolutionNode> {
    const node: ResolutionNode = {
      id: nextId(),
      kind: 'direct',
      label: 'direct assignment',
      detail: `tuples on ${object}#${relation}`,
      status: 'denied',
      contributed: false,
      children: [],
    };

    let subjects: string[];
    try {
      subjects = await read(object, relation);
    } catch {
      node.status = 'error';
      node.detail = 'failed to read tuples';
      return node;
    }

    const userType = typeOf(params.user);
    const usersetSubjects: string[] = [];

    for (const subject of subjects) {
      if (subject === params.user) {
        node.children.push({
          id: nextId(),
          kind: 'tuple',
          label: subject,
          detail: 'direct tuple',
          status: 'allowed',
          contributed: true,
          children: [],
        });
        node.status = 'allowed';
        node.contributed = true;
      } else if (subject.endsWith(':*') && typeOf(subject) === userType) {
        node.children.push({
          id: nextId(),
          kind: 'tuple',
          label: subject,
          detail: 'public wildcard',
          status: 'allowed',
          contributed: true,
          children: [],
        });
        node.status = 'allowed';
        node.contributed = true;
      } else if (subject.includes('#')) {
        usersetSubjects.push(subject);
      }
    }

    // In ACL mode, once we already have a direct/wildcard grant we can stop.
    if (mode === 'acl' && node.status === 'allowed') {
      if (usersetSubjects.length) node.expandable = true;
      return node;
    }

    const probe = usersetSubjects.slice(0, FANOUT_CAP);
    if (usersetSubjects.length > FANOUT_CAP) node.expandable = true;

    if (probe.length) {
      const items: CheckItem[] = probe.map((s) => {
        const [obj, rel] = s.split('#');
        return { user: params.user, relation: rel, object: obj };
      });
      const results = await check(items);
      for (let i = 0; i < probe.length; i++) {
        const [obj, rel] = probe[i].split('#');
        const allowed = results[i];
        const usersetNode: ResolutionNode = {
          id: nextId(),
          kind: 'tuple',
          label: probe[i],
          detail: `userset membership: ${params.user} as ${rel} on ${obj}`,
          status: statusFor(allowed),
          contributed: allowed,
          children: [],
        };
        // Expand the winning userset to show the deeper path.
        if (allowed && (mode === 'full' || node.status !== 'allowed')) {
          try {
            const deeper = await evalRelation(obj, rel, visited);
            usersetNode.children = deeper.children;
          } catch {
            /* keep the flat membership node */
          }
        }
        node.children.push(usersetNode);
        if (allowed) {
          node.status = 'allowed';
          node.contributed = true;
          if (mode === 'acl') break;
        }
      }
    }

    return node;
  }

  /** Resolve a tuple-to-userset (`computedRel from tupleset`) branch. */
  async function evalTtu(
    object: string,
    tupleset: string,
    computedRel: string,
    visited: Set<string>,
  ): Promise<ResolutionNode> {
    const node: ResolutionNode = {
      id: nextId(),
      kind: 'ttu',
      label: `${computedRel} from ${tupleset}`,
      detail: `via ${object}#${tupleset}`,
      status: 'denied',
      contributed: false,
      children: [],
    };

    let linked: string[];
    try {
      linked = await read(object, tupleset);
    } catch {
      node.status = 'error';
      node.detail = 'failed to read tupleset';
      return node;
    }

    const probe = linked.slice(0, FANOUT_CAP);
    if (linked.length > FANOUT_CAP) node.expandable = true;

    for (const linkedObject of probe) {
      // The tupleset subject is the linked object (e.g. repo owner -> org:x).
      const child = await evalRelation(linkedObject, computedRel, visited);
      node.children.push(child);
      if (child.status === 'allowed') {
        node.status = 'allowed';
        node.contributed = true;
        if (mode === 'acl') break;
      }
    }

    return node;
  }

  return evalRelation(params.object, params.relation, new Set());
}

/** Short human label for an un-evaluated rewrite (lazy union placeholder). */
function describeRewrite(rewrite: Rewrite): string {
  switch (rewrite.kind) {
    case 'this':
      return 'direct assignment';
    case 'computed':
      return rewrite.relation;
    case 'ttu':
      return `${rewrite.computedRelation} from ${rewrite.tupleset}`;
    case 'union':
      return 'OR (…)';
    case 'intersection':
      return 'AND (…)';
    case 'difference':
      return 'BUT NOT (…)';
  }
}
