import { describe, expect, it, vi } from 'vitest';

import { delay, settledWithin, withTimeout } from '../timeouts';

const never = (): Promise<never> => new Promise<never>(() => undefined);

describe('withTimeout', () => {
  it('passes the value through when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, 'work')).resolves.toBe(7);
  });

  it('passes a rejection through unchanged', async () => {
    const failure = new Error('the real reason');

    await expect(withTimeout(Promise.reject(failure), 1_000, 'work')).rejects.toBe(failure);
  });

  it('names the operation and the budget it exceeded', async () => {
    await expect(withTimeout(never(), 5, 'publish')).rejects.toThrow('publish timed out after 5ms');
  });

  it('clears the timer once the work settles, so it cannot hold the process open', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');

    await withTimeout(Promise.resolve('done'), 60_000, 'work');

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe('settledWithin', () => {
  it('reports true however the work settled, because only the waiting is in question', async () => {
    await expect(settledWithin(Promise.resolve(), 1_000)).resolves.toBe(true);
    await expect(settledWithin(Promise.reject(new Error('failed')), 1_000)).resolves.toBe(true);
  });

  it('reports false when the work is still running', async () => {
    await expect(settledWithin(never(), 5)).resolves.toBe(false);
  });
});

describe('delay', () => {
  it('resolves after the interval', async () => {
    const started = Date.now();

    await delay(20);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
