/**
 * A closed taxonomy: every expected failure is one of these codes, and presentation
 * maps a code to an HTTP status and to wording a user can act on. Nothing here is
 * written for a user — `message` and `details` are for logs, and must never carry
 * answer text, SQL, or credentials.
 */

export type DomainErrorCode =
  | 'validation'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'invalid_transition'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'unverifiable';

export type DomainErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  readonly details: DomainErrorDetails;

  constructor(message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** Input did not satisfy a rule that the caller could have checked first. */
export class ValidationError extends DomainError {
  readonly code = 'validation' as const;
}

/**
 * Nobody is signed in, or the credentials presented identify nobody. Distinct
 * from `forbidden`, which is a known caller reaching for something not theirs —
 * the first is fixed by signing in, the second never is.
 */
export class UnauthenticatedError extends DomainError {
  readonly code = 'unauthenticated' as const;
}

/**
 * The email and password presented do not identify anyone. Separate from
 * `unauthenticated` because the two are read in opposite situations: one is
 * someone standing at the sign-in form having mistyped, the other is a request
 * arriving without a session. Telling a person at the form that they "need to
 * sign in" is the wording bug this code exists to make impossible.
 *
 * Deliberately not split further: "no such account" and "wrong password" answer
 * with this same code, so the response never says which.
 */
export class InvalidCredentialsError extends DomainError {
  readonly code = 'invalid_credentials' as const;
}

/** The resource does not exist, or exists but is not this user's to see. */
export class NotFoundError extends DomainError {
  readonly code = 'not_found' as const;
}

/** The request is valid but the current state rejects it. */
export class ConflictError extends DomainError {
  readonly code = 'conflict' as const;
}

/** Authenticated, but not permitted. */
export class ForbiddenError extends DomainError {
  readonly code = 'forbidden' as const;
}

/** A lifecycle was asked to move along an edge that does not exist. */
export class InvalidTransitionError extends DomainError {
  readonly code = 'invalid_transition' as const;
}

/**
 * Too many attempts in the window. Separate from `budget_exceeded` although both
 * answer 429: one is about how often a caller asks, the other about what they
 * have spent, and a client that retries the first must not retry the second.
 */
export class RateLimitedError extends DomainError {
  readonly code = 'rate_limited' as const;

  /** Reaches the caller as `Retry-After`, so a client waits rather than hammering. */
  readonly retryAfterSeconds: number;

  /**
   * The wait is checked here rather than where it becomes a header, because
   * `Retry-After` is whole non-negative seconds and there is no sensible way to
   * render `-5` or `1.5`. A limiter that computes one is broken, and this is
   * where that stops being silent.
   */
  constructor(message: string, retryAfterSeconds: number, details: DomainErrorDetails = {}) {
    super(message, { ...details, retryAfterSeconds });
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0) {
      throw new TypeError(
        `retryAfterSeconds must be whole and not negative, got ${String(retryAfterSeconds)}`,
      );
    }
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Spending this request would exceed the window limit. */
export class BudgetExceededError extends DomainError {
  readonly code = 'budget_exceeded' as const;
}

/** A figure had no matching evidence, so the draft is discarded rather than shown. */
export class UnverifiableClaimError extends DomainError {
  readonly code = 'unverifiable' as const;
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
