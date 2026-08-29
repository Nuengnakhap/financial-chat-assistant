import { describe, expect, it } from 'vitest';

import { AppLogger, createPinoLogger } from '../../shared/observability/app-logger';
import { TaskRegistry } from '../task-registry';

const silent = (): AppLogger => new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('tracking work', () => {
  it('counts a task until it finishes', async () => {
    const registry = new TaskRegistry(silent());
    const work = deferred();

    registry.spawn('generation', () => work.promise);
    expect(registry.inFlight).toBe(1);

    work.resolve();
    await registry.drain(1_000);

    expect(registry.inFlight).toBe(0);
  });

  it('keeps tasks that share a name apart', async () => {
    const registry = new TaskRegistry(silent());
    const first = deferred();
    const second = deferred();

    registry.spawn('generation', () => first.promise);
    registry.spawn('generation', () => second.promise);

    expect(registry.inFlight).toBe(2);
    first.resolve();
    second.resolve();
    await registry.drain(1_000);
  });

  it('survives a task that throws before it ever returns a promise', async () => {
    const registry = new TaskRegistry(silent());

    expect(
      registry.spawn('broken', () => {
        throw new Error('synchronous failure');
      }),
    ).toBe(true);

    await expect(registry.drain(1_000)).resolves.toBeUndefined();
  });

  it('does not let a failing task take the process with it', async () => {
    const registry = new TaskRegistry(silent());

    registry.spawn('failing', () => Promise.reject(new Error('boom')));

    await expect(registry.drain(1_000)).resolves.toBeUndefined();
  });

  it('logs a rejection that is not an Error, rather than dropping it', async () => {
    const logger = silent();
    const failures: string[] = [];
    logger.error = (message: string): void => {
      failures.push(message);
    };
    const registry = new TaskRegistry(logger);

    // A library that rejects with a string still has to be reportable, which is
    // the case the rule below exists to prevent us from writing on purpose.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    registry.spawn('sloppy', () => Promise.reject('a bare string'));

    await registry.drain(1_000);

    expect(failures).toEqual(['background task failed']);
  });
});

describe('draining', () => {
  it('waits for work that is still running', async () => {
    const registry = new TaskRegistry(silent());
    const work = deferred();
    let finished = false;

    registry.spawn('slow', async () => {
      await work.promise;
      finished = true;
    });
    setTimeout(work.resolve, 20);

    await registry.drain(1_000);

    expect(finished).toBe(true);
  });

  it('returns at once when there is nothing to wait for', async () => {
    const registry = new TaskRegistry(silent());

    await expect(registry.drain(60_000)).resolves.toBeUndefined();
  });

  it('cancels a task that outstays the budget, and returns anyway', async () => {
    const registry = new TaskRegistry(silent());
    let cancelled = false;

    registry.spawn(
      'stubborn',
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            cancelled = true;
            resolve();
          });
        }),
    );

    await registry.drain(20);

    expect(cancelled).toBe(true);
  });

  it('gives up on a task that ignores cancellation rather than hanging', async () => {
    const registry = new TaskRegistry(silent());
    registry.spawn('deaf', () => new Promise<void>(() => undefined));

    // The second wait is the cancellation grace, which is why this is not instant.
    await expect(registry.drain(10)).resolves.toBeUndefined();
    expect(registry.inFlight).toBe(1);
  }, 10_000);
});

describe('once shutdown has begun', () => {
  it('refuses new work, so nothing starts that would then be abandoned', async () => {
    const registry = new TaskRegistry(silent());
    await registry.drain(1_000);

    let started = false;
    const accepted = registry.spawn('late', () => {
      started = true;
      return Promise.resolve();
    });

    expect(accepted).toBe(false);
    expect(started).toBe(false);
    expect(registry.inFlight).toBe(0);
  });
});
