import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web app talks to the API through a same-origin `/api` path so the
 * `sbm_session` cookie is first-party. In dev, Vite proxies `/api` to the local
 * API server (default http://127.0.0.1:8787); in production the reverse proxy in
 * front of the container does the same job.
 *
 * `@sbm/domain` is aliased to the package SOURCE so the app builds without a
 * separate domain build step (dist/ is git-ignored).
 */
const domainSource = fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@sbm/domain': domainSource },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
