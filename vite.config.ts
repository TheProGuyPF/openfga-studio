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

  if (env.VITE_TOKEN_SERVICE_URL) {
    const url = new URL(env.VITE_TOKEN_SERVICE_URL);
    proxy["/token-service"] = {
      target: url.origin,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/token-service/, url.pathname),
    };
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
