import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CpuPool, defaultCpuPoolOptions, type CpuPoolOptions } from '../cpu-pool';

const FAKE_WORKER = resolve(__dirname, 'fake-cpu-worker.cjs');

const pools: CpuPool[] = [];

function poolWith(overrides: Partial<CpuPoolOptions> = {}): CpuPool {
  const pool = new CpuPool({ ...defaultCpuPoolOptions(), ...overrides });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.onModuleDestroy()));
});

describe('counting tokens', () => {
  it('returns the count the model will be billed for', async () => {
    const pool = poolWith();

    // Pinned rather than recomputed in the test: the number is what a budget
    // reservation is built on, so a tokenizer upgrade that changes it must fail
    // here rather than quietly change what a user is charged.
    expect(await pool.countTokens('Revenue of Apple in 2024')).toBe(7);
    expect(await pool.countTokens('')).toBe(0);
  });

  it('leaves the event loop free while it works', async () => {
    const pool = poolWith();
    // Long enough that tokenizing it on this thread would be plainly visible.
    const text = 'Revenue of Apple in 2024. '.repeat(20_000);

    let timerFiredFirst = false;
    const counting = pool.countTokens(text);
    setTimeout(() => {
      timerFiredFirst = true;
    }, 0);

    expect(await counting).toBeGreaterThan(100_000);
    expect(timerFiredFirst).toBe(true);
  });
});

describe('when the pool is saturated', () => {
  it('rejects immediately rather than queueing work past its deadline', async () => {
    const pool = poolWith({ workerFile: FAKE_WORKER, maxThreads: 1, maxQueue: 1 });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => pool.countTokens('slow')),
    );

    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.reason).toMatchObject({ message: 'Task queue is at limit' });
  });
});

describe('cancellation', () => {
  it('gives up on a task whose caller has already gone', async () => {
    const pool = poolWith({ workerFile: FAKE_WORKER, maxThreads: 1 });
    const abort = new AbortController();

    const counting = pool.countTokens('slow', abort.signal);
    abort.abort();

    await expect(counting).rejects.toThrow();
  });
});

describe('when a worker answers with the wrong type', () => {
  it('fails loudly instead of passing it on as a token count', async () => {
    const pool = poolWith({ workerFile: FAKE_WORKER });

    await expect(pool.countTokens('anything')).rejects.toThrow(
      'cpu worker returned string for countTokens',
    );
  });
});
