import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker';

/**
 * Time is a parameter here rather than something to wait for, which is what
 * makes "it reopens after fifteen seconds" a test that runs in a millisecond.
 */
function breakerAt(clock: { ms: number }): CircuitBreaker {
  return new CircuitBreaker({
    failuresBeforeOpening: 3,
    openForMs: 1_000,
    now: () => clock.ms,
  });
}

const succeed = async (): Promise<string> => await Promise.resolve('answered');
const fail = async (): Promise<string> => await Promise.reject(new Error('the endpoint is down'));

async function failTimes(breaker: CircuitBreaker, times: number): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- consecutive is the whole point
    await expect(breaker.run(fail)).rejects.toThrow();
  }
}

describe('errors that say nothing about the endpoint', () => {
  class Cancelled extends Error {}

  function breakerIgnoringCancellation(): CircuitBreaker {
    return new CircuitBreaker({
      failuresBeforeOpening: 3,
      openForMs: 1_000,
      countsAsFailure: (error) => !(error instanceof Cancelled),
      now: () => 0,
    });
  }

  const cancel = async (): Promise<string> => await Promise.reject(new Cancelled('stopped'));

  it('are passed on without being counted', async () => {
    const breaker = breakerIgnoringCancellation();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- ten in a row is the point
      await expect(breaker.run(cancel)).rejects.toThrow('stopped');
    }

    // Ten people changed their minds. The endpoint has said nothing at all, so
    // the eleventh caller still gets to ask it.
    expect(await breaker.run(succeed)).toBe('answered');
  });

  it('do not reset a count either, because they are neither thing', async () => {
    const breaker = breakerIgnoringCancellation();

    await failTimes(breaker, 2);
    await expect(breaker.run(cancel)).rejects.toThrow('stopped');
    await expect(breaker.run(fail)).rejects.toThrow('the endpoint is down');

    // Two failures, a cancellation, and a third failure: still three in a row.
    await expect(breaker.run(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('the circuit breaker', () => {
  it('passes calls through and their failures with them', async () => {
    const breaker = breakerAt({ ms: 0 });

    expect(await breaker.run(succeed)).toBe('answered');
    await expect(breaker.run(fail)).rejects.toThrow('the endpoint is down');
  });

  it('opens after enough failures in a row, and says how long for', async () => {
    const clock = { ms: 0 };
    const breaker = breakerAt(clock);

    await failTimes(breaker, 3);

    // The next caller is refused without a call being made at all.
    await expect(breaker.run(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
    clock.ms = 400;
    await expect(breaker.run(succeed)).rejects.toMatchObject({ reopensInMs: 600 });
  });

  it('counts consecutively, so a success in between resets it', async () => {
    const breaker = breakerAt({ ms: 0 });

    await failTimes(breaker, 2);
    expect(await breaker.run(succeed)).toBe('answered');
    await failTimes(breaker, 2);

    // Four failures, but never three in a row.
    expect(await breaker.run(succeed)).toBe('answered');
  });

  it('tries one call once the pause is over, and closes when it works', async () => {
    const clock = { ms: 0 };
    const breaker = breakerAt(clock);
    await failTimes(breaker, 3);

    clock.ms = 1_000;
    expect(await breaker.run(succeed)).toBe('answered');

    // Closed again: the next failure starts a fresh count rather than reopening.
    await expect(breaker.run(fail)).rejects.toThrow('the endpoint is down');
    expect(await breaker.run(succeed)).toBe('answered');
  });

  it('opens for the whole pause again when the one trial fails', async () => {
    const clock = { ms: 0 };
    const breaker = breakerAt(clock);
    await failTimes(breaker, 3);

    clock.ms = 1_000;
    await expect(breaker.run(fail)).rejects.toThrow('the endpoint is down');

    clock.ms = 1_500;
    await expect(breaker.run(succeed)).rejects.toMatchObject({ reopensInMs: 500 });
  });

  it('lets one call through the half-open door, not a hundred', async () => {
    const clock = { ms: 0 };
    const breaker = breakerAt(clock);
    await failTimes(breaker, 3);
    clock.ms = 1_000;

    // Everyone arrives in the same moment the pause ends. Without this, an
    // outage would be met by the whole waiting crowd at once.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trial = breaker.run(async () => {
      await held;
      return 'answered';
    });

    await expect(breaker.run(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    expect(await trial).toBe('answered');

    // And once the trial has answered, the door is open to everyone again.
    expect(await breaker.run(succeed)).toBe('answered');
  });
});
