import { ask, composer, expect, settled, strangerState, test } from './fixtures';

/**
 * The scenarios, in a browser, against the real stack and the real model.
 *
 * S1, S2, S3, S5 and S6, plus isolation and the composer. **S4 is missing on
 * purpose**: it is the spent-budget banner, and reaching it means running with
 * a limit of a tenth of a cent — a different `USAGE_LIMIT_USD` on the stack
 * these tests are pointed at. Changing the environment of a running server from
 * inside a test that shares it with seven others is a worse trade than checking
 * one screen by hand, which is what M9 did.
 *
 * What is asserted is deliberately narrow: the things that are true whatever
 * the model says. "The answer contains $383.3B" is a test of a provider's
 * mood — that is what `pnpm eval:live` is for, and it reports rather than
 * gates. What belongs here is the machinery around the answer, which is exactly
 * what jsdom cannot reach: a real reload, a real second tab, real history state,
 * a real stream being cut.
 */

test.describe('S1 — asking a question', () => {
  test('shows the query before the answer, and says the figures were checked', async ({ page }) => {
    await ask(page, "What was Apple's revenue in 2024?");

    // The tool card is the promise this product makes: the query is visible
    // before the sentence built on it.
    await expect(page.getByText(/Query/u).first()).toBeVisible({ timeout: 60_000 });
    await settled(page);

    await expect(page.getByText(/Verified · \d+ figures? checked/u)).toBeVisible();
    // And the SQL is readable, not a summary of it.
    await page.getByText(/Query/u).first().click();
    await expect(page.getByText(/SELECT/u).first()).toBeVisible();
  });
});

test.describe('S2 — a question the dataset cannot answer', () => {
  test('says so, and claims nothing about figures it did not check', async ({ page }) => {
    await ask(page, "What was Berkshire Hathaway's revenue in 2023?");
    await settled(page);

    await expect(
      page.getByText(/does not (have|include|contain)|not in (this|the) dataset/iu),
    ).toBeVisible();
    // Either it checked nothing, or everything it checked passed. What must not
    // appear is the green badge over an answer with no figures behind it.
    const badge = page.getByText(/No figures to verify|Verified · \d+ figures? checked/u);
    await expect(badge).toBeVisible();
  });
});

test.describe('S3 — stopping', () => {
  test('is accepted, ends the stream, and keeps what was written', async ({ page }) => {
    // What is deterministic here is the request and the resting state, not
    // whether the model had already finished: against a fast endpoint a long
    // answer can arrive before a person can reach the button, and a test that
    // asserted "stopped" would be measuring the provider rather than the
    // product. That the stop is accepted, that the stream ends, and that
    // whatever was written is a row rather than a screen — those are ours.
    const stopped = page.waitForResponse(
      (response) => response.url().includes('/stop') && response.request().method() === 'POST',
    );

    await ask(page, 'Compare the net income of every technology company from 2022 to 2025.');
    const stop = page.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await stop.click();

    expect((await stopped).status()).toBe(202);
    await settled(page);

    // However it ended, it ended: `settled` waited for one of the resting
    // states, and the composer is back.
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    await page.reload();
    // A row rather than a screen. Scoped to the transcript, because the rail
    // carries the same words as the title of the conversation — an unscoped
    // locator matches both and fails on strictness, whenever the rail happens
    // to have caught up.
    await expect(
      page.locator('main').getByText(/Compare the net income of every technology company/u),
    ).toBeVisible();
    await settled(page);
  });
});

test.describe('S5 — leaving and coming back', () => {
  test('resumes the same answer rather than asking again', async ({ page }) => {
    await ask(page, 'How did Nvidia revenue change between 2022 and 2025?');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    // Mid-answer, which is the case that matters: the generation is detached
    // from the connection, so this must attach to the one already running.
    await page.reload();
    await settled(page);

    // Scoped to the transcript: the rail carries the same words as the title of
    // the conversation, and counting both would count two of everything.
    const asked = page.locator('main').getByText(/How did Nvidia revenue change/u);
    // Exactly one. A question asked twice is what `history.state` surviving a
    // reload used to produce, and only a real reload can show it.
    await expect(asked).toHaveCount(1);
  });

  test('shows the same live answer in a second tab', async ({ page, context }) => {
    await ask(page, 'Which three companies had the highest revenue in 2023?');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    const second = await context.newPage();
    await second.goto(page.url());
    await expect(second.locator('main').getByText(/Which three companies/u)).toBeVisible();

    await settled(page);
    await settled(second);
    // Both read the same stream; neither started a second generation.
    await expect(second.locator('main').getByText(/Which three companies/u)).toHaveCount(1);
    await second.close();
  });
});

test.describe('S6 — deleting a conversation', () => {
  test('does nothing on cancel, and takes it away on confirm', async ({ page }) => {
    await ask(page, "What was Apple's revenue in 2024?");
    await settled(page);
    const url = page.url();

    await page
      .getByRole('button', { name: /More actions/u })
      .first()
      .click();
    await page.getByRole('menuitem', { name: /Delete/u }).click();
    await page.getByRole('button', { name: /Cancel/u }).click();
    await expect(page).toHaveURL(url);

    await page
      .getByRole('button', { name: /More actions/u })
      .first()
      .click();
    await page.getByRole('menuitem', { name: /Delete/u }).click();
    await page
      .getByRole('button', { name: /Delete/u })
      .last()
      .click();

    // Gone from the rail, and gone from under the URL it used to be at. The
    // screen does not say "not found" — it takes you back to the empty state,
    // which is the same thing a conversation that was never yours does.
    await expect(page).not.toHaveURL(url, { timeout: 30_000 });
    await page.goto(url);
    await expect(page).toHaveURL(/\/$/u, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Ask about the revenue/u);
  });
});

test.describe('isolation', () => {
  test('another account cannot see or open this conversation', async ({ page, browser }) => {
    await ask(page, "What was Apple's revenue in 2024?");
    await settled(page);
    const url = page.url();

    const other = await browser.newContext({ storageState: strangerState });
    const stranger = await other.newPage();
    await stranger.goto('/');
    await expect(stranger.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();

    // The rail does not have it, and opening its URL puts the stranger back on
    // the empty state — the same thing a conversation that never existed does,
    // which is the point: a 403 would confirm that this one does.
    await expect(stranger.getByText(/What was Apple's revenue/u)).toHaveCount(0);
    await stranger.goto(url);
    await expect(stranger).toHaveURL(/\/$/u, { timeout: 30_000 });
    await expect(stranger.getByRole('heading', { level: 1 })).toContainText(
      /Ask about the revenue/u,
    );
    await other.close();
  });
});

test.describe('the composer', () => {
  test('refuses an empty question without saying anything rude about it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await composer(page).fill('  ');
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
