import { Box, Typography, Chip, useTheme } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import type { NodeStatus, ResolutionNode } from '../../utils/resolutionEngine';

function StatusIcon({ status }: { status: NodeStatus }) {
  if (status === 'allowed') return <CheckCircleIcon fontSize="small" color="success" />;
  if (status === 'error') return <ErrorOutlineIcon fontSize="small" color="error" />;
  return <RemoveCircleOutlineIcon fontSize="small" sx={{ color: 'text.disabled' }} />;
}

function matches(node: ResolutionNode, query: string): boolean {
  if (!query) return false;
  const q = query.toLowerCase();
  return node.label.toLowerCase().includes(q) || (node.detail?.toLowerCase().includes(q) ?? false);
}

function TreeNodeView({
  node,
  depth,
  query,
}: {
  node: ResolutionNode;
  depth: number;
  query: string;
}) {
  const theme = useTheme();
  const isOperator = node.kind === 'operator';
  const hit = matches(node, query);
  return (
    <Box sx={{ ml: depth === 0 ? 0 : 2 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          py: 0.5,
          pl: 1,
          borderLeft: depth === 0 ? 'none' : `2px solid ${theme.palette.divider}`,
          borderRadius: hit ? 1 : 0,
          bgcolor: hit ? 'warning.main' : 'transparent',
          ...(hit && { color: theme.palette.getContrastText(theme.palette.warning.main) }),
          opacity: query && !hit ? 0.5 : node.status === 'allowed' ? 1 : 0.85,
        }}
      >
        <StatusIcon status={node.status} />
        {isOperator ? (
          <Chip
            size="small"
            label={node.label}
            color={node.status === 'allowed' ? 'success' : 'default'}
            variant={node.contributed ? 'filled' : 'outlined'}
            sx={{ height: 20, fontWeight: 700 }}
          />
        ) : (
          <Typography
            component="span"
            sx={{
              fontFamily: '"Roboto Mono", monospace',
              fontSize: 13,
              fontWeight: node.contributed ? 700 : 400,
              color: hit ? 'inherit' : node.status === 'allowed' ? 'success.main' : 'text.primary',
            }}
          >
            {node.label}
          </Typography>
        )}
        {node.detail && (
          <Typography component="span" variant="caption" sx={{ color: hit ? 'inherit' : 'text.secondary' }}>
            {node.detail}
          </Typography>
        )}
        {node.expandable && (
          <MoreHorizIcon fontSize="small" sx={{ color: 'text.disabled' }} titleAccess="More (switch to Full tree)" />
        )}
      </Box>
      {node.children.map((child) => (
        <TreeNodeView key={child.id} node={child} depth={depth + 1} query={query} />
      ))}
    </Box>
  );
}

export function ResolutionList({ tree, query }: { tree: ResolutionNode; query: string }) {
  return (
    <Box sx={{ maxHeight: 460, overflow: 'auto' }}>
      <TreeNodeView node={tree} depth={0} query={query} />
    </Box>
  );
}
