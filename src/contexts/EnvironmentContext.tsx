import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { ENV_ORDER, environments, type EnvKey, type Environment } from '../environments';
import { getCurrentEnvKey, setCurrentEnvKey } from '../services/environmentStore';
import { setApiToken } from '../services/tokenStore';

interface EnvironmentContextValue {
  currentEnvKey: EnvKey;
  environment: Environment;
  /** All environments, in display order. */
  environments: Environment[];
  switchEnv: (key: EnvKey) => void;
}

const EnvironmentContext = createContext<EnvironmentContextValue | null>(null);

export function useEnvironment(): EnvironmentContextValue {
  const ctx = useContext(EnvironmentContext);
  if (!ctx) {
    throw new Error('useEnvironment must be used within an EnvironmentProvider');
  }
  return ctx;
}

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const [currentEnvKey, setKey] = useState<EnvKey>(getCurrentEnvKey());

  const switchEnv = useCallback(
    (key: EnvKey) => {
      if (key === currentEnvKey) return;
      // Drop any token from the previous env so the new env re-authenticates.
      setApiToken(null);
      // Update the module store first (services read from it synchronously)...
      setCurrentEnvKey(key);
      // ...then the React state, which remounts the keyed workspace and resets
      // all store/model/tuple/query state for the new env.
      setKey(key);
    },
    [currentEnvKey],
  );

  const value: EnvironmentContextValue = {
    currentEnvKey,
    environment: environments[currentEnvKey],
    environments: ENV_ORDER.map((k) => environments[k]),
    switchEnv,
  };

  return <EnvironmentContext.Provider value={value}>{children}</EnvironmentContext.Provider>;
}
