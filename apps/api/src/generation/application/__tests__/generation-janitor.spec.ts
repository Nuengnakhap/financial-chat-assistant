import { Writable } from 'node:stream';

import { MessageId } from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskRegistry } from '../../../bootstrap/task-registry';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { GenerationJanitor } from '../generation-janitor';
import type { EndAbandonedGenerationsUseCase } from '../use-cases/end-abandoned-generations.use-case';

/**
 * The schedule, not the decision — what to end has its own spec. The same shape
 * as `SessionJanitor`, so shutdown waits for a sweep in progress and cancels one
 * that is only sleeping.
 */

const ENDED = MessageId.trusted('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d');

const logs: string[] = [];
const logger = new AppLogger(
  createPinoLogger({
    level: 'debug',
    pretty: false,
    destination: new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    }),
  }),
);

const execute = vi.fn();
const endAbandoned = { execute } as unknown as EndAbandonedGenerationsUseCase;

let tasks: TaskRegistry;
let janitor: GenerationJanitor;

beforeEach(() => {
  vi.resetAllMocks();
  logs.length = 0;
  execute.mockResolvedValue([]);
  tasks = new TaskRegistry(logger);
  janitor = new GenerationJanitor(endAbandoned, tasks, logger);
});

describe('sweeping', () => {
  it('keeps going, one sweep at a time', async () => {
    const controller = new AbortController();
    const looping = janitor.loop(controller.signal, 1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await looping;

    // Two sweeps at once would fight over the same rows; the wait between them
    // is the schedule rather than an accident.
    expect(execute.mock.calls.length).toBeGreaterThan(1);
  });

  it('says which generation it ended, because each one is somebody watching', async () => {
    execute.mockResolvedValue([ENDED]);
    const controller = new AbortController();
    const looping = janitor.loop(controller.signal, 1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await looping;

    expect(logs.join('')).toContain('nothing was writing any more');
    expect(logs.join('')).toContain(ENDED);
  });

  it('carries on after a sweep that failed', async () => {
    execute.mockRejectedValueOnce(new Error('the database went away'));
    const controller = new AbortController();
    const looping = janitor.loop(controller.signal, 1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await looping;

    // One failed sweep is one more minute of a stuck row, not a reason to stop
    // sweeping for the lifetime of the process.
    expect(logs.join('')).toContain('generation sweep failed');
    expect(execute.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops when it is cancelled rather than waiting out the interval', async () => {
    const controller = new AbortController();
    const looping = janitor.loop(controller.signal, 3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 5));

    controller.abort();

    // An hour of sleep would otherwise be an hour of shutdown.
    await expect(looping).resolves.toBeUndefined();
  });
});

describe('registering itself', () => {
  it('runs as background work, so shutdown knows it is there', () => {
    janitor.onApplicationBootstrap();

    expect(tasks.inFlight).toBe(1);
  });
});
