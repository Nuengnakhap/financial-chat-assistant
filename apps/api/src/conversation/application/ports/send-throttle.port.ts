import type { RateLimitedError, Result, UserId } from '@fca/domain';

/**
 * How often one person may ask, which is not the same question as how much they
 * may spend.
 *
 * The budget stops a costly conversation and would not notice a cheap one
 * arriving ten thousand times until it had paid for all of them — every send
 * writes two rows and an outbox event before a single token is bought, so the
 * expensive part of a refused burst is the part that happens first.
 *
 * Counted per person rather than per address on purpose. An address is
 * something a proxy owns here, and this system has no edge; a signed-in user is
 * the only actor it can actually name.
 */
export interface SendThrottle {
  /**
   * Records the send and answers whether it was allowed, in that order and
   * atomically. Asking first and counting afterwards lets a burst all read the
   * same count and all pass, which is the shape of the thing being limited.
   */
  recordSend(userId: UserId): Promise<Result<void, RateLimitedError>>;
}

export const SEND_THROTTLE = Symbol('SendThrottle');
