import { Box, Typography } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useEnvironment } from '../../contexts/EnvironmentContext';

/** A persistent, unmissable banner shown whenever a guarded (prod/canary) env is active. */
export function ProdBanner() {
  const { environment } = useEnvironment();
  if (!environment.guarded) return null;

  return (
    <Box
      sx={{
        bgcolor: 'error.main',
        color: 'error.contrastText',
        px: 2,
        py: 0.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
      }}
    >
      <WarningAmberIcon fontSize="small" />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {environment.label} — protected environment. Changes affect real data.
      </Typography>
    </Box>
  );
}
