import { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  IconButton,
  Tooltip,
  Stack,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import DownloadIcon from '@mui/icons-material/Download';
import {
  exportHistoryJson,
  exportHistoryCsv,
  type HistoryEntry,
  type HistoryOp,
  type HistoryOutcome,
} from '../../services/historyStore';
import { formatMs } from '../../utils/latencyStats';

interface HistoryPanelProps {
  entries: HistoryEntry[];
  /** Restrict to these ops (e.g. ['check'] or ['list-objects','read']). */
  ops?: HistoryOp[];
  title?: string;
  onReplay: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

type OutcomeFilter = 'all' | HistoryOutcome;

const OUTCOME_COLOR: Record<HistoryOutcome, 'success' | 'default' | 'error'> = {
  allowed: 'success',
  denied: 'default',
  error: 'error',
};

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function HistoryPanel({ entries, ops, title = 'History', onReplay, onDelete, onClear }: HistoryPanelProps) {
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');

  const scoped = useMemo(
    () => (ops ? entries.filter((e) => ops.includes(e.op)) : entries),
    [entries, ops],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped.filter((e) => {
      if (outcome !== 'all' && e.outcome !== outcome) return false;
      if (!q) return true;
      return (
        e.label.toLowerCase().includes(q) ||
        [e.user, e.relation, e.object, e.objectType].some((v) => v?.toLowerCase().includes(q))
      );
    });
  }, [scoped, search, outcome]);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="subtitle1" sx={{ flex: 1 }}>
          {title}
          <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
            ({scoped.length})
          </Typography>
        </Typography>
        <Tooltip title="Export JSON">
          <span>
            <IconButton size="small" onClick={() => exportHistoryJson(scoped)} disabled={scoped.length === 0}>
              <DownloadIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Export CSV">
          <span>
            <IconButton size="small" onClick={() => exportHistoryCsv(scoped)} disabled={scoped.length === 0}>
              <Typography variant="caption" sx={{ fontWeight: 600 }}>CSV</Typography>
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Clear history">
          <span>
            <IconButton size="small" onClick={onClear} disabled={scoped.length === 0}>
              <DeleteSweepIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {scoped.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1.5 }}>
          <TextField
            size="small"
            placeholder="Search history…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ flex: 1 }}
          />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={outcome}
            onChange={(_e, v: OutcomeFilter | null) => v && setOutcome(v)}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="allowed">Allowed</ToggleButton>
            <ToggleButton value="denied">Denied</ToggleButton>
            <ToggleButton value="error">Error</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      )}

      {scoped.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No history yet — run a {ops?.includes('check') ? 'check' : 'query'} to see it here.
        </Typography>
      ) : filtered.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No entries match your filter.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ maxHeight: 360, overflow: 'auto' }}>
          {filtered.map((e) => (
            <Paper
              key={e.id}
              variant="outlined"
              onClick={() => onReplay(e)}
              sx={{
                p: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Chip size="small" label={e.op} variant="outlined" />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap title={e.label}>
                  {e.label}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {timeAgo(e.ts)}
                  {e.latencyMs != null && ` · ${formatMs(e.latencyMs)}`}
                  {e.op === 'list-objects' && e.objectCount != null && ` · ${e.objectCount} objects`}
                </Typography>
              </Box>
              <Chip
                size="small"
                color={OUTCOME_COLOR[e.outcome]}
                variant={e.outcome === 'denied' ? 'outlined' : 'filled'}
                label={e.op === 'check' ? e.outcome : e.outcome === 'error' ? 'error' : 'ok'}
              />
              <Tooltip title="Remove">
                <IconButton
                  size="small"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onDelete(e.id);
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Paper>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
