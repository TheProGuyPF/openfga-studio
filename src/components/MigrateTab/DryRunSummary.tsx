import { useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  Stack,
  Chip,
  Alert,
  Table,
  TableBody,
  TableRow,
  TableCell,
  TextField,
  Divider,
  CircularProgress,
  Collapse,
} from '@mui/material';
import ScienceIcon from '@mui/icons-material/Science';
import { parseTupleObject } from '../../utils/tupleHelper';
import { transformRow, type MigrationTemplate, type TransformResult, type Tuple } from '../../utils/migrationTransform';
import type { TupleWarning } from '../../utils/migrationModelCheck';
import type { DiffResult } from '../../services/migrationEngine';

interface DryRunSummaryProps {
  result: TransformResult | null;
  rows: Record<string, string>[];
  template: MigrationTemplate | null;
  warnings: TupleWarning[];
  modelAvailable: boolean;
  diff: DiffResult | null;
  diffLoading: boolean;
  onRunDiff: () => void;
}

const REASON_LABEL: Record<string, string> = {
  filtered: 'Excluded by row filter',
  missingRequired: 'Missing a required column',
  gatedOut: 'Rule gated out (column empty)',
  enumUnmatched: 'Enum value not mapped',
  invalidSegment: 'Invalid tuple segment',
  deduped: 'Duplicate',
};

