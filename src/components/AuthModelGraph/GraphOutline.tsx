import { useMemo, useState } from 'react';
import {
  Box,
  Typography,
  useTheme,
  InputBase,
  IconButton,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import type { StructuredModel } from '../../utils/modelGraph';

interface GraphOutlineProps {
  model: StructuredModel;
  collapsed: Set<string>;
  onToggleType: (type: string) => void;
  onSelectType: (type: string) => void;
  onSelectRelation: (relationId: string) => void;
}

/** A scrollable type→relation tree for navigating large models. */
export function GraphOutline({
  model,
  collapsed,
  onToggleType,
  onSelectType,
  onSelectRelation,
}: GraphOutlineProps) {
  const theme = useTheme();
  const [query, setQuery] = useState('');

  const types = useMemo(() => {
    const q = query.trim().toLowerCase();
    return model.types
      .filter((t) => t.relations.length > 0)
      .map((t) => ({
        ...t,
        relations: q
          ? t.relations.filter(
              (r) => r.name.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
            )
          : t.relations,
      }))
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.relations.length > 0);
  }, [model.types, query]);

  return (
    <Box
      sx={{
        width: 260,
        maxHeight: 560,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1.5,
        boxShadow: 3,
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.25,
          py: 0.5,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <InputBase
          placeholder="Filter outline"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ fontSize: 13, flex: 1 }}
        />
      </Box>
      <Box sx={{ overflow: 'auto', py: 0.5 }}>
        {types.map((t) => {
          const isCollapsed = collapsed.has(t.name);
          const showRelations = !isCollapsed || query.trim().length > 0;
          return (
            <Box key={t.name}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 1,
                  py: 0.4,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
                onClick={() => onSelectType(t.name)}
              >
                <IconButton
                  size="small"
                  sx={{ p: 0.25 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleType(t.name);
                  }}
                >
                  {isCollapsed ? (
                    <ChevronRightIcon fontSize="small" />
                  ) : (
                    <ExpandMoreIcon fontSize="small" />
                  )}
                </IconButton>
                <Typography sx={{ fontSize: 13, fontWeight: 700 }} noWrap>
                  {t.name}
                </Typography>
                <Typography sx={{ fontSize: 11, color: 'text.disabled', ml: 'auto' }}>
                  {t.relations.length}
                </Typography>
              </Box>
              {showRelations &&
                t.relations.map((r) => (
                  <Box
                    key={r.id}
                    onClick={() => onSelectRelation(r.id)}
                    sx={{
                      pl: 4,
                      pr: 1,
                      py: 0.3,
                      cursor: 'pointer',
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                  >
                    <Typography
                      sx={{ fontSize: 12, fontFamily: '"Roboto Mono", monospace' }}
                      color="text.secondary"
                      noWrap
                    >
                      {r.name}
                    </Typography>
                  </Box>
                ))}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
