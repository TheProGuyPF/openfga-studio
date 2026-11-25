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
import { applyTuples, findExistingTuples, rollbackTuples, tupleKey } from '../../services/migrationEngine';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { isGuarded } from '../../environments';
import { readAllOnObject } from './readAllOnObject';
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
  storeName: string;
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
export function RunHistory({ runs, storeId, storeName, authModelId, onChanged }: RunHistoryProps) {
  const { toast } = useToast();
  const { environment } = useEnvironment();
  const guarded = isGuarded(environment);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: 'rollback' | 'retry'; run: RunRecord } | null>(null);

  const rollback = async (run: RunRecord) => {
    if (run.storeId !== storeId) {
      toast('This run was applied to a different store — refusing to roll it back here', 'error');
      return;
    }
    setBusyId(run.id);
    try {
      const res = await rollbackTuples(run.tuples, {
        del: (batch) => OpenFGAService.deleteTuplesStrict(storeId, batch, authModelId),
      });
      const clean = res.failed.length === 0 && res.pending.length === 0;
      await saveRun({
        ...run,
        // Keep only what is still in the store so a re-run targets just those.
        tuples: clean ? run.tuples : [...res.failed, ...res.pending],
        status: clean ? 'rolledback' : run.status,
      });
      toast(
        clean
          ? `Rolled back ${res.deleted} tuples`
          : `Rolled back ${res.deleted}; ${res.failed.length + res.pending.length} tuple(s) still present — run Rollback again`,
        clean ? 'success' : 'warning',
      );
    } finally {
      setBusyId(null);
      onChanged();
    }
  };

  const retry = async (run: RunRecord) => {
    if (run.failures.length === 0) return;
    if (run.storeId !== storeId) {
      toast('This run was applied to a different store — refusing to retry it here', 'error');
      return;
    }
    setBusyId(run.id);
    try {
      // A failed batch may have contained tuples that already existed; keep those
      // out of the rollback set (same rule as the initial apply).
      const existing = await findExistingTuples(run.failures, {
        read: (object) => readAllOnObject(storeId, object),
      });
      const toWrite = run.failures.filter((t) => !existing.has(tupleKey(t)));
      const res = await applyTuples(toWrite, {
        write: (batch) => OpenFGAService.writeTuples(storeId, batch, authModelId, batch.length).then(() => undefined),
      });
      const failed = [...res.failed, ...res.pending];
      const written = run.counts.written + res.written;
      const status: RunStatus = failed.length === 0 ? 'applied' : written > 0 ? 'partial' : 'failed';
      await saveRun({
        ...run,
        tuples: [...run.tuples, ...res.applied],
        failures: failed,
        counts: {
          ...run.counts,
          written,
          failed: failed.length,
          alreadyPresent: (run.counts.alreadyPresent ?? 0) + existing.size,
        },
        status,
      });
      toast(
        failed.length === 0 ? `Retried — all ${res.written} succeeded` : `Retried, ${failed.length} still failing`,
        failed.length === 0 ? 'success' : 'warning',
      );
    } catch (err) {
      toast(`Retry not attempted — could not check existing tuples (${err instanceof Error ? err.message : String(err)})`, 'error');
    } finally {
      setBusyId(null);
      onChanged();
    }
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
    <>
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
                onClick={() => setPendingAction({ kind: 'rollback', run })}
                disabled={busyId !== null || run.tuples.length === 0 || run.status === 'rolledback'}
              >
                Rollback
              </Button>
              {run.failures.length > 0 && (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ReplayIcon />}
                  onClick={() => setPendingAction({ kind: 'retry', run })}
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
    <ConfirmDialog
      open={pendingAction !== null}
      title={pendingAction?.kind === 'rollback' ? 'Roll back this run?' : 'Retry failed tuples?'}
      confirmLabel={pendingAction?.kind === 'rollback' ? 'Delete tuples' : 'Write tuples'}
      confirmColor={pendingAction?.kind === 'rollback' || guarded ? 'warning' : 'primary'}
      requireTypedText={guarded ? storeName || storeId : undefined}
      onCancel={() => setPendingAction(null)}
      onConfirm={() => {
        const action = pendingAction;
        setPendingAction(null);
        if (!action) return;
        if (action.kind === 'rollback') void rollback(action.run);
        else void retry(action.run);
      }}
      message={
        pendingAction ? (
          <Box component="span" sx={{ display: 'block' }}>
            {pendingAction.kind === 'rollback' ? (
              <>
                This <strong>deletes {pendingAction.run.tuples.length.toLocaleString()}</strong> tuples
              </>
            ) : (
              <>
                This writes <strong>{pendingAction.run.failures.length.toLocaleString()}</strong> tuples
              </>
            )}{' '}
            {pendingAction.kind === 'rollback' ? 'from' : 'to'} <strong>{storeName || storeId}</strong> ({environment.label}),
            directly against OpenFGA (no Kafka/audit events). Run: {pendingAction.run.templateName},{' '}
            {new Date(pendingAction.run.ts).toLocaleString()}.
          </Box>
        ) : null
      }
    />
    </>
  );
}
