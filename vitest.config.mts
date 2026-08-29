import { defineConfig } from 'vitest/config';

/**
 * Coverage covers `packages/*` and `apps/api` alike: an uncovered branch is a
 * rule nobody has tested, wherever it lives. `main.ts` is the one exception —
 * it starts a process and listens, which a unit test cannot do without becoming
 * a worse copy of actually running the app.
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
      exclude: ['**/*.spec.ts', '**/index.ts', 'apps/api/src/main.ts'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
