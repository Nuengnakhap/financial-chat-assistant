/**
 * A closed taxonomy: every expected failure is one of these codes, and presentation
 * maps a code to an HTTP status and to wording a user can act on. Nothing here is
 * written for a user — `message` and `details` are for logs, and must never carry
 * answer text, SQL, or credentials.
 */

export type DomainErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'invalid_transition'
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
