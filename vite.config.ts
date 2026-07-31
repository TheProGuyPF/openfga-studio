import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const proxy: Record<string, object> = {
    "/api": {
      target: "https://openfga-mx.npe.moodys.cloud",
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ""),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    },
  };

  // Per-environment token-service routes. The X2S minting credential is read
  // from NON-VITE env vars (never inlined into the client bundle) and injected
  // as the Basic auth header server-side, so it never reaches the browser.
  const ENVS: { key: string; suffix: string }[] = [
    { key: "npe-xus", suffix: "NPE_XUS" },
    { key: "can-us", suffix: "CAN_US" },
    { key: "xus", suffix: "XUS" },
    { key: "xeu", suffix: "XEU" },
  ];
  for (const { key, suffix } of ENVS) {
    const upstream = env[`TOKEN_SERVICE_URL_${suffix}`];
    const x2s = env[`FGA_X2S_TOKEN_${suffix}`];
    if (upstream && x2s) {
      const url = new URL(upstream);
      proxy[`/token-service/${key}`] = {
        target: url.origin,
        changeOrigin: true,
        rewrite: () => url.pathname,
        headers: {
          Authorization: `Basic ${x2s}`,
        },
      };
    }
  }

  return {
    plugins: [react()],
    base: "./",
    server: { proxy },
    build: {
      outDir: "dist",
      assetsDir: "assets",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ["react", "react-dom", "reactflow", "axios", "html-to-image"],
          },
        },
      },
    },
  };
});
