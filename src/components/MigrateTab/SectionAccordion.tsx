import { type ReactNode } from 'react';
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Box,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface SectionAccordionProps {
  /** Section heading (e.g. "1. Source CSV"). */
  title: string;
  /** Whether the section starts open. */
  defaultExpanded?: boolean;
  /** Optional at-a-glance status shown on the right of the header, even when collapsed. */
  summary?: ReactNode;
  children: ReactNode;
}

/**
 * Collapsible section used to structure the Migrate tab so each step can be
 * folded away to reduce scrolling. Styled to read like the app's `Paper`
 * sections it replaces (headline + padded body).
 */
export function SectionAccordion({ title, defaultExpanded = true, summary, children }: SectionAccordionProps) {
  // The outer Box carries the parent Stack's inter-section spacing so the
  // accordion's own `Mui-expanded` margin reset can't collapse the gap on expand.
  return (
    <Box>
      <Accordion
        defaultExpanded={defaultExpanded}
        disableGutters
        sx={{
          borderRadius: 1,
          '&:before': { display: 'none' },
          '&.Mui-expanded': { margin: 0 },
        }}
      >
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          sx={{ '& .MuiAccordionSummary-content': { my: 1.25, alignItems: 'center' } }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', pr: 1 }}>
            <Typography variant="h6" sx={{ fontSize: '1.05rem' }}>
              {title}
            </Typography>
            <Box sx={{ flex: 1 }} />
            {summary}
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>{children}</AccordionDetails>
      </Accordion>
    </Box>
  );
}
