import { describe, expect, it } from 'vitest';

import {
  codeForHttpStatus,
  messageForCode,
  statusForDomainCode,
  type ApiErrorCode,
} from '../api-response';

const ALL_CODES: readonly ApiErrorCode[] = [
  'validation',
  'not_found',
  'conflict',
  'forbidden',
  'invalid_transition',
  'budget_exceeded',
  'unverifiable',
  'bad_request',
  'unauthorized',
  'internal',
];

describe('a domain code becomes a status', () => {
  it.each([
    ['validation', 400],
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['invalid_transition', 409],
    ['unverifiable', 422],
    ['budget_exceeded', 429],
  ] as const)('%s answers %i', (code, status) => {
    expect(statusForDomainCode(code)).toBe(status);
  });
});

describe('a framework status becomes a code', () => {
  it.each([
    [400, 'bad_request'],
    [413, 'bad_request'],
    [415, 'bad_request'],
    [422, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
  ] as const)('%i is reported as %s', (status, code) => {
    expect(codeForHttpStatus(status)).toBe(code);
  });

  it.each([405, 429, 500, 502, 503])('%i has no equivalent, so it stays internal', (status) => {
    // 429 in particular: a rate limiter is not a spent budget, and calling it
    // one would tell a client to check a usage page that is not the problem.
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
