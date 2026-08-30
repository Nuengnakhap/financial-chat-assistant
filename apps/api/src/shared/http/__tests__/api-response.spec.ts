import { describe, expect, it } from 'vitest';

import {
  codeForHttpStatus,
  messageForCode,
  statusForDomainCode,
  type ApiErrorCode,
} from '../api-response';

const ALL_CODES: readonly ApiErrorCode[] = [
  'validation',
  'unauthenticated',
  'not_found',
  'conflict',
  'forbidden',
  'invalid_transition',
  'rate_limited',
  'budget_exceeded',
  'unverifiable',
  'bad_request',
  'internal',
];

describe('a domain code becomes a status', () => {
  it.each([
    ['validation', 400],
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['invalid_transition', 409],
    ['unverifiable', 422],
    ['rate_limited', 429],
    ['budget_exceeded', 429],
  ] as const)('%s answers %i', (code, status) => {
    expect(statusForDomainCode(code)).toBe(status);
  });

  it('gives 429 two codes on purpose', () => {
    // Same status, different advice: one says wait, the other says you are done
    // for this window. A client that cannot tell them apart retries the wrong one.
    expect(statusForDomainCode('rate_limited')).toBe(statusForDomainCode('budget_exceeded'));
    expect(messageForCode('rate_limited')).not.toBe(messageForCode('budget_exceeded'));
  });
});

describe('a framework status becomes a code', () => {
  it.each([
    [400, 'bad_request'],
    [413, 'bad_request'],
    [415, 'bad_request'],
    [422, 'bad_request'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    // A rate limiter, never a spent budget: calling it one would send a client
    // to a usage page that is not the problem.
    [429, 'rate_limited'],
  ] as const)('%i is reported as %s', (status, code) => {
    expect(codeForHttpStatus(status)).toBe(code);
  });

  it.each([405, 500, 502, 503])('%i has no equivalent, so it stays internal', (status) => {
    expect(codeForHttpStatus(status)).toBe('internal');
  });
});

describe('public wording', () => {
  it('exists for every code a caller can receive', () => {
    for (const code of ALL_CODES) {
      expect(messageForCode(code).length).toBeGreaterThan(10);
    }
  });

  it('never names an internal concept', () => {
    const everyMessage = ALL_CODES.map((code) => messageForCode(code))
      .join(' ')
      .toLowerCase();

    for (const leak of ['sql', 'postgres', 'redis', 'token', 'exception', 'null', 'undefined']) {
      expect(everyMessage).not.toContain(leak);
    }
  });

  it('ends every sentence, so a client can concatenate without guessing', () => {
    for (const code of ALL_CODES) {
      expect(messageForCode(code)).toMatch(/[.!?]$/);
    }
  });
});
