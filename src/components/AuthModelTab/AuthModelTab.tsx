import { useState, useCallback, useEffect } from 'react';
import { Box, Paper, Button, IconButton, Alert, CircularProgress } from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { AuthModelEditor } from '../AuthModelEditor/AuthModelEditor';
import { AuthModelGraph } from '../AuthModelGraph/AuthModelGraph';
import { OpenFGAService } from '../../services/OpenFGAService';
import { parseAuthModelToGraph } from '../../utils/authModelParser';
import { dslToJson } from '../../utils/modelConverter';
import { useRegisterDirty } from '../../contexts/DirtyStateContext';
import { useToast } from '../../contexts/ToastContext';
import type { Node, Edge, NodeChange, EdgeChange } from 'reactflow';
import { applyNodeChanges, applyEdgeChanges } from 'reactflow';

interface AuthModelTabProps {
  storeId: string;
  storeName: string;
  initialModel: string;
  onModelUpdate: (model: string) => void;
}

export default function AuthModelTab({ storeId, storeName, initialModel, onModelUpdate }: AuthModelTabProps) {
  const [authModel, setAuthModel] = useState(initialModel);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [leftPanelExpanded, setLeftPanelExpanded] = useState(true);
  const [rightPanelExpanded, setRightPanelExpanded] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  // Track unsaved edits so the app can warn before refresh / tab / env switch.
  useRegisterDirty('auth-model', authModel !== initialModel);

  // Live validation: parse the model (debounced) and surface errors inline
  // instead of only failing silently in the graph / on save.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (!authModel.trim()) {
        setModelError(null);
        return;
      }
      try {
        if (authModel.trim().startsWith('{')) JSON.parse(authModel);
        else dslToJson(authModel);
        setModelError(null);
      } catch (error) {
        setModelError(error instanceof Error ? error.message : 'Invalid authorization model');
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [authModel]);

  useEffect(() => {
    setAuthModel(initialModel);
    try {
      const { nodes: initialNodes, edges: initialEdges } = parseAuthModelToGraph(initialModel, storeName);
      setNodes(initialNodes);
      setEdges(initialEdges);
    } catch (error) {
      console.error('Failed to parse initial auth model:', error);
    }
  }, [initialModel, storeName]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const handleAuthModelChange = (value: string) => {
    setAuthModel(value);
    try {
      const { nodes: newNodes, edges: newEdges } = parseAuthModelToGraph(value, storeName);
      setNodes(newNodes);
      setEdges(newEdges);
    } catch (error) {
      console.error('Failed to parse auth model:', error);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await OpenFGAService.writeAuthorizationModel(storeId, authModel);
      onModelUpdate(authModel);
      toast('Authorization model saved successfully', 'success');
    } catch (error) {
      console.error('Failed to save authorization model:', error);
      toast(
        error instanceof Error ? error.message : 'Failed to save authorization model',
        'error',
      );
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

  return (
    <Box sx={{ 
      display: 'flex', 
      gap: 2,
      height: '100%',
      position: 'relative',
      width: '100%',
      px: 2,
      pb: 2
    }}>
      <Box sx={{ 
        flex: leftPanelExpanded ? 1 : 'none',
        display: leftPanelExpanded ? 'flex' : 'none',
        flexDirection: 'column',
        minWidth: leftPanelExpanded ? '400px' : 0
      }}>
        <Paper sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between', gap: 1 }}>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                variant="contained"
                onClick={handleSave}
                disabled={isSaving || Boolean(modelError)}
                startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {isSaving ? 'Saving…' : 'Save Model'}
              </Button>
              <Button
                variant="outlined"
                startIcon={<FileDownloadIcon />}
                onClick={handleDownloadJSON}
                disabled={Boolean(modelError)}
              >
              JSON
              </Button>
            </Box>
          </Box>
          {modelError && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {modelError}
            </Alert>
          )}
          <Box sx={{ flexGrow: 1 }}>
            <AuthModelEditor value={authModel} onChange={handleAuthModelChange} />
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
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        {leftPanelExpanded ? <ChevronLeftIcon /> : <ChevronRightIcon />}
      </IconButton>

      <Box sx={{ 
        flex: rightPanelExpanded ? 1 : 'none',
        display: rightPanelExpanded ? 'flex' : 'none',
        minWidth: rightPanelExpanded ? '400px' : 0
      }}>
        <Paper sx={{ p: 2, height: '100%', width: '100%' }}>
          <AuthModelGraph
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
          />
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
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        {rightPanelExpanded ? <ChevronRightIcon /> : <ChevronLeftIcon />}
      </IconButton>
    </Box>
  );
};
