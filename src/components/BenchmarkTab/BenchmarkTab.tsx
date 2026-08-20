// Benchmark tab — deliberate latency/load harness. GATED to non-prod + canary;
// prod renders a disabled notice and refuses to run. In-flight runs use an
// AbortController aborted on unmount (and the workspace remounts on env switch,
// so a run can never bleed across environments).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  FormControlLabel,
  Checkbox,
  Slider,
  Alert,
  Divider,
  Stack,
  Chip,
  LinearProgress,
  CircularProgress,
  IconButton,
  Tooltip,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteIcon from '@mui/icons-material/Delete';
import StorageIcon from '@mui/icons-material/Storage';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { isGuarded } from '../../environments';
import { OpenFGAService, type Consistency } from '../../services/OpenFGAService';
import { DEPTH_LADDER } from './presets';
import {
  BENCHMARK_STORE_NAME,
  SCALE_PRESETS,
  estimateTupleCount,
  type ScaleName,
} from './seedData';
import {
  seedBenchmarkStore,
  teardownBenchmarkStore,
  type SeedStep,
} from './seedRunner';
import type {
  BenchScenario,
  BenchmarkConfig,
  BenchmarkRun,
  BatchDiagnostic,
  CacheMode,
  LoadMode,
} from './types';
import {
  runBenchmark,
  runBatchDiagnostic,
  effectiveConsistency,
  AbortedError,
  MAX_CONCURRENCY,
  type RunProgress,
} from './benchmarkEngine';
import { BenchmarkResults } from './BenchmarkResults';
import {
  loadRuns,
  saveRun,
  clearRuns,
  exportRunJson,
  exportRunCsv,
  runTitle,
} from './benchmarkStore';

interface BenchmarkTabProps {
  storeId: string;
  currentModel?: string;
  authModelId: string;
}

interface SavedQueryLike {
  query?: { user?: string; relation?: string; object?: string };
}

const DEFAULT_CONFIG: BenchmarkConfig = {
  iterations: 30,
  warmup: 3,
  cacheMode: 'cold',
  consistency: 'MINIMIZE_LATENCY',
  loadMode: 'sequential',
  concurrency: 6,
  timeoutMs: 10000,
};

