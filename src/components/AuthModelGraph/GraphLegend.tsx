import { Box, useTheme } from '@mui/material';

interface LegendItem {
  label: string;
  color: string;
  shape: 'node' | 'line' | 'dashed';
}

const NODE_ITEMS: LegendItem[] = [
  { label: 'Type', color: '#7c5cff', shape: 'node' },
  { label: 'Relation', color: '#31c48d', shape: 'node' },
];

const EDGE_ITEMS: LegendItem[] = [
  { label: 'Computed', color: '#31c48d', shape: 'line' },
  { label: 'From (tuple-to-userset)', color: '#ff9800', shape: 'dashed' },
  { label: 'Direct', color: '#2684ff', shape: 'line' },
];

export function GraphLegend() {
  const theme = useTheme();
  return (
    <Box
      sx={{
        px: 1.5,
        py: 1,
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1.5,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1.5,
        fontSize: 12,
        color: 'text.secondary',
        boxShadow: 1,
      }}
    >
      {[...NODE_ITEMS, ...EDGE_ITEMS].map((item) => (
        <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          {item.shape === 'node' ? (
            <Box
              sx={{
                width: 14,
                height: 14,
                borderRadius: '4px',
                border: `2px solid ${item.color}`,
                bgcolor: `${item.color}22`,
              }}
            />
          ) : (
            <Box
              sx={{
                width: 18,
                height: 0,
                borderTop: `2px ${item.shape === 'dashed' ? 'dashed' : 'solid'} ${item.color}`,
              }}
            />
          )}
          <span>{item.label}</span>
        </Box>
      ))}
    </Box>
  );
}
