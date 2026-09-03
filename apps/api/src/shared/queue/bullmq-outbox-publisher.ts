import type { AppConfig } from '@fca/config';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { DOMAIN_EVENTS_QUEUE } from './domain-events';
import { queueConnection } from './queue-connection';
import { settledWithin } from '../async/timeouts';
import { APP_CONFIG } from '../config/app-config.token';
import { AppLogger } from '../observability/app-logger';
import type { OutboxPublisher, PublishedEvent } from '../persistence/outbox-relay';

/**
 * A job that keeps failing stops being retried and stays visible instead of
 * disappearing: five attempts, spread out, and the failure kept for reading.
 */
const ATTEMPTS = 5;
const BACKOFF_MS = 1_000;
/** Enough failures to see a pattern, not so many that Redis becomes the archive. */
const KEEP_FAILED = 500;

/** Long enough for a write already under way, short enough to be a bound. */
const CLOSE_TIMEOUT_MS = 2_000;

/**
 * BullMQ refuses two kinds of custom job id, and the obvious choice is both of
 * them. An integer is reserved for the ids it generates itself, and the outbox
 * id is a `bigserial`, so every one of them reads as one; a colon is what it
 * builds its own Redis keys out of. Measured against a real broker rather than
 * read: `addBulk` answered `Custom Id cannot be integers`, and then `Custom Id
 * cannot contain :`. A dash is neither, and it says where the id came from.
 */
const jobIdFor = (eventId: string): string => `outbox-${eventId}`;

@Injectable()
export class BullMqOutboxPublisher implements OutboxPublisher, OnModuleDestroy {
  private readonly queue: Queue;
  private readonly connection: Redis;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: AppLogger,
  ) {
    this.connection = queueConnection(config);
    this.queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection: this.connection });

    // Without this the error does not crash the process — BullMQ catches its
    // own emit — it goes to a bare `console.error`, once per reconnect attempt,
    // outside `AppLogger` and outside `LogContext`. Measured against a queue
    // pointed at a closed port. The worker next door says the same thing at the
    // same level, and a connection that stays down reaches an operator through
    // readiness and through the pump's own drain failure.
    this.queue.on('error', (error: Error) => {
      this.logger.debug('outbox publisher connection error', {
        scope: 'BullMqOutboxPublisher',
        err: error,
      });
    });
  }

  /**
   * The outbox row id becomes the job id. The relay is at-least-once by design,
   * so the same event reaches here again whenever a crash lands between the
   * publish and the mark — and a queue that already holds that id ignores the
   * second one rather than running the work twice. It is a narrowing, not the
   * guarantee: a completed job is removed, and an event redelivered after that
   * is a new job. Handlers still have to be idempotent.
   */
  async publish(events: readonly PublishedEvent[]): Promise<void> {
    await this.queue.addBulk(
      events.map((event) => ({
        name: event.type,
        data: event,
        opts: {
          jobId: jobIdFor(event.id),
          attempts: ATTEMPTS,
          backoff: { type: 'exponential', delay: BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: { count: KEEP_FAILED },
        },
      })),
    );
  }

  async onModuleDestroy(): Promise<void> {
    // Bounded for the reason the worker's close is: this client retries forever
    // because BullMQ requires it to, so with Redis unreachable `close()` never
    // returns and takes `app.close()` with it. Nothing is in flight here worth
    // waiting on beyond a moment — publishing is a write that already happened
    // or did not.
    if (await settledWithin(this.queue.close(), CLOSE_TIMEOUT_MS)) return;

    this.logger.warn('the outbox publisher did not close; dropping its connection', {
      scope: 'BullMqOutboxPublisher',
      durationMs: CLOSE_TIMEOUT_MS,
    });
    this.connection.disconnect();
  }
}
