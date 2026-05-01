import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
  Snackbar,
  IconButton,
  Collapse,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { OpenFGAService } from '../../services/OpenFGAService';
import {
  extractRelationshipMetadata,
  type RelationshipMetadata,
} from '../../utils/tupleHelper';
import { EffectiveAccessForm } from './EffectiveAccessForm';
import { DirectTuplesForm } from './DirectTuplesForm';
import { LookupResults } from './LookupResults';
import type {
  LookupMode,
  EffectiveFormValues,
  DirectFormValues,
  EffectiveResult,
  DirectResult,
  PendingQueryPrefill,
  CrossModeActions,
} from './types';
import { DEFAULT_PAGE_SIZE, LOAD_ALL_CAP } from './types';

const BANNER_DISMISS_KEY = 'openfga-studio-lookup-banner-dismissed';

const EMPTY_EFFECTIVE: EffectiveFormValues = {
  userType: '',
  userName: '',
  relation: '',
  objectType: '',
  conditionState: null,
};

const EMPTY_DIRECT: DirectFormValues = {
  userType: '',
  userName: '',
  isUserset: false,
  usersetRelation: '',
  filterRelation: '',
  objectType: '',
  objectId: '',
};

interface LookupTabProps {
  storeId: string;
  currentModel?: string;
  authModelId: string;
  onCheckTupleInQueryTab: (prefill: PendingQueryPrefill) => void;
}

function parseObject(object: string): { type: string; id: string } {
  const idx = object.indexOf(':');
  if (idx === -1) return { type: object, id: '' };
  return { type: object.slice(0, idx), id: object.slice(idx + 1) };
}

function parseUser(
  user: string
): { type: string; id: string; relation?: string } | null {
  const hashIdx = user.indexOf('#');
  const colonIdx = user.indexOf(':');
  if (colonIdx === -1) return null;
  const type = user.slice(0, colonIdx);
  if (hashIdx === -1) {
    return { type, id: user.slice(colonIdx + 1) };
  }
  return {
    type,
    id: user.slice(colonIdx + 1, hashIdx),
    relation: user.slice(hashIdx + 1),
  };
}

