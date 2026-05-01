import { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Menu,
  MenuItem,
  Chip,
  InputAdornment,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  CircularProgress,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import type {
  EffectiveResult,
  DirectResult,
  CrossModeActions,
  LookupMode,
} from './types';
import { LOAD_ALL_CAP } from './types';

interface LookupResultsProps {
  mode: LookupMode;
  effective: EffectiveResult | null;
  direct: DirectResult | null;
  loading: boolean;
  loadingMore: boolean;
  loadingAll: boolean;
  crossMode: CrossModeActions;
  onLoadMore: () => void;
  onLoadAll: () => void;
  onCopy: (text: string) => void;
}

interface RowAction {
  label: string;
  onClick: () => void;
}

interface RowMenuButtonProps {
  actions: RowAction[];
}

function RowMenuButton({ actions }: RowMenuButtonProps) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  return (
    <>
      <IconButton
        size="small"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-label="Row actions"
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {actions.map((a) => (
          <MenuItem
            key={a.label}
            onClick={() => {
              a.onClick();
              setAnchor(null);
            }}
          >
            {a.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export function LookupResults({
  mode,
  effective,
  direct,
  loading,
  loadingMore,
  loadingAll,
  crossMode,
  onLoadMore,
  onLoadAll,
  onCopy,
}: LookupResultsProps) {
  const [filter, setFilter] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const filteredObjects = useMemo(() => {
    if (mode !== 'effective' || !effective) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return effective.objects;
    return effective.objects.filter((o) => o.toLowerCase().includes(q));
  }, [mode, effective, filter]);

  const filteredTuples = useMemo(() => {
    if (mode !== 'direct' || !direct) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return direct.tuples;
    return direct.tuples.filter((t) => {
      const conditionStr = t.condition
        ? `${t.condition.name} ${Object.entries(t.condition.context)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ')}`
        : '';
      return (
        t.user.toLowerCase().includes(q) ||
        t.relation.toLowerCase().includes(q) ||
        t.object.toLowerCase().includes(q) ||
        conditionStr.toLowerCase().includes(q)
      );
    });
  }, [mode, direct, filter]);

  const hasResults = mode === 'effective' ? !!effective : !!direct;

  if (loading) {
    return (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <CircularProgress size={24} />
      </Paper>
    );
  }

  if (!hasResults) {
    return (
      <Paper
        variant="outlined"
        sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}
      >
        <Typography variant="body2">
          Run a query above to see results.
        </Typography>
      </Paper>
    );
  }

  if (mode === 'effective' && effective) {
    const totalCount = effective.objects.length;
    const filteredCount = filteredObjects.length;
    return (
      <Paper variant="outlined" sx={{ borderRadius: 1 }}>
        <Box
          sx={{
            p: 2,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
            <Typography variant="subtitle2">
              {totalCount} object{totalCount === 1 ? '' : 's'}{' '}
              <code>{effective.query.user}</code> can{' '}
              <code>{effective.query.relation}</code>
            </Typography>
            <Chip
              size="small"
              label="computed via the model"
              color="info"
              variant="outlined"
            />
          </Box>
          <TextField
            size="small"
            fullWidth
            placeholder="Filter by object id..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
          {filter && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              Showing {filteredCount} of {totalCount}
            </Typography>
          )}
        </Box>

        {totalCount === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              No effective access found.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              There may still be direct tuples — try Direct tuples mode.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {filteredObjects.map((object) => (
              <Box
                key={object}
                sx={{
                  px: 2,
                  py: 1.5,
                  borderBottom: 1,
                  borderColor: 'divider',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  '&:last-of-type': { borderBottom: 0 },
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Typography
                  sx={{ fontFamily: '"Roboto Mono", monospace', fontSize: '0.9rem' }}
                >
                  {object}
                </Typography>
                <RowMenuButton
                  actions={[
                    { label: 'Copy id', onClick: () => onCopy(object) },
                    {
                      label: 'Check this exact tuple',
                      onClick: () =>
                        crossMode.checkTuple(
                          effective.query.user,
                          effective.query.relation,
                          object
                        ),
                    },
                    {
                      label: 'Show direct tuples for this object',
                      onClick: () => crossMode.showDirectTuplesForObject(object),
                    },
                  ]}
                />
              </Box>
            ))}
          </Box>
        )}
      </Paper>
    );
  }

  if (mode === 'direct' && direct) {
    const totalLoaded = direct.totalLoaded;
    const filteredCount = filteredTuples.length;
    const hasMore = !!direct.continuationToken;
    return (
      <Paper variant="outlined" sx={{ borderRadius: 1 }}>
        <Box
          sx={{
            p: 2,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2">
              {totalLoaded} tuple{totalLoaded === 1 ? '' : 's'} loaded
              {hasMore ? ' (more available)' : ''}
            </Typography>
            <Chip
              size="small"
              label="directly stored — not computed"
              color="info"
              variant="outlined"
            />
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <TextField
              size="small"
              fullWidth
              placeholder="Filter by user / relation / object / condition..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Button
              variant="outlined"
              size="small"
              onClick={onLoadMore}
              disabled={!hasMore || loadingMore || loadingAll}
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </Button>
            <Button
              variant="outlined"
              size="small"
              onClick={() => setConfirmOpen(true)}
              disabled={!hasMore || loadingMore || loadingAll}
            >
              {loadingAll ? 'Loading all...' : 'Load all'}
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            {filter
              ? `Showing ${filteredCount} of ${totalLoaded} loaded${hasMore ? ' · more pages remain' : ''}`
              : hasMore
              ? 'More pages available — Load more or Load all to expand the filter'
              : 'All pages loaded'}
          </Typography>
        </Box>

        {totalLoaded === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              No direct tuples match these filters.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Effective access via roles or hierarchies may still grant access — try Effective access mode.
            </Typography>
          </Box>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>User</TableCell>
                  <TableCell>Relation</TableCell>
                  <TableCell>Object</TableCell>
                  <TableCell>Condition</TableCell>
                  <TableCell width={60} align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredTuples.map((t, i) => (
                  <TableRow key={`${t.user}-${t.relation}-${t.object}-${i}`}>
                    <TableCell sx={{ fontFamily: '"Roboto Mono", monospace', fontSize: '0.85rem' }}>
                      {t.user}
                    </TableCell>
                    <TableCell sx={{ fontFamily: '"Roboto Mono", monospace', fontSize: '0.85rem' }}>
                      {t.relation}
                    </TableCell>
                    <TableCell sx={{ fontFamily: '"Roboto Mono", monospace', fontSize: '0.85rem' }}>
                      {t.object}
                    </TableCell>
                    <TableCell>
                      {t.condition ? (
                        <Box>
                          <Typography variant="caption" color="text.secondary">
                            {t.condition.name}
                          </Typography>
                          <Typography variant="body2">
                            {Object.entries(t.condition.context)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(', ')}
                          </Typography>
                        </Box>
                      ) : null}
                    </TableCell>
                    <TableCell align="right">
                      <RowMenuButton
                        actions={[
                          {
                            label: 'Copy as JSON',
                            onClick: () =>
                              onCopy(
                                JSON.stringify(
                                  {
                                    user: t.user,
                                    relation: t.relation,
                                    object: t.object,
                                    ...(t.condition ? { condition: t.condition } : {}),
                                  },
                                  null,
                                  2
                                )
                              ),
                          },
                          {
                            label: 'Check this exact tuple',
                            onClick: () =>
                              crossMode.checkTuple(t.user, t.relation, t.object),
                          },
                          {
                            label: 'Show effective access for this user',
                            onClick: () =>
                              crossMode.showEffectiveAccessForUser(t.user),
                          },
                          {
                            label: 'Show direct tuples for this object',
                            onClick: () =>
                              crossMode.showDirectTuplesForObject(t.object),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
          <DialogTitle>Load all matching tuples?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              This will fetch all remaining pages until either the server returns no
              more results or {LOAD_ALL_CAP.toLocaleString()} tuples have been
              loaded. On large stores this may take a while and use significant
              memory.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              variant="contained"
              onClick={() => {
                setConfirmOpen(false);
                onLoadAll();
              }}
            >
              Load all
            </Button>
          </DialogActions>
        </Dialog>
      </Paper>
    );
  }

  return null;
}
