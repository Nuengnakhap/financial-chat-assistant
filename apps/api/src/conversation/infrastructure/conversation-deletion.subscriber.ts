import { ConversationId, type DomainEventType } from '@fca/domain';
import { Injectable } from '@nestjs/common';

import { AppLogger } from '../../shared/observability/app-logger';
import type { PublishedEvent } from '../../shared/persistence/outbox-relay';
import type { DomainEventHandler } from '../../shared/queue/domain-events';
import { PurgeConversationUseCase } from '../application/use-cases/purge-conversation.use-case';

/**
 * The far end of the delete pipeline. An inbound adapter like a controller is,
 * with a queue in front of it instead of HTTP: it reads what arrived, turns it
 * into the domain's own vocabulary, and calls a use case.
 */
@Injectable()
export class ConversationDeletionSubscriber implements DomainEventHandler {
  readonly handles: DomainEventType = 'conversation.delete_requested';

  constructor(
    private readonly purge: PurgeConversationUseCase,
    private readonly logger: AppLogger,
  ) {}

  async handle(event: PublishedEvent): Promise<void> {
    const id = ConversationId.parse(event.aggregateId);
    // An id that cannot name a conversation is a job nothing will ever be able
    // to do. Retrying it five times and keeping it in the failed set says the
    // broker is unwell; finishing it says what is true, and the log is where
    // the malformed event is reported.
    if (!id.ok) {
      this.logger.error('conversation deletion asked for an id that names nothing', {
        scope: 'ConversationDeletionSubscriber',
      });
      return;
    }

    const removed = await this.purge.execute(id.value);
    if (removed) {
      this.logger.debug('conversation deleted', {
        scope: 'ConversationDeletionSubscriber',
        conversationId: id.value,
      });
    }
  }
}
