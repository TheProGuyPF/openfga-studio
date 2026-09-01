import type { ResolutionNode, NodeStatus } from '../../utils/resolutionEngine';

/**
 * Transform a {@link ResolutionNode} tree into a playground-style flow diagram:
 * the object#relation at the top, the granting user/tuple at the bottom, arrows
 * flowing upward. Verbose wrapper nodes (computed usersets, tuple-to-usersets,
 * pass-through unions) are collapsed into edge labels so a path reads as a short
 * chain instead of a deep indented list.
 */

export type FlowKind = 'relation' | 'operator' | 'direct' | 'tuple' | 'recursive';

interface FlowBox {
  id: string;
  label: string;
  sub?: string;
  status: NodeStatus;
  kind: FlowKind;
  emphasize: boolean;
  edgeLabel?: string;
  x: number;
  y: number;
  children: FlowBox[];
}

export interface ResolutionFlowNodeData {
  label: string;
  sub?: string;
  status: NodeStatus;
  kind: FlowKind;
  emphasize: boolean;
  /** Search-highlight state, applied at render time. */
  dimmed?: boolean;
  focused?: boolean;
}

export interface ResolutionFlowNode {
  id: string;
  position: { x: number; y: number };
  data: ResolutionFlowNodeData;
}

export interface ResolutionFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  allowed: boolean;
}

const X_SPACING = 240;
const Y_SPACING = 120;

/** Middle-ellipsis long ids so boxes stay a readable width. */
export function shorten(label: string, max = 30): string {
  if (label.length <= max) return label;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}

export function buildResolutionFlow(root: ResolutionNode): {
  nodes: ResolutionFlowNode[];
  edges: ResolutionFlowEdge[];
} {
  let seq = 0;
  const id = () => `f${seq++}`;

  const buildRelation = (node: ResolutionNode, isRoot: boolean): FlowBox => {
    const box: FlowBox = {
      id: id(),
      label: node.label,
      status: node.status,
      kind: 'relation',
      emphasize: isRoot,
      x: 0,
      y: 0,
      children: [],
    };
    for (const child of node.children) {
      const built = buildRewrite(child);
      if (built) box.children.push(built);
    }
    return box;
  };

  const buildRewrite = (node: ResolutionNode): FlowBox | null => {
    switch (node.kind) {
      case 'relation':
        return buildRelation(node, false);

      case 'operator': {
        const built = node.children.map(buildRewrite).filter((b): b is FlowBox => b !== null);
        if (built.length <= 1) return built[0] ?? null; // pass-through union
        return {
          id: id(),
          label: node.label,
          sub: node.detail,
          status: node.status,
          kind: 'operator',
          emphasize: false,
          x: 0,
          y: 0,
          children: built,
        };
      }

      case 'computed': {
        const rel = node.children[0];
        if (!rel) return null;
        const b = buildRelation(rel, false);
        b.edgeLabel = 'computed';
        return b;
      }

      case 'ttu': {
        const built = node.children.map((c) => buildRelation(c, false));
        built.forEach((b) => (b.edgeLabel = node.label)); // e.g. "reader from owner"
        if (built.length === 1) return built[0];
        return {
          id: id(),
          label: node.label,
          status: node.status,
          kind: 'operator',
          emphasize: false,
          x: 0,
          y: 0,
          children: built,
        };
      }

      case 'direct': {
        const box: FlowBox = {
          id: id(),
          label: 'Directly assigned',
          status: node.status,
          kind: 'direct',
          emphasize: false,
          x: 0,
          y: 0,
          children: [],
        };
        for (const child of node.children) {
          const built = buildRewrite(child);
          if (built) box.children.push(built);
        }
        return box;
      }

      case 'tuple': {
        const box: FlowBox = {
          id: id(),
          label: node.label,
          sub: node.detail,
          status: node.status,
          kind: 'tuple',
          emphasize: true,
          x: 0,
          y: 0,
          children: [],
        };
        for (const child of node.children) {
          const built = buildRewrite(child);
          if (built) box.children.push(built);
        }
        return box;
      }

      case 'recursive':
        return {
          id: id(),
          label: node.label,
          sub: 'recursive',
          status: node.status,
          kind: 'recursive',
          emphasize: false,
          x: 0,
          y: 0,
          children: [],
        };
    }
  };

  const tree = buildRelation(root, true);

  // Tidy-tree layout: root at top (depth 0), leaves at the bottom.
  let leafX = 0;
  const assign = (box: FlowBox, depth: number) => {
    box.y = depth * Y_SPACING;
    if (box.children.length === 0) {
      box.x = leafX * X_SPACING;
      leafX += 1;
      return;
    }
    box.children.forEach((c) => assign(c, depth + 1));
    box.x = (box.children[0].x + box.children[box.children.length - 1].x) / 2;
  };
  assign(tree, 0);

  const nodes: ResolutionFlowNode[] = [];
  const edges: ResolutionFlowEdge[] = [];
  const walk = (box: FlowBox, parent: FlowBox | null) => {
    nodes.push({
      id: box.id,
      position: { x: box.x, y: box.y },
      data: {
        label: box.label,
        sub: box.sub,
        status: box.status,
        kind: box.kind,
        emphasize: box.emphasize,
      },
    });
    if (parent) {
      // Edge points from child (below) up into the parent (above).
      edges.push({
        id: `${box.id}->${parent.id}`,
        source: box.id,
        target: parent.id,
        label: box.edgeLabel,
        allowed: box.status === 'allowed' && parent.status === 'allowed',
      });
    }
    box.children.forEach((c) => walk(c, box));
  };
  walk(tree, null);

  return { nodes, edges };
}
