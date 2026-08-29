import { describe, expect, it } from 'vitest';

import { checkAll } from '../health-indicator';

describe('checking dependencies', () => {
  it('reports nothing when everything answers', async () => {
    expect(await checkAll([{ name: 'db', check: () => Promise.resolve() }], 100)).toEqual([]);
  });

  it('names each failure and why', async () => {
    const failures = await checkAll(
      [
        { name: 'db', check: () => Promise.resolve() },
        { name: 'redis', check: () => Promise.reject(new Error('ECONNREFUSED')) },
      ],
      100,
    );

    expect(failures).toEqual([{ name: 'redis', reason: 'ECONNREFUSED' }]);
  });

  it('describes a rejection that is not an Error', async () => {
    // A library that rejects with a string must not turn the probe into a crash,
    // which is exactly the shape the rule below forbids us from writing on purpose.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const failures = await checkAll([{ name: 'odd', check: () => Promise.reject('nope') }], 100);

    expect(failures).toEqual([{ name: 'odd', reason: 'nope' }]);
  });

  it('treats silence as a failure, with the timeout in the reason', async () => {
    const failures = await checkAll(
      [{ name: 'stalled', check: () => new Promise<void>(() => undefined) }],
      20,
    );

    expect(failures[0]?.name).toBe('stalled');
    expect(failures[0]?.reason).toContain('timed out');
  });

  it('runs them in parallel, so ten slow checks are not ten timeouts', async () => {
    const indicators = Array.from({ length: 10 }, (_unused, index) => ({
      name: `dep-${String(index)}`,
      check: () => new Promise<void>(() => undefined),
    }));

    const started = Date.now();
    const failures = await checkAll(indicators, 50);

    expect(failures).toHaveLength(10);
    expect(Date.now() - started).toBeLessThan(400);
  });
});
