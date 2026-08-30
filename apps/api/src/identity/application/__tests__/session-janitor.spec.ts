import { describe, expect, it, vi } from 'vitest';

import { TaskRegistry } from '../../../bootstrap/task-registry';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { SessionJanitor } from '../session-janitor';
import type { PurgeDeadSessionsUseCase } from '../use-cases/purge-dead-sessions.use-case';

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

const janitorWith = (execute: () => Promise<number>) => {
  const tasks = new TaskRegistry(silent);
  const purge = { execute } as unknown as PurgeDeadSessionsUseCase;

  return { janitor: new SessionJanitor(purge, tasks, silent), tasks };
};

describe('the session janitor', () => {
  it('keeps sweeping until it is cancelled', async () => {
    const execute = vi.fn(() => Promise.resolve(0));
    const { janitor } = janitorWith(execute);
    const abort = new AbortController();

    const loop = janitor.loop(abort.signal, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await loop;

    expect(execute.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops sleeping the moment it is cancelled, rather than after the interval', async () => {
    const { janitor } = janitorWith(() => Promise.resolve(0));
    const abort = new AbortController();

    const started = Date.now();
    const loop = janitor.loop(abort.signal, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();
    await loop;

    // Otherwise shutdown would wait out a full interval for a task that is
    // doing nothing at all.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('survives a sweep that throws', async () => {
    let calls = 0;
    const { janitor } = janitorWith(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('database is down')) : Promise.resolve(0);
    });
    const abort = new AbortController();

    const loop = janitor.loop(abort.signal, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await loop;

    // A janitor that stops after one bad night is one nobody notices has stopped.
    expect(calls).toBeGreaterThan(1);
  });

  it('reports a sweep that removed something', async () => {
    const execute = vi.fn(() => Promise.resolve(4));
    const { janitor } = janitorWith(execute);
    const abort = new AbortController();

    const loop = janitor.loop(abort.signal, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    await loop;

    expect(execute).toHaveBeenCalled();
  });

  it('does not begin sleeping when the sweep itself was the last thing wanted', async () => {
    const abort = new AbortController();
    // Cancelled while the sweep is running: the loop must return rather than
    // start an interval nobody is waiting out.
    const { janitor } = janitorWith(() => {
      abort.abort();
      return Promise.resolve(0);
    });

    const started = Date.now();
    await janitor.loop(abort.signal, 60_000);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('registers with the task registry so shutdown can wait for it', () => {
    const { janitor, tasks } = janitorWith(() => Promise.resolve(0));

    janitor.onApplicationBootstrap();

    expect(tasks.inFlight).toBe(1);
  });

  it('does not start once shutdown has begun', async () => {
    const execute = vi.fn(() => Promise.resolve(0));
    const { janitor, tasks } = janitorWith(execute);
    await tasks.drain(10);

    janitor.onApplicationBootstrap();

    expect(tasks.inFlight).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
