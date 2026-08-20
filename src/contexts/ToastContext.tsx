// App-wide toast/snackbar queue. Replaces per-component Snackbars over time
// (#13) — one message at a time, consistent placement, no overlap.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Snackbar, Alert, type AlertColor } from '@mui/material';

interface ToastItem {
  id: number;
  message: string;
  severity: AlertColor;
  duration: number;
}

interface ToastContextValue {
  toast: (message: string, severity?: AlertColor, opts?: { duration?: number }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ToastItem[]>([]);
  const [current, setCurrent] = useState<ToastItem | null>(null);
  const [open, setOpen] = useState(false);
  const idRef = useRef(0);

  const toast = useCallback<ToastContextValue['toast']>((message, severity = 'info', opts) => {
    const item: ToastItem = {
      id: ++idRef.current,
      message,
      severity,
      duration: opts?.duration ?? (severity === 'error' ? 8000 : 4000),
    };
    setQueue((q) => [...q, item]);
  }, []);

  // Dequeue the next toast once the current one has fully exited.
  useEffect(() => {
    if (!current && queue.length > 0) {
      setCurrent(queue[0]);
      setQueue((q) => q.slice(1));
      setOpen(true);
    }
  }, [current, queue]);

  const handleClose = (_e: unknown, reason?: string) => {
    if (reason === 'clickaway') return;
    setOpen(false);
  };

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Snackbar
        key={current?.id}
        open={open}
        autoHideDuration={current?.duration}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        TransitionProps={{ onExited: () => setCurrent(null) }}
      >
        {current ? (
          <Alert onClose={() => setOpen(false)} severity={current.severity} variant="filled" sx={{ width: '100%' }}>
            {current.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </ToastContext.Provider>
  );
}
