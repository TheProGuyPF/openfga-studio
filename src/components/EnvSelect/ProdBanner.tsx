import { Box, Typography } from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { ENV_TIER_STYLE } from '../../environments';

/**
 * A persistent, unmissable banner shown whenever a guarded env is active.
 * Colored by tier — red for production, blue for canary.
 */
export function ProdBanner() {
  const { environment } = useEnvironment();
  const style = ENV_TIER_STYLE[environment.tier];
  if (!style) return null;

  return (
    <Box
      sx={{
        bgcolor: `${style.color}.main`,
        color: `${style.color}.contrastText`,
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
