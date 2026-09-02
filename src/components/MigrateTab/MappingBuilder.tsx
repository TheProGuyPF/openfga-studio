// Guided MappingBuilder — a form-based authoring surface for a MigrationTemplate,
// two-way synced with the JSON editor (both edit the SAME config object). It edits
// a normalized working template and emits changes via onChange; MappingEditor
// serializes those back to the shared JSON text. Progressive disclosure keeps the
// common case (constant relation, `type:{col}` segments) to a single row, with
// advanced options (case-fold, usersets, enum branches) tucked behind toggles.
import { useState } from 'react';
import {
  Box,
  Stack,
  Card,
  CardContent,
  Typography,
  TextField,
  Autocomplete,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  FormControlLabel,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  IconButton,
  Button,
  Chip,
  Collapse,
  Tooltip,
  Alert,
  useTheme,
  alpha,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TuneIcon from '@mui/icons-material/Tune';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import type {
  MigrationTemplate,
  TupleRule,
  Segment,
  RelationSpec,
  RowFilter,
} from '../../utils/migrationTransform';
import { describeRule } from '../../utils/migrationSchema';
import { newRule, newRowFilter, moveItem } from './mappingBuilderModel';

interface MappingBuilderProps {
  template: MigrationTemplate;
  onChange: (t: MigrationTemplate) => void;
  /** Detected CSV columns — power the column dropdowns and the not-in-CSV warnings. */
  headers: string[];
  /** Type names from the active model — seed the type prefix autocompletes. */
  modelTypes: string[];
  /** Relation names from the active model — seed the relation autocompletes. */
  modelRelations: string[];
}

/** A single free-text-or-pick field over CSV columns (or model names), with an
 * inline warning when the referenced column isn't in the detected CSV headers. */
function ColumnField({
  label,
  value,
  onChange,
  options,
  headers,
  required,
  placeholder,
  sx,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  /** When provided, warn if `value` isn't among these (used for CSV column fields). */
  headers?: string[];
  required?: boolean;
  placeholder?: string;
  sx?: object;
}) {
  const unknown = Boolean(headers && value && !headers.includes(value));
  return (
    <Autocomplete
      freeSolo
      size="small"
      options={options}
      inputValue={value}
      onInputChange={(_, v) => onChange(v)}
      sx={{ flex: 1, minWidth: 140, ...sx }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          placeholder={placeholder}
          error={required && !value}
          helperText={
            unknown ? (
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'warning.main' }}>
                <WarningAmberIcon sx={{ fontSize: 14 }} /> Not a detected CSV column
              </Box>
            ) : undefined
          }
        />
      )}
    />
  );
}

/** Multi-value chip field (columns / truthy values); warns on unknown columns. */
function ChipListField({
  label,
  values,
  onChange,
  options,
  headers,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: string[];
  headers?: string[];
  placeholder?: string;
}) {
  return (
    <Autocomplete
      multiple
      freeSolo
      size="small"
      options={options}
      value={values}
      onChange={(_, v) => onChange(v as string[])}
      renderTags={(tags, getTagProps) =>
        tags.map((tag, index) => {
          const unknown = Boolean(headers && !headers.includes(tag));
          const { key, ...rest } = getTagProps({ index });
          return (
            <Chip
              key={key}
              {...rest}
              size="small"
              label={tag}
              color={unknown ? 'warning' : 'default'}
              variant="outlined"
            />
          );
        })
      }
      renderInput={(params) => <TextField {...params} label={label} placeholder={placeholder} />}
    />
  );
}

