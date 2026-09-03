import type { MicroUsd, Reservation, UserId } from '@fca/domain';

/**
 * The counter a spending limit is actually held by.
 *
 * Two phases, because one is not enough: checking a total and then adding to it
 * lets any number of requests read the same total and all pass. Reserving is a
 * single atomic step, so `settled + reserved ≤ limit` holds however many
 * arrive at once — the limit is then arithmetic rather than a race that is
 * usually won.
 */
export interface BudgetStore {
  /**
   * `null` when there is not enough left. The caller turns that into a refusal;
   * the store does not know what an HTTP status is.
   */
  reserve(userId: UserId, amount: MicroUsd): Promise<Reservation | null>;
  /** Gives back what was held and adds what was actually spent. Doing it twice adds once. */
  settle(reservation: Reservation, actual: MicroUsd): Promise<void>;
  /** Gives back what was held and adds nothing. For a generation that spent nothing at all. */
  release(reservation: Reservation): Promise<void>;
  /** What the window looks like now. Reads only — asking must not change an answer. */
  read(userId: UserId): Promise<BudgetState>;
}

export interface BudgetState {
  readonly spent: MicroUsd;
  readonly reserved: MicroUsd;
  readonly limit: MicroUsd;
  /** When this window ends and the counter starts again. */
  readonly resetAt: Date;
}

export const BUDGET_STORE = Symbol('BudgetStore');
