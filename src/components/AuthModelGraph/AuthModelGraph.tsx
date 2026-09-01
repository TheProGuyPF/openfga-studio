import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  useNodesState,
  getRectOfNodes,
  getTransformForBounds,
  Panel,
  MarkerType,
  type Node,
  type Edge,
} from 'reactflow';
import {
  useTheme,
  IconButton,
  Tooltip,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Select,
  MenuItem,
  Box,
  Button,
} from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import SearchIcon from '@mui/icons-material/Search';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { toPng } from 'html-to-image';
import { CustomNode, type CustomNodeData } from './CustomNode';
import { GraphLegend } from './GraphLegend';
import { GraphOutline } from './GraphOutline';
import { HeaviestRelations } from './HeaviestRelations';
import {
  buildDiagram,
  type StructuredModel,
  type Diagram,
  type DiagramEdge,
  type DiagramEdgeKind,
} from '../../utils/modelGraph';
import { computeWeights, weightColor, formatWeight } from '../../utils/modelWeights';
import { layoutDiagram, type LayoutPosition } from '../../utils/graphLayout';
import 'reactflow/dist/style.css';

type ViewMode = 'diagram' | 'weighted';
const WORST = '__worst__';

interface AuthModelGraphProps {
  model: StructuredModel | null;
}

function edgeColor(kind: DiagramEdgeKind, dark: boolean): string {
  switch (kind) {
    case 'owns':
      return dark ? '#555' : '#c2c2c2';
    case 'computed':
      return '#31c48d';
    case 'ttu':
      return '#ff9800';
    case 'direct':
      return '#2684ff';
  }
}

/** Build the visible graph for the current collapse state, rerouting/aggregating
 * edges of collapsed types onto their type node. */
function computeVisible(diagram: Diagram, collapsed: Set<string>): Diagram {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const nodes = diagram.nodes.filter(
    (n) => !(n.kind === 'relation' && collapsed.has(n.parentType!)),
  );
  const mapId = (id: string) => {
    const n = byId.get(id);
    if (n && n.kind === 'relation' && collapsed.has(n.parentType!)) return `type:${n.parentType}`;
    return id;
  };

  const seen = new Map<string, DiagramEdge>();
  for (const e of diagram.edges) {
    if (e.kind === 'owns') {
      if (collapsed.has(e.targetType)) continue; // relation hidden
      seen.set(e.id, e);
      continue;
    }
    const source = mapId(e.source);
    const target = mapId(e.target);
    if (source === target) continue; // intra-collapsed reference
    const key = `${e.kind}:${source}->${target}`;
    if (!seen.has(key)) {
      const aggregated = source !== e.source || target !== e.target;
      seen.set(key, { ...e, id: key, source, target, label: aggregated ? undefined : e.label });
    }
  }
  return { nodes, edges: [...seen.values()] };
}

const DownloadButton = () => {
  const { getNodes } = useReactFlow();
  const theme = useTheme();
  const downloadImage = useCallback(async () => {
    const flow = document.querySelector('.react-flow') as HTMLElement | null;
    if (!flow) return;
    const bounds = getRectOfNodes(getNodes());
    const transform = getTransformForBounds(bounds, bounds.width, bounds.height, 0.5, 2);
    try {
      const dataUrl = await toPng(flow, {
        backgroundColor: theme.palette.background.default,
        width: bounds.width + 80,
        height: bounds.height + 80,
        style: { transform: `translate(${transform[0]}px, ${transform[1]}px) scale(${transform[2]})` },
      });
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = 'authorization-model-graph.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Failed to download graph:', error);
    }
  }, [getNodes, theme.palette.background.default]);

  return (
    <Tooltip title="Download graph">
      <IconButton
        onClick={downloadImage}
        sx={{ bgcolor: 'background.paper', boxShadow: 1, '&:hover': { bgcolor: 'action.hover' } }}
      >
        <FileDownloadIcon />
      </IconButton>
    </Tooltip>
  );
};

