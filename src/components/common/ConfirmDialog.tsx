import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  FormControlLabel,
  Checkbox,
  TextField,
} from '@mui/material';
import { useState, type ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmColor?: 'primary' | 'error' | 'warning';
  /** When set, renders a checkbox (e.g. "Don't ask again"); its state is passed
   * to onConfirm. */
  checkboxLabel?: string;
  /** When set, the user must type this exact text (e.g. the store name) before
   * Confirm enables — an extra guard for high-consequence tiers. */
  requireTypedText?: string;
  onConfirm: (checkboxChecked: boolean) => void;
  onCancel: () => void;
}

/** Reusable confirm dialog for destructive / irreversible / expensive actions. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmColor = 'primary',
  checkboxLabel,
  requireTypedText,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');

  const typedOk = !requireTypedText || typed === requireTypedText;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      // Reset the checkbox + typed-confirm each time the dialog opens.
      TransitionProps={{ onEnter: () => { setChecked(false); setTyped(''); } }}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{message}</DialogContentText>
        {requireTypedText && (
          <TextField
            fullWidth
            size="small"
            sx={{ mt: 2 }}
            label={`Type "${requireTypedText}" to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        )}
        {checkboxLabel && (
          <FormControlLabel
            sx={{ mt: 1 }}
            control={<Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)} />}
            label={checkboxLabel}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button
          onClick={() => onConfirm(checked)}
          variant="contained"
          color={confirmColor}
          disabled={!typedOk}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
