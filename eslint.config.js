import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '**/*.min.js']),
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      prettierConfig // must be last in extends
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        project: ['./tsconfig.dev.json']
      }
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    // `@interop/pws-sync/testing` is test fixtures: its fake server accepts
    // every write and serves a plausible changes feed, so a production import
    // would show a healthy sync status over a replica writing nothing to PWS.
    // Restated per file block, since flat config does not merge `rules`
    // options across blocks.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@interop/pws-sync/testing',
              message:
                'Test fixtures only. A production import would report a ' +
                'healthy sync over a replica writing nothing to PWS.'
            }
          ]
        }
      ]
    }
  },
  // The logging seam is a type-only devDependency (decision 0004 in the
  // @interop/logger repo): a value import would ship a runtime dependency
  // and, under link: dev setups, resolve to a second copy with its own
  // sink registry, silently splitting events away from the app's sinks.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@interop/logger'],
              allowTypeImports: true,
              message:
                'Only `import type` from @interop/logger in src/ -- the ' +
                'runtime port is src/log.ts (setLogger).'
            }
          ]
        }
      ]
    }
  }
])
