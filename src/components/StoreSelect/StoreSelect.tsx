import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Button, 
  Box, 
  CircularProgress, 
  TextField, 
  Dialog, 
  DialogTitle, 
  DialogContent, 
  DialogActions, 
  Alert, 
  Select,
  MenuItem,
  FormControl,
  Typography
} from '@mui/material';
import { OpenFGAService } from '../../services/OpenFGAService';
import { useEnvironment } from '../../contexts/EnvironmentContext';

interface Store {
  id: string;
  name: string;
}

interface StoreSelectProps {
  selectedStore?: string;
  onStoreChange: (storeId: string, storeName: string) => void;
  /** Optionally control the create-store dialog from a parent (e.g. an empty-state CTA). */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
}

export const StoreSelect = ({ selectedStore, onStoreChange, createOpen, onCreateOpenChange }: StoreSelectProps) => {
  const { environment } = useEnvironment();
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalCreateOpen, setInternalCreateOpen] = useState(false);
  // Controlled when the parent passes createOpen; otherwise self-managed.
  const isCreateDialogOpen = createOpen ?? internalCreateOpen;
  const setCreateOpen = onCreateOpenChange ?? setInternalCreateOpen;
  const [newStoreName, setNewStoreName] = useState('');
  const [creatingStore, setCreatingStore] = useState(false);
  // Ensures the initial auto-select / restore-sync runs once, not on every refresh.
  const didInitialSelect = useRef(false);

  const loadStores = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const storesList = await OpenFGAService.listStores();
      setStores(storesList);

      if (storesList.length > 0 && !didInitialSelect.current) {
        didInitialSelect.current = true;
        if (!selectedStore) {
          // Nothing selected: prefer this env's configured default, else the first.
          const preferred = environment.storeId
            ? storesList.find((s) => s.id === environment.storeId)
            : undefined;
          const pick = preferred ?? storesList[0];
          onStoreChange(pick.id, pick.name);
        } else {
          // A store is preselected (restored from URL/persistence): sync its name
          // and load its model. No-op if it isn't in this env's list.
          const current = storesList.find((s) => s.id === selectedStore);
          if (current) onStoreChange(current.id, current.name);
        }
      }
    } catch (error) {
      console.error('Failed to load stores:', error);
      setError(error instanceof Error ? error.message : 'Failed to load stores. Please try again.');
      setStores([]); // Ensure stores is always an array
    } finally {
      setLoading(false);
    }
  }, [selectedStore, onStoreChange, environment.storeId]);

  useEffect(() => {
    loadStores();
  }, [loadStores]);

  const handleCreateStore = async () => {
    if (!newStoreName.trim()) return;

    try {
      setCreatingStore(true);
      setError(null);
      await OpenFGAService.createStore(newStoreName.trim());
      setNewStoreName('');
      setCreateOpen(false);
      await loadStores(); // Reload stores after creating new one
    } catch (error) {
      console.error('Failed to create store:', error);
      setError('Failed to create store. Please try again.');
    } finally {
      setCreatingStore(false);
    }
  };

  const handleRefresh = () => {
    loadStores();
  };

  if (loading && stores.length === 0) {
    return (
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: 1,
        color: 'text.secondary' 
      }}>
        <CircularProgress size={20} />
        <Typography>Loading stores...</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 200 }}>
        {error && (
          <Alert 
            severity="error" 
            sx={{ 
              position: 'fixed',
              right: 16,
              top: 72,
              zIndex: 1400,
              minWidth: 300,
              boxShadow: (theme) => theme.shadows[3],
            }}
          >
            {error}
          </Alert>
        )}
        
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <Select
              value={selectedStore || ''}
              onChange={(e) => {
                const selectedStore = stores.find(s => s.id === e.target.value);
                if (selectedStore) {
                  onStoreChange(selectedStore.id, selectedStore.name);
                }
              }}
              disabled={loading}
              displayEmpty
            >
              {stores.length === 0 ? (
                <MenuItem value="" disabled>No stores available</MenuItem>
              ) : (
                stores.map((store) => (
                  <MenuItem key={store.id} value={store.id}>
                    <Typography>
                      {store.name} <Typography component="span" color="text.secondary">({store.id})</Typography>
                    </Typography>
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>
          
          {loading && <CircularProgress size={16} />}

          <Button 
            onClick={handleRefresh} 
            disabled={loading}
            size="small"
            variant="outlined"
            sx={{
              borderColor: 'divider',
              '&:hover': {
                borderColor: 'primary.main'
              }
            }}
          >
            Refresh
          </Button>
          
          <Button
            variant="outlined"
            size="small"
            onClick={() => setCreateOpen(true)}
            sx={{
              borderColor: 'divider',
              '&:hover': {
                borderColor: 'primary.main'
              }
            }}
          >
            New Store
          </Button>
        </Box>
      </Box>

      <Dialog 
        open={isCreateDialogOpen} 
        onClose={() => setCreateOpen(false)}
        PaperProps={{
          sx: {
            bgcolor: 'background.paper',
            backgroundImage: 'none'
          }
        }}
      >
        <DialogTitle>Create New Store</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Store Name"
            fullWidth
            variant="outlined"
            value={newStoreName}
            onChange={(e) => setNewStoreName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newStoreName.trim() && !creatingStore) {
                e.preventDefault();
                handleCreateStore();
              }
            }}
            sx={{
              mt: 1,
              '& .MuiOutlinedInput-root': {
                '& fieldset': {
                  borderColor: 'divider'
                }
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button 
            onClick={() => setCreateOpen(false)}
            sx={{
              color: 'text.secondary',
              '&:hover': {
                color: 'text.primary'
              }
            }}
          >
            Cancel
          </Button>
          <Button 
            onClick={handleCreateStore}
            disabled={!newStoreName.trim() || creatingStore}
            variant="contained"
          >
            {creatingStore ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
