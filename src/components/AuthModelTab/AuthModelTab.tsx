import { useState, useEffect } from 'react';
import { Box, Paper, Button, IconButton, Alert, CircularProgress, Chip, Tooltip } from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import LockIcon from '@mui/icons-material/Lock';
import { AuthModelEditor } from '../AuthModelEditor/AuthModelEditor';
import { AuthModelGraph } from '../AuthModelGraph/AuthModelGraph';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { OpenFGAService } from '../../services/OpenFGAService';
import { dslToJson } from '../../utils/modelConverter';
import { buildStructuredModel, type StructuredModel } from '../../utils/modelGraph';
import { useRegisterDirty } from '../../contexts/DirtyStateContext';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { ENV_TIER_STYLE } from '../../environments';
import { useToast } from '../../contexts/ToastContext';

interface AuthModelTabProps {
  storeId: string;
  storeName: string;
  initialModel: string;
  onModelUpdate: (model: string) => void;
}

/** Turn parser/transformer errors (which may carry a `.errors` array) into text. */
function formatModelError(error: unknown): string {
  if (error && typeof error === 'object' && 'errors' in error) {
    const errs = (error as { errors?: Array<{ msg?: string }> }).errors;
    if (Array.isArray(errs) && errs.length) {
      return errs.map((e) => e.msg ?? String(e)).join('; ');
    }
  }
  return error instanceof Error ? error.message : 'Invalid authorization model';
}

