import { useState, useMemo, useCallback, Suspense, lazy } from 'react';
import { Box, CssBaseline, ThemeProvider, createTheme, Tabs, Tab } from '@mui/material';
import StorageIcon from '@mui/icons-material/Storage';
import { AppHeader } from './components/AppHeader/AppHeader';
import { ProdBanner } from './components/EnvSelect/ProdBanner';
import { LatencyDrawer } from './components/LatencyDrawer/LatencyDrawer';
import { TabLoader } from './components/common/TabLoader';
import { EmptyState } from './components/common/EmptyState';
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary';
import { OpenFGAService } from './services/OpenFGAService';
import { TokenProvider } from './contexts/TokenContext';
import { ToastProvider } from './contexts/ToastContext';
import { EnvironmentProvider, useEnvironment } from './contexts/EnvironmentContext';
import { DirtyStateProvider, useDirtyState } from './contexts/DirtyStateContext';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { useLocalStorage } from './hooks/useLocalStorage';
import { getSearchParam, setSearchParam } from './utils/urlState';
import type { PendingQueryPrefill } from './components/LookupTab/types';
import './App.css';

const prefersDark = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

// Tab index <-> URL name mapping for deep-linkable tabs.
const TAB_NAMES = ['model', 'tuples', 'query', 'lookup', 'benchmark'] as const;
function tabNameToIndex(name: string | null): number | null {
  if (!name) return null;
  const i = TAB_NAMES.indexOf(name as (typeof TAB_NAMES)[number]);
  return i >= 0 ? i : null;
}

const AuthModelTab = lazy(() => import('./components/AuthModelTab/AuthModelTab'));
const TuplesTab = lazy(() => import('./components/TuplesTab/TuplesTab'));
const QueryTab = lazy(() => import('./components/QueryTab/QueryTab'));
const LookupTab = lazy(() => import('./components/LookupTab/LookupTab'));
const BenchmarkTab = lazy(() => import('./components/BenchmarkTab/BenchmarkTab'));

const QUERY_TAB_INDEX = 2;
const LOOKUP_TAB_INDEX = 3;
const BENCHMARK_TAB_INDEX = 4;

