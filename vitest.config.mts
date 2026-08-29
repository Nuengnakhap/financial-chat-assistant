import { defineConfig } from 'vitest/config';

/**
 * Coverage thresholds apply to every package under `packages/*`: they are pure
 * logic with no I/O, so an uncovered branch is a rule nobody has tested.
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
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/index.ts'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
