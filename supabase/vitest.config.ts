import { defineConfig } from 'vitest/config';

/**
 * Tests for the shared-cloud (PostgreSQL/Supabase) layer.
 *
 * There is no PostgreSQL server in this environment, so these tests do NOT
 * connect to a database. They read the migration/policy/seed SQL and assert the
 * invariants we care about (RLS coverage, tenant columns, exact numerics,
 * no plaintext invite codes, pinned search_path, idempotency keys, ...).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20_000,
  },
});