function App() {
  // Persisted theme; first-run default honors the OS color scheme.
  const [mode, setMode] = useLocalStorage<'light' | 'dark'>('openfga-studio.theme', () =>
    prefersDark() ? 'dark' : 'light',
  );

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
    [setMode]
  );

  return (
    <EnvironmentProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <ToastProvider>
          <DirtyStateProvider>
            <AppShell onToggleTheme={toggleTheme} />
          </DirtyStateProvider>
        </ToastProvider>
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
  const { currentEnvKey } = useEnvironment();
  const { isAnyDirty } = useDirtyState();
  const tabStorageKey = `openfga-studio.activeTab.${currentEnvKey}`;
  const storeStorageKey = `openfga-studio.store.${currentEnvKey}`;

  // Initial tab/store: URL param wins, then per-env persisted value, then default.
  const [activeTab, setActiveTab] = useState<number>(() => {
    const fromUrl = tabNameToIndex(getSearchParam('tab'));
    if (fromUrl != null) return fromUrl;
    const persisted = Number(localStorage.getItem(tabStorageKey));
    return Number.isInteger(persisted) && persisted >= 0 && persisted < TAB_NAMES.length
      ? persisted
      : 0;
  });
  const [selectedStoreId, setSelectedStoreId] = useState<string>(
    () => getSearchParam('store') || localStorage.getItem(storeStorageKey) || '',
  );
  const [selectedStoreName, setSelectedStoreName] = useState('');
  const [authModel, setAuthModel] = useState('');
  const [authModelId, setAuthModelId] = useState('');
  const [pendingQueryPrefill, setPendingQueryPrefill] =
    useState<PendingQueryPrefill | null>(null);
  const [createStoreOpen, setCreateStoreOpen] = useState(false);
  const [pendingTab, setPendingTab] = useState<number | null>(null);

  const persistTab = useCallback(
    (idx: number) => {
      try {
        localStorage.setItem(tabStorageKey, String(idx));
      } catch {
        // best-effort
      }
      setSearchParam('tab', TAB_NAMES[idx]);
    },
    [tabStorageKey],
  );

  const applyTab = useCallback(
    (idx: number) => {
      setActiveTab(idx);
      persistTab(idx);
    },
    [persistTab],
  );

  const handleStoreChange = async (storeId: string, storeName: string) => {
    setSelectedStoreId(storeId);
    setSelectedStoreName(storeName);
    try {
      localStorage.setItem(storeStorageKey, storeId);
    } catch {
      // best-effort
    }
    setSearchParam('store', storeId);
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
    // Guard leaving the model editor with unsaved changes.
    if (activeTab === 0 && newValue !== 0 && isAnyDirty()) {
      setPendingTab(newValue);
      return;
    }
    applyTab(newValue);
  };

  const handleCheckTupleInQueryTab = useCallback(
    (prefill: PendingQueryPrefill) => {
      setPendingQueryPrefill(prefill);
      applyTab(QUERY_TAB_INDEX);
    },
    [applyTab]
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
          createStoreOpen={createStoreOpen}
          onCreateStoreOpenChange={setCreateStoreOpen}
        />

        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!selectedStoreId && (
            <EmptyState
              icon={<StorageIcon sx={{ fontSize: 56, opacity: 0.5 }} />}
              title="No store selected"
              description="Choose a store from the header to start modeling, writing tuples, and running checks — or create a new one."
              actionLabel="Create store"
              onAction={() => setCreateStoreOpen(true)}
            />
          )}
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
                  <ErrorBoundary
                    title="This tab hit an error"
                    resetKeys={[activeTab, selectedStoreId]}
                  >
                  {activeTab === 0 ? (
                    <Suspense fallback={<TabLoader />}>
                      <AuthModelTab 
                        storeId={selectedStoreId}
                        storeName={selectedStoreName}
                        initialModel={authModel}
                        onModelUpdate={setAuthModel}
                      />
                    </Suspense>
                  ) : activeTab === 1 ? (
                    <Suspense fallback={<TabLoader />}>
                      <TuplesTab 
                        storeId={selectedStoreId} 
                        currentModel={authModel}
                        authModelId={authModelId}
                      />
                    </Suspense>
                  ) : activeTab === QUERY_TAB_INDEX ? (
                    <Suspense fallback={<TabLoader />}>
                      <QueryTab
                        storeId={selectedStoreId}
                        currentModel={authModel}
                        authModelId={authModelId}
                        pendingPrefill={pendingQueryPrefill}
                        onPrefillConsumed={handleQueryPrefillConsumed}
                      />
                    </Suspense>
                  ) : activeTab === LOOKUP_TAB_INDEX ? (
                    <Suspense fallback={<TabLoader />}>
                      <LookupTab
                        storeId={selectedStoreId}
                        currentModel={authModel}
                        authModelId={authModelId}
                        onCheckTupleInQueryTab={handleCheckTupleInQueryTab}
                      />
                    </Suspense>
                  ) : activeTab === BENCHMARK_TAB_INDEX ? (
                    <Suspense fallback={<TabLoader />}>
                      <BenchmarkTab
                        storeId={selectedStoreId}
                        currentModel={authModel}
                        authModelId={authModelId}
                      />
                    </Suspense>
                  ) : null}
                  </ErrorBoundary>
                </Box>
              </Box>
            </Box>
          )}
        </Box>

        <ConfirmDialog
          open={pendingTab !== null}
          title="Discard unsaved changes?"
          message="You have unsaved changes in the authorization model. Leaving this tab will discard them."
          confirmLabel="Discard & switch"
          confirmColor="warning"
          onConfirm={() => {
            if (pendingTab !== null) applyTab(pendingTab);
            setPendingTab(null);
          }}
          onCancel={() => setPendingTab(null)}
        />
    </TokenProvider>
  );
}

export default App;
