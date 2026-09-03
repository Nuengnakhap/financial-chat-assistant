import type { DomainEventType } from '@fca/domain';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { testConfig } from '../../config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import type { PublishedEvent } from '../../persistence/outbox-relay';
import { DomainEventWorker } from '../domain-event-worker';
import type { DomainEventHandler } from '../domain-events';

const logger = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

const EVENT: PublishedEvent = {
  id: '42',
  aggregate: 'conversation',
  aggregateId: 'cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21',
  type: 'conversation.delete_requested',
  payload: {},
};

/** Only `data` and `name` are read; a real `Job` carries a broker with it. */
const jobOf = (data: unknown): Job =>
  ({ name: 'conversation.delete_requested', data }) as unknown as Job;

function handlerFor(handles: DomainEventType, handle = vi.fn()): DomainEventHandler {
  return { handles, handle };
}

/**
 * The dispatch, without a broker. Starting a real `Worker` needs Redis and is
 * what the pipeline integration test covers; what is decided here is which
 * handler runs, and what happens when none does.
 */
const workerWith = (handlers: readonly DomainEventHandler[]): DomainEventWorker =>
  new DomainEventWorker(testConfig(), handlers, logger);

describe('wiring the handlers', () => {
  it('refuses two that claim the same event type', () => {
    // A map keeps the last of two entries with one key, so the other would
    // never be called and nothing would say so. The composition root guards
    // against exactly this one level up; this is the level below it.
    expect(() =>
      workerWith([
        handlerFor('conversation.delete_requested'),
        handlerFor('conversation.delete_requested'),
      ]),
    ).toThrow('same event type');
  });

  it('accepts one for each type', () => {
    expect(() =>
      workerWith([handlerFor('conversation.delete_requested'), handlerFor('generation.requested')]),
    ).not.toThrow();
  });
});

describe('a domain event job', () => {
  it('reaches the handler that says it consumes that type', async () => {
    const wanted = vi.fn();
    const other = vi.fn();

    // The wanted one is second on purpose: first in the list is what a
    // dispatch that ignores the type would reach for, and it would look right.
    await workerWith([
      handlerFor('generation.requested', other),
      handlerFor('conversation.delete_requested', wanted),
    ]).run(jobOf(EVENT));

    expect(wanted).toHaveBeenCalledWith(EVENT);
    expect(other).not.toHaveBeenCalled();
  });

  it('is finished rather than failed when nobody consumes that type', async () => {
    // The outbox records every type the domain has. Five retries and a
    // permanent failure for an event nothing listens for would make the failed
    // set a list of things working as intended.
    const unrelated = vi.fn();

    await expect(
      workerWith([handlerFor('generation.requested', unrelated)]).run(jobOf(EVENT)),
    ).resolves.toBe(undefined);

    // Finishing quietly is only right if nothing ran. Without this the test
    // passes just as happily when every handler is called for every event.
    expect(unrelated).not.toHaveBeenCalled();
  });

  it('fails a job it cannot read, rather than passing the pieces on', async () => {
    const handle = vi.fn();

    await expect(
      workerWith([handlerFor('conversation.delete_requested', handle)]).run(
        jobOf({ ...EVENT, type: 'conversation.exploded' }),
      ),
    ).rejects.toThrow('unreadable');
    expect(handle).not.toHaveBeenCalled();
  });

  it('fails a job whose payload is not JSON, since it cannot have come from the outbox', async () => {
    await expect(
      workerWith([handlerFor('conversation.delete_requested')]).run(
        jobOf({ ...EVENT, payload: { when: new Date() } }),
      ),
    ).rejects.toThrow('unreadable');
  });

  it('lets a handler failure through, so the queue retries it', async () => {
    const angry = vi.fn().mockRejectedValue(new Error('the database was down'));

    await expect(
      workerWith([handlerFor('conversation.delete_requested', angry)]).run(jobOf(EVENT)),
    ).rejects.toThrow('the database was down');
  });
});
