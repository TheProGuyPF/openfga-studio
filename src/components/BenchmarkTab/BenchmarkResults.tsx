// Benchmark results: a depth-ordered latency table + a Recharts comparison chart.
// Rendering the depth ladder in order makes the model-cost gradient visible
// (shallow → deep). p50-minus-floor isolates the model-compute component.
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Chip,
  useTheme,
} from '@mui/material';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { BenchmarkRun, BatchDiagnostic } from './types';
import { formatMs } from '../../utils/latencyStats';

export function BenchmarkResults({
  run,
  diagnostic,
}: {
  run: BenchmarkRun;
  diagnostic?: BatchDiagnostic | null;
}) {
  const theme = useTheme();

  const chartData = run.results.map((r) => ({
    name: r.scenario.label,
    p50: Math.round(r.stats.p50),
    p95: Math.round(r.stats.p95),
    model: Math.round(r.p50MinusFloor),
  }));

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1">Results</Typography>
        <Chip size="small" label={`env: ${run.envKey}`} />
        <Chip size="small" label={`mode: ${run.config.cacheMode}`} />
        <Chip size="small" label={`consistency: ${run.config.cacheMode === 'cold' ? 'HIGHER_CONSISTENCY' : run.config.consistency}`} />
        <Chip size="small" label={`${run.config.loadMode}${run.config.loadMode === 'parallel' ? ` ×${run.config.concurrency}` : ''}`} />
        <Chip size="small" color="info" label={`floor: ${formatMs(run.floorMs)}`} />
      </Box>

      <Paper variant="outlined" sx={{ p: 1, mb: 2 }}>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-15} textAnchor="end" height={70} />
            <YAxis tick={{ fontSize: 11 }} label={{ value: 'ms', angle: -90, position: 'insideLeft', fontSize: 11 }} />
            <Tooltip
              formatter={(v: number) => `${v} ms`}
              contentStyle={{
                background: theme.palette.background.paper,
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: 4,
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="p50" name="p50" fill={theme.palette.primary.main} />
            <Bar dataKey="p95" name="p95" fill={theme.palette.warning.main} />
            <Bar dataKey="model" name="p50 − floor (model)" fill={theme.palette.success.main} />
          </BarChart>
        </ResponsiveContainer>
      </Paper>

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>scenario</TableCell>
            <TableCell align="right">n</TableCell>
            <TableCell align="right">p50</TableCell>
            <TableCell align="right">p95</TableCell>
            <TableCell align="right">p99</TableCell>
            <TableCell align="right">max</TableCell>
            <TableCell align="right">p50−floor</TableCell>
            <TableCell align="right">err</TableCell>
            <TableCell align="right">timeout</TableCell>
            <TableCell align="right">allow/deny · objs</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {run.results.map((r) => (
            <TableRow key={r.scenario.id}>
              <TableCell>
                {r.scenario.label}
                {r.scenario.op !== 'list-objects' &&
                  !r.scenario.expectDenied &&
                  r.allowedCount === 0 &&
                  r.deniedCount > 0 && (
                    <Chip size="small" color="warning" label="not allowed — check seed" sx={{ ml: 1 }} />
                  )}
              </TableCell>
              <TableCell align="right">{r.stats.count}</TableCell>
              <TableCell align="right">{formatMs(r.stats.p50)}</TableCell>
              <TableCell align="right">{formatMs(r.stats.p95)}</TableCell>
              <TableCell align="right">{formatMs(r.stats.p99)}</TableCell>
              <TableCell align="right">{formatMs(r.stats.max)}</TableCell>
              <TableCell align="right">{formatMs(r.p50MinusFloor)}</TableCell>
              <TableCell align="right">{r.errors}</TableCell>
              <TableCell align="right">{r.timeouts}</TableCell>
              <TableCell align="right">
                {r.scenario.op === 'list-objects'
                  ? `~${Math.round(r.avgObjects ?? 0)} objs`
                  : `${r.allowedCount}/${r.deniedCount}`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {diagnostic && (
        <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Batch-check vs {diagnostic.n} single checks
          </Typography>
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell>1 batch-check of {diagnostic.n}</TableCell>
                <TableCell align="right">{formatMs(diagnostic.batchTotalMs)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>{diagnostic.n} sequential single checks</TableCell>
                <TableCell align="right">{formatMs(diagnostic.sequentialTotalMs)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>{diagnostic.n} parallel single checks</TableCell>
                <TableCell align="right">{formatMs(diagnostic.parallelTotalMs)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>per single check (p50 / p95)</TableCell>
                <TableCell align="right">
                  {formatMs(diagnostic.singleStats.p50)} / {formatMs(diagnostic.singleStats.p95)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {diagnostic.errors > 0 && (
            <Typography variant="caption" color="error">
              {diagnostic.errors} error(s) during the diagnostic.
            </Typography>
          )}
        </Paper>
      )}
    </Box>
  );
}
