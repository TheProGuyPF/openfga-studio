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
import { isEnvConfigured, type EnvKey } from '../../environments';

function ProdChip() {
  return <Chip label="PROD" size="small" color="error" sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />;
}

export function EnvSelect() {
  const { currentEnvKey, environments, switchEnv } = useEnvironment();
  const [pendingKey, setPendingKey] = useState<EnvKey | null>(null);

  const request = (key: EnvKey) => {
    if (key === currentEnvKey) return;
    const target = environments.find((e) => e.key === key);
    if (!target) return;
    // Guarded (prod / canary) envs require explicit confirmation before switching in.
    if (target.guarded) {
      setPendingKey(key);
    } else {
      switchEnv(key);
    }
  };

  const pendingEnv = environments.find((e) => e.key === pendingKey) ?? null;

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
                {env.guarded && <ProdChip />}
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
                  {env.guarded && <ProdChip />}
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
          <DialogContentText>
            You are about to connect to <strong>{pendingEnv?.label}</strong>, a protected environment.
            Writing tuples, saving authorization models, and creating stores here affect real data.
            Continue?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingKey(null)}>Cancel</Button>
          <Button
            color="error"
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
