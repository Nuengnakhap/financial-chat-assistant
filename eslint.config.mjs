import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import localTokens from './tools/eslint/no-off-token-styles.mjs';
import local from './tools/eslint/todo-requires-issue.mjs';

/**
 * The conventions in AGENTS.md, expressed wherever a linter can express them.
 * Anything this file cannot enforce is deliberately not a convention.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'tools/architecture/fixtures/**', // exist to be broken; checked by their own test
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    plugins: { 'import-x': importX, local },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      // --- Type safety ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        // Branded ids and repository mappers are the only legitimate casts, and
        // each carries an inline disable saying why.
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // Every NestJS module is an empty class carrying a decorator.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a union of string literals: an enum emits runtime code and is not closed.',
        },
        {
          selector: 'TSTypeReference > TSQualifiedName[left.name="ts"]',
          message: 'Compiler-internal types do not belong in application code.',
        },
      ],

      // --- Async discipline ---
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      'no-await-in-loop': 'warn',

      // --- Size budgets ---
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-params': ['error', 3],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 40, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],

      // --- Hygiene ---
      'local/todo-requires-issue': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'prefer-const': 'error',
      'no-param-reassign': ['error', { props: true }],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [{ pattern: '@fca/**', group: 'internal', position: 'before' }],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-cycle': 'error',
      'import-x/no-duplicates': 'error',
    },
  },

  {
    // The browser client. `globals.node` above would let `process` and `Buffer`
    // typecheck in code that ships to a page, so the environment is replaced
    // rather than extended.
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
    plugins: { 'local-tokens': localTokens },
    rules: {
      // The design tokens are a closed set; this is what stops a value walking
      // around them. See apps/web/src/shared/ui/tokens.css.
      'local-tokens/no-off-token-styles': 'error',
      // The rule that catches a subscription, timer or AbortController with no
      // cleanup, and derived state recomputed in an effect — the two failure
      // modes AGENTS.md names for this package.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  {
    // A long table of cases is a feature, and tests must be able to build values
    // the type system forbids to prove the runtime guard against them fires.
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },

  {
    // Outside every tsconfig, so type-aware rules have no program to consult.
    files: ['**/*.mjs', '**/*.cjs', '**/*.js', '*.config.mts', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'no-console': 'off' },
  },

  {
    // A worker thread loads its entry by filename with the CommonJS loader, so
    // `require` is the only thing that works there.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // Must stay last: switches off every rule Prettier already decides.
  prettierConfig,
);
