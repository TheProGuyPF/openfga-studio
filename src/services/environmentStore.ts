// Module-level source of truth for the active environment.
//
// Non-React services (OpenFGAService, TokenService) read the current env
// synchronously via getCurrentEnvironment(); the React layer mirrors it and
// drives switches through the EnvironmentProvider. Initialized synchronously
// from localStorage so the very first request already targets the right env.

import {
  environments,
  DEFAULT_ENV_KEY,
  isEnvKey,
  type EnvKey,
  type Environment,
} from '../environments';

const STORAGE_KEY = 'openfga-studio.environment';

function readInitial(): EnvKey {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isEnvKey(saved)) return saved;
  } catch {
    // localStorage may be unavailable (private mode / SSR) — fall back to default.
  }
  return DEFAULT_ENV_KEY;
}

let currentKey: EnvKey = readInitial();

type Listener = (key: EnvKey) => void;
const listeners = new Set<Listener>();

export function getCurrentEnvKey(): EnvKey {
  return currentKey;
}

export function getCurrentEnvironment(): Environment {
  return environments[currentKey];
}

export function setCurrentEnvKey(key: EnvKey): void {
  if (key === currentKey) return;
  currentKey = key;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Persistence is best-effort.
  }
  listeners.forEach((listener) => listener(key));
}

export function subscribeEnv(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
