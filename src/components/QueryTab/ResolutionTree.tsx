import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  CircularProgress,
  Alert,
  Tooltip,
  IconButton,
  TextField,
  InputAdornment,
  useTheme,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import BoltIcon from '@mui/icons-material/Bolt';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import ReactFlow, {
  Background,
  Controls,
  ReactFlowProvider,
  useReactFlow,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { OpenFGAService } from '../../services/OpenFGAService';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { ConfirmDialog } from '../common/ConfirmDialog';
import type { StructuredModel } from '../../utils/modelGraph';
import { resolveCheck, type ResolutionMode, type ResolutionNode } from '../../utils/resolutionEngine';
import {
  getCachedResolution,
  setCachedResolution,
  resolutionCacheKey,
} from '../../utils/resolutionCache';
import { ResolutionList } from './ResolutionList';
import { buildResolutionFlow, shorten, type ResolutionFlowNodeData } from './resolutionFlow';

interface ResolutionTreeProps {
  storeId: string;
  authModelId?: string;
  model: StructuredModel;
  params: { user: string; object: string; relation: string };
  context?: Record<string, string | number | boolean>;
  allowed: boolean;
}

type ViewStyle = 'diagram' | 'list';

// ---------------------------------------------------------------------------
// Custom node
// ---------------------------------------------------------------------------

function ResolutionBox({ data }: NodeProps<ResolutionFlowNodeData>) {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const allowed = data.status === 'allowed';
  const error = data.status === 'error';
  const isOperator = data.kind === 'operator';
  const handleStyle = { opacity: 0, width: 1, height: 1, border: 'none' };

  let bg: string;
  let border: string;
  let color: string;
  if (error) {
    bg = dark ? 'rgba(211,47,47,0.15)' : '#fdecea';
    border = theme.palette.error.main;
    color = theme.palette.error.main;
  } else if (allowed && data.emphasize) {
    bg = '#22c55e';
    border = '#16a34a';
    color = '#0b2e13';
  } else if (allowed) {
    bg = dark ? 'rgba(34,197,94,0.14)' : '#e8f8ee';
    border = '#22c55e';
    color = dark ? '#c7f0dd' : '#137a3f';
  } else {
    bg = theme.palette.background.paper;
    border = theme.palette.divider;
    color = theme.palette.text.secondary;
  }

  return (
    <Tooltip title={data.sub ? `${data.label} — ${data.sub}` : data.label} arrow placement="top">
      <Box
        sx={{
          px: 1.5,
          py: isOperator ? 0.5 : 1,
          borderRadius: isOperator ? '999px' : '8px',
          border: `2px solid ${data.focused ? theme.palette.warning.main : border}`,
          background: bg,
          color,
          minWidth: isOperator ? 0 : 150,
          maxWidth: 260,
          textAlign: 'center',
          boxShadow: data.focused ? `0 0 0 3px ${theme.palette.warning.main}` : theme.shadows[1],
          opacity: data.dimmed ? 0.25 : 1,
          transition: 'opacity 0.2s ease, box-shadow 0.2s ease',
        }}
      >
        <Handle type="target" position={Position.Bottom} style={handleStyle} isConnectable={false} />
        <Typography
          sx={{
            fontFamily: isOperator ? undefined : '"Roboto Mono", monospace',
            fontSize: isOperator ? 12 : 12.5,
            fontWeight: data.emphasize || isOperator ? 700 : 500,
            lineHeight: 1.25,
            wordBreak: 'break-word',
          }}
        >
          {isOperator ? data.label : shorten(data.label)}
        </Typography>
        {data.sub && !isOperator && (
          <Typography sx={{ fontSize: 10.5, opacity: 0.8, mt: 0.25 }}>{shorten(data.sub, 40)}</Typography>
        )}
        <Handle type="source" position={Position.Top} style={handleStyle} isConnectable={false} />
      </Box>
    </Tooltip>
  );
}

const NODE_TYPES = { resbox: ResolutionBox } as const;

// ---------------------------------------------------------------------------
// Flow diagram (inner component so it can use the React Flow instance)
// ---------------------------------------------------------------------------

function Diagram({
  tree,
  query,
  matchIndex,
  onMatchCount,
}: {
  tree: ResolutionNode;
  query: string;
  matchIndex: number;
  onMatchCount: (count: number) => void;
}) {
  const theme = useTheme();
  const { setCenter } = useReactFlow();

  const { nodes, edges } = useMemo(() => {
    const flow = buildResolutionFlow(tree);
    const rfNodes: Node<ResolutionFlowNodeData>[] = flow.nodes.map((n) => ({
      id: n.id,
      type: 'resbox',
      position: n.position,
      data: n.data,
    }));
    const rfEdges: Edge[] = flow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'smoothstep',
      style: { stroke: e.allowed ? '#22c55e' : theme.palette.divider, strokeWidth: 2 },
      labelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
      labelBgStyle: { fill: theme.palette.background.paper },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: e.allowed ? '#22c55e' : theme.palette.divider,
      },
    }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [tree, theme.palette.divider, theme.palette.text.secondary, theme.palette.background.paper]);

  const q = query.trim().toLowerCase();
  // Matches in flow order (root-first DFS), so prev/next steps through them predictably.
  const matches = useMemo(() => {
    if (!q) return [];
    return nodes
      .filter(
        (n) =>
          n.data.label.toLowerCase().includes(q) || (n.data.sub?.toLowerCase().includes(q) ?? false),
      )
      .map((n) => n.id);
  }, [q, nodes]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  useEffect(() => {
    onMatchCount(matches.length);
  }, [matches, onMatchCount]);

  const currentId = matches.length ? matches[matchIndex % matches.length] : null;

  // Center on the current match whenever it changes.
  useEffect(() => {
    if (!currentId) return;
    const node = nodes.find((n) => n.id === currentId);
    if (node) setCenter(node.position.x, node.position.y, { zoom: 1.1, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const displayNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          dimmed: q ? !matchSet.has(n.id) : false,
          focused: n.id === currentId,
        },
      })),
    [nodes, q, matchSet, currentId],
  );

  return (
    <ReactFlow
      nodes={displayNodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }}
      minZoom={0.2}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      style={{ background: theme.palette.background.default, borderRadius: 8 }}
    >
      <Background color={theme.palette.mode === 'dark' ? '#444' : '#e0e0e0'} gap={22} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ResolutionTree({
  storeId,
  authModelId,
  model,
  params,
  context,
  allowed,
}: ResolutionTreeProps) {
  const [mode, setMode] = useState<ResolutionMode>('acl');
  const [viewStyle, setViewStyle] = useState<ViewStyle>('diagram');
  const [search, setSearch] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [tree, setTree] = useState<ResolutionNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheAge, setCacheAge] = useState<number | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  const [skipFullConfirm, setSkipFullConfirm] = useLocalStorage(
    'openfga-studio.resolution.skipFullConfirm',
    false,
  );

  const runResolve = useCallback(
    async (resolveMode: ResolutionMode, force = false) => {
      const key = resolutionCacheKey({
        storeId,
        authModelId,
        user: params.user,
        object: params.object,
        relation: params.relation,
        mode: resolveMode,
        context,
      });

      if (!force) {
        const cached = getCachedResolution(key);
        if (cached) {
          setTree(cached.tree);
          setCacheAge(cached.ageMs);
          setError(null);
          setLoading(false);
          return;
        }
      }

      setLoading(true);
      setError(null);
      setCacheAge(null);
      try {
        const node = await resolveCheck(
          params,
          {
            model,
            check: async (items) => {
              const results = await OpenFGAService.batchCheck(
                storeId,
                items.map((item, i) => ({
                  user: item.user,
                  relation: item.relation,
                  object: item.object,
                  correlationId: `r${i}`,
                  context,
                })),
                { authorizationModelId: authModelId },
              );
              return results.map((r) => r.allowed === true);
            },
            read: async (object, relation) => {
              const { tuples } = await OpenFGAService.readFiltered(storeId, { object, relation });
              return tuples.map((t) => t.user);
            },
          },
          resolveMode,
        );
        setCachedResolution(key, node);
        setTree(node);
        setCacheAge(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to resolve path');
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeId, authModelId, model, params.user, params.object, params.relation],
  );

  useEffect(() => {
    setMode('acl');
    setSearch('');
    runResolve('acl');
  }, [runResolve]);

  const applyMode = (next: ResolutionMode) => {
    setMode(next);
    runResolve(next);
  };

  const handleMode = (next: ResolutionMode | null) => {
    if (!next || next === mode) return;
    if (next === 'full' && !skipFullConfirm) {
      setConfirmFull(true);
      return;
    }
    applyMode(next);
  };

  return (
    <Paper variant="outlined" sx={{ mt: 2, borderRadius: 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.default',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography fontSize={14} fontWeight="bold">
            Resolution path
          </Typography>
          <Chip
            size="small"
            label={allowed ? 'ALLOWED' : 'DENIED'}
            color={allowed ? 'success' : 'error'}
            sx={{ fontWeight: 700 }}
          />
          {cacheAge !== null && (
            <Tooltip title="Served from a recent result. Refresh to re-run against the store.">
              <Chip
                size="small"
                icon={<BoltIcon />}
                label={`Cached · ${Math.max(1, Math.round(cacheAge / 1000))}s ago`}
                variant="outlined"
                color="info"
              />
            </Tooltip>
          )}
          <Tooltip title="Refresh (re-run against the store)">
            <IconButton size="small" onClick={() => runResolve(mode, true)} disabled={loading}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {viewStyle === 'diagram' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <TextField
                size="small"
                placeholder="Find node"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setMatchIndex(0);
                }}
                sx={{ width: 160 }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
              {search.trim() && (
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <IconButton
                    size="small"
                    disabled={matchCount === 0}
                    onClick={() => setMatchIndex((i) => (i - 1 + matchCount) % matchCount)}
                  >
                    <KeyboardArrowLeftIcon fontSize="small" />
                  </IconButton>
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 34, textAlign: 'center' }}>
                    {matchCount === 0 ? '0/0' : `${(matchIndex % matchCount) + 1}/${matchCount}`}
                  </Typography>
                  <IconButton
                    size="small"
                    disabled={matchCount === 0}
                    onClick={() => setMatchIndex((i) => (i + 1) % matchCount)}
                  >
                    <KeyboardArrowRightIcon fontSize="small" />
                  </IconButton>
                </Box>
              )}
            </Box>
          )}
          <ToggleButtonGroup
            value={viewStyle}
            exclusive
            size="small"
            onChange={(_, next: ViewStyle | null) => next && setViewStyle(next)}
          >
            <ToggleButton value="diagram" sx={{ textTransform: 'none', fontSize: 12 }}>
              Diagram
            </ToggleButton>
            <ToggleButton value="list" sx={{ textTransform: 'none', fontSize: 12 }}>
              List
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup value={mode} exclusive size="small" onChange={(_, next) => handleMode(next)}>
            <ToggleButton value="acl" sx={{ textTransform: 'none', fontSize: 12 }}>
              ACL path
            </ToggleButton>
            <ToggleButton value="full" sx={{ textTransform: 'none', fontSize: 12 }}>
              Full tree
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      <Box sx={{ p: 2, minHeight: 120 }}>
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}>
            <CircularProgress size={16} />
            <Typography variant="body2">Resolving path…</Typography>
          </Box>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {!loading && !error && tree && (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {mode === 'acl'
                ? 'Minimal path that determined the result — read bottom-up from the user. Switch to Full tree for every branch.'
                : 'Every branch evaluated against the model.'}
            </Typography>
            {viewStyle === 'diagram' ? (
              <div style={{ width: '100%', height: 460 }}>
                <ReactFlowProvider>
                  <Diagram
                    tree={tree}
                    query={search}
                    matchIndex={matchIndex}
                    onMatchCount={setMatchCount}
                  />
                </ReactFlowProvider>
              </div>
            ) : (
              <ResolutionList tree={tree} query={search} />
            )}
          </>
        )}
      </Box>

      <ConfirmDialog
        open={confirmFull}
        title="Compute the full resolution tree?"
        confirmLabel="Compute full tree"
        confirmColor="warning"
        checkboxLabel="Don't ask again"
        onCancel={() => setConfirmFull(false)}
        onConfirm={(dontAsk) => {
          if (dontAsk) setSkipFullConfirm(true);
          setConfirmFull(false);
          applyMode('full');
        }}
        message={
          <Box component="span" sx={{ display: 'block' }}>
            The full tree evaluates every branch of the model, which can issue many additional checks and
            reads against the store — slower on large models. The ACL path already shows what determined the
            result.
          </Box>
        }
      />
    </Paper>
  );
}
