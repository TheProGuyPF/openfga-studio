import { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Stack,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  IconButton,
  Tooltip,
  LinearProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { SectionAccordion } from './SectionAccordion';
import UndoIcon from '@mui/icons-material/Undo';
import ReplayIcon from '@mui/icons-material/Replay';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteIcon from '@mui/icons-material/Delete';
import { useToast } from '../../contexts/ToastContext';
import { OpenFGAService } from '../../services/OpenFGAService';
import { applyTuples, rollbackTuples } from '../../services/migrationEngine';
import {
  deleteRun,
  saveRun,
  type RunRecord,
  type RunStatus,
} from '../../services/migrationStore';
import { downloadJson } from './download';

interface RunHistoryProps {
  runs: RunRecord[];
  storeId: string;
  authModelId: string;
  onChanged: () => void;
}

const STATUS_COLOR: Record<RunStatus, 'success' | 'warning' | 'error' | 'default'> = {
  applied: 'success',
  partial: 'warning',
  failed: 'error',
  rolledback: 'default',
};

/** Past runs (from IndexedDB) with durable rollback + retry-failed + downloads. */
export function RunHistory({ runs, storeId, authModelId, onChanged }: RunHistoryProps) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const rollback = async (run: RunRecord) => {
    setBusyId(run.id);
    const res = await rollbackTuples(run.tuples, {
      del: (batch) => OpenFGAService.deleteTuples(storeId, batch, authModelId, batch.length).then(() => undefined),
    });
    await saveRun({ ...run, status: 'rolledback' });
    setBusyId(null);
    toast(`Rolled back ${res.deleted} tuples${res.failures.length ? `, ${res.failures.length} batch(es) failed` : ''}`, res.failures.length ? 'warning' : 'success');
    onChanged();
  };

  const retry = async (run: RunRecord) => {
    if (run.failures.length === 0) return;
    setBusyId(run.id);
    const res = await applyTuples(run.failures, {
      write: (batch) => OpenFGAService.writeTuples(storeId, batch, authModelId, batch.length).then(() => undefined),
    });
    const succeeded = run.failures.filter((t) => !res.failed.includes(t));
    const failed = res.failed;
    const written = run.counts.written + res.written;
    const status: RunStatus = failed.length === 0 ? 'applied' : written > 0 ? 'partial' : 'failed';
    await saveRun({
      ...run,
      tuples: [...run.tuples, ...succeeded],
      failures: failed,
      counts: { ...run.counts, written, failed: failed.length },
      status,
    });
    setBusyId(null);
    toast(failed.length === 0 ? `Retried — all ${res.written} succeeded` : `Retried, ${failed.length} still failing`, failed.length === 0 ? 'success' : 'warning');
    onChanged();
  };

  const remove = async (run: RunRecord) => {
    await deleteRun(run.id);
    toast('Run deleted from history', 'info');
    onChanged();
  };

  if (runs.length === 0) {
    return (
      <SectionAccordion title="Run history" defaultExpanded={false}>
        <Typography variant="body2" color="text.secondary">
          No past runs for this store. Applied runs are recorded here (durable across reloads) so you can roll them back
          or retry failures.
        </Typography>
      </SectionAccordion>
    );
  }

  return (
    <SectionAccordion
      title="Run history"
      defaultExpanded={false}
      summary={<Chip size="small" variant="outlined" label={`${runs.length} run${runs.length === 1 ? '' : 's'}`} />}
    >
      {runs.map((run) => (
        <Accordion key={run.id} disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', flexWrap: 'wrap' }}>
              <Chip size="small" label={run.status} color={STATUS_COLOR[run.status]} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {run.templateName}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {new Date(run.ts).toLocaleString()} · {run.counts.written}/{run.counts.produced} written
                {run.counts.failed > 0 ? ` · ${run.counts.failed} failed` : ''}
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            {busyId === run.id && <LinearProgress sx={{ mb: 1 }} />}
            <Box sx={{ fontFamily: 'monospace', fontSize: 12, mb: 1 }}>
              <div>CSV: {run.csvName || '(pasted)'} · hash {run.csvHash}</div>
              <div>Model: {run.modelId || '(latest)'}</div>
              <div>Tuples retained for rollback: {run.tuples.length}</div>
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                size="small"
                variant="outlined"
                color="warning"
                startIcon={<UndoIcon />}
                onClick={() => rollback(run)}
                disabled={busyId !== null || run.tuples.length === 0 || run.status === 'rolledback'}
              >
                Rollback
              </Button>
              {run.failures.length > 0 && (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ReplayIcon />}
                  onClick={() => retry(run)}
                  disabled={busyId !== null}
                >
                  Retry failed ({run.failures.length})
                </Button>
              )}
              <Button
                size="small"
                variant="text"
                startIcon={<DownloadIcon />}
                onClick={() =>
                  downloadJson(`manifest-${run.id}.json`, {
                    id: run.id,
                    envKey: run.envKey,
                    storeId: run.storeId,
                    storeName: run.storeName,
                    ts: run.ts,
                    modelId: run.modelId,
                    templateName: run.templateName,
                    csvName: run.csvName,
                    csvHash: run.csvHash,
                    counts: run.counts,
                    status: run.status,
                  })
                }
              >
                Manifest
              </Button>
              {run.failures.length > 0 && (
                <Button
                  size="small"
                  variant="text"
                  startIcon={<DownloadIcon />}
                  onClick={() => downloadJson(`failures-${run.id}.json`, run.failures)}
                >
                  Failures
                </Button>
              )}
              <Tooltip title="Delete from history">
                <IconButton size="small" onClick={() => remove(run)} disabled={busyId !== null}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </AccordionDetails>
        </Accordion>
      ))}
    </SectionAccordion>
  );
}
