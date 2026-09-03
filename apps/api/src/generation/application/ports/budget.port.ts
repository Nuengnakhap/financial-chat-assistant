import type { BudgetSnapshot } from '@fca/contracts';
import type { MicroUsd, Reservation, UserId } from '@fca/domain';

/**
 * What this context needs from whatever holds the budget.
 *
 * Pricing and settling are separate calls on purpose. The row is what decides
 * which of several writers ended a generation, so the charge has to be worked
 * out before that write and applied only by whoever won it — otherwise the
 * counter holds one process's figure while the ledger holds another's, and a
 * rebuild would disagree with the counter it was rebuilding.
 *
 * Declared here rather than imported from the context that implements it, the
 * same way the conversation context declares its own half. Neither knows the
 * other exists; the composition root is where they meet.
 */
export interface UsageSettlement {
  /** What the rounds came to, counting anything the provider did not report. */
  price(usage: UsedTokens): Promise<Charged>;
  settle(reservation: Reservation, cost: MicroUsd): Promise<void>;
  release(reservation: Reservation): Promise<void>;
  /** For the `usage` event, which reports a window rather than a message. */
  snapshot(userId: UserId): Promise<BudgetSnapshot>;
}

export interface UsedTokens {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /**
   * What was written in a round the provider never reported. Stopping abandons
   * a response the provider had already begun, so the usage for that round
   * never arrives — counting the text is what stops a stopped answer being free.
   */
  readonly unreportedText: string;
  /** What that round sent, as far as anything here can know. */
  readonly estimatedInputTokens: number;
}

export interface Charged {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly cost: MicroUsd;
}

export const USAGE_SETTLEMENT = Symbol('UsageSettlement');