export default function LookupTab({
  storeId,
  currentModel,
  authModelId,
  onCheckTupleInQueryTab,
}: LookupTabProps) {
  const [mode, setMode] = useState<LookupMode>('effective');
  const [metadata, setMetadata] = useState<RelationshipMetadata | undefined>();
  const [effectiveValues, setEffectiveValues] = useState<EffectiveFormValues>(
    EMPTY_EFFECTIVE
  );
  const [directValues, setDirectValues] = useState<DirectFormValues>(
    EMPTY_DIRECT
  );
  const [effectiveResult, setEffectiveResult] =
    useState<EffectiveResult | null>(null);
  const [directResult, setDirectResult] = useState<DirectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'info' });
  const [bannerOpen, setBannerOpen] = useState(() => {
    try {
      return sessionStorage.getItem(BANNER_DISMISS_KEY) !== '1';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (!currentModel) {
      setMetadata(undefined);
      return;
    }
    try {
      setMetadata(extractRelationshipMetadata(currentModel));
    } catch (err) {
      console.error('Failed to parse model in Lookup tab:', err);
      setMetadata(undefined);
    }
  }, [currentModel]);

  // Reset state when the store changes.
  useEffect(() => {
    setEffectiveValues(EMPTY_EFFECTIVE);
    setDirectValues(EMPTY_DIRECT);
    setEffectiveResult(null);
    setDirectResult(null);
    setError(null);
  }, [storeId]);

  const dismissBanner = () => {
    setBannerOpen(false);
    try {
      sessionStorage.setItem(BANNER_DISMISS_KEY, '1');
    } catch {
      // ignore storage errors
    }
  };

  const showSnack = (
    message: string,
    severity: 'success' | 'error' | 'info' = 'info'
  ) => setSnackbar({ open: true, message, severity });

  const handleEffectiveSubmit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const userId = `${effectiveValues.userType}:${effectiveValues.userName}`;
      const context: Record<string, string | number | boolean> | undefined =
        effectiveValues.conditionState
          ? effectiveValues.conditionState.context
          : undefined;

      const { objects } = await OpenFGAService.listObjects(storeId, {
        user: userId,
        relation: effectiveValues.relation,
        type: effectiveValues.objectType,
        context,
        authorizationModelId: authModelId || undefined,
      });

      setEffectiveResult({
        query: {
          user: userId,
          relation: effectiveValues.relation,
          objectType: effectiveValues.objectType,
        },
        objects,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to list objects';
      setError(message);
      setEffectiveResult(null);
      showSnack(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [effectiveValues, storeId, authModelId]);

  const buildDirectFilters = useCallback(() => {
    const filters: { user?: string; relation?: string; object?: string } = {};
    if (directValues.userType && directValues.userName) {
      const base = `${directValues.userType}:${directValues.userName}`;
      filters.user =
        directValues.isUserset && directValues.usersetRelation
          ? `${base}#${directValues.usersetRelation}`
          : base;
    }
    if (directValues.filterRelation) {
      filters.relation = directValues.filterRelation;
    }
    if (directValues.objectType) {
      filters.object = directValues.objectId
        ? `${directValues.objectType}:${directValues.objectId}`
        : `${directValues.objectType}:`;
    }
    return filters;
  }, [directValues]);

  const handleDirectSubmit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters = buildDirectFilters();
      const response = await OpenFGAService.readFiltered(storeId, {
        ...filters,
        page_size: DEFAULT_PAGE_SIZE,
      });
      setDirectResult({
        query: filters,
        tuples: response.tuples,
        continuationToken: response.continuation_token,
        totalLoaded: response.tuples.length,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to read tuples';
      setError(message);
      setDirectResult(null);
      showSnack(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [buildDirectFilters, storeId]);

  const handleLoadMore = useCallback(async () => {
    if (!directResult?.continuationToken) return;
    setLoadingMore(true);
    try {
      const response = await OpenFGAService.readFiltered(storeId, {
        ...directResult.query,
        page_size: DEFAULT_PAGE_SIZE,
        continuation_token: directResult.continuationToken,
      });
      setDirectResult({
        query: directResult.query,
        tuples: [...directResult.tuples, ...response.tuples],
        continuationToken: response.continuation_token,
        totalLoaded: directResult.totalLoaded + response.tuples.length,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load more tuples';
      showSnack(message, 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [directResult, storeId]);

  const handleLoadAll = useCallback(async () => {
    if (!directResult?.continuationToken) return;
    setLoadingAll(true);
    try {
      let token: string | undefined = directResult.continuationToken;
      let all = [...directResult.tuples];
      let capHit = false;
      while (token && all.length < LOAD_ALL_CAP) {
        const response = await OpenFGAService.readFiltered(storeId, {
          ...directResult.query,
          page_size: 100,
          continuation_token: token,
        });
        all = [...all, ...response.tuples];
        token = response.continuation_token;
        if (all.length >= LOAD_ALL_CAP && token) {
          capHit = true;
          break;
        }
      }
      setDirectResult({
        query: directResult.query,
        tuples: all,
        continuationToken: capHit ? token : undefined,
        totalLoaded: all.length,
      });
      if (capHit) {
        showSnack(
          `Stopped at ${LOAD_ALL_CAP.toLocaleString()} tuples — more remain. Refine filters to narrow results.`,
          'info'
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load all tuples';
      showSnack(message, 'error');
    } finally {
      setLoadingAll(false);
    }
  }, [directResult, storeId]);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => showSnack('Copied to clipboard', 'success'))
      .catch(() => showSnack('Failed to copy', 'error'));
  }, []);

  const crossMode = useMemo<CrossModeActions>(
    () => ({
      showDirectTuplesForObject: (object: string) => {
        const { type, id } = parseObject(object);
        setDirectValues({
          ...EMPTY_DIRECT,
          objectType: type,
          objectId: id,
        });
        setMode('direct');
        setDirectResult(null);
      },
      showEffectiveAccessForUser: (user: string) => {
        const parsed = parseUser(user);
        if (!parsed) {
          showSnack(`Cannot extract user from '${user}'`, 'error');
          return;
        }
        if (parsed.relation) {
          showSnack(
            'Effective access requires a concrete user, not a userset. Pre-filled the type and id only.',
            'info'
          );
        }
        setEffectiveValues({
          ...EMPTY_EFFECTIVE,
          userType: parsed.type,
          userName: parsed.id,
        });
        setMode('effective');
        setEffectiveResult(null);
      },
      checkTuple: (user, relation, object) => {
        onCheckTupleInQueryTab({ user, relation, object });
      },
    }),
    [onCheckTupleInQueryTab]
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box
        sx={{
          bgcolor: 'background.paper',
          p: 2,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="h6" fontSize={18} fontWeight="bold">
          Lookup Access
        </Typography>
      </Box>

      <Box sx={{ p: 2, flex: 1, overflow: 'auto' }}>
        <Collapse in={bannerOpen}>
          <Alert
            severity="info"
            sx={{ mb: 2 }}
            action={
              <IconButton
                size="small"
                color="inherit"
                onClick={dismissBanner}
                aria-label="Dismiss"
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            }
          >
            <Typography variant="body2">
              <strong>Effective access</strong> walks the authorization model
              and returns every object the user can reach (including via roles,
              parent relations, and conditions). <strong>Direct tuples</strong>{' '}
              shows only the literal tuples stored in this store — no model
              resolution.
            </Typography>
          </Alert>
        </Collapse>

        <Paper variant="outlined" sx={{ mb: 2, borderRadius: 1 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              px: 2,
              py: 1.5,
              borderBottom: 1,
              borderColor: 'divider',
              bgcolor: 'background.default',
              flexWrap: 'wrap',
            }}
          >
            <Typography fontSize={14}>Mode:</Typography>
            <ToggleButtonGroup
              value={mode}
              exclusive
              onChange={(_, newMode) => {
                if (newMode) {
                  setMode(newMode);
                  setError(null);
                }
              }}
              size="small"
              sx={{
                '& .MuiToggleButton-root': {
                  px: 2,
                  bgcolor: 'action.hover',
                  '&.Mui-selected': {
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    '&:hover': {
                      bgcolor: 'primary.dark',
                    },
                  },
                },
              }}
            >
              <ToggleButton
                value="effective"
                sx={{ textTransform: 'none', fontSize: 13 }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <Typography variant="body2" fontWeight={600}>
                    Effective access (list-objects)
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.85 }}>
                    What can this user reach?
                  </Typography>
                </Box>
              </ToggleButton>
              <ToggleButton
                value="direct"
                sx={{ textTransform: 'none', fontSize: 13 }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <Typography variant="body2" fontWeight={600}>
                    Direct tuples (read)
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.85 }}>
                    What tuples mention this user/object?
                  </Typography>
                </Box>
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Box sx={{ p: 3, bgcolor: 'background.paper' }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            {mode === 'effective' ? (
              <EffectiveAccessForm
                values={effectiveValues}
                onChange={setEffectiveValues}
                metadata={metadata}
                isSubmitting={loading}
                onSubmit={handleEffectiveSubmit}
              />
            ) : (
              <DirectTuplesForm
                values={directValues}
                onChange={setDirectValues}
                metadata={metadata}
                isSubmitting={loading}
                onSubmit={handleDirectSubmit}
              />
            )}
          </Box>
        </Paper>

        <LookupResults
          mode={mode}
          effective={effectiveResult}
          direct={directResult}
          loading={loading}
          loadingMore={loadingMore}
          loadingAll={loadingAll}
          crossMode={crossMode}
          onLoadMore={handleLoadMore}
          onLoadAll={handleLoadAll}
          onCopy={handleCopy}
        />

        <Snackbar
          open={snackbar.open}
          autoHideDuration={6000}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <Alert
            onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
            severity={snackbar.severity}
            variant="filled"
            sx={{ width: '100%' }}
          >
            {snackbar.message}
          </Alert>
        </Snackbar>
      </Box>
    </Box>
  );
}
