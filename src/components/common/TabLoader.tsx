import { Box, CircularProgress } from '@mui/material';

/** Centered themed spinner for lazy-tab Suspense fallbacks. */
export function TabLoader() {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        width: '100%',
        p: 4,
      }}
    >
      <CircularProgress />
    </Box>
  );
}
