import type { BudgetExceededError, Reservation, Result, UserId } from '@fca/domain';

/**
 * What this context needs from whatever enforces a spending limit, and nothing
 * more: may this person start another answer, and here it is back.
 *
 * Declared here rather than imported from the context that implements it, for
 * the reason `SessionGuard` declares its own view of a token issuer — a context
 * that reaches into another's application layer ties the two together so that
 * neither can change alone. The composition root is where the two meet.
 */
export interface GenerationBudget {
  /**
   * Held before a question is written down, because a question stored against a
   * refusal is a question nobody will ever answer, sitting in a transcript.
   */
  reserve(userId: UserId): Promise<Result<Reservation, BudgetExceededError>>;
  release(reservation: Reservation): Promise<void>;
}

export const GENERATION_BUDGET = Symbol('GenerationBudget');
