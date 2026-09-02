import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * A separate config rather than folding this into vitest.config.ts's `include`:
 * these tests need a real Paperless-ngx reachable over the network and can take
 * minutes, which `pnpm test` must never depend on. See
 * packages/paperless/test/contract/run.sh, the only thing that invokes this.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@sheaf/core': pkg('core'),
      '@sheaf/http': pkg('http'),
      '@sheaf/paperless': pkg('paperless'),
    },
  },
  test: {
    include: ['packages/paperless/test/contract/**/*.test.ts'],
    // Consuming a document is a real OCR/classification pipeline, not a mock
    // answering instantly -- minutes, not milliseconds, is the honest budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
