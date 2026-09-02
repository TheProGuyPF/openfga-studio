import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { useTheme, Tooltip, Box, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

export interface CustomNodeData {
  kind: 'type' | 'relation';
  label: string;
  parentType?: string;
  dsl?: string;
  hasCondition?: boolean;
  /** Dimmed when another node is focused and this one isn't a neighbour. */
  dimmed?: boolean;
  /** Highlighted as the current focus / search hit. */
  focused?: boolean;
  // Type-node grouping
  relationCount?: number;
  collapsed?: boolean;
  // Relation-node chips (directly-assignable concrete/wildcard types)
  terminalChips?: string[];
  // Weighted-mode overlay
  weightLabel?: string;
  weightColor?: string;
  infinite?: boolean;
}

function palette(kind: 'type' | 'relation', dark: boolean) {
  if (kind === 'type') {
    return {
      bg: dark ? '#3b2d6b' : '#ede7ff',
      border: '#7c5cff',
      text: dark ? '#e9e2ff' : '#3a2b7a',
    };
  }
  return {
    bg: dark ? '#1f3d33' : '#e6f7ef',
    border: '#31c48d',
    text: dark ? '#c7f0dd' : '#1c6b4a',
  };
}

const MAX_CHIPS = 3;

export const CustomNode = memo(({ data }: NodeProps<CustomNodeData>) => {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const colors = palette(data.kind, dark);
  const weighted = Boolean(data.weightLabel);
  const isType = data.kind === 'type';

  const handleStyle = { opacity: 0, width: 1, height: 1, border: 'none' };

  const chips = data.terminalChips ?? [];
  const shownChips = chips.slice(0, MAX_CHIPS);
  const extraChips = chips.length - shownChips.length;

  const tooltip = isType
    ? `type ${data.label} — ${data.relationCount ?? 0} relation${data.relationCount === 1 ? '' : 's'} (click to ${data.collapsed ? 'expand' : 'collapse'})`
    : data.dsl
      ? `${data.parentType}#${data.label}: ${data.dsl}`
      : data.label;

  return (
    <Tooltip title={tooltip} arrow placement="top" enterDelay={250}>
      <Box
        sx={{
          px: isType ? 1.5 : 1.5,
          py: isType ? 1 : 0.75,
          borderRadius: isType ? '10px' : '999px',
          border: `2px solid ${weighted && data.weightColor ? data.weightColor : colors.border}`,
          background: colors.bg,
          color: colors.text,
          fontWeight: isType ? 700 : 500,
          fontSize: isType ? 14 : 13,
          minWidth: 60,
          maxWidth: 260,
          textAlign: 'center',
          opacity: data.dimmed ? 0.2 : 1,
          boxShadow: data.focused ? `0 0 0 3px ${theme.palette.warning.main}` : theme.shadows[2],
          transition: 'opacity 0.2s ease, box-shadow 0.2s ease',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0.4,
          cursor: isType ? 'pointer' : 'default',
        }}
      >
        <Handle type="target" position={Position.Left} style={handleStyle} isConnectable={false} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, justifyContent: 'center' }}>
          {isType &&
            (data.collapsed ? (
              <ChevronRightIcon sx={{ fontSize: 18 }} />
            ) : (
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            ))}
          {data.infinite && (
            <WarningAmberIcon sx={{ fontSize: 15, color: theme.palette.error.main }} />
          )}
          <Typography component="span" sx={{ fontSize: 'inherit', fontWeight: 'inherit', lineHeight: 1.2 }}>
            {data.label}
          </Typography>
          {isType && data.relationCount !== undefined && (
            <Box
              component="span"
              sx={{
                fontSize: 11,
                fontWeight: 700,
                px: 0.6,
                borderRadius: '10px',
                bgcolor: dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.1)',
              }}
            >
              {data.relationCount}
            </Box>
          )}
          {weighted && (
            <Box
              component="span"
              sx={{
                fontSize: 11,
                fontWeight: 700,
                px: 0.6,
                borderRadius: '6px',
                bgcolor: data.weightColor ?? theme.palette.action.selected,
                color: '#fff',
              }}
            >
              {data.weightLabel}
            </Box>
          )}
        </Box>

        {!isType && shownChips.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4, justifyContent: 'center' }}>
            {shownChips.map((c) => (
              <Box
                key={c}
                component="span"
                sx={{
                  fontSize: 10,
                  fontFamily: '"Roboto Mono", monospace',
                  px: 0.5,
                  borderRadius: '4px',
                  bgcolor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
                  color: theme.palette.text.secondary,
                }}
              >
                {c}
              </Box>
            ))}
            {extraChips > 0 && (
              <Box component="span" sx={{ fontSize: 10, color: theme.palette.text.disabled }}>
                +{extraChips}
              </Box>
            )}
          </Box>
        )}

        <Handle type="source" position={Position.Right} style={handleStyle} isConnectable={false} />
      </Box>
    </Tooltip>
  );
});

CustomNode.displayName = 'CustomNode';
