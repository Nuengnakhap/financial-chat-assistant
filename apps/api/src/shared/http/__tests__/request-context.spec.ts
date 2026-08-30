import { describe, expect, it } from 'vitest';

import {
  currentPrincipal,
  currentRequestId,
  runWithRequestContext,
  setPrincipal,
  toRequestId,
} from '../request-context';

const PRINCIPAL = {
  userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' as never,
  sessionId: '01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d' as never,
};

describe('carrying who is calling', () => {
  it('reaches everything inside the request the guard recorded it in', () => {
    const seen = runWithRequestContext({ requestId: 'req-1', principal: null }, () => {
      setPrincipal(PRINCIPAL);
      return currentPrincipal();
    });

    expect(seen).toEqual(PRINCIPAL);
  });

  it('is null before a guard has run', () => {
    expect(
      runWithRequestContext({ requestId: 'req-1', principal: null }, () => currentPrincipal()),
    ).toBeNull();
  });

  it('does not leak out of the request that set it', () => {
    runWithRequestContext({ requestId: 'req-1', principal: null }, () => {
      setPrincipal(PRINCIPAL);
    });

    expect(currentPrincipal()).toBeNull();
  });

  it('is a no-op outside a request rather than a crash', () => {
    // Background work has no caller; recording one must not be what stops a
    // task from running.
    expect(() => {
      setPrincipal(PRINCIPAL);
    }).not.toThrow();
    expect(currentPrincipal()).toBeNull();
  });
});

describe('reading the current request id', () => {
  it('returns the id inside a request', () => {
    expect(
      runWithRequestContext({ requestId: 'req-1', principal: null }, () => currentRequestId()),
    ).toBe('req-1');
  });

  it('returns a placeholder outside one, rather than throwing', () => {
    // A log line from a background task is still worth having, and a missing id
    // must never be the reason an error goes unreported.
    expect(currentRequestId()).toBe('no-request');
  });

  it('keeps nested scopes apart', () => {
    const seen = runWithRequestContext({ requestId: 'outer', principal: null }, () => [
      currentRequestId(),
      runWithRequestContext({ requestId: 'inner', principal: null }, () => currentRequestId()),
      currentRequestId(),
    ]);

    expect(seen).toEqual(['outer', 'inner', 'outer']);
  });
});

describe('accepting an inbound request id', () => {
  it('keeps a well-formed one so a trace continues across services', () => {
    expect(toRequestId('trace-abc_123')).toBe('trace-abc_123');
  });

  it.each([
    ['a header that is absent', undefined],
    ['an array of headers', ['a', 'b']],
    ['an empty string', ''],
    ['a newline, which would forge a log line', 'trace\ninjected=1'],
    ['a carriage return', 'trace\rinjected=1'],
    ['a space', 'trace injected'],
    ['a value longer than any real id', 'x'.repeat(129)],
  ])('generates a fresh one for %s', (_name, header) => {
    const generated = toRequestId(header);

    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });
});
