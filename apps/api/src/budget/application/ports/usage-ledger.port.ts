import type { MicroUsd, UserId } from '@fca/domain';

/**
 * What has been spent, according to the record that outlives the counter.
 *
 * Redis holds the number a limit is enforced by, because enforcing one needs a
 * single atomic step and a database transaction per question would be a poor
 * way to get one. But Redis can be restarted, and a spending limit that a
 * restart resets is not a limit. This is where a window is read back from.
 */
export interface UsageLedger {
  spentIn(userId: UserId, windowStart: Date): Promise<MicroUsd>;
}

export const USAGE_LEDGER = Symbol('UsageLedger');