function groupByTypeRelation(tuples: Tuple[]): { key: string; count: number }[] {
  const map = new Map<string, number>();
  for (const t of tuples) {
    const { type } = parseTupleObject(t.object);
    const key = `${type} · ${t.relation}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function TupleLine({ t }: { t: Tuple }) {
  return (
    <Box sx={{ fontFamily: 'monospace', fontSize: 12, display: 'flex', gap: 0.5, flexWrap: 'wrap', py: 0.25 }}>
      <span>{t.user}</span>
      <b>{t.relation}</b>
      <span>{t.object}</span>
    </Box>
  );
}

/** Step 3 — Dry run: diff (new vs present) + skipped-with-reasons + a per-row debugger. */
export function DryRunSummary({
  result,
  rows,
  template,
  warnings,
  modelAvailable,
  diff,
  diffLoading,
  onRunDiff,
}: DryRunSummaryProps) {
  const [debugIndex, setDebugIndex] = useState('0');

  const groups = useMemo(() => (result ? groupByTypeRelation(result.tuples) : []), [result]);

  const debugResult = useMemo(() => {
    if (!template) return null;
    const i = Number(debugIndex);
    if (!Number.isInteger(i) || i < 0 || i >= rows.length) return null;
    return { index: i, ...transformRow(rows[i], template) };
  }, [debugIndex, rows, template]);

  if (!result || !template) {
    return (
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          3. Dry run
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Load a CSV and a valid template to preview the migration.
        </Typography>
      </Paper>
    );
  }

  const { stats, skipped } = result;
  const skipCounts: Array<[string, number]> = [
    ['filtered', stats.filtered],
    ['missingRequired', stats.missingRequired],
    ['gatedOut', stats.gatedOut],
    ['enumUnmatched', stats.enumUnmatched],
    ['invalidSegment', stats.invalidSegment],
    ['deduped', stats.deduped],
  ];

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        3. Dry run
      </Typography>

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Chip color="primary" label={`${stats.produced.toLocaleString()} tuples`} />
        <Chip variant="outlined" label={`${stats.totalRows.toLocaleString()} rows`} />
        {skipCounts
          .filter(([, n]) => n > 0)
          .map(([reason, n]) => (
            <Chip key={reason} size="small" variant="outlined" label={`${REASON_LABEL[reason]}: ${n}`} />
          ))}
      </Stack>

      {/* Grouped tuple counts */}
      <Box sx={{ mb: 1 }}>
        <Typography variant="subtitle2">Produced tuples by type · relation</Typography>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
          {groups.map((g) => (
            <Chip key={g.key} size="small" label={`${g.key}: ${g.count}`} variant="outlined" />
          ))}
        </Stack>
      </Box>

      {/* Model validation */}
      {!modelAvailable ? (
        <Alert severity="info" sx={{ mb: 1 }}>
          No authorization model loaded — skipping model validation.
        </Alert>
      ) : warnings.length > 0 ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {warnings.length} tuple{warnings.length === 1 ? '' : 's'} may not match the active model:
          <Box sx={{ mt: 0.5 }}>
            {warnings.slice(0, 5).map((w, i) => (
              <Box key={i} sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                {w.tuple.user} {w.tuple.relation} {w.tuple.object} — {w.message}
              </Box>
            ))}
            {warnings.length > 5 && <div>…and {warnings.length - 5} more</div>}
          </Box>
        </Alert>
      ) : (
        <Alert severity="success" sx={{ mb: 1 }}>
          All produced tuples match the active model.
        </Alert>
      )}

      <Divider sx={{ my: 1.5 }} />

      {/* Diff: new vs already-present */}
      <Box sx={{ mb: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle2">Diff vs live store</Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={onRunDiff}
            disabled={diffLoading || stats.produced === 0}
            startIcon={diffLoading ? <CircularProgress size={14} /> : undefined}
          >
            {diffLoading ? 'Checking…' : 'Check what already exists'}
          </Button>
        </Stack>
        {diff && (
          <Box>
            <Stack direction="row" spacing={1} sx={{ mb: 0.5 }}>
              <Chip size="small" color="success" label={`${diff.newCount.toLocaleString()} new`} />
              <Chip size="small" label={`${diff.presentCount.toLocaleString()} already present`} />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Probed {diff.probedObjects} of {diff.totalObjects} objects{diff.partial ? ' (sampled — big migration)' : ''}.
            </Typography>
            {diff.newSample.length > 0 && (
              <Box sx={{ mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  New (sample):
                </Typography>
                {diff.newSample.map((t, i) => (
                  <TupleLine key={i} t={t} />
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>

      <Divider sx={{ my: 1.5 }} />

      {/* Skipped rows with reasons */}
      {skipped.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="subtitle2" gutterBottom>
            Skipped (sample of {skipped.length})
          </Typography>
          <Box sx={{ maxHeight: 180, overflow: 'auto' }}>
            <Table size="small">
              <TableBody>
                {skipped.slice(0, 50).map((s, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ width: 60 }}>row {s.index + 1}</TableCell>
                    <TableCell>{REASON_LABEL[s.reason]}</TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{s.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Box>
      )}

      <Divider sx={{ my: 1.5 }} />

      {/* Transform-one-row debugger */}
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <ScienceIcon fontSize="small" />
          <Typography variant="subtitle2">Transform one row</Typography>
          <TextField
            size="small"
            type="number"
            label="Row #"
            value={debugIndex}
            onChange={(e) => setDebugIndex(e.target.value)}
            sx={{ width: 120 }}
            helperText={`1–${rows.length}`}
            slotProps={{ htmlInput: { min: 1, max: rows.length } }}
          />
        </Stack>
        <Collapse in={Boolean(debugResult)}>
          {debugResult && (
            <Box sx={{ pl: 1 }}>
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                Outcome: <b>{debugResult.outcome}</b>
                {debugResult.detail ? ` — ${debugResult.detail}` : ''}
              </Typography>
              {debugResult.ruleOutcomes.map((ro, i) => (
                <Box key={i} sx={{ fontFamily: 'monospace', fontSize: 12, py: 0.25 }}>
                  <Chip
                    size="small"
                    label={ro.status}
                    color={ro.status === 'emitted' ? 'success' : ro.status === 'invalid' ? 'error' : 'default'}
                    sx={{ mr: 1, height: 18 }}
                  />
                  {ro.ruleId}
                  {ro.tuple ? ` → ${ro.tuple.user} ${ro.tuple.relation} ${ro.tuple.object}` : ''}
                  {ro.detail ? ` (${ro.detail})` : ''}
                </Box>
              ))}
            </Box>
          )}
        </Collapse>
        {!debugResult && rows.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            Enter a row number between 1 and {rows.length}.
          </Typography>
        )}
      </Box>
    </Paper>
  );
}
