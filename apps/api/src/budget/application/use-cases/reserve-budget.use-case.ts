import {
  BudgetExceededError,
  Err,
  Ok,
  type Reservation,
  type Result,
  type UserId,
} from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { ReservationEstimator } from '../cost-estimator';
import { BUDGET_STORE, type BudgetStore } from '../ports/budget.store';

/**
 * The one place a question is allowed to become work.
 *
 * What is held is the worst the loop can do, at the best price anything here
 * can know before the question is asked. What was really used is charged at the
 * other end, from the name the provider gave with the answer it produced — this
 * is an estimate, and that is the bill.
 */
@Injectable()
export class ReserveBudgetUseCase {
  constructor(
    @Inject(BUDGET_STORE) private readonly store: BudgetStore,
    private readonly estimate: ReservationEstimator,
  ) {}

  async reserve(userId: UserId): Promise<Result<Reservation, BudgetExceededError>> {
    const held = await this.store.reserve(userId, this.estimate.worstCase());
    if (held !== null) return Ok(held);

    // The wording comes from the code, not from here: this says which failure
    // it is and nothing about how it reads.
    return Err(new BudgetExceededError('Not enough budget remains in this window.'));
  }

  async release(reservation: Reservation): Promise<void> {
    await this.store.release(reservation);
  }
}
