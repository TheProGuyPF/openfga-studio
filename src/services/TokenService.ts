import axios from 'axios';
import { setApiToken } from './tokenStore';
import { getCurrentEnvironment } from './environmentStore';

const DEFAULT_REFRESH_INTERVAL_MS = 3600 * 1000; // 1 hour
const REFRESH_MARGIN_MS = 60 * 1000; // refresh 1 min before expiry

const tokenApi = axios.create({
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface TokenResponse {
  token: string;
  refreshIntervalMs: number;
}

export function isTokenServiceConfigured(): boolean {
  // Every environment authenticates via the token service; the client only
  // needs a proxy route (the proxy injects the X2S Basic auth server-side).
  return !!getCurrentEnvironment().tokenServiceRoute;
}

export async function fetchApiToken(): Promise<TokenResponse> {
  const env = getCurrentEnvironment();
  if (!env.tokenServiceRoute) {
    throw new Error('Token service is not configured for the current environment');
  }

  // No Authorization header here — the proxy injects `Basic <x2s>` for this env
  // so the minting credential never reaches the browser.
  const response = await tokenApi.post(
    env.tokenServiceRoute,
    { audience: env.tokenServiceAudience },
  );

  const data = response.data;
  const token: string | undefined = data.access_token ?? data.token;

  if (!token) {
    throw new Error('Token service response did not contain a token');
  }

  setApiToken(token);

  let refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
  if (typeof data.expires_in === 'number' && data.expires_in > 0) {
    refreshIntervalMs = Math.max(data.expires_in * 1000 - REFRESH_MARGIN_MS, 30_000);
  }

  return { token, refreshIntervalMs };
}

// Single-flight refresh: concurrent callers (startup burst, parallel 401 retries)
// share one in-flight fetch instead of stampeding the token service.
let inFlight: Promise<TokenResponse> | null = null;

export function getInFlight(): Promise<TokenResponse> | null {
  return inFlight;
}

export function refreshToken(): Promise<TokenResponse> {
  if (inFlight) {
    return inFlight;
  }
  inFlight = fetchApiToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
