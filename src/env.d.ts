/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Optional, env-agnostic manual token override (lowest priority in tokenStore).
  readonly VITE_OPENFGA_API_TOKEN?: string

  // Per-environment NON-SECRET values. Safe to inline into the client bundle.
  // (The per-env X2S secrets are NOT here — they live server-side in the proxy.)
  readonly VITE_OPENFGA_API_URL_NPE_XUS?: string
  readonly VITE_OPENFGA_STORE_ID_NPE_XUS?: string
  readonly VITE_TOKEN_SERVICE_AUDIENCE_NPE_XUS?: string

  readonly VITE_OPENFGA_API_URL_CAN_US?: string
  readonly VITE_OPENFGA_STORE_ID_CAN_US?: string
  readonly VITE_TOKEN_SERVICE_AUDIENCE_CAN_US?: string

  readonly VITE_OPENFGA_API_URL_XUS?: string
  readonly VITE_OPENFGA_STORE_ID_XUS?: string
  readonly VITE_TOKEN_SERVICE_AUDIENCE_XUS?: string

  readonly VITE_OPENFGA_API_URL_XEU?: string
  readonly VITE_OPENFGA_STORE_ID_XEU?: string
  readonly VITE_TOKEN_SERVICE_AUDIENCE_XEU?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
