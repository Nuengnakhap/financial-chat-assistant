import { describe, expect, it } from 'vitest';

import { AppLogger, createPinoLogger } from '../../shared/observability/app-logger';
import { runShutdown, type Refusable, type ShutdownTarget, type Windable } from '../shutdown';
import { TaskRegistry } from '../task-registry';

const TIMINGS = { readinessGraceMs: 0, connectionCloseTimeoutMs: 1_000, drainTimeoutMs: 1_000 };

interface Harness {
  steps: string[];
  readiness: Refusable & { accepting: boolean };
  streams: Windable;
  tasks: TaskRegistry;
  target: ShutdownTarget;
  logger: AppLogger;
}

function harness(): Harness {
  const steps: string[] = [];
  const logger = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));
  const readiness = {
    accepting: true,
    refuse(): void {
      this.accepting = false;
    },
  };

  return {
    steps,
    readiness,
    logger,
    streams: {
      windDown: () => {
        steps.push('wind-down-streams');
        return Promise.resolve();
      },
    },
    tasks: new TaskRegistry(logger),
    target: {
      stopAcceptingRequests: () => {
        steps.push('stop-accepting');
        return Promise.resolve();
      },
      cutConnections: () => {
        steps.push('cut-connections');
      },
      release: () => {
        steps.push('release');
        return Promise.resolve();
      },
    },
  };
}

describe('the shutdown sequence', () => {
  it('stops taking requests before it releases anything they depend on', async () => {
    const { steps, readiness, streams, tasks, target, logger } = harness();
    // Slow enough that it cannot have finished before the sequence starts,
    // which is what makes the order below an observation rather than a
    // coincidence of scheduling.
    tasks.spawn('work', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      steps.push('task-finished');
    });

    await runShutdown({ target, readiness, streams, tasks, logger, timings: TIMINGS });

    expect(steps).toEqual(['wind-down-streams', 'stop-accepting', 'task-finished', 'release']);
  });

  it('refuses readiness first, while everything still works', async () => {
    const { readiness, tasks, logger, streams } = harness();
    let readyWhenConnectionsClosed: boolean | undefined;

    const target: ShutdownTarget = {
      stopAcceptingRequests: () => {
        readyWhenConnectionsClosed = readiness.accepting;
        return Promise.resolve();
      },
      cutConnections: () => undefined,
      release: () => Promise.resolve(),
    };

    await runShutdown({ target, readiness, streams, tasks, logger, timings: TIMINGS });

    // A probe answered after this point must already say "do not send me traffic".
    expect(readyWhenConnectionsClosed).toBe(false);
  });

  it('lets a background task finish with its pools still open', async () => {
    const { readiness, tasks, logger, target, streams } = harness();
    let releasedBeforeTaskFinished = false;
    let released = false;

    tasks.spawn('persisting', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      releasedBeforeTaskFinished = released;
    });

    await runShutdown({
      readiness,
      streams,
      tasks,
      logger,
      timings: TIMINGS,
      target: {
        ...target,
        release: () => {
          released = true;
          return Promise.resolve();
        },
      },
    });

    expect(releasedBeforeTaskFinished).toBe(false);
    expect(released).toBe(true);
  });

  it('lets its event streams go before it stops accepting connections', async () => {
    const { steps, readiness, streams, tasks, target, logger } = harness();

    await runShutdown({ target, readiness, streams, tasks, logger, timings: TIMINGS });

    // The other order spends the whole connection-close budget waiting for
    // readers that are never going to leave on their own, and the steps that
    // persist and settle a generation all come after that one.
    expect(steps.indexOf('wind-down-streams')).toBeLessThan(steps.indexOf('stop-accepting'));
  });

  it('waits out the readiness grace before cutting traffic', async () => {
    const { readiness, streams, tasks, target, logger } = harness();
    const started = Date.now();

    await runShutdown({
      target,
      streams,
      readiness,
      tasks,
      logger,
      timings: { ...TIMINGS, readinessGraceMs: 40 },
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});

describe('when a connection will not close', () => {
  it('cuts it rather than letting one client hold the whole sequence open', async () => {
    const { steps, readiness, tasks, logger, target, streams } = harness();
    let finishClosing = (): void => undefined;

    await runShutdown({
      readiness,
      streams,
      tasks,
      logger,
      timings: { ...TIMINGS, connectionCloseTimeoutMs: 20 },
      target: {
        ...target,
        // A stream, or a client that stopped reading: the server never finishes closing.
        stopAcceptingRequests: () =>
          new Promise<void>((resolve) => {
            finishClosing = resolve;
          }),
        cutConnections: () => {
          steps.push('cut-connections');
          finishClosing();
        },
      },
    });

    expect(steps).toEqual(['wind-down-streams', 'cut-connections', 'release']);
  });

  it('still releases the pools when even cutting does not help', async () => {
    const { steps, readiness, tasks, logger, target, streams } = harness();

    await runShutdown({
      readiness,
      streams,
      tasks,
      logger,
      timings: { ...TIMINGS, connectionCloseTimeoutMs: 20 },
      target: {
        ...target,
        stopAcceptingRequests: () => new Promise<void>(() => undefined),
      },
    });

    // The pools are what a restart cannot recover on its own.
    expect(steps).toEqual(['wind-down-streams', 'cut-connections', 'release']);
  }, 10_000);
});
