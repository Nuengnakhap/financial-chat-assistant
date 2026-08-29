import { describe, expect, it } from 'vitest';

import { currentRequestId, runWithRequestContext, toRequestId } from '../request-context';

describe('reading the current request id', () => {
  it('returns the id inside a request', () => {
    expect(runWithRequestContext({ requestId: 'req-1' }, () => currentRequestId())).toBe('req-1');
  });

  it('returns a placeholder outside one, rather than throwing', () => {
    // A log line from a background task is still worth having, and a missing id
    // must never be the reason an error goes unreported.
    expect(currentRequestId()).toBe('no-request');
  });

  it('keeps nested scopes apart', () => {
    const seen = runWithRequestContext({ requestId: 'outer' }, () => [
      currentRequestId(),
      runWithRequestContext({ requestId: 'inner' }, () => currentRequestId()),
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
