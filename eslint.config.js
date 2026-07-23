import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      'eslint.config.js',
      'scripts/**',
      'bin/**',
      'docs/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
    },
  },

  // Layer boundaries: core <- api <- mcp <- tools (enforced at lint time).
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/mcp/**', '**/tools/**'],
              message: 'core is Layer 0 — it must not import from api/mcp/tools.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/mcp/**', '**/tools/**'],
              message: 'api is Layer 1 — it must not import from mcp/tools.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/http*', '**/core/host*'],
              message:
                'tools must not import core/http|host directly — every network call goes through the api/ layer.',
            },
          ],
        },
      ],
    },
  },

  // Test helpers stub globals (fetch/Response) and need loose typing.
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      // node:test `test()` returns a promise callers intentionally don't await.
      '@typescript-eslint/no-floating-promises': 'off',
      // Mock `IgRequestFn` seams are typed `=> Promise<T>` and written `async`
      // for readability even when they have no internal `await`.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  prettier,
);
