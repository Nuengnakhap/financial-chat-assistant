import { MicroUsd, type Reservation } from '@fca/domain';

import type { Charged, UsageSettlement, UsedTokens } from '../ports/budget.port';

/**
 * A budget that grants everything and remembers what it was told.
 *
 * Pricing is deliberately trivial — one micro-USD per token — so a test can say
 * what it expects without repeating a price table. What these tests are about is
 * which calls happen and in what order, not what a model costs; that is settled
 * where the arithmetic lives.
 */
export interface BudgetDouble extends UsageSettlement {
  readonly priced: UsedTokens[];
  readonly settled: { reservation: Reservation; cost: MicroUsd }[];
  readonly released: Reservation[];
}

export function budgetDouble(): BudgetDouble {
  const priced: UsedTokens[] = [];
  const settled: { reservation: Reservation; cost: MicroUsd }[] = [];
  const released: Reservation[] = [];

  return {
    priced,
    settled,
    released,
    price: async (usage: UsedTokens): Promise<Charged> => {
      priced.push(usage);
      const output = usage.outputTokens + usage.unreportedText.length;

      return await Promise.resolve({
        model: usage.model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: output,
        cost: MicroUsd.fromMicro(BigInt(usage.inputTokens + output)),
      });
    },
    settle: async (reservation, cost) => {
      settled.push({ reservation, cost });
      await Promise.resolve();
    },
    release: async (reservation) => {
      released.push(reservation);
      await Promise.resolve();
    },
    snapshot: async () =>
      await Promise.resolve({
        spentMicroUsd: '1000',
        reservedMicroUsd: '0',
        limitMicroUsd: '1000000',
        resetAt: '2026-09-02T15:00:00.000Z',
        exceeded: false,
      }),
  };
}
