import { useState, useCallback, useEffect, type MouseEvent } from 'react';
import {
  IconButton,
  Popover,
  Box,
  Typography,
  Tooltip,
  Chip,
  CircularProgress,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { OpenFGAService, type HealthStatus } from '../../services/OpenFGAService';

type HealthState = 'checking' | HealthStatus;

const HEALTH_DISPLAY: Record<HealthState, { label: string; color: 'success' | 'error' | 'default' }> = {
  checking: { label: 'Checking…', color: 'default' },
  serving: { label: 'Serving', color: 'success' },
  unhealthy: { label: 'Unhealthy', color: 'error' },
  unknown: { label: 'Unreachable', color: 'error' },
};

interface ConnectionInfoProps {
  storeId: string;
  storeName: string;
  authModelId: string;
}

interface InfoRowProps {
  label: string;
  value: string;
}

function InfoRow({ label, value }: InfoRowProps) {
  const [copied, setCopied] = useState(false);
  const hasValue = Boolean(value);

  const handleCopy = useCallback(async () => {
    if (!hasValue) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value, hasValue]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>
          {label}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            fontFamily: 'monospace',
            wordBreak: 'break-all',
            color: hasValue ? 'text.primary' : 'text.disabled',
          }}
        >
          {hasValue ? value : '—'}
        </Typography>
      </Box>
      <Tooltip title={copied ? 'Copied!' : 'Copy'} arrow>
        <span>
          <IconButton
            size="small"
            onClick={handleCopy}
            disabled={!hasValue}
            sx={{ flexShrink: 0 }}
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}

export const ConnectionInfo = ({ storeId, storeName, authModelId }: ConnectionInfoProps) => {
  const { environment } = useEnvironment();
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [health, setHealth] = useState<HealthState>('checking');

  const handleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);

  // Probe server health each time the popover opens.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setHealth('checking');
    OpenFGAService.getHealth(controller.signal).then((status) => {
      if (!controller.signal.aborted) setHealth(status);
    });
    return () => controller.abort();
  }, [open]);

  const healthDisplay = HEALTH_DISPLAY[health];

  return (
    <>
      <Tooltip title="Connection details">
        <IconButton onClick={handleOpen} color="inherit" size="small" sx={{ ml: 1 }}>
          <InfoOutlinedIcon />
        </IconButton>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: { p: 2, minWidth: 320, maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 1.5 },
          },
        }}
      >
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Connection Details</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            Server health
          </Typography>
          <Chip
            size="small"
            label={healthDisplay.label}
            color={healthDisplay.color}
            variant={health === 'serving' ? 'filled' : 'outlined'}
            icon={health === 'checking' ? <CircularProgress size={12} sx={{ ml: 0.5 }} /> : undefined}
            sx={{ fontWeight: 600 }}
          />
        </Box>
        <InfoRow label="Environment" value={environment.label} />
        <InfoRow label="API URL" value={environment.apiUrl} />
        <InfoRow label="Store Name" value={storeName} />
        <InfoRow label="Store ID" value={storeId} />
        <InfoRow label="Authorization Model ID" value={authModelId} />
      </Popover>
    </>
  );
};
