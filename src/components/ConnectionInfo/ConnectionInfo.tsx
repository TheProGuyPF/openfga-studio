import { useState, useCallback, MouseEvent } from 'react';
import {
  IconButton,
  Popover,
  Box,
  Typography,
  Tooltip,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { config } from '../../config';

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
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);

  const handleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);

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
        <InfoRow label="API URL" value={config.apiUrl} />
        <InfoRow label="Store Name" value={storeName} />
        <InfoRow label="Store ID" value={storeId} />
        <InfoRow label="Authorization Model ID" value={authModelId} />
      </Popover>
    </>
  );
};
