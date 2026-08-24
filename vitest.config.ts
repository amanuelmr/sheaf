import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sheaf/core': pkg('core'),
      '@sheaf/engine': pkg('engine'),
      '@sheaf/http': pkg('http'),
      '@sheaf/client': pkg('client'),
      '@sheaf/paperless': pkg('paperless'),
      '@sheaf/pdf': pkg('pdf'),
      '@sheaf/protocol': pkg('protocol'),
      '@sheaf/store/node': fileURLToPath(new URL('./packages/store/src/node.ts', import.meta.url)),
      '@sheaf/ingest': fileURLToPath(new URL('./services/ingest/src/index.ts', import.meta.url)),
      '@sheaf/store': pkg('store'),
      '@sheaf/sim': pkg('sim'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      // The app's pure helpers. Anything importing react-native stays out.
      'apps/*/test/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/**',
        'packages/engine/src/**',
        'packages/paperless/src/**',
        'packages/pdf/src/**',
        'packages/protocol/src/**',
        'packages/client/src/**',
        'packages/http/src/**',
        'services/ingest/src/**',
        'packages/store/src/**',
      ],
      // Type declarations and re-export barrels carry no logic to cover.
      exclude: ['**/events.ts', '**/types.ts', '**/index.ts'],
      thresholds: {
        // The sync core is the part that must not be wrong. Keep the bar high here.
        'packages/core/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/engine/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/pdf/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
