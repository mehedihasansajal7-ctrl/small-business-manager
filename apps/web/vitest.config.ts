import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Only the pure offline / api logic is unit-tested here, so a plain `node`
 * environment is enough — no DOM, no jsdom dependency.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@sbm/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
  },
});
