import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.expo/**',
      '**/.sheaf-data/**',
      // CommonJS build config, outside any TypeScript project.
      'apps/*/babel.config.js',
      'apps/*/metro.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Not part of tsconfig.node.json's own project as far as projectService's
          // auto-discovery is concerned -- no project references wire the two
          // together -- so it falls back to the default project rather than going
          // unlinted, the same as the root's own *.mjs config files.
          allowDefaultProject: ['*.mjs', 'apps/admin/vite.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
  {
    // Purity is a requirement of the core specifically, not of the repo. Written as
    // "only here" rather than "everywhere except these", because the second form
    // silently exempts anything added later -- which is exactly what happened when
    // the ingest service arrived and inherited a rule meant for the core.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message:
            'packages/core must stay pure and deterministic: take `now` as a parameter instead of reading the clock.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'packages/core must stay pure and deterministic: take jitter/randomness as a parameter.',
        },
      ],
    },
  },
  {
    // Node executes this service by stripping types, which cannot handle any
    // TypeScript that emits code. Parameter properties are the easy one to reach
    // for and they fail at startup, not at build time -- so they are banned here
    // rather than rediscovered.
    files: ['services/**/*.ts'],
    rules: {
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
      '@typescript-eslint/no-namespace': 'error',
    },
  },
  {
    // The app is its own TypeScript project (Expo's base config, JSX, RN types).
    // projectService finds apps/mobile/tsconfig.json on its own.
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    rules: {
      // React components legitimately return unions the compiler cannot narrow.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: ['apps/admin/**/*.ts', 'apps/admin/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
