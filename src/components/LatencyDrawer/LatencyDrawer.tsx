// Passive latency monitor — a collapsible panel, fixed bottom-right, that spans
// all tabs. Subscribes to the latency bus and shows a rolling distribution of the
// real check/lookup/read calls the user makes. Runs in ALL environments (it only
// observes calls already being made; it adds no load and reads nothing extra).
import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Paper,
  IconButton,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Chip,
} from '@mui/material';
import SpeedIcon from '@mui/icons-material/Speed';
import CloseIcon from '@mui/icons-material/Close';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import {
  subscribeLatency,
  getRecentSamples,
  type LatencySample,
  type LatencyOp,
} from '../../services/latencyBus';
import { computeStats, formatMs } from '../../utils/latencyStats';
import { LatencySparkline } from './LatencySparkline';

const OP_ORDER: LatencyOp[] = ['check', 'batch-check', 'list-objects', 'read', 'write', 'other'];
const OP_LABEL: Record<LatencyOp, string> = {
  check: 'check',
  'batch-check': 'batch-check',
  'list-objects': 'list-objects',
  read: 'read',
  write: 'write',
  other: 'other',
};

// Only these ops are interesting for latency monitoring; hide bookkeeping calls
// (store/model listing) which land under 'other'.
const MONITORED_OPS: LatencyOp[] = ['check', 'batch-check', 'list-objects', 'read'];

export function LatencyDrawer() {
  const [samples, setSamples] = useState<LatencySample[]>(() => getRecentSamples());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSamples(getRecentSamples());
    const unsub = subscribeLatency((s) => {
      setSamples((prev) => {
        const next = [...prev, s];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    });
    return unsub;
  }, []);

  const monitored = useMemo(
    () => samples.filter((s) => MONITORED_OPS.includes(s.op)),
    [samples],
  );

  const latest = monitored.length ? monitored[monitored.length - 1] : undefined;

  const perOp = useMemo(() => {
    return OP_ORDER.filter((op) => MONITORED_OPS.includes(op))
      .map((op) => {
        const rows = monitored.filter((s) => s.op === op);
        const durations = rows.filter((r) => r.status === 'ok').map((r) => r.elapsedMs);
        const errors = rows.filter((r) => r.status !== 'ok').length;
        return { op, stats: computeStats(durations), errors, total: rows.length };
      })
      .filter((r) => r.total > 0);
  }, [monitored]);

  const sparkData = useMemo(
    () =>
      monitored.slice(-40).map((s, i) => ({ i, ms: s.elapsedMs, status: s.status })),
    [monitored],
  );

  if (!open) {
    return (
      <Box sx={{ position: 'fixed', bottom: 16, left: 16, zIndex: (t) => t.zIndex.speedDial }}>
        <Tooltip title="Latency monitor">
          <Chip
            icon={<SpeedIcon />}
            color={latest && latest.status !== 'ok' ? 'error' : 'default'}
            label={latest ? formatMs(latest.elapsedMs) : 'Latency'}
            onClick={() => setOpen(true)}
            sx={{ boxShadow: 3, cursor: 'pointer' }}
          />
        </Tooltip>
      </Box>
    );
  }

  return (
    <Paper
      elevation={6}
      sx={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        width: 360,
        maxWidth: 'calc(100vw - 32px)',
        zIndex: (t) => t.zIndex.speedDial,
        p: 1.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <SpeedIcon fontSize="small" sx={{ mr: 0.5 }} />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          Latency monitor
        </Typography>
        <Tooltip title="Clear samples">
          <IconButton size="small" onClick={() => setSamples([])}>
            <DeleteSweepIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <IconButton size="small" onClick={() => setOpen(false)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {monitored.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          No calls yet. Run a check or lookup to see latency.
        </Typography>
      ) : (
        <>
          <Box sx={{ mb: 1 }}>
            <LatencySparkline data={sparkData} />
          </Box>
          <Table size="small" padding="none">
            <TableHead>
              <TableRow>
                <TableCell>op</TableCell>
                <TableCell align="right">n</TableCell>
                <TableCell align="right">p50</TableCell>
                <TableCell align="right">p95</TableCell>
                <TableCell align="right">max</TableCell>
                <TableCell align="right">err</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {perOp.map((r) => (
                <TableRow key={r.op}>
                  <TableCell>{OP_LABEL[r.op]}</TableCell>
                  <TableCell align="right">{r.stats.count}</TableCell>
                  <TableCell align="right">{formatMs(r.stats.p50)}</TableCell>
                  <TableCell align="right">{formatMs(r.stats.p95)}</TableCell>
                  <TableCell align="right">{formatMs(r.stats.max)}</TableCell>
                  <TableCell align="right">{r.errors}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </Paper>
  );
}
