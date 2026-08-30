import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  ConflictError,
  DomainError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  UnverifiableClaimError,
  ValidationError,
  isDomainError,
  type DomainErrorCode,
} from '../errors';

const CASES: readonly [new (message: string) => DomainError, DomainErrorCode, string][] = [
  [ValidationError, 'validation', 'ValidationError'],
  [UnauthenticatedError, 'unauthenticated', 'UnauthenticatedError'],
  [NotFoundError, 'not_found', 'NotFoundError'],
  [ConflictError, 'conflict', 'ConflictError'],
  [ForbiddenError, 'forbidden', 'ForbiddenError'],
  [InvalidTransitionError, 'invalid_transition', 'InvalidTransitionError'],
  [BudgetExceededError, 'budget_exceeded', 'BudgetExceededError'],
  [UnverifiableClaimError, 'unverifiable', 'UnverifiableClaimError'],
];

describe('the error taxonomy', () => {
  it.each(CASES)('%o carries its code and its own name', (Ctor, code, name) => {
    const error = new Ctor('something went wrong');

    expect(error.code).toBe(code);
    expect(error.name).toBe(name);
    expect(error.message).toBe('something went wrong');
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
  });

  it('assigns every code exactly once, so a code identifies one error type', () => {
    const codes = CASES.map(([, code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('defaults details to an empty object rather than undefined', () => {
    expect(new ValidationError('x').details).toEqual({});
  });

  it('keeps structured details for logging', () => {
    const error = new BudgetExceededError('over limit', { limitMicroUsd: 1_000_000, used: 999 });
    expect(error.details).toEqual({ limitMicroUsd: 1_000_000, used: 999 });
  });

  it('produces a usable stack trace', () => {
    expect(new ConflictError('x').stack).toContain('ConflictError');
  });
});

describe('RateLimitedError', () => {
  it('carries the wait as a field and in details, so a header and a log both have it', () => {
    const error = new RateLimitedError('too many login attempts', 300);

    expect(error.retryAfterSeconds).toBe(300);
    expect(error.details).toEqual({ retryAfterSeconds: 300 });
  });

  it('keeps details the caller supplied alongside it', () => {
    const error = new RateLimitedError('too many', 60, { scope: 'email' });

    expect(error.details).toEqual({ scope: 'email', retryAfterSeconds: 60 });
  });

  it.each([-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21])(
    'refuses %o, which has no meaning as a Retry-After',
    (invalid) => {
      // A limiter that produces one of these is broken. Rejecting at
      // construction keeps the mistake near its cause rather than turning into
      // a header a client cannot parse.
      expect(() => new RateLimitedError('too many', invalid)).toThrow(TypeError);
    },
  );

  it('allows zero, which means retry now', () => {
    expect(new RateLimitedError('too many', 0).retryAfterSeconds).toBe(0);
  });

  it('is separate from a spent budget, though both answer 429', () => {
    expect(new RateLimitedError('x', 1).code).not.toBe(new BudgetExceededError('y').code);
  });
});

describe('isDomainError', () => {
  it('accepts a domain error', () => {
    expect(isDomainError(new NotFoundError('gone'))).toBe(true);
  });

  it('rejects a plain error and a non-error', () => {
    expect(isDomainError(new Error('plain'))).toBe(false);
    expect(isDomainError('not an error')).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });
});
