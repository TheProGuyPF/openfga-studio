import { useMemo, useState } from 'react';
import { Box, Typography, useTheme, IconButton, Collapse } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import {
  formatWeight,
  weightColor,
  type ModelWeights,
  type Weight,
} from '../../utils/modelWeights';

interface HeaviestRelationsProps {
  weights: ModelWeights;
  /** Terminal type to rank by, or null for worst-case. */
  terminal: string | null;
  onSelect: (relationId: string) => void;
}

function rank(weight: Weight | undefined): number {
  if (weight === 'infinite') return Number.POSITIVE_INFINITY;
  if (weight === undefined) return -1;
  return weight;
}

export function HeaviestRelations({ weights, terminal, onSelect }: HeaviestRelationsProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(true);

  const rows = useMemo(() => {
    return weights.relations
      .map((r) => ({
        id: r.id,
        weight: terminal ? r.perType.get(terminal) : r.worstCase,
      }))
      .filter((r) => r.weight !== undefined && r.weight !== 0)
      .sort((a, b) => rank(b.weight) - rank(a.weight))
      .slice(0, 10);
  }, [weights, terminal]);

  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1.5,
        boxShadow: 1,
        width: 280,
        maxWidth: '40vw',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 0.75,
        }}
      >
        <Typography variant="caption" fontWeight={700} color="text.secondary">
          Heaviest relations{terminal ? ` → ${terminal}` : ''}
        </Typography>
        <IconButton size="small" onClick={() => setOpen((o) => !o)}>
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Box>
      <Collapse in={open}>
        <Box sx={{ maxHeight: 220, overflow: 'auto', pb: 0.5 }}>
          {rows.length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, pb: 1, display: 'block' }}>
              No weighted relations for this selection.
            </Typography>
          )}
          {rows.map((r) => (
            <Box
              key={r.id}
              onClick={() => onSelect(r.id)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                px: 1.5,
                py: 0.5,
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Typography
                sx={{ fontFamily: '"Roboto Mono", monospace', fontSize: 12 }}
                noWrap
                title={r.id}
              >
                {r.id}
              </Typography>
              <Box
                sx={{
                  minWidth: 26,
                  textAlign: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#fff',
                  bgcolor: weightColor(r.weight),
                  borderRadius: '6px',
                  px: 0.75,
                }}
              >
                {formatWeight(r.weight)}
              </Box>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
