import { describe, expect, it } from 'vitest';

import { Counters } from '../counters';

/**
 * The numbers two layers of the security model were written against and never
 * had. What is worth pinning is the shape rather than the arithmetic: that a
 * label cannot be a value from a request, and that a reading is stable.
 */

describe('what this process has seen', () => {
  it('starts at nothing rather than at zeroes for every name', () => {
    // A name that has never happened is absent, not `0`. A wall of zeroes is
    // what a reader has to scroll past to find the one number that moved.
    expect(new Counters().snapshot()).toEqual({});
  });

  it('counts', () => {
    const counters = new Counters();
    counters.count('grounding.violation');
    counters.count('grounding.violation');
    counters.count('generation.draft_reset');

    expect(counters.snapshot()).toEqual({
      'generation.draft_reset': 1,
      'grounding.violation': 2,
    });
  });

  it('keeps a labelled count apart from the same name unlabelled', () => {
    const counters = new Counters();
    counters.count('sql.refused', 'table');
    counters.count('sql.refused', 'syntax');
    counters.count('sql.refused', 'table');

    // Per rule, because a spike in `table` is a model with a broken idea of the
    // schema and a spike in `syntax` is somebody probing. One number for both
    // says a thing is happening and not which.
    expect(counters.snapshot()).toEqual({
      'sql.refused{syntax}': 1,
      'sql.refused{table}': 2,
    });
  });

  it('reads the same twice for a process that has not moved', () => {
    const counters = new Counters();
    counters.count('send.throttled');
    counters.count('budget.denied');

    expect(JSON.stringify(counters.snapshot())).toBe(JSON.stringify(counters.snapshot()));
  });

  it('is sorted, so two readings can be diffed by eye', () => {
    const counters = new Counters();
    counters.count('send.throttled');
    counters.count('budget.denied');
    counters.count('grounding.violation');

    expect(Object.keys(counters.snapshot())).toEqual([
      'budget.denied',
      'grounding.violation',
      'send.throttled',
    ]);
  });
});
