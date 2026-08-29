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
      ...['domain', 'config', 'contracts'].map((name) => ({
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
        // with `pnpm test:integration`. Persistence is tested against a real
        // PostgreSQL because a fake cannot reject a CHECK constraint.
        test: {
          name: 'integration',
          root: './apps/api',
          environment: 'node',
          include: ['src/**/*.int.spec.ts'],
          globalSetup: ['src/shared/persistence/__tests__/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
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
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      // `__tests__` is test infrastructure, not product code; `main.ts` starts a
      // process, which a unit test cannot do without becoming a worse copy of
      // running the app.
      exclude: ['**/__tests__/**', '**/index.ts', 'apps/api/src/main.ts'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