export default function BenchmarkTab({ storeId, authModelId }: BenchmarkTabProps) {
  const { currentEnvKey, environment } = useEnvironment();
  const isProd = environment.tier === 'prod';

  const [config, setConfig] = useState<BenchmarkConfig>(DEFAULT_CONFIG);
  const [selectedPresetIds, setSelectedPresetIds] = useState<Set<string>>(
    () => new Set(DEPTH_LADDER.map((s) => s.id)),
  );
  const [adhoc, setAdhoc] = useState<BenchScenario[]>([]);
  const [adhocDraft, setAdhocDraft] = useState({ user: '', relation: '', object: '' });
  const [runDiagnostic, setRunDiagnostic] = useState(true);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<BenchmarkRun | null>(null);
  const [diagnostic, setDiagnostic] = useState<BatchDiagnostic | null>(null);
  const [history, setHistory] = useState<BenchmarkRun[]>([]);

  // Seeding state.
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([]);
  const [sourceStoreId, setSourceStoreId] = useState('');
  const [scale, setScale] = useState<ScaleName>('medium');
  const [seeding, setSeeding] = useState(false);
  const [seedStep, setSeedStep] = useState<SeedStep | null>(null);
  const [seedMessage, setSeedMessage] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'seed' | 'teardown' | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setHistory(loadRuns(storeId));
  }, [storeId]);

  // Load stores for the seed source picker (skip in prod — the tab is disabled there).
  useEffect(() => {
    if (environment.tier === 'prod') return;
    let cancelled = false;
    OpenFGAService.listStores()
      .then((list) => {
        if (cancelled) return;
        setStores(list);
        // Default the source to the app-selected store, else the first non-benchmark store.
        setSourceStoreId((prev) => {
          if (prev) return prev;
          if (storeId && list.some((s) => s.id === storeId)) return storeId;
          const firstReal = list.find((s) => s.name !== BENCHMARK_STORE_NAME);
          return firstReal?.id ?? '';
        });
      })
      .catch(() => {
        /* listing errors surface elsewhere; leave the picker empty */
      });
    return () => {
      cancelled = true;
    };
  }, [environment.tier, storeId]);

  const seedStepLabel: Record<SeedStep, string> = {
    'finding-store': 'Finding benchmark store…',
    'creating-store': 'Creating benchmark store…',
    'copying-model': 'Copying authorization model…',
    'writing-tuples': 'Writing seed tuples…',
    done: 'Done',
  };

  const doSeed = useCallback(async () => {
    if (environment.tier === 'prod') return; // defense-in-depth
    setSeeding(true);
    setSeedError(null);
    setSeedMessage(null);
    try {
      const result = await seedBenchmarkStore(sourceStoreId, SCALE_PRESETS[scale].params, setSeedStep);
      setSeedMessage(
        `Seeded "${BENCHMARK_STORE_NAME}" (${result.storeId}) with model ${result.modelId} and ${result.written} tuples ` +
          `(${scale} dataset). Select "${BENCHMARK_STORE_NAME}" in the store picker to benchmark against it.`,
      );
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : 'Seeding failed.');
    } finally {
      setSeeding(false);
      setSeedStep(null);
    }
  }, [environment.tier, sourceStoreId, scale]);

  const doTeardown = useCallback(async () => {
    if (environment.tier === 'prod') return;
    setSeeding(true);
    setSeedError(null);
    setSeedMessage(null);
    try {
      const result = await teardownBenchmarkStore();
      setSeedMessage(
        result.found
          ? `Deleted the "${BENCHMARK_STORE_NAME}" store (${result.storeId}) and all its seeded data.`
          : `No "${BENCHMARK_STORE_NAME}" store found in this environment.`,
      );
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : 'Teardown failed.');
    } finally {
      setSeeding(false);
      setSeedStep(null);
    }
  }, [environment.tier]);

  const runConfirmedAction = useCallback(() => {
    const action = confirmAction;
    setConfirmAction(null);
    if (action === 'seed') void doSeed();
    else if (action === 'teardown') void doTeardown();
  }, [confirmAction, doSeed, doTeardown]);

  // Abort any in-flight run when the tab unmounts (also fires on env switch, since
  // the whole workspace remounts on a new env key).
  useEffect(() => () => abortRef.current?.abort(), []);

  const replayScenarios = useMemo<BenchScenario[]>(() => {
    if (!storeId) return [];
    try {
      const raw = localStorage.getItem(`queries-${storeId}`);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as SavedQueryLike[];
      return parsed
        .filter((q) => q.query?.user && q.query?.relation && q.query?.object)
        .slice(0, 10)
        .map((q, i) => ({
          id: `replay-${i}`,
          label: `replay: ${q.query!.object}`,
          depth: 99,
          user: q.query!.user!,
          relation: q.query!.relation!,
          object: q.query!.object!,
          note: 'From saved query history.',
        }));
    } catch {
      return [];
    }
  }, [storeId]);

  const [selectedReplayIds, setSelectedReplayIds] = useState<Set<string>>(new Set());

  const scenarios = useMemo<BenchScenario[]>(() => {
    const presets = DEPTH_LADDER.filter((s) => selectedPresetIds.has(s.id));
    const replays = replayScenarios.filter((s) => selectedReplayIds.has(s.id));
    return [...presets, ...adhoc, ...replays];
  }, [selectedPresetIds, adhoc, replayScenarios, selectedReplayIds]);

  const togglePreset = (id: string) =>
    setSelectedPresetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleReplay = (id: string) =>
    setSelectedReplayIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addAdhoc = () => {
    const { user, relation, object } = adhocDraft;
    if (!user || !relation || !object) return;
    setAdhoc((prev) => [
      ...prev,
      { id: `adhoc-${prev.length}`, label: `${object} · ${relation}`, depth: 50, user, relation, object },
    ]);
    setAdhocDraft({ user: '', relation: '', object: '' });
  };

  const handleRun = useCallback(async () => {
    // Re-check the gate at click time (defense-in-depth beyond hiding the button).
    if (environment.tier === 'prod') {
      setError('Benchmarks are disabled in production.');
      return;
    }
    if (!storeId) {
      setError('Select a store first.');
      return;
    }
    if (scenarios.length === 0) {
      setError('Select at least one scenario.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setCurrentRun(null);
    setDiagnostic(null);
    setProgress({ scenarioId: '', done: 0, total: scenarios.length });

    try {
      const partial = await runBenchmark(
        storeId,
        authModelId,
        scenarios,
        config,
        currentEnvKey,
        controller.signal,
        setProgress,
      );
      const run: BenchmarkRun = { ...partial, ts: Date.now() };
      setCurrentRun(run);
      setHistory(saveRun(storeId, run));

      if (runDiagnostic) {
        const diag = await runBatchDiagnostic(
          storeId,
          authModelId,
          scenarios,
          config,
          controller.signal,
        );
        setDiagnostic(diag);
      }
    } catch (err) {
      if (err instanceof AbortedError || controller.signal.aborted) {
        setError('Run aborted.');
      } else {
        setError(err instanceof Error ? err.message : 'Benchmark failed.');
      }
    } finally {
      setRunning(false);
      setProgress(null);
      abortRef.current = null;
    }
  }, [environment.tier, storeId, scenarios, authModelId, config, currentEnvKey, runDiagnostic]);

  const handleStop = () => abortRef.current?.abort();

  if (isProd) {
    return (
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Alert severity="error" sx={{ maxWidth: 640 }}>
          <Typography variant="subtitle1" gutterBottom>
            Benchmarks are disabled in production
          </Typography>
          Active benchmarking generates synthetic load and seeds data, so it is
          restricted to non-prod and canary environments. Switch to NPE or Canary
          to run benchmarks. (Passive latency monitoring still works here — see the
          latency chip, bottom-right.)
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2, height: '100%', overflow: 'auto' }}>
      <Typography variant="h6" gutterBottom>
        Benchmark
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }} component="div">
        Runs a model depth-ladder of checks against{' '}
        <Chip size="small" label={environment.label} sx={{ mx: 0.5 }} component="span" />
        to separate deployment latency from model cost. Seed the benchmark store below
        (or with <code>scripts/seed-benchmark-store.mjs</code> for CI), then select it in
        the store picker.
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <StorageIcon fontSize="small" />
          <Typography variant="subtitle2">Benchmark store setup</Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Creates (or reuses) an isolated <code>{BENCHMARK_STORE_NAME}</code> store in{' '}
          {environment.label}, copies the selected store's model into it, and writes seed tuples.
          Larger datasets add cardinality (roles with many assignees, a team with many members,
          many sibling objects) for more real-world-representative resolution. To switch sizes,
          Teardown first, then re-seed.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
          <FormControl size="small" sx={{ minWidth: 260 }} disabled={seeding}>
            <InputLabel id="seed-source-label">Copy model from store</InputLabel>
            <Select
              labelId="seed-source-label"
              label="Copy model from store"
              value={sourceStoreId}
              onChange={(e) => setSourceStoreId(e.target.value)}
            >
              {stores
                .filter((s) => s.name !== BENCHMARK_STORE_NAME)
                .map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name} ({s.id.slice(0, 8)}…)
                  </MenuItem>
                ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 200 }} disabled={seeding}>
            <InputLabel id="seed-scale-label">Dataset size</InputLabel>
            <Select
              labelId="seed-scale-label"
              label="Dataset size"
              value={scale}
              onChange={(e) => setScale(e.target.value as ScaleName)}
            >
              {(Object.keys(SCALE_PRESETS) as ScaleName[]).map((name) => (
                <MenuItem key={name} value={name}>
                  {SCALE_PRESETS[name].label} (~{estimateTupleCount(SCALE_PRESETS[name].params)} tuples)
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            variant="contained"
            onClick={() => setConfirmAction('seed')}
            disabled={seeding || !sourceStoreId}
            startIcon={seeding ? <CircularProgress size={16} /> : <StorageIcon />}
          >
            {seeding ? 'Working…' : 'Seed benchmark store'}
          </Button>
          <Button color="warning" onClick={() => setConfirmAction('teardown')} disabled={seeding}>
            Teardown
          </Button>
        </Stack>
        {seeding && seedStep && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {seedStepLabel[seedStep]}
          </Typography>
        )}
        {seedMessage && <Alert severity="success" sx={{ mt: 1.5 }}>{seedMessage}</Alert>}
        {seedError && <Alert severity="error" sx={{ mt: 1.5 }}>{seedError}</Alert>}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Scenarios (depth ladder)
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
          {DEPTH_LADDER.map((s) => (
            <Tooltip key={s.id} title={s.note || ''}>
              <Chip
                label={`${s.label}`}
                color={selectedPresetIds.has(s.id) ? 'primary' : 'default'}
                variant={selectedPresetIds.has(s.id) ? 'filled' : 'outlined'}
                onClick={() => togglePreset(s.id)}
              />
            </Tooltip>
          ))}
        </Stack>

        <Divider sx={{ my: 1.5 }} />
        <Typography variant="caption" color="text.secondary">
          Ad-hoc scenario
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 0.5, mb: 1 }}>
          <TextField size="small" label="user" placeholder="user:alice"
            value={adhocDraft.user} onChange={(e) => setAdhocDraft((d) => ({ ...d, user: e.target.value }))} />
          <TextField size="small" label="relation" placeholder="can_read"
            value={adhocDraft.relation} onChange={(e) => setAdhocDraft((d) => ({ ...d, relation: e.target.value }))} />
          <TextField size="small" label="object" placeholder="document:x"
            value={adhocDraft.object} onChange={(e) => setAdhocDraft((d) => ({ ...d, object: e.target.value }))} />
          <Button onClick={addAdhoc} variant="outlined" size="small">Add</Button>
        </Stack>
        {adhoc.length > 0 && (
          <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
            {adhoc.map((s) => (
              <Chip key={s.id} label={s.label} onDelete={() => setAdhoc((prev) => prev.filter((x) => x.id !== s.id))} />
            ))}
          </Stack>
        )}

        {replayScenarios.length > 0 && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="caption" color="text.secondary">
              Replay from saved queries
            </Typography>
            <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.5 }}>
              {replayScenarios.map((s) => (
                <Chip key={s.id} label={s.label}
                  color={selectedReplayIds.has(s.id) ? 'primary' : 'default'}
                  variant={selectedReplayIds.has(s.id) ? 'filled' : 'outlined'}
                  onClick={() => toggleReplay(s.id)} />
              ))}
            </Stack>
          </>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>Configuration</Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ mb: 2 }}>
          <Box sx={{ minWidth: 160 }}>
            <Typography variant="caption">Cache mode</Typography>
            <ToggleButtonGroup exclusive size="small" fullWidth value={config.cacheMode}
              onChange={(_e, v: CacheMode | null) => v && setConfig((c) => ({ ...c, cacheMode: v }))}>
              <ToggleButton value="cold">Cold</ToggleButton>
              <ToggleButton value="warm">Warm</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Box sx={{ minWidth: 220 }}>
            <Typography variant="caption">
              Consistency {config.cacheMode === 'cold' && '(forced by cold mode)'}
            </Typography>
            <ToggleButtonGroup exclusive size="small" fullWidth
              value={effectiveConsistency(config)}
              disabled={config.cacheMode === 'cold'}
              onChange={(_e, v: Consistency | null) => v && setConfig((c) => ({ ...c, consistency: v }))}>
              <ToggleButton value="MINIMIZE_LATENCY">Min latency</ToggleButton>
              <ToggleButton value="HIGHER_CONSISTENCY">Higher</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Box sx={{ minWidth: 200 }}>
            <Typography variant="caption">Load mode</Typography>
            <ToggleButtonGroup exclusive size="small" fullWidth value={config.loadMode}
              onChange={(_e, v: LoadMode | null) => v && setConfig((c) => ({ ...c, loadMode: v }))}>
              <ToggleButton value="sequential">Sequential</ToggleButton>
              <ToggleButton value="parallel">Parallel</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="flex-start">
          <TextField size="small" type="number" label="Iterations" sx={{ width: 120 }}
            value={config.iterations}
            onChange={(e) => setConfig((c) => ({ ...c, iterations: Math.max(1, Number(e.target.value) || 1) }))} />
          <TextField size="small" type="number" label="Warmup (discarded)" sx={{ width: 160 }}
            value={config.warmup}
            onChange={(e) => setConfig((c) => ({ ...c, warmup: Math.max(0, Number(e.target.value) || 0) }))} />
          <TextField size="small" type="number" label="Timeout (ms)" sx={{ width: 140 }}
            value={config.timeoutMs}
            onChange={(e) => setConfig((c) => ({ ...c, timeoutMs: Math.max(100, Number(e.target.value) || 100) }))} />
          {config.loadMode === 'parallel' && (
            <Box sx={{ width: 220 }}>
              <Typography variant="caption">Concurrency: {config.concurrency} (max {MAX_CONCURRENCY})</Typography>
              <Slider size="small" min={1} max={MAX_CONCURRENCY} value={config.concurrency}
                onChange={(_e, v) => setConfig((c) => ({ ...c, concurrency: v as number }))} />
            </Box>
          )}
        </Stack>

        <FormControlLabel sx={{ mt: 1 }}
          control={<Checkbox checked={runDiagnostic} onChange={(e) => setRunDiagnostic(e.target.checked)} />}
          label="Also run batch-check vs N-singles diagnostic" />

        {config.loadMode === 'parallel' && (
          <Alert severity="info" sx={{ mt: 1 }}>
            A browser is not a true load generator (≤6 connections/host over HTTP/1.1).
            Use parallel mode for a light load signal, not a real stress test — and
            only against the shared non-prod/canary env.
          </Alert>
        )}
      </Paper>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        {!running ? (
          <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={handleRun}
            disabled={!storeId || scenarios.length === 0}>
            Run benchmark ({scenarios.length} scenario{scenarios.length === 1 ? '' : 's'})
          </Button>
        ) : (
          <Button variant="outlined" color="error" startIcon={<StopIcon />} onClick={handleStop}>
            Stop
          </Button>
        )}
      </Stack>

      {running && progress && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption">
            Running… {progress.done}/{progress.total} scenarios
          </Typography>
          <LinearProgress variant="determinate"
            value={progress.total ? (progress.done / progress.total) * 100 : 0} />
        </Box>
      )}

      {error && <Alert severity={error === 'Run aborted.' ? 'warning' : 'error'} sx={{ mb: 2 }}>{error}</Alert>}

      {currentRun && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1">Latest run</Typography>
            <Box>
              <Tooltip title="Export JSON">
                <IconButton size="small" onClick={() => exportRunJson(currentRun)}><DownloadIcon fontSize="small" /></IconButton>
              </Tooltip>
              <Button size="small" onClick={() => exportRunCsv(currentRun)}>CSV</Button>
            </Box>
          </Stack>
          <BenchmarkResults run={currentRun} diagnostic={diagnostic} />
        </Paper>
      )}

      {history.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="subtitle2">Run history (this store)</Typography>
            <Tooltip title="Clear history">
              <IconButton size="small" onClick={() => { clearRuns(storeId); setHistory([]); }}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          <List dense>
            {history.map((run) => (
              <ListItem key={run.ts} disablePadding
                secondaryAction={
                  <IconButton edge="end" size="small" onClick={() => exportRunJson(run)}>
                    <DownloadIcon fontSize="small" />
                  </IconButton>
                }>
                <ListItemButton onClick={() => { setCurrentRun(run); setDiagnostic(null); }}>
                  <ListItemText primary={runTitle(run)}
                    secondary={`${run.results.length} scenarios · floor ${Math.round(run.floorMs)}ms`} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      <Dialog open={confirmAction !== null} onClose={() => setConfirmAction(null)}>
        <DialogTitle>
          {confirmAction === 'teardown' ? 'Delete benchmark store?' : 'Seed benchmark store?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmAction === 'teardown' ? (
              <>Delete the entire <b>{BENCHMARK_STORE_NAME}</b> store in{' '}
                <b>{environment.label}</b>, including all seeded data and its model.</>
            ) : (
              <>This will create/reuse the <b>{BENCHMARK_STORE_NAME}</b> store in{' '}
                <b>{environment.label}</b>, write an authorization model, and write{' '}
                <b>~{estimateTupleCount(SCALE_PRESETS[scale].params)}</b> tuples ({scale} dataset).</>
            )}
            {isGuarded(environment) && (
              <>
                {' '}
                <b>{environment.label} is a guarded environment</b> — this writes data there
                (to an isolated benchmark store, not your real data).
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmAction(null)}>Cancel</Button>
          <Button
            variant="contained"
            color={confirmAction === 'teardown' ? 'warning' : 'primary'}
            onClick={runConfirmedAction}
          >
            {confirmAction === 'teardown' ? 'Delete store' : 'Seed'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
