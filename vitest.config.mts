import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Coverage covers `packages/*` and `apps/api` alike: an uncovered branch is a
 * rule nobody has tested, wherever it lives.
 *
 * `pnpm test:coverage` therefore runs the integration project too and needs
 * Docker — persistence is deliberately tested against a real PostgreSQL, and
 * measuring without it would report that layer as untested when it is not.
 */
export default defineConfig({
  test: {
    projects: [
      ...['domain', 'config', 'contracts', 'grounding'].map((name) => ({
        test: {
          name,
          root: `./packages/${name}`,
          environment: 'node' as const,
          include: ['src/**/*.spec.ts'],
        },
      })),
      {
        // Legacy decorators and `emitDecoratorMetadata` are read from
        // apps/api/tsconfig.json by the default transform — see the note there.
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.int.spec.ts'],
        },
      },
      {
        // Needs Docker, so it stays out of `pnpm test` and `pnpm check`; run it
        // with `pnpm test:integration`. Persistence runs against a real
        // PostgreSQL because a fake cannot reject a CHECK constraint, and Redis
        // against a real server because a fake never forgets a cached script.
        test: {
          name: 'integration',
          root: './apps/api',
          environment: 'node',
          include: ['src/**/*.int.spec.ts'],
          globalSetup: ['src/__tests__/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        // The browser client. jsdom rather than a real browser: what these cover
        // is component logic, and a Playwright run is what covers the browser.
        // JSX needs no plugin here — `jsx: react-jsx` in the nearest tsconfig is
        // what the default transform reads, the same way apps/api gets decorators.
        //
        // `@fca/contracts` resolves to its source here for one reason: that is
        // what `apps/web` bundles, for the reasons written in its vite config.
        // A project should test the artefact it ships, and the API — which
        // imports the CommonJS build — keeps doing exactly that in its own
        // project above.
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
            '@fca/contracts': fileURLToPath(new URL('./packages/contracts/src', import.meta.url)),
          },
        },
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
      {
        // The grounding quality gate. Deterministic — recorded query results, no
        // model and no database — so it belongs in `pnpm test` rather than
        // beside the integration suite, and runs on every change.
        test: {
          name: 'eval',
          root: './evals',
          environment: 'node',
          include: ['**/*.eval.ts'],
        },
      },
      {
        test: {
          name: 'architecture',
          root: './tools',
          environment: 'node',
          include: ['**/*.spec.ts'],
          // A fixture is named like a spec because that is what makes it a violation.
          exclude: ['architecture/fixtures/**'],
          testTimeout: 60_000, // each case shells out to dependency-cruiser
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}'],
      // `__tests__` is test infrastructure, not product code; `main.ts` starts a
      // process and `main.tsx` mounts into a document, neither of which a unit
      // test can do without becoming a worse copy of running the app.
      exclude: ['**/__tests__/**', '**/index.ts', 'apps/api/src/main.ts', 'apps/web/src/main.tsx'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
