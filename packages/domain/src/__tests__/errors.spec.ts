import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  ConflictError,
  DomainError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  UnverifiableClaimError,
  ValidationError,
  isDomainError,
  type DomainErrorCode,
} from '../errors';

const CASES: readonly [new (message: string) => DomainError, DomainErrorCode, string][] = [
  [ValidationError, 'validation', 'ValidationError'],
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
