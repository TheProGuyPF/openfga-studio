import { useState, useMemo, useCallback, Suspense, lazy } from 'react';
import { Box, CssBaseline, ThemeProvider, createTheme, Tabs, Tab } from '@mui/material';
import { AppHeader } from './components/AppHeader/AppHeader';
import { ProdBanner } from './components/EnvSelect/ProdBanner';
import { LatencyDrawer } from './components/LatencyDrawer/LatencyDrawer';
import { OpenFGAService } from './services/OpenFGAService';
import { TokenProvider } from './contexts/TokenContext';
import { EnvironmentProvider, useEnvironment } from './contexts/EnvironmentContext';
import type { PendingQueryPrefill } from './components/LookupTab/types';
import './App.css';

const AuthModelTab = lazy(() => import('./components/AuthModelTab/AuthModelTab'));
const TuplesTab = lazy(() => import('./components/TuplesTab/TuplesTab'));
const QueryTab = lazy(() => import('./components/QueryTab/QueryTab'));
const LookupTab = lazy(() => import('./components/LookupTab/LookupTab'));
const BenchmarkTab = lazy(() => import('./components/BenchmarkTab/BenchmarkTab'));

const QUERY_TAB_INDEX = 2;
const LOOKUP_TAB_INDEX = 3;
const BENCHMARK_TAB_INDEX = 4;

function App() {
  const [mode, setMode] = useState<'light' | 'dark'>('dark');

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode,
          background: {
            default: mode === 'dark' ? '#121212' : '#f5f5f5',
            paper: mode === 'dark' ? '#1e1e1e' : '#ffffff',
          },
        },
      }),
    [mode]
  );

  const toggleTheme = useCallback(
    () => setMode((m) => (m === 'light' ? 'dark' : 'light')),
    []
  );

  return (
    <EnvironmentProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <AppShell onToggleTheme={toggleTheme} />
      </ThemeProvider>
    </EnvironmentProvider>
  );
}

// Reads the active environment and remounts the whole workspace when it changes
// (via `key`), which resets store/model/tuple/query state and re-fetches the
// token for the new env. The prod banner sits above the remount boundary.
function AppShell({ onToggleTheme }: { onToggleTheme: () => void }) {
  const { currentEnvKey } = useEnvironment();
  return (
    <Box sx={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      bgcolor: 'background.default',
      color: 'text.primary',
      overflow: 'hidden'
    }}>
      <ProdBanner />
      <Workspace key={currentEnvKey} onToggleTheme={onToggleTheme} />
      {/* Passive latency monitor — module-level sample buffer, so it survives the
          per-env workspace remount and observes calls across all tabs/envs. */}
      <LatencyDrawer />
    </Box>
  );
}

function Workspace({ onToggleTheme }: { onToggleTheme: () => void }) {
  const [activeTab, setActiveTab] = useState(0);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [selectedStoreName, setSelectedStoreName] = useState('');
  const [authModel, setAuthModel] = useState('');
  const [authModelId, setAuthModelId] = useState('');
  const [pendingQueryPrefill, setPendingQueryPrefill] =
    useState<PendingQueryPrefill | null>(null);

  const handleStoreChange = async (storeId: string, storeName: string) => {
    setSelectedStoreId(storeId);
    setSelectedStoreName(storeName);
    try {
      const { model, modelId } = await OpenFGAService.getAuthorizationModel(storeId);
      setAuthModel(model);
      setAuthModelId(modelId || '');
    } catch (error) {
      console.error('Failed to fetch authorization model:', error);
      setAuthModel('');
      setAuthModelId('');
    }
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  const handleCheckTupleInQueryTab = useCallback(
    (prefill: PendingQueryPrefill) => {
      setPendingQueryPrefill(prefill);
      setActiveTab(QUERY_TAB_INDEX);
    },
    []
  );

  const handleQueryPrefillConsumed = useCallback(() => {
    setPendingQueryPrefill(null);
  }, []);

  return (
    <TokenProvider>
        <AppHeader
          selectedStore={selectedStoreId}
          storeName={selectedStoreName}
          authModelId={authModelId}
          onStoreChange={handleStoreChange}
          onToggleTheme={onToggleTheme}
        />

        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedStoreId && (
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
                <Tabs 
                  value={activeTab} 
                  onChange={handleTabChange}
                  variant="scrollable"
                  scrollButtons="auto"
                >
                  <Tab label="Authorization Model" />
                  <Tab label="Tuples" />
                  <Tab label="Query" />
                  <Tab label="Lookup" />
                  <Tab label="Benchmark" />
                </Tabs>
              </Box>

              <Box sx={{ 
                flex: 1, 
                display: 'flex',
                width: '100%',
                overflow: 'hidden'
              }}>
                <Box sx={{ 
                  flex: 1,
                  width: '100%',
                  position: 'relative',
                  overflow: 'hidden'
                }}>
                  {activeTab === 0 ? (
                    <Suspense fallback={<div>Loading...</div>}>
                      <AuthModelTab 
                        storeId={selectedStoreId}
                        storeName={selectedStoreName}
                        initialModel={authModel}
                        onModelUpdate={setAuthModel}
                      />
                    </Suspense>
                  ) : activeTab === 1 ? (
                    <Suspense fallback={<div>Loading...</div>}>
                      <TuplesTab 
                        storeId={selectedStoreId} 
                        currentModel={authModel}
                        authModelId={authModelId}
                      />
                    </Suspense>
                  ) : activeTab === QUERY_TAB_INDEX ? (
                    <Suspense fallback={<div>Loading...</div>}>
                      <QueryTab
                        storeId={selectedStoreId}
                        currentModel={authModel}
                        authModelId={authModelId}
                        pendingPrefill={pendingQueryPrefill}
                        onPrefillConsumed={handleQueryPrefillConsumed}
                      />
                    </Suspense>
                  ) : activeTab === LOOKUP_TAB_INDEX ? (
                    <Suspense fallback={<div>Loading...</div>}>
                      <LookupTab
                        storeId={selectedStoreId}
                        currentModel={authModel}
                        authModelId={authModelId}
                        onCheckTupleInQueryTab={handleCheckTupleInQueryTab}
                      />
                    </Suspense>
                  ) : activeTab === BENCHMARK_TAB_INDEX ? (
                    <Suspense fallback={<div>Loading...</div>}>
                      <BenchmarkTab
                        storeId={selectedStoreId}
                        currentModel={authModel}
                        authModelId={authModelId}
                      />
                    </Suspense>
                  ) : null}
                </Box>
              </Box>
            </Box>
          )}
        </Box>
    </TokenProvider>
  );
}

export default App;
