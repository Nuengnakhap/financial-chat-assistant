import { remainingMicroUsd, type BudgetSnapshot, type UsageView } from '@fca/contracts';
import { MicroUsd, type Reservation, type UserId } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { CpuPool } from '../../../shared/cpu/cpu-pool';
import { ReservationEstimator } from '../cost-estimator';
import { BUDGET_STORE, type BudgetStore, type BudgetState } from '../ports/budget.store';

/**
 * What a generation actually cost, and the books closed on it.
 *
 * The numbers come from the provider wherever it reported them. Where it did
 * not — a generation stopped part-way, or one whose process died and which a
 * janitor is clearing up — they are counted here instead, because a round that
 * happened and was charged for is not free just because nobody wrote down its
 * size. This is the one place the tokenizer is needed, and it runs on a worker
 * thread for the reason `CpuPool` exists.
 */
export interface UsedTokens {
  /** The model the provider said answered. Empty when it never said. */
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /**
   * Text from a round the provider reported nothing for. Counted and charged as
   * output; the input of such a round is covered by `estimatedInputTokens`.
   */
  readonly unreportedText: string;
  /** What was sent in the round that reported nothing, as a token count. */
  readonly estimatedInputTokens: number;
}

export interface Settled {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly cost: MicroUsd;
}

@Injectable()
export class SettleUsageUseCase {
  constructor(
    @Inject(BUDGET_STORE) private readonly store: BudgetStore,
    private readonly estimate: ReservationEstimator,
    private readonly cpu: CpuPool,
  ) {}

  async price(usage: UsedTokens): Promise<Settled> {
    const estimated = await this.countUnreported(usage.unreportedText);
    const totals = {
      model: usage.model,
      inputTokens: usage.inputTokens + (estimated === 0 ? 0 : usage.estimatedInputTokens),
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens + estimated,
    };
    const cost = this.estimate.costOf(totals.model, {
      input: totals.inputTokens,
      cachedInput: totals.cachedInputTokens,
      output: totals.outputTokens,
    });

    return { ...totals, cost };
  }

  /**
   * Applied by whoever won the write that ended the generation, and by nobody
   * else: the claim is one field, so a second call adds nothing.
   */
  async settle(reservation: Reservation, cost: MicroUsd): Promise<void> {
    await this.store.settle(reservation, cost);
  }

  /** Nothing was spent, so nothing is charged — and the hold goes back whole. */
  async release(reservation: Reservation): Promise<void> {
    await this.store.release(reservation);
  }

  async read(userId: UserId): Promise<UsageView> {
    const state = await this.store.read(userId);
    const budget = this.snapshotOf(state);

    return { ...budget, remainingMicroUsd: remainingMicroUsd(budget) };
  }

  /**
   * The same window, in the words the wire uses. Amounts are strings of integer
   * micro-USD because JSON has only doubles, and a budget that crosses as
   * `0.0014` has already lost what the rest of this path exists to keep.
   */
  async snapshot(userId: UserId): Promise<BudgetSnapshot> {
    return this.snapshotOf(await this.store.read(userId));
  }

  /**
   * `exceeded` is "another answer will not fit", not "nothing is left". A
   * generation holds what it might cost before it starts, so a window with a
   * fraction of a cent in it is spent for every practical purpose — and the
   * threshold is what the next one would hold, which only this side knows.
   */
  private snapshotOf(state: BudgetState): BudgetSnapshot {
    const budget = {
      spentMicroUsd: state.spent.toString(),
      reservedMicroUsd: state.reserved.toString(),
      limitMicroUsd: state.limit.toString(),
      resetAt: state.resetAt.toISOString(),
      exceeded: false,
    };
    const left = MicroUsd.fromMicroString(remainingMicroUsd(budget));

    return { ...budget, exceeded: left.isLessThan(this.estimate.worstCase()) };
  }

  /**
   * A tokenizer that will not answer must not stop a generation being closed:
   * the row has to reach a terminal state and the hold has to go back. Zero is
   * the wrong number and the only safe one — the alternative is a message stuck
   * saying it is still being written.
   */
  private async countUnreported(text: string): Promise<number> {
    if (text === '') return 0;

    try {
      return await this.cpu.countTokens(text);
    } catch {
      return 0;
    }
  }
}
