import { defineConfig, devices } from '@playwright/test';

/**
 * The scenarios, in a real browser, against the real stack.
 *
 * These are the ones jsdom cannot answer, and the list is not a matter of
 * taste — every entry on it was a bug found by hand because no test could see
 * it: `history.state` surviving a reload and asking the same question twice,
 * `StrictMode` double-invoking effects only at the render root, a page that
 * attached to a stream and never attached again. A component test proves a
 * component; only this proves the product.
 *
 * **It expects the stack to be up.** `pnpm infra:up && pnpm dev` in another
 * terminal, which is the same thing a person does to look at the app. Booting
 * it from here would mean this suite owning the lifecycle of Postgres, Redis,
 * the API and Vite — four things whose failure modes would all arrive dressed
 * as a flaky test.
 *
 * Serial, and one worker. Two of these scenarios spend a shared budget and one
 * of them deliberately exhausts a window; running them beside each other would
 * make each one's result depend on the others'.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // A generation against the real model takes seconds, and three drafts take
  // more. Short enough that a hang still fails inside a coffee break.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:5173',
    // Signed in before the first test, because registration is throttled per
    // host and a suite that registers once per test trips its own product's
    // limit — which the first run of this suite did, and reported as eight
    // broken features.
    storageState: './e2e/.auth/main.json',
    // Kept only for a failure: a trace of a passing run is a folder nobody opens.
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
