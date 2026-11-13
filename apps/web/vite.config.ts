import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './src/content-security-policy';

// Imported straight from source, the same as every test config in this
// monorepo does -- there is no reason for this package to have its own build
// step just to be importable.
const protocol = fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url));
const pdf = fileURLToPath(new URL('../../packages/pdf/src/index.ts', import.meta.url));

/** Built pages only: the dev server needs an inline script of its own. */
const contentSecurityPolicy: Plugin = {
  name: 'sheaf-content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
      injectTo: 'head-prepend',
    },
  ],
};

export default defineConfig({
  plugins: [react(), contentSecurityPolicy],
  resolve: {
    alias: {
      '@sheaf/protocol': protocol,
      '@sheaf/pdf': pdf,
    },
  },
});
