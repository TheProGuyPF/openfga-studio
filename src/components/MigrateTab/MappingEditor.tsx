import { useMemo, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import {
  Box,
  Paper,
  Typography,
  Button,
  Stack,
  Alert,
  Chip,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  ToggleButton,
  ToggleButtonGroup,
  useTheme,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import SaveIcon from '@mui/icons-material/Save';
import DeleteIcon from '@mui/icons-material/Delete';
import ViewListIcon from '@mui/icons-material/ViewList';
import DataObjectIcon from '@mui/icons-material/DataObject';
import { MIGRATION_TEMPLATE_SCHEMA, describeRule } from '../../utils/migrationSchema';
import type { MigrationTemplate, Tuple } from '../../utils/migrationTransform';
import type { SavedTemplate } from './types';
import { MappingBuilder } from './MappingBuilder';
import { normalizeTemplate, serializeTemplate, BLANK_TEMPLATE } from './mappingBuilderModel';

interface MappingEditorProps {
  configText: string;
  onConfigChange: (text: string) => void;
  errors: string[];
  template: MigrationTemplate | null;
  headers: string[];
  sampleRows: Record<string, string>[];
  previewTuples: Tuple[];
  producedCount: number;
  modelTypes: string[];
  modelRelations: string[];
  savedTemplates: SavedTemplate[];
  onSaveTemplate: () => void;
  onLoadTemplate: (name: string) => void;
  onDeleteTemplate: (name: string) => void;
  onCopyAiPrompt: () => void;
}

/** Step 2 — Mapping: JSON-first Monaco editor with schema validation, live preview,
 * rule explainer, AI-prompt helper, import/export, and named templates. */
export function MappingEditor({
  configText,
  onConfigChange,
  errors,
  template,
  headers,
  previewTuples,
  producedCount,
  modelTypes,
  modelRelations,
  savedTemplates,
  onSaveTemplate,
  onLoadTemplate,
  onDeleteTemplate,
  onCopyAiPrompt,
}: MappingEditorProps) {
  const theme = useTheme();
  const importRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'builder' | 'json'>('builder');

  // The Builder edits the SAME config as the JSON editor. Derive a well-formed
  // working template from the current text; null means the JSON can't be parsed,
  // in which case the Builder shows a recovery prompt rather than crashing.
  const builderTemplate = useMemo(() => {
    try {
      return normalizeTemplate(JSON.parse(configText));
    } catch {
      return null;
    }
  }, [configText]);

  const handleBuilderChange = (t: MigrationTemplate) => onConfigChange(serializeTemplate(t));

  const handleMount: OnMount = (_editor, monaco) => {
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      schemas: [
        {
          uri: 'https://openfga-studio/migration-template.schema.json',
          fileMatch: ['*'],
          schema: MIGRATION_TEMPLATE_SCHEMA,
        },
      ],
    });
    loader.init().then((m) => {
      m.editor.defineTheme('custom-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: { 'editor.background': theme.palette.background.paper },
      });
    });
  };

  const handleExport = () => {
    const blob = new Blob([configText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${template?.name ? template.name : 'migration-template'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => onConfigChange(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        2. Mapping template
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
        <ToggleButtonGroup
          exclusive
          size="small"
          value={view}
          onChange={(_, v) => v && setView(v)}
          aria-label="Mapping authoring mode"
          sx={{ mr: 0.5 }}
        >
          <ToggleButton value="builder" sx={{ textTransform: 'none', px: 1.5 }}>
            <ViewListIcon fontSize="small" sx={{ mr: 0.5 }} /> Builder
          </ToggleButton>
          <ToggleButton value="json" sx={{ textTransform: 'none', px: 1.5 }}>
            <DataObjectIcon fontSize="small" sx={{ mr: 0.5 }} /> JSON
          </ToggleButton>
        </ToggleButtonGroup>
        <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={onCopyAiPrompt}>
          Copy AI prompt
        </Button>
        <Button size="small" variant="outlined" startIcon={<FileUploadIcon />} onClick={() => importRef.current?.click()}>
          Import
        </Button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImport(file);
            e.target.value = '';
          }}
        />
        <Button size="small" variant="outlined" startIcon={<FileDownloadIcon />} onClick={handleExport}>
          Export
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<SaveIcon />}
          onClick={onSaveTemplate}
          disabled={!template}
        >
          Save template
        </Button>
        {savedTemplates.length > 0 && (
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Load template</InputLabel>
            <Select label="Load template" value="" onChange={(e) => onLoadTemplate(e.target.value)}>
              {savedTemplates.map((t) => (
                <MenuItem key={t.name} value={t.name}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    {t.name}
                    <IconButton
                      size="small"
                      edge="end"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTemplate(t.name);
                      }}
                    >
                      <DeleteIcon fontSize="inherit" />
                    </IconButton>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Stack>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ flex: view === 'builder' ? '1 1 560px' : '1 1 420px', minWidth: 320 }}>
          {view === 'json' ? (
            <Box sx={{ height: 340, border: `1px solid ${theme.palette.divider}` }}>
              <Editor
                height="100%"
                defaultLanguage="json"
                path="migration-template.json"
                value={configText}
                onChange={(v) => onConfigChange(v ?? '')}
                onMount={handleMount}
                theme={theme.palette.mode === 'dark' ? 'custom-dark' : 'light'}
                options={{
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 13,
                  tabSize: 2,
                }}
              />
            </Box>
          ) : builderTemplate ? (
            <MappingBuilder
              template={builderTemplate}
              onChange={handleBuilderChange}
              headers={headers}
              modelTypes={modelTypes}
              modelRelations={modelRelations}
            />
          ) : (
            <Alert
              severity="warning"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => onConfigChange(serializeTemplate(BLANK_TEMPLATE))}
                >
                  Reset to blank
                </Button>
              }
            >
              The JSON can't be parsed, so the form is unavailable. Fix it in the JSON view, or reset to a blank
              template.
            </Alert>
          )}
          {errors.length > 0 ? (
            <Alert severity="warning" sx={{ mt: 1 }}>
              <Typography variant="body2" component="div">
                {errors.slice(0, 6).map((e, i) => (
                  <div key={i}>• {e}</div>
                ))}
                {errors.length > 6 && <div>…and {errors.length - 6} more</div>}
              </Typography>
            </Alert>
          ) : (
            template && (
              <Alert severity="success" sx={{ mt: 1 }}>
                Valid template. {producedCount.toLocaleString()} tuple{producedCount === 1 ? '' : 's'} produced from the
                current CSV.
              </Alert>
            )
          )}
        </Box>

        <Box sx={{ flex: '1 1 360px', minWidth: 300 }}>
          {view === 'json' && template && (
            <>
              <Typography variant="subtitle2" gutterBottom>
                What this template does
              </Typography>
              <List dense sx={{ mb: 1 }}>
                {template.rules.map((rule) => (
                  <ListItem key={rule.id} sx={{ display: 'list-item', py: 0.25 }}>
                    <ListItemText
                      primaryTypographyProps={{ variant: 'body2' }}
                      primary={describeRule(rule)}
                    />
                  </ListItem>
                ))}
              </List>
            </>
          )}

          <Typography variant="subtitle2" gutterBottom>
            Live preview {previewTuples.length > 0 && `(first ${previewTuples.length})`}
          </Typography>
          {previewTuples.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No tuples yet — load a CSV and a valid template.
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {previewTuples.map((t, i) => (
                <Box key={i} sx={{ fontFamily: 'monospace', fontSize: 12, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  <Chip size="small" label={t.user} variant="outlined" />
                  <Chip size="small" label={t.relation} color="primary" variant="outlined" />
                  <Chip size="small" label={t.object} variant="outlined" />
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </Box>

      {headers.length === 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Tip: paste a CSV above first so the AI prompt and validation can see your column names.
        </Typography>
      )}
    </Paper>
  );
}
