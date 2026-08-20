import { useCallback, useEffect, useState } from 'react';
import { useEnvironment } from '../contexts/EnvironmentContext';
import {
  getHistory,
  subscribeHistory,
  deleteHistoryEntry,
  clearHistory,
  migrateLegacyQueries,
  type HistoryEntry,
} from '../services/historyStore';

/**
 * React view over the persisted history for the current environment + a store.
 * Migrates legacy query history on first mount for the store.
 */
export function useHistory(storeId: string): {
  entries: HistoryEntry[];
  remove: (id: string) => void;
  clear: () => void;
} {
  const { currentEnvKey } = useEnvironment();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    if (!storeId) {
      setEntries([]);
      return;
    }
    migrateLegacyQueries(currentEnvKey, storeId);
    const refresh = () => setEntries(getHistory(currentEnvKey, storeId));
    refresh();
    return subscribeHistory(refresh);
  }, [currentEnvKey, storeId]);

  const remove = useCallback(
    (id: string) => deleteHistoryEntry(currentEnvKey, storeId, id),
    [currentEnvKey, storeId],
  );
  const clear = useCallback(() => clearHistory(currentEnvKey, storeId), [currentEnvKey, storeId]);

  return { entries, remove, clear };
}
