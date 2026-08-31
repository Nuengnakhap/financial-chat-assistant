import { Module } from '@nestjs/common';

import { BullMqOutboxPublisher } from './bullmq-outbox-publisher';
import { DomainEventWorker } from './domain-event-worker';
import { OutboxPump } from './outbox-pump';
import { DatabaseService } from '../persistence/database.service';
import { OutboxRelay, OUTBOX_PUBLISHER, type OutboxPublisher } from '../persistence/outbox-relay';
import { PersistenceModule } from '../persistence/persistence.module';

/**
 * Both halves of the outbox: the pump that turns committed rows into jobs, and
 * the worker that runs them. They speak through Redis even though they share a
 * process, so moving the worker to its own process later changes where it is
 * started and nothing about how either behaves.
 *
 * `DOMAIN_EVENT_HANDLERS` is deliberately not provided here — the list of who
 * consumes what is composed at the composition root, where every context is
 * already visible.
 */
@Module({
  imports: [PersistenceModule],
  providers: [
    { provide: OUTBOX_PUBLISHER, useClass: BullMqOutboxPublisher },
    // Built here rather than by the pump, which would then reach four
    // collaborators to construct one. The relay is a collaborator, not a
    // detail of the loop that drives it.
    {
      provide: OutboxRelay,
      useFactory: (database: DatabaseService, publisher: OutboxPublisher): OutboxRelay =>
        new OutboxRelay(database, publisher),
      inject: [DatabaseService, OUTBOX_PUBLISHER],
    },
    OutboxPump,
    DomainEventWorker,
  ],
})
export class QueueModule {}
