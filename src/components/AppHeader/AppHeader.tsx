import { AppBar, Toolbar, Typography, Box, IconButton, Tooltip, CircularProgress, useTheme } from '@mui/material';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { StoreSelect } from '../StoreSelect/StoreSelect';
import { useToken } from '../../contexts/TokenContext';

interface AppHeaderProps {
  selectedStore: string;
  onStoreChange: (storeId: string, storeName: string) => void;
  onToggleTheme: () => void;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString();
}

export const AppHeader = ({ selectedStore, onStoreChange, onToggleTheme }: AppHeaderProps) => {
  const theme = useTheme();
  const { tokenStatus, error, lastRefreshedAt, refresh, isConfigured } = useToken();

  const isLoading = tokenStatus === 'loading';

  function tokenTooltip(): string {
    if (isLoading) return 'Refreshing token...';
    if (tokenStatus === 'error') return `Token error: ${error}`;
    if (tokenStatus === 'success' && lastRefreshedAt) {
      return `Token refreshed at ${formatTimestamp(lastRefreshedAt)}`;
    }
    return 'Refresh API token';
  }

  return (
    <AppBar position="static" color="default" elevation={1}>
      <Toolbar>
        <Box sx={{ display: 'flex', alignItems: 'center', mr: 2 }}>
          <img src="/openfga.svg" alt="OpenFGA Logo" style={{ height: 32, marginRight: 8 }} />
        </Box>
        <Typography variant="h6" component="div" sx={{ flexGrow: 0, mr: 4 }}>
          OpenFGA Studio
        </Typography>
        <Box sx={{ flexGrow: 1 }}>
          <StoreSelect
            selectedStore={selectedStore}
            onStoreChange={onStoreChange}
          />
        </Box>

        {isConfigured && (
          <Tooltip title={tokenTooltip()}>
            <span>
              <IconButton
                onClick={refresh}
                disabled={isLoading}
                color={tokenStatus === 'error' ? 'error' : 'inherit'}
                size="small"
                sx={{ mr: 1 }}
              >
                {isLoading ? (
                  <CircularProgress size={20} color="inherit" />
                ) : tokenStatus === 'error' ? (
                  <ErrorOutlineIcon />
                ) : tokenStatus === 'success' ? (
                  <CheckCircleOutlineIcon />
                ) : (
                  <RefreshIcon />
                )}
              </IconButton>
            </span>
          </Tooltip>
        )}

        <IconButton onClick={onToggleTheme} color="inherit">
          {theme.palette.mode === 'dark' ? <Brightness7Icon /> : <Brightness4Icon />}
        </IconButton>
      </Toolbar>
    </AppBar>
  );
};
