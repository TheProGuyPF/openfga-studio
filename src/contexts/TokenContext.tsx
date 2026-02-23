import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { isTokenServiceConfigured, fetchApiToken } from '../services/TokenService';

type TokenStatus = 'idle' | 'loading' | 'success' | 'error';

interface TokenContextValue {
  tokenStatus: TokenStatus;
  error: string | null;
  lastRefreshedAt: number | null;
  refresh: () => Promise<void>;
  isConfigured: boolean;
}

const TokenContext = createContext<TokenContextValue>({
  tokenStatus: 'idle',
  error: null,
  lastRefreshedAt: null,
  refresh: async () => {},
  isConfigured: false,
});

export function useToken() {
  return useContext(TokenContext);
}

export function TokenProvider({ children }: { children: ReactNode }) {
  const configured = isTokenServiceConfigured();
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const scheduleRefresh = useCallback((intervalMs: number) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const result = await fetchApiToken();
        setTokenStatus('success');
        setError(null);
        setLastRefreshedAt(Date.now());
        scheduleRefresh(result.refreshIntervalMs);
      } catch (err) {
        setTokenStatus('error');
        setError(err instanceof Error ? err.message : 'Token refresh failed');
        scheduleRefresh(intervalMs);
      }
    }, intervalMs);
  }, []);

  const refresh = useCallback(async () => {
    if (!configured) return;
    setTokenStatus('loading');
    setError(null);
    try {
      const result = await fetchApiToken();
      setTokenStatus('success');
      setLastRefreshedAt(Date.now());
      clearTimeout(timerRef.current);
      scheduleRefresh(result.refreshIntervalMs);
    } catch (err) {
      setTokenStatus('error');
      setError(err instanceof Error ? err.message : 'Token refresh failed');
    }
  }, [configured, scheduleRefresh]);

  useEffect(() => {
    if (!configured) return;

    let cancelled = false;

    async function initialFetch() {
      setTokenStatus('loading');
      try {
        const result = await fetchApiToken();
        if (cancelled) return;
        setTokenStatus('success');
        setLastRefreshedAt(Date.now());
        scheduleRefresh(result.refreshIntervalMs);
      } catch (err) {
        if (cancelled) return;
        setTokenStatus('error');
        setError(err instanceof Error ? err.message : 'Initial token fetch failed');
      }
    }

    initialFetch();

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, [configured, scheduleRefresh]);

  return (
    <TokenContext.Provider value={{ tokenStatus, error, lastRefreshedAt, refresh, isConfigured: configured }}>
      {children}
    </TokenContext.Provider>
  );
}
