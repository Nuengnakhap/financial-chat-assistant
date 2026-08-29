import { describe, expect, it } from 'vitest';

import { ValidationError } from '../errors';
import {
  Err,
  Ok,
  allOk,
  andThen,
  expectOk,
  isErr,
  isOk,
  mapErr,
  mapOk,
  unwrapOr,
  type Result,
} from '../result';

const boom = new ValidationError('boom');

describe('Ok and Err', () => {
  it('discriminates on the ok flag', () => {
    const success: Result<number, ValidationError> = Ok(1);
    const failure: Result<number, ValidationError> = Err(boom);

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);
  });

  it('narrows to the payload after a guard', () => {
    const result: Result<number, ValidationError> = Ok(7);
    expect(isOk(result) ? result.value : -1).toBe(7);
  });
});

describe('mapOk', () => {
  it('transforms a success', () => {
    expect(mapOk(Ok(2), (n) => n * 3)).toEqual(Ok(6));
  });

  it('leaves a failure untouched and does not run the function', () => {
    let called = false;
    const result = mapOk<number, number, ValidationError>(Err(boom), (n) => {
      called = true;
      return n;
    });

    expect(called).toBe(false);
    expect(result).toEqual(Err(boom));
  });
});

describe('mapErr', () => {
  it('translates a failure', () => {
    const translated = mapErr(Err(boom), (error) => error.message.toUpperCase());
    expect(translated).toEqual(Err('BOOM'));
  });

  it('leaves a success untouched', () => {
    expect(mapErr(Ok(1), () => 'unused')).toEqual(Ok(1));
  });
});

describe('andThen', () => {
  const positive = (n: number): Result<number, ValidationError> =>
    n > 0 ? Ok(n) : Err(new ValidationError('not positive'));

  it('chains a step that succeeds', () => {
    expect(andThen(Ok(3), positive)).toEqual(Ok(3));
  });

  it('short-circuits on the first failure', () => {
    const result = andThen<number, number, ValidationError>(Err(boom), positive);
    expect(result).toEqual(Err(boom));
  });

  it('propagates a failure raised by the chained step', () => {
    const result = andThen(Ok(-1), positive);
    expect(isErr(result) && result.error.message).toBe('not positive');
  });
});

describe('unwrapOr', () => {
  it('returns the value on success', () => {
    expect(unwrapOr(Ok('a'), 'fallback')).toBe('a');
  });

  it('returns the fallback on failure', () => {
    expect(unwrapOr(Err<ValidationError>(boom), 'fallback')).toBe('fallback');
  });
});

describe('allOk', () => {
  it('collects every value when all succeed', () => {
    expect(allOk([Ok(1), Ok(2), Ok(3)])).toEqual(Ok([1, 2, 3]));
  });

  it('returns the first failure and abandons the rest', () => {
    const later = new ValidationError('later');
    const result = allOk<number, ValidationError>([Ok(1), Err(boom), Err(later)]);

    expect(isErr(result) && result.error).toBe(boom);
  });

  it('treats an empty list as success', () => {
    expect(allOk([])).toEqual(Ok([]));
  });
});

describe('expectOk', () => {
  it('returns the value on success', () => {
    expect(expectOk(Ok(42), 'reading config')).toBe(42);
  });

  it('throws with context and keeps the original error as cause', () => {
    let thrown: unknown;
    try {
      expectOk(Err(boom), 'reading config');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error('unreachable');
    expect(thrown.message).toBe('reading config: boom');
    expect(thrown.cause).toBe(boom);
  });

  it('describes a non-Error failure without crashing', () => {
    expect(() => expectOk(Err('plain string'), 'ctx')).toThrow('ctx: plain string');
  });
});