const rowSx = { display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' } as const;

/** Editor for a user/object Segment with progressive disclosure. */
function SegmentEditor({
  title,
  seg,
  onChange,
  headers,
  modelTypes,
}: {
  title: string;
  seg: Segment;
  onChange: (s: Segment) => void;
  headers: string[];
  modelTypes: string[];
}) {
  const enumOn = Boolean(seg.enum);
  const [advOpen, setAdvOpen] = useState(
    Boolean(seg.usersetRelation || (seg.caseFold && seg.caseFold !== 'none') || seg.enum),
  );
  const theme = useTheme();

  const patch = (p: Partial<Segment>) => onChange({ ...seg, ...p });

  const toggleEnum = (on: boolean) => {
    if (on) {
      onChange({ ...seg, type: undefined, enum: { column: '', caseInsensitive: true, map: {} } });
      setAdvOpen(true);
    } else {
      const next = { ...seg };
      delete next.enum;
      onChange(next);
    }
  };

  const enumEntries = seg.enum ? Object.entries(seg.enum.map) : [];
  const commitEnumMap = (entries: [string, { type: string; usersetRelation?: string }][]) => {
    if (!seg.enum) return;
    const map: Record<string, { type: string; usersetRelation?: string }> = {};
    for (const [k, v] of entries) map[k] = v;
    onChange({ ...seg, enum: { ...seg.enum, map } });
  };

  return (
    <Box
      sx={{
        flex: '1 1 240px',
        minWidth: 240,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1,
        p: 1.5,
        bgcolor: alpha(theme.palette.text.primary, 0.015),
      }}
    >
      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {title}
      </Typography>

      <Stack spacing={1}>
        {!enumOn && (
          <Box sx={rowSx}>
            <ColumnField
              label="Type prefix"
              value={seg.type ?? ''}
              onChange={(v) => patch({ type: v })}
              options={modelTypes}
              placeholder="e.g. user"
            />
            <ColumnField
              label="Id column"
              value={seg.column ?? ''}
              onChange={(v) => patch({ column: v })}
              options={headers}
              headers={headers}
              required
            />
          </Box>
        )}

        {enumOn && seg.enum && (
          <Stack spacing={1}>
            <Box sx={rowSx}>
              <ColumnField
                label="Id column"
                value={seg.column ?? ''}
                onChange={(v) => patch({ column: v })}
                options={headers}
                headers={headers}
                required
              />
              <ColumnField
                label="Branch on column"
                value={seg.enum.column}
                onChange={(v) => patch({ enum: { ...seg.enum!, column: v } })}
                options={headers}
                headers={headers}
                required
              />
            </Box>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={seg.enum.caseInsensitive}
                  onChange={(e) => patch({ enum: { ...seg.enum!, caseInsensitive: e.target.checked } })}
                />
              }
              label={<Typography variant="body2">Case-insensitive match</Typography>}
            />
            <Typography variant="caption" color="text.secondary">
              Value → type (unmatched values skip the tuple):
            </Typography>
            {enumEntries.map(([k, v], i) => (
              <Box key={i} sx={rowSx}>
                <TextField
                  size="small"
                  label="Value"
                  value={k}
                  sx={{ flex: '1 1 90px', minWidth: 90 }}
                  onChange={(e) => {
                    const next = [...enumEntries];
                    next[i] = [e.target.value, v];
                    commitEnumMap(next);
                  }}
                />
                <ColumnField
                  label="Type"
                  value={v.type}
                  options={modelTypes}
                  onChange={(nv) => {
                    const next = [...enumEntries];
                    next[i] = [k, { ...v, type: nv }];
                    commitEnumMap(next);
                  }}
                />
                <TextField
                  size="small"
                  label="#userset"
                  value={v.usersetRelation ?? ''}
                  sx={{ flex: '1 1 90px', minWidth: 90 }}
                  onChange={(e) => {
                    const next = [...enumEntries];
                    const userset = e.target.value;
                    next[i] = [k, userset ? { ...v, usersetRelation: userset } : { type: v.type }];
                    commitEnumMap(next);
                  }}
                />
                <Tooltip title="Remove mapping">
                  <IconButton
                    size="small"
                    aria-label="Remove value mapping"
                    onClick={() => commitEnumMap(enumEntries.filter((_, j) => j !== i))}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
            <Button
              size="small"
              startIcon={<AddIcon />}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => commitEnumMap([...enumEntries, ['', { type: '' }]])}
            >
              Add value mapping
            </Button>
          </Stack>
        )}

        <Button
          size="small"
          color="inherit"
          startIcon={<TuneIcon fontSize="small" />}
          endIcon={
            <ExpandMoreIcon
              fontSize="small"
              sx={{ transform: advOpen ? 'rotate(180deg)' : 'none', transition: '0.2s' }}
            />
          }
          onClick={() => setAdvOpen((o) => !o)}
          sx={{ alignSelf: 'flex-start', textTransform: 'none', color: 'text.secondary' }}
        >
          Advanced
        </Button>
        <Collapse in={advOpen} unmountOnExit>
          <Stack spacing={1} sx={{ pt: 0.5 }}>
            <FormControlLabel
              control={<Switch size="small" checked={enumOn} onChange={(e) => toggleEnum(e.target.checked)} />}
              label={<Typography variant="body2">Choose type from a column (enum branch)</Typography>}
            />
            {!enumOn && (
              <TextField
                size="small"
                label="Userset relation (optional)"
                placeholder="e.g. member → team:{id}#member"
                value={seg.usersetRelation ?? ''}
                onChange={(e) => patch({ usersetRelation: e.target.value || undefined })}
              />
            )}
            <FormControl size="small" sx={{ maxWidth: 220 }}>
              <InputLabel>Case-fold id</InputLabel>
              <Select
                label="Case-fold id"
                value={seg.caseFold ?? 'none'}
                onChange={(e) =>
                  patch({ caseFold: e.target.value === 'none' ? undefined : (e.target.value as 'upper' | 'lower') })
                }
              >
                <MenuItem value="none">None</MenuItem>
                <MenuItem value="upper">UPPERCASE</MenuItem>
                <MenuItem value="lower">lowercase</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </Collapse>
      </Stack>
    </Box>
  );
}

/** Editor for a tuple's relation: a constant, or an enum keyed off a column. */
function RelationEditor({
  rel,
  onChange,
  headers,
  modelRelations,
}: {
  rel: RelationSpec;
  onChange: (r: RelationSpec) => void;
  headers: string[];
  modelRelations: string[];
}) {
  const theme = useTheme();
  const mode: 'constant' | 'enum' = rel.enum ? 'enum' : 'constant';

  const entries = rel.enum ? Object.entries(rel.enum.map) : [];
  const commitMap = (next: [string, string][]) => {
    if (!rel.enum) return;
    const map: Record<string, string> = {};
    for (const [k, v] of next) map[k] = v;
    onChange({ enum: { ...rel.enum, map } });
  };

  return (
    <Box
      sx={{
        flex: '1 1 200px',
        minWidth: 200,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1,
        p: 1.5,
        bgcolor: alpha(theme.palette.primary.main, 0.03),
      }}
    >
      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Relation
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={mode}
        onChange={(_, v) => {
          if (!v) return;
          if (v === 'constant') onChange({ constant: rel.enum ? '' : rel.constant ?? '' });
          else onChange({ enum: { column: '', caseInsensitive: true, map: {} } });
        }}
        sx={{ mb: 1 }}
      >
        <ToggleButton value="constant" sx={{ textTransform: 'none' }}>
          Constant
        </ToggleButton>
        <ToggleButton value="enum" sx={{ textTransform: 'none' }}>
          From column
        </ToggleButton>
      </ToggleButtonGroup>

      {mode === 'constant' ? (
        <ColumnField
          label="Relation"
          value={rel.constant ?? ''}
          onChange={(v) => onChange({ constant: v })}
          options={modelRelations}
          required
        />
      ) : (
        rel.enum && (
          <Stack spacing={1}>
            <ColumnField
              label="Branch on column"
              value={rel.enum.column}
              onChange={(v) => onChange({ enum: { ...rel.enum!, column: v } })}
              options={headers}
              headers={headers}
              required
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={rel.enum.caseInsensitive}
                  onChange={(e) => onChange({ enum: { ...rel.enum!, caseInsensitive: e.target.checked } })}
                />
              }
              label={<Typography variant="body2">Case-insensitive match</Typography>}
            />
            {entries.map(([k, v], i) => (
              <Box key={i} sx={rowSx}>
                <TextField
                  size="small"
                  label="Value"
                  value={k}
                  sx={{ flex: '1 1 90px', minWidth: 90 }}
                  onChange={(e) => {
                    const next = [...entries];
                    next[i] = [e.target.value, v];
                    commitMap(next);
                  }}
                />
                <ColumnField
                  label="Relation"
                  value={v}
                  options={modelRelations}
                  onChange={(nv) => {
                    const next = [...entries];
                    next[i] = [k, nv];
                    commitMap(next);
                  }}
                />
                <Tooltip title="Remove mapping">
                  <IconButton
                    size="small"
                    aria-label="Remove relation mapping"
                    onClick={() => commitMap(entries.filter((_, j) => j !== i))}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
            <Button
              size="small"
              startIcon={<AddIcon />}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => commitMap([...entries, ['', '']])}
            >
              Add value mapping
            </Button>
            <ColumnField
              label="Default relation (optional)"
              value={rel.enum.default ?? ''}
              onChange={(v) => onChange({ enum: { ...rel.enum!, default: v || undefined } })}
              options={modelRelations}
            />
          </Stack>
        )
      )}
    </Box>
  );
}

/** One rule = one card, headed by its live plain-English sentence. */
function RuleCard({
  rule,
  index,
  total,
  onChange,
  onMove,
  onRemove,
  headers,
  modelTypes,
  modelRelations,
}: {
  rule: TupleRule;
  index: number;
  total: number;
  onChange: (r: TupleRule) => void;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
  headers: string[];
  modelTypes: string[];
  modelRelations: string[];
}) {
  const theme = useTheme();
  return (
    <Card variant="outlined">
      <CardContent sx={{ pb: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1.5 }}>
          <Chip size="small" label={`Rule ${index + 1}`} sx={{ mt: 0.25 }} />
          <Box
            sx={{
              flex: 1,
              p: 1,
              borderRadius: 1,
              bgcolor: alpha(theme.palette.info.main, 0.08),
              border: `1px solid ${alpha(theme.palette.info.main, 0.25)}`,
              fontSize: 13,
              lineHeight: 1.4,
              '& code': { fontFamily: 'monospace', fontSize: 12 },
            }}
          >
            <Typography variant="body2" component="div" dangerouslySetInnerHTML={{ __html: renderDescription(rule) }} />
          </Box>
          <Stack direction="row">
            <Tooltip title="Move up">
              <span>
                <IconButton size="small" aria-label="Move rule up" disabled={index === 0} onClick={() => onMove(index, index - 1)}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down">
              <span>
                <IconButton
                  size="small"
                  aria-label="Move rule down"
                  disabled={index === total - 1}
                  onClick={() => onMove(index, index + 1)}
                >
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Delete rule">
              <IconButton size="small" aria-label="Delete rule" color="error" onClick={onRemove}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        <Box sx={{ ...rowSx, mb: 1.5 }}>
          <TextField
            size="small"
            label="Rule id"
            value={rule.id}
            onChange={(e) => onChange({ ...rule, id: e.target.value })}
            sx={{ flex: '1 1 160px', minWidth: 160 }}
          />
          <Box sx={{ flex: '2 1 260px', minWidth: 220 }}>
            <ChipListField
              label="Only when these columns are present (optional)"
              values={rule.whenColumnsPresent}
              onChange={(v) => onChange({ ...rule, whenColumnsPresent: v })}
              options={headers}
              headers={headers}
              placeholder="add column…"
            />
          </Box>
        </Box>

        <Box sx={rowSx}>
          <SegmentEditor
            title="User"
            seg={rule.user}
            onChange={(user) => onChange({ ...rule, user })}
            headers={headers}
            modelTypes={modelTypes}
          />
          <RelationEditor
            rel={rule.relation}
            onChange={(relation) => onChange({ ...rule, relation })}
            headers={headers}
            modelRelations={modelRelations}
          />
          <SegmentEditor
            title="Object"
            seg={rule.object}
            onChange={(object) => onChange({ ...rule, object })}
            headers={headers}
            modelTypes={modelTypes}
          />
        </Box>
      </CardContent>
    </Card>
  );
}

/** describeRule() returns markdown-ish backtick spans; render them as <code>. */
function renderDescription(rule: TupleRule): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const raw = describeRule(rule);
  // Split on backtick spans and wrap only those in <code>, escaping everything.
  return raw
    .split(/(`[^`]*`)/g)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`')
        ? `<code>${escape(part.slice(1, -1))}</code>`
        : escape(part),
    )
    .join('');
}

export function MappingBuilder({ template, onChange, headers, modelTypes, modelRelations }: MappingBuilderProps) {
  const set = (p: Partial<MigrationTemplate>) => onChange({ ...template, ...p });

  const updateRule = (index: number, rule: TupleRule) =>
    set({ rules: template.rules.map((r, i) => (i === index ? rule : r)) });

  return (
    <Stack spacing={2}>
      {/* Template details */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            Template details
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <TextField
              size="small"
              label="Name"
              required
              value={template.name}
              error={!template.name.trim()}
              onChange={(e) => set({ name: e.target.value })}
              fullWidth
            />
            <TextField
              size="small"
              label="Description (optional)"
              value={template.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
              fullWidth
            />
            <Box sx={rowSx}>
              <FormControl size="small" sx={{ flex: '1 1 200px', minWidth: 180 }}>
                <InputLabel>On an invalid segment</InputLabel>
                <Select
                  label="On an invalid segment"
                  value={template.validationMode}
                  onChange={(e) => set({ validationMode: e.target.value as MigrationTemplate['validationMode'] })}
                >
                  <MenuItem value="drop-tuple">Drop just that tuple</MenuItem>
                  <MenuItem value="drop-row">Drop the whole row</MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                sx={{ ml: 0.5 }}
                control={<Switch checked={template.dedupe} onChange={(e) => set({ dedupe: e.target.checked })} />}
                label={<Typography variant="body2">De-duplicate identical tuples</Typography>}
              />
            </Box>
          </Stack>
        </CardContent>
      </Card>

      {/* Row filters */}
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <FilterAltIcon fontSize="small" color="action" />
            <Typography variant="subtitle2">Row filters</Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => set({ rowFilters: [...template.rowFilters, newRowFilter()] })}
            >
              Add filter
            </Button>
          </Box>
          {template.rowFilters.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No filters — every row is considered. Add one to include or exclude rows by a column value.
            </Typography>
          ) : (
            <Stack spacing={1.5}>
              {template.rowFilters.map((f, i) => (
                <Box key={i} sx={rowSx}>
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={f.mode}
                    onChange={(_, v) => v && updateFilter(template, set, i, { mode: v as RowFilter['mode'] })}
                  >
                    <ToggleButton value="include" sx={{ textTransform: 'none' }}>
                      Include if
                    </ToggleButton>
                    <ToggleButton value="exclude" sx={{ textTransform: 'none' }}>
                      Exclude if
                    </ToggleButton>
                  </ToggleButtonGroup>
                  <ColumnField
                    label="Column"
                    value={f.column}
                    onChange={(v) => updateFilter(template, set, i, { column: v })}
                    options={headers}
                    headers={headers}
                    sx={{ flex: '1 1 140px' }}
                  />
                  <Box sx={{ flex: '2 1 200px', minWidth: 180 }}>
                    <ChipListField
                      label="is one of"
                      values={f.truthyValues}
                      onChange={(v) => updateFilter(template, set, i, { truthyValues: v })}
                      options={[]}
                      placeholder="e.g. true, 1, yes"
                    />
                  </Box>
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={f.caseInsensitive}
                        onChange={(e) => updateFilter(template, set, i, { caseInsensitive: e.target.checked })}
                      />
                    }
                    label={<Typography variant="body2">Aa</Typography>}
                    title="Case-insensitive"
                  />
                  <Tooltip title="Remove filter">
                    <IconButton
                      size="small"
                      aria-label="Remove row filter"
                      onClick={() => set({ rowFilters: template.rowFilters.filter((_, j) => j !== i) })}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>

      {/* Required columns */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            Required columns
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            If any of these is empty in a row, the whole row is skipped.
          </Typography>
          <ChipListField
            label="Required columns"
            values={template.requiredColumns}
            onChange={(v) => set({ requiredColumns: v })}
            options={headers}
            headers={headers}
            placeholder="add column…"
          />
        </CardContent>
      </Card>

      {/* Rules */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="subtitle2">Rules</Typography>
          <Chip size="small" label={template.rules.length} />
          <Box sx={{ flex: 1 }} />
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => set({ rules: [...template.rules, newRule()] })}>
            Add rule
          </Button>
        </Box>
        {template.rules.length === 0 ? (
          <Card variant="outlined" sx={{ borderStyle: 'dashed' }}>
            <CardContent sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
              <Typography variant="body2" gutterBottom>
                No rules yet. Each rule turns one row into one tuple.
              </Typography>
              <Button size="small" startIcon={<AddIcon />} onClick={() => set({ rules: [newRule()] })}>
                Add your first rule
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Stack spacing={2}>
            {template.rules.map((rule, i) => (
              <RuleCard
                key={rule.id || i}
                rule={rule}
                index={i}
                total={template.rules.length}
                onChange={(r) => updateRule(i, r)}
                onMove={(from, to) => set({ rules: moveItem(template.rules, from, to) })}
                onRemove={() => set({ rules: template.rules.filter((_, j) => j !== i) })}
                headers={headers}
                modelTypes={modelTypes}
                modelRelations={modelRelations}
              />
            ))}
          </Stack>
        )}
      </Box>

      {headers.length === 0 && (
        <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
          <Typography variant="caption">
            Tip: load a CSV in step 1 so the column dropdowns can offer your actual headers.
          </Typography>
        </Alert>
      )}
    </Stack>
  );
}

/** Apply a partial patch to row filter `i` (small helper to keep JSX tidy). */
function updateFilter(
  template: MigrationTemplate,
  set: (p: Partial<MigrationTemplate>) => void,
  i: number,
  patch: Partial<RowFilter>,
) {
  set({ rowFilters: template.rowFilters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
}
