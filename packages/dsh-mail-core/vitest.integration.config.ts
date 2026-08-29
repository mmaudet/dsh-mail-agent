import { defineConfig } from 'vitest/config';

/**
 * Integration tests: real servers, real sockets, no mocks.
 *
 * Deliberately a second project rather than a tag, so `pnpm test` cannot reach
 * the network by accident. The unit suite's contract is that it never does.
 *
 *   bash test/integration/provision.sh
 *   pnpm --filter @dsh-mail-agent/mail-core test:integration
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.itest.ts'],
    // Sockets, container startup and IDLE round trips do not fit the unit
    // default, and a shared mailbox makes parallel files race each other.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
