// Tracks unsaved work across the app so we can warn before actions that would
// discard it (page unload, environment switch, tab switch). Components register
// a dirty flag under a stable key; the registry lives above the per-env workspace
// remount boundary so an env switch can consult it before remounting.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

interface DirtyStateContextValue {
  setDirty: (key: string, dirty: boolean) => void;
  isAnyDirty: () => boolean;
}

const DirtyStateContext = createContext<DirtyStateContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useDirtyState(): DirtyStateContextValue {
  const ctx = useContext(DirtyStateContext);
  if (!ctx) throw new Error('useDirtyState must be used within a DirtyStateProvider');
  return ctx;
}

/** Register (and auto-clear on unmount) a dirty flag under `key`. */
// eslint-disable-next-line react-refresh/only-export-components
export function useRegisterDirty(key: string, dirty: boolean): void {
  const { setDirty } = useDirtyState();
  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [key, dirty, setDirty]);
}

export function DirtyStateProvider({ children }: { children: ReactNode }) {
  const dirtyKeys = useRef<Set<string>>(new Set());

  const setDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) dirtyKeys.current.add(key);
    else dirtyKeys.current.delete(key);
  }, []);

  const isAnyDirty = useCallback(() => dirtyKeys.current.size > 0, []);

  // Native "you have unsaved changes" prompt on refresh / close.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isAnyDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isAnyDirty]);

  const value = useMemo(() => ({ setDirty, isAnyDirty }), [setDirty, isAnyDirty]);

  return <DirtyStateContext.Provider value={value}>{children}</DirtyStateContext.Provider>;
}
