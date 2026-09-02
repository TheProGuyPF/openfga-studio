import { useRef, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  TextField,
  Chip,
  Stack,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { SectionAccordion } from './SectionAccordion';

interface SourcePickerProps {
  csvText: string;
  onCsvChange: (text: string, name?: string) => void;
  csvName: string;
  headers: string[];
  rows: Record<string, string>[];
}

/** Step 1 — Source: upload / drag-drop / paste a raw CSV; show columns + a sample. */
export function SourcePicker({ csvText, onCsvChange, csvName, headers, rows }: SourcePickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => onCsvChange(String(reader.result ?? ''), file.name);
    reader.readAsText(file);
  };

  const sample = rows.slice(0, 5);

  return (
    <SectionAccordion
      title="1. Source CSV"
      defaultExpanded
      summary={
        rows.length > 0 ? (
          <Chip
            size="small"
            variant="outlined"
            label={`${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} · ${headers.length} col${headers.length === 1 ? '' : 's'}`}
          />
        ) : undefined
      }
    >
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap">
        <Button
          variant="outlined"
          startIcon={<UploadFileIcon />}
          onClick={() => fileRef.current?.click()}
        >
          Upload CSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) readFile(file);
            e.target.value = '';
          }}
        />
        {csvName && <Chip label={csvName} size="small" onDelete={() => onCsvChange('', '')} />}
        {rows.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'} · {headers.length} column
            {headers.length === 1 ? '' : 's'}
          </Typography>
        )}
      </Stack>

      <Box
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) readFile(file);
        }}
        sx={{
          border: '1px dashed',
          borderColor: dragOver ? 'primary.main' : 'divider',
          borderRadius: 1,
          p: 1,
          mb: 1,
          bgcolor: dragOver ? 'action.hover' : 'transparent',
        }}
      >
        <TextField
          fullWidth
          multiline
          minRows={4}
          maxRows={10}
          placeholder="Paste CSV here, or drag a file onto this box (RFC-4180: quoted fields may contain commas/newlines)."
          value={csvText}
          onChange={(e) => onCsvChange(e.target.value, csvName)}
          slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
        />
      </Box>

      {headers.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          {headers.map((h) => (
            <Chip key={h} label={h} size="small" variant="outlined" />
          ))}
        </Stack>
      )}

      {sample.length > 0 && (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {headers.map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {h}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {sample.map((row, i) => (
                <TableRow key={i}>
                  {headers.map((h) => (
                    <TableCell key={h} sx={{ whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row[h]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </SectionAccordion>
  );
}
