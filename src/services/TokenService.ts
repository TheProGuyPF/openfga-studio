import axios from 'axios';
import { config } from '../config';
import { setApiToken } from './tokenStore';

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
  return !!(config.tokenServiceUrl && config.x2sToken);
}

export async function fetchApiToken(): Promise<TokenResponse> {
  if (!isTokenServiceConfigured()) {
    throw new Error('Token service is not configured');
  }

  const response = await tokenApi.post(
    '/token-service',
    { audience: config.tokenServiceAudience },
    {
      headers: {
        Authorization: `Basic ${config.x2sToken}`,
      },
    },
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