export default function AuthModelTab({ storeId, storeName, initialModel, onModelUpdate }: AuthModelTabProps) {
  const [authModel, setAuthModel] = useState(initialModel);
  const [graphModel, setGraphModel] = useState<StructuredModel | null>(null);
  const [leftPanelExpanded, setLeftPanelExpanded] = useState(true);
  const [rightPanelExpanded, setRightPanelExpanded] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();
  const { environment } = useEnvironment();

  // Models loaded from a live store open read-only; the user must explicitly
  // unlock to edit. Any store-backed model counts as "remote".
  const isRemote = Boolean(storeId);
  const [locked, setLocked] = useState(isRemote);

  // Re-lock whenever the store changes (env switches remount this tab, which
  // resets state anyway, but store switches within an env do not).
  useEffect(() => {
    setLocked(Boolean(storeId));
  }, [storeId]);

  // Track unsaved edits so the app can warn before refresh / tab / env switch.
  useRegisterDirty('auth-model', authModel !== initialModel);

  // Build the structured model on load (immediately, so the graph shows).
  useEffect(() => {
    setAuthModel(initialModel);
    try {
      setGraphModel(initialModel.trim() ? buildStructuredModel(initialModel) : null);
      setModelError(null);
    } catch (error) {
      console.error('Failed to parse initial auth model:', error);
      setGraphModel(null);
    }
  }, [initialModel]);

  // Live validation + graph rebuild (debounced). On error, keep the last good
  // graph so the diagram doesn't flicker while mid-edit.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (!authModel.trim()) {
        setModelError(null);
        setGraphModel(null);
        return;
      }
      try {
        setGraphModel(buildStructuredModel(authModel));
        setModelError(null);
      } catch (error) {
        setModelError(formatModelError(error));
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [authModel]);

  const performSave = async () => {
    setConfirmOpen(false);
    setIsSaving(true);
    try {
      await OpenFGAService.writeAuthorizationModel(storeId, authModel);
      onModelUpdate(authModel);
      toast('Authorization model saved successfully', 'success');
    } catch (error) {
      console.error('Failed to save authorization model:', error);
      toast(error instanceof Error ? error.message : 'Failed to save authorization model', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDownloadJSON = () => {
    try {
      const jsonContent = authModel.trim().startsWith('{')
        ? authModel
        : JSON.stringify(dslToJson(authModel), null, 2);
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'authorization-model.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download JSON:', error);
      toast(error instanceof Error ? error.message : 'Failed to export model', 'error');
    }
  };

  const typeCount = graphModel?.types.length ?? 0;
  const relationCount = graphModel?.types.reduce((n, t) => n + t.relations.length, 0) ?? 0;
  const tierStyle = ENV_TIER_STYLE[environment.tier];

  return (
    <Box sx={{ display: 'flex', gap: 2, height: '100%', position: 'relative', width: '100%', px: 2, pb: 2 }}>
      <Box
        sx={{
          flex: leftPanelExpanded ? 1 : 'none',
          display: leftPanelExpanded ? 'flex' : 'none',
          flexDirection: 'column',
          minWidth: leftPanelExpanded ? '400px' : 0,
        }}
      >
        <Paper sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center' }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              {locked ? (
                <Button variant="contained" startIcon={<LockOpenIcon />} onClick={() => setLocked(false)}>
                  Unlock to edit
                </Button>
              ) : (
                <>
                  <Button
                    variant="contained"
                    onClick={() => setConfirmOpen(true)}
                    disabled={isSaving || Boolean(modelError) || authModel === initialModel}
                    startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : undefined}
                  >
                    {isSaving ? 'Saving…' : 'Save Model'}
                  </Button>
                  {isRemote && (
                    <Tooltip title="Re-lock (discard nothing, just prevent edits)">
                      <IconButton size="small" onClick={() => setLocked(true)}>
                        <LockIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </>
              )}
              <Button variant="outlined" startIcon={<FileDownloadIcon />} onClick={handleDownloadJSON} disabled={Boolean(modelError)}>
                JSON
              </Button>
            </Box>
            {locked && <Chip size="small" icon={<LockIcon />} label="Read-only" variant="outlined" />}
          </Box>
          {modelError && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {modelError}
            </Alert>
          )}
          <Box sx={{ flexGrow: 1 }}>
            <AuthModelEditor value={authModel} onChange={setAuthModel} readOnly={locked} />
          </Box>
        </Paper>
      </Box>

      <IconButton
        onClick={() => setLeftPanelExpanded(!leftPanelExpanded)}
        sx={{
          position: 'absolute',
          left: leftPanelExpanded ? 'calc(50% - 20px)' : 0,
          top: '50%',
          transform: 'translateY(-50%)',
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        {leftPanelExpanded ? <ChevronLeftIcon /> : <ChevronRightIcon />}
      </IconButton>

      <Box
        sx={{
          flex: rightPanelExpanded ? 1 : 'none',
          display: rightPanelExpanded ? 'flex' : 'none',
          minWidth: rightPanelExpanded ? '400px' : 0,
        }}
      >
        <Paper sx={{ p: 2, height: '100%', width: '100%' }}>
          <AuthModelGraph model={graphModel} />
        </Paper>
      </Box>

      <IconButton
        onClick={() => setRightPanelExpanded(!rightPanelExpanded)}
        sx={{
          position: 'absolute',
          right: rightPanelExpanded ? 16 : 0,
          top: '50%',
          transform: 'translateY(-50%)',
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        {rightPanelExpanded ? <ChevronRightIcon /> : <ChevronLeftIcon />}
      </IconButton>

      <ConfirmDialog
        open={confirmOpen}
        title="Persist authorization model?"
        confirmLabel="Save to store"
        confirmColor={tierStyle?.color === 'error' ? 'error' : environment.tier === 'canary' ? 'warning' : 'primary'}
        onConfirm={performSave}
        onCancel={() => setConfirmOpen(false)}
        message={
          <Box component="span" sx={{ display: 'block' }}>
            This writes a new authorization model version to:
            <Box component="ul" sx={{ mt: 1, mb: 1 }}>
              <li>
                <strong>Store:</strong> {storeName || storeId}
              </li>
              <li>
                <strong>Environment:</strong> {environment.label}
                {tierStyle && (
                  <Chip
                    size="small"
                    label={tierStyle.chipLabel}
                    color={tierStyle.color}
                    sx={{ ml: 1, height: 18 }}
                  />
                )}
              </li>
              <li>
                <strong>Model:</strong> {typeCount} type{typeCount === 1 ? '' : 's'}, {relationCount} relation
                {relationCount === 1 ? '' : 's'}
              </li>
            </Box>
            {environment.tier !== 'nonprod' && (
              <Box component="span" sx={{ color: 'warning.main', display: 'block', mt: 1 }}>
                You are writing to a {environment.tier.toUpperCase()} store. Authorization model versions are immutable
                and cannot be deleted.
              </Box>
            )}
          </Box>
        }
      />
    </Box>
  );
}
