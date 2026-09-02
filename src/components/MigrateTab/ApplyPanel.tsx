import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  Stack,
  Alert,
  Chip,
  LinearProgress,
  FormControlLabel,
  Checkbox,
  Switch,
  IconButton,
  Tooltip,
} from '@mui/material';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import LockIcon from '@mui/icons-material/Lock';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import ReplayIcon from '@mui/icons-material/Replay';
import DownloadIcon from '@mui/icons-material/Download';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { useToast } from '../../contexts/ToastContext';
import { ENV_TIER_STYLE, isGuarded } from '../../environments';
import { OpenFGAService } from '../../services/OpenFGAService';
import { applyTuples, type ApplyResult } from '../../services/migrationEngine';
import type { MigrationTemplate, Tuple } from '../../utils/migrationTransform';
import type { RunRecord, RunStatus } from '../../services/migrationStore';
import { saveRun } from '../../services/migrationStore';
import { downloadJson } from './download';

interface ApplyPanelProps {
  storeId: string;
  storeName: string;
  authModelId: string;
  template: MigrationTemplate | null;
  tuples: Tuple[];
  warningsCount: number;
  csvName: string;
  csvHash: string;
  onRunSaved: () => void;
}

const SCALE_WARN_THRESHOLD = 100_000;

/** Step 4 — Apply: read-only → unlock → Kafka-bypass ack → (guarded) type-the-store-name → run. */
export function ApplyPanel({
  storeId,
  storeName,
  authModelId,
  template,
  tuples,
  warningsCount,
  csvName,
  csvHash,
  onRunSaved,
}: ApplyPanelProps) {
  const { environment } = useEnvironment();
  const { toast } = useToast();
  const guarded = isGuarded(environment);
  const tierStyle = ENV_TIER_STYLE[environment.tier];

  const [locked, setLocked] = useState(true);
  const [acked, setAcked] = useState(false);
  const [blockOnInvalid, setBlockOnInvalid] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ApplyResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Re-lock + reset when the store changes (env switch remounts the workspace).
  useEffect(() => {
    setLocked(true);
    setAcked(false);
    setResult(null);
  }, [storeId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const invalidBlocking = blockOnInvalid && warningsCount > 0;
  const canApply = !locked && acked && tuples.length > 0 && !running && !invalidBlocking;

  const run = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setResult(null);
    setProgress({ done: 0, total: tuples.length });
    const controller = new AbortController();
    abortRef.current = controller;

    const res = await applyTuples(tuples, {
      write: (batch) => OpenFGAService.writeTuples(storeId, batch, authModelId, batch.length).then(() => undefined),
      batchSize: 40,
      concurrency: 5,
      signal: controller.signal,
      onProgress: setProgress,
    });

    setResult(res);
    setRunning(false);

    const status: RunStatus = res.failed.length === 0 ? 'applied' : res.written > 0 ? 'partial' : 'failed';
    const record: RunRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      envKey: environment.key,
      storeId,
      storeName,
      ts: Date.now(),
      modelId: authModelId,
      templateName: template?.name ?? 'unnamed',
      csvName,
      csvHash,
      counts: { produced: tuples.length, written: res.written, failed: res.failed.length },
      status,
      config: template as MigrationTemplate,
      tuples: tuples.filter((t) => !res.failed.includes(t)),
      failures: res.failed,
    };
    const persisted = await saveRun(record);
    onRunSaved();

    if (res.aborted) {
      toast(`Aborted after ${res.written} tuples`, 'warning');
    } else if (res.failed.length > 0) {
      toast(`Applied ${res.written}, ${res.failed.length} failed`, 'warning');
    } else {
      toast(`Applied ${res.written} tuples`, 'success');
    }
    if (!persisted) {
      toast('Run history unavailable (IndexedDB off) — download the applied tuples to keep a rollback set', 'info');
    }
  };

  const retry = async () => {
    if (!result || result.failed.length === 0) return;
    setRunning(true);
    const failedBefore = result.failed;
    setProgress({ done: 0, total: failedBefore.length });
    const controller = new AbortController();
    abortRef.current = controller;
    const res = await applyTuples(failedBefore, {
      write: (batch) => OpenFGAService.writeTuples(storeId, batch, authModelId, batch.length).then(() => undefined),
      signal: controller.signal,
      onProgress: setProgress,
    });
    setRunning(false);
    setResult((prev) =>
      prev ? { ...prev, written: prev.written + res.written, failed: res.failed, failures: res.failures } : res,
    );
    toast(res.failed.length === 0 ? `Retried — all ${res.written} succeeded` : `Retried, ${res.failed.length} still failing`, res.failed.length === 0 ? 'success' : 'warning');
    onRunSaved();
  };

  const startApply = () => {
    if (guarded) setConfirmOpen(true);
    else setConfirmOpen(true); // always confirm; typed-text only added for guarded tiers
  };

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        4. Apply
        {tierStyle && <Chip size="small" label={tierStyle.chipLabel} color={tierStyle.color} sx={{ ml: 1, height: 18 }} />}
      </Typography>

      {tuples.length >= SCALE_WARN_THRESHOLD && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {tuples.length.toLocaleString()} tuples is large for an in-browser apply. Consider "Export as script" for very
          large migrations.
        </Alert>
      )}

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        {locked ? (
          <Button variant="contained" startIcon={<LockOpenIcon />} onClick={() => setLocked(false)} disabled={tuples.length === 0}>
            Unlock to apply
          </Button>
        ) : (
          <>
            <Button
              variant="contained"
              color={tierStyle?.color === 'error' ? 'error' : guarded ? 'warning' : 'primary'}
              startIcon={<PlayArrowIcon />}
              onClick={startApply}
              disabled={!canApply}
            >
              Apply {tuples.length.toLocaleString()} tuples
            </Button>
            <Tooltip title="Re-lock">
              <IconButton size="small" onClick={() => setLocked(true)}>
                <LockIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
        {running && (
          <Button color="error" variant="outlined" startIcon={<StopIcon />} onClick={() => abortRef.current?.abort()}>
            Abort
          </Button>
        )}
      </Stack>

      {!locked && (
        <Box sx={{ mb: 1 }}>
          <FormControlLabel
            control={<Checkbox checked={acked} onChange={(e) => setAcked(e.target.checked)} />}
            label="I understand these writes go directly to OpenFGA, bypassing Kafka — no audit events or notifications are produced."
          />
          <FormControlLabel
            control={<Switch checked={blockOnInvalid} onChange={(e) => setBlockOnInvalid(e.target.checked)} />}
            label="Block apply when tuples fail model validation"
          />
          {invalidBlocking && (
            <Alert severity="warning" sx={{ mt: 0.5 }}>
              {warningsCount} tuple(s) fail model validation. Fix the mapping or turn off the block toggle to proceed.
            </Alert>
          )}
        </Box>
      )}

      {running && (
        <Box sx={{ mb: 1 }}>
          <LinearProgress variant="determinate" value={progress.total ? (progress.done / progress.total) * 100 : 0} />
          <Typography variant="caption" color="text.secondary">
            {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
          </Typography>
        </Box>
      )}

      {result && (
        <Box>
          <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
            <Chip color="success" label={`${result.written.toLocaleString()} written`} />
            {result.failed.length > 0 && <Chip color="error" label={`${result.failed.length.toLocaleString()} failed`} />}
            {result.aborted && <Chip color="warning" label="aborted" />}
          </Stack>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {result.failed.length > 0 && (
              <Button size="small" variant="outlined" startIcon={<ReplayIcon />} onClick={retry} disabled={running}>
                Retry failed ({result.failed.length})
              </Button>
            )}
            <Button
              size="small"
              variant="text"
              startIcon={<DownloadIcon />}
              onClick={() => downloadJson('applied-tuples.json', tuples.filter((t) => !result.failed.includes(t)))}
            >
              Applied tuples
            </Button>
            {result.failures.length > 0 && (
              <Button
                size="small"
                variant="text"
                startIcon={<DownloadIcon />}
                onClick={() => downloadJson('migration-failures.json', result.failures)}
              >
                Failures
              </Button>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Saved to run history below — rollback and retry survive a page reload.
          </Typography>
        </Box>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Apply migration?"
        confirmLabel={`Write to ${storeName || storeId}`}
        confirmColor={tierStyle?.color === 'error' ? 'error' : guarded ? 'warning' : 'primary'}
        requireTypedText={guarded ? storeName || storeId : undefined}
        onConfirm={run}
        onCancel={() => setConfirmOpen(false)}
        message={
          <Box component="span" sx={{ display: 'block' }}>
            This writes <strong>{tuples.length.toLocaleString()}</strong> tuples to:
            <Box component="ul" sx={{ mt: 1, mb: 1 }}>
              <li>
                <strong>Store:</strong> {storeName || storeId}
              </li>
              <li>
                <strong>Environment:</strong> {environment.label}
                {tierStyle && <Chip size="small" label={tierStyle.chipLabel} color={tierStyle.color} sx={{ ml: 1, height: 18 }} />}
              </li>
            </Box>
            Writes bypass Kafka — no audit events or notifications are produced.
            {guarded && (
              <Box component="span" sx={{ color: 'warning.main', display: 'block', mt: 1 }}>
                You are writing to a {environment.tier.toUpperCase()} store.
              </Box>
            )}
          </Box>
        }
      />
    </Paper>
  );
}
