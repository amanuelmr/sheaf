import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Imported straight from source, the same as every test config in this
// monorepo does -- there is no reason for this package to have its own build
// step just to be importable.
const protocol = fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sheaf/protocol': protocol,
    },
  },
});
