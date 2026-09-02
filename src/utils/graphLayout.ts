import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Diagram } from './modelGraph';

export interface LayoutPosition {
  x: number;
  y: number;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

interface SimLink {
  source: string;
  target: string;
}

/**
 * Compute force-directed positions for a diagram, playground-style.
 *
 * The simulation is run synchronously to completion (no animation) so React
 * Flow receives settled coordinates; nodes remain draggable afterwards. Typical
 * authorization models have tens of nodes, so O(n^2) charge is fine.
 */
export function layoutDiagram(
  diagram: Diagram,
  seed?: Map<string, LayoutPosition>,
): Map<string, LayoutPosition> {
  // Warm-start from prior positions so expand/collapse doesn't reshuffle the
  // whole graph — only brand-new nodes are placed fresh.
  const nodes: SimNode[] = diagram.nodes.map((n, i) => {
    const prev = seed?.get(n.id);
    if (prev) return { id: n.id, x: prev.x, y: prev.y };
    // Deterministic-ish spawn point for new nodes (no Math.random available).
    const angle = (i * 137.5 * Math.PI) / 180;
    return { id: n.id, x: Math.cos(angle) * 40, y: Math.sin(angle) * 40 };
  });
  const links: SimLink[] = diagram.edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  const simulation = forceSimulation<SimNode>(nodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(150)
        .strength(0.5),
    )
    // Cap the repulsion range so isolated/disconnected nodes aren't flung off
    // to infinity (nothing links them back).
    .force('charge', forceManyBody().strength(-500).distanceMax(600))
    .force('center', forceCenter(0, 0))
    // Gentle per-node pull toward the origin keeps disconnected components
    // (types with no cross-type references) near the main cluster.
    .force('x', forceX(0).strength(0.07))
    .force('y', forceY(0).strength(0.07))
    .force('collide', forceCollide(64))
    .stop();

  // Run enough ticks for the layout to settle deterministically.
  const ticks = Math.min(400, Math.max(120, diagram.nodes.length * 8));
  for (let i = 0; i < ticks; i++) simulation.tick();

  const positions = new Map<string, LayoutPosition>();
  for (const node of nodes) {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }
  return positions;
}
