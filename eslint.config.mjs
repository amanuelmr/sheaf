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
          allowDefaultProject: ['*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
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
    // The purity rules above only apply to the pure core; app + adapters may read clocks.
    files: ['packages/paperless/**', 'packages/sim/**', 'apps/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // The app is its own TypeScript project (Expo's base config, JSX, RN types).
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    // projectService finds apps/mobile/tsconfig.json on its own; overriding it
    // here only fights with the root setting.
    rules: {
      // React components legitimately return unions the compiler cannot narrow.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
