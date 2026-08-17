// Multi-environment definitions.
//
// This map holds only NON-SECRET structure and values. The per-env X2S minting
// credentials never appear here (or anywhere in the client bundle) — they live
// server-side in the proxy, which injects the Basic auth header when forwarding
// the same-origin `tokenServiceRoute` to the real token service.
//
// The non-secret per-env values (OpenFGA URL, audience, default store id) are
// sourced from VITE_*_<ENV> env vars rather than hardcoded, so the public repo
// never carries production infrastructure details.

export type EnvKey = 'npe-xus' | 'can-us' | 'xus' | 'xeu';

/**
 * Criticality tier. Drives both guard behavior (confirm-on-switch + banner for
 * anything above `nonprod`) and the visual style (see ENV_TIER_STYLE).
 */
export type EnvTier = 'nonprod' | 'canary' | 'prod';

export interface Environment {
  key: EnvKey;
  label: string;
  /** OpenFGA HTTP API base URL. Called directly (cross-origin) — the env must allow CORS from the studio origin. */
  apiUrl: string;
  /** Optional store to auto-select when this env becomes active. */
  storeId: string;
  /** Audience sent in the token-service request body. */
  tokenServiceAudience: string;
  /** Same-origin proxy route; the proxy injects the X2S Basic auth for this env. */
  tokenServiceRoute: string;
  /** Criticality tier — determines guarding and chip/banner color. */
  tier: EnvTier;
}

/** Chip label + MUI palette color per tier. `nonprod` gets no chip/banner. */
export const ENV_TIER_STYLE: Record<EnvTier, { chipLabel: string; color: 'error' | 'info' } | null> = {
  nonprod: null,
  canary: { chipLabel: 'CANARY', color: 'info' }, // MUI 'info' = blue
  prod: { chipLabel: 'PROD', color: 'error' }, // MUI 'error' = red
};

/** Guarded envs (canary + prod) get a persistent banner and confirm-on-switch. */
export function isGuarded(env: Environment): boolean {
  return env.tier !== 'nonprod';
}

const env = import.meta.env;

export const environments: Record<EnvKey, Environment> = {
  'npe-xus': {
    key: 'npe-xus',
    label: 'NPE-XUS',
    // NPE url is already public (see .env.example); keep a sensible default.
    apiUrl: env.VITE_OPENFGA_API_URL_NPE_XUS || 'https://openfga-mx.npe.moodys.cloud',
    storeId: env.VITE_OPENFGA_STORE_ID_NPE_XUS || '',
    tokenServiceAudience: env.VITE_TOKEN_SERVICE_AUDIENCE_NPE_XUS || 'openfga-mx',
    tokenServiceRoute: '/token-service/npe-xus',
    tier: 'nonprod',
  },
  'can-us': {
    key: 'can-us',
    label: 'Canary (Can-US)',
    apiUrl: env.VITE_OPENFGA_API_URL_CAN_US || '',
    storeId: env.VITE_OPENFGA_STORE_ID_CAN_US || '',
    tokenServiceAudience: env.VITE_TOKEN_SERVICE_AUDIENCE_CAN_US || '',
    tokenServiceRoute: '/token-service/can-us',
    tier: 'canary',
  },
  xus: {
    key: 'xus',
    label: 'Production XUS',
    apiUrl: env.VITE_OPENFGA_API_URL_XUS || '',
    storeId: env.VITE_OPENFGA_STORE_ID_XUS || '',
    tokenServiceAudience: env.VITE_TOKEN_SERVICE_AUDIENCE_XUS || '',
    tokenServiceRoute: '/token-service/xus',
    tier: 'prod',
  },
  xeu: {
    key: 'xeu',
    label: 'Production XEU',
    apiUrl: env.VITE_OPENFGA_API_URL_XEU || '',
    storeId: env.VITE_OPENFGA_STORE_ID_XEU || '',
    tokenServiceAudience: env.VITE_TOKEN_SERVICE_AUDIENCE_XEU || '',
    tokenServiceRoute: '/token-service/xeu',
    tier: 'prod',
  },
};

/** Display / selection order. */
export const ENV_ORDER: EnvKey[] = ['npe-xus', 'can-us', 'xus', 'xeu'];

/** Safe default on first load (non-prod). */
export const DEFAULT_ENV_KEY: EnvKey = 'npe-xus';

export function isEnvKey(value: string | null | undefined): value is EnvKey {
  return !!value && value in environments;
}

/** An env is usable only if its OpenFGA URL is configured. */
export function isEnvConfigured(env: Environment): boolean {
  return !!env.apiUrl;
}
