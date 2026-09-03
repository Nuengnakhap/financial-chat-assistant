import type { AppConfig } from '@fca/config';
import { MicroUsd, ReservationId, UserId, isErr, isOk, type Reservation } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import { ReservationEstimator } from '../cost-estimator';
import type { BudgetState, BudgetStore } from '../ports/budget.store';
import type { ModelInUse } from '../ports/model-in-use.port';
import { Pricing } from '../pricing';
import { ReserveBudgetUseCase } from '../use-cases/reserve-budget.use-case';

/**
 * What is held before a question is allowed to become work.
 *
 * The figure is the worst the loop can do, priced for the model that is
 * actually answering: a router takes `auto` and resolves per request, so what
 * the endpoint last answered as is the closest thing to a price there is before
 * a question is asked. Guessing high refuses somebody early; guessing low lets
 * them past the limit, and the limit is the point.
 */

const ADA = UserId.trusted('9f1b7c2e-0d3a-4f5b-8c6d-7e8f9a0b1c2d');
const HELD: Reservation = {
  userId: ADA,
  id: ReservationId.trusted('2f1c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b'),
  windowStart: new Date('2026-09-02T14:00:00.000Z'),
};

function reserverWith(model: string, granted = true, resolved: string | null = null) {
  const asked: MicroUsd[] = [];
  const released: Reservation[] = [];
  const store: BudgetStore = {
    reserve: async (_userId, amount) => {
      asked.push(amount);

      return await Promise.resolve(granted ? HELD : null);
    },
    settle: async () => await Promise.resolve(),
    release: async (reservation) => {
      released.push(reservation);
      await Promise.resolve();
    },
    read: async () => await Promise.resolve({} as BudgetState),
  };
  const config: AppConfig = { ...testConfig(), llm: { ...testConfig().llm, model } };
  const endpoint: ModelInUse = { resolved: () => resolved };
  const estimate = new ReservationEstimator(new Pricing(), endpoint, config);

  return { asked, released, use: new ReserveBudgetUseCase(store, estimate) };
}

describe('holding what an answer might cost', () => {
  it('asks for the worst the loop can do, not for what it usually costs', async () => {
    const { use, asked } = reserverWith('gpt-5.6-luna');

    const held = await use.reserve(ADA);

    expect(isOk(held)).toBe(true);
    // Eighteen rounds of a full transcript and a full answer, at $0.20/$1.20 per
    // million. An ordinary question uses a twentieth of it and the difference
    // comes straight back when the books are closed.
    expect(asked[0]?.toUsdNumber()).toBeCloseTo(0.061, 3);
  });

  it('holds the dearest price there is for a name it cannot price', async () => {
    // A router configured as `auto` is exactly this case, and so is a local
    // model nobody has priced. Reserving as though it were cheap is how a
    // window gets spent past its limit.
    const { asked: cheap } = await priced('gpt-5.6-luna');
    const { asked: unknown } = await priced('auto');

    expect(unknown[0]?.isGreaterThan(cheap[0] ?? MicroUsd.ZERO)).toBe(true);
  });

  it('refuses in the words the code chooses, not in a number', async () => {
    const { use } = reserverWith('gpt-5.6-luna', false);

    const refused = await use.reserve(ADA);

    // The wording a person reads is picked from the code by the error filter.
    // Anything said here would be a second copy of it.
    expect(isErr(refused) && refused.error.code).toBe('budget_exceeded');
  });

  it('prices what the endpoint answers as, not what it was asked for', async () => {
    // A router takes `auto` and resolves per request. Pricing the name that was
    // configured would hold the dearest rate in the table for every question,
    // and at a small limit that refuses the first one.
    const { asked } = await priced('auto', 'gpt-5.6-luna');

    expect(asked[0]?.toUsdNumber()).toBeCloseTo(0.061, 3);
  });

  it('gives a claim back when asked to', async () => {
    const { use, released } = reserverWith('gpt-5.6-luna');

    await use.release(HELD);

    expect(released).toEqual([HELD]);
  });
});

async function priced(model: string, resolved: string | null = null) {
  const reserver = reserverWith(model, true, resolved);
  await reserver.use.reserve(ADA);

  return reserver;
}
