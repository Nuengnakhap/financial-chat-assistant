import type { RateLimitedError, Result } from '@fca/domain';

export interface AuthThrottle {
  /**
   * Records the attempt and answers whether it was allowed, in that order and
   * atomically: asking first and counting afterwards lets a burst of requests
   * all read the same count and all pass.
   *
   * Both the address and the caller are counted, so one account cannot be ground
   * down from many hosts and one host cannot walk a list of accounts.
   */
  recordSignIn(email: string, ipHash: string): Promise<Result<void, RateLimitedError>>;

  /**
   * Counted per host only, and deliberately not per address. Registering says
   * out loud whether an address is taken, so it needs a limit — but counting it
   * per address would hand anyone a way to lock a known account out of signing
   * in by registering its email over and over.
   */
  recordRegistration(ipHash: string): Promise<Result<void, RateLimitedError>>;

  /** Signing in succeeded, so the failures that led to it stop counting. */
  clearSignIn(email: string): Promise<void>;
}

export const AUTH_THROTTLE = Symbol('AuthThrottle');
