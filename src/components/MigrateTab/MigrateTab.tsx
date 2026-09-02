// Migrate tab — ingest a raw source CSV + a declarative MigrationTemplate,
// transform to structural tuples in-browser, validate against the active model,
// dry-run (diff + skipped reasons + row debugger), then apply behind the app's
// tier guards with durable rollback/retry. Replaces the per-business-area backfill
// scripts for moderate migrations. See src/utils/migrationTransform.ts for the
// engine and the approved plan for the full design.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Stack, Typography, Button, Chip } from '@mui/material';
import CodeIcon from '@mui/icons-material/Code';
import StorageIcon from '@mui/icons-material/Storage';
import { EmptyState } from '../common/EmptyState';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { useToast } from '../../contexts/ToastContext';
import { useRegisterDirty } from '../../contexts/DirtyStateContext';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { OpenFGAService } from '../../services/OpenFGAService';
import { dryRunDiff, type DiffResult } from '../../services/migrationEngine';
import { listRuns, type RunRecord } from '../../services/migrationStore';
import {
  parseCsv,
  transformRows,
  type MigrationTemplate,
  type TransformResult,
} from '../../utils/migrationTransform';
import { validateTemplate } from '../../utils/migrationSchema';
import { validateAgainstModel } from '../../utils/migrationModelCheck';
import { extractRelationshipMetadata } from '../../utils/tupleHelper';
import { exportAsScript, slugify } from '../../utils/exportScript';
import { SourcePicker } from './SourcePicker';
import { MappingEditor } from './MappingEditor';
import { buildAiPrompt } from './aiPrompt';
import { DryRunSummary } from './DryRunSummary';
import { ApplyPanel } from './ApplyPanel';
import { RunHistory } from './RunHistory';
import { downloadText } from './download';
import type { SavedTemplate } from './types';

interface MigrateTabProps {
  storeId: string;
  storeName: string;
  currentModel: string;
  authModelId: string;
}

const DEFAULT_CONFIG = `{
  "name": "Example — task migration",
  "description": "task_id/institution_id → parent_institution; typed + assignee fan-out.",
  "rowFilters": [],
  "requiredColumns": ["task_id", "institution_id"],
  "dedupe": true,
  "validationMode": "drop-tuple",
  "rules": [
    {
      "id": "inst-task",
      "whenColumnsPresent": [],
      "user": { "type": "institution", "column": "institution_id" },
      "relation": { "constant": "parent_institution" },
      "object": { "type": "task", "column": "task_id" }
    },
    {
      "id": "assignee",
      "whenColumnsPresent": ["assigned_to_id", "assigned_to_type"],
      "user": {
        "column": "assigned_to_id",
        "enum": {
          "column": "assigned_to_type",
          "caseInsensitive": true,
          "map": { "USER": { "type": "user" }, "TEAM": { "type": "team", "usersetRelation": "member" } }
        }
      },
      "relation": { "constant": "task_assignee" },
      "object": { "type": "task", "column": "task_id" }
    }
  ]
}`;

