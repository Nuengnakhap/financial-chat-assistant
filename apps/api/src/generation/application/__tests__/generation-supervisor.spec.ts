import { ConversationId, MessageId, UserId } from '@fca/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskRegistry } from '../../../bootstrap/task-registry';
import { delay } from '../../../shared/async/timeouts';
import { AppLogger, createPinoLogger } from '../../../shared/observability/app-logger';
import { GenerationSupervisor } from '../generation-supervisor';
import type { Answer } from '../ports/generation-messages.port';
import type { GenerationStops } from '../ports/generation-stops.port';
import type { RunGenerationUseCase } from '../run-generation.use-case';

/**
 * What this process is running, and what can end it. The generation itself is
 * replaced by something that waits until it is told to stop, because everything
 * here is about the two signals that reach it and the bookkeeping around them.
 */

const answerFor = (id: string): Answer => ({
  id: MessageId.trusted(id),
  conversationId: ConversationId.trusted('cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21'),
  ownerId: UserId.trusted('e5c9f4a1-1f0e-4a6a-9d4e-0c8b6a3f21d0'),
  seq: 2,
  status: 'generating',
  startedAt: new Date('2026-09-02T10:00:00.000Z'),
});

const ANSWER = answerFor('a1f0c3d2-4b5e-4a6f-9c8d-0e1f2a3b4c5d');
const OTHER = answerFor('b2e1d4c3-5c6f-4b7a-8d9e-1f2a3b4c5d6e');

const silent = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

const execute = vi.fn<(answer: Answer, signal: AbortSignal) => Promise<void>>();
const hold = vi.fn();
const release = vi.fn();
const request = vi.fn();

const generate = { execute } as unknown as RunGenerationUseCase;
const stops: GenerationStops = { hold, release, request };

let tasks: TaskRegistry;
let supervisor: GenerationSupervisor;
let stopping: AbortController;
/** Resolves the generation under test, so a test decides when it ends. */
let finish: () => void;

beforeEach(() => {
  vi.resetAllMocks();
  stopping = new AbortController();
  hold.mockImplementation(async () => await Promise.resolve(stopping.signal));
  release.mockResolvedValue(undefined);
  execute.mockImplementation(
    async () =>
      await new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  tasks = new TaskRegistry(silent);
  supervisor = new GenerationSupervisor(generate, stops, tasks);
});

describe('starting a generation', () => {
  it('runs it as background work rather than in the caller', async () => {
    const started = supervisor.begin(ANSWER);
    await delay(1);

    // The job that triggered this is free the moment it returns: a queue with
    // four consumers must not be four generations wide.
    expect(started).toBe(true);
    expect(tasks.inFlight).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);

    finish();
  });

  it('refuses a second run of the same one', async () => {
    supervisor.begin(ANSWER);
    await delay(1);

    // Delivery is at-least-once, and two runners on one message would write two
    // answers into it a token at a time.
    expect(supervisor.begin(ANSWER)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);

    finish();
  });

  it('runs a different one beside it', async () => {
    supervisor.begin(ANSWER);

    expect(supervisor.begin(OTHER)).toBe(true);

    await delay(1);
    finish();
  });

  it('lets go of everything it held, however the generation ended', async () => {
    supervisor.begin(ANSWER);
    await delay(1);

    finish();
    await delay(1);

    // A channel left subscribed is one this process keeps listening on for a
    // message that has already been answered.
    expect(release).toHaveBeenCalledWith(ANSWER.id);
    // And with the id out of the set, a later redelivery can start it again.
    expect(supervisor.begin(ANSWER)).toBe(true);
    await delay(1);
    finish();
  });

  it('lets go even when the generation throws', async () => {
    execute.mockRejectedValue(new Error('the endpoint went away'));

    supervisor.begin(ANSWER);
    await delay(1);

    expect(release).toHaveBeenCalledWith(ANSWER.id);
  });
});

describe('the two ways a generation ends early', () => {
  it('gives the work one signal for a stop and for a shutdown alike', async () => {
    supervisor.begin(ANSWER);
    await delay(1);
    const [, signal] = execute.mock.calls[0] ?? [];

    stopping.abort();

    // From inside there is nothing to tell them apart: either way it stops
    // writing, keeps what it has, and settles.
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    finish();
  });

  it('is cancelled by a shutdown that runs out of patience', async () => {
    supervisor.begin(ANSWER);
    await delay(1);
    const [, signal] = execute.mock.calls[0] ?? [];

    const drained = tasks.drain(5);
    await delay(20);

    expect(signal?.aborted).toBe(true);
    finish();
    await drained;
  });
});

describe('a process that is shutting down', () => {
  it('does not start one at all', async () => {
    await tasks.drain(5);

    expect(supervisor.begin(ANSWER)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    // Nothing was held, so nothing is left holding the message: it stays
    // `generating` and the janitor is what notices.
    expect(hold).not.toHaveBeenCalled();
  });

  it('leaves the id free for another process to pick up', async () => {
    await tasks.drain(5);
    supervisor.begin(ANSWER);

    // Refused twice, not "already running" the second time.
    expect(supervisor.begin(ANSWER)).toBe(false);
  });
});