function Flow({ model }: AuthModelGraphProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const { setCenter, fitView } = useReactFlow();

  const [focusId, setFocusId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('diagram');
  const [terminal, setTerminal] = useState<string>(WORST);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const positionsRef = useRef<Map<string, LayoutPosition>>(new Map());
  const pendingFocusRef = useRef<string | null>(null);

  const fullDiagram = useMemo(() => (model ? buildDiagram(model) : { nodes: [], edges: [] }), [model]);
  const weights = useMemo(() => (model ? computeWeights(model) : null), [model]);
  const typeNames = useMemo(
    () => (model ? model.types.filter((t) => t.relations.length > 0).map((t) => t.name) : []),
    [model],
  );

  // Collapse every type by default when the model loads (legible overview first).
  useEffect(() => {
    setCollapsed(new Set(typeNames));
    positionsRef.current = new Map();
    setFocusId(null);
  }, [typeNames]);

  useEffect(() => {
    if (terminal !== WORST && weights && !weights.terminalTypes.includes(terminal)) {
      setTerminal(WORST);
    }
  }, [weights, terminal]);

  const visible = useMemo(() => computeVisible(fullDiagram, collapsed), [fullDiagram, collapsed]);

  const { baseNodes, baseEdges } = useMemo(() => {
    // Warm-start: keep existing node positions; seed new relations near their type.
    const seed = new Map(positionsRef.current);
    visible.nodes.forEach((n, i) => {
      if (seed.has(n.id)) return;
      if (n.kind === 'relation' && n.parentType) {
        const tp = seed.get(`type:${n.parentType}`);
        if (tp) seed.set(n.id, { x: tp.x + ((i % 5) - 2) * 40, y: tp.y + (i % 7) * 30 });
      }
    });
    const positions = layoutDiagram(visible, seed);
    positionsRef.current = positions;

    const baseNodes: Node<CustomNodeData>[] = visible.nodes.map((n) => ({
      id: n.id,
      type: 'custom',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: {
        kind: n.kind,
        label: n.label,
        parentType: n.parentType,
        dsl: n.dsl,
        hasCondition: n.hasCondition,
        relationCount: n.relationCount,
        terminalChips: n.terminalChips,
      },
    }));
    const baseEdges: Edge[] = visible.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'default',
      style: {
        stroke: edgeColor(e.kind, dark),
        strokeWidth: e.kind === 'owns' ? 1 : 2,
        strokeDasharray: e.kind === 'ttu' ? '6 4' : undefined,
      },
      labelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
      labelBgStyle: { fill: theme.palette.background.paper },
      markerEnd:
        e.kind === 'owns'
          ? undefined
          : { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeColor(e.kind, dark) },
    }));
    return { baseNodes, baseEdges };
    // layoutNonce forces a fresh relayout when the user hits "Re-arrange".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, dark, theme.palette.text.secondary, theme.palette.background.paper, layoutNonce]);

  const [nodes, setNodes, onNodesChange] = useNodesState(baseNodes);

  useEffect(() => {
    setNodes(baseNodes);
  }, [baseNodes, setNodes]);

  // Resolve a pending focus (from the outline / heaviest table) once its node
  // exists after an expand-triggered relayout.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const node = nodes.find((n) => n.id === pendingFocusRef.current);
    if (node) {
      setFocusId(node.id);
      setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 500 });
      pendingFocusRef.current = null;
    }
  }, [nodes, setCenter]);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set());
      map.get(a)!.add(b);
    };
    for (const e of baseEdges) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return map;
  }, [baseEdges]);

  const query = search.trim().toLowerCase();
  const searchMatches = useMemo(() => {
    if (!query) return null;
    return new Set(visible.nodes.filter((n) => n.label.toLowerCase().includes(query)).map((n) => n.id));
  }, [query, visible.nodes]);

  useEffect(() => {
    if (!searchMatches || searchMatches.size === 0) return;
    const first = [...searchMatches][0];
    const node = nodes.find((n) => n.id === first);
    if (node) setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const activeSet = useMemo(() => {
    if (searchMatches) return searchMatches;
    if (focusId) return new Set<string>([focusId, ...(neighbours.get(focusId) ?? [])]);
    return null;
  }, [searchMatches, focusId, neighbours]);

  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        const data: CustomNodeData = {
          ...n.data,
          dimmed: activeSet ? !activeSet.has(n.id) : false,
          focused: searchMatches ? searchMatches.has(n.id) : n.id === focusId,
          collapsed: n.data.kind === 'type' ? collapsed.has(n.data.label) : undefined,
          weightLabel: undefined,
          weightColor: undefined,
          infinite: false,
        };
        if (viewMode === 'weighted' && weights && n.data.kind === 'relation') {
          const rw = weights.byId.get(`${n.data.parentType}#${n.data.label}`);
          if (rw) {
            const w = terminal === WORST ? rw.worstCase : rw.perType.get(terminal);
            data.weightLabel = formatWeight(w);
            data.weightColor = weightColor(w);
            data.infinite = w === 'infinite' || rw.recursive;
          }
        }
        return { ...n, data };
      }),
    [nodes, activeSet, searchMatches, focusId, collapsed, viewMode, weights, terminal],
  );

  const displayEdges = useMemo(
    () =>
      baseEdges.map((e) => ({
        ...e,
        style: {
          ...e.style,
          opacity: activeSet && !(activeSet.has(e.source) && activeSet.has(e.target)) ? 0.1 : 1,
        },
      })),
    [baseEdges, activeSet],
  );

  const toggleType = (type: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  const centerNode = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (node) {
      setFocusId(id);
      setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 500 });
    }
  };

  const selectType = (type: string) => centerNode(`type:${type}`);

  const selectRelation = (relationId: string) => {
    const [type] = relationId.split('#');
    const nodeId = `rel:${relationId}`;
    if (collapsed.has(type)) {
      // Expand its type, then focus once the node exists (see pending effect).
      pendingFocusRef.current = nodeId;
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(type);
        return next;
      });
    } else {
      centerNode(nodeId);
    }
  };

  const onNodeClick = (_: unknown, node: Node<CustomNodeData>) => {
    if (node.data.kind === 'type') toggleType(node.data.label);
    else setFocusId((cur) => (cur === node.id ? null : node.id));
  };

  const reArrange = () => {
    positionsRef.current = new Map(); // discard drift / drags → fresh layout
    setFocusId(null);
    setLayoutNonce((n) => n + 1);
    setTimeout(() => fitView({ padding: 0.3, duration: 600 }), 80);
  };

  return (
    <ReactFlow
      nodes={displayNodes}
      edges={displayEdges}
      onNodesChange={onNodesChange}
      nodeTypes={{ custom: CustomNode }}
      onNodeClick={onNodeClick}
      onPaneClick={() => setFocusId(null)}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1.25, minZoom: 0.2 }}
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      style={{ background: theme.palette.background.default, borderRadius: 8 }}
    >
      <Background color={dark ? '#555' : '#e0e0e0'} gap={24} size={1.5} />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        style={{ marginBottom: 90 }}
        nodeColor={(n) => (n.data?.kind === 'type' ? '#7c5cff' : '#31c48d')}
      />
      <Panel position="top-left">
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: 260 }}>
            <ToggleButtonGroup
              value={viewMode}
              exclusive
              size="small"
              onChange={(_, next: ViewMode | null) => next && setViewMode(next)}
              sx={{ bgcolor: 'background.paper', borderRadius: 1 }}
            >
              <ToggleButton value="diagram" sx={{ textTransform: 'none', fontSize: 12, flex: 1 }}>
                Diagram
              </ToggleButton>
              <ToggleButton value="weighted" sx={{ textTransform: 'none', fontSize: 12, flex: 1 }}>
                Weighted
              </ToggleButton>
            </ToggleButtonGroup>

            {viewMode === 'diagram' ? (
              <TextField
                size="small"
                placeholder="Search types & relations"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                sx={{ bgcolor: 'background.paper', borderRadius: 1 }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
            ) : (
              <Select
                size="small"
                value={terminal}
                onChange={(e) => setTerminal(e.target.value)}
                sx={{ bgcolor: 'background.paper', borderRadius: 1 }}
              >
                <MenuItem value={WORST}>Worst case (all types)</MenuItem>
                {weights?.terminalTypes.map((t) => (
                  <MenuItem key={t} value={t}>
                    weight to reach {t}
                  </MenuItem>
                ))}
              </Select>
            )}

            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Tooltip title="Outline">
                <IconButton
                  size="small"
                  color={outlineOpen ? 'primary' : 'default'}
                  onClick={() => setOutlineOpen((o) => !o)}
                  sx={{ bgcolor: 'background.paper', boxShadow: 1 }}
                >
                  <AccountTreeIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Re-arrange layout">
                <IconButton
                  size="small"
                  onClick={reArrange}
                  sx={{ bgcolor: 'background.paper', boxShadow: 1 }}
                >
                  <AutoFixHighIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Button
                size="small"
                variant="outlined"
                startIcon={<UnfoldMoreIcon />}
                onClick={() => setCollapsed(new Set())}
                sx={{ bgcolor: 'background.paper', textTransform: 'none', fontSize: 12 }}
              >
                Expand all
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<UnfoldLessIcon />}
                onClick={() => setCollapsed(new Set(typeNames))}
                sx={{ bgcolor: 'background.paper', textTransform: 'none', fontSize: 12 }}
              >
                Collapse
              </Button>
            </Box>
          </Box>

          {outlineOpen && model && (
            <GraphOutline
              model={model}
              collapsed={collapsed}
              onToggleType={toggleType}
              onSelectType={selectType}
              onSelectRelation={selectRelation}
            />
          )}
        </Box>
      </Panel>
      <Panel position="top-right">
        <DownloadButton />
      </Panel>
      <Panel position="bottom-left">
        {viewMode === 'weighted' && weights ? (
          <HeaviestRelations
            weights={weights}
            terminal={terminal === WORST ? null : terminal}
            onSelect={selectRelation}
          />
        ) : (
          <GraphLegend />
        )}
      </Panel>
    </ReactFlow>
  );
}

export const AuthModelGraph = ({ model }: AuthModelGraphProps) => (
  <div style={{ width: '100%', height: '800px', position: 'relative' }}>
    <ReactFlowProvider>
      <Flow model={model} />
    </ReactFlowProvider>
  </div>
);
