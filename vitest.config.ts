import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sheaf/core': pkg('core'),
      '@sheaf/paperless': pkg('paperless'),
      '@sheaf/sim': pkg('sim'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**', 'packages/paperless/src/**'],
      // Type declarations and re-export barrels carry no logic to cover.
      exclude: ['**/events.ts', '**/types.ts', '**/index.ts'],
      thresholds: {
        // The sync core is the part that must not be wrong. Keep the bar high here.
        'packages/core/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
