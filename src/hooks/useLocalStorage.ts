import { useCallback, useEffect, useState } from 'react';

/**
 * Persisted state backed by localStorage. Safe against unavailable storage
 * (private mode / SSR) and kept in sync across tabs via the `storage` event.
 * `initialValue` may be a factory (read once on mount).
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T | (() => T),
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // localStorage unavailable or malformed — fall back to the initial value.
    }
    return initialValue instanceof Function ? (initialValue as () => T)() : initialValue;
  });

  const setStored = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = next instanceof Function ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Persistence is best-effort.
        }
        return resolved;
      });
    },
    [key],
  );

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          setValue(JSON.parse(e.newValue) as T);
        } catch {
          // ignore malformed cross-tab writes
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  return [value, setStored];
}
