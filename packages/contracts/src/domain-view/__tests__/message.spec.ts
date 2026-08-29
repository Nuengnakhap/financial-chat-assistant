import { describe, expect, it } from 'vitest';

import { messageView } from '../message';

const report = { verdict: 'pass' as const, checkedClaims: [], violations: [] };

const base = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  conversationId: '01936d1e-8f7a-7c3e-b8d4-9a1e2f3b4c5d',
  seq: 1,
  parts: [],
  usage: null,
  error: null,
  createdAt: '2026-08-29T12:00:00.000Z',
};

const parse = (overrides: Record<string, unknown>) =>
  messageView.safeParse({ ...base, ...overrides }).success;

describe('a complete assistant message always carries its evidence', () => {
  it('accepts complete with a report', () => {
    expect(parse({ role: 'assistant', status: 'complete', verification: report })).toBe(true);
  });

  it('refuses to describe a finished answer with no evidence behind it', () => {
    // The wire form of the rule the database will also hold: an answer the user
    // sees as finished and an answer that was checked are the same thing.
    expect(parse({ role: 'assistant', status: 'complete', verification: null })).toBe(false);
  });

  it('refuses a report on an answer that never finished', () => {
    for (const status of ['generating', 'stopped', 'error']) {
      expect(parse({ role: 'assistant', status, verification: report })).toBe(false);
    }
  });

  it('accepts an unfinished assistant message with no report', () => {
    for (const status of ['generating', 'stopped', 'error']) {
      expect(parse({ role: 'assistant', status, verification: null })).toBe(true);
    }
  });
});

describe('user messages', () => {
  it('never carry a verification report, since nothing was generated', () => {
    expect(parse({ role: 'user', status: 'complete', verification: null })).toBe(true);
    expect(parse({ role: 'user', status: 'complete', verification: report })).toBe(false);
  });
});

describe('error payloads', () => {
  it('reject a blank code, which cannot mean anything to a client', () => {
    const withError = (code: string) =>
      parse({
        role: 'assistant',
        status: 'error',
        verification: null,
        error: { code, message: 'Generation failed.' },
      });

    expect(withError('llm_unavailable')).toBe(true);
    expect(withError('')).toBe(false);
  });
});
