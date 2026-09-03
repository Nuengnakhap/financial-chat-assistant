import { expect, test as base, type Page } from '@playwright/test';

import { STRANGER_STATE } from './global-setup';

/**
 * One signed-in account for the whole run, and a stranger for the one test that
 * needs somebody else.
 *
 * Not an account per test: registration is throttled per host — ten in five
 * minutes, deliberately — so a suite that registers nine times trips its own
 * product's limit and reports it as nine broken features. The cost of sharing
 * is that these tests share a budget and a conversation rail, which is why
 * nothing here exhausts a window and why each test starts by opening a new
 * conversation of its own.
 */

export const test = base;
export { expect } from '@playwright/test';

/** Where the second account's cookies are, for the isolation test. */
export const strangerState = STRANGER_STATE;

/** The composer, which is on every screen a question can be asked from. */
export const composer = (page: Page) => page.getByRole('textbox', { name: 'Ask a question' });

/** Opens a fresh conversation and asks, without waiting for the answer. */
export async function ask(page: Page, question: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await composer(page).fill(question);
  await composer(page).press('Enter');
}

/**
 * Every resting state an answer can end in. `VerifiedBadge` renders exactly one
 * of these for every terminal status, and nothing else does, which makes it the
 * only sound signal that a generation is over.
 */
const RESTING =
  /Verified · \d+ figures? checked|No figures to verify|Showing verified data only|Stopped before it finished|could not be written/u;

/**
 * Waits for a generation to end, however it ended.
 *
 * Waiting for the Stop button to *disappear* is unsound and looked fine twice
 * before it did not: a locator that has never attached already has a count of
 * zero, so on a page that has just reloaded this returns immediately and every
 * assertion after it races the answer. Waiting for something that only exists
 * at the end cannot do that.
 */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('main').getByText(RESTING).first()).toBeVisible({ timeout: 80_000 });
}
