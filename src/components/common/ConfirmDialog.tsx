import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  FormControlLabel,
  Checkbox,
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [checked, setChecked] = useState(false);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      // Reset the checkbox each time the dialog opens.
      TransitionProps={{ onEnter: () => setChecked(false) }}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{message}</DialogContentText>
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
        <Button onClick={() => onConfirm(checked)} variant="contained" color={confirmColor}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
