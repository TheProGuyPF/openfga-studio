import { useState } from 'react';
import {
  Select,
  MenuItem,
  FormControl,
  Chip,
  Box,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from '@mui/material';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { useDirtyState } from '../../contexts/DirtyStateContext';
import {
  isEnvConfigured,
  isGuarded,
  ENV_TIER_STYLE,
  type Environment,
  type EnvKey,
} from '../../environments';

/** Colored criticality chip (blue CANARY / red PROD); nothing for non-prod. */
function TierChip({ env }: { env: Environment }) {
  const style = ENV_TIER_STYLE[env.tier];
  if (!style) return null;
  return (
    <Chip
      label={style.chipLabel}
      size="small"
      color={style.color}
      sx={{ height: 18, fontSize: 10, fontWeight: 700 }}
    />
  );
}

export function EnvSelect() {
  const { currentEnvKey, environments, switchEnv } = useEnvironment();
  const { isAnyDirty } = useDirtyState();
  const [pendingKey, setPendingKey] = useState<EnvKey | null>(null);

  const request = (key: EnvKey) => {
    if (key === currentEnvKey) return;
    const target = environments.find((e) => e.key === key);
    if (!target) return;
    // Confirm before switching into a guarded (prod/canary) env, OR whenever there
    // is unsaved work that the remount would discard.
    if (isGuarded(target) || isAnyDirty()) {
      setPendingKey(key);
    } else {
      switchEnv(key);
    }
  };

  const pendingEnv = environments.find((e) => e.key === pendingKey) ?? null;
  const pendingColor = pendingEnv ? ENV_TIER_STYLE[pendingEnv.tier]?.color ?? 'error' : 'error';
  const pendingGuarded = pendingEnv ? isGuarded(pendingEnv) : false;
  const pendingDirty = pendingEnv ? isAnyDirty() : false;

  return (
    <>
      <FormControl size="small" sx={{ minWidth: 190 }}>
        <Select
          value={currentEnvKey}
          onChange={(e) => request(e.target.value as EnvKey)}
          renderValue={(key) => {
            const env = environments.find((x) => x.key === key);
            if (!env) return key;
            return (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <TierChip env={env} />
                <span>{env.label}</span>
              </Box>
            );
          }}
        >
          {environments.map((env) => {
            const configured = isEnvConfigured(env);
            return (
              <MenuItem key={env.key} value={env.key} disabled={!configured}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                  <TierChip env={env} />
                  <span>{env.label}</span>
                  {!configured && (
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                      not configured
                    </Typography>
                  )}
                </Box>
              </MenuItem>
            );
          })}
        </Select>
      </FormControl>

      <Dialog open={Boolean(pendingEnv)} onClose={() => setPendingKey(null)}>
        <DialogTitle>Switch to {pendingEnv?.label}?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {pendingGuarded && (
              <>
                You are about to connect to <strong>{pendingEnv?.label}</strong>, a protected
                environment. Writing tuples, saving authorization models, and creating stores here
                affect real data.
              </>
            )}
            {pendingDirty && (
              <Box sx={{ mt: pendingGuarded ? 1 : 0 }}>
                <strong>You have unsaved changes</strong> that will be discarded when the workspace
                reloads for the new environment.
              </Box>
            )}
            {' '}Continue?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingKey(null)}>Cancel</Button>
          <Button
            color={pendingColor}
            variant="contained"
            onClick={() => {
              if (pendingKey) switchEnv(pendingKey);
              setPendingKey(null);
            }}
          >
            Switch to {pendingEnv?.label}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
