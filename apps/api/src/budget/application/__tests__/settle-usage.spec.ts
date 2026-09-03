import type { AppConfig } from '@fca/config';
import { type MicroUsd, ReservationId, UserId, type Reservation } from '@fca/domain';
import { describe, expect, it, vi } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import type { CpuPool } from '../../../shared/cpu/cpu-pool';
import { ReservationEstimator } from '../cost-estimator';
import type { BudgetState, BudgetStore } from '../ports/budget.store';
import { Pricing } from '../pricing';
import { SettleUsageUseCase, type UsedTokens } from '../use-cases/settle-usage.use-case';

/**
 * Closing the books. What matters here is that a round nobody reported is still
 * charged for — the alternative is a stop button that makes an answer free.
 */

const RESERVATION: Reservation = {
  userId: UserId.trusted('9f1b7c2e-0d3a-4f5b-8c6d-7e8f9a0b1c2d'),
  id: ReservationId.trusted('2f1c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b'),
  windowStart: new Date('2026-09-02T14:00:00.000Z'),
};

function settlerWith(counted = 0) {
  const settled: { reservation: Reservation; actual: MicroUsd }[] = [];
  const released: Reservation[] = [];
  const store: BudgetStore = {
    reserve: async () => await Promise.resolve(null),
    settle: async (reservation, actual) => {
      settled.push({ reservation, actual });
      await Promise.resolve();
    },
    release: async (reservation) => {
      released.push(reservation);
      await Promise.resolve();
    },
    read: async () => await Promise.resolve({} as BudgetState),
  };
  const cpu = { countTokens: vi.fn(async () => await Promise.resolve(counted)) };

  return {
    settled,
    released,
    cpu,
    use: new SettleUsageUseCase(store, estimator(), cpu as unknown as CpuPool),
  };
}

const usage = (over: Partial<UsedTokens> = {}): UsedTokens => ({
  model: 'gpt-5.6-luna',
  inputTokens: 2_000,
  cachedInputTokens: 0,
  outputTokens: 500,
  unreportedText: '',
  estimatedInputTokens: 0,
  ...over,
});

describe('a generation the provider reported in full', () => {
  it('charges what the rounds added up to, at the price of the model that answered', async () => {
    const { use, settled } = settlerWith();

    const result = await use.price(usage());
    await use.settle(RESERVATION, result.cost);

    // 2,000 input at $0.20/M and 500 output at $1.20/M.
    expect(result.cost.micro).toBe(400n + 600n);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.actual.micro).toBe(1_000n);
  });

  it('does not reach for the tokenizer when there is nothing to count', async () => {
    const { use, cpu } = settlerWith();

    await use.price(usage());

    expect(cpu.countTokens).not.toHaveBeenCalled();
  });
});

describe('a generation cut off part-way', () => {
  it('counts the round nobody reported rather than charging nothing for it', async () => {
    // Stopping abandons the response the provider had already begun sending, so
    // the usage chunk for that round never arrives. Free-of-charge is the one
    // reading of that which is certainly wrong.
    const { use, cpu } = settlerWith(120);

    const result = await use.price(
      usage({ outputTokens: 0, unreportedText: 'Apple earned ', estimatedInputTokens: 1_800 }),
    );

    expect(cpu.countTokens).toHaveBeenCalledWith('Apple earned ');
    expect(result.outputTokens).toBe(120);
    expect(result.inputTokens).toBe(2_000 + 1_800);
  });

  it('charges nothing extra for a round that produced no text at all', async () => {
    const { use } = settlerWith(0);

    const result = await use.price(usage({ unreportedText: '', estimatedInputTokens: 1_800 }));

    // Nothing was written, so there was no unreported round to charge for —
    // adding its input anyway would bill for a call that never happened.
    expect(result.inputTokens).toBe(2_000);
  });

  it('still closes the books when the tokenizer will not answer', async () => {
    const failing = settlerWith();
    failing.cpu.countTokens.mockRejectedValue(new Error('pool is full'));

    const priced = await failing.use.price(usage({ unreportedText: 'Apple earned ' }));

    // A row left `generating` because a worker thread was busy is worse than a
    // charge that is a few tokens short.
    expect(priced.outputTokens).toBe(500);
  });
});

describe('a generation that spent nothing', () => {
  it('gives the whole hold back and charges nothing', async () => {
    const { use, released, settled } = settlerWith();

    await use.release(RESERVATION);

    expect(released).toEqual([RESERVATION]);
    expect(settled).toHaveLength(0);
  });
});

describe('a model the provider never named', () => {
  it('is charged at the dearest rate rather than at nothing', async () => {
    const { use } = settlerWith();

    const unnamed = await use.price(usage({ model: '' }));
    const known = await use.price(usage({ model: 'gpt-5.6-luna' }));

    expect(unnamed.cost.isGreaterThan(known.cost)).toBe(true);
  });
});

/** Real prices, so a figure in a test is the figure the system would charge. */
function estimator(): ReservationEstimator {
  const config: AppConfig = testConfig();

  return new ReservationEstimator(new Pricing(), { resolved: () => 'gpt-5.6-luna' }, config);
}
