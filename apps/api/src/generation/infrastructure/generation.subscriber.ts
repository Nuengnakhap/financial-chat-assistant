import { MessageId, type DomainEventType } from '@fca/domain';
import { Inject, Injectable } from '@nestjs/common';

import { AppLogger } from '../../shared/observability/app-logger';
import type { PublishedEvent } from '../../shared/persistence/outbox-relay';
import type { DomainEventHandler } from '../../shared/queue/domain-events';
import { GenerationSupervisor } from '../application/generation-supervisor';
import {
  GENERATION_MESSAGES,
  type GenerationMessages,
} from '../application/ports/generation-messages.port';

/**
 * Where a question becomes work. An inbound adapter like a controller is, with a
 * queue in front of it instead of HTTP.
 *
 * Delivery is at-least-once, so this is written to be told the same thing twice.
 * The row itself is the guard: a message that is no longer `generating` has been
 * answered, stopped or given up on, and starting again would write a second
 * answer over the first.
 */
@Injectable()
export class GenerationSubscriber implements DomainEventHandler {
  readonly handles: DomainEventType = 'generation.requested';

  constructor(
    @Inject(GENERATION_MESSAGES) private readonly messages: GenerationMessages,
    private readonly supervisor: GenerationSupervisor,
    private readonly logger: AppLogger,
  ) {}

  async handle(event: PublishedEvent): Promise<void> {
    const id = MessageId.parse(event.aggregateId);
    // An id that cannot name a message is a job nothing will ever be able to do.
    // Retrying it five times says the broker is unwell; finishing it says what
    // is true, and the log is where the malformed event is reported.
    if (!id.ok) {
      this.logger.error('a generation was asked for an id that names nothing');
      return;
    }

    const answer = await this.messages.find(id.value);
    if (answer?.status === 'generating') {
      this.supervisor.begin(answer);
      return;
    }

    // Delivery is at-least-once and the row is the guard: a message that is no
    // longer `generating` has been answered, stopped or given up on, and
    // starting again would write a second answer over the first.
    this.logger.debug('a generation was asked for again after it had ended', {
      messageId: id.value,
    });
  }
}
