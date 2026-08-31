import type { AppConfig } from '@fca/config';
import type { DomainEventType } from '@fca/domain';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';

import {
  DOMAIN_EVENT_HANDLERS,
  DOMAIN_EVENTS_QUEUE,
  publishedEvent,
  type DomainEventHandler,
} from './domain-events';
import { queueConnection } from './queue-connection';
import { APP_CONFIG } from '../config/app-config.token';
import { AppLogger, asError } from '../observability/app-logger';
import type { PublishedEvent } from '../persistence/outbox-relay';

/** Small on purpose: every handler here writes to the database, which is the narrower resource. */
const CONCURRENCY = 4;

/**
 * The consuming half of the outbox. It runs in the same process as the API and
 * still talks through Redis, so splitting the two apart later changes where it
 * is started and nothing about how it behaves.
 */
@Injectable()
export class DomainEventWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private worker: Worker | null = null;
  private readonly byType: ReadonlyMap<DomainEventType, DomainEventHandler>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DOMAIN_EVENT_HANDLERS) handlers: readonly DomainEventHandler[],
    private readonly logger: AppLogger,
  ) {
    this.byType = new Map(handlers.map((handler) => [handler.handles, handler]));
    // A `Map` keeps the last of two entries with the same key, so two handlers
    // for one event type would leave one of them silently never called — the
    // same failure the composition root exists to avoid one level up. Thrown at
    // construction, because a duplicate is a wiring mistake and the boot is
    // where a wiring mistake should stop.
    if (this.byType.size !== handlers.length) {
      throw new Error('two domain event handlers claim the same event type');
    }
  }

  onApplicationBootstrap(): void {
    this.worker = new Worker(
      DOMAIN_EVENTS_QUEUE,
      async (job: Job) => {
        await this.run(job);
      },
      {
        connection: queueConnection(this.config),
        concurrency: CONCURRENCY,
      },
    );

    // Without a listener ioredis and BullMQ both treat an error as fatal, and a
    // Redis restart emits one per reconnect attempt.
    this.worker.on('error', (error: Error) => {
      this.logger.debug('domain event worker connection error', {
        scope: 'DomainEventWorker',
        err: error,
      });
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error('domain event handler failed', {
        scope: 'DomainEventWorker',
        // Built rather than spread with an undefined: `exactOptionalPropertyTypes`
        // refuses an explicit undefined where the field is merely optional.
        ...(job === undefined ? {} : { task: job.name }),
        err: asError(error),
      });
    });
  }

  /**
   * A job whose type nobody consumes is finished, not failed. The alternative is
   * five retries and a permanent failure for an event that was only ever
   * recorded — and the outbox holds every type the domain has, not only the ones
   * something listens for.
   */
  async run(job: Job): Promise<void> {
    const parsed = publishedEvent.safeParse(job.data);
    if (!parsed.success) {
      // Thrown rather than swallowed: a job this process cannot read is a bug in
      // whatever wrote it, and it belongs in the failed set where it is visible.
      throw new Error(`unreadable ${DOMAIN_EVENTS_QUEUE} job`);
    }

    const handler = this.byType.get(parsed.data.type);
    if (handler === undefined) return;

    await handler.handle(parsed.data satisfies PublishedEvent);
  }

  async onModuleDestroy(): Promise<void> {
    // Waits for jobs in flight, so a handler is never cut off midway through a
    // transaction it could have finished.
    await this.worker?.close();
  }
}
