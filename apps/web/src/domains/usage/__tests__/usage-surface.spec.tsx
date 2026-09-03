import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BudgetBanner } from '../components/BudgetBanner';
import { UsageMeter } from '../components/UsageMeter';

import { json, renderApp, stubApi } from '@/__tests__/harness';

/**
 * What a spending limit looks like from the outside: a bar that says how much
 * of the hour is left, and — once none of it is — a banner that says when
 * asking comes back, and takes itself away when it does.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const RESET_AT = '2026-09-02T15:00:00.000Z';

const window_ = (over: Record<string, unknown> = {}) => ({
  spentMicroUsd: '420000',
  reservedMicroUsd: '0',
  limitMicroUsd: '1000000',
  remainingMicroUsd: '580000',
  resetAt: RESET_AT,
  exceeded: false,
  ...over,
});

const serve = (over: Record<string, unknown> = {}) => stubApi(() => json(window_(over)));

describe('the meter', () => {
  it('says what has been spent against what is allowed', async () => {
    serve();

    renderApp(<UsageMeter />);

    expect(await screen.findByText('$0.42 / $1.00')).toBeInTheDocument();
  });

  it('says the same thing to a screen reader as a proportion', async () => {
    serve();

    renderApp(<UsageMeter />);

    const meter = await screen.findByRole('meter', { name: 'Usage this period' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(meter).toHaveAttribute('aria-valuetext', '$0.42 of $1.00 used');
  });

  it('draws nothing at all until a window has been read', () => {
    stubApi(() => json({}, 500));

    renderApp(<UsageMeter />);

    // A meter that starts at zero and jumps is worse than a space that fills
    // in: the zero is a figure, and it is wrong.
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it.each([
    ['420000', 'bg-ink'],
    ['850000', 'bg-warning'],
    ['1000000', 'bg-negative'],
  ])('warns before it refuses, at %s spent', async (spentMicroUsd, fill) => {
    // Colour is the last thing to say it and never the only one: the figures
    // beside the bar say it first. Amber means the next answer may not fit;
    // the negative colour means one certainly will not.
    serve({ spentMicroUsd });

    renderApp(<UsageMeter />);

    const meter = await screen.findByRole('meter');
    expect(meter.firstElementChild).toHaveClass(fill);
  });

  it('counts what is held as spent, because it cannot be spent again', async () => {
    serve({ spentMicroUsd: '200000', reservedMicroUsd: '300000' });

    renderApp(<UsageMeter />);

    expect(await screen.findByRole('meter')).toHaveAttribute('aria-valuenow', '50');
  });
});

describe('the banner', () => {
  it('stays out of the way while there is room left', async () => {
    const { calls } = serve();

    renderApp(<BudgetBanner />);
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says when asking comes back, counting down', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-02T14:58:30.000Z') });
    serve({ spentMicroUsd: '1000000', remainingMicroUsd: '0', exceeded: true });

    renderApp(<BudgetBanner />);
    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/reached your usage limit/);
    });

    // Not "later": the one thing worth knowing is whether to wait or to go away.
    expect(screen.getByRole('status')).toHaveTextContent('2 minutes');
  });

  it('reads the window again by itself once the time has passed', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-02T14:59:58.000Z') });
    let spent = true;
    const { calls } = stubApi(() =>
      json(
        spent
          ? window_({ spentMicroUsd: '1000000', remainingMicroUsd: '0', exceeded: true })
          : window_({ spentMicroUsd: '0', remainingMicroUsd: '1000000' }),
      ),
    );

    renderApp(<BudgetBanner />);
    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    spent = false;
    const read = calls.length;
    await vi.advanceTimersByTimeAsync(4_000);

    // Somebody who waited should not have to reload to find out they were right
    // to: the window turning over is something this can see for itself.
    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThan(read);
    });
    await vi.waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });
});
