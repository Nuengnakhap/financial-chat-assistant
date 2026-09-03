import type { ReservationId, UserId } from '../identifiers';

/**
 * A claim on somebody's budget, held while an answer is being written.
 *
 * The window is part of it because a claim outlives the request that made one:
 * whatever gives it back may be another process an hour later — a janitor
 * clearing up after a pod that died — and by then a clock cannot say which
 * window the claim was made in. Carrying it is what makes giving it back exact
 * rather than approximately right.
 */
export interface Reservation {
  readonly userId: UserId;
  readonly id: ReservationId;
  /** The start of the window this claim belongs to, on a whole second. */
  readonly windowStart: Date;
}