/** Cheap, stable content hash (djb2) for the run manifest. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export default function MigrateTab({ storeId, storeName, currentModel, authModelId }: MigrateTabProps) {
  const { environment } = useEnvironment();
  const { toast } = useToast();

  const [csvText, setCsvText] = useState('');
  const [csvName, setCsvName] = useState('');
  const [configText, setConfigText] = useState(DEFAULT_CONFIG);
  const [savedTemplates, setSavedTemplates] = useLocalStorage<SavedTemplate[]>(
    'openfga-studio.migrate.templates',
    [],
  );
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);

  useRegisterDirty('migrate', Boolean(csvText.trim()));

  const parsed = useMemo(() => {
    if (!csvText.trim()) return { headers: [], rows: [] };
    try {
      return parseCsv(csvText);
    } catch {
      return { headers: [], rows: [] };
    }
  }, [csvText]);

  const { template, errors } = useMemo((): { template: MigrationTemplate | null; errors: string[] } => {
    try {
      const obj = JSON.parse(configText);
      const errs = validateTemplate(obj);
      return { template: errs.length ? null : (obj as MigrationTemplate), errors: errs };
    } catch (e) {
      return { template: null, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }, [configText]);

  const transformResult: TransformResult | null = useMemo(
    () => (template ? transformRows(parsed.rows, template) : null),
    [template, parsed.rows],
  );

  const warnings = useMemo(
    () => (transformResult ? validateAgainstModel(transformResult.tuples, currentModel) : []),
    [transformResult, currentModel],
  );

  // Type/relation names from the active model — seed the Builder's autocompletes.
  const modelMeta = useMemo((): { types: string[]; relations: string[] } => {
    if (!currentModel || !currentModel.trim()) return { types: [], relations: [] };
    try {
      const meta = extractRelationshipMetadata(currentModel);
      const types = Array.from(meta.types.keys()).sort();
      const relations = Array.from(
        new Set(Array.from(meta.types.values()).flatMap((t) => t.relations)),
      ).sort();
      return { types, relations };
    } catch {
      return { types: [], relations: [] };
    }
  }, [currentModel]);

  // Reset the diff whenever the produced tuple set could have changed.
  useEffect(() => {
    setDiff(null);
  }, [transformResult]);

  const csvHash = useMemo(() => hashString(csvText), [csvText]);

  const loadRuns = useCallback(async () => {
    const list = await listRuns(environment.key, storeId);
    setRuns(list);
  }, [environment.key, storeId]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const handleCsvChange = (text: string, name?: string) => {
    setCsvText(text);
    if (name !== undefined) setCsvName(name);
  };

  const runDiff = async () => {
    if (!transformResult) return;
    setDiffLoading(true);
    try {
      const d = await dryRunDiff(transformResult.tuples, {
        read: (object) => OpenFGAService.readFiltered(storeId, { object, page_size: 100 }).then((r) => r.tuples),
      });
      setDiff(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to diff against the store', 'error');
    } finally {
      setDiffLoading(false);
    }
  };

  const copyAiPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildAiPrompt(parsed.headers, parsed.rows));
      toast('AI prompt copied to clipboard', 'success');
    } catch {
      toast('Clipboard unavailable — select and copy the editor content manually', 'warning');
    }
  };

  const saveTemplate = () => {
    if (!template) return;
    setSavedTemplates((prev) => {
      const without = prev.filter((t) => t.name !== template.name);
      return [...without, { name: template.name, config: template }];
    });
    toast(`Saved template "${template.name}"`, 'success');
  };

  const loadTemplate = (name: string) => {
    const found = savedTemplates.find((t) => t.name === name);
    if (found) setConfigText(JSON.stringify(found.config, null, 2));
  };

  const deleteTemplate = (name: string) => {
    setSavedTemplates((prev) => prev.filter((t) => t.name !== name));
  };

  const exportScript = () => {
    if (!template) return;
    downloadText(`${slugify(template.name)}.mjs`, exportAsScript(template), 'text/javascript');
    toast('Exported standalone .mjs', 'success');
  };

  if (!storeId) {
    return (
      <EmptyState
        icon={<StorageIcon sx={{ fontSize: 56, opacity: 0.5 }} />}
        title="No store selected"
        description="Choose a store to migrate source data into tuples."
      />
    );
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', px: 2, pb: 4 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1.5 }} flexWrap="wrap" useFlexGap>
        <Typography variant="body2" color="text.secondary">
          CSV → tuples for <strong>{storeName || storeId}</strong> ({environment.label})
        </Typography>
        <Box sx={{ flex: 1 }} />
        {transformResult && <Chip size="small" label={`${transformResult.stats.produced.toLocaleString()} tuples staged`} />}
        <Button size="small" variant="outlined" startIcon={<CodeIcon />} onClick={exportScript} disabled={!template}>
          Export as script
        </Button>
      </Stack>

      <Stack spacing={2}>
        <SourcePicker
          csvText={csvText}
          onCsvChange={handleCsvChange}
          csvName={csvName}
          headers={parsed.headers}
          rows={parsed.rows}
        />

        <MappingEditor
          configText={configText}
          onConfigChange={setConfigText}
          errors={errors}
          template={template}
          headers={parsed.headers}
          sampleRows={parsed.rows}
          previewTuples={transformResult?.sample ?? []}
          producedCount={transformResult?.stats.produced ?? 0}
          modelTypes={modelMeta.types}
          modelRelations={modelMeta.relations}
          savedTemplates={savedTemplates}
          onSaveTemplate={saveTemplate}
          onLoadTemplate={loadTemplate}
          onDeleteTemplate={deleteTemplate}
          onCopyAiPrompt={copyAiPrompt}
        />

        <DryRunSummary
          result={transformResult}
          rows={parsed.rows}
          template={template}
          warnings={warnings}
          modelAvailable={Boolean(currentModel && currentModel.trim())}
          diff={diff}
          diffLoading={diffLoading}
          onRunDiff={runDiff}
        />

        <ApplyPanel
          storeId={storeId}
          storeName={storeName}
          authModelId={authModelId}
          template={template}
          tuples={transformResult?.tuples ?? []}
          warningsCount={warnings.length}
          csvName={csvName}
          csvHash={csvHash}
          onRunSaved={loadRuns}
        />

        <RunHistory runs={runs} storeId={storeId} authModelId={authModelId} onChanged={loadRuns} />
      </Stack>
    </Box>
  );
}
