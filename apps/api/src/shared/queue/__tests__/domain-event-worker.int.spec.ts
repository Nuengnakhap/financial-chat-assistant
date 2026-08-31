import type { AppConfig } from '@fca/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { until } from '../../../__tests__/until';
import { testConfig } from '../../config/__tests__/test-config';
import { AppLogger, createPinoLogger } from '../../observability/app-logger';
import type { PublishedEvent } from '../../persistence/outbox-relay';
import { BullMqOutboxPublisher } from '../bullmq-outbox-publisher';
import { DomainEventWorker } from '../domain-event-worker';
import { DOMAIN_EVENTS_QUEUE, type DomainEventHandler } from '../domain-events';

/**
 * Real Redis and the real BullMQ configuration. What is proven here is the
 * retry policy the publisher sets: a handler that fails is asked again, which
 * is the only reason a worker that dies partway through a job is survivable.
 * A fake queue would answer a question about a fake queue.
 */
const logger = new AppLogger(createPinoLogger({ level: 'silent', pretty: false }));

function redisConfig(): AppConfig {
  const url = process.env['TEST_REDIS_URL'];
  if (url === undefined) throw new Error('TEST_REDIS_URL is not set; global setup did not run');

  return { ...testConfig(), redis: { url } };
}

const EVENT: PublishedEvent = {
  id: '1',
  aggregate: 'conversation',
  aggregateId: 'cb67e0d6-2b0a-4f2e-9a3f-6a1d4f0f4d21',
  type: 'conversation.delete_requested',
  payload: {},
};

let config: AppConfig;
let redis: Redis;
let publisher: BullMqOutboxPublisher;
let worker: DomainEventWorker | null = null;

beforeAll(() => {
  config = redisConfig();
  redis = new Redis(config.redis.url);
  publisher = new BullMqOutboxPublisher(config, logger);
});
afterAll(async () => {
  await worker?.onModuleDestroy();
  await publisher.onModuleDestroy();
  await redis.quit();
});
beforeEach(async () => {
  await worker?.onModuleDestroy();
  worker = null;
  await redis.flushall();
});

const start = (handler: DomainEventHandler): DomainEventWorker => {
  const started = new DomainEventWorker(config, [handler], logger);
  started.onApplicationBootstrap();
  worker = started;

  return started;
};

describe('a job whose handler fails', () => {
  it('is asked again, and the second answer is the one that counts', async () => {
    // What a worker dying partway through a job looks like from the queue's
    // side. Without the attempts the publisher sets, the work would be lost the
    // first time the database blinked.
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error('the database was down'))
      .mockResolvedValue(undefined);
    start({ handles: 'conversation.delete_requested', handle });

    await publisher.publish([EVENT]);

    await until(() => handle.mock.calls.length >= 2, 'the retry');
    const queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection: redis });
    await until(async () => (await queue.getCompletedCount()) === 0, 'the job to finish');
    expect(await queue.getFailedCount()).toBe(0);
    await queue.close();
  });
});

describe('the same event published twice', () => {
  it('runs once while the first job is still queued', async () => {
    // The narrowing the outbox row id buys: a relay that crashed between
    // publishing and marking republishes, and the queue recognises the id.
    const queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection: redis });

    await publisher.publish([EVENT]);
    await publisher.publish([EVENT]);

    expect(await queue.getWaitingCount()).toBe(1);
    await queue.close();
  });

  it('runs again once the first has been consumed, so the handler has to be idempotent', async () => {
    // The half of at-least-once that no queue can take away: a completed job is
    // gone, and an event redelivered after that is a new one.
    const handle = vi.fn().mockResolvedValue(undefined);
    start({ handles: 'conversation.delete_requested', handle });

    await publisher.publish([EVENT]);
    await until(() => handle.mock.calls.length === 1, 'the first delivery');
    await publisher.publish([EVENT]);

    await until(() => handle.mock.calls.length === 2, 'the redelivery');
  });
});
