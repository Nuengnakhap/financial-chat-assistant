import { usageView } from '@fca/contracts';
import { MicroUsd, SessionId, UserId } from '@fca/domain';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../../../shared/config/__tests__/test-config';
import type { CpuPool } from '../../../shared/cpu/cpu-pool';
import { runWithRequestContext } from '../../../shared/http/request-context';
import { ReservationEstimator } from '../../application/cost-estimator';
import type { BudgetState, BudgetStore } from '../../application/ports/budget.store';
import { Pricing } from '../../application/pricing';
import { SettleUsageUseCase } from '../../application/use-cases/settle-usage.use-case';
import { UsageController } from '../usage.controller';

/**
 * What a window looks like to a page. Every figure crosses as an integer
 * micro-USD string, so the one thing worth checking here is the arithmetic
 * nobody else does: what is left, and whether that means the composer should
 * be shut.
 */

const ADA = UserId.trusted('9f1b7c2e-0d3a-4f5b-8c6d-7e8f9a0b1c2d');
const SESSION = SessionId.trusted('1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
const RESET_AT = new Date('2026-09-02T15:00:00.000Z');

const state = (spentUsd: number, reservedUsd = 0): BudgetState => ({
  spent: MicroUsd.fromUsd(spentUsd),
  reserved: MicroUsd.fromUsd(reservedUsd),
  limit: MicroUsd.fromUsd(1),
  resetAt: RESET_AT,
});

async function read(budget: BudgetState) {
  const store = {
    read: async () => await Promise.resolve(budget),
  } as unknown as BudgetStore;
  const estimate = new ReservationEstimator(
    new Pricing(),
    { resolved: () => 'gpt-5.6-luna' },
    testConfig(),
  );
  const usage = new SettleUsageUseCase(store, estimate, {} as CpuPool);

  return await runWithRequestContext(
    {
      requestId: '2f1c2a1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
      principal: { userId: ADA, sessionId: SESSION },
    },
    async () => await new UsageController(usage).read(),
  );
}

describe('what is left of a window', () => {
  it('answers in whole micro-USD strings, which is what the contract says', async () => {
    const view = await read(state(0.42));

    // Parsed by the contract rather than compared field by field: a number
    // where a string belongs is exactly the drift this shape exists to stop.
    expect(usageView.parse(view)).toEqual({
      spentMicroUsd: '420000',
      reservedMicroUsd: '0',
      limitMicroUsd: '1000000',
      remainingMicroUsd: '580000',
      resetAt: RESET_AT.toISOString(),
      exceeded: false,
    });
  });

  it('counts what is held as gone, because it is', async () => {
    const view = await read(state(0.4, 0.5));

    // A reservation is money that cannot be spent on anything else. Reporting
    // it as available would offer room the next question is refused for.
    expect(view.remainingMicroUsd).toBe('100000');
  });

  it('says a window is spent when another answer will not fit in it', async () => {
    // Not "nothing is left": a generation holds what it might cost before it
    // starts, so a window with a cent in it is spent for every practical
    // purpose — and the threshold is what the next one would hold.
    expect((await read(state(1))).exceeded).toBe(true);
    expect((await read(state(0.99))).exceeded).toBe(true);
    expect((await read(state(0.1))).exceeded).toBe(false);
  });

  it('says nothing is wrong while there is room for another answer', async () => {
    const view = await read(state(0.42));

    expect(view.exceeded).toBe(false);
  });

  it('never reports a debt, however far past the limit a window went', async () => {
    // Settling can pass the limit by one generation's difference, and a
    // negative remaining would render as a meter running backwards.
    const view = await read(state(1.4));

    expect(view.remainingMicroUsd).toBe('0');
    expect(view.exceeded).toBe(true);
  });
});
